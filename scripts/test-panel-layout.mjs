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
// hookIndex/stateOverrides：按 hook 序号注入状态（test-canvas-perf 同款）——
// stateOverrides 为空时行为与旧 noop 版完全一致；非空时供 AutoModeCard 等局部组件直渲染注入状态。
let hookIndex = 0;
let stateOverrides = [];
// 有状态模式（跨卡丢失更新回归用）：stateStoreMap 非 null 时 useState 跨渲染持久、setter 真正生效，
// 按组件 key 分仓（等价真实 React 的独立组件实例，支持多卡同时挂载）。
// 模拟 React 重渲染（否则 setter 是 noop，验证不了「写回后 setS 同步刷新本地快照」这一半修复）。
let stateStoreMap = null;
let stateKey = '';
const fakeReact = {
  createElement: mkEl,
  useState(init) {
    const i = hookIndex++;
    if (stateStoreMap) {
      const store = (stateStoreMap[stateKey] = stateStoreMap[stateKey] || []);
      if (!Object.prototype.hasOwnProperty.call(store, i)) store[i] = typeof init === 'function' ? init() : init;
      return [store[i], (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v; }];
    }
    const val = Object.prototype.hasOwnProperty.call(stateOverrides, i) ? stateOverrides[i] : (typeof init === 'function' ? init() : init);
    return [val, () => {}];
  },
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
// hostRpc 调用记录（fetch 桩每次 push {method, args}）；rpcResponder 非空时按 method 动态给返回值
const rpcCalls = [];
let rpcResponder = null;
lsStub.setItem('dsh-ic:projects', JSON.stringify([
  { id: P1, name: '项目甲', createdAt: 1, updatedAt: 1 },
  { id: P2, name: '项目乙', createdAt: 2, updatedAt: 2 },
]));
lsStub.setItem('dsh-ic:active', JSON.stringify(P1));
lsStub.setItem('dsh-ic:graph:' + P1, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));
lsStub.setItem('dsh-ic:graph:' + P2, JSON.stringify({ nodes: {}, edges: [], view: { x: 0, y: 0, scale: 1 } }));
lsStub.setItem('dsh-ic:subjects', JSON.stringify([{ id: 's_test', name: '测试角色', desc: '用于面板渲染', assetIds: [] }]));
lsStub.setItem('dsh-ic:workflows', JSON.stringify([{ id: 'wf_test', name: '面板工作流', nodes: [{ key: 'n0', type: 'text', x: 0, y: 0, w: 360, h: 360, data: { text: 'hi' } }], edges: [], assets: [] }]));

const sandbox = {
  window: { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true, localStorage: lsStub },
  document: documentStub,
  localStorage: lsStub,
  navigator: { userAgent: 'test-panel-layout', clipboard: { writeText: async () => {} } },
  location: { href: 'http://127.0.0.1:1/', reload: noop },
  fetch: async (url, opts) => {
    let method = '';
    let args = {};
    try { const b = JSON.parse((opts && opts.body) || '{}'); method = b.method; args = b.args || {}; } catch { /* 忽略 */ }
    rpcCalls.push({ method, args }); // 记录所有 hostRpc 调用（自动创作卡动作区参数断言用）
    const payload = method === 'assetsList'
      ? { items: [], total: 0, nextCursor: null }
      : (rpcResponder ? rpcResponder(method, args) : { ok: true });
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
const SUBJ = sandbox.window.__DSH_IC_SUBJECTS__;
const WF = sandbox.window.__DSH_IC_WORKFLOWS__;
if (!TABS || !PANEL || !CANVAS || !LAYOUT || !sync || !SUBJ || !WF) {
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
  // 导演台（open-director）与 3D-BOX 库（open-3dbox-home）放在动作分区：它们是工具，不是节点类型
  // 记忆查看器（open-memory，0.20.x 会话绑定/项目记忆）：跟在设定集之后，属「项目资料」分组
  eq(acts.join(','), 'add-text,add-script,add-storyboard,add-image,add-video,add-audio,add-finalcut,open-assets,open-bible,open-subjects,open-workflows,open-memory,open-director,open-3dbox-home,run-workflow',
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
  // 工具栏（项目下一行）：同步/导入/全选 + 批量操作 + 分页同排；按钮透明底线框
  ok(/data-role['"]?\s*:\s*'assets-toolbar'/.test(assetsBody), '资产页操作按钮未收拢到项目下一行');
  ok(/data-role['"]?\s*:\s*'assets-page-input'/.test(assetsBody), '资产分页缺少页码输入跳转');
  const iTool = assetsBody.indexOf("'assets-toolbar'");
  const iImp = assetsBody.indexOf("'assets-import'");
  const iBatch = assetsBody.indexOf("'assets-batch-bar'");
  const iPager = assetsBody.indexOf("'assets-pager'");
  ok(iTool > 0 && iImp > iTool && iBatch > iTool && iPager > iTool, '导入/批量/分页必须同属一个工具栏');
  ok(iPager > iImp && iPager > iBatch, '分页不在工具栏内（或位置不在批量操作之后）');
  const assetsCss = LAYOUT.CSS || '';
  ok(/\.dshic-toolbtn\{[^}]*background:transparent/.test(assetsCss), '工具栏按钮仍有底色（应为透明底 + 线框）');
  ok(/\.dshic-toolbtn\{[^}]*border:1px solid/.test(assetsCss), '工具栏按钮缺少 1px 线框');
  ok(/\.dshic-asset-pager\{[^}]*margin-left:auto/.test(assetsCss), '分页未靠右（缺 margin-left:auto）');
  const jump = LAYOUT.assetsPageIndex;
  ok(typeof jump === 'function', '缺少 assetsPageIndex 测试缝隙（页码跳转）');
  if (typeof jump === 'function') {
    eq(jump('2', 10), 1, '页码 2 → 第 2 页（0-based 1）');
    eq(jump('0', 10), 0, '页码 0 夹到第 1 页');
    eq(jump('99', 10), 9, '页码越界夹到末页');
    eq(jump('abc', 10), null, '非法文本保持当前页');
    eq(jump('1.5', 10), null, '小数不当作页码');
    eq(jump('', 10), null, '空输入保持当前页');
  }
  // 搜索行：搜索框（右侧内嵌放大镜）与项目选择同一行
  ok(/data-role['"]?\s*:\s*'assets-searchrow'/.test(assetsBody), '资产页搜索框与项目选择未收进同一行');
  ok(/dshic-asset-search[\s\S]{0,800}?dshic-search-ic/.test(assetsBody), '资产搜索框缺右侧内嵌放大镜');
  ok(/dshic-asset-scope/.test(assetsBody), '资产页项目选择容器缺失（搜索同行布局）');
  // 严格项目隔离：通用项目（GENERAL_PID）资产不得混入其他项目的可见范围
  ok(!/a\.projectId !== GENERAL_PID/.test(assetsBody), '资产筛选仍在放行通用项目（项目隔离不完整）');
  ok(/if \(scope !== 'all' && a\.projectId !== scope\) return false;/.test(assetsBody), '资产筛选未按严格项目隔离过滤');
  // 文本资产（分镜表/剧本）也有项目归属下拉（projSel 抽取复用：媒体在名称行下、文本在 meta 行）
  ok(/const projSel = h\('select'/.test(src), '项目下拉未抽成 projSel 复用');
  ok(/a\.kind === 'text' \? projSel : null/.test(src), '文本资产卡片缺项目归属下拉');
  // 分类收敛：「图片」分类移除（角色/道具/场景本来就是图片），历史 image 资产读取侧归一到通用
  ok(!/const CATEGORIES = \[[^\]]*'image'/.test(src), 'CATEGORIES 仍含已移除的 image 分类');
  {
    const nc = LAYOUT.normCat;
    ok(typeof nc === 'function', '缺少 normCat 测试缝隙（分类归一）');
    if (typeof nc === 'function') {
      eq(nc('image'), 'general', 'image 分类归一到通用');
      eq(nc(''), 'general', '空分类归一到通用');
      eq(nc('character'), 'character', '既有分类保持不变');
      eq(nc('storyboard'), 'storyboard', '既有分类保持不变');
    }
    ok(/normCat\(a\.category\) !== filter/.test(assetsBody), '分类筛选未走归一（历史 image 资产会被孤立）');
    ok(/catLabel\(normCat\(a\.category\)\)/.test(assetsBody), '搜索索引未走分类归一');
    ok(/value: normCat\(a\.category\)/.test(src), '资产卡片分类下拉未走归一（image 资产下拉会显示错位）');
  }
  // 统一导入：单按钮按文件类型分流（图片/视频/文本 .txt/.md）
  ok(/accept: 'image\/\*,video\/\*,\.txt,\.md/.test(assetsBody), '导入按钮未接受文本文件');
  ok(/\.\(txt\|md\|markdown\)\$\/i\.test\(f\.name\)/.test(assetsBody), '导入分流缺文本扩展名识别');
  ok(/category: 'script', source: 'upload'/.test(assetsBody), '导入的文本资产未按剧本分类入库');
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
  eq(tabIds.join(','), 'bible,assets,subjects,workflows,memory', '统一弹窗标签页顺序/数量不对（应为 设定集 / 资产 / 角色库 / 工作流 / 记忆）');
  ok((modalEls.find((e) => e.props['data-tab'] === 'assets').props.className || '').includes('is-active'), '资产页未处于激活态');
  ok(modalEls.some((e) => String(e.props && e.props.className || '').includes('dshic-modal-assets')), '资产页容器缺失');
  ok(modalEls.some((e) => e.type === TABS.AssetsTab), '资产页没有渲染 AssetsTab');
  // 角色库页：分栏 + 全局角色卡（宫格）直渲染
  const subEls = all(SUBJ.SubjectsTab({}));
  ok(subEls.some((e) => e.props && e.props['data-subtab'] === 'mine'), '角色库页缺少「我的角色库」分栏');
  ok(subEls.some((e) => e.props && e.props['data-subject'] === 's_test'), '角色库页没有渲染全局角色卡');
  const wfEls = all(WF.WorkflowsTab({}));
  ok(wfEls.some((e) => e.props && e.props['data-workflow'] === 'wf_test'), '工作流页没有渲染已保存工作流');
  PANEL.openStudioModal('assets');
  const modalEls2 = all(TABS.StudioModal());
  ok(!!act(modalEls2, 'close-modal'), '统一弹窗缺少右上关闭按钮');
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
  eq(rbTabs.join(','), 'projects,craft,settings', '右侧面板页签应为 项目 / 技能 / 设置');
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

// ---------------- 自动创作卡片（0.20.0 实验开关） ----------------
{
  ok(/function AutoModeCard\(/.test(src), '缺 AutoModeCard（设置页自动创作开关卡片）');
  ok(/SettingsTab[\s\S]{0,2400}?h\(AutoModeCard, \{ key: 'automode' \}\)/.test(src), 'AutoModeCard 未挂进设置页（应在 CraftCard 之后）');
  ok(/hostRpc\('autoModeGet'\)/.test(src) && /hostRpc\('autoModeSet'/.test(src), '自动创作卡片未接 autoModeGet/autoModeSet RPC');
  ok(/data-role': 'auto-mode-status'/.test(src), '自动创作状态行缺 data-role（回归定位锚点）');
  ok(src.includes("'autoOldHost'"), '缺旧宿主提示文案（autoModeGet 失败时必须提示重启，不得静默）');
  // 0.20.2 T12：设置卡快捷动作区（全部走现有 RPC，零新增 RPC / 零轮询）
  ok(/对话仍是主入口|对话为主入口/.test(src.slice(Math.max(0, src.indexOf('function AutoModeCard(') - 400), src.indexOf('function AutoModeCard('))), 'AutoModeCard 注释未更新（对话为主入口语义）');
  for (const m of ['autoStart', 'autoQuote', 'autoApprove', 'autoGenerate', 'autoAbort']) {
    ok(new RegExp("hostRpc\\('" + m + "'").test(fnBody('AutoModeCard')), 'AutoModeCard 动作区未接 ' + m + ' RPC');
  }
  for (const k of ['autoStartBtn', 'autoBriefPh', 'autoQuoteBtn', 'autoApproveBtn', 'autoApprovePh', 'autoGenerateBtn', 'autoAbortBtn', 'autoNeedQuote', 'autoDone', 'autoFail']) {
    ok(src.includes("'" + k + "'"), '缺自动创作动作区词条键：' + k);
  }
  ok(/function ProductionStageRow\(/.test(src) && /data-role': 'production-stage'/.test(src), '缺制作阶段行（ProjectsTab 阶段显示）');
  ok(/hostRpc\('productionStatus'/.test(src), '阶段行未接 productionStatus RPC');
  ok(src.includes("'stageCurrent'") && src.includes("'stageBlockers'"), '缺阶段行 i18n 键');
  // zh/en 词条键集合一致（抽两词典的键做差集——audit.mjs 同款手法，抓「加了 zh 忘加 en」）
  {
    const dictKeys = (name) => {
      const start = src.indexOf('const ' + name + ' = {');
      if (start < 0) return null;
      let i = src.indexOf('{', start);
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
      }
      return null;
    };
    const keysOf = (block) => new Set([...String(block || '').matchAll(/^\s{4,6}'([^']+)':/gm)].map((m) => m[1]));
    const zhKeys = keysOf(dictKeys('DICT_ZH'));
    const enKeys = keysOf(dictKeys('DICT_EN'));
    ok(zhKeys && enKeys && zhKeys.size > 0 && enKeys.size > 0, '未能解析 DICT_ZH / DICT_EN（键集合断言需要）');
    if (zhKeys && enKeys) {
      for (const k of zhKeys) if (!enKeys.has(k)) errs.push('英文词典缺词条键：' + k);
      for (const k of enKeys) if (!zhKeys.has(k)) errs.push('中文词典缺词条键：' + k);
    }
  }
  // 绑定 chip 必须是可收缩的（否则长项目名把 composer 右侧按钮挤出边框）
  ok(/\.dshic-bind\{[^}]*min-width:0[^}]*\}/.test(src) && /\.dshic-bind\{[^}]*flex:0 1 auto[^}]*\}/.test(src), '.dshic-bind 缺 flex:0 1 auto / min-width:0（绑定态会挤爆 composer）');
  ok(/\.dshic-bind-chip\{[^}]*max-width:100%[^}]*\}/.test(src), '.dshic-bind-chip 缺 max-width:100%');
  // dsh-image-gen 桥接
  ok(/function ImageGenBridgeCard\(/.test(src) && /data-role': 'image-gen-bridge'/.test(src), '缺 ImageGenBridgeCard（dsh-image-gen 图片模型卡）');
  ok(/h\(ImageGenBridgeCard, \{ key: 'imagegenbridge' \}\)/.test(src), 'ImageGenBridgeCard 未挂进设置页');
  ok(/\/plugins\/dsh-image-gen\/studio/.test(src) && /function apiGenBridge\(/.test(src), '缺 dsh-image-gen /studio 桥接（模型探测或生图）');
  ok(/useBridge\s*\?\s*await apiGenBridge/.test(src), '图片生成未接入 dsh-image-gen 桥接分支');
  ok(/id: 'image-gen-bridge'/.test(src) && /viaImageGen/.test(src), '桥接模型未同步进 imageProviders（节点下拉应直选）');
  ok(src.includes("imageGenStatusYes") && src.includes("imageGenStatusNo"), '缺「未配置/已配置」状态行');
}

// 行为回归（P0）：桥接模型的 viaImageGen/imageGenProvider 必须在扁平视图里透传——
// 否则节点下拉能看到桥接模型，选中生成时 useBridge 判 false → 走 apiImage → baseUrl 空 → 「未配置图片 API」。
// 曾因 flattenImageModels 丢字段导致整条桥接链路必炸，源码正则门禁抓不住，必须走行为断言。
{
  const SET = sandbox.window.__DSH_IC_SETTINGS__;
  ok(SET && typeof SET.flattenImageModels === 'function', '__DSH_IC_SETTINGS__ 缺 flattenImageModels（桥接行为回归需要）');
  if (SET && typeof SET.flattenImageModels === 'function') {
    const fake = {
      imageProviders: [
        { id: 'image-gen-bridge', name: '桥接dsh-image-gen', baseUrl: '', apiKey: '', viaImageGen: true,
          models: [{ id: 'google|gemini-img', model: 'gemini-img', viaImageGen: 'google' }] },
        { id: 'plain', name: '普通供应商', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x',
          models: [{ id: 'm1', model: 'plain-model' }] },
      ],
    };
    const flat = SET.flattenImageModels(fake);
    const bridge = flat.find((x) => x.providerId === 'image-gen-bridge');
    const plain = flat.find((x) => x.providerId === 'plain');
    ok(!!bridge, 'flattenImageModels 丢掉了桥接条目');
    ok(bridge && bridge.viaImageGen === true, '桥接供应商级 viaImageGen 未透传（useBridge 判 false → 生成必炸）');
    ok(bridge && bridge.imageGenProvider === 'google', '桥接模型级 imageGenProvider 未透传（/studio 请求缺 provider）');
    ok(plain && !plain.viaImageGen && !plain.imageGenProvider, '普通供应商被误标为桥接（会错误路由到 /studio）');
  }
}

// 行为回归（状态行语义）：configured 只反映 image-gen 侧的配置状态，与卡片开关解耦——
// 「未配置/已配置」描述的是插件是否配好；开关只管模型是否同步进下拉。曾耦合导致关着开关时显示「未配置」。
// 写盘去抖：探测同步在设置无变化时不得 saveSettings（设置页每次挂载都会探测，写盘会触发 notify 重渲染循环）。
{
  const TABS2 = sandbox.window.__DSH_IC_TABS__;
  const SET = sandbox.window.__DSH_IC_SETTINGS__;
  // 源码级契约：configured 判定不得再乘上 on/enabled（解耦）；syncBridgeModels 写盘前必须比对现状
  ok(!/configured: on && conf\.length/.test(src), '桥接状态行仍与开关耦合（关闭时已配置的插件显示「未配置」）');
  ok(/JSON\.stringify\((?:s0|prev)\.imageProviders(?: \|\| \[\])?\) === JSON\.stringify\(list\)|function syncBridgeModels[\s\S]{0,900}不变/.test(src) || /syncBridgeModels[\s\S]{0,900}noChange/.test(src),
    'syncBridgeModels 每次探测都写盘（设置页挂载→saveSettings→notify 重渲染循环）');
  ok(!!TABS2 && !!SET, '沙箱缝隙缺失（TABS/SETTINGS）');
}

// ============================================================
// 0.20.2 T12：AutoModeCard 快捷动作区（行为级）
//   假 React useState 不保存状态 → 渲染树在「注入态」下断言结构，
//   动作点击的参数/防重入用 rpcCalls 断言；hook 序号注入（stateOverrides）直渲染。
// ============================================================
{
  const AMC = TABS.AutoModeCard;
  ok(typeof AMC === 'function', '缺少 AutoModeCard 测试缝隙（__DSH_IC_TABS__.AutoModeCard）');
  if (typeof AMC === 'function') {
    const rolesOf = (els) => els.map((e) => e.props && e.props['data-role']).filter(Boolean);
    // AutoModeCard 的 hook 顺序：0=st（null 初始）、1=act。注入后 hookIndex 必须复位。
    const renderWith = (stVal, actVal) => {
      stateOverrides = [stVal, Object.assign({ brief: '', confirm: '', quote: null, confirmOpen: false, busy: null, msg: '', err: '' }, actVal || {})];
      hookIndex = 0;
      const tree = AMC();
      hookIndex = 0;
      stateOverrides = [];
      return all(tree);
    };
    const enabledSt = { enabled: true, caps: { multiAgent: true }, oldHost: false, busy: false };
    // —— enabled + multiAgent：动作区五入口齐全 ——
    const elsOn = renderWith(enabledSt);
    ok(rolesOf(elsOn).includes('auto-actions'), 'enabled+multiAgent 时动作区未渲染（data-role auto-actions 缺失）');
    ok(rolesOf(elsOn).includes('auto-brief-input'), '动作区缺 brief 输入框');
    ok(rolesOf(elsOn).includes('auto-start-btn') && rolesOf(elsOn).includes('auto-quote-btn')
      && rolesOf(elsOn).includes('auto-approve-btn') && rolesOf(elsOn).includes('auto-generate-btn')
      && rolesOf(elsOn).includes('auto-abort-btn'), '动作区五按钮不齐（启动/预算/批准/生成/中止）');
    // 关闭态 / 旧宿主 / 非多智能体：一律无动作区
    ok(!rolesOf(renderWith({ enabled: false, caps: { multiAgent: true }, oldHost: false, busy: false })).includes('auto-actions'),
      '关闭态仍渲染了动作区（应只有开关+状态）');
    ok(!rolesOf(renderWith({ enabled: true, caps: null, oldHost: true, busy: false })).includes('auto-actions'),
      '旧宿主仍渲染了动作区');
    ok(!rolesOf(renderWith({ enabled: true, caps: { multiAgent: false }, oldHost: false, busy: false })).includes('auto-actions'),
      '非多智能体仍渲染了动作区');
    // brief 为空 → 启动按钮禁用
    const startBtn0 = elsOn.find((e) => e.props && e.props['data-role'] === 'auto-start-btn');
    ok(startBtn0 && startBtn0.props.disabled === true, 'brief 为空时启动创作按钮未禁用');
    // 无最近预算单时批准按钮禁用（批准令牌绑定最近一次 autoQuote）
    const approveBtn0 = elsOn.find((e) => e.props && e.props['data-role'] === 'auto-approve-btn');
    ok(approveBtn0 && approveBtn0.props.disabled === true, '无最近预算单时批准按钮未禁用');
    // 行内确认输入只在打开后渲染
    ok(!rolesOf(elsOn).includes('auto-confirm-input'), '未打开批准时不应渲染行内确认输入框');
    const elsConfirm = renderWith(enabledSt, { quote: { quoteId: 'qz1', summary: 'x' }, confirmOpen: true, confirm: '批准' });
    ok(rolesOf(elsConfirm).includes('auto-confirm-input'), '打开批准后行内确认输入框缺失');
    // busy 态：全部动作按钮禁用（防重入）——含确认提交（data-role 无 -btn 后缀，regex 须两头都匹配）
    const elsBusy = renderWith(enabledSt, { busy: 'generate', quote: { quoteId: 'qz1', summary: 'x' }, confirmOpen: true, confirm: '批准' });
    const actionRoles = ['auto-start-btn', 'auto-quote-btn', 'auto-approve-btn', 'auto-generate-btn', 'auto-abort-btn', 'auto-confirm-submit'];
    ok(actionRoles.every((role) => {
      const b = elsBusy.find((e) => e.props && e.props['data-role'] === role);
      return b && b.props.disabled === true;
    }), '动作执行中（busy）仍有按钮可点（防重入失效）');
    // —— RPC 参数（源码级）：动作调用必须带 projectId（S.activeId），approve 必须 quoteId+confirm 齐全 ——
    const body = fnBody('AutoModeCard');
    ok(/hostRpc\('autoStart', \{ projectId: pid, brief \}/.test(body), 'autoStart 未带 projectId+brief');
    ok(/hostRpc\('autoQuote', \{ projectId: pid \}\)/.test(body), 'autoQuote 未带 projectId');
    ok(/hostRpc\('autoApprove', \{ projectId: pid, quoteId: act\.quote\.quoteId, confirm: words \}\)/.test(body), 'autoApprove 未带 projectId+quoteId+confirm');
    ok(/hostRpc\('autoGenerate', \{ projectId: pid \}\)/.test(body), 'autoGenerate 未带 projectId');
    ok(/hostRpc\('autoAbort', \{ projectId: pid \}\)/.test(body), 'autoAbort 未带 projectId');
    ok(/S\.activeId \|\| ''/.test(body), 'projectId 未取 S.activeId');
    // quoteId 只信卡片内存的最近一次 autoQuote 返回值（不自动重刷）：批准路径不得主动调 autoQuote
    ok(!/doApprove[\s\S]{0,400}autoQuote/.test(body), '批准前自动重刷了预算（quoteId 应只取卡片内存值——批准令牌绑指纹）');
    // —— RPC 参数（行为级）：真实点击 → fetch 桩记录（活动项目以前序用例可能已切换，读实时状态） ——
    const pidNow = PANEL.state().activeId;
    rpcCalls.length = 0;
    rpcResponder = (method) => (method === 'autoQuote'
      ? { ok: true, quoteId: 'qz_abc', sceneCount: 2, shotCount: 6, totalSeconds: 30, videoCalls: 4, estimatedCost: 1.2, note: '' }
      : { ok: true });
    hookIndex = 0;
    stateOverrides = [enabledSt, { brief: '', confirm: '', quote: null, confirmOpen: false, busy: null, msg: '', err: '' }];
    const live = all(AMC());
    const btn = (role) => live.find((e) => e.props && e.props['data-role'] === role);
    btn('auto-quote-btn').props.onClick();
    await new Promise((r) => setTimeout(r, 10));
    const qCall = rpcCalls.find((c) => c.method === 'autoQuote');
    ok(!!qCall, '点「刷新预算」没有发出 autoQuote RPC');
    eq(qCall && qCall.args.projectId, pidNow, 'autoQuote 的 projectId 不是当前活动项目');
    ok(!!rpcCalls.find((c) => c.method === 'autoModeGet'), '动作执行后未回拉一次 autoModeGet（沿用手动 refresh 模式）');
    rpcCalls.length = 0;
    hookIndex = 0;
    stateOverrides = [enabledSt, { brief: '', confirm: '', quote: null, confirmOpen: false, busy: null, msg: '', err: '' }];
    const live2 = all(AMC());
    live2.find((e) => e.props && e.props['data-role'] === 'auto-generate-btn').props.onClick();
    await new Promise((r) => setTimeout(r, 10));
    const gCall = rpcCalls.find((c) => c.method === 'autoGenerate');
    ok(!!gCall, '点「开始生成」没有发出 autoGenerate RPC');
    eq(gCall && gCall.args.projectId, pidNow, 'autoGenerate 的 projectId 不是当前活动项目');
    eq(gCall && gCall.args.scenes, undefined, '卡片生成不应带 scenes（部分选场是对话侧能力，卡片保持全量）');
    rpcCalls.length = 0;
    hookIndex = 0;
    stateOverrides = [enabledSt, { brief: '', confirm: '', quote: null, confirmOpen: false, busy: null, msg: '', err: '' }];
    const live3 = all(AMC());
    live3.find((e) => e.props && e.props['data-role'] === 'auto-abort-btn').props.onClick();
    await new Promise((r) => setTimeout(r, 10));
    const aCall = rpcCalls.find((c) => c.method === 'autoAbort');
    ok(!!aCall, '点「中止」没有发出 autoAbort RPC');
    eq(aCall && aCall.args.projectId, pidNow, 'autoAbort 的 projectId 不是当前活动项目');
    // 启动：注入 brief（假 React 的 setState 是 noop，无法驱动 onChange 持久化——评审允许 state override）
    rpcCalls.length = 0;
    hookIndex = 0;
    stateOverrides = [enabledSt, { brief: '一个赛博武侠短剧', confirm: '', quote: null, confirmOpen: false, busy: null, msg: '', err: '' }];
    const live4 = all(AMC());
    const sBtn = live4.find((e) => e.props && e.props['data-role'] === 'auto-start-btn');
    ok(sBtn && sBtn.props.disabled !== true, '填了 brief 后启动创作按钮仍被禁用');
    sBtn.props.onClick();
    await new Promise((r) => setTimeout(r, 10));
    const stCall = rpcCalls.find((c) => c.method === 'autoStart');
    ok(!!stCall, '点「启动创作」没有发出 autoStart RPC');
    eq(stCall && stCall.args.projectId, pidNow, 'autoStart 的 projectId 不是当前活动项目');
    eq(stCall && stCall.args.brief, '一个赛博武侠短剧', 'autoStart 的 brief 与输入不一致');
    // 确认批准：注入最近预算单 + 打开行内确认 → 点确认提交 → autoApprove 带 quoteId+confirm
    rpcCalls.length = 0;
    hookIndex = 0;
    stateOverrides = [enabledSt, { brief: '', confirm: '批准', quote: { quoteId: 'qz1', summary: 'x' }, confirmOpen: true, busy: null, msg: '', err: '' }];
    const live5 = all(AMC());
    live5.find((e) => e.props && e.props['data-role'] === 'auto-confirm-submit').props.onClick();
    await new Promise((r) => setTimeout(r, 10));
    const apCall = rpcCalls.find((c) => c.method === 'autoApprove');
    ok(!!apCall, '点「确认批准」没有发出 autoApprove RPC');
    eq(apCall && apCall.args.quoteId, 'qz1', 'autoApprove 的 quoteId 不是卡片内存的最近预算单');
    eq(apCall && apCall.args.confirm, '批准', 'autoApprove 的 confirm 不是输入的确认原话');
    eq(apCall && apCall.args.projectId, pidNow, 'autoApprove 的 projectId 不是当前活动项目');
    rpcResponder = null;
    // —— 卡内显示：错误行 / 成功小字 / 预算摘要（渲染态注入断言） ——
    const elsErr = renderWith(enabledSt, { err: '预算单已过期' });
    ok(rolesOf(elsErr).includes('auto-act-err'), '错误未显示在卡内（缺 data-role auto-act-err 行）');
    ok((elsErr.find((e) => e.props && e.props['data-role'] === 'auto-act-err').props.className || '').includes('dshic-err'),
      '错误行未复用 dshic-err 样式类');
    const elsMsg = renderWith(enabledSt, { msg: '已批准付费（待调用 4 次）' });
    ok(rolesOf(elsMsg).includes('auto-act-msg'), '成功结果未以小字显示在卡内（缺 data-role auto-act-msg）');
    const elsQuote = renderWith(enabledSt, { quote: { quoteId: 'qz_abc', summary: '2 场 / 6 镜 / 30 秒 / 待调用 4 次 · 估算 ¥1.2' } });
    const qLine = elsQuote.find((e) => e.props && e.props['data-role'] === 'auto-quote-line');
    ok(!!qLine && stringsOf(qLine).join('').includes('待调用 4 次'), '预算小字未展示场/镜/秒/待调用摘要');
  }
}

// ============================================================
// 0.20.3：跨卡丢失更新回归（issue #6「设置的模型退出后不能保存」）
//   旧模式：每张设置卡持有挂载时快照、把整对象写回 → 碰第二张卡就把第一张的修改静默回滚。
//   修复：updateSettings（现取磁盘最新做基底）+ 写回后 setS 同步刷新本地快照。
//   有状态 useState（stateStore）让 setState 真正生效，才能同时验证修复的两半。
//   0.20.3 T2：TTS 卡已从 ApiListEditor 迁到 ModelProviderEditor（kind='tts'），驱动方式同步更新。
// ============================================================
{
  const SET = sandbox.window.__DSH_IC_SETTINGS__;
  ok(typeof SET.updateSettings === 'function', '__DSH_IC_SETTINGS__ 缺 updateSettings（设置卡写回助手）');
  ok(typeof SET.LlmModelSelect === 'function' && typeof SET.ModelProviderEditor === 'function',
    '__DSH_IC_SETTINGS__ 缺设置卡组件缝合口（跨卡丢失更新回归需要）');
  ok(typeof SET.ApiListEditor === 'undefined', 'ApiListEditor 已删除却仍挂在 __DSH_IC_SETTINGS__ 缝隙上（死代码未清）');
  stateStoreMap = {}; // 开启 useState 有状态模式（按组件 key 分仓）
  const settingsOf = () => JSON.parse(lsStub.getItem('dsh-ic:settings') || '{}');
  // mount(key)：为该组件开独立状态仓（= 重新挂载，useState 取 loadSettings() 快照）；render(key)：保留该仓状态（= 同卡重渲染）
  const mount = (key, Comp, props) => { stateKey = key; stateStoreMap[key] = []; hookIndex = 0; return all(Comp(props || {})); };
  const render = (key, Comp, props) => { stateKey = key; hookIndex = 0; return all(Comp(props || {})); };
  const addBtn = (els) => els.find((e) => e.type === 'button' && String(e.props.className || '').split(/\s+/).includes('dshic-mini')
    && !String(e.props.className || '').includes('is-ghost') && typeof e.props.onClick === 'function');
  const nameInput = (els) => els.find((e) => e.type === 'input' && e.props.autoFocus === true);
  const starBtns = (els) => els.filter((e) => e.type === 'button' && String(e.props.className || '').includes('is-ghost') && typeof e.props.onClick === 'function');
  const addModelBtnOf = (els) => els.filter((e) => e.type === 'button' && typeof e.props.onClick === 'function')
    .find((e) => stringsOf(e).join('').includes('添加模型'));

  // —— 场景① 跨卡互不回滚（正向）：两卡都在任何写盘前挂载 → 交替写 → 磁盘两边都在。
  //   时序是牙齿的关键：若第二张卡在第一张写盘后才挂载，其挂载快照已含对方写入，回退成快照基底也能绿。
  lsStub.setItem('dsh-ic:settings', '{}');
  let elsTts = mount('tts', SET.ModelProviderEditor, { kind: 'tts' });
  let elsLlm = mount('llm', SET.LlmModelSelect);
  let btn = addBtn(elsTts);
  ok(!!btn, 'TTS 卡缺「新增供应商」按钮（回归驱动不了）');
  btn.props.onClick();
  elsTts = render('tts', SET.ModelProviderEditor, { kind: 'tts' });
  let ni = nameInput(elsTts);
  ok(!!ni, 'TTS 卡新增后未展开名称输入');
  ni.props.onChange({ target: { value: 'tts-a' } });
  eq((settingsOf().ttsProviders || []).length, 1, 'TTS 新增供应商未落盘');
  eq(((settingsOf().ttsProviders || [])[0] || {}).name, 'tts-a', 'TTS 供应商名未落盘');
  const sel = elsLlm.find((e) => e.type === 'select' && typeof e.props.onChange === 'function');
  ok(!!sel, '文本模型卡缺下拉（回归驱动不了）');
  sel.props.onChange({ target: { value: 'prov-a|model-a' } });
  let after = settingsOf();
  eq((after.textLlm || {}).provider, 'prov-a', '文本模型卡写回缺 provider');
  eq((after.textLlm || {}).model, 'model-a', '文本模型卡写回缺 model');
  eq((after.ttsProviders || []).length, 1, '跨卡丢失更新：文本模型卡写回把 TTS 供应商回滚了（issue #6）');
  eq(((after.ttsProviders || [])[0] || {}).name, 'tts-a', '跨卡丢失更新：TTS 供应商名被回滚（issue #6）');
  // setS 同步渲染牙：同卡重渲染应显示新值（漏 setS 则显示挂载时陈旧快照）
  elsLlm = render('llm', SET.LlmModelSelect);
  const manual = elsLlm.find((e) => e.type === 'input');
  eq(manual && manual.props.value, 'prov-a|model-a', '文本模型卡写回后未 setS 同步本地快照（渲染值陈旧）');
  // 再交替一轮：TTS 卡再 patch（同卡二次编辑）→ 断言 textLlm 仍在（先挂载的卡把后写盘的别卡变更保住）
  elsTts = render('tts', SET.ModelProviderEditor, { kind: 'tts' });
  ni = nameInput(elsTts);
  ok(!!ni, 'TTS 卡重渲染后未保留展开的名称输入');
  ni.props.onChange({ target: { value: 'tts-a2' } });
  after = settingsOf();
  eq(((after.ttsProviders || [])[0] || {}).name, 'tts-a2', 'TTS 卡二次改名未落盘');
  eq((after.textLlm || {}).provider, 'prov-a', '跨卡丢失更新：TTS 卡写回把文本模型选择回滚了（issue #6）');

  // —— 场景① 反向：图片卡 + TTS 卡都在任何写盘前挂载 → 图片先写 → TTS 再写 → 两边都在盘 ——
  lsStub.setItem('dsh-ic:settings', '{}');
  let elsImg = mount('img', SET.ModelProviderEditor, { kind: 'image' });
  elsTts = mount('tts2', SET.ModelProviderEditor, { kind: 'tts' });
  btn = addBtn(elsImg);
  ok(!!btn, '图片卡缺「新增供应商」按钮（回归驱动不了）');
  btn.props.onClick();
  elsImg = render('img', SET.ModelProviderEditor, { kind: 'image' });
  ni = nameInput(elsImg);
  ok(!!ni, '图片卡新增后未展开名称输入');
  ni.props.onChange({ target: { value: 'img-b' } });
  after = settingsOf();
  eq((after.imageProviders || []).length, 1, '图片卡新增供应商未落盘');
  eq(((after.imageProviders || [])[0] || {}).name, 'img-b', '图片供应商名未落盘');
  addBtn(elsTts).props.onClick();
  elsTts = render('tts2', SET.ModelProviderEditor, { kind: 'tts' });
  // 新编辑器供应商下没有预置配置：先加一个模型，才有星标可点
  const ttsAddModelBtn = addModelBtnOf(elsTts);
  ok(!!ttsAddModelBtn, 'TTS 卡展开区缺「添加模型」按钮（回归驱动不了）');
  ttsAddModelBtn.props.onClick();
  elsTts = render('tts2', SET.ModelProviderEditor, { kind: 'tts' });
  const stars = starBtns(elsTts);
  ok(stars.length === 1, 'TTS 卡星标按钮数不对（应为 1）');
  stars[0].props.onClick();
  // 第三段交替：图片卡在 TTS 写盘之后再次改名——快照基底突变体在这里会把 TTS 写入回滚（真实 issue #6 触碰顺序）
  elsImg = render('img', SET.ModelProviderEditor, { kind: 'image' });
  ni = nameInput(elsImg);
  ok(!!ni, '图片卡重渲染后未保留展开的名称输入');
  ni.props.onChange({ target: { value: 'img-b2' } });
  after = settingsOf();
  eq(((after.imageProviders || [])[0] || {}).name, 'img-b2', '图片卡二次改名未落盘');
  eq((after.ttsProviders || []).length, 1, '跨卡丢失更新：图片卡写回把 TTS 供应商回滚了（issue #6）');
  eq(String(after.ttsStar || '').startsWith(((after.ttsProviders || [])[0] || {}).id + '|'), true,
    '跨卡丢失更新：TTS 星标被图片卡写回回滚（issue #6）');
  eq((after.imageProviders || []).length, 1, '跨卡丢失更新：图片供应商名被回滚（issue #6）');

  // —— 场景② 同卡连续两次编辑（setS 同步刷新的牙）：第一次编辑 → 直接 saveSettings 模拟别卡写入 → 第二次编辑 → 三次变更全在盘 ——
  lsStub.setItem('dsh-ic:settings', '{}');
  elsTts = mount('tts3', SET.ModelProviderEditor, { kind: 'tts' });
  addBtn(elsTts).props.onClick();
  elsTts = render('tts3', SET.ModelProviderEditor, { kind: 'tts' });
  nameInput(elsTts).props.onChange({ target: { value: 'first' } });
  // 模拟另一卡（图片卡）直接写盘
  SET.saveSettings({ ...SET.loadSettings(), imageProviders: [{ id: 'p-ext', name: 'ext-img', models: [] }] });
  // 同一张卡不重新挂载，第二次编辑
  elsTts = render('tts3', SET.ModelProviderEditor, { kind: 'tts' });
  addBtn(elsTts).props.onClick();
  elsTts = render('tts3', SET.ModelProviderEditor, { kind: 'tts' });
  nameInput(elsTts).props.onChange({ target: { value: 'second' } });
  after = settingsOf();
  eq((after.ttsProviders || []).length, 2, '同卡二次编辑丢了第一次的供应商');
  ok((after.ttsProviders || []).some((x) => x.name === 'first') && (after.ttsProviders || []).some((x) => x.name === 'second'),
    '同卡二次编辑后两次改名未同时落盘：' + JSON.stringify((after.ttsProviders || []).map((x) => x.name)));
  eq((after.imageProviders || []).length, 1, '同卡二次编辑把别卡写回的配置回滚了（快照基底突变体，issue #6）');
  // setS 同步渲染牙：重渲染应同时显示两行（折叠行=span 文本 'first'，展开行=input 值 'second'）；漏 setS 则本地快照仍陈旧
  elsTts = render('tts3', SET.ModelProviderEditor, { kind: 'tts' });
  const ttsNames = stringsOf(elsTts).join('|');
  ok(ttsNames.includes('first'), '写回后未 setS 同步本地快照（同卡重渲染折叠行陈旧）');
  const ttsOpenName = elsTts.find((e) => e.type === 'input' && e.props.autoFocus === true);
  eq(ttsOpenName && ttsOpenName.props.value, 'second', '写回后未 setS 同步本地快照（同卡重渲染展开行陈旧）');

  stateStoreMap = null; // 还原 useState 无状态模式
}

// ============================================================
// 0.20.3 T2：TTS 编辑器统一到「供应商+模型」形态（issue #6 第二阶段）
//   ① schema 迁移：ttsApis/ttsApiId → ttsProviders/ttsStar（确定性 id，loadSettings 直测）
//   ② flattenTtsModels：形状 / 默认路由 / 空模型名过滤
//   ③ 编辑器驱动：加供应商 → 加模型 → 填模型名/voice → 星标 → 写盘断言
// ============================================================
{
  const SET = sandbox.window.__DSH_IC_SETTINGS__;
  ok(typeof SET.flattenTtsModels === 'function', '__DSH_IC_SETTINGS__ 缺 flattenTtsModels（T2 行为回归需要）');
  // T2 独立的挂载/渲染助手（stateStoreMap 有状态模式与上面跨卡场景同款）
  const mount = (key, Comp, props) => { stateKey = key; stateStoreMap[key] = []; hookIndex = 0; return all(Comp(props || {})); };
  const render = (key, Comp, props) => { stateKey = key; hookIndex = 0; return all(Comp(props || {})); };
  const addBtnOf = (els) => els.find((e) => e.type === 'button' && String(e.props.className || '').split(/\s+/).includes('dshic-mini')
    && !String(e.props.className || '').includes('is-ghost') && typeof e.props.onClick === 'function');
  const nameInputOf = (els) => els.find((e) => e.type === 'input' && e.props.autoFocus === true);
  const addModelBtnOf = (els) => els.filter((e) => e.type === 'button' && typeof e.props.onClick === 'function')
    .find((e) => stringsOf(e).join('').includes('添加模型'));
  const settingsOf = () => JSON.parse(lsStub.getItem('dsh-ic:settings') || '{}');
  let after = null;

  // —— ① 迁移：旧扁平 ttsApis + ttsApiId → 新供应商/星标，id 确定性（'p_'+id / 'm_'+id） ——
  lsStub.setItem('dsh-ic:settings', JSON.stringify({
    ttsApis: [
      { id: 'cfgA', name: '配音甲', baseUrl: 'https://tts-a.example.com/v1', apiKey: 'sk-a', model: 'tts-model-a', voice: 'nova', timeoutMs: '90000' },
      { id: 'cfgB', name: '配音乙', baseUrl: 'https://tts-b.example.com/v1', apiKey: 'sk-b', model: 'tts-model-b', voice: '', timeoutMs: '' },
    ],
    ttsApiId: 'cfgB',
  }));
  const migrated = SET.loadSettings();
  eq(migrated.ttsProviders.length, 2, '迁移后应有 2 个 TTS 供应商');
  eq(migrated.ttsProviders[0].id, 'p_cfgA', "迁移供应商 id 非确定性（必须 'p_'+旧cfg.id）");
  eq(migrated.ttsProviders[0].name, '配音甲', '迁移丢供应商名');
  eq(migrated.ttsProviders[0].baseUrl, 'https://tts-a.example.com/v1', '迁移丢 baseUrl');
  eq(migrated.ttsProviders[0].apiKey, 'sk-a', '迁移丢 apiKey');
  eq(migrated.ttsProviders[0].timeoutMs, '90000', '迁移丢供应商级 timeoutMs');
  eq(migrated.ttsProviders[0].models.length, 1, '迁移后每旧配置应产出 1 个模型');
  eq(migrated.ttsProviders[0].models[0].id, 'm_cfgA', "迁移模型 id 非确定性（必须 'm_'+旧cfg.id）");
  eq(migrated.ttsProviders[0].models[0].model, 'tts-model-a', '迁移丢模型名');
  eq(migrated.ttsProviders[0].models[0].voice, 'nova', '迁移丢 voice');
  eq(migrated.ttsProviders[1].models[0].voice, 'alloy', '旧 voice 为空迁移未回退 alloy');
  eq(migrated.ttsStar, 'p_cfgB|m_cfgB', '迁移后 ttsStar 未指向旧默认项的确定性 ref');
  // 确定性牙：再跑一次 loadSettings 结果逐字段一致（uid() 突变体会漂移）
  const migrated2 = SET.loadSettings();
  eq(JSON.stringify(migrated2.ttsProviders), JSON.stringify(migrated.ttsProviders), 'loadSettings 两次迁移结果不一致（id 漂移 = 用了 uid()）');
  eq(migrated2.ttsStar, migrated.ttsStar, 'ttsStar 在重复 loadSettings 间漂移');
  // 新数据不重复迁移：已有 ttsProviders 时旧 ttsApis 不再映射
  lsStub.setItem('dsh-ic:settings', JSON.stringify({
    ttsProviders: [{ id: 'p_keep', name: '保留', baseUrl: '', apiKey: '', models: [{ id: 'm_keep', model: 'keep', voice: 'alloy' }] }],
    ttsApis: [{ id: 'cfgX', name: 'x', baseUrl: '', apiKey: '', model: 'x', voice: '' }],
    ttsApiId: 'cfgX',
  }));
  const noRemigrate = SET.loadSettings();
  eq(noRemigrate.ttsProviders.length, 1, '已有 ttsProviders 时旧 ttsApis 仍被映射（迁移条件非空判断失效）');
  eq(noRemigrate.ttsProviders[0].id, 'p_keep', '迁移覆盖了已有 ttsProviders');

  // —— ② flattenTtsModels：形状 / 默认路由 / 空模型名过滤 ——
  const ttsFlat = SET.flattenTtsModels({
    ttsProviders: [
      { id: 'p1', name: '甲', baseUrl: 'https://x/v1', apiKey: 'k1', timeoutMs: '60000',
        models: [{ id: 'm1', model: 'model-1', voice: 'nova' }, { id: 'm2', model: '  ', voice: 'x' }] },
      { id: 'p2', name: '乙', baseUrl: 'https://y/v1', apiKey: 'k2', models: [{ id: 'm3', model: 'model-3' }] },
    ],
    ttsStar: 'p2|m3',
  });
  eq(ttsFlat.length, 2, '空模型名条目未被过滤（应只剩 2 条）');
  eq(ttsFlat[0].ref, 'p1|m1', 'flattenTtsModels ref 形状不对');
  eq(ttsFlat[0].model, 'model-1', 'flattenTtsModels 模型名未 trim');
  eq(ttsFlat[0].voice, 'nova', 'flattenTtsModels 丢每模型 voice');
  eq(ttsFlat[0].baseUrl, 'https://x/v1', 'flattenTtsModels 丢 baseUrl');
  eq(ttsFlat[0].apiKey, 'k1', 'flattenTtsModels 丢 apiKey');
  eq(ttsFlat[0].timeoutMs, '60000', 'flattenTtsModels 丢供应商级 timeoutMs');
  eq(ttsFlat[1].voice, 'alloy', 'voice 为空未回退 alloy（genTts 请求体会缺音色）');
  // genTts 路由语义：ref === ttsStar 命中（genTts 同款表达式直测）
  const routed = ttsFlat.find((x) => x.ref === 'p2|m3') || ttsFlat[0];
  eq(routed.ref, 'p2|m3', '星标默认路由失效（genTts 应优先 ★）');

  // —— ③ 编辑器驱动：加供应商 → 加模型 → 填模型名/voice → 星标 → 写盘 ——
  stateStoreMap = {};
  lsStub.setItem('dsh-ic:settings', '{}');
  let elsTts = mount('tts4', SET.ModelProviderEditor, { kind: 'tts' });
  addBtnOf(elsTts).props.onClick();
  elsTts = render('tts4', SET.ModelProviderEditor, { kind: 'tts' });
  ok(!!nameInputOf(elsTts), 'TTS 供应商新增后未自动展开（回归驱动不了）');
  // 展开区：TTS 只应有 baseUrl / apiKey / timeoutMs 字段（不带 vendor/size/responseFormat/mode/extra）
  // 假 React 不展开函数组件（Field）——直接断言 Field 元素的 label props
  const fieldLabels = elsTts.filter((e) => typeof e.type === 'function' && e.props && e.props.label != null).map((e) => String(e.props.label));
  ok(fieldLabels.some((t) => t.includes('接口地址')), 'TTS 展开区缺接口地址');
  ok(fieldLabels.some((t) => t.includes('API Key')), 'TTS 展开区缺 API Key');
  ok(fieldLabels.some((t) => t.includes('请求超时')), 'TTS 展开区缺供应商级 timeoutMs 字段');
  for (const banned of ['厂商格式', '尺寸覆盖', 'response_format', '扩展参数']) {
    ok(!fieldLabels.some((t) => t.includes(banned)), 'TTS 展开区混入了不该有的字段：' + banned);
  }
  // 加模型 → 填模型名 + voice（voice 编辑入口是本任务的原始缺口，必须有）
  const addModelBtn = addModelBtnOf(elsTts);
  ok(!!addModelBtn, 'TTS 展开区缺「添加模型」按钮');
  addModelBtn.props.onClick();
  elsTts = render('tts4', SET.ModelProviderEditor, { kind: 'tts' });
  const modelRowInputs = elsTts.filter((e) => e.type === 'input' && !e.props.autoFocus);
  const modelInput = modelRowInputs.find((e) => String(e.props.placeholder || '').includes('模型 ID'));
  const voiceInput = modelRowInputs.find((e) => e.props.placeholder === 'alloy');
  ok(!!modelInput, 'TTS 模型行缺模型名输入框');
  ok(!!voiceInput, 'TTS 模型行缺 voice 输入框（voice 无编辑入口的原始缺口未修复）');
  modelInput.props.onChange({ target: { value: 'gpt-4o-mini-tts' } });
  elsTts = render('tts4', SET.ModelProviderEditor, { kind: 'tts' });
  const voiceInput2 = elsTts.find((e) => e.type === 'input' && e.props.placeholder === 'alloy');
  ok(!!voiceInput2, '填模型名后 voice 输入框丢失');
  voiceInput2.props.onChange({ target: { value: 'shimmer' } });
  after = settingsOf();
  eq((after.ttsProviders || []).length, 1, 'TTS 供应商未落盘');
  const prov = (after.ttsProviders || [])[0] || {};
  eq((prov.models || []).length, 1, 'TTS 模型未落盘');
  eq(((prov.models || [])[0] || {}).model, 'gpt-4o-mini-tts', 'TTS 模型名未落盘');
  eq(((prov.models || [])[0] || {}).voice, 'shimmer', 'TTS voice 未落盘（voice 编辑入口失效）');
  // 星标 → ttsStar 写盘
  elsTts = render('tts4', SET.ModelProviderEditor, { kind: 'tts' });
  const star = elsTts.find((e) => e.type === 'button' && String(e.props.className || '').includes('is-ghost') && typeof e.props.onClick === 'function');
  ok(!!star, 'TTS 模型行缺星标按钮');
  star.props.onClick();
  after = settingsOf();
  eq(after.ttsStar, prov.id + '|' + ((prov.models || [])[0] || {}).id, 'TTS 星标未写盘（ttsStar）');
  // flattenTtsModels 消费一致性：编辑器写出的形状必须能被 flatten 消费出正确 ref/voice
  const flatFromEditor = SET.flattenTtsModels(after);
  eq(flatFromEditor.length, 1, '编辑器写出的 TTS 配置 flatten 后丢条目');
  eq(flatFromEditor[0].ref, after.ttsStar, '编辑器写出的配置 flatten ref 与 ttsStar 不一致');
  eq(flatFromEditor[0].voice, 'shimmer', '编辑器写出的 voice 在 flatten 中丢失');
  stateStoreMap = null; // 还原 useState 无状态模式
}

if (errs.length) {
  console.error('✗ 面板结构测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 面板结构测试通过（返回图标 / 图标列无框悬浮 / 统一弹窗 / 项目名与画布名就地编辑 / 下拉单行+顶部+/底部页码分页 / 右栏仅当前项目+折叠+搜索+比例 / 全局实底无灰蓝/无模糊 / 多画布目录树 / 存储实况折叠 / 自动创作开关卡片）');
process.exit(0);
