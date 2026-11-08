#!/usr/bin/env node
/**
 * build-adapters 总编排契约测试（Task 9，dev-only，不随包发布）。需求：task-9-brief.md 断言清单。
 *
 * 流程：spawn `npm pack --dry-run`（仓库根）做 npm 包隔离断言 → spawn
 * `node adapters/scripts/build-adapters.mjs` 全量编排 → 对三产物逐条断言。
 *
 *  1) npm 隔离（Global Constraint #1 机械化）：npm pack --dry-run 的 Tarball Contents
 *     无任何 adapters/ 前缀条目（输出解析不出文件清单也算失败，防格式漂移静默通过）
 *  2) 总编排 exit 0（失败即停语义由编排脚本自身保证；此处断言全量编排可一键跑通）
 *  3) 三产物存在且非空：vsix / qoder zip / workbuddy staging 目录树完整 + workbuddy zip
 *  4) vsix 条目（tar -tf，vsce 产物为 zip 格式）：含 extension/extension.js、
 *     extension/shared/canvas-mcp.cjs、extension/shared/core/index.js（既有打包自检断言不变，
 *     §11）、含 extension/shared/llm-channel.cjs（carry #2 接线核对）、**不含**
 *     extension/shared/core/client.js（carry #1 瘦身反向断言）
 *  5) qoder zip 条目：含 dist/llm-channel.cjs（carry #2）、**不含** dist/core/client.js
 *  6) workbuddy staging：含 plugins/dsh-infinite-canvas/dist/llm-channel.cjs（carry #2）
 *
 * 版本断言随三 manifest 冻结为 0.2.0（产物文件名直接钉 0.2.0，与各壳测试口径一致）。
 * 收尾：无子进程残留（全程 spawnSync 同步等待）；产物均落在 gitignore 的 adapters/dist/ 内。
 * 运行：node scripts/test-adapters-build.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORCHESTRATOR = path.join(ROOT, 'adapters', 'scripts', 'build-adapters.mjs');
const DIST = path.join(ROOT, 'adapters', 'dist');
const VSIX = path.join(DIST, 'dsh-infinite-canvas-0.2.0.vsix');
const QODER_ZIP = path.join(DIST, 'dsh-infinite-canvas-qoder-0.2.0.zip');
const WB_STAGING = path.join(DIST, 'workbuddy-marketplace');
const WB_ZIP = path.join(DIST, 'dsh-marketplace-workbuddy-0.2.0.zip');
const WB_PLUGIN = path.join(WB_STAGING, 'plugins', 'dsh-infinite-canvas');

const errs = [];

/** tar -tf 列 zip/vsix 条目（vsce 产物为 zip 格式，系统 bsdtar 可列）；失败抛错。 */
function listZipEntries(archive) {
  const r = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error('tar -tf 列举失败: ' + (r.stderr || r.status));
  return r.stdout.split(/\r?\n/).map((e) => e.replace(/^\.\//, '')).filter(Boolean);
}

try {
  // ---------- 断言 1：npm 包隔离（adapters/** 永不进 npm 包，Global Constraint #1） ----------
  // win32 上 npm 是 npm.cmd，spawn 必须带 shell:true；npm notice 清单走 stderr，stdout+stderr 合并解析。
  const pack = spawnSync('npm', ['pack', '--dry-run'], { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 120000 });
  if (pack.error) errs.push('npm pack --dry-run spawn 失败: ' + pack.error.message);
  if (pack.status !== 0) errs.push('npm pack --dry-run 应 exit 0，实际 ' + pack.status);
  const packOut = String(pack.stdout || '') + String(pack.stderr || ''); // npm notice 走 stderr
  const packLines = packOut.split(/\r?\n/);
  const iStart = packLines.findIndex((l) => /npm notice\s+Tarball Contents/.test(l));
  const iEnd = packLines.findIndex((l) => /npm notice\s+Tarball Details/.test(l));
  if (iStart < 0 || iEnd < 0 || iEnd <= iStart) {
    errs.push('npm pack 输出无 Tarball Contents/Details 段（解析失败按失败处理，防静默通过）');
  } else {
    const files = [];
    for (const line of packLines.slice(iStart + 1, iEnd)) {
      const m = line.match(/^npm notice\s+[\d.]+\s*[kMG]?B\s+(.+)$/);
      if (m) files.push(m[1].trim().replace(/\\/g, '/'));
    }
    if (!files.length) errs.push('npm pack Tarball Contents 段未解析出任何文件行（npm 输出格式漂移？按失败处理）');
    const offenders = files.filter((f) => f === 'adapters' || f.startsWith('adapters/'));
    if (offenders.length) {
      errs.push('npm 包出现 adapters/ 条目（Global Constraint #1 红线）:\n  ' + offenders.join('\n  '));
    }
  }

  // ---------- 断言 2：总编排一键跑通（exit 0；超时从宽——全量含 vsce 打包） ----------
  const build = spawnSync(process.execPath, [ORCHESTRATOR], { cwd: ROOT, encoding: 'buffer', timeout: 300000 });
  if (build.error) errs.push('build-adapters.mjs spawn 失败: ' + build.error.message);
  if (build.status !== 0) {
    errs.push(`build-adapters.mjs 应 exit 0，实际 ${build.status}\nstdout 尾部: ${String(build.stdout || '').slice(-600)}\nstderr 尾部: ${String(build.stderr || '').slice(-600)}`);
  }

  // ---------- 断言 3：三产物存在且非空（版本冻结 0.2.0 钉在文件名） ----------
  for (const [label, f] of [['vsix', VSIX], ['qoder zip', QODER_ZIP], ['workbuddy zip', WB_ZIP]]) {
    if (!fs.existsSync(f)) errs.push(`${label} 产物不存在: ${f}`);
    else if (fs.statSync(f).size <= 0) errs.push(`${label} 产物为空: ${f}`);
  }
  const STAGING_TREE = [
    path.join(WB_STAGING, '.codebuddy-plugin', 'marketplace.json'),
    path.join(WB_PLUGIN, '.codebuddy-plugin', 'plugin.json'),
    path.join(WB_PLUGIN, '.mcp.json'),
    path.join(WB_PLUGIN, 'skills', 'canvas', 'SKILL.md'),
    path.join(WB_PLUGIN, 'README.md'),
    path.join(WB_PLUGIN, 'dist', 'canvas-mcp.cjs'),
    path.join(WB_PLUGIN, 'dist', 'core', 'index.js'),
    path.join(WB_PLUGIN, 'dist', 'core', 'package.json'),
    path.join(WB_PLUGIN, 'dist', 'core', 'assets', 'canvas-director', 'manifest.json'),
  ];
  if (!fs.existsSync(WB_STAGING) || !fs.statSync(WB_STAGING).isDirectory()) {
    errs.push('workbuddy staging 目录不存在: ' + WB_STAGING);
  } else {
    for (const f of STAGING_TREE) if (!fs.existsSync(f)) errs.push('staging 目录树缺 ' + f);
  }

  // ---------- 断言 4：vsix 条目正反向（瘦身反向 + llm-channel 正向） ----------
  if (fs.existsSync(VSIX)) {
    let entries = [];
    try { entries = listZipEntries(VSIX); } catch (e) { errs.push('vsix 条目列举失败: ' + e.message); }
    for (const rel of ['extension/extension.js', 'extension/shared/canvas-mcp.cjs', 'extension/shared/core/index.js']) {
      if (!entries.includes(rel)) errs.push(`vsix 应含 ${rel}（既有打包自检断言不变，§11）`);
    }
    if (!entries.includes('extension/shared/llm-channel.cjs')) {
      errs.push('vsix 应含 extension/shared/llm-channel.cjs（carry #2：三壳 llm-channel 接线核对）');
    }
    if (entries.includes('extension/shared/core/client.js')) {
      errs.push('vsix 不应含 extension/shared/core/client.js（carry #1 瘦身反向断言）');
    }
  }

  // ---------- 断言 5：qoder zip 条目正反向 ----------
  if (fs.existsSync(QODER_ZIP)) {
    let entries = [];
    try { entries = listZipEntries(QODER_ZIP); } catch (e) { errs.push('qoder zip 条目列举失败: ' + e.message); }
    if (!entries.includes('dist/llm-channel.cjs')) errs.push('qoder zip 应含 dist/llm-channel.cjs（carry #2）');
    if (entries.includes('dist/core/client.js')) errs.push('qoder zip 不应含 dist/core/client.js（瘦身反向断言）');
  }

  // ---------- 断言 6：workbuddy staging llm-channel（carry #2） ----------
  if (fs.existsSync(WB_STAGING)) {
    if (!fs.existsSync(path.join(WB_PLUGIN, 'dist', 'llm-channel.cjs'))) {
      errs.push('workbuddy staging 应含 plugins/dsh-infinite-canvas/dist/llm-channel.cjs（carry #2）');
    }
  }
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
}

if (errs.length) {
  console.error(`\n✗ build-adapters 总编排契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ build-adapters 总编排：npm 包隔离 / 一键编排 / 三产物 / vsix·qoder·workbuddy 正反向断言全部通过');
process.exit(0);
