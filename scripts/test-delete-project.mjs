#!/usr/bin/env node
/**
 * BLK-01 回归测试（dev-only，不随包发布）：删除项目必须真正清干净。
 *
 * 判据（对应 _qa/BLK-01-删除项目残留-20261019-1512.md 第 7 节 6 条 + 7.1 节 4 条，共 10 条）：
 *   1  删除前记录镜像目录文件数/字节 → 删除后目录不存在
 *   2  同级其它项目文件数/字节不变
 *   3  objects/ 与 DB 无悬挂引用（本项目 sha 对象按引用计数回收；assets/projects 无残留行）
 *   4  重建同名项目 → 目录内只有新产物（不读到旧文件）
 *   5  重复删除 → 幂等成功、无报错
 *   6  （界面项，命令级不可验 → 本脚本只断言接口返回值带磁盘结果，界面部分留给 QA）
 *   7  FTS 无残留：删后 MATCH 不命中该项目资产
 *   8  两条删除入口都覆盖：projectsDelete 与 canvasDeleteProject
 *   9  meta 无 folder 条目（目录名 = 项目 id）时目录仍被删掉
 *   10 表级等值断言：COUNT(assets_fts) == COUNT(assets)
 *
 * 运行：node scripts/test-delete-project.mjs；退出码 0=通过 1=失败（无 node:sqlite 时 SKIP 通过）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-del-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };
const countFiles = (dir) => {
  let n = 0;
  let bytes = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { n++; try { bytes += fs.statSync(p).size; } catch { /* 忽略 */ } }
    }
  };
  walk(dir);
  return { n, bytes };
};

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const I = mod._internals;
mod.apply({
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
});

if (!I.sqliteAvailable()) {
  console.log('SKIP：当前 Node 无 node:sqlite（<22.5），BLK-01 只在 SQL 模式下成立（JSON 分支本就有清理）');
  process.exit(0);
}

const DATA = path.join(SANDBOX, 'data');
const setRes = I.setDataRoot(DATA);
ok(setRes.ok && setRes.mode === 'sqlite', 'setDataRoot 未进入 sqlite 模式：' + JSON.stringify(setRes));
const db = I.getDb();
const t0 = Date.now();

/** 造一个项目：项目行 + 镜像目录 + 资产行（带 rel 文件）/FTS 行。 */
async function makeProject(id, name, opts = {}) {
  const doc = { id, name, createdAt: t0, updatedAt: t0, nodes: { n1: { id: 'n1', type: 'text', data: { label: name + '节点' } } }, edges: [], tombstones: [] };
  await I.projectsPut({ id, name, doc });
  // 镜像目录：meta 有条目时用项目名文件夹，无条目时用 id（对应判据 9）
  const folder = opts.noMetaFolder ? id : name;
  const dir = path.join(DATA, 'projects', folder);
  fs.mkdirSync(path.join(dir, 'image'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'text'), { recursive: true });
  const imgRel = 'projects/' + folder + '/image/' + id + '-pic.png';
  const txtRel = 'projects/' + folder + '/text/' + id + '-sheet.md';
  fs.writeFileSync(path.join(DATA, imgRel), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(DATA, txtRel), '# 分镜\n');
  if (!opts.noMetaFolder) {
    // 让 ensureProjectFolder 建立 meta 映射（等价于真实运行时 Host 落盘时建立）
    I.ensureProjectFolder(id, name);
  } else {
    // 显式构造「meta 无 folder 条目」：先清掉可能已写入的条目
    const meta = I.readDataRootMeta();
    meta.projects = meta.projects.filter((p) => p.id !== id);
    fs.writeFileSync(path.join(DATA, 'canvas.meta.json'), JSON.stringify(meta), 'utf8');
  }
  await I.dbAssetCreate({ id: id + '_a1', projectId: id, kind: 'image', mime: 'image/png', name: name + '图片', rel: imgRel, size: 2048, prompt: '内景 便利店', createdAt: t0 });
  await I.dbAssetCreate({ id: id + '_a2', projectId: id, kind: 'text', mime: 'text/markdown', name: name + '分镜表', rel: txtRel, size: 8, text: '# 分镜', prompt: name, createdAt: t0 });
  return { id, name, dir, imgRel, txtRel, folder };
}

const ftsCount = () => db.prepare('SELECT COUNT(*) AS n FROM assets_fts').get().n;
const assetCount = () => db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
const ftsHit = (kw) => {
  try { return db.prepare('SELECT COUNT(*) AS n FROM assets_fts WHERE assets_fts MATCH ?').get(kw).n; } catch { return -1; }
};
const hasRow = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id).n;

// ---------- 前置：一个旁观项目（判据 2 用） ----------
const bystander = await makeProject('p_keep', '旁观项目');
const bystanderStats = countFiles(bystander.dir);
ok(bystanderStats.n === 2, '前置失败：旁观项目应有 2 个文件，实际 ' + bystanderStats.n);

// ---------- 判据 1/2/3/7/8/10：canvasDeleteProject（对话侧入口） ----------
{
  const p = await makeProject('p_del1', '待删项目');
  const before = countFiles(p.dir);
  ok(before.n === 2, '前置失败：待删项目应有 2 个文件');
  const objSha = 'a'.repeat(64); // 本项目独占的 sha 对象
  const objAbs = I.objectAbsFor(DATA, objSha);
  fs.mkdirSync(path.dirname(objAbs), { recursive: true });
  fs.writeFileSync(objAbs, 'OBJ');
  await I.dbAssetCreate({ id: 'p_del1_a3', projectId: 'p_del1', kind: 'image', mime: 'image/png', name: '独享参考图', sha: objSha, size: 3, createdAt: t0 });

  const ftsBefore = ftsHit('待删项目');
  ok(ftsBefore > 0, '前置失败：删除前 FTS 应能命中待删项目资产');

  const res = await I.canvasDeleteProject({ projectId: 'p_del1' });
  ok(res.ok === true, 'canvasDeleteProject 返回失败');
  ok(res.disk && typeof res.disk === 'object', '返回值未带磁盘清理结果（失败不可见）');

  // 判据 1：目录消失
  ok(!fs.existsSync(p.dir), '判据1：删除后镜像目录仍存在 ' + p.dir);
  // 判据 2：旁观项目不变
  const after = countFiles(bystander.dir);
  ok(after.n === bystanderStats.n && after.bytes === bystanderStats.bytes, '判据2：旁观项目文件数/字节被改动');
  // 判据 3：无悬挂引用
  ok(!fs.existsSync(objAbs), '判据3：本项目独占的 CAS 对象未回收');
  ok(hasRow('assets', 'p_del1_a1') === 0 && hasRow('projects', 'p_del1') === 0, '判据3：DB 仍有该 id 残留行');
  // 判据 7：FTS 无残留
  ok(ftsHit('待删项目') === 0, '判据7：删除后 FTS 仍命中该项目资产（MATCH 命中 ' + ftsHit('待删项目') + ' 条）');
  // 判据 10：表级等值
  ok(ftsCount() === assetCount(), '判据10：assets_fts(' + ftsCount() + ') != assets(' + assetCount() + ')');
  // 判据 5：幂等
  let again = null;
  try { again = await I.canvasDeleteProject({ projectId: 'p_del1' }); } catch (e) { again = { error: String((e && e.message) || e) }; }
  ok(again && again.ok === true, '判据5：重复删除未幂等成功：' + JSON.stringify(again));
}

// ---------- 判据 1/8：projectsDelete（客户端侧入口） ----------
{
  const p = await makeProject('p_del2', '待删项目二');
  const res = await I.projectsDelete({ id: 'p_del2' });
  ok(res.ok === true, 'projectsDelete 返回失败');
  ok(!fs.existsSync(p.dir), '判据8：projectsDelete 未清理镜像目录 ' + p.dir);
  ok(ftsHit('待删项目二') === 0, '判据8：projectsDelete 未清理 FTS');
  ok(ftsCount() === assetCount(), '判据10：projectsDelete 后 FTS 与 assets 不等值');
}

// ---------- 判据 9：meta 无 folder 条目（目录名 = 项目 id） ----------
{
  const p = await makeProject('p_del3', '待删项目三', { noMetaFolder: true });
  ok(p.dir.endsWith('p_del3'), '前置失败：无 meta 条目时目录名应为项目 id');
  const res = await I.canvasDeleteProject({ projectId: 'p_del3' });
  ok(res.ok === true, 'judge9：删除返回失败');
  ok(!fs.existsSync(p.dir), '判据9：meta 无 folder 条目时目录仍残留（静默跳过未修）');
}

// ---------- 判据 4：重建同名项目不读到旧文件 ----------
{
  const first = await makeProject('p_del4', '同名项目');
  await I.canvasDeleteProject({ projectId: 'p_del4' });
  ok(!fs.existsSync(first.dir), '判据4 前置：旧目录未删');
  const second = await makeProject('p_del5', '同名项目');
  const stats = countFiles(second.dir);
  ok(stats.n === 2, '判据4：重建同名项目后目录里出现了旧文件（应有且仅有 2 个新文件，实际 ' + stats.n + '）');
  // 同一个物理文件夹被复用，故直接按文件名断言：旧项目的产物不得残留
  const oldImg = path.join(second.dir, 'image', 'p_del4-pic.png');
  const oldTxt = path.join(second.dir, 'text', 'p_del4-sheet.md');
  ok(!fs.existsSync(oldImg) && !fs.existsSync(oldTxt), '判据4：重建同名项目后仍能读到旧项目的产物文件');
  ok(fs.existsSync(path.join(second.dir, 'image', 'p_del5-pic.png')), '判据4：新项目产物未落盘（前置失败）');
  // 收尾：清掉
  await I.canvasDeleteProject({ projectId: 'p_del5' });
}

// ---------- 判据 10 最终态 ----------
ok(ftsCount() === assetCount(), '判据10（终态）：assets_fts(' + ftsCount() + ') != assets(' + assetCount() + ')');
// 旁观项目仍健在
ok(!!(await I.projectsGet({ id: 'p_keep' })), '旁观项目被误删');
ok(fs.existsSync(bystander.dir), '旁观项目目录被误删');

// ---------- 判据 11 路径逃逸防护（删除入口的 projectId 是外部输入） ----------
// removeDataRootProject 的候选目录 = meta.folder / 原始 pid，旧实现 path.join(root,'projects',x) 后
// 直接 rmrf：projectId 含 .. 时会删掉数据根之外的目录。守卫：resolve 后必须仍在 <dataRoot>/projects 内。
{
  const decoy = path.join(SANDBOX, 'decoy-witness');
  fs.mkdirSync(decoy, { recursive: true });
  fs.writeFileSync(path.join(decoy, 'keep.txt'), 'do not delete');
  const outside = path.join(SANDBOX, 'outside-target');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'must survive');
  // 数据根 = <SANDBOX>/data；projects/<pid>/../.. 解析回 <SANDBOX>，outside-target 正好在逃逸路径上
  const r1 = I.removeDataRootProject('../outside-target');
  ok(fs.existsSync(path.join(outside, 'victim.txt')), '判据11a：.. 穿越把数据根外的文件删了（路径逃逸）');
  ok((r1.errors || []).some((e) => /拒绝|数据根/.test(e)), '判据11b：拒绝时应有可读错误：' + JSON.stringify(r1.errors));
  // 绝对路径注入同样拒绝
  const r2 = I.removeDataRootProject(outside);
  ok(fs.existsSync(path.join(outside, 'victim.txt')), '判据11c：绝对路径注入未得逞');
  // pid='.'：resolve(projects/.) 恰等于 projects 本身 → 绝不能把整个 projects 目录当删除目标
  const projectsRoot = path.join(DATA, 'projects');
  ok(fs.existsSync(bystander.dir), '判据11f 前置：旁观项目目录在删除尝试前存在');
  const r4 = I.removeDataRootProject('.');
  ok(fs.existsSync(projectsRoot), "判据11f：pid='.' 不得清空整个 projects 目录");
  ok(fs.existsSync(bystander.dir), "判据11g：pid='.' 后旁观项目目录仍健在（未被连带删除）");
  ok((r4.errors || []).some((e) => /拒绝|数据根/.test(e)), "判据11h：pid='.' 应被拒绝并给出可读错误：" + JSON.stringify(r4.errors));
  // 守卫不能误伤正常删除
  fs.mkdirSync(path.join(DATA, 'projects', 'p_trav', 'image'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'projects', 'p_trav', 'image', 'a.png'), Buffer.alloc(64, 1));
  const r3 = I.removeDataRootProject('p_trav');
  ok(r3.removed === true && !fs.existsSync(path.join(DATA, 'projects', 'p_trav')), '判据11d：守卫未误伤正常目录删除');
  ok(fs.existsSync(path.join(decoy, 'keep.txt')), '判据11e：前置有效性——无关目录始终健在');
}

I.closeDb();
try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
if (errs.length) {
  console.error('✗ BLK-01 回归未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ BLK-01 回归通过：两条删除入口都清镜像目录 + FTS 等值，meta 缺条目时回退项目 id，重建同名项目无旧文件');
process.exit(0);
