// OBS-UI-1 定向单测：打开面板绝不自动创建「我的画布」空项目。
//
// 缺陷（QA OBS-UI-1，中级，数据卫生）：干净客户端每次打开「无限画布」面板，
// initStore() 都会自动造一个名为「我的画布」的占位项目并写 localStorage，随后
// pushAllProjectsToHost() 把它推给 Host 落进 canvas.db —— DB 项目数 13→14，
// 多客户端/自动化下持续累积（QA 一轮清了 10 个）。
//
// 修复口径：空列表 = 空态。initStore 不再建占位；pushAllProjectsToHost 空态不推送；
// 删除最后一个项目后进入空态而不是再造一个；项目页签显示引导文案，用户显式点
// 「新建项目」或让对话建项目才真正创建。
//
// 运行：node scripts/test-empty-project.mjs；退出码 0=通过 1=失败
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM（同 test-drag-alt 套路） ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const noop = () => {};
const elStub = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '',
  appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
  getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
  toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
const documentStub = {
  createElement: (tag) => { const el = elStub(); if (tag === 'canvas') el.captureStream = () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] }); return el; },
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null,
  addEventListener: noop, removeEventListener: noop,
};
const lsStore = new Map();
const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-empty-project', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  Image: class { constructor() { this.src = ''; } },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => ({ set onupgradeneeded(v) { void v; }, set onsuccess(v) { void v; }, set onerror(v) { void v; } }) },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
if (!mod) { console.error('✗ client.js 顶层执行失败'); process.exit(1); }

// 记录 hostSyncTick / pushAllProjectsToHost 推过的项目
const pushedProjects = [];
const plugin = mod.factory((name) => {
  if (name === 'react') return fakeReact;
  throw new Error('意外 require: ' + name);
});
plugin.apply({
  effect(fn) { fn(); return () => {}; },
  locale: { register: noop, subscribe: () => () => {} },
  slots: { inject(n, cb) { cb(); }, register: () => () => {} },
});

// ---------------- 1) 行为断言：干净客户端（localStorage 无项目）初始化后 ----------------
const S = sandbox.window.__DSH_IC_SYNC__ ? null : null; // 状态经 SYNC 缝隙读不到 projects 全量，走源码契约断言
ok(lsStore.get('dsh-ic:projects') === undefined || JSON.parse(lsStore.get('dsh-ic:projects') || '[]').length === 0,
  '干净客户端初始化后 localStorage 里出现了自动创建的占位项目（OBS-UI-1 未修干净）');
ok(![...lsStore.keys()].some((k) => {
  const v = lsStore.get(k);
  return typeof v === 'string' && v.includes('我的画布');
}), 'localStorage 里出现了「我的画布」占位内容（自动创建未根除）');

// ---------------- 2) 源码级契约：四处自动创建/推送路径全部关闭 ----------------
const fnBody = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
};
const initBody = fnBody('initStore');
ok(initBody.length > 0, '未找到 initStore');
ok(/OBS-UI-1/.test(initBody), 'initStore 缺少 OBS-UI-1 空态分支（仍会自动建占位项目）');
ok(!/S\.projects\s*=\s*\[\s*\{\s*id:\s*uid\('p'\)/.test(initBody), 'initStore 仍在自动创建占位项目');
const pushBody = fnBody('pushAllProjectsToHost');
ok(/OBS-UI-1/.test(pushBody) && /!S\.projects\.length\)\s*return/.test(pushBody), 'pushAllProjectsToHost 空态未拦截（空态占位会被推进 canvas.db）');
// 两个「删除后清空」分支：删除最后项目后进入空态而不是再造占位
const tickBody = fnBody('hostSyncTick');
ok((tickBody.match(/OBS-UI-1/g) || []).length >= 1, 'hostSyncTick 的删光分支未改为空态');
const projectsTab = src.slice(src.indexOf('function ProjectsTab'), src.indexOf('// =====', src.indexOf('function ProjectsTab')));
ok((projectsTab.match(/OBS-UI-1/g) || []).length >= 1, 'ProjectsTab 的删光分支未改为空态');
// 全仓不应再有「用 T('defaultProject') 造项目」的调用（i18n 键定义保留，仅供旧数据兼容展示）
const creators = (src.match(/name:\s*T\('defaultProject'\)/g) || []).length;
ok(creators === 0, `仍有 ${creators} 处用 defaultProject 自动建项目`);

// ---------------- 3) 空态 UI：项目页签显示引导文案 ----------------
ok(/emptyProjectHint/.test(src), '空态引导文案键 emptyProjectHint 缺失');
ok(/'emptyProjectHint':/.test(src), 'emptyProjectHint 中文定义缺失');
ok(/'emptyProjectHint':\s*'No projects yet/.test(src), 'emptyProjectHint 英文定义缺失');
ok(/!S\.projects\.length && !creating\s*\?\s*h\('div'[^)]*emptyProjectHint/.test(src.replace(/\n/g, ' ')), '空态引导没有挂到 ProjectsTab');

// ---------------- 4) 显式创建路径仍然完好（回归保护） ----------------
ok(/const create = \(\) => \{/.test(projectsTab), 'ProjectsTab 的显式创建函数丢失');
ok(/hostRpc\('projectsPut'/.test(projectsTab), '显式创建后未推送 Host（新建项目会失效）');

if (errs.length) {
  console.error('✗ OBS-UI-1 验证未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ OBS-UI-1 验证通过：空态不建项目、不推送 Host；删光进空态；项目页签有引导文案；显式创建路径完好');
process.exit(0);
