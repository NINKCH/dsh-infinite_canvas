// 正式回归：姿态关键帧（poseKeys 随时间过渡）+ 轴约束（X/Y/Z 锁定）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① poseKeys 线性插值
{
  const keys = [
    { t: 0, bonePose: { 34: [0, 0, 0] } },
    { t: 2, bonePose: { 34: [0, 0, Math.PI / 2] } },
  ];
  const samples = [[0, 0], [0.5, 0.25], [1, 0.5], [1.5, 0.75], [2, 1]];
  for (const [t, ratio] of samples) {
    const p = E.interpolatePoseKeys(keys, t);
    const got = p[34][2] / (Math.PI / 2);
    ok(Math.abs(got - ratio) < 1e-6, 'poseKeys t=' + t + ' 插值比例应为 ' + ratio + '，实际 ' + got.toFixed(3));
  }
  // 越界夹取
  ok(Math.abs(E.interpolatePoseKeys(keys, -5)[34][2]) < 1e-6, '负时间应夹到首帧');
  ok(Math.abs(E.interpolatePoseKeys(keys, 99)[34][2] - Math.PI / 2) < 1e-6, '超时应在尾帧');
}

// ② 多骨骼同时插值
{
  const keys = [
    { t: 0, bonePose: { 10: [0, 0, 0], 20: [0, 0, 0] } },
    { t: 2, bonePose: { 10: [1, 0, 0], 20: [0, 0, 2] } },
  ];
  const p = E.interpolatePoseKeys(keys, 1);
  ok(Math.abs(p[10][0] - 0.5) < 1e-6 && Math.abs(p[20][2] - 1) < 1e-6, '多骨骼插值不正确');
}

// ③ 只在一帧出现的骨骼也要补 0
{
  const keys = [
    { t: 0, bonePose: { 10: [1, 1, 1] } },
    { t: 2, bonePose: { 20: [2, 2, 2] } },
  ];
  const p = E.interpolatePoseKeys(keys, 1);
  ok(p[10] && p[20], '两帧不同骨骼应合并');
  ok(Math.abs(p[10][0] - 0.5) < 1e-6, '消失的骨骼应向 0 过渡');
  ok(Math.abs(p[20][0] - 1) < 1e-6, '新出现的骨骼应从 0 过渡');
}

// ④ 退化：null / 空 / 单帧
ok(E.interpolatePoseKeys(null, 1) === null, 'null 应返回 null');
ok(E.interpolatePoseKeys([], 1) === null, '空数组应返回 null');
{
  const one = E.interpolatePoseKeys([{ t: 0, bonePose: { 5: [0.3, 0, 0] } }], 9);
  ok(one && Math.abs(one[5][0] - 0.3) < 1e-6, '单帧应原样返回');
}

// ⑤ applyPlayhead：poseKeys 覆盖静态 bonePose
{
  const scene = {
    version: 2,
    objects: [{ id: 'o', kind: 'model', pos: { x: 0, y: 0, z: 0 }, h: 1.7, visible: true,
      bonePose: { 34: [9, 9, 9] },
      poseKeys: [{ t: 0, bonePose: { 34: [0, 0, 0] } }, { t: 2, bonePose: { 34: [0, 0, 1] } }] }],
    cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fov: 42, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: 4 },
  };
  const r1 = E.applyPlayhead(scene, 1);
  ok(Math.abs(r1.objects[0].bonePose[34][2] - 0.5) < 1e-6, 'applyPlayhead 应用 poseKeys 插值（应 0.5）');
  ok(Math.abs(r1.objects[0].bonePose[34][0]) < 1e-6, '静态 bonePose 应被 poseKeys 覆盖');
}

// ⑥ UI 接线
ok(src.includes('dir-pose-key'), 'UI 缺少姿态关键帧按钮');
ok(src.includes('poseKeys'), 'UI 未写入 poseKeys');
ok(src.includes('dirAxisLocked'), 'UI 缺少轴约束');

// ⑦ 轴约束：拖拽中按 X/Y/Z 会改 axis
ok(/'xyz'\.includes\(String\(e\.key\)\.toLowerCase\(\)\)/.test(src), '轴约束未监听 x/y/z');
ok(/d\.mode = 'axis';/.test(src), '轴约束未切换到移动模式');

if (errs.length) {
  console.error('✗ 姿态关键帧/轴约束测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 姿态关键帧/轴约束测试通过（线性插值 / 多骨 / 骨骼增删 / 退化 / applyPlayhead 集成 / UI 入口 / 轴锁）');
process.exit(0);
