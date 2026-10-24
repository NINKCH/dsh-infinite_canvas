// 正式回归：景别/镜头数学（对照 Blender ED_view3d_radius_to_dist_persp 与 camera.cc）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);

// ① Blender 公式一致性：ED_view3d_radius_to_dist_persp = radius / tan(angle/2)
{
  const radius = 2.5, fovDeg = 42;
  const expect = radius / Math.tan((fovDeg * Math.PI) / 180 / 2);
  ok(near(E.radiusToDist(fovDeg, radius), expect, 1e-6), 'radiusToDist 与 Blender 公式不一致');
}

// ② 焦距 ↔ FOV 互反
for (const lens of [18, 24, 35, 50, 85, 135]) {
  const fov = E.lensToFov(lens, 36, 16 / 9);
  const back = E.fovToLens(fov, 36, 16 / 9);
  ok(near(back, lens, 0.01), '焦距↔FOV 互反失败: ' + lens + 'mm');
}

// ③ 焦距语义：越长 FOV 越小
{
  const f18 = E.lensToFov(18, 36, 16 / 9);
  const f135 = E.lensToFov(135, 36, 16 / 9);
  ok(f135 < f18, '长焦 FOV 应该小于广角');
  ok(f18 > 50, '18mm 应为广角（垂直FOV > 50°）');
  ok(f135 < 15, '135mm 应为长焦（垂直FOV < 15°）');
}

// ④ 景别：8 档，占比递减
ok(E.SHOT_FILLS.length >= 8, '景别少于 8 档');
{
  let last = 1.1;
  for (const sf of E.SHOT_FILLS) {
    ok(sf.fill < last, '景别占比不是递减: ' + sf.id);
    last = sf.fill;
  }
}

// ⑤ 景别 → 距离 → 反算占比，误差 <3%
for (const sf of E.SHOT_FILLS) {
  const dist = E.shotDistance(42, 1.75, sf.fill);
  const back = E.subjectFillRatio(42, 1.75, dist);
  ok(Math.abs(back - sf.fill) < 0.03, '景别反算偏差过大: ' + sf.id + ' ' + (back * 100).toFixed(0) + '% vs ' + (sf.fill * 100).toFixed(0) + '%');
  ok(dist > 0, '景别距离应为正: ' + sf.id);
}

// ⑥ 焦距影响：同一景别，长焦距离更远
{
  const d18 = E.shotDistance(E.lensToFov(18, 36, 16 / 9), 1.75, 0.38);
  const d135 = E.shotDistance(E.lensToFov(135, 36, 16 / 9), 1.75, 0.38);
  ok(d135 > d18 * 3, '长焦拍同景别应该远得多');
}

// ⑦ 画幅四角：16:9 宽高比正确
{
  const cam = { pos: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 1 }, fov: 42, lens: 50, roll: 0 };
  const cs = E.cameraFrameWorld(cam, 16 / 9, 1.0);
  ok(cs.length === 4, '画幅应返回 4 个角');
  const w = Math.abs(cs[0].x - cs[2].x), h = Math.abs(cs[0].y - cs[2].y);
  ok(Math.abs(w / h - 16 / 9) < 0.01, '画幅宽高比不是 16:9，实际 ' + (w / h).toFixed(3));
}

// ⑧ sensor fit
ok(E.sensorFit('AUTO', 36, 24) === 'HOR', 'AUTO 横屏应 HOR');
ok(E.sensorFit('AUTO', 24, 36) === 'VERT', 'AUTO 竖屏应 VERT');

if (errs.length) {
  console.error('✗ 镜头数学测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 镜头数学测试通过（radius→dist / 焦距FOV互反 / 8档景别精度 / 画幅比例 / sensor fit）');
process.exit(0);
