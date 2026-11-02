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
let REGISTRY = []; // fakeRegistry.list() 活引用：apply 的 watcher effect 启动扫描时为空（无副作用），各节再填充
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get(key) { return key === 'workspaceRegistry' ? { list: () => REGISTRY } : undefined; },
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

const REGISTRY0 = [
  { id: 'ws-11111111', path: WS_DIR, title: 'story-workspace', sessionIds: ['ses_a'] },
  { id: 'ws-22222222', path: path.join(SANDBOX, 'empty-ws'), title: 'empty-ws', sessionIds: [] },
];
REGISTRY.push(...REGISTRY0);
fs.mkdirSync(REGISTRY0[1].path, { recursive: true }); // 无标记的工作区：采纳时不该建项目

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
  // 工作区里项目没了：模拟工作区删除后重新添加同目录 —— REGISTRY 移除该条目（后续 tick 不得重建干扰计数）
  const idxDel = REGISTRY.findIndex((w) => w.id === 'ws-11111111');
  if (idxDel >= 0) REGISTRY.splice(idxDel, 1);
}

// ---------------- 6) 降级：无 registry 不抛 ----------------
{
  let threw = null;
  try { I.wsWatchTick(undefined); } catch (e) { threw = e; }
  ok(threw === null, 'wsWatchTick(undefined) 不应抛错（老宿主降级），实际：' + (threw && threw.message));
}

// ---------------- 7) watcher：新工作区建项目 / 重复 tick 采纳 ----------------
{
  const wsNew = path.join(SANDBOX, 'ws-new');
  fs.mkdirSync(wsNew, { recursive: true });
  REGISTRY.push({ id: 'ws-new01', path: wsNew, title: 'ws-new', sessionIds: [] });
  const r = I.wsWatchTick(REGISTRY);
  // watcher 策略：所有无标记工作区都自动建项目（「新建工作区默认创建画布项目」）——empty-ws 也该建
  ok(r && !r.skipped && Array.isArray(r.created) && r.created.length === 2
     && r.created.includes('ws-22222222') && r.created.includes('ws-new01'),
    'tick 应为两个无标记工作区各建一个项目（实际：' + JSON.stringify(r && r.created) + '）');
  const doc = JSON.parse(fs.readFileSync(path.join(wsNew, '.infinite-canvas', 'project.json'), 'utf8'));
  eq(doc.defaultCanvasName, '第1集', '新项目默认画布名应为「第1集」');
  ok(/^[A-Za-z0-9_-]{1,96}$/.test(doc.id), '新项目 id 不符合 projectFile 字符集');
  const r2 = I.wsWatchTick(REGISTRY);
  eq(r2.created.length, 0, '重复 tick 不应重建项目（应走采纳）');
  const list = await I.projectsList();
  ok(list.filter((p) => p.origin === 'workspace').length >= 2, '工作区项目列表应含新建项目');
}

// ---------------- 8) watcher：唯一会话自动绑默认画布；第二会话不绑 ----------------
{
  const entry = REGISTRY.find((w) => w.id === 'ws-new01');
  entry.sessionIds = ['ses_first'];
  const r = I.wsWatchTick(REGISTRY);
  ok(Array.isArray(r.bound) && r.bound.includes('ses_first'), '唯一会话未自动绑默认画布');
  const pid = JSON.parse(fs.readFileSync(path.join(entry.path, '.infinite-canvas', 'project.json'), 'utf8')).id;
  const b = await I.bindingsRead(pid);
  eq(b.bindings.length, 1, '自动绑条目数不符');
  eq(b.bindings[0].sessionId, 'ses_first', '自动绑会话不符');
  eq(b.bindings[0].canvasId, null, '自动绑应指向默认画布');
  entry.sessionIds = ['ses_second', 'ses_first'];
  I.wsWatchTick(REGISTRY);
  const b2 = await I.bindingsRead(pid);
  eq(b2.bindings.length, 1, '第二会话不应被自动绑');
}

// ---------------- 9) watcher：项目创建时已有多会话 → 不自动绑 ----------------
{
  const wsMulti = path.join(SANDBOX, 'ws-multi');
  fs.mkdirSync(wsMulti, { recursive: true });
  REGISTRY.push({ id: 'ws-multi01', path: wsMulti, title: 'ws-multi', sessionIds: ['s1', 's2'] });
  I.wsWatchTick(REGISTRY);
  const pid = JSON.parse(fs.readFileSync(path.join(wsMulti, '.infinite-canvas', 'project.json'), 'utf8')).id;
  const b = await I.bindingsRead(pid);
  eq(b.bindings.length, 0, '项目创建时已有多会话 → 不应自动绑');
}

// ---------------- 10) watcher：目录消失 → 跳过不建不删 ----------------
{
  const gone = path.join(SANDBOX, 'ws-gone'); // 不创建目录
  REGISTRY.push({ id: 'ws-gone01', path: gone, title: 'ws-gone', sessionIds: [] });
  let threw = null;
  try { I.wsWatchTick(REGISTRY); } catch (e) { threw = e; }
  ok(threw === null, '目录消失 tick 不应抛错');
  ok(!fs.existsSync(path.join(gone, '.infinite-canvas')), '目录不存在时不应创建项目');
}

// ---------------- 11) RPC 面：bindingGet / bindingSet / bindingClear / workspaceProjectCreate / memoryGet / memoryPut ----------------
{
  const M = I.rpcMethods();
  const g = await M.sessionBindingGet({ sessionId: 'ses_first' });
  ok(g && g.ok && g.supported === true, 'sessionBindingGet 应 supported');
  ok(g.project && g.project.id, 'sessionBindingGet 未回项目');
  ok(g.binding && g.binding.canvasId === null, 'sessionBindingGet 绑定画布应为默认（null）');
  ok(Array.isArray(g.canvases), 'sessionBindingGet 未回画布清单');
  const c = await M.workspaceProjectCreate({ sessionId: 'ses_second' });
  ok(c && c.ok && c.projectId === g.project.id, 'workspaceProjectCreate 未复用既有项目');
  ok(c.created === false && c.bound === false, '复用既有项目时不应强行绑定（绑定走选择器）');
  // 新工作区：一键建项目 + 自动绑默认画布
  const wsFresh = path.join(SANDBOX, 'ws-fresh');
  fs.mkdirSync(wsFresh, { recursive: true });
  REGISTRY.push({ id: 'ws-fresh01', path: wsFresh, title: 'ws-fresh', sessionIds: ['ses_fresh'] });
  const c2 = await M.workspaceProjectCreate({ sessionId: 'ses_fresh' });
  ok(c2 && c2.ok && c2.created === true && c2.bound === true, '新工作区一键建项目+绑定失败');
  ok(fs.existsSync(path.join(wsFresh, '.infinite-canvas', 'project.json')), '一键建项目未落盘');
  const made = await I.canvasCreate({ projectId: g.project.id, name: '第2集' });
  ok(made && made.ok, '新建画布失败');
  const s = await M.sessionBindingSet({ sessionId: 'ses_second', projectId: g.project.id, canvasId: made.canvasId });
  ok(s && s.ok, 'sessionBindingSet 失败');
  const s2 = await M.sessionBindingSet({ sessionId: 'ses_first', canvasId: made.canvasId });
  ok(s2 && s2.ok === false && s2.occupied === true, 'RPC 层占用检查失效');
  const cl = await M.sessionBindingClear({ sessionId: 'ses_first' });
  ok(cl && cl.ok, 'sessionBindingClear 失败');
  const mp = await M.memoryPut({ projectId: g.project.id, canvasId: made.canvasId, title: '第2集', summary: 'RPC 写记忆。', body: '正文X' });
  ok(mp && mp.ok, 'memoryPut RPC 失败');
  const mg = await M.memoryGet({ projectId: g.project.id, canvasId: made.canvasId });
  ok(mg && mg.ok && String(mg.episode && mg.episode.body).includes('正文X'), 'memoryGet RPC 失败');
  const mgIdx = await M.memoryGet({ projectId: g.project.id });
  ok(mgIdx && mgIdx.ok && mgIdx.index.episodes.length === 1, 'memoryGet 索引条目不符');
}

// ---------------- 结果 ----------------
if (errs.length) {
  console.error('✗ test-workspace-projects FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-workspace-projects PASS');
