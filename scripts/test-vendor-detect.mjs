#!/usr/bin/env node
/**
 * IC-03 回归：视频厂商路由——**厂商格式（设置下拉）是唯一权威**。
 *
 * 2026-10-30 修订：移除"模型名猜测路由"。此前 wan3.0-video（moyu 中转站）因模型名
 * 命中 wan 正则被改道 DashScope 官方格式，中转站解析不到图字段 → 502 三连。
 * 新口径：
 *   ① 显式 vendor（设置下拉）= 唯一权威，模型名绝不参与；
 *   ② URL 特征兜底（用户填的 URL 也是显式配置的一部分，且设置卡会回填 vendor）；
 *   ③ 兜底 openai。
 * 保留：gatewayPrefixFor / wanEndpoints / apiVideo 未知厂商降级提示（原有断言不松）。
 *
 * 运行：node scripts/test-vendor-detect.mjs   退出码 0 = 通过；1 = 失败
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

// ---------------- 假 React / DOM（与 test-drag-alt 同套路） ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), localStorage: lsStub, location: { href: 'http://localhost/' }, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true },
  document: {
    createElement: () => ({ style: {}, dataset: {}, children: [], appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }),
    addEventListener: noop, removeEventListener: noop, body: { appendChild: noop }, head: { appendChild: noop }, documentElement: { style: {} },
  },
  localStorage: lsStub, navigator: { language: 'zh-CN', userAgent: 'node' }, location: { href: 'http://localhost/' },
  setTimeout, clearTimeout, setInterval: (f) => setTimeout(f, 0), clearInterval: noop, queueMicrotask,
  fetch: () => Promise.reject(new Error('no-net')), console,
  performance: { now: () => Date.now() }, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop,
  TextEncoder, TextDecoder, URL, URLSearchParams, Promise, JSON, Math, Date, Number, String, Array, Object, Map, Set, Error, RegExp, parseInt, parseFloat, isNaN, isFinite, Buffer, Blob: class {},
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
const SEG = sandbox.window.__DSH_IC_VENDOR__;
if (!SEG || typeof SEG.detectVideoVendor !== 'function') {
  console.error('✗ 未暴露 window.__DSH_IC_VENDOR__（vendor 识别的测试缝隙缺失）');
  process.exit(1);
}
const detect = SEG.detectVideoVendor;

// ---------------- ① 显式 vendor = 唯一权威（模型名绝不改道） ----------------
ok(detect({ vendor: 'openai', model: 'wan3.0-video', url: '' }) === 'openai', '显式 openai：wan3.0-video 模型名不得改道 wan（moyu 事故回归）');
ok(detect({ vendor: 'wan', model: 'gpt-4o', url: '' }) === 'wan', '显式 wan：任何模型名都走 wan');
ok(detect({ vendor: 'kling', model: 'wan3.0-video' }) === 'kling', '显式 kling：wan3.0-video 不得改道');
ok(detect({ vendor: 'seedance', model: 'wan3.0-video' }) === 'seedance', '显式 seedance：wan3.0-video 不得改道');
ok(detect({ vendor: 'openai', model: 'kling-v2' }) === 'openai', '显式 openai：kling 模型名不得改道 kling');

// ---------------- ② URL 特征兜底（旧配置 vendor 为空的过渡） ----------------
ok(detect({ vendor: '', model: '', url: 'https://dashscope.aliyuncs.com' }) === 'wan', 'URL 兜底：dashscope → wan');
ok(detect({ vendor: '', model: '', url: 'https://api.klingai.com' }) === 'kling', 'URL 兜底：klingai → kling');
ok(detect({ vendor: '', model: '', url: 'https://www.moyu.info/v1/video/generations' }) === 'openai', 'URL 兜底：无特征的中转站 → openai（moyu 默认）');
ok(detect({ vendor: '', model: '', url: '' }) === 'openai', 'URL 兜底：全空 → openai');

// ---------------- ③ protocol=seedance 保留 ----------------
ok(detect({ vendor: '', model: '', protocol: 'seedance' }) === 'seedance', 'protocol=seedance → seedance');
ok(detect({ vendor: '', model: '', url: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks' }) === 'seedance', 'URL 兜底：contents/generations/tasks → seedance');

// ---------------- ④ 空对象/缺参 ----------------
ok(detect(null) === 'openai', 'null → openai');
ok(detect({}) === 'openai', '空对象 → openai');

// ---------------- ⑤ 源码契约：模型名正则已移除 ----------------
ok(!/wanx\|万相/.test(src), 'detectVideoVendor 不应再有 wan 模型名正则（模型名路由已移除）');
ok(/if \(s\.vendor\) return s\.vendor;/.test(src), '显式 vendor 优先必须保留');

// ---------------- ⑥ 通用图片字段兜底（不新增厂商） ----------------
{
  const needs = SEG.needsSimpleMediaRetry;
  const build = SEG.buildSimpleMediaRetryBody;
  ok(typeof needs === 'function' && typeof build === 'function', '缺少通用图片字段兜底测试缝隙');
  if (typeof needs === 'function' && typeof build === 'function') {
    ok(needs('{"error":"图片接口代理请求失败：需要 http(s) 接口 url"}'), '应识别“图片代理需要 http(s) URL”错误');
    ok(!needs('{"error":"Invalid API key"}'), '鉴权错误不得触发图片字段兜底');
    ok(!needs('{"error":"rate limit exceeded"}'), '限流错误不得触发图片字段兜底');
    const base = { model: 'wan3.0-video', prompt: 'p', duration: 5, resolution: '720P', ratio: '16:9' };
    const first = build(base, { frameDataUrl: 'data:image/png;base64,AAA' });
    ok(first.input_reference === 'data:image/png;base64,AAA', '纯首帧兜底应使用 input_reference=dataURL');
    ok(!first.image && !first.images, '纯首帧兜底不得再发 image / images');
    ok(first.resolution === '720P', '兜底请求应保留大写分辨率');
    const refs = build(base, { refDataUrls: ['data:image/png;base64,AAA', 'data:image/jpeg;base64,BBB'] });
    ok(Array.isArray(refs.images) && refs.images.every((x) => typeof x === 'string'), '参考图兜底 images 必须是字符串 dataURL 数组');
    ok(!refs.images.some((x) => x && typeof x === 'object' && 'role' in x), '参考图兜底不得再发 {url,role} 对象');
    const mixed = build(base, { frameDataUrl: 'data:image/png;base64,FFF', refDataUrls: ['data:image/png;base64,AAA'] });
    ok(Array.isArray(mixed.images) && mixed.images.length === 2 && mixed.images[0] === 'data:image/png;base64,FFF', '首帧+参考图应统一降级为 images 字符串数组，首帧排第一');
    const audio = build(base, { refDataUrls: ['data:image/png;base64,AAA'], audioDataUrls: ['data:audio/wav;base64,CCC'] });
    ok(Array.isArray(audio.media) && audio.media[0].type === 'reference_image' && audio.media[1].type === 'reference_audio', '带参考音频时应使用 media[] 且保留参考音频');
  }
  ok(/needsSimpleMediaRetry\(res\.text\)/.test(src), 'apiVideo 未接入通用图片字段兜底');
  ok(/buildSimpleMediaRetryBody\(/.test(src), 'apiVideo 未使用简化参考字段请求体');
}

if (errs.length) {
  console.error('✗ 厂商识别回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 厂商识别回归通过：显式 vendor 唯一权威 / 模型名路由已移除 / URL 兜底保留 / moyu 默认 openai');
