#!/usr/bin/env node
/**
 * qoder-plugin 打包契约测试（dev-only，不随包发布）。需求：task-7-brief.md Step 1 断言清单。
 *
 * 流程：测试内 spawn `node adapters/scripts/build-qoder.mjs` 构建产物 → Expand-Archive（PowerShell
 * spawn）解包到 os 临时目录 → 逐条断言。全程不触碰 ~/.qoder-cn（注册延后 Task 11）。
 *
 *  1) 产物存在：adapters/dist/dsh-infinite-canvas-qoder-0.3.1.zip，大小 > 50KB
 *  2) ZIP 层布局（tar -tf）：ZIP 根直接含 .qoder-plugin/plugin.json（官方规范）+ .mcp.json + dist/*
 *  3) 解包目录树：.qoder-plugin/plugin.json、skills/canvas/SKILL.md、.mcp.json、
 *     dist/{canvas-mcp,canvas-web,model-bridge,llm-channel,host-adapter}.cjs、
 *     dist/core/index.js（client.js **随包**——0.3.0 Task 14 回归：canvas-web 壳经 /api/client.js
 *     装载的浏览器 UI 资产；Task 7 的「死重剔除」勘误已被实证推翻，正向断言防再丢），
 *     另加 dist/core/package.json、dist/core/assets/canvas-director/manifest.json（§4 RUNTIME_FILES）
 *     与 dist/vendor/react.production.min.js（Task 14 壳静态资产）
 *  4) plugin.json / .mcp.json JSON.parse 通过且字段逐字匹配 brief（键序与值全等）
 *  5) SKILL.md frontmatter 含 name: canvas（YAML 头），且 description 非空
 *  6) 全包文本扫描无密钥形状 sk-（红线）。勘误：brief 原文「无 sk-」按字面扫描对良性子串脆弱
 *     （如 model-bridge 脱敏正则源码本身、前端 CSS 类名的 'sk-' 字符片段），
 *     故按密钥形状 /sk-[A-Za-z0-9_-]{8,}/ 扫描（与 adapters/shared/model-bridge.cjs KEY_RE 同口径）
 *  7) 数据根冒烟：spawn 解包产物 dist/canvas-web.cjs --port <随机>（env DSH_IC_HOME 指临时目录
 *     隔离，绝不写真实用户目录）→ 轮询 GET / → 200 且含面板挂载点特征串 → 数据根落在
 *     DSH_IC_HOME（<home>/projects 已建）→ kill 子进程（证明解包产物可运行 + 缺省 --core-dir
 *     发布布局自解析 + 数据根新缺省生效）
 *
 * 收尾：删解包目录/数据根临时目录、杀子进程，端口不残留。
 * 运行：node scripts/test-adapters-qoder-pkg.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = path.join(ROOT, 'adapters', 'scripts', 'build-qoder.mjs');
const OUT_ZIP = path.join(ROOT, 'adapters', 'dist', 'dsh-infinite-canvas-qoder-0.3.1.zip');
const PANEL_MARK = 'id="infinite-canvas-root"'; // 面板挂载点特征子串（canvas-web.cjs 自备面板页）
const KEY_RE = /sk-[A-Za-z0-9_-]{8,}/g;         // 密钥形状（与 model-bridge.cjs KEY_RE 同口径）

// brief 逐字产物：plugin.json（键序与值全等才通过——壳契约冻结）
const PLUGIN_JSON_VERBATIM = {
  name: 'dsh-infinite-canvas',
  displayName: '无限画布',
  version: '0.3.1',
  description: '无限画布——可视化创作工作台（剧本/分镜/图片/视频节点编排）',
  author: { name: 'ninkch' },
  skills: './skills/',
  mcpServers: './.mcp.json',
};
// brief 逐字产物：.mcp.json
const MCP_JSON_VERBATIM = {
  mcpServers: {
    'dsh-infinite-canvas': {
      command: '${QODER_NODE_RUNTIME}',
      args: ['${QODER_PLUGIN_ROOT}/dist/canvas-mcp.cjs'],
      timeout: 120000,
    },
  },
};
// brief Step 1 断言清单的目录树（相对解包根）+ §4 RUNTIME_FILES 补充项
const REQUIRED_TREE = [
  '.qoder-plugin/plugin.json',
  'skills/canvas/SKILL.md',
  '.mcp.json',
  'dist/canvas-mcp.cjs',
  'dist/canvas-web.cjs',
  'dist/model-bridge.cjs',
  'dist/llm-channel.cjs',
  'dist/host-adapter.cjs',
  'dist/core/index.js',
  'dist/core/client.js', // 0.3.0 Task 14 回归：canvas-web 壳装载的浏览器 UI 资产（正向断言防再丢）
  'dist/core/package.json',
  'dist/core/production.js',
  'dist/core/assets/canvas-director/manifest.json',
  'dist/core/assets/canvas-studio/SKILL.md',
  'dist/vendor/react.production.min.js', // Task 14：真 UI 壳静态资产（React UMD vendor）
];

const errs = [];
let extractDir = null; // 解包目录（os 临时）
let smokeHome = null;  // 冒烟数据根（env DSH_IC_HOME 注入，os 临时）
let webChild = null;

/** PowerShell 单引号字面量转义（路径注入防御：内部单引号翻倍）。 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 带超时的 GET，返回 {status, body}；连接失败/超时 resolve {status: 0}（供轮询）。 */
function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const u = new URL(url);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => done({ status: 0, body: '' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done({ status: 0, body: '' }));
  });
}

/** 递归收集文件（相对路径列表，仅普通文件）。 */
function listFiles(base, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + name.name : name.name;
    if (name.isDirectory()) out.push(...listFiles(base, r));
    else if (name.isFile()) out.push(r);
  }
  return out;
}

async function cleanup() {
  if (webChild && webChild.exitCode === null) {
    try { webChild.kill(); } catch { /* 忽略 */ }
    await Promise.race([once(webChild, 'exit'), new Promise((ok) => setTimeout(ok, 5000))]);
  }
  for (const dir of [extractDir, smokeHome]) {
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

try {
  // ---------- 断言 1：构建 + ZIP 存在且 >50KB ----------
  const build = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, encoding: 'buffer', timeout: 120000 });
  if (build.error) errs.push('构建脚本 spawn 失败: ' + build.error.message);
  if (build.status !== 0) {
    errs.push(`build-qoder.mjs 应 exit 0，实际 ${build.status}\nstdout: ${String(build.stdout || '')}\nstderr: ${String(build.stderr || '')}`);
  }
  if (!fs.existsSync(OUT_ZIP)) {
    errs.push('ZIP 产物不存在: ' + OUT_ZIP + '（构建应先于断言产出）');
  } else {
    const size = fs.statSync(OUT_ZIP).size;
    if (size <= 50 * 1024) errs.push(`ZIP 应 > 50KB，实际 ${size} 字节`);
  }

  // ---------- 断言 2：ZIP 层布局（tar -tf：ZIP 根直接含 .qoder-plugin/） ----------
  const tarList = spawnSync('tar', ['-tf', OUT_ZIP], { encoding: 'utf8', timeout: 60000 });
  if (tarList.status !== 0) {
    errs.push('tar -tf 列举 ZIP 失败: ' + (tarList.stderr || tarList.error?.message || ('exit ' + tarList.status)));
  } else {
    const entries = tarList.stdout.split(/\r?\n/).filter(Boolean);
    for (const rel of ['.qoder-plugin/plugin.json', '.mcp.json', 'dist/canvas-mcp.cjs', 'skills/canvas/SKILL.md']) {
      if (!entries.some((e) => e.replace(/^\.\//, '') === rel)) {
        errs.push(`ZIP 条目缺 ${rel}（ZIP 根应直接含 .qoder-plugin/ 等顶层结构）`);
      }
    }
  }

  // ---------- 解包（Expand-Archive，PowerShell spawn） ----------
  extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-qoder-extract-'));
  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${psQuote(OUT_ZIP)} -DestinationPath ${psQuote(extractDir)} -Force`,
  ], { encoding: 'buffer', timeout: 120000 });
  if (ps.status !== 0) {
    errs.push(`Expand-Archive 应 exit 0，实际 ${ps.status}: ${String(ps.stderr || '')}`);
  }

  // ---------- 断言 3：解包目录树 ----------
  for (const rel of REQUIRED_TREE) {
    if (!fs.existsSync(path.join(extractDir, rel))) errs.push('解包树缺 ' + rel);
  }
  // client.js 正向断言（0.3.0 Task 14 回归；Task 7 的「不随包」反向断言已随实证推翻删除）：
  // 字节数与仓库根 client.js 一致——防旧版死重裁剪逻辑回归或拷贝截断
  const packedClient = path.join(extractDir, 'dist', 'core', 'client.js');
  const repoClient = path.join(ROOT, 'client.js');
  if (fs.existsSync(packedClient) && fs.existsSync(repoClient)) {
    if (fs.statSync(packedClient).size !== fs.statSync(repoClient).size) {
      errs.push(`dist/core/client.js 字节数应与仓库根 client.js 一致（Task 14 随包回归），实际 ${fs.statSync(packedClient).size} vs ${fs.statSync(repoClient).size}`);
    }
  }

  // ---------- 断言 4：plugin.json / .mcp.json 逐字（键序与值全等） ----------
  let pluginJson = null;
  try { pluginJson = JSON.parse(fs.readFileSync(path.join(extractDir, '.qoder-plugin', 'plugin.json'), 'utf8')); }
  catch (e) { errs.push('plugin.json JSON.parse 失败: ' + e.message); }
  if (pluginJson !== null && JSON.stringify(pluginJson) !== JSON.stringify(PLUGIN_JSON_VERBATIM)) {
    errs.push(`plugin.json 与 brief 逐字值不符，实际: ${JSON.stringify(pluginJson)}`);
  }
  let mcpJson = null;
  try { mcpJson = JSON.parse(fs.readFileSync(path.join(extractDir, '.mcp.json'), 'utf8')); }
  catch (e) { errs.push('.mcp.json JSON.parse 失败: ' + e.message); }
  if (mcpJson !== null && JSON.stringify(mcpJson) !== JSON.stringify(MCP_JSON_VERBATIM)) {
    errs.push(`.mcp.json 与 brief 逐字值不符，实际: ${JSON.stringify(mcpJson)}`);
  }

  // ---------- 断言 5：SKILL.md frontmatter 含 name: canvas ----------
  const skillPath = path.join(extractDir, 'skills', 'canvas', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    errs.push('解包树缺 skills/canvas/SKILL.md（frontmatter 断言跳过）');
  } else {
    const skillMd = fs.readFileSync(skillPath, 'utf8');
    const fm = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) errs.push('SKILL.md 应有 YAML frontmatter（--- 包头）');
    else {
      if (!/^name:\s*canvas\s*$/m.test(fm[1])) errs.push('SKILL.md frontmatter 应含 name: canvas，实际头: ' + fm[1].slice(0, 200));
      if (!/^description:\s*\S/m.test(fm[1])) errs.push('SKILL.md frontmatter description 应非空');
    }
  }

  // ---------- 断言 6：全包文本扫描无密钥形状 sk-（KEY_RE，见头注勘误） ----------
  if (extractDir) {
    const offenders = [];
    for (const rel of listFiles(extractDir)) {
      const buf = fs.readFileSync(path.join(extractDir, rel)); // 二进制按 latin1 扫（字节级 ASCII 形状）
      const m = buf.toString('latin1').match(KEY_RE);
      if (m) offenders.push(rel + ' → ' + m.slice(0, 3).join(', '));
    }
    if (offenders.length) errs.push('ZIP 内出现密钥形状 sk-（密钥红线）:\n  ' + offenders.join('\n  '));
  }

  // ---------- 断言 7：数据根冒烟（解包产物可运行；DSH_IC_HOME 隔离，绝不写真实用户目录） ----------
  smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-qoder-smoke-home-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  webChild = spawn(process.execPath, [path.join(extractDir, 'dist', 'canvas-web.cjs'), '--port', String(port)], {
    cwd: extractDir,
    env: { ...process.env, DSH_IC_HOME: smokeHome }, // 数据根裁定：env 注入临时目录（密闭）
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childErr = [];
  webChild.stderr.on('data', (c) => childErr.push(c));
  webChild.on('exit', (code) => { if (code !== 0 && code !== null) childErr.push(Buffer.from('提前退出 code=' + code)); });

  let panelOk = false;
  let panelBody = ''; // 成功轮询的面板 HTML（Task 14 冒烟断言三 script 用）
  const deadline = Date.now() + 30000; // core import 较重，轮询至 30s
  while (Date.now() < deadline) {
    if (webChild.exitCode !== null) break;
    const hit = await httpGet(`http://127.0.0.1:${port}/`, 1500);
    if (hit.status === 200 && hit.body.includes(PANEL_MARK)) { panelOk = true; panelBody = hit.body; break; }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  if (!panelOk) {
    errs.push(`解包产物 canvas-web.cjs 冒烟失败：端口 ${port} 未在 30s 内返回 200+面板特征串\nstderr: ${Buffer.concat(childErr).toString('utf8').slice(0, 600)}`);
  } else {
    // 数据根落在 DSH_IC_HOME（新缺省经 env 生效）：host-adapter 建根 + projects/
    if (!fs.existsSync(path.join(smokeHome, 'projects'))) {
      errs.push('数据根冒烟：DSH_IC_HOME/projects 应已创建（数据根落在 env 注入根），实际未建');
    }
    // Task 14/15 解包冒烟（真 UI 壳）：GET / 四 script 齐活 + 三条静态资产路由可用
    for (const needle of ['__ModuleLoader__', 'createRoot', '<script src="/infinite-canvas/api/client.js">', '<script src="/infinite-canvas/api/vendor/react.production.min.js">', '<script src="/infinite-canvas/api/vendor/react-dom.production.min.js">']) {
      if (!panelBody.includes(needle)) errs.push('解包产物面板缺真 UI 壳片段（Task 14/15 四 script）: ' + needle);
    }
    const smokeClient = await httpGet(`http://127.0.0.1:${port}/infinite-canvas/api/client.js`, 5000);
    if (smokeClient.status !== 200 || smokeClient.body.length < 100000) {
      errs.push(`解包产物 client.js 路由应 200 且为大体量浏览器应用（>100K 字符），实际 ${smokeClient.status} / ${smokeClient.body.length}`);
    }
    const smokeReact = await httpGet(`http://127.0.0.1:${port}/infinite-canvas/api/vendor/react.production.min.js`, 5000);
    if (smokeReact.status !== 200 || !smokeReact.body.includes('React')) {
      errs.push(`解包产物 vendor React 路由应 200 且含 React（UMD 全局），实际 ${smokeReact.status}`);
    }
    const smokeReactDOM = await httpGet(`http://127.0.0.1:${port}/infinite-canvas/api/vendor/react-dom.production.min.js`, 5000);
    if (smokeReactDOM.status !== 200 || !smokeReactDOM.body.includes('ReactDOM')) {
      errs.push(`解包产物 vendor ReactDOM 路由应 200 且含 ReactDOM（Task 15 壳自渲染 createRoot），实际 ${smokeReactDOM.status}`);
    }
  }

  // ---------- 收尾：杀子进程 + 删临时目录（cleanup 统一） ----------
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
} finally {
  await cleanup();
}

if (errs.length) {
  console.error(`\n✗ qoder-plugin 打包契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ qoder-plugin ZIP：契约全部通过（构建/ZIP 树/逐字清单/SKILL frontmatter/无密钥/解包产物冒烟：面板+四 script+client.js·vendor 路由+数据根）');
process.exit(0);
