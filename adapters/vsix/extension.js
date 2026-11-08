/**
 * 无限画布 vsix 壳（Task 6）——VS Code / CodeBuddy / Trae / Cursor 四家 VS Code 系宿主共用。
 *
 * activate 流程（brief 逐字）：探测四能力 → detect 决策 → 按路径注册工具通道 → 注册三命令。
 *   0.2.0 起另有无条件状态栏常驻入口（不依赖 adapter 构建，点击错误由命令处理器 try/catch 呈现）。
 *   能力探测（typeof 函数存在性，旧宿主缺失即 false，绝不抛错）：
 *     lmTools      = vscode.lm.registerTool 存在
 *     mcpProvider  = vscode.lm.registerMcpServerDefinitionProvider 存在
 *     cursorMcp    = vscode.cursor.mcp.registerServer 存在
 *     sampling     = vscode.lm.selectChatModels 存在
 *   决策链（lib/detect.cjs，纯逻辑单测覆盖）：lm-tools > mcp-provider > cursor-mcp > manual。
 *
 * vscode 依赖面纪律：全部 vscode 依赖只在本文件与 lib/llm-vscode.cjs；lib/detect.cjs 纯逻辑零依赖。
 *
 * API 形状依据（npm install 后的 @types/vscode d.ts 实读，详见任务报告）：
 *   - registerTool(name, tool)：tool.invoke(options, token)，args 取 options.input；
 *     结果包 LanguageModelToolResult([LanguageModelTextPart(JSON.stringify(result))])；
 *     prepareInvocation 可省（d.ts 可选成员）。d.ts 同时要求工具在 package.json
 *     `contributes.languageModelTools` 静态声明 → 生成器脚本
 *     scripts/generate-tools-contribution.mjs 从 host-adapter defs 一次性生成（core 工具面变更后重跑）。
 *   - registerMcpServerDefinitionProvider(id, provider)：provider.provideMcpServerDefinitions(token)
 *     返回 [McpStdioServerDefinition]；resolveMcpServerDefinition 可省（d.ts 可选成员）。
 *     d.ts 要求 package.json `contributes.mcpServerDefinitionProviders` 先声明同 id（已声明）。
 *   - McpStdioServerDefinition(label, command, args?, env?, version?)（1.145 d.ts L20739 构造器；
 *     cwd 不在构造器形参内故不传）。
 *   - cursor.mcp.registerServer：Cursor 专有、无 d.ts——按同款 stdio 形状尽力传入，异常仅记录
 *     降级（Task 11 实机探针后修正形状）。
 *
 * 密钥红线：所有日志 / 错误消息 / 探测报告统一过 model-bridge.redact 收口。
 * core 单例（HOST-CONTRACT.md §6）：每进程至多 createHostAdapter 一次（getAdapter 记忆 Promise），
 *   lm-tools / openCanvas / probeHost 复用同一实例；adapter 失败时清空记忆允许下次命令重试。
 */
'use strict';

const path = require('node:path');
const vscode = require('vscode');
const modelBridge = require('./shared/model-bridge.cjs');
const { detect } = require('./lib/detect.cjs');
const { createVscodeLmChannel } = require('./lib/llm-vscode.cjs');

// ---- vsix 运行时布局（sync-shared.mjs 产物，见 HOST-CONTRACT.md §11）----
const SHARED_DIR = path.join(__dirname, 'shared');
const CORE_DIR = path.join(SHARED_DIR, 'core');
const CANVAS_MCP_CJS = path.join(SHARED_DIR, 'canvas-mcp.cjs');
const CANVAS_WEB_CJS = path.join(SHARED_DIR, 'canvas-web.cjs');
const HOST_ADAPTER_CJS = path.join(SHARED_DIR, 'host-adapter.cjs');
const LLM_CHANNEL_CJS = path.join(SHARED_DIR, 'llm-channel.cjs');

const CANVAS_PORT = 3210; // brief 逐字：startWeb({port:3210})（端口被占用时 canvas-web 自动 +1 递增）
const MCP_PROVIDER_ID = 'dsh-canvas.mcp'; // 与 package.json contributes.mcpServerDefinitionProviders 同 id（d.ts 要求）
const CHANNEL_LABEL = '无限画布 (dsh-infinite-canvas)';
const MCP_ENV = { ELECTRON_RUN_AS_NODE: '1' }; // brief 逐字：宿主内置 node 跑 .cjs 的标准姿势
const MCP_ARGS = [CANVAS_MCP_CJS, '--core-dir', CORE_DIR]; // --core-dir 必传：canvas-mcp 缺省 REPO_ROOT 解析（其 ../../）在 vsix 内不成立
const STATUS_BAR_PRIORITY = 100; // 状态栏右组内的排序优先级（越大越靠左，同组常规项之上）

// ---- 模块态 ----
let outputChannel = null; // activate 创建；deactivate 随 context.subscriptions 释放
let adapterPromise = null; // §6 单例：记忆中的 createHostAdapter Promise
let currentAdapter = null; // 已建成实例（dispose 用；未建成时为 null）

/** 脱敏出口（密钥红线）：所有对外可见文本最后都过这一道。 */
function redact(s) {
  return modelBridge.redact(s);
}

/** 输出面板日志（自身过 redact；channel 在 activate 前调用时静默丢弃）。 */
function log(line) {
  try {
    if (outputChannel) outputChannel.appendLine(redact(String(line)));
  } catch { /* 输出面板异常不拖垮主流程 */ }
}

/**
 * core adapter 单例（懒建）。corePath 显式指向 vsix 内 core（sync 产物）；
 * homeDir 不传 → host-adapter 缺省（数据根裁定 Task 7 后为 ~/.dsh-infinite-canvas/，
 * env DSH_IC_HOME 可覆盖）——用户创作数据落用户目录，升级/重装不丢。
 */
function getAdapter() {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      const { createHostAdapter } = require(HOST_ADAPTER_CJS);
      const adapter = await createHostAdapter({ corePath: path.join(CORE_DIR, 'index.js') });
      currentAdapter = adapter;
      return adapter;
    })();
    // 失败清空记忆：下次命令可重试（同时避免 unhandled rejection）
    adapterPromise.catch(() => {
      adapterPromise = null;
      currentAdapter = null;
    });
  }
  return adapterPromise;
}

/** 四能力探测（brief：extension.js 从真实 vscode 命名空间探测后传入 detect）。 */
function probeCapabilities() {
  const lm = vscode.lm;
  const cursor = vscode.cursor;
  return {
    lmTools: Boolean(lm && typeof lm.registerTool === 'function'),
    mcpProvider: Boolean(lm && typeof lm.registerMcpServerDefinitionProvider === 'function'),
    cursorMcp: Boolean(cursor && cursor.mcp && typeof cursor.mcp.registerServer === 'function'),
    sampling: Boolean(lm && typeof lm.selectChatModels === 'function'),
  };
}

// ---------------- 四条工具通道路径 ----------------

/** ① lm-tools：vscode.lm.registerTool 直挂 host-adapter 的 30 个 canvas_* 工具（defs 一次收集并持有）。 */
async function registerLmToolsPath(context) {
  const adapter = await getAdapter(); // §6 单例：activate 一次收集，openCanvas 等复用
  for (const def of adapter.tools) {
    const disposable = vscode.lm.registerTool(def.name, {
      // d.ts：invoke(options: LanguageModelToolInvocationOptions<T>, token) → args = options.input；
      // 结果包 LanguageModelToolResult([text])，text = JSON.stringify(result)（brief 逐字）。
      async invoke(options) {
        const result = await def.execute(options && options.input);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(result)),
        ]);
      },
    });
    context.subscriptions.push(disposable);
  }
  context.subscriptions.push({
    dispose() {
      try {
        if (currentAdapter) currentAdapter.dispose(); // 幂等（§6）
      } catch (e) {
        log('adapter dispose 失败: ' + ((e && e.message) || e));
      }
      currentAdapter = null;
    },
  });
  log(`lm-tools 路径: 已注册 ${adapter.tools.length} 个 canvas_* 工具（vscode.lm.registerTool）`);
}

/** ② mcp-provider：动态发布 stdio MCP server 定义（command=宿主内置 node，args=vsix 内 canvas-mcp.cjs）。 */
function registerMcpProviderPath(context) {
  const definition = new vscode.McpStdioServerDefinition(
    '无限画布 MCP（dsh-infinite-canvas）',
    process.execPath,
    MCP_ARGS,
    MCP_ENV,
  );
  const disposable = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    // d.ts：provideMcpServerDefinitions(token): ProviderResult<McpServerDefinition[]>；
    // resolveMcpServerDefinition 可省（无需用户交互/认证）。
    provideMcpServerDefinitions() {
      return [definition];
    },
  });
  context.subscriptions.push(disposable);
  log('mcp-provider 路径: 已注册 MCP definition provider（id=' + MCP_PROVIDER_ID + '）');
}

/** ③ cursor-mcp：Cursor 专有 API（无 d.ts）——同款 stdio 形状尽力传入；失败只记录降级，不抛出。 */
function registerCursorMcpPath(context) {
  try {
    const disposable = vscode.cursor.mcp.registerServer({
      label: '无限画布 MCP（dsh-infinite-canvas）',
      name: 'dsh-infinite-canvas',
      command: process.execPath,
      args: MCP_ARGS,
      env: MCP_ENV,
    });
    if (disposable && typeof disposable.dispose === 'function') context.subscriptions.push(disposable);
    log('cursor-mcp 路径: 已调用 vscode.cursor.mcp.registerServer（专有 API 形状待 Task 11 实机校准）');
  } catch (e) {
    // 注册失败 ≠ 通道缺失：记录原因并引导手配（detect 已选 cursor-mcp，说明宿主声明了该 API）
    log('cursor-mcp 注册失败（落手配引导）: ' + ((e && e.stack) || e));
    vscode.window.showWarningMessage(redact('无限画布：Cursor MCP 注册失败（' + ((e && e.message) || e) + '），可在 mcp.json 手工配置（见输出面板）。'));
    showManualSnippet();
  }
}

/** mcp.json 手配片段（manual 兜底 + cursor-mcp 失败降级共用）：stdio 指向 vsix 内 canvas-mcp.cjs。 */
function mcpJsonSnippet() {
  return JSON.stringify(
    { mcpServers: { 'dsh-infinite-canvas': { command: process.execPath, args: MCP_ARGS, env: MCP_ENV } } },
    null,
    2,
  );
}

/** ④ manual：OutputChannel 展示 mcp.json 配置片段（brief 逐字）。 */
function showManualSnippet() {
  log('未检测到可用工具通道（manual）。请在宿主 mcp.json 手工加入以下配置：');
  log(mcpJsonSnippet());
  if (outputChannel) outputChannel.show(true);
}

function registerManualPath() {
  showManualSnippet();
  // 展示片段 + openSettings 引导：信息条按钮显式触发，避免每次启动弹设置页（onStartupFinished 常态激活）
  Promise.resolve(
    vscode.window.showInformationMessage(
      '无限画布：当前宿主无内置工具通道，mcp.json 手配片段已写入输出面板「' + CHANNEL_LABEL + '」。',
      '打开设置页',
    ),
  )
    .then((pick) => {
      if (pick === '打开设置页') return vscode.commands.executeCommand('dsh-canvas.openSettings');
      return undefined;
    })
    .catch(() => { /* 用户未理会按钮，正常 */ });
}

// ---------------- 三个命令（处理器全 try/catch + redact）----------------

/** WebviewPanel iframe 页（brief CSP 逐字：frame-src http://127.0.0.1:3210 http://127.0.0.1:*）。 */
function canvasFrameHtml(url) {
  const csp = "default-src 'none'; frame-src http://127.0.0.1:3210 http://127.0.0.1:*; style-src 'unsafe-inline'; img-src http://127.0.0.1:3210 http://127.0.0.1:* data:;";
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<title>无限画布</title>',
    '</head>',
    '<body style="margin:0;height:100vh;overflow:hidden">',
    '<iframe src="' + url + '" style="border:0;width:100%;height:100vh" allow="clipboard-write"></iframe>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** dsh-canvas.openCanvas：startWeb({port:3210}) → WebviewPanel iframe；创建抛错则落浏览器（brief 逐字）。 */
async function openCanvas() {
  const adapter = await getAdapter();
  // §6 单例：routes 传既有 adapter 的 routes，startWeb 不再自建（HOST-CONTRACT §8）
  const { startWeb } = require(CANVAS_WEB_CJS);
  const web = await startWeb({ port: CANVAS_PORT, routes: adapter.routes });
  const url = web.url;
  log('画布 HTTP: ' + url + (web.isReuse ? '（复用已有画布服务，未起新 server）' : ''));
  try {
    const panel = vscode.window.createWebviewPanel('dsh-canvas.canvas', '无限画布', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = canvasFrameHtml(url);
    log('画布已在 WebviewPanel 内嵌打开（iframe: ' + url + '）');
  } catch (e) {
    // brief 逐字：webview 失败自动落浏览器
    log('WebviewPanel 创建失败，落默认浏览器: ' + ((e && e.message) || e));
    await vscode.env.openExternal(vscode.Uri.parse(url));
    log('已请求默认浏览器打开 ' + url);
  }
}

/** dsh-canvas.probeHost：探测报告（多行纯文本，每行经 redact）。 */
async function probeHost() {
  const caps = probeCapabilities();
  const decision = detect(caps);
  const lines = [];

  lines.push('dsh-infinite-canvas 宿主探测报告');
  lines.push('host vscode: ' + (vscode.version || 'unknown'));
  lines.push(
    '能力: lmTools=' + caps.lmTools
    + ' mcpProvider=' + caps.mcpProvider
    + ' cursorMcp=' + caps.cursorMcp
    + ' sampling=' + caps.sampling,
  );
  lines.push('决策路径: ' + decision.path);

  // selectChatModels 模型 id 清单
  let modelIds = '（selectChatModels 不可用）';
  if (caps.sampling) {
    try {
      const models = (await vscode.lm.selectChatModels()) || [];
      modelIds = models.map((m) => m && m.id).filter(Boolean).join(', ') || '（无模型）';
    } catch (e) {
      modelIds = '（selectChatModels 失败: ' + redact((e && e.message) || e) + '）';
    }
  }
  lines.push('vscode.lm 模型: ' + modelIds);

  // Task 5 probeChannels：vscodeLm 注入（vsix 壳语义）；bridge 静默 discoverHosts；
  // sampling 不注入并以 'n/a' 呈现（进程内语义——文本生成由 vscode-lm 承载）；byok=false。
  const { probeChannels } = require(LLM_CHANNEL_CJS);
  const channels = { vscodeLm: await createVscodeLmChannel(vscode) };
  try {
    const discovered = modelBridge.discoverHosts(); // 缺省静默（§9 Ruling）
    const lists = [
      discovered && Array.isArray(discovered.workbuddy) ? discovered.workbuddy : [],
      discovered && Array.isArray(discovered.qoder) ? discovered.qoder : [],
      discovered && Array.isArray(discovered.cursor) ? discovered.cursor : [],
    ];
    const first = lists.find((l) => l.length > 0) || []; // §10：第一个非空 host（workbuddy > qoder > cursor）
    channels.bridge = { available: first, chat: modelBridge.chat };
  } catch (e) {
    log('bridge 探测失败（按不可用处理）: ' + redact((e && e.message) || e));
    channels.bridge = { available: [], chat: modelBridge.chat };
  }
  channels.byok = { available: false };
  const probe = probeChannels(channels);
  probe.sampling = 'n/a'; // 进程内语义（brief 逐字）：MCP server→client sampling 不适用于 vsix 进程
  lines.push('通道探测: ' + JSON.stringify(probe));
  lines.push('（sampling=n/a：进程内语义；byok=false：宿主侧 llm 服务不在假 ctx 内）');

  // 每行经 model-bridge redact（Review Focus #3：probeHost 输出脱敏）
  const report = lines.map((l) => redact(l)).join('\n');
  log('--- probeHost ---');
  log(report);
  log('--- probeHost 结束 ---');
  if (outputChannel) outputChannel.show(true);
  vscode.window.showInformationMessage('无限画布：宿主探测报告已写入输出面板「' + CHANNEL_LABEL + '」。');
}

/** dsh-canvas.openSettings：打开画布设置页。实现从简（brief 允许）：openCanvas + 提示消息。 */
async function openSettings() {
  await openCanvas();
  vscode.window.showInformationMessage('无限画布：已打开画布页，画布设置区在页面内（openSettings 从简实现）。');
}

// ---------------- activate / deactivate ----------------

async function activate(context) {
  outputChannel = vscode.window.createOutputChannel(CHANNEL_LABEL);
  context.subscriptions.push(outputChannel);
  log('无限画布壳激活（dsh-infinite-canvas@0.2.0）');

  // 状态栏常驻入口（0.2.0）：**无条件 show()**——按钮必须在任何窗口可见（含空白/受限窗口），
  // 不依赖 adapter 构建成功；点击后的错误由 openCanvas 命令处理器 try/catch 呈现。
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
  statusBar.text = '$(browser) 画布';
  statusBar.tooltip = '打开无限画布';
  statusBar.command = 'dsh-canvas.openCanvas';
  statusBar.show();
  context.subscriptions.push(statusBar); // dispose 随扩展释放

  const capabilities = probeCapabilities();
  const decision = detect(capabilities);
  log(
    '能力探测: lmTools=' + capabilities.lmTools
    + ' mcpProvider=' + capabilities.mcpProvider
    + ' cursorMcp=' + capabilities.cursorMcp
    + ' sampling=' + capabilities.sampling,
  );
  log('工具通道决策: ' + decision.path);

  // 路径注册失败不拖垮命令注册（命令仍可用，可经 probeHost 诊断）
  try {
    if (decision.path === 'lm-tools') await registerLmToolsPath(context);
    else if (decision.path === 'mcp-provider') registerMcpProviderPath(context);
    else if (decision.path === 'cursor-mcp') registerCursorMcpPath(context);
    else registerManualPath();
  } catch (e) {
    const msg = redact((e && e.message) || e);
    log('工具通道注册失败: ' + ((e && e.stack) || msg));
    vscode.window.showErrorMessage('无限画布：工具通道注册失败（' + msg + '），可运行「无限画布: 探测宿主能力」诊断。');
  }

  // 三命令注册（每个命令处理器包一层 try/catch，错误走 showErrorMessage + OutputChannel，经 redact）
  const handlers = {
    'dsh-canvas.openCanvas': openCanvas,
    'dsh-canvas.probeHost': probeHost,
    'dsh-canvas.openSettings': openSettings,
  };
  for (const [id, handler] of Object.entries(handlers)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args) => {
        try {
          return await handler(...args);
        } catch (e) {
          const msg = redact((e && e.message) || e);
          log('命令 ' + id + ' 失败: ' + ((e && e.stack) || msg));
          vscode.window.showErrorMessage('无限画布：' + msg);
          return undefined;
        }
      }),
    );
  }
}

function deactivate() {
  adapterPromise = null;
  if (currentAdapter) {
    try {
      currentAdapter.dispose(); // 幂等（§6）
    } catch { /* deactivate 不抛 */ }
    currentAdapter = null;
  }
}

module.exports = { activate, deactivate };
