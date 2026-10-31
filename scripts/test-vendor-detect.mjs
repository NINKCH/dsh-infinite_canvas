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

// ---------------- ⑦ wan（DashScope 兼容中转）响应形态归一 ----------------
// tiantoken 等 DashScope 系中转会改写响应结构：task_id / 状态 / 成品地址的位置和大小写都可能变。
// 归一口径：位置按序兼容 + 状态统一小写；集合外状态（含 unknown）一律继续轮询，绝不误杀。
{
  const tidOf = SEG.wanTaskIdOf, stOf = SEG.wanStatusOf, pollOf = SEG.wanPollState;
  ok(typeof pollOf === 'function', '缺少 wan 响应归一测试缝隙（wanTaskIdOf/wanStatusOf/wanPollState）');
  if (typeof tidOf === 'function' && typeof stOf === 'function' && typeof pollOf === 'function') {
    // task_id 多形态
    ok(tidOf({ output: { task_id: 'a' } }) === 'a', 'task_id：output.task_id 官方形态优先');
    ok(tidOf({ task_id: 'b' }) === 'b', 'task_id：中转顶层 task_id');
    ok(tidOf({ data: { task_id: 'c' } }) === 'c', 'task_id：data.task_id');
    ok(tidOf({ id: 'd' }) === 'd', 'task_id：裸 id');
    ok(tidOf({}) === null && tidOf(null) === null, 'task_id：缺失返回 null');
    // 状态多形态 + 小写化
    ok(stOf({ output: { task_status: 'SUCCEEDED' } }) === 'succeeded', '状态：官方大写 → 小写比较');
    ok(stOf({ status: 'Running' }) === 'running', '状态：顶层 status（中转改写形态）');
    ok(stOf({ task_status: 'Unknown' }) === 'unknown', '状态：顶层 task_status');
    ok(stOf({ output: { status: 'Done' } }) === 'done', '状态：output.status');
    ok(stOf({}) === '' && stOf(null) === '', '状态：缺失返回空串');
    // 轮询判定
    ok(pollOf({ output: { task_status: 'SUCCEEDED', video_url: 'https://x/v.mp4' } }).state === 'done'
      && pollOf({ output: { task_status: 'SUCCEEDED', video_url: 'https://x/v.mp4' } }).url === 'https://x/v.mp4', '轮询：官方成功形态取 output.video_url');
    ok(pollOf({ status: 'success', video_url: 'https://x/v.mp4' }).state === 'done', '轮询：小写 success + 顶层 url');
    ok(pollOf({ output: { task_status: 'SUCCEEDED' } }).state === 'fail', '轮询：成功但无地址 → 快失败，不空转 2 小时');
    ok(pollOf({ data: { result_url: 'https://x/v.mp4' }, output: { task_status: 'Success' } }).url === 'https://x/v.mp4', '轮询：data.result_url 兜底成品地址');
    ok(pollOf({ status: 'unknown' }).state === 'wait', '轮询：unknown ≠ 失败（中转刚提交常回 unknown，误杀回归）');
    ok(pollOf({ output: { task_status: 'PENDING' } }).state === 'wait', '轮询：PENDING 继续等');
    ok(pollOf({ status: 'Running' }).state === 'wait', '轮询：running 继续等');
    ok(pollOf({}).state === 'wait' && pollOf(null).state === 'wait', '轮询：无状态字段 → wait');
    const f1 = pollOf({ output: { task_status: 'FAILED', code: 'InvalidParameter', message: 'bad media' } });
    ok(f1.state === 'fail' && /InvalidParameter/.test(f1.error) && /bad media/.test(f1.error), '轮询：失败带 output.code + output.message');
    ok(pollOf({ status: 'Expired' }).state === 'fail', '轮询：expired 终态');
    ok(pollOf({ status: 'Cancelled' }).state === 'fail', '轮询：cancelled（双 l）终态');
    const f2 = pollOf({ status: 'Timeout', message: 'upstream timeout' });
    ok(f2.state === 'fail' && /upstream timeout/.test(f2.error), '轮询：顶层 message 兜底错误信息');
  }
  ok(/const tid = wanTaskIdOf\(j1\)/.test(src), 'wan runner 未接入 task_id 多形态提取');
  ok(/return wanPollState\(j\)/.test(src), 'wan runner 轮询未接入状态归一');
}

// ---------------- ⑧ 三宝影像工坊（Sanbao）任务制多参考 ----------------
// 协议：POST /openapi/v1/videos（任务制）+ GET 轮询 data.status；本地素材 dataURL 直传
// （全模型 media_inputs 含 data_url，实测格式校验通过）；报图片/素材格式类错误 →
// 用专用 uploadKey（扩展参数）走 /openapi/v1/uploads/raw 转公网 URL 后重试一次。
{
  const build = SEG.buildSanbaoVideoBody;
  const tidOf = SEG.sanbaoTaskIdOf;
  const pollOf = SEG.sanbaoPollState;
  const retry = SEG.needsSanbaoMediaRetry;
  ok(typeof build === 'function' && typeof pollOf === 'function' && typeof retry === 'function', '缺少三宝测试缝隙（buildSanbaoVideoBody/sanbaoTaskIdOf/sanbaoPollState/needsSanbaoMediaRetry）');
  if (typeof build === 'function') {
    const base = { model: 'wan30_720p_real', prompt: 'p', ratio: '9:16', resolution: '720P', duration: 5 };
    const b1 = build(base, { frameDataUrl: 'data:image/png;base64,AAA', refDataUrls: ['data:image/jpeg;base64,BBB', 'data:image/jpeg;base64,CCC'] });
    ok(b1.model === 'wan30_720p_real', '三宝：model 透传');
    ok(Array.isArray(b1.images) && b1.images.length === 3 && b1.images[0] === 'data:image/png;base64,AAA', '三宝：首帧降级为首张参考图，images 字符串数组');
    ok(b1.reference === 'all', '三宝：多参考模式 reference=all');
    ok(b1.resolution === '720p', '三宝：resolution 小写化（模型表枚举 480p/720p/1080p/2k）');
    ok(b1.ratio === '9:16' && b1.duration === 5, '三宝：ratio/duration 透传');
    const b2 = build(base, { refDataUrls: ['data:image/jpeg;base64,BBB'] });
    ok(!('input_reference' in b2) && Array.isArray(b2.images) && b2.images.length === 1, '三宝：无首帧只发参考图');
    const b3 = build(base, { frameDataUrl: 'data:image/png;base64,AAA', audioDataUrls: ['data:audio/mpeg;base64,CCC'] });
    ok(Array.isArray(b3.audios) && b3.audios[0].tag === '音频1' && /^data:audio/.test(b3.audios[0].url), '三宝：参考音频走 audios[{tag,url}]');
    const b4 = build(base, { refDataUrls: ['https://sanbaobeauty.com/a.jpg'] });
    ok(b4.images[0] === 'https://sanbaobeauty.com/a.jpg', '三宝：公网 URL 与 dataURL 同通道（上传兜底重试共用构造器）');
    ok(!('parameters' in b1) && !('watermark' in b1), '三宝：不发明其他协议的字段');
  }
  if (typeof tidOf === 'function') {
    ok(tidOf({ data: { id: 'task_x' } }) === 'task_x', '三宝：任务 id 在 data.id');
    ok(tidOf({ id: 't2' }) === 't2', '三宝：顶层 id 兼容');
    ok(tidOf({}) === null && tidOf(null) === null, '三宝：无 id 返回 null');
  }
  if (typeof pollOf === 'function') {
    ok(pollOf({ data: { status: 'succeeded', video_url: 'https://x/v.mp4' } }).state === 'done'
      && pollOf({ data: { status: 'succeeded', video_url: 'https://x/v.mp4' } }).url === 'https://x/v.mp4', '三宝：succeeded → data.video_url');
    ok(pollOf({ data: { status: 'succeeded', download_url: 'https://x/d.mp4' } }).url === 'https://x/d.mp4', '三宝：download_url 兜底（签名直链）');
    ok(pollOf({ data: { status: 'succeeded' } }).state === 'fail', '三宝：成功但无地址 → 快失败');
    const f1 = pollOf({ data: { status: 'failed', error: '敏感内容' } });
    ok(f1.state === 'fail' && /敏感内容/.test(f1.error), '三宝：failed → data.error');
    ok(pollOf({ data: { status: 'queued' } }).state === 'wait' && pollOf({ data: { status: 'processing', progress: 40 } }).state === 'wait', '三宝：queued/processing 继续等');
    ok(pollOf({}).state === 'wait' && pollOf(null).state === 'wait', '三宝：无状态 → wait');
  }
  if (typeof retry === 'function') {
    ok(retry('图片格式不支持，请提供 http(s) url'), '三宝兜底：图片格式类错误触发');
    ok(retry('素材拉取失败'), '三宝兜底：素材类错误触发');
    ok(!retry('余额不足'), '三宝兜底：余额错误绝不重试');
    ok(!retry('{"code":"INSUFFICIENT_CREDITS"}'), '三宝兜底：积分错误绝不重试');
    ok(!retry('Invalid API key'), '三宝兜底：鉴权错误绝不重试');
    ok(!retry('请求过于频繁'), '三宝兜底：限流绝不重试');
    ok(!retry(''), '三宝兜底：空错误不触发');
  }
  ok(detect({ vendor: '', model: '', url: 'https://sanbaobeauty.com/openapi/v1/videos' }) === 'sanbao', 'URL 兜底：sanbaobeauty → sanbao');
  ok(/openapi\/v1\/videos/.test(src), '三宝：任务创建/查询端点未接入');
  ok(/sanbaoUploadRaw/.test(src) && /uploads\/raw/.test(src), '三宝：素材上传口未接入');
  ok(/uploadKey/.test(src), '三宝：专用上传 key（扩展参数 uploadKey）未接入');
}

if (errs.length) {
  console.error('✗ 厂商识别回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 厂商识别回归通过：显式 vendor 唯一权威 / 模型名路由已移除 / URL 兜底保留 / moyu 默认 openai');
