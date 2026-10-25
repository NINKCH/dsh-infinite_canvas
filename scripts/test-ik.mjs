// Phase C 回归：两骨解析 IK + 约束（damped_track / copy_rotation / limit_rotation）
// 全部在「节点空间（米）」验证：applyBonePoseToLocal → localWorldMatrices
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const near = (a, b, eps, m) => { if (!(Math.abs(Number(a) - Number(b)) <= eps)) errs.push(m + '（实际 ' + a + ' / 期望 ' + b + '）'); };
const V = E.v3;
const len = (v) => Math.hypot(v.x, v.y, v.z);
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a, k) => V(a.x * k, a.y * k, a.z * k);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => mul(a, 1 / (len(a) || 1));

// ── ① 解析解几何自洽 ──
{
  const j0 = V(0, 0, 0), j1 = V(0.5, 0, 0), j2 = V(0.5, 0, -0.5);
  const L1 = len(sub(j1, j0)), L2 = len(sub(j2, j1));
  const target = V(0.3, 0.2, -0.4);
  const [ud, ld] = E.solveTwoBoneDirs(j0, j1, j2, target, V(0.5, 0.3, -0.2));
  near(len(ud), 1, 1e-9, '根骨方向应为单位向量');
  near(len(ld), 1, 1e-9, '中间骨方向应为单位向量');
  const mid = add(j0, mul(ud, L1));
  const end = add(mid, mul(ld, L2));
  const want = add(j0, mul(norm(sub(target, j0)), len(sub(target, j0))));
  near(len(sub(end, want)), 0, 1e-4, '解析解末端应落在目标');
  const [ud2, ld2] = E.solveTwoBoneDirs(j0, j1, j2, V(0, 3, 0), null);
  const end2 = add(add(j0, mul(ud2, L1)), mul(ld2, L2));
  near(len(sub(end2, j0)), L1 + L2 - 1e-4, 1e-4, '不可达目标应把链伸直');
}

// ── 载入 xbot，节点空间关节工具 ──
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
const asset = E.registerGltfAsset('xbot-ik-test', E.decodeModelPack(pack));
const CHILD = { RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightArm: 'RightForeArm', RightForeArm: 'RightHand' };
const boneOf = (n) => asset.bones.find((b) => String(b.name).replace(/^mixamorig:?/i, '') === n);
const headOf = (wm, n) => { const b = boneOf(n); const m = wm[b.nodeIdx]; return V(m[12], m[13], m[14]); };
const childDirOf = (wm, n) => {
  const c = CHILD[n];
  if (!c) return null;
  return norm(sub(headOf(wm, c), headOf(wm, n)));
};

// ── ② 脚 IK：命中目标 / 轴心不动 / 极向量 ──
{
  const local0 = E.applyBonePoseToLocal(asset, 0, null, null, null, 0, null);
  const wm0 = E.localWorldMatrices(asset, local0);
  const hip0 = headOf(wm0, 'RightUpLeg');
  const foot0 = headOf(wm0, 'RightFoot');
  const target = add(foot0, V(0.05, 0.25, 0.1));   // 明显可达的抬脚目标
  const pole = add(hip0, V(0, 0, 0.5));
  const local1 = E.applyBonePoseToLocal(asset, 0, null, null, null, 0, {
    ik: [{ chain: ['RightUpLeg', 'RightLeg', 'RightFoot'], target: [target.x, target.y, target.z], pole: [pole.x, pole.y, pole.z] }],
  });
  const wm1 = E.localWorldMatrices(asset, local1);
  const hip1 = headOf(wm1, 'RightUpLeg');
  const foot1 = headOf(wm1, 'RightFoot');
  near(len(sub(hip1, hip0)), 0, 1e-6, 'IK 不应移动根关节（轴心必须在该骨骼关节）');
  near(len(sub(foot1, target)), 0, 0.01, '脚 IK 应命中目标（误差 <1cm）');
  const knee = headOf(wm1, 'RightLeg');
  ok(dot(norm(sub(knee, hip1)), norm(sub(pole, hip1))) > 0.05, '膝应弯向极向量一侧');
  // 不可达：拉直、无 NaN
  const local2 = E.applyBonePoseToLocal(asset, 0, null, null, null, 0, { ik: [{ chain: ['RightUpLeg', 'RightLeg', 'RightFoot'], target: [0, 6, 0] }] });
  const wm2 = E.localWorldMatrices(asset, local2);
  let finite = true;
  local2.forEach((L) => { for (let i = 0; i < 4; i++) if (!Number.isFinite(L.r[i])) finite = false; });
  ok(finite, '不可达目标不应产生 NaN');
  const L1 = len(sub(headOf(wm0, 'RightLeg'), hip0));
  const L2 = len(sub(foot0, headOf(wm0, 'RightLeg')));
  near(len(sub(headOf(wm2, 'RightFoot'), headOf(wm2, 'RightUpLeg'))), L1 + L2 - 1e-4, 0.02, '不可达时腿应接近伸直');
}

// ── ③ damped_track：骨骼子方向指向目标 ──
{
  const tgt = V(1.2, 1.4, 0.6);
  const local = E.applyBonePoseToLocal(asset, 0, null, null, null, 0, { constraints: [{ type: 'damped_track', bone: 'RightArm', target: [tgt.x, tgt.y, tgt.z] }] });
  const wm = E.localWorldMatrices(asset, local);
  const dir = childDirOf(wm, 'RightArm');
  const want = norm(sub(tgt, headOf(wm, 'RightArm')));
  ok(dot(dir, want) > 0.999, 'damped_track 后骨骼子方向应指向目标（dot=' + dot(dir, want).toFixed(4) + '）');
}

// ── ④ limit / copy rotation ──
{
  const mkLocal = () => asset.nodes.map((n) => ({ t: n.t.slice(), r: n.r.slice(), s: n.s.slice() }));
  const arm = boneOf('RightArm'), fore = boneOf('RightForeArm');
  const L1 = mkLocal();
  L1[arm.nodeIdx].r = [0, Math.sin(0.6), 0, Math.cos(0.6)]; // 绕 Y 1.2rad
  E.resolveIkAndConstraints(asset, L1, { constraints: [{ type: 'limit_rotation', bone: 'RightArm', min: [-0.3, -0.3, -0.3], max: [0.3, 0.3, 0.3] }] }, 0);
  const e = E.quatToEuler(L1[arm.nodeIdx].r);
  ok(Math.abs(e[1]) <= 0.3 + 1e-6, 'limit_rotation 应把绕 Y 限制到 0.3 内（实际 ' + e[1].toFixed(3) + '）');
  const L2 = mkLocal();
  L2[fore.nodeIdx].r = [0, Math.sin(0.4), 0, Math.cos(0.4)];
  E.resolveIkAndConstraints(asset, L2, { constraints: [{ type: 'copy_rotation', bone: 'RightArm', from: 'RightForeArm' }] }, 0);
  const qa = L2[arm.nodeIdx].r, qb = L2[fore.nodeIdx].r;
  ok(Math.abs(qa[3] - qb[3]) < 1e-9 && Math.abs(qa[1] - qb[1]) < 1e-9, 'copy_rotation 应复制源骨骼旋转');
}

// ── ⑤ 规格透传 ──
{
  const spec = {
    characters: [{
      name: '甲',
      ik: [{ chain: ['RightUpLeg', 'RightLeg', 'RightFoot'], target: [0, 0.1, 0.3], pole: [0, 1, 1] }, { chain: ['bad'] }],
      constraints: [{ type: 'damped_track', bone: 'Head', target: [0, 2, 3] }, { type: 'x' }],
    }],
  };
  const sc = E.buildStageFromSpec(spec);
  const ob = sc.objects[0];
  ok(Array.isArray(ob.ik) && ob.ik.length === 1, '非法 IK（chain 不足 3 骨）应被过滤');
  ok(Array.isArray(ob.constraints) && ob.constraints.length === 1, '非法约束应被过滤');
  const back = E.compileStageSpec(sc);
  ok(Array.isArray(back.characters[0].ik) && back.characters[0].ik.length === 1, 'compileStageSpec 应回写 ik');
  ok(Array.isArray(back.characters[0].constraints) && back.characters[0].constraints.length === 1, 'compileStageSpec 应回写 constraints');
}

if (errs.length) {
  console.error('✗ Phase C IK/约束测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ Phase C 通过：IK 命中/轴心/极向量/不可达 + damped_track + limit/copy rotation + 规格透传');
process.exit(0);
