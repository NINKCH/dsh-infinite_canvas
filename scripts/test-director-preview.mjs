// 正式回归：实时渲染预览 == 成片（颜色材质保留 / 无辅助线 / 地面·阴影·太阳开关生效）
// 真实浏览器 + 真实 WebGL。无 Chrome 时 SKIP。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.log('SKIP 未找到 Chrome'); process.exit(0); }

const SITE = path.join(os.tmpdir(), 'dsh-preview-' + Date.now().toString(36));
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'models'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets/director/engine.js'), path.join(SITE, 'engine.js'));
for (const f of fs.readdirSync(path.join(ROOT, 'assets/director/models'))) fs.copyFileSync(path.join(ROOT, 'assets/director/models', f), path.join(SITE, 'models', f));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>INIT</title></head><body><pre id="out">boot</pre>
<script type="module">
const out=document.getElementById('out'); const errs=[]; const ok=(c,m)=>{if(!c)errs.push(m);};
  const done=(t,o)=>{out.textContent+='\\n'+JSON.stringify(o);document.title=t;};
(async()=>{
 try{
  const E=await import('./engine.js?v='+Date.now());
  E.registerGltfAsset('xbot',E.decodeModelPack(await(await fetch('./models/xbot.json')).json()));
  const W=480,H=320;
  const cv=document.createElement('canvas');cv.width=W;cv.height=H;
  const glr=E.createDirectorGlRenderer(cv); glr.resize(W,H);
  const gl=glr.gl||glr.glctx;
  const mk=(envPatch)=>({
    version:2,
    objects:[
      {id:'a',kind:'model',assetId:'xbot',typeId:'m_standard',pos:E.v3(-0.6,0,0),h:1.78,clip:'idle',animTime:0,visible:true,color:'#c25b4a',
       path:[{x:-2,y:0,z:0},{x:-2,y:0,z:0},{x:2,y:0,z:0}],pathMode:'linear'},
      {id:'b',kind:'geom',preset:'box',pos:E.v3(1.2,0,-0.6),scale:E.v3(0.8,0.8,0.8),visible:true,color:'#2f7d4f'},
    ],
    cameras:[{id:'c',pos:E.v3(0,1.7,5),target:E.v3(0,1,0),fov:44,keys:[]}],
    lights:[{id:'key',dir:E.vNorm({x:0.42,y:-0.6,z:0.55}),color:'#fff3dd',intensity:2.2},{id:'fill',dir:E.vNorm({x:-0.4,y:-0.3,z:-0.6}),color:'#cfe2ff',intensity:0.55}],
    env:Object.assign({preset:'daylight',bg:'#cfe0ee',ground:'#b9b0a6',grid:true,exposure:1.15,tonemap:'agx',
      guides:{heightRef:true,path:true,names:true,cameraFrame:true}}, envPatch||{}),
    activeCameraId:'c',shot:{duration:4},
  });
  const px=(envPatch)=>{
    const film=E.buildExportScene(mk(envPatch));   // 实时渲染与导出共用这条路径
    glr.draw(E.applyPlayhead(film,1),{selectedId:null,renderGround:true,renderOnly:true});
    const b=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;
  };
  const stats=(b)=>{let red=0,green=0,sum=0;for(let i=0;i<W*H;i++){const r=b[i*4],g=b[i*4+1],bl=b[i*4+2];sum+=(r+g+bl)/3;if(r>g+16&&r>bl+16)red++;else if(g>r+16&&g>bl+16)green++;}return {red,green,bright:sum/(W*H)};};
  const a=px(), b2=px();
  let same=0; for(let i=0;i<W*H;i++) if(Math.abs(a[i*4]-b2[i*4])>1) same++;
  const s=stats(a);
  const groundOn=px({groundInRender:true});
  const groundOff=px({groundInRender:false});
  let dGround=0; for(let i=0;i<W*H;i++) if(Math.abs(groundOn[i*4]-groundOff[i*4])>2) dGround++;
  const shOn=px({shadowOn:true});
  const shOff=px({shadowOn:false});
  let dShadow=0; for(let i=0;i<W*H;i++) if(Math.abs(shOn[i*4]-shOff[i*4])>3) dShadow++;
  // 太阳高度角：改变方向应改变亮度分布
  const sceneHi=mk(); sceneHi.lights[0].dir=E.vNorm({x:0.2,y:-0.95,z:0.2});
  const sceneLo=mk(); sceneLo.lights[0].dir=E.vNorm({x:0.9,y:-0.15,z:0.4});
  const drawScene=(sc)=>{glr.draw(E.applyPlayhead(E.buildExportScene(sc),1),{selectedId:null,renderGround:true,renderOnly:true});const b=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;};
  const hi=drawScene(sceneHi), lo=drawScene(sceneLo);
  let dSun=0; for(let i=0;i<W*H;i++) if(Math.abs(hi[i*4]-lo[i*4])>3) dSun++;
  // 辅助线剥离：guides 全开也必须不进入成片
  const film=E.buildExportScene(mk());
  const guidesClean = film.env.guides && !film.env.guides.path && !film.env.guides.names && !film.env.grid;
  // 影棚编辑视口：固定深色影棚风格，不随渲染参数（日光/地面/曝光/雾）变化
  const mkEnv=(patch)=>{const sc=mk();Object.assign(sc.env,patch);return sc;};
  const grabSc=(sc)=>{glr.draw(E.applyPlayhead(sc,1),{selectedId:null,renderGround:true,renderOnly:true});const b=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;};
  const studioA=grabSc(E.buildStudioScene(mkEnv({bg:'#cfe0ee',ground:'#b9b0a6',exposure:1.15,tonemap:'agx'})));
  const studioB=grabSc(E.buildStudioScene(mkEnv({bg:'#000000',ground:'#101010',exposure:2.4,tonemap:'srgb',fog:{enabled:true,color:'#ff0000',near:2,far:8,density:1}})));
  let studioDiff=0; for(let i=0;i<W*H;i++) if(Math.abs(studioA[i*4]-studioB[i*4])>2) studioDiff++;
  const studioEnv=E.buildStudioScene(mk()).env;
  const studioIsDark = studioEnv.bg === '#1a1e24' && studioEnv.grid === true && !studioEnv.fog && !studioEnv.dof;
  // 成片则必须随参数变化
  const filmA=grabSc(E.buildExportScene(mkEnv({bg:'#cfe0ee',exposure:1.15})));
  const filmB=grabSc(E.buildExportScene(mkEnv({bg:'#000000',exposure:2.4,tonemap:'srgb'})));
  let filmParamDiff=0; for(let i=0;i<W*H;i++) if(Math.abs(filmA[i*4]-filmB[i*4])>2) filmParamDiff++;
  ok(studioDiff===0, '静态/动态视口必须固定影棚风格（不随渲染参数变化），实际差异 ' + studioDiff + 'px');
  ok(studioIsDark, '影棚场景应为深色背景+网格+无雾无景深');
  ok(filmParamDiff>1000, '成片必须随渲染参数变化，实际差异 ' + filmParamDiff + 'px');

  done((errs.length===0&&s.red>150&&s.green>150&&s.bright>95&&same===0&&dGround>500&&dShadow>500&&dSun>500&&guidesClean)?'PASS':'FAIL',
    {errs,red:s.red,green:s.green,bright:+s.bright.toFixed(1),deterministic:same===0,groundPx:dGround,shadowPx:dShadow,sunPx:dSun,guidesClean,studioDiff,filmParamDiff,studioBg:studioEnv.bg});
 }catch(e){done('FAIL',{err:String(e&&e.message||e)});}
})();
</script></body></html>`;
fs.writeFileSync(path.join(SITE, 't.html'), html);
const srv = http.createServer((req, res) => { const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { res.statusCode = 404; return res.end('nf'); } res.setHeader('content-type', p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'text/html'); res.end(d); }); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const proc = spawn(CHROME, ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--user-data-dir=' + path.join(SITE, 'cp'), '--incognito', '--window-size=600,400', '--virtual-time-budget=90000', '--dump-dom', 'http://127.0.0.1:' + port + '/t.html']);
let txt = ''; proc.stdout.on('data', (d) => { txt += d; });
await new Promise((r) => proc.on('close', r));
srv.close();
const title = (txt.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const m = txt.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const line = m ? m[1].trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() : null;
fs.rmSync(SITE, { recursive: true, force: true });
if (title !== 'PASS') {
  console.error('✗ 实时渲染预览未通过：' + (line || title));
  process.exit(1);
}
console.log('✓ 实时渲染预览通过（预览=成片·颜色材质保留·地面/阴影/太阳开关生效·辅助线不进成片）');
process.exit(0);
