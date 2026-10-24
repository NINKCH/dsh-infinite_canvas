// 正式回归：运动驱动（步频）/ 雾与景深 / 一句话模板库 / 时间轴能力
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ── ① 运动驱动：步频随路径速度变化（不滑步）──
{
  const mk = (dur) => ({
    version: 2,
    objects: [{ id: 'm', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: E.v3(0, 0, 0), h: 1.78, clip: 'walk', animTime: 0, visible: true,
      path: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], pathMode: 'linear',
      locomotion: { source: 'clip', clip: 'walk', stride: 0.75, cycle: 1, refSpeed: 1.4 } }],
    cameras: [{ id: 'c', pos: E.v3(0, 1.6, 6), target: E.v3(0, 1, 0), fov: 42, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: dur },
  });
  const slow = E.applyPlayhead(mk(20), 2).objects[0];
  const fast = E.applyPlayhead(mk(4), 2).objects[0];
  ok(typeof slow.motionSpeed === 'number' && slow.motionSpeed > 0, '未计算路径速度');
  ok(fast.motionSpeed > slow.motionSpeed * 2, '速度应随时长变化（快路径速度更大）');
  ok(fast.animTime > slow.animTime * 2, '快路径的动画播放应更快（防滑步），实际 ' + fast.animTime.toFixed(2) + ' vs ' + slow.animTime.toFixed(2));
  // 位移与弧长一致
  ok(Math.abs(E.pathArcLength(mk(4).objects[0]) - 10) < 0.2, '路径弧长应约 10m，实际 ' + E.pathArcLength(mk(4).objects[0]).toFixed(2));
  ok(Math.abs(E.applyPlayhead(mk(4), 4).objects[0].pos.x - 10) < 0.2, '应沿路径走到终点');
  // 用户动作也能驱动（pose 模式 → poseTime）
  const sc = mk(4);
  sc.objects[0].locomotion = { source: 'action', stride: 0.75, cycle: 1, refSpeed: 1.4 };
  sc.objects[0].poseAnim = [{ t: 0, poseId: 'fight' }, { t: 1, poseId: 'punch' }, { t: 2, poseId: 'fight' }];
  const act = E.applyPlayhead(sc, 2).objects[0];
  ok(typeof act.poseTime === 'number' && act.poseTime > 0, '自建动作应能被路径驱动（poseTime）');
  // 默认驱动：有路径但未配置 locomotion → 自动按速度驱动当前动作片段（动作只在一处选）
  const sc2 = mk(6);
  sc2.objects[0].locomotion = undefined;
  const auto = E.applyPlayhead(sc2, 2).objects[0];
  ok(typeof auto.motionSpeed === 'number' && auto.motionSpeed > 0, '未配置时也应默认计算路径速度');
  ok(Math.abs(auto.animTime - (2 / 6 * 10) / (0.75 * 2) * 1 * (10 / 6 / 1.4)) < 0.05, '未配置时 animTime 应按步频自动驱动，实际 ' + auto.animTime.toFixed(3));
  // 显式关闭
  const sc3 = mk(6);
  sc3.objects[0].locomotion = { source: 'none' };
  const off = E.applyPlayhead(sc3, 2).objects[0];
  ok(off.motionSpeed === undefined && Math.abs(off.animTime - 2) < 1e-9, "source:'none' 应关闭驱动（animTime=time）");
}

// ── ①b 骨骼动画必须循环播放（修复：沿路径定格姿态平移）──
{
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
  const a = E.decodeModelPack(pack);
  E.registerGltfAsset('xbot', a);
  const hash = (clip, t) => {
    const sk = E.skinModel(a, clip, t, null, null, {});
    let h = 0;
    for (let i = 0; i < sk.pos.length; i += 97) h = (h * 31 + Math.round(sk.pos[i] * 1000)) | 0;
    return h;
  };
  const run = a.clipByName('run');
  ok(run && Number(run.duration) > 0 && Number(run.duration) < 2, 'run 片段应存在且短于 2s（实测 ' + (run && run.duration) + 's）');
  const dur = Number(run.duration);
  // t=1/2/3 远超 0.7s 片段时长：钳制 bug 下三者 hash 相同（定格）；循环下各不相同
  const h1 = hash('run', 1), h2 = hash('run', 2), h3 = hash('run', 3);
  ok(h1 !== h2 && h2 !== h3, 'run 动画在片段时长后应循环变化（t=1/2/3 hash：' + h1 + '/' + h2 + '/' + h3 + '）');
  ok(hash('run', dur + 0.1) === hash('run', 0.1) && hash('run', dur + 0.25) === hash('run', 0.25), '超时长后应精确循环回绕');
  const idle = a.clipByName('idle');
  ok(hash('idle', Number(idle.duration) * 2 + 0.15) === hash('idle', 0.15), 'idle 超时长后应循环回绕');
}

// ── ② 雾 / 景深 / 灯光进规格 ──
{
  const spec = {
    duration: 4,
    fog: { color: '#8899aa', near: 3, far: 25, density: 1 },
    dof: { focus: 4, range: 3, maxBlur: 8 },
    lights: [{ dir: [0.3, -0.8, 0.4], intensity: 1.5, color: '#ffffff' }, { dir: [-0.4, -0.2, -0.6], intensity: 0.6 }],
    characters: [{ name: 'A', pos: [0, 0, 0] }],
    cameras: [{ name: 'c1', pos: [0, 1.6, 4] }],
    shots: [{ camera: 'c1', start: 0, end: 4 }],
  };
  const sc = E.buildStageFromSpec(spec);
  ok(sc.env.fog && sc.env.fog.enabled && sc.env.fog.far === 25, '规格雾未写入 env.fog');
  ok(sc.env.dof && sc.env.dof.enabled && sc.env.dof.maxBlur === 8, '规格景深未写入 env.dof');
  ok(sc.lights.length === 2 && sc.lights[0].intensity === 1.5, '规格灯光未写入');
  const back = E.compileStageSpec(sc);
  ok(back.fog && back.fog.far === 25, '反向导出应保留雾');
  ok(back.dof && back.dof.focus === 4, '反向导出应保留景深');
  ok(Array.isArray(back.lights) && back.lights.length === 2, '反向导出应保留灯光');
}

// ── ③ 一句话 → 规格 模板库 ──
{
  const cases = [
    ['两人在巷子里打斗，8秒', 'fight', 2],
    ['主角追逐反派跑过街道', 'chase', 2],
    ['两人在桌前对话，12秒', 'dialogue', 3],
  ];
  for (const [brief, tplId, camCount] of cases) {
    const spec = E.specFromBrief(brief);
    ok(!!spec && typeof spec === 'object', '模板库未返回规格：' + brief);
    const sc = E.buildStageFromSpec(spec);
    ok(sc.objects.filter((o) => o.kind === 'model').length >= 2, brief + '：至少 2 个角色');
    ok(sc.cameras.length === camCount, brief + '：机位数应为 ' + camCount + '，实际 ' + sc.cameras.length);
    ok(sc.shots.length >= 2, brief + '：应有多分镜');
    ok(sc.shot.duration >= 1.5, brief + '：时长应合法');
    // 分镜首尾相接、不重叠
    const s2 = sc.shots;
    for (let i = 1; i < s2.length; i++) ok(Math.abs(s2[i].start - s2[i - 1].end) < 1e-6, brief + '：分镜应首尾相接');
    void tplId;
  }
  // 时长解析
  ok(Math.abs(E.buildStageFromSpec(E.specFromBrief('打斗 6秒')).shot.duration - 6) < 1e-6, '应从 brief 抓出时长 6 秒');
  // 显式模板覆盖关键词
  const forced = E.specFromBrief('两个人站着', { template: 'chase' });
  ok(forced.characters.some((c) => c.locomotion), '指定 chase 模板应带运动驱动');
  // Host 工具暴露 brief 动作
  const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(host.includes("action === 'brief'"), 'Host 工具缺少 brief 动作');
  ok(host.includes('specFromBrief'), 'Host 工具未调用模板库');
}

// ── ④ 时间轴能力 ──
{
  const keys = [{ t: 0, pos: E.v3(0, 0, 0) }, { t: 2, pos: E.v3(4, 0, 0), ease: 'constant' }, { t: 4, pos: E.v3(8, 0, 0), ease: 'linear' }];
  ok(E.prevKeyTime(keys, 1) === 0 && E.nextKeyTime(keys, 1) === 2, '上/下一关键帧查询错误');
  ok(E.prevKeyTime(keys, 0) === null && E.nextKeyTime(keys, 9) === null, '边界应为 null');
  ok(E.keyIndexAt(keys, 2.02) === 1, '关键帧下标查询错误');
  // 插值：constant 保持前一帧值；linear 线性；auto 平滑
  const c = E.sampleKeysEased(keys, 1, ['pos']);
  ok(Math.abs(c.pos.x - 0) < 1e-6, 'constant 插值应保持前一帧值，实际 ' + c.pos.x);
  const l = E.sampleKeysEased(keys, 3, ['pos']);
  ok(Math.abs(l.pos.x - 6) < 1e-6, 'linear 插值应为中点 6，实际 ' + l.pos.x);
  const au = E.sampleKeysEased([{ t: 0, pos: E.v3(0, 0, 0) }, { t: 2, pos: E.v3(4, 0, 0) }], 0.5, ['pos']);
  ok(au.pos.x > 0 && au.pos.x < 4, 'auto 插值应在区间内');
  // 标记
  const sc = { objects: [], cameras: [], shots: [], shot: { duration: 4 } };
  E.addMarker(sc, 1.5, 'A');
  E.addMarker(sc, 0.5, 'B');
  ok(sc.markers.length === 2 && sc.markers[0].t === 0.5, '标记应按时间排序');
  ok(E.removeMarkerAt(sc, 0.5) === true && sc.markers.length === 1, '标记删除失败');
  // 总览
  const sc2 = { objects: [{ id: 'o', name: 'O', keys }], cameras: [{ id: 'c', name: 'C', keys: [{ t: 0 }, { t: 3 }] }], shots: [{ id: 's', cameraId: 'c', start: 0, end: 4 }], markers: [], shot: { duration: 4 } };
  const info = E.dopeSheetInfo(sc2);
  ok(info.tracks.length === 3 && info.tracks[0].count === 3, '时间轴总览轨道数/关键帧数错误');
  // UI 入口
  const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  for (const act of ['dir-key-prev', 'dir-key-next', 'dir-key-del', 'dir-key-ease', 'dir-loop', 'dir-marker-add', 'dir-marker-del', 'dir-tl-zoom']) {
    ok(cli.includes(act), '时间轴缺少入口：' + act);
  }
  ok(cli.includes('loopPlay'), '缺少循环播放状态');
}

// ── ⑤ 角色一律用资产库的真实人偶资产（不许程序化木头人）──
{
  // 默认场景：真实 glTF 人偶 + 道具，不是 kind='actor'
  const d = E.directorDefaultScene('x');
  const actor = d.objects[0];
  ok(actor && actor.kind === 'model', '默认场景角色应是真实模型（model），实际 ' + (actor && actor.kind));
  ok(actor.assetId === 'xbot', '默认场景角色应使用资产 xbot');
  ok(!!actor.typeId, '默认场景角色缺少体型 typeId');
  ok(d.objects.every((o) => !o.color || o.color === E.CLAY), '默认场景应保持白膜（无自带颜色）');
  // 规格角色：12 体型都能映射到真实 asset + typeId
  for (const preset of E.ACTOR_PRESETS.map((x) => x.id)) {
    const sc = E.buildStageFromSpec({ characters: [{ name: 'A', preset }], cameras: [{ name: 'c' }], shots: [{ camera: 'c', start: 0, end: 2 }], duration: 2 });
    const ob = sc.objects[0];
    ok(ob.kind === 'model' && ob.assetId === 'xbot', '规格角色（' + preset + '）未用真实资产');
    ok(ob.typeId && ob.typeId !== 'm_standard' || preset === 'male_standard', '体型 ' + preset + ' 未映射成对应 typeId（' + ob.typeId + '）');
    ok(Math.abs(Number(ob.h) - (E.ACTOR_PRESETS.find((x) => x.id === preset) || {}).h) < 0.02, '体型 ' + preset + ' 身高不对');
  }
  // 旧场景迁移：kind='actor' → 真实模型
  const legacy = { version: 2, objects: [{ id: 'a', kind: 'actor', preset: 'female_teen', pos: E.v3(0, 0, 0), h: 1 }, { id: 'b', kind: 'model', pos: E.v3(1, 0, 0) }], cameras: [], lights: [], env: {}, shot: { duration: 2 } };
  const mig = E.migrateStageScene(JSON.parse(JSON.stringify(legacy)));
  ok(mig.objects[0].kind === 'model' && mig.objects[0].assetId === 'xbot', '旧 kind=actor 未迁移到真实模型');
  ok(mig.objects[0].typeId === 'f_teen', '迁移后体型应为 f_teen，实际 ' + mig.objects[0].typeId);
  ok(Math.abs(Number(mig.objects[0].h) - 1.52) < 0.02, '迁移后身高应取体型预设');
  ok(mig.objects[1].assetId === 'xbot' && mig.objects[1].clip === 'idle', '缺 assetId/clip 的模型未补齐');
  // 引擎提供迁移与体型映射 API
  ok(typeof E.migrateStageScene === 'function' && typeof E.actorTypeIdOf === 'function', '缺少迁移/体型映射 API');
  // 拾取面片：有 glTF 资产时 actor 也用真实网格（Node 无资产 → 回退程序化，仍须落地）
  const faces = E.directorObjectFaces({ id: 'm', kind: 'actor', preset: 'male_standard', pos: E.v3(0, 0, 0), h: 1.78, visible: true });
  ok(faces.length > 0, 'actor 面片为空');
}

// ── ⑥ 提示词景别/运镜映射（不得输出内部 id 或中英混排）+ 规格往返保真 ──
{
  const base = {
    version: 2, title: 't', shot: { duration: 4, shotSize: 'medium_close', cameraMove: 'push_in' },
    objects: [{ id: 'm', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: E.v3(0, 0, 0), h: 1.78, clip: 'idle', visible: false, scale: E.v3(1.1, 1, 0.9) }],
    cameras: [{ id: 'c', name: '机位1', pos: E.v3(0, 1.6, 4), target: E.v3(0, 1, 0), fov: 40, roll: 0.12, sensorX: 36, lens: 50, keys: [] }],
    shots: [{ id: 's1', cameraId: 'c', start: 0, end: 4 }], lights: [], env: {}, activeCameraId: 'c', markers: [{ t: 1, label: 'A' }],
  };
  const zh = E.compileDirectorPrompt(base, { zh: true });
  const en = E.compileDirectorPrompt(base, { zh: false });
  ok(!/medium_close/.test(zh) && !/medium_close/.test(en), '提示词不应输出内部景别 id');
  ok(zh.includes('近景'), '中文提示词应输出「近景」');
  ok(/medium close/i.test(en), '英文提示词应输出英文景别');
  ok(!/推近|拉远|固定机位/.test(en), '英文提示词不应混入中文运镜');
  ok(/push in/i.test(en), '英文运镜应为 push in');
  // 规格往返：镜头参数/可见性/缩放/传感器/焦段/标记都要回来
  const spec = E.compileStageSpec(base);
  ok(spec.shot && spec.shot.shotSize === 'medium_close' && spec.shot.cameraMove === 'push_in', '规格应导出镜头景别与运镜');
  ok(spec.characters[0].visible === false, '规格应导出角色可见性');
  ok(Array.isArray(spec.characters[0].scale), '规格应导出角色缩放');
  ok(spec.cameras[0].sensorX === 36 && spec.cameras[0].lens === 50, '规格应导出传感器宽度与焦段');
  ok(Array.isArray(spec.markers) && spec.markers.length === 1, '规格应导出标记');
  const back = E.buildStageFromSpec(JSON.parse(JSON.stringify(spec)));
  ok(back.shot.shotSize === 'medium_close' && back.shot.cameraMove === 'push_in', '规格往返后镜头参数丢失');
  ok(back.objects[0].visible === false, '规格往返后角色可见性丢失');
  ok(back.objects[0].scale && Math.abs(back.objects[0].scale.x - 1.1) < 1e-6, '规格往返后角色缩放丢失');
  ok(back.cameras[0].sensorX === 36 && Math.abs(back.cameras[0].lens - 50) < 1e-6, '规格往返后传感器/焦段丢失');
  ok(Array.isArray(back.markers) && back.markers.length === 1, '规格往返后标记丢失');
}

if (errs.length) {
  console.error('✗ 运动/雾景深/模板库/时间轴测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 运动驱动 / 雾+景深 / 一句话模板库 / 时间轴能力 测试通过');
process.exit(0);
