// 铺开到画布：资产库没有的实体必须建「图片生成」节点（并按 canvas-craft 设定图版式写好提示词），
// 不再放空壳占位。同时验证：重复铺开不叠加重复节点、没有资产库数据时不凭空产生资产节点。
// 运行：node scripts/test-expand-assets.mjs（退出码 0=通过）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM / localStorage（同 test-empty-project 套路） ----------------
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

// ---------------- 预置：一个项目 + 一个分镜表（3 个实体）+ 设定集 ----------------
const PID = 'p_expand';
const SB_ID = 'n_sb';
const shots = [
  { title: '镜1', duration: 2, visual: '@陈拾@ 在 @褶皱巷@ 里俯身', motion: '下俯跟进', characters: ['陈拾'], scene: '褶皱巷', props: ['火漆信'], dialogue: [], sfx: '雨声' },
  { title: '镜2', duration: 2, visual: '@陈拾@ 举起 @火漆信@', motion: '固定', characters: ['陈拾'], scene: '褶皱巷', props: ['火漆信'], dialogue: [], sfx: '' },
];
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '铺开测试', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({
  nodes: {
    [SB_ID]: { id: SB_ID, type: 'storyboard', x: 0, y: 0, w: 320, h: 260, data: { status: 'done', shots, label: '场1分镜表' } },
  },
  edges: [],
  view: { x: 0, y: 0, scale: 1 },
}));
lsStub.setItem('dsh-ic:bible:' + PID, JSON.stringify({
  worldview: '时空邮局', style: '写实电影感，冷色调',
  characters: [{ name: '陈拾', desc: '邮差。外观：深灰风衣、旧帆布邮包、短发。声音：低沉沙哑。' }],
  scenes: [{ name: '褶皱巷', desc: '外观：雨夜窄巷、青石地面反光。' }],
  props: [{ name: '火漆信', desc: '外观：泛黄牛皮纸、暗红火漆封蜡。' }],
}));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-expand-assets', clipboard: { writeText: async () => {} } },
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
  // IndexedDB 桩：本测试只用 localStorage 文档 + 空资产库。
  // openDb 必须**快速失败**（onerror），否则 idbByProjectRaw 的 Promise 永不 resolve → 测试挂死。
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
if (!sync || typeof sync.expandStoryboard !== 'function') { console.error('✗ 未暴露 expandStoryboard（冒烟缝隙被移除？）'); process.exit(1); }
// 全局超时保护：任何一步 await 卡住都要立刻失败，而不是让测试挂死
const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('超时未返回：' + label)), ms)),
]);
const sbNode = () => { const g = sync.graph(); return g.nodes[SB_ID]; };
const nodesOfType = (t) => Object.values(sync.graph().nodes).filter((n) => n.type === t);
const edgesTo = (id, port) => sync.graph().edges.filter((e) => e.toNode === id && e.toPort === port);

async function main() {
  // ---------------- 1) 铺开：缺资产 → 图片生成节点（带提示词） ----------------
  await withTimeout(sync.expandStoryboard(sbNode()), 8000, 'expandStoryboard #1');
  const gens = nodesOfType('image-gen');
  const placeholders = nodesOfType('image-asset').filter((n) => n.data && n.data.placeholderName);
  ok(gens.length === 3, '铺开后应有 3 个图片生成节点（陈拾/褶皱巷/火漆信），实际 ' + gens.length);
  ok(placeholders.length === 0, '不应再产生空壳占位资产节点（placeholderName），实际 ' + placeholders.length);
  const labels = gens.map((n) => String(n.data.label || ''));
  for (const want of ['角色-陈拾 设定图', '场景-褶皱巷 设定图', '道具-火漆信 设定图']) {
    ok(labels.includes(want), '缺少图片生成节点「' + want + '」，实际：' + labels.join(' / '));
  }
  for (const n of gens) {
    const p = String(n.data.prompt || '');
    ok(p.length > 80, '图片生成节点「' + n.data.label + '」提示词过短（' + p.length + ' 字），没有按设定图版式写');
    ok(p.includes('【') && p.includes('】'), '图片生成节点「' + n.data.label + '」提示词缺少分段结构');
    ok(String(n.data.size) === '2K' && String(n.data.ratio) === '16:9', '图片生成节点「' + n.data.label + '」清晰度/画幅不对');
  }
  const chen = gens.find((n) => String(n.data.label).includes('陈拾'));
  ok(chen && chen.data.prompt.includes('深灰风衣'), '角色提示词未带入设定集「外观：」');
  ok(chen && !chen.data.prompt.includes('低沉沙哑'), '角色提示词不应带入「声音：」');
  const vgens = nodesOfType('video-gen');
  ok(vgens.length === 1, '铺开应产生 1 个视频生成节点，实际 ' + vgens.length);
  const refEdges = edgesTo(vgens[0].id, 'ref');
  ok(refEdges.length === 3, '视频节点应有 3 条参考图连线，实际 ' + refEdges.length);
  ok(refEdges.every((e) => gens.some((g) => g.id === e.fromNode)), '参考图连线应来自新建的图片生成节点');

  // ---------------- 2) 重复铺开：复用同标签节点，不叠加重复 ----------------
  const gensBefore = nodesOfType('image-gen').length;
  await withTimeout(sync.expandStoryboard(sbNode()), 8000, 'expandStoryboard #2');
  const gensAfter = nodesOfType('image-gen').length;
  ok(gensAfter === gensBefore, '重复铺开不应叠加图片生成节点（前 ' + gensBefore + ' → 后 ' + gensAfter + '）');
  ok(nodesOfType('video-gen').length === 2, '重复铺开会新建视频节点（每段一个），实际 ' + nodesOfType('video-gen').length);

  // ---------------- 3) 没有资产库数据 → 不凭空产生资产节点 ----------------
  ok(nodesOfType('image-asset').length === 0, '无资产库数据时不应凭空产生 image-asset 节点，实际 ' + nodesOfType('image-asset').length);
}

main().then(() => {
  if (errs.length) {
    console.error('✗ 铺开资产测试未通过（' + errs.length + ' 项）：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✓ 铺开资产测试通过（缺资产→带设定图提示词的图片生成节点、设定集外观入词、参考图连线、重复铺开不叠加）');
  process.exit(0);
}).catch((e) => {
  console.error('✗ 铺开资产测试异常：' + (e && e.message));
  process.exit(1);
});
