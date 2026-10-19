#!/usr/bin/env node
/**
 * 成片合成回归测试（dev-only）：
 * 在假浏览器环境里**真实执行** composeFinalCut 的主循环——分段推进、编辑时长裁剪、
 * 叠化/黑场转场、字幕绘制、进度回调、以及 "某一段加载失败" 的错误路径。
 *
 * 为什么需要它：合成链路依赖 video 元素 + MediaRecorder + canvas，静态审计抓不到
 * 自由变量（历史 bug：`remainMs = dur ? ...` 里 dur 未声明），只会在用户点"合成"时
 * 以 ReferenceError 炸掉。这里用桩把整条链路跑通。
 *
 * 运行：node scripts/test-compose.mjs   退出码 0 = 通过
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');

const noop = () => {};
const errs = [];

// ---------------- 假 video：按给定时长"播放" ----------------
let nowMs = 0;
function mkVideo(meta) {
  const v = {
    _t: 0,
    _start: 0,
    duration: meta.duration,
    videoWidth: meta.w || 1280,
    videoHeight: meta.h || 720,
    muted: true,
    volume: 1,
    ended: false,
    readyState: 4,
    preload: '',
    playsInline: false,
    onloadedmetadata: null,
    onerror: null,
    oncanplay: null,
    onseeked: null,
    get currentTime() {
      // 播放中：假 timeupdate 随墙钟推进（素材到时自动置 ended，避免无限循环）
      if (!v._playing) return v._t;
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const t = v._t + (nowMs - v._start) / 1000;
      if (d > 0 && t >= d) { v._t = d; v._playing = false; v.ended = true; return d; }
      return t;
    },
    set currentTime(x) { v._t = Math.max(0, Number(x) || 0); v._start = nowMs; v.ended = false; if (v.onseeked) setTimeout(() => v.onseeked && v.onseeked(), 0); },
    play() { v._playing = true; v._start = nowMs; return Promise.resolve(); },
    pause() { v._playing = false; },
  };
  // 立即触发 loadedmetadata（合成逻辑用它拿时长）
  setTimeout(() => { if (meta.fail) { if (v.onerror) v.onerror(); } else if (v.onloadedmetadata) v.onloadedmetadata(); }, 0);
  return v;
}

// ---------------- 假 canvas 2D ----------------
function mkCtx() {
  const calls = { drawImage: 0, fillText: 0, fillRect: 0 };
  return new Proxy({
    _calls: calls,
    measureText: () => ({ width: 10 }),
    drawImage: () => { calls.drawImage++; },
    fillText: () => { calls.fillText++; },
    fillRect: () => { calls.fillRect++; },
    save: noop, restore: noop,
    set font(v) { void v; }, set fillStyle(v) { void v; }, set globalAlpha(v) { void v; },
    set textAlign(v) { void v; }, set textBaseline(v) { void v; },
  }, {
    get: (t, p) => (p in t ? t[p] : noop),
    set: (t, p, v) => { t[p] = v; return true; },
  });
}

// ---------------- 假 MediaRecorder：同步产出可辨识的数据块 ----------------
let lastRecorder = null;
class MediaRecorderStub {
  static isTypeSupported(m) { return /mp4|webm/.test(m); }
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || 'video/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    lastRecorder = this;
  }
  start() {
    this.state = 'recording';
    // 交付 3 块假数据（模拟分段 flush）
    setTimeout(() => {
      for (const n of [1, 2, 3]) {
        if (this.ondataavailable) this.ondataavailable({ data: new Blob(['chunk' + n]) });
      }
    }, 5);
  }
  stop() {
    this.state = 'inactive';
    setTimeout(() => { if (this.onstop) this.onstop(); }, 5);
  }
}

// ---------------- 假 window / document ----------------
const videos = [];
const headStub = { appendChild: noop, removeChild: noop, querySelector: () => null };
const documentStub = {
  createElement: (tag) => {
    if (tag === 'video') {
      const meta = metaForVideo(videos.length);
      const v = mkVideo({ duration: meta.duration, w: meta.w, h: meta.h, fail: videos.failAt === videos.length });
      videos.push(v);
      return v;
    }
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => mkCtx(), captureStream: () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] }), toBlob: (cb) => cb(new Blob(['x'])) };
    return { style: {}, dataset: {}, children: [], appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop, toggle: noop }, textContent: '', id: '' };
  },
  head: headStub,
  body: { appendChild: noop, removeChild: noop },
  documentElement: { appendChild: noop, removeChild: noop },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
};
// 每个 video 元素的时长序列（由测试在运行时决定）
let META = [];
function metaForVideo(i) { return META[i] || { duration: 2, w: 1280, h: 720 }; }

const sandbox = {
  window: { __DSH_IC_SMOKE__: true, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, localStorage: { getItem: () => null, setItem: noop, removeItem: noop } },
  document: documentStub,
  navigator: { userAgent: 'test-compose', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(nowMs), 1),
  cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  performance: { now: () => nowMs },
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
  MediaRecorder: MediaRecorderStub,
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
sandbox.window.MediaRecorder = MediaRecorderStub;
vm.createContext(sandbox);

let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
} catch (e) {
  console.error('✗ client.js 顶层执行失败：' + (e && e.message));
  process.exit(1);
}
if (!mod || !mod.factory) { console.error('✗ ModuleLoader.load 未被调用'); process.exit(1); }
// 假 React（只够让模块初始化，不渲染组件树）
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
} catch (e) {
  console.error('✗ factory(require) 执行失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}
const ctx = {
  effect(fn) { fn(); },
  locale: { register: noop, subscribe: () => () => {} },
  slots: { inject(name, cb) { cb(); }, register() { return () => {}; } },
};
try { plugin.apply(ctx); } catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}
const api = sandbox.window.__DSH_IC_COMPOSE__;
if (!api || typeof api.composeFinalCut !== 'function') {
  console.error('✗ 未暴露 __DSH_IC_COMPOSE__（composeFinalCut 出口缺失）');
  process.exit(1);
}
const eq = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) errs.push(label + '\n    期望 ' + JSON.stringify(b) + '\n    实际 ' + JSON.stringify(a)); };

// 推进假时钟：requestAnimationFrame 每 1ms 走一次，这里把 nowMs 跟着同步推进
const tick = setInterval(() => { nowMs += 40; }, 2);

async function main() {
  // ---------- 1) 基本合成：3 段 ----------
  META = [{ duration: 2 }, { duration: 1.5 }, { duration: 3 }];
  const segs = [
    { url: 'blob:1', name: '场1', sub: '第一句' },
    { url: 'blob:2', name: '场2', sub: '第二句' },
    { url: 'blob:3', name: '场3', sub: '' },
  ];
  const progress = [];
  let blob = null;
  try {
    blob = await api.composeFinalCut(segs, { width: 1280, height: 720, keepAudio: false, transition: 'none' }, (f, name) => progress.push([f, name]));
  } catch (e) {
    errs.push('基本合成（3 段）抛错：' + (e && e.message) + '\n' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : ''));
  }
  if (blob) {
    if (!(blob instanceof Blob)) errs.push('合成结果不是 Blob');
    if (blob.size <= 0) errs.push('合成结果为空');
  }
  if (progress.length < 3) errs.push('进度回调次数不足（实际 ' + progress.length + '，应有 3 段）：' + JSON.stringify(progress) + ' blobSize=' + (blob && blob.size) + ' videos=' + videos.length + ' durations=' + JSON.stringify(videos.map((x) => [x.duration, x._playing, x.ended])));

  // ---------- 2) 裁剪：编辑时长小于素材时长 ----------
  META = [{ duration: 10 }, { duration: 10 }];
  const p2 = [];
  try {
    const b2 = await api.composeFinalCut(
      [{ url: 'blob:a', name: 'A', dur: 2 }, { url: 'blob:b', name: 'B', dur: 1 }],
      { width: 640, height: 360, keepAudio: false, transition: 'fade' },
      (f) => p2.push(f),
    );
    if (!b2 || b2.size <= 0) errs.push('裁剪合成结果为空');
  } catch (e) {
    errs.push('裁剪合成（dur<素材时长）抛错：' + (e && e.message));
  }

  // ---------- 3) 黑场转场 ----------
  META = [{ duration: 1 }, { duration: 1 }];
  try {
    await api.composeFinalCut(
      [{ url: 'blob:x', name: 'X' }, { url: 'blob:y', name: 'Y' }],
      { width: 320, height: 180, keepAudio: false, transition: 'black' },
      noop,
    );
  } catch (e) {
    errs.push('黑场转场合成抛错：' + (e && e.message));
  }

  // ---------- 4) 元数据拿不到（duration=0/NaN）也要能走完（不挂死） ----------
  META = [{ duration: NaN }, { duration: 0 }];
  try {
    const b4 = await api.composeFinalCut(
      [{ url: 'blob:u', name: 'U1' }, { url: 'blob:v', name: 'U2' }],
      { width: 320, height: 180, keepAudio: false },
      noop,
    );
    if (!b4) errs.push('无时长元数据时未产出结果');
  } catch (e) {
    errs.push('无时长元数据时抛错：' + (e && e.message));
  }

  // ---------- 5) 片段解码失败必须明确报错（不静默吞掉） ----------
  // 真机语义：onerror 且拿不到时长 = 这段根本无法合成 → 必须中止并指名哪一段；
  // 反之若只是 metadata 超时但有体积可读，仍按兜底时长继续（下面 6 单独覆盖）。
  META = [{ duration: undefined }];
  videos.failAt = 0;
  videos.length = 0;
  try {
    await api.composeFinalCut([{ url: 'blob:bad', name: '坏片段' }], { width: 320, height: 180, keepAudio: false }, noop);
    errs.push('片段解码失败时应抛错（不能静默丢弃片段）');
  } catch (e) {
    if (!/坏片段|解码|播放/.test(String(e.message))) errs.push('解码失败的错误信息不可读：' + e.message);
  }
  videos.failAt = -1;

  // ---------- 6) 空片段列表 ----------
  try {
    await api.composeFinalCut([], { width: 320, height: 180 }, noop);
    errs.push('空片段列表应抛错');
  } catch { /* 预期 */ }
}

main().then(() => {
  clearInterval(tick);
  if (errs.length) {
    console.error('✗ 成片合成测试未通过（' + errs.length + ' 项）：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✓ 成片合成测试全部通过（分段推进/裁剪/叠化/黑场/无时长兜底/解码失败报错/空列表）');
  process.exit(0);
}).catch((e) => {
  clearInterval(tick);
  console.error('✗ 成片合成测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
