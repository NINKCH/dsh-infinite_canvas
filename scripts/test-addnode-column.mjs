#!/usr/bin/env node
/**
 * 画布建点布局强控制回归：**一类型一列 + 碰撞下移，代码级强制**。
 *
 * 背景：client 侧 addNodeAt 曾直接采用调用者的自由坐标（工具条快捷键固定在
 * worldCenter±偏移、双击菜单带 ±30 随机偏移、参考图快建 ±400），同类型连建
 * 两个节点必然重叠——对话侧建点有 Host nextNodePos 强控制，画布本地建点没有。
 *
 * 新契约（与 Host nextNodePos 同一套算法）：
 *   ① 一类型一列：同类型已有节点 → x 对齐该列（最小 x），y = 列尾最大 bottom + 40；
 *   ② 该类型第一个节点 → 用调用者 pos 起新列；
 *   ③ 碰撞下移：候选框（含 28px 间距）与任何节点相交 → 下移到相交节点下方，上限 80 轮；
 *   ④ pos 参数只用于"起新列"，自由摆放由 Alt+拖拽承担（既有功能，不受影响）。
 *
 * 运行：node scripts/test-addnode-column.mjs；退出码 0=通过。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const noop = () => {};

// ---------------- 假 React / DOM（与 test-segment-plan 同套路） ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const elStub = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '', innerHTML: '', className: '', value: '',
  appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
  toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
const documentStub = {
  createElement: elStub, documentElement: elStub(), body: elStub(), head: elStub(),
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
};
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), localStorage: lsStub, location: { href: 'http://localhost/' }, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true },
  document: documentStub,
  localStorage: lsStub, navigator: { language: 'zh-CN', userAgent: 'node' }, location: { href: 'http://localhost/' },
  setTimeout, clearTimeout, setInterval: (f) => setTimeout(f, 0), clearInterval: noop, queueMicrotask,
  fetch: () => Promise.reject(new Error('no-net')), console,
  performance: { now: () => Date.now() }, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  TextEncoder, TextDecoder, URL, URLSearchParams, Promise, JSON, Math, Date, Number, String, Array, Object, Map, Set, WeakMap, Error, RegExp, parseInt, parseFloat, isNaN, isFinite, Buffer, Blob: class { arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } },
};
sandbox.globalThis = sandbox;
sandbox.window.globalThis = sandbox.window;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
  plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
} catch (e) {
  console.error('✗ client.js 顶层执行失败：' + e.message);
  process.exit(1);
}
const SEG = sandbox.window.__DSH_IC_LAYOUT__;
if (!SEG || typeof SEG.addNodeAt !== 'function' || typeof SEG.nextNodePosClient !== 'function') {
  console.error('✗ 未暴露 window.__DSH_IC_ADDNODE__（建点布局的测试缝隙缺失）');
  process.exit(1);
}
const { addNodeAt, nextNodePosClient, addGraphNodes, graph: readGraph } = SEG;

// 准备：向活状态（S.graph）播种节点——graph() 是深克隆只能读，写入用 addGraphNodes
const seedNode = (id, type, x, y, w, h) => addGraphNodes([{ id, type, x, y, w: w || 360, h: h || 360, data: {} }]);

// ---------------- ① 一类型一列：同类型追加到列尾 ----------------
seedNode('s1', 'image', 1000, 100, 400, 300);
seedNode('s2', 'image', 1000, 440, 400, 300);
{
  const n = addNodeAt('image', { x: 50, y: 50 }); // 故意给一个自由坐标
  ok(n.x === 1000, '① 同类型建点 x 应对齐列（1000），实际 ' + n.x);
  ok(n.y >= 780, '① 同类型建点 y 应在列尾（≥780），实际 ' + n.y);
}

// ---------------- ② 碰撞下移：与其他类型节点相交 → 下移 ----------------
seedNode('v1', 'video', 500, 100, 400, 300);
{
  const n = addNodeAt('video', { x: 500, y: 120 }); // 与 v1 相交
  ok(!(n.x < 900 && n.y < 400 + 28), '② 视频新节点不得与已有节点重叠');
}

// ---------------- ③ 新类型起新列：用调用者 pos ----------------
seedNode('t0', 'text', 100, 100);
{
  const n = addNodeAt('script', { x: 3000, y: 200 }); // script 第一次出现
  ok(n.x === 3000 && n.y === 200, '③ 新类型首点应使用调用者 pos（3000,200），实际 ' + n.x + ',' + n.y);
}

// ---------------- ④ 全图无重叠终检（跑完所有断言后扫一遍） ----------------
{
  const ns = Object.values(readGraph().nodes).filter((n) => n.type !== 'group');
  let overlaps = 0;
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    if (a.x < (b.x + (b.w || 360)) && (a.x + (a.w || 360)) > b.x && a.y < (b.y + (b.h || 360)) && (a.y + (a.h || 360)) > b.y) overlaps++;
  }
  ok(overlaps === 0, '④ 画布存在 ' + overlaps + ' 对重叠节点（应 0）');
}

// ---------------- ⑤ 源码契约 ----------------
ok(/pos = nextNodePosClient\(t2, pos, sz\);/.test(src), 'addNodeAt 未收口到 nextNodePosClient（强控制缺失）');
ok(/一类型一列/.test(src) && /nextNodePosClient/.test(src), '布局算法注释缺失');

if (errs.length) {
  console.error('✗ 建点布局强控制回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 建点布局强控制回归通过：一类型一列 / 碰撞下移 / 新类型起列 / 全图无重叠 / 源码契约');
