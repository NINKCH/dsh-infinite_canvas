// 正式回归：循环动作（走/跑 两相位）+ 路径点编辑（拾取/拖动语义）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ── ① 预设动作片段已移除（改由用户自建动作）──
{
  ok(!E.ACTION_SEQUENCES, '预设动作片段应已移除');
}

// ── ② 路径点编辑 ──
{
  const scene = {
    version: 2,
    objects: [{ id: 'o', kind: 'geom', preset: 'box', pos: { x: 0, y: 0, z: 0 }, h: 1.7, visible: true,
      pathOrigin: { x: 0, y: 0, z: 0 }, pathMode: 'linear',
      path: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }] }],
    cameras: [{ id: 'c', pos: { x: 1.5, y: 3, z: 6 }, target: { x: 1.5, y: 0.8, z: 0 }, fov: 45, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: 3 },
  };
  ok(typeof E.directorPickPathPoint === 'function', '缺少 directorPickPathPoint');
  const W = 800, H = 600, cam = scene.cameras[0];
  const proj = (p) => E.directorScreenOf(cam, W, H, p);   // 与引擎绘制/拾取同源
  const target = scene.objects[0].path[1];
  const sp = proj({ x: target.x, y: target.y + 0.02, z: target.z });
  ok(!!sp, '路径点应能投影到屏幕');
  if (sp) {
    const hit = E.directorPickPathPoint(scene, W, H, sp.x, sp.y, 18);
    ok(hit && hit.objId === 'o' && hit.index === 1, '应按屏幕位置选中第 2 个路径点，实际 ' + JSON.stringify(hit));
    // 给屏幕坐标后能反投影回地面（拖动语义）
    const gp = E.groundPointFromScreen(cam, W, H, sp.x, sp.y);
    ok(!!gp, 'groundPointFromScreen 应返回地面点');
    if (gp) ok(Math.abs(gp.x - target.x) < 0.35 && Math.abs(gp.z - target.z) < 0.35, '反投影应接近原点位（' + (gp && gp.x.toFixed(2)) + ', ' + (gp && gp.z.toFixed(2)) + '）');
    // 偏离时不应命中
    const miss = E.directorPickPathPoint(scene, W, H, sp.x + 60, sp.y + 60, 18);
    ok(!miss, '远离路径点不应命中');
  }
}

// ── ③ UI 入口 ──
{
  const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(cli.includes("mode: 'pathpoint'"), '缺少路径点拖拽模式');
  ok(cli.includes("'data-action': 'dir-path-del-point'"), '缺少删除路径点按钮');
  ok(cli.includes('directorPickPathPoint'), '客户端未调用路径点拾取');
  ok(/pathSel: S\.directorPathSel/.test(cli), '绘制未传路径点高亮');
}

if (errs.length) {
  console.error('✗ 循环动作/路径点编辑测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 路径点编辑测试通过（拾取/反投影/远离不命中 + UI 入口 + 预设片段已移除）');
process.exit(0);
