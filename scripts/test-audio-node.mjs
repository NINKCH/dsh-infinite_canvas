// 正式回归：音频节点 + 成片音轨（静态接线 + Host/客户端端口一致）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const host = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// 客户端端口表
ok(cli.includes("'audio': { inputs: [{ id: 'prompt', kind: 'text' }], outputs: [{ id: 'out', kind: 'audio' }] }"), '客户端 PORTS 缺少 audio 生成输入');
ok(cli.includes("'finalcut': { inputs: [{ id: 'in', kind: 'video' }, { id: 'audio', kind: 'audio' }], outputs: [] }"), '客户端 finalcut 缺少 audio 输入');
ok(cli.includes('function AudioNodeBody'), '客户端缺少 AudioNodeBody');
ok(cli.includes("if (type === 'audio') return h(AudioNodeBody"), 'nodeBody 未接线 audio');
ok(cli.includes('audioTracks') && cli.includes('startBgm') && cli.includes('stopBgm'), 'composeFinalCut 未接线 BGM/SFX 混音');
ok(cli.includes("audioGain") && cli.includes("audioLoop") && cli.includes("audioMute"), 'AudioNodeBody 缺少增益/循环/静音控件');
ok(cli.includes("'audioGenerate'") && cli.includes('ttsSynthesize'), 'AudioNodeBody 缺少文本生成音频接线');
ok(cli.includes("if (type === 'audio') { await genAudioNode(n); return true; }"), 'runGenNode 未接 audio 生成');
ok(cli.includes("'audio', 'script', 'storyboard', 'finalcut'"), 'BATCH_TYPES 未包含 audio');
ok(cli.includes("'ttsProtocolLk888'") && cli.includes('/v1/media/generate'), '缺少星海聚合 TTS 协议');

// Host 端口表 + 创建节点
ok(host.includes("'audio': { inputs: [{ id: 'prompt', kind: 'text' }], outputs: [{ id: 'out', kind: 'audio' }] }"), 'Host PORT_TABLE 缺少 audio 生成输入');
ok(host.includes("'finalcut': { inputs: [{ id: 'in', kind: 'video' }, { id: 'audio', kind: 'audio' }], outputs: [] }"), 'Host finalcut 缺少 audio 输入');
ok(host.includes("['script', 'text', 'image', 'video', 'audio', 'storyboard', 'finalcut']"), 'Host canvasCreateNode 不接受 audio');
ok(host.includes("if (from.type === 'audio') return 'audio'") || host.includes("from.type === 'audio' ? 'audio'"), 'Host 默认连线未识别 audio → finalcut');

if (errs.length) {
  console.error('✗ 音频节点/音轨测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 音频节点/音轨测试通过（audio 端口 / AudioNodeBody / finalcut 音轨 / BGM 混音 / Host 一致）');
process.exit(0);
