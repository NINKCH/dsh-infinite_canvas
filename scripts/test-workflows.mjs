#!/usr/bin/env node
/**
 * 工作流工具箱回归（dev-only）：假浏览器里真实执行 client.js，
 * 验证「快照 → 跨项目插入 → 连线重建 → 缺失资产留占位」与「插入后再保存」。
 *
 * 运行：node scripts/test-workflows.mjs   退出码 0 = 通过
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const noop = () => {};
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) errs.push(m + '\n    期望 ' + JSON.stringify(b) + '\n    实际 ' + JSON.stringify(a)); };

const docEl = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '',
  appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
  addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
  getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
  toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
const documentStub = {
  createElement: () => docEl(),
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: docEl(), body: docEl(), documentElement: docEl(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null,
  addEventListener: noop, removeEventListener: noop,
};
const store = new Map();
const ls = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const sandbox = {
  window: { __DSH_IC_SMOKE__: true, addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, localStorage: ls, prompt: () => '测试工作流', confirm: () => true },
  document: documentStub,
  navigator: { userAgent: 'test-workflows', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  localStorage: ls,
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 1),
  cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  performance: { now: () => 0 },
  console,
  Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  Image: class { constructor() { this.src = ''; } },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: undefined, // 未实现 IDB：openDb 立即 reject，走「资产不可用」分支（测试缺失资产占位）
  alert: noop, confirm: () => true, prompt: () => '测试工作流',
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try { vm.runInContext(src, sandbox, { filename: 'client.js' }); } catch (e) {
  console.error('✗ client.js 顶层执行失败：' + (e && e.message)); process.exit(1);
}
const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useState: (i) => [typeof i === 'function' ? i() : i, noop],
  useEffect: noop, useLayoutEffect: noop, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(), Fragment: 'fragment',
};
let plugin = null;
try {
  plugin = mod.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error('意外 require: ' + name);
  });
  plugin.apply({
    effect(fn) { fn(); },
    locale: { register: noop, subscribe: () => () => {} },
    slots: { inject(name, cb) { cb(); }, register() { return () => {}; } },
  });
} catch (e) {
  console.error('✗ 初始化失败：' + (e && e.stack ? e.stack : String(e))); process.exit(1);
}
const api = sandbox.window.__DSH_IC_WORKFLOWS__;
const sync = sandbox.window.__DSH_IC_SYNC__;
if (!api || !sync) { console.error('✗ 缺少 __DSH_IC_WORKFLOWS__ / __DSH_IC_SYNC__ 出口'); process.exit(1); }

async function main() {
  const wf = {
    id: 'wf_test', name: '测试工作流',
    nodes: [
      { key: 'n0', type: 'text', x: 0, y: 0, w: 360, h: 360, data: { text: '雨夜街头', status: 'idle' } },
      { key: 'n1', type: 'image', x: 420, y: 20, w: 360, h: 300, data: { prompt: '霓虹雨夜', assetId: 'asset_missing', status: 'done' } },
    ],
    edges: [{ from: 'n0', fromPort: 'out', to: 'n1', toPort: 'prompt' }],
    assets: [{ nodeKey: 'n1', field: 'assetId', assetId: 'asset_missing', name: '不存在的图', kind: 'image' }],
  };
  const before = sync.graph();
  const r = await api.insertWorkflow(wf);
  ok(r && r.nodes === 2 && r.edges === 1, '插入计数不正确：' + JSON.stringify(r));
  const g = sync.graph();
  const ids = Object.keys(g.nodes);
  eq(ids.length, Object.keys(before.nodes).length + 2, '插入后节点数不对');
  eq(g.edges.length, before.edges.length + 1, '插入后连线数不对');
  const text = Object.values(g.nodes).find((n) => n.type === 'text' && n.data.text === '雨夜街头');
  const img = Object.values(g.nodes).find((n) => n.type === 'image' && n.data.prompt === '霓虹雨夜');
  ok(!!text && !!img, '插入的工作流节点缺失');
  ok(text && img && text.x !== 0, '插入节点未按视口居中（仍是快照相对坐标）');
  ok(img && !img.data.assetId, '缺失资产未清空 assetId');
  ok(img && String(img.data.genWarn || '').includes('资产未找到'), '缺失资产未留可见占位提示');
  const e = g.edges[g.edges.length - 1];
  ok(e && e.fromNode === text.id && e.toNode === img.id && e.toPort === 'prompt', '插入后连线未重映射到新节点 id');

  // 插入结果再保存 → 新工作流节点/连线数量一致
  const saved = await api.saveWorkflowFromIds([text.id, img.id]);
  ok(saved && saved.nodes.length === 2 && saved.edges.length === 1, '插入结果再保存失败');
  const list = api.loadWorkflows();
  ok(list.some((w) => w.id === saved.id && w.name === '测试工作流'), '工作流未写入全局存储');

  // 删除
  api.removeWorkflow(saved.id);
  ok(!api.loadWorkflows().some((w) => w.id === saved.id), '删除工作流失败');

  if (errs.length) {
    console.error('✗ 工作流测试未通过（' + errs.length + ' 项）：');
    for (const x of errs) console.error('  - ' + x);
    process.exit(1);
  }
  console.log('✓ 工作流测试通过（插入计数 / 连线重映射 / 缺失资产占位 / 再保存 / 删除）');
  process.exit(0);
}
main().catch((e) => { console.error('✗ 工作流测试异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
