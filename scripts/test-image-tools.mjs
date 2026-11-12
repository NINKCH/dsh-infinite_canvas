// 正式回归：确定性图像工具（能力注册表 / 抠图/超分/扩图接线）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const has = (s, m) => ok(cli.includes(s), m);

// 能力注册表：三档协议 + 透明底判定
has('const IMAGE_TOOL_CAPS = {', '缺少 IMAGE_TOOL_CAPS');
has('bridge: { upscale: true, matte: true, outpaint: true, angles: true, relight: true, transparent: false }', '桥接能力表缺失/错误');
has('edits: { upscale: true, matte: true, outpaint: true, angles: true, relight: true, transparent: false }', 'edits 能力表缺失/错误');
has('generations: { upscale: true, matte: false, outpaint: false, angles: false, relight: false, transparent: false }', 'generations 能力表应只保留本地超分');
has('function imageToolCaps(cfg)', '缺少 imageToolCaps');
has('caps.transparent = /gpt-image|transparent/i.test', '透明底未按模型判定');

// 工具实现：超分本地重采样；抠图/扩图/多角度/打光走 edits
has('async function upscaleImageBlob(blob, factor)', '缺少本地超分');
has("g.imageSmoothingQuality = 'high'", '超分未使用高质量重采样');
has("cv.toBlob(res, 'image/png')", '超分未输出 PNG');
has('function ImageToolsDialog({ nodeId, onClose })', '缺少图像工具面板');
has("runEdit('matte')", '缺少抠图执行');
has("runEdit('outpaint')", '缺少扩图执行');
has("runEdit('angles')", '缺少多角度执行');
has("runEdit('relight')", '缺少打光执行');
has("if (mcfg.viaImageGen)", '桥接模型未走 apiGenBridge');
has("background: kind === 'matte' && caps.transparent ? 'transparent' : undefined", '透明底未传入 images/edits');
has("if (opts && opts.background) fd.append('background'", 'images/edits 未发送 background');
has('const editSize = (r) =>', '缺少按比例选择编辑尺寸');
has('runRow(T(\'imgToolUpscale\')', '面板缺少超分入口');
has("caps.matte ? runRow(T('imgToolMatte')", '抠图按钮未按能力隐藏/显示');
has("caps.outpaint ? runRow(T('imgToolOutpaint')", '扩图按钮未按能力隐藏/显示');

// 节点入口 + 产物落节点
has("'data-action': 'image-tools'", '图片节点缺少图像工具入口');
has('async function commitDerivedImage(srcNode, blob, label, opts)', '缺少图像工具产物节点');
has("source: 'image-tool'", '产物资产未标记 image-tool');
has("toolsOpen && kind === 'image'", '图像工具面板未挂到图片节点');

if (errs.length) {
  console.error('✗ 图像工具测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 图像工具测试通过（能力注册表 / 超分 / 抠图 / 扩图 / 多角度 / 打光 / 透明底）');
process.exit(0);
