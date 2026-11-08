#!/usr/bin/env node
/**
 * build-qoder（Task 7，Task 9 抽公共改造）——qoder-plugin ZIP 自足构建（零 npm 依赖：node 内置 + 系统 tar）。
 *
 *  1) dist 同步（幂等，先删后拷）：按 HOST-CONTRACT.md §4 RUNTIME_FILES 把 shared 五模块 + core
 *     拷进 adapters/qoder-plugin/dist/，布局照 §5：dist/canvas-mcp.cjs 等 + dist/core/（含 assets/
 *     与 package.json）。shared 清单**枚举 + 缺失报错**（Task 9 对齐 workbuddy 基准，勿 readdir
 *     自动发现——Task 7 评审 Minor #2 的教训）；client.js 不随包（§4 勘误：Harness 控制台前端，
 *     index.js 不 import，Task 7 controller 裁定剔除，曾按 brief 断言随包属死重）。
 *  2) 版本号单源（Task 9 对齐 workbuddy 基准）：从 .qoder-plugin/plugin.json 读，semver 形状校验，
 *     硬编码 '0.1.0' 废弃（防改版本只改文件名不改 manifest）。
 *  3) ZIP 打包：系统 tar（win32 = bsdtar）`tar -a -c -f <out>.zip -C <插件目录> .`
 *     → ZIP 根直接含 .qoder-plugin/（官方规范）。
 *
 * 产物：adapters/dist/dsh-infinite-canvas-qoder-<version>.zip
 * 公共函数在 ./lib/build-common.cjs（Task 9 carry：copyDir/枚举拷贝/版本单源/tar 打包自检），
 * 行为等价改造——产物树不变，scripts/test-adapters-qoder-pkg.mjs 钉死。
 * 退出码：0 = 成功；1 = 清单校验/tar 失败。
 */
import { copyDir, copyEnumerated, packZip, readVersion } from './lib/build-common.cjs';
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

  // 0a) 版本号单源：从 plugin.json 读（Task 9 对齐 workbuddy 基准，硬编码废弃）
  const VERSION = readVersion(path.join(PLUGIN_DIR, '.qoder-plugin', 'plugin.json'));
  const OUT_ZIP = path.join(OUT_DIR, `dsh-infinite-canvas-qoder-${VERSION}.zip`);

  // 1) dist 同步（幂等：先删后拷，防旧残留混入）
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1a) shared 五模块（枚举清单，缺失报错；*.cjs 原样拷贝，一字不改）
  const sharedSrc = path.join(ADAPTERS_DIR, 'shared');
  copyEnumerated(sharedSrc, SHARED_MODULES, DIST_DIR, 'shared 模块');

  // 1b) core：§4 import 闭包 6 文件
  fs.mkdirSync(CORE_DST, { recursive: true });
  copyEnumerated(REPO_ROOT, RUNTIME_FILES, CORE_DST, '§4 RUNTIME_FILES');

  // 1c) core/assets：canvas 内置技能 ×4 + canvas-director 技能包整体
  const assetsDst = path.join(CORE_DST, 'assets');
  fs.mkdirSync(assetsDst, { recursive: true });
  for (const dir of SKILL_DIRS) {
    const src = path.join(REPO_ROOT, 'assets', dir);
    if (!fs.existsSync(src)) throw new Error(`§4 运行时资源缺失: assets/${dir}`);
    copyDir(src, path.join(assetsDst, dir), 'build-qoder');
  }

  // 1d) client.js 不随包（§4 勘误：Harness 控制台前端，index.js 不 import，controller 裁定剔除）

  // 2) ZIP 打包 + 条目自检（公共 packZip：ZIP 根直接含 .qoder-plugin/，官方规范）
  const entries = packZip(PLUGIN_DIR, OUT_ZIP, [
    '.qoder-plugin/plugin.json', '.mcp.json', 'skills/canvas/SKILL.md', 'dist/canvas-mcp.cjs', 'dist/core/index.js',
  ]);

  const size = fs.statSync(OUT_ZIP).size;
  console.log(`[build-qoder] shared 模块: ${SHARED_MODULES.length} 个（枚举清单）→ dist/`);
  console.log(`[build-qoder] core RUNTIME_FILES: ${RUNTIME_FILES.length} 个 + assets 技能 ×${SKILL_DIRS.length} → dist/core/`);
  console.log(`[build-qoder] 版本 ${VERSION}（单源: .qoder-plugin/plugin.json）`);
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
