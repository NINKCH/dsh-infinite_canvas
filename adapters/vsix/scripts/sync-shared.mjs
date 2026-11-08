#!/usr/bin/env node
/**
 * sync-shared（Task 6，vsix 壳构建步骤）——把发布物拷进 vsix，形成零依赖自足布局：
 *
 *   adapters/shared/*.cjs            → adapters/vsix/shared/*.cjs        （五模块：host-adapter /
 *   仓库根 RUNTIME_FILES             → adapters/vsix/shared/core/<同名>    canvas-mcp / canvas-web /
 *   assets/canvas-<模式>/SKILL.md    → adapters/vsix/shared/core/assets/   model-bridge / llm-channel）
 *   assets/canvas-director/**        → adapters/vsix/shared/core/assets/
 *   仓库根 LICENSE                   → adapters/vsix/LICENSE              （vsce LICENSE 告警处理）
 *
 * 清单以 HOST-CONTRACT.md §4 RUNTIME_FILES 为准（brief 逐字）：
 *   - import 闭包 6 文件：index.js / index-core-skill-profile.js / skill-pack-loader.js /
 *     skill-pack.js / production.js / package.json（core L38 import 时同步读 package.json，缺了会崩）；
 *   - 运行时读取（非 import，打包须随行）：assets/canvas-{studio,craft,layout,director}/SKILL.md
 *     （index.js L2046 相 HERE 解析）、assets/canvas-director/**（skill-pack-loader PACK_DIR_REL，
 *     index.js L31 initPackBase(HERE)）。
 *   - assets/director/**（3D 引擎静态资源，npm files 有、§4 无）不随行，按 §4 清单执行；
 *     后果记录在 HOST-CONTRACT.md §11 与任务报告。
 *   - **client.js 不在清单**（§4 勘误，Task 7 controller 裁定：Harness 控制台前端，index.js 不
 *     import）——core 侧仅按 RUNTIME_FILES 枚举拷贝，client.js 副本绝不进 vsix（Task 9 瘦身，
 *     同步后自检反向断言，防旧残留/误拷混入）。
 *
 * 幂等：先删后拷。执行：node vsix/scripts/sync-shared.mjs（或 adapters/ 内 npm run sync）。
 * 退出码：0 = 成功；1 = 清单校验失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // adapters/vsix/scripts
const VSIX_DIR = path.resolve(HERE, '..'); // adapters/vsix
const ADAPTERS_DIR = path.resolve(VSIX_DIR, '..'); // adapters/
const REPO_ROOT = path.resolve(ADAPTERS_DIR, '..'); // 仓库根
const SHARED_SRC = path.join(ADAPTERS_DIR, 'shared');
const SHARED_DST = path.join(VSIX_DIR, 'shared');
const CORE_DST = path.join(SHARED_DST, 'core');

// HOST-CONTRACT.md §4 RUNTIME_FILES（import 闭包表：仓库路径 → core/ 下同名）
const RUNTIME_FILES = [
  'index.js',
  'index-core-skill-profile.js',
  'skill-pack-loader.js',
  'skill-pack.js',
  'production.js',
  'package.json',
];
// §4 运行时读取清单：内置技能 SKILL.md + canvas-director 技能包整体
const SKILL_DIRS = ['canvas-studio', 'canvas-craft', 'canvas-layout', 'canvas-director'];

/** 递归拷贝目录（目标不存在则创建；仅普通文件与目录，符号链接跳过并告警）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isSymbolicLink()) {
      console.error(`[sync-shared] 跳过符号链接: ${s}`);
    } else if (st.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

try {
  // 1) 清空重建 shared 目标（幂等：先删后拷，防旧残留混入）
  fs.rmSync(SHARED_DST, { recursive: true, force: true });
  fs.mkdirSync(SHARED_DST, { recursive: true });

  // 2) shared 五模块（*.cjs 原样拷贝，一字不改）
  const sharedModules = fs.readdirSync(SHARED_SRC).filter((f) => f.endsWith('.cjs'));
  for (const f of sharedModules) fs.copyFileSync(path.join(SHARED_SRC, f), path.join(SHARED_DST, f));

  // 3) core：§4 import 闭包 6 文件
  fs.mkdirSync(CORE_DST, { recursive: true });
  for (const f of RUNTIME_FILES) {
    const src = path.join(REPO_ROOT, f);
    if (!fs.existsSync(src)) throw new Error(`§4 RUNTIME_FILES 缺失: ${f}`);
    fs.copyFileSync(src, path.join(CORE_DST, f));
  }

  // 4) core/assets：canvas 内置技能 SKILL.md ×4 + canvas-director 技能包
  const assetsDst = path.join(CORE_DST, 'assets');
  fs.mkdirSync(assetsDst, { recursive: true });
  for (const dir of SKILL_DIRS) {
    const src = path.join(REPO_ROOT, 'assets', dir);
    if (!fs.existsSync(src)) throw new Error(`§4 运行时资源缺失: assets/${dir}`);
    copyDir(src, path.join(assetsDst, dir));
  }

  // 5) LICENSE（vsce 打包 LICENSE 告警处理，brief Step 4『按告警补』）
  const licenseSrc = path.join(REPO_ROOT, 'LICENSE');
  if (fs.existsSync(licenseSrc)) fs.copyFileSync(licenseSrc, path.join(VSIX_DIR, 'LICENSE'));

  // 6) 清单自检：core 入口 + 五模块 + 技能包入口必须落位
  const mustExist = [
    path.join(CORE_DST, 'index.js'),
    path.join(CORE_DST, 'package.json'),
    path.join(assetsDst, 'canvas-director', 'manifest.json'),
    path.join(assetsDst, 'canvas-studio', 'SKILL.md'),
    ...sharedModules.map((f) => path.join(SHARED_DST, f)),
  ];
  for (const f of mustExist) {
    if (!fs.existsSync(f)) throw new Error('同步后校验失败（产物缺失）: ' + f);
  }

  // 7) 瘦身反向自检（Task 9 carry）：client.js 绝不在 core 清单（§4 勘误），旧残留/误拷混入即报错
  if (fs.existsSync(path.join(CORE_DST, 'client.js'))) {
    throw new Error('瘦身自检失败: shared/core/client.js 不应存在（§4 勘误：Harness 控制台前端，controller 裁定剔除）');
  }

  const countFiles = (dir) => {
    let n = 0;
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else n++;
      }
    };
    walk(dir);
    return n;
  };
  console.log(`[sync-shared] shared 模块: ${sharedModules.length} 个（${sharedModules.join(', ')}）`);
  console.log(`[sync-shared] core RUNTIME_FILES: ${RUNTIME_FILES.length} 个 → shared/core/`);
  console.log(`[sync-shared] core/assets 文件: ${countFiles(assetsDst)} 个（canvas 技能 ×${SKILL_DIRS.length}）`);
  console.log('[sync-shared] 完成 → ' + SHARED_DST);
} catch (e) {
  console.error('[sync-shared] 失败: ' + ((e && e.message) || e));
  process.exit(1);
}
