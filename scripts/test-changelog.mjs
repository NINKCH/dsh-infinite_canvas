#!/usr/bin/env node
/**
 * IC-07 回归测试：CHANGELOG 结构与「未发版事实」一致性。
 *
 * 为什么需要它：0.18.4 之后 dev 上积了 14 个提交（含本期 4 单），CHANGELOG 却一条没记，
 * 用户看到的版本叙事与代码实际状态脱节。补记之后还需要一条**可执行**的断言，
 * 避免下次又悄悄漂移：以后再往 dev 提交，CHANGELOG 的 Unreleased 段必须跟着动。
 *
 * 断言：
 *   1  CHANGELOG 存在 `## [Unreleased]` 段，且在 `0.18.4` 之前（最新在最上）
 *   2  未发版段**不写具体版本号**（版本号由维护者拍，不许提前写死）
 *   3  未发版段**不出现 CAS 写路径退役**的表述 —— 该条与 IC-08 强绑定，IC-08 未合入前不得出现在 CHANGELOG
 *   4  `package.json` 的 version 未擅自改动（仍是 0.18.4；本单不改版本号）
 *   5  段内四个分组齐全：Added / Fixed / Changed / Internal
 *   6  每个 `### ` 分组下至少有一条 `- ` 条目
 *   7  `dev` 上未发版的提交主题，至少被 Unreleased 段覆盖到可检索的关键词（防"补一半"）
 *
 * 运行：node scripts/test-changelog.mjs；退出码 0=通过 1=失败
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const raw = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
ok(raw.charCodeAt(0) !== 0xFEFF, 'CHANGELOG.md 带 BOM（加载器/工具链会出问题）');

// ---------- 1) Unreleased 段存在且位置最上 ----------
const unrelRe = /^## \[Unreleased\]\s*$/m;
const mUnrel = unrelRe.exec(raw);
ok(!!mUnrel, '缺少 `## [Unreleased]` 段');
const idxUnrel = mUnrel ? mUnrel.index : -1;
const firstReleased = /^## \[(\d+\.\d+\.\d+)\]/m.exec(raw);
ok(!!firstReleased, '找不到任何已发布版本段');
if (mUnrel && firstReleased) {
  ok(idxUnrel < firstReleased.index, 'Unreleased 段不在最上方（应排在最新已发布版本之前）');
}
// Unreleased 段正文 = 从段标题到下一个 `## ` 之间
let section = '';
if (mUnrel) {
  const rest = raw.slice(idxUnrel + mUnrel[0].length);
  const next = rest.search(/^## /m);
  section = next < 0 ? rest : rest.slice(0, next);
}

// ---------- 2) 不写具体版本号 ----------
ok(!/^## \[?\d+\.\d+\.\d+/m.test(section), 'Unreleased 段里出现了具体版本号标题（版本号必须由维护者拍板）');
ok(!/^## \[Unreleased\].*?\d+\.\d+\.\d+/m.test(section), 'Unreleased 段里写死了版本号');

// ---------- 3) CAS 写路径退役不得提前出现（与 IC-08 强绑定） ----------
const casRe = /object store|objects\/|CAS\b|content-addressed/i;
ok(!casRe.test(section), 'Unreleased 段出现 CAS / objects/ 表述 —— 该条与 IC-08 强绑定，IC-08 未合入前不得写进 CHANGELOG');

// ---------- 4) package.json 版本未被擅自改动 ----------
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok(pkg.version === '0.18.4', 'package.json 的 version 被改动（本单不改版本号）：' + pkg.version);

// ---------- 5) 四个分组齐全 ----------
for (const g of ['Added', 'Fixed', 'Changed', 'Internal']) {
  ok(new RegExp('^### ' + g + '\\s*$', 'm').test(section), 'Unreleased 段缺少 `### ' + g + '` 分组');
}

// ---------- 6) 每个分组下至少一条条目 ----------
{
  const parts = section.split(/^### /m).slice(1);
  for (const p of parts) {
    const name = p.split('\n')[0].trim();
    const body = p.slice(p.indexOf('\n') + 1);
    const bullets = body.split(/\n/).filter((l) => /^\s*-\s+\S/.test(l));
    ok(bullets.length > 0, '分组 `' + name + '` 下没有条目');
  }
}

// ---------- 7) dev 上未发版的提交主题被覆盖到（防补一半） ----------
// 每个未发版提交必须能在 Unreleased 段里找到对应的关键词组之一（任一命中即算覆盖）。
const COVERAGE = [
  { sha: 'a732f5b', keys: [/character.sheet/i] },
  { sha: 'a20ee16', keys: [/canvas_update_node|canvas_generate_node/i] },
  { sha: 'f745b4a', keys: [/vendor.adjacent|vendor-format|vendor format|reference-generation|storyboard-driven/i] },
  { sha: '9373bff', keys: [/project folder|projects\/<project>/i] },
  { sha: '537b74d', keys: [/segment continuity|hand-off|segments now actually connect/i] },
  { sha: 'c662c2a', keys: [/dur is not defined|final-cut merge/i] },
  { sha: '69e21e4', keys: [/13 defects|13 conflicts|continuity fixes/i] },
  { sha: '4707f52', keys: [/semantic inversion|tail is the shot|previous shot/i] },
  { sha: '16f20fe', keys: [/Alt-drag/i] },
  { sha: 'dfab885', keys: [/top toolbar|shortcuts panel/i] },
  { sha: '02a9891', keys: [/Download filenames follow the real container|real container/i] },
  { sha: '8bffade', keys: [/absolute `base`|ArtCraft calls/i] },
  { sha: '454b934', keys: [/disk mirror/i] },
  { sha: '67bfee4', keys: [/regress\.mjs|regression entry point/i] },
];
for (const c of COVERAGE) {
  ok(c.keys.some((re) => re.test(section)), '未发版提交 ' + c.sha + ' 在 Unreleased 段里找不到对应记录（补记不全）');
}

// ---------- 附加：确认这些 sha 确实在 dev 上、且不在 main 上（防止清单过期） ----------
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: 'D:\\Code\\deepseek-plugin\\_gitconfig' };
const git = (args) => {
  try { return execFileSync('git', args, { cwd: ROOT, env: gitEnv, encoding: 'utf8' }).trim(); } catch { return null; }
};
const inDev = git(['merge-base', '--is-ancestor', '16f20fe', 'dev']);
if (inDev !== null) {
  // 只有 git 可用时才做这条（QA 环境可能没有 .git 或没有该分支）
  const cnt = git(['rev-list', '--count', 'main..dev']);
  if (cnt && Number(cnt) > 0) {
    ok(Number(cnt) >= COVERAGE.length, 'dev 上未发版提交数（' + cnt + '）少于 CHANGELOG 覆盖清单（' + COVERAGE.length + '）——清单需要更新');
  }
}

if (errs.length) {
  console.error('✗ IC-07 验证未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ IC-07 验证通过：Unreleased 段结构完整（4 分组）、无提前写死的版本号、无越界的 CAS 退役条目，' + COVERAGE.length + ' 个未发版提交全部有记录');
process.exit(0);
