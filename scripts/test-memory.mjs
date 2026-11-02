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

// ---------------- 结果 ----------------
if (errs.length) {
  console.error('✗ test-memory FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-memory PASS');
