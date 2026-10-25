// gizmo 几何/拾取回归（Node 数值级，无需浏览器）
//   ① 轴长在屏幕上恒为 105 CSS px（绘制=拾取的换算基准）
//   ② 三轴缩放手柄屏幕尺寸一致（Z 指向纵深也不能变形/变小）
//   ③ 拾取落在绘制像素上：轴端手柄、轴身中点都能一次点中
//   ④ 远处小物体有屏幕容差，可点选
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

const W = 800, H = 600;
const mkCam = (pos, target, fov = 40) => ({ id: 'c', pos, target, fov, keys: [] });
const mkSel = (pos = E.v3(0, 0, 0), extras = {}) => Object.assign({
  id: 's', kind: 'geom', preset: 'box', pos, scale: E.v3(1, 1, 1), h: 1.7, rotY: 0, visible: true,
}, extras);
// 用引擎的精确投影（x 用 W/2、y 用 H/2）——与绘制/拾取同源
const projectOf = (cam) => (p) => E.directorScreenOf(cam, W, H, p);
const pickGizmo = (cam, sel, sx, sy) =>
  E.directorPickGizmo({ objects: [sel], cameras: [cam], activeCameraId: 'c' }, sel.id, W, H, sx, sy);

// ── ① 轴长 = 105 CSS px（多种相机距离/角度）──
for (const cam of [
  mkCam(E.v3(0, 2, 6), E.v3(0, 0.9, 0)),
  mkCam(E.v3(0, 1.6, 2.5), E.v3(0, 1, 0), 55),
  mkCam(E.v3(5, 3, 7), E.v3(0, 0.8, 0), 35),
]) {
  const sel = mkSel();
  const gm = E.gizmoMetrics(cam, sel, H);
  const project = projectOf(cam);
  const ax = E.objectAxes(sel);
  const o = project(gm.origin);
  const viewFwd = E.vNorm(E.vSub(cam.target, cam.pos));
  for (const [name, dir] of [['x', ax.x], ['y', ax.y], ['z', ax.z]]) {
    const tip = project(E.vAdd(gm.origin, E.vMul(dir, gm.L)));
    const len = Math.hypot(tip.x - o.x, tip.y - o.y);
    const alongView = Math.abs(E.vDot(dir, viewFwd));
    if (alongView < 0.6) {
      // 屏面内的轴：必须严格 ≈105 CSS px（这是「画在哪、点哪」的基准）
      ok(len > 93 && len < 117, '轴 ' + name + ' 屏幕长度应为 105px 量级，实际 ' + len.toFixed(1));
    } else {
      // 接近视线的轴允许透视压缩（3D 软件通用），但必须仍可见、且轴端可点
      ok(len > 8, '轴 ' + name + ' 接近视线时仍应有可见长度，实际 ' + len.toFixed(1));
      const hitTip = pickGizmo(cam, sel, tip.x, tip.y);
      ok(hitTip && hitTip.axis === name, '接近视线的轴端仍应可点中 ' + name + '，实际 ' + JSON.stringify(hitTip));
    }
  }
}

// ── ② 三轴手柄屏幕尺寸一致（含 Z 正对相机）──
for (const cam of [
  mkCam(E.v3(0, 1.4, 5), E.v3(0, 0.9, 0)),
  mkCam(E.v3(0, 1.4, 5), E.v3(0, 1.4, 0)),       // 正对 -Z：Z 轴接近视线（最易变形的角度）
]) {
  const sel = mkSel();
  const gm = E.gizmoMetrics(cam, sel, H);
  const project = projectOf(cam);
  const cb = E.cameraBasis(cam);
  const ax = E.objectAxes(sel);
  const sizes = [];
  for (const [name, dir] of [['x', ax.x], ['y', ax.y], ['z', ax.z]]) {
    const tip = E.vAdd(gm.origin, E.vMul(dir, gm.L));
    const hs = gm.px.handle;
    const corners = [
      E.vAdd(tip, E.vAdd(E.vMul(cb.right, hs), E.vMul(cb.up, hs))),
      E.vAdd(tip, E.vAdd(E.vMul(cb.right, -hs), E.vMul(cb.up, hs))),
      E.vAdd(tip, E.vAdd(E.vMul(cb.right, -hs), E.vMul(cb.up, -hs))),
      E.vAdd(tip, E.vAdd(E.vMul(cb.right, hs), E.vMul(cb.up, -hs))),
    ].map(project);
    if (corners.some((c) => !c)) { ok(false, '手柄角点投影失败：' + name); continue; }
    const ws = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    const hsSize = Math.hypot(corners[0].x - corners[3].x, corners[0].y - corners[3].y);
    sizes.push({ name, w: ws, h: hsSize });
  }
  const avg = sizes.reduce((a, s) => a + (s.w + s.h) / 2, 0) / sizes.length;
  for (const s of sizes) {
    const d = Math.abs((s.w + s.h) / 2 - avg) / Math.max(1, avg);
    ok(d < 0.12, '手柄 ' + s.name + ' 与其它轴尺寸差 ' + (d * 100).toFixed(1) + '%（应同形同大小）');
  }
}

// ── ③ 拾取与绘制重合：轴端 / 轴身 ──
{
  const cam = mkCam(E.v3(0, 2, 6), E.v3(0, 0.9, 0));
  const sel = mkSel();
  const gm = E.gizmoMetrics(cam, sel, H);
  const project = projectOf(cam);
  const ax = E.objectAxes(sel);
  for (const [name, dir] of [['x', ax.x], ['y', ax.y], ['z', ax.z]]) {
    const tipW = E.vAdd(gm.origin, E.vMul(dir, gm.L));
    const tip = project(tipW);
    const atTip = pickGizmo(cam, sel, tip.x, tip.y);
    ok(atTip && atTip.op === 'scale' && atTip.axis === name, '点在手柄中心应命中 ' + name + ' 缩放手柄，实际 ' + JSON.stringify(atTip));
    const off10 = pickGizmo(cam, sel, tip.x + 10, tip.y);
    ok(off10 && off10.axis === name, '手柄中心偏 10px 仍应命中 ' + name + '（容差 14px），实际 ' + JSON.stringify(off10));
    // 轴身中点
    const midW = E.vAdd(gm.origin, E.vMul(dir, gm.L * 0.45));
    const mid = project(midW);
    const atMid = pickGizmo(cam, sel, mid.x, mid.y);
    ok(atMid && atMid.axis === name, '点在轴身中点应命中 ' + name + ' 移动，实际 ' + JSON.stringify(atMid));
  }
}

// ── ④ 远处小物体容差 ──
{
  const cam = mkCam(E.v3(0, 1.6, 4), E.v3(0, 1, 0));
  const ob = { id: 'tiny', kind: 'geom', preset: 'box', pos: E.v3(0, 1, -12), scale: E.v3(0.12, 0.12, 0.12), visible: true };
  const scene = { objects: [ob], cameras: [cam], activeCameraId: 'c' };
  const project = projectOf(cam);
  const c = project(E.v3(0, 1, -12));
  ok(!!c, '远处物体应可投影');
  if (c) {
    const onCenter = E.directorPickObject(scene, W, H, c.x, c.y);
    ok(onCenter && onCenter.id === 'tiny', '远处小物体中心应可选中');
    const off6 = E.directorPickObject(scene, W, H, c.x + 6, c.y, { tol: 10 });
    ok(off6 && off6.id === 'tiny', '远处小物体偏 6px 应可选中（屏幕容差）');
    const off40 = E.directorPickObject(scene, W, H, c.x + 40, c.y, { tol: 10 });
    ok(!off40, '超出容差不应误选');
  }
}

// ── ⑤ 拾取/绘制同源：不允许再出现「各自算一套尺寸」──
{
  const src = await import('node:fs').then((m) => m.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8'));
  ok(/export function gizmoMetrics/.test(src), '缺少 gizmoMetrics 单一尺寸来源');
  ok((src.match(/gizmoMetrics\(/g) || []).length >= 3, 'gizmoMetrics 应被定义并同时用于绘制与拾取');
  ok(!/const pxWorld = pixelSizeAt\(cam, h, depth\)/.test(src), 'gizmo 尺寸不得再用设备像素 h 计算');
  ok(/vMul\(CB\.right, hs\)/.test(src) && /vMul\(CB\.up, hs\)/.test(src), '手柄必须用相机基向量（屏向方块），否则 Z 轴会变形/变小');
  ok(/轴端缩放手柄最后画/.test(src), '手柄必须最后绘制（否则会被旋转环盖住）');
}

// ── ⑤b 轴心与朝向（用户明确判定，回归红线）──
// 规则：
//   1) 轴心 = **物体自身坐标系原点**（人物是脚底中心），不随姿态/髋高上浮 → 不许悬空；
//   2) 轴朝向跟随物体旋转（objectAxes），不是固定世界坐标；
//   3) 人物倒地后 z 轴仍指向「头的方向」，不是世界天顶。
{
  const gmCam = mkCam(E.v3(0, 1.5, 5), E.v3(0, 0.9, 0));

  // 1) 站立：poseCenterY ≈ 1.04，但轴心必须仍在 y=0（脚底）
  const standing = { id: 's', pos: E.v3(1, 0, 2), h: 1.7, rx: 0, rotY: 0, rz: 0, poseCenterY: 1.04 };
  const gStand = E.gizmoMetrics(gmCam, standing, H);
  ok(Math.abs(gStand.origin.y - 0) < 1e-6,
    '站立时轴心必须在物体原点 y=0（脚底中心），实际 y=' + gStand.origin.y);
  ok(Math.abs(gStand.origin.x - 1) < 1e-6 && Math.abs(gStand.origin.z - 2) < 1e-6,
    '轴心水平位置必须等于物体 pos');

  // 2) 倒地：poseCenterY ≈ 0.34，轴心仍必须在 y=0
  const fallen = { id: 'f', pos: E.v3(0, 0, 0), h: 1.7, rx: Math.PI / 2, rotY: 0, rz: 0, poseCenterY: 0.34 };
  const gFall = E.gizmoMetrics(gmCam, fallen, H);
  ok(Math.abs(gFall.origin.y - 0) < 1e-6,
    '倒地时轴心仍必须在物体原点 y=0，不得抬到髋高，实际 y=' + gFall.origin.y);

  // 3) 朝向跟随物体：绕 x 转 90° 后，物体自身 z 轴离开世界 +Z（证明不是世界坐标）
  const axF = E.objectAxes(fallen);
  ok(Math.abs(axF.z.z) < 1e-6 && Math.abs(Math.abs(axF.z.y) - 1) < 1e-6,
    '倒地后物体 z 轴应离开世界 +Z（转到 ±Y，即头的朝向），实际 ' + JSON.stringify(axF.z));
  // 未旋转时 z 轴即世界 +Z
  const axS = E.objectAxes({ pos: E.v3(0, 0, 0), rx: 0, rotY: 0, rz: 0 });
  ok(Math.abs(axS.z.z - 1) < 1e-6, '未旋转时 z 轴应等于世界 +Z，实际 ' + JSON.stringify(axS.z));

  // 4) 绕 y 转 90° 后，物体的 x 轴不再等于世界 x（证明不是世界坐标）
  const turned = E.objectAxes({ pos: E.v3(0, 0, 0), rx: 0, rotY: Math.PI / 2, rz: 0 });
  ok(Math.abs(turned.x.x) < 1e-6 && Math.abs(Math.abs(turned.x.z) - 1) < 1e-6,
    '绕 Y 旋转 90° 后物体 x 轴应转到世界 ±Z（轴跟随物体，不是世界坐标），实际 ' + JSON.stringify(turned.x));

  // 5) 源码级：默认 origin 不得再叠加 poseCenterY（只能出现在 followBody 分支里）
  const engSrc = await import('node:fs').then((m) => m.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8'));
  ok(/const origin = originOverride \|\| v3\(sel\.pos\.x, sel\.pos\.y, sel\.pos\.z\);/.test(engSrc),
    'gizmoMetrics 默认 origin 必须是 (pos.x, pos.y, pos.z)，不得叠加 poseCenterY');
  const poseHits = (engSrc.match(/sel\.pos\.y \+ \(Number\(sel\.poseCenterY\) \|\| 0\)/g) || []).length;
  ok(poseHits >= 1 && poseHits <= 3, 'poseCenterY 只能出现在 followBody 分支与拾取同源分支里，实际 ' + poseHits + ' 处');
}

// ── ⑥ 框选灵敏：包围盒相交即选中（宽物体框住一半也算），隐藏/框外不选 ──
{
  const cam = mkCam(E.v3(0, 2.2, 7), E.v3(0, 1, 0));
  const scene = {
    objects: [
      { id: 'wide', kind: 'geom', preset: 'box', pos: E.v3(0, 0.5, 0), scale: E.v3(6, 1, 2), visible: true },
      { id: 'off', kind: 'geom', preset: 'box', pos: E.v3(40, 0.5, 0), scale: E.v3(1, 1, 1), visible: true },
      { id: 'hid', kind: 'geom', preset: 'box', pos: E.v3(0, 0.5, 0), scale: E.v3(2, 1, 2), visible: false },
    ],
    cameras: [cam], activeCameraId: 'c',
  };
  const project = projectOf(cam);
  const c = project(E.v3(0, 1, 0));
  ok(!!c, '宽物体应可投影');
  if (c) {
    // 只框住宽物体右半部分（中心在框外）→ 仍应命中
    const right = E.objectsInRect(scene, W, H, c.x + 4, c.y - 20, c.x + 80, c.y + 20);
    ok(right.includes('wide'), '框住宽物体一半也应选中（实际 ' + JSON.stringify(right) + '）');
    // 完全在框外 → 不选
    const none = E.objectsInRect(scene, W, H, 5, 5, 40, 40);
    ok(!none.includes('wide'), '框外不应选中宽物体');
    // 隐藏对象永不入选
    const all = E.objectsInRect(scene, W, H, 0, 0, W, H);
    ok(!all.includes('hid'), '隐藏对象不应被框选');
  }
}

// ── ⑦ 源码契约：Alt+缩放手柄 必须先于 orbit；框选不再要求「未选中」 ──
{
  const fsmod = await import('node:fs');
  const cli = fsmod.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const iAlt = cli.indexOf('Alt+左键按在');
  const iOrbit = cli.indexOf('右键（或中键）= 环绕旋转');
  ok(iAlt > 0 && iOrbit > iAlt, 'Alt+缩放手柄判定必须早于 orbit 分支（否则等比缩放永远不生效）');
  const iBox = cli.indexOf('框选 / 增量点选');
  const iGiz = cli.indexOf('if (g && startGizmoDrag(g, false');
  ok(iBox > 0 && iGiz > iBox, '框选分支必须在普通 gizmo 分支之前');
  ok(!/&& !S\.directorSel\) \{\s*\n\s*setBoxSel/.test(cli), '框选不应再要求「未选中」（否则选中后无法再框选）');
  ok(/boxToggleSel\(d\.hitId\)/.test(cli), 'Ctrl/Shift+点对象应切换选中');
  ok(/objectsInRect\(S\.directorLiveScene \|\| scene/.test(cli), '框选判定必须用 live 场景（路径对象位置才对）');
  const boxCss = (cli.match(/\.dshic-dir-boxsel\{[^}]*\}/) || [''])[0];
  ok(/rgba\(64,140,255,/.test(boxCss) && /rgba\(96,164,255,/.test(boxCss), '框选框应为显式蓝色半透明');
  ok(!/var\(--dsw-alias-brand-primary\)/.test(boxCss), '框选框不应依赖未定义的 --dsw 变量（会变黑边）');
}

if (errs.length) {
  console.error('✗ gizmo 几何/拾取测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ gizmo 几何/拾取通过（轴长 105px / 三轴手柄同形 / 手柄与轴身一次点中 / 远处容差 / 尺寸单一来源）');
