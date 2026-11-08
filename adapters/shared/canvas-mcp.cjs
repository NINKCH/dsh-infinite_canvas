/**
 * MCP stdio 聚合 server——把 host-adapter 收集的 30 个 canvas_* 工具 + canvas_llm_probe
 * 以 MCP（newline-delimited JSON-RPC 2.0 over stdio）暴露给宿主（Qoder/WorkBuddy/Cursor 等）。
 *
 * 职责单一：帧解析（Buffer 级）/ 协议分发（initialize / tools/list / tools/call）/ 工具路由。
 * 零依赖（仅 node 内置）。CommonJS：宿主加载器以 require 为主，发布物形态见 HOST-CONTRACT.md §5。
 *
 * 协议面（刻意最小）：只做 initialize / tools/list / tools/call。JSON-RPC 通知一律不回包
 * （含 notifications/initialized）；未知方法（带 id）回 -32601、坏 JSON 行回 -32700——均为
 * JSON-RPC 2.0 基线错误语义，不新增 MCP 方法。stdout 只写 JSON-RPC 消息，一切日志走 stderr
 * （日志只记方法名/错误消息且经 redact，绝不记工具参数——apiKey 红线）。
 *
 * server→client 请求（Task 5，sampling 通道）：initialize 记录 client capabilities.sampling
 * 布尔；可用时 sampling/createMessage 以 JSON-RPC request（params 按 MCP 规范最小形态
 * {messages, maxTokens}）发给 client，应答帧（无 method、带 id 且有 pending）路由回等待者。
 * 帧读取约束（Review Focus #1）：chunk 累积为 Buffer，按字节 indexOf(0x0A) 找行界，整行
 * Buffer.concat 后一次性 utf8 解码。禁止 readline、禁止 toString 后 split——多字节字符（中文）
 * 跨 chunk 边界时两者都会碎帧。
 *
 * 单例约束（HOST-CONTRACT.md §6）：每进程只 createHostAdapter 一次；多承载（MCP + HTTP）
 * 复用同一份 tools/routes（web 承载由 Task 3 接线）。
 *
 * CLI：node canvas-mcp.cjs [--core-dir <path>] [--home <dir>] [--port <n>]
 *   --core-dir  core 入口所在目录（内含 index.js）；缺省按布局自解析（host-adapter.defaultCorePath）：
 *               发布布局 dist/core/ 与本文件同级优先，开发布局退仓库根——宿主 .mcp.json 可不传。
 *   --home      存储根（DSH_IC_* 注入）；缺省复用 host-adapter 缺省（env DSH_IC_HOME ||
 *               ~/.dsh-infinite-canvas/，数据根裁定 Task 7）。
 *   --port      可选画布 HTTP 端口：**给定时** MCP server 启动后用 canvas-web 的 startWeb
 *               顺带起画布 HTTP（复用同一份 routes；失败仅 stderr 告警不退出）；**未给定时**
 *               不启动 web（行为与 Task 2 完全一致）。
 */
'use strict';

const path = require('node:path');
const { parseArgs } = require('node:util');
const modelBridge = require('./model-bridge.cjs');
const { probeChannels } = require('./llm-channel.cjs');
const { createHostAdapter, defaultCorePath } = require('./host-adapter.cjs');

const PROTOCOL_VERSION_DEFAULT = '2025-06-18';
const SERVER_INFO = { name: 'dsh-infinite-canvas', version: '0.3.1' }; // version 与三 manifest 对齐（build-adapters 版本单源；test-adapters-mcp 断言 1 钉住）

// ---- canvas_llm_probe（Task 5 已接线）：定义固定不动，真实编排实现见 main() 内 llmProbe ----
const LLM_PROBE_DEF = {
  name: 'canvas_llm_probe',
  description: '探测当前宿主可用的 LLM 通道（VS Code LM / 桥接 / sampling / BYOK），返回各通道可用状态。',
  inputSchema: { type: 'object', properties: {} },
};

/** stderr 日志（stdout 只写 JSON-RPC 消息；统一过 redact——探测/错误可能带上游响应片段）。 */
function log(message) {
  process.stderr.write('[canvas-mcp] ' + modelBridge.redact(String(message)) + '\n');
}

/** stdout 写一行 JSON-RPC 消息（唯一出口）。 */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** CLI 参数：--core-dir / --home / --port，均可缺省；strict:false 容忍宿主多传参数。 */
function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'core-dir': { type: 'string' },
      home: { type: 'string' },
      port: { type: 'string' },
    },
    strict: false,
    allowPositional: true,
  });
  const portNum = values.port !== undefined ? Number(values.port) : undefined;
  return {
    coreDir: values['core-dir'] ? path.resolve(String(values['core-dir'])) : path.dirname(defaultCorePath()),
    homeDir: values.home ? path.resolve(String(values.home)) : undefined,
    port: Number.isInteger(portNum) && portNum >= 0 ? portNum : undefined,
    portRaw: values.port,
  };
}

/**
 * 帧读取：返回一个接收 chunk 的回调。chunk 累积为 Buffer，按字节找 0x0A 行界，
 * 整行 concat 后一次性 utf8 解码（多字节字符跨 chunk 不碎）；空行跳过，容忍 \r\n。
 */
function createLineReader(onLine) {
  let acc = null;
  return (chunk) => {
    acc = acc ? Buffer.concat([acc, chunk]) : chunk;
    for (;;) {
      const nl = acc.indexOf(0x0A); // Buffer.prototype.indexOf(number)：按字节搜索
      if (nl < 0) break;
      const line = acc.subarray(0, nl);
      acc = acc.subarray(nl + 1);
      const text = line.toString('utf8'); // 整行一次性解码
      if (!text) continue;
      onLine(text.charCodeAt(text.length - 1) === 13 ? text.slice(0, -1) : text);
    }
  };
}

// =====================================================================
// LLM 通道构造（Task 5 接线，HOST-CONTRACT.md §10）——全部为「通道实现」，编排决策在
// llm-channel.cjs（resolveTextLLM/probeChannels 纯决策 + 委托）。本文件只做：
//   bridge   = model-bridge 静默 discoverHosts + modelBridge.chat（网络在 model-bridge 内）
//   sampling = initialize 记录的 client capability + sampling/createMessage server→client 请求
//   byok     = core 数据面探明结论（§10）：core 无 BYOK url/apiKey 存储，llmOptions 返回的是
//              Harness llm 服务（ctx.get('llm')）的 providers/resolved 视图——available =
//              resolved 非 null；chat 走 core 原生 /api/llm-stream（进程内路由调用，非网络）
// =====================================================================

// ---- server→client 请求（sampling/createMessage 用）：pending 表 + 应答帧路由回等待者 ----
const pendingClientReqs = new Map(); // id → { resolve, reject, timer }
let nextClientReqId = 1;
const SAMPLING_TIMEOUT_MS = 60000;

/** 向 client 发 JSON-RPC request 并等待其应答帧（handleMessage 里的响应分支路由到这）。 */
function requestClient(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextClientReqId++;
    const timer = setTimeout(() => {
      if (pendingClientReqs.delete(id)) reject(new Error('sampling: client 应答超时（' + (timeoutMs || SAMPLING_TIMEOUT_MS) + 'ms）'));
    }, timeoutMs || SAMPLING_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref(); // 不阻塞宿主进程退出
    pendingClientReqs.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

/** MCP content 形状 → 纯文本（字符串直传；[{type:'text',text}] 拼接；其余空串）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

/** sampling 通道 chat：向 client 发 sampling/createMessage（params 按 MCP 规范最小形态）。 */
async function samplingChat(messages, opts) {
  const arr = Array.isArray(messages) ? messages : [];
  const params = {
    messages: arr.map((m) => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: { type: 'text', text: textOfContent(m && m.content) },
    })),
    maxTokens: opts && typeof opts.maxTokens === 'number' && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
      ? opts.maxTokens
      : 1024,
  };
  let result;
  try {
    result = await requestClient('sampling/createMessage', params, opts && opts.timeout);
  } catch (e) {
    // client 拒答/失败 → chat 抛错（redact 后；brief 语义）
    throw new Error(modelBridge.redact('sampling: ' + ((e && e.message) || String(e))));
  }
  const content = result && result.message && result.message.content;
  const text = content && content.type === 'text' && typeof content.text === 'string'
    ? content.text
    : (typeof content === 'string' ? content : undefined);
  if (typeof text !== 'string') throw new Error('sampling: client 应答缺少 message.content.text');
  return { text };
}

/**
 * bridge 通道：静默 discoverHosts（Task 5 Ruling：不传 log）→ 取第一个非空 host 的模型列表
 * （顺序 workbuddy > qoder > cursor）；全空 → available=[]（编排器视为不可用）。
 * chat 签名 (model, messages, opts)——编排器绑定列表第一个模型。
 */
function buildBridgeChannel() {
  const discovered = modelBridge.discoverHosts();
  let models = [];
  for (const host of ['workbuddy', 'qoder', 'cursor']) {
    if (Array.isArray(discovered[host]) && discovered[host].length) {
      models = discovered[host];
      break;
    }
  }
  return {
    available: models,
    chat(model, messages, opts) {
      return modelBridge.chat(model, messages, opts); // 错误已先脱敏后截断（model-bridge §9）
    },
  };
}

/**
 * 进程内调用一条 core 路由（byok 专用，非网络）：伪造最小 req/res——core 的 rpc 与
 * llm-stream handler 只消费 req.method / req 异步迭代（body）/ res.statusCode / res.setHeader /
 * res.write / res.end / res.on('close') / res.headersSent。headersSent 语义对齐真实 node：
 * setHeader 不置位，write 才置位（core 错误分支据此区分 400 JSON 与 SSE fail 事件）。
 */
function invokeRoute(route, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let statusCode = 200;
    let headersSent = false;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = {
      method: 'POST',
      async *[Symbol.asyncIterator]() { yield body; },
    };
    const res = {
      set statusCode(v) { statusCode = v; },
      get statusCode() { return statusCode; },
      get headersSent() { return headersSent; },
      setHeader() { /* 头部未冲刷：真实 node 在首次 write 才置 headersSent */ },
      write(c) {
        headersSent = true;
        chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
        return true;
      },
      end(c) {
        if (c !== undefined && c !== null) chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
        resolve({ status: statusCode, body: chunks.join('') });
      },
      on() { /* 'close' 监听：进程内调用不会中途断开 */ },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
  });
}

/**
 * byok 通道（按 core 语义探明后接线，brief fallback 条款；探明结论记录于 HOST-CONTRACT §10）：
 * core 的 llmOptions RPC（index.js L3986 → listLlmOptions）读的是 Harness llm 服务
 * （ctx.get('llm')），返回 {providers, resolved, error?}，**没有任何 BYOK url/apiKey 概念**
 * （index.js 全文 grep apiKey/baseUrl/byok 零命中）。因此：
 *   - available = llmOptions().resolved 非 null（Harness llm 服务已配置至少一个可用模型）；
 *     llm 服务不可用（MCP 承载的假 ctx 恒 undefined）→ false，绝不在探测时抛错。
 *   - chat 不走 brief 假设的「url/apiKey 构造 Model + model-bridge 直调」（该配置在 core 不存在），
 *     改走 core 原生文本生成路径 /api/llm-stream：messages → complete(args) 形状
 *     （{system, user, temperature?, maxTokens?}，core 语义 system/user 为字符串），
 *     SSE 事件 t:'x' 累积 / t:'done' 为权威全文 / t:'fail' → 抛错（redact 后）。
 */
function findRoute(routes, apiPath) {
  return (routes || []).find((r) => r && r.kind === 'exact' && r.path === apiPath) || null;
}

async function buildByokChannel(routes) {
  const rpcRoute = findRoute(routes, '/infinite-canvas/api/rpc');
  const streamRoute = findRoute(routes, '/infinite-canvas/api/llm-stream');
  // available 探测：rpc 路由缺失/非 200/坏 JSON/llm 服务不可用（error 字段）→ 一律 false
  let available = false;
  try {
    if (rpcRoute) {
      const res = await invokeRoute(rpcRoute, { method: 'llmOptions' });
      if (res.status === 200) {
        const parsed = JSON.parse(res.body);
        available = Boolean(parsed && parsed.resolved && !parsed.error);
      }
    }
  } catch { available = false; }

  return {
    available,
    async chat(messages, opts) {
      if (!streamRoute) throw new Error('byok: 画布 llm-stream 路由不可用');
      const arr = Array.isArray(messages) ? messages : [];
      const args = {
        system: textOfContent(arr.filter((m) => m && m.role === 'system').map((m) => m.content).join('\n')),
        user: textOfContent((() => {
          for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i] && arr[i].role === 'user') return arr[i].content;
          }
          return '';
        })()),
      };
      const o = opts || {};
      if (typeof o.temperature === 'number' && Number.isFinite(o.temperature)) args.temperature = o.temperature;
      if (typeof o.maxTokens === 'number' && Number.isFinite(o.maxTokens) && o.maxTokens > 0) args.maxTokens = o.maxTokens;
      const res = await invokeRoute(streamRoute, args);
      if (res.status !== 200) {
        throw new Error(modelBridge.redact('byok: 画布 LLM HTTP ' + res.status + ': ' + res.body.slice(0, 200)));
      }
      let text = '';
      let doneText = null;
      let failed = null;
      for (const line of res.body.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        let ev = null;
        try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
        if (ev && ev.t === 'x' && typeof ev.d === 'string') text += ev.d;
        else if (ev && ev.t === 'done') doneText = ev.d;
        else if (ev && ev.t === 'fail') failed = ev.d;
      }
      if (failed !== null && failed !== undefined) {
        throw new Error(modelBridge.redact('byok: 画布 LLM 生成失败: ' + String(failed)));
      }
      if (typeof doneText === 'string') text = doneText; // done 事件携带权威全文
      if (!text) throw new Error('byok: 画布 LLM 未返回文本');
      return { text };
    },
  };
}

async function main() {
  const { coreDir, homeDir, port, portRaw } = parseCliArgs(process.argv.slice(2));
  // 单例约束：每进程只 create 一次（HOST-CONTRACT.md §6）。corePath = --core-dir 下的 index.js。
  const adapter = await createHostAdapter({
    corePath: path.join(coreDir, 'index.js'),
    homeDir,
  });
  // 实际生效的存储根（host-adapter 已注入 DSH_IC_* env；无论注入路径如何，以此为准记录）。
  const effectiveHome = path.dirname(process.env.DSH_IC_CONFIG_PATH || '');

  // 30 个 canvas_* def → MCP tools：name/description/inputSchema 逐字透传（inputSchema = def.parameters），
  // 顺序与 CANVAS_METHODS（HOST-CONTRACT.md §3）一致。
  const executors = new Map(); // 工具名 → execute(args)
  const mcpTools = adapter.tools.map((def) => {
    executors.set(def.name, def.execute);
    return { name: def.name, description: def.description, inputSchema: def.parameters };
  });

  // ---- canvas_llm_probe 真实编排（Task 5 接线；通道构造见顶部 LLM 通道构造段） ----
  // channels 每次探测现构造：bridge 文件可变（重读成本低且语义诚实）；sampling 读 initialize
  // 记录的 client capability 当前值；byok 每次重读 llmOptions（llm 服务可能中途就绪）。
  let clientSampling = false; // initialize 时记录 client capabilities.sampling 布尔
  async function llmProbe() {
    const channels = {
      // vscodeLm：MCP server 场景恒缺省（仅 vsix 壳注入）→ probe.vscodeLm = 'n/a'
      bridge: buildBridgeChannel(),
      sampling: { available: clientSampling, chat: samplingChat },
      byok: await buildByokChannel(adapter.routes),
    };
    return probeChannels(channels);
  }
  // canvas_llm_probe 追加末位（第 31 个）。
  executors.set(LLM_PROBE_DEF.name, llmProbe);
  mcpTools.push(LLM_PROBE_DEF);

  // ---- 协议分发：stdin 先到先入队，adapter 就绪后按序泵出（避免 import core 期间的启动竞态） ----
  const inbox = [];
  let ready = false;
  let pumping = false;
  async function pump() {
    if (!ready || pumping) return;
    pumping = true;
    try {
      while (inbox.length) await handleMessage(inbox.shift());
    } finally {
      pumping = false;
    }
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return; // 非对象帧，忽略
    const id = msg.id;
    if (typeof msg.method !== 'string') {
      // 应答帧（server→client 请求如 sampling/createMessage 的回包：无 method、带 id）。
      // 只有 pending 表在等的 id 才消费；其余（含无 id 的杂帧）照旧静默忽略——协议面不扩。
      if (id === undefined || id === null) return;
      const pending = pendingClientReqs.get(id);
      if (!pending) return;
      pendingClientReqs.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error && typeof msg.error === 'object') {
        pending.reject(new Error(modelBridge.redact(String(msg.error.message ?? JSON.stringify(msg.error)))));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (id === undefined || id === null) return; // 通知一律不回包（含 notifications/initialized）
    try {
      if (msg.method === 'initialize') {
        // protocolVersion：回显 client 提供的版本；未提供则缺省 2025-06-18
        const requested = msg.params && typeof msg.params.protocolVersion === 'string'
          ? msg.params.protocolVersion
          : PROTOCOL_VERSION_DEFAULT;
        // Task 5：记录 client 是否具备 sampling 能力（MCP 规范：capabilities.sampling 存在即支持）
        clientSampling = Boolean(msg.params && msg.params.capabilities && msg.params.capabilities.sampling);
        send({ jsonrpc: '2.0', id, result: { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: mcpTools } });
      } else if (msg.method === 'tools/call') {
        await callTool(id, msg.params);
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
      }
    } catch (e) {
      // 双保险：分发层任何异常都不允许进程退出
      log('分发异常: ' + (e && e.message ? e.message : String(e)));
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    }
  }

  async function callTool(id, params) {
    const name = params && typeof params.name === 'string' ? params.name : '';
    const execute = executors.get(name);
    if (!execute) {
      // 未知工具名 → JSON-RPC error -32602（MCP 约定）
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
      return;
    }
    const args = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    try {
      const result = await execute(args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result === undefined ? null : result) }] } });
    } catch (e) {
      // execute 抛错 → 包装为 isError:true 的 tool result（text 含错误消息），进程不得退出
      const message = e && e.message ? e.message : String(e);
      log('工具执行失败 ' + name + ': ' + message); // stderr；只记错误消息，不记参数（apiKey 红线）
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: message }], isError: true } });
    }
  }

  function handleLine(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // 坏 JSON 行：JSON-RPC 2.0 基线回 -32700（id 不可靠 → null）；日志只记长度不记内容（apiKey 红线）
      log('JSON 解析失败，丢弃该行（长度 ' + text.length + '）');
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    inbox.push(msg);
    pump();
  }

  // ---- stdio 接线 ----
  process.stdin.on('data', createLineReader(handleLine));
  process.stdin.on('end', () => {
    // 宿主关 stdin = 停机信号：撤销注册（dispose 幂等）后安静退出
    try { adapter.dispose(); } catch { /* 忽略 */ }
    process.exit(0);
  });
  process.stdin.on('error', (e) => log('stdin 错误: ' + (e && e.message ? e.message : e)));
  process.stdout.on('error', () => process.exit(0)); // 宿主先退（EPIPE）：静默收场

  ready = true;
  log('ready: ' + mcpTools.length + ' tools; coreDir=' + coreDir + '; home=' + effectiveHome);
  pump(); // 泵出启动期间排队的消息

  // ---- 可选画布 HTTP（Task 3 接线）：MCP server 已就绪后顺带起 web；失败仅告警不退出 ----
  if (port !== undefined) {
    startCanvasWeb(port, adapter.routes).catch(() => { /* 已在 startCanvasWeb 内 log */ });
  } else if (portRaw !== undefined) {
    log('--port 无效（' + portRaw + '），跳过画布 HTTP');
  }
}

/** 给定 --port 时：动态加载 canvas-web，复用本进程 adapter 的 routes 起画布 HTTP（§6 单例）。 */
async function startCanvasWeb(port, routes) {
  try {
    const mod = await import('./canvas-web.cjs');
    const startWeb = mod.startWeb || (mod.default && mod.default.startWeb);
    if (typeof startWeb !== 'function') throw new Error('canvas-web.cjs 未导出 startWeb');
    const web = await startWeb({ port, routes });
    log('web: ' + web.url + (web.isReuse ? '（复用已有画布服务，未起新 server）' : ''));
  } catch (e) {
    log('--port 启动画布 HTTP 失败（MCP 不受影响继续运行）: ' + (e && e.message ? e.message : String(e)));
  }
}

main().catch((e) => {
  log('启动失败: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
