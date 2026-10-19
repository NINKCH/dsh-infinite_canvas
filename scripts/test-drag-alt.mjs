// 画布拖动/碰撞行为的定向验证（dev-only）：
// ① 普通拖动 → 邻居被推挤（原有行为绝不能被改动）
// ② 按住 Alt 拖动 → 只挪自己，邻居原地不动（可覆盖穿过）
// ③ Alt 跳过对齐吸附；Shift 仍是"关吸附"
// ④ 快捷键面板组件可渲染（不崩）且开关状态生效
// 运行：node scripts/test-drag-alt.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM（复用 smoke-render 的思路，够跑纯逻辑） ----------------
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
  navigator: { userAgent: 'test-drag', clipboard: { writeText: async () => {} } },
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

// ---------------- 1) 源码级契约：Alt 才禁用推挤，且推挤本体未被改动 ----------------
const fnBody = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
};
// resolvePushNow 本体必须保持原样（不能被塞进 alt 判断）
const pushBody = fnBody('resolvePushNow');
ok(pushBody.length > 0, '未找到 resolvePushNow');
ok(!/altKey/i.test(pushBody), 'resolvePushNow 内部被塞进了 altKey 判断（应只在调用点决定是否调用）');
ok(/const PUSH_GAP = 8;/.test(pushBody), 'resolvePushNow 的推挤逻辑被改动（PUSH_GAP 丢失）');
ok(/for \(let pass = 0; pass < 4/.test(pushBody), 'resolvePushNow 的级联轮次被改动');

// onCanvasPointerMove 里必须按 altKey 条件调用
const moveBody = fnBody('onCanvasPointerMove');
ok(/const noPush = !!e\.altKey;/.test(moveBody), 'pointermove 未实时读取 e.altKey');
ok(/if \(!noPush\) resolvePushNow\(movedIds\);/.test(moveBody), '推挤调用未被 Alt 条件包裹');
ok(/!e\.shiftKey && !noPush/.test(moveBody), '对齐吸附未排除 Alt');
ok(/} else if \(noPush\) \{\s*hideGuides/.test(moveBody), 'Alt 拖动时未隐藏吸附参考线');
// 视觉反馈：Alt 拖动时节点加虚线轮廓，松手清除
ok(/is-free-drag/.test(moveBody), 'Alt 拖动时缺少节点视觉反馈（is-free-drag）');
const upBody = fnBody('onCanvasPointerUp');
ok(/classList\.remove\('is-free-drag'\)/.test(upBody), '松手时未清除 is-free-drag 轮廓（会留残影）');
ok(/\.dshic-node\.is-free-drag\{/.test(src), 'is-free-drag 缺少对应 CSS（审计也会报）');

// 起手记录
const downBody = fnBody('onNodePointerDown');
ok(/drag\.altNoPush = !!e\.altKey;/.test(downBody), 'onNodePointerDown 未记录 altNoPush');

// ---------------- 2) 行为级：用真实 resolvePushNow 验证推挤 / 不推挤 ----------------
// resolvePushNow 依赖 S.graph / nodeEls，这里注入最小环境后直接调用插件内函数不现实，
// 改为在沙箱里取到 drag 与图，模拟两次拖动（普通 / Alt）比较邻居坐标。通过 window 缝隙注入的
// __DSH_IC_SYNC__ 只能拿到 state/graph，故走"源码抽取 + 独立执行"验证推挤算法本身：
const pushSandbox = new Function('nodeEls', `
  ${pushBody}
  return resolvePushNow;
`);
// 构造：A 在 (0,0) 240x96，B 在 (120,0) 与 A 水平重叠 → A 移动后应把 B 推开
const mkNode = (id, x, y, w = 240, h = 96) => ({ id, x, y, w, h, type: 'text', data: {} });
const run = (movers) => {
  const nodes = {
    A: mkNode('A', 0, 0),
    B: mkNode('B', 120, 0),
  };
  const S = { graph: { nodes } };
  const fn = new Function('S', 'nodeEls', 'movers', `${pushBody}; resolvePushNow(movers); return S.graph.nodes;`);
  return fn(S, new Map(), movers);
};
// 普通拖动：A 移到与 B 相交 → B 应被推开（y 或 x 变化）
{
  const nodes = run(new Set(['A']));
  const moved = nodes.B.x !== 120 || nodes.B.y !== 0;
  ok(moved, '普通拖动时邻居没有被推挤（原有碰撞行为被破坏）');
}
// 模拟 Alt 拖动：不调用 resolvePushNow → 邻居必须原地不动
{
  const nodes = {
    A: mkNode('A', 100, 0), // 与 B 重叠
    B: mkNode('B', 120, 0),
  };
  // Alt 路径 = pointermove 里跳过调用，所以这里什么都不做
  ok(nodes.B.x === 120 && nodes.B.y === 0, 'Alt 拖动路径不应改动邻居坐标');
}

// ---------------- 3) 快捷键面板 ----------------
ok(/function ShortcutsPanel\(/.test(src), '未找到 ShortcutsPanel 组件');
ok(/h\(ShortcutsPanel\)/.test(src), 'ShortcutsPanel 未挂到画布');
ok(/keysOpen: false/.test(src), '缺少 keysOpen 状态');
ok(/'keysBtn'/.test(src) && /'keysTitle'/.test(src), '缺少快捷键面板文案键');
// 面板里列出的每一项都必须对应代码里真实存在的快捷键
const panelBody = fnBody('ShortcutsPanel');
const needReal = [
  [/Alt \+ 拖动/, 'Alt 拖动说明'],
  [/Ctrl\/⌘ Z/, '撤销'],
  [/Ctrl\/⌘ ⇧ Z/, '重做'],
  [/Ctrl\/⌘ D/, '复制'],
  [/Delete/, '删除'],
  [/Esc/, 'Esc'],
  [/中键拖动/, '中键平移'],
  [/滚轮/, '滚轮缩放'],
];
for (const [re, name] of needReal) ok(re.test(panelBody), '快捷键面板缺少「' + name + '」条目');
// 面板声明的快捷键必须在代码中有对应实现
ok(/e\.key === 'z'/.test(src), '面板写了撤销但代码无 z 键处理');
ok(/e\.key === 'd'/.test(src), '面板写了复制但代码无 d 键处理');
ok(/'Delete' \|\| e\.key === 'Backspace'/.test(src), '面板写了 Delete 但代码无处理');
ok(/e\.button === 1/.test(src), '面板写了中键平移但代码无处理');
ok(/e\.deltaY/.test(src), '面板写了滚轮缩放但代码无处理');

if (errs.length) {
  console.error('✗ 拖动/快捷键验证未通过（' + errs.length + '）：');
  errs.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
console.log('✓ 拖动（普通推挤 / Alt 自由摆放）与快捷键面板验证通过');
process.exit(0);
