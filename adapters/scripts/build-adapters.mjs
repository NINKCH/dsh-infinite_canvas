#!/usr/bin/env node
/**
 * build-adapters（Task 9）——三壳构建总编排：一键产出 vsix / qoder zip / workbuddy 市场三产物到
 * adapters/dist/。只做**编排**（spawn 既有子步骤 + 失败即停 + 版本一致性断言），不复制任何构建逻辑
 * （逻辑在各壳脚本内，公共函数在 ./lib/build-common.cjs）。
 *
 * CLI：node adapters/scripts/build-adapters.mjs [--skip-vsix]
 *   --skip-vsix：跳过 vsix 步骤（供无 npm/vsce 环境快速出两 zip）；正常路径全量。
 *
 * 步骤（任一步失败 → 立即 exit 1，stderr 指明哪步失败，不再继续后续步骤）：
 *   0. 版本一致性断言：adapters/vsix/package.json / adapters/qoder-plugin/.qoder-plugin/plugin.json /
 *      workbuddy marketplace plugin.json 三 manifest 各读 version，三者不一致即报错
 *      （防「同一插件三壳三版本」）。此步不依赖 npm，--skip-vsix 下仍执行。
 *   1. vsix：npm run sync（= sync-shared：shared/core 同步进 vsix）→ npm run generate:tools
 *      （generate:tools script 存在，条件成立）→ npm run package（产 vsix 到 adapters/dist/）。
 *      brief 接口写作 `npm run sync-shared`（adapters/vsix/）——实际 script 名在 adapters/package.json
 *      （vsix package.json 无 scripts 字段），按仓库现状对齐：sync / generate:tools / package 三 script
 *      均在 adapters/，cwd 一律 adapters/。
 *   2. spawn node adapters/scripts/build-qoder.mjs（qoder zip）。
 *   3. spawn node adapters/scripts/build-workbuddy.mjs（staging 市场 + zip）。
 *   4. 汇总清单：三产物路径与大小打 stderr。
 *
 * 子进程收尾：全程 spawnSync 同步等待（无悬挂子进程树）；stdio inherit 让子步骤日志直通终端。
 * 零依赖（node 内置 + npm spawn）；产物落 adapters/dist/（gitignore 覆盖）。
 * 退出码：0 = 成功；1 = 版本不一致 / 任一步骤失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion } from './lib/build-common.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // adapters/scripts
const ADAPTERS_DIR = path.resolve(HERE, '..'); // adapters/
const DIST_DIR = path.join(ADAPTERS_DIR, 'dist');
const SKIP_VSIX = process.argv.includes('--skip-vsix');

// 三 manifest 版本单源对账（读取本身即校验 semver 形状）
const VERSION_SOURCES = [
  ['vsix', path.join(ADAPTERS_DIR, 'vsix', 'package.json')],
  ['qoder', path.join(ADAPTERS_DIR, 'qoder-plugin', '.qoder-plugin', 'plugin.json')],
  ['workbuddy', path.join(ADAPTERS_DIR, 'workbuddy-plugin', 'marketplace', 'plugins', 'dsh-infinite-canvas', '.codebuddy-plugin', 'plugin.json')],
];

const fail = (msg) => {
  console.error('[build-adapters] 失败: ' + msg);
  process.exit(1);
};

/** spawn 一个子步骤：失败即停（exit 1 并指明步骤名）；label 仅用于 stderr 标识。 */
function step(label, file, args, { cwd, shell = false, timeout = 300000 } = {}) {
  console.error(`[build-adapters] ▶ ${label}`);
  const r = spawnSync(file, args, { cwd, shell, stdio: 'inherit', timeout });
  if (r.error) fail(`步骤「${label}」spawn 失败: ${r.error.message}`);
  if (r.status !== 0) fail(`步骤「${label}」失败（exit ${r.status}）——不再继续后续步骤`);
}

/** 产物行（路径 + 大小，KB）；不存在返回 null（由调用方决定是否致命）。 */
function artifactLine(label, file) {
  if (!fs.existsSync(file)) return null;
  return `  ${label} → ${file}（${(fs.statSync(file).size / 1024).toFixed(0)} KB）`;
}

try {
  // ---------- 步骤 0：版本一致性断言（三壳三 manifest，同一插件必须同一版本） ----------
  const versions = VERSION_SOURCES.map(([name, manifest]) => [name, readVersion(manifest)]);
  const drifted = versions.filter(([, v]) => v !== versions[0][1]);
  if (drifted.length) {
    fail(`版本漂移（同一插件三壳必须同版本）: ${versions.map(([n, v]) => `${n}=${v}`).join('、')}`);
  }
  console.error(`[build-adapters] 版本一致性通过: ${versions.map(([n, v]) => `${n}=${v}`).join('、')}`);

  // ---------- 步骤 1：vsix（sync-shared → generate:tools → package；--skip-vsix 可跳） ----------
  if (SKIP_VSIX) {
    console.error('[build-adapters] --skip-vsix：跳过 vsix 步骤（npm/vsce 不参与，仅出两 zip）');
  } else {
    step('① vsix: npm run sync（sync-shared：shared/core 同步进 vsix）', 'npm', ['run', 'sync'], { cwd: ADAPTERS_DIR, shell: true });
    step('① vsix: npm run generate:tools（静态工具声明再生成）', 'npm', ['run', 'generate:tools'], { cwd: ADAPTERS_DIR, shell: true });
    step('① vsix: npm run package（vsce 打包 → adapters/dist/）', 'npm', ['run', 'package'], { cwd: ADAPTERS_DIR, shell: true, timeout: 600000 });
  }

  // ---------- 步骤 2/3：qoder + workbuddy（零 npm 依赖壳构建） ----------
  step('② qoder: node adapters/scripts/build-qoder.mjs', process.execPath, [path.join(HERE, 'build-qoder.mjs')], { cwd: ADAPTERS_DIR });
  step('③ workbuddy: node adapters/scripts/build-workbuddy.mjs', process.execPath, [path.join(HERE, 'build-workbuddy.mjs')], { cwd: ADAPTERS_DIR });

  // ---------- 步骤 4：汇总清单（三产物路径与大小，stderr） ----------
  const vsixArtifact = artifactLine('vsix     ', path.join(DIST_DIR, `dsh-infinite-canvas-${versions[0][1]}.vsix`));
  const lines = [
    vsixArtifact === null ? '  vsix     → 未产出（--skip-vsix）' : vsixArtifact,
    artifactLine('qoder    ', path.join(DIST_DIR, `dsh-infinite-canvas-qoder-${versions[0][1]}.zip`)),
    artifactLine('workbuddy', path.join(DIST_DIR, `dsh-marketplace-workbuddy-${versions[0][1]}.zip`)),
    `  workbuddy 目录市场（staging） → ${path.join(DIST_DIR, 'workbuddy-marketplace')}`,
  ];
  console.error('[build-adapters] 三产物汇总:');
  for (const l of lines) console.error(l);

  // 非跳过模式下产物缺失视为编排失败（汇总只对已构建产物负责，但全量路径必须三件齐）
  if (!SKIP_VSIX) {
    for (const [label, file] of [['vsix', path.join(DIST_DIR, `dsh-infinite-canvas-${versions[0][1]}.vsix`)], ['qoder zip', path.join(DIST_DIR, `dsh-infinite-canvas-qoder-${versions[0][1]}.zip`)], ['workbuddy zip', path.join(DIST_DIR, `dsh-marketplace-workbuddy-${versions[0][1]}.zip`)]]) {
      if (!fs.existsSync(file) || fs.statSync(file).size <= 0) fail(`${label} 产物缺失或为空: ${file}`);
    }
  }
  console.error('[build-adapters] 完成（三壳产物就绪，adapters/dist/）');
} catch (e) {
  fail((e && e.message) || String(e));
}
