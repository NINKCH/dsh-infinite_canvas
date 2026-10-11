#!/usr/bin/env node
/**
 * LLM 流式与"推理模型只出思考"重试逻辑的确定性测试（dev-only）。
 *
 * 用假 llm 服务模拟真实故障：
 *  - 只有 reasoning-delta、finish=length（用户实测的 glm-5.3-flash 现象）
 *  - 只有在按「模型配置的输出上限」重试时才吐正文
 * 验证：① /api/llm-stream 会实时推送思考增量 ② 重试链能拿到正文
 *       ③ 全部尝试失败时返回可读原因（含 finish/直方图），而不是静默空文本
 *
 * 运行：node scripts/test-llm-stream.mjs；退出码 0=通过 1=失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-llm-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

const routes = [];
const CAP = 32000; // 模拟"用户在 Harness 里为模型配置的输出上限"
let scenario = 'retry-succeeds';
function makeStream(options) {
  return (async function* gen() {
    if (scenario === 'ok') {
      yield { type: 'text-delta', index: 0, text: '正文内容' };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    // 只有"按模型配置的输出上限重试"时才吐正文；其余情况思考吃满预算（finish=length）
    const givesBody = scenario === 'retry-succeeds' && options.maxTokens === CAP;
    yield { type: 'block-start', index: 0 };
    for (let i = 0; i < 3; i++) yield { type: 'reasoning-delta', index: i, text: '思考片段' + i };
    if (!givesBody) {
      yield { type: 'finish', reason: 'length' };
      return;
    }
    yield { type: 'text-delta', index: 1, text: '正文内容' };
    yield { type: 'finish', reason: 'stop' };
  })();
}
const fakeLlm = {
  listProviders: () => [{ id: 'p-test', name: 'TestProvider' }],
  listModels: () => [{ id: 'm-test', name: 'TestModel' }],
  resolveModel: () => Promise.resolve({ provider: 'p-test', id: 'm-test', name: 'TestModel', maxTokens: CAP }),
  stream: (options) => makeStream(options),
};
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get: (name) => (name === 'llm' ? fakeLlm : undefined),
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  tools: { register: () => () => {} },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
mod.apply(fakeCtx);
const rpc = routes.find((r) => r.path === '/infinite-canvas/api/rpc');
const streamRoute = routes.find((r) => r.path === '/infinite-canvas/api/llm-stream');
ok(!!rpc, '未注册 /api/rpc');
ok(!!streamRoute, '未注册 /api/llm-stream（流式思考无法推送）');

/** 以假 req/res 驱动路由，收集 SSE 帧 */
async function callStream(body) {
  const frames = [];
  let status = 200;
  let ctype = '';
  await new Promise((resolve) => {
    const req = {
      method: 'POST', url: '/infinite-canvas/api/llm-stream',
      headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
      on() {},
    };
    const res = {
      headersSent: false,
      set statusCode(v) { status = v; },
      get statusCode() { return status; },
      setHeader(k, v) { if (k.toLowerCase() === 'content-type') ctype = String(v); },
      write(chunk) {
        this.headersSent = true;
        for (const part of String(chunk).split('\n\n')) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (line) { try { frames.push(JSON.parse(line.slice(6))); } catch { /* 忽略 */ } }
        }
        return true;
      },
      end() { resolve(); },
      on() {},
    };
    Promise.resolve(streamRoute.handler(req, res)).then(() => resolve()).catch(() => resolve());
  });
  return { status, ctype, frames };
}

// ---------- 1) 重试成功：思考实时可见 + 最终拿到正文 ----------
{
  scenario = 'retry-succeeds';
  const r = await callStream({ system: 's', user: 'u' });
  ok(/text\/event-stream/.test(r.ctype), '流式路由未返回 SSE content-type：' + r.ctype);
  const reasoning = r.frames.filter((f) => f.t === 'r');
  ok(reasoning.length >= 3, '思考增量没有推送出来（画布上看不到"在思考"）：' + reasoning.length);
  const attempts = r.frames.filter((f) => f.t === 'attempt');
  ok(attempts.length >= 2, '没有尝试记录（重试链未生效）：' + attempts.length);
  ok(attempts.some((a) => a.d && a.d.maxTokens === CAP), '重试未使用模型配置的输出上限 ' + CAP + '：' + JSON.stringify(attempts.map((a) => a.d)));
  const done = r.frames.find((f) => f.t === 'done');
  ok(done && done.d && done.d.text === '正文内容', '重试后未拿到正文：' + JSON.stringify(done));
  ok(!r.frames.some((f) => f.t === 'fail'), '重试成功却报告了失败帧');
}

// ---------- 2) 全部失败：可读原因（含 finish/直方图），不是空文本 ----------
{
  scenario = 'always-reasoning';
  const r = await callStream({ system: 's', user: 'u' });
  const fail = r.frames.find((f) => f.t === 'fail');
  ok(!!fail, '全部尝试失败时未返回失败帧（会静默当成空结果）');
  const msg = String((fail && fail.d) || '');
  ok(/输出预算|思考/.test(msg), '失败原因未说明"思考吃满预算"：' + msg.slice(0, 120));
  ok(/reasoning-delta/.test(msg), '失败原因未附 chunk 直方图：' + msg.slice(0, 160));
  ok(/finish=length/.test(msg), '失败原因未包含 finish 原因：' + msg.slice(0, 160));
}

// ---------- 3) 一次性 RPC 也走同一套重试逻辑 ----------
{
  scenario = 'retry-succeeds';
  const out = await new Promise((resolve) => {
    const req = {
      method: 'POST', url: '/infinite-canvas/api/rpc',
      headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method: 'llmComplete', args: { system: 's', user: 'u' } })); },
      on() {},
    };
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve(JSON.parse(String(body))); } };
    Promise.resolve(rpc.handler(req, res)).catch((e) => resolve({ error: String(e && e.message) }));
  });
  ok(out && out.text === '正文内容', 'llmComplete 未复用重试逻辑：' + JSON.stringify(out));
  ok(out && out.variant === 'reasoning-retry', 'llmComplete 未标记为重试成功：' + JSON.stringify(out));
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
if (errs.length) {
  console.error('✗ LLM 流式/推理重试测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ LLM 流式/推理重试测试通过（思考实时推送 / 按模型配置上限重试 / 失败原因可读）');
