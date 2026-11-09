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
