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
import { planShotSegments } from '../shot-segments.js';

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

// 预算单口径（0.20.2 #8）：videoCalls 按镜头切段算法估算（一个分镜表 ≠ 一次生成），不再按分镜表数粗算
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });
  const segPid = (await byName.get('canvas_create_project').execute({ name: '预算切段口径测试' }, {})).projectId;
  // 场 A：20s 分镜表（超默认 15s 上限、含 scene_change 切点）→ 客户端同款切段为 2 段（8s + 12s）
  const sbA = await byName.get('canvas_create_node').execute({ projectId: segPid, type: 'storyboard', name: '长表分镜' }, {});
  const shotsA = JSON.stringify({ shots: [
    { title: '镜1', visual: '中景，陈拾收伞回望', motion: '横移跟随', duration: 4, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '近景，伞面雨水滑落', motion: '缓推', duration: 4, seg: 'continuation', tail: '伞沿滴水', cam: '缓推' },
    { title: '镜3', visual: '全景，邮局门口亮灯', motion: '横摇', duration: 4, seg: 'scene_change', tail: '门灯光稳定', cam: '横摇到位' },
    { title: '镜4', visual: '中景，陈拾推门而入', motion: '跟拍', duration: 4, seg: 'continuation', tail: '手扶门框', cam: '跟拍向前' },
    { title: '镜5', visual: '近景，信封放上柜台', motion: '俯拍缓降', duration: 4, seg: 'continuation', tail: '信封落定', cam: '俯拍' },
  ] });
  // 注意用 canvas_update_node 整表替换（patch.shots 保留 seg/tail/cam 衔接字段）：
  // canvas_write_node 的 output→shots 解析会丢 seg，切段推断就退化成全续帧链了。
  await byName.get('canvas_update_node').execute({ projectId: segPid, nodeId: sbA.nodeId, patch: { shots: JSON.parse(shotsA).shots } }, {});
  // 场 B：5s 分镜表（15s 内）→ 1 段
  const sbB = await byName.get('canvas_create_node').execute({ projectId: segPid, type: 'storyboard', name: '短表分镜' }, {});
  const shotsB = JSON.stringify({ shots: [
    { title: '镜1', visual: '近景，邮戳裂开', motion: '缓推', duration: 3, seg: 'opening', tail: '裂开定格', cam: '推进到位' },
    { title: '镜2', visual: '大特写，火漆印反光', motion: '微移', duration: 2, seg: 'closeup', tail: '反光闪烁', cam: '微移' },
  ] });
  await byName.get('canvas_update_node').execute({ projectId: segPid, nodeId: sbB.nodeId, patch: { shots: JSON.parse(shotsB).shots } }, {});

  const qs = await M.autoQuote({ projectId: segPid, unitPricePerSecond: 2 });
  ok(qs && qs.ok === true, '预算口径：autoQuote 失败');
  eq(qs.sceneCount, 2, '预算口径：两场分镜表');
  eq(qs.videoCalls, 3, '预算口径：videoCalls 应为两场段数之和（场A 2 段 + 场B 1 段 = 3），≠ 分镜表数 2');
  ok(qs.videoCalls !== qs.sceneCount, '预算口径：videoCalls 仍按分镜表数粗算（= 场数）→ 预算单再次失真');
  // 每场行项目带 videoCalls / maxSeconds：用户能看到每场拆几段、用的什么上限
  const scA = qs.scenes.find((s) => s.storyboardId === sbA.nodeId);
  const scB = qs.scenes.find((s) => s.storyboardId === sbB.nodeId);
  eq(scA && scA.videoCalls, 2, '预算口径：场 A（20s 含切点）应切 2 段');
  eq(scA && scA.maxSeconds, 15, '预算口径：场 A 未配 segMaxSeconds → 默认上限 15');
  eq(scB && scB.videoCalls, 1, '预算口径：场 B（5s）应 1 段');
  eq(qs.totalSeconds, 25, '预算口径：totalSeconds 口径不变（20+5）');
  eq(qs.estimatedCost, 50, '预算口径：估算金额仍按秒计（25s×2）');
  ok(String(qs.note).includes('切段'), '预算口径：note 应如实描述按镜头切段调用（实际：' + qs.note + '）');

  // 指纹自然变化（预期行为，无兼容垫片）：segMaxSeconds 挂在分镜表节点 data（客户端 L13883 同式），
  // 上限变更 → 每场上限进指纹 → 旧批准自动失效 → 重新复核预算。
  const ap0 = await M.autoApprove({ projectId: segPid, quoteId: qs.quoteId, confirm: '用户：按这个预算开机' });
  ok(ap0 && ap0.ok === true, '预算口径：按段数批准失败');
  const docSeg = await I.projectsGet({ id: segPid });
  docSeg.nodes[sbB.nodeId].data.segMaxSeconds = 30;
  await I.projectsPut({ id: segPid, doc: docSeg });
  const stQ = await M.autoStatus({ projectId: segPid });
  ok(stQ.approval && stQ.approval.valid === false, '预算口径：segMaxSeconds 变更后旧批准仍有效（指纹未吃每场上限）');
  const q30 = P.quote(segPid, null, 2);
  const scB30 = q30.scenes.find((s) => s.storyboardId === sbB.nodeId);
  eq(scB30 && scB30.maxSeconds, 30, '预算口径：分镜表节点 data.segMaxSeconds=30 应被 quote 读取（客户端同式）');

  // 已有视频的表不产生新调用：给场 B 接上视频 → 该场 videoCalls 归 0，总调用数降为 2
  const vB = await byName.get('canvas_create_node').execute({ projectId: segPid, type: 'video', name: '短表视频', connectFrom: sbB.nodeId }, {});
  ok(vB && vB.ok === true, '预算口径：场 B 建视频失败（' + JSON.stringify(vB && { gate: vB.gate, error: vB.error }) + '）');
  const qv = await M.autoQuote({ projectId: segPid, unitPricePerSecond: 2 });
  const scBv = qv.scenes.find((s) => s.storyboardId === sbB.nodeId);
  eq(scBv && scBv.videoCalls, 0, '预算口径：已有视频的场不应再计调用');
  eq(qv.videoCalls, 2, '预算口径：场 B 接视频后总调用数应为 2（只剩场 A 的 2 段）');
  await M.autoModeSet({ enabled: false });
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

// ============================ 四、工具 handler 直调回归（0.20.2 P0：裸调炸穿） ============================
// 0.20.1 实机 bug：工具注册区 execute 裸调 methods 成员（productionStatus / productionCapabilities /
// productionAdvance）→ ReferenceError（status 路径无兜底实机炸穿；capabilities 被外层 try/catch
// 静默吞掉 → 「多智能体能力」行永不显示）。直调 methods（I.rpcMethods()）永远测不出此类 bug——
// 那正是 0.20.0 漏测的原因。必须直调工具注册对象的 execute handler（fakeCtx 捕获的工具表）。
{
  const statusTool = byName.get('canvas_production_status');
  const advanceTool = byName.get('canvas_production_advance');
  ok(!!statusTool && typeof statusTool.execute === 'function', '工具表缺 canvas_production_status（execute）');
  ok(!!advanceTool && typeof advanceTool.execute === 'function', '工具表缺 canvas_production_advance（execute）');

  const realGet = fakeCtx.get;
  try {
    // 探针给真话：sessionController 在场 → capabilities 真实执行后 multiAgent 应为 true。
    // （裸调版本：ReferenceError 被 execute 内 try/catch 吞掉 → capsLine 恒空 → multiAgent 恒 false）
    fakeCtx.get = (key) => (key === 'sessionController' ? { __probe: true } : undefined);
    const st = await statusTool.execute({ projectId }, {});
    ok(st && st.ok === true, 'handler 直调: canvas_production_status 应 ok:true（裸调会炸 ReferenceError）');
    ok(st && typeof st.stage === 'string' && st.stage.length > 0, 'handler 直调: status 应携带 stage 字段');
    ok(st && typeof st.ready === 'boolean', 'handler 直调: status 应携带 ready 字段');
    eq(st && st.multiAgent, true, 'handler 直调: capabilities 探针应真实执行（capsLine 已生成；裸调被吞时恒为 false）');
    ok(st && typeof st.text === 'string' && st.text.includes('多智能体能力：可用（宿主已暴露会话服务'), 'handler 直调: capabilities 文本行应显示「可用」（sessionController 在场；裸调被吞时无此行）');

    // advance：按 parameters 构造合法调用（projectId + 合法 to + 必填 reason），当前阶段 storyboard → shots_ready
    const adv = await advanceTool.execute({ projectId, to: 'shots_ready', reason: '回归：显式推进到分镜就绪' }, {});
    ok(adv && adv.ok === true, 'handler 直调: canvas_production_advance 合法推进应 ok:true');
    eq(adv && adv.stage, 'shots_ready', 'handler 直调: advance 应返回目标阶段');

    // 错误路径也不许裸调炸穿：缺 reason → 业务拒绝（ok:false），绝非 undefined function
    const noReason = await advanceTool.execute({ projectId, to: 'bible' }, {});
    ok(noReason && noReason.ok === false, 'handler 直调: 缺 reason 应业务拒绝');
    ok(noReason && !/not defined|not a function|ReferenceError/i.test(String(noReason.text)), 'handler 直调: 缺 reason 的拒绝应为业务错误而非 undefined function');

    // 缺 projectId → 业务拒绝
    const noPid = await statusTool.execute({}, {});
    ok(noPid && noPid.ok === false, 'handler 直调: 缺 projectId 应业务拒绝');
    ok(noPid && !/not defined|not a function|ReferenceError/i.test(String(noPid.text)), 'handler 直调: 缺 projectId 的拒绝应为业务错误而非 undefined function');

    // 探针失败路径：ctx.get 恒抛错 → productionCapabilities 内部 svc() 应兜住 → 降级行「不可用」，
    // execute 主结果不受影响（catch 按设计吞探针失败，不吞主结果）
    fakeCtx.get = () => { throw new Error('probe boom'); };
    const st2 = await statusTool.execute({ projectId }, {});
    ok(st2 && st2.ok === true, 'handler 直调: 探针抛错时 status 仍应 ok:true（catch 按设计生效）');
    ok(st2 && typeof st2.text === 'string' && st2.text.includes('多智能体能力：不可用（宿主未暴露'), 'handler 直调: 探针抛错时应降级显示「不可用」（裸调被吞时无此行）');
    ok(st2 && st2.multiAgent === false, 'handler 直调: 探针抛错时 multiAgent 应为 false（svc 内部兜住，探针实测不可用）');

    // 降级真话路径（multiAgent 误匹配回归）：恢复默认 mock（无任何会话服务）→ capabilities 正常执行
    // 但 multiAgent:false → 返回字段必须如实为 false。修复前用 capsLine.includes('可用（') 判定，
    // 「不可用（宿主未暴露…」同样含子串「可用（」→ 恒 true，误导下游自动创作判断。
    fakeCtx.get = realGet;
    const st3 = await statusTool.execute({ projectId }, {});
    ok(st3 && st3.ok === true, 'handler 直调: 默认降级 mock 下 status 应 ok:true');
    eq(st3 && st3.multiAgent, false, 'handler 直调: 无会话服务时返回 multiAgent 应如实为 false（includes 误匹配修复前恒 true）');
    ok(st3 && typeof st3.text === 'string' && st3.text.includes('多智能体能力：不可用（宿主未暴露'), 'handler 直调: 无会话服务时文本行应显示「不可用」');
  } finally {
    fakeCtx.get = realGet; // 恢复降级 mock，不污染后续断言语境
  }
}

// ============================ 五、监制决策轮 JSON 兜底回归（0.20.2 P1：解析健壮化 + 局部重试） ============================
// 0.20.1 实机：监制轮散文夹杂非 JSON 花括号（roomJson 取第一个 `{` 误杀）或纯散文（needJson 失败直接 throw）
// → 整个 run failed。回归：roomJson 循环所有 `{` 候选位；needJson 失败局部重试一次（user 尾带「只输出 JSON」）；
//   两轮皆散文 → 原失败语义保留。
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });

  // 完整 decision/bible 形状（照抄编剧室块 fake；worldview 换值以证明断言吃的是本项目产出）
  const baseDec = () => ({ decision: 'merge', rationale: '取A冲突+B动机', logline: '雨夜邮差的最后一封信', beats: ['x', 'y', 'z'],
    bible: { worldview: '兜底世界观：时空邮局', style: '写实电影感', characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }], scenes: [{ name: '褶皱巷', desc: '雨夜窄巷' }], props: [{ name: '火漆信', desc: '火漆印' }],
      scriptIdea: '写第一节剧本：雨夜邮差陈拾接到一封无法投递的信……每场结尾留因果钩子，每场至少一个冲突点。' } });

  // 画布执行桩（同编剧室块手法）：脚本产出两场、分镜产出合规 shots，其余类型直接完成
  const goodShots = JSON.stringify({ shots: [
    { title: '镜1', visual: '中景，陈拾收伞回望', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ] });
  I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
    const doc = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
    const n = doc.nodes[nodeId];
    if (!n) throw new Error('桩：节点不存在');
    if (n.type === 'script') {
      const out = '【场1】巷口\n雨夜，陈拾收伞。\n【场2】邮局\n清晨，邮戳裂开。';
      await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: out, overwrite: true });
      return { type: 'script', output: out };
    }
    if (n.type === 'storyboard') {
      await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: goodShots, overwrite: true });
      return { type: 'storyboard', shots: JSON.parse(goodShots).shots };
    }
    return { type: n.type, status: 'done' };
  });

  // 假 LLM：非监制角色照抄编剧室块；监制按 monitorRaws() 依次给输出（超次数复用最后一个），记录调用数与 user
  const monitorFake = (monitorRaws) => {
    const calls = { monitor: 0, users: [] };
    const fn = async ({ system, user }) => {
      const s = String(system || '');
      if (s.includes('监制')) {
        calls.monitor++;
        calls.users.push(String(user || ''));
        const outs = monitorRaws();
        return outs[Math.min(calls.monitor - 1, outs.length - 1)];
      }
      if (s.includes('调研员')) return JSON.stringify({ themes: [{ name: '时空邮差', why: 't' }], styles: ['写实电影感'] });
      if (s.includes('编剧A')) return JSON.stringify({ logline: 'A案故事线', beats: ['b1', 'b2', 'b3'] });
      if (s.includes('编剧B')) return JSON.stringify({ logline: 'B案故事线', beats: ['c1', 'c2', 'c3'] });
      if (s.includes('剧评人')) return JSON.stringify({ critA: ['冲突可加强'], critB: ['动机可信'] });
      return '{}';
    };
    return { calls, fn };
  };

  const waitRunEnd = async (pid2) => {
    let v = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      v = (await M.autoStatus({ projectId: pid2 })).run;
      if (v && (v.status === 'done' || v.status === 'failed' || v.status === 'aborted')) break;
    }
    return v;
  };

  // ① 修复A：监制首轮 = 散文含非 JSON 花括号 + 围栏外合法 JSON → 首轮即可解析，不重试（监制调用 =1）
  {
    const pidA = (await byName.get('canvas_create_project').execute({ name: '监制JSON兜底A-扫描健壮化' }, {})).projectId;
    const f = monitorFake(() => ['我认为{这是花括号}不算JSON……\n' + JSON.stringify(baseDec())]);
    I.__auto.setRoomLlm(f.fn);
    const started = await M.autoStart({ projectId: pidA, brief: '修复A回归：散文花括号不误杀后面的真 JSON' });
    ok(started && started.ok === true, '修复A: autoStart 未启动');
    const v = await waitRunEnd(pidA);
    ok(v && v.status === 'done', '修复A: 流水线未 done（status=' + (v && v.status) + ' error=' + (v && v.error) + '）');
    eq(f.calls.monitor, 1, '修复A: 首轮即可解析时不应触发重试（监制调用数应为 1）');
    const bible = await I.canvasGetBible({ projectId: pidA });
    ok(bible.bible && bible.bible.worldview === '兜底世界观：时空邮局', '修复A: 决策未落盘设定集');
  }

  // ② 修复B：首轮纯散文 → 局部重试一次（user 尾带「只输出 JSON」）→ 次轮合法 JSON → done，监制调用 =2，log 含重试标记
  {
    const pidB = (await byName.get('canvas_create_project').execute({ name: '监制JSON兜底B-局部重试' }, {})).projectId;
    const f = monitorFake(() => ['我们决定融合两案，理由如下（没有任何 JSON）。', JSON.stringify(baseDec())]);
    I.__auto.setRoomLlm(f.fn);
    const started = await M.autoStart({ projectId: pidB, brief: '修复B回归：散文首轮局部重试一次' });
    ok(started && started.ok === true, '修复B: autoStart 未启动');
    const v = await waitRunEnd(pidB);
    ok(v && v.status === 'done', '修复B: 重试后流水线未 done（status=' + (v && v.status) + ' error=' + (v && v.error) + '）');
    eq(f.calls.monitor, 2, '修复B: 散文首轮应恰好局部重试一次（监制调用数应为 2）');
    ok((f.calls.users[1] || '').includes('只输出 JSON'), '修复B: 重试轮 user 尾部未带「只输出 JSON」指令');
    ok((f.calls.users[1] || '').startsWith(f.calls.users[0] || '\u0000'), '修复B: 重试轮未在原 user 基础上追加重试指令');
    const runB = I.__auto.runs.get(pidB + '::default');
    ok(!!runB && Array.isArray(runB.log) && runB.log.some((e) => /自动重试一次/.test(String(e.summary))), '修复B: run.log 缺重试标记');
    const bible = await I.canvasGetBible({ projectId: pidB });
    ok(bible.bible && bible.bible.worldview === '兜底世界观：时空邮局', '修复B: 重试轮决策未落盘设定集');
  }

  // ③ 失败语义保留：两轮都散文 → run failed，error 含「监制 输出不是可用 JSON」（重试恰一次）
  {
    const pidC = (await byName.get('canvas_create_project').execute({ name: '监制JSON兜底C-失败语义' }, {})).projectId;
    const f = monitorFake(() => ['我们决定融合两案（无 JSON）。', '还是散文好写（依旧无 JSON）。']);
    I.__auto.setRoomLlm(f.fn);
    const started = await M.autoStart({ projectId: pidC, brief: '修复C回归：两轮皆散文保留原失败语义' });
    ok(started && started.ok === true, '修复C: autoStart 未启动');
    const v = await waitRunEnd(pidC);
    ok(v && v.status === 'failed', '修复C: 两轮皆散文应 run failed（status=' + (v && v.status) + '）');
    ok(String((v && v.error) || '').includes('监制 输出不是可用 JSON'), '修复C: error 未保留原失败语义（实际：' + (v && v.error) + '）');
    eq(f.calls.monitor, 2, '修复C: 重试应恰好一次（监制调用数应为 2）');
  }
}

// ============================ 六、G2 重生成注入失败清单回归（0.20.2 P1：重生成不带清单=原样再犯） ============================
// 0.20.1 实机：场2 分镜 G2 首轮 11 项不合规，自动重生成一次后「仍有 11 项」一模一样——宿主原样重跑，
// 失败清单只进 run.log 没进提示词（客户端 aiStoryboardShots 每次生成都读节点 data.requirement 拼提示词）。
// 回归：重跑前 requirement 必须含「G2 复检」+ gate.fails 全清单（逐条编号，不 slice）；复检后还原；log 条目带「已注入清单」。
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });

  // 首轮 shots：缺时长 + 景别不具体 + 全表无大特写——先实跑真闸门确认 fails.length > 0，否则整个用例失效
  const badShotsArr = [{ title: '镜1', visual: '他走过来', motion: '', duration: 0 }];
  const preGate = P.gateStoryboard(badShotsArr);
  ok(preGate.ok === false && preGate.fails.length >= 3, 'G2注入前置: 首轮 shots 应被真闸门拒绝（fails=' + JSON.stringify(preGate.fails) + '）');
  const goodShotsArr = [
    { title: '镜1', visual: '中景，雨夜巷口，陈拾收伞', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ];
  eq(P.gateStoryboard(goodShotsArr).ok, true, 'G2注入前置: 复检 shots 应过真闸门');

  // 假 LLM：非监制角色照旧；监制首轮即合法 JSON（不触发决策重试，聚焦分镜重生成）
  I.__auto.setRoomLlm(async ({ system }) => {
    const s = String(system || '');
    if (s.includes('调研员')) return JSON.stringify({ themes: [{ name: '时空邮差', why: 't' }], styles: ['写实电影感'] });
    if (s.includes('编剧A')) return JSON.stringify({ logline: 'A案故事线', beats: ['b1', 'b2', 'b3'] });
    if (s.includes('编剧B')) return JSON.stringify({ logline: 'B案故事线', beats: ['c1', 'c2', 'c3'] });
    if (s.includes('剧评人')) return JSON.stringify({ critA: ['冲突可加强'], critB: ['动机可信'] });
    if (s.includes('监制')) return JSON.stringify({ decision: 'merge', rationale: '取A冲突+B动机', logline: '雨夜邮差的最后一封信', beats: ['x', 'y', 'z'],
      bible: { worldview: 'G2注入世界观：时空邮局', style: '写实电影感', characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }], scenes: [{ name: '褶皱巷', desc: '雨夜窄巷' }], props: [{ name: '火漆信', desc: '火漆印' }],
        scriptIdea: '写第一节剧本：雨夜邮差陈拾接到一封无法投递的信……每场结尾留因果钩子，每场至少一个冲突点。' } });
    return '{}';
  });

  // 画布执行桩：脚本产出一场（聚焦单个分镜表的 G2 循环）；分镜**首轮**返回不合规 shots，
  // 检测到节点 data.requirement 含「G2 复检」（宿主已注入清单）→ 返回合规 shots（模拟模型照清单改正）
  const reqSeen = []; // 桩内捕获：每次分镜 exec 前节点的 data.requirement
  I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
    const doc = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
    const n = doc.nodes[nodeId];
    if (!n) throw new Error('桩：节点不存在');
    if (n.type === 'script') {
      const out = '【场1】褶皱巷\n雨夜，陈拾收伞，发现邮戳裂开。';
      await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: out, overwrite: true });
      return { type: 'script', output: out };
    }
    if (n.type === 'storyboard') {
      const req = String((n.data && n.data.requirement) || '');
      reqSeen.push(req);
      const shots = req.includes('G2 复检') ? goodShotsArr : badShotsArr;
      await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: JSON.stringify({ shots }), overwrite: true });
      return { type: 'storyboard', shots };
    }
    return { type: n.type, status: 'done' };
  });

  const pidG = (await byName.get('canvas_create_project').execute({ name: 'G2重生成注入清单' }, {})).projectId;
  const started = await M.autoStart({ projectId: pidG, brief: 'G2注入回归：重生成前必须把全量失败清单写进分镜额外要求' });
  ok(started && started.ok === true, 'G2注入: autoStart 未启动');
  let vG = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    vG = (await M.autoStatus({ projectId: pidG })).run;
    if (vG && (vG.status === 'done' || vG.status === 'failed' || vG.status === 'aborted')) break;
  }
  // ① 流水线 done（首轮拒 → 注入清单 → 桩照清单改正 → 复检过闸）
  ok(vG && vG.status === 'done', 'G2注入: 流水线未 done（status=' + (vG && vG.status) + ' error=' + (vG && vG.error) + '）');
  eq(reqSeen.length, 2, 'G2注入: 分镜应恰好执行两次（首轮+重生成一次，实际 ' + reqSeen.length + '）');
  ok(reqSeen[0] === '', 'G2注入: 首轮 exec 前节点 requirement 应为原值（空，实际：' + JSON.stringify(reqSeen[0]) + '）');
  // ② 第二次 exec 前已注入「G2 复检」重试块与首个失败项关键字（桩内捕获）
  ok(String(reqSeen[1] || '').includes('G2 复检'), 'G2注入: 重生成前 requirement 未含「G2 复检」重试块');
  ok(String(reqSeen[1] || '').includes(preGate.fails[0]), 'G2注入: 重生成前 requirement 未含首个失败项（' + preGate.fails[0] + '）');
  // 全清单，不是 slice(0,2)——日志可以截断，提示词不能：每一个失败项都要进提示词
  const missingFails = preGate.fails.filter((f) => !String(reqSeen[1] || '').includes(f));
  eq(missingFails.length, 0, 'G2注入: 清单被截断，缺失项 → ' + JSON.stringify(missingFails));
  ok(String(reqSeen[1] || '').includes('1. ' + preGate.fails[0]), 'G2注入: 失败项未逐条编号列出');
  ok(String(reqSeen[1] || '').startsWith('【G2 复检'), 'G2注入: 原 requirement 为空时应只写重试块（不带前导追加）');
  // ③ 复检后还原 requirement 为原值（不污染节点数据）
  const docG = await I.projectsGet({ id: pidG });
  const sbG = Object.values(docG.nodes).find((n2) => n2.type === 'storyboard');
  ok(!!sbG, 'G2注入: 分镜节点缺失（测试前置失败）');
  eq(sbG && String(sbG.data.requirement || ''), '', 'G2注入: 复检后 requirement 未还原为原值（空）');
  // ④ run.log 重生成条目保持现有格式并追加「已注入清单」
  const runG = I.__auto.runs.get(pidG + '::default');
  ok(!!runG && Array.isArray(runG.log) && runG.log.some((e) => /G2 未过，自动重生成（已注入清单）/.test(String(e.summary))), 'G2注入: run.log 重生成条目缺「已注入清单」标记');
  ok(Array.isArray(vG && vG.boards) && vG.boards.length === 1 && vG.boards[0].gate === true, 'G2注入: 重生成后分镜应过闸（boards=' + JSON.stringify(vG && vG.boards) + '）');
}

// ============================ 七、场时长硬约束回归（0.20.2 T5：每场 ≤15 秒两层防线） ============================
// 0.20.1 实机：项目指南写明「每场 ≤15 秒」，编剧室照样产出 40.0/16.0/33.9/29.5 秒的场——
// 监制轮提示词对时长零约束（防线①缺失），分镜产出后也没有机械校验（防线②缺失）。
// 回归：① 监制输出指令含「每场」「15 秒」锚点；② 超时 shots 触发 requirement 注入「时长约束」→
// 桩照要求改正 → done、videoCalls=1、requirement 还原；③ G2+时长双违 → 合并注入、一次重跑两关都过；
// ④ 复检仍超时 → 不阻塞（done），log 含「仍超时长（秒/段）」，videoCalls 如实 >1。
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });

  // 超时但 G2 合规的 shots（40s：13+14+13；景别齐全、含大特写、无连续三镜同运动）——防线②唯一触发面
  const overShotsArr = [
    { title: '镜1', visual: '全景，雨夜巷口霓虹湿漉', motion: '横移跟随', duration: 13, seg: 'opening', tail: '伞面合拢', cam: '横移回正' },
    { title: '镜2', visual: '中景，陈拾踏水而行', motion: '跟拍向前', duration: 14, seg: 'continuation', tail: '脚步停住', cam: '跟拍减速' },
    { title: '镜3', visual: '大特写，信封上火漆印裂开', motion: '缓推', duration: 13, seg: 'closeup', tail: '裂纹定格', cam: '推进到位' },
  ];
  const goodShotsArr = [
    { title: '镜1', visual: '中景，陈拾收伞回望', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ];
  // 既 G2 不合规（景别不具体 + 无大特写）又超时（22s/18s 超限单镜）——合并注入触发面
  const badAndOverArr = [
    { title: '镜1', visual: '他走过来', motion: '推', duration: 22 },
    { title: '镜2', visual: '他停下', motion: '推', duration: 18 },
  ];
  // 前置自证：三组 fixtures 吃的闸门/切段判据都对，否则整个块失效
  eq(P.gateStoryboard(overShotsArr).ok, true, '时长前置: 超时 shots 必须先过 G2（否则触发面混淆）');
  eq(P.gateStoryboard(goodShotsArr).ok, true, '时长前置: goodShots 应过 G2');
  const preGateT5 = P.gateStoryboard(badAndOverArr);
  ok(preGateT5.ok === false && preGateT5.fails.length >= 2, '时长前置: 双违 shots 应被 G2 拒绝（fails=' + JSON.stringify(preGateT5.fails) + '）');
  ok(planShotSegments(overShotsArr).segments.length > 1, '时长前置: 40s shots 应切 >1 段');
  eq(planShotSegments(goodShotsArr).segments.length, 1, '时长前置: goodShots 应 1 段');
  ok(planShotSegments(badAndOverArr).segments.length > 1, '时长前置: 双违 shots 应切 >1 段');

  // 假 LLM：非监制照旧；监制首轮即合法 JSON（聚焦分镜循环），并捕获监制轮 system+user（防线①锚点断言用）
  const monCaptured = [];
  I.__auto.setRoomLlm(async ({ system, user }) => {
    const s = String(system || '');
    if (s.includes('监制')) {
      monCaptured.push({ system: s, user: String(user || '') });
      return JSON.stringify({ decision: 'merge', rationale: '取A冲突+B动机', logline: '雨夜邮差的最后一封信', beats: ['x', 'y', 'z'],
        bible: { worldview: '时长回归世界观：时空邮局', style: '写实电影感', characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }], scenes: [{ name: '褶皱巷', desc: '雨夜窄巷' }], props: [{ name: '火漆信', desc: '火漆印' }],
          scriptIdea: '写第一节剧本：雨夜邮差陈拾接到一封无法投递的信……每场结尾留因果钩子，每场至少一个冲突点。' } });
    }
    if (s.includes('调研员')) return JSON.stringify({ themes: [{ name: '时空邮差', why: 't' }], styles: ['写实电影感'] });
    if (s.includes('编剧A')) return JSON.stringify({ logline: 'A案故事线', beats: ['b1', 'b2', 'b3'] });
    if (s.includes('编剧B')) return JSON.stringify({ logline: 'B案故事线', beats: ['c1', 'c2', 'c3'] });
    if (s.includes('剧评人')) return JSON.stringify({ critA: ['冲突可加强'], critB: ['动机可信'] });
    return '{}';
  });

  const waitDoneT5 = async (pid2) => {
    let v = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      v = (await M.autoStatus({ projectId: pid2 })).run;
      if (v && (v.status === 'done' || v.status === 'failed' || v.status === 'aborted')) break;
    }
    return v;
  };
  // 画布执行桩工厂：脚本产出一场；分镜桩在 exec 前捕获节点 requirement，由 pickShots 决定返回哪版 shots
  const runWith = async (name, pickShots, reqSeen) => {
    I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
      const doc = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
      const n = doc.nodes[nodeId];
      if (!n) throw new Error('桩：节点不存在');
      if (n.type === 'script') {
        const out = '【场1】褶皱巷\n雨夜，陈拾收伞，发现邮戳裂开。';
        await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: out, overwrite: true });
        return { type: 'script', output: out };
      }
      if (n.type === 'storyboard') {
        const req = String((n.data && n.data.requirement) || '');
        reqSeen.push(req);
        const shots = pickShots(req);
        await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: JSON.stringify({ shots }), overwrite: true });
        return { type: 'storyboard', shots };
      }
      return { type: n.type, status: 'done' };
    });
    const pidX = (await byName.get('canvas_create_project').execute({ name }, {})).projectId;
    const started = await M.autoStart({ projectId: pidX, brief: name + '：场时长硬约束回归' });
    ok(started && started.ok === true, name + ': autoStart 未启动');
    const v = await waitDoneT5(pidX);
    const run = I.__auto.runs.get(pidX + '::default');
    const doc = await I.projectsGet({ id: pidX });
    const sb = Object.values(doc.nodes).find((n2) => n2.type === 'storyboard');
    return { v, run, doc, sb };
  };

  // ①② 防线①锚点 + 防线②生效：首轮超时 → 注入「时长约束」→ 桩改正 → done + videoCalls=1 + 还原
  const reqSeen2 = [];
  const r2 = await runWith('时长防线②修复回路', (req) => (req.includes('时长约束') ? goodShotsArr : overShotsArr), reqSeen2);
  ok(r2.v && r2.v.status === 'done', '防线②: 流水线未 done（status=' + (r2.v && r2.v.status) + ' error=' + (r2.v && r2.v.error) + '）');
  ok(monCaptured.length >= 1, '防线①: 监制轮未被调用');
  const monText = monCaptured.map((c) => c.system + '\n' + c.user).join('\n');
  ok(monText.includes('每场') && monText.includes('15 秒'), '防线①: 监制轮 system+user 缺「每场 / 15 秒」硬约束锚点');
  eq(reqSeen2.length, 2, '防线②: 分镜应恰好执行两次（首轮+重生成一次，实际 ' + reqSeen2.length + '）');
  eq(reqSeen2[0], '', '防线②: 首轮 exec 前 requirement 应为原值（空）');
  ok(String(reqSeen2[1]).startsWith('【时长约束】'), '防线②: 原 requirement 为空时应只写时长块（不带前导追加）');
  ok(String(reqSeen2[1]).includes('40 秒超过 15 秒上限'), '防线②: 时长块缺超时事实（40 秒超过 15 秒上限，实际：' + JSON.stringify(reqSeen2[1]) + '）');
  ok(String(reqSeen2[1]).includes('镜1=13s') && String(reqSeen2[1]).includes('镜3=13s'), '防线②: 时长块缺逐镜超时明细');
  ok(!String(reqSeen2[1]).includes('G2 复检'), '防线②: G2 已过时不应混入「G2 复检」块（触发面混淆）');
  ok(!!r2.sb, '防线②: 分镜节点缺失');
  eq(r2.sb && String(r2.sb.data.requirement || ''), '', '防线②: 复检后 requirement 未还原为原值（空）');
  ok(r2.v && r2.v.budget && r2.v.budget.videoCalls === 1, '防线②: 改正后预算单 videoCalls 应为 1（实际：' + JSON.stringify(r2.v && r2.v.budget && r2.v.budget.videoCalls) + '）');
  ok(Array.isArray(r2.v && r2.v.boards) && r2.v.boards.length === 1 && r2.v.boards[0].gate === true, '防线②: 改正后分镜应过闸');
  const logs2 = (r2.run && Array.isArray(r2.run.log)) ? r2.run.log.map((e) => String(e.summary)) : [];
  ok(logs2.some((t) => t.includes('已注入时长约束')), '防线②: run.log 缺重生成条目「已注入时长约束」');
  ok(!logs2.some((t) => t.includes('仍超时长')), '防线②: 改正后不应有「仍超时长」条目');

  // ③ 合并注入：首轮既不合规又超时 → 重试 requirement 同时含「G2 复检」与「时长约束」，一次重跑两关都过
  const reqSeen3 = [];
  const r3 = await runWith('时长防线③合并注入', (req) => ((req.includes('时长约束') && req.includes('G2 复检')) ? goodShotsArr : badAndOverArr), reqSeen3);
  ok(r3.v && r3.v.status === 'done', '合并注入: 流水线未 done（status=' + (r3.v && r3.v.status) + ' error=' + (r3.v && r3.v.error) + '）');
  eq(reqSeen3.length, 2, '合并注入: 两块必须合并为一次重跑（分镜应恰好执行两次，实际 ' + reqSeen3.length + '）');
  ok(String(reqSeen3[1]).includes('G2 复检'), '合并注入: 重试 requirement 缺「G2 复检」块');
  ok(String(reqSeen3[1]).includes('【时长约束】'), '合并注入: 重试 requirement 缺「时长约束」块');
  ok(String(reqSeen3[1]).startsWith('【G2 复检'), '合并注入: G2 块应在前（原 requirement 为空时不带前导追加）');
  const missingFails3 = preGateT5.fails.filter((f) => !String(reqSeen3[1]).includes(f));
  eq(missingFails3.length, 0, '合并注入: G2 全清单必须逐条进 requirement，缺失 → ' + JSON.stringify(missingFails3));
  ok(Array.isArray(r3.v && r3.v.boards) && r3.v.boards[0] && r3.v.boards[0].gate === true, '合并注入: 复检应过闸');
  ok(r3.v && r3.v.budget && r3.v.budget.videoCalls === 1, '合并注入: 一次重生成后两关都过，videoCalls 应为 1（实际：' + JSON.stringify(r3.v && r3.v.budget && r3.v.budget.videoCalls) + '）');

  // ④ 复检仍超时不阻塞：桩始终返回超时 shots → 流水线仍 done，log 记「仍超时长（秒/段）」，videoCalls 如实 >1
  const reqSeen4 = [];
  const r4 = await runWith('时长防线④仍超时不阻塞', () => overShotsArr, reqSeen4);
  ok(r4.v && r4.v.status === 'done', '仍超时: 复检超时不应炸流水线（status=' + (r4.v && r4.v.status) + ' error=' + (r4.v && r4.v.error) + '）');
  eq(reqSeen4.length, 2, '仍超时: 重跑上限仍是一次（实际执行 ' + reqSeen4.length + ' 次）');
  const logs4 = (r4.run && Array.isArray(r4.run.log)) ? r4.run.log.map((e) => String(e.summary)) : [];
  ok(logs4.some((t) => t.includes('仍超时长')), '仍超时: run.log 缺「仍超时长」条目');
  ok(logs4.some((t) => t.includes('仍超时长（40 秒/3 段）')), '仍超时: 「仍超时长」条目缺秒数/段数明细（logs=' + JSON.stringify(logs4) + '）');
  ok(r4.v && r4.v.budget && r4.v.budget.videoCalls > 1, '仍超时: 预算单 videoCalls 应如实 >1（实际：' + JSON.stringify(r4.v && r4.v.budget && r4.v.budget.videoCalls) + '）');
  eq(r4.sb && String(r4.sb.data.requirement || ''), '', '仍超时: requirement 仍应还原为原值（空）');
}

// ============================ 八、付费段按镜头切段拆分（0.20.2 T6：#10 长场整表一次请求撞厂商上限） ============================
// 0.20.1 实机：手动 40s 场整场一次请求 → 中转站 400（超厂商上限）；autoPaid 旧逻辑每张分镜表只建
// 1 个 video 节点、不带镜头区间，长场在付费段必然同样被拒，且与 T4 的按段预算脱节。
// 回归：① 40s 场（15s 上限）拆 3 段、16s 场拆 2 段、5s 场仍 1 个节点（不退化），段名带「段k/N」、
// 全部 connectFrom 分镜表，finalcut 连最后一个完成的段节点；② 每段 prompt 带「第 X-Y 镜」与段序号、
// data 带客户端 videoSegmentOf 消费的段键（segShotFrom/To/segIndex/segCount/needsTailChain/seamRisk）；
// ③ 批准后改 shots → 重新批准 → autoPaid 照跑，run.log 记「预算与实际段数不一致（预算 N / 实际 M）」。
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });

  // 三组 G2 合规 fixtures：40s（13+14+13，切段 3 段）/ 16s（4×4，镜3 换场切点 → 2 段）/ 5s（3+2，1 段）
  const longShotsArr = [
    { title: '镜1', visual: '全景，雨夜巷口霓虹湿漉', motion: '横移跟随', duration: 13, seg: 'opening', tail: '伞面合拢', cam: '横移回正' },
    { title: '镜2', visual: '中景，陈拾踏水而行', motion: '跟拍向前', duration: 14, seg: 'continuation', tail: '脚步停住', cam: '跟拍减速' },
    { title: '镜3', visual: '大特写，信封上火漆印裂开', motion: '缓推', duration: 13, seg: 'closeup', tail: '裂纹定格', cam: '推进到位' },
  ];
  const midShotsArr = [
    { title: '镜1', visual: '中景，邮局门口灯亮起', motion: '横摇', duration: 4, seg: 'opening', tail: '灯光稳定', cam: '横摇到位' },
    { title: '镜2', visual: '近景，陈拾推开邮局门', motion: '跟拍', duration: 4, seg: 'continuation', tail: '门被推开', cam: '跟拍向前' },
    { title: '镜3', visual: '全景，营业厅内空无一人', motion: '拉升', duration: 4, seg: 'scene_change', tail: '厅内空镜', cam: '拉升' },
    { title: '镜4', visual: '大特写，柜台上火漆信', motion: '缓推', duration: 4, seg: 'closeup', tail: '信封定格', cam: '推进到位' },
  ];
  const shortShotsArr = [
    { title: '镜1', visual: '中景，陈拾收伞回望', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ];
  // 前置自证：fixtures 的闸门/切段判据都对，否则整个块失效
  eq(P.gateStoryboard(longShotsArr).ok, true, 'T6前置: 40s shots 必须先过 G2（否则触发面混淆）');
  eq(P.gateStoryboard(midShotsArr).ok, true, 'T6前置: 16s shots 必须先过 G2');
  eq(P.gateStoryboard(shortShotsArr).ok, true, 'T6前置: 5s shots 必须先过 G2');
  const planLong = planShotSegments(longShotsArr).segments;
  const planMid = planShotSegments(midShotsArr).segments;
  eq(planLong.length, 3, 'T6前置: 40s shots 应切 3 段');
  eq(planMid.length, 2, 'T6前置: 16s shots 应切 2 段（镜3 换场切点）');
  eq(planShotSegments(shortShotsArr).segments.length, 1, 'T6前置: 5s shots 应 1 段');

  // 假 LLM：非监制照旧；监制首轮即合法 JSON（聚焦付费段，不触发决策重试）
  I.__auto.setRoomLlm(async ({ system }) => {
    const s = String(system || '');
    if (s.includes('调研员')) return JSON.stringify({ themes: [{ name: '时空邮差', why: 't' }], styles: ['写实电影感'] });
    if (s.includes('编剧A')) return JSON.stringify({ logline: 'A案故事线', beats: ['b1', 'b2', 'b3'] });
    if (s.includes('编剧B')) return JSON.stringify({ logline: 'B案故事线', beats: ['c1', 'c2', 'c3'] });
    if (s.includes('剧评人')) return JSON.stringify({ critA: ['冲突可加强'], critB: ['动机可信'] });
    if (s.includes('监制')) return JSON.stringify({ decision: 'merge', rationale: '取A冲突+B动机', logline: '雨夜邮差的最后一封信', beats: ['x', 'y', 'z'],
      bible: { worldview: 'T6世界观：时空邮局', style: '写实电影感', characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }], scenes: [{ name: '褶皱巷', desc: '雨夜窄巷' }], props: [{ name: '火漆信', desc: '火漆印' }],
        scriptIdea: '写第一节剧本：雨夜邮差陈拾接到一封无法投递的信……每场结尾留因果钩子，每场至少一个冲突点。' } });
    return '{}';
  });

  // 画布执行桩：分镜 shots 必须走 canvas_update_node 的 patch.shots 写入（canvasWriteNode 的
  // output→shots 解析会丢 seg/tail/cam，切点就没了——T4 实证坑）；视频直接完成并计数。
  const runWithShots = async (name, scriptOut, shotsByScene) => {
    const videoExecs = [];
    I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
      const doc = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
      const n = doc.nodes[nodeId];
      if (!n) throw new Error('桩：节点不存在');
      if (n.type === 'script') {
        await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: scriptOut, overwrite: true });
        return { type: 'script', output: scriptOut };
      }
      if (n.type === 'storyboard') {
        const label = String((n.data && n.data.label) || '');
        const hit = Object.keys(shotsByScene).find((k) => label.startsWith(k));
        const shots = hit ? shotsByScene[hit] : [];
        await byName.get('canvas_update_node').execute({ projectId: pid2, nodeId, patch: { shots } }, {});
        return { type: 'storyboard', shots };
      }
      if (n.type === 'video') { videoExecs.push(nodeId); return { type: 'video', status: 'done' }; }
      return { type: n.type, status: 'done' };
    });
    const pidX = (await byName.get('canvas_create_project').execute({ name }, {})).projectId;
    const started = await M.autoStart({ projectId: pidX, brief: name + '：付费段按镜头切段拆分回归' });
    ok(started && started.ok === true, name + ': autoStart 未启动');
    let v = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      v = (await M.autoStatus({ projectId: pidX })).run;
      if (v && (v.status === 'done' || v.status === 'failed' || v.status === 'aborted')) break;
    }
    return { pid: pidX, v, videoExecs };
  };
  const waitPaid = async (pid2) => {
    let paid = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      paid = (await M.autoStatus({ projectId: pid2 })).run;
      if (paid && (paid.paid === 'done' || paid.paid === 'failed')) break;
    }
    return paid;
  };
  const vidsOf = (doc, sbId) => (doc.edges || []).filter((e) => e.fromNode === sbId).map((e) => doc.nodes[e.toNode]).filter((n) => n && n.type === 'video');

  // ①② 拆分 + 区间元数据：场1 40s→3 段、场2 16s→2 段、场3 5s→1 个节点；finalcut 连最后完成的段节点
  const t6a = await runWithShots('付费切段拆分回归',
    '【场1】褶皱巷\n雨夜，陈拾收伞，发现邮戳裂开。\n【场2】邮局\n清晨，火漆印反光，陈拾推门而入。\n【场3】巷尾\n黄昏，信封投递，门缝里的字条。',
    { 场1: longShotsArr, 场2: midShotsArr, 场3: shortShotsArr });
  ok(t6a.v && t6a.v.status === 'done', 'T6①: 流水线未 done（status=' + (t6a.v && t6a.v.status) + ' error=' + (t6a.v && t6a.v.error) + '）');
  ok(t6a.v && t6a.v.budget && t6a.v.budget.videoCalls === 6, 'T6①: 预算单 videoCalls 应为 3+2+1=6（实际：' + JSON.stringify(t6a.v && t6a.v.budget && t6a.v.budget.videoCalls) + '）');
  const qT6 = await M.autoQuote({ projectId: t6a.pid, unitPricePerSecond: 2 });
  ok(qT6 && qT6.ok === true && qT6.videoCalls === 6, 'T6①: autoQuote 失败或口径不符');
  const apT6 = await M.autoApprove({ projectId: t6a.pid, quoteId: qT6.quoteId, confirm: '用户：按这个预算开机' });
  ok(apT6 && apT6.ok === true, 'T6①: 付费批准失败');
  const paidT6 = await M.autoGenerate({ projectId: t6a.pid });
  ok(paidT6 && paidT6.ok === true, 'T6①: 付费段启动失败');
  const paidViewT6 = await waitPaid(t6a.pid);
  ok(paidViewT6 && paidViewT6.paid === 'done', 'T6①: 付费段未完成（' + (paidViewT6 && paidViewT6.paidError) + '）');
  const runT6 = I.__auto.runs.get(t6a.pid + '::default'); // autoStatus 视图 log/paidLog 只留尾 6 条，断言吃全量
  const docT6 = await I.projectsGet({ id: t6a.pid });
  const sbsT6 = Object.values(docT6.nodes).filter((n) => n.type === 'storyboard');
  eq(sbsT6.length, 3, 'T6①: 应有 3 张分镜表');
  const sbByLabel = (lb) => sbsT6.find((n) => String((n.data && n.data.label) || '').startsWith(lb));
  const sb1 = sbByLabel('场1');
  const sb2 = sbByLabel('场2');
  const sb3 = sbByLabel('场3');
  ok(!!sb1 && !!sb2 && !!sb3, 'T6①: 分镜表节点缺失');
  const vids1 = vidsOf(docT6, sb1.id);
  const vids2 = vidsOf(docT6, sb2.id);
  const vids3 = vidsOf(docT6, sb3.id);
  // 拆分：每段一个节点、命名带「段k/N」、全部 connectFrom 分镜表
  eq(vids1.length, 3, 'T6①: 40s 场应建 3 个 video 节点（实际 ' + vids1.length + '）');
  eq(vids2.length, 2, 'T6①: 16s 场应建 2 个 video 节点');
  eq(vids3.length, 1, 'T6①: 5s 场应只建 1 个 video 节点（不退化）');
  const bySegIndex = (a, b) => (Number(a.data.segIndex) || 0) - (Number(b.data.segIndex) || 0);
  vids1.sort(bySegIndex); vids2.sort(bySegIndex);
  const segLabels1 = vids1.map((v) => String((v.data && v.data.label) || ''));
  ok(segLabels1.some((l) => l.includes('段1/3')) && segLabels1.some((l) => l.includes('段2/3')) && segLabels1.some((l) => l.includes('段3/3')),
    'T6①: 段节点命名缺「段k/N」区间（labels=' + JSON.stringify(segLabels1) + '）');
  ok(segLabels1.every((l) => l.length <= 40), 'T6①: 段节点命名超 40 字符（canvasCreateNode 语义）');
  ok(!segLabels1.some((l) => /镜\s*\d+/.test(l)), 'T6①: 段节点命名不得触发 G4「镜N」逐镜命名');
  const segLabels2 = vids2.map((v) => String((v.data && v.data.label) || ''));
  ok(segLabels2.some((l) => l.includes('段1/2')) && segLabels2.some((l) => l.includes('段2/2')), 'T6①: 场2 段命名缺「段k/N」');
  eq(String((vids3[0].data && vids3[0].data.label) || ''), '场3视频', 'T6①: 单段场命名应保持「场N视频」（不得带段标记）');
  ok(!!vids3[0] && !!vids2[1] && vids3[0].id !== vids2[1].id, 'T6①: 场3 节点与场2 段节点混淆');
  // 区间元数据：data 段键（客户端 videoSegmentOf/segMeta 消费）+ prompt 范围约束
  const segMetaOk = (v, from, to, idx, count, chain, risk, desc) => {
    if (!v) { ok(false, desc + ': 段节点缺失（拆分未按段建节点）'); return; }
    const d = (v.data || {});
    eq(d.segShotFrom, from, desc + ': segShotFrom 不符');
    eq(d.segShotTo, to, desc + ': segShotTo 不符');
    eq(d.segIndex, idx, desc + ': segIndex 不符');
    eq(d.segCount, count, desc + ': segCount 不符');
    eq(d.needsTailChain, chain, desc + ': needsTailChain 不符');
    eq(d.seamRisk, risk, desc + ': seamRisk 不符');
  };
  segMetaOk(vids1[0], 0, 0, 0, 3, false, 'none', 'T6② 场1段1');
  segMetaOk(vids1[1], 1, 1, 1, 3, true, 'forced', 'T6② 场1段2');
  segMetaOk(vids1[2], 2, 2, 2, 3, false, 'none', 'T6② 场1段3');
  segMetaOk(vids2[0], 0, 2, 0, 2, false, 'none', 'T6② 场2段1');
  segMetaOk(vids2[1], 3, 3, 1, 2, false, 'none', 'T6② 场2段2');
  const promptHas = (v, parts, desc) => {
    if (!v) { ok(false, desc + ': 段节点缺失（prompt 无从断言）'); return; }
    const p = String((v.data && v.data.prompt) || '');
    for (const part of parts) ok(p.includes(part), desc + ': prompt 缺「' + part + '」（实际：' + p + '）');
  };
  promptHas(vids1[0], ['本段 1/3', '第 1-1 镜', '共 3 镜', '时长约 13 秒', '只生成本段内容'], 'T6② 场1段1');
  promptHas(vids1[1], ['本段 2/3', '第 2-2 镜', '时长约 14 秒', '只生成本段内容'], 'T6② 场1段2');
  promptHas(vids1[2], ['本段 3/3', '第 3-3 镜', '只生成本段内容'], 'T6② 场1段3');
  promptHas(vids2[0], ['本段 1/2', '第 1-3 镜', '时长约 12 秒', '只生成本段内容'], 'T6② 场2段1');
  promptHas(vids2[1], ['本段 2/2', '第 4-4 镜', '时长约 4 秒', '只生成本段内容'], 'T6② 场2段2');
  promptHas(vids3[0], ['本段 1/1', '第 1-2 镜', '共 2 镜', '只生成本段内容'], 'T6② 场3');
  // 每段恰好执行一次（重试语义按段保留）；finalcut 连最后一个完成的段节点（场3 的节点）
  eq(t6a.videoExecs.length, 6, 'T6①: 视频应恰好执行 6 次（每段一次，实际 ' + t6a.videoExecs.length + '）');
  const allVidIds = [...vids1, ...vids2, vids3[0]].map((v) => v.id);
  ok(allVidIds.every((id) => t6a.videoExecs.includes(id)), 'T6①: 有段节点未被执行');
  const fcsT6 = Object.values(docT6.nodes).filter((n) => n.type === 'finalcut');
  eq(fcsT6.length, 1, 'T6①: 成片节点应恰为 1 个');
  const fcEdgeT6 = (docT6.edges || []).find((e) => e.toNode === fcsT6[0].id);
  ok(!!fcEdgeT6 && fcEdgeT6.fromNode === vids3[0].id, 'T6①: finalcut 未连最后一个完成的段节点（场3）');
  eq(fcEdgeT6 && fcEdgeT6.toPort, 'in', 'T6①: finalcut 连线端口应为 in');
  const logsT6 = (runT6 && Array.isArray(runT6.log)) ? runT6.log.map((e) => String(e.summary)) : [];
  ok(!logsT6.some((t) => t.includes('预算与实际段数不一致')), 'T6①: 预算一致时不应有偏差日志');
  const paidLogT6 = (runT6 && Array.isArray(runT6.paidLog)) ? runT6.paidLog.map((e) => String(e.text)) : [];
  ok(paidLogT6.some((t) => t.includes('段1/3') && t.includes('完成')), 'T6①: paidLog 缺段完成条目（' + JSON.stringify(paidLogT6) + '）');

  // ③ 预算偏差日志：免费段后改 shots（40s→16s，段数 3→2）→ 重新 quote+approve（指纹绑定新状态）→
  // autoPaid 照跑，run.budget 还是免费段快照 → 「预算 3 / 实际 2」日志诚实化，不阻塞
  const t6b = await runWithShots('付费预算偏差日志回归', '【场1】褶皱巷\n雨夜，陈拾收伞，发现邮戳裂开。', { 场1: longShotsArr });
  ok(t6b.v && t6b.v.status === 'done', 'T6③: 流水线未 done（status=' + (t6b.v && t6b.v.status) + ' error=' + (t6b.v && t6b.v.error) + '）');
  ok(t6b.v && t6b.v.budget && t6b.v.budget.videoCalls === 3, 'T6③: 免费段预算 videoCalls 应为 3');
  const docT6b = await I.projectsGet({ id: t6b.pid });
  const sbT6b = Object.values(docT6b.nodes).find((n) => n.type === 'storyboard');
  ok(!!sbT6b, 'T6③: 分镜表节点缺失');
  await byName.get('canvas_update_node').execute({ projectId: t6b.pid, nodeId: sbT6b.id, patch: { shots: midShotsArr } }, {});
  const qT6b = await M.autoQuote({ projectId: t6b.pid, unitPricePerSecond: 2 });
  ok(qT6b && qT6b.ok === true && qT6b.videoCalls === 2, 'T6③: 改 shots 后 autoQuote 应如实为 2 段');
  const apT6b = await M.autoApprove({ projectId: t6b.pid, quoteId: qT6b.quoteId, confirm: '用户：改过分镜了，按新预算开机' });
  ok(apT6b && apT6b.ok === true, 'T6③: 重新批准失败');
  const paidT6b = await M.autoGenerate({ projectId: t6b.pid });
  ok(paidT6b && paidT6b.ok === true, 'T6③: 付费段启动失败');
  const paidViewT6b = await waitPaid(t6b.pid);
  ok(paidViewT6b && paidViewT6b.paid === 'done', 'T6③: 偏差不应阻塞付费段（' + (paidViewT6b && paidViewT6b.paidError) + '）');
  const runT6b = I.__auto.runs.get(t6b.pid + '::default'); // 同上：断言吃全量 log/paidLog
  const logsT6b = (runT6b && Array.isArray(runT6b.log)) ? runT6b.log.map((e) => String(e.summary)) : [];
  ok(logsT6b.some((t) => t.includes('预算与实际段数不一致')), 'T6③: run.log 缺「预算与实际段数不一致」条目（logs=' + JSON.stringify(logsT6b) + '）');
  ok(logsT6b.some((t) => t.includes('预算 3') && t.includes('实际 2')), 'T6③: 偏差日志缺「预算 3 / 实际 2」明细');
  const paidLogT6b = (runT6b && Array.isArray(runT6b.paidLog)) ? runT6b.paidLog.map((e) => String(e.text)) : [];
  ok(paidLogT6b.some((t) => t.includes('预算与实际段数不一致')), 'T6③: paidLog 缺偏差条目（操作侧也要看得见）');
  const docT6b2 = await I.projectsGet({ id: t6b.pid });
  const sbT6b2 = Object.values(docT6b2.nodes).find((n) => n.type === 'storyboard');
  const vidsT6b = vidsOf(docT6b2, sbT6b2.id);
  eq(vidsT6b.length, 2, 'T6③: 应按实际 2 段建节点（实际 ' + vidsT6b.length + '）');
  const labelsT6b = vidsT6b.map((v) => String((v.data && v.data.label) || ''));
  ok(labelsT6b.some((l) => l.includes('段1/2')) && labelsT6b.some((l) => l.includes('段2/2')), 'T6③: 段命名缺「段k/N」（' + JSON.stringify(labelsT6b) + '）');
  eq(t6b.videoExecs.length, 2, 'T6③: 视频应恰好执行 2 次');
  const fcsT6b = Object.values(docT6b2.nodes).filter((n) => n.type === 'finalcut');
  eq(fcsT6b.length, 1, 'T6③: 成片节点应恰为 1 个');
  const lastSegT6b = vidsT6b.find((v) => Number(v.data && v.data.segIndex) === 1);
  const fcEdgeT6b = (docT6b2.edges || []).find((e) => e.toNode === fcsT6b[0].id);
  ok(!!fcEdgeT6b && fcEdgeT6b.fromNode === (lastSegT6b && lastSegT6b.id), 'T6③: finalcut 未连最后一个段节点');

  await M.autoModeSet({ enabled: false });
}

// ============================ 九、付费段参考图生成与 ref 连线（0.20.2 T8：#6/#7 角色一致性无保障） ============================
// 0.20.1 实机：免费段全程不产出任何参考图，autoPaid 只建 video 节点 → 角色一致性无保障。
// 回归：① 两场共享「陈拾」+ 场景/道具 → image 节点恰 3 个（跨场去重），命名逐字 =「角色-陈拾 设定图」
//       等契约（命名即分类），2K/16:9、prompt 带设定集描述，全部被 exec；
//       ② ref 连线：每个 video 段节点在 exec 时刻就已带齐其对应实体的 ref 入线（toPort:'ref'，
//       先连后生成——collectRefs 生成时严格只读连线）；③ 资产索引预置「角色-陈拾 多视图」→
//       陈拾不建点、不计数（边界匹配）；④ 预算单行项 refImages / 顶层 refImagesTotal 与建点数一致；
//       ⑤ 镜头中途加角色 → 「参考图预算与实际不一致（预算 3 / 实际 4）」日志、不阻塞；
//       ⑥ 单张参考图 exec 失败 → 重试 2 次、记「参考图生成失败」、不阻塞视频段、不连线。
// 存储说明：readAssetIndexNames 需要数据根 → 本块 dataRootSet 打开（Node 26 自带 node:sqlite，
// 会切到 SQL 存储）；块内自洽（项目全部在本块创建），块末 closeDb 释放句柄让清理段能删沙盒。
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });
  const drT8 = await M.dataRootSet({ root: path.join(SANDBOX, 't8-data-root') });
  ok(drT8 && drT8.ok === true, 'T8前置: dataRootSet 失败（资产索引无数据根不可用）');

  // fixtures：场1 = 13s+14s（切段 2 段）、场2 = 3s+2s（1 段）；实体字段齐（G2 已预验证合规）
  const t8Shots1 = [
    { title: '镜1', visual: '全景，当铺柜台前陈拾递出火漆信', motion: '横移跟随', duration: 13, seg: 'opening', tail: '信入柜台', cam: '横移回正', characters: ['陈拾'], scene: '当铺', props: ['火漆信'] },
    { title: '镜2', visual: '大特写，火漆印裂纹缓缓裂开', motion: '缓推', duration: 14, seg: 'closeup', tail: '裂纹定格', cam: '推进到位', characters: ['陈拾'], scene: '当铺', props: ['火漆信'] },
  ];
  const t8Shots2 = [
    { title: '镜1', visual: '近景，陈拾在当铺门前回望', motion: '跟拍', duration: 3, seg: 'opening', tail: '转身欲走', cam: '跟拍向前', characters: ['陈拾'], scene: '当铺' },
    { title: '镜2', visual: '大特写，门环在陈拾眼前晃动', motion: '缓推', duration: 2, seg: 'closeup', tail: '门环定格', cam: '推进到位', characters: ['陈拾'], scene: '当铺' },
  ];
  eq(P.gateStoryboard(t8Shots1).ok, true, 'T8前置: 场1 shots 必须过 G2');
  eq(P.gateStoryboard(t8Shots2).ok, true, 'T8前置: 场2 shots 必须过 G2');
  eq(planShotSegments(t8Shots1).segments.length, 2, 'T8前置: 场1 27s 应切 2 段');
  eq(planShotSegments(t8Shots2).segments.length, 1, 'T8前置: 场2 5s 应 1 段');

  // 假 LLM：非监制照旧；监制首轮合法 JSON（设定集含 陈拾/当铺/火漆信 → prompt 描述断言的数据源）
  const t8RoomLlm = async ({ system }) => {
    const s = String(system || '');
    if (s.includes('调研员')) return JSON.stringify({ themes: [{ name: '时空当铺', why: 't' }], styles: ['写实电影感'] });
    if (s.includes('编剧A')) return JSON.stringify({ logline: 'A案故事线', beats: ['b1', 'b2', 'b3'] });
    if (s.includes('编剧B')) return JSON.stringify({ logline: 'B案故事线', beats: ['c1', 'c2', 'c3'] });
    if (s.includes('剧评人')) return JSON.stringify({ critA: ['冲突可加强'], critB: ['动机可信'] });
    if (s.includes('监制')) return JSON.stringify({ decision: 'merge', rationale: '取A冲突+B动机', logline: '雨夜当铺的最后一封火漆信', beats: ['x', 'y', 'z'],
      bible: { worldview: 'T8世界观：时空当铺', style: '写实电影感',
        characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }],
        scenes: [{ name: '当铺', desc: '雨夜老当铺柜台' }],
        props: [{ name: '火漆信', desc: '火漆印的密信' }],
        scriptIdea: '写第一节剧本：雨夜当铺陈拾接到一封火漆信……每场结尾留因果钩子，每场至少一个冲突点。' } });
    return '{}';
  };

  const t8ScriptOut = '【场1】当铺\n雨夜，陈拾在柜台递出火漆信，火漆印裂开。\n【场2】当铺门口\n清晨，陈拾回望当铺门环，转身离去。';
  const t8imgsOf = (doc) => Object.values(doc.nodes).filter((n) => n.type === 'image');
  const t8imgByLabel = (doc, lb) => t8imgsOf(doc).find((n) => String((n.data && n.data.label) || '') === lb) || null;
  const t8sbOf = (doc, prefix) => Object.values(doc.nodes).find((n) => n.type === 'storyboard' && String((n.data && n.data.label) || '').startsWith(prefix)) || null;
  const t8vidsOf = (doc, sbId) => (doc.edges || []).filter((e) => e.fromNode === sbId).map((e) => doc.nodes[e.toNode]).filter((n) => n && n.type === 'video');
  const t8refsOf = (doc, videoId) => (doc.edges || []).filter((e) => e.toNode === videoId && e.toPort === 'ref').map((e) => e.fromNode).sort();

  // 跑一个 T8 项目：免费段 → （可选改 shots）→ quote/approve → 付费段；桩按 n.type 分支并捕获执行时刻
  const runT8 = async (name, opts = {}) => {
    const imageExecs = [];
    const refAtVideoExec = []; // 视频 exec 时刻已存在的 ref 入线（先连后生成的直接证据）
    const failImageLabel = opts.failImageLabel || null;
    const shots2 = opts.shots2 || t8Shots2;
    I.__auto.setRoomLlm(t8RoomLlm);
    I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
      const doc = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
      const n = doc.nodes[nodeId];
      if (!n) throw new Error('桩：节点不存在');
      if (n.type === 'script') {
        await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: t8ScriptOut, overwrite: true });
        return { type: 'script', output: t8ScriptOut };
      }
      if (n.type === 'storyboard') {
        const label = String((n.data && n.data.label) || '');
        const shots = label.startsWith('场1') ? t8Shots1 : shots2;
        await byName.get('canvas_update_node').execute({ projectId: pid2, nodeId, patch: { shots } }, {});
        return { type: 'storyboard', shots };
      }
      if (n.type === 'image') {
        imageExecs.push(nodeId);
        if (failImageLabel && String((n.data && n.data.label) || '') === failImageLabel) throw new Error('桩：出图通道故障');
        return { type: 'image', status: 'done' };
      }
      if (n.type === 'video') {
        const docNow = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
        refAtVideoExec.push({ nodeId, refs: t8refsOf(docNow, nodeId) });
        return { type: 'video', status: 'done' };
      }
      return { type: n.type, status: 'done' };
    });
    const pidX = (await byName.get('canvas_create_project').execute({ name }, {})).projectId;
    for (const a of (opts.preAssets || [])) await M.assetIndexPut({ projectId: pidX, asset: a });
    const started = await M.autoStart({ projectId: pidX, brief: name + '：付费段参考图回归' });
    ok(started && started.ok === true, name + ': autoStart 未启动');
    let v = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      v = (await M.autoStatus({ projectId: pidX })).run;
      if (v && (v.status === 'done' || v.status === 'failed' || v.status === 'aborted')) break;
    }
    ok(v && v.status === 'done', name + ': 免费段未 done（status=' + (v && v.status) + ' error=' + (v && v.error) + '）');
    return { pid: pidX, v, imageExecs, refAtVideoExec, shots2 };
  };
  const t8ApproveAndPaid = async (pidX) => {
    const q = await M.autoQuote({ projectId: pidX, unitPricePerSecond: 2 });
    ok(q && q.ok === true, 'T8: autoQuote 失败');
    const ap = await M.autoApprove({ projectId: pidX, quoteId: q.quoteId, confirm: '用户：按这个预算开机' });
    ok(ap && ap.ok === true, 'T8: 付费批准失败');
    const paid = await M.autoGenerate({ projectId: pidX });
    ok(paid && paid.ok === true, 'T8: 付费段启动失败');
    let paidView = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      paidView = (await M.autoStatus({ projectId: pidX })).run;
      if (paidView && (paidView.paid === 'done' || paidView.paid === 'failed')) break;
    }
    return { q, paidView };
  };

  // ①②④ 基准：3 张参考图（跨场共享角色去重）+ ref 连线先于视频 exec + 预算行项一致
  const t8a = await runT8('T8参考图基准回归');
  ok(t8a.v && t8a.v.budget && t8a.v.budget.refImagesTotal === 3, 'T8①: 免费段预算 refImagesTotal 应为 3（实际：' + JSON.stringify(t8a.v && t8a.v.budget && t8a.v.budget.refImagesTotal) + '）');
  eq(t8a.v && t8a.v.budget && t8a.v.budget.videoCalls, 3, 'T8①: 视频调用口径不变（场1 2 段 + 场2 1 段 = 3）');
  const qa8 = await M.autoQuote({ projectId: t8a.pid, unitPricePerSecond: 2 });
  const scA8 = qa8.scenes.find((s) => String(s.name || '').startsWith('场1'));
  const scB8 = qa8.scenes.find((s) => String(s.name || '').startsWith('场2'));
  eq(scA8 && scA8.refImages, 3, 'T8④: 场1 行项 refImages 应为 3（角色+场景+道具）');
  eq(scB8 && scB8.refImages, 0, 'T8④: 场2 行项 refImages 应为 0（实体全部被场1 认领）');
  eq(qa8 && qa8.refImagesTotal, 3, 'T8④: 顶层 refImagesTotal 应为 3（跨场共享实体只计一次）');
  ok(String(qa8.note).includes('含参考图 3 张（未登记/未生成参考资产的实体）'), 'T8④: note 缺参考图行项说明（实际：' + qa8.note + '）');
  const paidA8 = await t8ApproveAndPaid(t8a.pid);
  ok(paidA8.paidView && paidA8.paidView.paid === 'done', 'T8①: 付费段未完成（' + (paidA8.paidView && paidA8.paidView.paidError) + '）');
  const docA8 = await I.projectsGet({ id: t8a.pid });
  const imgsA8 = t8imgsOf(docA8);
  eq(imgsA8.length, 3, 'T8①: image 节点应恰 3 个（共享角色 1 张不重复，实际 ' + imgsA8.length + '）');
  const labelsA8 = imgsA8.map((n) => String((n.data && n.data.label) || '')).sort();
  eq(JSON.stringify(labelsA8), JSON.stringify(['场景-当铺 设定图', '角色-陈拾 设定图', '道具-火漆信 设定图']),
    'T8①: 设定图命名必须逐字符合契约（实际：' + JSON.stringify(labelsA8) + '）');
  const chenA8 = t8imgByLabel(docA8, '角色-陈拾 设定图');
  const dangA8 = t8imgByLabel(docA8, '场景-当铺 设定图');
  const xinA8 = t8imgByLabel(docA8, '道具-火漆信 设定图');
  ok(!!chenA8 && !!dangA8 && !!xinA8, 'T8①: 设定图节点缺失');
  eq(chenA8 && chenA8.data.size, '2K', 'T8①: 设定图 size 应为 2K');
  eq(chenA8 && chenA8.data.ratio, '16:9', 'T8①: 设定图 ratio 应为 16:9');
  const promptOf8 = (n) => String((n && n.data && n.data.prompt) || '');
  ok(promptOf8(chenA8).includes('设定图：角色 陈拾') && promptOf8(chenA8).includes('设定集描述：24 岁，旧邮差制服'),
    'T8①: prompt 未按「设定图：实体名。设定集描述：desc」构造（实际：' + promptOf8(chenA8) + '）');
  ok(promptOf8(dangA8).includes('设定集描述：雨夜老当铺柜台') && promptOf8(xinA8).includes('设定集描述：火漆印的密信'),
    'T8①: 场景/道具 prompt 缺设定集描述');
  eq(t8a.imageExecs.length, 3, 'T8①: 3 张设定图应全部被 exec 恰一次（实际 ' + t8a.imageExecs.length + '）');
  const idsA8 = { chen: chenA8.id, dang: dangA8.id, xin: xinA8.id };
  const sorted3 = [idsA8.chen, idsA8.dang, idsA8.xin].sort();
  const sb1A8 = t8sbOf(docA8, '场1');
  const sb2A8 = t8sbOf(docA8, '场2');
  ok(!!sb1A8 && !!sb2A8, 'T8①: 分镜表缺失');
  const vids1A8 = t8vidsOf(docA8, sb1A8.id);
  const vids2A8 = t8vidsOf(docA8, sb2A8.id);
  eq(vids1A8.length, 2, 'T8①: 场1 应 2 个段节点');
  eq(vids2A8.length, 1, 'T8①: 场2 应 1 个段节点');
  // 每个段节点都连齐「该场对应实体」的 ref 入线：场1 = 3 张全连；场2（shots 无火漆信）= 陈拾+当铺
  for (const vd of vids1A8) eq(JSON.stringify(t8refsOf(docA8, vd.id)), JSON.stringify(sorted3), 'T8②: 场1 段节点 ref 入线不齐（' + String((vd.data && vd.data.label) || '') + '）');
  eq(JSON.stringify(t8refsOf(docA8, vids2A8[0].id)), JSON.stringify([idsA8.chen, idsA8.dang].sort()), 'T8②: 场2 段节点 ref 入线应为其对应实体（陈拾+当铺）');
  // 先连后生成：视频 exec 时刻 ref 入线已存在（collectRefs 生成时只读连线）
  eq(t8a.refAtVideoExec.length, 3, 'T8②: 应捕获 3 次 video exec');
  ok(t8a.refAtVideoExec.every((r) => JSON.stringify(r.refs) === JSON.stringify(sorted3) || JSON.stringify(r.refs) === JSON.stringify([idsA8.chen, idsA8.dang].sort())),
    'T8②: 视频 exec 时 ref 入线未就绪（先连后生成被破坏）：' + JSON.stringify(t8a.refAtVideoExec));
  const runA8 = I.__auto.runs.get(t8a.pid + '::default');
  const paidLogA8 = (runA8 && Array.isArray(runA8.paidLog)) ? runA8.paidLog.map((e) => String(e.text)) : [];
  ok(paidLogA8.some((t) => t.includes('角色-陈拾 设定图 完成')), 'T8①: paidLog 缺设定图完成条目（' + JSON.stringify(paidLogA8) + '）');
  const logsA8 = (runA8 && Array.isArray(runA8.log)) ? runA8.log.map((e) => String(e.summary)) : [];
  ok(!logsA8.some((t) => t.includes('参考图预算与实际不一致')), 'T8①: 预算一致时不应有参考图偏差日志');
  const fcsA8 = Object.values(docA8.nodes).filter((n) => n.type === 'finalcut');
  eq(fcsA8.length, 1, 'T8①: 成片节点应恰 1 个');

  // ③ 已有资产跳过：资产索引预置「角色-陈拾 多视图」→ 陈拾不建点、预算不计、日志可查
  const t8b = await runT8('T8已有资产跳过回归', { preAssets: [{ id: 'ast-chen-t8', name: '角色-陈拾 多视图', kind: 'image', mime: 'image/png', category: 'character' }] });
  const qb8 = await M.autoQuote({ projectId: t8b.pid, unitPricePerSecond: 2 });
  eq(qb8 && qb8.refImagesTotal, 2, 'T8③: 已有资产的陈拾不应计入 refImagesTotal（应为 2）');
  const paidB8 = await t8ApproveAndPaid(t8b.pid);
  ok(paidB8.paidView && paidB8.paidView.paid === 'done', 'T8③: 付费段未完成');
  const docB8 = await I.projectsGet({ id: t8b.pid });
  const labelsB8 = t8imgsOf(docB8).map((n) => String((n.data && n.data.label) || '')).sort();
  eq(JSON.stringify(labelsB8), JSON.stringify(['场景-当铺 设定图', '道具-火漆信 设定图']), 'T8③: 陈拾不应建设定图节点（实际：' + JSON.stringify(labelsB8) + '）');
  eq(t8b.imageExecs.length, 2, 'T8③: 应只 exec 2 张设定图');
  const runB8 = I.__auto.runs.get(t8b.pid + '::default');
  const logsB8 = (runB8 && Array.isArray(runB8.log)) ? runB8.log.map((e) => String(e.summary)) : [];
  const paidLogB8 = (runB8 && Array.isArray(runB8.paidLog)) ? runB8.paidLog.map((e) => String(e.text)) : [];
  ok(logsB8.some((t) => t.includes('陈拾 已有参考资产，跳过')), 'T8③: run.log 缺「已有参考资产，跳过」条目');
  ok(paidLogB8.some((t) => t.includes('陈拾 已有参考资产，跳过')), 'T8③: paidLog 缺「已有参考资产，跳过」条目');
  const sb1B8 = t8sbOf(docB8, '场1');
  const vids1B8 = t8vidsOf(docB8, sb1B8.id);
  const dangB8 = t8imgByLabel(docB8, '场景-当铺 设定图');
  const xinB8 = t8imgByLabel(docB8, '道具-火漆信 设定图');
  ok(!!dangB8 && !!xinB8, 'T8③: 设定图节点缺失');
  for (const vd of vids1B8) eq(JSON.stringify(t8refsOf(docB8, vd.id)), JSON.stringify([dangB8.id, xinB8.id].sort()), 'T8③: 场1 段节点应只连已生成的 2 张（陈拾走资产索引不连线）');

  // ⑤ 预算偏差：免费段后给场2 加新角色「阿禾」→ 预算快照 3 / 实际 4 → 日志诚实化、不阻塞
  const moreShots2 = [
    { title: '镜1', visual: '近景，陈拾与阿禾在当铺门前回望', motion: '跟拍', duration: 3, seg: 'opening', tail: '转身欲走', cam: '跟拍向前', characters: ['陈拾', '阿禾'], scene: '当铺' },
    { title: '镜2', visual: '大特写，门环在陈拾眼前晃动', motion: '缓推', duration: 2, seg: 'closeup', tail: '门环定格', cam: '推进到位', characters: ['陈拾'], scene: '当铺' },
  ];
  const t8c = await runT8('T8参考图预算偏差回归');
  ok(t8c.v && t8c.v.budget && t8c.v.budget.refImagesTotal === 3, 'T8⑤: 免费段预算快照应为 3');
  const docC0 = await I.projectsGet({ id: t8c.pid });
  const sb2C = t8sbOf(docC0, '场2');
  ok(!!sb2C, 'T8⑤: 场2 分镜表缺失');
  await byName.get('canvas_update_node').execute({ projectId: t8c.pid, nodeId: sb2C.id, patch: { shots: moreShots2 } }, {});
  const paidC8 = await t8ApproveAndPaid(t8c.pid);
  ok(paidC8.q && paidC8.q.refImagesTotal === 4, 'T8⑤: 改 shots 后重报价 refImagesTotal 应为 4（实际：' + JSON.stringify(paidC8.q && paidC8.q.refImagesTotal) + '）');
  ok(paidC8.paidView && paidC8.paidView.paid === 'done', 'T8⑤: 偏差不应阻塞付费段（' + (paidC8.paidView && paidC8.paidView.paidError) + '）');
  const docC8 = await I.projectsGet({ id: t8c.pid });
  const labelsC8 = t8imgsOf(docC8).map((n) => String((n.data && n.data.label) || '')).sort();
  eq(JSON.stringify(labelsC8), JSON.stringify(['场景-当铺 设定图', '角色-阿禾 设定图', '角色-陈拾 设定图', '道具-火漆信 设定图']),
    'T8⑤: 应按实际 4 个实体建设定图（实际：' + JSON.stringify(labelsC8) + '）');
  eq(t8c.imageExecs.length, 4, 'T8⑤: 应 exec 4 张设定图');
  const runC8 = I.__auto.runs.get(t8c.pid + '::default');
  const logsC8 = (runC8 && Array.isArray(runC8.log)) ? runC8.log.map((e) => String(e.summary)) : [];
  const paidLogC8 = (runC8 && Array.isArray(runC8.paidLog)) ? runC8.paidLog.map((e) => String(e.text)) : [];
  ok(logsC8.some((t) => t.includes('参考图预算与实际不一致（预算 3 / 实际 4）')), 'T8⑤: run.log 缺参考图预算偏差条目（logs=' + JSON.stringify(logsC8.filter((t) => t.includes('参考图'))) + '）');
  ok(paidLogC8.some((t) => t.includes('参考图预算与实际不一致（预算 3 / 实际 4）')), 'T8⑤: paidLog 缺参考图预算偏差条目');

  // ⑥ 失败不阻塞：火漆信设定图 exec 恒败 → 重试恰 2 次、记「参考图生成失败」、不连线、视频照常完成
  const t8d = await runT8('T8参考图失败不阻塞回归', { failImageLabel: '道具-火漆信 设定图' });
  const paidD8 = await t8ApproveAndPaid(t8d.pid);
  ok(paidD8.paidView && paidD8.paidView.paid === 'done', 'T8⑥: 参考图失败不应阻塞付费段（' + (paidD8.paidView && paidD8.paidView.paidError) + '）');
  const docD8 = await I.projectsGet({ id: t8d.pid });
  const xinD8 = t8imgByLabel(docD8, '道具-火漆信 设定图');
  ok(!!xinD8, 'T8⑥: 失败的设定图节点仍应已建点');
  eq(t8d.imageExecs.filter((id) => id === xinD8.id).length, 2, 'T8⑥: 失败设定图应恰好尝试 2 次（T6 同款重试语义）');
  const runD8 = I.__auto.runs.get(t8d.pid + '::default');
  const logsD8 = (runD8 && Array.isArray(runD8.log)) ? runD8.log.map((e) => String(e.summary)) : [];
  const paidLogD8 = (runD8 && Array.isArray(runD8.paidLog)) ? runD8.paidLog.map((e) => String(e.text)) : [];
  ok(logsD8.some((t) => t.includes('火漆信（道具）参考图生成失败')), 'T8⑥: run.log 缺「参考图生成失败」条目');
  ok(paidLogD8.some((t) => t.includes('第 1 次失败')) && paidLogD8.some((t) => t.includes('第 2 次失败')), 'T8⑥: paidLog 缺逐次失败条目');
  const sb1D8 = t8sbOf(docD8, '场1');
  const dangD8 = t8imgByLabel(docD8, '场景-当铺 设定图');
  const chenD8 = t8imgByLabel(docD8, '角色-陈拾 设定图');
  ok(!!dangD8 && !!chenD8 && !!sb1D8, 'T8⑥: 其余设定图节点缺失');
  for (const vd of t8vidsOf(docD8, sb1D8.id)) {
    eq(JSON.stringify(t8refsOf(docD8, vd.id)), JSON.stringify([chenD8.id, dangD8.id].sort()), 'T8⑥: 失败的火漆信不得连线，其余照连');
  }
  ok(logsD8.some((t) => t.includes('参考图预算与实际不一致（预算 3 / 实际 2）')), 'T8⑥: 失败导致的偏差也应如实记日志');

  await M.autoModeSet({ enabled: false });
  I.closeDb(); // 释放 SQLite 句柄：清理段的 fs.rm 才能删掉沙盒里的 canvas.db（Windows 文件锁）
}

// ============================ 十、预算单价引导 + 选场部分执行（0.20.2 T9：#9） ============================
// 用户实测：① 预算单没配单价就不显示金额，也没有任何引导（不知道去哪配）；② 付费段只能全量跑，
// 「只跑一部分场」没有官方入口，只能绕手动流程。回归：
//  ④ 不配单价 → autoQuote / canvas_auto_budget 结果含锚点词「视频每秒单价」的配置引导；显式传价 →
//     有估算金额、无引导（现有行为不变）；
//  ③ scenes 参数校验：非数组 / 空数组 / 含非正整数（0、'a'、1.5）/ 越界场号 → 各自 ok:false 且付费段不启动；
//  ① 部分跑：全量预算批准后 canvas_auto_generate({scenes:[2]}) → 只有场 2 建 video 段节点并 exec，
//     场 1/3 零节点、连参考图设定图都不生成（实体收集只跑选中场）；finalcut 连场 2 末段；run.log 含「部分执行」；
//  ② 续跑补齐：部分跑后旧批准令牌按全量预算指纹失效（要重新复核）→ 重新报价（场2 已有视频 → 4→3 次）
//     批准 → 全量跑时场 1/3 建节点、场 2 的 hasVideo/段级恢复跳过（不重复 exec、不重复建设定图）；
//     finalcut 移到全场末段（本次范围的最后完成段）；全量跑不再记「部分执行」。
// 三场 fixtures 实体互不重叠（部分跑/续跑两轮各自建图，断言无歧义）。
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });
  const drT9 = await M.dataRootSet({ root: path.join(SANDBOX, 't9-data-root') });
  ok(drT9 && drT9.ok === true, 'T9前置: dataRootSet 失败');

  // fixtures：场1 = 13s+14s（2 段）、场2 = 3s+2s（1 段）、场3 = 3s+2s（1 段）；实体字段齐（G2 已预验证合规）
  const t9Shots1 = [
    { title: '镜1', visual: '全景，当铺柜台前陈拾递出火漆信', motion: '横移跟随', duration: 13, seg: 'opening', tail: '信入柜台', cam: '横移回正', characters: ['陈拾'], scene: '当铺', props: ['火漆信'] },
    { title: '镜2', visual: '大特写，火漆印裂纹缓缓裂开', motion: '缓推', duration: 14, seg: 'closeup', tail: '裂纹定格', cam: '推进到位', characters: ['陈拾'], scene: '当铺', props: ['火漆信'] },
  ];
  const t9Shots2 = [
    { title: '镜1', visual: '近景，阿禾在当铺门口递出门环', motion: '跟拍', duration: 3, seg: 'opening', tail: '门环入手', cam: '跟拍向前', characters: ['阿禾'], scene: '当铺门口', props: ['门环'] },
    { title: '镜2', visual: '大特写，门环纹路在晨光里发亮', motion: '缓推', duration: 2, seg: 'closeup', tail: '反光定格', cam: '推进到位', characters: ['阿禾'], scene: '当铺门口', props: ['门环'] },
  ];
  const t9Shots3 = [
    { title: '镜1', visual: '中景，巷尾黄昏老周驻足', motion: '横移跟随', duration: 3, seg: 'opening', tail: '驻足回望', cam: '横移回正', characters: ['老周'], scene: '巷尾', props: ['字条'] },
    { title: '镜2', visual: '大特写，字条在门缝里露出一角', motion: '缓推', duration: 2, seg: 'closeup', tail: '展信定格', cam: '推进到位', characters: ['老周'], scene: '巷尾', props: ['字条'] },
  ];
  eq(P.gateStoryboard(t9Shots1).ok, true, 'T9前置: 场1 shots 必须过 G2');
  eq(P.gateStoryboard(t9Shots2).ok, true, 'T9前置: 场2 shots 必须过 G2');
  eq(P.gateStoryboard(t9Shots3).ok, true, 'T9前置: 场3 shots 必须过 G2');
  eq(planShotSegments(t9Shots1).segments.length, 2, 'T9前置: 场1 27s 应切 2 段');
  eq(planShotSegments(t9Shots2).segments.length, 1, 'T9前置: 场2 5s 应 1 段');
  eq(planShotSegments(t9Shots3).segments.length, 1, 'T9前置: 场3 5s 应 1 段');

  // 假 LLM（T8 同款骨架）；执行桩按 n.type 分支：分镜按 label 前缀取 shots，image/video 记 exec，
  // video 额外捕获 exec 时刻的 ref 入线（先连后生成的直接证据）
  const t9RoomLlm = async ({ system }) => {
    const s = String(system || '');
    if (s.includes('调研员')) return JSON.stringify({ themes: [{ name: '时空当铺', why: 't' }], styles: ['写实电影感'] });
    if (s.includes('编剧A')) return JSON.stringify({ logline: 'A案故事线', beats: ['b1', 'b2', 'b3'] });
    if (s.includes('编剧B')) return JSON.stringify({ logline: 'B案故事线', beats: ['c1', 'c2', 'c3'] });
    if (s.includes('剧评人')) return JSON.stringify({ critA: ['冲突可加强'], critB: ['动机可信'] });
    if (s.includes('监制')) return JSON.stringify({ decision: 'merge', rationale: '取A冲突+B动机', logline: '雨夜当铺的最后一封火漆信', beats: ['x', 'y', 'z'],
      bible: { worldview: 'T9世界观：时空当铺', style: '写实电影感',
        characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }],
        scenes: [{ name: '当铺', desc: '雨夜老当铺柜台' }],
        props: [{ name: '火漆信', desc: '火漆印的密信' }],
        scriptIdea: '写第一节剧本：雨夜当铺陈拾接到一封火漆信……每场结尾留因果钩子，每场至少一个冲突点。' } });
    return '{}';
  };
  const t9ScriptOut = '【场1】当铺\n雨夜，陈拾在柜台递出火漆信，火漆印裂开。\n【场2】当铺门口\n清晨，阿禾把门环递还给陈拾，转身离去。\n【场3】巷尾\n黄昏，老周从门缝抽出字条，展信细读。';
  const t9imgsOf = (doc) => Object.values(doc.nodes).filter((n) => n.type === 'image');
  const t9imgByLabel = (doc, lb) => t9imgsOf(doc).find((n) => String((n.data && n.data.label) || '') === lb) || null;
  const t9sbOf = (doc, prefix) => Object.values(doc.nodes).find((n) => n.type === 'storyboard' && String((n.data && n.data.label) || '').startsWith(prefix)) || null;
  const t9vidsOf = (doc, sbId) => (doc.edges || []).filter((e) => e.fromNode === sbId).map((e) => doc.nodes[e.toNode]).filter((n) => n && n.type === 'video');
  const t9refsOf = (doc, videoId) => (doc.edges || []).filter((e) => e.toNode === videoId && e.toPort === 'ref').map((e) => e.fromNode).sort();

  const t9 = (() => {
    const imageExecs = [];
    const videoExecs = [];
    const refAtVideoExec = [];
    I.__auto.setRoomLlm(t9RoomLlm);
    I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
      const doc = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
      const n = doc.nodes[nodeId];
      if (!n) throw new Error('桩：节点不存在');
      if (n.type === 'script') {
        await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: t9ScriptOut, overwrite: true });
        return { type: 'script', output: t9ScriptOut };
      }
      if (n.type === 'storyboard') {
        const label = String((n.data && n.data.label) || '');
        const shots = label.startsWith('场1') ? t9Shots1 : label.startsWith('场2') ? t9Shots2 : t9Shots3;
        await byName.get('canvas_update_node').execute({ projectId: pid2, nodeId, patch: { shots } }, {});
        return { type: 'storyboard', shots };
      }
      if (n.type === 'image') { imageExecs.push(nodeId); return { type: 'image', status: 'done' }; }
      if (n.type === 'video') {
        const docNow = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
        refAtVideoExec.push({ nodeId, refs: t9refsOf(docNow, nodeId) });
        videoExecs.push(nodeId);
        return { type: 'video', status: 'done' };
      }
      return { type: n.type, status: 'done' };
    });
    return { imageExecs, videoExecs, refAtVideoExec };
  })();

  const pid9 = (await byName.get('canvas_create_project').execute({ name: 'T9选场部分执行回归' }, {})).projectId;
  const started9 = await M.autoStart({ projectId: pid9, brief: 'T9：选场部分执行回归（三场分镜）' });
  ok(started9 && started9.ok === true, 'T9前置: autoStart 未启动');
  let v9 = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    v9 = (await M.autoStatus({ projectId: pid9 })).run;
    if (v9 && (v9.status === 'done' || v9.status === 'failed' || v9.status === 'aborted')) break;
  }
  ok(v9 && v9.status === 'done', 'T9前置: 免费段未 done（status=' + (v9 && v9.status) + ' error=' + (v9 && v9.error) + '）');
  eq(v9 && v9.budget && v9.budget.sceneCount, 3, 'T9前置: 免费段应产出 3 场分镜');
  eq(v9 && v9.budget && v9.budget.videoCalls, 4, 'T9前置: 预算口径应为 2+1+1=4');
  eq(v9 && v9.budget && v9.budget.refImagesTotal, 9, 'T9前置: 预算参考图应为 9（三场实体互不重叠）');
  const waitPaid9 = async () => {
    let paid = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      paid = (await M.autoStatus({ projectId: pid9 })).run;
      if (paid && (paid.paid === 'done' || paid.paid === 'failed')) break;
    }
    return paid;
  };

  // ④ 单价引导：不配单价 → note 含锚点词「视频每秒单价」；显式传价 → 有金额、无引导（现有断言口径不变）
  const qNoPrice = await M.autoQuote({ projectId: pid9 });
  ok(qNoPrice && qNoPrice.ok === true, 'T9④: autoQuote 失败');
  ok(qNoPrice.estimatedCost == null, 'T9④: 未配单价时 estimatedCost 应为 null');
  ok(String(qNoPrice.note).includes('视频每秒单价'), 'T9④: note 缺单价配置引导（实际：' + qNoPrice.note + '）');
  const budgetNoPrice = await byName.get('canvas_auto_budget').execute({ projectId: pid9 }, {});
  ok(budgetNoPrice && budgetNoPrice.ok === true && String(budgetNoPrice.text).includes('视频每秒单价'),
    'T9④: canvas_auto_budget 输出缺单价提示行（实际：' + (budgetNoPrice && budgetNoPrice.text) + '）');
  const qWithPrice = await M.autoQuote({ projectId: pid9, unitPricePerSecond: 2 });
  ok(qWithPrice && qWithPrice.estimatedCost != null, 'T9④: 传价后应有估算金额');
  ok(!String(qWithPrice.note).includes('视频每秒单价'), 'T9④: 配了单价不应再出现引导（实际：' + qWithPrice.note + '）');

  // ③ 参数校验：非法 scenes 一律 ok:false，且错误必须来自参数校验本身（文案锚点锁定）而非下游批准闸；付费段不启动
  const bad9 = [
    { scenes: [0], word: '非法场号' },
    { scenes: ['a'], word: '非法场号' },
    { scenes: [1.5], word: '非法场号' },
    { scenes: [99], word: '超出当前场数' },
    { scenes: [], word: '空数组' },
    { scenes: '2', word: '必须是场号数组' },
  ];
  for (const bad of bad9) {
    const r = await M.autoGenerate({ projectId: pid9, scenes: bad.scenes });
    ok(r && r.ok === false, 'T9③: scenes=' + JSON.stringify(bad.scenes) + ' 应拒绝');
    ok(r && String(r.error || '').includes(bad.word), 'T9③: scenes=' + JSON.stringify(bad.scenes) + ' 错误应含「' + bad.word + '」（实际：' + (r && r.error) + '）');
    const view = (await M.autoStatus({ projectId: pid9 })).run;
    ok(view && view.paid !== 'running', 'T9③: 非法 scenes=' + JSON.stringify(bad.scenes) + ' 不应启动付费段');
  }
  ok((await M.autoGenerate({ projectId: pid9 })).ok === false, 'T9③: 未批准时全量跑仍应被拒（校验不得绕过批准）');

  // ① 部分跑：全量预算批准后 scenes:[2] → 只有场 2 建段节点并 exec
  const q9a = await M.autoQuote({ projectId: pid9, unitPricePerSecond: 2 });
  ok(q9a && q9a.ok === true && q9a.videoCalls === 4, 'T9①: 首次报价应 4 次调用');
  const ap9a = await M.autoApprove({ projectId: pid9, quoteId: q9a.quoteId, confirm: '用户：先只跑场2 看看效果' });
  ok(ap9a && ap9a.ok === true, 'T9①: 付费批准失败');
  const paid9a = await byName.get('canvas_auto_generate').execute({ projectId: pid9, scenes: [2] }, {});
  ok(paid9a && paid9a.ok === true, 'T9①: 部分跑启动失败（' + (paid9a && paid9a.text) + '）');
  ok(paid9a && String(paid9a.text).includes('部分执行：本次跑 场2'), 'T9②: 工具输出缺子集信息（实际：' + (paid9a && paid9a.text) + '）');
  const paidView9a = await waitPaid9();
  ok(paidView9a && paidView9a.paid === 'done', 'T9①: 部分跑未完成（' + (paidView9a && paidView9a.paidError) + '）');
  const run9 = I.__auto.runs.get(pid9 + '::default'); // autoStatus 视图 log/paidLog 只留尾 6 条，断言吃全量
  const logs9a = (run9 && Array.isArray(run9.log)) ? run9.log.map((e) => String(e.summary)) : [];
  ok(logs9a.some((t) => t.includes('部分执行：本次跑') && t.includes('场2（共 3 场）')), 'T9①: run.log 缺「部分执行」条目（logs=' + JSON.stringify(logs9a) + '）');
  const doc9a = await I.projectsGet({ id: pid9 });
  const sb19 = t9sbOf(doc9a, '场1');
  const sb29 = t9sbOf(doc9a, '场2');
  const sb39 = t9sbOf(doc9a, '场3');
  ok(!!sb19 && !!sb29 && !!sb39, 'T9①: 分镜表节点缺失');
  const vids19 = t9vidsOf(doc9a, sb19.id);
  const vids29 = t9vidsOf(doc9a, sb29.id);
  const vids39 = t9vidsOf(doc9a, sb39.id);
  eq(vids29.length, 1, 'T9①: 场2 应恰 1 个段节点');
  eq(vids19.length, 0, 'T9①: 未选中的场1 不应有任何视频节点');
  eq(vids39.length, 0, 'T9①: 未选中的场3 不应有任何视频节点');
  eq(t9.videoExecs.length, 1, 'T9①: 付费段应恰 exec 1 次（场2 的段）');
  // 被排除的场连参考图都不生成：image 节点恰为场2 的 3 个实体
  const labels19 = t9imgsOf(doc9a).map((n) => String((n.data && n.data.label) || '')).sort();
  eq(JSON.stringify(labels19), JSON.stringify(['场景-当铺门口 设定图', '角色-阿禾 设定图', '道具-门环 设定图'].sort()),
    'T9①: 被排除场不得建设定图（实际：' + JSON.stringify(labels19) + '）');
  eq(t9.imageExecs.length, 3, 'T9①: 应恰 exec 3 张设定图（场2 实体）');
  // finalcut 连场2 末段（本次执行范围内）
  const fcs9a = Object.values(doc9a.nodes).filter((n) => n.type === 'finalcut');
  eq(fcs9a.length, 1, 'T9①: 成片节点应恰 1 个');
  const fcEdge9a = (doc9a.edges || []).find((e) => e.toNode === fcs9a[0].id);
  ok(!!fcEdge9a && fcEdge9a.fromNode === vids29[0].id, 'T9①: finalcut 未连场2 末段');
  ok(logs9a.some((t) => t.includes('参考图预算与实际不一致（预算 9 / 实际 3）')), 'T9①: 部分跑应如实记参考图预算偏差（预算是全量快照）');

  // ② 续跑补齐：旧令牌已按全量预算指纹失效（场2 已有视频 → 预算行变化）→ 重新复核批准 → 全量补齐
  const apOld9 = await M.autoApprove({ projectId: pid9, quoteId: q9a.quoteId, confirm: '用户：按旧预算继续' });
  ok(apOld9 && apOld9.ok === false && apOld9.expired === true, 'T9②: 部分跑后旧批准令牌应失效（预算变了要重新复核）');
  const q9b = await M.autoQuote({ projectId: pid9, unitPricePerSecond: 2 });
  eq(q9b && q9b.videoCalls, 3, 'T9②: 重报价应为 场1 2 + 场2 0(已有视频) + 场3 1 = 3');
  const ap9b = await M.autoApprove({ projectId: pid9, quoteId: q9b.quoteId, confirm: '用户：补齐其余场' });
  ok(ap9b && ap9b.ok === true, 'T9②: 重新批准失败');
  const paid9b = await M.autoGenerate({ projectId: pid9 }); // 全量：不传 scenes，现行为零变化
  ok(paid9b && paid9b.ok === true, 'T9②: 全量续跑启动失败');
  const paidView9b = await waitPaid9();
  ok(paidView9b && paidView9b.paid === 'done', 'T9②: 全量续跑未完成（' + (paidView9b && paidView9b.paidError) + '）');
  const doc9b = await I.projectsGet({ id: pid9 });
  eq(t9vidsOf(doc9b, sb19.id).length, 2, 'T9②: 场1 应补齐 2 段');
  eq(t9vidsOf(doc9b, sb29.id).length, 1, 'T9②: 场2 不应重复建段');
  eq(t9vidsOf(doc9b, sb39.id).length, 1, 'T9②: 场3 应补齐 1 段');
  eq(t9.videoExecs.length, 4, 'T9②: 两次合计应恰 4 次视频 exec（场2 不重复）');
  const vid2Id9 = vids29[0].id;
  eq(t9.videoExecs.filter((id) => id === vid2Id9).length, 1, 'T9②: 场2 的段节点不得被再次 exec（hasVideo/段级恢复跳过）');
  // 设定图不重建：9 个实体各恰 1 个节点、各恰 exec 1 次
  const labels9b = t9imgsOf(doc9b).map((n) => String((n.data && n.data.label) || '')).sort();
  const expected9 = ['场景-当铺 设定图', '场景-当铺门口 设定图', '场景-巷尾 设定图', '角色-阿禾 设定图', '角色-陈拾 设定图', '角色-老周 设定图', '道具-火漆信 设定图', '道具-字条 设定图', '道具-门环 设定图'].sort();
  eq(JSON.stringify(labels9b), JSON.stringify(expected9), 'T9②: 续跑不得重建已有设定图（实际：' + JSON.stringify(labels9b) + '）');
  eq(t9.imageExecs.length, 9, 'T9②: 两轮合计应恰 exec 9 张设定图');
  ok(new Set(t9.imageExecs).size === 9, 'T9②: 设定图不得重复 exec');
  // ref 连线口径：每个视频段 exec 时刻只连本场实体（先连后生成）
  const id9 = {};
  for (const lb of expected9) { const n = t9imgByLabel(doc9b, lb); ok(!!n, 'T9②: 设定图节点缺失 ' + lb); if (n) id9[lb] = n.id; }
  const owner9 = (label) => label.startsWith('场1') ? ['场景-当铺 设定图', '角色-陈拾 设定图', '道具-火漆信 设定图']
    : label.startsWith('场2') ? ['场景-当铺门口 设定图', '角色-阿禾 设定图', '道具-门环 设定图']
    : ['场景-巷尾 设定图', '角色-老周 设定图', '道具-字条 设定图'];
  eq(t9.refAtVideoExec.length, 4, 'T9②: 应捕获 4 次 video exec');
  for (const cap of t9.refAtVideoExec) {
    const node = doc9b.nodes[cap.nodeId];
    const label = String((node && node.data && node.data.label) || '');
    eq(JSON.stringify(cap.refs), JSON.stringify(owner9(label).map((lb) => id9[lb]).sort()), 'T9②: ' + (label || cap.nodeId) + ' exec 时刻 ref 入线应只连本场实体');
  }
  // finalcut 移到全场末段（本次范围的最后完成段 = 场3）；旧成片保留（已产出内容不回收）
  const fcId9b = run9.finalcutNodeId;
  const fcEdge9b = (doc9b.edges || []).find((e) => e.toNode === fcId9b);
  const vids39b = t9vidsOf(doc9b, sb39.id);
  ok(!!fcEdge9b && fcEdge9b.fromNode === vids39b[0].id, 'T9②: 新成片应连场3 末段（本次执行范围内最后完成段）');
  const logs9b = (run9 && Array.isArray(run9.log)) ? run9.log.map((e) => String(e.summary)) : [];
  eq(logs9b.filter((t) => t.includes('部分执行：本次跑')).length, 1, 'T9②: 全量续跑不应再记「部分执行」');

  await M.autoModeSet({ enabled: false });
  I.closeDb(); // 释放 SQLite 句柄：清理段的 fs.rm 才能删掉沙盒里的 canvas.db（Windows 文件锁）
}

// ============================ 十一、免费段断点续跑（0.20.2 T10：#2 + #14） ============================
// 用户实测：监制决策轮失败后重试 = 免费段从头再跑（调研→A/B提案→互评→监制全部重走），前面成功阶段全浪费。
// 修复：阶段产物持久化进制作状态文件（PROD.readState/writeState，ps.autoRun），autoStart 检测未完成 run
// → 从断点续跑（已完成阶段不调 LLM、不重建节点、不再 exec）；传不同 brief = 全新启动（换创意是有意的）；
//   中途 abort 同样可续跑。场景：① 监制轮失败→续跑 ② 互评轮阻塞→abort→续跑 ③ 换 brief=全新 / 已完结=全新
//   ④ 无持久化 / 形状损坏=全新 ⑤ 场级断点（场1 分镜完成、场2 失败 → 续跑跳过场1）。
{
  const M = I.rpcMethods();
  await M.autoModeSet({ enabled: true });
  const drT10 = await M.dataRootSet({ root: path.join(SANDBOX, 't10-data-root') });
  ok(drT10 && drT10.ok === true, 'T10前置: dataRootSet 失败');

  const goodShots10 = JSON.stringify({ shots: [
    { title: '镜1', visual: '中景，陈拾收伞回望', motion: '横移跟随', duration: 3, seg: 'opening', tail: '转身欲走', cam: '横移回正' },
    { title: '镜2', visual: '大特写，邮戳裂开', motion: '缓推', duration: 2, seg: 'closeup', tail: '裂开定格', cam: '推进到位' },
  ] });
  const scriptOut10 = '【场1】巷口\n雨夜，陈拾收伞。\n【场2】邮局\n清晨，邮戳裂开。';
  const execs10 = []; // 画布执行桩的成功 exec 记录（断言「不再 exec」用）
  const setRunner10 = (failLabel) => {
    I.__auto.setCanvasRunner(async (pid2, cid2, nodeId) => {
      const d = await I.projectsGet({ id: pid2, ...(cid2 ? { canvasId: cid2 } : {}) });
      const n = d.nodes[nodeId];
      if (!n) throw new Error('桩：节点不存在');
      const label = String((n.data && n.data.label) || '');
      if (failLabel && failLabel.test(label)) throw new Error('桩注入：' + label + ' 生成失败');
      execs10.push({ pid: pid2, nodeId, type: n.type, label });
      if (n.type === 'script') {
        await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: scriptOut10, overwrite: true });
        return { type: 'script', output: scriptOut10 };
      }
      if (n.type === 'storyboard') {
        await I.canvasWriteNode({ projectId: pid2, canvasId: cid2 || undefined, nodeId, target: 'output', text: goodShots10, overwrite: true });
        return { type: 'storyboard', shots: JSON.parse(goodShots10).shots };
      }
      return { type: n.type, status: 'done' };
    });
  };

  // 带计数器的假 LLM（T2 骨架 + 逐角色计数）。每个角色的产物带 tag 前缀 → 「跳过」断言有牙：
  // 续跑若错误重调某角色，该角色计数 >0 且落盘产物内容会变成新 tag（双重穿帮）。
  const roomFake10 = (tag, opts = {}) => {
    const calls = { research: 0, pitchA: 0, pitchB: 0, critique: 0, monitor: 0 };
    let releaseCritique = null;
    const critiqueGate = new Promise((res) => { releaseCritique = res; });
    const fn = async ({ system }) => {
      const s = String(system || '');
      if (s.includes('调研员')) { calls.research++; return JSON.stringify({ themes: [{ name: tag + '调研', why: 't' }], styles: ['写实电影感'] }); }
      if (s.includes('编剧A')) { calls.pitchA++; return JSON.stringify({ logline: tag + 'A案故事线', beats: ['b1', 'b2', 'b3'] }); }
      if (s.includes('编剧B')) { calls.pitchB++; return JSON.stringify({ logline: tag + 'B案故事线', beats: ['c1', 'c2', 'c3'] }); }
      if (s.includes('剧评人')) {
        calls.critique++;
        if (opts.blockCritique) return critiqueGate.then(() => JSON.stringify({ critA: [tag + '互评'], critB: ['动机可信'] }));
        return JSON.stringify({ critA: [tag + '互评'], critB: ['动机可信'] });
      }
      if (s.includes('监制')) {
        calls.monitor++;
        if (opts.monitorProse) return opts.monitorProse(); // 散文两轮 → T2 原失败语义 → run failed
        return JSON.stringify({ decision: 'merge', rationale: '取A冲突+B动机', logline: tag + '定稿故事线', beats: ['x', 'y', 'z'],
          bible: { worldview: tag + '世界观：时空邮局', style: '写实电影感', characters: [{ name: '陈拾', desc: '24 岁，旧邮差制服' }], scenes: [{ name: '褶皱巷', desc: '雨夜窄巷' }], props: [{ name: '火漆信', desc: '火漆印' }],
            scriptIdea: '写第一节剧本：雨夜邮差陈拾接到一封无法投递的信……每场结尾留因果钩子，每场至少一个冲突点。' } });
      }
      return '{}';
    };
    return { calls, fn, unblock: () => releaseCritique() };
  };

  const waitRun10 = async (pid2, want) => {
    let v = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      v = (await M.autoStatus({ projectId: pid2 })).run;
      if (v && want.includes(v.status)) break;
    }
    return v;
  };
  const doc10 = async (pid2) => I.projectsGet({ id: pid2 });
  const nodes10 = (d, type, re) => Object.values(d.nodes).filter((n) => n.type === type && re.test(String((n.data && n.data.label) || '')));

  setRunner10(null);

  // ① 失败→续跑：监制两轮皆散文（T2 语义）→ run failed，research/pitchA/pitchB/crit 已持久化
  const pidT10a = (await byName.get('canvas_create_project').execute({ name: 'T10断点续跑-失败续跑' }, {})).projectId;
  const fBad = roomFake10('首轮', { monitorProse: () => '我们决定融合两案（无 JSON）。' });
  I.__auto.setRoomLlm(fBad.fn);
  const startedBad = await M.autoStart({ projectId: pidT10a, brief: 'T10：监制轮失败后从断点续跑（首轮创意）' });
  ok(startedBad && startedBad.ok === true, 'T10①: 首轮 autoStart 未启动');
  ok(String(startedBad.note).includes('全新启动'), 'T10①: 首轮 note 应注明全新启动（实际：' + (startedBad && startedBad.note) + '）');
  const vBad = await waitRun10(pidT10a, ['failed']);
  ok(vBad && vBad.status === 'failed', 'T10①: 首轮应 run failed（status=' + (vBad && vBad.status) + '）');
  eq(fBad.calls.research, 1, 'T10①: 首轮调研调用数');
  eq(fBad.calls.pitchA, 1, 'T10①: 首轮编剧A调用数');
  eq(fBad.calls.pitchB, 1, 'T10①: 首轮编剧B调用数');
  eq(fBad.calls.critique, 1, 'T10①: 首轮互评调用数');
  eq(fBad.calls.monitor, 2, 'T10①: 监制散文应恰好局部重试一次（调用数应为 2）');
  // 检查点已落盘：四个已完成阶段产物在、未完结、断点停在互评之后
  const psBad = P.readState(pidT10a, null);
  ok(!!psBad && !!psBad.autoRun && !psBad.autoRun.completed, 'T10①: 失败后 ps.autoRun 未完成检查点缺失');
  eq(psBad && psBad.autoRun && psBad.autoRun.phase, 'critique', 'T10①: 断点应停在互评之后');
  ok(!!(psBad && psBad.autoRun && psBad.autoRun.outputs.research && psBad.autoRun.outputs.pitchA && psBad.autoRun.outputs.pitchB && psBad.autoRun.outputs.crit), 'T10①: 四个已完成阶段产物未持久化');
  ok(!(psBad && psBad.autoRun && psBad.autoRun.outputs.dec), 'T10①: 失败阶段（监制）产物不应持久化');
  eq(psBad && psBad.autoRun && psBad.autoRun.brief, 'T10：监制轮失败后从断点续跑（首轮创意）', 'T10①: 检查点 brief 未落盘');
  // 换好假 LLM（产物带「续跑」前缀 → 若被错误重调，调用数与落盘产物双重穿帮），不传 brief → 续跑
  const fGood = roomFake10('续跑');
  I.__auto.setRoomLlm(fGood.fn);
  const resumed = await M.autoStart({ projectId: pidT10a });
  ok(resumed && resumed.ok === true, 'T10①: 不传 brief 的续跑应放行（brief 用存储值）');
  ok(String(resumed.note).includes('断点续跑') && String(resumed.note).includes('跳过 4 个已完成阶段'), 'T10①: note 未注明续跑与跳过数（实际：' + (resumed && resumed.note) + '）');
  const vRes = await waitRun10(pidT10a, ['done', 'failed']);
  ok(vRes && vRes.status === 'done', 'T10①: 续跑未 done（status=' + (vRes && vRes.status) + ' error=' + (vRes && vRes.error) + '）');
  eq(fGood.calls.research, 0, 'T10①: 调研不该被重调');
  eq(fGood.calls.pitchA, 0, 'T10①: 编剧A不该被重调');
  eq(fGood.calls.pitchB, 0, 'T10①: 编剧B不该被重调');
  eq(fGood.calls.critique, 0, 'T10①: 互评不该被重调');
  ok(fGood.calls.monitor >= 1, 'T10①: 监制（失败阶段）应被重调');
  // 落盘产物与首轮一致：会议记录里的调研/A/B提案仍是「首轮」产物（内容前缀穿帮断言）
  const dRes = await doc10(pidT10a);
  const meets10 = nodes10(dRes, 'text', /编剧室会议/);
  eq(meets10.length, 1, 'T10①: 会议节点不应重复建（实际 ' + meets10.length + '）');
  ok(!!meets10[0] && String(meets10[0].data.text || '').includes('首轮调研') && String(meets10[0].data.text || '').includes('首轮A案故事线') && String(meets10[0].data.text || '').includes('首轮B案故事线'),
    'T10①: 会议记录未复用首轮产物（续跑重跑了已完成阶段）');
  eq(nodes10(dRes, 'script', /第1节剧本/).length, 1, 'T10①: 剧本节点不应重复建');
  const boardsRes = nodes10(dRes, 'storyboard', /分镜表/);
  eq(boardsRes.length, 2, 'T10①: 续跑应产出两场分镜');
  ok(boardsRes.every((b) => Array.isArray(b.data.shots) && b.data.shots.length >= 2), 'T10①: 续跑分镜未生成 shots');
  eq(vRes && vRes.budget && vRes.budget.sceneCount, 2, 'T10①: 续跑预算单场数不符');
  eq(vRes && vRes.budget && vRes.budget.videoCalls, 2, 'T10①: 续跑预算单视频调用数不符');
  const runRes = I.__auto.runs.get(pidT10a + '::default');
  ok(!!runRes && (runRes.log || []).some((e) => String(e.summary).includes('断点续跑')), 'T10①: run.log 缺断点续跑标记');
  const bibleRes = await I.canvasGetBible({ projectId: pidT10a });
  ok(!!bibleRes.bible && String(bibleRes.bible.worldview).indexOf('续跑世界观') === 0, 'T10①: 监制重做的新决策未落盘设定集（实际：' + (bibleRes.bible && bibleRes.bible.worldview) + '）');
  // 完结后检查点标 completed，且已完成阶段产物仍是首轮原值（续跑不覆盖产物）
  const psDone = P.readState(pidT10a, null);
  ok(!!psDone && !!psDone.autoRun && psDone.autoRun.completed === true, 'T10①: 完结后检查点应标 completed');
  ok(!!(psDone && psDone.autoRun && psDone.autoRun.outputs.research && psDone.autoRun.outputs.research.themes[0].name === '首轮调研'), 'T10①: 续跑不应覆盖已完成阶段的持久化产物');

  // ② 中途 abort→续跑：互评轮阻塞（never-resolve）→ 前三阶段检查点落盘后 autoAbort → 释放阻塞
  // → 互评照常完成并入检查点，监制入口检查 → run 以 aborted 结束 → 续跑从监制起（前四段零调用）。
  const pidT10b = (await byName.get('canvas_create_project').execute({ name: 'T10断点续跑-abort续跑' }, {})).projectId;
  const fBlock = roomFake10('阻塞轮', { blockCritique: true });
  I.__auto.setRoomLlm(fBlock.fn);
  const startedBlk = await M.autoStart({ projectId: pidT10b, brief: 'T10：中途中止后从断点续跑（阻塞轮创意）' });
  ok(startedBlk && startedBlk.ok === true, 'T10②: 阻塞轮 autoStart 未启动');
  let phaseBlk = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    phaseBlk = (await M.autoStatus({ projectId: pidT10b })).run;
    if (phaseBlk && phaseBlk.phase === 'critique') break;
  }
  ok(!!phaseBlk && phaseBlk.phase === 'critique', 'T10②: 未进入互评阶段（phase=' + (phaseBlk && phaseBlk.phase) + '）');
  const abBlk = await M.autoAbort({ projectId: pidT10b });
  ok(abBlk && abBlk.ok === true, 'T10②: 运行中 autoAbort 应成功');
  fBlock.unblock(); // 释放阻塞：互评完成入检查点，监制入口检查 → aborted
  const vBlk = await waitRun10(pidT10b, ['aborted']);
  ok(vBlk && vBlk.status === 'aborted', 'T10②: 释放后 run 应以 aborted 结束（status=' + (vBlk && vBlk.status) + '）');
  const psBlk = P.readState(pidT10b, null);
  ok(!!psBlk && !!psBlk.autoRun && !psBlk.autoRun.completed, 'T10②: aborted 后未完成检查点缺失');
  eq(psBlk && psBlk.autoRun && psBlk.autoRun.phase, 'critique', 'T10②: 断点应停在互评之后（含释放后完成的互评产物）');
  ok(!!(psBlk && psBlk.autoRun && psBlk.autoRun.outputs.crit && psBlk.autoRun.outputs.research), 'T10②: 释放后完成的互评产物未入检查点');
  const fRes2 = roomFake10('续跑二');
  I.__auto.setRoomLlm(fRes2.fn);
  const resumed2 = await M.autoStart({ projectId: pidT10b });
  ok(!!resumed2 && resumed2.ok === true && String(resumed2.note).includes('跳过 4 个已完成阶段'), 'T10②: 续跑 note 不符（实际：' + (resumed2 && resumed2.note) + '）');
  const vRes2 = await waitRun10(pidT10b, ['done', 'failed']);
  ok(vRes2 && vRes2.status === 'done', 'T10②: abort 后续跑未 done（status=' + (vRes2 && vRes2.status) + ' error=' + (vRes2 && vRes2.error) + '）');
  eq(fRes2.calls.research + fRes2.calls.pitchA + fRes2.calls.pitchB + fRes2.calls.critique, 0, 'T10②: 断点之前的阶段被重调（' + JSON.stringify(fRes2.calls) + '）');
  ok(fRes2.calls.monitor >= 1, 'T10②: 监制未被重调');
  const dRes2 = await doc10(pidT10b);
  eq(nodes10(dRes2, 'text', /编剧室会议/).length, 1, 'T10②: 会议节点不应重复建');
  ok(nodes10(dRes2, 'text', /编剧室会议/).every((n) => String(n.data.text || '').includes('阻塞轮调研')), 'T10②: 会议记录未复用中止前的持久化产物');

  // ③ 换 brief = 全新启动：再造一个未完成断点，然后传不同 brief → 全部阶段重调（检查点被覆盖）
  const pidT10c = (await byName.get('canvas_create_project').execute({ name: 'T10断点续跑-换brief全新' }, {})).projectId;
  const fBad3 = roomFake10('换brief前', { monitorProse: () => '散文（无 JSON）。' });
  I.__auto.setRoomLlm(fBad3.fn);
  await M.autoStart({ projectId: pidT10c, brief: 'T10：换brief前的失败创意' });
  const vBad3 = await waitRun10(pidT10c, ['failed']);
  ok(vBad3 && vBad3.status === 'failed', 'T10③: 前置失败轮未 failed');
  const fNew3 = roomFake10('换brief后');
  I.__auto.setRoomLlm(fNew3.fn);
  const fresh3 = await M.autoStart({ projectId: pidT10c, brief: 'T10：完全不同的另一个创意方向' });
  ok(!!fresh3 && fresh3.ok === true, 'T10③: 换 brief 启动失败');
  ok(String(fresh3.note).includes('全新启动') && !String(fresh3.note).includes('断点续跑'), 'T10③: 换 brief 应全新启动（实际：' + (fresh3 && fresh3.note) + '）');
  const vNew3 = await waitRun10(pidT10c, ['done', 'failed']);
  ok(vNew3 && vNew3.status === 'done', 'T10③: 换 brief 全新流水线未 done（status=' + (vNew3 && vNew3.status) + '）');
  ok(fNew3.calls.research === 1 && fNew3.calls.pitchA === 1 && fNew3.calls.pitchB === 1 && fNew3.calls.critique === 1, 'T10③: 换 brief 后全部阶段应重调（' + JSON.stringify(fNew3.calls) + '）');
  const psNew3 = P.readState(pidT10c, null);
  eq(psNew3 && psNew3.autoRun && psNew3.autoRun.brief, 'T10：完全不同的另一个创意方向', 'T10③: 检查点 brief 未被新 brief 覆盖');
  // ③b 已完结 run（completed）→ 现行为：同一 brief 再启动也是全新（做新的一集）
  const fAgain = roomFake10('再跑一集');
  I.__auto.setRoomLlm(fAgain.fn);
  const again = await M.autoStart({ projectId: pidT10a, brief: 'T10：监制轮失败后从断点续跑（首轮创意）' });
  ok(!!again && again.ok === true && String(again.note).includes('全新启动'), 'T10③b: 已完结 run 再启动应全新（实际：' + (again && again.note) + '）');
  const vAgain = await waitRun10(pidT10a, ['done', 'failed']);
  ok(vAgain && vAgain.status === 'done', 'T10③b: 已完结 run 全新重跑未 done');
  ok(fAgain.calls.research === 1 && fAgain.calls.pitchA === 1, 'T10③b: 已完结 run 不该续跑（' + JSON.stringify(fAgain.calls) + '）');
  const dAgain = await doc10(pidT10a);
  eq(nodes10(dAgain, 'text', /编剧室会议/).length, 2, 'T10③b: 全新启动应新建第二个会议节点');

  // ④ 无持久化 → 现行为全新启动；ps.autoRun 形状损坏（旧版/缺字段）→ 视同无持久化，绝不带病续跑
  const pidT10d = (await byName.get('canvas_create_project').execute({ name: 'T10断点续跑-无持久化' }, {})).projectId;
  const fClean = roomFake10('干净项目');
  I.__auto.setRoomLlm(fClean.fn);
  const clean = await M.autoStart({ projectId: pidT10d, brief: 'T10：干净项目正常全新启动' });
  ok(!!clean && clean.ok === true && String(clean.note).includes('全新启动'), 'T10④: 干净项目应全新启动');
  const vClean = await waitRun10(pidT10d, ['done', 'failed']);
  ok(vClean && vClean.status === 'done', 'T10④: 干净项目未 done');
  ok(fClean.calls.research === 1 && fClean.calls.monitor >= 1, 'T10④: 干净项目流水线未完整跑（' + JSON.stringify(fClean.calls) + '）');
  const pidT10e = (await byName.get('canvas_create_project').execute({ name: 'T10断点续跑-形状损坏' }, {})).projectId;
  P.writeState(pidT10e, null, { version: 1, projectId: pidT10e, canvasKey: 'default', floor: 0, explicit: null, createdAt: Date.now(), updatedAt: 0, history: [], overrides: [], autoRun: { phase: 'decide', brief: '残缺形状的存储brief足够长' } });
  const noBriefBroken = await M.autoStart({ projectId: pidT10e });
  ok(noBriefBroken && noBriefBroken.ok === false, 'T10④: 形状损坏且未传 brief 应按缺 brief 拒绝（不得带病续跑）');
  const fBroken = roomFake10('损坏形状');
  I.__auto.setRoomLlm(fBroken.fn);
  const broken = await M.autoStart({ projectId: pidT10e, brief: 'T10：形状损坏时全新启动（不带病续跑）' });
  ok(!!broken && broken.ok === true && String(broken.note).includes('全新启动'), 'T10④: 形状损坏应视同无持久化');
  const vBroken = await waitRun10(pidT10e, ['done', 'failed']);
  ok(vBroken && vBroken.status === 'done', 'T10④: 形状损坏项目未 done');
  eq(fBroken.calls.research, 1, 'T10④: 形状损坏不应吃检查点（调研被跳过了）');

  // ⑤ 场级断点：场1 分镜完成后场2 exec 注入失败 → run failed（boardIds=[场1]）→ 续跑场1 跳过、场2 重做
  const pidT10f = (await byName.get('canvas_create_project').execute({ name: 'T10断点续跑-场级断点' }, {})).projectId;
  const fMid = roomFake10('场级');
  I.__auto.setRoomLlm(fMid.fn);
  setRunner10(/场2分镜表/);
  const startedMid = await M.autoStart({ projectId: pidT10f, brief: 'T10：场级断点续跑（第二场分镜失败）' });
  ok(startedMid && startedMid.ok === true, 'T10⑤: 场级失败轮未启动');
  const vMid = await waitRun10(pidT10f, ['failed']);
  ok(vMid && vMid.status === 'failed', 'T10⑤: 场2 失败轮未 failed');
  const psMid = P.readState(pidT10f, null);
  ok(!!psMid && !!psMid.autoRun && psMid.autoRun.phase === 'board1' && Array.isArray(psMid.autoRun.boardIds) && psMid.autoRun.boardIds.length === 1
    && Array.isArray(psMid.autoRun.scenes) && psMid.autoRun.scenes.length === 2,
    'T10⑤: 场级检查点缺失（' + JSON.stringify(psMid && psMid.autoRun && { p: psMid.autoRun.phase, b: psMid.autoRun.boardIds, s: psMid.autoRun.scenes && psMid.autoRun.scenes.length }) + '）');
  const dMid1 = await doc10(pidT10f);
  const sbMid1 = nodes10(dMid1, 'storyboard', /场1分镜表/);
  eq(sbMid1.length, 1, 'T10⑤: 前置 场1分镜表 应恰 1 个');
  ok(!!sbMid1[0] && Array.isArray(sbMid1[0].data.shots) && sbMid1[0].data.shots.length >= 2, 'T10⑤: 场1 shots 未生成');
  // 续跑（不传 brief）：LLM 全零调用、剧本不重 exec、场1 不重建不重跑、场2 重做 → done
  setRunner10(null);
  const fMid2 = roomFake10('场级续跑');
  I.__auto.setRoomLlm(fMid2.fn);
  const resumedMid = await M.autoStart({ projectId: pidT10f });
  ok(!!resumedMid && resumedMid.ok === true && String(resumedMid.note).includes('跳过 8 个已完成阶段'), 'T10⑤: 场级续跑 note 不符（实际：' + (resumedMid && resumedMid.note) + '）');
  const vMid2 = await waitRun10(pidT10f, ['done', 'failed']);
  ok(vMid2 && vMid2.status === 'done', 'T10⑤: 场级续跑未 done（status=' + (vMid2 && vMid2.status) + ' error=' + (vMid2 && vMid2.error) + '）');
  eq(fMid2.calls.research + fMid2.calls.pitchA + fMid2.calls.pitchB + fMid2.calls.critique + fMid2.calls.monitor, 0, 'T10⑤: 场级续跑不应调任何 LLM（' + JSON.stringify(fMid2.calls) + '）');
  const exF = execs10.filter((x) => x.pid === pidT10f);
  eq(exF.filter((x) => x.type === 'script').length, 1, 'T10⑤: 剧本不应重新 exec（scenes 应走检查点）');
  eq(exF.filter((x) => /场1分镜表/.test(x.label)).length, 1, 'T10⑤: 场1 分镜不应重新 exec');
  eq(exF.filter((x) => /场2分镜表/.test(x.label)).length, 1, 'T10⑤: 场2 分镜应恰重做 1 次');
  const dMid2 = await doc10(pidT10f);
  eq(nodes10(dMid2, 'storyboard', /场1分镜表/).length, 1, 'T10⑤: 场1分镜表不应重建');
  eq(nodes10(dMid2, 'text', /场1文本/).length, 1, 'T10⑤: 场1文本不应重建');
  const boardsMid2 = nodes10(dMid2, 'storyboard', /分镜表/).filter((b) => Array.isArray(b.data.shots) && b.data.shots.length);
  eq(boardsMid2.length, 2, 'T10⑤: 续跑后应有 2 个带 shots 的分镜表');
  const sb1Mid2 = nodes10(dMid2, 'storyboard', /场1分镜表/)[0] || null;
  const sb2Mid2 = nodes10(dMid2, 'storyboard', /场2分镜表/).find((b) => Array.isArray(b.data.shots) && b.data.shots.length) || null;
  ok(!!sb1Mid2 && !!sb2Mid2 && !!(dMid2.edges || []).find((e) => e.fromNode === sb1Mid2.id && e.toNode === sb2Mid2.id && e.toPort === 'prev'), 'T10⑤: 续跑场2 分镜应接续场1（tail→prev）');
  eq(vMid2 && vMid2.budget && vMid2.budget.sceneCount, 2, 'T10⑤: 续跑预算单场数不符');
  eq(vMid2 && vMid2.budget && vMid2.budget.videoCalls, 2, 'T10⑤: 续跑预算单视频调用数不符');
  const runMid2 = I.__auto.runs.get(pidT10f + '::default');
  ok(!!runMid2 && (runMid2.log || []).some((e) => String(e.summary).includes('场1 分镜已存在（断点续跑），跳过重新生成')), 'T10⑤: 缺场1跳过日志');
  ok(!!runMid2 && Array.isArray(runMid2.boards) && runMid2.boards.length === 2 && runMid2.boards[0].storyboardId === sb1Mid2.id, 'T10⑤: run.boards 未含跳过场的记账');

  await M.autoModeSet({ enabled: false });
  I.closeDb(); // 释放 SQLite 句柄：清理段的 fs.rm 才能删掉沙盒里的 canvas.db（Windows 文件锁）
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
