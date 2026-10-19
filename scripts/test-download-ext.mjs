// IC-01 定向单测：下载/导出扩展名必须按真实容器（MIME）判定，不再写死 .webm / .png。
// 运行：node scripts/test-download-ext.mjs
// 套路同 test-drag-alt.mjs：假 React + 桩 DOM 在 vm 里加载 client.js，经冒烟缝隙取纯函数。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM ----------------
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
  createElement: (tag) => {
    const el = elStub();
    if (tag === 'canvas') el.captureStream = () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] });
    return el;
  },
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null,
  addEventListener: noop, removeEventListener: noop,
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-download-ext', clipboard: { writeText: async () => {} } },
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
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} } });

const exportObj = sandbox.window.__DSH_IC_MEDIA__;
ok(exportObj && typeof exportObj.extForDownload === 'function', '冒烟缝隙未暴露 window.__DSH_IC_MEDIA__.extForDownload');
const ext = (exportObj && exportObj.extForDownload) || (() => 'MISSING');

// ---------------- 1) 行为断言：MIME 优先 ----------------
const cases = [
  ['video/mp4', '', 'video', '.mp4', '视频 mp4（成片主链路）'],
  ['video/mp4; codecs=avc1.42E01E', '', 'video', '.mp4', '带 codecs 参数的 mp4'],
  ['video/webm', '', 'video', '.webm', '真 webm 容器'],
  ['video/webm;codecs=vp9', 'x', 'video', '.webm', '带 codecs 的 webm'],
  ['video/quicktime', '', 'video', '.mov', 'mov 容器'],
  ['video/x-matroska', '', 'video', '.mkv', 'mkv 容器'],
  ['image/png', '', 'image', '.png', 'png'],
  ['image/jpeg', '', 'image', '.jpg', 'jpeg'],
  ['image/webp', '', 'image', '.webp', 'webp'],
  ['image/gif', '', 'image', '.gif', 'gif'],
  ['audio/mpeg', '', 'audio', '.mp3', 'mp3'],
  ['audio/wav', '', 'audio', '.wav', 'wav'],
  ['text/markdown', '', 'text', '.md', 'markdown'],
  // MIME 必须压过文件名（顺序是重点）
  ['video/mp4', 'clip.webm', 'video', '.mp4', 'MIME mp4 压过名字里的 .webm'],
  ['video/webm', 'clip.mp4', 'video', '.webm', 'MIME webm 压过名字里的 .mp4'],
];
for (const [mime, name, kind, want, label] of cases) {
  const got = ext(mime, name, kind);
  ok(got === want, `${label}：extForDownload(${JSON.stringify(mime)}, ${JSON.stringify(name)}, ${kind}) 期望 ${want}，实际 ${got}`);
}

// ---------------- 2) 兜底链：mime 缺失 → 名字白名单 → kind ----------------
ok(ext('', 'final.2026', 'video') === '.mp4', '「final.2026」这类带点号名字必须回落到 kind 兜底 .mp4（不得得到 .2026）');
ok(ext('', 'notes', 'text') === '.md', '无 mime 无扩展名的文本资产应兜底 .md');
ok(ext('', '', 'video') === '.mp4', '三处全空 + kind=video 必须给 .mp4');
ok(ext('', '', 'image') === '.png', '三处全空 + kind=image 必须给 .png');
ok(ext('', '', 'audio') === '.mp3', '三处全空 + kind=audio 必须给 .mp3');
ok(ext('application/octet-stream', 'clip.mov', 'video') === '.mov', '未知 mime 时名字白名单应生效（.mov）');
ok(ext(null, null, null) === '.bin', '全空且无 kind 时应给 .bin 而不是崩溃');
ok(ext('', 'weird.2026', 'video') === '.mp4', '非白名单的点号后缀不得当作扩展名（weird.2026 → .mp4）');

// ---------------- 3) 源码级契约：四个下载点都走同一函数、无写死 ----------------
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
ok(fnBody('extForDownload').length > 0, '未找到 extForDownload 定义');
ok(/const DOWNLOAD_EXT_BY_MIME/.test(src), '缺少 MIME→扩展名映射表');
// 四个下载点都不允许再出现写死的扩展名拼接
ok(!/\? '\.png' : '\.webm'/.test(src), '节点下载仍写死扩展名（原 client.js:7844）');
ok(!/'finalcut-fc-' \+ n\.id\.slice\(-5\) \+ '\.mp4'/.test(src), 'FilmCraft 下载仍写死 .mp4（原 client.js:8783）');
ok(!/'finalcut-' \+ n\.id\.slice\(-5\) \+ '\.webm'/.test(src), '成片下载仍写死 .webm（原 client.js:8802）');
ok(!/kind === 'video' \? '\.webm'/.test(src), '资产列表下载仍按 kind 写死 .webm（原 client.js:9427）');
const use = (src.match(/downloadNameForAsset\(/g) || []).length;
ok(use >= 4, `downloadNameForAsset 使用点不足：${use} 处（1 定义 + 3 处 onClick）`);
ok(/extForDownload\(a\.mime, a\.name, a\.kind\)/.test(src), '资产列表下载未传 mime/name/kind 三参');
// extForMime 的既有语义（文件名优先，供 Craft 落盘用）不能被顺手改掉
ok(/const fromName = String\(name \|\| ''\)\.match/.test(src), 'extForMime 的文件名优先语义被改动（Craft 落盘依赖它）');
// 录制端 mp4 优先的既有行为不能被动
ok(/video\/mp4;codecs=avc1\.42E01E,mp4a\.40\.2/.test(src), '录制 mime 列表的 mp4 优先项被改动');

if (errs.length) {
  console.error('✗ IC-01 验证未通过（' + errs.length + '）：');
  errs.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('✓ IC-01 验证通过：下载扩展名按容器判定（mp4→.mp4 / webm→.webm / jpg→.jpg），四个下载点共用 extForDownload');
process.exit(0);
