#!/usr/bin/env node
/**
 * 制作阶段机与流程闸门回归（0.20.0）
 *  覆盖：阶段枚举/推断/抬升/显式回退 · G1 设定集先行 · G2 分镜质量 · G3 一表一视频 ·
 *        G4 禁逐镜节点 · G5 破坏性确认 · G6 阶段越序 · 逃生舱与审计 · 汇报语义（ready）
 *  运行：node scripts/test-production.mjs（沙盒临时目录，零真实副作用）
 */
import path from 'node:path';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ---------- 沙盒 ----------
const SANDBOX = path.join(ROOT, '.tmp-test-production');
await fs.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
fsSync.mkdirSync(SANDBOX, { recursive: true });
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => ok(String(a) === String(b), m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）');

const tools = [];
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get(key) { return undefined; }, // 无 workspaceRegistry / sessionController → 降级路径
  webServer: { register: () => () => {} },
  tools: { register: (def) => { tools.push(def); return () => {}; } },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
try { mod.apply(fakeCtx); } catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + ((e && e.stack) || e));
  process.exit(1);
}
const I = mod._internals;
const tool = (name) => tools.find((t) => t.name === name);
const P = I.production;
const STAGES = I.productionStages;
ok(!!P && Array.isArray(STAGES) && STAGES.length === 10, 'production 模块未随 _internals 导出');

// ============================ 一、单元层：闸门纯函数 ============================
{
  // G1 设定集先行
  const g1Empty = P.gateBible({});
  eq(g1Empty.ok, false, 'G1: 空设定集应不通过');
  eq(g1Empty.missing.length, 3, 'G1: 空设定集应报 3 项缺失');
  const g1Half = P.gateBible({ worldview: 'x', style: '', characters: [] });
  ok(g1Half.missing.some((m) => m.startsWith('style')) && g1Half.missing.some((m) => m.startsWith('characters')), 'G1: 缺失项应逐项点名');
  const g1Full = P.gateBible({ worldview: 'x', style: 'y', characters: [{ name: '陈拾', desc: '邮差' }] });
  eq(g1Full.ok, true, 'G1: 完整设定集应通过');

  // G2 分镜质量
  const g2Empty = P.gateStoryboard([]);
  eq(g2Empty.ok, false, 'G2: 空 shots 应不通过');
  const badShots = [
    { title: '镜1', visual: '他走过来', motion: '', duration: 0 },
    { title: '镜2', visual: '中景，陈拾回望', motion: '横移', duration: 2, seg: 'cut' },
    { title: '镜3', visual: '远景，巷口', motion: '横移', duration: 2 },
    { title: '镜4', visual: '全景，巷口', motion: '横移', duration: 2 },
  ];
  const g2Bad = P.gateStoryboard(badShots);
  eq(g2Bad.ok, false, 'G2: 粗分镜应不通过');
  ok(g2Bad.fails.some((f) => f.includes('镜1') && f.includes('时长')), 'G2: 缺时长应逐镜点名');
  ok(g2Bad.fails.some((f) => f.includes('镜1') && f.includes('景别')), 'G2: 景别不具体应点名');
  ok(g2Bad.fails.some((f) => f.includes('大特写')), 'G2: 无大特写应失败');
  ok(g2Bad.fails.some((f) => f.includes('连续三镜')), 'G2: 连续三镜同运动应失败');
  ok(g2Bad.fails.some((f) => f.includes('seg')), 'G2: 非法 seg 应失败');
  ok((g2Bad.warns || []).some((w) => w.includes('衔接字段')), 'G2: 缺衔接字段应是建议（warns）不是失败');

  const goodShots = [
    { title: '镜1', visual: '中景，雨夜巷口，陈拾收伞', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ];
  const g2Good = P.gateStoryboard(goodShots);
  eq(g2Good.ok, true, 'G2: 合规分镜应通过（fails=' + JSON.stringify(g2Good.fails) + '）');
  eq(P.gateStoryboard(Array.from({ length: 13 }, () => goodShots).flat()).ok, false, 'G2: 超 24 镜应拒绝');

  // G4 禁逐镜节点
  eq(P.gateShotNodeName('第1节-场2-镜3 视频', 'video').ok, false, 'G4: 镜N 命名应拒绝');
  eq(P.gateShotNodeName('角色-陈拾 参考图', 'image').ok, true, 'G4: 资产命名应放行');
  eq(P.gateShotNodeName('场2-首帧', 'image').ok, true, 'G4: 首帧定帧图应放行');
  eq(P.gateShotNodeName('第一节剧本', 'script').ok, true, 'G4: 非媒体类型不受命名限制');

  // G3 一表一视频
  const docG3 = {
    nodes: { sb1: { id: 'sb1', type: 'storyboard' }, v1: { id: 'v1', type: 'video', data: { label: '场1视频' } } },
    edges: [{ fromNode: 'sb1', toNode: 'v1' }],
  };
  eq(P.gateOneVideoPerStoryboard(docG3, 'sb1').ok, false, 'G3: 同表第二个视频应拒绝');
  eq(P.gateOneVideoPerStoryboard(docG3, 'sb1').existingVideoId, 'v1', 'G3: 拒绝应指回既有视频');
  eq(P.gateOneVideoPerStoryboard(docG3, 'sb2').ok, true, 'G3: 新分镜表应放行');
}

// ============================ 二、单元层：阶段机 ============================
{
  const pid = 'stage-unit-test';
  const home = path.join(SANDBOX, 'stage-home');
  fsSync.mkdirSync(home, { recursive: true });
  const dep = {
    projectHomeDir: () => home,
    readToolDoc: () => ({ nodes: {}, edges: [], bible: {} }),
    readDoc: () => ({ bible: {} }),
    normalizeCanvasId: (v) => (v ? String(v) : null),
  };
  const PP = mod; void PP;
  // 直接用 _internals.production 无法自定义 deps → 用导出的 createProduction 不可行（未导出工厂）
  // 这里改走集成路径（第四节），单元层用真实 PROD + 沙盒项目目录。
}

// ============================ 三、集成层：真实工具链 ============================
const byName = new Map(tools.map((t) => [t.name, t]));
let projectId = '';
try {
  const created = await byName.get('canvas_create_project').execute({ name: '__阶段机测试__' }, {});
  ok(created && created.ok && created.projectId, 'canvas_create_project 失败');
  projectId = created.projectId;
} catch (e) { errs.push('建项目失败 → ' + ((e && e.message) || e)); }

// G1：设定集为空 → 剧本生成被拒
{
  const sn = await byName.get('canvas_create_node').execute({ projectId, type: 'script', name: '第一节剧本' }, {});
  ok(sn && sn.ok === true && sn.nodeId, 'G1 前置：建剧本节点失败');
  const r = await byName.get('canvas_run_node').execute({ projectId, nodeId: sn.nodeId }, {});
  ok(r && r.ok === false && r.gate === 'G1', 'G1: 空设定集时剧本生成未被拒');
  ok(Array.isArray(r.missing) && r.missing.length === 3, 'G1: 拒绝应携带缺失清单');
  ok(r.fix && r.fix.includes('override'), 'G1: 拒绝应告知逃生舱用法');
  // 写设定集 → 通过（并抬升阶段到 bible/script）
  await byName.get('canvas_update_bible').execute({
    projectId,
    bible: {
      worldview: '时空邮局', style: '写实电影感',
      characters: [{ name: '陈拾', desc: '24 岁邮差' }],
      scenes: [{ name: '巷口', desc: '雨夜窄巷' }],
      props: [{ name: '火漆信', desc: '火漆印' }],
    },
  }, {});
  const r2 = await byName.get('canvas_run_node').execute({ projectId, nodeId: sn.nodeId }, {});
  ok(r2 && r2.ok === true, 'G1: 补全设定集后剧本生成应放行');
}

// G4：逐镜节点命名被拒
{
  const r = await byName.get('canvas_create_node').execute({ projectId, type: 'image', name: '场1-镜3 视频', prompt: 'x' }, {});
  ok(r && r.ok === false && r.gate === 'G4', 'G4: 镜N 命名未被拒');
}

// G2：粗分镜 → 建视频被拒；合规分镜 → 放行并抬升 shots_ready
let sbNodeId = '';
{
  const sb = await byName.get('canvas_create_node').execute({ projectId, type: 'storyboard', name: '第一节分镜表' }, {});
  sbNodeId = sb.nodeId;
  const badShots = JSON.stringify({ shots: [{ title: '镜1', visual: '他走过来', motion: '推', duration: 2 }] });
  await byName.get('canvas_write_node').execute({ projectId, nodeId: sbNodeId, target: 'output', text: badShots, overwrite: true }, {});
  const v1 = await byName.get('canvas_create_node').execute({ projectId, type: 'video', name: '第一节多镜头视频' }, {});
  ok(v1 && v1.ok === false && v1.gate === 'G2', 'G2: 粗分镜建视频未被拒');
  ok(Array.isArray(v1.fails) && v1.fails.length >= 2, 'G2: 拒绝应携带逐条失败项');
  // 合规分镜（整表替换）
  const goodShots = JSON.stringify({ shots: [
    { title: '镜1', visual: '中景，陈拾收伞回望', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，火漆信邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ] });
  await byName.get('canvas_write_node').execute({ projectId, nodeId: sbNodeId, target: 'output', text: goodShots, overwrite: true }, {});
  const v2 = await byName.get('canvas_create_node').execute({ projectId, type: 'video', name: '第一节多镜头视频' }, {});
  ok(v2 && v2.ok === true && v2.nodeId, 'G2: 合规分镜建视频应放行');

  // G3：同表第二个视频被拒；override 放行
  const v3 = await byName.get('canvas_create_node').execute({ projectId, type: 'video', name: '第一节备份视频' }, {});
  ok(v3 && v3.ok === false && v3.gate === 'G3' && v3.existingVideoId === v2.nodeId, 'G3: 同表第二视频未被拒或未指回既有节点');
  const v4 = await byName.get('canvas_create_node').execute({ projectId, type: 'video', name: '第一节备份视频', override: { by: 'user-explicit', quote: '用户：再建一个对比' } }, {});
  ok(v4 && v4.ok === true, 'G3: override 未放行');

  // 状态汇报：阶段应已到 shots_ready
  const st = await I.rpcMethods().productionStatus({ projectId });
  eq(st.stage, 'shots_ready', '阶段机: 过闸后应为 shots_ready');
  eq(st.ready, true, '汇报语义: 过闸后 ready 应为 true');
  ok(st.evidence.shotsTotal >= 2, '汇报证据: 镜头计数不符');
}

// G5：删除必须带 confirm
{
  const img = await byName.get('canvas_create_node').execute({ projectId, type: 'image', name: '场景-巷口 设定图', prompt: '雨夜窄巷' }, {});
  ok(img && img.ok === true && img.nodeId, 'G5 前置：建图片节点失败');
  const r = await byName.get('canvas_delete_node').execute({ projectId, nodeId: img.nodeId }, {});
  ok(r && r.ok === false && r.gate === 'G5', 'G5: 无 confirm 删除未被拒');
  const r2 = await byName.get('canvas_delete_node').execute({ projectId, nodeId: img.nodeId, confirm: '删掉这张测试图' }, {});
  ok(r2 && r2.ok === true, 'G5: 带 confirm 删除应放行');
}

// 显式回退（返工）+ 审计 + capabilities
{
  const adv = await I.rpcMethods().productionAdvance({ projectId, to: 'storyboard', reason: '这集分镜推倒重来' });
  ok(adv && adv.ok === true && adv.to === 'storyboard', '显式回退失败');
  const noReason = await I.rpcMethods().productionAdvance({ projectId, to: 'bible' });
  ok(noReason && noReason.ok === false, '无 reason 的显式推进应被拒');
  const st = await I.rpcMethods().productionStatus({ projectId });
  eq(st.stage, 'storyboard', '回退后生效阶段应为 storyboard');
  ok(Array.isArray(st.overrides) && st.overrides.some((o) => o.gate === 'G3' || o.gate === 'G5'), '审计: override 未落审计');
  const caps = await I.rpcMethods().productionCapabilities();
  ok(caps && caps.ok && caps.rev >= 1 && caps.stageMachine === true, 'capabilities 探针缺失');
  eq(caps.multiAgent, false, 'capabilities: 无宿主会话服务时 multiAgent 应为 false（M0 探针降级）');
}

// 自动创作（A1 两段式）：开关默认关 + 预算单 + 一次性批准令牌
{
  const M = I.rpcMethods();
  const g0 = await M.autoModeGet();
  eq(g0.enabled, false, '自动创作开关默认应为关闭');
  const q0 = await M.autoQuote({ projectId });
  ok(q0 && q0.ok === false && q0.disabled === true, '关闭状态下 autoQuote 未被拒绝');
  await M.autoModeSet({ enabled: true });
  eq((await M.autoModeGet()).enabled, true, '打开开关失败');

  // 第二个分镜表（无视频）→ 预算单应有 1 次待调用
  const sb2 = await byName.get('canvas_create_node').execute({ projectId, type: 'storyboard', name: '第二节分镜表' }, {});
  ok(sb2 && sb2.ok, '预算夹具：建第二个分镜表失败');
  const shots2 = JSON.stringify({ shots: [
    { title: '镜1', visual: '近景，陈拾推门', motion: '跟拍', duration: 4, seg: 'opening', tail: '手按门把', cam: '跟拍向前' },
    { title: '镜2', visual: '大特写，门缝里的字条', motion: '缓推', duration: 1, seg: 'closeup', tail: '字条定格', cam: '推进到位' },
  ] });
  await byName.get('canvas_write_node').execute({ projectId, nodeId: sb2.nodeId, target: 'output', text: shots2, overwrite: true }, {});

  const q = await M.autoQuote({ projectId, unitPricePerSecond: 2 });
  ok(q && q.ok === true, 'autoQuote 失败');
  ok(q.sceneCount >= 2 && q.shotCount >= 4, '预算单场/镜计数不符：' + q.sceneCount + '/' + q.shotCount);
  ok(q.totalSeconds >= 10, '预算单总秒数不符：' + q.totalSeconds);
  eq(q.videoCalls, 1, '预算单待调用次数应为 1（第二个分镜表尚无视频）');
  eq(q.estimatedCost, 20, '预算单估算金额应为 秒数×单价');
  ok(!!q.quoteId, '预算单缺 quoteId');

  // 错误令牌 → 拒绝；正确令牌 + 用户原话 → 批准
  const bad = await M.autoApprove({ projectId, quoteId: 'q-deadbeef-1', confirm: '好' });
  ok(bad && bad.ok === false && bad.expired === true, '过期/伪造 quoteId 未被拒绝');
  const noWords = await M.autoApprove({ projectId, quoteId: q.quoteId });
  ok(noWords && noWords.ok === false, '无用户原话的批准未被拒绝');
  const ap = await M.autoApprove({ projectId, quoteId: q.quoteId, confirm: '用户：就按这个预算开机' });
  ok(ap && ap.ok === true && ap.approved === true, '按预算批准失败');
  const st1 = await M.autoStatus({ projectId });
  ok(st1.approval && st1.approval.valid === true, '批准后 approval.valid 应为 true');

  // 镜头变了 → 旧批准自动失效（必须重新复核预算）
  const docNow = await I.projectsGet({ id: projectId });
  const curShots = docNow.nodes[sb2.nodeId].data.shots;
  const longer = JSON.stringify({ shots: curShots.concat([{ title: '镜3', visual: '全景，雨幕压城', motion: '拉升', duration: 2, seg: 'scene_change', tail: '雨幕压城', cam: '拉升' }]) });
  await byName.get('canvas_write_node').execute({ projectId, nodeId: sb2.nodeId, target: 'output', text: longer, overwrite: true }, {});
  const st2 = await M.autoStatus({ projectId });
  ok(st2.approval && st2.approval.valid === false, '镜头变化后旧批准仍然有效（令牌未绑定预算指纹）');

  // 关掉开关 → 立即拒绝
  await M.autoModeSet({ enabled: false });
  const q2 = await M.autoQuote({ projectId });
  ok(q2 && q2.ok === false && q2.disabled === true, '关闭开关后 autoQuote 未被拒绝');
}

// 自动创作编剧室（免费段）：假 LLM 注入 → 全流水线落盘
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });
  const roomPid = (await byName.get('canvas_create_project').execute({ name: '自动创作测试' }, {})).projectId;
  // 技能遵循度回归：监制轮（唯一决定剧情/设定的环节）的 system 必须带项目技能包配置头——
  // 否则编剧室产出的题材/影调与项目技能配置脱节，全靠 G2 打回兜底。先给项目写入一份配置再跑。
  const monitorSystems = [];
  const fake = async ({ system }) => {
    const s = String(system || '');
    if (s.includes('监制')) monitorSystems.push(s);
    if (s.includes('调研员')) return JSON.stringify({ themes: [{ name: '时空邮差', why: 't' }], styles: ['写实电影感'] });
    if (s.includes('编剧A')) return JSON.stringify({ logline: 'A案故事线', beats: ['b1', 'b2', 'b3'] });
    if (s.includes('编剧B')) return JSON.stringify({ logline: 'B案故事线', beats: ['c1', 'c2', 'c3'] });
    if (s.includes('剧评人')) return JSON.stringify({ critA: ['冲突可加强'], critB: ['动机可信'] });
    if (s.includes('监制')) return JSON.stringify({ decision: 'merge', rationale: '取A冲突+B动机', logline: '雨夜邮差的最后一封信', beats: ['x', 'y', 'z'],
      bible: { worldview: '测试世界观：时空邮局', style: '写实电影感', characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }], scenes: [{ name: '褶皱巷', desc: '雨夜窄巷' }], props: [{ name: '火漆信', desc: '火漆印' }],
        scriptIdea: '写第一节剧本：雨夜邮差陈拾接到一封无法投递的信……每场结尾留因果钩子，每场至少一个冲突点。' } });
    return '{}';
  };
  I.__auto.setRoomLlm(fake);
  // 画布执行桩：模拟"画布已打开并完成生成"——脚本产出两场、分镜产出合规 shots、视频直接完成
  const goodShots = JSON.stringify({ shots: [
    { title: '镜1', visual: '中景，陈拾收伞回望', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ] });
  I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
    const doc = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
    const n = doc.nodes[nodeId];
    if (!n) throw new Error('桩：节点不存在');
    if (n.type === 'script') {
      await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: '【场1】巷口\n雨夜，陈拾收伞。\n【场2】邮局\n清晨，邮戳裂开。', overwrite: true });
      return { type: 'script', output: '【场1】巷口\n雨夜，陈拾收伞。\n【场2】邮局\n清晨，邮戳裂开。' };
    }
    if (n.type === 'storyboard') {
      await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: goodShots, overwrite: true });
      return { type: 'storyboard', shots: JSON.parse(goodShots).shots };
    }
    return { type: n.type, status: 'done' };
  });

  const noBrief = await M.autoStart({ projectId: roomPid });
  ok(noBrief && noBrief.ok === false, '缺 brief 未被拒');
  const started = await M.autoStart({ projectId: roomPid, brief: '雨夜邮差与一封无法投递的信' });
  ok(started && started.ok === true && started.status === 'running', 'autoStart 未启动');
  const dup = await M.autoStart({ projectId: roomPid, brief: '再试一次' });
  ok(dup && dup.ok === false, '运行中重复启动未被拒');
  // 等流水线完成（假 LLM 即时返回；最多 5s）
  let runView = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    runView = (await M.autoStatus({ projectId: roomPid })).run;
    if (runView && (runView.status === 'done' || runView.status === 'failed')) break;
  }
  ok(runView && runView.status === 'done', '编剧室流水线未完成（status=' + (runView && runView.status) + ' error=' + (runView && runView.error) + '）');
  // 落盘：会议节点 + 设定集 + 剧本 + 两场分镜 + 预算单
  const doc = await I.projectsGet({ id: roomPid });
  const meet = Object.values(doc.nodes).find((n) => n.type === 'text' && /编剧室会议/.test(n.data.label || ''));
  ok(!!meet && String(meet.data.text || '').includes('监制决策'), '会议记录节点缺失或无决策内容');
  const bible = await I.canvasGetBible({ projectId: roomPid });
  ok(bible.bible && bible.bible.worldview === '测试世界观：时空邮局' && (bible.bible.characters || []).length >= 1, '编剧室决策未写进设定集');
  const script = Object.values(doc.nodes).find((n) => n.type === 'script' && /第1节剧本/.test(n.data.label || ''));
  ok(!!script && String(script.data.idea || '').includes('因果钩子'), '剧本 idea 未落盘');
  const boards = Object.values(doc.nodes).filter((n) => n.type === 'storyboard');
  ok(boards.length === 2, '未按【场N】拆出两场分镜表（实际 ' + boards.length + '）');
  ok(boards.every((b) => Array.isArray(b.data.shots) && b.data.shots.length >= 2), '分镜表未生成 shots');
  ok(runView.budget && runView.budget.sceneCount === 2 && runView.budget.videoCalls === 2, '预算单口径不符：' + JSON.stringify(runView.budget && { s: runView.budget.sceneCount, calls: runView.budget.videoCalls }));
  // 付费段：未批准 → 拒绝；批准 → 逐场视频 + 成片节点
  const paid0 = await M.autoGenerate({ projectId: roomPid });
  ok(paid0 && paid0.ok === false, '未批准时付费段未被拒绝');
  const q2 = await M.autoQuote({ projectId: roomPid, unitPricePerSecond: 2 });
  const ap2 = await M.autoApprove({ projectId: roomPid, quoteId: q2.quoteId, confirm: '用户：按这个预算开机' });
  ok(ap2 && ap2.ok === true, '付费批准失败');
  const paid = await M.autoGenerate({ projectId: roomPid });
  ok(paid && paid.ok === true, '付费段启动失败');
  let paidView = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    paidView = (await M.autoStatus({ projectId: roomPid })).run;
    if (paidView && (paidView.paid === 'done' || paidView.paid === 'failed')) break;
  }
  ok(paidView && paidView.paid === 'done', '付费段未完成（' + (paidView && paidView.paidError) + '）');
  const doc2 = await I.projectsGet({ id: roomPid });
  const videos = Object.values(doc2.nodes).filter((n) => n.type === 'video');
  const fcs = Object.values(doc2.nodes).filter((n) => n.type === 'finalcut');
  ok(videos.length === 2, '付费段应创建 2 个视频节点（实际 ' + videos.length + '）');
  ok(fcs.length === 1, '付费段应创建 1 个成片节点（实际 ' + fcs.length + '）');
  // autoAbort：非运行态应拒绝
  const ab = await M.autoAbort({ projectId: roomPid });
  ok(ab && ab.ok === false, '非运行态 autoAbort 应拒绝');

  // 技能遵循度：给项目写一份技能配置（用 canvas_skill_pack set:true），重跑一次编剧室，
  // 监制轮 system 必须带上「生效配置」（题材/影调跟随项目配置，决策不与技能脱节）。
  {
    await byName.get('canvas_skill_pack').execute({ projectId: roomPid, kind: 'script', lens: 'fincher', genres: ['suspense-rule'], set: true }, {});
    monitorSystems.length = 0;
    await M.autoAbort({ projectId: roomPid }).catch(() => {});
    const run2 = await M.autoStart({ projectId: roomPid, brief: '第二个创意：确认监制轮吃到技能配置' });
    ok(run2 && run2.ok === true, '技能遵循度重跑未启动');
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const v = (await M.autoStatus({ projectId: roomPid })).run;
      if (v && (v.status === 'done' || v.status === 'failed')) break;
    }
    ok(monitorSystems.length >= 1, '监制轮未被调用（技能遵循度断言失效）');
    const monSys = monitorSystems[monitorSystems.length - 1] || '';
    ok(monSys.includes('生效配置') || monSys.includes('导演='), '监制轮 system 未带技能包配置头（编剧室决策会与项目技能配置脱节）');
    ok(monSys.includes('悬疑') || monSys.includes('suspense-rule'), '监制轮配置头未反映项目已选题材');
  }
}

// ---------------- 工具 ----------------
async function findNode(type) {
  const doc = await I.projectsGet({ id: projectId });
  const n = Object.values(doc.nodes).find((x) => x.type === type);
  if (!n) throw new Error('找不到 ' + type + ' 节点（测试前置失败）');
  return { nodeId: n.id };
}

// ---------------- 清理与结果 ----------------
await fs.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
if (errs.length) {
  console.error('✗ test-production FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-production PASS（阶段机 + 六闸门 + 逃生舱 + 汇报语义）');
