#!/usr/bin/env node
/**
 * 会话↔画布绑定 UI 结构契约测试（dev-only，源码级断言）：
 *  1) composer 注入：slots.inject('conversation.input.left') 存在，且带 try/catch 旧 runner 守卫
 *  2) 三态 chip：建画布项目 / 绑画布(未绑) / 已绑定锁定的渲染分支与 i18n key 双语齐全
 *  3) RPC 数据面：sessionBindingGet / sessionBindingSet / sessionBindingClear / workspaceProjectCreate 四个调用齐全
 *  4) 会话广播与跟随：S.activeSessionId 上报 + bindingRev 驱动画布面板跟随（pane 宿主守卫）+ 绑定打开走 hydrate
 *  5) 占用提示：占用画布在菜单里标「已被其他会话占用」
 * 运行：node scripts/test-session-binding-ui.mjs（退出码 0=通过）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------------- 1) composer 注入 + 守卫 ----------------
{
  const i = src.indexOf("slots.inject('conversation.input.left'");
  ok(i >= 0, '缺少 conversation.input.left 槽位注入（composer 画布选择器）');
  if (i >= 0) {
    const tail = src.slice(Math.max(0, i - 300), i + 900); // try 包在注入之前，窗口向后扩
    ok(/try\s*\{/.test(tail) && /catch/.test(tail), 'conversation.input.left 注入必须包 try/catch（旧 runner 降级）');
    ok(/旧 runner|旧宿主|降级/.test(tail), '注入处缺降级注释/守卫说明');
  }
}

// ---------------- 2) 三态 + i18n 双语 ----------------
const KEYS = [
  'bindNewProject', 'bindUnbound', 'bindMenuTitle', 'bindSessionOnly', 'bindNewCanvas',
  'bindNewCanvasPlaceholder', 'bindUnbind', 'bindOccupied', 'bindFail', 'bindCreating', 'bindChipBound',
];
{
  const mZh = /const DICT_ZH = \{/.exec(src);
  const mEn = /const DICT_EN = \{/.exec(src);
  const zhStart = mZh ? mZh.index : -1;
  const enStart = mEn ? mEn.index : -1;
  ok(zhStart >= 0 && enStart >= 0 && zhStart < enStart, 'DICT_ZH / DICT_EN 字典缺失');
  if (zhStart >= 0 && enStart >= 0) {
    for (const k of KEYS) {
      const re = new RegExp("('" + k + "')\\s*:");
      ok(re.test(src.slice(zhStart, enStart)), 'DICT_ZH 缺 key：' + k);
      ok(re.test(src.slice(enStart)), 'DICT_EN 缺 key：' + k);
    }
  }
  for (const k of ['bindNewProject', 'bindUnbound', 'bindUnbind', 'bindChipBound']) {
    ok(src.includes("T('" + k + "')"), 'key ' + k + ' 未在渲染代码中使用');
  }
}

// ---------------- 3) RPC 数据面 ----------------
for (const m of ['sessionBindingGet', 'sessionBindingSet', 'sessionBindingClear', 'workspaceProjectCreate']) {
  ok(src.includes("hostRpc('" + m + "'"), '缺少 RPC 调用：' + m);
}

// ---------------- 4) 会话广播 + 面板跟随 ----------------
{
  ok(src.includes('S.activeSessionId'), '缺少活动会话上报（S.activeSessionId）');
  ok(src.includes('bindingRev'), '缺少跟随驱动信号（bindingRev）');
  // 跟随 effect：绑定存在 → switchProject + switchCanvas + hydrate，且 pane 宿主守卫
  const followIdx = src.indexOf('followBoundCanvas');
  ok(followIdx >= 0, '缺少 followBoundCanvas 跟随实现');
  if (followIdx >= 0) {
    const seg = src.slice(followIdx, followIdx + 1600);
    ok(/switchProject/.test(seg) && /switchCanvas/.test(seg), '跟随未切换项目/画布');
    ok(/hydrateCanvasFromHost/.test(seg), '跟随未拉取远端画布文档（ hydrate ）');
    ok(/pane/.test(seg), '跟随缺 pane 宿主守卫（全屏面板不跟随）');
  }
}

// ---------------- 5) 占用提示 ----------------
{
  ok(/occupied/.test(src), '绑定数据未消费 occupied 占用图');
  ok(src.includes("T('bindOccupied')"), '菜单缺「已被其他会话占用」提示');
}

// ---------------- 结果 ----------------
if (errs.length) {
  console.error('✗ test-session-binding-ui FAIL（' + errs.length + '）:');
  for (const m of errs) console.error('  - ' + m);
  process.exit(1);
}
console.log('✓ test-session-binding-ui PASS');
