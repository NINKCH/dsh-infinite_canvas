/**
 * 宿主模型桥接——三家宿主（Cursor/Qoder/WorkBuddy）不向插件开放模型 API，但其本机配置文件里
 * 有**明文的官方网关模型配置**（对标 dsh-connect-workbuddy 插件先例，WorkBuddy 的
 * ~/.workbuddy/models.json 结构已实测验证）。本模块读出配置，用官方网关 URL + 官方 apiKey +
 * 宿主客户端 UA 直调 OpenAI 兼容的 /v1/chat/completions，画布文本 LLM（编剧室）即无需用户
 * 另填 key。Task 5 将本模块接入 LLM 通道编排（bridge → sampling → byok）。
 *
 * 职责单一：discover（读宿主配置）/ redact（脱敏收口）/ UA 构造（版本探测 + 纯函数）/
 * chat（非流式 OpenAI 兼容直调）。零依赖（仅 node 内置）。CommonJS：与 host-adapter /
 * canvas-mcp / canvas-web 同形态，发布物见 HOST-CONTRACT.md §5（dist/model-bridge.cjs）。
 * 无 CLI：承载进程（canvas-mcp / canvas-web / Task 5 llm 通道）经 require 调用。
 *
 * 协议自适应：真实网关是 https、测试 mock 是 http——按 url.protocol 选 node:https /
 * node:http（模块顶层同时 require 两者），不为此引入任何抽象。
 *
 * 密钥红线（本模块第一纪律，HOST-CONTRACT.md §9）：
 *   - apiKey 仅内存持有，不进仓库/日志/错误消息/工具返回/产物包；
 *   - 所有 Error.message 组装统一经 redact() 收口（网关响应体可能回显 key）；
 *   - stderr 日志函数自身也过 redact；任何把 Model 序列化出去的路径必须先过 redactModel。
 *
 * 降级纪律：discover 全程绝不抛错——文件不存在 / 坏 JSON / 非 JSON 数组 / 条目缺 url 或
 * apiKey → 跳过该条或返回空数组（宿主未登录/无配置是常态，不是异常）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

// 宿主版本缺失/非法时 UA 回退值（不冒充宿主客户端）
const FALLBACK_UA = 'dsh-bridge/0.1.0';
// chat 缺省超时（brief 语义：opts.timeout 默认 120000ms，AbortController 中止）
const DEFAULT_TIMEOUT_MS = 120000;
// 非 2xx 错误消息里响应体片段的截断上限（brief 语义：截断至 500 字符后再 redact）
const BODY_SNIPPET_MAX = 500;
// 密钥形状：sk- 后至少 8 个 [A-Za-z0-9_-]（brief 逐字）；不足 8 位不误伤
const KEY_RE = /sk-[A-Za-z0-9_-]{8,}/g;
// 「合法宿主版本」：2–4 段数字 + 可选预发布/构建后缀（如 1.2.3-beta.1）；带空白等杂字符即非法
const VERSION_RE = /^\d+(\.\d+){1,3}([-+.][0-9A-Za-z.-]+)?$/;

/** stderr 日志（统一出口，自身过 redact；只记方法名/路径/布尔，绝不记 apiKey）。 */
function log(message) {
  try {
    process.stderr.write('[model-bridge] ' + redact(String(message)) + '\n');
  } catch { /* stderr 不可用时静默（桥接失败不应拖垮宿主进程） */ }
}

/**
 * 脱敏：把文本里所有 sk-[A-Za-z0-9_-]{8,} 形状的 key 全局替换为 '[redacted]'（brief 逐字）。
 * 所有 console/error 出口（含 Error.message 组装）必须过一遍；非字符串输入先 String 化。
 */
function redact(s) {
  return String(s == null ? '' : s).replace(KEY_RE, '[redacted]');
}

/**
 * Model 的可序列化形态：apiKey 替换为字面 '[redacted]'，其余字段原样保留。
 * 任何把 Model 序列化进日志/错误/工具返回的路径必须先过它；不改动原对象。
 */
function redactModel(model) {
  if (!model || typeof model !== 'object') return model;
  return Object.assign({}, model, { apiKey: '[redacted]' });
}

/**
 * 宿主客户端 UA（纯函数，brief 逐字）：workbuddy → 'WorkBuddy/<v>'、qoder → 'QoderCN/<v>'；
 * version 缺失/非法（或宿主未知）→ 'dsh-bridge/0.1.0'。
 */
function buildUserAgent(host, version) {
  const prefix = host === 'workbuddy' ? 'WorkBuddy' : host === 'qoder' ? 'QoderCN' : null;
  if (!prefix) return FALLBACK_UA;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return FALLBACK_UA;
  return prefix + '/' + version;
}

/** 尽力而为读一个 JSON 文件的 version 字段；读不到/解析不了返回 null（绝不抛错）。 */
function readVersionField(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = parsed && parsed.version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * 宿主版本探测（尽力而为）：读已知安装目录的 product.json / package.json 的 version 字段，
 * 读不到就不给键。仅 chat 请求路径消费（经 resolveHostVersion 缓存）；测试不触发真实安装
 * 目录读取（用 opts.hostVersion 注入，只测 buildUserAgent 纯函数）。
 */
function detectHostVersions() {
  const home = os.homedir();
  const probes = {
    workbuddy: [
      path.join(home, '.workbuddy', 'product.json'),
      path.join(home, '.workbuddy', 'package.json'),
    ],
    qoder: [
      path.join(home, '.qoder-cn', 'product.json'),
      path.join(home, '.qoder-cn', 'package.json'),
    ],
  };
  const out = {};
  for (const host of Object.keys(probes)) {
    for (const file of probes[host]) {
      const v = readVersionField(file);
      if (v) { out[host] = v; break; }
    }
  }
  return out;
}

// detectHostVersions 结果的模块级缓存：版本探测在请求路径上只发生一次（brief 语义）。
let cachedHostVersions = null;

/** chat 请求路径的版本解析：opts.hostVersion 显式注入优先（测试注入用），否则探测一次并缓存。 */
function resolveHostVersion(host, override) {
  if (typeof override === 'string' && override) return override;
  if (!cachedHostVersions) cachedHostVersions = detectHostVersions();
  return cachedHostVersions[host];
}

/**
 * workbuddy 模型发现：读 models.json（结构已实测验证：
 * [{id, vendor, url, apiKey, supportsToolCall, supportsImages, supportsReasoning}]，全部走
 * 官方网关 /v1/chat/completions，OpenAI 兼容）。降级矩阵（绝不抛错）：文件不存在 / 读取失败 /
 * 坏 JSON / 非 JSON 数组 / 空数组 → []；条目缺 url 或 apiKey / 非对象条目 → 跳过。
 */
function discoverWorkbuddy(modelsFile) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  } catch {
    return []; // 文件不存在/读取失败/坏 JSON：宿主未登录或无配置是常态
  }
  if (!Array.isArray(entries)) return []; // 形状不对（如对象）：按空配置降级
  const models = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.url !== 'string' || !entry.url) continue;
    if (typeof entry.apiKey !== 'string' || !entry.apiKey) continue;
    const model = {
      host: 'workbuddy',
      id: typeof entry.id === 'string' ? entry.id : '',
      vendor: typeof entry.vendor === 'string' ? entry.vendor : '',
      url: entry.url,
      apiKey: entry.apiKey, // 仅内存持有；任何序列化出口必须先过 redactModel
    };
    if (typeof entry.supportsToolCall === 'boolean') model.supportsToolCall = entry.supportsToolCall;
    if (typeof entry.supportsImages === 'boolean') model.supportsImages = entry.supportsImages;
    if (typeof entry.supportsReasoning === 'boolean') model.supportsReasoning = entry.supportsReasoning;
    models.push(model);
  }
  return models;
}

/**
 * qoder 模型发现：目录结构 <qoderModelsDir>/<uid>/（uid 为目录名枚举）**未经验证**，
 * 首版恒返回 []（Task 11 探针后补真实解析）；目录不存在/无法解析出模型 → []。
 * 同时检测 env QODER_OPENAPI_ENDPOINT 是否存在：只记录布尔到 stderr，不发请求。
 * 探测行输出受 Task 5 Ruling 控制：仅调用方显式传 log:true 时输出（discoverHosts 缺省静默）。
 */
function discoverQoder(modelsDir, shouldLog) {
  let dirExists = false;
  try {
    dirExists = fs.existsSync(modelsDir) && fs.statSync(modelsDir).isDirectory();
  } catch {
    dirExists = false;
  }
  const hasEnvEndpoint = Boolean(process.env.QODER_OPENAPI_ENDPOINT);
  if (shouldLog) {
    log('qoder 探测: dir=' + modelsDir + ' exists=' + dirExists +
        ' QODER_OPENAPI_ENDPOINT=' + hasEnvEndpoint + '；结构未验证，首版返回 []（Task 11 补实现）');
  }
  return [];
}

/**
 * 宿主模型发现总入口（绝不抛错）。paths 测试注入：{ workbuddyModels?, qoderModelsDir? }，
 * 绝不触真实 home；缺省值：<homedir>/.workbuddy/models.json、<homedir>/.qoder-cn/.models。
 * cursor 恒 []（预留接口；后端 API 未公开、ToS 敏感）。
 * Task 5 Ruling：新增可选 { log?:boolean }，**缺省静默**（qoder 探测行不输出）；
 * canvas-mcp / llm-channel 一律静默调用，需要观测时显式传 log:true。
 */
function discoverHosts(options) {
  const opts = options || {};
  const paths = opts.paths || {};
  const shouldLog = opts.log === true; // 缺省静默（Task 5 Ruling）
  const home = os.homedir();
  const workbuddyModels = typeof paths.workbuddyModels === 'string' && paths.workbuddyModels
    ? paths.workbuddyModels
    : path.join(home, '.workbuddy', 'models.json');
  const qoderModelsDir = typeof paths.qoderModelsDir === 'string' && paths.qoderModelsDir
    ? paths.qoderModelsDir
    : path.join(home, '.qoder-cn', '.models');
  return {
    workbuddy: discoverWorkbuddy(workbuddyModels),
    qoder: discoverQoder(qoderModelsDir, shouldLog),
    cursor: [],
  };
}

/**
 * 非流式 OpenAI 兼容直调：POST model.url，body = {model: model.id, messages, ...opts.body?}
 * （messages 直接为数组；opts.timeout 缺省 120000ms，AbortController 中止）。
 * headers：content-type: application/json、authorization: Bearer <apiKey>、
 * user-agent: buildUserAgent(host, 版本)（版本经 detectHostVersions——请求路径只探测一次并
 * 缓存；opts.hostVersion 可注入覆盖，测试用它避开真实安装目录读取）。
 *
 * 响应解析：choices[0].message.content（字符串）→ {text}；usage 存在则透传。
 * 非 2xx → 抛 Error，message = '<host>/<id> HTTP <status>: ' + redact(响应体) 截断 500 字符
 * （先脱敏后截断：响应体可能回显 key，先截断会给横跨边界的 key 留残片——红线）。网络错误/
 * 超时 → 抛 Error（message 含 host/id/原因，经 redact 收口）。
 */
function chat(model, messages, opts) {
  const o = opts || {};
  if (!model || typeof model !== 'object') {
    throw new Error(redact('model-bridge chat: model 参数缺失或非对象'));
  }
  const id = (model.host || 'unknown') + '/' + (model.id || 'unknown');
  if (typeof model.url !== 'string' || !model.url) {
    throw new Error(redact('model-bridge chat: ' + id + ' 缺少 url'));
  }
  if (typeof model.apiKey !== 'string' || !model.apiKey) {
    throw new Error(redact('model-bridge chat: ' + id + ' 缺少 apiKey'));
  }
  if (!Array.isArray(messages)) {
    throw new Error(redact('model-bridge chat: ' + id + ' messages 必须为数组'));
  }
  const timeoutMs = typeof o.timeout === 'number' && Number.isFinite(o.timeout) && o.timeout > 0
    ? o.timeout
    : DEFAULT_TIMEOUT_MS;

  let urlObj;
  try {
    urlObj = new URL(model.url);
  } catch {
    throw new Error(redact('model-bridge chat: ' + id + ' url 非法: ' + model.url));
  }
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw new Error(redact('model-bridge chat: ' + id + ' 不支持的协议: ' + urlObj.protocol));
  }
  // 协议自适应：真实网关 https、测试 mock http，按 protocol 选传输层（不引入抽象）
  const transport = urlObj.protocol === 'https:' ? https : http;

  const payload = JSON.stringify(Object.assign({}, { model: model.id, messages }, o.body || {}));
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    authorization: 'Bearer ' + model.apiKey,
    'user-agent': buildUserAgent(model.host, resolveHostVersion(model.host, o.hostVersion)),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref(); // 兜底：不阻塞宿主进程退出

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } };
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };

    function onResponse(res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (e) => fail(new Error(redact(id + ' 响应读取失败: ' + ((e && e.message) || String(e))))));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          // 非 2xx：先 redact 全文、后截断至 500 字符（响应体可能回显 key——红线；若先截断，
          // 横跨边界的 key 会留下 <8 位残片逃过 {8,} 正则，评审修复）
          fail(new Error(redact(id + ' HTTP ' + status + ': ' + redact(bodyText).slice(0, BODY_SNIPPET_MAX))));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          // 同款顺序（先 redact 全文、后截断 200）：理由同上
          fail(new Error(redact(id + ' 响应非 JSON: ' + redact(bodyText).slice(0, 200))));
          return;
        }
        const choice = parsed && Array.isArray(parsed.choices) && parsed.choices[0];
        const content = choice && choice.message && choice.message.content;
        if (typeof content !== 'string') {
          fail(new Error(redact(id + ' 响应缺少 choices[0].message.content（HTTP ' + status + '）')));
          return;
        }
        const out = { text: content };
        if (parsed.usage && typeof parsed.usage === 'object') out.usage = parsed.usage;
        done(out);
      });
    }

    let req;
    try {
      req = transport.request(urlObj, { method: 'POST', headers, signal: controller.signal }, onResponse);
    } catch (e) {
      fail(new Error(redact(id + ' 请求构造失败: ' + ((e && e.message) || String(e)))));
      return;
    }
    req.on('error', (err) => {
      if (controller.signal.aborted) {
        fail(new Error(redact(id + ' 请求超时（' + timeoutMs + 'ms 无响应，已中止）')));
      } else {
        const reason = err && err.code ? err.code + ' ' + err.message : String(err);
        fail(new Error(redact(id + ' 请求失败: ' + reason)));
      }
    });
    req.end(payload);
  });
}

module.exports = {
  discoverHosts,
  redactModel,
  redact,
  buildUserAgent,
  detectHostVersions,
  chat,
};
