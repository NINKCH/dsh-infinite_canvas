#!/usr/bin/env node
/**
 * IC-08 回归测试：CAS **写路径退役**、**读路径保留**。
 *
 * 背景：0.18.0–0.18.4 上传的媒体存在 <dataRoot>/objects/<sha2>/<sha256> 里，DB 行是 sha-only。
 * 退役写路径时如果把读路径一起删了，老用户的图和视频会**全部 404**（历史数据不可恢复）。
 * 所以要同时锁两件事：
 *   A. 写路径必须真的没了 —— POST/PUT /api/object 返回 405（不是 200，也不是静默接受）
 *   B. 读路径必须原样还在 —— GET 200 / immutable / content-length / Range 206 / 非法 sha 400 / 缺失 404
 *
 * 造数据法（复用 test-db.mjs 的思路）：mkdtemp 数据根 → dataRootSet → 直连 canvas.db 插一行
 * 含 64 位 hex sha 的 assets → 用 I.objectAbsFor 写对象文件 → 打真实 HTTP 路由。
 *
 * 运行：node scripts/test-object-read.mjs；退出码 0=通过 1=失败（无 node:sqlite 时 SKIP 通过）
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-obj-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const routes = [];
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const I = mod._internals;
mod.apply({
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  tools: { register: () => () => {} },
});

if (!I.sqliteAvailable()) {
  console.log('SKIP：当前 Node 无 node:sqlite（<22.5），CAS 读路径不可测（运行时走 JSON 降级）');
  process.exit(0);
}

const DATA = path.join(SANDBOX, 'data');
const setRes = I.setDataRoot(DATA);
ok(setRes.ok && setRes.mode === 'sqlite', 'setDataRoot 未进入 sqlite 模式：' + JSON.stringify(setRes));

// ---------- 造一个「0.18.4 时代的老资产」：DB 行 sha-only + objects/ 里有文件 ----------
const SHA = 'ab'.repeat(32); // 64 位 hex
const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8'); // 36 字节，便于 Range 断言
const objAbs = I.objectAbsFor(DATA, SHA);
fs.mkdirSync(path.dirname(objAbs), { recursive: true });
fs.writeFileSync(objAbs, BODY);
await I.dbAssetCreate({ id: 'a_legacy', projectId: 'p_legacy', kind: 'image', mime: 'image/png', name: '老资产', sha: SHA, size: BODY.length, createdAt: Date.now() });
const rows = await I.dbAssetsList({ projectId: 'p_legacy' });
ok(rows.total === 1 && rows.items[0].sha === SHA, '前置失败：老资产行没写进去');

// ---------- 起真实 HTTP 服务，挂 /api/object 路由 ----------
const objRoute = routes.find((r) => r.path === '/infinite-canvas/api/object');
ok(!!objRoute, '未找到 /api/object 路由（读路径被整体删了？）');
const server = http.createServer((req, res) => { Promise.resolve(objRoute.handler(req, res)).catch(() => {}); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}/infinite-canvas/api/object`;

const req = (method, qs, opts = {}) => fetch(base + qs, { method, headers: opts.headers || {}, body: opts.body });
const readBody = async (res) => Buffer.from(await res.arrayBuffer());

// ---------- A. 写路径必须已退役 ----------
{
  const post = await req('POST', '?sha=', { body: 'x' });
  ok(post.status === 405, 'A1：POST /api/object 应返回 405（写路径已退役），实际 ' + post.status);
  const allow = post.headers.get('allow') || '';
  ok(/GET/i.test(allow), 'A2：405 响应缺少 `Allow: GET` 头，实际 "' + allow + '"');
  let j = null;
  try { j = JSON.parse(await post.text()); } catch { j = null; }
  ok(j && typeof j.error === 'string' && /退役|retired/i.test(j.error), 'A3：405 响应体没有可读的退役说明');
  const put = await req('PUT', '?sha=', { body: 'x' });
  ok(put.status === 405, 'A4：PUT /api/object 应返回 405，实际 ' + put.status);
  // 关键：不得静默写盘
  const before = fs.existsSync(path.join(DATA, 'objects')) ? fs.readdirSync(path.join(DATA, 'objects')).length : 0;
  await req('POST', '', { body: Buffer.alloc(64, 1) });
  const after = fs.existsSync(path.join(DATA, 'objects')) ? fs.readdirSync(path.join(DATA, 'objects')).length : 0;
  ok(before === after, 'A5：写路径虽回 405，但磁盘 objects/ 目录结构发生了变化（不得静默写盘）');
}

// ---------- B. 读路径必须原样还在 ----------
{
  const r1 = await req('GET', '?sha=' + SHA + '&mime=image/png');
  ok(r1.status === 200, 'B1：GET 历史对象应 200，实际 ' + r1.status);
  ok(r1.headers.get('cache-control') === 'public, max-age=31536000, immutable', 'B2：immutable 缓存头丢失：' + r1.headers.get('cache-control'));
  ok(r1.headers.get('content-type') === 'image/png', 'B3：mime 透传失效：' + r1.headers.get('content-type'));
  const body = await readBody(r1);
  ok(body.length === BODY.length && body.equals(BODY), 'B4：读取内容与写入不一致');
  ok(r1.headers.get('accept-ranges') === 'bytes', 'B5：accept-ranges 头丢失');

  const r2 = await req('GET', '?sha=' + SHA, { headers: { range: 'bytes=0-9' } });
  ok(r2.status === 206, 'B6：Range 请求应 206，实际 ' + r2.status);
  ok(r2.headers.get('content-range') === `bytes 0-9/${BODY.length}`, 'B7：content-range 不对：' + r2.headers.get('content-range'));
  const part = await readBody(r2);
  ok(part.length === 10 && part.equals(BODY.subarray(0, 10)), 'B8：Range 切片内容不对');

  const r3 = await req('GET', '?sha=not-a-sha');
  ok(r3.status === 400, 'B9：非法 sha 应 400，实际 ' + r3.status);

  const r4 = await req('GET', '?sha=' + 'ff'.repeat(32));
  ok(r4.status === 404, 'B10：缺失对象应 404，实际 ' + r4.status);

  const r5 = await req('GET', '?sha=' + SHA, { headers: { range: 'bytes=9999-10000' } });
  ok(r5.status === 416, 'B11：越界 Range 应 416，实际 ' + r5.status);
}

// ---------- C. 引用计数 GC 仍在（删资产时回收历史对象） ----------
{
  ok(typeof I.dbAssetDelete === 'function', 'C1：dbAssetDelete 丢失');
  await I.dbAssetDelete('a_legacy');
  ok(!fs.existsSync(objAbs), 'C2：删掉唯一引用该对象的资产后，历史对象未按引用计数回收');
}

// ---------- 收尾：先让 HTTP 句柄完全关闭，再关库，最后延迟退出 ----------
// 直接 process.exit 会在 Windows 上与 libuv 的句柄拆除竞态（Assertion failed: UV_HANDLE_CLOSING），
// 失败也会被掩成奇怪退出码；复用 test-db.mjs 的 setTimeout(...).unref() 做法。
await new Promise((resolve) => server.close(resolve));
I.closeDb();
try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不影响结论 */ }
if (errs.length) {
  console.error('✗ IC-08 验证未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  setTimeout(() => process.exit(1), 200).unref();
} else {
  console.log('✓ IC-08 验证通过：写路径已退役（POST/PUT→405 且不写盘），读路径完整保留（200/immutable/Range 206/400/404/416），引用计数回收仍生效');
  setTimeout(() => process.exit(0), 200).unref();
}
