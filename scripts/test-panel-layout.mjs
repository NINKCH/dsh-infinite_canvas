// 面板结构重构回归测试（dev-only）：
//   1) 顶部无空白：.dshic-page 不再吃 --dsh-frame-top-clearance / padding-top，画布第一块就是工具栏
//   2) 左侧图标列（单列）：顺序 = 文本/剧本/分镜表/图片/视频/成片/资产/设定集/运行工作流，
//      点节点图标 → 在视口中心添加该类型节点；容器**无边框/无底色/无投影/无圆角**，只占中间
//      （height:auto + align-self:center + margin:auto 0，不撑满）
//   3) 资产 + 设定集统一弹窗：两个标签页、资产页用 assetsForPicker 数据源 + 网格卡片、
//      Esc / 遮罩关闭、右侧面板不再有资产/设定集页签
//   4) 顶部工具栏：最左「返回会话」纯 < 图标 → 项目名（下拉列出项目 + 新建项目…；双击项目名就地编辑；
//      下拉每行右侧「修改」按钮在该行就地编辑（当前项目行同样可点，pointerdown/click 都不触发行切换），
//      当前项目只用蓝底/蓝字标选中、不再渲染 ✓；顶部不再有铅笔、也不再有当前画布名 chip；下拉里没有「重命名项目…」；
//      下拉行单行「项目名 · 画布名」；≤5 项列表高 = 实际行数（不留空白），>5 项才固定 5 行；
//      顶部行 = [+ 新建项目（纯图标）] + 搜索框（内嵌放大镜）；底部分页 = ‹ [页码输入] / N ›（回车/失焦跳转、夹取））
//      搜索/分页先结清进行中的就地改名）
//   5) 快捷键 / 帮助反馈 / 检查更新回到右上角：三个纯图标按钮（hover tooltip），右侧面板不再有动作行
//   6) 多画布：项目为根、子画布为目录；新建必须命名；切换读写不同 key；删除回默认画布；
//      默认画布 canvasId=null（key 仍等于 projectId，旧数据零迁移）
//   7) 右侧「项目」面板：只管理当前项目（无「新建项目」按钮；「+ 新建画布」是搜索框左侧的纯图标按钮，
//      搜索框内右侧内嵌放大镜、容器只有输入框一层边框）+ 项目/画布就地改名 + 折叠（localStorage）+ 搜索
//      + 比例协调 + 只剩一个画布时删除按钮隐藏
//   8) 全局去「灰蓝」：所有弹层容器实底主题背景 / 1px 线框 / 14–16px 圆角 / --dshic-shadow-lg，
//      无 --dsw-alias-bg-overlay / rgba / backdrop-filter；弹层内部无固定色字面量
//   9) 项目下拉：自适应高度（≤5 行）/ >5 行固定 5 行 + 分页（分页在搜索行右侧）/ 搜索 / 行内编辑结清
//  10) 设置页存储实况：默认一行精简状态 + ⓘ 折叠详情（路径/统计）；详情容器实底主题
// 运行：node scripts/test-panel-layout.mjs（退出码 0=通过）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => ok(String(a) === String(b), m + '（实际：' + JSON.stringify(a) + '，期望：' + JSON.stringify(b) + '）');

// ---------------- 假 React / DOM / localStorage（与其他沙箱测试同套路） ----------------
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
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
  getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
  toDataURL: () => 'data:,', classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
});
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

const P1 = 'p_panel_a';
const P2 = 'p_panel_b';
lsStub.setItem('dsh-ic:projects', JSON.stringify([
  { id: P1, name: '项目甲', createdAt: 1, updatedAt: 1 },
  { id: P2, name: '项目乙', createdAt: 2, updatedAt: 2 },
]));
lsStub.setItem('dsh-ic:active', JSON.stringify(P1));
lsStub.setItem('dsh-ic:graph:' + P1, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));
lsStub.setItem('dsh-ic:graph:' + P2, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-panel-layout', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: async (url, opts) => {
    let method = '';
    try { method = JSON.parse((opts && opts.body) || '{}').method; } catch { /* 忽略 */ }
    const payload = method === 'assetsList'
      ? { items: [], total: 0, nextCursor: null }
      : { ok: true };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, text: async () => text, json: async () => payload };
  },
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
if (!mod) { console.error('✗ client.js 顶层执行失败'); process.exit(1); }
const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
plugin.apply({
  effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} },
  slots: { inject(n, cb) { cb(); }, register: () => () => {} },
  sidebarRightTabs: { register: () => () => {} },
});

const TABS = sandbox.window.__DSH_IC_TABS__;
const PANEL = sandbox.window.__DSH_IC_PANEL__;
const CANVAS = sandbox.window.__DSH_IC_CANVAS__;
const LAYOUT = sandbox.window.__DSH_IC_LAYOUT__;
const sync = sandbox.window.__DSH_IC_SYNC__;
if (!TABS || !PANEL || !CANVAS || !LAYOUT || !sync) {
  console.error('✗ 冒烟缝隙缺失（__DSH_IC_TABS__/__DSH_IC_PANEL__/__DSH_IC_CANVAS__/__DSH_IC_LAYOUT__/__DSH_IC_SYNC__）');
  process.exit(1);
}

// ---------------- 渲染/遍历工具 ----------------
function collect(el, out, depth = 0) {
  if (el == null || depth > 80) return;
  if (Array.isArray(el)) { for (const x of el) collect(x, out, depth); return; }
  if (typeof el !== 'object' || !el.__el) return;
  out.push(el);
  collect(el.props && el.props.children, out, depth + 1);
}
const all = (el) => { const out = []; collect(el, out); return out; };
const clsOf = (e) => String((e && e.props && e.props.className) || '');
const act = (els, a) => els.find((e) => e && e.props && e.props['data-action'] === a);
function stringsOf(el, out = []) {
  if (el == null) return out;
  if (Array.isArray(el)) { for (const x of el) stringsOf(x, out); return out; }
  if (typeof el === 'string') { out.push(el); return out; }
  if (typeof el !== 'object') return out;
  if (!el.__el) return out;
  stringsOf(el.props && el.props.children, out);
  return out;
}
function fnBody(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  // 参数表可能有解构/默认值（如 AssetsTab({ variant } = {})）：先跳过参数表，再花括号配平函数体
  let i = src.indexOf('(', start);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
  }
  while (i < src.length && src[i] !== '{') i++;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}
/** 取 CSS 规则的声明体（拼接同名规则的多次定义）；找不到返回 ''。注释会先剔除，避免把注释里的
 *  「border/background」等字样当成真实声明（历史误报来源）。 */
function cssRule(selector) {
  const css = String(src || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const all = [];
  let from = 0;
  for (;;) {
    // 选择器后必须紧跟 `{`（不允许 `.dshic-rail` 误匹配 `.dshic-rail-inner{`）
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{', 'g');
    re.lastIndex = from;
    const m = re.exec(css);
    if (!m) break;
    const at = m.index;
    const end = css.indexOf('}', at);
    if (end < 0) break;
    all.push(css.slice(at + m[0].length, end));
    from = end + 1;
  }
  return all.join(';');
}
/** 取 CSS 中所有「选择器命中该类名（含组合选择器）」的规则：用于全量反向扫描，避免只看第一条。 */
function cssRulesMatchingClass(name) {
  const css = (LAYOUT.CSS || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  const needle = new RegExp('\\.' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![-\\w])');
  let m;
  while ((m = re.exec(css))) {
    if (needle.test(m[1])) out.push({ sel: m[1].trim(), body: m[2] });
  }
  return out;
}

// ============================================================
// 1) 顶部无空白：不再吃宿主 --dsh-frame-top-clearance，画布第一块就是工具栏
// ============================================================
{
  ok(!/dsh-frame-top-clearance/.test(src), 'client.js 仍在使用 --dsh-frame-top-clearance（顶部空带未移除）');
  const css = LAYOUT.CSS || '';
  const pageRules = [...css.matchAll(/\.dshic-page\{([^}]*)\}/g)].map((m) => m[1]);
  ok(pageRules.length > 0, '未找到 .dshic-page CSS 规则');
  for (const body of pageRules) {
    ok(!/padding-top/.test(body), '.dshic-page 仍有 padding-top（顶部空带未移除）：' + body.slice(0, 80));
  }
  // 画布第一块内容 = 工具栏（banner 只在出错/更新时出现；这里是正常态）
  const pageEl = TABS.CanvasPage();
  const kids = (Array.isArray(pageEl.props.children) ? pageEl.props.children : [pageEl.props.children]).filter(Boolean);
  ok(kids.length > 0, 'CanvasPage 没有渲染任何内容');
  ok(kids[0] && kids[0].type === TABS.Toolbar, '画布第一块不是工具栏（顶部有空占位）：' + String(kids[0] && (kids[0].type && kids[0].type.name)));
  for (const k of kids) {
    const st = k && k.props && k.props.style;
    ok(!(st && (st.paddingTop || st.height === 'var(--dsh-frame-top-clearance)')), '画布首屏存在顶部占位元素');
  }
  // 右侧面板宿主同款：右栏画布复用同一个 CanvasPage（同一份 .dshic-page CSS，因此同样贴顶）
  ok(/h\(CanvasPage, \{ host \}\)/.test(fnBody('CanvasHostedApp')), '右栏宿主未复用 CanvasPage（右侧面板画布可能仍有顶部空带）');
}

// ============================================================
// 2) 左侧图标列：顺序 + 每项动作
// ============================================================
{
  const rail = TABS.IconRail();
  const els = all(rail);
  const acts = els.filter((e) => e.props && e.props['data-action']).map((e) => e.props['data-action']);
  // 导演台（open-director）放在动作分区：它和"运行工作流"一样是工具，不是节点类型
  eq(acts.join(','), 'add-text,add-script,add-storyboard,add-image,add-video,add-finalcut,open-assets,open-bible,open-director,run-workflow',
    '左侧图标列顺序/动作不符合要求');
  ok(/\.dshic-rail\{[^}]*position:absolute/.test((LAYOUT.CSS || '')), '图标列不再是绝对定位悬浮层');
  // 第 2 条：图标列整列垂直居中（内层绝对定位居中，不是贴左上角/撑满整列）
  ok(/\.dshic-rail-inner\{[^}]*justify-content:center/.test((LAYOUT.CSS || '')), '图标列没有垂直居中（内层缺 justify-content:center）');
  ok(/\.dshic-rail-inner\{[^}]*top:50%[^}]*translateY\(-50%\)/.test((LAYOUT.CSS || '')), '图标列内层没有垂直居中（缺 top:50% + translateY(-50%)）');
  ok(/h\(IconRail\)/.test(fnBody('CanvasPage')), 'IconRail 未挂到画布主区域');
  // 点「文本」→ 在视口中心添加文本节点（沿用 addNodeAt：默认尺寸/选中/历史）
  const before = Object.keys(sync.graph().nodes).length;
  const addText = act(els, 'add-text');
  ok(!!addText && typeof addText.props.onClick === 'function', '文本图标没有点击动作');
  addText.props.onClick();
  const g = sync.graph();
  eq(Object.keys(g.nodes).length, before + 1, '点击文本图标没有新增节点');
  const tn = Object.values(g.nodes).find((n) => n.type === 'text');
  ok(!!tn, '点击文本图标没有新增 text 节点');
  // 视口中心：canvasEl 为 null 时容器 800×600、view(0,0,1) → center(400,300)，节点左上角 = 中心 - 180
  ok(tn && Math.abs(tn.x - 220) <= 2 && Math.abs(tn.y - 120) <= 2, '新节点不在视口中心：' + JSON.stringify(tn && { x: tn.x, y: tn.y }));
  eq(tn && tn.w, 360, '新节点没有沿用默认尺寸');
  // 打开资产 → 资产图标高亮、设定集不高亮
  PANEL.openStudioModal('assets');
  const els2 = all(TABS.IconRail());
  ok((act(els2, 'open-assets').props.className || '').includes('is-active'), '资产弹窗打开时资产图标未高亮');
  ok(!(act(els2, 'open-bible').props.className || '').includes('is-active'), '资产弹窗打开时设定集图标被误高亮');
  PANEL.closeStudioModal();
}

// ============================================================
// 3) 资产 + 设定集统一弹窗
// ============================================================
{
  const assetsBody = fnBody('AssetsTab');
  ok(/assetsForPicker\(/.test(assetsBody), '资产页数据源不是 assetsForPicker');
  ok(/ASSET_PAGE_SIZE/.test(assetsBody) && /dshic-asset-grid/.test(assetsBody), '资产页缺少分页或网格卡片');
  ok(/dshic-asset-pager/.test(assetsBody), '资产页缺少分页控件');
  // 卡片结构：缩略图/首帧 + 名称 + 分类 + 时间（AssetCard 复用）
  const card = all(PANEL.AssetCard({
    a: { id: 'a1', kind: 'image', name: '角色图', category: 'character', createdAt: Date.now() },
    onAdd: noop, onDel: noop, onCat: noop, onRename: noop, onMove: noop, projectName: '项目甲',
  }));
  ok(card.some((e) => /\bdshic-asset\b/.test(clsOf(e))), '资产卡片根节点缺少 dshic-asset 类');
  ok(card.some((e) => clsOf(e).includes('dshic-asset-thumb')), '资产卡片缺少缩略图/视频首帧');
  ok(card.some((e) => clsOf(e).includes('dshic-asset-name')), '资产卡片缺少名称');
  ok(card.some((e) => clsOf(e).includes('dshic-asset-meta')), '资产卡片缺少分类/时间行');
  ok(card.some((e) => clsOf(e).includes('dshic-cat')), '资产卡片缺少分类标签');
  // 打开统一弹窗（资产页）：两个标签页 + 关闭按钮 + AssetsTab 内容
  PANEL.openStudioModal('assets');
  const modalEls = all(TABS.StudioModal());
  ok(modalEls.some((e) => e.props && e.props['data-role'] === 'studio-modal'), '统一弹窗未渲染');
  const tabIds = modalEls.filter((e) => e.props && e.props['data-tab']).map((e) => e.props['data-tab']);
  eq(tabIds.join(','), 'bible,assets', '统一弹窗标签页顺序/数量不对（应为 设定集 / 资产）');
  ok((modalEls.find((e) => e.props['data-tab'] === 'assets').props.className || '').includes('is-active'), '资产页未处于激活态');
  ok(modalEls.some((e) => String(e.props && e.props.className || '').includes('dshic-modal-assets')), '资产页容器缺失');
  ok(modalEls.some((e) => e.type === TABS.AssetsTab), '资产页没有渲染 AssetsTab');
  ok(!!act(modalEls, 'close-modal'), '统一弹窗缺少右上关闭按钮');
  // 遮罩点击关闭
  const overlay = modalEls.find((e) => e.props && e.props['data-role'] === 'studio-modal');
  overlay.props.onPointerDown({ target: overlay, currentTarget: overlay });
  ok(PANEL.state().panelModal === null, '点击遮罩未关闭统一弹窗');
  // Esc 关闭（真实监听也走 handleStudioModalKey）
  PANEL.openStudioModal('assets');
  ok(PANEL.handleStudioModalKey({ key: 'Escape' }) === true, 'Esc 未关闭统一弹窗');
  ok(PANEL.state().panelModal === null, 'Esc 后 panelModal 仍存在');
  // 设定集页：BibleTab（条目卡 + 绑定资产缩略图）
  PANEL.openStudioModal('bible');
  const bibleEls = all(TABS.StudioModal());
  ok((bibleEls.find((e) => e.props && e.props['data-tab'] === 'bible').props.className || '').includes('is-active'), '设定集页未处于激活态');
  ok(bibleEls.some((e) => e.type === TABS.BibleTab), '设定集页没有渲染 BibleTab');
  ok(/BibleAssetThumbs/.test(fnBody('BibleTab')) && /dshic-bible-thumb/.test(src), '设定集条目缺少已绑定资产缩略图');
  PANEL.closeStudioModal();
  // 右侧面板不再有资产/设定集页签
  const rb = all(TABS.Rightbar());
  const rbTabs = rb.filter((e) => e.props && e.props['data-tab']).map((e) => e.props['data-tab']);
  eq(rbTabs.join(','), 'projects,settings', '右侧面板页签应只剩 项目 / 设置');
  ok(!rbTabs.includes('assets') && !rbTabs.includes('bible'), '右侧面板仍保留资产/设定集页签');
  ok(!/S\.rightTab === 'assets'|S\.rightTab === 'bible'/.test(fnBody('Rightbar')), 'Rightbar 仍渲染资产/设定集页');
}

// ============================================================
// 4) 顶部工具栏：最左「返回会话」纯图标 → 项目名（下拉切换/新建；双击/铅笔改名）
// ============================================================
{
  const tb = all(TABS.Toolbar());
  const bar = tb.find((e) => clsOf(e).includes('dshic-toolbar'));
  ok(!!bar, '未渲染顶部工具栏');
  const barKids = (bar.props.children || []).filter(Boolean);
  // 第 1 条：返回会话 = 只有 < 图标，且位于项目名左边（工具栏最左）
  const backBtn = barKids[0];
  ok(backBtn && backBtn.props && backBtn.props['data-action'] === 'back-to-chat', '工具栏最左不是「返回会话」按钮');
  ok(stringsOf(backBtn).join('').trim() === '', '「返回会话」按钮仍有文字（应为纯 < 图标）');
  ok(!/dshic-toolbar-title/.test(src), '仍存在 .dshic-toolbar-title（返回会话文字样式/文字未删除）');
  const projWrap = barKids[1];
  ok(projWrap && clsOf(projWrap).includes('dshic-proj-switch-wrap'), '项目切换器不在返回按钮右边');
  // 第 1 条：项目名右侧**不再有铅笔**（用户明确要求删除）——改名只靠双击就地编辑
  ok(!act(tb, 'rename-project-icon'), '顶部项目名右侧仍有铅笔图标（应删除，只保留双击就地编辑）');
  ok(!/dshic-proj-edit/.test(src), '源码里仍残留顶部铅笔图标入口/样式（.dshic-proj-edit）');
  const switcher = (Array.isArray(projWrap.props.children) ? projWrap.props.children : [projWrap.props.children]).filter(Boolean)[0];
  ok(switcher && switcher.props && switcher.props['data-role'] === 'project-switcher', '工具栏项目名切换按钮缺失');
  const nameEl = (Array.isArray(switcher.props.children) ? switcher.props.children : [switcher.props.children])
    .filter(Boolean).find((c) => c && c.props && c.props['data-role'] === 'project-name');
  ok(nameEl && String(nameEl.props.children) === '项目甲', '工具栏项目名未显示当前项目（实际：' + (nameEl && nameEl.props.children) + '）');
  // 第 1 条：双击项目名 → 就在原位置渲染 inline input（不是弹窗），且预填当前名字
  ok(typeof nameEl.props.onDoubleClick === 'function', '项目名不支持双击就地改名');
  nameEl.props.onDoubleClick({ stopPropagation: noop });
  const ie0 = PANEL.state().inlineEdit;
  eq(ie0 && ie0.kind, 'project', '双击项目名未进入就地编辑');
  eq(ie0 && ie0.value, '项目甲', '就地编辑没有预填当前项目名');
  eq(PANEL.state().projectDialog, null, '双击项目名仍弹出了重命名弹窗（应为 inline input）');
  const inlineTop = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input');
  ok(!!inlineTop, '双击项目名后没有在原地渲染 input');
  eq(inlineTop && inlineTop.props.value, '项目甲', '就地输入框的值与项目名不一致');
  ok(!all(TABS.Toolbar()).some((e) => e.props && e.props['data-role'] === 'project-switcher'), '就地编辑时仍渲染旧的项目名按钮（应被 input 取代）');
  // 空名：拒绝并保留原名（退出编辑）
  inlineTop.props.onChange({ target: { value: '   ' } });
  inlineTop.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().projects.find((p) => p.id === PANEL.state().activeId).name, '项目甲', '空名提交改掉了项目名');
  eq(PANEL.state().inlineEdit, null, '空名提交后没有退出就地编辑');
  // 合法名字：Enter 提交 → 状态 + 顶部渲染同步
  all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-name')
    .props.onDoubleClick({ stopPropagation: noop });
  const inlineTop2 = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input');
  ok(!!inlineTop2, '再次双击没有进入就地编辑');
  inlineTop2.props.onChange({ target: { value: '项目甲改' } });
  inlineTop2.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().inlineEdit, null, 'Enter 提交后没有退出就地编辑');
  eq(PANEL.state().projects.find((p) => p.id === PANEL.state().activeId).name, '项目甲改', 'Enter 提交后项目名未更新');
  const renamedTop = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-name');
  eq(renamedTop && String(renamedTop.props.children), '项目甲改', '改名后顶部项目名未同步');
  // Esc：取消，不改名
  renamedTop.props.onDoubleClick({ stopPropagation: noop });
  const inlineTop3 = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input');
  ok(!!inlineTop3, 'Esc 用例没有进入就地编辑');
  inlineTop3.props.onChange({ target: { value: '不应生效' } });
  inlineTop3.props.onKeyDown({ key: 'Escape', preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().inlineEdit, null, 'Esc 没有退出就地编辑');
  eq(PANEL.state().projects.find((p) => p.id === PANEL.state().activeId).name, '项目甲改', 'Esc 取消后名字被改掉了');
  ok(!all(TABS.Toolbar()).some((e) => e.props && e.props['data-role'] === 'inline-project-name-input'), 'Esc 后输入框没有消失');
  // 失焦提交路径（onBlur）存在
  const blurInput = (() => {
    all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-name')
      .props.onDoubleClick({ stopPropagation: noop });
    return all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input');
  })();
  ok(!!blurInput && typeof blurInput.props.onBlur === 'function', '就地输入框缺少失焦提交（onBlur）');
  blurInput.props.onChange({ target: { value: '项目甲改' } });
  blurInput.props.onBlur();
  eq(PANEL.state().inlineEdit, null, '失焦后没有退出就地编辑');
  // 工具栏没有「添加节点」「运行工作流」
  const tbStrings = stringsOf([[bar], [tb]]).join('|');
  ok(!tbStrings.includes('添加节点'), '工具栏仍存在「添加节点」按钮');
  ok(!tbStrings.includes('运行工作流'), '工具栏仍存在「运行工作流」按钮');
  ok(!/['"]addNode['"]/.test(fnBody('Toolbar')), '工具栏仍引用 addNode 入口');
  ok(!/runWorkflow/.test(fnBody('Toolbar')), '工具栏仍引用 runWorkflow');
  // 点项目名 → 下拉项目列表 + 新建项目…；下拉里**没有**「重命名项目…」（改名只走双击/铅笔）
  switcher.props.onClick({ stopPropagation: noop, currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 44 }) } });
  ok(!!PANEL.state().projectMenu, '点击项目名没有弹出项目下拉');
  const menuEls = all(TABS.Toolbar());
  ok(menuEls.some((e) => clsOf(e).includes('dshic-proj-menu')), '项目下拉未渲染');
  ok(!!act(menuEls, 'switch-project-' + P2), '项目下拉没有列出现有项目');
  ok(!!act(menuEls, 'new-project-main'), '项目下拉没有「新建项目…」');
  ok(!act(menuEls, 'rename-project-main'), '项目下拉仍有「重命名项目…」入口（应只保留 项目列表 + 新建项目…）');
  ok(!stringsOf(menuEls).join('|').includes('重命名项目'), '项目下拉仍渲染「重命名项目…」文字');
  // 源码级：下拉里不许再有「重命名项目」项（改名只保留双甲：双击项目名 / 项目名右侧铅笔）
  ok(!/rename-project-main/.test(src), '源码里仍残留「重命名项目…」下拉项（rename-project-main）');
  const toolbarMenuSrc = fnBody('Toolbar').slice(fnBody('Toolbar').indexOf("className: 'dshic-proj-menu'"));
  ok(toolbarMenuSrc.length > 0, '工具栏里找不到项目下拉渲染块');
  ok(!/renameProject/.test(toolbarMenuSrc), '项目下拉渲染块里仍引用「重命名项目」入口（应只剩项目列表 + 新建项目…）');
  ok(/new-project-main/.test(toolbarMenuSrc), '项目下拉渲染块里找不到「+ 新建项目」入口');
  // 顶部行：[+ 新建项目（纯图标）] 在搜索框之前；搜索框内部右侧放大镜；无底部文字新建行
  const sr4 = menuEls.find((e) => e.props && e.props['data-role'] === 'project-menu-searchrow');
  ok(!!sr4, '项目下拉缺少顶部行（+ 与搜索框）');
  const sr4Kids = (sr4.props.children || []).filter(Boolean);
  eq(sr4Kids.length, 2, '顶部行应只有「+ 新建项目」和搜索框');
  eq(sr4Kids[0].props['data-action'], 'new-project-main', '搜索行第一个子节点不是「+ 新建项目」');
  eq(stringsOf(sr4Kids[0]).join('').trim(), '', '「+ 新建项目」仍带文字');
  ok(String(sr4Kids[0].props.title || '').includes('新建项目'), '「+ 新建项目」缺少 tooltip');
  ok(clsOf(sr4Kids[1]).includes('dshic-proj-menu-search'), '搜索框不在 + 按钮之后');
  ok(!!all(sr4Kids[1]).find((e) => e.props && e.props['data-role'] === 'project-menu-search-icon'), '搜索框缺少内嵌放大镜');
  ok(!stringsOf(menuEls).join('|').includes('新建项目…'), '下拉仍渲染底部「+ 新建项目…」文字行');
  ok(!/T\('newProject'\) \+ '…'/.test(toolbarMenuSrc), '源码里仍渲染底部「+ 新建项目…」文字行');
  // 下拉每行右侧有「修改」（铅笔）按钮：点它 → 该行项目名原地变 input；Enter 提交后各处名称同步
  ok(!!act(menuEls, 'edit-project-' + P1), '项目下拉每行右侧缺少「修改」按钮');
  ok(!!act(menuEls, 'edit-project-' + P2), '项目下拉每行右侧缺少「修改」按钮（P2）');
  act(menuEls, 'edit-project-' + P2).props.onClick({ stopPropagation: noop });
  const ieMenu = PANEL.state().inlineEdit;
  eq(ieMenu && ieMenu.kind, 'project', '下拉「修改」没有进入就地编辑');
  eq(ieMenu && ieMenu.projectId, P2, '下拉「修改」编辑的不是该行项目');
  eq(ieMenu && ieMenu.value, '项目乙', '下拉就地输入框没有预填项目名');
  eq(PANEL.state().projectDialog, null, '下拉「修改」仍弹出了重命名弹窗（应为 inline input）');
  const inlineMenu = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input-menu');
  ok(!!inlineMenu, '下拉行就地编辑没有渲染 input');
  inlineMenu.props.onChange({ target: { value: '项目乙改' } });
  inlineMenu.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().inlineEdit, null, '下拉行 Enter 提交后没有退出编辑');
  eq(PANEL.state().projects.find((p) => p.id === P2).name, '项目乙改', '下拉就地改名未生效');
  // 顶部/右侧面板都读同一份 S.projects → 切到该项目后名称同步
  act(all(TABS.Toolbar()), 'switch-project-' + P2).props.onClick();
  eq(PANEL.state().activeId, P2, '下拉改名后切换项目失败');
  const topAfterMenu = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-name');
  eq(topAfterMenu && String(topAfterMenu.props.children), '项目乙改', '下拉改名后顶部项目名未同步');
  PANEL.openProjectMenuAt(10, 50);
  act(all(TABS.Toolbar()), 'switch-project-' + P1).props.onClick();
  eq(PANEL.state().activeId, P1, '切回 P1 失败');
  // ---------- 当前项目行：无 ✓；铅笔可进入就地改名，且点击不触发行切换/关菜单 ----------
  PANEL.openProjectMenuAt(10, 50);
  const activeEls = all(TABS.Toolbar());
  const activeRow = activeEls.find((e) => e.props
    && String(e.props['data-action'] || '') === 'switch-project-' + P1);
  ok(!!activeRow, '下拉里找不到当前项目行');
  ok((activeRow.props.className || '').includes('is-active'), '当前项目行没有 is-active 选中态');
  // 渲染级：当前行不再有 ✓ / 勾选图标（选中感只靠蓝底蓝字）
  const activeRowStrings = stringsOf(activeRow).join('|');
  ok(!activeRowStrings.includes('✓'), '当前项目行仍渲染 ✓ 勾选字符');
  ok(!all(activeRow).some((e) => clsOf(e).includes('dshic-proj-menu-meta')), '当前项目行仍渲染勾选图标节点');
  ok(!/proj-menu-meta/.test(src), '源码里仍残留下拉勾选图标样式/结构（proj-menu-meta）');
  // 当前行铅笔仍存在、点它进入 inline（且不切项目、不关菜单）
  const activeEdit = act(activeEls, 'edit-project-' + P1);
  ok(!!activeEdit, '当前项目行缺少可用的铅笔（修改）按钮');
  ok(activeEdit.props.disabled !== true, '当前项目行的铅笔被禁用');
  // pointerdown 路径也应直接进入就地编辑（真实浏览器里 click 可能被焦点竞争吞掉）
  activeEdit.props.onPointerDown({ stopPropagation: noop });
  eq(PANEL.state().inlineEdit && PANEL.state().inlineEdit.projectId, P1, '铅笔 pointerdown 没有进入就地编辑');
  PANEL.cancelInlineRename();
  const activeIdBefore = PANEL.state().activeId;
  const menuOpenBefore = !!PANEL.state().projectMenu;
  activeEdit.props.onClick({ preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().inlineEdit && PANEL.state().inlineEdit.projectId, P1, '点当前项目行铅笔没有进入就地编辑');
  eq(PANEL.state().inlineEdit && PANEL.state().inlineEdit.value, '项目甲改', '当前项目行就地输入没有预填当前名字');
  eq(PANEL.state().activeId, activeIdBefore, '点当前项目行铅笔触发了项目切换副作用');
  eq(!!PANEL.state().projectMenu, menuOpenBefore, '点当前项目行铅笔把下拉关掉了（inline input 会被卸载）');
  const activeInline = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input-menu');
  ok(!!activeInline, '当前项目行点击铅笔后没有渲染行内 input');
  activeInline.props.onChange({ target: { value: '当前项改名' } });
  activeInline.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().inlineEdit, null, '当前项目行 Enter 提交后没有退出就地编辑');
  eq(PANEL.state().projects.find((p) => p.id === P1).name, '当前项改名', '当前项目行就地改名未生效');
  const topAfterCurrent = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-name');
  eq(topAfterCurrent && String(topAfterCurrent.props.children), '当前项改名', '当前项目行改名后顶部未同步');
  ok(stringsOf(all(TABS.ProjectsTab())).join('|').includes('当前项改名'), '当前项目行改名后右栏面板未同步');
  // 行点击守卫：即使事件冒泡到行，铅笔/输入框来源也不能触发切换或关菜单
  const rowGuardTarget = { closest: (sel) => (sel.includes('dshic-proj-menu-edit') ? {} : null) };
  PANEL.openProjectMenuAt(10, 50);
  act(all(TABS.Toolbar()), 'switch-project-' + P1).props.onClick({ target: rowGuardTarget });
  eq(PANEL.state().activeId, P1, '铅笔点击冒泡到行仍触发了项目切换');
  ok(!!PANEL.state().projectMenu, '铅笔点击冒泡到行仍关掉了下拉');
  PANEL.closeProjectMenu();
  // 把 P1 名字改回「项目甲改」供后续断言
  PANEL.openProjectMenuAt(10, 50);
  act(all(TABS.Toolbar()), 'edit-project-' + P1).props.onClick({ preventDefault: noop, stopPropagation: noop });
  const restoreInline = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input-menu');
  restoreInline.props.onChange({ target: { value: '项目甲改' } });
  restoreInline.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  PANEL.openProjectMenuAt(10, 50);

  // ---------- 项目下拉视觉契约：与生成面板（GenComposer）同一套容器语言 ----------
  const menuCss = cssRule('.dshic-proj-menu');
  ok(menuCss.length > 0, '未找到 .dshic-proj-menu 样式');
  // 背景必须走主题变量（浅色=白 / 深色自动跟随），且不得出现灰蓝/固定色字面量
  ok(/background:var\(--dsw-alias-bg-layer-1\)/.test(menuCss), '项目下拉背景没有使用主题变量 --dsw-alias-bg-layer-1（深色主题会跟不住）');
  ok(!/--dsw-alias-bg-overlay/.test(menuCss), '项目下拉背景仍用 --dsw-alias-bg-overlay（浅色主题呈现灰蓝底）');
  ok(!/#[0-9a-fA-F]{3,8}|rgba?\(/.test(menuCss), '项目下拉容器出现固定颜色字面量（应只用主题变量）：' + menuCss.slice(0, 120));
  ok(/border:1px solid var\(--dshic-line2\)/.test(menuCss), '项目下拉没有 1px --dshic-line2 边框');
  ok(/border-radius:1[4-6]px/.test(menuCss), '项目下拉圆角不在 14–16px（与生成面板容器语言不一致）');
  ok(/box-shadow:var\(--dshic-shadow-lg\)/.test(menuCss), '项目下拉没有使用 --dshic-shadow-lg 投影');
  ok(/max-height:min\(60vh,calc\(100vh - 64px\)\)/.test(menuCss), '项目下拉没有按视口限制最大高度（项目多时会溢出视口）');
  ok(/overflow-y:auto/.test(menuCss), '项目下拉没有纵向滚动');
  const itemCss = cssRule('.dshic-proj-menu-item');
  ok(/border-radius:9px/.test(itemCss), '项目下拉列表项圆角不是 9px（应在 8–9px）');
  ok(/font-size:var\(--dshic-panel-font\)/.test(itemCss), '项目下拉列表项字号没有跟随面板字号变量（12–13px）');
  const itemHoverCss = cssRule('.dshic-proj-menu-item:hover');
  ok(/var\(--dsw-alias-interactive-bg-hover/.test(itemHoverCss), '列表项 hover 没有使用交互背景变量（深色主题不可读）');
  const itemActiveCss = cssRule('.dshic-proj-menu-item.is-active');
  ok(/--dshic-accent-soft|color-mix\(in srgb,var\(--dsw-alias-brand-primary\)/.test(itemActiveCss), '当前项没有用 accent-soft / 主题色轻混合背景');
  ok(/color:var\(--dshic-accent\)/.test(itemActiveCss), '浅色主题当前项文字没用到 accent（与生成面板选中态同色）');
  ok(/color:var\(--dsw-alias-brand-primary\)/.test(itemActiveCss), '深色主题当前项文字没有用主题色');
  ok(/@media \(prefers-color-scheme:dark\)[\s\S]*?\.dshic-proj-menu-item\.is-active\{background:color-mix\(in srgb,var\(--dsw-alias-brand-primary\)/.test(src),
    '深色主题缺少当前项的主题化覆写（固定 accent-soft 在深底上不可读）');
  // ≤5 项：不应有底部分页行（项目只有 2–3 个）
  ok(!act(menuEls, 'project-menu-pager'), '≤5 项时不应渲染底部分页行');
  ok(!act(menuEls, 'project-menu-page-input'), '≤5 项时不应渲染页码输入框');
  // 定位 / 最大高度 / 滚动：视口内不溢出
  const menuEl = menuEls.find((e) => clsOf(e).split(/\s+/).includes('dshic-proj-menu'));
  ok(!!menuEl, '项目下拉没有渲染根节点');
  const menuStyle2 = menuEl && menuEl.props && menuEl.props.style;
  ok(menuStyle2 && typeof menuStyle2.maxHeight === 'number', '项目下拉没有按视口计算 maxHeight（项目多时会溢出）');
  ok(menuStyle2 && menuStyle2.maxHeight >= 160 && menuStyle2.maxHeight <= 900 - menuStyle2.top - 12,
    '项目下拉 maxHeight 未按 top 收紧：' + JSON.stringify(menuStyle2));
  PANEL.openProjectMenuAt(99999, 99999);
  const clamped = PANEL.state().projectMenu;
  ok(clamped && clamped.left <= 1600 - 220, '下拉左侧未夹在视口内（右侧会溢出）：' + JSON.stringify(clamped));
  ok(clamped && clamped.top <= 900 - 96, '下拉顶部未夹在视口内（底部会溢出）：' + JSON.stringify(clamped));
  PANEL.openProjectMenuAt(10, 50);
  // 切换项目
  act(menuEls, 'switch-project-' + P2).props.onClick();
  eq(PANEL.state().activeId, P2, '点击项目项未切换项目');
  // 新建项目：必须弹命名框；空名被拒
  PANEL.openProjectMenuAt(10, 50);
  const menuEls2 = all(TABS.Toolbar());
  act(menuEls2, 'new-project-main').props.onClick();
  eq(PANEL.state().projectDialog && PANEL.state().projectDialog.mode, 'create', '「新建项目…」没有弹出命名输入框');
  const projCount0 = PANEL.state().projects.length;
  const bad = PANEL.submitProjectDialog();
  ok(bad && bad.ok === false && bad.error, '空项目名未被拒绝');
  eq(PANEL.state().projects.length, projCount0, '空项目名仍然创建了项目');
  ok(!!(PANEL.state().projectDialog && PANEL.state().projectDialog.error), '空项目名没有显示校验错误');
  ok(!!act(all(TABS.ProjectNameDialog()), 'project-dialog-submit'), '命名弹窗缺少确认按钮');
  // 合法名字 → 创建并切换
  PANEL.setProjectDialogValue('新画布项目');
  const good = PANEL.submitProjectDialog();
  ok(good && good.ok === true, '合法项目名创建失败');
  eq(PANEL.state().projects.length, projCount0 + 1, '合法项目名没有创建项目');
  const created = PANEL.state().projects.find((p) => p.name === '新画布项目');
  ok(!!created && PANEL.state().activeId === created.id, '新建项目后未切换到新项目');
  eq(PANEL.state().projectDialog, null, '创建成功后命名弹窗未关闭');
  // createProjectNamed 直接空名校验
  const direct = PANEL.createProjectNamed('   ');
  ok(direct && direct.ok === false, 'createProjectNamed 未拒绝空白名');
  // 命名弹窗只保留「新建」：重命名相关模式已移除（改名只走就地编辑）
  ok(!/openProjectDialog\('rename'/.test(src), '源码里仍有 openProjectDialog(\'rename\')（重命名应只走就地编辑）');
  ok(!/'canvas-rename'/.test(src), '源码里仍残留画布重命名弹窗模式 canvas-rename');
  ok(/const DIALOG_MODES = \['create', 'canvas-create'\];/.test(src), '命名弹窗模式应只剩 create / canvas-create');
  PANEL.openProjectDialog('rename', '旧名字', { projectId: P1 });
  eq(PANEL.state().projectDialog && PANEL.state().projectDialog.mode, 'create', '传 rename 模式仍进入重命名弹窗（应被归一为新建）');
  PANEL.closeProjectDialog();
}

// ============================================================
// 5) 快捷键 / 帮助 / 检查更新：右上角三个纯图标按钮；右侧面板无动作行
// ============================================================
{
  const tb = all(TABS.Toolbar());
  ok(tb.some((e) => e.type === TABS.ShortcutsPanel), '右上角缺少快捷键入口');
  ok(/h\(ShortcutsPanel, \{ compact: true \}\)/.test(fnBody('Toolbar')), '右上角快捷键入口不是纯图标（compact）形态');
  const scEls = all(TABS.ShortcutsPanel({ compact: true }));
  const shortcutsBtn = act(scEls, 'toolbar-shortcuts');
  ok(!!shortcutsBtn, '快捷键入口不是右上角的图标按钮');
  ok(stringsOf(shortcutsBtn).join('').trim() === '', '快捷键图标按钮仍带文字（应为纯图标）');
  ok(!!act(tb, 'toolbar-help'), '右上角缺少帮助与反馈入口');
  ok(stringsOf(act(tb, 'toolbar-help')).join('').trim() === '', '帮助按钮仍带文字（应为纯图标）');
  ok(!!act(tb, 'toolbar-update'), '右上角缺少检查更新入口');
  // hover tooltip 保留（title 文案来自 i18n 键）
  ok(/title: T\('supportBtn'\)/.test(fnBody('Toolbar')), '帮助按钮丢失 hover tooltip');
  ok(/title: T\('updateBtn'\)/.test(fnBody('Toolbar')), '检查更新按钮丢失 hover tooltip');
  shortcutsBtn.props.onClick({ stopPropagation: noop });
  eq(PANEL.state().keysOpen, true, '点击快捷键图标没有展开快捷键面板');
  act(all(TABS.ShortcutsPanel({ compact: true })), 'toolbar-shortcuts').props.onClick({ stopPropagation: noop });
  eq(PANEL.state().keysOpen, false, '再次点击快捷键图标没有收起面板');
  act(tb, 'toolbar-help').props.onClick();
  ok(PANEL.state().supportOpen === true, '「帮助入口」行为改变（未打开帮助弹窗）');
  // 右侧面板不再有动作行
  const rb = all(TABS.Rightbar());
  ok(!rb.some((e) => e.type === TABS.ShortcutsPanel), '右侧面板仍有快捷键入口');
  ok(!act(rb, 'rightbar-help'), '右侧面板仍有帮助入口');
  ok(!act(rb, 'rightbar-update'), '右侧面板仍有检查更新入口');
  ok(!/dshic-rb-actions/.test(src), '右侧面板动作行样式未删除');
}

// ============================================================
// 6) 多画布：默认画布兼容 + 新建/切换/改名/删除（每个子目录 = 独立画布）
// ============================================================
{
  eq(CANVAS.DEFAULT_CANVAS_ID, null, '默认画布 id 应为 null（单画布兼容）');
  eq(CANVAS.canvasDocKey('proj1'), 'proj1', '默认画布文档 key 必须等于 projectId（旧数据兼容）');
  eq(CANVAS.canvasDocKey('proj1', 'canvas2'), 'proj1::canvas2', '多画布文档 key 约定不符');
  const pid = PANEL.state().activeId;
  eq(CANVAS.activeCanvasId(), null, '打开项目应先落在默认画布（canvasId=null）');
  eq(CANVAS.activeGraphKey(), CANVAS.canvasDocKey(pid, null), 'activeGraphKey 与默认画布不匹配');
  const lc0 = CANVAS.listCanvases(pid);
  ok(Array.isArray(lc0) && lc0.length === 1 && lc0[0].id === null, '旧项目应只有默认画布（零迁移）');
  // 新建必须命名
  const badNew = CANVAS.createCanvasNamed(pid, '   ');
  ok(badNew && badNew.ok === false && badNew.error, '新建画布空名未被拒绝');
  eq(CANVAS.listCanvases(pid).length, 1, '空名新建画布仍创建了画布');
  // 合法名字 → 创建并切到新画布；数据层 key 变成 pid::cid
  const made = CANVAS.createCanvasNamed(pid, '第二画布');
  ok(made && made.ok === true && made.canvasId, '新建画布失败');
  eq(CANVAS.activeCanvasId(), made.canvasId, '新建画布后未切换过去');
  eq(CANVAS.activeGraphKey(), CANVAS.canvasDocKey(pid, made.canvasId), '新画布未使用独立文档 key');
  eq(CANVAS.listCanvases(pid).length, 2, '项目画布清单没有包含新画布');
  // 画布隔离：在新画布加节点，切回默认画布看不到
  const rail2 = all(TABS.IconRail());
  act(rail2, 'add-text').props.onClick();
  eq(CANVAS.state().graphNodeIds.length, 1, '新画布加节点失败');
  CANVAS.switchCanvas(null);
  eq(CANVAS.activeCanvasId(), null, '切回默认画布失败');
  eq(CANVAS.state().graphNodeIds.length, 0, '不同画布的节点互相串了');
  // 切换回新画布 → 节点还在（按 key 读写）
  CANVAS.switchCanvas(made.canvasId);
  eq(CANVAS.state().graphNodeIds.length, 1, '切回子画布后节点丢失（文档 key 未按画布隔离）');
  // 切画布要重置撤销栈：新画布上不能 Ctrl+Z 把另一个画布的节点写进来
  ok(/history\.stack = \[\]/.test(fnBody('switchCanvas')), '切画布没有重置撤销栈');
  // 重命名（空名/同名拒绝，合法生效）
  ok(CANVAS.renameCanvasNamed(pid, made.canvasId, '').ok === false, '重命名画布空名未被拒绝');
  ok(CANVAS.renameCanvasNamed(pid, made.canvasId, '第二画布').ok === true, '同名重命名应保持原名成功');
  ok(CANVAS.renameCanvasNamed(pid, made.canvasId, '改名画布').ok === true, '重命名画布失败');
  eq(CANVAS.canvasNameFor(pid, made.canvasId), '改名画布', '重命名画布未生效');
  eq(CANVAS.canvasNameFor(pid, null), '默认画布', '默认画布名称不对');
  // 删除当前画布 → 回默认画布，清缓存
  ok(CANVAS.deleteCanvasNamed(pid, made.canvasId).ok === true, '删除画布失败');
  eq(CANVAS.activeCanvasId(), null, '删除当前画布后未回到默认画布');
  eq(CANVAS.listCanvases(pid).length, 1, '删除画布后清单未更新');
  eq(sync.loadGraphDoc(pid, made.canvasId), null, '删除画布后本地文档缓存未清理');
  // 资产/设定集是项目级：key 不带画布维度（不随画布分割）
  ok(/LS_BIBLE \+ pid/.test(src) && !/LS_BIBLE \+ canvasDocKey/.test(src), '设定集被按画布分割（应按项目共享）');
  ok(/assetsForPicker\(/.test(src) && !/canvasDocKey\([^)]*\)[^)]*asset/.test(src), '资产被按画布分割（应按项目共享）');
  // 目录树：ProjectsTab 里项目下要列出每个画布行，且项目节点有「新建画布」入口
  const projTabSrc = fnBody('ProjectsTab');
  ok(/listCanvases\(/.test(projTabSrc), '「项目」页签没有列出画布（目录树缺失）');
  ok(/new-canvas-/.test(projTabSrc), '「项目」页签没有新建画布入口');
  ok(/delete-canvas-/.test(projTabSrc) && /renameCanvas/.test(projTabSrc), '「项目」页签缺少画布重命名/删除入口');
  // 新建画布弹窗走命名校验（必须命名）
  PANEL.openProjectDialog('canvas-create', '', { projectId: pid });
  eq(PANEL.state().projectDialog && PANEL.state().projectDialog.mode, 'canvas-create', '新建画布没有走命名弹窗');
  const canvasBad = PANEL.submitProjectDialog();
  ok(canvasBad && canvasBad.ok === false && canvasBad.error, '新建画布弹窗空名未被拒绝');
  eq(CANVAS.listCanvases(pid).length, 1, '新建画布弹窗空名仍创建了画布');
  PANEL.setProjectDialogValue('弹窗新画布');
  ok(PANEL.submitProjectDialog().ok === true, '新建画布弹窗合法名字创建失败');
  eq(CANVAS.listCanvases(pid).length, 2, '新建画布弹窗没有创建画布');
}

// ============================================================
// 7) 右侧「项目」面板：只显示当前项目 + 折叠 + 搜索 + 比例协调 + 至少保留一个画布
// ============================================================
{
  const active = PANEL.state().activeId;
  const activeName = PANEL.state().projects.find((p) => p.id === active).name;
  const els = all(TABS.ProjectsTab());
  const panel = els.find((e) => e.props && e.props['data-role'] === 'current-project-panel');
  ok(!!panel, '「项目」页签没有渲染当前项目面板');
  // 右栏不再负责「新建项目」：渲染级 + 源码级都不允许出现入口/文案；新建画布仍在
  const panelStrings = stringsOf(els).join('|');
  ok(!panelStrings.includes('新建项目'), '「项目」页签仍在渲染「新建项目」按钮/文案（新建应只走左上角项目名入口）');
  ok(!/T\('newProject'\)/.test(fnBody('ProjectsTab')), 'ProjectsTab 源码仍引用新建项目文案/入口');
  ok(!!act(els, 'new-canvas-' + active), '「项目」页签缺少「新建画布」入口（应保留）');
  // 新建画布 = 搜索框左侧的纯图标按钮：无文字、无外框/底色，只有 title tooltip
  const addCanvasBtn = act(els, 'new-canvas-' + active);
  ok(stringsOf(addCanvasBtn).join('').trim() === '', '「新建画布」按钮仍带文字（应为纯图标）');
  ok(addCanvasBtn.props.title && addCanvasBtn.props.title.includes('新建画布'), '「新建画布」图标缺少 tooltip 文案');
  ok(!/dshic-canvas-newrow/.test(src), '源码里仍残留底部「+ 新建画布」按钮行（dshic-canvas-newrow）');
  // DOM 顺序：+ 图标在搜索框之前，搜索框占满剩余宽度
  const searchbarEl = els.find((e) => e.props && e.props['data-role'] === 'canvas-searchbar');
  ok(!!searchbarEl, '缺少搜索行容器（+ 新建画布 + 搜索框同一行）');
  const sbKids = (searchbarEl.props.children || []).filter(Boolean);
  ok(sbKids.length === 2, '搜索行应只有两个子节点：+ 图标与搜索框');
  ok(sbKids[0].props && String(sbKids[0].props['data-action'] || '').startsWith('new-canvas-'), '搜索行第一个子节点不是「+ 新建画布」图标');
  ok(clsOf(sbKids[0]).includes('dshic-canvas-add'), '「+ 新建画布」不是纯图标按钮样式');
  ok(sbKids[1].props && clsOf(sbKids[1]).includes('dshic-canvas-search'), '搜索行第二个子节点不是搜索框容器');
  // 搜索框：放大镜在 input 内部右侧（absolute），容器本身无第二层边框/底色
  const searchWrap = sbKids[1];
  const searchInputEl = all(searchWrap).find((e) => e.props && e.props['data-role'] === 'canvas-search');
  ok(!!searchInputEl && searchInputEl.props.placeholder === '搜索画布…', '搜索框 placeholder/结构不对');
  const searchIcon = all(searchWrap).find((e) => e.props && e.props['data-role'] === 'canvas-search-icon');
  ok(!!searchIcon && clsOf(searchIcon).includes('dshic-search-ic'), '搜索框内部缺少放大镜图标');
  const icCss = cssRule('.dshic-search-ic');
  ok(/position:absolute/.test(icCss) && /right:8px/.test(icCss), '放大镜没有绝对定位在输入框内部右侧（position:absolute;right:8px）');
  const searchCss = cssRule('.dshic-canvas-search');
  ok(/flex:1/.test(searchCss), '搜索框没有占满剩余宽度（flex:1）');
  ok(!/border:|background:|box-shadow:/.test(searchCss), '搜索框容器出现第二层边框/底色：' + searchCss.slice(0, 120));
  const searchbarCss = cssRule('.dshic-canvas-searchbar');
  ok(!/border:|background:|box-shadow:/.test(searchbarCss), '搜索行容器出现边框/底色：' + searchbarCss.slice(0, 120));
  ok(/border:1px solid/.test(cssRule('.dshic-input')) && /width:100%/.test(cssRule('.dshic-canvas-search .dshic-input')), '搜索输入框应保持单一边框且占满搜索容器');
  // 左上角下拉里的「+ 新建项目…」仍在且可打开命名弹窗（回归，空名拒绝在 section 4 已覆盖）
  PANEL.openProjectMenuAt(10, 50);
  const topMenuEls = all(TABS.Toolbar());
  const newProjectBtn = act(topMenuEls, 'new-project-main');
  ok(!!newProjectBtn, '左上角项目下拉缺少「+ 新建项目…」入口');
  newProjectBtn.props.onClick();
  eq(PANEL.state().projectDialog && PANEL.state().projectDialog.mode, 'create', '左上角「+ 新建项目…」没有打开命名弹窗');
  PANEL.closeProjectDialog();
  const txt = stringsOf(els).join('|');
  ok(txt.includes(activeName), '面板没有显示当前项目名');
  for (const p of PANEL.state().projects) {
    if (p.id === active) continue;
    ok(!txt.includes(p.name), '「项目」页签仍列出其他项目：' + p.name + '（应只显示当前项目）');
  }
  // 项目行：可改名（就地）/可删除项目
  ok(!!act(els, 'rename-current-project'), '项目行缺少改名入口');
  ok(!!act(els, 'delete-current-project'), '项目行缺少删除项目入口');
  const pname = els.find((e) => e.props && e.props['data-role'] === 'tree-project-name');
  ok(!!pname && typeof pname.props.onDoubleClick === 'function', '项目行不支持双击就地改名');
  pname.props.onDoubleClick({ stopPropagation: noop });
  const pin = all(TABS.ProjectsTab()).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input-panel');
  ok(!!pin, '项目行双击没有进入就地编辑');
  pin.props.onChange({ target: { value: activeName + 'X' } });
  pin.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().projects.find((p) => p.id === active).name, activeName + 'X', '右栏项目就地改名未生效');
  ok(stringsOf(all(TABS.ProjectsTab())).join('|').includes(activeName + 'X'), '改名后面板未同步');
  // 画布行：新增/切换/就地改名/删除
  const canvasRows = els.filter((e) => e.props && /^switch-canvas-/.test(String(e.props['data-action'] || '')));
  ok(canvasRows.length >= 2, '画布行没有列出默认画布 + 子画布');
  const sub = (PANEL.state().projects.find((p) => p.id === active).canvases || [])[0];
  ok(!!sub, '当前项目没有子画布可用于断言');
  ok(!!act(els, 'rename-canvas-' + sub.id), '画布行缺少就地改名入口');
  ok(!!act(els, 'delete-canvas-' + sub.id), '画布行缺少删除入口');
  ok(!!act(els, 'new-canvas-' + active), '项目区域缺少「新建画布」入口');
  act(els, 'rename-canvas-' + sub.id).props.onClick({ stopPropagation: noop });
  const cin = all(TABS.ProjectsTab()).find((e) => e.props && e.props['data-role'] === 'inline-canvas-name-input');
  ok(!!cin, '画布行就地编辑没有渲染 input');
  cin.props.onChange({ target: { value: '画布改名' } });
  cin.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(CANVAS.canvasNameFor(active, sub.id), '画布改名', '画布就地改名未生效');
  // 默认画布也可改名：行内铅笔 → 就地编辑（Enter 提交；空名拒绝）
  const defBefore = CANVAS.canvasNameFor(active, null);
  ok(!!act(els, 'rename-canvas-default'), '默认画布行缺少就地改名（铅笔）入口');
  ok(!!act(els, 'delete-canvas-default'), '默认画布行缺少删除入口（画布数 > 1 时应存在）');
  act(all(TABS.ProjectsTab()), 'rename-canvas-default').props.onClick({ stopPropagation: noop });
  const din = all(TABS.ProjectsTab()).find((e) => e.props && e.props['data-role'] === 'inline-canvas-name-input');
  ok(!!din, '默认画布就地编辑没有渲染 input');
  eq(din && din.props.value, defBefore, '默认画布就地输入框没有预填当前名字');
  // 空名拒绝：名字不变、退出编辑
  din.props.onChange({ target: { value: '   ' } });
  din.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(CANVAS.canvasNameFor(active, null), defBefore, '默认画布空名提交改掉了名字');
  eq(PANEL.state().inlineEdit, null, '默认画布空名提交后没有退出编辑');
  // 合法名字 → Enter 提交，canvasNameFor / 下拉行内画布名 / 面板同步；顶部工具栏不再显示画布名
  act(all(TABS.ProjectsTab()), 'rename-canvas-default').props.onClick({ stopPropagation: noop });
  const din2 = all(TABS.ProjectsTab()).find((e) => e.props && e.props['data-role'] === 'inline-canvas-name-input');
  din2.props.onChange({ target: { value: '主画布' } });
  din2.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(CANVAS.canvasNameFor(active, null), '主画布', '默认画布改名未生效');
  ok(stringsOf(all(TABS.ProjectsTab())).join('|').includes('主画布'), '默认画布改名后面板未同步');
  // 第 3 条：顶部工具栏不再有当前画布名 chip（源码级 + 渲染级）
  ok(!/active-canvas-name/.test(src), '源码里仍渲染顶部当前画布名（active-canvas-name）');
  ok(!/dshic-canvas-chip/.test(src), '源码里仍残留顶部当前画布名样式（dshic-canvas-chip）');
  CANVAS.switchCanvas(null); // 切到默认画布；下拉里当前项目行应显示它的新名字
  const tbNoChip = all(TABS.Toolbar());
  ok(!tbNoChip.some((e) => e.props && e.props['data-role'] === 'active-canvas-name'), '顶部工具栏仍渲染当前画布名 chip');
  ok(!!tbNoChip.find((e) => e.props && e.props['data-role'] === 'project-name'), '顶部项目名丢失');
  ok(tbNoChip.some((e) => clsOf(e).includes('dshic-proj-car')), '顶部项目名下拉箭头丢失');
  PANEL.openProjectMenuAt(10, 50);
  const menuNow = all(TABS.Toolbar());
  const menuSub = menuNow.filter((e) => e.props && e.props['data-role'] === 'project-menu-canvas-name')
    .find((e) => stringsOf(e).join('') === '主画布');
  ok(!!menuSub, '默认画布改名后下拉当前项目行的画布名未同步');
  PANEL.closeProjectMenu();
  // 默认画布可删除（画布数 > 1）：行上有删除按钮 + 行内二次确认；删除走 deleteCanvasNamed(pid, null)
  ok(CANVAS.listCanvases(active).length > 1, '默认画布删除用例要求项目里还有其它画布');
  ok(/confirm-delete-canvas-/.test(src) && /setCanvasDel\(\{ pid: p\.id, cid, name: c\.name \}\)/.test(src),
    '默认画布删除缺少行内二次确认（应先在行内切换到 ✓/✕ 再删）');
  const defaultKey = 'dsh-ic:graph:' + active;
  ok(sandbox.localStorage.getItem(defaultKey) !== null, '默认画布文档缓存不存在（无法验证删除）');
  const delDefault = CANVAS.deleteCanvasNamed(active, null);
  ok(delDefault && delDefault.ok === true, '删除默认画布失败（deleteCanvasNamed(pid, null)）');
  ok(!CANVAS.listCanvases(active).some((c) => c.isDefault), '删除后默认画布仍出现在清单');
  ok(CANVAS.activeCanvasId() !== null, '删除默认画布后没有切换到剩余画布');
  ok(CANVAS.listCanvases(active).some((c) => c.id === CANVAS.activeCanvasId()), '删除默认画布后切到了不存在的画布');
  eq(sandbox.localStorage.getItem(defaultKey), null, '删除默认画布后本地默认文档缓存未清理');
  eq(CANVAS.canvasNameFor(active, null), '', '默认画布已删除，canvasNameFor(null) 不应再返回名字');
  ok(CANVAS.deleteCanvasNamed(active, null).ok === false, '只剩一个画布时仍允许删除默认画布');
  // 只剩一个画布（总数=1，默认画布也算）时：默认/子画布的删除按钮**都不渲染**（不是禁用）；铅笔仍在
  const fresh = PANEL.createProjectNamed('单画布项目');
  const freshEls = all(TABS.ProjectsTab());
  eq(CANVAS.listCanvases(fresh.project.id).length, 1, '新项目应只有默认画布');
  const freshDel = freshEls.filter((e) => e.props && /^delete-canvas-/.test(String(e.props['data-action'] || '')));
  eq(freshDel.length, 0, '只剩一个画布时仍渲染了删除按钮（应隐藏）');
  ok(!!act(freshEls, 'rename-canvas-default'), '默认画布没有改名（铅笔）入口（改名应永远可用）');
  ok(!freshEls.some((e) => e.props && String(e.props['data-action'] || '').startsWith('rename-canvas-cv')),
    '只剩一个画布时不应出现子画布行');
  // 加到 2 个画布后：默认画布的删除按钮重新出现
  CANVAS.createCanvasNamed(fresh.project.id, '第二画布');
  const twoEls = all(TABS.ProjectsTab());
  ok(!!act(twoEls, 'delete-canvas-default'), '画布数 > 1 时默认画布删除按钮没有出现');
  ok(!!act(twoEls, 'delete-canvas-' + CANVAS.listCanvases(fresh.project.id).find((c) => !c.isDefault).id), '画布数 > 1 时子画布删除按钮没有出现');
  ok(!!act(twoEls, 'rename-canvas-default'), '画布数 > 1 时默认画布改名入口丢失');
  // 折叠：开关存在 → 折叠后列表消失且持久化 → 再点恢复
  ok(!!act(freshEls, 'toggle-canvas-collapse'), '项目区域缺少折叠开关');
  ok(!!freshEls.find((e) => e.props && e.props['data-role'] === 'canvas-list'), '折叠前没有画布列表');
  act(freshEls, 'toggle-canvas-collapse').props.onClick({ stopPropagation: noop });
  eq(PANEL.state().canvasCollapsed, true, '点击折叠开关未折叠');
  ok(!all(TABS.ProjectsTab()).some((e) => e.props && e.props['data-role'] === 'canvas-list'), '折叠后子画布列表仍渲染');
  eq(sandbox.localStorage.getItem('dsh-ic:canvas-collapsed'), 'true', '折叠状态没有持久化到 localStorage');
  act(all(TABS.ProjectsTab()), 'toggle-canvas-collapse').props.onClick({ stopPropagation: noop });
  eq(PANEL.state().canvasCollapsed, false, '再次点击没有展开');
  ok(!!all(TABS.ProjectsTab()).find((e) => e.props && e.props['data-role'] === 'canvas-list'), '展开后画布列表没有回来');
  // 搜索：输入即过滤当前项目的子画布
  CANVAS.createCanvasNamed(fresh.project.id, '分镜画布A');
  CANVAS.createCanvasNamed(fresh.project.id, '角色画布B');
  const searchEl = all(TABS.ProjectsTab()).find((e) => e.props && e.props['data-role'] === 'canvas-search');
  ok(!!searchEl, '项目区域缺少搜索框');
  searchEl.props.onChange({ target: { value: '分镜' } });
  const filtered = all(TABS.ProjectsTab());
  const shownRows = filtered.filter((e) => e.props && /^switch-canvas-/.test(String(e.props['data-action'] || '')));
  ok(shownRows.length === 1 && stringsOf(shownRows[0]).join('').includes('分镜画布A'),
    '搜索没有过滤画布（实际：' + shownRows.length + ' 行）');
  PANEL.setCanvasSearch('不存在的画布');
  const noneEls = all(TABS.ProjectsTab());
  eq(noneEls.filter((e) => e.props && /^switch-canvas-/.test(String(e.props['data-action'] || ''))).length, 0, '搜索无匹配时仍显示画布');
  ok(!!noneEls.find((e) => e.props && e.props['data-role'] === 'canvas-search-empty'), '搜索无匹配时缺少空提示');
  PANEL.setCanvasSearch('');
  // 尺寸契约：项目行 36–40px / 画布行 32–34px / 字号 13px 与 12.5px / 缩进 16–20px / 两者差 ≤ 8px
  const projCss = cssRule('.dshic-tree-project');
  const projNameCss = cssRule('.dshic-tree-project .dshic-proj-name');
  const canvasCss = cssRule('.dshic-canvas-row');
  const listCss = cssRule('.dshic-canvas-list');
  const projH = Number((/(?:^|;)height:(\d+)px/.exec(projCss) || [])[1]);
  const canvH = Number((/(?:^|;)height:(\d+)px/.exec(canvasCss) || [])[1]);
  ok(projH >= 36 && projH <= 40, '项目行高不在 36–40px：' + projH);
  ok(canvH >= 32 && canvH <= 34, '画布行高不在 32–34px：' + canvH);
  ok(Math.abs(projH - canvH) <= 8, '项目行与画布行高度差过大（层级失调）：' + projH + ' vs ' + canvH);
  const projFont = Number((/(?:^|;)font-size:([\d.]+)px/.exec(projNameCss) || [])[1]);
  const canvFont = Number((/(?:^|;)font-size:([\d.]+)px/.exec(canvasCss) || [])[1]);
  ok(projFont >= 12.5 && projFont <= 13.5, '项目行字号不在 12.5–13.5px：' + projFont);
  ok(canvFont >= 12 && canvFont <= 13, '画布行字号不在 12–13px：' + canvFont);
  ok(/1[6-9]px/.test(listCss), '子画布缩进不在 16–20px：' + listCss);
}

// ============================================================
// 8) 全局去「灰蓝」：所有弹层实底 + 无半透明模糊；图标栏只占中间
// ============================================================
{
  const css = LAYOUT.CSS || '';
  // 灰蓝 token 全插件零出现
  ok(!/--dsw-alias-bg-overlay/.test(src), '源码仍使用 --dsw-alias-bg-overlay（灰蓝底）');
  ok(!/backdrop-filter/.test(css), '插件 CSS 仍存在 backdrop-filter（半透明模糊底）');
  // 弹层容器清单：项目下拉 / 右键菜单 / 快捷键面板 / 弹窗 / 统一弹窗 / 蒙版 / 模型下拉 / toast / 小地图
  const SURFACES = [
    '.dshic-proj-menu', '.dshic-menu', '.dshic-keys-pop', '.dshic-modal', '.dshic-studio-modal',
    '.dshic-mask-card', '.dshic-pick-menu', '.dshic-toast', '.dshic-minimap',
  ];
  for (const sel of SURFACES) {
    const body = cssRule(sel);
    ok(body.length > 0, '未找到弹层容器样式 ' + sel);
    ok(/background:var\(--dsw-alias-bg-layer-1\)/.test(body), sel + ' 容器没有使用实底主题背景 --dsw-alias-bg-layer-1');
    ok(!/rgba?\(/.test(body), sel + ' 容器出现半透明/固定颜色字面量（rgba）：' + body.slice(0, 120));
    ok(!/backdrop-filter/.test(body), sel + ' 容器仍使用 backdrop-filter 模糊');
    ok(!/--dsw-alias-bg-overlay/.test(body), sel + ' 容器仍用 --dsw-alias-bg-overlay');
  }
  // 气泡/弹窗类：1px 线框 + 14–16px 圆角 + --dshic-shadow-lg
  const RADIUS_SURFACES = [
    '.dshic-proj-menu', '.dshic-menu', '.dshic-keys-pop', '.dshic-modal', '.dshic-studio-modal',
    '.dshic-mask-card', '.dshic-pick-menu', '.dshic-toast',
  ];
  for (const sel of RADIUS_SURFACES) {
    const body = cssRule(sel);
    ok(/border:1px solid var\(--dshic-line2\)|border:1px solid var\(--dshic-line\)/.test(body), sel + ' 容器缺少 1px 线框');
    ok(/border-radius:1[4-6]px/.test(body), sel + ' 圆角不在 14–16px：' + body.slice(0, 100));
    ok(/box-shadow:var\(--dshic-shadow-lg\)/.test(body), sel + ' 缺少 --dshic-shadow-lg 投影');
  }
  // 快捷键面板专项：实底 + 线框 + 圆角（与生成面板同一套语言）
  const keysBody = cssRule('.dshic-keys-pop');
  ok(/background:var\(--dsw-alias-bg-layer-1\)/.test(keysBody), '快捷键面板不是实底主题背景');
  ok(/border-radius:15px/.test(keysBody), '快捷键面板圆角不是 15px');
  ok(/box-shadow:var\(--dshic-shadow-lg\)/.test(keysBody), '快捷键面板缺少统一投影');
  ok(!/color-mix\(in srgb,var\(--dsw-alias-bg-overlay\)/.test(keysBody), '快捷键面板仍是半透明 mix');
  // 节点右键/双击空白菜单与生成面板同一套容器语言
  const ctxBody = cssRule('.dshic-menu');
  ok(/background:var\(--dsw-alias-bg-layer-1\)/.test(ctxBody), '右键/空白菜单不是实底');
  ok(/border-radius:14px/.test(ctxBody), '右键/空白菜单圆角不是 14px');
  // 弹层内部同样不许出现固定色字面量（半透明/灰蓝）
  const INNER = [
    '.dshic-menu-item', '.dshic-keys-key', '.dshic-keys-action', '.dshic-pick-item',
    '.dshic-pick-sub', '.dshic-pick-empty', '.dshic-proj-menu-item', '.dshic-toast',
  ];
  for (const sel of INNER) {
    const body = cssRule(sel);
    ok(body.length > 0, '未找到弹层内部规则 ' + sel);
    ok(!/rgba?\(|#[0-9a-fA-F]{3,8}/.test(body), sel + ' 出现固定色字面量（应用主题变量）：' + body.slice(0, 120));
    ok(!/--dsw-alias-bg-overlay/.test(body), sel + ' 仍用灰蓝 token');
  }
  // 左侧图标栏：外层只占位、内层绝对定位垂直居中（真正悬浮，上下留白）
  const rail = cssRule('.dshic-rail');
  const railInnerCss = cssRule('.dshic-rail-inner');
  ok(/position:absolute/.test(rail) && /left:0/.test(rail) && /top:0/.test(rail) && /bottom:0/.test(rail), '图标列外层不是绝对定位覆盖层（left:0/top:0/bottom:0）');
  ok(/pointer-events:none/.test(rail), '图标列外层没有 pointer-events:none（空白区应穿透到画布）');
  ok(!/flex:1/.test(rail), '图标列仍用 flex:1 撑满');
  // 内层必须是绝对定位 + top:50% + translateY 居中，且高度自适应内容
  ok(/position:absolute/.test(railInnerCss), '图标列内层不是绝对定位（仍会被 flex 拉伸）');
  ok(/top:50%/.test(railInnerCss) && /translateY\(-50%\)/.test(railInnerCss), '图标列内层没有垂直居中（top:50% + translateY(-50%)）');
  ok(/justify-content:center/.test(railInnerCss), '图标列内层没有垂直居中');
  ok(!/flex:1/.test(railInnerCss), '图标列内层仍用 flex:1 撑满');
  // 内层 = 悬浮工具条本体：实底白（主题变量）+ 圆角 + 轻投影（即梦式），托住图标；外层保持透明占位
  ok(/background:var\(--dsw-alias-bg-layer-1\)/.test(railInnerCss), '图标列内层缺少实底白背景（悬浮工具条要有白底）');
  ok(!/border-radius/.test(railInnerCss), '图标列内层不应声明圆角（用户要求四角直角）');
  ok(/box-shadow:var\(--dshic-shadow\)/.test(railInnerCss), '图标列内层缺少轻投影');
  // 渲染级：外层与内层都不带边框/底色样式
  const railTree = TABS.IconRail();
  const railEl = all(railTree).find((e) => clsOf(e).split(/\s+/).includes('dshic-rail'));
  ok(!!railEl, '渲染树里找不到图标列容器');
  ok(!/(^|[^-])border/.test(String(clsOf(railEl))), '图标列容器渲染时带了边框样式类');
  const railStyle = (railEl && railEl.props && railEl.props.style) || {};
  eq(railStyle.border, 0, '图标列渲染 style 的 border 不是 0');
  eq(railStyle.background, 'transparent', '图标列渲染 style 的 background 不是 transparent');
  eq(railStyle.boxShadow, 'none', '图标列渲染 style 的 boxShadow 不是 none');
  eq(railStyle.borderRadius, 0, '图标列渲染 style 的 borderRadius 不是 0');
  // 全量扫描：所有命中 `.dshic-rail` 类名的规则（不只第一条）都不得声明**非零**边框/底色/投影/圆角
  // （`border:0` / `background:transparent` / `box-shadow:none` / `border-radius:0` 是显式归零，属正确写法）
  const railRules = cssRulesMatchingClass('dshic-rail');
  ok(railRules.length >= 1, '找不到任何命中 .dshic-rail 的 CSS 规则');
  for (const r of railRules) {
    ok(!/(^|;)\s*border(-[a-z-]+)?\s*:\s*(?!0\b)(?!none\b)/.test(r.body), '规则「' + r.sel + '」仍声明非零 border');
    ok(!/(^|;)\s*background(-[a-z-]+)?\s*:\s*(?!transparent|none)/.test(r.body), '规则「' + r.sel + '」仍声明非透明 background');
    ok(!/(^|;)\s*box-shadow\s*:\s*(?!none)/.test(r.body), '规则「' + r.sel + '」仍声明 box-shadow');
    ok(!/(^|;)\s*border-radius\s*:\s*(?!0\b)/.test(r.body), '规则「' + r.sel + '」仍声明非零 border-radius');
    ok(!/(^|;)\s*height\s*:\s*(100%|100vh)/.test(r.body), '规则「' + r.sel + '」仍会让图标列撑满高度');
  }
  // 布局模型（fake DOM 无真实排版，按盒模型计算）：内容高 ≈ 图标+分隔线+间距，远小于父高且上下留白充足
  // 图标列现在是「外层占位 + 内层绝对定位居中」两层结构，子节点统计取内层
  const railInner = all(railTree).find((e) => clsOf(e).split(/\s+/).includes('dshic-rail-inner')) || railTree;
  const railBtns = all(railInner).filter((e) => clsOf(e).split(/\s+/).includes('dshic-rail-btn'));
  const railSeps = all(railInner).filter((e) => clsOf(e).split(/\s+/).includes('dshic-rail-sep'));
  const innerKids = railInner.props.children;
  const railKids = (Array.isArray(innerKids) ? innerKids : [innerKids]).filter(Boolean);
  ok(railBtns.length >= 9, '图标列按钮数量不足（应含 9 个动作图标）');
  const contentH = 12 + railBtns.length * 34 + railSeps.length * 1 + (railKids.length - 1) * 3;
  const parentH = 800;
  ok(contentH < parentH * 0.8, '图标列内容高度未明显小于父高：' + contentH + ' vs ' + parentH);
  ok((parentH - contentH) / 2 > 20, '图标列上下留白不足（未真正悬浮）：' + ((parentH - contentH) / 2).toFixed(1));
  // 父容器直接挂 rail + canvas (+右侧栏)，没有额外 wrapper 把 rail 撑成满高
  const pageTree = TABS.CanvasPage();
  const mainEl = all(pageTree).find((e) => clsOf(e).split(/\s+/).includes('dshic-main'));
  ok(!!mainEl, '画布主区域 .dshic-main 不存在');
  const mainKids = (mainEl.props.children || []).filter(Boolean);
  ok(mainKids[0] && mainKids[0].type === TABS.IconRail, '.dshic-main 第一个子节点不是图标列（不应有包边 wrapper）');
  eq(mainKids.filter((k) => k && k.type === TABS.IconRail).length, 1, '.dshic-main 里出现重复图标列');
  ok(mainKids.some((k) => k && k.props && String(k.props.className || '').includes('dshic-canvas')), '.dshic-main 缺少画布区域');
  ok(/h\(IconRail\)/.test(fnBody('CanvasPage')), 'IconRail 未挂到画布主区域');
}

// ============================================================
// 9) 项目下拉：自适应 5 行/页 + 底部分页（页码输入）+ 顶部 +/搜索 + 行内编辑
// ============================================================
{
  for (let i = 1; i <= 12; i++) PANEL.createProjectNamed('分页项目' + String(i).padStart(2, '0'));
  PANEL.closeProjectMenu();
  PANEL.openProjectMenuAt(10, 50); // 新开 → 搜索/页码重置
  const rows = () => all(TABS.Toolbar()).filter((e) => e.props && /^switch-project-/.test(String(e.props['data-action'] || '')));
  const menuSearch = () => all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-menu-search');
  const pageInputEl = () => all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-menu-page-input');
  const pageTotalText = () => {
    const el = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-menu-page-total');
    return el ? stringsOf(el).join('') : '';
  };
  const pageValue = () => String((pageInputEl() || { props: {} }).props.value);
  const jumpTo = (v) => {
    const el = pageInputEl();
    el.props.onChange({ target: { value: String(v) } });
    pageInputEl().props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  };
  // >5 项：固定 5 行高 + 底部分页；≤5 项：按实际行数自适应（不留空白）
  eq(rows().length, 5, '项目下拉第一页应只渲染 5 个项目行');
  const listEl = () => all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-menu-list');
  const listCss = cssRule('.dshic-proj-menu-list');
  ok(/height:auto/.test(listCss), '项目下拉列表基础高度应为 auto（≤5 项时按实际行数）：' + listCss.slice(0, 120));
  ok(/overflow:visible/.test(listCss), '项目下拉列表基础不应裁切（≤5 项时按实际行数）');
  const pagedCss = cssRule('.dshic-proj-menu-list.is-paged');
  ok(/height:calc\(5 \* 38px\)/.test(pagedCss), '>5 项时缺少固定 5 行高度（is-paged）：' + pagedCss.slice(0, 120));
  ok(/overflow:hidden/.test(pagedCss), '>5 项时列表没有固定高度裁切（项目多时会撑高下拉）');
  ok(clsOf(listEl()).includes('is-paged'), '>5 项时列表没有命中 is-paged（仍会自适应）');
  eq(listEl().props['data-paged'], '1', '>5 项时列表 data-paged 标记不对');
  // 顶部行：[+ 新建项目（纯图标）] 在搜索框之前；搜索框内部右侧放大镜
  const tbNow = all(TABS.Toolbar());
  const srEl = tbNow.find((e) => e.props && e.props['data-role'] === 'project-menu-searchrow');
  ok(!!srEl, '>5 项时缺少搜索行容器');
  const srKids = (srEl.props.children || []).filter(Boolean);
  eq(srKids.length, 2, '搜索行应只有「+ 新建项目」和搜索框两个子节点');
  const addProjectBtn = srKids[0];
  ok(addProjectBtn && addProjectBtn.props && addProjectBtn.props['data-action'] === 'new-project-main', '搜索行第一个子节点不是「+ 新建项目」');
  ok(clsOf(addProjectBtn).includes('dshic-proj-menu-add'), '「+ 新建项目」不是纯图标按钮样式');
  eq(stringsOf(addProjectBtn).join('').trim(), '', '「+ 新建项目」按钮仍带文字（应为纯图标）');
  ok(String((addProjectBtn.props && addProjectBtn.props.title) || '').includes('新建项目'), '「+ 新建项目」缺少 tooltip');
  const addCss = cssRule('.dshic-proj-menu-add');
  ok(/background:transparent/.test(addCss) && /border:none/.test(addCss), '「+ 新建项目」按钮不是无外框/无底色');
  ok(clsOf(srKids[1]).includes('dshic-proj-menu-search'), '搜索行第二个子节点不是搜索框（+ 应在搜索框左侧）');
  const searchIcon = all(srKids[1]).find((e) => e.props && e.props['data-role'] === 'project-menu-search-icon');
  ok(!!searchIcon && clsOf(searchIcon).includes('dshic-search-ic'), '搜索框内部缺少放大镜图标');
  const searchIcCss = cssRule('.dshic-search-ic');
  ok(/position:absolute/.test(searchIcCss) && /right:8px/.test(searchIcCss), '放大镜没有绝对定位在输入框内部右侧（absolute/right:8px）');
  const srSearchCss = cssRule('.dshic-proj-menu-search');
  ok(!/border:|background:|box-shadow:/.test(srSearchCss), '搜索框容器出现额外边框/底色：' + srSearchCss.slice(0, 120));
  ok(/padding-right:26px/.test(cssRule('.dshic-proj-menu-search .dshic-input')), '搜索输入框没有给放大镜留出右侧内边距');
  ok(/flex:1/.test(srSearchCss), '搜索框没有占满剩余宽度（flex:1）');
  // 下拉里不存在「+ 新建项目…」文字行（源码级 + 渲染级），按钮只在顶部行
  ok(!/T\('newProject'\) \+ '…'/.test(fnBody('Toolbar')), '源码里仍渲染底部「+ 新建项目…」文字行');
  ok(!stringsOf(tbNow).join('|').includes('新建项目…'), '下拉仍渲染「新建项目…」文字行');
  const addButtons = tbNow.filter((e) => e.props && e.props['data-action'] === 'new-project-main');
  eq(addButtons.length, 1, '「新建项目」入口应只有一个（顶部 + 图标）');
  // 分页在列表底部：‹ [页码输入] / N ›；不在搜索行、不在列表之前
  const pagerEl = tbNow.find((e) => e.props && e.props['data-role'] === 'project-menu-pager');
  ok(!!pagerEl, '>5 项时缺少底部分页行');
  ok(!all(srEl).some((e) => e === pagerEl), '分页控件仍在搜索行内（应移到列表底部）');
  const menuRootEl = tbNow.find((e) => clsOf(e).split(/\s+/).includes('dshic-proj-menu'));
  const menuRootKids = (menuRootEl.props.children || []).filter(Boolean);
  const listEl0 = tbNow.find((e) => e.props && e.props['data-role'] === 'project-menu-list');
  const listIdx = menuRootKids.indexOf(listEl0);
  ok(menuRootKids.indexOf(pagerEl) > listIdx, '分页控件不在列表下方');
  const pagerKids = (pagerEl.props.children || []).filter(Boolean);
  eq(pagerKids.length, 3, '分页行应包含：上一页 + 页码盒（输入+总数） + 下一页');
  eq(pagerKids[0].props['data-action'], 'project-menu-prev', '分页行第一个不是上一页箭头');
  eq(pagerKids[2].props['data-action'], 'project-menu-next', '分页行最后不是下一页箭头');
  const pageBoxKids = (pagerKids[1].props.children || []).filter(Boolean);
  ok(pageBoxKids.some((e) => e.props && e.props['data-role'] === 'project-menu-page-input'), '分页行缺少页码输入框');
  ok(pageBoxKids.some((e) => e.props && e.props['data-role'] === 'project-menu-page-total'), '分页行缺少总页数文本');
  const totalPages = Math.ceil(PANEL.state().projects.length / 5);
  ok(totalPages > 1, '构造的项目数不足，无法验证分页');
  eq(pageValue(), '1', '页码输入框默认应显示当前页 1');
  eq(pageTotalText().replace(/\s/g, ''), '/' + totalPages, '总页数文本不对：' + pageTotalText());
  // 行内布局：每个项目行只有一行文本「项目名 · 画布名」，没有单独画布名次行节点
  const row0 = rows()[0];
  const row0Id = String(row0.props['data-action']).replace('switch-project-', '');
  const mainEl = all(row0).find((e) => clsOf(e).includes('dshic-proj-menu-main'));
  ok(!!mainEl, '项目行缺少主区容器');
  const mainKids = (mainEl.props.children || []).filter(Boolean);
  ok(!all(row0).some((e) => clsOf(e).includes('dshic-proj-menu-sub')), '项目行仍渲染单独的画布名次行节点（dshic-proj-menu-sub）');
  ok(mainKids.some((e) => clsOf(e).includes('dshic-proj-menu-canvas')), '项目行缺少同行画布名节点');
  ok(mainKids.some((e) => clsOf(e).includes('dshic-proj-menu-dot') && stringsOf(e).join('') === '·'), '项目行缺少「·」分隔符');
  const row0Name = PANEL.state().projects.find((p) => p.id === row0Id).name;
  const row0Text = stringsOf(row0).join('');
  ok(row0Text.includes('·') && row0Text.includes('默认画布'), '项目行文本不是「项目名 · 画布名」形式：' + row0Text.slice(0, 80));
  ok(row0Text.indexOf(row0Name) >= 0 && row0Text.indexOf(row0Name) < row0Text.indexOf('·'), '行内顺序应为项目名在前、画布名在后');
  // 行内编辑：铅笔只编辑项目名，画布名仍在同一行；提交后项目名变化、画布名不变
  act(all(TABS.Toolbar()), 'edit-project-' + row0Id).props.onClick({ preventDefault: noop, stopPropagation: noop });
  const rowEdit = rows().find((e) => String(e.props['data-action'] || '') === 'switch-project-' + row0Id);
  const mainEdit = all(rowEdit).find((e) => clsOf(e).includes('dshic-proj-menu-main'));
  ok(!!mainEdit && clsOf(mainEdit).includes('is-editing'), '编辑态项目行主区没有 is-editing');
  ok(!!all(mainEdit).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input-menu'), '编辑态 input 不在项目行主区内');
  ok(all(mainEdit).some((e) => clsOf(e).includes('dshic-proj-menu-canvas')), '编辑态画布名没有和 input 留在同一行');
  ok(!!mainEdit.props.children && (Array.isArray(mainEdit.props.children) ? mainEdit.props.children : []).filter(Boolean).length === 3,
    '编辑态同一行应只有 input + 分隔符 + 画布名三个节点');
  const inputEdit = all(mainEdit).find((e) => e.props && e.props['data-role'] === 'inline-project-name-input-menu');
  const canvasBefore = CANVAS.canvasNameFor(row0Id, null);
  inputEdit.props.onChange({ target: { value: '行内改名项目' } });
  inputEdit.props.onKeyDown({ key: 'Enter', preventDefault: noop, stopPropagation: noop });
  eq(PANEL.state().projects.find((p) => p.id === row0Id).name, '行内改名项目', '行内编辑没有只改项目名');
  eq(CANVAS.canvasNameFor(row0Id, null), canvasBefore, '行内改项目名时画布名被改了');
  PANEL.renameProjectTo(row0Id, row0Name);
  // 搜索 '分页项目' → 12 项，分 3 页；第一页 01–05
  ok(!!menuSearch(), '项目下拉缺少搜索框');
  menuSearch().props.onChange({ target: { value: '分页项目' } });
  eq(rows().length, 5, '搜索过滤后第一页应仍是 5 行');
  ok(stringsOf(rows()[0]).join('').includes('分页项目01'), '搜索结果顺序不对（第一页应从 01 开始）');
  eq(pageValue(), '1', '搜索后页码输入框应回到 1');
  eq(pageTotalText().replace(/\s/g, ''), '/3', '搜索后总页数应为 /3');
  // 箭头翻页 → 06–10
  act(all(TABS.Toolbar()), 'project-menu-next').props.onClick();
  eq(rows().length, 5, '翻页后应仍显示 5 行');
  ok(stringsOf(rows()[0]).join('').includes('分页项目06'), '翻页后不是第 6–10 个项目');
  eq(pageValue(), '2', '箭头翻页后页码输入框应显示 2');
  act(all(TABS.Toolbar()), 'project-menu-prev').props.onClick();
  eq(pageValue(), '1', '上一页后页码输入框应回到 1');
  // 页码输入框：输入合法页码回车跳转
  jumpTo(3);
  eq(rows().length, 2, '输入 3 回车后应跳到最后一页（2 行）');
  ok(stringsOf(rows()[0]).join('').includes('分页项目11'), '输入 3 回车后不是第 11–12 个项目');
  eq(pageValue(), '3', '跳转后页码输入框应显示 3');
  // 夹取：0 → 第 1 页；99 → 最后一页
  jumpTo(0);
  eq(pageValue(), '1', '输入 0 应被夹取到第 1 页');
  jumpTo(99);
  eq(pageValue(), '3', '输入 99 应被夹取到最后一页');
  // 非法文本不改变当前页
  jumpTo('abc');
  eq(pageValue(), '3', '非法页码文本不应改变当前页');
  // 失焦提交同样生效
  pageInputEl().props.onChange({ target: { value: '1' } });
  pageInputEl().props.onBlur();
  eq(pageValue(), '1', '失焦提交页码没有生效');
  // 搜索过滤到 ≤5 项：分页行消失，列表高度 = 实际行数（3×行高，无空白占位）
  PANEL.setProjectMenuSearch('分页项目1');
  eq(rows().length, 3, '搜索「分页项目1」应命中 3 项（10/11/12）');
  ok(!all(TABS.Toolbar()).some((e) => e.props && e.props['data-role'] === 'project-menu-pager'), '结果 ≤5 项时仍渲染分页行');
  const adaptiveList = listEl();
  ok(!!adaptiveList, '≤5 项时缺少列表节点');
  ok(!clsOf(adaptiveList).includes('is-paged'), '≤5 项时列表仍固定 5 行高（is-paged）');
  eq(adaptiveList.props['data-paged'], '0', '≤5 项时列表应标记 data-paged=0（高度自适应）');
  eq((adaptiveList.props.children || []).filter(Boolean).length, 3, '≤5 项时列表高度应等于实际 3 行（不应补空行占位）');
  const srAdaptive = all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-menu-searchrow');
  ok(!!srAdaptive, '≤5 项时缺少搜索行');
  eq((srAdaptive.props.children || []).filter(Boolean).length, 2, '≤5 项时搜索行应仍是「+ 新建项目 + 搜索框」');
  ok(!!act(all(TABS.Toolbar()), 'new-project-main'), '≤5 项时「+ 新建项目」入口丢失');
  // 无匹配空态
  PANEL.setProjectMenuSearch('不存在的项目');
  eq(rows().length, 0, '无匹配时仍渲染项目行');
  ok(!!all(TABS.Toolbar()).find((e) => e.props && e.props['data-role'] === 'project-menu-empty'), '无匹配时缺少空态提示');
  // 搜索不影响行内改名入口；编辑中切换搜索会先结清（不丢输入框/不静默卸载）
  PANEL.setProjectMenuSearch('分页项目0');
  eq(rows().length, 5, '搜索「分页项目0」命中 9 项，第一页应渲染 5 行');
  ok(stringsOf(rows()[0]).join('').includes('分页项目01'), '搜索「分页项目0」第一行应为 01');
  const oneId = String(rows()[0].props['data-action']).replace('switch-project-', '');
  const editBtn = act(all(TABS.Toolbar()), 'edit-project-' + oneId);
  ok(!!editBtn, '搜索过滤后该项目的行内改名入口丢失');
  editBtn.props.onClick({ preventDefault: noop, stopPropagation: noop });
  ok(!!PANEL.state().inlineEdit, '搜索过滤后点击铅笔没有进入就地编辑');
  PANEL.setProjectMenuSearch('分页项目05');
  eq(PANEL.state().inlineEdit, null, '切换搜索时没有先提交/取消进行中的就地改名');
  ok(!all(TABS.Toolbar()).some((e) => e.props && e.props['data-role'] === 'inline-project-name-input-menu'),
    '切换搜索后行内输入框残留（应已提交/取消）');
  // 编辑中翻页同样先结清
  PANEL.setProjectMenuSearch('分页项目');
  const editFirst = act(all(TABS.Toolbar()), 'edit-project-' + String(rows()[0].props['data-action']).replace('switch-project-', ''));
  editFirst.props.onClick({ preventDefault: noop, stopPropagation: noop });
  ok(!!PANEL.state().inlineEdit, '翻页用例没有进入就地编辑');
  act(all(TABS.Toolbar()), 'project-menu-next').props.onClick();
  eq(PANEL.state().inlineEdit, null, '切换分页时没有先提交/取消进行中的就地改名');
  PANEL.closeProjectMenu();
}

// ============================================================
// 10) 设置页「存储实况」：默认一行精简状态，详情收进 ⓘ 折叠（UI-RULES 第 8 条）
// ============================================================
{
  PANEL.setStorageInfoOpen(false);
  PANEL.setDbStats({
    store: 'sqlite', dbExists: true, dbBytes: 60 * 1048576, walBytes: 2 * 1048576,
    projects: 7, assets: 58, fts: 'trigram', dbPath: 'D:\\data\\canvas-data\\canvas.db',
  });
  const settingsTree = all(TABS.SettingsTab());
  ok(settingsTree.some((e) => e.type === TABS.DataRootCard), '设置页没有挂载数据目录/存储卡片');
  const card = () => all(TABS.DataRootCard());
  const s0 = card();
  const summary = s0.find((e) => e.props && e.props['data-role'] === 'storage-summary');
  ok(!!summary, '设置页缺少存储精简状态行');
  const summaryTxt = stringsOf(summary).join('');
  ok(/SQLite/.test(summaryTxt), '精简状态没有显示存储类型 SQLite：' + summaryTxt);
  ok(/62MB/.test(summaryTxt), '精简状态没有显示容量（60+2=62MB）：' + summaryTxt);
  // 默认不展开：详情节点不存在，且整页不再平铺大段存储说明
  ok(!s0.some((e) => e.props && e.props['data-role'] === 'storage-details'), '默认就展开了存储详情（应默认收起）');
  const settingsText = stringsOf(settingsTree).join('|') + '|' + stringsOf(s0).join('|');
  ok(!settingsText.includes('存储实况'), '设置页仍平铺「存储实况」大段说明');
  ok(!settingsText.includes('库文件'), '设置页默认仍显示库文件路径');
  ok(!settingsText.includes('trigram'), '设置页默认仍显示检索统计');
  ok(!settingsText.includes('WAL'), '设置页默认仍显示 WAL 明细');
  const toggle = s0.find((e) => e.props && e.props['data-action'] === 'toggle-storage-info');
  ok(!!toggle, '缺少存储详情展开按钮（ⓘ）');
  eq(stringsOf(toggle).join(''), 'ⓘ', '展开按钮不是 ⓘ 图标');
  toggle.props.onClick({ stopPropagation: noop });
  const s1 = card();
  const details = s1.find((e) => e.props && e.props['data-role'] === 'storage-details');
  ok(!!details, '点击 ⓘ 后没有出现存储详情区');
  const detTxt = stringsOf(details).join('|');
  ok(detTxt.includes('D:\\data\\canvas-data\\canvas.db'), '详情缺少库文件路径：' + detTxt.slice(0, 120));
  ok(detTxt.includes('58') && detTxt.includes('7'), '详情缺少资产/项目统计');
  ok(detTxt.includes('trigram'), '详情缺少检索统计');
  // 再次点击收起
  const toggle2 = s1.find((e) => e.props && e.props['data-action'] === 'toggle-storage-info');
  toggle2.props.onClick({ stopPropagation: noop });
  ok(!card().some((e) => e.props && e.props['data-role'] === 'storage-details'), '再次点击 ⓘ 没有收起详情');
  // 详情样式：实底主题 + 线框，不是高亮/半透明框
  const detCss = cssRule('.dshic-storage-details');
  ok(/background:var\(--dsw-alias-bg-layer-1\)/.test(detCss), '详情区不是实底主题背景');
  ok(/border:1px solid var\(--dshic-line2\)/.test(detCss), '详情区缺少 1px --dshic-line2 线框');
  ok(!/background:rgba|background:color-mix|box-shadow:var\(--dshic-shadow-sel\)/.test(detCss), '详情区出现高亮/半透明底');
  ok(/white-space:nowrap/.test(cssRule('.dshic-storage-summary')), '精简状态不是单行（缺少 nowrap）');
}

if (errs.length) {
  console.error('✗ 面板结构测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 面板结构测试通过（返回图标 / 图标列无框悬浮 / 统一弹窗 / 项目名与画布名就地编辑 / 下拉单行+顶部+/底部页码分页 / 右栏仅当前项目+折叠+搜索+比例 / 全局实底无灰蓝/无模糊 / 多画布目录树 / 存储实况折叠）');
process.exit(0);
