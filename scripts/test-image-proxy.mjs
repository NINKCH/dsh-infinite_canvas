#!/usr/bin/env node
/**
 * 外部 API 代理回归测试（fetchProxyForward，路由 /api/fetch-proxy）：
 *  图片/视频/音频接口由浏览器直连会被 CORS 拦（Failed to fetch），统一经 Host 代理转发。
 *  覆盖：JSON POST 透传（含鉴权头）/ 二进制响应 / 状态码透传 / 上游超时 / 非法 url / 路由调用点绊线。
 *
 * 运行：node scripts/test-image-proxy.mjs；退出码 0=通过 1=失败
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), 'dsh-ic-imgproxy-');
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

// 0) 源码绊线：改名（imageProxyForward → fetchProxyForward）曾漏改路由内调用点，
//    测试直接调模块函数全绿、真实路由却 ReferenceError。凡旧名残留（含路由体）一律失败。
const hostSrc = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
ok(!/imageProxyForward/.test(hostSrc), 'index.js 仍有旧函数名 imageProxyForward 残留（路由调用点断裂）');
ok(/await fetchProxyForward\(payload\)/.test(hostSrc), 'fetch-proxy 路由未调用 fetchProxyForward');

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const I = mod._internals;
mod.apply({
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
});

// 本地上游服务器：模拟图片网关的各种响应
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/echo') {
      res.setHeader('content-type', 'application/json');
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; } // multipart 等非 JSON 体不解析，只回显长度
      res.end(JSON.stringify({ data: [{ b64_json: 'cG5n' }], got: parsed, rawLength: Buffer.concat(chunks).length, auth: req.headers.authorization || '' }));
    } else if (req.url === '/binary') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    } else if (req.url === '/fail') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'bad size' }));
    } else if (req.url === '/hang') {
      // 挂死不响应：触发代理超时
    } else {
      res.statusCode = 404; res.end('nope');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

try {
  // 1) JSON POST 透传：请求体对象 → JSON 序列化，鉴权头保留，响应 JSON 可读
  const r1 = await I.fetchProxyForward({ url: base + '/echo', headers: { Authorization: 'Bearer sk-test' }, body: { model: 'sensenova-u1.5-lite', prompt: '一只海豹宝宝' } });
  ok(r1.status === 200, 'JSON POST 透传状态码不正确');
  const j1 = JSON.parse(r1.buf.toString('utf8'));
  ok(j1.auth === 'Bearer sk-test', '鉴权头未透传');
  ok(j1.got && j1.got.model === 'sensenova-u1.5-lite' && j1.got.prompt === '一只海豹宝宝', 'JSON 请求体未正确转发');
  ok(Array.isArray(j1.data) && j1.data[0].b64_json === 'cG5n', 'JSON 响应体未透传');

  // 2) 二进制响应（模拟 url 下载）：字节与 content-type 原样回传
  const r2 = await I.fetchProxyForward({ url: base + '/binary', method: 'GET' });
  ok(r2.status === 200 && r2.contentType.startsWith('image/png'), '二进制响应 content-type 不正确');
  ok(r2.buf.length === 6 && r2.buf[0] === 0x89 && r2.buf[1] === 0x50, '二进制响应体损坏');

  // 3) 状态码透传（上游 400 不吞不包装成 200）
  const r3 = await I.fetchProxyForward({ url: base + '/fail' });
  ok(r3.status === 400 && /bad size/.test(r3.buf.toString('utf8')), '上游 400 状态/响应未透传');

  // 4) 上游挂死 → 代理超时抛错（客户端据此报"超时"而不是笼统 Failed to fetch）
  let timedOut = false;
  try { await I.fetchProxyForward({ url: base + '/hang', timeoutMs: 300 }); } catch (e) {
    timedOut = e && (e.name === 'TimeoutError' || /timeout|aborted/i.test(String((e && e.message) || e)));
  }
  ok(timedOut, '挂死上游未触发代理超时');

  // 5) 非法 url 拒绝
  let badUrl = false;
  try { await I.fetchProxyForward({ url: 'ftp://example.com/x' }); } catch { badUrl = true; }
  ok(badUrl, '非 http(s) url 应拒绝');

  // 6) multipart 原文转发（edits 模式路径）
  const boundaryBody = ['--XBOUND', 'Content-Disposition: form-data; name="prompt"', '', '测试', '--XBOUND--', ''].join('\r\n');
  const r4 = await I.fetchProxyForward({ url: base + '/echo', headers: { Authorization: 'Bearer sk-e' }, bodyRaw: Buffer.from(boundaryBody).toString('base64'), bodyContentType: 'multipart/form-data; boundary=XBOUND' });
  const j4 = JSON.parse(r4.buf.toString('utf8'));
  ok(j4.auth === 'Bearer sk-e', 'multipart 模式鉴权头未透传');
  ok(j4.rawLength > 0, 'multipart 原文未转发（体长为 0）');
} finally {
  server.close();
}

if (errs.length) {
  console.error('✗ 图片代理回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 图片代理回归测试通过（JSON/二进制/状态码透传、超时、非法 url、multipart 原文）');
process.exit(0);
