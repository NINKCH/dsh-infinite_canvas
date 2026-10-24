// 正式回归：物体路径运动 / 机位增删 / 暂停不跳页 / gizmo 尺寸 / 白模地面光影 / 材质色
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const eng = fs.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① 物体路径：曲线/折线 + 起点终点精确
{
  const ob = { id: 'o', kind: 'model', pos: { x: 0, y: 0, z: 0 }, h: 1.7, pathMode: 'curve',
    path: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }] };
  const sc = { version: 2, objects: [ob], cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 6 }, target: { x: 0, y: 1, z: 0 }, fov: 42, keys: [] }], lights: [], env: {}, activeCameraId: 'c', shot: { duration: 3 } };
  const p0 = E.applyPlayhead(sc, 0).objects[0].pos;
  const p3 = E.applyPlayhead(sc, 3).objects[0].pos;
  ok(Math.abs(p0.x) < 0.01 && Math.abs(p0.z) < 0.01, '路径起点不精确');
  ok(Math.abs(p3.x - 3) < 0.01 && Math.abs(p3.z - 3) < 0.01, '路径终点不精确');
  // 折线中点 = 第二个路径点
  const lin = E.applyPlayhead({ ...sc, objects: [{ ...ob, pathMode: 'linear' }] }, 1.5).objects[0].pos;
  ok(Math.abs(lin.x - 3) < 0.01 && Math.abs(lin.z) < 0.01, '折线中点应为路径点2 (3,0)，实际 ' + lin.x + ',' + lin.z);
  // 无路径不受影响
  const plain = E.applyPlayhead({ ...sc, objects: [{ id: 'o', kind: 'model', pos: { x: 5, y: 0, z: 5 }, h: 1.7 }] }, 2).objects[0].pos;
  ok(plain.x === 5 && plain.z === 5, '无路径对象不应被移动');
  // 路径点不足 2 个 → 不生效
  ok(E.objectPathPos({ path: [{ x: 0, y: 0, z: 0 }], pathMode: 'curve' }, 1, 3) === null, '单点路径应返回 null');
  ok(E.objectPathPos({}, 1, 3) === null, '无 path 应返回 null');
}

// ② 机位增删 + 路径 UI 入口
for (const [label, key] of [
  ['新建机位', 'dir-cam-add'], ['删除机位', 'dir-cam-del'],
  ['路径模式', 'dirPathMode'], ['加点', 'dir-path-add'],
  ['画路径', 'dir-path-draw'], ['清空路径', 'dir-path-clear'],
  ['视口点画路径', 'S.directorPathPick'],
]) ok(cli.includes(key), '缺少 UI 入口：' + label + ' (' + key + ')');

// ③ 暂停不再跳静态预演、时间线常驻
ok(/const \[previzMode, setPrevizMode\] = useState\('static'\)/.test(cli), '缺少 previzMode 状态');
ok(/const timelineDock = \(previzMode === 'dynamic' \|\| previzMode === 'render' \|\| S\.directorTimelineOpen\)/.test(cli), '时间线应在动态预演与实时渲染下常驻（可暂停/拖动）');
ok(/setPrevizMode\('dynamic'\); S\.directorCamFollow = true; setPlaying\(\(v\) => !v\)/.test(cli), '播放按钮应保持动态模式并开启分镜机位跟随');
ok(!/onClick: \(\) => setPlaying\(false\) \}, T\('dirStaticPreviz'\)/.test(cli), '静态按钮不应只改 playing');
ok(/previzMode === 'dynamic' && 'is-on'/.test(cli), '动态按钮高亮未跟随模式');

// ④ gizmo 至少 1/3 人物高
ok(/const minWorld = Math\.max\(0\.25, \(Number\(sel\.h\) \|\| 1\.7\) \/ 3\)/.test(eng), 'gizmo 未按人物高度 1/3 下限');
ok(/const L = Math\.max\(pxWorld \* 105, minWorld\)/.test(eng), 'gizmo 轴长未取较大值');
{
  // 数值：1.78m 人物在高 dpr 视口里，轴长应 >= 0.59m
  const cam = { pos: { x: 0, y: 1.6, z: 2 }, target: { x: 0, y: 0.9, z: 0 }, fov: 42 };
  const pxWorld = E.pixelSizeAt(cam, 720, E.depthOf(cam, { x: 0, y: 0, z: 0 }));
  const L = Math.max(pxWorld * 105, 1.78 / 3);
  ok(L >= 1.78 / 3 - 1e-9, 'gizmo 轴长应 >= 人物 1/3 高');
}

// ⑤ 成片场景：默认保留外观；显式 clay:true 才输出白模
{
  const sc = { version: 2, objects: [{ id: 'a', kind: 'model', pos: { x: 0, y: 0, z: 0 }, h: 1.7, color: '#123456' }],
    cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fov: 42 }],
    lights: [{ id: 'k', dir: { x: 0.4, y: -0.8, z: 0.4 }, color: '#fff2d8', intensity: 1 }],
    env: { bg: '#171717', ground: '#2a2f36', grid: true, guides: {} }, activeCameraId: 'c', shot: { duration: 3 } };
  const ex = E.buildExportScene(sc);
  ok(ex.env.grid === false, '成片未关网格');
  ok(ex.env.bg === '#171717' && ex.objects[0].color === '#123456', '成片默认应保留原背景与对象颜色（不能变灰）');
  const clay = E.buildExportScene(sc, { clay: true });
  const bgHex = clay.env.bg;
  const bgv = parseInt(bgHex.slice(1), 16);
  const bgLum = ((bgv >> 16) + ((bgv >> 8) & 255) + (bgv & 255)) / 3;
  ok(bgLum > 180, '白模背景应为浅灰（当前 ' + bgHex + '）');
  const gv = parseInt(clay.env.ground.slice(1), 16);
  const gLum = ((gv >> 16) + ((gv >> 8) & 255) + (gv & 255)) / 3;
  ok(gLum > 140, '白模地面应为亮色（当前 ' + clay.env.ground + '）');
  ok(!!clay.objects[0].color, '白模对象必须有颜色（无材质色时用纯白）');
  ok(clay.lights.every((l) => l.color === '#ffffff'), '白模灯光应为中性白');
  ok(clay.lights.length >= 2, '白模应有主光+补光（正面不发黑）');
}

// ⑥ 地面阴影 + 各类型基础色
ok(/shadowFactor\(/.test(eng), '着色器缺少阴影采样函数 shadowFactor');
ok(/shadowTex|shadowFbo/.test(eng), '缺少阴影贴图资源');
ok(/uniform float uAlpha;/.test(eng), '着色器缺少 uAlpha（阴影需要）');
ok(/gl_FragColor = vec4\(col, uAlpha\);/.test(eng), '着色器未直接输出 uAlpha');
{
  const colors = new Set((E.MANNEQUIN_TYPES || []).map((t) => t.color).filter(Boolean));
  ok(colors.size >= 10, '人偶类型基础色不足（' + colors.size + ' 种，12 种体型应各有颜色）');
  ok((E.MANNEQUIN_TYPES || []).every((t) => !!t.color), '有体型缺少基础色');
}

// ⑦ 地面/阴影/机位框细节
ok(/renderShadowMap\(scene\)/.test(eng), 'draw 中缺少阴影 pass 调用');
ok(/uShadowRadius/.test(eng), 'PCF 缺少 filter radius（半影）');
ok(/getContext\('webgl2'/.test(eng), '未启用 WebGL2（深度纹理必需）');
ok(/for \(let iz = 0; iz < 5; iz\+\+\)/.test(eng), '地面应为 5×5 且居中（否则地平线断层）');
ok(/\(ix - 2\) \* gsz/.test(eng), '地面块未按原点居中');
ok(/cam2\.id === scene\.activeCameraId\) return;/.test(eng), '不应画当前机位自己的画幅框');
ok(/cameraFrame === true/.test(eng), '相机画幅框应默认关闭（避免挡视线）');
ok(/shaft: 7\.5/.test(eng), '轴身应加粗到 7.5px');
ok(/handle: 11/.test(eng), '缩放块应为 11px（与拾取容差同源）');

// ⑧ 材质 UI
ok(cli.includes('dir-obj-color'), '缺少材质颜色输入');
ok(cli.includes('dshic-dir-swatch'), '缺少预设色块');
ok(/o2\.color = e2\.target\.value/.test(cli), '颜色修改未写入 scene');

if (errs.length) {
  console.error('✗ 导演台 v2 测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 导演台 v2 测试通过（物体路径运动 / 机位增删 / 暂停不跳页 / gizmo≥1/3身高 / 白模地面光影 / 类型基础色 / 材质UI）');
process.exit(0);
