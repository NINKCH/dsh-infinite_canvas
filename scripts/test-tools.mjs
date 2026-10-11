#!/usr/bin/env node
/**
 * 对话工具 schema 测试（dev-only，不随包发布）。
 *
 * 用假 ctx 捕获 Host 注册的全部 Agent 工具，校验它们是**标准 JSON Schema**：
 *  - required 必须是对象级「字符串数组」，绝不能是属性级布尔（defineTool 方言）
 *  - required 引用的键必须存在于 properties
 *  - 每个属性必须有 type / items / properties 之一；enum 必须是数组
 *  - output.render 可执行且返回 [{ type:'text', text }]
 *
 * 运行：node scripts/test-tools.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tools = [];
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get() { return undefined; },
  webServer: { register: () => () => {} },
  tools: { register: (def) => { tools.push(def); return () => {}; } },
};

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const plugin = mod.default ?? mod;
try {
  (plugin.apply ?? mod.apply)(fakeCtx);
} catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + ((e && e.stack) || e));
  process.exit(1);
}

const errs = [];
if (!tools.length) errs.push('没有捕获到任何工具（ctx.tools.register 未被调用）');

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
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) checkSchema(v, `${where}.properties.${k}`);
  }
  if (node.items) checkSchema(node.items, `${where}.items`);
}

const seen = new Set();
for (const t of tools) {
  const nm = t && t.name;
  if (!nm || !/^[a-z][a-z0-9_]*$/.test(nm)) { errs.push(`工具名不合法: ${JSON.stringify(nm)}`); continue; }
  if (seen.has(nm)) errs.push(`工具名重复: ${nm}`);
  seen.add(nm);
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

console.log(`捕获工具 ${tools.length} 个：${tools.map((t) => t.name).join(', ')}`);
if (errs.length) {
  console.error(`✗ 工具 schema 校验未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 工具 schema 全部符合标准 JSON Schema');
process.exit(0);
