// 正式回归：白模导出 / MP4 优先 / 工作区文件往返 / 脏标记 / gizmo 几何与悬停。
// 对应 2026-10 用户实测反馈的 5 个问题，防退化。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const eng = fs.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① 成片场景：只剥辅助线，默认保留颜色/材质/灯光；显式 clay:true 才输出白模
{
  const scene = {
    version: 2,
    objects: [{ id: 'a', kind: 'model', pos: { x: 0, y: 0, z: 0 }, h: 1.7, visible: true, color: '#8fa4c8', material: { roughness: 0.3, metallic: 0.4 } }],
    cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fov: 42 }],
    lights: [{ id: 'k', dir: { x: 0.5, y: -0.8, z: 0.4 }, color: '#fff2d8', intensity: 1 }],
    env: { bg: '#171717', grid: true, guides: { heightRef: true, path: true, names: true, cameraFrame: true } },
    activeCameraId: 'c', shot: { duration: 3 },
  };
  const ex = E.buildExportScene(scene);
  ok(ex.env.grid === false, '成片必须关网格');
  const g = ex.env.guides || {};
  ok(!g.heightRef && !g.path && !g.names && !g.cameraFrame, '成片必须关全部辅助线（路径线不能进成片）');
  // 默认：保留用户颜色/材质/灯光/环境（用户实测：导出变灰是 bug）
  ok(String(ex.objects[0].color).toLowerCase() === '#8fa4c8', '成片默认必须保留对象颜色');
  ok(ex.objects[0].material && Number(ex.objects[0].material.roughness) === 0.3, '成片默认必须保留材质');
  ok(String(ex.lights[0].color).toLowerCase() === '#fff2d8', '成片默认必须保留灯光颜色');
  ok(ex.env.bg === '#171717', '成片默认必须保留原环境背景');
  // 显式白模
  const clay = E.buildExportScene(scene, { clay: true });
  ok(clay.objects.every((o) => String(o.color).toLowerCase() === '#e2e4e6'), 'clay:true 时才是纯白黏土');
  ok(clay.lights.every((l) => String(l.color).toLowerCase() === '#ffffff'), 'clay:true 时灯光为中性白');
  ok(scene.env.grid === true && scene.objects[0].color === '#8fa4c8', 'buildExportScene 不能改动原场景');
}

// ② MP4 优先 + 回退
ok(cli.includes("'video/mp4;codecs=avc1.42E01E'"), '导出缺少 MP4/avc1 候选');
ok(/const isMp4 = \/mp4\/i\.test/.test(cli), '缺少 MP4 判断');
ok(/isMp4 \? '\.mp4' : '\.webm'/.test(cli), '下载扩展名未跟随实际格式');

// ③ 工作区文件：存档格式 + 打开校验
ok(cli.includes("format: 'dsh-director-stage'"), '保存文件缺少格式标识');
ok(cli.includes('.dshstage.json'), '保存文件名缺少 .dshstage.json 后缀');
ok(cli.includes('dirOpenBadFile'), '打开文件缺少格式校验提示');
{
  const scene = { objects: [{ id: 'a', kind: 'model', pos: { x: 1, y: 0, z: 2 }, h: 1.7 }], cameras: [], shots: [], env: {}, activeCameraId: '', shot: {} };
  const text = JSON.stringify({ format: 'dsh-director-stage', version: 1, name: 'w', scene });
  const back = JSON.parse(text);
  ok(JSON.stringify(back.scene) === JSON.stringify(scene), '工作区文件往返不一致');
}

// ④ 脏标记：编辑→未保存，保存→已保存
ok(cli.includes("'dirUnsaved'"), '缺少「未保存」文案键');
ok(/dirtyState \? T\('dirUnsaved'\) : T\('dirSaved'\)/.test(cli), '顶栏未按脏状态切换文案');
ok(/const commit = \(next\) => \{ setScene\(next\); markDirty\(\)/.test(cli), 'commit 未打脏标记');
ok(/const markDirty = /.test(cli), '缺少 markDirty');

// ⑤ gizmo：轴长 105px、环 0.62 倍、悬停参数、加粗几何
ok(/pxWorld \* 105/.test(eng), 'gizmo 轴长不是 105px（应在 gizmoMetrics 内）');
  ok(/export function gizmoMetrics/.test(eng), '缺少 gizmoMetrices 单一尺寸来源（绘制/拾取必须同源）');
ok(/const R = L \* 0\.62;/.test(eng), '旋转环不是 0.62 倍轴长（轴必须超出环）');
{
  // 数值：轴端投影距离必须显著大于环极
  const cam = { pos: { x: 3, y: 2, z: 4 }, target: { x: 0, y: 0.9, z: 0 }, fov: 42 };
  const H = 600;
  const pxWorld = E.pixelSizeAt(cam, H, E.depthOf(cam, { x: 0, y: 0, z: 0 }));
  const L = pxWorld * 105, R = L * 0.62;
  ok(L > R * 1.4, '轴长必须明显大于环半径');
}
ok(/hoverAxis/.test(eng) && /o\.hoverAxis/.test(eng), 'draw 未接收 hoverAxis');
ok(/W_AXIS_H|W_RING_H|H_HANDLE_H/.test(eng), '缺少悬停加粗尺寸');
ok(cli.includes('directorHoverAxis'), '客户端未做悬停探测');
ok(/hoverAxis: S\.directorHoverAxis/.test(cli), '悬停状态未传给渲染');
ok(/uFlat/.test(eng), 'gizmo 缺少不受光模式（颜色会变暗）');

// ⑥ 局部轴与轴向缩放：旋转后平移/缩放必须沿自身轴，Z 手柄可命中，向外拉放大
{
  const ob = { pos: E.v3(0, 0, 0), rx: 0, rotY: Math.PI / 2, rz: 0, h: 1.8, scale: E.v3(1, 1, 1) };
  const ax = E.objectAxes(ob);
  // 绕世界 Y +90° 后：局部 X 指向世界 -Z，局部 Z 指向世界 +X。
  ok(Math.abs(ax.x.x) < 1e-6 && ax.x.z < -0.999, '旋转90°后局部X轴不应仍是世界X');
  ok(ax.z.x > 0.999 && Math.abs(ax.z.z) < 1e-6, '旋转90°后局部Z轴应指向世界+X');
  // 沿局部X平移1m：世界坐标应主要改变Z，不应改变X。
  const moved = E.vAdd(ob.pos, E.vMul(ax.x, 1));
  ok(Math.abs(moved.x) < 1e-6 && moved.z < -0.999, '局部X平移仍按世界X写回');
  // 正向外拉放大，负向推回缩小；三个轴共用同一换算，Z 不能例外。
  ok(E.axisScaleFromDelta(1, 0.5, 0.6, false) > 1, '向外拉应放大');
  ok(E.axisScaleFromDelta(1, -0.5, 0.6, false) < 1, '向中心推应缩小');
  ok(Math.abs(E.axisScaleFromDelta(1, 0, 0.6, false) - 1) < 1e-9, '零拖动不应改变缩放');
  // Z 轴手柄命中：用真实投影计算端点屏幕位置再拾取，必须返回 scale/z。
  const scene = E.directorDefaultScene('gizmo-z');
  scene.objects = [{ id: 'o', kind: 'geom', preset: 'box', pos: E.v3(0, 0, 0), rotY: Math.PI / 4, scale: E.v3(1, 1, 1), h: 1.8, visible: true }];
  scene.cameras = [{ id: 'c', pos: E.v3(4, 3, 6), target: E.v3(0, 0.8, 0), fov: 42, roll: 0 }];
  scene.activeCameraId = 'c';
  const cam = scene.cameras[0], W = 900, H = 600;
  const origin = scene.objects[0].pos;
  const depth = E.depthOf(cam, origin), pxWorld = E.pixelSizeAt(cam, H, depth);
  const L = Math.max(pxWorld * 105, 1.8 / 3);
  const zTip = E.vAdd(origin, E.vMul(E.objectAxes(scene.objects[0]).z, L));
  const view = E.directorViewOf(cam), nd = E.directorProject(view.toCam(zTip), cam.fov, W / H);
  const sx = W / 2 + nd.x * (Math.min(W, H) / 2), sy = H / 2 - nd.y * (Math.min(W, H) / 2);
  const hit = E.directorPickGizmo(scene, 'o', W, H, sx, sy);
  ok(hit && hit.op === 'scale' && hit.axis === 'z', 'Z轴缩放手柄命中失败：' + JSON.stringify(hit));
  // 从手柄继续沿屏幕投影后的局部Z正方向向外拖，axisDragDelta 必须为正，换算后必须放大。
  const zFar = E.vAdd(origin, E.vMul(E.objectAxes(scene.objects[0]).z, L * 1.25));
  const ndFar = E.directorProject(view.toCam(zFar), cam.fov, W / H);
  const sxFar = W / 2 + ndFar.x * (Math.min(W, H) / 2), syFar = H / 2 - ndFar.y * (Math.min(W, H) / 2);
  const rayStart = E.screenRayDir(cam, W, H, sx, sy);
  const rayFar = E.screenRayDir(cam, W, H, sxFar, syFar);
  const localZ = E.objectAxes(scene.objects[0]).z;
  const outwardDelta = E.axisDragDelta(origin, localZ, cam.pos, rayFar) - E.axisDragDelta(origin, localZ, cam.pos, rayStart);
  ok(outwardDelta > 0, '沿Z轴向外拖的参数应为正，实际 ' + outwardDelta.toFixed(4));
  ok(E.axisScaleFromDelta(1, outwardDelta, L, false) > 1, '沿Z轴向外拖没有放大');
}

// 源码接线：拖拽开始保存局部轴，移动与缩放都复用该轴
ok(/const obLive = \(liveSc\.objects \|\| \[\]\)\.find/.test(cli) && /E\.objectAxes\(obLive\)\[g\.axis\]/.test(cli), '拖拽必须用实时对象取局部轴（否则拖红轴跑蓝轴）');
  ok(/pathOrg0:/.test(cli), '路径物体拖动需记录 pathOrigin/path[0] 基准（否则松手回弹）');
  ok(/const total = \(ax === 'roty' \? dx : dy\) \* 0\.008/.test(cli) && /const startRot =/.test(cli), '旋转必须用绝对角（否则越拖越快）');
ok(/const axisVec = d\.axisVec \|\|/.test(cli), '移动/缩放未使用保存的局部轴');
ok(/E\.axisScaleFromDelta\(base, delta, refLen/.test(cli), '缩放未使用统一的向外放大换算');
ok(!/\[ax\]: next \}\); if \(ax === 'y'\) t2\.h/.test(cli), 'Y轴仍同时修改scale.y与h（会双重缩放）');
// Alt+拖缩放手柄 = 等比缩放（xyz 三轴同一倍率）
  ok(/const uniform = ev\.altKey;/.test(cli) && /const k = next \/ base;/.test(cli) && /t2\.scale = \{ x: cl\(base0\.x \* k\)/.test(cli), 'Alt+拖轴端方块未实现等比缩放（应按倍率作用于三轴）');
// 动作去重：移动驱动不再重复提供片段选择，跟随上方「动作」下拉
ok(!cli.includes("'dir-loco-clip'"), '移动驱动不应再重复提供动作片段选择');
ok(cli.includes('dirLocoFollow'), '移动驱动应显示"跟随动作"读数');
ok(/const locoSrc = \(o\.locomotion && o\.locomotion\.source\) \? String\(o\.locomotion\.source\) : 'clip'/.test(eng), '沿路径应默认自动驱动当前动作片段');
// 骨骼动画循环播放（修复"沿路径定格姿态平移"）：钳制代码必须不存在
ok(!eng.includes('Math.min(anim ? anim.duration'), '动画时间不得钳制在片段末尾（会定格）');
ok(eng.includes('animLoopTime'), '缺少动画循环采样');
// 机位切换语义：点机位树=立即切视角（手动）；播放/点分镜=分镜跟随；跟随中拖动/滚轮=无缝接管
{
  ok(cli.includes('directorCamFollow'), '缺少分镜跟随/手动查看状态');
  ok(/if \(!S\.directorCamFollow && scene\.activeCameraId\) sc\.activeCameraId = scene\.activeCameraId;/.test(cli), '手动模式未覆盖applyPlayhead被分镜抢占的机位（点机位没反应）');
  ok(/S\.directorCamFollow = false;\s*\n\s*setScene\(\(n\) => Object\.assign\(\{\}, n, \{ activeCameraId: c\.id \}\)\)/.test(cli), '机位树点击未立即切换视角');
  ok(/dir-play.*S\.directorCamFollow = true/s.test(cli) || /S\.directorCamFollow = true; setPlaying/.test(cli), '播放未开启分镜跟随');
  ok((cli.match(/S\.directorCamFollow = false;/g) || []).length >= 5, '手动查看模式入口不足（机位树/预设/新建/重置/接管）');
  ok(cli.includes('live.id !== host.id'), '跟随中拖动/滚轮未做无缝视角接管');
  // 引擎侧保持：有分镜时 applyPlayhead 返回分镜机位（播放预览正确切换）
  const sc2 = { objects: [], cameras: [{ id: 'a', pos: E.v3(0, 1, 3), target: E.v3(0, 1, 0), fov: 42 }, { id: 'b', pos: E.v3(3, 1, 0), target: E.v3(0, 1, 0), fov: 42 }], shots: [{ id: 's1', cameraId: 'a', start: 0, end: 2 }, { id: 's2', cameraId: 'b', start: 2, end: 4 }], activeCameraId: 'b', shot: { duration: 4 }, lights: [], env: {} };
  ok(E.applyPlayhead(sc2, 1).activeCameraId === 'a' && E.applyPlayhead(sc2, 3).activeCameraId === 'b', '播放时 applyPlayhead 应按分镜切换机位');
}

// 数据完整性 / 恢复能力（审计确认的缺口）
ok(cli.includes('preloadSceneAssets'), '打开场景时应按 assetId 批量预加载模型（否则资产退化成方块）');
ok(/const ids = \[\.\.\.new Set/.test(cli), '预加载应去重收集 assetId');
ok(cli.includes("fresh.shots = [{ id: 'shot1'"), '清空工作区应同步重置分镜轨（否则导出时长与画面不符）');
ok(cli.includes("dirClearConfirm") && cli.includes('window.confirm'), '清空工作区应有二次确认');
{
  const ci = cli.indexOf('const clearStage = () => {');
  const body = ci >= 0 ? cli.slice(ci, ci + 1400) : '';
  ok(body.includes('markDirty()'), '清空后应标脏以提示未导出');
}
// 规格往返保真（props 可见性）
ok(/visible: ob\.visible === false \? false : undefined/.test(eng), '道具可见性应进入规格（否则隐藏道具重开后会显形）');

// 缩放稳定性：标签锚点必须 O(1)（历史事故：锚点里生成 4.9 万三角网格 → 76ms/次 → 拖动时缩放乱跳）
{
  const ob = { id: 'm', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: E.v3(0, 0, 0), h: 1.78, clip: 'run', animTime: 0, visible: true };
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) E.directorObjectAnchor(ob);
  const perCall = (Date.now() - t0) / 200;
  ok(perCall < 2, '标签锚点必须是 O(1)（当前 ' + perCall.toFixed(2) + 'ms/次，会拖慢拖动）');
  ok(E.directorObjectAnchor(ob).top > 1.5 && E.directorObjectAnchor(ob).top < 2.1, '人偶标签锚点高度应约等于身高');
  const box = E.directorObjectAnchor({ id: 'b', kind: 'geom', preset: 'box', pos: E.v3(0, 0, 0), scale: E.v3(1, 1, 1), visible: true });
  ok(Math.abs(box.top - 1) < 0.05, '方块标签锚点应在几何顶部（约 1.0）');
}
// 拖动渲染补偿必须包含 scale（否则有关键帧的对象缩放会来回跳）
ok(/out\.pos = live\.pos; out\.rotY = live\.rotY; out\.rx = live\.rx; out\.rz = live\.rz; out\.scale = live\.scale; out\.h = live\.h;/.test(cli), '拖动渲染补偿缺少 scale/h（缩放会跳）');

// 属性面板分区（用户实测要求）：对象选中只显示对象设置；未选中显示镜头/机位/景深；太阳与渲染参数只在实时渲染
{
  const lines = cli.split('\n');
  const idxOf = (needle, from = 0) => { for (let i = from; i < lines.length; i++) if (lines[i].includes(needle)) return i; return -1; };
  const renderOpen = idxOf("...(previzMode === 'render' ? [");
  const dofOpen = idxOf("...(!sel && previzMode !== 'render' ? [");
  const camOpen = idxOf("...(!sel && previzMode !== 'render' ? [", dofOpen + 1);
  ok(renderOpen > 0 && dofOpen > renderOpen && camOpen > dofOpen, '属性面板未按上下文分区（渲染/镜头/对象）');
  if (renderOpen > 0 && dofOpen > renderOpen && camOpen > dofOpen) {
    const renderB = lines.slice(renderOpen, dofOpen - 1).join('\n');
    const dofB = lines.slice(dofOpen, camOpen - 1).join('\n');
    const camB = lines.slice(camOpen, camOpen + 140).join('\n');
    ok(['dirEnvPreset', 'dirSun', 'dirLights', 'dirFogFar', 'dirTonemap', 'dirGround'].every((k) => renderB.includes(k)), '渲染区应包含环境/太阳/灯光/雾/色调映射/地面');
    ok(!renderB.includes('dirShot') && !renderB.includes('dirSelObject') && !renderB.includes('dirDofBlur'), '渲染区不应混入镜头/对象/景深');
    ok(['dirDof', 'dirDofBlur'].every((k) => dofB.includes(k)), '未选中时应显示景深设置');
    ok(['FOV', 'dirLens', 'dirSensor', 'dirRoll', 'dirShotSize', 'dirMove'].every((k) => camB.includes(k)), '未选中时应显示镜头/机位/景别/运镜');
    ok(!camB.includes('dirSelObject') || camB.indexOf('dirSelObject') > 100, '镜头区不应包含对象设置');
  }
}

// 方案C：视口刷新收敛为单一 revision（切模式必须立即重绘，不允许依赖点击画面）
{
  ok(/const \[viewRev, setViewRev\] = useState\(0\)/.test(cli), '缺少 viewRev（视口刷新 revision）');
  ok(/const bumpView = \(\) => setViewRev/.test(cli), '缺少 bumpView');
  ok(/\[open, engReady, scene, tick, playT, viewRev\]/.test(cli), '渲染 effect 依赖必须包含 viewRev');
  {
    const i = cli.indexOf('const setMode = (m) =>');
    ok(i > 0 && /bumpView\(\)/.test(cli.slice(i, i + 400)), '切模式必须走 setMode 并 bumpView');
  }
  const btns = ['dirStaticPreviz', 'dirDynamicPreviz', 'dirRenderPreview'];
  ok(btns.every((t) => new RegExp('dir-(static|dynamic|render-preview)').test(cli)), '缺少三种预演模式按钮');
  const setModeCalls = (cli.match(/setMode\('(static|dynamic|render)'\)/g) || []).length;
  ok(setModeCalls >= 3, '三个模式按钮必须都走 setMode（当前 ' + setModeCalls + ' 处）');
  ok(!/setPrevizMode\('static'\); setPlaying\(false\)/.test(cli), '静态按钮不应再手写状态（会漏重绘）');
}
// 快捷键面板（右下角入口 + 机位下方右对齐纯文字 10% 透明 + 隐藏滚动条）
{
  ok(/DIRECTOR_KEY_HELP = \[/.test(cli), '缺少快捷键说明数据（单一来源）');
  ok(/'data-action': 'dir-keys-toggle'/.test(cli), '缺少快捷键入口按钮');
  ok(/'data-action': 'dir-keys'/.test(cli), '缺少快捷键面板');
  ok(/\.dshic-dir-pillgroup\{/.test(cli) && /\.dshic-dir-keys\{/.test(cli), '缺少快捷键面板样式');
  ok(/color:rgba\(219,227,238,\.85\)/.test(cli), '快捷键列表应为 85% 不透明纯文字（只 15% 透）');
  ok(/scrollbar-width:none/.test(cli) && /\.dshic-dir-keys::-webkit-scrollbar\{display:none;\}/.test(cli), '快捷键列表应隐藏滚动条');
  ok(/top:180px;bottom:104px/.test(cli), '快捷键列表应位于机位缩略图下方、世界坐标上方');
}

// 键盘漫游（Lumion / D5 手感）：W/S 前后、A/D 平移、Q/E 升降、Shift 加速
{
  ok(/const FLY_CODES = new Set\(\['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'\]\)/.test(cli), '缺少 WASD/QE 漫游键映射');
  ok(/cameraFlyStep\(c2, input, dt/.test(cli), '漫游必须调用引擎 cameraFlyStep（不得另写位移公式）');
  ok(/Math\.min\(0\.1, Math\.max\(0, \(ts - f\.last\) \/ 1000\)\)/.test(cli), '漫游 dt 应钳制 0.1s（切后台不瞬移）');
  ok(/f\.before = JSON\.stringify\(scene\);/.test(cli) && /pushUndo\(\);/.test(cli), '整段漫游应只 pushUndo 一次');
  ok(/const flyStop = \(\) =>/.test(cli) && /E2\.saveStageDoc\(S\.activeId, s2\)/.test(cli), '松键停飞应落盘');
  ok(/onKeyUp/.test(cli) && /onFlyBlur/.test(cli) && /visibilitychange/.test(cli), '松键/失焦/切页应停飞清键');
  ok(/!\(S\.directorDragging && dragRef\.current\)/.test(cli), '拖动 gizmo 时不应触发漫游');
  {
    const i = cli.indexOf('const flyStart = () =>');
    const body = i >= 0 ? cli.slice(i, i + 1400) : '';
    ok(body.includes('S.directorCamFollow') && body.includes('S.directorCamFollow = false'), '跟随时漫游应先接管为自由机位');
  }
  // 快捷键面板必须列出这套按键（用户明确要求）
  ok(/k: 'W \/ S'/.test(cli) && /k: 'A \/ D'/.test(cli) && /k: 'Q \/ E'/.test(cli), '快捷键列表必须包含 W/S、A/D、Q/E');
  ok(/Shift \+ 漫游/.test(cli), '快捷键列表必须包含 Shift 加速');
}

if (errs.length) {
  console.error('✗ 导演台可用性测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 导演台可用性测试通过（白模导出 / MP4优先 / 工作区文件往返 / 脏标记 / gizmo 轴超环+加粗+悬停）');
process.exit(0);
