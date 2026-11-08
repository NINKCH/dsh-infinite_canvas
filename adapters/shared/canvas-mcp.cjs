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
 * （日志只记方法名/错误消息，绝不记工具参数——apiKey 红线）。
 *
 * 帧读取约束（Review Focus #1）：chunk 累积为 Buffer，按字节 indexOf(0x0A) 找行界，整行
 * Buffer.concat 后一次性 utf8 解码。禁止 readline、禁止 toString 后 split——多字节字符（中文）
 * 跨 chunk 边界时两者都会碎帧。
 *
 * 单例约束（HOST-CONTRACT.md §6）：每进程只 createHostAdapter 一次；多承载（MCP + HTTP）
 * 复用同一份 tools/routes（web 承载由 Task 3 接线）。
 *
 * CLI：node canvas-mcp.cjs [--core-dir <path>] [--home <dir>] [--port <n>]
 *   --core-dir  core 入口所在目录（内含 index.js）；缺省 = 仓库根（与 host-adapter 同款解析）。
 *   --home      存储根（DSH_IC_* 注入）；缺省复用 host-adapter 默认（adapters/.tmp-home/）。
 *   --port      可选画布 HTTP 端口：**给定时** MCP server 启动后用 canvas-web 的 startWeb
 *               顺带起画布 HTTP（复用同一份 routes；失败仅 stderr 告警不退出）；**未给定时**
 *               不启动 web（行为与 Task 2 完全一致）。
 */
'use strict';

const path = require('node:path');
const { parseArgs } = require('node:util');

// 仓库根：本文件位于 adapters/shared/，向上两级即仓库根（与 host-adapter.cjs 同款解析）。
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROTOCOL_VERSION_DEFAULT = '2025-06-18';
const SERVER_INFO = { name: 'dsh-infinite-canvas', version: '0.1.0' };

// ---- canvas_llm_probe（Task 5 接线点）：顶部单一定义，届时把 llmProbe 换成真实探测即可，协议面不动 ----
const llmProbe = async () => ({ vscodeLm: 'n/a', bridge: [], sampling: 'unknown', byok: false });
const LLM_PROBE_DEF = {
  name: 'canvas_llm_probe',
  description: '探测当前宿主可用的 LLM 通道（VS Code LM / 桥接 / sampling / BYOK），返回各通道可用状态。',
  inputSchema: { type: 'object', properties: {} },
};

/** stderr 日志（stdout 只写 JSON-RPC 消息）。 */
function log(message) {
  process.stderr.write('[canvas-mcp] ' + message + '\n');
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
    coreDir: values['core-dir'] ? path.resolve(String(values['core-dir'])) : REPO_ROOT,
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

async function main() {
  const { coreDir, homeDir, port, portRaw } = parseCliArgs(process.argv.slice(2));
  const { createHostAdapter } = require('./host-adapter.cjs');
  // 单例约束：每进程只 create 一次（HOST-CONTRACT.md §6）。corePath = --core-dir 下的 index.js。
  const adapter = await createHostAdapter({
    corePath: path.join(coreDir, 'index.js'),
    homeDir,
  });

  // 30 个 canvas_* def → MCP tools：name/description/inputSchema 逐字透传（inputSchema = def.parameters），
  // 顺序与 CANVAS_METHODS（HOST-CONTRACT.md §3）一致。
  const executors = new Map(); // 工具名 → execute(args)
  const mcpTools = adapter.tools.map((def) => {
    executors.set(def.name, def.execute);
    return { name: def.name, description: def.description, inputSchema: def.parameters };
  });
  // canvas_llm_probe 追加末位（第 31 个）：Task 5 把 llmProbe 换成真实实现即可。
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
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return; // 非请求帧，忽略
    const id = msg.id;
    if (id === undefined || id === null) return; // 通知一律不回包（含 notifications/initialized）
    try {
      if (msg.method === 'initialize') {
        // protocolVersion：回显 client 提供的版本；未提供则缺省 2025-06-18
        const requested = msg.params && typeof msg.params.protocolVersion === 'string'
          ? msg.params.protocolVersion
          : PROTOCOL_VERSION_DEFAULT;
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
  log('ready: ' + mcpTools.length + ' tools; coreDir=' + coreDir + '; home=' + (homeDir || 'adapters/.tmp-home (默认)'));
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
