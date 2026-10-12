// 针对用户实测故障的定向复验：canvas_node_status 在"无产物"的剧本/分镜节点上
// （正是此前每次轮询必炸的场景）必须返回干净的无损 JSON。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-verify-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const tools = [];
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: () => () => {} },
  tools: { register: (def) => { tools.push(def); return () => {}; } },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
mod.apply(fakeCtx);
const byName = new Map(tools.map((d) => [d.name, d]));

// 无损校验（与 DSH snapshotJsonValue 同规则：任何层级 undefined/NaN/Infinity 即非法）
function hasLossy(value, path) {
  if (value === undefined) return path;
  if (typeof value === 'number' && !Number.isFinite(value)) return path;
  if (typeof value === 'function' || typeof value === 'symbol') return path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const hit = hasLossy(value[i], path + '[' + i + ']'); if (hit) return hit; }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { const hit = hasLossy(v, path + '.' + k); if (hit) return hit; }
  }
  return null;
}

const created = await byName.get('canvas_create_project').execute({ name: '验证项目', scriptText: '本节创作提示词', nodeName: '第一节剧本' }, {});
const projectId = created.projectId;
// 模拟用户实测：剧本成稿 + 分镜表（connectFrom 建连线），两节点都没有产物
const w = await byName.get('canvas_write_node').execute({ projectId, nodeId: created.nodeId, target: 'output', text: '第一节剧本正文……', overwrite: true }, {});
void w;
const sb = await byName.get('canvas_create_node').execute({ projectId, type: 'storyboard', name: '第一节分镜表' }, {});
const shotsJson = JSON.stringify({ shots: Array.from({ length: 14 }, (_, i) => ({ title: '镜' + (i + 1), visual: '中景，画面描述……', motion: '缓推', characters: ['陈拾'], scene: '褶皱巷', props: [], duration: 5 })) });
await byName.get('canvas_write_node').execute({ projectId, nodeId: sb.nodeId, target: 'output', text: shotsJson, overwrite: true }, {});

// 连线必须存在（用户最在意的工作流）
const doc = await mod._internals.projectsGet({ id: projectId });
const edge = (doc.edges || []).find((e) => e.toNode === sb.nodeId && e.toPort === 'script' && e.fromNode === created.nodeId);
if (!edge) errs.push('剧本→分镜表的自动连线不存在');

// 两个节点分别查询 status：结果必须无损（此前 assetId: undefined 让每次轮询必炸）
for (const [label, nodeId] of [['剧本节点', created.nodeId], ['分镜表节点', sb.nodeId]]) {
  const r = await byName.get('canvas_node_status').execute({ projectId, nodeId }, {});
  const hit = hasLossy(r, '$');
  if (hit) errs.push(`canvas_node_status（${label}）结果含非法值 ${hit} → 工具侧解析错误复发`);
  if (r && typeof r.status !== 'string') errs.push(`canvas_node_status（${label}）status 不是字符串`);
}
// bible 写入 → 读回一致（用户实测"对话说补全了、画布为空"链路的 Host 侧）
await byName.get('canvas_update_bible').execute({
  projectId,
  bible: { worldview: '测试世界观', style: '写实', characters: [{ name: '陈拾', desc: '26 岁邮递员' }], scenes: [], props: [] },
}, {});
const b = await mod._internals.canvasGetBible({ projectId });
if (!b.bible || b.bible.worldview !== '测试世界观') errs.push('设定集写入后读回不一致');
if (!doc.bibleUpdatedAt && !b.bibleUpdatedAt) errs.push('设定集缺少同步时间戳');

// Host 侧墓碑语义：删除记墓碑 → 撤销恢复（节点随推送回来）必须清墓碑，
// 否则恢复的节点被 Host dead 过滤永久丢弃（"Ctrl+Z 之后节点又消失"）
const undoNode = { id: 'n_undo', type: 'text', x: 0, y: 0, w: 280, h: 96, data: { status: 'idle', text: '待撤销的节点' } };
await mod._internals.projectsPut({ id: projectId, name: '验证项目', doc: { nodes: { [undoNode.id]: undoNode }, edges: [] } }, {});
let d1 = await mod._internals.projectsGet({ id: projectId });
if (!d1.nodes[undoNode.id]) errs.push('前置失败：n_undo 未落库');
// 用户删除（推送缺节点 + 墓碑）
await mod._internals.projectsPut({ id: projectId, name: '验证项目', doc: { nodes: {}, edges: [], tombstones: [undoNode.id] } }, {});
d1 = await mod._internals.projectsGet({ id: projectId });
if (d1.nodes[undoNode.id]) errs.push('墓碑未生效：删除的节点仍在 Host 文档里');
if (!(d1.tombstones || []).includes(undoNode.id)) errs.push('Host 未保留节点墓碑');
// 陈旧推送（删除前的快照：节点在场但无 ts）不得借"在场"清墓碑复活
await mod._internals.projectsPut({ id: projectId, name: '验证项目', doc: { nodes: { [undoNode.id]: undoNode }, edges: [], tombstones: [] } }, {});
d1 = await mod._internals.projectsGet({ id: projectId });
if (d1.nodes[undoNode.id]) errs.push('陈旧推送（无 ts）把墓碑节点复活了');
// 用户 Ctrl+Z 恢复（节点随推送回来，且推送带发送时刻 ts）→ 墓碑必须被撤掉、节点必须保留
await mod._internals.projectsPut({ id: projectId, name: '验证项目', doc: { ts: Date.now(), nodes: { [undoNode.id]: undoNode }, edges: [], tombstones: [] } }, {});
d1 = await mod._internals.projectsGet({ id: projectId });
if (!d1.nodes[undoNode.id]) errs.push('撤销恢复的节点被 Host 永久丢弃（墓碑未随推送清掉）');
if ((d1.tombstones || []).includes(undoNode.id)) errs.push('撤销恢复后 Host 仍留旧墓碑（下轮同步会把节点再删掉）');
// 边墓碑同理：删除记边墓碑 → 恢复随推送回来必须清
const undoEdge = { id: 'e_undo', fromNode: undoNode.id, fromPort: 'out', toNode: undoNode.id, toPort: 'in' };
await mod._internals.projectsPut({ id: projectId, name: '验证项目', doc: { nodes: { [undoNode.id]: undoNode }, edges: [undoEdge], tombstones: [] } }, {});
await mod._internals.projectsPut({ id: projectId, name: '验证项目', doc: { nodes: { [undoNode.id]: undoNode }, edges: [], tombstones: [], edgeTombstones: [undoEdge.id] } }, {});
d1 = await mod._internals.projectsGet({ id: projectId });
if ((d1.edgeTombstones || []).includes(undoEdge.id)) {
  await mod._internals.projectsPut({ id: projectId, name: '验证项目', doc: { ts: Date.now(), nodes: { [undoNode.id]: undoNode }, edges: [undoEdge], tombstones: [], edgeTombstones: [] } }, {});
  d1 = await mod._internals.projectsGet({ id: projectId });
  if ((d1.edgeTombstones || []).includes(undoEdge.id)) errs.push('撤销恢复后 Host 仍留旧边墓碑');
  if (!d1.edges.some((e) => e.id === undoEdge.id)) errs.push('撤销恢复的边被 Host 永久丢弃（边墓碑未随推送清掉）');
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
if (errs.length) {
  console.error('✗ 定向复验未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 定向复验通过：剧本/分镜节点轮询返回无损 JSON（不再"解析错误"）、自动连线存在、设定集读写一致、删除/撤销恢复的墓碑语义正确');
process.exit(0);
