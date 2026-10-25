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
  // 'pirate by p. konstantinov' 是单帧静态姿势（3 帧/1 秒/29 轨），不是动作，已剔除。
];

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

/** 把稀疏关键帧轨道重采样到固定 fps（默认 30），消除「关键帧之间插值跨度过大 → 采样时跳变」。
 *  rotation 用最短弧 nlerp，translation 线性插值。 */
function resampleTrack(times, vals, path, fps = 30) {
  const n = times.length;
  const comp = path === 'rotation' ? 4 : 3;
  if (n < 2) return { times, vals };
  const dur = times[n - 1] || 0;
  const want = Math.max(2, Math.min(600, Math.round(dur * fps) + 1));
  const outT = new Float32Array(want);
  const outV = new Float32Array(want * comp);
  const lerp = (a, b, t2) => a + (b - a) * t2;
  let i = 0;
  for (let k = 0; k < want; k++) {
    const tt = (dur * k) / (want - 1);
    while (i < n - 2 && times[i + 1] < tt) i++;
    const t0 = times[i], t1 = times[i + 1];
    const u = t1 > t0 ? (tt - t0) / (t1 - t0) : 0;
    outT[k] = tt;
    const o0 = i * comp, o1 = (i + 1) * comp;
    if (path === 'rotation') {
      // 最短弧：若点积为负，翻转后插值再归一化
      let q0 = [vals[o0], vals[o0 + 1], vals[o0 + 2], vals[o0 + 3]];
      let q1 = [vals[o1], vals[o1 + 1], vals[o1 + 2], vals[o1 + 3]];
      const d = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
      if (d < 0) q1 = q1.map((v) => -v);
      let r = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) r[c] = lerp(q0[c], q1[c], u);
      const len = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
      for (let c = 0; c < 4; c++) outV[k * 4 + c] = r[c] / len;
    } else {
      for (let c = 0; c < 3; c++) outV[k * 3 + c] = lerp(vals[o0 + c], vals[o1 + c], u);
    }
  }
  return { times: outT, vals: outV };
}

/** 只读 glTF 的动画轨道（纯动画 FBX 转出的 GLB 没有网格，parseGlb 会拒绝）。
 *  与 engine.parseGlb 的轨道口径一致：只收 rotation / translation，时间轴线性采样。 */
function readGlbAnimations(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const data = new Uint8Array(buf, off + 8, len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB 无 JSON 块');
  const CT = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array, 5120: Int8Array };
  const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const readAcc = (idx) => {
    const acc = json.accessors[idx];
    const bv = json.bufferViews[acc.bufferView];
    const Ctor = CT[acc.componentType];
    const n = COMP[acc.type] || 1;
    const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const arr = new Ctor(bin.buffer, bin.byteOffset + start, acc.count * n);
    return Float32Array.from(arr);
  };
  const nodes = (json.nodes || []).map((n) => String(n.name || ''));
  // 节点静止姿态（局部 TRS）：目标骨架重定向需要它来算绑定姿态差量
  const restNodes = (json.nodes || []).map((n) => ({
    t: n.translation || [0, 0, 0],
    r: n.rotation || [0, 0, 0, 1],
    s: n.scale || [1, 1, 1],
  }));
  const out = [];
  for (const an of (json.animations || [])) {
    const tracks = [];
    let dur = 0;
    for (const ch of (an.channels || [])) {
      const smp = an.samplers[ch.sampler];
      if (!smp) continue;
      const path = ch.target && ch.target.path;
      if (path !== 'rotation' && path !== 'translation') continue;
      const times = readAcc(smp.input);
      const vals = readAcc(smp.output);
      dur = Math.max(dur, times.length ? times[times.length - 1] : 0);
      tracks.push({ node: (ch.target && ch.target.node) || 0, path, times, vals, bone: nodes[(ch.target && ch.target.node) || 0] || '' });
    }
    if (tracks.length) out.push({ name: String(an.name || ('take' + out.length)), duration: dur || 1, tracks, nodes, restNodes });
  }
  return out;
}

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
  // npm 包 fbx2gltf：二进制放在 bin/<平台>/FBX2glTF.exe（不挂 .bin，需直接指过去）
  const plat = { win32: 'Windows_NT', darwin: 'Darwin', linux: 'Linux' }[process.platform];
  const pkgDirs = [path.join(ROOT, 'node_modules', 'fbx2gltf', 'bin')];
  for (const base of pkgDirs) {
    for (const sub of [plat, 'windows', 'darwin', 'linux']) {
      for (const n of ['FBX2glTF.exe', 'FBX2glTF', 'Fbx2Gtlf.exe', 'Fbx2Gtlf']) {
        const p = path.join(base, sub || '', n);
        try { if (fs.existsSync(p)) return p; } catch { /* 继续 */ }
      }
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
  const anims = readGlbAnimations(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    .slice().sort((a, b) => b.duration - a.duration);
  if (!anims.length) { console.error('转换失败', name, '（GLB 无动画轨道）'); continue; }
  const anim = anims[0];
  const srcNodes = anim.restNodes || [];
  // 根位移裁剪：Mixamo 走跑 FBX 的根节点带大幅水平位移（跑 1 秒能位移 1 米），
  // 直接搬进来角色会瞬移/抖动。**按根节点索引裁掉水平分量**（保留纵向起伏），
  // 水平位移交给路径与关键帧系统 —— 与本插件"动作只演姿态、位移单独编排"的约定一致。
  const rootNodes = new Set((anim.nodes || []).map((nm, i) => (/^(RootNode|Armature|root|mixamorig:Hips)$/i.test(String(nm || '')) ? i : -1)).filter((i) => i >= 0));
  const tracks = (anim.tracks || []).map((t2) => {
    // 先重采样（30fps），再按根节点裁水平
    const rs = resampleTrack(t2.times, t2.vals, t2.path, 30);
    // **必须带骨骼名**：node 索引只在源 GLB 内有效，目标模型（xbot/explorer）节点顺序完全不同，
    // 直接用索引会把旋转施加到错误骨骼上 → 畸形扭曲（用户实测）。
    const bone = String(t2.bone || '').replace(/^mixamorig:?/i, '');
    const nodeIdx = (t2.node !== undefined) ? t2.node : 0;
    const restNode = (srcNodes && srcNodes[nodeIdx]) || null;
    const raw = {
      node: nodeIdx, bone, path: t2.path,
      times: b64(Float32Array.from(rs.times)), vals: b64(Float32Array.from(rs.vals)),
      // 源绑定姿态（局部旋转）：目标端据此做重定向，避免不同骨架绑定姿态导致的翻转/畸形
      rest: t2.path === 'rotation' && restNode && restNode.r ? Array.from(restNode.r) : null,
    };
    if (t2.path !== 'translation' || !rootNodes.has(t2.node)) return raw;
    const vals = Float32Array.from(rs.vals);
    for (let i = 0; i < vals.length; i += 3) { vals[i] = 0; vals[i + 2] = 0; }
    return { node: nodeIdx, bone, path: t2.path, times: raw.times, vals: b64(vals), rest: raw.rest };
  });
  const clip = {
    name,
    label,
    loop: !!loop,
    duration: +(+anim.duration).toFixed(3),
    // 来源骨架标记：这些动作是对着 awplanet 的 explorer 骨架手工录的（Mixamo 命名但局部坐标朝向
    // 与 xbot 那套资产不同）。只在同源骨架（explorer 系）上播放才正确，
    // 引擎按此字段过滤，避免套到 xbot 上出现「腿翻转 170°」的畸形。
    sourceRig: 'awplanet-explorer',
    tracks,
  };
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(clip));
  manifest.push({ file: name + '.json', name, label, duration: clip.duration, loop, sourceRig: clip.sourceRig });
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
