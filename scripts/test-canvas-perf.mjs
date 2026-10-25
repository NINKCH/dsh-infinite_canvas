#!/usr/bin/env node
/**
 * 画布性能回归（P0-A / P0-B / P1 / P2，dev-only，不随包发布）：
 *   1) 空闲视频只渲染 <img poster>，不挂 <video>；playing 后才挂，暂停/播完卸载；
 *   2) 有 poster 即 ready；poster 失败 error；骨架只在无 poster 时出现；
 *   3) videoPosterUrl：缓存 / 并发去重 / 404→生成→POST /api/poster→落盘 URL / 失败静默 / 并发≤2；
 *   4) Host POST /api/poster：正常写入、非法 rel 拒绝、GET 回读 200；
 *   5) idbGet：sqlite 命中不查 IDB、miss 只查一次、json 仍走 IDB、hostRpc 抛错回退；
 *   6) 拖动：pointermove 不 notify、rAF 合并、pointerup 恰 1 次、is-node-dragging 收尾；
 *   7) MediaNodeBody memo：相同 props（同 _rev/连线签名）不重渲染，版本变化才重渲染。
 *
 * 运行：node scripts/test-canvas-perf.mjs；退出码 0 = 通过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-perf-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');
const DATA_ROOT = path.join(SANDBOX, 'data');
fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.writeFileSync(process.env.DSH_IC_CONFIG_PATH, JSON.stringify({ dataRoot: DATA_ROOT }), 'utf8');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => { if (a !== b) errs.push(m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）'); };
const noop = () => {};

// 假 React：memo 缓存相同 props；useState 支持按 hook 序号注入（fake DOM 无状态机）
let hookIndex = 0;
let stateOverrides = [];
const fakeReact = {
  createElement(type, props, ...kids) {
    return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
  },
  useState(init) {
    const i = hookIndex++;
    const val = Object.prototype.hasOwnProperty.call(stateOverrides, i) ? stateOverrides[i] : (typeof init === 'function' ? init() : init);
    return [val, () => {}];
  },
  useEffect: noop, useLayoutEffect: noop, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
  memo(fn, eqFn) {
    let last = null;
    let lastOut = null;
    const wrapped = (props) => {
      if (last && eqFn && eqFn(last, props)) return lastOut;
      last = props;
      hookIndex = 0;
      lastOut = fn(props);
      return lastOut;
    };
    wrapped.__memo = eqFn;
    wrapped.__inner = fn;
    return wrapped;
  },
};
function elStub() {
  return {
    style: {}, dataset: {}, children: [], textContent: '', id: '',
    appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
    getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
    toDataURL: () => 'data:image/jpeg;base64,cG9zdGVy',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  };
}
class FakeVideo {
  constructor() { this.videoWidth = 640; this.videoHeight = 360; this.duration = 2; this._t = 0; this.muted = false; this.playsInline = false; this.preload = ''; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  set currentTime(v) { this._t = v; setTimeout(() => { if (this.onseeked) this.onseeked(); }, 0); }
  get currentTime() { return this._t; }
  load() { setTimeout(() => { if (this.onloadeddata) this.onloadeddata(); }, 0); }
  play() { return Promise.resolve(); }
  pause() {}
  removeAttribute() {}
}
class FakeCanvas {
  constructor() { this.width = 0; this.height = 0; }
  // 缩略图生成会先铺底色再画：测试桩要提供 fillStyle/fillRect，否则被当成失败
  getContext() { return { drawImage: noop, fillRect: noop, fillStyle: '#000' }; }
  toDataURL() { return 'data:image/jpeg;base64,cG9zdGVy'; }
}
const documentStub = {
  createElement: (tag) => (tag === 'video' ? new FakeVideo() : tag === 'canvas' ? new FakeCanvas() : elStub()),
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null, addEventListener: noop, removeEventListener: noop,
};
const lsStore = new Map();
const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };
let rafSeq = 0;
const rafQueue = [];
const requestAnimationFrameStub = (fn) => { const id = ++rafSeq; rafQueue.push({ id, fn }); return id; };
const cancelAnimationFrameStub = (id) => { const i = rafQueue.findIndex((x) => x.id === id); if (i >= 0) rafQueue.splice(i, 1); };
const runRafFrame = () => { const job = rafQueue.shift(); if (job) job.fn(); };

const fetchCalls = [];
let posterOnDisk = false;
const assetRecords = new Map();
async function fetchStub(url, opts = {}) {
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  fetchCalls.push({ url: String(url), method });
  if (String(url).includes('/api/rpc')) {
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch { /* 忽略 */ }
    if (body.method === 'assetsGet') {
      const ids = (body.args && body.args.ids) || [];
      const items = ids.map((id) => assetRecords.get(id)).filter(Boolean);
      return { ok: true, status: 200, json: async () => ({ items }), text: async () => JSON.stringify({ items }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  }
  if (String(url).includes('/api/file') && method === 'HEAD') return { ok: posterOnDisk, status: posterOnDisk ? 200 : 404 };
  if (String(url).includes('/api/file')) return { ok: true, status: 200, blob: async () => new Blob(['x'], { type: 'video/mp4' }) };
  if (String(url).includes('/api/poster')) { posterOnDisk = true; return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' }; }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
}
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub, localStorage: lsStub,
  navigator: { userAgent: 'test-canvas-perf', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: fetchStub, requestAnimationFrame: requestAnimationFrameStub, cancelAnimationFrame: cancelAnimationFrameStub,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  atob: () => 'poster',
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
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try { vm.runInContext(src, sandbox, { filename: 'client.js' }); } catch (e) { console.error('✗ client.js 顶层执行失败：' + ((e && e.stack) || e)); process.exit(1); }
if (!mod) { console.error('✗ __ModuleLoader__.load 未被调用'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
try {
  plugin.apply({
    effect(fn) { fn(); return () => {}; },
    locale: { register: noop, subscribe: () => () => {} },
    slots: { inject(n, cb) { cb(); }, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    layout: { selectPanel: noop },
  });
} catch (e) { console.error('✗ apply(ctx) 执行失败：' + ((e && e.stack) || e)); process.exit(1); }

const PERF = sandbox.window.__DSH_IC_PERF__;
const all = (el, out = []) => {
  if (el == null || typeof el === 'boolean') return out;
  if (Array.isArray(el)) { el.forEach((x) => all(x, out)); return out; }
  if (el.__el) { out.push(el); all(el.props.children, out); }
  return out;
};
const allInner = (el) => { hookIndex = 0; return all(el); };
const clsOf = (el) => String((el && el.props && el.props.className) || '');
const hasClass = (el, c) => clsOf(el).split(/\s+/).includes(c);
const countCalls = (pred) => fetchCalls.filter(pred).length;
const resetFetch = () => { fetchCalls.length = 0; posterOnDisk = false; };
ok(!!PERF, '未暴露 window.__DSH_IC_PERF__（测试缝隙缺失）');

// 1) 空闲视频只画 poster；播放才挂 <video>；暂停/播完卸载
{
  const node = { id: 'n-v1', type: 'video', x: 0, y: 0, w: 640, h: 424, data: { assetId: 'v1', label: 'video' } };
  const props = { n: node, kind: 'video', refSig: '' };
  // hook 序号：0=thumbUrl 1=playUrl 2=poster 3=posterState 4=mediaState 5=playing 6=ended 7=current 8=duration 9=volume 10=muted
  const renderVideo = (over) => {
    stateOverrides = Object.assign({ 2: '/api/file?rel=projects/p/video/v1.mp4.poster.jpg', 3: 'ready' }, over || {});
    return allInner(PERF.MediaNodeBodyInner(props));
  };
  let els = renderVideo({});
  ok(els.some((e) => e.type === 'img' && String(e.props.src || '').includes('.poster.jpg')), '空闲视频节点没有渲染 poster <img>');
  ok(!els.some((e) => e.type === 'video'), '空闲视频节点仍挂着 <video>（应只画 poster）');
  ok(!els.some((e) => hasClass(e, 'dshic-media-skeleton')), '有 poster 时不应出现骨架');
  els = renderVideo({ 5: true });
  const vid = els.find((e) => e.type === 'video');
  ok(!!vid, 'playing=true 时没有挂载 <video>');
  ok(vid && String(vid.props.poster || '').includes('.poster.jpg'), '播放中的 <video> 缺少 poster 兜底');
  ok(vid && vid.props.preload === 'auto', '播放中的 <video> preload 不是 auto');
  ok(vid && typeof vid.props.onDoubleClick === 'function' && typeof vid.props.onClick === 'function', '<video> 双击播放/单击开面板事件丢失');
  els = renderVideo({ 6: true });
  ok(!els.some((e) => e.type === 'video'), '暂停/播完后 <video> 未被卸载（应回到 poster）');
  ok(els.some((e) => hasClass(e, 'dshic-media-play') && hasClass(e, 'is-replay')), '播完后圆形键没有切成重播态');
  const imgNode = { id: 'n-i1', type: 'image', x: 0, y: 0, w: 360, h: 360, data: { assetId: 'i1', label: 'img' } };
  stateOverrides = { 0: '/api/file?rel=projects/p/image/i1.png.thumb.jpg', 4: 'ready' };
  const imgEls = allInner(PERF.MediaNodeBodyInner({ n: imgNode, kind: 'image', refSig: '' }));
  ok(imgEls.some((e) => e.type === 'img' && String(e.props.src || '').includes('.thumb.jpg')), '图片节点应渲染缩略图 <img>');
    ok(!imgEls.some((e) => e.type === 'img' && /i1\\.png$/.test(String(e.props.src || ''))), '图片节点不得直接加载原图');
  ok(!els.some((e) => e.type === 'video'), '图片节点不应出现 <video>');
  // 浏览器级可见性裁剪：视口外媒体内容跳过绘制；节点框/端口仍在节点层，不裁端口
  ok(/\.dshic-media-wrap\{[^}]*content-visibility:auto/.test(src), '媒体内容缺少 content-visibility:auto（无可见性裁剪）');
  ok(!/\.dshic-node\{[^}]*contain:paint/.test(src), '节点容器用了 paint containment（会裁掉端口圆点）');
}

// 2) 有 poster 即 ready；失败 error；骨架只在无 poster 时
{
  const node = { id: 'n-v2', type: 'video', x: 0, y: 0, w: 640, h: 424, data: { assetId: 'v2', label: 'video' } };
  const render = (over) => {
    stateOverrides = Object.assign({}, over);
    return allInner(PERF.MediaNodeBodyInner({ n: node, kind: 'video', refSig: '' }));
  };
  let els = render({ 2: '/poster.jpg', 3: 'ready' });
  ok(els.some((e) => e.type === 'img' && String(e.props.src) === '/poster.jpg'), 'poster 就绪时没有渲染 poster');
  ok(!els.some((e) => hasClass(e, 'dshic-media-skeleton')), 'poster 就绪时骨架仍在（会闪烁）');
  els = render({ 2: null, 3: 'loading' });
  ok(els.some((e) => hasClass(e, 'dshic-media-skeleton')), '无 poster（首次生成中）应显示一次骨架');
  els = render({ 2: null, 3: 'error' });
  ok(!els.some((e) => hasClass(e, 'dshic-media-skeleton')), 'poster 失败后仍来回显示骨架（闪烁）');
  ok(els.some((e) => hasClass(e, 'dshic-media-placeholder')), 'poster 失败时缺少中性占位');
  ok(/有 poster 即视为就绪/.test(src), '源码未说明 poster 即 ready 的语义');
}

// 3) videoPosterUrl 链路
async function posterTest() {
  resetFetch();
  PERF.resetPosterCaches();
  PERF.clearAssetMemAndCaches();
  PERF.setStoreForTest('sqlite');
  assetRecords.set('v1', { id: 'v1', kind: 'video', mime: 'video/mp4', rel: 'projects/p/video/v1.mp4' });
  const url = await PERF.videoPosterUrl('v1');
  ok(String(url || '').includes('v1.mp4.poster.jpg'), 'poster 落盘 URL 不对：' + url);
  eq(countCalls((c) => c.method === 'HEAD'), 1, 'poster 探测 HEAD 次数不对');
  eq(countCalls((c) => c.method === 'POST' && String(c.url).includes('/api/poster')), 1, 'poster 没有 POST 落盘');
  resetFetch();
  const url2 = await PERF.videoPosterUrl('v1');
  eq(url2, url, 'poster 缓存返回的 URL 不一致');
  eq(fetchCalls.length, 0, 'poster 内存缓存命中后仍发起了网络请求');
  resetFetch();
  PERF.resetPosterCaches();
  assetRecords.set('v3', { id: 'v3', kind: 'video', mime: 'video/mp4', rel: 'projects/p/video/v3.mp4' });
  const [a, b] = await Promise.all([PERF.videoPosterUrl('v3'), PERF.videoPosterUrl('v3')]);
  eq(a, b, '并发同 id 的 poster 结果不一致');
  eq(countCalls((c) => c.method === 'POST' && String(c.url).includes('/api/poster')), 1, '并发同 id 生成了多次 poster');
  resetFetch();
  PERF.resetPosterCaches();
  const origCreate = documentStub.createElement;
  documentStub.createElement = (tag) => (tag === 'video' ? Object.assign(new FakeVideo(), { videoWidth: 0, videoHeight: 0 }) : origCreate(tag));
  let failed = null;
  try { failed = await PERF.videoPosterUrl('v3'); } catch (e) { failed = 'THREW:' + e; }
  documentStub.createElement = origCreate;
  eq(failed, null, 'poster 生成失败没有静默回退 null');
  resetFetch();
  PERF.resetPosterCaches();
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
  for (const id of ids) assetRecords.set(id, { id, kind: 'video', mime: 'video/mp4', rel: `projects/p/video/${id}.mp4` });
  await Promise.all(ids.map((id) => PERF.videoPosterUrl(id)));
  ok(PERF.posterStats.max <= 2, 'poster 生成并发超过 2：' + PERF.posterStats.max);
}

// 5) idbGet 顺序
async function idbTest() {
  PERF.setIdbGetRawForTest(null);
  PERF.clearAssetMemAndCaches();
  PERF.setStoreForTest('sqlite');
  assetRecords.set('s1', { id: 's1', kind: 'image', mime: 'image/png', rel: 'projects/p/image/s1.png' });
  let rawHits = 0;
  PERF.setIdbGetRawForTest(async () => { rawHits++; return null; });
  const rec = await PERF.idbGet('s1');
  eq(rec && rec.id, 's1', 'sqlite 模式没有从服务端取到资产');
  eq(rawHits, 0, 'sqlite 模式命中服务端后仍查了 IndexedDB');
  rawHits = 0;
  PERF.clearAssetMemAndCaches();
  eq(await PERF.idbGet('missing-id'), null, '不存在的资产应返回 null');
  eq(await PERF.idbGet('missing-id'), null, '不存在的资产第二次应仍返回 null');
  eq(rawHits, 1, 'sqlite 模式 IDB miss 没有缓存（查了 ' + rawHits + ' 次）');
  ok(PERF.idbMiss.has('missing-id'), 'idbMiss 未记录 miss');
  PERF.setStoreForTest('json');
  PERF.clearAssetMemAndCaches();
  PERF.setIdbGetRawForTest(async (id) => ({ id, kind: 'image', blob: new Blob(['x']) }));
  const jrec = await PERF.idbGet('j1');
  ok(jrec && jrec.id === 'j1', 'json 模式没有走 IndexedDB');
  PERF.setStoreForTest('sqlite');
  PERF.clearAssetMemAndCaches();
  const origFetch = sandbox.fetch;
  PERF.setIdbGetRawForTest(async (id) => ({ id, kind: 'image' }));
  sandbox.fetch = async () => { throw new Error('rpc down'); };
  const erec = await PERF.idbGet('e1');
  sandbox.fetch = origFetch;
  ok(erec && erec.id === 'e1', 'hostRpc 抛错时没有回退 IndexedDB');
  PERF.setIdbGetRawForTest(null);
}

// 6) 拖动 rAF / notify / class
function dragTest() {
  const mkEl = () => ({
    style: {}, setPointerCapture: noop, releasePointerCapture: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }),
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  });
  const canvas = mkEl();
  PERF.setCanvasElForTest(canvas);
  PERF.setViewForTest(0, 0, 1);
  const nodes = {
    a: { id: 'a', type: 'image', x: 0, y: 0, w: 240, h: 96, data: {} },
    b: { id: 'b', type: 'image', x: 400, y: 0, w: 240, h: 96, data: {} },
  };
  PERF.setGraphForTest(nodes, []);
  PERF.nodeEls.clear();
  const elA = mkEl();
  PERF.nodeEls.set('a', elA);
  PERF.nodeEls.set('b', mkEl());
  rafQueue.length = 0;
  PERF.resetNotifyCount();
  PERF.onNodePointerDown({
    button: 0, clientX: 100, clientY: 100, pointerId: 7, altKey: false, shiftKey: false,
    stopPropagation: noop, preventDefault: noop, target: null,
  }, nodes.a);
  eq(PERF.drag.mode, 'node', 'onNodePointerDown 没有进入节点拖动模式');
  ok(canvas.classList.contains('is-node-dragging'), '拖动开始没有给画布根加 is-node-dragging');
  PERF.resetNotifyCount();
  rafQueue.length = 0;
  PERF.drag.snapCandidates = [];
  PERF.onCanvasPointerMove({ clientX: 120, clientY: 100, altKey: false, shiftKey: false });
  PERF.onCanvasPointerMove({ clientX: 140, clientY: 100, altKey: false, shiftKey: false });
  PERF.onCanvasPointerMove({ clientX: 160, clientY: 100, altKey: false, shiftKey: false });
  eq(rafQueue.length, 1, 'pointermove 没有合并到一帧（rAF 数=' + rafQueue.length + '）');
  eq(PERF.notifyCount(), 0, '拖动帧前就触发了全树 notify');
  runRafFrame();
  eq(PERF.notifyCount(), 0, '拖动 rAF 帧内触发了全树 notify');
  eq(nodes.a.x, 60, '拖动没有按最终指针位置更新节点 x');
  eq(elA.style.left, '60px', '拖动没有 imperative 更新 nodeEl.style.left');
  PERF.resetNotifyCount();
  PERF.onCanvasPointerUp({ clientX: 160, clientY: 100 });
  eq(PERF.notifyCount(), 1, 'pointerup 后 notify 次数不是恰好 1 次（实际 ' + PERF.notifyCount() + '）');
  ok(!canvas.classList.contains('is-node-dragging'), 'pointerup 后 is-node-dragging 未移除');
  ok(!PERF.drag.raf, 'pointerup 后 rAF 未清理');
}

// 7) memo 行为
{
  const node = { id: 'n-memo', type: 'video', x: 0, y: 0, w: 640, h: 424, data: { assetId: 'm1', label: 'v' } };
  stateOverrides = { 0: '/u', 1: '/p.jpg', 2: 'ready' };
  const rev = PERF.bumpNodeRev(node);
  const p1 = { n: node, kind: 'video', refSig: '', rev };
  const out1 = PERF.MediaNodeBody(p1);
  const out2 = PERF.MediaNodeBody(p1);
  ok(out1 === out2, 'MediaNodeBody 相同 props/_rev 仍重渲染（memo 未生效）');
  node.data.assetId = 'm2';
  const rev2 = PERF.bumpNodeRev(node);
  ok(rev2 > rev, 'data 真变化时 _rev 没有自增');
  const out3 = PERF.MediaNodeBody({ n: node, kind: 'video', refSig: '', rev: rev2 });
  ok(out3 !== out1, 'MediaNodeBody 版本号变化后没有重渲染');
  const out4 = PERF.MediaNodeBody({ n: node, kind: 'video', refSig: 'e1', rev: rev2 });
  ok(out4 !== out3, '连线签名变化后没有重渲染（参考角标会过期）');
  ok(typeof PERF.MediaNodeBody.__memo === 'function', 'MediaNodeBody 没有使用 React.memo 比较器');
  ok(PERF.mediaNodePropsEqual({ n: node, kind: 'video', refSig: 'e1', rev: 2 }, { n: node, kind: 'video', refSig: 'e1', rev: 2 }),
    'mediaNodePropsEqual 对相同 props 返回 false');
  ok(!PERF.mediaNodePropsEqual({ n: node, kind: 'video', refSig: 'e1', rev: 2 }, { n: node, kind: 'video', refSig: 'e1', rev: 3 }),
    'mediaNodePropsEqual 对版本变化返回 true');
}

// 4) Host /api/poster
async function hostPosterTest() {
  const routes = new Map();
  const hostCtx = {
    effect(fn) { fn(); return () => {}; },
    get() { return undefined; },
    webServer: { register(def) { routes.set(def.path, def.handler); return () => {}; } },
    tools: { register: () => () => {} },
  };
  let hostMod = null;
  try {
    hostMod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href + '?perf=' + Date.now());
    hostMod.apply(hostCtx);
  } catch (e) { errs.push('Host apply 失败 → ' + ((e && e.stack) || e)); return; }
  const posterHandler = routes.get('/infinite-canvas/api/poster');
  const fileHandler = routes.get('/infinite-canvas/api/file');
  ok(!!posterHandler, 'Host 未注册 /api/poster');
  ok(!!fileHandler, 'Host 未注册 /api/file');
  if (!posterHandler || !fileHandler) return;
  const mkReq = (method, url, chunks) => ({
    method, url, headers: {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield Buffer.from(c); },
  });
  const mkRes = () => ({
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b == null ? '' : String(b); },
  });
  const body = [0xff, 0xd8, 0xff, 0xd9];
  const res = mkRes();
  await posterHandler(mkReq('POST', '/infinite-canvas/api/poster?rel=' + encodeURIComponent('projects/p1/video/a.mp4'), [body]), res);
  eq(res.statusCode, 200, 'POST /api/poster 正常写入返回非 200：' + res.body);
  ok(/ok/.test(res.body), 'POST /api/poster 返回体缺少 ok');
  const posterFile = path.join(DATA_ROOT, 'projects', 'p1', 'video', 'a.mp4.poster.jpg');
  ok(fs.existsSync(posterFile), 'poster 文件没有落盘：' + posterFile);
  eq(fs.readFileSync(posterFile).length, body.length, 'poster 落盘大小不对');
  const badRes = mkRes();
  await posterHandler(mkReq('POST', '/infinite-canvas/api/poster?rel=' + encodeURIComponent('../escape.jpg'), [[1, 2, 3]]), badRes);
  eq(badRes.statusCode, 400, 'POST /api/poster 非法 rel 未被拒绝');
  ok(!fs.existsSync(path.join(DATA_ROOT, '..', 'escape.jpg')), '非法 rel 写了数据目录之外的文件');
  const getRes = new Writable({ write(chunk, enc, cb) { getRes.bytes = (getRes.bytes || 0) + chunk.length; cb(); } });
  getRes.statusCode = 200; getRes.headers = {}; getRes.setHeader = function (k, v) { this.headers[k.toLowerCase()] = v; };
  await new Promise((resolve) => {
    getRes.on('finish', resolve); getRes.on('close', resolve);
    fileHandler(mkReq('GET', '/infinite-canvas/api/file?rel=' + encodeURIComponent('projects/p1/video/a.mp4.poster.jpg'), []), getRes);
  });
  eq(getRes.statusCode, 200, 'GET /api/file 回读 poster 非 200');
  eq(getRes.bytes || 0, body.length, 'GET /api/file 回读 poster 内容长度不对');
}

(async () => {
  try { await hostPosterTest(); } catch (e) { errs.push('Host poster 测试异常 → ' + ((e && e.stack) || e)); }
  try { await idbTest(); } catch (e) { errs.push('idbGet 测试异常 → ' + ((e && e.stack) || e)); }
  try { await posterTest(); } catch (e) { errs.push('poster 测试异常 → ' + ((e && e.stack) || e)); }
  try { dragTest(); } catch (e) { errs.push('拖动测试异常 → ' + ((e && e.stack) || e)); }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 忽略 */ }
  if (errs.length) {
    console.error('✗ 画布性能测试未通过（' + errs.length + ' 项）：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✓ 画布性能测试通过：');
  console.log('  · 视频空闲只画 poster / 播放才挂 <video> / 暂停播完卸载；有 poster 即 ready，骨架只出现一次');
  console.log('  · poster：HEAD 探测 → 离屏首帧 → POST 落盘；缓存 / 并发去重 / 并发≤2 / 失败静默');
  console.log('  · idbGet：sqlite 先服务端（不查 IDB），miss 只查一次；JSON 模式走 IDB；RPC 异常回退');
  console.log('  · 拖动：pointermove 合并 rAF、零 notify、imperative style；pointerup 恰 1 次 notify；is-node-dragging 收尾');
  console.log('  · MediaNodeBody memo：相同 props/_rev 不重渲染，data/连线签名变化才重渲染');
  process.exit(0);
})();
