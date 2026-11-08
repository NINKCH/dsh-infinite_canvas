#!/usr/bin/env node
/**
 * 工具贡献点生成器（Task 6）——从 host-adapter defs 一次性生成 contributes.languageModelTools
 * 写入 adapters/vsix/package.json。
 *
 * 决策依据（brief 决策树 + @types/vscode d.ts 实读）：最新 d.ts（1.145.0）`lm.registerTool` 注释
 * 逐字：『The tool must also be registered in the package.json `languageModelTools` contribution
 * point.』——纯运行时注册不满足声明要求，故选静态 contributes 路线，本脚本是唯一的生成入口。
 *
 * 映射纪律（全局约束『工具名/描述/参数 schema 一字不改复用 core』）：name/description/parameters
 * 原样搬运，仅换键名（description→modelDescription、parameters→inputSchema），不做任何语义改写、
 * 不裁剪、不排序（保持 core 注册表顺序）。
 *
 * 漂移风险：contributes 是打包时的静态快照；core 工具面（30 个 canvas_*）变更后本块即过期，
 * 必须重跑（在 adapters/ 内）：npm run generate:tools
 * 校验：脚本末尾对比「生成的工具名清单 ↔ 本次 createHostAdapter 收集的 defs」恒一致，无漂移。
 *
 * 退出码：0 = 已写入且校验一致；1 = 失败（defs 为空 / 写入校验不过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)); // adapters/vsix/scripts
const VSIX_DIR = path.resolve(HERE, '..'); // adapters/vsix
const ADAPTERS_DIR = path.resolve(VSIX_DIR, '..'); // adapters/
const REPO_ROOT = path.resolve(ADAPTERS_DIR, '..'); // 仓库根
const MANIFEST = path.join(VSIX_DIR, 'package.json');

try {
  // 1) 收集 defs：core 单例约束（HOST-CONTRACT §6）——本进程内只 create 一次，用完 dispose
  const { createHostAdapter } = require(path.join(ADAPTERS_DIR, 'shared', 'host-adapter.cjs'));
  const adapter = await createHostAdapter({ corePath: path.join(REPO_ROOT, 'index.js') });
  const defs = adapter.tools;
  const names = defs.map((d) => d && d.name);
  if (!defs.length || names.some((n) => typeof n !== 'string' || !n)) {
    throw new Error('host-adapter defs 为空或含无名条目，拒绝生成');
  }

  // 2) 逐字映射（name/description/parameters 原样；contribution 键名为 VS Code 贡献点约定）
  const tools = defs.map((def) => ({
    name: def.name,
    displayName: def.name, // defs 无人类标题字段；displayName 用工具名（模型可见描述走 modelDescription）
    modelDescription: def.description,
    canBeReferencedInPrompt: false, // 面向代理调用而非 @ 提示引用（toolReferenceName 因此不需要）
    inputSchema: def.parameters,
  }));

  // 3) 合并写入 package.json（保留其余键；languageModelTools 整块替换）
  const pkg = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  pkg.contributes = pkg.contributes || {};
  pkg.contributes.languageModelTools = tools;
  fs.writeFileSync(MANIFEST, JSON.stringify(pkg, null, 2) + '\n');

  // 4) 写后校验：回读并逐项对账（防写入失真/漂移）
  const reread = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const written = reread.contributes && reread.contributes.languageModelTools;
  if (!Array.isArray(written) || written.length !== defs.length) {
    throw new Error(`写入校验失败：期望 ${defs.length} 条，实得 ${written && written.length}`);
  }
  for (let i = 0; i < defs.length; i++) {
    const ok =
      written[i].name === defs[i].name &&
      written[i].modelDescription === defs[i].description &&
      JSON.stringify(written[i].inputSchema) === JSON.stringify(defs[i].parameters);
    if (!ok) throw new Error(`写入校验失败（第 ${i + 1} 条与 defs 不一致）: ${defs[i].name}`);
  }

  console.log(`[generate-tools] 已生成 ${written.length} 条 languageModelTools → ${path.relative(REPO_ROOT, MANIFEST)}`);
  console.log('[generate-tools] 工具清单: ' + names.join(', '));
  try { adapter.dispose(); } catch { /* 幂等清理，失败忽略 */ }
} catch (e) {
  console.error('[generate-tools] 失败: ' + ((e && e.stack) || e));
  process.exit(1);
}
