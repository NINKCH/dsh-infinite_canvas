/**
 * 画布 HTTP 承载——把 host-adapter 收集的 webServer 路由（9 条，全 /infinite-canvas/api/*）
 * 以普通 node:http 服务暴露给浏览器与本机进程（Qoder/WorkBuddy 等**无 Webview 宿主的唯一
 * 画布 UI 承载方式**）。
 *
 * 职责单一：路由分发（exact 匹配，routes 原样透传不改写 handler 语义）/ 探活 / 端口复用 /
 * --open 命令构造。零依赖（仅 node 内置）。CommonJS：与 host-adapter / canvas-mcp 同形态，
 * 发布物见 HOST-CONTRACT.md §5（dist/canvas-web.cjs）。
 *
 * 面板页（重要契约事实）：core（index.js L5560–5918）注册的 9 条路由全为 API，**不注册任何
 * HTML 面板路由**（Task 3 实现前探针实测 GET / → 404）。因此面板页由本模块自备：exact `/`，
 * 200 text/html，挂载点 `id="infinite-canvas-root"` 即探活特征子串。
 *
 * 真 UI 装载壳（Task 14，画布真 UI 浏览器化）：`/` 不再是状态页，而是三 script 装载壳——
 *   ① vendor React（`/infinite-canvas/api/vendor/react.production.min.js`，UMD 全局 window.React，
 *      来源 react@18.3.1，见 vendor/README.md——vendor 静态资产，非 npm 依赖）；
 *   ② `__ModuleLoader__` shim（内联：load(def) → def.factory(require)，require('react') 返回
 *      window.React，其余模块名一概抛错）；
 *   ③ client.js（`/infinite-canvas/api/client.js`，core 目录的浏览器应用，§4 RUNTIME_FILES——
 *      装载契约已实证：client.js 以 window.__ModuleLoader__.load 自装载、factory 内唯一外部
 *      require 是 react、hostRpc 自 POST /api/rpc、CTX 全守卫无 harness 时回退全屏面板）。
 * 原状态页**不删**，原样挪到 exact `/status`（探活/排错诊断页）。探活/复用语义不动（仍查 `/`
 * 的 PANEL_MARK）。两条资产路由文件在启动时一次性读入内存缓存（每请求零 IO）；client.js 基于
 * coreDir（与 core/index.js 同目录，发布布局 dist/core/、开发布局仓库根），vendor 基于
 * canvas-web.cjs 同级 vendor/ 目录（三壳发布布局同构：shared/vendor → dist/vendor / shared/vendor）。
 *
 * 端口复用语义（Review Focus #4，HOST-CONTRACT.md §8）：
 *   1) 启动前 GET http://127.0.0.1:<port>/ 探活（超时 1.5s）：200 且含面板挂载点特征子串
 *      → 已有画布服务：返回 {url, isReuse:true, server:null}，不起新 server；
 *   2) 探活失败（ECONNREFUSED / 404 / 无特征串 / 超时）→ listen；EADDRINUSE → 递增换口，
 *      上限 +10，返回实际 url。
 *
 * RPC 路由真实契约（Task 3 实现前 HTTP 实测，详见 HOST-CONTRACT.md §2.2）：请求体为原始
 * JSON `{"method":"<camelCase 名>","args":{}}`（非 JSON-RPC 2.0 信封）；方法表是 core 内部
 * 67 个 camelCase 方法（ping / projectsList / canvasCreateProject / …）。30 个 canvas_* 名是
 * 工具注册表（ctx.tools.register，走 MCP 承载），**不在 RPC 方法表里**，POST 它 → 400。
 *
 * 单例约束（HOST-CONTRACT.md §6）：每进程只 createHostAdapter 一次。进程内已有 adapter 的
 * 调用方（canvas-mcp --port、本仓库测试）必须经 options.routes 传入既有路由；只有 CLI
 * main()（进程内无 adapter）才由本模块自建。
 *
 * CLI：node canvas-web.cjs [--core-dir <path>] [--home <dir>] [--port <n>] [--open]
 *   --core-dir  core 入口所在目录（内含 index.js）；缺省按布局自解析（host-adapter.defaultCorePath）：
 *               发布布局 dist/core/ 与本文件同级优先，开发布局退仓库根。
 *   --home      存储根（DSH_IC_* 注入）；缺省复用 host-adapter 缺省（env DSH_IC_HOME ||
 *               ~/.dsh-infinite-canvas/，数据根裁定 Task 7）。
 *   --port      监听端口；缺省 3210。被画布服务占用 → 复用；被其他服务占用 → 换口 +10。
 *   --open      起服务后用平台默认浏览器打开画布 url（win32: cmd /c start "" "<url>"）。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { createHostAdapter, defaultCorePath } = require('./host-adapter.cjs');

const DEFAULT_PORT = 3210;
const PORT_RETRY_LIMIT = 10; // EADDRINUSE 递增换口上限（+10）
const PROBE_TIMEOUT_MS = 1500;
const PANEL_PATH = '/';
// 面板挂载点特征子串：本模块自备面板页的确定性标识（core 无面板路由，见文件头契约事实）
const PANEL_MARK = 'id="infinite-canvas-root"';
// 诊断页（原状态页原样挪移，Task 14）与两条真 UI 壳静态资产路由（canvas-web 自有 exact）
const STATUS_PATH = '/status';
const CLIENT_ASSET_PATH = '/infinite-canvas/api/client.js';
const VENDOR_ASSET_PATH = '/infinite-canvas/api/vendor/react.production.min.js';

/** stderr 日志（CLI 场景无 stdout 协议约束，统一走 stderr 便于与画布页输出区分）。 */
function log(message) {
  process.stderr.write('[canvas-web] ' + message + '\n');
}

/**
 * 平台「用默认浏览器打开 url」命令（brief 语义逐字）。未知平台返回 null。
 * win32 返回完整语义模板（<url> 为占位符，`start` 的第一个 "" 是窗口标题占位）；
 * darwin/linux 返回命令名，url 作为参数追加。
 */
function pickOpenCommand(platform) {
  if (platform === 'win32') return 'cmd /c start "" "<url>"';
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

/** 用 pickOpenCommand 的语义真开浏览器（仅 CLI --open 手动运行时调用；测试不触发）。 */
function openInBrowser(url, platform) {
  const cmd = pickOpenCommand(platform);
  if (!cmd) return false;
  if (platform === 'win32') {
    // 语义 cmd /c start "" "<url>" → argv 数组传参，绕开 shell 字符串转义
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  }
  return true;
}

/**
 * 真 UI 装载壳（Task 14）：三 script 齐活——vendor React UMD → __ModuleLoader__ shim →
 * client.js。挂载点 id 保持 `infinite-canvas-root`（探活特征串 PANEL_MARK 不变）。
 * shim 语义：client.js 自装载 def.factory(require)，require('react') 返回 UMD 全局 window.React，
 * 其余模块名一概抛错（client.js 唯一外部 require 是 react，已实证）。
 */
function shellHtml() {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<title>无限画布</title>',
    '<style>html,body{margin:0;height:100%;background:#111;color:#eee}</style>',
    '</head>',
    '<body>',
    '<div id="infinite-canvas-root"></div>',
    '<script src="/infinite-canvas/api/vendor/react.production.min.js"></script>',
    '<script>',
    'window.__ModuleLoader__={load:function(def){def.factory(function(name){if(name===\'react\')return window.React;throw new Error(\'unknown module: \'+name);});}};',
    '</script>',
    '<script src="/infinite-canvas/api/client.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 诊断页（Task 14 前的状态页原样挪到 /status，探活/排错用；页内经 RPC 列项目）。 */
function statusHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>无限画布 · dsh-infinite-canvas</title>',
    '<style>',
    ':root { color-scheme: dark; }',
    'body { margin: 0; font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; background: #111418; color: #d7dde6; }',
    '#infinite-canvas-root { max-width: 720px; margin: 0 auto; padding: 32px 20px; }',
    'h1 { font-size: 20px; margin: 0 0 4px; color: #fff; }',
    '.sub { color: #8b94a3; margin-bottom: 20px; }',
    'code { background: #1c2129; padding: 2px 6px; border-radius: 4px; }',
    'ul { padding-left: 20px; } li { margin: 4px 0; }',
    '.err { color: #ff8a80; }',
    '</style>',
    '</head>',
    '<body>',
    '<div id="infinite-canvas-root">',
    '<h1>无限画布（HTTP 承载）</h1>',
    '<div class="sub">adapters/shared/canvas-web.cjs · 画布操作经 MCP 工具（canvas-mcp.cjs）；本页为画布服务探活与状态页</div>',
    '<p>API 端点：<code>POST /infinite-canvas/api/rpc</code>（body：<code>{"method":"ping","args":{}}</code>）</p>',
    '<h2>项目列表</h2>',
    '<ul id="infinite-canvas-projects">加载中…</ul>',
    '</div>',
    '<script>',
    "fetch('/infinite-canvas/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'projectsList', args: {} }) })",
    '  .then((r) => r.json())',
    '  .then((list) => {',
    "    const ul = document.getElementById('infinite-canvas-projects');",
    "    ul.textContent = '';",
    "    if (!Array.isArray(list) || !list.length) { ul.textContent = '（暂无项目）'; return; }",
    '    for (const p of list) {',
    "      const li = document.createElement('li');",
    "      li.textContent = (p && (p.name || p.id || p.folder)) || JSON.stringify(p);",
    '      ul.appendChild(li);',
    '    }',
    '  })',
    '  .catch((e) => {',
    "    const ul = document.getElementById('infinite-canvas-projects');",
    "    ul.textContent = '';",
    "    const li = document.createElement('li');",
    "    li.className = 'err';",
    "    li.textContent = 'RPC 失败: ' + e;",
    '    ul.appendChild(li);',
    '  });',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * 真 UI 壳静态资产（Task 14）：client.js（core 目录，§4 RUNTIME_FILES）+ vendor React UMD
 * （canvas-web.cjs 同级 vendor/）。启动时（startWeb）一次性读入内存缓存，每请求零 IO；
 * 模块级缓存跨多次 startWeb 复用。缺文件在启动期即抛错（fail fast，不拖到首个请求）。
 */
let shellAssetsCache = null;
function loadShellAssets(coreDir) {
  if (shellAssetsCache) return shellAssetsCache;
  const clientPath = path.join(coreDir, 'client.js');
  const vendorPath = path.join(__dirname, 'vendor', 'react.production.min.js');
  try {
    shellAssetsCache = { clientJs: fs.readFileSync(clientPath), reactJs: fs.readFileSync(vendorPath) };
  } catch (e) {
    throw new Error(
      '画布真 UI 壳静态资产缺失（' + (e && e.code === 'ENOENT' ? '文件不存在' : String(e && e.message || e)) + '）: ' +
      (fs.existsSync(clientPath) ? vendorPath : clientPath) +
      '（client.js 属 §4 RUNTIME_FILES，vendor 属 canvas-web 同级 vendor/；发布布局须随包拷贝）'
    );
  }
  return shellAssetsCache;
}

/** 探活：GET http://127.0.0.1:<port>/ 是否为已有画布服务（200 + 面板特征子串）。永不 reject。 */
function probeCanvasService(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: PANEL_PATH, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
        if (body.length > 64e3) req.destroy(); // 足够判特征串即可，不无界读
      });
      res.on('end', () => done(res.statusCode === 200 && body.includes(PANEL_MARK)));
      res.on('error', () => done(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false)); // ECONNREFUSED / 其余连接错误 → 非画布服务
  });
}

/** JS 静态资产响应（text/javascript + no-cache，防升级后浏览器拿旧缓存）。 */
function serveJs(buffer) {
  return (req, res) => {
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.end(buffer);
  };
}

/**
 * 路由分发：routes（core 原样透传）+ 真 UI 壳（/）+ 诊断页（/status）+ 两条静态资产路由
 * （Task 14，canvas-web 自有 exact）→ http request handler。未命中 404 JSON。
 * 本模块自有路由一律 set-if-absent：core 万一注册同名路由时 core 语义优先（透传纪律）。
 */
function createDispatcher(routes, assets) {
  const table = new Map();
  for (const r of routes) {
    if (r && r.kind === 'exact' && typeof r.path === 'string' && typeof r.handler === 'function') {
      table.set(r.path, r.handler); // core 语义一字不改：handler 直透
    }
  }
  if (!table.has(PANEL_PATH)) table.set(PANEL_PATH, (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.end(shellHtml());
  });
  if (!table.has(STATUS_PATH)) table.set(STATUS_PATH, (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.end(statusHtml());
  });
  if (!table.has(CLIENT_ASSET_PATH)) table.set(CLIENT_ASSET_PATH, serveJs(assets.clientJs));
  if (!table.has(VENDOR_ASSET_PATH)) table.set(VENDOR_ASSET_PATH, serveJs(assets.reactJs));
  return function dispatch(req, res) {
    let pathname = req.url || '/';
    const cut = pathname.search(/[?#]/); // exact 匹配用 pathname；handler 收到的仍是原 req（自带 query）
    if (cut >= 0) pathname = pathname.slice(0, cut);
    const handler = table.get(pathname);
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'not found: ' + pathname }));
      return;
    }
    // core handler 自含错误处理（如 rpc 的 try/catch 400）；此处兜底防分发层崩 server
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        try {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json; charset=utf-8');
          }
          res.end(JSON.stringify({ error: String((e && e.message) || e) }));
        } catch { try { res.destroy(); } catch { /* 忽略 */ } }
      });
  };
}

/** listen 单端口；resolve on listening，reject 交给调用方区分 EADDRINUSE。 */
function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen({ port, host: '127.0.0.1' });
  });
}

/**
 * 启动画布 HTTP 服务（探活 → 复用 / 新起 → EADDRINUSE 换口）。
 *
 * @param {object} [options]
 * @param {string} [options.coreDir]  core 入口所在目录（仅 routes 未传时用于自建 adapter）。
 * @param {string} [options.home]     存储根（仅 routes 未传时用于自建 adapter）。
 * @param {number} [options.port]     目标端口；缺省 DEFAULT_PORT。
 * @param {Array}  [options.routes]   既有 adapter 的 routes（HOST-CONTRACT §6：进程内已有
 *                                    adapter 的调用方必须传，不要各自 create）。
 * @returns {Promise<{url: string, server: http.Server|null, isReuse: boolean}>}
 *   复用路径 {url, isReuse:true, server:null}；新起路径 {url, isReuse:false, server}。
 */
async function startWeb(options) {
  const opts = options || {};
  const basePort = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : DEFAULT_PORT;

  // 1) 探活：已有画布服务 → 复用，绝不双开
  if (await probeCanvasService(basePort, PROBE_TIMEOUT_MS)) {
    return { url: 'http://127.0.0.1:' + basePort, server: null, isReuse: true };
  }

  // 2) 新起：优先复用传入 routes；CLI 场景（进程内无 adapter）才自建（§6 单例约束）
  //    coreDir 同一解析供两条路使用：routes 未传时建 adapter、启动时读真 UI 壳静态资产（client.js）
  const coreDir = opts.coreDir ? path.resolve(String(opts.coreDir)) : path.dirname(defaultCorePath());
  let routes = opts.routes;
  if (!routes) {
    const adapter = await createHostAdapter({
      corePath: path.join(coreDir, 'index.js'),
      homeDir: opts.home ? path.resolve(String(opts.home)) : undefined,
    });
    routes = adapter.routes;
  }
  const assets = loadShellAssets(coreDir); // 启动期读入内存（缺文件此处 fail fast）

  // 3) listen：EADDRINUSE → 递增换口，上限 +10；端口 0（随机）无换口语义，只试一次
  const server = http.createServer(createDispatcher(routes, assets));
  const attempts = basePort === 0 ? 1 : PORT_RETRY_LIMIT + 1;
  for (let i = 0; i < attempts; i++) {
    try {
      await listenOnce(server, basePort + i);
      return { url: 'http://127.0.0.1:' + server.address().port, server, isReuse: false };
    } catch (e) {
      if (e && e.code !== 'EADDRINUSE') throw e;
    }
  }
  server.unref();
  try { server.close(); } catch { /* 从未 listen 成功时 close 会抛 ERR_SERVER_NOT_RUNNING，忽略 */ }
  throw new Error(`端口 ${basePort}..${basePort + PORT_RETRY_LIMIT} 均被占用（EADDRINUSE），无法启动画布 HTTP`);
}

/** CLI 参数：--core-dir / --home / --port / --open，均可缺省；strict:false 容忍多传参数。 */
function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'core-dir': { type: 'string' },
      home: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean' },
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
    open: values.open === true,
  };
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.port === undefined && cli.portRaw !== undefined) {
    log('--port 无效（' + cli.portRaw + '），回退默认端口 ' + DEFAULT_PORT);
  }
  // CLI 进程内无既有 adapter → 由 startWeb 自建（routes 未传分支，§6 单例不破坏）
  const web = await startWeb({ coreDir: cli.coreDir, home: cli.homeDir, port: cli.port });
  log('画布 HTTP: ' + web.url + (web.isReuse ? '（复用已有画布服务，未起新 server）' : ''));
  if (cli.open) {
    if (openInBrowser(web.url, process.platform)) log('已请求默认浏览器打开 ' + web.url);
    else log('当前平台（' + process.platform + '）无已知的打开浏览器命令，请手动访问 ' + web.url);
  }
}

if (require.main === module) {
  main().catch((e) => {
    log('启动失败: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}

module.exports = { startWeb, pickOpenCommand };
