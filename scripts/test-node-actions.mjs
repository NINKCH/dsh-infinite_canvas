// 节点排版规范：**作用于「已生成结果」的操作按钮必须放在节点末尾左下角**（内容之后、alignSelf:flex-start），
// 参考分镜节点（复制全部 / 存为资产 / 铺开到画布）。曾经剧本节点把「铺开到场景 / 存为资产」夹在
// 生成按钮与输出正文之间，用户要往下扫一遍节点才能找到——这条规范从此由本测试兜住。
// 媒体节点合并后：图片/视频节点底部只有「下载 / 重新生成 / 参考图 N」三个结果操作，空节点没有生成按钮。
// 运行：node scripts/test-node-actions.mjs（退出码 0=通过）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

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
  navigator: { userAgent: 'test-node-actions', clipboard: { writeText: async () => {} } },
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
if (!NODES) { console.error('✗ 未暴露 __DSH_IC_NODES__（冒烟缝隙被移除？）'); process.exit(1); }

// 取组件返回的节点数组（有些 body 返回 Fragment 数组的嵌套数组，统一拍平）
const flatten = (v) => Array.isArray(v) ? v.flat(Infinity).filter((x) => x && typeof x === 'object' && x.__el) : [];
const keyOf = (el) => String((el && el.props && el.props.key) || '');
/** 断言：若该 body 渲染了操作行（key='acts'），它必须是**最后一个**节点（末尾左下角），
 *  且节点内不得再出现旧的中间位置操作行（key='btns'）。 */
function assertActionsAtEnd(label, children) {
  const els = flatten(children);
  ok(els.length > 0, label + ' 没有渲染出任何内容');
  const actsIdx = els.findIndex((e) => keyOf(e) === 'acts');
  ok(actsIdx >= 0, label + ' 未渲染操作行（key=acts）——结果操作按钮消失了');
  if (actsIdx >= 0) {
    ok(actsIdx === els.length - 1, label + ' 的操作行不在末尾（第 ' + (actsIdx + 1) + '/' + els.length
      + ' 个），结果操作按钮必须放节点左下角');
    const row = els[actsIdx];
    ok(String(row.props.style && row.props.style.alignSelf) === 'flex-start',
      label + ' 的操作行缺少 alignSelf:flex-start（应左对齐，而不是居中/拉伸）');
  }
  ok(!els.some((e) => keyOf(e) === 'btns'), label + ' 仍存在旧的中间位置操作行（key=btns）');
}

const sbNode = { id: 'n_sb', type: 'storyboard', x: 0, y: 0, w: 320, h: 260, data: { label: '场1', script: '【场1】测试', shots: [{ title: '镜1', duration: 2, visual: '@陈拾@ 站着', motion: '固定', characters: ['陈拾'], scene: '巷子', props: [], dialogue: [], sfx: '' }] } };
const scriptNode = { id: 'n_sc', type: 'script', x: 0, y: 0, w: 320, h: 260, data: { label: '第一节剧本', idea: '创意', output: '【场1】测试剧本正文\n陈拾：你好。' } };

// 1) 剧本节点：铺开到场景 / 存为资产 → 末尾左下角
assertActionsAtEnd('剧本节点', NODES.ScriptNodeBody({ n: scriptNode }));
// 2) 分镜节点：复制全部 / 存为资产 / 铺开到画布 → 末尾左下角（规范源头）
assertActionsAtEnd('分镜节点', NODES.StoryboardNodeBody({ n: sbNode }));

// 3) 媒体节点（合并后的图片/视频）与成片节点：有产物时操作行同样必须在末尾（无产物时不渲染操作行，不参与断言）。
//    媒体节点底部的「下载 / 重新生成 / 参考图 N」是本次改版后唯一的结果操作入口。
for (const [label, comp, node, kind] of [
  ['图片节点', NODES.MediaNodeBody, { id: 'n_ig', type: 'image', x: 0, y: 0, w: 360, h: 360, data: { label: '角色-陈拾 设定图', prompt: 'x', assetId: 'a1', ratio: '16:9', size: '2K', status: 'done' } }, 'image'],
  ['视频节点', NODES.MediaNodeBody, { id: 'n_vid', type: 'video', x: 0, y: 0, w: 640, h: 360, data: { label: '视频', prompt: 'x', assetId: 'a1', ratio: '16:9', resolution: '720P', status: 'done' } }, 'video'],
  ['成片节点', NODES.FinalCutNodeBody, { id: 'n_fc', type: 'finalcut', x: 0, y: 0, data: { label: '成片', assetId: 'a1' } }, undefined],
]) {
  const els = flatten(comp({ n: node, kind }));
  const actsIdx = els.findIndex((e) => keyOf(e) === 'acts');
  if (actsIdx >= 0) ok(actsIdx === els.length - 1, label + ' 的操作行不在末尾（' + (actsIdx + 1) + '/' + els.length + '）');
}

// 3b) 空媒体节点：只显示空态，绝不内嵌生成按钮（生成动作在生成面板的发送按钮里）
for (const kind of ['image', 'video']) {
  const emptyNode = { id: 'n_empty_' + kind, type: kind, x: 0, y: 0, w: 360, h: 360, data: { label: kind, prompt: '', assetId: null, status: 'idle' } };
  const els = flatten(NODES.MediaNodeBody({ n: emptyNode, kind }));
  ok(els.length > 0, kind + ' 空节点没有渲染任何内容（应该有虚线空态）');
  ok(!els.some((e) => keyOf(e) === 'acts'), kind + ' 空节点不应渲染结果操作行（无结果可操作）');
  ok(!els.some((e) => String(e.props && e.props.className || '').includes('dshic-gen')), kind + ' 空节点内不应有生成按钮');
}

// 3c) 生成面板：本次改版后 text/script/storyboard/image/video/finalcut 都能渲染（控件按类型区分）
for (const kind of ['text', 'script', 'storyboard', 'image', 'video', 'finalcut']) {
  const n = { id: 'n_c_' + kind, type: kind, x: 0, y: 0, w: 360, h: 360, data: { label: kind, prompt: 'x', idea: 'i', script: 's', text: 't', ratio: '16:9', size: '2K', resolution: '720P', duration: 5, shots: [], status: 'idle' } };
  const out = NODES.GenComposer({ nodeId: n.id, node: n });
  ok(!!out && out.__el, '生成面板 ' + kind + ' 未渲染出面板根节点');
}

// 4) 源码面：旧的中部操作行标记彻底消失（防止换个 key 又摆回中间）
ok(!/key: 'btns'/.test(src), 'client.js 仍残留 key=btns 的中间位置操作行');

if (errs.length) {
  console.error('✗ 节点操作排版测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 节点操作排版测试通过（结果操作按钮统一在节点末尾左下角：剧本 / 分镜 / 合并图片·视频 / 成片；空媒体节点无生成按钮；生成面板六种类型均可渲染）');
process.exit(0);
