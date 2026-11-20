#!/usr/bin/env node
/**
 * 视频提示词字段完整性回归（P0）：
 *   有参考图时走 buildStructuredVideoPrompt（subject/picture 绑定路径），
 *   逐镜必须仍然带出 camera / timeBeats / vfx / 打斗因果——这四类字段是
 *   「导演镜头语言 / 动作不是平移 / 特殊技能不机械」在最后一公里的唯一载体。
 *
 * 另一条 buildStoryboardVideoPrompt（无参考图回退路径）已经会写这些字段；
 * 本测试同时断言两条路径对同一组 shot 的字段输出一致，防止再次漂移。
 *
 * 运行：node scripts/test-video-prompt-fields.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const noop = () => {};

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
  vm.runInContext(src, sandbox, { filename: 'client.js' });
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
  console.error('✗ client.js 顶层执行失败：' + e.message);
  process.exit(1);
}

const P = sandbox.window.__DSH_IC_STORYBOARD_PROMPT__;
ok(P && typeof P.buildStructuredVideoPrompt === 'function',
  '未暴露 buildStructuredVideoPrompt（有参考图的视频提示词路径不可回归）');
if (!P || typeof P.buildStructuredVideoPrompt !== 'function') {
  console.error('✗ 视频提示词字段测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}

const CAM = 'CAM_LOW_24MM_SIDE_TRACK';
const BEAT1 = 'BEAT_ONE_FOOT_ON_THIRD_STEP';
const BEAT2 = 'BEAT_TWO_AIRBORNE_CLOTH_TRAILS';
const BEAT3 = 'BEAT_THREE_TOE_ON_FIFTH_STEP';
const VFX = 'VFX_STONE_DUST_BURST';
const ATK = 'ATK_CHEN_TO_MONSTER_KNEE';
const REACT = 'REACT_MONSTER_BLOCKS_FOREARM';
const IMPACT = 'IMPACT_KNEE_CRACKS_STONE';
const INIT = 'INIT_CHEN_HOLDS_PRESSURE';
const NEXT = 'NEXT_MONSTER_TAIL_SWEEP';

const shots = [{
  title: '飞跨石阶',
  visual: '@陈拾@ 在 @石阶@ 前压低身体，@怪物@ 从上方扑下',
  motion: '蹬地腾空，连续跨过三阶',
  timeBeats: [BEAT1, BEAT2, BEAT3],
  camera: CAM,
  vfx: VFX,
  attack: ATK,
  reaction: REACT,
  impact: IMPACT,
  initiative: INIT,
  nextCombat: NEXT,
  duration: 3,
  characters: ['陈拾', '怪物'],
  scene: '石阶',
  props: ['石阶'],
  dialogue: [],
  sfx: 'stone scrape',
}];
const refs = [
  { name: '角色-陈拾 多视图', category: 'character', entity: '陈拾' },
  { name: '角色-怪物 多视图', category: 'character', entity: '怪物' },
];
const bible = {
  style: '写实电影感，冷蓝硬光。',
  characters: [
    { name: '陈拾', desc: '外观：短外套、右手护腕；声音：低哑。' },
    { name: '怪物', desc: '外观：灰黑鳞甲、四肢着地。' },
  ],
  scenes: [{ name: '石阶', desc: '外观：湿滑的青石长阶。' }],
  props: [],
};

const structured = P.buildStructuredVideoPrompt(shots, refs, bible, { zh: true });
for (const [label, needle] of [
  ['camera（机位/焦段/运镜）', CAM],
  ['timeBeats 第 1 拍', BEAT1],
  ['timeBeats 第 2 拍', BEAT2],
  ['timeBeats 第 3 拍', BEAT3],
  ['vfx（特效必须可见）', VFX],
  ['attack（攻击指向）', ATK],
  ['reaction（对手回应）', REACT],
  ['impact（受力/破坏）', IMPACT],
  ['initiative（攻守归属）', INIT],
  ['nextCombat（下一镜战斗意图）', NEXT],
]) {
  ok(structured.includes(needle), '结构化视频提示词丢失 ' + label + '：' + needle);
}
ok(structured.includes('subject_definitions'), '结构化路径的主体绑定块被破坏');
ok(structured.includes('retention_analysis'), '结构化路径的保真核对块被破坏');
ok(structured.indexOf(BEAT1) < structured.indexOf(BEAT2) && structured.indexOf(BEAT2) < structured.indexOf(BEAT3),
  'timeBeats 顺序被打乱');

// 两条编译路径不得再漂移：无参考图的回退路径必须与结构化路径字段同源。
const fallback = P.buildStoryboardVideoPrompt({ data: { shots } }, null);
for (const [label, needle] of [
  ['camera', CAM], ['timeBeats', BEAT2], ['vfx', VFX],
  ['attack', ATK], ['reaction', REACT], ['impact', IMPACT],
]) {
  ok(fallback.includes(needle), '回退路径丢失 ' + label + '：' + needle);
}

if (errs.length) {
  console.error('✗ 视频提示词字段测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 视频提示词字段完整（camera / timeBeats / vfx / 打斗因果；两条路径同源）');
