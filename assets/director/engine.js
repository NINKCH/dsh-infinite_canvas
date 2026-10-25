export const ENGINE_VERSION = 'ground-off-1';
/**
 * 3D 导演台引擎（独立 ES 模块，零依赖）。
 *
 * 为什么拆出去：导演台的数学/几何/渲染/解析器是纯逻辑，不依赖 React 与画布状态；
 * 放在 client.js 里既难测又难维护。本模块**自包含**（无任何 import），浏览器经
 * plugin-asset 路由动态 import()，Node 测试直接 ESM import——两端同一份代码。
 *
 * 设计口径（自己的 API，不照搬任何库）：
 *   · 场景是纯 JSON：{ objects, cameras, lights, env, activeCameraId, shot }
 *   · 几何以「凸面片」表达（{v:[...], shade}），世界坐标在构建时烘焙；
 *   · 渲染两条路径：WebGL 深度缓冲（主）与 Canvas2D 画家算法（兼容），
 *     同一个数据、同一个接口 draw(scene, opts)；
 *   · 白膜：所有默认资产不着色（clay #e2e4e6），靠光照读形体。
 */

// ============================================================
// 向量
// ============================================================
export const v3 = (x, y, z) => ({ x: x || 0, y: y || 0, z: z || 0 });
export const vAdd = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const vSub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vMul = (a, k) => v3(a.x * k, a.y * k, a.z * k);
export const vDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vCross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const vLen = (a) => Math.sqrt(vDot(a, a)) || 0;
export const vNorm = (a) => { const l = vLen(a) || 1; return vMul(a, 1 / l); };

/** 相机 up 向量（含荷兰角 roll：绕视线轴旋转 up）。 */
export function cameraUp(cam) {
  const fwd = vNorm(vSub(cam.target, cam.pos));
  const roll = (Number(cam.roll) || 0) * Math.PI / 180;
  if (!roll) return v3(0, 1, 0);
  const side = vCross(fwd, v3(0, 1, 0));
  return vNorm(vAdd(vMul(v3(0, 1, 0), Math.cos(roll)), vMul(side, Math.sin(roll))));
}

/** 视图基（世界→相机）。 */
export function directorLookAt(eye, target, up) {
  const zAxis = vNorm(vSub(eye, target));
  const xAxis = vNorm(vCross(up || v3(0, 1, 0), zAxis));
  const yAxis = vCross(zAxis, xAxis);
  return {
    xAxis, yAxis, zAxis, eye,
    toCam(p) {
      const d = vSub(p, this.eye);
      return v3(vDot(d, this.xAxis), vDot(d, this.yAxis), vDot(d, this.zAxis));
    },
  };
}
export function directorViewOf(cam) { return directorLookAt(cam.pos, cam.target, cameraUp(cam)); }

/** 透视投影：相机空间 → NDC；在近平面后返回 null。 */
export function directorProject(camPt, fovDeg, aspect) {
  const near = 0.05;
  if (camPt.z >= -near) return null;
  const f = 1 / Math.tan((Math.max(5, Math.min(150, fovDeg)) * Math.PI / 180) / 2);
  return {
    x: (f * camPt.x / (aspect || 1)) / -camPt.z,
    y: (f * camPt.y) / -camPt.z,
    z: -camPt.z,
  };
}

/**
 * 世界点 → 屏幕像素（与 GL 投影矩阵严格同构）。
 * 关键：x 必须用 w/2、y 用 h/2 缩放；早期版本两轴都用 min(w,h)/2，
 * 在非方形视口下水平坐标被压缩（例：16:9 时只有 0.5625 倍），越靠边偏移越大 →
 * gizmo/标签/点选全部「画在这里、实际要点旁边」。
 */
export function directorScreenOf(cam, w, h, p) {
  const view = directorViewOf(cam);
  const nd = directorProject(view.toCam(p), cam.fov, w / Math.max(1, h));
  if (!nd) return null;
  return { x: w / 2 + nd.x * (w / 2), y: h / 2 - nd.y * (h / 2), z: nd.z };
}

/** 屏幕点 → 世界空间射线方向（gizmo 轴拖拽与精确拾取的基础）。 */
export function screenRayDir(cam, w, h, sx, sy) {
  const aspect = w / Math.max(1, h);
  const f = 1 / Math.tan((Math.max(5, Math.min(150, cam.fov)) * Math.PI / 180) / 2);
  const nx = (sx - w / 2) / (w / 2), ny = (h / 2 - sy) / (h / 2);
  const d = vNorm(v3(nx * aspect / f, ny / f, -1));
  const view = directorViewOf(cam);
  return vNorm(vAdd(vAdd(vMul(view.xAxis, d.x), vMul(view.yAxis, d.y)), vMul(view.zAxis, d.z)));
}

/**
 * 轴拖拽核心：给定轴（origin+dir）与鼠标射线（eye+dir），返回轴上离射线最近的参数 s。
 * 拖动位移 = s_now - s_start，新位置 = 起点 + axis * 位移。这是三维软件通用做法，
 * 比拿屏幕 dx 凑系数精确得多（鼠标斜着拖也不会漂）。
 */
export function axisDragDelta(origin, axisDir, eye, rayDir) {
  const d1 = vNorm(axisDir), d2 = vNorm(rayDir);
  const w0 = vSub(origin, eye);
  const a = vDot(d1, d1), b = vDot(d1, d2), c = vDot(d2, d2);
  const d = vDot(d1, w0), e = vDot(d2, w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-9) return 0;
  return (b * e - c * d) / denom;
}

/**
 * 局部轴缩放换算：delta>0 表示从中心沿轴正方向向外拖，结果必须放大；delta<0 缩小。
 * 指数映射不会穿过 0，近远视角下都稳定；snap=true 时按 0.1 倍率吸附。
 */
export function axisScaleFromDelta(base, delta, refLen, snap) {
  const b = Math.max(0.01, Number(base) || 1);
  const r = Math.max(0.05, Number(refLen) || 1);
  let next = b * Math.exp(((Number(delta) || 0) / r) * 0.7);
  if (snap) next = Math.round(next * 10) / 10;
  return Math.max(0.15, Math.min(8, next));
}

// ============================================================
// 白膜材质与颜色
// ============================================================
export const CLAY = '#e2e4e6';
export function directorHexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || CLAY));
  const n = m ? parseInt(m[1], 16) : 0xe2e4e6;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function hexToRgb255(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || CLAY));
  const n = m ? parseInt(m[1], 16) : 0xe2e4e6;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ============================================================
// 几何：凸面片构建（全部低面数、底部落地 y=0）
// ============================================================
export function directorFaceNormal(v) {
  if (!v || v.length < 3) return v3(0, 1, 0);
  return vNorm(vCross(vSub(v[1], v[0]), vSub(v[2], v[0])));
}
export function directorShadeColor(hex, k) {
  const [r, g, b] = hexToRgb255(hex);
  const c = (x) => Math.max(0, Math.min(255, Math.round(x * k)));
  return 'rgb(' + c(r) + ',' + c(g) + ',' + c(b) + ')';
}
export function directorBoxFaces(cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const p = (x, y, z) => v3(x, y, z);
  return [
    { v: [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)], shade: 0.06 },
    { v: [p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)], shade: -0.06 },
    { v: [p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)], shade: 0.12 },
    { v: [p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)], shade: -0.12 },
    { v: [p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0)], shade: 0.20 },
    { v: [p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)], shade: -0.20 },
  ];
}
export function directorSphereFaces(cx, cy, cz, r, seg) {
  const n = Math.max(6, seg || 14), m = Math.max(4, Math.round(n / 2));
  const out = [];
  const pt = (i, j) => {
    const phi = (i / n) * Math.PI * 2, th = (j / m) * Math.PI;
    return v3(cx + r * Math.sin(th) * Math.cos(phi), cy + r * Math.cos(th), cz + r * Math.sin(th) * Math.sin(phi));
  };
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    out.push({ v: [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)], shade: 0.04 + 0.18 * (Math.cos((i + 0.5) / n * Math.PI * 2) * 0.5 + 0.5) });
  }
  return out;
}
export function directorCylinderFaces(cx, cy, cz, r, hgt, seg) {
  const n = Math.max(6, seg || 14), out = [];
  const ring = (y, i) => { const a = (i / n) * Math.PI * 2; return v3(cx + r * Math.cos(a), y, cz + r * Math.sin(a)); };
  for (let i = 0; i < n; i++) out.push({ v: [ring(cy - hgt / 2, i), ring(cy - hgt / 2, i + 1), ring(cy + hgt / 2, i + 1), ring(cy + hgt / 2, i)], shade: 0.02 + 0.18 * (0.5 + 0.5 * Math.cos((i + 0.5) / n * Math.PI * 2)) });
  const top = [], bot = [];
  for (let i = 0; i < n; i++) { top.push(ring(cy + hgt / 2, i)); bot.push(ring(cy - hgt / 2, n - i)); }
  out.push({ v: top, shade: 0.22, flat: true }, { v: bot, shade: -0.18, flat: true });
  return out;
}
/** 圆锥（底面落地）。 */
export function directorConeFaces(cx, cy, cz, r, h, seg) {
  const n = Math.max(6, seg || 14), out = [];
  const ring = (i) => { const a = (i / n) * Math.PI * 2; return v3(cx + r * Math.cos(a), cy, cz + r * Math.sin(a)); };
  const apex = v3(cx, cy + h, cz);
  for (let i = 0; i < n; i++) out.push({ v: [ring(i), ring(i + 1), apex], shade: 0.05 + 0.18 * (0.5 + 0.5 * Math.cos((i + 0.5) / n * Math.PI * 2)) });
  const base = []; for (let i = 0; i < n; i++) base.push(ring(n - i));
  out.push({ v: base, shade: -0.16, flat: true });
  return out;
}
/** 四棱锥（方形底）。 */
export function directorPyramidFaces(cx, cy, cz, w, d, h) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, apex = v3(cx, cy + h, cz);
  const q = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    out.push({ v: [v3(a[0], cy, a[1]), v3(b[0], cy, b[1]), apex], shade: i % 2 ? 0.10 : -0.04 });
  }
  out.push({ v: [v3(x0, cy, z0), v3(x0, cy, z1), v3(x1, cy, z1), v3(x1, cy, z0)], shade: -0.18, flat: true });
  return out;
}
/** 圆环体（平放）。 */
export function directorTorusFaces(cx, cy, cz, R, r, seg, tube) {
  const n = Math.max(8, seg || 20), m = Math.max(6, tube || 10), out = [];
  const pt = (i, j) => {
    const th = (i / n) * Math.PI * 2, ph = (j / m) * Math.PI * 2;
    const rr = R + r * Math.cos(ph);
    return v3(cx + rr * Math.cos(th), cy + r * Math.sin(ph) + r, cz + rr * Math.sin(th));
  };
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    out.push({ v: [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)], shade: 0.02 + 0.2 * (Math.cos((j + 0.5) / m * Math.PI * 2) * 0.5 + 0.5) });
  }
  return out;
}
/** 胶囊体（圆柱 + 上下半球，落地）。 */
export function directorCapsuleFaces(cx, cy, cz, r, h, seg) {
  const cylH = Math.max(0.05, h - 2 * r);
  return [
    ...directorCylinderFaces(cx, cy + r + cylH / 2, cz, r, cylH, seg),
    ...directorSphereFaces(cx, cy + r + cylH, cz, r, 12),
    ...directorSphereFaces(cx, cy + r, cz, r, 12),
  ];
}
/** 圆盘（很薄的圆柱）。 */
export function directorDiskFaces(cx, cy, cz, r) {
  return directorCylinderFaces(cx, cy + 0.015, cz, r, 0.03, 20);
}
/** 半圆拱（立着的半圆环，两端封口）。 */
export function directorHalfArcFaces(cx, cy, cz, R, r) {
  const n = 14, m = 8, out = [];
  const pt = (i, j) => {
    const th = (i / n) * Math.PI, ph = (j / m) * Math.PI * 2;
    const rr = R + r * Math.cos(ph);
    return v3(cx + rr * Math.cos(th), cy + rr * Math.sin(th), cz + r * Math.sin(ph));
  };
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    out.push({ v: [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)], shade: 0.02 + 0.18 * (0.5 + 0.5 * Math.cos((j + 0.5) / m * Math.PI * 2)) });
  }
  // 两端封口（半圆环面）
  for (const zz of [cz - r, cz + r]) {
    const outer = [], inner = [];
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * Math.PI;
      outer.push(v3(cx + (R + r) * Math.cos(th), cy + (R + r) * Math.sin(th), zz));
      inner.push(v3(cx + (R - r) * Math.cos(th), cy + (R - r) * Math.sin(th), zz));
    }
    const cap = [];
    for (let i = 0; i < n; i++) { cap.push(outer[i], outer[i + 1], inner[i + 1], inner[i]); }
    out.push({ v: cap, shade: zz < cz ? -0.1 : 0.12, flat: true });
  }
  return out;
}
/** 半圆柱（拱形壳，开口朝下，沿 X 轴）。 */
export function directorHalfCylinderFaces(cx, cy, cz, r, len) {
  const n = 14, out = [];
  const pt = (i, x) => {
    const th = (i / n) * Math.PI;
    return v3(cx - len / 2 + x * len, cy + r * Math.sin(th), cz + r * Math.cos(th));
  };
  for (let i = 0; i < n; i++) {
    out.push({ v: [pt(i, 0), pt(i + 1, 0), pt(i + 1, 1), pt(i, 1)], shade: 0.02 + 0.2 * (0.5 + 0.5 * Math.cos((i + 0.5) / n * Math.PI)) });
  }
  for (const x of [0, 1]) {
    const cap = [];
    for (let i = 0; i < n; i++) cap.push(v3(cx - len / 2 + x * len, cy, cz), pt(i + 1, x), pt(i, x));
    out.push({ v: cap, shade: x ? 0.1 : -0.1, flat: true });
  }
  return out;
}
/** 多边形柱（XZ 多边形沿 Y 拉伸；poly 为 [[x,z],…] 逆时针）。 */
export function polyPrismFaces(poly, y0, y1, cx, cz) {
  const n = poly.length, out = [];
  const P = (i, y) => v3(cx + poly[i][0], y, cz + poly[i][1]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push({ v: [P(i, y0), P(j, y0), P(j, y1), P(i, y1)], shade: 0.02 + 0.18 * (0.5 + 0.5 * Math.cos((i + 0.5) / n * Math.PI * 2)) });
  }
  const top = [], bot = [];
  for (let i = 0; i < n; i++) { top.push(P(i, y1)); bot.push(P(n - 1 - i, y0)); }
  out.push({ v: top, shade: 0.2, flat: true }, { v: bot, shade: -0.18, flat: true });
  return out;
}
/** 多边形台（底/顶两个相似多边形，用于屋顶与台基；kTop 为顶面收缩比）。 */
export function polyFrustumFaces(poly, y0, y1, kTop, cx, cz) {
  const cx0 = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cz0 = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const top = poly.map((p) => [cx0 + (p[0] - cx0) * kTop, cz0 + (p[1] - cz0) * kTop]);
  const n = poly.length, out = [];
  const P = (i, y, which) => v3(cx + (which === 'top' ? top : poly)[i][0], y, cz + (which === 'top' ? top : poly)[i][1]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push({ v: [P(i, y0, 'bot'), P(j, y0, 'bot'), P(j, y1, 'top'), P(i, y1, 'top')], shade: 0.04 + 0.16 * (0.5 + 0.5 * Math.cos((i + 0.5) / n * Math.PI * 2)) });
  }
  const topRing = [], botRing = [];
  for (let i = 0; i < n; i++) { topRing.push(P(i, y1, 'top')); botRing.push(P(n - 1 - i, y0, 'bot')); }
  out.push({ v: topRing, shade: 0.2, flat: true }, { v: botRing, shade: -0.18, flat: true });
  return out;
}

// ============================================================
// 角色预设（12 个体型；全部白膜）
// ============================================================
export const ACTOR_PRESETS = [
  { id: 'male_standard', zh: '男性 · 标准', en: 'Male · Standard', h: 1.78, shoulder: 1.00, waist: 0.92, hip: 0.94, limb: 1.00, head: 1.00, belly: 0 },
  { id: 'female_standard', zh: '女性 · 标准', en: 'Female · Standard', h: 1.65, shoulder: 0.88, waist: 0.80, hip: 1.10, limb: 0.88, head: 1.00, belly: 0 },
  { id: 'male_teen', zh: '男性 · 少年', en: 'Male · Teen', h: 1.58, shoulder: 0.90, waist: 0.84, hip: 0.92, limb: 0.88, head: 1.12, belly: 0 },
  { id: 'female_teen', zh: '女性 · 少年', en: 'Female · Teen', h: 1.52, shoulder: 0.84, waist: 0.76, hip: 1.04, limb: 0.82, head: 1.12, belly: 0 },
  { id: 'male_child', zh: '男性 · 儿童', en: 'Male · Child', h: 1.16, shoulder: 0.80, waist: 0.82, hip: 0.88, limb: 0.80, head: 1.34, belly: 0 },
  { id: 'female_child', zh: '女性 · 儿童', en: 'Female · Child', h: 1.14, shoulder: 0.78, waist: 0.80, hip: 0.90, limb: 0.78, head: 1.34, belly: 0 },
  { id: 'male_slim', zh: '男性 · 纤瘦', en: 'Male · Slim', h: 1.80, shoulder: 0.92, waist: 0.74, hip: 0.86, limb: 0.82, head: 0.98, belly: 0 },
  { id: 'female_slim', zh: '女性 · 纤瘦', en: 'Female · Slim', h: 1.68, shoulder: 0.82, waist: 0.68, hip: 1.00, limb: 0.76, head: 0.98, belly: 0 },
  { id: 'male_muscular', zh: '男性 · 健壮', en: 'Male · Muscular', h: 1.82, shoulder: 1.22, waist: 0.98, hip: 0.98, limb: 1.26, head: 0.96, belly: 0 },
  { id: 'female_muscular', zh: '女性 · 健壮', en: 'Female · Muscular', h: 1.70, shoulder: 1.02, waist: 0.84, hip: 1.10, limb: 1.06, head: 0.96, belly: 0 },
  { id: 'male_plump', zh: '男性 · 丰腴', en: 'Male · Plump', h: 1.74, shoulder: 1.06, waist: 1.38, hip: 1.24, limb: 1.14, head: 1.00, belly: 0.5 },
  { id: 'female_plump', zh: '女性 · 丰腴', en: 'Female · Plump', h: 1.62, shoulder: 0.96, waist: 1.30, hip: 1.36, limb: 1.06, head: 1.00, belly: 0.45 },
];

/**
 * 骨骼白膜人偶（可摆姿势）。
 *
 * 设计：局部轴永远 +Y 为骨长方向，`off` 是相对父骨**头部**的偏移（父骨局部系），
 * `rest` 是相对父骨的静止朝向（度），`pose` 是动作角度（度）。世界变换：
 *   world = parentWorld · T(off) · R(pose) · R(rest)
 * 屈伸语义因此是「在父级坐标系里先摆动作，再套自身静止朝向」，摆姿势直觉正确。
 *
 * 肢体用**锥形胶囊**画（两端关节补球），所以弯曲处是圆角、不会出现方盒穿插的破面；
 * 这也是即梦/Blender 白膜的观感。全部白色，靠光照读形体。
 */
const DEG = Math.PI / 180;
function rot3(ex, ey, ez) {
  const cx = Math.cos(ex * DEG), sx = Math.sin(ex * DEG);
  const cy = Math.cos(ey * DEG), sy = Math.sin(ey * DEG);
  const cz = Math.cos(ez * DEG), sz = Math.sin(ez * DEG);
  // R = Rz · Ry · Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}
function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}
const apply3 = (m, v) => v3(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z, m[6] * v.x + m[7] * v.y + m[8] * v.z);

/** 锥形胶囊：p0→p1，半径 r0→r1（不含端盖——关节球会盖住）。 */
export function capsuleBetween(p0, p1, r0, r1, seg) {
  const d = vSub(p1, p0);
  const L = vLen(d);
  if (L < 1e-5) return [];
  const axis = vMul(d, 1 / L);
  const helper = Math.abs(axis.y) > 0.95 ? v3(1, 0, 0) : v3(0, 1, 0);
  const u = vNorm(vCross(axis, helper));
  const w = vCross(axis, u);
  const n = Math.max(6, seg || 10);
  const ring = (c, r) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(vAdd(c, vAdd(vMul(u, Math.cos(a) * r), vMul(w, Math.sin(a) * r))));
    }
    return out;
  };
  const A = ring(p0, r0), B = ring(p1, r1);
  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push({
      v: [A[i], A[j], B[j], B[i]],
      shade: 0.03 + 0.16 * (0.5 + 0.5 * Math.cos(((i + 0.5) / n) * Math.PI * 2)),
    });
  }
  return faces;
}

/**
 * 骨骼定义（长度/偏移都是身高 H 的比例）。
 * 有 `len` 的骨画成肢体，`ball` 的在末端补关节球，`size` 的（头）画球。
 */
function skeletonOf(H, preset) {
  const sx = preset.shoulder, hp = preset.hip, lm = preset.limb, hd = preset.head;
  const armR = H * 0.029 * lm, legR = H * 0.036 * lm;
  const L = (f) => H * f;
  const bones = {
    hips: { off: [0, 0.480, 0], rest: [0, 0, 0], len: 0.070, r0: 0.070 * hp, r1: 0.076 * hp },
    spine: { parent: 'hips', off: [0, 0.070, 0], rest: [0, 0, 0], len: 0.130, r0: 0.082 * preset.waist, r1: 0.090 * sx },
    chest: { parent: 'spine', off: [0, 0.130, 0], rest: [0, 0, 0], len: 0.150, r0: 0.095 * sx, r1: 0.080 * sx },
    neck: { parent: 'chest', off: [0, 0.150, 0], rest: [0, 0, 0], len: 0.048, r0: 0.028, r1: 0.026 },
    head: { parent: 'neck', off: [0, 0.048, 0], rest: [0, 0, 0], ball: 0.062 * hd },
    clavL: { parent: 'chest', off: [0.020, 0.115, 0], rest: [0, 0, -90], len: 0.085, r0: 0.045 * sx, r1: 0.042 * sx },
    upperArmL: { parent: 'clavL', off: [0, 0.085, 0], rest: [0, 0, 0], len: 0.190, r0: armR * 1.15, r1: armR * 0.92 },
    foreArmL: { parent: 'upperArmL', off: [0, 0.190, 0], rest: [0, 0, 0], len: 0.170, r0: armR * 0.92, r1: armR * 0.72 },
    handL: { parent: 'foreArmL', off: [0, 0.170, 0], rest: [0, 0, 0], len: 0.052, r0: armR * 0.75, r1: armR * 0.5 },
    thighL: { parent: 'hips', off: [0.074 * hp, 0.012, 0], rest: [0, 0, 180], len: 0.245, r0: legR * 1.15, r1: legR },
    shinL: { parent: 'thighL', off: [0, 0.245, 0], rest: [0, 0, 0], len: 0.235, r0: legR, r1: legR * 0.68 },
    footL: { parent: 'shinL', off: [0, 0.235, 0], rest: [90, 0, 0], len: 0.115, r0: legR * 0.7, r1: legR * 0.5 },
  };
  // 右半身镜像（X 取反、绕 Z 的静止角取反）
  for (const k of ['clavL', 'upperArmL', 'foreArmL', 'handL', 'thighL', 'shinL', 'footL']) {
    const src = bones[k];
    const id = k.replace(/L$/, 'R');
    bones[id] = Object.assign({}, src, {
      parent: src.parent && src.parent.endsWith('L') ? src.parent.replace(/L$/, 'R') : src.parent,
      off: [-src.off[0], src.off[1], src.off[2]],
      rest: [src.rest[0], -src.rest[1], -src.rest[2]],
    });
  }
  void L;
  return bones;
}

/** 动作预设：每根骨的欧拉角（度）。空对象 = T 姿势。 */
export const POSE_PRESETS = [
  { id: 'tpose', zh: 'T 姿势', en: 'T-pose', bones: {} },
  { id: 'stand', zh: '站立', en: 'Stand', bones: { upperArmL: [0, 0, -68], upperArmR: [0, 0, 68], foreArmL: [0, 0, -14], foreArmR: [0, 0, 14] } },
  { id: 'punch', zh: '出拳', en: 'Punch',
    // 右直拳：上臂与肘同向朝前伸直；左手上臂贴身下垂、前臂竖起到下颌前护脸；腰胯带转
    base: { Spine: [0, -0.34, 0], Spine1: [0, -0.18, 0], Hips: [0, -0.16, 0], Neck: [0, 0.22, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.05, 0.04, 1.0] }, { bone: 'RightForeArm', to: [-0.03, 0.02, 1.0] },
      { bone: 'LeftArm', to: [0.22, -0.66, 0.30] }, { bone: 'LeftForeArm', to: [-0.14, 0.88, 0.26] },
      { bone: 'LeftUpLeg', to: [0.10, -1.0, 0.30] }, { bone: 'RightUpLeg', to: [-0.10, -1.0, -0.26] },
      { bone: 'LeftLeg', to: [0.04, -1.0, 0.02] }, { bone: 'RightLeg', to: [-0.04, -1.0, 0.22] },
      { bone: 'RightFoot', to: [-0.04, -0.55, 0.55] },
    ] },
  { id: 'kick', zh: '踢腿', en: 'Kick',
    // 高位前踢：踢腿抬到与腰同高、小腿伸出、脚背绷直；支撑腿微屈、双臂抬起护身
    base: { Spine: [0.16, 0, 0.06], Hips: [-0.12, 0, 0.04], Neck: [-0.10, 0, 0] },
    dirs: [
      { bone: 'RightUpLeg', to: [-0.12, 0.72, 0.68] }, { bone: 'RightLeg', to: [-0.06, 0.34, 0.94] },
      { bone: 'RightFoot', to: [-0.04, 0.05, 1.0] },
      { bone: 'LeftUpLeg', to: [0.06, -0.99, -0.08] }, { bone: 'LeftLeg', to: [0.02, -1.0, 0.06] },
      { bone: 'LeftArm', to: [0.55, -0.30, 0.62] }, { bone: 'RightArm', to: [-0.55, -0.35, 0.55] },
      { bone: 'LeftForeArm', to: [-0.15, 0.55, 0.72] }, { bone: 'RightForeArm', to: [0.15, 0.55, 0.72] },
    ] },
  { id: 'flip', zh: '空翻', en: 'Flip',
    // 团身前空翻：髋前滚 + 屈髋抱膝 + 屈肘抱腿
    base: { Hips: [-1.85, 0, 0], Spine: [0.55, 0, 0], Spine1: [0.35, 0, 0], Neck: [0.35, 0, 0] },
    dirs: [
      { bone: 'LeftUpLeg', to: [0.12, 0.62, 0.78] }, { bone: 'RightUpLeg', to: [-0.12, 0.62, 0.78] },
      { bone: 'LeftLeg', to: [0.10, -0.55, -0.83] }, { bone: 'RightLeg', to: [-0.10, -0.55, -0.83] },
      { bone: 'LeftArm', to: [0.30, -0.35, 0.88] }, { bone: 'RightArm', to: [-0.30, -0.35, 0.88] },
      { bone: 'LeftForeArm', to: [-0.25, 0.35, -0.90] }, { bone: 'RightForeArm', to: [0.25, 0.35, -0.90] },
    ] },
  { id: 'fly', zh: '轻功', en: 'Qinggong', rootY: 0.42,
    // 轻功腾跃（武侠标准）：身体前倾腾空，右腿屈膝收于裆前、左腿向后舒展，
    // 左臂前撩、右臂后扬（掌心向下），抬头看向前方落点
    base: { Hips: [-0.34, 0, 0], Spine: [0.14, 0, 0], Spine1: [0.08, 0, 0], Neck: [-0.34, 0, 0] },
    dirs: [
      { bone: 'RightUpLeg', to: [0.16, 0.30, 0.94] }, { bone: 'RightLeg', to: [-0.10, -0.92, 0.38] },
      { bone: 'RightFoot', to: [-0.06, -0.60, 0.80] },
      { bone: 'LeftUpLeg', to: [-0.14, -0.52, -0.84] }, { bone: 'LeftLeg', to: [-0.08, -0.12, -0.99] },
      { bone: 'LeftFoot', to: [-0.06, -0.35, -0.94] },
      { bone: 'LeftArm', to: [0.42, 0.34, 0.84] }, { bone: 'RightArm', to: [-0.52, -0.10, -0.85] },
      { bone: 'LeftForeArm', to: [0.30, 0.62, 0.72] }, { bone: 'RightForeArm', to: [-0.42, -0.55, -0.72] },
    ] },
  { id: 'crouch', zh: '下蹲', en: 'Crouch', rootY: -0.29,
    // 深蹲：大腿前伸、小腿竖直、脚掌踩平；骨盆整体下沉 0.46m 让双脚落到地面
    base: { Spine: [0.50, 0, 0], Spine1: [0.22, 0, 0], Hips: [0.14, 0, 0], Neck: [-0.24, 0, 0] },
    dirs: [
      { bone: 'LeftUpLeg', to: [0.24, -0.30, 0.92] }, { bone: 'RightUpLeg', to: [-0.24, -0.30, 0.92] },
      { bone: 'LeftLeg', to: [0.04, -1.0, 0.04] }, { bone: 'RightLeg', to: [-0.04, -1.0, 0.04] },
      { bone: 'LeftFoot', to: [0.04, -0.06, 1.0] }, { bone: 'RightFoot', to: [-0.04, -0.06, 1.0] },
      { bone: 'LeftArm', to: [0.22, -0.26, 0.94] }, { bone: 'RightArm', to: [-0.22, -0.26, 0.94] },
      { bone: 'LeftForeArm', to: [0.14, -0.10, 0.98] }, { bone: 'RightForeArm', to: [-0.14, -0.10, 0.98] },
    ] },
  { id: 'fight', zh: '格斗架势', en: 'Fight stance',
    // 拳击架势：上臂夹紧体侧、前臂几乎竖直、双拳贴在下颌前；左肩稍前、重心下沉
    base: { Spine: [0.10, 0.26, 0], Spine1: [0.06, 0.14, 0], Neck: [0.12, -0.18, 0] },
    dirs: [
      { bone: 'LeftArm', to: [0.30, -0.72, 0.26] }, { bone: 'RightArm', to: [-0.30, -0.72, 0.26] },
      { bone: 'LeftForeArm', to: [-0.16, 0.94, 0.18] }, { bone: 'RightForeArm', to: [0.16, 0.94, 0.18] },
      { bone: 'LeftUpLeg', to: [0.12, -0.94, 0.34] }, { bone: 'RightUpLeg', to: [-0.12, -0.94, -0.30] },
      { bone: 'LeftLeg', to: [0.05, -0.98, 0.10] }, { bone: 'RightLeg', to: [-0.05, -0.98, 0.22] },
      { bone: 'RightFoot', to: [-0.05, -0.45, 0.60] },
    ] },
];

/** 由「骨骼名 → 旋转」构造姿态表（按骨骼名解析成 index）。 */
/**
 * 方向求解：给定「某骨骼要指向的世界方向」，反解出需要的局部欧拉旋转。
 *   d 作用在局部（post-multiply）→ 世界旋转 R' = R_world · q，
 *   要求 R_world · q · v_local = T  ⇒  q = rotFromTo(v_local, R_world⁻¹·T)
 * 这样姿势由「解剖方向」决定，而不是靠猜欧拉角。
 */
function quatFromTo(a, b) {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  let d = ax * bx + ay * by + az * bz;
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    // 反向：绕任意垂直轴转 180°
    let axis = Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c1 = [ay * axis[2] - az * axis[1], az * axis[0] - ax * axis[2], ax * axis[1] - ay * axis[0]];
    const l1 = Math.hypot(c1[0], c1[1], c1[2]) || 1;
    return [c1[0] / l1, c1[1] / l1, c1[2] / l1, 0];
  }
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  const w = 1 + d;
  const l = Math.hypot(cx, cy, cz, w) || 1;
  return [cx / l, cy / l, cz / l, w / l];
}

/** 四元数 → 3x3（行主序） */
function quatToM3Row(q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** 3x3 → 欧拉（R = Rz·Ry·Rx，与 eulerToQuat 的约定一致） */
function m3ToEulerXYZ(R) {
  const sy = -R[2][0];
  const ry = Math.asin(Math.max(-1, Math.min(1, sy)));
  let rx, rz;
  if (Math.abs(sy) < 0.999) {
    rx = Math.atan2(R[2][1], R[2][2]);
    rz = Math.atan2(R[1][0], R[0][0]);
  } else {
    rx = Math.atan2(-R[1][2], R[1][1]);
    rz = 0;
  }
  return [rx, ry, rz];
}

function mat3FromM4(m, off) {
  return [
    [m[off], m[off + 4], m[off + 8]],
    [m[off + 1], m[off + 5], m[off + 9]],
    [m[off + 2], m[off + 6], m[off + 10]],
  ];
}
const m3mul = (A, B) => [
  [A[0][0] * B[0][0] + A[0][1] * B[1][0] + A[0][2] * B[2][0], A[0][0] * B[0][1] + A[0][1] * B[1][1] + A[0][2] * B[2][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2] * B[2][2]],
  [A[1][0] * B[0][0] + A[1][1] * B[1][0] + A[1][2] * B[2][0], A[1][0] * B[0][1] + A[1][1] * B[1][1] + A[1][2] * B[2][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2] * B[2][2]],
  [A[2][0] * B[0][0] + A[2][1] * B[1][0] + A[2][2] * B[2][0], A[2][0] * B[0][1] + A[2][1] * B[1][1] + A[2][2] * B[2][1], A[2][0] * B[0][2] + A[2][1] * B[1][2] + A[2][2] * B[2][2]],
];
/** 去掉缩放的 3x3（列归一化）——节点带 scale 时，直接把 3x3 当旋转会算错方向。 */
const m3ortho = (A) => {
  const col = (i) => {
    const l = Math.hypot(A[0][i], A[1][i], A[2][i]) || 1;
    return [A[0][i] / l, A[1][i] / l, A[2][i] / l];
  };
  const c0 = col(0), c1 = col(1), c2 = col(2);
  return [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]],
  ];
};
const m3t = (A) => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
const m3v = (A, v) => [
  A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
  A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
  A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
];

/**
 * 按方向求解姿态。
 * @param asset 模型
 * @param spec  { base: {boneKeyword: [rx,ry,rz]}, dirs: [{ bone, to:[x,y,z] }, ...] }
 * @returns poseMap { boneIndex: [rx,ry,rz] }
 */
/** 肢体链：父骨 → 子骨（用于确定骨骼自身轴向；glTF 里按父链扫描会找错） */
const BONE_CHILD = {
  Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head',
  LeftShoulder: 'LeftArm', RightShoulder: 'RightArm',
  LeftArm: 'LeftForeArm', RightArm: 'RightForeArm',
  LeftForeArm: 'LeftHand', RightForeArm: 'RightHand',
  LeftUpLeg: 'LeftLeg', RightUpLeg: 'RightLeg',
  LeftLeg: 'LeftFoot', RightLeg: 'RightFoot',
  LeftFoot: 'LeftToeBase', RightFoot: 'RightToeBase',
};
/** 从骨骼名里剥掉 mixamorig: 前缀 */
const shortBoneName = (n) => String(n || '').replace(/^mixamorig:?/i, '');

/**
 * 姿态库：只保留「骨架级基础姿态」（方向式，蒙皮时按当前动画姿势求解）。
 * 连贯动作来自 ① 模型自带的骨骼动画片段（动作下拉）② 用户用骨骼旋转 + 姿态关键帧自己编排后保存的动作。
 */
export const BONE_POSES = [
  { id: 'none', zh: '无', en: 'None', base: {}, dirs: [] },
  { id: 'arms_up', zh: '举双手', en: 'Arms up',
    base: {},
    dirs: [
      { bone: 'LeftArm', to: [0.45, 1.0, 0.12] }, { bone: 'RightArm', to: [-0.45, 1.0, 0.12] },
      { bone: 'LeftForeArm', to: [0.30, 1.0, 0.10] }, { bone: 'RightForeArm', to: [-0.30, 1.0, 0.10] },
    ] },
  { id: 'punch', zh: '出拳', en: 'Punch',
    // 右直拳：上臂与肘同向朝前伸直；左手上臂贴身下垂、前臂竖起到下颌前护脸；腰胯带转
    base: { Spine: [0, -0.34, 0], Spine1: [0, -0.18, 0], Hips: [0, -0.16, 0], Neck: [0, 0.22, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.05, 0.04, 1.0] }, { bone: 'RightForeArm', to: [-0.03, 0.02, 1.0] },
      { bone: 'LeftArm', to: [0.22, -0.66, 0.30] }, { bone: 'LeftForeArm', to: [-0.14, 0.88, 0.26] },
      { bone: 'LeftUpLeg', to: [0.10, -1.0, 0.30] }, { bone: 'RightUpLeg', to: [-0.10, -1.0, -0.26] },
      { bone: 'LeftLeg', to: [0.04, -1.0, 0.02] }, { bone: 'RightLeg', to: [-0.04, -1.0, 0.22] },
      { bone: 'RightFoot', to: [-0.04, -0.55, 0.55] },
    ] },
  { id: 'kick', zh: '踢腿', en: 'Kick',
    // 高位前踢：踢腿抬到与腰同高、小腿伸出、脚背绷直；支撑腿微屈、双臂抬起护身
    base: { Spine: [0.16, 0, 0.06], Hips: [-0.12, 0, 0.04], Neck: [-0.10, 0, 0] },
    dirs: [
      { bone: 'RightUpLeg', to: [-0.12, 0.72, 0.68] }, { bone: 'RightLeg', to: [-0.06, 0.34, 0.94] },
      { bone: 'RightFoot', to: [-0.04, 0.05, 1.0] },
      { bone: 'LeftUpLeg', to: [0.06, -0.99, -0.08] }, { bone: 'LeftLeg', to: [0.02, -1.0, 0.06] },
      { bone: 'LeftArm', to: [0.55, -0.30, 0.62] }, { bone: 'RightArm', to: [-0.55, -0.35, 0.55] },
      { bone: 'LeftForeArm', to: [-0.15, 0.55, 0.72] }, { bone: 'RightForeArm', to: [0.15, 0.55, 0.72] },
    ] },
  { id: 'flip', zh: '空翻', en: 'Flip',
    // 团身前空翻：髋前滚 + 屈髋抱膝 + 屈肘抱腿
    base: { Hips: [-1.85, 0, 0], Spine: [0.55, 0, 0], Spine1: [0.35, 0, 0], Neck: [0.35, 0, 0] },
    dirs: [
      { bone: 'LeftUpLeg', to: [0.12, 0.62, 0.78] }, { bone: 'RightUpLeg', to: [-0.12, 0.62, 0.78] },
      { bone: 'LeftLeg', to: [0.10, -0.55, -0.83] }, { bone: 'RightLeg', to: [-0.10, -0.55, -0.83] },
      { bone: 'LeftArm', to: [0.30, -0.35, 0.88] }, { bone: 'RightArm', to: [-0.30, -0.35, 0.88] },
      { bone: 'LeftForeArm', to: [-0.25, 0.35, -0.90] }, { bone: 'RightForeArm', to: [0.25, 0.35, -0.90] },
    ] },
  { id: 'fly', zh: '轻功', en: 'Qinggong', rootY: 0.42,
    // 轻功腾跃：身体前倾腾空，右腿屈膝收于裆前、左腿向后舒展，双臂展开如翼
    base: { Hips: [-0.34, 0, 0], Spine: [0.14, 0, 0], Spine1: [0.08, 0, 0], Neck: [-0.34, 0, 0] },
    dirs: [
      { bone: 'RightUpLeg', to: [0.16, 0.30, 0.94] }, { bone: 'RightLeg', to: [-0.10, -0.92, 0.38] },
      { bone: 'RightFoot', to: [-0.06, -0.60, 0.80] },
      { bone: 'LeftUpLeg', to: [-0.14, -0.52, -0.84] }, { bone: 'LeftLeg', to: [-0.08, -0.12, -0.99] },
      { bone: 'LeftFoot', to: [-0.06, -0.35, -0.94] },
      { bone: 'LeftArm', to: [0.42, 0.34, 0.84] }, { bone: 'RightArm', to: [-0.52, -0.10, -0.85] },
      { bone: 'LeftForeArm', to: [0.30, 0.62, 0.72] }, { bone: 'RightForeArm', to: [-0.42, -0.55, -0.72] },
    ] },
  { id: 'crouch', zh: '下蹲', en: 'Crouch', rootY: -0.29,
    // 深蹲：大腿前伸、小腿竖直、脚掌踩平；骨盆下沉让双脚落地
    base: { Spine: [0.50, 0, 0], Spine1: [0.22, 0, 0], Hips: [0.14, 0, 0], Neck: [-0.24, 0, 0] },
    dirs: [
      { bone: 'LeftUpLeg', to: [0.24, -0.30, 0.92] }, { bone: 'RightUpLeg', to: [-0.24, -0.30, 0.92] },
      { bone: 'LeftLeg', to: [0.04, -1.0, 0.04] }, { bone: 'RightLeg', to: [-0.04, -1.0, 0.04] },
      { bone: 'LeftFoot', to: [0.04, -0.06, 1.0] }, { bone: 'RightFoot', to: [-0.04, -0.06, 1.0] },
      { bone: 'LeftArm', to: [0.22, -0.26, 0.94] }, { bone: 'RightArm', to: [-0.22, -0.26, 0.94] },
      { bone: 'LeftForeArm', to: [0.14, -0.10, 0.98] }, { bone: 'RightForeArm', to: [-0.14, -0.10, 0.98] },
    ] },
  { id: 'fight', zh: '格斗架势', en: 'Fight stance',
    // 拳击架势：上臂夹紧体侧、前臂几乎竖直、双拳贴在下颌前；左肩稍前、重心下沉
    base: { Spine: [0.10, 0.26, 0], Spine1: [0.06, 0.14, 0], Neck: [0.12, -0.18, 0] },
    dirs: [
      { bone: 'LeftArm', to: [0.30, -0.72, 0.26] }, { bone: 'RightArm', to: [-0.30, -0.72, 0.26] },
      { bone: 'LeftForeArm', to: [-0.16, 0.94, 0.18] }, { bone: 'RightForeArm', to: [0.16, 0.94, 0.18] },
      { bone: 'LeftUpLeg', to: [0.12, -0.94, 0.34] }, { bone: 'RightUpLeg', to: [-0.12, -0.94, -0.30] },
      { bone: 'LeftLeg', to: [0.05, -0.98, 0.10] }, { bone: 'RightLeg', to: [-0.05, -0.98, 0.22] },
      { bone: 'RightFoot', to: [-0.05, -0.45, 0.60] },
    ] },
  { id: 'vault', zh: '翻越障碍', en: 'Vault',
    // 侧手翻越：上身前倾、双手下撑障碍顶面，双腿向侧上方收起（跨栏/翻摊位的动作语汇）
    base: { Spine: [0.52, 0, 0.10], Spine1: [0.30, 0, 0.08], Hips: [0.26, 0, 0.14], Neck: [-0.34, 0, 0] },
    dirs: [
      { bone: 'LeftArm', to: [0.34, -0.86, 0.38] }, { bone: 'RightArm', to: [-0.34, -0.86, 0.38] },
      { bone: 'LeftForeArm', to: [0.10, -0.98, 0.16] }, { bone: 'RightForeArm', to: [-0.10, -0.98, 0.16] },
      { bone: 'RightUpLeg', to: [-0.30, 0.36, 0.88] }, { bone: 'RightLeg', to: [-0.12, -0.72, 0.68] },
      { bone: 'RightFoot', to: [-0.10, -0.52, 0.85] },
      { bone: 'LeftUpLeg', to: [0.26, 0.10, 0.96] }, { bone: 'LeftLeg', to: [0.10, -0.86, 0.50] },
      { bone: 'LeftFoot', to: [0.06, -0.62, 0.78] },
    ] },

  // ============================================================
  // 打斗动作库（依据参考片段 6:20–6:30 的动作语义编写，方向式）
  //   命名：spear_* / block_* / dodge_* / hit_* / ult_*
  //   配合 poseAnim 串成打斗序列；每个动作都可单帧关键帧使用
  // ============================================================
  // ① 侧身持枪起势：侧身对敌、双手前后持杆、重心下沉
  { id: 'spear_ready', zh: '持枪起势', en: 'Spear ready',
    base: { Spine: [0.10, 0.42, 0], Spine1: [0.06, 0.20, 0], Hips: [0.02, 0.16, 0], Neck: [0.06, -0.30, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.10, -0.30, 0.95] }, { bone: 'RightForeArm', to: [-0.04, -0.10, 1.0] },
      { bone: 'LeftArm', to: [0.16, -0.42, 0.90] }, { bone: 'LeftForeArm', to: [0.06, -0.24, 0.97] },
      { bone: 'LeftUpLeg', to: [0.16, -0.92, 0.36] }, { bone: 'RightUpLeg', to: [-0.16, -0.94, -0.30] },
      { bone: 'LeftLeg', to: [0.06, -0.97, 0.22] }, { bone: 'RightLeg', to: [-0.06, -0.97, 0.20] },
    ] },
  // ② 横枪突刺：腰部拧转、双手前推、前腿弓步
  { id: 'spear_thrust', zh: '横枪突刺', en: 'Spear thrust',
    base: { Spine: [0.16, -0.46, 0], Spine1: [0.10, -0.24, 0], Hips: [0.04, -0.30, 0], Neck: [0.08, 0.34, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.06, 0.02, 1.0] }, { bone: 'RightForeArm', to: [-0.04, 0.02, 1.0] },
      { bone: 'LeftArm', to: [0.12, -0.10, 0.98] }, { bone: 'LeftForeArm', to: [0.06, -0.04, 1.0] },
      { bone: 'LeftUpLeg', to: [0.10, -0.88, 0.46] }, { bone: 'LeftLeg', to: [0.04, -0.97, 0.22] },
      { bone: 'RightUpLeg', to: [-0.12, -0.98, -0.16] }, { bone: 'RightLeg', to: [-0.04, -1.0, 0.06] },
      { bone: 'RightFoot', to: [-0.04, -0.40, 0.70] },
    ] },
  // ③ 单掌格挡：单臂上架、掌面外翻、躯干侧倾卸力
  { id: 'palm_block', zh: '单掌格挡', en: 'Palm block',
    base: { Spine: [-0.14, 0.34, 0], Spine1: [-0.08, 0.18, 0], Hips: [-0.04, 0.12, 0], Neck: [0.10, -0.26, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.52, 0.66, 0.54] }, { bone: 'RightForeArm', to: [-0.46, 0.86, 0.22] },
      { bone: 'LeftArm', to: [0.24, -0.62, 0.74] }, { bone: 'LeftForeArm', to: [0.12, 0.10, 0.98] },
      { bone: 'LeftUpLeg', to: [0.14, -0.94, 0.30] }, { bone: 'RightUpLeg', to: [-0.14, -0.92, -0.34] },
      { bone: 'LeftLeg', to: [0.04, -0.98, 0.18] }, { bone: 'RightLeg', to: [-0.04, -0.98, 0.16] },
    ] },
  // ④ 后仰闪避：上身大幅后仰、髋部后坐、双手回收护身
  { id: 'dodge_lean', zh: '后仰闪避', en: 'Lean back dodge',
    base: { Spine: [-0.62, 0.20, 0], Spine1: [-0.40, 0.12, 0], Hips: [0.18, 0.08, 0], Neck: [0.30, -0.16, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.30, -0.30, 0.90] }, { bone: 'RightForeArm', to: [-0.18, 0.34, 0.92] },
      { bone: 'LeftArm', to: [0.30, -0.34, 0.88] }, { bone: 'LeftForeArm', to: [0.18, 0.30, 0.94] },
      { bone: 'LeftUpLeg', to: [0.18, -0.86, 0.48] }, { bone: 'LeftLeg', to: [0.06, -0.96, 0.26] },
      { bone: 'RightUpLeg', to: [-0.18, -0.90, -0.38] }, { bone: 'RightLeg', to: [-0.06, -0.98, 0.16] },
    ] },
  // ⑤ 蹬地冲刺：前腿蹬直、后腿抬起、上身前压、双臂前后摆
  { id: 'dash_forward', zh: '蹬地冲刺', en: 'Dash',
    base: { Spine: [0.46, 0.10, 0], Spine1: [0.28, 0.06, 0], Hips: [0.16, 0.04, 0], Neck: [-0.34, -0.08, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.20, -0.72, 0.66] }, { bone: 'RightForeArm', to: [-0.10, 0.20, 0.97] },
      { bone: 'LeftArm', to: [0.24, 0.30, -0.92] }, { bone: 'LeftForeArm', to: [0.12, 0.10, -0.98] },
      { bone: 'LeftUpLeg', to: [0.10, -0.96, 0.26] }, { bone: 'LeftLeg', to: [0.04, -1.0, 0.02] },
      { bone: 'RightUpLeg', to: [-0.10, 0.52, -0.84] }, { bone: 'RightLeg', to: [-0.06, -0.30, -0.95] },
      { bone: 'RightFoot', to: [-0.04, -0.20, -0.98] },
    ] },
  // ⑥ 压上发狠：上身前探、双臂收紧、下颌压低（近身压制的瞬间）
  { id: 'grit_advance', zh: '压上发狠', en: 'Grit advance',
    base: { Spine: [0.34, -0.18, 0], Spine1: [0.22, -0.10, 0], Hips: [0.10, -0.12, 0], Neck: [0.16, 0.14, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.14, -0.44, 0.88] }, { bone: 'RightForeArm', to: [-0.06, 0.26, 0.96] },
      { bone: 'LeftArm', to: [0.16, -0.50, 0.84] }, { bone: 'LeftForeArm', to: [0.06, 0.20, 0.97] },
      { bone: 'LeftUpLeg', to: [0.12, -0.92, 0.38] }, { bone: 'LeftLeg', to: [0.04, -0.98, 0.18] },
      { bone: 'RightUpLeg', to: [-0.12, -0.94, -0.32] }, { bone: 'RightLeg', to: [-0.04, -0.98, 0.20] },
    ] },
  // ⑦ 低身横扫：深蹲转体、持杆手贴地扫出、另一手撑地
  { id: 'low_sweep', zh: '低身横扫', en: 'Low sweep',
    base: { Spine: [0.72, -0.52, 0], Spine1: [0.42, -0.28, 0], Hips: [0.30, -0.24, 0.08], Neck: [-0.30, 0.20, 0] },
    rootY: -0.29,
    dirs: [
      { bone: 'RightArm', to: [-0.34, -0.86, 0.36] }, { bone: 'RightForeArm', to: [-0.16, -0.96, 0.22] },
      { bone: 'LeftArm', to: [0.40, -0.80, 0.44] }, { bone: 'LeftForeArm', to: [0.18, -0.94, 0.28] },
      // 蹲姿腿（脚落地）：大腿前伸下压、小腿竖直、脚掌踩平
      { bone: 'LeftUpLeg', to: [0.26, -0.34, 0.90] }, { bone: 'RightUpLeg', to: [-0.26, -0.34, 0.90] },
      { bone: 'LeftLeg', to: [0.05, -1.0, 0.04] }, { bone: 'RightLeg', to: [-0.05, -1.0, 0.04] },
      { bone: 'LeftFoot', to: [0.04, -0.06, 1.0] }, { bone: 'RightFoot', to: [-0.04, -0.06, 1.0] },
    ] },
  // ⑧ 枪尖戳地：单膝下沉、持杆手直下压、上身俯冲
  { id: 'spear_ground', zh: '枪尖戳地', en: 'Spear to ground',
    base: { Spine: [0.86, -0.20, 0], Spine1: [0.48, -0.12, 0], Hips: [0.34, -0.10, 0.06], Neck: [-0.48, 0.10, 0] },
    rootY: -0.29,
    dirs: [
      { bone: 'RightArm', to: [-0.16, -0.96, 0.20] }, { bone: 'RightForeArm', to: [-0.08, -0.99, 0.10] },
      { bone: 'LeftArm', to: [0.30, -0.72, 0.62] }, { bone: 'LeftForeArm', to: [0.14, -0.30, 0.94] },
      // 蹲姿腿（脚落地）：大腿前伸下压、小腿竖直、脚掌踩平
      { bone: 'LeftUpLeg', to: [0.26, -0.34, 0.90] }, { bone: 'RightUpLeg', to: [-0.26, -0.34, 0.90] },
      { bone: 'LeftLeg', to: [0.05, -1.0, 0.04] }, { bone: 'RightLeg', to: [-0.05, -1.0, 0.04] },
      { bone: 'LeftFoot', to: [0.04, -0.06, 1.0] }, { bone: 'RightFoot', to: [-0.04, -0.06, 1.0] },
    ] },
  // ⑨ 俯身贴地收势：单膝跪地、上身压到近地、持杆手垂落
  { id: 'crouch_low', zh: '俯身贴地', en: 'Crouch low',
    base: { Spine: [0.94, 0.18, 0], Spine1: [0.52, 0.10, 0], Hips: [0.38, 0.08, 0], Neck: [-0.54, -0.12, 0] },
    rootY: -0.29,
    dirs: [
      { bone: 'RightArm', to: [-0.24, -0.92, 0.30] }, { bone: 'RightForeArm', to: [-0.10, -0.98, 0.14] },
      { bone: 'LeftArm', to: [0.34, -0.86, 0.38] }, { bone: 'LeftForeArm', to: [0.16, -0.96, 0.22] },
      // 蹲姿腿（脚落地）：大腿前伸下压、小腿竖直、脚掌踩平
      { bone: 'LeftUpLeg', to: [0.26, -0.34, 0.90] }, { bone: 'RightUpLeg', to: [-0.26, -0.34, 0.90] },
      { bone: 'LeftLeg', to: [0.05, -1.0, 0.04] }, { bone: 'RightLeg', to: [-0.05, -1.0, 0.04] },
      { bone: 'LeftFoot', to: [0.04, -0.06, 1.0] }, { bone: 'RightFoot', to: [-0.04, -0.06, 1.0] },
    ] },
  // ⑩ 大招起势：抬头挺胸、双臂外展上举、重心拔起
  { id: 'ult_charge', zh: '大招起势', en: 'Ultimate charge',
    base: { Spine: [-0.28, 0, 0], Spine1: [-0.18, 0, 0], Hips: [-0.10, 0, 0], Neck: [-0.26, 0, 0] },
    rootY: 0.10,
    dirs: [
      { bone: 'RightArm', to: [-0.62, 0.62, 0.48] }, { bone: 'RightForeArm', to: [-0.48, 0.84, 0.26] },
      { bone: 'LeftArm', to: [0.62, 0.62, 0.48] }, { bone: 'LeftForeArm', to: [0.48, 0.84, 0.26] },
      { bone: 'LeftUpLeg', to: [0.14, -0.94, 0.30] }, { bone: 'RightUpLeg', to: [-0.14, -0.94, -0.30] },
      { bone: 'LeftLeg', to: [0.04, -0.99, 0.14] }, { bone: 'RightLeg', to: [-0.04, -0.99, 0.14] },
    ] },
  // ⑪ 受击后仰：躯干后折、双臂散开、后腿撤步卸力
  { id: 'hit_recoil', zh: '受击后仰', en: 'Hit recoil',
    base: { Spine: [-0.78, 0.24, 0.10], Spine1: [-0.48, 0.14, 0.06], Hips: [0.24, 0.10, -0.06], Neck: [0.40, -0.20, 0] },
    dirs: [
      { bone: 'RightArm', to: [-0.66, 0.30, 0.68] }, { bone: 'RightForeArm', to: [-0.52, -0.10, 0.84] },
      { bone: 'LeftArm', to: [0.70, 0.24, 0.66] }, { bone: 'LeftForeArm', to: [0.56, -0.16, 0.80] },
      { bone: 'LeftUpLeg', to: [0.20, -0.80, 0.56] }, { bone: 'LeftLeg', to: [0.08, -0.96, 0.26] },
      { bone: 'RightUpLeg', to: [-0.24, -0.86, -0.44] }, { bone: 'RightLeg', to: [-0.08, -0.98, 0.14] },
    ] },
  // ⑫ 倒地：全身放倒、四肢摊开
  { id: 'knockdown', zh: '倒地', en: 'Knockdown',
    base: { Hips: [-1.52, 0.20, 0.10], Spine: [0.40, 0.10, 0.04], Spine1: [0.26, 0.06, 0], Neck: [0.22, -0.14, 0] },
    rootY: -0.70,
    dirs: [
      { bone: 'LeftUpLeg', to: [0.34, -0.10, 0.94] }, { bone: 'LeftLeg', to: [0.16, -0.44, 0.88] },
      { bone: 'RightUpLeg', to: [-0.30, -0.06, 0.95] }, { bone: 'RightLeg', to: [-0.14, -0.38, 0.92] },
      { bone: 'LeftArm', to: [0.78, 0.22, 0.58] }, { bone: 'RightArm', to: [-0.80, 0.18, 0.56] },
      { bone: 'LeftForeArm', to: [0.62, 0.06, 0.78] }, { bone: 'RightForeArm', to: [-0.64, 0.02, 0.76] },
    ] },
];


export function solvePoseDirections(asset, spec, opts) {
  if (!asset || !asset.bones || !asset.nodes) return {};
  const bones = asset.bones;
  const idxOf = (kw) => matchBone(bones, kw);
  // 1) 局部 TRS（无动画）
  const local = asset.nodes.map((n) => ({ t: n.t.slice(), r: n.r.slice(), s: n.s.slice() }));
  // 2) 先应用欧拉基底
  const applied = {};
  for (const [kw, rot] of Object.entries((spec && spec.base) || {})) {
    const bi = idxOf(kw);
    if (bi < 0) continue;
    const ni = bones[bi].nodeIdx;
    const q = eulerToQuat(rot[0] || 0, rot[1] || 0, rot[2] || 0);
    local[ni].r = quatMul(local[ni].r, q);
    applied[bi] = [q[0], q[1], q[2], q[3]];   // 统一用四元数表示
  }
  // 3) 世界矩阵
  const nW = local.length;
  const worldM = new Array(nW);
  const parentOf = (i) => (asset.parentOfAll ? asset.parentOfAll[i] : -1);
  const resolve = (i, guard) => {
    if (worldM[i]) return worldM[i];
    if (guard > 200) return directorMat4Identity();
    const Lp = local[i];
    const m = trsToMat4(Lp.t, Lp.r, Lp.s);
    const p = parentOf(i);
    worldM[i] = (p >= 0 && p !== i) ? directorMat4Multiply(resolve(p, guard + 1), m) : m;
    return worldM[i];
  };
  for (let i = 0; i < nW; i++) resolve(i, 0);
  // 4) 逐条方向约束（按深度升序，父先子后）
  const dirs = ((spec && spec.dirs) || []).slice();
  const depthOfBone = (bi) => {
    let d = 0, cur = bones[bi].nodeIdx;
    while (cur >= 0 && d < 100) { cur = parentOf(cur); if (cur < 0) break; d++; }
    return d;
  };
  dirs.sort((a, b) => depthOfBone(idxOf(a.bone)) - depthOfBone(idxOf(b.bone)));
  const out = JSON.parse(JSON.stringify(applied));
  for (const d of dirs) {
    const bi = idxOf(d.bone);
    if (bi < 0) continue;
    const ni = bones[bi].nodeIdx;
    const M = worldM[ni];
    const R = m3ortho(mat3FromM4(M, 0));
    // 骨骼局部方向 v_local：取其子骨（或父骨）在局部空间的轴向
    let childNi = -1;
    {
      const childName = BONE_CHILD[shortBoneName(bones[bi].name)];
      if (childName) {
        const ci = bones.findIndex((b) => shortBoneName(b.name) === childName);
        if (ci >= 0) childNi = bones[ci].nodeIdx;
      }
    }
    let vLocal;
    if (childNi >= 0) {
      const cw = worldM[childNi];
      const bw = worldM[ni];
      const dw = [cw[12] - bw[12], cw[13] - bw[13], cw[14] - bw[14]];
      const len = Math.hypot(dw[0], dw[1], dw[2]) || 1;
      const dirW = [dw[0] / len, dw[1] / len, dw[2] / len];
      vLocal = m3v(m3t(R), dirW);          // 世界方向 → 局部方向
    } else {
      vLocal = [0, 1, 0];
    }
    const T = d.to;
    const Tl = Math.hypot(T[0], T[1], T[2]) || 1;
    const Tw = [T[0] / Tl, T[1] / Tl, T[2] / Tl];
    const u = m3v(m3t(R), Tw);             // 目标方向变换到该骨局部
    const q = quatFromTo(vLocal, u);
    // 累积到局部旋转
    local[ni].r = quatMul(local[ni].r, q);
    // 4b) 更新该子树的世界矩阵（自顶向下重算）
    const refresh = (i) => {
      const p = parentOf(i);
      const m2 = trsToMat4(local[i].t, local[i].r, local[i].s);
      worldM[i] = (p >= 0 && p !== i) ? directorMat4Multiply(worldM[p], m2) : m2;
      for (let c = 0; c < nW; c++) if (parentOf(c) === i) refresh(c);
    };
    refresh(ni);
    // 4c) 记录欧拉角
    out[bi] = [q[0], q[1], q[2], q[3]];   // 直接给四元数，避免欧拉往返误差
    // 自检：用更新后的世界矩阵复算该骨实际指向，与目标比较
    if (opts && opts.diag) {
      const Mn = worldM[ni];
      let gotW = null;
      if (childNi >= 0) {
        const cw2 = worldM[childNi];
        const dw2 = [cw2[12] - Mn[12], cw2[13] - Mn[13], cw2[14] - Mn[14]];
        const l2 = Math.hypot(dw2[0], dw2[1], dw2[2]) || 1;
        gotW = [dw2[0] / l2, dw2[1] / l2, dw2[2] / l2];
      }
      out.__check = out.__check || [];
      out.__check.push({ bone: d.bone, want: Tw, got: gotW, dot: gotW ? (gotW[0] * Tw[0] + gotW[1] * Tw[1] + gotW[2] * Tw[2]) : NaN });
    }
  }
  if (opts && opts.diag && out.__check) {
    const chk = out.__check;
    delete out.__check;
    return { map: out, check: chk };
  }
  return out;
}

export function resolveBonePose(asset, poseId) {
  const preset = BONE_POSES.find((p) => p.id === poseId);
  if (!preset || poseId === 'none') return {};
  // 优先走方向求解器（解剖方向可靠）；旧格式只有 rot 的仍兼容
  if (Array.isArray(preset.dirs) || preset.base) {
    try { return solvePoseDirections(asset, { base: preset.base || {}, dirs: preset.dirs || [] }); } catch { /* 回退 */ }
  }
  const out = {};
  for (const [kw, rot] of Object.entries(preset.rot || {})) {
    const idx = matchBone(asset.bones || [], kw);
    if (idx >= 0) out[idx] = rot;
  }
  return out;
}

/** 欧拉角 → 3x3 旋转矩阵（用于骨骼局部旋转）。 */
function eulerMat3(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [-sx * sz + cx * sy * cz, sx * cz + cx * sy * sz, cx * cy],
  ];
}

/**
 * 应用骨骼姿态：在 boneMatrices 之后，对指定骨骼的蒙皮矩阵再乘一层局部旋转。
 * boneWorld · Ry·Rx·Rz · IBM —— 旋转作用在骨骼局部空间，所以看起来就是「转动这根骨头」。
 */
export function applyBonePose(asset, mats, poseMap) {
  if (!mats || !mats.mats || !poseMap) return mats;
  const bones = asset.bones || [];
  const M = mats.mats;
  // 对点 v：v' = p + R·(v - p)  —— 绕关节头 p 旋转（Blender: chan_mat 作用在骨骼空间）
  // 实现为先求枢轴变换矩阵 P = T(p)·R·T(-p)，再对骨骼及其子骨做 M' = P·M。
  for (const [k, rot] of Object.entries(poseMap)) {
    const bi = Number(k);
    if (!(bi >= 0) || bi >= bones.length) continue;
    const rx = Number(rot[0]) || 0, ry = Number(rot[1]) || 0, rz = Number(rot[2]) || 0;
    if (!rx && !ry && !rz) continue;
    // R (3x3, 行主序) = Rz·Ry·Rx
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const R = [
      [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
      [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
      [-sy, cy * sx, cy * cx],
    ];
    const off = bi * 16;
    const px = M[off + 12], py = M[off + 13], pz = M[off + 14];
    // 枢轴平移 t = p - R·p
    const tx = px - (R[0][0] * px + R[0][1] * py + R[0][2] * pz);
    const ty = py - (R[1][0] * px + R[1][1] * py + R[1][2] * pz);
    const tz = pz - (R[2][0] * px + R[2][1] * py + R[2][2] * pz);
    const stack = [bi];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur) || cur >= bones.length) continue;
      seen.add(cur);
      const o = cur * 16;
      // 取当前 3x3（列主序: m[o],m[o+4],m[o+8] 是第一行…）
      const a00 = M[o], a01 = M[o + 4], a02 = M[o + 8];
      const a10 = M[o + 1], a11 = M[o + 5], a12 = M[o + 9];
      const a20 = M[o + 2], a21 = M[o + 6], a22 = M[o + 10];
      const b00 = R[0][0] * a00 + R[0][1] * a10 + R[0][2] * a20;
      const b01 = R[0][0] * a01 + R[0][1] * a11 + R[0][2] * a21;
      const b02 = R[0][0] * a02 + R[0][1] * a12 + R[0][2] * a22;
      const b10 = R[1][0] * a00 + R[1][1] * a10 + R[1][2] * a20;
      const b11 = R[1][0] * a01 + R[1][1] * a11 + R[1][2] * a21;
      const b12 = R[1][0] * a02 + R[1][1] * a12 + R[1][2] * a22;
      const b20 = R[2][0] * a00 + R[2][1] * a10 + R[2][2] * a20;
      const b21 = R[2][0] * a01 + R[2][1] * a11 + R[2][2] * a21;
      const b22 = R[2][0] * a02 + R[2][1] * a12 + R[2][2] * a22;
      const ox = M[o + 12], oy = M[o + 13], oz = M[o + 14];
      M[o] = b00; M[o + 4] = b01; M[o + 8] = b02;
      M[o + 1] = b10; M[o + 5] = b11; M[o + 9] = b12;
      M[o + 2] = b20; M[o + 6] = b21; M[o + 10] = b22;
      M[o + 12] = R[0][0] * ox + R[0][1] * oy + R[0][2] * oz + tx;
      M[o + 13] = R[1][0] * ox + R[1][1] * oy + R[1][2] * oz + ty;
      M[o + 14] = R[2][0] * ox + R[2][1] * oy + R[2][2] * oz + tz;
      for (let ci = 0; ci < bones.length; ci++) if (bones[ci].parent === cur) stack.push(ci);
    }
  }
  return mats;
}

/** 全姿态模型矩阵：R = Ry * Rx * Rz（支持翻滚/俯仰，不只有偏航）。 */
export function directorMat4ModelEuler(pos, rx, ry, rz, scale) {
  const cx = Math.cos(rx || 0), sx2 = Math.sin(rx || 0);
  const cy = Math.cos(ry || 0), sy2 = Math.sin(ry || 0);
  const cz = Math.cos(rz || 0), sz2 = Math.sin(rz || 0);
  // Ry * Rx * Rz
  const m00 = cy * cz + sy2 * sx2 * sz2;
  const m01 = -cy * sz2 + sy2 * sx2 * cz;
  const m02 = sy2 * cx;
  const m10 = cx * sz2;
  const m11 = cx * cz;
  const m12 = -sx2;
  const m20 = -sy2 * cz + cy * sx2 * sz2;
  const m21 = sy2 * sz2 + cy * sx2 * cz;
  const m22 = cy * cx;
  const scx = (scale && scale.x) || 1, scy = (scale && scale.y) || 1, scz = (scale && scale.z) || 1;
  const out = directorMat4Identity();
  out[0] = m00 * scx; out[1] = m10 * scx; out[2] = m20 * scx;
  out[4] = m01 * scy; out[5] = m11 * scy; out[6] = m21 * scy;
  out[8] = m02 * scz; out[9] = m12 * scz; out[10] = m22 * scz;
  out[12] = pos.x; out[13] = pos.y; out[14] = pos.z;
  return out;
}

export function directorMat3NormalFrom(pos, rotY, scale) {
  const c = Math.cos(Number(rotY) || 0), s = Math.sin(Number(rotY) || 0);
  const sx = (scale && scale.x) || 1, sy = (scale && scale.y) || 1, sz = (scale && scale.z) || 1;
  return new Float32Array([c / sx, 0, -s / sx, 0, 1 / sy, 0, s / sz, 0, c / sz]);
}
export function directorTriangulateFaces(faces) {
  const tris = [];
  (faces || []).forEach((f) => {
    const v = f.v || [];
    for (let i = 1; i + 1 < v.length; i++) tris.push([v[0], v[i], v[i + 1]]);
  });
  return tris;
}
function directorGlCompile(gl, type, srcStr) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, srcStr);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    try { console.warn('[director] shader 编译失败：' + gl.getShaderInfoLog(sh)); } catch { /* 忽略 */ }
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}
/**
 * WebGL 渲染器工厂：一次创建、反复 draw；无 WebGL 返回 null（调用方回落 Canvas2D）。
 * opts.draw(scene, {selectedId, grid, gizmo}) —— gizmo 时对象原点画三根轴 + 旋转环（深度测试关闭，永远可见）。
 */
// ============================================================
// glTF / GLB 资产管线：真实模型（含骨骼与动画）
//
// 为什么自己写：插件没有 node_modules、没有构建步骤，也要尽量避免引三方库；
// 导演台只需要 glTF 的一个子集——三角网格 + 蒙皮权重 + 骨架 + 动画轨道。
// 纹理一律忽略（导演台是白膜预演，材质统一成 CLY 白）。
// ============================================================
const GLB_MAGIC = 0x46546c67; // 'glTF'
function glbChunks(buf) {
  // 允许 ArrayBuffer / Buffer / TypedArray（Node 与浏览器传入形态不同）
  let ab;
  if (buf instanceof ArrayBuffer) ab = buf;
  else if (ArrayBuffer.isView(buf)) ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  else throw new Error('GLB 数据类型不支持');
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('不是 GLB 文件');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error('只支持 glTF 2.0（当前 ' + version + '）');
  const total = dv.getUint32(8, true);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < Math.min(total, ab.byteLength)) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, start, len)));
    else if (type === 0x004e4942) bin = new Uint8Array(ab, start, len);
    off = start + len;
    // 4 字节对齐
    if (off % 4) off += 4 - (off % 4);
  }
  if (!json) throw new Error('GLB 缺少 JSON 块');
  return { json, bin };
}

const GLTF_COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const GLTF_NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
/** 读一个 accessor → 扁平 TypedArray（只支持紧密排列或按 stride 步进）。 */
function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  const n = GLTF_NCOMP[acc.type] || 1;
  const Arr = GLTF_COMP[acc.componentType];
  const count = acc.count * n;
  const out = new Arr(count);
  const bv = gltf.bufferViews[acc.bufferView];
  if (!bv) return out;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  if (!bin) return out;
  const elemBytes = Arr.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || (elemBytes * n);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++) {
      const p = base + i * stride + c * elemBytes;
      let v2 = 0;
      switch (acc.componentType) {
        case 5120: v2 = dv.getInt8(p); break;
        case 5121: v2 = dv.getUint8(p); break;
        case 5122: v2 = dv.getInt16(p, true); break;
        case 5123: v2 = dv.getUint16(p, true); break;
        case 5125: v2 = dv.getUint32(p, true); break;
        default: v2 = dv.getFloat32(p, true); break;
      }
      out[i * n + c] = v2;
    }
  }
  // glTF 的 WEIGHTS/JOINTS 常用整数 + normalized：必须归一化到 0..1，
  // 否则 0-255 会被当成 0-255 的权重 → 顶点被放大糊到各关节位置（模型变一团球）。
  if (acc.normalized) {
    const scale = acc.componentType === 5121 ? 255 : acc.componentType === 5123 ? 65535 : acc.componentType === 5120 ? 127 : acc.componentType === 5122 ? 32767 : 0;
    if (scale) for (let i = 0; i < out.length; i++) out[i] = out[i] / scale;
  }
  return out;
}

function quatFromEulerXYZ(rx, ry, rz) {
  const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}
/** 四元数 → 3x3 旋转（行主序）。 */
function quatToM3(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}

/**
 * 解析 GLB → 导演台可渲染的资产。
 * @returns {{
 *   positions: Float32Array, normals: Float32Array, indices: Uint16Array|Uint32Array,
 *   joints: Uint16Array|null, weights: Float32Array|null,
 *   bones: Array<{name,parent,t,r,s,ibm:number[]}>|null,
 *   tris: number, verts: number,
 *   animations: Array<{name, duration, tracks: Array<{node, times, rot, pos}>}>
 * }}
 */
export function parseGlb(buf) {
  const { json: gltf, bin } = glbChunks(buf);
  if (!gltf.meshes || !gltf.meshes.length) throw new Error('模型没有网格');
  // 合并**全部** mesh/primitive：只看第一个会漏掉身体（历史 bug：只渲染出一只手）
  const posChunks = [];
  const nrmChunks = [];
  const jntChunks = [];
  const wgtChunks = [];
  const idxChunks = [];
  let vertBase = 0;
  for (let mi = 0; mi < gltf.meshes.length; mi++) {
    for (const p of gltf.meshes[mi].primitives || []) {
      if (p.attributes && p.attributes.POSITION !== undefined) {
        const pa = readAccessor(gltf, bin, p.attributes.POSITION);
        const na = p.attributes.NORMAL !== undefined ? readAccessor(gltf, bin, p.attributes.NORMAL) : new Float32Array(pa.length);
        posChunks.push(pa);
        nrmChunks.push(na);
        const cnt = pa.length / 3;
        if (p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined) {
          jntChunks.push(readAccessor(gltf, bin, p.attributes.JOINTS_0));
          wgtChunks.push(readAccessor(gltf, bin, p.attributes.WEIGHTS_0));
        } else {
          jntChunks.push(new Float32Array(cnt * 4));
          wgtChunks.push(new Float32Array(cnt * 4));
        }
        let ia;
        if (p.indices !== undefined) ia = readAccessor(gltf, bin, p.indices);
        else { ia = new Uint32Array(cnt); for (let i = 0; i < cnt; i++) ia[i] = i; }
        const off = new Uint32Array(ia.length);
        for (let i = 0; i < ia.length; i++) off[i] = ia[i] + vertBase;
        idxChunks.push(off);
        vertBase += cnt;
      }
    }
  }
  if (!posChunks.length) throw new Error('模型没有顶点');
  const cat = (chunks, Type) => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Type(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };
  const positions = cat(posChunks, Float32Array);
  const normals = cat(nrmChunks, Float32Array);
  const rawIdx = cat(idxChunks, Uint32Array);
  const needU32 = vertBase > 65535;
  const indices = needU32 ? rawIdx : Uint16Array.from(rawIdx);
  const joints = cat(jntChunks, Float32Array);
  const weights = cat(wgtChunks, Float32Array);
  const meshIndex = 0;
  // 骨架：只从 mesh 所属 node 的 skin 取
  let bones = null;
  const nodeOfMesh = (gltf.nodes || []).findIndex((n) => n.mesh === meshIndex);
  const skinIndex = nodeOfMesh >= 0 ? (gltf.nodes[nodeOfMesh].skin ?? -1) : -1;
  if (skinIndex >= 0 && gltf.skins && gltf.skins[skinIndex]) {
    const skin = gltf.skins[skinIndex];
    const ibm = skin.inverseBindMatrices !== undefined ? readAccessor(gltf, bin, skin.inverseBindMatrices) : null;
    // 建立节点父表
    const parentOf = new Array((gltf.nodes || []).length).fill(-1);
    (gltf.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => { parentOf[c] = i; }));
    bones = skin.joints.map((nodeIdx, bi) => {
      const n = gltf.nodes[nodeIdx] || {};
      const t = n.translation || [0, 0, 0];
      const r = n.rotation || [0, 0, 0, 1];
      const sc = n.scale || [1, 1, 1];
      const m = ibm ? Array.from(ibm.slice(bi * 16, bi * 16 + 16)) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      return { nodeIdx, name: String(n.name || ('bone' + bi)), parent: parentOf[nodeIdx], t, r, s: sc, ibm: m };
    });
  }
  // 节点表（世界矩阵要沿**全部节点**累乘：关节祖先里常有 Armature 之类的非关节节点，
  // 只沿关节链算会漏掉它们的变换，模型就会炸开/错位）
  const nodes = (gltf.nodes || []).map((n) => ({
    name: String(n.name || ''),
    t: n.translation || [0, 0, 0],
    r: n.rotation || [0, 0, 0, 1],
    s: n.scale || [1, 1, 1],
  }));
  const parentOfAll = new Array(nodes.length).fill(-1);
  (gltf.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => { parentOfAll[c] = i; }));
  // 动画：按**节点索引**存轨道（骨架/非骨架节点都可能被动画驱动）
  const animations = [];
  (gltf.animations || []).forEach((an, ai) => {
    const tracks = [];
    let dur = 0;
    (an.channels || []).forEach((ch) => {
      const smp = an.samplers[ch.sampler];
      if (!smp) return;
      const nodeIdx = ch.target.node;
      if (nodeIdx === undefined || !nodes[nodeIdx]) return;
      const path = ch.target.path;
      if (path !== 'rotation' && path !== 'translation') return;
      const times = readAccessor(gltf, bin, smp.input);
      const vals = readAccessor(gltf, bin, smp.output);
      dur = Math.max(dur, times.length ? times[times.length - 1] : 0);
      tracks.push({ node: nodeIdx, path, times, vals });
    });
    if (tracks.length) animations.push({ name: String(an.name || ('clip' + ai)), duration: dur || 1, tracks });
  });
  void nodeOfMesh;
  return {
    positions, normals, indices, joints, weights, bones,
    nodes, parentOfAll,
    verts: positions.length / 3, tris: indices.length / 3, animations,
  };
}

/** 采样动画轨道（线性插值；四元数用最短弧 nlerp）。 */
/**
 * 动画时间 → 循环时间。idle/run/walk 等骨骼动画片段都是循环动画：
 * 超过片段时长后必须取模循环播放，而不是钳在末帧（钳制会让角色在 ~1s 后定格，
 * 沿路径运动时表现为"定格姿态平移"——2026-10 用户实测反馈）。
 */
function animLoopTime(asset, time) {
  const anim = asset && asset._anim;
  const dur = anim && Number(anim.duration) > 1e-6 ? Number(anim.duration) : 0;
  const t = Math.max(0, Number(time) || 0);
  return dur > 0 ? (t % dur) : t;
}

function sampleTrack(track, time) {
  const n = track.times.length;
  if (!n) return null;
  if (time <= track.times[0]) return Array.from(track.vals.slice(0, track.path === 'rotation' ? 4 : 3));
  if (time >= track.times[n - 1]) {
    const s0 = (n - 1) * (track.path === 'rotation' ? 4 : 3);
    return Array.from(track.vals.slice(s0, s0 + (track.path === 'rotation' ? 4 : 3)));
  }
  let i = 0;
  while (i < n - 1 && track.times[i + 1] < time) i++;
  const t0 = track.times[i], t1 = track.times[i + 1];
  const k = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
  if (track.path === 'rotation') {
    const a = [track.vals[i * 4], track.vals[i * 4 + 1], track.vals[i * 4 + 2], track.vals[i * 4 + 3]];
    const b = [track.vals[i * 4 + 4], track.vals[i * 4 + 5], track.vals[i * 4 + 6], track.vals[i * 4 + 7]];
    // 球面插值：角速度恒定（原实现为 nlerp，长弧段会变速）
    return quatSlerp(a, b, k);
  }
  return [0, 1, 2].map((j) => track.vals[i * 3 + j] + (track.vals[(i + 1) * 3 + j] - track.vals[i * 3 + j]) * k);
}

/** 计算某一时刻每根骨的本地 TRS（含动画覆盖）。 */
/**
 * 计算骨骼矩阵（world = parentWorld · T · R · S），并乘 inverseBindMatrix 得到蒙皮矩阵。
 * @returns {{mats: Float32Array, count:number}|null} 每根骨 16 个 float，列主序
 */
export function boneMatrices(asset, time) {
  if (!asset || !asset.bones || !asset.nodes) return null;
  const anim = asset._anim;
  const t = animLoopTime(asset, time);
  // 1) 每节点本地 TRS（动画覆盖）
  const local = asset.nodes.map((n) => ({ t: n.t.slice(), r: n.r.slice(), s: n.s.slice() }));
  if (anim) {
    for (const tr of anim.tracks) {
      const v = sampleTrack(tr, t);
      if (!v || !local[tr.node]) continue;
      if (tr.path === 'rotation') local[tr.node].r = v;
      else local[tr.node].t = v;
    }
  }
  // 2) 全节点世界矩阵（自顶向下）
  const n = local.length;
  const worldM = new Array(n);
  const resolveNode = (i, guard) => {
    if (worldM[i]) return worldM[i];
    if (guard > 128) return directorMat4Identity();
    const L = local[i];
    const m = trsToMat4(L.t, L.r, L.s);
    const p = asset.parentOfAll ? asset.parentOfAll[i] : -1;
    worldM[i] = (p >= 0 && p !== i) ? directorMat4Multiply(resolveNode(p, guard + 1), m) : m;
    return worldM[i];
  };
  for (let i = 0; i < n; i++) resolveNode(i, 0);
  // 3) 蒙皮矩阵 = jointNodeWorld · inverseBindMatrix
  const out = new Float32Array(asset.bones.length * 16);
  asset.bones.forEach((b, bi) => {
    const w = worldM[b.nodeIdx] || directorMat4Identity();
    const skin = directorMat4Multiply(w, new Float32Array(b.ibm));
    out.set(skin, bi * 16);
  });
  return { mats: out, count: asset.bones.length };
}

/** TRS → 4x4（列主序）。 */
function trsToMat4(t, q, s) {
  const m = quatToM3(q);
  const out = new Float32Array(16);
  out[0] = m[0] * s[0]; out[1] = m[3] * s[0]; out[2] = m[6] * s[0];
  out[4] = m[1] * s[1]; out[5] = m[4] * s[1]; out[6] = m[7] * s[1];
  out[8] = m[2] * s[2]; out[9] = m[5] * s[2]; out[10] = m[8] * s[2];
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}
void quatFromEulerXYZ;

// ---------- 已加载的 glTF 资产登记表（assetId → 解析好的资产） ----------
const GLTF_ASSETS = new Map();
export function registerGltfAsset(id, asset) { GLTF_ASSETS.set(String(id), asset); return asset; }
export function gltfAssetOf(id) { return GLTF_ASSETS.get(String(id)) || null; }
export function gltfAssetIds() { return [...GLTF_ASSETS.keys()]; }

/** 屏幕点 → 地面(y=0) 世界坐标（点击放置资产用）；视线平行地面时返回 null。 */
export function groundPointFromScreen(cam, w, h, sx, sy) {
  const dir = screenRayDir(cam, w, h, sx, sy);
  if (!cam || !cam.pos) return null;
  if (Math.abs(dir.y) < 1e-4) return null;
  const t = -cam.pos.y / dir.y;
  if (!(t > 0)) return null;
  return v3(cam.pos.x + dir.x * t, 0, cam.pos.z + dir.z * t);
}

// ============================================================
// 真实模型包（assets/director/models/*.json）：base64 解码 + CPU 蒙皮
// ============================================================
function b64ToU8(b64) {
  if (!b64) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function b64ToF32(b64) { const u8 = b64ToU8(b64); return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4); }
function b64ToU16(b64) { const u8 = b64ToU8(b64); return new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2); }
function b64ToU32(b64) { const u8 = b64ToU8(b64); return new Uint32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4); }

/** 模型包 JSON → 与 parseGlb 同形的 asset（可直接喂 boneMatrices / 渲染）。 */
export function decodeModelPack(pack, actionClips) {
  const asset = {
    id: pack.id,
    label: pack.label,
    positions: b64ToF32(pack.positions),
    normals: b64ToF32(pack.normals),
    indices: pack.indexBits === 32 ? b64ToU32(pack.indices) : b64ToU16(pack.indices),
    joints: pack.joints ? b64ToF32(pack.joints) : null,
    weights: pack.weights ? b64ToF32(pack.weights) : null,
    bones: (pack.bones || []).map((b) => ({ nodeIdx: b.nodeIdx, name: b.name, parent: b.parent, t: b.t, r: b.r, s: b.s, ibm: b.ibm })),
    nodes: pack.nodes || [],
    parentOfAll: pack.parentOfAll || [],
    animations: (pack.animations || []).map((a) => ({
      name: a.name, duration: a.duration,
      tracks: a.tracks.map((t) => ({ node: t.node, path: t.path, times: b64ToF32(t.times), vals: b64ToF32(t.vals) })),
    })),
    rawHeight: pack.rawHeight,
    verts: pack.verts, tris: pack.tris,
  };
  // 动作库（内置成熟动作：three.js AnimationClip 转 tracks，base64 Float32）
  if (Array.isArray(actionClips)) {
    for (const c of actionClips) {
      if (!c || !c.name || !Array.isArray(c.tracks)) continue;
      // 只追加同名不存在的动作：内置片段（待机/行走/奔跑/潜行）保持原样，绝不被覆盖
      if (asset.animations.some((a) => a.name === c.name)) continue;
      asset.animations.push({
        name: c.name, duration: Number(c.duration) || 0, label: c.label || c.name, loop: !!c.loop,
        tracks: c.tracks.map((t) => ({ node: t.node, path: t.path, times: b64ToF32(t.times), vals: b64ToF32(t.vals) })),
      });
    }
  }
  asset.clipByName = (name) => asset.animations.find((a) => a.name === name) || null;
  return asset;
}
/** 解析动作库文件（clips/*.json，base64 tracks）→ decodeModelPack 第二参可直接用的数组。 */
export function decodeActionClips(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    name: String(c.name || ''),
    label: c.label || c.name || '',
    duration: Number(c.duration) || 0,
    loop: !!c.loop,
    tracks: (c.tracks || []).map((t) => ({ node: t.node, path: t.path, times: t.times, vals: t.vals })),
  }));
}

/**
 * CPU 蒙皮：算出某一时刻的顶点/法线（写进传入的复用数组，避免每帧分配）。
 * @returns {{pos:Float32Array, nrm:Float32Array}|null}
 */
/**
 * 体型形变：在 CPU 蒙皮结果上按「主导骨骼」做局部几何变化。
 * 不是整体缩放——女性加胸部体积、丰腴加腹部、健壮加四肢围度、儿童收窄肩胯。
 * shape: { bust, belly, muscle, shoulder, hip, heightShift }
 */
// waist：腰部横向系数（男性 >1 直腰方厚，女性 <1 收腰）；chestFlat：男性压扁胸部正面
const BODY_SHAPE_OF = {
  m_standard: { bust: 0, belly: 0.00, muscle: 0.32, shoulder: 1.12, hip: 1.02, waist: 1.16, chestFlat: 0.10 },
  f_standard: { bust: 1.00, belly: 0.04, muscle: 0.00, shoulder: 0.94, hip: 1.10, waist: 0.88, chestFlat: 0 },
  m_teen: { bust: 0, belly: 0.02, muscle: 0.14, shoulder: 1.00, hip: 0.98, waist: 1.08, chestFlat: 0.08 },
  f_teen: { bust: 0.62, belly: 0.03, muscle: 0.00, shoulder: 0.90, hip: 1.02, waist: 0.90, chestFlat: 0 },
  m_child: { bust: 0, belly: 0.06, muscle: 0.00, shoulder: 0.84, hip: 0.88, waist: 1.02, chestFlat: 0.04 },
  f_child: { bust: 0.18, belly: 0.06, muscle: 0.00, shoulder: 0.82, hip: 0.90, waist: 0.94, chestFlat: 0 },
  m_slim: { bust: 0, belly: -0.02, muscle: 0.12, shoulder: 1.04, hip: 0.96, waist: 1.06, chestFlat: 0.10 },
  f_slim: { bust: 0.78, belly: -0.03, muscle: 0.00, shoulder: 0.88, hip: 0.98, waist: 0.84, chestFlat: 0 },
  m_muscular: { bust: 0, belly: -0.02, muscle: 0.62, shoulder: 1.26, hip: 1.08, waist: 1.16, chestFlat: 0.12 },
  f_muscular: { bust: 0.90, belly: -0.02, muscle: 0.38, shoulder: 1.06, hip: 1.10, waist: 0.92, chestFlat: 0 },
  m_plump: { bust: 0, belly: 0.34, muscle: 0.10, shoulder: 1.16, hip: 1.22, waist: 1.24, chestFlat: 0.02 },
  f_plump: { bust: 1.15, belly: 0.32, muscle: 0.02, shoulder: 1.02, hip: 1.24, waist: 1.00, chestFlat: 0 },
};
export function bodyShapeOf(typeId) { return BODY_SHAPE_OF[typeId] || BODY_SHAPE_OF.m_standard; }

/** 对已蒙皮顶点做体型形变（原地）。asset 提供 joints/weights/bones 用于判定主导骨骼。 */
function applyBodyShape(asset, pos, shape) {
  if (!shape || !asset.bones || !asset.joints || !asset.weights) return;
  const bones = asset.bones;
  const J = asset.joints, W = asset.weights;
  const nv = pos.length / 3;
  const { bust = 0, belly = 0, muscle = 0, shoulder = 1, hip = 1, waist = 1, chestFlat = 0 } = shape;
  // 形变带按「相对身高」计算，不再用绝对米：xbot 是米制（rawHeight≈1.8），
  // soldier≈44、explorer≈194 都是厘米制——绝对带在它们身上会错位到脚踝（形变静默失效）。
  // k = 该资产身高 / 基准身高 1.809（这些带最初按 xbot 调的）。
  let Hm = asset._shapeH;
  if (!Hm) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 1; i < pos.length; i += 3) { const y = pos[i]; if (y < mn) mn = y; if (y > mx) mx = y; }
    Hm = (Number.isFinite(mn) && mx > mn) ? (mx - mn) : 1.8;
    asset._shapeH = Hm;
  }
  const k = Hm / 1.809;              // 长度缩放（y 带中心/宽度、横向高斯宽度都用它）
  for (let v = 0; v < nv; v++) {
    // 主导骨骼
    let bi = -1, bw = 0;
    for (let k = 0; k < 4; k++) { const w = W[v * 4 + k]; if (w > bw) { bw = w; bi = J[v * 4 + k]; } }
    if (bi < 0 || bi >= bones.length) continue;
    const nm = (bones[bi].name || '').toLowerCase();
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let nx = x, ny = y, nz = z;
    const isTorso = /spine|chest|hips|neck/.test(nm);
    const isArm = /arm|hand|forearm|shoulder|clav/.test(nm);
    const isLeg = /thigh|leg|shin|foot/.test(nm);
    // 腰部横向：男性直腰（>1），女性收腰（<1）——这是男女轮廓最关键的区别
    if (isTorso && /spine1|spine|hips/.test(nm) && y > 0.47 * Hm && y < 0.675 * Hm) {
      const gw = Math.exp(-Math.pow((y - 0.5694 * Hm) / (0.0774 * Hm), 2));
      nx *= 1 + (waist - 1) * gw;
    }
    // 男性胸部正面压扁（女性不压）
    if (chestFlat > 0 && isTorso && /chest|spine2/.test(nm) && y > 0.663 * Hm && z > 0) {
      nz *= 1 - chestFlat;
    }
    // 肩胯宽度
    if (isTorso && /chest|spine2|spine1|spine|clav/.test(nm)) nx *= shoulder;
    if (isTorso && /hips/.test(nm)) { nx *= hip; nz *= hip * 0.98; }
    // 腹部体积：腹部（y 在中段）向前鼓
    if (belly > 0 && isTorso && y > 0.4146 * Hm && y < 0.8016 * Hm) {
      const g = Math.exp(-Math.pow((y - 0.597 * Hm) / (0.1216 * Hm), 2));
      nz += belly * 0.085 * k * g * Math.exp(-Math.pow(x / (0.19 * k), 2));
      nx *= 1 + belly * 0.10 * g;
    }
    if (belly < 0 && isTorso) { nx *= 1 + belly * 0.25; nz *= 1 + belly * 0.25; }
    // 胸部体积（女性）：胸前两侧隆起
    if (bust > 0 && isTorso && y > 0.630 * Hm && y < 0.840 * Hm && z > 0) {
      const gg = Math.exp(-Math.pow((y - 0.735 * Hm) / (0.0553 * Hm), 2));
      const lobe = Math.exp(-Math.pow((Math.abs(x) - 0.075 * k) / (0.055 * k), 2));
      nz += bust * 0.075 * k * gg * lobe;
    }
    // 肌肉围度：四肢加粗
    if (muscle > 0 && (isArm || isLeg)) {
      const k = 1 + muscle * (/forearm|hand|shin|foot/.test(nm) ? 0.10 : 0.22);
      nx *= k; nz *= k;
    }
    if (nx !== x || ny !== y || nz !== z) { pos[v * 3] = nx; pos[v * 3 + 1] = ny; pos[v * 3 + 2] = nz; }
  }
}

/** 欧拉角（XYZ）→ 四元数 [x,y,z,w] */
function eulerToQuat(rx, ry, rz) {
  const hx = rx * 0.5, hy = ry * 0.5, hz = rz * 0.5;
  const cx = Math.cos(hx), sx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  // q = qz * qy * qx
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

/** 四元数乘法 a*b（先 a 后 b） */
function quatMul(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * 带骨骼姿态的蒙皮矩阵（Blender 语义：pose_mat = parent · rest · chan_mat）。
 * 做法：把姿态旋转叠加到「该骨骼节点的局部旋转」上，再自顶向下重算世界矩阵，
 * 最后乘 inverseBind。因为子骨天然继承父骨局部变换，整条链保持刚性，不会碎。
 */
/**
 * 在「已应用的局部变换」上施加方向约束（就地修改 local）。
 * local: [{t,r,s}]；dirs: [{bone, to}]。基于当前动画后的姿势求解，因此与动画叠加也正确。
 */
function solveDirsIntoLocal(asset, local, dirs) {
  if (!asset || !asset.nodes || !dirs || !dirs.length) return;
  const bones = asset.bones || [];
  const nW = local.length;
  const worldM = new Array(nW);
  const parentOf = (i) => (asset.parentOfAll ? asset.parentOfAll[i] : -1);
  const resolve = (i, guard) => {
    if (worldM[i]) return worldM[i];
    if (guard > 200) return directorMat4Identity();
    const Lp = local[i];
    const m = trsToMat4(Lp.t, Lp.r, Lp.s);
    const p = parentOf(i);
    worldM[i] = (p >= 0 && p !== i) ? directorMat4Multiply(resolve(p, guard + 1), m) : m;
    return worldM[i];
  };
  for (let i = 0; i < nW; i++) resolve(i, 0);
  const short = (n) => String(n || '').replace(/^mixamorig:?/i, '');
  const depthOfNode = (ni) => { let d = 0, c = ni; while (c >= 0 && d < 200) { c = parentOf(c); if (c < 0) break; d++; } return d; };
  const list = dirs.slice().sort((a, b) => {
    const ia = bones.findIndex((x) => short(x.name) === a.bone), ib = bones.findIndex((x) => short(x.name) === b.bone);
    return depthOfNode(ia >= 0 ? bones[ia].nodeIdx : 0) - depthOfNode(ib >= 0 ? bones[ib].nodeIdx : 0);
  });
  for (const d of list) {
    const bi = bones.findIndex((x) => short(x.name) === d.bone);
    if (bi < 0) continue;
    const ni = bones[bi].nodeIdx;
    if (ni === undefined || ni < 0 || !local[ni]) continue;
    const M = worldM[ni];
    const R = m3ortho(mat3FromM4(M, 0));
    let childNi = -1;
    const childName = BONE_CHILD[d.bone];
    if (childName) { const ci = bones.findIndex((x) => short(x.name) === childName); if (ci >= 0) childNi = bones[ci].nodeIdx; }
    let vLocal;
    if (childNi >= 0 && worldM[childNi]) {
      const cw = worldM[childNi], bw = worldM[ni];
      const dw = [cw[12] - bw[12], cw[13] - bw[13], cw[14] - bw[14]];
      const len = Math.hypot(dw[0], dw[1], dw[2]) || 1;
      vLocal = m3v(m3t(R), [dw[0] / len, dw[1] / len, dw[2] / len]);
    } else vLocal = [0, 1, 0];
    const T = d.to;
    const Tl = Math.hypot(T[0], T[1], T[2]) || 1;
    const Tw = [T[0] / Tl, T[1] / Tl, T[2] / Tl];
    const u = m3v(m3t(R), Tw);
    const q = quatFromTo(vLocal, u);
    local[ni].r = quatMul(local[ni].r, q);
    const refresh = (i2) => {
      const p = parentOf(i2);
      const m2 = trsToMat4(local[i2].t, local[i2].r, local[i2].s);
      worldM[i2] = (p >= 0 && p !== i2) ? directorMat4Multiply(worldM[p], m2) : m2;
      for (let c = 0; c < nW; c++) if (parentOf(c) === i2) refresh(c);
    };
    refresh(ni);
  }
}

/* ============================================================
 * 约束与 IK（Phase C）
 *   约束：damped_track（骨骼 Y 轴指向目标）/ copy_rotation / limit_rotation
 *   IK：两骨解析解（余弦定理 + 极向量），链 = [根骨, 中间骨, 末端骨]
 * 求值顺序对齐 Blender：FK 姿态 → 约束 → IK（constraint.cc / ikplugin 语义；算法自行实现）
 * ============================================================ */
/** 四元数 → 欧拉（ZYX 顺序，与 eulerToQuat 的 qz*qy*qx 对应）。 */
export function quatToEuler(q) {
  const x = Number(q && q[0]) || 0, y = Number(q && q[1]) || 0, z = Number(q && q[2]) || 0, w = Number(q && q[3]) || 1;
  const m00 = 1 - 2 * (y * y + z * z), m10 = 2 * (x * y + z * w), m20 = 2 * (x * z - y * w);
  const m21 = 2 * (y * z + x * w), m22 = 1 - 2 * (x * x + y * y);
  const beta = Math.asin(Math.max(-1, Math.min(1, -m20)));
  if (Math.abs(m20) < 0.9999999) {
    return [Math.atan2(m21, m22), beta, Math.atan2(m10, m00)];
  }
  // 万向锁兜底
  const m01 = 2 * (x * y - z * w), m11 = 1 - 2 * (x * x + z * z);
  return [Math.atan2(-m01, m11), beta, 0];
}
/** 罗德里格斯：绕单位轴 axis 旋转 v 角 ang。 */
function rotateVecAxis(v, axis, ang) {
  const c = Math.cos(ang), s2 = Math.sin(ang);
  const d = v.x * axis.x + v.y * axis.y + v.z * axis.z;
  const cr = vCross(axis, v);
  return v3(
    v.x * c + cr.x * s2 + axis.x * d * (1 - c),
    v.y * c + cr.y * s2 + axis.y * d * (1 - c),
    v.z * c + cr.z * s2 + axis.z * d * (1 - c),
  );
}
/** 由 local 变换算世界矩阵表（与 boneMatricesWithPose 的 ② 同构）。 */
function localWorldMatrices(asset, local) {
  const n = local.length;
  const worldM = new Array(n);
  const parentOf = (i) => (asset.parentOfAll ? asset.parentOfAll[i] : -1);
  const resolve = (i, guard) => {
    if (worldM[i]) return worldM[i];
    if (guard > 128) return directorMat4Identity();
    const Lp = local[i];
    const m = trsToMat4(Lp.t, Lp.r, Lp.s);
    const p = parentOf(i);
    worldM[i] = (p >= 0 && p !== i) ? directorMat4Multiply(resolve(p, guard + 1), m) : m;
    return worldM[i];
  };
  for (let i = 0; i < n; i++) resolve(i, 0);
  return worldM;
}
const m4pos = (m) => v3(m[12], m[13], m[14]);
/** IK 目标点：target 支持 [x,y,z] / {x,y,z} / {keys:[{t,pos:[x,y,z]}]}。 */
export function ikTargetPoint(spec, time) {
  const t = spec && spec.target;
  if (!t) return null;
  if (Array.isArray(t)) return v3(Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0);
  if (typeof t === 'object') {
    if (Array.isArray(t.keys) && t.keys.length) {
      const gx = evalKeyChannel(t.keys, (k) => (k.pos ? k.pos[0] : undefined), time);
      const gy = evalKeyChannel(t.keys, (k) => (k.pos ? k.pos[1] : undefined), time);
      const gz = evalKeyChannel(t.keys, (k) => (k.pos ? k.pos[2] : undefined), time);
      return v3(gx === null ? 0 : gx, gy === null ? 0 : gy, gz === null ? 0 : gz);
    }
    return v3(Number(t.x) || 0, Number(t.y) || 0, Number(t.z) || 0);
  }
  return null;
}
/**
 * 两骨解析 IK 的方向解：给定三关节世界位置与目标，返回 [根骨方向, 中间骨方向]（世界单位向量）。
 * 复用引擎的方向求解器落地到 local 旋转（见 resolveIkAndConstraints）。
 */
export function solveTwoBoneDirs(j0, j1, j2, target, pole) {
  const L1 = vLen(vSub(j1, j0)), L2 = vLen(vSub(j2, j1));
  const v = vSub(target, j0);
  const dRaw = vLen(v) || 1e-6;
  const d = Math.max(Math.abs(L1 - L2) + 1e-4, Math.min(L1 + L2 - 1e-4, dRaw));
  const dir = vMul(v, 1 / dRaw);
  let bend = pole ? vSub(pole, j0) : vSub(j1, j0);
  let axis = vCross(dir, bend);
  if (vLen(axis) < 1e-6) {
    axis = vCross(dir, v3(0, 1, 0));
    if (vLen(axis) < 1e-6) axis = vCross(dir, v3(1, 0, 0));
  }
  axis = vNorm(axis);
  const cos1 = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  const a1 = Math.acos(cos1);
  // 绕 axis 旋转 dir 得到根骨方向；若与极向量方向相反则取负角（弯向极向量）
  let upperDir = rotateVecAxis(dir, axis, a1);
  const mid0 = vAdd(j0, vMul(upperDir, L1));
  if (pole && vDot(vSub(mid0, j0), vSub(pole, j0)) < 0) upperDir = rotateVecAxis(dir, axis, -a1);
  const mid = vAdd(j0, vMul(upperDir, L1));
  const endTarget = vAdd(j0, vMul(dir, d));
  const lowerDir = vLen(vSub(endTarget, mid)) < 1e-6 ? upperDir : vNorm(vSub(endTarget, mid));
  return [upperDir, lowerDir];
}
/** 应用约束 + IK 到 local（就地修改 local 旋转）。 */
export function resolveIkAndConstraints(asset, local, opts, time) {
  if (!asset || !local || !opts) return;
  const bones = asset.bones || [];
  const t = Math.max(0, Number(time) || 0);
  const shortOf = (kw) => String(kw || '').replace(/^mixamorig:?/i, '');
  const parentOfNode = (i) => (asset.parentOfAll ? asset.parentOfAll[i] : -1);
  const childNodeOf = (bi) => {
    const cn = BONE_CHILD[shortOf(bones[bi].name)];
    if (!cn) return -1;
    const ci = bones.findIndex((x) => shortOf(x.name) === cn);
    return ci >= 0 ? bones[ci].nodeIdx : -1;
  };
  /**
   * 把某根骨骼转到「世界方向 targetDir」：qLocal = P⁻¹ · qWorld · P（P=父节点世界旋转），
   * 这样旋转轴心恒为该骨骼关节（不会像旧 dirs 路径那样绕原点转整条骨架）。
   */
  const aimBone = (worldMIn, bi, targetDir) => {
    const ni = bones[bi].nodeIdx;
    if (!(ni >= 0) || !local[ni]) return worldMIn;
    const want = vNorm(v3(Number(targetDir.x) || 0, Number(targetDir.y) || 0, Number(targetDir.z) || 0));
    if (vLen(want) < 1e-9) return worldMIn;
    const childNi = childNodeOf(bi);
    let wm = worldMIn;
    // 迭代修正：父级含缩放/非正交时，一次共轭会有几度系统残差；迭代 3 次收敛到 1e-6
    for (let iter = 0; iter < 3; iter++) {
      const bw = wm[ni];
      const head = v3(bw[12], bw[13], bw[14]);
      let cur;
      if (childNi >= 0 && wm[childNi]) {
        const cw = wm[childNi];
        cur = vNorm(v3(cw[12] - head.x, cw[13] - head.y, cw[14] - head.z));
      } else {
        cur = vNorm(v3(bw[4], bw[5], bw[6]));
      }
      if (vLen(cur) < 1e-9 || vDot(cur, want) > 0.9999999) break;
      const qW = quatFromTo([cur.x, cur.y, cur.z], [want.x, want.y, want.z]);
      const pn = parentOfNode(ni);
      const P = pn >= 0 && wm[pn] ? mat4RotationQuat(wm[pn]) : [0, 0, 0, 1];
      const qLocal = quatMul(quatConj(P), quatMul(qW, P));
      local[ni].r = quatMul(qLocal, local[ni].r);
      wm = localWorldMatrices(asset, local);
    }
    return wm;
  };

  // ── ① 约束（copy / limit 先做，不需要世界矩阵；damped_track 需要世界矩阵）──
  let worldM = null;
  for (const c of Array.isArray(opts.constraints) ? opts.constraints : []) {
    if (!c || !c.bone) continue;
    const bi = matchBone(bones, c.bone);
    if (bi < 0) continue;
    const ni = bones[bi].nodeIdx;
    if (!(ni >= 0) || !local[ni]) continue;
    const type = String(c.type || '').toLowerCase();
    if (type === 'copy_rotation' || type === 'copyrotation') {
      const fromBi = matchBone(bones, c.from || c.source || '');
      if (fromBi < 0) continue;
      const fni = bones[fromBi].nodeIdx;
      if (!(fni >= 0) || !local[fni]) continue;
      const mix = Math.max(0, Math.min(1, Number(c.mix === undefined ? 1 : c.mix)));
      local[ni].r = mix >= 1 ? local[fni].r.slice() : quatSlerp(local[ni].r, local[fni].r, mix);
    } else if (type === 'limit_rotation' || type === 'limitrotation') {
      const e = quatToEuler(local[ni].r);
      const mn = Array.isArray(c.min) ? c.min : [-Math.PI, -Math.PI, -Math.PI];
      const mx = Array.isArray(c.max) ? c.max : [Math.PI, Math.PI, Math.PI];
      for (let k = 0; k < 3; k++) {
        const lo = Number(mn[k]); const hi = Number(mx[k]);
        if (Number.isFinite(lo)) e[k] = Math.max(lo, e[k]);
        if (Number.isFinite(hi)) e[k] = Math.min(hi, e[k]);
      }
      local[ni].r = eulerToQuat(e[0], e[1], e[2]);
    } else if (type === 'damped_track' || type === 'dampedtrack' || type === 'track') {
      const tp = ikTargetPoint(c, t);
      if (!tp) continue;
      worldM = worldM || localWorldMatrices(asset, local);
      const head = v3(worldM[ni][12], worldM[ni][13], worldM[ni][14]);
      const dir = vSub(tp, head);
      if (vLen(dir) < 1e-6) continue;
      worldM = aimBone(worldM, bi, vNorm(dir));
    }
  }

  // ── ② IK：两骨解析（链 = [根骨, 中间骨, 末端骨]）──
  const chains = Array.isArray(opts.ik) ? opts.ik : [];
  for (const spec of chains) {
    const names = (spec && Array.isArray(spec.chain) ? spec.chain : []).map(String);
    if (names.length < 3) continue;
    const bis = names.map((n) => matchBone(bones, n));
    if (bis.some((x) => x < 0)) continue;
    const nodes = bis.map((bi) => bones[bi].nodeIdx);
    if (nodes.some((n2) => !(n2 >= 0))) continue;
    const target = ikTargetPoint(spec, t);
    if (!target) continue;
    worldM = worldM || localWorldMatrices(asset, local);
    const j0 = v3(worldM[nodes[0]][12], worldM[nodes[0]][13], worldM[nodes[0]][14]);
    const j1 = v3(worldM[nodes[1]][12], worldM[nodes[1]][13], worldM[nodes[1]][14]);
    const j2 = v3(worldM[nodes[2]][12], worldM[nodes[2]][13], worldM[nodes[2]][14]);
    const pole = spec.pole
      ? (Array.isArray(spec.pole) ? v3(Number(spec.pole[0]) || 0, Number(spec.pole[1]) || 0, Number(spec.pole[2]) || 0) : ikTargetPoint({ target: spec.pole }, t))
      : null;
    const solved = solveTwoBoneDirs(j0, j1, j2, target, pole || null);
    worldM = aimBone(worldM, bis[0], solved[0]);
    worldM = aimBone(worldM, bis[1], solved[1]);
  }
}

/**
 * 仅应用姿态/约束/IK 到 local（不计算世界矩阵/蒙皮矩阵）。
 * 测试与工具用它拿「节点空间」结果；预览/导出走的 boneMatricesWithPose 内部同样调用它。
 */
export function applyBonePoseToLocal(asset, time, poseMap, dirs, baseEuler, rootY, opts) {
  if (!asset || !asset.bones || !asset.nodes) return null;

  if (!asset || !asset.bones || !asset.nodes) return null;
  const anim = asset._anim;
  const t = animLoopTime(asset, time);
  const local = asset.nodes.map((n) => ({ t: n.t.slice(), r: n.r.slice(), s: n.s.slice() }));
  if (anim) {
    for (const tr of anim.tracks) {
      const v = sampleTrack(tr, t);
      if (!v || !local[tr.node]) continue;
      if (tr.path === 'rotation') local[tr.node].r = v;
      else local[tr.node].t = v;
    }
  }
  // ① 姿态旋转叠加到骨骼节点局部旋转（post-multiply：绕骨骼自身轴）
  if (poseMap) {
    for (const [k, rot] of Object.entries(poseMap)) {
      const bi = Number(k);
      const bone = asset.bones[bi];
      if (!bone) continue;
      const ni = bone.nodeIdx;
      if (ni === undefined || ni < 0 || !local[ni]) continue;
      // rot 支持两种：[rx,ry,rz] 欧拉（3 个）或 [x,y,z,w] 四元数（4 个，求解器输出）
      const q = (rot && rot.length === 4)
        ? [Number(rot[0]), Number(rot[1]), Number(rot[2]), Number(rot[3])]
        : eulerToQuat(Number(rot[0]) || 0, Number(rot[1]) || 0, Number(rot[2]) || 0);
      local[ni].r = quatMul(local[ni].r, q);
    }
  }
  // ①b 姿态基底（欧拉，作用在动画之上）
  if (baseEuler) {
    for (const [kw, rot] of Object.entries(baseEuler)) {
      const bi2 = (asset.bones || []).findIndex((x) => String(x.name || "").replace(/^mixamorig:?/i, "") === kw);
      if (bi2 < 0) continue;
      const ni2 = asset.bones[bi2].nodeIdx;
      if (ni2 === undefined || !local[ni2]) continue;
      local[ni2].r = quatMul(local[ni2].r, eulerToQuat(Number(rot[0]) || 0, Number(rot[1]) || 0, Number(rot[2]) || 0));
    }
  }
  // ①b2 根位移：把 Hips 整体上下平移（下蹲/轻功这类需要骨盆升降的姿势）
  if (typeof rootY === "number" && rootY !== 0) {
    const hi = (asset.bones || []).findIndex((x) => String(x.name || "").replace(/^mixamorig:?/i, "") === "Hips");
    if (hi >= 0) {
      const ni3 = asset.bones[hi].nodeIdx;
      if (ni3 !== undefined && local[ni3] && local[ni3].t) {
        // rootY 以「米」为单位，而骨骼节点位移是模型本地位（xbot 为厘米级 ~100×）
        const kRoot = 100;
        local[ni3].t[1] += rootY * kRoot;
      }
    }
  }
  // ①b2 动作层（BVH 重定向后的 poseKeys / NLA-lite）：以姿态增量叠加到当前姿势
  if (opts && Array.isArray(opts.clips) && opts.clips.length) {
    const cpm = sampleClips(asset, opts.clips, time || 0);
    for (const [kk, rot] of Object.entries(cpm || {})) {
      const bi2 = Number(kk);
      const bone2 = asset.bones[bi2];
      if (!bone2) continue;
      const ni2 = bone2.nodeIdx;
      if (!(ni2 >= 0) || !local[ni2]) continue;
      const q2 = rot.length === 4 ? rot : eulerToQuat(Number(rot[0]) || 0, Number(rot[1]) || 0, Number(rot[2]) || 0);
      local[ni2].r = quatMul(local[ni2].r, q2);
    }
  }
  // ①c 方向约束（基于「动画 + 基底」后的当前姿势求解，因此永远不会被动画带偏）
  if (dirs && dirs.length) solveDirsIntoLocal(asset, local, dirs);
  // ①d 约束 + IK（FK 之后；对齐 Blender 求值顺序：姿势 → 约束 → IK）
  if (opts && (Array.isArray(opts.ik) || Array.isArray(opts.constraints))) resolveIkAndConstraints(asset, local, opts, time || 0);

  return local;
}

/** 节点空间世界矩阵（与 boneMatrices 同一套 TRS 组合；供 IK/测试/工具使用）。 */
export { localWorldMatrices };

/* ============================================================
 * 动捕数据接入（Phase D）：BVH 解析 → rest-delta 重定向 → 动作层混合
 *   参考 Blender 的骨骼 rest/pose 矩阵语义（arm_mat / pose_mat）与 NLA strip
 *   混合（replace/add/multiply + influence）；算法自行实现（GPL 兼容性）。
 * ============================================================ */
const normBone = (n) => String(n || '').toLowerCase().replace(/^mixamorig:?/i, '').replace(/[^a-z0-9]/g, '');
/** 解析 BVH 文本 → { joints:[{name,parent,offset,channels,end}], frames:number[][], frameTime }。 */
export function parseBVH(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const joints = [];
  const stack = [];
  let frameTime = 1 / 30;
  const frames = [];
  let mode = 'hierarchy';
  let pendingFrames = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    if (/^MOTION$/i.test(line)) { mode = 'motion'; continue; }
    if (mode === 'motion') {
      const fm = /^Frames:\s*(\d+)/i.exec(line);
      if (fm) { pendingFrames = Number(fm[1]); continue; }
      const tm = /^Frame Time:\s*([\d.eE+-]+)/i.exec(line);
      if (tm) { frameTime = Number(tm[1]) || frameTime; continue; }
      const vals = line.split(/[\s,]+/).filter((x) => x !== '').map(Number).filter((x) => Number.isFinite(x));
      if (vals.length) frames.push(vals);
      continue;
    }
    const head = /^(ROOT|JOINT)\s+(\S+)/i.exec(line);
    if (head) {
      const parent = stack.length ? stack[stack.length - 1] : -1;
      const idx = joints.length;
      joints.push({ name: head[2], parent, offset: [0, 0, 0], channels: [], end: false });
      stack.push(idx);
      continue;
    }
    if (/^End Site/i.test(line)) {
      const parent = stack.length ? stack[stack.length - 1] : -1;
      joints.push({ name: 'End_' + joints.length, parent, offset: [0, 0, 0], channels: [], end: true });
      stack.push(joints.length - 1);
      continue;
    }
    if (/^OFFSET/i.test(line)) {
      const p = line.split(/\s+/);
      const cur = joints[stack[stack.length - 1]];
      if (cur) cur.offset = [Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0];
      continue;
    }
    if (/^CHANNELS/i.test(line)) {
      const p = line.split(/\s+/);
      const cur = joints[stack[stack.length - 1]];
      if (cur) cur.channels = p.slice(2);
      continue;
    }
    if (line === '}') { stack.pop(); continue; }
  }
  const totalFrames = pendingFrames || frames.length;
  return { joints, frames: frames.slice(0, totalFrames || frames.length), frameTime };
}
/** BVH 关节名 → 资产骨骼索引（按规范化名精确匹配；找不到跳过）。 */
export function mapBVHToBones(asset, bvh) {
  const bones = (asset && asset.bones) || [];
  const byName = new Map();
  bones.forEach((b, bi) => byName.set(normBone(b.name), bi));
  const map = [];
  for (const j of (bvh && bvh.joints) || []) map.push(byName.has(normBone(j.name)) ? byName.get(normBone(j.name)) : -1);
  return map;
}
/** 单帧关节局部旋转（按通道顺序，第一通道最外层）。 */
export function bvhJointLocalQuat(joint, values, offset) {
  let q = [0, 0, 0, 1];
  let k = offset;
  for (const ch of (joint && joint.channels) || []) {
    const rad = (Number(values[k]) || 0) * Math.PI / 180;
    let qi;
    if (/^Xrotation$/i.test(ch)) qi = [Math.sin(rad / 2), 0, 0, Math.cos(rad / 2)];
    else if (/^Yrotation$/i.test(ch)) qi = [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
    else if (/^Zrotation$/i.test(ch)) qi = [0, 0, Math.sin(rad / 2), Math.cos(rad / 2)];
    else { k++; continue; }
    q = quatMul(q, qi);
    k++;
  }
  return q;
}
/**
 * BVH → 目标骨架的 poseKeys（rest-delta 重定向）：
 *   q_target = q_rest_local · q_src_local（xbot 的 rest 局部旋转基本为单位四元数，故近似为局部旋转叠加）
 * 返回 { poseKeys:[{t,bonePose, ease}], duration, frameTime }。
 */
export function retargetBVH(asset, bvh, opts) {
  const o = opts || {};
  if (!asset || !bvh || !Array.isArray(bvh.frames) || !bvh.frames.length) return { poseKeys: [], duration: 0, frameTime: bvh ? bvh.frameTime : 0 };
  const map = mapBVHToBones(asset, bvh);
  const channelsBefore = [];
  {
    let acc = 0;
    for (const j of bvh.joints) { channelsBefore.push(acc); acc += (j.channels || []).length; }
  }
  const poseKeys = [];
  const frameStep = o.sampleStep ? Math.max(1, Math.round(o.sampleStep)) : 1;
  for (let f = 0; f < bvh.frames.length; f += frameStep) {
    const values = bvh.frames[f];
    const bonePose = {};
    let any = false;
    for (let ji = 0; ji < bvh.joints.length; ji++) {
      const bi = map[ji];
      if (bi < 0) continue;
      const qSrc = bvhJointLocalQuat(bvh.joints[ji], values, channelsBefore[ji]);
      const bone = asset.bones[bi];
      const qRest = bone && bone.r && bone.r.length === 4 ? bone.r : [0, 0, 0, 1];
      bonePose[bi] = quatMul([Number(qRest[0]) || 0, Number(qRest[1]) || 0, Number(qRest[2]) || 0, Number(qRest[3]) || 1], qSrc);
      any = true;
    }
    if (any) poseKeys.push({ t: f * (Number(bvh.frameTime) || 1 / 30), bonePose });
  }
  return {
    poseKeys,
    duration: bvh.frames.length * (Number(bvh.frameTime) || 1 / 30),
    frameTime: Number(bvh.frameTime) || 1 / 30,
  };
}
/**
 * 动作层混合（NLA-lite）：clip = { keys:[{t,bonePose}], t0, t1, loop, blend:'replace'|'add'|'multiply', influence }
 * 返回 poseMap（boneIndex → 四元数），供 skinModel 以「姿态增量」叠加。
 */
export function sampleClips(asset, clips, time) {
  const out = {};
  const t = Math.max(0, Number(time) || 0);
  for (const clip of Array.isArray(clips) ? clips : []) {
    const keys = Array.isArray(clip && clip.keys) ? clip.keys : [];
    if (!keys.length) continue;
    const t0 = Number(clip.t0) || 0;
    const lastT = Number(keys[keys.length - 1].t) || 0;
    const t1 = Number(clip.t1) || lastT;
    const dur = Math.max(1e-6, t1 - t0);
    let tl = t - t0;
    if (clip.loop) tl = ((tl % dur) + dur) % dur;
    tl = Math.max(0, Math.min(dur, tl));
    const pm = interpolatePoseKeys(keys, tl);
    if (!pm) continue;
    const influence = Math.max(0, Math.min(1, Number(clip.influence === undefined ? 1 : clip.influence)));
    const mode = String(clip.blend || 'replace').toLowerCase();
    for (const [k, rot] of Object.entries(pm)) {
      const q = rot.length === 4 ? rot.slice() : eulerToQuat(Number(rot[0]) || 0, Number(rot[1]) || 0, Number(rot[2]) || 0);
      const base = out[k] || [0, 0, 0, 1];
      if (mode === 'replace') out[k] = quatSlerp(base, q, influence);
      else out[k] = quatMul(base, quatSlerp([0, 0, 0, 1], q, influence));
    }
  }
  return out;
}

export function boneMatricesWithPose(asset, time, poseMap, dirs, baseEuler, rootY, opts) {
  const local = applyBonePoseToLocal(asset, time, poseMap, dirs, baseEuler, rootY, opts);
  if (!local) return null;
  // ② 自顶向下世界矩阵
  const n = local.length;
  const worldM = new Array(n);
  const resolveNode = (i2, guard) => {
    if (worldM[i2]) return worldM[i2];
    if (guard > 128) return directorMat4Identity();
    const Lp = local[i2];
    const m = trsToMat4(Lp.t, Lp.r, Lp.s);
    const p = asset.parentOfAll ? asset.parentOfAll[i2] : -1;
    worldM[i2] = (p >= 0 && p !== i2) ? directorMat4Multiply(resolveNode(p, guard + 1), m) : m;
    return worldM[i2];
  };
  for (let i2 = 0; i2 < n; i2++) resolveNode(i2, 0);
  // ③ 蒙皮矩阵 = jointWorld · inverseBind
  const out = new Float32Array(asset.bones.length * 16);
  asset.bones.forEach((b, bi) => {
    const ni = b.nodeIdx;
    const jw = (ni !== undefined && ni >= 0 && worldM[ni]) ? worldM[ni] : directorMat4Identity();
    const ib = b.ibm;
    const o = bi * 16;
    if (ib) {
      for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 4; r2++) {
        out[o + c * 4 + r2] = jw[r2] * ib[c * 4] + jw[4 + r2] * ib[c * 4 + 1] + jw[8 + r2] * ib[c * 4 + 2] + jw[12 + r2] * ib[c * 4 + 3];
      }
    } else {
      out.set(jw, o);
    }
  });
  return { mats: out };
}

/**
 * 姿态关键帧动画：poseAnim = [{ t, poseId }] → 返回该时刻的姿态混合列表。
 * 每项 { base, dirs, w }：w 为权重（相邻两帧线性权重，其余为 0）。
 */
export function poseBlendAt(posedefs, poseAnim, time) {
  if (!Array.isArray(poseAnim) || !poseAnim.length) return null;
  const ks = poseAnim.filter((k) => k && k.poseId).slice().sort((a, b) => a.t - b.t);
  if (!ks.length) return null;
  const find = (id) => posedefs.find((p) => p.id === id) || null;
  const t = Number(time) || 0;
  if (ks.length === 1 || t <= ks[0].t) {
    const sp = find(ks[0].poseId);
    return sp ? [{ base: sp.base || null, dirs: sp.dirs || [], rootY: Number(sp.rootY) || 0, w: 1 }] : null;
  }
  if (t >= ks[ks.length - 1].t) {
    const sp = find(ks[ks.length - 1].poseId);
    return sp ? [{ base: sp.base || null, dirs: sp.dirs || [], rootY: Number(sp.rootY) || 0, w: 1 }] : null;
  }
  let a = ks[0], b = ks[ks.length - 1];
  for (let i = 0; i < ks.length - 1; i++) if (t >= ks[i].t && t <= ks[i + 1].t) { a = ks[i]; b = ks[i + 1]; break; }
  const span = b.t - a.t;
  const k = span > 1e-6 ? (t - a.t) / span : 0;
  // 缓动：默认 smoothstep（起止更自然）；可按帧用 ease 覆盖
  const e = easeFactor(b.ease || a.ease || 'auto', k);
  const sa = find(a.poseId), sb = find(b.poseId);
  const out = [];
  if (sa && e < 0.999) out.push({ base: sa.base || null, dirs: sa.dirs || [], rootY: Number(sa.rootY) || 0, w: 1 - e });
  if (sb && e > 0.001) out.push({ base: sb.base || null, dirs: sb.dirs || [], rootY: Number(sb.rootY) || 0, w: e });
  return out.length ? out : null;
}

/** 四元数球面插值（a→b，t∈[0,1]，最短弧） */
export function quatSlerp(a, b, t) {
  let ax = a[0], ay = a[1], az = a[2], aw = a[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
  if (d > 0.9995) {
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, w = aw + (bw - aw) * t;
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  }
  const th0 = Math.acos(Math.max(-1, Math.min(1, d)));
  const th = th0 * t;
  const s0 = Math.sin(th0 - th) / Math.sin(th0);
  const s1 = Math.sin(th) / Math.sin(th0);
  return [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1];
}

/**
 * 姿态混合蒙皮矩阵：list = [{ base, dirs, w }]。
 * 做法：对每个姿态在「动画后的局部变换」上求解，得到逐节点旋转，再按权重 slerp 混合，
 * 最后统一算世界矩阵与蒙皮矩阵 —— 这样两段姿态之间是平滑过渡，而不是跳变。
 */
export function boneMatricesWithPoseMix(asset, time, list) {
  if (!asset || !asset.bones || !asset.nodes || !list || !list.length) return null;
  const anim = asset._anim;
  const t = animLoopTime(asset, time);
  const baseLocal = asset.nodes.map((n) => ({ t: n.t.slice(), r: n.r.slice(), s: n.s.slice() }));
  if (anim) {
    for (const tr of anim.tracks) {
      const v = sampleTrack(tr, t);
      if (!v || !baseLocal[tr.node]) continue;
      if (tr.path === 'rotation') baseLocal[tr.node].r = v;
      else baseLocal[tr.node].t = v;
    }
  }
  const applySpec = (entry) => {
    const local = baseLocal.map((n) => ({ t: n.t.slice(), r: n.r.slice(), s: n.s.slice() }));
    if (entry.base) {
      for (const [kw, rot] of Object.entries(entry.base)) {
        const bi2 = (asset.bones || []).findIndex((x) => String(x.name || '').replace(/^mixamorig:?/i, "") === kw);
        if (bi2 < 0) continue;
        const ni2 = asset.bones[bi2].nodeIdx;
        if (ni2 === undefined || !local[ni2]) continue;
        local[ni2].r = quatMul(local[ni2].r, eulerToQuat(Number(rot[0]) || 0, Number(rot[1]) || 0, Number(rot[2]) || 0));
      }
    }
    if (entry.dirs && entry.dirs.length) solveDirsIntoLocal(asset, local, entry.dirs);
    return local;
  };
  const perPose = list.map((e) => ({ w: e.w === undefined ? 1 : e.w, local: applySpec(e) })).filter((e) => e.w > 0.0001);
  // 加权根位移（下蹲/轻功）
  {
    let ry = 0, wsum = 0;
    for (const e of list) { ry += (Number(e.rootY) || 0) * (e.w === undefined ? 1 : e.w); wsum += (e.w === undefined ? 1 : e.w); }
    if (wsum > 0) ry /= wsum;
    if (Math.abs(ry) > 1e-6) {
      const hi2 = (asset.bones || []).findIndex((x) => String(x.name || "").replace(/^mixamorig:?/i, "") === "Hips");
      if (hi2 >= 0) {
        const ni4 = asset.bones[hi2].nodeIdx;
        if (ni4 !== undefined) for (const pp of perPose) { if (pp.local[ni4] && pp.local[ni4].t) pp.local[ni4].t[1] += ry; }
      }
    }
  }
  if (!perPose.length) return null;
  const nN = asset.nodes.length;
  const mixed = new Array(nN);
  for (let i = 0; i < nN; i++) {
    let acc = perPose[0].local[i].r.slice();
    let accW = perPose[0].w;
    for (let k = 1; k < perPose.length; k++) {
      const w = perPose[k].w;
      const ratio = w / Math.max(1e-6, accW + w);
      acc = quatSlerp(acc, perPose[k].local[i].r, ratio);
      accW += w;
    }
    mixed[i] = { t: perPose[0].local[i].t, r: acc, s: perPose[0].local[i].s };
  }
  // 世界矩阵
  const worldM = new Array(nN);
  const parentOf = (i) => (asset.parentOfAll ? asset.parentOfAll[i] : -1);
  const resolve = (i, guard) => {
    if (worldM[i]) return worldM[i];
    if (guard > 200) return directorMat4Identity();
    const m = trsToMat4(mixed[i].t, mixed[i].r, mixed[i].s);
    const p = parentOf(i);
    worldM[i] = (p >= 0 && p !== i) ? directorMat4Multiply(resolve(p, guard + 1), m) : m;
    return worldM[i];
  };
  for (let i = 0; i < nN; i++) resolve(i, 0);
  const out = new Float32Array(asset.bones.length * 16);
  asset.bones.forEach((b, bi) => {
    const jw = worldM[b.nodeIdx] || directorMat4Identity();
    const ib = b.ibm;
    const o = bi * 16;
    if (ib) {
      for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 4; r2++) {
        out[o + c * 4 + r2] = jw[r2] * ib[c * 4] + jw[4 + r2] * ib[c * 4 + 1] + jw[8 + r2] * ib[c * 4 + 2] + jw[12 + r2] * ib[c * 4 + 3];
      }
    } else out.set(jw, o);
  });
  return { mats: out };
}

/* ============================================================
 * 双四元数蒙皮（DQS）：解决线性混合蒙皮（LBS）在大角度关节处的塌陷/糖纸
 * 算法对照 Blender 源码（只借鉴算法，不复制 GPL 代码；本插件 Apache-2.0）：
 *   armature_update.cc#mat4_to_dquat / armature_deform.cc 的 deform_dual_quat 混合
 * ============================================================ */
function quatConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
function quatRotateVec(q, v) {
  const t = quatMul(quatMul(q, [v[0], v[1], v[2], 0]), quatConj(q));
  return [t[0], t[1], t[2]];
}
/** 列主序 3x3（取自 mat4 的旋转列）→ 单位四元数 [x,y,z,w]。 */
export function mat4RotationQuat(m) {
  const m00 = m[0], m01 = m[4], m02 = m[8];
  const m10 = m[1], m11 = m[5], m12 = m[9];
  const m20 = m[2], m21 = m[6], m22 = m[10];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const q = Math.sqrt(tr + 1) * 2;
    w = 0.25 * q; x = (m21 - m12) / q; y = (m02 - m20) / q; z = (m10 - m01) / q;
  } else if (m00 > m11 && m00 > m22) {
    const q = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / q; x = 0.25 * q; y = (m01 + m10) / q; z = (m02 + m20) / q;
  } else if (m11 > m22) {
    const q = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / q; x = (m01 + m10) / q; y = 0.25 * q; z = (m12 + m21) / q;
  } else {
    const q = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / q; x = (m02 + m20) / q; y = (m12 + m21) / q; z = 0.25 * q;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}
/** mat4 → 单位双四元数 { r:[x,y,z,w], d:[x,y,z,w] }，d = 0.5·t·r。 */
export function mat4ToDualQuat(m) {
  const r = mat4RotationQuat(m);
  const t = [Number(m[12]) || 0, Number(m[13]) || 0, Number(m[14]) || 0, 0];
  const d = quatMul(t, r).map((v) => 0.5 * v);
  return { r, d };
}
/** 双四元数作用到点：p' = R·p·R* + 2·(D·R*).xyz。 */
export function dqTransformPoint(R, D, p) {
  const rot = quatRotateVec(R, [p[0], p[1], p[2]]);
  const dr = quatMul(D, quatConj(R));
  return [rot[0] + 2 * dr[0], rot[1] + 2 * dr[1], rot[2] + 2 * dr[2]];
}
/** 单点蒙皮（测试/工具用）：mode='lbs'|'dqs'。 */
export function skinPointWithMats(mats, joints, weights, p, nb, mode) {
  const dqs = String(mode || 'lbs').toLowerCase() === 'dqs';
  if (!dqs) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = Number(weights[k]) || 0, j = Number(joints[k]);
      if (!w || !(j >= 0) || j >= nb) continue;
      const o = j * 16;
      x += w * (mats[o] * p[0] + mats[o + 4] * p[1] + mats[o + 8] * p[2] + mats[o + 12]);
      y += w * (mats[o + 1] * p[0] + mats[o + 5] * p[1] + mats[o + 9] * p[2] + mats[o + 13]);
      z += w * (mats[o + 2] * p[0] + mats[o + 6] * p[1] + mats[o + 10] * p[2] + mats[o + 14]);
    }
    return [x, y, z];
  }
  let R = [0, 0, 0, 0], D = [0, 0, 0, 0], ref = null, used = 0;
  for (let k = 0; k < 4; k++) {
    const w = Number(weights[k]) || 0, j = Number(joints[k]);
    if (!w || !(j >= 0) || j >= nb) continue;
    const dq = mat4ToDualQuat(mats.subarray ? mats.subarray(j * 16, j * 16 + 16) : mats.slice(j * 16, j * 16 + 16));
    let r = dq.r, d = dq.d;
    if (!ref) ref = r;
    else if (r[0] * ref[0] + r[1] * ref[1] + r[2] * ref[2] + r[3] * ref[3] < 0) {
      r = r.map((v) => -v); d = d.map((v) => -v);
    }
    for (let q = 0; q < 4; q++) { R[q] += w * r[q]; D[q] += w * d[q]; }
    used++;
  }
  if (!used) return [p[0], p[1], p[2]];
  const rl = Math.hypot(R[0], R[1], R[2], R[3]) || 1;
  R = R.map((v) => v / rl); D = D.map((v) => v / rl);
  return dqTransformPoint(R, D, p);
}

export function skinModel(asset, clipName, time, outPos, outNrm, shape) {
  const clip = clipName ? asset.clipByName(clipName) : null;
  asset._anim = clip;
  const poseMap = (shape && shape.bonePose && Object.keys(shape.bonePose).length) ? shape.bonePose : null;
  const poseId = shape && shape.poseId ? shape.poseId : null;
  const spec = poseId ? (BONE_POSES.find((p) => p.id === poseId) || null) : null;
  const poseDirs = spec ? (spec.dirs || []) : (shape && shape.poseDirs) || null;
  const poseBase = spec ? (spec.base || null) : null;
  const poseRootY = spec ? (Number(spec.rootY) || 0) : (Number(shape && shape.rootY) || 0);
  const poseBlend = shape && shape.poseBlend && shape.poseBlend.length ? shape.poseBlend : null;
  const wantPose = !!(poseMap || (poseDirs && poseDirs.length) || poseBase || poseBlend || (shape && (shape.ik || shape.constraints || shape.clips)));
  const bm = asset.bones && asset.bones.length
    ? (poseBlend ? boneMatricesWithPoseMix(asset, time || 0, poseBlend)
       : (wantPose ? boneMatricesWithPose(asset, time || 0, poseMap, poseDirs, poseBase, poseRootY, shape && (shape.ik || shape.constraints || shape.clips) ? { ik: shape.ik, constraints: shape.constraints, clips: shape.clips } : null)
          : boneMatrices(asset, time || 0)))
    : null;
  const P = asset.positions, N = asset.normals, J = asset.joints, W = asset.weights, nb = asset.bones ? asset.bones.length : 0;
  const pos = outPos && outPos.length === P.length ? outPos : new Float32Array(P.length);
  const nrm = outNrm && outNrm.length === P.length ? outNrm : new Float32Array(P.length);
  const nv = P.length / 3;
  const modeRaw = String((shape && shape.skinning) || 'lbs').toLowerCase();
  const useDQS = modeRaw === 'dqs' || modeRaw === 'auto';
  // 每帧一次：把骨骼蒙皮矩阵转成双四元数（不是每顶点）
  let dqsBones = null;
  if (useDQS && bm && bm.mats && nb > 0) {
    dqsBones = new Array(nb);
    for (let j = 0; j < nb; j++) dqsBones[j] = mat4ToDualQuat(bm.mats.subarray(j * 16, j * 16 + 16));
  }
  for (let v = 0; v < nv; v++) {
    let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0;
    if (!bm || !J || !W) {
      pos[v * 3] = P[v * 3]; pos[v * 3 + 1] = P[v * 3 + 1]; pos[v * 3 + 2] = P[v * 3 + 2];
      nrm[v * 3] = N[v * 3]; nrm[v * 3 + 1] = N[v * 3 + 1]; nrm[v * 3 + 2] = N[v * 3 + 2];
      continue;
    }
    if (dqsBones) {
      // 双四元数线性混合（DLB）：半球对齐后加权求和，再归一化
      let R = [0, 0, 0, 0], D = [0, 0, 0, 0], ref = null, used = 0;
      for (let k = 0; k < 4; k++) {
        const w = W[v * 4 + k];
        const j = J[v * 4 + k];
        if (!w || j >= nb) continue;
        const dq = dqsBones[j];
        let rr = dq.r, dd = dq.d;
        if (!ref) ref = rr;
        else if (rr[0] * ref[0] + rr[1] * ref[1] + rr[2] * ref[2] + rr[3] * ref[3] < 0) {
          rr = [-rr[0], -rr[1], -rr[2], -rr[3]];
          dd = [-dd[0], -dd[1], -dd[2], -dd[3]];
        }
        R[0] += w * rr[0]; R[1] += w * rr[1]; R[2] += w * rr[2]; R[3] += w * rr[3];
        D[0] += w * dd[0]; D[1] += w * dd[1]; D[2] += w * dd[2]; D[3] += w * dd[3];
        used++;
      }
      if (!used) {
        pos[v * 3] = P[v * 3]; pos[v * 3 + 1] = P[v * 3 + 1]; pos[v * 3 + 2] = P[v * 3 + 2];
        nrm[v * 3] = N[v * 3]; nrm[v * 3 + 1] = N[v * 3 + 1]; nrm[v * 3 + 2] = N[v * 3 + 2];
        continue;
      }
      const rl = Math.hypot(R[0], R[1], R[2], R[3]) || 1;
      R = [R[0] / rl, R[1] / rl, R[2] / rl, R[3] / rl];
      D = [D[0] / rl, D[1] / rl, D[2] / rl, D[3] / rl];
      // 与 skinPointWithMats 完全同源：p' = R·p·R* + 2·(D·R*).xyz
      const p2 = quatRotateVec(R, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      const dr = quatMul(D, quatConj(R));
      pos[v * 3] = p2[0] + 2 * dr[0];
      pos[v * 3 + 1] = p2[1] + 2 * dr[1];
      pos[v * 3 + 2] = p2[2] + 2 * dr[2];
      const n2 = quatRotateVec(R, [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]]);
      const nl = Math.hypot(n2[0], n2[1], n2[2]) || 1;
      nrm[v * 3] = n2[0] / nl; nrm[v * 3 + 1] = n2[1] / nl; nrm[v * 3 + 2] = n2[2] / nl;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const w = W[v * 4 + k];
      const j = J[v * 4 + k];
      if (!w || j >= nb) continue;
      const m = bm.mats.subarray(j * 16, j * 16 + 16);
      const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
      x += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
      y += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
      z += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
      const qx = N[v * 3], qy = N[v * 3 + 1], qz = N[v * 3 + 2];
      nx += w * (m[0] * qx + m[4] * qy + m[8] * qz);
      ny += w * (m[1] * qx + m[5] * qy + m[9] * qz);
      nz += w * (m[2] * qx + m[6] * qy + m[10] * qz);
    }
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm[v * 3] = nx / l; nrm[v * 3 + 1] = ny / l; nrm[v * 3 + 2] = nz / l;
  }
  if (shape) applyBodyShape(asset, pos, shape);
  return { pos, nrm };
}

/**
 * 播放头 → 场景副本：模型对象的动作时间跟随播放头，带关键帧的相机做位置/注视点插值。
 * 预演与导出视频都走这一个函数，保证"看到的"和"导出的"一致。
 */
/* ============================================================
 * 运动路径（对照 Blender BKE_where_on_path + Follow Path 约束）
 *   关键帧串成 Catmull-Rom 样条 → 按时间参数在曲线上取「位置 + 切线」
 *   Blender 语义：
 *     curvetime = (ctime - offset) / pathlen，clamp 到 [0,1]
 *     pos/quat 由曲线求值给出；FOLLOW 时朝向 = 切线方向
 * ============================================================ */

/** Catmull-Rom 基样条插值（4 个控制点 → 中间段光滑曲线）。 */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * 关键帧数组（按 t 升序）→ 指定时间的样条位置。
 * 对标 BKE_where_on_path：时间先归一化到 [0,1]（首尾关键帧为路径端点）。
 * @param {{t:number,pos:{x,y,z}}} keys
 * @param {number} time
 */
export function samplePath(keys, time) {
  // 守卫：旧数据/脏数据的 key 可能缺 pos —— 补 {0,0,0} 而不是崩（reading 'x' 历史事故）
  const SAFE_P = { x: 0, y: 0, z: 0 };
  const ks = (keys || []).filter((k) => k && k.pos).map((k) => ({ t: Number(k.t) || 0, pos: k.pos })).sort((a, b) => a.t - b.t);
  if (!ks.length) return null;
  if (ks.length === 1) return { pos: v3(ks[0].pos.x, ks[0].pos.y, ks[0].pos.z), tangent: v3(0, 0, 1) };
  const t0 = ks[0].t, t1 = ks[ks.length - 1].t;
  const u = t1 > t0 ? Math.max(0, Math.min(1, (time - t0) / (t1 - t0))) : 0;
  const seg = Math.min(ks.length - 2, Math.floor(u * (ks.length - 1)));
  const frac = u * (ks.length - 1) - seg;
  const P = (i) => ks[Math.max(0, Math.min(ks.length - 1, i))];
  const a = P(seg - 1), b = P(seg), c = P(seg + 1), d = P(seg + 2);
  const pos = v3(
    catmullRom(a.pos.x, b.pos.x, c.pos.x, d.pos.x, frac),
    catmullRom(a.pos.y, b.pos.y, c.pos.y, d.pos.y, frac),
    catmullRom(a.pos.z, b.pos.z, c.pos.z, d.pos.z, frac),
  );
  // 切线 = 数值微分（与 Blender 求曲线导数同义）
  const eps = 1e-3;
  const ahead = samplePos(ks, Math.min(1, u + eps));
  const behind = samplePos(ks, Math.max(0, u - eps));
  const tangent = vNorm(vSub(ahead, behind));
  return { pos, tangent, u };
}

/** 只取位置（避免切线计算递归）。 */
function samplePos(ks, u) {
  const seg = Math.min(ks.length - 2, Math.floor(u * (ks.length - 1)));
  const frac = u * (ks.length - 1) - seg;
  const P = (i) => ks[Math.max(0, Math.min(ks.length - 1, i))];
  const a = P(seg - 1), b = P(seg), c = P(seg + 1), d = P(seg + 2);
  return v3(
    catmullRom(a.pos.x, b.pos.x, c.pos.x, d.pos.x, frac),
    catmullRom(a.pos.y, b.pos.y, c.pos.y, d.pos.y, frac),
    catmullRom(a.pos.z, b.pos.z, c.pos.z, d.pos.z, frac),
  );
}

/**
 * 运动路径：机位关键帧 + pathMode='curve' 时，用样条取 pos，
 * target = pos + tangent × lookAhead（相机朝向运动方向，即 Follow Path 的 FOLLOW）。
 */
export function cameraPathAt(cam, time, lookAhead) {
  if (!cam || !Array.isArray(cam.keys) || cam.keys.length < 2) return null;
  const ks = cam.keys.slice().sort((a, b) => a.t - b.t);
  const s = samplePath(ks, time);
  if (!s) return null;
  if (cam.pathMode !== 'curve') return null;   // 折线模式仍走原 applyPlayhead
  const aheadDist = Math.max(0.05, Number(lookAhead) || 1.2);
  const target = vAdd(s.pos, vMul(s.tangent, aheadDist));
  return { pos: s.pos, target };
}

/* ============================================================
 * 分镜串联（对照 Blender Sequencer Strip）
 *   shot = { cameraId, start, end, label }   —— 一个镜头 = 一台相机 + 时间区间
 *   播放/导出时按当前时间自动切换到对应镜头的相机。
 * ============================================================ */

/** 当前时间该用哪台相机（无分镜时退回 activeCameraId）。 */
export function activeCameraAt(scene, time) {
  const ss = (scene && Array.isArray(scene.shots)) ? scene.shots : [];
  if (!ss.length) return (scene && scene.activeCameraId) || '';
  const t = Math.max(0, Number(time) || 0);
  // 按开始时间排序，找包含 t 的；找不到（间隙）取最近的前一个
  const sorted = ss.slice().sort((a, b) => (a.start || 0) - (b.start || 0));
  let hit = null;
  for (const sh of sorted) {
    if (t >= (sh.start || 0) && t < (sh.end || 0)) { hit = sh; break; }
  }
  if (!hit) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (t >= (sorted[i].start || 0)) { hit = sorted[i]; break; }
    }
  }
  return hit ? hit.cameraId : (scene && scene.activeCameraId) || '';
}

/** 分镜总时长（最后一个 end；无分镜时用 shot.duration）。 */
export function sequenceDuration(scene) {
  const ss = (scene && Array.isArray(scene.shots)) ? scene.shots : [];
  if (!ss.length) return Math.max(1, Number(scene && scene.shot && scene.shot.duration) || 6);
  return Math.max(1, ...ss.map((sh) => Number(sh.end) || 0));
}

/** 添加一个分镜（在 playhead 处开始，默认时长 2 秒）。 */
export function addShot(scene, cameraId, start, duration) {
  if (!scene) return false;
  if (!Array.isArray(scene.shots)) scene.shots = [];
  const dur = Math.max(0.5, Number(duration) || 2);
  const st = Math.max(0, Number(start) || 0);
  const label = '镜头 ' + (scene.shots.length + 1);
  scene.shots.push({ cameraId: String(cameraId || ''), start: st, end: st + dur, label });
  scene.shots.sort((a, b) => a.start - b.start);
  return true;
}

/** 删除分镜（按索引）。 */
export function removeShot(scene, index) {
  if (!scene || !Array.isArray(scene.shots)) return false;
  if (index < 0 || index >= scene.shots.length) return false;
  scene.shots.splice(index, 1);
  return true;
}

/* ============================================================
 * 姿态关键帧（poseKeys）：姿态随时间线性过渡
 *   poseKeys = [{ t, bonePose: { boneIndex: [rx,ry,rz] } }]
 *   播放到某时刻 → 取相邻两帧的 bonePose 逐骨线性插值
 * ============================================================ */

/** 姿态关键帧插值：返回该时刻的 bonePose（无关键帧返回 null）。 */
/* ============================================================
 * 动画曲线核心（四元数 / 缓动表 / 三次贝塞尔 / 通道求值）
 * 算法对照 Blender 源码（只借鉴算法，不复制 GPL 代码；本插件 Apache-2.0）：
 *   - blenkernel/intern/fcurve.cc#fcurve_eval_keyframes_interpolate（BEZT_IPO_BEZ 三次贝塞尔）
 *   - animrig/intern/fcurve.cc 的 auto handle 语义（HD_AUTO / HD_AUTO_ANIM）
 *   - blenlib 的四元数插值语义（最短弧、归一化）
 * ============================================================ */
export function quatNormalize(q) {
  const l = Math.hypot(Number(q[0]) || 0, Number(q[1]) || 0, Number(q[2]) || 0, Number(q[3]) || 0) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** 缓动表（in 方向；out/inout 由 easeFactor 组合）。 */
const EASE_IN_FN = {
  sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  quart: (t) => t * t * t * t,
  quint: (t) => t * t * t * t * t,
  expo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  circ: (t) => 1 - Math.sqrt(Math.max(0, 1 - t * t)),
  back: (t) => { const c = 1.70158; return t * t * ((c + 1) * t - c); },
  elastic: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3));
  },
  bounce: (t) => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) { const u = t - 1.5 / 2.75; return 7.5625 * u * u + 0.75; }
    if (t < 2.5 / 2.75) { const u = t - 2.25 / 2.75; return 7.5625 * u * u + 0.9375; }
    const u = t - 2.625 / 2.75;
    return 7.5625 * u * u + 0.984375;
  },
};
/** 缓动：'auto'（smoothstep）/ 'linear' / 'constant' / '<曲线>_in|_out|_in_out'。 */
export function easeFactor(kind, x) {
  const k = Math.max(0, Math.min(1, Number(x) || 0));
  const id = String(kind == null ? 'auto' : kind).toLowerCase().replace(/[\s-]+/g, '_');
  if (id === 'constant') return 0;
  if (id === 'linear') return k;
  if (id === 'auto' || id === 'smooth' || id === 'smoothstep' || id === 'bezier') return k * k * (3 - 2 * k);
  const m = /^(sine|quad|cubic|quart|quint|expo|circ|back|elastic|bounce)(?:_?(in_out|in|out))?$/.exec(id);
  if (m) {
    const fn = EASE_IN_FN[m[1]];
    const dir = m[2] || 'in_out';
    if (dir === 'in') return fn(k);
    if (dir === 'out') return 1 - fn(1 - k);
    return k < 0.5 ? fn(2 * k) / 2 : 1 - fn(2 - 2 * k) / 2;
  }
  return k * k * (3 - 2 * k);
}
/** 一维三次贝塞尔。 */
function bez1(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
/** 由 x 反解贝塞尔参数 t（x 单调；手柄已限幅）。二分法稳定且精度足够。 */
function bezierSolveT(x0, x1, x2, x3, x) {
  if (x <= x0) return 0;
  if (x >= x3) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (bez1(x0, x1, x2, x3, mid) < x) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
/** 自动切线（auto-clamped 语义）：极值点取水平切线，其余用中心差分并限幅。 */
function autoHandle(keys, i, val) {
  const k = keys[i];
  const prev = keys[i - 1], next = keys[i + 1];
  const dtNext = next ? Math.max(1e-6, next.t - k.t) : 1e-6;
  if (!prev || !next) return { dx: 0, dy: 0 };   // 端点：水平切线（Blender 端点同义）
  const v0 = val(prev), v1 = val(k), v2 = val(next);
  const isExtremum = (v1 >= v0 && v1 >= v2) || (v1 <= v0 && v1 <= v2);
  const slope = isExtremum ? 0 : (v2 - v0) / Math.max(1e-6, next.t - prev.t);
  const dx = Math.min(dtNext / 3, (k.t - prev.t) / 3);
  return { dx, dy: slope * dx };
}
/**
 * 通道求值：keys = [{ t, interp?, ease?, hIn?{dx,dy}, hOut?{dx,dy} }]
 *   interp: 'auto'(默认，smoothstep/legacy) | 'linear' | 'constant' | 'bezier'
 *   bezier 时用显式手柄（dx=时间偏移, dy=值偏移），缺省走自动切线。
 */
export function evalKeyChannel(keys, valueOf, time) {
  const ks = (keys || []).filter((k) => k && k.t !== undefined).slice().sort((a, b) => a.t - b.t);
  if (!ks.length) return null;
  const val = (k) => { const v = Number(valueOf(k)); return Number.isFinite(v) ? v : 0; };
  const t = Math.max(0, Number(time) || 0);
  if (t <= ks[0].t) return val(ks[0]);
  if (t >= ks[ks.length - 1].t) return val(ks[ks.length - 1]);
  let i = 0;
  while (i < ks.length - 1 && ks[i + 1].t <= t) i++;
  const a = ks[i], b = ks[i + 1];
  const span = b.t - a.t;
  const k = span > 1e-6 ? (t - a.t) / span : 0;
  const va = val(a), vb = val(b);
  const interp = String((b.interp || a.interp || 'auto')).toLowerCase();
  if (interp === 'constant') return va;
  if (interp === 'bezier') {
    const ho = a.hOut && Number.isFinite(Number(a.hOut.dx)) ? { dx: Number(a.hOut.dx), dy: Number(a.hOut.dy) || 0 } : (() => { const h = autoHandle(ks, i, val); return { dx: h.dx, dy: h.dy }; })();
    const hi = b.hIn && Number.isFinite(Number(b.hIn.dx)) ? { dx: Number(b.hIn.dx), dy: Number(b.hIn.dy) || 0 } : (() => { const h = autoHandle(ks, i + 1, val); return { dx: -h.dx, dy: -h.dy }; })();
    let x1 = a.t + ho.dx, x2 = b.t + hi.dx;
    // 手柄 x 限幅（对应 Blender BKE_fcurve_correct_bezpart：防止时间轴回环）
    x1 = Math.min(Math.max(x1, a.t + 1e-6), b.t - 1e-6);
    x2 = Math.min(Math.max(x2, a.t + 1e-6), b.t - 1e-6);
    if (x2 < x1) { const mid = (x1 + x2) / 2; x1 = mid; x2 = mid; }
    const u = bezierSolveT(a.t, x1, x2, b.t, t);
    return bez1(va, va + ho.dy, vb + hi.dy, vb, u);
  }
  const e = interp === 'linear' ? k : easeFactor(b.ease || a.ease || 'auto', k);
  return va + (vb - va) * e;
}

export function interpolatePoseKeys(poseKeys, time) {
  if (!Array.isArray(poseKeys) || !poseKeys.length) return null;
  const ks = poseKeys.filter((k) => k && k.t !== undefined).sort((a, b) => a.t - b.t);
  if (!ks.length) return null;
  if (ks.length === 1) return ks[0].bonePose || null;
  const t = Math.max(0, Number(time) || 0);
  if (t <= ks[0].t) return ks[0].bonePose || null;
  if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].bonePose || null;
  let a = ks[0], b = ks[ks.length - 1];
  for (let i = 0; i < ks.length - 1; i++) {
    if (t >= ks[i].t && t <= ks[i + 1].t) { a = ks[i]; b = ks[i + 1]; break; }
  }
  const span = b.t - a.t;
  const rawK = span > 1e-6 ? (t - a.t) / span : 0;
  // 默认线性（向后兼容既有 poseKeys 语义）；需要缓动时在关键帧上显式写 ease:'auto' 等
  const k = easeFactor(b.ease || a.ease || 'linear', rawK);
  const pa = a.bonePose || {}, pb = b.bonePose || {};
  const idxSet = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  const out = {};
  for (const key of idxSet) {
    const ra = pa[key] || [0, 0, 0];
    const rb = pb[key] || [0, 0, 0];
    if (ra.length === 4 || rb.length === 4) {
      // 四元数通道：最短弧 slerp（Blender bone rotation 语义）；3 分量按欧拉转四元数兜底
      const qa = ra.length === 4 ? ra : eulerToQuat(Number(ra[0]) || 0, Number(ra[1]) || 0, Number(ra[2]) || 0);
      const qb = rb.length === 4 ? rb : eulerToQuat(Number(rb[0]) || 0, Number(rb[1]) || 0, Number(rb[2]) || 0);
      out[key] = quatSlerp(qa, qb, k);
    } else {
      out[key] = [
        (Number(ra[0]) || 0) + ((Number(rb[0]) || 0) - (Number(ra[0]) || 0)) * k,
        (Number(ra[1]) || 0) + ((Number(rb[1]) || 0) - (Number(ra[1]) || 0)) * k,
        (Number(ra[2]) || 0) + ((Number(rb[2]) || 0) - (Number(ra[2]) || 0)) * k,
      ];
    }
  }
  return out;
}

/* ============================================================
 * 物体路径运动（画出线，物体沿线走）
 *   ob.path = [{x,y,z}, ...]  路径点（世界坐标）
 *   ob.pathMode = 'curve' | 'linear'
 *   时间 → 路径参数 u = t / duration（与 Blender Follow Path 的 curvetime 同义）
 * ============================================================ */

/** 路径总弧长（米）。 */
export function pathArcLength(ob) {
  if (!ob || !Array.isArray(ob.path) || ob.path.length < 2) return 0;
  let len = 0, prev = null;
  for (let i = 0; i <= 64; i++) {
    const p = objectPathPos(ob, (i / 64) * 1000, 1000);
    if (!p) continue;
    if (prev) len += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    prev = p;
  }
  return len;
}

/**
 * 运动驱动（avoid foot-sliding）：按路径速度换算「播放进度」。
 *   ob.locomotion = { source: 'clip' | 'action' | 'none', clip, actionId, stride, cycle, refSpeed }
 *   stride 步幅(m)：一步走多远；cycle 一个循环周期(s)；refSpeed 参考速度(m/s)。
 * 返回 { animTime, poseTime, speed, cadenceHz, dist }（无路径或未配置时 animTime/poseTime 为 null）。
 */
export function locomotionAt(ob, time, duration) {
  const p = objectPathPos(ob, time, duration);
  if (!p) return null;
  const dur = Math.max(0.1, Number(duration) || 6);
  const u = Math.max(0, Math.min(1, (Number(time) || 0) / dur));
  const total = pathArcLength(ob);
  const dist = total * u;
  const speed = total / dur;                    // m/s（匀速采样：Blender 默认按曲线时间线性）
  const loco = ob.locomotion || null;
  const stride = Math.max(0.05, Number(loco && loco.stride) || 0.75);
  const cycle = Math.max(0.05, Number(loco && loco.cycle) || 1.0);
  const refSpeed = Math.max(0.05, Number(loco && loco.refSpeed) || 1.4);
  // 步数 = 走过的距离 / 步幅；每个循环包含 2 步（左右脚各一步）
  const cycles = dist / (stride * 2);
  const phaseTime = cycles * cycle;
  // 参考速度下的自然节奏：速度越快，周期按比例缩短（避免快走却慢摆）
  const rate = speed > 0.001 ? Math.max(0.35, Math.min(3.5, speed / refSpeed)) : 1;
  return {
    dist, speed, rate,
    // 参考速度下按 cycle 播放；实际速度更快 → 播放更快（rate>1），更慢 → 更慢
    animTime: phaseTime * rate,
    poseTime: phaseTime * rate,
    cadenceHz: stride > 0 ? (speed / stride) : 0,   // 每秒步数（步频）
  };
}

/** 时间 → 路径上的位置。无路径返回 null。 */
export function objectPathPos(ob, time, duration) {
  if (!ob || !Array.isArray(ob.path) || ob.path.length < 2) return null;
  const mode = ob.pathMode || 'curve';
  const dur = Math.max(0.1, Number(duration) || Number(ob.pathDuration) || 6);
  const u = Math.max(0, Math.min(1, (Number(time) || 0) / dur));
  if (mode === 'linear') {
    // 折线：按段等分
    const n = ob.path.length - 1;
    const f = u * n, seg = Math.min(n - 1, Math.floor(f)), k = f - seg;
    const a = ob.path[seg], b = ob.path[seg + 1];
    return v3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
  }
  // 曲线：Catmull-Rom（复用相机路径同一套数学）
  const keys = ob.path.map((p, i) => ({ t: i / (ob.path.length - 1), pos: p }));
  const sp = samplePath(keys, u);
  return sp ? sp.pos : null;
}


// ============================================================
// 场景规格（Stage Spec）：一段 JSON 描述整场预演，供 AI / 脚本直接生成
//   —— 让「手动搭场景」变成「写规格」，Harness 全程可操控出预演视频。
// ============================================================
const SPEC_PRESET_IDS = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'capsule', 'torus', 'pyramid', 'disc', 'arc', 'half_cylinder', 'ancient_house', 'ancient_stall', 'stone_step'];

/**
 * 规格 → 场景。数组坐标一律简写 [x,y,z] 或 [x,z]（两维视为地面 x/z，y=0）。
 */
export function buildStageFromSpec(spec) {
  const sp = spec && typeof spec === 'object' ? spec : {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const v3of = (a, y0) => {
    if (!a) return v3(0, y0 || 0, 0);
    if (Array.isArray(a)) {
      if (a.length >= 3) return v3(num(a[0], 0), num(a[1], 0), num(a[2], 0));
      return v3(num(a[0], 0), y0 || 0, num(a[1], 0));
    }
    return v3(num(a.x, 0), num(a.y, y0 || 0), num(a.z, 0));
  };
  const poseOf = (p) => (typeof p === 'string' && BONE_POSES.some((q) => q.id === p) ? p : null);
  const objects = [];
  let seq = 0;
  const addPath = (ob, raw, mode) => {
    if (!Array.isArray(raw) || raw.length < 2) return;
    ob.path = raw.map((p) => { const v = v3of(p, 0); return { x: v.x, y: 0, z: v.z }; });
    ob.pathOrigin = { x: ob.pos.x, y: ob.pos.y, z: ob.pos.z };
    ob.pathMode = mode === 'linear' ? 'linear' : 'curve';
  };
  for (const c of Array.isArray(sp.characters) ? sp.characters : []) {
    seq += 1;
    const pos = v3of(c.pos, 0);
    const ob = {
      id: String(c.id || 'char' + seq), name: String(c.name || c.label || ('角色' + seq)),
      kind: 'model', assetId: String(c.assetId || 'xbot'),
      typeId: String(c.typeId || actorTypeIdOf(c.preset || c.body || 'm_standard')),
      pos, rotY: num(c.rotY, 0),
      h: num(c.h, (ACTOR_PRESETS.find((p) => p.id === (c.preset || c.body)) || {}).h || 1.78),
      clip: String(c.clip || 'idle'), animTime: 0,
      visible: c.visible !== false, color: String(c.color || '#c9ced6'),
    };
    if (c.scale) ob.scale = v3of(c.scale, 1);
    const pose = poseOf(c.pose);
    if (pose) ob.poseId = pose;
    if (c.material && typeof c.material === 'object') ob.material = { ...c.material };
    if (c.skinning && /^(lbs|dqs|auto)$/i.test(String(c.skinning))) ob.skinning = String(c.skinning).toLowerCase();
    if (Array.isArray(c.ik) && c.ik.length) {
      ob.ik = c.ik.filter((x) => x && Array.isArray(x.chain) && x.chain.length >= 3 && x.target)
        .map((x) => { const o = { chain: x.chain.map(String), target: x.target }; if (x.pole) o.pole = x.pole; if (x.weight !== undefined) o.weight = Number(x.weight); return o; });
      if (!ob.ik.length) delete ob.ik;
    }
    if (Array.isArray(c.constraints) && c.constraints.length) {
      ob.constraints = c.constraints.filter((x) => x && x.bone && x.type).map((x) => Object.assign({}, x));
      if (!ob.constraints.length) delete ob.constraints;
    }
    if (Array.isArray(c.clips) && c.clips.length) {
      ob.clips = c.clips.filter((x) => x && Array.isArray(x.keys) && x.keys.length).map((x) => {
        const o = { keys: x.keys, blend: String(x.blend || 'replace'), influence: Number(x.influence === undefined ? 1 : x.influence) };
        if (x.t0 !== undefined) o.t0 = Number(x.t0);
        if (x.t1 !== undefined) o.t1 = Number(x.t1);
        if (x.loop) o.loop = true;
        return o;
      });
      if (!ob.clips.length) delete ob.clips;
    }
    addPath(ob, c.path, c.pathMode);
    if (ob.path && c.pathFace === false) ob.pathFace = false;
    if (c.locomotion && typeof c.locomotion === 'object') ob.locomotion = { ...c.locomotion };
    if (c.bonePose && typeof c.bonePose === 'object') ob.bonePose = JSON.parse(JSON.stringify(c.bonePose));
    if (Array.isArray(c.poseKeys)) ob.poseKeys = c.poseKeys.map((k) => ({ t: num(k.t, 0), bonePose: JSON.parse(JSON.stringify(k.bonePose || {})), ease: String(k.ease || 'auto') })).sort((a, b) => a.t - b.t);
    if (Array.isArray(c.poseAnim)) {
      ob.poseAnim = c.poseAnim.map((k) => ({ t: num(k.t, 0), poseId: poseOf(k.pose || k.poseId) || 'none' })).sort((a, b) => a.t - b.t);
      if (c.loop) { ob.poseLoop = num(c.loopPeriod, ob.poseAnim[ob.poseAnim.length - 1].t); }
    }
    if (Array.isArray(c.keys)) {
      ob.keys = c.keys.map((k) => ({ t: num(k.t, 0), pos: v3of(k.pos, 0), rotY: num(k.rotY, 0), rx: num(k.rx, 0), rz: num(k.rz, 0), ease: String(k.ease || 'auto') })).sort((a, b) => a.t - b.t);
    }
    objects.push(ob);
  }
  for (const p of Array.isArray(sp.props) ? sp.props : []) {
    seq += 1;
    const preset = SPEC_PRESET_IDS.includes(p.preset) ? p.preset : 'box';
    const pob = {
      id: String(p.id || 'prop' + seq), name: String(p.name || p.label || ('布景' + seq)),
      kind: 'geom', preset, pos: v3of(p.pos, 0), rotY: num(p.rotY, 0), rx: num(p.rx, 0), rz: num(p.rz, 0),
      scale: p.scale ? v3of(p.scale, 1) : v3(1, 1, 1), visible: p.visible !== false,
      color: String(p.color || '#b3b8bf'),
    };
    if (p.material && typeof p.material === 'object') pob.material = { ...p.material };
    // 道具关键帧：与角色同构（t/pos/rotY/rx/rz/ease），供长枪等跟手（applyPlayhead 对所有对象统一应用）
    if (Array.isArray(p.keys)) {
      pob.keys = p.keys.map((k) => ({
        t: num(k.t, 0),
        pos: v3of(k.pos, 0),
        rotY: num(k.rotY, 0),
        rx: num(k.rx, 0),
        rz: num(k.rz, 0),
        ease: String(k.ease || 'auto'),
        ...(k.interp ? { interp: String(k.interp) } : {}),
      })).sort((x, y) => x.t - y.t);
    }
    objects.push(pob);
  }
  const cameras = (Array.isArray(sp.cameras) ? sp.cameras : []).map((c, i) => {
    const cam = {
      id: String(c.id || 'cam' + (i + 1)), name: String(c.name || ('机位' + (i + 1))),
      pos: v3of(c.pos || [0, 1.6, 4], 1.6), target: v3of(c.target || [0, 1, 0], 1),
      fov: num(c.fov, 42), roll: num(c.roll, 0), sensorFit: String(c.sensorFit || 'AUTO'), lookAhead: num(c.lookAhead, 1.2), keys: [],
    };
    if (c.sensorX !== undefined) cam.sensorX = num(c.sensorX, 36);
    if (c.lens !== undefined) cam.lens = num(c.lens, 0);
    if (Array.isArray(c.keys)) {
      cam.keys = c.keys.map((k) => ({
        t: num(k.t, 0), pos: v3of(k.pos, cam.pos.y), target: v3of(k.target || k.look || [0, 1, 0], 1),
        fov: num(k.fov, cam.fov), roll: num(k.roll, cam.roll), ease: String(k.ease || 'auto'),
      })).sort((a, b) => a.t - b.t);
    }
    if (c.pathMode) cam.pathMode = String(c.pathMode);
    return cam;
  });
  const duration = Math.max(0.5, num(sp.duration, Math.max(4, ...((sp.shots || []).map((x) => num(x.end, 0))), 4)));
  // 分镜引用可以写机位 id、name 或序号（1 起）——AI 写规格时最自然的是 name
  const resolveCam = (ref) => {
    if (ref === undefined || ref === null || ref === '') return (cameras[0] && cameras[0].id) || '';
    const key = String(ref);
    const byId = cameras.find((c) => c.id === key);
    if (byId) return byId.id;
    const byName = cameras.find((c) => c.name === key);
    if (byName) return byName.id;
    const nIdx = Number(key);
    if (Number.isFinite(nIdx) && nIdx >= 1 && nIdx <= cameras.length) return cameras[nIdx - 1].id;
    return (cameras[0] && cameras[0].id) || '';
  };
  const shots = (Array.isArray(sp.shots) ? sp.shots : []).map((s2, i) => ({
    id: String(s2.id || 'shot' + (i + 1)), label: String(s2.label || ''),
    cameraId: resolveCam(s2.camera !== undefined ? s2.camera : s2.cameraId),
    start: num(s2.start, 0), end: num(s2.end, duration),
  })).sort((a, b) => a.start - b.start);
  const markers = (Array.isArray(sp.markers) ? sp.markers : []).map((m) => ({ t: num(m.t, 0), label: String(m.label || '') })).sort((a, b) => a.t - b.t);
  const env0 = (sp.env && typeof sp.env === 'object') ? sp.env : {};
  const env = {
    preset: String(env0.preset || 'studio'),
    bg: String(env0.bg || '#1a1e24'), ground: String(env0.ground || '#2a2f36'),
    grid: env0.grid !== false, exposure: num(env0.exposure, 1),
    tonemap: String(env0.tonemap || 'agx'),
    guides: Object.assign({ heightRef: true, path: true, names: true, cameraFrame: true }, env0.guides || {}),
  };
  if (env0.sky && typeof env0.sky === 'object') env.sky = { ...env0.sky };
  // 雾：spec.fog = { color, near, far, density } 或 env.fog
  const fog0 = (sp.fog && typeof sp.fog === 'object') ? sp.fog : env0.fog;
  if (fog0 && typeof fog0 === 'object') {
    env.fog = {
      enabled: fog0.enabled !== false,
      color: String(fog0.color || '#aab4c0'),
      near: num(fog0.near, 6), far: num(fog0.far, 40), density: num(fog0.density, 1),
    };
  }
  // 景深：spec.dof = { focus, range, maxBlur } 或 env.dof
  const dof0 = (sp.dof && typeof sp.dof === 'object') ? sp.dof : env0.dof;
  if (dof0 && typeof dof0 === 'object') {
    env.dof = {
      enabled: dof0.enabled !== false,
      focus: num(dof0.focus, 5), range: num(dof0.range, 4), maxBlur: num(dof0.maxBlur, 6),
    };
  }
  const built = {
    version: 2,
    title: String(sp.title || 'AI 预演场景'),
    objects, cameras, shots, markers, env,
    lights: Array.isArray(sp.lights) && sp.lights.length ? sp.lights.map((l, i) => ({
      id: String(l.id || (i === 0 ? 'key' : i === 1 ? 'fill' : 'light' + (i + 1))),
      dir: v3of(l.dir || (i === 0 ? [0.42, -0.72, 0.55] : [-0.45, -0.35, -0.6]), -0.7),
      color: String(l.color || '#ffffff'), intensity: num(l.intensity, i === 0 ? 1.2 : 0.45),
    })) : [
      { id: 'key', dir: v3NormKey(), color: '#ffffff', intensity: num(env0.keyIntensity, 1.2) },
      { id: 'fill', dir: v3(-0.45, -0.35, -0.6), color: '#ffffff', intensity: num(env0.fillIntensity, 0.45) },
    ],
    activeCameraId: (cameras[0] && cameras[0].id) || '',
    shot: Object.assign(
      { duration },
      (sp.shot && typeof sp.shot === 'object' && sp.shot.shotSize) ? { shotSize: String(sp.shot.shotSize) } : {},
      (sp.shot && typeof sp.shot === 'object' && sp.shot.cameraMove) ? { cameraMove: String(sp.shot.cameraMove) } : {},
      (sp.shot && typeof sp.shot === 'object' && sp.shot.note) ? { note: String(sp.shot.note) } : {},
    ),
    playT: 0,
  };
  return migrateStageScene(built);
}

/** 场景 → 规格（供「导出为 AI 规格 / 反向生成」使用）。 */
export function compileStageSpec(scene) {
  const sc = scene || {};
  const arr = (p) => [round3(p.x), round3(p.y), round3(p.z)];
  const characters = [];
  const props = [];
  for (const ob of sc.objects || []) {
    if (ob.kind === 'model') {
      const c = {
        id: ob.id, name: ob.name || ob.id, assetId: ob.assetId || 'xbot', typeId: ob.typeId || 'm_standard',
        pos: arr(ob.pos || v3(0, 0, 0)), rotY: round3(ob.rotY || 0), rx: round3(ob.rx || 0), rz: round3(ob.rz || 0),
        h: round3(ob.h || 1.78), clip: ob.clip || 'idle', color: ob.color,
      };
      if (ob.visible === false) c.visible = false;
      if (ob.scale && (Number(ob.scale.x) !== 1 || Number(ob.scale.y) !== 1 || Number(ob.scale.z) !== 1)) c.scale = arr(ob.scale);
      if (ob.poseId) c.pose = ob.poseId;
      if (ob.material) c.material = { ...ob.material };
      if (ob.skinning) c.skinning = ob.skinning;
      if (Array.isArray(ob.ik) && ob.ik.length) c.ik = JSON.parse(JSON.stringify(ob.ik));
      if (Array.isArray(ob.constraints) && ob.constraints.length) c.constraints = JSON.parse(JSON.stringify(ob.constraints));
      if (Array.isArray(ob.clips) && ob.clips.length) c.clips = JSON.parse(JSON.stringify(ob.clips));
      if (ob.bonePose && Object.keys(ob.bonePose).length) c.bonePose = JSON.parse(JSON.stringify(ob.bonePose));
      if (Array.isArray(ob.path) && ob.path.length) {
        c.path = ob.path.map(arr); c.pathMode = ob.pathMode || 'curve';
        if (ob.pathFace === false) c.pathFace = false;
      }
      if (ob.locomotion) c.locomotion = { ...ob.locomotion };
      if (Array.isArray(ob.poseAnim) && ob.poseAnim.length) c.poseAnim = ob.poseAnim.map((k) => ({ t: round3(k.t), pose: k.poseId }));
      if (Array.isArray(ob.poseKeys) && ob.poseKeys.length) c.poseKeys = ob.poseKeys.map((k) => ({ t: round3(k.t), bonePose: JSON.parse(JSON.stringify(k.bonePose || {})), ease: k.ease || 'auto' }));
      if (Array.isArray(ob.keys) && ob.keys.length) c.keys = ob.keys.map((k) => ({ t: round3(k.t), pos: arr(k.pos), rotY: round3(k.rotY || 0), rx: round3(k.rx || 0), rz: round3(k.rz || 0), ease: k.ease || 'auto' }));
      characters.push(c);
    } else {
      props.push({
        id: ob.id, name: ob.name || ob.id, preset: ob.preset || 'box',
        pos: arr(ob.pos || v3(0, 0, 0)), rotY: round3(ob.rotY || 0), rx: round3(ob.rx || 0), rz: round3(ob.rz || 0),
        scale: arr(ob.scale || v3(1, 1, 1)), color: ob.color,
        visible: ob.visible === false ? false : undefined,
        material: ob.material ? { ...ob.material } : undefined,
        ...(Array.isArray(ob.keys) && ob.keys.length
          ? { keys: ob.keys.map((k) => ({ t: round3(k.t), pos: arr(k.pos), rotY: round3(k.rotY || 0), rx: round3(k.rx || 0), rz: round3(k.rz || 0), ease: k.ease || 'auto' })) }
          : {}),
      });
    }
  }
  return {
    title: sc.title || 'AI 预演场景',
    duration: Number((sc.shot && sc.shot.duration) || 6),
    // 镜头参数整体带出（之前只导 duration，景别/运镜/备注在往返后全丢）
    shot: {
      duration: Number((sc.shot && sc.shot.duration) || 6),
      shotSize: (sc.shot && sc.shot.shotSize) || undefined,
      cameraMove: (sc.shot && sc.shot.cameraMove) || undefined,
      note: (sc.shot && sc.shot.note) || undefined,
    },
    env: Object.assign({}, sc.env || {}),
    characters, props,
    cameras: (sc.cameras || []).map((c) => ({
      id: c.id, name: c.name || c.id, pos: arr(c.pos), target: arr(c.target),
      fov: round3(c.fov || 42), roll: round3(c.roll || 0), sensorFit: c.sensorFit || 'AUTO',
      sensorX: round3(c.sensorX || 36), lens: round3(c.lens || 0) || undefined,
      pathMode: c.pathMode || 'line', lookAhead: round3(c.lookAhead || 1.2),
      keys: (c.keys || []).map((k) => ({ t: round3(k.t), pos: arr(k.pos), target: arr(k.target), fov: round3(k.fov || c.fov || 42), roll: round3(k.roll || c.roll || 0), ease: k.ease || 'auto' })),
    })),
    shots: (sc.shots || []).map((s2) => ({ id: s2.id, label: s2.label, camera: ((sc.cameras || []).find((c) => c.id === s2.cameraId) || {}).name || s2.cameraId, start: round3(s2.start), end: round3(s2.end) })),
    markers: (sc.markers || []).map((m) => ({ t: round3(m.t), label: m.label || '' })),
    lights: (sc.lights || []).map((l) => ({ dir: arr(l.dir || v3(0.4, -0.7, 0.5)), color: l.color, intensity: round3(l.intensity) })),
    fog: (sc.env && sc.env.fog) ? Object.assign({}, sc.env.fog) : undefined,
    dof: (sc.env && sc.env.dof) ? Object.assign({}, sc.env.dof) : undefined,
  };
}
const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const v3NormKey = () => vNorm(v3(0.42, -0.72, 0.55));


// ============================================================
// 「一句话 → 规格」模板库（打斗 / 追逐 / 对话）
//   AI 侧只需给一句自然语言，这里产出可直接 buildStageFromSpec 的规格。
// ============================================================
export const BRIEF_TEMPLATES = [
  { id: 'fight', zh: '打斗', en: 'Fight', keywords: ['打斗', '战斗', '开打', '对打', '格斗', 'pk', 'fight', 'battle', '拳'] },
  { id: 'chase', zh: '追逐', en: 'Chase', keywords: ['追逐', '追', '逃', '奔跑', 'chase', 'run', 'escape', '追车'] },
  { id: 'dialogue', zh: '对话', en: 'Dialogue', keywords: ['对话', '说话', '交谈', '对峙', '谈判', 'dialogue', 'talk', 'conversation', '聊'] },
];

/**
 * 一句话 → 场景规格。
 * opts = { template, duration, actors, mood }
 * 返回可直接交给 buildStageFromSpec 的对象（含 lights / fog / dof / shots）。
 */
export function specFromBrief(brief, opts) {
  const o = opts || {};
  const text = String(brief || '').toLowerCase();
  const tpl = o.template || (BRIEF_TEMPLATES.find((t) => t.keywords.some((k) => text.includes(k))) || {}).id || 'dialogue';
  // 时长：从文本里抓「N秒 / N s / N seconds」，否则按模板默认
  let dur = Number(o.duration);
  if (!Number.isFinite(dur) || dur <= 0) {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(秒|s\b|sec|seconds?)/);
    dur = m ? Math.max(1.5, Math.min(30, Number(m[1]))) : (tpl === 'chase' ? 6 : tpl === 'fight' ? 5 : 8);
  }
  const actors = Array.isArray(o.actors) && o.actors.length ? o.actors : ['主角', '对手'];
  const A = String(actors[0] || '主角');
  const B = String(actors[1] || '对手');
  const half = Math.max(0.8, dur / 2);
  const base = {
    title: String(brief || (tpl === 'fight' ? '打斗预演' : tpl === 'chase' ? '追逐预演' : '对话预演')).slice(0, 40),
    duration: dur,
    env: { preset: tpl === 'chase' ? 'daylight' : tpl === 'fight' ? 'night' : 'studio', grid: true, tonemap: 'agx' },
  };
  if (tpl === 'fight') {
    return Object.assign(base, {
      characters: [
        { name: A, pos: [-1.1, 0, 0], rotY: 1.2, pose: 'fight', color: '#c9ced6' },
        { name: B, pos: [1.1, 0, 0], rotY: -1.2, pose: 'fight', color: '#b9c2cc' },
      ],
      props: [{ name: '地面台', preset: 'plane', pos: [0, 0, 0], scale: [14, 1, 14], color: '#9aa3ad' }],
      cameras: [
        { name: 'A 中景', pos: [0, 1.5, 4.4], target: [0, 1.0, 0], fov: 40 },
        { name: 'B 低角', pos: [2.6, 0.55, 2.8], target: [0, 1.1, 0], fov: 46, },
      ],
      shots: [
        { camera: 'A 中景', start: 0, end: half },
        { camera: 'B 低角', start: half, end: dur },
      ],
      lights: [
        { dir: [0.35, -0.8, 0.45], color: '#ffffff', intensity: 1.35 },
        { dir: [-0.4, -0.25, -0.6], color: '#9fb4d8', intensity: 0.5 },
      ],
      fog: { color: '#2a3038', near: 6, far: 22, density: 1 },
      dof: { focus: 4.2, range: 2.6, maxBlur: 5 },
      poseAnim: null,
    });
  }
  if (tpl === 'chase') {
    return Object.assign(base, {
      characters: [
        { name: A, pos: [-3, 0, 0], rotY: 0, pose: 'run' && null, clip: 'run', color: '#c9ced6',
          path: [[-3, 0], [-3, 0], [4, -1.5], [9, -1.5]], pathFace: true,
          locomotion: { source: 'clip', stride: 1.1, cycle: 0.8, refSpeed: 4 } },
        { name: B, pos: [-4.6, 0, 0.6], rotY: 0, clip: 'run', color: '#b3bcc6',
          path: [[-4.6, 0.6], [-4.6, 0.6], [3, -1.0], [8.2, -1.0]], pathFace: true,
          locomotion: { source: 'clip', stride: 1.1, cycle: 0.8, refSpeed: 4 } },
      ],
      props: [{ name: '路面', preset: 'plane', pos: [2, 0, 0], scale: [26, 1, 10], color: '#9aa3ad' }],
      cameras: [
        { name: '侧跟', pos: [1.5, 1.6, 7.5], target: [1.5, 1.0, 0], fov: 44 },
        { name: '低位追', pos: [5.5, 0.8, 5.2], target: [3.5, 1.0, 0], fov: 40 },
      ],
      shots: [{ camera: '侧跟', start: 0, end: half }, { camera: '低位追', start: half, end: dur }],
      lights: [{ dir: [0.4, -0.75, 0.4], color: '#fff4e0', intensity: 1.3 }],
      dof: { focus: 6, range: 5, maxBlur: 4 },
    });
  }
  // dialogue：正反打
  return Object.assign(base, {
    characters: [
      { name: A, pos: [-0.9, 0, 0], rotY: 1.45, clip: 'idle', color: '#c9ced6' },
      { name: B, pos: [0.9, 0, 0], rotY: -1.45, clip: 'idle', color: '#b9c2cc' },
    ],
    props: [{ name: '桌面', preset: 'box', pos: [0, 0, 0.1], scale: [2.2, 0.75, 1.1], color: '#8f98a3' }],
    cameras: [
      { name: 'A 过肩', pos: [-1.5, 1.55, -2.1], target: [0.9, 1.4, 0], fov: 40 },
      { name: 'B 过肩', pos: [1.5, 1.55, -2.1], target: [-0.9, 1.4, 0], fov: 40 },
      { name: '双人', pos: [0, 1.5, 4.6], target: [0, 1.05, 0], fov: 40 },
    ],
    shots: [
      { camera: '双人', start: 0, end: Math.max(0.6, dur * 0.2) },
      { camera: 'A 过肩', start: Math.max(0.6, dur * 0.2), end: half },
      { camera: 'B 过肩', start: half, end: dur },
    ],
    lights: [{ dir: [0.3, -0.7, 0.5], color: '#fff6ea', intensity: 1.15 }, { dir: [-0.5, -0.2, -0.4], color: '#cfd6e2', intensity: 0.5 }],
    dof: { focus: 4.5, range: 2.2, maxBlur: 7 },
  });
}


// ============================================================
// 时间轴（Dope Sheet）辅助：关键帧查询 / 插值模式 / 标记
//   Blender 语义对齐：G 移动、I 插入、X 删除、Shift+←/→ 跳关键帧、T 设插值
// ============================================================
/** 关键帧时间列表（升序）。 */
export function keyTimesOf(keys) {
  return (Array.isArray(keys) ? keys : []).map((k) => Number(k.t) || 0).sort((a, b) => a - b);
}
/** 当前时间之前/之后最近的关键帧时间（没有则 null）。 */
export function prevKeyTime(keys, t) {
  const ts = keyTimesOf(keys).filter((x) => x < (Number(t) || 0) - 1e-6);
  return ts.length ? ts[ts.length - 1] : null;
}
export function nextKeyTime(keys, t) {
  const ts = keyTimesOf(keys).filter((x) => x > (Number(t) || 0) + 1e-6);
  return ts.length ? ts[0] : null;
}
/** 找 t 附近的关键帧下标（用于删除/改插值）。 */
export function keyIndexAt(keys, t, eps) {
  const e = eps === undefined ? 0.06 : eps;
  let best = -1, bestD = e;
  (Array.isArray(keys) ? keys : []).forEach((k, i) => {
    const d = Math.abs((Number(k.t) || 0) - (Number(t) || 0));
    if (d <= bestD) { bestD = d; best = i; }
  });
  return best;
}
/** 插值模式：'auto'（平滑）/ 'linear' / 'constant'（跳变）。返回 [0,1] 的缓动值。 */
export function easeAt(a, b, t, mode) {
  const span = b - a;
  const k = span > 1e-9 ? Math.max(0, Math.min(1, ((Number(t) || 0) - a) / span)) : 0;
  if (mode === 'linear') return k;
  if (mode === 'constant') return 0;
  return k * k * (3 - 2 * k);
}
/** 按插值模式采样「带 ease 的关键帧曲线」。keys: [{t, ...values}] → 返回插值后的对象。 */
export function sampleKeysEased(keys, t, fields) {
  if (!Array.isArray(keys) || !keys.length) return null;
  const ks = keys.slice().sort((x, y) => x.t - y.t);
  const tt = Number(t) || 0;
  if (tt <= ks[0].t) return Object.assign({}, ks[0]);
  if (tt >= ks[ks.length - 1].t) return Object.assign({}, ks[ks.length - 1]);
  let a = ks[0], b = ks[ks.length - 1];
  for (let i = 0; i < ks.length - 1; i++) if (tt >= ks[i].t && tt <= ks[i + 1].t) { a = ks[i]; b = ks[i + 1]; break; }
  const mode = String((b.ease || a.ease || 'auto'));
  const k = easeAt(a.t, b.t, tt, mode);
  const out = Object.assign({}, a);
  for (const f of (fields || Object.keys(a))) {
    const va = a[f], vb = b[f];
    if (va && vb && typeof va === 'object' && 'x' in va) out[f] = v3(va.x + (vb.x - va.x) * k, va.y + (vb.y - va.y) * k, va.z + (vb.z - va.z) * k);
    else if (typeof va === 'number' && typeof vb === 'number') out[f] = va + (vb - va) * k;
  }
  return out;
}
/** 场景标记（Markers）：[{t, label}] */
export function addMarker(scene, t, label) {
  if (!scene) return null;
  if (!Array.isArray(scene.markers)) scene.markers = [];
  const m = { t: Math.max(0, Number(t) || 0), label: String(label || '标记') };
  scene.markers.push(m);
  scene.markers.sort((a, b) => a.t - b.t);
  return m;
}
export function removeMarkerAt(scene, t, eps) {
  if (!scene || !Array.isArray(scene.markers)) return false;
  const i = keyIndexAt(scene.markers, t, eps === undefined ? 0.08 : eps);
  if (i < 0) return false;
  scene.markers.splice(i, 1);
  return true;
}
/** 时间轴总览：每个通道的关键帧数量（UI 用）。 */
export function dopeSheetInfo(scene) {
  const out = { duration: Number((scene && scene.shot && scene.shot.duration) || 6), tracks: [] };
  for (const ob of (scene && scene.objects) || []) {
    const keys = (ob.keys || []).concat((ob.poseAnim || []).map((k) => ({ t: k.t, kind: 'pose' })));
    out.tracks.push({ id: 'obj:' + ob.id, label: ob.name || ob.id, kind: 'object', keys: keyTimesOf(keys), count: keys.length });
  }
  for (const c of (scene && scene.cameras) || []) {
    out.tracks.push({ id: 'cam:' + c.id, label: c.name || c.id, kind: 'camera', keys: keyTimesOf(c.keys || []), count: (c.keys || []).length });
  }
  for (const s2 of (scene && scene.shots) || []) {
    out.tracks.push({ id: 'shot:' + s2.id, label: '分镜 ' + (s2.cameraId || ''), kind: 'shot', keys: [Number(s2.start) || 0, Number(s2.end) || 0], count: 2 });
  }
  out.markers = Array.isArray(scene && scene.markers) ? scene.markers.slice() : [];
  return out;
}
export function applyPlayhead(scene, t) {
  if (!scene) return scene;
  const time = Math.max(0, Number(t) || 0);
  const out = Object.assign({}, scene);
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerp3 = (p, q, k) => {
    const A = p || q || v3(0, 0, 0);
    const B = q || p || v3(0, 0, 0);
    return v3(lerp(Number(A.x) || 0, Number(B.x) || 0, k),
              lerp(Number(A.y) || 0, Number(B.y) || 0, k),
              lerp(Number(A.z) || 0, Number(B.z) || 0, k));
  };
  /** 取关键帧区间与插值系数 */
  const pickPair = (keys) => {
    const ks = keys.slice().sort((a, b) => a.t - b.t);
    if (!ks.length) return null;
    if (ks.length === 1) return { a: ks[0], b: ks[0], k: 0 };
    if (time <= ks[0].t) return { a: ks[0], b: ks[0], k: 0 };
    if (time >= ks[ks.length - 1].t) return { a: ks[ks.length - 1], b: ks[ks.length - 1], k: 0 };
    for (let i = 0; i < ks.length - 1; i++) {
      if (time >= ks[i].t && time <= ks[i + 1].t) {
        const span = ks[i + 1].t - ks[i].t;
        const rawK = span > 1e-6 ? (time - ks[i].t) / span : 0;
        const mode = String(ks[i + 1].ease || ks[i].ease || 'auto');
        const k = mode === 'constant' ? 0 : mode === 'linear' ? rawK : rawK * rawK * (3 - 2 * rawK);
        return { a: ks[i], b: ks[i + 1], k };
      }
    }
    return { a: ks[0], b: ks[0], k: 0 };
  };

  out.objects = (scene.objects || []).map((o) => {
    const next = Object.assign({}, o, { animTime: time });
    // 运动驱动默认开启：有路径就按速度驱动「当前动作片段」（ob.clip）的步频，避免滑步。
    // 显式 source:'action' 改用自建动作，source:'none' 关闭。动作只在对象「动作」一处选。
    const locoSrc = (o.locomotion && o.locomotion.source) ? String(o.locomotion.source) : 'clip';
    const motion = (Array.isArray(o.path) && o.path.length >= 2 && locoSrc !== 'none')
      ? locomotionAt(o, time, (scene.shot && scene.shot.duration) || 6) : null;
    if (motion) {
      next.motionDist = motion.dist; next.motionSpeed = motion.speed;
      if (locoSrc === 'clip') next.animTime = motion.animTime;
      else if (locoSrc === 'action') next.poseTime = motion.poseTime;
    }
    const poseSampleTime = next.poseTime !== undefined && next.poseTime !== null ? next.poseTime : time;
    // 姿态动画：poseAnim=[{t,poseId}] → 混合权重（在蒙皮时按权重 slerp）
    if (Array.isArray(o.poseAnim) && o.poseAnim.length) {
      const bl = poseBlendAt(BONE_POSES, o.poseAnim, poseSampleTime);
      if (bl) { next.poseBlend = bl; next.poseId = null; }
    }
    // 姿态根位移（下蹲/轻功/倒地需要整体升降）：**只在骨骼层生效**（见 applyBonePoseToLocal
    // 的 ①b2 段：把 Hips 整体上下平移）。这里绝不能再往 pos.y 里加一次——
    // 那是重复应用，而且会把物体的逻辑原点（人物脚底）污染成"髋部高度"，
    // 导致 gizmo 轴心悬空、路径/关键帧的 y 基准也跟着漂。
    // （历史 bug：这一行曾把 rootY 加到 next.pos.y 上，站立时 pos.y≈1.04，轴心飘到腰腹。）
    // 姿态中心偏移（**仅供需要「跟随身体」的场合**，例如要让 gizmo 贴住倒地的人）：
    // 单独存成 poseCenterY，绝不并进 pos.y —— pos.y 永远是物体原点。
    {
      // 姿态根位移只用于**渲染骨骼**（applyBonePoseToLocal 负责），此处不再写 pos.y。
      // 保留一个显式的空块形式以免误读：确需场景级整体升降时，请改 sh 的 ground 或加关键帧，
      // 不要把姿态位移混进物体原点。
    }
    // 姿态中心偏移（供 gizmo / 拾取跟随身体，而非留在地面原点）
    if (next.kind === 'model' && gltfAssetOf(next.assetId)) {
      try {
        const a2 = gltfAssetOf(next.assetId);
        const clipName = next.clip || (a2.animations[0] && a2.animations[0].name) || '';
        const clip = clipName ? a2.clipByName(clipName) : null;
        let hipsY = null;
        if (clip && Array.isArray(clip.tracks)) {
          const hipTrack = clip.tracks.find((tr) => tr.path === 'translation' && tr.node === (a2.bones.find((x) => String(x.name).replace(/^mixamorig:?/i, '') === 'Hips') || {}).nodeIdx);
          if (hipTrack) {
            const tv = hipTrack.times, vv = hipTrack.vals;
            const n = tv.length;
            if (n) {
              let i2 = 0;
              const tt = Math.max(tv[0], Math.min(tv[n - 1], time));
              while (i2 < n - 2 && tv[i2 + 1] < tt) i2++;
              const k2 = (tt - tv[i2]) / Math.max(1e-6, tv[i2 + 1] - tv[i2]);
              hipsY = (vv[i2 * 3 + 1] * (1 - k2) + vv[(i2 + 1) * 3 + 1] * k2) / 100;  // 厘米 → 米
            }
          }
        }
        if (hipsY !== null && Number.isFinite(hipsY)) {
          // 髋的实际世界高度就作为 gizmo 中心高度（站立≈1.04，倒地≈0.35）
          next.poseCenterY = Math.max(0.15, Math.min(1.2, hipsY));
        }
      } catch { /* 姿态中心算不出就退回原点 */ }
    }
    // 姿态关键帧：优先于静态 bonePose（姿态随时间过渡）
    if (Array.isArray(o.poseKeys) && o.poseKeys.length) {
      const ip = interpolatePoseKeys(o.poseKeys, time);
      if (ip) next.bonePose = ip;
    }
    // 物体路径：沿画好的线运动（优先于位置关键帧）
    if (Array.isArray(o.path) && o.path.length >= 2 && (o.pathMode === 'curve' || o.pathMode === 'linear')) {
      const pp = objectPathPos(o, time, (scene.shot && scene.shot.duration) || 6);
      if (pp) {
        // 相对轨迹：以 pathOrigin 为锚 —— t=0 时对象停在原位，不会因为画了路径就瞬移
        const org = o.pathOrigin || o.path[0];
        const b0 = o.path[0];
        next.pos = v3(
          (Number(org.x) || 0) + (pp.x - b0.x),
          (Number(org.y) || 0) + (pp.y - b0.y),
          (Number(org.z) || 0) + (pp.z - b0.z),
        );
      }
      // 沿路径自动转向：朝向 = 路径切线方向（o.pathFace !== false 时生效）
      if (pp && o.pathFace !== false) {
        const eps = 0.05;
        const dur2 = (scene.shot && scene.shot.duration) || 6;
        const tt = Math.min(dur2, Math.max(0, time + eps));
        const tb = Math.max(0, time - eps);
        const pf = objectPathPos(o, tt, dur2);
        const pb = objectPathPos(o, tb, dur2);
        if (pf && pb) {
          const tx = pf.x - pb.x, tz = pf.z - pb.z;
          if (Math.hypot(tx, tz) > 1e-5) next.rotY = Math.atan2(tx, tz);
        }
      }
    }
    // 对象关键帧：位置 / 朝向 / 翻滚（逐通道求值，支持 bezier/linear/constant + ease）
    if (Array.isArray(o.keys) && o.keys.length) {
      const kx = evalKeyChannel(o.keys, (kk) => (kk.pos ? kk.pos.x : undefined), time);
      const ky = evalKeyChannel(o.keys, (kk) => (kk.pos ? kk.pos.y : undefined), time);
      const kz = evalKeyChannel(o.keys, (kk) => (kk.pos ? kk.pos.z : undefined), time);
      const kr = evalKeyChannel(o.keys, (kk) => kk.rotY, time);
      const kx2 = evalKeyChannel(o.keys, (kk) => kk.rx, time);
      const kz2 = evalKeyChannel(o.keys, (kk) => kk.rz, time);
      const hasPosKey = o.keys.some((kk) => kk && kk.pos);
      if (hasPosKey) next.pos = v3(kx === null ? o.pos.x : kx, ky === null ? o.pos.y : ky, kz === null ? o.pos.z : kz);
      next.rotY = kr === null ? (Number(o.rotY) || 0) : kr;
      next.rx = kx2 === null ? (Number(o.rx) || 0) : kx2;
      next.rz = kz2 === null ? (Number(o.rz) || 0) : kz2;
    }
    // 路径优先级高于对象位置关键帧：但只接管平面 X/Z，**竖直 Y 保留关键帧的高度**
    // （否则翻越/跳跃的关键帧抬升会被路径压回地面 —— 用户实测"翻不过去"）
    if (Array.isArray(o.path) && o.path.length >= 2 && (o.pathMode === 'curve' || o.pathMode === 'linear')) {
      const dur2 = (scene.shot && scene.shot.duration) || 6;
      const pp2 = objectPathPos(o, time, dur2);
      if (pp2) {
        const org = o.pathOrigin || o.path[0], b0 = o.path[0];
        next.pos = v3((Number(org.x) || 0) + (pp2.x - b0.x), next.pos.y, (Number(org.z) || 0) + (pp2.z - b0.z));
        if (o.pathFace !== false) {
          const pf = objectPathPos(o, Math.min(dur2, time + 0.05), dur2);
          const pb = objectPathPos(o, Math.max(0, time - 0.05), dur2);
          if (pf && pb) { const tx = pf.x - pb.x, tz = pf.z - pb.z; if (Math.hypot(tx, tz) > 1e-5) next.rotY = Math.atan2(tx, tz); }
        }
      }
    }
    return next;
  });

  // 分镜串联：当前时间的活动相机（覆盖 activeCameraId）
  const liveCamId = activeCameraAt(scene, time);
  out.activeCameraId = liveCamId || scene.activeCameraId;
  out.cameras = (scene.cameras || []).map((c) => {
    if (!Array.isArray(c.keys) || !c.keys.length) return c;
    // 样条路径模式（Follow Path 的 FOLLOW）：pos 走 Catmull-Rom，朝向 = 切线方向
    if (c.pathMode === 'curve' && c.keys.length >= 2) {
      const cp = cameraPathAt(c, time, c.lookAhead);
      if (cp) return Object.assign({}, c, { pos: cp.pos, target: cp.target });
    }
    const pr = pickPair(c.keys);
    if (!pr) return c;
    return Object.assign({}, c, {
      pos: lerp3(pr.a.pos || c.pos, pr.b.pos || c.pos, pr.k),
      target: lerp3(pr.a.target || c.target, pr.b.target || c.target, pr.k),
      fov: lerp(Number(pr.a.fov) || Number(c.fov) || 42, Number(pr.b.fov) || Number(c.fov) || 42, pr.k),
      roll: lerp(Number(pr.a.roll) || Number(c.roll) || 0, Number(pr.b.roll) || Number(c.roll) || 0, pr.k),
    });
  });
  out.__time = time;
  return out;
}

/** 复位到默认（新建布景时）的机位视角。 */
export function resetView(scene) {
  const def = directorDefaultScene();
  const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0];
  if (!cam) return false;
  cam.pos = v3(def.cameras[0].pos.x, def.cameras[0].pos.y, def.cameras[0].pos.z);
  cam.target = v3(def.cameras[0].target.x, def.cameras[0].target.y, def.cameras[0].target.z);
  cam.fov = def.cameras[0].fov;
  cam.roll = 0;
  return true;
}

/**
 * 关节人偶的 12 种体型：同一蒙皮模型 + 每项比例（身高 / 宽度 / 厚度）。
 * 预演只需要"看得出是谁、动作对不对"，用骨骼模型 + 比例缩放即可，
 * 不必真的重建 12 套网格（那样包体积会爆炸）。
 */
export const MANNEQUIN_TYPES = [
  { id: 'm_standard', zh: '男性 · 标准', en: 'Male standard', h: 1.78, w: 1.00, d: 1.00 , color: '#2f7fe8' },
  { id: 'f_standard', zh: '女性 · 标准', en: 'Female standard', h: 1.66, w: 0.92, d: 0.94 , color: '#e857a8' },
  { id: 'm_teen', zh: '男性 · 少年', en: 'Male teen', h: 1.60, w: 0.90, d: 0.92 , color: '#17b877' },
  { id: 'f_teen', zh: '女性 · 少年', en: 'Female teen', h: 1.54, w: 0.86, d: 0.90 , color: '#8b5cf6' },
  { id: 'm_child', zh: '男性 · 儿童', en: 'Male child', h: 1.18, w: 0.80, d: 0.86 , color: '#7cc93f' },
  { id: 'f_child', zh: '女性 · 儿童', en: 'Female child', h: 1.15, w: 0.78, d: 0.85 , color: '#f0a832' },
  { id: 'm_slim', zh: '男性 · 纤细', en: 'Male slim', h: 1.80, w: 0.88, d: 0.90 , color: '#38a8e8' },
  { id: 'f_slim', zh: '女性 · 纤细', en: 'Female slim', h: 1.68, w: 0.84, d: 0.88 , color: '#e85d6f' },
  { id: 'm_muscular', zh: '男性 · 健壮', en: 'Male muscular', h: 1.82, w: 1.12, d: 1.08 , color: '#f07818' },
  { id: 'f_muscular', zh: '女性 · 健壮', en: 'Female muscular', h: 1.70, w: 1.02, d: 1.02 , color: '#d83050' },
  { id: 'm_plump', zh: '男性 · 丰腴', en: 'Male plump', h: 1.74, w: 1.18, d: 1.14 , color: '#5865d8' },
  { id: 'f_plump', zh: '女性 · 丰腴', en: 'Female plump', h: 1.62, w: 1.14, d: 1.12 , color: '#a05fd8' },
];
export function mannequinTypeOf(id) { return MANNEQUIN_TYPES.find((t) => t.id === id) || MANNEQUIN_TYPES[0]; }

/** 资产包围盒（用于自动归一化到人高 / 落地）。 */
export function assetBounds(asset) {
  const p = asset.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  return { minX, minY, minZ, maxX, maxY, maxZ, height: maxY - minY };
}

/** 把资产归一化到目标高度、底部落地、XZ 居中（原地修改顶点）。 */
export function normalizeAsset(asset, targetHeight) {
  const b = assetBounds(asset);
  const h = b.height > 1e-6 ? b.height : 1;
  const k = (targetHeight || 1.7) / h;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const p = asset.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (p[i] - cx) * k;
    p[i + 1] = (p[i + 1] - b.minY) * k;
    p[i + 2] = (p[i + 2] - cz) * k;
  }
  return { scale: k, height: targetHeight || 1.7 };
}


// ============================================================
// 矩阵 / 投影 / 拾取 辅助（列主序 4x4，与 WebGL uniformMatrix4fv 一致）
// ============================================================
export function directorMat4Identity() {
  const m = new Float32Array(16); m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1; return m;
}
export function directorMat4Multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
export function directorMat4Perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan(((Number(fovDeg) || 42) * Math.PI / 180) / 2);
  const m = directorMat4Identity();
  m[0] = f / Math.max(1e-6, aspect); m[5] = f;
  m[10] = (far + near) / (near - far); m[11] = -1;
  m[14] = (2 * far * near) / (near - far); m[15] = 0;
  return m;
}
export function directorMat4Ortho(l, r, b, t, n, f) {
  const m = directorMat4Identity();
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
  return m;
}
export function directorMat4View(eye, center, up) {
  const z = vNorm(vSub(eye, center));
  const x = vNorm(vCross(up || v3(0, 1, 0), z));
  const y = vCross(z, x);
  const m = directorMat4Identity();
  m[0] = x.x; m[1] = y.x; m[2] = z.x;
  m[4] = x.y; m[5] = y.y; m[6] = z.y;
  m[8] = x.z; m[9] = y.z; m[10] = z.z;
  m[12] = -vDot(x, eye); m[13] = -vDot(y, eye); m[14] = -vDot(z, eye);
  return m;
}
export function directorMat4Model(pos, rotY, scale) {
  const c = Math.cos(Number(rotY) || 0), s = Math.sin(Number(rotY) || 0);
  const sx = Number(scale && scale.x) || 1, sy = Number(scale && scale.y) || 1, sz = Number(scale && scale.z) || 1;
  const m = directorMat4Identity();
  m[0] = c * sx; m[1] = 0; m[2] = -s * sx;
  m[4] = 0; m[5] = sy; m[6] = 0;
  m[8] = s * sz; m[9] = 0; m[10] = c * sz;
  m[12] = pos.x; m[13] = pos.y; m[14] = pos.z;
  return m;
}
/** 相机空间深度（沿视线的正向距离）。 */
export function depthOf(cam, p) {
  const fwd = vNorm(vSub(cam.target, cam.pos));
  return Math.max(0.001, vDot(vSub(p, cam.pos), fwd));
}
/** 该深度上「一个屏幕像素」对应多少世界单位。 */
export function pixelSizeAt(cam, h, dep) {
  const fov = ((Number(cam && cam.fov) || 42) * Math.PI) / 180;
  return (2 * Math.max(0.001, dep) * Math.tan(fov / 2)) / Math.max(1, Number(h) || 600);
}

/** 相机世界基向量（屏向手柄/箭头用）：与轴方向解耦，任何朝向都不会退化。 */
export function cameraBasis(cam) {
  const fwd = vNorm(vSub(cam.target || v3(0, 0, 0), cam.pos || v3(0, 0, 0)));
  let right = vCross(fwd, v3(0, 1, 0));
  if (vLen(right) < 1e-6) right = v3(1, 0, 0);
  right = vNorm(right);
  const up = vNorm(vCross(right, fwd));
  return { right, up, fwd };
}

/**
 * 建筑漫游式相机步进（Lumion / D5 习惯）：
 *   W/S = 沿「视线水平投影」前后；A/D = 水平右向量左右平移；Q/E = 世界 Y 上下。
 *   位移同时作用于 pos 与 target（纯平移，朝向不变）；Y 不低于 minY（贴地不下穿）。
 * input: { f, r, u } 均在 [-1, 1]；dt 秒（内部 clamp 0..0.1，切后台回来不瞬移）。
 * 返回 { pos, target, moved }；无输入/无位移返回 null。纯函数，不依赖 React/DOM。
 */
export function cameraFlyStep(cam, input, dt, opts) {
  const o = opts || {};
  const i = input || {};
  const d = Math.max(0, Math.min(0.1, Number(dt) || 0));
  if (!cam || !cam.pos || !cam.target || d <= 0) return null;
  const f = Math.max(-1, Math.min(1, Number(i.f) || 0));
  const r = Math.max(-1, Math.min(1, Number(i.r) || 0));
  const u = Math.max(-1, Math.min(1, Number(i.u) || 0));
  if (!f && !r && !u) return null;
  const speed = Math.max(0.1, Number(o.speed) || 4) * (o.fast ? 4 : 1) * (o.slow ? 0.3 : 1);
  const minY = Number.isFinite(Number(o.minY)) ? Number(o.minY) : 0.15;
  // 水平投影前向：俯仰不影响 W/S（升降交给 Q/E）
  const raw = vSub(cam.target, cam.pos);
  let fwdH = v3(raw.x, 0, raw.z);
  if (vLen(fwdH) < 1e-6) fwdH = v3(0, 0, -1);   // 正上/正下看时给个默认前向
  fwdH = vNorm(fwdH);
  const right = vNorm(vCross(fwdH, v3(0, 1, 0)));
  // 组合向量归一化：斜向（W+D）不会比直行快
  let mx = fwdH.x * f + right.x * r;
  let mz = fwdH.z * f + right.z * r;
  const my = u;
  const len = Math.hypot(mx, my, mz);
  if (len < 1e-9) return null;
  const k = (speed * d) / len;
  const dx = mx * k, dz = mz * k;
  const posY = Math.max(minY, cam.pos.y + my * k);
  const dy = posY - cam.pos.y;
  return {
    pos: v3(cam.pos.x + dx, posY, cam.pos.z + dz),
    target: v3(cam.target.x + dx, cam.target.y + dy, cam.target.z + dz),
    moved: Math.hypot(dx, dy, dz),
  };
}

/**
 * gizmo 度量：绘制与拾取的唯一尺寸来源。
 * 单位一律是 CSS 像素 → 同一相机/同一 CSS 尺寸下两者必然一致（历史 bug：绘制用设备像素、拾取用 CSS，命中区偏移）。
 */
export function gizmoMetrics(cam, sel, hCss, originOverride) {
  // 轴心 = 物体自身坐标系原点（人物是脚底中心），**不随姿态上浮**。
  // 轴朝向由 objectAxes(sel) 给出 → 物体旋转时轴跟着转（人物倒地后 z 轴仍指向头）。
  // 需要「轴心跟随身体」的场合显式传 originOverride（见 render 里的 gizmoFollowBody 开关）。
  const origin = originOverride || v3(sel.pos.x, sel.pos.y, sel.pos.z);
  const depth = depthOf(cam, origin);
  const pxWorld = pixelSizeAt(cam, hCss, depth);
  const minWorld = Math.max(0.25, (Number(sel.h) || 1.7) / 3);
  const L = Math.max(pxWorld * 105, minWorld);
  const R = L * 0.62;
  return {
    origin, pxWorld, depth, L, R, minWorld,
    px: { shaft: 7.5, shaftHover: 11, ring: 5, ringHover: 8.5, handle: 11, handleHover: 15 },
  };
}
/** Blender ED_view3d_radius_to_dist_persp：把「画面半径」换算成相机距离。 */

/** 取景景别：每档给定「主体占画面高度比例」。 */
export const SHOT_FILLS = [
  { id: 'extreme_close', zh: '大特写', en: 'Extreme close-up', fill: 0.88 },
  { id: 'close', zh: '特写', en: 'Close-up', fill: 0.66 },
  { id: 'medium_close', zh: '近景', en: 'Medium close-up', fill: 0.52 },
  { id: 'medium', zh: '中景', en: 'Medium shot', fill: 0.40 },
  { id: 'medium_full', zh: '中全景', en: 'Medium full', fill: 0.32 },
  { id: 'cowboy', zh: '七分身', en: 'Cowboy', fill: 0.26 },
  { id: 'full', zh: '全景', en: 'Full shot', fill: 0.20 },
  { id: 'wide', zh: '远景', en: 'Wide shot', fill: 0.12 },
];
/** 传感器适配：AUTO 取长边（Blender sensor_fit=AUTO）。 */
export function sensorFit(mode, sensorW, sensorH) {
  const m = String(mode || 'AUTO').toUpperCase();
  if (m === 'HOR' || m === 'HORIZONTAL') return 'HOR';
  if (m === 'VERT' || m === 'VERTICAL') return 'VERT';
  return Number(sensorW) >= Number(sensorH) ? 'HOR' : 'VERT';
}
/** 焦距(mm) → 垂直 FOV(度)。 */
export function lensToFov(lens, sensorW, aspect, fitMode) {
  const sw = Number(sensorW) || 36;
  const as = Number(aspect) || 16 / 9;
  const fit = sensorFit(fitMode || 'AUTO', as, 1);
  const sh = fit === 'VERT' ? sw : sw / as;
  const l = Math.max(1, Number(lens) || 35);
  return (2 * Math.atan(sh / 2 / l)) * 180 / Math.PI;
}
/** 垂直 FOV(度) → 焦距(mm)。 */
export function fovToLens(fovDeg, sensorW, aspect, fitMode) {
  const sw = Number(sensorW) || 36;
  const as = Number(aspect) || 16 / 9;
  const fit = sensorFit(fitMode || 'AUTO', as, 1);
  const sh = fit === 'VERT' ? sw : sw / as;
  const f = ((Number(fovDeg) || 42) * Math.PI) / 180;
  return (sh / 2) / Math.tan(f / 2);
}
/** 让高度 h 的主体占到画面 fill 比例所需的相机距离。 */
export function shotDistance(fovDeg, subjectH, fill) {
  const f = ((Number(fovDeg) || 42) * Math.PI) / 180;
  const ratio = Math.max(0.02, Math.min(1, Number(fill) || 0.4));
  return ((Number(subjectH) || 1.75) / ratio / 2) / Math.tan(f / 2);
}
/** 反算：距离 dist 时主体占画面高度的比例。 */
export function subjectFillRatio(fovDeg, subjectH, dist) {
  const f = ((Number(fovDeg) || 42) * Math.PI) / 180;
  const frameH = 2 * Math.max(0.01, Number(dist) || 1) * Math.tan(f / 2);
  return (Number(subjectH) || 1.75) / frameH;
}

export function radiusToDist(fovDeg, radius) {
  return (Number(radius) || 1) / Math.tan(((Number(fovDeg) || 42) * Math.PI / 180) / 2);
}

/** 物体局部轴（随 rotY 旋转）。 */
export function objectAxes(ob) {
  const rx = Number(ob && ob.rx) || 0;
  const ry = Number(ob && ob.rotY) || 0;
  const rz = Number(ob && ob.rz) || 0;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  // 必须与 directorMat4ModelEuler 完全同序：R = Ry * Rx * Rz。
  // 矩阵三列就是物体自身的 X/Y/Z 轴（这里不带 scale，保持单位方向）。
  return {
    x: vNorm(v3(cy * cz + sy * sx * sz, cx * sz, -sy * cz + cy * sx * sz)),
    y: vNorm(v3(-cy * sz + sy * sx * cz, cx * cz, sy * sz + cy * sx * cz)),
    z: vNorm(v3(sy * cx, -sx, cy * cx)),
  };
}
/** 机位画幅四角（世界坐标）：左上/右上/右下/左下。 */
export function cameraFrameWorld(cam, aspect, dist) {
  const fwd = vNorm(vSub(cam.target, cam.pos));
  const right = vNorm(vCross(fwd, cameraUp(cam)));
  const up = vNorm(vCross(right, fwd));
  const f = ((Number(cam.fov) || 42) * Math.PI) / 180;
  const d = Math.max(0.1, Number(dist) || 1);
  const hh = Math.tan(f / 2) * d;
  const hw = hh * Math.max(0.1, Number(aspect) || 16 / 9);
  const c = vAdd(cam.pos, vMul(fwd, d));
  return [
    vAdd(vAdd(c, vMul(right, -hw)), vMul(up, hh)),
    vAdd(vAdd(c, vMul(right, hw)), vMul(up, hh)),
    vAdd(vAdd(c, vMul(right, hw)), vMul(up, -hh)),
    vAdd(vAdd(c, vMul(right, -hw)), vMul(up, -hh)),
  ];
}
/** 按骨骼名匹配下标（忽略 mixamorig: 前缀，找不到返回 -1）。 */
function matchBone(bones, kw) {
  if (!Array.isArray(bones)) return -1;
  const want = shortBoneName(kw).toLowerCase();
  for (let i = 0; i < bones.length; i++) if (shortBoneName(bones[i].name).toLowerCase() === want) return i;
  for (let i = 0; i < bones.length; i++) if (shortBoneName(bones[i].name).toLowerCase().endsWith(want)) return i;
  return -1;
}
/**
 * 通用人形骨架映射：把任意模型的骨骼名归一化到标准语义关节。
 * 覆盖 Mixamo / VRM(0.x,1.0) / Daz-Genesis / MakeHuman / Unreal / Blender(.L/.R) / 裸名。
 * 返回 { semantic: nodeIdx } —— 动作只以语义关节表达，因此同一动作可套到任意人形模型。
 */
const CANON_BONES = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];
/** 各骨架上常见的别名（key 为语义名，值为可接受的正则片段）。 */
const RIG_ALIASES = {
  Hips: ['hips', 'hip', 'pelvis'],
  Spine: ['spine', 'spine1', 'abdomen', 'abdomenlower', 'lowerback'],
  Chest: ['chest', 'spine2', 'upperchest', 'torso', 'abdomenupper'],
  Neck: ['neck', 'necklower'],
  Head: ['head', 'skull'],
  LeftShoulder: ['lshoulder', 'lcollar', 'lclavicle'], LeftArm: ['larm', 'lshldr', 'lupperarm'], LeftForeArm: ['lforearm', 'llowerarm', 'lelbow'], LeftHand: ['lhand', 'lwrist'],
  RightShoulder: ['rshoulder', 'rcollar', 'rclavicle'], RightArm: ['rarm', 'rshldr', 'rupperarm'], RightForeArm: ['rforearm', 'rlowerarm', 'relbow'], RightHand: ['rhand', 'rwrist'],
  LeftUpLeg: ['lupleg', 'lthigh'], LeftLeg: ['lleg', 'lshin'], LeftFoot: ['lfoot'], LeftToeBase: ['ltoe'],
  RightUpLeg: ['rupleg', 'rthigh'], RightLeg: ['rleg', 'rshin'], RightFoot: ['rfoot'], RightToeBase: ['rtoe'],
};
/** 骨骼名归一化：去前缀、去分隔符、小写、统一左右（_.L / _L / .Left / left）。 */
function canonBoneName(name) {
  let n = String(name || '');
  n = n.replace(/^mixamorig:?/i, '');
  n = n.replace(/^bip_?\d*_?/i, '');
  n = n.toLowerCase();
  // 统一左右标记：把 left/right、_l/_r、.l/.r、-l/-r、l_/r_ 统一成前缀 l/r
  let side = '';
  if (/(lef|^l[._\-\s]|_l$|\.l$|\bl$)/.test(n)) side = 'l';
  else if (/(righ|^r[._\-\s]|_r$|\.r$|\br$)/.test(n)) side = 'r';
  // 去掉所有分隔符与左右词
  n = n.replace(/[\.\-_\s]/g, '').replace(/^(left|right)/, '');
  n = n.replace(/(left|right)$/, '');
  // 语义归一：upperleg/thigh → upleg；lowerleg/shin/calf → leg；upperarm → arm；lowerarm/forearm → forearm
  n = n.replace(/upperleg/g, 'upleg').replace(/thigh/g, 'upleg');
  n = n.replace(/lowerleg/g, 'leg').replace(/shin/g, 'leg').replace(/calf/g, 'leg');
  n = n.replace(/upperarm/g, 'arm');
  n = n.replace(/lowerarm/g, 'forearm');
  n = n.replace(/clavicle/g, 'shoulder').replace(/collar/g, 'shoulder').replace(/shldr/g, 'shoulder');
  n = n.replace(/toes|toebase/g, 'toe');
  n = n.replace(/pelvis/g, 'hips');
  return side + n;
}
/** 把任意骨架映射到标准语义关节；返回 { semantic: nodeIdx, coverage, missing }。 */
export function autoRigMap(asset) {
  const bones = (asset && asset.bones) || [];
  const nodes = (asset && asset.nodes) || [];
  const byCanon = new Map();
  for (const b of bones) {
    const c = canonBoneName(b.name);
    if (!byCanon.has(c)) byCanon.set(c, b.nodeIdx);
  }
  const semantic = {};
  for (const [sem, aliases] of Object.entries(RIG_ALIASES)) {
    let nodeIdx = -1;
    for (const al of aliases) {
      for (const [c, ni] of byCanon) {
        if (c === al) { nodeIdx = ni; break; }
      }
      if (nodeIdx >= 0) break;
    }
    if (nodeIdx < 0) {
      // 二次匹配：包含关系（处理 leftarm_01 之类的变体）
      for (const al of aliases) {
        for (const [c, ni] of byCanon) {
          if (c.includes(al)) { nodeIdx = ni; break; }
        }
        if (nodeIdx >= 0) break;
      }
    }
    if (nodeIdx >= 0) semantic[sem] = nodeIdx;
  }
  const total = CANON_BONES.length;
  const got = Object.keys(semantic).length;
  return {
    semantic,
    coverage: got / total,
    missing: CANON_BONES.filter((k) => !(k in semantic)),
    total: nodes.length,
  };
}
/** 读取资产某节点的 rest 局部旋转四元数。 */
export function restQuatOf(asset, nodeIdx) {
  const n = (asset && asset.nodes && asset.nodes[nodeIdx]) || null;
  if (!n || !n.r) return [0, 0, 0, 1];
  return [Number(n.r[0]) || 0, Number(n.r[1]) || 0, Number(n.r[2]) || 0, Number(n.r[3]) || 1];
}
/** 默认场景（新建预演时）。 */
export function directorDefaultScene(title) {
  const t = String(title || '预演场景');
  return {
    version: 2,
    title: t,
    objects: [
      // 与资产库同一份资产（xbot 关节人偶）：真实网格 + 骨骼，不是程序化面片
      { id: 'obj_actor_1', name: '男性 · 标准', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: v3(0, 0, 0), rotY: 0, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '' },
      { id: 'obj_prop_1', name: '木箱', kind: 'geom', preset: 'box', pos: v3(2.2, 0, -1.4), rotY: 0.4, scale: v3(0.9, 0.9, 0.9), visible: true, color: '' },
    ],
    cameras: [{ id: 'cam_main', name: '机位1', pos: v3(0, 1.6, 3.6), target: v3(0, 1, 0), fov: 42, roll: 0, keys: [], pathMode: 'line' }],
    shots: [{ id: 'shot1', cameraId: 'cam_main', start: 0, end: 4 }],
    env: {
      // 默认自然日光棚拍：浅暖天空 + 米色石板地面，避免整片灰黑（用户实测反馈"太灰"）
      preset: 'daylight', bg: '#cfe0ee', ground: '#b9b3a6', grid: true, exposure: 1.18, tonemap: 'agx',
      sky: { zenith: '#8fbcf0', horizon: '#e8f1f8', ground: '#b9b3a6' },
      guides: { heightRef: true, path: true, names: true, cameraFrame: true },
    },
    lights: [
      // 太阳：暖白直射；天光：冷蓝补光（自然日光的两段式光照）
      { id: 'key', dir: vNorm(v3(0.38, -0.78, 0.50)), color: '#fff4e2', intensity: 1.85 },
      { id: 'fill', dir: vNorm(v3(-0.42, -0.28, -0.62)), color: '#cfe0ff', intensity: 0.62 },
    ],
    activeCameraId: 'cam_main', shot: { duration: 4 }, playT: 0,
  };
}

/** 人偶面片：按体型预设与姿态生成胶囊肢体（低面数、圆滑）。 */
function actorFaces(ob) {
  const preset = ACTOR_PRESETS.find((p) => p.id === (ob.preset || 'male_standard')) || ACTOR_PRESETS[0];
  const H = Number(preset.h) || 1.7;
  // skeletonOf 的偏移/长度/半径都是「单位身高」尺寸 → 整体乘 H 得到真实尺寸
  const base = skeletonOf(1, preset);
  const bones = {};
  for (const [k, v] of Object.entries(base)) {
    bones[k] = {
      parent: v.parent,
      off: [(v.off[0] || 0) * H, (v.off[1] || 0) * H, (v.off[2] || 0) * H],
      rest: v.rest || [0, 0, 0],
      len: v.len ? v.len * H : 0,
      ball: v.ball ? v.ball * H : 0,
      r0: v.r0 ? v.r0 * H : 0,
      r1: v.r1 ? v.r1 * H : 0,
    };
  }
  const poseBones = (() => {
    if (ob.pose) {
      const p = POSE_PRESETS.find((x) => x.id === ob.pose);
      if (p) return p.bones || {};
    }
    return {};
  })();
  const world = {};
  const resolve = (name) => {
    if (world[name]) return world[name];
    const b = bones[name];
    if (!b) { world[name] = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: v3(0, 0, 0) }; return world[name]; }
    const parent = b.parent ? resolve(b.parent) : { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: v3(0, 0, 0) };
    const pr = (poseBones[name] || [0, 0, 0]);
    const m = mul3(parent.m, mul3(rot3(pr[0], pr[1], pr[2]), rot3(b.rest[0], b.rest[1], b.rest[2])));
    const off = apply3(parent.m, v3(b.off[0], b.off[1], b.off[2]));
    world[name] = { m, p: vAdd(parent.p, off) };
    return world[name];
  };
  const faces = [];
  for (const name of Object.keys(bones)) {
    const b = bones[name];
    const w = resolve(name);
    if (b.len > 0) {
      const tip = vAdd(w.p, apply3(w.m, v3(0, b.len, 0)));
      capsuleBetween(w.p, tip, b.r0 || 0.03 * H, b.r1 || 0.025 * H, 8).forEach((f) => faces.push(f));
      if (b.ball > 0) {
        const c = vAdd(tip, apply3(w.m, v3(0, b.ball * 0.6, 0)));
        faces.push(...directorSphereFaces(c.x, c.y, c.z, b.ball, 8));
      }
    } else if (b.ball > 0) {
      const c = vAdd(w.p, apply3(w.m, v3(0, b.ball * 0.9, 0)));
      faces.push(...directorSphereFaces(c.x, c.y, c.z, b.ball, 10));
    }
  }
  // 根骨（hips）补一个骨盆盒，避免腰段断裂
  {
    const w = resolve('hips');
    const c = vAdd(w.p, apply3(w.m, v3(0, 0.02 * H, 0)));
    faces.push(...directorSphereFaces(c.x, c.y, c.z, 0.085 * H, 8));
  }
  const ry = Number(ob.rotY) || 0;
  const c0 = Math.cos(ry), s0 = Math.sin(ry);
  const scv = ob.scale || { x: 1, y: 1, z: 1 };
  const kx = Number(scv.x) || 1, ky = Number(scv.y) || 1, kz = Number(scv.z) || 1;
  const pos = ob.pos || v3(0, 0, 0);
  // 落地修正：脚底球会略微穿地，整体上移到 minY = 0
  let minY = Infinity;
  for (const f of faces) for (const p of f.v) if (p.y < minY) minY = p.y;
  const lift = Number.isFinite(minY) ? -minY : 0;
  return faces.map((f) => ({
    v: f.v.map((p) => v3(
      pos.x + (p.x * kx) * c0 + (p.z * kz) * s0,
      pos.y + (p.y + lift) * ky,
      pos.z - (p.x * kx) * s0 + (p.z * kz) * c0,
    )),
    shade: f.shade,
  }));
}

/**
 * 物体的面（CPU 拾取 / Canvas2D 回退渲染用）。
 *  - geom：按 preset 生成单位图元 → 缩放/旋转/平移
 *  - model：有 glTF 资产 → 用蒙皮后的三角面；否则用包围盒代理
 */
/** ACTOR_PRESETS 的 id → 关节人偶的体型 typeId（BODY_SHAPE_OF 的键）。 */
export function actorTypeIdOf(presetId) {
  const id = String(presetId || '');
  if (BODY_SHAPE_OF[id]) return id;
  // 资产库用 male_ / female_ 前缀，体型表用 m_ / f_ 前缀
  const m = id.match(/^(male|female)_(.+)$/);
  if (m) {
    const t = (m[1] === 'male' ? 'm_' : 'f_') + m[2];
    if (BODY_SHAPE_OF[t]) return t;
  }
  return 'm_standard';
}
/**
 * 物体锚点（标签/构图用）：**O(1) 解析计算，绝不生成网格**。
 * 历史事故：早期版本在这里调用 directorObjectFaces()，单个模型要蒙皮 4.9 万三角形 ≈ 77ms，
 * 指针每移动一次都算 → 拖动/缩放卡死、gizmo 跟手错位（"缩放乱跳"）。性能敏感路径禁止走 face 生成。
 */
export function directorObjectAnchor(ob) {
  if (!ob || !ob.pos) return { top: 0, center: v3(0, 0, 0) };
  const px = Number(ob.pos.x) || 0, py = Number(ob.pos.y) || 0, pz = Number(ob.pos.z) || 0;
  const sc = ob.scale || { x: 1, y: 1, z: 1 };
  const sy = (Number(sc.y) || 1) * (Number(ob.s) || 1);
  let top = py + (Number(ob.h) || 1.7) * sy;   // 模型/人偶：按设定身高
  if (ob.kind === 'geom' || ob.kind === 'obj' || !ob.kind) {
    const preset = String(ob.preset || 'box');
    const unitH = preset === 'plane' || preset === 'disc' ? 0.01
      : preset === 'ancient_house' ? 1.34      // 墙身 1 + 屋顶 0.34
      : preset === 'ancient_stall' ? 0.84      // 台面+遮棚
      : preset === 'stone_step' ? 0.3
      : 1;                                     // 其余单位图元高度 1
    top = py + unitH * sy;
  }
  // 朝向只影响平面轮廓，标签用轴对齐包围盒中心即可（不引入旋转误差）
  return { top, center: v3(px, top, pz) };
}
/** 物体的面（CPU 拾取 / Canvas2D 回退渲染用）：geom 按 preset、model 用蒙皮三角面。性能敏感路径请勿调用。 */
export function directorObjectFaces(ob) {
  if (!ob || !ob.pos) return [];
  if (ob.visible === false) return [];   // 隐藏对象不产生面片（拾取/渲染都不该命中）
  if (ob.kind === 'actor') {
    // 有 glTF 人偶资产时优先用真实网格（与视口 GL 渲染一致，避免"木头人"观感）
    const asset = gltfAssetOf('xbot');
    if (asset && asset.positions) {
      const presetId = String(ob.preset || 'male_standard');
      const typeId = actorTypeIdOf(presetId);
      const h = Number(ob.h) || (ACTOR_PRESETS.find((p) => p.id === presetId) || {}).h || 1.78;
      const sk = skinModel(asset, ob.clip || '', Number(ob.animTime) || 0, null, null,
        Object.assign({}, bodyShapeOf(typeId), ob.bonePose ? { bonePose: ob.bonePose } : {}, ob.poseId ? { poseId: ob.poseId } : {}, ob.skinning ? { skinning: ob.skinning } : {}, ob.ik ? { ik: ob.ik } : {}, ob.constraints ? { constraints: ob.constraints } : {}, ob.clips ? { clips: ob.clips } : {}));
      const scale = (Number(asset.rawHeight) > 0 ? h / asset.rawHeight : 1) * (Number(ob.s) || 1);
      const ry = Number(ob.rotY) || 0, c0 = Math.cos(ry), s0 = Math.sin(ry);
      const idx = asset.indices || [];
      const P = sk.pos;
      const out = [];
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], d = idx[t + 2];
        const put = (i2) => {
          const x = P[i2 * 3] * scale, y = P[i2 * 3 + 1] * scale, z = P[i2 * 3 + 2] * scale;
          return v3(ob.pos.x + x * c0 + z * s0, ob.pos.y + y, ob.pos.z - x * s0 + z * c0);
        };
        out.push({ v: [put(a), put(b), put(d)] });
      }
      if (out.length) return out;
    }
    return actorFaces(ob);
  }
  const sc = ob.scale || { x: 1, y: 1, z: 1 };
  const s = Number(ob.s) || 1;
  const sx = s * (Number(sc.x) || 1), sy = s * (Number(sc.y) || 1), sz = s * (Number(sc.z) || 1);
  const ry = Number(ob.rotY) || 0;
  const c = Math.cos(ry), sn = Math.sin(ry);
  const xf = (p) => v3(
    ob.pos.x + (p.x * sx) * c + (p.z * sz) * sn,
    ob.pos.y + p.y * sy,
    ob.pos.z - (p.x * sx) * sn + (p.z * sz) * c,
  );
  if (ob.kind === 'obj' && Array.isArray(ob.objFaces)) {
    return ob.objFaces.map((f) => ({ v: (f.v || []).map(xf), shade: f.shade }));
  }
  if (ob.kind === 'model') {
    const asset = gltfAssetOf(ob.assetId);
    if (asset && asset.positions) {
      const shape = Object.assign({}, ob.typeId ? bodyShapeOf(ob.typeId) : {},
        ob.bonePose ? { bonePose: ob.bonePose } : {}, ob.poseId ? { poseId: ob.poseId } : {},
        ob.poseBlend ? { poseBlend: ob.poseBlend } : {}, ob.skinning ? { skinning: ob.skinning } : {},
        ob.ik ? { ik: ob.ik } : {}, ob.constraints ? { constraints: ob.constraints } : {}, ob.clips ? { clips: ob.clips } : {});
      const sk = skinModel(asset, ob.clip || '', Number(ob.animTime) || 0, null, null, shape);
      const scale = (Number(asset.rawHeight) > 0 ? (Number(ob.h) || 1.78) / asset.rawHeight : 1);
      const out = [];
      const idx = asset.indices || [];
      const P = sk.pos;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], d = idx[t + 2];
        out.push({ v: [
          v3(ob.pos.x + P[a * 3] * scale, ob.pos.y + P[a * 3 + 1] * scale, ob.pos.z + P[a * 3 + 2] * scale),
          v3(ob.pos.x + P[b * 3] * scale, ob.pos.y + P[b * 3 + 1] * scale, ob.pos.z + P[b * 3 + 2] * scale),
          v3(ob.pos.x + P[d * 3] * scale, ob.pos.y + P[d * 3 + 1] * scale, ob.pos.z + P[d * 3 + 2] * scale),
        ] });
      }
      return out;
    }
    const hgt = Number(ob.h) || 1.78, w = hgt * 0.28;
    return directorBoxFaces(0, hgt / 2, 0, w, hgt, w * 0.6).map((f) => ({ v: f.v.map(xf), shade: f.shade }));
  }
  const preset = String(ob.preset || 'box');
  let local;
  if (preset === 'sphere') local = directorSphereFaces(0, 0.5, 0, 0.5);
  else if (preset === 'cylinder') local = directorCylinderFaces(0, 0.5, 0, 0.5, 1);
  else if (preset === 'cone') local = directorConeFaces(0, 0, 0, 0.5, 1);
  else if (preset === 'plane') local = directorBoxFaces(0, 0.005, 0, 1, 0.01, 1);
  else if (preset === 'capsule') local = directorCapsuleFaces(0, 0.5, 0, 0.25, 0.5);
  else if (preset === 'torus') local = directorTorusFaces(0, 0.5, 0, 0.35, 0.15);
  else if (preset === 'pyramid') local = directorPyramidFaces(0, 0, 0, 1, 1, 1);
  else if (preset === 'disc') local = directorDiskFaces(0, 0.01, 0, 0.5);
  else if (preset === 'arc') local = directorHalfArcFaces(0, 0.5, 0, 0.5, 0.1);
  else if (preset === 'half_cylinder') local = directorHalfCylinderFaces(0, 0.5, 0, 0.5, 1);
  else if (preset === 'ancient_house') local = ancientHouseFaces(0, 0, 0, 1, 1, 1, 0.34);
  else if (preset === 'ancient_stall') local = ancientStallFaces(0, 0, 0, 1, 1, 1);
  else if (preset === 'stone_step') local = directorBoxFaces(0, 0.15, 0, 1, 0.3, 1);
  else local = directorBoxFaces(0, 0.5, 0, 1, 1, 1);
  return local.map((f) => ({ v: f.v.map(xf), shade: f.shade }));
}

/**
 * 古代建筑（低面数预演体块）：下段墙身 + 上段浅凹进（浅口凹凸）+ 双坡屋顶。
 * 尺寸 1×1×1 归一，由对象的 scale 控制宽/高/深；roofH 为屋顶高度占比。
 */
export function ancientHouseFaces(cx, baseY, cz, w, h, d, roofH) {
  const faces = [];
  const y0 = baseY;
  const y1 = baseY + h * 0.62;          // 一层檐口
  const y2 = baseY + h;                 // 墙顶
  const rh = Math.max(0.05, Number(roofH) || 0.34) * h;
  const inset = Math.min(w, d) * 0.07;  // 浅凹进量（浅口凹凸）
  const pushBox = (px, py, pz, sx, sy, sz, shade) => {
    const f = directorBoxFaces(px, py, pz, sx, sy, sz);
    for (const ff of f) faces.push({ v: ff.v, shade: (ff.shade || 0) + (shade || 0) });
  };
  // 一层墙身（略宽） + 二层（内收，形成浅口凹凸与腰檐）
  pushBox(cx, y0 + (y1 - y0) / 2, cz, w, y1 - y0, d, 0);
  pushBox(cx, y1 + (y2 - y1) / 2, cz, Math.max(0.2, w - inset * 2), y2 - y1, Math.max(0.2, d - inset * 2), 0.05);
  // 腰檐（出挑薄板）
  pushBox(cx, y1, cz, w + inset * 1.2, Math.max(0.04, h * 0.03), d + inset * 1.2, 0.08);
  // 双坡屋顶：屋脊沿 X 轴，两条坡面 + 两端山墙三角
  const hw = w / 2 + inset * 0.8, hd = d / 2 + inset * 0.8;
  const ridgeY = y2 + rh, ridgeZ = 0;
  const eaveL = v3(cx - hw, y2, cz - hd), eaveR = v3(cx + hw, y2, cz - hd);
  const eaveL2 = v3(cx - hw, y2, cz + hd), eaveR2 = v3(cx + hw, y2, cz + hd);
  const ridgeA = v3(cx - hw, ridgeY, cz + ridgeZ), ridgeB = v3(cx + hw, ridgeY, cz + ridgeZ);
  // 前后两坡（各两块四边形，法线朝外）
  faces.push({ v: [eaveL, eaveR, ridgeB, ridgeA], shade: 0.22 });
  faces.push({ v: [eaveR2, eaveL2, ridgeA, ridgeB], shade: 0.18 });
  // 山墙三角
  faces.push({ v: [eaveR, eaveR2, ridgeB], shade: 0.10 });
  faces.push({ v: [eaveL2, eaveL, ridgeA], shade: 0.10 });
  return faces;
}

/** 古代摊位（低面数）：台面 + 四腿 + 顶部斜面遮棚（坡顶）。 */
export function ancientStallFaces(cx, baseY, cz, w, h, d) {
  const faces = [];
  const pushBox = (px, py, pz, sx, sy, sz, shade) => {
    const f = directorBoxFaces(px, py, pz, sx, sy, sz);
    for (const ff of f) faces.push({ v: ff.v, shade: (ff.shade || 0) + (shade || 0) });
  };
  const tableY = baseY + h * 0.46;
  pushBox(cx, tableY, cz, w, Math.max(0.04, h * 0.06), d, 0);        // 台面
  const lx = w * 0.42, lz = d * 0.42, legH = tableY - baseY;
  // 注意：循环变量不能叫 sx/sz —— 会覆盖 pushBox 的尺寸参数（历史 bug：桌腿错位、桌面浮空）
  for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
    pushBox(cx + dx * lx, baseY + legH / 2, cz + dz * lz, w * 0.05, legH, d * 0.05, -0.04);
  }
  // 坡顶遮棚（两侧斜下）：下沿压在台面上方约 1/4 身高处，视觉上"罩住摊位"
  const topY = baseY + h * 0.74, hw = w / 2, hd = d / 2;
  const ridgeY = topY + h * 0.10;
  const a = v3(cx - hw, topY, cz - hd), b = v3(cx + hw, topY, cz - hd);
  const c2 = v3(cx - hw, topY, cz + hd), d2 = v3(cx + hw, topY, cz + hd);
  const ra = v3(cx - hw, ridgeY, cz), rb = v3(cx + hw, ridgeY, cz);
  faces.push({ v: [a, b, rb, ra], shade: 0.20 });
  faces.push({ v: [d2, c2, ra, rb], shade: 0.16 });
  faces.push({ v: [b, d2, rb], shade: 0.08 });
  faces.push({ v: [c2, a, ra], shade: 0.08 });
  // 遮棚四角立杆（从台面到棚沿）
  for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
    pushBox(cx + dx * (hw - w * 0.04), (tableY + topY) / 2, cz + dz * (hd - d * 0.06), w * 0.035, Math.max(0.05, topY - tableY), d * 0.035, -0.02);
  }
  return faces;
}

// ============================================================
// GLSL：静态/蒙皮/阴影三套着色器（PBR + AgX + PCF 阴影）
// ============================================================
const DIRECTOR_GL_VS = [
  'attribute vec3 aPosition;',
  'attribute vec3 aNormal;',
  'uniform mat4 uModel;',
  'uniform mat4 uViewProj;',
  'uniform mat3 uNormalMat;',
  'varying vec3 vNormal;',
  'varying vec3 vWorld;',
  'void main() {',
  '  vec4 wp = uModel * vec4(aPosition, 1.0);',
  '  vWorld = wp.xyz;',
  '  vNormal = uNormalMat * aNormal;',
  '  gl_Position = uViewProj * wp;',
  '}',
].join('\n');

const DIRECTOR_SKIN_VS = [
  'attribute vec3 aPosition;',
  'attribute vec3 aNormal;',
  'attribute vec4 aJoints;',
  'attribute vec4 aWeights;',
  'uniform mat4 uModel;',
  'uniform mat4 uViewProj;',
  'uniform mat3 uNormalMat;',
  'uniform mat4 uBones[70];',
  'uniform float uSkinned;',
  'varying vec3 vNormal;',
  'varying vec3 vWorld;',
  'void main() {',
  '  vec4 pos = vec4(aPosition, 1.0);',
  '  vec3 nrm = aNormal;',
  '  if (uSkinned > 0.5) {',
  '    mat4 bm = uBones[int(aJoints.x)] * aWeights.x',
  '      + uBones[int(aJoints.y)] * aWeights.y',
  '      + uBones[int(aJoints.z)] * aWeights.z',
  '      + uBones[int(aJoints.w)] * aWeights.w;',
  '    pos = bm * pos;',
  '    nrm = mat3(bm) * aNormal;',
  '  }',
  '  vec4 wp = uModel * pos;',
  '  vWorld = wp.xyz;',
  '  vNormal = uNormalMat * nrm;',
  '  gl_Position = uViewProj * wp;',
  '}',
].join('\n');

const DIRECTOR_SHADOW_VS = [
  'attribute vec3 aPosition;',
  'attribute vec4 aJoints;',
  'attribute vec4 aWeights;',
  'uniform mat4 uModel;',
  'uniform mat4 uViewProj;',
  'uniform mat4 uBones[70];',
  'uniform float uSkinned;',
  'void main() {',
  '  vec4 pos = vec4(aPosition, 1.0);',
  '  if (uSkinned > 0.5) {',
  '    mat4 bm = uBones[int(aJoints.x)] * aWeights.x',
  '      + uBones[int(aJoints.y)] * aWeights.y',
  '      + uBones[int(aJoints.z)] * aWeights.z',
  '      + uBones[int(aJoints.w)] * aWeights.w;',
  '    pos = bm * pos;',
  '  }',
  '  gl_Position = uViewProj * (uModel * pos);',
  '}',
].join('\n');

const DIRECTOR_SHADOW_FS = [
  'precision mediump float;',
  'void main() { gl_FragColor = vec4(1.0); }',
].join('\n');

// ── 后处理：全屏三角 + 基于深度的景深模糊（CoC）──
export const DIRECTOR_POST_VS = [
  'attribute vec2 aPos;',
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = aPos * 0.5 + 0.5;',
  '  gl_Position = vec4(aPos, 0.0, 1.0);',
  '}',
].join('\n');

export const DIRECTOR_POST_FS = [
  'precision highp float;',
  'varying vec2 vUv;',
  'uniform sampler2D uScene;',
  'uniform sampler2D uDepth;',
  'uniform vec2 uTexel;',
  'uniform vec3 uDof;',      // x=对焦距离 y=景深范围 z=最大模糊半径(px)
  'uniform vec2 uClip;',     // x=near y=far
  'float linearDepth(float d) {',
  '  float z = d * 2.0 - 1.0;',
  '  return (2.0 * uClip.x * uClip.y) / (uClip.y + uClip.x - z * (uClip.y - uClip.x));',
  '}',
  'void main() {',
  '  vec3 base = texture2D(uScene, vUv).rgb;',
  '  float dist = linearDepth(texture2D(uDepth, vUv).r);',
  '  float coc = clamp(abs(dist - uDof.x) / max(0.001, uDof.y), 0.0, 1.0) * uDof.z;',
  '  if (coc < 0.6) { gl_FragColor = vec4(base, 1.0); return; }',
  '  vec3 sum = base;',
  '  float wsum = 1.0;',
  '  for (int i = 0; i < 12; i++) {',
  '    float a = float(i) * 0.5236;',
  '    float t3 = float(i) - 3.0 * floor(float(i) / 3.0);   // i % 3（ES1.00 不支持 %）',
  '    float r = (0.35 + 0.65 * t3 / 2.0);',
  '    vec2 off = vec2(cos(a), sin(a)) * uTexel * coc * r;',
  '    float d2 = linearDepth(texture2D(uDepth, vUv + off).r);',
  '    float coc2 = clamp(abs(d2 - uDof.x) / max(0.001, uDof.y), 0.0, 1.0) * uDof.z;',
  '    float w = (coc2 < 0.6) ? 0.35 : 1.0;',
  '    sum += texture2D(uScene, vUv + off).rgb * w;',
  '    wsum += w;',
  '  }',
  '  gl_FragColor = vec4(sum / wsum, 1.0);',
  '}',
].join('\n');


const DIRECTOR_GL_FS = [
  'precision highp float;',
  'varying vec3 vNormal;',
  'varying vec3 vWorld;',
  'uniform vec3 uColor;',
  'uniform float uRoughness;',
  'uniform float uMetallic;',
  'uniform float uSpecular;',
  'uniform vec3 uCamPos;',
  'uniform vec3 uSkyZenith;',
  'uniform vec3 uSkyHorizon;',
  'uniform vec3 uSkyGround;',
  'uniform vec3 uKeyDir;',
  'uniform vec3 uKeyColor;',
  'uniform float uKeyIntensity;',
  'uniform vec3 uFillDir;',
  'uniform vec3 uFillColor;',
  'uniform float uFillIntensity;',
  'uniform float uExposure;',
  'uniform float uSelected;',
  'uniform float uFlat;',
  'uniform float uAlpha;',
  'uniform float uTonemap;',
  'uniform vec3 uFogColor;',
  'uniform vec3 uFogParams;',   // x=near y=far z=density(0=关)
  'uniform vec3 uCamPosFog;',
  'uniform sampler2D uShadowMap;',
  'uniform mat4 uShadowVP;',
  'uniform vec2 uShadowTexel;',
  'uniform float uShadowOn;',
  'uniform float uShadowBias;',
  'uniform float uShadowRadius;',
  'float shadowFactor(vec3 wp, vec3 n, vec3 l) {',
  '  if (uShadowOn < 0.5) return 1.0;',
  '  float cosT = abs(dot(n, l));',
  '  float slope = clamp((1.0 - cosT) / max(cosT, 0.15), 0.0, 4.0);',
  '  float bias = uShadowBias * (0.4 + slope);',
  '  vec3 P = wp + n * bias * 2.0;',
  '  vec4 sp = uShadowVP * vec4(P, 1.0);',
  '  if (abs(sp.w) < 1e-6) return 1.0;',
  '  vec3 pc = sp.xyz / sp.w;',
  '  if (pc.z > 1.0 || pc.z < -1.0) return 1.0;',
  '  vec2 uv = pc.xy * 0.5 + 0.5;',
  '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;',
  '  float zref = pc.z * 0.5 + 0.5;',
  '  float sum = 0.0;',
  '  for (int y = -1; y <= 1; y++) {',
  '    for (int x = -1; x <= 1; x++) {',
  '      float d = texture2D(uShadowMap, uv + vec2(float(x), float(y)) * uShadowTexel * uShadowRadius).r;',
  '      sum += (zref - bias <= d) ? 1.0 : 0.0;',
  '    }',
  '  }',
  '  return sum / 9.0;',
  '}',
  'float orenNayar(vec3 n, vec3 L, vec3 V, float rough) {',
  '  float s2 = rough * rough;',
  '  float a = 1.0 - 0.5 * (s2 / (s2 + 0.33));',
  '  float b = 0.45 * (s2 / (s2 + 0.09));',
  '  float NL = max(dot(n, L), 0.0);',
  '  float NV = max(dot(n, V), 0.001);',
  '  float t = dot(L, V) - NL * NV;',
  '  t = t > 0.0 ? t / max(NL, NV) : 0.0;',
  '  return NL * (a + b * t);',
  '}',
  'float ggx_D(float NH, float a2) {',
  '  float NH2 = NH * NH;',
  '  float d = (1.0 - NH2) + a2 * NH2;',
  '  return a2 / (3.14159265 * d * d);',
  '}',
  'float ggx_G1(float NX, float a2) {',
  '  return 2.0 / (1.0 + sqrt(1.0 + a2 * (1.0 / max(NX * NX, 1e-4) - 1.0)));',
  '}',
  'vec3 specGGX(vec3 n, vec3 V, vec3 L, float rough, float f0s) {',
  '  float a = max(0.002, rough * rough);',
  '  float a2 = a * a;',
  '  vec3 H = normalize(L + V);',
  '  float NH = max(dot(n, H), 0.0);',
  '  float NV = max(dot(n, V), 0.001);',
  '  float NL = max(dot(n, L), 0.0);',
  '  float VH = max(dot(V, H), 0.0);',
  '  float D = ggx_D(NH, a2);',
  '  float G = ggx_G1(NV, a2) * ggx_G1(NL, a2);',
  '  vec3 F0 = mix(vec3(0.04 * f0s), uColor, uMetallic);',
  '  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VH, 5.0);',
  '  return D * G * F / (4.0 * NV * NL + 0.001) * NL;',
  '}',
  'vec3 skyIrradiance(vec3 n) {',
  '  float up = n.y;',
  '  vec3 c = mix(uSkyGround, uSkyHorizon, smoothstep(-0.25, 0.15, up));',
  '  c = mix(c, uSkyZenith, smoothstep(0.05, 0.75, up));',
  '  return c;',
  '}',
  'vec3 tonemapAgX(vec3 c) {',
  '  const float W = 2.6;',
  '  vec3 x = max(c, vec3(0.0));',
  '  vec3 num = x * (1.0 + x / (W * W));',
  '  vec3 y = num / (1.0 + x);',
  '  y = clamp(y, 0.0, 1.0);',
  '  y = mix(y, y * y * (3.0 - 2.0 * y), 0.18);',
  '  return pow(y, vec3(1.0 / 2.2));',
  '}',
  'void main() {',
  '  vec3 n = normalize(vNormal);',
  '  if (!gl_FrontFacing) n = -n;',
  '  vec3 V = normalize(uCamPos - vWorld);',
  '  vec3 Lk = normalize(-uKeyDir);',
  '  vec3 Lf = normalize(-uFillDir);',
  '  float rough = clamp(uRoughness, 0.02, 1.0);',
  '  float sh = shadowFactor(vWorld, n, Lk);',
  '  float dK = orenNayar(n, Lk, V, rough) * sh;',
  '  float dF = orenNayar(n, Lf, V, rough);',
  '  vec3 diffuseIrr = skyIrradiance(n) * (0.22 + 0.10 * rough)',
  '    + uKeyColor * (dK * uKeyIntensity * 0.55)',
  '    + uFillColor * (dF * uFillIntensity * 0.30);',
  '  vec3 albedo = uColor;',
  '  float kd = 1.0 - uMetallic;',
  '  vec3 col = albedo * diffuseIrr * kd;',
  '  float specMask = (1.0 - uMetallic) * (1.0 - rough * 0.92);',
  '  vec3 specK = specGGX(n, V, Lk, rough, uSpecular) * uKeyColor * uKeyIntensity * sh * 0.55;',
  '  vec3 specF = specGGX(n, V, Lf, rough, uSpecular) * uFillColor * uFillIntensity * 0.18;',
  '  col += (specK + specF) * specMask;',
  '  col *= uExposure;',
  '  if (uFlat > 0.5) {',
  '    gl_FragColor = vec4(uColor, uAlpha);',
  '    return;',
  '  }',
  '  // 距离雾（线性 near→far，可叠加指数密度）',
  '  if (uFogParams.z > 0.0) {',
  '    float fd = length(vWorld - uCamPosFog);',
  '    float kf = clamp((fd - uFogParams.x) / max(0.001, uFogParams.y - uFogParams.x), 0.0, 1.0);',
  '    if (uFogParams.z > 1.0) kf = max(kf, 1.0 - exp(-(fd - uFogParams.x) * (uFogParams.z - 1.0) * 0.02));',
  '    col = mix(col, uFogColor, clamp(kf, 0.0, 1.0));',
  '  }',
  '  if (uSelected > 0.5) col = mix(col, vec3(0.42, 0.62, 1.0), 0.30);',
  '  col = (uTonemap > 0.5) ? tonemapAgX(col) : pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));',
  '  gl_FragColor = vec4(col, uAlpha);',
  '}',
].join('\n');



// ============================================================
// 舞台文档持久化（按项目 id 存 localStorage）
// ============================================================
export const directorDocKey = (pid) => 'dsh-director-stage:' + String(pid || 'default');
/** 用户自建动作（骨骼+姿态编排后保存；出现在「动作」下拉里，与模型自带片段并列）。 */
const userActionsKey = (pid) => 'dsh-director-actions:' + String(pid || 'default');
export function loadUserActions(pid) {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(userActionsKey(pid));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveUserAction(pid, action) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const name = String((action && action.name) || '').trim();
    if (!name) return null;
    const list = loadUserActions(pid).filter((a) => a.name !== name);
    const rec = {
      id: 'ua_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name,
      poseId: action.poseId || null,
      bonePose: action.bonePose && Object.keys(action.bonePose).length ? action.bonePose : null,
      poseAnim: Array.isArray(action.poseAnim) && action.poseAnim.length ? action.poseAnim : null,
      duration: Number(action.duration) || 0,
      createdAt: Date.now(),
    };
    list.push(rec);
    localStorage.setItem(userActionsKey(pid), JSON.stringify(list.slice(-40)));
    return rec;
  } catch { return null; }
}
export function deleteUserAction(pid, id) {
  try {
    if (typeof localStorage === 'undefined') return false;
    const list = loadUserActions(pid).filter((a) => a.id !== id);
    localStorage.setItem(userActionsKey(pid), JSON.stringify(list));
    return true;
  } catch { return false; }
}
/** 把用户动作套到物体上（清掉其它姿态来源，保证结果确定）。 */
export function applyUserAction(ob, action) {
  if (!ob || !action) return ob;
  ob.poseId = action.poseId || null;
  ob.bonePose = action.bonePose ? JSON.parse(JSON.stringify(action.bonePose)) : {};
  ob.poseAnim = Array.isArray(action.poseAnim) ? JSON.parse(JSON.stringify(action.poseAnim)) : [];
  return ob;
}
export function saveStageDoc(pid, scene) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(directorDocKey(pid), JSON.stringify(Object.assign({}, scene, { updatedAt: Date.now() })));
    return true;
  } catch { return false; }
}
/**
 * 场景迁移：旧版布景里的程序化人偶（kind='actor'）升级为真实 glTF 人偶（xbot），
 * 保证历史场景 / AI 生成的场景统一用资产库里的资产，不再出现「简易木头人」。
 */
export function migrateStageScene(scene) {
  if (!scene || !Array.isArray(scene.objects)) return scene;
  let changed = false;
  for (const ob of scene.objects) {
    if (!ob) continue;
    if (ob.kind === 'actor') {
      const typeId = actorTypeIdOf(ob.preset);
      const preset = ACTOR_PRESETS.find((p) => p.id === ob.preset) || null;
      ob.kind = 'model';
      ob.assetId = ob.assetId || 'xbot';
      ob.typeId = ob.typeId || typeId;
      if (!Number(ob.h) || Number(ob.h) <= 1.01) ob.h = (preset && preset.h) || 1.78;
      if (ob.clip === undefined) ob.clip = 'idle';
      if (ob.animTime === undefined) ob.animTime = 0;
      changed = true;
    } else if (ob.kind === 'model') {
      if (!ob.assetId) { ob.assetId = 'xbot'; changed = true; }
      if (!ob.typeId) { ob.typeId = 'm_standard'; changed = true; }
      if (ob.clip === undefined) { ob.clip = 'idle'; changed = true; }
      if (ob.animTime === undefined) { ob.animTime = 0; changed = true; }
    }
  }
  if (changed) scene.migratedAt = Date.now();
  return scene;
}

export function loadStageDoc(pid, title) {
  try {
    if (typeof localStorage === 'undefined') return directorDefaultScene(title);
    const raw = localStorage.getItem(directorDocKey(pid));
    if (!raw) return directorDefaultScene(title);
    const doc = JSON.parse(raw);
    if (!doc || !Array.isArray(doc.objects)) return directorDefaultScene(title);
    if (!Array.isArray(doc.cameras) || !doc.cameras.length) doc.cameras = directorDefaultScene(title).cameras;
    if (!Array.isArray(doc.lights) || !doc.lights.length) doc.lights = directorDefaultScene(title).lights;
    if (!Array.isArray(doc.shots) || !doc.shots.length) doc.shots = [{ id: 'shot1', cameraId: doc.cameras[0].id, start: 0, end: Number((doc.shot && doc.shot.duration) || 4) }];
    if (!doc.env) doc.env = directorDefaultScene(title).env;
    if (!doc.activeCameraId) doc.activeCameraId = doc.cameras[0].id;
    return migrateStageScene(doc);   // 旧场景自动升级到真实人偶资产
  } catch { return directorDefaultScene(title); }
}
export function clearStageDoc(pid) {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(directorDocKey(pid)); return true; }
  catch { return false; }
}

// ============================================================
// 资产库预设：几何体 / 建筑 / 机位 / 环境 / 工作区 / OBJ 导入
// ============================================================
export const GEOMETRY_PRESETS = [
  { id: 'box', zh: '立方体', en: 'Cube' },
  { id: 'sphere', zh: '球体', en: 'Sphere' },
  { id: 'cylinder', zh: '圆柱体', en: 'Cylinder' },
  { id: 'cone', zh: '圆锥体', en: 'Cone' },
  { id: 'pyramid', zh: '四棱锥', en: 'Pyramid' },
  { id: 'torus', zh: '圆环体', en: 'Torus' },
  { id: 'plane', zh: '基础平面', en: 'Plane' },
  { id: 'capsule', zh: '胶囊体', en: 'Capsule' },
  { id: 'disc', zh: '圆盘', en: 'Disc' },
  { id: 'arc', zh: '半圆弧', en: 'Half arc' },
  { id: 'half_cylinder', zh: '半圆柱', en: 'Half cylinder' },
  { id: 'ancient_house', zh: '古建坡屋顶', en: 'Ancient pitched house' },
  { id: 'ancient_stall', zh: '古街摊位', en: 'Ancient street stall' },
  { id: 'stone_step', zh: '石阶/矮台', en: 'Stone step' },
];

/** 建筑模板：build(pos, scale) → 面片数组（供白模布景） */
const bld = (id, zh, en, fn) => ({ id, zh, en, build: fn });
const boxAt = (faces, pos, s, cx, cy, cz, sx, sy, sz, shade) => {
  directorBoxFaces(cx, cy, cz, sx, sy, sz).forEach((f) => {
    faces.push({ v: f.v.map((p) => v3(pos.x + p.x * s, pos.y + p.y * s, pos.z + p.z * s)), shade: (f.shade || 0) + (shade || 0) });
  });
};
export const BUILDING_PRESETS = [
  bld('house_small', '小屋', 'Small house', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 1.4, 0, 4, 2.8, 4);
    boxAt(f, pos, s, 0, 3.1, 0, 4.6, 0.6, 4.6, 0.1);
    return f;
  }),
  bld('house_large', '大宅', 'Large house', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 1.8, 0, 7, 3.6, 6);
    boxAt(f, pos, s, 0, 3.9, 0, 7.6, 0.6, 6.6, 0.12);
    return f;
  }),
  bld('tower', '塔楼', 'Tower', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 4, 0, 3, 8, 3);
    boxAt(f, pos, s, 0, 8.4, 0, 3.8, 0.8, 3.8, 0.14);
    return f;
  }),
  bld('shop', '店铺', 'Shop', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 1.6, 0, 6, 3.2, 4);
    boxAt(f, pos, s, 0, 3.5, 0, 6.6, 0.6, 4.6, 0.1);
    return f;
  }),
  bld('wall', '围墙', 'Wall', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 1.1, 0, 10, 2.2, 0.5);
    return f;
  }),
  bld('gate', '门楼', 'Gate', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, -2.4, 1.6, 0, 1.2, 3.2, 1.2);
    boxAt(f, pos, s, 2.4, 1.6, 0, 1.2, 3.2, 1.2);
    boxAt(f, pos, s, 0, 3.7, 0, 6, 0.8, 1.6, 0.12);
    return f;
  }),
  bld('stairs', '台阶', 'Stairs', (pos, s) => {
    const f = [];
    for (let i = 0; i < 6; i++) boxAt(f, pos, s, 0, 0.18 + i * 0.36, 0, 4, 0.36, 1.2 * (6 - i), 0.02 * i);
    return f;
  }),
  bld('pillar', '立柱', 'Pillar', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 2, 0, 1.2, 4, 1.2);
    boxAt(f, pos, s, 0, 4.2, 0, 1.8, 0.4, 1.8, 0.12);
    return f;
  }),
  bld('bridge', '桥梁', 'Bridge', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 1.6, 0, 12, 0.6, 3);
    boxAt(f, pos, s, -5, 0.8, 0, 1, 1.6, 3);
    boxAt(f, pos, s, 5, 0.8, 0, 1, 1.6, 3);
    return f;
  }),
  bld('shed', '棚屋', 'Shed', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 1.2, 0, 3.2, 2.4, 3.2);
    boxAt(f, pos, s, 0, 2.6, 0, 3.8, 0.4, 3.8, 0.1);
    return f;
  }),
  bld('temple', '庙宇', 'Temple', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, 0, 0.4, 0, 10, 0.8, 8);
    boxAt(f, pos, s, 0, 2.4, 0, 8, 3.2, 6);
    boxAt(f, pos, s, 0, 4.6, 0, 9.6, 0.8, 7.6, 0.12);
    return f;
  }),
  bld('ruin', '废墟', 'Ruin', (pos, s) => {
    const f = [];
    boxAt(f, pos, s, -1.6, 1.1, 0, 2, 2.2, 3);
    boxAt(f, pos, s, 1.8, 0.7, 0.4, 1.6, 1.4, 2.4, -0.08);
    boxAt(f, pos, s, 0, 0.15, 0, 6, 0.3, 4, -0.04);
    return f;
  }),
];

/** 机位预设（即梦口径：一键取景）。place(subject) → {pos, target, fov} */
const cam = (id, zh, en, fov, place) => ({ id, zh, en, fov, place });
const subj = (s) => s || { pos: v3(0, 0, 0), h: 1.78 };
export const CAMERA_PRESETS = [
  cam('current', '当前视角', 'Current view', 42, null),
  cam('front_medium', '正面中景', 'Front medium', 42, (s) => { const o = subj(s); return { pos: v3(o.pos.x, o.pos.y + 1.4, o.pos.z + 4.2), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z) }; }),
  cam('front_close', '正面特写', 'Front close-up', 50, (s) => { const o = subj(s); return { pos: v3(o.pos.x, o.pos.y + 1.55, o.pos.z + 1.5), target: v3(o.pos.x, o.pos.y + 1.45, o.pos.z) }; }),
  cam('front_full', '正面全景', 'Front full', 38, (s) => { const o = subj(s); return { pos: v3(o.pos.x, o.pos.y + 1.3, o.pos.z + 7.5), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z) }; }),
  cam('side_left', '左侧面', 'Left side', 42, (s) => { const o = subj(s); return { pos: v3(o.pos.x - 4.2, o.pos.y + 1.4, o.pos.z), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z) }; }),
  cam('side_right', '右侧面', 'Right side', 42, (s) => { const o = subj(s); return { pos: v3(o.pos.x + 4.2, o.pos.y + 1.4, o.pos.z), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z) }; }),
  cam('three_quarter_l', '左前 3/4', 'Left 3/4', 42, (s) => { const o = subj(s); return { pos: v3(o.pos.x - 3, o.pos.y + 1.6, o.pos.z + 3), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z) }; }),
  cam('three_quarter_r', '右前 3/4', 'Right 3/4', 42, (s) => { const o = subj(s); return { pos: v3(o.pos.x + 3, o.pos.y + 1.6, o.pos.z + 3), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z) }; }),
  cam('back', '背面', 'Back', 42, (s) => { const o = subj(s); return { pos: v3(o.pos.x, o.pos.y + 1.4, o.pos.z - 4.2), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z) }; }),
  cam('overhead', '俯拍', 'Overhead', 46, (s) => { const o = subj(s); return { pos: v3(o.pos.x, o.pos.y + 7, o.pos.z + 1.2), target: v3(o.pos.x, o.pos.y + 0.6, o.pos.z) }; }),
  cam('low_angle', '仰拍', 'Low angle', 48, (s) => { const o = subj(s); return { pos: v3(o.pos.x + 1.2, o.pos.y + 0.5, o.pos.z + 3.4), target: v3(o.pos.x, o.pos.y + 1.5, o.pos.z) }; }),
  cam('over_shoulder', '过肩', 'Over the shoulder', 45, (s) => { const o = subj(s); return { pos: v3(o.pos.x - 0.9, o.pos.y + 1.5, o.pos.z - 2.2), target: v3(o.pos.x, o.pos.y + 1.35, o.pos.z + 2.4) }; }),
  cam('wide_establish', '大全景', 'Establishing wide', 34, (s) => { const o = subj(s); return { pos: v3(o.pos.x + 2, o.pos.y + 3.2, o.pos.z + 12), target: v3(o.pos.x, o.pos.y + 1.2, o.pos.z) }; }),
  cam('bird', '鸟瞰', 'Bird view', 46, (s) => { const o = subj(s); return { pos: v3(o.pos.x + 1.5, o.pos.y + 8.5, o.pos.z + 5), target: v3(o.pos.x, o.pos.y + 0.4, o.pos.z) }; }),
  cam('top_full', '正顶大全', 'Top full', 58, (s) => { const o = subj(s); return { pos: v3(o.pos.x, o.pos.y + 9, o.pos.z + 0.01), target: v3(o.pos.x, o.pos.y, o.pos.z) }; }),
  cam('low_wide', '低角全景', 'Low wide', 44, (s) => { const o = subj(s); return { pos: v3(o.pos.x + 1.6, o.pos.y + 0.45, o.pos.z + 4.6), target: v3(o.pos.x, o.pos.y + 1.2, o.pos.z) }; }),
  cam('dutch', '荷兰角', 'Dutch angle', 44, (s) => { const o = subj(s); return { pos: v3(o.pos.x + 2.4, o.pos.y + 1.7, o.pos.z + 3.2), target: v3(o.pos.x, o.pos.y + 0.95, o.pos.z), roll: 12 }; }),
  cam('top_down', '顶视', 'Top down', 60, (s) => { const o = subj(s); return { pos: v3(o.pos.x, o.pos.y + 9, o.pos.z + 0.01), target: v3(o.pos.x, o.pos.y, o.pos.z) }; }),
];
export function applyCameraPreset(scene, presetId, subjectId) {
  if (!scene) return false;
  const p = CAMERA_PRESETS.find((x) => x.id === presetId);
  if (!p || !p.place) return false;
  const c = (scene.cameras || []).find((x) => x.id === scene.activeCameraId) || (scene.cameras || [])[0];
  if (!c) return false;
  const subject = (scene.objects || []).find((o) => o.id === subjectId) || (scene.objects || [])[0] || null;
  const r = p.place(subject);
  if (!r) return false;
  c.pos = v3(r.pos.x, r.pos.y, r.pos.z);
  c.target = v3(r.target.x, r.target.y, r.target.z);
  c.fov = p.fov;
  c.roll = Number(r.roll) || 0;
  return true;
}

/** 环境预设 */
export const ENV_PRESETS = [
  { id: 'studio', zh: '影棚', en: 'Studio', bg: '#1a1e24', ground: '#2a2f36', grid: true, exposure: 1, space: { zenith: '#cfd8e6', horizon: '#e6e9ee', ground: '#9aa0a8' } },
  { id: 'daylight', zh: '日光', en: 'Daylight', bg: '#cfe4f5', ground: '#9fb0a8', grid: true, exposure: 1.05, space: { zenith: '#9cc6f0', horizon: '#e8f1f8', ground: '#8a9a90' } },
  { id: 'night', zh: '夜景', en: 'Night', bg: '#0b0f15', ground: '#141a22', grid: true, exposure: 0.85, space: { zenith: '#1a2740', horizon: '#2a3550', ground: '#0a0d12' } },
  { id: 'sunset', zh: '黄昏', en: 'Sunset', bg: '#3a1f1c', ground: '#2a1a18', grid: true, exposure: 1, space: { zenith: '#4a3a5a', horizon: '#e08a4a', ground: '#2a1a18' } },
  { id: 'overcast', zh: '阴天', en: 'Overcast', bg: '#dfe2e6', ground: '#b3b8bf', grid: true, exposure: 1.1, space: { zenith: '#c8ced6', horizon: '#e6e9ee', ground: '#aeb4bb' } },
  { id: 'void', zh: '纯黑', en: 'Void', bg: '#000000', ground: '#050505', grid: false, exposure: 1, space: { zenith: '#0a0a0a', horizon: '#111111', ground: '#000000' } },
];
export function applyEnvPreset(scene, presetId) {
  if (!scene) return false;
  const p = ENV_PRESETS.find((x) => x.id === presetId);
  if (!p) return false;
  scene.env = Object.assign({}, scene.env || {}, {
    preset: p.id, bg: p.bg, ground: p.ground, grid: p.grid, exposure: p.exposure, sky: p.space,
  });
  return true;
}

/** 布景工作区（多套场景存档） */
const workspacesKey = (pid) => 'dsh-director-workspaces:' + String(pid || 'default');
export function listWorkspaces(pid) {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(workspacesKey(pid));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export function saveWorkspaces(pid, list) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(workspacesKey(pid), JSON.stringify(Array.isArray(list) ? list : []));
    return true;
  } catch { return false; }
}

/** 骨骼清单（骨架下拉用） */
export function boneListOf(asset) {
  if (!asset || !Array.isArray(asset.bones)) return [];
  return asset.bones.map((b, i) => ({ index: i, name: shortBoneName(b.name) }));
}
/** 景别 → 占比 */
export function shotFillOf(id) {
  const f = SHOT_FILLS.find((x) => x.id === id);
  return f ? f.fill : 0.4;
}

/**
 * 解析 OBJ 文本 → 三角面片（归一化：底部落地、高度 = targetHeight）。
 */
export function parseObjText(text, targetHeight) {
  const RAW = String(text == null ? '' : text);
  if (!RAW.trim()) throw new Error('OBJ 内容为空');
  const MAX_TRIS = 60000;   // 超此面数提示先减面（浏览器里才跑得动）
  const verts = [];
  const faces = [];
  let triCount = 0;
  const lines = RAW.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const parts = t.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      const px = Number(parts[1]), py = Number(parts[2]), pz = Number(parts[3]);
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) throw new Error('OBJ 顶点坐标非法：' + t.slice(0, 40));
      verts.push(v3(px, py, pz));
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const idx = parts.slice(1).map((p) => {
        const n = parseInt(p.split('/')[0], 10);
        return n > 0 ? n - 1 : verts.length + n;
      }).filter((n) => Number.isInteger(n) && n >= 0 && n < verts.length);
      for (let i = 1; i + 1 < idx.length; i++) {
        faces.push({ v: [verts[idx[0]], verts[idx[i]], verts[idx[i + 1]]] });
        triCount++;
      }
    }
  }
  if (!verts.length) throw new Error('OBJ 没有顶点（v 行）');
  if (!faces.length) throw new Error('OBJ 没有三角面（f 行）');
  if (triCount > MAX_TRIS) throw new Error('OBJ 面数过多（' + triCount + '），请先减面到 ' + MAX_TRIS + ' 以内');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const f of faces) for (const p of f.v) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const h = Math.max(1e-6, maxY - minY);
  const k = (Number(targetHeight) || 1.7) / h;
  const out = faces.map((f) => ({
    v: f.v.map((p) => v3((p.x - cx) * k, (p.y - minY) * k, (p.z - cz) * k)),
  }));
  return { faces: out, triCount, verts: verts.length };
}

export function createDirectorGlRenderer(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  let gl = null;
  // 优先 WebGL2：阴影贴图需要深度纹理 + FBO（Blender EEVEE 的 shadow map 管线）
  let gl2 = false;
  try {
    gl = canvas.getContext('webgl2', { antialias: true, depth: true, alpha: false, preserveDrawingBuffer: true });
    if (gl) gl2 = true;
  } catch { gl = null; }
  if (!gl) {
    try {
      gl = canvas.getContext('webgl', { antialias: true, depth: true, alpha: false, preserveDrawingBuffer: true })
        || canvas.getContext('experimental-webgl', { antialias: true, depth: true });
    } catch { gl = null; }
  }
  if (!gl) return null;
  const vs = directorGlCompile(gl, gl.VERTEX_SHADER, DIRECTOR_GL_VS);
  const fs2 = directorGlCompile(gl, gl.FRAGMENT_SHADER, DIRECTOR_GL_FS);
  if (!vs || !fs2) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs2); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const loc = {
    aPosition: gl.getAttribLocation(prog, 'aPosition'),
    aNormal: gl.getAttribLocation(prog, 'aNormal'),
    uModel: gl.getUniformLocation(prog, 'uModel'),
    uViewProj: gl.getUniformLocation(prog, 'uViewProj'),
    uNormalMat: gl.getUniformLocation(prog, 'uNormalMat'),
    uColor: gl.getUniformLocation(prog, 'uColor'),
    uKeyDir: gl.getUniformLocation(prog, 'uKeyDir'),
    uKeyColor: gl.getUniformLocation(prog, 'uKeyColor'),
    uKeyIntensity: gl.getUniformLocation(prog, 'uKeyIntensity'),
    uFillDir: gl.getUniformLocation(prog, 'uFillDir'),
    uFillColor: gl.getUniformLocation(prog, 'uFillColor'),
    uFillIntensity: gl.getUniformLocation(prog, 'uFillIntensity'),
    uExposure: gl.getUniformLocation(prog, 'uExposure'),
    uSelected: gl.getUniformLocation(prog, 'uSelected'),
    uFlat: gl.getUniformLocation(prog, 'uFlat'),
    uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
    uShadowMap: gl.getUniformLocation(prog, 'uShadowMap'),
    uShadowVP: gl.getUniformLocation(prog, 'uShadowVP'),
    uShadowTexel: gl.getUniformLocation(prog, 'uShadowTexel'),
    uShadowOn: gl.getUniformLocation(prog, 'uShadowOn'),
    uShadowBias: gl.getUniformLocation(prog, 'uShadowBias'),
    uShadowRadius: gl.getUniformLocation(prog, 'uShadowRadius'),
    uRoughness: gl.getUniformLocation(prog, 'uRoughness'),
    uMetallic: gl.getUniformLocation(prog, 'uMetallic'),
    uSpecular: gl.getUniformLocation(prog, 'uSpecular'),
    uCamPos: gl.getUniformLocation(prog, 'uCamPos'),
    uSkyZenith: gl.getUniformLocation(prog, 'uSkyZenith'),
    uSkyHorizon: gl.getUniformLocation(prog, 'uSkyHorizon'),
    uSkyGround: gl.getUniformLocation(prog, 'uSkyGround'),
    uTonemap: gl.getUniformLocation(prog, 'uTonemap'),
    uFogColor: gl.getUniformLocation(prog, 'uFogColor'),
    uFogParams: gl.getUniformLocation(prog, 'uFogParams'),
    uCamPosFog: gl.getUniformLocation(prog, 'uCamPosFog'),
  };
  // —— 蒙皮 program（glTF 资产用；和静态 program 共用片元着色器） ——
  const vsSkin = directorGlCompile(gl, gl.VERTEX_SHADER, DIRECTOR_SKIN_VS);
  const progSkin = vsSkin ? gl.createProgram() : null;
  if (progSkin) {
    gl.attachShader(progSkin, vsSkin);
    gl.attachShader(progSkin, fs2);
    gl.linkProgram(progSkin);
  }
  const skinOk = !!(progSkin && gl.getProgramParameter(progSkin, gl.LINK_STATUS));
  const locSkin = skinOk ? {
    aPosition: gl.getAttribLocation(progSkin, 'aPosition'),
    aNormal: gl.getAttribLocation(progSkin, 'aNormal'),
    aJoints: gl.getAttribLocation(progSkin, 'aJoints'),
    aWeights: gl.getAttribLocation(progSkin, 'aWeights'),
    uModel: gl.getUniformLocation(progSkin, 'uModel'),
    uViewProj: gl.getUniformLocation(progSkin, 'uViewProj'),
    uNormalMat: gl.getUniformLocation(progSkin, 'uNormalMat'),
    uBones: gl.getUniformLocation(progSkin, 'uBones[0]'),
    uSkinned: gl.getUniformLocation(progSkin, 'uSkinned'),
    uColor: gl.getUniformLocation(progSkin, 'uColor'),
    uKeyDir: gl.getUniformLocation(progSkin, 'uKeyDir'),
    uKeyColor: gl.getUniformLocation(progSkin, 'uKeyColor'),
    uKeyIntensity: gl.getUniformLocation(progSkin, 'uKeyIntensity'),
    uFillDir: gl.getUniformLocation(progSkin, 'uFillDir'),
    uFillColor: gl.getUniformLocation(progSkin, 'uFillColor'),
    uFillIntensity: gl.getUniformLocation(progSkin, 'uFillIntensity'),
    uExposure: gl.getUniformLocation(progSkin, 'uExposure'),
    uSelected: gl.getUniformLocation(progSkin, 'uSelected'),
    uShadowMap: gl.getUniformLocation(progSkin, 'uShadowMap'),
    uShadowVP: gl.getUniformLocation(progSkin, 'uShadowVP'),
    uShadowTexel: gl.getUniformLocation(progSkin, 'uShadowTexel'),
    uShadowOn: gl.getUniformLocation(progSkin, 'uShadowOn'),
    uShadowBias: gl.getUniformLocation(progSkin, 'uShadowBias'),
    uShadowRadius: gl.getUniformLocation(progSkin, 'uShadowRadius'),
    uRoughness: gl.getUniformLocation(progSkin, 'uRoughness'),
    uMetallic: gl.getUniformLocation(progSkin, 'uMetallic'),
    uSpecular: gl.getUniformLocation(progSkin, 'uSpecular'),
    uCamPos: gl.getUniformLocation(progSkin, 'uCamPos'),
    uSkyZenith: gl.getUniformLocation(progSkin, 'uSkyZenith'),
    uSkyHorizon: gl.getUniformLocation(progSkin, 'uSkyHorizon'),
    uSkyGround: gl.getUniformLocation(progSkin, 'uSkyGround'),
    uTonemap: gl.getUniformLocation(progSkin, 'uTonemap'),
    uFogColor: gl.getUniformLocation(progSkin, 'uFogColor'),
    uFogParams: gl.getUniformLocation(progSkin, 'uFogParams'),
    uCamPosFog: gl.getUniformLocation(progSkin, 'uCamPosFog'),
  } : null;

  // ══ 阴影贴图（Blender EEVEE shadow map 管线）══
  const SHADOW_SIZE = 2048;
  let shadowTex = null, shadowFbo = null, shadowOk = false;
  const vsShadow = directorGlCompile(gl, gl.VERTEX_SHADER, DIRECTOR_SHADOW_VS);
  const fsShadow = directorGlCompile(gl, gl.FRAGMENT_SHADER, DIRECTOR_SHADOW_FS);
  let progShadow = null, locShadow = null;
  if (vsShadow && fsShadow) {
    progShadow = gl.createProgram();
    gl.attachShader(progShadow, vsShadow);
    gl.attachShader(progShadow, fsShadow);
    gl.linkProgram(progShadow);
    if (!gl.getProgramParameter(progShadow, gl.LINK_STATUS)) progShadow = null;
  }
  if (progShadow) {
    locShadow = {
      aPosition: gl.getAttribLocation(progShadow, 'aPosition'),
      aJoints: gl.getAttribLocation(progShadow, 'aJoints'),
      aWeights: gl.getAttribLocation(progShadow, 'aWeights'),
      uModel: gl.getUniformLocation(progShadow, 'uModel'),
      uViewProj: gl.getUniformLocation(progShadow, 'uViewProj'),
      uBones: gl.getUniformLocation(progShadow, 'uBones[0]'),
      uSkinned: gl.getUniformLocation(progShadow, 'uSkinned'),
    };


  }

  // ── 景深后处理资源（WebGL2：颜色纹理 + 深度纹理 FBO）──
  let progPost = null, locPost = null, postFbo = null, postColorTex = null, postDepthTex = null, postQuad = null;
  let postW = 0, postH = 0;
  const vsPostSrc = directorGlCompile(gl, gl.VERTEX_SHADER, DIRECTOR_POST_VS);
  const fsPostSrc = directorGlCompile(gl, gl.FRAGMENT_SHADER, DIRECTOR_POST_FS);
  if (vsPostSrc && fsPostSrc) {
    progPost = gl.createProgram();
    gl.attachShader(progPost, vsPostSrc);
    gl.attachShader(progPost, fsPostSrc);
    gl.linkProgram(progPost);
    if (gl.getProgramParameter(progPost, gl.LINK_STATUS)) {
      locPost = {
        aPos: gl.getAttribLocation(progPost, 'aPos'),
        uScene: gl.getUniformLocation(progPost, 'uScene'),
        uDepth: gl.getUniformLocation(progPost, 'uDepth'),
        uTexel: gl.getUniformLocation(progPost, 'uTexel'),
        uDof: gl.getUniformLocation(progPost, 'uDof'),
        uClip: gl.getUniformLocation(progPost, 'uClip'),
      };
      postQuad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, postQuad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    } else progPost = null;
  }
  const postOk = !!(gl2 && progPost && locPost);
  const ensurePostFbo = (w, h) => {
    if (!postOk) return false;
    if (postFbo && postW === w && postH === h) return true;
    if (postFbo) { gl.deleteFramebuffer(postFbo); postFbo = null; }
    if (postColorTex) { gl.deleteTexture(postColorTex); postColorTex = null; }
    if (postDepthTex) { gl.deleteTexture(postDepthTex); postDepthTex = null; }
    postW = w; postH = h;
    postColorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, postColorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    postDepthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, postDepthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    postFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, postFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, postColorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, postDepthTex, 0);
    const okFbo = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return okFbo;
  };
  /** 跑景深后处理：把 postFbo 的颜色按深度 CoC 模糊后铺回画布。 */
  const runPostPass = (w, h, dof) => {
    if (!postOk) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(progPost);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, postColorTex);
    gl.uniform1i(locPost.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, postDepthTex);
    gl.uniform1i(locPost.uDepth, 1);
    gl.uniform2f(locPost.uTexel, 1 / Math.max(1, w), 1 / Math.max(1, h));
    gl.uniform3f(locPost.uDof, Number(dof.focus) || 5, Number(dof.range) || 4, Number(dof.maxBlur) || 6);
    gl.uniform2f(locPost.uClip, 0.05, 300);
    gl.bindBuffer(gl.ARRAY_BUFFER, postQuad);
    gl.enableVertexAttribArray(locPost.aPos);
    gl.vertexAttribPointer(locPost.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    return true;
  };
  // 深度纹理只在 WebGL2 可用（WebGL1 需扩展，直接降级为无实时阴影）
  if (gl2 && progShadow) {
    shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    shadowOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!shadowOk) { shadowTex = null; shadowFbo = null; }
  }

  /** 光源正交视投影矩阵（贴合场景包围盒）。 */
  const computeShadowVP = (scene) => {
    const lights = scene.lights || [];
    const key = lights[0] || { dir: vNorm(v3(0.4, -0.8, 0.3)) };
    let Ld = key.dir || vNorm(v3(0.4, -0.8, 0.3));
    Ld = vNorm(Ld);
    if (Ld.y > -0.15) Ld = vNorm(v3(Ld.x, -0.6, Ld.z));   // 保证光线向下，否则阴影投不出去
    let minX = -8, maxX = 8, minZ = -8, maxZ = 8, maxY = 4;
    for (const ob of (scene.objects || [])) {
      if (!ob || !ob.pos) continue;
      const h = Number(ob.h) || 1.7;
      minX = Math.min(minX, ob.pos.x - h); maxX = Math.max(maxX, ob.pos.x + h);
      minZ = Math.min(minZ, ob.pos.z - h); maxZ = Math.max(maxZ, ob.pos.z + h);
      maxY = Math.max(maxY, ob.pos.y + h);
    }
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const radius = Math.max(6, Math.hypot(maxX - minX, maxZ - minZ) / 2 + 4, maxY + 2);
    const center = v3(cx, maxY * 0.35, cz);
    const eye = v3(center.x - Ld.x * radius * 2.5, center.y - Ld.y * radius * 2.5, center.z - Ld.z * radius * 2.5);
    const upv = Math.abs(Ld.y) > 0.95 ? v3(0, 0, 1) : v3(0, 1, 0);
    const view = directorMat4View(eye, center, upv);
    const proj = directorMat4Ortho(-radius, radius, -radius, radius, 0.05, radius * 6 + 20);
    return directorMat4Multiply(proj, view);
  };

  /** 阴影 pass：只渲染几何到深度纹理（Blender：light POV 深度图）。 */
  const renderShadowMap = (scene) => {
    if (!shadowOk || !progShadow || !shadowFbo) return null;
    const vp = computeShadowVP(scene);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.colorMask(false, false, false, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.useProgram(progShadow);
    gl.uniformMatrix4fv(locShadow.uViewProj, false, vp);
    for (const ob of (scene.objects || [])) {
      if (!ob || !ob.pos || ob.visible === false) continue;
      if (ob.kind === "model" || ob.kind === "gltf") {
        const asset = gltfAssetOf(ob.assetId);
        if (!asset) continue;
        const poseKey = (ob.poseId || '') + '|' + (Array.isArray(ob.poseAnim) ? ob.poseAnim.map((p) => p.poseId + '@' + p.t).join(',') + '#' + (Number(ob.animTime) || 0).toFixed(3) : '') + '|' + (ob.bonePose ? Object.keys(ob.bonePose).sort().map((bi) => bi + '=' + (ob.bonePose[bi] || []).map((v) => Number(v).toFixed(3)).join(',')).join(';') : '');
        const kk = ob.id + ":" + (ob.clip || "") + ":" + (Number(ob.animTime) || 0).toFixed(3) + ":" + (ob.typeId || "") + ":" + (ob.skinning || "lbs") + ":" + (ob.ik ? JSON.stringify(ob.ik) : "") + ":" + (ob.constraints ? JSON.stringify(ob.constraints) : "") + ":" + poseKey + ":shadowV2";
        let sk = skCache.get(kk);
        if (!sk) {
          sk = skinModel(asset, ob.clip || (asset.animations[0] && asset.animations[0].name), Number(ob.animTime) || 0, null, null, Object.assign({}, ob.typeId ? bodyShapeOf(ob.typeId) : {}, ob.bonePose ? { bonePose: ob.bonePose } : {}, ob.poseId ? { poseId: ob.poseId } : {}, ob.poseBlend ? { poseBlend: ob.poseBlend } : {}, ob.skinning ? { skinning: ob.skinning } : {}, ob.ik ? { ik: ob.ik } : {}, ob.constraints ? { constraints: ob.constraints } : {}, ob.clips ? { clips: ob.clips } : {}));
          if (skCache.size > 40) skCache.clear();
          skCache.set(kk, sk);
        }
        const idx = asset.indices;
        if (!idx || !idx.length) continue;
        const ep = new Float32Array(idx.length * 3);
        for (let t = 0; t < idx.length; t++) {
          const v = idx[t] * 3;
          ep[t * 3] = sk.pos[v]; ep[t * 3 + 1] = sk.pos[v + 1]; ep[t * 3 + 2] = sk.pos[v + 2];
        }
        const scale = (Number(ob.s) || 1) * (Number(asset.rawHeight) > 0 ? (Number(ob.h) || 1.7) / asset.rawHeight : 1);
        const scv = ob.scale || { x: 1, y: 1, z: 1 };
        const model = directorMat4Model(ob.pos, Number(ob.rotY) || 0, v3(scale * (scv.x || 1), scale * (scv.y || 1), scale * (scv.z || 1)));
        gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
        gl.bufferData(gl.ARRAY_BUFFER, ep, gl.DYNAMIC_DRAW);
        if (locShadow.aPosition >= 0) { gl.enableVertexAttribArray(locShadow.aPosition); gl.vertexAttribPointer(locShadow.aPosition, 3, gl.FLOAT, false, 0, 0); }
        if (locShadow.aJoints >= 0) gl.disableVertexAttribArray(locShadow.aJoints);
        if (locShadow.aWeights >= 0) gl.disableVertexAttribArray(locShadow.aWeights);
        gl.uniformMatrix4fv(locShadow.uModel, false, model);
        gl.uniform1f(locShadow.uSkinned, 0);
        gl.drawArrays(gl.TRIANGLES, 0, idx.length);
        continue;
      }
      const faces = directorObjectFaces(ob);
      if (!faces.length) continue;
      const rec = buildMesh(ob.id, faces, ob);
      if (!rec.count) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.vbo);
      if (locShadow.aPosition >= 0) { gl.enableVertexAttribArray(locShadow.aPosition); gl.vertexAttribPointer(locShadow.aPosition, 3, gl.FLOAT, false, 0, 0); }
      if (locShadow.aJoints >= 0) gl.disableVertexAttribArray(locShadow.aJoints);
      if (locShadow.aWeights >= 0) gl.disableVertexAttribArray(locShadow.aWeights);
      gl.uniformMatrix4fv(locShadow.uModel, false, directorMat4Identity());
      gl.uniform1f(locShadow.uSkinned, 0);
      gl.drawArrays(gl.TRIANGLES, 0, rec.count);
    }
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return vp;
  };
  const skCache = new Map();
  const skinCache = new Map();
  const meshCache = new Map();
  const scratch = gl.createBuffer();
  let gridVbo = null, gridCount = 0;
  let disposed = false;
  // 当前帧阴影状态（draw 计算，drawDynamic/drawSkin 切 program 后重设）
  let curShadowVP = null, curShadowOn = 0, curShadowBias = 0.0012;   // 阴影状态
  let curShadowRadius = 2.2;
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  // 关闭背面剔除：第三方资产（Kenney/threemodels 等）三角形绕序并不统一，
  // 一旦剔面就会出现"破面/缺半边"（历史 bug）。双面照明由 shader 的 gl_FrontFacing 兜。
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const buildMesh = (id, faces, ob) => {
    const tris = directorTriangulateFaces(faces);
    const pos = new Float32Array(tris.length * 9);
    const nrm = new Float32Array(tris.length * 9);
    let k = 0;
    for (const tri of tris) {
      const n = directorFaceNormal(tri);
      for (const p of tri) {
        pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
        nrm[k] = n.x; nrm[k + 1] = n.y; nrm[k + 2] = n.z;
        k += 3;
      }
    }
    let rec = meshCache.get(id);
    if (!rec) { rec = { vbo: gl.createBuffer(), nbo: gl.createBuffer(), count: 0, sig: '' }; meshCache.set(id, rec); }
    const t = (ob && ob.pos) || { x: 0, y: 0, z: 0 };
    const sc = (ob && ob.scale) || { x: 1, y: 1, z: 1 };
    const sig = tris.length + '|' + t.x + ',' + t.y + ',' + t.z + '|' + (Number(ob && ob.rotY) || 0) + '|' + sc.x + ',' + sc.y + ',' + sc.z + '|' + (Number(ob && ob.h) || 1) + '|' + String(ob && ob.preset || '');
    if (rec.sig !== sig) {
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.vbo); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.nbo); gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.DYNAMIC_DRAW);
      rec.sig = sig;
    }
    rec.count = tris.length * 3;
    return rec;
  };
  /** 一次性三角形批次（地面/gizmo 用；顶点为世界坐标，法线逐面计算后上传 scratch 缓冲）。 */
  const drawTris = (verts, model, color) => {
    const pos = new Float32Array(verts.length * 9);
    const nrm = new Float32Array(verts.length * 9);
    let j = 0;
    for (const tri of verts) {
      const n = directorFaceNormal(tri);
      for (const p of tri) {
        pos[j] = p.x; pos[j + 1] = p.y; pos[j + 2] = p.z;
        nrm[j] = n.x; nrm[j + 1] = n.y; nrm[j + 2] = n.z;
        j += 3;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(loc.aNormal);
    gl.vertexAttrib3f(loc.aNormal, 0, 1, 0);
    gl.uniformMatrix4fv(loc.uModel, false, model);
    // 必须显式给法线矩阵：默认 mat3 全零 → 法线归零 → 光照为 0 → 地面/网格全黑（历史 bug）
    gl.uniformMatrix3fv(loc.uNormalMat, false, directorMat3NormalFrom(v3(0, 0, 0), 0, v3(1, 1, 1)));
    gl.uniform1f(loc.uSelected, 0);
    gl.uniform3f(loc.uColor, color[0], color[1], color[2]);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length * 3);
  };

  /** 上传一份 glTF 资产（顶点/法线/关节/权重/索引）；按 asset 对象身份缓存。 */
  const uploadSkin = (key, asset) => {
    let rec = skinCache.get(key);
    if (rec) return rec;
    const mk = (data, target) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    rec = {
      pos: mk(asset.positions, gl.ARRAY_BUFFER),
      nrm: mk(asset.normals && asset.normals.length === asset.positions.length ? asset.normals : new Float32Array(asset.positions.length), gl.ARRAY_BUFFER),
      jnt: asset.joints ? mk(asset.joints instanceof Float32Array ? asset.joints : new Float32Array(asset.joints), gl.ARRAY_BUFFER) : null,
      wgt: asset.weights ? mk(asset.weights instanceof Float32Array ? asset.weights : new Float32Array(asset.weights), gl.ARRAY_BUFFER) : null,
      idx: mk(asset.indices instanceof Uint32Array ? new Uint32Array(asset.indices) : new Uint16Array(asset.indices), gl.ELEMENT_ARRAY_BUFFER),
      count: asset.indices.length,
      idxType: asset.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      hasSkin: !!(asset.joints && asset.weights && asset.bones),
    };
    skinCache.set(key, rec);
    return rec;
  };

  /** 绘制一份蒙皮资产；bones 为 boneMatrices() 结果（可为 null = T 姿势）。 */
  const drawSkin = (asset, rec, model, color, viewProj, lights, exposure, selected, bones) => {
    if (!skinOk) return false;
    gl.useProgram(progSkin);
    if (locSkin.uShadowOn) gl.uniform1f(locSkin.uShadowOn, curShadowOn);
    if (locSkin.uShadowVP) gl.uniformMatrix4fv(locSkin.uShadowVP, false, curShadowVP || directorMat4Identity());
    if (locSkin.uShadowTexel) gl.uniform2f(locSkin.uShadowTexel, 1 / SHADOW_SIZE, 1 / SHADOW_SIZE);
    if (locSkin.uShadowBias) gl.uniform1f(locSkin.uShadowBias, curShadowBias);
    if (locSkin.uShadowRadius) gl.uniform1f(locSkin.uShadowRadius, curShadowRadius);
    if (shadowOk && shadowTex && locSkin.uShadowMap) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadowTex); gl.uniform1i(locSkin.uShadowMap, 0); }
    gl.uniformMatrix4fv(locSkin.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(locSkin.uModel, false, model);
    gl.uniformMatrix3fv(locSkin.uNormalMat, false, directorMat3NormalFrom(v3(0, 0, 0), 0, v3(1, 1, 1)));
    gl.uniform3f(locSkin.uColor, color[0], color[1], color[2]);
    gl.uniform3f(locSkin.uKeyDir, lights.kd.x, lights.kd.y, lights.kd.z);
    gl.uniform3f(locSkin.uKeyColor, lights.kc[0], lights.kc[1], lights.kc[2]);
    gl.uniform1f(locSkin.uKeyIntensity, lights.ki);
    gl.uniform3f(locSkin.uFillDir, lights.fd.x, lights.fd.y, lights.fd.z);
    gl.uniform3f(locSkin.uFillColor, lights.fc[0], lights.fc[1], lights.fc[2]);
    gl.uniform1f(locSkin.uFillIntensity, lights.fi);
    gl.uniform1f(locSkin.uExposure, exposure);
    gl.uniform1f(locSkin.uSelected, selected ? 1 : 0);
    if (rec.hasSkin && bones && bones.count) {
      gl.uniform1f(locSkin.uSkinned, 1);
      const arr = new Float32Array(64 * 16);
      arr.set(bones.mats.subarray(0, Math.min(64, bones.count) * 16));
      gl.uniformMatrix4fv(locSkin.uBones, false, arr);
    } else {
      gl.uniform1f(locSkin.uSkinned, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.pos);
    gl.enableVertexAttribArray(locSkin.aPosition);
    gl.vertexAttribPointer(locSkin.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.nrm);
    gl.enableVertexAttribArray(locSkin.aNormal);
    gl.vertexAttribPointer(locSkin.aNormal, 3, gl.FLOAT, false, 0, 0);
    if (rec.jnt) {
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.jnt);
      gl.enableVertexAttribArray(locSkin.aJoints);
      gl.vertexAttribPointer(locSkin.aJoints, 4, gl.FLOAT, false, 0, 0);
    }
    if (rec.wgt) {
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.wgt);
      gl.enableVertexAttribArray(locSkin.aWeights);
      gl.vertexAttribPointer(locSkin.aWeights, 4, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rec.idx);
    gl.drawElements(gl.TRIANGLES, rec.count, rec.idxType, 0);
    return true;
  };
  /**
   * 动态网格绘制（CPU 蒙皮结果用）：每帧把顶点/法线传到 GPU 再画索引。
   * 走静态 program，避免再维护一套蒙皮 shader（更少的出错面）。
   */

  /**
   * 动态网格绘制（CPU 蒙皮结果）：把索引展开成非索引三角形后 drawArrays。
   * 为什么不用 drawElements：元素缓冲在多 program/多对象交替绑定时出现过索引错乱
   * （模型渲染成散点），展开虽然多传一倍顶点，但状态简单、结果确定。
   */
  const dyn = { vbo: gl.createBuffer(), nbo: gl.createBuffer() };
  const drawDynamic = (pos, nrm, idx, model, color, selected, viewProj, lightPack, exposure, style) => {
    if (!pos || !idx || !idx.length) return false;
    const n = idx.length;
    const ep = new Float32Array(n * 3);
    const en = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = idx[i] * 3;
      ep[i * 3] = pos[v]; ep[i * 3 + 1] = pos[v + 1]; ep[i * 3 + 2] = pos[v + 2];
      en[i * 3] = nrm[v]; en[i * 3 + 1] = nrm[v + 1]; en[i * 3 + 2] = nrm[v + 2];
    }
    gl.useProgram(prog);
    if (loc.uShadowOn) gl.uniform1f(loc.uShadowOn, curShadowOn);
    if (loc.uShadowVP) gl.uniformMatrix4fv(loc.uShadowVP, false, curShadowVP || directorMat4Identity());
    if (loc.uShadowTexel) gl.uniform2f(loc.uShadowTexel, 1 / SHADOW_SIZE, 1 / SHADOW_SIZE);
    if (loc.uShadowBias) gl.uniform1f(loc.uShadowBias, curShadowBias);
    if (loc.uShadowRadius) gl.uniform1f(loc.uShadowRadius, curShadowRadius);
    if (shadowOk && shadowTex && loc.uShadowMap) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadowTex); gl.uniform1i(loc.uShadowMap, 0); }
    gl.uniformMatrix4fv(loc.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(loc.uModel, false, model);
    gl.uniformMatrix3fv(loc.uNormalMat, false, directorMat3NormalFrom(v3(0, 0, 0), 0, v3(1, 1, 1)));
    gl.uniform3f(loc.uColor, color[0], color[1], color[2]);
    gl.uniform3f(loc.uKeyDir, lightPack.kd.x, lightPack.kd.y, lightPack.kd.z);
    gl.uniform3f(loc.uKeyColor, lightPack.kc[0], lightPack.kc[1], lightPack.kc[2]);
    gl.uniform1f(loc.uKeyIntensity, lightPack.ki);
    gl.uniform3f(loc.uFillDir, lightPack.fd.x, lightPack.fd.y, lightPack.fd.z);
    gl.uniform3f(loc.uFillColor, lightPack.fc[0], lightPack.fc[1], lightPack.fc[2]);
    gl.uniform1f(loc.uFillIntensity, lightPack.fi);
    gl.uniform1f(loc.uExposure, exposure);
    gl.uniform1f(loc.uSelected, selected ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, dyn.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, ep, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, dyn.nbo);
    gl.bufferData(gl.ARRAY_BUFFER, en, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.aNormal);
    gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);
    const st = style || {};
    gl.uniform1f(loc.uFlat, st.flat ? 1 : 0);
    gl.uniform1f(loc.uAlpha, st.alpha === undefined ? 1 : st.alpha);
    gl.drawArrays(gl.TRIANGLES, 0, n);
    return true;
  };
  const buildGrid = () => {
    const lines = [];
    const G = 10;
    for (let i = -G; i <= G; i++) { lines.push(-G, 0, i, G, 0, i, i, 0, -G, i, 0, G); }
    if (!gridVbo) gridVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gridVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.STATIC_DRAW);
    gridCount = lines.length / 3;
  };
  buildGrid();

  let pixelRatio = 1;
  return {
    kind: 'webgl',
    canvas,
    gl,
    get dofSupported() { return postOk; },
    get shadowSupported() { return !!shadowOk; },
    /** resize(逻辑宽, 逻辑高, 设备像素比)：DPR 只影响后备缓冲，所有像素换算按 CSS 尺寸，绘制与拾取同源。 */
    resize(cssW, cssH, dpr) {
      if (disposed) return;
      pixelRatio = Math.max(0.5, Math.min(4, Number(dpr) || 1));
      canvas.width = Math.max(1, Math.round(cssW * pixelRatio));
      canvas.height = Math.max(1, Math.round(cssH * pixelRatio));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    draw(scene, opts) {
      const o = opts || {};
      const stats = { faces: 0, tris: 0, drawn: 0 };
      if (disposed || !gl || !scene) return stats;
      const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0];
      if (!cam) return stats;
      const env = scene.env || {};
      const w = canvas.width || 1, h = canvas.height || 1;
      // 像素宽度换算一律用 CSS 尺寸：绘制与拾取同源（高 DPI 下不再出现命中偏移、线宽变细）
      const hCss = Math.max(1, h / pixelRatio);
      gl.viewport(0, 0, w, h);
      // ── 阴影 pass（Blender EEVEE：先从光源视角渲染深度图）──
      // 阴影：env.shadowOn === false 时整段跳过（UI「投射阴影」开关）；opts.shadows === false 也可临时关
      const shadowVP = (o.shadows !== false && env.shadowOn !== false) ? renderShadowMap(scene) : null;
      // ── 景深：开启时先把场景画进 FBO，最后按深度做 CoC 模糊铺回画布 ──
      const dof = (env.dof && env.dof.enabled) ? env.dof : null;
      const dofOn = !!(dof && dof.enabled && postOk && ensurePostFbo(w, h));
      curShadowVP = shadowVP;
      curShadowOn = (shadowVP && shadowOk) ? 1 : 0;
      curShadowBias = Number(env.shadowBias) || 0.0012;
      curShadowRadius = Number(env.shadowRadius) || 2.2;
      gl.useProgram(prog);            // 阴影 pass 切过 program，这里必须切回主 program
      gl.bindFramebuffer(gl.FRAMEBUFFER, dofOn ? postFbo : null);
      gl.viewport(0, 0, w, h);
      const bg = directorHexToRgb(env.bg || '#171717');
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);
      const proj = directorMat4Perspective(cam.fov, w / Math.max(1, h), 0.05, 300);
      const viewM = directorMat4View(cam.pos, cam.target, cameraUp(cam));
      const viewProj = directorMat4Multiply(proj, viewM);
      gl.uniformMatrix4fv(loc.uViewProj, false, viewProj);
      const lights = scene.lights || [];
      const key = lights[0] || { dir: vNorm(v3(0.4, -0.8, 0.3)), color: '#fff2d8', intensity: 1 };
      const fill = lights[1] || { dir: vNorm(v3(-0.4, -0.3, -0.6)), color: '#8fa4c8', intensity: 0.4 };
      const kd = key.dir || vNorm(v3(0.4, -0.8, 0.3));
      const fd = fill.dir || vNorm(v3(-0.4, -0.3, -0.6));
      const kc = directorHexToRgb(key.color || '#fff2d8');
      const fc = directorHexToRgb(fill.color || '#8fa4c8');
      gl.uniform3f(loc.uKeyDir, kd.x, kd.y, kd.z);
      gl.uniform3f(loc.uKeyColor, kc[0], kc[1], kc[2]);
      gl.uniform1f(loc.uKeyIntensity, Number(key.intensity) || 1);
      gl.uniform3f(loc.uFillDir, fd.x, fd.y, fd.z);
      gl.uniform3f(loc.uFillColor, fc[0], fc[1], fc[2]);
      gl.uniform1f(loc.uFillIntensity, Number(fill.intensity) || 0.4);
      gl.uniform1f(loc.uExposure, Number(env.exposure) || 1);
      // ── PBR 材质默认值（哑光黏土：roughness=1, metallic=0）──
      const defMat = { roughness: 1, metallic: 0, specular: 0.5 };
      if (loc.uRoughness) gl.uniform1f(loc.uRoughness, defMat.roughness);
      if (loc.uMetallic) gl.uniform1f(loc.uMetallic, defMat.metallic);
      if (loc.uSpecular) gl.uniform1f(loc.uSpecular, defMat.specular);
      if (loc.uCamPos) gl.uniform3f(loc.uCamPos, cam.pos.x, cam.pos.y, cam.pos.z);
      // ── 程序化天空（环境光）：可用 env.sky 覆盖 ──
      const skyCfg = env.sky || {};
      const zc = directorHexToRgb(skyCfg.zenith || '#a8c0dd');
      const hc = directorHexToRgb(skyCfg.horizon || '#d6dde6');
      const gc = directorHexToRgb(skyCfg.ground || '#8f949b');
      if (loc.uSkyZenith) gl.uniform3f(loc.uSkyZenith, zc[0], zc[1], zc[2]);
      if (loc.uSkyHorizon) gl.uniform3f(loc.uSkyHorizon, hc[0], hc[1], hc[2]);
      if (loc.uSkyGround) gl.uniform3f(loc.uSkyGround, gc[0], gc[1], gc[2]);
      if (loc.uTonemap) gl.uniform1f(loc.uTonemap, env.tonemap === 'srgb' ? 0 : 1);
      // 蒙皮 program 同样需要（两套 program 不共享 uniform 值）
      if (locSkin.uRoughness) gl.uniform1f(locSkin.uRoughness, defMat.roughness);
      if (locSkin.uMetallic) gl.uniform1f(locSkin.uMetallic, defMat.metallic);
      if (locSkin.uSpecular) gl.uniform1f(locSkin.uSpecular, defMat.specular);
      if (locSkin.uCamPos) gl.uniform3f(locSkin.uCamPos, cam.pos.x, cam.pos.y, cam.pos.z);
      if (locSkin.uSkyZenith) gl.uniform3f(locSkin.uSkyZenith, zc[0], zc[1], zc[2]);
      if (locSkin.uSkyHorizon) gl.uniform3f(locSkin.uSkyHorizon, hc[0], hc[1], hc[2]);
      if (locSkin.uSkyGround) gl.uniform3f(locSkin.uSkyGround, gc[0], gc[1], gc[2]);
      if (locSkin.uTonemap) gl.uniform1f(locSkin.uTonemap, env.tonemap === 'srgb' ? 0 : 1);
      // ── 距离雾：env.fog = {color, near, far, density} ──
      {
        const fog = env.fog && env.fog.enabled !== false ? env.fog : null;
        const fc = fog ? directorHexToRgb(fog.color || '#aab4c0') : [0, 0, 0];
        const near = fog ? (Number(fog.near) || 0) : 0;
        const far = fog ? (Number(fog.far) || 30) : 0;
        const dens = fog ? (Number(fog.density) || 1) : 0;
        for (const L2 of [loc, locSkin]) {
          if (L2.uFogColor) gl.uniform3f(L2.uFogColor, fc[0], fc[1], fc[2]);
          if (L2.uFogParams) gl.uniform3f(L2.uFogParams, near, far, dens);
          if (L2.uCamPosFog) gl.uniform3f(L2.uCamPosFog, cam.pos.x, cam.pos.y, cam.pos.z);
        }
      }
      // 阴影采样（与阴影 pass 的深度图对应）
      if (loc.uShadowOn) gl.uniform1f(loc.uShadowOn, (shadowVP && shadowOk) ? 1 : 0);
      if (loc.uShadowVP) gl.uniformMatrix4fv(loc.uShadowVP, false, shadowVP || directorMat4Identity());
      if (loc.uShadowTexel) gl.uniform2f(loc.uShadowTexel, 1 / SHADOW_SIZE, 1 / SHADOW_SIZE);
      if (loc.uShadowBias) gl.uniform1f(loc.uShadowBias, Number(env.shadowBias) || 0.0012);
      if (loc.uShadowRadius) gl.uniform1f(loc.uShadowRadius, curShadowRadius);
      if (shadowOk && shadowTex && loc.uShadowMap) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, shadowTex);
        gl.uniform1i(loc.uShadowMap, 0);
      }
      gl.uniform1f(loc.uAlpha, 1);
      // 地面填充：预览不画（opts.renderGround 不为真时跳过）；导出白模时按 env.groundInRender 决定
      if (o.renderGround && env.groundInRender !== false) {
        const gsz = 120;
        const gq = [];
        // 居中且够大：5×5 块 → 覆盖 ±300，远到相机看不到边界（消除地平线断层）
        for (let iz = 0; iz < 5; iz++) {
          for (let ix = 0; ix < 5; ix++) {
            const x0 = (ix - 2) * gsz, x1 = x0 + gsz, z0 = (iz - 2) * gsz, z1 = z0 + gsz;
            gq.push([v3(x0, 0.001, z0), v3(x1, 0.001, z1), v3(x1, 0.001, z0)]);   // 绕序：法线朝上
            gq.push([v3(x0, 0.001, z0), v3(x0, 0.001, z1), v3(x1, 0.001, z1)]);
          }
        }
        const gc = directorHexToRgb(env.ground || '#242424');
        drawTris(gq, directorMat4Identity(), [gc[0], gc[1], gc[2]]);
      }
      // 相机画幅框（BKE_camera_view_frame_ex）：所有机位都画出"能拍到什么"的框 + 视锥
      {
        const drawCamFrame = (cam2) => {
          if (cam2 && cam2.id === scene.activeCameraId) return;   // 正在用的机位不画自己的框
          if (!cam2 || !cam2.pos || !cam2.target) return;
          const camAspect = 16 / 9;
          const corners = cameraFrameWorld(cam2, camAspect, 0.9);
          const segs = [];
          // 画幅矩形四边
          for (let i = 0; i < 4; i++) segs.push([corners[i], corners[(i + 1) % 4]]);
          // 视锥：相机位置连到四角（只画上/下两条边，避免太乱）
          segs.push([cam2.pos, corners[0]]);
          segs.push([cam2.pos, corners[2]]);
          // 相机本体（小三角锥）
          const fwd = vNorm(vSub(cam2.target, cam2.pos));
          const right = vNorm(vCross(fwd, v3(0, 1, 0)));
          const up = vNorm(vCross(right, fwd));
          const tipD = 0.28;
          const bp = vSub(cam2.pos, vMul(fwd, 0.16));
          const p1 = vAdd(bp, vMul(right, 0.09));
          const p2 = vSub(bp, vMul(right, 0.09));
          const p3 = vAdd(bp, vMul(up, 0.09));
          const p4 = vSub(bp, vMul(up, 0.09));
          segs.push([p1, p2], [p2, p4], [p4, p3], [p3, p1]);
          segs.push([cam2.pos, p1], [cam2.pos, p2], [cam2.pos, p3], [cam2.pos, p4]);
          void tipD;
          const buf = new Float32Array(segs.length * 6);
          segs.forEach((sg, i) => {
            buf[i * 6] = sg[0].x; buf[i * 6 + 1] = sg[0].y; buf[i * 6 + 2] = sg[0].z;
            buf[i * 6 + 3] = sg[1].x; buf[i * 6 + 4] = sg[1].y; buf[i * 6 + 5] = sg[1].z;
          });
          gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
          gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc.aPosition);
          gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
          gl.disableVertexAttribArray(loc.aNormal);
          gl.vertexAttrib3f(loc.aNormal, 0, 1, 0);
          gl.uniformMatrix4fv(loc.uModel, false, directorMat4Identity());
          gl.uniformMatrix3fv(loc.uNormalMat, false, directorMat3NormalFrom(v3(0, 0, 0), 0, v3(1, 1, 1)));
          gl.uniform1f(loc.uSelected, 0);
          gl.uniform1f(loc.uExposure, 1);
          gl.uniform3f(loc.uColor, 0.42, 0.72, 0.95);
          gl.drawArrays(gl.LINES, 0, segs.length * 2);
        };
        // 机位画幅框改为「显式开启」才画：默认关闭，避免多机位的大蓝框横穿视口（用户反馈挡视线）
        if (!o.renderOnly && env.guides && env.guides.cameraFrame === true) {
          for (const c2 of (scene.cameras || [])) drawCamFrame(c2);
        }
      }
      // 地面网格（Blender 风格）：暗色细网格 + X 红 / Z 绿 两条主轴线，无地面填充色
      if (env.grid !== false) {
        const drawSegs = (segs, color) => {
          if (!segs.length) return;
          const buf = new Float32Array(segs.length * 6);
          segs.forEach((sg, i) => {
            buf[i * 6] = sg[0].x; buf[i * 6 + 1] = sg[0].y; buf[i * 6 + 2] = sg[0].z;
            buf[i * 6 + 3] = sg[1].x; buf[i * 6 + 4] = sg[1].y; buf[i * 6 + 5] = sg[1].z;
          });
          gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
          gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc.aPosition);
          gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
          gl.disableVertexAttribArray(loc.aNormal);
          gl.vertexAttrib3f(loc.aNormal, 0, 1, 0);
          gl.uniformMatrix4fv(loc.uModel, false, directorMat4Identity());
          gl.uniformMatrix3fv(loc.uNormalMat, false, directorMat3NormalFrom(v3(0, 0, 0), 0, v3(1, 1, 1)));
          gl.uniform1f(loc.uSelected, 0);
          gl.uniform1f(loc.uExposure, 1);
          gl.uniformMatrix4fv(loc.uViewProj, false, viewProj);
          gl.uniform3f(loc.uColor, color[0], color[1], color[2]);
          gl.drawArrays(gl.LINES, 0, segs.length * 2);
        };
        void 0;
        // 连续均匀网格：全幅用同一套格线，每 10 格的主格稍亮；
        // 不再分内圈/外圈（那会形成亮暗边界，看起来就像"网格破了"）
        const minor = [], major = [];
        const G = 30;
        for (let i = -G; i <= G; i++) {
          if (i === 0) continue;
          const sx = [[v3(-G, 0.003, i), v3(G, 0.003, i)]];
          const sz = [[v3(i, 0.003, -G), v3(i, 0.003, G)]];
          if (i % 10 === 0) major.push(...sx, ...sz);
          else minor.push(...sx, ...sz);
        }
        drawSegs(minor, [0.21, 0.23, 0.27]);
        drawSegs(major, [0.29, 0.31, 0.36]);
        // 主轴：X 红 / Z 绿，贯穿全幅
        drawSegs([[v3(-G, 0.004, 0), v3(G, 0.004, 0)]], [0.55, 0.20, 0.22]);
        drawSegs([[v3(0, 0.004, -G), v3(0, 0.004, G)]], [0.22, 0.46, 0.26]);

      }
      // 物体
      const lightPack = { kd, kc, ki: Number(key.intensity) || 1, fd, fc, fi: Number(fill.intensity) || 0.4 };
      (scene.objects || []).forEach((ob) => {
        if (ob.visible === false) return;
        // 真实模型（CPU 蒙皮；关节人偶/建筑等预转换资产）
        if (ob.kind === 'model') {
          if (!ob.pos) return; // 脏数据守卫：缺 pos 直接跳过（reading 'x' 历史事故）
          const asset = gltfAssetOf(ob.assetId);
          if (asset) {
            // 缓存键必须包含「体型 + 骨骼姿态」：姿态一改就得重新蒙皮，否则永远命中旧网格
            const poseKey = (ob.poseId || '') + '|' + (ob.bonePose ? Object.keys(ob.bonePose).sort().map((bi) => bi + '=' + (ob.bonePose[bi] || []).map((v) => Number(v).toFixed(3)).join(',')).join(';') : '');
            const k = ob.id + ':' + (ob.clip || '') + ':' + (Number(ob.animTime) || 0).toFixed(3) + ':' + (ob.typeId || '') + ':' + (ob.skinning || 'lbs') + ':' + (ob.ik ? JSON.stringify(ob.ik) : '') + ':' + (ob.constraints ? JSON.stringify(ob.constraints) : '') + ':' + poseKey;
            let sk = skCache.get(k);
            if (!sk) {
              sk = skinModel(asset, ob.clip || (asset.animations[0] && asset.animations[0].name), Number(ob.animTime) || 0, null, null, Object.assign({}, ob.typeId ? bodyShapeOf(ob.typeId) : {}, ob.bonePose ? { bonePose: ob.bonePose } : {}, ob.poseId ? { poseId: ob.poseId } : {}, ob.poseBlend ? { poseBlend: ob.poseBlend } : {}, ob.skinning ? { skinning: ob.skinning } : {}, ob.ik ? { ik: ob.ik } : {}, ob.constraints ? { constraints: ob.constraints } : {}, ob.clips ? { clips: ob.clips } : {}));
              if (skCache.size > 24) skCache.clear();
              skCache.set(k, sk);
            }
            const scale = (Number(ob.s) || 1) * (Number(asset.rawHeight) > 0 ? (Number(ob.h) || 1.7) / asset.rawHeight : 1);
            const sc3 = ob.scale || { x: 1, y: 1, z: 1 };
            const model = (Number(ob.rx) || Number(ob.rz))
              ? directorMat4ModelEuler(ob.pos, Number(ob.rx) || 0, Number(ob.rotY) || 0, Number(ob.rz) || 0, v3(scale * (sc3.x || 1), scale * (sc3.y || 1), scale * (sc3.z || 1)))
              : directorMat4Model(ob.pos, Number(ob.rotY) || 0, v3(scale * (sc3.x || 1), scale * (sc3.y || 1), scale * (sc3.z || 1)));
            const mat = ob.material || null;
            if (loc.uRoughness) gl.uniform1f(loc.uRoughness, mat && mat.roughness !== undefined ? Number(mat.roughness) : 1);
            if (loc.uMetallic) gl.uniform1f(loc.uMetallic, mat && mat.metallic !== undefined ? Number(mat.metallic) : 0);
            if (loc.uSpecular) gl.uniform1f(loc.uSpecular, mat && mat.specular !== undefined ? Number(mat.specular) : 0.5);
            if (locSkin && locSkin.uRoughness) gl.uniform1f(locSkin.uRoughness, mat && mat.roughness !== undefined ? Number(mat.roughness) : 1);
            if (locSkin && locSkin.uMetallic) gl.uniform1f(locSkin.uMetallic, mat && mat.metallic !== undefined ? Number(mat.metallic) : 0);
            if (locSkin && locSkin.uSpecular) gl.uniform1f(locSkin.uSpecular, mat && mat.specular !== undefined ? Number(mat.specular) : 0.5);
            const cc3 = directorHexToRgb(ob.color || CLAY);
            if (drawDynamic(sk.pos, sk.nrm, asset.indices, model, cc3, !!(o.selectedId && ob.id === o.selectedId), viewProj, lightPack, Number(env.exposure) || 1)) {
              stats.faces += asset.tris;
              stats.tris += asset.tris;
              stats.drawn++;
            }
            return;
          }
        }
        // glTF 资产：蒙皮 + 骨架 + 动画（真实模型，不是程序化面片）
        if (ob.kind === 'gltf') {
          const asset = gltfAssetOf(ob.assetId);
          if (asset) {
            const rec = uploadSkin(ob.assetId, asset);
            const t = Number(ob.animTime) || 0;
            const bones = asset.bones ? boneMatrices(asset, t) : null;
            const cc2 = directorHexToRgb(ob.color || CLAY);
            const model = directorMat4Model(ob.pos, Number(ob.rotY) || 0, v3(Number(ob.s) || 1, Number(ob.s) || 1, Number(ob.s) || 1));
            if (drawSkin(asset, rec, model, cc2, viewProj, lightPack, Number(env.exposure) || 1, !!(o.selectedId && ob.id === o.selectedId), bones)) {
              stats.faces += asset.tris;
              stats.tris += asset.tris;
              stats.drawn++;
            }
            return;
          }
        }
        const faces = directorObjectFaces(ob);
        stats.faces += faces.length;
        if (!faces.length) return;
        const rec = buildMesh(ob.id, faces, ob);
        stats.tris += rec.count / 3;
        gl.bindBuffer(gl.ARRAY_BUFFER, rec.vbo);
        gl.enableVertexAttribArray(loc.aPosition);
        gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, rec.nbo);
        gl.enableVertexAttribArray(loc.aNormal);
        gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(loc.uModel, false, directorMat4Identity());
        gl.uniformMatrix3fv(loc.uNormalMat, false, directorMat3NormalFrom(v3(0, 0, 0), 0, v3(1, 1, 1)));
        const cc = directorHexToRgb(ob.color || CLAY);
        gl.uniform3f(loc.uColor, cc[0], cc[1], cc[2]);
        gl.uniform1f(loc.uSelected, (o.selectedId && ob.id === o.selectedId) ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, rec.count);
        stats.drawn++;
      });
      // gizmo：三根轴 + 旋转环（深度测试关闭 → 永远可见；最后画）
      // 辅助线：对象高度参考线 + 机位路径（参考图里的「对象高度参考线」「运动路径」）
      {
        const guides = env.guides || {};
        const lineBuf = [];
        if (guides.heightRef !== false) {
          for (const ob of (scene.objects || [])) {
            if (ob.visible === false) continue;
            const hgt = Number(ob.h) || (ob.kind === 'model' ? 1.7 : 1.0);
            lineBuf.push([v3(ob.pos.x, 0, ob.pos.z), v3(ob.pos.x, hgt, ob.pos.z)]);
          }
        }
        // 物体路径线：只在「编辑器视口」画，成片/导出绝不出现（用户反馈路径被渲染进成片）
        if (!o.renderOnly) {
          for (const ob of (scene.objects || [])) {
            if (!ob || !Array.isArray(ob.path) || ob.path.length < 2) continue;
            const pm = ob.pathMode || 'curve';
            const lineSegs = [];
            if (pm === 'curve') {
              const keys2 = ob.path.map((p, i) => ({ t: i / (ob.path.length - 1), pos: p }));
              let prev2 = null;
              for (let i = 0; i <= 40; i++) {
                const sp = samplePath(keys2, i / 40);
                if (!sp) continue;
                if (prev2) lineSegs.push([prev2, sp.pos]);
                prev2 = sp.pos;
              }
            } else {
              for (let i = 0; i + 1 < ob.path.length; i++) lineSegs.push([ob.path[i], ob.path[i + 1]]);
            }
            const psel = (o.pathSel && o.pathSel.objId === ob.id) ? o.pathSel.index : -1;
            ob.path.forEach((p, pidx) => {
              const r = pidx === psel ? 0.26 : 0.12;   // 选中的点画得更大
              lineSegs.push([v3(p.x - r, p.y, p.z), v3(p.x + r, p.y, p.z)]);
              lineSegs.push([v3(p.x, p.y - r, p.z), v3(p.x, p.y + r, p.z)]);
              lineSegs.push([v3(p.x, p.y, p.z - r), v3(p.x, p.y, p.z + r)]);
            });
            if (!lineSegs.length) continue;
            // 有宽度的条带（1px 线太细看不清）：每段向两侧展开成四边形
            const seg = lineSegs;
            const tris3 = [];
            for (const sg of seg) {
              const a2 = sg[0], b2 = sg[1];
              const dx = b2.x - a2.x, dy = b2.y - a2.y, dz = b2.z - a2.z;
              const len = Math.hypot(dx, dy, dz);
              if (len < 1e-6) continue;
              const upv = Math.abs(dy / len) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
              const side = vNorm(vCross(v3(dx, dy, dz), upv));
              // 按屏幕像素定宽：约 3.5px 半宽，远近都看得清
              const dep = depthOf(cam, vMul(vAdd(a2, b2), 0.5));
              const w = Math.max(1e-4, pixelSizeAt(cam, hCss, dep) * 3.5);
              const o1 = vMul(side, w), o2 = vMul(side, -w);
              // 抬高 2cm：地面在 y=0.001，路径贴地会被地面完全遮挡（只剩端点）
              const LIFT_Y = v3(0, 0.02, 0);
              const p1 = vAdd(vAdd(a2, o1), LIFT_Y), p2 = vAdd(vAdd(a2, o2), LIFT_Y);
              const p3 = vAdd(vAdd(b2, o2), LIFT_Y), p4 = vAdd(vAdd(b2, o1), LIFT_Y);
              tris3.push([p1, p2, p3], [p1, p3, p4]);
            }
            if (tris3.length) {
              gl.uniform1f(loc.uFlat, 1);      // 路径不受光照（纯色，避免被灯光染色）
              gl.uniform1f(loc.uSelected, 0);
              drawTris(tris3, directorMat4Identity(), [1.0, 0.78, 0.25]);
              gl.uniform1f(loc.uFlat, 0);
            }
          }
        }
        if (guides.path !== false) {
          const cam2 = (scene.cameras || []).find((c) => c.id === scene.activeCameraId);
          const keys = (cam2 && Array.isArray(cam2.keys)) ? cam2.keys.slice().sort((a, b) => a.t - b.t) : [];
          if (keys.length >= 2 && cam2.pathMode === 'curve') {
            // 样条路径：按 30 段采样画平滑曲线（对照 BKE_where_on_path）
            const t0 = keys[0].t, t1 = keys[keys.length - 1].t;
            let prev2 = null;
            for (let i = 0; i <= 30; i++) {
              const sp = samplePath(keys, t0 + ((t1 - t0) * i) / 30);
              if (!sp) continue;
              if (prev2) lineBuf.push([prev2, sp.pos]);
              prev2 = sp.pos;
            }
          } else {
            for (let i = 0; i + 1 < keys.length; i++) lineBuf.push([keys[i].pos, keys[i + 1].pos]);
          }
        }
        if (lineBuf.length) {
          gl.disable(gl.DEPTH_TEST);
          const buf = new Float32Array(lineBuf.length * 6);
          lineBuf.forEach((seg2, i) => {
            buf[i * 6] = seg2[0].x; buf[i * 6 + 1] = seg2[0].y; buf[i * 6 + 2] = seg2[0].z;
            buf[i * 6 + 3] = seg2[1].x; buf[i * 6 + 4] = seg2[1].y; buf[i * 6 + 5] = seg2[1].z;
          });
          gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
          gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc.aPosition);
          gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
          gl.disableVertexAttribArray(loc.aNormal);
          gl.vertexAttrib3f(loc.aNormal, 0, 1, 0);
          gl.uniformMatrix4fv(loc.uModel, false, directorMat4Identity());
          gl.uniform1f(loc.uSelected, 0);
          gl.uniform3f(loc.uColor, 0.36, 0.58, 0.85);
          gl.drawArrays(gl.LINES, 0, lineBuf.length * 2);
          gl.enable(gl.DEPTH_TEST);
        }
      }
      if (o.gizmo && o.selectedId) {
        const sel = (scene.objects || []).find((x) => x.id === o.selectedId);
        if (sel) {
          // 轴心恒 = 物体自身坐标系原点（人物 = 脚底中心），轴朝向由 objectAxes(sel) 给出
          // → 物体旋转时轴跟着转（人物倒地后 z 轴仍指向头），不是固定世界坐标。
          // 绝不随姿态/髋高上浮：任何"智能抬升"都会让轴悬空（0.19.3/0.19.4 的教训）。
          const origin = v3(sel.pos.x, sel.pos.y, sel.pos.z);
          // 屏幕恒定大小（Blender: wm_gizmo_calculate_scale）：轴长 105 CSS px，环 0.62×轴长。
          // 尺寸唯一来源 gizmoMetrics，拾取用同一个函数 → 不可能再出现「画的位置和点不中」。
          const gm = gizmoMetrics(cam, sel, hCss, origin);
          const pxWorld = gm.pxWorld, L = gm.L, R = gm.R;
          const GP = gm.px;
          const ax = objectAxes(sel);
          const hov = String(o.hoverAxis || '');          // 悬停的部件（x/y/z/rotx/roty/rotz/scale:x…）
          const isHov = (kind, id) => hov === (kind === 'ring' ? 'rot' + id : kind === 'handle' ? 'scale:' + id : id);
          const W_AXIS = pxWorld * GP.shaft, W_AXIS_H = pxWorld * GP.shaftHover;   // 轴身粗细（CSS 像素）
          const W_RING = pxWorld * GP.ring, W_RING_H = pxWorld * GP.ringHover;     // 环粗细
          const H_HANDLE = pxWorld * GP.handle, H_HANDLE_H = pxWorld * GP.handleHover;  // 缩放块半宽
          const CB = cameraBasis(cam);   // 屏向基向量：手柄/箭头不再随轴朝向变形

          gl.disable(gl.DEPTH_TEST);
          gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
          gl.enableVertexAttribArray(loc.aPosition);
          gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
          gl.disableVertexAttribArray(loc.aNormal);
          gl.vertexAttrib3f(loc.aNormal, 0, 1, 0);
          gl.uniformMatrix4fv(loc.uModel, false, directorMat4Identity());
          gl.uniform1f(loc.uSelected, 0);
          gl.uniform1f(loc.uFlat, 1);                     // gizmo 不受光 → 颜色即 uColor，稳定明亮

          // 三角形批次（屏幕朝向的四边形）：一次 upload 画完，性能与线框相当
          const tris = [];
          const quad = (a2, b2, width) => {
            // 以 a2-b2 为轴、宽 width 的 billboard 四边形（法线朝相机，uFlat 下不需光照）
            const mid = vMul(vAdd(a2, b2), 0.5);
            const toCam = vNorm(vSub(cam.pos, mid));
            const dirAB = vSub(b2, a2);
            if (vLen(dirAB) < 1e-9) return;
            const side = vNorm(vCross(dirAB, toCam));
            if (vLen(side) < 1e-6) return;
            const hw = vMul(side, width * 0.5);
            const p0 = vSub(a2, hw), p1 = vAdd(a2, hw), p2 = vAdd(b2, hw), p3 = vSub(b2, hw);
            tris.push([p0, p1, p2], [p0, p2, p3]);
          };
          const flush = (color) => {
            if (!tris.length) return;
            const pos = new Float32Array(tris.length * 9);
            let j = 0;
            for (const tri of tris) for (const p of tri) { pos[j++] = p.x; pos[j++] = p.y; pos[j++] = p.z; }
            gl.bindBuffer(gl.ARRAY_BUFFER, scratch);
            gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(loc.aPosition);
            gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
            gl.uniform3f(loc.uColor, color[0], color[1], color[2]);
            gl.drawArrays(gl.TRIANGLES, 0, tris.length * 3);
            tris.length = 0;
          };
          const bright = (c, k) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

          const AXES = [
            { id: 'x', dir: ax.x, color: [0.92, 0.30, 0.30] },
            { id: 'y', dir: ax.y, color: [0.34, 0.86, 0.40] },
            { id: 'z', dir: ax.z, color: [0.32, 0.56, 0.98] },
          ];
          // ① 轴身 + 箭头 + 轴端缩放块
          for (const a2 of AXES) {
            const hovAxis = isHov('axis', a2.id);
            const col = hovAxis ? bright(a2.color, 1.45) : a2.color;
            const shaftEnd = vAdd(origin, vMul(a2.dir, L * 0.92));
            quad(origin, shaftEnd, hovAxis ? W_AXIS_H : W_AXIS);
            // 箭头（指向轴端）
            const tip = vAdd(origin, vMul(a2.dir, L));
            const base = vAdd(origin, vMul(a2.dir, L * 0.82));
            const sideRaw = vCross(a2.dir, vNorm(vSub(cam.pos, base)));
            const sideDir = vLen(sideRaw) > 1e-6 ? vNorm(sideRaw) : CB.right;
            const side = vMul(sideDir, L * 0.075);
            tris.push([tip, vAdd(base, side), vSub(base, side)]);
            flush(col);
          }
          // ② 三环（环半径 0.62L，在轴内侧；悬停加粗提亮）
          const RING_SEG = 64;
          for (const rg of [
            { id: 'y', color: [0.93, 0.76, 0.30], a: ax.x, b: ax.z },   // 绕局部 Y
            { id: 'x', color: [0.92, 0.44, 0.44], a: ax.y, b: ax.z },   // 绕局部 X
            { id: 'z', color: [0.44, 0.66, 0.96], a: ax.x, b: ax.y },   // 绕局部 Z
          ]) {
            const hovRing = isHov('ring', rg.id);
            const w = hovRing ? W_RING_H : W_RING;
            const at = (ang) => vAdd(origin, vAdd(vMul(rg.a, Math.cos(ang) * R), vMul(rg.b, Math.sin(ang) * R)));
            for (let i = 0; i < RING_SEG; i++) {
              const a1 = (i / RING_SEG) * Math.PI * 2, a2b = ((i + 1) / RING_SEG) * Math.PI * 2;
              quad(at(a1), at(a2b), w);
            }
            flush(hovRing ? bright(rg.color, 1.5) : rg.color);
          }
          // ③ 轴端缩放手柄最后画：永远置顶（否则 Z 指向相机时会被旋转环盖住，看着像"Z 没有手柄"）
          for (const a2 of AXES) {
            const hovScale = isHov('handle', a2.id);
            const hs = hovScale ? H_HANDLE_H : H_HANDLE;
            const tip2 = vAdd(origin, vMul(a2.dir, L));
            const q1 = vAdd(tip2, vAdd(vMul(CB.right, hs), vMul(CB.up, hs)));
            const q2 = vAdd(tip2, vAdd(vMul(CB.right, -hs), vMul(CB.up, hs)));
            const q3 = vAdd(tip2, vAdd(vMul(CB.right, -hs), vMul(CB.up, -hs)));
            const q4 = vAdd(tip2, vAdd(vMul(CB.right, hs), vMul(CB.up, -hs)));
            tris.push([q1, q2, q3], [q1, q3, q4]);
            flush(hovScale ? bright(a2.color, 1.7) : a2.color);
          }
          gl.uniform1f(loc.uFlat, 0);
          gl.enable(gl.DEPTH_TEST);
        }
      }
      if (dofOn) runPostPass(w, h, dof);
      else if (postOk) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return stats;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        for (const rec of meshCache.values()) { gl.deleteBuffer(rec.vbo); gl.deleteBuffer(rec.nbo); }
        meshCache.clear();
        if (gridVbo) gl.deleteBuffer(gridVbo);
        gl.deleteBuffer(scratch);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs2);
      } catch { /* 忽略 */ }
    },
  };
}

// ============================================================
// 渲染（B）：Canvas2D 画家算法（无 WebGL 时的兼容路径）
// ============================================================
export function directorRenderScene(ctx, w, h, scene, opts) {
  const o = opts || {};
  const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0];
  const stats = { faces: 0, drawn: 0 };
  if (!ctx || !cam) return stats;
  const env = scene.env || {};
  const view = directorViewOf(cam);
  const aspect = (w || 1) / Math.max(1, h || 1);
  const cx = w / 2, cy = h / 2, hw = w / 2, hh = h / 2;
  ctx.fillStyle = env.bg || '#171717';
  ctx.fillRect(0, 0, w, h);
  const items = [];
  (scene.objects || []).forEach((ob) => {
    const fs = directorObjectFaces(ob);
    stats.faces += fs.length;
    fs.forEach((f) => items.push({ f, color: ob.color || CLAY, base: ob }));
  });
  if (false && env.groundVisible !== false) {
    const s = 400, op = 0;   // 不画地面填充，只画网格
    const g = hexToRgb255(env.ground || '#242424'), bg = hexToRgb255(env.bg || '#171717');
    const mixed = 'rgb(' + Math.round(g[0] * op + bg[0] * (1 - op)) + ',' + Math.round(g[1] * op + bg[1] * (1 - op)) + ',' + Math.round(g[2] * op + bg[2] * (1 - op)) + ')';
    const project = (p) => {
      const nd = directorProject(view.toCam(p), cam.fov, aspect);
      return nd ? { x: cx + nd.x * hw, y: cy - nd.y * hh } : null;
    };
    const a = project(v3(-s, 0.002, -s)), b2 = project(v3(s, 0.002, -s)), c2 = project(v3(s, 0.002, s)), d2 = project(v3(-s, 0.002, s));
    if (a && b2 && c2 && d2) {
      ctx.fillStyle = mixed;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(d2.x, d2.y); ctx.closePath(); ctx.fill();
    }
  }
  if (env.grid !== false) {
    const gridLines = [];
    const G = 10;
    for (let i = -G; i <= G; i++) { gridLines.push([v3(i, 0.004, -G), v3(i, 0.004, G)]); gridLines.push([v3(-G, 0.004, i), v3(G, 0.004, i)]); }
    const project = (p) => {
      const nd = directorProject(view.toCam(p), cam.fov, aspect);
      return nd ? { x: cx + nd.x * hw, y: cy - nd.y * hh } : null;
    };
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150,160,175,0.25)';
    ctx.beginPath();
    gridLines.forEach(([a, b2]) => {
      const pa = project(a), pb = project(b2);
      if (!pa || !pb) return;
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    });
    ctx.stroke();
  }
  const keyLight = (scene.lights || [])[0] || { dir: vNorm(v3(0.4, -0.8, 0.3)), intensity: 1 };
  const amb = (scene.lights || [])[1] || { intensity: 0.4 };
  const exposure = Number(env.exposure) || 1;
  const project = (p) => {
    const nd = directorProject(view.toCam(p), cam.fov, aspect);
    return nd ? { x: cx + nd.x * hw, y: cy - nd.y * hh, z: nd.z } : null;
  };
  items.forEach((it) => {
    const proj = it.f.v.map(project);
    if (proj.some((p) => !p)) { it.skip = true; return; }
    it.proj = proj;
    it.depth = proj.reduce((a, p) => a + p.z, 0) / proj.length;
    const nrm = directorFaceNormal(it.f.v);
    const lam = Math.max(0, -vDot(nrm, keyLight.dir || v3(0, -1, 0))) * (Number(keyLight.intensity) || 1);
    it.light = Math.max(0.18, Math.min(1.35, 0.32 + lam + (Number(amb.intensity) || 0.4) * 0.35 + (it.f.shade || 0))) * exposure;
  });
  items.sort((a, b) => (b.depth || 0) - (a.depth || 0));
  items.forEach((it) => {
    if (it.skip || !it.proj || it.proj.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(it.proj[0].x, it.proj[0].y);
    for (let i = 1; i < it.proj.length; i++) ctx.lineTo(it.proj[i].x, it.proj[i].y);
    ctx.closePath();
    ctx.fillStyle = directorShadeColor(it.color, it.light);
    ctx.fill();
    if (o.selectedId && it.base && it.base.id === o.selectedId) {
      ctx.strokeStyle = 'rgba(96,165,250,0.95)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    stats.drawn++;
  });
  return stats;
}

// ============================================================
// 拾取与 gizmo 命中
// ============================================================
/**
 * 框选：返回屏幕矩形内的所有对象（用每个对象包围盒中心 + 投影判定）。
 * 与 Blender 的框选语义一致：只要对象的屏幕投影与矩形有交叠即算选中。
 */
/**
 * 框选：对象包围盒投影与屏幕矩形相交即选中（Blender 框选语义）。
 * 判定用「中心点 + 半径」两重条件，小对象也能被小框套住。
 */
export function objectsInRect(scene, w, h, x0, y0, x1, y1) {
  const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0];
  if (!cam) return [];
  const view = directorViewOf(cam);
  const aspect = w / Math.max(1, h);
  const cx = w / 2, cy = h / 2, hw = w / 2, hh = h / 2;
  const project = (p) => {
    const nd = directorProject(view.toCam(p), cam.fov, aspect);
    return nd ? { x: cx + nd.x * hw, y: cy - nd.y * hh } : null;
  };
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const out = [];
  for (const ob of (scene.objects || [])) {
    if (ob.visible === false || !ob.pos) continue;
    // ① 屏幕包围盒与框选矩形相交即选中（建筑/摊位这类宽物体框住一半也算）
    const box = directorObjectScreenBox(ob, project);
    if (box) {
      const overlap = box.x1 >= minX && box.x0 <= maxX && box.y1 >= minY && box.y0 <= maxY;
      if (overlap) { out.push(ob.id); continue; }
    }
    // ② 兜底：中心/头顶/脚底任一采样点落框（细长物体或包围盒退化时）
    const hgt = Number(ob.h) || 1.7;
    const c = project(v3(ob.pos.x, ob.pos.y + hgt * 0.5, ob.pos.z));
    if (c && c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY) { out.push(ob.id); continue; }
    const top = project(v3(ob.pos.x, ob.pos.y + hgt, ob.pos.z));
    const bot = project(v3(ob.pos.x, ob.pos.y, ob.pos.z));
    const inRect = (p) => p && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    if (inRect(top) || inRect(bot)) out.push(ob.id);
  }
  return out;
}

/**
 * 路径点拾取：返回 { objId, index } 或 null。按屏幕像素距离判定，命中阈值 16px。
 */
export function directorPickPathPoint(scene, w, h, sx, sy, radius) {
  const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0];
  if (!cam) return null;
  const view = directorViewOf(cam);
  const aspect = w / Math.max(1, h);
  const cx = w / 2, cy = h / 2, hw = w / 2, hh = h / 2;
  const project = (p) => {
    const nd = directorProject(view.toCam(p), cam.fov, aspect);
    return nd ? { x: cx + nd.x * hw, y: cy - nd.y * hh } : null;
  };
  const R = radius || 16;
  let best = null, bestD = R;
  for (const ob of scene.objects || []) {
    if (ob.visible === false) continue;
    if (!Array.isArray(ob.path) || !ob.path.length) continue;
    ob.path.forEach((p, idx) => {
      if (!p) return;
      // 路径点存的是世界绝对坐标（与绘制、applyPlayhead 一致）
      const sp = project({ x: Number(p.x) || 0, y: (Number(p.y) || 0) + 0.02, z: Number(p.z) || 0 });
      if (!sp) return;
      const d = Math.hypot(sp.x - sx, sp.y - sy);
      if (d <= bestD) { bestD = d; best = { objId: ob.id, index: idx }; }
    });
  }
  return best;
}

/**
 * 对象屏幕包围盒（廉价：单位盒/身高 × scale，不生成网格）。
 * 只用于「点不中时」的容差兜底：远处角色只占几像素，纯多边形包含判定几乎不可能点中。
 */
function directorObjectScreenBox(ob, project) {
  const sc = ob.scale || { x: 1, y: 1, z: 1 };
  const k = Number(ob.s) || 1;
  const sx = k * (Number(sc.x) || 1), sy = k * (Number(sc.y) || 1), sz = k * (Number(sc.z) || 1);
  let hx, hy, hz;
  if (ob.kind === 'model' || ob.kind === 'gltf' || ob.kind === 'actor') {
    const h = Number(ob.h) || 1.78;
    hx = h * 0.30 * Math.max(0.5, sx);
    hy = h * Math.max(0.5, sy);
    hz = h * 0.22 * Math.max(0.5, sz);
  } else {
    const preset = String(ob.preset || 'box');
    const H = preset === 'plane' || preset === 'disc' ? 0.02
      : preset === 'ancient_house' ? 1.34
        : preset === 'ancient_stall' ? 0.84
          : preset === 'stone_step' ? 0.3 : 1;
    hx = 0.5 * sx; hy = H * sy; hz = 0.5 * sz;
  }
  const ry = Number(ob.rotY) || 0, c = Math.cos(ry), sn = Math.sin(ry);
  const xf = (x, y, z) => v3(ob.pos.x + x * c + z * sn, ob.pos.y + Math.max(0, y), ob.pos.z - x * sn + z * c);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, depth = 0, n = 0;
  for (const X of [-hx, hx]) for (const Y of [0, hy]) for (const Z of [-hz, hz]) {
    const p = project(xf(X, Y, Z));
    if (!p) continue;
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    depth += p.z; n++;
  }
  if (!n) return null;
  return { x0, x1, y0, y1, depth: depth / n };
}

export function directorPickObject(scene, w, h, sx, sy, opts) {
  const o = opts || {};
  const tol = Number(o.tol) >= 0 ? Number(o.tol) : 8;   // 屏幕容差（CSS 像素）
  const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0];
  if (!cam) return null;
  const project = (p) => directorScreenOf(cam, w, h, p);
  const hit = (poly, x, y) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  // ① 精确命中（多边形包含，取最近深度）
  let best = null, bestDepth = Infinity;
  (scene.objects || []).forEach((ob) => {
    if (ob.visible === false) return;
    directorObjectFaces(ob).forEach((f) => {
      const proj = f.v.map(project);
      if (proj.some((p) => !p)) return;
      if (!hit(proj, sx, sy)) return;
      const d = proj.reduce((a, p) => a + p.z, 0) / proj.length;
      if (d < bestDepth) { bestDepth = d; best = ob; }
    });
  });
  if (best) return best;
  // ② 容差兜底：屏幕包围盒外扩 tol（远处小目标/细长物体也能点中）
  if (!(tol > 0)) return null;
  let near = null, nearD = Infinity, nearDepth = Infinity;
  for (const ob of (scene.objects || [])) {
    if (ob.visible === false) continue;
    const box = directorObjectScreenBox(ob, project);
    if (!box) continue;
    const dx = Math.max(box.x0 - sx, 0, sx - box.x1);
    const dy = Math.max(box.y0 - sy, 0, sy - box.y1);
    const d = Math.hypot(dx, dy);
    if (d > tol) continue;
    if (d < nearD - 1e-6 || (Math.abs(d - nearD) <= 1e-6 && box.depth < nearDepth)) {
      near = ob; nearD = d; nearDepth = box.depth;
    }
  }
  return near;
}

const distToSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + dx * t, y = ay + dy * t;
  return Math.hypot(px - x, py - y);
};
/** gizmo 命中：返回 {axis:'x'|'y'|'z'|'rot'}；优先轴（8px），其次旋转环（10px）。 */
/**
 * gizmo 拾取（与绘制完全同源）：尺寸用屏幕恒定像素换算，轴线随物体旋转。
 * 判定顺序：轴端方块(缩放) → 圆环(旋转) → 轴身(移动)；全部按屏幕像素距离，命中率不受远近影响。
 */
export function directorPickGizmo(scene, selectedId, w, h, sx, sy) {
  const sel = (scene.objects || []).find((x) => x.id === selectedId);
  if (!sel) return null;
  const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0];
  if (!cam) return null;
  // 与绘制完全同源：精确屏幕投影 + 同一个 gizmoMetrics（w/h 都是 CSS 尺寸）
  const project = (p) => directorScreenOf(cam, w, h, p);
  // 与绘制完全同源：轴心恒 = 物体原点（规则必须与绘制一字不差，否则点不中画出来的轴）
  const gm = gizmoMetrics(cam, sel, h, v3(sel.pos.x, sel.pos.y, sel.pos.z));
  const origin = gm.origin, L = gm.L, R = gm.R;
  const ax = objectAxes(sel);
  const AXES = [['x', ax.x], ['y', ax.y], ['z', ax.z]];

  // ① 轴端缩放手柄（屏向方块）：命中半径 = 半宽 + 3px 容差
  const HIT_HANDLE = gm.px.handle + 3;
  let best = null, bestD = HIT_HANDLE;
  for (const [id, dir] of AXES) {
    const tip = project(vAdd(origin, vMul(dir, L)));
    if (!tip) continue;
    const d = Math.hypot(tip.x - sx, tip.y - sy);
    if (d < bestD) { bestD = d; best = { axis: id, op: 'scale' }; }
  }
  if (best) return best;

  // ② 轴身（移动）：命中 = 轴半宽 + 4px 容差
  const HIT_SHAFT = Math.max(6, gm.px.shaft / 2 + 4);
  let bestMove = null, bestMoveD = HIT_SHAFT;
  for (const [id, dir] of AXES) {
    const a = project(origin), b2 = project(vAdd(origin, vMul(dir, L * 0.92)));
    if (!a || !b2) continue;
    const d = distToSeg(sx, sy, a.x, a.y, b2.x, b2.y);
    if (d < bestMoveD) { bestMoveD = d; bestMove = id; }
  }
  if (bestMove) return { axis: bestMove, op: 'move' };

  // ③ 旋转环：命中 = 环半宽 + 3px 容差
  const HIT_RING = gm.px.ring / 2 + 3;
  const RINGS = [
    ['roty', ax.x, ax.z],
    ['rotx', ax.y, ax.z],
    ['rotz', ax.x, ax.y],
  ];
  let bestRing = null, bestRingD = HIT_RING;
  for (const [key, b1, b2] of RINGS) {
    let dmin = Infinity;
    for (let i = 0; i < 48; i++) {
      const a1 = (i / 48) * Math.PI * 2, a2 = ((i + 1) / 48) * Math.PI * 2;
      const p1 = project(vAdd(origin, vAdd(vMul(b1, Math.cos(a1) * R), vMul(b2, Math.sin(a1) * R))));
      const p2 = project(vAdd(origin, vAdd(vMul(b1, Math.cos(a2) * R), vMul(b2, Math.sin(a2) * R))));
      if (!p1 || !p2) continue;
      dmin = Math.min(dmin, distToSeg(sx, sy, p1.x, p1.y, p2.x, p2.y));
    }
    if (dmin < bestRingD) { bestRingD = dmin; bestRing = key; }
  }
  if (bestRing) return { axis: bestRing, op: 'rotate' };

  return null;
}


// ============================================================
// 成片场景：只剥离编辑辅助，不破坏用户的材质与布光。
//   默认保留对象颜色、材质、灯光、天空和背景；opts.clay=true 才输出中性白模。
//   路径/网格/标签/gizmo 永远属于编辑态，不会进入预览或导出。
// ============================================================
export function buildExportScene(scene, opts) {
  const o = opts || {};
  if (!scene) return scene;
  const out = JSON.parse(JSON.stringify(scene));
  const clay = o.clay === true;
  out.env = Object.assign({}, out.env, {
    ...(clay ? {
      bg: o.bg || '#d9dde2',
      sky: o.sky || { zenith: '#cfd8e6', horizon: '#e6e9ee', ground: '#9aa0a8' },
      ground: o.ground || '#b3b8bf',
    } : {}),
    grid: false,
    // 地面开关跟随场景设置（UI「无限地面」）；opts 显式传入时以 opts 为准
    groundInRender: o.groundInRender !== undefined ? (o.groundInRender !== false) : (out.env.groundInRender !== false),
    guides: { heightRef: false, path: false, names: false, cameraFrame: false },
  });
  if (clay) {
    out.lights = [
      { id: 'key', dir: vNorm(v3(0.40, -0.80, 0.45)), color: '#ffffff', intensity: 0.88 },
      { id: 'fill', dir: vNorm(v3(0.10, -0.16, -0.98)), color: '#ffffff', intensity: 0.60 },
    ];
    out.objects = (out.objects || []).map((ob) => Object.assign({}, ob, {
      color: o.clayColor || '#e2e4e6',
      material: Object.assign({}, ob.material || {}, { metallic: 0, roughness: 0.82, specular: 0.35 }),
    }));
  }
  out.__export = true;
  out.__renderOnly = true;
  return out;
}

// ============================================================
// 影棚编辑场景（静态/动态预演视口专用）
//   编辑态必须稳定：固定深色影棚背景 + 网格 + 中性布光，
//   不跟随用户在「实时渲染」里调的日光/地面/曝光/雾/景深变化，
//   否则摆位时画面会随渲染参数漂移（用户实测要求）。
// ============================================================
export function buildStudioScene(scene, opts) {
  const o = opts || {};
  if (!scene) return scene;
  const out = JSON.parse(JSON.stringify(scene));
  const guides = Object.assign({ heightRef: true, path: true, names: true, cameraFrame: true }, (out.env && out.env.guides) || {});
  out.env = Object.assign({}, out.env, {
    preset: 'studio',
    bg: o.bg || '#1a1e24',
    ground: o.ground || '#2a2f36',
    grid: true,
    groundInRender: true,
    exposure: 1,
    tonemap: 'srgb',
    fog: undefined,
    dof: undefined,
    guides,
  });
  // 中性影棚双灯：与环境参数解耦，保证编辑态光照恒定
  out.lights = [
    { id: 'key', dir: vNorm(v3(0.42, -0.72, 0.55)), color: '#ffffff', intensity: 1.35 },
    { id: 'fill', dir: vNorm(v3(-0.45, -0.35, -0.6)), color: '#c8d6ff', intensity: 0.5 },
  ];
  return out;
}

// ============================================================
// 提示词编译（白膜口径：身份按名称/站位，不再用颜色映射）
// ============================================================
export function compileDirectorPrompt(scene, opts) {
  const o = opts || {};
  const zh = o.zh !== false;
  const shot = scene.shot || {};
  // 景别/运镜文案一律从中英双语的单一来源取：避免输出内部 id（如 medium_close），也避免英文分支里混中文
  const fillDef = SHOT_FILLS.find((f) => f.id === shot.shotSize) || null;
  const sizeLabel = fillDef ? (zh ? fillDef.zh : fillDef.en) : String(shot.shotSize || '');
  const MOVE_LABELS = {
    static: { zh: '固定机位', en: 'static camera' },
    push_in: { zh: '推近', en: 'push in' },
    pull_out: { zh: '拉远', en: 'pull out' },
    pan_left: { zh: '向左摇', en: 'pan left' },
    pan_right: { zh: '向右摇', en: 'pan right' },
    orbit_left: { zh: '左环绕', en: 'orbit left' },
    orbit_right: { zh: '右环绕', en: 'orbit right' },
    handheld: { zh: '手持微晃', en: 'handheld' },
  };
  const mvDef = MOVE_LABELS[shot.cameraMove] || null;
  const moveLabel = mvDef ? (zh ? mvDef.zh : mvDef.en) : String(shot.cameraMove || '');
  const cam = (scene.cameras || []).find((c) => c.id === scene.activeCameraId) || (scene.cameras || [])[0] || {};
  const actors = (scene.objects || []).filter((x) => (x.kind === 'actor' || x.kind === 'body' || (x.kind === 'model' && (x.assetId === 'xbot' || x.typeId))) && x.visible !== false);
  const props = (scene.objects || []).filter((x) => !actors.includes(x) && x.visible !== false);
  const camY = (cam.pos && cam.pos.y) || 1.6;
  const tgtY = (cam.target && cam.target.y) || 1.0;
  const angle = camY < tgtY - 0.35 ? (zh ? '低机位仰拍' : 'low angle') : camY > tgtY + 0.9 ? (zh ? '高机位俯拍' : 'high angle') : (zh ? '平视机位' : 'eye level');
  const dist = cam.pos && cam.target ? vLen(vSub(cam.pos, cam.target)) : 3;
  const focal = Math.round(12 / Math.tan((Math.max(5, Math.min(150, cam.fov || 42)) * Math.PI / 180) / 2));
  const lines = [];
  if (zh) {
    lines.push('【导演台布景】按以下机位与人物站位生成这一镜。布景是白色素模（白膜占位），必须画成真实人物与真实场景，不要保留素模外观。');
    lines.push('机位：' + sizeLabel + '，' + angle + '，约 ' + focal + 'mm 焦段视角，距主体约 ' + (Math.round(dist * 10) / 10) + ' 米，' + moveLabel + '。');
    if (actors.length) {
      lines.push('人物站位映射（按画面方位识别身份，素模为白色占位）：' +
        actors.map((a, i) => String(a.name || ('角色' + (i + 1))) + '站在画面' +
          (a.pos.x < -0.5 ? '左侧' : a.pos.x > 0.5 ? '右侧' : '中央') +
          (a.pos.z > 0.5 ? '偏近景' : a.pos.z < -0.5 ? '偏远' : '')).join('；') + '。');
    }
    if (props.length) {
      lines.push('场景陈设（占位模型，按类型还原为真实道具/建筑）：' + props.slice(0, 12).map((p) => String(p.name || p.kind)).join('、') + '。');
    }
    lines.push('镜头时长 ' + (Number(shot.duration) || 5) + ' 秒，' + moveLabel + '要有起点与终点，不要停在半途。');
  } else {
    lines.push('[Director stage] Generate this shot from the camera and blocking below. The stage shows WHITE CLAY stand-ins — render real people and a real set, never keep the clay look.');
    lines.push('Camera: ' + sizeLabel + ', ' + angle + ', about ' + focal + 'mm equivalent, ' + (Math.round(dist * 10) / 10) + 'm from subject, ' + moveLabel + '.');
    if (actors.length) {
      lines.push('Blocking map (identify by screen position; stand-ins are white clay): ' +
        actors.map((a) => String(a.name || 'figure') + ' at frame ' +
          (a.pos.x < -0.5 ? 'left' : a.pos.x > 0.5 ? 'right' : 'centre') +
          (a.pos.z > 0.5 ? ' nearer' : a.pos.z < -0.5 ? ' further' : '')).join('; ') + '.');
    }
    if (props.length) {
      lines.push('Set dressing (placeholder models, restore as real props/buildings): ' + props.slice(0, 12).map((p) => String(p.name || p.kind)).join(', ') + '.');
    }
    lines.push('Shot duration ' + (Number(shot.duration) || 5) + 's; the move needs a start and an end.');
  }
  const note = String(shot.note || '').trim();
  if (note) lines.push(zh ? '补充：' + note : 'Notes: ' + note);
  return lines.join('\n');
}
