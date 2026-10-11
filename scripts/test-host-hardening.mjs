#!/usr/bin/env node
/**
 * Host 加固回归测试（dev-only，不随包发布）。
 *
 * 每一条都对应一次真实审查发现的缺陷，且都能在修复前复现：
 *  1) /api/file 读流错误会变成**进程级未捕获异常**（Host 按 fatal 退出）→ 用真实路由起 http 服务验证
 *  2) projectsPut 用客户端快照整体覆盖 nodes（抹掉对话刚建的节点）
 *  3) 墓碑不生效：已删节点被陈旧推送复活
 *  4) canvas_open 对不存在的项目返回假成功
 *  5) dataRootSet 相对路径会静默落到应用 cwd（绝对路径检查曾是死代码）
 *  6) /api/rpc 可被跨站简单请求触发（无同源/内容类型校验）
 *
 * 运行：node scripts/test-host-hardening.mjs；退出码 0=通过 1=失败
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-harden-'));
const DATA_ROOT = path.join(SANDBOX, 'data');
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

const routes = [];
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  tools: { register: () => () => {} },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
mod.apply(fakeCtx);

const route = (p) => routes.find((r) => r.path === p);
ok(routes.length >= 3, `应注册至少 3 条路由，实际 ${routes.length}`);
const i = mod._internals;

// ---------- 1) /api/file：读流错误不得逃逸（EISDIR 走 open 失败路径） ----------
{
  // 用真实 RPC 设置数据根目录（顺带验证 dataRootSet 正常路径）
  const rpcRoute = route('/infinite-canvas/api/rpc');
  const rpcCall = (method, args, headers) => new Promise((resolve) => {
    const req = {
      method: 'POST', url: '/infinite-canvas/api/rpc',
      headers: headers || { host: '127.0.0.1:1', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method, args: args || {} })); },
      on() {},
    };
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: res.statusCode, body: String(body) }); } };
    Promise.resolve(rpcRoute.handler(req, res)).catch((e) => resolve({ status: 500, body: String(e && e.message) }));
  });
  const setRoot = await rpcCall('dataRootSet', { root: DATA_ROOT });
  ok(setRoot.status === 200, 'dataRootSet 失败：' + setRoot.body);
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(path.join(DATA_ROOT, 'ok.bin'), Buffer.alloc(1000, 7));
  fs.mkdirSync(path.join(DATA_ROOT, 'adir'), { recursive: true }); // 目录：stat 成功但读流 open 失败

  const fileRoute = route('/infinite-canvas/api/file');
  ok(!!fileRoute, '未找到 /api/file 路由');
  let escaped = null;
  const onUncaught = (e) => { escaped = e; };
  process.on('uncaughtException', onUncaught);
  const server = http.createServer((req, res) => { Promise.resolve(fileRoute.handler(req, res)).catch(() => {}); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = async (rel, headers) => {
    const res = await fetch(`http://127.0.0.1:${port}/infinite-canvas/api/file?rel=${encodeURIComponent(rel)}`, { headers });
    const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    return { status: res.status, len: body.byteLength, headers: res.headers };
  };
  try {
    const full = await get('ok.bin');
    ok(full.status === 200 && full.len === 1000, `普通 GET 应为 200 且 1000 字节，实际 ${full.status}/${full.len}`);
    const ranged = await get('ok.bin', { range: 'bytes=0-9' });
    ok(ranged.status === 206 && ranged.len === 10, `Range GET 应为 206 且 10 字节，实际 ${ranged.status}/${ranged.len}`);
    const missing = await get('nope.bin');
    ok(missing.status === 404, `缺失文件应为 404，实际 ${missing.status}`);
    // 读流 open 失败（stat 成功之后文件被删/被占用）是**异步 error 事件**：
    // 以前没人接管 → 进程级未捕获异常 → Host fatal 退出。这里用真实 http 服务器驱动该分支。
    const srv2 = http.createServer((req, res) => {
      res.statusCode = 200;
      i.pipeFile(path.join(DATA_ROOT, 'gone.bin'), {}, res);
    });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    const gone = await fetch(`http://127.0.0.1:${srv2.address().port}/x`);
    ok(gone.status === 404, `读流错误应转成 404，实际 ${gone.status}`);
    await gone.arrayBuffer().catch(() => {});
    await new Promise((r) => srv2.close(r));
    await new Promise((r) => setTimeout(r, 60));
    ok(escaped === null, '读流/路由产生了进程级未捕获异常：' + String(escaped && escaped.message));
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    await new Promise((r) => server.close(r));
  }
}

// ---------- 2/3) projectsPut：合并 Host 独有节点 + 墓碑生效 ----------
{
  const p = await i.canvasCreateProject({ name: '硬化测试', scriptText: '意图', nodeName: '第一节' });
  const pid = p.projectId;
  // 对话再建一个节点（Host 独有，客户端尚未拉取）
  const created = i.canvasCreateNode({ projectId: pid, type: 'image-gen', name: '角色-张山 多视图', prompt: 'x' });
  // 模拟客户端 450ms 全量推送：只有第一节节点，没有刚建的角色节点
  const doc = await i.projectsGet({ id: pid });
  const withoutAgentNode = { ...doc, nodes: { [p.nodeId]: doc.nodes[p.nodeId] } };
  await i.projectsPut({ id: pid, name: '硬化测试', doc: withoutAgentNode });
  const after = await i.projectsGet({ id: pid });
  ok(!!after.nodes[created.nodeId], '客户端全量推送把对话刚建的节点抹掉了（projectsPut 未合并 Host 独有节点）');
  // 墓碑：删除后陈旧推送不得复活
  i.canvasDeleteNode({ projectId: pid, nodeId: created.nodeId });
  await i.projectsPut({ id: pid, name: '硬化测试', doc: { ...doc, nodes: { ...doc.nodes, [created.nodeId]: doc.nodes[created.nodeId] } } });
  const after2 = await i.projectsGet({ id: pid });
  ok(!after2.nodes[created.nodeId], '被墓碑标记的节点被陈旧推送复活了');
  // 客户端本地删除（tombstones 随文档推送）同样生效
  i.canvasCreateNode({ projectId: pid, type: 'text', name: '临时', prompt: 'y' });
  const d3 = await i.projectsGet({ id: pid });
  const tmpId = Object.keys(d3.nodes).find((k) => d3.nodes[k].data.label === '临时');
  const nextNodes = { ...d3.nodes };
  delete nextNodes[tmpId];
  await i.projectsPut({ id: pid, name: '硬化测试', doc: { ...d3, nodes: nextNodes, tombstones: [tmpId] } });
  const after3 = await i.projectsGet({ id: pid });
  ok(!after3.nodes[tmpId], '客户端本地删除（带 tombstones 推送）后节点又回来了');
  await i.projectsDelete({ id: pid });
}

// ---------- 4) canvas_open 不存在的项目必须报错 ----------
{
  let threw = false;
  try { await i.canvasOpen({ projectId: 'nope-not-exist' }); } catch { threw = true; }
  ok(threw, 'canvas_open 对不存在的项目返回了假成功');
}

// ---------- 5) dataRootSet 必须拒绝相对路径 ----------
{
  const configPath = process.env.DSH_IC_CONFIG_PATH;
  const beforeCfg = fs.readFileSync(configPath, 'utf8');
  let rejected = null;
  try {
    // 通过真实 RPC handler 调用（最贴近实际路径）
    const rpc = route('/infinite-canvas/api/rpc');
    await new Promise((resolve) => {
      const req = {
        method: 'POST', url: '/infinite-canvas/api/rpc',
        headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method: 'dataRootSet', args: { root: 'relative/dir' } })); },
        on() {},
      };
      const res = {
        statusCode: 200, setHeader() {},
        end(body) { rejected = { status: res.statusCode, body: String(body) }; resolve(); },
      };
      Promise.resolve(rpc.handler(req, res)).catch(() => resolve());
    });
    ok(rejected && rejected.status === 400 && /绝对路径/.test(rejected.body), 'dataRootSet 未拒绝相对路径：' + JSON.stringify(rejected));
    ok(fs.readFileSync(configPath, 'utf8') === beforeCfg, 'dataRootSet 失败时改动了配置');
    ok(!fs.existsSync(path.join(process.cwd(), 'relative')), '相对路径在 cwd 下真建了目录');
  } catch (e) {
    errs.push('dataRootSet 相对路径校验失败 → ' + ((e && e.message) || e));
  }
}

// ---------- 6) /api/rpc 同源护栏 ----------
{
  const rpc = route('/infinite-canvas/api/rpc');
  const callRpc = (headers) => new Promise((resolve) => {
    const req = {
      method: 'POST', url: '/infinite-canvas/api/rpc', headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method: 'ping', args: {} })); },
      on() {},
    };
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: res.statusCode, body: String(body) }); } };
    Promise.resolve(rpc.handler(req, res)).catch((e) => resolve({ status: 500, body: String(e && e.message) }));
  });
  const cross = await callRpc({ host: '127.0.0.1:1', origin: 'https://evil.example', 'content-type': 'application/json' });
  ok(cross.status === 403, '跨站 Origin 未被拒绝：' + cross.status + ' ' + cross.body);
  const site = await callRpc({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' });
  ok(site.status === 403, 'cross-site（Sec-Fetch-Site）未被拒绝');
  const same = await callRpc({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  ok(same.status === 200 && /"ok":true/.test(same.body), '同源请求被误拒：' + same.status + ' ' + same.body);
  // 用局域网 IP / 自定义域名访问 DSH 也必须放行（护栏只判"同源"，不限定本机回环）
  const lan = await callRpc({ host: '192.168.1.5:19387', origin: 'http://192.168.1.5:19387', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  ok(lan.status === 200 && /"ok":true/.test(lan.body), '局域网/自定义域名访问被误拒（护栏过严）：' + lan.status + ' ' + lan.body);
  const otherHost = await callRpc({ host: '192.168.1.5:19387', origin: 'http://evil.internal:19387', 'content-type': 'application/json' });
  ok(otherHost.status === 403, '不同主机的 Origin 未被拒绝：' + otherHost.status);
  // 原型链方法名
  const proto = await callRpc({ host: '127.0.0.1:1', 'content-type': 'application/json' });
  void proto;
  const ctor = await new Promise((resolve) => {
    const req = {
      method: 'POST', url: '/infinite-canvas/api/rpc', headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method: 'constructor', args: {} })); },
      on() {},
    };
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: res.statusCode, body: String(body) }); } };
    Promise.resolve(rpc.handler(req, res)).catch(() => resolve({ status: 500, body: '' }));
  });
  ok(ctor.status === 400 && /未知操作/.test(ctor.body), '原型链方法名（constructor）未被拒绝：' + ctor.status + ' ' + ctor.body);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

if (errs.length) {
  console.error('✗ Host 加固回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ Host 加固回归测试全部通过（读流错误接管 / projectsPut 合并与墓碑 / canvas_open 校验 / dataRootSet 绝对路径 / RPC 同源护栏）');
