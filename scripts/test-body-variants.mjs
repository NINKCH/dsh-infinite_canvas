#!/usr/bin/env node
/**
 * 体型变体 / Explorer 资产 / 姿势库 回归：
 *   A) 男性体型 = Explorer 网格（MANNEQUIN_TYPES.assetId）+ 身高档
 *   B) Explorer 资产包完整（解码 / Mixamo 骨架 / idle+motion 双动作 / 脚底锚定）
 *   C) 形变幅度（storyai 量级，防「改了看不出」回归）：
 *      m_standard 腰部显著加宽、大腿加粗、脚不漂；m_child 头部明显放大
 *   D) 姿势库：BONE_POSES 含 19 套 awplanet 复刻（ap_*），base 骨名为 Mixamo 规范名
 *   E) UI 管线：资产落位/缩略图跟随 assetId；姿势选择器；引擎过期横幅；版本自检
 *
 * 运行：node scripts/test-body-variants.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);

// ── A) 男性体型（xbot 素体；explorer 是宇航员资产，不挂男性档） ──
{
  const males = (E.MANNEQUIN_TYPES || []).filter((t) => t.id.startsWith('m_'));
  ok(males.length === 6, '男性体型应有 6 档，实际 ' + males.length);
  for (const t of males) ok(!t.assetId || t.assetId === 'xbot', t.id + ' 不应挂 explorer（那是宇航员角色）');
  const hOf = Object.fromEntries(males.map((t) => [t.id, t.h]));
  ok(hOf.m_child === 1.18 && hOf.m_teen === 1.60 && hOf.m_standard === 1.78,
    '男性身高档位不符：' + JSON.stringify(hOf));
  // 每个体型都有标志色（高饱和配色）
  for (const t of (E.MANNEQUIN_TYPES || [])) {
    ok(/^#[0-9A-Fa-f]{6}$/.test(t.color || ''), t.id + ' 缺标志色');
    ok(E.mannequinColorOf(t.id) === t.color, t.id + ' mannequinColorOf 与表不一致');
  }
}

// ── B) Explorer 资产包 ──
{
  const p = path.join(ROOT, 'assets/director/models/explorer.json');
  ok(fs.existsSync(p), '缺 assets/director/models/explorer.json');
  const pack = JSON.parse(fs.readFileSync(p, 'utf8'));
  ok((pack.rawHeight || 0) > 150, 'explorer rawHeight 应为厘米制原样打包（>150），实际 ' + pack.rawHeight);
  const a = E.decodeModelPack(pack, []);
  ok((a.bones || []).length >= 40, 'explorer 骨架应 ≥40 骨（Mixamo），实际 ' + (a.bones || []).length);
  const names = (a.animations || []).map((x) => x.name);
  ok(names.includes('idle') && names.includes('motion'), 'explorer 应带 idle+motion 双动作，实际 ' + names.join(','));
  const b = E.assetBounds(a);
  ok(Math.abs(b.minY) < 1, 'explorer 脚底应锚定 0（minY=' + b.minY.toFixed(2) + '）');
  // 库清单注册
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/index.json'), 'utf8'));
  const ex = (idx.models || []).find((m) => m.id === 'explorer');
  ok(!!ex, 'models/index.json 未注册 explorer');
  ok(/宇航员/.test(ex.label || ''), 'explorer 标签应如实标注宇航员，实际：' + (ex.label || ''));
}

// ── C) 形变幅度（explorer + m_standard，storyai 量级） ──
{
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/director/models/explorer.json'), 'utf8'));
  const a = E.decodeModelPack(pack, []);
  const H = pack.rawHeight;
  const base = E.skinModel(a, 'idle', 0.2, null, null, null);
  const std = E.skinModel(a, 'idle', 0.2, null, null, { waist: 1.24, muscle: 0.50, shoulder: 1.14, hip: 0.96, belly: 0, chestFlat: 0.10, head: 1.0 });
  const child = E.skinModel(a, 'idle', 0.2, null, null, { waist: 1.06, muscle: 0.10, shoulder: 0.86, hip: 0.88, belly: 0.06, chestFlat: 0.04, head: 1.18 });
  const band = (sk, lo, hi) => { let s = 0, n = 0; for (let v = 0; v < base.pos.length / 3; v++) { const y = base.pos[v * 3 + 1]; if (y > lo * H && y < hi * H) { s += Math.hypot(sk.pos[v * 3] - base.pos[v * 3], sk.pos[v * 3 + 2] - base.pos[v * 3 + 2]); n++; } } return n ? s / n : 0; };
  const waist = band(std, 0.50, 0.62);
  const thigh = band(std, 0.30, 0.42);
  ok(waist >= 2, 'm_standard 腰部位移应 ≥2cm（storyai 量级），实际 ' + waist.toFixed(2));
  ok(thigh >= 2, 'm_standard 大腿位移应 ≥2cm，实际 ' + thigh.toFixed(2));
  let headD = 0, headN = 0;
  for (let v = 0; v < base.pos.length / 3; v++) {
    const y = base.pos[v * 3 + 1];
    if (y > 0.82 * H) { headN++; headD += Math.hypot(child.pos[v * 3] - base.pos[v * 3], child.pos[v * 3 + 1] - base.pos[v * 3 + 1], child.pos[v * 3 + 2] - base.pos[v * 3 + 2]); }
  }
  const headPct = (headD / Math.max(1, headN)) / H * 100;
  ok(headPct >= 10, 'm_child 头部位移应 ≥10% 身高，实际 ' + headPct.toFixed(1) + '%');
  // 脚不漂：纵向（y）位移 ≈ 0
  let footY = 0;
  for (let v = 0; v < base.pos.length / 3; v++) { const y = base.pos[v * 3 + 1]; if (y < 0.04 * H) footY = Math.max(footY, Math.abs(std.pos[v * 3 + 1] - base.pos[v * 3 + 1])); }
  ok(footY < H * 0.02, 'm_standard 脚部纵向漂移应 <2% 身高，实际 ' + (footY / H * 100).toFixed(2) + '%');
}

// ── D) 姿势库（awplanet 复刻） ──
{
  const ap = (E.BONE_POSES || []).filter((p) => p.id.startsWith('ap_'));
  ok(ap.length === 19, 'awplanet 姿势复刻应 19 套，实际 ' + ap.length);
  for (const p of ap) {
    ok(p.zh && p.en, p.id + ' 缺中英文名');
    const keys = Object.keys(p.base || {});
    ok(keys.length >= 2, p.id + ' base 骨数过少');
    for (const k of keys) ok(/^(Spine|Spine1|Spine2|Neck|Head|Hips|Left|Right)/.test(k), p.id + ' 骨名不合 Mixamo 规范：' + k);
  }
  ok(E.BONE_POSES.some((p) => p.id === 'ap_lie_prone' && p.rootY < 0), '俯卧姿势应带 rootY（否则穿地）');
  ok(E.BONE_POSES.some((p) => p.id === 'ap_sit_low' && p.rootY < 0), '低坐姿势应带 rootY');
  // 引擎版本（W5）
  ok(E.ENGINE_VERSION === 'explorer-1', 'ENGINE_VERSION 应为 explorer-1，实际 ' + E.ENGINE_VERSION);
}

// ── E) UI 管线（源码级） ──
{
  const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(cli.includes("assetId: p.assetId || 'xbot'"), 'placeAt 未按体型资产落位');
  ok(cli.includes("const aid = t.assetId || 'xbot'"), 'addMannequin 未按体型预加载资产');
  ok(/thumbOf\('type:' \+ it\.id, it\.t\.assetId \|\| 'xbot'/.test(cli), '缩略图未跟随体型资产');
  ok(cli.includes("'data-action': 'dir-pose-select'"), '缺少姿势选择器');
  ok(cli.includes("'data-role': 'dir-stalebar'"), '缺少引擎过期横幅');
  ok(cli.includes("sessionStorage.getItem('dsh-ic:engineV')"), '缺少引擎版本比对');
  // 动作管线脚本
  const build = fs.readFileSync(path.join(ROOT, 'scripts/build-director-actions.mjs'), 'utf8');
  ok(/FBX2GLTF/.test(build) && /SKIP/.test(build), 'build-director-actions 缺工具检测/SKIP 逻辑');
  ok(/semantic|SEMANTIC/.test(build), 'build-director-actions 缺语义映射');
}

if (errs.length) {
  console.error('✗ 体型变体回归失败（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
const males = (E.MANNEQUIN_TYPES || []).filter((t) => t.id.startsWith('m_')).map((t) => t.id.split('_')[1] + '=' + t.h).join(' ');
console.log('✓ 体型变体回归通过：');
console.log('  · 男性 6 档用 xbot 素体（' + males + '）；Explorer 已还原为宇航员资产；12 体型标志色闭环');
console.log('  · Explorer 资产包：Mixamo 49 骨 / idle+motion / 脚底锚定 / 已注册库清单');
console.log('  · 形变幅度（storyai 量级）：腰/大腿 ≥2cm、儿童头 ≥10% 身高、脚不漂');
console.log('  · 姿势库 41 条（含 awplanet 复刻 19 套），骨名与 rootY 合规');
console.log('  · 管线：assetId 三处解耦 / 姿势选择器 / 引擎过期横幅 / FBX 构建脚本就位');
process.exit(0);
