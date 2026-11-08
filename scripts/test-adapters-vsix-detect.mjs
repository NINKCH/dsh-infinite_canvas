#!/usr/bin/env node
/**
 * vsix 能力探测决策表测试（detect.cjs，Task 6，dev-only 不随包发布）。
 *
 * 只测 adapters/vsix/lib/detect.cjs 纯函数——零 vscode 依赖、零 node_modules（brief Step 1），
 * 本测试不 import 'vscode'、不起网络、不触真实宿主。
 *
 *  组1 决策表五例（brief 逐字）：全 false→manual；仅 lmTools→lm-tools；lmTools+mcpProvider→
 *      lm-tools（优先级）；无 lmTools 有 mcpProvider→mcp-provider；仅 cursorMcp→cursor-mcp。
 *  组2 sampling 直传四例：true/false 各路径至少一例（lm-tools:true / mcp-provider:true /
 *      cursor-mcp:false / manual:false）。
 *  组3 非法输入：缺字段（{}、undefined、null）与多传（额外字段）→ 按 false 处理不抛错；
 *      非布尔真值（1/'yes'/{}/[]）同样按 false；返回形状恒 {path, sampling} 两键。
 * 运行：node scripts/test-adapters-vsix-detect.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const DETECT_PATH = path.join(ROOT, 'adapters', 'vsix', 'lib', 'detect.cjs');

let detect = null;
try {
  ({ detect } = require(DETECT_PATH));
} catch { /* TDD RED 阶段模块尚不存在，属预期 */ }

const errs = [];

try {
  if (typeof detect !== 'function') {
    errs.push('adapters/vsix/lib/detect.cjs 应导出 detect 函数（TDD RED 阶段缺失属预期，实现后应消失）');
    throw new Error('模块缺失，跳过后续组');
  }

  // ---------- 组1：决策表五例（brief 逐字） ----------
  // 1a 全 false → manual
  const r1a = detect({ lmTools: false, mcpProvider: false, cursorMcp: false, sampling: false });
  if (!r1a || r1a.path !== 'manual') errs.push(`组1a 全 false 应选 'manual'，实际 ${r1a && r1a.path}`);
  // 1b 仅 lmTools → lm-tools
  const r1b = detect({ lmTools: true, mcpProvider: false, cursorMcp: false, sampling: false });
  if (!r1b || r1b.path !== 'lm-tools') errs.push(`组1b 仅 lmTools 应选 'lm-tools'，实际 ${r1b && r1b.path}`);
  // 1c lmTools+mcpProvider → lm-tools（优先级：lm-tools > mcp-provider）
  const r1c = detect({ lmTools: true, mcpProvider: true, cursorMcp: false, sampling: false });
  if (!r1c || r1c.path !== 'lm-tools') errs.push(`组1c lmTools+mcpProvider 应选 'lm-tools'（优先级），实际 ${r1c && r1c.path}`);
  // 1d 无 lmTools 有 mcpProvider → mcp-provider
  const r1d = detect({ lmTools: false, mcpProvider: true, cursorMcp: false, sampling: false });
  if (!r1d || r1d.path !== 'mcp-provider') errs.push(`组1d 无 lmTools 有 mcpProvider 应选 'mcp-provider'，实际 ${r1d && r1d.path}`);
  // 1e 仅 cursorMcp → cursor-mcp
  const r1e = detect({ lmTools: false, mcpProvider: false, cursorMcp: true, sampling: false });
  if (!r1e || r1e.path !== 'cursor-mcp') errs.push(`组1e 仅 cursorMcp 应选 'cursor-mcp'，实际 ${r1e && r1e.path}`);
  // 1f 优先级总链：三者全 true 仍 lm-tools（cursorMcp 优先级低于 mcp-provider 的钉死）
  const r1f = detect({ lmTools: false, mcpProvider: true, cursorMcp: true, sampling: false });
  if (!r1f || r1f.path !== 'mcp-provider') errs.push(`组1f mcpProvider+cursorMcp 应选 'mcp-provider'（优先级），实际 ${r1f && r1f.path}`);

  // ---------- 组2：sampling 直传四例（true/false 各路径至少一例） ----------
  const s2a = detect({ lmTools: true, sampling: true });
  if (!s2a || s2a.path !== 'lm-tools' || s2a.sampling !== true) {
    errs.push(`组2a lmTools+sampling:true 应得 {path:'lm-tools',sampling:true}，实际 ${JSON.stringify(s2a)}`);
  }
  const s2b = detect({ mcpProvider: true, sampling: true });
  if (!s2b || s2b.path !== 'mcp-provider' || s2b.sampling !== true) {
    errs.push(`组2b mcpProvider+sampling:true 应得 {path:'mcp-provider',sampling:true}，实际 ${JSON.stringify(s2b)}`);
  }
  const s2c = detect({ cursorMcp: true, sampling: false });
  if (!s2c || s2c.path !== 'cursor-mcp' || s2c.sampling !== false) {
    errs.push(`组2c cursorMcp+sampling:false 应得 {path:'cursor-mcp',sampling:false}，实际 ${JSON.stringify(s2c)}`);
  }
  const s2d = detect({ lmTools: false, mcpProvider: false, cursorMcp: false, sampling: false });
  if (!s2d || s2d.path !== 'manual' || s2d.sampling !== false) {
    errs.push(`组2d 全 false+sampling:false 应得 {path:'manual',sampling:false}，实际 ${JSON.stringify(s2d)}`);
  }

  // ---------- 组3：非法输入（缺字段/多传）→ 按 false 处理不抛错 ----------
  // 3a 缺字段：{} → manual + sampling false
  const r3a = detect({});
  if (!r3a || r3a.path !== 'manual' || r3a.sampling !== false) {
    errs.push(`组3a 空对象（缺字段）应按 false 处理得 manual/false，实际 ${JSON.stringify(r3a)}`);
  }
  // 3b undefined / null：不抛错 → manual
  for (const [label, input] of [['undefined', undefined], ['null', null]]) {
    let r3b = null;
    let threw = false;
    try { r3b = detect(input); } catch { threw = true; }
    if (threw) errs.push(`组3b 输入 ${label} 不应抛错`);
    else if (!r3b || r3b.path !== 'manual' || r3b.sampling !== false) {
      errs.push(`组3b 输入 ${label} 应按 false 处理得 manual/false，实际 ${JSON.stringify(r3b)}`);
    }
  }
  // 3c 缺单字段：其余字段 false 时缺 lmTools → 落 mcp-provider（缺位按 false）
  const r3c = detect({ mcpProvider: true });
  if (!r3c || r3c.path !== 'mcp-provider') errs.push(`组3c 缺 lmTools 字段应按 false 处理（落 mcp-provider），实际 ${r3c && r3c.path}`);
  // 3d 非布尔真值：全部按 false（不抛错、不误判可用）
  const r3d = detect({ lmTools: 1, mcpProvider: 'yes', cursorMcp: {}, sampling: 'true' });
  if (!r3d || r3d.path !== 'manual' || r3d.sampling !== false) {
    errs.push(`组3d 非布尔真值应按 false 处理得 manual/false，实际 ${JSON.stringify(r3d)}`);
  }
  // 3e 多传：额外字段被忽略；返回形状恒两键 {path, sampling}
  let r3e = null;
  let threw3e = false;
  try { r3e = detect({ lmTools: true, sampling: true, extra: true, another: { nested: 1 } }); } catch { threw3e = true; }
  if (threw3e) errs.push('组3e 多传额外字段不应抛错');
  else {
    if (!r3e || r3e.path !== 'lm-tools' || r3e.sampling !== true) {
      errs.push(`组3e 多传额外字段应忽略并正常决策，实际 ${JSON.stringify(r3e)}`);
    }
    const keys3e = Object.keys(r3e || {}).sort();
    if (keys3e.join(',') !== 'path,sampling') {
      errs.push(`组3e 返回形状应恒为 {path, sampling} 两键，实际 ${JSON.stringify(keys3e)}`);
    }
  }
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
}

if (errs.length) {
  console.error(`\n✗ vsix detect 决策表测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ vsix detect 能力探测决策表：契约全部通过（五例决策/sampling 直传/非法输入降级）');
process.exit(0);
