// 临时渲染服务器（跑完即删）：boot 页 + React/client.js + /infinite-canvas API 代理 → 127.0.0.1:3080
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const UP = 'http://127.0.0.1:3080';
const TOKEN = 'WTUsIWybMtlmBbCXy8j61cxAB87RYH0w0NrqfuKkONo';
const PORT = 18123;

const BOOT = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>IC</title>
<style>
:root{--dsw-alias-bg-base:#161616;--dsw-alias-bg-layer-1:#1e1e1e;--dsw-alias-bg-overlay:#222;--dsw-alias-label-primary:#e8e8e8;--dsw-alias-label-secondary:#9a9a9a;--dsw-alias-border-l1:#333;--dsw-alias-border-l2:#3a3a3a;--dsw-alias-brand-primary:#4f7cff;--dsw-alias-state-warn-primary:#e8a33d;--dsw-alias-state-error-primary:#e05252;--dsw-alias-bg-hover:rgba(255,255,255,.06);}
html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif;}
#app{height:100%;}
</style></head><body><div id="app">loading…</div>
<script>window.__DSH_IC_SMOKE__=true;window.__ModuleLoader__={load(def){window.__IC_DEF__=def;}};</script>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script src="/client.js"></script>
<script>
(function(){
  var params = new URLSearchParams(location.search);
  if (params.get('demo') === '1' && !localStorage.getItem('dsh-ic:settings')) {
    localStorage.setItem('dsh-ic:settings', JSON.stringify({
      textLlm:{provider:'',model:''},
      imageProviders:[{id:'p_img',name:'sensenova',baseUrl:'https://token.sensenova.cn/v1',apiKey:'sk-****',extra:'',size:'',responseFormat:'',mode:'generations',models:[{id:'m1',model:'sensenova-u1.5-lite'}]}],
      videoProviders:[{id:'p_vid',name:'relayrouter',url:'https://api.relayrouter.ai/v1/video/generations',apiKey:'sk-****',extra:'',outputFormat:'mp4',generateAudio:true,protocol:'generic',models:[{id:'m1',model:'doubao-seedance-2-0-260128'}]}],
      imageStar:'p_img|m1',videoStar:'p_vid|m1',ttsApis:[],ttsApiId:'',lang:'',skillScript:'',skillStoryboard:''
    }));
  }
  var plugin = window.__IC_DEF__.factory(function(name){ if (name === 'react') return React; throw new Error('require ' + name); });
  var roots = [];
  plugin.apply({ effect: function(f){ if (f) f(); }, locale: { register: function(){}, subscribe: function(){ return function(){}; } }, slots: { inject: function(n, cb){ if (cb) cb(); }, register: function(meta, Comp){ roots.push(Comp); } } });
  var root = ReactDOM.createRoot(document.getElementById('app'));
  root.render(React.createElement(roots[0]));
})();
</script></body></html>`;

// 预取 React UMD 到本地缓存
async function ensureReact() {
  for (const [file, url] of [
    ['react.js', 'https://unpkg.com/react@18.3.1/umd/react.production.min.js'],
    ['react-dom.js', 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js'],
  ]) {
    const p = path.join(ROOT, 'scripts', '_' + file);
    if (!existsSync(p)) {
      const r = await fetch(url);
      writeFileSync(p, Buffer.from(await r.arrayBuffer()));
      console.log('cached', file);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(BOOT); return; }
    if (u.pathname === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(path.join(ROOT, 'client.js'))); return; }
    if (u.pathname === '/react.js' || u.pathname === '/react-dom.js') { await ensureReact(); res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(path.join(ROOT, 'scripts', '_' + u.pathname.slice(1)))); return; }
    // 其余全部代理到 dsh web（附 token）
    const target = UP + u.pathname + u.search + (u.search ? '&' : '?') + 'token=' + TOKEN;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host; delete headers.referer; delete headers.origin;
    if (body.length) headers['content-length'] = String(body.length);
    const r2 = await fetch(target, { method: req.method, headers, body: body.length ? body : undefined });
    const buf = Buffer.from(await r2.arrayBuffer());
    const h2 = {};
    r2.headers.forEach((v, k) => { if (!/^content-encoding$|^transfer-encoding$|^content-length$/i.test(k)) h2[k] = v; });
    res.writeHead(r2.status, h2);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'proxy: ' + e.message }));
  }
});
server.listen(PORT, () => console.log('render server on http://127.0.0.1:' + PORT));
