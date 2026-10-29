#!/usr/bin/env node
/**
 * 图片 API「字段校验型 400」自愈回归。
 *
 * 背景：通用 /images/generations 协议默认带 watermark:false，但部分厂商把该端点
 * 转成自己的队列式文生图接口，字段表严格（实测某厂商报「watermark 不是文生图
 * 队列支持的字段」HTTP 400）。unsupportedFieldName() 从报错文案里提取字段名，
 * apiImage 剥掉该字段重试一次。
 *
 * 本测试锁死识别正则的口径：中文/英文两类文案 + 负例（不得误剥，否则会把
 * 真实错误（如 Invalid API key）吞掉变成无限重试或空字段请求）。
 *
 * 运行：node scripts/test-image-field-retry.mjs；退出码 0=通过。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// 1) 函数存在且接进了 generations 主路径
ok(src.includes('function unsupportedFieldName'), 'client.js 缺 unsupportedFieldName()');
ok(/let res = await send\(body, '图片 API'\);/.test(src), 'generations 主路径未改为 send() 形式（无自愈重试）');
ok(/delete retried\[bad\]/.test(src), '重试时未剥离不支持字段（delete retried[bad] 缺失）');
ok(src.includes("图片 API(剥字段重试)"), '重试请求缺少独立 label（排查时无法区分）');

// 2) 抽出真函数体（vm 沙箱求值），锁死识别口径
const i = src.indexOf('function unsupportedFieldName');
const j = src.indexOf('return null;', i);
ok(i >= 0 && j > i, 'unsupportedFieldName 函数体不完整');
if (!errs.length) {
  const end = src.indexOf('}', j) + 1;
  const fn = vm.runInNewContext('(' + src.slice(i, end) + ')');

  const cases = [
    // [报错原文（含用户实测原文）, 期望提取的字段]
    ['{"error":{"message":"watermark 不是文生图队列支持的字段(request id:2026102818)","type":"invalid_request"}}', 'watermark'],
    ['{"error":{"message":"prompt_extend 不是该接口支持的参数"}}', 'prompt_extend'],
    ['{"error":{"message":"size 不是有效字段"}}', 'size'],
    ['{"error":{"message":"unsupported field watermark"}}', 'watermark'],
    ['{"error":{"message":"unknown parameter seed"}}', 'seed'],
    ['{"error":{"message":"\'watermark\' is not a supported field"}}', 'watermark'],
    // 负例：绝不能误剥——否则真实错误被吞、或剥成空请求
    ['{"error":{"message":"Invalid API key provided"}}', null],
    ['{"error":{"message":"rate limit exceeded"}}', null],
    ['{"error":{"message":"内容安全审核未通过"}}', null],
    ['{"error":{"message":"insufficient quota"}}', null],
  ];
  for (const [input, want] of cases) {
    const got = fn(input);
    ok(got === want, `字段识别失败：${input.slice(0, 60)} → ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
  }
}

if (errs.length) {
  console.error('✗ 图片字段重试回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 图片字段重试回归通过：识别函数存在 + 已接入 generations 主路径 + 中英文文案识别 11 例 + 负例不误剥');
