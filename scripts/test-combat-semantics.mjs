#!/usr/bin/env node
/**
 * 战斗语义回归（0.20.5）：打斗分镜因果链——按场检测 / 契约块 / 因果句 / 几何校验 / 词表。
 *
 * 断言五组：
 *   ① 按场检测：命中词触发、对白/回忆排除、空文本不误判、on/off 显式覆盖
 *   ② 契约块：命中打斗才有战斗字段语义 + 动作词表；zh/en 双语
 *   ③ 因果句：只拼存在的字段、空镜返回空、打斗镜完整因果
 *   ④ 几何校验：无回应攻击 / 未指向对手 / 背对写表情 / tail 缺战斗态；非打斗镜不告警
 *   ⑤ 漂移守卫：client.js（vm 加载）与 combat-semantics.js（import）在同一组 fixtures
 *      上输出逐字一致——两端漂移 = 按场检测/契约/因果口径分叉，测试红必须人工对齐
 *   ⑥ 词表与 3D 姿势对齐：COMBAT_ACTION_LEXICON 的 id 必须存在于 engine.js BONE_POSES 打斗段
 *
 * 运行：node scripts/test-combat-semantics.mjs   退出码 0 = 通过；1 = 失败
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMBAT_ACTION_LEXICON as LEX_HOST,
  detectCombatScene as detectHost,
  shotIsCombat as isCombatHost,
  combatContractAddendum as contractHost,
  combatCausalityText as causalityHost,
  validateCombatGeometry as geometryHost,
} from '../combat-semantics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const noop = () => {};

// ---------------- 假 React / DOM（与 test-vendor-detect 同套路） ----------------
function mkEl(type, props, ...kids) { return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) }; }
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), localStorage: lsStub, location: { href: 'http://localhost/' }, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true },
  document: {
    createElement: () => ({ style: {}, dataset: {}, children: [], appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }),
    addEventListener: noop, removeEventListener: noop, body: { appendChild: noop }, head: { appendChild: noop }, documentElement: { style: {} },
  },
  localStorage: lsStub, navigator: { language: 'zh-CN', userAgent: 'node' }, location: { href: 'http://localhost/' },
  setTimeout, clearTimeout, setInterval: (f) => setTimeout(f, 0), clearInterval: noop, queueMicrotask,
  fetch: () => Promise.reject(new Error('no-net')), console,
  performance: { now: () => Date.now() }, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop,
  TextEncoder, TextDecoder, URL, URLSearchParams, Promise, JSON, Math, Date, Number, String, Array, Object, Map, Set, Error, RegExp, parseInt, parseFloat, isNaN, isFinite, Buffer, Blob: class {},
};
sandbox.globalThis = sandbox;
sandbox.window.globalThis = sandbox.window;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
  plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
} catch (e) {
  console.error('✗ client.js 顶层执行失败：' + e.message);
  process.exit(1);
}
const SEG = sandbox.window.__DSH_IC_SEGMENT__;
if (!SEG || typeof SEG.detectCombatScene !== 'function') {
  console.error('✗ 未暴露 window.__DSH_IC_SEGMENT__（战斗语义测试缝隙缺失）');
  process.exit(1);
}
const detect = SEG.detectCombatScene;
const isCombat = SEG.shotIsCombat;
const contract = SEG.combatContractAddendum;
const causality = SEG.combatCausalityText;
const geometry = SEG.validateCombatGeometry;
const lex = SEG.COMBAT_ACTION_LEXICON;

// ---------------- ① 按场检测 ----------------
{
  const fight = '【场1】巷战（夜）\n@李寒@ 挥刀劈向 @沈铁@，@沈铁@ 单臂格挡，随即反击一拳将李寒击退半步。';
  const r = detect(fight, {});
  ok(r.hit === true, '检测：明确打斗文本命中（实际 ' + JSON.stringify(r) + '）');
  ok(r.matched.length > 0 && r.mode === 'auto', '检测：命中词被记录、mode=auto');
  const calm = '【场1】茶馆（午后）\n两人对坐谈判，@李寒@ 说道：「当年的事，就此作罢。」@沈铁@ 点头，窗外雨声渐歇。';
  ok(detect(calm, {}).hit === false, '检测：对白/谈判/回忆场景不误判');
  ok(detect('', {}).hit === false, '检测：空文本不误判');
  ok(detect('两人回忆起当年在战场上厮杀的往事。', {}).hit === false, '检测：回忆语境（厮杀前带「当年…的」叙述）不误判');
  ok(detect('两人聊天，说起昨天新闻里的枪战事件。', {}).hit === false, '检测：转述新闻（枪战在讲述语境里）不误判');
  ok(detect(calm, { mode: 'on' }).hit === true, '覆盖：mode=on 强制命中');
  ok(detect(fight, { mode: 'off' }).hit === false, '覆盖：mode=off 强制不命中');
  ok(detect(fight, { mode: 'off' }).mode === 'off', '覆盖：off 时 mode=off 回传');
  ok(detect('两人隔桌对峙，谁都没有先动手。', {}).hit === false, '检测：对峙（无动作谓语）不误判');
}

// ---------------- ② 契约块 ----------------
{
  const zhOn = contract(true);
  ok(zhOn.some((l) => l.includes('attack')), '契约块 zh：attack 字段语义存在');
  ok(zhOn.some((l) => l.includes('战斗态')), '契约块 zh：tail 战斗态规则存在');
  ok(zhOn.some((l) => l.includes('禁止')), '契约块 zh：招式名/概括词禁令存在');
  ok(zhOn.some((l) => l.includes('攻防三拍')), '契约块 zh：timeBeats 攻防三拍规则存在');
  ok(zhOn.some((l) => l.includes('动作词表')), '契约块 zh：动作词表注入存在');
  ok(zhOn.some((l) => lex.some((x) => l.includes(x.zh))), '契约块 zh：词表词真进了正文');
  const enOn = contract(false);
  ok(enOn.some((l) => l.includes('[COMBAT STORYBOARD - HARD]')), '契约块 en：头部存在');
  ok(enOn.some((l) => lex.some((x) => l.includes(x.en))), '契约块 en：英文词表注入存在');
}

// ---------------- ③ 因果句 ----------------
{
  const combatShot = { title: '镜2', attack: '@李寒@→@沈铁@，锁定胸肩，横枪突刺', reaction: '@沈铁@ 单臂斜上架、上身侧倾卸力', impact: '枪尖擦肩、木栏断裂', initiative: '@李寒@ 持攻', nextCombat: '@沈铁@ 借卸力低身横扫' };
  const zhT = causality(combatShot, true);
  ok(zhT.startsWith('【打斗因果】'), '因果句 zh：前缀正确');
  ok(zhT.includes('攻击（必须朝向该对手）') && zhT.includes('对手回应（必须演出）'), '因果句 zh：攻击/回应两段在');
  ok(zhT.includes('攻守归属') && zhT.includes('下一镜从该攻势继续'), '因果句 zh：攻守/下一镜在');
  const enT = causality(combatShot, false);
  ok(enT.startsWith('[COMBAT CAUSALITY]') && enT.includes('attack (must point at that opponent)'), '因果句 en：前缀+攻击段');
  ok(causality({ title: '文戏' }, true) === '', '因果句：非打斗镜返回空');
  ok(causality({ reaction: '仅回应' }, true).includes('对手回应'), '因果句：只有部分字段时只拼存在的');
}

// ---------------- ④ 几何最小校验 ----------------
{
  const bad = [{ title: '镜1', attack: '横枪突刺' },                                  // 无回应
    { title: '镜2', attack: '横枪突刺', reaction: '格挡' },                            // 未指向对手（无 @ 或 →）
    { title: '镜3', attack: '@A@→@B@ 刺出', reaction: '@B@ 侧身避开', visual: '@B@ 背对镜头，嘴角浮起冷笑' }, // 背对写表情
    { title: '镜4', attack: '@A@→@B@', reaction: '格挡', tail: '停在半跪' },           // tail 缺战斗态
    { title: '文镜', visual: '两人对坐', },                                          // 非打斗镜
  ];
  const w1 = geometry(bad[0], true);
  ok(w1.length === 2 && w1[0].includes('无对手回应') && w1[1].includes('未指向具体对手'), '校验：无回应 + 未指向 → 2 条告警（实际 ' + JSON.stringify(w1) + '）');
  ok(w1[0].startsWith('镜1 · '), '校验：告警带镜标题前缀');
  ok(geometry(bad[1], true).some((w) => w.includes('未指向具体对手')), '校验：无 @/→ 的攻击被告警');
  ok(geometry(bad[2], true).some((w) => w.includes('可见性矛盾')), '校验：背对镜头写表情被告警');
  ok(geometry(bad[3], true).some((w) => w.includes('战斗态')), '校验：tail 缺战斗态被告警');
  ok(geometry(bad[4], true).length === 0, '校验：非打斗镜零告警');
  const good = { title: '镜5', attack: '@李寒@→@沈铁@，锁定胸肩', reaction: '@沈铁@ 上架卸力', tail: '枪尖压在肩前｜战斗态：攻势在 @李寒@' };
  ok(geometry(good, true).length === 0, '校验：合规打斗镜零告警');
  ok(geometry(bad[0], false).some((w) => /no statues/i.test(w)), '校验：英文告警存在');
}

// ---------------- ⑤ 漂移守卫：client.js ↔ combat-semantics.js 逐字一致 ----------------
{
  const FIX = {
    scenes: [
      '【场1】巷战（夜）\n@李寒@ 挥刀劈向 @沈铁@，@沈铁@ 单臂格挡，随即反击一拳将李寒击退半步。',
      '【场1】茶馆（午后）\n两人对坐谈判，@李寒@ 说道：「当年的事，就此作罢。」',
      '两人回忆起当年在战场上厮杀的往事。',
      '',
      '他一剑刺出，对方翻滚躲开，反手一刀劈中肩膀。',
    ],
    shots: [
      { title: '镜2', attack: '@李寒@→@沈铁@，锁定胸肩', reaction: '@沈铁@ 上架卸力', impact: '木栏断裂', initiative: '@李寒@ 持攻', nextCombat: '低身横扫' },
      { title: '文镜', visual: '对坐' },
      {},
    ],
  };
  for (const t of FIX.scenes) {
    for (const mode of ['auto', 'on', 'off']) {
      const a = JSON.stringify(detect(t, { mode }));
      const b = JSON.stringify(detectHost(t, { mode }));
      ok(a === b, '漂移守卫 detectCombatScene(' + JSON.stringify(t.slice(0, 12)) + ',' + mode + ')：client 与 host 输出不一致\n  client=' + a + '\n  host  =' + b);
    }
  }
  for (const s of FIX.shots) {
    ok(JSON.stringify(isCombat(s)) === JSON.stringify(isCombatHost(s)), '漂移守卫 shotIsCombat');
    for (const zh of [true, false]) {
      ok(causality(s, zh) === causalityHost(s, zh), '漂移守卫 combatCausalityText(zh=' + zh + ')');
      ok(JSON.stringify(geometry(s, zh)) === JSON.stringify(geometryHost(s, zh)), '漂移守卫 validateCombatGeometry(zh=' + zh + ')');
    }
  }
  for (const zh of [true, false]) {
    ok(JSON.stringify(contract(zh)) === JSON.stringify(contractHost(zh)), '漂移守卫 combatContractAddendum(zh=' + zh + ')');
    ok(JSON.stringify(lex) === JSON.stringify(LEX_HOST), '漂移守卫 COMBAT_ACTION_LEXICON');
  }
}

// ---------------- ⑥ 词表与 3D 姿势对齐 ----------------
{
  const eng = readFileSync(path.join(ROOT, 'assets', 'director', 'engine.js'), 'utf8');
  const ids = lex.map((x) => x.id);
  ok(ids.length === 12, '词表：12 式齐全（实际 ' + ids.length + '）');
  for (const id of ids) {
    ok(new RegExp("\\{ id: '" + id + "'").test(eng), '词表：' + id + ' 在 3D 姿势库 BONE_POSES 中存在');
  }
  for (const x of lex) {
    ok(x.zh && x.zh.length >= 8 && x.en && x.en.length >= 8, '词表：' + x.id + ' 中英文语义非空');
  }
}

// ---------------- ⑦ 源码契约锚点 ----------------
ok(/combat\.hit \? \[combatContractAddendum\(zh\)\]/.test(src), '源码契约：分镜契约按检测命中注入战斗块');
ok(/combatCausalityText\(s, zh\)/.test(src), '源码契约：视频提示词编译注入打斗因果');
ok(/validateCombatGeometry\(sh, zh\)/.test(src), '源码契约：生成后几何校验进 warnings');
ok(/combatMode: String\(n\.data\.combatMode \|\| 'auto'\)/.test(src), '源码契约：分镜生成传 combatMode 三态');
ok(!/FIGHT_RHYTHM_GENRES/.test(src), '源码契约：题材清单已移除（按场检测取代）');
ok(/if \(kind === 'storyboard' && o\.combatMode !== undefined\)/.test(readFileSync(path.join(ROOT, 'skill-pack.js'), 'utf8')), '源码契约：skill-pack 按场检测判定 fight-rhythm');
ok(!/FIGHT_RHYTHM_GENRES/.test(readFileSync(path.join(ROOT, 'skill-pack.js'), 'utf8')), '源码契约：skill-pack 题材清单已移除');

// ---------------- 汇总 ----------------
if (errs.length) {
  console.error('✗ 战斗语义回归未通过（' + errs.length + ' 条）：');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ 战斗语义回归通过（按场检测/契约块/因果句/几何校验/漂移守卫/词表对齐）');
