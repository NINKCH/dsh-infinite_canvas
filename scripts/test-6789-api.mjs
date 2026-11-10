#!/usr/bin/env node
/**
 * 6789API 视频厂商适配回归（0.20.x）：任务制 /v1/videos，同一路径按模型分两族请求体。
 *
 * 协议要点（6789api.apifox.cn 六端点）：
 *   · 提交 POST /v1/videos（Idempotency-Key 幂等）→ 轮询 GET /v1/videos/{id} → /content 下载；
 *   · seedance* 族：{model, prompt, duration, ratio, resolution(小写), image_urls?}，透传不裁剪；
 *   · minimax* 族：{model, prompt, seconds, size, workflow_id, images?}，
 *     比例×清晰度必须映射精确像素 size（2K/4K 大写），workflow 自动选；
 *   · 查询响应兼容 data 包装（data.status / data.task_id / data.file）。
 *
 * 运行：node scripts/test-6789-api.mjs   退出码 0 = 通过；1 = 失败
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

// ---------------- 假 React / DOM（与 test-vendor-detect 同套路） ----------------
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
const V = sandbox.window.__DSH_IC_VENDOR__;
if (!V || typeof V.build6789VideoBody !== 'function') {
  console.error('✗ 未暴露 window.__DSH_IC_VENDOR__（6789 纯函数测试缝隙缺失）');
  process.exit(1);
}

// ---------------- ① seedance 族请求体：字段形状 + 透传 ----------------
{
  const b = V.build6789VideoBody(
    { model: 'seedance2.0fast', prompt: '雨后的城市街道', duration: 15, ratio: '16:9', resolution: '720P' },
    {},
  );
  ok(b.model === 'seedance2.0fast', 'seedance 族：model 小写透传');
  ok(b.duration === 15 && b.ratio === '16:9' && b.resolution === '720p', 'seedance 族：duration/ratio/resolution 透传且 resolution 小写（' + JSON.stringify({ d: b.duration, r: b.ratio, res: b.resolution }) + '）');
  ok(!('image_urls' in b) && !('images' in b), 'seedance 族：无图不得带 image_urls / images 字段');
  ok(!('seconds' in b) && !('size' in b) && !('workflow_id' in b), 'seedance 族：不得混入 minimax 字段');
  ok(!('reference' in b), 'seedance 族：不得携带三宝的 reference 字段');
}
{
  const b = V.build6789VideoBody(
    { model: 'Seedance2.5', prompt: 'p', duration: 30, ratio: '21:9', resolution: '720p' },
    { refDataUrls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'] },
  );
  ok(b.model === 'seedance2.5', 'seedance 族：大写模型名归一为小写');
  ok(Array.isArray(b.image_urls) && b.image_urls.length === 2 && b.image_urls[0] === 'https://cdn.example.com/a.png', 'seedance 族：参考图进 image_urls 字符串数组');
}

// ---------------- ② minimax 族请求体：size 映射 + workflow 自动选 ----------------
{
  const b = V.build6789VideoBody(
    { model: 'minimax-h3', prompt: '街道', duration: 8, ratio: '16:9', resolution: '720P' },
    {},
  );
  ok(b.model === 'minimax-h3', 'minimax 族：model 透传');
  ok(b.seconds === 8, 'minimax 族：duration → seconds 整数');
  ok(b.size === '1376x768', 'minimax 族：16:9×720P → 1376x768（得到 ' + b.size + '）');
  ok(b.workflow_id === 'text-to-video', 'minimax 族：无图 → text-to-video');
  ok(!('images' in b) && !('image_urls' in b), 'minimax 族：无图不得带 images 字段');
  ok(!('duration' in b) && !('ratio' in b) && !('resolution' in b), 'minimax 族：不得混入 seedance 字段');
}
{
  const CASES = [
    ['9:16', '720P', '768x1376'], ['1:1', '720P', '1024x1024'],
    ['4:3', '720P', '1184x896'], ['3:4', '720P', '896x1184'],
    ['21:9', '720P', '1568x672'], ['16:9', '1080P', '1920x1088'],
    ['9:16', '1080P', '1088x1920'], ['1:1', '1080P', '1440x1440'],
    ['21:9', '1080P', '2208x960'], ['16:9', '2K', '2K'], ['16:9', '4K', '4K'],
    ['9:16', '2k', '2K'], ['16:9', '未知档', '1376x768'],
  ];
  for (const [ratio, res, want] of CASES) {
    const got = V.api6789SizeOf(ratio, res);
    ok(got === want, 'size 映射：' + ratio + '×' + res + ' → ' + want + '（得到 ' + got + '）');
  }
}
{
  const b = V.build6789VideoBody(
    { model: 'minimax-h3', prompt: '保持人物一致', duration: 12, ratio: '9:16', resolution: '1080P' },
    { frameDataUrl: 'data:image/png;base64,AAA', refDataUrls: ['data:image/jpeg;base64,BBB'] },
  );
  ok(b.size === '1088x1920', 'minimax 族：9:16×1080P 图生视频 → 1088x1920');
  ok(b.workflow_id === 'multi-reference', 'minimax 族：有图+普通清晰度 → multi-reference');
  ok(Array.isArray(b.images) && b.images.length === 2 && b.images[0] === 'data:image/png;base64,AAA', 'minimax 族：首帧在前、参考图在后');
}
{
  const b = V.build6789VideoBody(
    { model: 'minimax-h3', prompt: 'p', duration: 8, ratio: '16:9', resolution: '2K' },
    { refDataUrls: ['data:image/png;base64,AAA'] },
  );
  ok(b.size === '2K' && b.workflow_id === 'cf-multi-reference', 'minimax 族：有图+2K → cf-multi-reference');
}

// ---------------- ③ 参考图上限 ----------------
ok(V.api6789ImageCap('seedance2.5') === 30, '上限：seedance2.5 → 30');
ok(V.api6789ImageCap('seedance2.5mini') === 30, '上限：seedance2.5mini → 30');
ok(V.api6789ImageCap('seedance2.0') === 9, '上限：seedance2.0 → 9');
ok(V.api6789ImageCap('seedance2.0fast') === 9, '上限：seedance2.0fast → 9');
ok(V.api6789ImageCap('minimax-h3') === 9, '上限：minimax-h3 → 9');
ok(V.api6789ImageCap('') === 9, '上限：空模型兜底 → 9');
ok(V.VIDEO_REF_CAPS.api6789 && V.VIDEO_REF_CAPS.api6789.img === 9, 'VIDEO_REF_CAPS.api6789 注册（通用告警口径）');

// ---------------- ④ 任务 id / 状态 / 结果地址 / 失败原因（含 data 包装兼容） ----------------
ok(V.api6789TaskIdOf({ id: 'task_a' }) === 'task_a', '任务 id：顶层 id');
ok(V.api6789TaskIdOf({ task_id: 'task_b' }) === 'task_b', '任务 id：顶层 task_id');
ok(V.api6789TaskIdOf({ code: 0, data: { task_id: 'task_c' } }) === 'task_c', '任务 id：data 包装');
ok(V.api6789TaskIdOf({}) === null, '任务 id：缺失 → null');

ok(V.api6789StatusOf({ status: 'RUNNING' }) === 'running', '状态：大小写归一');
ok(V.api6789StatusOf({ code: 0, data: { status: 'completed' } }) === 'completed', '状态：data 包装');

ok(V.api6789VideoUrlOf({ status: 'succeeded', file: '', download_url: 'https://cdn.example.com/v.mp4', error: '' }) === 'https://cdn.example.com/v.mp4', '结果地址：download_url 优先');
ok(V.api6789VideoUrlOf({ status: 'succeeded', file: '/v1/videos/task_x/content', download_url: '', error: '' }) === '/v1/videos/task_x/content', '结果地址：file 相对路径原样返回（调用方拼 origin）');
ok(V.api6789VideoUrlOf({ status: 'succeeded', file: '', download_url: '', video_url: 'https://x/v.mp4' }) === 'https://x/v.mp4', '结果地址：video_url 兼容字段');
ok(V.api6789VideoUrlOf({ status: 'succeeded', content: { video_url: 'https://x/v.mp4' } }) === 'https://x/v.mp4', '结果地址：content.video_url 兼容');
ok(V.api6789VideoUrlOf({ status: 'succeeded', output: { video_url: 'https://x/v.mp4' } }) === 'https://x/v.mp4', '结果地址：output.video_url 兼容');
ok(V.api6789VideoUrlOf({ code: 0, data: { status: 'completed', video_url: 'https://x/v.mp4' } }) === 'https://x/v.mp4', '结果地址：data 包装 video_url');
ok(V.api6789VideoUrlOf({ status: 'succeeded', file: '', download_url: '', error: '' }) === '', '结果地址：全空 → 空串（由轮询判定报「成功无地址」）');

ok(V.api6789ErrorOf({ status: 'failed', error: 'provider rejected prompt' }) === 'provider rejected prompt', '失败原因：error 字符串');
ok(V.api6789ErrorOf({ status: 'failed', error: { message: 'bad' } }) === '{"message":"bad"}', '失败原因：error 对象序列化');
ok(V.api6789ErrorOf({ status: 'failed', fail_reason: 'rate limited' }) === 'rate limited', '失败原因：fail_reason 兼容');
ok(V.api6789ErrorOf({ status: 'failed', data: { error: 'x' } }) === 'x', '失败原因：data 包装');

// ---------------- ⑤ 轮询状态机 ----------------
ok(V.api6789PollState({ status: 'queued', file: '', download_url: '' }).state === 'wait', '轮询：queued → wait');
ok(V.api6789PollState({ status: 'running', file: '', download_url: '' }).state === 'wait', '轮询：running → wait');
ok(V.api6789PollState({ status: 'unknown_future_state' }).state === 'wait', '轮询：未知状态 → wait（绝不误杀）');
{
  const done = V.api6789PollState({ status: 'succeeded', file: '/v1/videos/t/content', download_url: '', error: '' });
  ok(done.state === 'done' && done.url === '/v1/videos/t/content', '轮询：succeeded + file → done');
}
{
  const done = V.api6789PollState({ status: 'success', download_url: 'https://x/v.mp4' });
  ok(done.state === 'done' && done.url === 'https://x/v.mp4', '轮询：success（别名）→ done');
}
{
  const done = V.api6789PollState({ code: 0, data: { status: 'completed', video_url: 'https://x/v.mp4' } });
  ok(done.state === 'done' && done.url === 'https://x/v.mp4', '轮询：data 包装 completed → done');
}
ok(V.api6789PollState({ status: 'succeeded', file: '', download_url: '' }).state === 'fail', '轮询：成功但无地址 → fail（绝不无限轮询）');
for (const st of ['failed', 'error', 'cancelled', 'canceled', 'expired']) {
  ok(V.api6789PollState({ status: st, error: 'boom' }).state === 'fail', '轮询：' + st + ' → fail');
}
ok(V.api6789PollState({ status: 'failed', error: '' }).error === 'failed', '轮询：失败无原因 → 用状态名兜底');

// ---------------- ⑥ 下载重试口径（复用共享件，窗口参数断言） ----------------
ok(V.SANBAO_DOWNLOAD_RETRY_MS === 10 * 60 * 1000 && V.SANBAO_DOWNLOAD_RETRY_STEP_MS === 10 * 1000, '共享下载重试窗口常量：10 分钟 / 10s（6789 复用同常量，30s 步长在 runner 调用处覆盖）');
ok(V.retryableDownloadError({ status: 409 }) === true, '下载重试：409 video_not_ready 可重试');
ok(V.retryableDownloadError({ status: 502 }) === true, '下载重试：502 CDN 未铺开可重试');
ok(V.retryableDownloadError({ status: 401 }) === false, '下载重试：401 鉴权错误不重试');
ok(V.retryableDownloadError({ status: 400 }) === false, '下载重试：400 请求错误不重试');

// ---------------- ⑦ 素材提示触发口径 ----------------
ok(V.needs6789MediaHint('{"error":"image_urls must be https url"}') === true, '素材提示：URL 类错误触发');
ok(V.needs6789MediaHint('{"error":"图片格式不支持"}') === true, '素材提示：图片类错误触发');
ok(V.needs6789MediaHint('{"error":"Invalid API key"}') === false, '素材提示：鉴权错误不触发');
ok(V.needs6789MediaHint('{"error":"insufficient balance"}') === false, '素材提示：余额错误不触发');

// ---------------- ⑧ 路由：显式 vendor = 唯一权威 ----------------
ok(V.detectVideoVendor({ vendor: 'api6789' }) === 'api6789', '路由：显式 vendor=api6789 生效');
ok(V.detectVideoVendor({ vendor: '', url: 'https://example.com/v1/videos' }) === 'openai', '路由：URL 无特征不嗅探（6789 是格式不是站点，必须显式选）');

// ---------------- ⑨ 源码契约锚点 ----------------
const RUN6789 = (src.match(/async api6789\(prompt[\s\S]*?—— MiniMax 海螺/) || [''])[0];
ok(RUN6789.length > 400, '源码契约：api6789 runner 段可提取');
ok(/6789 提交/.test(src), '源码契约：6789 提交标签存在');
ok(/'Idempotency-Key': idem/.test(src), '源码契约：提交带 Idempotency-Key（幂等）');
ok(/windowMs: SANBAO_DOWNLOAD_RETRY_MS/.test(RUN6789), '源码契约：6789 下载走 10 分钟重试窗口');
ok(/refreshUrl: async/.test(RUN6789), '源码契约：每次重试前刷新结果地址（签名 URL 会过期）');
ok(!/adaptive/.test(RUN6789), '源码契约：6789 不得携带通用链的 adaptive ratio 逻辑');

// ---------------- 汇总 ----------------
if (errs.length) {
  console.error('✗ 6789 适配回归未通过（' + errs.length + ' 条）：');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ 6789 适配回归通过（两族请求体 / size 映射 / workflow 自动选 / 上限 / data 包装兼容 / 轮询状态机 / 下载重试口径 / 路由）');
