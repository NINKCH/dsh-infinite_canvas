#!/usr/bin/env node
/**
 * IC-B2 回归：删除项目时清理其 ArtCraft 后期目录（projects/<folder>/craft）。
 *
 * 背景：BLK-01 只清资产镜像与 FTS；craft/（PhotoCraft 调色、FilmCraft 导出等后期产物）
 * 不在其中。slug 时代它由客户端 localStorage 生成、Host 不知情 → 删不掉。
 * BLK-02 之后目录基准统一为 <数据根>\projects\<物理文件夹>\，Host 能定位了。
 * 本单：删除项目时由客户端触发 Host RPC projectCraftRemove，只删这一个子目录。
 *
 * 断言（临时数据根）：
 *   1) craft/ 存在 → 删项目后消失；其他项目 craft/ 逐字节不变
 *   2) 目录不存在 → 幂等成功（removed=false, existed=false）
 *   3) 无数据根 → ok=false 且有可读错误
 *   4) 只删 craft 子目录：项目镜像目录本体保留（BLK-01 的职责不受影响——本 RPC 独立调用）
 *
 * 运行：node scripts/test-craft-cleanup.mjs   退出码 0 = 通过；1 = 失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-craftclean-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const noop = () => {};

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')));
const I = mod._internals;
mod.apply({ effect(fn) { fn(); return () => {}; }, get: () => undefined, webServer: { register: () => () => {} }, tools: { register: () => () => {} } });

I.setDataRoot(SANDBOX);
const rpc = () => I.rpcMethods();

// ---------- 造数据：项目 A（有 craft 产物 + 资产镜像）、项目 B（只有 craft，作对照） ----------
const docA = { id: 'p_a', name: '项目A', createdAt: 1, updatedAt: 2, nodes: {}, edges: [] };
const docB = { id: 'p_b', name: '项目B', createdAt: 1, updatedAt: 2, nodes: {}, edges: [] };
await rpc().projectsPut({ id: docA.id, name: docA.name, doc: docA }, {});
await rpc().projectsPut({ id: docB.id, name: docB.name, doc: docB }, {});

const dirA = path.join(SANDBOX, 'projects', '项目A');
const dirB = path.join(SANDBOX, 'projects', '项目B');
fs.mkdirSync(path.join(dirA, 'craft', 'out'), { recursive: true });
fs.writeFileSync(path.join(dirA, 'craft', 'timeline.xml'), '<x/>', 'utf8');
fs.writeFileSync(path.join(dirA, 'craft', 'out', 'final.mp4'), Buffer.alloc(1024, 7));
fs.mkdirSync(path.join(dirA, 'image'), { recursive: true });
fs.writeFileSync(path.join(dirA, 'image', 'ref.png'), Buffer.alloc(2048, 3));
fs.mkdirSync(path.join(dirB, 'craft', 'out'), { recursive: true });
fs.writeFileSync(path.join(dirB, 'craft', 'timeline.xml'), '<b/>', 'utf8');
const bBefore = fs.readFileSync(path.join(dirB, 'craft', 'timeline.xml'));

// ---------- 1) craft 存在：RPC 清掉它，其他不受影响 ----------
const r1 = await rpc().projectCraftRemove({ projectId: 'p_a' });
ok(r1.ok === true && r1.removed === true && r1.existed === true, '应有 craft 且被清掉：' + JSON.stringify(r1));
ok(!fs.existsSync(path.join(dirA, 'craft')), 'craft/ 应已消失');
ok(fs.existsSync(path.join(dirA, 'image', 'ref.png')), '资产镜像不应被波及（那是 BLK-01 的职责）');
ok(fs.existsSync(dirA), '项目目录本体不应被删');
ok(fs.existsSync(path.join(dirB, 'craft', 'timeline.xml')), '其他项目的 craft 不应被波及');
ok(Buffer.compare(fs.readFileSync(path.join(dirB, 'craft', 'timeline.xml')), bBefore) === 0, '其他项目 craft 文件应逐字节不变');
console.log('  ✓ 清理命中：craft 消失、资产镜像保留、对照项目逐字节不变');

// ---------- 2) 幂等：再清一次（目录已不存在） ----------
const r2 = await rpc().projectCraftRemove({ projectId: 'p_a' });
ok(r2.ok === true && r2.removed === false && r2.existed === false, '重复清理应幂等成功：' + JSON.stringify(r2));
console.log('  ✓ 幂等：existed=false 且 ok=true');

// ---------- 3) 走完整删除流程（projectsDelete → projectCraftRemove）后一切干净 ----------
fs.mkdirSync(path.join(dirA, 'craft'), { recursive: true });
fs.writeFileSync(path.join(dirA, 'craft', 'drama.fcproj'), '{}', 'utf8');
await I.projectsDelete({ id: 'p_a' });
const r3 = await rpc().projectCraftRemove({ projectId: 'p_a' });
ok(r3.ok === true, '项目删除后清理应成功（meta 条目已清，回退按 id）');
console.log('  ✓ 与 BLK-01 删除流程衔接');

// ---------- 4) 无数据根 → 明确失败（OBS-2：进程内重载，不硬依赖子进程） ----------
// 关键：必须在**设置 env 之前**（即 import 之前）就为第二个实例准备好空配置——CONFIG_PATH
// 是模块加载期常量，所以用「带唯一查询串的 URL」加载同一文件的全新实例，
// 实例化前把 process.env 指到空配置，实例内 dataRoot() 即读到无 dataRoot 的配置。
// spawn 受限的环境（QA 实测）因此不再假红；子进程只是曾经的实现手段，不是语义本身。
{
  const emptyCfg = path.join(SANDBOX, 'config-empty.json');
  fs.writeFileSync(emptyCfg, JSON.stringify({}), 'utf8');
  const savedEnv = { DSH_IC_PROJECTS_DIR: process.env.DSH_IC_PROJECTS_DIR, DSH_IC_CONFIG_PATH: process.env.DSH_IC_CONFIG_PATH };
  process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
  process.env.DSH_IC_CONFIG_PATH = emptyCfg;
  let r4 = null;
  try {
    const probeUrl = pathToFileURL(path.join(ROOT, 'index.js')).href + '?no-root-probe=' + Date.now();
    const mod2 = await import(probeUrl); // env 已指向空配置 → 实例内 CONFIG_PATH = 空配置
    mod2.apply({ effect(fn) { fn(); return () => {}; }, get: () => undefined, webServer: { register: () => () => {} }, tools: { register: () => () => {} } });
    r4 = await mod2._internals.rpcMethods().projectCraftRemove({ projectId: 'p_b' });
  } catch (e) {
    r4 = { ok: false, error: String((e && e.message) || e) };
  } finally {
    Object.assign(process.env, savedEnv); // 还原主进程 env（后续无用例，防御性还原）
  }
  ok(r4 && r4.ok === false && /未设置数据根目录/.test(r4.error || ''), '无数据根应明确失败：' + JSON.stringify(r4));
}
console.log('  ✓ 无数据根明确失败（进程内重载，受限环境不假红）');

// ---------- 汇总 ----------
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
if (errs.length) {
  console.error('\n✗ craft 目录清理回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ craft 目录清理回归全部通过（IC-B2）');
process.exit(0);
