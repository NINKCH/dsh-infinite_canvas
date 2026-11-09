#!/usr/bin/env node
/**
 * 同步链路回归测试（dev-only）：
 *  1) Agent 补的设定集必须能被画布拉回（docChanged → projectsGet → mergeHostDoc 含 bible）
 *  2) 项目列表里某一个项目拉取失败不得中断整轮（否则排在其后的设定集永远拉不到）
 *
 * 运行：node scripts/test-sync-bible.mjs；退出码 0=通过 1=失败
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

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

// 预置必须在 apply()（initStore）之前：否则活动项目是自动新建的默认项目，
// removeNodes/undo/redo 会作用在默认项目而不是 p2 上
localStorageStub.setItem('dsh-ic:projects', JSON.stringify([
  { id: 'p1', name: '坏项目', createdAt: T, updatedAt: T },
  { id: 'p2', name: '好项目', createdAt: T, updatedAt: T },
]));
localStorageStub.setItem('dsh-ic:active', JSON.stringify('p2')); // lsGet 会 JSON.parse，必须存 JSON 字符串

plugin.apply(ctx);

const sync = windowStub.__DSH_IC_SYNC__;
if (!sync) { console.error('✗ 未找到 __DSH_IC_SYNC__（冒烟缝隙被移除？）'); process.exit(1); }

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };
ok(sync.state().activeId === 'p2', '前置失败：活动项目不是 p2（localStorage 预置未生效）');

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

// 3) 用户删除节点（走真实 removeNodes 路径：内存墓碑 + 立即推送）→ Host 拉回不得复活
//    （用户实测：× 正常、Delete 键删除后自动恢复 —— 根因是键盘路径曾裸删不记墓碑）
sync.pushHistory(); // 记住删除前状态，供撤销往返使用
const before = sync.graph();
if (!before.nodes.n2) errs.push('前置失败：n2 不在内存画布上');
sync.removeNodes(['n2']);
const afterDel = sync.graph();
ok(!afterDel.nodes.n2, 'removeNodes 未删除节点');
ok(afterDel.tombstones && afterDel.tombstones.includes('n2'), 'removeNodes 未记节点墓碑');
sync.mergeHostDoc('p2', {
  nodes: { n2: { id: 'n2', type: 'script', x: 0, y: 0, w: 320, h: 100, data: { status: 'idle', label: '剧本', idea: '', output: '' } } },
  edges: [], bible: { worldview: '测试世界观', style: '写实', characters: [{ name: '张山', desc: '主角' }], scenes: [], props: [] },
  bibleUpdatedAt: T,
});
const graph4 = JSON.parse(localStorageStub.getItem('dsh-ic:graph:p2') || 'null');
ok(!graph4.nodes.n2, '被用户删除的节点（节点墓碑）被 Host 拉回复活（删除后又出现/需要删多次）');
ok(!!graph4.tombstones && graph4.tombstones.includes('n2'), '合并后节点墓碑丢失（下次推送会复活）');

// 3b) 撤销恢复 → 墓碑必须同步撤销（否则 Ctrl+Z 恢复的节点被下一轮同步再次抹掉）；
//     重做删除 → 墓碑必须补回（否则重做的删除被同步复活）
sync.undo();
const afterUndo = sync.graph();
ok(!!afterUndo.nodes.n2, 'undo 未恢复节点');
ok(!afterUndo.tombstones || !afterUndo.tombstones.includes('n2'), 'undo 恢复节点后旧墓碑未撤销（节点会被同步再次抹掉）');
sync.redo();
const afterRedo = sync.graph();
ok(!afterRedo.nodes.n2, 'redo 未重新删除节点');
ok(afterRedo.tombstones && afterRedo.tombstones.includes('n2'), 'redo 删除节点后未补墓碑（节点会被同步复活）');

// 3c) 键盘 Delete 必须走 removeNodes（源码绊线：曾经的裸删分支是"Delete 复活"的根因）
ok(/e\.key === 'Delete'[\s\S]{0,600}removeNodes\(\[\.\.\.S\.sel\]/.test(src), '键盘 Delete/Backspace 未走 removeNodes（裸删会复活）');

// 3d) 资产命名规则 = 节点名 + 时间（用户规则：不得退回"分镜-时间"这类通用前缀）
ok(/function nowStamp\(\)/.test(src), 'nowStamp 时间戳助手缺失');
ok(/function assetNameFor[\s\S]{0,400}nowStamp\(\)/.test(src), 'assetNameFor 未使用「节点名+时间」命名规则');
ok(!/name: T\('storyboardAssetPrefix'\) \+ new Date\(\)/.test(src), '分镜资产命名仍在用通用前缀+时间（应为节点名+时间）');

// 4) loadBible 读取（BibleTab 的数据源）
const loaded = sync.loadBible('p2');
ok(loaded.worldview === '测试世界观' && loaded.characters.length === 1, 'loadBible 读取不一致');

// ============================================================
// 5) 一致性告警：台词碎片豁免（Host/Client 双实现同规则，#5 误报修复）
//    用户实测：台词「来了个带纸的」被抽成道具「带纸的」误报未登记实体。
//    规则：名字以「的」结尾 **且** 出现在任一对白文本里 → 角色/场景/道具 三类跳过未登记告警；
//    @提及 通道绝不跳过；「已登记但描述为空」路径不跳过；宿主 shots 无 dialogue 时自然不跳过。
// ============================================================
{
  const clientLines = new Set(src.split('\n').map((l) => l.trim()));
  const hostSrc = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const hostLines = new Set(hostSrc.split('\n').map((l) => l.trim()));
  // 同构规则行（trim 后逐行比对，防止两实现漂移——漂移一次就修一次，太贵了）
  const canonLines = [
    "let dialogueAll = '';",
    'for (const sh of shots || []) {',
    "for (const d of ((sh && sh.dialogue) || [])) dialogueAll += ' ' + String((d && d.line) || '');",
    'const check = (title, kind, name, entity) => {',
    "if (entity && String(name || '').trim().endsWith('的') && dialogueAll.includes(String(name || '').trim())) return;",
  ];
  for (const cl of canonLines) {
    ok(clientLines.has(cl), 'client.js checkShotConsistency 缺少同构规则行: ' + cl);
    ok(hostLines.has(cl), 'index.js storyboardConsistencyWarnings 缺少同构规则行: ' + cl);
  }
  // 三类实体走 entity=true，@提及 通道走 entity=false（提及绝不跳过的实现锚点）
  ok(src.includes("check(title, T('catCharacter'), nm, true)") && src.includes("check(title, T('catScene'), sh.scene, true)")
    && src.includes("check(title, T('catProp'), nm, true)") && src.includes("check(title, T('catMention'), mm.name, false)"),
    'client.js 三类实体/提及通道的 entity 标志缺失（提及通道可能被误跳过）');
  ok(hostSrc.includes("check(title, '角色', nm, true)") && hostSrc.includes("check(title, '场景', sh && sh.scene, true)")
    && hostSrc.includes("check(title, '道具', nm, true)") && hostSrc.includes("check(title, '提及', nm, false)"),
    'index.js 三类实体/提及通道的 entity 标志缺失（提及通道可能被误跳过）');

  // ---- Host 侧行为断言：index.js _internals.storyboardConsistencyWarnings 直调 ----
  const SANDBOX_HOST = mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-syncbible-'));
  process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX_HOST, 'projects');
  process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX_HOST, 'config.json');
  const hostMod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  const hostWarn = hostMod._internals && hostMod._internals.storyboardConsistencyWarnings;
  if (!hostWarn) {
    errs.push('index.js _internals 未导出 storyboardConsistencyWarnings');
  } else {
    const EMPTY_BIBLE = { characters: [], scenes: [], props: [] };
    const shot = (o) => Object.assign({ title: '镜1', visual: '中景', motion: '推进', characters: [], scene: '', props: [], dialogue: [], duration: 3 }, o);
    const hasWarn = (ws, name) => ws.some((w) => w.includes('「' + name + '」'));
    // 实测症状①：台词「来了个带纸的」的描述性片段被抽成道具 → 不再误报（对白与道具可跨镜）
    const w1 = hostWarn(EMPTY_BIBLE, [
      shot({ title: '镜1', dialogue: [{ role: '甲', line: '来了个带纸的' }] }),
      shot({ title: '镜2', props: ['带纸的'] }),
    ], []);
    ok(!hasWarn(w1, '带纸的'), '实测症状①未修复：台词碎片「带纸的」仍误报未登记');
    // 对照组②：不以「的」结尾的「黑皮笔记本」→ 照常告警（引导登记，语义保持）
    const w2 = hostWarn(EMPTY_BIBLE, [shot({ dialogue: [{ role: '甲', line: '他拿起黑皮笔记本' }], props: ['黑皮笔记本'] })], []);
    ok(hasWarn(w2, '黑皮笔记本') && w2.some((w) => w.includes('未在设定集中登记')), '对照组②失效：「黑皮笔记本」未登记却没告警');
    // ③「已登记但描述为空」路径不跳过（用户显式登记的条目仍要提示补全）
    const w3 = hostWarn({ characters: [], scenes: [], props: [{ name: '带纸的', desc: '' }] },
      [shot({ dialogue: [{ role: '甲', line: '来了个带纸的' }], props: ['带纸的'] })], []);
    ok(hasWarn(w3, '带纸的') && w3.some((w) => w.includes('已登记但描述为空')), '规则误伤：已登记但描述为空的「带纸的」没有提示补全');
    // ④ @提及 通道绝不跳过
    const w4 = hostWarn(EMPTY_BIBLE, [shot({ visual: '@带纸的@ 特写', dialogue: [{ role: '甲', line: '来了个带纸的' }] })], []);
    ok(hasWarn(w4, '带纸的') && w4.some((w) => w.includes('提及')), '规则误伤：@带纸的@ 提及通道被跳过（提及绝不豁免）');
    // ⑤ 只有「的」结尾、对白里没出现 → 照常告警（两个条件缺一不可，防止豁免面扩大）
    const w5 = hostWarn(EMPTY_BIBLE, [shot({ dialogue: [{ role: '甲', line: '他拿起黑皮笔记本' }], props: ['远处的'] })], []);
    ok(hasWarn(w5, '远处的'), '豁免面过大：对白里没出现的「远处的」也被跳过了');
    // ⑥ 旧数据 shots 无 dialogue 字段 → 按「无对白可查」自然不跳过，不报错
    let w6;
    try { w6 = hostWarn(EMPTY_BIBLE, [{ title: '镜1', visual: '', motion: '', characters: [], scene: '', props: ['带纸的'], duration: 3 }], []); }
    catch (e) { errs.push('宿主 shots 无 dialogue 字段时报错（应容错）: ' + ((e && e.message) || e)); }
    if (w6) ok(hasWarn(w6, '带纸的'), '无对白可查时「带纸的」未告警（无对白应不豁免）');
  }

  // ---- Client 侧行为断言：按 test-mentions 同款手法从 client.js 抽取 checkShotConsistency 真身执行 ----
  const aCsc = src.indexOf('async function checkShotConsistency(shots) {');
  const bCsc = aCsc >= 0 ? src.indexOf('/** 分镜生成后：', aCsc) : -1;
  const mentionPure = /\/\/ <<<MENTION_PURE_BEGIN>>>([\s\S]*?)\/\/ <<<MENTION_PURE_END>>>/.exec(src);
  if (aCsc < 0 || bCsc < 0 || !mentionPure) {
    errs.push('client.js 抽取锚点丢失（checkShotConsistency / MENTION_PURE 结构被改动？）');
  } else {
    const catLabel = (c) => ({ character: '角色', scene: '场景', prop: '道具', general: '通用' }[c] || '通用');
    const parseMentions = new Function('catLabel', 'effLang', mentionPure[1] + '\nreturn { parseMentions };')(catLabel, () => 'zh').parseMentions;
    let clientBible = { characters: [], scenes: [], props: [] };
    let clientAssets = []; // 资产名清单；stub 按 idbByProject 真实形状包成 { name } 记录
    const checkShotConsistency = new Function('loadBible', 'S', 'T', 'parseMentions', 'idbByProject', 'GENERAL_PID',
      'return (' + src.slice(aCsc, bCsc) + ');')(
      () => clientBible, { activeId: 'p_warn' }, (k) => k, parseMentions, async () => (clientAssets || []).map((n) => ({ name: n })), 'general');
    const shot = (o) => Object.assign({ title: '镜1', visual: '中景', motion: '推进', characters: [], scene: '', props: [], dialogue: [], duration: 3 }, o);
    const hasWarn = (ws, name) => ws.some((w) => w.includes('「' + name + '」'));
    const run = async (bible, shots, assets) => { clientBible = bible; clientAssets = assets || []; return await checkShotConsistency(shots); };
    // 实测症状①：台词碎片「带纸的」（跨镜对白）不再误报
    const c1 = await run({ characters: [], scenes: [], props: [] }, [
      shot({ title: '镜1', dialogue: [{ role: '甲', line: '来了个带纸的' }] }),
      shot({ title: '镜2', props: ['带纸的'] }),
    ]);
    ok(!hasWarn(c1, '带纸的'), '实测症状①未修复（client）：台词碎片「带纸的」仍误报未登记');
    // 对照组②：「黑皮笔记本」照常告警（warnUnregistered 键随 T stub 原样出现）
    const c2 = await run({ characters: [], scenes: [], props: [] }, [shot({ dialogue: [{ role: '甲', line: '他拿起黑皮笔记本' }], props: ['黑皮笔记本'] })]);
    ok(hasWarn(c2, '黑皮笔记本') && c2.some((w) => w.includes('warnUnregistered')), '对照组②失效（client）：「黑皮笔记本」未登记却没告警');
    // ③「已登记但描述为空」不跳过（warnEmptyDesc 键）
    const c3 = await run({ characters: [], scenes: [], props: [{ name: '带纸的', desc: '' }] }, [shot({ dialogue: [{ role: '甲', line: '来了个带纸的' }], props: ['带纸的'] })]);
    ok(hasWarn(c3, '带纸的') && c3.some((w) => w.includes('warnEmptyDesc')), '规则误伤（client）：已登记但描述为空的「带纸的」没有提示补全');
    // ④ @提及 通道不跳过
    const c4 = await run({ characters: [], scenes: [], props: [] }, [shot({ visual: '@带纸的@ 特写', dialogue: [{ role: '甲', line: '来了个带纸的' }] })]);
    ok(hasWarn(c4, '带纸的') && c4.some((w) => w.includes('catMention')), '规则误伤（client）：@带纸的@ 提及通道被跳过');
    // ⑤ 只有「的」结尾、对白没出现 → 照常告警
    const c5 = await run({ characters: [], scenes: [], props: [] }, [shot({ dialogue: [{ role: '甲', line: '他拿起黑皮笔记本' }], props: ['远处的'] })]);
    ok(hasWarn(c5, '远处的'), '豁免面过大（client）：对白里没出现的「远处的」也被跳过了');
    // ⑥ 旧数据无 dialogue → 不报错、不豁免
    const c6 = await run({ characters: [], scenes: [], props: [] }, [{ title: '镜1', visual: '', motion: '', characters: [], scene: '', props: ['带纸的'], duration: 3 }]);
    ok(hasWarn(c6, '带纸的'), '无对白可查时「带纸的」未告警（client，无对白应不豁免）');
    // ⑦ 资产名子串容忍保持：登记了资产「道具-带纸的束」→ 不告警（既有语义未回归）
    const c7 = await run({ characters: [], scenes: [], props: [] }, [shot({ props: ['带纸的'] })], ['道具-带纸的束']);
    ok(!hasWarn(c7, '带纸的'), '资产子串容忍回归：与资产名子串匹配的「带纸的」不应告警');
  }

  // ---- bibleTick 自动刷新（#5 症状②）：persist 自增信号 + 分镜详情监听重算 ----
  ok(/assetsTick: 0,[\s\S]{0,200}bibleTick: 0,/.test(src), '全局状态缺 bibleTick: 0（设定集更新无信号源）');
  ok(/const persist = \(next\) => \{ setBible\(next\); saveBible\(S\.activeId, next\); update\(\(s\) => \{ s\.bibleTick\+\+; \}\); \};/.test(src),
    'BibleTab persist 未自增 bibleTick（补全设定集后本地旧告警仍挂着）');
  ok(/const lastBibleTickRef = useRef\(S\.bibleTick\);/.test(src) && /\}, \[S\.bibleTick\]\);/.test(src),
    '分镜详情缺 bibleTick 自动重算 useEffect（旧告警不会自动消失）');
}

if (errs.length) {
  console.error('✗ 同步链路回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 同步合并回归测试通过（mergeHostDoc：设定集/节点/连线落库 + 幂等 + loadBible 一致）');
process.exit(0);
