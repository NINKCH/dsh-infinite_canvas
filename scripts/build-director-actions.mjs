#!/usr/bin/env node
/**
 * 动作动画构建（awplanet 的 Mixamo FBX → 导演台动作库 clips/*.json）。
 *
 * 源：_refs/awplanet-main/public/animations/{uploaded,new-model}/*.fbx（20 个，Mixamo 骨架，
 *     与 xbot/explorer 同 rig，可直接重定向）。源文件长期保留在 _refs，不进 git。
 * 产物：assets/director/clips/<语义名>.json + clips/manifest.json
 *       （client 的 loadActionClips 会拉清单并经 decodeActionClips 合并进所有 Mixamo 资产；
 *         与资产自带片段同名时自动让位——内置 idle/run/walk 永不被覆盖。）
 *
 * 依赖：FBX2glTF（Facebook 的 FBX→glTF 转换器）。检测顺序：
 *   1) 环境变量 FBX2GLTF 指向的可执行文件；
 *   2) PATH 上的 FBX2glTF / fbx2gltf；
 *   3) npx --no-install fbx2gltf（本地 node_modules 里装过 fbx2gltf 包时可用）。
 * 都没有 → 打印安装指引后 SKIP（退出 0，不算失败——门禁不依赖外部工具）。
 *
 * 用法：node scripts/build-director-actions.mjs [--src <dir>] [--out <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SRC = argOf('--src', 'D:/Code/deepseek-plugin/_refs/awplanet-main/public/animations');
const OUT = argOf('--out', path.join(ROOT, 'assets/director/clips'));

/** 语义映射：文件名（不含扩展名，大小写不敏感）→ {name, label, loop} */
const SEMANTIC = [
  ['standing idle', 'idle_02', '待机 · 呼吸', true],
  ['standing idle 01', 'idle_03', '待机 · 变体', true],
  ['standard walk', 'walk', '行走', true],
  ['standing walk forward', 'walk_forward', '行走 · 前', true],
  ['standing walk back', 'walk_back', '行走 · 后', true],
  ['standing walk left', 'walk_left', '行走 · 左', true],
  ['standing walk right', 'walk_right', '行走 · 右', true],
  ['running', 'run', '奔跑', true],
  ['standing run forward', 'run_forward', '奔跑 · 前', true],
  ['standing run back', 'run_back', '奔跑 · 后', true],
  ['standing run left', 'run_left', '奔跑 · 左', true],
  ['standing run right', 'run_right', '奔跑 · 右', true],
  ['standing run forward stop', 'run_stop', '奔跑 · 急停', false],
  ['standing turn 90 left', 'turn_left', '转身 90° · 左', false],
  ['standing turn 90 right', 'turn_right', '转身 90° · 右', false],
  ['jumping', 'jump', '跳跃', false],
  ['running jump', 'running_jump', '助跑跳', false],
  ['sitting laughing', 'sit_laugh', '坐 · 大笑', true],
  ['standing dodge backward', 'dodge_back', '站姿 · 后闪', false],
  ['pirate by p. konstantinov', 'pirate', '海盗 · 展示', false],
];

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

// ── 1) 找 FBX2glTF ──
function findFbx2gltf() {
  if (process.env.FBX2GLTF && fs.existsSync(process.env.FBX2GLTF)) return process.env.FBX2GLTF;
  const names = process.platform === 'win32' ? ['FBX2glTF.exe', 'fbx2gltf.exe'] : ['FBX2glTF', 'fbx2gltf'];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(d, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 继续 */ }
    }
  }
  try {
    const p = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'fbx2gltf.cmd' : 'fbx2gltf');
    if (fs.existsSync(p)) return p;
  } catch { /* 继续 */ }
  return null;
}

const tool = findFbx2gltf();
if (!tool) {
  console.log('SKIP：未找到 FBX2glTF，无法转换 FBX 动作。');
  console.log('  安装其一后重跑本脚本：');
  console.log('    npm i -D fbx2gltf            #（npx 兼容的 node 包装，含各平台二进制）');
  console.log('    或从 https://github.com/facebookincubator/FBX2glTF/releases 下载，');
  console.log('    并 set FBX2GLTF=<可执行文件路径>');
  process.exit(0);
}
console.log('FBX2glTF:', tool);

// ── 2) 逐个转换 ──
fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbx2gltf-'));
let ok = 0, miss = 0;

// 收集源文件（uploaded + new-model）
const srcFiles = [];
for (const sub of ['uploaded', 'new-model', '.']) {
  const d = path.join(SRC, sub);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) if (/\.fbx$/i.test(f)) srcFiles.push(path.join(d, f));
}

for (const [fileKey, name, label, loop] of SEMANTIC) {
  const src = srcFiles.find((f) => path.basename(f, path.extname(f)).toLowerCase() === fileKey);
  if (!src) { console.log('MISS', name, '（缺源', fileKey + '.fbx）'); miss++; continue; }
  const glbPath = path.join(tmpDir, name + '.glb');
  try {
    execFileSync(tool, ['--binary', '--pbr-metallic-roughness', '--khr-materials-unlit', '-i', src, '-o', glbPath], { stdio: 'pipe' });
  } catch (e) {
    console.error('转换失败', name, '→', String(e.message || e).slice(0, 120));
    continue;
  }
  if (!fs.existsSync(glbPath)) { console.error('转换失败', name, '（无输出）'); continue; }
  const buf = fs.readFileSync(glbPath);
  const asset = E.parseGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  // 取时长最长的动画（FBX 里偶尔带多个 take）
  const anims = (asset.animations || []).slice().sort((a, b) => b.duration - a.duration);
  if (!anims.length) { console.error('转换失败', name, '（GLB 无动画轨道）'); continue; }
  const anim = anims[0];
  const clip = {
    name,
    label,
    loop: !!loop,
    duration: +(+anim.duration).toFixed(3),
    tracks: (anim.tracks || []).map((t2) => ({ node: t2.node, path: t2.path, times: b64(Float32Array.from(t2.times)), vals: b64(Float32Array.from(t2.vals)) })),
  };
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(clip));
  manifest.push({ file: name + '.json', name, label, duration: clip.duration, loop });
  console.log('OK', name.padEnd(14), clip.duration.toFixed(1) + 's', '|', label);
}
fs.rmSync(tmpDir, { recursive: true, force: true });

// ── 3) 清单（保留既有条目，按 name 去重） ──
const manifestPath = path.join(OUT, 'manifest.json');
let prev = { clips: [] };
try { prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* 首次 */ }
const byName = new Map();
for (const c of (prev.clips || [])) byName.set(c.name, c);
for (const c of manifest) byName.set(c.name, c);
fs.writeFileSync(manifestPath, JSON.stringify({ clips: [...byName.values()] }, null, 2));

console.log('完成：新增/更新 ' + manifest.length + '，缺源 ' + miss + '，清单 ' + [...byName.values()].length + ' 条 → ' + manifestPath);
