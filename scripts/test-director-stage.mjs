// 3D 导演台回归测试。
//
// 用户需求：给无限画布加 3D 导演台，入口放左侧图标列。参考项目 BeefTV 的导演台是
// three.js + @react-three/fiber 的 React 组件树（GLB 角色 + 骨骼 + IK），我们**不能复制它的代码**
// （其 LICENSE Part A 禁止与我们 Apache-2.0 的包混合分发），也不能引 three.js——
// 本插件是单文件、无构建步骤、无 node_modules 的浏览器插件。
//
// 所以 v1 用 Canvas2D + 画家算法做软件渲染：零依赖、零体积、接口稳定（将来换 WebGL 只换
// directorRenderScene 的实现，其余不动）。本测试锁死这些判据：
//   ① 场景数据可序列化（纯 JSON，不能夹带 DOM/函数/循环引用）→ 否则存不进 localStorage
//   ② 相机数学正确：正前方投影到画面中心、背后点返回 null、FOV 变宽则同一点更靠中间
//   ③ 几何构建：每种 primitive 都有面片；隐藏对象不产生面片
//   ④ 渲染：真的画出像素（不是空画布）、面片确实被绘制、开启网格时有网格线
//   ⑤ 拾取：点画面的对象中心能选中它、点空白命中 null
//   ⑥ 提示词编译：必须写明"人偶要画成真人"（否则视频模型会把蓝色人偶画成蓝色人），
//      且带景别/机位高度/运镜/站位映射
//   ⑦ 持久化：save→load 往返一致；损坏数据回落到默认场景不抛错
//   ⑧ 源码级：图标列有导演台入口；导演台挂进了画布主区域
//
// 运行：node scripts/test-director-stage.mjs（退出码 0=通过）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM / localStorage ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const noop = () => {};
// 2D canvas 桩：记录调用，能回答「填了几次」「画了几条线」
function mkCtx2d() {
  const calls = { fillRect: 0, fill: 0, stroke: 0, beginPath: 0, moveTo: 0, lineTo: 0, arc: 0 };
  const ctx = {
    calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: () => { calls.fillRect++; },
    beginPath: () => { calls.beginPath++; },
    moveTo: () => { calls.moveTo++; },
    lineTo: () => { calls.lineTo++; },
    closePath: () => {},
    fill: () => { calls.fill++; },
    stroke: () => { calls.stroke++; },
    arc: () => { calls.arc++; },
    setLineDash: () => {},
    setTransform: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  return ctx;
}
let lastCtx = null;
const elStub = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '',
  appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 }),
  getContext: (kind) => { if (kind === '2d') { lastCtx = mkCtx2d(); return lastCtx; } return new Proxy({}, { get: () => noop, set: () => true }); },
  toDataURL: () => 'data:,', toBlob: (cb) => cb({ type: 'image/png', size: 1234 }),
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
const documentStub = {
  createElement: (tag) => { const el = elStub(); if (tag === 'canvas') el.captureStream = () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] }); return el; },
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null,
  addEventListener: noop, removeEventListener: noop,
};
const lsStore = new Map();
const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };

const PID = 'p_director';
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '导演台测试', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-director-stage', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  Image: class { constructor() { this.src = ''; } },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => { const req = {}; setTimeout(() => { try { req.onerror && req.onerror(); } catch { /* 忽略 */ } }, 0); return req; } },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
if (!mod) { console.error('✗ client.js 顶层执行失败'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });

const D = sandbox.window.__DSH_IC_DIRECTOR__;
if (!D) { console.error('✗ 未暴露 window.__DSH_IC_DIRECTOR__（导演台测试缝隙缺失）'); process.exit(1); }

// ============================================================
// ① 场景数据可序列化（存进 localStorage 的前提）
// ============================================================
{
  const scene = D.directorDefaultScene();
  let json = null, threw = null;
  try { json = JSON.stringify(scene); } catch (e) { threw = e; }
  ok(!threw, '默认场景无法序列化成 JSON（' + (threw && threw.message) + '）——存不进 localStorage');
  ok(typeof json === 'string' && json.length > 100, '默认场景序列化结果为空');
  const back = JSON.parse(json);
  ok(back.version === 1, '场景缺少 version:1（后续结构升级要靠它判断迁移）');
  ok(Array.isArray(back.objects) && back.objects.length >= 2, '默认场景应有至少 2 个演员，实际 ' + (back.objects || []).length);
  ok(Array.isArray(back.cameras) && back.cameras.length >= 1, '默认场景应有至少 1 个机位');
  ok(Array.isArray(back.lights) && back.lights.length >= 2, '默认场景应有主光 + 环境光两盏灯');
  ok(!!back.activeCameraId, '默认场景缺少 activeCameraId（渲染找不到机位就会白屏）');
  ok(back.shot && Number(back.shot.duration) > 0, '默认场景缺少镜头时长');
  // 每个对象都必须有 pos/scale/rotY 这些渲染必需的字段
  for (const o of back.objects) {
    ok(o.id && o.pos && Number.isFinite(o.pos.x) && Number.isFinite(o.pos.y) && Number.isFinite(o.pos.z), '对象 ' + o.id + ' 缺少有效 pos');
    ok(o.scale && Number.isFinite(o.scale.y), '对象 ' + o.id + ' 缺少有效 scale');
    ok(Number.isFinite(Number(o.rotY)), '对象 ' + o.id + ' 的 rotY 不是数字');
  }
}

// ============================================================
// ② 相机数学
// ============================================================
{
  const cam = D.directorLookAt({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  // 正前方的点 → 相机空间 z 为负
  const front = cam.toCam({ x: 0, y: 0, z: 0 });
  ok(front.z < 0, '注视点在相机空间应为负 z（相机看 -z），实际 ' + front.z);
  ok(Math.abs(front.x) < 1e-6 && Math.abs(front.y) < 1e-6, '注视点应投到画面正中，实际 x=' + front.x + ' y=' + front.y);
  // 投影：中心点 → (0,0)
  const p0 = D.directorProject(front, 45, 16 / 9);
  ok(p0 && Math.abs(p0.x) < 1e-6 && Math.abs(p0.y) < 1e-6, '注视点应投到 (0,0)');
  // 相机身后的点 → null（不能画到画面上）
  ok(D.directorProject(cam.toCam({ x: 0, y: 0, z: 20 }), 45, 16 / 9) === null, '相机身后的点应返回 null（否则会画出鬼影）');
  // 偏移点 → 有 x 偏移；FOV 变宽 → 归一化坐标变小（同样物理位置更靠画面中间）
  const off = cam.toCam({ x: 1, y: 0, z: 0 });
  const narrow = D.directorProject(off, 30, 16 / 9);
  const wide = D.directorProject(off, 90, 16 / 9);
  ok(narrow && wide, '偏移点投影失败');
  ok(Math.abs(wide.x) < Math.abs(narrow.x), 'FOV 变大时同一点应更靠画面中心（narrow=' + narrow.x + ' wide=' + wide.x + '）');
  ok(narrow.y === 0 && wide.y === 0, '水平偏移点的 y 应为 0');
}

// ============================================================
// ③ 几何构建
// ============================================================
{
  const scene = D.directorDefaultScene();
  const actor = scene.objects.find((o) => o.kind === 'actor');
  const af = D.directorActorFaces(actor);
  ok(af.length >= 20, '人形占位体面片太少（' + af.length + '），轮廓会看不出人形');
  ok(af.every((f) => Array.isArray(f.v) && f.v.length >= 3), '人形面片存在非法顶点数组');
  ok(af.every((f) => f.v.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))), '人形面片存在 NaN 顶点（会导致整帧消失）');
  for (const kind of ['box', 'sphere', 'cylinder', 'plane']) {
    const ob = { id: 't_' + kind, kind, name: kind, color: '#888888', pos: { x: 0, y: 0, z: 0 }, rotY: 0, scale: { x: 1, y: 1, z: 1 }, visible: true };
    const fs = D.directorObjectFaces(ob);
    ok(fs.length > 0, 'primitive「' + kind + '」没有产生任何面片（渲染会缺件）');
    ok(fs.every((f) => f.v.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))), 'primitive「' + kind + '」存在 NaN 顶点');
  }
  // 隐藏对象不产生面片
  const hidden = { id: 't_h', kind: 'box', name: 'h', color: '#888888', pos: { x: 0, y: 0, z: 0 }, rotY: 0, scale: { x: 1, y: 1, z: 1 }, visible: false };
  ok(D.directorObjectFaces(hidden).length === 0, '隐藏对象不应产生面片');
  // 旋转 90° 的方块：包围盒交换 X/Z 宽深
  const flat = { id: 'r', kind: 'box', name: 'r', color: '#888888', pos: { x: 0, y: 0, z: 0 }, rotY: Math.PI / 2, scale: { x: 2, y: 1, z: 0.5 }, visible: true };
  const rf = D.directorObjectFaces(flat);
  ok(rf.length === 6, '方块应有 6 个面，实际 ' + rf.length);
}

// ============================================================
// ④ 渲染：真的画出东西
// ============================================================
{
  const scene = D.directorDefaultScene();
  const ctx = mkCtx2d();
  const stats = D.directorRenderScene(ctx, 900, 600, scene, { selectedId: null });
  ok(stats.faces > 0, '渲染没有收集到任何面片（场景是空的？）');
  ok(stats.drawn > 0, '没有任何面片被绘制（画家算法把全部面片都判为背面/出界了）');
  ok(ctx.calls.fill > 0, '没有发生任何 fill（画布会是空的）');
  ok(ctx.calls.fillRect > 0, '没有画背景（会露出上一帧残影）');
  ok(ctx.calls.lineTo > 0, '没有画任何线段（地面网格/机位指示缺失）');
  ok(ctx.calls.stroke > 0, '没有 stroke（网格或选中高亮没画）');
  // 关掉网格后 lineTo 应显著减少（网格是最大的线段来源）
  const ctx2 = mkCtx2d();
  D.directorRenderScene(ctx2, 900, 600, scene, { grid: false });
  ok(ctx2.calls.lineTo < ctx.calls.lineTo, 'grid:false 时线段数应减少（网格开关无效）');
  // 空场景不抛错
  const empty = { version: 1, objects: [], cameras: scene.cameras, lights: scene.lights, activeCameraId: scene.activeCameraId, shot: scene.shot };
  let threw = null;
  const ctx3 = mkCtx2d();
  try { D.directorRenderScene(ctx3, 900, 600, empty, {}); } catch (e) { threw = e; }
  ok(!threw, '空场景渲染抛错（' + (threw && threw.message) + '）——用户删光对象后画布会崩');
  // 缺机位不抛错（损坏数据兜底）
  let threw2 = null;
  try { D.directorRenderScene(mkCtx2d(), 900, 600, { objects: [], cameras: [], lights: [] }, {}); } catch (e) { threw2 = e; }
  ok(!threw2, '没有机位时渲染抛错（应静默返回）');
}

// ============================================================
// ⑤ 拾取
// ============================================================
{
  // 用一个「正对镜头、目标就在画面中心」的场景，让中心点必然命中
  const scene = {
    version: 1,
    objects: [
      { id: 'center_box', kind: 'box', name: '居中方块', color: '#ff0000', pos: { x: 0, y: 0, z: 0 }, rotY: 0, scale: { x: 1.2, y: 1.2, z: 1.2 }, visible: true },
      { id: 'far_right', kind: 'box', name: '右侧方块', color: '#00ff00', pos: { x: 6, y: 0, z: 0 }, rotY: 0, scale: { x: 1, y: 1, z: 1 }, visible: true },
    ],
    cameras: [{ id: 'c', name: 'cam', pos: { x: 0, y: 0.6, z: 5 }, target: { x: 0, y: 0.6, z: 0 }, fov: 45 }],
    lights: [{ id: 'l', dir: { x: 0.4, y: -0.8, z: 0.3 }, intensity: 1 }],
    activeCameraId: 'c',
    shot: { duration: 5 },
  };
  const hitCenter = D.directorPickObject(scene, 900, 600, 450, 300);
  ok(hitCenter && hitCenter.id === 'center_box', '点画面中心应命中居中方块，实际 ' + (hitCenter && hitCenter.id));
  const hitBlank = D.directorPickObject(scene, 900, 600, 20, 20);
  ok(hitBlank === null, '点左上角空白应命中 null，实际 ' + (hitBlank && hitBlank.id));
  // 隐藏对象不可拾取
  const hiddenScene = JSON.parse(JSON.stringify(scene));
  hiddenScene.objects[0].visible = false;
  ok(D.directorPickObject(hiddenScene, 900, 600, 450, 300) === null, '隐藏对象不应被拾取');
}

// ============================================================
// ⑥ 提示词编译：必须把"人偶→真人"写进去
// ============================================================
{
  const scene = D.directorDefaultScene();
  const zh = D.compileDirectorPrompt(scene, { zh: true });
  ok(typeof zh === 'string' && zh.length > 80, '中文提示词过短（编译失败？）');
  // 最关键的一条：不写这句，视频模型会把蓝/黄人偶原样画成彩色人偶
  ok(/必须画成真实人物|不要保留人偶的颜色/.test(zh), '中文提示词缺少「人偶必须画成真人」的硬要求——视频会生成彩色人偶');
  ok(/机位[：:]/.test(zh), '中文提示词缺少机位描述');
  ok(/人物站位与身份映射/.test(zh), '中文提示词缺少人物站位/身份映射');
  ok(/镜头时长/.test(zh), '中文提示词缺少镜头时长');
  // 景别/运镜用的是中文字面量，不能漏成 id
  ok(!/shotSize|cameraMove|extreme_wide|push_in/.test(zh), '中文提示词里漏出了字段名/枚举 id（' + zh.slice(0, 200) + '）');
  const en = D.compileDirectorPrompt(scene, { zh: false });
  ok(/render real people|never keep the mannequin/i.test(en), '英文提示词缺少「mannequin → real people」硬要求');
  // 空布景也要能编译（不能抛错）
  let threw = null;
  const emptyScene = { shot: { duration: 3 }, cameras: [{ id: 'c', pos: { x: 0, y: 1.5, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 40 }], objects: [], activeCameraId: 'c', lights: [] };
  let text = '';
  try { text = D.compileDirectorPrompt(emptyScene, { zh: true }); } catch (e) { threw = e; }
  ok(!threw, '空布景编译提示词抛错（' + (threw && threw.message) + '）');
  ok(text.length > 20, '空布景编译出的提示词为空');
  // 机位高度推断：高机位应写"俯拍"，低机位写"仰拍"
  const high = JSON.parse(JSON.stringify(emptyScene));
  high.cameras[0].pos = { x: 0, y: 6, z: 3 };
  ok(/俯拍/.test(D.compileDirectorPrompt(high, { zh: true })), '高机位未识别为俯拍');
  const low = JSON.parse(JSON.stringify(emptyScene));
  low.cameras[0].pos = { x: 0, y: 0.3, z: 3 };
  low.cameras[0].target = { x: 0, y: 1.6, z: 0 };
  ok(/仰拍/.test(D.compileDirectorPrompt(low, { zh: true })), '低机位未识别为仰拍');
}

// ============================================================
// ⑦ 持久化：save→load 往返 + 损坏数据兜底
// ============================================================
{
  const scene = D.directorDefaultScene();
  scene.title = '测试布景';
  scene.objects.push({ id: 'obj_extra', kind: 'sphere', name: '球', color: '#123456', pos: { x: 2, y: 0, z: -1 }, rotY: 0, scale: { x: 1, y: 1, z: 1 }, visible: true });
  ok(D.saveStageDoc(PID, scene) === true, '保存导演台场景失败');
  const back = D.loadStageDoc(PID);
  ok(back.title === '测试布景', '往返后标题丢失（' + back.title + '）');
  ok(back.objects.some((o) => o.id === 'obj_extra'), '往返后新增对象丢失');
  ok(back.objects.find((o) => o.id === 'obj_extra').color === '#123456', '往返后对象颜色丢失');
  // 损坏数据：不能抛错，必须回落到默认场景
  for (const bad of ['{not json', 'null', '[]', JSON.stringify({ version: 99, objects: [] }), JSON.stringify({ version: 1, objects: 'nope' })]) {
    lsStub.setItem(D.directorDocKey(PID), bad);
    let threw = null, got = null;
    try { got = D.loadStageDoc(PID); } catch (e) { threw = e; }
    ok(!threw, '损坏数据「' + String(bad).slice(0, 24) + '」让 loadStageDoc 抛错（导演台会打不开）');
    ok(got && Array.isArray(got.objects) && got.cameras.length > 0, '损坏数据「' + String(bad).slice(0, 24) + '」未回落到可用默认场景');
  }
  // 未知 projectId 也要能开
  const fresh = D.loadStageDoc('never-existed');
  ok(fresh && Array.isArray(fresh.objects) && fresh.cameras.length > 0, '新项目的导演台读不到默认场景');
}

// ============================================================
// ⑧ 源码级：入口与挂载
// ============================================================
{
  ok(/data-action': 'open-director'/.test(src) || /'open-director'/.test(src), '左侧图标列缺少导演台入口（data-action=open-director）');
  ok(/h\(DirectorStage\)/.test(src), 'DirectorStage 未挂进画布主区域');
  ok(/function DirectorStage\(/.test(src), 'DirectorStage 组件不存在');
  ok(/function directorRenderScene\(/.test(src), 'directorRenderScene 不存在（渲染器被删）');
  ok(/function directorPickObject\(/.test(src), 'directorPickObject 不存在（拾取被删）');
  ok(/function compileDirectorPrompt\(/.test(src), 'compileDirectorPrompt 不存在（提示词编译被删）');
  // 入口必须在图标列内部（不是别处凑的）
  const railIdx = src.indexOf('function IconRail()');
  const gateIdx = src.indexOf("'open-director'");
  ok(railIdx > 0 && gateIdx > railIdx, '导演台入口不在 IconRail 里（挂错位置）');
  // 反向断言：不得 require three.js（单文件插件没有 node_modules）
  ok(!/require\('three'\)|from ['"]three['"]/.test(src), 'client.js 引入了 three.js——本插件是单文件无构建步骤，装不了 npm 依赖');
  // 反向断言：不得出现 BeefTV 的标识符（我们只借鉴设计，不复制代码）
  for (const banned of ['DirectorScene', 'DirectorCamera', 'directorPoseBoneDeltas', 'applyDirectorRigPose', 'quaternius']) {
    ok(!src.includes(banned), 'client.js 里出现了参考项目的标识符「' + banned + '」——借鉴设计可以，复制代码不行（许可不允许）');
  }
  // 导演台产物必须走既有资产链路（不新建第二套存储）
  ok(/saveAssetRecord\(S\.activeId, 'image', blob, \{[\s\S]{0,400}source: 'director'/.test(src), '导演台截图没有走 saveAssetRecord 既有资产链路');
}

if (errs.length) {
  console.error('✗ 3D 导演台测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 3D 导演台测试通过（场景可序列化 / 相机投影 / 几何构建 / 真的画出像素 / 拾取 / 人偶→真人提示词 / 持久化兜底 / 入口挂载与许可反向断言）');
process.exit(0);
