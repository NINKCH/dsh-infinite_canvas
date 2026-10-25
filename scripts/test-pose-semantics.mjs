// 正式回归：姿态语义正确性（不是"没有碎"而是"姿势对"）
//   arms_up: 双手高过头顶；crouch: 明显变矮；flip/fly: 身体近乎水平且重心下降；
//   punch: 有一只拳头在身体前方（+Z）且高度接近胸口；fight: 双手抬到胸/面高度。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const packPath = path.join(ROOT, 'assets/director/models/xbot.json');
if (!fs.existsSync(packPath)) { console.error('缺模型包，跳过'); process.exit(0); }
const asset = E.decodeModelPack(JSON.parse(fs.readFileSync(packPath, 'utf8')));

const skin = (poseId, clip) => E.skinModel(asset, clip || 'idle', 0, null, null, poseId ? { poseId } : {});
const bounds = (sk) => {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < sk.pos.length; i += 3) {
    const x = sk.pos[i], y = sk.pos[i + 1], z = sk.pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ, h: maxY - minY };
};
// 「双手/脚」的极值点
const extreme = (sk, axis, dir) => {
  let best = dir > 0 ? -1e9 : 1e9, pt = null;
  for (let i = 0; i < sk.pos.length; i += 3) {
    const v = sk.pos[i + axis];
    if (dir > 0 ? v > best : v < best) { best = v; pt = [sk.pos[i], sk.pos[i + 1], sk.pos[i + 2]]; }
  }
  return pt;
};

const rest = bounds(skin(null));
console.log('静止: 高=' + rest.h.toFixed(2) + ' maxY=' + rest.maxY.toFixed(2));

// ① 举双手：最高点必须明显高于静止（手举过头）
{
  const b = bounds(skin('arms_up'));
  ok(b.maxY > rest.maxY + 0.15, '举双手没举起来（maxY ' + b.maxY.toFixed(2) + ' vs rest ' + rest.maxY.toFixed(2) + '）');
  const top = extreme(skin('arms_up'), 1, +1);
  ok(top && Math.abs(top[0]) > 0.12, '举双手的最高点应在手的位置（横向有偏移），实际 x=' + (top ? top[0].toFixed(2) : '-'));
}

// ② 下蹲：整体高度明显降低
{
  const b = bounds(skin('crouch'));
  ok(b.h < rest.h * 0.93, '下蹲没有变矮（' + b.h.toFixed(2) + ' vs ' + rest.h.toFixed(2) + '）');
}

// ③ 空翻：团身——高度降低且重心抬高（悬空），膝盖收向躯干
{
  const sk = skin('flip');
  const b = bounds(sk);
  ok(b.h < rest.h * 0.9, '空翻没有团身（高 ' + b.h.toFixed(2) + '）');
  ok(b.minY > 0.25, '空翻应悬空（minY ' + b.minY.toFixed(2) + '）');
}

// ④ 飞行：身体接近水平（高度远小于静止、且比空翻更平）
{
  const b = bounds(skin('fly'));
  ok(b.h < rest.h * 0.75, '飞行身体没有放平（高 ' + b.h.toFixed(2) + '）');
  ok(b.minY > 0.2, '飞行应悬空（minY ' + b.minY.toFixed(2) + '）');
}

// ⑤ 出拳：一只拳明显前伸（+Z），另一只手护在下颌附近
{
  const sk = skin('punch');
  const front = extreme(sk, 2, +1);
  ok(front && front[2] > 0.45, '出拳的拳没有伸到身体前方（z=' + (front ? front[2].toFixed(2) : '-') + '）');
  ok(front && front[1] > 1.0 && front[1] < 1.85, '出拳的拳高应在胸肩之间（y=' + (front ? front[1].toFixed(2) : '-') + '）');
  // 护脸手：高位 + 贴近身体中线、且不靠前
  let guard = 0;
  for (let i = 0; i < sk.pos.length; i += 3) {
    const x = sk.pos[i], y = sk.pos[i + 1], z = sk.pos[i + 2];
    if (y > 1.45 && Math.abs(x) < 0.32 && z < 0.28) guard++;
  }
  ok(guard > 60, '出拳时应有一只手护在下颌前（命中顶点 ' + guard + '）');
}

// ⑥ 格斗架势：双拳抬到下颌附近，但都不向前外伸（护而不是伸）
{
  const sk = skin('fight');
  const b = bounds(sk);
  // 左右两侧各自的高位手部顶点
  let hiL = -1e9, hiR = -1e9;
  for (let i = 0; i < sk.pos.length; i += 3) {
    const x = sk.pos[i], y = sk.pos[i + 1], z = sk.pos[i + 2];
    if (y > 1.35 && Math.abs(x) > 0.10 && Math.abs(x) < 0.45 && z < 0.45) {
      if (x > 0) hiL = Math.max(hiL, y); else hiR = Math.max(hiR, y);
    }
  }
  ok(hiL > 1.4 && hiR > 1.4, '格斗架势双手都应抬到下颌附近（左 ' + hiL.toFixed(2) + ' / 右 ' + hiR.toFixed(2) + '）');
  ok(b.maxZ < 0.55, '格斗架势双手不应向前外伸（maxZ=' + b.maxZ.toFixed(2) + '）');
  // 前后脚分开（站架）
  ok(b.maxZ - b.minZ > 0.45, '格斗架势应有前后脚站架（Z 跨度 ' + (b.maxZ - b.minZ).toFixed(2) + '）');
}

// ⑦ 关键回归：姿态在「有动画」与「无动画」下都成立（之前 bug：动画一开姿态失效）
for (const id of ['arms_up', 'crouch', 'flip', 'fly']) {
  const withAnim = bounds(skin(id, 'idle'));
  const noAnim = bounds(skin(id, ''));
  ok(Math.abs(withAnim.h - noAnim.h) < 0.25, '姿态 ' + id + ' 在动画叠加下走样（h ' + withAnim.h.toFixed(2) + ' vs ' + noAnim.h.toFixed(2) + '）');
}

// ⑧ 打斗动作库（参考片段动作语义）：每个动作可解、脚落地、姿态有区分度
{
  const FIGHT_IDS = ['spear_ready', 'spear_thrust', 'palm_block', 'dodge_lean', 'dash_forward', 'grit_advance',
    'low_sweep', 'spear_ground', 'crouch_low', 'ult_charge', 'hit_recoil', 'knockdown'];
  const all = new Set(E.BONE_POSES.map((p) => p.id));
  for (const id of FIGHT_IDS) ok(all.has(id), '缺少打斗动作：' + id);
  const sigs = new Set();
  for (const id of FIGHT_IDS) {
    const sk = skin(id);
    const b = bounds(sk);
    ok(Number.isFinite(b.h) && b.h > 0.2, '动作 ' + id + ' 姿态无效（h=' + b.h + '）');
    // 脚落地：站立/蹲/落地类动作 minY 应贴近 0（倒地也贴地）
    ok(b.minY < 0.12, '动作 ' + id + ' 悬空（minY=' + b.minY.toFixed(3) + '）');
    // 姿态区分度：包围盒签名不应重复
    sigs.add([b.h.toFixed(2), b.maxZ.toFixed(2), (b.maxX - b.minX).toFixed(2)].join('/'));
  }
  ok(sigs.size >= FIGHT_IDS.length - 2, '打斗动作姿态区分度不足（' + sigs.size + '/' + FIGHT_IDS.length + '）');
  // 关键语义：突刺手在身前（Z 大）、格挡手高于肩、倒地极矮
  const thrust = bounds(skin('spear_thrust'));
  ok(thrust.maxZ > 0.5, '横枪突刺应有前伸的手（zmax=' + thrust.maxZ.toFixed(2) + '）');
  const block = bounds(skin('palm_block'));
  ok(block.maxY > rest.maxY * 0.98, '单掌格挡的手应抬到肩/头高度（maxY=' + block.maxY.toFixed(2) + '）');
  const down = bounds(skin('knockdown'));
  ok(down.h < rest.h * 0.65, '倒地应明显放低（h=' + down.h.toFixed(2) + '）');
}

if (errs.length) {
  console.error('✗ 姿态语义测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 姿态语义测试通过（基础姿态 + 打斗动作库 12 个：落地/前伸/格挡/倒地 + 动画叠加不走样）');
process.exit(0);
