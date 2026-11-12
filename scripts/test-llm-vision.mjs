#!/usr/bin/env node
/**
 * 视觉输入（拉片）Host 契约：llmComplete({ images }) 必须把 dataURL 存成宿主附件，
 * 并以 {type:'image', attachment} content block 发给模型；不带 images 时保持纯文本消息。
 *
 * 运行：node scripts/test-llm-vision.mjs   退出码 0 = 通过
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const calls = [];
const saved = [];
const llm = {
  listProviders: () => [{ id: 'test', name: 'Test' }],
  listModels: () => [{ id: 'vision-1', name: 'Vision 1' }],
  async *stream(options) {
    calls.push(options);
    yield { type: 'text-delta', text: '{"shots":[]}' };
    yield { type: 'finish', reason: 'stop' };
  },
};
const attachments = {
  async saveImage(image) {
    saved.push(image);
    return { attachmentId: 'sha256:test-' + saved.length, mediaType: image.mediaType, bytes: image.data.length, width: 768, height: 432, name: image.name };
  },
};
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get(name) {
    if (name === 'llm') return llm;
    if (name === 'attachments') return attachments;
    return undefined;
  },
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
};

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
try { mod.apply(fakeCtx); } catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + ((e && e.stack) || e)); process.exit(1);
}
const methods = mod._internals.rpcMethods();
const llmComplete = methods && methods.llmComplete;
if (typeof llmComplete !== 'function') { console.error('✗ 未暴露 llmComplete'); process.exit(1); }

const dataUrl = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]).toString('base64');
try {
  const r = await llmComplete({
    provider: 'test', model: 'vision-1', system: 'sys', user: '拉片',
    images: [{ dataUrl, name: 'frame-1.jpg' }],
  });
  ok(r && r.text && r.text.includes('shots'), 'llmComplete 未返回模型正文');
  ok(saved.length === 1, 'dataURL 未保存为附件（saveImage 调用次数 ' + saved.length + '）');
  ok(saved[0] && saved[0].mediaType === 'image/jpeg' && saved[0].data.length === 6, '附件字节/媒体类型不正确');
  const msg = calls[0] && calls[0].messages && calls[0].messages[0];
  ok(!!msg, '模型 stream 没有收到 messages');
  const content = (msg && msg.content) || [];
  ok(content.some((b) => b && b.type === 'text' && b.text === '拉片'), '文本块缺失');
  ok(content.some((b) => b && b.type === 'image' && b.attachment && b.attachment.attachmentId === 'sha256:test-1'), '图片 content block 缺失或附件引用不正确');
} catch (e) {
  errs.push('视觉调用抛错：' + String((e && e.message) || e));
}

// 纯文本路径不受影响
calls.length = 0; saved.length = 0;
try {
  await llmComplete({ provider: 'test', model: 'vision-1', user: '纯文本' });
  const content = (calls[0] && calls[0].messages && calls[0].messages[0] && calls[0].messages[0].content) || [];
  ok(content.length === 1 && content[0].type === 'text', '纯文本路径不应产生 image block');
  ok(saved.length === 0, '纯文本路径不应保存附件');
} catch (e) {
  errs.push('纯文本调用抛错：' + String((e && e.message) || e));
}

if (errs.length) {
  console.error('✗ 视觉输入契约未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 视觉输入契约通过（dataURL → 附件 → image content block；纯文本零影响）');
process.exit(0);
