// 正式回归：auto-key 语义（有动画的对象/机位拖拽后必须能在当前播放头补帧，不被插值弹回）。
// 历史事故：打完关键帧后 gizmo 拖不动 —— applyPlayhead 插值覆盖了编辑中的位置。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① 渲染 effect 必须有「拖拽中显示实时值」的覆盖逻辑
ok(src.includes('拖拽编辑优先'), '渲染缺少拖拽实时覆盖（拖拽中会被插值锁死 → 拖不动）');
ok(/if \(S\.directorDragging && dragRef\.current\)/.test(src), '缺少 directorDragging 分支');
ok(/d\.mode === 'axis' \|\| d\.mode === 'rotate'/.test(src), '对象拖拽模式未覆盖实时值');
ok(/d\.mode === 'orbit' \|\| d\.mode === 'pan'/.test(src), '相机拖拽模式未覆盖实时值');

// ② onUp 必须有 auto-key（对象 + 相机）
ok(src.includes('auto-key'), '松手缺少 auto-key');
ok(/o2\.keys\.push\(\{ t: \+playT\.toFixed\(2\)/.test(src), '对象 auto-key 未插入关键帧');
ok(/c2\.keys\.push\(\{ t: \+playT\.toFixed\(2\)/.test(src), '相机 auto-key 未插入关键帧');

// ③ 引擎侧语义验证：打帧后插值 = 拖拽位置（不弹回）
{
  const scene = {
    version: 2,
    objects: [{ id: 'o1', kind: 'model', pos: { x: 5, y: 0, z: 5 }, rotY: 0, h: 1.7, visible: true, keys: [
      { t: 0, pos: { x: 0, y: 0, z: 0 }, rotY: 0, rx: 0, rz: 0 },
      { t: 2, pos: { x: 5, y: 0, z: 5 }, rotY: 0, rx: 0, rz: 0 },
      { t: 4, pos: { x: 8, y: 0, z: 0 }, rotY: 0, rx: 0, rz: 0 },
    ] }],
    cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 8 }, target: { x: 0, y: 1, z: 0 }, fov: 45, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: 6 },
  };
  const r = E.applyPlayhead(scene, 2);
  ok(Math.abs(r.objects[0].pos.x - 5) < 0.01 && Math.abs(r.objects[0].pos.z - 5) < 0.01,
    'auto-key 后插值应等于拖拽位置，实际 ' + r.objects[0].pos.x + ',' + r.objects[0].pos.z);
  // 中间时刻正确过渡到下一帧
  const r3 = E.applyPlayhead(scene, 3);
  ok(Math.abs(r3.objects[0].pos.x - 6.5) < 0.01, 't=3 应在 (5,5)→(8,0) 中点，x≈6.5，实际 ' + r3.objects[0].pos.x);
}

if (errs.length) {
  console.error('✗ auto-key 测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ auto-key 测试通过（拖拽实时覆盖 / 松手补帧 / 插值不弹回 / 中间帧正确过渡）');
process.exit(0);
