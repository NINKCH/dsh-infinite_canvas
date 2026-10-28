#!/usr/bin/env node
/**
 * 技能页（canvas-director）Client 侧回归：
 *   A) 数据层结构：manifest 五层数量、每份卡的必备小节、slice 标记、frontmatter 字段
 *   B) 切片纯函数：按生成能力取值 —— 反向断言，防退回「整份注入」
 *   C) 技能配置：项目隔离 / 非法值回落 / 默认回落
 *   D) UI 结构：三页签、技能页零 <select>、五层卡片与瓦片数据、72 图标闭环
 *   E) 注入矩阵：剧本/分镜/设定集草稿带 packText；图片与视频各带镜头语言锁；未配置不注入
 *
 * 运行：node scripts/test-skill-panel.mjs
 * 退出码：0 = 通过，1 = 失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.join(ROOT, 'assets', 'canvas-director');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => { if (a !== b) errs.push(m + `（实际：${JSON.stringify(a)}，期望：${JSON.stringify(b)}）`); };

// ============================================================
// A) 数据层结构
// ============================================================
const P = await import(pathToFileURL(path.join(PACK, 'pack.js')).href);
const manifestRaw = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8'));
const parsed = P.parseManifest(manifestRaw);
ok(parsed.ok, 'manifest 校验失败：' + parsed.errors.join('；'));
const M = parsed.manifest || { lenses: [], genres: [], industries: [], forms: [], looks: [] };

eq(M.lenses.length, 45, '导演透镜数量不对');
eq(M.genres.length, 36, '叙事题材数量不对');
eq(M.industries.length, 10, '行业题材数量不对');
eq(M.forms.length, 8, '规格数量不对');
eq(M.looks.length, 15, '影调数量不对');

const NEED = {
  lenses: ['一句话镜头 / Lens in one line', '适用场景', '反例：这不是什么 / What this lens is NOT', '核心风格关键词',
    '叙事方法', '镜头语言', '灯光与色彩', '剪辑节奏', '声音与音乐', '人物与表演',
    '风格参数 / Style parameters', '可迁移拍摄清单', '提示词模板 / Prompt templates', '落地示例 / Worked example'],
  genres: ['题材核心与观众为什么看', '压力来源与冲突发动机', '人物策略与信息权限', '观众回报与情绪落点',
    '常见场面颗粒', '集尾钩子取向', '前中后期打法', '制作难点', '禁止漂移', '证据与置信度'],
  industries: ['视觉母题', '证据点', '常见承诺', '禁项', '参考镜头'],
  forms: ['交付规格', '结构块', '这个类型的观众契约', '与导演透镜冲突时的改写', '类型级负向词'],
  looks: ['成像底层', '形体与骨相', '影调与光比', '色彩命题', '空气与介质', '光学与镜头', '材质响应', '特效语言', '针对性禁项', '负向词块'],
};
const DIRS = { lenses: 'lenses', genres: 'genres', industries: 'industries', forms: 'forms', looks: 'looks' };
for (const layer of Object.keys(DIRS)) {
  for (const it of M[layer]) {
    const abs = path.join(PACK, DIRS[layer], it.file);
    if (!fs.existsSync(abs)) { errs.push(layer + '/' + it.id + ': 文件不存在 ' + it.file); continue; }
    const md = fs.readFileSync(abs, 'utf8');
    const titles = P.splitSections(md).map((s) => s.title);
    for (const need of (NEED[layer] || [])) {
      ok(titles.includes(need), layer + '/' + it.id + ': 缺小节「' + need + '」');
    }
    ok((md.match(/<!--\s*slice:/g) || []).length >= (NEED[layer] || []).length,
      layer + '/' + it.id + ': slice 标记数量少于小节数');
    ok(!/\]\(\.\.\//.test(md), layer + '/' + it.id + ': 含相对路径外链');
    // 反引号形式的 ../xxx.md 同样是死指针：包里没有 assets/canvas-director/*.md 这些同级文件，
    // 读者照着找不到东西。历史上有 13 份透镜靠「反引号不算链接」躲过了上面那条断言，
    // 2026-10 统一清理时补上这条，防止再长出来。
    ok(!/`\.\.\/[^`]+`/.test(md), layer + '/' + it.id + ': 含反引号形式的 ../ 死指针');
    ok(!/https?:\/\//i.test(md), layer + '/' + it.id + ': 含外链');
    ok(!/DirectorSKILL|drama-skills|zenstory|manju-laoli|shotcraft|github\.com/i.test(md),
      layer + '/' + it.id + ': 含第三方来源标识');
    ok(Buffer.from(md, 'utf8')[0] !== 0xef, layer + '/' + it.id + ': 带 BOM');
  }
}
// 2026-10 新增的 21 位导演透镜：工艺层按「完整能力」标准校验（反例点名 / 剪辑含 ASL+转场+锚点 /
// 声音四层+主导层 / 落地示例含弱强写法对照 / 三套提示词模板标签齐全）。
// 既有 24 位是更早一批写的，达不到这套更严的标准，故不在本节断言范围内（避免把「未写作」当成「已通过」）。
const EXTENDED_LENSES = new Set([
  'ang_lee', 'edward_yang', 'jia_zhangke', 'jiang_wen', 'johnnie_to', 'ning_hao', 'stephen_chow', 'wong_jing',
  'bong_joon_ho', 'koreeda_hirokazu', 'lee_chang_dong', 'miyazaki_hayao', 'shinkai_makoto',
  'ridley_scott', 'david_lynch', 'alfonso_cuaron', 'alejandro_inarritu', 'wes_anderson', 'george_miller',
  'pedro_almodovar', 'guy_ritchie',
]);

for (const it of M.lenses) {
  const md = fs.readFileSync(path.join(PACK, 'lenses', it.file), 'utf8');
  const y = P.yamlBlock(md);
  ok(!!y, 'lens/' + it.id + ': 缺风格参数 YAML 块');
  ok(/style_id/.test(y), 'lens/' + it.id + ': YAML 缺 style_id');
  ok(/lens_kit_mm/.test(y), 'lens/' + it.id + ': YAML 缺 lens_kit_mm');
  ok(/negative_prompt_adds/.test(y), 'lens/' + it.id + ': YAML 缺 negative_prompt_adds');
  // YAML 十三键完整性（所有透镜同构，缺一即视为参数块不齐）
  for (const k of ['style_id', 'lens_kit_mm', 'camera', 'shot_size_bias', 'composition', 'lighting',
    'palette', 'editing', 'sound', 'performance', 'aspect_bias', 'ai_video', 'negative_prompt_adds']) {
    ok(new RegExp('(^|\\n)' + k + ':').test(y), 'lens/' + it.id + ': YAML 缺 ' + k);
  }
  if (!EXTENDED_LENSES.has(it.id)) continue;

  // 以下为新增 21 位的完整能力校验
  const sec = (t) => P.sectionText(md, t);
  const contra = sec('反例：这不是什么 / What this lens is NOT');
  const contraLines = contra.split('\n').filter((l) => /^\s*-\s/.test(l));
  ok(contraLines.length >= 3, 'lens/' + it.id + ': 反例少于 3 条（' + contraLines.length + '）');
  ok(/不是[^：:\n]{2,24}[：:]/.test(contra), 'lens/' + it.id + ': 反例未点名对比对象并说明差异轴');
  const edit = sec('剪辑节奏');
  ok(/\d+(\.\d+)?\s*[–\-~]\s*\d+(\.\d+)?\s*秒/.test(edit), 'lens/' + it.id + ': 剪辑节奏缺 ASL 数值区间');
  ok(/转场/.test(edit), 'lens/' + it.id + ': 剪辑节奏缺转场偏好');
  ok(/锚点/.test(edit), 'lens/' + it.id + ': 剪辑节奏缺锚点镜安排');
  const snd = sec('声音与音乐');
  for (const k of ['音乐', '环境', '对白', '静默']) ok(snd.includes(k), 'lens/' + it.id + ': 声音与音乐缺「' + k + '」');
  ok(/主导/.test(snd), 'lens/' + it.id + ': 声音与音乐未标明主导层');
  const worked = sec('落地示例 / Worked example');
  for (const k of ['弱写法', '强写法', '调度']) ok(worked.includes(k), 'lens/' + it.id + ': 落地示例缺「' + k + '」');
  ok(/```text/.test(worked), 'lens/' + it.id + ': 落地示例缺成品提示词代码块');
  const tpl = sec('提示词模板 / Prompt templates');
  ok(tpl.includes('镜头设计简报（中文，用于 Step 5 导演本与 Step 7 分镜）：'), 'lens/' + it.id + ': 缺中文简报模板标签');
  ok(tpl.includes('Image-to-video motion prompt（英文，用于 Step 10，接关键帧）：'), 'lens/' + it.id + ': 缺 I2V 模板标签');
  ok(tpl.includes('Keyframe / still prompt（英文，用于 Step 8，接图像模型）：'), 'lens/' + it.id + ': 缺 Keyframe 模板标签');
}
// 题材卡：每题必须带「类型级负向词」，否则题材对成片只剩"场面颗粒"一层约束，
// 而画面禁项（不许出现什么、不许拿什么代替故事）完全进不到视频提示词。
for (const it of M.genres) {
  const md = fs.readFileSync(path.join(PACK, 'genres', it.file), 'utf8');
  const neg = P.negativePhrases(md);
  ok(neg.length >= 4, 'genre/' + it.id + ': 类型级负向词少于 4 条（题材对成片没有约束力）');
  ok(!!P.sectionText(md, '禁止漂移'), 'genre/' + it.id + ': 缺「禁止漂移」小节');
  ok(!!P.sectionText(md, '常见场面颗粒'), 'genre/' + it.id + ': 缺「常见场面颗粒」小节');
}
for (const it of M.forms) {
  const md = fs.readFileSync(path.join(PACK, 'forms', it.file), 'utf8');
  const spec = P.frontmatterSpec(md);
  ok(Array.isArray(spec.durations) && spec.durations.length, 'form/' + it.id + ': spec.durations 不是非空数组');
  ok(Number.isFinite(spec.asl_floor_s), 'form/' + it.id + ': spec.asl_floor_s 不是数字');
  // 画幅不属于规格：spec.aspect 必须缺席（画幅在视频节点生成时选）
  ok(spec.aspect === undefined || (Array.isArray(spec.aspect) && spec.aspect.length === 0),
    'form/' + it.id + ': spec.aspect 存在——规格不应锁画幅（画幅由视频生成时选）');
}
for (const it of M.looks) {
  const md = fs.readFileSync(path.join(PACK, 'looks', it.file), 'utf8');
  ok((md.match(/#[0-9A-Fa-f]{6}/g) || []).length >= 3, 'look/' + it.id + ': 色板 hex 少于 3 个');
  ok(P.negativePhrases(md).length >= 10, 'look/' + it.id + ': 负向词少于 10 条');
  ok(/\[1:\d+/.test(md), 'look/' + it.id + ': 缺光比区间');
}

// ============================================================
// B) 切片纯函数 —— 反向断言
// ============================================================
const lensMd = fs.readFileSync(path.join(PACK, 'lenses', M.lenses[0].file), 'utf8');
const scriptSlice = P.pickSections(lensMd, 'script');
const shotSlice = P.pickSections(lensMd, 'storyboard');
const promptSlice = P.pickSections(lensMd, 'prompt');
const assetSlice = P.pickSections(lensMd, 'assets');
ok(scriptSlice.length > 200, 'script 切片过短');
ok(!scriptSlice.includes('风格参数 / Style parameters'), 'script 切片里出现了「风格参数」（应只给分镜/提示词）');
ok(!scriptSlice.includes('提示词模板'), 'script 切片里出现了「提示词模板」');
ok(promptSlice.includes('风格参数 / Style parameters'), 'prompt 切片缺「风格参数」');
ok(!promptSlice.includes('叙事方法'), 'prompt 切片里出现了「叙事方法」（应只给剧本）');
ok(!assetSlice.includes('剪辑节奏'), 'assets 切片里出现了「剪辑节奏」');
ok(!assetSlice.includes('叙事方法'), 'assets 切片里出现了「叙事方法」');
ok(shotSlice.includes('镜头语言'), 'storyboard 切片缺「镜头语言」');
const fullBytes = P.utf8Bytes(lensMd);
for (const [k, v] of [['script', scriptSlice], ['storyboard', shotSlice], ['prompt', promptSlice], ['assets', assetSlice]]) {
  ok(P.utf8Bytes(v) < fullBytes * 0.8, k + ' 切片占全文比例过高（' + P.utf8Bytes(v) + '/' + fullBytes + '），疑似整份注入');
}
const built = P.buildPackText('script', [{ layer: 'lens', md: lensMd, meta: { id: 'x', name: 'X', oneliner: 'o' } }], { zh: true, head: 'HEAD' });
ok(built.text.startsWith('HEAD'), 'buildPackText 未带上 head');
ok(built.bytes > 200, 'buildPackText 字节数异常');
eq(built.used.length, 1, 'buildPackText used 记录不对');

// ============================================================
// C) 技能配置（把 client.js 放进沙箱）
// ============================================================
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
function mkEl(type, props, ...kids) {
  return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
}
const noop = () => {};
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
function elStub() {
  return {
    style: {}, dataset: {}, children: [], textContent: '', id: '', value: '', className: '',
    appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }),
    getContext: () => new Proxy({}, { get: (t2, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
    toDataURL: () => 'data:', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  };
}
const documentStub = {
  createElement: (tag) => { const el = elStub(); if (tag === 'canvas') el.captureStream = () => ({ addTrack: noop, getAudioTracks: () => [], getVideoTracks: () => [{}] }); return el; },
  createTextNode: (t2) => ({ nodeValue: String(t2) }),
  head: elStub(), body: elStub(), documentElement: elStub(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  elementFromPoint: () => null, activeElement: null, addEventListener: noop, removeEventListener: noop,
};
const lsMap = new Map();
const lsStub = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k), clear: () => lsMap.clear(),
};
const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, __DSH_IC_SMOKE__: true, localStorage: lsStub, AudioContext: undefined },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-skill-panel', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop, origin: 'http://127.0.0.1:1' },
  fetch: async (url) => {
    const u = String(url || '');
    const m = /rel=([^&]+)/.exec(u);
    if (m) {
      const rel = decodeURIComponent(m[1]).replace(/\\/g, '/');
      const abs = path.join(ROOT, rel);
      if (fs.existsSync(abs)) {
        const text = fs.readFileSync(abs, 'utf8');
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
    const payload = { ok: true, items: [], total: 0, nextCursor: null };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, text: async () => text, json: async () => payload };
  },
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
  Image: class { constructor() { this.src = ''; } },
  Audio: class { constructor() { this.src = ''; } },
  FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
  CustomEvent: class { constructor(t2, i2) { this.type = t2; this.detail = i2 && i2.detail; } },
  Event: class { constructor(t2) { this.type = t2; } },
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
  if (!mod) throw new Error('client.js 顶层未调用 ModuleLoader.load');
  const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
  plugin.apply({
    effect(fn) { fn(); return () => {}; }, locale: { register: () => () => {}, subscribe: () => () => {} },
    slots: { inject(n, cb) { cb(); }, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    layout: { selectPanel: noop }, shortcuts: { register: () => () => {} },
  });
} catch (e) {
  errs.push('client.js 在沙箱里执行失败 → ' + ((e && e.stack) || e));
}
const TABS = sandbox && sandbox.window && sandbox.window.__DSH_IC_TABS__;
const CRAFT = sandbox && sandbox.window && sandbox.window.__DSH_IC_SKILLPACK__;
ok(!!TABS, '缺少 __DSH_IC_TABS__ 测试缝隙');
ok(!!CRAFT, '缺少 __DSH_IC_SKILLPACK__ 测试缝隙（非组件出口）');

if (TABS && CRAFT) {
  const KEY = 'dsh-ic:skills:';
  lsMap.set(KEY + 'pA', JSON.stringify({ lens: 'fincher', genres: ['crime-police'], form: 'trailer', look: 'dark-myth-cg' }));
  lsMap.set(KEY + 'pB', JSON.stringify({ lens: 'wong_kar_wai', genres: [], form: 'short-drama', look: '' }));
  const a = CRAFT.loadSkillProfile('pA');
  const b = CRAFT.loadSkillProfile('pB');
  eq(a.lens, 'fincher', 'pA 的 lens 未读出');
  eq(b.lens, 'wong_kar_wai', 'pB 的 lens 未读出');
  ok(a.lens !== b.lens, '两个项目的技能配置串了（项目隔离失效）');
  eq(a.genres.join(','), 'crime-police', 'pA 的 genres 未读出');
  eq(b.genres.length, 0, 'pB 的 genres 应为空');
  lsMap.set(KEY + 'pC', JSON.stringify({ lens: 123, genres: 'not-array', form: null, look: {} }));
  const c = CRAFT.loadSkillProfile('pC');
  eq(c.lens, '', '非法 lens 未回落空串');
  eq(c.genres.length, 0, '非法 genres 未回落空数组');
  // 默认值统一为「未选」（空串），不再回填 short-drama —— 三处 DEFAULT* 必须一致
  eq(c.form, '', '非法 form 未回落空串（未选）');
  eq(c.look, '', '非法 look 未回落空串');
  const d = CRAFT.loadSkillProfile('never-seen');
  eq(d.lens, '', '无记录时 lens 应空');
  eq(d.form, '', '无记录时 form 应为空（未选，不是 short-drama）');
  ok(!('targetSec' in d) && !('aspect' in d) && !('platform' in d), '死字段 aspect/targetSec/platform 应已移除');
  CRAFT.saveSkillProfile('pD', { lens: 'nolan', genres: ['wuxia'], form: 'cinematic', look: 'guoman-3d-xianxia' });
  const e2 = CRAFT.loadSkillProfile('pD');
  eq(e2.lens, 'nolan', 'saveSkillProfile 后读回不一致');
  eq(e2.genres.join(','), 'wuxia', 'saveSkillProfile 后 genres 不一致');

  const all = (el, out) => {
    const acc = out || [];
    const walk = (x) => {
      if (x == null || typeof x === 'boolean') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (typeof x !== 'object' || !x.__el) return;
      acc.push(x);
      walk(x.props && x.props.children);
    };
    walk(el);
    return acc;
  };
  const rb = all(TABS.Rightbar());
  const rbTabs = rb.filter((x) => x.props && x.props['data-tab']).map((x) => x.props['data-tab']);
  eq(rbTabs.join(','), 'projects,craft,settings', '右侧面板页签应为 项目/技能/设置');
  const st = all(TABS.SettingsTab());
  const stText = [];
  (function walkText(x) {
    if (x == null || typeof x === 'boolean') return;
    if (typeof x === 'string' || typeof x === 'number') { stText.push(String(x)); return; }
    if (Array.isArray(x)) { x.forEach(walkText); return; }
    if (x.__el) walkText(x.props && x.props.children);
  })(TABS.SettingsTab());
  ok(!stText.includes('技能增强'), '设置页仍有「技能增强」文案（应已迁到技能页）');
  ok(!st.some((x) => x.type === TABS.ExpertSelect), '设置页仍挂载 ExpertSelect（应迁到技能页瓦片）');
  eq(typeof TABS.__setPackForTest, 'function', '缺少 __setPackForTest 测试注入口');
  if (typeof TABS.__setPackForTest === 'function') TABS.__setPackForTest(M, P);
  const sk = all(TABS.SkillsTab());
  eq(sk.filter((x) => x.type === 'select').length, 0, '技能页出现 <select>（要求全用瓦片，不许下拉框）');
  const cards = sk.filter((x) => x.type === TABS.SkillCard).map((x) => x.props && x.props.id).filter(Boolean);
  // 四层：导演 / 题材 / 规格 / 影调（「专家」层已按方案 A 移除）
  for (const id of ['lens', 'genre', 'form', 'look']) {
    ok(cards.includes(id), '技能页缺少「' + id + '」层卡片');
  }
  ok(!cards.includes('expert'), '技能页仍有「专家」卡片（方案 A 已移除该层）');
  const cardEls = sk.filter((x) => x.type === TABS.SkillCard);
  for (const ce of cardEls) {
    const kids = all(ce.props && ce.props.children);
    ok(kids.some((x) => x.type === TABS.SkillTileGrid), '卡片「' + (ce.props && ce.props.id) + '」没有挂瓦片网格');
  }
  const itemCountOf = (id) => {
    const ce = cardEls.find((x) => x.props && x.props.id === id);
    if (!ce) return -1;
    const grid = all(ce.props && ce.props.children).find((x) => x.type === TABS.SkillTileGrid);
    return grid ? (grid.props.items || []).length : -1;
  };
  eq(itemCountOf('lens'), M.lenses.length, '导演瓦片数量与 manifest 不一致');
  eq(itemCountOf('form'), M.forms.length, '规格瓦片数量与 manifest 不一致');
  eq(itemCountOf('look'), M.looks.length, '影调瓦片数量与 manifest 不一致');
  eq(itemCountOf('genre'), M.genres.length, '默认规格下题材瓦片应取自叙事题材');
  const GLYPHS = CRAFT.SKILL_GLYPHS;
  ok(!!GLYPHS, '缺少 SKILL_GLYPHS 图标表');
  if (GLYPHS) {
    const allIds = [];
    for (const layer of ['lenses', 'genres', 'industries', 'forms', 'looks']) for (const it of M[layer]) allIds.push([layer, it]);
    for (const [layer, it] of allIds) {
      ok(Array.isArray(GLYPHS[it.id]) && GLYPHS[it.id].length > 0, '图标缺失：' + layer + '/' + it.id + '（glyph=' + it.glyph + '）');
    }
    const ids = new Set(allIds.map(([, it]) => it.id));
    for (const k of Object.keys(GLYPHS)) ok(ids.has(k), 'GLYPHS 有孤儿键（没有对应卡）：' + k);
    eq(Object.keys(GLYPHS).length, 45 + 36 + 10 + 8 + 15, '图标总数应等于四层卡数之和');
  }
  for (const layer of ['lenses', 'genres', 'industries', 'forms', 'looks']) {
    for (const it of M[layer]) ok(!!it.oneliner, layer + '/' + it.id + ': manifest 缺 oneliner（会显示成空标题）');
  }
}

// ============================================================
// E) 注入矩阵
// ============================================================
{
  const fnSlice = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\n    async function ', i + 10);
    const k = src.indexOf('\n    function ', i + 10);
    const end = [j, k].filter((x) => x > 0).sort((x, y) => x - y)[0] || src.length;
    return src.slice(i, end);
  };
  for (const [fn, label] of [['aiScriptNodes', '剧本链路'], ['aiStoryboardShots', '分镜链路'], ['aiDraftBible', '设定集草稿链路']]) {
    const body = fnSlice(fn);
    ok(!!body, '未能定位 ' + fn);
    ok(/ctx(?:Sb|Bible)?\.packText/.test(body), label + '（' + fn + '）未把 packText 拼进 system');
  }
  const bec = fnSlice('buildExpertContext');
  ok(/buildSkillPackText\(k\)/.test(bec), 'buildExpertContext 未调用 buildSkillPackText');
  ok(/packText/.test(bec), 'buildExpertContext 未产出 packText');
  // 方案 A：人设已移除，硬规则唯一来源是 canvas-craft 技能
  ok(/loadSkillRules\(CRAFT_SKILL/.test(bec), 'buildExpertContext 未从 canvas-craft 取硬规则');
  ok(!/expertPersona|loadExpertRules/.test(bec), 'buildExpertContext 仍引用已删除的专家人设');
  ok(!/const EXPERT_SCRIPT|const EXPERT_STORYBOARD/.test(src), '人设常量仍存在（方案 A 应已删除）');
  ok(!/const EXPERTS = \[/.test(src), 'EXPERTS 注册表仍存在（方案 A 应已删除）');
  const runGen = fnSlice('runGenNode');
  ok(!!runGen, '未能定位 runGenNode');
  // 图片分支按节点类型选切片（设定图走 assets），视频分支固定 prompt
  const lockCount = (runGen.match(/buildShotLockText\((?:'prompt'|lockKind)(?:,\s*\{[^}]*\})?\)/g) || []).length;
  ok(lockCount >= 2, 'buildShotLockText 应同时接在图片分支与视频分支（实际出现 ' + lockCount + ' 次）');
  ok(/设定图/.test(runGen), '图片分支缺少「设定图 → assets 切片」判定');
  const lockFn = fnSlice('buildShotLockText');
  ok(!!lockFn, '未能定位 buildShotLockText');
  ok(/yamlBlock/.test(lockFn), '风格增强块未使用 yamlBlock 取风格参数');
  ok(/negativePhrases/.test(lockFn), '风格增强块未取负向词');
  // 风格增强块必须带四层（不是只有风格参数与负向词）——这是「后面越走越偏」的根因
  ok(/pickSections\(lens/.test(lockFn) || /pickSections\(md, k\)/.test(lockFn), '风格增强块未按能力取透镜切片');
  ok(/影调与材质/.test(lockFn), '风格增强块缺影调的成像与材质内容');
  ok(/常见场面颗粒|参考镜头|视觉母题/.test(lockFn), '风格增强块缺题材的场面颗粒');
  ok(/类型负向词|交付规格/.test(lockFn), '风格增强块缺规格的节奏与负向词');
  // 短路必须把「规格」算作一层（只选规格时也要注入）
  ok(/if \(!profile\.lens && !profile\.look && !profile\.form && !\(profile\.genres \|\| \[\]\)\.length\) return '';/.test(lockFn),
    '风格增强块的短路未包含 form（只选规格时不注入 → 与对话侧分叉）');
  ok(/const hasAnyLayer = !!\(profile\.lens \|\| profile\.form \|\| profile\.look/.test(src),
    'buildSkillPackText 的短路未包含 form');
  ok(/if \(!hasAnyLayer && !o\.force\) return \{ text: '', bytes: 0 \};/.test(src),
    'buildSkillPackText 缺少「四层全空则不注入」的短路（老项目行为会变）');
}

// ============================================================
// 输出
// ============================================================
if (errs.length) {
  console.error(`✗ 技能页回归失败（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 技能页回归通过：');
console.log(`  · 数据层：导演 ${M.lenses.length} / 叙事题材 ${M.genres.length} / 行业题材 ${M.industries.length} / 规格 ${M.forms.length} / 影调 ${M.looks.length}`);
console.log('  · 每份卡：必备小节齐全、slice 标记齐全、无外链与第三方来源、无 BOM');
console.log('  · 切片反向断言：script 不含风格参数 / prompt 不含叙事方法 / assets 不含剪辑节奏；四类切片均 < 全文 80%');
console.log('  · 技能配置：项目隔离、非法值回落、无记录回落默认、写后读一致');
console.log('  · UI：三页签（项目/技能/设置）、技能页 0 个 <select>、五层卡片与瓦片数据齐全、123 个图标闭环且无孤儿');
console.log('  · 注入矩阵：剧本/分镜/设定集草稿带 packText；图片与视频分支各带一次镜头语言锁；四层全空时不注入');
// 显式退出：client.js 的 apply 会注册 setInterval（宿主轮询），沙箱里不会自动清，否则进程永不退出
process.exit(0);
