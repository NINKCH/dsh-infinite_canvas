/**
 * 自定义媒体供应商适配器（Host 侧权威实现，0.22）
 *
 * 设计目标（对标 Toonflow 的“AI 生成一个供应商文件”能力，但适配本插件的
 * Node Host + 原生对话）：
 *  - 一个 `.js` 文件同时声明供应商/模型/配置字段，并可实现 generateImage /
 *    generateVideo 的任意请求、上传、轮询逻辑；
 *  - 元数据必须是可 JSON 化的对象字面量，便于设置页/对话工具直接展示；
 *  - 生成函数在 node:vm 中执行，不提供 require/import/process/fs；网络只能通过
 *    ctx.fetch（宿主注入的 fetch，执行时会叠加取消信号与超时）；
 *  - 返回值统一归一化为 { mediaType, type:'url'|'base64', url|data, mimeType }，
 *    由客户端继续走现有 saveAssetRecord 管线。
 *
 * 这不是强安全沙箱：用户明确导入的 AI 生成代码仍能读取自己配置的 API Key 并发
 * 网络请求（与 Toonflow 的 trusted provider 模型一致）。设置页/对话工具必须把
 * “只导入你信任的适配器”说清楚。
 */
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ID_RE = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_MEDIA_ITEMS = 8;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const FIELD_TYPES = new Set(['text', 'password', 'number', 'select', 'boolean']);
const MODEL_TYPES = new Set(['image', 'video']);
const RESERVED_IDS = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

function fail(message) { throw Object.assign(new Error(String(message || '适配器无效')), { status: 400 }); }

function stringValue(value, max, label) {
  const s = String(value == null ? '' : value).trim();
  if (!s) fail(label + '不能为空');
  if (s.length > max) fail(label + '不能超过 ' + max + ' 个字符');
  return s;
}

function optionalString(value, max, label) {
  if (value == null) return '';
  const s = String(value).trim();
  if (s.length > max) fail(label + '不能超过 ' + max + ' 个字符');
  return s;
}

function stringList(value, maxItems, maxLen, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(label + '必须是数组');
  return [...new Set(value.map((x) => String(x).trim()).filter(Boolean))].slice(0, maxItems)
    .map((x) => {
      if (x.length > maxLen) fail(label + '中的值过长');
      return x;
    });
}

function numberList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(label + '必须是数组');
  const out = [];
  for (const x of value.slice(0, 80)) {
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) fail(label + '只能包含正数');
    out.push(n);
  }
  return [...new Set(out)];
}

function normalizeField(raw, where) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(where + '字段必须是对象');
  const key = String(raw.key == null ? '' : raw.key).trim();
  if (!FIELD_KEY_RE.test(key)) fail(where + '字段 key 无效：' + key);
  const type = String(raw.type || 'text').toLowerCase();
  if (!FIELD_TYPES.has(type)) fail(where + '字段 ' + key + ' 的 type 只支持 text/password/number/select/boolean');
  const label = optionalString(raw.label, 120, where + '字段 ' + key + ' 的 label') || key;
  let defaultValue = raw.default === undefined ? (type === 'boolean' ? false : '') : raw.default;
  try {
    defaultValue = JSON.parse(JSON.stringify(defaultValue));
  } catch {
    fail(where + '字段 ' + key + ' 的 default 必须是 JSON 可序列化值');
  }
  if (defaultValue === undefined) fail(where + '字段 ' + key + ' 的 default 必须是 JSON 可序列化值');
  const out = {
    key, label, type,
    default: defaultValue,
    required: raw.required === true,
    placeholder: optionalString(raw.placeholder, 200, where + '字段 ' + key + ' 的 placeholder'),
    help: optionalString(raw.help, 500, where + '字段 ' + key + ' 的 help'),
  };
  if (type === 'select') {
    out.options = stringList(raw.options, 60, 160, where + '字段 ' + key + ' 的 options');
    if (!out.options.length) fail(where + '字段 ' + key + ' 是 select，必须提供 options');
  }
  if (type === 'number') {
    if (raw.min !== undefined && raw.min !== null && raw.min !== '') out.min = Number(raw.min);
    if (raw.max !== undefined && raw.max !== null && raw.max !== '') out.max = Number(raw.max);
    if (out.min !== undefined && !Number.isFinite(out.min)) fail(where + '字段 ' + key + ' 的 min 无效');
    if (out.max !== undefined && !Number.isFinite(out.max)) fail(where + '字段 ' + key + ' 的 max 无效');
  }
  return out;
}

function normalizeFields(raw, where) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail(where + ' fields 必须是数组');
  if (raw.length > 50) fail(where + ' fields 不能超过 50 个');
  const out = raw.map((f) => normalizeField(f, where));
  const keys = new Set();
  for (const f of out) {
    if (keys.has(f.key)) fail(where + ' fields 的 key 重复：' + f.key);
    keys.add(f.key);
  }
  return out;
}

function normalizeModel(raw, providerFields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('models 每一项必须是对象');
  const id = String(raw.id == null ? '' : raw.id).trim();
  if (!MODEL_ID_RE.test(id) || id.includes('|')) fail('模型 id 无效（不能含 |）：' + id);
  const label = stringValue(raw.label, 120, '模型 ' + id + ' 的 label');
  const type = String(raw.type || '').toLowerCase();
  if (!MODEL_TYPES.has(type)) fail('模型 ' + id + ' 的 type 只支持 image/video');
  const out = {
    id, label, type,
    modes: stringList(raw.modes, 12, 80, '模型 ' + id + ' 的 modes'),
    ratios: stringList(raw.ratios, 40, 40, '模型 ' + id + ' 的 ratios'),
    sizes: stringList(raw.sizes, 20, 40, '模型 ' + id + ' 的 sizes'),
    resolutions: stringList(raw.resolutions, 20, 40, '模型 ' + id + ' 的 resolutions'),
    durations: numberList(raw.durations, '模型 ' + id + ' 的 durations'),
    maxRefs: raw.maxRefs === undefined ? null : Math.max(0, Math.min(32, Math.round(Number(raw.maxRefs) || 0))),
    fields: normalizeFields(raw.fields, '模型 ' + id),
  };
  if (raw.audio === 'optional' || typeof raw.audio === 'boolean') out.audio = raw.audio;
  const fieldKeys = new Set(providerFields.map((f) => f.key));
  for (const f of out.fields) {
    if (fieldKeys.has(f.key)) fail('模型 ' + id + ' 的字段 ' + f.key + ' 与供应商字段重名');
  }
  return out;
}

function normalizeDefinition(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('module.exports 必须直接导出一个对象');
  const id = String(raw.id == null ? '' : raw.id).trim();
  if (!ID_RE.test(id)) fail('供应商 id 必须是小写字母开头、仅含字母数字/下划线/短横线，最长 64 字符');
  if (RESERVED_IDS.has(id.toLowerCase())) fail('供应商 id 不能使用系统保留名：' + id);
  const label = stringValue(raw.label, 120, '供应商 label');
  const version = optionalString(raw.version, 80, '供应商 version');
  const readme = optionalString(raw.readme, 20000, '供应商 readme');
  const fields = normalizeFields(raw.fields, '供应商');
  if (!Array.isArray(raw.models) || !raw.models.length) fail('models 不能为空');
  if (raw.models.length > 200) fail('models 不能超过 200 个');
  const models = raw.models.map((m) => normalizeModel(m, fields));
  const ids = new Set();
  for (const m of models) {
    if (ids.has(m.id)) fail('模型 id 重复：' + m.id);
    ids.add(m.id);
  }
  if (models.some((m) => m.type === 'image') && typeof raw.generateImage !== 'function') fail('有 image 模型时必须实现 generateImage(ctx, request)');
  if (models.some((m) => m.type === 'video') && typeof raw.generateVideo !== 'function') fail('有 video 模型时必须实现 generateVideo(ctx, request)');
  return {
    definition: raw,
    metadata: {
      id, label, version, readme, fields, models,
      revision: createHash('sha256').update(String(source)).digest('hex'),
      bytes: Buffer.byteLength(String(source), 'utf8'),
    },
  };
}

function evalDefinition(source, extraGlobals) {
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports,
    Buffer, atob, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, Blob,
    AbortController, AbortSignal, crypto: webcrypto,
    setTimeout, clearTimeout, console,
    ...(extraGlobals || {}),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const code = String(source || '').replace(/^\uFEFF/, '').replace(/\bexport\s+default\s+/, 'module.exports = ');
  vm.runInContext('"use strict";\n' + code, context, { timeout: 1500, filename: 'provider-adapter.js' });
  return module.exports;
}

export function parseProviderSource(source) {
  const text = String(source == null ? '' : source);
  if (text.length > MAX_SOURCE_BYTES) fail('适配器源码不能超过 1 MB');
  if (!text.trim()) fail('适配器源码不能为空');
  if (/^\uFEFF/.test(text)) fail('适配器源码不能带 BOM');
  const definition = evalDefinition(text);
  return normalizeDefinition(definition, text);
}

export function validateProviderSource(source) {
  try {
    const parsed = parseProviderSource(source);
    return { ok: true, provider: parsed.metadata };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('适配器目录不能是符号链接或文件');
}

function providerFile(dir, id) {
  if (!ID_RE.test(String(id || ''))) fail('供应商 id 无效');
  return path.join(dir, id + '.js');
}

function readFileEntry(file, fileName) {
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) fail('适配器文件不能是符号链接或目录');
  if (st.size > MAX_SOURCE_BYTES) fail('适配器文件不能超过 1 MB');
  const source = readFileSync(file, 'utf8');
  const parsed = parseProviderSource(source);
  if (fileName && fileName !== parsed.metadata.id + '.js') fail('适配器文件名必须与 id 一致：' + parsed.metadata.id + '.js');
  return { source, ...parsed };
}

export function listProviderAdapters(dir) {
  try { ensureDir(dir); } catch { return []; }
  const names = readdirSync(dir).filter((n) => /^[a-z][a-zA-Z0-9_-]{0,63}\.js$/.test(n)).sort();
  return names.map((fileName) => {
    try {
      const entry = readFileEntry(path.join(dir, fileName), fileName);
      return { ...entry.metadata, fileName };
    } catch (e) {
      return { id: fileName.replace(/\.js$/, ''), label: fileName, fileName, revision: '', models: [], fields: [], error: String((e && e.message) || e) };
    }
  });
}

export function getProviderAdapter(dir, id) {
  const file = providerFile(dir, id);
  if (!existsSync(file)) fail('供应商不存在：' + id);
  const entry = readFileEntry(file, id + '.js');
  return { ok: true, provider: entry.metadata, source: entry.source };
}

export function saveProviderAdapter(dir, source, opts) {
  const o = opts || {};
  ensureDir(dir);
  const parsed = parseProviderSource(source);
  const file = providerFile(dir, parsed.metadata.id);
  const exists = existsSync(file);
  if (exists && !o.overwrite) fail('供应商已存在：' + parsed.metadata.id + '（修改请显式 overwrite:true）');
  if (exists && o.revision) {
    const current = readFileEntry(file, parsed.metadata.id + '.js');
    if (current.metadata.revision !== String(o.revision)) fail('适配器已被修改，请刷新后重试');
  }
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    writeFileSync(tmp, String(source), 'utf8');
    renameSync(tmp, file);
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 清理失败无碍 */ }
  }
  return { ok: true, provider: parsed.metadata, created: !exists };
}

export function deleteProviderAdapter(dir, id, opts) {
  const o = opts || {};
  const file = providerFile(dir, id);
  if (!existsSync(file)) return { ok: true, deleted: false };
  if (o.revision) {
    const current = readFileEntry(file, id + '.js');
    if (current.metadata.revision !== String(o.revision)) fail('适配器已被修改，请刷新后重试');
  }
  rmSync(file, { force: true });
  return { ok: true, deleted: true, id };
}

function redact(value, config) {
  let text = String(value == null ? '' : value);
  const secrets = [];
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return;
    if (typeof v === 'string') { if (v.trim()) secrets.push(v.trim()); return; }
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, depth + 1); return; }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/api.?key|secret|token|password|authorization|cookie|credential|signature/i.test(k)) walk(x, depth + 1);
      }
    }
  };
  walk(config, 0);
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 3) text = text.split(secret).join('••••••');
  }
  return text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1••••••').slice(0, 4000);
}

function normalizeMedia(input, fallbackType) {
  const list = Array.isArray(input) ? input : (input == null ? [] : [input]);
  if (list.length > MAX_MEDIA_ITEMS) fail('适配器返回的媒体数量超过 ' + MAX_MEDIA_ITEMS + ' 个');
  return list.map((item) => {
    if (typeof item === 'string') {
      return { mediaType: fallbackType, type: 'url', url: item };
    }
    if (!item || typeof item !== 'object') fail('适配器返回了无效的媒体项');
    const mediaType = String(item.mediaType || fallbackType);
    if (!MODEL_TYPES.has(mediaType)) fail('适配器返回的 mediaType 无效：' + mediaType);
    if (mediaType !== fallbackType) fail('适配器返回的 mediaType（' + mediaType + '）与本次生成类型（' + fallbackType + '）不一致');
    if (item.type === 'url' || item.url) {
      const url = String(item.url || item.data || '').trim();
      let parsed = null;
      try { parsed = new URL(url); } catch { /* 下面统一报错 */ }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) fail('适配器返回的媒体 URL 必须是 HTTP(S)');
      return { mediaType, type: 'url', url };
    }
    if (item.type === 'base64' || item.type === 'binary') {
      let b64 = '';
      if (item.type === 'binary') {
        const data = item.data;
        if (Buffer.isBuffer(data)) b64 = data.toString('base64');
        // vm 里的 Uint8Array 与宿主不是同一个 intrinsic：用 ArrayBuffer.isView 做跨 realm 判定。
        else if (ArrayBuffer.isView(data)) b64 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
        else if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') b64 = Buffer.from(new Uint8Array(data)).toString('base64');
        else fail('适配器 binary 结果的 data 必须是 Uint8Array/ArrayBuffer');
      } else {
        b64 = String(item.data || '').replace(/^data:[^;]+;base64,/, '');
      }
      if (!b64) fail('适配器返回的 base64 结果为空');
      const bytes = Buffer.from(b64, 'base64');
      if (!bytes.length) fail('适配器返回的 base64 结果无效');
      if (bytes.length > MAX_MEDIA_BYTES) fail('适配器返回的媒体超过 32 MB，请优先返回 URL');
      const mimeType = String(item.mimeType || (mediaType === 'image' ? 'image/png' : 'video/mp4'));
      return { mediaType, type: 'base64', data: bytes.toString('base64'), mimeType, bytes: bytes.length };
    }
    fail('适配器返回的媒体项必须是 {type:"url"} 或 {type:"base64"}');
    return null;
  }).filter(Boolean);
}

function withTimeoutSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('适配器执行超时（' + timeoutMs + 'ms）')), timeoutMs);
  const onAbort = () => controller.abort(parent && parent.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => { clearTimeout(timer); if (parent) parent.removeEventListener('abort', onAbort); },
  };
}

async function sleepWithSignal(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0);
  if (signal && signal.aborted) throw signal.reason || new Error('已取消');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
    const onAbort = () => { cleanup(); reject(signal && signal.reason ? signal.reason : new Error('已取消')); };
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 执行适配器生成。
 * opts: { id, kind:'image'|'video', request, config, readAsset(assetId), fetchImpl, timeoutMs, signal, log }
 * 返回 { ok:true, media:[...] }；错误会抛出已被脱敏的 Error。
 */
export async function runProviderAdapter(dir, opts) {
  const o = opts || {};
  const id = String(o.id || '');
  const kind = String(o.kind || '');
  if (kind !== 'image' && kind !== 'video') fail('kind 只支持 image/video');
  const entry = getProviderAdapter(dir, id);
  const provider = entry.provider;
  const request = JSON.parse(JSON.stringify(o.request || {}));
  const modelId = String(request.model || request.modelId || '').trim();
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) fail('模型不存在：' + modelId);
  if (model.type !== kind) fail('模型 ' + modelId + ' 不是 ' + kind + ' 模型');
  const methodName = kind === 'image' ? 'generateImage' : 'generateVideo';
  const definition = parseProviderSource(entry.source).definition;
  if (typeof definition[methodName] !== 'function') fail('适配器未实现 ' + methodName);
  const config = Object.assign(Object.fromEntries(provider.fields.map((f) => [f.key, f.default])), o.config || {});
  const extraDefault = Object.fromEntries(model.fields.map((f) => [f.key, f.default]));
  request.extra = Object.assign(extraDefault, request.extra || {});
  request.model = modelId;
  request.modelId = modelId;
  const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(o.timeoutMs) || 10 * 60 * 1000));
  const timed = withTimeoutSignal(o.signal, timeoutMs);
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch;
  const combineSignal = (a, b) => (typeof AbortSignal.any === 'function' ? AbortSignal.any([a, b]) : a);
  const fetchWithSignal = (input, init) => {
    const i = init || {};
    const own = i.signal;
    const signal = own ? combineSignal(timed.signal, own) : timed.signal;
    return fetchImpl(input, { ...i, signal });
  };
  const readAsset = typeof o.readAsset === 'function' ? o.readAsset : async () => null;
  const ctx = {
    config,
    signal: timed.signal,
    fetch: fetchWithSignal,
    asset: async (assetId) => {
      const a = await readAsset(String(assetId || ''));
      if (!a) return null;
      return { type: 'binary', data: a.data, mimeType: a.mimeType || 'application/octet-stream', name: a.name || '' };
    },
    sleep: (ms) => sleepWithSignal(ms, timed.signal),
    log: (...args) => { try { if (typeof o.log === 'function') o.log(...args); } catch { /* 日志不影响生成 */ } },
    errorMessage: (value) => redact(value, config),
    tool: null,
  };
  ctx.tool = { fetch: fetchWithSignal, errorMessage: ctx.errorMessage };
  try {
    const method = definition[methodName];
    // 兼容两种写法：Toonflow 风格 generateImage(request)（上下文用 this），
    // 以及显式 generateImage(ctx, request)；按函数声明参数个数选择。
    const result = method.length >= 2
      ? await method.call(ctx, ctx, request)
      : await method.call(ctx, request);
    return { ok: true, media: normalizeMedia(result, kind), adapter: { id, model: modelId } };
  } catch (e) {
    const msg = redact((e && e.message) || e, config) || '适配器执行失败';
    const err = new Error(msg);
    if (e && e.code) err.code = e.code;
    throw err;
  } finally {
    timed.cleanup();
  }
}

/** 供回归测试直接构造一个 Provider 文件内容（不写盘）。 */
export function makeProviderSource(definition) {
  return 'module.exports = ' + JSON.stringify(definition, null, 2) + ';\n';
}

export const _internals = {
  ID_RE, FIELD_KEY_RE, MAX_SOURCE_BYTES, MAX_MEDIA_BYTES,
  evalDefinition, normalizeDefinition, normalizeMedia, redact,
};
