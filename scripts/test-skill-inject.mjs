#!/usr/bin/env node
/**
 * 技能注入 + 快捷键入口契约测试（dev-only，不随包发布）。
 *
 * 覆盖三件事：
 *   A) 内置专家人设与 canvas-craft 技能同步：分镜人设必须含六要素 / 每场大特写 /
 *      motion「起点→方式→终点」/ 同场连续三镜不同运动 / 每场冲撞点 / 因果钩子 / 术语；
 *      剧本人设必须含四要素 + 因果钩子；且分镜 JSON 输出契约（字段名、shots 结构）未被改动。
 *   B) 技能注入 Harness 与快捷键入口：
 *      - Host：内置三份技能注册进 `skills` 服务，可枚举、modelInvocable、正文含新规则；
 *      - Client：ctx.shortcuts.register 收到命令（id/各平台默认键位/动作），命令目录数据源可枚举；
 *      - 插件快捷键浮层里能看到并点击到技能入口；
 *      - 快捷键动作（复制技能全文）真的把技能正文送到剪贴板（桩验证）。
 *   C) 专家（EXPERTS）：设置页只有一个「专家」下拉、只列本插件专家；旧技能字段迁移到 general；
 *      剧本/分镜统一走 buildExpertContext（persona + skills），注入假第二专家验证结构支持多专家。
 *
 * 运行：node scripts/test-skill-inject.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-skill-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => { if (a !== b) errs.push(m + `（实际：${JSON.stringify(a)}，期望：${JSON.stringify(b)}）`); };
const noop = () => {};

// ============================================================
// 一、Client 半：加载 client.js（假 React/DOM，与 smoke-render 同一套路）
// ============================================================
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

function mkEl(type, props, ...kids) {
  return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
}
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
function elStub() {
  return {
    style: {}, dataset: {}, children: [], textContent: '', id: '',
    appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
    getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
    toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  };
}
const documentStub = {
  createElement: (tag) => { const el = elStub(); if (tag === 'canvas') el.captureStream = () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] }); return el; },
  createTextNode: (t) => ({ nodeValue: String(t) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null,
  addEventListener: noop, removeEventListener: noop,
};
const lsStore = new Map();
const lsStub = { getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, String(v)), removeItem: (k) => lsStore.delete(k), clear: () => lsStore.clear() };

// 技能正文桩：readSkill RPC 返回它，用来验证"复制到剪贴板"的正是技能全文
const SKILL_BODY = '# canvas-craft\n' + '分镜六要素：景别 / 机位 / 主体位置 / 层次 / 光线 / 道具。'.repeat(20);
let clipboardText = null;
const navigatorStub = {
  userAgent: 'test-skill-inject',
  clipboard: { writeText: async (t) => { clipboardText = String(t); } },
};
const fetchStub = async (url, opts) => {
  let method = '';
  try { method = JSON.parse((opts && opts.body) || '{}').method; } catch { /* 忽略 */ }
  const payload = method === 'readSkill'
    ? { name: 'canvas-craft', text: SKILL_BODY }
    : { skills: [{ name: 'canvas-craft', description: '创作方法论' }] };
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, text: async () => text, json: async () => payload };
};

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: navigatorStub,
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: fetchStub,
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
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
} catch (e) {
  console.error('✗ client.js 顶层执行失败：' + ((e && e.stack) || e));
  process.exit(1);
}
if (!mod) { console.error('✗ __ModuleLoader__.load 未被调用'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });

// ctx.shortcuts 桩：记录 register 进来的命令；同时模拟真实 registry 的「可观察命令目录」数据源
const registered = [];
const fakeShortcuts = {
  register(cmd) { registered.push(cmd); return () => {}; },
  // 真实服务里 catalog 由已注册命令派生（effectiveShortcuts）；这里按同一口径暴露可枚举数据源
  catalog: { getSnapshot: () => registered.map((c) => ({ id: c.id, label: c.label(), aliases: c.aliases || [] })) },
};
const ctx = {
  effect(fn) { fn(); return () => {}; },
  locale: { register: noop, subscribe: () => () => {} },
  slots: { inject(n, cb) { cb(); }, register: () => () => {} },
  sidebarRightTabs: { register: () => () => {} },
  shortcuts: fakeShortcuts,
  layout: { selectPanel: (id) => { ctx.selectedPanels.push(id); } },
  selectedPanels: [],
};
try {
  plugin.apply(ctx);
} catch (e) {
  console.error('✗ apply(ctx) 执行失败：' + ((e && e.stack) || e));
  process.exit(1);
}

const SKILL = sandbox.window.__DSH_IC_SKILL__;
const TABS = sandbox.window.__DSH_IC_TABS__;
const SYNC = sandbox.window.__DSH_IC_SYNC__;
const SETTINGS = sandbox.window.__DSH_IC_SETTINGS__;
ok(!!SKILL, '未暴露 window.__DSH_IC_SKILL__（测试缝隙缺失）');
ok(!!TABS, '未暴露 window.__DSH_IC_TABS__');
ok(!!SYNC, '未暴露 window.__DSH_IC_SYNC__');
ok(!!SETTINGS, '未暴露 window.__DSH_IC_SETTINGS__（专家团/设置迁移缝隙缺失）');

// ---------- A) 人设文本：硬规则关键词 ----------
if (SKILL) {
  const sbZh = SKILL.EXPERT_STORYBOARD(true);
  const sbEn = SKILL.EXPERT_STORYBOARD(false);
  const scZh = SKILL.EXPERT_SCRIPT(true);
  const scEn = SKILL.EXPERT_SCRIPT(false);

  // 分镜人设：六要素
  for (const k of ['景别', '机位', '主体位置与朝向', '前景/背景层次', '光线方向与质感', '关键道具位置', '六要素']) {
    ok(sbZh.includes(k), `分镜人设（zh）缺少六要素关键字「${k}」`);
  }
  for (const k of ['SIX elements', 'shot size', 'camera position/angle', 'subject position and facing', 'foreground/background', 'light direction and quality', 'key prop position']) {
    ok(sbEn.includes(k), `分镜人设（en）缺少六要素关键字「${k}」`);
  }
  // 每场至少 1 个大特写
  ok(/每场至少\s*1\s*个大特写/.test(sbZh), '分镜人设（zh）未写「每场至少 1 个大特写」');
  ok(/At least ONE extreme close-up per scene/.test(sbEn), '分镜人设（en）未写 per-scene extreme close-up');
  ok(sbZh.includes('大特写') && sbZh.includes('0.8–2s'), '分镜人设（zh）大特写缺时长口径（0.8–2s）');
  // motion 起点→方式→终点 + 禁止空模板平移 + 同场连续三镜不同运动
  ok(sbZh.includes('起点 → 运动方式 → 终点'), '分镜人设（zh）motion 未写「起点 → 运动方式 → 终点」');
  ok(sbZh.includes('空模板'), '分镜人设（zh）未禁止空模板运镜');
  ok(/连续三镜不得使用同一种运动方式/.test(sbZh), '分镜人设（zh）未写「同场连续三镜不得同种运动」');
  ok(sbEn.includes('start -> movement -> end') && /three consecutive shots/.test(sbEn), '分镜人设（en）缺少 motion 公式/三镜不同运动');
  // 每场至少一个冲撞点 + 至少两种手段
  ok(/每场至少一个冲撞点/.test(sbZh), '分镜人设（zh）未写「每场至少一个冲撞点」');
  for (const k of ['短镜头堆叠', '反向构图', '跳切', '声音突入']) ok(sbZh.includes(k), `分镜人设（zh）冲撞手段缺「${k}」`);
  ok(/COLLISION POINT/.test(sbEn) && /stacked short shots/.test(sbEn) && /sound intrusion/.test(sbEn), '分镜人设（en）缺少冲撞点/手段');
  // 因果钩子 + 术语
  ok(sbZh.includes('因果钩子') && sbZh.includes('调度'), '分镜人设（zh）缺「因果钩子」或「调度」术语');
  ok(/术语必须正确/.test(sbZh), '分镜人设（zh）未写术语正确约束');

  // 剧本人设：四要素 + 因果钩子（zh/en）
  for (const k of ['目标', '阻碍', '转折', '代价', '因果钩子']) ok(scZh.includes(k), `剧本人设（zh）缺少「${k}」`);
  for (const k of ['goal', 'obstacle', 'turn', 'cost', 'CAUSAL HOOK']) ok(scEn.includes(k), `剧本人设（en）缺少「${k}」`);

  // 输出结构约束不变：jsonContract 里的字段名必须原样保留（只提升内容质量，不改解析依赖）
  const contractBlock = (() => {
    const i = src.indexOf('const contFields = (() => {');
    if (i < 0) return '';
    const j = src.indexOf('})();', i);
    return j > 0 ? src.slice(i, j) : '';
  })();
  ok(!!contractBlock, '未能定位 contFields（分镜 JSON 契约）');
  const fields = [...new Set([...contractBlock.matchAll(/"([a-zA-Z]+)":/g)].map((m) => m[1]))].sort();
  const EXPECT = ['cam', 'characters', 'dialogue', 'duration', 'line', 'motion', 'props', 'role', 'scene', 'seg', 'sfx', 'start', 'tail', 'title', 'visual'].sort();
  ok(fields.join(',') === EXPECT.join(','), `分镜 JSON 字段被改动（实际：${fields.join(',')}）`);
  ok(src.includes('只输出一个 JSON 对象：{"shots":['), '分镜契约不再要求只输出 {"shots":[...]}');
  ok(src.includes('"dialogue":[{"role"'), '分镜契约的 dialogue 结构 {role,line} 被改动');
  ok(src.includes('数量由内容自然决定（3-10 镜都正常）'), '分镜契约的镜头数量口径被改动（应保持按内容自然决定）');
  ok(src.includes('**仅作参考**——必须按实际动作节拍切分'), '镜头数参数应仍为「仅参考」，不得变成硬性数量');
}

// ---------- B) 快捷键：注册、目录可见、面板可见、动作把技能文本送进剪贴板 ----------
if (SKILL && TABS && SYNC) {
  const id = SKILL.SKILL_SHORTCUT_ID;
  ok(typeof id === 'string' && /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/.test(id), `快捷键 id 不符合 DSH 命令命名规则：${id}`);
  ok(registered.length === 1, `ctx.shortcuts.register 应被调用 1 次，实际 ${registered.length} 次`);
  const cmd = registered[0] || {};
  ok(cmd.id === id, `注册的快捷键 id 不是 ${id}`);
  // 命令目录数据源可枚举且包含它（真实 registry 的 ctx.shortcuts.catalog 同口径）
  const catalog = fakeShortcuts.catalog.getSnapshot();
  ok(catalog.some((row) => row.id === id) && catalog.find((row) => row.id === id).label, '快捷键目录数据源里没有该命令或缺少 label');
  // 平台默认键位：desktop 三平台 + web windows/macos；web linux 因 DSH 白名单不声明
  const keys = Object.keys(cmd.defaults || {}).sort();
  for (const p of ['desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows']) {
    ok(keys.includes(p), `快捷键缺少平台默认键位 ${p}`);
    const b = cmd.defaults[p];
    ok(b && b.code === 'KeyK' && Array.isArray(b.modifiers) && b.modifiers.join('+') === 'primary+shift', `${p} 的默认键位应为 primary+shift+KeyK（实际 ${JSON.stringify(b)}）`);
  }
  ok(!keys.includes('web:linux'), 'web:linux 不应声明默认键位（dsh-client-shortcuts 的 Web/Linux 白名单会拒绝）');
  // 键位声明要能通过 DSH 的 parseShortcutDefinitions：profile 名 / 物理 code / 修饰键取值都必须是合法集合
  const PROFILES = /^(desktop|web):(macos|windows|linux)$/;
  const MODIFIERS = new Set(['primary', 'control', 'alt', 'shift', 'meta']);
  const CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/;
  for (const [p, b] of Object.entries(cmd.defaults || {})) {
    ok(PROFILES.test(p), `非法的平台 profile：${p}`);
    ok(CODE.test(b.code || ''), `${p}: 非法的物理 code：${b.code}`);
    ok(Array.isArray(b.modifiers) && b.modifiers.length > 0 && b.modifiers.every((m) => MODIFIERS.has(m)), `${p}: 非法的修饰键：${JSON.stringify(b.modifiers)}`);
  }
  ok(Array.isArray(cmd.regions) && cmd.regions.includes('page') && Array.isArray(cmd.modals), '快捷键缺少 regions/modals 约束');
  // 动作：resolve → handled → run 打开画布并弹出技能浮层
  ok(SKILL.paletteOpen() === false, '技能浮层初始不应是打开状态');
  const res = cmd.resolve({ region: 'page', modal: null });
  ok(res && res.status === 'handled' && typeof res.run === 'function', '快捷键 resolve 未返回 handled + run');
  res.run();
  ok(SKILL.paletteOpen() === true, '执行快捷键后技能浮层未打开');
  ok(ctx.selectedPanels.includes('infinite-canvas'), '执行快捷键未聚焦/打开画布面板（layout.selectPanel）');

  // 插件快捷键浮层（面板数据源）里能看到快捷键行与技能入口按钮
  SYNC.setKeysOpen(true);
  const texts = [];
  const buttons = [];
  (function walk(el) {
    if (el == null || typeof el === 'boolean') return;
    if (typeof el === 'string' || typeof el === 'number') { texts.push(String(el)); return; }
    if (Array.isArray(el)) { el.forEach(walk); return; }
    if (el.__el) {
      if (el.type === 'button') buttons.push(el);
      walk(el.props.children);
    }
  })(TABS.ShortcutsPanel({}));
  ok(texts.some((t) => t.includes('Ctrl/⌘ ⇧ K')), '快捷键浮层未列出 Ctrl/⌘ ⇧ K');
  ok(texts.some((t) => t.includes('创作技能')), '快捷键浮层未出现「创作技能」分组/按钮文案');
  const action = buttons.find((b) => b.props && b.props.className === 'dshic-keys-action');
  ok(!!action, '快捷键浮层缺少技能入口按钮（.dshic-keys-action）');
  SKILL.closeSkillPalette();
  if (action) {
    action.props.onClick({ stopPropagation: noop });
    ok(SKILL.paletteOpen() === true, '点击快捷键浮层里的技能入口按钮未打开技能浮层');
  }
  SYNC.setKeysOpen(false);

  // 技能浮层本身：三条内置技能 + 复制按钮
  SKILL.openSkillPalette();
  const paletteEl = TABS.SkillPalette({});
  const paletteTexts = [];
  (function walk(el) {
    if (el == null || typeof el === 'boolean') return;
    if (typeof el === 'string' || typeof el === 'number') { paletteTexts.push(String(el)); return; }
    if (Array.isArray(el)) { el.forEach(walk); return; }
    if (el.__el) walk(el.props.children);
  })(paletteEl);
  for (const name of ['canvas-studio', 'canvas-craft', 'canvas-layout']) {
    ok(paletteTexts.includes(name), `技能浮层未列出内置技能 ${name}`);
  }
  ok(paletteTexts.filter((t) => t === '复制全文').length === 3, '技能浮层每个技能都应有「复制全文」按钮');
  SKILL.closeSkillPalette();

  // 动作桩验证：复制技能全文 → 剪贴板收到技能正文
  clipboardText = null;
  const copied = await SKILL.copySkillText('canvas-craft');
  ok(copied === SKILL_BODY, `copySkillText 返回的技能正文不正确（长度 ${String(copied).length}）`);
  ok(clipboardText === SKILL_BODY, '快捷键技能动作未把技能全文送进剪贴板');
}

// ---------- C) 专家：单一「专家」下拉（只列本插件）+ 迁移 + 剧本/分镜统一调度 ----------
if (SETTINGS && TABS) {
  const ST_KEY = 'dsh-ic:settings';
  const readWith = (obj) => { lsStore.set(ST_KEY, JSON.stringify(obj)); return SETTINGS.loadSettings(); };
  // 1) 迁移：旧 skillScript/skillStoryboard（无 expert）→ general；非法/缺失也回退 general
  let st = readWith({ skillScript: 'canvas-craft', skillStoryboard: 'canvas-craft' });
  eq(st.expert, 'general', '旧 settings（skillScript/skillStoryboard）迁移后 expert 不是 general');
  ok(!Object.prototype.hasOwnProperty.call(st, 'skillScript') && !Object.prototype.hasOwnProperty.call(st, 'skillStoryboard'),
    'loadSettings 仍输出旧 skillScript/skillStoryboard 字段（应只读 expert）');
  eq(readWith({ expert: 'not-a-real-expert' }).expert, 'general', '非法 expert 未回退 general');
  eq(readWith({}).expert, 'general', '缺 expert 字段未回退 general');
  eq(readWith({ expert: 'general' }).expert, 'general', '合法 expert 未保留');
  lsStore.delete(ST_KEY);
  eq(SETTINGS.loadSettings().expert, 'general', '无 settings 时默认不是 general');
  // 2) 数据源：EXPERTS 只有 general；结构支持多专家（persona 按能力 + skills 数组）
  const ids = SETTINGS.EXPERTS.map((e) => e.id);
  ok(ids.length === 1 && ids[0] === 'general', 'EXPERTS 应只有 general，实际：' + ids.join(','));
  for (const e of SETTINGS.EXPERTS) {
    ok(Array.isArray(e.skills) && e.skills.length > 0, e.id + ': skills 不是非空数组');
    ok(e.persona && typeof e.persona.script === 'function' && typeof e.persona.storyboard === 'function',
      e.id + ': persona 必须按 script/storyboard 提供人设');
    for (const s of e.skills) ok(!/^(artcraft|noteboard|office|diagnose)-/.test(s), e.id + ': skills 混入非本插件技能 ' + s);
  }
  // 3) 设置页 UI：标题无括号说明；只有一个专家下拉；选项只含「通用专家」
  readWith({ expert: 'general' });
  const els = [];
  const texts = [];
  (function walk(el) {
    if (el == null || typeof el === 'boolean') return;
    if (typeof el === 'string' || typeof el === 'number') { texts.push(String(el)); return; }
    if (Array.isArray(el)) { el.forEach(walk); return; }
    if (el.__el) { els.push(el); walk(el.props.children); }
  })(TABS.SettingsTab());
  ok(texts.includes('技能增强'), '设置页缺少「技能增强」标题');
  ok(!texts.some((t) => t.includes('（用已安装') || t.includes('技能增强（')), '设置页标题仍带括号说明');
  ok(!texts.includes('剧本技能') && !texts.includes('分镜技能'), '设置页仍出现「剧本技能」「分镜技能」标签');
  const expertEls = els.filter((e) => e.type === TABS.ExpertSelect);
  eq(expertEls.length, 1, '设置页应恰好挂载 1 个 ExpertSelect（剧本/分镜两个下拉应已合并）');
  const exTree = TABS.ExpertSelect({ value: 'general', onChange: noop });
  const exEls = [];
  (function walkEx(el) {
    if (el == null || typeof el === 'boolean') return;
    if (typeof el === 'string' || typeof el === 'number') return;
    if (Array.isArray(el)) { el.forEach(walkEx); return; }
    if (el.__el) { exEls.push(el); walkEx(el.props.children); }
  })(exTree);
  const selects = exEls.filter((e) => e.type === 'select');
  eq(selects.length, 1, '专家下拉组件应只有一个 select');
  const expertSel = selects[0];
  ok(expertSel && expertSel.props['data-role'] === 'expert-select', '专家下拉缺少 data-role="expert-select"');
  // 卡片大标题已说明用途：不得再多一行「专家 ⓘ」小标签（历史返工点）
  ok(!exEls.some((e) => String((e.props && e.props.className) || '') === 'dshic-field-label'),
    '专家下拉上方仍有多余的字段标签行（应只保留下拉框）');
  const optTexts = [];
  (function walkOpt(el) {
    if (el == null || typeof el === 'boolean') return;
    if (Array.isArray(el)) { el.forEach(walkOpt); return; }
    if (el.__el) {
      if (el.type === 'option') { optTexts.push(String(el.props.children)); return; }
      walkOpt(el.props.children);
    }
  })(expertSel);
  eq(optTexts.length, 1, '专家下拉选项应只有 1 个（通用专家），实际：' + optTexts.join(','));
  eq(optTexts[0], '通用专家', '专家下拉默认选项不是「通用专家」');
  ok(!optTexts.some((t) => /artcraft-|noteboard-|office-|diagnose-/.test(t)), '专家下拉渲染了 Harness 其它技能名');
  eq(String(expertSel.props['data-expert-options'] || ''), 'general', '专家下拉的数据源（data-expert-options）不是只有 general');
  ok(!/artcraft-|noteboard-|office-|diagnose-/.test(String(expertSel.props['data-expert-options'] || '')), '专家下拉数据源混入 Harness 技能名');
  // 数据源级：ExpertSelect 不得再调用 useSkills（否则只是"过滤显示"）
  const exStart = src.indexOf('function ExpertSelect(');
  const exSrc = exStart >= 0 ? src.slice(exStart, src.indexOf('\n    function', exStart + 10)) : '';
  ok(!!exSrc, '未能定位 ExpertSelect 源码');
  ok(!/useSkills\s*\(/.test(exSrc), 'ExpertSelect 仍从 Harness 全量技能（useSkills）取数据');
  ok(!/'skillScript'|'skillStoryboard'/.test(src), '源码仍保留旧技能标签 i18n key');
  ok(src.includes("'skillEnhance': 'Skill boost',"), '英文标题仍不是纯「Skill boost」');
  // 4) 调度：general 的剧本/分镜上下文都包含 persona + 技能规则；假专家验证结构支持多专家
  const sc = await SETTINGS.buildExpertContext('script', { expert: 'general' }, true);
  ok(sc.persona.includes('目标') && sc.persona.includes('阻碍') && sc.persona.includes('因果钩子'), '剧本上下文缺少通用专家 persona（四要素/因果钩子）');
  ok(String(sc.rules || '').includes('严格遵循') && String(sc.rules || '').includes('六要素'), '剧本上下文缺少 canvas-craft 技能规则正文');
  const sb = await SETTINGS.buildExpertContext('storyboard', { expert: 'general' }, true);
  ok(sb.persona.includes('六要素') && sb.persona.includes('大特写'), '分镜上下文缺少通用专家 persona（六要素/大特写）');
  ok(String(sb.rules || '').includes('六要素'), '分镜上下文缺少 canvas-craft 技能规则正文');
  const general = SETTINGS.EXPERTS[0];
  const fake = {
    id: 'ancient-costume', nameKey: 'expertGeneral',
    persona: { script: () => 'FAKE-SCRIPT-PERSONA', storyboard: () => 'FAKE-STORYBOARD-PERSONA' },
    skills: ['canvas-craft'],
  };
  const reg = [general, fake];
  ok(SETTINGS.expertFor('ancient-costume', reg) === fake, 'expertFor 未按 id 从注入注册表取到第二专家');
  ok(SETTINGS.expertFor('missing', reg) === general, 'expertFor 对未知 id 未回退 general');
  eq(SETTINGS.expertIdOrDefault('ancient-costume'), 'general', 'expertIdOrDefault 未把非内置 id 回退 general');
  const cf = await SETTINGS.buildExpertContext('script', { expert: 'ancient-costume' }, true, reg);
  eq(cf.persona, 'FAKE-SCRIPT-PERSONA', '假专家的人设没有生效（调度仍写死 general）');
  eq(cf.skills.join(','), 'canvas-craft', '假专家的 skills 未被调度使用');
  const cfb = await SETTINGS.buildExpertContext('storyboard', { expert: 'ancient-costume' }, true, reg);
  eq(cfb.persona, 'FAKE-STORYBOARD-PERSONA', '假专家分镜人设没有生效');
  // 真实生成入口：剧本/分镜都必须走 buildExpertContext，且把 persona + rules 拼进 system（不再读旧字段）
  const fnSlice = (name) => {
    const i = src.indexOf('async function ' + name + '(');
    const j = i >= 0 ? src.indexOf('\n    async function ', i + 10) : -1;
    return i >= 0 ? src.slice(i, j > 0 ? j : src.length) : '';
  };
  const scriptFn = fnSlice('aiScriptNodes');
  const sbFn = fnSlice('aiStoryboardShots');
  ok(/buildExpertContext\('script'/.test(scriptFn), '剧本生成没有走 buildExpertContext(script)');
  ok(/ctx\.persona/.test(scriptFn) && /ctx\.rules/.test(scriptFn), '剧本生成没有把专家 persona/rules 拼进 system');
  ok(/buildExpertContext\('storyboard'/.test(sbFn), '分镜生成没有走 buildExpertContext(storyboard)');
  ok(/ctxSb\.persona/.test(sbFn) && /ctxSb\.rules/.test(sbFn), '分镜生成没有把专家 persona/rules 拼进 system');
  ok(!/loadSkillRules\(settings\.skill(Script|Storyboard)/.test(src), '生成代码仍读取旧 skillScript/skillStoryboard 字段');
}

// ============================================================
// 二、Host 半：技能注册进 skills 服务，可枚举、可加载
// ============================================================
const hostProviders = [];
const hostTools = [];
const fakeSkills = { registerProvider: (fn) => { hostProviders.push(fn()); return () => {}; } };
const hostCtx = {
  effect(fn) { fn(); return () => {}; },
  get(name) { return name === 'skills' ? fakeSkills : undefined; },
  webServer: { register: () => () => {} },
  tools: { register: (def) => { hostTools.push(def); return () => {}; } },
};
try {
  const hostMod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  hostMod.apply(hostCtx);
} catch (e) {
  errs.push('Host apply(ctx) 执行失败 → ' + ((e && e.stack) || e));
}
try {
  ok(hostProviders.length === 1, `Host 应向 skills 服务注册 1 个提供方，实际 ${hostProviders.length}`);
  const p = hostProviders[0] || {};
  ok(p.name === 'dsh-infinite-canvas', '技能提供方 name 应为 dsh-infinite-canvas');
  const list = await p.list();
  const names = (list || []).map((c) => c.name).sort();
  ok(names.join(',') === 'canvas-craft,canvas-layout,canvas-studio', `技能目录应可枚举出三份内置技能，实际 ${names.join(',')}`);
  const need = {
    'canvas-craft': ['六要素', '大特写', '冲撞点', '起点', '调度'],
    'canvas-studio': ['大特写', '调度', '六要素', 'canvas_update_bible'],
    'canvas-layout': ['一类型一列', '绝不重叠'],
  };
  for (const cand of list || []) {
    ok(Number.isFinite(cand.rank), `${cand.name}: rank 必须是有限数字`);
    ok(cand.invocation && cand.invocation.modelInvocable === true && cand.invocation.userInvocable === true, `${cand.name}: 技能必须 modelInvocable + userInvocable`);
    const got = await p.get(cand, {});
    ok(typeof got.content === 'string' && got.content.length > 300, `${cand.name}: 技能正文不可加载或过短`);
    for (const k of need[cand.name] || []) ok(String(got.content).includes(k), `${cand.name}: 技能正文缺少新规则关键词「${k}」`);
    ok(got.rank === undefined && got.locator === undefined, `${cand.name}: get() 应剥离内部字段 rank/locator`);
  }
} catch (e) {
  errs.push('技能提供方断言失败 → ' + ((e && e.stack) || e));
}

// ============================================================
// 输出
// ============================================================
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
if (errs.length) {
  console.error(`✗ 技能注入/快捷键契约测试失败（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 技能注入 + 快捷键契约通过：');
console.log('  · 分镜人设：六要素 / 每场大特写 / motion 起点→方式→终点 / 连续三镜不同运动 / 每场冲撞点 / 因果钩子 / 术语');
console.log('  · 剧本人设：四要素 + 因果钩子；分镜 JSON 输出字段未改动');
console.log('  · Host 技能目录可枚举 3 份内置技能（modelInvocable，正文含新规则）');
console.log('  · 快捷键 ' + (process.env.IC_SKILL_ID || 'infinite-canvas.skill') + '：Ctrl/⌘+Shift+K，目录可见、浮层可见、动作把技能全文送进剪贴板');
console.log('  · 专家：单一「专家」下拉（仅通用专家）；旧字段迁移 general；剧本/分镜统一调度 persona+skills；多专家结构可扩展');
process.exit(0);
