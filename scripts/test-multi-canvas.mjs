#!/usr/bin/env node
/**
 * 多画布（项目下子目录 = 独立画布）契约测试（dev-only）：
 *  1) 数据层：默认画布 canvasId=null → 文档 id 仍等于 projectId（旧数据零迁移）；
 *     子画布文档 id = `${projectId}__cv__${canvasId}`，节点/连线按画布隔离
 *  2) 登记：项目文档里 canvases:[{id,name,createdAt}]；projectsList 不把画布文档当项目
 *  3) RPC：canvasCreate/canvasRename/canvasDelete/canvasesList；空名/重名拒绝
 *  4) 工具：canvas_* 全部支持 canvasId 透传（缺省 = 默认画布），canvas_list_projects 列出画布
 *  5) 删除：删项目时清掉全部子画布文档
 *  6) 项目级共享：资产/设定集仍按 projectId（子画布读写共用项目设定集）
 * 运行：node scripts/test-multi-canvas.mjs（退出码 0=通过；临时目录，不碰真实数据）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-multicanvas-'));
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

// ---------------- 1) 文档 id 约定（默认画布零迁移） ----------------
{
  eq(I.canvasDocId('p1'), 'p1', '默认画布文档 id 必须等于 projectId（旧数据零迁移）');
  eq(I.canvasDocId('p1', 'cv1'), 'p1__cv__cv1', '子画布文档 id 约定不符');
  eq(I.isCanvasDocId('p1'), false, '项目 id 被误判为画布文档 id');
  eq(I.isCanvasDocId('p1__cv__cv1'), true, '子画布文档 id 未被识别');
  eq(I.splitCanvasDocId('p1__cv__cv1').projectId, 'p1', '项目 id 解析错误');
  eq(I.splitCanvasDocId('p1__cv__cv1').canvasId, 'cv1', '画布 id 解析错误');
}

// ---------------- 2) 默认画布读写 + 子画布隔离 ----------------
{
  await I.projectsPut({ id: 'p1', name: '项目一', canvases: [], doc: { nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } } });
  const created = I.canvasCreateNode({ projectId: 'p1', type: 'text', prompt: '默认画布节点' });
  ok(created && created.ok, '默认画布建节点失败');
  const defDoc = await I.projectsGet({ id: 'p1' });
  ok(defDoc && Object.keys(defDoc.nodes || {}).length === 1, '默认画布节点未写入项目文档');
  eq(defDoc.id, 'p1', '默认画布文档 id 不是 projectId');

  const made = await I.canvasCreate({ projectId: 'p1', name: '分镜画布' });
  ok(made && made.ok && made.canvasId, '新建画布失败');
  const cid = made.canvasId;
  const reg = await I.projectsGet({ id: 'p1' });
  ok(Array.isArray(reg.canvases) && reg.canvases.some((c) => c.id === cid), '项目文档没有登记新画布');
  const emptyCanvas = await I.projectsGet({ id: 'p1', canvasId: cid });
  ok(emptyCanvas && Object.keys(emptyCanvas.nodes || {}).length === 0, '新画布首入应为空白');
  eq(emptyCanvas.canvasId, cid, '子画布文档没有回传 canvasId');

  // 子画布建节点：不污染默认画布
  const cnode = I.canvasCreateNode({ projectId: 'p1', canvasId: cid, type: 'text', prompt: '子画布节点' });
  ok(cnode && cnode.ok && cnode.canvasId === cid, '子画布建节点失败或未回传 canvasId');
  const cDoc = await I.projectsGet({ id: 'p1', canvasId: cid });
  eq(Object.keys(cDoc.nodes || {}).length, 1, '子画布节点未写入子画布文档');
  const defDoc2 = await I.projectsGet({ id: 'p1' });
  eq(Object.keys(defDoc2.nodes || {}).length, 1, '子画布写入污染了默认画布文档');
  eq(defDoc2.canvases.length, 1, '默认画布文档的画布登记丢失');

  // projectsList：画布文档不算项目，项目挂着 canvases
  const list = I.projectsList();
  eq(list.length, 1, 'projectsList 把画布文档当成了项目');
  eq(list[0].id, 'p1', 'projectsList 项目 id 不对');
  ok(Array.isArray(list[0].canvases) && list[0].canvases.some((c) => c.id === cid), 'projectsList 未附加画布清单');

  // 工具 canvasId 透传：status / update / delete / relayout / connect 全部按画布定位
  const st = tool('canvas_node_status');
  const statusC = await st.execute({ projectId: 'p1', canvasId: cid, nodeId: cnode.nodeId });
  ok(String(statusC.text).includes('子画布节点'), 'canvas_node_status 未按 canvasId 定位子画布节点');
  let missed = false;
  try { await st.execute({ projectId: 'p1', nodeId: cnode.nodeId }); } catch { missed = true; }
  ok(missed, 'canvas_node_status 缺少 canvasId 时仍在默认画布找到了子画布节点（画布未隔离）');

  const upd = tool('canvas_update_node');
  const u = await upd.execute({ projectId: 'p1', canvasId: cid, nodeId: cnode.nodeId, patch: { label: '子画布改名节点' } });
  ok(u && u.ok, 'canvas_update_node 不支持 canvasId');
  const cDoc2 = await I.projectsGet({ id: 'p1', canvasId: cid });
  eq(cDoc2.nodes[cnode.nodeId].data.label, '子画布改名节点', 'canvasUpdateNode 未写进子画布文档');

  const connectTool = tool('canvas_connect');
  const n2 = I.canvasCreateNode({ projectId: 'p1', canvasId: cid, type: 'storyboard', prompt: '分镜表' });
  const ce = await connectTool.execute({ projectId: 'p1', canvasId: cid, fromNode: cnode.nodeId, toNode: n2.nodeId });
  ok(ce && ce.ok, 'canvas_connect 不支持 canvasId');
  const cDoc3 = await I.projectsGet({ id: 'p1', canvasId: cid });
  eq((cDoc3.edges || []).length, 1, '子画布连线未写入子画布文档');

  const del = tool('canvas_delete_node');
  const dn = await del.execute({ projectId: 'p1', canvasId: cid, nodeId: n2.nodeId });
  ok(dn && dn.ok, 'canvas_delete_node 不支持 canvasId');

  // 画布清单 RPC
  const cl = await I.canvasesList({ projectId: 'p1' });
  ok(Array.isArray(cl.canvases) && cl.canvases.length === 1, 'canvasesList 未返回子画布清单');
  eq((await I.projectsSync()).docChanged.canvasId, cid, 'Agent 改动子画布后的同步信号没带 canvasId');

  // 重命名：空名 / 重名拒绝，合法生效
  let renameErr = null;
  try { await I.canvasRename({ projectId: 'p1', canvasId: cid, name: '  ' }); } catch (e) { renameErr = e; }
  ok(!!renameErr, '重命名画布空名未被拒绝');
  const rn = await I.canvasRename({ projectId: 'p1', canvasId: cid, name: '改名画布' });
  ok(rn && rn.ok && rn.name === '改名画布', '重命名画布失败');
  eq((await I.projectsGet({ id: 'p1' })).canvases.find((c) => c.id === cid).name, '改名画布', '重命名未落项目登记');

  // 设定集按项目共享：子画布读到的 bible 与项目一致
  await I.canvasUpdateBible({ projectId: 'p1', bible: { worldview: '共享世界观' } });
  const cBible = await I.projectsGet({ id: 'p1', canvasId: cid });
  eq(cBible.bible && cBible.bible.worldview, '共享世界观', '子画布没有共享项目设定集（应按 projectId 共享）');
  const dDoc = await I.projectsGet({ id: 'p1' });
  ok(Array.isArray(dDoc.canvases) && dDoc.canvases.length === 1, '设定集更新后项目画布登记丢失');

  // projectsPut 直接推画布文档（客户端 450ms 全量推送路径）：视图落盘，节点按合并语义保留 Host 侧节点
  await I.projectsPut({ id: 'p1', canvasId: cid, canvases: [{ id: cid, name: '改名画布', createdAt: 1 }], doc: { nodes: {}, edges: [], view: { x: 1, y: 2, scale: 1 } } });
  const pushed = await I.projectsGet({ id: 'p1', canvasId: cid });
  eq(pushed.view.x, 1, 'projectsPut(canvasId) 视图未落盘');
  eq(Object.keys(pushed.nodes || {}).length, 1, 'projectsPut(canvasId) 丢失了 Host 侧已有节点（合并语义被破坏）');
  eq((await I.projectsGet({ id: 'p1' })).canvases.find((c) => c.id === cid).name, '改名画布', 'projectsPut(canvases) 未同步画布登记');

  // canvas_list_projects 工具展示画布
  const lp = await tool('canvas_list_projects').execute({});
  ok(String(lp.text).includes('canvasId=' + cid), 'canvas_list_projects 未列出子画布');

  // 删除画布：登记与文档一起清
  const cd = await I.canvasDelete({ projectId: 'p1', canvasId: cid });
  ok(cd && cd.ok, '删除画布失败');
  eq((await I.projectsGet({ id: 'p1' })).canvases.length, 0, '删除画布后项目登记未更新');
  let gone = false;
  try { await I.projectsGet({ id: 'p1', canvasId: cid }); } catch { gone = true; }
  ok(gone, '删除画布后仍能读到画布文档');
}

// ---------------- 3) 删除项目时清掉全部子画布文档 ----------------
{
  await I.projectsPut({ id: 'p2', name: '项目二', canvases: [], doc: { nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } } });
  const made = await I.canvasCreate({ projectId: 'p2', name: '子画布' });
  await I.projectsPut({ id: 'p2', canvasId: made.canvasId, doc: { nodes: { c1: { id: 'c1', type: 'text', x: 0, y: 0, w: 360, h: 360, data: { text: 'x' } } }, edges: [], view: { x: 0, y: 0, scale: 1 } } });
  await I.projectsDelete({ id: 'p2' });
  const ids = I.projectsList().map((p) => p.id);
  ok(!ids.includes('p2'), '删除项目后项目仍在列表');
  let gone = false;
  try { await I.projectsGet({ id: 'p2', canvasId: made.canvasId }); } catch { gone = true; }
  ok(gone, '删除项目后子画布文档残留');
  // 删除后迟到的画布推送被墓碑拒收（不能把项目/画布复活）
  const late = await I.projectsPut({ id: 'p2', canvasId: made.canvasId, doc: { nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } } });
  ok(late && late.deleted === true, '删除后迟到的画布推送未被墓碑拒收');
  ok(!I.projectsList().some((p) => p.id === 'p2'), '迟到的画布推送把项目复活了');
}

// ---------------- 4) 旧项目（无 canvases 字段）兼容 ----------------
{
  // 模拟旧版落盘文档：没有 canvases 字段、没有 canvasId
  await I.projectsPut({ id: 'old1', name: '旧项目', doc: { nodes: { n1: { id: 'n1', type: 'text', x: 0, y: 0, w: 360, h: 360, data: { text: '旧节点', label: '旧节点' } } }, edges: [], view: { x: 0, y: 0, scale: 1 } } });
  const doc = await I.projectsGet({ id: 'old1' });
  eq(Object.keys(doc.nodes || {}).length, 1, '旧项目默认画布节点丢失');
  ok(Array.isArray(doc.canvases) && doc.canvases.length === 0, '旧项目应被归一为空画布清单');
  // 旧文档照常跑工具（默认画布）
  const st = await tool('canvas_node_status').execute({ projectId: 'old1', nodeId: 'n1' });
  ok(String(st.text).includes('旧节点'), '旧项目默认画布无法按原有方式访问');
}

if (errs.length) {
  console.error('✗ 多画布契约测试未通过（' + errs.length + ' 项）：');
  errs.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('✓ 多画布契约测试通过（默认画布零迁移 / 子画布独立文档 / 登记与 RPC / 工具 canvasId 透传 / 删项目清画布 / 旧项目兼容）');
process.exit(0);
