#!/usr/bin/env node
/**
 * 对话工具契约测试（dev-only，不随包发布）。
 *
 * 覆盖两类事故：
 *  1) 静态：parameters 必须是标准 JSON Schema（属性级 required:true 是 defineTool 方言，会被 API 拒绝）
 *  2) 动态：真正执行每个工具的 execute()，把**返回值**与它声明的 output.schema 逐字段比对
 *     （第 2 类曾两次逃逸：返回值多字段 / 类型不符 → 整轮请求被 API 拒绝）
 *
 * 执行期使用临时目录（DSH_IC_PROJECTS_DIR / DSH_IC_CONFIG_PATH），不触碰真实画布数据。
 *
 * 运行：node scripts/test-tools.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-tools-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const tools = [];
const providers = [];
const fakeSkills = { registerProvider: (fn) => { providers.push(fn()); return () => {}; } };
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get(name) { return name === 'skills' ? fakeSkills : undefined; },
  webServer: { register: () => () => {} },
  tools: { register: (def) => { tools.push(def); return () => {}; } },
};

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
try {
  mod.apply(fakeCtx);
} catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + ((e && e.stack) || e));
  process.exit(1);
}
if (!tools.length) { console.error('✗ 没有捕获到任何工具'); process.exit(1); }

// ---------- 静态：参数/输出 schema 必须是标准 JSON Schema ----------
function checkSchema(node, where) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) { errs.push(`${where}: schema 必须是对象`); return; }
  if (node.required !== undefined && !Array.isArray(node.required)) {
    errs.push(`${where}.required 必须是字符串数组，收到 ${JSON.stringify(node.required)}（属性级 required:true 是 defineTool 方言，标准 JSON Schema 不接受）`);
  }
  if (Array.isArray(node.required) && node.properties) {
    for (const k of node.required) {
      if (!Object.prototype.hasOwnProperty.call(node.properties, k)) errs.push(`${where}.required 引用了不存在的属性: ${k}`);
    }
  }
  if (node.type !== undefined && typeof node.type !== 'string') errs.push(`${where}.type 必须是字符串`);
  if (node.enum !== undefined && !Array.isArray(node.enum)) errs.push(`${where}.enum 必须是数组`);
  for (const key of Object.keys(node)) {
    if (!['type', 'description', 'properties', 'required', 'items', 'enum', 'additionalProperties'].includes(key)) {
      errs.push(`${where}: 含有非标准 JSON Schema 关键字 "${key}"`);
    }
  }
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) checkSchema(v, `${where}.properties.${k}`);
  if (node.items) checkSchema(node.items, `${where}.items`);
}

const TYPES = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', object: 'object', array: 'object' };
/** 用声明的 output.schema 校验实际返回值（必填、类型、additionalProperties:false 时的多余字段）。 */
function validateValue(schema, value, where) {
  if (!schema || typeof schema !== 'object') return;
  if (value === undefined || value === null) {
    if (Array.isArray(schema.required) && schema.required.length) errs.push(`${where}: 返回值为空但 schema 要求必填字段 ${schema.required.join(',')}`);
    return;
  }
  const want = TYPES[schema.type];
  if (want && typeof value !== want) { errs.push(`${where}: 期望 ${schema.type}，实际 ${typeof value}`); return; }
  if (schema.type === 'integer' && !Number.isInteger(value)) errs.push(`${where}: 期望 integer，实际 ${value}`);
  if (Array.isArray(schema.required)) {
    for (const k of schema.required) {
      if (value[k] === undefined) errs.push(`${where}: 缺少必填字段 "${k}"（实际字段：${Object.keys(value).join(',')}）`);
    }
  }
  if (schema.properties) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (value[k] !== undefined) validateValue(sub, value[k], `${where}.${k}`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, k)) errs.push(`${where}: 返回了未声明的字段 "${k}"，而 schema 声明 additionalProperties:false（会被 API 拒绝）`);
      }
    }
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((v, i) => validateValue(schema.items, v, `${where}[${i}]`));
  }
}

const byName = new Map();
const seen = new Set();
for (const t of tools) {
  const nm = t && t.name;
  if (!nm || !/^[a-z][a-z0-9_]*$/.test(nm)) { errs.push(`工具名不合法: ${JSON.stringify(nm)}`); continue; }
  if (seen.has(nm)) errs.push(`工具名重复: ${nm}`);
  seen.add(nm);
  byName.set(nm, t);
  if (typeof t.description !== 'string' || !t.description.trim()) errs.push(`${nm}: description 缺失`);
  if (typeof t.execute !== 'function') errs.push(`${nm}: execute 缺失`);
  if (!t.parameters || t.parameters.type !== 'object') errs.push(`${nm}: parameters 必须是 type=object`);
  else checkSchema(t.parameters, `${nm}.parameters`);
  if (!t.output || !t.output.schema || typeof t.output.render !== 'function') { errs.push(`${nm}: output.schema/render 缺失`); continue; }
  checkSchema(t.output.schema, `${nm}.output.schema`);
  try {
    const rendered = t.output.render({}, {});
    if (!Array.isArray(rendered) || !rendered.length || typeof rendered[0].text !== 'string') errs.push(`${nm}: output.render 返回值不是 [{ type:'text', text }]`);
  } catch (e) {
    errs.push(`${nm}: output.render 抛错 → ${(e && e.message) || e}`);
  }
}

// ---------- 动态：按依赖顺序真实执行，逐个校验返回值 ----------
async function run(name, args) {
  const t = byName.get(name);
  if (!t) { errs.push(`缺少工具: ${name}`); return null; }
  let value;
  try {
    value = await t.execute(args, {});
  } catch (e) {
    errs.push(`${name}.execute 抛错 → ${(e && e.message) || e}`);
    return null;
  }
  validateValue(t.output.schema, value, `${name} 返回值`);
  const brief = value ? { ...value, text: value.text ? String(value.text).slice(0, 36) + '…' : value.text } : value;
  console.log(`  ${name} → ${JSON.stringify(brief)}`);
  return value;
}

console.log(`捕获工具 ${tools.length} 个：${[...byName.keys()].join(', ')}`);

// ---------- 内置技能（操作规程 + 创作方法论）----------
try {
  if (providers.length !== 1) errs.push(`skills 提供方数量应为 1，实际 ${providers.length}`);
  const p = providers[0];
  if (!p || p.name !== 'dsh-infinite-canvas') errs.push('技能提供方 name 不正确');
  const list = await p.list();
  if (!Array.isArray(list) || list.length !== 2) errs.push(`技能列表应包含 2 个内置技能，实际 ${Array.isArray(list) ? list.length : '非数组'}`);
  const names = (list || []).map((c) => c && c.name).sort();
  if (names.join(',') !== 'canvas-craft,canvas-studio') errs.push('内置技能名应为 canvas-craft 与 canvas-studio，实际 ' + names.join(','));
  const needBySkill = {
    'canvas-studio': ['canvas_list_projects', 'canvas_write_node', 'canvas_create_project', 'canvas_get_bible', 'canvas_update_bible', 'canvas_create_node', '设定集先行', 'output'],
    'canvas-craft': ['景别', '运镜', '分镜', '提示词', '设定集'],
  };
  for (const cand of list || []) {
    if (!Number.isFinite(cand.rank)) errs.push(`${cand.name}: 技能 rank 必须是有限数字（registry 强制要求）`);
    if (!cand.description || !cand.description.trim()) errs.push(`${cand.name}: 技能缺少 description`);
    if (!cand.invocation || cand.invocation.modelInvocable !== true) errs.push(`${cand.name}: 技能必须 modelInvocable（否则 Agent 无法加载）`);
    const got = await p.get(cand, {});
    if (!got.content || got.content.length < 300) errs.push(`${cand.name}: 技能正文过短，可能未正确解析 SKILL.md`);
    for (const need of needBySkill[cand.name] || []) {
      if (!String(got.content).includes(need)) errs.push(`${cand.name}: 技能正文未包含关键内容：${need}`);
    }
    if (got.rank !== undefined || got.locator !== undefined) errs.push(`${cand.name}: 技能 get() 应剥离 rank/locator 内部字段`);
    console.log(`  技能 ${cand.name}（rank=${cand.rank}，正文 ${got.content.length} 字）`);
  }
} catch (e) {
  errs.push('技能提供方校验失败 → ' + ((e && e.message) || e));
}

console.log('执行契约测试（临时目录隔离）：');
const created = await run('canvas_create_project', { name: '__契约测试__', scriptText: '创作意图文本', nodeName: '创作意图' });
const projectId = created && created.projectId;

// 幂等：同名再建必须复用而不是新建（用户反馈的核心问题）
try {
  const again = await byName.get('canvas_create_project').execute({ name: '__契约测试__' }, {});
  if (!again || again.projectId !== projectId) errs.push('同名项目未复用（重复创建会把画布塞满空壳项目）');
  const all = await mod._internals.projectsList();
  if (all.length !== 1) errs.push(`同名创建后项目数应为 1，实际 ${all.length}`);
} catch (e) {
  errs.push('幂等创建校验失败 → ' + ((e && e.message) || e));
}

await run('canvas_list_projects', {});
const written = await run('canvas_write_node', { projectId, text: '第一节剧本：雨夜接信', name: '第一节剧本' });
const nodeId = written && written.nodeId;

// 设定集先行：读/写设定集与通用建节点
try {
  const b0 = await byName.get('canvas_get_bible').execute({ projectId }, {});
  if (!b0 || !b0.ok) errs.push('canvas_get_bible 未返回 ok');
  const bb = await mod._internals.canvasGetBible({ projectId });
  if (!bb || !bb.bible) errs.push('canvas_get_bible 未返回设定集');
  const w = await byName.get('canvas_update_bible').execute({
    projectId,
    bible: {
      worldview: '城市褶皱里的时空邮局', style: '写实电影感，暖色调',
      characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服，帆布邮包' }],
      scenes: [{ name: '褶皱巷', desc: '雨夜老城区窄巷' }],
      props: [{ name: '火漆信', desc: '火漆印着邮戳' }],
    },
  }, {});
  if (!w || !w.ok) errs.push('canvas_update_bible 写入失败');
  // 合并语义：同名更新、不同名追加
  await byName.get('canvas_update_bible').execute({
    projectId,
    bible: { characters: [{ name: '陈拾', desc: '改：加了怀表' }, { name: '林小满', desc: '17 岁学生' }] },
  }, {});
  const b1 = await mod._internals.canvasGetBible({ projectId });
  const chars = b1.bible.characters || [];
  if (chars.length !== 2) errs.push(`设定集合并后角色数应为 2，实际 ${chars.length}`);
  const chen = chars.find((x) => x.name === '陈拾');
  if (!chen || !chen.desc.includes('怀表')) errs.push('设定集同名条目未更新');
  if (!b1.bible.worldview) errs.push('设定集世界观未保留');
  if (!b1.bibleUpdatedAt) errs.push('设定集缺少 bibleUpdatedAt（客户端无法感知同步）');
  // 通用建节点：角色参考图节点
  const n = await byName.get('canvas_create_node').execute({ projectId, type: 'image-gen', name: '角色-陈拾 参考图', prompt: '中近景，陈拾，旧邮差制服' }, {});
  if (!n || !n.ok || !n.nodeId) errs.push('canvas_create_node 未返回 nodeId');
  const doc = await mod._internals.projectsGet({ id: projectId });
  const created = doc.nodes[n.nodeId];
  if (!created || created.type !== 'image-gen') errs.push('canvas_create_node 未创建 image-gen 节点');
  if (!created || !(created.data.prompt || '').includes('陈拾')) errs.push('canvas_create_node 未写入提示词');
  if (!created || created.data.label !== '角色-陈拾 参考图') errs.push('canvas_create_node 丢失了节点名（data.label 被覆盖）');
} catch (e) {
  errs.push('设定集/建节点校验失败 → ' + ((e && e.message) || e));
}

// 剧本节点语义：写 output 不带 nodeId 必须复用已有剧本节点（idea 与 output 落在同一节点），
// 且 idea 参数能与 text/target 一次写全 —— 直接对应用户反馈的"两个半残节点"问题
try {
  const before = await mod._internals.projectsGet({ id: projectId });
  const beforeScripts = Object.values(before.nodes).filter((n) => n.type === 'script').length;
  const w = await byName.get('canvas_write_node').execute({ projectId, text: '第一版成稿', target: 'output', name: '第一节剧本' }, {});
  const after = await mod._internals.projectsGet({ id: projectId });
  const afterScripts = Object.values(after.nodes).filter((n) => n.type === 'script').length;
  if (afterScripts !== beforeScripts) errs.push(`写 output 时新建了剧本节点（${beforeScripts} → ${afterScripts}）：应当复用已有剧本节点`);
  const t0 = after.nodes[w.nodeId];
  if (!t0) errs.push('写入返回的 nodeId 在文档中不存在');
  else {
    if (!String(t0.data.output || '').trim()) errs.push('成稿未写入 output');
    if (!String(t0.data.idea || '').trim()) errs.push('复用后该剧本节点仍缺少 idea（出现"只有结果"的半残节点）');
  }
  const w2 = await byName.get('canvas_write_node').execute({ projectId, nodeId: w.nodeId, text: '第二版成稿', target: 'output', idea: '第二版意图' }, {});
  const doc2 = await mod._internals.projectsGet({ id: projectId });
  const n2 = doc2.nodes[w2.nodeId];
  if (!n2 || n2.data.output !== '第二版成稿' || n2.data.idea !== '第二版意图') errs.push('idea 参数未与 text/target 同时生效（无法一次写全意图与成稿）');
} catch (e) {
  errs.push('剧本节点语义校验失败 → ' + ((e && e.message) || e));
}
await run('canvas_write_node', { projectId, nodeId, text: '成稿内容……', target: 'output' });
await run('canvas_run_node', { projectId, nodeId });
await run('canvas_node_status', { projectId, nodeId });
await run('canvas_open', { projectId });
await run('canvas_delete_node', { projectId, nodeId });
// 删除的节点必须留墓碑（否则客户端按本地内容推送会把它复活）
try {
  const afterDel = await mod._internals.projectsGet({ id: projectId });
  if (afterDel.nodes[nodeId]) errs.push('canvas_delete_node 后节点仍在文档里');
  if (!Array.isArray(afterDel.tombstones) || !afterDel.tombstones.includes(nodeId)) errs.push('canvas_delete_node 未写入墓碑（tombstones）');
} catch (e) {
  errs.push('墓碑校验失败 → ' + ((e && e.message) || e));
}
await run('canvas_delete_project', { projectId });

// 运行/打开请求与删除通知必须一次性消费（projectsSync 读走即清空）
try {
  const sync1 = await mod._internals.projectsSync();
  const sync2 = await mod._internals.projectsSync();
  if (!sync1.runRequest) errs.push('canvas_run_node 写入的 runRequest 未被 projectsSync 读到');
  if (!Array.isArray(sync1.deletedProjects) || !sync1.deletedProjects.includes(projectId)) errs.push('canvas_delete_project 未通知客户端删除（deletedProjects）');
  if (sync2.runRequest || sync2.openRequest || sync2.deletedProjects) errs.push('projectsSync 未一次性消费 openRequest/runRequest/deletedProjects');
} catch (e) {
  errs.push('projectsSync 消费行为校验失败 → ' + ((e && e.message) || e));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 忽略 */ }

if (errs.length) {
  console.error(`\n✗ 工具契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ 工具 schema 与返回值契约全部通过');
process.exit(0);
