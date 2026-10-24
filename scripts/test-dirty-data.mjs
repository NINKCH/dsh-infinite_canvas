// 正式回归：脏数据守卫（历史事故：导出视频 reading 'x' —— 关键帧缺 pos / 对象缺 pos）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① samplePath 正常路径不受守卫影响
{
  const keys = [{ t: 0, pos: { x: 0, y: 1, z: 5 } }, { t: 2, pos: { x: 3, y: 1.5, z: 2 } }, { t: 4, pos: { x: 0, y: 2, z: -2 } }];
  const s = E.samplePath(keys, 2);
  ok(Math.abs(s.pos.x - 3) < 1e-6, '守卫破坏了正常样条取点');
}

// ② key 缺 pos → 不崩（被过滤）
try {
  const dirty = [{ t: 0, pos: { x: 0, y: 1, z: 5 } }, { t: 2 }, { t: 4, pos: { x: 0, y: 2, z: -2 } }];
  E.samplePath(dirty, 1);
  ok(true, '');
} catch (e) { ok(false, 'key 缺 pos 仍崩溃: ' + e.message); }

// ③ null/undefined 入参
try { E.samplePath(null, 1); } catch (e) { ok(false, 'null 入参崩溃: ' + e.message); }
try { E.samplePath([null, undefined], 1); } catch (e) { ok(false, '含 null 元素崩溃: ' + e.message); }

// ④ applyPlayhead 相机含脏 key（curve 模式）
try {
  const scene = { version: 2, objects: [], cameras: [{ id: 'c', pos: { x: 0, y: 2, z: 8 }, target: { x: 0, y: 1, z: 0 }, fov: 42, pathMode: 'curve', keys: [{ t: 0, pos: { x: 0, y: 2, z: 8 } }, { t: 3 }] }], lights: [], env: {}, activeCameraId: 'c', shot: { duration: 5 } };
  E.applyPlayhead(scene, 1.5);
} catch (e) { ok(false, 'applyPlayhead 脏 key 崩溃: ' + e.message); }

// ⑤ 客户端导出有分步报错（看得到失败步骤）+ 引擎 model 分支守卫
import fs from 'node:fs';
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const eng = fs.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8');
ok(src.includes("导出视频["), '导出缺少分步错误报告');
ok(eng.includes('if (!ob.pos) return; // 脏数据守卫'), 'draw model 分支缺 pos 守卫（engine.js）');

if (errs.length) {
  console.error('✗ 脏数据守卫测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 脏数据守卫测试通过（缺 pos key / null 入参 / curve 脏 key / 导出分步报错）');
process.exit(0);
