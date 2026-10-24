// 正式回归：真实浏览器里的导演台端到端契约
//   分镜机位切换 / 隐藏对象不出面片 / 骨骼动画循环 / 规格往返保真 / 提示词景别中英映射 / UI 入口齐备
// 无 Chrome 时 SKIP（与其他浏览器测试一致）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.log('SKIP 未找到 Chrome，跳过浏览器端到端（其余测试已覆盖逻辑层）'); process.exit(0); }

const SITE = path.join(os.tmpdir(), 'dsh-dir-e2e-' + Date.now().toString(36));
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'models'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets/director/engine.js'), path.join(SITE, 'engine.js'));
for (const f of fs.readdirSync(path.join(ROOT, 'assets/director/models'))) {
  fs.copyFileSync(path.join(ROOT, 'assets/director/models', f), path.join(SITE, 'models', f));
}
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const actions = [...new Set([...cli.matchAll(/'data-action': '([a-z0-9-]+)'/g)].map((m) => m[1]))];

const html = `<!doctype html><html><head><meta charset="utf-8"><title>INIT</title></head><body><pre id="out">boot</pre>
<script type="module">
const out=document.getElementById('out'); const done=(t,o)=>{out.textContent+='\\n'+JSON.stringify(o);document.title=t;};
(async()=>{
 try{
  const E=await import('./engine.js?v='+Date.now());
  E.registerGltfAsset('xbot',E.decodeModelPack(await(await fetch('./models/xbot.json')).json()));
  const W=560,H=420;
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;
  const glr=E.createDirectorGlRenderer(cv); glr.resize(W,H);
  const sc=E.directorDefaultScene('E2E');
  sc.cameras.push({ id:'cam2', name:'机位2', pos:E.v3(3,1.5,1.2), target:E.v3(0,1,0), fov:38, roll:0.15, keys:[] });
  sc.shots=[{id:'s1',cameraId:'cam1',start:0,end:2},{id:'s2',cameraId:'cam2',start:2,end:4}];
  sc.objects.push({ id:'hidden1', name:'隐藏道具', kind:'geom', preset:'box', pos:E.v3(1.5,0,1), scale:E.v3(0.5,0.5,0.5), visible:false });
  const drawAt=(t)=>{const live=E.applyPlayhead(sc,t); glr.draw(live,{selectedId:null,gizmo:true,renderGround:true});return live;};
  const l0=drawAt(0), l2=drawAt(2);
  const camSwitch = l0.activeCameraId==='cam1' && l2.activeCameraId==='cam2';
  const hiddenFaces = E.directorObjectFaces(sc.objects.find(o=>o.id==='hidden1')).length;
  const a=E.gltfAssetOf('xbot');
  const hash=(t)=>{const sk=E.skinModel(a,'run',t,null,null,{});let h=0;for(let i=0;i<sk.pos.length;i+=97)h=(h*31+Math.round(sk.pos[i]*1000))|0;return h;};
  const animLoops = hash(1)!==hash(2) && hash(0.1)===hash(0.7+0.1);
  sc.shot.shotSize='medium_close'; sc.shot.cameraMove='push_in';
  const spec=E.compileStageSpec(sc); const back=E.buildStageFromSpec(JSON.parse(JSON.stringify(spec)));
  const specOK = spec.shot.shotSize==='medium_close' && back.shot.shotSize==='medium_close'
    && back.objects.some(o=>o.visible===false) && back.objects.some(o=>o.scale && Math.abs(o.scale.x-0.5)<1e-6)
    && back.cameras.every(c=>c.sensorX===36);
  const prompt=E.compileDirectorPrompt(sc,{zh:true});
  const promptEN=E.compileDirectorPrompt(sc,{zh:false});
  const promptOK = prompt.includes('近景') && !prompt.includes('medium_close') && /medium close/i.test(promptEN) && !/推近/.test(promptEN);
  done((camSwitch&&hiddenFaces===0&&animLoops&&specOK&&promptOK)?'PASS':'FAIL', {camSwitch,hiddenFaces,animLoops,specOK,promptOK});
 }catch(e){done('FAIL',{err:String(e&&e.message||e)});}
})();
</script></body></html>`;
fs.writeFileSync(path.join(SITE, 't.html'), html);
const srv = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'text/html'); res.end(d); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const proc = spawn(CHROME, ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + path.join(SITE, 'cp'), '--incognito', '--window-size=700,600', '--virtual-time-budget=90000', '--dump-dom', 'http://127.0.0.1:' + port + '/t.html']);
let txt = ''; proc.stdout.on('data', (d) => { txt += d; });
await new Promise((r) => proc.on('close', r));
srv.close();
fs.rmSync(SITE, { recursive: true, force: true });

const title = (txt.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const m = txt.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const line = m ? m[1].trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() : null;

const MUST = ['dir-obj-vis', 'dir-cam-roll', 'dir-shot-del-at', 'dir-shot-start', 'dir-shot-end', 'dir-export-cancel', 'dir-loco-source', 'dir-spec-apply', 'dir-marker-add', 'dir-key-ease', 'dir-loop'];
const missing = MUST.filter((a) => !actions.includes(a));
const errs = [];
if (title !== 'PASS') errs.push('浏览器端到端结果为 ' + title + '：' + (line || '(无输出)'));
if (missing.length) errs.push('缺少关键 UI 入口：' + missing.join(', '));
if (errs.length) {
  console.error('✗ 导演台浏览器端到端未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 导演台浏览器端到端通过（分镜机位切换 / 隐藏对象不出面片 / 骨骼动画循环 / 规格往返保真 / 提示词中英景别 / ' + actions.length + ' 个 UI 入口）');
process.exit(0);
