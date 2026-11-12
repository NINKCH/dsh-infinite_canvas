#!/usr/bin/env node
/**
 * 资产库 DAM 回归：ZIP 打包字节结构（真实执行）+ 标签/文件夹元数据接线。
 *
 * 运行：node scripts/test-dam.mjs   退出码 0 = 通过
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const host = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
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
  createElement: () => docEl(), createTextNode: (t) => ({ nodeValue: String(t) }),
  head: docEl(), body: docEl(), documentElement: docEl(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null, addEventListener: noop, removeEventListener: noop,
};
const store = new Map();
const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
const sandbox = {
  window: { __DSH_IC_SMOKE__: true, addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, localStorage: ls, prompt: () => '', confirm: () => true },
  document: documentStub,
  navigator: { userAgent: 'test-dam', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  localStorage: ls,
  fetch: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 1), cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  performance: { now: () => 0 }, console,
  Blob, URL, AbortController, AbortSignal, structuredClone, crypto, TextEncoder,
  Image: class { constructor() { this.src = ''; } }, Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: undefined,
  alert: noop, confirm: () => true, prompt: () => '',
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
try {
  const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
  plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register() { return () => {}; } } });
} catch (e) { console.error('✗ 初始化失败：' + (e && e.stack ? e.stack : e)); process.exit(1); }
const api = sandbox.window.__DSH_IC_DAM__;
if (!api) { console.error('✗ 缺少 __DSH_IC_DAM__ 出口'); process.exit(1); }

async function main() {
  // CRC32 已知值
  eq(api.crc32Bytes(new TextEncoder().encode('hello')), 0x3610a686, 'CRC32 计算错误');
  const files = [
    { name: 'a.txt', data: new TextEncoder().encode('hello') },
    { name: '空 格.png', data: new Uint8Array([1, 2, 3, 4]) },
  ];
  const blob = api.buildZipStore(files);
  ok(blob && blob.type === 'application/zip', 'ZIP Blob 类型不对');
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  eq(dv.getUint32(0, true), 0x04034b50, '缺少本地文件头签名');
  const eocdAt = u8.length - 22;
  eq(dv.getUint32(eocdAt, true), 0x06054b50, '缺少 EOCD 签名');
  eq(dv.getUint16(eocdAt + 10, true), 2, 'EOCD 文件数不对');
  const centralAt = dv.getUint32(eocdAt + 16, true);
  eq(dv.getUint32(centralAt, true), 0x02014b50, '缺少中央目录签名');
  const text = new TextDecoder('utf-8').decode(u8);
  ok(text.includes('a.txt') && text.includes('空 格.png'), 'ZIP 内缺少 UTF-8 文件名');

  // Host 迁移/写回
  ok(host.includes("ALTER TABLE assets ADD COLUMN tags TEXT"), 'Host 缺少 tags 列迁移');
  ok(host.includes("ALTER TABLE assets ADD COLUMN folder TEXT"), 'Host 缺少 folder 列迁移');
  ok(host.includes('tags: Array.isArray(a.tags)'), 'Host assetRowFromRecord 未写 tags');
  ok(host.includes('folder: a.folder ? String(a.folder)'), 'Host assetRowFromRecord 未写 folder');
  ok(host.includes('if (r.tags)') && host.includes('if (r.folder)'), 'Host rowToAsset 未读 tags/folder');
  ok(host.includes('patch.tags !== undefined') && host.includes('patch.folder !== undefined'), 'Host assetUpdate 未处理 tags/folder');

  // 客户端接线
  ok(src.includes('const updateAssetMeta = (a, patch)') || src.includes('const updateAssetMeta = (a, patch) =>'), '缺少 updateAssetMeta');
  ok(src.includes("'data-action': 'assets-download-zip'"), '资产批处理缺少 ZIP 下载');
  ok(src.includes('function buildZipStore(files)'), '缺少 buildZipStore');
  ok(src.includes('if (tagFilter && !(Array.isArray(a.tags)'), '标签筛选未接线');
  ok(src.includes('if (folderFilter && String(a.folder'), '文件夹筛选未接线');
  ok(src.includes('onMeta: updateAssetMeta'), '资产卡未接标签/文件夹编辑');

  if (errs.length) {
    console.error('✗ DAM 测试未通过（' + errs.length + ' 项）：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✓ DAM 测试通过（ZIP 字节结构 / UTF-8 文件名 / CRC32 / tags+folder 落库与筛选）');
  process.exit(0);
}
main().catch((e) => { console.error('✗ DAM 测试异常：' + (e && e.stack ? e.stack : e)); process.exit(1); });
