// 真实浏览器：gizmo 绘制像素位置 == 拾取命中位置（含 DPR=2）
//   ① 画布按 DPR 放大（像素清晰度不被牺牲）
//   ② 三轴轴端：采样颜色对应该轴颜色 + 拾取返回该轴缩放手柄
//   ③ 手柄置顶：Z 指向相机时也不会被旋转环盖住
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.log('SKIP 未找到 Chrome'); process.exit(0); }

const SITE = path.join(os.tmpdir(), 'dsh-gizmo-px-' + Date.now().toString(36));
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets/director/engine.js'), path.join(SITE, 'engine.js'));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>INIT</title></head><body><pre id="out">boot</pre>
<script type="module">
const out=document.getElementById('out'); const done=(t,o)=>{out.textContent+='\\n'+JSON.stringify(o);document.title=t;};
(async()=>{
 try{
  const E=await import('./engine.js?v='+Date.now());
  const W=800,H=600,DPR=2;
  const cv=document.createElement('canvas');
  const glr=E.createDirectorGlRenderer(cv); glr.resize(W,H,DPR);
  const gl=glr.gl||glr.glctx;
  const cam={id:'c',pos:E.v3(1.2,1.8,4.5),target:E.v3(0,0.9,0),fov:42,keys:[]};
  const sel={id:'s',kind:'geom',preset:'box',pos:E.v3(0,0.9,0),scale:E.v3(0.6,1.8,0.6),rotY:0.3,visible:true,color:'#8fa4c8'};
  const scene={version:2,objects:[sel],cameras:[cam],lights:[],env:{bg:'#cfe0ee',ground:'#b9b0a6',grid:false,exposure:1.1,tonemap:'agx'},activeCameraId:'c',shot:{duration:3}};
  glr.draw(scene,{selectedId:'s',gizmo:true});
  const px=new Uint8Array(cv.width*cv.height*4);
  gl.readPixels(0,0,cv.width,cv.height,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const at=(sx,sy)=>{const x=Math.round(sx*DPR), y=Math.round((H-sy)*DPR); const i=((y*cv.width)+x)*4; return [px[i],px[i+1],px[i+2]];};
  const gm=E.gizmoMetrics(cam,sel,H);
  const ax=E.objectAxes(sel);
  const tips={};
  for(const [name,dir] of [['x',ax.x],['y',ax.y],['z',ax.z]]) tips[name]=E.directorScreenOf(cam,W,H,E.vAdd(gm.origin,E.vMul(dir,gm.L)));
  const report=[];
  for(const [name,col] of [['x','red'],['y','green'],['z','blue']]){
    const tip=tips[name];
    const p=E.directorPickGizmo(scene,'s',W,H,tip.x,tip.y);
    const c=at(tip.x,tip.y);
    const dominant = col==='red' ? (c[0]>c[1]+25&&c[0]>c[2]+25) : col==='green' ? (c[1]>c[0]+25&&c[1]>c[2]+25) : (c[2]>c[0]+25&&c[2]>c[1]+25);
    report.push({name,pick:p&&p.op+':'+p.axis,color:c.join(','),dominant});
  }
  const okAll=report.every(r=>r.pick==='scale:'+r.name && r.dominant);
  done(okAll && cv.width===W*DPR && cv.height===H*DPR ? 'PASS':'FAIL',{canvasPx:cv.width+'x'+cv.height,report});
 }catch(e){done('FAIL',{err:String(e&&e.message||e)});}
})();
</script></body></html>`;
fs.writeFileSync(path.join(SITE, 't.html'), html);

const srv = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', p.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(d); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const proc = spawn(CHROME, ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + path.join(SITE, 'cp'), '--incognito', '--window-size=900,700', '--virtual-time-budget=60000', '--dump-dom', 'http://127.0.0.1:' + port + '/t.html']);
let txt = ''; proc.stdout.on('data', (d) => { txt += d; });
await new Promise((r) => proc.on('close', r));
srv.close();
const title = (txt.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const m = txt.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const line = m ? m[1].trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() : null;
fs.rmSync(SITE, { recursive: true, force: true });
if (title !== 'PASS') { console.error('✗ gizmo 像素对齐未通过：' + (line || title)); process.exit(1); }
console.log('✓ gizmo 像素对齐通过（DPR=2 画布 / 三轴轴端颜色与拾取一致 / 手柄置顶）');
process.exit(0);
