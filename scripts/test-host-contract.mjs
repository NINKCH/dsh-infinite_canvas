#!/usr/bin/env node
/**
 * 宿主契约回归（dev-only）：core 的 apply(ctx) 必须只依赖
 *   ctx.effect / ctx.tools.register / ctx.webServer.register
 * 就能同步注册全部工具与 API 路由；llm / attachments / workspaceRegistry 等
 * 宿主增强服务缺失时必须降级而不是抛错（宿主无关化的底线）。
 *
 * 运行：node scripts/test-host-contract.mjs   退出码 0 = 通过
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-hostonly-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const tools = [];
const routes = [];
const disposers = [];
const fakeSkills = { registerProvider: () => () => {} };
const fakeCtx = {
  effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); return () => {}; },
  // 故意只提供 skills：llm / attachments / workspaceRegistry / sessionController 全部缺失
  get(name) { return name === 'skills' ? fakeSkills : undefined; },
  tools: { register(def) { tools.push(def); return () => {}; } },
  webServer: { register(route) { routes.push(route); return () => {}; } },
};

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
try { mod.apply(fakeCtx); } catch (e) {
  console.error('✗ apply(ctx) 在最小宿主下抛错：' + ((e && e.stack) || e));
  process.exit(1);
}

// 同步注册：apply 返回即完成（非 Harness 宿主无需等待事件循环）
ok(tools.length >= 30, '工具注册数异常（实际 ' + tools.length + '）');
ok(routes.length >= 9, 'API 路由注册数异常（实际 ' + routes.length + '）');
ok(tools.every((t) => t && typeof t.name === 'string' && t.name.startsWith('canvas_')), '存在非 canvas_* 工具');
ok(tools.every((t) => typeof t.execute === 'function'), '存在缺少 execute 的工具');
ok(routes.every((r) => r && r.kind === 'exact' && String(r.path).startsWith('/infinite-canvas/api/')), '存在非 exact / 非 /infinite-canvas/api 路由');
const names = tools.map((t) => t.name);
for (const must of ['canvas_list_projects', 'canvas_create_node', 'canvas_import_asset', 'canvas_list_assets', 'canvas_list_presets', 'canvas_apply_preset']) {
  ok(names.includes(must), '缺少工具 ' + must);
}
ok(names.length === new Set(names).size, '工具名重复');
ok(!routes.some((r) => r.path === '/'), 'core 不应注册 HTML 面板路由（面板由 adapter 承载）');
ok(disposers.length > 0, 'effect 未返回清理函数');
for (const off of disposers.reverse()) { try { off(); } catch { /* 忽略 */ } }

if (errs.length) {
  console.error('✗ 宿主契约未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 宿主契约通过（最小 ctx 同步注册 ' + tools.length + ' 工具 / ' + routes.length + ' 路由；增强服务缺失可降级）');
process.exit(0);
