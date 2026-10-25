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
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const NAME = 'infinite-canvas';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// 版本单一来源 = 当前副本的 package.json（硬编码常量曾与包版本漂移）
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || VERSION;
} catch { /* 保留默认值 */ }

// 更新检查的唯一信息源 = npm registry latest（与安装方式无关：
// npm 在线安装 / 本地 link 开发态 / 其它方式，一律走同一条逻辑）。
const NPM_LATEST_URL = 'https://registry.npmjs.org/' + encodeURIComponent('@ninkch/dsh-infinite-canvas') + '/latest';
const PKG_NAME = '@ninkch/dsh-infinite-canvas';

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
function runPnpmAdd(pnpm, spec, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdout = [];
    const stderr = [];
    let child;
    const relax = opts.relaxReleaseAge ? ['--config.minimum-release-age=0'] : [];
    const args = pnpm.kind === 'script'
      ? ['--expose-internals', pnpm.script, 'add', spec, '--save-exact', ...relax]
      : ['add', spec, '--save-exact', ...relax];
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
      text TEXT, source TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_assets_proj ON assets(project_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha);
    CREATE TABLE IF NOT EXISTS bindings (asset_id TEXT, entity_id TEXT, PRIMARY KEY (asset_id, entity_id));
    CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, project_id TEXT, season INTEGER, number INTEGER, title TEXT);
  `);
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

/** 项目文档摘要（列表页用，避免每次列表都解析全量 doc）。类型按合并类型输出。 */
function docSummary(d) {
  const nodes = Object.values(d.nodes || {}).map((n) => ({
    id: n.id, type: normalizeNodeType(n.type), label: (n.data && n.data.label) || '', status: (n.data && n.data.status) || 'idle',
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
  if (r.text != null && r.text !== '') out.text = r.text;
  return out;
}

function syncFts(db, id, name, prompt) {
  db.prepare('DELETE FROM assets_fts WHERE id = ?').run(id);
  db.prepare('INSERT INTO assets_fts (id, name, prompt) VALUES (?, ?, ?)').run(id, String(name || ''), String(prompt || ''));
}

function upsertAssetRow(db, row) {
  db.prepare(`INSERT INTO assets (id, project_id, episode_id, kind, mime, name, rel, sha, bytes, width, height, duration, prompt, category, entity, entities, node_label, text, source, created_at, updated_at)
    VALUES (@id, @project_id, @episode_id, @kind, @mime, @name, @rel, @sha, @bytes, @width, @height, @duration, @prompt, @category, @entity, @entities, @node_label, @text, @source, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET project_id=@project_id, episode_id=@episode_id, kind=@kind, mime=@mime, name=@name, rel=@rel, sha=@sha, bytes=@bytes,
      width=@width, height=@height, duration=@duration, prompt=@prompt, category=@category, entity=@entity, entities=@entities,
      node_label=@node_label, text=@text, source=@source, updated_at=@updated_at`).run(row);
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
  if (patch && patch.text !== undefined && cur.kind === 'text') merged.text = String(patch.text || '');
  upsertAssetRow(db, assetRowFromRecord({ ...merged, createdAt: cur.createdAt }));
  return { ok: true, asset: rowToAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id)) };
}

/** CAS 对象库 GC 已随写路径退役（IC-08）：新上传不再产生 objects/，历史对象由删资产时的
 *  引用计数回收（gcObjectIfUnreferenced）兜住，不需要独立的定期扫描入口。 */

function readDocOrNull(id) {
  if (sqlActive()) {
    const db = getDb();
    const row = db.prepare('SELECT doc FROM projects WHERE id = ?').get(id);
    if (!row) return null;
    try { return JSON.parse(row.doc); } catch { return null; }
  }
  try { return JSON.parse(readFileSync(projectFile(id), 'utf8')); } catch { return null; }
}
function docExists(id) {
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
    characters: arr(b.characters),
    scenes: arr(b.scenes),
    props: arr(b.props),
  };
}
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
function projectsList() {
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
      }));
      list.push({ id: d.id || id, name: d.name || id, createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0, source: d.source || 'app', nodeIds: Object.keys(d.nodes || {}), nodes, tombstones: d.tombstones || [], bibleUpdatedAt: d.bibleUpdatedAt || 0, canvases: canvasRegistry(d), defaultCanvasName: defaultCanvasNameForApi(d), defaultCanvasDeleted: !defaultCanvasExists(d) });
    } catch { /* 单文件损坏跳过 */ }
  }
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
    // 项目级字段（名称/设定集/画布清单）始终只写项目文档：项目文档缺失时补一份最小项目
    const projectDoc = readDocOrNull(id);
    if (!projectDoc) {
      const canvases = sanitizeCanvases((args && args.canvases) || []);
      if (!canvases.some((c) => c.id === canvasId)) canvases.push({ id: canvasId, name: canvasId, createdAt: Date.now() });
      writeIcDoc(id, {
        id, name: String((args && args.name) || id).slice(0, 80), createdAt: Date.now(), updatedAt: Date.now(),
        nodes: {}, edges: [], view: { x: 60, y: 40, scale: 1 }, tombstones: [], canvases,
        defaultCanvasName: defaultCanvasNameOf({ defaultCanvasName: args && args.defaultCanvasName }),
        ...(canvasBible ? { bible: canvasBible.bible, bibleUpdatedAt: canvasBible.bibleUpdatedAt } : {}),
      });
    } else {
      const patch = {};
      if (canvasBible) { patch.bible = canvasBible.bible; patch.bibleUpdatedAt = canvasBible.bibleUpdatedAt; }
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
  if (sqlActive()) {
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
// canvas-studio＝操作硬约束；canvas-craft＝剧本/分镜/提示词创作方法论；canvas-layout＝节点布局纪律
const SKILL_NAMES = ['canvas-studio', 'canvas-craft', 'canvas-layout'];
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
  if (sqlActive()) {
    const doc = readDocOrNull(id);
    if (!doc) throw new Error('项目不存在：' + id + '（先用 canvas_list_projects 查看可用项目 id）');
    // 旧项目兼容：读入即归一旧节点类型（image-gen/image-asset → image，video-gen/video-asset → video）
    return normalizeDocNodes(doc);
  }
  const f = projectFile(id);
  let raw;
  try {
    raw = readFileSync(f, 'utf8');
  } catch {
    throw new Error('项目不存在：' + id + '（先用 canvas_list_projects 查看可用项目 id）');
  }
  try {
    return normalizeDocNodes(JSON.parse(raw));
  } catch {
    throw new Error('项目文件损坏，无法解析：' + id + '（可考虑重建该项目）');
  }
}
/** 原子写项目/画布文档：SQL 模式走单行事务；文件模式先写临时文件再改名，避免半写导致项目"消失"。
 *  子画布文档（id 含 __cv__）不重复登记项目文件夹、不镜像 project.json——项目级 meta 只属于默认画布行。 */
function writeIcDoc(id, doc) {
  const canvasRef = splitCanvasDocId(id);
  const isCanvas = isCanvasDocId(id);
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
  if (!['script', 'text', 'image', 'video', 'storyboard', 'finalcut'].includes(type)) throw new Error('不支持的节点类型: ' + rawType);
  const legacyType = rawType !== type ? rawType : '';
  const label = args && args.name ? String(args.name).slice(0, 40) : '';
  const prompt = String((args && args.prompt) || '');
  const connectFrom = String((args && args.connectFrom) || '');
  // 媒体节点：空态按「预览区比例 + 标题栏」给外框（没有操作栏就不加 NODE_FOOT_H），
  // 布点时用真实外框做碰撞检测，避免按 360×360 估小后与同列邻居重叠。
  const mediaSize = (type === 'image' || type === 'video')
    ? mediaNodeSize((args && args.ratio) || '16:9', false)
    : null;
  const pos = nextNodePos(doc, type, connectFrom, mediaSize);
  let connected = null;
  let autoConnected = null;
  let node;
  if (type === 'image') {
    node = agentNode('text', '', pos.x, pos.y, label || '图片节点');
    node.type = 'image';
    node.w = mediaSize.w; node.h = mediaSize.h;
    node.data = { ...node.data, status: 'idle', error: null, prompt, assetId: null, demo: false, size: (args && args.size) || '2K', ratio: (args && args.ratio) || '16:9', imageCount: 1 };
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
    let autoConnectId = '';
    let forced = false;
    if (sbWithShots) {
      autoConnectId = sbWithShots.id; // 无论是否传 prompt：镜头清单只认分镜表
      forced = hasPrompt;
    } else if (!hasPrompt && sbEmpty) {
      autoConnectId = sbEmpty.id; // 分镜表存在但 shots 为空：先连线占位（生成前需先拆解镜头）
    }
    node.data = { ...node.data, status: 'idle', error: null, prompt: autoConnectId ? '' : prompt, assetId: null, demo: false, duration: Number(args && args.duration) || 5, resolution: (args && args.resolution) || '720P', ratio: (args && args.ratio) || '16:9' };
    autoConnected = autoConnectId ? { from: autoConnectId, ignoredPrompt: forced && hasPrompt, emptyShots: !sbWithShots && !!sbEmpty } : null;
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
    node.data = { ...node.data, status: 'idle', error: null, resolution: (args && args.resolution) || '720P', ratio: (args && args.ratio) || '16:9', transition: 'none', progress: null, assetId: null, subs: {}, keepAudio: true };
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
  const nodes = Object.values(doc.nodes || {});
  if (!nodes.length) return { ok: true, projectId: id, ...(canvasId ? { canvasId } : {}), moved: 0, rows: 0 };
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
  let cy = 40;
  let moved = 0;
  for (const row of rowList) {
    const rowH = Math.max(200, ...row.ids.map((n) => Number(n.h) || 200));
    for (const n of row.ids) { n.x = colX.get(depth.get(n.id) || 0); n.y = cy; moved++; }
    cy += rowH + 40;
  }
  doc.updatedAt = Date.now();
  writeToolDoc(args, doc);
  return { ok: true, projectId: id, ...(canvasId ? { canvasId } : {}), moved, rows: rowList.length };
}
async function canvasDeleteProject(args) {
  const id = String((args && args.projectId) || '');
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
  const cfg = readIcConfig();
  cfg.ui = { ...(cfg.ui || {}), runRequest: { projectId: pid, canvasId, nodeId, at: Date.now() } };
  writeIcConfig(cfg);
  return { ok: true, projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, type: node.type, label: (node.data && node.data.label) || '' };
}
/** 读取节点运行状态与产物（画布执行完成后会把结果推回 Host 文档）。 */
/** 分镜一致性检查（与客户端 checkShotConsistency 同规则，Host 供状态查询/设定集更新后重算）：
 *  检查 shots 的角色/场景/道具数组 **以及 visual/motion 文本里的 @提及** 是否都在设定集登记；
 *  两级告警：「未登记」（设定集/资产都没有）与「已登记但描述为空」（待补全）。 */
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
  const check = (title, kind, name) => {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return;
    const exact = entries.find((e) => e.lower === q);
    if (exact) {
      if (!exact.desc.trim()) warn(`${title} · ${kind}「${exact.name}」已登记但描述为空（待补全）`);
      return;
    }
    for (const k of known) { if (k.includes(q) || q.includes(k)) return; }
    warn(`${title} · ${kind}「${String(name).trim()}」未在设定集中登记`);
  };
  for (const sh of shots || []) {
    const title = String((sh && sh.title) || '').trim() || '分镜';
    for (const nm of (sh.characters || [])) check(title, '角色', nm);
    check(title, '场景', sh && sh.scene);
    for (const nm of (sh.props || [])) check(title, '道具', nm);
    // visual/motion 文本里的 @资产名@ 提及同样纳入检查（未登记的提示补充——与客户端 parseMentions 词法一致）
    const text = String((sh && sh.visual) || '') + ' ' + String((sh && sh.motion) || '');
    const seenMention = new Set();
    for (const m of (text.match(/@([^@\s，。；：、,.;:!?！？()（）[\]【】"'“”<>《》/\\|]{1,64}?)@/g) || [])) {
      const nm = m.replace(/^@/, '').replace(/@$/, '');
      if (seenMention.has(nm)) continue;
      seenMention.add(nm);
      check(title, '提及', nm);
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
    }))
    : undefined;
  const d = n.data || {};
  return {
    projectId: pid, ...(canvasId ? { canvasId } : {}), nodeId, type: n.type, label: d.label || '',
    status: d.status || 'idle',
    aiStatus: d.aiStatus || 'idle',
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
const NODE_PATCH_FIELDS = ['prompt', 'idea', 'output', 'text', 'script', 'requirement', 'label', 'ratio', 'size', 'duration', 'resolution', 'frameMode', 'count', 'imageModel', 'videoModel', 'model', 'cont'];
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
    } else {
      v = String(v == null ? '' : v);
    }
    n.data[k] = v;
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
  'finalcut': { inputs: [{ id: 'in', kind: 'video' }], outputs: [] },
  'group': { inputs: [], outputs: [] },
};
const MULTI_INPUT_PORTS = new Set(['ref', 'char', 'scene', 'prop']);
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
      tp = 'in';
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

/** 读取 npm registry 上 latest dist-tag 的版本号。 */
async function npmLatestVersion() {
  const res = await fetch(NPM_LATEST_URL, {
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
  const remoteVersion = await npmLatestVersion();
  const cmp = cmpVer(runningVersion, remoteVersion);
  if (cmp === null) {
    // 版本号无法解析（本地被改成非规范三段等）：如实报"未知"，绝不谎称已是最新
    return { source: 'npm', runningVersion, remoteVersion, behind: 0, upToDate: false, unknown: true, note: '版本号无法解析，无法判断是否需要更新' };
  }
  const behind = cmp < 0 ? 1 : 0;
  return { source: 'npm', runningVersion, remoteVersion, behind, upToDate: behind === 0 };
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
  const latest = await npmLatestVersion();
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
  let res = await runPnpmAdd(pnpm, spec);
  let policyRelaxed = false;
  if (!res.ok && /MINIMUM_RELEASE_AGE_VIOLATION/.test((res.stdout || '') + (res.stderr || ''))) {
    // pnpm 11 供应链保护对 24h 内新发布间歇性拦截；用户点击已是明确同意 → 放宽重试一次
    policyRelaxed = true;
    res = await runPnpmAdd(pnpm, spec, { relaxReleaseAge: true });
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
  return { ok: true, changed: true, version: installed, output, policyRelaxed };
}

export const inject = ['webServer', 'tools'];

// 仅供诊断 / 自动化测试（不属于 RPC 面，运行时行为不受影响）
export const _internals = { THUMB_MAX_SIDE, thumbRelOf, isDerivedMedia, updateCheck, updateInstall, npmLatestVersion, cmpVer, findPnpm, getProfileDir: () => PROFILE_DIR, getVersion: () => VERSION, dataRoot, setDataRoot, dataRootMigrate, dataRootImport, ensureProjectFolder, physicalRel, mirrorProjectToDataRoot, writeAssetIndex, removeAssetIndexEntry, readDataRootMeta, removeDataRootProject, sqlDeleteProjectRows, deletedProjectIds, addDeletedProjectId, clearDeletedProjectId, fetchProxyForward, storyboardConsistencyWarnings, readAssetIndexNames, safeJoin, mimeOf, pipeFile, getIcConfigPath: () => CONFIG_PATH, canvasCreateProject, canvasWriteNode, canvasConnect, canvasDeleteProject, canvasDeleteNode, canvasRunNode, canvasNodeStatus, canvasGetBible, canvasUpdateBible, canvasCreateNode, canvasOpen, canvasesList, canvasCreate, canvasRename, canvasDelete, canvasDocId, isCanvasDocId, splitCanvasDocId, normalizeCanvasId, canvasRegistry, sanitizeCanvases, readCanvasDoc, writeCanvasDoc, deleteCanvasDocsForProject, projectsList, projectsPut, projectsGet, projectsDelete, projectsSync, sqliteAvailable: () => !!SQLITE, getDb, closeDb, dbAssetsList, dbAssetsGet, dbAssetNames, dbAssetCreate, dbAssetUpdate, dbAssetDelete, objectAbsFor, ftsReconcile, readDocOrNull, docExists, sqlActive, rpcMethods: () => _rpcMethods, canvasUpdateNode, canvasGenerateNode };

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
      const userMessage = { role: 'user', content: [{ type: 'text', text: user }] };
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

    const methods = {
      async ping() { return { ok: true, version: VERSION }; },
      async llmOptions() { return listLlmOptions(); },
      async llmComplete(args) { return complete(args); },
      async updateCheck() { return updateCheck(); },
      async updateInstall() { return updateInstall(); },
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
      // IC-B4：FTS 存量孤儿一次性清理（幂等，可重复调；无 SQLite 时明确说不适用）
      async ftsReconcile() {
        if (!sqlActive()) return { ok: false, error: '当前不是 SQLite 存储模式，无 FTS 需要清理', applicable: false };
        return ftsReconcile(getDb());
      },
      /** IC-B2：删除项目时清理其目录下的 craft/（ArtCraft 后期产物）。
       *  客户端知道自己要删哪个项目，Host 按项目物理文件夹定位（与 projectDirGet 同一基准），
       *  只删 projects/<folder>/craft 这一个子目录——绝不碰项目镜像、其他项目、数据根其他内容。
       *  幂等：目录不存在也是成功；失败可见（removed=false + reason），不静默吞。 */
      /** 导演台场景规格：AI / 脚本写入，客户端打开导演台时自动套用（存 <projectDir>/craft/director-stage.json）。 */
      async directorStageSave(args) {
        const dir = await methods.projectDirGet({ projectId: args && args.projectId });
        if (!dir || !dir.ok) return { ok: false, error: (dir && dir.error) || '项目目录不可用' };
        const craftDir = path.join(dir.abs, 'craft');
        try { mkdirSync(craftDir, { recursive: true }); } catch { /* 交给写入报错 */ }
        const file = path.join(craftDir, 'director-stage.json');
        const spec = (args && args.spec) || null;
        if (!spec || typeof spec !== 'object') return { ok: false, error: '缺少 spec 对象' };
        const payload = { ok: true, savedAt: Date.now(), spec };
        try { writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8'); }
        catch (e) { return { ok: false, error: '写入失败: ' + String((e && e.message) || e) }; }
        return { ok: true, projectId: String(args.projectId), file, bytes: Buffer.byteLength(JSON.stringify(payload)) };
      },
      async directorStageLoad(args) {
        const dir = await methods.projectDirGet({ projectId: args && args.projectId });
        if (!dir || !dir.ok) return { ok: false, error: (dir && dir.error) || '项目目录不可用' };
        const file = path.join(dir.abs, 'craft', 'director-stage.json');
        if (!existsSync(file)) return { ok: true, found: false, file };
        try {
          const doc = JSON.parse(readFileSync(file, 'utf8'));
          return { ok: true, found: true, file, savedAt: doc.savedAt || null, spec: doc.spec || null };
        } catch (e) { return { ok: false, found: false, file, error: '读取失败: ' + String((e && e.message) || e) }; }
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
        const next = { ...cur, ...(patch.name !== undefined ? { name: String(patch.name).slice(0, 80) } : {}), ...(patch.category !== undefined ? { category: String(patch.category || 'general') } : {}) };
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
    };

    const toolDisposers = [];
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
            def.execute = async (args, exec) => stripUndefined(await inner(args, exec));
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
          async execute(args) {
            const kw = String((args && args.keyword) || '').toLowerCase();
            const list = projectsList().filter((p) => !kw || String(p.name).toLowerCase().includes(kw));
            const lines = [];
            for (const p of list) {
              const canvases = Array.isArray(p.canvases) ? p.canvases : [];
              const defTxt = p.defaultCanvasDeleted
                ? '默认画布已删除'
                : '默认画布「' + (p.defaultCanvasName || '默认画布') + '」canvasId=null';
              lines.push('- 「' + p.name + '」 id=' + p.id + ' · ' + defTxt + ' · ' + canvases.length + ' 个子画布 · ' + p.nodes.length + ' 节点 · 更新于 ' + new Date(p.updatedAt).toLocaleString());
              for (const n of p.nodes) lines.push('    · [' + n.type + '] ' + (n.label || '(未命名)') + ' id=' + n.id + ' status=' + n.status);
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
          async execute(args) {
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
            schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' }, assetId: { type: 'string' }, prompt: { type: 'string' }, ratio: { type: 'string' }, size: { type: 'string' }, duration: { type: 'number' }, resolution: { type: 'string' }, frameMode: { type: 'string' }, imageModel: { type: 'string' }, videoModel: { type: 'string' }, genWarn: { type: 'string' }, chainFrom: { type: 'string' }, seam: { type: 'object', properties: { ok: { type: 'boolean' }, sim: { type: 'number' }, thr: { type: 'number' }, note: { type: 'string' } } }, tailPickAssetId: { type: 'string' }, historyAssetIds: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } }, shots: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, duration: { type: 'number' }, visual: { type: 'string' }, motion: { type: 'string' }, tail: { type: 'string' }, cam: { type: 'string' }, start: { type: 'string' }, seg: { type: 'string' }, characters: { type: 'array', items: { type: 'string' } }, scene: { type: 'string' }, props: { type: 'array', items: { type: 'string' } } } } } }, required: ['ok', 'text'] },
            render: (args, value) => [{ type: 'text', text: String(value.text || '') }],
          },
          timeoutMs: 30000,
          async execute(args) {
            const s = await canvasNodeStatus(args);
            const lines = ['节点[' + s.type + ']「' + (s.label || s.nodeId) + '」', '状态: ' + s.status + (s.aiStatus && s.aiStatus !== 'idle' ? ' / ' + s.aiStatus : '')];
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
              prompt: s.prompt || undefined, ratio: s.ratio || undefined, size: s.size || undefined,
              duration: s.duration == null ? undefined : s.duration, resolution: s.resolution || undefined,
              frameMode: s.frameMode || undefined, imageModel: s.imageModel || undefined, videoModel: s.videoModel || undefined,
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
          description: '修改无限画布上**已有节点**的字段（改提示词、改比例/清晰度/时长/分辨率等参数）——"改节点"的唯一入口，改完不必删节点重建。可改字段：prompt（图片/视频节点的对话框提示词）、idea/output（剧本节点）、text（文本节点的正文）、script/requirement（分镜表的剧本来源与额外要求）、shots（分镜镜头清单，JSON 数组）、label（节点名）、ratio、size、duration、resolution、frameMode、count、imageModel、videoModel、model、cont（分镜表「分镜衔接」开关，默认 true；关掉后拆镜不写衔接字段、视频不自动续帧）。结构字段（id/type/坐标/宽高）不可改。改完用 canvas_generate_node 触发生成。**前提**：先用 canvas_node_status 读到当前内容，再只传要改的字段。**注意 shots 是整表替换**：只改一镜也要先把 canvas_node_status 返回的全部 shots 取回、改完再整体传回；否则其它镜的 tail/cam/seg 会被冲掉（服务端会按镜序兜底保留，但不要依赖它）。',
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
            return { ok: true, projectId: r.projectId, nodeId: r.nodeId, text: '🗑 已删除节点 ' + r.nodeId + '。' };
          },
        });
        reg({
          name: 'canvas_relayout',
          description: '一键重排画布节点布局（消除重叠）：按「行」排列——横向数据流决定列（文本→分镜表→视频→资产），竖向关系（衔接 prev / 首帧 frame）不参与分列；每行 = 一个横向连通组（如「场N文本 ↔ 场N分镜表」同行对齐），行高取行内最高节点、行间保留间距。节点重叠、或批量建点后布局混乱时调用。',
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
            return { ok: true, projectId: r.projectId, text: '✅ 已重排 ' + r.moved + ' 个节点（' + r.rows + ' 行，无重叠）。' };
          },
        });
        reg({
          name: 'canvas_director_stage',
          description: '3D 导演台（预演场景）的总控工具：用一段 JSON 规格直接生成/更新整场预演，无需手动搭场景。\n' +
            'action=apply：把 spec 写入项目并落盘（客户端打开导演台时自动套用；再点「导出视频」即得白模预演片）。\n' +
            'action=get：读回当前项目的规格。\n' +
            'action=help：返回规格 schema 与可用姿态/预设清单。\n' +
            'spec 结构：{ title, duration, env{preset,bg,ground,grid,exposure,tonemap}, ' +
            'characters[{name,pos:[x,y,z],rotY,h,pose,color,material{roughness,metallic,specular},path:[[x,z]...],pathFace,poseAnim[{t,pose}],loop,loopPeriod,keys[{t,pos,rotY}]}], ' +
            'props[{preset,pos,scale,color}], cameras[{name,pos,target,fov,keys[{t,pos,target}]}], shots[{camera,start,end}] }。\n' +
            'pose 取值见 action=help 的 poses；道具 preset 见 presets。坐标两维数组 [x,z] 自动补 y=0。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['apply', 'get', 'help', 'brief'], description: '操作类型' },
              brief: { type: 'string', description: '一句话描述（action=brief 时用，如「两人在巷子里打斗，8秒」）；会套用打斗/追逐/对话模板生成规格并落盘' },
              template: { type: 'string', enum: ['fight', 'chase', 'dialogue'], description: '强制指定模板（不传则按 brief 关键词自动判断）' },
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
            if (action === 'help') {
              const eng = await loadDirectorEngine();
              return {
                ok: true,
                text: '✅ 导演台规格说明\n' +
                  '· 姿态 id：none, arms_up, punch, kick, flip, fly(轻功), crouch(下蹲), fight, walk, run, jump, hit, fall, walk_a, walk_b, run_a, run_b\n' +
                  '· 道具 preset：box, sphere, cylinder, cone, plane, capsule, torus, pyramid, disc, arc\n' +
                  '· 循环动作：poseAnim 首尾 pose 相同即可循环（如 walk_a→walk_b→walk_a）\n' +
                  '· 路径：path 为二维地面点数组，物体沿路径运动并按切线自动转向（pathFace:false 关闭）\n' +
                  '· 角色一律使用资产库的真实关节人偶（assetId=xbot）：characters[].preset 可填 actors 列表里的体型，未填默认 m_standard',
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
              const spec2 = eng2.specFromBrief(brief, { template: args.template, duration: args.duration });
              const r4 = await methods.directorStageSave({ projectId: args.projectId, spec: spec2 });
              if (!r4.ok) throw new Error(r4.error || '保存失败');
              return {
                ok: true, projectId: String(args.projectId || ''), spec: spec2,
                text: '✅ 已按「' + (spec2.title || brief) + '」生成预演规格并写入项目（' + (spec2.characters || []).length + ' 角色 / ' + (spec2.cameras || []).length + ' 机位 / ' + (spec2.shots || []).length + ' 分镜 / ' + spec2.duration + 's）。打开或刷新 3D 导演台即可看到；点「导出视频」出片。',
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
          name: 'canvas_delete_project',
          description: '删除无限画布上的一个项目（含其全部节点）。用户明确要求删除项目、或清理误创建的空项目时使用；删除前请先用 canvas_list_projects 确认 id。',
          parameters: { type: 'object', properties: { projectId: { type: 'string', description: '项目 id' } }, required: ['projectId'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasDeleteProject(args);
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
          description: '写入项目设定集（世界观/核心设定、风格基调、角色/场景/道具）。默认按名称合并：同名更新、不存在则追加；mode="replace" 时条目整体替换。【设定集先行】先把世界观/风格/角色/场景/道具写进设定集，再生成剧本与参考图，保证跨镜跨集一致。',
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
                  style: { type: 'string', description: '风格基调（画风、年代、色调、质感）' },
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
          name: 'canvas_create_node',
          description: '在项目画布上新建指定类型的节点（image 图片节点 / video 视频节点 / storyboard 分镜表 / finalcut 成片 / script 剧本 / text 文本）。图片与视频是**合并节点**：有 assetId 就是已有素材（资产），空节点在画布上点开生成面板填写提示词后生成；旧类型名 image-gen / image-asset / video-gen / video-asset 仍可用，会被自动映射为 image / video。【分镜必须用 type:"storyboard" 的分镜表节点，绝不要用剧本节点装分镜】。【工作流铁律】实际生成由节点完成：你只负责写提示词、连线（connectFrom）、canvas_run_node 触发，不要把成稿直接填进 output。分镜表用 connectFrom 连到上游剧本节点（内容来自连线，不要复制剧本全文）；image/video 没有上游提示词时才在 prompt 里写内容，有上游时靠连线取。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              canvasId: { type: 'string', description: '可选：画布 id（项目下的子画布；缺省 = 项目默认画布）' },
              type: { type: 'string', enum: ['script', 'text', 'image', 'video', 'storyboard', 'finalcut', 'image-gen', 'image-asset', 'video-gen', 'video-asset'], description: '节点类型（image/video 为合并类型；旧名 image-gen 等仍接受并自动映射）' },
              name: { type: 'string', description: '节点名字（建议填写，如"角色-陈拾 参考图"）' },
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
              if (raw.length > 4e6) throw new Error('请求过大');
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
