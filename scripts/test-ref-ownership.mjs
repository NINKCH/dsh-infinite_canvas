// 参考图归属 / 资产检索 / 设定注入 的三合一回归（缺陷 1/2/3 的防复发网）：
//   ① 参考图严格等于连进 ref 口的连线（refOrder 顺序），@引用绝不自动追加图片；
//      面板角标与厂商告警口径一致（同一份连线列表），不会再"连 6 张报 9 张"。
//   ② 设定集「链接资产」弹窗的数据源必须服务端分页拉全（跨 nextCursor）+ 本地遗留合并，
//      250 条资产跨 2 页也要一条不少，最早生成的旧资产同样在结果里。
//   ③ 视频提示词（分镜结构化 / 手写 / 续帧承接三条路径）都要注入 @实体@ 的设定文字
//      （外观 desc + 声音），且绝不因此增加 refs。
// 纯函数直接从 client.js 抽取执行（无 DOM / 无网络依赖）。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(root, 'client.js'), 'utf8');

/** 按函数名抓取源码（花括号配平；只用于不含「花括号字符串」的纯逻辑函数）。 */
function grab(name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name + '（client.js 结构被改动？）');
  if (src.slice(start - 6, start) === 'async ') start -= 6; // 保留 async：否则函数体里的 await 语法错误
  // 从参数表的 ) 之后找函数体 {：不能直接 indexOf('{')（解构参数 `({ entry, ... })` 会误判成函数体）
  const pStart = src.indexOf('(', start);
  let pd = 0, pEnd = -1;
  for (let j = pStart; j < src.length; j++) {
    if (src[j] === '(') pd++;
    else if (src[j] === ')') { pd--; if (pd === 0) { pEnd = j; break; } }
  }
  let i = src.indexOf('{', pEnd + 1), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('函数花括号配平失败：' + name);
}

/** 直接从 client.js 抽 MENTION_PURE 区块（与 test-mentions 同一份事实源）。 */
const m = /\/\/ <<<MENTION_PURE_BEGIN>>>([\s\S]*?)\/\/ <<<MENTION_PURE_END>>>/.exec(src);
if (!m) {
  console.error('✗ 未找到 MENTION_PURE 区块（client.js 结构被改动？）');
  process.exit(1);
}
const pureBody = m[1];

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };
const eq = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) errs.push(label + '\n    期望 ' + JSON.stringify(b) + '\n    实际 ' + JSON.stringify(a));
};

// ---------------------------------------------------------------
// ① 参考图归属：连线优先 + refOrder，@引用不追加图片
// ---------------------------------------------------------------
const catLabel = (c) => ({ character: '角色', scene: '场景', prop: '道具', general: '通用' }[c] || '通用');
const effLang = () => 'zh';
const pure = new Function('catLabel', 'effLang', pureBody + `
  return { parseMentions, matchBibleEntity, assetBelongsToEntity, entityLabelOf, entityCategoryOf,
    buildEffectivePrompt, buildStructuredVideoPrompt, subjectInfoFromRef, condenseDesc, voiceFromDesc,
    entityBibleBlock, assetNameFor, stripMentionMarks, bibleNames, repairUnclosedMentions };
`)(catLabel, effLang);

// collectRefs / resolveMentionBundle 依赖 S、资产库与资产读取：用桩跑真实源码
const collSrc = [
  'const GENERAL_PID = "general";',
  grab('orderedRefEdgeIds'),
  grab('resolveMentionBundle'),
  grab('collectRefs'),
].join('\n\n');

const bible = {
  style: '写实电影感',
  characters: [{ name: '陈拾', desc: '邮差。外观：深灰风衣、旧帆布邮包、短发。声音：低沉沙哑的男声。' }],
  scenes: [{ name: '褶皱巷', desc: '外观：雨夜窄巷、青石地面反光。' }],
  props: [],
};

// 资产库：连线用的 6 张 + 该实体名下 5 张历史图（都是"不该被自动加入"的）+ 1 条声音
const assets = {};
for (let i = 1; i <= 6; i++) assets['a' + i] = { id: 'a' + i, kind: 'image', name: '图' + i, category: 'general', createdAt: i };
for (let i = 1; i <= 5; i++) assets['m' + i] = { id: 'm' + i, kind: 'image', name: '角色-陈拾 多视图 ' + i, entity: '陈拾', category: 'character', createdAt: 100 + i };
assets.voice1 = { id: 'voice1', kind: 'audio', name: '角色-陈拾 声音', entity: '陈拾', category: 'general', createdAt: 200 };

const S = { activeId: 'p1', graph: { nodes: {}, edges: [] } };
for (let i = 1; i <= 6; i++) S.graph.nodes['img' + i] = { id: 'img' + i, type: 'image', data: { assetId: 'a' + i } };
S.graph.nodes.vid = { id: 'vid', type: 'video', data: { refOrder: ['e4', 'e2', 'e1', 'e3', 'e5', 'e6'] } };
for (let i = 1; i <= 6; i++) {
  S.graph.edges.push({ id: 'e' + i, fromNode: 'img' + i, fromPort: 'out', toNode: 'vid', toPort: 'ref' });
}
// 干扰连线：prompt 口不算参考图
S.graph.nodes.sb = { id: 'sb', type: 'storyboard', data: {} };
S.graph.edges.push({ id: 'ep', fromNode: 'sb', fromPort: 'out', toNode: 'vid', toPort: 'prompt' });

const lib = Object.values(assets);
const collect = new Function('S', 'idbGet', 'assetBlob', 'idbByProject', 'parseMentions', 'matchBibleEntity', 'assetBelongsToEntity', 'servedAssetId',
  collSrc + '\nreturn { collectRefs, orderedRefEdgeIds, resolveMentionBundle };')(
  S,
  async (id) => assets[id] || null,
  async (id) => (assets[id] ? { fakeBlob: id } : null),
  async (pid) => (pid === 'general' ? [] : lib),
  pure.parseMentions, pure.matchBibleEntity, pure.assetBelongsToEntity,
  (srcNode, fromPort) => (srcNode && srcNode.data ? srcNode.data.assetId || null : null),
);

const prompt = '@陈拾@ 走进 @褶皱巷@，手里拿着 @火漆信@';
const out = await collect.collectRefs(S.graph.nodes.vid, prompt, bible);
const refIds = out.refs.map((r) => r.assetId);
eq(refIds, ['a4', 'a2', 'a1', 'a3', 'a5', 'a6'], '参考图必须严格等于 ref 连线且按 refOrder 排序');
eq(refIds.length, 6, '只连了 6 条 ref：参考图必须是 6 张（@引用绝不自动追加图片）');
ok(!refIds.some((id) => id.startsWith('m')), '资产库里该实体名下的其它图片被自动塞进了参考图（缺陷 1 回归）');
ok(out.refs.every((r) => r.source === 'wired'), '参考图来源必须是 wired（连线），出现非连线来源');
eq(out.entities.map((e) => e.name), ['陈拾', '褶皱巷'], '@引用仍要解析出命中实体（供文字设定注入）');
eq(out.audioBlobs.map((a) => a.assetId), ['voice1'], '声音参考资产仍按实体匹配（audioBlobs，与图片参考图分开）');

// 告警/上限口径：告警基于同一份真实列表 → 6 张，绝不报超限（厂商上限 8）
{
  const refCount = out.refs.length;
  const capsImg = 8;
  const warn = refCount > capsImg ? '参考图 ' + refCount + ' 张超过该厂商上限 ' + capsImg + ' 张' : '';
  eq(warn, '', '连 6 张却按 9 张报超限（面板角标与告警统计口径不一致）');
}

// refOrder 缺项/过期项：未登记的连线按连线先后补到末尾，过期 id 被忽略
{
  const n2 = { id: 'v2', data: { refOrder: ['e6', 'zzz', 'e2'] } };
  eq(collect.orderedRefEdgeIds(n2, S.graph.edges.filter((e) => e.id.startsWith('e') && e.id !== 'ep').slice(0, 6)),
    ['e6', 'e2', 'e1', 'e3', 'e4', 'e5'], 'refOrder 优先 + 未记录连线按连线先后补位');
}

// 源码级防复发：collectRefs 里不得再出现"追加 @引用图片"的旧逻辑
{
  const body = grab('collectRefs');
  ok(!/bundle\.refs/.test(body), 'collectRefs 仍在消费 bundle.refs（会把设定集图片自动加入参考图）');
  ok(!/source:\s*'mention'/.test(body), "collectRefs 仍在生成 source:'mention' 的参考图（旧自动追加逻辑复活）");
  ok(/bundle\.audioRefs/.test(body), 'collectRefs 丢了声音参考解析（audioBlobs 应保留）');
  ok(/orderedRefEdgeIds\(n, edges\)/.test(body), 'collectRefs 未按 refOrder 顺序取参考图');
  // 图片/视频/续帧/工作流/铺开/历史重跑都走 runGenNode → collectRefs：两条生成分支都必须调用它
  const runs = (src.match(/await collectRefs\(n, prompt, bible\)/g) || []).length;
  eq(runs, 2, '图片/视频两条生成路径必须都通过 collectRefs 取参考图（新增路径请同步）');
}

// ---------------------------------------------------------------
// ② 设定集绑定弹窗的数据源：服务端分页拉全（> 分页上限也不截断）
// ---------------------------------------------------------------
const pickSrc = grab('assetsForPicker');

function mkServerAssets(total) {
  const list = [];
  for (let i = total; i >= 1; i--) list.push({ id: 'srv' + i, name: '图 ' + i, prompt: '画面描述 ' + i, kind: 'image', projectId: 'p1', createdAt: i });
  return list;
}

/** 分页 hostRpc 桩：每次返回 limit 条 + nextCursor（与 Host dbAssetsList 协议一致）。 */
function mkRpc(serverAssets) {
  const calls = [];
  const rpc = async (method, args) => {
    calls.push({ method, args });
    if (method !== 'assetsList') throw new Error('unexpected rpc ' + method);
    const limit = Number(args.limit) || 50;
    const start = args.cursor ? Number(Buffer.from(String(args.cursor), 'base64').toString('utf8')) : 0;
    const items = serverAssets.slice(start, start + limit);
    const next = start + limit < serverAssets.length ? Buffer.from(String(start + limit)).toString('base64') : null;
    return { ok: true, total: serverAssets.length, items, nextCursor: next };
  };
  return { rpc, calls };
}

{
  const server = mkServerAssets(250);
  const { rpc, calls } = mkRpc(server);
  const localLegacy = [
    { id: 'legacy1', name: '旧本地资产', kind: 'image', projectId: 'p1', createdAt: 999 }, // 只在本地 IDB
    { id: 'srv250', name: '重复项', kind: 'image', projectId: 'p1', createdAt: 250 }, // 服务端已有 → 必须去重
  ];
  const pick = new Function('hostRpc', 'idbAll', 'assetMem', 'assetNameCache',
    pickSrc + '\nreturn assetsForPicker;')(rpc, async () => localLegacy, new Map(), new Map());
  const all = await pick();
  eq(calls.length, 2, '250 条资产跨 2 页：必须循环 nextCursor 拉 2 页（不得只取第一页）');
  eq(calls[0].args.limit, 200, '分页拉取应使用服务端上限 200/页');
  eq(calls[0].args.projectId, '', '绑定弹窗要拉全部项目资产（projectId 空 = 全量）');
  eq(all.length, 251, '弹窗数据源应拿到全部资产（250 服务端 + 1 本地遗留，重复项去重）');
  eq(new Set(all.map((a) => a.id)).size, all.length, '数据源出现重复资产 id（去重失效）');
  ok(all.some((a) => a.id === 'srv1'), '最早生成的旧资产在结果里缺失（分页后面的页被丢掉）');
  eq(all[0].id, 'legacy1', '结果必须按生成时间倒序（最早的排最后、最新的排最前）');
  eq(all[all.length - 1].id, 'srv1', '按生成时间倒序：最旧资产应排最后');

  // 服务端不可用 → 本地兜底，不崩
  const fallback = new Function('hostRpc', 'idbAll', 'assetMem', 'assetNameCache',
    pickSrc + '\nreturn assetsForPicker;')(async () => { throw new Error('offline'); }, async () => localLegacy, new Map(), new Map());
  const local = await fallback();
  eq(local.map((a) => a.id).sort(), ['legacy1', 'srv250'], '服务端不可用时应以本地遗留资产兜底');
}

// 源码级防复发：弹窗必须走 assetsForPicker（不能退回只读本地 IndexedDB 的 idbAll）
{
  const dlg = grab('BibleLinkDialog');
  ok(/await assetsForPicker\(\)/.test(dlg), '设定集绑定弹窗未使用 assetsForPicker（资产检索会再次不全）');
  ok(!/await idbAll\(\)/.test(dlg), '设定集绑定弹窗又在直接读本地 idbAll（服务端资产会看不到）');
  ok(/a\.prompt/.test(dlg), '绑定弹窗搜索没命中提示词（只能按名称搜）');
  const pickBody = pickSrc;
  ok(/nextCursor/.test(pickBody) && /for \(;;\)/.test(pickBody), 'assetsForPicker 没有循环 nextCursor 拉全');
  ok(/idbAll\(\)/.test(pickBody), 'assetsForPicker 丢了本地遗留资产合并（旧数据会消失）');
}

// ---------------------------------------------------------------
// ③ 设定注入：分镜结构化 / 手写 / 续帧承接三条路径都注入文字，且不增加 refs
// ---------------------------------------------------------------
{
  const shots = [
    { title: '开场', duration: 2, visual: '@陈拾@ 在 @褶皱巷@ 里停下', motion: '镜头缓推', sfx: '雨声' },
    { title: '对话', duration: 2.5, visual: '近景，@陈拾@ 抬头', motion: '固定', dialogue: [{ role: '陈拾', line: '信到了。' }] },
  ];
  const refs = [{ entity: '褶皱巷', name: '场景-褶皱巷', category: 'scene' }]; // 只连了 1 张场景图
  const mentioned = [pure.matchBibleEntity('陈拾', bible)]; // @陈拾@ 命中但没有连图
  const p = pure.buildStructuredVideoPrompt(shots, refs, bible, { zh: true, entities: mentioned });

  ok(p.includes('series_bible'), '结构化视频提示词缺少设定集文字段（缺陷 3）');
  ok(p.includes('外观：深灰风衣、旧帆布邮包、短发'), '结构化视频提示词没注入 @陈拾@ 的外观设定文本');
  ok(p.includes('声音：低沉沙哑的男声'), '结构化视频提示词没注入 @陈拾@ 的声音设定');
  ok(/陈拾（S1） 用低沉沙哑的男声说/.test(p), '分镜台词没有带出该实体的声音要求（用…说）');
  ok(p.includes('<d>[Chinese] 信到了。</d>'), '台词仍必须用 <d>…</d> 包裹');
  // 不虚构参考图：只有 1 张连线 → 只能出现 <Picture 1>，绝不能因为 @陈拾@ 冒出 <Picture 2>
  ok(!p.includes('<Picture 2>'), '@引用凭空造出了第 2 张参考图（参考图必须严格等于连线）');
  eq(p.match(/<Picture \d+>/g), ['<Picture 1>'], '结构化提示词的 <Picture N> 数量必须等于连线参考图数量');

  // 续帧承接段（图1=上一段尾帧 → 实体参考图偏移为图2）：文字设定照样注入，图片数量不变
  const cont = pure.buildStructuredVideoPrompt(shots, refs, bible, {
    zh: true, entities: mentioned, hasFrame: true, frameRole: 'reference_image',
    continuity: '本段是上一段的直接续帧：不重演、不重置机位',
  });
  ok(cont.includes('外观：深灰风衣、旧帆布邮包、短发'), '续帧承接段（tail）没注入实体设定文字');
  ok(cont.includes('声音：低沉沙哑的男声'), '续帧承接段（tail）没注入声音设定');
  ok(cont.includes('continuity:'), '续帧承接段缺少 continuity 段');
  eq(cont.match(/<Picture \d+>/g), ['<Picture 2>'], '续帧降级模式下唯一实体参考图应仍是 <Picture 2>（偏移正确、数量不变）');

  // 单视频节点手写提示词（无分镜上游）：buildEffectivePrompt 注入设定文字（含 voice 字段）
  const entVoiceOnly = { kind: 'character', name: '陈拾', desc: '邮差，深灰风衣', voice: '低沉沙哑的男声' };
  const plain = pure.buildEffectivePrompt('@陈拾@ 在巷口停下', refs, [entVoiceOnly], bible, false);
  ok(plain.includes('设定集：角色 陈拾：'), '手写提示词路径没注入实体设定文本');
  ok(plain.includes('声音：低沉沙哑的男声'), '手写提示词路径没注入声音设定（voice 字段）');
  ok(!plain.includes('@陈拾@'), '有效提示词里仍残留 @引用@ 标记');

  // 图片 light 模式仍然不内联设定全文（与既有行为一致，缺陷 1 不改变图片口径）
  const imgLight = pure.buildEffectivePrompt('@陈拾@ 在巷口停下', refs, mentioned, bible, true);
  ok(!imgLight.includes('深灰风衣'), '图片 light 模式不应内联设定全文（会污染画面文字）');

  // refs 不因注入而增加：注入前后引用数组完全一致
  const before = JSON.stringify(refs);
  pure.buildStructuredVideoPrompt(shots, refs, bible, { zh: true, entities: mentioned });
  eq(JSON.stringify(refs), before, '提示词注入过程修改/扩充了 refs（注入必须只出文字）');
}

// 源码级防复发：三条路径都承接 entities
{
  ok(/entities,/.test(src.slice(src.indexOf('p = buildStructuredVideoPrompt(shotList, refs, bible,'), src.indexOf('p = buildStructuredVideoPrompt(shotList, refs, bible,') + 600)),
    '分镜→视频路径没把 entities 传给结构化提示词组装（设定文字会丢）');
  ok(/entityBibleBlock\(entities, bible, zh\)/.test(src), '手写结构化提示词路径没有注入设定文字块');
  ok(/series_bible/.test(src), '缺少 series_bible 文字段的输出口径');
  ok(/声音：/.test(grab('entityBibleBlock')) || /voice/.test(grab('entityBibleBlock')), '设定文字块没处理声音设定');
}

// ---------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------
if (errs.length) {
  console.error('✗ 参考图归属/资产检索/设定注入测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 参考图归属/资产检索/设定注入测试全部通过');
console.log('  · 缺陷 1：refs 严格 = ref 连线（refOrder 顺序），@引用零自动追加，告警口径一致（6/6）');
console.log('  · 缺陷 2：绑定弹窗数据源跨页拉全 251 条（含最早生成的旧资产），服务端故障本地兜底');
console.log('  · 缺陷 3：结构化/手写/续帧三条路径均注入外观+声音文本，<Picture N> 数量不因 @引用 增加');
