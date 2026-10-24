// 正式回归：骨骼姿态刚性（不再碎模）+ 路径绘制不锁视角 + 地面反算精度
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① 骨骼姿态必须走「局部旋转 + 重算链」（Blender pose_mat 语义），不能直接改蒙皮矩阵
ok(typeof E.boneMatricesWithPose === 'function', '缺少 boneMatricesWithPose');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8');
  ok(/local\[ni\]\.r = quatMul\(local\[ni\]\.r, q\)/.test(src), '姿态未叠加到骨骼局部旋转');
  ok(/b\.nodeIdx/.test(src), '未使用骨骼 nodeIdx 映射节点');
  ok(/b\.ibm/.test(src), '未使用骨骼 ibm（inverse bind）');
  // 姿态矩阵必须是刚性链：先算世界再乘 IBM
  ok(/jw\[r2\] \* ib\[c \* 4\]/.test(src), '蒙皮矩阵未按 jointWorld·IBM 计算');
}

// ② 数值验证：姿态不产生「碎块」（顶点位移应集中在被驱动的肢体，且 bbox 不爆炸）
{
  const packPath = path.join(ROOT, 'assets/director/models/xbot.json');
  if (fs.existsSync(packPath)) {
    const asset = E.decodeModelPack(JSON.parse(fs.readFileSync(packPath, 'utf8')));
    const rest = E.skinModel(asset, 'idle', 0, null, null, {});
    const maxRest = Math.max(...rest.pos.map((v) => Math.abs(v)));
    let bad = 0;
    for (const p of (E.BONE_POSES || [])) {
      if (p.id === 'none') continue;
      const pose = E.resolveBonePose(asset, p.id);
      if (!pose || !Object.keys(pose).length) continue;
      const sk = E.skinModel(asset, 'idle', 0, null, null, { bonePose: pose });
      // 位移统计
      let maxD = 0, moved = 0, nan = 0;
      for (let i = 0; i < sk.pos.length; i += 3) {
        const dx = sk.pos[i] - rest.pos[i], dy = sk.pos[i + 1] - rest.pos[i + 1], dz = sk.pos[i + 2] - rest.pos[i + 2];
        if (!isFinite(dx) || !isFinite(dy) || !isFinite(dz)) { nan++; continue; }
        const d = Math.hypot(dx, dy, dz);
        if (d > maxD) maxD = d;
        if (d > 0.01) moved++;
      }
      ok(nan === 0, '姿态 ' + p.id + ' 产生 NaN 顶点（' + nan + ' 个）');
      ok(moved > 0, '姿态 ' + p.id + ' 没有任何顶点移动（姿态无效）');
      // 爆炸判定：位移超过人体高度 3 倍 = 碎模
      ok(maxD < 1.78 * 3, '姿态 ' + p.id + ' 位移过大（' + maxD.toFixed(2) + 'm，疑碎模）');
      // bbox 不应显著膨胀
      const maxNow = Math.max(...sk.pos.map((v) => Math.abs(v)));
      ok(maxNow < maxRest * 3 + 3, '姿态 ' + p.id + ' 包围盒爆炸（' + maxNow.toFixed(2) + '）');
    }
  }
}

// ③ 路径绘制不锁视角：只拦左键
ok(/S\.directorPathPick && S\.directorSel && ev\.button === 0 && !ev\.altKey/.test(cli), '路径绘制必须只拦左键（否则右键环绕被吃、视角锁死）');
ok(/'正在画（点地面）'/.test(cli) || /dirPathDrawing/.test(cli), '缺少画路径状态提示');

// ④ 地面反算精度（点哪加哪）
{
  const W = 1280, H = 720;
  const cam = { pos: { x: 2, y: 2.2, z: 6 }, target: { x: 0, y: 0.9, z: 0 }, fov: 42, roll: 0 };
  let maxErr = 0;
  for (const p of [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -2, y: 0, z: -1.5 }]) {
    // 用引擎的精确投影（x 用 W/2、y 用 H/2）→ 与绘制/拾取同源
    const sp = E.directorScreenOf(cam, W, H, p);
    const sx = sp.x, sy = sp.y;
    const back = E.groundPointFromScreen(cam, W, H, sx, sy);
    maxErr = Math.max(maxErr, Math.hypot(back.x - p.x, back.z - p.z));
  }
  ok(maxErr < 1e-3, '地面反算误差过大（' + maxErr.toExponential(2) + '）');
}

if (errs.length) {
  console.error('✗ 姿态/路径测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 姿态/路径测试通过（局部旋转刚性链 / 无 NaN / 无碎模 / 路径只拦左键 / 地面反算精确）');
process.exit(0);
