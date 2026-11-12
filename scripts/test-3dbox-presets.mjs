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

// ── ⑥ Host 工具与客户端入口接线 ──
{
  const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(/action === 'presets'|action === \"presets\"/.test(host), 'Host 缺少 action=presets');
  ok(host.includes('SCENE_PRESETS') || host.includes('scenePresets'), 'Host 未暴露场景预设');
  ok(host.includes('applyCameraMove'), 'Host 未接线 applyCameraMove');
  ok(host.includes('cameraMove'), 'Host 工具未接收 cameraMove');
  ok(host.includes("action === 'edit'") && host.includes('editDirectorSpec'), 'Host 缺少自然语言改景 action=edit');
  const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(cli.includes('dshic-dir-boxbar'), '客户端缺少 3D-BOX 提示条');
  ok(cli.includes("'box-build'"), '客户端缺少「生成预演」按钮');
  ok(cli.includes("'box-edit'") && cli.includes('directorStageEdit'), '客户端缺少「改景」入口或未接 RPC');
  ok(cli.includes("'box-shot-4'") && cli.includes("'box-shot-12'"), '客户端缺少四/十二方位截图入口');
  ok(cli.includes('viewCamerasAround'), '客户端未接线四/十二方位截图');
  ok(cli.includes('specFromBrief'), '客户端未接线一句话搭景');
  ok(cli.includes('CAMERA_MOVES') || cli.includes('DIRECTOR_MOVES'), '客户端未接线运镜清单');
}

if (errs.length) {
  console.error('✗ 3D-BOX 预设测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 3D-BOX 预设测试通过（9 场景 / 6 风格 / 16+ 运镜 / 组合搭景 / 纯函数 / Host+客户端接线）');
process.exit(0);
