#!/usr/bin/env node
/**
 * 宿主模型桥接（model-bridge.cjs）契约测试（dev-only，不随包发布）。
 *
 * 全程本地 mock 网关（http.createServer 随机端口，记录收到的 headers/body）+ 临时目录注入
 * （discoverHosts paths / chat hostVersion），绝不读写真实 ~/.workbuddy、~/.qoder-cn
 * （需求：task-4-brief.md；密钥红线：任何 Error.message/日志/序列化出口不得含 apiKey 明文）。
 *  组1 happy path：discoverHosts 读注入 models.json → Model 字段保真（host/id/vendor/url/
 *      apiKey 内存持有/三个 supports*）；chat 走 mock：请求 URL = 条目 url 路径、
 *      authorization = Bearer <条目key>、user-agent = WorkBuddy/<注入版本>（经 buildUserAgent
 *      纯函数注入，不走真实安装目录）、content-type、body.model 透传条目 id、messages 数组
 *      直传、opts.body 合并；choices[0].message.content → text；usage 透传
 *  组2 非 2xx 脱敏：mock 500 且 body 回显 sk-abc123def456 → Error.message 含
 *      `workbuddy/<id> HTTP 500:` 前缀与 [redacted]，绝无 key 明文；body 截断至 500 字符；
 *      边界残片（评审修复钉死）：key 起始于 493/193 位横跨 500/200 截断边界 → message
 *      不含任何 sk- 残片（先 redact 全文后截断的顺序断言）
 *  组3 网络错误/超时：永不响应 mock + opts.timeout 300 → 抛「超时」（AbortController 生效，
 *      ≈300ms 而非默认 120s）；对已关闭端口请求 → ECONNREFUSED；两类 message 均含 host/id/
 *      原因、经 redact、无 key 明文
 *  组4 空配置降级：models.json 不存在 / 空数组 / 坏 JSON / 非 JSON 数组 → workbuddy:[] 且
 *      绝不抛错；缺 url / 缺 apiKey / 非对象条目被跳过
 *  组5 qoder/cursor：临时空目录与不存在目录 → qoder:[] 不抛错；cursor 恒 []；
 *      QODER_OPENAPI_ENDPOINT 存在性只记录布尔到 stderr（捕获断言），不发请求
 *  组6 redactModel：apiKey → 字面 '[redacted]'，序列化无明文，原对象不被改动
 *  组7 buildUserAgent 纯函数：WorkBuddy/<v>、QoderCN/<v>；版本缺失/非法 → dsh-bridge/0.1.0
 *  组8 redact 直测：sk-[A-Za-z0-9_-]{8,} 全局替换为 [redacted]；不足 8 位不误伤
 * 存储根：临时目录挂 adapters/.tmp-home/ 下（同 Task 1/2/3 模式，gitignored）。
 * 收尾：关闭全部 mock server（含连接清理）、还原 stderr、删临时目录，端口不残留。
 * 运行：node scripts/test-adapters-model-bridge.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BRIDGE_PATH = path.join(ROOT, 'adapters', 'shared', 'model-bridge.cjs');
const TMP_BASE = path.join(ROOT, 'adapters', '.tmp-home');
const LEAK_KEY = 'sk-abc123def456'; // brief 钉死的脱敏断言用 key（响应体回显场景）

let bridge = null;
try { bridge = require(BRIDGE_PATH); } catch { /* TDD RED 阶段模块尚不存在，属预期 */ }

const errs = [];
const servers = new Set(); // 本测试起的全部 mock server（收尾统一关闭）
let tmpRoot = null;

/** 在临时根下再开一层一次性目录。 */
function mkTmp(name) {
  return fs.mkdtempSync(path.join(tmpRoot, name + '-'));
}

/** 写文件（字符串原样，否则 JSON 序列化），返回路径。 */
function writeFix(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

/**
 * 起 mock 网关：记录每个请求 {method, url, headers, bodyText}，用 responder 产生响应。
 * responder(res, hit)；永不调用 res.end 即可制造超时场景。
 */
async function startMock(responder) {
  const state = { hits: [], server: null, port: 0 };
  state.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => { /* 客户端中止（超时场景）属预期，忽略 */ });
    req.on('end', () => {
      const hit = {
        method: req.method,
        url: req.url,
        headers: Object.assign({}, req.headers),
        bodyText: Buffer.concat(chunks).toString('utf8'),
      };
      state.hits.push(hit);
      responder(res, hit);
    });
  });
  servers.add(state.server);
  await new Promise((ok, bad) => {
    state.server.once('error', bad);
    state.server.listen(0, '127.0.0.1', ok);
  });
  state.port = state.server.address().port;
  return state;
}

/** 固定 JSON 响应的 responder 工厂。 */
function jsonResponder(payload, status = 200) {
  return (res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

/** 收尾：关全部 mock server（含连接清理）+ 删临时根。任何一步失败不掩盖主流程结果。 */
async function cleanup() {
  for (const s of servers) {
    try { s.unref(); } catch { /* 忽略 */ }
    try { s.closeAllConnections(); } catch { /* 旧 node 无此方法 */ }
    await Promise.race([
      new Promise((ok) => { try { s.close(ok); } catch { ok(); } }),
      new Promise((ok) => setTimeout(ok, 3000)),
    ]);
  }
  servers.clear();
  if (tmpRoot) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

try {
  if (!bridge) {
    errs.push('adapters/shared/model-bridge.cjs 不存在或加载失败（TDD RED 阶段属预期，实现后应消失）');
    throw new Error('模块缺失，跳过后续组');
  }
  const { discoverHosts, redactModel, redact, buildUserAgent, chat } = bridge;

  fs.mkdirSync(TMP_BASE, { recursive: true });
  tmpRoot = fs.mkdtempSync(path.join(TMP_BASE, 'bridge-'));

  // ---------- 组1：happy path（discover 保真 + chat 全链路断言） ----------
  const dir1 = mkTmp('happy');
  const mock1 = await startMock(jsonResponder({
    id: 'chatcmpl-test-1',
    choices: [{ index: 0, message: { role: 'assistant', content: '第一幕：开场……第二幕：转折……第三幕：收束。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  }));
  const KEY_A = 'sk-wblocaltest12345678';
  const entryA = {
    id: 'claude-sonnet-5',
    vendor: 'claude',
    url: `http://127.0.0.1:${mock1.port}/v1/chat/completions`,
    apiKey: KEY_A,
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: false,
  };
  const modelsFile1 = writeFix(dir1, 'models.json', [entryA]);
  const qoderDir1 = path.join(dir1, '.models');
  fs.mkdirSync(qoderDir1, { recursive: true });

  const disc1 = discoverHosts({ paths: { workbuddyModels: modelsFile1, qoderModelsDir: qoderDir1 } });
  if (!Array.isArray(disc1.workbuddy) || disc1.workbuddy.length !== 1) {
    errs.push(`组1 workbuddy 应恰好 1 个模型，实际 ${Array.isArray(disc1.workbuddy) ? disc1.workbuddy.length : typeof disc1.workbuddy}`);
  }
  const got1 = disc1.workbuddy && disc1.workbuddy[0];
  if (!got1 || got1.host !== 'workbuddy') errs.push(`组1 host 应为 'workbuddy'，实际 ${got1 && got1.host}`);
  if (!got1 || got1.id !== 'claude-sonnet-5') errs.push(`组1 id 应透传条目 id，实际 ${got1 && got1.id}`);
  if (!got1 || got1.vendor !== 'claude') errs.push(`组1 vendor 应透传条目 vendor，实际 ${got1 && got1.vendor}`);
  if (!got1 || got1.url !== entryA.url) errs.push(`组1 url 应透传条目 url，实际 ${got1 && got1.url}`);
  if (!got1 || got1.apiKey !== KEY_A) errs.push('组1 apiKey 应在内存中原样持有（仅供 chat 直调，出口必须过 redactModel）');
  if (!got1 || got1.supportsToolCall !== true || got1.supportsImages !== true || got1.supportsReasoning !== false) {
    errs.push(`组1 supports* 应透传，实际 ${JSON.stringify(redactModel(got1 || {}))}`);
  }
  if (!Array.isArray(disc1.qoder) || disc1.qoder.length !== 0) errs.push(`组1 注入空 qoder 目录应 qoder:[]，实际 ${disc1.qoder && disc1.qoder.length}`);
  if (!Array.isArray(disc1.cursor) || disc1.cursor.length !== 0) errs.push(`组1 cursor 恒 []，实际 ${disc1.cursor && disc1.cursor.length}`);

  const messages1 = [
    { role: 'system', content: '你是画布编剧室' },
    { role: 'user', content: '给一版三幕大纲' },
  ];
  const r1 = await chat(got1, messages1, { hostVersion: '9.9.9', timeout: 8000, body: { temperature: 0.7, max_tokens: 256 } });
  if (!mock1.hits.length) errs.push('组1 mock 网关应收到请求');
  else {
    if (mock1.hits.length !== 1) errs.push(`组1 chat 应只发一次请求，实际 ${mock1.hits.length}`);
    const hit1 = mock1.hits[0];
    if (hit1.url !== '/v1/chat/completions') errs.push(`组1 请求 URL 应为条目 url 的路径 /v1/chat/completions，实际 ${hit1.url}`);
    if (hit1.headers.authorization !== 'Bearer ' + KEY_A) {
      errs.push(`组1 authorization 应为 "Bearer <条目key>"，实际 ${redact(String(hit1.headers.authorization))}`);
    }
    if (hit1.headers['user-agent'] !== 'WorkBuddy/9.9.9') {
      errs.push(`组1 user-agent 应为 WorkBuddy/9.9.9（注入版本经 buildUserAgent），实际 ${hit1.headers['user-agent']}`);
    }
    if (!String(hit1.headers['content-type'] || '').includes('application/json')) {
      errs.push(`组1 content-type 应含 application/json，实际 ${hit1.headers['content-type']}`);
    }
    let body1 = null;
    try { body1 = JSON.parse(hit1.bodyText); } catch { errs.push(`组1 请求体应为合法 JSON，实际 ${hit1.bodyText.slice(0, 120)}`); }
    if (body1) {
      if (body1.model !== 'claude-sonnet-5') errs.push(`组1 body.model 应透传条目 id，实际 ${body1.model}`);
      if (JSON.stringify(body1.messages) !== JSON.stringify(messages1)) errs.push('组1 messages 应作为数组直传（不包裹不改编）');
      if (body1.temperature !== 0.7 || body1.max_tokens !== 256) errs.push('组1 opts.body 应合并进请求 body（temperature/max_tokens）');
    }
  }
  if (!r1 || r1.text !== '第一幕：开场……第二幕：转折……第三幕：收束。') {
    errs.push(`组1 text 应解析 choices[0].message.content，实际 ${r1 && JSON.stringify(r1.text).slice(0, 80)}`);
  }
  if (!r1 || !r1.usage || r1.usage.prompt_tokens !== 11 || r1.usage.total_tokens !== 33) {
    errs.push(`组1 usage 应透传，实际 ${r1 && JSON.stringify(r1.usage)}`);
  }

  // ---------- 组2：非 2xx 脱敏（响应体回显 key） ----------
  const mock2 = await startMock((res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '网关校验失败，回显 key ' + LEAK_KEY + ' 拒绝', trace: 'x'.repeat(1200) } }));
  });
  const model2 = {
    host: 'workbuddy', id: 'claude-sonnet-5', vendor: 'claude',
    url: `http://127.0.0.1:${mock2.port}/v1/chat/completions`,
    apiKey: 'sk-errcasekey98765432',
  };
  let err2 = null;
  try { await chat(model2, [{ role: 'user', content: 'hi' }], { hostVersion: '1.0.0' }); } catch (e) { err2 = e; }
  if (!err2) errs.push('组2 非 2xx 应抛 Error');
  else {
    if (err2.message.includes(LEAK_KEY)) errs.push('组2 Error.message 含响应体回显的 key 明文——密钥红线（必须 [redacted]）');
    if (!err2.message.includes('[redacted]')) errs.push(`组2 Error.message 应含 [redacted]，实际 ${err2.message.slice(0, 120)}`);
    if (!err2.message.startsWith('workbuddy/claude-sonnet-5 HTTP 500:')) {
      errs.push(`组2 message 前缀应为 "host/<id> HTTP <status>:"，实际 ${err2.message.slice(0, 60)}`);
    }
    const snippet2 = err2.message.slice('workbuddy/claude-sonnet-5 HTTP 500: '.length); // 含前缀后的分隔空格
    if (snippet2.length > 500) errs.push(`组2 body 片段应截断至 500 字符，实际 ${snippet2.length}`);
  }
  // 组2b 边界残片（评审修复钉死，500 路径）：key 起始于第 493 位（0 基）横跨 500 截断边界——
  // 旧顺序「先截断后 redact」会留下 'sk-abcdefg'（≤7 字）残片逃过 {8,} 正则；新顺序
  // 「先 redact 全文后截断」下 message 不得含任何 sk- 字样，且应见截断中的 [reda… 残标
  const mock2b = await startMock((res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('x'.repeat(493) + LEAK_KEY + 'y'.repeat(60));
  });
  const model2b = {
    host: 'workbuddy', id: 'claude-sonnet-5', vendor: 'claude',
    url: `http://127.0.0.1:${mock2b.port}/v1/chat/completions`,
    apiKey: 'sk-boundarycase55667788',
  };
  let err2b = null;
  try { await chat(model2b, [{ role: 'user', content: 'hi' }], { hostVersion: '1.0.0' }); } catch (e) { err2b = e; }
  if (!err2b) errs.push('组2b 边界用例应抛 Error');
  else {
    if (err2b.message.includes('sk-')) errs.push(`组2b key 横跨 500 边界时 message 含 sk- 残片（旧顺序回归），尾部: ${err2b.message.slice(-60)}`);
    if (!err2b.message.includes('[reda')) errs.push(`组2b message 应含截断中的 [reda… 残标（证明先 redact 后截断），实际: ${err2b.message.slice(-60)}`);
  }
  // 组2c 边界残片（200 非 JSON 路径）：key 起始于第 193 位横跨 200 截断边界，同款顺序断言
  const mock2c = await startMock((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(193) + LEAK_KEY + 'y'.repeat(40));
  });
  const model2c = {
    host: 'workbuddy', id: 'claude-sonnet-5', vendor: 'claude',
    url: `http://127.0.0.1:${mock2c.port}/v1/chat/completions`,
    apiKey: 'sk-boundarycase88990011',
  };
  let err2c = null;
  try { await chat(model2c, [{ role: 'user', content: 'hi' }], { hostVersion: '1.0.0' }); } catch (e) { err2c = e; }
  if (!err2c) errs.push('组2c 边界用例应抛 Error');
  else {
    if (!err2c.message.includes('响应非 JSON')) errs.push(`组2c 非 JSON 2xx 应抛「响应非 JSON」，实际 ${err2c.message.slice(0, 60)}`);
    if (err2c.message.includes('sk-')) errs.push(`组2c key 横跨 200 边界时 message 含 sk- 残片（旧顺序回归），尾部: ${err2c.message.slice(-60)}`);
    if (!err2c.message.includes('[reda')) errs.push(`组2c message 应含截断中的 [reda… 残标，实际: ${err2c.message.slice(-60)}`);
  }

  // ---------- 组3：超时（AbortController）与连接拒绝 ----------
  const mock3 = await startMock(() => { /* 故意永不响应，制造超时 */ });
  const model3 = {
    host: 'workbuddy', id: 'claude-sonnet-5', vendor: 'claude',
    url: `http://127.0.0.1:${mock3.port}/v1/chat/completions`,
    apiKey: 'sk-timeoutcase44332211',
  };
  const t3 = Date.now();
  let err3 = null;
  try { await chat(model3, [{ role: 'user', content: 'hi' }], { timeout: 300, hostVersion: '9.9.9' }); } catch (e) { err3 = e; }
  const cost3 = Date.now() - t3;
  if (!err3) errs.push('组3 超时应抛 Error');
  else {
    if (cost3 > 5000) errs.push(`组3 opts.timeout 300 应经 AbortController 约 300ms 生效，实际 ${cost3}ms`);
    if (!(err3.message.includes('超时') && err3.message.includes('workbuddy/claude-sonnet-5'))) {
      errs.push(`组3 超时 message 应含 host/id/原因（超时），实际 ${err3.message.slice(0, 120)}`);
    }
    if (err3.message.includes('sk-timeoutcase44332211')) errs.push('组3 超时 message 不得含 key 明文（红线）');
  }
  // 连接拒绝：取一个空闲端口后立即释放
  const freePort = await new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
  let err4 = null;
  const model4 = {
    host: 'workbuddy', id: 'claude-sonnet-5', vendor: 'claude',
    url: `http://127.0.0.1:${freePort}/v1/chat/completions`,
    apiKey: 'sk-refusedkey77889900',
  };
  try { await chat(model4, [{ role: 'user', content: 'hi' }], { hostVersion: '9.9.9' }); } catch (e) { err4 = e; }
  if (!err4) errs.push('组3 连接拒绝应抛 Error');
  else {
    if (!(err4.message.includes('ECONNREFUSED') && err4.message.includes('workbuddy/'))) {
      errs.push(`组3 连接拒绝 message 应含 host/id/原因（ECONNREFUSED），实际 ${err4.message.slice(0, 120)}`);
    }
    if (err4.message.includes('sk-refusedkey77889900')) errs.push('组3 连接拒绝 message 不得含 key 明文（红线）');
  }

  // ---------- 组4：空配置降级 + 条目跳过 ----------
  const dir4 = mkTmp('degrade');
  const qoderDir4 = path.join(dir4, '.models');
  fs.mkdirSync(qoderDir4, { recursive: true });
  const degradeCases = [
    ['文件不存在', path.join(dir4, 'no-such-models.json')],
    ['空数组', writeFix(dir4, 'empty.json', [])],
    ['坏 JSON', writeFix(dir4, 'bad.json', '{oops 不是 JSON')],
    ['非 JSON 数组', writeFix(dir4, 'obj.json', { workbuddy: [] })],
  ];
  for (const [label, file] of degradeCases) {
    let d = null;
    try { d = discoverHosts({ paths: { workbuddyModels: file, qoderModelsDir: qoderDir4 } }); } catch (e) {
      errs.push(`组4 ${label}：discoverHosts 绝不抛错，实际抛出 ${e.message}`);
      continue;
    }
    if (!Array.isArray(d.workbuddy) || d.workbuddy.length !== 0) {
      errs.push(`组4 ${label}：应降级为 workbuddy:[]，实际 ${JSON.stringify(d.workbuddy && d.workbuddy.length)}`);
    }
  }
  const skipFile = writeFix(dir4, 'skip.json', [
    { id: 'gpt-5o', vendor: 'openai', url: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'sk-goodkey1234567890' },
    { id: 'no-url', vendor: 'v', apiKey: 'sk-nourlkey12345678' }, // 缺 url → 跳过
    { id: 'no-key', vendor: 'v', url: 'http://127.0.0.1:9/v1/chat/completions' }, // 缺 apiKey → 跳过
    null, // 非对象条目 → 跳过
  ]);
  const dSkip = discoverHosts({ paths: { workbuddyModels: skipFile, qoderModelsDir: qoderDir4 } });
  if (!Array.isArray(dSkip.workbuddy) || dSkip.workbuddy.length !== 1 || (dSkip.workbuddy[0] && dSkip.workbuddy[0].id !== 'gpt-5o')) {
    errs.push(`组4 缺 url/apiKey/非对象条目应被跳过（只留完整条目），实际 ${JSON.stringify((dSkip.workbuddy || []).map((m) => redactModel(m || {}).id))}`);
  }

  // ---------- 组5：qoder/cursor + env 布尔记录 ----------
  const dir5 = mkTmp('qoder');
  const emptyDir5 = path.join(dir5, 'empty');
  fs.mkdirSync(emptyDir5, { recursive: true });
  const noneJson5 = path.join(dir5, 'none.json');
  const d5a = discoverHosts({ paths: { workbuddyModels: noneJson5, qoderModelsDir: emptyDir5 } });
  if (!Array.isArray(d5a.qoder) || d5a.qoder.length !== 0) errs.push(`组5 空 qoder 目录应 qoder:[]，实际 ${JSON.stringify(d5a.qoder && d5a.qoder.length)}`);
  let d5b = null;
  try { d5b = discoverHosts({ paths: { workbuddyModels: noneJson5, qoderModelsDir: path.join(dir5, 'not-exist') } }); } catch (e) {
    errs.push(`组5 不存在的 qoder 目录绝不抛错，实际抛出 ${e.message}`);
  }
  if (!d5b || !Array.isArray(d5b.qoder) || d5b.qoder.length !== 0) errs.push('组5 不存在的 qoder 目录应 qoder:[]');
  if (d5a.cursor.length !== 0 || (d5b && d5b.cursor.length !== 0)) errs.push('组5 cursor 恒 []（预留接口，后端未公开）');
  // QODER_OPENAPI_ENDPOINT 只记录布尔到 stderr，不发请求（捕获 stderr 断言后还原）
  const origStderrWrite = process.stderr.write;
  let captured5 = '';
  process.stderr.write = (chunk) => { captured5 += String(chunk); return true; };
  try {
    discoverHosts({ paths: { workbuddyModels: noneJson5, qoderModelsDir: emptyDir5 } });
  } finally {
    process.stderr.write = origStderrWrite;
  }
  if (!/QODER_OPENAPI_ENDPOINT=(true|false)/.test(captured5)) {
    errs.push(`组5 QODER_OPENAPI_ENDPOINT 存在性应只记录布尔，实际 stderr: ${captured5.slice(0, 200)}`);
  }
  if (captured5.includes('sk-')) errs.push('组5 stderr 日志出现 sk- 字样——密钥红线');

  // ---------- 组6：redactModel（序列化出口唯一合规形态） ----------
  const m6 = {
    host: 'workbuddy', id: 'm6-model', vendor: 'claude',
    url: 'https://gw.example.com/v1/chat/completions',
    apiKey: 'sk-modelserialize9911', supportsToolCall: true, supportsImages: false,
  };
  const rm6 = redactModel(m6);
  if (!rm6 || rm6.apiKey !== '[redacted]') errs.push(`组6 redactModel apiKey 应为字面 '[redacted]'，实际 ${rm6 && JSON.stringify(rm6.apiKey)}`);
  if (!rm6 || rm6.host !== 'workbuddy' || rm6.id !== 'm6-model' || rm6.vendor !== 'claude' || rm6.url !== m6.url) {
    errs.push('组6 redactModel 应保留 host/id/vendor/url');
  }
  if (!rm6 || rm6.supportsToolCall !== true || rm6.supportsImages !== false) errs.push('组6 redactModel 应保留 supports* 可选字段');
  if (JSON.stringify(rm6).includes('sk-modelserialize9911')) errs.push('组6 redactModel 序列化含 key 明文——密钥红线');
  if (m6.apiKey !== 'sk-modelserialize9911') errs.push('组6 redactModel 不得改动原对象（apiKey 仅内存持有）');

  // ---------- 组7：buildUserAgent 纯函数 ----------
  if (buildUserAgent('workbuddy', '9.9.9') !== 'WorkBuddy/9.9.9') errs.push(`组7 buildUserAgent('workbuddy','9.9.9') 应为 WorkBuddy/9.9.9，实际 ${buildUserAgent('workbuddy', '9.9.9')}`);
  if (buildUserAgent('qoder', '1.2.0') !== 'QoderCN/1.2.0') errs.push(`组7 buildUserAgent('qoder','1.2.0') 应为 QoderCN/1.2.0，实际 ${buildUserAgent('qoder', '1.2.0')}`);
  const badVersions = [undefined, null, '', 'abc', 123, '9.9.9 '];
  for (const v of badVersions) {
    const got = buildUserAgent('workbuddy', v);
    if (got !== 'dsh-bridge/0.1.0') errs.push(`组7 版本缺失/非法（${JSON.stringify(v)}）应回退 dsh-bridge/0.1.0，实际 ${got}`);
  }
  if (buildUserAgent('qoder', undefined) !== 'dsh-bridge/0.1.0') errs.push(`组7 qoder 版本缺失应回退，实际 ${buildUserAgent('qoder', undefined)}`);

  // ---------- 组8：redact 直测 ----------
  if (redact('call sk-Abc123_-Xyz987 end') !== 'call [redacted] end') errs.push(`组8 sk-[A-Za-z0-9_-]{8,} 应替换为 [redacted]，实际 ${redact('call sk-Abc123_-Xyz987 end')}`);
  if (redact('a sk-keyAAAAAAAA1 b sk-keyBBBBBBBB2') !== 'a [redacted] b [redacted]') errs.push('组8 多个 key 应全局替换');
  if (redact('sk-1234567') !== 'sk-1234567') errs.push('组8 不足 8 位（sk-1234567）不应误伤');
  if (redact('no key here') !== 'no key here') errs.push('组8 无 key 文本应原样返回');
  if (redact('leak ' + LEAK_KEY).includes(LEAK_KEY)) errs.push('组8 brief 钉死 key 未被替换');
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
} finally {
  await cleanup();
}

if (errs.length) {
  console.error(`\n✗ model-bridge 契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ model-bridge 宿主模型桥接：契约全部通过（discover 保真与降级/chat 直调与 UA/500 脱敏截断/超时与连接拒绝/qoder-cursor 恒空/redactModel/redact/buildUserAgent）');
process.exit(0);
