#!/usr/bin/env node
/**
 * 发布前打包校验（dev-only，不随包发布）。
 *
 * 原理：`npm pack --dry-run --json` 得到"将要发布"的文件清单，
 * 与预期白名单逐一核对，并校验 package.json 关键字段 —— 防止漏打包 / 多打包 / 元数据漂移。
 *
 * 运行：node scripts/check-pack.mjs
 * 退出码：0 = 通过；1 = 有问题（会逐条列出）。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED = [
  'skills.js',
  'skills/director-workshop/SKILL.md',
  'package.json',
  'index.js',
  'client.js',
  // 根级 JS 模块全覆盖（0.20.2 事故的显式防线第二层：相对 import 审计之外，任何
  // 一个根模块被误删/漏提交时直接报「缺少必打包文件」，而不是等 import 解析失败）。
  'production.js',
  'shot-segments.js',
  'combat-semantics.js',
  'skill-pack.js',
  'skill-pack-loader.js',
  'index-core-skill-profile.js',
  'icon.svg',
  'cordis.patch.yml',
  'README.md',
  'README.zh-CN.md',
  'locale/en.json',
  'locale/zh.json',
  'assets/canvas-studio/SKILL.md',
  'assets/canvas-director/SKILL.md',
  'assets/canvas-director/manifest.json',
  'assets/canvas-director/pack.js',
  'assets/canvas-craft/SKILL.md',
  'assets/support/README.md',
  'assets/director/engine.js',
  'assets/director/models/index.json',
  'assets/director/models/xbot.json',
  'assets/support/wechat.png',
  'docs/artcraft-handoff.md',
  'docs/host-agnostic.md',
  'docs/release.md',
];
// 包内允许出现的路径形态（package.json 与 LICENSE 由 npm 恒定收入，无需列 files 白名单）
// assets/support/*：帮助与反馈用的微信二维码等界面静态资源（必须随包分发，否则用户看不到）
// docs/images/*：README/用户手册引用的截图（文档里的相对路径必须能解析，否则 npm/GitHub 上裂图）
const ALLOWED = /^(package\.json|LICENSE|LICENCE|NOTICE|index\.js|client\.js|production\.js|shot-segments\.js|combat-semantics\.js|skill-pack\.js|skill-pack-loader\.js|index-core-skill-profile\.js|icon\.svg|cordis\.patch\.yml|README(\.zh-CN)?\.md|locale\/[a-zA-Z-]+\.json|assets\/[a-z0-9-]+\/SKILL\.md|assets\/canvas-director\/(?:pack\.js|manifest\.json)|assets\/canvas-director\/(?:lenses|genres|industries|forms|looks|moves)\/[a-z0-9_-]+\.md|assets\/support\/[A-Za-z0-9._-]+|assets\/director\/[a-zA-Z0-9._-]+\.js|assets\/director\/models\/[A-Za-z0-9._-]+\.json|assets\/director\/clips\/[A-Za-z0-9._-]+\.json|skills\.js|skills\/[a-z0-9-]+\/SKILL\.md|docs\/[a-zA-Z0-9._-]+\.md|docs\/images\/[a-zA-Z0-9._-]+\.(png|svg|jpe?g|webp))$/;

const errors = [];
const ok = (msg) => console.log('  ✓ ' + msg);
const fail = (msg) => { errors.push(msg); console.log('  ✗ ' + msg); };

// ---------- 1) package.json 元数据 ----------
console.log('— package.json 元数据');
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (e) {
  console.error('package.json 解析失败：' + e.message);
  process.exit(1);
}
pkg.name === '@ninkch/dsh-infinite-canvas'
  ? ok('name = ' + pkg.name)
  : fail('name 异常：' + pkg.name + '（未作用域包会被 npm E403 拒绝）');
/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(pkg.version)
  ? ok('version = ' + pkg.version)
  : fail('version 不是语义化版本：' + pkg.version);
pkg.publishConfig && pkg.publishConfig.registry === 'https://registry.npmjs.org/'
  ? ok('publishConfig.registry → npmjs')
  : fail('publishConfig.registry 未指向 npmjs');
pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml'
  ? ok('dsh.bundle.patch = ./cordis.patch.yml')
  : fail('dsh.bundle.patch 缺失或不是 ./cordis.patch.yml');
pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'
  ? ok('dsh.client.platform = web')
  : fail('dsh.client.platform ≠ web');
pkg.exports && pkg.exports['./client'] === './client.js' && pkg.exports['.'] === './index.js'
  ? ok('exports（. / ./client）')
  : fail('exports 缺少 . 或 ./client');

// ---------- 2) 打包清单 ----------
console.log('— cordis.patch.yml 检查');
let patchYml = '';
try { patchYml = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8'); } catch (e) { fail('cordis.patch.yml 不可读: ' + (e.message || e)); }
if (patchYml) {
  patchYml.includes('preset-media-studio') ? ok('patch 含 preset-media-studio（媒体创作模式）') : fail('patch 缺 preset-media-studio');
  // media-studio-skills 行【语义修正 2026-11-11】：该行与 profile bundle 层挂载同一物理包 =
  // 重复激活（老版 dsh-studio-mode 警告的加载失败模式）。允许两种状态：行不存在（彻底移除），
  // 或行存在但必须 disabled: true（留档）。断言方向与产品决策一致，不再逼人恢复废弃行。
  {
    const rowRe = /- id: media-studio-skills[\s\S]{0,300}?name: '@ninkch\/dsh-infinite-canvas\/skills'([\s\S]{0,200}?)(?=\n          - id: |\n              - id: |$)/;
    const m = patchYml.match(rowRe);
    if (!m) ok('media-studio-skills 行已移除（director-workshop 由 bundle 层注册）');
    else if (/disabled:\s*true/.test(m[1])) ok('media-studio-skills 行存在且已禁用（防重复挂载）');
    else fail('media-studio-skills 行未禁用：与 bundle 层重复挂载同一物理包会导致预设加载失败（应 disabled: true 或删行）');
  }
  (patchYml.match(/name: '@ninkch\/dsh-infinite-canvas'\s*$/gm) || []).length === 1 ? ok('patch 挂载画布插件行恰好 1 条（本包自身）') : fail('patch 画布插件行数量异常（0 = 忘挂自身，≥2 = 重复挂载导致路由冲突）');
  /name: '@ninkch\/dsh-artcraft'\s*$/m.test(patchYml) ? fail('patch 挂载了 ArtCraft（重复挂载）') : ok('patch 未挂载 ArtCraft');
  patchYml.includes('order: 5') ? ok('模式 order = 5') : fail('patch 缺 order: 5');
  // 废弃子路径守卫（list-agents 事故）：preset 里不得再出现已知被 Harness 移除的子路径行
  /dsh-tool-subagent-control\/list-agents/.test(patchYml) ? fail('patch 含废弃子路径 dsh-tool-subagent-control/list-agents（主入口已统一注册三工具，解析不到模块 → 预设 broken）') : ok('无废弃子路径插件行');
}

console.log('— npm pack --dry-run 清单核对');
let out;
try {
  out = execSync('npm pack --dry-run --json', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  console.error('npm pack 执行失败：' + (e.message || e));
  process.exit(1);
}
let data;
try {
  const j = out.slice(out.indexOf('['));
  data = JSON.parse(j)[0];
} catch (e) {
  console.error('npm pack --json 输出解析失败：' + e.message + '\n原始输出：\n' + out.slice(0, 2000));
  process.exit(1);
}
const files = (data.files ?? []).map((f) => String(f.path).replace(/\\/g, '/'));
const present = new Set(files);

// ---------- 2.5) 相对 import 解析完整性审计 ----------
// 为什么需要这一步（0.20.2 事故）：REQUIRED 是手工维护清单，与 changelog COVERAGE 同款漂移病——
// 新增模块（shot-segments.js）改了 index.js/production.js 的 import，却没人同步白名单，
// 导致 npm 发布包加载即 ERR_MODULE_NOT_FOUND，所有 npm 安装用户全量即死。
// 本审计从机械上杜绝这类事故：对包内每个 .js 文件（含 assets/ 下）扫描全部静态相对 import
// （from './x'、import('./x')、require('./x') 三种形态），按文件所在目录解析目标路径，
// 逐一断言目标也在打包清单内。node: 前缀与裸说明符（非 ./ 开头）跳过。
// 注意：只认静态 import 三形态；fetch / fs 读文件等动态引用不在扫描范围。
// 相对目标必须是带扩展名的文件路径；目录式导入（如 './lib'）解析不到清单条目，按缺失判 fail（fail-closed）。
// 匹配前先剥掉注释（字符串字面量原样保留；client.js 的 JSDoc 里有 import('./assets/...') 这类
// 文档性伪引用，0.20.2 事故复盘时曾造成误报），避免注释内容触发假失败。

/**
 * 剥掉 JS 源码里的注释（行注释/块注释），字符串、模板字符串与正则字面量的内容原样保留。
 * 轻量单遍扫描器：靠「前一个有效字符」区分正则字面量与除号（经典 JSLint 启发式）。
 * 只为打包审计服务，不是完整词法器：构造出来的正则字面量内容（含引号、`//` 等）可能
 * 触发假阳性（审计多报一条 import → fail-closed）或罕见的假阴性；对本仓库包内 .js
 * 已实测无假阳/假阴。代价模型：假阳性只是打包时多一次红，不会漏放真实缺口。
 */
function stripJsComments(src) {
  const REGEX_ALLOWED_PREV = '(,=:[!&|?{};+-*%~^<>'; // 这些字符后跟 / 是正则字面量
  let out = '';
  let prevSig = ''; // 输出侧最近一个非空白字符（用于除号 vs 正则判定）
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && d === '/') { // 行注释：吞到行尾（换行符留给主循环输出）
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') { // 块注释：整体替换成一个空格
      i += 2;
      while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      out += ' ';
      if (prevSig) prevSig = ' '; // 注释不改变正则/除号判定（等价于空白）
      continue;
    }
    if (c === "'" || c === '"') { // 单/双引号字符串：内容原样保留（含转义）
      const q = c;
      out += c; i++;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
        const done = src[i] === q || src[i] === '\n';
        i++;
        if (done) break;
      }
      prevSig = q;
      continue;
    }
    if (c === '`') { // 模板字符串：内容原样保留（含转义；${} 内部按普通文本处理）
      out += c; i++;
      while (i < n) {
        out += src[i];
        if (src[i] === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
        const done = src[i] === '`';
        i++;
        if (done) break;
      }
      prevSig = '`';
      continue;
    }
    if (c === '/' && !(REGEX_ALLOWED_PREV.includes(prevSig)) && !/[a-zA-Z0-9_$)\]'"`]/.test(prevSig)) {
      // 启发式分支：判定为「悬空的 / 开头正则字面量」（如行首）时跳过其内容，避免
      // 正则里的引号污染扫描状态。启发式而非词法级判定：构造性内容可能误入本分支
      //（fail-closed 假阳）或漏进（罕见假阴）；见 stripJsComments JSDoc 的失败模式说明。
      out += ' '; i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break; // 不跨行，防御性兜底
        i++;
      }
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

console.log('— 包内相对 import 解析完整性审计');
{
  // 三种静态相对 import 形态：from './x'（含 export..from）、import('./x')、require('./x')
  const STATIC_REL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
  const errCountBefore = errors.length;
  let auditedFiles = 0;
  let auditedImports = 0;
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    let src;
    try {
      src = readFileSync(path.join(ROOT, f), 'utf8');
    } catch {
      fail('包内 .js 文件不可读（无法审计 import）：' + f);
      continue;
    }
    auditedFiles++;
    for (const m of stripJsComments(src).matchAll(STATIC_REL_IMPORT)) {
      const target = m[2];
      auditedImports++;
      // 以该文件所在目录解析相对目标（strip query/hash 后取裸路径）
      const bare = target.split('?')[0].split('#')[0];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(f), bare));
      if (!present.has(resolved)) {
        fail(`包内 ${f} 引用了未打包的 ${resolved}（相对 import '${target}'）`);
      }
    }
  }
  if (errors.length === errCountBefore) {
    ok(`全部相对 import 可解析（${auditedFiles} 个 .js 文件 / ${auditedImports} 条相对 import）`);
  }
}

for (const req of REQUIRED) {
  present.has(req) ? ok('包含 ' + req) : fail('缺少必打包文件：' + req);
}
for (const f of files) {
  if (!ALLOWED.test(f)) fail('清单外文件混入包内：' + f);
}
for (const f of files) {
  if (f.startsWith('.git') || f.startsWith('.github/') || f.startsWith('scripts/') || f.startsWith('node_modules/')) {
    fail('不该发布的路径进入包内：' + f);
  }
}
ok(`共 ${files.length} 个文件将发布（${data.filename || ('包 ' + data.name + '@' + data.version)}）`);
if (data.version !== pkg.version) fail(`pack 版本 ${data.version} 与 package.json ${pkg.version} 不一致`);
if (data.name !== pkg.name) fail(`pack 名 ${data.name} 与 package.json ${pkg.name} 不一致`);

if (errors.length) {
  console.error(`\n✗ 打包校验未通过（${errors.length} 项）：`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ 打包校验通过');
