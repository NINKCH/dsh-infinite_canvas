#!/usr/bin/env node
/**
 * 移动/追逐语义回归（P2）：
 *   ① 按场检测：轻功/连续跨阶/墙跑/攀爬/追逐命中；追查/回忆/对白不误判；on/off 覆盖
 *   ② 契约块：连续位移 = 一个主动作；拆镜只拆接触点；timeBeats 写接触点；
 *      台阶一跨 3–5 阶；墙面接触/重量/碎屑；怪物质量；禁止逐阶跑/滑步/钢丝感
 *   ③ 漂移守卫：client.js（vm 加载）与 movement-semantics.js（import）逐字一致
 *   ④ 词表与 3D 姿势对齐：已有 fly/crouch/dash_forward 必须真实存在于 BONE_POSES
 *
 * 运行：node scripts/test-movement-semantics.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

let host = null;
try {
  host = await import(pathToFileURL(path.join(ROOT, 'movement-semantics.js')).href);
} catch (e) {
  console.error('✗ 移动/追逐语义测试未通过（1 项）：');
  console.error('  - movement-semantics.js 不存在或无法加载：' + (e && e.message));
  process.exit(1);
}
const {
  detectMovementScene,
  movementContractAddendum,
  MOVEMENT_ACTION_LEXICON,
} = host;

// ---------------- ① 按场检测 ----------------
{
  const stairs = '【场1】山门石阶（夜）\n@陈拾@ 一步跨过三级石阶，脚尖在栏杆上一点，翻上屋脊；@怪物@ 贴着墙面奔行，随后蹬墙扑下。';
  const r = detectMovementScene(stairs, {});
  ok(r.hit === true, '检测：连续跨阶/墙跑文本应命中（实际 ' + JSON.stringify(r) + '）');
  ok(r.matched.length > 0 && r.mode === 'auto', '检测：命中词被记录、mode=auto');

  const chase = '两人在屋脊上奔跑，瓦片不断坠落，前面的身影一跃掠过三丈宽的巷口。';
  ok(detectMovementScene(chase, {}).hit === true, '检测：屋脊奔跑/飞跃应命中');

  const climb = '怪物四肢着地攀上外墙，爪子在砖上刮出白痕。';
  ok(detectMovementScene(climb, {}).hit === true, '检测：攀爬/墙面接触应命中');

  const fly = '他御剑飞行，穿过云层。';
  ok(detectMovementScene(fly, {}).hit === true, '检测：飞行应命中');

  const vault = '他纵身跃起，抓住屋檐。';
  ok(detectMovementScene(vault, {}).hit === true, '检测：跃起/抓屋檐应命中');

  const wallVault = '他翻身越过院墙。';
  ok(detectMovementScene(wallVault, {}).hit === true, '检测：翻身越墙应命中');

  const actionWithTag = '@陈拾@ 说道，一步跨过三级石阶。';
  ok(detectMovementScene(actionWithTag, {}).hit === true, '检测：说话标签 + 同一句动作，动作仍应命中');

  const pureDialogue = '「快追！」@陈拾@ 说道。';
  ok(detectMovementScene(pureDialogue, {}).hit === false, '检测：纯对白行不应误判');

  const gaze = '他的目光掠过窗台上的灰尘。';
  ok(detectMovementScene(gaze, {}).hit === false, '检测：「目光掠过」不应误判为移动');

  const smell = '一阵桂花香扑来。';
  ok(detectMovementScene(smell, {}).hit === false, '检测：「香气扑来」不应误判为移动');

  const metaphor = '他终于跨过心里那道坎。';
  ok(detectMovementScene(metaphor, {}).hit === false, '检测：隐喻「跨过心里那道坎」不应误判');

  const staticWall = '她贴墙站着，听隔壁的动静。';
  ok(detectMovementScene(staticWall, {}).hit === false, '检测：静态「贴墙站着」不应误判');

  const noun = '这是本门的身法口诀。';
  ok(detectMovementScene(noun, {}).hit === false, '检测：名词「身法口诀」不应误判');

  const investigate = '他追查那封信的来历，翻看旧档案。';
  ok(detectMovementScene(investigate, {}).hit === false, '检测：「追查」不应误判为追逐');

  const memory = '他回忆起当年在屋脊上狂奔的往事。';
  ok(detectMovementScene(memory, {}).hit === false, '检测：回忆语境（含真实移动词）不应误判');

  const training = '他在训练场冲向木桩。';
  ok(detectMovementScene(training, {}).hit === true, '检测：「训练场」不应压掉真实移动动作');

  ok(detectMovementScene('', {}).hit === false, '检测：空文本不应误判');
  ok(detectMovementScene(investigate, { mode: 'on' }).hit === true, '检测：on 强制开启');
  ok(detectMovementScene(stairs, { mode: 'off' }).hit === false, '检测：off 强制关闭');
}

// ---------------- ② 契约块 ----------------
{
  const zh = movementContractAddendum(true).join('\n');
  for (const [label, needle] of [
    ['连续位移=一个主动作', '一个主动作'],
    ['拆镜只拆接触点', '接触点'],
    ['台阶 3–5 阶', '3–5 阶'],
    ['墙跑接触/夹角', '墙面'],
    ['怪物质量', '质量'],
    ['禁止逐阶', '逐阶'],
    ['timeBeats 接触点写法', 'timeBeats'],
    ['速度/镜头豁免', '连续跟拍'],
  ]) {
    ok(zh.includes(needle), '中文契约块缺「' + label + '」：' + needle);
  }
  ok(!/禁止镜内高速位移/.test(zh), '移动契约块不应沿用「禁止镜内高速位移」——连续位移必须镜内完成');
  ok(/覆盖/.test(zh) && /三拍/.test(zh), '移动契约块未显式覆盖 jsonContract 的「三拍」规则');
  ok(/2–4 拍|2-4 拍/.test(zh), '移动契约块未写明接触点节拍 2–4 拍');
  ok(/用户固定总时长/.test(zh), '移动契约块未写明「用户固定总时长优先于 2–5s」');
  ok(/动作词表/.test(zh), '移动契约块未注入可见动作词表');

  const en = movementContractAddendum(false).join('\n');
  for (const needle of ['one primary action', 'contact point', '3-5 steps', 'wall', 'weight', 'never stair-by-stair', 'timeBeats']) {
    ok(en.toLowerCase().includes(needle.toLowerCase()), 'English contract missing: ' + needle);
  }
  ok(/covers the three-beat rule/i.test(en), 'English contract does not override the three-beat rule');
  ok(/user-fixed total duration/i.test(en), 'English contract missing user-fixed total duration precedence');
  ok(/action lexicon/i.test(en), 'English contract missing the visible action lexicon');
}

// ---------------- ④ 词表与 3D 姿势对齐 ----------------
{
  const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
  const ids = new Set((E.BONE_POSES || []).map((p) => p.id));
  for (const id of ['fly', 'crouch', 'dash_forward']) {
    ok(ids.has(id), 'MOVEMENT_ACTION_LEXICON 引用的 3D 姿势不存在：' + id);
  }
  ok(MOVEMENT_ACTION_LEXICON.some((x) => x.id === 'fly'), '移动词表缺 fly/轻功腾空');
  ok(MOVEMENT_ACTION_LEXICON.some((x) => x.id === 'wall_contact'), '移动词表缺墙面接触');
}

// ---------------- ③ 漂移守卫：client.js ----------------
function mkEl(type, props, ...kids) {
  return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
}
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); },
};
const noop = () => {};
const sandbox = {
  window: {
    devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    localStorage: lsStub, location: { href: 'http://localhost/' },
    AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true,
  },
  document: {
    createElement: () => ({
      style: {}, dataset: {}, children: [], appendChild: noop, remove: noop,
      setAttribute: noop, addEventListener: noop, removeEventListener: noop,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    }),
    addEventListener: noop, removeEventListener: noop,
    body: { appendChild: noop }, head: { appendChild: noop }, documentElement: { style: {} },
  },
  localStorage: lsStub, navigator: { language: 'zh-CN', userAgent: 'node' },
  location: { href: 'http://localhost/' },
  setTimeout, clearTimeout, setInterval: (f) => setTimeout(f, 0), clearInterval: noop, queueMicrotask,
  fetch: () => Promise.reject(new Error('no-net')), console,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop,
  TextEncoder, TextDecoder, URL, URLSearchParams, Promise, JSON, Math, Date, Number, String,
  Array, Object, Map, Set, Error, RegExp, parseInt, parseFloat, isNaN, isFinite, Buffer, Blob: class {},
};
sandbox.globalThis = sandbox;
sandbox.window.globalThis = sandbox.window;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try {
  vm.runInContext(readFileSync(path.join(ROOT, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' });
  const plugin = mod.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error('意外 require: ' + name);
  });
  plugin.apply({
    effect(fn) { fn(); },
    locale: { register: noop, subscribe: () => () => {} },
    slots: { inject(n, cb) { cb(); }, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
  });
} catch (e) {
  errs.push('client.js 顶层执行失败：' + e.message);
}
const SEG = sandbox.window.__DSH_IC_SEGMENT__;
ok(SEG && typeof SEG.detectMovementScene === 'function', 'client.js 未暴露 detectMovementScene（漂移守卫缺失）');
ok(SEG && typeof SEG.movementContractAddendum === 'function', 'client.js 未暴露 movementContractAddendum（漂移守卫缺失）');
if (SEG && typeof SEG.detectMovementScene === 'function') {
  const fixtures = [
    '他一步跨过三级石阶，脚尖在栏杆上一点，翻上屋脊。',
    '怪物贴着墙面奔行，随后蹬墙扑下。',
    '两人在屋脊上追逐，瓦片不断坠落。',
    '他追查那封信的来历。',
    '他回忆起当年在山上奔跑的往事。',
    '',
  ];
  for (const mode of ['auto', 'on', 'off']) {
    for (const t of fixtures) {
      const a = JSON.stringify(SEG.detectMovementScene(t, { mode }));
      const b = JSON.stringify(detectMovementScene(t, { mode }));
      ok(a === b, '漂移守卫 detectMovementScene(' + JSON.stringify(t.slice(0, 14)) + ',' + mode + ')：client=' + a + ' host=' + b);
    }
  }
  ok(SEG.movementContractAddendum(true).join('\n') === movementContractAddendum(true).join('\n'), '漂移守卫：zh 移动契约块不一致');
  ok(SEG.movementContractAddendum(false).join('\n') === movementContractAddendum(false).join('\n'), '漂移守卫：en 移动契约块不一致');
}

if (errs.length) {
  console.error('✗ 移动/追逐语义测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 移动/追逐语义通过（检测 / 契约 / 漂移 / 3D 词表）');
