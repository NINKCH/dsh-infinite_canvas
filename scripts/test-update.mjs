#!/usr/bin/env node
/**
 * 更新检查功能测试（dev-only，不随包发布）。
 *
 * 直接调用 Host 的 _internals：验证版本单一来源、cmpVer 语义化比较边界、
 * 以及真实的 npm registry 检查结果。不测 UI（UI 由 smoke-render 覆盖）。
 *
 * 运行：node scripts/test-update.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const i = mod._internals;

let bad = 0;
const expect = (label, got, want) => {
  const pass = got === want;
  if (!pass) bad++;
  console.log(`${pass ? '✓' : '✗'} ${label} = ${got}（期望 ${want}）`);
};

// 1) 版本单一来源：Host 读取的 VERSION 必须与 package.json 一致
const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
expect('VERSION（来自 package.json）', i.getVersion(), pkgVersion);

// 2) cmpVer 边界：相等 / 落后 / 领先 / prerelease 低于同号正式版 / v 前缀 / 非法输入
const cases = [
  ['0.17.1', '0.17.1', 0],
  ['0.17.1', '0.17.2', -1],
  ['0.17.2-beta.0', '0.17.2', -1],
  ['0.18.0', '0.17.9', 1],
  ['0.17.2-beta.0', '0.17.2-beta.1', -1],
  ['1.0.0-rc.1', '1.0.0', -1],
  ['v0.17.1', '0.17.1', 0],
  ['x', '0.1.2', 0],
];
for (const [a, b, want] of cases) expect(`cmpVer(${a}, ${b})`, i.cmpVer(a, b), want);

// 3) 真实检查：本地版本 vs npm registry latest
try {
  const r = await i.updateCheck();
  console.log('updateCheck →', JSON.stringify(r));
  if (r.source !== 'npm') { bad++; console.log('✗ source 应为 npm'); }
  if (r.runningVersion !== pkgVersion) { bad++; console.log('✗ runningVersion 与 package.json 不一致'); }
  if (typeof r.remoteVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(r.remoteVersion)) { bad++; console.log('✗ remoteVersion 不是语义化版本'); }
  if (r.upToDate !== (r.behind === 0)) { bad++; console.log('✗ upToDate 与 behind 不一致'); }
} catch (e) {
  bad++;
  console.log('✗ updateCheck 失败（网络/registry）：' + (e && e.message) || e);
}

// 4) 点击安装（updateInstall）：仅在没有落后时执行 no-op 路径 —— 已是最新 → ok:true, changed:false，
//    用于验证 profile 探测 / pnpm 定位 / spawn 链路；若落后则跳过（测试绝不偷偷升级安装）
let check = null;
try { check = await i.updateCheck(); } catch { /* 网络失败已在上面统计 */ }
if (check && check.upToDate) {
  const pdir = i.getProfileDir();
  console.log('profileDir =', pdir);
  if (!pdir) {
    console.log('（开发态安装：updateInstall 走引导分支，跳过 no-op 验证）');
  } else {
    const inst = await i.updateInstall();
    console.log('updateInstall →', JSON.stringify({ ...inst, output: inst.output ? '…' : inst.output }));
    if (!inst || inst.ok !== true || inst.changed !== false) { bad++; console.log('✗ no-op 安装路径应返回 ok:true, changed:false'); }
  }
} else if (check) {
  console.log('（当前落后 registry：跳过 updateInstall 测试，避免测试期间真实升级）');
}

console.log(bad === 0 ? '\n✓ 更新检查功能测试通过' : `\n✗ ${bad} 项失败`);
// 给挂起的 AbortSignal 计时器一个落定机会，避免 Windows 上 process.exit 与 libuv 拆除竞态
setTimeout(() => process.exit(bad === 0 ? 0 : 1), 200).unref();
