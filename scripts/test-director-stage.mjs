// 3D 导演台回归测试（引擎拆分版）。
//
// 用户需求与边界：
//   · 导演台能力参考了 BeefTV 与即梦，但**只借鉴设计、不复制代码**（BeefTV LICENSE Part A
//     禁止与其混合分发；我们也不引 three.js——单文件插件没有 node_modules）；
//   · 引擎拆分到 assets/director/engine.js（用户要求"代码分割要改"），client.js 只留
//     React 面板，懒加载引擎；
//   · 拖拽必须用坐标轴 gizmo（用户实测：直接拖模型会反向走——根因是叉乘顺序）；
//   · 资产要丰富：12 角色体型 + 13 几何体 + 12 建筑/古风模板，全部白膜、低面数；
//   · 支持上传 Blender 导出的 OBJ。
//
// 本测试两段：A 段直接 ESM import engine.js（引擎是自包含模块，Node 可加载）——
// 测的就是浏览器里跑的同一份文件；B 段源码级锁 client.js 的结构与约束。
//
// 运行：node scripts/test-director-stage.mjs（退出码 0=通过）

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ============================================================
// A 段：引擎模块（同一份 engine.js，Node 直接加载）
// ============================================================
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const v3 = E.v3;

// ---------- A1 场景可序列化 ----------
{
  const s = E.directorDefaultScene('测试布景');
  let err = null;
  try { JSON.stringify(s); } catch (e) { err = e; }
  ok(!err, '默认场景无法 JSON 序列化（' + (err && err.message) + '）');
  ok(s.objects.length >= 2 && s.cameras.length >= 1 && s.lights.length >= 2, '默认场景缺少基本要素');
  ok(s.env && typeof s.env.bg === 'string', '默认场景缺少环境（env）');
  // 往返
  E.saveStageDoc('proj_test', s);
  const back = E.loadStageDoc('proj_test', '测试布景');
  ok(back.objects.length === s.objects.length, 'save→load 往返丢对象');
  ok(Array.isArray(back.env) === false && back.env.preset === s.env.preset && typeof back.env.bg === 'string', '往返后环境丢失');
  // 损坏兜底
  for (const bad of ['{', 'null', '123', '{"objects":"x"}', '{"cameras":[]}']) {
    try { globalThis.localStorage.setItem(E.directorDocKey('proj_bad'), bad); } catch { /* Node 无 localStorage */ }
    const d = E.loadStageDoc('proj_bad', 'x');
    ok(d && Array.isArray(d.objects) && d.cameras.length > 0, '损坏数据（' + bad.slice(0, 12) + '）未回落默认场景');
  }
  const fresh = E.loadStageDoc('never-existed', 'x');
  ok(fresh && Array.isArray(fresh.objects) && fresh.cameras.length > 0, '新项目读不到默认场景');
}

// ---------- A2 相机数学 ----------
{
  const proj = E.directorMat4Perspective(45, 16 / 9, 0.1, 100);
  const apply = (m, p) => {
    const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
    const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
    const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
    const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
    return { x: x / w, y: y / w, z: z / w };
  };
  const mid = apply(proj, { x: 0, y: 0, z: -10 });
  ok(Math.abs(mid.x) < 1e-5 && Math.abs(mid.y) < 1e-5, '透视矩阵把画面中心投偏了');
  const near = apply(proj, { x: 0, y: 0, z: -2 });
  const far = apply(proj, { x: 0, y: 0, z: -50 });
  ok(near.z < far.z, '深度方向反了（近处应更小）');
  const view = E.directorMat4View({ x: 0, y: 2, z: 8 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
  const camPt = apply(view, { x: 0, y: 1, z: 0 });
  ok(Math.abs(camPt.x) < 1e-5 && camPt.z < 0, '视图矩阵没把注视点放到 -z 轴');
  // directorProject：正前方中心 → (0,0)；背后 → null
  const cam = { fov: 42, pos: v3(0, 1.5, 5), target: v3(0, 1, 0) };
  const view2 = E.directorViewOf(cam);
  const nd = E.directorProject(view2.toCam(v3(0, 1, 0)), cam.fov, 16 / 9);
  ok(nd && Math.abs(nd.x) < 1e-5, '正前方点没投影到画面中心');
  const ndBehind = E.directorProject(view2.toCam(v3(0, 1, 9)), cam.fov, 16 / 9);
  ok(ndBehind === null, '相机身后的点应返回 null');
  // 模型矩阵：列主序平移 + 绕 Y 旋转
  const m1 = E.directorMat4Model({ x: 3, y: 4, z: 5 }, 0, { x: 1, y: 1, z: 1 });
  ok(m1[12] === 3 && m1[13] === 4 && m1[14] === 5, '模型矩阵平移不在 [12..14]');
  const rx = apply(E.directorMat4Model({ x: 0, y: 0, z: 0 }, Math.PI / 2, { x: 1, y: 1, z: 1 }), { x: 1, y: 0, z: 0 });
  ok(Math.abs(rx.x) < 1e-5 && Math.abs(rx.z + 1) < 1e-5, '绕 Y 转 90° 后 (1,0,0) 应变 (0,0,-1)');
  const prod = E.directorMat4Multiply(E.directorMat4Identity(), proj);
  ok(Array.from(prod).every((v2, i) => Math.abs(v2 - proj[i]) < 1e-9), '单位矩阵乘法不恒等');
}

// ---------- A3 轴拖拽（拖拽反向 bug 的根治判据） ----------
{
  // 相机在 +Z 看向原点：世界 +X 在屏幕上是向右的。
  // 鼠标向右拖（屏幕坐标 x 增大）→ 轴参数 s 必须增大 → 模型跟手向右。旧实现 right=up×fwd 叉乘
  // 顺序反了，模型往左跑。
  const cam = { fov: 42, pos: v3(0, 2, 6), target: v3(0, 1, 0) };
  const W = 800, H = 500;
  const rayAt = (sx, sy) => E.screenRayDir(cam, W, H, sx, sy);
  const origin = v3(0, 1, 0);
  const sLeft = E.axisDragDelta(origin, v3(1, 0, 0), cam.pos, rayAt(300, 250));
  const sRight = E.axisDragDelta(origin, v3(1, 0, 0), cam.pos, rayAt(500, 250));
  ok(sRight > sLeft, '鼠标向右拖，X 轴参数反而变小（拖拽反向 bug 复发）');
  // Y 轴：鼠标向上拖 → 参数增大
  const sDown = E.axisDragDelta(origin, v3(0, 1, 0), cam.pos, rayAt(400, 350));
  const sUp = E.axisDragDelta(origin, v3(0, 1, 0), cam.pos, rayAt(400, 150));
  ok(sUp > sDown, '鼠标向上拖，Y 轴参数反而变小');
  // Z 轴：Z 指向相机方向；物体「朝相机走」在屏幕上是**向下**变大（透视近大），
  // 所以向下拖 → 参数增大才是跟手。向上拖时物体往远处走、参数变小是对的。
  const sZnear = E.axisDragDelta(origin, v3(0, 0, 1), cam.pos, rayAt(400, 320));
  const sZfar = E.axisDragDelta(origin, v3(0, 0, 1), cam.pos, rayAt(400, 230));
  ok(sZnear > sZfar, '鼠标向下拖（朝相机），Z 轴参数应增大（跟手）');
  // 跟手终判：纯正面机位，鼠标向右拖 120px，X 位移必须是正的（这是「拖反方向」bug 的原始现场）
  const camFront = { fov: 42, pos: v3(0, 1.5, 5), target: v3(0, 1, 0) };
  const sF0 = E.axisDragDelta(origin, v3(1, 0, 0), camFront.pos, E.screenRayDir(camFront, 800, 500, 400, 250));
  const sF1 = E.axisDragDelta(origin, v3(1, 0, 0), camFront.pos, E.screenRayDir(camFront, 800, 500, 520, 250));
  ok(sF1 - sF0 > 0.3, '正面机位鼠标向右拖，X 位移应为正（拖拽反向 bug 现场复现判据）');
}

// ---------- A4 几何：资产库覆盖与低面数 ----------
{
  const kinds = ['box', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'capsule', 'disk', 'half_arc', 'half_cylinder', 'plane', 'body'];
  for (const k of kinds) {
    const o = { id: 't_' + k, kind: k, name: k, pos: v3(0, 0, 0), scale: { x: 1, y: 1, z: 1 }, visible: true };
    const f = E.directorObjectFaces(o);
    ok(f.length > 0, '几何体 ' + k + ' 没有面片');
    ok(f.every((x) => x.v && x.v.length >= 3 && x.v.every((p) => Number.isFinite(p.x + p.y + p.z))), '几何体 ' + k + ' 有非法顶点');
  }
  // 12 角色体型全部出模、面数一致、白膜
  ok(E.ACTOR_PRESETS.length === 12, '角色预设应为 12 个体型，实际 ' + E.ACTOR_PRESETS.length);
  let faceCount = -1;
  for (const p of E.ACTOR_PRESETS) {
    const f = E.directorObjectFaces({ id: 'a_' + p.id, kind: 'actor', preset: p.id, name: p.zh, pos: v3(0, 0, 0), h: 1, visible: true });
    if (faceCount < 0) faceCount = f.length;
    ok(f.length > 0, '体型 ' + p.id + ' 没有面片');
    // 骨骼人偶：所有体型共用同一骨架 + 胶囊肢体，面数必须完全一致
    ok(f.length === faceCount, '体型 ' + p.id + ' 面数与基准不一致（' + f.length + '）——体型必须由同一构建器参数化');
    // 脚底必须落地（y 最小值 ≈ 0）
    const minY = Math.min(...f.flatMap((x) => x.v.map((v2) => v2.y)));
    ok(Math.abs(minY) < 0.02, '体型 ' + p.id + ' 没有落地（minY=' + minY.toFixed(3) + '）');
    // 人偶高度在合理范围
    const maxY = Math.max(...f.flatMap((x) => x.v.map((v2) => v2.y)));
    ok(maxY > p.h * 0.7 && maxY < p.h * 1.3, '体型 ' + p.id + ' 高度异常（' + maxY.toFixed(2) + ' vs 预设 ' + p.h + '）');
  }
  // 人偶面数上限（低面数要求；含肚子盒的体型也不得超）
  const maxFaces = Math.max(...E.ACTOR_PRESETS.map((p) => E.directorObjectFaces({ id: 'm', kind: 'actor', preset: p.id, name: 'm', pos: v3(0, 0, 0), h: 1, visible: true }).length));
  ok(maxFaces <= 700, '人偶面数过多（' + maxFaces + '）——要求圆滑精简');
  // 建筑 12 模板
  ok(E.BUILDING_PRESETS.length >= 12, '建筑模板应 ≥12 个，实际 ' + E.BUILDING_PRESETS.length);
  for (const b of E.BUILDING_PRESETS) {
    const f = b.build(v3(0, 0, 0), 1);
    ok(f.length > 0, '建筑模板 ' + b.id + ' 没有面片');
    const maxY = Math.max(...f.flatMap((x) => x.v.map((v2) => v2.y)));
    ok(maxY > 1, '建筑模板 ' + b.id + ' 高度可疑（' + maxY.toFixed(2) + '）');
    const minY = Math.min(...f.flatMap((x) => x.v.map((v2) => v2.y)));
    ok(minY >= -0.02, '建筑模板 ' + b.id + ' 沉到地下（minY=' + minY.toFixed(3) + '）');
  }
  // 白膜默认色
  ok(E.CLAY === '#e2e4e6', '白膜默认色不是 CLAY #e2e4e6');
  const d = E.directorDefaultScene('x');
  ok(d.objects.every((o) => !o.color || o.color === E.CLAY), '默认场景带颜色（用户要求全部白膜）');
  // 隐藏对象不产生面片
  ok(E.directorObjectFaces({ id: 'h', kind: 'box', pos: v3(0, 0, 0), visible: false }).length === 0, '隐藏对象仍产生面片');
}

// ---------- A5 OBJ 上传 ----------
{
  const obj = [
    '# comment',
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0.5 0.5 1',
    'f 1 2 3', 'f 1 3 4', 'f 1 3 5',
  ].join('\n');
  const r = E.parseObjText(obj, 1.7);
  ok(r.faces.length === 3, 'OBJ 三角形数不对（' + r.faces.length + ' ≠ 3）');
  ok(r.triCount === 3, 'triCount 统计错误');
  // 底部落地
  const minY = Math.min(...r.faces.flatMap((f) => f.v.map((p) => p.y)));
  ok(Math.abs(minY) < 1e-6, 'OBJ 归一化后没有落地（minY=' + minY + '）');
  // 高度归一
  const maxY = Math.max(...r.faces.flatMap((f) => f.v.map((p) => p.y)));
  ok(Math.abs(maxY - 1.7) < 1e-6, 'OBJ 高度没有归一到 1.7（maxY=' + maxY + '）');
  // v/vt/vn 与负索引
  const obj2 = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'vn 0 0 1', 'f 1/1/1 2/1/1 3/1/1', 'f -3//-1 -2//-1 -1//-1'].join('\n');
  const r2 = E.parseObjText(obj2, 1.0);
  ok(r2.faces.length === 2, '带 vt/vn/负索引的 OBJ 解析失败（' + r2.faces.length + '）');
  // 错误路径
  for (const bad of ['', 'v 1 2 3', 'f 1 2 3', 'x'.repeat(901_000)]) {
    let threw = false;
    try { E.parseObjText(bad, 1.7); } catch { threw = true; }
    ok(threw, 'OBJ 输入（' + bad.slice(0, 12) + '…）应抛错而不是静默返回');
  }
  // 超面数（>60000 三角形应抛错提示减面）
  const many = (() => {
    const vs = []; const fs = [];
    for (let i = 0; i < 62_000; i++) { vs.push('v ' + i + ' 0 0'); fs.push('f ' + (i + 1) + ' ' + ((i % 62000) + 1) + ' 1'); }
    return vs.join('\n') + '\n' + fs.join('\n');
  })();
  let threw2 = false;
  try { E.parseObjText(many, 1.7); } catch { threw2 = true; }
  ok(threw2, '面数超限的 OBJ 应抛错提示减面');
}

// ---------- A6 机位预设 ----------
{
  ok(E.CAMERA_PRESETS.length >= 14, '机位预设应 ≥14 个（即梦口径），实际 ' + E.CAMERA_PRESETS.length);
  for (const pid of E.CAMERA_PRESETS.map((x) => x.id)) {
    if (pid === 'current') continue;
    const s = E.directorDefaultScene('x');
    const before = JSON.stringify(s.cameras[0].pos);
    const changed = E.applyCameraPreset(s, pid, 'obj_actor_1');
    ok(changed === true, '机位预设 ' + pid + ' 未生效');
    ok(JSON.stringify(s.cameras[0].pos) !== before, '机位预设 ' + pid + ' 没有移动机位');
    ok(Number.isFinite(s.cameras[0].fov) && s.cameras[0].fov > 10 && s.cameras[0].fov < 130, '机位预设 ' + pid + ' FOV 异常');
    const cam = s.cameras[0];
    ok(Number.isFinite(cam.pos.x + cam.pos.y + cam.pos.z) && Number.isFinite(cam.target.x + cam.target.y + cam.target.z), '机位预设 ' + pid + ' 位置非法');
    // 俯拍类机位要真的在头顶上方
    if (pid === 'bird' || pid === 'top_full') ok(cam.pos.y > 5, pid + ' 应是高空机位（y=' + cam.pos.y.toFixed(1) + '）');
    if (pid === 'low_angle' || pid === 'low_wide') ok(cam.pos.y < 0.8, pid + ' 应是低机位（y=' + cam.pos.y.toFixed(1) + '）');
  }
  // 荷兰角要有 roll
  const s2 = E.directorDefaultScene('x');
  E.applyCameraPreset(s2, 'dutch', null);
  ok((s2.cameras[0].roll || 0) > 5, '荷兰角预设没有设置 roll');
}

// ---------- A7 渲染（Canvas2D 真画 + 环境生效） ----------
{
  function mkCtx2d() {
    const calls = { fillRect: 0, fill: 0, stroke: 0, beginPath: 0, moveTo: 0, lineTo: 0 };
    const seen = { bgFills: new Set() };
    const ctx2 = {
      calls, seen, fillStyle: '', strokeStyle: '', lineWidth: 1,
      fillRect: () => { calls.fillRect++; seen.bgFills.add(ctx2.fillStyle); }, beginPath: () => { calls.beginPath++; },
      moveTo: () => { calls.moveTo++; }, lineTo: () => { calls.lineTo++; },
      closePath: () => {}, fill: () => { calls.fill++; }, stroke: () => { calls.stroke++; },
      setLineDash: () => {}, setTransform: () => {}, createLinearGradient: () => ({ addColorStop: () => {} }),
    };
    return ctx2;
  }
  const scene = E.directorDefaultScene('x');
  const ctx = mkCtx2d();
  const st = E.directorRenderScene(ctx, 640, 400, scene, {});
  ok(st.faces > 0 && st.drawn > 0, 'Canvas2D 没画任何面片');
  ok(ctx.calls.fillRect >= 1, 'Canvas2D 没有铺背景');
  // 环境背景色生效（捕获 fillRect 时刻的 fillStyle，而不是渲染结束后的残留值）
  const scene2 = JSON.parse(JSON.stringify(scene));
  scene2.env.bg = '#102030';
  const ctx2 = mkCtx2d();
  E.directorRenderScene(ctx2, 100, 80, scene2, {});
  ok(ctx2.seen.bgFills.has('#102030'), '环境背景色没有应用到 Canvas2D 渲染（' + [...ctx2.seen.bgFills].join(',') + '）');
  // 关网格：少一批线段
  const scene3 = JSON.parse(JSON.stringify(scene));
  scene3.env.grid = false;
  const ctx3 = mkCtx2d();
  E.directorRenderScene(ctx3, 640, 400, scene3, {});
  ok(ctx3.calls.lineTo < ctx.calls.lineTo, '关闭网格后线段没有减少');
  // 隐藏对象不画
  const scene4 = JSON.parse(JSON.stringify(scene));
  scene4.objects.forEach((o) => { o.visible = false; });
  const ctx4 = mkCtx2d();
  const st4 = E.directorRenderScene(ctx4, 640, 400, scene4, {});
  ok(st4.drawn === 0, '全部隐藏后仍画了面片');
}

// ---------- A8 WebGL 管线判据 ----------
{
  for (const n of ['directorMat4Perspective', 'directorMat4View', 'directorMat4Multiply', 'directorMat4Model', 'directorMat4Identity', 'directorTriangulateFaces', 'createDirectorGlRenderer', 'axisDragDelta', 'screenRayDir']) {
    ok(typeof E[n] === 'function', '引擎缺少 ' + n);
  }
  const quad = [{ v: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }] }];
  ok(E.directorTriangulateFaces(quad).length === 2, '四边形应三角化成 2 个三角形');
  let got = 'unset', threw = null;
  try { got = E.createDirectorGlRenderer({ getContext: () => null }); } catch (e) { threw = e; }
  ok(!threw && got === null, '无 WebGL 时应返回 null 而不是抛错');
  // gizmo 命中（gizmo 原点 = 对象 pos，即 (0,0,0)；**场景相机必须与探针一致**——
  // pickGizmo 内部用的是 scene.cameras，不是外面传的相机）
  const cam = { fov: 42, pos: v3(0, 2, 6), target: v3(0, 1, 0) };
  const scene = E.directorDefaultScene('x');
  scene.objects[0].pos = v3(0, 0, 0);
  scene.cameras[0] = { id: 'cam_main', name: 'cam', pos: { x: 0, y: 2, z: 6 }, target: { x: 0, y: 1, z: 0 }, fov: 42, roll: 0 };
  const view = E.directorViewOf(cam);
  const W = 800, H = 500;
  const projPt = (p) => {
    const nd = E.directorProject(view.toCam(p), cam.fov, W / H);
    return nd ? { x: W / 2 + nd.x * (Math.min(W, H) / 2), y: H / 2 - nd.y * (Math.min(W, H) / 2) } : null;
  };
  {
    const a = projPt(v3(0, 0, 0)), b2 = projPt(v3(0.9, 0, 0));
    ok(a && b2, 'X 轴端点投影失败');
    if (a && b2) {
      const sx = b2.x, sy = b2.y;
      const g = E.directorPickGizmo(scene, 'obj_actor_1', W, H, sx, sy);
      ok(g && g.axis === 'x', 'gizmo 没有命中 X 轴（' + JSON.stringify(g) + '）');
      // 轴中点也应命中
      const gMid = E.directorPickGizmo(scene, 'obj_actor_1', W, H, (a.x + b2.x) / 2, (a.y + b2.y) / 2);
      ok(gMid && gMid.axis === 'x', 'gizmo 轴中点没有命中 X（' + JSON.stringify(gMid) + '）');
    }
  }
  // 远离轴的点应落空（或命中旋转环），但不能报错误的轴
  const gFar = E.directorPickGizmo(scene, 'obj_actor_1', W, H, 20, 20);
  ok(!gFar || gFar.axis === 'rot', '画面角落不应命中坐标轴（' + JSON.stringify(gFar) + '）');
  // 提示词：白膜口径
  const prompt = E.compileDirectorPrompt(scene, { zh: true });
  ok(/白膜|素模|白色/.test(prompt) && /真实人物|真人/.test(prompt), '提示词没有写明白膜→真人的转换要求');
  ok(!/彩色人偶/.test(prompt), '提示词还在说"彩色人偶"（已是白膜口径）');
  const promptEn = E.compileDirectorPrompt(scene, { zh: false });
  ok(/WHITE CLAY|clay/i.test(promptEn) && /real people/i.test(promptEn), '英文提示词没有 clay→real people 要求');
}

// ============================================================
// B 段：client.js 源码级（懒加载、入口、约束）
// ============================================================
{
  ok(/DIRECTOR_ENGINE_REL = 'assets\/director\/engine\.js'/.test(src), 'client.js 没有声明引擎路径（代码分割断裂）');
  ok(/function loadDirectorEngine\(\)/.test(src) && /import\(/.test(src), 'client.js 没有动态 import 引擎（懒加载缺失）');
  // **import 在 dsh-app:// 协议下永远解析不到 HTTP**（用户两次实测截图：相对路径和
  // 根相对路径都被解析成 dsh-app://app/...）。所以加载器必须是两级方案：
  // ① 带 location.origin 的 http 绝对 URL import；② 失败则 fetch 源码 + Blob + blob: URL import
  // （blob: 是绝对 URL，不经过任何协议解析；fetch 走 document base 必然是 http）。
  ok(/import\(origin \+ rel\)/.test(src), '加载器第一级没有用 http 绝对 URL import');
  ok(/createObjectURL\(new Blob\(\[src\], \{ type: 'text\/javascript' \}\)\)/.test(src),
    '加载器没有 fetch+Blob 兜底（dsh-app:// 拦截 import 时引擎永远加载失败——用户实测崩过两次）');
  ok(!/import\('\.\/' \+ DIRECTOR_ENGINE_REL\)/.test(src) && !/import\('\/' \+ NS \+ '\//.test(src.replace(/origin \+ rel/g, '')),
    '仍残留相对/根相对 import（dsh-app:// 协议下必然失败）');
  // **hooks 顺序**：DirectorStage 里所有 use*() 必须在第一个提前 return 之前——
  // 放后面 = 两次渲染 hooks 数量不同 = React #310 整个面板白屏（用户实测）。
  {
    const dsStart = src.indexOf('function DirectorStage()');
    const dsEnd = src.indexOf('左侧图标列（单列）');
    ok(dsStart > 0 && dsEnd > dsStart, 'DirectorStage 函数边界找不到');
    if (dsEnd > dsStart) {
      const body2 = src.slice(dsStart, dsEnd).replace(/\r/g, '');
      const ls = body2.split('\n');
      let ret2 = -1, bad2 = 0;
      ls.forEach((l, i) => { if (ret2 < 0 && /if \(!open\) return null/.test(l)) ret2 = i + 1; });
      ls.forEach((l, i) => { if (ret2 > 0 && i + 1 > ret2 && /use(State|Effect|Ref)\(/.test(l)) bad2++; });
      ok(ret2 > 0, 'DirectorStage 找不到提前 return（加载态分支丢了？）');
      ok(bad2 === 0, 'DirectorStage 有 ' + bad2 + ' 个 hooks 声明在提前 return 之后（React #310 白屏）');
    }
  }
  ok(/h\(DirectorStage\)/.test(src), 'DirectorStage 未挂进画布主区域');
  const railIdx = src.indexOf('function IconRail()');
  const gateIdx = src.indexOf("'open-director'");
  ok(railIdx > 0 && gateIdx > railIdx, '导演台入口不在 IconRail 里');
  // gizmo 交互契约：点对象只选中，轴拖拽才移动
  ok(/directorPickGizmo/.test(src), '面板没有接 gizmo 拾取');
  ok(/mode: isRot \? 'rotate' :/.test(src) && /mode: 'select'/.test(src), '面板没有区分「选中」与「轴/环拖拽」三种模式');
  ok(/rotx|roty|rotz/.test(src), '面板没有接三轴旋转（翻滚需要 rotx/rotz）');
  ok(/ev\.button === 2/.test(src), '右键没有绑定环绕（左键应为平移）');
  ok(/axisDragDelta/.test(src), '轴拖拽没有用射线∩轴求参数（会漂移/反向）');
  // 引擎拆分后 client.js 里不得再内联几何构建（防止两份实现漂移）
  ok(!/function directorActorFaces\(/.test(src), 'client.js 仍内联 directorActorFaces（应只在 engine.js）');
  ok(!/function directorBoxFaces\(/.test(src), 'client.js 仍内联 directorBoxFaces（应只在 engine.js）');
  ok(!/const DIRECTOR_GL_VS/.test(src), 'client.js 仍内联 GL 着色器（应只在 engine.js）');
  // 资产四页签 + 上传
  for (const k of ['dirTabActors', 'dirTabGeom', 'dirTabBuild', 'dirTabCams', 'dirUpload', 'dirTimeline', 'dirStaticPreviz', 'dirDynamicPreviz', 'dirObjects', 'dirProps', 'dirCameras']) {
    ok(src.includes("T('" + k + "')"), '面板缺少文案键 ' + k);
  }
  ok(src.includes('onUpload'), '上传入口缺失');
  ok(/if \(!\/\\\.obj\$\/i\.test\(f\.name\)\)/.test(src), '上传未按扩展名分流（OBJ 走解析，其它类型提示）');
  // MIME：Host 必须把 js 当 text/javascript（否则动态 import 被拒）
  const idxSrc = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(/js: 'text\/javascript/.test(idxSrc), 'Host MIME_BY_EXT 缺少 js —— 动态 import 会被浏览器拒载');
  // 打包：engine.js 必须进包
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok((pkg.files || []).includes('assets/director/*.js'), 'package.json files 没有包含 assets/director/*.js');
  const cpk = readFileSync(path.join(ROOT, 'scripts/check-pack.mjs'), 'utf8');
  ok(/assets\\\/director\\\/\[a-zA-Z0-9\._-\]\+\\\.js/.test(cpk), 'check-pack ALLOWED 没有放行 assets/director/*.js');
  // 反向断言：不引 three.js、不带参考项目标识符
  ok(!/require\(['"]three['"]\)|from ['"]three['"]/.test(src), 'client.js 引入了 three.js');
  const engineSrc = readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8');
  ok(!/require\(|from ['"]/.test(engineSrc.replace(/^[\s\S]*?export const v3/)), 'engine.js 有外部依赖（必须是自包含模块）');
  // **拆分后 client.js 里不得残留引擎函数的裸调用**——拆分漏改一处就是一个
  // "v3 is not defined" 运行时崩（用户实测：点两下面板就白屏）。
  {
    const dsStart = src.indexOf('function DirectorStage()');
    const dsEnd = src.indexOf('左侧图标列（单列）');
    const ds = src.slice(dsStart, dsEnd).replace(/\r/g, '');
    const others = src.slice(0, dsStart) + src.slice(dsEnd);
    const engineNames = ['v3', 'vSub', 'vAdd', 'vMul', 'vDot', 'vCross', 'vLen', 'vNorm', 'vLerp',
      'directorLookAt', 'directorProject', 'directorObjectFaces', 'directorBoxFaces', 'directorSphereFaces',
      'directorCylinderFaces', 'directorActorFaces', 'directorFaceNormal', 'directorShadeColor', 'directorDocKey'];
    for (const n of engineNames) {
      const re = new RegExp('(?<![A-Za-z0-9_.])' + n + '\\s*\\(');
      ok(!re.test(ds), 'DirectorStage 里残留引擎裸调用 ' + n + '( —— 必须经引擎对象（E.' + n + '）访问');
      ok(!re.test(others), 'client.js 非面板区残留引擎裸调用 ' + n + '(');
    }
    ok(!/LS_DIRECTOR|(?<![A-Za-z0-9_])DIRECTOR_VERSION/.test(ds), 'DirectorStage 里残留引擎常量引用');
  }
  for (const banned of ['PerspectiveCamera', 'WebGLRenderer', 'MeshStandardMaterial', 'OrbitControls', 'TransformControls', 'DirectorScene', 'DirectorCamera', 'quaternius']) {
    ok(!src.includes(banned), '源码出现违禁标识符「' + banned + '」');
  }
  // 导出与面板同渲染器
  ok(/exportShot[\s\S]{0,900}E\.createDirectorGlRenderer\(cv\)/.test(src) || /const glOut = E\.createDirectorGlRenderer\(cv\)/.test(src), '导出没有用 WebGL 渲染器（所见非所得）');
}

if (errs.length) {
  console.error('✗ 3D 导演台测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 3D 导演台测试通过（引擎模块 A1-A8：场景/相机/轴拖拽/资产库/OBJ/机位预设/渲染/GL 判据 + B：懒加载/gizmo 契约/打包/许可反向断言）');
process.exit(0);