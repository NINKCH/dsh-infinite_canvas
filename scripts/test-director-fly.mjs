// 键盘漫游（Lumion / D5 手感）数值回归：
//   W/S 前进后退（水平投影）、A/D 平移、Q/E 升降、Shift 加速、斜向不加速、
//   朝向不变、贴地钳制、dt 钳制（切后台不瞬移）
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, m + '（实际 ' + Number(a).toFixed(4) + '，期望 ' + Number(b).toFixed(4) + '）');

const cam = { pos: E.v3(0, 1.7, 5), target: E.v3(0, 1.7, 0), fov: 42 };
const DT = 1 / 60;
const step = (input, opts) => E.cameraFlyStep(cam, input, DT, Object.assign({ speed: 4 }, opts || {}));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

ok(typeof E.cameraFlyStep === 'function', '缺少 cameraFlyStep（客户端不得自己写位移公式）');

// ① W：沿视线水平投影前进，Δy = 0，步长 = speed*dt
{
  const r = step({ f: 1 });
  ok(!!r, 'W 应有位移');
  near(r.pos.z, cam.pos.z - 4 * DT, 1e-6, 'W 应沿 -Z 前进');
  near(r.pos.y, cam.pos.y, 1e-9, 'W 不应改变高度（升降交给 Q/E）');
  near(r.moved, 4 * DT, 1e-6, 'W 步长应等于 speed*dt');
}
// ② 俯视时按 W 不钻地：前向取水平投影
{
  const lookDown = { pos: E.v3(0, 5, 5), target: E.v3(0, 0, 0), fov: 42 };
  const r = E.cameraFlyStep(lookDown, { f: 1 }, DT, { speed: 4 });
  near(r.pos.y, lookDown.pos.y, 1e-9, '俯视按 W 不应下潜');
  ok(Math.abs(r.pos.z - lookDown.pos.z) > 1e-4 || Math.abs(r.pos.x - lookDown.pos.x) > 1e-4, '俯视按 W 仍应水平前进');
}
// ③ D：右移，且与前向点积 ≈ 0
{
  const r = step({ r: 1 });
  near(r.pos.x, cam.pos.x + 4 * DT, 1e-6, 'D 应向 +X 右移');
  near(r.pos.y, cam.pos.y, 1e-9, 'D 不应改变高度');
}
// ④ A/S 与 W/D 相反
{
  const a = step({ r: -1 }), d = step({ r: 1 });
  near(a.pos.x - cam.pos.x, -(d.pos.x - cam.pos.x), 1e-9, 'A 应与 D 反向');
  const w = step({ f: 1 }), s = step({ f: -1 });
  near(s.pos.z - cam.pos.z, -(w.pos.z - cam.pos.z), 1e-9, 'S 应与 W 反向');
}
// ⑤ Q/E：纯竖直
{
  const q = step({ u: -1 }), e = step({ u: 1 });
  near(q.pos.y, cam.pos.y - 4 * DT, 1e-6, 'Q 应下降');
  near(e.pos.y, cam.pos.y + 4 * DT, 1e-6, 'E 应上升');
  near(q.pos.x, cam.pos.x, 1e-9, 'Q 不应水平移动');
  near(q.pos.z, cam.pos.z, 1e-9, 'Q 不应水平移动');
}
// ⑥ 贴地钳制：一路 Q 到底，y 不低于 minY
{
  let c = { pos: E.v3(0, 0.2, 0), target: E.v3(0, 0.2, -1), fov: 42 };
  for (let i = 0; i < 120; i++) {
    const r = E.cameraFlyStep(c, { u: -1 }, 0.1, { speed: 4, minY: 0.15 });
    if (r) c = { pos: r.pos, target: r.target, fov: c.fov };
  }
  ok(c.pos.y >= 0.15 - 1e-9, 'Q 应贴地钳制在 minY（实际 ' + c.pos.y.toFixed(3) + '）');
}
// ⑦ Shift 加速 4×
{
  const n = step({ f: 1 }), f = step({ f: 1 }, { fast: true });
  near(f.moved / n.moved, 4, 1e-6, 'Shift 应加速 4×');
}
// ⑧ 斜向（W+D）不加速：模长与直行一致
{
  const straight = step({ f: 1 }), diag = step({ f: 1, r: 1 });
  near(diag.moved, straight.moved, 1e-6, '斜向不应比直行快');
}
// ⑨ 朝向不变：target-pos 方向不变
{
  const r = step({ f: 1, r: 1, u: 1 });
  const before = E.vNorm(E.vSub(cam.target, cam.pos));
  const after = E.vNorm(E.vSub(r.target, r.pos));
  near(E.vDot(before, after), 1, 1e-9, '平移后朝向应保持不变');
  // pos 与 target 位移同步
  near(r.pos.x - cam.pos.x, r.target.x - cam.target.x, 1e-9, 'pos/target 应同步平移 X');
  near(r.pos.y - cam.pos.y, r.target.y - cam.target.y, 1e-9, 'pos/target 应同步平移 Y');
}
// ⑩ dt 钳制：10 秒只走 0.1 秒的量
{
  const huge = E.cameraFlyStep(cam, { f: 1 }, 10, { speed: 4 });
  near(huge.moved, 4 * 0.1, 1e-6, 'dt 应钳制到 0.1s（切后台不瞬移）');
}
// ⑪ 无输入返回 null
ok(E.cameraFlyStep(cam, {}, DT, {}) === null, '无输入应返回 null');
ok(E.cameraFlyStep(cam, { f: 0, r: 0, u: 0 }, DT, {}) === null, '零输入应返回 null');

if (errs.length) {
  console.error('✗ 键盘漫游测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 键盘漫游通过（W/S 水平前后、A/D 平移、Q/E 升降贴地、Shift 4×、斜向不加速、朝向不变、dt 钳制）');
