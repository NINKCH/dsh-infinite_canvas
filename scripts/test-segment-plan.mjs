// 按镜头切段（segmentation planner）回归测试。
//
// 用户实测痛点：分镜脚本被"按 10–14 秒等比例"切成很规整的段，而不是按真实镜头边界分组；
// 两个本来衔接着同一角色同一动作的镜头被塞进两个生成段，第二次生成接不上第一次；
// 加了首帧参考后剪辑处仍重影/卡顿；MiniMax 这类弱衔接模型尤其处理不了。
//
// 本测试锁死切段铁律（任一条失败 = 用户会再次看到"接不上"）：
//   ① 段边界只落在切点（scene_change / closeup / new_character）或段首；
//   ② 连续 continuation 镜头绝不跨段（动作相位不可拆）；
//   ③ 每段时长 ≤ 单次上限；
//   ④ 找不到切点又超长 → seamRisk='forced' 且给出告警，绝不静默；
//   ⑤ 从切点开始的段不需要尾帧接力（弱衔接模型的默认路线）；
//   ⑥ 提示词只写本段镜头，且注入 timeBeats / camera / vfx / negative。
//
// 运行：node scripts/test-segment-plan.mjs（退出码 0=通过）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM / localStorage（与 test-expand-assets 同一套） ----------------
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

const PID = 'p_segplan';
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '切段测试', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-segment-plan', clipboard: { writeText: async () => {} } },
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

// ---------------- 构造镜头 ----------------
const mkShot = (o) => Object.assign({
  title: '镜', visual: '中景，平视，@陈拾@ 站在雨里，画面右侧三分之一、身体朝左；前景雨帘，背景邮局门口；暖黄门灯从右后方打来；信封在胸口。',
  motion: '起点：他举着信封 → 缓缓贴上胸口、低头 → 停在信封贴住心口', duration: 3,
  characters: ['陈拾'], scene: '褶皱巷', props: [], dialogue: [], sfx: '雨声',
  tail: '右手按在胸口一半，视线仍锁在信封上，雨帘挡住右后肩',
  cam: '轻微手持晃动，未停', seg: 'continuation',
}, o || {});

const RUN = [
  // 一场戏：连续 5 个 continuation 镜头（同一个人同一段走位），总 15s
  mkShot({ title: '起', duration: 3, seg: 'opening' }),
  mkShot({ title: '接1', duration: 3 }),
  mkShot({ title: '接2', duration: 3 }),
  mkShot({ title: '接3', duration: 3 }),
  mkShot({ title: '接4', duration: 3 }),
  // 换场：新场景 3 镜
  mkShot({ title: '换场', duration: 4, seg: 'scene_change', scene: '邮局内' }),
  mkShot({ title: '内1', duration: 4, seg: 'continuation', scene: '邮局内' }),
  mkShot({ title: '内2', duration: 4, seg: 'continuation', scene: '邮局内' }),
  // 特写插入
  mkShot({ title: '特写', duration: 1.5, seg: 'closeup' }),
];
const TOTAL = RUN.reduce((a, s) => a + s.duration, 0);

function assertSegments(label, shots, opts, check) {
  const plan = SEG.planShotSegments(shots, opts);
  const segs = plan.segments;
  // 全局段落规划（与实现同一套推断）：用来判断"段边界是否真的落在换镜头上"
  const plans = shots.map((s, i) => SEG.shotContinuityPlan(s, shots[i - 1] || null, i));
  ok(segs.length > 0, label + '：没有切出任何段');
  // ① 覆盖完整且不重叠：所有镜头恰好出现一次，顺序不变
  const covered = segs.flatMap((s) => s.shotIds);
  ok(covered.length === shots.length, label + '：段覆盖镜头数 ' + covered.length + ' ≠ 镜头总数 ' + shots.length);
  ok(covered.every((v, i) => v === i), label + '：段覆盖不是 0..N-1 的顺序（' + covered.join(',') + '）');
  segs.forEach((s, i) => {
    ok(s.startIndex === (i === 0 ? 0 : segs[i - 1].endIndex + 1), label + '：第 ' + (i + 1) + ' 段的起点与上一段不连续');
    // ③ 每段时长 ≤ 上限（单镜本身超长的 forced 段除外）
    const single = s.shotIds.length === 1;
    if (!single) ok(s.duration <= (opts.maxSeconds + 1e-6), label + '：第 ' + (i + 1) + ' 段时长 ' + s.duration + 's 超上限 ' + opts.maxSeconds + 's');
    // ④ 段内镜头时长之和 = 段时长
    const sum = s.shots.reduce((a, sh) => a + sh.duration, 0);
    ok(Math.abs(sum - s.duration) < 0.11, label + '：第 ' + (i + 1) + ' 段时长 ' + s.duration + ' 与镜时长之和 ' + sum + ' 不符');
  });
  // ② 切点约束（核心铁律）：段边界必须落在"换镜头的镜头"上——
  //    即下一段的首镜必须是 scene_change / closeup / new_character / opening（opening 仅第 1 镜）。
  //    若下一段首镜仍是 continuation，那一刀就切在了连续动作中间 → 必须 needsTailChain 且标 seamRisk。
  for (let i = 0; i < segs.length - 1; i++) {
    const nextFirst = plans[segs[i + 1].startIndex];
    const nextIsCut = SEG.isCutPoint(nextFirst.seg);
    if (!nextIsCut) {
      ok(segs[i + 1].needsTailChain === true,
        label + '：第 ' + (i + 2) + ' 段首镜是续帧镜头（' + nextFirst.seg + '），这一刀切在连续动作中间却没标需要尾帧接力');
      ok(segs[i + 1].seamRisk !== 'none', label + '：跨连续动作的段没有标注 seamRisk');
    } else {
      // 从换镜头切点开始的段：不需要接力（弱衔接模型的默认路线）
      ok(segs[i + 1].needsTailChain === false,
        label + '：第 ' + (i + 2) + ' 段其实从切点（' + nextFirst.seg + '）开始，却仍要尾帧接力——多一次硬接就是多一次重影');
      ok(segs[i + 1].opensOnCut === true, label + '：第 ' + (i + 2) + ' 段从切点开始却未标 opensOnCut');
    }
  }
  if (check) check(plan, segs);
  return plan;
}

// ============================================================
// 1) 15s 上限：整表 26.5s 必须切成多段，且切点落在换场/特写处
// ============================================================
{
  const plan = assertSegments('15s上限', RUN, { maxSeconds: 15 }, (p, segs) => {
    ok(segs.length >= 2, '15s上限：26.5s 的整表应切成 ≥2 段，实际 ' + segs.length);
    ok(p.total === TOTAL, '15s上限：总时长统计错误（' + p.total + ' ≠ ' + TOTAL + '）');
    ok(p.max === 15, '15s上限：max 回传错误（' + p.max + '）');
    // 第 1 段必须从 opening 开始
    ok(segs[0].firstSeg === 'opening', '15s上限：第 1 段首镜应是 opening，实际 ' + segs[0].firstSeg);
    ok(segs[0].opensOnCut === true, '15s上限：第 1 段必然从一个合法起点开始');
    // 第 1 段必须把连续 5 镜（0..4）整段包住或整段断开在切点——但绝不能切在 0..4 中间
    // 判据：第 1 段的 endIndex 要么 >= 4（含), 要么入位于 4 之前但下一段 needsTailChain
    if (segs.length > 1 && segs[0].endIndex < 4) {
      ok(segs[1].needsTailChain === true, '15s上限：把连续动作切断却没标需要尾帧接力');
    }
  });
  ok(plan.cutMode === 'clean' || plan.cutMode === 'forced', '15s上限：cutMode 取值异常 ' + plan.cutMode);
}

// ============================================================
// 2) 6s 上限（MiniMax 档）：必须切得更碎，但切点仍只落在换场/特写
// ============================================================
{
  const segs6 = SEG.planShotSegments(RUN, { maxSeconds: 6 }).segments;
  const segs15 = SEG.planShotSegments(RUN, { maxSeconds: 15 }).segments;
  ok(segs6.length > segs15.length, '6s上限应比 15s上限切出更多段（' + segs6.length + ' vs ' + segs15.length + '）');
  segs6.forEach((s, i) => {
    const single = s.shotIds.length === 1;
    if (!single) ok(s.duration <= 6 + 1e-6, '6s上限：第 ' + (i + 1) + ' 段时长 ' + s.duration + ' 超过 6s');
  });
}

// ============================================================
// 3) 单镜超长（20s 一镜，上限 15s）：必须 forced + 告警，不许静默
// ============================================================
{
  const long = [mkShot({ title: '超长镜', duration: 20, seg: 'opening' })];
  const plan = SEG.planShotSegments(long, { maxSeconds: 15 });
  ok(plan.segments.length === 1, '单镜超长：应只切出 1 段（单镜不可再拆）');
  ok(plan.warnings.length > 0, '单镜超长：必须给出告警，实际没有 warnings');
  ok(plan.warnings.some((w) => /超|上限/.test(w)), '单镜超长：告警文案未说明超上限');
}

// ============================================================
// 4) 弱衔接模型判定：MiniMax 不给硬尾帧接力，Seedance 才给
// ============================================================
{
  const needsChainSeg = { needsTailChain: true };
  ok(SEG.segmentNeedsHardFrame(needsChainSeg, 'MiniMax-Hailuo-02') === false, 'MiniMax 不应被判定为可依赖硬尾帧接力');
  ok(SEG.segmentNeedsHardFrame(needsChainSeg, 'minimax-h3') === false, 'minimax-h3 不应被判定为可依赖硬尾帧接力');
  ok(SEG.segmentNeedsHardFrame(needsChainSeg, 'doubao-seedance-2-5') === true, 'Seedance 2.5 应允许尾帧接力');
  ok(SEG.segmentNeedsHardFrame({ needsTailChain: false }, 'doubao-seedance-2-5') === false, '不需要接力的段不应接尾帧');
}

// ============================================================
// 5) 提示词：只写本段镜头 + 注入 timeBeats / camera / vfx / negative
// ============================================================
{
  const build = sandbox.window.__DSH_IC_STORYBOARD_PROMPT__ && sandbox.window.__DSH_IC_STORYBOARD_PROMPT__.buildStoryboardVideoPrompt;
  ok(typeof build === 'function', '未暴露 buildStoryboardVideoPrompt（提示词测试缝隙缺失）');
  if (typeof build === 'function') {
    const shots = [
      mkShot({ title: '甲', duration: 3, seg: 'opening', timeBeats: ['0s 右手抬起一半', '1s 手继续抬到胸口', '3s 停在胸口上方'], camera: '中近景 50mm f/2，缓慢推近，起点→终点', vfx: '雨丝斜打、尘粒在门灯光柱中浮动', negative: '手部畸形、多指' }),
      mkShot({ title: '乙', duration: 3, timeBeats: ['0s 门槛前停步', '1s 重心前移抬脚', '3s 脚掌落地'], camera: '全身 35mm f/4，右移跟拍' }),
      mkShot({ title: '丙', duration: 3, seg: 'scene_change', scene: '邮局内' }),
    ];
    const sb = { data: { shots, label: '场1' } };
    const full = build(sb);
    ok(typeof full === 'string' && full.length > 200, '整表提示词为空或过短');
    for (const k of ['动作节拍', '机位/焦段/运镜', '物理特效', '禁止：换脸']) {
      ok(full.includes(k), '提示词缺少关键段落「' + k + '」（模型不会自己补出来）');
    }
    ok(full.includes('雨丝斜打'), '提示词未注入 vfx 内容');
    ok(full.includes('中近景 50mm'), '提示词未注入 camera 内容');
    ok(full.includes('右手抬起一半'), '提示词未注入 timeBeats 内容');
    // 段：只写本段镜头
    const seg = { from: 1, to: 1, index: 0, count: 2, needsTailChain: true, seamRisk: 'chain' };
    const one = build(sb, seg);
    ok(one.includes('门槛前停步'), '段提示词应包含本段镜头（乙）的 timeBeats');
    ok(!one.includes('右手抬起一半'), '段提示词不应包含段外镜头（甲）的内容');
    ok(!one.includes('邮局内'), '段提示词不应包含段外镜头（丙）的内容');
    ok(/第 1\/2 段|1\/2/.test(one), '段提示词未标注段序号');
    ok(/承接上一段|尾帧/.test(one), '需要接力的段提示词未说明承接关系');
    // 不需要接力的段：应明确"从切点开始，不接上一段画面"
    const seg2 = { from: 2, to: 2, index: 1, count: 2, needsTailChain: false, seamRisk: 'none' };
    const two = build(sb, seg2);
    ok(/切点|不要承接上一段/.test(two), '从切点开始的段提示词未声明"不承接上一段画面"');
  }
}

// ============================================================
// 6) 源码级反向断言：旧的"整表一次生成"写法不得复活
// ============================================================
{
  ok(!/const total = shots\.reduce\(\(a, sh\) => a \+ Math\.max\(1, Number\(sh\.duration\) \|\| 3\), 0\);\s*\n\s*\/\/ 合并后的视频节点/.test(src),
    '旧的「整表时长求和塞一次生成」写法仍在（切段改造被回退）');
  ok(/function planShotSegments\(/.test(src), 'planShotSegments 不存在（切段规划器被删除）');
  ok(/function isCutPoint\(/.test(src), 'isCutPoint 不存在（切点判定被删除）');
  ok(/function segmentNeedsHardFrame\(/.test(src), 'segmentNeedsHardFrame 不存在（强弱模型分流被删除）');
  ok(/function videoSegmentOf\(/.test(src), 'videoSegmentOf 不存在（视频节点段区间解析被删除）');
  ok(/segShotFrom/.test(src) && /segShotTo/.test(src), '视频节点缺少 segShotFrom/segShotTo 字段');
  ok(/segMaxSeconds/.test(src), '分镜表缺少 segMaxSeconds（单段上限）字段');
  // 旧 expandStoryboard 里"每张分镜表只建一个 videoGen"的写法不得复活
  ok(!/const videoGen = mk\('video', baseX \+ 540, baseY \+ 20/.test(src), 'expandStoryboard 又退回"一个分镜表 = 一个视频节点"');
}


// ---------------- 用户实测回归（2026-10-28）----------------
// 症状：20s 场次被切成「19.8 + 1.0」，且第二段从镜中开始 → UI 报"存在硬切点"。
// 两处根因：① 切点镜被留在上一段末尾（应开新段）；② 1 秒尾段没有并回上一段。
{
  const mk = (o) => Object.assign({ title: '镜', visual: '中景，平视，人物站在雨里', motion: '起 → 止', duration: 1.5, characters: ['甲'], scene: '天桥', props: [], seg: 'continuation' }, o);

  // 切点镜归属：换场镜必须成为下一段首镜，本段不得把它当尾镜
  const s = [];
  for (let i = 0; i < 11; i++) s.push(mk({ duration: 2.1, seg: i === 0 ? 'opening' : i === 5 ? 'scene_change' : 'continuation' }));
  s.push(mk({ duration: 2.6, seg: 'closeup' }));
  const r = SEG.planShotSegments(s, { maxSeconds: 20 });
  ok(r.cutMode === 'clean', '切点镜必须开新段：含换场镜的分镜应切成干净段，实际 cutMode=' + r.cutMode);
  ok(r.segments.length >= 2 && r.segments[1].firstSeg === 'scene_change', '第二段首个镜头应是换场镜（切点归属修正），实际 ' + (r.segments[1] && r.segments[1].firstSeg));

  // 尾段合并：1 秒尾镜不该单独成段
  const s2 = [];
  for (let i = 0; i < 12; i++) s2.push(mk({ seg: i === 0 ? 'opening' : i === 3 ? 'closeup' : 'continuation' }));
  s2.push(mk({ duration: 1.0, visual: '黑屏闷响，画面全黑', seg: 'closeup' }));
  const r2 = SEG.planShotSegments(s2, { maxSeconds: 20 });
  ok(r2.segments.length === 1, '1 秒尾镜应并回上一段，实际切成 ' + r2.segments.length + ' 段');
  ok(r2.cutMode === 'clean', '尾段合并后不应报硬切，实际 ' + r2.cutMode);
}

if (errs.length) {
  console.error('✗ 按镜头切段测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 按镜头切段测试通过（切点约束 / 连续动作不拆 / 时长上限 / 超长告警 / 强弱模型分流 / 提示词注入 / 旧写法反向断言）');
process.exit(0);
