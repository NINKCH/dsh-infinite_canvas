// 正式回归：检测「动画循环 useEffect 依赖每帧变化的值」这类失控 bug。
// 历史事故：播放循环依赖 scene，setPlayT 每帧重渲染 → effect 反复重建 → 暂停失灵。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ① 播放循环必须存在且只依赖 [open, playing]
ok(/if \(!open \|\| !playing\) return undefined;/.test(src), '找不到播放循环');
ok(!/\}, \[open, playing, scene\]\);/.test(src), '播放循环仍依赖 scene（每帧重渲染会导致暂停失灵）');
ok(/\}, \[open, playing\]\);/.test(src), '播放循环依赖不是 [open, playing]');

// ② cleanup 必须真正停止 rAF
ok(/let alive = true;/.test(src), '播放循环缺少 alive 开关');
ok(/alive = false; if \(raf\) cancelAnimationFrame\(raf\);/.test(src), 'cleanup 没有真正取消 rAF');

// ③ requestAnimationFrame 的循环体必须有停止条件
ok(/if \(!alive\) return;/.test(src), 'rAF 回调缺少 alive 早退');

// ④ 时间推进必须用真实时间差（不能假定固定帧率）
ok(/performance\.now\(\): Date\.now\(\)/.test(src.replace(/\s/g, '')) || /performance\.now\(\)/.test(src), '时间推进没有用 performance.now()');

if (errs.length) {
  console.error('✗ 动画循环测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 动画循环测试通过（播放/暂停可控、cleanup 正确、时间推进真实）');
process.exit(0);
