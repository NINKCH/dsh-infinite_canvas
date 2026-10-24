// 正式回归：运动路径样条（对照 Blender BKE_where_on_path / Follow Path 的 FOLLOW 语义）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const keys = [
  { t: 0, pos: { x: 0, y: 1, z: 5 } },
  { t: 2, pos: { x: 3, y: 1.5, z: 2 } },
  { t: 4, pos: { x: 0, y: 2, z: -2 } },
  { t: 6, pos: { x: -3, y: 1.5, z: 2 } },
];

// ① 端点精确：样条必须过首尾关键帧
{
  const s0 = E.samplePath(keys, 0);
  const s6 = E.samplePath(keys, 6);
  ok(Math.abs(s0.pos.x - 0) < 1e-6 && Math.abs(s0.pos.z - 5) < 1e-6, '样条 t=0 未过首关键帧');
  ok(Math.abs(s6.pos.x + 3) < 1e-6 && Math.abs(s6.pos.z - 2) < 1e-6, '样条 t=末 未过尾关键帧');
}

// ② 样条过所有控制点（Catmull-Rom 性质）
for (const k of keys) {
  const s = E.samplePath(keys, k.t);
  const d = Math.hypot(s.pos.x - k.pos.x, s.pos.y - k.pos.y, s.pos.z - k.pos.z);
  ok(d < 0.01, '样条未过控制点 t=' + k.t + ' 偏差 ' + d.toFixed(4));
}

// ③ 平滑性：相邻采样（0.1s 间隔）步长无突变
{
  let prev = null, maxJump = 0;
  for (let t = 0; t <= 6.0001; t += 0.1) {
    const s = E.samplePath(keys, t);
    if (prev) maxJump = Math.max(maxJump, Math.hypot(s.pos.x - prev.x, s.pos.y - prev.y, s.pos.z - prev.z));
    prev = s.pos;
  }
  ok(maxJump < 0.45, '样条不平滑：最大步进 ' + maxJump.toFixed(3) + 'm');
}

// ④ 切线方向 = 运动方向（点积为正）
for (const t of [0.5, 1.5, 3, 4.5]) {
  const s = E.samplePath(keys, t);
  const a = E.samplePath(keys, t + 0.25);
  const b = E.samplePath(keys, t - 0.25);
  const dot = s.tangent.x * (a.pos.x - b.pos.x) + s.tangent.y * (a.pos.y - b.pos.y) + s.tangent.z * (a.pos.z - b.pos.z);
  ok(dot > 0, '切线与运动方向相反 t=' + t);
  const len = Math.hypot(s.tangent.x, s.tangent.y, s.tangent.z);
  ok(Math.abs(len - 1) < 1e-3, '切线未归一化 t=' + t);
}

// ⑤ 时间越界：夹到 [0,1]（Blender CU_PATH_CLAMP 语义）
{
  const before = E.samplePath(keys, -1);
  const after = E.samplePath(keys, 100);
  ok(Math.abs(before.pos.z - 5) < 1e-6, '负时间应夹到起点');
  ok(Math.abs(after.pos.x + 3) < 1e-6, '超大时间应夹到终点');
}

// ⑥ cameraPathAt：curve 模式给 pos+target（FOLLOW）；line 模式返回 null（走折线逻辑）
{
  const cam = { keys, pathMode: 'curve' };
  const cp = E.cameraPathAt(cam, 3, 1.2);
  ok(cp && cp.pos && cp.target, 'curve 模式应返回 pos+target');
  const d = Math.hypot(cp.target.x - cp.pos.x, cp.target.y - cp.pos.y, cp.target.z - cp.pos.z);
  ok(Math.abs(d - 1.2) < 0.01, 'target 应在切线前方 1.2m，实际 ' + d.toFixed(3));
  ok(E.cameraPathAt({ keys, pathMode: 'line' }, 3) === null, 'line 模式应返回 null');
}

// ⑦ applyPlayhead 集成：curve 走样条、line 走折线（两点在同一时刻给出不同位置）
{
  const mk = (mode) => ({ version: 2, objects: [], cameras: [{ id: 'c', name: 'c', pos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 1 }, fov: 42, keys, pathMode: mode }], lights: [], env: {}, activeCameraId: 'c', shot: { duration: 6 } });
  const rc = E.applyPlayhead(mk('curve'), 3);
  const rl = E.applyPlayhead(mk('line'), 3);
  const diff = Math.hypot(rc.cameras[0].pos.x - rl.cameras[0].pos.x, rc.cameras[0].pos.z - rl.cameras[0].pos.z);
  ok(diff > 0.1, 'curve 与 line 在同一时刻应给出不同位置（差异 ' + diff.toFixed(3) + '）');
  ok(rc.cameras[0].target !== undefined, 'curve 模式应更新 target');
}

// ⑧ 单关键帧 / 空关键帧的退化处理
ok(E.samplePath([], 1) === null, '空关键帧应返回 null');
{
  const one = E.samplePath([{ t: 0, pos: { x: 1, y: 2, z: 3 } }], 5);
  ok(one && Math.abs(one.pos.x - 1) < 1e-6, '单关键帧应返回该点');
}

if (errs.length) {
  console.error('✗ 运动路径测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 运动路径测试通过（样条过控制点 / 平滑 / 切线=运动方向 / 时间夹取 / FOLLOW 前瞻 / 折线曲线分离 / 退化处理）');
process.exit(0);
