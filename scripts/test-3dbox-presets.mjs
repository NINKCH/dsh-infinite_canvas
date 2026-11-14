// 正式回归：3D-BOX 预设与一句话搭景（场景/风格/运镜）
// 覆盖：引擎导出清单 / 场景预设可构建 / 风格与运镜组合 / applyCameraMove 纯函数 / Host 工具与客户端入口接线
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ── ① 引擎导出清单 ──
ok(Array.isArray(E.SCENE_PRESETS) && E.SCENE_PRESETS.length >= 9, '缺少 9 个场景预设（SCENE_PRESETS）');
ok(Array.isArray(E.DIRECTOR_STYLES) && E.DIRECTOR_STYLES.length >= 6, '缺少 6 个导演风格（DIRECTOR_STYLES）');
ok(Array.isArray(E.CAMERA_MOVES) && E.CAMERA_MOVES.length >= 16, '缺少 16+ 运镜预设（CAMERA_MOVES）');
ok(typeof E.specFromScenePreset === 'function', '缺少 specFromScenePreset');
ok(typeof E.applyCameraMove === 'function', '缺少 applyCameraMove');
ok(typeof E.viewCamerasAround === 'function', '缺少 viewCamerasAround（四/十二方位截图）');
ok(typeof E.cameraPathKeys === 'function', '缺少 cameraPathKeys（手绘运镜）');
ok(typeof E.addBibleCharacter === 'function', '缺少 addBibleCharacter（角色库入口）');
ok(Array.isArray(E.MOTION_PRESETS) && E.MOTION_PRESETS.length >= 30, '缺少 30+ 运镜/转场预设（MOTION_PRESETS）');
ok(typeof E.applyMotionPreset === 'function', '缺少 applyMotionPreset');

// ── ② 每个场景预设都能构建出合法场景 ──
for (const p of (E.SCENE_PRESETS || [])) {
  const spec = E.specFromScenePreset(p.id);
  ok(!!spec && typeof spec === 'object', '场景预设未返回规格：' + p.id);
  if (!spec) continue;
  const sc = E.buildStageFromSpec(spec);
  ok(sc && Array.isArray(sc.cameras) && sc.cameras.length >= 1, p.id + '：至少 1 个机位');
  ok(sc && Array.isArray(sc.shots) && sc.shots.length >= 1, p.id + '：至少 1 个分镜');
  ok(sc && sc.shot && sc.shot.duration >= 0.5, p.id + '：时长应合法');
  ok(Array.isArray(spec.characters) || Array.isArray(spec.props), p.id + '：应有角色或道具');
}

// ── ③ 三人对话：角色数/机位数必须真的变 ──
{
  const sc = E.buildStageFromSpec(E.specFromScenePreset('dialogue3'));
  const actors = sc.objects.filter((o) => o.kind === 'model');
  ok(actors.length >= 3, '三人对话应有 3 个角色，实际 ' + actors.length);
  ok(sc.cameras.length >= 3, '三人对话应有 3 个机位，实际 ' + sc.cameras.length);
}

// ── ③b 本地资产目录：models[] 必须落成 gltf 对象并保留高度 ──
{
  const spec = E.specFromScenePreset('blank');
  spec.models = [{ assetId: 'bld_a', pos: [-5, 0, -2], h: 12, rotY: 0.3 }];
  const sc = E.buildStageFromSpec(spec);
  const m = sc.objects.find((o) => o.kind === 'gltf' && o.assetId === 'bld_a');
  ok(!!m, '本地资产 bld_a 未落成 gltf 对象');
  ok(m && Math.abs(m.h - 12) < 1e-6, '本地资产高度未保留');
  ok(m && Math.abs(m.rotY - 0.3) < 1e-6, '本地资产旋转未保留');
  // 场景 → 规格 → 场景：models[] 不能退化成道具
  const back = E.compileStageSpec(sc);
  ok(Array.isArray(back.models) && back.models.some((x) => x.assetId === 'bld_a' && Math.abs(x.h - 12) < 1e-6), 'models[] 往返丢失');
  const sc2 = E.buildStageFromSpec(JSON.parse(JSON.stringify(back)));
  ok(sc2.objects.some((o) => o.kind === 'gltf' && o.assetId === 'bld_a'), 'models[] 二次构建丢失');
  // array / scatter：成排建筑与树林必须真的展开成多个实例
  const row = E.buildStageFromSpec({ models: [{ assetId: 'tree_oak', pos: [0, 0, -6], h: 7, array: { count: 3, offset: [3, 0, 0] } }] });
  const trees = row.objects.filter((o) => o.kind === 'gltf' && o.assetId === 'tree_oak');
  ok(trees.length === 3 && Math.abs(trees[2].pos.x - 6) < 1e-6, 'models array 未展开');
  const forest = E.buildStageFromSpec({ models: [{ assetId: 'tree_oak', scatter: { count: 5, radius: 4, seed: 9 } }] });
  const fs = forest.objects.filter((o) => o.assetId === 'tree_oak');
  ok(fs.length === 5, 'models scatter 数量不对：' + fs.length);
  ok(fs.every((o) => Math.hypot(o.pos.x, o.pos.z) <= 4.0001), 'scatter 超出半径');
  const forest2 = E.buildStageFromSpec({ models: [{ assetId: 'tree_oak', scatter: { count: 5, radius: 4, seed: 9 } }] });
  ok(JSON.stringify(fs.map((o) => [o.pos.x, o.pos.z])) === JSON.stringify(forest2.objects.filter((o) => o.assetId === 'tree_oak').map((o) => [o.pos.x, o.pos.z])), 'scatter 结果不确定（同 seed 位置应一致）');
}

// ── ③c 参数化组合道具：parts 拼装 + 父变换 + 颜色 + 往返 ──
{
  const spec = E.specFromScenePreset('blank');
  spec.props = [{
    id: 'police_car', name: '警车', pos: [2, 0, 1], rotY: 0.5,
    parts: [
      { preset: 'box', pos: [0, 0.35, 0], scale: [4, 0.7, 1.8], color: '#15181d' },
      { preset: 'box', pos: [0, 1.05, 0.15], scale: [2, 0.7, 1.6], color: '#2f6fed' },
      { preset: 'cylinder', pos: [-1.2, 0.35, 0.9], scale: [0.5, 0.5, 0.5], color: '#0b0b0d' },
      { preset: 'box', pos: [0, 1.45, 0], scale: [0.8, 0.18, 0.4], color: '#ff2d2d' },
    ],
  }];
  const sc = E.buildStageFromSpec(spec);
  const car = sc.objects.find((o) => o.id === 'police_car');
  ok(!!car && car.kind === 'compound', 'parts 道具未落成 compound');
  ok(car && car.parts.length === 4, 'compound parts 数量不对：' + (car && car.parts.length));
  const faces = E.directorObjectFaces(car);
  ok(faces.length > 0, 'compound 未生成面片');
  const colors = new Set(faces.map((f) => f.color));
  ok(colors.has('#15181d') && colors.has('#ff2d2d'), 'compound 未保留部件颜色');
  const top = E.directorObjectAnchor(car).top;
  ok(top > 1.5, 'compound 锚点高度应按最高部件计算（实际 ' + top.toFixed(2) + '）');
  // 父对象旋转/位移必须作用到所有部件：同一部件 rotY 0 vs π 应关于父对象中心对称
  const car0 = JSON.parse(JSON.stringify(car));
  car0.rotY = 0;
  const carPi = JSON.parse(JSON.stringify(car));
  carPi.rotY = Math.PI;
  const wheelCenter = (ob) => {
    const f = E.directorObjectFaces(ob).find((x) => x.color === '#0b0b0d');
    return f.v.reduce((a, p) => ({ x: a.x + p.x / f.v.length, z: a.z + p.z / f.v.length }), { x: 0, z: 0 });
  };
  const c0 = wheelCenter(car0);
  const c1 = wheelCenter(carPi);
  ok(Math.abs((c1.x - 2) + (c0.x - 2)) < 0.05 && Math.abs((c1.z - 1) + (c0.z - 1)) < 0.05, 'compound 父对象旋转未作用到部件');
  const back = E.compileStageSpec(sc);
  const backCar = (back.props || []).find((p) => p.id === 'police_car');
  ok(backCar && Array.isArray(backCar.parts) && backCar.parts.length === 4, 'parts 往返丢失');
  const sc2 = E.buildStageFromSpec(JSON.parse(JSON.stringify(back)));
  ok(sc2.objects.find((o) => o.id === 'police_car') && sc2.objects.find((o) => o.id === 'police_car').kind === 'compound', 'parts 二次构建丢失');
  // array 复制 + mirror 镜像：4 根栅栏柱 + 左右 2 根横梁 = 6 个部件
  const fenceSpec = E.specFromScenePreset('blank');
  fenceSpec.props = [{
    name: '栅栏', parts: [
      { preset: 'box', pos: [0, 0.5, 0], scale: [0.08, 1, 0.08], array: { count: 4, offset: [1, 0, 0] } },
      { preset: 'box', pos: [0.5, 1.05, 0], scale: [2, 0.1, 0.1], mirror: 'x' },
    ],
  }];
  const fence = E.buildStageFromSpec(fenceSpec).objects.find((o) => o.kind === 'compound');
  ok(fence && fence.parts.length === 6, 'parts array/mirror 未展开（实际 ' + (fence && fence.parts.length) + '）');
  const xs = fence ? fence.parts.map((p) => p.pos.x) : [];
  ok(xs.includes(3) && xs.includes(-0.5) && xs.includes(0.5), 'parts array/mirror 位置不对：' + xs.join(','));
}

// ── ④ 场景 + 风格 + 运镜组合 ──
{
  const spec = E.specFromBrief('三个人在会议室开会，10秒', { scene: 'meeting', style: 'suspense', cameraMove: 'arc_left' });
  ok(spec.style === 'suspense', '风格应写入 spec.style');
  ok(spec.cameraMove === 'arc_left' || (spec.shot && spec.shot.cameraMove === 'arc_left'), '运镜应写入 spec');
  const cam = (spec.cameras || [])[0] || {};
  ok(Array.isArray(cam.keys) && cam.keys.length >= 2, '运镜应生成机位关键帧');
  const sc = E.buildStageFromSpec(spec);
  ok(Math.abs(sc.shot.duration - 10) < 1e-6, '时长应保留 10 秒');
  ok(sc.cameras[0].keys && sc.cameras[0].keys.length >= 2, '构建后机位关键帧应保留');
}

// ── ⑤ applyCameraMove 是纯函数，且真的改变机位 ──
{
  const base = E.specFromScenePreset('dialogue2');
  const before = JSON.parse(JSON.stringify(base));
  const out = E.applyCameraMove(base, 'push_in', { duration: 6 });
  ok(JSON.stringify(base) === JSON.stringify(before), 'applyCameraMove 不应修改入参');
  const keys = (out.cameras || [])[0] && out.cameras[0].keys;
  ok(Array.isArray(keys) && keys.length >= 2, 'push_in 应生成 2 个关键帧');
  if (keys && keys.length >= 2) {
    const p0 = keys[0].pos, p1 = keys[keys.length - 1].pos;
    ok(JSON.stringify(p0) !== JSON.stringify(p1), 'push_in 首尾机位应不同');
  }
  // 每个运镜都能生成合法关键帧
  for (const m of (E.CAMERA_MOVES || [])) {
    const s = E.applyCameraMove(base, m.id, { duration: 5 });
    const ks = (s.cameras || [])[0] && s.cameras[0].keys;
    ok(Array.isArray(ks) && ks.length >= 2, '运镜 ' + m.id + ' 未生成关键帧');
  }
}

// ── ⑤b 四/十二方位截图：机位数量/角度/高度分层 ──
{
  const base = E.specFromScenePreset('dialogue2');
  const sc = E.buildStageFromSpec(base);
  const four = E.viewCamerasAround(sc, { count: 4 });
  ok(Array.isArray(four) && four.length === 4, '四方位截图应返回 4 个机位，实际 ' + (four && four.length));
  const twelve = E.viewCamerasAround(sc, { count: 12 });
  ok(Array.isArray(twelve) && twelve.length === 12, '十二方位截图应返回 12 个机位，实际 ' + (twelve && twelve.length));
  if (four && four.length === 4) {
    const keys = four.map((v) => v.pos.map((x) => Math.round(x * 100) / 100).join(','));
    ok(new Set(keys).size === 4, '四方位机位不应重合');
    ok(four.every((v) => Number.isFinite(v.pos[0]) && Number.isFinite(v.pos[1]) && Number.isFinite(v.pos[2])), '方位机位坐标必须合法');
    ok(four.every((v) => v.pos[1] >= 0.3), '方位机位不应钻到地面以下');
  }
  if (twelve && twelve.length === 12) {
    const ys = new Set(twelve.map((v) => Math.round(v.pos[1] * 10) / 10));
    ok(ys.size >= 3, '十二方位应至少分 3 个高度层，实际 ' + ys.size);
  }
  // 纯函数：不改入参
  const before = JSON.stringify(sc);
  E.viewCamerasAround(sc, { count: 4 });
  ok(JSON.stringify(sc) === before, 'viewCamerasAround 不应修改入参场景');
}

// ── ⑤c 手绘运镜：地面路径点 → 相机关键帧 ──
{
  const path = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }];
  const r = E.cameraPathKeys(path, { duration: 4, posY: 1.6, targetY: 1.0, fov: 42 });
  ok(r && Array.isArray(r.keys) && r.keys.length === 3, '手绘运镜应生成 3 个关键帧，实际 ' + (r && r.keys && r.keys.length));
  if (r && r.keys && r.keys.length === 3) {
    ok(Math.abs(r.keys[0].t) < 1e-6 && Math.abs(r.keys[2].t - 4) < 1e-6, '手绘运镜关键帧时间应覆盖 0..duration');
    ok(Math.abs(r.keys[0].pos[1] - 1.6) < 1e-6, '手绘运镜应使用给定机位高度');
    ok(Math.abs(r.keys[1].pos[0] - 2) < 1e-6 && Math.abs(r.keys[1].pos[2]) < 1e-6, '手绘运镜机位应沿路径');
  }
  const one = E.cameraPathKeys([{ x: 1, z: 1 }], { duration: 3 });
  ok(one && one.keys.length >= 2, '单点手绘应退化为两点（至少 2 帧）');
  const bad = E.cameraPathKeys([], { duration: 3 });
  ok(bad && Array.isArray(bad.keys) && bad.keys.length === 0, '空路径应返回空关键帧，不崩溃');
}

// ── ⑤d 角色库：设定集角色 → 场景对象（去重/参考图保留/纯函数）──
{
  const scene = E.buildStageFromSpec(E.specFromScenePreset('blank'));
  const beforeLen = scene.objects.length;
  const char = { name: '陈拾', assetIds: ['asset-a', 'asset-b'] };
  const r = E.addBibleCharacter(scene, char, { x: 1, z: 2 });
  ok(r && r.added === true, '角色库应添加新角色');
  ok(r && r.scene && r.scene.objects.some((o) => o.name === '陈拾'), '角色名应写入场景');
  const added = r && r.scene && r.scene.objects.find((o) => o.name === '陈拾');
  ok(added && Array.isArray(added.refAssetIds) && added.refAssetIds.length === 2, '角色参考图应写入 refAssetIds');
  ok(scene.objects.length === beforeLen, 'addBibleCharacter 不应修改入参场景');
  const dup = E.addBibleCharacter(r.scene, char);
  ok(dup && dup.added === false, '同名角色应去重');
}

// ── ⑤e 运镜/转场预设库：分类/映射/纯函数 ──
{
  const kinds = new Set((E.MOTION_PRESETS || []).map((p) => p.kind));
  ok(kinds.has('camera') && kinds.has('transition') && kinds.has('template'), '预设应覆盖 camera/transition/template 三类');
  const ids = new Set((E.MOTION_PRESETS || []).map((p) => p.id));
  ok(ids.size === (E.MOTION_PRESETS || []).length, '预设 id 不应重复');
  const base = E.specFromScenePreset('dialogue2');
  const before = JSON.stringify(base);
  const move = E.applyMotionPreset(base, 'travel_zoom_in', { duration: 4 });
  ok(move && move.motionPreset === 'travel_zoom_in', '转场应写入 motionPreset');
  ok(move && move.cameras && move.cameras[0].keys && move.cameras[0].keys.length >= 2, '转场应映射到机位关键帧');
  ok(JSON.stringify(base) === before, 'applyMotionPreset 不应修改入参');
  const tpl = E.applyMotionPreset(base, 'storyboard_grid', { duration: 4 });
  ok(tpl && tpl.motionPreset === 'storyboard_grid', '模板预设应可应用');
}

// ── ⑥ Host 工具与客户端入口接线 ──
{
  const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(/action === 'presets'|action === \"presets\"/.test(host), 'Host 缺少 action=presets');
  ok(host.includes('SCENE_PRESETS') || host.includes('scenePresets'), 'Host 未暴露场景预设');
  ok(host.includes('applyCameraMove'), 'Host 未接线 applyCameraMove');
  ok(host.includes('cameraMove'), 'Host 工具未接收 cameraMove');
  ok(host.includes("action === 'edit'") && host.includes('editDirectorSpec'), 'Host 缺少自然语言改景 action=edit');
  ok(host.includes('directorStageList') && host.includes('directorStageBrief'), 'Host 缺少 3D-BOX 库 RPC（list/brief）');
  ok(host.includes('multiStage: true') && host.includes('briefVersion: 2'), 'Host 缺少多 stage / AI brief 能力标记');
  ok(host.includes("name: 'canvas_list_presets'") && host.includes("name: 'canvas_apply_preset'"), 'Host 缺少预设库工具');
  const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(cli.includes('r.briefVersion !== 2') && cli.includes('!r.multiStage'), '客户端未拦截旧 Host（会静默退回本地模板）');
  ok(cli.includes('BoxHome') && cli.includes("'open-3dbox-home'"), '客户端缺少 3D-BOX 库首页入口');
  ok(cli.includes("'boxhome-create'") && cli.includes("'boxhome-open'"), '客户端缺少 3D-BOX 库新建/打开动作');
  ok(cli.includes('dshic-dir-boxbar'), '客户端缺少 3D-BOX 提示条');
  ok(!cli.includes("'box-build'"), '舞台仍保留重复的「生成预演」按钮（应只在库首页）');
  ok(cli.includes("'boxhome-create'") && cli.includes("'boxhome-continue'"), '库首页缺少生成/继续入口');
  ok(cli.includes("'box-edit-input'") && cli.includes("'dir-home'"), '舞台缺少改景输入或返回库入口');
  ok(cli.includes('hostRpcErrText') && cli.includes("'hostStaleHint'"), '缺少旧 Host RPC 的人话兜底');
  ok(cli.includes("'box-edit'") && cli.includes('directorStageEdit'), '客户端缺少「改景」入口或未接 RPC');
  ok(cli.includes("'box-ai-cam'") && cli.includes('directorStageCamera'), '客户端缺少「AI运镜」入口或未接 RPC');
  ok(cli.includes("'box-shot-4'") && cli.includes("'box-shot-12'"), '客户端缺少四/十二方位截图入口');
  ok(cli.includes("'box-to-video'") && cli.includes('toVideoShot'), '客户端缺少 3D→视频节点入口');
  ok(!cli.includes('model3dStart') && !cli.includes('Meshy'), '仍残留第三方 Meshy 3D 集成');
  ok(cli.includes('viewCamerasAround'), '客户端未接线四/十二方位截图');
  ok(cli.includes('cameraPathKeys') && cli.includes("'dir-cam-path-draw'"), '客户端未接线手绘运镜');
  ok(cli.includes("'dir-char-add'") && cli.includes('loadBible'), '客户端缺少角色库入口/设定集接线');
  ok(cli.includes('motion-presets') && cli.includes('MOTION_PRESETS'), '客户端缺少视频节点运镜/转场预设入口');
  ok(cli.includes('video-preflight') && cli.includes('addCharacterRefs'), '客户端缺少视频生成前预检/角色参考入口');
  ok(cli.includes("'video-canvas-ref'") && cli.includes("'video-autolink'"), '客户端缺少画布参考/AutoLink 入口');
  ok(cli.includes("'video-first-frame'") && cli.includes("'video-long-hint'"), '客户端缺少首帧/长视频快捷入口');
  ok(host.includes('specFromBrief'), 'Host 未接线一句话搭景');
  ok(host.includes('AVAILABLE LOCAL ASSETS') && host.includes('Never invent assetId'), 'Host 未把本地资产目录注入 AI prompt');
  ok(host.includes('Parametric prop') && host.includes('parts:[{preset'), 'Host 未把 parts 参数化建模 schema 注入 AI prompt');
  ok(cli.includes('CAMERA_MOVES') || cli.includes('DIRECTOR_MOVES'), '客户端未接线运镜清单');
}

if (errs.length) {
  console.error('✗ 3D-BOX 预设测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 3D-BOX 预设测试通过（9 场景 / 6 风格 / 16+ 运镜 / 组合搭景 / 纯函数 / Host+客户端接线）');
process.exit(0);
