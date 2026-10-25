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

// ---------- A) 硬规则来源（方案 A）：人设已删除，规则唯一来源 = canvas-craft 技能正文 ----------
if (SKILL) {
  // 人设常量与注册表必须已移除（方案 A 的核心：同一套规则只留一份）
  ok(typeof SKILL.EXPERT_SCRIPT === 'undefined', 'EXPERT_SCRIPT 仍被导出（人设应已删除）');
  ok(typeof SKILL.EXPERT_STORYBOARD === 'undefined', 'EXPERT_STORYBOARD 仍被导出（人设应已删除）');
  ok(!/const EXPERT_SCRIPT\s*=/.test(src), '源码仍定义 EXPERT_SCRIPT');
  ok(!/const EXPERT_STORYBOARD\s*=/.test(src), '源码仍定义 EXPERT_STORYBOARD');
  ok(!/const EXPERTS = \[/.test(src), '源码仍定义 EXPERTS 注册表');
  ok(!/expertIdOrDefault|expertFor|expertPersona|loadExpertRules/.test(src), '源码仍引用已删除的专家函数');

  // 硬规则从技能正文取（Host 的 readSkill 返回 canvas-craft 全文）
  const craft = await (async () => {
    try {
      const sk = await SKILL.buildExpertContext
        ? await (await import('node:fs')).promises.readFile(
          (await import('node:path')).join(ROOT, 'assets', 'canvas-craft', 'SKILL.md'), 'utf8')
        : '';
      return sk;
    } catch { return ''; }
  })();
  ok(!!craft && craft.length > 5000, '读不到 canvas-craft 技能正文');

  // 分镜六要素
  for (const k of ['六要素', '景别', '机位', '前景', '光线方向', '道具']) {
    ok(craft.includes(k), `canvas-craft 技能缺少六要素关键字「${k}」`);
  }
  // 每场大特写 + 时长
  ok(/大特写/.test(craft), 'canvas-craft 技能未写「大特写」');
  ok(/0\.8/.test(craft), 'canvas-craft 技能缺大特写时长口径（0.8–2s）');
  // motion 起点→方式→终点 + 禁止空模板
  ok(/起点/.test(craft) && /终点/.test(craft), 'canvas-craft 技能缺 motion 公式（起点→终点）');
  ok(/空模板|推近|平移/.test(craft), 'canvas-craft 技能缺空模板运镜禁令');
  // 冲撞点与手段
  ok(/冲撞点/.test(craft), 'canvas-craft 技能未写「冲撞点」');
  // 因果钩子 + 术语
  ok(/因果钩子/.test(craft), 'canvas-craft 技能缺「因果钩子」');
  ok(/调度/.test(craft), 'canvas-craft 技能缺「调度」术语');

  // 剧本四要素
  for (const k of ['目标', '阻碍', '转折', '代价']) {
    ok(craft.includes(k), `canvas-craft 技能缺剧本四要素「${k}」`);
  }

  // buildExpertContext 必须把 canvas-craft 规则与技能包切片都产出
  // 注：沙箱里 readSkill RPC 是桩，rules 正文取不到 → 这里断言「结构」，正文由 A) 段读磁盘技能文件覆盖
  const ctx = await SKILL.buildExpertContext('storyboard', {}, true);
  ok(!!ctx, 'buildExpertContext 未返回上下文');
  ok(Object.prototype.hasOwnProperty.call(ctx, 'rules'), 'buildExpertContext 未产出 rules 字段');
  ok(typeof ctx.packText === 'string', 'buildExpertContext 未产出 packText（技能包切片）');
  ok(ctx.persona === '', 'buildExpertContext 仍产出人设（方案 A 应为人设留空）');
  ok(Array.isArray(ctx.skills) && ctx.skills.includes('canvas-craft'), 'buildExpertContext 的技能组不含 canvas-craft');
  const becSrc = (() => {
    const i = src.indexOf('async function buildExpertContext(');
    const j = i >= 0 ? src.indexOf('\n    async function aiScriptNodes(', i) : -1;
    return i >= 0 ? src.slice(i, j > 0 ? j : i + 3000) : '';
  })();
  ok(/loadSkillRules\(CRAFT_SKILL/.test(becSrc), 'buildExpertContext 未从 canvas-craft 取硬规则（源码级）');
  ok(/buildSkillPackText\(k\)/.test(becSrc), 'buildExpertContext 未调用 buildSkillPackText（源码级）');

  // 输出结构约束不变：jsonContract 里的字段名必须原样保留（只提升内容质量，不改解析依赖）
  const contractBlock = (() => {
    const i = src.indexOf('const contFields = (() => {');
    if (i < 0) return '';
    const j = src.indexOf('})();', i);
    return j > 0 ? src.slice(i, j) : '';
  })();
  ok(!!contractBlock, '未能定位 contFields（分镜 JSON 契约）');
  const fields = [...new Set([...contractBlock.matchAll(/"([a-zA-Z]+)":/g)].map((m) => m[1]))].sort();
  // 追加四个"动作是否演得出来"的字段（用户实测：动作极简/只会平移/没有特效）：
  //   timeBeats 三节拍 / camera 机位三件套 / vfx 物理特效 / negative 负向要求
  const EXPECT = ['cam', 'camera', 'characters', 'dialogue', 'duration', 'line', 'motion', 'negative', 'props', 'role', 'scene', 'seg', 'sfx', 'start', 'tail', 'timeBeats', 'title', 'vfx', 'visual'].sort();
  ok(fields.join(',') === EXPECT.join(','), `分镜 JSON 字段被改动（实际：${fields.join(',')}）`);
  // 四个新字段必须是"硬性"要求，不能只出现在 JSON 示例里
  for (const k of ['【动作层次·硬性】timeBeats', 'camera 是本镜的机位/焦段/运镜三件套', 'vfx 是本镜必须可见的物理特效', 'negative 是本镜要排除的失败项', '【切段友好·硬性】']) {
    ok(src.includes(k), `分镜契约缺少硬性要求「${k}」`);
  }
  ok(src.includes('**禁止只写"推近/拉远/平移"这类空模板**') || src.includes('禁止只写"推近/拉远/平移"'), '分镜契约未禁止空模板运镜（"只会平移"的直接来源）');
  ok(src.includes('只输出一个 JSON 对象：{"shots":['), '分镜契约不再要求只输出 {"shots":[...]}');
  ok(src.includes('"dialogue":[{"role"'), '分镜契约的 dialogue 结构 {role,line} 被改动');
  ok(src.includes('数量由内容自然决定（3-10 镜都正常）'), '分镜契约的镜头数量口径被改动（应保持按内容自然决定）');
  ok(src.includes('**仅作参考**——必须按实际动作节拍切分'), '镜头数参数应仍为「仅参考」，不得变成硬性数量');
  ok(ctx.persona === '', 'buildExpertContext 仍产出人设（方案 A 应为人设留空）');
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

// ---------- C) 方案 A：专家层已移除，设置里不再有专家字段/下拉 ----------
if (SETTINGS && TABS) {
  const ST_KEY = 'dsh-ic:settings';
  const readWith = (obj) => { lsStore.set(ST_KEY, JSON.stringify(obj)); return SETTINGS.loadSettings(); };
  // 1) 旧字段（skillScript/skillStoryboard/expert）一律不再输出，也不报错
  const st = readWith({ skillScript: 'canvas-craft', skillStoryboard: 'canvas-craft', expert: 'general' });
  ok(!Object.prototype.hasOwnProperty.call(st, 'expert'), 'loadSettings 仍输出 expert 字段（方案 A 应已移除）');
  ok(!Object.prototype.hasOwnProperty.call(st, 'skillScript'), 'loadSettings 仍输出旧 skillScript 字段');
  ok(!Object.prototype.hasOwnProperty.call(st, 'skillStoryboard'), 'loadSettings 仍输出旧 skillStoryboard 字段');
  lsStore.delete(ST_KEY);
  ok(!Object.prototype.hasOwnProperty.call(SETTINGS.loadSettings(), 'expert'), '无 settings 时 loadSettings 仍带 expert');

  // 2) 设置页：没有专家下拉、没有「技能增强」卡
  const els = [];
  const texts = [];
  (function walk(el) {
    if (el == null || typeof el === 'boolean') return;
    if (typeof el === 'string' || typeof el === 'number') { texts.push(String(el)); return; }
    if (Array.isArray(el)) { el.forEach(walk); return; }
    if (el.__el) { els.push(el); walk(el.props.children); }
  })(TABS.SettingsTab());
  ok(!texts.includes('技能增强'), '设置页仍有「技能增强」标题（应已迁到技能页）');
  ok(!texts.includes('通用专家'), '设置页仍出现「通用专家」（方案 A 应已移除）');
  ok(!els.some((e) => e.type === TABS.ExpertSelect), '设置页仍挂载 ExpertSelect');
  ok(!/data-role': 'expert-select'/.test(src), '源码仍渲染 expert-select 下拉');

  // 3) 人设与注册表源码级已删除
  ok(typeof SETTINGS.EXPERTS === 'undefined', 'SETTINGS 仍导出 EXPERTS');
  ok(!/const EXPERT_SCRIPT\s*=/.test(src), '源码仍定义 EXPERT_SCRIPT');
  ok(!/const EXPERT_STORYBOARD\s*=/.test(src), '源码仍定义 EXPERT_STORYBOARD');
  ok(!/expertIdOrDefault|expertFor|expertPersona|loadExpertRules/.test(src), '源码仍引用专家函数');

  // 4) 剧本/分镜都走 buildExpertContext，且把「canvas-craft 规则 + 技能包切片」拼进 system
  const sc = await SETTINGS.buildExpertContext('script', {}, true);
  ok(sc.persona === '', '剧本上下文 persona 应为空（方案 A）');
  ok(String(sc.rules || '').includes('严格遵循') && String(sc.rules || '').includes('六要素'), '剧本上下文缺 canvas-craft 规则正文');
  ok(typeof sc.packText === 'string', '剧本上下文缺技能包切片 packText');
  const sb = await SETTINGS.buildExpertContext('storyboard', {}, true);
  ok(String(sb.rules || '').includes('六要素'), '分镜上下文缺 canvas-craft 规则正文');
  ok(typeof sb.packText === 'string', '分镜上下文缺技能包切片 packText');

  // 5) 三个生成入口都必须同时拼 rules 与 packText
  const fnSlice = (name) => {
    const i = src.indexOf('async function ' + name + '(');
    const j = i >= 0 ? src.indexOf('\n    async function ', i + 10) : -1;
    return i >= 0 ? src.slice(i, j > 0 ? j : src.length) : '';
  };
  const scriptFn = fnSlice('aiScriptNodes');
  const sbFn = fnSlice('aiStoryboardShots');
  ok(/buildExpertContext\('script'/.test(scriptFn), '剧本生成没有走 buildExpertContext(script)');
  ok(/ctx\.rules/.test(scriptFn), '剧本生成没有把 canvas-craft 规则拼进 system');
  ok(/ctx\.packText/.test(scriptFn), '剧本生成没有把技能包切片拼进 system');
  ok(/buildExpertContext\('storyboard'/.test(sbFn), '分镜生成没有走 buildExpertContext(storyboard)');
  ok(/ctxSb\.rules/.test(sbFn), '分镜生成没有把 canvas-craft 规则拼进 system');
  ok(/ctxSb\.packText/.test(sbFn), '分镜生成没有把技能包切片拼进 system');
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
  ok(names.join(',') === 'canvas-craft,canvas-director,canvas-layout,canvas-studio', `技能目录应可枚举出四份内置技能，实际 ${names.join(',')}`);
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
console.log('  · 硬规则来源：canvas-craft 技能正文（六要素 / 大特写 / motion 公式 / 冲撞点 / 因果钩子 / 术语 / 四要素）');
console.log('  · 分镜 JSON 输出字段未改动（timeBeats / camera / vfx / negative 齐备）');
console.log('  · Host 技能目录可枚举 4 份内置技能（modelInvocable，正文含新规则）');
console.log('  · 快捷键 ' + (process.env.IC_SKILL_ID || 'infinite-canvas.skill') + '：Ctrl/⌘+Shift+K，目录可见、浮层可见、动作把技能全文送进剪贴板');
console.log('  · 方案 A：专家层已移除（人设 / 注册表 / 下拉全部不存在）；剧本与分镜统一走 canvas-craft + 技能包切片');
process.exit(0);
