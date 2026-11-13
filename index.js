/**
 * Host half of the infinite-canvas bundle.
 *
 * Registers one JSON-RPC style route (`/infinite-canvas/api/rpc`) the browser
 * half calls for AI text generation (剧本 / 分镜提示词). The completion runs
 * through the Harness `llm` Service — the same providers/models the user has
 * configured for the Harness itself, no extra API key handling here.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { normalizeSkillProfile, DEFAULT_SKILL_PROFILE } from './index-core-skill-profile.js';
import { initPackBase, packInventory, allowedIds } from './skill-pack-loader.js';
import { buildSkillPack, SKILL_CATALOG, renderInventory, renderProfile } from './skill-pack.js';
import { createProduction, PRODUCTION_STAGES, PRODUCTION_STAGE_ZH } from './production.js';
import { planShotSegments } from './shot-segments.js';

/** 制作阶段机与流程闸门（0.20.0）：deps 全是本模块的函数声明（已提升，运行时才调用）。 */
const PROD = createProduction({
  projectHomeDir,
  readToolDoc,
  readDoc,
  normalizeCanvasId,
  readAssetIndexNames, // T8：预算单参考图行项要查「实体是否已有参考资产」
});

const NAME = 'infinite-canvas';
const HERE = path.dirname(fileURLToPath(import.meta.url));
initPackBase(HERE); // 技能包加载器需要知道插件根目录
/** 自动创作测试挂点（apply 内赋值）：runs=运行表引用，setRoomLlm=注入假 LLM 通道。 */
const __autoApi = { runs: null, setRoomLlm: null };

// 版本单一来源 = 当前副本的 package.json（硬编码常量曾与包版本漂移）
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || VERSION;
} catch { /* 保留默认值 */ }

// 更新检查的唯一信息源 = npm registry latest（与安装方式无关：
// npm 在线安装 / 本地 link 开发态 / 其它方式，一律走同一条逻辑）。
// 双源：官方权威 + 中国大陆镜像（registry.npmmirror.com）。按网络环境自动选源
// （探测缓存 24h），用户可在更新横幅手动覆盖（config.updateRegistry = 'auto' | 'official' | 'china'）。
const PKG_NAME = '@ninkch/dsh-infinite-canvas';
const NPM_LATEST_PATH = '/' + encodeURIComponent(PKG_NAME) + '/latest';
const NPM_REGISTRIES = {
  official: 'https://registry.npmjs.org',
  china: 'https://registry.npmmirror.com',
};
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------- 安装形态探测（用于"点击即更新"） ----------
// 受管安装 = 本副本位于某个 DSH profile 的 node_modules 下（向上找带 dsh.profile.bundles 的 package.json）。
// 开发态（目录含 .git）不受管 → 点击更新时降级为纯引导。
const PROFILE_DIR = (() => {
  if (existsSync(path.join(HERE, '.git'))) return null;
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir);
    try {
      const m = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (m && m.dsh && m.dsh.profile && Array.isArray(m.dsh.profile.bundles)) return dir;
    } catch { /* 继续向上 */ }
  }
  return null;
})();

/** 定位 pnpm：Desktop 安装布局 → 用户运行时目录 → PATH。返回 { execPath, args 前缀 } 或 null。 */
function findPnpm() {
  const candidates = [];
  try {
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'));
  } catch { /* execPath 不可用 */ }
  try {
    const runtimes = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
    for (const entry of readdirSync(runtimes)) {
      candidates.push(path.join(runtimes, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'));
    }
  } catch { /* 无运行时目录 */ }
  for (const c of candidates) {
    try { if (existsSync(c)) return { kind: 'script', node: process.execPath, script: c }; } catch { /* 跳过 */ }
  }
  try { if (existsSync('C:\\Program Files\\nodejs\\pnpm.cmd')) return { kind: 'path', command: 'pnpm' }; } catch { /* 跳过 */ }
  return { kind: 'path', command: 'pnpm' }; // 交给 spawn 兜底（PATH 上有就用）
}

/** 在 profile 目录执行 pnpm add <spec> --save-exact。opts.relaxReleaseAge → 跳过 24h 新版本冷却期。 */
/** 组装 pnpm add 参数（纯函数供回归）：registry 只认白名单值——
 *  URL 是外部输入时绝不进命令行（防注入面），非白名单一律不带参数（回落机器默认配置）。 */
function pnpmAddArgs(pnpm, spec, opts = {}) {
  const relax = opts.relaxReleaseAge ? ['--config.minimum-release-age=0'] : [];
  const reg = NPM_REGISTRIES[opts.registry] ? ['--registry', NPM_REGISTRIES[opts.registry]] : [];
  const tail = ['add', spec, '--save-exact', ...relax, ...reg];
  return pnpm.kind === 'script' ? ['--expose-internals', pnpm.script, ...tail] : tail;
}

function runPnpmAdd(pnpm, spec, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdout = [];
    const stderr = [];
    let child;
    const args = pnpmAddArgs(pnpm, spec, opts);
    try {
      child = pnpm.kind === 'script'
        ? spawn(pnpm.node, args, { cwd: PROFILE_DIR, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
        : spawn(pnpm.command, args, { cwd: PROFILE_DIR, windowsHide: true, shell: process.platform === 'win32' });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, 240000);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => stdout.push(String(d)));
    child.stderr?.on('data', (d) => stderr.push(String(d)));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stdout: stdout.join(''), stderr: String(e?.message ?? e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.join(''), stderr: stderr.join(''), ms: Date.now() - started });
    });
  });
}

/** pnpm add 成功后同步 bundles 列表（等价 DSH reconcile 的 add 分支：新依赖必须成为 bundle 层）。 */
async function ensureBundleEntry(profileDir, pkg) {
  const manifestPath = path.join(profileDir, 'package.json');
  const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const bundles = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || [];
  if (bundles.includes(pkg)) return false;
  bundles.push(pkg);
  m.dsh = { ...(m.dsh || {}), profile: { ...(m.dsh.profile || {}), bundles } };
  await fs.writeFile(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
  return true;
}

// ---------- 数据根目录（资产落盘）----------
// 配置存在 ~/.dsh/infinite-canvas/config.json：跨重装/重启稳定，绝不放进包目录。
const CONFIG_PATH = process.env.DSH_IC_CONFIG_PATH || path.join(os.homedir(), '.dsh', 'infinite-canvas', 'config.json');

/** 安全递归删除目录。
 *  **禁止用 fs.rmSync(recursive)**：本机 Node（24.x / Windows）在**中文路径**上会原生崩溃
 *  （STATUS_STACK_BUFFER_OVERRUN，直接把宿主进程带走——删一个中文名项目就能打崩 DSH）。
 *  这里逐层 readdir + unlink/rmdir，走的是不同的系统调用路径，实测稳定。 */
function rmrf(target) {
  let st;
  try { st = lstatSync(target); } catch { return; } // 不存在 = 已删干净
  if (!st.isDirectory()) {
    try { unlinkSync(target); } catch { /* 被占用则残留，无碍 */ }
    return;
  }
  let names = [];
  try { names = readdirSync(target); } catch { return; }
  for (const name of names) rmrf(path.join(target, name));
  try { rmdirSync(target); } catch { /* 被占用则残留，无碍 */ }
}

function readIcConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; }
}
function writeIcConfig(cfg) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
function dataRoot() {
  const r = readIcConfig().dataRoot;
  return (typeof r === 'string' && r.trim()) ? path.resolve(r.trim()) : null;
}

// ============================================================
// 数据目录 = 可迁移的完整数据包（换电脑拷贝整个目录 → 一键导入）
//   <root>/canvas.meta.json          清单：项目 id → 文件夹映射（文件夹按项目名）
//   <root>/projects/<项目名>/
//     project.json                   项目完整文档（节点/连线/视图/**设定集（含 assetIds 绑定）**）
//     assets.json                    资产元数据索引（id/名称/类型/rel/实体绑定/提示词）
//     image|video|audio|text/...     媒体文件
// 客户端资产记录里的 rel 保持**逻辑路径**（projects/<pid>/…）；
// Host 在读写边界做 pid→项目名 文件夹映射（physicalRel），旧记录无需重写。
// ============================================================
const DATA_META_FILE = 'canvas.meta.json';

function dataRootMetaFile() {
  const root = dataRoot();
  return root ? path.join(root, DATA_META_FILE) : null;
}
function readDataRootMeta() {
  const f = dataRootMetaFile();
  if (f) {
    try {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      if (m && typeof m === 'object' && Array.isArray(m.projects)) return m;
    } catch { /* 缺失/损坏 → 重建 */ }
  }
  return { version: 1, updatedAt: 0, projects: [] };
}
function writeDataRootMeta(meta) {
  const f = dataRootMetaFile();
  if (!f) return;
  try {
    mkdirSync(path.dirname(f), { recursive: true });
    meta.updatedAt = Date.now();
    const tmp = f + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(meta, null, 1), 'utf8');
    renameSync(tmp, f);
  } catch { /* 清单写失败不影响主存储 */ }
}
function sanitizeFolderName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)
    .replace(/[.\s]+$/, ''); // Windows 尾随点/空格会被文件系统吞掉；纯 ".." 会让 path.join 上跳一级
  return (!s || s === '.' || s === '..') ? '未命名项目' : s;
}

// ============================================================
// 提交留痕（0.20.2 能力③）：视频提交请求的脱敏 JSONL 留底
//   客户端在 onTask（submitted）/终态（done）/失败（failed）时各写一条 entry；
//   Host 统一 redact 后追加到 <项目目录>/submissions.jsonl，>500 行裁最旧。
//   红线条文（绝不落盘）：apiKey / 回调令牌 / taskQueryUrl（带签名地址）/ 素材数据——
//   entry 本身就不含这些字段，redact 再对一切字符串兜底（error 消息里可能内嵌 URL/token）。
// ============================================================
const SUBMISSION_LOG_FILE = 'submissions.jsonl';
const SUBMISSION_LOG_MAX_LINES = 500;
/** 单条文本脱敏（可单测）：sk- 密钥、带签名参数的 URL、Bearer 令牌。正常文本不受影响。 */
function redactSubmissionText(text) {
  let s = String(text ?? '');
  // 带签名参数的 URL 整体替换为 [signed-url]（X-Amz-Signature/Signature=AWS 系，sign=/token= 常见中转系）
  s = s.replace(/https?:\/\/\S+/g, (u) => (/[?&](?:X-Amz-Signature|Signature|sign|token)=/i.test(u) ? '[signed-url]' : u));
  s = s.replace(/Bearer \S+/gi, 'Bearer ***'); // 先于 sk-：Bearer 串里也可能内嵌 sk- 密钥
  s = s.replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-***');
  return s;
}
/** entry 深度脱敏：所有字符串值逐个过 redactSubmissionText（嵌套对象/数组同样处理）。 */
function redactSubmissionValue(v) {
  if (typeof v === 'string') return redactSubmissionText(v);
  if (Array.isArray(v)) return v.map(redactSubmissionValue);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = redactSubmissionValue(v[k]);
    return o;
  }
  return v;
}
/** 追加一条留痕（宿主核心实现，abs 为项目绝对目录；可单测）：
 *  - 追加 JSONL 一行（整行先深度 redact，再序列化）
 *  - 超过 500 行裁最旧（读全文重写；留痕是低频写，无需追加流优化）
 *  - 任何写失败返回 ok:false，绝不 throw（留痕不能挡住生成主链路） */
function submissionLogAppendImpl(abs, entry) {
  if (!abs) return { ok: false, error: '项目目录不可用' };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, error: '缺少 entry 对象' };
  let clean;
  try { clean = redactSubmissionValue(entry); } catch (e) { return { ok: false, error: 'redact 失败: ' + String((e && e.message) || e) }; }
  let line;
  try { line = JSON.stringify(clean); } catch (e) { return { ok: false, error: 'entry 无法序列化: ' + String((e && e.message) || e) }; }
  if (!line) return { ok: false, error: 'entry 序列化为空' };
  const file = path.join(abs, SUBMISSION_LOG_FILE);
  let lines = [];
  try {
    mkdirSync(abs, { recursive: true });
    try { lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()); } catch { /* 首次写入无文件 */ }
    lines.push(line);
    while (lines.length > SUBMISSION_LOG_MAX_LINES) lines.shift();
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  } catch (e) { return { ok: false, error: '写入失败: ' + String((e && e.message) || e) }; }
  return { ok: true, lines: lines.length, file };
}


// ============================================================
// 存储引擎 v2（0.18.0）：SQLite（node:sqlite）+ 项目文件夹落盘
//   <dataRoot>/canvas.db                元数据 + 项目文档 = 唯一事实源
//   <dataRoot>/projects/<项目>/<类型>/   媒体文件（0.18.5 起新上传一律落这里）
//   <dataRoot>/objects/<sha2>/<sha256>  历史 CAS 对象库：**只读保留**
//       ！0.18.0–0.18.4 上传的媒体在这里，删掉老用户的图/视频会 404
//       ！IC-08 已退役写路径：不再有 POST /api/object，新上传不再产生对象
//       ！删资产时仍按引用计数回收（gcObjectIfUnreferenced），避免只增不减
// node:sqlite 需要 Node ≥22.5（DSH 捆绑 Node 24 满足）；不可用时整站回退 v1 JSON 存储。
// ============================================================
const require_ = createRequire(import.meta.url);
const SQLITE = (() => { try { return require_('node:sqlite'); } catch { return null; } })();
let _db = null;       // DatabaseSync 实例（按 dataRoot 缓存）
let _dbRoot = null;
let _rpcMethods = null; // RPC 方法表（apply 时赋值；测试直接调用）

function sqlActive() { return !!SQLITE && !!dataRoot(); }
function dbFileFor(root) { return path.join(root, 'canvas.db'); }
function objectsDirFor(root) { return path.join(root, 'objects'); }
function objectAbsFor(root, sha) { return path.join(objectsDirFor(root), String(sha).slice(0, 2), String(sha)); }

function closeDb() {
  if (!_db) return;
  try { _db.close(); } catch { /* 已关闭 */ }
  _db = null;
  _dbRoot = null;
}
process.on('exit', () => { try { closeDb(); } catch { /* 忽略 */ } });

/** 打开（或复用）数据目录的 canvas.db；全新库自动执行一次性 v1 迁移。 */
function getDb() {
  const root = dataRoot();
  if (!root || !SQLITE) return null;
  if (_db && _dbRoot === root) return _db;
  closeDb();
  mkdirSync(root, { recursive: true });
  const db = new SQLITE.DatabaseSync(dbFileFor(root));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  ensureSchema(db, root);
  _db = db;
  _dbRoot = root;
  return _db;
}

function metaGet(db, k) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(k);
  return r ? r.value : null;
}
function metaSet(db, k, v) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(k, String(v));
}

function ensureSchema(db, root) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, updated_at INTEGER,
      bible_updated_at INTEGER DEFAULT 0, summary TEXT, tombstones TEXT, doc TEXT);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, project_id TEXT, episode_id TEXT,
      kind TEXT, mime TEXT, name TEXT,
      rel TEXT, sha TEXT, bytes INTEGER,
      width INTEGER, height INTEGER, duration REAL,
      prompt TEXT, category TEXT, entity TEXT, entities TEXT, node_label TEXT,
      tags TEXT, folder TEXT, merged_into TEXT,
      text TEXT, source TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_assets_proj ON assets(project_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha);
    CREATE TABLE IF NOT EXISTS bindings (asset_id TEXT, entity_id TEXT, PRIMARY KEY (asset_id, entity_id));
    CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, project_id TEXT, season INTEGER, number INTEGER, title TEXT);
  `);
  // DAM 增量列（旧库迁移）：tags = JSON 数组；folder = 用户文件夹名。
  try {
    const cols = db.prepare('PRAGMA table_info(assets)').all().map((c) => c.name);
    if (!cols.includes('tags')) db.exec('ALTER TABLE assets ADD COLUMN tags TEXT');
    if (!cols.includes('folder')) db.exec('ALTER TABLE assets ADD COLUMN folder TEXT');
    if (!cols.includes('merged_into')) db.exec('ALTER TABLE assets ADD COLUMN merged_into TEXT');
  } catch { /* 迁移失败不阻塞启动：旧库仍可用 */ }
  if (!metaGet(db, 'fts_tokenizer')) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(id UNINDEXED, name, prompt, tokenize = 'trigram')`);
      metaSet(db, 'fts_tokenizer', 'trigram'); // trigram：中文子串级全文检索（SQLite ≥3.34）
    } catch {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(id UNINDEXED, name, prompt)`);
      metaSet(db, 'fts_tokenizer', 'unicode61');
    }
  } else if (metaGet(db, 'fts_tokenizer') === 'unicode61') {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(id UNINDEXED, name, prompt)`);
  } else {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(id UNINDEXED, name, prompt, tokenize = 'trigram')`);
  }
  if (!metaGet(db, 'schema_version')) {
    // 全新库：从 v1 布局（~/.dsh 项目 JSON + 数据目录 assets.json 镜像）一次性导入
    const counts = migrateV1IntoDb(db, root);
    metaSet(db, 'schema_version', '2');
    metaSet(db, 'migrated_from', 'v1@' + new Date().toISOString());
    metaSet(db, 'migrated_counts', JSON.stringify(counts));
  }
}

/** 项目文档摘要（列表页用，避免每次列表都解析全量 doc）。类型按合并类型输出。
 *  坐标/尺寸是布局的最小事实源：对话侧只有读到 x/y/w/h，才能回答"节点在哪/是否重叠"。 */
function docSummary(d) {
  const nodes = Object.values(d.nodes || {}).map((n) => ({
    id: n.id, type: normalizeNodeType(n.type), label: (n.data && n.data.label) || '', status: (n.data && n.data.status) || 'idle',
    x: Number(n.x) || 0, y: Number(n.y) || 0, w: Number(n.w) || 0, h: Number(n.h) || 0,
  }));
  return {
    nodeIds: Object.keys(d.nodes || {}), nodes, source: d.source || 'app', canvases: canvasRegistry(d),
    // 默认画布名（缺省 '默认画布'，旧项目零迁移）与"默认画布已删除"标记（只剩子画布时）
    defaultCanvasName: defaultCanvasNameForApi(d), defaultCanvasDeleted: !defaultCanvasExists(d),
  };
}

/** v1 → v2 一次性迁移：文档按 updatedAt 新者胜合并；资产索引照抄（媒体文件原地保留，rel 指针不动——零风险迁移）。 */
function migrateV1IntoDb(db, root) {
  const counts = { projects: 0, assets: 0 };
  const insProj = db.prepare('INSERT OR REPLACE INTO projects (id, name, created_at, updated_at, bible_updated_at, summary, tombstones, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const docs = new Map();
  const consider = (d) => {
    if (!d || !d.id) return;
    const cur = docs.get(d.id);
    if (!cur || ((cur.updatedAt || 0) <= (d.updatedAt || 0))) docs.set(d.id, d);
  };
  try {
    for (const f of readdirSync(PROJECTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { consider(JSON.parse(readFileSync(path.join(PROJECTS_DIR, f), 'utf8'))); } catch { /* 损坏跳过 */ }
    }
  } catch { /* 无旧目录 */ }
  try {
    const meta = readDataRootMeta();
    for (const entry of meta.projects) {
      try { consider(JSON.parse(readFileSync(path.join(root, 'projects', entry.folder, 'project.json'), 'utf8'))); } catch { /* 跳过 */ }
    }
  } catch { /* 无镜像 */ }
  for (const d of docs.values()) {
    insProj.run(
      d.id, String(d.name || d.id).slice(0, 80), d.createdAt || 0, d.updatedAt || 0, d.bibleUpdatedAt || 0,
      JSON.stringify(docSummary(d)), JSON.stringify(d.tombstones || []), JSON.stringify(d),
    );
    counts.projects++;
  }
  try {
    const meta = readDataRootMeta();
    for (const entry of meta.projects) {
      let list = null;
      try { list = JSON.parse(readFileSync(path.join(root, 'projects', entry.folder, 'assets.json'), 'utf8')); } catch { continue; }
      if (!Array.isArray(list)) continue;
      for (const a of list) {
        if (!a || !a.id) continue;
        upsertAssetRow(db, assetRowFromRecord({ ...a, projectId: a.projectId || entry.id }));
        counts.assets++;
      }
    }
  } catch { /* 无索引 */ }
  return counts;
}

/** 客户端资产记录 → SQL 行参数（0.18 统一形状）。 */
function assetRowFromRecord(a) {
  return {
    id: String(a.id),
    project_id: String(a.projectId || ''),
    episode_id: a.episodeId ? String(a.episodeId) : null,
    kind: String(a.kind || ''),
    mime: String(a.mime || ''),
    name: String(a.name || ''),
    rel: a.rel ? String(a.rel) : null,
    sha: a.sha ? String(a.sha).toLowerCase() : null,
    bytes: Number(a.size || a.bytes || 0) || null,
    width: Number(a.width || 0) || null,
    height: Number(a.height || 0) || null,
    duration: Number(a.duration || 0) || null,
    prompt: String(a.prompt || ''),
    category: String(a.category || 'general'),
    entity: a.entity ? String(a.entity) : null,
    entities: Array.isArray(a.entities) ? JSON.stringify(a.entities) : null,
    node_label: a.nodeLabel ? String(a.nodeLabel) : null,
    tags: Array.isArray(a.tags) && a.tags.length ? JSON.stringify(a.tags.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 20)) : null,
    folder: a.folder ? String(a.folder).slice(0, 80) : null,
    merged_into: a.mergedInto ? String(a.mergedInto) : null,
    text: (a.kind === 'text' && typeof a.text === 'string') ? a.text : null,
    source: String(a.source || ''),
    created_at: Number(a.createdAt) || Date.now(),
    updated_at: Date.now(),
  };
}

/** SQL 行 → 客户端资产记录（v1 形状超集：新增 sha/episodeId）。 */
function rowToAsset(r) {
  const out = {
    id: r.id, projectId: r.project_id, kind: r.kind, mime: r.mime, name: r.name,
    createdAt: r.created_at, category: r.category || 'general', prompt: r.prompt || '', source: r.source || '',
  };
  if (r.episode_id) out.episodeId = r.episode_id;
  if (r.rel) { out.rel = r.rel; out.size = r.bytes || 0; }
  if (r.sha) { out.sha = r.sha; out.size = r.bytes || 0; }
  if (r.width) out.width = r.width;
  if (r.height) out.height = r.height;
  if (r.duration) out.duration = r.duration;
  if (r.entity) out.entity = r.entity;
  if (r.entities) { try { out.entities = JSON.parse(r.entities); } catch { /* 忽略 */ } }
  if (r.node_label) out.nodeLabel = r.node_label;
  if (r.tags) { try { const tags = JSON.parse(r.tags); if (Array.isArray(tags) && tags.length) out.tags = tags; } catch { /* 忽略 */ } }
  if (r.folder) out.folder = r.folder;
  if (r.merged_into) out.mergedInto = r.merged_into;
  if (r.text != null && r.text !== '') out.text = r.text;
  return out;
}

function syncFts(db, id, name, prompt) {
  db.prepare('DELETE FROM assets_fts WHERE id = ?').run(id);
  db.prepare('INSERT INTO assets_fts (id, name, prompt) VALUES (?, ?, ?)').run(id, String(name || ''), String(prompt || ''));
}

function upsertAssetRow(db, row) {
  db.prepare(`INSERT INTO assets (id, project_id, episode_id, kind, mime, name, rel, sha, bytes, width, height, duration, prompt, category, entity, entities, node_label, tags, folder, merged_into, text, source, created_at, updated_at)
    VALUES (@id, @project_id, @episode_id, @kind, @mime, @name, @rel, @sha, @bytes, @width, @height, @duration, @prompt, @category, @entity, @entities, @node_label, @tags, @folder, @merged_into, @text, @source, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET project_id=@project_id, episode_id=@episode_id, kind=@kind, mime=@mime, name=@name, rel=@rel, sha=@sha, bytes=@bytes,
      width=@width, height=@height, duration=@duration, prompt=@prompt, category=@category, entity=@entity, entities=@entities,
      node_label=@node_label, tags=@tags, folder=@folder, merged_into=@merged_into, text=@text, source=@source, updated_at=@updated_at`).run(row);
  syncFts(db, row.id, row.name, row.prompt);
}

/** 对象引用计数：>0 表示仍有资产引用，不可物理删除。 */
function objectRefCount(db, sha) {
  return db.prepare('SELECT COUNT(*) AS n FROM assets WHERE sha = ?').get(sha).n;
}
/** 引用归零后删除 CAS 对象（其它项目还在用就保留——内容寻址天然跨项目共享）。 */
function gcObjectIfUnreferenced(db, root, sha) {
  try {
    if (objectRefCount(db, sha) > 0) return false;
    const abs = objectAbsFor(root, sha);
    if (existsSync(abs)) unlinkSync(abs);
    return true;
  } catch { return false; }
}

/** 资产删除（SQL 模式）：行 + FTS + rel 旧文件 / sha 对象按引用计数清理。 */
function dbAssetDelete(id) {
  const db = getDb();
  const root = dataRoot();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!row) return { ok: true, deleted: false };
  db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  db.prepare('DELETE FROM assets_fts WHERE id = ?').run(id);
  if (row.sha && root) gcObjectIfUnreferenced(db, root, row.sha);
  if (row.rel && root) {
    try {
      const mapped = physicalRel(row.rel) || row.rel;
      const { abs } = safeJoin(root, mapped);
      unlinkSync(abs);
      // 派生预览文件随原文件一起删（不存在则忽略）
      for (const suffix of ['.thumb.jpg', '.poster.jpg']) {
        try { unlinkSync(abs + suffix); } catch { /* 没有就忽略 */ }
      }
    } catch { /* 已不存在视为成功 */ }
  }
  return { ok: true, deleted: true };
}

/** 资产分页查询：过滤 + keyset 游标（created_at, id）+ 中文全文检索。 */
function dbAssetsList(args) {
  const db = getDb();
  const limit = Math.min(200, Math.max(1, Number(args && args.limit) || 50));
  const where = [];
  const params = {};
  const projectId = String((args && args.projectId) || '');
  if (projectId) { where.push('project_id = @projectId'); params.projectId = projectId; }
  const category = String((args && args.category) || '');
  if (category) { where.push('category = @category'); params.category = category; }
  const kind = String((args && args.kind) || '');
  if (kind) { where.push('kind = @kind'); params.kind = kind; }
  const q = String((args && args.q) || '').trim();
  if (q) {
    if (q.length >= 3 && metaGet(db, 'fts_tokenizer') === 'trigram') {
      where.push("id IN (SELECT id FROM assets_fts WHERE assets_fts MATCH @q)");
      params.q = '"' + q.replace(/"/g, '""') + '"';
    } else {
      where.push("(name LIKE @like ESCAPE '\\' OR prompt LIKE @like ESCAPE '\\')");
      params.like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    }
  }
  let cursor = null;
  if (args && args.cursor) {
    try { cursor = JSON.parse(Buffer.from(String(args.cursor), 'base64').toString('utf8')); } catch { cursor = null; }
  }
  if (Array.isArray(cursor) && cursor.length === 2) {
    where.push('(created_at < @cAt OR (created_at = @cAt AND id < @cId))');
    params.cAt = Number(cursor[0]) || 0;
    params.cId = String(cursor[1] || '');
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS n FROM assets ' + whereSql).get(params).n;
  const rows = db.prepare('SELECT * FROM assets ' + whereSql + ' ORDER BY created_at DESC, id DESC LIMIT @limit').all({ ...params, limit: limit + 1 });
  let nextCursor = null;
  if (rows.length > limit) {
    rows.length = limit;
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64');
  }
  return { ok: true, total, items: rows.map(rowToAsset), nextCursor };
}

function dbAssetsGet(ids) {
  const db = getDb();
  const out = [];
  const get = db.prepare('SELECT * FROM assets WHERE id = ?');
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) {
    const r = get.get(String(id));
    if (r) out.push(rowToAsset(r));
  }
  return { ok: true, items: out };
}

function dbAssetNames(projectId) {
  const db = getDb();
  const rows = db.prepare('SELECT id, name FROM assets WHERE project_id = ? ORDER BY created_at DESC').all(String(projectId || ''));
  return { ok: true, names: rows.map((r) => ({ id: r.id, name: r.name })) };
}

function dbAssetCreate(a) {
  if (!a || !a.id || !a.projectId) throw new Error('需要 asset.id 与 asset.projectId');
  const db = getDb();
  const row = assetRowFromRecord(a);
  upsertAssetRow(db, row);
  return { ok: true, asset: rowToAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id)) };
}

function dbAssetUpdate(id, patch) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(String(id || ''));
  if (!row) throw new Error('资产不存在：' + id);
  const cur = rowToAsset(row);
  const merged = { ...cur };
  if (patch && patch.name !== undefined) merged.name = String(patch.name).slice(0, 80);
  if (patch && patch.category !== undefined) merged.category = String(patch.category || 'general');
  if (patch && patch.projectId !== undefined) merged.projectId = String(patch.projectId || '');
  if (patch && patch.prompt !== undefined) merged.prompt = String(patch.prompt || '');
  if (patch && patch.entity !== undefined) merged.entity = patch.entity ? String(patch.entity) : undefined;
  if (patch && patch.entities !== undefined) merged.entities = Array.isArray(patch.entities) ? patch.entities : undefined;
  if (patch && patch.nodeLabel !== undefined) merged.nodeLabel = patch.nodeLabel ? String(patch.nodeLabel) : undefined;
  if (patch && patch.tags !== undefined) merged.tags = Array.isArray(patch.tags) ? patch.tags.map(String).map((t) => t.trim()).filter(Boolean).slice(0, 20) : [];
  if (patch && patch.folder !== undefined) merged.folder = patch.folder ? String(patch.folder).slice(0, 80) : undefined;
  if (patch && patch.mergedInto !== undefined) merged.mergedInto = patch.mergedInto ? String(patch.mergedInto) : undefined;
  if (patch && patch.text !== undefined && cur.kind === 'text') merged.text = String(patch.text || '');
  upsertAssetRow(db, assetRowFromRecord({ ...merged, createdAt: cur.createdAt }));
  return { ok: true, asset: rowToAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id)) };
}

/** CAS 对象库 GC 已随写路径退役（IC-08）：新上传不再产生 objects/，历史对象由删资产时的
 *  引用计数回收（gcObjectIfUnreferenced）兜住，不需要独立的定期扫描入口。 */

function readDocOrNull(id) {
  // 工作区内嵌项目优先：文档在 <ws>/.infinite-canvas/，与数据根/SQLite 无关
  const wsf = wsDocFile(id);
  if (wsf) {
    try { return JSON.parse(readFileSync(wsf, 'utf8')); } catch { return null; }
  }
  if (sqlActive()) {
    const db = getDb();
    const row = db.prepare('SELECT doc FROM projects WHERE id = ?').get(id);
    if (!row) return null;
    try { return JSON.parse(row.doc); } catch { return null; }
  }
  try { return JSON.parse(readFileSync(projectFile(id), 'utf8')); } catch { return null; }
}
function docExists(id) {
  if (wsDocFile(id)) return !!readDocOrNull(id);
  try { projectFile(id); } catch { return false; } // 非法 id（含路径逃逸段）：一律视为不存在，不抛
  if (sqlActive()) {
    const db = getDb();
    return !!db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  }
  return existsSync(projectFile(id));
}

/** JSON 降级模式的资产分页：扫全部 assets.json 平铺 → 过滤 → offset 游标模拟（无检索）。 */
function jsonAssetsList(args) {
  const root = dataRoot();
  const items = [];
  if (root) {
    try {
      const meta = readDataRootMeta();
      for (const entry of meta.projects) {
        let list = null;
        try { list = JSON.parse(readFileSync(path.join(root, 'projects', entry.folder, 'assets.json'), 'utf8')); } catch { continue; }
        if (Array.isArray(list)) for (const a of list) { if (a && a.id) items.push({ ...a, projectId: a.projectId || entry.id }); }
      }
    } catch { /* 无目录 */ }
  }
  const projectId = String((args && args.projectId) || '');
  const kind = String((args && args.kind) || '');
  const category = String((args && args.category) || '');
  const rows = items
    .filter((a) => (!projectId || a.projectId === projectId) && (!kind || a.kind === kind) && (!category || (a.category || 'general') === category))
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  const total = rows.length;
  let start = 0;
  if (args && args.cursor) { try { start = Number(Buffer.from(String(args.cursor), 'base64').toString('utf8')) || 0; } catch { start = 0; } }
  const limit = Math.min(200, Math.max(1, Number(args && args.limit) || 50));
  const page = rows.slice(start, start + limit);
  const nextCursor = start + limit < total ? Buffer.from(String(start + limit)).toString('base64') : null;
  return Promise.resolve({ ok: true, total, items: page, nextCursor });
}
/** IC-B4：FTS 存量孤儿清理（一次性维护，幂等）。assets_fts 里 id 不在 assets 表的行 = 孤儿
 *  （0.18.0 存储重写期 DELETE FROM assets 绕过 dbAssetDelete 留下的，QA 实测 58 vs 56）。
 *  只读判断 + 显式计数返回；顺带把"在 assets 却不在 fts"的漏登行补齐（反向孤儿，同样幂等）。 */
function ftsReconcile(db) {
  const orphans = db.prepare('SELECT f.id AS id FROM assets_fts f LEFT JOIN assets a ON a.id = f.id WHERE a.id IS NULL').all().map((r) => r.id);
  const missing = db.prepare('SELECT a.id AS id FROM assets a LEFT JOIN assets_fts f ON f.id = a.id WHERE f.id IS NULL').all().map((r) => r.id);
  const del = db.prepare('DELETE FROM assets_fts WHERE id = ?');
  let removed = 0;
  const errors = [];
  for (const id of orphans) {
    try { del.run(id); removed++; } catch (e) { errors.push(id + ': ' + String((e && e.message) || e)); }
  }
  let repaired = 0;
  if (missing.length) {
    const rows = db.prepare('SELECT id, name, prompt FROM assets WHERE id IN (' + missing.map(() => '?').join(',') + ')').all(...missing);
    for (const r of rows) {
      try { syncFts(db, r.id, r.name, r.prompt); repaired++; } catch (e) { errors.push(r.id + ': ' + String((e && e.message) || e)); }
    }
  }
  return { ok: errors.length === 0, removed, repaired, fts: db.prepare('SELECT COUNT(*) AS n FROM assets_fts').get().n, assets: db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, errors };
}

/** 确保项目的物理文件夹（按项目名）与清单条目存在；改名时尽力重命名目录（被占用/冲突则保留旧文件夹）。返回文件夹名。 */
function ensureProjectFolder(pid, name) {
  const root = dataRoot();
  if (!root) return null;
  const meta = readDataRootMeta();
  const want = sanitizeFolderName(name || pid);
  let entry = meta.projects.find((p) => p.id === pid) || null;
  if (!entry) {
    let folder = want;
    let i = 2;
    while (meta.projects.some((p) => p.folder === folder)) folder = want + '-' + i++;
    entry = { id: pid, name: want, folder, createdAt: Date.now() };
    meta.projects.push(entry);
  } else {
    entry.name = want;
    if (entry.folder !== want) {
      let target = want;
      let i = 2;
      while (meta.projects.some((p) => p.folder === target && p.id !== pid)) target = want + '-' + i++;
      const from = path.join(root, 'projects', entry.folder);
      const to = path.join(root, 'projects', target);
      if (!existsSync(to)) {
        try {
          if (existsSync(from)) renameSync(from, to);
          entry.folder = target; // 目录被占用（Windows 文件锁）时保留旧文件夹，仅改清单名
        } catch { /* 保留旧文件夹 */ }
      }
    }
  }
  writeDataRootMeta(meta);
  return entry.folder;
}
/** 逻辑路径（projects/<pid>/…）→ 物理路径（projects/<项目名>/…）；无法识别时原样返回。 */
function physicalRel(logicalRel) {
  const m = /^projects\/([^/]+)(\/.*)?$/.exec(String(logicalRel || '').trim().replace(/\\/g, '/'));
  if (!m) return null;
  const meta = readDataRootMeta();
  const entry = meta.projects.find((p) => p.id === m[1]);
  return 'projects/' + (entry ? entry.folder : m[1]) + (m[2] || '');
}
/** 把项目文档镜像到数据目录（project.json，含设定集与 assetIds 绑定）；镜像失败不影响主存储。 */
function mirrorProjectToDataRoot(id, doc) {
  const root = dataRoot();
  if (!root || !id) return;
  try {
    const folder = ensureProjectFolder(id, (doc && doc.name) || id);
    if (!folder) return;
    const dir = path.join(root, 'projects', folder);
    mkdirSync(dir, { recursive: true });
    const out = {
      id, name: (doc && doc.name) || id,
      createdAt: (doc && doc.createdAt) || null,
      updatedAt: (doc && doc.updatedAt) || Date.now(), // 用文档自身的时间戳：导入时"新者胜"比较才有意义
      nodes: (doc && doc.nodes) || {},
      edges: (doc && doc.edges) || [],
      view: (doc && doc.view) || null,
      tombstones: (doc && doc.tombstones) || [],
      edgeTombstones: (doc && doc.edgeTombstones) || [],
      bible: (doc && doc.bible) || null,           // 设定集（角色/场景/道具条目含 assetIds 资产绑定）
      bibleUpdatedAt: (doc && doc.bibleUpdatedAt) || 0,
    };
    const tmp = path.join(dir, 'project.json.tmp');
    writeFileSync(tmp, JSON.stringify(out, null, 1), 'utf8');
    renameSync(tmp, path.join(dir, 'project.json'));
  } catch { /* 镜像失败不影响主存储 */ }
}
/** 资产元数据索引 upsert：<项目文件夹>/assets.json。
 *  opts.replace=true 时整表替换（客户端启动全量同步用：IndexedDB 是资产库的唯一事实源，
 *  替换语义能自愈"删除后残留的幽灵条目"）；默认按 id 合并（单资产保存用）。 */
function writeAssetIndex(pid, projectName, assets, opts) {
  const root = dataRoot();
  if (!root) throw new Error('未设置数据根目录');
  const folder = ensureProjectFolder(pid, projectName || pid);
  if (!folder) throw new Error('数据目录不可用');
  const dir = path.join(root, 'projects', folder);
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'assets.json');
  let list = [];
  if (!(opts && opts.replace)) {
    try {
      const parsed = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* 首次/损坏 → 重建 */ }
  }
  for (const a of assets || []) {
    if (!a || !a.id) continue;
    const i = list.findIndex((x) => x.id === a.id);
    if (i >= 0) list[i] = a;
    else list.push(a);
  }
  // replace 语义保留"文件仍存在"的孤儿记录：手工放进数据目录/导入中的资产不被启动对齐误清；
  // 文件已不存在的记录才是真幽灵（删除后残留），照常清理。
  if (opts && opts.replace) {
    const keepIds = new Set(list.map((x) => x.id));
    const orphans = [];
    try {
      const prev = JSON.parse(readFileSync(f, 'utf8'));
      for (const a of (Array.isArray(prev) ? prev : [])) {
        if (!a || !a.id || keepIds.has(a.id)) continue;
        let alive = false;
        if (a.rel) {
          try { const pr = physicalRel(a.rel); if (pr) alive = existsSync(path.join(root, pr)); } catch { alive = false; }
        }
        if (alive) orphans.push(a);
      }
    } catch { /* 首次/损坏 → 无孤儿可保留 */ }
    for (const a of orphans) list.push(a);
  }
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf8');
  renameSync(tmp, f);
  return { ok: true, folder, count: list.length };
}
/** 删除项目的数据目录镜像（项目被删除时调用）。
 *  BLK-01：SQL 模式下目录名可能没有 meta 条目（实测就是项目 id），旧实现此时静默 return、
 *  永远删不掉目录。现在：优先用 meta 的 folder；没有条目就回退 <pid>；两个候选都尝试删；
 *  删除失败不再吞掉，返回值里带 removed/errors 供调用方暴露。
 *  路径安全：folder/pid 可能来自调用方（canvas_delete_project 的 projectId 是外部输入），
 *  含 `..` 或绝对路径时 path.join 会逃出数据根 → rmrf 删掉无关目录。与 IC-B2 的 craft 清理
 *  同一防护：resolve 后必须仍落在 <dataRoot>/projects 之内，否则拒绝并记录。 */
function removeDataRootProject(pid) {
  const out = { removed: false, dirs: [], errors: [] };
  const root = dataRoot();
  if (!root || !pid) return out;
  const meta = readDataRootMeta();
  const entry = meta.projects.find((p) => p.id === pid) || null;
  const candidates = [];
  if (entry && entry.folder) candidates.push(entry.folder);
  if (!candidates.includes(pid)) candidates.push(pid);
  meta.projects = meta.projects.filter((p) => p.id !== pid);
  try { writeDataRootMeta(meta); } catch (e) { out.errors.push('meta: ' + String((e && e.message) || e)); }
  const projectsBase = path.resolve(path.join(root, 'projects'));
  for (const folder of candidates) {
    let dir = null;
    try {
      const cand = path.resolve(path.join(root, 'projects', String(folder)));
      // 必须是 projects 的**子目录**（含 projects 本身在内的任何异常形态都拒绝：
      // cand === projectsBase 时 rmrf 会清掉全部项目的媒体，比越界删除更糟）
      if (cand === projectsBase || !cand.startsWith(projectsBase + path.sep)) {
        out.errors.push('拒绝删除数据根之外的目录: ' + folder);
        continue;
      }
      dir = cand;
    } catch (e) { out.errors.push('路径异常: ' + String((e && e.message) || e)); continue; }
    if (!existsSync(dir)) { out.dirs.push({ dir, existed: false }); continue; }
    try { rmrf(dir); out.dirs.push({ dir, existed: true, removed: !existsSync(dir) }); if (!existsSync(dir)) out.removed = true; }
    catch (e) { out.dirs.push({ dir, existed: true, removed: false }); out.errors.push(dir + ': ' + String((e && e.message) || e)); }
  }
  return out;
}

/** BLK-01：SQL 模式删除项目时的统一清理（两条删除入口共用，禁止各写一份）。
 *  DB 行 → FTS 行 → 资产文件（rel/sha）→ 项目镜像目录 → meta 条目，每一处失败都返回可见。
 *  不碰 craft/ 目录（归 IC-B2）。 */
function sqlDeleteProjectRows(db, id, root) {
  const result = { ok: true, projectId: id, fts: 0, assets: 0, files: 0, dir: null, errors: [] };
  // 1) 资产行与它们占用的文件：先取快照，再删行
  let rows = [];
  try { rows = db.prepare('SELECT id, rel, sha FROM assets WHERE project_id = ?').all(id); } catch (e) { result.errors.push('select assets: ' + String((e && e.message) || e)); }
  result.assets = rows.length;
  // 2) FTS：DELETE FROM assets 绕过了 dbAssetDelete（那里才同步删 FTS）→ 这里逐条清
  try {
    const delFts = db.prepare('DELETE FROM assets_fts WHERE id = ?');
    for (const r of rows) { try { delFts.run(r.id); result.fts++; } catch { /* 单条失败继续 */ } }
  } catch (e) { result.errors.push('fts: ' + String((e && e.message) || e)); }
  // 3) 资产文件（rel 镜像 / sha 对象）：删行前先按引用清理
  try {
    db.prepare('DELETE FROM assets WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    // 多画布：项目下的子画布行随项目一起清掉（否则删项目后画布文档残留成孤行）
    const canvasPattern = String(id).replace(/[\\%_]/g, '\\$&') + CANVAS_ID_SEP + '%';
    db.prepare("DELETE FROM projects WHERE id LIKE ? ESCAPE '\\'").run(canvasPattern);
  } catch (e) { result.errors.push('delete rows: ' + String((e && e.message) || e)); }
  if (root) {
    const seen = new Set();
    for (const r of rows) {
      if (r.rel) {
        try {
          const mapped = physicalRel(r.rel) || r.rel;
          const { abs } = safeJoin(root, mapped);
          if (seen.has(abs)) continue;
          seen.add(abs);
          if (existsSync(abs)) { unlinkSync(abs); result.files++; }
        } catch { /* 已不存在视为成功 */ }
      }
      if (r.sha) { try { gcObjectIfUnreferenced(db, root, r.sha); } catch { /* 对象清理失败不阻塞 */ } }
    }
  }
  // 4) 项目镜像目录（含 meta 条目缺失时的 id 回退）
  try { result.dir = removeDataRootProject(id); if (result.dir.errors.length) result.errors.push(...result.dir.errors); } catch (e) { result.errors.push('dir: ' + String((e && e.message) || e)); }
  if (result.errors.length) result.ok = false;
  return result;
}
/** 子画布文档镜像：数据目录 projects/<项目名文件夹>/canvases/<canvasId>.json。
 *  子画布共用项目文件夹（资产/设定集按项目维度）；失败不影响主存储。 */
function mirrorCanvasDocToDataRoot(projectId, canvasId, doc) {
  const root = dataRoot();
  if (!root) return;
  const projectDoc = readDocOrNull(projectId) || {};
  let folder = null;
  try { folder = ensureProjectFolder(projectId, projectDoc.name || projectId); } catch { return; }
  if (!folder) return;
  try {
    const dir = path.join(root, 'projects', folder, 'canvases');
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, String(canvasId) + '.json');
    const tmp = f + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');
    renameSync(tmp, f);
  } catch { /* 镜像失败不影响主存储 */ }
}
/** 一次性迁移/对齐数据目录布局：旧 pid 文件夹 → 项目名文件夹，并镜像全部项目文档。 */
function dataRootMigrate() {
  const root = dataRoot();
  if (!root) throw new Error('未设置数据根目录');
  let ids = [];
  try {
    ids = existsSync(PROJECTS_DIR)
      ? readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).filter((id) => !isCanvasDocId(id))
      : [];
  } catch { ids = []; }
  let filesMoved = 0;
  const folders = [];
  for (const id of ids) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(projectFile(id), 'utf8')); } catch { continue; }
    const folder = ensureProjectFolder(id, (doc && doc.name) || id);
    folders.push(folder);
    const dir = path.join(root, 'projects', folder);
    mkdirSync(dir, { recursive: true });
    // 旧物理布局（projects/<pid>/<kind>/…）→ 新布局（projects/<项目名>/<kind>/…）
    const oldDir = path.join(root, 'projects', id);
    if (id !== folder && existsSync(oldDir)) {
      try {
        for (const kind of readdirSync(oldDir)) {
          const fromKind = path.join(oldDir, kind);
          const toKind = path.join(dir, kind);
          mkdirSync(toKind, { recursive: true });
          for (const f of readdirSync(fromKind)) {
            const from = path.join(fromKind, f);
            const to = path.join(toKind, f);
            if (!existsSync(to)) { renameSync(from, to); filesMoved++; }
          }
        }
        rmrf(oldDir);
      } catch { /* 目录被占用：保留旧目录，下轮再试 */ }
    }
    mirrorProjectToDataRoot(id, doc);
  }
  return { ok: true, projects: folders.filter(Boolean).length, filesMoved, folders };
}
/** 从项目的 assets.json 索引里移除一条资产记录（资产被删除时保持数据目录同步）。 */
function removeAssetIndexEntry(pid, projectName, assetId) {
  const root = dataRoot();
  if (!root || !pid || !assetId) return { ok: true, removed: false };
  let folder = null;
  try { folder = ensureProjectFolder(pid, projectName || pid); } catch { return { ok: true, removed: false }; }
  if (!folder) return { ok: true, removed: false };
  const f = path.join(root, 'projects', folder, 'assets.json');
  let list = [];
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    if (Array.isArray(parsed)) list = parsed;
  } catch { return { ok: true, removed: false }; }
  const next = list.filter((x) => x && x.id !== assetId);
  if (next.length === list.length) return { ok: true, removed: false };
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
  renameSync(tmp, f);
  return { ok: true, removed: true };
}
/** 一键导入：扫描数据目录 → 合并 project.json 进主存储（updatedAt 新者胜）→ 返回资产元数据供客户端入 IDB。 */
function dataRootImport() {
  const root = dataRoot();
  if (!root) throw new Error('未设置数据根目录');
  const projectsDir = path.join(root, 'projects');
  const dirs = existsSync(projectsDir)
    ? readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const imported = [];
  const importedCanvases = [];
  const assets = {};
  for (const folder of dirs) {
    const dir = path.join(projectsDir, folder);
    let doc = null;
    try { doc = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch { continue; }
    const id = String(doc.id || '');
    if (!id) continue;
    let cur = null;
    try { cur = JSON.parse(readFileSync(projectFile(id), 'utf8')); } catch { /* 本机没有该项目 */ }
    if (!cur || (cur.updatedAt || 0) < (doc.updatedAt || 0)) {
      doc.updatedAt = Date.now();
      writeIcDoc(id, doc); // 会同步镜像回数据目录（无害）
      clearDeletedProjectId(id); // 导入恢复：撤掉长效墓碑，后续客户端推送不再被拒收
      imported.push({ id, name: doc.name || id });
    }
    try {
      const list = JSON.parse(readFileSync(path.join(dir, 'assets.json'), 'utf8'));
      // 派生预览文件不是资产：历史 data 里混入也要剔除
    if (Array.isArray(list)) assets[id] = list.filter((a) => !isDerivedMedia(a && a.rel));
    } catch { /* 无资产索引 */ }
    // 多画布：画布文档镜像在 projects/<项目文件夹>/canvases/*.json（updatedAt 新者胜）
    try {
      const cvDir = path.join(dir, 'canvases');
      for (const f of readdirSync(cvDir)) {
        if (!f.endsWith('.json')) continue;
        let cdoc = null;
        try { cdoc = JSON.parse(readFileSync(path.join(cvDir, f), 'utf8')); } catch { continue; }
        const cid = normalizeCanvasId(cdoc && cdoc.canvasId);
        if (!cid) continue;
        const target = canvasDocId(id, cid);
        let curC = null;
        try { curC = JSON.parse(readFileSync(projectFile(target), 'utf8')); } catch { /* 本机没有该画布 */ }
        if (!curC || (curC.updatedAt || 0) < (cdoc.updatedAt || 0)) {
          writeIcDoc(target, { ...cdoc, id: target, projectId: id, canvasId: cid, updatedAt: Date.now() });
          importedCanvases.push({ id, canvasId: cid, name: String(cdoc.name || cid) });
        }
      }
    } catch { /* 无画布镜像 */ }
  }
  return { ok: true, imported, canvases: importedCanvases, assets };
}
/** 设定集字段规范化（世界观/风格 + 角色/场景/道具条目，条目可携带链接资产 assetIds）。 */
function normalizeBible(raw) {
  const b = (raw && typeof raw === 'object') ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v : [])
    .map((x) => ({
      name: String((x && x.name) || '').slice(0, 60),
      desc: String((x && x.desc) || '').slice(0, 2000),
      // 链接的资产 id（图片/音频/视频）：设定条目与可视化资产的绑定，@引用与参考图解析会用到
      assetIds: Array.isArray(x && x.assetIds)
        ? [...new Set(x.assetIds.map((a) => String(a || '').trim()).filter(Boolean))].slice(0, 20)
        : [],
    }))
    .filter((x) => x.name);
  return {
    worldview: String(b.worldview || '').slice(0, 8000),
    style: String(b.style || '').slice(0, 2000),
    // 风格锚（一句话全片视觉总锚）：AI 更新设定集时与 style 同时产出；生成请求只带锚，style 全文进分镜消化
    styleAnchor: String(b.styleAnchor || '').slice(0, 200),
    characters: arr(b.characters),
    scenes: arr(b.scenes),
    props: arr(b.props),
  };
}
/**
 * 技能配置（四层：导演透镜 / 题材 / 规格 / 影调）字段规范化。
 * 实现搬进 index-core-skill-profile.js（skill-pack.js 也要引用，避免循环依赖）。
 */
/**
 * 把文件流安全地写进响应。
 * createReadStream 的 open/read 错误是**异步事件**，回到不了路由的 try/catch ——
 * 不接管就会变成宿主进程级 uncaughtException（DSH 会按 fatal 退出），
 * 而这条路径非常日常：前端把资产 URL 交给 <img>/<video>，文件被删/被占用即命中。
 */
function pipeFile(abs, opts, res) {
  const rs = createReadStream(abs, opts);
  let headersSent = false;
  const onSent = () => { headersSent = true; };
  try { res.on('finish', onSent); } catch { /* 忽略 */ }
  rs.on('error', (err) => {
    const code = err && err.code;
    try {
      if (!res.headersSent && !headersSent) {
        res.statusCode = code === 'ENOENT' ? 404 : 500;
        res.end(code === 'ENOENT' ? 'not found' : 'read failed');
      } else {
        res.destroy(); // 已发头：只能中断连接，绝不能让异常冒到进程层
      }
    } catch { /* 忽略 */ }
  });
  // 客户端提前断开（切页面/取消播放）时主动关掉读流，避免句柄悬挂
  res.on('close', () => { try { rs.destroy(); } catch { /* 忽略 */ } });
  rs.pipe(res);
}

/** rel 限定在 dataRoot 之内：拒绝绝对路径 / 盘符 / 上级跳转，返回 { abs, clean }。 */
function safeJoin(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean) throw new Error('缺少相对路径');
  if (/(^|\/)\.\.(\/|$)/.test(clean) || /^[a-z]:/i.test(clean)) throw new Error('非法路径: ' + rel);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, ...clean.split('/'));
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('路径越界');
  return { abs, clean };
}
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
  json: 'application/json', srt: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8',
  // js/mjs：浏览器动态 import() 只认 text/javascript —— 导演台引擎模块（assets/director/engine.js）
  // 走 plugin-asset 路由加载，没有这个 MIME 会被浏览器拒载（"Failed to fetch dynamically imported module"）
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
};
function mimeOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? (MIME_BY_EXT[m[1].toLowerCase()] || 'application/octet-stream') : 'application/octet-stream';
}

// ============================================================
// 派生预览文件（系统内部用，**不是资产**）
//   <rel>.thumb.jpg   节点展示用的极小压缩图（图片/截图/视频首帧）
//   <rel>.poster.jpg  视频首帧（历史口径，视作同一类派生文件）
// 规则：不进资产库 / assets.json / 导入扫描；随原文件删除；不分配资产 ID。
// ============================================================
const THUMB_MAX_SIDE = 512; // 缩略图最长边（px）
function isDerivedMedia(rel) {
  return /\.(?:thumb|poster)\.jpg$/i.test(String(rel || '').trim());
}
function thumbRelOf(rel) {
  const t = String(rel || '').trim();
  return t ? t + '.thumb.jpg' : null;
}

/**
 * 弹出系统"选择目录"对话框（阻塞至用户选择/取消）。
 * Windows = PowerShell + WinForms FolderBrowserDialog（TopMost，可新建文件夹）；
 * macOS = osascript choose folder；Linux = zenity（若安装）。均不可用 → { ok:false, unsupported:true }。
 */
function pickFolderDialog() {
  return new Promise((resolve) => {
    const collect = (child) => {
      const stdout = [];
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d) => stdout.push(String(d)));
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, 600000);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, unsupported: e.code === 'ENOENT', error: String(e?.message ?? e) }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const picked = stdout.join('').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        if (code === 0 && picked) resolve({ ok: true, path: picked });
        else resolve({ ok: false, cancelled: true });
      });
    };
    try {
      if (process.platform === 'win32') {
        const script = [
          '$ErrorActionPreference="Stop"',
          '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
          'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
          '$o = New-Object System.Windows.Forms.Form',
          '$o.TopMost = $true',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$d.Description = '选择数据根目录（资产与视频将存到该目录）'",
          '$d.ShowNewFolderButton = $true',
          'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
        ].join('; ');
        collect(spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true }));
      } else if (process.platform === 'darwin') {
        collect(spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择数据根目录")'], { windowsHide: true }));
      } else {
        collect(spawn('zenity', ['--file-selection', '--directory', '--title=选择数据根目录'], { windowsHide: true }));
      }
    } catch (e) {
      resolve({ ok: false, unsupported: true, error: String((e && e.message) || e) });
    }
  });
}

// ---------- 项目存储（对话 ↔ 画布同步）----------
// 客户端是内容权威（编辑后推送全量文档）；Agent 经工具在 Host 侧追加节点；客户端轮询合并。
const PROJECTS_DIR = process.env.DSH_IC_PROJECTS_DIR || path.join(os.homedir(), '.dsh', 'infinite-canvas', 'projects');
function projectFile(id) {
  const s = String(id || '');
  const seg = isCanvasDocId(s) ? splitCanvasDocId(s) : { projectId: s, canvasId: null };
  const okProject = /^[A-Za-z0-9_-]{1,96}$/.test(seg.projectId || '');
  const okCanvas = seg.canvasId === null || /^[A-Za-z0-9_-]{1,64}$/.test(seg.canvasId || '');
  if (!okProject || !okCanvas) throw new Error('非法项目 id');
  return path.join(PROJECTS_DIR, s + '.json');
}
// ---------- 多画布（项目下子目录 = 独立画布文档）----------
// 默认画布：canvasId = null，文档 id 仍是 projectId（旧数据零迁移）。
// 子画布：文档 id = `${projectId}__cv__${canvasId}`，项目文档里登记 canvases: [{id,name,createdAt}]；
// 资产/设定集仍以 projectId 为维度共享，不随画布分割。
const CANVAS_ID_SEP = '__cv__';
function canvasDocId(projectId, canvasId) {
  const cid = normalizeCanvasId(canvasId);
  return cid ? (String(projectId) + CANVAS_ID_SEP + cid) : String(projectId);
}
function isCanvasDocId(docId) { return String(docId || '').includes(CANVAS_ID_SEP); }
function splitCanvasDocId(docId) {
  const s = String(docId || '');
  const i = s.indexOf(CANVAS_ID_SEP);
  if (i < 0) return { projectId: s, canvasId: null };
  return { projectId: s.slice(0, i), canvasId: s.slice(i + CANVAS_ID_SEP.length) || null };
}
function normalizeCanvasId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error('非法画布 id: ' + s);
  return s;
}
function canvasRegistry(projectDoc) {
  return Array.isArray(projectDoc && projectDoc.canvases)
    ? projectDoc.canvases.filter((c) => c && c.id).map((c) => ({ id: String(c.id), name: String(c.name || '').slice(0, 80), createdAt: Number(c.createdAt) || 0 }))
    : [];
}
/** 规范化画布清单（Host 侧唯一写入口）：丢弃非法 id、同名去重、最多 200 个画布。 */
function sanitizeCanvases(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    let cid;
    try { cid = normalizeCanvasId(raw && raw.id); } catch { continue; }
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    out.push({ id: cid, name: String((raw && raw.name) || cid).slice(0, 80), createdAt: Number(raw && raw.createdAt) || Date.now() });
  }
  return out.slice(0, 200);
}
// ---- 工作区内嵌项目（0.20.x）：<工作区目录>/.infinite-canvas/ 即项目家目录 ----
// 项目随工作区目录走（宿主侧 workspaceRegistry 发现）：project.json / canvases/ / memory/ / bindings.json
// 全部内嵌目录自包含。文档读写与数据根/SQLite 完全解耦（wsDocFile 分发）；媒体仍走数据根管线
//（ensureProjectFolder 统一登记媒体文件夹），拷工作区目录 = 带走全部设定/记忆/画布文档。
const WS_APP_DIR = '.infinite-canvas';
/** 工作区项目缓存：pid -> { pid, wsId, wsPath, home, doc }；wsProjectsScan 负责刷新。 */
const wsProjects = new Map();
/** 扫描工作区注册表 list（[{id,path,title,sessionIds}]），发现带 `.infinite-canvas/project.json` 标记的项目。
 *  每次全量重扫（代价 = 每工作区读一个小 JSON），标记消失/目录消失自然落榜。 */
function wsProjectsScan(list) {
  const seen = Array.isArray(list) ? list : [];
  wsProjects.clear();
  for (const w of seen) {
    if (!w || typeof w.path !== 'string' || !w.path) continue;
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(path.join(w.path, WS_APP_DIR, 'project.json'), 'utf8'));
    } catch { /* 无标记/损坏 → 不算项目 */ }
    if (!doc || typeof doc !== 'object' || !doc.id) continue;
    const pid = String(doc.id);
    wsProjects.set(pid, { pid, wsId: String(w.id || ''), wsPath: w.path, home: path.join(w.path, WS_APP_DIR), doc });
  }
  return [...wsProjects.values()];
}
/** 该 pid 是否工作区内嵌项目（按最近一次扫描缓存）。 */
function isWsProject(pid) { return wsProjects.has(String(pid || '')); }
/** 工作区项目家目录（<工作区>/.infinite-canvas）；非工作区项目返回 null。 */
function wsProjectHome(pid) {
  const r = wsProjects.get(String(pid || ''));
  return r ? r.home : null;
}
/** 工作区文档 id → 物理文件：项目文档 = project.json；子画布文档 = canvases/<cid>.json；非工作区项目返回 null。 */
function wsDocFile(id) {
  const s = String(id || '');
  try { projectFile(s); } catch { return null; } // id 段合法性复用 projectFile 校验：封死 canvases/<cid> 路径逃逸（评审 I4）
  const ref = isCanvasDocId(s) ? splitCanvasDocId(s) : { projectId: s, canvasId: null };
  const home = wsProjectHome(ref.projectId);
  if (!home) return null;
  return ref.canvasId ? path.join(home, 'canvases', ref.canvasId + '.json') : path.join(home, 'project.json');
}
/** 工作区项目 → projectsList 条目（与数据根条目同形，另带 origin:'workspace' + wsId/wsPath）。 */
function wsProjectListEntry(rec) {
  const d = rec.doc || {};
  const nodes = Object.values(d.nodes || {}).map((n) => ({
    id: n.id, type: normalizeNodeType(n.type), label: (n.data && n.data.label) || '',
    status: (n.data && n.data.status) || 'idle',
    x: Number(n.x) || 0, y: Number(n.y) || 0, w: Number(n.w) || 0, h: Number(n.h) || 0,
  }));
  return {
    id: d.id, name: d.name || rec.pid, createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0,
    source: d.source || 'agent', nodeIds: Object.keys(d.nodes || {}), nodes,
    tombstones: Array.isArray(d.tombstones) ? d.tombstones : [], bibleUpdatedAt: d.bibleUpdatedAt || 0,
    canvases: canvasRegistry(d), defaultCanvasName: defaultCanvasNameForApi(d),
    defaultCanvasDeleted: !defaultCanvasExists(d),
    origin: 'workspace', wsId: rec.wsId, wsPath: rec.wsPath,
  };
}
/** 删除工作区项目目录（.infinite-canvas 整目录）；工作区目录本身不动。
 *  watcher 只发现不创建 → 删除后不会复活，无需墓碑。 */
function wsProjectRemove(pid) {
  const home = wsProjectHome(pid);
  if (!home) return false;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 目录被占用：标记已无效，后续扫描自然落榜 */ }
  wsProjects.delete(String(pid));
  return true;
}
/** 在工作区目录创建内嵌项目（RPC「建画布项目」/ 测试共用）：默认画布「第1集」。仅显式路径调用。 */
function wsProjectCreateAt(w) {
  const dir = path.join(String(w.path), WS_APP_DIR);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const pid = 'ws' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // 名字优先取工作区**显示名**（title，如 composer 里的 test-2），其次目录名，最后兜底。
  // 旧实现只用 basename(path)：目录名是随机 id（wsmw3hao7et2ll）时项目名就成了乱码。
  const titleName = String(w.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const folderName = (path.basename(String(w.path || '')) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const name = titleName || folderName || '画布项目';
  const doc = {
    id: pid, name, createdAt: Date.now(), updatedAt: Date.now(), source: 'agent',
    nodes: {}, edges: [], view: { x: 60, y: 40, scale: 1 },
    defaultCanvasName: '第1集',
  };
  const rec = { pid, wsId: String(w.id || ''), wsPath: String(w.path), home: dir, doc };
  wsProjects.set(pid, rec); // 先登记再写：writeIcDoc 的 ws 分发靠 wsProjectHome 命中
  try {
    writeIcDoc(pid, doc); // ws 分发 → <dir>/project.json
  } catch (e) {
    wsProjects.delete(pid); // 写失败不留幽灵缓存
    throw e;
  }
  return rec;
}
/** 工作区注册表条目 → 已登记项目缓存记录（wsId/wsPath 双口径匹配）。 */
function wsRecOf(w) {
  if (!w) return null;
  return [...wsProjects.values()].find((r) => r.wsId === String(w.id || '') || r.wsPath === w.path) || null;
}
/** watcher 单次 tick：**纯发现**——只扫描已带 `.infinite-canvas/project.json` 标记的工作区项目进缓存/列表。
 *  不自动建项目、不自动绑会话（0.20.x 口径修正）：绑定必须是用户在 composer chip 里的显式动作，
 *  编码等普通任务的工作区零打扰。目录消失的标记自然读不到 → 自动落榜，无需特殊处理。 */
function wsWatchTick(list) {
  if (!Array.isArray(list)) return { skipped: true };
  const scan = wsProjectsScan(list);
  return { skipped: false, discovered: scan.map((r) => r.pid) };
}
// ---- 项目记忆（0.20.x）：每集画布一份记忆正文 + 项目级调度索引 ----
// 落位：<项目家目录>/memory/index.json（索引：canvasId/标题/摘要/关键词/状态）+ memory/episodes/<canvasId>.md（正文）。
// 项目家目录：工作区项目 = <ws>/.infinite-canvas；数据根项目 = <数据根>/projects/<项目文件夹>。
// 世界观/风格在 bible（project.json），记忆只记「动态」：剧情决策/人物状态变化/伏笔账本。
/** 项目家目录：记忆/绑定等派生文件的落点。
 *  工作区项目 = <ws>/.infinite-canvas；有数据根 = <数据根>/projects/<项目文件夹>；
 *  无数据根（IndexedDB 模式）= PROJECTS_DIR/<pid>/（记忆功能不因数据根缺席而缺席）。 */
function projectHomeDir(pid) {
  const id = String(pid || '');
  const ws = wsProjectHome(id);
  if (ws) return ws;
  const root = dataRoot();
  if (root) {
    let entry = readDataRootMeta().projects.find((p) => p.id === id);
    if (!entry) {
      // 从未登记过媒体文件夹的老项目：按需登记（目录随之创建）
      try {
        const doc = readDocOrNull(id);
        const folder = ensureProjectFolder(id, (doc && doc.name) || id);
        if (folder) entry = { folder };
      } catch { /* 项目不存在等 → 走统一落点 */ }
    }
    return entry && entry.folder ? path.join(root, 'projects', entry.folder) : null;
  }
  try { projectFile(id); } catch { return null; } // 非法 id 拒绝（防路径逃逸）
  return path.join(PROJECTS_DIR, id);
}
const MEMORY_CAP = { title: 80, summary: 120, keywords: 10, keyword: 24 };
/** 同项目写串行链：并发 memoryWrite 顺序落盘，互不覆盖。 */
const memoryWriteChains = new Map();
function memoryDirOf(pid) {
  const home = projectHomeDir(pid);
  return home ? path.join(home, 'memory') : null;
}
/** 读调度索引；缺失/损坏一律容错为空索引（写路径会重建）。 */
function readMemoryIndex(pid) {
  const dir = memoryDirOf(pid);
  if (dir) {
    try {
      const m = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
      if (m && typeof m === 'object' && Array.isArray(m.episodes)) return m;
    } catch { /* 缺失/损坏 → 重建 */ }
  }
  return { version: 1, updatedAt: 0, episodes: [] };
}
/** 原子写索引；覆盖前留一份 index.backup.json（上次良好状态）。 */
function writeMemoryIndexAtomic(pid, index) {
  const dir = memoryDirOf(pid);
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'index.json');
  try { if (existsSync(f)) copyFileSync(f, path.join(dir, 'index.backup.json')); } catch { /* 备份失败不阻塞 */ }
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(index, null, 1), 'utf8');
  renameSync(tmp, f);
}
/** 写一集记忆：正文落 episodes/<canvasId>.md（有内容才写），索引条目 upsert（保序）。 */
async function memoryWrite(pid, canvasId, patch) {
  const id = String(pid || '');
  const cid = normalizeCanvasId(canvasId);
  if (!id || !cid) return { ok: false, error: '缺少 projectId 或 canvasId' };
  try { projectFile(id); } catch { return { ok: false, error: '非法项目 id' }; }
  const p = patch || {};
  const rec = {
    canvasId: cid,
    title: String(p.title || '').trim().slice(0, MEMORY_CAP.title) || ('画布 ' + cid),
    summary: String(p.summary || '').trim().slice(0, MEMORY_CAP.summary),
    keywords: (Array.isArray(p.keywords) ? p.keywords : [])
      .map((k) => String(k || '').trim().slice(0, MEMORY_CAP.keyword)).filter(Boolean).slice(0, MEMORY_CAP.keywords),
    status: p.status === 'done' ? 'done' : 'drafting',
    updatedAt: Date.now(),
  };
  const body = String(p.body == null ? '' : p.body);
  const job = (memoryWriteChains.get(id) || Promise.resolve()).catch(() => {}).then(() => {
    const dir = memoryDirOf(id);
    if (!dir) return { ok: false, error: '项目家目录不可用（未设置数据根且非工作区项目）' };
    if (body.trim()) {
      const epDir = path.join(dir, 'episodes');
      try { mkdirSync(epDir, { recursive: true }); } catch { /* 已存在 */ }
      const f = path.join(epDir, cid + '.md');
      const tmp = f + '.' + process.pid + '.tmp';
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, f);
    }
    const idx = readMemoryIndex(id);
    const i = idx.episodes.findIndex((e) => e && e.canvasId === cid);
    if (i >= 0) idx.episodes[i] = { ...idx.episodes[i], ...rec };
    else idx.episodes.push(rec);
    idx.version = 1;
    idx.updatedAt = Date.now();
    writeMemoryIndexAtomic(id, idx);
    return { ok: true, projectId: id, canvasId: cid, index: idx };
  });
  memoryWriteChains.set(id, job);
  return job;
}
/** 读记忆：无 canvasId 只回索引；有 canvasId 附该集正文（正文文件可独立于索引存在）。 */
async function memoryRead(pid, canvasId) {
  const id = String(pid || '');
  const idx = readMemoryIndex(id);
  const cid = normalizeCanvasId(canvasId);
  let episode = null;
  if (cid) {
    const dir = memoryDirOf(id);
    let body = null;
    if (dir) {
      try { body = readFileSync(path.join(dir, 'episodes', cid + '.md'), 'utf8'); } catch { /* 无正文 */ }
    }
    const meta = idx.episodes.find((e) => e && e.canvasId === cid) || null;
    if (meta || body != null) {
      episode = {
        canvasId: cid,
        title: meta ? meta.title : '', summary: meta ? meta.summary : '',
        keywords: meta ? meta.keywords || [] : [], status: meta ? meta.status || 'drafting' : 'drafting',
        updatedAt: meta ? meta.updatedAt || 0 : 0,
        body: body == null ? '' : body,
      };
    }
  }
  return { ok: true, projectId: id, index: idx, episode };
}
/** 会话 → 绑定 {projectId, canvasId}：扫**全部项目**（工作区内嵌 + 数据根）的绑定表。 */
function toolBindingForSession(sid) {
  const s = String(sid || '');
  if (!s) return null;
  for (const pid of allBoundProjectIds()) {
    let data = null;
    try { data = bindingsRead(pid); } catch { continue; }
    const hit = data.bindings.find((b) => b && b.sessionId === s);
    if (hit) return { projectId: pid, canvasId: hit.canvasId == null ? null : hit.canvasId };
  }
  return null;
}
/** 可承载绑定的项目 id 全集：工作区内嵌项目 + 数据根项目（绑定可跨来源，菜单列表同口径）。 */
function allBoundProjectIds() {
  const ids = new Set(wsProjects.keys());
  try { for (const p of projectsListDataRoot()) ids.add(String(p.id)); } catch { /* 无数据根：只留工作区项目 */ }
  return [...ids];
}
/** 文档 → 画布清单（默认画布 id=null 在前）。 */
function canvasesOfDoc(doc) {
  const list = defaultCanvasExists(doc) ? [{ id: null, name: defaultCanvasNameOf(doc) }] : [];
  for (const c of canvasRegistry(doc)) list.push({ id: c.id, name: c.name });
  return list;
}
/** 绑定的人类可读标签「项目名·画布名」（拒绝文案用）。 */
function bindingLabelOf(b) {
  try {
    const doc = readDocOrNull(b.projectId) || {};
    const cid = b.canvasId == null ? null : b.canvasId;
    let cname = '默认画布';
    if (cid != null) {
      const hit = canvasRegistry(doc).find((c) => c.id === cid);
      cname = (hit && hit.name) || String(cid);
    } else if (defaultCanvasExists(doc)) {
      cname = defaultCanvasNameOf(doc);
    }
    return (doc.name || String(b.projectId || '')) + '·' + cname;
  } catch { return String(b.projectId || ''); }
}
/** 防御式嗅探工具执行身份：不同宿主版本 exec.agent 携带的会话字段可能不同
 *  （sessionId / session / id；cordis branded id 可能包一层 {value}）。拿不到 → null（走显式参数路径）。 */
function toolExecSessionId(exec) {
  try {
    const a = exec && exec.agent;
    if (!a || typeof a !== 'object') return null;
    const candidates = [a.sessionId, a.session, a.id];
    if (a.ctx && typeof a.ctx === 'object') candidates.push(a.ctx.sessionId, a.ctx.session);
    for (const v of candidates) {
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object' && typeof v.value === 'string' && v.value) return v.value;
    }
  } catch { /* 嗅探失败 → null */ }
  return null;
}
// ---- 会话↔画布绑定（0.20.x）：一会话一画布、一画布一会话 ----
// 落位：<项目家目录>/bindings.json：{ version:1, updatedAt, bindings:[{ sessionId, canvasId, boundAt }] }
// 占用判定：目标画布已被其他会话绑定时，aliveFn(占用者) 为真 → 拒绝（occupied）；为假（会话已删的孤儿）→ 覆盖。
/** 读绑定文件；缺失/损坏容错为空。 */
function bindingsRead(pid) {
  const id = String(pid || '');
  try { projectFile(id); } catch { return { version: 1, updatedAt: 0, bindings: [] }; }
  const home = projectHomeDir(id);
  if (!home) return { version: 1, updatedAt: 0, bindings: [] };
  try {
    const b = JSON.parse(readFileSync(path.join(home, 'bindings.json'), 'utf8'));
    if (b && typeof b === 'object' && Array.isArray(b.bindings)) return b;
  } catch { /* 缺失/损坏 → 空 */ }
  return { version: 1, updatedAt: 0, bindings: [] };
}
function writeBindingsAtomic(pid, data) {
  const home = projectHomeDir(pid);
  if (!home) return false;
  try { mkdirSync(home, { recursive: true }); } catch { /* 已存在 */ }
  const f = path.join(home, 'bindings.json');
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  renameSync(tmp, f);
  return true;
}
/** 绑定会话到画布（canvasId=null = 默认画布）。一会话一画布（换绑移除旧条目）；一画布一会话。 */
function bindingSetSync(pid, sessionId, canvasId, aliveFn) {
  const id = String(pid || '');
  const sid = String(sessionId || '').trim();
  let cid = null;
  try { cid = normalizeCanvasId(canvasId); } catch { return { ok: false, error: '非法画布 id' }; }
  if (!id || !sid) return { ok: false, error: '缺少 projectId 或 sessionId' };
  try { projectFile(id); } catch { return { ok: false, error: '非法项目 id' }; }
  const projectDoc = readDocOrNull(id);
  if (!projectDoc) return { ok: false, error: '项目不存在：' + id };
  if (cid) {
    if (!canvasRegistry(projectDoc).some((c) => c.id === cid)) return { ok: false, error: '画布不存在：' + cid };
  } else if (!defaultCanvasExists(projectDoc)) {
    return { ok: false, error: '默认画布已删除：请指定 canvasId' };
  }
  const alive = typeof aliveFn === 'function' ? aliveFn : () => true;
  const data = bindingsRead(id);
  const others = data.bindings.filter((b) => b && b.sessionId !== sid);
  const mine = data.bindings.find((b) => b && b.sessionId === sid);
  const occupant = others.find((b) => (b.canvasId || null) === cid);
  if (occupant && alive(occupant.sessionId)) {
    return { ok: false, occupied: true, by: occupant.sessionId, error: '该画布已绑定其他会话' };
  }
  // 会话全局唯一绑定（评审 I3）：会话改绑本项目时，清掉它在**其他任何项目**（含数据根）里的绑定——
  // 「一会话一画布」是全局约束，否则会话感知默认值可能落到错误项目且 agent 无感知。
  for (const otherPid of allBoundProjectIds()) {
    if (otherPid === id) continue;
    let ob = null;
    try { ob = bindingsRead(otherPid); } catch { continue; }
    const kept = ob.bindings.filter((b) => b && b.sessionId !== sid);
    if (kept.length !== ob.bindings.length) {
      writeBindingsAtomic(otherPid, { ...ob, updatedAt: Date.now(), bindings: kept });
    }
  }
  const next = {
    version: 1,
    updatedAt: Date.now(),
    bindings: others.filter((b) => b !== occupant).concat([{ sessionId: sid, canvasId: cid, boundAt: Date.now() }]),
  };
  writeBindingsAtomic(id, next);
  return { ok: true, projectId: id, sessionId: sid, canvasId: cid, replaced: !!(mine || occupant) };
}
/** 异步包装（watcher 用同步核心以准确回报；RPC 走此包装）。 */
async function bindingSet(pid, sessionId, canvasId, aliveFn) {
  return bindingSetSync(pid, sessionId, canvasId, aliveFn);
}
/** 解绑会话（幂等：无绑定返回 removed=false）。显式解绑即持久——watcher 只发现不绑定，不会绑回。 */
async function bindingClear(pid, sessionId) {
  const id = String(pid || '');
  const sid = String(sessionId || '').trim();
  if (!id || !sid) return { ok: false, error: '缺少 projectId 或 sessionId' };
  const data = bindingsRead(id);
  const kept = data.bindings.filter((b) => b && b.sessionId !== sid);
  const removed = kept.length < data.bindings.length;
  if (removed) writeBindingsAtomic(id, { version: 1, updatedAt: Date.now(), bindings: kept });
  return { ok: true, removed };
}
// ---- 默认画布（canvasId=null）：名字存项目文档 defaultCanvasName；删除后 defaultCanvasDeleted=true ----
const DEFAULT_CANVAS_NAME = '默认画布';
/** 默认画布名：缺省 '默认画布'（旧项目无该字段 → 零迁移）。 */
function defaultCanvasNameOf(doc) {
  const n = String((doc && doc.defaultCanvasName) || '').trim();
  return (n || DEFAULT_CANVAS_NAME).slice(0, 80);
}
/** 默认画布是否还存在（尚未删除）。 */
function defaultCanvasExists(doc) { return !(doc && doc.defaultCanvasDeleted === true); }
/** API 返回的默认画布名：默认画布已删除 → 空字符串（storage 里已清空）。 */
function defaultCanvasNameForApi(doc) { return defaultCanvasExists(doc) ? defaultCanvasNameOf(doc) : ''; }
/** 项目画布总数 = 默认画布（若还在）+ 子画布。 */
function canvasTotal(projectDoc) { return canvasRegistry(projectDoc).length + (defaultCanvasExists(projectDoc) ? 1 : 0); }
/** 项目下全部画布名（默认画布 + 子画布）：重名判定用。 */
function allCanvasNames(projectDoc) {
  const names = defaultCanvasExists(projectDoc) ? [defaultCanvasNameOf(projectDoc)] : [];
  return names.concat(canvasRegistry(projectDoc).map((c) => c.name));
}
function projectsListDataRoot() {
  if (sqlActive()) {
    const db = getDb();
    const rows = db.prepare('SELECT id, name, created_at, updated_at, bible_updated_at, summary, tombstones FROM projects ORDER BY updated_at DESC').all()
      .filter((r) => !isCanvasDocId(r.id)); // 子画布行不是项目：不出现在项目列表（画布清单在项目文档里）
    return rows.map((r) => {
      let sum = {};
      try { sum = JSON.parse(r.summary || '{}'); } catch { /* 旧行/损坏摘要 */ }
      let tombs = [];
      try { tombs = JSON.parse(r.tombstones || '[]'); } catch { /* 旧行 */ }
      return {
        id: r.id, name: r.name, createdAt: r.created_at || 0, updatedAt: r.updated_at || 0,
        source: sum.source || 'app', nodeIds: sum.nodeIds || [],
        // 旧版本摘要里可能是旧类型名：输出时按合并类型归一（image / video）
        nodes: (sum.nodes || []).map((n) => ({ ...n, type: normalizeNodeType(n && n.type) })),
        tombstones: Array.isArray(tombs) ? tombs : [], bibleUpdatedAt: r.bible_updated_at || 0,
        canvases: canvasRegistry(sum),
        defaultCanvasName: defaultCanvasNameForApi(sum),
        defaultCanvasDeleted: !defaultCanvasExists(sum),
      };
    });
  }
  let files = [];
  try { files = readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const list = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    if (isCanvasDocId(id)) continue; // 子画布文档不是项目（由所属项目的 canvases 清单表达）
    try {
      let d;
      try {
        d = JSON.parse(readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
      } catch {
        // 损坏/半写的项目文件：显式标记后仍列出，避免用户看到"项目凭空消失"
        list.push({ id: f.replace(/\.json$/, ''), name: f.replace(/\.json$/, '') + '（文件损坏）', corrupted: true, nodeIds: [], nodes: {}, tombstones: [] });
        continue;
      }
      const nodes = Object.values(d.nodes || {}).map((n) => ({
        id: n.id, type: normalizeNodeType(n.type), label: (n.data && n.data.label) || '',
        status: (n.data && n.data.status) || 'idle',
        x: Number(n.x) || 0, y: Number(n.y) || 0, w: Number(n.w) || 0, h: Number(n.h) || 0,
      }));
      list.push({ id: d.id || id, name: d.name || id, createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0, source: d.source || 'app', nodeIds: Object.keys(d.nodes || {}), nodes, tombstones: d.tombstones || [], bibleUpdatedAt: d.bibleUpdatedAt || 0, canvases: canvasRegistry(d), defaultCanvasName: defaultCanvasNameForApi(d), defaultCanvasDeleted: !defaultCanvasExists(d) });
    } catch { /* 单文件损坏跳过 */ }
  }
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
/** 项目总列表 = 工作区内嵌项目 + 数据根项目，按更新时间合并排序（工作区缓存由 wsProjectsScan 刷新）。 */
function projectsList() {
  const ws = [...wsProjects.values()].map(wsProjectListEntry);
  return ws.concat(projectsListDataRoot()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
async function projectsPut(args) {
  const id = String((args && args.id) || '');
  // 项目删除墓碑（长效）：删除后迟到的全量推送（450ms 防抖竞速 / 启动 pushAllProjectsToHost 快照）
  // 一律拒收——否则项目原地复活（资产/设定集已清，复活即残废）。客户端不会复用项目 id，拒收永不误伤。
  if (deletedProjectIds().includes(id)) return { ok: true, id, deleted: true };
  // 多画布：canvasId 缺省 = 项目默认画布（文档 id 仍是 projectId，旧数据零迁移）；
  // 子画布写到独立文档 id，项目文档只保留名称/设定集/画布清单/默认画布图。
  const canvasId = normalizeCanvasId(args && args.canvasId);
  const targetId = canvasId ? canvasDocId(id, canvasId) : id;
  projectFile(targetId); // 非法 id 早失败（画布文档 id 走同一套校验）
  const doc = (args && args.doc) || {};
  let prev = readDocOrNull(targetId) || {};
  // 墓碑：对话删除的节点 + 客户端本地删除的节点（客户端删除时也会写入 tombstones）。
  // tombstoneAt 记录每个墓碑的创建时刻：只有**推送时间戳（doc.ts）不早于墓碑时刻**的推送
  // 才被认定为"撤销恢复"允许清墓碑；陈旧推送（快照早于删除、无 ts 或 ts 更老）不得借
  // "节点在场"清掉墓碑把已删节点复活。
  const now = Date.now();
  const tombstoneAt = { ...((prev.tombstoneAt && typeof prev.tombstoneAt === 'object') ? prev.tombstoneAt : {}) };
  const edgeTombstoneAt = { ...((prev.edgeTombstoneAt && typeof prev.edgeTombstoneAt === 'object') ? prev.edgeTombstoneAt : {}) };
  const tombstones = [];
  for (const t of (prev.tombstones || [])) { // 旧档案迁移：无时刻记录的墓碑按 0 处理（保持旧的宽松语义）
    if (typeof t !== 'string' || !t) continue;
    if (!tombstones.includes(t)) tombstones.push(t);
    if (tombstoneAt[t] === undefined) tombstoneAt[t] = 0;
  }
  for (const t of ((doc && doc.tombstones) || [])) { // 新推送来的墓碑：以 Host 接收时刻为创建时刻
    if (typeof t !== 'string' || !t) continue;
    if (!tombstones.includes(t)) tombstones.push(t);
    if (tombstoneAt[t] === undefined) tombstoneAt[t] = now;
  }
  const edgeTombstones = [];
  for (const t of (prev.edgeTombstones || [])) {
    if (typeof t !== 'string' || !t) continue;
    if (!edgeTombstones.includes(t)) edgeTombstones.push(t);
    if (edgeTombstoneAt[t] === undefined) edgeTombstoneAt[t] = 0;
  }
  for (const t of ((doc && doc.edgeTombstones) || [])) {
    if (typeof t !== 'string' || !t) continue;
    if (!edgeTombstones.includes(t)) edgeTombstones.push(t);
    if (edgeTombstoneAt[t] === undefined) edgeTombstoneAt[t] = now;
  }
  // 撤销恢复：节点/边随推送回来了，且推送发出时刻不早于墓碑创建时刻 → 撤掉对应旧墓碑
  //（否则 Ctrl+Z 恢复的节点会被下面的 dead 过滤永久丢弃，表现为"Ctrl+Z 之后节点又消失"）
  const pushTs = Number(doc && doc.ts) || 0;
  if (doc && doc.nodes) {
    for (const nid of Object.keys(doc.nodes)) {
      const i = tombstones.indexOf(nid);
      if (i >= 0 && pushTs >= (tombstoneAt[nid] || 0)) {
        tombstones.splice(i, 1);
        delete tombstoneAt[nid];
      }
    }
  }
  if (doc && Array.isArray(doc.edges)) {
    for (const e of doc.edges) {
      const eid = e && e.id;
      if (!eid) continue;
      const i = edgeTombstones.indexOf(eid);
      if (i >= 0 && pushTs >= (edgeTombstoneAt[eid] || 0)) {
        edgeTombstones.splice(i, 1);
        delete edgeTombstoneAt[eid];
      }
    }
  }
  const dead = new Set(tombstones.slice(-200));
  const deadEdges = new Set(edgeTombstones.slice(-400));
  // 节点合并：客户端推来的为准，但**保留 Host 上客户端还没有的节点**（对话刚建的节点
  // 在客户端下一次轮询拉回之前不能被 450ms 的全量推送抹掉）；墓碑标记的节点一律丢弃。
  const merged = {};
  for (const [nid, n] of Object.entries(prev.nodes || {})) {
    if (!dead.has(nid)) merged[nid] = n;
  }
  for (const [nid, n] of Object.entries(doc.nodes || {})) {
    if (!dead.has(nid)) merged[nid] = n;
    else delete merged[nid];
  }
  // 竞态防护：客户端推来的分镜表没有 shots，而 Host 上已有 shots → 保留 Host 的 shots
  // （客户端旧快照推送会覆盖刚生成的分镜，导致"跑下一个时上一个被清空"）
  for (const [nid, n] of Object.entries(merged)) {
    if (!n || n.type !== 'storyboard') continue;
    const hasNew = Array.isArray(n.data && n.data.shots) && n.data.shots.length;
    if (hasNew) continue;
    const prevN = (prev.nodes || {})[nid];
    if (prevN && prevN.type === 'storyboard' && Array.isArray(prevN.data && prevN.data.shots) && prevN.data.shots.length) {
      n.data = { ...(n.data || {}), shots: prevN.data.shots, warnings: prevN.data.warnings || [] };
    }
  }
  const edgeOk = (e) => e && !deadEdges.has(e.id) && merged[e.fromNode] && merged[e.toNode];
  const clientEdges = (doc.edges || []).filter(edgeOk);
  const prevEdges = (prev.edges || []).filter(edgeOk);
  const edgeKey = (e) => e.fromNode + '>' + (e.fromPort || '') + '>' + e.toNode + '>' + (e.toPort || '');
  const seen = new Set(clientEdges.map(edgeKey));
  const edges = clientEdges.concat(prevEdges.filter((e) => !seen.has(edgeKey(e))));
  const keptTomb = tombstones.slice(-200);
  const keptEdgeTomb = edgeTombstones.slice(-400);
  const pruneStamp = (m, keep) => { const o = {}; for (const k of keep) { if (m[k] !== undefined) o[k] = m[k]; } return o; };
  const out = {
    id: targetId,
    createdAt: prev.createdAt || (doc && doc.createdAt) || Date.now(),
    updatedAt: Date.now(),
    source: prev.source || 'app',
    nodes: merged,
    edges,
    view: doc.view || prev.view || { x: 60, y: 40, scale: 1 },
    tombstones: keptTomb,
    edgeTombstones: keptEdgeTomb,
    tombstoneAt: pruneStamp(tombstoneAt, keptTomb),
    edgeTombstoneAt: pruneStamp(edgeTombstoneAt, keptEdgeTomb),
  };
  if (canvasId) {
    out.projectId = id;
    out.canvasId = canvasId; // 子画布文档：不带 name/canvases/bible（项目级字段只在项目文档）
  } else {
    out.name = String((args && args.name) || prev.name || id).slice(0, 80);
    out.canvases = sanitizeCanvases((args && args.canvases) !== undefined ? args.canvases : prev.canvases);
    // 默认画布的项目级字段：名字（缺省 '默认画布'，不写字段即零迁移）与"已删除"标记
    const dnRaw = (args && args.defaultCanvasName !== undefined) ? args.defaultCanvasName : prev.defaultCanvasName;
    if (dnRaw !== undefined && dnRaw !== null && String(dnRaw).trim()) out.defaultCanvasName = String(dnRaw).trim().slice(0, 80);
    const ddRaw = (args && args.defaultCanvasDeleted !== undefined) ? args.defaultCanvasDeleted : prev.defaultCanvasDeleted;
    if (ddRaw) out.defaultCanvasDeleted = true;
    else if (prev.defaultCanvasDeleted) out.defaultCanvasDeleted = true; // 客户端未带该字段时保留"已删除"（防旧推送把默认画布复活）
  }
  // 设定集随文档一起同步（世界观/风格/角色/场景/道具）：对话侧可读写
  let canvasBible = null;
  if (canvasId) {
    // 设定集是项目级：子画布推送里携带的 bible 落到项目文档（画布文档不存 bible）
    const projectDoc = readDocOrNull(id) || {};
    if (doc.bible !== undefined) canvasBible = { bible: normalizeBible(doc.bible), bibleUpdatedAt: Date.now() };
    else if (projectDoc.bible !== undefined) canvasBible = { bible: projectDoc.bible, bibleUpdatedAt: projectDoc.bibleUpdatedAt || 0 };
  } else if (doc.bible !== undefined) {
    out.bible = normalizeBible(doc.bible);
    out.bibleUpdatedAt = Date.now();
  } else if (prev.bible !== undefined) {
    out.bible = prev.bible;
    out.bibleUpdatedAt = prev.bibleUpdatedAt || 0;
  }
  // 技能配置（四层：导演/题材/规格/影调）同样是项目级，与设定集同一套同步语义
  let canvasSkillProfile = null;
  if (canvasId) {
    const projectDoc = readDocOrNull(id) || {};
    if (doc.skillProfile !== undefined) canvasSkillProfile = { profile: normalizeSkillProfile(doc.skillProfile), skillUpdatedAt: Date.now() };
    else if (projectDoc.skillProfile !== undefined) canvasSkillProfile = { profile: projectDoc.skillProfile, skillUpdatedAt: projectDoc.skillUpdatedAt || 0 };
  } else if (doc.skillProfile !== undefined) {
    out.skillProfile = normalizeSkillProfile(doc.skillProfile);
    out.skillUpdatedAt = Date.now();
  } else if (prev.skillProfile !== undefined) {
    out.skillProfile = prev.skillProfile;
    out.skillUpdatedAt = prev.skillUpdatedAt || 0;
  }
  // 设定集有更新时重算全部分镜表的一致性告警（客户端侧设定集编辑也走这条路径）
  const bibleForWarn = canvasId ? (canvasBible && canvasBible.bible) : out.bible;
  if (bibleForWarn !== undefined) {
    try {
      const assetNames = readAssetIndexNames(id);
      for (const nd of Object.values(merged)) {
        if (nd && nd.type === 'storyboard' && Array.isArray(nd.data && nd.data.shots) && nd.data.shots.length) {
          const nextW = storyboardConsistencyWarnings(bibleForWarn, nd.data.shots, assetNames);
          if (JSON.stringify(nextW) !== JSON.stringify(nd.data.warnings || [])) nd.data.warnings = nextW;
        }
      }
    } catch { /* 重算失败不影响保存 */ }
  }
  mkdirSync(PROJECTS_DIR, { recursive: true });
  writeIcDoc(targetId, out); // 统一走原子写 + 数据目录镜像（此前直写绕过了镜像与原子性）
  if (canvasId) {
    // 项目级字段（名称/设定集/技能配置/画布清单）始终只写项目文档：项目文档缺失时补一份最小项目
    const projectDoc = readDocOrNull(id);
    if (!projectDoc) {
      const canvases = sanitizeCanvases((args && args.canvases) || []);
      if (!canvases.some((c) => c.id === canvasId)) canvases.push({ id: canvasId, name: canvasId, createdAt: Date.now() });
      writeIcDoc(id, {
        id, name: String((args && args.name) || id).slice(0, 80), createdAt: Date.now(), updatedAt: Date.now(),
        nodes: {}, edges: [], view: { x: 60, y: 40, scale: 1 }, tombstones: [], canvases,
        defaultCanvasName: defaultCanvasNameOf({ defaultCanvasName: args && args.defaultCanvasName }),
        ...(canvasBible ? { bible: canvasBible.bible, bibleUpdatedAt: canvasBible.bibleUpdatedAt } : {}),
        ...(canvasSkillProfile ? { skillProfile: canvasSkillProfile.profile, skillUpdatedAt: canvasSkillProfile.skillUpdatedAt } : {}),
      });
    } else {
      const patch = {};
      if (canvasBible) { patch.bible = canvasBible.bible; patch.bibleUpdatedAt = canvasBible.bibleUpdatedAt; }
      if (canvasSkillProfile) { patch.skillProfile = canvasSkillProfile.profile; patch.skillUpdatedAt = canvasSkillProfile.skillUpdatedAt; }
      if (args && args.canvases !== undefined) patch.canvases = sanitizeCanvases(args.canvases);
      if (Object.keys(patch).length) patchProjectDoc(id, patch);
    }
  }
  return { ok: true, id, ...(canvasId ? { canvasId } : {}), updatedAt: out.updatedAt };
}
async function projectsGet(args) {
  const id = String((args && args.id) || '');
  const canvasId = normalizeCanvasId(args && args.canvasId);
  if (!canvasId) return readDoc(id);
  // 默认画布/子画布同一入口：子画布返回独立文档 + 项目级字段（名称/设定集/画布清单）
  return readCanvasDoc(id, canvasId);
}
/** 长效项目删除墓碑（区别于 projectsSync 的一次性 deletedProjects 通知信号）：
 *  删除后任何迟到的 projectsPut 都被拒收，直到 dataRootImport 显式恢复该 id。 */
function deletedProjectIds(cfg) {
  const c = cfg || readIcConfig();
  return (c.ui && Array.isArray(c.ui.deletedProjectIds)) ? c.ui.deletedProjectIds : [];
}
function addDeletedProjectId(id) {
  const pid = String(id || '');
  if (!pid) return;
  const cfg = readIcConfig();
  const prev = (cfg.ui && Array.isArray(cfg.ui.deletedProjectIds)) ? cfg.ui.deletedProjectIds : [];
  cfg.ui = { ...(cfg.ui || {}), deletedProjectIds: [...new Set([...prev, pid])].slice(-200) };
  writeIcConfig(cfg);
}
function clearDeletedProjectId(id) {
  const pid = String(id || '');
  if (!pid) return;
  const cfg = readIcConfig();
  if (!cfg.ui || !Array.isArray(cfg.ui.deletedProjectIds) || !cfg.ui.deletedProjectIds.includes(pid)) return;
  cfg.ui = { ...cfg.ui, deletedProjectIds: cfg.ui.deletedProjectIds.filter((x) => x !== pid) };
  writeIcConfig(cfg);
}
/** 外部 API 代理转发：浏览器直连第三方图片/视频/音频网关会被 CORS 拦截（带 Authorization 头的
 *  POST 触发预检，绝大多数网关不返回 CORS 头 → TypeError: Failed to fetch）。
 *  由 Host 服务端（Node fetch，无 CORS）代为请求并原样回传状态码与响应体。
 *  req: { url, method?, headers?, body?（对象→JSON 序列化）, bodyRaw?（base64 原文，multipart 用）, bodyContentType?, timeoutMs? } */
async function fetchProxyForward(reqBody) {
  const url = String((reqBody && reqBody.url) || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('需要 http(s) 接口 url');
  const method = String((reqBody && reqBody.method) || 'POST').toUpperCase();
  // 头部统一小写：客户端与默认补值可能各自携带不同大小写的同名头（Content-Type 与 content-type），
  // 混用会作为重复头转发，严格网关（优云智算）直接 400 "Content-Type must be application/json"
  const headers = {};
  for (const [hk, hv] of Object.entries((reqBody && reqBody.headers && typeof reqBody.headers === 'object') ? reqBody.headers : {})) {
    if (hv === undefined || hv === null) continue;
    headers[String(hk).toLowerCase()] = String(hv);
  }
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    if (reqBody && reqBody.bodyRaw != null) {
      body = Buffer.from(String(reqBody.bodyRaw), 'base64');
      if (reqBody.bodyContentType) headers['content-type'] = String(reqBody.bodyContentType);
    } else if (reqBody && reqBody.body != null) {
      body = typeof reqBody.body === 'string' ? reqBody.body : JSON.stringify(reqBody.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
  }
  const ms = Number(reqBody && reqBody.timeoutMs) > 0 ? Number(reqBody.timeoutMs) : 120000;
  const upstream = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(ms),
  });
  const buf = Buffer.from(await upstream.arrayBuffer());
  return { status: upstream.status, contentType: upstream.headers.get('content-type') || 'application/json; charset=utf-8', buf };
}
/** 设置数据根目录（绝对路径）并挂载数据库；SQL 模式下首次打开自动执行 v1→v2 迁移。 */
function setDataRoot(raw) {
  raw = String(raw ?? '').trim();
  if (!raw) throw new Error('需要数据根目录路径');
  // 必须在 resolve 之前判绝对路径：resolve 之后恒为绝对路径，检查就成了死代码，
  // 相对路径会静默落到应用 cwd（升级即丢数据）
  if (!path.isAbsolute(raw)) throw new Error('需要绝对路径（如 D:\\canvas-data）');
  const root = path.resolve(raw);
  mkdirSync(root, { recursive: true });
  const cfg = readIcConfig();
  cfg.dataRoot = root;
  writeIcConfig(cfg);
  closeDb(); // 换目录：关闭旧库句柄，下一次访问按新路径重开
  let opened = null;
  if (sqlActive()) {
    try {
      const db = getDb();
      opened = { mode: 'sqlite', migrated: JSON.parse(metaGet(db, 'migrated_counts') || '{}') };
    } catch (e) { opened = { mode: 'sqlite', error: String((e && e.message) || e) }; }
  } else {
    // v1 布局迁移（仅 JSON 降级模式）；就绪后自动搬存量资产到磁盘由客户端负责
    let migrated = null;
    try { migrated = dataRootMigrate(); } catch (e) { migrated = { error: String((e && e.message) || e) }; }
    opened = { mode: 'json', migrated };
  }
  return { ok: true, dataRoot: root, ...opened };
}
async function projectsDelete(args) {
  const id = String((args && args.id) || '');
  let cleanup = null;
  if (isWsProject(id)) {
    // 工作区内嵌项目：删 .infinite-canvas 整目录（工作区目录本身不动），并清数据根媒体文件夹
    cleanup = { ws: wsProjectRemove(id) };
    try { removeDataRootProject(id); } catch { /* 媒体清理失败不影响删除 */ }
  } else if (sqlActive()) {
    // BLK-01：行 + FTS + 资产文件 + 镜像目录，一处收口（与 canvasDeleteProject 共用同一实现）
    cleanup = sqlDeleteProjectRows(getDb(), id, dataRoot());
  } else {
    try { unlinkSync(projectFile(id)); } catch { /* 已不存在视为成功 */ }
    try { deleteCanvasDocsForProject(id); } catch { /* 子画布清理失败不影响删除 */ }
    try { removeDataRootProject(id); } catch { /* 数据目录镜像清理失败不影响删除 */ }
  }
  try { addDeletedProjectId(id); } catch { /* 墓碑写失败不影响删除 */ }
  // 清理失败必须可见：ok 保留删除语义，disk 字段给出磁盘侧实际结果
  return { ok: true, disk: cleanup };
}
async function projectsSync() {
  const cfg = readIcConfig();
  const openRequest = (cfg.ui && cfg.ui.openRequest) || null;
  const runRequest = (cfg.ui && cfg.ui.runRequest) || null;
  const deletedProjects = (cfg.ui && cfg.ui.deletedProjects) || null;
  const docChanged = (cfg.ui && cfg.ui.docChanged) || null;
  if (openRequest || runRequest || deletedProjects || docChanged) {
    cfg.ui = { ...(cfg.ui || {}), openRequest: null, runRequest: null, deletedProjects: null, docChanged: null };
    writeIcConfig(cfg);
  }
  return { projects: projectsList(), openRequest, runRequest, deletedProjects, docChanged };
}
/** 节点默认名：取内容首行前 18 字，保证对话创建的节点可识别。 */
function defaultLabel(text) {
  const line = String(text || '').trim().split(/\r?\n/)[0] || '';
  return line.length > 18 ? line.slice(0, 18) + '…' : (line || '未命名');
}
/** 旧节点类型 → 合并类型（与客户端 client.js 同一映射）：
 *  image-gen / image-asset → image，video-gen / video-asset → video。
 *  旧项目文档读入时统一归一（只改 type，节点 data / 连线端点原样保留：有 assetId 就是资产，有 prompt 就是提示词）。 */
const LEGACY_NODE_TYPES = { 'image-gen': 'image', 'image-asset': 'image', 'video-gen': 'video', 'video-asset': 'video' };
function normalizeNodeType(type) { return LEGACY_NODE_TYPES[type] || type; }
function normalizeNode(n) {
  if (n && typeof n === 'object') {
    const t = normalizeNodeType(n.type);
    if (t !== n.type) n.type = t;
  }
  return n;
}
function normalizeDocNodes(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  for (const n of Object.values(doc.nodes || {})) {
    normalizeNode(n);
    normalizeMediaNodeSize(n); // 与客户端同一几何规则：媒体节点外框 = 预览区 + 标题栏 +（有结果时）操作栏
  }
  return doc;
}
const MERGED_NODE_TYPES = ['image', 'video'];
// ---- 媒体节点几何（必须与 client.js 的 NODE_HDR_H / NODE_FOOT_H / MEDIA_PREVIEW_SHORT / MEDIA_MAX_LONG 一致）----
// 媒体节点三段：标题栏（固定）+ 预览区（盒比 = 画面比例，短边 360、长边 ≤800）+ 操作栏（固定，有结果才有）。
const NODE_HDR_H = 32;
const NODE_FOOT_H = 32;
const MEDIA_PREVIEW_SHORT = 360;
const MEDIA_MAX_LONG = 800;
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const ratioIsValid = (r) => {
  const [rw, rh] = String(r || '').split(':').map(Number);
  return rw > 0 && rh > 0;
};
/** 画面比例 → 预览区尺寸（不含标题栏/操作栏）。 */
function mediaPreviewSize(ratio) {
  const [rw, rh] = String(ratio == null ? '' : ratio).split(':').map(Number);
  if (!rw || !rh) return { w: MEDIA_PREVIEW_SHORT, h: MEDIA_PREVIEW_SHORT };
  let w; let h;
  if (rw >= rh) { h = MEDIA_PREVIEW_SHORT; w = Math.round(MEDIA_PREVIEW_SHORT * rw / rh); }
  else { w = MEDIA_PREVIEW_SHORT; h = Math.round(MEDIA_PREVIEW_SHORT * rh / rw); }
  const long = Math.max(w, h);
  if (long > MEDIA_MAX_LONG) { const k = MEDIA_MAX_LONG / long; w = Math.round(w * k); h = Math.round(h * k); }
  return { w, h };
}
/** 媒体节点外框尺寸 = 预览区尺寸 + 固定栏高度（hasFooter 只在有 assetId 时为 true）。 */
function mediaNodeSize(ratio, hasFooter) {
  const pv = mediaPreviewSize(ratio);
  return { w: pv.w, h: pv.h + NODE_HDR_H + (hasFooter ? NODE_FOOT_H : 0) };
}
/** 像素尺寸 → 比例（吸附到 RATIOS 档，3% 容差；否则约分）。 */
function ratioFromDims(w, h) {
  const aw = Number(w) || 0;
  const ah = Number(h) || 0;
  if (!(aw > 0 && ah > 0)) return '16:9';
  const want = aw / ah;
  let best = null;
  for (const r of RATIOS) {
    const [rw, rh] = r.split(':').map(Number);
    const diff = Math.abs(rw / rh - want) / want;
    if (!best || diff < best.diff) best = { ratio: r, diff };
  }
  if (best && best.diff <= 0.03) return best.ratio;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const k = gcd(Math.round(aw), Math.round(ah)) || 1;
  return Math.round(aw / k) + ':' + Math.round(ah / k);
}
/** 媒体节点应使用的画面比例：记录值 → 资产实测尺寸 → 默认 16:9。 */
function mediaRatioOf(n) {
  const d = (n && n.data) || {};
  if (ratioIsValid(d.ratio)) return d.ratio;
  const aw = Number(d.assetW);
  const ah = Number(d.assetH);
  if (aw > 0 && ah > 0) return ratioFromDims(aw, ah);
  return '16:9';
}
/** 文档读入时的幂等归一：媒体节点外框必须满足「预览区比例 = 画面比例」，
 *  否则按记录比例重算（用户等比拉伸过的预览区比例已正确 → 保留）。
 *  与 client.js normalizeMediaNodeSize 同一规则，Host 侧建节点/读文档也保持一致。 */
function normalizeMediaNodeSize(n) {
  if (!n || (normalizeNodeType(n.type) !== 'image' && normalizeNodeType(n.type) !== 'video')) return n;
  const d = n.data || (n.data = {});
  const hasFooter = !!d.assetId;
  const ratio = mediaRatioOf(n);
  if (!ratioIsValid(d.ratio)) d.ratio = ratio;
  const [rw, rh] = String(ratio).split(':').map(Number);
  const want = rw / rh;
  const pw = Number(n.w) || 0;
  const ph = (Number(n.h) || 0) - NODE_HDR_H - (hasFooter ? NODE_FOOT_H : 0);
  const okPreview = pw > 0 && ph > 0 && Math.abs(pw / ph - want) / want <= 0.02;
  if (!okPreview) {
    const sz = mediaNodeSize(ratio, hasFooter);
    n.w = sz.w; n.h = sz.h;
  }
  return n;
}
/** 构造与客户端 newNode() 完全一致的节点（形状不一致会导致渲染异常）。 */
function agentNode(kind, text, x, y, label) {
  const id = 'na' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const isText = kind === 'text';
  const data = isText
    ? { status: 'idle', error: null, text: String(text ?? '') }
    : { status: 'idle', error: null, idea: String(text ?? ''), output: '', aiStatus: 'idle', aiError: null };
  if (label) data.label = String(label).slice(0, 40);
  // 与客户端一致：所有节点默认 360×360（文本/剧本/分镜固定这个尺寸，不随内容变化；尺寸持久化进文档）
  return { id, type: isText ? 'text' : 'script', x, y, w: 360, h: 360, data };
}
/** 新节点布局（用户设计）：
 *  1) 有 connectFrom 源 → 放在源节点右侧同一行（串联节点横向成对）；
 *  2) 无连线 → 同类型竖向成列（排在该类型最后一个节点下方，新起一行）；
 *  3) 碰撞检测：候选位置与任何现有节点（含最小间距 28px）相交 → 自动下移到该节点下方，绝不重叠。 */
function nextNodePos(doc, type, connectFromId, size) {
  const GAP_X = 60, GAP_Y = 40, MIN_GAP = 28;
  const H = (n) => Number(n && n.h) || 160;
  const W = (n) => Number(n && n.w) || 280;
  const nodes = Object.values(doc.nodes || {});
  const EST_H = { storyboard: 360, video: 360, image: 360, script: 360, finalcut: 360, text: 360 };
  // 媒体节点的真实外框比 360 高/宽（预览区按比例 + 固定栏）：建节点时传 size，避免估小后与邻居重叠
  const estH = (size && Number(size.h)) || EST_H[type] || 360;
  const estW = (size && Number(size.w)) || 360;
  const same = nodes.filter((n) => n.type === type);
  let x = 80;
  let y = 40;
  if (same.length) {
    // 一类型一列（布局铁律）：该类型已有节点 → 永远追加到同类型列尾；
    // 连线只表达数据流，不改变列归属（否则类型会交叉、画布无法辨认）
    x = Math.min(...same.map((n) => n.x || 0));
    y = Math.max(...same.map((n) => (n.y || 0) + H(n))) + GAP_Y;
  } else if (connectFromId && doc.nodes && doc.nodes[connectFromId]) {
    // 该类型的第一个节点：放在上游右侧一行（自然形成新的一列）
    const src = doc.nodes[connectFromId];
    x = (src.x || 0) + W(src) + GAP_X;
    y = src.y || 40;
  } else if (nodes.length) {
    // 该类型还没有节点且无上游 → 在最右侧另起一列（绝不插进已有列里跟别的类型混排）
    x = Math.max(...nodes.map((n) => (n.x || 0) + W(n))) + GAP_X;
    y = Math.min(...nodes.map((n) => n.y || 40));
  }
  const hit = (yy) => nodes.find((n) => (n.x || 0) < x + estW + MIN_GAP && (n.x || 0) + W(n) + MIN_GAP > x
    && (n.y || 0) < yy + estH + MIN_GAP && (n.y || 0) + H(n) + MIN_GAP > yy);
  let blocker = hit(y);
  let guard = 0;
  while (blocker && guard++ < 80) { y = (blocker.y || 0) + H(blocker) + MIN_GAP; blocker = hit(y); }
  return { x, y };
}
// ---------- 内置技能（操作规程 + 创作方法论，约束并提升对话的画布创作）----------
// canvas-studio＝操作硬约束；canvas-craft＝剧本/分镜/提示词创作方法论；canvas-layout＝节点布局纪律；
// canvas-director＝导演透镜/题材/规格/影调/运镜（创作控制层，按生成能力切片注入）
const SKILL_NAMES = ['canvas-studio', 'canvas-craft', 'canvas-layout', 'canvas-director'];
/** 随包分发的引导技能（skills/<name>/SKILL.md）：原由 preset 里 @ninkch/dsh-infinite-canvas/skills
 *  行挂载——2026-11-11 诊断：主包已在 profile bundle 层挂载，preset 再挂同包子路径 = 同一物理包
 *  重复激活（老版 dsh-studio-mode 头注释警告的「重复挂载 → 预设加载失败」）→ media-studio
 *  预设 broken。改为 bundle 层与四件套一起注册，preset 不再需要独立技能行。 */
const WORKSHOP_SKILL_NAMES = ['director-workshop'];
// = @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK（避免 import DSH 包；registry 要求 rank 必须是有限数字）
const SKILL_RANK = 600;
/** 解析 SKILL.md 的 YAML frontmatter（仅需 description 与正文）。 */
function parseSkillMd(raw) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(raw || ''));
  const meta = fm ? fm[1] : '';
  const m = /^description:\s*(.+)$/m.exec(meta);
  const description = m ? m[1].trim() : '';
  const content = fm ? String(raw).slice(fm[0].length).trim() : String(raw || '').trim();
  return { description, content };
}
/** 把内置技能注册进 skills 服务（与 dsh-skill-office 同款 provider 形状，零 DSH 包依赖）。 */
function registerCanvasSkill(ctx, disposers) {
  const skills = ctx.get('skills');
  if (!skills || typeof skills.registerProvider !== 'function') return false;
  const candidates = [];
  // 四件套：assets/<name>/SKILL.md
  for (const name of SKILL_NAMES) {
    const assetPath = path.join(HERE, 'assets', name, 'SKILL.md');
    if (!existsSync(assetPath)) continue;
    const { description } = parseSkillMd(readFileSync(assetPath, 'utf8'));
    if (!description) continue;
    candidates.push({
      name,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-infinite-canvas',
      source: 'bundled',
      rank: SKILL_RANK,
      resourceBase: { kind: 'directory', path: path.dirname(assetPath) },
      locator: assetPath,
    });
  }
  // 导演工作坊：skills/<name>/SKILL.md（原 preset 层挂载，现并入同一 provider；见 WORKSHOP_SKILL_NAMES 注释）
  for (const name of WORKSHOP_SKILL_NAMES) {
    const assetPath = path.join(HERE, 'skills', name, 'SKILL.md');
    if (!existsSync(assetPath)) continue;
    const { description } = parseSkillMd(readFileSync(assetPath, 'utf8'));
    if (!description) continue;
    candidates.push({
      name,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-infinite-canvas',
      source: 'bundled',
      rank: SKILL_RANK,
      resourceBase: { kind: 'directory', path: path.dirname(assetPath) },
      locator: assetPath,
    });
  }
  if (!candidates.length) return false;
  const provider = {
    name: 'dsh-infinite-canvas',
    list: () => Promise.resolve(candidates),
    async get(c, options) {
      const { rank: _rank, locator, ...summary } = c;
      const raw = await fs.readFile(locator, { encoding: 'utf8', signal: options && options.signal });
      return { ...summary, content: parseSkillMd(raw).content };
    },
  };
  try {
    const off = skills.registerProvider(() => provider);
    if (typeof off === 'function') disposers.push(off);
    return true;
  } catch {
    return false;
  }
}

function canvasCreateProject(args) {
  const name = String((args && args.name) || '').trim();
  if (!name) throw new Error('需要项目名称');
  // 幂等保护：同名项目已存在 → 复用，绝不重复创建（Agent 重试或误调用都会走到这里）
  const existing = projectsList().find((p) => String(p.name).trim() === name);
  if (existing) {
    return { ok: true, projectId: existing.id, name: existing.name, reused: true, nodeId: null };
  }
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const doc = { id, name: name.slice(0, 80), createdAt: Date.now(), updatedAt: Date.now(), source: 'agent', nodes: {}, edges: [], view: { x: 60, y: 40, scale: 1 } };
  const st = String((args && args.scriptText) || '');
  const out = String((args && args.scriptOutput) || '');
  if (st.trim() || out.trim()) {
    const pos = nextNodePos(doc);
    const n = agentNode('script', st, pos.x, pos.y, (args && args.nodeName) || defaultLabel(st || out));
    if (out.trim()) n.data.output = out; // 剧本节点：idea 与 output 同属一个节点，一次写全
    doc.nodes[n.id] = n;
  }
  mkdirSync(PROJECTS_DIR, { recursive: true });
  writeIcDoc(id, doc);
  markDocChanged(id);
  return { ok: true, projectId: id, name: doc.name, nodeId: Object.keys(doc.nodes)[0] || null };
}
/**
 * 写入项目内容。
 * - 带 nodeId：更新该节点（target=output 写成稿，target=idea 写提示词；text 节点写正文）
 * - 不带 nodeId：
 *   · text 节点 → 追加新节点
 *   · 剧本节点 → 复用规则**严格区分"定位"与"命名"**：
 *     1) 给了 name 且能匹配已有节点名 → 更新该节点（这是"定位"）
 *     2) 给了 name 但匹配不到 → **新建节点**（这是"命名"新章节；绝不改旧节点的名，
 *        否则多集/多节写作会一路把旧稿覆盖掉且无任何报错）
 *     3) 没给 name → 只复用"有 idea 没 output"或"output 为空"的剧本节点（补全半成品）
 *     4) 其余情况新建，避免静默覆盖已经写完的成稿
 */
function canvasWriteNode(args) {
  const id = String((args && args.projectId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const text = String((args && args.text) || '');
  const target = (args && args.target) === 'output' ? 'output' : 'idea';
  const nodeId = String((args && args.nodeId) || '');
  const name = args && args.name ? String(args.name).slice(0, 40) : '';
  const idea = args && args.idea !== undefined ? String(args.idea) : null;
  const overwrite = args && args.overwrite === true;
  const writeInto = (node) => {
    if (node.type === 'text') node.data.text = text;
    else if (node.type === 'storyboard' && target === 'output') {
      // 分镜节点：text 为 {"shots":[...]} JSON → 写入镜头列表；普通文本 → 作为分镜的剧本来源。
      // 禁止把分镜内容塞进剧本节点（剧本节点只放剧本）。
      let shots = null;
      try { const p = JSON.parse(text); if (p && Array.isArray(p.shots)) shots = p.shots; } catch { /* 非 JSON */ }
      if (!shots) {
        const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
        if (fence) { try { const p2 = JSON.parse(fence[1]); if (p2 && Array.isArray(p2.shots)) shots = p2.shots; } catch { /* 非 JSON */ } }
      }
      if (shots) {
        node.data.shots = shots.slice(0, 24).map((s, i) => ({
          title: String((s && s.title) || ('镜头' + (i + 1))).slice(0, 24),
          visual: String((s && s.visual) || ''),
          motion: String((s && s.motion) || ''),
          characters: Array.isArray(s && s.characters) ? s.characters.map(String) : [],
          scene: String((s && s.scene) || ''),
          props: Array.isArray(s && s.props) ? s.props.map(String) : [],
          duration: Number(s && s.duration) || 5,
          dialogue: Array.isArray(s && s.dialogue)
            ? s.dialogue.slice(0, 6).map((d) => ({ role: String(d && d.role || '').trim().slice(0, 24), line: String(d && d.line || '').trim().slice(0, 200) })).filter((d) => d.role && d.line)
            : [],
          sfx: String((s && s.sfx) || '').trim().slice(0, 120),
          // 分镜新四字段（动作节拍/机位三件套/特效/负向词）必须透传：对话侧改 shots 时
          // 不带这些字段才允许被默认清空；带了就保留——否则特效演绎镜落库即退化为纯 visual/motion。
          timeBeats: Array.isArray(s && s.timeBeats) ? s.timeBeats.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 4) : [],
          camera: String((s && s.camera) || '').trim().slice(0, 200),
          vfx: String((s && s.vfx) || '').trim().slice(0, 160),
          negative: String((s && s.negative) || '').trim().slice(0, 200),
          // 战斗因果字段（打斗镜专用，全部可选）同规则透传
          attack: String((s && s.attack) || '').trim().slice(0, 160),
          reaction: String((s && s.reaction) || '').trim().slice(0, 160),
          impact: String((s && s.impact) || '').trim().slice(0, 160),
          initiative: String((s && s.initiative) || '').trim().slice(0, 80),
          nextCombat: String((s && s.nextCombat) || '').trim().slice(0, 80),
        }));
        node.data.aiStatus = 'idle';
        node.data.aiError = null;
        // 写入分镜时同步计算一致性告警：node_status 能立刻返回 warnings（对话侧据此补全设定集）
        try { node.data.warnings = storyboardConsistencyWarnings(doc.bible || {}, node.data.shots, readAssetIndexNames(id)); } catch { node.data.warnings = []; }
      } else {
        // 二选一强约束（不可用 overwrite 绕过）：已连线到上游剧本的分镜表，内容只从连线取——
        // 两套来源并存会让生成结果不可预期。如需改用粘贴，请先删除该连线或重建分镜表节点。
        const wired = (doc.edges || []).some((e) => e.toNode === node.id && e.toPort === 'script');
        if (wired) {
          throw new Error('该分镜表已连线到上游剧本节点，内容将从连线读取（连线与粘贴二选一，不可并用）；请编辑上游剧本节点。');
        }
        node.data.script = text;
      }
    }
    else if (target === 'output') { node.data.output = text; node.data.aiStatus = 'idle'; node.data.aiError = null; }
    else node.data.idea = text;
    if (idea !== null && node.type === 'script') node.data.idea = idea;
    if (name) node.data.label = name;
  };
  const save = () => { doc.updatedAt = Date.now(); writeToolDoc(args, doc); };
  const withCanvas = (o) => (canvasId ? { ...o, canvasId } : o);
  /** 该节点是否已有会被 target=output 覆盖的内容（剧本=成稿；分镜=镜头列表；文本=正文）。 */
  const hasExisting = (node) => {
    if (!node || !node.data) return false;
    if (node.type === 'storyboard') return Array.isArray(node.data.shots) && node.data.shots.length > 0;
    return String(node.data.output ?? node.data.text ?? '').trim() !== '';
  };
  const guardOverwrite = (node) => {
    if (target === 'output' && !overwrite && hasExisting(node)) {
      throw new Error('节点「' + ((node.data && node.data.label) || node.id) + '」已有内容，覆盖会丢失原文；确认要覆盖请传 overwrite:true，或换个 name 新建节点。');
    }
  };
  if (nodeId) {
    const node = doc.nodes[nodeId];
    if (!node) throw new Error('节点不存在: ' + nodeId);
    guardOverwrite(node);
    writeInto(node);
    save();
    return withCanvas({ ok: true, projectId: id, nodeId, updated: true, label: node.data.label || '' });
  }
  if ((args && args.kind) === 'text') {
    const pos = nextNodePos(doc);
    const n = agentNode('text', text, pos.x, pos.y, name || defaultLabel(text));
    doc.nodes[n.id] = n;
    save();
    return withCanvas({ ok: true, projectId: id, nodeId: n.id, label: n.data.label || '' });
  }
  const scripts = Object.values(doc.nodes || {}).filter((n) => n.type === 'script');
  let reuse = null;
  if (name) {
    reuse = scripts.find((n) => String((n.data && n.data.label) || '').trim() === name) || null; // 仅"定位"
  } else {
    reuse = scripts.find((n) => String((n.data && n.data.idea) || '').trim() && !String((n.data && n.data.output) || '').trim())
      || scripts.find((n) => !String((n.data && n.data.output) || '').trim())
      || null;
  }
  if (reuse) {
    if (target === 'output' && !overwrite && hasExisting(reuse)) {
      throw new Error('节点「' + ((reuse.data && reuse.data.label) || reuse.id) + '」已有内容，覆盖会丢失原文；确认要覆盖请传 overwrite:true，或换个 name 新建节点。');
    }
    writeInto(reuse);
    save();
    return withCanvas({ ok: true, projectId: id, nodeId: reuse.id, updated: true, reused: true, label: reuse.data.label || '' });
  }
  const pos = nextNodePos(doc);
  const n = agentNode('script', target === 'output' ? '' : text, pos.x, pos.y, name || defaultLabel(text));
  if (target === 'output') n.data.output = text;
  if (idea !== null) n.data.idea = idea;
  doc.nodes[n.id] = n;
  save();
  return withCanvas({ ok: true, projectId: id, nodeId: n.id, label: n.data.label || '' });
}
/** 读取项目文档：把"文件不存在/内容损坏"变成用户和模型都读得懂的报错（不泄漏绝对路径）。 */
function readDoc(id) {
  const doc = readDocOrNull(id);
  if (doc) {
    // 旧项目兼容：读入即归一旧节点类型（image-gen/image-asset → image，video-gen/video-asset → video）
    return normalizeDocNodes(doc);
  }
  // 文件模式区分「不存在」与「损坏」（损坏给重建提示）；SQL/工作区侧统一按不存在处理
  if (!sqlActive() && !wsDocFile(id) && existsSync(projectFile(id))) {
    throw new Error('项目文件损坏，无法解析：' + id + '（可考虑重建该项目）');
  }
  throw new Error('项目不存在：' + id + '（先用 canvas_list_projects 查看可用项目 id）');
}
/** 原子写项目/画布文档：SQL 模式走单行事务；文件模式先写临时文件再改名，避免半写导致项目"消失"。
 *  子画布文档（id 含 __cv__）不重复登记项目文件夹、不镜像 project.json——项目级 meta 只属于默认画布行。 */
function writeIcDoc(id, doc) {
  const canvasRef = splitCanvasDocId(id);
  const isCanvas = isCanvasDocId(id);
  // 工作区内嵌项目：文档直接落 <ws>/.infinite-canvas/（原子写）；不进 SQLite、不镜像数据根。
  // 项目级文档顺带在数据根登记媒体文件夹（媒体仍走数据根管线），失败不阻塞。
  const wsf = wsDocFile(id);
  if (wsf) {
    try { mkdirSync(path.dirname(wsf), { recursive: true }); } catch { /* 目录已存在 */ }
    const tmp = wsf + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');
    renameSync(tmp, wsf);
    if (!isCanvas) {
      try { ensureProjectFolder(canvasRef.projectId, (doc && doc.name) || canvasRef.projectId); } catch { /* 媒体文件夹登记失败不阻塞文档 */ }
    }
    return;
  }
  if (sqlActive()) {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id, name, created_at, updated_at, bible_updated_at, summary, tombstones, doc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at,
                  bible_updated_at = excluded.bible_updated_at, summary = excluded.summary,
                  tombstones = excluded.tombstones, doc = excluded.doc`)
      .run(
        id,
        String((doc && doc.name) || (isCanvas ? canvasRef.projectId : id)).slice(0, 80),
        (doc && doc.createdAt) || Date.now(), (doc && doc.updatedAt) || Date.now(),
        (doc && doc.bibleUpdatedAt) || 0, JSON.stringify(docSummary(doc)), JSON.stringify((doc && doc.tombstones) || []), JSON.stringify(doc),
      );
    // SQL 模式也要保证数据目录里有 meta 映射（craft 清理/物理落盘按 folder 定位）：
    // 子画布共用项目的物理文件夹，不单独登记。
    if (!isCanvas) {
      try { ensureProjectFolder(id, (doc && doc.name) || id); } catch { /* meta 写失败不阻塞主存储 */ }
    }
    return;
  }
  const f = projectFile(id);
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');
  renameSync(tmp, f);
  // 数据目录镜像（含设定集/assetIds 绑定）：失败不影响主存储；子画布镜像到项目文件夹下 canvases/，不写 project.json
  if (!isCanvas) mirrorProjectToDataRoot(id, doc);
  else mirrorCanvasDocToDataRoot(canvasRef.projectId, canvasRef.canvasId, doc);
}
/** 读取画布文档（多画布）：默认画布 = 项目文档；子画布 = 独立文档 + 合并项目级字段（名称/设定集/画布清单）。 */
function readCanvasDoc(projectId, canvasId) {
  const pid = String(projectId || '');
  const cid = normalizeCanvasId(canvasId);
  const projectDoc = readDocOrNull(pid);
  if (!projectDoc) throw new Error('项目不存在：' + pid + '（先用 canvas_list_projects 查看可用项目 id）');
  if (!cid) {
    if (!defaultCanvasExists(projectDoc)) throw new Error('默认画布已删除：请指定 canvasId（先用 canvas_list_projects 查看可用画布）');
    return normalizeDocNodes({
      ...projectDoc, canvases: canvasRegistry(projectDoc),
      defaultCanvasName: defaultCanvasNameOf(projectDoc), defaultCanvasDeleted: false,
    });
  }
  const rec = canvasRegistry(projectDoc).find((c) => c.id === cid);
  if (!rec) throw new Error('画布不存在：' + cid + '（项目 ' + pid + '；先用 canvas_list_projects 查看可用画布）');
  const raw = readDocOrNull(canvasDocId(pid, cid)) || {};
  const doc = { ...raw, id: pid, projectId: pid, canvasId: cid, name: projectDoc.name || pid };
  doc.nodes = raw.nodes || {};
  doc.edges = raw.edges || [];
  doc.view = raw.view || { x: 60, y: 40, scale: 1 };
  if (projectDoc.bible !== undefined) { doc.bible = projectDoc.bible; doc.bibleUpdatedAt = projectDoc.bibleUpdatedAt || 0; }
  doc.canvases = canvasRegistry(projectDoc);
  doc.defaultCanvasName = defaultCanvasNameForApi(projectDoc);
  doc.defaultCanvasDeleted = !defaultCanvasExists(projectDoc);
  return normalizeDocNodes(doc);
}
/** 写画布文档：默认画布写项目文档；子画布写独立文档（项目级字段剔除）。 */
function writeCanvasDoc(projectId, canvasId, doc) {
  const pid = String(projectId || '');
  const cid = normalizeCanvasId(canvasId);
  if (!cid) {
    writeIcDoc(pid, { ...doc, id: pid });
    return;
  }
  const out = { ...doc, id: canvasDocId(pid, cid), projectId: pid, canvasId: cid, updatedAt: Date.now() };
  delete out.bible;
  delete out.bibleUpdatedAt;
  delete out.canvases;
  delete out.name;
  writeIcDoc(canvasDocId(pid, cid), out);
}
/** 更新项目级字段（名称/设定集/画布清单）——只作用于默认画布那份项目文档。 */
function patchProjectDoc(projectId, patch) {
  const pid = String(projectId || '');
  const cur = readDocOrNull(pid);
  if (!cur) throw new Error('项目不存在：' + pid);
  writeIcDoc(pid, { ...cur, ...patch, id: pid });
}
/** 工具入口统一的画布参数解析：args.canvasId 缺省 = 项目默认画布（null）；非法 id 直接报错不静默降级。 */
function toolCanvasId(args) {
  return normalizeCanvasId(args && args.canvasId);
}
/** 工具读文档：默认画布读项目文档，子画布读子文档（项目级字段已合并进来）。 */
function readToolDoc(args) {
  const pid = String((args && args.projectId) || '');
  return readCanvasDoc(pid, toolCanvasId(args));
}
/** 工具写文档：默认画布写项目文档、子画布写子文档，并标记画布级变更信号。返回 canvasId。 */
function writeToolDoc(args, doc) {
  const pid = String((args && args.projectId) || '');
  const cid = toolCanvasId(args);
  writeCanvasDoc(pid, cid, doc);
  markDocChanged(pid, cid);
  return cid;
}
/** 删除项目的全部子画布文档（项目删除时清干净，避免残留行/文件被列出）。 */
function deleteCanvasDocsForProject(projectId) {
  const pid = String(projectId || '');
  if (!pid) return 0;
  let removed = 0;
  // 工作区内嵌项目：清 <home>/canvases/ 目录
  const home = wsProjectHome(pid);
  if (home) {
    const dir = path.join(home, 'canvases');
    let files = [];
    try { files = readdirSync(dir); } catch { return 0; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { unlinkSync(path.join(dir, f)); removed++; } catch { /* 文件占用/已删 */ }
    }
    return removed;
  }
  if (sqlActive()) {
    try {
      const db = getDb();
      const ids = db.prepare('SELECT id FROM projects WHERE instr(id, ?) > 0').all(CANVAS_ID_SEP).map((r) => r.id)
        .filter((id) => splitCanvasDocId(id).projectId === pid);
      const del = db.prepare('DELETE FROM projects WHERE id = ?');
      for (const id of ids) { try { del.run(id); removed++; } catch { /* 单行失败不影响其他 */ } }
    } catch { /* 清理失败不影响项目删除 */ }
    return removed;
  }
  try {
    for (const f of readdirSync(PROJECTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (!isCanvasDocId(id) || splitCanvasDocId(id).projectId !== pid) continue;
      try { unlinkSync(path.join(PROJECTS_DIR, f)); removed++; } catch { /* 文件占用/已删 */ }
    }
  } catch { /* 无目录 */ }
  return removed;
}
/** 读取设定集（对话侧"设定集先行"的前提）。 */
async function canvasGetBible(args) {
  const id = String((args && args.projectId) || '');
  const doc = readDoc(id);
  return { projectId: id, name: doc.name || id, bible: normalizeBible(doc.bible || {}), bibleUpdatedAt: doc.bibleUpdatedAt || 0 };
}
/**
 * 写入设定集：世界观/风格整体替换，角色/场景/道具默认按名称合并（同名更新、不存在则追加）；
 * mode='replace' 时条目整体替换。
 */
async function canvasUpdateBible(args) {
  const id = String((args && args.projectId) || '');
  const f = projectFile(id);
  const doc = readDoc(id);
  const cur = normalizeBible(doc.bible || {});
  const inc = (args && args.bible) || {};
  const mergeList = (base, incoming) => {
    if (incoming === undefined) return base;
    const list = (Array.isArray(incoming) ? incoming : [])
      .map((x) => ({
        name: String((x && x.name) || ''),
        desc: String((x && x.desc) || ''),
        // 资产绑定（assetIds）必须透传：设定集落地到数据目录时要携带"连接的资产信息"；
        // 未提供 assetIds 的合并不抹掉既有绑定（spread 只覆盖存在的键）
        ...(Array.isArray(x && x.assetIds) ? { assetIds: x.assetIds.map(String).filter(Boolean).slice(0, 20) } : {}),
      }))
      .filter((x) => x.name);
    if ((args && args.mode) === 'replace') return list;
    const out = [...base];
    for (const item of list) {
      const i = out.findIndex((x) => String(x.name).trim() === item.name.trim());
      if (i >= 0) out[i] = { ...out[i], ...item };
      else out.push(item);
    }
    return out;
  };
  const next = {
    worldview: inc.worldview !== undefined ? String(inc.worldview) : cur.worldview,
    style: inc.style !== undefined ? String(inc.style) : cur.style,
    styleAnchor: inc.styleAnchor !== undefined ? String(inc.styleAnchor) : cur.styleAnchor,
    characters: mergeList(cur.characters, inc.characters),
    scenes: mergeList(cur.scenes, inc.scenes),
    props: mergeList(cur.props, inc.props),
  };
  doc.bible = normalizeBible(next);
  doc.bibleUpdatedAt = Date.now();
  doc.updatedAt = Date.now();
  // 设定集更新后重算全部分镜表的一致性告警：否则节点上挂着过期告警，用户与对话侧都会被误导
  try {
    const assetNames = readAssetIndexNames(id);
    for (const nd of Object.values(doc.nodes || {})) {
      if (nd && nd.type === 'storyboard' && Array.isArray(nd.data && nd.data.shots) && nd.data.shots.length) {
        const nextW = storyboardConsistencyWarnings(doc.bible, nd.data.shots, assetNames);
        if (JSON.stringify(nextW) !== JSON.stringify(nd.data.warnings || [])) nd.data.warnings = nextW;
      }
    }
  } catch { /* 重算失败不影响设定集写入 */ }
  writeIcDoc(id, doc);
  markDocChanged(id);
  // 阶段机：设定集落盘 → 本画布阶段 ≥ bible（只抬高，不回退）
  try { PROD.noteStage(id, toolCanvasId(args), 'bible', 'update_bible'); } catch { /* 阶段机故障不阻塞主流程 */ }
  return { projectId: id, bible: doc.bible, bibleUpdatedAt: doc.bibleUpdatedAt };
}
/** 通用建节点（供对话建角色/场景/道具参考图等）；支持 script/text/image/video/storyboard/finalcut。
 *  image / video 是合并类型：有 assetId 即资产节点、有 prompt 即待生成的空节点；旧名
 *  image-gen / image-asset / video-gen / video-asset 仍接受，内部一律映射为合并类型。 */
function canvasCreateNode(args) {
  const id = String((args && args.projectId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const rawType = String((args && args.type) || 'text');
  const type = normalizeNodeType(rawType);
  if (!['script', 'text', 'image', 'video', 'audio', 'storyboard', 'finalcut'].includes(type)) throw new Error('不支持的节点类型: ' + rawType);
  const legacyType = rawType !== type ? rawType : '';
  const label = args && args.name ? String(args.name).slice(0, 40) : '';
  const prompt = String((args && args.prompt) || '');
  const assetId = String((args && args.assetId) || '').trim() || null;
  const connectFrom = String((args && args.connectFrom) || '');
  // G4 禁止逐镜节点：一致性靠参考图资产，不靠逐镜建点（高频走错路，这里直接封死）
  const g4 = PROD.gateShotNodeName(label, type);
  if (!g4.ok) {
    return { ok: false, gate: g4.code, projectId: id, ...(canvasId ? { canvasId } : {}), error: g4.error, fix: '改用规范资产命名（角色-<名> 设定图 / 场景-<名> / 道具-<名>），或为开场首帧建「<场次>-首帧」节点；确属用户明确要求逐镜节点时，向用户说明后果后再传 override:{by:\'user-explicit\',quote:\'用户原话\'} 重试' };
  }
  // 媒体节点：空态按「预览区比例 + 标题栏」给外框（没有操作栏就不加 NODE_FOOT_H），
  // 布点时用真实外框做碰撞检测，避免按 360×360 估小后与同列邻居重叠。
  const mediaSize = (type === 'image' || type === 'video')
    ? mediaNodeSize((args && args.ratio) || '16:9', false)
    : null;
  const pos = nextNodePos(doc, type, connectFrom, mediaSize);
  let connected = null;
  let autoConnected = null;
  let shotsGatePass = false; // 目标分镜表 shots 已过质量闸门（建点成功后据此抬升 shots_ready）
  let node;
  if (type === 'image') {
    node = agentNode('text', '', pos.x, pos.y, label || '图片节点');
    node.type = 'image';
    node.w = mediaSize.w; node.h = mediaSize.h;
    node.data = { ...node.data, status: assetId ? 'done' : 'idle', error: null, prompt, assetId: assetId || null, demo: false, size: (args && args.size) || '2K', ratio: (args && args.ratio) || '16:9', imageCount: 1 };
  } else if (type === 'video') {
    node = agentNode('text', '', pos.x, pos.y, label || '视频节点');
    node.type = 'video';
    node.w = mediaSize.w; node.h = mediaSize.h;
    // 多镜头工作流（结构性强制）：项目里已有**拆解过镜头**的分镜表 → 一律自动连线分镜表、prompt 忽略。
    // 一个分镜表 = 一个完整视频，镜头清单只从分镜表读取；对话侧手写 prompt 绕过分镜表是高频错误，这里直接封死。
    const sbs = Object.values(doc.nodes || {}).filter((n) => n.type === 'storyboard');
    const sbWithShots = sbs.filter((n) => Array.isArray(n.data && n.data.shots) && n.data.shots.length).pop() || null;
    const sbEmpty = sbs[sbs.length - 1] || null; // 存在但尚未拆解镜头
    const hasPrompt = Boolean(String(prompt || '').trim());
    const hasAsset = Boolean(assetId);
    let autoConnectId = '';
    let forced = false;
    if (!hasAsset && sbWithShots) {
      autoConnectId = sbWithShots.id; // 无论是否传 prompt：镜头清单只认分镜表
      forced = hasPrompt;
    } else if (!hasAsset && !hasPrompt && sbEmpty) {
      autoConnectId = sbEmpty.id; // 分镜表存在但 shots 为空：先连线占位（生成前需先拆解镜头）
    }
    // G2/G3：建视频节点前，目标分镜表的 shots 必须过质量闸门；且一个分镜表只允许一个视频节点。
    // 逃生舱：override:{by:'user-explicit',quote:'用户原话'}——用户明确要求时放行并记入审计。
    const sbTargetId = (connectFrom && doc.nodes[connectFrom] && doc.nodes[connectFrom].type === 'storyboard')
      ? connectFrom
      : autoConnectId;
    if (sbTargetId) {
      const ov = args && args.override;
      const ovOk = ov && ov.by === 'user-explicit' && String(ov.quote || '').trim();
      const g3 = PROD.gateOneVideoPerStoryboard(doc, sbTargetId);
      if (!g3.ok && !ovOk) {
        return { ok: false, gate: g3.code, projectId: id, ...(canvasId ? { canvasId } : {}), error: g3.error, existingVideoId: g3.existingVideoId, fix: '用 canvas_update_node 改现有视频节点的参数后重新生成；确需并排多个版本时，向用户说明后传 override:{by:\'user-explicit\',quote:\'用户原话\'}' };
      }
      const sbNode = doc.nodes[sbTargetId];
      const shots = sbNode && Array.isArray(sbNode.data && sbNode.data.shots) ? sbNode.data.shots : [];
      if (shots.length) {
        const g2 = PROD.gateStoryboard(shots);
        if (g2.ok) shotsGatePass = true;
        if (!g2.ok && !ovOk) {
          return { ok: false, gate: g2.code, projectId: id, ...(canvasId ? { canvasId } : {}), error: '分镜质量闸门未通过（' + g2.fails.length + ' 项）——分镜重生成不花钱，视频按秒计费，绝不带病生成', fails: g2.fails, warns: g2.warns || [], fix: 'canvas_run_node 重生成该分镜表，或 canvas_update_node 整表替换 shots 修复上述每一项；用户明确要求继续时传 override:{by:\'user-explicit\',quote:\'用户原话\'}' };
        }
        if (!g2.ok && ovOk) PROD.recordOverride(id, canvasId, 'G2', ov.quote, { node: label });
      }
      if (!g3.ok && ovOk) PROD.recordOverride(id, canvasId, 'G3', ov.quote, { node: label, storyboardId: sbTargetId });
    }
    node.data = { ...node.data, status: assetId ? 'done' : 'idle', error: null, prompt: hasAsset ? '' : (autoConnectId ? '' : prompt), assetId: assetId || null, demo: false, duration: Number(args && args.duration) || 5, resolution: (args && args.resolution) || '720P', ratio: (args && args.ratio) || '16:9' };
    autoConnected = autoConnectId ? { from: autoConnectId, ignoredPrompt: forced && hasPrompt, emptyShots: !sbWithShots && !!sbEmpty } : null;
  } else if (type === 'audio') {
    node = agentNode('text', '', pos.x, pos.y, label || '音频节点');
    node.type = 'audio';
    node.w = 360; node.h = 300;
    node.data = {
      ...node.data, status: assetId ? 'done' : 'idle', error: null, prompt: '', assetId: assetId || null,
      audioModel: '', voiceId: '', audioEmotion: 'auto', audioEmotionScale: '4', audioSpeechRate: '0', audioFormat: 'mp3',
      audioGain: 1, audioStart: 0, audioOffset: 0, audioDuration: 0, audioLoop: false, audioMute: false,
    };
  } else if (type === 'storyboard') {
    node = agentNode('text', '', pos.x, pos.y, label || '分镜表');
    node.type = 'storyboard';
    node.w = 360;
    // 连线与提示词**二选一**：创建时项目里已有剧本节点（无论是否已生成完）→ 自动连线到最新剧本节点，
    // 此时 prompt 被忽略（内容从连线取，最多用 requirement 加额外要求）。
    // 工作流=先规划后执行：先把节点和连线建好，再逐步 canvas_run_node。
    const scripts = Object.values(doc.nodes || {}).filter((n) => n.type === 'script');
    const autoScript = scripts.filter((n) => String((n.data && n.data.output) || '').trim()).pop() || scripts[scripts.length - 1] || null;
    const autoConnectId = connectFrom || (autoScript ? autoScript.id : '');
    node.data = { ...node.data, status: 'idle', error: null, script: autoConnectId ? '' : prompt, requirement: String((args && args.requirement) || ''), count: Number(args && args.count) || 0, shots: [], aiStatus: 'idle', aiError: null, warnings: [] };
    autoConnected = autoConnectId ? { from: autoConnectId, ignoredPrompt: Boolean(prompt && autoConnectId) } : null;
  } else if (type === 'finalcut') {
    node = agentNode('text', '', pos.x, pos.y, label || '成片');
    node.type = 'finalcut';
    node.w = 360; node.h = 360;
    node.data = { ...node.data, status: assetId ? 'done' : 'idle', error: null, resolution: (args && args.resolution) || '720P', ratio: (args && args.ratio) || '16:9', transition: 'none', progress: null, assetId: assetId || null, subs: {}, keepAudio: true };
  } else if (type === 'script') {
    node = agentNode('script', prompt, pos.x, pos.y, label || defaultLabel(prompt));
  } else {
    node = agentNode('text', prompt, pos.x, pos.y, label || defaultLabel(prompt));
  }
  doc.nodes[node.id] = node;
  // connectFrom：创建即连线（如分镜表连到上游剧本、image-gen 连到 shot/文本），一次调用完成建点+连线
  const explicitConnect = Boolean(connectFrom);
  if (connectFrom) {
    if (!doc.nodes[connectFrom]) throw new Error('connectFrom 指向的节点不存在: ' + connectFrom);
    // 分镜表默认连「剧本来源」口（script），而不是输入队列里的第一个口（prev）——场景文本是剧本来源，不是承接来源
    const srcType = doc.nodes[connectFrom] && doc.nodes[connectFrom].type;
    const defaultToPort = (type === 'storyboard' && (srcType === 'text' || srcType === 'script')) ? 'script' : undefined;
    const edge = connectEdge(doc, connectFrom, node.id, args && args.connectFromPort, (args && args.connectToPort) || defaultToPort);
    connected = edge.id;
  } else if (autoConnected && (type === 'storyboard' || type === 'video')) {
    // 未指定连线但上游已存在（分镜表→剧本 / 视频节点→分镜表）→ 默认自动连线（工作流的默认形态，不依赖 Agent 记得）
    const edge = connectEdge(doc, autoConnected.from, node.id, undefined, type === 'storyboard' ? 'script' : undefined);
    connected = edge.id;
  }
  doc.updatedAt = Date.now();
  writeToolDoc(args, doc);
  // 阶段机：剧本/分镜表节点落盘 → 阶段 ≥ script / storyboard（只抬高；shots_ready 由运行/状态汇报再抬）
  try {
    if (type === 'script') PROD.noteStage(id, canvasId, 'script', 'create_script_node');
    else if (type === 'storyboard') PROD.noteStage(id, canvasId, 'storyboard', 'create_storyboard_node');
    // 建视频节点时目标分镜表已过质量闸门 → shots_ready（这是"分镜定稿"的机器证据）
    if (type === 'video' && shotsGatePass) PROD.noteStage(id, canvasId, 'shots_ready', 'create_video_gate_pass');
  } catch { /* 阶段机故障不阻塞建点 */ }
  const note = autoConnected && autoConnected.ignoredPrompt
    ? (type === 'video'
      ? '⚠️ 已强制连线到分镜表（多镜头工作流：一个分镜表 = 一个完整视频，镜头清单从分镜表读取），传入的 prompt 已忽略——不要手写视频提示词绕过分镜表。'
      : '已自动连线到上游剧本节点，传入的 prompt 被忽略（内容从连线取）。')
    : (autoConnected && autoConnected.emptyShots
      ? '已连线到分镜表；该分镜表尚未拆解镜头（shots 为空）——先 canvas_run_node 分镜表生成镜头，再生成视频。'
      : '');
  return {
    ok: true, projectId: id, ...(canvasId ? { canvasId } : {}), nodeId: node.id, type: node.type, label: (node.data && node.data.label) || '',
    edgeId: connected || undefined, note: note || undefined,
    // 旧名（image-gen / image-asset / video-gen / video-asset）已映射为合并节点：明确告诉 Agent 实际类型
    mergedType: legacyType ? (legacyType + ' → ' + node.type + '（合并节点：有 assetId 即资产，空节点在画布点开面板生成）') : undefined,
  };
}

/** 一键重排：按「行」布局——横向数据流决定列，竖向端口（prev/frame）不参与分列；
 *  每行 = 一个横向连通分量（如「场N文本 ↔ 场N分镜表」），行内同 y 横向配对，
 *  行高取行内最高节点、行间保留间距，绝不重叠。 */
function canvasRelayout(args) {
  const id = String((args && args.projectId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const all = Object.values(doc.nodes || {});
  // pinned 节点：用户/对话精摆过的位置，重排绝不覆盖（它也不参与分列与相对排序）
  const nodes = all.filter((n) => !(n.data && n.data.pinned));
  const skippedPinned = all.length - nodes.length;
  if (!nodes.length) return { ok: true, projectId: id, ...(canvasId ? { canvasId } : {}), moved: 0, rows: 0, skippedPinned };
  const VERT = new Set(['prev', 'frame']);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let i = 0; i < 12; i++) {
    for (const e of (doc.edges || [])) {
      if (VERT.has(String(e.toPort))) continue;
      if (!byId.has(e.fromNode) || !byId.has(e.toNode)) continue;
      const d = (depth.get(e.fromNode) || 0) + 1;
      if ((depth.get(e.toNode) || 0) < d) depth.set(e.toNode, d);
    }
  }
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x) => { let y = x; while (parent.get(y) !== y) y = parent.get(y); return y; };
  for (const e of (doc.edges || [])) {
    if (VERT.has(String(e.toPort))) continue;
    if (!byId.has(e.fromNode) || !byId.has(e.toNode)) continue;
    const a = find(e.fromNode); const b = find(e.toNode);
    if (a !== b) parent.set(b, a);
  }
  const rows = new Map();
  for (const n of nodes) {
    const r = find(n.id);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(n);
  }
  const rowList = [...rows.values()]
    .map((ids) => ({ ids, minY: Math.min(...ids.map((n) => Number(n.y) || 0)) }))
    .sort((a, b) => a.minY - b.minY);
  const colW = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id) || 0;
    colW.set(d, Math.max(colW.get(d) || 280, Number(n.w) || 280));
  }
  const colX = new Map();
  let cx = 80;
  for (const d of [...colW.keys()].sort((a, b) => a - b)) { colX.set(d, cx); cx += (colW.get(d) || 280) + 60; }
  // 分带排列（0.20.0）：一行 = 一个横向连通簇；行内按深度分列，**同深度的兄弟节点纵向堆叠**
  // （行高 = 各列堆叠高度的最大值），避让 pinned 节点；行自上而下堆，超过带高上限换右边新带。
  // 旧实现行内所有节点同一个 y → 分支结构（一上游连多个下游）会整叠重合。
  const MAX_BAND_H = 1800, BAND_GAP = 160, ROW_GAP = 40, SIB_GAP = 24;
  // pinned 作为障碍物：并列摆放时不得覆盖它们
  const obstacles = all
    .filter((n) => n.data && n.data.pinned)
    .map((n) => ({ x: Number(n.x) || 0, y: Number(n.y) || 0, w: Number(n.w) || 360, h: Number(n.h) || 360 }));
  let bandX = 80, bandY = 40, bandMaxW = 0, bandH = 0;
  let moved = 0;
  for (const row of rowList) {
    const rowW = Math.max(...row.ids.map((n) => (colX.get(depth.get(n.id) || 0) || 80) + (Number(n.w) || 280))) - 80;
    // 行内按深度分列；每列内部按原 y 顺序堆叠
    const lanes = new Map();
    for (const n of row.ids) {
      const d = depth.get(n.id) || 0;
      if (!lanes.has(d)) lanes.set(d, []);
      lanes.get(d).push(n);
    }
    for (const lane of lanes.values()) lane.sort((a, b) => ((Number(a.y) || 0) - (Number(b.y) || 0)) || ((Number(a.x) || 0) - (Number(b.x) || 0)));
    let rowH = 200;
    for (const lane of lanes.values()) {
      const hSum = lane.reduce((a, n) => a + (Number(n.h) || 200) + SIB_GAP, 0) - SIB_GAP;
      rowH = Math.max(rowH, hSum);
    }
    // 避让钉住节点：整行下移，直到与任何 pinned 矩形不相交（上限 20 次防死循环）
    for (let guard = 0; guard < 20; guard++) {
      const bad = obstacles.some((o) => bandX < o.x + o.w && o.x < bandX + rowW && bandY < o.y + o.h && o.y < bandY + rowH);
      if (!bad) break;
      const pushTo = Math.max(...obstacles
        .filter((o) => bandX < o.x + o.w && o.x < bandX + rowW && bandY < o.y + o.h && o.y < bandY + rowH)
        .map((o) => o.y + o.h + ROW_GAP));
      bandY = pushTo;
    }
    if (bandH > 0 && bandH + ROW_GAP + rowH > MAX_BAND_H) {
      bandX += bandMaxW + BAND_GAP; bandY = 40; bandH = 0; bandMaxW = 0;
      // 新带起点也可能压在 pinned 上：同样下移避让
      for (let guard = 0; guard < 20; guard++) {
        const bad = obstacles.some((o) => bandX < o.x + o.w && o.x < bandX + rowW && bandY < o.y + o.h && o.y < bandY + rowH);
        if (!bad) break;
        bandY = Math.max(...obstacles
          .filter((o) => bandX < o.x + o.w && o.x < bandX + rowW && bandY < o.y + o.h && o.y < bandY + rowH)
          .map((o) => o.y + o.h + ROW_GAP));
      }
    }
    for (const [d, lane] of lanes) {
      let ly = bandY;
      for (const n of lane) {
        n.x = bandX + ((colX.get(d) || 80) - 80);
        n.y = ly;
        ly += (Number(n.h) || 200) + SIB_GAP;
        moved++;
      }
    }
    bandY += rowH + ROW_GAP;
    bandH += rowH + ROW_GAP;
    bandMaxW = Math.max(bandMaxW, rowW);
  }
  doc.updatedAt = Date.now();
  writeToolDoc(args, doc);
  return { ok: true, projectId: id, ...(canvasId ? { canvasId } : {}), moved, rows: rowList.length, skippedPinned };
}

/** 整画布几何视图（0.20.0）：对话侧据此精确计算每个节点该放哪（x/y/w/h + pinned + 包围盒）。 */
function canvasLayoutGet(args) {
  const pid = String((args && args.projectId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const nodes = Object.values(doc.nodes || {}).map((n) => ({
    nodeId: n.id,
    name: String((n.data && n.data.label) || n.id).slice(0, 60),
    type: n.type,
    x: Math.round(Number(n.x) || 0),
    y: Math.round(Number(n.y) || 0),
    w: Math.round(Number(n.w) || 360),
    h: Math.round(Number(n.h) || 360),
    pinned: !!(n.data && n.data.pinned),
  }));
  const bounds = nodes.length
    ? {
        minX: Math.min(...nodes.map((n) => n.x)), minY: Math.min(...nodes.map((n) => n.y)),
        maxX: Math.max(...nodes.map((n) => n.x + n.w)), maxY: Math.max(...nodes.map((n) => n.y + n.h)),
      }
    : null;
  return { ok: true, projectId: pid, ...(canvasId ? { canvasId } : {}), count: nodes.length, bounds, nodes };
}

/** 精准摆放（0.20.0）：批量设置节点坐标（媒体节点可同时改尺寸），pinned 钉住防 relayout 覆盖。
 *  允许重叠——精确摆放是调用方明确意图，不做碰撞拒绝。 */
function canvasLayoutNode(args) {
  const pid = String((args && args.projectId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const list = (args && args.nodes) || [];
  if (!Array.isArray(list) || !list.length) throw new Error('nodes 需要非空数组：[{ nodeId, x, y, w?, h?, pinned? }]');
  const applied = [];
  for (const item of list) {
    const nodeId = String((item && item.nodeId) || '');
    const n = doc.nodes[nodeId];
    if (!n) throw new Error('节点不存在: ' + nodeId + '（先 canvas_layout_get 拿全图坐标）');
    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(nodeId + ' 的 x/y 必须是有限数字（可为负）');
    n.x = Math.round(x);
    n.y = Math.round(y);
    const entry = { nodeId, x: n.x, y: n.y };
    if (item.w !== undefined || item.h !== undefined) {
      const isMedia = n.type === 'image' || n.type === 'video';
      if (!isMedia) throw new Error(nodeId + '（' + n.type + '）不支持改尺寸：只有 image/video 媒体节点可设 w/h');
      // 媒体节点预览区必须保持画面比例（normalizeMediaNodeSize 会强制）：只给一维时按比例补另一维，
      // 两维都给了就必须与比例一致（误差 ≤2%），否则明确拒绝而不是被静默重置。
      const d = n.data || {};
      const ratio = mediaRatioOf(n);
      const [rw, rh] = String(ratio).split(':').map(Number);
      const chrome = NODE_HDR_H + (d.assetId ? NODE_FOOT_H : 0);
      let w = item.w !== undefined ? Number(item.w) : null;
      let h = item.h !== undefined ? Number(item.h) : null;
      if (w !== null && h === null) {
        if (!Number.isFinite(w) || w < 160) throw new Error(nodeId + ' 的 w 非法（≥160）');
        h = Math.round((w * rh) / rw + chrome);
      } else if (h !== null && w === null) {
        if (!Number.isFinite(h) || h - chrome < 120) throw new Error(nodeId + ' 的 h 非法（预览高 ≥120）');
        w = Math.round(((h - chrome) * rw) / rh);
      } else {
        const ph = h - chrome;
        const okRatio = Number.isFinite(w) && Number.isFinite(h) && ph > 0 && Math.abs(w / ph - rw / rh) / (rw / rh) <= 0.02;
        if (!okRatio) {
          throw new Error(nodeId + ' 的 w/h 与画面比例 ' + ratio + ' 不匹配：只传 w 或只传 h 会自动按比例补齐（例如 w=520 → h=' + Math.round((520 * rh) / rw + chrome) + '）');
        }
      }
      n.w = Math.round(w);
      n.h = Math.round(h);
      entry.w = n.w;
      entry.h = n.h;
    }
    if (item.pinned !== undefined) {
      n.data = n.data || {};
      n.data.pinned = !!item.pinned;
      entry.pinned = !!n.data.pinned;
    }
    applied.push(entry);
  }
  doc.updatedAt = Date.now();
  writeToolDoc(args, doc);
  return { ok: true, projectId: pid, ...(canvasId ? { canvasId } : {}), applied, moved: applied.length };
}
async function canvasDeleteProject(args) {
  const id = String((args && args.projectId) || '');
  // G5 破坏性操作确认：删项目不可逆（全部画布/资产/记忆）。必须携带用户确认原话，写入审计。
  const g5quote = String((args && args.confirm) || '').trim();
  if (!g5quote) {
    return { ok: false, gate: 'G5', projectId: id, error: '删除项目是破坏性操作（全部画布、资产与记忆一并删除，不可恢复）。仅当用户明确要求删除整个项目时才执行：调用时必须携带 confirm 参数（填用户的确认原话）。', fix: '向用户确认后，携带 confirm 重试同一调用' };
  }
  try { PROD.recordOverride(id, null, 'G5', g5quote, { op: 'delete_project' }); } catch { /* 审计失败不阻塞 */ }
  let name = id;
  const prevDoc = readDocOrNull(id);
  if (prevDoc && prevDoc.name) name = prevDoc.name;
  let cleanup = null;
  if (sqlActive()) {
    // BLK-01：与 projectsDelete 共用同一清理实现（行 + FTS + 资产文件 + 镜像目录）
    cleanup = sqlDeleteProjectRows(getDb(), id, dataRoot());
  } else {
    try { unlinkSync(projectFile(id)); } catch { /* 已删除 */ }
    try { deleteCanvasDocsForProject(id); } catch { /* 子画布清理失败不影响删除 */ }
    try { removeDataRootProject(id); } catch { /* 数据目录镜像清理失败不影响删除 */ }
  }
  // 通知客户端把这个项目也从本地删掉，否则下次推送会把它复活 + 长效墓碑：拒收迟到的推送
  const cfg = readIcConfig();
  const prev = (cfg.ui && cfg.ui.deletedProjects) || [];
  // 防御：config 里可能根本没有 ui 段（新装/被手工清空）——直接解引用 cfg.ui 会 TypeError 打断删除
  const prevTomb = Array.isArray(cfg.ui && cfg.ui.deletedProjectIds) ? cfg.ui.deletedProjectIds : [];
  cfg.ui = {
    ...(cfg.ui || {}),
    deletedProjects: [...new Set([...prev, id])].slice(-50),
    deletedProjectIds: [...new Set([...prevTomb, id])].slice(-200),
  };
  writeIcConfig(cfg);
  return { ok: true, projectId: id, name, disk: cleanup };
}
async function canvasDeleteNode(args) {
  const id = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const canvasId = toolCanvasId(args);
  // G5 破坏性操作确认：删除不可逆（连带连线）。必须携带用户确认原话，写入审计。
  const g5quote = String((args && args.confirm) || '').trim();
  if (!g5quote) {
    return { ok: false, gate: 'G5', projectId: id, ...(canvasId ? { canvasId } : {}), nodeId, error: '删除是破坏性操作（节点连同连线，不可恢复）。仅当用户明确要求删除时才执行：调用时必须携带 confirm 参数（填用户的确认原话，如 confirm:\'把这场视频删掉\'）。改内容/改参数请用 canvas_update_node，不需要删除。', fix: '向用户确认后，携带 confirm 重试同一调用' };
  }
  try { PROD.recordOverride(id, canvasId, 'G5', g5quote, { op: 'delete_node', nodeId }); } catch { /* 审计失败不阻塞 */ }
  const doc = readToolDoc(args);
  if (!doc.nodes[nodeId]) throw new Error('节点不存在: ' + nodeId);
  delete doc.nodes[nodeId];
  doc.edges = (doc.edges || []).filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId);
  doc.tombstones = [...new Set([...(doc.tombstones || []), nodeId])].slice(-100);
  doc.tombstoneAt = { ...(doc.tombstoneAt || {}), [nodeId]: Date.now() }; // 记录墓碑创建时刻：撤销恢复的推送（ts 更新）才允许清墓碑
  doc.updatedAt = Date.now();
  writeToolDoc(args, doc);
  return { ok: true, projectId: id, ...(canvasId ? { canvasId } : {}), nodeId };
}
/** 运行节点：写一次性请求，画布客户端轮询消费后用画布内配置的模型/接口真实执行。 */
async function canvasRunNode(args) {
  const pid = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const node = doc.nodes[nodeId];
  if (!node) throw new Error('节点不存在: ' + nodeId);
  // ── 流程闸门（0.20.0）：只拦"生成"与"花钱"，不拦节点搭建。逃生舱见各 fix 字段。 ──
  {
    const ov = args && args.override;
    const ovOk = ov && ov.by === 'user-explicit' && String(ov.quote || '').trim();
    // G1 设定集先行：剧本/分镜表**生成内容**前必须有世界观+风格+≥1 角色
    if (node.type === 'script' || node.type === 'storyboard') {
      const g1 = PROD.gateBible(doc.bible);
      if (!g1.ok && !ovOk) {
        return { ok: false, gate: g1.code, projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, missing: g1.missing, error: '设定集先行：' + g1.missing.join('、') + ' 尚未补全——先 canvas_get_bible 读现状、canvas_update_bible 补全后再生成。跨镜一致性全靠它。', fix: 'canvas_update_bible 补全缺失项（用户已给创意按其创意写，不要另起一套）；用户明确说"先随便生成"时传 override:{by:\'user-explicit\',quote:\'用户原话\'}' };
      }
      if (!g1.ok && ovOk) PROD.recordOverride(pid, canvasId, 'G1', ov.quote, { node: node.type });
    }
    // G2/G6 视频生成：镜头清单必须来自已过闸门的分镜表；自由 prompt 视频（无分镜上游）不受此限
    if (node.type === 'video') {
      const sbEdge = (doc.edges || []).filter((e) => e && e.toNode === nodeId && doc.nodes[e.fromNode] && doc.nodes[e.fromNode].type === 'storyboard').pop();
      const sbNode = sbEdge ? doc.nodes[sbEdge.fromNode] : null;
      if (sbNode) {
        const shots = Array.isArray(sbNode.data && sbNode.data.shots) ? sbNode.data.shots : [];
        const g2 = PROD.gateStoryboard(shots);
        if (!g2.ok && !ovOk) {
          return { ok: false, gate: g2.code, projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, error: '分镜质量闸门未通过（' + g2.fails.length + ' 项）——分镜重生成不花钱，视频按秒计费，绝不带病生成', fails: g2.fails, warns: g2.warns || [], fix: 'canvas_run_node 重生成该分镜表，或 canvas_update_node 整表替换 shots；用户明确要求继续时传 override:{by:\'user-explicit\',quote:\'用户原话\'}' };
        }
        if (!g2.ok && ovOk) PROD.recordOverride(pid, canvasId, 'G2', ov.quote, { nodeId });
        if (g2.ok) { try { PROD.noteStage(pid, canvasId, 'shots_ready', 'storyboard_gate_pass'); } catch { /* 忽略 */ } }
        const g6 = PROD.gateStage(pid, canvasId, 'shots_ready');
        if (!g6.ok && !ovOk) {
          return { ok: false, gate: g6.code, projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, error: '阶段越序：当前阶段「' + g6.at + '」尚未到达「shots_ready」——先完成分镜并通过质量闸门，再触发视频生成（视频按秒计费）。', fix: '用 canvas_production_status 查看缺口；用户明确要求跳过时传 override:{by:\'user-explicit\',quote:\'用户原话\'}' };
        }
        if (!g6.ok && ovOk) PROD.recordOverride(pid, canvasId, 'G6', ov.quote, { nodeId });
      }
    }
  }
  const cfg = readIcConfig();
  cfg.ui = { ...(cfg.ui || {}), runRequest: { projectId: pid, canvasId, nodeId, at: Date.now() } };
  writeIcConfig(cfg);
  // 阶段机：视频触发 → ≥ generating
  try { if (node.type === 'video') PROD.noteStage(pid, canvasId, 'generating', 'video_run'); } catch { /* 忽略 */ }
  return { ok: true, projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, type: node.type, label: (node.data && node.data.label) || '' };
}
/** 读取节点运行状态与产物（画布执行完成后会把结果推回 Host 文档）。 */
/** 分镜一致性检查（与客户端 checkShotConsistency 同规则，Host 供状态查询/设定集更新后重算）：
 *  检查 shots 的角色/场景/道具数组 **以及 visual/motion 文本里的 @提及** 是否都在设定集登记；
 *  两级告警：「未登记」（设定集/资产都没有）与「已登记但描述为空」（待补全）。
 *  台词碎片豁免：名字以「的」结尾且出现在对白文本里的角色/场景/道具视为描述性片段（如台词
 *  「来了个带纸的」被抽成道具「带纸的」），未登记不告警——与客户端 client.js
 *  checkShotConsistency 同规则，两边必须字面同构（防漂移）。 */
function storyboardConsistencyWarnings(bible, shots, extraNames) {
  const entries = [];
  const addEntry = (kind, name, desc) => {
    const nm = String(name || '').trim();
    if (nm) entries.push({ kind, name: nm, desc: String(desc || ''), lower: nm.toLowerCase() });
  };
  (bible.characters || []).forEach((c) => addEntry('角色', c && c.name, c && c.desc));
  (bible.scenes || []).forEach((c) => addEntry('场景', c && c.name, c && c.desc));
  (bible.props || []).forEach((c) => addEntry('道具', c && c.name, c && c.desc));
  const known = new Set(entries.map((e) => e.lower).concat((extraNames || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean)));
  const warnings = [];
  const seen = new Set();
  const warn = (line) => { if (!seen.has(line) && warnings.length < 12) { seen.add(line); warnings.push(line); } };
  // 台词碎片收集（与客户端 client.js checkShotConsistency 同规则——两边必须字面同构，防漂移）：
  // 拼接同 shots 数组内全部对白文本；shots 无 dialogue 字段（旧数据）时按「无对白可查」自然不跳过。
  let dialogueAll = '';
  for (const sh of shots || []) {
    for (const d of ((sh && sh.dialogue) || [])) dialogueAll += ' ' + String((d && d.line) || '');
  }
  const check = (title, kind, name, entity) => {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return;
    const exact = entries.find((e) => e.lower === q);
    if (exact) {
      if (!exact.desc.trim()) warn(`${title} · ${kind}「${exact.name}」已登记但描述为空（待补全）`);
      return;
    }
    // 台词碎片跳过：仅 角色/场景/道具 三类（entity=true）；@提及 通道绝不跳过，「已登记但描述为空」路径（上方）不跳过
    if (entity && String(name || '').trim().endsWith('的') && dialogueAll.includes(String(name || '').trim())) return;
    for (const k of known) { if (k.includes(q) || q.includes(k)) return; }
    warn(`${title} · ${kind}「${String(name).trim()}」未在设定集中登记`);
  };
  for (const sh of shots || []) {
    const title = String((sh && sh.title) || '').trim() || '分镜';
    for (const nm of (sh.characters || [])) check(title, '角色', nm, true);
    check(title, '场景', sh && sh.scene, true);
    for (const nm of (sh.props || [])) check(title, '道具', nm, true);
    // visual/motion 文本里的 @资产名@ 提及同样纳入检查（未登记的提示补充——与客户端 parseMentions 词法一致）
    const text = String((sh && sh.visual) || '') + ' ' + String((sh && sh.motion) || '');
    const seenMention = new Set();
    for (const m of (text.match(/@([^@\s，。；：、,.;:!?！？()（）[\]【】"'“”<>《》/\\|]{1,64}?)@/g) || [])) {
      const nm = m.replace(/^@/, '').replace(/@$/, '');
      if (seenMention.has(nm)) continue;
      seenMention.add(nm);
      check(title, '提及', nm, false);
    }
  }
  return warnings;
}
/** 取资产名（SQL 模式查 assets 表；JSON 模式读数据目录索引；与客户端"设定集/资产中登记"的判定口径对齐）。 */
function readAssetIndexNames(pid) {
  if (!pid) return [];
  if (sqlActive()) {
    try {
      const db = getDb();
      return db.prepare('SELECT name FROM assets WHERE project_id = ?').all(pid).map((r) => r.name).filter(Boolean);
    } catch { return []; }
  }
  const root = dataRoot();
  if (!root) return [];
  try {
    const entry = readDataRootMeta().projects.find((p) => p.id === pid);
    if (!entry) return [];
    const list = JSON.parse(readFileSync(path.join(root, 'projects', entry.folder, 'assets.json'), 'utf8'));
    return Array.isArray(list) ? list.map((x) => x && x.name).filter(Boolean) : [];
  } catch { return []; }
}
async function canvasNodeStatus(args) {
  const pid = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const n = doc.nodes[nodeId];
  if (!n) throw new Error('节点不存在: ' + nodeId);
  // 分镜表：返回镜头清单（结构化）——对话侧据此组织视频提示词，绝不自行推导/编造镜头表
  const shots = (n.type === 'storyboard' && Array.isArray(n.data && n.data.shots))
    ? n.data.shots.map((s, i) => ({
      index: i + 1,
      title: String((s && s.title) || '').slice(0, 60),
      duration: Number(s && s.duration) || 0,
      visual: String((s && s.visual) || '').slice(0, 400),
      motion: String((s && s.motion) || '').slice(0, 300),
      characters: Array.isArray(s && s.characters) ? s.characters.map(String) : [],
      scene: String((s && s.scene) || '').slice(0, 100),
      props: Array.isArray(s && s.props) ? s.props.map(String) : [],
      // 台词标注：声音参考提取/对话侧对白定位的数据源
      dialogue: Array.isArray(s && s.dialogue)
        ? s.dialogue.slice(0, 6).map((d) => ({ role: String(d && d.role || '').slice(0, 24), line: String(d && d.line || '').slice(0, 200) }))
        : [],
      // 音效/环境音：声音设计提示，随镜头透出给对话侧与视频提示词
      sfx: String((s && s.sfx) || '').slice(0, 120),
      // 分镜衔接（分段生成的接戏依据）：接点尾态/运镜延续/起始态/段落类型——对话侧改写 shots 时必须一起带回
      tail: String((s && s.tail) || '').slice(0, 160),
      cam: String((s && s.cam) || '').slice(0, 120),
      start: String((s && s.start) || '').slice(0, 160),
      seg: String((s && s.seg) || '').slice(0, 24),
      // 新四字段（与分镜契约同构）：动作节拍/机位三件套/特效/负向词——对话侧整表替换时必须带回
      timeBeats: Array.isArray(s && s.timeBeats) ? s.timeBeats.map(String).slice(0, 4) : [],
      camera: String((s && s.camera) || '').slice(0, 200),
      vfx: String((s && s.vfx) || '').slice(0, 160),
      negative: String((s && s.negative) || '').slice(0, 200),
      // 战斗因果字段（打斗镜专用，全部可选）：node_status 必须透出，否则对话侧读回再写回时会丢失
      attack: String((s && s.attack) || '').slice(0, 160),
      reaction: String((s && s.reaction) || '').slice(0, 160),
      impact: String((s && s.impact) || '').slice(0, 160),
      initiative: String((s && s.initiative) || '').slice(0, 80),
      nextCombat: String((s && s.nextCombat) || '').slice(0, 80),
    }))
    : undefined;
  const d = n.data || {};
  // 阶段机：读取即观测——分镜出镜头且过质量闸 → shots_ready；剧本有成稿 → script；视频完成 → qc；成片完成 → post。
  // stage 随每次状态轮询返回：模型随时知道"自己在哪一步"，不需要额外调用。
  let productionStage = null;
  try {
    if (n.type === 'storyboard' && Array.isArray(d.shots) && d.shots.length && PROD.gateStoryboard(d.shots).ok) {
      PROD.noteStage(pid, canvasId, 'shots_ready', 'storyboard_shots_ok');
    } else if (n.type === 'script' && String(d.output || '').trim()) {
      PROD.noteStage(pid, canvasId, 'script', 'script_output');
    } else if (n.type === 'video' && String(d.status) === 'done') {
      PROD.noteStage(pid, canvasId, 'qc', 'video_done');
    } else if (n.type === 'finalcut' && String(d.status) === 'done') {
      PROD.noteStage(pid, canvasId, 'post', 'finalcut_done');
    }
    const st = PROD.stageOf(pid, canvasId);
    productionStage = { stage: st.stage, stageZh: PRODUCTION_STAGE_ZH[st.stage] || st.stage };
  } catch { /* 阶段机故障不影响状态读取 */ }
  return {
    projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, type: n.type, label: d.label || '',
    status: d.status || 'idle',
    aiStatus: d.aiStatus || 'idle',
    // 制作阶段（0.20.0 阶段机）：brief/bible/assets/script/storyboard/shots_ready/generating/qc/post/delivered
    stage: productionStage ? productionStage.stage : undefined,
    stageZh: productionStage ? productionStage.stageZh : undefined,
    // 布局事实：坐标与外框尺寸只读透出（改布局走 canvas_relayout；canvas_update_node 仍禁改结构字段）
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    w: Number(n.w) || 0,
    h: Number(n.h) || 0,
    // 文档级时间戳：canvas_generate_node 的等待循环用它区分「本轮真的跑过」与「上一次的残留终态」
    docUpdatedAt: Number(doc.updatedAt) || 0,
    error: d.error || d.aiError || null,
    output: String(d.output || '').slice(0, 6000),
    idea: String(d.idea || '').slice(0, 2000),
    // 生成节点的对话框提示词与生成参数：对话侧读取后可精准改写（配合 canvas_update_node），不必删节点重建
    prompt: String(d.prompt || '').slice(0, 4000),
    text: String(d.text || '').slice(0, 4000),
    script: String(d.script || '').slice(0, 2000),
    requirement: String(d.requirement || '').slice(0, 1000),
    ratio: d.ratio || null,
    size: d.size || null,
    duration: d.duration == null ? null : Number(d.duration),
    resolution: d.resolution || null,
    frameMode: d.frameMode || null,
    count: d.count == null ? null : Number(d.count),
    // 分镜节点参数（0.20.5 对话侧读面补注册）：总时长硬约束与打斗判定三态——
    // update_node 白名单里有写面、这里必须有读面，否则对话侧读不回、shots 整表替换场景丢语义
    targetDuration: d.targetDuration == null ? null : Number(d.targetDuration),
    combatMode: d.combatMode || null,
    cont: d.cont === false ? false : true,
    imageModel: d.imageModel || null,
    videoModel: d.videoModel || null,
    model: d.model || null,
    stopNote: d.stopNote || null,
    genWarn: d.genWarn || null,
    lastAssetId: d.lastAssetId || null,
    // 尾帧「最佳选帧」（续帧接力首选：动作进行中/清晰/不抖）
    tailPickAssetId: d.lastPickAssetId || null,
    tailPick: d.tailPickMeta || null,
    // 续帧来源：'wired'=首帧来自 frame 连线；节点 id=自动取上一段视频尾帧
    chainFrom: d.chainFrom || null,
    // 接缝校验：{ ok, sim, thr, note }——同场续帧阈值 0.55 / 跨场 0.35 / 特写插入 0.15
    seam: d.seam || null,
    historyAssetIds: Array.isArray(d.history) ? d.history.map((x) => x && x.assetId).filter(Boolean).slice(-20) : [],
    assetId: d.assetId || null,
    // 视频任务凭据：中断/超时后对话侧可凭 id 回查结果（钱花了就必须能找回）
    taskId: d.taskId || null,
    taskQueryUrl: d.taskQueryUrl || null,
    // 分镜表：一致性告警随状态返回——对话侧据此逐条补全设定集（缺失则要自动补充，绝不忽略）
    warnings: Array.isArray(d.warnings) ? d.warnings : [],
    shots,
  };
}
/** 可被 canvas_update_node 修改的节点字段白名单（结构字段 id/type/x/y/w/h/data 一律不可写）。 */
const NODE_PATCH_FIELDS = ['prompt', 'idea', 'output', 'text', 'script', 'requirement', 'label', 'ratio', 'size', 'duration', 'resolution', 'frameMode', 'count', 'imageModel', 'videoModel', 'model', 'cont', 'targetDuration', 'combatMode', 'assetId'];
/** 更新已有节点的字段：对话侧"改提示词 / 改参数"的唯一入口（此前只能删节点重建）。 */
function canvasUpdateNode(args) {
  const pid = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const n = doc.nodes[nodeId];
  if (!n) throw new Error('节点不存在: ' + nodeId + '（先用 canvas_list_projects 查看节点 id）');
  const patch = (args && args.patch) || {};
  const keys = Object.keys(patch);
  if (!keys.length && patch.shots === undefined) throw new Error('patch 为空：请给出要修改的字段，如 { "prompt": "……" }');
  const applied = [];
  const skipped = [];
  for (const k of keys) {
    if (k === 'shots') continue; // 单独处理
    if (!NODE_PATCH_FIELDS.includes(k)) { skipped.push(k); continue; }
    let v = patch[k];
    if (k === 'duration' || k === 'count') {
      const num = Number(v);
      // count 允许 0（=自动按内容节拍，与 canvasCreateNode 的语义一致）；duration 必须正数
      if (!Number.isFinite(num) || num < 0 || (k === 'duration' && num <= 0)) {
        throw new Error(k + (k === 'count' ? ' 需要非负数（0=自动按内容节拍）' : ' 需要正数') + '，收到：' + JSON.stringify(v));
      }
      v = k === 'count' ? Math.round(num) : num;
    } else if (k === 'label') {
      v = String(v == null ? '' : v).slice(0, 40);
    } else if (k === 'cont') {
      v = !(v === false || v === 'false' || v === 0 || v === '0'); // 分镜衔接开关：默认开
    } else if (k === 'targetDuration') {
      // 分镜总时长（秒，一位小数）：0/空 = 自动档（按镜头节奏）。与客户端 setData('targetDuration') 同口径。
      const num = Math.round(Number(v) * 10) / 10;
      if (!Number.isFinite(num) || num < 0 || num > 300) throw new Error('targetDuration 需要非负数（0=自动档，上限 300s），收到：' + JSON.stringify(v));
      v = num || null;
    } else if (k === 'combatMode') {
      // 打斗判定三态覆盖：auto=按场检测（缺省）/ on=本场强制按打斗注入 / off=强制不注入
      v = ['auto', 'on', 'off'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : 'auto';
    } else if (k === 'assetId') {
      v = String(v == null ? '' : v).trim() || null;
    } else {
      v = String(v == null ? '' : v);
    }
    n.data[k] = v;
    if (k === 'assetId' && v) { n.data.status = 'done'; n.data.error = null; n.data.demo = false; }
    applied.push(k);
  }
  if (patch.shots !== undefined) {
    let arr = patch.shots;
    if (typeof arr === 'string') {
      try { arr = JSON.parse(arr); } catch { throw new Error('shots 需要 JSON 数组或 JSON 字符串'); }
    }
    if (!Array.isArray(arr)) throw new Error('shots 需要 JSON 数组');
    // shots 是**整表替换**：只改一镜也必须先把全量读出来再传回（否则其它镜的 tail/cam 会被冲掉）。
    // 这里做两层兜底：① 合法的 seg 取值归一化 ② 旧表里有衔接字段而新值没给时，按镜序保留旧值。
    const oldShots = Array.isArray(n.data.shots) ? n.data.shots : [];
    const SEG_OK = new Set(['opening', 'continuation', 'new_character', 'scene_change', 'closeup', 'cut', '']);
    const SEG_NORM = { cut: 'closeup', close: 'closeup', insert: 'closeup', cont: 'continuation', open: 'opening', scene: 'scene_change' };
    arr = arr.map((sh, i) => {
      if (!sh || typeof sh !== 'object') return sh;
      const out = { ...sh };
      const segRaw = String(out.seg || '').trim().toLowerCase();
      out.seg = SEG_NORM[segRaw] || (SEG_OK.has(segRaw) ? segRaw : '');
      const old = oldShots[i] || {};
      // 只补「本来是空的 + 旧值有」的衔接字段，绝不覆盖调用方明确给的新值
      for (const k2 of ['tail', 'cam', 'start', 'seg']) {
        if (!out[k2] && old[k2]) out[k2] = old[k2];
      }
      // 战斗因果字段同规则兜底：旧镜带战斗态而新值没给时按镜序保留（与衔接字段同款，防整表替换冲掉）
      for (const k2 of ['attack', 'reaction', 'impact', 'initiative', 'nextCombat']) {
        if (!String(out[k2] || '').trim() && old[k2]) out[k2] = old[k2];
      }
      return out;
    });
    n.data.shots = arr;
    applied.push('shots');
  }
  if (!applied.length) {
    throw new Error('没有可应用的字段（允许：' + NODE_PATCH_FIELDS.join(' / ') + ' / shots）；收到：' + keys.join(' / '));
  }
  doc.updatedAt = Date.now();
  writeToolDoc(args, doc);
  return { projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, type: n.type, label: n.data.label || '', applied, skipped, prompt: String(n.data.prompt || '').slice(0, 400) };
}
/** 触发节点执行并（可选）等待到终态：对话侧"改完提示词 → 点生成 → 拿结果"的一站式入口。
 *  执行发生在画布侧（需要浏览器开着画布页面消费运行请求），等待超时不代表失败。 */
async function canvasGenerateNode(args) {
  const pid = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const canvasId = toolCanvasId(args);
  const waitSec = Math.max(0, Math.min(600, Number((args && args.waitSeconds) || 0)));
  // 触发前快照：canvasRunNode 只写一次性 runRequest，真正的执行要等画布下一个 3s 同步 tick
  // 才开始（状态才翻成 running）；而下面的首轮轮询在 2.5s 就发生——对**曾经跑过**的节点，
  // 首轮会读到上一次的 done/error 并误当本次结果（页面关闭 100%、页开约 17% 触发）。
  // 因此终态只有在「本轮确实跑过」时才可信：轮询中见过 running，或文档在触发后被写过
  //（快进完成的短任务可能整体落在两次轮询之间，用文档时间戳兜底）。
  const baseline = await canvasNodeStatus({ projectId: pid, canvasId, nodeId }).catch(() => null);
  const baseUpdatedAt = Number(baseline && baseline.docUpdatedAt) || 0;
  const run = await canvasRunNode({ projectId: pid, canvasId, nodeId });
  // 闸门拒绝（G1/G2/G6）原样透传：调用方拿到 gate/fails/fix 结构化字段
  if (run && run.ok === false) return run;
  if (!waitSec) {
    return { ok: true, triggered: true, finished: false, projectId: pid, nodeId, type: run.type, label: run.label, status: 'running', note: '已触发执行；画布需处于打开状态才会真正执行，可用 canvas_node_status 查询进度' };
  }
  const deadline = Date.now() + waitSec * 1000;
  let last = null;
  let sawRunning = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    try { last = await canvasNodeStatus({ projectId: pid, canvasId, nodeId }); } catch { continue; }
    const st = String(last.status || '');
    const ai = String(last.aiStatus || '');
    if (st === 'running' || ai === 'running') { sawRunning = true; continue; }
    // 终态可信门：没见过 running 且文档也没动过 → 这是触发前就挂着的旧终态，继续等
    const confirmed = sawRunning || (baseUpdatedAt > 0 && (Number(last.docUpdatedAt) || 0) > baseUpdatedAt);
    if (!confirmed) continue;
    const isAiNode = last.type === 'script' || last.type === 'storyboard';
    if (isAiNode) {
      if (ai === 'error') return { ok: false, triggered: true, finished: true, projectId: pid, nodeId, type: last.type, label: last.label, status: 'error', error: last.error || 'AI 生成失败' };
      if (ai !== 'running' && (String(last.output || '').trim() || (Array.isArray(last.shots) && last.shots.length))) {
        return { ok: true, triggered: true, finished: true, projectId: pid, nodeId, type: last.type, label: last.label, status: 'done' };
      }
    } else if (st === 'done' || st === 'error') {
      return { ok: st === 'done', triggered: true, finished: true, projectId: pid, nodeId, type: last.type, label: last.label, status: st, assetId: last.assetId || null, error: last.error || null };
    }
  }
  const started = sawRunning || (last && (Number(last.docUpdatedAt) || 0) > baseUpdatedAt && baseUpdatedAt > 0);
  return { ok: true, triggered: true, finished: false, projectId: pid, nodeId, type: last ? last.type : run.type, label: last ? last.label : run.label, status: last ? last.status : 'running',
    note: started ? '等待超时，任务仍在进行；可继续用 canvas_node_status 查询' : '等待超时且未见本轮开始执行——画布页面很可能未打开（运行请求未被消费）；打开画布后会自动继续' };
}
async function canvasOpen(args) {
  const pid = String((args && args.projectId) || '');
  const canvasId = toolCanvasId(args);
  if (pid) {
    // 项目（以及指定画布）必须真实存在：否则工具回"✅ 已打开"，而前端因为找不到项目什么都不做（假成功）
    if (canvasId) readCanvasDoc(pid, canvasId);
    else if (!docExists(pid)) throw new Error('项目不存在：' + pid + '（先用 canvas_list_projects 查看可用项目 id）');
  }
  const cfg = readIcConfig();
  cfg.ui = { ...(cfg.ui || {}), openRequest: { projectId: pid || null, canvasId: pid ? canvasId : null, at: Date.now() } };
  writeIcConfig(cfg);
  return { ok: true, projectId: pid || null, ...(canvasId ? { canvasId } : {}) };
}

/** 画布清单（多画布目录树的数据源）：默认画布不登记在 canvases 里（客户端用 canvasId=null 表达），
 *  返回 projectId + 默认画布名/是否已删除 + canvases（子画布）。 */
async function canvasesList(args) {
  const pid = String((args && args.projectId) || '');
  const doc = readDoc(pid);
  return {
    projectId: pid, name: doc.name || pid,
    canvases: canvasRegistry(doc),
    defaultCanvasName: defaultCanvasNameForApi(doc),
    defaultCanvasDeleted: !defaultCanvasExists(doc),
  };
}
/** 新建子画布：必须命名；画布 id 由 Host 生成（cv 前缀，避免与项目 id 混淆）。
 *  新画布首次打开是空白画布（没有文档行，readCanvasDoc 会兜底空图）。 */
async function canvasCreate(args) {
  const pid = String((args && args.projectId) || '');
  const name = String((args && args.name) || '').trim();
  if (!name) throw new Error('需要画布名称（新建画布必须命名）');
  const projectDoc = readDoc(pid);
  const list = canvasRegistry(projectDoc);
  const defaultCanvasName = defaultCanvasNameForApi(projectDoc);
  // 同名复用：重复点击/重试不产生一堆同名画布
  const dup = list.find((c) => String(c.name).trim() === name);
  if (dup) return { ok: true, projectId: pid, canvasId: dup.id, name: dup.name, reused: true, defaultCanvasName };
  if (allCanvasNames(projectDoc).some((n) => n.trim() === name)) throw new Error('同名画布已存在：' + name);
  if (list.length >= 200) throw new Error('一个项目最多 200 个画布');
  // 客户端可自带 id（本地已登记、目录树已显示的路径）：合法且未占用就采用，避免两端 id 不一致
  const wantId = normalizeCanvasId(args && args.canvasId);
  const cid = (wantId && !list.some((c) => c.id === wantId)) ? wantId : ('cv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const next = sanitizeCanvases([...list, { id: cid, name: name.slice(0, 80), createdAt: Date.now() }]);
  patchProjectDoc(pid, { canvases: next });
  return { ok: true, projectId: pid, canvasId: cid, name: name.slice(0, 80), reused: false, defaultCanvasName };
}
/** 重命名画布：canvasId=null 表示默认画布（写项目文档 defaultCanvasName）；必须命名、同名（除自己）拒绝。 */
async function canvasRename(args) {
  const pid = String((args && args.projectId) || '');
  const cid = normalizeCanvasId(args && args.canvasId);
  const name = String((args && args.name) || '').trim();
  if (!name) throw new Error('需要画布名称');
  const projectDoc = readDoc(pid);
  const list = canvasRegistry(projectDoc);
  if (!cid) {
    if (!defaultCanvasExists(projectDoc)) throw new Error('默认画布已删除，无法重命名');
    if (list.some((c) => String(c.name).trim() === name)) throw new Error('同名画布已存在：' + name);
    patchProjectDoc(pid, { defaultCanvasName: name.slice(0, 80) });
    return { ok: true, projectId: pid, canvasId: null, name: name.slice(0, 80), defaultCanvasName: name.slice(0, 80) };
  }
  const target = list.find((c) => c.id === cid);
  if (!target) throw new Error('画布不存在：' + cid);
  const defNameApi = defaultCanvasNameForApi(projectDoc);
  if (defNameApi && String(defNameApi).trim() === name) throw new Error('同名画布已存在：' + name);
  if (list.some((c) => c.id !== cid && String(c.name).trim() === name)) throw new Error('同名画布已存在：' + name);
  const next = list.map((c) => (c.id === cid ? { ...c, name: name.slice(0, 80) } : c));
  patchProjectDoc(pid, { canvases: sanitizeCanvases(next) });
  return { ok: true, projectId: pid, canvasId: cid, name: name.slice(0, 80), defaultCanvasName: defaultCanvasNameForApi(projectDoc) };
}
/** 删除画布。canvasId=null 删除默认画布（清图 + defaultCanvasName + 标记 defaultCanvasDeleted，项目保留）；
 *  子画布沿用原逻辑。画布总数 = 1 时拒绝删除（客户端已隐藏按钮，Host 兜底）。 */
async function canvasDelete(args) {
  const pid = String((args && args.projectId) || '');
  const cid = normalizeCanvasId(args && args.canvasId);
  const projectDoc = readDoc(pid);
  const list = canvasRegistry(projectDoc);
  const total = canvasTotal(projectDoc);
  if (total <= 1) throw new Error('至少要保留一个画布');
  if (!cid) {
    if (!defaultCanvasExists(projectDoc)) throw new Error('默认画布已删除');
    const desiredName = defaultCanvasNameOf(projectDoc);
    const nextDoc = {
      ...projectDoc,
      nodes: {}, edges: [],
      view: { x: 60, y: 40, scale: 1 },
      tombstones: [], edgeTombstones: [], tombstoneAt: {}, edgeTombstoneAt: {},
      defaultCanvasDeleted: true,
      defaultCanvasName: '',
      updatedAt: Date.now(),
    };
    writeIcDoc(pid, nextDoc);
    const nextCanvasId = list[0] ? list[0].id : null;
    return { ok: true, projectId: pid, canvasId: null, deletedName: desiredName, defaultCanvasName: '', defaultCanvasDeleted: true, nextCanvasId };
  }
  const targetId = canvasDocId(pid, cid);
  const inList = list.some((c) => c.id === cid);
  const hasDoc = Boolean(readDocOrNull(targetId));
  // 幂等：客户端先删本地登记再发删除请求时，Host 可能只剩文档或只剩登记
  if (!inList && !hasDoc) throw new Error('画布不存在：' + cid);
  if (inList) patchProjectDoc(pid, { canvases: sanitizeCanvases(list.filter((c) => c.id !== cid)) });
  try {
    if (sqlActive()) getDb().prepare('DELETE FROM projects WHERE id = ?').run(targetId);
    else unlinkSync(projectFile(targetId));
  } catch { /* 文档不存在视为已删除 */ }
  return {
    ok: true, projectId: pid, canvasId: cid,
    defaultCanvasName: defaultCanvasNameForApi(projectDoc),
    defaultCanvasDeleted: !defaultCanvasExists(projectDoc),
  };
}

/** 与客户端一致的端口表（连线校验用）。image / video 是合并类型（旧生成/资产节点归一到这里）：
 *  image 输入 prompt+ref、输出 out；video 输入 prompt+frame+ref、输出 out/tailpick/last。 */
const PORT_TABLE = {
  'text': { inputs: [], outputs: [{ id: 'out', kind: 'text' }] },
  'shot': { inputs: [{ id: 'char', kind: 'image' }, { id: 'scene', kind: 'image' }, { id: 'prop', kind: 'image' }], outputs: [{ id: 'visual', kind: 'text' }, { id: 'motion', kind: 'text' }] },
  'script': { inputs: [], outputs: [{ id: 'out', kind: 'text' }] },
  'storyboard': { inputs: [{ id: 'prev', kind: 'text' }, { id: 'script', kind: 'text' }], outputs: [{ id: 'out', kind: 'text' }, { id: 'tail', kind: 'text' }] },
  'image': { inputs: [{ id: 'prompt', kind: 'text' }, { id: 'ref', kind: 'image' }], outputs: [{ id: 'out', kind: 'image' }] },
  'video': { inputs: [{ id: 'prompt', kind: 'text' }, { id: 'frame', kind: 'image' }, { id: 'ref', kind: 'image' }], outputs: [{ id: 'out', kind: 'video' }, { id: 'tailpick', kind: 'image' }, { id: 'last', kind: 'image' }] },
  'finalcut': { inputs: [{ id: 'in', kind: 'video' }, { id: 'audio', kind: 'audio' }], outputs: [] },
  'audio': { inputs: [{ id: 'prompt', kind: 'text' }], outputs: [{ id: 'out', kind: 'audio' }] },
  'group': { inputs: [], outputs: [] },
};
const MULTI_INPUT_PORTS = new Set(['ref', 'char', 'scene', 'prop', 'audio']);
/** Agent 改动了项目文档：记一次性信号，让画布在几秒内拉回合并（否则画布上看不到 Agent 的改动）。
 *  canvasId 记录是哪个画布被改（缺省/默认画布 = null），客户端只刷新当前画布。 */
function markDocChanged(projectId, canvasId) {
  try {
    const cfg = readIcConfig();
    let cid = null;
    try { cid = normalizeCanvasId(canvasId); } catch { cid = null; }
    cfg.ui = { ...(cfg.ui || {}), docChanged: { projectId, canvasId: cid, at: Date.now() } };
    writeIcConfig(cfg);
  } catch { /* 配置写失败不影响主流程 */ }
}
/** 在两个节点间连一条边（供 canvasConnect 与 canvasCreateNode 的 connectFrom 复用）。返回边对象。 */
function connectEdge(doc, fromId, toId, fromPort, toPort) {
  const from = doc.nodes[fromId];
  const to = doc.nodes[toId];
  if (!from) throw new Error('源节点不存在: ' + fromId);
  if (!to) throw new Error('目标节点不存在: ' + toId);
  if (fromId === toId) throw new Error('不能把节点连到自己');
  const outs = (PORT_TABLE[from.type] && PORT_TABLE[from.type].outputs) || [];
  const ins = (PORT_TABLE[to.type] && PORT_TABLE[to.type].inputs) || [];
  let fp = String(fromPort || '').trim();
  // 目标端口缺省时按语义选择，而不是死板取第一个输入口：
  // 剧本/文本 → 分镜表 = 剧本来源（script）；分镜表 → 分镜表 = 承接上一镜（prev）；其余取第一个输入口
  let tp = String(toPort || '').trim();
  if (!tp) {
    // 目标端口缺省时按语义选择（与客户端「端口单点、系统自动选口」同一套规则）：
    // 文本 → 分镜表 script；分镜表 → 分镜表 prev；文本 → 图片/视频 prompt；
    // 图片 → 图片/视频 ref；视频 → 视频 frame 或成片 in。
    if (to.type === 'storyboard') {
      tp = from.type === 'storyboard' ? 'prev' : ((from.type === 'text' || from.type === 'script') ? 'script' : String((ins[0] && ins[0].id) || ''));
    } else if (to.type === 'image') {
      tp = (from.type === 'image' || from.type === 'image-asset' || from.type === 'image-gen') ? 'ref' : 'prompt';
    } else if (to.type === 'video') {
      if (from.type === 'video' || from.type === 'video-asset' || from.type === 'video-gen') tp = 'frame';
      else if (from.type === 'image' || from.type === 'image-asset' || from.type === 'image-gen') tp = 'ref';
      else tp = 'prompt';
    } else if (to.type === 'finalcut') {
      tp = from.type === 'audio' ? 'audio' : 'in';
    } else {
      tp = String((ins[0] && ins[0].id) || '');
    }
  }
  if (!fp) {
    const want = ins.find((p) => p.id === tp);
    const same = want ? outs.filter((o) => o.kind === want.kind) : [];
    if (tp === 'prev') {
      const tail = same.find((o) => o.id === 'tail');
      fp = String((tail && tail.id) || (same[0] && same[0].id) || (outs[0] && outs[0].id) || '');
    } else if (want && want.kind === 'image') {
      // 视频 → 视频的 frame：优先尾帧最佳选帧，退到真·最后帧
      const pick = same.find((o) => o.id === 'tailpick');
      const last = same.find((o) => o.id === 'last');
      fp = String((pick && from.data && from.data.lastPickAssetId ? 'tailpick' : '') || (last && last.id) || (same[0] && same[0].id) || (outs[0] && outs[0].id) || '');
    } else {
      fp = String((same[0] && same[0].id) || (outs[0] && outs[0].id) || '');
    }
  }
  const outDef = outs.find((p) => p.id === fp);
  const inDef = ins.find((p) => p.id === tp);
  if (!outDef) throw new Error('源节点没有输出端口 ' + fp);
  if (!inDef) throw new Error('目标节点没有输入端口 ' + tp);
  if (outDef.kind !== inDef.kind) throw new Error('端口类型不匹配：' + outDef.kind + ' → ' + inDef.kind + '（剧本/文本输出请连 script/prompt 类输入）');
  const dup = (doc.edges || []).find((e) => e.fromNode === fromId && e.fromPort === fp && e.toNode === toId && e.toPort === tp);
  if (dup) return dup;
  // 单线输入端口（如分镜表的 script、图片的 prompt）：新线替换旧线，与画布拖线行为一致
  if (!MULTI_INPUT_PORTS.has(tp)) {
    doc.edges = (doc.edges || []).filter((e) => !(e.toNode === toId && e.toPort === tp));
  }
  const edge = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), fromNode: fromId, fromPort: fp, toNode: toId, toPort: tp };
  doc.edges.push(edge);
  return edge;
}
/** 在两个节点间连线（画布工作流的关键：剧本→分镜→图→视频靠连线组织，不要复制文本）。 */
function canvasConnect(args) {
  const id = String((args && args.projectId) || '');
  const canvasId = toolCanvasId(args);
  const doc = readToolDoc(args);
  const fromId = String((args && args.fromNode) || '');
  const toId = String((args && args.toNode) || '');
  const already = (doc.edges || []).some((e) => e.fromNode === fromId && e.toNode === toId);
  const edge = connectEdge(doc, fromId, toId, args && args.fromPort, args && args.toPort);
  const from = doc.nodes[fromId];
  const to = doc.nodes[toId];
  const fromLabel = String((from.data && from.data.label) || fromId);
  const toLabel = String((to.data && to.data.label) || toId);
  doc.updatedAt = Date.now();
  writeToolDoc(args, doc);
  return {
    ok: true, projectId: id, ...(canvasId ? { canvasId } : {}), edgeId: edge.id, already,
    text: '✅ 已连线：「' + fromLabel + '」(' + edge.fromPort + ') → 「' + toLabel + '」(' + edge.toPort + ')。' + (already ? '（此前已连过，本次未重复建线）' : ''),
  };
}

/** 读取 npm registry 上 latest dist-tag 的版本号（kind: 'official' | 'china'，双源白名单）。 */
async function npmLatestVersion(kind) {
  const base = NPM_REGISTRIES[kind] || NPM_REGISTRIES.official;
  const res = await fetch(base + NPM_LATEST_PATH, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('npm registry 返回 HTTP ' + res.status);
  const meta = await res.json();
  if (!meta || typeof meta.version !== 'string') throw new Error('npm registry 响应缺少 version 字段');
  // 版本号会被拼进安装命令（Windows 下经 shell 执行）→ 必须先校验形态，防止 registry 污染注入
  const v = meta.version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) throw new Error('npm registry 返回了非法的版本号');
  return v;
}

/** 探测双源可用性（并发，3s 超时）：探测路径就是实际要拉取的 packument——比 /-/ping 更贴近真实链路。 */
async function probeRegistries() {
  const probeOne = async (kind) => {
    const t0 = Date.now();
    try {
      const res = await fetch(NPM_REGISTRIES[kind] + NPM_LATEST_PATH, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
      return { ok: !!res.ok, ms: Date.now() - t0 };
    } catch { return { ok: false, ms: Date.now() - t0 }; }
  };
  const [official, china] = await Promise.all([probeOne('official'), probeOne('china')]);
  return { official, china };
}

/** 选源纯函数（表驱动回归）：手动覆盖显式优先；auto 按探测结果——
 *  官方可达 → 官方（非大陆/代理良好，权威源优先）；官方不可达而镜像可达 → 镜像（大陆直连形态）；
 *  双可达 → 官方（保守，镜像同步有分钟级延迟）；双不可达 → 官方（维持现状行为与报错）。 */
function pickUpdateRegistry(override, probe) {
  if (override === 'china') return 'china';
  if (override === 'official') return 'official';
  const off = probe && probe.official;
  const cn = probe && probe.china;
  if (off && off.ok) return 'official';
  if (cn && cn.ok) return 'china';
  return 'official';
}

/** 自动探测缓存是否仍有效：24h TTL 且源必须是白名单值（防 config 被手改成任意字符串）。 */
function registryCacheValid(cache, now) {
  if (!cache) return false;
  if (cache.resolved !== 'official' && cache.resolved !== 'china') return false;
  const at = Number(cache.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at < REGISTRY_CACHE_TTL_MS;
}

/** 解析本次更新应使用的源：手动覆盖优先；auto 读 24h 缓存，过期/缺失则探测并写回缓存。 */
async function resolveUpdateRegistry() {
  const cfg = readIcConfig();
  const override = cfg.updateRegistry === 'china' || cfg.updateRegistry === 'official' ? cfg.updateRegistry : 'auto';
  if (override !== 'auto') return { kind: override, override: true };
  const cache = cfg.updateRegistryResolved && Number(cfg.updateRegistryAt) > 0
    ? { resolved: cfg.updateRegistryResolved, at: Number(cfg.updateRegistryAt) }
    : null;
  if (registryCacheValid(cache, Date.now())) return { kind: cache.resolved, cached: true };
  const kind = pickUpdateRegistry('auto', await probeRegistries());
  try {
    writeIcConfig({ ...readIcConfig(), updateRegistry: 'auto', updateRegistryResolved: kind, updateRegistryAt: Date.now() });
  } catch { /* 写缓存失败不阻断更新 */ }
  return { kind, probed: true };
}

/** 按偏好源取 latest，失败自动换备源一次（探测再准也有抖动，兜底保证不卡更新）。 */
async function npmLatestVersionAny(preferred) {
  const order = preferred === 'china' ? ['china', 'official'] : ['official', 'china'];
  let lastErr = null;
  for (const kind of order) {
    try {
      return { kind, version: await npmLatestVersion(kind) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/**
 * 语义化版本比较：a<b → -1，a>b → 1，相等 → 0，**无法解析 → null（未知，不能当成"相等"）**。
 * prerelease 按 semver 规则逐段比较：数字段按数值（rc.10 > rc.9），数字段优先于字母段。
 */
function cmpVer(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
    return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] === undefined ? null : m[4].split('.') } : null;
  };
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return null;
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;  // 正式版 > 预发布版
  if (B.pre === null) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字标识符优先级低于字母标识符
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function readLocalVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version ?? VERSION;
  } catch { return VERSION; }
}

/**
 * 更新检查（与安装方式无关）：当前副本版本 vs npm registry latest。
 * 本地版本 ≥ 远端 → 最新；仅真正落后才提示。
 */
async function updateCheck() {
  const runningVersion = readLocalVersion();
  const reg = await resolveUpdateRegistry();
  const r = await npmLatestVersionAny(reg.kind);
  const remoteVersion = r.version;
  const cmp = cmpVer(runningVersion, remoteVersion);
  const base = { registryKind: r.kind, registry: NPM_REGISTRIES[r.kind], registryFallback: r.kind !== reg.kind };
  if (cmp === null) {
    // 版本号无法解析（本地被改成非规范三段等）：如实报"未知"，绝不谎称已是最新
    return { source: 'npm', ...base, runningVersion, remoteVersion, behind: 0, upToDate: false, unknown: true, note: '版本号无法解析，无法判断是否需要更新' };
  }
  const behind = cmp < 0 ? 1 : 0;
  return { source: 'npm', ...base, runningVersion, remoteVersion, behind, upToDate: behind === 0 };
}

/**
 * 点击即更新（仅在用户显式点击时由客户端调用，无 RPC 参数）：
 * 安装 registry latest 的精确版本到所属 profile，绝不自动重启/刷新。
 * - 已是最新 → { ok:true, changed:false }
 * - 受管安装 + pnpm 可用 → pnpm add <pkg>@<exact> --save-exact + 同步 bundles 列表
 * - 开发态 / pnpm 不可用 / 安装失败 → { ok:false, guide:true }（客户端回退为纯引导文案）
 */
async function updateInstall() {
  const runningVersion = readLocalVersion();
  const reg = await resolveUpdateRegistry();
  const order = reg.kind === 'china' ? ['china', 'official'] : ['official', 'china'];
  const r = await npmLatestVersionAny(order[0]);
  const latest = r.version;
  const cmp = cmpVer(runningVersion, latest);
  if (cmp === null) {
    // 无法比较时不能假装"已是最新"（按钮会显示成功但什么都没装）→ 回退为引导
    return { ok: false, guide: true, version: latest, output: '当前版本号无法解析，无法自动判断；请手动更新到 ' + latest };
  }
  if (cmp >= 0) {
    return { ok: true, changed: false, version: runningVersion };
  }
  if (!PROFILE_DIR) {
    return { ok: false, guide: true, version: latest, output: '开发态安装，请自行更新工作区' };
  }
  const pnpm = findPnpm();
  const spec = PKG_NAME + '@' + latest;
  let usedRegistry = order[0];
  let policyRelaxed = false;
  let registryFallback = false;
  let res = await runPnpmAdd(pnpm, spec, { registry: usedRegistry });
  if (!res.ok && /MINIMUM_RELEASE_AGE_VIOLATION/.test((res.stdout || '') + (res.stderr || ''))) {
    // pnpm 11 供应链保护对 24h 内新发布间歇性拦截；用户点击已是明确同意 → 放宽重试一次
    policyRelaxed = true;
    res = await runPnpmAdd(pnpm, spec, { relaxReleaseAge: true, registry: usedRegistry });
  }
  if (!res.ok) {
    // 备源兜底：探测选错的源不会卡死更新——自动换另一源重试一次
    registryFallback = true;
    usedRegistry = order[1];
    res = await runPnpmAdd(pnpm, spec, { registry: usedRegistry, relaxReleaseAge: policyRelaxed });
  }
  const output = ((res.stdout || '') + '\n' + (res.stderr || '')).trim().slice(-1500);
  if (!res.ok) {
    return { ok: false, guide: true, version: latest, output };
  }
  try {
    await ensureBundleEntry(PROFILE_DIR, PKG_NAME);
  } catch { /* bundles 同步失败不阻塞安装结果 */ }
  let installed = latest;
  try {
    installed = JSON.parse(readFileSync(path.join(PROFILE_DIR, 'node_modules', ...PKG_NAME.split('/'), 'package.json'), 'utf8')).version || latest;
  } catch { /* 保留 latest */ }
  return { ok: true, changed: true, version: installed, output, policyRelaxed, registryKind: usedRegistry, registry: NPM_REGISTRIES[usedRegistry], registryFallback };
}

export const inject = ['webServer', 'tools'];

// 仅供诊断 / 自动化测试（不属于 RPC 面，运行时行为不受影响）
export const _internals = { THUMB_MAX_SIDE, thumbRelOf, isDerivedMedia, updateCheck, updateInstall, npmLatestVersion, cmpVer, findPnpm, NPM_REGISTRIES, pickUpdateRegistry, registryCacheValid, pnpmAddArgs, getProfileDir: () => PROFILE_DIR, getVersion: () => VERSION, dataRoot, setDataRoot, dataRootMigrate, dataRootImport, ensureProjectFolder, physicalRel, mirrorProjectToDataRoot, writeAssetIndex, removeAssetIndexEntry, readDataRootMeta, removeDataRootProject, sqlDeleteProjectRows, deletedProjectIds, addDeletedProjectId, clearDeletedProjectId, fetchProxyForward, storyboardConsistencyWarnings, readAssetIndexNames, safeJoin, mimeOf, pipeFile, getIcConfigPath: () => CONFIG_PATH, canvasCreateProject, canvasWriteNode, canvasConnect, canvasDeleteProject, canvasDeleteNode, canvasRunNode, canvasNodeStatus, canvasGetBible, canvasUpdateBible, canvasCreateNode, canvasOpen, canvasesList, canvasCreate, canvasRename, canvasDelete, canvasDocId, isCanvasDocId, splitCanvasDocId, normalizeCanvasId, canvasRegistry, sanitizeCanvases, wsProjectsScan, isWsProject, wsProjectHome, wsWatchTick, wsProjectCreateAt, projectHomeDir, memoryRead, memoryWrite, bindingsRead, bindingSet, bindingClear, readCanvasDoc, writeCanvasDoc, deleteCanvasDocsForProject, projectsList, projectsPut, projectsGet, projectsDelete, projectsSync, sqliteAvailable: () => !!SQLITE, getDb, closeDb, dbAssetsList, dbAssetsGet, dbAssetNames, dbAssetCreate, dbAssetUpdate, dbAssetDelete, objectAbsFor, ftsReconcile, readDocOrNull, docExists, sqlActive, rpcMethods: () => _rpcMethods, canvasUpdateNode, canvasGenerateNode, production: PROD, productionStages: PRODUCTION_STAGES,
  canvasLayoutNode, canvasLayoutGet, canvasRelayout,
  // 提交留痕（0.20.2 T11）：redact 可单测（sk- 密钥/签名 URL/Bearer 三条 + 正常文本不受影响）
  redactSubmissionText, redactSubmissionValue, submissionLogAppendImpl, SUBMISSION_LOG_MAX_LINES,
  __auto: __autoApi };

function resolveModel(providers, want) {
  const byProvider = want && want.provider
    ? providers.find((p) => p.id === want.provider)
    : null;
  const provider = byProvider || providers.find((p) => (p.models ?? []).length) || null;
  if (!provider) return null;
  const byModel = want && want.model
    ? provider.models.find((m) => m.id === want.model)
    : null;
  const model = byModel || provider.models[0] || null;
  if (!model) return null;
  return { provider: provider.id, model: model.id };
}

/** 3D-BOX stage id → 文件系统安全名（空值表示旧版单文件入口）。 */
function safeStageId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export function apply(ctx) {
  ctx.effect(() => {
    const llm = () => ctx.get('llm');

    async function listLlmOptions() {
      const service = llm();
      if (!service) return { providers: [], resolved: null, error: 'llm 服务不可用' };
      const out = [];
      const seen = new Set();
      const pushProvider = async (id, name) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        try {
          const models = await service.listModels(id);
          out.push({
            id,
            name: name ?? id,
            models: (models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
          });
        } catch (e) {
          out.push({ id, name: name ?? id, models: [], error: String((e && e.message) || e) });
        }
      };
      try {
        for (const p of (service.listProviders() ?? [])) await pushProvider(p.id, p.name ?? p.id);
      } catch { /* 继续尝试 configurable providers */ }
      try {
        if (typeof service.listConfigurableProviders === 'function') {
          for (const c of (service.listConfigurableProviders() ?? [])) {
            const id = c && (c.id ?? c.key ?? c.settingsNs ?? c.name);
            if (id) await pushProvider(String(id), (c.name ?? c.title) ?? String(id));
          }
        }
      } catch { /* ignore */ }
      return { providers: out, resolved: resolveModel(out) };
    }

    /**
     * 调用 Harness 的 LLM 生成文本。
     * @param args {provider, model, system, user, temperature, maxTokens}
     * @param hooks 可选：{ onAttempt(info), onReasoning(text), onText(text) } —— 供流式路由把
     *              思考过程实时推给画布（用户能看到"没卡住"）
     */
    async function complete(args, hooks) {
      const service = llm();
      if (!service) throw new Error('llm 服务不可用');
      const emit = (fn, payload) => { try { if (hooks && typeof hooks[fn] === 'function') hooks[fn](payload); } catch { /* 回调异常不影响生成 */ } };
      const want = args ?? {};
      const { providers } = await listLlmOptions();
      const resolved = resolveModel(providers, want);
      if (!resolved) throw new Error('没有可用模型，请先在 Harness 设置中配置模型提供方');
      const system = String(want.system ?? '');
      const user = String(want.user ?? '');
      // 只透传调用方显式给出的参数；不给就不发 —— 让适配器/模型用 Harness 里配置的默认值
      // （此前插件写死 maxTokens 会覆盖用户在 Harness 里的输出上限，推理模型思考一吃就没了）
      const temperature = typeof want.temperature === 'number' && Number.isFinite(want.temperature) ? want.temperature : undefined;
      const maxTokens = typeof want.maxTokens === 'number' && Number.isFinite(want.maxTokens) && want.maxTokens > 0 ? want.maxTokens : undefined;
      const tuned = {
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      };
      // 视觉输入（拉片）：把 dataURL 存成宿主附件，作为 image content block 发给模型。
      // 模型不支持图片输入时适配器会报错——调用方据此提示用户换视觉模型，绝不静默丢图。
      const imageBlocks = [];
      const wantImages = Array.isArray(want.images) ? want.images.slice(0, 16) : [];
      if (wantImages.length) {
        let attachments = null;
        try { attachments = (ctx.get && ctx.get('attachments')) || ctx.attachments || null; } catch { attachments = null; }
        if (!attachments || typeof attachments.saveImage !== 'function') {
          throw new Error('当前宿主不支持图片附件（attachments），无法做视觉拉片');
        }
        for (let i = 0; i < wantImages.length; i++) {
          const im = wantImages[i] || {};
          const raw = String(im.dataUrl || '');
          const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(raw);
          let data = null;
          let mediaType = String(im.mediaType || 'image/jpeg');
          if (m) {
            mediaType = m[1];
            data = Buffer.from(m[2], 'base64');
          } else if (im.data && (im.data instanceof Uint8Array || Buffer.isBuffer(im.data))) {
            data = im.data;
          }
          if (!data || !data.length) continue;
          const ref = await attachments.saveImage({ data, mediaType, name: String(im.name || ('frame-' + (i + 1) + '.jpg')) });
          if (ref) imageBlocks.push({ type: 'image', attachment: ref });
        }
        if (!imageBlocks.length) throw new Error('拉片图片解码失败（没有可用的帧）');
      }
      const userMessage = { role: 'user', content: [{ type: 'text', text: user }, ...imageBlocks] };
      /** 跑一次流：统计 chunk 类型，返回文本与失败原因（单次尝试抛错不致命，便于逐级回退）。 */
      const run = async (options, label) => {
        const kinds = [];
        let text = '';
        let finishKind = null;
        let finishMsg = null;
        emit('onAttempt', { label });
        try {
          for await (const chunk of service.stream(options)) {
            const type = chunk && chunk.type;
            kinds.push(type || 'unknown');
            if (type === 'reasoning-delta' && typeof chunk.text === 'string') emit('onReasoning', chunk.text);
            else if (type === 'text-delta' || type === 'text') {
              if (typeof chunk.text === 'string') { text += chunk.text; emit('onText', chunk.text); }
            } else if (type === 'finish') {
              // 适配器的 finish.reason 是对象：{kind:'stop'|'max-tokens'|'error', failure?}
              const r = chunk.reason;
              if (r && typeof r === 'object') { finishKind = r.kind || null; finishMsg = (r.failure && r.failure.message) || null; }
              else if (typeof r === 'string') finishKind = r;
            }
          }
          return { text, kinds, finishKind, finishMsg, error: null };
        } catch (e) {
          return { text: '', kinds, finishKind, finishMsg, error: String((e && e.message) || e) };
        }
      };
      const histogram = (kinds) => {
        if (!kinds.length) return '（没有任何 chunk）';
        const m = new Map();
        for (const k of kinds) m.set(k, (m.get(k) || 0) + 1);
        return [...m.entries()].map(([k, v]) => k + '×' + v).join(', ');
      };
      const base = {
        provider: resolved.provider,
        model: resolved.model,
        ...(system ? { system } : {}),
        messages: [userMessage],
        ...tuned,
        sessionId: 'infinite-canvas',
        purpose: 'infinite-canvas',
      };
      // 1) 规范信封（system 独立字段 + sessionId；参数按调用方配置，不发插件自造的数值）
      const primary = await run(base, '默认');
      if (primary.text.trim()) return { text: primary.text, provider: resolved.provider, model: resolved.model, variant: 'system' };
      // 2) 没拿到正文时的重试 —— **绝不修改任何模型参数**（思考强度/输出上限/温度都不碰）：
      //    a) 老式信封（system 放进 messages）：只是换一种转写方式
      //    b) 追问一次："请把最终答案作为正文输出" —— 只追加对话内容，
      //       适用于"模型把结果写进了思考、正文为空"的情况；思考质量原封不动
      const nudgeMessage = { role: 'user', content: [{ type: 'text', text: '（继续）请把你的最终答案完整地作为正文输出，不要只输出思考内容。' }] };
      const attempts = [
        { label: '老式信封', options: { provider: resolved.provider, model: resolved.model, messages: system ? [{ role: 'system', content: [{ type: 'text', text: system }] }, userMessage] : [userMessage], ...tuned } },
        { label: '追问正文', options: { ...base, messages: [userMessage, nudgeMessage] } },
      ];
      const tried = [];
      for (const a of attempts) {
        const r = await run(a.options, a.label);
        if (r.text.trim()) return { text: r.text, provider: resolved.provider, model: resolved.model, variant: 'retry', attempt: a.label };
        tried.push(a.label + ': ' + histogram(r.kinds) + (r.finishKind ? ' finish=' + r.finishKind + (r.finishMsg ? '（' + r.finishMsg + '）' : '') : '') + (r.error ? ' / 错误: ' + r.error : ''));
      }
      const why = primary.finishKind === 'max-tokens'
        ? '输出在预算内被截断（finish=max-tokens）'
        : primary.finishKind
          ? '模型结束而未输出正文（finish=' + primary.finishKind + (primary.finishMsg ? '：' + primary.finishMsg : '') + '）'
          : '模型未返回正文';
      throw new Error(
        why + '（provider=' + resolved.provider + ' model=' + resolved.model + '）。'
        + '插件未修改任何模型参数（思考强度/输出上限/温度都按你的配置）；已尝试追问正文仍未得到。'
        + '建议：换一个文本模型试试。'
        + '（chunk 统计 → 首次: ' + histogram(primary.kinds) + (primary.finishKind ? ' finish=' + primary.finishKind : '') + '；重试: ' + tried.join(' | ') + '）',
      );
    }

    /** 懒加载导演台引擎（纯 ESM 函数/常量，无 DOM 依赖），供导演台工具读取姿态/动作清单。 */
    let _directorEngine = null;
    const loadDirectorEngine = async () => {
      if (_directorEngine) return _directorEngine;
      try {
        const url = new URL('./assets/director/engine.js', import.meta.url).href;
        _directorEngine = await import(url);
      } catch { _directorEngine = null; }
      return _directorEngine;
    };

    // ---- 会话↔画布绑定：会话所在工作区解析（ctx 闭包内：需要 workspaceRegistry 服务）----
    /** 解析 sessionId 所在工作区与活会话判定；老宿主无 workspaceRegistry → supported:false（全链降级）。 */
    const wsSessionContext = (sessionId) => {
      let reg = null;
      try { reg = ctx.get && ctx.get('workspaceRegistry'); } catch { reg = null; }
      const list = reg && typeof reg.list === 'function' ? reg.list() : null;
      if (!Array.isArray(list)) return { supported: false, list: null, ws: null, isAlive: () => true };
      const sid = String(sessionId || '');
      const ws = list.find((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.map(String).includes(sid)) || null;
      const isAlive = (t) => list.some((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.map(String).includes(String(t)));
      return { supported: true, list, ws, isAlive };
    };
    /** 工作区注册表条目的对外视图（不泄漏内部字段）。 */
    const wsView = (w) => ({ id: w && w.id, path: w && w.path, title: (w && w.title) || '' });
    /** 自动创作开关（实验，默认关闭）：关闭时所有 auto* RPC 一律拒绝——零成本、零干扰。 */
    const autoEnabled = () => {
      try { const cfg = readIcConfig(); return !!(cfg.ui && cfg.ui.autoMode); } catch { return false; }
    };
    const autoDisabled = () => ({ ok: false, disabled: true, error: '自动创作处于关闭状态（实验功能）：请先在画布设置里打开「多智能体自动创作（实验）」' });

    // ---- 自动创作 runner（免费段·编剧室）：进程内执行器 ----
    // 角色分工 = 独立系统提示词的轮次（调研 → 编剧A/B 独立提案 → 互评 → 监制决策 → 落盘）。
    // 全程零付费（不触发生成接口）；讨论记录落盘为画布文本节点；剧情走向只来自用户 brief。
    const AUTO_RUNS = new Map(); // runKey(pid::cid) → { status:'running'|'done'|'failed'|'aborted', phase, log:[{at,role,summary}], error, brief, startedAt, meetingNodeId }
    const runKeyOf = (pid, cid) => String(pid) + '::' + (cid || 'default');
    /** 测试注入口：默认走插件内 LLM 通道；测试注入假通道以覆盖全流水线。 */
    let roomLlm = async ({ system, user }) => {
      const r = await complete({ system, user });
      return (r && r.text) || '';
    };
    /** 从模型输出提取第一个可解析的平衡 JSON 对象（容忍 ```json 围栏、前后闲话与散文里的非 JSON 花括号）。 */
    function roomJson(text) {
      const s = String(text || '');
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
      // 围栏内扫不出可用 JSON 时退回全文扫描（散文先于/后于围栏出现花括号时，真 JSON 不被围栏边界误杀）
      for (const src of (fence ? [fence[1], s] : [s])) {
        // 循环所有 `{` 候选位：首个平衡对象解析失败就从下一个 `{` 继续，全失败才 null
        // （0.20.1 实机：散文「我认为{这是花括号}」先出现 → 第一个 `{` 被误当 JSON 起点 → 真 JSON 被误杀）
        let from = src.indexOf('{');
        while (from >= 0) {
          let depth = 0, inStr = false, esc = false; // 换起点时转义/字符串状态机完整重置
          for (let i = from; i < src.length; i++) {
            const ch = src[i];
            if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
            if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(src.slice(from, i + 1)); } catch { break; } } }
          }
          from = src.indexOf('{', from + 1);
        }
      }
      return null;
    }
    /** needJson 失败局部重试指令：追加在 user 尾部，测试以「只输出 JSON」识别重试轮。 */
    const AUTO_JSON_RETRY = '\n\n【格式重试】上一轮输出无法解析为 JSON。只输出 JSON 对象本身：不要任何解释文字、不要 markdown 代码围栏、不要前后缀。';
    /** 3D-BOX 自然语言改景：把当前 spec + 指令交给用户已配置的模型，返回完整可构建 spec。 */
    const DIRECTOR_EDIT_SYSTEM = [
      'You are a 3D previs scene editor. Modify the CURRENT SPEC according to the INSTRUCTION.',
      'Return ONLY one JSON object, no prose, no markdown fences.',
      'Keep the same schema: { title, duration, env, style, characters[], props[], cameras[], shots[], shot }',
      'Camera: { name, pos:[x,y,z], target:[x,y,z], fov, keys?[] }',
      'Shot: { camera, start, end }',
      'Character: { name, pos:[x,y,z], rotY, pose, color, path?, keys?, poseAnim? }',
      'Valid pose ids: none, stand, arms_up, punch, kick, flip, fly, crouch, fight, walk, run, jump, hit, fall, walk_a, walk_b, run_a, run_b.',
      'Preserve all fields the instruction does not mention. Keep cameras/shots non-empty. Use meters and seconds.',
      'Examples: "机位低一点" -> lower camera pos.y and target.y; "让 A 从左入画" -> move A pos.x negative; "加一张桌子" -> add a box prop; "手持" -> set shot.cameraMove="handheld".',
    ].join('\n');
    /** 3D-BOX 一句话搭景：LLM 生成完整 spec（动作/道具/机位/分镜），本地模板只做 schema 骨架与失败兜底。 */
    const DIRECTOR_BRIEF_SYSTEM = [
      'You are a 3D previs director. Turn a one-line brief into a complete, playable previz spec.',
      'Return ONLY one JSON object, no prose, no markdown fences.',
      'Schema: { title, duration, env:{preset,grid,tonemap,bg?}, style?, characters[], props[], cameras[], shots[], shot:{duration,cameraMove}, lights[], fog?, dof? }',
      'Character: { name, pos:[x,y,z], rotY, color, clip, pose, path?, pathFace?, locomotion?, poseAnim? }',
      'poseAnim: [{"t":0,"pose":"idle"},{"t":1.2,"pose":"punch"},{"t":2.4,"pose":"hit"}] — use it for fights/actions.',
      'path: [[x,z],...] + locomotion:{source:"clip",clip:"run",stride:1.1,cycle:0.8,refSpeed:4} for chase/walk movement.',
      'Camera: { name, pos:[x,y,z], target:[x,y,z], fov, keys?[] } — keys are [{t,pos,target,fov,ease}] for camera movement.',
      'Shot: { camera, start, end } — shots must cover 0..duration without gaps.',
      'Prop: { name, preset, pos:[x,y,z], scale:[x,y,z], color }',
      'Model asset: { assetId, name?, pos:[x,y,z], rotY, h, scale?, color? } — place real local GLB assets.',
      'Valid prop presets: box, sphere, cylinder, cone, plane, capsule, torus, pyramid, disc, arc, half_cylinder, ancient_house, ancient_stall, stone_step.',
      'Valid pose ids: none, stand, arms_up, punch, kick, flip, fly, crouch, fight, walk, run, jump, hit, fall, walk_a, walk_b, run_a, run_b.',
      'env.preset: studio | daylight | night. Use meters and seconds.',
      'Rules: read the brief literally and cast 2–6 characters, 2–6 props, 2–5 cameras, 3–6 shots. Build a recognizable set using models[] from AVAILABLE LOCAL ASSETS first (buildings/furniture/trees/people); use primitive props only for gaps (cars, weapons, small props).',
      'Never invent assetId values. Street: use bld_*/tree_* plus a road plane; room: use furn_*; fight: use a ground/arena plus human models.',
      'Action words must become poseAnim/path/locomotion, not just labels. A chase needs running paths and a moving camera; a fight needs punch/kick/hit beats; dialogue needs idle poses and over-shoulder cameras.',
      'The BASE SKELETON is only a valid fallback shape; replace or extend its arrays with your own detailed staging. Never return empty cameras or shots.',
    ].join('\n');
    function mergeDirectorSpec(base, patch) {
      if (Array.isArray(patch)) return patch;
      if (patch && typeof patch === 'object') {
        const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
        for (const [k, v] of Object.entries(patch)) out[k] = mergeDirectorSpec(out[k], v);
        return out;
      }
      return patch === undefined ? base : patch;
    }
    /** 动作语义兜底：模型偶尔只给“站着”的角色；按 brief 的关键词补路径/姿态关键帧，
     *  保证“追车/打斗”至少能被预演出来（不替代 AI 的完整编排，只补最低可演要求）。 */
    function enrichDirectorSpec(spec, brief) {
      if (!spec || typeof spec !== 'object') return spec;
      const text = String(brief || '').toLowerCase();
      const chase = /追|跑|逃|追逐|警匪|chase|run|escape|pursuit/i.test(text);
      const fight = /打|斗|拳|踢|击|fight|punch|kick|combat|battle/i.test(text);
      const chars = Array.isArray(spec.characters) ? spec.characters : [];
      if (!Array.isArray(spec.props) || !spec.props.length) spec.props = [{ name: '地面', preset: 'plane', pos: [0, 0, 0], scale: [16, 1, 12], color: '#9aa3ad' }];
      const duration = Math.max(0.5, Number(spec.duration) || 6);
      if (Array.isArray(spec.shots) && spec.shots.length) {
        const shots = spec.shots.slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
        shots[0].start = 0;
        shots[shots.length - 1].end = duration;
        spec.shots = shots;
      }
      if (chase) {
        chars.slice(0, 2).forEach((c, i) => {
          if (!c || typeof c !== 'object') return;
          if (!Array.isArray(c.path) || c.path.length < 2) c.path = [[Number(c.pos?.[0]) || (i ? 1.2 : -1.2), Number(c.pos?.[2]) || 0], [8 + i * 1.5, 0]];
          if (!c.clip || c.clip === 'idle') c.clip = 'run';
          c.pathFace = c.pathFace !== false;
          if (!c.locomotion || typeof c.locomotion !== 'object') c.locomotion = { source: 'clip', clip: 'run', stride: 1.1, cycle: 0.8, refSpeed: 4 };
        });
      }
      if (fight) {
        const hasBeat = chars.some((c) => Array.isArray(c && c.poseAnim) && c.poseAnim.length);
        if (!hasBeat) {
          chars.slice(0, 2).forEach((c, i) => {
            if (!c || typeof c !== 'object') return;
            c.clip = c.clip || 'fight';
            c.poseAnim = i === 0
              ? [{ t: 0, pose: 'idle' }, { t: 0.5, pose: 'punch' }, { t: 1.1, pose: 'hit' }, { t: 1.6, pose: 'fight' }]
              : [{ t: 0, pose: 'fight' }, { t: 0.6, pose: 'kick' }, { t: 1.2, pose: 'hit' }, { t: 1.8, pose: 'idle' }];
          });
        }
      }
      return spec;
    }
    async function briefDirectorSpec(brief, opts) {
      const text = String(brief || '').trim();
      if (!text) throw new Error('需要 brief');
      const eng = await loadDirectorEngine();
      if (!eng || typeof eng.buildStageFromSpec !== 'function' || typeof eng.specFromBrief !== 'function') throw new Error('引擎未就绪');
      const o = opts || {};
      const seed = eng.specFromBrief(text, o);
      let catalog = [];
      try {
        const j = JSON.parse(readFileSync(new URL('./assets/director/models/index.json', import.meta.url), 'utf8'));
        catalog = Array.isArray(j.models) ? j.models : [];
      } catch { catalog = []; }
      const catalogMap = new Map(catalog.map((m) => [String(m.id), m]));
      const catalogText = catalog.map((m) => m.id + ' | ' + (m.label || '') + ' | ' + (m.category || '') + ' | h=' + (m.height || '')).join('\n');
      const call = (o && typeof o.llm === 'function') ? o.llm : roomLlm;
      const hints = [
        o.scene && o.scene !== 'auto' ? 'SCENE PRESET: ' + o.scene : '',
        o.style && o.style !== 'auto' ? 'STYLE PRESET: ' + o.style : '',
        o.cameraMove && o.cameraMove !== 'auto' ? 'CAMERA PRESET: ' + o.cameraMove : '',
      ].filter(Boolean).join('\n');
      const baseUser = 'BRIEF:\n' + text + (hints ? '\n\n' + hints : '')
        + '\n\nAVAILABLE LOCAL ASSETS (use models[]; ids are exact):\n' + catalogText
        + '\n\nBASE SKELETON JSON:\n' + JSON.stringify(seed);
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const user = attempt === 0
          ? baseUser
          : baseUser + '\n\n【修正】上一轮返回不可用：' + String((lastErr && lastErr.message) || lastErr) + '\n只输出修正后的完整 JSON 对象。';
        const raw = await call({ system: DIRECTOR_BRIEF_SYSTEM, user });
        const parsed = roomJson(raw);
        if (!parsed || typeof parsed !== 'object') { lastErr = new Error('模型没有返回可解析的 JSON'); continue; }
        const ai = (parsed.spec && typeof parsed.spec === 'object') ? parsed.spec : parsed;
        const next = enrichDirectorSpec(mergeDirectorSpec(seed, ai), text);
        // 本地资产兜底：AI/模板都漏掉 models 时，按题材补建筑/家具/树，避免只给一块地面。
        if (!Array.isArray(next.models) || !next.models.length) {
          const t = String(text || '').toLowerCase();
          if (/街|城|追|警|巷|road|street|city|chase|alley/i.test(t) && catalogMap.has('bld_a')) {
            next.models = [
              { assetId: 'bld_a', pos: [-10, 0, -8], h: catalogMap.get('bld_a').height || 12 },
              { assetId: 'bld_b', pos: [10, 0, -8], h: catalogMap.get('bld_b').height || 15 },
              { assetId: 'tree_oak', pos: [6, 0, -4], h: catalogMap.get('tree_oak').height || 7 },
            ];
          } else if (/会|室|桌|家|office|room|meeting|indoor/i.test(t) && catalogMap.has('furn_tableCross')) {
            next.models = [
              { assetId: 'furn_tableCross', pos: [0, 0, 0], h: catalogMap.get('furn_tableCross').height || 0.75 },
              { assetId: 'furn_chair', pos: [-1.2, 0, 0.8], h: catalogMap.get('furn_chair').height || 0.95 },
              { assetId: 'furn_chair', pos: [1.2, 0, 0.8], h: catalogMap.get('furn_chair').height || 0.95 },
            ];
          }
        }
        // 资产 id 校验 + 缺省高度（模型必须来自本地目录，绝不接受编造 id）
        if (Array.isArray(next.models)) {
          next.models = next.models.map((m) => {
            const id = String((m && m.assetId) || '');
            const meta = catalogMap.get(id);
            if (!meta) return null;
            return { ...m, assetId: id, h: Number(m.h) > 0 ? Number(m.h) : Number(meta.height) || 1.7 };
          }).filter(Boolean);
        }
        const built = eng.buildStageFromSpec(next);
        if (!built || !Array.isArray(built.cameras) || !built.cameras.length || !Array.isArray(built.shots) || !built.shots.length) {
          lastErr = new Error('返回的规格缺机位/分镜，无法构建');
          continue;
        }
        return { spec: next, built, source: 'llm' };
      }
      throw lastErr || new Error('AI 搭景失败');
    }
    async function editDirectorSpec(currentSpec, instruction, opts) {
      const text = String(instruction || '').trim();
      if (!text) throw new Error('需要 instruction');
      if (!currentSpec || typeof currentSpec !== 'object') throw new Error('缺少当前场景规格');
      const eng = await loadDirectorEngine();
      if (!eng || typeof eng.buildStageFromSpec !== 'function') throw new Error('引擎未就绪');
      const call = (opts && typeof opts.llm === 'function') ? opts.llm : roomLlm;
      const baseUser = 'CURRENT SPEC JSON:\n' + JSON.stringify(currentSpec) + '\n\nINSTRUCTION:\n' + text;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const user = attempt === 0
          ? baseUser
          : baseUser + '\n\n【修正】上一轮返回不可用：' + String((lastErr && lastErr.message) || lastErr) + '\n只输出修正后的完整 JSON 对象。';
        const raw = await call({ system: DIRECTOR_EDIT_SYSTEM, user });
        const parsed = roomJson(raw);
        if (!parsed || typeof parsed !== 'object') { lastErr = new Error('模型没有返回可解析的 JSON'); continue; }
        const next = (parsed.spec && typeof parsed.spec === 'object') ? parsed.spec : parsed;
        const built = eng.buildStageFromSpec(next);
        if (!built || !Array.isArray(built.cameras) || !built.cameras.length || !Array.isArray(built.shots) || !built.shots.length) {
          lastErr = new Error('返回的规格缺机位/分镜，无法构建');
          continue;
        }
        return { ok: true, spec: next, built };
      }
      throw lastErr || new Error('改景失败');
    }
    /** AI 运镜：自然语言 → 机位关键帧 JSON，校验后写回 spec。纯函数只做校验/归一，模型调用可注入。 */
    const DIRECTOR_CAMERA_SYSTEM = [
      'You are a 3D previs camera planner. Given the CURRENT SPEC and a CAMERA INSTRUCTION, return camera keyframes.',
      'Return ONLY one JSON object: {"keys":[{"t":0,"pos":[x,y,z],"target":[x,y,z],"fov":42,"ease":"auto"}]}',
      'Rules: at least 2 keys; t in seconds within the scene duration; pos/target in meters; keep the subject in frame; y between 0.3 and 6; fov between 20 and 90; use ease "auto" or "linear".',
      'Use the current camera as the starting point. Do not change characters, props or shots; only return camera keys.',
      'Examples: "环绕香水瓶，低机位，最后推近 logo" -> keys around the subject with y low, ending closer and narrower; "手持跟拍" -> small jitter keys; "升镜" -> pos.y increases.',
    ].join('\n');
    async function planCameraMotion(currentSpec, prompt, opts) {
      const text = String(prompt || '').trim();
      if (!text) throw new Error('需要 prompt');
      if (!currentSpec || typeof currentSpec !== 'object') throw new Error('缺少当前场景规格');
      const eng = await loadDirectorEngine();
      if (!eng || typeof eng.buildStageFromSpec !== 'function') throw new Error('引擎未就绪');
      const call = (opts && typeof opts.llm === 'function') ? opts.llm : roomLlm;
      const duration = Math.max(0.5, Number(currentSpec.duration) || 5);
      const baseUser = 'CURRENT SPEC JSON:\n' + JSON.stringify(currentSpec) + '\n\nCAMERA INSTRUCTION:\n' + text;
      const asArr = (v) => {
        if (Array.isArray(v) && v.length >= 3) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
        if (v && typeof v === 'object') return [Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0];
        return null;
      };
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const user = attempt === 0
          ? baseUser
          : baseUser + '\n\n【修正】上一轮返回不可用：' + String((lastErr && lastErr.message) || lastErr) + '\n只输出修正后的 {"keys":[...]} JSON。';
        const raw = await call({ system: DIRECTOR_CAMERA_SYSTEM, user });
        const parsed = roomJson(raw);
        const keysRaw = parsed && Array.isArray(parsed.keys) ? parsed.keys
          : (parsed && parsed.camera && Array.isArray(parsed.camera.keys) ? parsed.camera.keys : null);
        if (!Array.isArray(keysRaw) || keysRaw.length < 2) { lastErr = new Error('机位关键帧不足 2 个'); continue; }
        const norm = [];
        let bad = false;
        for (const k of keysRaw) {
          const t = Number(k && k.t);
          const pos = asArr(k && k.pos);
          const target = asArr(k && k.target);
          if (!Number.isFinite(t) || !pos || !target) { bad = true; break; }
          norm.push({
            t: Math.max(0, Math.min(duration * 1.5, t)),
            pos: [pos[0], Math.max(0.3, Math.min(6, pos[1])), pos[2]],
            target,
            fov: Math.max(8, Math.min(140, Number(k.fov) || 42)),
            ease: String(k.ease || 'auto'),
          });
        }
        if (bad) { lastErr = new Error('关键帧字段不完整'); continue; }
        norm.sort((a, b) => a.t - b.t);
        if (norm.some((k) => Math.hypot(k.pos[0] - k.target[0], k.pos[2] - k.target[2]) > 60)) {
          lastErr = new Error('机位离主体过远');
          continue;
        }
        const out = JSON.parse(JSON.stringify(currentSpec));
        const cams = Array.isArray(out.cameras) ? out.cameras : [];
        if (!cams.length) throw new Error('当前规格没有机位');
        let cam = cams[0];
        if (opts && opts.camera) cam = cams.find((c) => c.id === opts.camera || c.name === opts.camera) || cam;
        cam.keys = norm;
        out.cameraPrompt = text;
        out.cameraMove = 'ai';
        out.shot = out.shot || {};
        out.shot.cameraMove = 'ai';
        const built = eng.buildStageFromSpec(out);
        if (!built || !Array.isArray(built.cameras) || !built.cameras.length) { lastErr = new Error('机位关键帧无法构建'); continue; }
        return { ok: true, spec: out, keys: norm };
      }
      throw lastErr || new Error('AI 运镜失败');
    }
    /** Agent 素材导入：本地绝对路径或 http(s) URL → 项目资产目录 + 资产库。 */
    const importAsset = async (args) => {
      const pid = String((args && args.projectId) || '');
      if (!pid) throw new Error('需要 projectId');
      const localPath = String((args && args.path) || '').trim();
      const url = String((args && args.url) || '').trim();
      if (!localPath && !url) throw new Error('需要 path 或 url');
      const root = dataRoot();
      if (!root) throw new Error('未设置数据根目录：请先在画布设置里配置数据根目录');
      const doc = readDocOrNull(pid);
      const projectName = (doc && doc.name) || pid;
      const folder = ensureProjectFolder(pid, projectName);
      if (!folder) throw new Error('项目目录不可用');
      let buf = null, srcName = '', respMime = '';
      if (localPath) {
        const abs = path.resolve(localPath);
        if (!existsSync(abs)) throw new Error('文件不存在: ' + abs);
        const st = statSync(abs);
        if (!st.isFile()) throw new Error('不是文件: ' + abs);
        if (st.size > 200 * 1024 * 1024) throw new Error('文件超过 200MB 上限');
        buf = readFileSync(abs);
        srcName = path.basename(abs);
      } else {
        const r = await fetchProxyForward({ url, method: 'GET', timeoutMs: 120000 });
        if (!r || r.status >= 400) throw new Error('下载失败 HTTP ' + (r && r.status));
        buf = r.buf;
        respMime = String(r.contentType || '').split(';')[0].trim();
        try { srcName = decodeURIComponent(path.basename(new URL(url).pathname)) || 'asset'; } catch { srcName = 'asset'; }
      }
      if (!buf || !buf.length) throw new Error('文件为空');
      const mime = (respMime && respMime.includes('/')) ? respMime : mimeOf(srcName);
      const kindArg = String((args && args.kind) || '').toLowerCase();
      const kind = ['image', 'video', 'audio'].includes(kindArg) ? kindArg
        : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'general';
      const extMatch = /\.([a-z0-9]{1,8})$/i.exec(srcName);
      const ext = (extMatch && extMatch[1]) || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
      const id = 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const file = id + '.' + ext.toLowerCase();
      const rel = 'projects/' + pid + '/' + kind + '/' + file;
      const phys = physicalRel(rel);
      if (!phys) throw new Error('资产路径解析失败');
      const absOut = path.join(root, phys);
      mkdirSync(path.dirname(absOut), { recursive: true });
      writeFileSync(absOut, buf);
      const name = String((args && args.name) || srcName || ('import-' + id)).slice(0, 80);
      const asset = { id, projectId: pid, kind, mime, name, rel, size: buf.length, createdAt: Date.now(), source: 'import', category: 'general' };
      const saved = await methods.assetCreate({ asset, projectName });
      if (!saved || !saved.ok) throw new Error((saved && saved.error) || '资产入库失败');
      return { ok: true, assetId: id, kind, name, mime, size: buf.length, rel };
    };
    async function autoRoomStep(run, role, system, user, needJson) {
      if (run.status !== 'running') throw new Error('aborted');
      const raw = await roomLlm({ system, user });
      const parsed = needJson ? (roomJson(raw) || {}) : null;
      if (needJson && !Object.keys(parsed).length) {
        // 局部重试一次：只坏这一轮就局部救，不炸整个 run（0.20.1 实机：监制轮散文输出直接 fail 全流水线）
        run.log.push({ at: Date.now(), role, summary: '输出无法解析为 JSON，自动重试一次（要求只输出 JSON）' });
        const raw2 = await roomLlm({ system, user: user + AUTO_JSON_RETRY });
        const reparsed = roomJson(raw2) || {};
        if (!Object.keys(reparsed).length) throw new Error(role + ' 输出不是可用 JSON'); // 重试仍失败 → 原错误抛出（fail 语义不变）
        run.log.push({ at: Date.now(), role, summary: String(raw2 || '').slice(0, 160) });
        return reparsed;
      }
      run.log.push({ at: Date.now(), role, summary: String(raw || '').slice(0, 160) });
      return parsed || raw;
    }
    /** 画布执行适配器：自动打开画布 → 触发节点 → 轮询终态。测试可注入桩（__auto.setCanvasRunner）。 */
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    let canvasExec = async (pid, cid, nodeId, opts) => {
      await canvasOpen({ projectId: pid, canvasId: cid }); // 自动打开画布（用户不用点面板）
      await sleepMs(600); // 给客户端一个同步周期消费 openRequest
      const r = await canvasRunNode({ projectId: pid, canvasId: cid, nodeId });
      if (r && r.ok === false) throw new Error('[' + (r.gate || 'GATE') + '] ' + (r.error || '闸门拒绝'));
      const deadline = Date.now() + (Number(opts && opts.timeoutMs) || 8 * 60 * 1000);
      while (Date.now() < deadline) {
        await sleepMs(2000);
        let st = null;
        try { st = await canvasNodeStatus({ projectId: pid, canvasId: cid, nodeId }); } catch { continue; }
        const ai = String(st.aiStatus || '');
        const s = String(st.status || '');
        if (ai === 'error' || s === 'error') throw new Error(st.error || st.aiError || '生成失败');
        if (st.type === 'script' || st.type === 'storyboard') {
          if (ai !== 'running' && (String(st.output || '').trim() || (Array.isArray(st.shots) && st.shots.length))) return st;
        } else if (s === 'done') return st;
      }
      throw new Error('等待生成超时（画布需保持打开）');
    };
    /** 按【场N】拆分剧本成稿；没有标记就整段当一场。 */
    function splitScenes(text) {
      const src = String(text || '');
      const lines = src.split(/\r?\n/);
      const out = [];
      let cur = null;
      for (const line of lines) {
        const m = /^\s*【场\s*(\d+)\s*】/.exec(line);
        if (m) {
          if (cur && cur.lines.join('').trim()) out.push(cur);
          cur = { no: Number(m[1]) || out.length + 1, head: line.trim(), lines: [] };
        } else if (cur) cur.lines.push(line);
      }
      if (cur && cur.lines.join('').trim()) out.push(cur);
      if (!out.length) return [{ no: 1, head: '【场1】', lines: [src] }];
      return out.map((s, i) => ({ no: s.no || i + 1, text: (s.head + '\n' + s.lines.join('\n')).trim() }));
    }
    // 0.20.2 T10 断点续跑：免费段检查点的单位序（每完成一个单位就把 ps.autoRun 就地落盘一次）。
    // phase 语义 =「最后完成的单位名」，续跑从它的下一个单位继续；pitchA/pitchB 拆成两个单位，
    // 断在 A、B 之间只重跑 B。board 单位（'board<k>'）在 script 之后按场追加，数量随 scenes 定。
    const AUTO_CKPT_ORDER = ['research', 'pitchA', 'pitchB', 'critique', 'decide', 'writeback', 'script'];
    /** 持久化 run 形状校验：旧版/损坏/已完结 → 视同无持久化（全新启动），绝不带病续跑。 */
    const autoCkptValid = (c) => !!c && typeof c === 'object' && !c.completed
      && typeof c.brief === 'string' && c.brief.trim().length >= 4
      && !!c.outputs && typeof c.outputs === 'object' && !Array.isArray(c.outputs)
      && Array.isArray(c.boardIds);
    /** 已完成单位数（note/日志的「跳过 N 个已完成阶段」）。 */
    const autoCkptSkipCount = (c) => {
      const i = AUTO_CKPT_ORDER.indexOf(c.phase);
      if (i >= 0) return i + 1;
      return String(c.phase || '').indexOf('board') === 0 ? AUTO_CKPT_ORDER.length + c.boardIds.filter(Boolean).length : 0;
    };
    /** 断点的展示阶段（run.phase 仅供 autoStatus 观察；autoRoom 执行时会按实际阶段覆盖）。 */
    const autoCkptDisplayPhase = (c) => {
      if (c.phase === 'pitchA' || c.phase === 'pitchB') return 'pitch';
      if (AUTO_CKPT_ORDER.indexOf(c.phase) >= 0) return c.phase;
      return String(c.phase || '').indexOf('board') === 0 ? 'boards' : 'start';
    };
    // resume 非空 = 断点续跑（autoStart 已校验形状）：已完成单位的产物直接吃检查点，不调 LLM、不重建节点。
    async function autoRoom(pid, cid, brief, resume) {
      const runKey = runKeyOf(pid, cid);
      const run = AUTO_RUNS.get(runKey);
      const BASE = '你是短剧创作团队的一员。流程与格式是硬要求；剧情创意只来自用户 brief，绝不套模板。输出只给 JSON。';
      // T10：run.ckpt = 制作状态文件 ps.autoRun 的内存镜像；ckptDone 每单位落盘一次
      //（try/catch：状态文件损坏/写失败不炸流水线，内存 run 照常推进）。
      run.ckpt = resume || { brief, phase: null, completed: false, outputs: {}, meetingNodeId: null, scriptNodeId: null, scenes: null, boardIds: [], startedAt: Date.now(), updatedAt: Date.now() };
      const ckptDone = (phase) => {
        run.ckpt.phase = phase;
        run.ckpt.updatedAt = Date.now();
        try {
          const ps = PROD.readState(pid, cid) || { version: 1, projectId: pid, canvasKey: (cid || 'default'), floor: 0, explicit: null, createdAt: Date.now(), updatedAt: 0, history: [], overrides: [] };
          ps.autoRun = JSON.parse(JSON.stringify(run.ckpt));
          ps.updatedAt = Date.now();
          PROD.writeState(pid, cid, ps);
        } catch { /* 检查点写失败不阻塞主流程 */ }
      };
      const ckptOut = (k) => ((resume && resume.outputs && resume.outputs[k]) || null);
      try {
        // ① 调研（离线知识；联网调研随会话执行器上线）——续跑时已完成单位直接吃检查点产物
        let research = ckptOut('research');
        if (!research) {
          run.phase = 'research';
          research = await autoRoomStep(run, '调研', BASE + '\n你是题材调研员（当前离线：基于既有知识，标注「离线调研」）。给出 3 个与 brief 相关的热门题材方向与 3 种视觉风格建议。',
            '用户 brief：' + brief, true);
          run.ckpt.outputs.research = research;
          ckptDone('research');
        }
        // ② 编剧 A / B 独立提案（互不可见）——A/B 是两个独立检查点单位
        run.phase = 'pitch';
        const ctxUser = '用户 brief：' + brief + '\n调研建议：' + JSON.stringify(research).slice(0, 1200);
        let pitchA = ckptOut('pitchA');
        if (!pitchA) {
          pitchA = await autoRoomStep(run, '编剧A', BASE + '\n你是编剧A（强冲突/强反转取向）。给出 logline（≤40字）与 3 个节拍。',
            ctxUser + '\n输出 {"logline":"…","beats":["…","…","…"]}', true);
          run.ckpt.outputs.pitchA = pitchA;
          ckptDone('pitchA');
        }
        let pitchB = ckptOut('pitchB');
        if (!pitchB) {
          pitchB = await autoRoomStep(run, '编剧B', BASE + '\n你是编剧B（人物动机/情感真实取向）。给出 logline（≤40字）与 3 个节拍。与常规方案反着来。',
            ctxUser, true);
          run.ckpt.outputs.pitchB = pitchB;
          ckptDone('pitchB');
        }
        // ③ 互评
        let crit = ckptOut('crit');
        if (!crit) {
          run.phase = 'critique';
          crit = await autoRoomStep(run, '互评', BASE + '\n你是剧评人。分别评 A、B 两案各 ≤3 条（冲突强度/动机可信/成本可行性）。',
            'A案：' + JSON.stringify(pitchA).slice(0, 800) + '\nB案：' + JSON.stringify(pitchB).slice(0, 800), true);
          run.ckpt.outputs.crit = crit;
          ckptDone('critique');
        }
        // ④ 监制决策
        let dec = ckptOut('dec');
        if (!dec) {
          run.phase = 'decide';
          // 技能遵循度：监制轮带上项目技能包配置（renderProfile 头），决策/设定集不得与项目技能配置脱节——
          // 未配置技能包的项目如实说「未配置」，行为不变。
          let skillLine = '';
          try {
            const doc0 = readDoc(pid);
            const inv0 = packInventory(HERE);
            const prof0 = normalizeSkillProfile(doc0.skillProfile, allowedIds(inv0));
            skillLine = '\n【项目技能包配置·决策须与之一致】' + renderProfile(prof0, inv0, true)
              + '\n题材/影调/规格按上述配置取材；brief 的剧情创意仍优先，配置只约束风格与世界观口径。';
          } catch { /* 项目文档读不到时跳过（与未配置同等对待） */ }
          dec = await autoRoomStep(run, '监制', BASE + skillLine + '\n你是监制。择一或融合，给出决策与理由，并把世界观/风格/角色/场景/道具写成设定集草案（描述要可生成：年龄/发型/服装/材质/光线）。',
            ctxUser + '\nA案：' + JSON.stringify(pitchA).slice(0, 800) + '\nB案：' + JSON.stringify(pitchB).slice(0, 800) + '\n互评：' + JSON.stringify(crit).slice(0, 800) +
            '\n输出 {"decision":"A|B|merge","rationale":"…","logline":"…","beats":["…"],"scriptIdea":"（写给剧本节点的创作提示词，含两条叙事硬约束：每场结尾因果钩子、每场至少一个冲突点）","bible":{"worldview":"…","style":"…","characters":[{"name":"…","desc":"…"}],"scenes":[{"name":"…","desc":"…"}],"props":[{"name":"…","desc":"…"}]}}' +
            // 0.20.2 T5 防线①：监制轮明写每场 ≤15 秒硬约束（实测项目指南「每场 ≤15 秒」被无视，产出了 40s 的场）。
            // 必须落进 scriptIdea，让剧本与分镜在源头就按短场写：剧情需要更长只能拆成多场，不能拖长单场。
            '\n【时长硬约束·写进 scriptIdea】每场总时长（由该场分镜镜头 duration 累加）不得超过 15 秒；剧情需要更长必须拆成多场，绝不生成超长场。', true);
          run.ckpt.outputs.dec = dec;
          ckptDone('decide');
        }
        // ⑤ 落盘：讨论记录节点 + 设定集 + 剧本 idea（writeback 已完成的续跑不重建节点、不重写设定集）
        run.phase = 'writeback';
        const transcript = [
          '用户 brief：' + brief,
          '调研（离线）：' + JSON.stringify(research),
          '编剧A提案：' + JSON.stringify(pitchA),
          '编剧B提案：' + JSON.stringify(pitchB),
          '互评：' + JSON.stringify(crit),
          '监制决策：' + dec.decision + '——' + (dec.rationale || ''),
          '定稿 logline：' + (dec.logline || ''),
        ].join('\n\n');
        let meet = null;
        let sc = null;
        if (resume && resume.scriptNodeId) {
          // 断点续跑：会议/剧本节点上次已建（id 从检查点读），不再重建
          meet = { nodeId: resume.meetingNodeId || resume.scriptNodeId };
          sc = { nodeId: resume.scriptNodeId };
        } else {
          if (resume && resume.meetingNodeId) meet = { nodeId: resume.meetingNodeId }; // 断在 writeback 中途：会议节点复用，记录重写（幂等）
          else meet = canvasCreateNode({ projectId: pid, canvasId: cid, type: 'text', name: '编剧室会议' });
          canvasWriteNode({ projectId: pid, canvasId: cid, nodeId: meet.nodeId, target: 'output', text: transcript.slice(0, 60000), overwrite: true });
          const bi = dec.bible || {};
          await canvasUpdateBible({ projectId: pid, bible: bi });
          // scriptIdea 兼容两处：监制按指示写在根级，写歪时落到 bible 里（模型照抄示例的结构错误要容忍）
          const idea = String(dec.scriptIdea || bi.scriptIdea || dec.logline || brief).slice(0, 4000);
          sc = canvasCreateNode({ projectId: pid, canvasId: cid, type: 'script', name: '第1节剧本', prompt: idea });
          run.ckpt.meetingNodeId = meet.nodeId;
          run.ckpt.scriptNodeId = sc.nodeId;
          ckptDone('writeback');
        }
        // ⑥ 剧本自动生成 → 按场拆分 → 逐场分镜表（tail→prev 串联）→ 生成 → G2 校验
        // （剧本已生成过的续跑不再 exec：scenes 直接吃检查点）
        let scenes = (resume && Array.isArray(resume.scenes) && resume.scenes.length) ? resume.scenes : null;
        if (!scenes) {
          run.phase = 'script';
          const st = await canvasExec(pid, cid, sc.nodeId, { timeoutMs: 10 * 60 * 1000 });
          scenes = splitScenes(st.output);
          run.ckpt.scenes = scenes;
          ckptDone('script');
        }
        const boards = [];
        let prevBoard = null;
        // 0.20.2 T5 防线②：分镜产出后的场时长校验。切段算法与 client.js 同源（shot-segments.js），
        // 上限同式取分镜表节点 data.targetDuration（0.20.3 起下拉即总时长语义；缺省 15，不另立常量）。判据：切段段数 >1
        //（该场要拆多次生成才装得下）或任一单镜 duration 超上限 → 场超时长。
        const shotDurOf = (s) => Math.max(0.3, Math.round((Number(s && s.duration) || 3) * 10) / 10);
        const durCheck = (shots, cap) => {
          const plan = planShotSegments(shots, { maxSeconds: cap });
          const overShot = (Array.isArray(shots) ? shots : []).some((s) => shotDurOf(s) > cap);
          return { plan, overShot, ok: plan.segments.length <= 1 && !overShot };
        };
        // T10：读分镜表节点现况（该场已有 shots → 整场跳过；读不到按无处理）
        const sbShotsOf = (nodeId) => {
          try {
            const d = readToolDoc({ projectId: pid, canvasId: cid });
            const n = (d.nodes || {})[nodeId];
            return (n && n.data && Array.isArray(n.data.shots) && n.data.shots.length) ? n.data.shots : null;
          } catch { return null; }
        };
        for (let i = 0; i < scenes.length; i++) {
          const savedSbId = (resume && Array.isArray(resume.boardIds) && resume.boardIds[i]) || null;
          const savedShots = savedSbId ? sbShotsOf(savedSbId) : null;
          if (savedShots) { // T10 跳过语义：不建节点、不 exec、不注入，只按现况补记账（串联链以它为 prev）
            prevBoard = savedSbId;
            const g = PROD.gateStoryboard(savedShots);
            boards.push({ no: scenes[i].no, storyboardId: savedSbId, gate: g.ok, fails: g.fails });
            run.log.push({ at: Date.now(), role: 'runner', summary: '场' + scenes[i].no + ' 分镜已存在（断点续跑），跳过重新生成' });
            continue;
          }
          run.phase = 'boards ' + (i + 1) + '/' + scenes.length;
          const txt = canvasCreateNode({ projectId: pid, canvasId: cid, type: 'text', name: '场' + scenes[i].no + '文本' });
          canvasWriteNode({ projectId: pid, canvasId: cid, nodeId: txt.nodeId, target: 'output', text: scenes[i].text, overwrite: true });
          const sb = canvasCreateNode({ projectId: pid, canvasId: cid, type: 'storyboard', name: '场' + scenes[i].no + '分镜表', connectFrom: txt.nodeId });
          if (prevBoard) { try { canvasConnect({ projectId: pid, canvasId: cid, fromNode: prevBoard, toNode: sb.nodeId, fromPort: 'tail', toPort: 'prev' }); } catch { /* 端口异常不阻塞 */ } }
          prevBoard = sb.nodeId;
          // 0.20.2 T3：首轮 exec 前记下节点原有 requirement（重生成注入要在它基础上追加，复检后还原，不污染节点数据）
          let origReq = '';
          let segMax = 15;
          try {
            const sbDoc = readToolDoc({ projectId: pid, canvasId: cid });
            const sbNode0 = sbDoc.nodes[sb.nodeId];
            origReq = String((sbNode0 && sbNode0.data && sbNode0.data.requirement) || '');
            segMax = Number(sbNode0 && sbNode0.data && sbNode0.data.targetDuration) || 15;
          } catch { /* 读不到按空处理 */ }
          let sbSt = await canvasExec(pid, cid, sb.nodeId, { timeoutMs: 10 * 60 * 1000 });
          let gate = PROD.gateStoryboard(sbSt.shots);
          let dur = durCheck(sbSt.shots, segMax);
          if (!gate.ok || !dur.ok) { // 不过闸/超时长都自动重生成一次（两块合并注入，重跑上限仍是一次，不拆两次）
            const logParts = [];
            const injParts = [];
            if (!gate.ok) {
              logParts.push('G2 未过，自动重生成（已注入清单）：' + gate.fails.slice(0, 2).join('；'));
              // 0.20.2 T3：重跑前把 gate.fails **全清单**写进分镜节点 requirement（客户端 aiStoryboardShots
              // 每次生成都读它拼进提示词）——不注入则重生成提示词与首轮逐字相同，模型原样再犯（实测 11 项依旧）。
              // 全清单逐条编号，不是 slice(0,2)：日志可以截断，提示词不能。
              injParts.push('【G2 复检·必须逐项修复】上一版分镜未通过质量闸门，以下是全部不合规项，重新生成时逐项改正：\n' + gate.fails.map((f, j) => (j + 1) + '. ' + f).join('\n'));
            }
            if (!dur.ok) {
              // 0.20.2 T5：场超时长——事实与修复要求并入同一条 requirement（同一次重生成既修合规又修时长）。
              logParts.push('分镜超时长（' + dur.plan.total + ' 秒/' + dur.plan.segments.length + ' 段），自动重生成（已注入时长约束）');
              injParts.push('【时长约束】本场总时长 ' + dur.plan.total + ' 秒超过 ' + segMax + ' 秒上限：删减镜头或压缩每镜 duration，确保总时长 ≤' + segMax + ' 秒；若剧情需要更长必须拆成多场。超时明细：'
                + (Array.isArray(sbSt.shots) ? sbSt.shots : []).map((s, k) => '镜' + (k + 1) + '=' + shotDurOf(s) + 's').join('，')
                + '（切段 ' + dur.plan.segments.length + ' 段）');
            }
            run.log.push({ at: Date.now(), role: 'runner', summary: '场' + scenes[i].no + ' ' + logParts.join('；') });
            canvasUpdateNode({ projectId: pid, canvasId: cid, nodeId: sb.nodeId, patch: { requirement: (origReq ? origReq + '\n\n' : '') + injParts.join('\n\n') } });
            try {
              sbSt = await canvasExec(pid, cid, sb.nodeId, { timeoutMs: 10 * 60 * 1000 });
              gate = PROD.gateStoryboard(sbSt.shots);
              dur = durCheck(sbSt.shots, segMax);
            } finally {
              // 复检结束（无论过没过，重跑炸了也一样）还原 requirement 为原值；还原失败不阻塞
              try { canvasUpdateNode({ projectId: pid, canvasId: cid, nodeId: sb.nodeId, patch: { requirement: origReq } }); } catch { /* 还原失败不阻塞 */ }
            }
          }
          if (!dur.ok) { // 复检仍超时：不阻塞（预算单照出，场行 videoCalls 已如实反映成本），只记 log
            run.log.push({ at: Date.now(), role: 'runner', summary: '场' + scenes[i].no + ' 仍超时长（' + dur.plan.total + ' 秒/' + dur.plan.segments.length + ' 段）' });
          }
          boards.push({ no: scenes[i].no, storyboardId: sb.nodeId, gate: gate.ok, fails: gate.fails });
          run.ckpt.boardIds[i] = sb.nodeId;
          ckptDone('board' + (i + 1));
          run.log.push({ at: Date.now(), role: 'runner', summary: '场' + scenes[i].no + ' 分镜：' + (gate.ok ? '过闸' : '仍有 ' + gate.fails.length + ' 项') });
        }
        // ⑦ 预算单（免费段终点）
        const cfg = readIcConfig();
        const price = Number(cfg.production && cfg.production.videoUnitPricePerSecond);
        run.budget = PROD.quote(pid, cid, price);
        run.boards = boards;
        run.meetingNodeId = meet.nodeId;
        run.scriptNodeId = sc.nodeId;
        run.status = 'done';
        run.phase = 'budget';
        // T10：免费段完结 → 检查点标 completed 而不是清掉：brief/产物/预算留作「上一集」记录
        //（autoStart 把 brief 落盘本就为重启后可查）；completed 与「未完成才续跑」判定天然互斥，
        // 下次 autoStart 无论 brief 异同都是全新启动。
        run.ckpt.completed = true;
        run.ckpt.budget = run.budget;
        run.ckpt.boards = boards;
        ckptDone('budget');
        run.log.push({ at: Date.now(), role: 'runner', summary: '免费段完成：' + scenes.length + ' 场分镜 + 预算单（' + run.budget.videoCalls + ' 次视频调用 / ' + run.budget.totalSeconds + ' 秒）' });
      } catch (e) {
        // T10：失败/中止不清检查点——未完成的 ps.autoRun 留在状态文件里，
        // 下次 autoStart（不传 brief 或 brief 一致）从断点续跑。
        run.status = String((e && e.message) || e) === 'aborted' ? 'aborted' : 'failed';
        run.error = String((e && e.message) || e);
        run.log.push({ at: Date.now(), role: 'runner', summary: '失败：' + run.error });
      }
    }
    /** 付费段 v1：批准后按镜头切段逐段建视频节点 → 生成 → 轮询（失败重试 2 次）→ 成片节点。
     *  0.20.2 T6（#10）：一个分镜表 ≠ 一次生成——planShotSegments 切出的每段各建一个 video 节点
     * （命名带「段k/N」、prompt 带镜头范围约束、data 带客户端 videoSegmentOf 消费的段键），
     * 长场（如 40s）不再整表一次请求撞厂商上限（实测中转站 400）；finalcut 连最后一个完成的段节点。
     *  0.20.2 T8（#6/#7）：参考图先行——有待生成段的场，先把 shots 里的 角色/场景/道具 实体建成
     * 「<品类>-<名> 设定图」image 节点（命名即分类数据契约，client.js L4931-4946）并出图，再建视频段；
     * 生成时参考图严格只取连线（collectRefs，client.js L4949-4953），所以 ref 线必须在视频 exec 之前
     * 用 canvasConnect(toPort:'ref') 接到该场每个 video 段节点。跨场共享实体只生成一次（run 级 Map）；
     * 已有参考资产（资产名边界匹配）跳过；参考图失败不阻塞视频段。
     *  0.20.2 T9（#9）：可选 scenes 选场执行——传入 1-based 场号数组时只跑选中场（boards[i] 场号 = i+1，
     * 与 quote scenes 序号一致）：未选中场零视频节点、实体收集也不跑（连参考图都不生成）；finalcut 仍连
     * 「最后一个完成的段节点」（本次执行范围内的）。批准令牌与指纹零改动：入口照旧按全量预算校验，
     * scenes 只是执行过滤器——不传 scenes 时行为逐字节不变。 */
    async function autoPaid(pid, cid, scenes) {
      const cfg = readIcConfig();
      const price = Number(cfg.production && cfg.production.videoUnitPricePerSecond);
      const ap = PROD.approvalOf(pid, cid, price);
      if (!ap || !ap.valid) return { ok: false, error: '没有有效的付费批准：先用 canvas_auto_budget 生成预算单，用户批准后重试' };
      const run = AUTO_RUNS.get(runKeyOf(pid, cid));
      if (!run || run.status !== 'done') return { ok: false, error: '免费段尚未完成（没有分镜与预算）' };
      if (run.paid === 'running') return { ok: false, error: '付费段已在运行' };
      run.paid = 'running';
      run.paidAbort = false;
      run.paidLog = [{ at: Date.now(), text: '付费段启动（已批准预算 ' + ap.quoteId + '）' }];
      const abortNow = () => { run.paid = 'aborted'; run.paidPhase = 'aborted'; run.paidLog.push({ at: Date.now(), text: '已中止（保留已完成视频）' }); };
      (async () => {
        try {
          const doc = readToolDoc({ projectId: pid, canvasId: cid });
          const boards = Object.values(doc.nodes || {}).filter((n) => n.type === 'storyboard' && Array.isArray(n.data && n.data.shots) && n.data.shots.length);
          // T9 ②：选场执行——scenes 存在时按 boards 序号过滤（boards[i] 的场号 = i+1，与 quote scenes 序号一致）；
          // 被排除的场不进循环：零视频节点、实体收集也不跑（连参考图都不生成）。批准令牌不受影响：
          // 本函数入口的 approvalOf 已按全量预算指纹校验（PROD.approve 语义零改动），scenes 只是执行过滤器。
          const picked = Array.isArray(scenes) && scenes.length ? scenes : null;
          if (picked) {
            const msg = '部分执行：本次跑 ' + boards.map((_b, i) => i + 1).filter((s) => picked.includes(s)).map((s) => '场' + s).join('/') + '（共 ' + boards.length + ' 场）';
            run.log.push({ at: Date.now(), role: 'runner', summary: msg });
            run.paidLog.push({ at: Date.now(), text: msg });
          }
          // T8：参考图 run 级状态——实体键「品类|名」→ image 节点；跨场共享同一实体只生成一次。
          // 「已有参考资产」读项目资产索引一次（角色-<名>/场景-<名>/道具-<名> 边界匹配，client.js L4078 同款）。
          const refImageByEntity = new Map();
          let refImagesMade = 0;
          let assetNames = [];
          try { assetNames = readAssetIndexNames(pid) || []; } catch { assetNames = []; }
          // 设定集实体描述（prompt 用；名字精确匹配，与 matchBibleEntity 同式的大小写不敏感）
          const bibleDescOf = (kind, name) => {
            const bible = (doc && doc.bible) || {};
            const key = kind === '角色' ? 'characters' : kind === '场景' ? 'scenes' : 'props';
            const q = String(name || '').trim().toLowerCase();
            const list = Array.isArray(bible[key]) ? bible[key] : [];
            const hit = list.find((it) => String((it && it.name) || '').trim().toLowerCase() === q);
            return String((hit && hit.desc) || '').trim();
          };
          let lastVideo = null;
          for (let i = 0; i < boards.length; i++) {
            if (picked && !picked.includes(i + 1)) continue; // T9 ②：未选中场零节点零参考图
            if (run.paidAbort) { abortNow(); return; }
            const sb = boards[i];
            run.paidPhase = 'video ' + (i + 1) + '/' + boards.length;
            const shots = Array.isArray(sb.data && sb.data.shots) ? sb.data.shots : [];
            const segMax = Number(sb.data && sb.data.targetDuration) || 15;
            const plan = planShotSegments(shots, { maxSeconds: segMax });
            // 客户端兜底同款（production.quote 同式）：切段为空但表里有镜头 → 整表按一段
            const segs = plan.segments.length ? plan.segments
              : [{ startIndex: 0, endIndex: shots.length - 1, duration: plan.total, needsTailChain: false, seamRisk: 'none' }];
            const segCount = segs.length;
            const baseLabel = String((sb.data && sb.data.label) || ('场' + (i + 1))).replace(/分镜表$/, '');
            // 段节点名（T6 原式提成函数：T8 判断「哪些段待生成」与建段要用同一个名字口径）
            const segLabelOf = (k) => {
              const suffix = segCount > 1 ? '视频 · 段' + (k + 1) + '/' + segCount : '视频';
              // 段序号后缀整体进名字（G4 禁「镜N」式逐镜命名，这里带的是段区间不是单镜）；先切基础名保后缀完整
              return baseLabel.slice(0, Math.max(1, 40 - suffix.length)) + suffix;
            };
            // ③ 预算一致性（只记日志不阻塞）：run.budget 是免费段终点的快照，镜头中途被用户改过就对不上；
            //   批准令牌的指纹校验已在 autoPaid 入口把守，这里只是日志诚实化。
            const budgetRow = run.budget && Array.isArray(run.budget.scenes) ? run.budget.scenes.find((r) => r && r.storyboardId === sb.id) : null;
            if (budgetRow && Number(budgetRow.videoCalls) !== segCount) {
              const msg = '预算与实际段数不一致（预算 ' + Number(budgetRow.videoCalls) + ' / 实际 ' + segCount + '），按实际执行';
              run.log.push({ at: Date.now(), role: 'runner', summary: baseLabel + ' ' + msg });
              run.paidLog.push({ at: Date.now(), text: msg });
            }
            // 断点续跑：旧版整表单节点（名字不带「段k/N」）→ 整场跳过（该场已有视频、预算已计 0）；
            // 本 hotfix 的段节点 → 只跳过已存在的那几段，缺的段照建（重试语义按段保留）。
            const boardVideos = (doc.edges || []).filter((e) => e.fromNode === sb.id).map((e) => doc.nodes[e.toNode]).filter((n) => n && n.type === 'video');
            const segNumOf = (v) => { const m = String((v.data && v.data.label) || '').match(/ · 段(\d+)\/(\d+)$/); return m ? Number(m[1]) : 0; };
            if (boardVideos.length && !boardVideos.some((v) => segNumOf(v) > 0)) continue;
            // ── T8（#6/#7）：参考图先行 ──────────────────────────────────────
            // 只有「有待生成段」的场才产生参考图需求（全完成/续跑完成的场不重复生成）；
            // 该场的 image 设定图建好并出图之后，才轮到下面的 video 段节点——collectRefs 生成时
            // 严格只读连线，ref 线在建段后、段 exec 前接上（先连后生成）。
            const boardEntities = PROD.collectShotEntities(shots);
            const hasPendingSeg = segs.some((_s, k) => !boardVideos.some((v) => String((v.data && v.data.label) || '') === segLabelOf(k)));
            if (hasPendingSeg) {
              run.paidPhase = '参考图 ' + (i + 1) + '/' + boards.length;
              for (const ent of boardEntities) {
                if (run.paidAbort) { abortNow(); return; }
                if (refImageByEntity.has(ent.key)) continue; // 跨场共享：本 run 已生成，直接复用连线
                if (PROD.hasRefAssetName(assetNames, ent.kind, ent.name)) {
                  const msg = ent.name + ' 已有参考资产，跳过';
                  run.log.push({ at: Date.now(), role: 'runner', summary: msg });
                  run.paidLog.push({ at: Date.now(), text: msg });
                  continue;
                }
                const label = ent.kind + '-' + ent.name + ' 设定图';
                const desc = bibleDescOf(ent.kind, ent.name);
                const prompt = '设定图：' + ent.kind + ' ' + ent.name + (desc ? '。设定集描述：' + desc : '');
                let img = null;
                try { img = canvasCreateNode({ projectId: pid, canvasId: cid, type: 'image', name: label, prompt, size: '2K', ratio: '16:9' }); }
                catch (e) { img = { ok: false, error: String((e && e.message) || e) }; }
                // 实测闸门行为：canvasCreateNode 的 G4（禁逐镜命名）没有 override 逃生舱（G2/G3 才有），
                // 规范「<品类>-<名> 设定图」命名天然过闸；真被拒说明实体名病态（含「镜N」）——记日志跳过，不阻塞视频段。
                if (!img || img.ok === false || !img.nodeId) {
                  const msg = ent.name + '（' + ent.kind + '）参考图建点失败：' + String((img && img.error) || '未知');
                  run.log.push({ at: Date.now(), role: 'runner', summary: msg });
                  run.paidLog.push({ at: Date.now(), text: msg });
                  continue;
                }
                let done = false; let err = null;
                for (let attempt = 0; attempt < 2 && !done; attempt++) {
                  if (attempt > 0 && run.paidAbort) { abortNow(); return; }
                  try { await canvasExec(pid, cid, img.nodeId, { timeoutMs: 10 * 60 * 1000 }); done = true; }
                  catch (e) { err = e; run.paidLog.push({ at: Date.now(), text: label + ' 第 ' + (attempt + 1) + ' 次失败：' + String((e && e.message) || e) }); }
                }
                if (!done) {
                  const msg = ent.name + '（' + ent.kind + '）参考图生成失败：' + String((err && err.message) || err);
                  run.log.push({ at: Date.now(), role: 'runner', summary: msg });
                  run.paidLog.push({ at: Date.now(), text: msg });
                  continue; // 不入 Map、不连线、不阻塞视频段
                }
                refImageByEntity.set(ent.key, { nodeId: img.nodeId, label });
                refImagesMade++;
                run.paidLog.push({ at: Date.now(), text: label + ' 完成' });
              }
              run.paidPhase = 'video ' + (i + 1) + '/' + boards.length;
            }
            for (let k = 0; k < segCount; k++) {
              if (run.paidAbort) { abortNow(); return; }
              const seg = segs[k];
              const label = segLabelOf(k);
              if (boardVideos.some((v) => String((v.data && v.data.label) || '') === label)) continue;
              // G3 一表一视频的逃生舱只给「同场第 2 段起 / 续跑补建缺段」用；quote 引用用户批准过的预算单号（审计可查），
              // 绝不伪造用户原话。首段不传 override：G2 不过的场在这里照旧硬失败（分镜带病不下场）。
              const needOverride = boardVideos.length > 0 || k > 0;
              const segDuration = Math.max(1, Math.round(Number(seg.duration) || 0));
              const v = canvasCreateNode({ projectId: pid, canvasId: cid, type: 'video', name: label, connectFrom: sb.id, duration: segDuration,
                ...(needOverride ? { override: { by: 'user-explicit', quote: '付费段按预算切段执行（批准单 ' + ap.quoteId + '）：' + label } } : {}) });
              if (v && v.ok === false) throw new Error('[' + v.gate + '] ' + v.error);
              // ② 镜头区间元数据：prompt 通道（白名单内、画布可见；分镜表不在上游时它就是生成提示词）
              //    + data 段键（client.js videoSegmentOf/segMeta 消费——上游分镜表在 prompt 口时由它决定只取本段镜头）。
              const shotFrom = Number.isFinite(Number(seg.startIndex)) ? Number(seg.startIndex) : 0;
              const shotTo = Number.isFinite(Number(seg.endIndex)) ? Number(seg.endIndex) : shots.length - 1;
              canvasUpdateNode({ projectId: pid, canvasId: cid, nodeId: v.nodeId, patch: { prompt: '【本段 ' + (k + 1) + '/' + segCount + '】本段覆盖分镜第 ' + (shotFrom + 1) + '-' + (shotTo + 1) + ' 镜（共 ' + shots.length + ' 镜），时长约 ' + seg.duration + ' 秒；只生成本段内容，不要越界到其他段的镜头。' } });
              try {
                const d2 = readToolDoc({ projectId: pid, canvasId: cid });
                const n2 = d2.nodes[v.nodeId];
                if (n2) {
                  n2.data = { ...(n2.data || {}), segShotFrom: shotFrom, segShotTo: shotTo, segIndex: k, segCount, needsTailChain: seg.needsTailChain === true, seamRisk: String(seg.seamRisk || 'none') };
                  writeToolDoc({ projectId: pid, canvasId: cid }, d2);
                }
              } catch { /* 段键写不进不阻塞：prompt 通道兜底 */ }
              // T8：先连后生成——collectRefs 生成时严格只读连线，本段 exec 前必须把该场实体的
              // 参考图全部接到 ref 口（Multi-input，可多张）；连线失败只记日志，不阻塞视频段。
              for (const ent of boardEntities) {
                const hit = refImageByEntity.get(ent.key);
                if (!hit) continue;
                try {
                  canvasConnect({ projectId: pid, canvasId: cid, fromNode: hit.nodeId, toNode: v.nodeId, toPort: 'ref' });
                } catch (e) {
                  const msg = hit.label + ' → ' + label + ' ref 连线失败：' + String((e && e.message) || e);
                  run.log.push({ at: Date.now(), role: 'runner', summary: msg });
                  run.paidLog.push({ at: Date.now(), text: msg });
                }
              }
              let done = false; let err = null;
              for (let attempt = 0; attempt < 2 && !done; attempt++) {
                if (attempt > 0 && run.paidAbort) { abortNow(); return; }
                try { await canvasExec(pid, cid, v.nodeId, { timeoutMs: 15 * 60 * 1000 }); done = true; }
                catch (e) { err = e; run.paidLog.push({ at: Date.now(), text: label + ' 第 ' + (attempt + 1) + ' 次失败：' + String((e && e.message) || e) }); }
              }
              if (!done) throw err;
              lastVideo = v.nodeId;
              run.paidLog.push({ at: Date.now(), text: label + ' 完成' });
            }
          }
          // T8 ③：参考图预算偏差诚实化——run.budget.refImagesTotal 是免费段终点的快照，
          // 镜头/设定集中途变化就对不上；只记日志不阻塞（与段数偏差日志同一语义）。
          const budgetRefs = run.budget && Number.isFinite(Number(run.budget.refImagesTotal)) ? Number(run.budget.refImagesTotal) : null;
          if (budgetRefs != null && budgetRefs !== refImagesMade) {
            const msg = '参考图预算与实际不一致（预算 ' + budgetRefs + ' / 实际 ' + refImagesMade + '）';
            run.log.push({ at: Date.now(), role: 'runner', summary: msg });
            run.paidLog.push({ at: Date.now(), text: msg });
          }
          if (lastVideo) {
            const fc = canvasCreateNode({ projectId: pid, canvasId: cid, type: 'finalcut', name: '成片', connectFrom: lastVideo });
            if (fc && fc.nodeId) run.finalcutNodeId = fc.nodeId;
          }
          run.paid = 'done'; run.paidPhase = 'done';
          run.paidLog.push({ at: Date.now(), text: lastVideo ? '全部视频完成，已建成片节点' : '没有待生成的视频' });
        } catch (e) {
          run.paid = 'failed'; run.paidError = String((e && e.message) || e);
        }
      })();
      return { ok: true, status: 'running', quoteId: ap.quoteId };
    }
    __autoApi.runs = AUTO_RUNS;
    __autoApi.setRoomLlm = (fn) => { roomLlm = fn; };
    __autoApi.setCanvasRunner = (fn) => { canvasExec = fn; };
    __autoApi.editDirectorSpec = editDirectorSpec;
    __autoApi.planCameraMotion = planCameraMotion;

    const methods = {
      async ping() { return { ok: true, version: VERSION }; },
      async llmOptions() { return listLlmOptions(); },
      async llmComplete(args) { return complete(args); },
      async updateCheck() { return updateCheck(); },
      async updateInstall() { return updateInstall(); },
      async updateGetRegistry() {
        const cfg = readIcConfig();
        const override = cfg.updateRegistry === 'china' || cfg.updateRegistry === 'official' ? cfg.updateRegistry : 'auto';
        return { override, resolved: cfg.updateRegistryResolved || null, cachedAt: cfg.updateRegistryAt || null, registries: NPM_REGISTRIES };
      },
      async updateSetRegistry(args) {
        const v = String((args && args.override) || 'auto');
        if (v !== 'auto' && v !== 'official' && v !== 'china') throw new Error('updateRegistry 只接受 auto / official / china');
        const cfg = readIcConfig();
        cfg.updateRegistry = v;
        // 覆盖变化后清掉自动探测缓存：显式覆盖不需要缓存；切回 auto 时重新探测
        delete cfg.updateRegistryResolved;
        delete cfg.updateRegistryAt;
        writeIcConfig(cfg);
        return { override: v, resolved: null };
      },
      async dataRootGet() {
        const root = dataRoot();
        let exists = false;
        if (root) { try { exists = statSync(root).isDirectory(); } catch { /* 不存在 */ } }
        return { dataRoot: root, exists, configPath: CONFIG_PATH, sql: !!SQLITE, store: sqlActive() ? 'sqlite' : 'json' };
      },
      /** BLK-02：项目在数据根下的**绝对目录** = <dataRoot>/projects/<物理文件夹>。
       *  画布调 ArtCraft 时以它为 base（ArtCraft 0.3.x 无数据根概念、/status 也不再返回 dataRoot），
       *  避免「无 base 的相对路径」被按插件进程 cwd 解析而静默写错目录。 */
      async projectDirGet(args) {
        const root = dataRoot();
        const pid = String((args && args.projectId) || '');
        if (!root) return { ok: false, error: '未设置数据根目录', projectId: pid };
        if (!pid) return { ok: false, error: '缺少 projectId', projectId: pid };
        const meta = readDataRootMeta();
        const entry = meta.projects.find((p) => p.id === pid) || null;
        const folder = entry ? entry.folder : sanitizeFolderName(pid);
        const abs = path.join(root, 'projects', folder);
        try { mkdirSync(abs, { recursive: true }); } catch { /* 目录建不出来交给调用方报错 */ }
        return { ok: true, projectId: pid, folder, abs, dataRoot: root, legacy: !entry };
      },
      /** 提交留痕（0.20.2 能力③）：{projectId, entry} → 追加一行脱敏 JSONL 到 <项目目录>/submissions.jsonl。
       *  目录解析与 projectDirGet 同一基准；写失败返回 ok:false（客户端留痕是尽力而为，绝不挡生成）。 */
      async submissionLogAppend(args) {
        const dir = await methods.projectDirGet({ projectId: args && args.projectId });
        if (!dir || !dir.ok) return { ok: false, error: (dir && dir.error) || '项目目录不可用' };
        return submissionLogAppendImpl(dir.abs, args && args.entry);
      },
      // IC-B4：FTS 存量孤儿一次性清理（幂等，可重复调；无 SQLite 时明确说不适用）
      async ftsReconcile() {
        if (!sqlActive()) return { ok: false, error: '当前不是 SQLite 存储模式，无 FTS 需要清理', applicable: false };
        return ftsReconcile(getDb());
      },
      /** IC-B2：删除项目时清理其目录下的 craft/（ArtCraft 后期产物）。
       *  客户端知道自己要删哪个项目，Host 按项目物理文件夹定位（与 projectDirGet 同一基准），
       *  只删 projects/<folder>/craft 这一个子目录——绝不碰项目镜像、其他项目、数据根其他内容。
       *  幂等：目录不存在也是成功；失败可见（removed=false + reason），不静默吞。 */
      /** 3D-BOX stage id：文件系统安全 + 稳定（一个 stage = 一条库记录）。 */
      async directorStageSave(args) {
        const dir = await methods.projectDirGet({ projectId: args && args.projectId });
        if (!dir || !dir.ok) return { ok: false, error: (dir && dir.error) || '项目目录不可用' };
        const craftDir = path.join(dir.abs, 'craft');
        const stageId = safeStageId(args && args.stageId);
        const spec = (args && args.spec) || null;
        if (!spec || typeof spec !== 'object') return { ok: false, error: '缺少 spec 对象' };
        const payload = { ok: true, savedAt: Date.now(), stageId: stageId || null, spec };
        try {
          if (stageId) {
            const stageDir = path.join(craftDir, '3dbox');
            mkdirSync(stageDir, { recursive: true });
            // 旧版单文件先迁到 3dbox/，避免第一次生成新 stage 时把旧预演覆盖掉。
            const legacyFile = path.join(craftDir, 'director-stage.json');
            if (existsSync(legacyFile)) {
              try {
                const old = JSON.parse(readFileSync(legacyFile, 'utf8'));
                const oldSid = safeStageId(old.stageId);
                if (!oldSid || oldSid !== stageId) {
                  const keepSid = oldSid || ('legacy_' + (Number(old.savedAt) || Date.now()));
                  const keepFile = path.join(stageDir, safeStageId(keepSid) + '.json');
                  if (!existsSync(keepFile)) writeFileSync(keepFile, JSON.stringify({ ...old, stageId: safeStageId(keepSid) }, null, 2), 'utf8');
                }
              } catch { /* 旧文件损坏则放弃迁移，不阻塞新保存 */ }
            }
            writeFileSync(path.join(stageDir, stageId + '.json'), JSON.stringify(payload, null, 2), 'utf8');
          }
          // 兼容旧入口：始终维护「最近一次」文件（列表会按 stageId 去重，不重复展示）
          mkdirSync(craftDir, { recursive: true });
          writeFileSync(path.join(craftDir, 'director-stage.json'), JSON.stringify(payload, null, 2), 'utf8');
        } catch (e) { return { ok: false, error: '写入失败: ' + String((e && e.message) || e) }; }
        return { ok: true, projectId: String(args.projectId), stageId: stageId || null, file: path.join(craftDir, stageId ? '3dbox/' + stageId + '.json' : 'director-stage.json'), bytes: Buffer.byteLength(JSON.stringify(payload)) };
      },
      async directorStageLoad(args) {
        const dir = await methods.projectDirGet({ projectId: args && args.projectId });
        if (!dir || !dir.ok) return { ok: false, error: (dir && dir.error) || '项目目录不可用' };
        const stageId = safeStageId(args && args.stageId);
        const file = stageId
          ? path.join(dir.abs, 'craft', '3dbox', stageId + '.json')
          : path.join(dir.abs, 'craft', 'director-stage.json');
        if (!existsSync(file)) return { ok: true, found: false, file, stageId: stageId || null };
        try {
          const doc = JSON.parse(readFileSync(file, 'utf8'));
          return { ok: true, found: true, file, stageId: stageId || doc.stageId || null, savedAt: doc.savedAt || null, spec: doc.spec || null };
        } catch (e) { return { ok: false, found: false, file, stageId: stageId || null, error: '读取失败: ' + String((e && e.message) || e) }; }
      },
      async directorStageList() {
        let list = [];
        try { list = await projectsList(); } catch { list = []; }
        const items = [];
        const seen = new Set();
        for (const p of (Array.isArray(list) ? list : [])) {
          try {
            const dir = await methods.projectDirGet({ projectId: p.id });
            if (!dir || !dir.ok) continue;
            const craftDir = path.join(dir.abs, 'craft');
            const stageDir = path.join(craftDir, '3dbox');
            const files = [];
            try {
              for (const f of readdirSync(stageDir)) if (f.endsWith('.json')) files.push({ file: path.join(stageDir, f), stageId: f.slice(0, -5) });
            } catch { /* 没有目录 */ }
            files.push({ file: path.join(craftDir, 'director-stage.json'), stageId: null });
            for (const ent of files) {
              if (!existsSync(ent.file)) continue;
              let doc = null;
              try { doc = JSON.parse(readFileSync(ent.file, 'utf8')); } catch { continue; }
              const sid = safeStageId(ent.stageId || doc.stageId);
              const key = p.id + '::' + (sid || 'legacy');
              if (seen.has(key)) continue;
              seen.add(key);
              const spec = doc.spec || {};
              items.push({
                projectId: p.id, projectName: p.name || p.id, stageId: sid || null,
                title: String(spec.title || '3D-BOX'),
                savedAt: Number(doc.savedAt) || 0,
                cameras: Array.isArray(spec.cameras) ? spec.cameras.length : 0,
                shots: Array.isArray(spec.shots) ? spec.shots.length : 0,
                duration: Number(spec.duration) || 0,
              });
            }
          } catch { /* 单个项目读失败不影响列表 */ }
        }
        items.sort((a, b) => b.savedAt - a.savedAt);
        return { ok: true, multiStage: true, items };
      },
      async directorStageBrief(args) {
        const projectId = String((args && args.projectId) || '');
        const brief = String((args && args.brief) || '').trim();
        if (!brief) return { ok: false, error: '需要 brief' };
        const eng = await loadDirectorEngine();
        if (!eng || typeof eng.specFromBrief !== 'function') return { ok: false, error: '引擎未就绪' };
        const stageId = safeStageId(args && args.stageId) || ('box_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
        const scene = String((args && args.scene) || '');
        let spec = null;
        let source = 'llm';
        let warning = '';
        if (scene === 'blank') {
          spec = eng.specFromBrief(brief, { scene: 'blank', style: args && args.style, cameraMove: args && args.cameraMove, duration: args && args.duration });
          source = 'blank';
        } else {
          try {
            const made = await briefDirectorSpec(brief, {
              scene: args && args.scene, style: args && args.style,
              cameraMove: args && args.cameraMove, duration: args && args.duration,
            });
            spec = made.spec;
          } catch (e) {
            // 明确降级：AI 失败时仍可出图，但前端必须展示 warning（不静默假装 AI 成功）
            spec = enrichDirectorSpec(eng.specFromBrief(brief, {
              scene: args && args.scene, style: args && args.style,
              cameraMove: args && args.cameraMove, duration: args && args.duration,
            }), brief);
            source = 'fallback';
            warning = 'AI 搭景失败，已使用本地模板：' + String((e && e.message) || e);
          }
        }
        try {
          const saved = await methods.directorStageSave({ projectId, stageId, spec });
          if (!saved || !saved.ok) return { ok: false, error: (saved && saved.error) || '保存失败' };
          return { ok: true, projectId, stageId, briefVersion: 2, spec, source, warning, savedAt: saved.savedAt || Date.now() };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      async directorStageEdit(args) {
        const projectId = String((args && args.projectId) || '');
        const stageId = safeStageId(args && args.stageId);
        const instruction = String((args && args.instruction) || '').trim();
        if (!instruction) return { ok: false, error: '需要 instruction' };
        const cur = await methods.directorStageLoad({ projectId, stageId });
        if (!cur || !cur.ok) return { ok: false, error: (cur && cur.error) || '读取场景失败' };
        if (!cur.found || !cur.spec) return { ok: false, error: '当前 3D-BOX 还没有规格：先生成或导入一版' };
        try {
          const edited = await editDirectorSpec(cur.spec, instruction);
          const saved = await methods.directorStageSave({ projectId, stageId, spec: edited.spec });
          if (!saved || !saved.ok) return { ok: false, error: (saved && saved.error) || '保存失败' };
          return { ok: true, projectId, stageId: stageId || null, spec: edited.spec, savedAt: saved.savedAt || Date.now() };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      async directorStageCamera(args) {
        const projectId = String((args && args.projectId) || '');
        const stageId = safeStageId(args && args.stageId);
        const prompt = String((args && args.prompt) || '').trim();
        const moveId = String((args && args.cameraMove) || '').trim();
        if (!prompt && !moveId) return { ok: false, error: '需要 prompt 或 cameraMove' };
        const cur = await methods.directorStageLoad({ projectId, stageId });
        if (!cur || !cur.ok) return { ok: false, error: (cur && cur.error) || '读取场景失败' };
        if (!cur.found || !cur.spec) return { ok: false, error: '当前 3D-BOX 还没有规格：先生成或导入一版' };
        try {
          if (prompt) {
            const planned = await planCameraMotion(cur.spec, prompt, { duration: args && args.duration });
            const saved = await methods.directorStageSave({ projectId, stageId, spec: planned.spec });
            if (!saved || !saved.ok) return { ok: false, error: (saved && saved.error) || '保存失败' };
            return { ok: true, projectId, stageId: stageId || null, spec: planned.spec, keys: planned.keys.length, savedAt: saved.savedAt || Date.now() };
          }
          const eng = await loadDirectorEngine();
          if (!eng || typeof eng.applyCameraMove !== 'function') return { ok: false, error: '引擎未就绪' };
          const next = eng.applyCameraMove(cur.spec, moveId, { duration: args && args.duration });
          const saved = await methods.directorStageSave({ projectId, stageId, spec: next });
          if (!saved || !saved.ok) return { ok: false, error: (saved && saved.error) || '保存失败' };
          return { ok: true, projectId, stageId: stageId || null, spec: next, keys: (next.cameras && next.cameras[0] && next.cameras[0].keys || []).length, savedAt: saved.savedAt || Date.now() };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      async projectCraftRemove(args) {
        const root = dataRoot();
        const pid = String((args && args.projectId) || '');
        if (!root) return { ok: false, error: '未设置数据根目录', projectId: pid };
        if (!pid) return { ok: false, error: '缺少 projectId', projectId: pid };
        const meta = readDataRootMeta();
        const entry = meta.projects.find((p) => p.id === pid) || null;
        const folder = entry ? entry.folder : sanitizeFolderName(pid);
        const craftDir = path.join(root, 'projects', folder, 'craft');
        // 防御：拼出来的必须是 <root>/projects/<folder>/craft，任何异常形态都拒绝执行
        if (path.resolve(craftDir).toLowerCase() !== craftDir.toLowerCase() || !craftDir.toLowerCase().includes((path.join(root, 'projects')).toLowerCase())) {
          return { ok: false, error: '拒绝执行：目标目录形态异常', projectId: pid, craftDir };
        }
        if (!existsSync(craftDir)) return { ok: true, removed: false, existed: false, craftDir, projectId: pid };
        try {
          rmrf(craftDir);
          const gone = !existsSync(craftDir);
          return { ok: gone, removed: gone, existed: true, craftDir, projectId: pid, error: gone ? null : '目录仍存在（可能被占用）' };
        } catch (e) {
          return { ok: false, removed: false, existed: true, craftDir, projectId: pid, error: String((e && e.message) || e) };
        }
      },
      // 存储实况：一眼看清"是否真在用 SQLite 库、库在哪、多少数据"（客户端设置页显示）
      async dbStats() {
        const root = dataRoot();
        const dbPath = root ? path.join(root, 'canvas.db') : null;
        const out = {
          ok: true, sqlite: !!SQLITE, store: sqlActive() ? 'sqlite' : (root ? 'json' : 'none'),
          dataRoot: root, dbPath, dbExists: false, dbBytes: 0, walBytes: 0, projects: 0, assets: 0, fts: null,
        };
        if (dbPath) {
          try { const st = statSync(dbPath); out.dbExists = st.isFile(); out.dbBytes = st.size; } catch { /* 无库 */ }
          try { const st2 = statSync(dbPath + '-wal'); out.walBytes = st2.size; } catch { /* 无 WAL */ }
        }
        if (sqlActive()) {
          try {
            const db = getDb();
            out.projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
            out.assets = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
            out.fts = metaGet(db, 'fts_tokenizer');
          } catch (e) { out.error = String((e && e.message) || e); }
        }
        return out;
      },
      async dataRootSet(args) {
        return setDataRoot((args && args.root) ?? '');
      },
      async dataRootReveal() {
        const root = dataRoot();
        if (!root) throw new Error('未设置数据根目录');
        mkdirSync(root, { recursive: true });
        const open = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        // spawn 的失败是**异步 error 事件**（ENOENT 等），不挂监听就会冒成进程级未捕获异常
        try {
          const child = spawn(open, [root], { detached: true, stdio: 'ignore' });
          child.on('error', () => { /* 打不开目录不算致命错误，忽略 */ });
          child.unref();
        } catch { /* 同步抛错同样忽略 */ }
        return { ok: true, dataRoot: root };
      },
      // 资产元数据写入（v1 兼容入口，0.18 起客户端走 assetCreate）：SQL 模式 upsert 进 assets 表
      async assetIndexPut(args) {
        const projectId = String((args && args.projectId) || '');
        const asset = (args && args.asset) || null;
        if (!projectId || !asset || !asset.id) throw new Error('需要 projectId 与 asset');
        if (sqlActive()) return dbAssetCreate({ ...asset, projectId });
        return writeAssetIndex(projectId, String((args && args.projectName) || ''), [asset]);
      },
      async assetIndexBulkPut(args) {
        const items = Array.isArray(args && args.items) ? args.items : [];
        if (sqlActive()) {
          // 兼容旧客户端的"启动全量同步"：逐条 upsert；空表不覆盖非空项目（防旧浏览器清库）
          const byProject = new Map();
          for (const it of items) {
            if (!it || !it.projectId) continue;
            const key = String(it.projectId);
            if (!byProject.has(key)) byProject.set(key, []);
            if (it.asset && it.asset.id) byProject.get(key).push(it.asset);
          }
          const db = getDb();
          let indexed = 0;
          for (const [pid, list] of byProject) {
            if (!list.length) {
              const n = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE project_id = ?').get(pid).n;
              if (n > 0) continue; // 空表保护：绝不因旧客户端启动清掉服务端已有资产
            }
            for (const a of list) { upsertAssetRow(db, assetRowFromRecord({ ...a, projectId: pid })); indexed++; }
          }
          return { ok: true, indexed, projects: byProject.size };
        }
        const byProject = new Map();
        for (const it of items) {
          if (!it || !it.projectId) continue;
          const key = String(it.projectId);
          if (!byProject.has(key)) byProject.set(key, { name: String(it.projectName || key), list: [] });
          if (it.asset && it.asset.id) byProject.get(key).list.push(it.asset); // asset=null 的项目占位也入组：assets.json 清空对齐
        }
        let indexed = 0;
        // 整表替换：客户端 IDB 是资产库唯一事实源，启动全量同步借此自愈残留的幽灵条目
        for (const [pid, { name, list }] of byProject) {
          writeAssetIndex(pid, name, list, { replace: true });
          indexed += list.length;
        }
        return { ok: true, indexed, projects: byProject.size };
      },
      // ===== 资产库 v2（0.18）：服务端是唯一事实源，任意浏览器/远程访问同一份 =====
      async assetsList(args) {
        if (sqlActive()) return dbAssetsList(args);
        return jsonAssetsList(args);
      },
      async assetsGet(args) {
        if (sqlActive()) return dbAssetsGet(args && args.ids);
        const ids = new Set((Array.isArray(args && args.ids) ? args.ids : []).map(String));
        const r = await jsonAssetsList({ limit: 200000 });
        return { ok: true, items: r.items.filter((a) => ids.has(String(a.id))) };
      },
      async assetNames(args) {
        if (sqlActive()) return dbAssetNames(args && args.projectId);
        const r = await jsonAssetsList({ projectId: args && args.projectId, limit: 200000 });
        return { ok: true, names: r.items.map((a) => ({ id: a.id, name: a.name })) };
      },
      async assetCreate(args) {
        const a = (args && args.asset) || null;
        if (!a || !a.id || !a.projectId) throw new Error('需要 asset.id 与 asset.projectId');
        if (sqlActive()) return dbAssetCreate(a);
        return writeAssetIndex(String(a.projectId), String((args && args.projectName) || ''), [a]);
      },
      async assetUpdate(args) {
        const id = String((args && args.id) || '');
        if (!id) throw new Error('需要 asset.id');
        if (sqlActive()) return dbAssetUpdate(id, (args && args.patch) || {});
        // JSON 降级：读旧索引改单条写回
        const r = await jsonAssetsList({ limit: 200000 });
        const cur = r.items.find((a) => String(a.id) === id);
        if (!cur) throw new Error('资产不存在：' + id);
        const patch = (args && args.patch) || {};
        const next = {
          ...cur,
          ...(patch.name !== undefined ? { name: String(patch.name).slice(0, 80) } : {}),
          ...(patch.category !== undefined ? { category: String(patch.category || 'general') } : {}),
          ...(patch.tags !== undefined ? { tags: Array.isArray(patch.tags) ? patch.tags.map(String).filter(Boolean).slice(0, 20) : [] } : {}),
          ...(patch.folder !== undefined ? { folder: String(patch.folder || '').slice(0, 80) } : {}),
          ...(patch.mergedInto !== undefined ? { mergedInto: patch.mergedInto ? String(patch.mergedInto) : undefined } : {}),
        };
        return writeAssetIndex(String(next.projectId), '', [next]);
      },
      // CAS 对象库 GC 已随写路径退役（IC-08）：见 dbObjectsGc 位置的说明。
      // 一键迁移/对齐：旧 pid 文件夹 → 项目名文件夹 + 全部项目文档镜像（v1 JSON 模式专用）
      async dataRootMigrate() {
        if (sqlActive()) return { ok: true, skipped: 'sqlite（数据目录即主存储，无需布局迁移）' };
        return dataRootMigrate();
      },
      // 一键导入：换电脑后把数据目录拷过来 → SQL 模式指向目录即自动挂载/迁移；JSON 模式扫描合并
      async dataRootImport() {
        if (sqlActive()) {
          const db = getDb();
          return { ok: true, mode: 'sqlite', migrated: JSON.parse(metaGet(db, 'migrated_counts') || '{}'), note: '数据目录已就绪：指向该目录后打开画布即为全部数据' };
        }
        return dataRootImport();
      },
      async pickFolder() {
        const r = await pickFolderDialog();
        return r; // { ok, path } | { ok:false, cancelled } | { ok:false, unsupported }
      },
      async projectsPut(args) { return projectsPut(args); },
      async projectsGet(args) { return projectsGet(args); },
      async projectsList() { return projectsList(); },
      async projectsDelete(args) { return projectsDelete(args); },
      async projectsSync() { return projectsSync(); },
      async canvasCreateProject(args) { return canvasCreateProject(args); },
      async canvasWriteNode(args) { return canvasWriteNode(args); },
      async canvasGetBible(args) { return canvasGetBible(args); },
      async canvasUpdateBible(args) { return canvasUpdateBible(args); },
      async canvasCreateNode(args) { return canvasCreateNode(args); },
      async canvasDeleteProject(args) { return canvasDeleteProject(args); },
      async canvasDeleteNode(args) { return canvasDeleteNode(args); },
      async canvasRunNode(args) { return canvasRunNode(args); },
      async canvasNodeStatus(args) { return canvasNodeStatus(args); },
      async canvasOpen(args) { return canvasOpen(args); },
      async canvasesList(args) { return canvasesList(args); },
      async canvasCreate(args) { return canvasCreate(args); },
      async canvasRename(args) { return canvasRename(args); },
      async canvasDelete(args) { return canvasDelete(args); },
      async assetDelete(args) {
        const id = String((args && args.id) || '');
        if (!id) return { ok: true };
        if (sqlActive()) return dbAssetDelete(id);
        const root = dataRoot();
        const rel = String((args && args.rel) || '');
        // 逻辑路径（pid）→ 物理路径（项目名文件夹）：不映射会删不到真实文件
        if (root && rel) {
          const mapped = physicalRel(rel) || rel;
          try {
            const { abs } = safeJoin(root, mapped);
            unlinkSync(abs);
          } catch { /* 已不存在视为成功 */ }
        }
        // 同步清掉 assets.json 里的记录，保持数据目录与应用状态一致
        const pid = String((args && args.projectId) || '');
        if (pid) {
          try { removeAssetIndexEntry(pid, String((args && args.projectName) || ''), id); } catch { /* 索引清理失败不影响 */ }
        }
        return { ok: true };
      },
      async listSkills() {
        const skills = ctx.get('skills');
        if (!skills) return { skills: [], error: 'skills 服务不可用' };
        try {
          const list = await skills.list({ limit: 200 });
          return {
            skills: (list ?? []).map((s) => ({ name: s.name, description: s.description ?? '' })),
          };
        } catch (e) {
          return { skills: [], error: String((e && e.message) || e) };
        }
    },
      async readSkill(args) {
        const skills = ctx.get('skills');
        if (!skills) throw new Error('skills 服务不可用');
        const name = String((args && args.name) ?? '');
        if (!name) throw new Error('缺少技能名');
        const def = await skills.get(name);
        if (!def) throw new Error('技能不存在: ' + name);
        const text = typeof def === 'string'
          ? def
          : (def.content ?? def.body ?? def.instructions ?? def.markdown ?? null);
        return {
          name,
          text: String(text ?? ((def && typeof def === 'object') ? JSON.stringify(def) : '')).slice(0, 80000),
        };
      },
      // ---- 会话↔画布绑定 RPC（0.20.x）：composer 画布选择器与画布面板跟随的数据面 ----
      /** 绑定能力探针：客户端用它识别「宿主进程仍是旧版」（旧宿主无此方法 → 返回 400 → 客户端提示重启）。 */
      async bindingCapabilities() {
        return { ok: true, rev: 2, anyProject: true };
      },
      // ---- 制作阶段机 RPC（0.20.0）：阶段/闸门/汇报语义的数据面 ----
      /** 制作能力探针（M0）：stageMachine/qualityGate 恒真；multiAgent = 宿主是否暴露会话服务
       *  （sessionController/agents，懒探测不加 inject——与 workspaceRegistry 同一安全模式）。
       *  multiAgent:false 时客户端隐藏「自动创作」入口，auto* RPC 一律拒绝。 */
      async productionCapabilities() {
        const svc = (name) => { try { return !!(ctx.get && ctx.get(name)); } catch { return false; } };
        const multiAgent = svc('sessionController') || svc('agents');
        return { ok: true, rev: 1, stageMachine: true, qualityGate: true, multiAgent, autoMode: multiAgent, version: VERSION, stages: PRODUCTION_STAGES };
      },
      /** 制作状态汇报：模型宣称"完成/可交付"前必须以 ready:true 为据；next 给当前阶段的下一步。 */
      async productionPrice() {
        const cfg = readIcConfig();
        const price = Number(cfg.production && cfg.production.videoUnitPricePerSecond);
        return { ok: true, price: Number.isFinite(price) && price > 0 ? price : 0, currency: 'CNY' };
      },
      async productionStatus(args) {
        const pid = String((args && args.projectId) || '');
        if (!pid) return { ok: false, error: '缺少 projectId' };
        try { projectFile(pid); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        return PROD.status(pid, toolCanvasId(args));
      },
      /** 显式推进/回退（返工）：必须带 reason（审计）；回退会下调 floor，随后按工具事件重新抬升。 */
      async productionAdvance(args) {
        const pid = String((args && args.projectId) || '');
        if (!pid) return { ok: false, error: '缺少 projectId' };
        try { projectFile(pid); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        return PROD.advance(pid, toolCanvasId(args), String((args && args.to) || ''), String((args && args.reason) || ''), 'user');
      },
      // ---- 自动创作（实验，A1 两段式）：开关默认关；关闭时所有 auto* 一律拒绝 ----
      /** 开关状态 + 能力（multiAgent 取决于宿主是否暴露会话服务，M0 探针）。 */
      async autoModeGet() {
        const cfg = readIcConfig();
        const enabled = !!(cfg.ui && cfg.ui.autoMode);
        return { ok: true, enabled, caps: await methods.productionCapabilities() };
      },
      /** 打开/关闭自动创作。默认关闭；打开只是"允许入口"，不启动任何创作、不花钱。 */
      async autoModeSet(args) {
        const enabled = !!(args && args.enabled);
        const cfg = readIcConfig();
        cfg.ui = { ...(cfg.ui || {}), autoMode: enabled };
        writeIcConfig(cfg);
        return { ok: true, enabled };
      },
      /** 预算单（免费段终点）：场/镜/秒数/视频调用次数（+配置了单价时的估算金额）。
       *  0.20.2 T9（#9）：没配单价时 estimatedCost 为 null、金额行不显示（无法算钱是设计），
       *  但要在 note 追加配置引导（锚点词「视频每秒单价」）——note 不进预算指纹，批准校验不受影响。 */
      async autoQuote(args) {
        if (!autoEnabled()) return autoDisabled();
        const pid = String((args && args.projectId) || '');
        if (!pid) return { ok: false, error: '缺少 projectId' };
        const cfg = readIcConfig();
        const price = Number(args && args.unitPricePerSecond);
        const configured = Number(cfg.production && cfg.production.videoUnitPricePerSecond);
        const q = PROD.quote(pid, toolCanvasId(args), Number.isFinite(price) && price > 0 ? price : configured);
        if (q && q.ok && q.estimatedCost == null) {
          q.note = (q.note ? q.note + '；' : '') + '未配置视频单价——在画布设置 → 制作 → 视频每秒单价 填入后可显示估算金额';
        }
        return q;
      },
      /** 批准付费段：一次性令牌，绑定预算指纹；镜头/时长一变即失效（须重新复核）。 */
      async autoApprove(args) {
        if (!autoEnabled()) return autoDisabled();
        const pid = String((args && args.projectId) || '');
        if (!pid) return { ok: false, error: '缺少 projectId' };
        const cfg = readIcConfig();
        const price = Number(cfg.production && cfg.production.videoUnitPricePerSecond);
        return PROD.approve(pid, toolCanvasId(args), String((args && args.quoteId) || ''), String((args && args.confirm) || ''), price);
      },
      /** 付费段：批准后逐分镜表生成视频（真实计费）；失败重试，全部完成建成片节点。
       *  0.20.2 T9（#9）：可选 scenes 选场执行——1-based 场号数组（对应预算单 scenes[].scene，
       *  boards[i] 的场号 = i+1），不传 = 全量（现行为零变化）；被排除的场不建视频节点、
       *  连参考图都不生成（实体收集只跑选中场）。批准令牌与指纹零改动：autoPaid 入口仍按
       *  全量预算校验，scenes 只是执行过滤器——镜头变了要重新复核。非法 scenes（非数组/
       *  空数组/含非正整数/场号越界）→ ok:false 业务错误，不启动。 */
      async autoGenerate(args) {
        if (!autoEnabled()) return autoDisabled();
        const pid = String((args && args.projectId) || '');
        if (!pid) return { ok: false, error: '缺少 projectId' };
        let scenes = null;
        const rawScenes = args ? args.scenes : undefined;
        if (rawScenes != null) {
          if (!Array.isArray(rawScenes)) return { ok: false, error: 'scenes 必须是场号数组（1-based，对应预算单 scenes 的 scene 字段）；不传跑全部' };
          if (!rawScenes.length) return { ok: false, error: 'scenes 不能是空数组：要么不传跑全部，要么至少给一个场号' };
          let sceneCount = 0;
          try {
            const doc = readToolDoc({ projectId: pid, canvasId: toolCanvasId(args) });
            sceneCount = Object.values(doc.nodes || {}).filter((n) => n.type === 'storyboard' && Array.isArray(n.data && n.data.shots) && n.data.shots.length).length;
          } catch { sceneCount = 0; }
          for (const s of rawScenes) {
            const n = Number(s);
            if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'scenes 含非法场号（必须是正整数，1-based）：' + JSON.stringify(rawScenes) };
            if (n > sceneCount) return { ok: false, error: '场号 ' + n + ' 超出当前场数（当前 ' + sceneCount + ' 场分镜）：先完成免费段生成分镜，或修正 scenes' };
          }
          scenes = rawScenes.map(Number);
        }
        return autoPaid(pid, toolCanvasId(args), scenes);
      },
      /** 自动创作总状态：开关 / 阶段 / 当前批准是否仍有效 / 编剧室运行状态 / 下一步。 */
      async autoStatus(args) {
        const cfg = readIcConfig();
        const enabled = !!(cfg.ui && cfg.ui.autoMode);
        const caps = await methods.productionCapabilities();
        const pid = String((args && args.projectId) || '');
        const run = pid ? AUTO_RUNS.get(runKeyOf(pid, toolCanvasId(args))) : null;
        const runView = run ? { status: run.status, phase: run.phase, error: run.error || null,
          log: run.log.slice(-6), meetingNodeId: run.meetingNodeId || null, scriptNodeId: run.scriptNodeId || null, startedAt: run.startedAt,
          budget: run.budget || null, boards: run.boards || [], paid: run.paid || null, paidPhase: run.paidPhase || null, paidError: run.paidError || null,
          paidLog: (run.paidLog || []).slice(-6), finalcutNodeId: run.finalcutNodeId || null } : null;
        if (!enabled || !pid) return { ok: true, enabled, caps, stage: null, approval: null, run: runView };
        const price = Number(cfg.production && cfg.production.videoUnitPricePerSecond);
        const st = PROD.status(pid, toolCanvasId(args));
        return {
          ok: true, enabled, caps,
          stage: st.stage, ready: st.ready, blockers: st.blockers,
          approval: PROD.approvalOf(pid, toolCanvasId(args), price),
          quote: PROD.quote(pid, toolCanvasId(args), price),
          run: runView,
        };
      },
      /** 启动免费段（编剧室）：调研 → 编剧A/B 独立提案 → 互评 → 监制决策 → 设定集+剧本 idea 落盘。
       *  全程零付费；讨论记录写进「编剧室会议」文本节点；剧情走向只来自 brief。
       *  0.20.2 T10 断点续跑：制作状态文件里有**未完成的** ps.autoRun 且（未传 brief 或 brief 与存储一致）
       *  → 从断点续跑（已完成阶段不调 LLM、不重建节点，log/note 注明跳过数）；传了不同 brief → 全新启动
       *  （检查点被覆盖——用户换创意是有意的）；上次已完结（completed）/无持久化/形状损坏 → 现行为全新启动。
       *  续跑时 brief 非必需（用存储值）。 */
      async autoStart(args) {
        if (!autoEnabled()) return autoDisabled();
        const pid = String((args && args.projectId) || '');
        if (!pid) return { ok: false, error: '缺少 projectId' };
        const cid = toolCanvasId(args);
        const brief = String((args && args.brief) || '').trim();
        // T10：读持久化 run（读失败/形状不对/已完结 → 视同无持久化，全新启动）
        let saved = null;
        try {
          const ps = PROD.readState(pid, cid);
          saved = (ps && ps.autoRun) || null;
        } catch { saved = null; }
        if (!autoCkptValid(saved)) saved = null;
        const resuming = !!saved && (!brief || brief === saved.brief);
        if (!resuming && brief.length < 4) return { ok: false, error: '缺少 brief：请给一句话创意（至少 4 个字），它是剧情走向的唯一源头' };
        const runKey = runKeyOf(pid, cid);
        const prev = AUTO_RUNS.get(runKey);
        if (prev && prev.status === 'running') return { ok: false, error: '该画布已有自动创作在跑（阶段 ' + prev.phase + '）：先 autoAbort 或等待完成' };
        const effBrief = resuming ? saved.brief : brief;
        const skipN = resuming ? autoCkptSkipCount(saved) : 0;
        const run = { status: 'running', phase: resuming ? autoCkptDisplayPhase(saved) : 'start',
          log: [{ at: Date.now(), role: 'runner', summary: resuming ? '断点续跑：跳过 ' + skipN + ' 个已完成阶段' : '启动：' + effBrief.slice(0, 60) }],
          error: null, brief: effBrief, startedAt: resuming ? (Number(saved.startedAt) || Date.now()) : Date.now(), meetingNodeId: null, scriptNodeId: null };
        AUTO_RUNS.set(runKey, run);
        // brief + 检查点记进制作状态（status 可见；重启后仍能查到这一集的创意源头与断点）
        try {
          const ps = PROD.readState(pid, cid) || { version: 1, projectId: pid, canvasKey: (cid || 'default'), floor: 0, explicit: null, createdAt: Date.now(), updatedAt: 0, history: [], overrides: [] };
          ps.brief = effBrief;
          ps.autoRun = resuming ? JSON.parse(JSON.stringify(saved)) : { brief: effBrief, phase: null, completed: false, outputs: {}, meetingNodeId: null, scriptNodeId: null, scenes: null, boardIds: [], startedAt: run.startedAt, updatedAt: Date.now() };
          ps.updatedAt = Date.now();
          PROD.writeState(pid, cid, ps);
        } catch { /* 状态写入失败不阻塞启动 */ }
        autoRoom(pid, cid, effBrief, resuming ? JSON.parse(JSON.stringify(saved)) : null).catch(() => { /* 兜底：autoRoom 内部已捕获并落状态 */ });
        return { ok: true, runId: runKey, status: 'running', note: resuming
          ? '已从断点续跑（跳过 ' + skipN + ' 个已完成阶段）；用 autoStatus 查看进度'
          : '免费段已启动（调研→提案→互评→决策→落盘）·全新启动；用 autoStatus 查看进度' };
      },
      /** 中止运行中的自动创作（免费段或付费段）：保留已产出内容（讨论节点/设定集/节点/已完成视频）。 */
      async autoAbort(args) {
        if (!autoEnabled()) return autoDisabled();
        const pid = String((args && args.projectId) || '');
        if (!pid) return { ok: false, error: '缺少 projectId' };
        const run = AUTO_RUNS.get(runKeyOf(pid, toolCanvasId(args)));
        if (!run) return { ok: false, error: '该画布没有正在运行的自动创作' };
        let stopped = false;
        if (run.status === 'running') { run.status = 'aborted'; stopped = true; }
        if (run.paid === 'running') { run.paidAbort = true; run.paid = 'aborting'; stopped = true; }
        if (!stopped) return { ok: false, error: '该画布没有正在运行的自动创作' };
        run.error = null;
        run.log.push({ at: Date.now(), role: 'runner', summary: '已中止（保留已产出内容）' });
        return { ok: true, status: run.status, paid: run.paid };
      },
      async sessionBindingGet(args) {
        const sid = String((args && args.sessionId) || '');
        if (!sid) return { ok: false, error: '缺少 sessionId' };
        const sc = wsSessionContext(sid);
        if (!sc.supported) return { ok: true, supported: false };
        // 绑定查找是**全局**的（工作区内嵌 + 数据根项目都可被绑定）：先找会话现绑的项目；
        // 未绑定时再退回会话所在工作区项目（仅供上下文/画布清单，不产生绑定）。
        const boundHit = toolBindingForSession(sid);
        let pid = boundHit ? boundHit.projectId : null;
        if (!pid && sc.ws) {
          let rec = wsRecOf(sc.ws);
          if (!rec && sc.list) {
            // watcher 可能还没轮到：按**完整** registry 补扫一次（单工作区补扫会清掉其他工作区缓存）
            wsProjectsScan(sc.list);
            rec = wsRecOf(sc.ws);
          }
          if (rec) pid = rec.pid;
        }
        if (!pid) return { ok: true, supported: true, workspace: sc.ws ? wsView(sc.ws) : null, project: null, binding: null, canvasId: null, canvases: [], occupied: {} };
        const data = bindingsRead(pid);
        const binding = boundHit ? (data.bindings.find((b) => b && b.sessionId === sid) || null) : null;
        const pdoc = readDocOrNull(pid) || {};
        const canvases = canvasesOfDoc(pdoc);
        const occupied = {};
        for (const b of data.bindings) if (b && b.sessionId !== sid && b.canvasId) occupied[b.canvasId] = b.sessionId;
        return {
          ok: true, supported: true,
          workspace: sc.ws ? wsView(sc.ws) : null,
          project: { id: pid, name: pdoc.name || pid },
          binding: binding ? { canvasId: binding.canvasId, boundAt: binding.boundAt || 0 } : null,
          canvasId: binding ? binding.canvasId : null,
          defaultCanvasName: defaultCanvasNameForApi(pdoc),
          canvases, occupied,
        };
      },
      async sessionBindingSet(args) {
        const sid = String((args && args.sessionId) || '');
        if (!sid) return { ok: false, error: '缺少 sessionId' };
        const sc = wsSessionContext(sid);
        if (!sc.supported) return { ok: false, unsupported: true, error: '当前宿主无工作区能力，无法绑定画布' };
        let pid = String((args && args.projectId) || '');
        if (!pid) {
          if (!sc.ws) return { ok: false, error: '会话不在任何工作区，无法解析项目' };
          const rec = wsRecOf(sc.ws);
          if (!rec) return { ok: false, error: '该工作区还没有画布项目' };
          pid = rec.pid;
        }
        // 项目必须是真实存在的画布项目（工作区内嵌或数据根均可）；存在性由 bindingSet 校验
        const alive = (t) => sc.isAlive(t);
        return bindingSet(pid, sid, (args && args.canvasId) ?? null, alive);
      },
      async sessionBindingClear(args) {
        const sid = String((args && args.sessionId) || '');
        if (!sid) return { ok: false, error: '缺少 sessionId' };
        const sc = wsSessionContext(sid);
        if (!sc.supported) return { ok: false, unsupported: true, error: '当前宿主无工作区能力' };
        let pid = String((args && args.projectId) || '');
        if (!pid) {
          // 绑定查找是全局的：先找会话**实际绑定**的项目（绑定可指向数据根老项目）
          const hit = toolBindingForSession(sid);
          if (hit) pid = hit.projectId;
        }
        if (!pid && sc.ws) {
          const rec = wsRecOf(sc.ws);
          if (rec) pid = rec.pid;
        }
        if (!pid) return { ok: true, removed: false };
        return bindingClear(pid, sid);
      },
      /** 可绑定的项目清单（画布选择器未绑定态用）：工作区内嵌 + 数据根混排，按更新时间倒序，每项带画布清单。 */
      async bindableProjects() {
        const out = [];
        try {
          for (const rec of wsProjects.values()) {
            const doc = readDocOrNull(rec.pid) || {};
            out.push({
              id: rec.pid, name: doc.name || rec.pid, origin: 'workspace',
              updatedAt: doc.updatedAt || 0, canvases: canvasesOfDoc(doc),
            });
          }
        } catch { /* 单个项目读取失败跳过 */ }
        try {
          for (const p of projectsListDataRoot()) {
            if (wsProjects.has(p.id)) continue;
            const canvases = (p.defaultCanvasDeleted ? [] : [{ id: null, name: p.defaultCanvasName || '默认画布' }])
              .concat((p.canvases || []).map((c) => ({ id: c.id, name: c.name })));
            out.push({ id: p.id, name: p.name, origin: 'dataRoot', updatedAt: p.updatedAt || 0, canvases });
          }
        } catch { /* 无数据根：仅工作区项目 */ }
        out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return { ok: true, projects: out.slice(0, 100) };
      },
      async workspaceProjectCreate(args) {        const sid = String((args && args.sessionId) || '');
        if (!sid) return { ok: false, error: '缺少 sessionId' };
        const sc = wsSessionContext(sid);
        if (!sc.supported) return { ok: false, unsupported: true, error: '当前宿主无工作区能力' };
        if (!sc.ws) return { ok: false, error: '会话不在任何工作区（仅会话无法挂画布项目）' };
        let rec = wsRecOf(sc.ws);
        let createdNow = false;
        if (!rec && sc.list) {
          wsProjectsScan(sc.list); // 完整补扫（语义同上：不清其他工作区的账）
          rec = wsRecOf(sc.ws);
        }
        if (!rec) { rec = wsProjectCreateAt(sc.ws); createdNow = true; }
        // 存量修正：机器生成的项目名（= 目录名 / 项目 id / ws* 随机串）→ 改用工作区显示名。
        // 用户手动改过名的项目（既不等于目录名也不像 id）绝不覆盖。
        const wsTitle = String((sc.ws && sc.ws.title) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (rec && wsTitle) {
          try {
            const doc = readDoc(rec.pid);
            const cur = String(doc.name || '').trim();
            const folder = (path.basename(String((sc.ws && sc.ws.path) || '')) || '').trim();
            const machineNamed = !cur || cur === folder || cur === rec.pid || /^ws[a-z0-9]{8,}$/i.test(cur);
            if (machineNamed && cur !== wsTitle) patchProjectDoc(rec.pid, { name: wsTitle });
          } catch { /* 修正失败不阻塞创建/绑定 */ }
        }
        const name = String((args && args.name) || '').trim();
        if (createdNow && name) {
          try { patchProjectDoc(rec.pid, { name: name.slice(0, 80) }); } catch { /* 改名失败不阻塞 */ }
        }
        // 只在**新建**时自动绑默认画布（复用既有项目时不强行绑定：绑定走选择器，避免占用冲突）
        let bound = null;
        if (createdNow) bound = await bindingSet(rec.pid, sid, null, sc.isAlive);
        return {
          ok: true, projectId: rec.pid, created: createdNow,
          name: (() => { try { return String(readDoc(rec.pid).name || '').trim() || undefined; } catch { return undefined; } })(),
          bound: !!(bound && bound.ok), occupied: !!(bound && bound.occupied),
          bindError: bound && !bound.ok ? (bound.error || null) : null,
        };
      },
      async memoryGet(args) {
        return memoryRead(args && args.projectId, args && args.canvasId);
      },
      async memoryPut(args) {
        return memoryWrite(args && args.projectId, args && args.canvasId, args || {});
      },
      
    };

    const toolDisposers = [];
    // 工作区 watcher：5s 轮询 workspaceRegistry（老宿主无该服务 → list 不可得 → tick 直接跳过）。
    // 不把 workspaceRegistry 放进 export const inject：cordis 的 inject 语义是「服务不存在则插件挂起等待」，
    // 老宿主会让我们整个插件起不来——防御式 get + 轮询才是可降级的接法。
    ctx.effect(() => {
      const tick = () => {
        try {
          const reg = ctx.get && ctx.get('workspaceRegistry');
          const list = reg && typeof reg.list === 'function' ? reg.list() : null;
          wsWatchTick(list);
        } catch { /* registry 漂移/服务缺失 → 下轮再试 */ }
      };
      tick(); // 启动即扫一次（工作区项目立即可见，不等首个 5s）
      const timer = setInterval(tick, 5000);
      if (timer && typeof timer.unref === 'function') timer.unref(); // 不阻塞进程退出
      return () => clearInterval(timer);
    }, 'infinite-canvas: workspace watcher');
    try {
      if (ctx.tools && typeof ctx.tools.register === 'function') {
        /** 深度剥掉 undefined 值：DSH 对工具结果做"无损 JSON"校验（snapshotJsonValue），
         *  任意一层出现 undefined（NaN/Infinity 同理）都会让整个结果被判非法
         *  ——此前 canvas_node_status 在无产物节点上必炸（assetId: undefined）就是这条。 */
        const stripUndefined = (value) => {
          if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : stripUndefined(v)));
          if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) {
              if (v === undefined) continue;
              out[k] = stripUndefined(v);
            }
            return out;
          }
          return value;
        };
        const reg = (def) => {
          try {
            const inner = def.execute;
            // 会话绑定（0.20.x）：绑定会话的 agent 被**代码级锁死**在本集画布——
            //  ① projectId/canvasId 缺省 → 自动注入绑定值；
            //  ② 显式传其他项目/画布（含同项目其他画布与默认画布）→ 直接拒绝（locked），文案指引先解绑；
            //  ③ 未绑定会话不受任何限制（编码等普通任务零打扰）。
            // 只对 schema 声明了该参数的工具生效（additionalProperties:false 的工具不能多塞键）；
            // 嗅探失败（宿主不带会话身份）静默回退旧行为。
            const propDefs = (def.parameters && def.parameters.properties) || null;
            const allowProject = !!(propDefs && Object.prototype.hasOwnProperty.call(propDefs, 'projectId'));
            const allowCanvas = !!(propDefs && Object.prototype.hasOwnProperty.call(propDefs, 'canvasId'));
            def.execute = async (args, exec) => {
              let a = args;
              try {
                const sid = toolExecSessionId(exec);
                if (sid && (allowProject || allowCanvas)) {
                  const b = toolBindingForSession(sid);
                  if (b) {
                    a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
                    const wantPid = b.projectId == null ? null : String(b.projectId);
                    const wantCid = b.canvasId == null ? null : String(b.canvasId);
                    const deny = (what) => {
                      const label = bindingLabelOf(b);
                      return stripUndefined({
                        ok: false,
                        locked: true,
                        text: '本会话已绑定画布工作台「' + label + '」，代码级限制：' + what
                          + '。一个会话只允许操作自己绑定的那一张画布；如需操作其他画布/项目，请先在对话输入行的画布选择器里解绑。',
                      });
                    };
                    if (allowProject && a.projectId != null && String(a.projectId) !== wantPid) return deny('禁止跨项目操作');
                    if (allowCanvas && a.canvasId != null && String(a.canvasId) !== wantCid) return deny('禁止跨画布操作（含同项目其他画布与默认画布）');
                    if (allowProject && a.projectId == null && wantPid != null) a.projectId = b.projectId;
                    if (allowCanvas && a.canvasId == null && wantCid != null) a.canvasId = b.canvasId;
                  }
                }
              } catch { /* 默认解析失败 → 原参数路径 */ }
              return stripUndefined(await inner(a, exec));
            };
            toolDisposers.push(ctx.tools.register(def));
          } catch { /* 单个工具失败不阻塞其余 */ }
        };
        // 输出 schema：显式声明字段但不用 additionalProperties:false（工具返回值的校验不能比参数更严，
        // 否则多返回一个字段就会让整轮请求被 API 拒绝）
        const textOutput = {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' }, text: { type: 'string' },
              projectId: { type: 'string' }, nodeId: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' },
            },
            required: ['ok', 'text'],
          },
          render: (args, value) => [{ type: 'text', text: String(value.text || '') }],
        };
        reg({
          name: 'canvas_list_projects',
          description: '列出无限画布的项目、每个项目下的画布（多画布：默认画布 + 子画布）及其节点（节点 id/类型/名称/状态）。用户提到画布项目、想看有哪些项目/画布、或要指定某个项目/画布/节点时使用。子画布用 canvasId 标识（缺省 = 默认画布）。',
          parameters: { type: 'object', properties: { keyword: { type: 'string', description: '按项目名称过滤（可选）' } }, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { count: { type: 'integer' }, text: { type: 'string' } }, required: ['count', 'text'] },
            render: (args, value) => [{ type: 'text', text: String(value.text || '') }],
          },
          timeoutMs: 30000,
          async execute(args, exec) {
            const kw = String((args && args.keyword) || '').toLowerCase();
            // 绑定会话：只允许看到自己绑定的项目（读取也必须锁死，否则模型能"围观"全部画布）
            const sid = toolExecSessionId(exec);
            const bound = sid ? toolBindingForSession(sid) : null;
            let full = projectsList();
            if (full && typeof full.then === 'function') full = await full;
            let list = Array.isArray(full) ? full : [];
            if (bound) list = list.filter((p) => p.id === bound.projectId);
            list = list.filter((p) => !kw || String(p.name).toLowerCase().includes(kw));
            const lines = [];
            if (bound) lines.push('本会话已绑定画布工作台：只显示绑定项目「' + ((list[0] && list[0].name) || bound.projectId) + '」；其他项目已隐藏（要操作其他项目请先解绑）。');
            for (const p of list) {
              const canvases = Array.isArray(p.canvases) ? p.canvases : [];
              const defTxt = p.defaultCanvasDeleted
                ? '默认画布已删除'
                : '默认画布「' + (p.defaultCanvasName || '默认画布') + '」canvasId=null';
              lines.push('- 「' + p.name + '」 id=' + p.id + ' · ' + defTxt + ' · ' + canvases.length + ' 个子画布 · ' + p.nodes.length + ' 节点 · 更新于 ' + new Date(p.updatedAt).toLocaleString());
              for (const n of p.nodes) lines.push('    · [' + n.type + '] ' + (n.label || '(未命名)') + ' id=' + n.id + ' status=' + n.status + ' x=' + (Number(n.x) || 0) + ' y=' + (Number(n.y) || 0) + ' · ' + (Number(n.w) || 0) + '×' + (Number(n.h) || 0));
              for (const c of canvases) lines.push('    ▸ 画布「' + (c.name || c.id) + '」 canvasId=' + c.id + '（用 canvasId 参数指定；资产与设定集按项目共享）');
            }
            const text = lines.length ? ('共 ' + list.length + ' 个项目：\n' + lines.join('\n')) : '画布上还没有项目。可调用 canvas_create_project 创建。';
            return { count: list.length, text };
          },
        });
        reg({
          name: 'canvas_create_project',
          description: '在无限画布上创建一个新项目（可同时写好第一个剧本节点）。【硬约束】调用前必须先 canvas_list_projects 查重；同名项目会被自动复用并提示，绝不要为"重试"或为每个节点重复创建项目。剧本节点必须 idea（创作意图）+ output（剧本成稿）同属一个节点：创作意图填 scriptText，成稿填 scriptOutput，用 nodeName 命名。【注意】世界观/核心设定/风格基调等"创作意图类"内容一律写进设定集（canvas_update_bible），绝不要为它们单独建节点。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '项目名称' },
              scriptText: { type: 'string', description: '可选：创作意图/提示词（写入首个剧本节点的 idea）' },
              scriptOutput: { type: 'string', description: '可选：剧本完整成稿（写入同一节点的 output）' },
              nodeName: { type: 'string', description: '可选：首个剧本节点的名字（建议填写，如"第一节剧本"）' },
            },
            required: ['name'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args, exec) {
            // 绑定会话：禁止新建项目（跨项目动作；要新建先解绑）
            const sid = toolExecSessionId(exec);
            const bound = sid ? toolBindingForSession(sid) : null;
            if (bound) {
              return { ok: false, locked: true, text: '本会话已绑定画布工作台「' + (bound.canvasId ? bound.canvasId : '默认画布') + '」，代码级限制：禁止新建项目（一个会话只允许操作自己绑定的那一张画布）。要新建项目请先在对话输入行的画布选择器里解绑。' };
            }
            const r = canvasCreateProject(args);
            if (r.reused) {
              return { ok: true, projectId: r.projectId, name: r.name, text: '♻️ 项目「' + r.name + '」已存在（id=' + r.projectId + '），已复用，未重复创建。往其中加内容请用 canvas_write_node({ projectId: "' + r.projectId + '", ... })。' };
            }
            return { ok: true, projectId: r.projectId, name: r.name, nodeId: r.nodeId || undefined, text: '✅ 已创建项目「' + r.name + '」（id=' + r.projectId + '）。往同一个项目继续加内容请用 canvas_write_node({ projectId: "' + r.projectId + '" })，不要为节点新建项目。' };
          },
        });
        reg({
          name: 'canvas_write_node',
          description: '写入无限画布的项目内容。【硬约束】绝不要为了加节点而新建项目——一律指定已有 projectId。世界观/核心设定/风格基调等"创作意图类"内容写进设定集（canvas_update_bible），绝不要为它们建节点。剧本节点的 idea（创作意图）与 output（剧本成稿）必须在同一个节点里；分镜内容只能写进分镜表节点（storyboard）：text 为 {"shots":[…]} JSON 时写入镜头列表，普通文本则作为分镜的剧本来源——绝不要用剧本节点装分镜。复用规则：给 name 且能匹配已有节点名 → 更新该节点；给 name 但匹配不到 → **新建节点**（写新一集/新一节时就这样用）；不给 name → 只会复用"有意图没成稿"的剧本节点补全。已写成稿的节点默认拒绝覆盖，确认要覆盖请传 overwrite:true（否则报错而不是静默吃掉稿件）。target：idea=提示词（默认），output=成稿。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id（来自 canvas_list_projects 或 canvas_create_project）' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下子画布；缺省 = 项目默认画布。多画布项目必须显式指定目标画布）' },
              text: { type: 'string', description: '要写入的内容（按 target 与节点类型决定写哪里）' },
              kind: { type: 'string', enum: ['script', 'text'], description: '新节点类型：script=剧本（默认），text=纯文本' },
              target: { type: 'string', enum: ['idea', 'output'], description: '写哪一部分：idea=提示词/创作意图（默认），output=成稿' },
              nodeId: { type: 'string', description: '可选：指定要更新的节点（最精确的定位方式）' },
              name: { type: 'string', description: '可选：节点名字。匹配到同名节点就更新它；匹配不到会新建节点（写新章节用这个）' },
              idea: { type: 'string', description: '可选：同时设置该剧本节点的创作意图（与 text/target 配合，一次写全意图与成稿）' },
              overwrite: { type: 'boolean', description: '可选：目标节点已有成稿时是否允许覆盖（默认 false，会报错保护稿件）' },
            },
            required: ['projectId', 'text'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = canvasWriteNode(args);
            const what = String((args && args.text) || '').trim().slice(0, 24);
            return { ok: true, projectId: r.projectId, nodeId: r.nodeId, label: r.label || undefined, text: (r.updated ? '✅ 已更新节点' : '✅ 已写入节点') + '「' + (r.label || what) + '」（id=' + r.nodeId + '）。' };
          },
        });
        reg({
          name: 'canvas_run_node',
          description: '触发画布用其自身配置的模型/接口真实执行某个节点（剧本生成、分镜拆解、图片生成、视频生成等）。执行在画布侧异步进行，随后可用 canvas_node_status 读取状态与产物。用户说"生成剧本""开始生成""跑一下这个节点"时使用。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下的子画布；缺省 = 项目默认画布。来自 canvas_list_projects 的画布清单）' },
              nodeId: { type: 'string', description: '节点 id（来自 canvas_list_projects）' },
            },
            required: ['projectId', 'nodeId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasRunNode(args);
            if (r && r.ok === false) {
              const det = r.fails ? '\n· ' + r.fails.join('\n· ') : '';
              return { ok: false, gate: r.gate, projectId: r.projectId, nodeId: r.nodeId, missing: r.missing || undefined, fails: r.fails || undefined, warns: r.warns || undefined, fix: r.fix || undefined, text: '⛔ [' + r.gate + '] ' + (r.error || '流程闸门未通过') + det + (r.fix ? '\n出路：' + r.fix : '') };
            }
            return { ok: true, projectId: r.projectId, nodeId: r.nodeId, text: '🚀 已触发执行[' + r.type + ']「' + (r.label || r.nodeId) + '」。画布将在数秒内开始，可用 canvas_node_status 查询进度与结果。' };
          },
        });
        reg({
          name: 'canvas_node_status',
          description: '查询画布节点的运行状态与产物（状态、错误、剧本成稿内容、生成出的资产 id）。分镜表节点会返回 shots（镜头清单：标题/时长/画面/动作/角色/场景/道具——视频提示词的镜头序列必须来自它）与 warnings（一致性告警：未登记/描述为空的实体清单）——warnings 非空时必须逐条 canvas_update_bible 补全，绝不忽略。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下的子画布；缺省 = 项目默认画布）' },
              nodeId: { type: 'string', description: '节点 id' },
            },
            required: ['projectId', 'nodeId'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, assetId: { type: 'string' }, prompt: { type: 'string' }, ratio: { type: 'string' }, size: { type: 'string' }, duration: { type: 'number' }, resolution: { type: 'string' }, frameMode: { type: 'string' }, imageModel: { type: 'string' }, videoModel: { type: 'string' }, count: { type: 'number' }, targetDuration: { type: 'number', description: '分镜总时长硬约束（秒；缺省 = 自动档）' }, combatMode: { type: 'string', enum: ['auto', 'on', 'off'], description: '打斗判定：auto=按场检测 / on=强制打斗 / off=强制非打斗' }, cont: { type: 'boolean', description: '分镜衔接开关（默认 true）' }, genWarn: { type: 'string' }, chainFrom: { type: 'string' }, seam: { type: 'object', properties: { ok: { type: 'boolean' }, sim: { type: 'number' }, thr: { type: 'number' }, note: { type: 'string' } } }, tailPickAssetId: { type: 'string' }, historyAssetIds: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } }, shots: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, duration: { type: 'number' }, visual: { type: 'string' }, motion: { type: 'string' }, tail: { type: 'string' }, cam: { type: 'string' }, start: { type: 'string' }, seg: { type: 'string' }, characters: { type: 'array', items: { type: 'string' } }, scene: { type: 'string' }, props: { type: 'array', items: { type: 'string' } }, timeBeats: { type: 'array', items: { type: 'string' } }, camera: { type: 'string' }, vfx: { type: 'string' }, negative: { type: 'string' }, attack: { type: 'string' }, reaction: { type: 'string' }, impact: { type: 'string' }, initiative: { type: 'string' }, nextCombat: { type: 'string' } } } } }, required: ['ok', 'text'] },
            render: (args, value) => [{ type: 'text', text: String(value.text || '') }],
          },
          timeoutMs: 30000,
          async execute(args) {
            const s = await canvasNodeStatus(args);
            const lines = ['节点[' + s.type + ']「' + (s.label || s.nodeId) + '」', '状态: ' + s.status + (s.aiStatus && s.aiStatus !== 'idle' ? ' / ' + s.aiStatus : '')];
            // 画布坐标与外框尺寸：对话侧回答"节点在哪/是否重叠"的最小布局事实（只读；改坐标仍走 canvas_relayout）
            lines.push('位置: x=' + Number(s.x) + ' y=' + Number(s.y) + ' · 尺寸 ' + Number(s.w) + '×' + Number(s.h));
            if (s.error) lines.push('错误: ' + s.error);
            if (s.assetId) lines.push('产物资产: ' + s.assetId);
            if (s.taskId) lines.push('任务凭据: ' + s.taskId + (s.taskQueryUrl ? '（查询: ' + s.taskQueryUrl + '）' : ''));
            if (s.idea) lines.push('提示词: ' + s.idea.slice(0, 400));
            if (s.output) lines.push('成稿:\n' + s.output);
            // 镜头清单：结构化返回 + 渲染进文本——对话侧据此组织多镜头视频提示词（绝不自行编造镜头表）
            const shots = Array.isArray(s.shots) ? s.shots : [];
            if (shots.length) {
              lines.push('镜头清单（' + shots.length + ' 镜，总时长 ' + shots.reduce((a, x) => a + (Number(x.duration) || 0), 0) + 's）——视频提示词的镜头序列以此为准:');
              shots.forEach((sh) => {
                const dl = (sh.dialogue || []).map((d) => d.role + '：' + d.line).join('；');
                lines.push(sh.index + '. ' + sh.title + '（' + sh.duration + 's）' + (sh.seg ? '[' + sh.seg + '] ' : '') + '角色:' + (sh.characters.join('/') || '-') + '｜场景:' + (sh.scene || '-') + '｜道具:' + (sh.props.join('/') || '-')
                  + '\n   画面: ' + sh.visual + '\n   动作: ' + sh.motion
                  + (sh.tail ? '\n   接点尾态(应写进下一镜起始态): ' + sh.tail : '')
                  + (sh.cam ? '\n   运镜延续: ' + sh.cam : '')
                  + (sh.start ? '\n   起始态: ' + sh.start : '')
                  + (dl ? '\n   台词: ' + dl : '')
                  + (sh.sfx ? '\n   音效: ' + sh.sfx : ''));
              });
            }
            // 一致性告警：结构化返回 + 渲染进文本——对话侧据此逐条补全设定集，绝不忽略
            const warnings = Array.isArray(s.warnings) ? s.warnings : [];
            if (warnings.length) {
              lines.push('一致性告警（' + warnings.length + ' 条，须逐条 canvas_update_bible 补全，名称逐字一致）:');
              warnings.forEach((w) => lines.push(' · ' + w));
            }
            // 生成节点的对话框提示词与参数：对话侧据此精准改写（canvas_update_node），不必删节点重建
            if (s.prompt) lines.push('对话框提示词:\n' + s.prompt);
            const params = [];
            if (s.ratio) params.push('比例 ' + s.ratio);
            if (s.size) params.push('清晰度 ' + s.size);
            if (s.duration != null) params.push('时长 ' + s.duration + 's');
            if (s.resolution) params.push('分辨率 ' + s.resolution);
            if (s.frameMode) params.push('衔接 ' + s.frameMode);
            if (s.count != null && s.count > 0) params.push('镜头数 ' + s.count);
            // 分镜节点参数（对话侧读面）：总时长硬约束 / 打斗判定 / 衔接开关
            if (s.targetDuration != null && s.targetDuration > 0) params.push('总时长硬约束 ' + s.targetDuration + 's');
            if (s.targetDuration == null) params.push('总时长自动');
            if (s.combatMode) params.push('打斗判定 ' + s.combatMode);
            if (s.imageModel) params.push('图片模型 ' + s.imageModel);
            if (s.videoModel) params.push('视频模型 ' + s.videoModel);
            if (params.length) lines.push('生成参数: ' + params.join(' · '));
            if (s.historyAssetIds.length) lines.push('历史产物（' + s.historyAssetIds.length + ' 条，最新在最后）: ' + s.historyAssetIds.join(', '));
            if (s.genWarn) lines.push('生成告警: ' + s.genWarn);
            // 分镜衔接状态：续帧来源 + 接缝校验 + 最佳选帧（对话侧汇报成片质量时要一并说明）
            if (s.chainFrom) lines.push('续帧: ' + (s.chainFrom === 'wired' ? '首帧来自 frame 连线（上一段尾帧）' : '自动取上一段视频的尾帧作首帧'));
            if (s.seam) lines.push('接缝校验: ' + (s.seam.ok ? '通过' : '偏跳') + (s.seam.sim != null ? '（相似度 ' + s.seam.sim + '，阈值 ' + s.seam.thr + '）' : '') + (s.seam.note ? ' — ' + s.seam.note : ''));
            if (s.tailPick && s.tailPickAssetId) lines.push('尾帧最佳选帧: ' + Number(s.tailPick.t || 0).toFixed(2) + 's 处（得分 ' + s.tailPick.score + '）资产 ' + s.tailPickAssetId);
            return {
              ok: true, type: s.type, status: s.status, assetId: s.assetId || undefined,
              x: Number(s.x) || 0, y: Number(s.y) || 0, w: Number(s.w) || 0, h: Number(s.h) || 0,
              prompt: s.prompt || undefined, ratio: s.ratio || undefined, size: s.size || undefined,
              duration: s.duration == null ? undefined : s.duration, resolution: s.resolution || undefined,
              frameMode: s.frameMode || undefined, imageModel: s.imageModel || undefined, videoModel: s.videoModel || undefined,
              count: s.count == null ? undefined : s.count,
              targetDuration: s.targetDuration == null ? undefined : s.targetDuration,
              combatMode: s.combatMode || undefined,
              cont: s.cont,
              genWarn: s.genWarn || undefined,
              chainFrom: s.chainFrom || undefined, seam: s.seam || undefined,
              tailPickAssetId: s.tailPickAssetId || undefined,
              historyAssetIds: s.historyAssetIds.length ? s.historyAssetIds : undefined,
              warnings: warnings.length ? warnings : undefined, shots: shots.length ? shots : undefined,
              text: lines.join('\n'),
            };
          },
        });
        reg({
          name: 'canvas_update_node',
          description: '修改无限画布上**已有节点**的字段（改提示词、改比例/清晰度/时长/分辨率等参数）——"改节点"的唯一入口，改完不必删节点重建。可改字段：prompt（图片/视频节点的对话框提示词）、assetId（挂载已有资产 id，图片/视频节点直接呈现该素材；来自 canvas_import_asset / canvas_list_assets）、idea/output（剧本节点）、text（文本节点的正文）、script/requirement（分镜表的剧本来源与额外要求）、shots（分镜镜头清单，JSON 数组）、label（节点名）、ratio、size、duration、resolution、frameMode、count、imageModel、videoModel、model、cont（分镜表「分镜衔接」开关，默认 true；关掉后拆镜不写衔接字段、视频不自动续帧）、targetDuration（分镜**总时长硬约束**秒数，0/不传 = 自动档按镜头节奏；设置后所有镜头 duration 之和严格等于该值）、combatMode（打斗判定三态：auto=按本场剧本自动检测（缺省）/ on=本场强制按打斗注入战斗契约 / off=强制不注入——只影响分镜生成的注入口径）。结构字段（id/type/坐标/宽高）不可改。改完用 canvas_generate_node 触发生成。**这是迭代生成的主路径**：用户对某张图/某段视频不满意（"重来/换一版/不像"）时，改 prompt 后重生成即可，**绝不删掉节点再新建一个**——同一角色/场景/镜的节点永远只有一个，删了重建会丢连线、位置与历史。**前提**：先用 canvas_node_status 读到当前内容，再只传要改的字段。**注意 shots 是整表替换**：只改一镜也要先把 canvas_node_status 返回的全部 shots 取回、改完再整体传回（含每镜的 tail/cam/start/seg/timeBeats/camera/vfx/negative 与打斗字段 attack/reaction/impact/initiative/nextCombat）；否则其它镜的衔接与战斗字段会被冲掉（服务端会按镜序兜底保留，但不要依赖它）。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下的子画布；缺省 = 项目默认画布）' },
              nodeId: { type: 'string', description: '节点 id（来自 canvas_list_projects）' },
              patch: {
                type: 'object',
                description: '要修改的字段（只传需要改的，其余保持不动）',
                properties: {
                  prompt: { type: 'string', description: '图片/视频节点的提示词（对话框内容）' },
                  idea: { type: 'string', description: '剧本节点的创作意图' },
                  output: { type: 'string', description: '剧本节点的成稿' },
                  text: { type: 'string', description: '文本节点的正文' },
                  script: { type: 'string', description: '分镜表的剧本来源' },
                  requirement: { type: 'string', description: '分镜表的额外要求' },
                  label: { type: 'string', description: '节点名（≤40 字）' },
                  ratio: { type: 'string', description: '比例，如 16:9 / 9:16 / 1:1' },
                  size: { type: 'string', description: '图片清晰度：1K / 2K / 4K' },
                  duration: { type: 'number', description: '视频时长（秒，正数）' },
                  resolution: { type: 'string', description: '视频分辨率，如 720P / 1080P / 2K' },
                  frameMode: { type: 'string', description: '衔接模式：auto / hard / off' },
                  count: { type: 'number', description: '分镜表镜头数（0=自动）' },
                  imageModel: { type: 'string', description: '图片模型（供应商|模型引用）' },
                  videoModel: { type: 'string', description: '视频模型（供应商|模型引用）' },
                  model: { type: 'string', description: '文本模型（剧本/分镜节点）' },
                  shots: { type: 'array', items: { type: 'object' }, description: '分镜镜头清单（整表替换）' },
                },
                additionalProperties: false,
              },
            },
            required: ['projectId', 'nodeId', 'patch'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = canvasUpdateNode(args);
            const skipped = Array.isArray(r.skipped) && r.skipped.length ? '（已忽略不可改字段：' + r.skipped.join('、') + '）' : '';
            return { ok: true, projectId: r.projectId, nodeId: r.nodeId, label: r.label || undefined, text: '✅ 已更新节点[' + r.type + ']「' + (r.label || r.nodeId) + '」字段：' + r.applied.join('、') + skipped + '。需要重新生成请调用 canvas_generate_node。' };
          },
        });
        reg({
          name: 'canvas_generate_node',
          description: '触发节点执行并（可选）等到结束——"改完提示词 → 点生成 → 拿结果"的一站式入口（等价于点画布上的生成按钮）。执行由画布侧用节点上配置的模型真实运行，**画布页面必须处于打开状态**；等待超时不代表失败（任务仍在继续，可用 canvas_node_status 继续查）。waitSeconds=0 表示只触发不等待；图片通常 30–120s，视频数分钟。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下的子画布；缺省 = 项目默认画布）' },
              nodeId: { type: 'string', description: '节点 id' },
              waitSeconds: { type: 'number', description: '可选：等待秒数（0=只触发；上限 600）' },
            },
            required: ['projectId', 'nodeId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 660000,
          async execute(args) {
            const r = await canvasGenerateNode(args);
            if (r && r.ok === false && r.gate) {
              const det = r.fails ? '\n· ' + r.fails.join('\n· ') : '';
              return { ok: false, gate: r.gate, projectId: r.projectId, nodeId: r.nodeId, text: '⛔ [' + r.gate + '] ' + (r.error || '流程闸门未通过') + det + (r.fix ? '\n出路：' + r.fix : '') };
            }
            const head = '🚀 已触发[' + r.type + ']「' + (r.label || r.nodeId) + '」';
            const tail = r.finished
              ? (r.ok ? '✅ 已完成（状态 ' + r.status + (r.assetId ? '，产物资产 ' + r.assetId : '') + '）' : '❌ 失败：' + (r.error || r.status))
              : '⏳ ' + (r.note || '仍在进行');
            return { ok: r.ok !== false, projectId: r.projectId, nodeId: r.nodeId, status: r.status || undefined, assetId: r.assetId || undefined, text: head + '。' + tail };
          },
        });
        reg({
          name: 'canvas_delete_node',
          description: '删除无限画布项目中的一个节点（连同它的连线）。用于清理误创建的节点。',
          parameters: {
            type: 'object',
            properties: { projectId: { type: 'string', description: '项目 id' }, canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' }, nodeId: { type: 'string', description: '节点 id' } },
            required: ['projectId', 'nodeId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasDeleteNode(args);
            if (r && r.ok === false) return { ok: false, gate: r.gate, projectId: r.projectId, nodeId: r.nodeId, text: '⛔ [' + r.gate + '] ' + (r.error || '') + (r.fix ? '\n出路：' + r.fix : '') };
            return { ok: true, projectId: r.projectId, nodeId: r.nodeId, text: '🗑 已删除节点 ' + r.nodeId + '。' };
          },
        });
        reg({
          name: 'canvas_relayout',
          description: '一键粗排画布节点（兜底用，不是精确摆放）：按「行」排列——横向数据流决定列，竖向关系（prev/frame）不参与分列；每行 = 一个横向连通组，行间保留间距，多行按带宽分带左右铺开。**pinned（被 canvas_layout_node 钉住的节点）不会被移动**。需要精确到像素的摆放请用 canvas_layout_get + canvas_layout_node，不要用本工具。',
          parameters: {
            type: 'object',
            properties: { projectId: { type: 'string', description: '项目 id' }, canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' } },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = canvasRelayout(args);
            return { ok: true, projectId: r.projectId, text: '✅ 已重排 ' + r.moved + ' 个节点（' + r.rows + ' 行，无重叠）。' + (r.skippedPinned ? '钉住的 ' + r.skippedPinned + ' 个节点保持原位。' : '') };
          },
        });
        reg({
          name: 'canvas_layout_get',
          description: '读取整画布几何视图：返回每个节点的 nodeId/名字/类型/x/y/w/h/pinned 与画布包围盒。精确摆放前先调它拿全图坐标（不要靠猜）。',
          parameters: {
            type: 'object',
            properties: { projectId: { type: 'string', description: '项目 id' }, canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' } },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const r = canvasLayoutGet(args);
            const lines = r.nodes.map((n) => n.nodeId + ' [' + n.type + '] ' + n.name + '  x=' + n.x + ' y=' + n.y + ' w=' + n.w + ' h=' + n.h + (n.pinned ? ' 📌' : ''));
            return { ok: true, projectId: r.projectId, count: r.count, bounds: r.bounds || undefined, nodes: r.nodes, text: '几何视图（' + r.count + ' 个节点' + (r.bounds ? '，范围 x ' + r.bounds.minX + '..' + r.bounds.maxX + ' / y ' + r.bounds.minY + '..' + r.bounds.maxY : '') + '）：\n' + lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_layout_node',
          description: '精准摆放节点（0.20.0）：批量设置坐标，媒体节点可同时改尺寸；pinned=true 钉住后 canvas_relayout 不会再动它。允许重叠（这是精确摆放，不是自动整理）。先 canvas_layout_get 读全图，再算好坐标一次传入。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
              nodes: {
                type: 'array',
                description: '要摆放的节点数组（一次可传多个）',
                items: {
                  type: 'object',
                  properties: {
                    nodeId: { type: 'string' },
                    x: { type: 'number', description: '目标 x（可为负）' },
                    y: { type: 'number', description: '目标 y（可为负）' },
                    w: { type: 'number', description: '可选：宽度（仅 image/video，≥160）' },
                    h: { type: 'number', description: '可选：高度（仅 image/video，≥120）' },
                    pinned: { type: 'boolean', description: '可选：钉住，canvas_relayout 不再移动它' },
                  },
                  required: ['nodeId', 'x', 'y'],
                  additionalProperties: false,
                },
              },
            },
            required: ['projectId', 'nodes'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = canvasLayoutNode(args);
            const lines = r.applied.map((a) => a.nodeId + ' → x=' + a.x + ' y=' + a.y + (a.w !== undefined ? ' w=' + a.w + ' h=' + a.h : '') + (a.pinned !== undefined ? (a.pinned ? ' 📌钉住' : ' 取消钉住') : ''));
            return { ok: true, projectId: r.projectId, moved: r.moved, applied: r.applied, text: '✅ 已精准摆放 ' + r.moved + ' 个节点：\n' + lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_director_stage',
          description: '3D-BOX / 3D 导演台（预演场景）的总控工具：用一段 JSON 规格或一句话直接生成/更新整场预演，无需手动搭场景。\n' +
            'action=apply：把 spec 写入项目并落盘（客户端打开 3D-BOX 时自动套用；再点「导出视频」即得白模预演片）。\n' +
            'action=brief：一句话搭景。可选 scene（场景预设，见 action=presets）、style（导演风格）、cameraMove（运镜预设）；不传则按关键词自动选。\n' +
            'action=camera：给当前已保存的规格施加一个运镜预设（生成可编辑的机位关键帧）。\n' +
            'action=presets：返回场景预设 / 导演风格 / 运镜清单（Agent 先查再选，避免编造 id）。\n' +
            'action=get：读回当前项目的规格。\n' +
            'action=help：返回规格 schema 与可用姿态/预设清单。\n' +
            'spec 结构：{ title, duration, env{preset,bg,ground,grid,exposure,tonemap}, style, ' +
            'characters[{name,pos:[x,y,z],rotY,h,pose,color,material{roughness,metallic,specular},path:[[x,z]...],pathFace,poseAnim[{t,pose}],loop,loopPeriod,keys[{t,pos,rotY}]}], ' +
            'props[{preset,pos,scale,color}], cameras[{name,pos,target,fov,keys[{t,pos,target,fov}]}], shots[{camera,start,end}], shot{cameraMove,shotSize,note} }。\n' +
            'pose 取值见 action=help 的 poses；道具 preset 见 presets。坐标两维数组 [x,z] 自动补 y=0。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['apply', 'get', 'help', 'brief', 'presets', 'camera', 'edit'], description: '操作类型' },
              brief: { type: 'string', description: '一句话描述（action=brief 时用，如「两人在巷子里打斗，8秒」）；会套用场景/风格/运镜预设生成规格并落盘' },
              template: { type: 'string', enum: ['fight', 'chase', 'dialogue'], description: '旧版模板（保留兼容；新代码用 scene）' },
              scene: { type: 'string', description: '场景预设 id（action=brief 时用；见 action=presets 的 scenePresets，如 dialogue3 / interview / meeting / chase）' },
              style: { type: 'string', description: '导演风格 id（action=brief 时用；见 action=presets 的 directorStyles，如 animation / tvc / mv / documentary / commerce / suspense）' },
              cameraMove: { type: 'string', description: '运镜预设 id（action=brief 或 action=camera 时用；见 action=presets 的 cameraMoves，如 push_in / arc_left / crane_up / dolly_zoom）' },
              prompt: { type: 'string', description: '自然语言运镜（action=camera 时用）：如「环绕香水瓶，低机位，最后推近 logo」；由用户已配置模型生成可编辑机位关键帧' },
              instruction: { type: 'string', description: '自然语言改景指令（action=edit 时用）：如「机位再低一点」「让角色 A 从左入画」「加一张桌子」；由用户已配置的模型改当前 spec，失败自动重试一次' },
              duration: { type: 'number', description: '时长秒数（不传则从 brief 里抓「N秒」，否则用模板默认值）' },
              projectId: { type: 'string', description: '项目 id' },
              spec: { type: 'object', description: '场景规格（action=apply 时必填）' },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const action = String((args && args.action) || 'get');
            if (action === 'presets') {
              const eng = await loadDirectorEngine();
              return {
                ok: true,
                scenePresets: (eng && eng.SCENE_PRESETS) || [],
                directorStyles: (eng && eng.DIRECTOR_STYLES) || [],
                cameraMoves: (eng && eng.CAMERA_MOVES) || [],
                text: '✅ 3D-BOX 预设清单\n' +
                  '· 场景：' + (((eng && eng.SCENE_PRESETS) || []).map((x) => x.id + '=' + x.zh).join(' / ') || '(引擎未就绪)') + '\n' +
                  '· 风格：' + (((eng && eng.DIRECTOR_STYLES) || []).map((x) => x.id + '=' + x.zh).join(' / ') || '(引擎未就绪)') + '\n' +
                  '· 运镜：' + (((eng && eng.CAMERA_MOVES) || []).map((x) => x.id + '=' + x.zh).join(' / ') || '(引擎未就绪)'),
              };
            }
            if (action === 'help') {
              const eng = await loadDirectorEngine();
              return {
                ok: true,
                text: '✅ 导演台规格说明\n' +
                  '· 姿态 id：none, arms_up, punch, kick, flip, fly(轻功), crouch(下蹲), fight, walk, run, jump, hit, fall, walk_a, walk_b, run_a, run_b\n' +
                  '· 道具 preset：box, sphere, cylinder, cone, plane, capsule, torus, pyramid, disc, arc\n' +
                  '· 循环动作：poseAnim 首尾 pose 相同即可循环（如 walk_a→walk_b→walk_a）\n' +
                  '· 路径：path 为二维地面点数组，物体沿路径运动并按切线自动转向（pathFace:false 关闭）\n' +
                  '· 角色一律使用资产库的真实关节人偶（assetId=xbot）：characters[].preset 可填 actors 列表里的体型，未填默认 m_standard\n' +
                  '· 3D-BOX 场景预设：' + (((eng && eng.SCENE_PRESETS) || []).map((x) => x.id).join(', ') || '(引擎未就绪)') + '\n' +
                  '· 导演风格：' + (((eng && eng.DIRECTOR_STYLES) || []).map((x) => x.id).join(', ') || '(引擎未就绪)') + '\n' +
                  '· 运镜：' + (((eng && eng.CAMERA_MOVES) || []).map((x) => x.id).join(', ') || '(引擎未就绪)'),
                poses: (eng && eng.BONE_POSES ? eng.BONE_POSES.map((p) => ({ id: p.id, zh: p.zh, en: p.en })) : []),
                presets: ['box', 'sphere', 'cylinder', 'cone', 'plane', 'capsule', 'torus', 'pyramid', 'disc', 'arc'],
                actors: (eng && eng.ACTOR_PRESETS ? eng.ACTOR_PRESETS.map((p) => ({ preset: p.id, zh: p.zh, en: p.en, h: p.h })) : []),
                sequences: (eng && eng.ACTION_SEQUENCES ? eng.ACTION_SEQUENCES.map((s2) => ({ id: s2.id, zh: s2.zh, loop: !!s2.loop })) : []),
              };
            }
            if (action === 'brief') {
              const brief = String((args && args.brief) || '').trim();
              if (!brief) throw new Error('action=brief 需要 brief 一句话描述');
              const eng2 = await loadDirectorEngine();
              if (!eng2 || typeof eng2.specFromBrief !== 'function') throw new Error('引擎未就绪');
              const spec2 = eng2.specFromBrief(brief, {
                template: args.template,
                scene: args.scene,
                style: args.style,
                cameraMove: args.cameraMove,
                duration: args.duration,
              });
              const r4 = await methods.directorStageSave({ projectId: args.projectId, spec: spec2 });
              if (!r4.ok) throw new Error(r4.error || '保存失败');
              return {
                ok: true, projectId: String(args.projectId || ''), spec: spec2,
                text: '✅ 已按「' + (spec2.title || brief) + '」生成 3D-BOX 预演并写入项目（' + (spec2.characters || []).length + ' 角色 / ' + (spec2.cameras || []).length + ' 机位 / ' + (spec2.shots || []).length + ' 分镜 / ' + spec2.duration + 's' + (spec2.style ? ' / 风格 ' + spec2.style : '') + (spec2.cameraMove ? ' / 运镜 ' + spec2.cameraMove : '') + '）。打开或刷新 3D-BOX 即可看到；点「导出视频」出片。',
              };
            }
            if (action === 'camera') {
              const moveId = String((args && args.cameraMove) || '').trim();
              const prompt = String((args && args.prompt) || '').trim();
              if (!moveId && !prompt) throw new Error('action=camera 需要 cameraMove 或 prompt');
              const r5 = await methods.directorStageCamera({ projectId: args.projectId, cameraMove: moveId || undefined, prompt: prompt || undefined, duration: args.duration });
              if (!r5 || !r5.ok) throw new Error((r5 && r5.error) || '运镜失败');
              return {
                ok: true, projectId: String(args.projectId || ''), spec: r5.spec,
                text: '✅ 已施加' + (prompt ? ' AI 运镜「' + prompt.slice(0, 60) + '」' : '运镜「' + moveId + '」') + '并写入项目（' + (r5.keys || 0) + ' 个机位关键帧）。刷新 3D-BOX 即可预览。',
              };
            }
            if (action === 'edit') {
              const instruction = String((args && args.instruction) || '').trim();
              if (!instruction) throw new Error('action=edit 需要 instruction');
              const r6 = await methods.directorStageEdit({ projectId: args.projectId, instruction });
              if (!r6 || !r6.ok) throw new Error((r6 && r6.error) || '改景失败');
              return {
                ok: true, projectId: String(args.projectId || ''), spec: r6.spec,
                text: '✅ 已按「' + instruction.slice(0, 60) + '」改景并写入项目（' + ((r6.spec && r6.spec.cameras) || []).length + ' 机位 / ' + ((r6.spec && r6.spec.shots) || []).length + ' 分镜）。刷新 3D-BOX 即可预览。',
              };
            }
            if (action === 'get') {
              const r2 = await methods.directorStageLoad({ projectId: args.projectId });
              return { ok: !!r2.ok, projectId: String(args.projectId || ''), spec: r2.spec || undefined, text: r2.found ? '✅ 已读取导演台规格（savedAt=' + new Date(r2.savedAt || Date.now()).toISOString() + '）' : '（该项目还没有导演台规格）' };
            }
            if (!args || !args.spec || typeof args.spec !== 'object') throw new Error('action=apply 需要 spec 对象');
            const r3 = await methods.directorStageSave({ projectId: args.projectId, spec: args.spec });
            if (!r3.ok) throw new Error(r3.error || '保存失败');
            return {
              ok: true, projectId: String(args.projectId || ''), file: r3.file,
              text: '✅ 导演台规格已写入（' + r3.bytes + ' 字节）。打开/刷新画布的 3D 导演台会自动套用该场景；点「导出视频」即可产出白模预演片。',
            };
          },
        });

        reg({
          name: 'canvas_list_presets',
          description: '列出运镜/转场预设（视频节点“尝试”区、3D-BOX 预设页、Agent 共用一份）。kind=all/camera/transition/template；先查清单再选 id，避免编造。',
          parameters: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['all', 'camera', 'transition', 'template'], description: '可选：按类型过滤（缺省 all）' },
            },
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const eng = await loadDirectorEngine();
            const all = (eng && eng.MOTION_PRESETS) || [];
            const kind = String((args && args.kind) || 'all');
            const list = kind === 'all' ? all : all.filter((x) => x.kind === kind);
            const lines = list.map((x) => '- ' + x.id + ' [' + x.kind + '] ' + x.zh + '：' + x.promptZh);
            return {
              ok: true,
              presets: list.map((x) => {
                const o = { id: x.id, zh: x.zh, en: x.en, kind: x.kind, category: x.category, promptZh: x.promptZh, promptEn: x.promptEn };
                if (x.cameraMove) o.cameraMove = x.cameraMove;
                return o;
              }),
              text: '✅ 运镜/转场预设（' + list.length + '）：\n' + lines.join('\n'),
            };
          },
        });
        reg({
          name: 'canvas_apply_preset',
          description: '给当前项目的 3D-BOX 规格施加一个运镜/转场预设（转场会映射到基础机位运动；模板只写备注）。先用 canvas_list_presets 查 presetId。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              presetId: { type: 'string', description: '运镜/转场预设 id（见 canvas_list_presets）' },
              duration: { type: 'number', description: '可选：时长秒数（缺省用规格时长）' },
            },
            required: ['projectId', 'presetId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const pid = String((args && args.projectId) || '');
            const presetId = String((args && args.presetId) || '').trim();
            if (!presetId) throw new Error('需要 presetId');
            const eng = await loadDirectorEngine();
            if (!eng || typeof eng.applyMotionPreset !== 'function') throw new Error('引擎未就绪');
            const cur = await methods.directorStageLoad({ projectId: pid });
            if (!cur || !cur.found || !cur.spec) throw new Error('当前项目还没有 3D-BOX 规格：先用 canvas_director_stage action=brief/apply');
            const next = eng.applyMotionPreset(cur.spec, presetId, { duration: args.duration });
            const saved = await methods.directorStageSave({ projectId: pid, spec: next });
            if (!saved.ok) throw new Error(saved.error || '保存失败');
            return {
              ok: true, projectId: pid, spec: next,
              text: '✅ 已应用预设「' + presetId + '」并写入项目（' + ((next.cameras && next.cameras[0] && next.cameras[0].keys) || []).length + ' 个机位关键帧）。刷新 3D-BOX 即可预览。',
            };
          },
        });

        reg({
          name: 'canvas_delete_project',
          description: '删除无限画布上的一个项目（含其全部节点）。用户明确要求删除项目、或清理误创建的空项目时使用；删除前请先用 canvas_list_projects 确认 id。',
          parameters: { type: 'object', properties: { projectId: { type: 'string', description: '项目 id' } }, required: ['projectId'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasDeleteProject(args);
            if (r && r.ok === false && r.gate) return { ok: false, gate: r.gate, projectId: r.projectId, text: '⛔ [' + r.gate + '] ' + (r.error || '') + (r.fix ? '\n出路：' + r.fix : '') };
            // 磁盘清理失败必须可见：rmrf 部分失败（文件锁）时目录残留，同名重建会继承旧文件
            const diskErrs = r.disk && Array.isArray(r.disk.errors) ? r.disk.errors : [];
            const warn = diskErrs.length ? '⚠ 磁盘清理有 ' + diskErrs.length + ' 项失败：' + diskErrs.join('；') : '';
            return { ok: diskErrs.length === 0, warning: diskErrs.length ? diskErrs : undefined, projectId: r.projectId, text: '🗑 已删除项目「' + r.name + '」（id=' + r.projectId + '）。' + (warn ? '\n' + warn : '') };
          },
        });
        reg({
          name: 'canvas_get_bible',
          description: '读取项目的设定集（世界观/核心设定、风格基调、角色/场景/道具及描述）。【设定集先行】在写剧本或生成角色/场景/道具参考图之前，先读它；若为空，先与用户确认或按用户已给的创意补全设定集，再开始生成剧本。',
          parameters: {
            type: 'object',
            properties: { projectId: { type: 'string', description: '项目 id' } },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasGetBible(args);
            const b = r.bible;
            const lines = ['项目「' + r.name + '」设定集：'];
            lines.push('世界观/核心设定：' + (b.worldview || '（空）'));
            lines.push('风格基调：' + (b.style || '（空）'));
            for (const [label, list] of [['角色', b.characters], ['场景', b.scenes], ['道具', b.props]]) {
              lines.push(label + '（' + list.length + '）：' + (list.length ? list.map((x) => x.name + '＝' + (x.desc || '')).join('；') : '（空）'));
            }
            return { ok: true, projectId: r.projectId, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_update_bible',
          description: '写入项目设定集（世界观/核心设定、风格基调、角色/场景/道具）。默认按名称合并：同名更新、不存在则追加；mode="replace" 时条目整体替换。【设定集先行】先把世界观/风格/角色/场景/道具写进设定集，再生成剧本与参考图，保证跨镜跨集一致。写/改 style 时必须同时产出 styleAnchor（一句话 ≤40 字的全片视觉总锚；细节在 style，锚进生成请求总控）。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              mode: { type: 'string', enum: ['merge', 'replace'], description: '条目合并方式，默认 merge' },
              bible: {
                type: 'object',
                description: '设定集内容（只传要改的字段）',
                properties: {
                  worldview: { type: 'string', description: '世界观/核心设定（题材、年代、核心规则、主线暗线）' },
                  style: { type: 'string', description: '风格基调（画风、年代、色调、质感，可多句细节）' },
                  styleAnchor: { type: 'string', description: '风格锚：一句话（≤40 字）全片视觉总锚，与 style 同时产出——style 写细节，锚进图片/视频生成请求的总控' },
                  characters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' } }, required: ['name'] }, description: '角色设定（名称 + 外观/性格描述）' },
                  scenes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' } }, required: ['name'] }, description: '场景设定' },
                  props: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' } }, required: ['name'] }, description: '道具设定' },
                },
              },
            },
            required: ['projectId', 'bible'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasUpdateBible(args);
            const b = r.bible;
            const text = '✅ 设定集已更新（世界观 ' + (b.worldview ? '有' : '空') + '、风格 ' + (b.style ? '有' : '空')
              + '、角色 ' + b.characters.length + '、场景 ' + b.scenes.length + '、道具 ' + b.props.length + '）。画布会在数秒内同步显示。';
            return { ok: true, projectId: r.projectId, text };
          },
        });
        reg({
          name: 'canvas_read_memory',
          description: '读取项目记忆：不带 canvasId 返回**调度索引**（每集画布的标题/摘要/关键词/状态，一眼看到全项目各集记忆脉络）；带 canvasId 额外返回该集**完整记忆正文**（剧情决策/人物状态变化/伏笔账本）。【记忆先行】写第 N 集剧本或分镜之前必须先读本集记忆（canvasId 从画布清单或索引对上号）；跨集要伏笔/人物状态连续性时先读索引再读相关集正文。世界观/风格/角色场景设定不在记忆里——那些用 canvas_get_bible。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '画布 id（集）；缺省只回索引' },
            },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await memoryRead(args && args.projectId, args && args.canvasId);
            const idx = r.index || { episodes: [] };
            const lines = [];
            if (!idx.episodes.length) lines.push('（项目记忆为空：本集是第一集或尚未回写过记忆。写完记得 canvas_write_memory。）');
            else {
              lines.push('记忆索引（' + idx.episodes.length + ' 集）——跨集连续性的总账：');
              for (const e of idx.episodes) {
                lines.push(' · [' + (e.canvasId || '-') + '] ' + (e.title || '未命名') + '（' + (e.status === 'done' ? '已完结' : ' drafting/进行中') + '）' + (e.summary ? '：' + e.summary : '') + (Array.isArray(e.keywords) && e.keywords.length ? '　关键词:' + e.keywords.join('/') : ''));
              }
            }
            if (r.episode) {
              lines.push('—— [' + r.episode.canvasId + '] ' + (r.episode.title || '未命名') + ' 的完整记忆 ——');
              lines.push(r.episode.body || '（该集还没有记忆正文）');
            }
            return { ok: true, projectId: r.projectId, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_write_memory',
          description: '写入某集（画布）的项目记忆并自动更新调度索引：title 集标题、summary 一句话摘要（≤120 字，进索引供其他集快速检索）、keywords 关键词、body 完整记忆正文（剧情决策/人物状态变化/伏笔账本/未回收的钩子）、status 进度。【会话收尾铁律】一集创作告一段落（每场定稿/全集完成）必须回写本集记忆——记忆是跨集连续性的唯一载体，不回写 = 下一集会重复创作、重复设定、丢伏笔。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '画布 id（集）——记忆按画布隔离' },
              title: { type: 'string', description: '集标题（如「第3集 雨夜追踪」）' },
              summary: { type: 'string', description: '一句话摘要（≤120 字，写入索引供跨集检索）' },
              keywords: { type: 'array', items: { type: 'string' }, description: '关键词（人物/地点/伏笔标记，≤10 个）' },
              body: { type: 'string', description: '完整记忆正文（markdown）：剧情决策、人物状态变化、伏笔登记与回收、生成要点' },
              status: { type: 'string', enum: ['drafting', 'done'], description: '进度：进行中/已完结' },
            },
            required: ['projectId', 'canvasId', 'title', 'summary', 'body'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            if (!args || !String(args.canvasId || '').trim()) return { ok: false, text: '缺少 canvasId：记忆按画布（集）隔离，必须指定。' };
            const r = await memoryWrite(args.projectId, args.canvasId, args);
            if (!r.ok) return { ok: false, text: r.error || '记忆写入失败' };
            return { ok: true, projectId: r.projectId, canvasId: r.canvasId, text: '✅ 记忆已写入索引（' + ((r.index && r.index.episodes.length) || 0) + ' 集）。' };
          },
        });
        reg({
          name: 'canvas_my_canvas',
          description: '自证身份：返回当前会话绑定的画布项目与画布（第几集），以及本集记忆状态。【会话=画布工作台】开始任何创作前先调用它确认「我是哪一集」；此后所有 canvas_* 工具不传 projectId/canvasId 即默认作用于本集画布。**代码级禁令**：绑定会话只能操作本集画布——显式传其他项目/画布（含同项目其他画布）会被工具直接拒绝，确需操作先请用户解绑；未绑定会话可自由操作任意项目/画布。返回的记忆提示告知是否需要先读/写本集记忆。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args, exec) {
            const sid = toolExecSessionId(exec);
            if (!sid) return { ok: false, text: '无法识别当前会话（宿主未提供会话身份）：请显式指定 projectId/canvasId 操作画布。' };
            const b = toolBindingForSession(sid);
            if (!b) return { ok: false, text: '当前会话未绑定画布：在对话输入行的「绑画布」选择器里选择或新建画布后再试；或显式传 projectId/canvasId 直接操作。' };
            const doc = readDocOrNull(b.projectId) || {};
            const regList = canvasRegistry(doc);
            const cid = b.canvasId == null ? null : b.canvasId;
            const canvases = (defaultCanvasExists(doc) && !cid ? [{ id: null, name: defaultCanvasNameOf(doc) }] : regList.map((c) => ({ id: c.id, name: c.name })));
            const idx = canvases.findIndex((c) => (c.id || null) === cid);
            const ep = idx >= 0 ? idx + 1 : null;
            const name = idx >= 0 ? canvases[idx].name : String(cid || '默认画布');
            const mem = await memoryRead(b.projectId, cid);
            const hasMem = !!(mem.episode && ((mem.episode.body || '').trim() || (mem.episode.summary || '').trim()));
            let nodeCount = 0;
            try { nodeCount = Object.keys((readCanvasDoc(b.projectId, cid) || {}).nodes || {}).length; } catch { /* 画布读取失败不阻塞自证 */ }
            const lines = [
              '本会话绑定：项目「' + (doc.name || b.projectId) + '」· 画布「' + name + '」' + (ep ? '（第' + ep + ' 集 / 共 ' + canvases.length + ' 集）' : ''),
              '记忆状态：' + (hasMem ? '已有本集记忆——开写前先 canvas_read_memory 读索引与本集正文' : '本集还没有记忆——创作告一段落必须 canvas_write_memory 回写'),
              '本集画布节点：' + nodeCount + ' 个（可读写：canvas_write_node / canvas_create_node / canvas_connect / canvas_run_node / canvas_delete_node / canvas_get_bible / canvas_update_bible）',
              '代码级禁令：绑定会话禁止跨画布/跨项目操作（显式传其他 id 会被工具拒绝）；如需操作其他画布，请用户先在对话输入行解绑。',
            ];
            return { ok: true, projectId: b.projectId, canvasId: cid, name, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_production_status',
          description: '制作状态汇报（阶段机）：返回本集画布当前所处阶段（brief/bible/assets/script/storyboard/shots_ready/generating/qc/post/delivered）、各闸门（设定集 G1 / 分镜质量 G2）的通过情况与缺失清单、证据计数（剧本/镜头/资产/视频完成数）、以及当前阶段的下一步建议。【铁律】宣称"完成/可以交付"之前必须先调它：只有 ready:true 或用户明确验收才允许说完成；blockers 非空时逐条修复后再继续。开工、卡住、汇报前都应调用。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
            },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const r = await methods.productionStatus(args);
            if (!r.ok) return { ok: false, text: '❌ ' + (r.error || '状态读取失败') };
            let capsLine = '';
            let capsMultiAgent; // undefined = 探针失败（未知）；true/false = 探针实测
            try {
              const caps = await methods.productionCapabilities();
              capsMultiAgent = !!caps.multiAgent;
              capsLine = '\n多智能体能力：' + (caps.multiAgent ? '可用（宿主已暴露会话服务）' : '不可用（宿主未暴露会话服务——自动创作保持休眠）');
            } catch { /* 探针失败不影响状态输出 */ }
            const lines = [
              '阶段：' + r.stageZh + '（' + r.stage + '）' + (r.explicit ? ' · 显式设定' : ' · 自动推进') + '　推断基线：' + r.inferred,
              '闸门：G1 设定集 ' + (r.gates.bible.ok ? '✅' : '❌ 缺 ' + r.gates.bible.missing.join('、')) + '；G2 分镜 ' + (r.gates.storyboard.ok ? '✅' : '❌ ' + r.gates.storyboard.fails.length + ' 项'),
            ];
            if ((r.gates.storyboard.warns || []).length) lines.push('G2 建议：' + r.gates.storyboard.warns.slice(0, 4).join('；'));
            if (r.blockers.length) lines.push('阻塞：' + r.blockers.map((b) => b.gate).join('、') + '——逐条修复后再继续');
            const e = r.evidence;
            lines.push('证据：角色 ' + e.characters + ' · 场景 ' + e.scenes + ' · 剧本 ' + e.scriptsDone + '/' + e.scripts + ' · 分镜表 ' + e.storyboardsWithShots + '/' + e.storyboards + '（镜头 ' + e.shotsTotal + '）· 图 ' + e.imagesDone + '/' + e.images + ' · 视频 ' + e.videosDone + '/' + e.videos);
            lines.push('下一步：' + r.next);
            lines.push('ready=' + (r.ready ? 'true（可宣称完成/进入下一步）' : 'false（不得宣称完成）'));
            if (capsLine) lines.push(capsLine.trim());
            return { ok: true, projectId: r.projectId, ...(r.canvasId ? { canvasId: r.canvasId } : {}), stage: r.stage, ready: r.ready, blockers: r.blockers, multiAgent: capsMultiAgent, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_production_advance',
          description: '显式推进/回退制作阶段（阶段机）：仅在两种情况使用——① 用户明确要求跳过某一步（如实说明后果后）；② 返工（如"这集分镜推倒重来"回退到 storyboard）。日常推进是自动的，不需要调它。必须携带 reason（写进审计），回退会同时下调阶段基线，后续按工具事件重新抬升。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
              to: { type: 'string', enum: ['brief', 'bible', 'assets', 'script', 'storyboard', 'shots_ready', 'generating', 'qc', 'post', 'delivered'], description: '目标阶段' },
              reason: { type: 'string', description: '原因（必填，进审计日志）' },
            },
            required: ['projectId', 'to', 'reason'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const r = await methods.productionAdvance(args);
            if (!r.ok) return { ok: false, text: '❌ ' + (r.error || '推进失败') };
            return { ok: true, projectId: args.projectId, stage: r.to, text: '✅ 阶段 ' + r.from + ' → ' + r.to + '（已记入审计）。' };
          },
        });
        reg({
          name: 'canvas_auto_status',
          description: '自动创作总状态：开关是否开启、宿主多智能体能力、编剧室运行进度（阶段/日志）、免费段预算单（场/镜/秒/待调用次数/估算金额）、付费段进度与成片节点。【自动模式开场先调它】它决定你走全自动分支还是引导式工作坊。',
          parameters: { type: 'object', properties: {
            projectId: { type: 'string', description: '项目 id' },
            canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
          }, required: ['projectId'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const r = await methods.autoStatus(args);
            if (!r.ok) return { ok: false, text: '❌ ' + (r.error || '状态读取失败') };
            const lines = ['自动创作：' + (r.enabled ? '已开启' : '已关闭') + ' · 多智能体：' + (r.caps && r.caps.multiAgent ? '可用' : '不可用')];
            if (r.enabled) lines.push('【自动模式·硬规则】禁止调用 ask_user_question（任何理由）；本轮必须 canvas_auto_start 启动编剧室，brief 不足由编剧室代拟 3 个方向并选定。');
            if (r.stage) lines.push('制作阶段：' + r.stage);
            if (r.run) {
              lines.push('编剧室：' + r.run.status + (r.run.phase ? '（' + r.run.phase + '）' : '') + (r.run.error ? ' · 错误：' + r.run.error : ''));
              if (r.run.budget) lines.push('预算单：' + r.run.budget.sceneCount + ' 场 / ' + r.run.budget.shotCount + ' 镜 / ' + r.run.budget.totalSeconds + ' 秒 / 待调用 ' + r.run.budget.videoCalls + ' 次' + (r.run.budget.estimatedCost != null ? ' / 估算 ' + r.run.budget.estimatedCost : ''));
              if (r.run.boards && r.run.boards.length) lines.push('分镜：' + r.run.boards.map((b) => '场' + b.no + (b.gate ? '✅' : '⚠' + b.fails.length)).join(' '));
              if (r.run.paid) lines.push('付费段：' + r.run.paid + (r.run.paidPhase ? '（' + r.run.paidPhase + '）' : '') + (r.run.paidError ? ' · ' + r.run.paidError : ''));
              if (r.run.log && r.run.log.length) lines.push('最近：' + r.run.log[r.run.log.length - 1].summary);
            }
            if (r.approval) lines.push('批准：' + (r.approval.valid ? '有效（' + r.approval.quoteId + '）' : '无/已过期'));
            return { ok: true, enabled: r.enabled, caps: r.caps, run: r.run, budget: r.run && r.run.budget || null, approval: r.approval, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_auto_start',
          description: '启动全自动创作免费段（零付费）：自动打开画布 → 调研 → 编剧A/B 独立提案 → 互评 → 监制决策 → 设定集 → 剧本生成 → 按场拆分 → 逐场分镜表 → G2 校验 → 预算单。仅当自动创作开关已开启时可用。**自动模式下用户给出创意后直接调用它，不要逐步提问。**',
          parameters: { type: 'object', properties: {
            projectId: { type: 'string', description: '项目 id' },
            canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
            brief: { type: 'string', description: '一句话创意（拍什么/给谁看/什么情绪）——剧情走向的唯一源头' },
          }, required: ['projectId', 'brief'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            try { await canvasOpen({ projectId: args.projectId, canvasId: args.canvasId }); } catch { /* 打开失败不阻塞启动 */ }
            const r = await methods.autoStart(args);
            if (!r.ok) return { ok: false, text: '❌ ' + (r.error || '启动失败') };
            return { ok: true, projectId: args.projectId, status: r.status, text: '🚀 免费段已启动（自动打开画布 + 调研/提案/互评/决策/剧本/分镜/预算单）。用 canvas_auto_status 查看进度。' };
          },
        });
        reg({
          name: 'canvas_auto_budget',
          description: '生成/查看免费段的预算单：场数、镜数、总秒数、待调用视频次数、配置单价时的估算金额。批准付费前必须先用它出单。',
          parameters: { type: 'object', properties: {
            projectId: { type: 'string', description: '项目 id' },
            canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
            unitPricePerSecond: { type: 'number', description: '可选：每秒单价（不传则用画布设置里的单价）' },
          }, required: ['projectId'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const r = await methods.autoQuote(args);
            if (!r.ok) return { ok: false, text: '❌ ' + (r.error || '预算单生成失败') };
            const lines = ['预算单 ' + r.quoteId, '场 ' + r.sceneCount + ' / 镜 ' + r.shotCount + ' / ' + r.totalSeconds + ' 秒 / 待调用 ' + r.videoCalls + ' 次'];
            if (r.estimatedCost != null) lines.push('估算金额：' + r.estimatedCost + '（单价 ' + r.unitPricePerSecond + '/秒）');
            else lines.push('提示：未配置视频单价——在画布设置 → 制作 → 视频每秒单价 填入后可显示估算金额'); // T9 ①：没配单价时给配置引导
            lines.push('批准：调用 autoApprove 或在设置卡点「批准付费段」（必须带用户原话）');
            return { ok: true, quoteId: r.quoteId, budget: r, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_auto_generate',
          description: '付费段：仅在有有效批准后可用——逐分镜表创建视频节点并真实生成（按秒计费），失败重试 2 次，全部完成后创建「成片」节点。没有批准会被拒绝。',
          parameters: { type: 'object', properties: {
            projectId: { type: 'string', description: '项目 id' },
            canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
            scenes: { type: 'array', items: { type: 'integer' }, description: '可选：只跑指定场号（1-based，对应预算单 scenes 的 scene 字段）；不传跑全部。批准令牌仍按全量预算校验——镜头变了要重新复核' },
          }, required: ['projectId'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await methods.autoGenerate(args);
            if (!r.ok) return { ok: false, text: '❌ ' + (r.error || '付费段启动失败') };
            const subset = Array.isArray(args.scenes) && args.scenes.length ? '，部分执行：本次跑 ' + args.scenes.map((n) => '场' + n).join('/') : ''; // T9 ②
            return { ok: true, projectId: args.projectId, status: r.status, text: '🎬 付费段已启动（逐场建视频节点并生成，失败重试 2 次' + subset + '）。用 canvas_auto_status 查看进度。' };
          },
        });
        reg({
          name: 'canvas_auto_abort',
          description: '中止正在运行的自动创作（免费段或付费段），保留已产出内容（会议记录/设定集/节点）。',
          parameters: { type: 'object', properties: {
            projectId: { type: 'string', description: '项目 id' },
            canvasId: { type: 'string', description: '可选：画布 id（缺省 = 项目默认画布）' },
          }, required: ['projectId'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const r = await methods.autoAbort(args);
            if (!r.ok) return { ok: false, text: '❌ ' + (r.error || '中止失败') };
            return { ok: true, projectId: args.projectId, text: '⏹ 已中止（保留已产出内容）。' };
          },
        });
        reg({
          name: 'canvas_create_node',
          description: '在项目画布上新建指定类型的节点（image 图片节点 / video 视频节点 / storyboard 分镜表 / finalcut 成片 / script 剧本 / text 文本）。图片与视频是**合并节点**：有 assetId 就是已有素材（资产），空节点在画布上点开生成面板填写提示词后生成；旧类型名 image-gen / image-asset / video-gen / video-asset 仍可用，会被自动映射为 image / video。【分镜必须用 type:"storyboard" 的分镜表节点，绝不要用剧本节点装分镜】。【工作流铁律】实际生成由节点完成：你只负责写提示词、连线（connectFrom）、canvas_run_node 触发，不要把成稿直接填进 output。分镜表用 connectFrom 连到上游剧本节点（内容来自连线，不要复制剧本全文）；image/video 没有上游提示词时才在 prompt 里写内容，有上游时靠连线取。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下的子画布；缺省 = 项目默认画布）' },
              type: { type: 'string', enum: ['script', 'text', 'image', 'video', 'audio', 'storyboard', 'finalcut', 'image-gen', 'image-asset', 'video-gen', 'video-asset'], description: '节点类型（image/video/audio 为合并/资产类型；旧名 image-gen 等仍接受并自动映射）' },
              name: { type: 'string', description: '节点名字（建议填写，如"角色-陈拾 参考图"）' },
              assetId: { type: 'string', description: '可选：已有资产 id（canvas_import_asset / canvas_list_assets 返回）。有 assetId 时图片/视频节点直接呈现该素材，不再需要生成 prompt' },
              prompt: { type: 'string', description: '提示词（图片/视频用画面提示词；剧本用创作意图；文本用正文）' },
              size: { type: 'string', description: '可选：图片清晰度 1K/2K/4K' },
              ratio: { type: 'string', description: '可选：比例，如 16:9 / 9:16 / 1:1' },
              connectFrom: { type: 'string', description: '可选：创建后立即从该节点连一条线到新节点（如剧本节点→分镜表）' },
              connectFromPort: { type: 'string', description: '可选：连线源端口，默认源节点第一个输出端口' },
              connectToPort: { type: 'string', description: '可选：连线目标端口，默认新节点第一个输入端口' },
              resolution: { type: 'string', description: '可选：视频分辨率 480P/720P/1080P' },
              duration: { type: 'number', description: '可选：视频时长（秒）' },
              count: { type: 'number', description: '可选：分镜表镜头数' },
              requirement: { type: 'string', description: '可选：分镜表额外要求' },
            },
            required: ['projectId', 'type'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = canvasCreateNode(args);
            if (r && r.ok === false && r.gate) {
              const det = r.fails ? '\n· ' + r.fails.join('\n· ') : '';
              return { ok: false, gate: r.gate, projectId: r.projectId, existingVideoId: r.existingVideoId || undefined, fails: r.fails || undefined, warns: r.warns || undefined, text: '⛔ [' + r.gate + '] ' + (r.error || '流程闸门未通过') + det + (r.fix ? '\n出路：' + r.fix : '') };
            }
            const kindHint = r.type === 'image'
              ? '（图片节点：有 assetId 即资产；空节点在画布上点开生成面板写提示词后生成）'
              : r.type === 'video'
                ? '（视频节点：有 assetId 即资产；空节点在画布上点开生成面板写提示词后生成）'
                : '';
            return {
              ok: true, projectId: r.projectId, nodeId: r.nodeId, label: r.label || undefined,
              text: '✅ 已新建[' + r.type + ']节点「' + (r.label || r.nodeId) + '」（id=' + r.nodeId + '）。' + kindHint
                + (r.mergedType ? '\n注：旧类型 ' + r.mergedType : '') + (r.note ? '\n' + r.note : ''),
            };
          },
        });
        reg({
          name: 'canvas_import_asset',
          description: '把本地文件或 http(s) URL 导入当前项目资产库，返回 assetId；随后可用 canvas_create_node / canvas_update_node 的 assetId 字段挂到图片/视频/成片节点。支持 image/video/audio，单文件上限 200MB。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              path: { type: 'string', description: '可选：本地绝对路径（与 url 二选一）' },
              url: { type: 'string', description: '可选：http(s) 直链（与 path 二选一）' },
              kind: { type: 'string', enum: ['image', 'video', 'audio'], description: '可选：资产类型（缺省按 MIME 推断）' },
              name: { type: 'string', description: '可选：资产显示名（缺省用文件名）' },
            },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 120000,
          async execute(args) {
            const r = await importAsset(args);
            return {
              ok: true, projectId: String((args && args.projectId) || ''), assetId: r.assetId, kind: r.kind, name: r.name, rel: r.rel,
              text: '✅ 已导入素材「' + r.name + '」（' + r.kind + ' · ' + Math.round(r.size / 1024) + 'KB · assetId=' + r.assetId + '）。用 canvas_create_node/update_node 的 assetId 挂到节点。',
            };
          },
        });
        reg({
          name: 'canvas_list_assets',
          description: '列出当前项目资产库（可按 kind 过滤）。返回 assetId/name/kind/mime/大小/相对路径；用于 find-and-mount，避免编造 assetId。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              kind: { type: 'string', enum: ['image', 'video', 'audio', 'text', 'general'], description: '可选：按类型过滤' },
              limit: { type: 'number', description: '可选：返回条数（默认 50，上限 200）' },
            },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 15000,
          async execute(args) {
            const projectId = String((args && args.projectId) || '');
            const limit = Math.min(200, Math.max(1, Number(args && args.limit) || 50));
            const r = await methods.assetsList({ projectId, kind: args && args.kind, limit });
            if (!r || !r.ok) return { ok: false, projectId, text: '❌ 资产列表读取失败：' + ((r && r.error) || '未知错误') };
            const assets = (r.items || []).map((a) => {
              const o = { id: a.id, name: a.name, kind: a.kind, mime: a.mime, createdAt: a.createdAt };
              if (a.rel) o.rel = a.rel;
              if (a.size != null) o.size = a.size;
              return o;
            });
            const lines = assets.map((a) => '- ' + a.id + ' [' + a.kind + '] ' + a.name + (a.size ? ' · ' + Math.round(a.size / 1024) + 'KB' : ''));
            return { ok: true, projectId, assets, text: '✅ 资产（' + assets.length + '）：\n' + (lines.join('\n') || '（空）') };
          },
        });
        reg({
          name: 'canvas_connect',
          description: '在项目画布上把两个节点连成工作流连线（剧本 → 分镜表 → 图片/视频 → 成片）。【工作流铁律】分镜表的内容来自连线的上游剧本节点，不要把剧本全文复制进分镜表节点；图片/视频节点没有上游提示词时才在 prompt 里写内容，有上游时靠连线取。端口类型必须匹配（text→text、image→image、video→video），不匹配会报错；单线输入端口（script/prompt/frame/in）重复连线会替换旧线，ref 类端口允许多条。目标端口缺省时按语义自动选：文本→分镜表 script、分镜表→分镜表 prev、文本→图片/视频 prompt、图片→图片/视频 ref、视频→视频 frame / 成片 in。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下的子画布；缺省 = 项目默认画布）' },
              fromNode: { type: 'string', description: '源节点 id（连出方）' },
              fromPort: { type: 'string', description: '可选：源端口，默认该节点第一个输出端口（剧本/文本/图片/视频都是 out）' },
              toNode: { type: 'string', description: '目标节点 id（连入方）' },
              toPort: { type: 'string', description: '可选：目标端口，缺省按语义自动选择（分镜表=script/prev、图片=prompt/ref、视频=prompt/ref/frame、成片=in）' },
            },
            required: ['projectId', 'fromNode', 'toNode'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = canvasConnect(args);
            return { ok: true, projectId: r.projectId, edgeId: r.edgeId, already: r.already || undefined, text: r.text };
          },
        });
        reg({
          name: 'canvas_open',
          description: '打开无限画布页面并跳到指定项目（画布侧会在几秒内自动切换）。用户想查看/编辑画布时使用。',
          parameters: { type: 'object', properties: { projectId: { type: 'string', description: '要打开的项目 id（缺省只打开画布页）' }, canvasId: { type: 'string', description: '可选：要打开的画布 id（缺省 = 项目默认画布）' } }, additionalProperties: false },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasOpen(args);
            return { ok: true, projectId: r.projectId || undefined, text: r.projectId ? ('✅ 画布即将打开并跳到项目 ' + r.projectId + '。') : '✅ 画布即将打开。' };
          },
        });
        // ── 技能包：把「本插件有哪些技能、各管什么」和「当前该按什么口径写提示词」交给对话侧 ──
        reg({
          name: 'canvas_list_skills',
          description: '列出本插件（无限画布）提供的全部技能，以及技能包（导演透镜 / 题材 / 规格 / 影调 / 运镜）的完整清单和当前项目的已选配置。【开始任何画布创作前先调它】：它会告诉你写剧本、分镜、图片提示词、视频提示词各自该加载哪份技能、可用哪些透镜与题材，随后用 canvas_skill_pack 取切片。',
          parameters: {
            type: 'object',
            properties: { projectId: { type: 'string', description: '可选：项目 id（给出时一并返回该项目的已选配置）' } },
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const inv = packInventory(HERE);
            const pid = String((args && args.projectId) || '');
            const doc = pid ? readDoc(pid) : { skillProfile: DEFAULT_SKILL_PROFILE };
            const allow = allowedIds(inv);
            const profile = normalizeSkillProfile(doc.skillProfile, allow);
            const lines = [];
            lines.push('本插件共 ' + SKILL_CATALOG.length + ' 份技能：');
            for (const s of SKILL_CATALOG) lines.push('  · ' + s.name + ' —— ' + s.when);
            lines.push('');
            lines.push('技能包清单（用 canvas_skill_pack 按能力取切片，不要整份读）：');
            lines.push(renderInventory(inv, profile, true));
            lines.push('');
            lines.push(pid ? ('项目 ' + pid + ' 当前配置：' + renderProfile(profile, inv, true)) : '（未指定项目，不返回配置）');
            lines.push('');
            lines.push('下一步：canvas_skill_pack({ projectId, kind }) —— kind 取 script / storyboard / prompt / assets。');
            return { ok: true, projectId: pid || undefined, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_skill_pack',
          description: '按生成能力取「导演透镜 + 题材 + 规格 + 影调 + 运镜」的已拼装切片，用于写剧本（script）/ 分镜（storyboard）/ 图片与视频提示词（prompt）/ 角色场景道具设定图（assets）。返回切片全文、字节数与生效配置，可直接拼进你的系统提示或提示词。【这是让对话写出的内容与画布自生成保持同一口径的唯一入口】；也可以用 lens/genres/form/look 临时覆盖，或传 set:true 把配置写进项目（与画布 UI 选择同源）。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              kind: { type: 'string', enum: ['script', 'storyboard', 'prompt', 'assets'], description: '生成能力：script=剧本，storyboard=分镜，prompt=图片/视频提示词，assets=资产设定图。缺省 script' },
              lens: { type: 'string', description: '可选：临时覆盖导演透镜 id（见 canvas_list_skills）' },
              genres: { type: 'array', items: { type: 'string' }, description: '可选：临时覆盖题材 id 数组（叙事题材与行业题材都可）' },
              form: { type: 'string', description: '可选：临时覆盖规格 id' },
              look: { type: 'string', description: '可选：临时覆盖影调 id；传空串表示跟随导演' },
              sceneText: { type: 'string', description: '可选（仅 kind=storyboard 有意义）：本场剧本文本——战斗注入按场检测用，命中打斗才带「打斗节奏」卡；不传则不判定、绝不由题材猜测' },
              combatMode: { type: 'string', enum: ['auto', 'on', 'off'], description: '可选：打斗判定覆盖——auto=按 sceneText 检测（缺省），on=本场强制按打斗注入，off=强制不注入' },
              set: { type: 'boolean', description: '可选：true = 把本次生效的配置写进项目（之后画布自生成也用同一套）' },
            },
            required: ['projectId'],
            additionalProperties: false,
          },
          output: textOutput,
          timeoutMs: 60000,
          async execute(args) {
            const pid = String((args && args.projectId) || '');
            if (!pid) throw new Error('需要 projectId');
            const doc = readDoc(pid);
            const inv = packInventory(HERE);
            const allow = allowedIds(inv);
            const base = normalizeSkillProfile(doc.skillProfile, allow);
            const override = {};
            if (args.lens !== undefined) override.lens = args.lens;
            if (args.genres !== undefined) override.genres = args.genres;
            if (args.form !== undefined) override.form = args.form;
            if (args.look !== undefined) override.look = args.look;
            const merged = normalizeSkillProfile({ ...base, ...override }, allow);
            const kind = String((args && args.kind) || 'script');
            if (!['script', 'storyboard', 'prompt', 'assets'].includes(kind)) {
              throw new Error('kind 必须是 script / storyboard / prompt / assets，收到：' + kind);
            }
            const built = await buildSkillPack({
              kind, profile: merged, hereDir: HERE, zh: true,
              ...(kind === 'storyboard' && args.combatMode !== undefined ? { sceneText: String(args.sceneText || ''), combatMode: String(args.combatMode || 'auto') } : {}),
            });
            if (args.set) {
              doc.skillProfile = merged;
              doc.skillUpdatedAt = Date.now();
              doc.updatedAt = Date.now();
              writeIcDoc(pid, doc);
              markDocChanged(pid);
            }
            const head = '【' + (args.set ? '已写入项目配置。' : '') + '生效配置：' + renderProfile(merged, inv, true) + '】\n切片 ' + built.bytes + ' 字节；';
            return {
              ok: true,
              projectId: pid,
              bytes: built.bytes,
              profile: merged,
              text: head + '\n\n' + built.text,
            };
          },
        });
      }
    } catch { /* tools 服务不可用时跳过注册 */ }

    // 内置技能：把画布操作规程交给 skills 服务（Agent 可加载，作为硬约束）
    try { registerCanvasSkill(ctx, toolDisposers); } catch { /* skills 服务不可用时跳过 */ }

    // 数据根目录已设置时：启动即迁移/对齐布局（pid 文件夹 → 项目名文件夹 + 项目文档镜像），失败静默（下次设置/重启再试）
    try {
      if (dataRoot()) {
        if (sqlActive()) getDb(); // 预热 SQLite（必要时触发 v1→v2 一次性迁移）
        else dataRootMigrate();
      }
    } catch { /* 迁移失败不影响启动 */ }

    _rpcMethods = methods;
    const registrations = [
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/rpc`,
        async handler(req, res) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          try {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: '仅接受 POST' }));
              return;
            }
            let raw = '';
            for await (const chunk of req) {
              raw += chunk;
              if (raw.length > 8e6) throw new Error('请求过大');
            }
            const { method, args } = JSON.parse(raw);
            if (typeof method !== 'string' || !Object.hasOwn(methods, method)) throw new Error('未知操作: ' + method);
            const fn = methods[method];
            if (typeof fn !== 'function') throw new Error('未知操作: ' + method);
            res.end(JSON.stringify(await fn(args ?? {})));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String((e && e.message) || e) }));
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/llm-stream`,
        async handler(req, res) {
          // 流式生成：把「思考中」的内容实时推给画布，让用户看得到过程（推理模型可能要思考很久）
          try {
            if (req.method !== 'POST') { res.statusCode = 405; res.end('仅接受 POST'); return; }
            let raw = '';
            for await (const chunk of req) {
              raw += chunk;
              if (raw.length > 16e6) throw new Error('请求过大'); // 视觉拉片可能带多帧 base64
            }
            const args = JSON.parse(raw || '{}');
            res.statusCode = 200;
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('connection', 'keep-alive');
            const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端断开 */ } };
            let closed = false;
            res.on('close', () => { closed = true; });
            const text = await complete(args, {
              onAttempt: (info) => send({ t: 'attempt', d: info }),
              onReasoning: (d) => { if (!closed) send({ t: 'r', d }); },
              onText: (d) => { if (!closed) send({ t: 'x', d }); },
            });
            send({ t: 'done', d: text });
            res.end();
          } catch (e) {
            const message = String((e && e.message) || e);
            try {
              if (res.headersSent) { res.write('data: ' + JSON.stringify({ t: 'fail', d: message }) + '\n\n'); res.end(); }
              else { res.statusCode = 400; res.end(message); }
            } catch { /* 忽略 */ }
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/asset`,
        async handler(req, res) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          try {
            if (req.method !== 'POST' && req.method !== 'PUT') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: '仅接受 POST/PUT' }));
              return;
            }
            const root = dataRoot();
            if (!root) throw new Error('未设置数据根目录');
            const u = new URL(req.url, 'http://localhost');
            const rawRel = u.searchParams.get('rel') || '';
            const rel = physicalRel(rawRel) || rawRel; // 逻辑路径（pid）→ 物理路径（项目名文件夹）
            const { abs, clean } = safeJoin(root, rel);
            mkdirSync(path.dirname(abs), { recursive: true });
            let size = 0;
            const MAX_UPLOAD = 512 * 1024 * 1024; // 512MB 上限：避免无界写盘
            await new Promise((resolve, reject) => {
              const ws = createWriteStream(abs);
              const fail = (err) => {
                // 中断/超限：销毁写流并删掉半截文件，避免数据目录累积垃圾与"截断但仍 200"的资产
                try { ws.destroy(); } catch { /* 忽略 */ }
                try { unlinkSync(abs); } catch { /* 忽略 */ }
                reject(err);
              };
              req.on('data', (c) => {
                size += c.length;
                if (size > MAX_UPLOAD) fail(new Error('文件过大（上限 512MB）'));
              });
              req.on('error', fail);
              req.on('aborted', () => fail(new Error('上传中断')));
              ws.on('error', fail);
              ws.on('finish', resolve);
              req.pipe(ws);
            });
            res.end(JSON.stringify({ ok: true, rel: clean, size }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String((e && e.message) || e) }));
          }
        },
      }),
      // 外部 API 代理：浏览器直连第三方图片/视频/音频网关会被 CORS 拦（Failed to fetch），由 Host 代为请求
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/fetch-proxy`,
        async handler(req, res) {
          try {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ error: '仅接受 POST' }));
              return;
            }
            const chunks = [];
            let size = 0;
            for await (const c of req) {
              size += c.length;
              if (size > 16e6) { res.statusCode = 413; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: '请求体过大（上限 16MB）' })); return; }
              chunks.push(c);
            }
            let payload = {};
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { payload = {}; }
            const out = await fetchProxyForward(payload);
            res.statusCode = out.status;
            res.setHeader('content-type', out.contentType);
            res.end(out.buf);
          } catch (e) {
            const timedOut = e && (e.name === 'TimeoutError' || /aborted|timeout/i.test(String((e && e.message) || e)));
            res.statusCode = timedOut ? 504 : 502;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: (timedOut ? '图片接口代理超时：' : '图片接口代理请求失败：') + String((e && e.message) || e) }));
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/file`,
        async handler(req, res) {
          try {
            if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end('仅接受 GET/HEAD'); return; }
            const root = dataRoot();
            if (!root) { res.statusCode = 404; res.end('未设置数据根目录'); return; }
            const u = new URL(req.url, 'http://localhost');
            const rawRel = u.searchParams.get('rel') || '';
            const rel = physicalRel(rawRel) || rawRel; // 逻辑路径（pid）→ 物理路径（项目名文件夹）
            const { abs } = safeJoin(root, rel);
            let st;
            try { st = statSync(abs); } catch { res.statusCode = 404; res.end('not found'); return; }
            if (!st.isFile()) { res.statusCode = 404; res.end('not found'); return; }
            res.setHeader('content-type', mimeOf(abs));
            res.setHeader('accept-ranges', 'bytes');
            // 派生预览文件内容不变 → 长缓存；原文件保持 no-cache
            res.setHeader('cache-control', isDerivedMedia(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
            // HEAD：只回应元信息（node fetch HEAD 探针用），不读文件、不占解码/内存
            if (req.method === 'HEAD') {
              res.statusCode = 200;
              res.setHeader('content-length', String(st.size));
              res.end();
              return;
            }
            const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
            if (m && (m[1] !== '' || m[2] !== '')) {
              let start;
              let end;
              if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; }
              else { start = parseInt(m[1], 10); end = m[2] === '' ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1); }
              if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
                res.statusCode = 416;
                res.setHeader('content-range', 'bytes */' + st.size);
                res.end();
                return;
              }
              res.statusCode = 206;
              res.setHeader('content-range', `bytes ${start}-${end}/${st.size}`);
              res.setHeader('content-length', String(end - start + 1));
              pipeFile(abs, { start, end }, res);
            } else {
              res.setHeader('content-length', String(st.size));
              pipeFile(abs, {}, res);
            }
          } catch (e) {
            res.statusCode = 400;
            res.end(String((e && e.message) || e));
          }
        },
      }),
      // 视频静态封面（poster）落盘：body 为 jpeg/png 字节，写入 `<rel>.poster.jpg`。
      // 有 poster 后画布视频节点默认只画一张 img（浏览器磁盘缓存、零视频解码），播放时才挂 <video>。
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/poster`,
        async handler(req, res) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          try {
            if (req.method !== 'POST' && req.method !== 'PUT') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: '仅接受 POST/PUT' }));
              return;
            }
            const root = dataRoot();
            if (!root) throw new Error('未设置数据根目录');
            const u = new URL(req.url, 'http://localhost');
            const rawRel = String(u.searchParams.get('rel') || '').trim();
            if (!rawRel) throw new Error('缺少 rel');
            if (/\.poster\.jpg$/i.test(rawRel)) throw new Error('rel 不应包含 poster 后缀');
            const rel = physicalRel(rawRel) || rawRel; // 逻辑路径（pid）→ 物理路径（项目名文件夹）
            const { abs, clean } = safeJoin(root, rel + '.poster.jpg'); // safeJoin 会拒绝 ../ 与绝对路径
            mkdirSync(path.dirname(abs), { recursive: true });
            const chunks = [];
            let size = 0;
            const MAX_POSTER = 8 * 1024 * 1024; // 封面只应是缩略 JPEG，8MB 足够且防无界写盘
            for await (const c of req) {
              size += c.length;
              if (size > MAX_POSTER) { res.statusCode = 413; res.end(JSON.stringify({ error: 'poster 过大（上限 8MB）' })); return; }
              chunks.push(c);
            }
            if (!size) throw new Error('poster 内容为空');
            await fs.writeFile(abs, Buffer.concat(chunks));
            res.end(JSON.stringify({ ok: true, rel: clean, size }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String((e && e.message) || e) }));
          }
        },
      }),
      // 节点展示用缩略图落盘：body 为 jpeg/png，写入 `<rel>.thumb.jpg`。
  // 缩略图是系统派生文件：不进 assets.json、不出现在资产库；节点只加载它（几十 KB），
  // 点开看原图 / 点播放才加载原文件。
  ctx.webServer.register({
    kind: 'exact',
    path: `/${NAME}/api/thumb`,
    async handler(req, res) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      try {
        if (req.method !== 'POST' && req.method !== 'PUT') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: '仅接受 POST/PUT' }));
          return;
        }
        const root = dataRoot();
        if (!root) throw new Error('未设置数据根目录');
        const u = new URL(req.url, 'http://localhost');
        const rawRel = String(u.searchParams.get('rel') || '').trim();
        if (!rawRel) throw new Error('缺少 rel');
        if (/\.thumb\.jpg$/i.test(rawRel)) throw new Error('rel 不应包含 thumb 后缀');
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (ct && !/^image\/(jpeg|png)/.test(ct)) throw new Error('缩略图只接受 image/jpeg 或 image/png');
        const rel = physicalRel(rawRel) || rawRel;
        const { abs, clean } = safeJoin(root, rel + '.thumb.jpg');
        mkdirSync(path.dirname(abs), { recursive: true });
        const chunks = [];
        let size = 0;
        const MAX_THUMB = 2 * 1024 * 1024;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_THUMB) { res.statusCode = 413; res.end(JSON.stringify({ error: 'thumb 过大（上限 2MB）' })); return; }
          chunks.push(c);
        }
        if (!size) throw new Error('thumb 内容为空');
        await fs.writeFile(abs, Buffer.concat(chunks));
        res.end(JSON.stringify({ ok: true, rel: clean, size, maxSide: THUMB_MAX_SIDE }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      }
    },
  }),

  // CAS 对象库读路径（0.18）：0.18.0–0.18.4 上传的媒体仍在 objects/ 里，必须继续可读。
      // IC-08 起写路径已退役（POST/PUT 一律 405），只有 GET。
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/object`,
        async handler(req, res) {
          try {
            const root = dataRoot();
            if (!root) throw new Error('未设置数据根目录');
            // IC-08：写路径已退役——新上传一律经 /api/asset 落项目文件夹。
            // 明确回 4xx 而不是静默接受：挂着旧版本 JS 的标签页 POST 过来时必须看得见失败。
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.setHeader('allow', 'GET');
              res.end(JSON.stringify({ error: '对象库写路径已退役（0.18.5 起新上传走 /api/asset 落项目文件夹）；本路由仅支持 GET 读取历史对象' }));
              return;
            }
            {
              const u = new URL(req.url, 'http://localhost');
              const sha = String(u.searchParams.get('sha') || '').toLowerCase();
              if (!/^[0-9a-f]{64}$/.test(sha)) { res.statusCode = 400; res.end('非法 sha256'); return; }
              const abs = objectAbsFor(root, sha);
              let st;
              try { st = statSync(abs); } catch { res.statusCode = 404; res.end('对象不存在'); return; }
              const mime = String(u.searchParams.get('mime') || 'application/octet-stream');
              res.setHeader('content-type', /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream');
              res.setHeader('accept-ranges', 'bytes');
              res.setHeader('cache-control', 'public, max-age=31536000, immutable'); // 内容寻址：内容永不变，可永久缓存
              const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
              if (m && (m[1] !== '' || m[2] !== '')) {
                let start;
                let end;
                if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; }
                else { start = parseInt(m[1], 10); end = m[2] === '' ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1); }
                if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
                  res.statusCode = 416;
                  res.setHeader('content-range', 'bytes */' + st.size);
                  res.end();
                  return;
                }
                res.statusCode = 206;
                res.setHeader('content-range', `bytes ${start}-${end}/${st.size}`);
                res.setHeader('content-length', String(end - start + 1));
                pipeFile(abs, { start, end }, res);
              } else {
                res.setHeader('content-length', String(st.size));
                pipeFile(abs, {}, res);
              }
              return;
            }
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: String((e && e.message) || e) }));
          }
        },
      }),
      // 插件自带静态资源（帮助与反馈用的微信群二维码等）：白名单 assets/ 目录，拒绝路径穿越
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/plugin-asset`,
        async handler(req, res) {
          try {
            if (req.method !== 'GET') { res.statusCode = 405; res.end('仅接受 GET'); return; }
            const u = new URL(req.url, 'http://localhost');
            const rel = String(u.searchParams.get('rel') || '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (rel.includes('..') || !/^assets\/[\w.\u4e00-\u9fa5/-]+$/.test(rel)) { res.statusCode = 400; res.end('非法路径'); return; }
            const assetsDir = path.join(HERE, 'assets');
            const abs = path.resolve(path.join(HERE, rel));
            if (!abs.startsWith(assetsDir)) { res.statusCode = 400; res.end('非法路径'); return; }
            let st;
            try { st = statSync(abs); } catch { res.statusCode = 404; res.end('not found'); return; }
            if (!st.isFile()) { res.statusCode = 404; res.end('not found'); return; }
            res.setHeader('content-type', mimeOf(abs));
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('content-length', String(st.size));
            pipeFile(abs, {}, res);
          } catch (e) {
            res.statusCode = 500;
            res.end(String((e && e.message) || e));
          }
        },
      }),
    ];
    return () => {
      for (const off of registrations) { try { if (off) off(); } catch { /* 忽略 */ } }
      for (const d of toolDisposers) { try { d(); } catch { /* 忽略 */ } }
    };
  }, `${NAME}: api routes`);
}
