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
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'infinite-canvas', 'config.json');

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

/** 读取 npm registry 上 latest dist-tag 的版本号。 */
async function npmLatestVersion() {
  const res = await fetch(NPM_LATEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('npm registry 返回 HTTP ' + res.status);
  const meta = await res.json();
  if (!meta || typeof meta.version !== 'string') throw new Error('npm registry 响应缺少 version 字段');
  return meta.version;
}

/** 语义化版本比较：a<b → -1，a>b → 1，相等或无法解析 → 0；prerelease 低于同号正式版。 */
function cmpVer(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
    return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ?? null } : null;
  };
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
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
  const behind = cmpVer(runningVersion, remoteVersion) < 0 ? 1 : 0;
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
  if (cmpVer(runningVersion, latest) >= 0) {
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

export const inject = ['webServer'];

// 仅供诊断 / 自动化测试（不属于 RPC 面，运行时行为不受影响）
export const _internals = { updateCheck, updateInstall, npmLatestVersion, cmpVer, findPnpm, getProfileDir: () => PROFILE_DIR, getVersion: () => VERSION, dataRoot, safeJoin, mimeOf, getIcConfigPath: () => CONFIG_PATH };

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
      let text = '';
      const stream = service.stream({
        provider: resolved.provider,
        model: resolved.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: String(want.system ?? '') }] },
          { role: 'user', content: [{ type: 'text', text: String(want.user ?? '') }] },
        ],
        temperature: typeof want.temperature === 'number' ? want.temperature : 0.7,
        maxTokens: typeof want.maxTokens === 'number' ? want.maxTokens : 4000,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
      }
      return { text, provider: resolved.provider, model: resolved.model };
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
        const root = path.resolve(raw);
        if (!path.isAbsolute(root)) throw new Error('需要绝对路径（如 D:\\canvas-data）');
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
        try { spawn(open, [root], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打开失败不阻塞 */ }
        return { ok: true, dataRoot: root };
      },
      async pickFolder() {
        const r = await pickFolderDialog();
        return r; // { ok, path } | { ok:false, cancelled } | { ok:false, unsupported }
      },
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
              if (raw.length > 2e6) throw new Error('请求过大');
            }
            const { method, args } = JSON.parse(raw);
            const fn = methods[method];
            if (!fn) throw new Error('未知操作: ' + method);
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
            const root = dataRoot();
            if (!root) throw new Error('未设置数据根目录');
            const u = new URL(req.url, 'http://localhost');
            const { abs, clean } = safeJoin(root, u.searchParams.get('rel') || '');
            mkdirSync(path.dirname(abs), { recursive: true });
            let size = 0;
            await new Promise((resolve, reject) => {
              const ws = createWriteStream(abs);
              req.on('data', (c) => { size += c.length; });
              req.on('error', reject);
              ws.on('error', reject);
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
              createReadStream(abs, { start, end }).pipe(res);
            } else {
              res.setHeader('content-length', String(st.size));
              createReadStream(abs).pipe(res);
            }
          } catch (e) {
            res.statusCode = 400;
            res.end(String((e && e.message) || e));
          }
        },
      }),
    ];
    return () => { for (const off of registrations) { try { if (off) off(); } catch { /* 忽略 */ } } };
  }, `${NAME}: api routes`);
}
