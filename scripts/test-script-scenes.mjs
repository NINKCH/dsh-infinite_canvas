#!/usr/bin/env node
/**
 * 剧本 → 场景切分回归（parseScriptScenes）：
 *  · 按分场标记（【场N】/ 场N：/ ## 场N / SCENE N）切分，标题提取；
 *  · 片尾清单剥离只认「最后一场末尾的纯清单行块」（人物/角色/场景/道具/地点 + 空行 + （终）/完）；
 *  · 场内的「人物：」行（每场格式的常见写法）绝不能被当作片尾清单——
 *    旧正则从场内首个「人物：」一路吞到结尾，曾把最后一场正文全部丢掉（只剩标题）。
 *
 * 运行：node scripts/test-script-scenes.mjs   退出码 0 = 通过；1 = 失败
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM（与 test-vendor-detect 同套路） ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), localStorage: lsStub, location: { href: 'http://localhost/' }, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true },
  document: {
    createElement: () => ({ style: {}, dataset: {}, children: [], appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }),
    addEventListener: noop, removeEventListener: noop, body: { appendChild: noop }, head: { appendChild: noop }, documentElement: { style: {} },
  },
  localStorage: lsStub, navigator: { language: 'zh-CN', userAgent: 'node' }, location: { href: 'http://localhost/' },
  setTimeout, clearTimeout, setInterval: (f) => setTimeout(f, 0), clearInterval: noop, queueMicrotask,
  fetch: () => Promise.reject(new Error('no-net')), console,
  performance: { now: () => Date.now() }, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop,
  TextEncoder, TextDecoder, URL, URLSearchParams, Promise, JSON, Math, Date, Number, String, Array, Object, Map, Set, Error, RegExp, parseInt, parseFloat, isNaN, isFinite, Buffer, Blob: class {},
};
sandbox.globalThis = sandbox;
sandbox.window.globalThis = sandbox.window;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
  plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
} catch (e) {
  console.error('✗ client.js 顶层执行失败：' + e.message);
  process.exit(1);
}
const SYNC = sandbox.window.__DSH_IC_SYNC__;
if (!SYNC || typeof SYNC.parseScriptScenes !== 'function') {
  console.error('✗ 缺少测试缝隙 __DSH_IC_SYNC__.parseScriptScenes');
  process.exit(1);
}
const parse = SYNC.parseScriptScenes;

// ---------- ① 场10 复现（用户实测）：最后一场自带「人物：」行，正文必须完整保留 ----------
const ep10 = [
  '【场9】码头仓库（夜）',
  '画面：仓库探照灯扫过水面。',
  '对白：',
  '沈无咎：船到了。',
  '',
  '【场10】沉宵司档案层（天亮·结案）',
  '人物：沈无咎、纪缡',
  '画面：',
  '（3.5s）空镜 35mm：雨停的桥，干地消失，路面全湿，车流重新涨上来。',
  '（3s）中景 50mm：档案层，案卷合上，压红色「结」章。',
  '对白：',
  '纪缡：报告我写。',
  '沈无咎：写"意外"。',
  '音效：印章闷响、雨停后的滴水。',
  '（终）',
].join('\n');
const s1 = parse(ep10);
ok(s1.length === 2, '① 应切出 2 场（实际 ' + s1.length + '）');
const last1 = s1[s1.length - 1];
ok(/【场10】/.test(last1.title), '① 末场标题提取正确');
ok(/空镜 35mm/.test(last1.text) && /案卷合上/.test(last1.text), '① 末场正文「画面」保留（旧正则会把正文全部吞掉）');
ok(/报告我写/.test(last1.text) && /写"意外"/.test(last1.text), '① 末场正文「对白」保留');
ok(/印章闷响/.test(last1.text) && /（终）/.test(last1.text), '① 末场正文「音效/（终）」保留');
ok(/人物：沈无咎、纪缡/.test(last1.text), '① 场内「人物：」行保留（它是每场格式的一部分，不是片尾清单）');
ok(s1[0].text.includes('船到了'), '① 非末场不受影响');

// ---------- ② 契约形态：末场正文后跟真正的片尾清单 → 剥离清单、保留正文 ----------
const epList = [
  '【场1】桥（夜）',
  '画面：雨。',
  '',
  '【场2】档案层（天亮）',
  '画面：案卷合上。',
  '对白：',
  '纪缡：报告我写。',
  '（终）',
  '人物：沈无咎、纪缡',
  '场景/道具：码头仓库、黑皮档案袋',
].join('\n');
const s2 = parse(epList);
ok(s2.length === 2, '② 应切出 2 场');
const last2 = s2[s2.length - 1];
ok(/案卷合上/.test(last2.text), '② 片尾剥离后正文保留');
ok(!/场景\/道具：/.test(last2.text), '② 片尾「场景/道具：」清单被剥离');
ok(!/\n人物：沈无咎、纪缡/.test(last2.text.slice(last2.text.indexOf('（终）'))), '② 片尾「人物：」清单被剥离');
ok(/（终）/.test(last2.text), '② （终）终止符保留在正文内');

// ---------- ③ 退化：末场只有标题 + 人物行 → 绝不剥到只剩标题 ----------
const s3 = parse(['【场1】桥（夜）', '画面：雨。', '', '【场2】档案层（天亮）', '人物：纪缡'].join('\n'));
const last3 = s3[s3.length - 1];
ok(/人物：纪缡/.test(last3.text), '③ 退化形态：标题+人物行完整保留（绝不剥到只剩标题）');

// ---------- ④ 四种分场标记都能识别 ----------
const marks = ['【场1】A', '场1：A', '## 场1 A', 'SCENE 1 A'];
for (const mk of marks) {
  const r = parse(mk + '\n画面：X。\n\n【场2】B\n画面：Y。');
  ok(r.length === 2 && /画面：X/.test(r[0].text), '④ 分场标记识别：' + mk.slice(0, 8));
}

// ---------- ⑤ 前导非场景文本（无分场标记）被忽略 ----------
const s5 = parse('全剧梗概：一个关于雨的故事。\n\n【场1】A\n画面：X。');
ok(s5.length === 1 && s5[0].text.includes('画面：X'), '⑤ 首个分场标记前的导语不产生幽灵场景');

if (errs.length) {
  console.error('✗ 剧本场景切分回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 剧本场景切分回归通过：分场标记 / 片尾清单只剥尾块 / 场内「人物：」行保留（最后一场正文零丢失）');
function noop() {}
