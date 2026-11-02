#!/usr/bin/env node
/**
 * 工作区内嵌项目契约测试（dev-only）：
 *  1) 发现：<工作区>/.infinite-canvas/project.json 是项目标记；wsProjectsScan 按 registry list 扫描
 *  2) 分发：readDocOrNull/docExists/writeIcDoc 对工作区 pid 透明（project.json / canvases/<cid>.json）
 *  3) 列表：projectsList 合并数据根项目与工作区项目（origin:'workspace'，带 wsId/wsPath）
 *  4) 多画布：canvasCreate 在工作区项目上照常工作（画布文档落 <ws>/.infinite-canvas/canvases/）
 *  5) 删除：projectsDelete 工作区项目 = 删 .infinite-canvas 目录（不碰工作区其他内容）
 *  6) 降级：wsWatchTick(undefined)（老宿主无 registry）不抛错
 * 运行：node scripts/test-workspace-projects.mjs（退出码 0=通过；临时目录，不碰真实数据）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-wsproj-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => ok(String(a) === String(b), m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）');

const tools = [];
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get() { return undefined; },
  webServer: { register: () => () => {} },
  tools: { register: (def) => { tools.push(def); return () => {}; } },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
try { mod.apply(fakeCtx); } catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + ((e && e.stack) || e));
  process.exit(1);
}
const I = mod._internals;
if (!I) { console.error('✗ index.js 未导出 _internals'); process.exit(1); }
const tool = (name) => tools.find((t) => t.name === name);

// ---------- 假工作区：目录 + 项目标记 ----------
const WS_DIR = path.join(SANDBOX, 'story-workspace');
const WS_APP = path.join(WS_DIR, '.infinite-canvas');
fs.mkdirSync(WS_APP, { recursive: true });
const WS_PID = 'ws-test01';
fs.writeFileSync(path.join(WS_APP, 'project.json'), JSON.stringify({
  id: WS_PID, name: '百炼短剧', createdAt: 1700000000000, updatedAt: 1700000000000, source: 'agent',
  nodes: {}, edges: [], view: { x: 60, y: 40, scale: 1 }, defaultCanvasName: '第1集',
}), 'utf8');

const REGISTRY = [
  { id: 'ws-11111111', path: WS_DIR, title: 'story-workspace', sessionIds: ['ses_a'] },
  { id: 'ws-22222222', path: path.join(SANDBOX, 'empty-ws'), title: 'empty-ws', sessionIds: [] },
];
fs.mkdirSync(REGISTRY[1].path, { recursive: true }); // 无标记的工作区：采纳时不该建项目

// ---------------- 1) 发现 ----------------
{
  const found = I.wsProjectsScan(REGISTRY);
  ok(Array.isArray(found) && found.length === 1, '扫描应恰好发现 1 个工作区项目（无标记目录不算）');
  eq(found[0] && found[0].pid, WS_PID, '扫描结果的 pid 应取自 project.json 的 id');
  eq(found[0] && found[0].wsId, 'ws-11111111', '扫描结果应携带工作区 id');
  eq(I.isWsProject(WS_PID), true, 'isWsProject 未识别工作区项目');
  eq(I.isWsProject('nope'), false, 'isWsProject 误报未知 pid');
  const home = I.wsProjectHome(WS_PID);
  ok(home && fs.existsSync(home), 'wsProjectHome 应返回存在的 .infinite-canvas 目录');
}

// ---------------- 2) 读分发 ----------------
{
  eq(I.docExists(WS_PID), true, 'docExists 对工作区项目应返回 true');
  const doc = await I.projectsGet({ id: WS_PID });
  ok(doc && doc.id === WS_PID, 'projectsGet 未能读到工作区项目文档');
  eq(doc && doc.name, '百炼短剧', '工作区项目文档内容不符');
}

// ---------------- 3) 列表合并 ----------------
{
  await I.projectsPut({ id: 'plain1', name: '数据根项目', doc: { nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } } });
  const list = await I.projectsList();
  const wsEntry = list.find((p) => p.id === WS_PID);
  const drEntry = list.find((p) => p.id === 'plain1');
  ok(!!wsEntry, 'projectsList 缺少工作区项目');
  ok(!!drEntry, 'projectsList 丢失了数据根项目');
  eq(wsEntry && wsEntry.origin, 'workspace', '工作区项目应带 origin:"workspace"');
  eq(wsEntry && wsEntry.wsId, 'ws-11111111', '工作区项目应带 wsId');
  ok(!drEntry || drEntry.origin === undefined, '数据根项目不应带 workspace origin');
  eq(wsEntry && wsEntry.defaultCanvasName, '第1集', '工作区项目默认画布名未透出');
}

// ---------------- 4) 多画布在工作区项目上照常工作 ----------------
{
  const made = await I.canvasCreate({ projectId: WS_PID, name: '第2集' });
  ok(made && made.ok && made.canvasId, '工作区项目新建画布失败');
  const cid = made.canvasId;
  // 画布文档首写懒创建（与数据根一致）：登记后先建节点，再断言文件落位
  const cnode = I.canvasCreateNode({ projectId: WS_PID, canvasId: cid, type: 'text', prompt: '第二集开场' });
  ok(cnode && cnode.ok, '工作区子画布建节点失败');
  const canvasFile = path.join(WS_APP, 'canvases', cid + '.json');
  ok(fs.existsSync(canvasFile), '子画布文档应落在 <ws>/.infinite-canvas/canvases/ 下');
  const cDoc = await I.projectsGet({ id: WS_PID, canvasId: cid });
  eq(Object.keys(cDoc.nodes || {}).length, 1, '子画布节点未写入工作区画布文档');
  const projDoc = JSON.parse(fs.readFileSync(path.join(WS_APP, 'project.json'), 'utf8'));
  ok((projDoc.canvases || []).some((c) => c.id === cid), '工作区 project.json 未登记新画布');
  // 数据根项目不受影响
  const drDoc = await I.projectsGet({ id: 'plain1' });
  ok(drDoc && Object.keys(drDoc.nodes || {}).length === 0, '工作区写入污染了数据根项目');
}

// ---------------- 5) 删除工作区项目 = 删 .infinite-canvas 目录 ----------------
{
  const del = await I.projectsDelete({ id: WS_PID });
  ok(del && (del.ok !== false), 'projectsDelete 工作区项目失败');
  ok(!fs.existsSync(WS_APP), '删除后 .infinite-canvas 目录应被清掉');
  ok(fs.existsSync(WS_DIR), '工作区目录本身必须保留（项目目录 ≠ 工作区）');
  eq(I.isWsProject(WS_PID), false, '删除后缓存未清（isWsProject 仍为 true）');
  eq(I.docExists(WS_PID), false, '删除后 docExists 仍为 true');
  const list2 = await I.projectsList();
  ok(!list2.some((p) => p.id === WS_PID), '删除后项目列表仍出现工作区项目');
}

// ---------------- 6) 降级：无 registry 不抛 ----------------
{
  let threw = null;
  try { I.wsWatchTick(undefined); } catch (e) { threw = e; }
  ok(threw === null, 'wsWatchTick(undefined) 不应抛错（老宿主降级），实际：' + (threw && threw.message));
}

// ---------------- 结果 ----------------
if (errs.length) {
  console.error('✗ test-workspace-projects FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-workspace-projects PASS');
