// CDP 截图驱动 Stage2：选工作区 → canvasOpen(时空邮递员) → 截总览与节点细节（跑完即删）
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const port = process.argv[2] || '9223';
const outDir = process.argv[3] || 'docs/images';
const PID = 'pmv54zuhu6zky';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[s2]', ...a);

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${outDir}/${name}`, Buffer.from(r.data, 'base64')); log('saved', name); };
const clickByText = (txt) => evaluate(`(() => {
  const els = [...document.querySelectorAll('button, a, div, span, li')].filter((e) => e.offsetParent !== null && e.textContent.trim() === ${JSON.stringify(txt)});
  if (!els.length) return false;
  els[els.length - 1].click();
  return true;
})()`);

await send('Page.enable');
await send('Runtime.enable');

// 1) 选中工作区（进入会话视图）
log('click workspace:', await clickByText('deepseek-plugin'));
await sleep(3000);
log('view:', JSON.stringify(await evaluate(`JSON.stringify([...document.querySelectorAll('button, [role=button], .dshic-btn, li, span, div')].filter((e) => e.offsetParent !== null && e.textContent.trim() && e.textContent.trim().length < 24).slice(0, 50).map((e) => e.textContent.trim()))`).then(JSON.parse)).slice(0, 600));

// 2) 宿主侧触发 canvasOpen（客户端轮询后会自动打开该项目画布）
const m = await import('../index.js');
await m._internals.canvasOpen({ projectId: PID });
log('canvasOpen requested for', PID);
await sleep(9000);
log('nodes:', await evaluate(`document.querySelectorAll('.dshic-node').length`));
await shot('_flow-canvas.png');
log('DONE-STAGE2');
