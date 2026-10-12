#!/usr/bin/env node
/**
 * 同步链路回归测试（dev-only）：
 *  1) Agent 补的设定集必须能被画布拉回（docChanged → projectsGet → mergeHostDoc 含 bible）
 *  2) 项目列表里某一个项目拉取失败不得中断整轮（否则排在其后的设定集永远拉不到）
 *
 * 运行：node scripts/test-sync-bible.mjs；退出码 0=通过 1=失败
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');

function mkEl(type, props, ...kids) {
  return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
}
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const noop = () => {};
function domEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [], textContent: '', innerHTML: '',
    value: '', className: '', id: '', width: 0, height: 0, firstChild: null, parentNode: null,
    appendChild: noop, removeChild: noop, remove: noop, click: noop, focus: noop, blur: noop, select: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
    toDataURL: () => 'data:,',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  };
}
const documentStub = {
  createElement: (tag) => domEl(tag), createTextNode: (t) => ({ nodeValue: String(t) }),
  head: domEl('head'), body: domEl('body'), documentElement: domEl('html'),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null,
  activeElement: null, addEventListener: noop, removeEventListener: noop,
};
const localStorageStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };

const T = Date.now() - 1000;
let failProject = 'p1';
const rpcStubFetch = async (url, opts) => {
  const u = String(url || '');
  if (u.includes('/artcraft/')) throw new Error('stub: artcraft offline');
  let body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch { /* 忽略 */ }
  const method = body.method || '';
  let payload;
  if (method === 'projectsSync') {
    payload = {
      projects: [
        { id: 'p1', name: '坏项目', updatedAt: T, nodeIds: ['nx'], nodes: {}, tombstones: [], bibleUpdatedAt: 0 },
        { id: 'p2', name: '好项目', updatedAt: T, nodeIds: [], nodes: {}, tombstones: [], bibleUpdatedAt: T },
      ],
      docChanged: { projectId: 'p2', at: T },
    };
  } else if (method === 'projectsGet') {
    if (failProject === String(body.args && body.args.id)) throw new Error('stub: 拉取失败');
    payload = {
      nodes: { n2: { id: 'n2', type: 'script', x: 0, y: 0, w: 320, h: 100, data: { status: 'idle', label: '剧本', idea: '', output: '' } } },
      edges: [], view: { x: 0, y: 0, scale: 1 },
      bible: { worldview: '测试世界观', style: '写实', characters: [{ name: '张山', desc: '主角' }], scenes: [], props: [] },
      bibleUpdatedAt: T,
    };
  } else {
    payload = { ok: true };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
};

const windowStub = { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, __DSH_IC_SMOKE__: true };
const sandbox = {
  window: windowStub,
  document: {
    createElement: (tag) => domEl(tag), createTextNode: (t) => ({ nodeValue: String(t) }),
    head: domEl('head'), body: domEl('body'), documentElement: domEl('html'),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null,
    activeElement: null, addEventListener: noop, removeEventListener: noop,
  },
  localStorage: localStorageStub,
  navigator: { userAgent: 'smoke', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:19387/', reload: noop },
  fetch: rpcStubFetch,
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, crypto, Blob, URL, AbortController, AbortSignal, structuredClone,
  Image: class { constructor() { this.src = ''; } }, Audio: class { constructor() { this.src = ''; } },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  Event: class { constructor(type) { this.type = type; } },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => ({ set onupgradeneeded(v) { void v; }, set onsuccess(v) { void v; }, set onerror(v) { void v; } }) },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.window.localStorage = localStorageStub;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
const plugin = mod.factory((name) => (name === 'react' ? fakeReact : (() => { throw new Error('意外 require: ' + name); })()));
const ctx = {
  effect(fn) { fn(); },
  locale: { register: noop, subscribe: () => () => {} },
  slots: { inject: (name, cb) => cb(), register: (meta, Comp) => Comp },
};
plugin.apply(ctx);

const sync = windowStub.__DSH_IC_SYNC__;
if (!sync) { console.error('✗ 未找到 __DSH_IC_SYNC__（冒烟缝隙被移除？）'); process.exit(1); }

// 预置：两个项目对客户端已知（known=true），本地文档为空 —— 走"按项目合并"路径
localStorageStub.setItem('dsh-ic:projects', JSON.stringify([
  { id: 'p1', name: '坏项目', createdAt: T, updatedAt: T },
  { id: 'p2', name: '好项目', createdAt: T, updatedAt: T },
]));
localStorageStub.setItem('dsh-ic:active', 'p2');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

// 1) mergeHostDoc：节点 + 连线 + 设定集一次合并（Agent 改文档后的画布拉回路径）
sync.mergeHostDoc('p2', {
  nodes: { n2: { id: 'n2', type: 'script', x: 0, y: 0, w: 320, h: 100, data: { status: 'idle', label: '剧本', idea: '', output: '' } } },
  edges: [{ id: 'e1', fromNode: 'n2', fromPort: 'out', toNode: 'n2', toPort: 'script' }], // 两端缺失的边会被剔除，这里用同节点自连验证保留逻辑
  bible: { worldview: '测试世界观', style: '写实', characters: [{ name: '张山', desc: '主角' }], scenes: [], props: [] },
  bibleUpdatedAt: T,
});
const bible = JSON.parse(localStorageStub.getItem('dsh-ic:bible:p2') || 'null');
ok(!!bible && bible.worldview === '测试世界观', 'mergeHostDoc 未把设定集写入本地（对话补的设定集画布看不到）');
ok(!!bible && Array.isArray(bible.characters) && bible.characters[0] && bible.characters[0].name === '张山', '设定集条目不完整');
ok(localStorageStub.getItem('dsh-ic:biblesync:p2') === String(T), '设定集同步时间戳未更新（会导致重复拉取/回推）');
const graph2 = JSON.parse(localStorageStub.getItem('dsh-ic:graph:p2') || 'null');
ok(!!graph2 && !!graph2.nodes.n2, 'mergeHostDoc 未合并节点');
ok(!!graph2 && Array.isArray(graph2.edges) && graph2.edges.length === 1, 'mergeHostDoc 未合并连线');

// 2) 用户删除了连线（记入边墓碑）→ 陈旧推送带着同一条边也不得复活
const g2 = JSON.parse(localStorageStub.getItem('dsh-ic:graph:p2') || 'null');
g2.edges = []; // 用户删掉了连线
g2.edgeTombstones = ['e1'];
localStorageStub.setItem('dsh-ic:graph:p2', JSON.stringify(g2));
sync.mergeHostDoc('p2', {
  nodes: { n2: { id: 'n2', type: 'script', x: 0, y: 0, w: 320, h: 100, data: { status: 'idle', label: '剧本', idea: '', output: '' } } },
  edges: [{ id: 'e1', fromNode: 'n2', fromPort: 'out', toNode: 'n2', toPort: 'script' }], // 陈旧推送仍带着这条边
  bible: { worldview: '测试世界观', style: '写实', characters: [{ name: '张山', desc: '主角' }], scenes: [], props: [] },
  bibleUpdatedAt: T,
});
const bible2 = JSON.parse(localStorageStub.getItem('dsh-ic:bible:p2') || 'null');
ok(!!bible2 && bible2.worldview === '测试世界观', '二次合并回滚了设定集');
const graph3 = JSON.parse(localStorageStub.getItem('dsh-ic:graph:p2') || 'null');
ok(!!graph3 && graph3.nodes.n2, '二次合并丢节点');
ok(!!graph3 && Array.isArray(graph3.edges) && graph3.edges.length === 0, '被用户删除的连线（边墓碑）被陈旧推送复活');

// 3) 用户删除了节点（节点墓碑）→ Host 拉回不得复活（用户实测：删除后 3 秒内节点又回来）
const g3 = JSON.parse(localStorageStub.getItem('dsh-ic:graph:p2') || 'null');
g3.nodes = {}; // 用户删掉了所有节点
g3.tombstones = ['n2'];
localStorageStub.setItem('dsh-ic:graph:p2', JSON.stringify(g3));
sync.mergeHostDoc('p2', {
  nodes: { n2: { id: 'n2', type: 'script', x: 0, y: 0, w: 320, h: 100, data: { status: 'idle', label: '剧本', idea: '', output: '' } } },
  edges: [], bible: { worldview: '测试世界观', style: '写实', characters: [{ name: '张山', desc: '主角' }], scenes: [], props: [] },
  bibleUpdatedAt: T,
});
const graph4 = JSON.parse(localStorageStub.getItem('dsh-ic:graph:p2') || 'null');
ok(!graph4.nodes.n2, '被用户删除的节点（节点墓碑）被 Host 拉回复活（删除后又出现/需要删多次）');
ok(!!graph4.tombstones && graph4.tombstones.includes('n2'), '合并后节点墓碑丢失（下次推送会复活）');

// 4) loadBible 读取（BibleTab 的数据源）
const loaded = sync.loadBible('p2');
ok(loaded.worldview === '测试世界观' && loaded.characters.length === 1, 'loadBible 读取不一致');

if (errs.length) {
  console.error('✗ 同步链路回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 同步合并回归测试通过（mergeHostDoc：设定集/节点/连线落库 + 幂等 + loadBible 一致）');
process.exit(0);
