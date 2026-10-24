// 正式回归：渲染管线（WebGL2 + shadow map + PCF）与路径/成片分离
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const src = fs.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① 渲染后端：WebGL2 优先 + 阴影贴图资源
ok(/getContext\('webgl2'/.test(src), '未优先请求 WebGL2（深度纹理必需）');
ok(/getContext\('webgl', \{ antialias: true/.test(src), '缺少 WebGL1 回退');
ok(/gl\.DEPTH_COMPONENT24/.test(src), '阴影贴图未使用 DEPTH_COMPONENT24 深度纹理');
ok(/createFramebuffer/.test(src), '缺少阴影 FBO');
ok(/checkFramebufferStatus/.test(src), '缺少 FBO 完整性检查');

// ② 阴影采样：Blender PCF（法线偏移 + 斜率 bias + 核半径 + 多次采样）
ok(/float shadowFactor\(vec3 wp, vec3 n, vec3 l\)/.test(src), '缺少 shadowFactor');
ok(/float bias = uShadowBias \* \(0\.4 \+ slope\);/.test(src), '缺少斜率相关 bias（会 acne）');
ok(/vec3 P = wp \+ n \* bias \* 2\.0;/.test(src), '缺少法线偏移');
ok(/uShadowRadius/.test(src), 'PCF 缺少 filter radius');
ok(/for \(int y = -1; y <= 1; y\+\+\)/.test(src), 'PCF 核不是 3x3');
ok(/orenNayar\(n, Lk, V, rough\) \* sh/.test(src), '阴影未参与主光计算（应先算阴影再乘漫反射）');

// ③ 阴影 pass：光源正交矩阵 + 深度 pass
ok(/export function directorMat4Ortho/.test(src), '缺少正交投影矩阵');
ok(/const computeShadowVP = \(scene\) =>/.test(src), '缺少光源视投影矩阵计算');
ok(/const shadowVP = \(o\.shadows !== false && env\.shadowOn !== false\) \? renderShadowMap\(scene\) : null;/.test(src), 'draw 未调用阴影 pass（含 env.shadowOn 开关）');
ok(/env\.shadowOn !== false/.test(src), '阴影应支持 env.shadowOn 开关（渲染面板可关）');
ok(/gl\.useProgram\(prog\);            \/\/ 阴影 pass 切过 program/.test(src), '阴影 pass 后未切回主 program（会导致整帧不画）');

// ④ 路径/成片分离
ok(/if \(!o\.renderOnly\) \{/.test(src), '路径/辅助元素未按 renderOnly 隔离');
ok(/const org = o\.pathOrigin \|\| o\.path\[0\];/.test(src), '路径未按 pathOrigin 锚定（会产生瞬移）');

// ⑤ 路径锚定语义：t=0 不移动
{
  const scene = { version: 2, objects: [{ id: 'o', kind: 'model', pos: { x: 1, y: 0, z: 2 }, h: 1.7, pathOrigin: { x: 1, y: 0, z: 2 }, pathMode: 'curve', path: [{ x: -2, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 2, y: 0, z: 1 }] }],
    cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fov: 45, keys: [] }], lights: [], env: {}, activeCameraId: 'c', shot: { duration: 3 } };
  const p0 = E.applyPlayhead(scene, 0).objects[0].pos;
  ok(Math.abs(p0.x - 1) < 0.01 && Math.abs(p0.z - 2) < 0.01, 't=0 应停在 pathOrigin，实际 ' + p0.x + ',' + p0.z);
  const p3 = E.applyPlayhead(scene, 3).objects[0].pos;
  // 终点 = origin + (last - first) = (1+4, 2+0) = (5, 2)
  ok(Math.abs(p3.x - 5) < 0.02 && Math.abs(p3.z - 2) < 0.02, '终点应为 origin+(last-first)=(5,2)，实际 ' + p3.x + ',' + p3.z);
  ok(Math.abs(p3.x - p0.x) > 1, '物体应真的沿路径移动');
}

// ⑤ 路径自动转向：rotY 应跟随切线变化
{
  const scene = {
    version: 2,
    objects: [{ id: 'o', kind: 'model', pos: { x: 0, y: 0, z: 0 }, h: 1.7, pathOrigin: { x: 0, y: 0, z: 0 }, pathMode: 'curve',
      path: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }] }],
    cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fov: 45, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: 3 },
  };
  const r0 = E.applyPlayhead(scene, 0).objects[0];
  const r1 = E.applyPlayhead(scene, 1.5).objects[0];
  const r2 = E.applyPlayhead(scene, 3).objects[0];
  ok(typeof r1.rotY === 'number', '路径运动时 rotY 应为数字');
  ok(Math.abs(r1.rotY - r0.rotY) > 0.05, '路径转向：t=1.5 朝向应与起点不同（' + (r0.rotY || 0).toFixed(2) + ' → ' + (r1.rotY || 0).toFixed(2) + '）');
  ok(Math.abs(r2.rotY - r1.rotY) > 0.1, '路径转向：末段朝向应继续变化（' + r1.rotY.toFixed(2) + ' → ' + r2.rotY.toFixed(2) + '）');
  // pathFace=false 时不转向
  const noFace = JSON.parse(JSON.stringify(scene));
  noFace.objects[0].pathFace = false;
  const rf = E.applyPlayhead(noFace, 1.5).objects[0];
  ok(Math.abs((rf.rotY || 0) - 0) < 1e-6, 'pathFace=false 时不应自动转向');
}

// ⑥ 拾取必须用「动画后位置」：按实时位置能选中、按静态位置选不中
{
  const scene = {
    version: 2,
    objects: [{ id: 'mover', kind: 'geom', preset: 'box', pos: { x: 0, y: 0, z: 0 }, h: 1.78, scale: { x: 0.5, y: 1.78, z: 0.5 }, visible: true,
      keys: [{ t: 0, pos: { x: 0, y: 0, z: 0 }, rotY: 0, rx: 0, rz: 0 }, { t: 2, pos: { x: 3, y: 0, z: 0 }, rotY: 0, rx: 0, rz: 0 }] }],
    cameras: [{ id: 'c', pos: { x: 1.5, y: 2, z: 6 }, target: { x: 1.5, y: 1, z: 0 }, fov: 45, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: 3 },
  };
  const W = 800, H = 600;
  const live = E.applyPlayhead(scene, 2);
  const cam = scene.cameras[0];
  const project = (sc, p) => {
    const view = E.directorViewOf(cam);
    const nd = E.directorProject(view.toCam(p), cam.fov, W / H);
    return nd ? { x: W / 2 + nd.x * (Math.min(W, H) / 2), y: H / 2 - nd.y * (Math.min(W, H) / 2) } : null;
  };
  const liveOb = live.objects[0];
  const sp = project(live, { x: liveOb.pos.x, y: 0.9, z: liveOb.pos.z });
  ok(!!sp, '实时位置应可投影到屏幕');
  if (sp) {
    const hitLive = E.directorPickObject(live, W, H, sp.x, sp.y);
    const hitStatic = E.directorPickObject(scene, W, H, sp.x, sp.y);
    ok(hitLive && hitLive.id === 'mover', '按实时位置应能选中物体（修「动画后选不中」）');
    ok(!hitStatic, '按静态位置(未动画)在其中同一屏幕点应选不中（证明必须用实时场景）');
  }
}

if (errs.length) {
  console.error('✗ 渲染管线/路径测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 渲染管线/路径测试通过（WebGL2+深度纹理+FBO / PCF 斜率bias+法线偏移+核半径 / 阴影pass接线 / 路径锚定不瞬移 / 成片隔离）');
process.exit(0);
