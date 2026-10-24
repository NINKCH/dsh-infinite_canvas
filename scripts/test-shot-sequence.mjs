// 正式回归：分镜串联（多镜头按时间自动切换相机，对照 Blender Sequencer Strip 模型）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const mkScene = () => ({
  version: 2,
  objects: [{ id: 'o', kind: 'model', pos: { x: 0, y: 0, z: 0 }, h: 1.7, visible: true }],
  cameras: [
    { id: 'camA', name: 'A', pos: { x: 0, y: 1.5, z: 4 }, target: { x: 0, y: 1, z: 0 }, fov: 42 },
    { id: 'camB', name: 'B', pos: { x: 4, y: 1.5, z: 0 }, target: { x: 0, y: 1, z: 0 }, fov: 42 },
    { id: 'camC', name: 'C', pos: { x: 0, y: 5, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 42 },
  ],
  shots: [
    { cameraId: 'camA', start: 0, end: 2, label: '镜头1' },
    { cameraId: 'camB', start: 2, end: 4, label: '镜头2' },
    { cameraId: 'camC', start: 4, end: 6, label: '镜头3' },
  ],
  lights: [], env: {}, activeCameraId: 'camA', shot: { duration: 6 },
});

// ① activeCameraAt：按时间正确切换
{
  const scene = mkScene();
  const cases = [[0, 'camA'], [1.9, 'camA'], [2, 'camB'], [3.5, 'camB'], [4, 'camC'], [5.9, 'camC']];
  for (const [t, expect] of cases) {
    const got = E.activeCameraAt(scene, t);
    ok(got === expect, 't=' + t + ' 应为 ' + expect + '，实际 ' + got);
  }
}

// ② applyPlayhead 的 activeCameraId 跟随分镜
{
  const r = E.applyPlayhead(mkScene(), 3);
  ok(r.activeCameraId === 'camB', 'applyPlayhead t=3 应激活 camB，实际 ' + r.activeCameraId);
}

// ③ sequenceDuration：分镜总时长 vs 无分镜
ok(E.sequenceDuration(mkScene()) === 6, '分镜总时长应为 6');
ok(E.sequenceDuration({ ...mkScene(), shots: [] }) === 6, '无分镜时用 shot.duration');

// ④ addShot：追加并排序
{
  const scene = mkScene();
  E.addShot(scene, 'camA', 6, 3);
  ok(scene.shots.length === 4, 'addShot 后应有 4 个分镜');
  ok(E.sequenceDuration(scene) === 9, '追加后总时长应为 9');
  ok(scene.shots[3].cameraId === 'camA', '新分镜 cameraId 应为 camA');
}

// ⑤ removeShot
{
  const scene = mkScene();
  E.removeShot(scene, 0);
  ok(scene.shots.length === 2 && scene.shots[0].cameraId === 'camB', 'removeShot(0) 后首个应为 camB');
}

// ⑥ 无分镜退化
ok(E.activeCameraAt({ ...mkScene(), shots: [] }, 3) === 'camA', '无分镜时应用 activeCameraId');

// ⑦ 分镜间隙（取最近的前一个）
ok(E.activeCameraAt(mkScene(), 10) === 'camC', '超出末尾应取最后一个分镜的相机');

// ⑧ UI 接线
ok(src.includes('dir-add-shot'), 'UI 缺少添加分镜按钮');
ok(src.includes('dshic-dir-shotblock'), 'UI 缺少分镜轨道色块');
ok(src.includes('sequenceDuration'), '导出未使用 sequenceDuration');

if (errs.length) {
  console.error('✗ 分镜串联测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 分镜串联测试通过（时间切换 / applyPlayhead 跟随 / 总时长 / 增删 / 退化 / 间隙 / UI 入口）');
process.exit(0);
