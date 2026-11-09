/**
 * 桥接 llm 服务（Task 16 / v0.3.3）——把宿主网关模型（model-bridge.cjs）包装成 core 消费的
 * Harness llm 服务形状，供 host-adapter 假 ctx 的 get('llm') 返回（canvas-web / canvas-mcp
 * 承载进程内与 core RPC handler 同进程，模型修复全在 Node 侧，浏览器壳零改动）。
 *
 * core 消费接口（index.js L3604-3679 实证，listLlmOptions / complete）：
 *   listProviders() → [{id, name}]        非空 host 映射（discoverHosts 有可用模型的 host）；
 *                                         qoder/cursor 恒空不列（最终结论 not-planned）
 *   listModels(providerId) → [{id, name}] 该 host 模型清单（id=模型 id，name=同名；空 id 条目剔除）
 *   stream(options) → 异步生成器：
 *     yield { type:'text-delta', text }   桥接 chat 的完整返回文本（**伪流**：整段一个 delta，
 *                                         编剧室 onText 一次性收到全文——行为正确但无打字机效果）
 *     yield { type:'finish', reason:{kind:'stop'} }                        成功
 *     yield { type:'finish', reason:{kind:'error', failure:{message}} }    网关失败（message 过 redact）
 *   // options = core complete() 构造的信封：{provider, model, system?, messages, temperature?, maxTokens?}
 *   // messages 内容是 core 压平前的形态（[{role, content:string|[{type:'text',text}]}]），
 *   // 本模块负责压平成 OpenAI 兼容的 [{role:'system',content}, {role:'user',content}] 再交 chat。
 *
 * **finish 形状以 core 为准**（brief 伪码写 finish:{...}，但 core 逐字读 chunk.reason——
 * index.js L3680 `const r = chunk.reason`，L3681 `r.failure.message`）。
 *
 * 密钥红线（model-bridge 同款纪律）：本模块任何出口（listProviders/listModels/stream 事件/
 * 错误消息）只含 id/name/文本/redact 后的 message，绝不携带 Model/apiKey；stream 的错误路径
 * 统一再过一遍 redact（自研 chat 注入者可能不脱敏，双保险）。
 *
 * 注入面（全部可选，测试用；生产 createLlmBridgeService() 零参）：
 *   discoverHosts  覆盖 model-bridge.discoverHosts（默认真件）
 *   chat           覆盖 model-bridge.chat（默认真件）
 *   paths          透传 discoverHosts 的 paths（{workbuddyModels?, qoderModelsDir?}，测试隔离）
 *   hostVersion    透传 chat 的 opts.hostVersion（测试避开真实安装目录探测）
 *
 * 零依赖（仅 require 兄弟模块 model-bridge.cjs，其自身仅 node 内置）。CommonJS：
 * 发布物 dist/llm-bridge-service.cjs（§5 六模块清单）。无 CLI：host-adapter 经 require 调用。
 */
'use strict';

const { discoverHosts, chat, redact } = require('./model-bridge.cjs');

// host 展示名（listProviders 的 name 字段；顺序即数组顺序——workbuddy 在前=resolveModel
// 的默认 provider 选择序）。qoder/cursor 恒空不列，名字仅防御性保留。
const HOST_NAMES = [
  ['workbuddy', 'WorkBuddy 模型桥（本机网关）'],
  ['qoder', 'Qoder 模型桥（本机网关）'],
  ['cursor', 'Cursor 模型桥（本机网关）'],
];

/** content 压平：string 原样；[{type:'text',text}] 拼接 text 片段；其余 → ''。 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * messages 压平：role==='system' 归 system（\n 连接），其余归 user（空段落连接）——
 * core 的追问重试（老式信封 / 追问正文）会发多条 user 消息，保留全部文本。
 */
function flattenMessages(messages) {
  const sys = [];
  const usr = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const text = textOfContent(m.content);
    if (!text) continue;
    if (m.role === 'system') sys.push(text);
    else usr.push(text);
  }
  return { system: sys.join('\n'), user: usr.join('\n\n') };
}

/**
 * 创建桥接 llm 服务。返回对象形状即 core 期望的 llm 服务（listProviders/listModels/
 * stream；listConfigurableProviders 不实现——core 有 typeof 守卫，typeof 检查后跳过）。
 */
function createLlmBridgeService(options) {
  const opts = options || {};
  const discover = opts.discoverHosts || discoverHosts;
  const chatFn = opts.chat || chat;
  const discoverArg = opts.paths ? { paths: opts.paths } : undefined;

  /** 当前可用模型清单（空 id / 非对象条目剔除——id 是选择锚点，空 id 会污染默认选择）。 */
  function usableModels(hostId) {
    let hosts;
    try {
      hosts = discover(discoverArg) || {};
    } catch {
      return []; // discover 契约是不抛错；防御兜底（注入桩抛错也不外泄）
    }
    const list = hosts[hostId];
    if (!Array.isArray(list)) return [];
    return list.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id);
  }

  function listProviders() {
    const out = [];
    for (const [id, name] of HOST_NAMES) {
      if (usableModels(id).length) out.push({ id, name });
    }
    return out;
  }

  function listModels(providerId) {
    return usableModels(providerId).map((m) => ({ id: m.id, name: m.id }));
  }

  /**
   * 伪流：桥接 chat 一次拿全文 → 整段一个 text-delta → finish stop。
   * 失败两态：模型解析不到（无 host/无此模型）→ throw（core run() 收进 error 聚合）；
   * 网关调用失败 → yield finish error（message 过 redact，core 逐字读 reason.failure.message）。
   */
  async function* stream(options) {
    const o = options || {};
    const provider = typeof o.provider === 'string' ? o.provider : '';
    const modelId = typeof o.model === 'string' ? o.model : '';
    const model = usableModels(provider).find((m) => m.id === modelId) || null;
    if (!model) {
      // discoverHosts 全空 / provider 不在列 / model id 不匹配：保持 core 语义（抛错）
      throw new Error(redact('模型桥无可用模型：provider=' + (provider || '（空）') +
        ' model=' + (modelId || '（空）') + '（宿主未登录网关或模型清单已变化，请重开设置页刷新）'));
    }
    const flat = flattenMessages(o.messages);
    const system = typeof o.system === 'string' && o.system ? o.system : flat.system;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: flat.user });
    // core 纪律（index.js L3655）：只透传调用方显式给出的参数；不给就不发，用宿主网关默认值
    const body = {};
    if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) body.temperature = o.temperature;
    if (typeof o.maxTokens === 'number' && Number.isFinite(o.maxTokens) && o.maxTokens > 0) body.max_tokens = o.maxTokens;
    let text = '';
    try {
      // chat 约定：额外字段经 o.body 合并进请求体（见 model-bridge.cjs chat）
      const r = await chatFn(model, messages, { body, hostVersion: opts.hostVersion });
      text = r && typeof r.text === 'string' ? r.text : '';
    } catch (e) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: redact((e && e.message) || String(e)) } } };
      return;
    }
    if (text) yield { type: 'text-delta', text }; // 整段一个 delta（伪流，见文件头）
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  return { listProviders, listModels, stream };
}

module.exports = { createLlmBridgeService };
