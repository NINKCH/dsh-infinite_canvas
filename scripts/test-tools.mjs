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
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get() { return undefined; },
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
console.log('执行契约测试（临时目录隔离）：');
const created = await run('canvas_create_project', { name: '__契约测试__', scriptText: '创作意图文本', nodeName: '创作意图' });
const projectId = created && created.projectId;
await run('canvas_list_projects', {});
const written = await run('canvas_write_node', { projectId, text: '第一节剧本：雨夜接信', name: '第一节剧本' });
const nodeId = written && written.nodeId;
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
