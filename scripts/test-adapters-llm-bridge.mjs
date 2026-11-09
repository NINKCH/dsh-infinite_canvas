#!/usr/bin/env node
/**
 * 桥接 llm 服务（llm-bridge-service.cjs）契约测试（dev-only，不随包发布；Task 16 / v0.3.3）。
 *
 * 手法同 test-adapters-model-bridge.mjs：本地 mock 网关（http.createServer 随机端口）+
 * discoverHosts paths 注入临时目录 + chat hostVersion 注入——绝不读写真实 ~/.workbuddy、
 * ~/.qoder-cn。服务用**真件 chat**（model-bridge.cjs）打 mock 网关，消息映射全链路断言。
 *  组1 listProviders 形状：非空 host 映射 [{id:'workbuddy', name:'WorkBuddy 模型桥（本机网关）'}]；
 *      models.json 全空 → []（qoder/cursor 恒空不列——矩阵里根本不出现）
 *  组2 listModels 形状：[{id,name}] 且 name===id；空 id 条目剔除（id 是选择锚点）；
 *      未知 provider → []；出口绝不携带 apiKey（密钥红线）
 *  组3 stream happy path（core 信封形状）：text-delta 恰一个（整段全文=伪流）+ finish stop
 *      （reason.kind，**core 逐字读 chunk.reason**）；网关收到 body.model=条目 id、
 *      messages=[{system},{user}]（content 数组压平）、temperature/maxTokens 显式才透传
 *      （core 纪律：不给就不发）、UA=注入版本
 *  组4 stream 网关 500：finish error 且 reason.failure.message 含 [redacted]、无 sk- 残片
 *  组5 stream 不可解析模型 → throw（discoverHosts 全空 / provider 不在列 / model 不匹配）
 *  组6 stream 无正文响应：choices content 为空串 → 不 yield text-delta，仍 finish stop
 *      （core 会按重试矩阵追问，桥接层不吞事件）
 * 存储根：临时目录挂 adapters/.tmp-home/ 下（同 Task 1/2/3 模式，gitignored）。
 * 收尾：关闭全部 mock server（含连接清理）、删临时目录，端口不残留。
 * 运行：node scripts/test-adapters-llm-bridge.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SERVICE_PATH = path.join(ROOT, 'adapters', 'shared', 'llm-bridge-service.cjs');
const TMP_BASE = path.join(ROOT, 'adapters', '.tmp-home');
const LEAK_KEY = 'sk-abc123def456'; // 脱敏断言用 key（响应体回显场景，同 model-bridge 测试）

let serviceMod = null;
try { serviceMod = require(SERVICE_PATH); } catch { /* TDD RED 阶段模块尚不存在，属预期 */ }

const errs = [];
const servers = new Set(); // 本测试起的全部 mock server（收尾统一关闭）
let tmpRoot = null;

/** 在临时根下再开一层一次性目录。 */
function mkTmp(name) {
  return fs.mkdtempSync(path.join(tmpRoot, name + '-'));
}

/** 写 JSON 文件，返回路径。 */
function writeFix(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** 起 mock 网关：记录每个请求 {url, headers, body}，用 responder 产生响应。 */
async function startMock(responder) {
  const state = { hits: [], server: null, port: 0 };
  state.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => { /* 客户端中止属预期，忽略 */ });
    req.on('end', () => {
      state.hits.push({
        url: req.url,
        headers: Object.assign({}, req.headers),
        bodyText: Buffer.concat(chunks).toString('utf8'),
      });
      responder(res);
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

/** 收尾：关全部 mock server（含连接清理）+ 删临时根。 */
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

/** 消费整个 stream 生成器，返回 chunk 数组（core run() 的消费形态）。 */
async function drain(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

try {
  if (!serviceMod || typeof serviceMod.createLlmBridgeService !== 'function') {
    errs.push('adapters/shared/llm-bridge-service.cjs 不存在或未导出 createLlmBridgeService（TDD RED 阶段属预期，实现后应消失）');
    throw new Error('模块缺失，跳过后续组');
  }
  const { createLlmBridgeService } = serviceMod;

  fs.mkdirSync(TMP_BASE, { recursive: true });
  tmpRoot = fs.mkdtempSync(path.join(TMP_BASE, 'llmbridge-'));

  // ---------- 组1：listProviders 形状（非空 host 映射；qoder/cursor 恒空不列） ----------
  const dir1 = mkTmp('providers');
  const qoderDir1 = path.join(dir1, '.models');
  fs.mkdirSync(qoderDir1, { recursive: true });
  const modelsFile1 = writeFix(dir1, 'models.json', [
    { id: 'claude-sonnet-5', vendor: 'claude', url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'sk-provcase11111111' },
    { id: 'deepseek-v3', vendor: 'deepseek', url: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'sk-provcase22222222' },
  ]);
  const svc1 = createLlmBridgeService({ paths: { workbuddyModels: modelsFile1, qoderModelsDir: qoderDir1 } });
  const prov1 = svc1.listProviders();
  if (!Array.isArray(prov1) || prov1.length !== 1) {
    errs.push(`组1 listProviders 应恰 1 个（workbuddy 非空；qoder/cursor 恒空不列），实际 ${JSON.stringify(prov1)}`);
  } else {
    if (prov1[0].id !== 'workbuddy') errs.push(`组1 provider id 应为 'workbuddy'，实际 ${prov1[0].id}`);
    if (prov1[0].name !== 'WorkBuddy 模型桥（本机网关）') errs.push(`组1 provider name 应为 brief 逐字展示名，实际 ${prov1[0].name}`);
    if (JSON.stringify(prov1).toLowerCase().includes('apikey')) errs.push('组1 listProviders 出现 apiKey 字样——密钥红线');
  }
  const dir1b = mkTmp('providers-empty');
  const modelsFile1b = writeFix(dir1b, 'models.json', []);
  const svc1b = createLlmBridgeService({ paths: { workbuddyModels: modelsFile1b, qoderModelsDir: path.join(dir1b, 'noqoder') } });
  const prov1b = svc1b.listProviders();
  if (!Array.isArray(prov1b) || prov1b.length !== 0) {
    errs.push(`组1b models.json 全空应 listProviders → []，实际 ${JSON.stringify(prov1b)}`);
  }

  // ---------- 组2：listModels 形状（name 同名；空 id 剔除；未知 provider → []；无 apiKey） ----------
  const dir2 = mkTmp('models');
  const modelsFile2 = writeFix(dir2, 'models.json', [
    { id: 'm-a', vendor: 'v', url: 'http://127.0.0.1:1/x', apiKey: 'sk-modelcase33333333' },
    { id: '', vendor: 'v', url: 'http://127.0.0.1:1/x', apiKey: 'sk-modelcase44444444' }, // 空 id → 剔除
    { vendor: 'v', url: 'http://127.0.0.1:1/x', apiKey: 'sk-modelcase55555555' }, // 缺 id → 剔除
  ]);
  const svc2 = createLlmBridgeService({ paths: { workbuddyModels: modelsFile2, qoderModelsDir: path.join(dir2, 'noqoder') } });
  const models2 = svc2.listModels('workbuddy');
  if (!Array.isArray(models2) || models2.length !== 1) {
    errs.push(`组2 listModels 应只留有效 id 条目（恰 1），实际 ${JSON.stringify(models2)}`);
  } else {
    if (models2[0].id !== 'm-a' || models2[0].name !== 'm-a') {
      errs.push(`组2 条目应为 {id:'m-a', name:'m-a'}（name=同名），实际 ${JSON.stringify(models2[0])}`);
    }
    if (JSON.stringify(models2).toLowerCase().includes('apikey')) errs.push('组2 listModels 出现 apiKey 字样——密钥红线');
  }
  const models2b = svc2.listModels('qoder');
  if (!Array.isArray(models2b) || models2b.length !== 0) errs.push(`组2b 未知/恒空 provider 应 → []，实际 ${JSON.stringify(models2b)}`);

  // ---------- 组3：stream happy path（core 信封形状 → 网关映射全链路） ----------
  const mock3 = await startMock((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-llmbridge-1',
      choices: [{ index: 0, message: { role: 'assistant', content: '第一幕：开场。第二幕：转折。第三幕：收束。' }, finish_reason: 'stop' }],
    }));
  });
  const dir3 = mkTmp('stream');
  const modelsFile3 = writeFix(dir3, 'models.json', [
    { id: 'claude-sonnet-5', vendor: 'claude', url: `http://127.0.0.1:${mock3.port}/v1/chat/completions`, apiKey: 'sk-streamcase66666666' },
  ]);
  const svc3 = createLlmBridgeService({
    paths: { workbuddyModels: modelsFile3, qoderModelsDir: path.join(dir3, 'noqoder') },
    hostVersion: '9.9.9',
  });
  // core complete() 的真实信封（index.js L3696-3704）：system 独立字段 + messages 内容数组
  const chunks3 = await drain(svc3.stream({
    provider: 'workbuddy',
    model: 'claude-sonnet-5',
    system: '你是画布编剧室',
    messages: [{ role: 'user', content: [{ type: 'text', text: '给一版三幕大纲' }] }],
    temperature: 0.7,
    maxTokens: 256,
  }));
  if (chunks3.length !== 2) {
    errs.push(`组3 stream 应恰 2 个 chunk（text-delta + finish），实际 ${chunks3.length}: ${JSON.stringify(chunks3).slice(0, 200)}`);
  } else {
    const d3 = chunks3[0];
    const f3 = chunks3[1];
    if (d3.type !== 'text-delta' || d3.text !== '第一幕：开场。第二幕：转折。第三幕：收束。') {
      errs.push(`组3 首 chunk 应为整段全文 text-delta（伪流），实际 ${JSON.stringify(d3).slice(0, 160)}`);
    }
    // **core 逐字读 chunk.reason**（index.js L3680）——finish 形状以 core 为准
    if (!f3 || f3.type !== 'finish' || !f3.reason || f3.reason.kind !== 'stop') {
      errs.push(`组3 finish 应为 {type:'finish', reason:{kind:'stop'}}，实际 ${JSON.stringify(f3)}`);
    }
    if (JSON.stringify(chunks3).toLowerCase().includes('apikey') || JSON.stringify(chunks3).includes('sk-streamcase66666666')) {
      errs.push('组3 stream 事件携带 key/apiKey——密钥红线');
    }
  }
  if (!mock3.hits.length) errs.push('组3 mock 网关应收到请求');
  else {
    const hit3 = mock3.hits[0];
    if (hit3.headers['user-agent'] !== 'WorkBuddy/9.9.9') {
      errs.push(`组3 UA 应为注入版本 WorkBuddy/9.9.9，实际 ${hit3.headers['user-agent']}`);
    }
    let body3 = null;
    try { body3 = JSON.parse(hit3.bodyText); } catch { errs.push(`组3 请求体应为合法 JSON，实际 ${hit3.bodyText.slice(0, 120)}`); }
    if (body3) {
      if (body3.model !== 'claude-sonnet-5') errs.push(`组3 body.model 应为条目 id，实际 ${body3.model}`);
      const want3 = [
        { role: 'system', content: '你是画布编剧室' },
        { role: 'user', content: '给一版三幕大纲' },
      ];
      if (JSON.stringify(body3.messages) !== JSON.stringify(want3)) {
        errs.push(`组3 messages 应压平为 [{system},{user}]（content 数组拆 text），实际 ${JSON.stringify(body3.messages).slice(0, 200)}`);
      }
      if (body3.temperature !== 0.7 || body3.max_tokens !== 256) {
        errs.push(`组3 显式给出的参数应透传（temperature=0.7, max_tokens=256），实际 ${JSON.stringify({ t: body3.temperature, m: body3.max_tokens })}`);
      }
    }
  }
  // 组3b：参数不给就不发（core 纪律——让宿主网关用自己的默认值）
  mock3.hits.length = 0;
  await drain(svc3.stream({ provider: 'workbuddy', model: 'claude-sonnet-5', messages: [{ role: 'user', content: '继续' }] }));
  let body3b = null;
  try { body3b = JSON.parse(mock3.hits[0].bodyText); } catch { /* 下方断言记错 */ }
  if (!body3b || 'temperature' in body3b || 'max_tokens' in body3b) {
    errs.push(`组3b 未显式给出参数时不得发 temperature/max_tokens（core 纪律：不给就不发），实际 ${body3b && JSON.stringify(Object.keys(body3b))}`);
  }

  // ---------- 组4：网关 500 → finish error，message 无 sk- 残片 ----------
  const mock4 = await startMock((res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '网关校验失败，回显 key ' + LEAK_KEY + ' 拒绝' } }));
  });
  const dir4 = mkTmp('err');
  const modelsFile4 = writeFix(dir4, 'models.json', [
    { id: 'claude-sonnet-5', vendor: 'claude', url: `http://127.0.0.1:${mock4.port}/v1/chat/completions`, apiKey: 'sk-errcase77777777' },
  ]);
  const svc4 = createLlmBridgeService({
    paths: { workbuddyModels: modelsFile4, qoderModelsDir: path.join(dir4, 'noqoder') },
    hostVersion: '1.0.0',
  });
  const chunks4 = await drain(svc4.stream({ provider: 'workbuddy', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }));
  const f4 = chunks4.find((c) => c && c.type === 'finish');
  if (!f4) errs.push(`组4 应有 finish chunk，实际 ${JSON.stringify(chunks4).slice(0, 160)}`);
  else {
    if (!f4.reason || f4.reason.kind !== 'error' || !f4.reason.failure || typeof f4.reason.failure.message !== 'string') {
      errs.push(`组4 finish 应为 reason:{kind:'error', failure:{message}}，实际 ${JSON.stringify(f4)}`);
    } else {
      const msg4 = f4.reason.failure.message;
      if (msg4.includes(LEAK_KEY)) errs.push('组4 failure.message 含响应体回显 key 明文——密钥红线（必须 [redacted]）');
      if (!msg4.includes('[redacted]')) errs.push(`组4 failure.message 应含 [redacted]，实际 ${msg4.slice(0, 120)}`);
      if (!msg4.includes('HTTP 500')) errs.push(`组4 failure.message 应含网关状态（HTTP 500），实际 ${msg4.slice(0, 120)}`);
    }
    if (chunks4.some((c) => c.type === 'text-delta')) errs.push('组4 失败路径不应有 text-delta');
  }

  // ---------- 组5：不可解析模型 → throw（discoverHosts 全空 / provider 不在列 / model 不匹配） ----------
  const dir5 = mkTmp('unresolved');
  const none5 = path.join(dir5, 'no-such-models.json');
  const svc5a = createLlmBridgeService({ paths: { workbuddyModels: none5, qoderModelsDir: path.join(dir5, 'noqoder') } });
  let threw5a = null;
  try { await drain(svc5a.stream({ provider: 'workbuddy', model: 'x', messages: [{ role: 'user', content: 'hi' }] })); } catch (e) { threw5a = e; }
  if (!threw5a) errs.push('组5a 无任何 host 时 stream 应 throw（core 语义），实际正常返回');
  const dir5b = mkTmp('unresolved-mismatch');
  const modelsFile5b = writeFix(dir5b, 'models.json', [
    { id: 'only-model', vendor: 'v', url: 'http://127.0.0.1:1/x', apiKey: 'sk-mismatch88888888' },
  ]);
  const svc5b = createLlmBridgeService({ paths: { workbuddyModels: modelsFile5b, qoderModelsDir: path.join(dir5b, 'noqoder') } });
  let threw5b = null;
  try { await drain(svc5b.stream({ provider: 'workbuddy', model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] })); } catch (e) { threw5b = e; }
  if (!threw5b) errs.push('组5b model id 不匹配时 stream 应 throw，实际正常返回');
  let threw5c = null;
  try { await drain(svc5b.stream({ provider: 'qoder', model: 'only-model', messages: [{ role: 'user', content: 'hi' }] })); } catch (e) { threw5c = e; }
  if (!threw5c) errs.push('组5c provider 不在列（qoder 恒空）时 stream 应 throw，实际正常返回');
  for (const [label, e] of [['5a', threw5a], ['5b', threw5b], ['5c', threw5c]]) {
    if (e && String(e.message).includes('sk-')) errs.push(`组${label} throw 的 message 含 sk- 字样——密钥红线`);
  }

  // ---------- 组6：空正文响应 → 不 yield text-delta，仍 finish stop（core 重试矩阵接手） ----------
  const mock6 = await startMock((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }));
  });
  const dir6 = mkTmp('empty');
  const modelsFile6 = writeFix(dir6, 'models.json', [
    { id: 'claude-sonnet-5', vendor: 'claude', url: `http://127.0.0.1:${mock6.port}/v1/chat/completions`, apiKey: 'sk-emptycase99999999' },
  ]);
  const svc6 = createLlmBridgeService({
    paths: { workbuddyModels: modelsFile6, qoderModelsDir: path.join(dir6, 'noqoder') },
    hostVersion: '1.0.0',
  });
  const chunks6 = await drain(svc6.stream({ provider: 'workbuddy', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }));
  if (chunks6.length !== 1 || chunks6[0].type !== 'finish' || !chunks6[0].reason || chunks6[0].reason.kind !== 'stop') {
    errs.push(`组6 空正文应只 yield finish stop（无 text-delta），实际 ${JSON.stringify(chunks6).slice(0, 160)}`);
  }
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
} finally {
  await cleanup();
}

if (errs.length) {
  console.error(`\n✗ llm-bridge-service 契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ llm-bridge-service 桥接 llm 服务：契约全部通过（listProviders 非空 host 映射/listModels 形状与空 id 剔除/stream 伪流 text-delta+finish stop/finish 走 reason（core 逐字）/网关 500 脱敏/不可解析 throw/参数显式才透传）');
process.exit(0);
