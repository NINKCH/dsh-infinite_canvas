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

// ---------- 4) package.json 版本未在 dev 上被擅自改动 ----------
// 基线 = CHANGELOG 里最新**已发布**段的版本号（不是字面量）：发版后基线自动前移，
// 不必每版手改这个门禁（曾把 0.18.4 写死，0.18.5 一发就假红）。
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const baselineVersion = firstReleased ? firstReleased[1] : '';
ok(!!baselineVersion, '找不到最新已发布版本号，无法校验 package.json（CHANGELOG 段缺失？）');
ok(pkg.version === baselineVersion, 'package.json 的 version 与最新已发布版本不一致（本单不改版本号）：'
  + pkg.version + ' ≠ ' + baselineVersion);

// ---------- 5) 四个分组齐全（仅当 Unreleased 段有内容时） ----------
// 刚发完版时 Unreleased 是空段（只有一句提示），此时**无可记录、也无结构可校验**——
// 旧口径无条件要求四分组，发版提交一落地就假红（0.18.6 发版时坐实）。真正的把关在
// 第 7/8 节：只要有未发版提交，清单必须与提交数相等且逐条命中；缺条目照样红。
const unrelHasEntries = /^\s*-\s+\S/m.test(section);
if (unrelHasEntries) {
  for (const g of ['Added', 'Fixed', 'Changed', 'Internal']) {
    ok(new RegExp('^### ' + g + '\\s*$', 'm').test(section), 'Unreleased 段缺少 `### ' + g + '` 分组');
  }

  // ---------- 6) 每个分组下至少一条条目 ----------
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
  // 0.18.6 已发布；此后每笔未发版功能提交在这里登记（sha + Unreleased 里必须能命中的关键词）。
  { sha: 'b34462d', keys: [/merge generation and asset nodes|unified media node|MediaNodeBody|GenComposer|节点类型合并/i] },
  { sha: '0f88454', keys: [/aspect|one row|any click|等比|letterbox|比例/i] },
  { sha: '6c4d9a7', keys: [/fixed-height header|action bar|fixed chrome|not part of the picture ratio/i] },
  { sha: '825b1af', keys: [/follows the reviewed prototype|content area|点击|原型/i] },
  { sha: '2a25a84', keys: [/panel got simpler|drag a thumbnail|controls only while playing/i] },
  { sha: '5bbb39d', keys: [/only the references you actually wired|lists every asset|injects the bible text|shot-level detail/i] },
  { sha: 'd90ea5a', keys: [/expert personas now carry|available to the Harness itself|shortcut/i] },
  { sha: '9d6b1ed', keys: [/icon rail|IconRail|studio modal|StudioModal|project switcher|图标|弹窗|面板/i] },
  { sha: '2793862', keys: [/inject list|without inject|client plugin loads again/i] },
  { sha: '2a1b829', keys: [/sub-canvases|directory tree|rename|icon-only/i] },
  { sha: 'caea5e7', keys: [/in-place rename|shows only the current one|solid-surface|rail only takes the middle|no literal colours/i] },
  { sha: 'e97f063', keys: [/default canvas|defaultCanvasName|only one canvas remains|remaining canvas/i] },
  { sha: '814f135', keys: [/current-project tick|inline rename|right panel|新建项目/i] },
  { sha: 'afec094', keys: [/paginat|search|icon rail frame|search row|分页|图标/i] },
  { sha: '41fb0b7', keys: [/size the project menu|content up to five|canvas name on the project row|canvas chip|自适应/i] },
  { sha: '11fbc15', keys: [/pager sits on the same row|search field|rail|storage|icon rail/i] },
  { sha: '3ae252b', keys: [/pager|page-jump|plus icon|magnifier|页码/i] },
  { sha: '9d39aa0', keys: [/expert selector|whole skill set|skill pickers|专家/i] },
  { sha: '07bfda3', keys: [/icon rail|rail is a fixed column|float|图标列/i] },
  { sha: '1af1e55', keys: [/redundant expert field label|skill boost card|expert|专家/i] },
  { sha: 'aa02f28', keys: [/icon rail|floats over the canvas|悬浮/i] },
  { sha: 'ef574bd', keys: [/solid white pill|floating icon rail|白底/i] },
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
/** 净零对判定（纯函数，git 可注入；定义在模块顶层——主流程与第 9 节单测共用，
 *  此前误放在 if (cntAll) 块内，块级作用域让第 9 节单测 ReferenceError）：
 *  - subject 恰为 `Revert "<X>"` 且 X 在 shas 内 → 本提交是 revert：取 X 触及的文件做
 *    内容级净 diff（`git diff <X>^ <本提交> -- <文件>`），输出为空 = 真撤销（netZero=true）；
 *    非空 = 假撤销（netZero=false + why）。
 *  - subject 非 revert 但存在 `Revert "<subject>"` → 本提交是探针：同样做内容级净 diff。
 *  - revert 回指的 X 不在 shas（悬空）→ netZero=false 且 why 为空（调用方按越界处理）。 */
const isNetZeroPair = (git, sha, subject, shas) => {
  let netZero = false;
  let why = '';
  const revertOfThis = shas.find((l) => l.slice(l.indexOf(' ') + 1) === 'Revert "' + subject + '"');
  const revertMatch = /^Revert "(.+)"(?:\s|$)/.exec(subject);
  if (revertOfThis) {
    const revSha = revertOfThis.slice(0, revertOfThis.indexOf(' '));
    const files = (git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]) || '').split(/\r?\n/).filter(Boolean);
    const empty = ((git(['diff', sha + '^', revSha, '--'].concat(files)) || '').trim() === '');
    netZero = empty;
    if (!empty) why = '限定文件净 diff 非空（' + files.join(', ') + '，' + sha + '^→' + revSha + '）—— revert 未把内容真正恢复原状';
  } else if (revertMatch) {
    const origLine = shas.find((l) => l.slice(l.indexOf(' ') + 1) === revertMatch[1]);
    if (origLine) {
      const origSha = origLine.slice(0, origLine.indexOf(' '));
      const files = (git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]) || '').split(/\r?\n/).filter(Boolean);
      const empty = ((git(['diff', origSha + '^', sha, '--'].concat(files)) || '').trim() === '');
      netZero = empty;
      if (!empty) why = '限定文件净 diff 非空（' + files.join(', ') + '，' + origSha + '^→' + sha + '）—— revert 未把内容真正恢复原状';
    }
  }
  return { netZero, why };
};
if (cntAll && Number(cntAll) > 0) {
  const shas = (git(['log', '--format=%h %s', 'main..dev']) || '').split(/\r?\n/).filter(Boolean);
  // 纯收尾提交 = **精确白名单**（IC-B5：禁止 fix(OBS)/docs(OBS) 这类泛前缀——
  // 泛匹配曾把 fix(OBS-UI-1)「不再自动建占位项目」这条真实功能修复放进收尾账，
  // CHANGELOG 零命中而门禁照绿，即 QA 实证的"假绿"活样本）。
  // 白名单只收确定修门禁自身/记录 CHANGELOG 的主题；新收尾类型出现时**显式加一行**，
  // 加错会被下面的功能账数量相等断言拦住（收尾项多算 → 功能数 ≠ 清单数）。
  // 【治理规则】新增 CHORE_SUBJECTS 条目必须经 PM 批准——每加一条等于放宽一次门禁的
  // 执行面；条目必须能自证「只修门禁自身（scripts/）或只记 CHANGELOG/docs」。
  // 文件面由 isChoreFileAllowed 双重兜底：subject 骗过、文件面也骗不过。
  const CHORE_SUBJECTS = [
    'docs(IC-07)',
    'chore(test)',
    'test(IC-07)',
    'fix(OBS-1)',
    'fix(OBS-2)',
    'fix(IC-B5)',
    // revert-of-chore：撤销一条收尾/探针提交也是收尾操作（记录对象仍是那个功能提交）
    'Revert "fix(OBS-1)',
    'Revert "chore(test)',
  ];
  const isChore = (subject) => CHORE_SUBJECTS.some((p) => subject === p || subject.startsWith(p + ':') || subject.startsWith(p + ' '));
  /** IC-B5 文件面断言（subject 白名单的第二道锁）：收尾提交只许触碰
   *  CHANGELOG.md / scripts/（门禁与测试）/ docs/（文档）。client.js、index.js、
   *  locale/、assets/ 等任何用户可见面越界 → false（调用方报红指名提交与文件）。 */
  const isChoreFileAllowed = (paths) => (paths || []).every((p) => {
    const f = String(p || '').replace(/\\/g, '/');
    return f === 'CHANGELOG.md' || f.startsWith('scripts/') || f.startsWith('docs/');
  });
  const functional = [];
  const shasSet = new Set();
  for (const line of shas) {
    const sp = line.indexOf(' ');
    const sha = line.slice(0, sp);
    const subject = line.slice(sp + 1);
    shasSet.add(sha);
    if (!isChore(subject)) { functional.push(sha); continue; }
    // 文件面双重锁：subject 判成收尾的提交，改动文件越界 = 不是收尾（subject 冒名），
    // 并入功能账并报红——「真改 client.js 的提交只要标题写成 fix(OBS-1) 就能逃账」的
    // 最后一条通道由此关闭。
    const files = (git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]) || '').split(/\r?\n/).filter(Boolean);
    if (!isChoreFileAllowed(files)) {
      // IC-B5 净零提交对豁免（PM 裁决 D，通用规则、零 sha 特例）：验证用探针 + 其 revert
      // 成对时整体豁免。**真撤销判据 = 限定文件的净 diff 为空**：`git diff <探针>^ <revert>
      // -- <探针触及的文件>` 输出为空 —— 只比对「文件名集合」不安全（同文件、不同改法的
      // 假 revert 会漏判成净零），内容必须真的回到探针之前的状态。
      // 成对断言：① 探针与 revert 同在 main..dev（缺一 = 历史被改写）；② 限定文件净 diff 为空；
      // ③ revert 的 subject 以 `Revert "<探针subject>"` 回指探针。任一不满足仍报红。
      // 探针侧与 revert 侧**两个方向都要豁免**：只豁免 revert 侧会让探针提交永远报"越界"。
      // 判定逻辑抽成纯函数 isNetZeroPair(gitCmd, sha, subject, shas)（文件底部有 10 组
      // 可注入反例单测，含「假撤销必须报红」），此处只做调用。
      const verdict = isNetZeroPair(git, sha, subject, shas);
      if (verdict.netZero) continue; // 净零对：两笔都不进功能账、不报红（无用户可见变化）
      if (verdict.why) {
        errs.push('净零提交对不成立（假撤销）：' + sha + '（' + subject + '）—— ' + verdict.why);
        continue;
      }
      errs.push('提交 ' + sha + '（' + subject + '）主题在收尾白名单内，但触碰了越界文件：' + files.join(', ') + ' —— 收尾提交只许改 CHANGELOG.md/scripts/docs，功能改动请改主题并进功能账');
      functional.push(sha);
    }
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

// ---------- 8) 文件面断言的纯函数反例（IC-B5 补完，不依赖 git） ----------
// 白名单目录/文件规则独立可测：越界（client.js/index.js/locale/assets）必 false，
// 收尾面（CHANGELOG/scripts/docs）必 true，混入一个越界文件即整体 false。
const isChoreFileAllowedPure = (paths) => (paths || []).every((p) => {
  const f = String(p || '').replace(/\\/g, '/');
  return f === 'CHANGELOG.md' || f.startsWith('scripts/') || f.startsWith('docs/');
});
ok(isChoreFileAllowedPure(['client.js']) === false, 'isChoreFileAllowed(client.js) 应为 false（关键反例：功能面冒名收尾）');
ok(isChoreFileAllowedPure(['index.js']) === false, 'isChoreFileAllowed(index.js) 应为 false（Host 侧越界）');
ok(isChoreFileAllowedPure(['locale/zh.json']) === false, 'isChoreFileAllowed(locale/zh.json) 应为 false（用户可见文案面）');
ok(isChoreFileAllowedPure(['assets/support/x.png']) === false, 'isChoreFileAllowed(assets/…) 应为 false（打包面）');
ok(isChoreFileAllowedPure(['CHANGELOG.md']) === true, 'isChoreFileAllowed(CHANGELOG.md) 应为 true');
ok(isChoreFileAllowedPure(['scripts/test-x.mjs']) === true, 'isChoreFileAllowed(scripts/test-x.mjs) 应为 true');
ok(isChoreFileAllowedPure(['docs/x.md']) === true, 'isChoreFileAllowed(docs/x.md) 应为 true');
ok(isChoreFileAllowedPure(['CHANGELOG.md', 'scripts/regress.mjs']) === true, '混合合法文件应为 true');
ok(isChoreFileAllowedPure(['CHANGELOG.md', 'client.js']) === false, '合法文件混入一个越界文件即 false');
ok(isChoreFileAllowedPure([]) === true, '空文件列表视为合法（空提交不冒名）');

// ---------- 9) 净零对判定的纯函数反例（IC-B5 D 方案：git 输出可注入，不依赖 git/不碰历史） ----------
// isNetZeroPair(git, sha, subject, shas) 从主流程抽出；这里注入假 git 断言四个方向：
//   A. 真撤销（限定文件净 diff 空）→ netZero=true（豁免）
//   B. 假撤销（同文件、不同改法，diff 非空）→ netZero=false 且带原因（必须报红）
//   C. revert 无回指原提交（悬空）→ 不豁免、按越界处理
//   D. 探针侧对称：subject 非 revert 但存在回指它的 revert → 同 A 判定
/** 净零对判定（纯函数，git 可注入）：
 *  - subject 恰为 `Revert "<X>"` 且 X 在 shas 内 → 本提交是 revert：取 X 触及的文件做
 *    内容级净 diff（`git diff <X>^ <本提交> -- <文件>`），输出为空 = 真撤销（netZero=true）；
 *    非空 = 假撤销（netZero=false + why）。
 *  - subject 非 revert 但存在 `Revert "<subject>"` → 本提交是探针：同样做内容级净 diff。
 *  - revert 回指的 X 不在 shas（悬空）→ netZero=false 且 why 为空（调用方按越界处理）。 */

// A) 真撤销：revert 侧，diff 输出为空
{
  const gitA = (args) => (args[0] === 'diff' ? '' : 'client.js');
  const r = isNetZeroPair(gitA, '675da38', 'fix(OBS-1): probe', ['3961c22 Revert "fix(OBS-1): probe"', '675da38 fix(OBS-1): probe']);
  ok(r.netZero === true && r.why === '', '净零对 A（真撤销）应豁免：' + JSON.stringify(r));
}
// B) 假撤销：revert 侧，diff 输出非空（同文件、不同改法）→ 必须不豁免且带原因
{
  const gitB = (args) => (args[0] === 'diff' ? 'diff --git a/client.js b/client.js\n@@ -1 +1 @@\n-x\n+y' : 'client.js');
  const r = isNetZeroPair(gitB, '675da38', 'fix(OBS-1): probe', ['3961c22 Revert "fix(OBS-1): probe"', '675da38 fix(OBS-1): probe']);
  ok(r.netZero === false && /净 diff 非空/.test(r.why), '净零对 B（假撤销）必须报红并说明：' + JSON.stringify(r));
}
// C) 悬空 revert：revert 回指的原提交不在 shas 里 → 不豁免（走越界报红路径）
{
  const gitC = () => '';
  const r = isNetZeroPair(gitC, '9999999', 'Revert "ghost subject"', ['3961c22 Revert "ghost subject"']);
  ok(r.netZero === false && r.why === '', '净零对 C（悬空 revert）不豁免：' + JSON.stringify(r));
}
// D) 探针侧对称：subject 非 revert、存在回指它的 revert、diff 空 → 豁免
{
  const gitD = (args) => (args[0] === 'diff' ? '' : 'client.js');
  const r = isNetZeroPair(gitD, '675da38', 'fix(OBS-1): probe', ['675da38 fix(OBS-1): probe', '3961c22 Revert "fix(OBS-1): probe"']);
  ok(r.netZero === true && r.why === '', '净零对 D（探针侧对称）应豁免：' + JSON.stringify(r));
}
// B2) 探针侧假撤销：diff 非空 → 报红
{
  const gitB2 = (args) => (args[0] === 'diff' ? 'diff --git a/client.js b/client.js' : 'client.js');
  const r = isNetZeroPair(gitB2, '3961c22', 'Revert "fix(OBS-1): probe"', ['675da38 fix(OBS-1): probe', '3961c22 Revert "fix(OBS-1): probe"']);
  ok(r.netZero === false && /净 diff 非空/.test(r.why), '净零对 B2（探针侧假撤销）必须报红：' + JSON.stringify(r));
}

if (errs.length) {
  console.error('✗ IC-07 验证未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ IC-07 验证通过：' + (unrelHasEntries ? 'Unreleased 段结构完整（4 分组）' : 'Unreleased 为空段（已发版、无待记事项）')
  + '、无提前写死的版本号、CAS 条目措辞与读路径保留一致，' + COVERAGE.length + ' 个未发版提交全部有记录');
process.exit(0);
