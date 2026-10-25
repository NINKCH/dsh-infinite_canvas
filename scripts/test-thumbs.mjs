// 缩略图预览体系回归（node）：
//   派生文件规则 / 路由存在性 / 节点只用缩略图 / 原图与原视频按需加载 /
//   缺失媒体负缓存 / 合成层与滚轮修复的源码契约
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

// ① Host 派生文件纯函数
const m = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const I = m._internals || {};
ok(I.THUMB_MAX_SIDE === 512, 'THUMB_MAX_SIDE 应为 512');
ok(I.thumbRelOf && I.thumbRelOf('projects/p/image/a.png') === 'projects/p/image/a.png.thumb.jpg', 'thumbRelOf 规则错误');
ok(I.thumbRelOf && I.thumbRelOf('') === null, 'thumbRelOf(空) 应为 null');
ok(I.isDerivedMedia && I.isDerivedMedia('a.png.thumb.jpg'), 'thumb 应识别为派生文件');
ok(I.isDerivedMedia && I.isDerivedMedia('a.mp4.poster.jpg'), 'poster 应识别为派生文件');
ok(I.isDerivedMedia && !I.isDerivedMedia('a.png'), '原文件不应识别为派生文件');

// ② Host 路由与治理
ok(/\/api\/thumb`/.test(host), '缺少 /api/thumb 路由');
ok(/仅接受 POST\/PUT/.test(host.split('/api/thumb')[1] || ''), '/api/thumb 应只接受 POST/PUT');
ok(/isDerivedMedia\(rel\) \? 'public, max-age=31536000, immutable'/.test(host), '派生文件应带 immutable 缓存');
ok(/list\.filter\(\(a\) => !isDerivedMedia\(a && a\.rel\)\)/.test(host), '导入时应剔除派生条目');
ok(/unlinkSync\(abs \+ suffix\)/.test(host), '删除资产时应清理派生文件');

// ③ 客户端缩略图管线
ok(/const THUMB_MAX = 512, THUMB_QUALITY = 0\.72;/.test(cli), '客户端缩略图参数缺失');
ok(/function makeThumbBlob\(blob\)/.test(cli) && /createImageBitmap/.test(cli), '缩略图应优先用 createImageBitmap 缩放');
ok(/\/api\/thumb\?rel=/.test(cli), '客户端应把缩略图 POST 到 /api/thumb');
ok(/if \(kind === 'image'\) \{ try \{ queueThumb\(rec\.id\); \}/.test(cli), '图片保存后应排队生成缩略图');
ok(/function useNodeThumb\(assetId\)/.test(cli), '缺少 useNodeThumb');
ok(/const thumbUrlV = useNodeThumb\(kind === 'image' \? n\.data\.assetId : null\);/.test(cli), '图片节点应使用缩略图');
ok(/src: thumbUrlV, draggable: false, decoding: 'async',/.test(cli), '图片节点 src 必须是缩略图');
ok(!/src: assetUrlV, draggable: false,/.test(cli), '图片节点不得再直接加载原图');
ok(/const \[playUrl, setPlayUrl\] = useState\(null\)/.test(cli), '视频应使用按需 playUrl');
ok(/src: playUrl \|\| undefined,/.test(cli), '视频节点 src 必须来自 playUrl（播放时才取）');
ok(/if \(!videoPlaying\) \{ setPlayUrl\(null\);/.test(cli), '未播放时应释放原视频 URL');
ok(/const u = await assetUrl\(n\.data\.assetId\)\.catch\(\(\) => null\);\s*\n\s*if \(u\) openLightbox\('image', u/.test(cli), '双击放大时应按需取原图');
ok(/const thumbFailed = new Set\(\)/.test(cli) && /thumbIsFailed/.test(cli), '缺少缺失负缓存');
ok(/T\('mediaMissing'\)/.test(cli) && /T\('retry'\)/.test(cli), '缺少缺失素材占位与重试文案');
ok('mediaMissing' in (() => { const z = cli.indexOf("'mediaMissing'"); return z >= 0 ? { mediaMissing: 1 } : {}; })() || cli.includes("'mediaMissing'"), '缺少 mediaMissing 文案键');

// ④ 视频首帧缩到 512（poster 即视频缩略图）
ok(/Math\.min\(1, 512 \/ Math\.max\(w0, h0\)\)/.test(cli) || /Math\.min\(1, 512 \/ Math\.max\(w, h\)\)/.test(cli), '视频首帧应缩到 512');

// ⑤ 合成层与滚轮修复
ok(!/\.dshic-world\{[^}]*will-change:transform;/.test(cli), '.dshic-world 不应有常驻 will-change');
ok(/\.dshic-world\.is-interacting\{will-change:transform;\}/.test(cli), 'should add will-change only while interacting');
ok(/worldEl\.classList\.add\('is-interacting'\)/.test(cli) && /worldEl\.classList\.remove\('is-interacting'\)/.test(cli), '交互类应随指针按下/抬起切换');
ok(/addEventListener\('wheel', dirWheelListenerRef\.current, \{ passive: false \}\)/.test(cli), '导演台滚轮必须是 non-passive 原生监听');
ok(!/onWheel: onWheel,/.test(cli), '不应再挂 React onWheel（passive，无法阻止页面缩放）');
ok(/@keyframes dshic-sheen\{0%\{opacity/.test(cli), 'sheen 动画不应使用 filter（强制重绘）');

if (errs.length) {
  console.error('✗ 缩略图/合成层测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 缩略图体系通过（512 派生图 / 节点只用缩略图 / 原图按需 / 缺失负缓存 / 无常驻合成层 / 滚轮非 passive）');
process.exit(0);
