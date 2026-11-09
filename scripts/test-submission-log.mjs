#!/usr/bin/env node
/**
 * 提交前校验门 / 请求预览 / 脱敏留痕 回归测试（0.20.2 T11）。
 *
 * 覆盖（外部用户 issue 三能力）：
 *  A. 宿主侧（index.js）：redact 单测（sk- 密钥 / 签名 URL / Bearer / 正常文本不受影响 / 深度脱敏）
 *     + submissionLogAppend（追加 / 500 行裁最旧 / 写失败返回 ok:false 不炸 / 无数据根明确说不）
 *  B. 客户端侧（client.js vm 抽取，仿 test-segment-plan）：
 *     - 同一组装承诺：预览轻量 inputs 与 run 全量 inputs 产出的 p 逐字相等、决策字段一致
 *     - warnings 校验门逐条触发：超时长 / 多参考图 / 硬首帧降级 / 首帧忽略 / 分镜零时长 / 模型未配置
 *     - segMeta 切片与 chain 决策经 videoRequestContext 与 run 路径同一份
 *     - 静态断言：run 路径确实调用 assembleVideoRequest（特征串）+ 留痕三条（submitted/failed/done）
 *       + entry 绝不含 taskQueryUrl（带签名地址）+ 留痕写失败绝不影响生成主链路
 *
 * 运行：node scripts/test-submission-log.mjs（沙盒临时目录，零真实副作用）；退出码 0=通过 1=失败
 */
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ============================================================
// A. 宿主侧：redact + submissionLogAppend（沙盒 index.js）
// ============================================================
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-sublog-'));
const DATA = path.join(SANDBOX, 'data');
const CONFIG = path.join(SANDBOX, 'config.json');
process.env.DSH_IC_CONFIG_PATH = CONFIG;
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
fs.writeFileSync(CONFIG, JSON.stringify({}), 'utf8'); // 先不给 dataRoot：验证「无数据根明确说不」

const hostMod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
hostMod.apply({
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
});
const I = hostMod._internals;
const M = I.rpcMethods();
ok(typeof I.redactSubmissionText === 'function' && typeof I.redactSubmissionValue === 'function'
  && typeof I.submissionLogAppendImpl === 'function', '宿主 _internals 未导出 redact/submissionLogAppendImpl（不可单测）');
ok(typeof M.submissionLogAppend === 'function', 'RPC 方法表缺 submissionLogAppend');

// A1) 无数据根：明确说不，绝不 throw
{
  let r = null, threw = false;
  try { r = await M.submissionLogAppend({ projectId: 'p_host', entry: { at: 1 } }); } catch (e) { threw = true; }
  ok(!threw, '无数据根时 submissionLogAppend 抛异常（应返回 ok:false）');
  ok(r && r.ok === false && String(r.error || '').includes('数据根'), '无数据根未返回明确错误');
}

// A2) redact 单测：三条红线 + 正常文本不受影响
{
  const R = I.redactSubmissionText;
  ok(R('我的密钥是 sk-abcdef1234567890 请保密') === '我的密钥是 sk-*** 请保密', 'sk- 密钥未脱敏');
  ok(R('sk-12345678') === 'sk-***', '8 位 sk- 串未脱敏');
  ok(R('下载地址 https://oss.example.com/a.mp4?X-Amz-Signature=deadbeef&exp=1 失效') === '下载地址 [signed-url] 失效', 'X-Amz-Signature 签名 URL 未脱敏');
  ok(R('https://gw.example.com/task?Signature=zz&id=1') === '[signed-url]', 'Signature= 签名 URL 未脱敏');
  ok(R('https://relay.example.com/q?sign=abc123') === '[signed-url]', 'sign= 签名 URL 未脱敏');
  ok(R('https://relay.example.com/q?token=abc123') === '[signed-url]', 'token= 签名 URL 未脱敏');
  ok(R('Authorization: Bearer eyJhbGciOi.abc.def') === 'Authorization: Bearer ***', 'Bearer 令牌未脱敏');
  ok(R('Bearer sk-abcdef12345678') === 'Bearer ***', 'Bearer 内嵌 sk- 未整体脱敏');
  // 正常文本不受影响
  ok(R('时长 20s 超过上限') === '时长 20s 超过上限', '正常中文被误伤');
  ok(R('https://api.example.com/v1/video/generations') === 'https://api.example.com/v1/video/generations', '无签名参数的正常 URL 被误伤');
  ok(R('task id: vid-20261109-001') === 'task id: vid-20261109-001', '普通任务 id 被误伤');
  // 深度脱敏（嵌套对象/数组）
  const deep = I.redactSubmissionValue({ a: 'sk-abcdef12345678', b: ['https://x.com/f?sign=z'], c: { d: 'Bearer q' } });
  ok(deep.a === 'sk-***' && deep.b[0] === '[signed-url]' && deep.c.d === 'Bearer ***', 'redactSubmissionValue 深度脱敏失效');
}

// A3) RPC 追加：JSONL 落盘 + redact 兜底（entry 里塞签名 URL 也要被拦）
fs.writeFileSync(CONFIG, JSON.stringify({ dataRoot: path.resolve(DATA) }), 'utf8');
{
  const r1 = await M.submissionLogAppend({ projectId: 'p_host', entry: { at: 111, status: 'submitted', effectivePrompt: '参考 https://oss.example.com/a?X-Amz-Signature=zz', apiKeyLike: 'sk-abcdef12345678' } });
  ok(r1 && r1.ok === true, 'submissionLogAppend 追加失败');
  const file = path.join(DATA, 'projects', 'p_host', 'submissions.jsonl');
  ok(fs.existsSync(file), 'submissions.jsonl 未落盘到项目目录');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  ok(lines.length === 1, '追加后行数不对');
  const rec = JSON.parse(lines[0]);
  ok(rec.at === 111 && rec.status === 'submitted', 'JSONL 记录字段丢失');
  ok(!lines[0].includes('X-Amz-Signature') && rec.effectivePrompt.includes('[signed-url]'), '落盘内容含签名 URL（红线）');
  ok(!lines[0].includes('sk-abcdef') && rec.apiKeyLike === 'sk-***', '落盘内容含 sk- 密钥（红线）');
}

// A4) 500 行裁最旧
{
  for (let i = 0; i < 505; i++) {
    const r = await M.submissionLogAppend({ projectId: 'p_host', entry: { at: 1000 + i, status: 'done', seq: i } });
    if (!r || !r.ok) { errs.push('批量追加第 ' + i + ' 条失败'); break; }
  }
  const file = path.join(DATA, 'projects', 'p_host', 'submissions.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  ok(lines.length === I.SUBMISSION_LOG_MAX_LINES, '超限后未裁到 500 行（实际 ' + lines.length + '）');
  const first = JSON.parse(lines[0]);
  const last = JSON.parse(lines[lines.length - 1]);
  ok(first.seq === 5, '裁剪方向错误：最旧的应被裁掉（首条 seq=' + first.seq + '，应为 5）');
  ok(last.seq === 504, '最新一条应保留在末尾');
}

// A5) 写失败不炸：abs 指向一个「文件」（目录建不出来）→ ok:false，绝不 throw
{
  const blocked = path.join(SANDBOX, 'blocked-file');
  fs.writeFileSync(blocked, 'not a dir', 'utf8');
  let r = null, threw = false;
  try { r = I.submissionLogAppendImpl(blocked, { at: 1 }); } catch (e) { threw = true; }
  ok(!threw, '写失败时抛异常（留痕绝不能挡主链路）');
  ok(r && r.ok === false, '写失败未返回 ok:false');
}

// ============================================================
// B. 客户端侧：vm 装载 client.js（假 React/DOM/localStorage，仿 test-segment-plan）
// ============================================================
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const noop = () => {};
const elStub = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '',
  appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
  getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
  toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
const lsStore = new Map();
const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };

const PID = 'p_vreq';
lsStore.set('dsh-ic:projects', JSON.stringify([{ id: PID, name: '组装测试', createdAt: 1, updatedAt: 1 }]));
lsStore.set('dsh-ic:active', JSON.stringify(PID));

// 资产元数据（服务端是唯一事实源；assetMem 由 assetsList 填充 → 预览 ref 名称从这里取）
const ASSET_A1 = { id: 'a1', name: '角色-陈拾 设定图', category: 'character', kind: 'image', createdAt: 1 };
const rpcFetch = async (url, opts) => {
  const u = String(url || '');
  if (u.includes('plugin-asset')) return { ok: false, status: 404, text: async () => '', json: async () => ({}) }; // 技能包 manifest 缺失 → 无风格锁（确定性）
  let body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch { /* 忽略 */ }
  if (body.method === 'assetsList') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [ASSET_A1], nextCursor: null }), json: async () => ({ items: [ASSET_A1], nextCursor: null }) };
  }
  const payload = { ok: true };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
};

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: {
    createElement: (tag) => elStub(), createTextNode: (t) => ({ nodeValue: String(t) }),
    head: elStub(), body: elStub(), documentElement: elStub(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null,
    activeElement: null, addEventListener: noop, removeEventListener: noop,
  },
  localStorage: lsStub,
  navigator: { userAgent: 'test-submission-log', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: rpcFetch,
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  Image: class { constructor() { this.src = ''; } },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => { const req = {}; setTimeout(() => { try { req.onerror && req.onerror(); } catch { /* 忽略 */ } }, 0); return req; } },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
if (!mod) { console.error('✗ client.js 顶层执行失败'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
plugin.apply({
  effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} },
  slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} },
});

const VR = sandbox.window.__DSH_IC_VIDEO_REQUEST__;
if (!VR || typeof VR.assembleVideoRequest !== 'function') {
  console.error('✗ 未暴露 window.__DSH_IC_VIDEO_REQUEST__（测试缝隙缺失）');
  process.exit(1);
}
const SYNC = sandbox.window.__DSH_IC_SYNC__;
const SP = sandbox.window.__DSH_IC_STORYBOARD_PROMPT__;
const SEG = sandbox.window.__DSH_IC_SEGMENT__;
ok(!!SYNC && !!SP && !!SEG, '依赖的既有测试缝隙（SYNC/STORYBOARD_PROMPT/SEGMENT）缺失');

// ---- 播种画布：分镜表(2镜×10s) → 视频 n1；设定图 img1 → ref；上一段 v0 → frame(tailpick) ----
const mkVideo = (id, data, y) => ({ id, type: 'video', x: 900, y, w: 320, h: 100, data: Object.assign({ status: 'idle', label: id }, data) });
const doc = {
  nodes: {
    sb1: { id: 'sb1', type: 'storyboard', x: 100, y: 0, w: 320, h: 100, data: { status: 'idle', label: '分镜1', cont: true, shots: [
      { title: '镜1', visual: '@陈拾@ 走进邮局', motion: '缓推', duration: 10, characters: ['陈拾'], scene: '邮局', props: [], dialogue: [], seg: 'continuation' },
      { title: '镜2', visual: '信封特写', motion: '', duration: 10, characters: [], scene: '邮局', props: ['信封'], dialogue: [] },
    ] } },
    v0: mkVideo('v0', { assetId: 'a0', lastAssetId: 'a2', lastPickAssetId: 'a2', label: '上一段' }, 0),
    n1: mkVideo('n1', { prompt: '', frameMode: 'auto', duration: 5, resolution: '720p', ratio: '16:9' }, 400),
  },
  edges: [
    { id: 'e1', fromNode: 'sb1', fromPort: 'out', toNode: 'n1', toPort: 'prompt' },
    { id: 'e2', fromNode: 'img1', fromPort: 'out', toNode: 'n1', toPort: 'ref' },
    { id: 'e3', fromNode: 'v0', fromPort: 'tailpick', toNode: 'n1', toPort: 'frame' },
  ],
};
// e2 引用的 img1 节点（带 assetId → servedAssetId 命中；assetMem 由 assetsList 填充名称）
doc.nodes.img1 = { id: 'img1', type: 'image', x: 500, y: 200, w: 220, h: 160, data: { status: 'idle', label: '角色-陈拾 设定图', assetId: 'a1' } };
SYNC.mergeHostDoc(PID, {
  nodes: doc.nodes, edges: doc.edges,
  bible: { worldview: '', style: '写实', characters: [{ name: '陈拾', desc: '邮差，蓝色制服', voice: '低沉男声' }], scenes: [], props: [] },
  bibleUpdatedAt: Date.now(),
});

// ---- run 路径的独立重建（不借 previewVideoInputs，模拟 runGenNode 的 inputs 组装）----
// 纯函数真身抽取（test-sync-bible 手法）：matchBibleEntity / parseMentions / repairUnclosedMentions
function extractFn(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = a >= 0 ? src.indexOf(endMarker, a) : -1;
  if (a < 0 || b < 0) throw new Error('client.js 抽取锚点丢失: ' + startMarker);
  return src.slice(a, b);
}
const mentionPure = /\/\/ <<<MENTION_PURE_BEGIN>>>([\s\S]*?)\/\/ <<<MENTION_PURE_END>>>/;
const catLabelStub = (c) => ({ character: '角色', scene: '场景', prop: '道具', general: '通用' }[c] || '通用');
const { parseMentions } = new Function('catLabel', 'effLang', mentionPure.exec(src)[1] + '\nreturn { parseMentions };')(catLabelStub, () => 'zh');
const matchBibleEntity = new Function('return (' + extractFn('function matchBibleEntity(name, bible) {', '/** 资产是否属于某实体') + ')')();
const repairUnclosedMentions = new Function('return (' + extractFn('function repairUnclosedMentions(text, knownNames) {', '/** 设定集里的全部资产名') + ')')();
const bibleNames = new Function('return (' + extractFn('function bibleNames(bible) {', '/** 设定集风格锚') + ')')();
const effLang = () => 'zh'; // 沙箱无宿主语言 → 中文（与 client.js 默认一致，确定性）

const graph = SYNC.graph();
const sbNode = graph.nodes.sb1;
const videoN1 = graph.nodes.n1;
const bibleNow = SYNC.loadBible(PID);
const composedPrompt = SP.buildStoryboardVideoPrompt(sbNode, SEG.videoSegmentOf(videoN1)); // resolvePrompt 分镜上游分支的同一函数
const runPrompt = repairUnclosedMentions(composedPrompt, bibleNames(bibleNow));            // run 路径的未闭合引用自愈
const bundleEntities = parseMentions(runPrompt).map((m) => matchBibleEntity(m.name, bibleNow)).filter(Boolean); // resolveMentionBundle 实体通道
const runRefs = [{ name: ASSET_A1.name, category: ASSET_A1.category, entity: '' }];        // collectRefs 描述符形状（entity undefined → ''）
const runInputs = { prompt: runPrompt, bible: bibleNow, refs: runRefs, entities: bundleEntities, audioNames: [], hasFrame: true, frameAuto: false };

// ============================================================
// B1) 同一组装承诺：预览轻量 inputs 与 run 全量 inputs → p 逐字相等 + 决策字段一致
// ============================================================
{
  const inputsP = await VR.previewVideoInputs(graph.nodes.n1);
  ok(inputsP.hasFrame === true, '预览轻量 inputs：frame 口连线+上游 assetId 应判 hasFrame=true（零 blob 解码）');
  ok(Array.isArray(inputsP.refs) && inputsP.refs.length === 1, '预览轻量 inputs：ref 连线未解析出参考图');
  ok(inputsP.refs[0].name === ASSET_A1.name && inputsP.refs[0].category === 'character', '预览 ref 名称/分类未取资产元数据（assetMem）');
  ok(inputsP.refs[0].entity === '', '预览 ref 描述符 entity 应为空串（与 collectRefs 产物同构）');
  ok(inputsP.entities.length === 1 && inputsP.entities[0].name === '陈拾', '预览 @引用 实体解析失效');
  ok(typeof inputsP.prompt === 'string' && inputsP.prompt.includes('陈拾'), '预览 prompt 未走 resolvePrompt 分镜组合');

  const outP = await VR.assembleVideoRequest(graph.nodes.n1, inputsP);
  const outR = await VR.assembleVideoRequest(graph.nodes.n1, runInputs);
  ok(outP.p === outR.p, '同一组装承诺破缺：预览 p 与 run p 不逐字相等');
  const dp = outP.params; const dr = outR.params;
  for (const k of ['duration', 'resolution', 'ratio', 'frameMode', 'hardFrame', 'anchorRole', 'useFrame', 'refNames', 'refRoles', 'audioNames', 'modelLabel', 'segMeta']) {
    ok(JSON.stringify(dp[k]) === JSON.stringify(dr[k]), '决策字段 ' + k + ' 预览与 run 不一致');
  }
  ok(dp.duration === 20, '分镜档时长应为本段镜头求和 20s（实际 ' + dp.duration + '）');
  ok(dp.frameMode === 'auto' && dp.hardFrame === false && dp.anchorRole === 'reference_image', 'auto+参考图+首帧 → 降级为 reference_image 锚定');
  ok(JSON.stringify(dp.refNames) === JSON.stringify([ASSET_A1.name]), 'refNames 应取资产名');
  ok(dp.modelLabel === '', '未配置视频模型时 modelLabel 应为空串（不带 key）');
  // p 内容抽查：结构化组装 + 图序偏移 + 首帧锚定 + 实体设定
  ok(outP.p.includes('subject_definitions:'), '结构化提示词缺 subject_definitions（分镜上游应走 buildStructuredVideoPrompt）');
  ok(outP.p.includes('<Picture 2>'), '降级锚定时实体参考图应为图2（picOffset 失效）');
  ok(outP.p.includes('【首帧锚定】'), '带首帧请求缺首帧锚定文字');
  ok(outP.p.includes('邮差'), '实体设定文字（desc）未注入提示词');
}

// ============================================================
// B2) 校验门逐条触发（每条独立 fixture，只点名一条）
// ============================================================
function seedGraph(nodes, edges) {
  SYNC.mergeHostDoc(PID, { nodes, edges, bibleUpdatedAt: Date.now() });
  return SYNC.graph();
}
const mkImg = (id, aid, y) => ({ id, type: 'image', x: 500, y, w: 220, h: 160, data: { status: 'idle', label: '图' + id, assetId: aid } });

// ① 超时长（分镜档 20s > 15）——fixture B1 已触发；这里独立断言
{
  const g = seedGraph(doc.nodes, doc.edges);
  const out = await VR.assembleVideoRequest(g.nodes.n1, runInputs);
  ok(out.params.warnings.some((w) => w.includes('超过单次生成上限 15s') && w.includes('按镜头切段')), '校验门①失效：超时长未提示');
}
// ② 参考图 >4：独立节点 n2（无分镜、手写 prompt、5 张参考、无首帧）
{
  const nodes = { n2: mkVideo('n2', { prompt: '@陈拾@ 在邮局门口挥手', frameMode: 'auto', duration: 5 }, 0) };
  for (let i = 0; i < 5; i++) nodes['ri' + i] = mkImg('ri' + i, 'a1', i * 10);
  const edges = [];
  for (let i = 0; i < 5; i++) edges.push({ id: 'eri' + i, fromNode: 'ri' + i, fromPort: 'out', toNode: 'n2', toPort: 'ref' });
  const g = seedGraph(nodes, edges);
  const inputs = await VR.previewVideoInputs(g.nodes.n2);
  const out = await VR.assembleVideoRequest(g.nodes.n2, inputs);
  ok(out.params.duration === 5, '未连分镜应回退节点秒数 5s');
  ok(out.params.warnings.some((w) => w.includes('参考图 5 张') && w.includes('上限')), '校验门②失效：参考图超 4 张未提示');
  ok(out.params.warnings.some((w) => w.includes('未配置视频模型')), '校验门⑥失效：模型未配置未提示（预览路径警告不 throw）');
}
// ③ 硬首帧降级（frameMode=auto + 首帧 + 参考图 → anchorRole=reference_image）：fixture B1 同款，独立断言文案
{
  const g = seedGraph(doc.nodes, doc.edges);
  const out = await VR.assembleVideoRequest(g.nodes.n1, runInputs);
  ok(out.params.warnings.some((w) => w.includes('硬首帧与实体参考图互斥') && w.includes('已降级为参考图锚定')), '校验门③失效：锚定降级未提示（静默修改回归）');
}
// ④ 首帧已接线但 frameMode=off
{
  const nodes = {
    v0: mkVideo('v0', { assetId: 'a0', lastPickAssetId: 'a2' }, 0),
    n4: mkVideo('n4', { prompt: '手写', frameMode: 'off', duration: 5 }, 400),
    img4: mkImg('img4', 'a1', 200),
  };
  const edges = [
    { id: 'ef1', fromNode: 'v0', fromPort: 'tailpick', toNode: 'n4', toPort: 'frame' },
    { id: 'ef2', fromNode: 'img4', fromPort: 'out', toNode: 'n4', toPort: 'ref' },
  ];
  const g = seedGraph(nodes, edges);
  const inputs = await VR.previewVideoInputs(g.nodes.n4);
  ok(inputs.hasFrame === true, '预览：frameMode=off 不影响连线存在性判定');
  const out = await VR.assembleVideoRequest(g.nodes.n4, inputs);
  ok(out.params.useFrame === false, 'frameMode=off 时 useFrame 应为 false');
  ok(out.params.warnings.some((w) => w.includes('首帧已接线但 frameMode=off') && w.includes('不带首帧')), '校验门④失效：接线却被 off 忽略未提示');
}
// ⑤ 已连分镜但零镜头时长（既有告警原文保持）
{
  const nodes = {
    sb5: { id: 'sb5', type: 'storyboard', x: 100, y: 0, w: 320, h: 100, data: { label: '空分镜', cont: true, shots: [
      { title: '镜1', visual: '@陈拾@ 空镜', motion: '', duration: 0, characters: ['陈拾'], scene: '', props: [], dialogue: [] },
    ] } },
    n5: mkVideo('n5', { frameMode: 'auto', duration: 5 }, 400),
  };
  const edges = [{ id: 'es5', fromNode: 'sb5', fromPort: 'out', toNode: 'n5', toPort: 'prompt' }];
  const g = seedGraph(nodes, edges);
  const inputs = await VR.previewVideoInputs(g.nodes.n5);
  const out = await VR.assembleVideoRequest(g.nodes.n5, inputs);
  ok(out.params.duration === 5, '分镜零时长应回退 5s');
  ok(out.params.warnings.some((w) => w.includes('已连接分镜但暂无镜头时长')), '校验门⑤失效：既有「分镜零时长」告警丢失');
}
// ⑥ segMeta 切片与 chain 决策（T6 键：segShotFrom/To/Index/Count/needsTailChain）
{
  const nodes = { n6: mkVideo('n6', { prompt: '', frameMode: 'auto', duration: 5, segShotFrom: 0, segShotTo: 0, segIndex: 1, segCount: 3, needsTailChain: true, seamRisk: 'forced' }, 400) };
  const edges = [{ id: 'es6', fromNode: 'sb1', fromPort: 'out', toNode: 'n6', toPort: 'prompt' }];
  const g = seedGraph(nodes, edges);
  const ctx = VR.videoRequestContext(g.nodes.n6);
  ok(ctx.segMeta && ctx.segMeta.from === 0 && ctx.segMeta.to === 0 && ctx.segMeta.index === 1 && ctx.segMeta.count === 3, 'segMeta 解析失效');
  ok(ctx.segMeta.needsTailChain === true && ctx.segMeta.seamRisk === 'forced', 'segMeta 键（needsTailChain/seamRisk）丢失');
  ok(ctx.shotList.length === 1 && ctx.shotList[0].title === '镜1', 'shotList 未按 segMeta 切片');
  ok(ctx.durationPlan.value === 10, '切片后时长应为本段镜头求和 10s');
  ok(ctx.plan.chain === true, 'needsTailChain+continuation 应判 chain=true（续帧接力）');
  const out = await VR.assembleVideoRequest(g.nodes.n6, { prompt: '', bible: bibleNow, refs: [], entities: [], audioNames: [], hasFrame: false, frameAuto: false });
  ok(out.params.duration === 10, 'assembleVideoRequest 应消费切片时长（实际 ' + out.params.duration + '）');
  ok(out.params.frameAuto === false, '调用方未判续帧时 frameAuto 应为 false');
}

// ============================================================
// B3) 静态断言：run 路径确实调用 assembleVideoRequest + 留痕三条 + 红线条文
// ============================================================
{
  ok(src.includes('const assembled = await assembleVideoRequest(n, {'), 'run 路径未调用 assembleVideoRequest（真预览地基缺失）');
  ok(src.includes('refs: refs.map((r) => ({ name: r.name, category: r.category, entity: r.entity || \"\" }))')
    || src.includes("refs: refs.map((r) => ({ name: r.name, category: r.category, entity: r.entity || '' }))"), 'run 路径未传描述符 refs（blob 应只在 apiVideo 时映射）');
  ok(src.includes('window.__DSH_IC_VIDEO_REQUEST__ = { assembleVideoRequest'), '测试缝隙 __DSH_IC_VIDEO_REQUEST__ 缺失');
  ok(src.includes('isVideo ? h(RequestPreview, { n }) : null'), '视频节点面板未挂 RequestPreview（真预览 UI 缺失）');
  ok(src.includes('const inputs = await previewVideoInputs(n)'), '预览面板未走 previewVideoInputs（轻量 inputs 通道缺失）');
  // 留痕三条（submitted / failed / done）
  ok(/status: 'submitted'/.test(src) && /status: 'failed'/.test(src) && /status: 'done'/.test(src), '留痕三态（submitted/failed/done）缺失');
  ok(src.includes("hostRpc('submissionLogAppend', { projectId: S.activeId, entry })"), '留痕未走宿主 RPC submissionLogAppend');
  // 失败留痕必须在 throw 之前（失败可追溯是本能力主要价值）
  ok(/catch \(eSub\) \{[\s\S]{0,400}logVideoSubmission\(\{ \.\.\.logBase\(\), taskId: subTid, status: 'failed'[\s\S]{0,200}throw eSub;/.test(src), '失败留痕不在 throw 之前（失败将无迹可寻）');
  // 留痕写失败绝不影响生成主链路
  ok(/async function logVideoSubmission\(entry\) \{[\s\S]{0,300}hostRpc\('submissionLogAppend'[\s\S]{0,200}\} catch \{/.test(src), 'logVideoSubmission 未兜底 try/catch（留痕可能炸掉生成）');
  // entry 绝不含 taskQueryUrl（带签名地址）：logBase 形状里没有 qurl 字段
  const logBaseBlock = /const logBase = \(\) => \(\{[\s\S]*?\}\);/.exec(src);
  ok(!!logBaseBlock, 'run 路径缺 logBase（留痕 entry 形状缺失）');
  if (logBaseBlock) {
    const blk = logBaseBlock[0];
    ok(blk.includes('effectivePrompt: p') && blk.includes("status: 'submitted'"), 'logBase 缺 effectivePrompt/status 字段');
    ok(!/qurl/.test(blk), 'logBase 含 qurl——带签名地址绝不落盘（红线）');
    ok(!/apiKey/i.test(blk), 'logBase 含 apiKey（红线）');
  }
  // 预览面板不含留痕入口（留痕是自动、无感的）
  ok(!/logVideoSubmission/.test(src.slice(src.indexOf('function RequestPreview'), src.indexOf('/** 文本节点：只显示正文结果'))), '预览面板含留痕入口（应为无感自动）');
}

if (errs.length) {
  console.error('✗ 提交留痕/校验门回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 提交留痕/校验门回归测试通过（redact 三条红线 + 追加/裁剪/写失败不炸 + 同一组装 p 逐字相等 + 校验门六条逐一触发 + run 路径静态锚点）');
process.exit(0);
