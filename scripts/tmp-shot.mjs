// CDP 截图驱动（临时）：连接无头 Edge，驱动 GUI 打开无限画布并截图（跑完即删）
// 用法: node scripts/tmp-shot.mjs <cdpPort> <outDir>
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const port = process.argv[2] || '9223';
const outDir = process.argv[3] || 'docs/images';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[shot]', ...a);

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
await new Promise((r) => { ws.onopen = r; });
log('cdp connected');
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++seq; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${outDir}/${name}`, Buffer.from(r.data, 'base64'));
  log('saved', name);
};
const clickByText = (txt, tag) => evaluate(`(() => {
  const want = ${JSON.stringify(txt)};
  const els = [...document.querySelectorAll(${JSON.stringify(tag || 'button, a, div, span, li')})]
    .filter((e) => e.offsetParent !== null && e.textContent.trim() === want);
  if (!els.length) return false;
  els[els.length - 1].click();
  return true;
})()`);
const dumpClickables = (limit = 60) => evaluate(`JSON.stringify([...document.querySelectorAll('button, a, [role=button], .dshic-btn, li')]
  .filter((e) => e.offsetParent !== null && e.textContent.trim() && e.textContent.trim().length < 30)
  .slice(0, ${limit}).map((e) => e.textContent.trim()))`);

await send('Page.enable');
await send('Runtime.enable');

// 1) 注入演示模型配置（供应商+模型+星标），让设置/节点下拉截图真实
const injected = await evaluate(`(() => {
  const cfg = {
    textLlm: { provider: '', model: '' },
    imageProviders: [{ id: 'p_img', name: 'sensenova', baseUrl: 'https://token.sensenova.cn/v1', apiKey: 'sk-****', extra: '', size: '', responseFormat: '', mode: 'generations', models: [{ id: 'm1', model: 'sensenova-u1.5-lite' }] }],
    videoProviders: [{ id: 'p_vid', name: 'relayrouter', url: 'https://api.relayrouter.ai/v1/video/generations', apiKey: 'sk-****', extra: '', outputFormat: 'mp4', generateAudio: true, protocol: 'generic', models: [{ id: 'm1', model: 'doubao-seedance-2-0-260128' }] }],
    imageStar: 'p_img|m1',
    videoStar: 'p_vid|m1',
    ttsApis: [], ttsApiId: '',
    lang: '', skillScript: '', skillStoryboard: ''
  };
  localStorage.setItem('dsh-ic:settings', JSON.stringify(cfg));
  return 'ok';
})()`);
log('inject settings:', injected);
await evaluate('location.reload()');
await sleep(4000);

// 2) 打开 插件 → 无限画布
log('sidebar:', JSON.stringify(await dumpClickables(40)));
log('click 插件:', await clickByText('插件'));
await sleep(1200);
log('plugin list:', JSON.stringify(await dumpClickables(50)));
const opened = await evaluate(`(() => {
  const els = [...document.querySelectorAll('*')].filter((e) => e.offsetParent !== null && e.childElementCount === 0 && /无限画布|Infinite Canvas/i.test(e.textContent.trim()));
  if (!els.length) return false;
  els[els.length - 1].click();
  return true;
})()`);
log('click infinite canvas:', opened);
await sleep(3500);
log('after open:', JSON.stringify(await dumpClickables(50)));
await shot('_flow-plugins.png');

// 3) 打开 时空邮递员 项目
log('click project:', await clickByText('时空邮递员'));
await sleep(5000);
const nodeCount = await evaluate(`document.querySelectorAll('.dshic-node').length`);
log('nodes on canvas:', nodeCount);
if (!nodeCount) {
  // 可能在项目列表：再点一次项目名/打开按钮
  await evaluate(`(() => { const els = [...document.querySelectorAll('*')].filter((e) => e.offsetParent !== null && /时空邮递员/.test(e.textContent) && e.childElementCount <= 2); if (els.length) { els[els.length - 1].click(); return true; } return false; })()`);
  await sleep(5000);
  log('nodes after retry:', await evaluate(`document.querySelectorAll('.dshic-node').length`));
}
await shot('_flow-canvas.png');
log('DONE-STAGE1');
