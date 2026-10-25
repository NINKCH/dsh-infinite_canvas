// Phase D 回归：BVH 解析 → rest-delta 重定向 → 动作层混合（NLA-lite）
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const near = (a, b, eps, m) => { if (!(Math.abs(Number(a) - Number(b)) <= eps)) errs.push(m + '（实际 ' + a + ' / 期望 ' + b + '）'); };
const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(Number(q[3]))));
const deg = (q) => (angleOf(q) * 180) / Math.PI;
const axisOf = (q) => {
  const s = Math.sin(angleOf(q) / 2) || 1e-9;
  return [q[0] / s, q[1] / s, q[2] / s];
};

// ── ① BVH 解析 ──
const BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 3 Zrotation Xrotation Yrotation
  JOINT Spine
  {
    OFFSET 0 10 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 12 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.033333
0 0 0 0 0 0
90 0 0 0 0 0
0 0 0 0 0 0
`;
{
  const bvh = E.parseBVH(BVH);
  ok(Array.isArray(bvh.joints) && bvh.joints.length >= 2, 'BVH 应解析出至少 2 个关节');
  const hips = bvh.joints.find((j) => j.name === 'Hips');
  ok(!!hips && hips.channels.length === 3 && hips.channels[0] === 'Zrotation', 'Root 的通道应解析为 Zrotation/Xrotation/Yrotation');
  ok(Math.abs(bvh.frameTime - 0.033333) < 1e-9, 'Frame Time 应解析');
  ok(bvh.frames.length === 3, '应解析出 3 帧（实际 ' + bvh.frames.length + '）');
  const spine = bvh.joints.find((j) => j.name === 'Spine');
  ok(!!spine && spine.parent === bvh.joints.indexOf(hips), 'Spine 的父关节应为 Hips');
  // 单关节旋转
  const q = E.bvhJointLocalQuat(hips, bvh.frames[1], 0);
  near(deg(q), 90, 1e-6, 'Zrotation 90° 应解析为 90° 旋转');
  ok(Math.abs(Math.abs(axisOf(q)[2]) - 1) < 1e-6, '旋转轴应为 Z');
}

// ── ② rest-delta 重定向到 xbot ──
{
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
  const asset = E.registerGltfAsset('xbot-bvh-test', E.decodeModelPack(pack));
  const bvh = E.parseBVH(BVH);
  const rt = E.retargetBVH(asset, bvh);
  ok(Array.isArray(rt.poseKeys) && rt.poseKeys.length === 3, '重定向应产出 3 帧 poseKeys（实际 ' + (rt.poseKeys || []).length + '）');
  near(rt.duration, 3 * 0.033333, 1e-6, '重定向时长应等于帧数 × Frame Time');
  const hipsBi = asset.bones.findIndex((b) => String(b.name).replace(/^mixamorig:?/i, '') === 'Hips');
  ok(hipsBi >= 0, '应能映射到 Hips 骨骼');
  const mid = rt.poseKeys[1].bonePose[hipsBi];
  ok(!!mid, '第 2 帧应含 Hips 姿态');
  near(deg(mid), 90, 1e-3, '重定向后 Hips 应保留 90° 旋转（rest 近似单位四元数）');
  // 未匹配关节应被跳过而不是报错
  const bad = E.retargetBVH(asset, { joints: [{ name: 'NoSuchBone', parent: -1, offset: [0, 0, 0], channels: ['Zrotation'] }], frames: [[45]], frameTime: 0.1 });
  ok(Array.isArray(bad.poseKeys) && bad.poseKeys.length === 0, '未匹配骨骼应跳过（不产出 poseKeys）');
}

// ── ③ 动作层混合 ──
{
  const zq = (d) => [0, 0, Math.sin((d * Math.PI) / 360), Math.cos((d * Math.PI) / 360)];
  const clipA = { keys: [{ t: 0, bonePose: { 5: zq(20) } }, { t: 1, bonePose: { 5: zq(20) } }], blend: 'replace', influence: 1 };
  const clipB = { keys: [{ t: 0, bonePose: { 5: zq(40) } }, { t: 1, bonePose: { 5: zq(40) } }], blend: 'add', influence: 0.5 };
  const base = E.sampleClips(null, [clipA], 0.5);
  near(deg(base[5]), 20, 1e-6, 'replace 层应得到 20°');
  const mixed = E.sampleClips(null, [clipA, clipB], 0.5);
  near(deg(mixed[5]), 40, 1e-4, 'add 层 40°×0.5 应叠加到 20° → 40°（实际 ' + deg(mixed[5]).toFixed(2) + '）');
  // loop：t=1.5 在 1s 周期内应回绕到 0.5 → 20°
  const looped = E.sampleClips(null, [{ ...clipA, loop: true, t0: 0, t1: 1 }], 1.5);
  near(deg(looped[5]), 20, 1e-4, 'loop 层应回绕取样');
  // influence=0.5 的 replace 应从 identity 混到一半
  const half = E.sampleClips(null, [{ ...clipA, influence: 0.5, blend: 'replace' }], 0.5);
  near(deg(half[5]), 10, 1e-4, 'replace influence 0.5 应得到 10°');
}

// ── ④ 接入姿态管线：opts.clips 生效 ──
{
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
  const asset = E.registerGltfAsset('xbot-bvh-test2', E.decodeModelPack(pack));
  const hipsBi = asset.bones.findIndex((b) => String(b.name).replace(/^mixamorig:?/i, '') === 'Hips');
  const hipsNode = asset.bones[hipsBi].nodeIdx;
  const local0 = E.applyBonePoseToLocal(asset, 0, null, null, null, 0, null);
  const r0 = local0[hipsNode].r.slice();
  const clip = { keys: [{ t: 0, bonePose: { [hipsBi]: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)] } }, { t: 1, bonePose: { [hipsBi]: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)] } }], blend: 'replace', influence: 1 };
  const local1 = E.applyBonePoseToLocal(asset, 0, null, null, null, 0, { clips: [clip] });
  const r1 = local1[hipsNode].r;
  const dq = [r1[0] - r0[0], r1[1] - r0[1], r1[2] - r0[2], r1[3] - r0[3]];
  ok(Math.hypot(dq[0], dq[1], dq[2], dq[3]) > 0.1, 'opts.clips 应改变 Hips 局部旋转');
}

// ── ⑤ 规格透传 ──
{
  const spec = {
    characters: [{
      name: '甲',
      clips: [
        { keys: [{ t: 0, bonePose: { 5: [0, 0, 0, 1] } }], blend: 'add', influence: 0.5, loop: true },
        { keys: [] },
      ],
    }],
  };
  const sc = E.buildStageFromSpec(spec);
  const ob = sc.objects[0];
  ok(Array.isArray(ob.clips) && ob.clips.length === 1, '空 keys 的 clip 应被过滤');
  ok(ob.clips[0].blend === 'add' && ob.clips[0].loop === true, 'clip 参数应保留');
  const back = E.compileStageSpec(sc);
  ok(Array.isArray(back.characters[0].clips) && back.characters[0].clips.length === 1, 'compileStageSpec 应回写 clips');
}

if (errs.length) {
  console.error('✗ Phase D BVH/动作层测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ Phase D 通过：BVH 解析 / rest-delta 重定向 / 动作层 replace·add·loop·influence / 姿态管线接入 / 规格透传');
process.exit(0);
