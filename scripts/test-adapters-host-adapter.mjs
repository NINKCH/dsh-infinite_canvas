#!/usr/bin/env node
/**
 * 假 ctx 适配器（host-adapter）契约测试（dev-only，不随包发布）。
 *
 * 覆盖 adapters/shared/HOST-CONTRACT.md §6 的接口契约：
 *  1) createHostAdapter() 的假 ctx 喂给 apply(ctx) 后，收集到全部 canvas_* 工具（实测 30 个）
 *  2) 工具名集合与 HOST-CONTRACT.md §3 的 CANVAS_METHODS 数组逐项一致（数量+顺序）
 *  3) routes 收集到 webServer 路由，含 /infinite-canvas/api/rpc
 *  4) 每个 def.name 以 canvas_ 开头、入口函数（execute）是函数
 *  5) 存储根约定（数据根裁定 Task 7）：缺省优先级 homeDir option > env DSH_IC_HOME >
 *     用户目录 ~/.dsh-infinite-canvas/；本断言经 env DSH_IC_HOME 注入临时目录（密闭，
 *     绝不写真实用户目录），DSH_IC_PROJECTS_DIR / DSH_IC_CONFIG_PATH 指向注入根之下
 *  6) dispose() 调用全部 disposer（工具/路由注册被逐一撤销）
 *
 * 运行：node scripts/test-adapters-host-adapter.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const errs = [];
let tmpHome = null; // os 临时目录（密闭数据根）；异常收尾也要删

// ---------- 从 HOST-CONTRACT.md 解析 CANVAS_METHODS（文档即权威，不让清单漂移） ----------
function canvasMethodsFromContract() {
  const md = fs.readFileSync(path.join(ROOT, 'adapters', 'shared', 'HOST-CONTRACT.md'), 'utf8');
  const m = md.match(/const CANVAS_METHODS = \[([\s\S]*?)\];/);
  if (!m) { errs.push('HOST-CONTRACT.md 里找不到 CANVAS_METHODS 数组'); return null; }
  const names = [...m[1].matchAll(/'(canvas_[a-z_]+)'/g)].map((x) => x[1]);
  if (!names.length) { errs.push('HOST-CONTRACT.md 的 CANVAS_METHODS 数组为空'); return null; }
  return names;
}

try {
  const CANVAS_METHODS = canvasMethodsFromContract();

  // ---------- 密闭准备（数据根裁定 Task 7）：缺省存储根经 env DSH_IC_HOME 注入临时目录 ----------
  // 必须在 createHostAdapter 之前设置（其内部读 env 决定缺省根）；绝不依赖/触碰真实用户目录，
  // 也不再写仓库内 adapters/.tmp-home（旧缺省已废弃——包内数据随插件升级清空创作资产）。
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-host-adapter-home-'));
  process.env.DSH_IC_HOME = tmpHome;

  // ---------- 装载适配器（corePath 缺省按布局自解析，开发布局 = 仓库根 index.js） ----------
  const { createHostAdapter } = require(path.join(ROOT, 'adapters', 'shared', 'host-adapter.cjs'));
  const adapter = await createHostAdapter();
  const { ctx, tools, routes, dispose } = adapter;

  // ---------- 断言 5：存储根约定（env DSH_IC_HOME 注入根；import core 前必须已生效） ----------
  if (process.env.DSH_IC_PROJECTS_DIR !== path.join(tmpHome, 'projects')) {
    errs.push(`DSH_IC_PROJECTS_DIR 应指向 DSH_IC_HOME（${tmpHome}）/projects，实际 ${process.env.DSH_IC_PROJECTS_DIR}`);
  }
  if (process.env.DSH_IC_CONFIG_PATH !== path.join(tmpHome, 'config.json')) {
    errs.push(`DSH_IC_CONFIG_PATH 应指向 DSH_IC_HOME（${tmpHome}）/config.json，实际 ${process.env.DSH_IC_CONFIG_PATH}`);
  }

  // ---------- 断言 1：假 ctx 喂 apply 后收集到全部工具 ----------
  if (tools.length !== 30) {
    errs.push(`tools.length 应为 30（实测注册数），实际 ${tools.length}`);
  }
  // Task 16：get('llm') 返回桥接 llm 服务（同实例；形状=core 消费接口三件）；
  // 其余服务名仍恒 undefined（防御式降级不变）
  const llmSvc = ctx.get('llm');
  if (!llmSvc || typeof llmSvc !== 'object') {
    errs.push(`ctx.get('llm') 应返回桥接 llm 服务对象，实际 ${typeof llmSvc}`);
  } else {
    if (typeof llmSvc.listProviders !== 'function') errs.push("ctx.get('llm').listProviders 应为函数（core listLlmOptions 消费）");
    if (typeof llmSvc.listModels !== 'function') errs.push("ctx.get('llm').listModels 应为函数（core listLlmOptions 消费）");
    if (typeof llmSvc.stream !== 'function') errs.push("ctx.get('llm').stream 应为函数（core complete() 消费）");
    if (ctx.get('llm') !== llmSvc) errs.push("ctx.get('llm') 应返回同一实例（懒创建单例）");
  }
  if (ctx.get('workspaceRegistry') !== undefined) errs.push("ctx.get('workspaceRegistry') 应恒返回 undefined（非 llm 服务防御式降级不变）");
  if (ctx.get('anything-else') !== undefined) errs.push("ctx.get('anything-else') 应恒返回 undefined（非 llm 服务防御式降级不变）");
  // Task 16：effect 回调抛错 → stderr 红字日志，不炸进程（不向上传播），已完成的注册保留
  let effectDisposerRan = false;
  ctx.effect(() => { // 正常路径：返回的清理函数进 dispose 链
    return () => { effectDisposerRan = true; };
  });
  let threwFromEffect = null;
  try {
    ctx.effect(() => { throw new Error('effect 回调应被接住'); });
  } catch (e) { threwFromEffect = e; }
  if (threwFromEffect) errs.push('ctx.effect 回调抛错应被捕获转 stderr，不得向上传播：' + threwFromEffect.message);
  ctx.effect('not-a-function'); // 非函数入参静默忽略（原契约）

  // ---------- 断言 2：工具名集合与 CANVAS_METHODS 逐项一致（数量+顺序） ----------
  if (CANVAS_METHODS) {
    const names = tools.map((d) => d.name);
    if (names.length !== CANVAS_METHODS.length) {
      errs.push(`工具数 ${names.length} 与 CANVAS_METHODS.length ${CANVAS_METHODS.length} 不一致`);
    } else {
      for (let i = 0; i < names.length; i++) {
        if (names[i] !== CANVAS_METHODS[i]) {
          errs.push(`第 ${i + 1} 个工具不符（注册表 "${names[i]}" vs CANVAS_METHODS "${CANVAS_METHODS[i]}"）`);
          break;
        }
      }
    }
    const onlyRegistry = names.filter((n) => !CANVAS_METHODS.includes(n));
    const onlyContract = CANVAS_METHODS.filter((n) => !names.includes(n));
    if (onlyRegistry.length) errs.push('注册表里有 CANVAS_METHODS 没有的工具: ' + onlyRegistry.join(', '));
    if (onlyContract.length) errs.push('CANVAS_METHODS 里有注册表没有的工具: ' + onlyContract.join(', '));
  }

  // ---------- 断言 3：routes 含 /infinite-canvas/api/rpc ----------
  const paths = routes.map((r) => r.path);
  if (!paths.includes('/infinite-canvas/api/rpc')) {
    errs.push('routes 缺少 /infinite-canvas/api/rpc，实际: ' + paths.join(', '));
  }
  for (const r of routes) {
    if (r.kind !== 'exact') errs.push(`路由 ${r.path} 的 kind 应为 exact，实际 ${r.kind}`);
    if (typeof r.handler !== 'function') errs.push(`路由 ${r.path} 的 handler 应为函数`);
  }

  // ---------- 断言 4：def.name 以 canvas_ 开头、入口函数为函数 ----------
  for (const def of tools) {
    if (!def.name || !String(def.name).startsWith('canvas_')) errs.push(`工具名应以 canvas_ 开头: ${def.name}`);
    if (typeof def.execute !== 'function') errs.push(`${def.name}.execute 应为函数`);
    if (typeof def.description !== 'string' || !def.description) errs.push(`${def.name}.description 应为非空字符串`);
    if (!def.parameters || typeof def.parameters !== 'object') errs.push(`${def.name}.parameters 应为 JSON Schema 对象`);
  }

  // ---------- 断言 6：dispose() 撤销全部注册 ----------
  dispose();
  dispose(); // 幂等
  if (tools.length !== 0) errs.push(`dispose() 后 tools 应清空，实际剩 ${tools.length}`);
  if (routes.length !== 0) errs.push(`dispose() 后 routes 应清空，实际剩 ${routes.length}`);
  if (!effectDisposerRan) errs.push('dispose() 应执行 effect 回调返回的清理函数（dispose 链含 effect 收集）');

  // 清理密闭数据根（里面只有空目录，不丢任何东西）
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
} catch (e) {
  try { if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.error('✗ host-adapter 契约测试异常终止：' + ((e && e.stack) || e));
  process.exit(1);
}

if (errs.length) {
  console.error(`\n✗ host-adapter 契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ host-adapter 收集 core 工具注册表与 webServer 路由：契约全部通过');
process.exit(0);
