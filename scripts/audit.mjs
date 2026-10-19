// 机械化审计：i18n 键对齐 / T() 引用是否有定义 / CSS 类是否定义 / 节点类型覆盖
// 用法：node scripts/audit.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const client = readFileSync(path.join(root, 'client.js'), 'utf8');
const host = readFileSync(path.join(root, 'index.js'), 'utf8');

const problems = [];
const notes = [];
const add = (list, msg) => list.push(msg);

// ---------- 1) i18n：抽取两个词典的键 ----------
function dictKeys(name) {
  const start = client.indexOf(`const ${name} = {`);
  if (start < 0) return null;
  let i = client.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < client.length; j++) {
    const c = client[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return extractKeys(client.slice(i, j + 1));
    }
  }
  return null;
}
function extractKeys(block) {
  const keys = new Set();
  const re = /^\s{4,6}'([^']+)':/gm;
  let m;
  while ((m = re.exec(block)) !== null) keys.add(m[1]);
  return keys;
}
const zh = dictKeys('DICT_ZH');
const en = dictKeys('DICT_EN');
if (!zh || !en) {
  add(problems, '未能解析 DICT_ZH / DICT_EN（审计脚本需随结构更新）');
} else {
  for (const k of zh) if (!en.has(k)) add(problems, `英文词典缺少键 '${k}'（中文有）`);
  for (const k of en) if (!zh.has(k)) add(problems, `中文词典缺少键 '${k}'（英文有）`);
  // T('x') 引用是否有定义
  const used = new Set();
  const reT = /T\('([^']+)'\)/g;
  let m;
  while ((m = reT.exec(client)) !== null) used.add(m[1]);
  for (const k of used) if (!zh.has(k)) add(problems, `T('${k}') 使用了未定义的文案键（会显示成键名）`);
  notes.push(`文案键：中文 ${zh.size} 个，英文 ${en.size} 个；代码引用 ${used.size} 个`);
  const unused = [...zh].filter((k) => !used.has(k) && !new RegExp(`T\\('${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`).test(client));
  if (unused.length) notes.push(`未被 T() 直接引用的键 ${unused.length} 个（可能是动态键，正常）：${unused.slice(0, 12).join(', ')}${unused.length > 12 ? '…' : ''}`);
}

// ---------- 2) CSS：dshic-* 类是否有定义 ----------
const styleStart = client.indexOf('const CSS = ');
const styleBlock = styleStart >= 0 ? client.slice(styleStart, client.indexOf('`;', styleStart)) : '';
const defined = new Set();
{
  const re = /\.(dshic-[A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(styleBlock)) !== null) defined.add(m[1]);
}
const usedClasses = new Set();
{
  const re = /className: '([^']+)'/g;
  let m;
  while ((m = re.exec(client)) !== null) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('dshic-')) usedClasses.add(c);
  }
  // 模板字符串里的 className（如 'dshic-x ' + ...）
  const re2 = /className: `([^`]+)`/g;
  while ((m = re2.exec(client)) !== null) {
    for (const c of m[1].split(/[\s${}]+/)) if (c.startsWith('dshic-')) usedClasses.add(c);
  }
}
for (const c of usedClasses) if (!defined.has(c)) add(problems, `使用了未定义的 CSS 类 .${c}（样式不会生效）`);
notes.push(`CSS：定义 ${defined.size} 个 dshic-* 类，使用 ${usedClasses.size} 个`);

// ---------- 3) 节点类型覆盖：可运行类型必须有分支；不可运行类型必须有明确拒绝（不能误跑视频） ----------
const types = new Set();
{
  const blk = /const TYPE_LABEL = \(\) => \(\{([\s\S]*?)\}\)/.exec(client);
  if (blk) {
    const re = /^\s*'?([a-z-]+)'?:/gm;
    let m;
    while ((m = re.exec(blk[1])) !== null) types.add(m[1]);
  }
}
if (!types.size) add(problems, '未能解析 TYPE_LABEL（节点类型清单）');
const runStart = client.indexOf('async function runGenNode');
const runBlock = client.slice(runStart, client.indexOf('function commitGenResult', runStart));
const RUNNABLE = ['script', 'storyboard', 'finalcut', 'image-gen', 'video-gen'];
for (const t of types) {
  if (RUNNABLE.includes(t)) {
    if (!runBlock.includes(`'${t}'`)) add(problems, `可运行节点类型 '${t}' 在 runGenNode 中没有分支`);
  } else if (!/type !== 'image-gen' && type !== 'video-gen'\) throw/.test(runBlock)) {
    add(problems, `不可运行类型 '${t}' 缺少明确拒绝分支：对话触发时可能误跑视频生成`);
  }
}
notes.push(`节点类型 ${types.size} 种（可运行 ${RUNNABLE.filter((t) => types.has(t)).length} 种）：${[...types].join(', ')}`);

// ---------- 4) Host：RPC 方法是否与前端调用一致 ----------
const rpcMethods = new Set();
{
  const blk = /const methods = \{([\s\S]*?)\n    \};/.exec(host);
  if (blk) {
    const re = /(?:async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
    let m;
    while ((m = re.exec(blk[1])) !== null) rpcMethods.add(m[1]);
  }
}
const calledMethods = new Set();
{
  const re = /hostRpc\('([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(client)) !== null) calledMethods.add(m[1]);
}
for (const m of calledMethods) if (!rpcMethods.has(m)) add(problems, `前端调用了 Host 未实现的 RPC 方法 '${m}'`);
notes.push(`RPC：Host 实现 ${rpcMethods.size} 个，前端调用 ${calledMethods.size} 个`);

// ---------- 5) 工具名与技能引用一致性 ----------
const toolNames = new Set();
{
  const re = /name: '(canvas_[a-z_]+)'/g;
  let m;
  while ((m = re.exec(host)) !== null) toolNames.add(m[1]);
}
const skill = readFileSync(path.join(root, 'assets', 'canvas-studio', 'SKILL.md'), 'utf8');
for (const t of toolNames) if (!skill.includes(t)) add(problems, `技能 canvas-studio 未提到工具 ${t}`);
for (const m of skill.matchAll(/`?(canvas_[a-z_]+)`?/g)) {
  if (!toolNames.has(m[1])) add(problems, `技能 canvas-studio 引用了不存在的工具 ${m[1]}`);
}
notes.push(`工具 ${toolNames.size} 个：${[...toolNames].join(', ')}`);

// ---------- 5b) 端口表两侧一致性 + 技能引用的端口必须真实存在 ----------
// 背景：曾经客户端用 'tailpick' 端口建边、技能也教 Agent 这么连，但两张端口表里都没有这个端口——
// 静态审计当时抓不到，运行期表现为"连线位置错乱/被当成文本边"。
{
  const extract = (src, anchor) => {
    const i = src.indexOf(anchor);
    if (i < 0) return null;
    const seg = src.slice(i, i + 4000);
    const end = seg.indexOf('\n};');
    return new Set([...seg.slice(0, end > 0 ? end : seg.length).matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]));
  };
  const hostPorts = extract(host, 'const PORT_TABLE = {');
  const clientSrc = readFileSync(path.join(root, 'client.js'), 'utf8');
  const clientPorts = extract(clientSrc, 'const PORTS = {');
  if (hostPorts && clientPorts) {
    const onlyHost = [...hostPorts].filter((p) => !clientPorts.has(p));
    const onlyClient = [...clientPorts].filter((p) => !hostPorts.has(p));
    for (const p of onlyHost) add(problems, `端口 '${p}' 只在 Host 端口表里有，客户端没有`);
    for (const p of onlyClient) add(problems, `端口 '${p}' 只在客户端端口表里有，Host 没有`);
    // 技能里教的 fromPort / toPort 必须真实存在
    const docs = [
      ['canvas-studio', skill],
      ['canvas-craft', readFileSync(path.join(root, 'assets', 'canvas-craft', 'SKILL.md'), 'utf8')],
    ];
    for (const [name, doc] of docs) {
      for (const m of doc.matchAll(/fromPort:\s*'([a-z]+)'/g)) {
        if (!clientPorts.has(m[1])) add(problems, `技能 ${name} 教了不存在的输出端口 '${m[1]}'（fromPort）`);
      }
      for (const m of doc.matchAll(/toPort:\s*'([a-z]+)'/g)) {
        if (!clientPorts.has(m[1])) add(problems, `技能 ${name} 教了不存在的输入端口 '${m[1]}'（toPort）`);
      }
    }
    notes.push(`端口：两侧各 ${clientPorts.size} 个 id（一致）`);
  }
}

// ---------- 5c) 分镜段落类型（seg）取值闭环 ----------
// 背景：规划器曾产出 'cut'、别名表却把规范值定为 'closeup'、UI 又去拼 T('segCut') —— 同一概念三套写法。
{
  const clientSrc = readFileSync(path.join(root, 'client.js'), 'utf8');
  const SEG_CANON = ['opening', 'continuation', 'scene_change', 'new_character', 'closeup'];
  // 规划器里 `seg = 'xxx'` 的赋值必须是规范值
  for (const m of clientSrc.matchAll(/\bseg\s*=\s*'([a-z_]+)'/g)) {
    if (!SEG_CANON.includes(m[1])) add(problems, `分镜段落类型产出非规范值 '${m[1]}'（规范：${SEG_CANON.join(' / ')}）`);
  }
  // UI 拼 T('seg' + Capitalize(seg)) 时，每个规范值都要有 i18n 键
  for (const v of SEG_CANON) {
    const key = 'seg' + v.charAt(0).toUpperCase() + v.slice(1);
    if (!clientSrc.includes(`'${key}'`)) add(problems, `缺 i18n 键 ${key}（分镜列表会显示原始 key）`);
  }
  notes.push(`分镜段落类型：${SEG_CANON.length} 个规范值（取值 + i18n 已闭环）`);
}

// ---------- 6) 说明：不做"未声明函数"扫描 ----------
// 试过基于正则的调用点扫描，但剥离注释/字符串时会被正则字面量里的引号破坏（例如 `/'"]/`），
// 产生大量误报，不能作为门禁。这类问题改由 smoke-render（真实执行组件树）与 test-tools（真实
// 执行全部工具）覆盖；新增函数务必补测试，而不是依赖静态扫描。

// ---------- 输出 ----------
console.log('=== 审计结果 ===');
for (const n of notes) console.log('· ' + n);
if (problems.length) {
  console.log('');
  console.error(`✗ 发现 ${problems.length} 个结构性问题：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\n✓ 机械化审计通过：i18n 键对齐、CSS 类定义、节点类型覆盖、RPC 一致性、技能/工具一致');
