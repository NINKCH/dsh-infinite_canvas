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
  'package.json',
  'index.js',
  'client.js',
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
  'docs/release.md',
];
// 包内允许出现的路径形态（package.json 与 LICENSE 由 npm 恒定收入，无需列 files 白名单）
// assets/support/*：帮助与反馈用的微信二维码等界面静态资源（必须随包分发，否则用户看不到）
// docs/images/*：README/用户手册引用的截图（文档里的相对路径必须能解析，否则 npm/GitHub 上裂图）
const ALLOWED = /^(package\.json|LICENSE|LICENCE|NOTICE|index\.js|client\.js|skill-pack\.js|skill-pack-loader\.js|index-core-skill-profile\.js|icon\.svg|cordis\.patch\.yml|README(\.zh-CN)?\.md|locale\/[a-zA-Z-]+\.json|assets\/[a-z0-9-]+\/SKILL\.md|assets\/canvas-director\/(?:pack\.js|manifest\.json)|assets\/canvas-director\/(?:lenses|genres|industries|forms|looks|moves)\/[a-z0-9_-]+\.md|assets\/support\/[A-Za-z0-9._-]+|assets\/director\/[a-zA-Z0-9._-]+\.js|assets\/director\/models\/[A-Za-z0-9._-]+\.json|assets\/director\/clips\/[A-Za-z0-9._-]+\.json|docs\/[a-zA-Z0-9._-]+\.md|docs\/images\/[a-zA-Z0-9._-]+\.(png|svg|jpe?g|webp))$/;

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
