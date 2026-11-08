/**
 * LLM 通道编排器（Task 5）——画布文本 LLM（编剧室 5 轮等插件进程内调用）的统一选路入口。
 *
 * 职责单一：纯决策 + 委托。按优先级 `vscode-lm > bridge > sampling > byok > none`（brief 逐字）
 * 从注入的 channels 里选出第一个可用通道，返回绑定该通道的 chat(messages, opts)；本模块自己
 * **不碰网络**——网络在各通道实现里（vscode-lm 在 vsix 壳、bridge 在 model-bridge.cjs、sampling
 * 在 canvas-mcp 的 server→client 请求、byok 在 canvas-mcp 的 core 路由调用）。
 * 零依赖（仅 node 内置，不 require 任何兄弟模块）。CommonJS：发布物 dist/llm-channel.cjs（§5）。
 *
 * channels 注入对象（全部可注入，测试用 fake；HOST-CONTRACT.md §10）：
 *   - vscodeLm?: { available:boolean, count?:number, chat(messages, opts) }（仅 vsix 壳注入，
 *     MCP server 场景恒缺省）
 *   - bridge?:   { available:boolean|Model[], chat(model, messages, opts) }——available 为
 *     discoverHosts 过滤出的第一个非空 host 的模型列表；chat 用列表第一个模型（后续可扩展选型）
 *   - sampling?: { available:boolean, chat(messages, opts) }
 *   - byok?:     { available:boolean, chat(messages, opts) }
 *
 * 失败模式统一（Task 4 遗留事实）：上游 chat 可能同步 throw 也可能 promise reject——编排器
 * 返回的 chat 内部 `try { return await upstream(...) } catch` 包裹（await 会把同步 throw 一并
 * 收进 catch），调用方只需 `await chat(...)` + catch 一次。上游 Error 实例原样透传（其 message
 * 已由各通道实现按密钥红线 redact）；非 Error 抛出物包装为 Error（message 字符串化）。
 *
 * none 通道错误消息（brief 逐字）：『无可用文本 LLM 通道，请在画布设置页配置 BYOK』——含指引、
 * 不含任何 key。
 */
'use strict';

// none 通道的错误消息（brief 逐字，测试断言钉死「画布设置页」指引；不含任何 key）
const NONE_MESSAGE = '无可用文本 LLM 通道，请在画布设置页配置 BYOK';

/**
 * 失败模式统一包装：返回 async chat，内部先调用再 await（同步 throw 与 promise reject
 * 都被同一个 catch 收口）。Error 实例原样重抛（保留上游已脱敏的 message）；非 Error
 * （字符串/对象等）包装为 Error。
 */
function wrapChat(upstream) {
  return async function chat(messages, opts) {
    try {
      return await upstream(messages, opts);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  };
}

/**
 * 按优先级选路（brief 逐字）：逐个看各通道 available 的真值，第一个真值者胜。
 * bridge 特例（brief 语义「available 为 Model[]——第一个非空 host 的模型列表」）：空数组
 * 表示没有任何可用模型，视为不可用；非数组真值（boolean true 注入）按可用处理，此时取不到
 * 列表首模型则 chat 收到 undefined model（由 model-bridge 自身的参数校验抛错，经统一包装呈现）。
 * 全部不可用 → { channel:'none', chat }，chat 恒 reject NONE_MESSAGE。
 */
function resolveTextLLM(channels) {
  const c = channels || {};

  if (c.vscodeLm && c.vscodeLm.available) {
    return { channel: 'vscode-lm', chat: wrapChat((messages, opts) => c.vscodeLm.chat(messages, opts)) };
  }

  const bridgeAv = c.bridge && c.bridge.available;
  const bridgeUsable = Array.isArray(bridgeAv) ? bridgeAv.length > 0 : Boolean(bridgeAv);
  if (bridgeUsable) {
    const model = Array.isArray(bridgeAv) ? bridgeAv[0] : undefined; // chat 用列表第一个模型
    return { channel: 'bridge', chat: wrapChat((messages, opts) => c.bridge.chat(model, messages, opts)) };
  }

  if (c.sampling && c.sampling.available) {
    return { channel: 'sampling', chat: wrapChat((messages, opts) => c.sampling.chat(messages, opts)) };
  }

  if (c.byok && c.byok.available) {
    return { channel: 'byok', chat: wrapChat((messages, opts) => c.byok.chat(messages, opts)) };
  }

  // none：chat 同步 throw 经 wrapChat 统一为 reject（调用方 await catch 一次即可）
  return { channel: 'none', chat: wrapChat(() => { throw new Error(NONE_MESSAGE); }) };
}

/**
 * 通道探测（canvas_llm_probe 应答，brief 逐字形状）：
 *   { vscodeLm:'n/a'|number, bridge:{<host>:count,...}|{}, sampling:boolean|'unsupported', byok:boolean }
 *   - vscodeLm：channels.vscodeLm 存在时给可用模型数（注入可带 count；未带 count 时按
 *     available 真值记 1/0）；缺省字面 'n/a'（MCP server 场景恒缺省）。
 *   - bridge：available 为数组时按 host 分组计数（零计数 host 省略——本测试钉此形态）；
 *     空数组/非数组/无注入 → {}。
 *   - sampling：available === true → true；false/未注入 → 'unsupported'。
 *   - byok：available 布尔直传（缺省 false）。
 *   - 序列化安全（密钥红线）：结果只含计数与布尔，绝不携带 Model/apiKey——上游注入即使
 *     带着完整 Model（含 apiKey），输出也只留下数字。
 */
function probeChannels(channels) {
  const c = channels || {};
  const out = {};

  if (c.vscodeLm) {
    const n = c.vscodeLm.count;
    out.vscodeLm = typeof n === 'number' && Number.isFinite(n) && n >= 0
      ? n
      : (c.vscodeLm.available ? 1 : 0);
  } else {
    out.vscodeLm = 'n/a';
  }

  const bridgeAv = c.bridge && c.bridge.available;
  if (Array.isArray(bridgeAv)) {
    const counts = {};
    for (const m of bridgeAv) {
      const host = m && typeof m.host === 'string' && m.host ? m.host : 'unknown';
      counts[host] = (counts[host] || 0) + 1;
    }
    out.bridge = counts;
  } else {
    out.bridge = {};
  }

  out.sampling = Boolean(c.sampling) && c.sampling.available === true ? true : 'unsupported';

  out.byok = Boolean(c.byok && c.byok.available);

  return out;
}

module.exports = { resolveTextLLM, probeChannels };
