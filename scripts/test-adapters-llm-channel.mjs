#!/usr/bin/env node
/**
 * LLM 通道编排（llm-channel.cjs）契约测试（dev-only，不随包发布）。
 *
 * 全部 fake 注入（brief Step 1：不起真实网络、不读真实宿主配置）：
 *  组1 优先级矩阵（≥5 例，brief 逐字）：仅 vscodeLm → 'vscode-lm'；无 vscodeLm 有 bridge →
 *      'bridge'；无前两者有 sampling → 'sampling'；仅 byok → 'byok'；全空 → 'none' 且 chat
 *      reject（message 含「画布设置页」指引、无任何 sk- 字样）。
 *      追加真值边界：vscodeLm.available=false → 落 bridge；bridge.available=[]（空数组，第一个
 *      非空 host 语义）→ 落 sampling。
 *  组2 chat 委托：所选通道 fake 被正确调用——messages/opts 原引用透传、返回 {text,usage} 原样
 *      透传；bridge 通道 chat 收到 (model=available[0], messages, opts)（brief：用列表第一个模型）。
 *  组3 失败模式统一（Task 4 遗留事实：上游可能同步 throw 也可能 promise reject）：同步 throw →
 *      编排 chat 以 reject 呈现（await catch 接住）；promise reject → reject；throw 非 Error →
 *      reject 且 message 为字符串化原因；Error 实例的 message 原样保留。
 *  组4 probeChannels：bridge 数组按 host 分组计数（钉形态：零计数 host 省略）、空数组/缺省 →
 *      {}；sampling true/false→true/'unsupported'（缺省同 unsupported）；vscodeLm 缺省 'n/a'、
 *      注入带 count → 数；byok 布尔直传（缺省 false）；序列化安全——available 携带 apiKey 的
 *      Model 与注入对象塞 key 后，JSON.stringify 全文无 'sk-'（密钥红线）。
 *  组5 返回形状：resolveTextLLM → { channel:string, chat:function }。
 * 运行：node scripts/test-adapters-llm-channel.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CHANNEL_PATH = path.join(ROOT, 'adapters', 'shared', 'llm-channel.cjs');

let channel = null;
try { channel = require(CHANNEL_PATH); } catch { /* TDD RED 阶段模块尚不存在，属预期 */ }

const errs = [];

/** 极简 fake 通道工厂：记录每次调用（messages/opts 引用），返回固定结果或按配置抛错。 */
function makeFakeChannel({ available = true, result = { text: 'ok', usage: { total_tokens: 1 } }, throwMode = null } = {}) {
  const calls = [];
  const fake = {
    available,
    calls,
    chat(messages, opts) {
      calls.push({ messages, opts });
      if (throwMode === 'sync') throw new Error('sync boom');
      if (throwMode === 'string') throw 'string boom';
      if (throwMode === 'reject') return Promise.reject(new Error('reject boom'));
      return Promise.resolve(result);
    },
  };
  return fake;
}

try {
  if (!channel) {
    errs.push('adapters/shared/llm-channel.cjs 不存在或加载失败（TDD RED 阶段属预期，实现后应消失）');
    throw new Error('模块缺失，跳过后续组');
  }
  const { resolveTextLLM, probeChannels } = channel;
  if (typeof resolveTextLLM !== 'function') errs.push('llm-channel 应导出 resolveTextLLM 函数');
  if (typeof probeChannels !== 'function') errs.push('llm-channel 应导出 probeChannels 函数');
  if (typeof resolveTextLLM !== 'function' || typeof probeChannels !== 'function') {
    throw new Error('导出缺失，跳过后续组');
  }

  // ---------- 组1：优先级矩阵（brief 逐字 5 例 + 2 例真值边界） ----------
  // 1a 仅 vscodeLm → 'vscode-lm'
  const r1a = resolveTextLLM({ vscodeLm: makeFakeChannel() });
  if (!r1a || r1a.channel !== 'vscode-lm') errs.push(`组1a 仅 vscodeLm 应选 'vscode-lm'，实际 ${r1a && r1a.channel}`);
  // 1b 无 vscodeLm 有 bridge（非空 Model[]）→ 'bridge'
  const bridgeModels = [{ host: 'workbuddy', id: 'm1', url: 'https://gw.example.com', apiKey: 'k' }];
  const r1b = resolveTextLLM({ bridge: { available: bridgeModels, chat: () => {} } });
  if (!r1b || r1b.channel !== 'bridge') errs.push(`组1b 无 vscodeLm 有 bridge 应选 'bridge'，实际 ${r1b && r1b.channel}`);
  // 1c 无前两者有 sampling → 'sampling'
  const r1c = resolveTextLLM({ sampling: makeFakeChannel() });
  if (!r1c || r1c.channel !== 'sampling') errs.push(`组1c 无前两者有 sampling 应选 'sampling'，实际 ${r1c && r1c.channel}`);
  // 1d 仅 byok → 'byok'
  const r1d = resolveTextLLM({ byok: makeFakeChannel() });
  if (!r1d || r1d.channel !== 'byok') errs.push(`组1d 仅 byok 应选 'byok'，实际 ${r1d && r1d.channel}`);
  // 1e 全空 → 'none' 且 chat reject（message 含「画布设置页」、无 sk- 字样）
  for (const [label, empty] of [['空对象', {}], ['undefined', undefined]]) {
    const r1e = resolveTextLLM(empty);
    if (!r1e || r1e.channel !== 'none') errs.push(`组1e 全空（${label}）应选 'none'，实际 ${r1e && r1e.channel}`);
    let err1e = null;
    try { await r1e.chat([{ role: 'user', content: 'hi' }]); } catch (e) { err1e = e; }
    if (!err1e) errs.push(`组1e 全空（${label}）chat 应 reject`);
    else {
      const msg1e = String(err1e.message || err1e);
      if (!msg1e.includes('画布设置页')) errs.push(`组1e none 错误消息应含「画布设置页」指引，实际 ${msg1e}`);
      if (/sk-/.test(msg1e)) errs.push(`组1e none 错误消息不得含 sk- 字样，实际 ${msg1e}`);
    }
  }
  // 1f vscodeLm.available=false（假值）→ 逐个看 available 真值，落 'bridge'
  const r1f = resolveTextLLM({ vscodeLm: makeFakeChannel({ available: false }), bridge: { available: bridgeModels, chat: () => {} } });
  if (!r1f || r1f.channel !== 'bridge') errs.push(`组1f vscodeLm.available=false 应落 'bridge'，实际 ${r1f && r1f.channel}`);
  // 1g bridge.available=[]（空数组 = 无任何非空 host）→ 落 'sampling'
  const r1g = resolveTextLLM({ bridge: { available: [], chat: () => {} }, sampling: makeFakeChannel() });
  if (!r1g || r1g.channel !== 'sampling') errs.push(`组1g bridge.available=[] 应落 'sampling'，实际 ${r1g && r1g.channel}`);

  // ---------- 组2：chat 委托（messages/opts 透传 + 返回值透传 + bridge 首模型绑定） ----------
  // 2a vscode-lm：messages/opts 原引用透传、{text,usage} 原样透传
  const fake2a = makeFakeChannel({ result: { text: '剧本文本', usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } } });
  const r2a = resolveTextLLM({ vscodeLm: fake2a });
  const messages2a = [{ role: 'system', content: '你是编剧室' }, { role: 'user', content: '三幕大纲' }];
  const opts2a = { temperature: 0.7 };
  const out2a = await r2a.chat(messages2a, opts2a);
  if (fake2a.calls.length !== 1) errs.push(`组2a 所选通道 fake 应恰好被调用一次，实际 ${fake2a.calls.length}`);
  else {
    if (fake2a.calls[0].messages !== messages2a) errs.push('组2a messages 应原引用透传');
    if (fake2a.calls[0].opts !== opts2a) errs.push('组2a opts 应原引用透传');
  }
  if (!out2a || out2a.text !== '剧本文本' || !out2a.usage || out2a.usage.total_tokens !== 8) {
    errs.push(`组2a 返回 {text,usage} 应原样透传，实际 ${out2a && JSON.stringify(out2a)}`);
  }
  // 2b bridge：chat 收到 (model=available[0], messages, opts)
  const model2b = { host: 'workbuddy', id: 'first-model', url: 'https://gw.example.com', apiKey: 'k' };
  const calls2b = [];
  const r2b = resolveTextLLM({ bridge: { available: [model2b, { host: 'workbuddy', id: 'second' }], chat: (...a) => { calls2b.push(a); return Promise.resolve({ text: '桥接文本' }); } } });
  const messages2b = [{ role: 'user', content: 'hi' }];
  const opts2b = { timeout: 5000 };
  const out2b = await r2b.chat(messages2b, opts2b);
  if (calls2b.length !== 1) errs.push(`组2b bridge fake.chat 应被调用一次，实际 ${calls2b.length}`);
  else {
    if (calls2b[0][0] !== model2b) errs.push(`组2b bridge chat 第一个参数应为列表第一个模型，实际 ${JSON.stringify(calls2b[0][0] && calls2b[0][0].id)}`);
    if (calls2b[0][1] !== messages2b) errs.push('组2b bridge chat 第二个参数应为 messages 原引用');
    if (calls2b[0][2] !== opts2b) errs.push('组2b bridge chat 第三个参数应为 opts 原引用');
  }
  if (!out2b || out2b.text !== '桥接文本') errs.push(`组2b bridge 返回应透传，实际 ${out2b && JSON.stringify(out2b)}`);
  // 2c byok：同步返回（非 Promise）的 fake 也应被编排成 Promise
  const fake2c = {
    available: true,
    chat(messages, opts) { return { text: '同步返回' }; },
  };
  const r2c = resolveTextLLM({ byok: fake2c });
  const out2c = await r2c.chat([{ role: 'user', content: 'hi' }], undefined);
  if (!out2c || out2c.text !== '同步返回') errs.push(`组2c 同步返回值应透传（编排恒为 Promise），实际 ${out2c && JSON.stringify(out2c)}`);

  // ---------- 组3：失败模式统一（同步 throw 也被吞成 reject，调用方只需 await catch 一次） ----------
  // 3a 同步 throw
  const r3a = resolveTextLLM({ sampling: makeFakeChannel({ throwMode: 'sync' }) });
  let err3a = null;
  try { await r3a.chat([{ role: 'user', content: 'hi' }], {}); } catch (e) { err3a = e; }
  if (!err3a) errs.push('组3a 上游同步 throw 应呈现为 reject（await catch 接住）');
  else if (err3a.message !== 'sync boom') errs.push(`组3a Error 实例 message 应原样保留，实际 ${err3a.message}`);
  // 3b promise reject
  const r3b = resolveTextLLM({ sampling: makeFakeChannel({ throwMode: 'reject' }) });
  let err3b = null;
  try { await r3b.chat([{ role: 'user', content: 'hi' }], {}); } catch (e) { err3b = e; }
  if (!err3b) errs.push('组3b 上游 promise reject 应呈现为 reject');
  else if (err3b.message !== 'reject boom') errs.push(`组3b reject message 应原样保留，实际 ${err3b.message}`);
  // 3c throw 非 Error（字符串）→ 仍 reject 且 message 字符串化
  const r3c = resolveTextLLM({ sampling: makeFakeChannel({ throwMode: 'string' }) });
  let err3c = null;
  try { await r3c.chat([{ role: 'user', content: 'hi' }], {}); } catch (e) { err3c = e; }
  if (!err3c) errs.push('组3c 上游 throw 字符串应呈现为 reject');
  else if (!(err3c instanceof Error) || err3c.message !== 'string boom') errs.push(`组3c 非 Error 抛出物应包装为 Error（message 字符串化），实际 ${typeof err3c}:${err3c.message}`);

  // ---------- 组4：probeChannels ----------
  // 4a bridge 按 host 分组计数（钉形态：数组里出现过的 host 计数，零计数 host 省略）
  const p4a = probeChannels({ bridge: { available: [
    { host: 'workbuddy', id: 'a', apiKey: 'sk-p4akey11111111' },
    { host: 'workbuddy', id: 'b', apiKey: 'sk-p4akey22222222' },
    { host: 'qoder', id: 'c', apiKey: 'sk-p4akey33333333' },
  ], chat: () => {} } });
  if (!p4a.bridge || p4a.bridge.workbuddy !== 2 || p4a.bridge.qoder !== 1) {
    errs.push(`组4a bridge 应按 host 分组计数 {workbuddy:2,qoder:1}，实际 ${JSON.stringify(p4a.bridge)}`);
  }
  if (JSON.stringify(p4a).includes('sk-')) errs.push('组4a probe 输入含 apiKey 的 Model，序列化出现 sk-——密钥红线（只允许计数/布尔）');
  const p4aEmpty = probeChannels({ bridge: { available: [], chat: () => {} } });
  if (!p4aEmpty.bridge || typeof p4aEmpty.bridge !== 'object' || Object.keys(p4aEmpty.bridge).length !== 0) {
    errs.push(`组4a bridge.available=[] 应得 {}，实际 ${JSON.stringify(p4aEmpty.bridge)}`);
  }
  const p4aNone = probeChannels({});
  if (!p4aNone.bridge || typeof p4aNone.bridge !== 'object' || Object.keys(p4aNone.bridge).length !== 0) {
    errs.push(`组4a 无 bridge 注入应得 {}，实际 ${JSON.stringify(p4aNone.bridge)}`);
  }
  // 4b sampling：true → true；false → 'unsupported'；缺省 → 'unsupported'
  if (probeChannels({ sampling: { available: true, chat: () => {} } }).sampling !== true) {
    errs.push(`组4b sampling.available=true 应探测为 true，实际 ${JSON.stringify(probeChannels({ sampling: { available: true, chat: () => {} } }).sampling)}`);
  }
  if (probeChannels({ sampling: { available: false, chat: () => {} } }).sampling !== 'unsupported') {
    errs.push(`组4b sampling.available=false 应探测为 'unsupported'，实际 ${JSON.stringify(probeChannels({ sampling: { available: false, chat: () => {} } }).sampling)}`);
  }
  if (probeChannels({}).sampling !== 'unsupported') {
    errs.push(`组4b sampling 缺省应探测为 'unsupported'，实际 ${JSON.stringify(probeChannels({}).sampling)}`);
  }
  // 4c vscodeLm：缺省 'n/a'；注入带 count → 数
  if (probeChannels({}).vscodeLm !== 'n/a') errs.push(`组4c vscodeLm 缺省应为 'n/a'，实际 ${JSON.stringify(probeChannels({}).vscodeLm)}`);
  const p4c = probeChannels({ vscodeLm: { available: true, count: 7, chat: () => {} } });
  if (p4c.vscodeLm !== 7) errs.push(`组4c vscodeLm 注入带 count:7 应给 7，实际 ${JSON.stringify(p4c.vscodeLm)}`);
  // 4d byok：布尔直传，缺省 false
  if (probeChannels({ byok: { available: true, chat: () => {} } }).byok !== true) errs.push('组4d byok.available=true 应直传 true');
  if (probeChannels({ byok: { available: false, chat: () => {} } }).byok !== false) errs.push('组4d byok.available=false 应直传 false');
  if (probeChannels({}).byok !== false) errs.push('组4d byok 缺省应为 false');
  // 4e 序列化安全（红线总断言）：把带 key 的注入塞进各通道，probe 全文 JSON 无 sk-
  const leaky = {
    vscodeLm: { available: true, count: 1, chat: () => {} },
    bridge: { available: [{ host: 'workbuddy', id: 'x', url: 'u', apiKey: 'sk-leakprobeAAAAAA01' }], chat: () => {} },
    sampling: { available: false, chat: () => {} },
    byok: { available: false, chat: () => {} },
  };
  const p4e = probeChannels(leaky);
  const p4eJson = JSON.stringify(p4e);
  if (p4eJson.includes('sk-')) errs.push(`组4e probe 结果含 sk- 字样——密钥红线，实际 ${p4eJson.slice(0, 200)}`);
  if (p4eJson.includes('apiKey') || p4eJson.includes('url')) errs.push(`组4e probe 结果不得携带模型字段（只含计数与布尔），实际 ${p4eJson.slice(0, 200)}`);
  if (!p4eJson.includes('"vscodeLm":1') || !p4eJson.includes('"workbuddy":1')) errs.push(`组4e probe 计数形态应保留，实际 ${p4eJson}`);

  // ---------- 组5：返回形状 ----------
  const r5 = resolveTextLLM({});
  if (!r5 || typeof r5 !== 'object' || typeof r5.channel !== 'string' || typeof r5.chat !== 'function') {
    errs.push(`组5 resolveTextLLM 应返回 {channel:string, chat:function}，实际 ${r5 && typeof r5}`);
  }
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
}

if (errs.length) {
  console.error(`\n✗ llm-channel 契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ llm-channel LLM 通道编排：契约全部通过（优先级矩阵/chat 委托/失败模式统一/probeChannels 计数与脱敏）');
process.exit(0);
