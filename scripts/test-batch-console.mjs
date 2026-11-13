// 正式回归：画布选区/整组批量执行台（静态接线）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const has = (s, m) => ok(cli.includes(s), m);

// 状态与目标收集
has('batch: null,', 'S 缺少 batch 状态');
has('const BATCH_TYPES = new Set([\'image\', \'video\', \'audio\', \'script\', \'storyboard\', \'finalcut\']);', '可执行类型集合缺失/被改');
has('function collectBatchTargets(ids)', '缺少 collectBatchTargets');
has('for (const m of (n.data.members || [])) walk(m);', '组节点未递归展开成员');
has('function openBatchConsole(ids, source)', '缺少 openBatchConsole');

// 预检：数量/秒数/金额
has('batchVideoSecsOf', '缺少视频秒数汇总');
has('hostRpc(\'productionPrice\'', '批量预检未复用 productionPrice 单价口径');
has('batchNoPrice', '缺少未配置单价提示');
has('batchMissingPrompt', '缺少缺提示词预检告警');

// 队列 / 并发 / 停止
has('async function startBatchQueue()', '缺少队列执行器');
has('clamp(Number(b.concurrency) || 1, 1, 3)', '并发上限未限制在 1–3');
has('const worker = async () =>', '缺少并发 worker');
has('markBatchItem(it, \'skipped\')', '已在生成中的节点未跳过（会重复计费）');
has('function stopBatchQueue()', '缺少停止入口');
has('genAbort.batchAbort = true;', '停止未中断批量队列');
has('genAbort.batchControllers.add(ctl)', 'runGenNode 未登记批量 AbortController');
has('genAbort.batchAbort ||', 'genAborted 未识别批量停止');

// 面板接线
has('function BatchRunPanel()', '缺少批量执行台组件');
has('\'data-role\': \'batch-console\'', '面板缺少 data-role');
has('\'data-action\': \'batch-start\'', '面板缺少开始按钮');
has('\'data-action\': \'batch-stop\'', '面板缺少停止按钮');
has('S.batch ? h(BatchRunPanel) : null', '根组件未渲染批量执行台');

// 右键入口 + 组动作
has("T(n.type === 'group' ? 'batchGroupRun' : 'batchMenu')", '右键菜单缺少批量生成入口');
has("T('batchGroupVideo')", '组菜单缺少批量生成视频');
has("T('batchGroupDownload')", '组菜单缺少批量下载');
has('function batchVideosFromImages(ids)', '缺少组内图片批量建视频');
has('toPort: \'frame\'', '图片→视频未接首帧端口');
has('async function batchDownloadNodes(ids)', '缺少批量下载');

// 样式
has('.dshic-batch{', '缺少批量执行台样式');
has('.dshic-batch-item[data-st="error"]', '缺少失败态样式');

if (errs.length) {
  console.error('✗ 批量执行台测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 批量执行台测试通过（预检/并发队列/停止/失败隔离/组动作/下载）');
process.exit(0);
