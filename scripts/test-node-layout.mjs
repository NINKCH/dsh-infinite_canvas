// 节点排版/生成面板的用户实测缺陷回归测试（几何规则已按用户纠正版重写，上一轮的错误断言全部替换）：
//   ① 媒体节点三段几何：标题栏 NODE_HDR_H（固定）+ 预览区（盒比 = 媒体比例，短边 360、长边 ≤800）
//      + 操作栏 NODE_FOOT_H（固定，有结果才渲染）。节点宽 = 预览宽；节点高 = 预览高 + 标题栏 +（有操作栏时的）操作栏。
//      旧文档加载时按记录比例（缺省资产像素，再缺省 16:9）重算外框（幂等）；用户等比拉伸过的尺寸不被回收。
//   ② 渲染结构：媒体 body 内从上到下依次「标题栏 / 预览区 / 操作栏」，标题栏/操作栏 flex:none 固定高度、
//      预览区 flex:1；预览**不裁切**（`.dshic-media-fill` 不得再有 object-fit:cover）。
//   ③ 用户拉伸媒体节点 = 等比缩放预览区（标题栏/操作栏高度恒定）；文本/剧本/分镜固定 360×360、内容区 flex 撑满。
//   ④ 点击节点任意位置（标题栏/预览图/空白/空态/正文）都打开生成面板；生成面板固定宽度/单行控件（上一轮缺陷不许复发）。
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
const SEED_NODES = {
  // 媒体节点：文档里是旧的 360×360 盒子（标题栏/操作栏吃掉画面高度），加载时必须按记录比例重算外框
  n_img: { id: 'n_img', type: 'image', x: 0, y: 0, w: 360, h: 360, data: { label: '角色-林晚 多视图', prompt: 'x', assetId: 'a_img', ratio: '16:9', size: '2K', status: 'done' } },
  n_vid: { id: 'n_vid', type: 'video', x: 700, y: 0, w: 360, h: 360, data: { label: '视频', prompt: 'x', assetId: 'a_vid', ratio: '9:16', resolution: '720P', status: 'done' } },
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
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '排版测试', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({ nodes: JSON.parse(JSON.stringify(SEED_NODES)), edges: [], view: { x: 0, y: 0, scale: 1 } }));

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
  eq({ hdr: LAYOUT.NODE_HDR_H, foot: LAYOUT.NODE_FOOT_H }, { hdr: 32, foot: 32 }, '固定栏高度常量：NODE_HDR_H=NODE_FOOT_H=32');
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
  // 手写数字断言（16:9 有操作栏 → 640 × (360+32+32)）
  eq(LAYOUT.nodeSizeForRatio('16:9', { hasFooter: true }), { w: 640, h: 424 }, "nodeSizeForRatio('16:9', 有操作栏) 必须是 {640,424}");
  eq(LAYOUT.nodeSizeForRatio('16:9', { hasFooter: false }), { w: 640, h: 392 }, "nodeSizeForRatio('16:9', 空态无操作栏) 必须是 {640,392}（不凭空多出操作栏高度）");
  eq(LAYOUT.nodeSizeForRatio('9:16', { hasFooter: true }), { w: 360, h: 704 }, "nodeSizeForRatio('9:16', 有操作栏)");
  eq(LAYOUT.nodeSizeForRatio('9:16', { hasFooter: false }), { w: 360, h: 672 }, "nodeSizeForRatio('9:16', 空态)");
  eq(LAYOUT.nodeSizeForRatio('1:1', { hasFooter: true }), { w: 360, h: 424 }, "nodeSizeForRatio('1:1', 有操作栏)");
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
  // 16:9 有结果：预览 640×360 + 标题栏 32 + 操作栏 32 = 640×424
  eq({ w: nodeOf('n_img').w, h: nodeOf('n_img').h }, { w: 640, h: 424 }, '旧 360×360 的 16:9 图片节点加载后应为 640×424');
  // 9:16 有结果：预览 360×640 + 64 = 360×704
  eq({ w: nodeOf('n_vid').w, h: nodeOf('n_vid').h }, { w: 360, h: 704 }, '旧 360×360 的 9:16 视频节点加载后应为 360×704');
  // 没有 ratio 的旧资产：从实测尺寸推断（1024×1024 → 1:1），外框 360×(360+64)
  eq(nodeOf('n_square').data.ratio, '1:1', '没有 ratio 的旧资产应从实测尺寸推断比例');
  eq({ w: nodeOf('n_square').w, h: nodeOf('n_square').h }, { w: 360, h: 424 }, '1:1 旧资产外框应为 360×424（预览 360×360 + 固定栏）');
  // 既无 ratio 也无尺寸：缺省 16:9
  eq({ w: nodeOf('n_legacy').w, h: nodeOf('n_legacy').h }, { w: 640, h: 424 }, '既无 ratio 也无尺寸的旧资产缺省 16:9（640×424）');
  // 用户等比拉伸过的（预览 960×540）→ 原样保留，不能回收到 640×424
  eq({ w: nodeOf('n_scaled').w, h: nodeOf('n_scaled').h }, { w: 960, h: 604 }, '用户等比拉伸过的媒体节点加载后不得被回收尺寸');
  // 空媒体节点：按记录比例给外框，但没有操作栏 → 16:9 = 640×392、9:16 = 360×672
  eq({ w: nodeOf('n_empty_img').w, h: nodeOf('n_empty_img').h }, { w: 640, h: 392 }, '空态 16:9 图片节点外框 = 预览 640×360 + 标题栏（无操作栏）');
  eq({ w: nodeOf('n_empty_vid').w, h: nodeOf('n_empty_vid').h }, { w: 360, h: 672 }, '空态 9:16 视频节点外框 = 预览 360×640 + 标题栏（无操作栏）');
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
  eq({ w: oldBox.w, h: oldBox.h }, { w: 640, h: 424 }, '上一轮「节点框 = 画面框」的旧盒子必须重算为 640×424');
  // 空态（无 assetId）：按比例给外框，不加操作栏高度
  const empty = { type: 'video', w: 360, h: 360, data: { assetId: null, ratio: '9:16' } };
  LAYOUT.normalizeMediaNodeSize(empty);
  eq({ w: empty.w, h: empty.h }, { w: 360, h: 672 }, '空态媒体节点归一：360×672（不加操作栏高度）');
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
  const imgNode = { id: 'n_render_img', type: 'image', x: 0, y: 0, w: 640, h: 424, data: { label: '图片', prompt: 'x', assetId: 'a1', ratio: '16:9', status: 'done' } };
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
  const vidNode = { id: 'n_render_vid', type: 'video', x: 0, y: 0, w: 360, h: 704, data: { label: '视频', prompt: 'x', assetId: 'a2', ratio: '9:16', resolution: '720P', status: 'done' } };
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
    const emptyNode = { id: 'n_render_empty', type: 'image', x: 0, y: 0, w: 640, h: 392, data: { label: '空', prompt: '', assetId: null, status: 'idle', ratio: '16:9' } };
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
  ok(headRule.includes('height:${NODE_HDR_H}px'), '.dshic-node-head 高度必须是常量 NODE_HDR_H（实际规则：' + headRule.slice(0, 120) + '）');
  ok(/box-sizing:border-box/.test(headRule), '.dshic-node-head 必须 border-box（height 常量才能精确等于 32）');
  const footRule = cssRule('.dshic-media-foot');
  ok(/flex:none/.test(footRule), '.dshic-media-foot 必须 flex:none（操作栏不参与拉伸）');
  ok(footRule.includes('height:${NODE_FOOT_H}px'), '.dshic-media-foot 高度必须是常量 NODE_FOOT_H（实际规则：' + footRule.slice(0, 120) + '）');
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
// 4) 点击节点任意位置都打开生成面板（不依赖只有边框才触发）
// ============================================================
{
  const noHit = { closest: () => null };
  const evt = () => ({ target: noHit, stopPropagation: noop, preventDefault: noop, button: 0 });
  // 先彻底关闭面板
  ok(SYNC.composerId() == null, '初始不应有打开的面板');
  for (const id of ['n_text', 'n_script', 'n_sb', 'n_img', 'n_vid', 'n_fc']) {
    const n = nodeOf(id);
    const shell = NODES.NodeShell({ n });
    ok(!!(shell && shell.__el), 'NodeShell(' + id + ') 未渲染出根节点');
    ok(typeof shell.props.onClick === 'function', id + ' 节点根缺少点击入口（onClick）——只有边框可点会复发');
    shell.props.onClick(evt());
    eq(SYNC.composerId(), id, '点击 ' + id + ' 节点任意位置（标题/预览/正文区）未打开生成面板');
    // 面板渲染条件是 composerId ∈ S.sel：点击后节点必须被选中，否则面板不会出现（缺陷 2 的真实表现）
    ok(SYNC.selectedIds().includes(id), '点击 ' + id + ' 后节点未被选中——面板会因为 sel 不匹配而不显示');
  }
  // 真正的交互控件（按钮/下拉/视频控件/可编辑输入）保留拦截：点击它们不重新打开面板
  const shell = NODES.NodeShell({ n: nodeOf('n_text') });
  shell.props.onClick(evt()); // 面板挂到文本节点
  const buttonTarget = { closest: (sel) => (String(sel).includes('button') ? {} : null) };
  shell.props.onClick({ target: buttonTarget, stopPropagation: noop, preventDefault: noop });
  eq(SYNC.composerId(), 'n_text', '点击节点内按钮不应被当成"点击节点打开面板"（控件保留 stopPropagation 语义）');
  // 交互控件选择器必须覆盖按钮/下拉/视频控件/可编辑输入
  for (const sel of ['button', 'select', 'video', 'textarea', 'input']) {
    ok(LAYOUT.NODE_INTERACTIVE_SELECTOR.includes(sel), '节点交互控件选择器缺少 ' + sel + '（会被误判为可打开面板区域）');
  }
  // 图片预览不再拦截 pointerdown：源码里 img 预览块不得出现 stopPropagation/data-no-drag
  const imgBlock = /key: 'img', className: 'dshic-media-fill'[\s\S]{0,700}?\n\s*\}\)/.exec(src);
  ok(!!imgBlock, '未找到图片预览渲染块（源码契约失效）');
  if (imgBlock) {
    ok(!/data-no-drag/.test(imgBlock[0]), '图片预览仍带 data-no-drag（点击会被拦住，面板打不开）');
    ok(!/onPointerDown/.test(imgBlock[0]), '图片预览仍在 pointerdown 里拦截点击');
  }
  // 空态区点击（尚未生成的媒体节点）→ 选中 + 打开面板
  {
    const emptyNode = nodeOf('n_empty_img');
    const els = findAll(NODES.MediaNodeBody({ n: emptyNode, kind: 'image' }));
    const empty = els.find((e) => hasClass(e, 'dshic-media-empty') && typeof e.props.onClick === 'function');
    ok(!!empty, '空媒体节点没有可点击的空态区（点击描述画面生成）');
    if (empty) {
      empty.props.onClick({ stopPropagation: noop });
      eq(SYNC.composerId(), 'n_empty_img', '点击空态区未打开生成面板');
      ok(SYNC.selectedIds().includes('n_empty_img'), '点击空态区后面板挂靠的节点未被选中（面板不会显示）');
    }
  }
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
    ['e', 640, 424, 120, 0],
    ['w', 640, 424, -120, 0],
    ['s', 640, 424, 0, 90],
    ['n', 640, 424, 0, -90],
    ['se', 640, 424, 80, 20],
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
  // 9:16 视频拖宽：预览 360×640 → 450×800，外框 450×864（固定栏 64）
  {
    const b = LAYOUT.resizeBoxFor('e', 360, 704, 90, 0, a916, { hasFooter: true });
    eq({ w: b.w, h: b.h }, { w: 450, h: 864 }, '9:16 视频拖宽后外框应为 450×864（预览 450×800 + 64）');
    ok(Math.abs(b.w / (b.h - barsOn()) - 9 / 16) / (9 / 16) <= 0.01, '9:16 视频拖宽后预览比例失真：' + b.w + '×' + (b.h - barsOn()));
  }
  // 空态媒体节点（无操作栏）：只扣标题栏，绝不扣操作栏
  {
    const e = LAYOUT.resizeBoxFor('s', 360, 672, 0, 90, a916, { hasFooter: false });
    ok(Math.abs((e.h - e.w / a916) - HDR()) <= 1.5, '空态媒体节点缩放后固定栏应只有标题栏：' + (e.h - e.w / a916));
    ok(Math.abs(e.w / (e.h - HDR()) - a916) / a916 <= 0.01, '空态媒体节点缩放后预览比例失真：' + e.w + '×' + (e.h - HDR()));
  }
  // 缩放后的外框经 normalize 仍是幂等的（用户拉伸过的尺寸在重载后不被回收）
  {
    const box = LAYOUT.resizeBoxFor('e', 640, 424, 300, 0, a169, { hasFooter: true });
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

if (errs.length) {
  console.error('✗ 节点排版/生成面板测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 节点排版/生成面板测试通过（预览区盒比=媒体比·标题栏/操作栏固定高度·节点高=预览高+固定栏·旧文档幂等归一·用户拉伸不回收·body 三段结构·预览不裁切·文本类 flex 撑满·点击任意位置开面板·面板 ≥520 nowrap 发送不换行）');
process.exit(0);
