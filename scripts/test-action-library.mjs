// 内置动作库：成熟动作 clip（本地化）能被资产加载并真实播放
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const CLIP_DIR = path.join(ROOT, 'assets/director/clips');
const manifestPath = path.join(CLIP_DIR, 'manifest.json');
ok(fs.existsSync(manifestPath), '缺少动作库 manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { clips: [] };
ok(Array.isArray(manifest.clips), '动作库 manifest 结构错误');
// 动作库允许为空（只使用内置动作），不为空时逐项校验

// ① 每个动作文件结构正确
const clips = [];
for (const it of manifest.clips) {
  const f = path.join(CLIP_DIR, it.file);
  ok(fs.existsSync(f), '缺少动作文件 ' + it.file);
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok(Array.isArray(j.tracks) && j.tracks.length >= 40, it.name + ' 轨道数不足（' + (j.tracks || []).length + '）');
  ok(Number(j.duration) > 0.1, it.name + ' 时长无效');
  const badNode = j.tracks.filter((t) => !(Number(t.node) >= 0)).length;
  ok(badNode === 0, it.name + ' 存在未映射轨道 ' + badNode + ' 条');
  const badPath = j.tracks.filter((t) => t.path !== 'rotation' && t.path !== 'translation').length;
  ok(badPath === 0, it.name + ' 存在非法 path ' + badPath + ' 条');
  clips.push(j);
}

// ② 资产加载动作库后，clipByName 能找到
const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
const asset = E.decodeModelPack(pack, E.decodeActionClips(clips));
for (const it of manifest.clips) {
  const c = asset.clipByName(it.name);
  ok(!!c, '资产缺少动作 ' + it.name);
  if (c) ok(c.tracks.length >= 40 && c.duration > 0.1, it.name + ' 加载后轨道/时长异常');
}

// ③ 真实播放：skinModel 逐帧采样，必须有运动且无跳变
for (const it of manifest.clips) {
  const c = asset.clipByName(it.name);
  if (!c) continue;
  const steps = Math.min(40, Math.max(10, Math.round(c.duration * 10)));
  let prev = null, maxJump = 0, total = 0, n = 0, moved = 0;
  for (let i = 0; i <= steps; i++) {
    const t = (c.duration * i) / steps;
    const sk = E.skinModel(asset, it.name, t, null, null, {});
    if (!sk) { ok(false, it.name + ' 蒙皮返回空'); break; }
    if (prev) {
      let m = 0;
      const N = Math.min(sk.pos.length, prev.length);
      for (let k = 0; k < N; k += 3) {
        const d = Math.hypot(sk.pos[k] - prev[k], sk.pos[k + 1] - prev[k + 1], sk.pos[k + 2] - prev[k + 2]);
        if (d > m) m = d;
      }
      maxJump = Math.max(maxJump, m); total += m; n++;
      if (m > 0.002) moved++;
    }
    if (!prev || prev.length !== sk.pos.length) prev = new Float32Array(sk.pos.length);
    prev.set(sk.pos);
  }
  ok(moved >= n * 0.5, it.name + ' 动作几乎没有运动（moving ' + moved + '/' + n + '）');
  ok((total / n) > 0.01, it.name + ' 平均运动量过小（' + ((total / n) * 1000).toFixed(1) + 'mm）');
  const fast = /knockdown|hit_recoil|jump|dance|low_sweep|spear_ground|crouch/.test(it.name);
  const jumpLimit = fast ? 2.0 : 1.2;
  ok(maxJump < jumpLimit, it.name + ' 存在跳变（单帧 ' + (maxJump * 1000).toFixed(0) + 'mm，限 ' + jumpLimit * 1000 + 'mm）');
}

// ④ 内置片段必须保持原样（动作库只追加，不覆盖）
{
  const packRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/xbot.json'), 'utf8'));
  const builtinNames = (packRaw.animations || []).map((a) => a.name);
  for (const nm of builtinNames) {
    const c = asset.clipByName(nm);
    ok(!!c, '内置动作丢失：' + nm);
    const raw = (packRaw.animations || []).find((a) => a.name === nm);
    ok(c && c.tracks.length === raw.tracks.length, '内置动作 ' + nm + ' 轨道数被改动（' + (c ? c.tracks.length : 0) + ' vs ' + raw.tracks.length + '）');
  }
  ok(builtinNames.includes('idle') && builtinNames.includes('walk'), '内置应含待机与行走');
}

if (errs.length) {
  console.error('✗ 动作库测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 动作库通过：' + manifest.clips.length + ' 个打斗动作可加载、真实播放、连续无跳变；内置待机/行走不被覆盖');
process.exit(0);
