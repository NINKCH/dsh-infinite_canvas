// 资产转换脚本（长期保留）：把 _refs 里的 GLB 转成导演台可加载的紧凑格式。
// 输出：assets/director/models/<id>.json（Float32/Uint16 以 base64 存放，体积约为二进制 1.33 倍）
//
// 用法：node scripts/build-director-models.mjs [--src <dir>] [--out <dir>]
// 只挑白膜预演需要的：网格 + 蒙皮 + 骨架 + 少量动作（可选裁剪）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SRC = argOf('--src', 'D:/Code/deepseek-plugin/_refs/assets/_dl');
const OUT = argOf('--out', path.join(ROOT, 'assets/director/models'));

/** 每个模型的裁剪配置：id → {file, height, clips:[名字/正则], label} */
const PLAN = [
  { id: 'xbot', file: 'human_xbot.glb', height: 1.7, label: '关节人偶 · X', clips: [/idle/i, /run/i, /walk/i, /sneak/i] },
  { id: 'soldier', file: 'human_soldier.glb', height: 1.8, label: '关节人偶 · 士兵', clips: [/idle/i, /walk/i, /run/i, /tpose/i] },
  { id: 'cesiumman', file: 'human_cesiumman.glb', height: 1.7, label: '白模 · 简人', clips: null },
];

function b64(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const p of PLAN) {
  const file = path.join(SRC, p.file);
  if (!fs.existsSync(file)) { console.log('SKIP', p.id, '(缺文件 ' + p.file + ')'); continue; }
  const raw = fs.readFileSync(file);
  const asset = E.parseGlb(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const b = E.assetBounds(asset);
  // 选定动作（保留少量，控制体积）
  let clips = asset.animations;
  if (p.clips) clips = asset.animations.filter((a) => p.clips.some((re) => re.test(a.name)));
  if (!clips.length) clips = asset.animations.slice(0, 1);
  const out = {
    id: p.id,
    label: p.label,
    height: p.height,
    // 原始网格高度（运行时用 height/rawHeight 作为缩放）
    rawHeight: +b.height.toFixed(4),
    verts: asset.verts,
    tris: asset.tris,
    positions: b64(Float32Array.from(asset.positions)),
    normals: b64(Float32Array.from(asset.normals && asset.normals.length === asset.positions.length ? asset.normals : new Float32Array(asset.positions.length))),
    indices: b64(asset.indices instanceof Uint32Array ? Uint32Array.from(asset.indices) : Uint16Array.from(asset.indices)),
    indexBits: asset.indices instanceof Uint32Array ? 32 : 16,
    joints: asset.joints ? b64(Float32Array.from(asset.joints)) : null,
    weights: asset.weights ? b64(Float32Array.from(asset.weights)) : null,
    bones: (asset.bones || []).map((x) => ({ nodeIdx: x.nodeIdx, name: x.name, parent: x.parent, t: x.t, r: x.r, s: x.s, ibm: x.ibm })),
    nodes: asset.nodes || [],
    parentOfAll: asset.parentOfAll || [],
    animations: clips.map((a) => ({
      name: a.name,
      duration: +a.duration.toFixed(3),
      tracks: a.tracks.map((t) => ({
        node: t.node, path: t.path,
        times: b64(Float32Array.from(t.times)),
        vals: b64(Float32Array.from(t.vals)),
      })),
    })),
  };
  const json = JSON.stringify(out);
  const dst = path.join(OUT, p.id + '.json');
  fs.writeFileSync(dst, json);
  manifest.push({ id: p.id, label: p.label, height: p.height, clips: out.animations.map((a) => a.name), kb: Math.round(json.length / 1024) });
  console.log('OK', p.id.padEnd(12), (json.length / 1024).toFixed(0) + 'KB', '| clips:', out.animations.map((a) => a.name).join(','));
}
// 清单文件（运行时只读它，按需加载具体模型）
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ version: 1, models: manifest }, null, 2));
console.log('manifest:', path.join(OUT, 'index.json'));
