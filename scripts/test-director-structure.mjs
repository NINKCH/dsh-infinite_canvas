// 正式回归测试：检测 DirectorStage 组件体内的 TDZ 引用（定义前使用 → 白屏）。
// 历史事故：Cannot access 'durS' before initialization
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const lines = src.split('\n');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

let start = -1;
for (let i = 0; i < lines.length; i++) if (lines[i].includes('function DirectorStage()')) { start = i; break; }
ok(start > 0, '找不到 DirectorStage');
if (start > 0) {
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].replace(/\r$/, '') === '    }') { end = i; break; }
  ok(end > start, '找不到 DirectorStage 结束位置');
  const defs = [];
  for (let i = start; i < end; i++) {
    const m = lines[i].match(/^      const ([A-Za-z_$][\w$]*)\s*[=:]/);
    if (m) defs.push({ name: m[1], line: i });
  }
  ok(defs.length > 40, 'DirectorStage 内 const 数量异常：' + defs.length);
  const bad = [];
  for (const d of defs) {
    const re = new RegExp('\\b' + d.name + '\\b');
    for (let i = start; i < d.line; i++) {
      if (/^\s*\/\//.test(lines[i])) continue;
      if (re.test(lines[i])) { bad.push(d.name + '(定义@' + (d.line + 1) + ')'); break; }
    }
  }
  ok(bad.length === 0, 'TDZ 引用（定义前使用会白屏）：' + bad.join(', '));
}

// 另外检查：组件顶层 hooks 必须全部位于组件顶层 early return 之前
// 注意：useEffect 回调内部的 return 不算 early return（缩进更深），必须排除
if (start > 0) {
  const body = lines.slice(start, start + 400);
  let firstEarlyReturn = -1;
  let hookAfterReturn = [];
  for (let i = 0; i < body.length; i++) {
    const raw = body[i];
    const t = raw.trim();
    // 组件顶层 early return：正好 6 空格缩进的 if + return
    if (firstEarlyReturn < 0 && /^      if \(/.test(raw) && /\breturn\b/.test(t)) firstEarlyReturn = i;
    // 组件顶层 hook：6 空格缩进开头
    const isHook = /^      const \[[^\]]*\] = use(State|Ref|Memo|Callback)\(/.test(raw)
                || /^      use(Effect|LayoutEffect)\(/.test(raw);
    if (isHook && firstEarlyReturn >= 0) hookAfterReturn.push(i + 1);
  }
  ok(hookAfterReturn.length === 0, 'hooks 在 early return 之后（React #310），行号：' + hookAfterReturn.join(','));
}

if (errs.length) {
  console.error('✗ 组件结构测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 组件结构测试通过（无 TDZ 引用、hooks 顺序正确）');
process.exit(0);
