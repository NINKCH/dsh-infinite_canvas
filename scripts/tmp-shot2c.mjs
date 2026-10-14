// CDP Stage2c：读取插件页真实渲染文本（跑完即删）
import { writeFileSync } from 'node:fs';
const port = process.argv[2] || '9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[s2c]', ...a);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value; };
await send('Page.enable');
await send('Runtime.enable');
log('url:', await evaluate('location.href'));
const text = await evaluate('document.body.innerText.slice(0, 2500)');
log('PAGE TEXT:\n' + text);
// 点「官方」展开官方插件列表
const clicked = await evaluate(`(() => { const els = [...document.querySelectorAll('*')].filter((e) => e.offsetParent !== null && /^官方/.test(e.textContent.trim()) && e.textContent.trim().length < 12); if (!els.length) return false; els[els.length - 1].click(); return true; })()`);
log('click 官方:', clicked);
await sleep(2000);
const text2 = await evaluate('document.body.innerText');
log('HAS 无限画布:', /无限画布/.test(text2));
log('PAGE TEXT2:\n' + text2.slice(0, 2500));
