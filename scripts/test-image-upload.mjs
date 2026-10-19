#!/usr/bin/env node
/**
 * IC-04 第一步回归：参考图上传三件套纯函数（抽自 client.js，行为等价）。
 *
 * 背景：同一段上传逻辑 10 天内修了 5 次（297/309/310/317/322），零脚本覆盖。
 * 本脚本把历史事故固化为断言，纳入 regress.mjs 门禁——**先有网兜，再谈加固**。
 *
 * 覆盖四类历史事故 + 边界：
 *   1) EXIF 旋转：rawImageDims 读文件原始尺寸（宽高不换位），与浏览器解码口径不同
 *   2) 改后缀的 AVIF/HEIC：sniffImageEncoding 按字节拒收（返回 null）
 *   3) 宽高被拒重试：registerReferenceAsset 解码尺寸被拒 → 原始尺寸重试一次 → 成功
 *   4) 两种厂商路由断言（compshare 任务式走 registerReferenceAsset；OpenAI 兼容 generations/edits 不做登记）
 *   5) 重试仍失败：错误信息带两次原因；非宽高类错误不重试直接抛
 *
 * 运行：node scripts/test-image-upload.mjs   退出码 0 = 通过；1 = 失败
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

// ---------------- 假 React / DOM（与 test-drag-alt 同套路，够跑纯函数） ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: {
    createElement: () => ({ style: {}, dataset: {}, children: [], appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }),
    createTextNode: (t) => ({ nodeValue: String(t) }),
    head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop }, documentElement: {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null, activeElement: null, addEventListener: noop,
  },
  localStorage: lsStub,
  navigator: { userAgent: 'test-image-upload', clipboard: { writeText: async () => {} } },
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

const media = sandbox.window.__DSH_IC_IMGREF__;
ok(!!media, '冒烟缝隙未暴露 __DSH_IC_IMGREF__（IC-04 纯函数出口缺失）');
if (!media) { console.error('\n✗ 无被测对象，提前退出'); process.exit(1); }
const { rawImageDims, sniffImageEncoding, registerReferenceAsset } = media;

// ---------------- 测试素材：手工构造最小合法头 ----------------
// PNG：8 字节签名 + IHDR（宽 320 高 240）
const pngU8 = new Uint8Array(26);
pngU8.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
pngU8.set([0, 0, 0, 13], 8);           // IHDR 长度
pngU8.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
pngU8.set([0, 0, 1, 64], 16);          // width 320
pngU8.set([0, 0, 0, 240], 20);         // height 240

// JPEG：SOI + APP1(撑长度) + SOF0（高 240 宽 320 —— 注意 JPEG SOF 段内是「高在前」）
const jpgU8 = new Uint8Array(20);
jpgU8.set([0xff, 0xd8, 0xff], 0);      // SOI + 下一段 marker 前缀
jpgU8[3] = 0xe0; jpgU8.set([0, 4, 1, 2], 4); // APP0 len=4（跳过）
jpgU8.set([0xff, 0xc0], 8);            // SOF0
jpgU8.set([0, 11], 10);                // 段长 11
jpgU8[12] = 8;                         // 精度
jpgU8.set([0, 240], 13);               // height 240（高在前）
jpgU8.set([0x01, 0x40], 15);           // width 320（0x0140）

// WebP：RIFF + WEBP + VP8X
const webpU8 = new Uint8Array(30);
webpU8.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
webpU8.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP

// AVIF（改后缀成 .jpg 的真实字节）
const avifU8 = new Uint8Array(16);
avifU8.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 0); // ftypavif

// ---------------- 1) rawImageDims：EXIF 旋转的历史事故（平台读原始文件，宽高不换位） ----------------
const pngDims = rawImageDims(pngU8);
ok(pngDims && pngDims.w === 320 && pngDims.h === 240, 'PNG 原始尺寸解析错误：' + JSON.stringify(pngDims));
const jpgDims = rawImageDims(jpgU8);
ok(jpgDims && jpgDims.w === 320 && jpgDims.h === 240, 'JPEG SOF 原始尺寸解析错误（应为高在前）：' + JSON.stringify(jpgDims));
ok(rawImageDims(avifU8) === null, 'AVIF 字节不应解析出尺寸');
ok(rawImageDims(new Uint8Array(4)) === null, '过短输入不应崩溃，返回 null');
console.log('  ✓ rawImageDims：PNG/JPEG 原始尺寸 + 非法输入兜底');

// ---------------- 2) sniffImageEncoding：改后缀 AVIF/HEIC 拒收 ----------------
ok(sniffImageEncoding(pngU8).kind === 'png' && sniffImageEncoding(pngU8).mime === 'image/png', 'PNG 嗅探错误');
ok(sniffImageEncoding(jpgU8).kind === 'jpeg' && sniffImageEncoding(jpgU8).ext === 'jpg', 'JPEG 嗅探错误');
ok(sniffImageEncoding(webpU8).kind === 'webp' && sniffImageEncoding(webpU8).mime === 'image/webp', 'WebP 嗅探错误');
ok(sniffImageEncoding(avifU8) === null, '改后缀的 AVIF 必须被拒（返回 null）——0.18.3 的 400 根因');
ok(sniffImageEncoding(new Uint8Array(8).fill(0x61)) === null, '随机字节必须被拒');
ok(sniffImageEncoding(null) === null, 'null 输入不崩溃');
console.log('  ✓ sniffImageEncoding：三类放行 / AVIF·随机·null 拒收');

// ---------------- 3) registerReferenceAsset：宽高被拒 → 原始尺寸重试 ----------------
const meta = { width: 240, height: 320, rawWidth: 320, rawHeight: 240 }; // EXIF 竖图：解码 240×320，原始 320×240
{
  let calls = [];
  const api = async (method, p, body) => {
    calls.push({ m: method, p, w: body.width, h: body.height });
    if (body.width === 240) throw new Error('优云图片 API POST /image/v1/assets HTTP 400：Params [Width/Height] not available');
    return { reference: { asset_id: 'A1' } };
  };
  const reg = await registerReferenceAsset(api, (w, h) => ({ width: w, height: h }), meta);
  ok(reg && reg.reference.asset_id === 'A1', '重试后未拿到 asset_id');
  ok(calls.length === 2, '应恰好调用两次（解码尺寸 → 原始尺寸），实际 ' + calls.length);
  ok(calls[0].w === 240 && calls[1].w === 320, '第二次必须用原始尺寸 320×240，实际 ' + JSON.stringify(calls[1]));
}
console.log('  ✓ registerReferenceAsset：EXIF 宽高被拒 → 原始尺寸重试成功');

{
  // 非宽高类错误：不重试，直接抛
  let calls = 0;
  const api = async () => { calls++; throw new Error('HTTP 401 invalid api key'); };
  let threw = '';
  try { await registerReferenceAsset(api, (w, h) => ({ width: w, height: h }), meta); } catch (e) { threw = String(e.message || e); }
  ok(calls === 1, '非宽高类错误不应重试，实际调用 ' + calls + ' 次');
  ok(/401/.test(threw), '非宽高类错误应原样抛出，实际：' + threw);
}
{
  // 尺寸一致时不重试（普通图，一次成功）
  let calls = 0;
  const api = async (m, p, body) => { calls++; return { reference: { asset_id: 'A2', echo: body } }; };
  const reg = await registerReferenceAsset(api, (w, h) => ({ width: w, height: h }), { width: 100, height: 100, rawWidth: 100, rawHeight: 100 });
  ok(calls === 1 && reg.reference.asset_id === 'A2', '尺寸一致的普通图应一次登记成功');
}
{
  // 两次都失败：错误信息带两次原因（0.18.4 的报错回显契约）
  const api = async (m, p, body) => { throw new Error('Params [Width/Height] not available (w=' + body.width + ')'); };
  let threw = '';
  try { await registerReferenceAsset(api, (w, h) => ({ width: w, height: h }), meta); } catch (e) { threw = String(e.message || e); }
  ok(/重试仍失败/.test(threw) && /w=320/.test(threw) && /w=240/.test(threw), '两次失败的错误必须带两次原因，实际：' + threw);
}
{
  // 解码尺寸与原始尺寸一致时被拒 → 不具备重试条件（alt=false）→ 原样抛
  let calls = 0;
  const api = async () => { calls++; throw new Error('Params [Width/Height] not available'); };
  let threw = '';
  try { await registerReferenceAsset(api, (w, h) => ({ width: w, height: h }), { width: 100, height: 100, rawWidth: 100, rawHeight: 100 }); } catch (e) { threw = String(e.message || e); }
  ok(calls === 1, '无备选尺寸时不应重试，实际调用 ' + calls + ' 次');
  ok(/not available/.test(threw) && !/重试仍失败/.test(threw), '无备选尺寸时应原样抛出');
}
console.log('  ✓ registerReferenceAsset：非宽高错误直抛 / 一次成功 / 双失败回显 / 无备选不重试');

// ---------------- 4) 厂商路由事实断言（源码级，防回归） ----------------
// compshare 任务式：登记走 registerReferenceAsset（抽出的函数被调用点引用）
ok(/const reg = await registerReferenceAsset\(api, regPayload, meta\);/.test(src), 'compshare 登记未走 registerReferenceAsset（抽取回退？）');
// OpenAI 兼容路径不做登记（generations/edits 直接带参考图，没有 upload_urls/assets 三步）：
const apiImageStart = src.indexOf('async function apiImage(');
const apiImageEnd = src.indexOf('async function ', apiImageStart + 10);
const apiImageBody = src.slice(apiImageStart, apiImageEnd > apiImageStart ? apiImageEnd : apiImageStart + 9000);
ok(!/registerReferenceAsset/.test(apiImageBody), 'apiImage（OpenAI 兼容路径）不应出现登记逻辑');
ok(/\/image\/v1\/upload_urls/.test(src) && /\/image\/v1\/assets/.test(src), 'compshare 三步上传端点缺失');
console.log('  ✓ 厂商路由：compshare 走登记重试 / OpenAI 兼容路径无登记');

// ---------------- 汇总 ----------------
if (errs.length) {
  console.error('\n✗ 参考图上传回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1); // 显式退出：client.js 里的 3s 轮询 interval 会把事件循环挂住
}
console.log('\n✓ 参考图上传三件套回归全部通过（IC-04 第一步）');
process.exit(0);
