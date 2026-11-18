#!/usr/bin/env node
/**
 * 自定义媒体供应商适配器回归（0.22 P1）：
 *  - 源码校验：id/模型/字段/方法/禁止 import/require/process
 *  - 存储：保存/列表/读取/覆盖冲突/revision/删除
 *  - 执行：URL/base64 结果、ctx.fetch、ctx.asset、错误脱敏
 *
 * 运行：node scripts/test-provider-adapters.mjs；退出码 0 = 通过。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateProviderSource,
  saveProviderAdapter,
  listProviderAdapters,
  getProviderAdapter,
  deleteProviderAdapter,
  runProviderAdapter,
} from '../provider-adapters.js';

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');
const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-provider-'));

const SOURCE = `
module.exports = {
  id: "demoProvider",
  label: "演示供应商",
  version: "1.0.0",
  readme: "演示用",
  fields: [{ key: "apiKey", label: "API Key", type: "password", required: true }],
  models: [
    {
      id: "img-1", label: "图片一", type: "image",
      ratios: ["1:1", "16:9"], sizes: ["1K", "2K"], maxRefs: 4,
      fields: [{ key: "style", label: "风格", type: "select", options: ["a", "b"], default: "a" }],
    },
    {
      id: "vid-1", label: "视频一", type: "video",
      durations: [5, 10], resolutions: ["720P"], audio: false,
    },
  ],
  async generateImage(ctx, req) {
    if (req.prompt === "bin") return [{ mediaType: "image", type: "binary", data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }];
    const asset = await ctx.asset(req.refs && req.refs[0] && req.refs[0].assetId);
    const res = await ctx.fetch("https://mock.test/images", {
      method: "POST",
      headers: { Authorization: "Bearer " + ctx.config.apiKey },
      body: JSON.stringify({ model: req.model, prompt: req.prompt, style: req.extra.style, ref: asset && asset.mimeType }),
    });
    const json = await res.json();
    return [{ mediaType: "image", type: "url", url: json.url }];
  },
  async generateVideo(ctx, req) {
    if (req.duration === 99) throw new Error("bad key " + ctx.config.apiKey);
    return [{ mediaType: "video", type: "base64", data: Buffer.from("video-bytes").toString("base64"), mimeType: "video/mp4" }];
  },
};
`;

try {
  // ---------------- 1) 校验 ----------------
  const valid = validateProviderSource(SOURCE);
  ok(valid.ok, '合法适配器应通过校验：' + (valid.error || ''));
  if (valid.ok) {
    eq(valid.provider.id, 'demoProvider', '供应商 id');
    eq(valid.provider.models.length, 2, '模型数量');
    eq(valid.provider.models[0].ratios, ['1:1', '16:9'], '图片模型 capabilities');
    eq(valid.provider.models[0].fields[0].options, ['a', 'b'], '模型字段 options');
    ok(valid.provider.revision.length === 64, 'revision 应为 sha256');
  }
  for (const [src, why] of [
    ['module.exports = { id: "Bad", label: "x", models: [{ id: "m", label: "m", type: "image" }], generateImage() {} };', '大写 id'],
    ['module.exports = { id: "okProvider", label: "x", models: [{ id: "m", label: "m", type: "image" }] };', '缺 generateImage'],
    ['module.exports = { id: "okProvider", label: "x", models: [{ id: "m", label: "m", type: "image" }], generateImage() {} }; require("fs");', 'require 必须失败'],
    ['module.exports = { id: "okProvider", label: "x", models: [{ id: "m", label: "m", type: "image" }], generateImage() {} }; process.exit(1);', 'process 必须失败'],
    ['module.exports = { id: "okProvider", label: "x", models: [{ id: "m", label: "m", type: "image" }], generateImage() {} }; import "node:fs";', 'import 必须失败'],
  ]) {
    const r = validateProviderSource(src);
    ok(!r.ok, why + ' 应被拒绝');
  }

  // ---------------- 2) 存储 ----------------
  const saved = saveProviderAdapter(dir, SOURCE, {});
  ok(saved.ok && saved.created, '首次保存应创建');
  eq(listProviderAdapters(dir).length, 1, '列表应有 1 个');
  const got = getProviderAdapter(dir, 'demoProvider');
  ok(got.ok && got.source === SOURCE, '读取源码应一致');
  let dupErr = '';
  try { saveProviderAdapter(dir, SOURCE, {}); } catch (e) { dupErr = String(e.message || e); }
  ok(/已存在/.test(dupErr), '重复保存无 overwrite 应失败');
  const oldRevision = got.provider.revision;
  saveProviderAdapter(dir, SOURCE.replace('"1.0.0"', '"1.0.1"'), { overwrite: true, revision: oldRevision });
  eq(getProviderAdapter(dir, 'demoProvider').provider.version, '1.0.1', '带 revision 覆盖应成功');
  let revErr = '';
  try { saveProviderAdapter(dir, SOURCE, { overwrite: true, revision: oldRevision }); } catch (e) { revErr = String(e.message || e); }
  ok(/已被修改/.test(revErr), '过期 revision 应失败');

  // ---------------- 3) 执行 ----------------
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ url: 'https://cdn.test/out.png' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const readAsset = async (id) => (id === 'a1' ? { data: Buffer.from('image-bytes'), mimeType: 'image/png', name: 'a1' } : null);
  const image = await runProviderAdapter(dir, {
    id: 'demoProvider', kind: 'image',
    request: { model: 'img-1', prompt: 'hello', refs: [{ assetId: 'a1' }], extra: {} },
    config: { apiKey: 'sk-secret' }, readAsset, fetchImpl,
  });
  ok(image.ok && image.media[0].type === 'url' && image.media[0].url === 'https://cdn.test/out.png', '图片 URL 结果应归一化');
  eq(calls.length, 1, '适配器应通过 ctx.fetch 发起一次请求');
  const body = JSON.parse(calls[0].init.body);
  eq(body.style, 'a', '模型字段默认值应进入 req.extra');
  eq(body.ref, 'image/png', 'ctx.asset 应返回参考图 MIME');

  const binary = await runProviderAdapter(dir, {
    id: 'demoProvider', kind: 'image',
    request: { model: 'img-1', prompt: 'bin' }, config: { apiKey: 'sk-secret' },
  });
  ok(binary.ok && binary.media[0].type === 'base64' && binary.media[0].mimeType === 'image/png', 'binary 结果应转 base64');
  eq([...Buffer.from(binary.media[0].data, 'base64')], [1, 2, 3], 'binary 内容应跨 vm realm 正确转换');

  const video = await runProviderAdapter(dir, {
    id: 'demoProvider', kind: 'video',
    request: { model: 'vid-1', prompt: 'x', duration: 5 }, config: { apiKey: 'sk-secret' },
  });
  ok(video.ok && video.media[0].type === 'base64' && video.media[0].mimeType === 'video/mp4', '视频 base64 结果应归一化');
  ok(Buffer.from(video.media[0].data, 'base64').toString() === 'video-bytes', 'base64 内容应一致');

  let redacted = '';
  try {
    await runProviderAdapter(dir, {
      id: 'demoProvider', kind: 'video',
      request: { model: 'vid-1', prompt: 'x', duration: 99 }, config: { apiKey: 'sk-secret' },
    });
  } catch (e) { redacted = String(e.message || e); }
  ok(/bad key/.test(redacted) && !redacted.includes('sk-secret') && redacted.includes('••••••'), '错误信息必须脱敏 API Key（实际：' + redacted + '）');

  // ---------------- 4) 删除 ----------------
  const del = deleteProviderAdapter(dir, 'demoProvider', { revision: getProviderAdapter(dir, 'demoProvider').provider.revision });
  ok(del.ok && del.deleted, '删除应成功');
  eq(listProviderAdapters(dir).length, 0, '删除后列表为空');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

if (errs.length) {
  console.error('✗ 自定义供应商适配器回归未通过（' + errs.length + ' 条）：');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ 自定义供应商适配器回归通过（校验/存储/revision/执行/URL/base64/资产/脱敏）');
