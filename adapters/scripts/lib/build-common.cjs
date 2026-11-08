#!/usr/bin/env node
/**
 * build-common（Task 9 carry-forward #3）——qoder / workbuddy 两构建脚本的公共函数库。
 *
 * 基准：build-workbuddy.mjs（Task 8 版）——枚举清单 + 缺失报错 / 版本单源（semver 形状校验）/
 * tar spawn + 条目自检 / copyDir。build-qoder.mjs 与 build-workbuddy.mjs 均切换到本模块
 * （行为等价红线：三壳产物树不变，各壳测试钉死；只收敛重复实现，不加新功能）。
 *
 * CJS 形态是刻意的：两个调用方是 ESM .mjs，Node 对 `exports.xxx = ...` 做命名导出静态探测，
 * `import { copyDir } from './lib/build-common.cjs'` 直接可用。零依赖（仅 node 内置 + 系统 tar）。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// semver 形状（防读坏版本拼坏产物文件名；与 build-workbuddy 原版同一条正则）
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * 递归拷贝目录（目标不存在则创建；仅普通文件与目录，符号链接跳过并告警）。
 * tag：日志前缀（保持各脚本原 `[build-<壳>] 跳过符号链接: <path>` 输出形态）。
 */
function copyDir(src, dst, tag) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) {
      console.error(`[${tag}] 跳过符号链接: ${s}`);
    } else if (st.isDirectory()) {
      copyDir(s, d, tag);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * 清单枚举 + 缺失报错拷贝（枚举清单是刻意的——勿 readdir 自动发现，Task 7 评审 Minor #2 教训）。
 * describe：报错用清单名（如 'shared 模块' / '§4 RUNTIME_FILES'），保持各脚本原报错文案。
 */
function copyEnumerated(srcDir, files, dstDir, describe) {
  for (const f of files) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src)) throw new Error(describe + ' 缺失: ' + f);
    fs.copyFileSync(src, path.join(dstDir, f));
  }
}

/**
 * 版本单源：读 JSON manifest 的 version 字段并校验 semver 形状（缺失/坏形状即抛错）。
 * 调用方自行做跨 manifest 对账（如 workbuddy 的 plugin.json ↔ marketplace.json）。
 */
function readVersion(manifestPath) {
  const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const v = json && json.version;
  if (typeof v !== 'string' || !VERSION_RE.test(v)) {
    throw new Error(manifestPath + ' version 缺失或非 semver 形状: ' + JSON.stringify(v));
  }
  return v;
}

/**
 * zip 打包 + 条目自检：系统 tar（win32 = bsdtar）`tar -a -c -f <out> -C <srcDir> .`（ZIP 根直接含
 * 源目录内容），随后 `tar -tf` 列表抽查 requiredEntries（缺失即抛错）。返回条目清单。
 */
function packZip(srcDir, outZip, requiredEntries) {
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  fs.rmSync(outZip, { force: true });
  const tar = spawnSync('tar', ['-a', '-c', '-f', outZip, '-C', srcDir, '.'], { encoding: 'buffer', timeout: 120000 });
  if (tar.error) throw new Error('tar spawn 失败: ' + tar.error.message);
  if (tar.status !== 0) {
    throw new Error(`tar 打包失败（exit ${tar.status}）: ${String(tar.stderr || '')}`);
  }
  if (!fs.existsSync(outZip)) throw new Error('tar 报告成功但 zip 不存在: ' + outZip);
  const list = spawnSync('tar', ['-tf', outZip], { encoding: 'utf8', timeout: 60000 });
  if (list.status !== 0) throw new Error('tar -tf 自检失败: ' + (list.stderr || list.status));
  const entries = list.stdout.split(/\r?\n/).map((e) => e.replace(/^\.\//, '')).filter(Boolean);
  for (const rel of requiredEntries) {
    if (!entries.includes(rel)) throw new Error('zip 条目自检失败，缺 ' + rel);
  }
  return entries;
}

exports.VERSION_RE = VERSION_RE;
exports.copyDir = copyDir;
exports.copyEnumerated = copyEnumerated;
exports.readVersion = readVersion;
exports.packZip = packZip;
