#!/usr/bin/env node
/**
 * moyu 类中转站图片字段兼容回归。
 *
 * 背景：moyu.info 的 wan3.0 接口是 OpenAI 风格但图片字段不同——
 *   ① 参考图用 images:string[]（纯 dataURL 字符串数组），不是 [{url,role}] 对象数组；
 *   ② 首帧用 input_reference（dataURL 字符串）；
 *   ③ resolution 大写枚举（480P/720P/1080P）；duration [2,30]；
 *   ④ 无 generate_audio / output_format 参数。
 * 曾因 images 发成 [{url,role}] 对象数组 + DashScope 协议误判，502 三连。
 *
 * 断言（源码契约 + 逻辑常量）：
 *   1) isMoyuFlavor 按 base 域名激活；
 *   2) 首帧分支：moyu → input_reference；非 moyu → body.image（原行为）；
 *   3) 参考图分支：moyu → images 纯字符串数组；非 moyu openai → [{url,role}]（JUAI 回归）；
 *   4) duration 夹取 [2,30]；moyu resolution 大写；
 *   5) generate_audio/output_format 在 moyu 下不发送；
 *   6) extractVideoUrl 覆盖 data.result_url；taskFailureOf 覆盖 data.fail_reason。
 *
 * 运行：node scripts/test-video-image-url.mjs；退出码 0=通过。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------- 1) isMoyuFlavor 激活与作用域 ----------
ok(src.includes('const isMoyuFlavor = /moyu\\.info/i.test(base);'), '缺 isMoyuFlavor 域名判定');
// 必须在视频 openai 分支内（apiVideo 附近），不能泄漏到图片分支
const videoIdx = src.indexOf('const isMoyuFlavor');
const apiImageIdx = src.indexOf('async function apiImage');
const apiVideoIdx = src.indexOf('async function apiVideo');
ok(videoIdx > apiVideoIdx, 'isMoyuFlavor 应定义在 apiVideo（视频）作用域内（位于 apiImage 之后即不影响图片路径）');

// ---------- 2) 首帧分支：moyu → input_reference ----------
ok(/if \(isMoyuFlavor\) body\.input_reference = moyuImagePayload\(await blobToDataUrlScaled\(frameBlob\)\);/.test(src), 'moyu 首帧未走 input_reference（裸 base64）');
ok(/else try \{ body\.image = await blobToDataUrlScaled\(frameBlob\); \} catch/.test(src), '非 moyu 首帧的 body.image 原行为丢失');

// ---------- 3) 参考图分支：moyu → images 纯字符串数组 ----------
ok(/body\.images = isMoyuFlavor[\s\S]{0,160}?moyuImagePayload\(await blobToDataUrlScaled\(b\)\)\)/.test(src), 'moyu 参考图未走纯字符串数组（裸 base64）');
ok(/: isOpenaiVideo\s*\? await Promise\.all\(imgs\.map\(async \(b\) => \(\{ url: await blobToDataUrlScaled\(b\), role: 'reference_image' \}\)\)\)/.test(src), '非 moyu openai 的 [{url,role}] 结构丢失（JUAI 回归）');

// ---------- 4) duration 夹取 + moyu resolution 大写 ----------
ok(/duration: Math\.min\(30, Math\.max\(2, Number\(o\.duration\) \|\| 5\)\)/.test(src), 'duration 未夹取 [2,30]');
ok(/if \(isMoyuFlavor\) body\.resolution = String\(o\.resolution \|\| '1080P'\)\.toUpperCase\(\);/.test(src), 'moyu resolution 未用大写枚举');

// ---------- 5) moyu 下不发 generate_audio / output_format ----------
ok(/if \(!isMoyuFlavor\) \{[\s\S]{0,200}?generate_audio = true;[\s\S]{0,200}?output_format/.test(src), 'moyu 分支未屏蔽 generate_audio/output_format');

ok(/const moyuImagePayload = \(dataUrl\) =>/.test(src), '缺 moyuImagePayload（dataURL 剥前缀 helper）');
// ---------- 6) 轮询字段覆盖 ----------
ok(/j\.data && j\.data\.result_url,/.test(src), 'extractVideoUrl 未覆盖 data.result_url');
ok(/st\.data && \(st\.data\.fail_reason/.test(src), 'taskFailureOf 未覆盖 data.fail_reason');

// ---------- 7) 厂商路由（联动断言，防改回去） ----------
ok(!/wanx\|万相/.test(src), '模型名路由不应回潮（wanx 正则）');
ok(/if \(s\.vendor\) return s\.vendor;/.test(src), '显式 vendor 优先丢失');

if (errs.length) {
  console.error('✗ moyu 图片字段兼容回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ moyu 图片字段兼容回归通过：isMoyuFlavor 激活域 / input_reference / images:string[] / JUAI 结构保留 / duration-resolution 口径 / moyu 参数屏蔽 / 轮询字段覆盖 / 厂商路由不回潮');
