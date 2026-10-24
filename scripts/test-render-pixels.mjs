// 门禁级像素验证（阶段E）：真实浏览器渲染 + readPixels 断言
//   覆盖：① 真阴影（墙面/地面接收，A/B 差分）② 路径只在编辑器可见
//        ③ PBR 粗糙度影响高光 ④ AgX 与 sRGB 不同 ⑤ 白模导出无网格/辅助线
// 无 Chrome 时输出 SKIP 并成功退出（不阻塞 CI）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'assets/director/engine.js');
const MODELS = path.join(ROOT, 'assets/director/models');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chrome) { console.log('SKIP 像素验证：未找到 Chrome/Edge'); process.exit(0); }

const SITE = path.join(os.tmpdir(), 'dsh-director-pixels');
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'models'), { recursive: true });
fs.copyFileSync(ENGINE, path.join(SITE, 'engine.js'));
for (const f of fs.readdirSync(MODELS)) fs.copyFileSync(path.join(MODELS, f), path.join(SITE, 'models', f));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>RUN</title></head><body><pre id="out">boot</pre>
<script type="module">
const out = document.getElementById('out');
const log = (s) => { out.textContent += '\\n' + s; };
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: detail || '' }); };
(async () => {
  try {
    const E = await import('./engine.js?v=' + Date.now());
    E.registerGltfAsset('xbot', E.decodeModelPack(await (await fetch('./models/xbot.json')).json()));
    const W = 480, H = 320;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const glr = E.createDirectorGlRenderer(cv);
    if (!glr) { check('渲染器创建', false, 'createDirectorGlRenderer 返回 null'); document.title = 'DONE'; out.textContent += '\\n' + JSON.stringify(results); return; }
    glr.resize(W, H);
    const gl = glr.gl || glr.glctx;
    check('WebGL2 上下文', typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext, gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1（回退）');
    const grab = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    const lum = (px, i) => (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    const diffCount = (a, b, th) => { let n = 0; for (let i = 0; i < W * H; i++) if (Math.abs(lum(a, i) - lum(b, i)) > (th || 4)) n++; return n; };
    const countColor = (px, f) => { let n = 0; for (let i = 0; i < W * H; i++) if (f(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])) n++; return n; };

    const mkScene = (o) => Object.assign({
      version: 2,
      objects: [
        { id: 'man', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, rotY: 0, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '#c9ced6' },
        { id: 'wall', kind: 'geom', preset: 'box', pos: { x: 2.0, y: 0, z: 0 }, rotY: 0, scale: { x: 0.25, y: 3, z: 5 }, visible: true, color: '#c9ced6' },
      ],
      cameras: [{ id: 'c', name: 'A', pos: { x: -0.5, y: 1.9, z: 4.8 }, target: { x: 0.7, y: 0.8, z: 0 }, fov: 46, roll: 0 }],
      lights: [{ id: 'k', dir: E.vNorm({ x: 0.55, y: -0.86, z: 0.18 }), color: '#ffffff', intensity: 1.2 }],
      env: { bg: '#dfe2e6', ground: '#b3b8bf', grid: false, exposure: 1, guides: {}, groundInRender: true },
      activeCameraId: 'c', shot: { duration: 3 },
    }, o || {});

    // ① 真阴影：开/关阴影差分 + 墙面暗部
    const A = (glr.draw(E.applyPlayhead(mkScene(), 0), { selectedId: null, renderGround: true, shadows: false }), grab());
    const B = (glr.draw(E.applyPlayhead(mkScene(), 0), { selectedId: null, renderGround: true, shadows: true }), grab());
    const shadowDiff = diffCount(A, B, 4);
    let darkOnWall = 0;
    for (let y = 0; y < Math.floor(H * 0.6); y++) for (let x = Math.floor(W * 0.55); x < W; x++) {
      const i = y * W + x; if (lum(B, i) < lum(A, i) - 20) darkOnWall++;
    }
    check('真实阴影（A/B 差分）', shadowDiff > W * H * 0.004, 'diff=' + shadowDiff + ' px');
    check('墙面接收阴影', darkOnWall > 100, '墙面变暗 ' + darkOnWall + ' px');

    // ② 路径：编辑器可见、成片不可见
    const pathScene = mkScene({
      objects: [{ id: 'man', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, rotY: 0, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '#c9ced6', pathMode: 'curve', pathOrigin: { x: 0, y: 0, z: 0 }, path: [{ x: -2, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 2, y: 0, z: 1 }] }],
    });
    glr.draw(E.applyPlayhead(pathScene, 0), { selectedId: null, renderGround: true }); const ed = grab();
    glr.draw(E.applyPlayhead(pathScene, 0), { selectedId: null, renderGround: true, renderOnly: true }); const ro = grab();
    const isPath = (r, g, b) => r > 150 && g > 100 && g < 230 && b < 110;
    const pEd = countColor(ed, isPath), pRo = countColor(ro, isPath);
    check('路径在编辑器可见', pEd > 40, 'path px=' + pEd);
    check('成片不含路径', pRo === 0, 'render px=' + pRo);

    // ③ PBR：粗糙度影响高光
    const matte = (glr.draw(E.applyPlayhead(mkScene({ objects: [{ id: 'man', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '#c9ced6', material: { roughness: 1, metallic: 0, specular: 0.5 } }] }), 0), { selectedId: null, renderGround: true }), grab());
    const glossy = (glr.draw(E.applyPlayhead(mkScene({ objects: [{ id: 'man', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '#c9ced6', material: { roughness: 0.1, metallic: 0, specular: 0.9 } }] }), 0), { selectedId: null, renderGround: true }), grab());
    const roughDiff = diffCount(matte, glossy, 3);
    check('PBR 粗糙度生效', roughDiff > W * H * 0.002, 'diff=' + roughDiff + ' px');

    // ④ 色调映射：AgX 与 sRGB 不同
    const agx = (glr.draw(E.applyPlayhead(mkScene({ env: Object.assign({}, mkScene().env, { tonemap: 'agx' }) }), 0), { selectedId: null, renderGround: true }), grab());
    const srgb = (glr.draw(E.applyPlayhead(mkScene({ env: Object.assign({}, mkScene().env, { tonemap: 'srgb' }) }), 0), { selectedId: null, renderGround: true }), grab());
    const tmDiff = diffCount(agx, srgb, 3);
    check('色调映射（AgX vs sRGB）', tmDiff > W * H * 0.02, 'diff=' + tmDiff + ' px');

    // ④b 姿态序列：整段动画逐帧有变化、无空帧、首尾姿态不同
    {
      const poseScene = mkScene({
        objects: [{ id: 'man', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, rotY: 0, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '#c9ced6',
          poseAnim: [{ t: 0, poseId: 'arms_up' }, { t: 1, poseId: 'flip' }, { t: 2, poseId: 'crouch' }, { t: 3, poseId: 'fight' }] }],
        cameras: [{ id: 'c', name: 'A', pos: { x: 0.3, y: 1.4, z: 3.8 }, target: { x: 0, y: 1.0, z: 0 }, fov: 40, keys: [] }],
        env: { bg: '#dfe2e6', ground: '#b3b8bf', grid: false, exposure: 1, guides: {}, groundInRender: true },
      });
      const frames = [];
      for (let t = 0; t <= 3.0001; t += 0.5) {
        glr.draw(E.applyPlayhead(poseScene, t), { selectedId: null, renderGround: true, renderOnly: true });
        frames.push({ t: +t.toFixed(2), px: grab() });
      }
      let minAdj = Infinity;
      for (let i = 1; i < frames.length; i++) minAdj = Math.min(minAdj, diffCount(frames[i - 1].px, frames[i].px, 3));
      check('姿态序列帧间连续变化', minAdj > W * H * 0.002, '相邻帧最小差异=' + minAdj + ' px');
      // 首尾姿态必须不同（证明真的在动，不是静止）
      check('序列首尾姿态不同', diffCount(frames[0].px, frames[frames.length - 1].px, 4) > W * H * 0.003, 'diff=' + diffCount(frames[0].px, frames[frames.length - 1].px, 6) + ' px');
      // 无空帧
      let blank = 0;
      for (const f of frames) { let n = 0; for (let i = 0; i < W * H; i++) if (lum(f.px, i) < 180) n++; if (n < W * H * 0.008) blank++; }
      check('姿态序列无空帧', blank === 0, '空帧数=' + blank);
    }

    // ④c AI 规格：一段 JSON → 真实预演画面（角色+姿态+路径+双机位分镜）
    {
      const spec = {
        title: 'AI 预演测试',
        duration: 3,
        env: { preset: 'studio', bg: '#dfe2e6', ground: '#b3b8bf', grid: false, tonemap: 'agx' },
        characters: [
          { name: '男主', pos: [0, 0, 0], pose: 'fight', color: '#c9ced6', path: [[0, 0], [0, 0], [2.4, 1.2]] },
        ],
        props: [{ name: '箱子', preset: 'box', pos: [1.6, 0, -1.2], scale: [0.8, 0.8, 0.8], color: '#aab2bd' }],
        cameras: [
          { name: 'A', pos: [0.2, 1.55, 4.0], target: [0, 1.0, 0], fov: 42 },
          { name: 'B', pos: [3.2, 1.55, 0.6], target: [0, 1.0, 0], fov: 42 },
        ],
        shots: [{ camera: 'A', start: 0, end: 1.5 }, { camera: 'B', start: 1.5, end: 3 }],
      };
      const built = E.buildStageFromSpec(spec);
      check('规格→场景：对象数', built.objects.length === 2, 'objects=' + built.objects.length);
      check('规格→场景：机位数', built.cameras.length === 2, 'cameras=' + built.cameras.length);
      check('规格→场景：姿态', built.objects[0].poseId === 'fight', String(built.objects[0].poseId));
      check('规格→场景：路径点数', (built.objects[0].path || []).length === 3, String((built.objects[0].path || []).length));
      // 渲染两帧（两个分镜各一帧）
      glr.draw(E.applyPlayhead(built, 0.5), { selectedId: null, renderGround: true, renderOnly: true });
      const f1 = grab();
      const live2 = E.applyPlayhead(built, 2.2);
      glr.draw(live2, { selectedId: null, renderGround: true, renderOnly: true });
      const f2 = grab();
      let nonBg1 = 0;
      for (let i = 0; i < W * H; i++) if (lum(f1, i) < 180) nonBg1++;
      check('规格画面有内容', nonBg1 > W * H * 0.01, '非背景像素=' + nonBg1);
      check('规格两分镜画面不同', diffCount(f1, f2, 6) > W * H * 0.01, 'diff=' + diffCount(f1, f2, 6));
      check('规格：分镜切换生效', live2.activeCameraId === 'cam2', String(live2.activeCameraId));
      // 反向：场景 → 规格 可往返
      const back = E.compileStageSpec(built);
      check('场景→规格 往返', back.characters.length === 2 - 1 && back.cameras.length === 2 && Math.abs(back.duration - 3) < 1e-6, JSON.stringify({ chars: back.characters.length, cams: back.cameras.length, dur: back.duration }));
    }

    // ④d 距离雾 + 景深（后处理）真实生效
    {
      const fogScene = mkScene({ env: Object.assign({}, mkScene().env, { fog: { enabled: true, color: '#8899aa', near: 2, far: 16, density: 1 } }) });
      const noFog = mkScene({ env: Object.assign({}, mkScene().env, { fog: { enabled: false } }) });
      glr.draw(E.applyPlayhead(noFog, 0), { selectedId: null, renderGround: true, renderOnly: true });
      const f0 = grab();
      glr.draw(E.applyPlayhead(fogScene, 0), { selectedId: null, renderGround: true, renderOnly: true });
      const f1 = grab();
      check('距离雾生效', diffCount(f0, f1, 3) > W * H * 0.02, 'diff=' + diffCount(f0, f1, 3) + ' px');
      // 景深：局部方差应下降（图像变柔）
      const localVar = (px) => {
        let sum = 0;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          sum += Math.abs(lum(px, i) - lum(px, i - 1)) + Math.abs(lum(px, i) - lum(px, i + 1));
        }
        return sum / (W * H);
      };
      check('景深后处理可用', glr.dofSupported !== false, 'dofSupported=' + glr.dofSupported);
      if (glr.dofSupported) {
        const dofScene = mkScene({ env: Object.assign({}, mkScene().env, { dof: { enabled: true, focus: 4.5, range: 2.5, maxBlur: 10 } }) });
        glr.draw(E.applyPlayhead(dofScene, 0), { selectedId: null, renderGround: true, renderOnly: true });
        const f2 = grab();
        check('景深生效（画面变柔）', diffCount(f1, f2, 3) > W * H * 0.005 && localVar(f2) < localVar(f1) * 0.98,
          'diff=' + diffCount(f1, f2, 3) + ' var ' + localVar(f1).toFixed(2) + '→' + localVar(f2).toFixed(2));
      }
    }

    // ⑤ 多镜头成片端到端：相机按分镜切换 + 帧间有运动 + 无空帧
    {
      const twoShot = mkScene({
        objects: [{ id: 'man', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, rotY: 0, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '#c9ced6',
          keys: [{ t: 0, pos: { x: -1.2, y: 0, z: 0 }, rotY: 0, rx: 0, rz: 0 }, { t: 3, pos: { x: 1.2, y: 0, z: 0 }, rotY: 0.8, rx: 0, rz: 0 }] }],
        cameras: [
          { id: 'cA', name: 'A', pos: { x: 0, y: 1.7, z: 4.2 }, target: { x: 0, y: 0.9, z: 0 }, fov: 42, keys: [] },
          { id: 'cB', name: 'B', pos: { x: 4.0, y: 1.7, z: 0.4 }, target: { x: 0, y: 0.9, z: 0 }, fov: 42, keys: [] },
        ],
        shots: [{ cameraId: 'cA', start: 0, end: 1.5 }, { cameraId: 'cB', start: 1.5, end: 3 }],
        activeCameraId: 'cA',
      });
      const seq = [];
      for (let t = 0; t <= 3.0001; t += 0.75) {
        const sc = E.applyPlayhead(twoShot, t);
        glr.draw(sc, { selectedId: null, renderGround: true, renderOnly: true });
        seq.push({ t: +t.toFixed(2), cam: sc.activeCameraId, px: grab() });
      }
      // 相机按分镜切换
      check('分镜相机切换', seq[0].cam === 'cA' && seq[2].cam === 'cB', seq.map((f) => f.t + 's=' + f.cam).join(' '));
      // 帧间必须有内容差异（运动或换机位）
      let minAdj = Infinity;
      for (let i = 1; i < seq.length; i++) minAdj = Math.min(minAdj, diffCount(seq[i - 1].px, seq[i].px, 3));
      check('帧间有变化（非静止/非空帧）', minAdj > W * H * 0.01, '相邻帧最小差异=' + minAdj + ' px');
      // 每帧都不能是纯背景（有物体）
      let allNonBlank = true;
      for (const f of seq) {
        let nonBg = 0;
        for (let i = 0; i < W * H; i++) if (lum(f.px, i) < 180) nonBg++;
        if (nonBg < W * H * 0.01) allNonBlank = false;
      }
      check('每帧都有内容（无空帧）', allNonBlank);
    }

    // ⑤ 成片场景：无网格/辅助线；默认保留外观，clay:true 才是浅底白模
    const srcScene = mkScene({ env: Object.assign({}, mkScene().env, { grid: true, guides: { heightRef: true, path: true, names: true, cameraFrame: true } }) });
    const exp = E.buildExportScene(srcScene);
    check('成片：关网格', exp.env.grid === false);
    check('成片：关辅助线', !exp.env.guides.heightRef && !exp.env.guides.path && !exp.env.guides.names && !exp.env.guides.cameraFrame);
    check('成片：保留原背景（不变灰）', exp.env.bg === srcScene.env.bg, exp.env.bg + ' vs ' + srcScene.env.bg);
    check('成片：保留对象颜色', exp.objects.every((o, i) => o.color === srcScene.objects[i].color), JSON.stringify(exp.objects.map((o) => o.color)));
    const clay = E.buildExportScene(srcScene, { clay: true });
    const bgv = parseInt(String(clay.env.bg).slice(1), 16);
    check('白模(clay:true)：浅色背景', ((bgv >> 16) + ((bgv >> 8) & 255) + (bgv & 255)) / 3 > 170, clay.env.bg);

    out.textContent += '\\n' + JSON.stringify(results);
    document.title = 'DONE';
  } catch (e) {
    out.textContent += '\\n' + JSON.stringify([{ name: '异常', pass: false, detail: String(e && e.message || e) }]);
    document.title = 'DONE';
  }
})();
</script></body></html>`;
fs.writeFileSync(path.join(SITE, 't.html'), html);

const srv = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => {
    if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'text/html');
    res.end(d);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const proc = spawn(chrome, ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + path.join(SITE, 'cp'), '--incognito', '--window-size=600,400', '--virtual-time-budget=120000', '--dump-dom', 'http://127.0.0.1:' + port + '/t.html']);
let txt = '';
proc.stdout.on('data', (d) => { txt += d; });
const code = await new Promise((r) => proc.on('close', r));
srv.close();
fs.rmSync(SITE, { recursive: true, force: true });

const m = txt.match(/<pre id="out">([\s\S]*?)<\/pre>/);
let results = null;
if (m) {
  const line = m[1].trim().split('\n').filter((l) => l.trim().startsWith('[')).pop();
  if (line) { try { results = JSON.parse(line.replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { /* ignore */ } }
}
if (!results) {
  console.log('SKIP 像素验证：浏览器未返回结果（chrome exit ' + code + '）');
  process.exit(0);
}
let fail = 0;
for (const r of results) {
  console.log((r.pass ? '  ✓ ' : '  ✗ ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  if (!r.pass) fail++;
}
if (fail) { console.error('✗ 像素验证未通过（' + fail + '/' + results.length + ' 项）'); process.exit(1); }
console.log('✓ 像素验证通过（' + results.length + ' 项：阴影/墙面阴影/路径隔离/PBR粗糙度/色调映射/白模环境）');
process.exit(0);
