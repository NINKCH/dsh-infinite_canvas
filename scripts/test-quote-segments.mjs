#!/usr/bin/env node
// 漂移守卫：宿主预算单估算（shot-segments.js）必须与客户端执行（client.js）完全同源。
//
// 背景（#8，0.20.2）：真实视频调用次数由客户端 planShotSegments 按镜头边界切段决定
// （一个分镜表 ≠ 一次生成；默认上限 15s，分镜表节点 data.targetDuration 可调——0.20.3 起下拉即总时长语义）。
// 宿主 production.js quote() 的 videoCalls 用的是 shot-segments.js——client.js
// planShotSegments 的逐字移植。本测试用 test-segment-plan.mjs 的 vm 手法（假
// React/DOM/localStorage 桩）加载真实 client.js，取测试缝
// window.__DSH_IC_SEGMENT__.planShotSegments（client.js L21879），与新模块在
// 同一组 fixtures 上断言输出一致。
//
// 任何一条不一致 = 宿主估算与客户端执行漂移 = 预算单再次失真（用户批准决策被误导）。
//
// 运行：node scripts/test-quote-segments.mjs（退出码 0=通过）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planShotSegments as hostPlanShotSegments } from '../shot-segments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM / localStorage（与 test-segment-plan 同一套） ----------------
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
  createElement: (tag) => { const el = elStub(); if (tag === 'canvas') el.captureStream = () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] }); return el; },
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null,
  addEventListener: noop, removeEventListener: noop,
};
const lsStore = new Map();
const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };

const PID = 'p_quoteseg';
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '预算切段漂移守卫', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-quote-segments', clipboard: { writeText: async () => {} } },
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
  indexedDB: { open: () => { const req = {}; setTimeout(() => { try { req.onerror && req.onerror(); } catch { /* 忽略 */ } }, 0); return req; } },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
if (!mod) { console.error('✗ client.js 顶层执行失败'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });

const SEG = sandbox.window.__DSH_IC_SEGMENT__;
if (!SEG || typeof SEG.planShotSegments !== 'function') {
  console.error('✗ 未暴露 window.__DSH_IC_SEGMENT__（切段规划的测试缝隙缺失）');
  process.exit(1);
}
const clientPlan = SEG.planShotSegments;

// ---------------- 构造镜头（形状抄自 scripts/test-segment-plan.mjs） ----------------
const mkShot = (o) => Object.assign({
  title: '镜', visual: '中景，平视，@陈拾@ 站在雨里，画面右侧三分之一、身体朝左；前景雨帘，背景邮局门口；暖黄门灯从右后方打来；信封在胸口。',
  motion: '起点：他举着信封 → 缓缓贴上胸口、低头 → 停在信封贴住心口', duration: 3,
  characters: ['陈拾'], scene: '褶皱巷', props: [], dialogue: [], sfx: '雨声',
  tail: '右手按在胸口一半，视线仍锁在信封上，雨帘挡住右后肩',
  cam: '轻微手持晃动，未停', seg: 'continuation',
}, o || {});

// test-segment-plan.mjs 的 RUN 原样抄入（26.5s：5 连续镜 + 换场 3 镜 + 特写）
const RUN = [
  mkShot({ title: '起', duration: 3, seg: 'opening' }),
  mkShot({ title: '接1', duration: 3 }),
  mkShot({ title: '接2', duration: 3 }),
  mkShot({ title: '接3', duration: 3 }),
  mkShot({ title: '接4', duration: 3 }),
  mkShot({ title: '换场', duration: 4, seg: 'scene_change', scene: '邮局内' }),
  mkShot({ title: '内1', duration: 4, seg: 'continuation', scene: '邮局内' }),
  mkShot({ title: '内2', duration: 4, seg: 'continuation', scene: '邮局内' }),
  mkShot({ title: '特写', duration: 1.5, seg: 'closeup' }),
];

// 用户实测的灾难案例形状：62 秒续帧链、上限 15 → 十余段（预算单曾经只显示"1 次"的口径根源）
const CHAIN62 = [
  mkShot({ title: '起', duration: 4.6, seg: 'opening' }),
  ...Array.from({ length: 12 }, (_, k) => mkShot({ title: '续' + (k + 1), duration: 4.8 })),
];

const FIXTURES = [
  {
    name: '空表',
    shots: [],
    variants: [{}, { maxSeconds: 15 }],
  },
  {
    name: '空表变体（null / 非数组 / 全是无效镜头）',
    shots: null,
    variants: [undefined, {}],
    extra: [
      ['非数组输入', 'not-an-array', {}],
      ['全无效镜头（缺 visual/motion/dialogue）', [{ title: '空镜', duration: 5 }, { title: '空镜2', duration: 5 }], { maxSeconds: 15 }],
    ],
  },
  {
    name: '单短镜',
    shots: [mkShot({ title: '独镜', duration: 3, seg: 'opening' })],
    variants: [{}, { maxSeconds: 15 }, { maxSeconds: 6 }],
  },
  {
    name: '15s 内多镜（12s 不该切）',
    shots: [
      mkShot({ title: '起', duration: 3, seg: 'opening' }),
      mkShot({ title: '续1', duration: 3 }),
      mkShot({ title: '换场', duration: 3, seg: 'scene_change' }),
      mkShot({ title: '续2', duration: 3 }),
    ],
    variants: [{ maxSeconds: 15 }, { maxSeconds: 12 }],
  },
  {
    name: '超限含 scene_change 切点（20s：切点镜归属决定段形状）',
    shots: [
      mkShot({ title: '起', duration: 4, seg: 'opening' }),
      mkShot({ title: '续1', duration: 4 }),
      mkShot({ title: '换场', duration: 4, seg: 'scene_change' }),
      mkShot({ title: '续2', duration: 4 }),
      mkShot({ title: '续3', duration: 4 }),
    ],
    variants: [{ maxSeconds: 15 }, { maxSeconds: 6 }, { maxSeconds: 30 }],
  },
  {
    name: '超限含续帧链（62s 续帧不许跨段，硬切必须如实告警）',
    shots: CHAIN62,
    variants: [{ maxSeconds: 15 }, { maxSeconds: 30 }],
  },
  {
    name: 'test-segment-plan 的 RUN 原表（26.5s）',
    shots: RUN,
    variants: [{ maxSeconds: 15 }, { maxSeconds: 6 }],
  },
  {
    name: '单镜超上限（20s 一镜，上限 15s → forced + 告警）',
    shots: [mkShot({ title: '超长镜', duration: 20, seg: 'opening' })],
    variants: [{ maxSeconds: 15 }],
  },
  {
    name: 'tiny-tail 合并（14s + 2s 碎尾 → 并回一段 16s）',
    shots: [
      mkShot({ title: '起', duration: 7, seg: 'opening' }),
      mkShot({ title: '续1', duration: 7 }),
      mkShot({ title: '换场', duration: 2, seg: 'scene_change' }),
    ],
    variants: [{ maxSeconds: 15 }],
    absolute: (plan) => {
      ok(plan.segments.length === 1 && plan.segments[0].duration === 16,
        'tiny-tail：碎尾应并回上一段（1 段 16s），实际 ' + plan.segments.length + ' 段 [' + plan.segments.map((s) => s.duration).join(',') + ']s');
    },
  },
];

// ---------------- 漂移断言：宿主移植版 ≡ 客户端真实实现 ----------------
const DRIFT = '宿主估算与客户端执行漂移 = 预算单再次失真';
let compared = 0;
for (const fx of FIXTURES) {
  const cases = [];
  for (const v of fx.variants || [{}]) cases.push([fx.name, fx.shots, v]);
  for (const [nm, shots, v] of fx.extra || []) cases.push([fx.name + '·' + nm, shots, v]);
  for (const [name, shots, opts] of cases) {
    const snap = JSON.stringify({ shots, opts: opts === undefined ? null : opts });
    const back = JSON.parse(snap);
    const a = clientPlan(back.shots, back.opts);
    const b = hostPlanShotSegments(JSON.parse(snap).shots, back.opts);
    compared++;
    const tag = name + '（opts=' + JSON.stringify(opts === undefined ? null : opts) + '）';
    // 全量深度一致：segments/total/max/cutMode/warnings 逐字节一致（含每段 shots 引用内容的序列化）
    ok(JSON.stringify(a) === JSON.stringify(b), tag + '：全量输出不一致 → ' + DRIFT
      + '\n  client=' + JSON.stringify(a).slice(0, 400)
      + '\n  host  =' + JSON.stringify(b).slice(0, 400));
    // brief 点名的三项分别断言（失败时给出可读差异）
    ok(a.segments.length === b.segments.length, tag + '：段数 client=' + a.segments.length + ' ≠ host=' + b.segments.length + ' → ' + DRIFT);
    const da = a.segments.map((s) => s.duration);
    const db = b.segments.map((s) => s.duration);
    ok(JSON.stringify(da) === JSON.stringify(db), tag + '：每段时长 client=[' + da.join(',') + '] ≠ host=[' + db.join(',') + '] → ' + DRIFT);
    ok(a.cutMode === b.cutMode, tag + '：cutMode client=' + a.cutMode + ' ≠ host=' + b.cutMode + ' → ' + DRIFT);
    ok(a.total === b.total && a.max === b.max, tag + '：total/max 不一致（client=' + a.total + '/' + a.max + '，host=' + b.total + '/' + b.max + '）→ ' + DRIFT);
    // 覆盖完整性（廉价绝对校验）：所有镜头恰好按序出现一次
    const covered = b.segments.flatMap((s) => s.shotIds);
    const n = Array.isArray(shots) ? shots.length : 0;
    ok(covered.every((v, i) => v === i) || !n, tag + '：宿主段覆盖不是 0..N-1 顺序');
    if (fx.absolute) fx.absolute(b);
  }
}
ok(compared >= 15, '漂移守卫覆盖不足：只比了 ' + compared + ' 组（应 ≥15 组 fixtures×opts）');

// ---------------- 汇总 ----------------
if (errs.length) {
  console.error('✗ 漂移守卫失败（' + errs.length + ' 项）：shot-segments.js 与 client.js planShotSegments 不一致');
  for (const e of errs) console.error('  · ' + e);
  process.exit(1);
}
console.log('✓ 漂移守卫通过：shot-segments.js ≡ client.js planShotSegments（' + compared + ' 组 fixtures×opts 全一致）');
process.exit(0);
