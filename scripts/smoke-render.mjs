#!/usr/bin/env node
/**
 * 渲染冒烟测试（dev-only，不随包发布）。
 *
 * 以假 React + 桩全局环境执行 client.js，通过 slots.register 捕获根组件，
 * 递归走一遍真实组件树 —— 专抓"渲染期 ReferenceError 导致整树卸载（黑屏）"这类问题。
 *
 * 运行：node scripts/smoke-render.mjs
 * 退出码：0 = 通过；1 = 存在渲染错误或模块无法加载。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');

// ---------------- 假 React ----------------
function mkEl(type, props, ...kids) {
  return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
}
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
};

// ---------------- DOM / 浏览器全局桩 ----------------
const noop = () => {};
function domEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    id: '',
    width: 0,
    height: 0,
    firstChild: null,
    parentNode: null,
    appendChild: noop,
    removeChild: noop,
    remove: noop,
    click: noop,
    focus: noop,
    blur: noop,
    select: noop,
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getContext: () => new Proxy({}, {
      get: (t, p) => {
        if (p === 'measureText') return () => ({ width: 10 });
        if (typeof p === 'string') return noop;
        return undefined;
      },
      set: () => true,
    }),
    toDataURL: () => 'data:,',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  };
}

const documentStub = {
  createElement: (tag) => domEl(tag),
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: domEl('head'),
  body: domEl('body'),
  documentElement: domEl('html'),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  elementFromPoint: () => null,
  activeElement: null,
  addEventListener: noop,
  removeEventListener: noop,
};

const localStorageStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };

// Host RPC 桩：updateCheck 返回"有新版本"，覆盖横幅渲染路径；ArtCraft 探测直接失败（走降级分支）
const rpcStubFetch = async (url, opts) => {
  const u = String(url || '');
  if (u.includes('/artcraft/')) throw new Error('stub: artcraft offline');
  let method = '';
  try { method = JSON.parse((opts && opts.body) || '{}').method; } catch { /* 忽略 */ }
  const payload = method === 'updateCheck'
    ? { source: 'npm', runningVersion: '0.17.1', remoteVersion: '9.9.9', behind: 1, upToDate: false }
    : { ok: true, version: '0.17.1' };
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text, json: async () => payload };
};

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
class FileReaderStub { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} }

const windowStub = {
  devicePixelRatio: 1,
  innerWidth: 1600,
  innerHeight: 900,
  addEventListener: noop,
  removeEventListener: noop,
  AudioContext: undefined,
  webkitAudioContext: undefined,
  __DSH_IC_SMOKE__: true, // 让 client.js 暴露各页签组件供冒烟直渲染
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  localStorage: localStorageStub,
  navigator: { userAgent: 'smoke', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:19387/', reload: noop },
  fetch: rpcStubFetch,
  requestAnimationFrame: noop, // 不真正调度，避免动画循环挂住
  cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask,
  console,
  performance,
  crypto,
  Blob,
  URL,
  AbortController,
  AbortSignal,
  structuredClone,
  Image: class { constructor() { this.src = ''; } },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: FileReaderStub,
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  Event: class { constructor(type) { this.type = type; } },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => ({ set onupgradeneeded(v) { void v; }, set onsuccess(v) { void v; }, set onerror(v) { void v; } }) },
  alert: noop,
  confirm: () => false,
  prompt: () => null,
};
sandbox.window.localStorage = localStorageStub;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// ---------------- 组件树遍历 ----------------
const walked = new Set();
let walkedCount = 0;
const errors = [];

function walkEl(el, label, depth) {
  if (el == null || typeof el === 'boolean' || typeof el === 'string' || typeof el === 'number') return;
  if (Array.isArray(el)) { for (const c of el) walkEl(c, label, depth); return; }
  if (typeof el !== 'object' || !el.__el) return;
  const { type, props } = el;
  if (typeof type === 'function') {
    // 类组件（错误边界等）无法用假 React 无 new 调用：只走其 children，跳过组件本身
    if (type.__dshicClass) { walkEl(props.children, label, depth); return; }
    walk(type, props, `${type.name || 'anon'} <${label}>`, depth + 1);
    return;
  }
  walkEl(props.children, label, depth);
}

function walk(comp, props, label, depth) {
  if (depth > 80) return;
  if (walked.has(comp)) return; // 同一组件只需走一次：目标是抓确定性的渲染期错误
  walked.add(comp);
  walkedCount++;
  let out;
  try { out = comp(props || {}); } catch (e) { errors.push(label + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))); return; }
  walkEl(out, label, depth);
}

// ---------------- 执行 ----------------
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
if (!mod) { console.error('✗ ModuleLoader.load 未被调用 —— client.js 顶层执行失败'); process.exit(1); }

let plugin = null;
try {
  plugin = mod.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error('意外 require: ' + name);
  });
} catch (e) {
  console.error('✗ factory(require) 执行失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}
if (!plugin || typeof plugin.apply !== 'function') { console.error('✗ factory 返回缺少 apply(ctx)'); process.exit(1); }

const roots = [];
const walkedTabTypes = []; // sidebarRightTabs.register 桩的注册记录（开始页卡片来源）
const ctx = {
  effect(fn) { fn(); },
  locale: { register: noop, subscribe: () => () => {} },
  slots: {
    inject(name, cb) { cb(); },
    register(meta, Comp) { roots.push({ meta: meta || {}, Comp }); return Comp; },
  },
  // 右栏页签注册表桩：真实 runner 由 ctx.reflect.provide('sidebarRightTabs') 提供；
  // 旧 runner 没有该服务 → 插件须守卫跳过（这里记录注册事实，不产生渲染根）
  sidebarRightTabs: { register: (def) => { walkedTabTypes.push(def); return () => {}; } },
};
try {
  plugin.apply(ctx);
} catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}

// 等桩 fetch 的 Promise 落地（checkUpdate / ping / probeCraft），覆盖横幅等异步渲染路径
await new Promise((r) => setTimeout(r, 120));

for (const { meta, Comp } of roots) walk(Comp, {}, meta.id || meta.key || 'root');

// 逐个直接渲染各页签：抓"某个页签一渲染就崩（如引用未定义变量）→ 面板白屏"的问题
// （画布默认只渲染激活的页签，切到资产/设定集/设置时的崩溃此前测不到）
if (windowStub.__DSH_IC_TABS__) {
  for (const [name, Comp] of Object.entries(windowStub.__DSH_IC_TABS__)) {
    walk(Comp, name === 'CanvasPage' ? {} : {}, 'tab:' + name);
  }
  console.log('页签直渲染：' + Object.keys(windowStub.__DSH_IC_TABS__).join(', '));
  // 快捷键面板：展开态也要渲染一次（闭合态只画按钮，展开态才构造整张列表 —— 列表里引用错变量时报错只在这一态出现）
  const SP = windowStub.__DSH_IC_TABS__.ShortcutsPanel;
  if (SP && windowStub.__DSH_IC_SYNC__) {
    const st = windowStub.__DSH_IC_SYNC__.state();
    void st;
    // 直接以展开态调用（组件读 S.keysOpen；这里通过全局 patch 后渲染）
    try {
      const g = windowStub.__DSH_IC_SYNC__;
      if (g && typeof g.setKeysOpen === 'function') g.setKeysOpen(true);
    } catch { /* 无该缝隙时跳过 */ }
    walk(SP, {}, 'ShortcutsPanel:open');
  }
} else {
  console.error('✗ 未找到 __DSH_IC_TABS__（冒烟缝隙被移除？）');
  process.exit(1);
}

// 右栏页签 kind 必须已注册（开始页卡片的真正来源）——曾漏注册导致页签体存在但开始页无入口
{
  const def = walkedTabTypes.find((d) => d && d.kind === 'infinite-canvas');
  if (!def) { console.error('✗ sidebarRightTabs.register 未注册 infinite-canvas kind（开始页不会出现画布入口）'); process.exit(1); }
  if (!Array.isArray(def.guide) || !def.guide.length) { console.error('✗ 页签 kind 未带 guide 数组（开始页标准卡渲染不出来）'); process.exit(1); }
  console.log('右栏页签 kind 注册：' + def.kind + '（guide 条目 ' + def.guide.length + ' 个，multiple=' + def.multiple + '）');
  // 关键契约：壳的 TabSlot 用 `entryKey: definition?.id ?? tab.kind` 调度插槽——
  // 页签体槽位的 key 必须是注册 id，写成 kind 会永远命中 fallback
  // （实测现象：「这类内容还没有可用的查看方式」，卡片在但点开是空壳）。
  const body = roots.find((r) => r.meta && r.meta.name === 'sidebar.right.pane.tab');
  if (!body) { console.error('✗ 未注册 sidebar.right.pane.tab 页签体'); process.exit(1); }
  if (body.meta.key !== def.id) {
    console.error('✗ 页签体槽位 key（' + body.meta.key + '）必须等于注册 id（' + def.id + '），否则壳调不到 body 而显示 fallback');
    process.exit(1);
  }
  const title = roots.find((r) => r.meta && r.meta.name === 'sidebar.right.pane.tab.title');
  if (title && title.meta.key !== def.id) {
    console.error('✗ 标题槽位 key（' + title.meta.key + '）必须等于注册 id（' + def.id + '）');
    process.exit(1);
  }
  console.log('页签槽位 key 与注册 id 一致：' + def.id);
}

console.log(`组件遍历：${walkedCount} 个（根组件 ${roots.length} 个：${roots.map((r) => r.meta.id || r.meta.key || '?').join(', ')}）`);
if (errors.length) {
  console.error(`✗ 渲染冒烟发现 ${errors.length} 个错误：`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 渲染冒烟通过：组件树无渲染期异常');
process.exit(0);
