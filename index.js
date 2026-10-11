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
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
/** 设定集字段规范化（世界观/风格 + 角色/场景/道具条目）。 */
function normalizeBible(raw) {
  const b = (raw && typeof raw === 'object') ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v : [])
    .map((x) => ({ name: String((x && x.name) || '').slice(0, 60), desc: String((x && x.desc) || '').slice(0, 2000) }))
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
};
function mimeOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? (MIME_BY_EXT[m[1].toLowerCase()] || 'application/octet-stream') : 'application/octet-stream';
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
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('非法项目 id');
  return path.join(PROJECTS_DIR, String(id) + '.json');
}
function projectsList() {
  let files = [];
  try { files = readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const list = [];
  for (const f of files) {
    const id = f.slice(0, -5);
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
        id: n.id, type: n.type, label: (n.data && n.data.label) || '',
        status: (n.data && n.data.status) || 'idle',
      }));
      list.push({ id: d.id || id, name: d.name || id, createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0, source: d.source || 'app', nodeIds: Object.keys(d.nodes || {}), nodes, tombstones: d.tombstones || [], bibleUpdatedAt: d.bibleUpdatedAt || 0 });
    } catch { /* 单文件损坏跳过 */ }
  }
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
async function projectsPut(args) {
  const id = String((args && args.id) || '');
  const f = projectFile(id);
  const doc = (args && args.doc) || {};
  let prev = {};
  try { prev = JSON.parse(readFileSync(f, 'utf8')); } catch { /* 新项目 */ }
  // 墓碑：对话删除的节点 + 客户端本地删除的节点（客户端删除时也会写入 tombstones）
  const tombstones = [...new Set([...(prev.tombstones || []), ...((doc && doc.tombstones) || [])])].slice(-200);
  const dead = new Set(tombstones);
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
  const edgeOk = (e) => e && merged[e.fromNode] && merged[e.toNode];
  const clientEdges = (doc.edges || []).filter(edgeOk);
  const prevEdges = (prev.edges || []).filter(edgeOk);
  const edgeKey = (e) => e.fromNode + '>' + (e.fromPort || '') + '>' + e.toNode + '>' + (e.toPort || '');
  const seen = new Set(clientEdges.map(edgeKey));
  const edges = clientEdges.concat(prevEdges.filter((e) => !seen.has(edgeKey(e))));
  const out = {
    id,
    name: String((args && args.name) || prev.name || id).slice(0, 80),
    createdAt: prev.createdAt || (doc && doc.createdAt) || Date.now(),
    updatedAt: Date.now(),
    source: prev.source || 'app',
    nodes: merged,
    edges,
    view: doc.view || prev.view || { x: 60, y: 40, scale: 1 },
    tombstones,
  };
  // 设定集（世界观/风格/角色/场景/道具）：随文档一起同步，对话侧可读写
  if (doc.bible !== undefined) {
    out.bible = normalizeBible(doc.bible);
    out.bibleUpdatedAt = Date.now();
  } else if (prev.bible !== undefined) {
    out.bible = prev.bible;
    out.bibleUpdatedAt = prev.bibleUpdatedAt || 0;
  }
  mkdirSync(PROJECTS_DIR, { recursive: true });
  writeFileSync(f, JSON.stringify(out, null, 1), 'utf8');
  return { ok: true, id, updatedAt: out.updatedAt };
}
async function projectsGet(args) {
  return readDoc(String((args && args.id) || ''));
}
async function projectsDelete(args) {
  try { unlinkSync(projectFile(args && args.id)); } catch { /* 已不存在视为成功 */ }
  return { ok: true };
}
async function projectsSync() {
  const cfg = readIcConfig();
  const openRequest = (cfg.ui && cfg.ui.openRequest) || null;
  const runRequest = (cfg.ui && cfg.ui.runRequest) || null;
  const deletedProjects = (cfg.ui && cfg.ui.deletedProjects) || null;
  if (openRequest || runRequest || deletedProjects) {
    cfg.ui = { ...(cfg.ui || {}), openRequest: null, runRequest: null, deletedProjects: null };
    writeIcConfig(cfg);
  }
  return { projects: projectsList(), openRequest, runRequest, deletedProjects };
}
/** 节点默认名：取内容首行前 18 字，保证对话创建的节点可识别。 */
function defaultLabel(text) {
  const line = String(text || '').trim().split(/\r?\n/)[0] || '';
  return line.length > 18 ? line.slice(0, 18) + '…' : (line || '未命名');
}
/** 构造与客户端 newNode() 完全一致的节点（形状不一致会导致渲染异常）。 */
function agentNode(kind, text, x, y, label) {
  const id = 'na' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const isText = kind === 'text';
  const data = isText
    ? { status: 'idle', error: null, text: String(text ?? '') }
    : { status: 'idle', error: null, idea: String(text ?? ''), output: '', aiStatus: 'idle', aiError: null };
  if (label) data.label = String(label).slice(0, 40);
  return { id, type: isText ? 'text' : 'script', x, y, w: isText ? 260 : 320, h: 100, data };
}
function nextNodePos(doc) {
  let maxX = 0;
  let maxY = 40;
  for (const n of Object.values(doc.nodes || {})) { if ((n.x || 0) + (n.w || 240) > maxX) { maxX = (n.x || 0) + (n.w || 240); maxY = n.y || 40; } }
  return { x: maxX + 60, y: maxY };
}
// ---------- 内置技能（操作规程 + 创作方法论，约束并提升对话的画布创作）----------
// canvas-studio＝操作硬约束；canvas-craft＝剧本/分镜/提示词创作方法论
const SKILL_NAMES = ['canvas-studio', 'canvas-craft'];
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
  const f = projectFile(id);
  const doc = readDoc(id);
  const text = String((args && args.text) || '');
  const target = (args && args.target) === 'output' ? 'output' : 'idea';
  const nodeId = String((args && args.nodeId) || '');
  const name = args && args.name ? String(args.name).slice(0, 40) : '';
  const idea = args && args.idea !== undefined ? String(args.idea) : null;
  const overwrite = args && args.overwrite === true;
  const writeInto = (node) => {
    if (node.type === 'text') node.data.text = text;
    else if (target === 'output') { node.data.output = text; node.data.aiStatus = 'idle'; node.data.aiError = null; }
    else node.data.idea = text;
    if (idea !== null && node.type === 'script') node.data.idea = idea;
    if (name) node.data.label = name;
  };
  const save = () => { doc.updatedAt = Date.now(); writeIcDoc(id, doc); };
  if (nodeId) {
    const node = doc.nodes[nodeId];
    if (!node) throw new Error('节点不存在: ' + nodeId);
    if (target === 'output' && !overwrite && String((node.data && node.data.output) || '').trim() && String((node.data && node.data.output) || '') !== text) {
      throw new Error('节点「' + ((node.data && node.data.label) || nodeId) + '」已有成稿，覆盖会丢失原文；确认要覆盖请传 overwrite:true，或换个 name 新建节点。');
    }
    writeInto(node);
    save();
    return { ok: true, projectId: id, nodeId, updated: true, label: node.data.label || '' };
  }
  if ((args && args.kind) === 'text') {
    const pos = nextNodePos(doc);
    const n = agentNode('text', text, pos.x, pos.y, name || defaultLabel(text));
    doc.nodes[n.id] = n;
    save();
    return { ok: true, projectId: id, nodeId: n.id, label: n.data.label || '' };
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
    if (target === 'output' && !overwrite && String((reuse.data && reuse.data.output) || '').trim()) {
      throw new Error('剧本节点「' + ((reuse.data && reuse.data.label) || reuse.id) + '」已有成稿：传 overwrite:true 覆盖，或给 name 新建一节。');
    }
    writeInto(reuse);
    save();
    return { ok: true, projectId: id, nodeId: reuse.id, updated: true, reused: true, label: reuse.data.label || '' };
  }
  const pos = nextNodePos(doc);
  const n = agentNode('script', target === 'output' ? '' : text, pos.x, pos.y, name || defaultLabel(text));
  if (target === 'output') n.data.output = text;
  if (idea !== null) n.data.idea = idea;
  doc.nodes[n.id] = n;
  save();
  return { ok: true, projectId: id, nodeId: n.id, label: n.data.label || '' };
}
/** 读取项目文档：把"文件不存在/内容损坏"变成用户和模型都读得懂的报错（不泄漏绝对路径）。 */
function readDoc(id) {
  const f = projectFile(id);
  let raw;
  try {
    raw = readFileSync(f, 'utf8');
  } catch {
    throw new Error('项目不存在：' + id + '（先用 canvas_list_projects 查看可用项目 id）');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('项目文件损坏，无法解析：' + id + '（可考虑重建该项目）');
  }
}
/** 原子写项目文档：先写临时文件再改名，避免半写导致项目"消失"。 */
function writeIcDoc(id, doc) {
  const f = projectFile(id);
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8');
  renameSync(tmp, f);
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
      .map((x) => ({ name: String((x && x.name) || ''), desc: String((x && x.desc) || '') }))
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
  writeIcDoc(id, doc);
  return { projectId: id, bible: doc.bible, bibleUpdatedAt: doc.bibleUpdatedAt };
}
/** 通用建节点（供对话建角色/场景/道具参考图等）；支持 script/text/image-gen/video-gen/storyboard/finalcut。 */
function canvasCreateNode(args) {
  const id = String((args && args.projectId) || '');
  const f = projectFile(id);
  const doc = readDoc(id);
  const type = String((args && args.type) || 'text');
  if (!['script', 'text', 'image-gen', 'video-gen', 'storyboard', 'finalcut'].includes(type)) throw new Error('不支持的节点类型: ' + type);
  const label = args && args.name ? String(args.name).slice(0, 40) : '';
  const prompt = String((args && args.prompt) || '');
  const pos = nextNodePos(doc);
  let node;
  if (type === 'image-gen') {
    node = agentNode('text', '', pos.x, pos.y, label || '图片生成');
    node.type = 'image-gen';
    node.w = 280;
    node.data = { ...node.data, status: 'idle', error: null, prompt, assetId: null, demo: false, size: (args && args.size) || '2K', ratio: (args && args.ratio) || '16:9' };
  } else if (type === 'video-gen') {
    node = agentNode('text', '', pos.x, pos.y, label || '视频生成');
    node.type = 'video-gen';
    node.w = 280;
    node.data = { ...node.data, status: 'idle', error: null, prompt, assetId: null, demo: false, duration: Number(args && args.duration) || 5, resolution: (args && args.resolution) || '720P', ratio: (args && args.ratio) || '16:9' };
  } else if (type === 'storyboard') {
    node = agentNode('text', '', pos.x, pos.y, label || '分镜表');
    node.type = 'storyboard';
    node.w = 360;
    node.data = { ...node.data, status: 'idle', error: null, script: prompt, requirement: String((args && args.requirement) || ''), count: Number(args && args.count) || 6, shots: [], aiStatus: 'idle', aiError: null, warnings: [] };
  } else if (type === 'finalcut') {
    node = agentNode('text', '', pos.x, pos.y, label || '成片');
    node.type = 'finalcut';
    node.w = 300;
    node.data = { ...node.data, status: 'idle', error: null, resolution: (args && args.resolution) || '720P', ratio: (args && args.ratio) || '16:9', transition: 'none', progress: null, assetId: null, subs: {}, keepAudio: true };
  } else if (type === 'script') {
    node = agentNode('script', prompt, pos.x, pos.y, label || defaultLabel(prompt));
  } else {
    node = agentNode('text', prompt, pos.x, pos.y, label || defaultLabel(prompt));
  }
  doc.nodes[node.id] = node;
  doc.updatedAt = Date.now();
  writeIcDoc(id, doc);
  return { ok: true, projectId: id, nodeId: node.id, type: node.type, label: (node.data && node.data.label) || '' };
}

async function canvasDeleteProject(args) {
  const id = String((args && args.projectId) || '');
  const f = projectFile(id);
  let name = id;
  try { name = JSON.parse(readFileSync(f, 'utf8')).name || id; } catch { /* 本来就不存在 */ }
  try { unlinkSync(f); } catch { /* 已删除 */ }
  // 通知客户端把这个项目也从本地删掉，否则下次推送会把它复活
  const cfg = readIcConfig();
  const prev = (cfg.ui && cfg.ui.deletedProjects) || [];
  cfg.ui = { ...(cfg.ui || {}), deletedProjects: [...new Set([...prev, id])].slice(-50) };
  writeIcConfig(cfg);
  return { ok: true, projectId: id, name };
}
async function canvasDeleteNode(args) {
  const id = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const f = projectFile(id);
  const doc = readDoc(id);
  if (!doc.nodes[nodeId]) throw new Error('节点不存在: ' + nodeId);
  delete doc.nodes[nodeId];
  doc.edges = (doc.edges || []).filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId);
  doc.tombstones = [...new Set([...(doc.tombstones || []), nodeId])].slice(-100);
  doc.updatedAt = Date.now();
  writeIcDoc(id, doc);
  return { ok: true, projectId: id, nodeId };
}
/** 运行节点：写一次性请求，画布客户端轮询消费后用画布内配置的模型/接口真实执行。 */
async function canvasRunNode(args) {
  const pid = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const doc = readDoc(pid);
  const node = doc.nodes[nodeId];
  if (!node) throw new Error('节点不存在: ' + nodeId);
  const cfg = readIcConfig();
  cfg.ui = { ...(cfg.ui || {}), runRequest: { projectId: pid, nodeId, at: Date.now() } };
  writeIcConfig(cfg);
  return { ok: true, projectId: pid, nodeId, type: node.type, label: (node.data && node.data.label) || '' };
}
/** 读取节点运行状态与产物（画布执行完成后会把结果推回 Host 文档）。 */
async function canvasNodeStatus(args) {
  const pid = String((args && args.projectId) || '');
  const nodeId = String((args && args.nodeId) || '');
  const doc = readDoc(pid);
  const n = doc.nodes[nodeId];
  if (!n) throw new Error('节点不存在: ' + nodeId);
  return {
    projectId: pid, nodeId, type: n.type, label: (n.data && n.data.label) || '',
    status: (n.data && n.data.status) || 'idle',
    aiStatus: (n.data && n.data.aiStatus) || 'idle',
    error: (n.data && (n.data.error || n.data.aiError)) || null,
    output: String((n.data && n.data.output) || '').slice(0, 6000),
    idea: String((n.data && n.data.idea) || '').slice(0, 2000),
    assetId: (n.data && n.data.assetId) || null,
  };
}
async function canvasOpen(args) {
  const pid = String((args && args.projectId) || '');
  if (pid) {
    const f = projectFile(pid); // 校验 id 合法性
    // 项目必须真实存在：否则工具回"✅ 已打开"，而前端因为找不到项目什么都不做（假成功）
    if (!existsSync(f)) throw new Error('项目不存在：' + pid + '（先用 canvas_list_projects 查看可用项目 id）');
  }
  const cfg = readIcConfig();
  cfg.ui = { ...(cfg.ui || {}), openRequest: { projectId: pid || null, at: Date.now() } };
  writeIcConfig(cfg);
  return { ok: true, projectId: pid || null };
}

/**
 * 本地 HTTP 面的"来源校验"（不是鉴权：没有登录、没有密码、没有 token，你无感）。
 * 目的：阻止**其他网站**在你浏览器里朝本机端口发请求触发副作用
 * （跨站页面能用简单请求打到 127.0.0.1，读不到响应但安装/删除/写文件已经发生）。
 * 放行规则：Origin 的主机必须与请求的 Host 一致（即同源）——
 * 不论你是用 127.0.0.1、localhost、局域网 IP 还是反代域名访问，都照常工作；
 * 无 Origin 的非浏览器调用（curl 等）本来就不受浏览器 CSRF 影响，也放行。
 * 返回错误字符串表示拒绝，返回 null 表示放行。
 */
function sameOriginGuard(req) {
  const origin = String(req.headers.origin || '');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { return '来源不合法'; }
    const self = String(req.headers.host || '');
    if (self && host !== self) return '拒绝跨站请求';
  }
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return '拒绝跨站请求';
  return null;
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
export const _internals = { updateCheck, updateInstall, npmLatestVersion, cmpVer, findPnpm, getProfileDir: () => PROFILE_DIR, getVersion: () => VERSION, dataRoot, safeJoin, mimeOf, pipeFile, getIcConfigPath: () => CONFIG_PATH, canvasCreateProject, canvasWriteNode, canvasDeleteProject, canvasDeleteNode, canvasRunNode, canvasNodeStatus, canvasGetBible, canvasUpdateBible, canvasCreateNode, canvasOpen, projectsList, projectsPut, projectsGet, projectsDelete, projectsSync };

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

    async function complete(args) {
      const service = llm();
      if (!service) throw new Error('llm 服务不可用');
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
      const run = async (options) => {
        const kinds = [];
        let text = '';
        try {
          for await (const chunk of service.stream(options)) {
            const type = chunk && chunk.type;
            kinds.push(type || 'unknown');
            if ((type === 'text-delta' || type === 'text') && typeof chunk.text === 'string') text += chunk.text;
          }
          return { text, kinds, error: null };
        } catch (e) {
          return { text: '', kinds, error: String((e && e.message) || e) };
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
      const primary = await run(base);
      if (primary.text.trim()) return { text: primary.text, provider: resolved.provider, model: resolved.model, variant: 'system' };
      // 2) 推理模型：只出思考不出正文 → 降低推理强度重试（不擅自放大/改写输出上限）
      if (primary.kinds.includes('reasoning-delta')) {
        const attempts = [
          { label: '降低推理强度', options: { ...base, reasoningEffort: 'low' } },
          { label: '降低推理强度+老式信封', options: { ...base, reasoningEffort: 'low', messages: system ? [{ role: 'system', content: [{ type: 'text', text: system }] }, userMessage] : [userMessage], system: undefined } },
        ];
        const tried = [];
        for (const a of attempts) {
          const opts = { ...a.options };
          if (opts.system === undefined) delete opts.system;
          const r = await run(opts);
          if (r.text.trim()) return { text: r.text, provider: resolved.provider, model: resolved.model, variant: 'reasoning-retry' };
          tried.push(a.label + ': ' + histogram(r.kinds) + (r.error ? ' / 错误: ' + r.error : ''));
        }
        throw new Error(
          '该模型只输出了思考内容、没有正文（provider=' + resolved.provider + ' model=' + resolved.model + '）。'
          + '插件没有覆盖任何参数，输出上限按你在 Harness 里的配置生效；若仍失败，请检查该模型在 Harness 里的输出上限配置，'
          + '或改用非推理模型（如 deepseek-flash）。'
          + '（chunk 统计 → 首次: ' + histogram(primary.kinds) + '；重试: ' + tried.join(' | ') + '）',
        );
      }
      // 3) 回退：老式写法（system 作为 messages 首条，不带附加字段）
      const fallback = await run({
        provider: resolved.provider,
        model: resolved.model,
        messages: system ? [{ role: 'system', content: [{ type: 'text', text: system }] }, userMessage] : [userMessage],
        ...tuned,
      });
      if (fallback.text.trim()) return { text: fallback.text, provider: resolved.provider, model: resolved.model, variant: 'system-in-messages' };
      throw new Error(
        '模型未返回文本（provider=' + resolved.provider + ' model=' + resolved.model
        + '；chunk 统计 → 规范信封: ' + histogram(primary.kinds) + ' / 回退: ' + histogram(fallback.kinds)
        + (primary.error ? '；规范信封错误: ' + primary.error : '')
        + (fallback.error ? '；回退错误: ' + fallback.error : '')
        + '）。插件未覆盖任何生成参数；请检查该模型在 Harness 中的可用性与输出上限设置。',
      );
    }

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
        return { dataRoot: root, exists, configPath: CONFIG_PATH };
      },
      async dataRootSet(args) {
        const raw = String((args && args.root) ?? '').trim();
        if (!raw) throw new Error('需要数据根目录路径');
        // 必须在 resolve 之前判绝对路径：resolve 之后恒为绝对路径，检查就成了死代码，
        // 相对路径会静默落到应用 cwd（升级即丢数据）
        if (!path.isAbsolute(raw)) throw new Error('需要绝对路径（如 D:\\canvas-data）');
        const root = path.resolve(raw);
        mkdirSync(root, { recursive: true });
        const cfg = readIcConfig();
        cfg.dataRoot = root;
        writeIcConfig(cfg);
        return { ok: true, dataRoot: root };
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
      async assetDelete(args) {
        const root = dataRoot();
        if (!root) throw new Error('未设置数据根目录');
        const { abs } = safeJoin(root, (args && args.rel) || '');
        try { unlinkSync(abs); } catch { /* 已不存在视为成功 */ }
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
        const reg = (def) => { try { toolDisposers.push(ctx.tools.register(def)); } catch { /* 单个工具失败不阻塞其余 */ } };
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
          description: '列出无限画布的项目及其节点（节点 id/类型/名称/状态）。用户提到画布项目、想看有哪些项目、或要指定某个项目/节点时使用。',
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
              lines.push('- 「' + p.name + '」 id=' + p.id + ' · ' + p.nodes.length + ' 节点 · 更新于 ' + new Date(p.updatedAt).toLocaleString());
              for (const n of p.nodes) lines.push('    · [' + n.type + '] ' + (n.label || '(未命名)') + ' id=' + n.id + ' status=' + n.status);
            }
            const text = lines.length ? ('共 ' + list.length + ' 个项目：\n' + lines.join('\n')) : '画布上还没有项目。可调用 canvas_create_project 创建。';
            return { count: list.length, text };
          },
        });
        reg({
          name: 'canvas_create_project',
          description: '在无限画布上创建一个新项目（可同时写好第一个剧本节点）。【硬约束】调用前必须先 canvas_list_projects 查重；同名项目会被自动复用并提示，绝不要为"重试"或为每个节点重复创建项目。剧本节点必须 idea（创作意图）+ output（剧本成稿）同属一个节点：创作意图填 scriptText，成稿填 scriptOutput，用 nodeName 命名。',
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
          description: '写入无限画布的项目内容。【硬约束】绝不要为了加节点而新建项目——一律指定已有 projectId。剧本节点的 idea（创作意图）与 output（剧本成稿）必须在同一个节点里。复用规则：给 name 且能匹配已有节点名 → 更新该节点；给 name 但匹配不到 → **新建节点**（写新一集/新一节时就这样用）；不给 name → 只会复用"有意图没成稿"的剧本节点补全。已写成稿的节点默认拒绝覆盖，确认要覆盖请传 overwrite:true（否则报错而不是静默吃掉稿件）。target：idea=提示词（默认），output=成稿。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id（来自 canvas_list_projects 或 canvas_create_project）' },
              text: { type: 'string', description: '要写入的内容（按 target 决定写 idea 还是 output）' },
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
          description: '查询画布节点的运行状态与产物（状态、错误、剧本成稿内容、生成出的资产 id）。用于确认 canvas_run_node 是否完成。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              nodeId: { type: 'string', description: '节点 id' },
            },
            required: ['projectId', 'nodeId'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, status: { type: 'string' }, assetId: { type: 'string' } }, required: ['ok', 'text'] },
            render: (args, value) => [{ type: 'text', text: String(value.text || '') }],
          },
          timeoutMs: 30000,
          async execute(args) {
            const s = await canvasNodeStatus(args);
            const lines = ['节点[' + s.type + ']「' + (s.label || s.nodeId) + '」', '状态: ' + s.status + (s.aiStatus && s.aiStatus !== 'idle' ? ' / ' + s.aiStatus : '')];
            if (s.error) lines.push('错误: ' + s.error);
            if (s.assetId) lines.push('产物资产: ' + s.assetId);
            if (s.idea) lines.push('提示词: ' + s.idea.slice(0, 400));
            if (s.output) lines.push('成稿:\n' + s.output);
            return { ok: true, status: s.status, assetId: s.assetId || undefined, text: lines.join('\n') };
          },
        });
        reg({
          name: 'canvas_delete_node',
          description: '删除无限画布项目中的一个节点（连同它的连线）。用于清理误创建的节点。',
          parameters: {
            type: 'object',
            properties: { projectId: { type: 'string', description: '项目 id' }, nodeId: { type: 'string', description: '节点 id' } },
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
          name: 'canvas_delete_project',
          description: '删除无限画布上的一个项目（含其全部节点）。用户明确要求删除项目、或清理误创建的空项目时使用；删除前请先用 canvas_list_projects 确认 id。',
          parameters: { type: 'object', properties: { projectId: { type: 'string', description: '项目 id' } }, required: ['projectId'], additionalProperties: false },
          output: textOutput,
          timeoutMs: 30000,
          async execute(args) {
            const r = await canvasDeleteProject(args);
            return { ok: true, projectId: r.projectId, text: '🗑 已删除项目「' + r.name + '」（id=' + r.projectId + '）。' };
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
          description: '在项目画布上新建指定类型的节点（image-gen 图片生成 / video-gen 视频生成 / storyboard 分镜表 / finalcut 成片 / script 剧本 / text 文本），可同时写入提示词。用于按设定集生成角色/场景/道具参考图：先用 canvas_get_bible 取设定，再为每个角色/场景/道具建一个 image-gen 节点（name 用规范命名如「角色-张山 多视图」，prompt 用 @张山 引用设定集条目）并 canvas_run_node 触发。',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: '项目 id' },
              type: { type: 'string', enum: ['script', 'text', 'image-gen', 'video-gen', 'storyboard', 'finalcut'], description: '节点类型' },
              name: { type: 'string', description: '节点名字（建议填写，如"角色-陈拾 参考图"）' },
              prompt: { type: 'string', description: '提示词（图片/视频用画面提示词；剧本用创作意图；文本用正文）' },
              size: { type: 'string', description: '可选：图片清晰度 1K/2K/4K' },
              ratio: { type: 'string', description: '可选：比例，如 16:9 / 9:16 / 1:1' },
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
            return { ok: true, projectId: r.projectId, nodeId: r.nodeId, label: r.label || undefined, text: '✅ 已新建[' + r.type + ']节点「' + (r.label || r.nodeId) + '」（id=' + r.nodeId + '）。可用 canvas_run_node 触发执行。' };
          },
        });
        reg({
          name: 'canvas_open',
          description: '打开无限画布页面并跳到指定项目（画布侧会在几秒内自动切换）。用户想查看/编辑画布时使用。',
          parameters: { type: 'object', properties: { projectId: { type: 'string', description: '要打开的项目 id（缺省只打开画布页）' } }, additionalProperties: false },
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
            // 同源 + JSON 内容类型校验：阻断恶意网页用"简单请求"（text/plain，无预检）
            // 直接打本地端口触发 updateInstall / dataRootSet / projectsDelete 等副作用
            const guard = sameOriginGuard(req);
            if (guard) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: guard }));
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
        path: `/${NAME}/api/asset`,
        async handler(req, res) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          try {
            if (req.method !== 'POST' && req.method !== 'PUT') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: '仅接受 POST/PUT' }));
              return;
            }
            // 同源护栏：该路由能往数据根目录任意写文件，必须只接受 DSH 自身页面
            const guard = sameOriginGuard(req);
            if (guard) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: guard }));
              return;
            }
            const root = dataRoot();
            if (!root) throw new Error('未设置数据根目录');
            const u = new URL(req.url, 'http://localhost');
            const { abs, clean } = safeJoin(root, u.searchParams.get('rel') || '');
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
      ctx.webServer.register({
        kind: 'exact',
        path: `/${NAME}/api/file`,
        async handler(req, res) {
          try {
            if (req.method !== 'GET') { res.statusCode = 405; res.end('仅接受 GET'); return; }
            const root = dataRoot();
            if (!root) { res.statusCode = 404; res.end('未设置数据根目录'); return; }
            const u = new URL(req.url, 'http://localhost');
            const { abs } = safeJoin(root, u.searchParams.get('rel') || '');
            let st;
            try { st = statSync(abs); } catch { res.statusCode = 404; res.end('not found'); return; }
            if (!st.isFile()) { res.statusCode = 404; res.end('not found'); return; }
            res.setHeader('content-type', mimeOf(abs));
            // SVG 同源内联会在 DSH 源下执行脚本（数据目录内容可由上传写入）→ 强制下载而非内联
            if (/\.svg$/i.test(abs)) res.setHeader('content-disposition', 'attachment');
            res.setHeader('accept-ranges', 'bytes');
            res.setHeader('cache-control', 'no-cache');
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
    ];
    return () => {
      for (const off of registrations) { try { if (off) off(); } catch { /* 忽略 */ } }
      for (const d of toolDisposers) { try { d(); } catch { /* 忽略 */ } }
    };
  }, `${NAME}: api routes`);
}
