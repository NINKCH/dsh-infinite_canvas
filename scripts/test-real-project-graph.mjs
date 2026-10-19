// 用【真实项目图结构】验证 autoPrevVideoNode 的跨分镜表续帧查找（核心修复点）。
// 缺库/缺项目时跳过；数据目录用 DSH_IC_DATA_ROOT 覆盖。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = process.env.DSH_IC_DATA_ROOT || 'D:/data/canvas-data';
const DB_PATH = path.join(DATA_ROOT, 'canvas.db');
const PROJECT_ID = process.env.DSH_IC_PROJECT_ID || 'pmv54zuhu6zky';

if (!existsSync(DB_PATH)) {
  console.log('· 跳过真实项目图验证：未找到 ' + DB_PATH);
  process.exit(0);
}
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {
  console.log('· 跳过真实项目图验证：当前 Node 不支持 node:sqlite');
  process.exit(0);
}
let row = null;
try {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  row = db.prepare('SELECT doc FROM projects WHERE id = ?').get(PROJECT_ID);
  db.close();
} catch { row = null; }
if (!row) {
  console.log('· 跳过真实项目图验证：库里没有项目 ' + PROJECT_ID);
  process.exit(0);
}

const clientSrc = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const doc = JSON.parse(row.doc);
const graph = { nodes: doc.nodes, edges: doc.edges || [] };
const label = (id) => (graph.nodes[id] && graph.nodes[id].data && graph.nodes[id].data.label) || id;

// ---------- 2) 抽取待验证的纯函数 ----------
function grab(name) {
  const start = clientSrc.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  // 花括号配平
  let i = clientSrc.indexOf('{', start), depth = 0, end = -1;
  for (; i < clientSrc.length; i++) {
    if (clientSrc[i] === '{') depth++;
    else if (clientSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return clientSrc.slice(start, end);
}
const fnSrc = ['shotVisualText', 'shotContinuityPlan', 'shotContinuityBlock', 'storyboardContinuityNote', 'frameAnchorText', 'autoPrevVideoNode']
  .map(grab).join('\n\n');

const sandbox = new Function('S', 'PORTS', 'MULTI_INPUT_PORTS', fnSrc + `
  return { shotContinuityPlan, shotContinuityBlock, storyboardContinuityNote, frameAnchorText, autoPrevVideoNode };
`);
const S = { graph };
const api = sandbox(S, {}, new Set());

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------- 3) 场1..场6 的首镜规划 ----------
console.log('=== 各场首镜的段落规划（真实数据）===');
const sbs = Object.entries(graph.nodes).filter(([, n]) => n.type === 'storyboard')
  .sort((a, b) => (a[1].data.label || '').localeCompare(b[1].data.label || ''));
for (const [id, n] of sbs) {
  const shots = n.data.shots || [];
  const first = api.shotContinuityPlan(shots[0], null, 0);
  const prevEdge = graph.edges.find((e) => e.toNode === id && e.toPort === 'prev');
  console.log(`  ${n.data.label}: 首镜 seg=${first.seg} join=${first.join} chain=${first.chain} | prev 上游=${prevEdge ? label(prevEdge.fromNode) : '（无）'}`);
}

// ---------- 4) 关键验证：autoPrevVideoNode 能否跨分镜表找到上一段视频 ----------
console.log('\n=== 自动续帧「找上一段视频」（核心修复点）===');
const videoNodes = Object.entries(graph.nodes).filter(([, n]) => n.type === 'video-gen');
const byLabel = new Map(videoNodes.map(([id, n]) => [n.data.label || id, { ...n, id }]));
console.log('  已存在的视频节点:', videoNodes.map(([id, n]) => `${n.data.label}(asset=${n.data.assetId ? '有' : '无'})`).join(', '));

const v1 = byLabel.get('第一节-场1视频');
const v2 = byLabel.get('第一节-场2视频');
if (v1) {
  const p = api.autoPrevVideoNode(v1);
  console.log('  场1视频 → 上一段:', p ? (p.data.label || p.id) : 'null（首段，应为 null）');
  ok(p === null, '场1视频是首段，不应找到上一段');
}
if (v2) {
  const p = api.autoPrevVideoNode(v2);
  const name = p ? (p.data.label || p.id) : null;
  console.log('  场2视频 → 上一段:', name, '（期望 第一节-场1视频）');
  ok(name === '第一节-场1视频', '场2视频应通过 frame 连线/prev 链找到场1视频，实际: ' + name);
}

// ---------- 5) 模拟【场3视频】节点：只有 prev 链、没有 frame 线时的表现 ----------
console.log('\n=== 模拟场3视频（真实 prev 链，无 frame 线）===');
const sb3Id = sbs.find(([, n]) => (n.data.label || '').includes('场3'))?.[0];
const fake3 = { id: 'fake_v3', type: 'video-gen', x: 1000, y: 1000, data: { label: '第一节-场3视频', assetId: null } };
graph.nodes[fake3.id] = fake3;
graph.edges.push({ id: 'fake_e1', fromNode: sb3Id, fromPort: 'out', toNode: fake3.id, toPort: 'prompt' });
const p3 = api.autoPrevVideoNode(fake3);
const p3name = p3 ? (p3.data.label || p3.id) : null;
console.log('  场3视频 → 上一段:', p3name, '（期望沿 prev 链找到 第一节-场2视频）');
ok(p3name === '第一节-场2视频', '场3视频应沿 prev 链找到场2视频（这是修复前不可达的路径），实际: ' + p3name);

// 再模拟场4（场3还没生成 → 应继续上溯到场2）
const sb4Id = sbs.find(([, n]) => (n.data.label || '').includes('场4'))?.[0];
const fake4 = { id: 'fake_v4', type: 'video-gen', x: 1000, y: 1200, data: { label: '第一节-场4视频' } };
graph.nodes[fake4.id] = fake4;
graph.edges.push({ id: 'fake_e2', fromNode: sb4Id, fromPort: 'out', toNode: fake4.id, toPort: 'prompt' });
const p4 = api.autoPrevVideoNode(fake4);
const p4name = p4 ? (p4.data.label || p4.id) : null;
console.log('  场4视频 → 上一段:', p4name, '（期望 第一节-场2视频——场3未生成则继续上溯）');
ok(p4name === '第一节-场2视频', '场4应上溯找到已生成的最近上游片段，实际: ' + p4name);

// ---------- 6) 旧数据（无 tail/seg）的兜底行为 ----------
console.log('\n=== 旧分镜（无 tail/seg）的兜底 ===');
const sb1 = sbs.find(([, n]) => (n.data.label || '').includes('场1'))?.[1];
const shots1 = sb1.data.shots || [];
const plans = shots1.map((s, i) => api.shotContinuityPlan(s, shots1[i - 1], i));
console.log('  seg:', plans.map((p) => p.seg).join(' / '));
ok(plans[0].seg === 'opening', '无 tail/seg 的旧分镜首镜应为 opening');
ok(plans.slice(1).every((p) => ['continuation', 'closeup', 'scene_change', 'new_character'].includes(p.seg)), '旧分镜第2镜起的 seg 应落在规范值内');
// 旧数据没有 tail：本镜 tail 必须保持空（不拿本镜画面冒充），承接改由上一镜 motion 推断并标注
ok(plans.slice(1, 3).every((p) => !p.tail), '旧分镜没写 tail 时本镜 tail 必须为空（不得拿本镜画面冒充接点）');
ok(plans.slice(1, 3).every((p) => p.prevTail && p.prevTailSource === 'motion'), '旧分镜应退到上一镜 motion 作为承接依据并标注来源');
const blk = api.shotContinuityBlock(plans[1], { zh: true });
console.log('  第2镜衔接块:', blk ? blk.slice(0, 110) + '…' : '（空）');
ok(blk && blk.includes('承接上镜结尾'), '旧分镜第2镜仍应生成衔接块（承接上一镜动作）');
ok(blk && blk.includes('按其最后动作推断'), '旧分镜兜底必须诚实标注「按其最后动作推断」，不能伪装成精确尾态');

// ---------- 7) 跨分镜表承接文本（真实 prev 链）----------
console.log('\n=== 跨场承接说明（场1尾镜 → 场2）===');
const sb1Shots = sbs.find(([, n]) => (n.data.label || '').includes('场1'))?.[1].data.shots || [];
const note = api.storyboardContinuityNote(sb1Shots, '第一节-场1分镜表', true);
console.log('  ' + (note ? note.text.split('\n').filter(Boolean).join(' | ').slice(0, 160) + '…' : 'null'));
ok(!!note, '真实 prev 链下应能产出跨场承接说明');
ok(note.text.includes(sb1Shots[sb1Shots.length - 1].visual.slice(0, 10)), '跨场承接应带出尾镜画面');

// ---------- 输出 ----------
if (errs.length) {
  console.error('\n✗ 真实项目验证未通过（' + errs.length + '）：');
  errs.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('\n✓ 时空邮递员真实数据验证通过');
