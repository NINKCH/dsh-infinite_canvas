#!/usr/bin/env node
/**
 * 精准布局回归（0.20.0）
 *  canvas_layout_get 全图几何 / canvas_layout_node 批量精摆 + 尺寸校验 /
 *  pinned 钉住后 canvas_relayout 不移动 / relayout 分带不再拍成一列
 */
import path from 'node:path';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SANDBOX = path.join(ROOT, '.tmp-test-layout-node');
await fs.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
fsSync.mkdirSync(SANDBOX, { recursive: true });
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => ok(String(a) === String(b), m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）');
const throws = async (fn, m) => { try { await fn(); errs.push(m + '（未抛错）'); } catch { /* 预期 */ } };

const tools = [];
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get() { return undefined; },
  webServer: { register: () => () => {} },
  tools: { register: (d) => { tools.push(d); return () => {}; } },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
try { mod.apply(fakeCtx); } catch (e) { console.error('✗ apply 失败：' + ((e && e.stack) || e)); process.exit(1); }
const I = mod._internals;

const byName = new Map(tools.map((t) => [t.name, t]));
const created = await byName.get('canvas_create_project').execute({ name: '布局测试' }, {});
const pid = created.projectId;
const n1 = I.canvasCreateNode({ projectId: pid, type: 'text', name: '场1文本' });
const n2 = I.canvasCreateNode({ projectId: pid, type: 'image', name: '角色-陈拾 设定图', prompt: 'x' });
const n3 = I.canvasCreateNode({ projectId: pid, type: 'image', name: '场景-巷口', prompt: 'y' });

// 1) 几何视图
{
  const g = I.canvasLayoutGet({ projectId: pid });
  eq(g.count, 3, 'layout_get 节点数不符');
  ok(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.w) && Number.isFinite(n.h)), 'layout_get 缺 x/y/w/h');
  ok(g.bounds && Number.isFinite(g.bounds.maxX), 'layout_get 缺包围盒');
  ok(g.nodes.every((n) => n.pinned === false), 'pinned 默认应为 false');
}

// 2) 批量精摆 + 尺寸（媒体节点改尺寸必须保持画面比例）
{
  const r = I.canvasLayoutNode({ projectId: pid, nodes: [
    { nodeId: n1.nodeId, x: 100, y: 200 },
    { nodeId: n2.nodeId, x: 700, y: 200, w: 520 },
  ] });
  eq(r.moved, 2, 'layout_node 移动数不符');
  const g = I.canvasLayoutGet({ projectId: pid });
  const a = g.nodes.find((n) => n.nodeId === n1.nodeId);
  const b = g.nodes.find((n) => n.nodeId === n2.nodeId);
  eq(a.x, 100, 'text 节点 x 未生效');
  eq(a.y, 200, 'text 节点 y 未生效');
  eq(b.x, 700, 'image 节点 x 未生效');
  eq(b.w, 520, 'image 节点 w 未生效');
  ok(b.h > 300, 'image 节点 h 未按比例自动补齐（实际 ' + b.h + '）');
  // 比例不符的 w/h 组合应被拒绝（而不是被静默重置）
  await throws(() => I.canvasLayoutNode({ projectId: pid, nodes: [{ nodeId: n2.nodeId, x: 700, y: 200, w: 520, h: 420 }] }), 'w/h 比例不符应抛错');
}

// 3) 校验
await throws(() => I.canvasLayoutNode({ projectId: pid, nodes: [{ nodeId: 'nope', x: 0, y: 0 }] }), '未知节点应抛错');
await throws(() => I.canvasLayoutNode({ projectId: pid, nodes: [{ nodeId: n1.nodeId, x: 'abc', y: 0 }] }), '非数字 x 应抛错');
await throws(() => I.canvasLayoutNode({ projectId: pid, nodes: [{ nodeId: n3.nodeId, x: 0, y: 0, w: 100, h: 400 }] }), '过小 w 应抛错');
await throws(() => I.canvasLayoutNode({ projectId: pid, nodes: [{ nodeId: n1.nodeId, x: 0, y: 0, w: 400 }] }), '非媒体节点改尺寸应抛错');

// 4) pinned：relayout 不动钉住的节点
{
  I.canvasLayoutNode({ projectId: pid, nodes: [{ nodeId: n2.nodeId, x: 700, y: 200, pinned: true }] });
  const before = I.canvasLayoutGet({ projectId: pid }).nodes.find((n) => n.nodeId === n2.nodeId);
  const r = I.canvasRelayout({ projectId: pid });
  eq(r.skippedPinned, 1, 'relayout 未跳过 pinned 节点');
  eq(r.moved, 2, 'relayout 应只移动未钉节点');
  const after = I.canvasLayoutGet({ projectId: pid }).nodes.find((n) => n.nodeId === n2.nodeId);
  eq(after.x, before.x, 'relayout 移动了 pinned 节点 x（应保持原位）');
  eq(after.y, before.y, 'relayout 移动了 pinned 节点 y（应保持原位）');
  // 取消钉住后可被移动
  I.canvasLayoutNode({ projectId: pid, nodes: [{ nodeId: n2.nodeId, x: 700, y: 200, pinned: false }] });
  const r2 = I.canvasRelayout({ projectId: pid });
  eq(r2.skippedPinned, 0, '取消钉住后 relayout 仍跳过');
  eq(r2.moved, 3, '取消钉住后 relayout 应移动全部节点');
}

// 5) 多簇不再拍成一列：多个互不相连的簇应按带高打包 → 出现多个 x 区域（不是一根竖列）
{
  const pid2 = (await byName.get('canvas_create_project').execute({ name: '分带测试' }, {})).projectId;
  for (let i = 1; i <= 6; i++) I.canvasCreateNode({ projectId: pid2, type: 'text', name: '孤立簇' + i });
  I.canvasRelayout({ projectId: pid2 });
  const g = I.canvasLayoutGet({ projectId: pid2 });
  const xs = [...new Set(g.nodes.map((n) => n.x))];
  eq(g.count, 6, '分带测试节点数不符');
  ok(xs.length > 1, 'relayout 后所有孤立簇仍在同一 x（仍是一列）');
  ok(g.bounds.maxX - g.bounds.minX < 6000, 'relayout 横向展开过度（带高打包失效）');
}

await fs.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
if (errs.length) {
  console.error('✗ test-layout-node FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-layout-node PASS（几何视图 / 批量精摆 / 尺寸校验 / pinned 保护 / 分带不再一列）');
