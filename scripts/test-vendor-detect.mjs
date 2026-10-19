#!/usr/bin/env node
/**
 * IC-03 回归：视频厂商识别 / 网关前缀归一化 / 未知厂商降级提示。
 *
 * 背景（IC-03 卡）：vendor 探测与前缀归一化这块历史上改一次崩一次
 * （0.17.15 前后十余个 fix 提交），从未有单测；未知厂商此前直接
 * `throw 暂未适配的视频厂商格式`，现在降级走 OpenAI 兼容通用链并给节点提示。
 *
 * 断言（≥3 已知前缀 + 1 未知前缀 + 端点归一化 + 降级提示源码契约）：
 *   1) detectVideoVendor：模型名优先（wan/h3/kling/... 12 家）、URL 兜底、显式 vendor 必胜
 *   2) gatewayPrefixFor：relayrouter → /alibailian；未知网关 → ''
 *   3) wanEndpoints：官方域 / 网关裸域 / 网关带前缀 / 完整端点 四种写法 + 拖尾 /v1 清理
 *   4) apiVideo：未知厂商不再 throw（源码级），且 warn 提示含降级说明
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
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: {
    createElement: () => ({ style: {}, dataset: {}, children: [], appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }),
    createTextNode: (t) => ({ nodeValue: String(t) }),
    head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop }, documentElement: {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null, activeElement: null, addEventListener: noop,
  },
  localStorage: lsStub,
  navigator: { userAgent: 'test-vendor', clipboard: { writeText: async () => {} } },
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

const V = sandbox.window.__DSH_IC_VENDOR__;
ok(!!V && typeof V.detectVideoVendor === 'function', '冒烟缝隙未暴露 __DSH_IC_VENDOR__（IC-03 出口缺失）');
if (V) {
  const { detectVideoVendor, gatewayPrefixFor, wanEndpoints, vendorBase, VIDEO_REF_CAPS } = V;

  // ---------------- 1) detectVideoVendor：模型名优先 ----------------
  // 已知前缀（模型名能识别的，远超 3 家——这里全表过一遍，防「改一次崩一次」）
  const modelCases = [
    ['wan2.2-t2v-plus', 'wan'], ['wanx2.1-t2v-turbo', 'wan'], ['万相-xxx', 'wan'],
    ['minimax-h3-01', 'minimaxv2'], ['hailuo-03-preview', 'minimaxv2'],
    ['kling-v2-6', 'kling'], ['klingai-omni', 'kling'],
    ['minimax-video', 'minimax'], ['hailuo-standard', 'minimax'],
    ['vidu-q2', 'vidu'], ['runway-gen4', 'runway'], ['veo-3.0-fast', 'veo'],
    ['luma-ray-2', 'luma'], ['ray-2-flash', 'luma'], ['pixverse-v4', 'pixverse'],
    ['stable-video-diffusion', 'stability'], ['svd-xt', 'stability'],
    ['doubao-seedance-2-0-260128', 'seedance'],
  ];
  for (const [model, want] of modelCases) {
    const got = detectVideoVendor({ model, url: 'https://gw.example.com' });
    ok(got === want, `模型名「${model}」应识别为 ${want}，实际 ${got}`);
  }
  // URL 兜底
  const urlCases = [
    ['https://dashscope.aliyuncs.com/api/v1', 'wan'],
    ['https://api.klingai.com/v1', 'kling'],
    ['https://api.minimaxi.com/v1', 'minimax'],
    ['https://api.vidu.com/v1', 'vidu'],
    ['https://api.dev.runwayml.com/v1', 'runway'],
    ['https://generativelanguage.googleapis.com/v1', 'veo'],
    ['https://api.lumalabs.ai/v1', 'luma'],
    ['https://app-api.pixverse.ai/v1', 'pixverse'],
    ['https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', 'seedance'],
  ];
  for (const [url, want] of urlCases) {
    const got = detectVideoVendor({ model: '', url });
    ok(got === want, `URL「${url}」应识别为 ${want}，实际 ${got}`);
  }
  // 显式 vendor 必胜（模型名/URL 都骗不动）
  ok(detectVideoVendor({ vendor: 'kling', model: 'wan2.2', url: 'https://dashscope.aliyuncs.com' }) === 'kling', '显式 vendor 应优先于模型名/URL');
  // 未知前缀 → openai（不再 throw 的前提：识别层只归 openai，降级由 apiVideo 处理）
  ok(detectVideoVendor({ model: 'gw-x-unheard-vendor-9', url: 'https://gw.example.com' }) === 'openai', '未知前缀应归 openai（通用链）');
  ok(detectVideoVendor(null) === 'openai', '空配置应归 openai');
  ok(detectVideoVendor({ model: 'minimax-h3-01', url: 'https://dashscope.aliyuncs.com' }) === 'minimaxv2', 'H3 判定必须先于 V1 minimax（顺序回归）');
  console.log('  ✓ detectVideoVendor：' + modelCases.length + ' 组模型名 + ' + urlCases.length + ' 组 URL + 显式优先 + H3 先于 V1');

  // ---------------- 2) gatewayPrefixFor ----------------
  ok(gatewayPrefixFor('api.relayrouter.ai', 'wan') === '/alibailian', 'relayrouter 的 wan 前缀应为 /alibailian');
  ok(gatewayPrefixFor('gw.relayrouter.ai', 'wan') === '/alibailian', '子域也应命中');
  ok(gatewayPrefixFor('gw.example.com', 'wan') === '', '未知网关应返回空（不猜）');
  ok(gatewayPrefixFor('api.relayrouter.ai', 'kling') === '', '已知网关的未知厂商前缀应为空');
  console.log('  ✓ gatewayPrefixFor：已知网关/子域/未知网关/未知厂商');

  // ---------------- 3) wanEndpoints：四种写法归一化 ----------------
  const we = (u) => wanEndpoints(u);
  let e = we('https://dashscope.aliyuncs.com');
  ok(e.submitUrl === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis', '官方裸域应拼官方端点：' + e.submitUrl);
  e = we('https://api.relayrouter.ai');
  ok(e.submitUrl.startsWith('https://api.relayrouter.ai/alibailian/api/v1/'), '网关裸域应自动补厂商前缀：' + e.submitUrl);
  e = we('https://api.relayrouter.ai/alibailian');
  ok(e.submitUrl.startsWith('https://api.relayrouter.ai/alibailian/api/v1/'), '网关带前缀应原样保留：' + e.submitUrl);
  e = we('https://api.relayrouter.ai/alibailian/api/v1/services/aigc/video-generation/video-synthesis');
  ok(e.submitUrl.startsWith('https://api.relayrouter.ai/alibailian/api/v1/'), '完整端点应反推出前缀：' + e.submitUrl);
  e = we('https://dashscope.aliyuncs.com/v1/');
  ok(e.submitUrl === 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis', '拖尾 /v1 应剥掉：' + e.submitUrl);
  ok(we('https://dashscope.aliyuncs.com').taskUrl('T1') === 'https://dashscope.aliyuncs.com/api/v1/tasks/T1', 'taskUrl 拼接错误');
  console.log('  ✓ wanEndpoints：官方域/网关裸域/带前缀/完整端点/拖尾 /v1/taskUrl');

  // ---------------- vendorBase ----------------
  ok(vendorBase('https://api.klingai.com/v1/', 'https://x') === 'https://api.klingai.com', '拖尾 /v1 应剥掉');
  ok(vendorBase('', 'https://api.klingai.com') === 'https://api.klingai.com', '空 base 应回退厂商预设');
  ok(vendorBase('https://api.klingai.com/api/v1', '') === 'https://api.klingai.com', '/api/v1 也应剥掉');

  // ---------------- VIDEO_REF_CAPS 全覆盖厂商 ----------------
  const capsVendors = ['wan', 'minimaxv2', 'openai', 'seedance', 'kling', 'vidu', 'runway', 'veo', 'luma', 'pixverse', 'minimax', 'stability'];
  for (const v of capsVendors) ok(VIDEO_REF_CAPS[v] && VIDEO_REF_CAPS[v].img > 0, 'VIDEO_REF_CAPS 缺厂商 ' + v);
  console.log('  ✓ vendorBase + VIDEO_REF_CAPS（' + capsVendors.length + ' 家全覆盖）');
}

// ---------------- 4) apiVideo 降级：源码级契约 ----------------
const apiVideoBody = (() => {
  const start = src.indexOf('async function apiVideo(');
  const next = src.indexOf('\n    function b64Pure', start);
  return src.slice(start, next > start ? next : start + 9000);
})();
ok(!/throw new Error\('暂未适配的视频厂商格式/.test(apiVideoBody), 'apiVideo 仍保留「暂未适配」硬失败（IC-03 未生效）');
ok(/未识别到「/.test(apiVideoBody) && /按 OpenAI 兼容格式发送/.test(apiVideoBody), '未知厂商降级缺少可见提示');
ok(/vendorDowngraded/.test(apiVideoBody), '降级路径缺标记变量（静默换协议回归）');
console.log('  ✓ apiVideo：未知厂商降级 + 提示 + 标记（源码级）');

// ---------------- 汇总 ----------------
if (errs.length) {
  console.error('\n✗ 厂商识别回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ 视频厂商识别 / 前缀归一化回归全部通过（IC-03）');
process.exit(0); // client.js 的 3s 轮询 interval 会挂住事件循环，显式退出
