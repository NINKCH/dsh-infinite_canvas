#!/usr/bin/env node
/**
 * build-qoder（Task 7）——qoder-plugin ZIP 自足构建（零 npm 依赖：node 内置 + 系统 tar）。
 *
 *  1) dist 同步（幂等，先删后拷）：按 HOST-CONTRACT.md §4 RUNTIME_FILES 把 shared 五模块 + core
 *     拷进 adapters/qoder-plugin/dist/，布局照 §5：dist/canvas-mcp.cjs 等 + dist/core/（含 assets/
 *     与 package.json）；另随包 dist/core/client.js（brief Step 1 断言要求的画布前端随包文件）。
 *  2) ZIP 打包：系统 tar（win32 = bsdtar）`tar -a -c -f <out>.zip -C <插件目录> .`
 *     → ZIP 根直接含 .qoder-plugin/（官方规范）。
 *
 * 产物：adapters/dist/dsh-infinite-canvas-qoder-0.1.0.zip
 * 逻辑自足，可被 Task 9 总编排脚本复用（导出 buildQoder）。
 * 退出码：0 = 成功；1 = 清单校验/tar 失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // adapters/scripts
const ADAPTERS_DIR = path.resolve(HERE, '..'); // adapters/
const REPO_ROOT = path.resolve(ADAPTERS_DIR, '..'); // 仓库根
const PLUGIN_DIR = path.join(ADAPTERS_DIR, 'qoder-plugin');
const DIST_DIR = path.join(PLUGIN_DIR, 'dist');
const CORE_DST = path.join(DIST_DIR, 'core');
const OUT_DIR = path.join(ADAPTERS_DIR, 'dist');
const VERSION = '0.1.0'; // 与 .qoder-plugin/plugin.json 版本一致
const OUT_ZIP = path.join(OUT_DIR, `dsh-infinite-canvas-qoder-${VERSION}.zip`);

// HOST-CONTRACT.md §4 RUNTIME_FILES（import 闭包表：仓库路径 → dist/core/ 下同名）
const RUNTIME_FILES = [
  'index.js',
  'index-core-skill-profile.js',
  'skill-pack-loader.js',
  'skill-pack.js',
  'production.js',
  'package.json',
];
// §4 运行时读取清单：canvas 内置技能 SKILL.md ×4 + canvas-director 技能包整体
const SKILL_DIRS = ['canvas-studio', 'canvas-craft', 'canvas-layout', 'canvas-director'];
// 画布前端随包文件（brief Step 1 断言 dist/core/client.js；仓库根同名文件）
const CLIENT_BUNDLE = 'client.js';

/** 递归拷贝目录（目标不存在则创建；仅普通文件与目录，符号链接跳过并告警）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) {
      console.error(`[build-qoder] 跳过符号链接: ${s}`);
    } else if (st.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export function buildQoder() {
  // 0) 源清单自检：壳源文件必须就位（plugin.json/.mcp.json/SKILL.md 是随仓提交的源，不在本脚本生成范围）
  const sources = [
    path.join(PLUGIN_DIR, '.qoder-plugin', 'plugin.json'),
    path.join(PLUGIN_DIR, '.mcp.json'),
    path.join(PLUGIN_DIR, 'skills', 'canvas', 'SKILL.md'),
    path.join(PLUGIN_DIR, 'README.md'),
  ];
  for (const f of sources) {
    if (!fs.existsSync(f)) throw new Error('qoder-plugin 壳源缺失: ' + f);
  }

  // 1) dist 同步（幂等：先删后拷，防旧残留混入）
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1a) shared 五模块（*.cjs 原样拷贝，一字不改）
  const sharedSrc = path.join(ADAPTERS_DIR, 'shared');
  const sharedModules = fs.readdirSync(sharedSrc).filter((f) => f.endsWith('.cjs'));
  for (const f of sharedModules) fs.copyFileSync(path.join(sharedSrc, f), path.join(DIST_DIR, f));

  // 1b) core：§4 import 闭包 6 文件
  fs.mkdirSync(CORE_DST, { recursive: true });
  for (const f of RUNTIME_FILES) {
    const src = path.join(REPO_ROOT, f);
    if (!fs.existsSync(src)) throw new Error(`§4 RUNTIME_FILES 缺失: ${f}`);
    fs.copyFileSync(src, path.join(CORE_DST, f));
  }

  // 1c) core/assets：canvas 内置技能 ×4 + canvas-director 技能包整体
  const assetsDst = path.join(CORE_DST, 'assets');
  fs.mkdirSync(assetsDst, { recursive: true });
  for (const dir of SKILL_DIRS) {
    const src = path.join(REPO_ROOT, 'assets', dir);
    if (!fs.existsSync(src)) throw new Error(`§4 运行时资源缺失: assets/${dir}`);
    copyDir(src, path.join(assetsDst, dir));
  }

  // 1d) client.js（brief Step 1 断言要求的画布前端随包文件）
  const clientSrc = path.join(REPO_ROOT, CLIENT_BUNDLE);
  if (!fs.existsSync(clientSrc)) throw new Error(`画布前端随包文件缺失: ${CLIENT_BUNDLE}`);
  fs.copyFileSync(clientSrc, path.join(CORE_DST, CLIENT_BUNDLE));

  // 2) ZIP 打包：系统 tar（win32 = bsdtar），-a 按扩展名选 zip 格式；-C 插件目录 + `.` → ZIP 根
  //    直接含 .qoder-plugin/（官方规范）。
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(OUT_ZIP, { force: true });
  const tar = spawnSync('tar', ['-a', '-c', '-f', OUT_ZIP, '-C', PLUGIN_DIR, '.'], { encoding: 'buffer', timeout: 120000 });
  if (tar.error) throw new Error('tar spawn 失败: ' + tar.error.message);
  if (tar.status !== 0) {
    throw new Error(`tar 打包失败（exit ${tar.status}）: ${String(tar.stderr || '')}`);
  }

  // 3) 自检：产物存在 + 条目抽查（ZIP 根含 .qoder-plugin/plugin.json）
  if (!fs.existsSync(OUT_ZIP)) throw new Error('tar 报告成功但 ZIP 不存在: ' + OUT_ZIP);
  const list = spawnSync('tar', ['-tf', OUT_ZIP], { encoding: 'utf8', timeout: 60000 });
  if (list.status !== 0) throw new Error('tar -tf 自检失败: ' + (list.stderr || list.status));
  const entries = list.stdout.split(/\r?\n/).map((e) => e.replace(/^\.\//, '')).filter(Boolean);
  for (const rel of ['.qoder-plugin/plugin.json', '.mcp.json', 'skills/canvas/SKILL.md', 'dist/canvas-mcp.cjs', 'dist/core/index.js']) {
    if (!entries.includes(rel)) throw new Error('ZIP 条目自检失败，缺 ' + rel);
  }

  const size = fs.statSync(OUT_ZIP).size;
  console.log(`[build-qoder] shared 模块: ${sharedModules.length} 个 → dist/`);
  console.log(`[build-qoder] core RUNTIME_FILES: ${RUNTIME_FILES.length} 个 + assets 技能 ×${SKILL_DIRS.length} + ${CLIENT_BUNDLE} → dist/core/`);
  console.log(`[build-qoder] ZIP 条目: ${entries.length} 个`);
  console.log(`[build-qoder] 完成 → ${OUT_ZIP}（${(size / 1024).toFixed(0)} KB）`);
  return OUT_ZIP;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildQoder();
  } catch (e) {
    console.error('[build-qoder] 失败: ' + ((e && e.message) || e));
    process.exit(1);
  }
}
