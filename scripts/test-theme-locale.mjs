// 主题跟随与界面语言回归测试。
//
// 用户实测反馈（两条独立缺陷）：
//  ① **深色模式下节点底板仍是白色**：插件的深色样式只写了 `@media (prefers-color-scheme:dark)`，
//     而宿主的深色是 `body[data-ds-dark-theme]`（用户在「设置 → 外观」里显式选择）。
//     当"系统是浅色 + 应用内选深色"时媒体查询不命中 → 白卡片、深色字，看着像没适配。
//  ② **插件名变成英文**：模块名 / 右侧面板页签名没跟随宿主语言；根因是 hostLang()
//     读快照里的 `snap.locale || snap.id`，而 dsh-client-locale 的快照是
//     `{ active, locales, revision }`——字段不存在 → 永远回落到 zh/en 之一。
//     另外英文词典里的面板名曾经就是硬编码 'Infinite Canvas'，中文语境下也照样出现。
//
// 本测试锁死：
//   A. 深色覆盖必须挂在宿主属性上（不许只靠媒体查询），且深色变量组真的被覆盖
//   B. 语言判定要吃 `active` 字段（也兼容字符串/旧字段），而不是只认一种形态
//   C. 面板名 / 页签名必须走 T('panel')，不允许硬编码英文名
//   D. 两种语言下面板名都必须存在且不同（中文"无限画布" / 英文 "Infinite Canvas"）
//
// 运行：node scripts/test-theme-locale.mjs（退出码 0=通过）

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 假 React / DOM / localStorage ----------------
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
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600 }),
  getContext: () => null, toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
const documentStub = {
  createElement: () => elStub(), createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null, addEventListener: noop, removeEventListener: noop,
};
const lsStore = new Map();
const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };
const PID = 'p_theme';
lsStub.setItem('dsh-ic:projects', JSON.stringify([{ id: PID, name: '主题测试', createdAt: 1, updatedAt: 1 }]));
lsStub.setItem('dsh-ic:active', JSON.stringify(PID));
lsStub.setItem('dsh-ic:graph:' + PID, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));

// 宿主 locale 快照桩：可在测试里切换，验证"跟随宿主语言"
let hostLocaleSnapshot = { active: 'zh', locales: ['zh', 'en'], revision: 0 };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, localStorage: lsStub, __DSH_IC_SMOKE__: true },
  document: documentStub, localStorage: lsStub,
  navigator: { userAgent: 'test-theme-locale', clipboard: { writeText: async () => {} } },
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
  indexedDB: { open: () => { const req = {}; setTimeout(() => { try { req.onerror && req.onerror(); } catch { /* 忽略 */ } }, 0); return req; } },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });

// 捕获注册进去的字典与标签函数（不跑真实渲染）
const captured = { dicts: null, panellistLabel: null, tabTitle: null, tabTitleText: null, slots: [] };
const fakeCtx = {
  effect(fn) { try { fn(); } catch { /* 副作用在测试环境可能失败，忽略 */ } return () => {}; },
  locale: {
    register(ns, dicts) { captured.dicts = dicts; },
    subscribe() { return () => {}; },
    getLocale() { return hostLocaleSnapshot; },
    getSnapshot() { return hostLocaleSnapshot; },
  },
  slots: {
    inject(name, cb) { captured.slots.push(name); try { cb(); } catch { /* 忽略 */ } },
    register(def, comp) {
      if (def && def.name === 'sidebar.panellist') captured.panellistLabel = def.label;
      if (def && def.name === 'sidebar.right.pane.tab.title') captured.tabTitle = comp;
      if (def && def.name === 'sidebar.right.pane.tab') captured.tabBody = comp;
      return () => {};
    },
  },
  sidebarRightTabs: {
    register(def) {
      captured.tabDef = def;
      return () => {};
    },
  },
  layout: { selectPanel: noop },
  shortcuts: { register: () => () => {} },
  skills: { register: () => () => {} },
  webServer: { register: () => () => {} },
  get: () => undefined,
};
plugin.apply(fakeCtx);

const CONTENT = sandbox.window.__DSH_IC_CONTENT__ || null;
const LAYOUT = sandbox.window.__DSH_IC_LAYOUT__ || null;

// ============================================================
// A. 深色主题必须挂在宿主属性上
// ============================================================
{
  const css = (LAYOUT && LAYOUT.CSS) || (sandbox.window.__DSH_IC_CSS__ ? sandbox.window.__DSH_IC_CSS__() : null);
  ok(!!css, '未暴露 CSS（测试缝隙缺失），无法校验深色主题');
  if (css) {
    // ① 必须存在宿主属性选择器（这是 Harness 真实的深色信号）
    ok(/body\[data-ds-dark-theme\][^{]*\.dshic-page\s*\{/.test(css),
      '缺少 body[data-ds-dark-theme] .dshic-page 变量覆盖——深色主题不会生效（用户实测：深色下节点底板仍是白的）');
    // ② 深色变量组必须真的改了卡片底色 / 字色（不能只改边框）
    const darkBlock = (() => {
      const m = /body\[data-ds-dark-theme\]\s*\.dshic-page\s*\{([\s\S]*?)\n\}/.exec(css);
      return m ? m[1] : '';
    })();
    ok(!!darkBlock, 'body[data-ds-dark-theme] .dshic-page 规则块解析失败');
    for (const v of ['--dshic-card', '--dshic-ink', '--dshic-ink2', '--dshic-line', '--dshic-head-bg', '--dshic-preview-bg']) {
      ok(new RegExp(v.replace(/-/g, '\\-') + '\\s*:').test(darkBlock), '深色变量组缺少 ' + v + '（该处仍是浅色值）');
    }
    // ③ 深色卡片底色不能是白的（这是用户看到的那张白卡）
    const cardVal = (/--dshic-card\s*:\s*([^;]+);/.exec(darkBlock) || [])[1] || '';
    ok(cardVal && !/#fff/i.test(cardVal) && !/white/i.test(cardVal), '深色下 --dshic-card 仍是白色（' + cardVal + '）');
    // ④ 深色字色必须比底色亮（不然深底深字看不见）
    const lum = (hex) => {
      const m = /#([0-9a-f]{6})/i.exec(hex || '');
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
    };
    const inkL = lum((/--dshic-ink\s*:\s*([^;]+);/.exec(darkBlock) || [])[1]);
    const cardL = lum(cardVal);
    ok(inkL != null && cardL != null && inkL > cardL + 0.35,
      '深色下字色与底色的亮度差不足（ink=' + inkL + ' card=' + cardL + '）——会看不清');
    // ⑤ 不许只靠媒体查询表达深色：媒体查询块计数应为 0（注释里的说明不算）
    const mediaBlocks = (css.match(/@media\s*\(prefers-color-scheme:dark\)\s*\{/g) || []).length;
    ok(mediaBlocks === 0,
      '仍有 ' + mediaBlocks + ' 个 @media (prefers-color-scheme:dark) 块——宿主"应用内选深色 + 系统浅色"时不会命中，必须改用 body[data-ds-dark-theme]');
    // ⑥ 其它弹层/菜单的深色边框也要挂在属性上
    for (const sel of ['.dshic-menu', '.dshic-modal', '.dshic-toast', '.dshic-pick-menu', '.dshic-keys-pop', '.dshic-storage-details', '.dshic-minimap', '.dshic-studio-modal', '.dshic-inline-input', '.dshic-mask-card']) {
      ok(css.includes('body[data-ds-dark-theme] ' + sel) || css.includes(sel.split(',').join('') + ','),
        '深色边框覆盖缺少 ' + sel + '（该弹层在深色下边框会发亮）');
    }
  }
}

// ============================================================
// B/C. 语言判定与面板名
// ============================================================
{
  ok(!!captured.dicts, '未捕获到注册的词典（locale.register 未被调用）');
  const d = captured.dicts || {};
  ok(d.zh && d.en, '词典缺少 zh 或 en');
  // D. 两种语言下面板名都要有，且不能相同（否则"跟随语言"是假的）
  const zhName = d.zh && d.zh.panel;
  const enName = d.en && d.en.panel;
  ok(typeof zhName === 'string' && zhName.length, '中文词典缺少 panel（面板名）');
  ok(typeof enName === 'string' && enName.length, '英文词典缺少 panel（面板名）');
  ok(zhName !== enName, '中英文面板名相同（' + zhName + '）——语言切换不会改变显示');
  ok(zhName === '无限画布', '中文面板名不是「无限画布」（实际 ' + zhName + '）');
  ok(enName === 'Infinite Canvas', '英文面板名不是 "Infinite Canvas"（实际 ' + enName + '）');

  // C. 面板名 / 页签名必须走 T('panel')，不许硬编码英文名
  const idx = src.indexOf("id: PANEL_ID");
  const around = src.slice(Math.max(0, idx - 300), idx + 500);
  ok(/label:\s*\(\)\s*=>\s*T\('panel'\)/.test(around) || /label:\s*\(\)\s*=>\s*T\("panel"\)/.test(around),
    'sidebar.panellist 的 label 没走 T(\'panel\')（插件名不会跟随语言）');
  // 右侧面板页签标题同理
  const tabBlock = src.slice(src.indexOf('sidebar.right.pane.tab.title'), src.indexOf('sidebar.right.pane.tab.title') + 900);
  ok(tabBlock.includes("T('panel')"), '右侧面板页签标题没走 T(\'panel\')');
  // 侧栏页签注册的 title 也要走 T
  const tabRegIdx = src.indexOf('ctx.sidebarRightTabs.register');
  const tabReg = src.slice(tabRegIdx, tabRegIdx + 700);
  ok(/title:\s*\(\)\s*=>\s*T\('panel'\)/.test(tabReg), '侧栏页签注册的 title 没走 T(\'panel\')');
  ok(/guide:/.test(tabReg) && /title:\s*\(\)\s*=>\s*T\('panel'\)/.test(tabReg), '引导卡片标题没走 T(\'panel\')');

  // B. hostLang 必须能吃 active 字段（这是 dsh-client-locale 的真实快照形态）
  ok(/typeof snap\.active === 'string'/.test(src), 'hostLang 没有读取 locale 快照的 active 字段——永远回落到默认语言');
  ok(/function localeIdOf/.test(src), '缺少 localeIdOf 归一化函数（多形态快照兼容）');

  // B'. 行为验证：切宿主快照 → 面板名跟着变
  const evalLocaleIdOf = () => {
    const i = src.indexOf('function localeIdOf');
    const j = src.indexOf('\n    }', i);
    const body = src.slice(i, j + 6);
    const fn = new Function(body + '; return localeIdOf;')();
    return fn;
  };
  const idOf = evalLocaleIdOf();
  ok(idOf({ active: 'en' }) === 'en', 'localeIdOf 吃不到 {active:"en"}');
  ok(idOf({ active: 'zh-CN' }) === 'zh-CN', 'localeIdOf 吃不到 {active:"zh-CN"}');
  ok(idOf('en-US') === 'en-US', 'localeIdOf 不支持字符串形态');
  ok(idOf({ locale: 'zh' }) === 'zh', 'localeIdOf 不支持旧字段 locale');
  ok(idOf({ id: 'en' }) === 'en', 'localeIdOf 不支持旧字段 id');
  ok(idOf(null) === '' && idOf({}) === '', 'localeIdOf 空值应返回空串');

  // 面板标签函数在两种快照下要给出对应语言
  if (captured.panellistLabel) {
    hostLocaleSnapshot = { active: 'zh', locales: ['zh', 'en'], revision: 0 };
    const zh2 = captured.panellistLabel();
    hostLocaleSnapshot = { active: 'en', locales: ['zh', 'en'], revision: 1 };
    const en2 = captured.panellistLabel();
    ok(zh2 === '无限画布', '宿主中文时面板名应为「无限画布」，实际 ' + zh2);
    ok(en2 === 'Infinite Canvas', '宿主英文时面板名应为 "Infinite Canvas"，实际 ' + en2);
    ok(zh2 !== en2, '面板名没有跟随宿主语言变化');
  } else {
    errs.push('未捕获到 sidebar.panellist 的 label（面板名无法验证）');
  }
}

if (errs.length) {
  console.error('✗ 主题跟随 / 界面语言测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 主题跟随 / 界面语言测试通过（深色挂在 body[data-ds-dark-theme] / 深色变量与亮度对比 / 无媒体查询残留 / 面板名中英双语 / active 字段解析）');
process.exit(0);
