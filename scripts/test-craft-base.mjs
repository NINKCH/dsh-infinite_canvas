// BLK-02 定向单测：画布↔ArtCraft 调用必须带 base（项目绝对目录），绝不发「无 base 的相对 rel」。
// 运行：node scripts/test-craft-base.mjs
// 套路同 test-download-ext.mjs：假 React + 桩 DOM 在 vm 里加载 client.js，经冒烟缝隙取纯函数。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const noop = () => {};
const elStub = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '',
  appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
  getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
  toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
const documentStub = {
  createElement: (tag) => {
    const el = elStub();
    if (tag === 'canvas') el.captureStream = () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] });
    return el;
  },
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null,
  addEventListener: noop, removeEventListener: noop,
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-craft-base', clipboard: { writeText: async () => {} } },
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

const C = sandbox.window.__DSH_IC_CRAFT__;
ok(C && typeof C.joinLocal === 'function', '冒烟缝隙未暴露 window.__DSH_IC_CRAFT__.joinLocal');
ok(C && typeof C.craftFolderOf === 'function', '冒烟缝隙未暴露 window.__DSH_IC_CRAFT__.craftFolderOf');
ok(C && typeof C.craftBaseDirRequired === 'function', '冒烟缝隙未暴露 craftBaseDirRequired');
const joinLocal = (C && C.joinLocal) || (() => 'MISSING');
const craftFolderOf = (C && C.craftFolderOf) || (() => 'MISSING');

// ---------------- 1) 目录拼接：base 绝对 + 相对 path ----------------
const B = 'D:\\data\\canvas-data\\projects\\时空邮递员';
ok(joinLocal(B, 'craft/media/a.png') === B + '\\craft\\media\\a.png', 'joinLocal(base, 相对路径) 结果不对：' + joinLocal(B, 'craft/media/a.png'));
ok(joinLocal(B, '/craft/timeline.xml') === B + '\\craft\\timeline.xml', 'joinLocal 未去掉前导斜杠：' + joinLocal(B, '/craft/timeline.xml'));
ok(joinLocal(B + '\\', 'craft/out/final.mp4') === B + '\\craft\\out\\final.mp4', 'joinLocal 未处理 base 尾部反斜杠：' + joinLocal(B + '\\', 'craft/out/final.mp4'));
ok(joinLocal('C:/x/y', 'craft/a.txt') === 'C:\\x\\y' + '\\craft\\a.txt', 'joinLocal 未统一正斜杠');
ok(craftFolderOf(B) === '时空邮递员', 'craftFolderOf 未取到末段文件夹：' + craftFolderOf(B));
ok(craftFolderOf(B + '/') === '时空邮递员', 'craftFolderOf 未处理尾部斜杠：' + craftFolderOf(B + '/'));

// ---------------- 2) 契约断言：不再有「无 base 的相对 rel」调用 ----------------
const badPatterns = [
  [/'\/fs\?action=write&rel='/, '仍存在无 base 的写调用（?action=write&rel=）'],
  [/'\/fs\?op=readtext&rel='/, '仍存在无 base 的读调用（?op=readtext&rel=）'],
  [/'\/file\?rel='/, '仍存在无 base 的产物回收调用（/file?rel=）'],
];
for (const [re, msg] of badPatterns) ok(!re.test(src), msg);
// craft 对象的四个文件方法都必须收 base 参数
const craftObj = src.slice(src.indexOf('const craft = {'), src.indexOf('async function probeCraft'));
for (const [sig, label] of [
  ['write: async (base, rel, blob)', 'craft.write 未改为 (base, rel, blob)'],
  ['writeText: async (base, rel, text)', 'craft.writeText 未改为 (base, rel, text)'],
  ['readText: async (base, rel)', 'craft.readText 未改为 (base, rel)'],
  ['file: async (base, rel)', 'craft.file 未改为 (base, rel)'],
]) ok(craftObj.includes(sig), label);
// 调用点必须带 base
ok(/craft\.write\(base, rel, blob\)/.test(src), 'syncAssetToDisk 未用 base+相对路径写入');
ok(/craft\.writeText\(base, 'craft\/timeline\.xml'/.test(src), 'timeline.xml 未用 base+相对路径写入');
ok(/craft\.file\(base, outRel\)/.test(src), '产物回收未带 base');
// job 必须带 cwd（ArtCraft 侧 ensureDir(cwd) 建目录、outputs 相对它解析）
ok(/craft\.jobStart\(\{\s*\n?\s*bin: 'photocraft',\s*\n?\s*cwd: base/m.test(src), 'PhotoCraft jobStart 未带 cwd: base');
ok(/jobStart\(\{ bin: 'filmcraft', cwd: base,/.test(src), 'FilmCraft jobStart 未带 cwd: base');
// 不再依赖 ArtCraft 的 dataRoot（0.3.x 已无该字段）
ok(!/st\.dataRoot/.test(src), '仍有人读 ArtCraft status 的 dataRoot（该字段已不存在）');
ok(!/data\.dataRoot/.test(src), '仍有人读 /status 的 dataRoot');
// slug 目录基准必须消失（Host 与 ArtCraft 都无法可靠重建）
ok(!/craftProjectSlug/.test(src), '仍存在 craftProjectSlug（slug 目录基准应已弃用）');
ok(!/function slugifyName/.test(src), '仍存在 slugifyName');
// 未配置数据根时必须明确失败，而不是退回相对路径
ok(/未设置画布数据根目录/.test(src), '取不到项目目录时缺少明确错误文案');

// ---------------- 3) 行为断言：宿主返回项目目录时可解析；不可用时抛明确错误 ----------------
{
  const hostRpcStub = async (method, args) => {
    if (method === 'projectDirGet') return { ok: true, projectId: args.projectId, abs: 'D:\\data\\canvas-data\\projects\\p_x', folder: 'p_x' };
    return {};
  };
  // 直接重跑一份带桩的 craftBaseDir：源码抽取 + 注入最小依赖
  const fnSrc = (() => {
    const start = src.indexOf('const craftBaseCache');
    const end = src.indexOf('/** 项目目录下的相对路径 → 本机绝对路径');
    return src.slice(start, end);
  })();
  ok(fnSrc.length > 0, '未能抽取 craftBaseDir 段源码');
  const S = { activeId: 'p_x' };
  const make = () => new Function('S', 'hostRpc', `${fnSrc}\nreturn { craftBaseDir, craftBaseDirRequired };`)(S, hostRpcStub);
  const api = make();
  const abs = await api.craftBaseDir('p_x');
  ok(abs === 'D:\\data\\canvas-data\\projects\\p_x', 'craftBaseDir 未返回宿主给的项目目录：' + abs);
  let threw = null;
  const badHost = async () => ({ ok: false, error: '未设置数据根目录' });
  const api2 = new Function('S', 'hostRpc', `${fnSrc}\nreturn { craftBaseDir, craftBaseDirRequired };`)(S, badHost);
  try { await api2.craftBaseDirRequired('p_x'); } catch (e) { threw = e; }
  ok(!!threw && /未设置画布数据根目录/.test(String(threw && threw.message)), '取不到项目目录时未抛出明确错误（不得静默回落）');
}

if (errs.length) {
  console.error('✗ BLK-02 验证未通过（' + errs.length + '）：');
  errs.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('✓ BLK-02 验证通过：ArtCraft 调用一律 base(项目绝对目录)+相对 path，无 base 的相对 rel 已清零');
process.exit(0);
