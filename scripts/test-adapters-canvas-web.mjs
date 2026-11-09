#!/usr/bin/env node
/**
 * 画布 HTTP 承载（canvas-web.cjs）契约测试（dev-only，不随包发布）。
 *
 * 以进程内 require + 真实 HTTP 请求逐条断言（需求：task-3-brief.md，含 controller 勘误）：
 *  组1 面板页：startWeb 返回的 url GET /（面板路由）→ 200、text/html、含面板挂载点特征子串
 *      `id="infinite-canvas-root"`。依据：core（index.js）注册的 9 条路由全为
 *      /infinite-canvas/api/*，**无任何 HTML 面板路由**（Task 3 实现前探针实测 GET / → 404、
 *      源码逐条核对 index.js L5560–5918）；面板页由 canvas-web.cjs 自备（它是 Qoder/WorkBuddy
 *      无 Webview 宿主的唯一画布 UI 承载），特征子串即其挂载点 id，随本模块源码确定性成立。
 *  组2 RPC 路由（core 真实契约，实现前 HTTP 实测探明）：POST /infinite-canvas/api/rpc
 *      body 为**原始 JSON** `{"method":"<名>","args":{}}`（非 JSON-RPC 2.0 信封）——
 *      方法表是 core 内部 67 个 camelCase 方法（_internals.rpcMethods() 实测键集），30 个
 *      canvas_* 名是工具注册表（ctx.tools.register），**不在 RPC 方法表里**：
 *      - {"method":"projectsList","args":{}} → 200 且 JSON 可解析（Array.isArray；项目数即
 *        length，不做 {count} 字段断言——brief 原文 canvas_list_projects 是工具名，POST 它
 *        实测 400「未知操作」，按 brief「以 core 为准」勘误适配）
 *      - {"method":"ping","args":{}} → 200 且 parsed.ok === true（探活级方法）
 *      - {"method":"canvas_list_projects","args":{}} → 400（钉死「工具名≠RPC 方法」契约）
 *  组3 未命中路由 → 404 且 JSON 可解析（{error:...}）
 *  组4 端口复用（复用判定路径）：同参数二次 startWeb → isReuse===true 且 url 相同、server:null
 *  组5 EADDRINUSE 换口（换口路径）：非画布 http.createServer 占住随机端口 →
 *      startWeb({port: 占用端口}) → 成功返回、isReuse===false、实际端口 ∈ (占用端口, 占用端口+10]
 *  组5b 200 无特征串不复用（复用判定盲区补钉）：占用者返回 200 + 非面板 body（无
 *      `id="infinite-canvas-root"`）→ 探活必须判「非画布」，startWeb 不得复用
 *      （isReuse===false）且照常换口——否则外来 200 服务会被静默误复用
 *  组6 pickOpenCommand('win32'|'darwin'|'linux'|'freebsd') → 三平台命令与 null
 *      （win32 语义 `cmd /c start "" "<url>"`；全程不真的打开浏览器，--open 只测命令构造）
 *  组7 canvas-mcp --port 接线：子进程拉起 canvas-mcp.cjs --port <P3> → 面板 200+特征串、
 *      RPC ping 200、且 MCP stdio 的 initialize 仍正常应答（--port 不影响协议面）；收尾杀进程
 *  组8 画布真 UI 壳契约（Task 14，Task 15 升级为四 script）：GET / 不再是状态页而是装载壳——
 *      含 `__ModuleLoader__` shim（壳内模拟 Harness：createRoot 全屏挂载 + slots 捕获渲染函数）、
 *      含 `/infinite-canvas/api/client.js` script 标签、含
 *      `/infinite-canvas/api/vendor/react.production.min.js` 与 react-dom script 标签（四 script 齐活）、
 *      **script 相对顺序**（装载契约钉死）：react < react-dom < 内联 shim < client.js、
 *      挂载点特征串不变（组1 双条件钉死）。壳引用的三条静态资产路由（canvas-web 自有 exact）：
 *      - GET /infinite-canvas/api/client.js → 200 text/javascript 且字节数与磁盘上 core 目录的
 *        client.js 完全一致（内存缓存不改一字）
 *      - GET /infinite-canvas/api/vendor/react.production.min.js → 200 且含 React（UMD vendor）
 *      - GET /infinite-canvas/api/vendor/react-dom.production.min.js → 200 且含 ReactDOM
 *        （Task 15：壳自渲染 createRoot 必需）
 *      诊断页不删：原状态页挪到 GET /status → 200（探活/排错用）
 *  组8b startWeb 资产缺失即抛错且自建 adapter 先 dispose（Task 14 评审 Minor）：子进程内打桩
 *      createHostAdapter（计数 dispose），coreDir 指向空目录 + port:0（防本机 3210 有活画布
 *      服务走复用路径绕过资产加载）→ startWeb 必 reject（资产缺失）且 dispose 恰好一次——
 *      半初始化 adapter 不残留
 *  组8c vm 沙箱集成（Task 15 评审固化，行为级回归）：真实内联 shim（从运行中服务的面板 HTML
 *      抽取）× 真实 client.js（组8 已断言字节一致）× vendor React UMD 在 node:vm 里真实执行——
 *      正路：apply(fakeCtx) 全程完成、createRoot().render 恰 1 次且元素为合法组件元素（'main'
 *      全屏槽位）、无错误框、挂载点全屏化；错路：apply 阶段抛错（head.appendChild 抛 → 样式
 *      effect 抛）→ 错误框「画布装载失败」+ HTML 转义 + 不挂载。断言面=装载+apply 段（黑屏
 *      根因段）；React 真渲染的 DOM 表现不在 vm 面内（待实机验证）
 *
 * 存储根：单次 createHostAdapter 注入 adapters/.tmp-home/（同 Task 1/2 模式，绝不碰真实画布
 * 数据；HOST-CONTRACT §6 单例——本进程所有 startWeb 共享同一 adapter 的 routes，不各自 create）。
 * 收尾：关闭全部 server（含连接清理）、杀子进程、删临时 home，端口不残留。
 * 运行：node scripts/test-adapters-canvas-web.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { startWeb, pickOpenCommand } = require(path.join(ROOT, 'adapters', 'shared', 'canvas-web.cjs'));
const { createHostAdapter, defaultCorePath } = require(path.join(ROOT, 'adapters', 'shared', 'host-adapter.cjs'));
const MCP_SERVER = path.join(ROOT, 'adapters', 'shared', 'canvas-mcp.cjs');
const TMP_HOME = path.join(ROOT, 'adapters', '.tmp-home');
const PANEL_MARK = 'id="infinite-canvas-root"'; // 面板挂载点特征子串（依据见组1注释）
const RPC_PATH = '/infinite-canvas/api/rpc';

const errs = [];
const servers = new Set(); // 本测试起的全部 server（收尾统一关闭）
let mcpChild = null;

/** 带超时的 HTTP 请求小工具。 */
function httpHit(url, { method = 'GET', body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时（' + timeoutMs + 'ms）: ' + method + ' ' + url)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 起一个监听随机端口的 server，返回其实际端口（供占用/探活场景）。 */
async function listenRandom(server) {
  servers.add(server);
  await new Promise((ok, err) => {
    server.once('error', err);
    server.listen(0, '127.0.0.1', ok);
  });
  return server.address().port;
}

/** 收尾：关全部 server + 杀子进程 + 删临时 home。任何一步失败不掩盖主流程结果。 */
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
  if (mcpChild && mcpChild.exitCode === null) {
    try { mcpChild.kill(); } catch { /* 忽略 */ }
    await Promise.race([once(mcpChild, 'exit'), new Promise((ok) => setTimeout(ok, 5000))]);
  }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

try {
  // 单例 adapter（HOST-CONTRACT §6）：全进程只 create 一次，env 在 import core 前定格到隔离 home
  const adapter = await createHostAdapter({ homeDir: TMP_HOME });
  if (adapter.routes.length !== 9) errs.push(`createHostAdapter.routes 应为 9 条，实际 ${adapter.routes.length}`);
  const routes = adapter.routes;

  // ---------- 组1：面板页（GET / → 200 + text/html + 挂载点特征子串） ----------
  const web1 = await startWeb({ port: 32101, routes });
  if (web1.server) servers.add(web1.server);
  if (web1.isReuse !== false) errs.push(`首次 startWeb 应 isReuse===false，实际 ${web1.isReuse}`);
  if (!web1.url.startsWith('http://127.0.0.1:32101')) {
    errs.push(`首次 startWeb url 应落在请求端口 32101，实际 ${web1.url}`);
  }
  const panel = await httpHit(web1.url + '/');
  if (panel.status !== 200) errs.push(`面板路由 GET / 应 200，实际 ${panel.status}（body: ${panel.body.slice(0, 120)}）`);
  if (!String(panel.headers['content-type'] || '').includes('text/html')) {
    errs.push(`面板路由 content-type 应为 text/html，实际 ${panel.headers['content-type']}`);
  }
  if (!panel.body.includes(PANEL_MARK)) {
    errs.push(`面板页应含挂载点特征子串 "${PANEL_MARK}"（依据：core 无面板路由，面板页由 canvas-web 自备），实际前 200 字符: ${panel.body.slice(0, 200)}`);
  }
  // 组8 前置：/ 是真 UI 装载壳（Task 14 → Task 15 四 script）——vendor React + vendor ReactDOM
  // + ModuleLoader shim（壳内模拟 Harness）+ client.js；挂载点特征串不变
  if (!panel.body.includes('__ModuleLoader__')) {
    errs.push('面板页应含 __ModuleLoader__ shim（Task 14 装载契约：client.js 以 window.__ModuleLoader__.load 自装载）');
  }
  if (!panel.body.includes('<script src="/infinite-canvas/api/client.js">')) {
    errs.push('面板页应含 client.js script 标签（Task 14：壳装载 1.4MB 浏览器应用）');
  }
  if (!panel.body.includes('<script src="/infinite-canvas/api/vendor/react.production.min.js">')) {
    errs.push('面板页应含 vendor React script 标签（Task 14：client.js 唯一外部依赖 react 由 UMD 全局提供）');
  }
  // Task 15（黑屏修复）Harness 模拟特征：createRoot（壳自渲染）+ slots（捕获渲染函数）
  if (!panel.body.includes('createRoot')) {
    errs.push('面板页应含 createRoot（Task 15：壳内模拟 Harness 后由壳 ReactDOM.createRoot 全屏挂载）');
  }
  if (!panel.body.includes('slots')) {
    errs.push('面板页 shim 应含 slots 捕获逻辑（Task 15：slots.register 的渲染函数是壳挂载的数据源）');
  }
  if (!panel.body.includes('<script src="/infinite-canvas/api/vendor/react-dom.production.min.js">')) {
    errs.push('面板页应含 vendor ReactDOM script 标签（Task 15：createRoot 由 react-dom@18.3.1 UMD 全局提供）');
  }
  // Task 14 评审 Minor #3：script 相对顺序断言（装载契约钉死）——react < react-dom < 内联 shim < client.js
  {
    const iReact = panel.body.indexOf('<script src="/infinite-canvas/api/vendor/react.production.min.js">');
    const iReactDOM = panel.body.indexOf('<script src="/infinite-canvas/api/vendor/react-dom.production.min.js">');
    const iShim = panel.body.indexOf('window.__ModuleLoader__');
    const iClient = panel.body.indexOf('<script src="/infinite-canvas/api/client.js">');
    if (iReact < 0 || iReactDOM < 0 || iShim < 0 || iClient < 0) {
      errs.push(`script 顺序断言前提不成立（四个标记应齐活）: react=${iReact} react-dom=${iReactDOM} shim=${iShim} client.js=${iClient}`);
    } else if (!(iReact < iReactDOM && iReactDOM < iShim && iShim < iClient)) {
      errs.push(`script 相对顺序应 react(${iReact}) < react-dom(${iReactDOM}) < shim(${iShim}) < client.js(${iClient})——UMD 全局先落位、shim 定义装载器、client.js 自装载`);
    }
  }

  // ---------- 组2：RPC 路由（core 真实契约：原始 JSON {method,args}，camelCase 方法表） ----------
  const rpcList = await httpHit(web1.url + RPC_PATH, {
    method: 'POST',
    body: JSON.stringify({ method: 'projectsList', args: {} }),
  });
  if (rpcList.status !== 200) errs.push(`POST rpc projectsList 应 200，实际 ${rpcList.status}（body: ${rpcList.body.slice(0, 160)}）`);
  else {
    let parsed = null;
    try { parsed = JSON.parse(rpcList.body); } catch { /* 记入下方错误 */ }
    if (!Array.isArray(parsed)) {
      errs.push(`POST rpc projectsList 应返回 JSON 数组（core projectsList 实测契约），实际: ${rpcList.body.slice(0, 160)}`);
    }
  }
  const rpcPing = await httpHit(web1.url + RPC_PATH, {
    method: 'POST',
    body: JSON.stringify({ method: 'ping', args: {} }),
  });
  if (rpcPing.status !== 200) errs.push(`POST rpc ping 应 200，实际 ${rpcPing.status}`);
  else {
    let ping = null;
    try { ping = JSON.parse(rpcPing.body); } catch { /* 记入下方错误 */ }
    if (!ping || ping.ok !== true) errs.push(`POST rpc ping 应返回 {ok:true,...}，实际: ${rpcPing.body.slice(0, 160)}`);
  }
  const rpcToolName = await httpHit(web1.url + RPC_PATH, {
    method: 'POST',
    body: JSON.stringify({ method: 'canvas_list_projects', args: {} }),
  });
  if (rpcToolName.status !== 400) {
    errs.push(`POST rpc canvas_list_projects（工具名，非 RPC 方法）应 400「未知操作」，实际 ${rpcToolName.status}（body: ${rpcToolName.body.slice(0, 120)}）`);
  }

  // ---------- 组3：未命中路由 → 404 JSON ----------
  const miss = await httpHit(web1.url + '/no-such-path');
  if (miss.status !== 404) errs.push(`未命中路由应 404，实际 ${miss.status}`);
  else {
    let missJson = null;
    try { missJson = JSON.parse(miss.body); } catch { /* 记入下方错误 */ }
    if (!missJson || typeof missJson.error !== 'string') {
      errs.push(`未命中路由应返回 JSON {error:...}，实际: ${miss.body.slice(0, 160)}`);
    }
  }

  // ---------- 组4：端口复用（同参数二次 startWeb → isReuse===true 且 url 相同） ----------
  const web2 = await startWeb({ port: 32101, routes });
  if (web2.isReuse !== true) errs.push(`同参数二次 startWeb 应判定复用 isReuse===true，实际 ${web2.isReuse}`);
  if (web2.url !== web1.url) errs.push(`复用应返回原 url（${web1.url}），实际 ${web2.url}`);
  if (web2.server !== null) errs.push(`复用路径不应起新 server（应 server:null），实际 ${web2.server}`);

  // ---------- 组5：EADDRINUSE 换口（非画布服务占住端口 → 起新 server 且换下一端口） ----------
  const occupier = http.createServer((req, res) => { res.statusCode = 404; res.end('occupier'); }); // 非画布：探活 GET / 无特征串
  const occupiedPort = await listenRandom(occupier);
  const web3 = await startWeb({ port: occupiedPort, routes });
  if (web3.server) servers.add(web3.server);
  if (web3.isReuse !== false) errs.push(`占用端口的 startWeb 应起新 server（isReuse===false，探活 404 非画布），实际 ${web3.isReuse}`);
  const gotPort = Number(new URL(web3.url).port);
  if (gotPort === occupiedPort) errs.push(`EADDRINUSE 应换口：url 端口仍等于被占用端口 ${occupiedPort}`);
  if (!(gotPort > occupiedPort && gotPort <= occupiedPort + 10)) {
    errs.push(`换口应递增且上限 +10：实际端口 ${gotPort}，占用端口 ${occupiedPort}`);
  }
  const panel3 = await httpHit(web3.url + '/');
  if (panel3.status !== 200 || !panel3.body.includes(PANEL_MARK)) {
    errs.push(`换口后的新 server 面板应可用（200 + 特征串），实际 ${panel3.status}`);
  }

  // ---------- 组5b：200 无特征串不复用（复用判定的假阳性盲区补钉） ----------
  // 占用者返回 200 + 非面板 body（无 id="infinite-canvas-root"）：探活必须「状态码 + 特征串」
  // 双条件都过才判复用。若实现退化成只看 200，这个外来服务会被静默误复用（isReuse:true 且
  // url 指向别人的服务）——终审（2026-11-08）确认的测试盲区，本组钉死该分支。
  const occupier200 = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>another service, no panel mark here</body></html>');
  });
  const occupiedPort2 = await listenRandom(occupier200);
  const web3b = await startWeb({ port: occupiedPort2, routes });
  if (web3b.server) servers.add(web3b.server);
  if (web3b.isReuse !== false) errs.push(`200 无特征串的占用端口必须不复用（isReuse===false，探活需状态码+特征串双条件），实际 ${web3b.isReuse}`);
  const gotPort2 = Number(new URL(web3b.url).port);
  if (gotPort2 === occupiedPort2) errs.push(`200 无特征串应按占用处理换口：url 端口仍等于被占用端口 ${occupiedPort2}`);
  if (!(gotPort2 > occupiedPort2 && gotPort2 <= occupiedPort2 + 10)) {
    errs.push(`200 无特征串占用换口应递增且上限 +10：实际端口 ${gotPort2}，占用端口 ${occupiedPort2}`);
  }
  const panel3b = await httpHit(web3b.url + '/');
  if (panel3b.status !== 200 || !panel3b.body.includes(PANEL_MARK)) {
    errs.push(`200 无特征串占用换口后的新 server 面板应可用（200 + 特征串），实际 ${panel3b.status}`);
  }

  // ---------- 组6：pickOpenCommand 三平台命令与 null（不真开浏览器） ----------
  const expectOpen = [
    ['win32', 'cmd /c start "" "<url>"'],
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ];
  for (const [platform, cmd] of expectOpen) {
    const got = pickOpenCommand(platform);
    if (got !== cmd) errs.push(`pickOpenCommand('${platform}') 应为 "${cmd}"，实际 "${got}"`);
  }
  if (pickOpenCommand('freebsd') !== null) errs.push(`pickOpenCommand('freebsd') 应为 null，实际 "${pickOpenCommand('freebsd')}"`);
  if (pickOpenCommand('sunos') !== null) errs.push(`pickOpenCommand('sunos') 应为 null，实际 "${pickOpenCommand('sunos')}"`);

  // ---------- 组7：canvas-mcp --port 接线（面板可开、RPC 可用、stdio 协议不受影响） ----------
  const probeHold = http.createServer((req, res) => { res.statusCode = 404; res.end(); }); // 先占后放的随机端口
  const mcpPort = await listenRandom(probeHold);
  await new Promise((ok) => { probeHold.close(ok); probeHold.closeAllConnections(); });
  servers.delete(probeHold);
  mcpChild = spawn(process.execPath, [MCP_SERVER, '--home', TMP_HOME, '--port', String(mcpPort)], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mcpStderr = [];
  mcpChild.stderr.on('data', (c) => mcpStderr.push(c));
  mcpChild.on('exit', (code) => { if (code !== 0 && code !== null && code !== 1) errs.push(`canvas-mcp --port 子进程异常退出 code=${code}`); });
  // 轮询等面板就绪（core import + startWeb 异步完成）
  let mcpPanel = null;
  for (let waited = 0; waited <= 20000; waited += 300) {
    try {
      mcpPanel = await httpHit(`http://127.0.0.1:${mcpPort}/`, { timeoutMs: 2000 });
      if (mcpPanel.status === 200) break;
    } catch { /* 未就绪，继续轮询 */ }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  if (!mcpPanel || mcpPanel.status !== 200 || !mcpPanel.body.includes(PANEL_MARK)) {
    errs.push(`canvas-mcp --port 应起画布 HTTP（面板 200 + 特征串），实际 ${mcpPanel ? mcpPanel.status : '无响应'}`);
  } else {
    const mcpRpc = await httpHit(`http://127.0.0.1:${mcpPort}` + RPC_PATH, {
      method: 'POST',
      body: JSON.stringify({ method: 'ping', args: {} }),
    });
    if (mcpRpc.status !== 200) errs.push(`canvas-mcp --port 的 RPC 路由应可用（ping 200），实际 ${mcpRpc.status}`);
  }
  // stdio 协议面不受 --port 影响：initialize 仍正常应答
  const initReply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('initialize 应答超时（--port 模式）')), 15000);
    const onData = (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) { clearTimeout(timer); mcpChild.stdout.off('data', onData); resolve(msg); return; }
        } catch { /* 非完整行，忽略 */ }
      }
    };
    mcpChild.stdout.on('data', onData);
    mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  });
  if (!initReply.result || !initReply.result.serverInfo || initReply.result.serverInfo.name !== 'dsh-infinite-canvas') {
    errs.push(`--port 模式下 initialize 应仍正常应答（serverInfo.name），实际: ${JSON.stringify(initReply).slice(0, 200)}`);
  }

  // ---------- 组8：画布真 UI 壳的静态资产与诊断页（Task 14） ----------
  // client.js 路由：200 text/javascript，字节与磁盘文件一致（读文件路径基于 coreDir：
  // 与 core/index.js 同目录——开发布局退仓库根，发布布局 dist/core/，同一文件随 §4 拷贝）
  const coreDirForAssets = path.dirname(defaultCorePath());
  const clientOnDisk = path.join(coreDirForAssets, 'client.js');
  const clientAsset = await httpHit(web1.url + '/infinite-canvas/api/client.js');
  if (clientAsset.status !== 200) {
    errs.push(`GET /infinite-canvas/api/client.js 应 200，实际 ${clientAsset.status}（body: ${clientAsset.body.slice(0, 120)}）`);
  } else {
    if (!String(clientAsset.headers['content-type'] || '').includes('text/javascript')) {
      errs.push(`client.js 路由 content-type 应为 text/javascript，实际 ${clientAsset.headers['content-type']}`);
    }
    if (!fs.existsSync(clientOnDisk)) {
      errs.push('core 目录缺 client.js（§4 RUNTIME_FILES：canvas-web 壳装载的浏览器 UI 资产）: ' + clientOnDisk);
    } else {
      const diskBytes = fs.statSync(clientOnDisk).size;
      const servedBytes = Buffer.byteLength(clientAsset.body, 'utf8');
      if (servedBytes !== diskBytes) {
        errs.push(`client.js 路由字节数应与磁盘一致（内存缓存不改一字），磁盘 ${diskBytes} vs 响应 ${servedBytes}`);
      }
    }
  }
  // vendor React 路由：200 text/javascript 且含 React（UMD 全局形态，来源 react@18.3.1）
  const reactAsset = await httpHit(web1.url + '/infinite-canvas/api/vendor/react.production.min.js');
  if (reactAsset.status !== 200) {
    errs.push(`GET /infinite-canvas/api/vendor/react.production.min.js 应 200，实际 ${reactAsset.status}（body: ${reactAsset.body.slice(0, 120)}）`);
  } else {
    if (!String(reactAsset.headers['content-type'] || '').includes('text/javascript')) {
      errs.push(`vendor React 路由 content-type 应为 text/javascript，实际 ${reactAsset.headers['content-type']}`);
    }
    if (!reactAsset.body.includes('React')) {
      errs.push('vendor React 文件应含 React 全局赋值形态（UMD 构建），实际前 200 字符: ' + reactAsset.body.slice(0, 200));
    }
  }
  // vendor ReactDOM 路由（Task 15）：200 text/javascript 且含 ReactDOM（UMD 全局形态，来源 react-dom@18.3.1）
  const reactDomAsset = await httpHit(web1.url + '/infinite-canvas/api/vendor/react-dom.production.min.js');
  if (reactDomAsset.status !== 200) {
    errs.push(`GET /infinite-canvas/api/vendor/react-dom.production.min.js 应 200，实际 ${reactDomAsset.status}（body: ${reactDomAsset.body.slice(0, 120)}）`);
  } else {
    if (!String(reactDomAsset.headers['content-type'] || '').includes('text/javascript')) {
      errs.push(`vendor ReactDOM 路由 content-type 应为 text/javascript，实际 ${reactDomAsset.headers['content-type']}`);
    }
    if (!reactDomAsset.body.includes('ReactDOM')) {
      errs.push('vendor ReactDOM 文件应含 ReactDOM 全局赋值形态（UMD 构建），实际前 200 字符: ' + reactDomAsset.body.slice(0, 200));
    }
  }
  // 诊断页保留：原状态页挪到 /status（探活/排错用；探活语义仍只查 / 的特征串，不受影响）
  const statusPage = await httpHit(web1.url + '/status');
  if (statusPage.status !== 200) {
    errs.push(`GET /status 应 200（诊断页保留），实际 ${statusPage.status}`);
  } else {
    if (!String(statusPage.headers['content-type'] || '').includes('text/html')) {
      errs.push(`/status content-type 应为 text/html，实际 ${statusPage.headers['content-type']}`);
    }
    if (!statusPage.body.includes(PANEL_MARK)) {
      errs.push('/status 诊断页应保留挂载点特征子串（原状态页原样挪移）');
    }
  }

  // ---------- 组8c：vm 沙箱集成——真实内联 shim × 真实 client.js（Task 15 评审固化） ----------
  // 组8 的静态断言是自指的：shim 逻辑被改坏（桩键名改动、内联脚本转义出 SyntaxError、
  // client.js 换槽位名）时它们照常绿。本组把行为级回归钉进仓库：从运行中的服务面板 HTML
  // 抽出**真实内联 shim**，与磁盘上**真实 client.js**（组8 已断言与响应字节一致）+ **vendor
  // React UMD** 一起放进 node:vm 沙箱真实执行——
  //   正路：factory(require('react')) → desc.apply(fakeCtx) 全程完成 → createRoot().render()
  //        被调用且元素是合法 React 组件元素（全屏 'main' 槽位）→ 不出错误框；
  //   错路：apply 阶段抛错（document.head.appendChild 抛 → 样式 effect 抛 → captured.error）
  //        → 挂载点 innerHTML 显示「画布装载失败」+ HTML 转义后的错误文本 + 不执行挂载。
  // 断言面=装载+apply 段（黑屏根因段）；React 真渲染的 DOM 表现不在 vm 面内（待实机）。
  {
    const shimMatch = panel.body.match(/<script>([\s\S]*?)<\/script>/); // 面板里唯一无 src 的 <script>
    if (!shimMatch) {
      errs.push('组8c：面板 HTML 里未找到内联 shim <script> 段（壳形态被改坏？）');
    } else if (!fs.existsSync(clientOnDisk)) {
      errs.push('组8c：core 目录缺 client.js，vm 集成无法执行（§4 RUNTIME_FILES 缺失）: ' + clientOnDisk);
    } else {
      const shimJs = shimMatch[1];
      const clientSrc = fs.readFileSync(clientOnDisk, 'utf8');
      const reactSrc = fs.readFileSync(path.join(ROOT, 'adapters', 'shared', 'vendor', 'react.production.min.js'), 'utf8');

      /** 薄桩沙箱（只覆盖装载+apply 段所需的全局面）：React=vendor UMD 真源、ReactDOM 桩、
       *  DOM/存储/网络桩（fetch 恒 reject——client.js 全守卫静默，探针实证）。 */
      function makeSandbox(breakHeadAppend) {
        const timers = new Set(); // 沙箱内注册的宿主定时器（跑完统一清，防 interval 挂住测试进程）
        const mountEl = {
          style: {},
          set innerHTML(v) { st.errorBox = v; },
          get innerHTML() { return st.errorBox; },
        };
        const st = { mounted: [], errorBox: '', mountEl };
        const sandbox = {
          window: null,
          document: {
            title: '',
            head: { appendChild: breakHeadAppend ? () => { throw new Error('boom<style>&'); } : () => {} },
            body: { appendChild: () => {} },
            createElement: () => ({ style: {}, appendChild: () => {}, remove: () => {}, setAttribute: () => {} }),
            getElementById: (id) => (id === 'infinite-canvas-root' ? mountEl : null),
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            removeEventListener: () => {},
          },
          navigator: { userAgent: 'canvas-web-vm-probe', language: 'zh-CN' },
          location: { href: 'http://127.0.0.1:32101/', protocol: 'http:' },
          localStorage: {
            store: new Map(),
            getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
            setItem(k, v) { this.store.set(k, String(v)); },
            removeItem(k) { this.store.delete(k); },
            key(i) { return [...this.store.keys()][i] || null; },
            get length() { return this.store.size; },
          },
          fetch: () => Promise.reject(new Error('vm 桩：网络不可达')),
          indexedDB: { open: () => ({ onsuccess: null, onerror: null, onupgradeneeded: null }) },
          Image: function () { return { style: {}, addEventListener: () => {}, removeEventListener: () => {} }; },
          requestAnimationFrame: (cb) => setTimeout(cb, 0),
          matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
          history: { pushState: () => {}, replaceState: () => {} },
          performance: { now: () => Date.now() },
          ReactDOM: { createRoot: () => ({ render(x) { st.mounted.push(x); } }) },
          setTimeout: (fn, ms, ...a) => { const id = setTimeout(fn, ms, ...a); timers.add(id); return id; },
          setInterval: (fn, ms, ...a) => { const id = setInterval(fn, ms, ...a); timers.add(id); return id; },
          clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
          clearInterval: (id) => { timers.delete(id); clearInterval(id); },
          console,
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.self = sandbox;
        vm.createContext(sandbox); // contextify：runInContext 要求 vm.Context
        return {
          sandbox,
          st,
          run(src, name) { return vm.runInContext(src, sandbox, { filename: name }); },
          dispose() { for (const id of timers) { clearTimeout(id); clearInterval(id); } timers.clear(); },
        };
      }

      // 8c-正路：apply 全程完成、'main' 全屏槽位渲染被挂载、无错误框
      try {
        const okRun = makeSandbox(false);
        okRun.run(reactSrc, 'vendor/react.production.min.js');
        okRun.run(shimJs, 'shell-inline-shim.js');
        okRun.run(clientSrc, 'client.js');
        const mountedEl = okRun.st.mounted[okRun.st.mounted.length - 1];
        if (okRun.st.mounted.length !== 1) {
          errs.push(`组8c 正路：createRoot().render 应恰好被调 1 次，实际 ${okRun.st.mounted.length}`);
        }
        if (!mountedEl || typeof okRun.sandbox.React.isValidElement !== 'function' || !okRun.sandbox.React.isValidElement(mountedEl)) {
          errs.push('组8c 正路：render 应收到合法 React 元素（vendor React isValidElement 判定）');
        } else {
          if (typeof mountedEl.type !== 'function') {
            errs.push(`组8c 正路：挂载元素应为组件（type 为函数），实际 ${typeof mountedEl.type} ${String(mountedEl.type).slice(0, 60)}`);
          }
          if (mountedEl.props && mountedEl.props.host !== 'main') {
            errs.push(`组8c 正路：挂载元素应为全屏 'main' 槽位（props.host），实际 ${JSON.stringify(mountedEl.props && mountedEl.props.host)}`);
          }
        }
        if (okRun.st.errorBox !== '') {
          errs.push(`组8c 正路：正常装载不应出错误框，实际 innerHTML: ${String(okRun.st.errorBox).slice(0, 200)}`);
        }
        if (okRun.st.mountEl.style.cssText !== 'position:fixed;inset:0;overflow:hidden;') {
          errs.push(`组8c 正路：挂载点应被全屏化（cssText），实际 ${JSON.stringify(okRun.st.mountEl.style.cssText)}`);
        }
        okRun.dispose();
      } catch (e) {
        errs.push('组8c 正路：vm 执行抛错（shim×client.js 装载契约被改坏）: ' + ((e && e.stack) || e).toString().slice(0, 400));
      }

      // 8c-错路：apply 阶段抛错（head.appendChild 抛 → 样式 effect 抛）→ 错误框 + 转义 + 不挂载
      try {
        const badRun = makeSandbox(true);
        badRun.run(reactSrc, 'vendor/react.production.min.js');
        badRun.run(shimJs, 'shell-inline-shim.js');
        badRun.run(clientSrc, 'client.js');
        const box = badRun.st.errorBox;
        if (!box.includes('画布装载失败')) {
          errs.push(`组8c 错路：apply 抛错应显示错误框（画布装载失败），实际 innerHTML: ${String(box).slice(0, 200)}`);
        }
        if (!box.includes('boom&lt;style&gt;&amp;')) {
          errs.push(`组8c 错路：错误文本应 HTML 转义（含 boom&lt;style&gt;&amp;），实际: ${String(box).slice(0, 240)}`);
        }
        if (box.includes('boom<style>&')) {
          errs.push('组8c 错路：错误文本不得出现未转义原文（XSS 面）');
        }
        if (badRun.st.mounted.length !== 0) {
          errs.push(`组8c 错路：有错误时不得执行挂载（render 调用 ${badRun.st.mounted.length} 次）`);
        }
        badRun.dispose();
      } catch (e) {
        errs.push('组8c 错路：vm 执行抛错（错误框路径未接住 apply 抛错）: ' + ((e && e.stack) || e).toString().slice(0, 400));
      }

      // 8c-错路2（Task 16 固化 Task 15 Minor）：vendor React 缺失（不装载 reactSrc）→
      // def.factory 调用已在 try 内 → captured.error → 错误框 + 不挂载（修复前 factory 调用
      // 在 try 外，抛错直接崩掉 load() → client.js 装载脚本级失败 → 黑屏静默）
      try {
        const noReactRun = makeSandbox(false);
        noReactRun.run(shimJs, 'shell-inline-shim.js');
        noReactRun.run(clientSrc, 'client.js');
        const box2 = noReactRun.st.errorBox;
        if (!box2.includes('画布装载失败')) {
          errs.push(`组8c 错路2：React 缺失应显示错误框（factory 已挪进 try），实际 innerHTML: ${String(box2).slice(0, 200)}`);
        }
        if (noReactRun.st.mounted.length !== 0) {
          errs.push(`组8c 错路2：React 缺失不得执行挂载（render 调用 ${noReactRun.st.mounted.length} 次）`);
        }
        noReactRun.dispose();
      } catch (e) {
        errs.push('组8c 错路2：vm 执行抛错（factory-in-try 回归——抛错逃出了 load()）: ' + ((e && e.stack) || e).toString().slice(0, 400));
      }

      // 让沙箱内启动期 fetch 拒绝（内部全守卫）的微任务落定，避免污染后续组
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }

  // ---------- 组9：浅色主题 token 表 + 语言预置（Task 16 / v0.3.3） ----------
  // client.js 消费 17 个 --dsw-alias-* 主题 token 且自身无 :root 定义（真 Harness 注入）——
  // 壳 <style> 必须供齐**每一个 client.js 实际消费的 token**（清单从磁盘 client.js 现场提取，
  // 防两清单漂移）；html/body 底色换浅色（黑底终结）；语言预置 script 先于 client.js 装载
  // （底线交付：lang 预置 zh；「跟随 Harness」选项在 client.js 里无条件渲染，壳无法移除）。
  {
    const clientSrc = fs.readFileSync(clientOnDisk, 'utf8');
    const usedTokens = [...new Set(clientSrc.match(/--dsw-alias-[a-z0-9-]+/g) || [])];
    if (!usedTokens.length) errs.push('组9：client.js 里未发现 --dsw-alias-* token 消费（清单提取前提不成立）');
    for (const t of usedTokens) {
      if (!panel.body.includes(t + ':')) {
        errs.push(`组9：壳 <style> 缺 client.js 实际消费的主题 token ${t}（Harness 缺席时该变量无值，样式塌黑）`);
      }
    }
    if (!/:root\s*\{/.test(panel.body)) errs.push('组9：壳应有 :root token 表（client.js 自身无 :root 定义，token 由壳供给）');
    if (!panel.body.includes('color-scheme:light')) errs.push('组9：壳应声明 color-scheme:light（表单控件/滚动条浅色化）');
    if (/background:#111\b/.test(panel.body)) errs.push('组9：壳 html/body 底色仍是旧黑底 #111（黑底回归）');
    // 生效语言确定中文：fake ctx locale 恒 active:'zh'（hostLang 的唯一数据源）
    if (!panel.body.includes("getLocale:function(){return{active:'zh'")) {
      errs.push("组9：壳 fake ctx locale.getLocale 应恒返回 active:'zh'（生效语言中文）");
    }
    // 语言预置（底线交付）：设置 lang 预置 zh 的内联 script 必须存在且先于 client.js 装载
    const presetMark = "localStorage.setItem(K,JSON.stringify(s))";
    if (!panel.body.includes('dsh-ic:settings') || !panel.body.includes(presetMark)) {
      errs.push('组9：壳应含语言预置 script（localStorage dsh-ic:settings.lang 预置 zh，client.js 冻结无法改选项列表）');
    }
    const iPreset = panel.body.indexOf('dsh-ic:settings');
    const iClientTag = panel.body.indexOf('<script src="/infinite-canvas/api/client.js">');
    if (!(iPreset >= 0 && iClientTag > iPreset)) {
      errs.push(`组9：语言预置 script 应先于 client.js 装载（preset@${iPreset} < client.js@${iClientTag}）`);
    }
    // Task 15 评审 Minor：def.factory 调用挪进 try（vendor React 缺失路径也有错误框而非脚本崩溃）
    const iFactoryTry = panel.body.indexOf('desc=def.factory(function(name){');
    if (iFactoryTry < 0) errs.push('组9：shim 的 factory 调用形态被改写（desc=def.factory(...) 锚点丢失）');
  }

  // ---------- 组8b：startWeb 资产缺失即抛错，且自建 adapter 在抛错前 dispose（Task 14 评审 Minor） ----------
  // 子进程内打桩 createHostAdapter（计数 dispose）：canvas-web.cjs 在 require 时解构 createHostAdapter，
  // 所以先 require host-adapter.cjs 换桩、再 require canvas-web.cjs 才能截住。coreDir 指向空目录 →
  // client.js 缺失 → loadShellAssets 启动期抛错 → startWeb 必须 reject，且 dispose 恰好被调一次
  // （半初始化 adapter 不残留——0.3.0 曾直接把 adapter 扔在泄漏态）。
  {
    const probeFile = path.join(TMP_HOME, 'probe-dispose-on-throw.cjs');
    fs.mkdirSync(TMP_HOME, { recursive: true });
    fs.writeFileSync(probeFile, `
      const ha = require(${JSON.stringify(path.join(ROOT, 'adapters', 'shared', 'host-adapter.cjs'))});
      let disposed = 0;
      ha.createHostAdapter = async () => ({ routes: [], dispose() { disposed++; } });
      const cw = require(${JSON.stringify(path.join(ROOT, 'adapters', 'shared', 'canvas-web.cjs'))});
      cw.startWeb({ coreDir: ${JSON.stringify(path.join(TMP_HOME, 'no-such-core-dir'))}, port: 0 }).then(
        () => { console.log('UNEXPECTED_SUCCESS'); process.exit(1); },
        (e) => {
          if (!/缺失/.test(String((e && e.message) || e))) {
            console.log('WRONG_ERROR: ' + String((e && e.message) || e)); process.exit(1);
          }
          console.log(disposed === 1 ? 'DISPOSED_OK' : 'DISPOSED_COUNT_' + disposed);
        }
      );
    `, 'utf8');
    const probe = spawn(process.execPath, [probeFile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const probeStdout = [];
    probe.stdout.on('data', (c) => probeStdout.push(c));
    // once(events) 以 [code, signal] 数组 resolve；20s 超时回退 [undefined]（形状一致）
    const [probeExitCode] = await Promise.race([
      once(probe, 'exit'),
      new Promise((ok) => setTimeout(() => ok([undefined]), 20000)),
    ]);
    const probeOut = Buffer.concat(probeStdout).toString('utf8').trim();
    if (probeExitCode !== 0 || probeOut !== 'DISPOSED_OK') {
      errs.push(`组8b 资产缺失路径应 reject 且先 dispose 一次（DISPOSED_OK），实际 exit=${probeExitCode} stdout="${probeOut.slice(0, 200)}"`);
    }
  }

  // ---------- 收尾：stderr 不得有未处理异常堆栈 ----------
  const stderrText = Buffer.concat(mcpStderr).toString('utf8');
  if (/UnhandledPromiseRejection|Uncaught|ERR_UNHANDLED|ERR_UNCAUGHT/i.test(stderrText)) {
    errs.push('canvas-mcp --port stderr 出现未处理异常堆栈:\n' + stderrText.slice(0, 800));
  }
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
} finally {
  await cleanup();
}

if (errs.length) {
  console.error(`\n✗ canvas-web 契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ canvas-web 画布 HTTP 承载：契约全部通过（真 UI 壳四 script·顺序钉死/client.js·react·react-dom·status 路由/Harness 模拟 shim/浅色主题 token 表与语言预置（组9）/资产缺失 dispose/RPC 分发/404/端口复用/EADDRINUSE 换口/open 命令/--port 接线）');
process.exit(0);
