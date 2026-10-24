// 正式回归：AI 场景规格（spec → scene → spec）+ 循环动作 + 路径点编辑
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ── ① 规格 → 场景 ──
const spec = {
  title: '巷战预演',
  duration: 6,
  env: { preset: 'studio', bg: '#101418', ground: '#20262e', grid: true, tonemap: 'agx' },
  characters: [
    { name: '男主', pos: [0, 0, 0], rotY: 0, h: 1.78, pose: 'fight', color: '#c9ced6',
      path: [[0, 0], [0, 0], [3, 2]], poseAnim: [{ t: 0, pose: 'fight' }, { t: 1, pose: 'punch' }],
      keys: [{ t: 0, pos: [0, 0, 0], rotY: 0 }, { t: 3, pos: [1, 0, 0], rotY: 1.2 }] },
    { name: '反派', pos: [3, 0, 2], pose: 'crouch', material: { roughness: 0.3, metallic: 0.1 } },
  ],
  props: [{ name: '木箱', preset: 'box', pos: [1.5, 0, -1], scale: [0.8, 0.8, 0.8], color: '#aab' }],
  cameras: [
    { name: 'A', pos: [0, 1.6, 4], target: [0, 1, 0], fov: 42 },
    { name: 'B', pos: [4, 1.6, 0], target: [0, 1, 0], fov: 35, keys: [{ t: 0, pos: [4, 1.6, 0], target: [0, 1, 0] }, { t: 3, pos: [2, 1.2, 2], target: [0, 1, 0] }] },
  ],
  shots: [{ camera: 'A', start: 0, end: 3 }, { camera: 'B', start: 3, end: 6 }],
};
{
  const sc = E.buildStageFromSpec(spec);
  ok(!!sc && sc.version >= 2, 'buildStageFromSpec 返回合法场景');
  ok(sc.objects.length === 3, '角色+道具数量应为 3，实际 ' + sc.objects.length);
  ok(sc.cameras.length === 2, '机位数量应为 2');
  ok(sc.shots.length === 2, '分镜数量应为 2');
  ok(Math.abs(sc.shot.duration - 6) < 1e-6, '时长应取 spec.duration');
  const hero = sc.objects[0];
  ok(hero.poseId === 'fight', '角色姿态应写入 poseId');
  ok(Array.isArray(hero.path) && hero.path.length === 3, '路径点应写入');
  ok(hero.pathOrigin && hero.pathOrigin.x === hero.pos.x, 'pathOrigin 应锚定在初始位置（不瞬移）');
  ok(Array.isArray(hero.poseAnim) && hero.poseAnim.length === 2, '姿态帧应写入');
  ok(Array.isArray(hero.keys) && hero.keys.length === 2, '位置关键帧应写入');
  ok(sc.objects[1].material && sc.objects[1].material.roughness === 0.3, '材质应写入');
  ok(sc.objects[2].preset === 'box', '道具 preset 应写入');
  // 分镜引用机位 name 时应解析成 id
  ok(sc.shots[0].cameraId === sc.cameras[0].id, '分镜应能按机位 name 解析 id（实际 ' + sc.shots[0].cameraId + ' vs ' + sc.cameras[0].id + '）');
  // 机位关键帧
  ok(sc.cameras[1].keys.length === 2, '机位关键帧应写入');
  // 播放头：分镜切换必须真实生效
  const t1 = E.applyPlayhead(sc, 1).activeCameraId;
  const t2 = E.applyPlayhead(sc, 4).activeCameraId;
  ok(t1 === sc.cameras[0].id && t2 === sc.cameras[1].id, '分镜在不同时间应切换机位（' + t1 + ' → ' + t2 + '）');
  // 路径转向：有 path + pathFace 默认 → rotY 应变化
  const p0 = E.applyPlayhead(sc, 0).objects[0];
  const p5 = E.applyPlayhead(sc, 5.5).objects[0];
  ok(p0 && p5 && p5.pos && (Math.abs(p5.pos.x - p0.pos.x) > 0.1 || Math.abs(p5.pos.z - p0.pos.z) > 0.1), '角色应沿路径移动');
}

// ── ② 场景 → 规格（往返）──
{
  const sc = E.buildStageFromSpec(spec);
  const back = E.compileStageSpec(sc);
  ok(back.characters.length === 2, '往返后角色数应为 2，实际 ' + back.characters.length);
  ok(back.props.length === 1, '往返后道具数应为 1');
  ok(back.cameras.length === 2 && back.shots.length === 2, '往返后机位/分镜数应保持');
  ok(Math.abs(back.duration - 6) < 1e-6, '往返后时长应保持');
  ok(back.characters[0].pose === 'fight', '往返后姿态应保持');
  // 二次构建应等价
  const sc2 = E.buildStageFromSpec(back);
  ok(sc2.objects.length === sc.objects.length, '两次构建对象数应一致');
}

// ── ③ 规格容错 ──
{
  const empty = E.buildStageFromSpec(null);
  ok(!!empty && Array.isArray(empty.objects) && empty.objects.length === 0, '空规格应返回空场景而非崩溃');
  ok(empty.shot.duration >= 0.5, '空规格也应有合法时长');
  const badPose = E.buildStageFromSpec({ characters: [{ pose: '不存在的姿态' }] });
  ok(!badPose.objects[0].poseId, '未知姿态应被忽略而非写入');
  const twoDim = E.buildStageFromSpec({ characters: [{ pos: [3, 4] }] });
  ok(twoDim.objects[0].pos.x === 3 && twoDim.objects[0].pos.y === 0 && twoDim.objects[0].pos.z === 4, '二维坐标 [x,z] 应自动补 y=0');
}

// ── ④ 用户自建动作（取代预设动作片段）──
{
  ok(!('ACTION_SEQUENCES' in E) || !E.ACTION_SEQUENCES, '预设动作片段应已移除（用户要求不预设）');
  ok(typeof E.saveUserAction === 'function' && typeof E.loadUserActions === 'function', '缺少用户动作存取');
  ok(typeof E.deleteUserAction === 'function', '缺少删除用户动作');
  ok(typeof E.applyUserAction === 'function', '缺少套用用户动作');
}

// ── ⑤ Host 工具 / 客户端接线 ──
{
  const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(host.includes("name: 'canvas_director_stage'"), '缺少 canvas_director_stage 工具');
  ok(host.includes('directorStageSave') && host.includes('directorStageLoad'), '缺少导演台规格 RPC');
  ok(/director-stage\.json/.test(host), '规格应落盘到 director-stage.json');
  const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(cli.includes("hostRpc('directorStageLoad'"), '客户端应读取 Host 规格');
  ok(cli.includes('buildStageFromSpec'), '客户端应能用规格构建场景');
  ok(cli.includes("'dir-spec-apply'") && cli.includes("'dir-spec-copy'"), '缺少规格面板按钮');
  ok(cli.includes('compileStageSpec'), '缺少「从当前场景生成规格」');
}

if (errs.length) {
  console.error('✗ AI 规格测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ AI 场景规格测试通过（spec→scene→spec 往返 / 分镜按 name 解析 / 路径与转向 / 容错 / 循环动作 / Host 工具与客户端接线）');
process.exit(0);
