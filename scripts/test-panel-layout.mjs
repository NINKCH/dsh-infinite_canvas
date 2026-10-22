// 面板结构重构回归测试（dev-only）：
//   1) 顶部无空白：.dshic-page 不再吃 --dsh-frame-top-clearance / padding-top，画布第一块就是工具栏
//   2) 左侧图标列（单列）：顺序 = 文本/剧本/分镜表/图片/视频/成片/资产/设定集/运行工作流，
//      点节点图标 → 在视口中心添加该类型节点；整列垂直居中（不是贴左上角）；资产/设定集与弹窗联动高亮
//   3) 资产 + 设定集统一弹窗：两个标签页、资产页用 assetsForPicker 数据源 + 网格卡片、
//      Esc / 遮罩关闭、右侧面板不再有资产/设定集页签
//   4) 顶部工具栏：最左「返回会话」纯 < 图标 → 项目名（下拉列出项目 + 新建项目…；双击/铅笔重命名；
//      下拉里没有「重命名项目…」）；新建/重命名必须命名、空名被拒
//   5) 快捷键 / 帮助反馈 / 检查更新回到右上角：三个纯图标按钮（hover tooltip），右侧面板不再有动作行
//   6) 多画布：项目为根、子画布为目录；新建必须命名；切换读写不同 key；删除回默认画布；
//      默认画布 canvasId=null（key 仍等于 projectId，旧数据零迁移）
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
  eq(acts.join(','), 'add-text,add-script,add-storyboard,add-image,add-video,add-finalcut,open-assets,open-bible,run-workflow',
    '左侧图标列顺序/动作不符合要求');
  ok(/\.dshic-rail\{[^}]*flex:none/.test((LAYOUT.CSS || '')), '图标列不是固定 flex:none 列（会随画布布局变化）');
  // 第 2 条：图标列整列垂直居中（不是贴左上角）
  ok(/\.dshic-rail\{[^}]*justify-content:center/.test((LAYOUT.CSS || '')), '图标列没有垂直居中（justify-content:center）');
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
  const switcher = (projWrap.props.children || []).filter(Boolean)[0];
  ok(switcher && switcher.props && switcher.props['data-role'] === 'project-switcher', '工具栏项目名切换按钮缺失');
  const nameEl = ((switcher.props.children || []).filter(Boolean)).find((c) => c && c.props && c.props['data-role'] === 'project-name');
  ok(nameEl && String(nameEl.props.children) === '项目甲', '工具栏项目名未显示当前项目（实际：' + (nameEl && nameEl.props.children) + '）');
  // 第 3 条：双击项目名 → 预填当前名字的重命名弹窗
  ok(typeof nameEl.props.onDoubleClick === 'function', '项目名不支持双击重命名');
  nameEl.props.onDoubleClick({ stopPropagation: noop });
  eq(PANEL.state().projectDialog && PANEL.state().projectDialog.mode, 'rename', '双击项目名未进入重命名');
  eq(PANEL.state().projectDialog && PANEL.state().projectDialog.value, '项目甲', '双击重命名未预填当前项目名');
  PANEL.setProjectDialogValue('');
  const emptyRename = PANEL.submitProjectDialog();
  ok(emptyRename && emptyRename.ok === false && emptyRename.error, '重命名空名未被拒绝');
  eq(PANEL.state().projects.find((p) => p.id === PANEL.state().activeId).name, '项目甲', '空名重命名仍改掉了项目名');
  ok(!!(PANEL.state().projectDialog && PANEL.state().projectDialog.error), '重命名空名没有显示校验错误');
  PANEL.setProjectDialogValue('项目甲改');
  ok(PANEL.submitProjectDialog().ok === true, '合法重命名失败');
  eq(PANEL.state().projects.find((p) => p.id === PANEL.state().activeId).name, '项目甲改', '合法重命名未生效');
  // 第 3 条：项目名右侧有编辑图标，点击同样进入重命名
  const editBtn = act(all(TABS.Toolbar()), 'rename-project-icon');
  ok(!!editBtn, '项目名右侧缺少编辑（重命名）图标');
  editBtn.props.onClick({ stopPropagation: noop });
  eq(PANEL.state().projectDialog && PANEL.state().projectDialog.mode, 'rename', '编辑图标未打开重命名弹窗');
  PANEL.closeProjectDialog();
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

if (errs.length) {
  console.error('✗ 面板结构测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 面板结构测试通过（返回图标/图标列垂直居中/资产+设定集统一弹窗/项目名双击与铅笔改名/下拉无重命名项/右上角纯图标按钮/多画布目录树）');
process.exit(0);
