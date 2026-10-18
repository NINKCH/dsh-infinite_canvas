#!/usr/bin/env node
/**
 * 存储引擎 v2（0.18）回归测试：SQLite（node:sqlite）+ CAS 对象库
 *  1) setDataRoot → 挂载/创建 canvas.db（node:sqlite 不可用的环境自动跳过本测试）
 *  2) 项目文档 CRUD 走 DB（projectsPut 合并 / projectsList 摘要 / projectsGet 往返）
 *  3) 对话侧工具走 DB（canvasCreateProject / canvasWriteNode / canvasGetBible）
 *  4) 资产：创建/更新/删除；分页（keyset 游标）与中文检索（trigram FTS / 短词 LIKE）
 *  5) CAS 引用计数：多资产共享对象，最后一个引用删除后对象文件才回收
 *  6) 空表保护：旧客户端 assetIndexBulkPut 空清单不得清掉服务端已有资产
 *  7) v1 → v2 一次性迁移：~/.dsh 项目 JSON + 数据目录 assets.json → canvas.db
 *
 * 运行：node scripts/test-db.mjs；退出码 0=通过 1=失败（无 node:sqlite 时打印 SKIP 并通过）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-db-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const I = mod._internals;
mod.apply({
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
});

if (!I.sqliteAvailable()) {
  console.log('SKIP：当前 Node 无 node:sqlite（<22.5），存储引擎 v2 不可测（运行时将走 JSON 降级）');
  process.exit(0);
}

// ---------- 1) 挂载 ----------
const DATA = path.join(SANDBOX, 'data');
const setRes = I.setDataRoot(DATA);
ok(setRes.ok && setRes.mode === 'sqlite', 'setDataRoot 未进入 sqlite 模式：' + JSON.stringify(setRes));
ok(fs.existsSync(path.join(DATA, 'canvas.db')), 'canvas.db 未创建在数据目录');
ok(I.sqlActive(), 'sqlActive() 应为 true');

// ---------- 2) 项目文档 CRUD ----------
const doc1 = {
  id: 'p_db1', name: '测试剧集', createdAt: Date.now() - 1000, updatedAt: Date.now() - 500,
  nodes: { n1: { id: 'n1', type: 'script', data: { label: '第一节', status: 'idle', idea: 'x', output: '' } } },
  edges: [], tombstones: [], view: { x: 0, y: 0, scale: 1 },
};
const put1 = await I.projectsPut({ id: doc1.id, name: doc1.name, doc: doc1 });
ok(put1.ok && !put1.deleted, 'projectsPut 失败');
const lst = I.projectsList();
ok(lst.length === 1 && lst[0].id === 'p_db1' && lst[0].name === '测试剧集', 'projectsList 未从 DB 读出项目');
ok(Array.isArray(lst[0].nodeIds) && lst[0].nodeIds.includes('n1'), 'projectsList 摘要缺 nodeIds');
ok(lst[0].nodes.some((n) => n.id === 'n1' && n.label === '第一节'), 'projectsList 摘要缺节点信息');
const got = await I.projectsGet({ id: 'p_db1' });
ok(got && got.nodes && got.nodes.n1 && got.nodes.n1.data.label === '第一节', 'projectsGet 往返丢失节点数据');
// 二次推送合并：prev 节点保留 + 新节点进入
await I.projectsPut({ id: 'p_db1', name: '测试剧集', doc: { nodes: { n2: { id: 'n2', type: 'text', data: { text: '场景一' } } }, edges: [], ts: Date.now() } });
const got2 = await I.projectsGet({ id: 'p_db1' });
ok(got2.nodes.n1 && got2.nodes.n2, 'projectsPut 合并丢失既有节点或未纳入新节点');

// ---------- 3) 对话侧工具走 DB ----------
const cp = await I.canvasCreateProject({ name: '时光邮局', scriptText: '意图文本', nodeName: '第一节剧本' });
ok(cp.ok && cp.projectId && cp.nodeId, 'canvasCreateProject 失败');
await I.canvasWriteNode({ projectId: cp.projectId, nodeId: cp.nodeId, target: 'output', text: '第一节正文', overwrite: true });
const bibleRes = await I.canvasUpdateBible({ projectId: cp.projectId, bible: { worldview: '邮局穿越', characters: [{ name: '陈拾', desc: '26 岁邮递员' }] } });
ok(bibleRes.bible && bibleRes.bible.worldview === '邮局穿越', 'canvasUpdateBible 失败');
const bibleGet = await I.canvasGetBible({ projectId: cp.projectId });
ok(bibleGet.bible.characters[0].name === '陈拾', 'canvasGetBible 未从 DB 读回设定集');
const namesByTool = I.readAssetIndexNames(cp.projectId);
ok(Array.isArray(namesByTool), 'readAssetIndexNames（SQL 模式）应返回数组');

// ---------- 4) 资产：创建/分页/检索/更新/删除 ----------
const t0 = 1700000000000;
await I.dbAssetCreate({ id: 'a_img1', projectId: cp.projectId, kind: 'image', mime: 'image/png', name: '角色-陈拾 三视图设定', sha: 'a'.repeat(64), size: 123, createdAt: t0, prompt: '三视图 turnaround 参考' });
await I.dbAssetCreate({ id: 'a_img2', projectId: cp.projectId, kind: 'image', mime: 'image/png', name: '场景-巷道 主视图', sha: 'b'.repeat(64), size: 456, createdAt: t0 + 1, prompt: '巷道夜景 冷白光' });
await I.dbAssetCreate({ id: 'a_txt1', projectId: cp.projectId, kind: 'text', mime: 'text/markdown', name: '第一节分镜表', rel: `projects/${cp.projectId}/text/b.md`, createdAt: t0 + 2, text: '【镜1】3s', category: 'storyboard' });

const page1 = await I.dbAssetsList({ projectId: cp.projectId, limit: 2 });
ok(page1.total === 3 && page1.items.length === 2 && page1.nextCursor, '分页第一页不正确：' + JSON.stringify({ total: page1.total, n: page1.items.length }));
ok(page1.items[0].id === 'a_txt1', '分页应按 created_at DESC 排序');
const page2 = await I.dbAssetsList({ projectId: cp.projectId, limit: 2, cursor: page1.nextCursor });
ok(page2.items.length === 1 && page2.items[0].id === 'a_img1' && !page2.nextCursor, '分页第二页不正确');

const hit = await I.dbAssetsList({ projectId: cp.projectId, q: '三视图' });
ok(hit.total === 1 && hit.items[0].id === 'a_img1', '中文 FTS（trigram）检索未命中');
const short = await I.dbAssetsList({ projectId: cp.projectId, q: '巷道' });
ok(short.total === 1 && short.items[0].id === 'a_img2', '短词 LIKE 检索未命中');
const miss = await I.dbAssetsList({ projectId: cp.projectId, q: '不存在的词' });
ok(miss.total === 0, '不存在的关键词不应命中');

const upd = await I.dbAssetUpdate('a_txt1', { name: '第一节分镜表·定稿' });
ok(upd.asset.name === '第一节分镜表·定稿' && upd.asset.text === '【镜1】3s', 'assetUpdate 改名失败或丢文本字段');
const nm = await I.dbAssetNames(cp.projectId);
ok(nm.names.length === 3 && nm.names.some((x) => x.name === '第一节分镜表·定稿'), 'assetNames 不正确');

// ---------- 5) CAS 引用计数 ----------
const shaShared = 'c'.repeat(64);
await I.dbAssetCreate({ id: 'a_s1', projectId: cp.projectId, kind: 'image', mime: 'image/png', name: '共享参考1', sha: shaShared, size: 9, createdAt: t0 + 10 });
await I.dbAssetCreate({ id: 'a_s2', projectId: 'p_db1', kind: 'image', mime: 'image/png', name: '共享参考2', sha: shaShared, size: 9, createdAt: t0 + 11 });
const objAbs = I.objectAbsFor(DATA, shaShared);
fs.mkdirSync(path.dirname(objAbs), { recursive: true });
fs.writeFileSync(objAbs, 'OBJECTDATA');
await I.dbAssetDelete('a_s1');
ok(fs.existsSync(objAbs), '仍有引用时对象文件被误删');
await I.dbAssetDelete('a_s2');
ok(!fs.existsSync(objAbs), '引用归零后对象文件未回收');

// ---------- 6) 空表保护（旧客户端兼容） ----------
const rpc = I.rpcMethods();
ok(typeof rpc.assetIndexBulkPut === 'function', 'RPC 方法表未暴露');
await rpc.assetIndexPut({ projectId: cp.projectId, projectName: '时光邮局', asset: { id: 'a_keep', kind: 'image', name: '保护对象', projectId: cp.projectId } });
// 旧客户端启动全量同步：该浏览器没有资产 → 发空占位 → 绝不能清掉服务端已有资产
await rpc.assetIndexBulkPut({ items: [{ projectId: cp.projectId, projectName: '时光邮局', asset: null }] });
const keep = await rpc.assetsGet({ ids: ['a_keep'] });
ok(keep.items.length === 1, '旧客户端空表同步清掉了服务端资产（空表保护失效）');

// ---------- 7) v1 → v2 迁移 ----------
const DATA2 = path.join(SANDBOX, 'data2');
const legacyDoc = {
  id: 'p_legacy', name: '旧机器剧集', createdAt: t0, updatedAt: t0 + 100,
  nodes: { ln1: { id: 'ln1', type: 'script', data: { label: '旧第一节', status: 'idle' } } },
  edges: [], tombstones: [],
};
fs.mkdirSync(process.env.DSH_IC_PROJECTS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, 'p_legacy.json'), JSON.stringify(legacyDoc), 'utf8');
fs.mkdirSync(path.join(DATA2, 'projects', '旧机器剧集'), { recursive: true });
fs.writeFileSync(path.join(DATA2, 'projects', '旧机器剧集', 'project.json'), JSON.stringify(legacyDoc), 'utf8');
fs.writeFileSync(path.join(DATA2, 'projects', '旧机器剧集', 'assets.json'), JSON.stringify([
  { id: 'a_legacy', projectId: 'p_legacy', kind: 'image', name: '旧角色图', rel: 'projects/p_legacy/image/old.png', size: 42, createdAt: t0 },
]), 'utf8');
// v1 清单：pid → 文件夹映射（迁移扫描依赖它定位 assets.json）
fs.writeFileSync(path.join(DATA2, 'canvas.meta.json'), JSON.stringify({
  version: 1, updatedAt: t0,
  projects: [{ id: 'p_legacy', name: '旧机器剧集', folder: '旧机器剧集', createdAt: t0 }],
}), 'utf8');
const set2 = I.setDataRoot(DATA2); // 换目录：fresh canvas.db → 自动 v1 迁移
ok(set2.ok && set2.mode === 'sqlite', '第二数据目录挂载失败');
const migList = I.projectsList();
ok(migList.some((p) => p.id === 'p_legacy' && p.name === '旧机器剧集'), 'v1 项目文档未迁移进 DB');
const legacyAssets = await I.dbAssetsList({ projectId: 'p_legacy' });
ok(legacyAssets.total === 1 && legacyAssets.items[0].id === 'a_legacy' && legacyAssets.items[0].rel === 'projects/p_legacy/image/old.png', 'v1 资产索引未迁移（rel 指针应原样保留）');
// 挂载幂等：重开不重复导入（计数不变）
const listAgain = I.projectsList();
ok(listAgain.filter((p) => p.id === 'p_legacy').length === 1, '重复挂载产生重复项目');

// ---------- 8) 项目删除 → 项目资产行一并删除 ----------
await I.setDataRoot(DATA); // 切回第一个库
await I.projectsDelete({ id: 'p_db1' });
const afterDel = await I.projectsGet({ id: 'p_db1' }).then(() => false).catch(() => true);
ok(afterDel, 'projectsDelete 后项目仍可读');
const orphans = await I.dbAssetsList({ projectId: 'p_db1' });
ok(orphans.total === 0, '项目删除后资产行未清理');
const cpStill = await I.projectsGet({ id: cp.projectId });
ok(!!cpStill, '未删除的项目受影响');

I.closeDb(); // 关闭 SQLite 句柄：Windows 上句柄未释放时 rmSync 会 EPERM
try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
if (errs.length) {
  console.error('✗ 存储引擎 v2 回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 存储引擎 v2 回归测试通过（挂载/文档CRUD/分页/中文检索/引用计数/迁移/删除清理）');
process.exit(0);
