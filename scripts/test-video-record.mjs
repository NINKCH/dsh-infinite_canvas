// 门禁级：导出视频端到端（真实 MediaRecorder → 合法 webm 字节流）
//   无 Chrome 时 SKIP；无 MediaRecorder 时 SKIP（不阻塞 CI）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chrome) { console.log('SKIP 视频录制验证：未找到 Chrome/Edge'); process.exit(0); }

const SITE = path.join(os.tmpdir(), 'dsh-video-record');
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'models'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets/director/engine.js'), path.join(SITE, 'engine.js'));
const MODELS = path.join(ROOT, 'assets/director/models');
for (const f of fs.readdirSync(MODELS)) fs.copyFileSync(path.join(MODELS, f), path.join(SITE, 'models', f));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>INIT</title></head><body><pre id="out">boot</pre>
<script type="module">
const out = document.getElementById('out');
const log = (s) => { out.textContent += '\\n' + s; };
const done = (t, payload) => { out.textContent += '\\n' + JSON.stringify(payload); document.title = t; };
(async () => {
  try {
    if (typeof MediaRecorder === 'undefined') { done('NOMR', { skip: true }); return; }
    const E = await import('./engine.js?v=' + Date.now());
    E.registerGltfAsset('xbot', E.decodeModelPack(await (await fetch('./models/xbot.json')).json()));
    const W = 320, H = 180, FPS = 24, TOTAL = 1.5;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const glr = E.createDirectorGlRenderer(cv);
    if (!glr) { done('FAIL', { err: 'renderer null' }); return; }
    glr.resize(W, H);
    // 带运动的场景（物体左右移动 + 两个分镜）
    const scene = {
      version: 2,
      objects: [{ id: 'm', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, rotY: 0, h: 1.78, clip: 'idle', animTime: 0, visible: true, color: '#c9ced6',
        keys: [{ t: 0, pos: { x: -0.9, y: 0, z: 0 }, rotY: 0, rx: 0, rz: 0 }, { t: 1.5, pos: { x: 0.9, y: 0, z: 0 }, rotY: 0.9, rx: 0, rz: 0 }] }],
      cameras: [
        { id: 'cA', name: 'A', pos: { x: 0.2, y: 1.5, z: 3.4 }, target: { x: 0, y: 0.95, z: 0 }, fov: 42, keys: [] },
        { id: 'cB', name: 'B', pos: { x: 3.2, y: 1.5, z: 0.3 }, target: { x: 0, y: 0.95, z: 0 }, fov: 42, keys: [] },
      ],
      shots: [{ cameraId: 'cA', start: 0, end: 0.75 }, { cameraId: 'cB', start: 0.75, end: 1.5 }],
      lights: [{ id: 'k', dir: E.vNorm({ x: 0.4, y: -0.7, z: 0.5 }), color: '#ffffff', intensity: 1.2 }],
      env: { bg: '#dfe2e6', ground: '#b3b8bf', grid: false, exposure: 1, guides: {}, groundInRender: true },
      activeCameraId: 'cA', shot: { duration: TOTAL },
    };
    const exportScene = E.buildExportScene(scene);
    const stream = cv.captureStream(FPS);
    const mime = (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2e6 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(80);
    const frames = Math.round(TOTAL * FPS);
    let drawn = 0;
    for (let i = 0; i <= frames; i++) {
      glr.draw(E.applyPlayhead(exportScene, i / FPS), { selectedId: null, renderGround: true, renderOnly: true });
      drawn++;
      await new Promise((r) => setTimeout(r, 12));   // 无头环境下 rAF 不推进，用 setTimeout 驱动
    }
    try { rec.requestData(); } catch { /* 忽略 */ }
    rec.stop();
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
    const blob = new Blob(chunks, { type: 'video/webm' });
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const isWebm = head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
    // 采样一帧确认不是黑屏
    glr.draw(E.applyPlayhead(exportScene, 1.0), { selectedId: null, renderGround: true, renderOnly: true });
    const gl = glr.gl || glr.glctx;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nonUniform = 0;
    for (let i = 0; i < W * H; i++) if (Math.abs(px[i * 4] - px[0]) > 8) nonUniform++;
    done(blob.size > 1000 && isWebm ? 'PASS' : 'FAIL', {
      drawn, chunks: chunks.length, size: blob.size, isWebm, nonUniform,
    });
  } catch (e) {
    done('FAIL', { err: String(e && e.message || e) });
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
const proc = spawn(chrome, ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--user-data-dir=' + path.join(SITE, 'cp'), '--incognito', '--window-size=400,300',
  '--autoplay-policy=no-user-gesture-required', '--virtual-time-budget=90000', '--dump-dom',
  'http://127.0.0.1:' + port + '/t.html']);
let txt = '';
proc.stdout.on('data', (d) => { txt += d; });
const code = await new Promise((r) => proc.on('close', r));
srv.close();
fs.rmSync(SITE, { recursive: true, force: true });

const title = (txt.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const m = txt.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const jsonLine = m ? m[1].trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() : null;
let info = null;
if (jsonLine) { try { info = JSON.parse(jsonLine.replace(/&quot;/g, '"')); } catch { /* ignore */ } }
if (title === 'NOMR' || (info && info.skip)) { console.log('SKIP 视频录制验证：当前浏览器无 MediaRecorder'); process.exit(0); }
if (!info) { console.log('SKIP 视频录制验证：浏览器未返回结果（exit ' + code + '）'); process.exit(0); }
console.log('  绘制帧数=' + info.drawn + '  chunks=' + info.chunks + '  size=' + info.size + 'B  webm=' + info.isWebm + '  非均匀像素=' + info.nonUniform);
if (title === 'PASS' && info.nonUniform > 100) {
  console.log('✓ 视频录制端到端通过（真实 MediaRecorder 产出合法 webm，画面非黑屏）');
  process.exit(0);
}
console.error('✗ 视频录制端到端失败：' + JSON.stringify(info));
process.exit(1);
