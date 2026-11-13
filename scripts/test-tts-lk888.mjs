#!/usr/bin/env node
/** 星海聚合（lk888）TTS 适配回归：音色列表 + 异步创建/轮询/下载，不访问外网。 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const calls = [];
const docEl = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '',
  appendChild: () => {}, removeChild: () => {}, remove: () => {}, setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true }),
  toDataURL: () => 'data:,', classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
});
const documentStub = { createElement: () => docEl(), createTextNode: (t) => ({ nodeValue: String(t) }), head: docEl(), body: docEl(), documentElement: docEl(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {}, activeElement: null };
const store = new Map();
const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let statusCalls = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/api/fetch-proxy')) {
    const payload = JSON.parse(String(opts.body || '{}'));
    const target = String(payload.url || '');
    if (target.includes('/v1/skills/voices')) {
      return Response.json({ voices: [{ voice_id: 'zh_female_vv_uranus_bigtts', name: 'VV 温柔女声', gender: '女', language: '中文' }], total: 1 });
    }
    if (target.includes('/v1/media/generate')) {
      return Response.json({ code: 200, data: { task_id: 123 }, msg: 'ok' });
    }
    if (target.includes('/v1/media/status')) {
      statusCalls++;
      return Response.json(statusCalls < 2
        ? { task_id: 123, state: 'running', is_final: false, progress: '45%' }
        : { task_id: 123, state: 'success', is_final: true, progress: '100%', result_url: 'https://cdn.mock/a.mp3', result_type: 'audio' });
    }
    if (target === 'https://cdn.mock/a.mp3') return new Response(Buffer.from('ID3audio'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  return new Response('not found', { status: 404 });
};
const sandbox = {
  window: { __DSH_IC_SMOKE__: true, addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, localStorage: ls, prompt: () => '', confirm: () => true },
  document: documentStub,
  navigator: { userAgent: 'test-tts', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: () => {} },
  localStorage: ls,
  fetch: globalThis.fetch,
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 1), cancelAnimationFrame: () => {},
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  performance: { now: () => 0 }, console,
  Blob, URL, AbortController, AbortSignal, structuredClone, crypto, TextEncoder, TextDecoder,
  Response, Headers, Request,
  Image: class { constructor() { this.src = ''; } }, Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  indexedDB: undefined,
  alert: () => {}, confirm: () => true, prompt: () => '',
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try { vm.runInContext(src, sandbox, { filename: 'client.js' }); } catch (e) { console.error('✗ client 初始化失败：' + (e && e.message)); process.exit(1); }
const fakeReact = { createElement: (type, props, ...kids) => ({ type, props, kids }), useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }), useCallback: (f) => f, useMemo: (f) => f(), Fragment: 'fragment' };
try {
  mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('require ' + name); })
    .apply({ effect(fn) { fn(); }, locale: { register: () => {}, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register() { return () => {}; } } });
} catch (e) { console.error('✗ apply 失败：' + (e && e.stack ? e.stack : e)); process.exit(1); }
const api = sandbox.window.__DSH_IC_TTS__;
if (!api) { console.error('✗ 缺少 __DSH_IC_TTS__'); process.exit(1); }

const cfg = { protocol: 'lk888', baseUrl: 'https://api.lk888.ai', apiKey: 'sk-test', model: 'doubao-tts-2.0', voice: 'zh_female_vv_uranus_bigtts', timeoutMs: '' };
try {
  const voices = await api.ttsVoiceList(cfg);
  ok(voices.length === 1 && voices[0].voice_id === 'zh_female_vv_uranus_bigtts', '音色列表解析失败');
  const blob = await api.ttsSynthesize(cfg, '大家好，欢迎收听。', { voice: 'zh_female_vv_uranus_bigtts', emotion: 'auto', format: 'mp3' });
  ok(blob && blob.type.startsWith('audio/') && blob.size > 0, 'TTS 音频 Blob 为空');
  ok(calls.some((u) => u.includes('/api/fetch-proxy')), '未走 Host 代理');
  ok(statusCalls >= 2, '未轮询到 is_final');
} catch (e) { errs.push('TTS 调用异常：' + String((e && e.stack) || e)); }

if (errs.length) {
  console.error('✗ lk888 TTS 测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ lk888 TTS 通过（音色列表 / 创建任务 / 轮询 is_final / 下载音频）');
process.exit(0);
