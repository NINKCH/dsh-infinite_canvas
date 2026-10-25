// 旧 IDB 资产一次性迁移：保留原 id 落盘 + assetCreate + 清 IDB；缺失分类；无 dataRoot 跳过；幂等/并发
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-mig-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');
const DATA_ROOT = path.join(SANDBOX, 'data');
fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.writeFileSync(process.env.DSH_IC_CONFIG_PATH, JSON.stringify({ dataRoot: DATA_ROOT }), 'utf8');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => { if (a !== b) errs.push(m + '（实际 ' + JSON.stringify(a) + ' / 期望 ' + JSON.stringify(b) + '）'); };
const noop = () => {};
const elStub = () => ({
  style: {}, dataset: {}, children: [], textContent: '', id: '', appendChild: noop, removeChild: noop, remove: noop,
  setAttribute: noop, getAttribute: () => null, removeAttribute: noop, addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  getContext: () => ({ drawImage: noop, fillRect: noop, fillStyle: '#000', createLinearGradient: () => ({ addColorStop: noop }) }),
  toBlob: (cb) => setTimeout(() => cb(new Blob(['thumb'], { type: 'image/jpeg' })), 0),
  classList: { add: noop, remove: noop, contains: () => false },
});
const cap = { assetPosts: [], assetCreates: [], deleted: [] };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop, localStorage: { getItem: () => null, setItem: noop, removeItem: noop } },
  document: { createElement: () => elStub(), createTextNode: (t) => ({ nodeValue: String(t) }), head: elStub(), body: elStub(), documentElement: elStub(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, activeElement: null },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  navigator: { userAgent: 'mig-test' },
  location: { href: 'http://127.0.0.1:1/', reload: noop, origin: 'http://127.0.0.1:1' },
  fetch: null,
  requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'), btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  Image: class {
    constructor() { this._src = ''; this.naturalWidth = 4; this.naturalHeight = 4; }
    set src(v) { this._src = v; setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0); }
    get src() { return this._src; }
  },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => { const r = {}; setTimeout(() => { try { r.onerror && r.onerror(); } catch { /* 忽略 */ } }, 0); return r; } },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
sandbox.window.__DSH_IC_SMOKE__ = true;

// 假 fetch：/api/asset 记录 body；RPC 记录 assetCreate
sandbox.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  if (u.includes('/api/asset') && method === 'POST') {
    cap.assetPosts.push({ url: u, size: opts.body && opts.body.size });
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  }
  if (u.includes('/api/rpc')) {
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch { /* 忽略 */ }
    if (body.method === 'assetCreate') cap.assetCreates.push(body.args && body.args.asset);
    if (body.method === 'assetsGet') return { ok: true, status: 200, json: async () => ({ items: [] }), text: async () => '{"items":[]}' };
    // 让 boot 期的 refreshDataRoot 拿到同一数据根，避免它把 S.dataRoot 覆盖成 null
    if (body.method === 'dataRootGet') {
      const j = { dataRoot: DATA_ROOT, exists: true, store: 'sqlite', sql: true };
      return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

vm.createContext(sandbox);
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
} catch (e) {
  console.error('✗ client.js 顶层执行失败：' + ((e && e.stack) || e));
  process.exit(1);
}
if (!mod) { console.error('✗ __ModuleLoader__.load 未被调用'); process.exit(1); }
const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }),
  useState: (v) => [typeof v === 'function' ? v() : v, noop],
  useEffect: noop, useLayoutEffect: noop, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(), memo: (f) => f,
};
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require ' + name); });
try {
  plugin.apply({
    effect(fn) { try { fn(); } catch { /* 忽略 */ } return () => {}; },
    locale: { register: noop, subscribe: () => () => {} },
    slots: { inject(n, cb) { cb(); }, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    layout: { selectPanel: noop },
  });
} catch (e) {
  console.error('✗ apply(ctx) 失败：' + ((e && e.stack) || e));
  process.exit(1);
}

const M = sandbox.window.__DSH_IC_MIGRATE__;
ok(!!M, '未暴露 __DSH_IC_MIGRATE__ 测试缝');

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))]);

// 1) 有 blob：落盘 + assetCreate（保留 id）+ idbDelete
async function caseMigrate() {
  cap.assetPosts.length = 0; cap.assetCreates.length = 0; cap.deleted.length = 0;
  const rec = { id: 'a_legacy_1', projectId: 'p1', kind: 'image', mime: 'image/png', name: '角色-瓦力 设定图', createdAt: 1, blob: new Blob(['x'.repeat(100)], { type: 'image/png' }) };
  M.setDataRootForTest(DATA_ROOT);
  M.setIdbAllForTest(async () => [rec]);
  M.setIdbDeleteForTest(async (id) => { cap.deleted.push(id); });
  const r = await withTimeout(M.migrateLegacyAssets('test'), 4000, 'migrate');
  ok(r && r.ok, '迁移应成功返回 ok：' + JSON.stringify(r));
  eq(r.migrated, 1, '应迁移 1 个资产');
  eq(cap.assetPosts.length, 1, '应 POST 一次 /api/asset');
  ok(cap.assetPosts[0] && decodeURIComponent(String(cap.assetPosts[0].url)).includes('projects/p1/image/'), '落盘路径应在 projects/<pid>/<kind>/：' + (cap.assetPosts[0] && cap.assetPosts[0].url));
  eq(cap.assetCreates.length, 1, '应调用一次 assetCreate');
  eq(cap.assetCreates[0] && cap.assetCreates[0].id, 'a_legacy_1', 'assetCreate 必须保留原 id');
  ok(cap.assetCreates[0] && cap.assetCreates[0].rel && cap.assetCreates[0].rel.indexOf('projects/p1/image/') === 0, 'assetCreate 应带 rel（磁盘资产）');
  eq(cap.deleted[0], 'a_legacy_1', '迁移成功后应删除 IDB 记录');
  const st = M.state();
  ok(st && st.migrated === 1, '迁移状态应记录 migrated=1');
}

// 2) 无 blob：missing（不写盘）
async function caseMissing() {
  cap.assetPosts.length = 0;
  M.setIdbAllForTest(async () => [{ id: 'a_legacy_2', projectId: 'p1', kind: 'image', mime: 'image/png', name: 'lost' }]);
  M.setIdbDeleteForTest(async () => {});
  const r = await withTimeout(M.migrateLegacyAssets('test'), 4000, 'missing');
  console.log('[mig] missing result:', JSON.stringify(r));
  eq(r.missing, 1, '无 blob 应计入 missing');
  eq(cap.assetPosts.length, 0, '无 blob 不应写盘');
  const st = M.state();
  ok(st && st.missing === 1 && (st.missingIds || []).includes('a_legacy_2'), '缺失清单应含该 id');
}

// 3) 无 dataRoot：跳过
async function caseNoRoot() {
  M.setDataRootForTest(null);
  M.setIdbAllForTest(async () => [{ id: 'x', projectId: 'p', kind: 'image', blob: new Blob(['a']) }]);
  const r = await withTimeout(M.migrateLegacyAssets('test'), 4000, 'no-root');
  ok(r && r.ok === false && r.skipped === 'no-data-root', '无 dataRoot 应延后迁移：' + JSON.stringify(r));
  M.setDataRootForTest(DATA_ROOT);
}

// 4) 幂等 + 并发只跑一次
async function caseIdempotent() {
  let calls = 0;
  M.setIdbAllForTest(async () => { calls++; return []; });
  M.setIdbDeleteForTest(async () => {});
  const [a, b] = await withTimeout(Promise.all([M.migrateLegacyAssets('t1'), M.migrateLegacyAssets('t2')]), 4000, 'concurrent');
  ok(a && b, '并发调用应返回结果');
  eq(calls, 1, '并发调用只应执行一次 idbAll（并发保护）');
  const again = await withTimeout(M.migrateLegacyAssets('t3'), 4000, 'again');
  eq(again.migrated, 0, '第二次迁移应无新增（幂等）');
}

// 5) 显示兜底：无 rel 资产仍能拿到缩略图 URL
async function caseThumbFallback() {
  const blob = new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
  sandbox.window.__DSH_IC_PERF__.setStoreForTest('sqlite');
  sandbox.window.__DSH_IC_PERF__.setIdbGetRawForTest(async (id) => ({ id, kind: 'image', mime: 'image/png', projectId: 'p1', blob }));
  M.setIdbAllForTest(async () => [{ id: 'a_legacy_norel', projectId: 'p1', kind: 'image', mime: 'image/png', blob }]);
  M.setIdbDeleteForTest(async () => {});
  const u = await withTimeout(M.ensureThumbForAsset('a_legacy_norel'), 6000, 'thumb');
  ok(typeof u === 'string' && u.length > 0, '无 rel 资产应返回内存缩略图 URL（不再直接 null）：' + u);
}

(async () => {
  try {
    await caseMigrate();
    await caseMissing();
    await caseNoRoot();
    await caseIdempotent();
    await caseThumbFallback();
  } catch (e) {
    console.error('✗ 用例异常：' + ((e && e.stack) || e));
    errs.push('用例异常：' + String((e && e.message) || e));
  } finally {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
  if (errs.length) {
    console.error('✗ 资产一次性迁移测试未通过（' + errs.length + ' 项）：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✓ 迁移通过：保留 id 落盘入库 / 清 IDB / 缺失分类 / 无数据根时延后 / 幂等并发 / 无 rel 显示兜底');
  process.exit(0);
})();
