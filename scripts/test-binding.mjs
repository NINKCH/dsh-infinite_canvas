#!/usr/bin/env node
/**
 * 会话↔画布绑定层契约测试（dev-only）：
 *  1) 绑定/读取 roundtrip：bindingSet 落 <项目家目录>/bindings.json；bindingsRead 容错
 *  2) 一会话一画布：会话换绑 = 旧条目移除
 *  3) 一画布一会话：活会话占用 → occupied 拒绝；死会话（孤儿）→ 覆盖
 *  4) 解绑：bindingClear 移除条目（幂等）
 *  5) 工作区项目：绑定落 <ws>/.infinite-canvas/bindings.json
 *  6) 非法入参：非法 projectId / 空 sessionId / 未知 canvasId 拒绝
 * 运行：node scripts/test-binding.mjs（退出码 0=通过；临时目录，不碰真实数据）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-binding-'));
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

await I.projectsPut({ id: 'bindP1', name: '绑定项目', doc: { nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } } });
const made = await I.canvasCreate({ projectId: 'bindP1', name: '第2集' });
const CID2 = made && made.canvasId;
const WS_DIR = path.join(SANDBOX, 'ws-bind');
const WS_APP = path.join(WS_DIR, '.infinite-canvas');
fs.mkdirSync(WS_APP, { recursive: true });
fs.writeFileSync(path.join(WS_APP, 'project.json'), JSON.stringify({ id: 'wsBind01', name: '工作区绑定项目', createdAt: 1700000000000, updatedAt: 1700000000000, nodes: {}, edges: [] }), 'utf8');
I.wsProjectsScan([{ id: 'ws-bbbb', path: WS_DIR, title: 'ws-bind', sessionIds: ['ses_a', 'ses_b'] }]);

const alive = (sid) => sid === 'ses_a' || sid === 'ses_b'; // ses_dead 不活着

// ---------------- 1) 绑定/读取 roundtrip ----------------
{
  const w = await I.bindingSet('bindP1', 'ses_a', null, alive);
  ok(w && w.ok, 'bindingSet 失败');
  const r = await I.bindingsRead('bindP1');
  ok(r && Array.isArray(r.bindings) && r.bindings.length === 1, 'bindingsRead 条目数不符');
  eq(r.bindings[0].sessionId, 'ses_a', '绑定条目 sessionId 不符');
  eq(r.bindings[0].canvasId, null, '默认画布绑定应存 null');
  ok(typeof r.bindings[0].boundAt === 'number', '缺 boundAt');
  const f = I.projectHomeDir('bindP1');
  ok(f && fs.existsSync(path.join(f, 'bindings.json')), '绑定文件未落项目家目录');
}

// ---------------- 2) 一会话一画布（换绑） ----------------
{
  const w = await I.bindingSet('bindP1', 'ses_a', CID2, alive);
  ok(w && w.ok, '换绑失败');
  const r = await I.bindingsRead('bindP1');
  eq(r.bindings.length, 1, '换绑后应仍一条');
  eq(r.bindings[0].canvasId, CID2, '换绑未生效');
}

// ---------------- 3) 占用/孤儿 ----------------
{
  const blocked = await I.bindingSet('bindP1', 'ses_b', CID2, alive);
  ok(blocked && blocked.ok === false && blocked.occupied === true, '活会话占用未被拒绝');
  ok(blocked && blocked.by === 'ses_a', '占用未回指占用者');
  const orphan = await I.bindingSet('bindP1', 'ses_b', CID2, () => false);
  ok(orphan && orphan.ok === true, '孤儿绑定（占用者已死）未被覆盖');
  const r = await I.bindingsRead('bindP1');
  eq(r.bindings[0].sessionId, 'ses_b', '孤儿覆盖未生效');
}

// ---------------- 4) 解绑（幂等） ----------------
{
  const c1 = await I.bindingClear('bindP1', 'ses_b');
  ok(c1 && c1.ok && c1.removed === true, '解绑失败');
  const c2 = await I.bindingClear('bindP1', 'ses_b');
  ok(c2 && c2.ok && c2.removed === false, '重复解绑应幂等 removed=false');
  const r = await I.bindingsRead('bindP1');
  eq(r.bindings.length, 0, '解绑后应空');
}

// ---------------- 5) 工作区项目绑定落位 ----------------
{
  const w = await I.bindingSet('wsBind01', 'ses_a', null, alive);
  ok(w && w.ok, '工作区项目绑定失败');
  ok(fs.existsSync(path.join(WS_APP, 'bindings.json')), '绑定未落 <ws>/.infinite-canvas/bindings.json');
  const raw = JSON.parse(fs.readFileSync(path.join(WS_APP, 'bindings.json'), 'utf8'));
  eq(raw.bindings[0].sessionId, 'ses_a', '工作区绑定文件内容不符');
  // 同工作区第二画布绑定占用检查
  const made2 = await I.canvasCreate({ projectId: 'wsBind01', name: '第2集' });
  const occ = await I.bindingSet('wsBind01', 'ses_b', null, alive);
  ok(occ && occ.ok === false && occ.occupied === true, '工作区项目占用检查失效');
  await I.bindingClear('wsBind01', 'ses_a');
  const ok2 = await I.bindingSet('wsBind01', 'ses_b', made2.canvasId, alive);
  ok(ok2 && ok2.ok, '解绑后换绑画布失败');
}

// ---------------- 6) 非法入参 ----------------
{
  const e1 = await I.bindingSet(' ../evil ', 'ses_a', null, alive);
  ok(e1 && e1.ok === false, '非法 projectId 未拒绝');
  const e2 = await I.bindingSet('bindP1', '', null, alive);
  ok(e2 && e2.ok === false, '空 sessionId 未拒绝');
  const e3 = await I.bindingSet('bindP1', 'ses_a', '不存在', alive);
  ok(e3 && e3.ok === false, '未知 canvasId 未拒绝');
}

// ---------------- 结果 ----------------
if (errs.length) {
  console.error('✗ test-binding FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-binding PASS');
