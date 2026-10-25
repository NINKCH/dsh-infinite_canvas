// Phase B 回归：双四元数蒙皮（DQS）
//   ① 单点蒙皮：±60° 双骨混合时 LBS 会塌陷、DQS 保持半径（DLB 语义）
//   ② mat4 → 双四元数 → 点变换，与矩阵变换逐点一致
//   ③ 真实 xbot 网格：单骨顶点 DQS 输出 == 同路径骨骼矩阵的双四元数直算；
//      'kick' 姿态下混合权重顶点对的保形误差 DQS 优于 LBS
//   ④ 规格透传：characters[].skinning → buildStageFromSpec / compileStageSpec
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const near = (a, b, eps, m) => { if (!(Math.abs(Number(a) - Number(b)) <= eps)) errs.push(m + '（实际 ' + a + ' / 期望 ' + b + '）'); };

// ── ① 单点蒙皮：两骨各 ±60°，权重各半 ──
{
  const ang = Math.PI / 3;
  const mat = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // 列主序，绕 Z
  };
  const mats = new Float32Array([...mat(ang), ...mat(-ang)]);
  const p = [0.5, 0, 0];
  const lbs = E.skinPointWithMats(mats, [0, 1, 0, 0], [0.5, 0.5, 0, 0], p, 2, 'lbs');
  const dqs = E.skinPointWithMats(mats, [0, 1, 0, 0], [0.5, 0.5, 0, 0], p, 2, 'dqs');
  near(Math.hypot(lbs[0], lbs[1], lbs[2]), 0.25, 1e-6, 'LBS 在 ±60° 双骨混合下应塌陷到半径 0.25');
  near(Math.hypot(dqs[0], dqs[1], dqs[2]), 0.5, 1e-5, 'DQS 应保持半径 0.5（不塌陷）');
}

// ── ② mat4 → 双四元数 → 点变换 与 矩阵变换一致 ──
{
  // 刚体矩阵：绕 Y 轴 45° + 平移（列主序）
  const ang = Math.PI / 4, ca = Math.cos(ang), sa = Math.sin(ang);
  const m = [
    ca, 0, -sa, 0,
    0, 1, 0, 0,
    sa, 0, ca, 0,
    1.3, -0.4, 2.1, 1,
  ];
  const dq = E.mat4ToDualQuat(m);
  for (const p of [[0, 0, 0], [1, 2, 3], [-0.7, 0.2, 1.1]]) {
    const mtx = [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
    const dqp = E.dqTransformPoint(dq.r, dq.d, p);
    for (let i = 0; i < 3; i++) near(dqp[i], mtx[i], 1e-6, '双四元数点变换应与矩阵一致（轴 ' + i + '）');
  }
}

// ── ③ 真实 xbot 网格 ──
{
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
  const asset = E.registerGltfAsset('xbot-dqs-test', E.decodeModelPack(pack));
  const preset = E.BONE_POSES.find((p) => p.id === 'kick');
  ok(!!preset, '应能找到 kick 姿态定义');
  // 与 skinModel 内部同路径：先设置同一个 clip（_anim），再用 dirs/base 求解
  asset._anim = asset.clipByName('idle');
  const mats = E.boneMatricesWithPose(asset, 0.3, null, preset ? preset.dirs : [], preset ? preset.base : null, preset ? (preset.rootY || 0) : 0);
  ok(!!(mats && mats.mats), '应产出骨骼矩阵');

  const skin = (pose, mode) => E.skinModel(asset, 'idle', 0.3, null, null, { poseId: pose, skinning: mode });
  const lbs = skin('kick', 'lbs');
  const dqs = skin('kick', 'dqs');
  ok(lbs.pos.length === dqs.pos.length && lbs.pos.length > 0, '两种蒙皮应输出同样长度');
  let finite = true, diff = 0;
  for (let i = 0; i < dqs.pos.length; i++) {
    if (!Number.isFinite(dqs.pos[i])) { finite = false; break; }
    if (Math.abs(lbs.pos[i] - dqs.pos[i]) > 1e-7) diff++;
  }
  ok(finite, 'DQS 输出应全部为有限数值');
  ok(diff > 0, 'DQS 与 LBS 结果应不同（否则分支未生效）');

  // 驱动一致性：skinModel 的 DQS 输出应等于「参考实现 skinPointWithMats」对同一顶点/权重/矩阵的结果
  const P = asset.positions, J = asset.joints, W = asset.weights;
  const nb = asset.bones ? asset.bones.length : 0;
  let checked = 0, maxErr = 0;
  for (let v = 0; v < P.length / 3 && checked < 60; v += 3) {
    const joints = [J[v * 4], J[v * 4 + 1], J[v * 4 + 2], J[v * 4 + 3]];
    const weights = [W[v * 4], W[v * 4 + 1], W[v * 4 + 2], W[v * 4 + 3]];
    if (!(weights[0] > 0.5)) continue;   // 只挑主权重明显的顶点
    const want = E.skinPointWithMats(mats.mats, joints, weights, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], nb, 'dqs');
    const got = [dqs.pos[v * 3], dqs.pos[v * 3 + 1], dqs.pos[v * 3 + 2]];
    maxErr = Math.max(maxErr, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]), Math.abs(got[2] - want[2]));
    checked++;
  }
  ok(checked >= 5, '应至少有若干顶点用于一致性校验（实际 ' + checked + '）');
  // 注意：skinModel 末尾还会执行 applyBodyShape（体形微调），因此与纯蒙皮参考实现存在 ~1e-3 级差异
  ok(maxErr < 5e-3, 'skinModel 的 DQS 输出应与 skinPointWithMats 参考实现一致（含体形微调；maxErr=' + maxErr.toExponential(2) + '）');

  // 保形：混合权重顶点对（关节区）的相对长度误差，DQS 应优于 LBS
  const mixed = [];
  for (let v = 0; v < P.length / 3; v++) {
    let cnt = 0;
    for (let k = 0; k < 4; k++) if ((W[v * 4 + k] || 0) > 0.001) cnt++;
    if (cnt >= 2) mixed.push(v);
  }
  const pairs = [];
  for (let i = 0; i < mixed.length && pairs.length < 300; i += 5) {
    const v = mixed[i];
    for (let j = i + 1; j < Math.min(mixed.length, i + 30); j += 3) {
      const u = mixed[j];
      const d0 = Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
      if (d0 > 0.01 && d0 < 0.05) { pairs.push([v, u, d0]); break; }
    }
  }
  const relErr = (src) => {
    let sum = 0;
    for (const [v, u, d0] of pairs) {
      const d = Math.hypot(src[u * 3] - src[v * 3], src[u * 3 + 1] - src[v * 3 + 1], src[u * 3 + 2] - src[v * 3 + 2]);
      sum += Math.abs(d - d0) / d0;
    }
    return pairs.length ? sum / pairs.length : 1;
  };
  ok(pairs.length >= 20, '应有足够的关节区顶点对（实际 ' + pairs.length + '）');
  const eL = relErr(lbs.pos), eD = relErr(dqs.pos);
  ok(eD <= eL, 'DQS 关节保形应不劣于 LBS（' + eD.toFixed(4) + ' vs ' + eL.toFixed(4) + '）');
}

// ── ④ 规格透传 ──
{
  const sc = E.buildStageFromSpec({ characters: [{ name: '甲', skinning: 'dqs' }, { name: '乙', skinning: '乱写' }] });
  ok(sc.objects[0].skinning === 'dqs', 'buildStageFromSpec 应写入合法 skinning');
  ok(!sc.objects[1].skinning, '非法 skinning 应被忽略');
  const back = E.compileStageSpec(sc);
  ok(back.characters[0].skinning === 'dqs', 'compileStageSpec 应回写 skinning');
}

if (errs.length) {
  console.error('✗ Phase B DQS 测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ Phase B 通过：DQS 不塌陷 / 矩阵一致 / xbot 单骨一致 / 关节保形不劣于 LBS / 规格透传');
process.exit(0);
