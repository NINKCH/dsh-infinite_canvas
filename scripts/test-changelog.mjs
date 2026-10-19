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
import { readFileSync, existsSync } from 'node:fs';
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

// ---------- 3) CAS 写路径退役：与 IC-08 强绑定（落地状态变了，断言跟着变） ----------
// 原口径（IC-08 未合入时）：Unreleased 段**不得**出现 CAS/objects 表述。
// 现口径（IC-08 已合入）：允许出现，但措辞必须是「写路径退役 + 读路径保留」，
// 不能写成「CAS 整体移除」——那会让 0.18.0–0.18.4 的老资产被误认为失效。
{
  const mentionsCas = /object store|objects\/|CAS\b|content-addressed/i.test(section);
  if (mentionsCas) {
    ok(/write path/i.test(section), 'CAS 条目缺少「写路径退役（write path）」的限定——不允许写成整体移除');
    ok(/read path/i.test(section), 'CAS 条目缺少「读路径保留（read path）」说明——老资产 0.18.0–0.18.4 仍要能读');
    ok(/0\.18\.0|0\.18\.4|legacy/i.test(section), 'CAS 条目没说是哪些版本的历史数据（0.18.0–0.18.4 / legacy）');
  }
  // 反向守卫：读路径真的还在代码里（防止有人删了读路径却在 CHANGELOG 说保留）
  const hostSrc = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  ok(/api\/object/.test(hostSrc), 'CHANGELOG 声称保留读路径，但 index.js 里已找不到 /api/object 路由');
}

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
// OBS-1 硬要求（QA 判据）：清单**手工维护**，绝不从 `git log` 动态生成——动态清单会自证
// （脚本生成的清单当然自己全中，"缺一必红"退化成摆设）。数量相等 + 逐 sha 关键词命中，两条都拦。
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
  { sha: 'c409e6a', keys: [/write path is retired|read path is kept|content-addressed/i] },
  { sha: 'b705887', keys: [/hard-codes the regression item count|--list.*live source/i] },
  { sha: 'ed3713f', keys: [/reference-upload trio|magic-byte sniffing/i] },
  { sha: 'c578311', keys: [/EXIF rotation is reported|dimension measurement/i] },
  { sha: '7367b00', keys: [/Unknown video vendors degrade/i] },
  { sha: '0313d7f', keys: [/ftsReconcile/i] },
  { sha: '94515e1', keys: [/Craft outputs no longer survive|craft\/ directory/i] },
  { sha: '1f6ea01', keys: [/extension mappings/i] },
  { sha: '44eddec', keys: [/record the phase|phase-2 six|Unreleased section/i] },
];
for (const c of COVERAGE) {
  ok(c.keys.some((re) => re.test(section)), '未发版提交 ' + c.sha + ' 在 Unreleased 段里找不到对应记录（补记不全）');
}

// ---------- 附加：数量相等 + 清单 sha 真实性（OBS-1 的"缺一必红"数量侧） ----------
// 比较基线 = `main..dev` 剔除「纯收尾提交」（只动 CHANGELOG.md / scripts/ 的提交）。
// 原因：`~1`（排除 HEAD）仍会漂移——每多一个记录 CHANGELOG 的提交，未记录计数就 +1，
// 门禁被自己的修复打破（21963fc→eb6a1e1 两次坐实）。收尾提交（本脚本/CHANGELOG 自身）
// 的记录对象是"上一个功能提交"，它们的数量天然不进功能覆盖账。语义不变：任何新功能
// 提交落地后必须补条目，缺一必红；纯收尾提交不再让门禁自爆。
// git 不可用时不允许静默假绿（OBS-1 同性质问题）：显式 SKIP 原因，--strict 下判失败。
const gitEnv = { ...process.env };
if (!gitEnv.GIT_CONFIG_GLOBAL) {
  // 换机即失效的硬编码改为候选：环境变量已设则不覆盖；未设才尝试项目组侧的候选文件
  const candidate = 'D:\\Code\\deepseek-plugin\\_gitconfig';
  if (existsSync(candidate)) gitEnv.GIT_CONFIG_GLOBAL = candidate;
}
const git = (args) => {
  try { return execFileSync('git', args, { cwd: ROOT, env: gitEnv, encoding: 'utf8' }).trim(); } catch { return null; }
};
const cntAll = git(['rev-list', '--count', 'main..dev']);
if (cntAll && Number(cntAll) > 0) {
  const shas = (git(['log', '--format=%h %s', 'main..dev']) || '').split(/\r?\n/).filter(Boolean);
  // 纯收尾提交 = 主题以 docs(IC-07)/chore(test)/docs(OBS 开头，或改动只含 CHANGELOG.md+scripts/
  const isChore = (subject) => /^(docs\(IC-07\)|chore\(test\)|docs\(OBS|test\(IC-07\))/.test(subject);
  const functional = [];
  const shasSet = new Set();
  for (const line of shas) {
    const sp = line.indexOf(' ');
    const sha = line.slice(0, sp);
    const subject = line.slice(sp + 1);
    shasSet.add(sha);
    if (!isChore(subject)) functional.push(sha);
  }
  ok(functional.length === COVERAGE.length, 'dev 未发版功能提交数（' + functional.length + '，剔除纯收尾 ' + (shasSet.size - functional.length) + ' 个）≠ CHANGELOG 覆盖清单条数（' + COVERAGE.length + '）——清单与实际脱节，扩清单或清掉已发布项');
  for (const c of COVERAGE) ok(shasSet.has(c.sha), '覆盖清单里的 ' + c.sha + ' 不在 main..dev（已发布或已 amend？请更新手工清单）');
} else {
  const strict = process.argv.includes('--strict');
  const reason = 'git 不可用（或 main..dev 无提交）：数量相等与逐 sha 存在性校验被跳过';
  if (strict) {
    errs.push('SKIP-AS-FAIL（--strict）：' + reason);
    console.error('SKIP（--strict 下判失败）：' + reason);
  } else {
    console.log('  · SKIP：' + reason + '（--strict 下这将判失败）');
  }
}

if (errs.length) {
  console.error('✗ IC-07 验证未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ IC-07 验证通过：Unreleased 段结构完整（4 分组）、无提前写死的版本号、CAS 条目措辞与读路径保留一致，' + COVERAGE.length + ' 个未发版提交全部有记录');
process.exit(0);
