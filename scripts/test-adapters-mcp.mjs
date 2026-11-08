#!/usr/bin/env node
/**
 * MCP stdio 聚合 server（canvas-mcp.cjs）契约测试（dev-only，不随包发布）。
 *
 * 以子进程拉起 node adapters/shared/canvas-mcp.cjs，经 newline-delimited JSON-RPC 2.0 over
 * stdio 逐条断言（需求：task-2-brief.md，六条断言全覆盖）：
 *  1) initialize 应答含 serverInfo.name==='dsh-infinite-canvas' 与 capabilities.tools
 *     （protocolVersion：client 提供则回显，未提供则缺省 2025-06-18）
 *  1b) canvas_llm_probe 真实编排（Task 5 接线）：client 声明 capabilities.sampling →
 *      probe.sampling === true（能力记录）；vscodeLm 'n/a'（MCP 场景恒缺省）；bridge 为
 *      host→count 对象（无桥接配置 → {}）；byok 布尔；应答全文无 'sk-'（密钥红线）
 *  2) tools/list 长度 31：前 30 名与 HOST-CONTRACT.md §3 CANVAS_METHODS 逐项一致（顺序），
 *     末位为 canvas_llm_probe（inputSchema = {type:'object',properties:{}}）
 *  3) tools/call 真实通路：canvas_list_projects {} → content[0].text 为完整 {count,text} JSON；
 *     canvas_create_project → content[0].text 含 "ok":true
 *     （勘误：brief 原文断言 canvas_list_projects 含 "ok":true，实测该工具返回 {count,text}
 *      无 ok 字段（index.js L4674）；"ok":true 断言落到契约上有 ok 字段的 canvas_create_project，
 *      tools/call 通路验证意图不变，待 controller 勘误计划原文）
 *  4) tools/call 未知工具名 → JSON-RPC error code === -32602
 *  5) 碎帧防护：发送一条 >64KB 且含中文的合法 JSON 行（tools/list 附超长中文探针字段，按
 *     8191 字节分片写入制造跨 chunk 边界）→ 应答完整可 JSON.parse 且 tools 仍 31 个；
 *     含中文的未知工具名请求 → 错误应答中文完好（证明按 Buffer 切帧未碎多字节字符）
 *  6) tools/call canvas_node_status 带不存在的 nodeId → isError:true 的 tool result（text 含
 *     错误消息，非协议层 crash），随后 tools/list 仍正常（进程存活）
 *
 * 存储根：--home 注入 adapters/.tmp-home/（复用 Task 1 测试模式，绝不碰真实画布数据）。
 * 运行：node scripts/test-adapters-mcp.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'adapters', 'shared', 'canvas-mcp.cjs');
const TMP_HOME = path.join(ROOT, 'adapters', '.tmp-home');
const REQUEST_TIMEOUT_MS = 20000;
/** 分片写入块大小：8191 字节（奇数、非 3 的倍数）→ 分片边界频繁落在中文字符（3 字节 UTF-8）内部。 */
const CHUNK_SIZE = 8191;

const errs = [];

// ---------- 从 HOST-CONTRACT.md 解析 CANVAS_METHODS（文档即权威，同 Task 1 测试的做法） ----------
function canvasMethodsFromContract() {
  const md = fs.readFileSync(path.join(ROOT, 'adapters', 'shared', 'HOST-CONTRACT.md'), 'utf8');
  const m = md.match(/const CANVAS_METHODS = \[([\s\S]*?)\];/);
  if (!m) { errs.push('HOST-CONTRACT.md 里找不到 CANVAS_METHODS 数组'); return null; }
  const names = [...m[1].matchAll(/'(canvas_[a-z_]+)'/g)].map((x) => x[1]);
  if (!names.length) { errs.push('HOST-CONTRACT.md 的 CANVAS_METHODS 数组为空'); return null; }
  return names;
}

// ---------- 子进程 stdio JSON-RPC 客户端（Buffer 级切帧，与被测协议对称） ----------
let child = null;
let nextId = 1;
const pending = new Map(); // id → { resolve, reject, timer }
const unexpected = [];     // 没有请求在等的应答（通知被回包 / id 不匹配都算）
const stderrChunks = [];
let stdoutAcc = null;
let finished = false;

function failAll(message) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
  }
  pending.clear();
}

function startServer() {
  child = spawn(process.execPath, [SERVER, '--home', TMP_HOME], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (e) => failAll('子进程 spawn 失败: ' + e.message));
  child.on('exit', (code) => { if (!finished) failAll('server 进程提前退出（code=' + code + '）'); });
  child.stdout.on('data', (chunk) => {
    // Buffer 级按字节找行界再整行解码（测试侧与 server 侧同构，避免测试自身碎帧）
    stdoutAcc = stdoutAcc ? Buffer.concat([stdoutAcc, chunk]) : chunk;
    for (;;) {
      const nl = stdoutAcc.indexOf(0x0A);
      if (nl < 0) break;
      const line = stdoutAcc.subarray(0, nl).toString('utf8');
      stdoutAcc = stdoutAcc.subarray(nl + 1);
      onServerLine(line);
    }
  });
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.stdin.on('error', () => { /* server 死后写 stdin 的 EPIPE：exit 分支已报错 */ });
}

function onServerLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    errs.push('server stdout 出现非 JSON 行: ' + line.slice(0, 120));
    return;
  }
  const entry = msg && pending.get(msg.id);
  if (entry) {
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  } else {
    unexpected.push(msg);
  }
}

function sendLine(obj) {
  child.stdin.write(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));
}

/** 分片写入一整行：用背压（drain）强制子进程多次收到 data 事件，块大小刻意非字节对齐。 */
async function sendLineChunked(obj) {
  const buf = Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
    const piece = buf.subarray(i, Math.min(i + CHUNK_SIZE, buf.length));
    if (!child.stdin.write(piece)) {
      await Promise.race([once(child.stdin, 'drain'), new Promise((r) => setTimeout(r, 5000))]);
    }
  }
}

function request(method, params, { chunked = false } = {}) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）: ${method} id=${id}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
  });
  const frame = { jsonrpc: '2.0', id, method, params };
  if (chunked) { sendLineChunked(frame); } else { sendLine(frame); }
  return promise;
}

function notify(method, params) {
  sendLine({ jsonrpc: '2.0', method, params });
}

function contentText(res) {
  const c = res && res.result && Array.isArray(res.result.content) ? res.result.content[0] : null;
  return c && c.type === 'text' ? c.text : undefined;
}

try {
  startServer();

  // ---------- 断言 1：initialize 应答（serverInfo + capabilities.tools + 版本回显/缺省） ----------
  const init1 = await request('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'dsh-adapter-test', version: '0.0.0' },
    capabilities: { sampling: {} }, // Task 5：声明 sampling 能力，供断言 1b 验证 server 侧记录
  });
  if (!init1.result) errs.push('initialize 应返回 result，实际: ' + JSON.stringify(init1).slice(0, 200));
  else {
    if (init1.result.serverInfo && init1.result.serverInfo.name !== 'dsh-infinite-canvas') {
      errs.push(`initialize.serverInfo.name 应为 dsh-infinite-canvas，实际 ${JSON.stringify(init1.result.serverInfo)}`);
    }
    if (!init1.result.serverInfo) errs.push('initialize 应答缺 serverInfo');
    if (!init1.result.capabilities || !init1.result.capabilities.tools) {
      errs.push('initialize 应答应含 capabilities.tools');
    }
    if (init1.result.protocolVersion !== '2025-06-18') {
      errs.push(`initialize 应回显 client 的 protocolVersion 2025-06-18，实际 ${init1.result.protocolVersion}`);
    }
  }
  notify('notifications/initialized', {}); // 通知：server 无需应答（收尾断言 unexpected 为空）

  // ---------- 断言 1b：canvas_llm_probe 真实编排（Task 5 接线） ----------
  // 旧默认值 {vscodeLm:'n/a', bridge:[], sampling:'unknown', byok:false} 换为 probeChannels
  // 新语义：bridge 为 host→count 对象、sampling true|'unsupported'（此处 client 声明了
  // sampling 能力 → true，验证 initialize 能力记录）。
  const probeCall = await request('tools/call', { name: 'canvas_llm_probe', arguments: {} });
  const probeText = contentText(probeCall);
  if (!probeCall.result || typeof probeText !== 'string') {
    errs.push('canvas_llm_probe 应返回 content[0].text 字符串，实际: ' + JSON.stringify(probeCall).slice(0, 200));
  } else {
    let probeParsed = null;
    try { probeParsed = JSON.parse(probeText); } catch { /* 记入下方错误 */ }
    if (!probeParsed || typeof probeParsed !== 'object' || Array.isArray(probeParsed)) {
      errs.push('canvas_llm_probe 的 content[0].text 应为 JSON 对象，实际: ' + probeText.slice(0, 200));
    } else {
      if (probeParsed.vscodeLm !== 'n/a') {
        errs.push(`probe.vscodeLm 在 MCP server 场景应为 'n/a'（恒缺省注入），实际 ${JSON.stringify(probeParsed.vscodeLm)}`);
      }
      if (!probeParsed.bridge || typeof probeParsed.bridge !== 'object' || Array.isArray(probeParsed.bridge)) {
        errs.push(`probe.bridge 应为 host→count 对象（无桥接配置时 {}），实际 ${JSON.stringify(probeParsed.bridge)}`);
      }
      if (probeParsed.sampling !== true && probeParsed.sampling !== 'unsupported') {
        errs.push(`probe.sampling 应为 true|'unsupported'，实际 ${JSON.stringify(probeParsed.sampling)}`);
      } else if (probeParsed.sampling !== true) {
        errs.push(`client 已声明 capabilities.sampling，probe.sampling 应记录为 true，实际 ${JSON.stringify(probeParsed.sampling)}`);
      }
      if (typeof probeParsed.byok !== 'boolean') {
        errs.push(`probe.byok 应为布尔，实际 ${JSON.stringify(probeParsed.byok)}`);
      }
      if (probeText.includes('sk-')) errs.push('probe 应答出现 sk- 字样——密钥红线（只允许计数与布尔）');
    }
  }

  // initialize 不带 protocolVersion → 缺省 2025-06-18
  const init2 = await request('initialize', {});
  if (init2.result && init2.result.protocolVersion !== '2025-06-18') {
    errs.push(`initialize 未提供版本时应缺省 2025-06-18，实际 ${init2.result.protocolVersion}`);
  }

  // ---------- 断言 1c：不属于任何 server→client 请求的应答帧 → 静默忽略（Task 5 新增
  // 响应帧路由的边界：无 pending 在等的 id 不得回包/不得扰动进程；断言 2 的 tools/list
  // 紧随其后成功即为存活证明，收尾 unexpected 为空即为无多余回包证明） ----------
  sendLine({ jsonrpc: '2.0', id: 424242, result: { ignored: true } });

  // ---------- 断言 2：tools/list 长度 31，前 30 与 CANVAS_METHODS 一致，末位 canvas_llm_probe ----------
  const CANVAS_METHODS = canvasMethodsFromContract();
  const list1 = await request('tools/list', {});
  const tools = list1.result && Array.isArray(list1.result.tools) ? list1.result.tools : null;
  if (!tools) errs.push('tools/list 应返回 result.tools 数组，实际: ' + JSON.stringify(list1).slice(0, 200));
  else {
    if (tools.length !== 31) errs.push(`tools/list 长度应为 31（30 canvas_* + canvas_llm_probe），实际 ${tools.length}`);
    const names = tools.map((t) => t && t.name);
    if (CANVAS_METHODS) {
      for (let i = 0; i < CANVAS_METHODS.length; i++) {
        if (names[i] !== CANVAS_METHODS[i]) {
          errs.push(`第 ${i + 1} 个工具不符（实际 "${names[i]}" vs CANVAS_METHODS "${CANVAS_METHODS[i]}"）`);
          break;
        }
      }
      if (names[30] !== 'canvas_llm_probe') errs.push(`末位工具应为 canvas_llm_probe，实际 ${names[30]}`);
    }
    for (const t of tools) {
      if (typeof t.name !== 'string' || !t.name) errs.push('工具缺 name');
      if (typeof t.description !== 'string' || !t.description) errs.push(`${t.name}.description 应为非空字符串`);
      if (!t.inputSchema || typeof t.inputSchema !== 'object') errs.push(`${t.name}.inputSchema 应为对象`);
    }
    const probe = tools.find((t) => t && t.name === 'canvas_llm_probe');
    if (probe && JSON.stringify(probe.inputSchema) !== JSON.stringify({ type: 'object', properties: {} })) {
      errs.push('canvas_llm_probe.inputSchema 应为 {type:\'object\',properties:{}}，实际 ' + JSON.stringify(probe.inputSchema));
    }
  }

  // ---------- 断言 3：tools/call 真实通路（结果 JSON 完整 + "ok":true） ----------
  const listCall = await request('tools/call', { name: 'canvas_list_projects', arguments: {} });
  const listText = contentText(listCall);
  if (typeof listText !== 'string') errs.push('canvas_list_projects 应返回 content[0].text 字符串，实际: ' + JSON.stringify(listCall).slice(0, 200));
  else {
    let parsed = null;
    try { parsed = JSON.parse(listText); } catch { /* 记入下方错误 */ }
    if (!parsed || typeof parsed.count !== 'number' || typeof parsed.text !== 'string') {
      errs.push('canvas_list_projects 的 content[0].text 应为完整 {count,text} JSON，实际: ' + listText.slice(0, 200));
    }
  }
  const createCall = await request('tools/call', { name: 'canvas_create_project', arguments: { name: 'mcp自检项目-中文' } });
  const createText = contentText(createCall);
  if (typeof createText !== 'string' || !createText.includes('"ok":true')) {
    errs.push(`canvas_create_project 的 content[0].text 应含 "ok":true，实际: ${String(createText).slice(0, 200)}`);
  }

  // ---------- 断言 4：未知工具名 → error.code === -32602 ----------
  const unknown = await request('tools/call', { name: 'no_such_tool', arguments: {} });
  if (!unknown.error || unknown.error.code !== -32602) {
    errs.push('未知工具应返回 error.code === -32602，实际: ' + JSON.stringify(unknown).slice(0, 200));
  }

  // ---------- 断言 5：碎帧防护（>64KB 含中文行 + 中文工具名错误应答） ----------
  const probePad = '画布碎帧探针测试'.repeat(12000); // 8 字 × 3 字节 × 12000 ≈ 281KB > 64KB
  const bigList = await request('tools/list', { probePad }, { chunked: true });
  if (!bigList.result || !Array.isArray(bigList.result.tools) || bigList.result.tools.length !== 31) {
    errs.push('>64KB 含中文碎帧行的 tools/list 应答应完整（31 个工具），实际: ' + JSON.stringify(bigList).slice(0, 200));
  }
  const cnName = '不存在的工具_中文名测试';
  const cnUnknown = await request('tools/call', { name: cnName, arguments: {} });
  if (!cnUnknown.error || cnUnknown.error.code !== -32602) {
    errs.push('含中文的未知工具名应返回 -32602，实际: ' + JSON.stringify(cnUnknown).slice(0, 200));
  } else if (typeof cnUnknown.error.message === 'string' && !cnUnknown.error.message.includes(cnName)) {
    errs.push('错误应答中的中文工具名应完好，实际: ' + cnUnknown.error.message.slice(0, 200));
  }

  // ---------- 断言 6：execute 抛错 → isError tool result（非协议层 crash），进程存活 ----------
  const badCall = await request('tools/call', {
    name: 'canvas_node_status',
    arguments: { projectId: '不存在的项目', nodeId: 'node-x' },
  });
  const badText = contentText(badCall);
  if (!badCall.result || badCall.result.isError !== true) {
    errs.push('execute 抛错应包装为 isError:true 的 tool result（非协议层 error/crash），实际: ' + JSON.stringify(badCall).slice(0, 200));
  }
  if (typeof badText !== 'string' || !badText.includes('不存在')) {
    errs.push('抛错 tool result 的 text 应含错误消息（"不存在"），实际: ' + String(badText).slice(0, 200));
  }
  const listAfter = await request('tools/list', {});
  if (!listAfter.result || !Array.isArray(listAfter.result.tools) || listAfter.result.tools.length !== 31) {
    errs.push('抛错后 tools/list 应仍正常（进程存活），实际: ' + JSON.stringify(listAfter).slice(0, 200));
  }

  // ---------- 收尾：kill 子进程（退出码不要求 0），stderr 不得有未处理异常堆栈 ----------
  finished = true;
  child.kill();
  await once(child, 'exit');
  const stderrText = Buffer.concat(stderrChunks).toString('utf8');
  if (/UnhandledPromiseRejection|Uncaught|ERR_UNHANDLED|ERR_UNCAUGHT/i.test(stderrText)) {
    errs.push('server stderr 出现未处理异常堆栈:\n' + stderrText.slice(0, 800));
  }
  if (unexpected.length) {
    errs.push(`server 发出了没有请求在等的应答 ${unexpected.length} 条（通知不应回包）: ` + JSON.stringify(unexpected[0]).slice(0, 200));
  }

  // 清理测试存储根（同 Task 1：里面只有测试数据，不留仓库垃圾）
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 忽略 */ }
} catch (e) {
  finished = true;
  try { if (child && child.exitCode === null) child.kill(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.error('✗ canvas-mcp 契约测试异常终止：' + ((e && e.message) || e));
  process.exit(1);
}

if (errs.length) {
  console.error(`\n✗ canvas-mcp 契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ canvas-mcp MCP stdio 聚合 server：契约全部通过（31 工具，帧解析/协议分发/工具路由）');
process.exit(0);
