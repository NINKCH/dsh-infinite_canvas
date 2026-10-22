// 用【真实项目数据】验证 runGenNode 的完整 plan 判定与最终提示词注入。
// 这是开发机上的定向验证：数据目录可通过 DSH_IC_DATA_ROOT 覆盖；缺库或缺项目时**跳过**（不算失败），
// 因为它校验的是"真实数据上的行为"，而不是构造用例——构造用例由 test-mentions 覆盖。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = process.env.DSH_IC_DATA_ROOT || 'D:/data/canvas-data';
const DB_PATH = path.join(DATA_ROOT, 'canvas.db');
const PROJECT_ID = process.env.DSH_IC_PROJECT_ID || 'pmv54zuhu6zky'; // 时空邮递员

if (!existsSync(DB_PATH)) {
  console.log('· 跳过真实项目验证：未找到 ' + DB_PATH + '（可用 DSH_IC_DATA_ROOT 指定）');
  process.exit(0);
}
let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {
  console.log('· 跳过真实项目验证：当前 Node 不支持 node:sqlite');
  process.exit(0);
}
let row = null;
try {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  row = db.prepare('SELECT doc FROM projects WHERE id = ?').get(PROJECT_ID);
  db.close();
} catch { row = null; }
if (!row) {
  console.log('· 跳过真实项目验证：库里没有项目 ' + PROJECT_ID);
  process.exit(0);
}

const clientSrc = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const doc = JSON.parse(row.doc);
const graph = { nodes: doc.nodes, edges: doc.edges || [] };
const label = (id) => (graph.nodes[id] && graph.nodes[id].data && graph.nodes[id].data.label) || id;

function grab(name) {
  const start = clientSrc.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到 ' + name);
  let i = clientSrc.indexOf('{', start), depth = 0;
  for (; i < clientSrc.length; i++) {
    if (clientSrc[i] === '{') depth++;
    else if (clientSrc[i] === '}') { depth--; if (depth === 0) return clientSrc.slice(start, i + 1); }
  }
  throw new Error('配平失败 ' + name);
}
const fnSrc = ['shotVisualText', 'shotContinuityPlan', 'shotContinuityBlock', 'storyboardContinuityNote',
  'frameAnchorText', 'subjectInfoFromRef', 'condenseDesc', 'voiceFromDesc', 'entityBibleBlock',
  'buildStructuredVideoPrompt', 'matchBibleEntity', 'entityLabelOf'].map(grab).join('\n\n');

// 复刻 runGenNode 里的 plan IIFE（与源码同逻辑，逐字搬运）
const planSrc = `
function computePlan(n, sbUp, S) {
  const shotList = sbUp && Array.isArray(sbUp.data.shots) ? sbUp.data.shots : [];
  if (!shotList.length) return { first: null, chain: false, join: 'loose', seg: 'opening', fromShot: false };
  const first = shotContinuityPlan(shotList[0], null, 0);
  const contOn = sbUp ? sbUp.data.cont !== false : true;
  const prevSb = (() => {
    const e2 = S.graph.edges.find((x) => x.toNode === (sbUp && sbUp.id) && x.toPort === 'prev');
    const src = e2 && S.graph.nodes[e2.fromNode];
    return src && src.type === 'storyboard' ? src : null;
  })();
  const prevNote = prevSb ? storyboardContinuityNote(prevSb.data.shots || [], String(prevSb.data.label || ''), true) : null;
  let seg = first.seg;
  if (seg === 'opening' && prevNote) seg = 'continuation';
  const join = (seg === 'scene_change' || seg === 'new_character') ? 'loose' : seg === 'closeup' ? 'cut' : 'strict';
  const chain = contOn && seg === 'continuation';
  return { first, chain, seg, join, fromShot: contOn && !!prevNote, contOn, prevNote, prevSb };
}`;

const api = new Function('S', fnSrc + planSrc + `
  return { shotContinuityPlan, shotContinuityBlock, storyboardContinuityNote, buildStructuredVideoPrompt, computePlan };
`)({ graph });
const S = { graph };

const sbs = Object.entries(graph.nodes).filter(([, n]) => n.type === 'storyboard')
  .sort((a, b) => (a[1].data.label || '').localeCompare(b[1].data.label || ''));

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

console.log('=== runGenNode 完整 plan 判定（真实项目）===');
const results = [];
for (const [id, n] of sbs) {
  const sbUp = { id, data: n.data };
  const plan = api.computePlan({ id }, sbUp, S);
  results.push({ id, label: n.data.label, plan });
  console.log(`  ${n.data.label}: seg=${plan.seg} join=${plan.join} chain=${plan.chain} fromShot=${plan.fromShot} prev=${plan.prevSb ? label(plan.prevSb.id) : '无'}`);
}

// 断言：场1 首段不接力；场2~场6 因 prev 链完整 → 全部 continuation 且 chain=true
ok(results[0].plan.chain === false, '场1 是首段，不应自动续帧');
for (const r of results.slice(1)) {
  ok(r.plan.seg === 'continuation', r.label + ' 首镜应为 continuation（有 prev 上游），实际 ' + r.plan.seg);
  ok(r.plan.chain === true, r.label + ' 应 chain=true（自动取上一段尾帧），实际 false');
  ok(r.plan.fromShot === true, r.label + ' 应 fromShot=true');
  ok(r.plan.join === 'strict', r.label + ' 接缝应为 strict');
}

// 验证 cont 开关真的能关掉
console.log('\n=== 关掉「分镜衔接」开关（cont:false）===');
const sb2Id = sbs.find(([, n]) => (n.data.label || '').includes('场2'))[0];
const offPlan = api.computePlan({ id: sb2Id }, { id: sb2Id, data: { ...graph.nodes[sb2Id].data, cont: false } }, S);
console.log(`  场2（cont=false）: seg=${offPlan.seg} chain=${offPlan.chain} fromShot=${offPlan.fromShot}`);
ok(offPlan.chain === false, 'cont=false 时不应自动续帧');
ok(offPlan.fromShot === false, 'cont=false 时不应生成跨段承接说明');

// 验证最终提示词里衔接信息真的进去了（用真实场1镜头 + 模拟参考图）
console.log('\n=== 场1 真实镜头生成的提示词（节选）===');
const sb1 = sbs.find(([, n]) => (n.data.label || '').includes('场1'))[1];
const refs = [
  { entity: '城市街头', name: '场景-城市街头 多视图', category: 'scene' },
  { entity: '陈拾', name: '角色-陈拾 多视图', category: 'character' },
];
const bible = {
  style: '写实电影感，冷色调',
  characters: [{ name: '陈拾', desc: '邮差。外观：深灰风衣、旧邮包。声音：低沉沙哑的中年男声。' }],
  scenes: [{ name: '城市街头', desc: '外观：冷白路灯、铁皮围挡、雨夜湿地面。' }],
  props: [],
};
const prompt = api.buildStructuredVideoPrompt(sb1.data.shots, refs, bible, { zh: true, hasFrame: false, frameRole: 'first_frame' });
const lines = prompt.split('\n').filter((l) => l.startsWith('[Shot') || l.startsWith('【'));
lines.slice(0, 4).forEach((l) => console.log('  ' + l.slice(0, 150) + (l.length > 150 ? '…' : '')));
ok(/\[Shot 2\][^\n]*【衔接】/.test(prompt), '第2镜起应带【衔接】块');
ok(/承接上镜结尾/.test(prompt), '应含承接上镜结尾');
// 旧分镜没有 tail/cam 字段：承接应退到「上一镜的 motion」并标注推断来源
ok(/上一镜未写接点尾态，按其最后动作推断/.test(prompt), '旧分镜缺 tail 时应诚实标注「按最后动作推断」');
ok(!/承接上镜结尾（本镜起始态[^）]*）：中景，<Subject 2> 在 <Subject 1> 路灯下俯身扶正/.test(prompt), '承接内容不能是本镜自己的画面（必须是上一镜的）');
// 新分镜（有 tail/cam）才应出现运镜延续 —— 用补全字段后的副本验证
const shotsWithCont = sb1.data.shots.map((s, i) => ({
  ...s,
  tail: i === 0 ? '手扶车把停在半途，视线刚离开围挡' : (i === 1 ? '单脚踩下撑杆一半，车身未完全稳住' : ''),
  cam: i === 0 ? '缓慢推近，匀速，未停' : (i === 1 ? '轻微下摇跟随，匀速' : ''),
}));
const prompt2 = api.buildStructuredVideoPrompt(shotsWithCont, refs, bible, { zh: true });
ok(/运镜延续：轻微下摇跟随，匀速/.test(prompt2), '运镜延续应使用本镜的 cam（本镜运镜承接上一镜方向）');
ok(/承接上镜结尾（本镜起始态[^）]*）：手扶车把停在半途/.test(prompt2), '承接内容必须是上一镜的 tail 原文');
const shot2Line = prompt2.split('\n').find((l) => l.startsWith('[Shot 2]')) || '';
const shot3Line = prompt2.split('\n').find((l) => l.startsWith('[Shot 3]')) || '';
ok(shot2Line.includes('承接上镜结尾（本镜起始态，不得重置姿态/位置/手持物）：手扶车把停在半途'), 'Shot2 的承接内容必须是 Shot1 的 tail 原文');
ok(!shot2Line.includes('承接上镜结尾（本镜起始态，不得重置姿态/位置/手持物）：单脚踩下撑杆一半'), 'Shot2 的承接内容不能误用 Shot2 自己的 tail');
ok(shot3Line.includes('承接上镜结尾（本镜起始态，不得重置姿态/位置/手持物）：单脚踩下撑杆一半'), 'Shot3 的承接内容必须是 Shot2 的 tail 原文（链式传递）');
ok(!/@陈拾@/.test(prompt2), '提示词里不应残留 @引用@ 语法');

// 有首帧时的锚定
const withFrame = api.buildStructuredVideoPrompt(sb1.data.shots, refs, bible, { zh: true, hasFrame: true, frameRole: 'reference_image' });
ok(/【首帧锚定】\[图1\]/.test(withFrame), '有首帧时应带首帧锚定说明');

if (errs.length) {
  console.error('\n✗ 验证未通过（' + errs.length + '）：');
  errs.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('\n✓ 时空邮递员：plan 判定 + 提示词注入 全部符合预期');
