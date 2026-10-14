// CDP Stage2b：在插件页找无限画布卡片并打开（跑完即删）
import { writeFileSync } from 'node:fs';
const port = process.argv[2] || '9223';
const outDir = process.argv[3] || 'docs/images';
const PID = 'pmv54zuhu6zky';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[s2b]', ...a);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${outDir}/${name}`, Buffer.from(r.data, 'base64')); log('saved', name); };
await send('Page.enable');
await send('Runtime.enable');

// 找包含「无限画布」文本的元素及附近可点击内容
const probe = await evaluate(`(() => {
  const hits = [...document.querySelectorAll('*')].filter((e) => e.offsetParent !== null && e.childElementCount === 0 && /无限画布/.test(e.textContent));
  return hits.map((e) => {
    let p = e; let chain = [];
    for (let k = 0; k < 4 && p; k++) { chain.push(p.tagName + '.' + String(p.className).slice(0, 60)); p = p.parentElement; }
    return { text: e.textContent.trim().slice(0, 40), chain };
  });
})()`);
log('hits:', JSON.stringify(probe).slice(0, 800));

// 点击卡片（从文本元素向上找可点击容器）
const clicked = await evaluate(`(() => {
  const hit = [...document.querySelectorAll('*')].find((e) => e.offsetParent !== null && e.childElementCount === 0 && /无限画布/.test(e.textContent));
  if (!hit) return 'no-hit';
  let p = hit;
  for (let k = 0; k < 6 && p; k++) {
    p = p.parentElement;
    if (!p) break;
    const btn = [...p.querySelectorAll('button')].find((b) => /打开|启动|进入|Open/i.test(b.textContent));
    if (btn) { btn.click(); return 'clicked-btn:' + btn.textContent.trim(); }
  }
  hit.click();
  return 'clicked-text';
})()`);
log('open action:', clicked);
await sleep(4000);
log('nodes:', await evaluate(`document.querySelectorAll('.dshic-node').length`));
await shot('_flow-open-plugin.png');

// 若画布已挂载：触发项目打开
const m = await import('../index.js');
await m._internals.canvasOpen({ projectId: PID });
await sleep(9000);
log('nodes after open:', await evaluate(`document.querySelectorAll('.dshic-node').length`));
const projVisible = await evaluate(`(() => { const els = [...document.querySelectorAll('*')].filter((e) => e.offsetParent !== null && /时空邮递员/.test(e.textContent)); return els.length; })()`);
log('project mentions:', projVisible);
await shot('_flow-canvas.png');
log('DONE');
