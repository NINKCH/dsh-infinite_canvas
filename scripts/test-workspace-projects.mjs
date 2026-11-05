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

// ---------------- 5b) 修复轮回归：解绑后不被绑回（简化后天然成立，并确认无残留字段） ----------------
{
  const wsUb = path.join(SANDBOX, 'ws-unbind');
  fs.mkdirSync(wsUb, { recursive: true });
  I.wsProjectCreateAt({ id: 'ws-unbind01', path: wsUb, title: 'ws-unbind', sessionIds: ['ses_only'] });
  const pidUb = JSON.parse(fs.readFileSync(path.join(wsUb, '.infinite-canvas', 'project.json'), 'utf8')).id;
  await I.bindingSet(pidUb, 'ses_only', null, () => true);
  const b1 = await I.bindingsRead(pidUb);
  eq(b1.bindings.length, 1, '前置：绑定应存在');
  await I.bindingClear(pidUb, 'ses_only'); // 用户显式解绑
  I.wsWatchTick(REGISTRY.concat([{ id: 'ws-unbind01', path: wsUb, title: 'ws-unbind', sessionIds: ['ses_only'] }]));
  const b2 = await I.bindingsRead(pidUb);
  eq(b2.bindings.length, 0, '解绑后被绑回');
  const raw = JSON.parse(fs.readFileSync(path.join(wsUb, '.infinite-canvas', 'bindings.json'), 'utf8'));
  ok(raw.suppressAutoBind === undefined, 'suppressAutoBind 机制应已移除（无自动绑即无需抑制标记）');
}

// ---------------- 5c) 修复轮回归：会话全局唯一绑定 ----------------
{
  // 同一会话先后绑到两个工作区项目：旧项目的绑定必须被移除（一会话一画布是全局约束）
  const wsA = path.join(SANDBOX, 'ws-ga');
  const wsB = path.join(SANDBOX, 'ws-gb');
  fs.mkdirSync(wsA, { recursive: true }); fs.mkdirSync(wsB, { recursive: true });
  I.wsProjectCreateAt({ id: 'ws-ga01', path: wsA, title: 'ws-ga', sessionIds: ['ses_roam'] });
  I.wsProjectCreateAt({ id: 'ws-gb01', path: wsB, title: 'ws-gb', sessionIds: ['ses_roam'] });
  const pidA = JSON.parse(fs.readFileSync(path.join(wsA, '.infinite-canvas', 'project.json'), 'utf8')).id;
  const pidB = JSON.parse(fs.readFileSync(path.join(wsB, '.infinite-canvas', 'project.json'), 'utf8')).id;
  await I.bindingSet(pidA, 'ses_roam', null, () => true);
  const made = await I.canvasCreate({ projectId: pidB, name: '第2集' });
  await I.bindingSet(pidB, 'ses_roam', made.canvasId, () => true);
  const bA = await I.bindingsRead(pidA);
  eq(bA.bindings.filter((x) => x.sessionId === 'ses_roam').length, 0, '跨项目重绑后旧项目绑定未清除');
  const bB = await I.bindingsRead(pidB);
  eq(bB.bindings.filter((x) => x.sessionId === 'ses_roam').length, 1, '新项目绑定缺失');
}

// ---------------- 5e) 修复轮：wsDocFile 路径逃逸封堵（评审 I4） ----------------
{
  const evil = WS_PID + '__cv__../../../evil';
  eq(I.docExists(evil), false, '路径逃逸 id 可探测文件存在（评审 I4）');
  eq(I.wsProjectHome('wsX__cv__..%2f..%2fx'), null, '编码逃逸未被拒绝');
  let threw = null;
  try { await I.projectsGet({ id: evil }); } catch (e) { threw = e; }
  ok(!!threw, '路径逃逸 id 未被项目不存在拦截');
}

// ---------------- 7) watcher 退化为纯发现：不建项目、不绑会话（显式-only） ----------------
{
  const wsNew = path.join(SANDBOX, 'ws-new');
  fs.mkdirSync(wsNew, { recursive: true });
  REGISTRY.push({ id: 'ws-new01', path: wsNew, title: 'ws-new', sessionIds: ['ses_new01', 'ses_second'] });
  const r = I.wsWatchTick(REGISTRY);
  ok(r && !r.skipped && Array.isArray(r.discovered), 'tick 应回报 discovered 列表');
  ok(!fs.existsSync(path.join(wsNew, '.infinite-canvas')), 'watcher 不得自动建项目（绑定必须显式，编码工作区零打扰）');
  const list = await I.projectsList();
  ok(!list.some((p) => p.wsId === 'ws-new01'), '无标记工作区不应出现在项目列表');
  // 显式创建后：tick 只做发现（采纳），不重复建、不绑会话
  const rec = I.wsProjectCreateAt({ id: 'ws-new01', path: wsNew, title: 'ws-new' });
  const doc = JSON.parse(fs.readFileSync(path.join(wsNew, '.infinite-canvas', 'project.json'), 'utf8'));
  eq(doc.defaultCanvasName, '第1集', '显式创建的项目默认画布名应为「第1集」');
  ok(/^[A-Za-z0-9_-]{1,96}$/.test(rec.pid), '新项目 id 不符合 projectFile 字符集');
  const r2 = I.wsWatchTick(REGISTRY);
  ok(r2.discovered.includes(rec.pid), 'tick 应发现（采纳）已有标记的项目');
  eq(r2.discovered.filter((x) => x === rec.pid).length, 1, '发现列表不应重复');
  const list2 = await I.projectsList();
  ok(list2.some((p) => p.id === rec.pid && p.origin === 'workspace'), '发现的项目应进项目列表');
  const b0 = await I.bindingsRead(rec.pid);
  eq(b0.bindings.length, 0, 'watcher 不得自动绑定会话（显式绑定-only）');
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
  const g = await M.sessionBindingGet({ sessionId: 'ses_new01' });
  ok(g && g.ok && g.supported === true, 'sessionBindingGet 应 supported');
  ok(g.project && g.project.id, 'sessionBindingGet 未回项目');
  // 无绑定会话：binding=null（watcher 不再自动绑，绑定只能显式）
  ok(g.binding === null, '未显式绑定的会话不应有绑定（自动绑已移除）');
  // 显式绑定到默认画布
  const gb = await M.sessionBindingSet({ sessionId: 'ses_new01', projectId: g.project.id, canvasId: null });
  ok(gb && gb.ok, '显式绑定默认画布失败');
  const g2 = await M.sessionBindingGet({ sessionId: 'ses_new01' });
  ok(g2.binding && g2.binding.canvasId === null, '显式绑定后 bindingGet 应回默认画布（null）');
  ok(Array.isArray(g2.canvases), 'sessionBindingGet 未回画布清单');
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
  const s2 = await M.sessionBindingSet({ sessionId: 'ses_new01', canvasId: made.canvasId });
  ok(s2 && s2.ok === false && s2.occupied === true, 'RPC 层占用检查失效');
  const cl = await M.sessionBindingClear({ sessionId: 'ses_new01' });
  ok(cl && cl.ok, 'sessionBindingClear 失败');
  const mp = await M.memoryPut({ projectId: g.project.id, canvasId: made.canvasId, title: '第2集', summary: 'RPC 写记忆。', body: '正文X' });
  ok(mp && mp.ok, 'memoryPut RPC 失败');
  const mg = await M.memoryGet({ projectId: g.project.id, canvasId: made.canvasId });
  ok(mg && mg.ok && String(mg.episode && mg.episode.body).includes('正文X'), 'memoryGet RPC 失败');
  const mgIdx = await M.memoryGet({ projectId: g.project.id });
  ok(mgIdx && mgIdx.ok && mgIdx.index.episodes.length === 1, 'memoryGet 索引条目不符');
  // —— 两级菜单数据面：bindableProjects 混排两类来源，每项带画布清单 ——
  const bp = await M.bindableProjects();
  ok(bp && bp.ok && Array.isArray(bp.projects), 'bindableProjects 失败');
  const cap = await M.bindingCapabilities();
  ok(cap && cap.ok && cap.rev >= 2 && cap.anyProject === true, 'bindingCapabilities 探针缺失或版本不足');
  const wsProj = bp.projects.find((p) => p.id === g.project.id);
  const drProj = bp.projects.find((p) => p.id === 'plain1');
  ok(!!wsProj && wsProj.origin === 'workspace' && Array.isArray(wsProj.canvases) && wsProj.canvases.length >= 1, 'bindableProjects 缺工作区项目或画布清单');
  ok(!!drProj && drProj.origin === 'dataRoot', 'bindableProjects 缺数据根项目');
  // 数据根项目也可绑定（RPC 面）
  const dp = await M.sessionBindingSet({ sessionId: 'ses_second', projectId: 'plain1', canvasId: null });
  ok(dp && dp.ok, '数据根项目绑定失败');
  const dpGet = await M.sessionBindingGet({ sessionId: 'ses_second' });
  ok(dpGet && dpGet.project && dpGet.project.id === 'plain1', 'bindable 绑定回读不符');
  // 解绑必须命中**实际绑定项目**（全局查找）：数据根项目的绑定也能被仅会话清除
  const dc = await M.sessionBindingClear({ sessionId: 'ses_second' });
  ok(dc && dc.ok && dc.removed === true, '数据根项目解绑未命中（仅会话点了无效）');
  const dpGet2 = await M.sessionBindingGet({ sessionId: 'ses_second' });
  ok(!(dpGet2 && dpGet2.binding), '解绑后仍回读为已绑定');
}

// ---------------- 绑定会话的读取隔离（0.20.0） ----------------
{
  I.wsWatchTick(REGISTRY); // 填充 wsProjects 缓存（锁依赖它解析工作区内嵌项目）
  await I.rpcMethods().sessionBindingSet({ sessionId: 'ses_new01', projectId: 'plain1', canvasId: null });
  const execBound = { agent: { sessionId: 'ses_new01' } };
  const lr = await tool('canvas_list_projects').execute({}, execBound);
  ok(String(lr.text).includes('只显示绑定项目'), '绑定会话 list 未提示只显示绑定项目');
  ok(!String(lr.text).includes(WS_PID), '绑定会话 list 泄漏了其他项目');
  ok(String(lr.text).includes('plain1'), '绑定会话 list 缺少绑定项目本身');
  const cr = await tool('canvas_create_project').execute({ name: '越权新项目' }, execBound);
  ok(cr && cr.ok === false && cr.locked === true, '绑定会话 canvas_create_project 未被拒绝');
  // 未绑定会话不受限（不能过度收紧）
  const lr2 = await tool('canvas_list_projects').execute({}, { agent: { sessionId: 'ses_free_xyz' } });
  ok(!String(lr2.text).includes('只显示绑定项目'), '未绑定会话不应出现绑定过滤提示');
}

// ---------------- 工作区项目命名（0.20.0）：title 优先，存量机器名自动修正 ----------------
{
  const TITLE_DIR = path.join(SANDBOX, 'wsmw3hao7et2ll');
  fs.mkdirSync(TITLE_DIR, { recursive: true });
  const WS_TITLE = { id: 'ws-title-0001', path: TITLE_DIR, title: '百炼短剧', sessionIds: ['ses_title'] };
  REGISTRY.push(WS_TITLE);
  I.wsWatchTick(REGISTRY);
  const M2 = I.rpcMethods();
  const made = await M2.workspaceProjectCreate({ sessionId: 'ses_title' });
  ok(made && made.ok, 'workspaceProjectCreate 失败');
  eq(made && made.name, '百炼短剧', '新建项目名未取工作区显示名（实际：' + (made && made.name) + '）');
  const doc = await I.projectsGet({ id: made.projectId });
  eq(doc && doc.name, '百炼短剧', '项目文档名未取工作区显示名');
  // 存量修正：把名字改回"目录名"（模拟旧版本建出来的项目），再次 adopt 应自动改回显示名
  const f = path.join(TITLE_DIR, '.infinite-canvas', 'project.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw.name = 'wsmw3hao7et2ll';
  fs.writeFileSync(f, JSON.stringify(raw));
  const again = await M2.workspaceProjectCreate({ sessionId: 'ses_title' });
  eq(again && again.name, '百炼短剧', '存量机器名未被自动修正');
  // 用户手动改过的名字不得覆盖
  const raw2 = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw2.name = '我的手改项目';
  fs.writeFileSync(f, JSON.stringify(raw2));
  const third = await M2.workspaceProjectCreate({ sessionId: 'ses_title' });
  eq(third && third.name, '我的手改项目', '用户手动改过的项目名被覆盖');
}

// ---------------- 结果 ----------------
if (errs.length) {
  console.error('✗ test-workspace-projects FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-workspace-projects PASS');
