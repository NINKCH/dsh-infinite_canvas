#!/usr/bin/env node
/**
 * workbuddy-plugin 打包契约测试（dev-only，不随包发布）。需求：task-8-brief.md Step 1 断言清单。
 *
 * 形态：WorkBuddy 装插件 = 加本地目录市场，产物为目录市场 staging + zip（区别于 qoder 的单 ZIP：
 * 这里目录本身就是可装产物，zip 是可选分发物）。测试内 spawn `node adapters/scripts/build-workbuddy.mjs`
 * 构建 → 直接对 staging 目录树逐条断言 → zip 用 tar -tf 验根条目 → staging 产物数据根冒烟。
 * 全程不触碰 ~/.workbuddy（本会话正运行在 WorkBuddy 内；注册延后 Task 11）。
 *
 *  1) 构建成功 + staging 市场目录树存在：.codebuddy-plugin/marketplace.json、
 *     plugins/dsh-infinite-canvas/{.codebuddy-plugin/plugin.json、.mcp.json、skills/canvas/SKILL.md、
 *     README.md、dist/ 五模块 + dist/core/index.js}（另加 §4 RUNTIME_FILES 抽查项）
 *  2) 正向断言（0.3.0 Task 14 回归）：dist/core/client.js 存在且与仓库根字节数一致（canvas-web 壳
 *     装载的浏览器 UI 资产；Task 7 的「不随包」反向断言已被实证推翻删除）+ dist/vendor/
 *     react.production.min.js（真 UI 壳静态资产）
 *  3) 三个 JSON parse 通过且与 brief 逐字全等（marketplace.json / plugin.json / .mcp.json；
 *     JSON.stringify 全等比对，键序一致）
 *  4) zip 产物：tar -tf 列表含 .codebuddy-plugin/marketplace.json 于 ZIP 根（另抽查插件关键条目）
 *  5) SKILL.md frontmatter 含 name: canvas（YAML 头），且 description 非空
 *  6) 全包文本扫描无密钥形状 sk-（红线）。勘误：brief 原文「无 sk-」按字面扫描对良性子串脆弱
 *     （model-bridge 脱敏正则源码本身等），故按密钥形状 /sk-[A-Za-z0-9_-]{8,}/ 扫描
 *     （与 adapters/shared/model-bridge.cjs KEY_RE 及 test-adapters-qoder-pkg.mjs 断言 6 同口径）
 *  7) 数据根冒烟：env DSH_IC_HOME 指临时目录，spawn staging 内 dist/canvas-web.cjs --port <随机>
 *     → 轮询 GET / → 200 且含面板挂载点特征串 + POST /api/rpc {"method":"ping"} → 200 且 ok:true
 *     → kill（staging 市场产物可运行 + 缺省 --core-dir 发布布局自解析 + 数据根 env 注入生效）
 *
 * 收尾：杀子进程、删临时目录，端口不残留。
 * 运行：node scripts/test-adapters-workbuddy-pkg.mjs
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
const BUILD_SCRIPT = path.join(ROOT, 'adapters', 'scripts', 'build-workbuddy.mjs');
const STAGING = path.join(ROOT, 'adapters', 'dist', 'workbuddy-marketplace');
const OUT_ZIP = path.join(ROOT, 'adapters', 'dist', 'dsh-marketplace-workbuddy-0.3.3.zip');
const PANEL_MARK = 'id="infinite-canvas-root"'; // 面板挂载点特征子串（canvas-web.cjs 自备面板页）
const KEY_RE = /sk-[A-Za-z0-9_-]{8,}/g;         // 密钥形状（与 model-bridge.cjs KEY_RE 同口径）

// brief 逐字产物：marketplace.json（市场根；键序与值全等才通过——壳契约冻结）
const MARKETPLACE_JSON_VERBATIM = {
  name: 'dsh-marketplace',
  description: 'DSH 插件市场',
  owner: { name: 'ninkch' },
  plugins: [
    {
      name: 'dsh-infinite-canvas',
      version: '0.3.3',
      description: '无限画布——可视化创作工作台（剧本/分镜/图片/视频节点编排）',
      source: './plugins/dsh-infinite-canvas',
    },
  ],
};
// brief 逐字产物：plugin.json（注意：无 displayName / skills 字段，与 qoder 形态不同）
const PLUGIN_JSON_VERBATIM = {
  name: 'dsh-infinite-canvas',
  version: '0.3.3',
  description: '无限画布——可视化创作工作台（剧本/分镜/图片/视频节点编排）',
  author: { name: 'ninkch' },
  mcpServers: './.mcp.json',
};
// brief 逐字产物：.mcp.json（command:"node" 走 PATH 合法——官方样本 godot-mcp 实证；stdio command
// 强制插件根内，由 ${CODEBUDDY_PLUGIN_ROOT} 指向保证）
const MCP_JSON_VERBATIM = {
  mcpServers: {
    'dsh-infinite-canvas': {
      command: 'node',
      args: ['${CODEBUDDY_PLUGIN_ROOT}/dist/canvas-mcp.cjs'],
    },
  },
};
// 断言清单的 staging 目录树（相对 staging 根）+ §4 RUNTIME_FILES / Files 清单补充项
const PLUGIN = 'plugins/dsh-infinite-canvas';
const REQUIRED_TREE = [
  '.codebuddy-plugin/marketplace.json',
  `${PLUGIN}/.codebuddy-plugin/plugin.json`,
  `${PLUGIN}/.mcp.json`,
  `${PLUGIN}/skills/canvas/SKILL.md`,
  `${PLUGIN}/README.md`,
  `${PLUGIN}/dist/canvas-mcp.cjs`,
  `${PLUGIN}/dist/canvas-web.cjs`,
  `${PLUGIN}/dist/model-bridge.cjs`,
  `${PLUGIN}/dist/llm-channel.cjs`,
  `${PLUGIN}/dist/llm-bridge-service.cjs`, // Task 16：桥接 llm 服务（host-adapter get('llm') 供给源）
  `${PLUGIN}/dist/host-adapter.cjs`,
  `${PLUGIN}/dist/core/index.js`,
  `${PLUGIN}/dist/core/client.js`, // 0.3.0 Task 14 回归：canvas-web 壳装载的浏览器 UI 资产（正向断言防再丢）
  `${PLUGIN}/dist/core/package.json`,
  `${PLUGIN}/dist/core/production.js`,
  `${PLUGIN}/dist/core/assets/canvas-director/manifest.json`,
  `${PLUGIN}/dist/core/assets/canvas-studio/SKILL.md`,
  `${PLUGIN}/dist/vendor/react.production.min.js`, // Task 14：真 UI 壳静态资产（React UMD vendor）
];

const errs = [];
let smokeHome = null;  // 冒烟数据根（env DSH_IC_HOME 注入，os 临时）
let webChild = null;

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

/** 带超时的 POST（原始 JSON 体，{method,args} 形状——§2.2 非信封），返回 {status, body}。 */
function httpPostJson(url, payload, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => done({ status: 0, body: '' }));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done({ status: 0, body: '' }));
    req.end(data);
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
  try { if (smokeHome) fs.rmSync(smokeHome, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

try {
  // ---------- 断言 1：构建成功 + staging 市场目录树 ----------
  const build = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, encoding: 'buffer', timeout: 120000 });
  if (build.error) errs.push('构建脚本 spawn 失败: ' + build.error.message);
  if (build.status !== 0) {
    errs.push(`build-workbuddy.mjs 应 exit 0，实际 ${build.status}\nstdout: ${String(build.stdout || '')}\nstderr: ${String(build.stderr || '')}`);
  }
  if (!fs.existsSync(STAGING)) {
    errs.push('staging 市场目录不存在: ' + STAGING + '（构建应先于断言产出）');
  } else {
    for (const rel of REQUIRED_TREE) {
      if (!fs.existsSync(path.join(STAGING, rel))) errs.push('staging 树缺 ' + rel);
    }
    // client.js 正向断言（0.3.0 Task 14 回归；「不随包」反向断言已随实证推翻删除）：
    // 字节数与仓库根 client.js 一致——防旧版死重裁剪逻辑回归或拷贝截断
    const packedClient = path.join(STAGING, PLUGIN, 'dist', 'core', 'client.js');
    if (fs.existsSync(packedClient) && fs.existsSync(path.join(ROOT, 'client.js'))) {
      if (fs.statSync(packedClient).size !== fs.statSync(path.join(ROOT, 'client.js')).size) {
        errs.push(`staging client.js 字节数应与仓库根一致（Task 14 随包回归），实际 ${fs.statSync(packedClient).size} vs ${fs.statSync(path.join(ROOT, 'client.js')).size}`);
      }
    }
  }

  // ---------- 断言 3：三个 JSON 逐字（parse + JSON.stringify 全等，键序一致） ----------
  const jsonChecks = [
    { rel: '.codebuddy-plugin/marketplace.json', verbatim: MARKETPLACE_JSON_VERBATIM, label: 'marketplace.json' },
    { rel: `${PLUGIN}/.codebuddy-plugin/plugin.json`, verbatim: PLUGIN_JSON_VERBATIM, label: 'plugin.json' },
    { rel: `${PLUGIN}/.mcp.json`, verbatim: MCP_JSON_VERBATIM, label: '.mcp.json' },
  ];
  for (const { rel, verbatim, label } of jsonChecks) {
    const p = path.join(STAGING, rel);
    if (!fs.existsSync(p)) { errs.push(`${label} 不存在（JSON 断言跳过）: ${p}`); continue; }
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { errs.push(`${label} JSON.parse 失败: ` + e.message); continue; }
    if (JSON.stringify(parsed) !== JSON.stringify(verbatim)) {
      errs.push(`${label} 与 brief 逐字值不符，实际: ${JSON.stringify(parsed)}`);
    }
  }

  // ---------- 断言 4：zip 产物 tar -tf（ZIP 根含 .codebuddy-plugin/marketplace.json） ----------
  if (!fs.existsSync(OUT_ZIP)) {
    errs.push('zip 产物不存在: ' + OUT_ZIP);
  } else {
    const tarList = spawnSync('tar', ['-tf', OUT_ZIP], { encoding: 'utf8', timeout: 60000 });
    if (tarList.status !== 0) {
      errs.push('tar -tf 列举 zip 失败: ' + (tarList.stderr || tarList.error?.message || ('exit ' + tarList.status)));
    } else {
      const entries = tarList.stdout.split(/\r?\n/).map((e) => e.replace(/^\.\//, '')).filter(Boolean);
      const mustContain = [
        '.codebuddy-plugin/marketplace.json',
        `${PLUGIN}/.codebuddy-plugin/plugin.json`,
        `${PLUGIN}/dist/canvas-mcp.cjs`,
        `${PLUGIN}/skills/canvas/SKILL.md`,
      ];
      for (const rel of mustContain) {
        if (!entries.includes(rel)) errs.push(`zip 条目缺 ${rel}（ZIP 根应为市场根）`);
      }
    }
  }

  // ---------- 断言 5：SKILL.md frontmatter 含 name: canvas ----------
  const skillPath = path.join(STAGING, PLUGIN, 'skills', 'canvas', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    errs.push('staging 树缺 skills/canvas/SKILL.md（frontmatter 断言跳过）');
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
  if (fs.existsSync(STAGING)) {
    const offenders = [];
    for (const rel of listFiles(STAGING)) {
      const buf = fs.readFileSync(path.join(STAGING, rel)); // 二进制按 latin1 扫（字节级 ASCII 形状）
      const m = buf.toString('latin1').match(KEY_RE);
      if (m) offenders.push(rel + ' → ' + m.slice(0, 3).join(', '));
    }
    if (offenders.length) errs.push('staging 市场内出现密钥形状 sk-（密钥红线）:\n  ' + offenders.join('\n  '));
  }

  // ---------- 断言 7：数据根冒烟（staging 产物可运行；DSH_IC_HOME 隔离，绝不写真实用户目录） ----------
  smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-workbuddy-smoke-home-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  webChild = spawn(process.execPath, [path.join(STAGING, PLUGIN, 'dist', 'canvas-web.cjs'), '--port', String(port)], {
    cwd: path.join(STAGING, PLUGIN),
    env: { ...process.env, DSH_IC_HOME: smokeHome }, // 数据根裁定：env 注入临时目录（密闭）
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childErr = [];
  webChild.stderr.on('data', (c) => childErr.push(c));
  webChild.on('error', (e) => childErr.push(Buffer.from('spawn 失败: ' + e.message))); // 例：staging 缺失 → cwd ENOENT，记录而非崩溃
  webChild.on('exit', (code) => { if (code !== 0 && code !== null) childErr.push(Buffer.from('提前退出 code=' + code)); });

  let panelOk = false;
  let panelBody = ''; // 成功轮询的面板 HTML（Task 14 冒烟断言三 script 用）
  let pingOk = false;
  const deadline = Date.now() + 30000; // core import 较重，轮询至 30s
  while (Date.now() < deadline) {
    if (webChild.exitCode !== null) break;
    const hit = await httpGet(`http://127.0.0.1:${port}/`, 1500);
    if (hit.status === 200 && hit.body.includes(PANEL_MARK)) { panelOk = true; panelBody = hit.body; break; }
    await new Promise((ok) => setTimeout(ok, 300));
  }
  if (!panelOk) {
    errs.push(`staging 产物 canvas-web.cjs 冒烟失败：端口 ${port} 未在 30s 内返回 200+面板特征串\nstderr: ${Buffer.concat(childErr).toString('utf8').slice(0, 600)}`);
  } else {
    // POST ping 200（§2.2 RPC：{method:"ping"} → {ok:true,version}）
    const ping = await httpPostJson(`http://127.0.0.1:${port}/infinite-canvas/api/rpc`, { method: 'ping' }, 10000);
    if (ping.status !== 200) {
      errs.push(`staging 产物冒烟：POST ping 应 200，实际 ${ping.status}，body: ${ping.body.slice(0, 200)}`);
    } else {
      try {
        const pong = JSON.parse(ping.body);
        if (pong.ok !== true) errs.push('staging 产物冒烟：POST ping 应返回 ok:true，实际: ' + ping.body.slice(0, 200));
        else pingOk = true;
      } catch (e) {
        errs.push('staging 产物冒烟：POST ping 应答非 JSON: ' + e.message + '，body: ' + ping.body.slice(0, 200));
      }
    }
    // 数据根落在 DSH_IC_HOME（新缺省经 env 生效）：host-adapter 建根 + projects/
    if (!fs.existsSync(path.join(smokeHome, 'projects'))) {
      errs.push('数据根冒烟：DSH_IC_HOME/projects 应已创建（数据根落在 env 注入根），实际未建');
    }
    // Task 14/15 staging 冒烟（真 UI 壳）：GET / 四 script 齐活 + 三条静态资产路由可用
    for (const needle of ['__ModuleLoader__', 'createRoot', '<script src="/infinite-canvas/api/client.js">', '<script src="/infinite-canvas/api/vendor/react.production.min.js">', '<script src="/infinite-canvas/api/vendor/react-dom.production.min.js">']) {
      if (!panelBody.includes(needle)) errs.push('staging 面板缺真 UI 壳片段（Task 14/15 四 script）: ' + needle);
    }
    const smokeClient = await httpGet(`http://127.0.0.1:${port}/infinite-canvas/api/client.js`, 5000);
    if (smokeClient.status !== 200 || smokeClient.body.length < 100000) {
      errs.push(`staging client.js 路由应 200 且为大体量浏览器应用（>100K 字符），实际 ${smokeClient.status} / ${smokeClient.body.length}`);
    }
    const smokeReact = await httpGet(`http://127.0.0.1:${port}/infinite-canvas/api/vendor/react.production.min.js`, 5000);
    if (smokeReact.status !== 200 || !smokeReact.body.includes('React')) {
      errs.push(`staging vendor React 路由应 200 且含 React（UMD 全局），实际 ${smokeReact.status}`);
    }
    const smokeReactDOM = await httpGet(`http://127.0.0.1:${port}/infinite-canvas/api/vendor/react-dom.production.min.js`, 5000);
    if (smokeReactDOM.status !== 200 || !smokeReactDOM.body.includes('ReactDOM')) {
      errs.push(`staging vendor ReactDOM 路由应 200 且含 ReactDOM（Task 15 壳自渲染 createRoot），实际 ${smokeReactDOM.status}`);
    }
  }

  // ---------- 收尾：杀子进程 + 删临时目录（cleanup 统一） ----------
} catch (e) {
  errs.push('测试异常终止: ' + ((e && e.stack) || e));
} finally {
  await cleanup();
}

if (errs.length) {
  console.error(`\n✗ workbuddy-plugin 打包契约测试未通过（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ workbuddy 本地市场：契约全部通过（构建/staging 树/三 JSON 逐字/client.js·vendor 正向断言/zip 根条目/SKILL frontmatter/无密钥/staging 产物冒烟 GET+POST ping+四 script+资产路由）');
process.exit(0);
