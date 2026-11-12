#!/usr/bin/env node
/**
 * 参考视频拉片回归（dev-only）：
 * 在假浏览器环境里真实执行 client.js，取出 __DSH_IC_PULL__ 的纯函数级出口，
 * 验证「提示词包含帧时间/契约」「视觉模型 JSON → 分镜结构」「时间轴覆盖/裁剪」
 * 「抽帧按时间均匀分布且产出 JPEG dataURL」。
 *
 * 运行：node scripts/test-pull-shots.mjs   退出码 0 = 通过
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const noop = () => {};
const errs = [];

// ---------------- 假 video / canvas ----------------
function mkVideo(meta) {
  const v = {
    _src: '', _t: 0, duration: meta.duration, videoWidth: meta.w, videoHeight: meta.h,
    muted: false, preload: '', readyState: 4,
    get src() { return this._src; },
    set src(v2) { this._src = v2; setTimeout(() => { if (this.onloadedmetadata) this.onloadedmetadata(); }, 0); },
    get currentTime() { return this._t; },
    set currentTime(t) { this._t = Number(t) || 0; setTimeout(() => { if (this.onseeked) this.onseeked(); }, 0); },
  };
  return v;
}
const videos = [];
let META = { duration: 6, w: 1280, h: 720 };
const ctx2d = { drawImage: noop, fillRect: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }), fillText: noop, measureText: () => ({ width: 10 }), save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, closePath: noop, set fillStyle(v) {}, set strokeStyle(v) {}, set font(v) {}, set textAlign(v) {}, set lineWidth(v) {} };
function mkCanvas() {
  return {
    width: 0, height: 0, getContext: () => ctx2d,
    toDataURL: () => 'data:image/jpeg;base64,AAAA',
    toBlob: (cb) => cb(new Blob(['x'])),
    captureStream: () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] }),
  };
}
const documentStub = {
  createElement: (tag) => {
    if (tag === 'video') { const v = mkVideo(META); videos.push(v); return v; }
    if (tag === 'canvas') return mkCanvas();
    return { style: {}, dataset: {}, children: [], appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop, toggle: noop }, textContent: '', id: '' };
  },
  head: { appendChild: noop, removeChild: noop, querySelector: () => null },
  body: { appendChild: noop, removeChild: noop },
  documentElement: { appendChild: noop, removeChild: noop },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
};

const sandbox = {
  window: { __DSH_IC_SMOKE__: true, addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, localStorage: { getItem: () => null, setItem: noop, removeItem: noop } },
  document: documentStub,
  navigator: { userAgent: 'test-pull', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 1),
  cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  performance: { now: () => 0 },
  console,
  Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
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
try { vm.runInContext(src, sandbox, { filename: 'client.js' }); } catch (e) {
  console.error('✗ client.js 顶层执行失败：' + (e && e.message)); process.exit(1);
}
const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useState: (i) => [typeof i === 'function' ? i() : i, noop],
  useEffect: noop, useLayoutEffect: noop, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(), Fragment: 'fragment',
};
let plugin = null;
try {
  plugin = mod.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error('意外 require: ' + name);
  });
  plugin.apply({
    effect(fn) { fn(); },
    locale: { register: noop, subscribe: () => () => {} },
    slots: { inject(name, cb) { cb(); }, register() { return () => {}; } },
  });
} catch (e) {
  console.error('✗ 初始化失败：' + (e && e.stack ? e.stack : String(e))); process.exit(1);
}
const api = sandbox.window.__DSH_IC_PULL__;
if (!api || typeof api.pullPromptFor !== 'function' || typeof api.normalizePullResult !== 'function' || typeof api.extractVideoFramesAt !== 'function') {
  console.error('✗ 未暴露 __DSH_IC_PULL__（拉片纯函数出口缺失）'); process.exit(1);
}
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) errs.push(label + '\n    期望 ' + JSON.stringify(b) + '\n    实际 ' + JSON.stringify(a)); };

async function main() {
  // 1) 提示词：帧时间 + 输出契约 + 不编造台词
  const prompt = api.pullPromptFor([{ t: 0.5 }, { t: 2 }, { t: 3.5 }], 4, true);
  ok(prompt.includes('t=0.5s') && prompt.includes('t=3.5s'), '提示词缺少帧时间轴');
  ok(prompt.includes('"shots"') && prompt.includes('"music"'), '提示词缺少输出契约');
  ok(prompt.includes('4 秒') || prompt.includes('4s'), '提示词缺少视频时长');

  // 2) 归一化：时间轴 → duration；首镜 opening；music 对象 → 文本；坏台词被过滤
  const j = {
    summary: '一段雨夜追逐',
    shots: [
      { start: 0, end: 1.4, title: '起', visual: '远景雨街', motion: '人物冲出', camera: '35mm 跟拍', dialogue: [{ role: '甲', line: '跑！' }, { role: '', line: 'x' }] },
      { start: 1.4, end: 4, title: '追', visual: '近景', motion: '回头', camera: '50mm 手持', characters: ['甲'] },
    ],
    music: { description: '低频鼓点', style: '悬疑', tempo: 'fast', confidence: 0.3 },
  };
  const r = api.normalizePullResult(j, 4);
  eq(r.shots.length, 2, '镜头数');
  eq(r.shots[0].duration, 1.4, '首镜时长');
  eq(r.shots[1].duration, 2.6, '次镜时长');
  eq(r.shots[0].seg, 'opening', '首镜段落类型');
  eq(r.shots[1].seg, 'continuation', '次镜段落类型');
  eq(r.shots[0].dialogue.length, 1, '空角色台词应被过滤');
  ok(r.music.includes('低频鼓点') && r.music.includes('悬疑'), 'music 对象未归一化为可读文本');

  // 3) 越界/缺失时间：夹到片长内、无时间按顺序补
  const r2 = api.normalizePullResult({ shots: [{ visual: 'a' }, { start: 3.8, end: 9, visual: 'b' }] }, 4);
  ok(r2.shots[0].duration > 0, '缺失时间的镜头未补时长');
  ok(r2.shots[1].duration <= 0.3 + 1e-6 || r2.shots[1].duration >= 0.3, '越界镜头未裁剪到片长内');

  // 4) 抽帧：4 帧、时间递增、dataURL 为 JPEG
  META = { duration: 6, w: 1280, h: 720 };
  const ex = await api.extractVideoFramesAt(new Blob(['x']), 4);
  eq(ex.frames.length, 4, '抽帧数量');
  eq(ex.frames.every((f) => /^data:image\/jpeg;base64,/.test(f.dataUrl)), true, '抽帧不是 JPEG dataURL');
  ok(ex.frames.every((f, i) => i === 0 || f.t > ex.frames[i - 1].t), '抽帧时间未递增');
  ok(ex.frames.every((f) => f.t > 0 && f.t < 6), '抽帧时间越界');

  if (errs.length) {
    console.error('✗ 拉片测试未通过（' + errs.length + ' 项）：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✓ 拉片测试通过（帧时间轴 / JSON 契约 / 时间归一化 / 抽帧 JPEG）');
  process.exit(0);
}
main().catch((e) => { console.error('✗ 拉片测试异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
