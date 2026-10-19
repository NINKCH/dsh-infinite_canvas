#!/usr/bin/env node
/**
 * IC-B3 回归：三套扩展名映射的分工契约（不是合并成一份，是**单一职责 + 零重复实现**）。
 *
 * 背景：IC-01 提测单带出的事实——client.js 曾并存三套 mime→扩展名逻辑且语义互相矛盾：
 *   extFromMime  （磁盘落盘，mime 子类型直取，image/jpeg → .jpeg）
 *   extForMime   （Craft 落盘，文件名优先，image/jpeg → .jpg）
 *   extForDownload（用户下载，mime 优先，final.2026 不得得到 .2026）
 * PM 裁决：下载侧必须同一函数（IC-01 已做）；三套并存登记 IC-B3 统一。
 * 本单结论：三者服务三个不同写入面，**语义本来就不同**，合并反而制造回归；
 * 统一 = 每个调用面只用自己那一套 + 文档写明分工 + 断言钉死边界（防未来互相"顺手复用"）。
 *
 * 断言：
 *   1) 每个调用面严格使用对应函数（源码级）：磁盘落盘 2 处→extFromMime；Craft 2 处→extForMime；下载 3 处→extForDownload
 *   2) 语义方向钉死：extForMime 文件名优先（final.2026 → .2026 合法）；extForDownload mime 优先（final.2026 → 按 mime/kind）
 *   3) extForDownload 的白名单兜底：`final.exe` 这类危险/无关扩展名不得通过名字兜底放行
 *   4) 分工注释存在（后续维护者能看到为什么是三套）
 *
 * 运行：node scripts/test-ext-mapping.mjs   退出码 0 = 通过；1 = 失败
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const noop = () => {};

// ---------------- 假 React / DOM（与 test-drag-alt 同套路） ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: {
    createElement: () => ({ style: {}, dataset: {}, children: [], appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }),
    createTextNode: (t) => ({ nodeValue: String(t) }),
    head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop }, documentElement: {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null, activeElement: null, addEventListener: noop,
  },
  localStorage: lsStub,
  navigator: { userAgent: 'test-ext', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  Image: class { constructor() { this.src = ''; } },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => ({ set onupgradeneeded(v) { void v; }, set onsuccess(v) { void v; }, set onerror(v) { void v; } }) },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
if (!mod) { console.error('✗ client.js 顶层执行失败'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} } });

const MEDIA = sandbox.window.__DSH_IC_MEDIA__;
ok(!!MEDIA && typeof MEDIA.extForDownload === 'function', '冒烟缝隙未暴露 __DSH_IC_MEDIA__');

// ---------------- 1) 调用面 ↔ 函数 的绑定（源码级，防"顺手复用"） ----------------
// 磁盘落盘（saveAssetRecord + autoMigrate）：必须用 extFromMime，不得用另外两套
const diskSites = [...src.matchAll(/\$\{assetFileBase\(rec\)\}\.\$\{(?:extFromMime|extForMime|extForDownload)\(([^)]*)\)\}/g)];
ok(diskSites.length >= 2, `磁盘落盘模板串应至少 2 处，实际 ${diskSites.length}`);
for (const [, args] of diskSites) {
  ok(/^\s*mime\s*\)$/.test(args.trim()) || /^\s*mime\b/.test(args), `磁盘落盘应只传 mime 给 extFromMime（实际：${args}）——落盘无名字兜底`);
  ok(!/extForMime|extForDownload/.test(args), '磁盘落盘混用了 Craft/下载映射：' + args);
}
// Craft 侧（syncAssetToDisk + PhotoCraft 产物）：必须用 extForMime（mime, name 两参）
const craftSites = [...src.matchAll(/extForMime\(([^)]*)\)/g)].filter(([, a]) => !/^mime,\s*name$/.test(a.trim()));
ok(craftSites.length >= 2, `Craft 侧应至少 2 处调用点，实际 ${craftSites.length}`);
for (const [, args] of craftSites) ok(/rec\.mime,\s*rec\.name/.test(args), `Craft 侧应传 (rec.mime, rec.name)：${args}`);
// 下载侧：必须用 extForDownload（2 直接调用点 + helper + 冒烟出口）
const dlSites = [...src.matchAll(/extForDownload\(([^)]*)\)/g)];
ok(dlSites.length >= 3, `下载侧应有 3 处以上（2 调用点 + helper），实际 ${dlSites.length}`);
for (const [, args] of dlSites) ok(!/extFromMime|extForMime\b/.test(args), '下载侧混用了落盘/Craft 映射：' + args);
console.log(`  ✓ 调用面绑定：磁盘 ${diskSites.length} 处→extFromMime；Craft ${craftSites.length} 处→extForMime；下载 ${dlSites.length} 处→extForDownload`);

// ---------------- 2) 语义方向钉死（行为级） ----------------
if (MEDIA) {
  const e = MEDIA.extForDownload;
  // mime 优先：final.2026 + video/mp4 → .mp4（绝不 .2026）
  ok(e('video/mp4', 'final.2026', 'video') === '.mp4', 'mime 优先失效：final.2026 + video/mp4 应得 .mp4');
  // 名字兜底只认白名单：final.2026 无 mime → kind 兜底 .mp4，不是 .2026
  ok(e('', 'final.2026', 'video') === '.mp4', '白名单外的名字后缀不得通过兜底放行');
  // 危险扩展名：final.exe 无 mime → kind 兜底，绝不 .exe
  ok(e('', 'setup.exe', 'image') === '.png', '危险名字后缀（.exe）必须被 kind 兜底拦下');
  // 合法名字兜底仍然工作：recording.webm 无 mime → .webm
  ok(e('', 'recording.webm', 'video') === '.webm', '白名单内的名字兜底应工作');
  // kind 兜底链
  ok(e('', '', 'audio') === '.mp3' && e('', '', 'text') === '.md' && e('', '', '') === '.bin', 'kind 兜底链错误');
  // mime 精确匹配
  ok(e('image/jpeg', '', '') === '.jpg' && e('video/quicktime', '', '') === '.mov' && e('text/markdown', '', '') === '.md', 'mime 精确表错误');
}
console.log('  ✓ extForDownload 语义：mime 优先 / 白名单外名字拦下 / kind 链');

// ---------------- 3) 源码级：extForMime 仍是文件名优先（Craft 依赖） ----------------
const body = (name) => {
  const start = src.indexOf('function ' + name + '(');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  return '';
};
ok(/fromName/.test(body('extForMime')) && src.indexOf('fromName') < src.indexOf('m.includes'), 'extForMime 的文件名优先顺序被改动（Craft 落盘依赖它）');
ok(body('extFromMime').includes("split('/')[1]"), 'extFromMime 的子类型直取实现被改动');
console.log('  ✓ extForMime 文件名优先 / extFromMime 子类型直取（实现未漂移）');

// ---------------- 4) 分工注释存在 ----------------
ok(/三套映射的分工/.test(src) || (/extFromMime/um.test(src) && /单一职责|分工/.test(src)), '缺少三套映射分工说明（下个维护者会再次合并它们）');
console.log('  ✓ 分工注释在位');

// ---------------- 汇总 ----------------
if (errs.length) {
  console.error('\n✗ 扩展名映射分工回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ 三套扩展名映射分工回归全部通过（IC-B3）');
process.exit(0); // client.js 的 3s 轮询 interval 会挂住事件循环
