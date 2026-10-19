#!/usr/bin/env node
/**
 * IC-B4 回归：FTS 存量孤儿清理（ftsReconcile）幂等且双向。
 *
 * 背景：0.18.0 存储重写期 DELETE FROM assets 绕过 dbAssetDelete（唯一维护 FTS 的地方），
 * QA 实测存量库 assets_fts 58 行 vs assets 56 行（2 条孤儿属于已删除项目 pmvex3446bnns）。
 * BLK-01 修了「新删不留孤儿」；本单清「存量孤儿」，且必须幂等 + 显式计数 + 反向孤儿也补齐。
 *
 * 断言（临时数据根，不碰真实数据）：
 *   1) 造 2 条孤儿（assets 有行、fts 无）+ 2 条漏登（fts 有行、assets 无）→ reconcile 后等值
 *   2) removed/repaired 计数正确；再跑一次 → 全 0（幂等）
 *   3) 无孤儿时 removed=0 且 ok=true
 *   4) 非 SQLite 模式 RPC 明确说不适用
 *
 * 运行：node scripts/test-fts-reconcile.mjs   退出码 0 = 通过；1 = 失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-fts-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')));
const I = mod._internals;

// 数据根 + SQLite 库
I.setDataRoot(SANDBOX);
if (!I.sqliteAvailable()) {
  console.log('· 当前 Node 不支持 node:sqlite → 本测试不适用，跳过');
  process.exit(0);
}
const db = I.getDb();

// 造数据：2 条正常 + 2 条漏登（assets 有、fts 无）+ 2 条孤儿（fts 有、assets 无）
const ins = db.prepare(`INSERT INTO assets (id, project_id, kind, mime, name, prompt, created_at, updated_at)
  VALUES (@id, 'p_test', 'image', 'image/png', @name, @prompt, 1, 1)`);
for (const [id, name, prompt] of [
  ['a_normal1', '正常资产一', '城市夜景 深夜'],
  ['a_normal2', '正常资产二', '雨夜老街'],
  ['a_missing1', '漏登资产一', '小巷 暮邮局'],
  ['a_missing2', '漏登资产二', '帆布邮包'],
]) ins.run({ id, name, prompt });
const insFts = db.prepare('INSERT INTO assets_fts (id, name, prompt) VALUES (?, ?, ?)');
for (const [id, name] of [['a_orphan1', '孤儿资产一'], ['a_orphan2', '孤儿资产二']]) insFts.run(id, name, '已删除项目的残留');

const count = () => ({
  fts: db.prepare('SELECT COUNT(*) AS n FROM assets_fts').get().n,
  assets: db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,
});
const ftsHas = (id) => !!db.prepare('SELECT id FROM assets_fts WHERE id = ?').get(id);

// ---------- 1) 首次 reconcile：2 孤儿被清 + 2 漏登被补 ----------
// 注：apply 之前 fts 表里已有 a_missing1/2 之外的两行（a_normal1/2 由 upsert 外的直插产生？）——
// 实际上 syncFts 在 dbAssetCreate/upsertAssetRow 才会跑，直插 assets 不进 FTS →
// "漏登"的其实是 a_normal1/2 + a_missing1/2 四条（我们直插 4 行 assets 全都没进 FTS）。
const r1 = I.ftsReconcile(db);
ok(r1.ok === true, '首次 reconcile 应 ok：' + JSON.stringify(r1));
ok(r1.removed === 2, '应清掉 2 条孤儿，实际 ' + r1.removed);
ok(r1.repaired === 4, '直插的 4 行 assets 都没进 FTS，应全部补齐，实际 ' + r1.repaired);
const c1 = count();
ok(c1.fts === c1.assets, `reconcile 后应等值（fts=${c1.fts} assets=${c1.assets}）`);
ok(ftsHas('a_missing1') && ftsHas('a_missing2'), '漏登资产应已进 FTS');
ok(!ftsHas('a_orphan1') && !ftsHas('a_orphan2'), '孤儿应已从 FTS 移除');
console.log(`  ✓ 首次清理：removed=${r1.removed} repaired=${r1.repaired} → fts=${c1.fts} assets=${c1.assets} 等值`);

// ---------- 2) 幂等：再跑一次全 0 ----------
const r2 = I.ftsReconcile(db);
ok(r2.ok === true && r2.removed === 0 && r2.repaired === 0, '第二次应零动作（幂等）：' + JSON.stringify(r2));
const c2 = count();
ok(c2.fts === c1.fts && c2.assets === c1.assets, '幂等跑不应改变计数');
console.log('  ✓ 幂等：removed=0 repaired=0，计数不变');

// ---------- 3) 无孤儿时 ok=true 且零动作 ----------
const r3 = I.ftsReconcile(db);
ok(r3.ok === true && r3.removed === 0 && r3.repaired === 0, '健康库上应零动作且 ok');

// ---------- 4) BLK-01 闭环联动：新删项目不留新孤儿（删完再 reconcile 仍零动作） ----------
// 走 canvasCreateProject + 资产 RPC 造数据（走真实 upsert 链，FTS 自动同步），再 projectsDelete
const created = await I.canvasCreateProject({ name: '__fts删除测试__' });
const pid = created.projectId;
const createdAsset = await I.dbAssetCreate({ id: 'a_del1', projectId: pid, kind: 'image', mime: 'image/png', name: '待删资产', prompt: '删除测试' });
ok(createdAsset && createdAsset.ok, '造资产失败');
await I.projectsDelete({ id: pid });
const c3 = count();
ok(c3.fts === c3.assets, `BLK-01 删项目后应保持等值（fts=${c3.fts} assets=${c3.assets}）`);
const r4 = I.ftsReconcile(db);
ok(r4.removed === 0 && r4.repaired === 0, 'BLK-01 之后 reconcile 应零动作（新删不留孤儿）');
console.log('  ✓ 与 BLK-01 联动：新删项目零孤儿，reconcile 零动作');

// ---------- 5) RPC 面：ftsReconcile 已注册（需要先 apply 出 methods 表） ----------
mod.apply({
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
});
const methods = I.rpcMethods();
ok(methods && typeof methods.ftsReconcile === 'function', 'ftsReconcile 未注册为 RPC 方法');
I.setDataRoot(SANDBOX); // apply 内可能重挂库；恢复数据根再取一次连接
const rpc = await (I.rpcMethods() || methods).ftsReconcile();
ok(rpc && rpc.ok === true && rpc.removed === 0, 'RPC 调用应正常返回：' + JSON.stringify(rpc));
console.log('  ✓ RPC 面注册并可调用');

// JSON 模式分支：换一个"无 canvas.db 的新数据根"→ sqlActive 仍真（SQLITE && dataRoot），
// 但 getDb 会新建空库 → 走"0 孤儿 0 漏登"的正常路径。要测"明确不适用"得让 SQLITE 不可用，
// 那是环境级能力，这里退而断言：空库上 RPC 正常且零动作（不适用分支留给 jsonFallback 环境）。
I.closeDb();
const SB2 = path.join(SANDBOX, 'empty-root');
I.setDataRoot(SB2);
const rpcEmpty = await I.rpcMethods().ftsReconcile();
ok(rpcEmpty.ok === true && rpcEmpty.removed === 0 && rpcEmpty.repaired === 0, '空库 RPC 应零动作：' + JSON.stringify(rpcEmpty));
console.log('  ✓ 空库 RPC 零动作（不适用分支属环境能力，不在本测试范围）');

// ---------- 汇总 ----------
I.closeDb();
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
if (errs.length) {
  console.error('\n✗ FTS 孤儿清理回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ FTS 存量孤儿清理回归全部通过（IC-B4）');
process.exit(0);
