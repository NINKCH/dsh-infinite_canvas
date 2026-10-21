// 节点类型合并（A 单）回归测试：
//   旧项目文档里的 image-gen / image-asset / video-gen / video-asset 在**文档入口**统一归一为
//   image / video（数据层合并），且：
//     ① 节点类型归一为 image / video；
//     ② 连线数量与端点（节点/端口）一条不丢；
//     ③ 节点 data 原样保留——有 assetId 就是"已有图/视频"，有 prompt 就是"有提示词"；
//     ④ 迁移幂等：重复加载 / 重复合并两次结果一致（不会二次改写或丢数据）。
// 运行：node scripts/test-node-merge.mjs（退出码 0=通过）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）');

// ---------------- 假 React / DOM / localStorage（同 test-expand-assets 套路） ----------------
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

// ---------------- 预置：一个旧项目文档（含旧类型节点、连线、assetId、prompt） ----------------
const PID = 'p_merge';
const LEGACY_NODES = {
  n_text: { id: 'n_text', type: 'text', x: 0, y: 0, w: 360, h: 360, data: { text: '剧本文本' } },
  n_img_gen: { id: 'n_img_gen', type: 'image-gen', x: 400, y: 0, w: 280, h: 300, data: { prompt: '图片提示词', size: '2K', ratio: '16:9', assetId: null } },
  n_img_asset: { id: 'n_img_asset', type: 'image-asset', x: 400, y: 400, w: 280, h: 300, data: { assetId: 'asset_img_1', label: '角色-陈拾' } },
  n_vid_gen: { id: 'n_vid_gen', type: 'video-gen', x: 800, y: 0, w: 280, h: 320, data: { prompt: '视频提示词', duration: 8, resolution: '720P', ratio: '16:9', assetId: null } },
  n_vid_asset: { id: 'n_vid_asset', type: 'video-asset', x: 1200, y: 0, w: 280, h: 320, data: { assetId: 'asset_vid_1', lastAssetId: 'asset_tail_1' } },
  n_sb: { id: 'n_sb', type: 'storyboard', x: 800, y: 500, w: 360, h: 360, data: { shots: [], label: '场1分镜表' } },
};
const LEGACY_EDGES = [
  { id: 'e1', fromNode: 'n_text', fromPort: 'out', toNode: 'n_img_gen', toPort: 'prompt' },
  { id: 'e2', fromNode: 'n_img_asset', fromPort: 'out', toNode: 'n_vid_gen', toPort: 'ref' },
  { id: 'e3', fromNode: 'n_vid_gen', fromPort: 'out', toNode: 'n_vid_asset', toPort: 'in' },
  { id: 'e4', fromNode: 'n_img_gen', fromPort: 'out', toNode: 'n_vid_gen', toPort: 'ref' },
  { id: 'e5', fromNode: 'n_sb', fromPort: 'out', toNode: 'n_vid_gen', toPort: 'prompt' },
];
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '合并测试', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({ nodes: JSON.parse(JSON.stringify(LEGACY_NODES)), edges: JSON.parse(JSON.stringify(LEGACY_EDGES)), view: { x: 0, y: 0, scale: 1 } }));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-node-merge', clipboard: { writeText: async () => {} } },
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
  indexedDB: { open: () => { const req = {}; setTimeout(() => { try { req.onerror && req.onerror(); } catch { /* 忽略 */ } }, 0); return req; } },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
if (!mod) { console.error('✗ client.js 顶层执行失败'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });

const sync = sandbox.window.__DSH_IC_SYNC__;
if (!sync || typeof sync.graph !== 'function' || typeof sync.loadGraphDoc !== 'function' || typeof sync.mergeHostDoc !== 'function') {
  console.error('✗ 未暴露 __DSH_IC_SYNC__ 的 graph/loadGraphDoc/mergeHostDoc（冒烟缝隙被移除？）');
  process.exit(1);
}

const graph = () => sync.graph();
const typeOf = (g, id) => g.nodes[id] && g.nodes[id].type;
const portsOf = (g, id) => {
  const e = (g.edges || []).find((x) => x.id === id);
  return e ? [e.fromNode, e.fromPort, e.toNode, e.toPort] : null;
};

// ---------- 1) 加载即归一：旧类型 → image / video ----------
{
  const g = graph();
  eq(typeOf(g, 'n_img_gen'), 'image', 'image-gen 未归一为 image');
  eq(typeOf(g, 'n_img_asset'), 'image', 'image-asset 未归一为 image');
  eq(typeOf(g, 'n_vid_gen'), 'video', 'video-gen 未归一为 video');
  eq(typeOf(g, 'n_vid_asset'), 'video', 'video-asset 未归一为 video');
  eq(typeOf(g, 'n_text'), 'text', 'text 类型被误改');
  eq(typeOf(g, 'n_sb'), 'storyboard', 'storyboard 类型被误改');
  ok(!Object.values(g.nodes).some((n) => ['image-gen', 'image-asset', 'video-gen', 'video-asset'].includes(n.type)), '仍残留旧节点类型');
}

// ---------- 2) 连线数量与端点一条不丢 ----------
{
  const g = graph();
  eq((g.edges || []).length, LEGACY_EDGES.length, '迁移后连线数量变化');
  for (const e of LEGACY_EDGES) eq(portsOf(g, e.id), [e.fromNode, e.fromPort, e.toNode, e.toPort], '连线端点被改写：' + e.id);
}

// ---------- 3) data 原样保留：assetId / prompt / 参数 ----------
{
  const g = graph();
  eq(g.nodes.n_img_gen.data.prompt, '图片提示词', '图片提示词丢失');
  eq(g.nodes.n_img_gen.data.size, '2K', '图片清晰度丢失');
  eq(g.nodes.n_img_gen.data.ratio, '16:9', '图片比例丢失');
  eq(g.nodes.n_img_asset.data.assetId, 'asset_img_1', '图片 assetId 丢失（有图就是资产）');
  eq(g.nodes.n_img_asset.data.label, '角色-陈拾', '图片节点名丢失');
  eq(g.nodes.n_vid_gen.data.prompt, '视频提示词', '视频提示词丢失');
  eq(g.nodes.n_vid_gen.data.duration, 8, '视频时长丢失');
  eq(g.nodes.n_vid_asset.data.assetId, 'asset_vid_1', '视频 assetId 丢失');
  eq(g.nodes.n_vid_asset.data.lastAssetId, 'asset_tail_1', '视频尾帧资产 id 丢失（续帧接力依赖它）');
}

// ---------- 4) loadGraphDoc 读出来也必须是归一后的类型 ----------
{
  const doc = sync.loadGraphDoc(PID);
  for (const [id, legacy] of [['n_img_gen', 'image-gen'], ['n_img_asset', 'image-asset'], ['n_vid_gen', 'video-gen'], ['n_vid_asset', 'video-asset']]) {
    ok(doc.nodes[id].type !== legacy, 'loadGraphDoc 返回的节点仍是旧类型：' + id);
  }
  eq(doc.edges.length, LEGACY_EDGES.length, 'loadGraphDoc 返回的连线数量变化');
}

// ---------- 5) 迁移幂等：重复合并同一份旧文档两次，结果一致且不丢数据 ----------
{
  sync.mergeHostDoc(PID, { nodes: JSON.parse(JSON.stringify(LEGACY_NODES)), edges: JSON.parse(JSON.stringify(LEGACY_EDGES)), view: { x: 0, y: 0, scale: 1 } });
  const after1 = JSON.stringify({ nodes: graph().nodes, edges: graph().edges });
  sync.mergeHostDoc(PID, { nodes: JSON.parse(JSON.stringify(LEGACY_NODES)), edges: JSON.parse(JSON.stringify(LEGACY_EDGES)), view: { x: 0, y: 0, scale: 1 } });
  const after2 = JSON.stringify({ nodes: graph().nodes, edges: graph().edges });
  ok(after1 === after2, '重复合并两次结果不一致（迁移不幂等：可能二次改写类型或丢失数据）');
  const g = graph();
  eq((g.edges || []).length, LEGACY_EDGES.length, '重复合并后连线数量变化');
  eq(typeOf(g, 'n_img_gen'), 'image', '重复合并后类型漂移');
  eq(g.nodes.n_vid_asset.data.assetId, 'asset_vid_1', '重复合并后 assetId 丢失');
}

// ---------- 6) 已是合并类型的文档原样保留（归一映射对 image/video 是恒等） ----------
{
  const mergedNodes = { n_m: { id: 'n_m', type: 'image', x: 0, y: 0, w: 360, h: 360, data: { prompt: 'p', assetId: 'a' } } };
  sync.mergeHostDoc(PID, { nodes: mergedNodes, edges: [], view: { x: 0, y: 0, scale: 1 } });
  eq(typeOf(graph(), 'n_m'), 'image', '合并类型节点被误改');
  eq(graph().nodes.n_m.data.assetId, 'a', '合并类型节点的 assetId 丢失');
}

if (errs.length) {
  console.error('✗ 节点类型合并测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 节点类型合并测试通过（旧文档 image-gen/image-asset/video-gen/video-asset → image/video，连线/端点/assetId/prompt 不丢，重复迁移幂等）');
process.exit(0);
