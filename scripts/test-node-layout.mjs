// 节点排版/生成面板的用户实测缺陷回归测试（几何规则已按用户纠正版重写，上一轮的错误断言全部替换）：
//   ① 媒体节点三段几何：标题栏 NODE_HDR_H（固定，原型 34px）+ 预览区（盒比 = 媒体比例，短边 360、长边 ≤800）
//      + 操作栏 NODE_FOOT_H（固定，原型 7+24+7+1=39px；有结果才渲染）。节点宽 = 预览宽；
//      节点高 = 预览高 + 标题栏 +（有操作栏时的）操作栏。
//      旧文档加载时按记录比例（缺省资产像素，再缺省 16:9）重算外框（幂等）；用户等比拉伸过的尺寸不被回收。
//   ② 渲染结构：媒体 body 内从上到下依次「标题栏 / 预览区 / 操作栏」，标题栏/操作栏 flex:none 固定高度、
//      预览区 flex:1；预览**不裁切**（`.dshic-media-fill` 不得再有 object-fit:cover）。
//   ③ 用户拉伸媒体节点 = 等比缩放预览区（标题栏/操作栏高度恒定）；文本/剧本/分镜固定 360×360、内容区 flex 撑满。
//   ④ 点击区域：只有内容区（媒体预览/空态、正文、镜头清单）弹面板；标题栏（拖动/重命名）与底部操作栏（按钮区）不弹。
//   ⑤ 视觉契约（源码级）：节点/生成面板的每个视觉值都必须来自 CSS 变量 --dshic-*（逐值对齐已验收原型
//      node-redesign-mockup.html，不许在规则里写死同一字面量）。
// 运行：node scripts/test-node-layout.mjs（退出码 0=通过）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）');

// ---------------- 假 React / DOM / localStorage（与 test-node-actions 同一套路） ----------------
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

// ---------------- 预置：一个含旧尺寸（360×360，上一轮把节点框当画面框）媒体节点的项目文档 ----------------
const PID = 'p_layout';
const SHOT = { title: '镜1', duration: 2, visual: '@陈拾@ 站着', motion: '固定', characters: ['陈拾'], scene: '巷子', props: [], dialogue: [], sfx: '' };
// 参考图上游节点（图片/视频节点的顶栏缩略图条与拖拽排序测试用）：assetId 就绪 → 缩略图按 refOrder 排
const REF_SRC = {
  n_ref_a: { id: 'n_ref_a', type: 'image', x: -1500, y: 0, w: 640, h: 433, data: { label: '角色-林晚 多视图', prompt: '', assetId: 'a_ref1', ratio: '16:9', size: '2K', status: 'done' } },
  n_ref_b: { id: 'n_ref_b', type: 'image', x: -1500, y: 500, w: 640, h: 433, data: { label: '场景-雨夜深巷', prompt: '', assetId: 'a_ref2', ratio: '16:9', size: '2K', status: 'done' } },
  n_ref_c: { id: 'n_ref_c', type: 'image', x: -1500, y: 1000, w: 640, h: 433, data: { label: '道具-旧信封', prompt: '', assetId: 'a_ref3', ratio: '16:9', size: '2K', status: 'done' } },
};
// 连到 n_img 的参考图输入；初始 refOrder 故意不是连线顺序（e_ref3 在首位）
const REF_EDGES = [
  { id: 'e_ref1', fromNode: 'n_ref_a', fromPort: 'out', toNode: 'n_img', toPort: 'ref' },
  { id: 'e_ref2', fromNode: 'n_ref_b', fromPort: 'out', toNode: 'n_img', toPort: 'ref' },
  { id: 'e_ref3', fromNode: 'n_ref_c', fromPort: 'out', toNode: 'n_img', toPort: 'ref' },
  { id: 'e_vid_sb', fromNode: 'n_sb', fromPort: 'out', toNode: 'n_vid_sb', toPort: 'prompt' },
];
const SEED_NODES = {
  // 媒体节点：文档里是旧的 360×360 盒子（标题栏/操作栏吃掉画面高度），加载时必须按记录比例重算外框
  n_img: { id: 'n_img', type: 'image', x: 0, y: 0, w: 360, h: 360, data: { label: '角色-林晚 多视图', prompt: 'x', assetId: 'a_img', ratio: '16:9', size: '2K', status: 'done', refOrder: ['e_ref3', 'e_ref1', 'e_ref2'] } },
  n_vid: { id: 'n_vid', type: 'video', x: 700, y: 0, w: 360, h: 360, data: { label: '视频', prompt: 'x', assetId: 'a_vid', ratio: '9:16', resolution: '720P', status: 'done' } },
  // 已连分镜表的独立视频段：时长控件必须禁用（分镜镜头自带 duration，节点秒数无效）
  n_vid_sb: { id: 'n_vid_sb', type: 'video', x: 1300, y: 1100, w: 360, h: 360, data: { label: '分镜视频段', prompt: '', assetId: null, ratio: '16:9', resolution: '720P', duration: 5, status: 'idle' } },
  // 旧资产节点：没有 ratio，只有实测尺寸 → 从尺寸推断比例
  n_square: { id: 'n_square', type: 'image', x: 0, y: 700, w: 360, h: 360, data: { label: '方图', assetId: 'a_sq', assetW: 1024, assetH: 1024, status: 'done' } },
  n_legacy: { id: 'n_legacy', type: 'image', x: 400, y: 700, w: 360, h: 360, data: { label: '旧资产', assetId: 'a_legacy', status: 'done' } },
  // 用户已等比拉伸过的媒体节点（预览区 960×540 = 16:9，外框高 + 固定栏 = 604）→ 重载时不得被回收
  n_scaled: { id: 'n_scaled', type: 'image', x: 1000, y: 700, w: 960, h: 604, data: { label: '放大图', assetId: 'a_scaled', ratio: '16:9', status: 'done' } },
  // 空媒体节点（还没生成，没有操作栏）：按记录比例给外框，但**不加**操作栏高度
  n_empty_img: { id: 'n_empty_img', type: 'image', x: 800, y: 700, w: 360, h: 360, data: { label: '空图片', prompt: '', assetId: null, status: 'idle', ratio: '16:9' } },
  n_empty_vid: { id: 'n_empty_vid', type: 'video', x: 1400, y: 700, w: 360, h: 360, data: { label: '空视频', prompt: '', assetId: null, status: 'idle', ratio: '9:16' } },
  // 文本类：尺寸固定 360×360
  n_text: { id: 'n_text', type: 'text', x: 0, y: 1100, w: 360, h: 360, data: { label: '文本', text: '第1集-场5 文本\n雨夜。深巷。' } },
  n_script: { id: 'n_script', type: 'script', x: 400, y: 1100, w: 360, h: 360, data: { label: '剧本', idea: 'i', output: '【场1】正文\n陈拾：你好。', aiStatus: 'idle' } },
  n_sb: { id: 'n_sb', type: 'storyboard', x: 800, y: 1100, w: 360, h: 360, data: { label: '分镜表', script: 's', shots: [SHOT], aiStatus: 'idle' } },
  n_fc: { id: 'n_fc', type: 'finalcut', x: 1200, y: 1100, w: 360, h: 360, data: { label: '成片', status: 'idle', subs: {}, keepAudio: true, ratio: '16:9', resolution: '720P' } },
};
const SEED_ALL_NODES = Object.assign({}, SEED_NODES, REF_SRC);
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '排版测试', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({ nodes: JSON.parse(JSON.stringify(SEED_ALL_NODES)), edges: JSON.parse(JSON.stringify(REF_EDGES)), view: { x: 0, y: 0, scale: 1 } }));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-node-layout', clipboard: { writeText: async () => {} } },
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

const NODES = sandbox.window.__DSH_IC_NODES__;
const LAYOUT = sandbox.window.__DSH_IC_LAYOUT__;
const SYNC = sandbox.window.__DSH_IC_SYNC__;
if (!NODES || !LAYOUT || !SYNC) {
  console.error('✗ 未暴露 __DSH_IC_NODES__ / __DSH_IC_LAYOUT__ / __DSH_IC_SYNC__（冒烟缝隙被移除？）');
  process.exit(1);
}

// ---------------- 工具：组件返回树的遍历 ----------------
const flatten = (v) => Array.isArray(v) ? v.flat(Infinity).filter((x) => x && typeof x === 'object' && (x.__el || typeof x === 'string')) : [];
const classNameOf = (el) => String((el && el.props && el.props.className) || '');
const hasClass = (el, name) => classNameOf(el).split(/\s+/).includes(name);
/** 深度查找元素（含组件返回的嵌套 children；不调用组件，只遍历已返回的树） */
function findAll(v, out = []) {
  if (!v || typeof v !== 'object') return out;
  if (Array.isArray(v)) { for (const c of v) findAll(c, out); return out; }
  if (!v.__el) return out;
  out.push(v);
  findAll(v.props && v.props.children, out);
  return out;
}
/** 展开组件树：函数组件按 props 真实调用（假 React hook 可跑），用于断言 NodeShell → body → 三段的 DOM 顺序 */
function expand(v, depth = 0) {
  if (depth > 30) return [];
  if (Array.isArray(v)) return v.flatMap((x) => expand(x, depth + 1));
  if (!v || typeof v !== 'object' || !v.__el) return [];
  if (typeof v.type === 'function') return expand(v.type(v.props || {}), depth + 1);
  return [v, ...expand(v.props && v.props.children, depth + 1)];
}
/** 只取**直接子节点**（函数组件展开，但不再往 host 元素的 children 里钻） */
function expandKids(v, depth = 0) {
  if (depth > 30) return [];
  if (Array.isArray(v)) return v.flatMap((x) => expandKids(x, depth + 1));
  if (!v || typeof v !== 'object' || !v.__el) return [];
  if (typeof v.type === 'function') return expandKids(v.type(v.props || {}), depth + 1);
  return [v];
}
/** 取 CSS 里某选择器的第一条规则体（花括号配平，兼容 ${CONST} 模板插值） */
function cssRule(sel) {
  const i = src.indexOf(sel + '{');
  if (i < 0) return '';
  let depth = 0;
  for (let j = i + sel.length; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + sel.length + 1, j); }
  }
  return '';
}
/** 取闭包内函数源码（缩进 4 空格的函数体） */
function fnSrc(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = src.indexOf('\n    }', i);
  return j < 0 ? '' : src.slice(i, j + 6);
}
const nodeOf = (id) => SYNC.graph().nodes[id];
const HDR = () => LAYOUT.NODE_HDR_H;
const FOOT = () => LAYOUT.NODE_FOOT_H;
const barsOn = () => HDR() + FOOT();

// ============================================================
// 1) 纯函数：节点默认 360×360；sizeForRatio 只算**预览区**；nodeSizeForRatio 才是节点外框
// ============================================================
{
  eq({ w: LAYOUT.NODE_W, h: LAYOUT.NODE_H }, { w: 360, h: 360 }, '节点默认尺寸必须是 360×360（文本/剧本/分镜）');
  // 固定栏高度来自原型：标题栏 34px（.hd）、操作栏 39px（.foot = 7+24+7 + 1px border-top）
  eq({ hdr: LAYOUT.NODE_HDR_H, foot: LAYOUT.NODE_FOOT_H }, { hdr: 34, foot: 39 }, '固定栏高度常量：NODE_HDR_H=34 / NODE_FOOT_H=39（逐值对齐原型）');
  eq({ short: LAYOUT.MEDIA_PREVIEW_SHORT, long: LAYOUT.MEDIA_MAX_LONG }, { short: 360, long: 800 }, '预览区短边 360 / 长边上限 800');
  // sizeForRatio = 预览区尺寸（不含标题栏/操作栏）
  eq(LAYOUT.sizeForRatio('16:9'), { w: 640, h: 360 }, "sizeForRatio('16:9') 预览区");
  eq(LAYOUT.sizeForRatio('9:16'), { w: 360, h: 640 }, "sizeForRatio('9:16') 预览区");
  eq(LAYOUT.sizeForRatio('1:1'), { w: 360, h: 360 }, "sizeForRatio('1:1') 预览区");
  eq(LAYOUT.sizeForRatio('4:3'), { w: 480, h: 360 }, "sizeForRatio('4:3') 预览区");
  eq(LAYOUT.sizeForRatio('3:4'), { w: 360, h: 480 }, "sizeForRatio('3:4') 预览区");
  const widePv = LAYOUT.sizeForRatio('21:9');
  ok(Math.max(widePv.w, widePv.h) <= LAYOUT.MEDIA_MAX_LONG, '超长比例（21:9）预览区长边必须 ≤ 800（实际 ' + JSON.stringify(widePv) + '）');
  ok(widePv.w > widePv.h, '21:9 预览区必须横向变长');
  eq(LAYOUT.sizeForRatio(''), { w: 360, h: 360 }, '空比例回落 360×360');
  eq(LAYOUT.sizeForRatio(undefined), { w: 360, h: 360 }, 'undefined 比例回落 360×360');

  // nodeSizeForRatio = 预览区 + 固定栏：w = 预览宽、h = 预览高 + HDR + (hasFooter ? FOOT : 0)
  // 手写数字断言（16:9 有操作栏 → 640 × (360+34+39)）
  eq(LAYOUT.nodeSizeForRatio('16:9', { hasFooter: true }), { w: 640, h: 433 }, "nodeSizeForRatio('16:9', 有操作栏) 必须是 {640,433}");
  eq(LAYOUT.nodeSizeForRatio('16:9', { hasFooter: false }), { w: 640, h: 394 }, "nodeSizeForRatio('16:9', 空态无操作栏) 必须是 {640,394}（不凭空多出操作栏高度）");
  eq(LAYOUT.nodeSizeForRatio('9:16', { hasFooter: true }), { w: 360, h: 713 }, "nodeSizeForRatio('9:16', 有操作栏)");
  eq(LAYOUT.nodeSizeForRatio('9:16', { hasFooter: false }), { w: 360, h: 674 }, "nodeSizeForRatio('9:16', 空态)");
  eq(LAYOUT.nodeSizeForRatio('1:1', { hasFooter: true }), { w: 360, h: 433 }, "nodeSizeForRatio('1:1', 有操作栏)");
  {
    const sz = LAYOUT.nodeSizeForRatio('16:9', { hasFooter: true });
    ok(sz.w === LAYOUT.sizeForRatio('16:9').w, 'nodeSizeForRatio 的宽必须 = 预览区宽（节点宽就是预览宽）');
    ok(sz.h === 360 + HDR() + FOOT(), 'nodeSizeForRatio 的高必须 = 预览高 360 + 标题栏 + 操作栏（实际 ' + sz.h + '）');
    const noFoot = LAYOUT.nodeSizeForRatio('16:9', { hasFooter: false });
    ok(noFoot.h === 360 + HDR(), '无操作栏时高必须 = 预览高 + 标题栏（实际 ' + noFoot.h + '）');
  }
  const wide = LAYOUT.nodeSizeForRatio('21:9', { hasFooter: true });
  ok(wide.w <= LAYOUT.MEDIA_MAX_LONG, '21:9 节点宽（= 预览宽）必须 ≤ 800（实际 ' + wide.w + '）');
  ok(wide.h === LAYOUT.sizeForRatio('21:9').h + barsOn(), '21:9 节点高必须 = 预览高 + 固定栏高');
  // 每个比例：预览盒宽高比误差 ≤1%（盒比 == 媒体比）
  for (const r of ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']) {
    const sz = LAYOUT.nodeSizeForRatio(r, { hasFooter: true });
    const pvAspect = sz.w / (sz.h - barsOn());
    const want = LAYOUT.ratioAspect(r);
    ok(Math.abs(pvAspect - want) / want <= 0.01, r + ' 的预览区盒比失真：' + pvAspect + ' vs ' + want);
  }
}

// ============================================================
// 2) 旧文档加载：按记录比例重算「预览区 + 固定栏」外框（幂等）；用户拉伸过的尺寸不被回收
// ============================================================
{
  // 16:9 有结果：预览 640×360 + 标题栏 34 + 操作栏 39 = 640×433
  eq({ w: nodeOf('n_img').w, h: nodeOf('n_img').h }, { w: 640, h: 433 }, '旧 360×360 的 16:9 图片节点加载后应为 640×433');
  // 9:16 有结果：预览 360×640 + 73 = 360×713
  eq({ w: nodeOf('n_vid').w, h: nodeOf('n_vid').h }, { w: 360, h: 713 }, '旧 360×360 的 9:16 视频节点加载后应为 360×713');
  // 没有 ratio 的旧资产：从实测尺寸推断（1024×1024 → 1:1），外框 360×(360+73)
  eq(nodeOf('n_square').data.ratio, '1:1', '没有 ratio 的旧资产应从实测尺寸推断比例');
  eq({ w: nodeOf('n_square').w, h: nodeOf('n_square').h }, { w: 360, h: 433 }, '1:1 旧资产外框应为 360×433（预览 360×360 + 固定栏）');
  // 既无 ratio 也无尺寸：缺省 16:9
  eq({ w: nodeOf('n_legacy').w, h: nodeOf('n_legacy').h }, { w: 640, h: 433 }, '既无 ratio 也无尺寸的旧资产缺省 16:9（640×433）');
  // 用户等比拉伸过的（预览 960×540，旧固定栏 64 → 604）→ 不得被回收到标准 640 宽
  eq({ w: nodeOf('n_scaled').w, h: nodeOf('n_scaled').h }, { w: 960, h: 604 }, '用户等比拉伸过的媒体节点加载后不得被回收尺寸');
  // 空媒体节点：按记录比例给外框，但没有操作栏 → 16:9 = 640×394、9:16 = 360×674
  eq({ w: nodeOf('n_empty_img').w, h: nodeOf('n_empty_img').h }, { w: 640, h: 394 }, '空态 16:9 图片节点外框 = 预览 640×360 + 标题栏（无操作栏）');
  eq({ w: nodeOf('n_empty_vid').w, h: nodeOf('n_empty_vid').h }, { w: 360, h: 674 }, '空态 9:16 视频节点外框 = 预览 360×640 + 标题栏（无操作栏）');
  // 文本/剧本/分镜/成片：尺寸固定 360×360，不随内容变化
  for (const id of ['n_text', 'n_script', 'n_sb', 'n_fc']) {
    eq({ w: nodeOf(id).w, h: nodeOf(id).h }, { w: 360, h: 360 }, id + ' 文本类/成片节点尺寸必须固定 360×360');
  }
  // 纯函数幂等：已经是「预览 + 固定栏」的节点保持不动
  const scaled = { type: 'image', w: 1280, h: 784, data: { assetId: 'a', ratio: '16:9' } };
  LAYOUT.normalizeMediaNodeSize(scaled);
  eq({ w: scaled.w, h: scaled.h }, { w: 1280, h: 784 }, '已按新规则放大的媒体节点不应被回收（预览 1280×720 + 64）');
  // 上一轮的旧盒子（节点框 = 画面框）必须被纠正
  const oldBox = { type: 'image', w: 640, h: 360, data: { assetId: 'a', ratio: '16:9' } };
  LAYOUT.normalizeMediaNodeSize(oldBox);
  eq({ w: oldBox.w, h: oldBox.h }, { w: 640, h: 433 }, '上一轮「节点框 = 画面框」的旧盒子必须重算为 640×433');
  // 空态（无 assetId）：按比例给外框，不加操作栏高度
  const empty = { type: 'video', w: 360, h: 360, data: { assetId: null, ratio: '9:16' } };
  LAYOUT.normalizeMediaNodeSize(empty);
  eq({ w: empty.w, h: empty.h }, { w: 360, h: 674 }, '空态媒体节点归一：360×674（不加操作栏高度）');
  // 文档级归一必须幂等
  const doc = { nodes: JSON.parse(JSON.stringify(SEED_NODES)) };
  LAYOUT.normalizeGraphDoc(doc);
  const once = JSON.stringify(doc);
  LAYOUT.normalizeGraphDoc(doc);
  ok(JSON.stringify(doc) === once, '文档尺寸归一必须幂等（重复加载结果一致）');
  LAYOUT.normalizeGraphDoc(doc);
  ok(JSON.stringify(doc) === once, '第三次归一仍必须一致（幂等）');
  eq(LAYOUT.ratioFromDims(1080, 1920), '9:16', '1080×1920 → 9:16');
  eq(LAYOUT.ratioFromDims(1024, 576), '16:9', '1024×576 → 16:9（吸附到 16:9 档）');
}

// ============================================================
// 3) 渲染结构：媒体 body 内「标题栏 / 预览区 / 操作栏」三段，固定栏 flex:none，预览不裁切
// ============================================================
{
  const imgNode = { id: 'n_render_img', type: 'image', x: 0, y: 0, w: 640, h: 433, data: { label: '图片', prompt: 'x', assetId: 'a1', ratio: '16:9', status: 'done' } };
  const tree = NODES.MediaNodeBody({ n: imgNode, kind: 'image' });
  const els = findAll(tree);
  const wrap = els.find((e) => hasClass(e, 'dshic-media-wrap'));
  ok(!!wrap, '媒体节点没有预览容器（dshic-media-wrap）');
  const first = flatten(tree)[0];
  ok(first && hasClass(first, 'dshic-media-wrap'), '预览区必须是 MediaNodeBody 的第一个子元素');
  // 沙箱里资产 URL 永远不就绪：必须显示中性骨架，而不是 <img> 破图/白底空态
  ok(els.some((e) => hasClass(e, 'dshic-media-skeleton')), '资产未就绪时必须渲染中性骨架（dshic-media-skeleton）');
  const imgs = els.filter((e) => e.type === 'img');
  ok(imgs.every((im) => !im.props.alt), '未就绪时不得渲染 <img> 破图 alt 占位');
  // 视频节点同样：未就绪 → 骨架
  const vidNode = { id: 'n_render_vid', type: 'video', x: 0, y: 0, w: 360, h: 713, data: { label: '视频', prompt: 'x', assetId: 'a2', ratio: '9:16', resolution: '720P', status: 'done' } };
  const vels = findAll(NODES.MediaNodeBody({ n: vidNode, kind: 'video' }));
  ok(vels.some((e) => hasClass(e, 'dshic-media-skeleton')), '视频未就绪时也必须渲染中性骨架');
  // —— NodeShell 真实结构：body 内从上到下 = 标题栏 / 预览区 / 操作栏 ——
  {
    const shellEls = expand(NODES.NodeShell({ n: imgNode }));
    const body = shellEls.find((e) => hasClass(e, 'dshic-node-body') && hasClass(e, 'is-media'));
    ok(!!body, '媒体节点没有 dshic-node-body.is-media 容器');
    if (body) {
      const kids = expandKids(body.props.children);
      eq(kids.map(classNameOf), ['dshic-node-head', 'dshic-media-wrap', 'dshic-media-foot'],
        '媒体 body 内必须依次是「标题栏 / 预览区 / 操作栏」');
    }
    // 空态：没有操作栏，body 只有「标题栏 / 预览区」两段（节点高度里也不加操作栏）
    const emptyNode = { id: 'n_render_empty', type: 'image', x: 0, y: 0, w: 640, h: 394, data: { label: '空', prompt: '', assetId: null, status: 'idle', ratio: '16:9' } };
    const shellEls2 = expand(NODES.NodeShell({ n: emptyNode }));
    const body2 = shellEls2.find((e) => hasClass(e, 'dshic-node-body') && hasClass(e, 'is-media'));
    if (body2) {
      eq(expandKids(body2.props.children).map(classNameOf), ['dshic-node-head', 'dshic-media-wrap'],
        '空态媒体节点不得渲染操作栏（否则会凭空多出 NODE_FOOT_H 高度）');
    } else ok(false, '空态媒体节点没有 dshic-node-body.is-media 容器');
  }
  // 操作栏必须是 MediaNodeBody 的最后一个元素（按钮行在节点末尾，test-node-actions 同口径）
  {
    const last = flatten(tree).filter((e) => e && e.__el).pop();
    ok(last && last.props && last.props.key === 'acts' && hasClass(last, 'dshic-media-foot'),
      '媒体操作栏必须是最后一个元素且带 dshic-media-foot（固定高度的那一栏）');
  }
  // —— CSS 契约：标题栏/操作栏 flex:none + 明确 height 常量；预览区 flex:1；预览不裁切 ——
  const headRule = cssRule('.dshic-node-head');
  ok(/flex:none/.test(headRule), '.dshic-node-head 必须 flex:none（标题栏不参与拉伸）');
  ok(headRule.includes('height:var(--dshic-head-h)'), '.dshic-node-head 高度必须引用变量 --dshic-head-h（实际规则：' + headRule.slice(0, 120) + '）');
  ok(/box-sizing:border-box/.test(headRule), '.dshic-node-head 必须 border-box（height 常量才能精确等于 32）');
  const footRule = cssRule('.dshic-media-foot');
  ok(/flex:none/.test(footRule), '.dshic-media-foot 必须 flex:none（操作栏不参与拉伸）');
  ok(footRule.includes('height:var(--dshic-foot-h)'), '.dshic-media-foot 高度必须引用变量 --dshic-foot-h（实际规则：' + footRule.slice(0, 120) + '）');
  ok(/box-sizing:border-box/.test(footRule), '.dshic-media-foot 必须 border-box（height 常量才能精确等于 32）');
  const wrapRule = cssRule('.dshic-media-wrap');
  ok(/flex:1/.test(wrapRule), '.dshic-media-wrap 必须 flex:1 撑满剩余高度（预览区吃剩余空间）');
  ok(/min-height:0/.test(wrapRule), '.dshic-media-wrap 必须 min-height:0');
  ok(!/[;{]height:\s*\d/.test(wrapRule), '预览容器不得写死 height（它的高度应由 flex 剩余空间决定）');
  // 预览**不裁切**：上一轮的 object-fit:cover 必须消失（cover 会裁掉约 10% 画面）
  const fillRule = cssRule('.dshic-media-fill');
  ok(!/object-fit:cover/.test(fillRule), '.dshic-media-fill 不得再用 object-fit:cover（会裁切画面）');
  ok(/object-fit:(fill|contain)/.test(fillRule), '.dshic-media-fill 必须是不裁切方案（fill 或 contain）');
  ok(/\.dshic-media-skeleton\{[^}]*position:absolute;[^}]*inset:0/.test(src), '.dshic-media-skeleton 必须绝对定位铺满预览区');
  ok(/\.dshic-node-body\.is-media\{[^}]*padding:0;[^}]*gap:0;[^}]*overflow:hidden/.test(src), '媒体节点 body 必须无 padding/gap（三段紧贴）');
  ok(/\.dshic-node-body\.is-media > \.dshic-node-head\{[^}]*flex:none/.test(src), '媒体节点标题栏嵌在 body 内时同样必须 flex:none');
  // 源码契约：sizeForRatio 只管预览区（不得把固定栏算进画面），nodeSizeForRatio 才加固定栏
  const sfr = fnSrc('sizeForRatio');
  ok(!!sfr, '未找到 sizeForRatio 函数（几何入口被改名？）');
  ok(!/NODE_HDR_H|NODE_FOOT_H|mediaBarsHeight/.test(sfr), 'sizeForRatio 不得把标题栏/操作栏算进画面尺寸（它只返回预览区）');
  const nsfr = fnSrc('nodeSizeForRatio');
  ok(/mediaBarsHeight/.test(nsfr), 'nodeSizeForRatio 必须用 mediaBarsHeight 加固定栏高度');
  ok(!/const sz = sizeForRatio\(/.test(src), '仍有代码把 sizeForRatio（预览区）直接当成节点 w/h —— 必须改用 nodeSizeForRatio');
  // 生成完成 / 加载 / 改比例三条路径都必须走 nodeSizeForRatio（不能只改其中一条）
  ok(/function commitGenResult[\s\S]*?nodeSizeForRatio\(mediaRatioOf\(nd\), \{ hasFooter: true \}\)/.test(src), '生成完成后没有按「预览 + 标题栏 + 操作栏」设置节点外框');
  ok(/function normalizeMediaNodeSize[\s\S]*?nodeSizeForRatio\(ratio, \{ hasFooter \}\)/.test(src), '加载旧文档时没有按记录比例重算媒体外框');
  ok(/const sz = nodeSizeForRatio\(v, \{ hasFooter: mediaHasFooter\(nd\) \}\)/.test(src), '改比例时没有按「预览 + 固定栏」重排媒体外框');
}

// ============================================================
// 4) 点击区域规则（用户明确要求）：只有内容区弹面板；标题栏/底部操作栏不弹；
//    视频双击画面播放、圆形播放键只播放不弹面板；拖动只从标题栏/节点空白发起
// ============================================================
{
  /** 把「点击目标」伪装成某个渲染出来的区域元素：closest 只认它自己身上的 data-* 标记。 */
  const targetOn = (el) => {
    const p = (el && el.props) || {};
    return {
      stopPropagation: noop, preventDefault: noop,
      closest: (sel) => {
        const s = String(sel);
        if (s === LAYOUT.NODE_INTERACTIVE_SELECTOR) return null; // 区域容器本身不是交互控件
        if (s === LAYOUT.NODE_NON_OPEN_SELECTOR) return (p['data-node-head'] || p['data-node-foot']) ? {} : null;
        if (s === LAYOUT.NODE_CONTENT_SELECTOR) return p['data-node-content'] ? {} : null;
        return null;
      },
    };
  };
  const clickOn = (shell, el) => shell.props.onClick({ target: targetOn(el), stopPropagation: noop, preventDefault: noop });
  /** 渲染 NodeShell 并按 data-* 区域标记取出「标题栏 / 内容区 / 底部操作栏」。 */
  const zonesOf = (id) => {
    const shell = NODES.NodeShell({ n: nodeOf(id) });
    const els = expand(shell);
    const props = (e) => (e && e.props) || {};
    return {
      shell,
      head: els.find((e) => hasClass(e, 'dshic-node-head')),
      content: els.find((e) => props(e)['data-node-content']),
      foot: els.find((e) => props(e)['data-node-foot']),
      body: els.find((e) => hasClass(e, 'dshic-node-body')),
    };
  };
  eq(LAYOUT.NODE_CONTENT_SELECTOR, '[data-node-content]', '内容区标记选择器必须是 [data-node-content]');
  ok(LAYOUT.NODE_NON_OPEN_SELECTOR.includes('[data-node-head]') && LAYOUT.NODE_NON_OPEN_SELECTOR.includes('[data-node-foot]'),
    '不弹面板的区域选择器必须同时覆盖 [data-node-head]（标题栏）与 [data-node-foot]（底部操作栏）');
  ok(SYNC.composerId() == null, '初始不应有打开的面板');
  // 6 类节点 + 空媒体节点：标题栏/操作栏不弹，内容区弹
  for (const id of ['n_img', 'n_empty_img', 'n_vid', 'n_text', 'n_script', 'n_sb', 'n_fc']) {
    const z = zonesOf(id);
    ok(!!(z.shell && z.shell.__el), 'NodeShell(' + id + ') 未渲染出根节点');
    ok(typeof z.shell.props.onClick === 'function', id + ' 节点根缺少点击入口（onClick）');
    ok(!!z.head, id + ' 节点缺少标题栏（data-node-head）——拖动/重命名区必须可识别');
    ok(!!z.content, id + ' 节点缺少内容区（data-node-content）——内容区缺失会变成"点了没反应"');
    if (!z.head || !z.content) continue;
    const before = SYNC.composerId();
    clickOn(z.shell, z.head);
    eq(SYNC.composerId(), before, '点击 ' + id + ' 标题栏不应弹生成面板（标题栏是拖动/重命名区）');
    if (z.foot) {
      clickOn(z.shell, z.foot);
      eq(SYNC.composerId(), before, '点击 ' + id + ' 底部操作栏不应弹生成面板（操作栏是按钮区）');
    }
    clickOn(z.shell, z.content);
    eq(SYNC.composerId(), id, '点击 ' + id + ' 内容区未打开生成面板（媒体预览/空态/正文/镜头清单）');
    // 面板渲染条件是 composerId ∈ S.sel：点击后节点必须被选中，否则面板不会出现
    ok(SYNC.selectedIds().includes(id), '点击 ' + id + ' 内容区后节点未被选中——面板会因为 sel 不匹配而不显示');
  }
  // 底部操作栏只在「有结果/有底部动作」的节点上出现：图片、视频、剧本、分镜
  for (const id of ['n_img', 'n_vid', 'n_script', 'n_sb']) {
    ok(!!zonesOf(id).foot, id + ' 有底部操作栏却没渲染 data-node-foot（点击按钮区会被误判为内容区）');
  }
  for (const id of ['n_text', 'n_empty_img', 'n_fc']) {
    ok(!zonesOf(id).foot, id + ' 没有底部操作栏却渲染了 data-node-foot（区域标记错误）');
  }
  // 交互控件（按钮/下拉/视频控件/可编辑输入）仍保留拦截语义
  {
    const z = zonesOf('n_text');
    clickOn(z.shell, z.content);
    eq(SYNC.composerId(), 'n_text', '文本内容区点击应打开面板');
    const buttonTarget = { closest: (sel) => (String(sel).includes('button') ? {} : null), stopPropagation: noop, preventDefault: noop };
    z.shell.props.onClick({ target: buttonTarget, stopPropagation: noop, preventDefault: noop });
    eq(SYNC.composerId(), 'n_text', '点击节点内按钮不应被当成"点击节点打开面板"（控件保留 stopPropagation 语义）');
  }
  for (const sel of ['button', 'select', 'video', 'textarea', 'input']) {
    ok(LAYOUT.NODE_INTERACTIVE_SELECTOR.includes(sel), '节点交互控件选择器缺少 ' + sel + '（会被误判为可打开面板区域）');
  }
  // 拖动只从标题栏/节点空白发起：内容区 pointerdown 不得进入拖动分支
  const npd = fnSrc('onNodePointerDown');
  ok(!!npd, '未找到 onNodePointerDown（拖动入口被改名？）');
  ok(/isNodeContentTarget\(t\)/.test(npd), 'onNodePointerDown 未排除内容区：内容区按下会开始拖动节点');
  ok(!/openComposerFor/.test(npd), 'onNodePointerDown 里仍在打开面板：点标题栏会弹面板（应只在内容区 onClick 里打开）');
  // 图片预览不拦 pointerdown（点了要能弹面板）：只允许 onDoubleClick 做灯箱
  const imgBlock = /key: 'img', className: 'dshic-media-fill'[\s\S]{0,700}?\n\s*\}\)/.exec(src);
  ok(!!imgBlock, '未找到图片预览渲染块（源码契约失效）');
  if (imgBlock) {
    ok(!/data-no-drag/.test(imgBlock[0]), '图片预览仍带 data-no-drag（点击会被拦住，面板打不开）');
    ok(!/onPointerDown/.test(imgBlock[0]), '图片预览仍在 pointerdown 里拦截点击');
  }
  // 空态区点击（尚未生成的媒体节点）→ 选中 + 打开面板
  {
    const els = findAll(NODES.MediaNodeBody({ n: nodeOf('n_empty_img'), kind: 'image' }));
    const empty = els.find((e) => hasClass(e, 'dshic-media-empty') && typeof e.props.onClick === 'function');
    ok(!!empty, '空媒体节点没有可点击的空态区（点击描述画面生成）');
    if (empty) {
      empty.props.onClick({ stopPropagation: noop });
      eq(SYNC.composerId(), 'n_empty_img', '点击空态区未打开生成面板');
      ok(SYNC.selectedIds().includes('n_empty_img'), '点击空态区后面板挂靠的节点未被选中（面板不会显示）');
    }
  }
  // 视频：单击画面 → 面板；双击画面 → 播放；圆形播放键 → 只播放（自身 stopPropagation，不弹面板）
  const vidI = src.indexOf("key: 'vid', ref: videoRef");
  ok(vidI > 0, '未找到视频渲染块（视频交互契约失效）');
  if (vidI > 0) {
    const vidBlock = src.slice(vidI, src.indexOf("key: 'play'", vidI) + 1);
    ok(/onDoubleClick/.test(vidBlock), '视频画面缺少双击播放处理（onDoubleClick）');
    ok(/detail > 1/.test(vidBlock), '视频双击时不应再打开面板（应按 e.detail 跳过单击逻辑）');
    ok(/openPanel\(\)/.test(vidBlock), '视频单击画面应打开生成面板');
  }
  ok(/const togglePlay = \(\) => \{[\s\S]{0,500}?\.play\(\)/.test(src), '视频播放没有调用 <video>.play()');
  {
    const playI = src.indexOf("key: 'play'");
    const playEnd = playI > 0 ? src.indexOf("}, h('i', {}))", playI) : -1;
    ok(playI > 0 && playEnd > playI, '缺少原型式圆形半透明播放键（dshic-media-play）');
    const playBlock = (playI > 0 && playEnd > playI) ? src.slice(playI, playEnd + 20) : '';
    ok(/dshic-media-play/.test(playBlock), '播放键必须用 dshic-media-play 样式（原型圆形半透明播放钮）');
    ok(/stopPropagation/.test(playBlock), '播放键自身必须 stopPropagation（点播放不弹面板）');
    ok(!/openPanel/.test(playBlock), '播放键不得调用 openPanel（点播放不应弹面板）');
  }
  ok(/\.dshic-media-play\{[^}]*pointer-events:none/.test(src), '播放键覆盖层必须 pointer-events:none（只有圆钮可点，其余画面点击仍开面板）');
}

// ============================================================
// 5) 生成面板：宽度不随节点收缩（≥520，≤视口-24）、控件行 nowrap、发送按钮在行内
// ============================================================
{
  ok(LAYOUT.COMPOSER_MIN_W >= 520, '面板最小宽度常量必须 ≥520（实际 ' + LAYOUT.COMPOSER_MIN_W + '）');
  eq(LAYOUT.composerWidthFor(360, 1600), 520, '360 宽节点的面板宽度必须是 520（不随节点收缩）');
  eq(LAYOUT.composerWidthFor(360, 1000), 520, '1000 视口下 360 宽节点的面板仍是 520');
  eq(LAYOUT.composerWidthFor(900, 1600), 720, '节点更宽时面板可放宽到上限 720');
  ok(LAYOUT.composerWidthFor(360, 400) <= 400 - LAYOUT.COMPOSER_VIEWPORT_GAP, '极窄视口时面板宽度不得超过视口 - 24');
  ok(/const pw = composerWidthFor\(r\.width, vw\)/.test(src), '生成面板定位没有使用 composerWidthFor（宽度会重新跟着节点收缩）');
  // 源码契约：控件行 nowrap；模型下拉可收缩；发送按钮 flex:none
  ok(/\.dshic-composer-controls\{[^}]*flex-wrap:nowrap/.test(src), '生成面板控件行必须 flex-wrap:nowrap（否则发送按钮会被挤到第二行）');
  ok(!/\.dshic-composer-controls\{[^}]*flex-wrap:wrap/.test(src), '生成面板控件行不得再 flex-wrap:wrap');
  ok(/\.dshic-send\{[^}]*flex:none/.test(src), '发送按钮必须 flex:none（绝不换行/被压缩）');
  ok(/\.dshic-composer-controls \.dshic-flex\{[^}]*flex:1 1 6px/.test(src), '控件行的弹性占位必须可收缩（flex:1 1 6px）');
  // 渲染：三种控件组合都出现「模型 → 类型控件 → @ → 发送」，发送按钮是控件行的最后一个子节点
  for (const [kind, id] of [['image', 'n_img'], ['video', 'n_vid'], ['storyboard', 'n_sb']]) {
    const n = nodeOf(id);
    const tree = NODES.GenComposer({ nodeId: id, node: n });
    const els = findAll(tree);
    const row = els.find((e) => hasClass(e, 'dshic-composer-controls'));
    ok(!!row, kind + ' 生成面板没有控件行');
    if (!row) continue;
    const kids = flatten(row.props.children);
    ok(kids.length >= 3, kind + ' 控件行子控件过少（' + kids.length + '）');
    ok(hasClass(kids[kids.length - 1], 'dshic-send'), kind + ' 发送按钮必须排在控件行最后（否则会被挤到第二行）');
    const at = kids.find((e) => hasClass(e, 'dshic-at'));
    ok(!!at, kind + ' 生成面板缺少 @ 控件');
    if (at) ok(kids.indexOf(at) < kids.length - 1, kind + ' @ 控件必须在发送按钮之前');
    const modelWrap = kids.find((e) => hasClass(e, 'is-model'));
    if (kind !== 'finalcut') {
      ok(!!modelWrap, kind + ' 生成面板缺少模型下拉');
      // 模型下拉是 PopupSelect 组件元素（未展开）：断言它被标记为可收缩（shrink）且带宽度基准
      if (modelWrap) {
        ok(modelWrap.props.shrink === true, kind + ' 模型下拉必须标记 shrink（空间不足时收缩成省略号）');
        ok(Number(modelWrap.props.width) > 0, kind + ' 模型下拉缺少宽度基准（flex-basis）');
        eq(kids.indexOf(modelWrap), 0, kind + ' 控件顺序错误：模型下拉必须排在最前');
      }
    }
  }
}

// ============================================================
// 5b) 分镜数 / 单段上限支持自定义：下拉预设 + 数值夹取（用户指定 1–100 镜、1–300s 小数）
// ============================================================
{
  // 纯函数：自定义输入必须夹取到范围；整数/一位小数口径固定；非法输入回退 fallback
  const cn = LAYOUT.clampCustomNumber;
  ok(typeof cn === 'function', 'PopupSelect 缺少 clampCustomNumber 测试缝隙（自定义输入无法回归）');
  if (typeof cn === 'function') {
    eq(cn('5', { min: 1, max: 100, integer: true, fallback: 0 }), { ok: true, value: 5 }, '分镜自定义 5 应接受');
    eq(cn('100', { min: 1, max: 100, integer: true, fallback: 8 }), { ok: true, value: 100 }, '分镜自定义上限应为 100');
    eq(cn('101', { min: 1, max: 100, integer: true, fallback: 8 }), { ok: true, value: 100 }, '分镜 101 应夹到 100');
    eq(cn('0', { min: 1, max: 100, integer: true, fallback: 8 }), { ok: false, value: 8 }, '分镜 0 是自动档，不是自定义值');
    eq(cn('abc', { min: 1, max: 100, integer: true, fallback: 8 }), { ok: false, value: 8 }, '非数字自定义输入应拒绝');
    eq(cn('18.5', { min: 1, max: 300, integer: false, decimals: 1, fallback: 15 }), { ok: true, value: 18.5 }, '单段上限应支持一位小数');
    eq(cn('300.4', { min: 1, max: 300, integer: false, decimals: 1, fallback: 15 }), { ok: true, value: 300 }, '单段上限 300.4 应夹到 300');
    eq(cn('0.25', { min: 1, max: 300, integer: false, decimals: 1, fallback: 15 }), { ok: false, value: 15 }, '低于 1 秒的自定义上限应拒绝');
  }

  // 分镜面板两个控件必须真的接上自定义输入与范围
  const n = nodeOf('n_sb');
  const tree = NODES.GenComposer({ nodeId: 'n_sb', node: n });
  const els = findAll(tree);
  const row = els.find((e) => hasClass(e, 'dshic-composer-controls'));
  ok(!!row, '分镜生成面板没有控件行');
  if (row) {
    const kids = flatten(row.props.children);
    const countSel = kids.find((e) => Array.isArray(e.props && e.props.options) && e.props.options.some((o) => String(o && o.value) === '0'));
    ok(!!countSel, '分镜面板缺少镜头数下拉');
    if (countSel) {
      ok(countSel.props.editable === true, '镜头数下拉未开启自定义输入');
      eq({ min: countSel.props.min, max: countSel.props.max, integer: countSel.props.integer }, { min: 1, max: 100, integer: true }, '镜头数自定义范围必须为 1–100 整数');
      ok(typeof countSel.props.customLabel === 'function', '镜头数下拉缺少自定义值展示格式');
    }
    const segSel = kids.find((e) => hasClass(e, 'is-segmax'));
    ok(!!segSel, '分镜面板缺少单段上限下拉');
    if (segSel) {
      ok(segSel.props.editable === true, '单段上限下拉未开启自定义输入');
      eq({ min: segSel.props.min, max: segSel.props.max, integer: segSel.props.integer }, { min: 1, max: 300, integer: false }, '单段上限自定义范围必须为 1–300');
      ok(Number(segSel.props.decimals) === 1, '单段上限自定义小数必须固定一位');
      ok(typeof segSel.props.customLabel === 'function', '单段上限下拉缺少自定义值展示格式');
    }
  }
  // 自定义值不在预设里时，触发按钮必须显示该值，不能错显第一个预设
  ok(/customLabel\s*\? customLabel\(value\)/.test(src), 'PopupSelect 未按自定义值渲染触发按钮文案');
  // 生成端硬上限与 UI 自定义上限一致：100 镜（旧的 24 截断会吃掉用户自定义镜头）
  ok(src.includes('return shots.slice(0, MAX_STORYBOARD_SHOTS)'), '分镜生成仍使用旧的 24 镜截断（应使用 100 上限常量）');
  ok(/const MAX_STORYBOARD_SHOTS = 100;/.test(src), '缺少分镜硬上限常量 MAX_STORYBOARD_SHOTS=100');
  ok(/segments\.length < 128/.test(src), '切段循环上限过低，无法覆盖 100 镜自定义分镜');
}

// ============================================================
// 5c) 视频时长：未连分镜可选/自定义；已连分镜禁用并按镜头节拍计算
// ============================================================
{
  const vd = LAYOUT.videoDurationFor;
  ok(typeof vd === 'function', '缺少 videoDurationFor 测试缝隙（视频时长策略无法回归）');
  if (typeof vd === 'function') {
    // 未连分镜：节点秒数是唯一事实源，支持一位小数；缺省回退 5s
    eq(vd({ data: { duration: 7.2 } }, [], false), { controlled: false, value: 7.2 }, '未连分镜时应使用节点时长');
    eq(vd({ data: { duration: 0 } }, [], false), { controlled: false, value: 5 }, '未连分镜且无有效时长应回退 5s');
    // 已连分镜：分镜镜头 duration 求和；空分镜回退 0，由调用方补告警与 5s
    eq(vd({ data: { duration: 8 } }, [{ duration: 2 }, { duration: 3.2 }], true), { controlled: true, value: 5.2 }, '已连分镜应按镜头节拍求和');
    eq(vd({ data: { duration: 8 } }, [], true), { controlled: true, value: 0 }, '已连空分镜应标记为无时长');
  }

  // 独立视频：时长下拉可自定义
  const vidTree = NODES.GenComposer({ nodeId: 'n_vid', node: nodeOf('n_vid') });
  const vidRow = findAll(vidTree).find((e) => hasClass(e, 'dshic-composer-controls'));
  ok(!!vidRow, '视频生成面板没有控件行');
  if (vidRow) {
    const kids = flatten(vidRow.props.children);
    const durSel = kids.find((e) => Array.isArray(e.props && e.props.options) && e.props.options.some((o) => String(o && o.value) === '4'));
    ok(!!durSel, '独立视频面板缺少时长下拉');
    if (durSel) {
      ok(durSel.props.disabled !== true, '未连分镜的视频时长控件不应禁用');
      ok(durSel.props.editable === true, '未连分镜的视频时长未开启自定义输入');
      eq({ min: durSel.props.min, max: durSel.props.max, integer: durSel.props.integer }, { min: 1, max: 300, integer: false }, '视频时长自定义范围必须为 1–300');
      ok(Number(durSel.props.decimals) === 1, '视频时长自定义小数必须固定一位');
    }
  }

  // 已连分镜：时长下拉禁用；提示词/请求时长由分镜镜头节拍决定
  const sbVidTree = NODES.GenComposer({ nodeId: 'n_vid_sb', node: nodeOf('n_vid_sb') });
  const sbVidRow = findAll(sbVidTree).find((e) => hasClass(e, 'dshic-composer-controls'));
  ok(!!sbVidRow, '已连分镜的视频生成面板没有控件行');
  if (sbVidRow) {
    const kids = flatten(sbVidRow.props.children);
    const durSel = kids.find((e) => Array.isArray(e.props && e.props.options) && e.props.options.some((o) => String(o && o.value) === '4'));
    ok(!!durSel, '已连分镜的视频面板缺少时长下拉');
    if (durSel) {
      ok(durSel.props.disabled === true, '已连分镜的视频时长控件必须禁用');
      ok(typeof durSel.props.disabledLabel === 'function' || typeof durSel.props.disabledLabel === 'string', '禁用态缺少“分镜时长”文案');
    }
  }
  // 生成请求必须改用 durationPlan 的值，不能再把节点 duration 原样传给已连分镜的视频
  ok(/const durationPlan = videoDurationFor\(n, shotList, !!sbUp\)/.test(src), '视频生成未按“是否连接分镜”计算时长策略');
  ok(/duration: autoDuration,/.test(src), '视频请求仍直接传节点 duration（已连分镜时设置会污染请求）');
  ok(/\.dshic-pick:disabled\{/.test(src), '下拉缺少禁用态样式（时长栏不会变灰）');
}

// ============================================================
// 5d) 下拉滚动条可命中；下拉打开时暂停节点缩放热区；文本/剧本正文支持滚轮
// ============================================================
{
  // 纯函数：画布滚轮只在“确实可滚”的正文/列表上放行；输入区与整个下拉菜单始终放行。
  const wheelTarget = LAYOUT.wheelScrollTarget;
  ok(typeof wheelTarget === 'function', '缺少 wheelScrollTarget 测试缝隙（节点滚轮策略无法回归）');
  if (typeof wheelTarget === 'function') {
    const fake = (selector, hit, metrics = {}) => ({
      closest: (s) => (s === selector ? hit : null),
      scrollHeight: metrics.scrollHeight || 0,
      clientHeight: metrics.clientHeight || 0,
      scrollWidth: metrics.scrollWidth || 0,
      clientWidth: metrics.clientWidth || 0,
    });
    const input = { tagName: 'INPUT', closest: (s) => (s.includes('input') ? { type: 'input' } : null) };
    ok(wheelTarget(input) != null, '输入区滚轮必须放行原生行为');
    const menu = { closest: (s) => (s.includes('.dshic-pick-menu') ? { id: 'menu' } : null) };
    ok(wheelTarget(menu) != null, '下拉菜单内滚轮必须放行原生行为');
    const scroller = { id: 'preview', scrollHeight: 500, clientHeight: 300 };
    const preview = fake('.dshic-scroll-preview', scroller, { scrollHeight: 500, clientHeight: 300 });
    ok(wheelTarget(preview) === scroller, '文本/剧本正文可滚动时必须放行滚轮');
    const short = { id: 'preview-short', scrollHeight: 200, clientHeight: 300 };
    const shortNode = fake('.dshic-scroll-preview', short, { scrollHeight: 200, clientHeight: 300 });
    ok(wheelTarget(shortNode) === null, '正文没有溢出时不应霸占滚轮（应保留画布缩放）');
    const list = { id: 'shots', scrollHeight: 800, clientHeight: 300 };
    const shotNode = fake('.dshic-shot-list', list, { scrollHeight: 800, clientHeight: 300 });
    ok(wheelTarget(shotNode) === list, '分镜清单可滚动时必须放行滚轮');
    const plain = { closest: () => null };
    ok(wheelTarget(plain) === null, '画布空白区滚轮仍应用于缩放');
  }

  // 滚动条必须可见且有足够命中宽度；不能只靠系统默认的淡色细条
  ok(/\.dshic-pick-list,\.dshic-scroll-preview,\.dshic-shot-list\{[^}]*scrollbar-width:thin/.test(src),
    '下拉/正文/分镜滚动容器缺少 Firefox thin scrollbar');
  ok(/\.dshic-pick-list::-webkit-scrollbar,\.dshic-scroll-preview::-webkit-scrollbar,\.dshic-shot-list::-webkit-scrollbar\{[^}]*width:12px/.test(src),
    '滚动条宽度必须 ≥12px（当前过窄难命中）');
  ok(/::-webkit-scrollbar-thumb\{[^}]*min-height:32px/.test(src), '滚动条 thumb 缺少最小高度（太短难选中）');
  ok(/::-webkit-scrollbar-thumb:hover\{[^}]*var\(--dsw-alias-brand-primary\)/.test(src), '滚动条 thumb 悬停态不明显');

  // 下拉打开期间禁用节点缩放热区，但不禁用节点本体/内容交互
  ok(/useEffect\(\(\) => \{\s*if \(!open\) return undefined;[\s\S]*?document\.body\.dataset\.dshicPickOpen = '1';/.test(src),
    'PopupSelect 打开时未标记 body（无法暂停节点缩放热区）');
  ok(/body\[data-dshic-pick-open\] \.dshic-rs\{pointer-events:none;\}/.test(src),
    '下拉打开时未禁用节点缩放热区（鼠标会先变拉宽箭头）');
  ok(!/body\[data-dshic-pick-open\] \.dshic-node\{pointer-events:none/.test(src),
    '不能在下拉打开时禁用整个节点（会破坏内容交互）');
  ok(/delete document\.body\.dataset\.dshicPickOpen;/.test(src), 'PopupSelect 关闭后未清理 body 标记');
}

// ============================================================
// 6) 文本/剧本/分镜：body 内容区 flex 撑满剩余高度（拉长不留白带），操作行固定高度
// ============================================================
{
  // 源码契约
  ok(/\.dshic-node-body\{[^}]*flex:1;[^}]*min-height:0;[^}]*overflow:auto/.test(src), '.dshic-node-body 必须 flex:1 + min-height:0 + overflow:auto');
  ok(/\.dshic-node-body > \.dshic-scroll-preview\{[^}]*flex:1 1 auto;[^}]*min-height:0/.test(src), '文本/剧本滚动区必须 flex 撑满剩余高度');
  ok(/\.dshic-scroll-preview\{[^}]*flex:1;[^}]*min-height:0;[^}]*overflow:auto/.test(src), '.dshic-scroll-preview 必须 flex:1 + 内部滚动');
  ok(/\.dshic-node-fill\{[^}]*display:flex;[^}]*flex-direction:column;[^}]*flex:1 1 auto;[^}]*min-height:0/.test(src), '分镜清单外层必须 flex 撑满剩余高度');
  ok(/\.dshic-shot-list\.is-fill\{[^}]*flex:1 1 auto;[^}]*min-height:0;[^}]*max-height:none;[^}]*overflow-y:auto/.test(src), '分镜清单必须 is-fill：撑满 + 内部滚动（不能固定 max-height 留白）');
  ok(/\.dshic-node-body > \.dshic-node-row\{[^}]*flex:none/.test(src), '文本类节点操作行必须 flex:none（固定高度、不被正文拉伸）');
  // 渲染契约：文本/剧本返回可滚动的正文区；分镜清单带 is-fill
  for (const [id, comp, label] of [['n_text', NODES.TextNodeBody, '文本'], ['n_script', NODES.ScriptNodeBody, '剧本']]) {
    const els = findAll(comp({ n: nodeOf(id) }));
    const sc = els.find((e) => hasClass(e, 'dshic-scroll-preview'));
    ok(!!sc, label + '节点没有渲染滚动正文区（dshic-scroll-preview）');
  }
  const sbEls = findAll(NODES.StoryboardNodeBody({ n: nodeOf('n_sb') }));
  const list = sbEls.find((e) => hasClass(e, 'dshic-shot-list'));
  ok(!!list, '分镜节点没有渲染镜头清单');
  if (list) ok(hasClass(list, 'is-fill'), '分镜镜头清单缺少 is-fill（节点拉高时会留空白带）');
  const wrap = sbEls.find((e) => hasClass(e, 'dshic-node-fill'));
  ok(!!wrap, '分镜清单外层缺少 dshic-node-fill（无法撑满剩余高度）');
}

// ============================================================
// 7) 媒体节点拖拽等比缩放：缩放的是预览区，标题栏/操作栏高度恒定
// ============================================================
{
  const a169 = LAYOUT.mediaAspectOf({ type: 'image', data: { ratio: '16:9' } });
  ok(Math.abs(a169 - 16 / 9) < 0.01, '16:9 媒体的 aspect 计算错误：' + a169);
  const a916 = LAYOUT.mediaAspectOf({ type: 'video', data: { ratio: '9:16' } });
  // 初始外框 = 640×(360+64)；拖角/拖边后：预览盒比误差 ≤1%，固定栏高度恒定
  const cases = [
    ['e', 640, 433, 120, 0],
    ['w', 640, 433, -120, 0],
    ['s', 640, 433, 0, 90],
    ['n', 640, 433, 0, -90],
    ['se', 640, 433, 80, 20],
  ];
  for (const [dir, w0, h0, dx, dy] of cases) {
    const box = LAYOUT.resizeBoxFor(dir, w0, h0, dx, dy, a169, { hasFooter: true });
    const pvH = box.h - barsOn();
    ok(pvH > 0, '拖 ' + dir + ' 后预览区高度为负：' + box.h);
    ok(Math.abs(box.w / pvH - a169) / a169 <= 0.01, '拖 ' + dir + ' 后预览区比例误差 >1%：' + box.w + '×' + pvH);
    ok(box.h === pvH + HDR() + FOOT(), '拖 ' + dir + ' 后节点高 ≠ 预览高 + 标题栏 + 操作栏');
    // 固定栏不被拉伸：节点高 - 预览宽/比例 ≈ 固定栏高度（允许 1px 圆整）
    ok(Math.abs((box.h - box.w / a169) - barsOn()) <= 1.5, '拖 ' + dir + ' 后标题栏/操作栏被拉伸了：' + (box.h - box.w / a169));
  }
  // 9:16 视频拖宽：预览 360×640 → 450×800，外框 450×873（固定栏 73）
  {
    const b = LAYOUT.resizeBoxFor('e', 360, 713, 90, 0, a916, { hasFooter: true });
    eq({ w: b.w, h: b.h }, { w: 450, h: 873 }, '9:16 视频拖宽后外框应为 450×873（预览 450×800 + 73）');
    ok(Math.abs(b.w / (b.h - barsOn()) - 9 / 16) / (9 / 16) <= 0.01, '9:16 视频拖宽后预览比例失真：' + b.w + '×' + (b.h - barsOn()));
  }
  // 空态媒体节点（无操作栏）：只扣标题栏，绝不扣操作栏
  {
    const e = LAYOUT.resizeBoxFor('s', 360, 674, 0, 90, a916, { hasFooter: false });
    ok(Math.abs((e.h - e.w / a916) - HDR()) <= 1.5, '空态媒体节点缩放后固定栏应只有标题栏：' + (e.h - e.w / a916));
    ok(Math.abs(e.w / (e.h - HDR()) - a916) / a916 <= 0.01, '空态媒体节点缩放后预览比例失真：' + e.w + '×' + (e.h - HDR()));
  }
  // 缩放后的外框经 normalize 仍是幂等的（用户拉伸过的尺寸在重载后不被回收）
  {
    const box = LAYOUT.resizeBoxFor('e', 640, 433, 300, 0, a169, { hasFooter: true });
    const n = { type: 'image', w: box.w, h: box.h, data: { assetId: 'a', ratio: '16:9' } };
    const before = JSON.stringify(n);
    LAYOUT.normalizeMediaNodeSize(n);
    ok(JSON.stringify(n) === before, '用户拉伸后的媒体外框重载时被回收了：' + before + ' → ' + JSON.stringify(n));
  }
  // 非媒体节点保持自由缩放（不受比例约束）
  eq(LAYOUT.resizeBoxFor('se', 400, 300, 50, 50, null), { w: 450, h: 350 }, '文本类节点应自由缩放（宽高独立）');
  // 旧文档里的媒体比例也能推出（没有 ratio 时用实测尺寸）
  const aInfer = LAYOUT.mediaAspectOf({ type: 'image', data: { assetId: 'a', assetW: 1080, assetH: 1920 } });
  ok(Math.abs(aInfer - 9 / 16) < 0.01, '没有 ratio 时应从资产尺寸推断 aspect：' + aInfer);
  // 记录比例 vs 实测尺寸：一致沿用记录，实测明显不同以画面为准（否则预览必然留边）
  eq(LAYOUT.mediaRatioForDims('16:9', 1920, 1080), '16:9', '实测符合记录比例时应沿用记录值');
  eq(LAYOUT.mediaRatioForDims('16:9', 1080, 1080), '1:1', '实拍/导入素材与记录比例不符时应以画面实际比例为准');
  eq(LAYOUT.mediaRatioForDims('', 1080, 1920), '9:16', '没有记录比例时应从实测尺寸推断');
}

// ============================================================
// 8) 视觉契约（源码级）：节点 + 生成面板的视觉值逐项对齐已验收原型
//    （原型 node-redesign-mockup.html；每个值只允许出现在 --dshic-* 变量里一次，规则必须引用变量）
// ============================================================
{
  const css = LAYOUT.CSS;
  ok(typeof css === 'string' && css.length > 2000, '未暴露 CSS 字符串（视觉契约无法断言）');
  /** 取 .dshic-page 的第一条规则体（= 变量块；变量是节点与面板的唯一取值来源） */
  const varsText = (() => {
    const i = css.indexOf('.dshic-page{');
    if (i < 0) return '';
    let depth = 0;
    for (let j = i + '.dshic-page'.length; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) return css.slice(i, j + 1); }
    }
    return '';
  })();
  const cssVar = (name) => {
    const m = new RegExp('--dshic-' + name + ':([^;]+);').exec(varsText);
    return m ? m[1].trim() : '';
  };
  /** 精确取某条规则体：按顶层选择器精确匹配（避免 `.dshic-pick` 命中 `.dshic-composer-controls .dshic-pick`） */
  const rules = (() => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释：注释里的括号不参与规则切分
    const out = [];
    let depth = 0, selStart = 0, bodyStart = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') {
        if (depth === 0) { bodyStart = i + 1; out.push({ sel: text.slice(selStart, i).trim(), body: '' }); }
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && out.length) { out[out.length - 1].body = text.slice(bodyStart, i); selStart = i + 1; }
      }
    }
    return out;
  })();
  const cssOf = (sel) => {
    const want = String(sel).split(',').map((x) => x.trim()).filter(Boolean);
    const hit = rules.find((r) => {
      const got = r.sel.split(',').map((x) => x.trim());
      return want.every((w) => got.includes(w)) && got.length === want.length;
    });
    return hit ? hit.body : '';
  };
  // —— 变量值：与原型 :root 逐项一致 ——
  eq(cssVar('ink'), '#1b1c1f', '--dshic-ink 必须 = 原型 --ink #1b1c1f');
  eq(cssVar('ink2'), '#5b5f66', '--dshic-ink2 必须 = 原型 --ink2 #5b5f66');
  eq(cssVar('ink3'), '#8b9098', '--dshic-ink3 必须 = 原型 --ink3 #8b9098');
  eq(cssVar('line'), '#e4e5e9', '--dshic-line 必须 = 原型 --line #e4e5e9');
  eq(cssVar('line2'), '#d3d5da', '--dshic-line2 必须 = 原型 --line2 #d3d5da');
  eq(cssVar('line-hover'), '#b9c0cc', '节点 hover 边框必须 = 原型 #b9c0cc（.node:hover）');
  eq(cssVar('card'), '#ffffff', '--dshic-card 必须 = #ffffff');
  eq(cssVar('preview-bg'), '#eef0f4', '预览区底色必须 = 原型 .media #eef0f4');
  eq(cssVar('accent'), '#2b6dfd', '--dshic-accent 必须 = 原型 --accent #2b6dfd');
  eq(cssVar('accent-soft'), '#eaf1ff', '--dshic-accent-soft 必须 = 原型 --accent-soft #eaf1ff');
  eq(cssVar('ok'), '#12a150', '已生成绿点必须 = 原型 --ok #12a150');
  eq(cssVar('shadow'), '0 1px 2px rgba(16,18,22,.06),0 8px 24px rgba(16,18,22,.08)', '--dshic-shadow 必须 = 原型 --shadow');
  eq(cssVar('shadow-lg'), '0 12px 40px rgba(16,18,22,.16),0 2px 6px rgba(16,18,22,.08)', '--dshic-shadow-lg 必须 = 原型 --shadow-lg');
  eq(cssVar('node-r'), '14px', '节点圆角必须 14px（原型 --r）');
  eq(cssVar('head-h'), '34px', '标题栏高度必须 34px（原型 .hd）');
  eq(cssVar('foot-h'), '39px', '操作栏高度必须 39px（原型 .foot：7+24+7+1 border-top）');
  eq(cssVar('foot-pad'), '7px', '操作栏上/下内距必须 7px（原型 .foot padding:7px 9px）');
  eq(cssVar('foot-pad-x'), '9px', '操作栏左/右内距必须 9px（原型 .foot padding:7px 9px）');
  eq(cssVar('mini-h'), '24px', '操作栏按钮高度必须 24px（原型 .mini）');
  eq(cssVar('dash-color'), '#d6d9df', '虚线空态/参考图 + 的虚色必须 #d6d9df');
  eq(cssVar('body-size'), '12px', '文本类正文必须 12px（原型 .scroll）');
  eq(cssVar('body-lh'), '1.65', '文本类正文行高必须 1.65（原型 .scroll）');
  eq(cssVar('body-pad'), '10px', '文本类正文纵向内距必须 10px（原型 .scroll padding:10px 12px）');
  eq(cssVar('body-pad-x'), '12px', '文本类正文横向内距必须 12px（原型 .scroll padding:10px 12px）');
  eq(cssVar('empty-text'), '11.5px', '空态文案必须 11.5px（原型 .empty .t）');
  eq(cssVar('panel-r'), '18px', '生成面板圆角必须 18px（任务书指定；原型 #composer 为 16px）');
  eq(cssVar('pick-h'), '28px', '面板控件按钮高度必须 28px（原型 .pick）');
  eq(cssVar('pick-r'), '8px', '面板控件按钮圆角必须 8px（原型 .pick）');
  eq(cssVar('pick-size'), '11.5px', '面板控件按钮字号必须 11.5px（原型 .pick）');
  eq(cssVar('send-size'), '34px', '发送按钮必须 34px（原型 .send）');
  eq(cssVar('send-bg'), 'var(--dshic-ink)', '发送按钮黑底（#1b1c1f）必须取自 --dshic-ink');
  eq(cssVar('panel-font'), '13px', '面板提示词字号必须 13px（原型 .pw）');
  ok(/^1\.6/.test(cssVar('panel-lh')), '面板提示词行高必须 1.6（原型 1.62）');
  eq(cssVar('panel-pad'), '9px 14px', '面板提示词内距必须 9px 14px（原型 .pw）');
  eq(cssVar('ref-thumb'), '50px', '参考图缩略图必须 50px（任务书）');
  eq(cssVar('ref-r'), '9px', '参考图缩略图圆角必须 9px（任务书）');
  // —— 规则必须引用变量（同一字面量不得在规则里重复写死）——
  const nodeRule = cssOf('.dshic-node');
  ok(/border-radius:var\(--dshic-node-r\)/.test(nodeRule), '.dshic-node 圆角必须引用 --dshic-node-r');
  ok(/border:1px solid var\(--dshic-line2\)/.test(nodeRule), '.dshic-node 必须是 1px solid --dshic-line2 边框');
  ok(/box-shadow:var\(--dshic-shadow\)/.test(nodeRule), '.dshic-node 阴影必须引用 --dshic-shadow');
  ok(!/border-left:/.test(nodeRule), '.dshic-node 不得再有类型色条左边框（原型节点四边同色）');
  ok(!/border-radius:\s*\d/.test(nodeRule), '.dshic-node 圆角不得写死数字');
  ok(/border-color:var\(--dshic-line-hover\)/.test(cssOf('.dshic-node:hover')), '节点 hover 边框必须引用 --dshic-line-hover');
  {
    const selRule = cssOf('.dshic-node.is-selected');
    ok(/border-color:var\(--dshic-accent\)/.test(selRule), '选中节点边框必须 var(--dshic-accent)');
    ok(/box-shadow:var\(--dshic-shadow-sel\),var\(--dshic-shadow\)/.test(selRule), '选中节点必须有 3px accent 光圈 + 常驻阴影');
    eq(cssVar('shadow-sel'), '0 0 0 3px rgba(43,109,253,.16)', '选中光圈必须是 0 0 0 3px rgba(43,109,253,.16)');
  }
  const headRule2 = cssOf('.dshic-node-head');
  ok(/height:var\(--dshic-head-h\)/.test(headRule2), '标题栏高度必须引用 --dshic-head-h');
  ok(/background:var\(--dshic-head-bg\)/.test(headRule2), '标题栏背景必须引用 --dshic-head-bg');
  ok(/border-bottom:1px solid var\(--dshic-line\)/.test(headRule2), '标题栏必须 1px solid --dshic-line 下边框');
  ok(/padding:var\(--dshic-head-pad\)/.test(headRule2), '标题栏内距必须引用 --dshic-head-pad（0 9px 0 10px）');
  ok(cssVar('head-bg') === 'linear-gradient(#fff,var(--dshic-subtle))', '标题栏背景必须是从 #fff 到 --dshic-subtle(#fcfcfd) 的渐变');
  ok(/width:var\(--dshic-head-ic\)[^}]*height:var\(--dshic-head-ic\)/.test(cssOf('.dshic-head-ic')), '标题栏图标必须 16px 且来自变量');
  ok(/color:var\(--dshic-ink3\)/.test(cssOf('.dshic-head-ic')), '标题栏图标必须是灰色（--ink3）');
  ok(/font-size:var\(--dshic-title-size\)/.test(cssOf('.dshic-node-title')) && /color:var\(--dshic-ink\)/.test(cssOf('.dshic-node-title')),
    '标题名必须 12px/600 且为 --ink 色');
  ok(/font-size:var\(--dshic-legacy-size\)/.test(cssOf('.dshic-node-legacy')) && /border:1px solid var\(--dshic-line2\)/.test(cssOf('.dshic-node-legacy')) && /border-radius:5px/.test(cssOf('.dshic-node-legacy')),
    '旧类型小标签必须 10px / 圆角 5 / 1px --line2 边框');
  // 预览区 + 右下信息条 + 状态胶囊 + 参考图角标 + 播放键
  // 全局去灰蓝：这些浮层一律实底主题背景（浅色白 / 深色跟随）+ 1px 线框，不再用半透明 + blur。
  ok(/background:var\(--dshic-preview-bg\)/.test(cssOf('.dshic-media-wrap')), '预览区底色必须引用 --dshic-preview-bg');
  ok(/background:var\(--dshic-meta-bg\)/.test(cssOf('.dshic-media-meta')) && /font-size:var\(--dshic-meta-size\)/.test(cssOf('.dshic-media-meta'))
    && /border-radius:var\(--dshic-meta-r\)/.test(cssOf('.dshic-media-meta')) && /border:1px solid var\(--dshic-line2\)/.test(cssOf('.dshic-media-meta'))
    && !/backdrop-filter/.test(cssOf('.dshic-media-meta')),
    '右下信息条必须实底 / 10px / 圆角 6 / 1px --dshic-line2 边框（不得再用 blur 半透明）');
  eq(cssVar('meta-bg'), 'var(--dsw-alias-bg-layer-1)', '信息条底色必须走主题实底 --dsw-alias-bg-layer-1');
  {
    const badge = cssOf('.dshic-status-badge');
    ok(/background:var\(--dshic-badge-bg\)/.test(badge) && /border:1px solid var\(--dshic-line2\)/.test(badge)
      && /border-radius:var\(--dshic-badge-r\)/.test(badge) && !/backdrop-filter/.test(badge),
      '状态胶囊必须实底 / 1px --dshic-line2 / 胶囊圆角（不得再用 blur 半透明）');
    eq(cssVar('badge-bg'), 'var(--dsw-alias-bg-layer-1)', '状态胶囊底色必须走主题实底 --dsw-alias-bg-layer-1');
    ok(/\.dshic-status-dot\{[^}]*width:6px[^}]*height:6px/.test(src), '状态圆点必须 6px');
    ok(/\.dshic-status-badge\.is-done \.dshic-status-dot\{background:var\(--dshic-ok\);?\}/.test(src), '已生成绿点必须引用 --dshic-ok');
    ok(/\.dshic-status-badge\.is-run \.dshic-status-dot\{background:var\(--dshic-run\);animation:dshic-pulse/.test(src), '生成中蓝点必须 pulse');
  }
  {
    const rb = cssOf('.dshic-refbadge');
    ok(/background:var\(--dshic-refbadge-bg\)/.test(rb) && /right:7px/.test(rb) && /top:7px/.test(rb)
      && /border:1px solid var\(--dshic-line2\)/.test(rb) && !/backdrop-filter/.test(rb),
      '参考图角标必须实底胶囊 + 1px 线框、右上 7px（不得再用 blur 半透明）');
    eq(cssVar('refbadge-bg'), 'var(--dsw-alias-bg-layer-1)', '参考图角标底色必须走主题实底 --dsw-alias-bg-layer-1');
    ok(/\.dshic-refbadge-thumb\{[^}]*width:16px[^}]*height:16px[^}]*border-radius:5px/.test(src), '参考图角标缩略图必须 16px / 圆角 5');
  }
  ok(/\.dshic-media-play i\{[^}]*width:44px[^}]*height:44px[^}]*border-radius:50%/.test(src), '播放键圆钮必须 44px 圆形（原型 .play i）');
  // 空态
  {
    const empty = cssOf('.dshic-media-empty');
    ok(/border:var\(--dshic-dash-w\) dashed var\(--dshic-dash-color\)/.test(empty), '空态必须是 1.5px 虚线（变量）');
    ok(/border-radius:10px/.test(empty), '空态虚线框圆角必须 10px');
    ok(/gap:7px/.test(empty), '空态图标与文案间距必须 7px');
    eq(cssVar('dash-w'), '1.5px', '虚线宽度必须 1.5px');
    ok(/\.dshic-media-empty-ic\{[^}]*width:30px[^}]*height:30px[^}]*border-radius:9px[^}]*background:var\(--dshic-preview-bg\)/.test(src),
      '空态 + 图标必须 30px / 圆角 9 / #eef0f4 底');
    ok(/\.dshic-media-empty-t\{[^}]*font-size:var\(--dshic-empty-text\)/.test(src), '空态文案必须 11.5px');
    ok(/\.dshic-media-empty:hover\{border-color:var\(--dshic-empty-hover\)/.test(src), '空态 hover 边框必须 #bcc4d2');
  }
  // 底部操作栏：固定高度 + border-top + 7px 9px 内距（按钮与画面不贴边）
  {
    const foot = cssOf('.dshic-media-foot');
    ok(/flex:none/.test(foot), '操作栏必须 flex:none');
    ok(/height:var\(--dshic-foot-h\)/.test(foot), '操作栏高度必须引用 --dshic-foot-h');
    ok(/padding:var\(--dshic-foot-pad\) var\(--dshic-foot-pad-x\)/.test(foot), '操作栏内距必须是 7px 9px（来自变量）');
    ok(/border-top:1px solid var\(--dshic-line\)/.test(foot), '操作栏必须有 border-top：把按钮与画面隔开');
    ok(/background:var\(--dshic-foot-bg\)/.test(foot), '操作栏底色必须引用 --dshic-foot-bg');
    ok(/\.dshic-node \.dshic-mini,\.dshic-composer \.dshic-mini\{[^}]*height:var\(--dshic-mini-h\)/.test(src), '节点/面板按钮高度必须引用 --dshic-mini-h（24px）');
    ok(/\.dshic-node \.dshic-mini,\.dshic-composer \.dshic-mini\{[^}]*border-radius:var\(--dshic-mini-r\)/.test(src), '节点/面板按钮圆角必须引用 --dshic-mini-r（7px）');
    ok(/\.dshic-node \.dshic-mini,\.dshic-composer \.dshic-mini\{[^}]*font-size:var\(--dshic-mini-size\)/.test(src), '节点/面板按钮字号必须引用 --dshic-mini-size（11px）');
    ok(/\.dshic-node \.dshic-mini\.pri,\.dshic-composer \.dshic-mini\.pri\{[^}]*background:var\(--dshic-ink\)/.test(src), 'primary 按钮必须黑底白字');
    ok(/\.dshic-node \.dshic-mini\.is-ghost,\.dshic-composer \.dshic-mini\.is-ghost\{border-color:transparent;background:transparent;?\}/.test(src), 'ghost 按钮必须无边框');
  }
  // 生成面板：白底 / 圆角 18 / --shadow-lg / 小三角 / 控件 28 / 发送 34 黑底
  {
    const panel = cssOf('.dshic-composer');
    ok(/background:var\(--dshic-card\)/.test(panel), '面板底色必须白（--dshic-card）');
    ok(/border:1px solid var\(--dshic-line2\)/.test(panel), '面板边框必须 1px solid --dshic-line2');
    ok(/border-radius:var\(--dshic-panel-r\)/.test(panel), '面板圆角必须引用 --dshic-panel-r');
    ok(/box-shadow:var\(--dshic-shadow-lg\)/.test(panel), '面板阴影必须引用 --dshic-shadow-lg');
    ok(!/border-radius:\s*\d/.test(panel), '面板圆角不得写死数字');
    const caret = cssOf('.dshic-composer-caret');
    ok(/width:11px/.test(caret) && /height:11px/.test(caret) && /rotate\(45deg\)/.test(caret), '面板小三角必须 11px 旋转 45deg');
    ok(/background:var\(--dshic-card\)/.test(caret), '小三角底色必须白（与面板一致）');
    const pick = cssOf('.dshic-pick');
    ok(/height:var\(--dshic-pick-h\)/.test(pick) && /border-radius:var\(--dshic-pick-r\)/.test(pick) && /font-size:var\(--dshic-pick-size\)/.test(pick),
      '面板控件按钮必须 28px / 圆角 8 / 11.5px（引用变量）');
    ok(/border:1px solid var\(--dshic-line2\)/.test(pick), '面板控件按钮必须有 1px --line2 边框');
    const send = cssOf('.dshic-send');
    ok(/width:var\(--dshic-send-size\)/.test(send) && /height:var\(--dshic-send-size\)/.test(send), '发送按钮尺寸必须引用 --dshic-send-size（34px）');
    ok(/border-radius:50%/.test(send), '发送按钮必须圆角 50%');
    ok(/background:var\(--dshic-send-bg\)/.test(send), '发送按钮必须黑底（--dshic-send-bg = --dshic-ink #1b1c1f）');
    ok(/\.dshic-composer \.dshic-prompt-back,\.dshic-composer \.dshic-prompt-input\{[^}]*font-size:var\(--dshic-panel-font\)[^}]*line-height:var\(--dshic-panel-lh\)[^}]*padding:var\(--dshic-panel-pad\)/.test(src),
      '面板提示词必须 13px / 行高 1.62 / 内距 9px 14px（且全部来自变量）');
  }
  // 文本类正文与 @实体 高亮
  {
    const body = cssOf('.dshic-scroll-preview');
    ok(/font-size:var\(--dshic-body-size\)/.test(body) && /line-height:var\(--dshic-body-lh\)/.test(body), '正文必须 12px / 1.65（引用变量）');
    ok(/padding:var\(--dshic-body-pad\) var\(--dshic-body-pad-x\)/.test(body), '正文内距必须 10px 12px（引用变量）');
    ok(/color:var\(--dshic-ink2\)/.test(body), '正文颜色必须 #5b5f66（--ink2）');
    ok(/\.dshic-scroll-preview \.dshic-mention,[\s\S]{0,200}?color:var\(--dshic-accent\);font-weight:600/.test(src), '正文 @实体 必须蓝色加粗');
    ok(/\.dshic-mention\{color:var\(--dshic-accent\);?\}/.test(src), '@实体 基础色必须 #2b6dfd');
  }
  // —— 同一字面量只允许在变量块出现一次（规则全部引用变量，不许散落魔法值）——
  for (const lit of ['#e4e5e9', '#d3d5da', '#2b6dfd', '#eef0f4', '#d6d9df', '#1b1c1f', '#b9c0cc', '#12a150', '#5b5f66', '#8b9098', '#fcfcfd']) {
    eq(css.split(lit).length - 1, 1, '视觉字面量 ' + lit + ' 只允许出现在 --dshic-* 变量定义里一次（规则必须引用变量）');
  }
  for (const lit of ['0 8px 24px rgba(16,18,22,.08)', '0 12px 40px rgba(16,18,22,.16)', 'rgba(43,109,253,.16)']) {
    eq(css.split(lit).length - 1, 1, '阴影字面量 ' + lit + ' 只允许出现一次（必须收进 --dshic-* 变量）');
  }
}

// ============================================================
// 9) 生成面板做减法（用户截图）：参考图只留顶部缩略图条 + 拖拽排序，高级项默认折叠；
//    视频节点：未播放只有圆形播放键，播放中才出现控件条（进度/音量），暂停/结束撤销。
// ============================================================
{
  const nImg = nodeOf('n_img');
  const tree = NODES.GenComposer({ nodeId: 'n_img', node: nImg });
  const allEls = findAll(tree);
  const body = allEls.find((e) => hasClass(e, 'dshic-composer-body'));
  ok(!!body, '生成面板缺少 body 容器');
  const bodyKids = body ? expandKids(body.props.children) : [];
  const refsIdx = bodyKids.findIndex((e) => hasClass(e, 'dshic-composer-refs'));
  const promptIdx = bodyKids.findIndex((e) => hasClass(e, 'dshic-composer-prompt'));
  ok(refsIdx >= 0, '图片节点的面板缺少「参考图横向缩略图条」');
  ok(promptIdx >= 0, '生成面板缺少提示词区');
  ok(refsIdx >= 0 && promptIdx >= 0 && refsIdx < promptIdx,
    '缩略图条必须在提示词之上（实际 ' + refsIdx + ' vs ' + promptIdx + '）');

  // 控件行：六种节点类型都必须保持「一行控件、发送按钮在最后」（做减法不得动控件行）
  for (const [kind, id] of [['image', 'n_img'], ['video', 'n_vid'], ['storyboard', 'n_sb'], ['script', 'n_script'], ['text', 'n_text'], ['finalcut', 'n_fc']]) {
    const els = findAll(NODES.GenComposer({ nodeId: id, node: nodeOf(id) }));
    const row = els.find((e) => hasClass(e, 'dshic-composer-controls'));
    ok(!!row, kind + ' 生成面板没有控件行');
    if (row) {
      const kids = flatten(row.props.children);
      ok(kids.length >= 2 && hasClass(kids[kids.length - 1], 'dshic-send'), kind + ' 发送按钮必须是控件行最后一个（保证单行不换行）');
    }
  }

  // —— ① 旧文字版参考图列表彻底移除（[图N] 角色：… ↑ ↓ × 多行列表）——
  ok(!allEls.some((e) => hasClass(e, 'dshic-tag') && String((e.props && e.props.children) || '').indexOf('[图') === 0),
    '仍渲染旧文字版参考图列表（dshic-tag api 的 [图N] 行）');
  ok(!/className: 'dshic-shot-label' \}, T\('refList'\)/.test(src), "旧文字版参考图列表代码仍在（T('refList') 标题）");
  ok(!/title: T\('moveUp'\)/.test(src) && !/title: T\('moveDown'\)/.test(src), '旧 ↑ ↓ 排序按钮未删除');
  ok(!/function RefRows/.test(src), '旧 RefRows 文字列表组件未删除');

  // —— ② 顶部缩略图条：+ 在最左、按 refOrder 排序、带 [图N] 角标与右上角 × ——
  const refsBar = bodyKids.find((e) => hasClass(e, 'dshic-composer-refs'));
  const barKids = refsBar ? flatten(refsBar.props.children) : [];
  ok(barKids.length && hasClass(barKids[0], 'dshic-ref-add') && String(barKids[0].props.children) === '+', '参考图条的 + 上传按钮必须在最左');
  const thumbs = allEls.filter((e) => hasClass(e, 'dshic-ref-thumb'));
  const thumbOrder = thumbs.map((e) => e.props['data-ref-edge']);
  eq(thumbOrder, ['e_ref3', 'e_ref1', 'e_ref2'], '缩略图顺序必须与 node.data.refOrder 一致');
  eq(thumbs.map((e) => e.props['data-ref-idx']), [0, 1, 2], '缩略图必须带 0 基下标（拖拽排序用）');
  ok(thumbs.every((e) => e.props.draggable === true), '每张缩略图都必须可拖拽（draggable=true）');
  const badgeText = (t) => {
    const b = flatten(t.props.children).find((x) => x && x.__el && hasClass(x, 'dshic-ref-idx'));
    return b ? String(b.props.children) : '';
  };
  eq(thumbs.map(badgeText), ['[图1]', '[图2]', '[图3]'], '[图N] 角标必须与 refOrder 下标同步');
  ok(thumbs.every((t) => flatten(t.props.children).some((x) => x && x.__el && hasClass(x, 'dshic-ref-del'))), '缩略图缺少右上角删除 ×');
  ok(/\.dshic-ref-thumb\.is-drop\{[^}]*outline:2px solid var\(--dshic-accent\)/.test(src), '拖拽插入位置缺少高亮样式（.dshic-ref-thumb.is-drop）');
  ok(/\.dshic-ref-idx\{/.test(src) && /\.dshic-ref-del\{/.test(src), '缩略图 [图N] 角标/删除按钮缺少样式');

  // —— ③ 默认折叠：高级区默认不渲染；「更多」展开后才出现（状态切换）——
  ok(!allEls.some((e) => hasClass(e, 'dshic-composer-extra')), '高级区默认不应渲染（必须默认折叠）');
  ok(!allEls.some((e) => String((e.props && e.props['data-advanced']) || '') === '1'), '高级区默认不应渲染（data-advanced）');
  ok(!allEls.some((e) => e.type === 'input' && /扩展参数/.test(String(e.props.placeholder || ''))), '扩展参数 JSON 默认不应占版面');
  ok(!allEls.some((e) => e.type === 'select'), '默认不应渲染衔接模式下拉（高级项）');
  const moreBtn = allEls.find((e) => String((e.props && e.props['data-more-toggle']) || '') === '1');
  ok(!!moreBtn, '面板缺少「更多」折叠开关');
  ok(/setIsMoreOpen\(!isMoreOpen\)/.test(src), '「更多」开关没有切换展开状态');
  ok(/isMoreOpen && hasAdvanced[\s\S]{0,80}?h\(ComposerAdvanced/.test(src), '高级区未受 isMoreOpen 控制（会默认占版面）');
  // 展开态：直接渲染高级区组件（假 React 无法触发 setState，用受控组件断言打开后的内容）
  const advOpen = findAll(NODES.ComposerAdvanced({ n: nImg, isImage: true, isVideo: false, running: false, setData: noop, onMask: noop, onCraft: noop, onVoice: noop }));
  ok(advOpen.some((e) => hasClass(e, 'dshic-composer-extra')), '「更多」展开后应渲染高级区');
  ok(advOpen.some((e) => e.type === 'input' && /扩展参数/.test(String(e.props.placeholder || ''))), '展开后应出现扩展参数 JSON');
  ok(advOpen.some((e) => e.type === 'button' && /蒙版重绘|Mask/.test(String(e.props.title || ''))), '展开后应保留蒙版重绘（功能不得删减）');
  const advVid = findAll(NODES.ComposerAdvanced({ n: nodeOf('n_vid'), isImage: false, isVideo: true, running: false, setData: noop, onMask: noop, onCraft: noop, onVoice: noop }));
  const advSel = advVid.find((e) => e.type === 'select');
  ok(!!advSel, '视频节点展开「更多」后才应显示衔接模式下拉');
  if (advSel) eq(flatten(advSel.props.children).map((o) => o.props.value), ['auto', 'hard', 'off'], '衔接模式下拉必须保留三档（参考图融合 / 硬首帧 / 忽略）');
  // 文本/剧本/分镜：没有参考图条；默认也只剩提示词（+ 控件行）
  for (const id of ['n_text', 'n_script', 'n_sb']) {
    const els = findAll(NODES.GenComposer({ nodeId: id, node: nodeOf(id) }));
    ok(!els.some((e) => hasClass(e, 'dshic-composer-refs')), id + ' 不应出现参考图条');
    ok(!els.some((e) => hasClass(e, 'dshic-composer-extra')), id + ' 高级区默认不应渲染');
  }

  // —— ④ 拖拽排序：dragstart → dragover/dragenter → drop 写回 refOrder，[图N] 同步 ——
  const dt = {
    effectAllowed: '', _m: new Map(),
    setData(k, v) { this._m.set(String(k), String(v)); },
    getData(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : ''; },
  };
  const dev = (extra) => Object.assign({ stopPropagation: noop, preventDefault: noop, dataTransfer: dt }, extra || {});
  const drawThumbs = () => findAll(NODES.GenComposer({ nodeId: 'n_img', node: nodeOf('n_img') })).filter((e) => hasClass(e, 'dshic-ref-thumb'));
  const before = drawThumbs();
  eq(before.map((e) => e.props['data-ref-edge']), ['e_ref3', 'e_ref1', 'e_ref2'], '拖拽前缩略图顺序');
  // 把第 1 张（e_ref3）拖到第 3 个位置（e_ref2 上放下）→ 插入语义
  before[0].props.onDragStart(dev({}));
  ok(dt.getData('text/plain') === '0', 'dragstart 必须把源下标写入 dataTransfer（跨节点拖拽也能拿到）');
  before[2].props.onDragEnter(dev({}));
  before[2].props.onDragOver(dev({}));
  before[2].props.onDrop(dev({}));
  eq(nodeOf('n_img').data.refOrder, ['e_ref1', 'e_ref2', 'e_ref3'], '拖拽后必须把新顺序写回 node.data.refOrder（插入语义）');
  const after = drawThumbs();
  eq(after.map((e) => e.props['data-ref-edge']), ['e_ref1', 'e_ref2', 'e_ref3'], '重渲染后缩略图顺序必须跟随 refOrder');
  eq(after.map((e) => e.props['data-ref-idx']), [0, 1, 2], '[图N] 序号必须跟随新顺序');
  eq(after.map(badgeText), ['[图1]', '[图2]', '[图3]'], '[图N] 角标必须与新的绑定顺序同步');
  // 顺序的唯一来源：collectRefs（提示词绑定 / 厂商上送）必须与面板同口径读取 refOrder
  ok(/function collectRefs[\s\S]{0,600}?orderedRefEdgeIds\(n, edges\)/.test(src), 'collectRefs 未按 refOrder 顺序收集参考图（面板顺序与实际上送会不一致）');
  ok(/function resolveRefMetas[\s\S]{0,400}?orderedRefEdgeIds\(n, es\)/.test(src), 'resolveRefMetas 未按 refOrder 顺序解析参考图');
  // 纯函数：插入语义 / 原地 / 越界 / 不改入参
  eq(LAYOUT.reorderRefOrder(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'], 'reorderRefOrder 插入语义错误');
  eq(LAYOUT.reorderRefOrder(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c'], '末位拖到首位错误');
  eq(LAYOUT.reorderRefOrder(['a', 'b', 'c', 'd'], 1, 1), ['a', 'b', 'c', 'd'], '原地不动必须保持顺序');
  eq(LAYOUT.reorderRefOrder(['a', 'b', 'c', 'd'], 9, 0), ['a', 'b', 'c', 'd'], '越界源下标必须原样返回');
  {
    const base = ['a', 'b', 'c'];
    LAYOUT.reorderRefOrder(base, 0, 2);
    eq(base, ['a', 'b', 'c'], 'reorderRefOrder 不得修改入参');
  }
  eq(LAYOUT.orderedRefEdgeIds({ data: { refOrder: ['e2'] } }, [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]), ['e2', 'e1', 'e3'],
    'orderedRefEdgeIds：refOrder 优先、未记录的按连线先后补到末尾');
  // 缩略图右上角 ×：解除对应参考图连线
  const delBtn = flatten(after[0].props.children).find((x) => x && x.__el && hasClass(x, 'dshic-ref-del'));
  ok(!!delBtn, '缩略图缺少右上角删除按钮');
  if (delBtn) delBtn.props.onClick({ stopPropagation: noop });
  eq(SYNC.graph().edges.filter((e) => e.toNode === 'n_img' && e.toPort === 'ref').map((e) => e.id), ['e_ref2', 'e_ref3'],
    '点击缩略图 × 必须只解除那一条参考图连线');

  // —— ⑤ 视频播放控件显隐状态机 ——
  eq(LAYOUT.videoUiMode(false, false), 'play', '未播放 → 只有圆形播放键（play）');
  eq(LAYOUT.videoUiMode(true, false), 'controls', '播放中 → 出现控件条（controls）');
  eq(LAYOUT.videoUiMode(false, true), 'replay', '播放结束 → 回到圆形按钮（replay）');
  eq(LAYOUT.videoUiMode(true, true), 'controls', '播放中优先于结束态（controls）');
  // 未播放 / 结束：控件条不渲染
  ok(NODES.VideoControls({ mode: 'play' }) == null, '未播放不得渲染控件条');
  ok(NODES.VideoControls({ mode: 'replay' }) == null, '播放结束不得渲染控件条');
  // 播放中：控件条出现，含播放/暂停、可拖动进度、当前/总时长、音量（含静音）
  const cels = findAll(NODES.VideoControls({
    mode: 'controls', current: 5, duration: 20, volume: 0.6, muted: false,
    onToggle: noop, onSeek: noop, onVolume: noop, onMute: noop,
  }));
  ok(cels.some((e) => hasClass(e, 'dshic-media-ctl')), '播放中缺少控件条');
  const ranges = cels.filter((e) => e.type === 'input' && e.props.type === 'range');
  eq(ranges.length, 2, '控件条必须同时有进度条与音量条');
  const seekRange = ranges.find((e) => Number(e.props.max) === 20);
  const volRange = ranges.find((e) => Number(e.props.max) === 1);
  ok(!!seekRange && Number(seekRange.props.min) === 0 && Number(seekRange.props.step) === 0.1, '进度条必须可拖动 seek（0..总时长）');
  ok(!!volRange, '音量条缺失（0..1）');
  ok(!!seekRange && Math.abs(Number(seekRange.props.value) - 5) < 1e-6, '进度条当前值必须来自 timeupdate（current）');
  const timeEl = cels.find((e) => hasClass(e, 'dshic-ctl-time'));
  ok(!!timeEl && /0:05\s*\/\s*0:20/.test(String(timeEl.props.children)), '时间显示必须是 当前 / 总时长（实际：' + String(timeEl && timeEl.props.children) + '）');
  const ctlBtns = cels.filter((e) => e.type === 'button');
  ok(ctlBtns.some((b) => /暂停|Pause/.test(String(b.props.title || ''))), '控件条缺少播放/暂停按钮');
  ok(ctlBtns.some((b) => /静音|Mute/.test(String(b.props.title || ''))), '控件条缺少静音切换按钮');
  // 静音态：音量归零、按钮切到「取消静音」
  const mutedEls = findAll(NODES.VideoControls({
    mode: 'controls', current: 0, duration: 10, volume: 0.1, muted: true,
    onToggle: noop, onSeek: noop, onVolume: noop, onMute: noop,
  }));
  const mutedVol = mutedEls.find((e) => e.type === 'input' && e.props.type === 'range' && Number(e.props.max) === 1);
  ok(!!mutedVol && Number(mutedVol.props.value) === 0, '静音时音量滑杆必须归零');
  ok(mutedEls.some((b) => b.type === 'button' && /取消静音|Unmute/.test(String(b.props.title || ''))), '静音时按钮必须切到取消静音');
  // 控件条自身吞掉点击（点控件条不弹面板；画面其他区域仍按既有规则）
  const ctlEl = cels.find((e) => hasClass(e, 'dshic-media-ctl'));
  ok(!!ctlEl && typeof ctlEl.props.onPointerDown === 'function' && typeof ctlEl.props.onClick === 'function', '控件条缺少事件拦截（点它会误弹生成面板）');
  // 源码契约：timeupdate 驱动；play/pause/ended 切换显隐；不用原生 controls
  ok(/onTimeUpdate/.test(src), '视频缺少 timeupdate 进度驱动');
  ok(/onPause: \(\) => setPlaying\(false\)/.test(src), '暂停时必须撤掉控件条（playing=false）');
  ok(/onEnded: \(\) => \{[^}]*setPlaying\(false\);[^}]*setEnded\(true\);/.test(src), '播放结束必须撤掉控件条并进入重播态');
  ok(/const vidMode = videoUiMode\(playing, ended\)/.test(src), '视频控件显隐未走纯函数状态机');
  // 播放后才挂 <video>（默认只有 poster）：控件条/播放键仍只由 vidMode 决定，且仅视频节点
  ok(/done && kind === 'video' && vidMode !== 'controls'/.test(src) && /done && kind === 'video' && vidMode === 'controls'/.test(src),
    '播放键/控件条的渲染条件必须是 vidMode（且仅视频节点）');
  ok(/\.dshic-media-ctl\{[^}]*position:absolute/.test(src), '控件条必须是画面内的底部浮层（不挤压画面比例）');
  {
    const vi = src.indexOf("key: 'vid', ref: videoRef");
    const pi = src.indexOf("key: 'play'", vi);
    const block = vi >= 0 && pi > vi ? src.slice(vi, pi) : '';
    ok(!!block && !/controls: true/.test(block), '视频预览不得启用原生 controls（原型没有原生控件条）');
    ok(/onDoubleClick/.test(block) && /detail > 1/.test(block) && /openPanel\(\)/.test(block), '视频画面单击开面板 / 双击播放的既有规则被破坏');
  }
}

if (errs.length) {
  console.error('✗ 节点排版/生成面板测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 节点排版/生成面板测试通过（预览区盒比=媒体比·标题栏 34/操作栏 39 固定高度·节点高=预览高+固定栏·旧文档幂等归一·用户拉伸不回收·body 三段结构·预览不裁切·文本类 flex 撑满·只有内容区开面板·视频双击播放·视觉值全部来自 --dshic-* 变量·面板做减法（缩略图条/无文字列表/更多默认折叠）·参考图拖拽排序（[图N] 同步）·视频控件显隐状态机）');
process.exit(0);
