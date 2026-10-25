// Phase A 回归：四元数 slerp / 缓动表 / 三次贝塞尔 / 通道求值 / poseKeys 四元数
// 基准数值来自 Blender 源码 blenkernel/intern/fcurve_test.cc（只取数学期望值，不复制代码）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const near = (a, b, eps, m) => { if (!(Math.abs(Number(a) - Number(b)) <= eps)) errs.push(m + '（实际 ' + a + ' / 期望 ' + b + '）'); };

// ── ① 线性插值（fcurve_test InterpolationLinear：1→7、2→13，1.25/1.5/1.75 = 8.5/10/11.5） ──
{
  const keys = [{ t: 1, v: 7, interp: 'linear' }, { t: 2, v: 13, interp: 'linear' }];
  const get = (k) => k.v;
  near(E.evalKeyChannel(keys, get, 1.25), 8.5, 1e-9, '线性 @1.25 应为 8.5');
  near(E.evalKeyChannel(keys, get, 1.5), 10, 1e-9, '线性 @1.5 应为 10');
  near(E.evalKeyChannel(keys, get, 1.75), 11.5, 1e-9, '线性 @1.75 应为 11.5');
}

// ── ② 贝塞尔：用 fcurve_test 的「modified handles」绝对坐标换算成偏移，验证求值器 ──
{
  const keys = [
    { t: 1, v: 7, interp: 'bezier', hIn: { dx: 0.71855 - 1, dy: 6.22482 - 7 }, hOut: { dx: 1.35148 - 1, dy: 7.96806 - 7 } },
    { t: 2, v: 13, interp: 'bezier', hIn: { dx: 1.66667 - 2, dy: 10.4136 - 13 }, hOut: { dx: 2.33333 - 2, dy: 15.5864 - 13 } },
  ];
  const get = (k) => k.v;
  near(E.evalKeyChannel(keys, get, 1.25), 7.945497, 1e-4, '贝塞尔 @1.25 应为 7.945497');
  near(E.evalKeyChannel(keys, get, 1.5), 9.3495407, 1e-4, '贝塞尔 @1.5 应为 9.3495407');
  near(E.evalKeyChannel(keys, get, 1.75), 11.088551, 1e-4, '贝塞尔 @1.75 应为 11.088551');
  near(E.evalKeyChannel(keys, get, 1), 7, 1e-9, '贝塞尔应精确过首帧');
  near(E.evalKeyChannel(keys, get, 2), 13, 1e-9, '贝塞尔应精确过尾帧');
}

// ── ③ 自动切线：单调段不过冲、端点精确 ──
{
  const keys = [{ t: 0, v: 0, interp: 'bezier' }, { t: 1, v: 10, interp: 'bezier' }, { t: 2, v: 30, interp: 'bezier' }];
  const get = (k) => k.v;
  let prev = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const v = E.evalKeyChannel(keys, get, i / 20);
    ok(v >= prev - 1e-9, '自动切线：0→2 区间应单调递增（t=' + (i / 20) + '）');
    ok(v >= -1e-6 && v <= 30 + 1e-6, '自动切线：不应越出端点范围（t=' + (i / 20) + ' v=' + v + '）');
    prev = v;
  }
  near(E.evalKeyChannel(keys, get, 0), 0, 1e-9, '自动切线：首帧精确');
  near(E.evalKeyChannel(keys, get, 2), 30, 1e-9, '自动切线：尾帧精确');
}

// ── ④ constant 与默认 auto（smoothstep） ──
{
  const c = [{ t: 0, v: 5, interp: 'constant' }, { t: 1, v: 9, interp: 'constant' }];
  near(E.evalKeyChannel(c, (k) => k.v, 0.9), 5, 1e-9, 'constant：段内应保持起始值');
  const d = [{ t: 1, v: 7 }, { t: 2, v: 13 }];
  near(E.evalKeyChannel(d, (k) => k.v, 1.25), 7 + 6 * 0.15625, 1e-9, '默认 auto：1.25 应为 smoothstep(0.25)');
  near(E.evalKeyChannel([{ t: 1, v: 7, ease: 'linear' }, { t: 2, v: 13, ease: 'linear' }], (k) => k.v, 1.25), 8.5, 1e-9, 'ease:linear 应等价线性');
}

// ── ⑤ 缓动表性质 ──
{
  for (const id of ['auto', 'linear', 'sine_in', 'sine_out', 'sine_in_out', 'cubic_in', 'back_out', 'elastic_out', 'bounce_out']) {
    const a = E.easeFactor(id, 0), b = E.easeFactor(id, 1);
    near(a, 0, 1e-6, 'easeFactor(' + id + ',0) 应为 0');
    near(b, 1, 1e-6, 'easeFactor(' + id + ',1) 应为 1');
  }
  ok(E.easeFactor('cubic_in', 0.5) < E.easeFactor('linear', 0.5), 'cubic_in 前半应慢于线性');
  near(E.easeFactor('constant', 0.9), 0, 1e-12, 'constant 缓动应恒为 0');
}

// ── ⑥ 四元数 slerp：最短弧、等角速度、单位长度 ──
{
  const q0 = [0, 0, 0, 1];
  const q1 = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
  const qm = E.quatSlerp(q0, q1, 0.5);
  const ang = 2 * Math.acos(Math.min(1, Math.abs(qm[3])));
  near(ang, Math.PI / 4, 1e-6, 'slerp 中点应为 45°');
  near(Math.hypot(qm[0], qm[1], qm[2], qm[3]), 1, 1e-9, 'slerp 结果应为单位四元数');
  // 反向四元数（-q 等价）应走最短弧，结果同 45° 而非 135°
  const qn = E.quatSlerp(q0, q1.map((x) => -x), 0.5);
  const ang2 = 2 * Math.acos(Math.min(1, Math.abs(qn[3])));
  near(ang2, Math.PI / 4, 1e-6, 'slerp 应取最短弧（负号等价）');
}

// ── ⑦ poseKeys 四元数通道：过帧精确 + 中点 slerp ──
{
  const q0 = [0, 0, 0, 1];
  const q1 = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
  const keys = [{ t: 0, bonePose: { 3: q0 } }, { t: 1, bonePose: { 3: q1 }, ease: 'linear' }];
  const at0 = E.interpolatePoseKeys(keys, 0)[3];
  const at1 = E.interpolatePoseKeys(keys, 1)[3];
  near(at0[3], 1, 1e-9, 'poseKeys：t=0 应精确为首帧');
  near(at1[3], q1[3], 1e-9, 'poseKeys：t=1 应精确为尾帧');
  const mid = E.interpolatePoseKeys(keys, 0.5)[3];
  const ang = 2 * Math.acos(Math.min(1, Math.abs(mid[3])));
  near(ang, Math.PI / 4, 1e-6, 'poseKeys：中点应为 45°');
  near(Math.hypot(mid[0], mid[1], mid[2], mid[3]), 1, 1e-9, 'poseKeys：中点应为单位四元数');
  // 3 分量欧拉仍走线性，且默认 smoothstep
  const ek = [{ t: 0, bonePose: { 1: [0, 0, 0] } }, { t: 1, bonePose: { 1: [1, 0, 0] } }];
  near(E.interpolatePoseKeys(ek, 0.5)[1][0], 0.5, 1e-9, 'poseKeys：欧拉默认线性中点应为 0.5');
  near(E.interpolatePoseKeys(ek, 0.25)[1][0], 0.25, 1e-9, 'poseKeys：欧拉默认线性 0.25 处应为 0.25');
  const ekSmooth = [{ t: 0, bonePose: { 1: [0, 0, 0] } }, { t: 1, bonePose: { 1: [1, 0, 0] }, ease: 'auto' }];
  near(E.interpolatePoseKeys(ekSmooth, 0.25)[1][0], 0.15625, 1e-9, 'poseKeys：显式 ease:auto 应走 smoothstep(0.25)=0.15625');
}

if (errs.length) {
  console.error('✗ Phase A 动画曲线测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ Phase A 通过：线性/贝塞尔（Blender fcurve_test 基准）/自动切线/缓动表/四元数 slerp/poseKeys 四元数');
process.exit(0);
