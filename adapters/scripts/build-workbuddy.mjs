#!/usr/bin/env node
/**
 * build-workbuddy（Task 8）——workbuddy-plugin 本地目录市场自足构建（零 npm 依赖：node 内置 + 系统 tar）。
 *
 * 市场形态：WorkBuddy 装插件 = 加本地目录市场（known_marketplaces.json 实证 directory / zip URL
 * 两种 type）。市场根含 .codebuddy-plugin/marketplace.json，插件目录 = .codebuddy-plugin/plugin.json
 * + .mcp.json（stdio，${CODEBUDDY_PLUGIN_ROOT} 指插件根，command:"node" 走 PATH 合法——官方样本
 * godot-mcp 实证）+ skills/ + dist/。
 *
 *  1) dist 同步（幂等，先删后拷）：按 HOST-CONTRACT.md §4 RUNTIME_FILES 把 shared 五模块 + core
 *     拷进 marketplace/plugins/dsh-infinite-canvas/dist/，布局照 §5：dist/canvas-mcp.cjs 等 +
 *     dist/core/（含 assets/ 与 package.json）。shared 清单**枚举 + 缺失报错**，勿 readdir 自动发现
 *     （Task 7 评审 Minor #2 的教训）；client.js 不随包（§4 勘误：Harness 控制台前端，index.js 不
 *     import，Task 7 controller 裁定剔除）。
 *  2) 版本号单源：从插件 .codebuddy-plugin/plugin.json 读（Task 7 评审 Minor #3），并与
 *     marketplace.json 条目版本做一致性校验（不同步即报错，防双处漂移）。
 *  3) 产物：staging 完整市场拷贝 → adapters/dist/workbuddy-marketplace/；zip → 系统 tar
 *     （win32 = bsdtar）`tar -a -c -f <out>.zip -C <staging> .` → ZIP 根直接含
 *     .codebuddy-plugin/marketplace.json（官方规范）。
 *
 * 产物：adapters/dist/workbuddy-marketplace/（目录形态市场）
 *       adapters/dist/dsh-marketplace-workbuddy-<version>.zip（zip 分发物）
 * 逻辑自足，可被 Task 9 总编排脚本复用（导出 buildWorkbuddy）；不改 build-qoder.mjs
 * （零跨任务回归面，两脚本小重复可接受，Task 9 再统一）。
 * 红线：本脚本只写 adapters/dist/ 与 marketplace 内 dist/，绝不触碰 ~/.workbuddy
 * （注册延后 Task 11）。
 * 退出码：0 = 成功；1 = 清单校验/tar 失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // adapters/scripts
const ADAPTERS_DIR = path.resolve(HERE, '..'); // adapters/
const REPO_ROOT = path.resolve(ADAPTERS_DIR, '..'); // 仓库根
const MARKETPLACE_DIR = path.join(ADAPTERS_DIR, 'workbuddy-plugin', 'marketplace'); // 市场根（源）
const PLUGIN_DIR = path.join(MARKETPLACE_DIR, 'plugins', 'dsh-infinite-canvas'); // 插件目录（源）
const DIST_DIR = path.join(PLUGIN_DIR, 'dist');
const CORE_DST = path.join(DIST_DIR, 'core');
const STAGING_DIR = path.join(ADAPTERS_DIR, 'dist', 'workbuddy-marketplace'); // staging 完整市场
const OUT_DIR = path.join(ADAPTERS_DIR, 'dist');
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/; // semver 形状（防读坏版本拼坏文件名）

// shared 五模块（§5 dist 布局；**枚举清单 + 缺失报错**——勿自动发现，Task 7 评审 Minor #2 教训）
const SHARED_MODULES = [
  'canvas-mcp.cjs',
  'canvas-web.cjs',
  'host-adapter.cjs',
  'llm-channel.cjs',
  'model-bridge.cjs',
];
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

/** 递归拷贝目录（目标不存在则创建；仅普通文件与目录，符号链接跳过并告警）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) {
      console.error(`[build-workbuddy] 跳过符号链接: ${s}`);
    } else if (st.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export function buildWorkbuddy() {
  // 0) 源清单自检：壳源文件必须就位（三个 JSON/SKILL.md/README 是随仓提交的源，不在本脚本生成范围）
  const sources = [
    path.join(MARKETPLACE_DIR, '.codebuddy-plugin', 'marketplace.json'),
    path.join(PLUGIN_DIR, '.codebuddy-plugin', 'plugin.json'),
    path.join(PLUGIN_DIR, '.mcp.json'),
    path.join(PLUGIN_DIR, 'skills', 'canvas', 'SKILL.md'),
    path.join(PLUGIN_DIR, 'README.md'),
  ];
  for (const f of sources) {
    if (!fs.existsSync(f)) throw new Error('workbuddy-plugin 壳源缺失: ' + f);
  }

  // 0a) 版本号单源：从 plugin.json 读（Task 7 评审 Minor #3），并与 marketplace.json 条目对账
  const pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.codebuddy-plugin', 'plugin.json'), 'utf8'));
  const VERSION = pluginJson && pluginJson.version;
  if (typeof VERSION !== 'string' || !VERSION_RE.test(VERSION)) {
    throw new Error('plugin.json version 缺失或非 semver 形状: ' + JSON.stringify(VERSION));
  }
  const marketplaceJson = JSON.parse(fs.readFileSync(path.join(MARKETPLACE_DIR, '.codebuddy-plugin', 'marketplace.json'), 'utf8'));
  const entry = Array.isArray(marketplaceJson.plugins) && marketplaceJson.plugins.find((p) => p && p.name === pluginJson.name);
  if (!entry) throw new Error('marketplace.json 无 ' + pluginJson.name + ' 条目（市场与插件必须同名）');
  if (entry.version !== VERSION) {
    throw new Error(`版本漂移：plugin.json=${VERSION} 而 marketplace.json 条目=${entry.version}（两处须同步改）`);
  }
  const OUT_ZIP = path.join(OUT_DIR, `dsh-marketplace-workbuddy-${VERSION}.zip`);

  // 1) dist 同步（幂等：先删后拷，防旧残留混入）
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1a) shared 五模块（枚举清单，缺失报错；*.cjs 原样拷贝，一字不改）
  const sharedSrc = path.join(ADAPTERS_DIR, 'shared');
  for (const f of SHARED_MODULES) {
    const src = path.join(sharedSrc, f);
    if (!fs.existsSync(src)) throw new Error('shared 模块缺失: ' + f);
    fs.copyFileSync(src, path.join(DIST_DIR, f));
  }

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

  // 1d) client.js 不随包（§4 勘误：Harness 控制台前端，index.js 不 import，controller 裁定剔除）

  // 2) staging：完整市场拷贝（目录形态产物本身即可作本地市场源）
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  copyDir(MARKETPLACE_DIR, STAGING_DIR);

  // 3) zip 打包：系统 tar（win32 = bsdtar），-a 按扩展名选 zip 格式；-C staging + `.` → ZIP 根
  //    直接含 .codebuddy-plugin/marketplace.json（官方规范）。
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(OUT_ZIP, { force: true });
  const tar = spawnSync('tar', ['-a', '-c', '-f', OUT_ZIP, '-C', STAGING_DIR, '.'], { encoding: 'buffer', timeout: 120000 });
  if (tar.error) throw new Error('tar spawn 失败: ' + tar.error.message);
  if (tar.status !== 0) {
    throw new Error(`tar 打包失败（exit ${tar.status}）: ${String(tar.stderr || '')}`);
  }

  // 4) 自检：staging 关键文件存在 + zip 条目抽查（ZIP 根含 .codebuddy-plugin/marketplace.json）
  const stagingMust = [
    path.join('.codebuddy-plugin', 'marketplace.json'),
    path.join('plugins', 'dsh-infinite-canvas', '.codebuddy-plugin', 'plugin.json'),
    path.join('plugins', 'dsh-infinite-canvas', '.mcp.json'),
    path.join('plugins', 'dsh-infinite-canvas', 'skills', 'canvas', 'SKILL.md'),
    path.join('plugins', 'dsh-infinite-canvas', 'dist', 'canvas-mcp.cjs'),
    path.join('plugins', 'dsh-infinite-canvas', 'dist', 'core', 'index.js'),
  ];
  for (const rel of stagingMust) {
    if (!fs.existsSync(path.join(STAGING_DIR, rel))) throw new Error('staging 自检失败，缺 ' + rel);
  }
  if (!fs.existsSync(OUT_ZIP)) throw new Error('tar 报告成功但 zip 不存在: ' + OUT_ZIP);
  const list = spawnSync('tar', ['-tf', OUT_ZIP], { encoding: 'utf8', timeout: 60000 });
  if (list.status !== 0) throw new Error('tar -tf 自检失败: ' + (list.stderr || list.status));
  const entries = list.stdout.split(/\r?\n/).map((e) => e.replace(/^\.\//, '')).filter(Boolean);
  for (const rel of ['.codebuddy-plugin/marketplace.json', 'plugins/dsh-infinite-canvas/.codebuddy-plugin/plugin.json', 'plugins/dsh-infinite-canvas/dist/canvas-mcp.cjs']) {
    if (!entries.includes(rel)) throw new Error('zip 条目自检失败，缺 ' + rel);
  }

  const size = fs.statSync(OUT_ZIP).size;
  console.log(`[build-workbuddy] shared 模块: ${SHARED_MODULES.length} 个（枚举清单）→ plugins/dsh-infinite-canvas/dist/`);
  console.log(`[build-workbuddy] core RUNTIME_FILES: ${RUNTIME_FILES.length} 个 + assets 技能 ×${SKILL_DIRS.length} → dist/core/`);
  console.log(`[build-workbuddy] 版本 ${VERSION}（单源: plugin.json，marketplace.json 对账通过）`);
  console.log(`[build-workbuddy] staging 市场 → ${STAGING_DIR}`);
  console.log(`[build-workbuddy] zip 条目: ${entries.length} 个 → ${OUT_ZIP}（${(size / 1024).toFixed(0)} KB）`);
  return { staging: STAGING_DIR, zip: OUT_ZIP, version: VERSION };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildWorkbuddy();
  } catch (e) {
    console.error('[build-workbuddy] 失败: ' + ((e && e.message) || e));
    process.exit(1);
  }
}
