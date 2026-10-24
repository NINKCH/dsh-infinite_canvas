// 正式回归：PBR 材质（Oren-Nayar / GGX）与 AgX 色调映射
//   数值部分用与着色器一致的公式在 JS 里复算，校验标定点与单调性。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'assets/director/engine.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ── ① 源码级：公式与 Blender 对应实现一致 ──
ok(/float orenNayar\(vec3 n, vec3 L, vec3 V, float rough\)/.test(src), '缺少 Oren-Nayar 漫反射');
ok(/float a = 1\.0 - 0\.5 \* \(s2 \/ \(s2 \+ 0\.33\)\);/.test(src), 'Oren-Nayar a 系数与 Blender 不一致');
ok(/float b = 0\.45 \* \(s2 \/ \(s2 \+ 0\.09\)\);/.test(src), 'Oren-Nayar b 系数与 Blender 不一致');
ok(/float ggx_D\(float NH, float a2\)/.test(src), '缺少 GGX D 项');
ok(/return a2 \/ \(3\.14159265 \* d \* d\);/.test(src), 'GGX D 公式与 Blender 不一致');
ok(/float ggx_G1\(float NX, float a2\)/.test(src), '缺少 GGX Smith G1');
ok(/return 2\.0 \/ \(1\.0 \+ sqrt\(1\.0 \+ a2 \* \(1\.0 \/ max\(NX \* NX, 1e-4\) - 1\.0\)\)\);/.test(src), 'GGX G1 公式与 Blender 不一致');
ok(/vec3 specGGX\(/.test(src), '缺少 GGX 组合 BRDF');
ok(/vec3 skyIrradiance\(vec3 n\)/.test(src), '缺少程序化天空环境光');
ok(/vec3 tonemapAgX\(vec3 c\)/.test(src), '缺少 AgX 风格色调映射');
ok(/uniform float uRoughness;/.test(src) && /uniform float uMetallic;/.test(src), '缺少材质 uniform');
ok(/col = \(uTonemap > 0\.5\) \? tonemapAgX\(col\)/.test(src), '色调映射未接入');

// ── ② 数值：按着色器公式在 JS 复算 ──
const orenNayar = (NL, NV, dotLV, rough) => {
  const s2 = rough * rough;
  const a = 1.0 - 0.5 * (s2 / (s2 + 0.33));
  const b = 0.45 * (s2 / (s2 + 0.09));
  const nl = Math.max(NL, 0);
  const nv = Math.max(NV, 0.001);
  let t = dotLV - nl * nv;
  t = t > 0 ? t / Math.max(nl, nv) : 0;
  return { v: nl * (a + b * t), a, b };
};
// roughness=0 → a=1, b=0 → 纯 Lambert
{
  const r0 = orenNayar(1, 1, 1, 0);
  ok(Math.abs(r0.a - 1) < 1e-6 && Math.abs(r0.b) < 1e-6, 'roughness=0 时 Oren-Nayar 应退化为 Lambert');
  ok(Math.abs(r0.v - 1) < 1e-6, 'Lambert 极限值应为 NL=1');
  // roughness 增大 → a 减小（更"扁"）
  const r1 = orenNayar(1, 1, 1, 1);
  ok(r1.a < r0.a, '粗糙度增大时 a 应减小');
  ok(r1.b > r0.b, '粗糙度增大时 b 应增大');
}
const ggx_D = (NH, a2) => { const NH2 = NH * NH; const d = (1 - NH2) + a2 * NH2; return a2 / (Math.PI * d * d); };
const ggx_G1 = (NX, a2) => 2 / (1 + Math.sqrt(1 + a2 * (1 / Math.max(NX * NX, 1e-4) - 1)));
{
  // 峰值：NH=1 时 D = 1/(π*a2)
  const a = 0.3, a2 = a * a;
  ok(Math.abs(ggx_D(1, a2) - 1 / (Math.PI * a2)) < 1e-6, 'GGX D 峰值应为 1/(π·a²)');
  ok(ggx_D(0.5, a2) < ggx_D(1, a2), 'GGX D 应随 NH 单调增');
  ok(ggx_G1(1, a2) <= 1.0 + 1e-6 && ggx_G1(0.2, a2) < ggx_G1(1, a2), 'Smith G1 应在 (0,1] 且随 NX 增');
}
// 色调映射标定：0.18 线性 → 约 0.43 显示（sRGB 编码后）
const tonemap = (c) => {
  const W = 2.6;
  const x = Math.max(c, 0);
  let y = (x * (1 + x / (W * W))) / (1 + x);
  y = Math.min(Math.max(y, 0), 1);
  y = y + ((y * y * (3 - 2 * y)) - y) * 0.18;
  return Math.pow(y, 1 / 2.2);
};
{
  const mid = tonemap(0.18);
  ok(mid > 0.36 && mid < 0.50, '18% 灰应映射到 0.36~0.50，实际 ' + mid.toFixed(3));
  ok(tonemap(0.01) < 0.12, '暗部不应被抬亮（实际 ' + tonemap(0.01).toFixed(3) + '）');
  ok(tonemap(1.0) > 0.7 && tonemap(1.0) < 0.9, '中高光应在 0.7~0.9，实际 ' + tonemap(1.0).toFixed(3));
  ok(tonemap(6.0) > 0.94, '高光应平滑接近 1.0');
  // 单调性
  let prev = -1, mono = true;
  for (let c = 0; c <= 4; c += 0.05) { const v = tonemap(c); if (v < prev - 1e-9) mono = false; prev = v; }
  ok(mono, '色调映射必须单调递增');
}

if (errs.length) {
  console.error('✗ PBR/色调映射测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ PBR/AgX 测试通过（Oren-Nayar 系数与 Blender 一致 / GGX D·G1 公式与峰值 / 天空环境光 / 色调映射标定与单调性）');
process.exit(0);
