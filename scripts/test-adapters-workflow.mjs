#!/usr/bin/env node
/**
 * release-adapters workflow 结构校验测试（Task 12，dev-only，不随包发布）。需求：task-12-brief.md 断言清单。
 *
 * 为什么：release-adapters.yml 是三产物发布通道的草案，CI 面没有本地执行环境，
 * 用 `yaml` devDep（adapters/，仅校验用）解析结构 + 原文扫描，把规格逐条机械化。
 *
 * 断言（brief 六条 + 密钥引用面一条 Global Constraint）：
 *   1  .github/workflows/release-adapters.yml 存在且 YAML parse 通过
 *   2  顶层含 workflow_dispatch，且 inputs.publish_openvsx.default === false、
 *      inputs.draft.default === true（两 input 均 boolean 类型）
 *   3  jobs 的 runs-on 含 windows-latest
 *   4  构建 step 存在（run 内容含 build-adapters.mjs）
 *   5  红线：原文（除完整注释行）不含可执行的 npm 发布命令。brief 第 27 行要求红线注释**逐字**
 *      引用该命令名、第 38 行又要求**全文**不含该字样 —— 两句口径冲突，按语义执行：注释不可执行，
 *      红线约束的是可执行面。扫描基准式（task-12 评审加固，覆盖三类可执行变体）：
 *        /\bnpm(\.(cmd|exe))?\s+(--?\S+(\s+\S+)?\s+)*publish\b/i
 *      大小写不敏感（NPM Publish）/ 容忍 .cmd/.exe 扩展（npm.cmd publish）/ 容忍 publish
 *      前插任意 npm flag（npm --prefix adapters publish）；\s+ 跨多空格、tab、run 块内换行
 *      与折叠标量，直连形态全覆盖。注释剔除在扫描**之前**（红线注释逐字引用命令名，剔除后
 *      才不误报）；行尾注释文本仍可能「疑似」命中，由报错文案说明、人工复核。
 *      附对抗自测样例矩阵（含评审指定样例 NPM.cmd --prefix x publish）。
 *   6  Open VSX step 的 if 条件引用 publish_openvsx（含 OVSX_PAT），step 带 continue-on-error: true
 *   7  密钥只引用不内联（Global Constraint）：引用的 secret 只有 OVSX_PAT，且 ovsx -p 参数
 *      必须来自 secrets 表达式（防令牌字面量写进 run）
 *
 * 运行：node scripts/test-adapters-workflow.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release-adapters.yml');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------- 红线扫描（纯函数，供主流程与对抗自测共用；定义在模块顶层，doc 解析失败也自测） ----------
/** 剔除完整注释行（行首空白后 # 的行）。run 块内的 shell 注释行同形，本就不是可执行文本。
 *  行尾注释（`code # 注释`）不剔 —— 剔除需要引号感知，误剔可执行文本比多报「疑似」更危险。 */
const stripCommentLines = (text) => text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
/** 红线基准式（task-12 评审给定）：大小写不敏感 + 容忍 .cmd/.exe 扩展 + 容忍 publish
 *  前插任意 npm flag；\s+ 跨多空格/tab/块内换行/折叠标量，直连形态全覆盖。
 *  已知取舍：flag 组 `--?\S+(\s+\S+)?` 的 \S+ 不含空白，`npm --workspaces=false exec
 *  publish-tool` 这类「flag 值恰为 publish- 前缀」会被 \bpublish\b 误报 —— 宁可误报不漏报。 */
const NPM_PUBLISH_RE = /\bnpm(\.(cmd|exe))?\s+(--?\S+(\s+\S+)?\s+)*publish\b/i;

// ---------- 1) 文件存在 + YAML parse 通过 ----------
ok(existsSync(WORKFLOW), '缺少 .github/workflows/release-adapters.yml（本任务产物）');
let raw = '';
let doc = null;
if (existsSync(WORKFLOW)) {
  raw = readFileSync(WORKFLOW, 'utf8');
  ok(raw.charCodeAt(0) !== 0xFEFF, 'release-adapters.yml 带 BOM（Actions 加载器/工具链会出问题）');
  const require = createRequire(path.join(ROOT, 'adapters', 'package.json'));
  let YAML = null;
  try {
    YAML = require('yaml');
  } catch {
    errs.push("无法 require('yaml')——adapters devDependencies 缺 yaml（npm install 跑过吗？）");
  }
  if (YAML) {
    try {
      doc = YAML.parse(raw);
    } catch (e) {
      errs.push('release-adapters.yml YAML 解析失败: ' + ((e && e.message) || e));
    }
    ok(doc !== null && typeof doc === 'object' && !Array.isArray(doc), 'release-adapters.yml 解析结果不是对象');
  }
}

if (doc) {
  const jobs = doc.jobs || {};
  const jobIds = Object.keys(jobs);
  ok(jobIds.length > 0, 'jobs 为空（workflow 没有任何 job）');
  const allSteps = jobIds.flatMap((id) => (jobs[id] && Array.isArray(jobs[id].steps)) ? jobs[id].steps : []);
  ok(allSteps.length > 0, '没有任何 step');

  // ---------- 2) workflow_dispatch + inputs 默认值（brief 逐字：false / true） ----------
  const wd = doc.on && doc.on.workflow_dispatch;
  ok(!!wd, '顶层 on 缺少 workflow_dispatch（本 workflow 只允许手动触发）');
  ok(wd && doc.on.release === undefined, 'on 不应含 release 触发（发布通道独立于 publish.yml 的 release 链）');
  const inputs = (wd && wd.inputs) || {};
  const pub = inputs.publish_openvsx;
  const draft = inputs.draft;
  ok(!!pub, 'workflow_dispatch.inputs 缺 publish_openvsx');
  ok(!!draft, 'workflow_dispatch.inputs 缺 draft');
  ok(pub && pub.type === 'boolean', 'inputs.publish_openvsx 应为 boolean 类型');
  ok(draft && draft.type === 'boolean', 'inputs.draft 应为 boolean 类型');
  ok(pub && pub.default === false, 'inputs.publish_openvsx.default 必须 === false（Open VSX 是可选发布）');
  ok(draft && draft.default === true, 'inputs.draft.default 必须 === true（GitHub Release 默认草稿）');

  // ---------- 3) runs-on 含 windows-latest ----------
  const runsOn = jobIds.map((id) => jobs[id] && jobs[id]['runs-on']);
  ok(runsOn.some((r) => typeof r === 'string' && r.includes('windows-latest')),
    'runs-on 必须含 windows-latest（构建脚本依赖 PowerShell/tar/系统工具，与开发机同构）');

  // ---------- 4) 构建 step 存在（脚本内容含 build-adapters.mjs） ----------
  ok(allSteps.some((s) => typeof s.run === 'string' && s.run.includes('build-adapters.mjs')),
    '缺少构建 step（应有 run 执行 adapters/scripts/build-adapters.mjs）');

  // ---------- 5) 红线：原文（除完整注释行）不含可执行的 npm 发布命令 ----------
  const noComments = stripCommentLines(raw);
  const hitText = NPM_PUBLISH_RE.exec(noComments);
  ok(!hitText, '非注释原文疑似出现可执行的 npm 发布命令（红线：npm 发版只走 RELEASING.md 流程；'
    + '扫描含大小写/.cmd/.exe/flag 变体，完整注释行已剔除，行尾注释文本提及也会算疑似、请人工复核）：'
    + JSON.stringify(hitText && hitText[0]));
  const runValues = allSteps.map((s) => (typeof s.run === 'string' ? s.run : '')).join('\n');
  const hitRun = NPM_PUBLISH_RE.exec(runValues);
  ok(!hitRun, '存在疑似执行 npm publish 的 step（红线，变体扫描：大小写/.cmd/.exe/flag）：'
    + JSON.stringify(hitRun && hitRun[0]));

  // ---------- 6) Open VSX step：if 引用 publish_openvsx + continue-on-error: true ----------
  const ovsxSteps = allSteps.filter((s) => typeof s.if === 'string' && s.if.includes('publish_openvsx'));
  ok(ovsxSteps.length === 1, 'if 条件引用 publish_openvsx 的 step 应恰有 1 个（Open VSX 可选发布步）');
  const ovsx = ovsxSteps[0];
  if (ovsx) {
    ok(/publish_openvsx\s*==\s*true/.test(ovsx.if) && ovsx.if.includes('OVSX_PAT'),
      "Open VSX step 的 if 应为 `inputs.publish_openvsx == true && secrets.OVSX_PAT != ''` 形态");
    ok(ovsx['continue-on-error'] === true, 'Open VSX step 必须带 continue-on-error: true（失败不阻塞 Release 产物）');
    ok(typeof ovsx.run === 'string' && ovsx.run.includes('ovsx'), 'Open VSX step 应经 npx 调 ovsx CLI 发布 vsix');
  }

  // ---------- 7) 密钥只引用不内联（Global Constraint） ----------
  const secretRefs = [...raw.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  ok(secretRefs.length > 0 && secretRefs.every((s) => s === 'OVSX_PAT'),
    'workflow 引用了 OVSX_PAT 以外的 secret（本 workflow 只允许 OVSX_PAT）：' + JSON.stringify([...new Set(secretRefs)]));
  const ovsxRun = ovsx && typeof ovsx.run === 'string' ? ovsx.run : '';
  ok(!/-p\s+(?!['"]?\$\{\{)/.test(ovsxRun), 'ovsx -p 参数不是 ${{ secrets.* }} 表达式（疑似内联令牌，红线）');
}

// ---------- 8) 红线扫描对抗自测（评审要求：inline yaml 字符串样例，不动真实 workflow） ----------
// 正例（必须扫出）：评审三类变体 + 既有直连形态；反例（不得误报）。
// 纯函数断言不依赖 doc 解析成败，无条件执行。
const SELF_TESTS = [
  ['NPM.cmd --prefix x publish', true, '三重变体（大小写+扩展+flag，评审指定样例）'],
  ['Npm Publish', true, '大小写变体'],
  ['NPM publish', true, '大小写变体（命令大写）'],
  ['npm.cmd publish', true, '扩展隔断邻接（cmd）'],
  ['npm.EXE publish', true, '扩展隔断邻接（exe，大小写不敏感）'],
  ['npm --prefix adapters publish', true, 'flag 隔断邻接'],
  ['npm -g publish', true, '短 flag 隔断'],
  ['npm publish', true, '直连形态'],
  ['npm   publish', true, '多空格'],
  ['npm\tpublish', true, 'tab 隔断'],
  ['run: |\n    npm\n    publish', true, 'run 块内换行'],
  ['run: >-\n  npm publish', true, '折叠标量'],
  ['npm publishx', false, '词边界（publishx 非 publish）'],
  ['npm run publish', false, 'npm run 子命令不误报'],
  ['npm install foo publish', false, 'install 参数含 publish 不误报'],
  ['npm --prefix adapters ci', false, '带 flag 但非 publish 不误报'],
  ['npx --yes @vscode/ovsx publish x.vsix', false, 'npx 非 npm（ovsx 发布是本 workflow 合法步骤）'],
];
for (const [sample, shouldMatch, why] of SELF_TESTS) {
  ok(NPM_PUBLISH_RE.test(sample) === shouldMatch,
    '红线扫描对抗样例失败（' + why + '，应' + (shouldMatch ? '命中' : '放行') + '）: ' + JSON.stringify(sample));
}
// 注释剔除预处理与扫描的相互作用（双向证明）：
// a) 红线注释逐字含 `npm publish`（brief 第 27 行要求）——剔除**前**必须命中，证明预处理是必要前提；
const commentLine = '# 红线：本 workflow 不含、也不得添加 `npm publish`；npm 发版严格走 RELEASING.md 流程。';
ok(NPM_PUBLISH_RE.test(commentLine) === true, '对抗自测前置失效：红线注释行原文应命中（否则剔除预处理无必要，说明正则弱化）');
// b) 剔除**后**必须放行，证明不误伤 brief 要求的逐字红线注释（不引入新误报）；
ok(NPM_PUBLISH_RE.test(stripCommentLines(commentLine)) === false, '红线注释剔除后应放行（剔除预处理失效）');
// c) run 块内 shell 注释不吞可执行行：剔除注释行后，块内变体形态仍被扫出（不引入新漏报）。
const runWithShellComment = 'run: |\n    # build first\n    NPM.cmd --prefix x publish';
ok(NPM_PUBLISH_RE.test(stripCommentLines(runWithShellComment)) === true, 'run 块内 shell 注释不应吞掉可执行 npm publish 变体（剔除引入漏报）');

if (errs.length) {
  console.error('✗ release-adapters workflow 校验未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ release-adapters workflow 校验通过：workflow_dispatch 两 input 默认值（publish_openvsx=false / draft=true）、'
  + 'windows-latest、build-adapters.mjs 构建步、npm publish 红线加固扫描（大小写/.cmd/.exe/flag 变体 + '
  + SELF_TESTS.length + ' 条对抗样例）、Open VSX 可选步（if + continue-on-error）、密钥仅引用 secrets.OVSX_PAT');
process.exit(0);
