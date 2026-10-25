// 导演台 IK / 约束 / 动作层面板：源码契约 + 引擎字段往返
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① 三面板入口按钮
for (const action of ['dir-ik-add', 'dir-ik-take-current', 'dir-ik-key', 'dir-constraint-add', 'dir-clip-add', 'dir-clip-bake', 'dir-bvh-import']) {
  ok(cli.includes('data-action": "' + action + '"') || cli.includes("'data-action': '" + action + "'") || cli.includes('data-action=\'"' + action + '"'), '缺少面板按钮：' + action);
}

// ② 写回字段
ok(/o2\.ik\s*=/.test(cli), 'IK 面板应写回 o2.ik');
ok(/o2\.constraints\s*=/.test(cli), '约束面板应写回 o2.constraints');
ok(/o2\.clips\s*=/.test(cli), '动作层面板应写回 o2.clips');
ok(/blend:\s*'replace'/.test(cli) && /influence/.test(cli), '动作层应支持 blend/influence');

// ③ 面板调用引擎能力
ok(cli.includes('E.applyBonePoseToLocal') && cli.includes('E.localWorldMatrices'), 'IK 面板应调用节点空间姿态/世界矩阵（取末端位置）');
ok(cli.includes('E.parseBVH') && cli.includes('E.retargetBVH'), 'BVH 导入应调用引擎解析/重定向');

// ④ i18n 键（中英都要有）
const keys = ['dirIk', 'dirIkAdd', 'dirIkChain', 'dirIkTarget', 'dirIkPole', 'dirConstraint', 'dirConstraintAdd', 'dirConstraintType',
  'dirClips', 'dirClipAdd', 'dirClipBake', 'dirClipBvh', 'dirClipBlend', 'dirClipInfluence', 'dirClipLoop'];
for (const k of keys) {
  const n = (cli.match(new RegExp("'" + k + "'", 'g')) || []).length;
  ok(n >= 2, 'i18n 键应中英各一份：' + k + '（实际 ' + n + '）');
}

// ⑤ 引擎往返：ik / constraints / clips 经 spec→scene→spec 保真
{
  const spec = {
    duration: 4,
    characters: [{
      name: '甲',
      ik: [{ chain: ['RightUpLeg', 'RightLeg', 'RightFoot'], target: [0, 0.1, 0.2], pole: [0, 1, 1] }],
      constraints: [{ type: 'damped_track', bone: 'Head', target: [0, 2, 3] }, { type: 'limit_rotation', bone: 'Neck', min: [-0.2, -0.2, -0.2], max: [0.2, 0.2, 0.2] }],
      clips: [{ keys: [{ t: 0, bonePose: { 5: [0, 0, 0, 1] } }], blend: 'add', influence: 0.5, loop: true }],
    }],
    cameras: [{ name: 'A', pos: [0, 1.6, 4], target: [0, 1, 0], fov: 42 }],
    shots: [{ camera: 'A', start: 0, end: 4 }],
  };
  const sc = E.buildStageFromSpec(spec);
  const ob = sc.objects[0];
  ok(Array.isArray(ob.ik) && ob.ik.length === 1, 'buildStageFromSpec 应写入 ik');
  ok(Array.isArray(ob.constraints) && ob.constraints.length === 2, 'buildStageFromSpec 应写入 constraints');
  ok(Array.isArray(ob.clips) && ob.clips.length === 1 && ob.clips[0].blend === 'add', 'buildStageFromSpec 应写入 clips（含 blend）');
  const back = E.compileStageSpec(sc);
  ok(back.characters[0].ik && back.characters[0].ik.length === 1, 'compileStageSpec 应回写 ik');
  ok(back.characters[0].constraints && back.characters[0].constraints.length === 2, 'compileStageSpec 应回写 constraints');
  ok(back.characters[0].clips && back.characters[0].clips.length === 1, 'compileStageSpec 应回写 clips');
  // 面板写回同构：把 UI 会写的形态再喂一次，应等价
  const sc2 = E.buildStageFromSpec(back);
  ok(sc2.objects[0].ik.length === 1 && sc2.objects[0].constraints.length === 2 && sc2.objects[0].clips.length === 1, 'UI 写入形态应可再次解析（幂等）');
}

if (errs.length) {
  console.error('✗ 导演台三面板测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 三面板通过：按钮入口 / 字段写回 / 引擎接线 / 中英 i18n / spec 往返');
process.exit(0);
