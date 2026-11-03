#!/usr/bin/env node
/**
 * 项目记忆层契约测试（dev-only）：
 *  1) 读写 roundtrip：memoryWrite 落 episodes/<canvasId>.md + 索引条目（title/summary/keywords/status）
 *  2) 索引：memoryRead 无 canvasId 只回索引；有 canvasId 附正文；upsert 保序
 *  3) 摘要限幅：summary ≤120 字、title ≤80、keywords ≤10×24
 *  4) 容错：index.json 损坏 → 读重建不抛；写前备份 index.backup.json
 *  5) 工作区项目：记忆落 <ws>/.infinite-canvas/memory/；数据根项目落数据根项目文件夹
 *  6) 并发：同项目两次并发写顺序串行，索引两条俱全
 * 运行：node scripts/test-memory.mjs（退出码 0=通过；临时目录，不碰真实数据）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-memory-'));
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
const tool = (name) => tools.find((t) => t.name === name);

// 数据根项目 + 工作区项目各一
await I.projectsPut({ id: 'memP1', name: '记忆项目', doc: { nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } } });
const WS_DIR = path.join(SANDBOX, 'ws-mem');
const WS_APP = path.join(WS_DIR, '.infinite-canvas');
fs.mkdirSync(WS_APP, { recursive: true });
fs.writeFileSync(path.join(WS_APP, 'project.json'), JSON.stringify({ id: 'wsMem01', name: '工作区记忆项目', createdAt: 1700000000000, updatedAt: 1700000000000, nodes: {}, edges: [] }), 'utf8');
I.wsProjectsScan([{ id: 'ws-aaaa', path: WS_DIR, title: 'ws-mem', sessionIds: [] }]);

// ---------------- 1) 读写 roundtrip（数据根项目） ----------------
{
  const w = await I.memoryWrite('memP1', 'cvE1', { title: '第1集', summary: '主角觉醒，结识师尊。', keywords: ['觉醒', '师尊'], body: '# 第1集记忆\n\n主角在雷雨夜觉醒。', status: 'done' });
  ok(w && w.ok, 'memoryWrite 数据根项目失败');
  const r = await I.memoryRead('memP1', 'cvE1');
  ok(r && r.ok && r.episode, 'memoryRead 回正文失败');
  eq(r.episode && r.episode.title, '第1集', '正文条目标题不符');
  ok(String(r.episode && r.episode.body).includes('雷雨夜'), '正文内容不符');
  eq(r.index && r.index.episodes && r.index.episodes.length, 1, '索引条目数不符');
  const mdFile = I.projectHomeDir('memP1');
  ok(mdFile && fs.existsSync(path.join(mdFile, 'memory', 'episodes', 'cvE1.md')), '正文未落数据根项目文件夹 memory/episodes/');
}

// ---------------- 2) 索引行为 ----------------
{
  await I.memoryWrite('memP1', 'cvE2', { title: '第2集', summary: '入门试炼。', body: '试炼开始。' });
  const idxOnly = await I.memoryRead('memP1');
  ok(idxOnly && idxOnly.ok && idxOnly.index, 'memoryRead 索引失败');
  eq(idxOnly.index.episodes.length, 2, '索引应有两条');
  ok(idxOnly.episode === null || idxOnly.episode === undefined, '无 canvasId 时不应带正文');
  ok(idxOnly.index.episodes[0].canvasId === 'cvE1', '索引保序失败（首写应在前）');
  // upsert：同 canvasId 重写 → 仍一条、内容更新、位置不变
  await I.memoryWrite('memP1', 'cvE1', { title: '第1集', summary: '修改后的摘要。', body: '新正文。', status: 'done' });
  const after = await I.memoryRead('memP1');
  eq(after.index.episodes.length, 2, 'upsert 后索引应仍两条');
  eq(after.index.episodes[0].summary, '修改后的摘要。', 'upsert 未更新摘要');
  eq(after.index.episodes[0].canvasId, 'cvE1', 'upsert 打乱了顺序');
  const r2 = await I.memoryRead('memP1', 'cvE1');
  ok(String(r2.episode && r2.episode.body).includes('新正文'), 'upsert 未更新正文');
}

// ---------------- 3) 限幅 ----------------
{
  await I.memoryWrite('memP1', 'cvE3', {
    title: 'T'.repeat(200),
    summary: 'S'.repeat(500),
    keywords: Array.from({ length: 30 }, (_, i) => 'K'.repeat(40)),
    body: 'b',
  });
  const r = await I.memoryRead('memP1', 'cvE3');
  ok(r.episode.title.length <= 80, 'title 未限幅 80');
  ok(r.episode.summary.length <= 120, 'summary 未限幅 120');
  ok(r.episode.keywords.length <= 10 && r.episode.keywords.every((k) => k.length <= 24), 'keywords 未限幅 10×24');
}

// ---------------- 4) 容错 + 备份 ----------------
{
  const home = I.projectHomeDir('memP1');
  const idxFile = path.join(home, 'memory', 'index.json');
  const good = fs.readFileSync(idxFile, 'utf8');
  fs.writeFileSync(idxFile, '{corrupted!!!', 'utf8');
  const r = await I.memoryRead('memP1');
  ok(r && r.ok && Array.isArray(r.index.episodes) && r.index.episodes.length === 0, '损坏索引应容错为空索引');
  // 再次写 → 备份生成
  await I.memoryWrite('memP1', 'cvE9', { title: '重建', summary: '损坏后首写。', body: 'x' });
  ok(fs.existsSync(path.join(home, 'memory', 'index.backup.json')), '覆盖前未备份 index.backup.json');
  // 恢复正常内容供后续用例
  fs.writeFileSync(idxFile, good, 'utf8');
}

// ---------------- 5) 工作区项目记忆落位 ----------------
{
  await I.memoryWrite('wsMem01', 'cvW1', { title: '第1集', summary: '工作区记忆。', body: 'WS 记忆正文' });
  const r = await I.memoryRead('wsMem01', 'cvW1');
  ok(r && r.ok, '工作区项目记忆读取失败');
  ok(fs.existsSync(path.join(WS_APP, 'memory', 'episodes', 'cvW1.md')), '工作区记忆正文未落 <ws>/.infinite-canvas/memory/episodes/');
  ok(fs.existsSync(path.join(WS_APP, 'memory', 'index.json')), '工作区记忆索引未落 <ws>/.infinite-canvas/memory/');
}

// ---------------- 6) 并发串行 ----------------
{
  await Promise.all([
    I.memoryWrite('memP1', 'cvC1', { title: '并发甲', summary: '甲', body: '甲正文' }),
    I.memoryWrite('memP1', 'cvC2', { title: '并发乙', summary: '乙', body: '乙正文' }),
  ]);
  const r = await I.memoryRead('memP1');
  ok(r.index.episodes.some((e) => e.canvasId === 'cvC1') && r.index.episodes.some((e) => e.canvasId === 'cvC2'), '并发写丢条目');
  const r1 = await I.memoryRead('memP1', 'cvC1');
  const r2 = await I.memoryRead('memP1', 'cvC2');
  ok(String(r1.episode && r1.episode.body).includes('甲') && String(r2.episode && r2.episode.body).includes('乙'), '并发写正文互相覆盖');
}

// ---------------- 7) Agent 工具：canvas_read_memory / canvas_write_memory ----------------
{
  const rd = tool('canvas_read_memory');
  const wr = tool('canvas_write_memory');
  ok(!!rd, '缺少 canvas_read_memory 工具');
  ok(!!wr, '缺少 canvas_write_memory 工具');
  if (rd && wr) {
    ok(/记忆/.test(rd.description) && /先/.test(rd.description), 'read 工具描述缺「记忆先行」纪律');
    ok(/回写|写回|write_memory/.test(wr.description), 'write 工具描述缺「回写」纪律');
    // 写 → 读 roundtrip（工具面）
    const w = await wr.execute({ projectId: 'memP1', canvasId: 'cvE1', title: '第1集', summary: '工具写摘要。', keywords: ['工具'], body: '工具正文', status: 'done' });
    ok(w && w.ok, 'canvas_write_memory 执行失败');
    const rIdx = await rd.execute({ projectId: 'memP1' });
    ok(rIdx && rIdx.ok && /第1集/.test(rIdx.text) && /工具写摘要。/.test(rIdx.text), 'read 工具索引输出缺条目');
    const rFull = await rd.execute({ projectId: 'memP1', canvasId: 'cvE1' });
    ok(rFull && rFull.ok && /工具正文/.test(rFull.text), 'read 工具未回正文');
    // 参数校验
    const bad = await wr.execute({ projectId: 'memP1', title: 'x', summary: 'y', body: 'z' });
    ok(bad && bad.ok === false, '缺 canvasId 未拒绝');
    const bad2 = await rd.execute({ projectId: '不存在的项目', canvasId: 'cv1' });
    ok(bad2 && (bad2.ok === true || bad2.ok === false), 'read 对未知项目应容错返回（空索引），不抛');
  }
}

// ---------------- 8) 会话感知默认值 + 代码级跨画布禁令 ----------------
{
  // 工作区项目 + 绑定：ses_bound → cvS1（子画布）
  const made = await I.canvasCreate({ projectId: 'wsMem01', name: '第1集' });
  const cid = made && made.canvasId;
  ok(!!cid, '会话感知用例建画布失败');
  const bs = await I.bindingSet('wsMem01', 'ses_bound', cid, () => true);
  ok(bs && bs.ok, '会话感知用例绑定失败');
  const rd = tool('canvas_read_memory');
  ok(!!rd, '缺少 canvas_read_memory 工具');
  if (rd && cid) {
    // 预置该画布记忆，正文含标记词
    await I.memoryWrite('wsMem01', cid, { title: '第1集', summary: '嗅探默认值。', body: 'SNIFFED-BODY' });
    await I.memoryWrite('wsMem01', 'cvOther', { title: '其他集', summary: 'x', body: 'OTHER-BODY' });
    // ① exec 带 agent.sessionId → 不传 projectId/canvasId 也命中绑定画布
    const r1 = await rd.execute({}, { agent: { sessionId: 'ses_bound' } });
    ok(r1 && r1.ok && /SNIFFED-BODY/.test(r1.text || ''), 'exec.agent.sessionId 嗅探未命中绑定画布');
    // ② exec 带 branded id（{value}）
    const r2 = await rd.execute({}, { agent: { session: { value: 'ses_bound' } } });
    ok(r2 && r2.ok && /SNIFFED-BODY/.test(r2.text || ''), 'branded sessionId 嗅探失败');
    // ③ 无 exec → 行为不变（只回索引，不猜项目）
    const r3 = await rd.execute({});
    ok(r3 && r3.ok && !/SNIFFED-BODY/.test(r3.text || ''), '无 exec 时不应猜默认项目');
    // ④ 代码级禁令：绑定会话显式传**别的画布** → 拒绝（locked）
    const r4 = await rd.execute({ projectId: 'wsMem01', canvasId: 'cvOther' }, { agent: { sessionId: 'ses_bound' } });
    ok(r4 && r4.ok === false && r4.locked === true, '跨画布显式操作未被拒绝（强限制缺失）');
    ok(/解绑/.test(r4 && r4.text || ''), '拒绝文案缺「先解绑」指引');
    // ⑤ 代码级禁令：显式传**别的项目** → 拒绝
    const r5 = await rd.execute({ projectId: 'memP1', canvasId: 'cvE1' }, { agent: { sessionId: 'ses_bound' } });
    ok(r5 && r5.ok === false && r5.locked === true, '跨项目显式操作未被拒绝（强限制缺失）');
    // ⑥ 显式传绑定值本身 → 放行
    const r6 = await rd.execute({ projectId: 'wsMem01', canvasId: cid }, { agent: { sessionId: 'ses_bound' } });
    ok(r6 && r6.ok && /SNIFFED-BODY/.test(r6.text || ''), '显式传绑定值被误拒');
    // ⑦ 解绑后恢复自由：显式跨画布放行
    await I.bindingClear('wsMem01', 'ses_bound');
    const r7 = await rd.execute({ projectId: 'wsMem01', canvasId: 'cvOther' }, { agent: { sessionId: 'ses_bound' } });
    ok(r7 && r7.ok && /OTHER-BODY/.test(r7.text || ''), '解绑后未恢复跨画布自由');
    // 重新绑定供 my_canvas 用例
    await I.bindingSet('wsMem01', 'ses_bound', cid, () => true);
  }
  // canvas_my_canvas：自证身份 + 禁令提示
  const my = tool('canvas_my_canvas');
  ok(!!my, '缺少 canvas_my_canvas 工具');
  if (my) {
    const m1 = await my.execute({}, { agent: { sessionId: 'ses_bound' } });
    ok(m1 && m1.ok && m1.projectId === 'wsMem01' && m1.canvasId === cid, 'canvas_my_canvas 未解析出绑定画布');
    ok(/禁止跨/.test(m1.text || ''), 'canvas_my_canvas 输出缺跨画布禁令提示');
    const m2 = await my.execute({});
    ok(m2 && m2.ok === false, 'canvas_my_canvas 无 exec 应报「无法识别会话」');
  }
  // 绑定会话对其他工具同样被锁（以设定集写为例：跨项目 projectId → 拒绝）
  const bible = tool('canvas_update_bible');
  ok(!!bible, '缺少 canvas_update_bible 工具');
  if (bible) {
    const bx = await bible.execute({ projectId: 'memP1', bible: { style: 'x' } }, { agent: { sessionId: 'ses_bound' } });
    ok(bx && bx.ok === false && bx.locked === true, '设定集写的跨项目操作未被拒绝');
  }
  // 数据根项目也可绑定：全局查找 + 工具默认值同样命中
  const plainBind = await I.bindingSet('memP1', 'ses_plain', null, () => true);
  ok(plainBind && plainBind.ok, '数据根项目绑定失败');
  const rp = await rd.execute({}, { agent: { sessionId: 'ses_plain' } });
  ok(rp && rp.ok && /第1集/.test(rp.text || ''), '数据根项目绑定未被工具默认值命中（全局查找缺失）');
  await I.bindingClear('memP1', 'ses_plain');
}

// ---------------- 结果 ----------------
if (errs.length) {
  console.error('✗ test-memory FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-memory PASS');
