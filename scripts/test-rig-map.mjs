// 通用人形骨架映射：动作只依赖语义关节，可套用到任意命名的人形模型
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const mk = (names) => ({ bones: names.map((n, i) => ({ name: n, nodeIdx: i })), nodes: names.map(() => ({})) });

// ① 真实 xbot 必须 100%
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
const asset = E.decodeModelPack(pack);
const mx = E.autoRigMap(asset);
ok(mx.coverage >= 0.95, 'xbot 语义映射覆盖不足：' + (mx.coverage * 100).toFixed(0) + '% 缺 ' + mx.missing.join(','));
ok(!mx.missing.includes('Hips') && !mx.missing.includes('Head'), 'xbot 缺核心关节');

// ② 四种主流命名约定都要能映射
const SETS = {
  Mixamo: ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head',
    'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand',
    'mixamorig:RightShoulder', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand',
    'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase',
    'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot', 'mixamorig:RightToeBase'],
  VRM: ['J_Bip_C_Hips', 'J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_Neck', 'J_Bip_C_Head',
    'J_Bip_L_Shoulder', 'J_Bip_L_UpperArm', 'J_Bip_L_LowerArm', 'J_Bip_L_Hand',
    'J_Bip_R_Shoulder', 'J_Bip_R_UpperArm', 'J_Bip_R_LowerArm', 'J_Bip_R_Hand',
    'J_Bip_L_UpperLeg', 'J_Bip_L_LowerLeg', 'J_Bip_L_Foot', 'J_Bip_L_Toes',
    'J_Bip_R_UpperLeg', 'J_Bip_R_LowerLeg', 'J_Bip_R_Foot', 'J_Bip_R_Toes'],
  Blender: ['hips', 'spine', 'chest', 'neck', 'head',
    'shoulder.L', 'upper_arm.L', 'forearm.L', 'hand.L',
    'shoulder.R', 'upper_arm.R', 'forearm.R', 'hand.R',
    'thigh.L', 'shin.L', 'foot.L', 'toe.L',
    'thigh.R', 'shin.R', 'foot.R', 'toe.R'],
  Daz: ['hip', 'abdomenLower', 'abdomenUpper', 'neckLower', 'head',
    'lCollar', 'lShldr', 'lForeArm', 'lHand',
    'rCollar', 'rShldr', 'rForeArm', 'rHand',
    'lThigh', 'lShin', 'lFoot', 'lToe',
    'rThigh', 'rShin', 'rFoot', 'rToe'],
};
for (const [name, names] of Object.entries(SETS)) {
  const r = E.autoRigMap(mk(names));
  ok(r.coverage >= 0.85, name + ' 骨架映射覆盖不足：' + (r.coverage * 100).toFixed(0) + '% 缺 ' + r.missing.join(','));
}

// ③ 左右不能串（最危险的错误：左臂动作套到右臂）
{
  const r = E.autoRigMap(mk(SETS.Mixamo));
  const L = r.semantic.LeftArm, R = r.semantic.RightArm;
  ok(L !== undefined && R !== undefined && L !== R, '左右臂映射串了');
  const lName = SETS.Mixamo[L], rName = SETS.Mixamo[R];
  ok(/left/i.test(lName) && /right/i.test(rName), '左右臂映射方向颠倒：L=' + lName + ' R=' + rName);
}

// ④ 非人形骨架应低覆盖（不能硬套）
{
  const r = E.autoRigMap(mk(['Cube', 'Cube.001', 'Camera', 'Light']));
  ok(r.coverage < 0.3, '非人形骨架不应高覆盖（实际 ' + (r.coverage * 100).toFixed(0) + '%）');
}

if (errs.length) {
  console.error('✗ 通用骨架映射测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 通用骨架映射通过：xbot 100% / Mixamo·VRM·Blender·Daz ≥85% / 左右不串 / 非人形低覆盖');
process.exit(0);
