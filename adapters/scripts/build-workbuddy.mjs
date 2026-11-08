#!/usr/bin/env node
/**
 * build-workbuddy（Task 8，Task 9 抽公共改造）——workbuddy-plugin 本地目录市场自足构建（零 npm 依赖：node 内置 + 系统 tar）。
 *
 * 市场形态：WorkBuddy 装插件 = 加本地目录市场（known_marketplaces.json 实证 directory / zip URL
 * 两种 type）。市场根含 .codebuddy-plugin/marketplace.json，插件目录 = .codebuddy-plugin/plugin.json
 * + .mcp.json（stdio，${CODEBUDDY_PLUGIN_ROOT} 指插件根，command:"node" 走 PATH 合法——官方样本
 * godot-mcp 实证）+ skills/ + dist/。
 *
 *  1) dist 同步（幂等，先删后拷）：按 HOST-CONTRACT.md §4 RUNTIME_FILES 把 shared 五模块 + core
 *     拷进 marketplace/plugins/dsh-infinite-canvas/dist/，布局照 §5：dist/canvas-mcp.cjs 等 +
 *     dist/core/（含 assets/ 与 package.json）。shared 清单**枚举 + 缺失报错**，勿 readdir 自动发现
 *     （Task 7 评审 Minor #2 的教训）；shared/vendor/（Task 14：React UMD，canvas-web 真 UI 壳
 *     的静态资产）随 shared → dist/vendor/。client.js **随包**（0.3.0 Task 14 回归：canvas-web
 *     壳装载的浏览器 UI 资产，0.2.0 的「不随包」勘误已被实证推翻）。
 *  2) 版本号单源：从插件 .codebuddy-plugin/plugin.json 读（Task 7 评审 Minor #3），并与
 *     marketplace.json 条目版本做一致性校验（不同步即报错，防双处漂移）。
 *  3) 产物：staging 完整市场拷贝 → adapters/dist/workbuddy-marketplace/；zip → 系统 tar
 *     （win32 = bsdtar）`tar -a -c -f <out>.zip -C <staging> .` → ZIP 根直接含
 *     .codebuddy-plugin/marketplace.json（官方规范）。
 *
 * 产物：adapters/dist/workbuddy-marketplace/（目录形态市场）
 *       adapters/dist/dsh-marketplace-workbuddy-<version>.zip（zip 分发物）
 * 公共函数在 ./lib/build-common.cjs（Task 9 carry：copyDir/枚举拷贝/版本单源/tar 打包自检，
 * 本脚本即抽公共基准版），行为等价改造——产物树不变，scripts/test-adapters-workbuddy-pkg.mjs 钉死。
 * 红线：本脚本只写 adapters/dist/ 与 marketplace 内 dist/，绝不触碰 ~/.workbuddy
 * （注册延后 Task 11）。
 * 退出码：0 = 成功；1 = 清单校验/tar 失败。
 */
import { assertStaging, copyDir, copyEnumerated, packZip, readVersion } from './lib/build-common.cjs';
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

// shared 五模块（§5 dist 布局；**枚举清单 + 缺失报错**——勿自动发现，Task 7 评审 Minor #2 教训）
const SHARED_MODULES = [
  'canvas-mcp.cjs',
  'canvas-web.cjs',
  'host-adapter.cjs',
  'llm-channel.cjs',
  'model-bridge.cjs',
];
// HOST-CONTRACT.md §4 RUNTIME_FILES（import 闭包表 + client.js：仓库路径 → dist/core/ 下同名；
// client.js 是 canvas-web 壳装载的浏览器 UI 资产，Task 14 回归）
const RUNTIME_FILES = [
  'index.js',
  'index-core-skill-profile.js',
  'skill-pack-loader.js',
  'skill-pack.js',
  'production.js',
  'package.json',
  'client.js',
];
// shared/vendor（Task 14：React UMD；Task 15：ReactDOM UMD——壳内模拟 Harness 后壳自渲染必需）
const SHARED_VENDOR_FILES = ['vendor/react.production.min.js', 'vendor/react-dom.production.min.js'];
// §4 运行时读取清单：canvas 内置技能 SKILL.md ×4 + canvas-director 技能包整体
const SKILL_DIRS = ['canvas-studio', 'canvas-craft', 'canvas-layout', 'canvas-director'];

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
  //     （pluginJson.name 另供条目匹配——市场与插件必须同名，原语义保留）
  const pluginJsonPath = path.join(PLUGIN_DIR, '.codebuddy-plugin', 'plugin.json');
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  const VERSION = readVersion(pluginJsonPath);
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

  // 1a) shared 五模块（枚举清单，缺失报错；*.cjs 原样拷贝，一字不改）+ vendor 资产（Task 14）
  const sharedSrc = path.join(ADAPTERS_DIR, 'shared');
  copyEnumerated(sharedSrc, SHARED_MODULES, DIST_DIR, 'shared 模块');
  fs.mkdirSync(path.join(DIST_DIR, 'vendor'), { recursive: true }); // copyEnumerated 不建目录
  copyEnumerated(sharedSrc, SHARED_VENDOR_FILES, DIST_DIR, 'shared vendor 资产');

  // 1b) core：§4 import 闭包 6 文件 + client.js（浏览器 UI 资产，Task 14 回归）
  fs.mkdirSync(CORE_DST, { recursive: true });
  copyEnumerated(REPO_ROOT, RUNTIME_FILES, CORE_DST, '§4 RUNTIME_FILES');

  // 1c) core/assets：canvas 内置技能 ×4 + canvas-director 技能包整体
  const assetsDst = path.join(CORE_DST, 'assets');
  fs.mkdirSync(assetsDst, { recursive: true });
  for (const dir of SKILL_DIRS) {
    const src = path.join(REPO_ROOT, 'assets', dir);
    if (!fs.existsSync(src)) throw new Error(`§4 运行时资源缺失: assets/${dir}`);
    copyDir(src, path.join(assetsDst, dir), 'build-workbuddy');
  }

  // 1d) client.js 随包（0.3.0 Task 14：canvas-web 壳装载的浏览器 UI 资产，随 1b RUNTIME_FILES 拷入）

  // 2) staging：完整市场拷贝（目录形态产物本身即可作本地市场源）
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  copyDir(MARKETPLACE_DIR, STAGING_DIR, 'build-workbuddy');

  // 2a) staging 自检（Task 8 原有 6 文件存在性检查；Task 9 抽公共时误删，评审 Important 恢复）
  assertStaging(STAGING_DIR, [
    path.join('.codebuddy-plugin', 'marketplace.json'),
    path.join('plugins', 'dsh-infinite-canvas', '.codebuddy-plugin', 'plugin.json'),
    path.join('plugins', 'dsh-infinite-canvas', '.mcp.json'),
    path.join('plugins', 'dsh-infinite-canvas', 'skills', 'canvas', 'SKILL.md'),
    path.join('plugins', 'dsh-infinite-canvas', 'dist', 'canvas-mcp.cjs'),
    path.join('plugins', 'dsh-infinite-canvas', 'dist', 'core', 'index.js'),
    path.join('plugins', 'dsh-infinite-canvas', 'dist', 'core', 'client.js'),
    path.join('plugins', 'dsh-infinite-canvas', 'dist', 'vendor', 'react.production.min.js'),
    path.join('plugins', 'dsh-infinite-canvas', 'dist', 'vendor', 'react-dom.production.min.js'),
  ]);

  // 3) zip 打包 + 条目自检（公共 packZip：ZIP 根直接含 .codebuddy-plugin/marketplace.json，官方规范）
  const entries = packZip(STAGING_DIR, OUT_ZIP, [
    '.codebuddy-plugin/marketplace.json',
    'plugins/dsh-infinite-canvas/.codebuddy-plugin/plugin.json',
    'plugins/dsh-infinite-canvas/dist/canvas-mcp.cjs',
    'plugins/dsh-infinite-canvas/dist/core/client.js',
    'plugins/dsh-infinite-canvas/dist/vendor/react.production.min.js',
    'plugins/dsh-infinite-canvas/dist/vendor/react-dom.production.min.js',
  ]);

  const size = fs.statSync(OUT_ZIP).size;
  console.log(`[build-workbuddy] shared 模块: ${SHARED_MODULES.length} 个（枚举清单）+ vendor 资产 ${SHARED_VENDOR_FILES.length} 个 → plugins/dsh-infinite-canvas/dist/`);
  console.log(`[build-workbuddy] core RUNTIME_FILES: ${RUNTIME_FILES.length} 个（含 client.js）+ assets 技能 ×${SKILL_DIRS.length} → dist/core/`);
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
