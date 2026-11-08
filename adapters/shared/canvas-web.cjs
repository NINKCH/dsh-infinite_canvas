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
 * 200 text/html，挂载点 `id="infinite-canvas-root"` 即探活特征子串；页内经 RPC 列项目，
 * 不复制、不重写任何 core 语义。
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
 *   --core-dir  core 入口所在目录（内含 index.js）；缺省 = 仓库根（与 host-adapter 同款解析）。
 *   --home      存储根（DSH_IC_* 注入）；缺省复用 host-adapter 默认（adapters/.tmp-home/）。
 *   --port      监听端口；缺省 3210。被画布服务占用 → 复用；被其他服务占用 → 换口 +10。
 *   --open      起服务后用平台默认浏览器打开画布 url（win32: cmd /c start "" "<url>"）。
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

// 仓库根：本文件位于 adapters/shared/，向上两级即仓库根（与 host-adapter.cjs 同款解析）。
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PORT = 3210;
const PORT_RETRY_LIMIT = 10; // EADDRINUSE 递增换口上限（+10）
const PROBE_TIMEOUT_MS = 1500;
const PANEL_PATH = '/';
// 面板挂载点特征子串：本模块自备面板页的确定性标识（core 无面板路由，见文件头契约事实）
const PANEL_MARK = 'id="infinite-canvas-root"';

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

/** 面板页：core 无面板路由（文件头契约事实），由本模块自备的状态/挂载页。 */
function panelHtml() {
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

/** 路由分发：routes（core 原样透传）+ 面板页 → http request handler。未命中 404 JSON。 */
function createDispatcher(routes) {
  const table = new Map();
  for (const r of routes) {
    if (r && r.kind === 'exact' && typeof r.path === 'string' && typeof r.handler === 'function') {
      table.set(r.path, r.handler); // core 语义一字不改：handler 直透
    }
  }
  if (!table.has(PANEL_PATH)) table.set(PANEL_PATH, (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.end(panelHtml());
  });
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
  let routes = opts.routes;
  if (!routes) {
    const coreDir = opts.coreDir ? path.resolve(String(opts.coreDir)) : REPO_ROOT;
    const { createHostAdapter } = require('./host-adapter.cjs');
    const adapter = await createHostAdapter({
      corePath: path.join(coreDir, 'index.js'),
      homeDir: opts.home ? path.resolve(String(opts.home)) : undefined,
    });
    routes = adapter.routes;
  }

  // 3) listen：EADDRINUSE → 递增换口，上限 +10；端口 0（随机）无换口语义，只试一次
  const server = http.createServer(createDispatcher(routes));
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
    coreDir: values['core-dir'] ? path.resolve(String(values['core-dir'])) : REPO_ROOT,
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
