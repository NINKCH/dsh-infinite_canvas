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
  if (typeof type === 'function') { walk(type, props, `${type.name || 'anon'} <${label}>`, depth + 1); return; }
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
const ctx = {
  effect(fn) { fn(); },
  locale: { register: noop, subscribe: () => () => {} },
  slots: {
    inject(name, cb) { cb(); },
    register(meta, Comp) { roots.push({ meta: meta || {}, Comp }); return Comp; },
  },
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

console.log(`组件遍历：${walkedCount} 个（根组件 ${roots.length} 个：${roots.map((r) => r.meta.id || r.meta.key || '?').join(', ')}）`);
if (errors.length) {
  console.error(`✗ 渲染冒烟发现 ${errors.length} 个错误：`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 渲染冒烟通过：组件树无渲染期异常');
process.exit(0);
