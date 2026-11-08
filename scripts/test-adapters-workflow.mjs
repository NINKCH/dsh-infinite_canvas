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
 *   5  红线：原文不含 `npm publish` 字样。brief 第 27 行要求红线注释**逐字**引用该命令名、
 *      第 38 行又要求**全文**不含该字样 —— 两句口径冲突，按语义执行：注释不可执行，
 *      红线约束的是可执行面。实现 = 剔除注释行后扫描原文 + 对全部 run 值做 \bnpm\s+publish\b
 *      正则反查（防 run 块/折叠标量绕过行级剔除）。
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

  // ---------- 5) 红线：原文（除注释行）不含 `npm publish` 字样 ----------
  const noComments = raw.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  ok(!noComments.includes('npm publish'), '非注释原文出现 `npm publish` 字样（红线：npm 发版只走 RELEASING.md 流程）');
  const runValues = allSteps.map((s) => (typeof s.run === 'string' ? s.run : '')).join('\n');
  ok(!/\bnpm\s+publish\b/.test(runValues), '存在执行 npm publish 的 step（红线）');

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

if (errs.length) {
  console.error('✗ release-adapters workflow 校验未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ release-adapters workflow 校验通过：workflow_dispatch 两 input 默认值（publish_openvsx=false / draft=true）、'
  + 'windows-latest、build-adapters.mjs 构建步、无 npm publish 红线、Open VSX 可选步（if + continue-on-error）、密钥仅引用 secrets.OVSX_PAT');
process.exit(0);
