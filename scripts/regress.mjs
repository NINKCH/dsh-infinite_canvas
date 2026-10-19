#!/usr/bin/env node
/**
 * IC-02 统一回归入口（dev-only，不随包发布）。
 *
 * 为什么存在：RELEASING.md 说「12 项」、docs/release.md §3 说「10 项」，两份口径不一致；
 * 更要紧的是最危险的成片链路（test-compose）从来没进任何门禁清单 —— 历史上
 * `bc77bb8e fix(finalcut): 每次合成都崩(ReferenceError: dur is not defined)` 就是
 * 只在用户点"合成"时炸、静态审计抓不到的典型（test-compose 的头注释记着这件事）。
 *
 * 用法：
 *   node scripts/regress.mjs            # 日常开发：条件用例缺失前置时记 SKIP，不算失败
 *   node scripts/regress.mjs --strict   # 发版门禁：SKIP 也算失败（缺前置 = 没测）
 *   node scripts/regress.mjs --only=test-db,test-compose   # 只跑指定脚本（排障用）
 *   node scripts/regress.mjs --list     # 列出清单后退出
 *
 * 四态输出：PASS / FAIL / SKIP / ERROR
 *   PASS  = 退出码 0，且没有"跳过"标记
 *   SKIP  = 退出码 0，但输出里出现跳过标记（条件用例缺前置）
 *   FAIL  = 退出码非 0，且输出里没有崩溃特征（脚本正常判定失败）
 *   ERROR = 退出码非 0，且输出含堆栈/语法错误特征（脚本自己炸了，比 FAIL 更严重）
 *
 * 退出码：默认出现 FAIL 或 ERROR → 非 0；--strict 下再叠加 SKIP。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const ONLY = (() => {
  const hit = argv.find((a) => a.startsWith('--only='));
  if (!hit) return null;
  return new Set(hit.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
})();

/**
 * 清单（PM 定稿：必须包含 test-compose / test-db / test-drag-alt / test-real-project / test-real-project-graph）。
 * conditional = true 的用例：缺前置时脚本自己打印"跳过"并 exit 0；--strict 下算失败。
 * partialSkip = true 的用例：脚本内部有子项跳过（如开发态 link 安装下 updateInstall 走引导分支），
 *   但主检查真的跑了且通过 → 判 PASS，只把子项跳过原因打出来（不算"没测"）。
 */
const SUITE = [
  // --- 语法闸门（不是脚本，单独跑）---
  { kind: 'syntax', name: 'node --check index.js', args: ['--check', path.join(ROOT, 'index.js')] },
  { kind: 'syntax', name: 'node --check client.js', args: ['--check', path.join(ROOT, 'client.js')] },
  // --- 静态审计 ---
  { name: 'audit.mjs', desc: '机械化体检（i18n/CSS/节点类型/RPC 一致）' },
  // --- 渲染与组件 ---
  { name: 'smoke-render.mjs', desc: '渲染冒烟（假 React 走真实组件树，抓黑屏级崩溃）' },
  { name: 'test-drag-alt.mjs', desc: '拖动推挤 / Alt 自由摆放 / 快捷键面板' },
  { name: 'test-download-ext.mjs', desc: 'IC-01 下载扩展名按容器判定' },
  { name: 'test-craft-base.mjs', desc: 'BLK-02 画布→ArtCraft base+path 契约' },
  // --- 核心链路（历史事故区）---
  { name: 'test-compose.mjs', desc: '成片合成主循环（dur is not defined 事故的网兜）' },
  { name: 'test-tools.mjs', desc: '对话工具 schema 与返回值契约' },
  { name: 'test-mentions.mjs', desc: '@引用解析（设定集匹配 / [图N] 绑定）' },
  { name: 'test-llm-stream.mjs', desc: 'LLM 流式与推理重试' },
  { name: 'test-sync-bible.mjs', desc: '设定集同步合并 / 边墓碑防复活' },
  { name: 'test-user-scenarios.mjs', desc: '用户实测场景定向复验' },
  { name: 'test-host-hardening.mjs', desc: 'Host 加固（读流错误 / 项目合并 / 来源校验）' },
  // --- 存储与数据目录 ---
  { name: 'test-db.mjs', desc: '存储引擎 v2（SQLite/CAS/迁移）' },
  { name: 'test-delete-project.mjs', desc: 'BLK-01 删项目清镜像目录 + FTS 等值' },
  { name: 'test-dataroot.mjs', desc: '数据目录布局 / 文档镜像 / 一键导入' },
  { name: 'test-object-read.mjs', desc: 'IC-08 CAS 写路径退役 + 读路径保留' },
  { name: 'test-changelog.mjs', desc: 'IC-07 CHANGELOG 结构 / 版本号未定 / CAS 条目不越界' },
  // --- 网络与条件用例 ---
  { name: 'test-image-proxy.mjs', desc: '图片 API 代理（CORS 规避）' },
  { name: 'test-update.mjs', desc: '更新检查（打真实 npm registry，需网络）', conditional: '需要网络访问 registry.npmjs.org', partialSkip: true },
  { name: 'test-real-project.mjs', desc: '真实项目数据定向验证', conditional: '需要 D:/data/canvas-data/canvas.db（或 DSH_IC_DATA_ROOT）' },
  { name: 'test-real-project-graph.mjs', desc: '真实项目图结构验证', conditional: '需要 D:/data/canvas-data/canvas.db 且含目标项目' },
  // --- 打包 ---
  { name: 'check-pack.mjs', desc: '打包清单 + 元数据核对（npm pack --dry-run）' },
];

const SKIP_MARKERS = [/跳过/, /\bSKIP\b/i, /缺前置/, /未找到.*canvas\.db/];
const CRASH_MARKERS = [/SyntaxError/, /ReferenceError/, /TypeError/, /RangeError/, /\n\s+at .+\(/, /EMPTY_RESPONSE/, /Cannot find module/];

function runOne(item) {
  const isSyntax = item.kind === 'syntax';
  const file = isSyntax ? process.execPath : path.join(SCRIPTS, item.name);
  if (!isSyntax && !existsSync(file)) {
    return Promise.resolve({ state: 'ERROR', code: -1, ms: 0, out: '脚本不存在：' + file });
  }
  const args = isSyntax ? item.args : [file];
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    } catch (e) {
      resolve({ state: 'ERROR', code: -1, ms: Date.now() - t0, out: String((e && e.message) || e) });
      return;
    }
    const cap = (d) => { if (out.length < 200000) out += d.toString('utf8'); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    let timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, 15 * 60 * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ state: 'ERROR', code: -1, ms: Date.now() - t0, out: out + '\n[spawn] ' + String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const text = out;
      if (code === 0) {
        const skipped = SKIP_MARKERS.some((re) => re.test(text));
        // partialSkip 脚本：内部子项跳过不算"整体没测"，只在 PASS 行后附注
        resolve({ state: skipped && !item.partialSkip ? 'SKIP' : 'PASS', code, ms, out: text, subSkip: skipped });
        return;
      }
      const crashed = CRASH_MARKERS.some((re) => re.test(text));
      resolve({ state: crashed ? 'ERROR' : 'FAIL', code, ms, out: text });
    });
  });
}

const label = (item) => (item.kind === 'syntax' ? item.name : 'scripts/' + item.name);
const tail = (out, n = 24) => out.split(/\r?\n/).filter(Boolean).slice(-n).join('\n');

async function main() {
  if (argv.includes('--list')) {
    for (const it of SUITE) console.log((it.conditional ? '[条件] ' : '       ') + label(it) + (it.desc ? '  — ' + it.desc : ''));
    console.log('\n共 ' + SUITE.length + ' 项（其中条件用例 ' + SUITE.filter((x) => x.conditional).length + ' 项）');
    return 0;
  }

  const list = ONLY ? (() => {
    const picked = [];
    for (const want of ONLY) {
      // 名字容错：test-db / test-db.mjs / node --check index.js 都能对上
      const hit = SUITE.find((it) => it.name === want || label(it) === want || it.name === want + '.mjs');
      if (hit) { if (!picked.includes(hit)) picked.push(hit); }
      else picked.push({ name: want, desc: '（--only 指定，不在清单内）' }); // 不存在的脚本 → ERROR，正是要验证的
    }
    return picked;
  })() : SUITE;
  if (!list.length) {
    console.error('✗ --only 没有匹配到任何脚本；用 --list 看清单');
    return 2;
  }

  console.log('回归开始：' + list.length + ' 项' + (STRICT ? '（--strict：SKIP 也算失败）' : ''));
  console.log('Node ' + process.version + ' · cwd ' + ROOT + '\n');

  const results = [];
  for (const it of list) {
    process.stdout.write('▶ ' + label(it) + ' … ');
    const r = await runOne(it);
    results.push({ item: it, ...r });
    console.log(r.state + ' (' + (r.ms / 1000).toFixed(1) + 's)');
    if (r.state === 'FAIL' || r.state === 'ERROR') {
      console.log('--- 失败输出（尾部 24 行）---');
      console.log(tail(r.out));
      console.log('--- 结束 ---\n');
    } else if (r.state === 'SKIP' && it.conditional) {
      const line = r.out.split(/\r?\n/).find((l) => SKIP_MARKERS.some((re) => re.test(l))) || '';
      console.log('    SKIP 原因：' + it.conditional + (line ? ' ／脚本输出：' + line.trim() : ''));
    } else if (r.state === 'PASS' && r.subSkip) {
      const line = r.out.split(/\r?\n/).find((l) => SKIP_MARKERS.some((re) => re.test(l))) || '';
      console.log('    注：脚本内部子项跳过' + (line ? '（' + line.trim() + '）' : '') + ' —— 主检查已执行');
    }
  }

  const counts = { PASS: 0, FAIL: 0, SKIP: 0, ERROR: 0 };
  for (const r of results) counts[r.state]++;
  const totalMs = results.reduce((a, r) => a + r.ms, 0);

  console.log('\n=========== 汇总 ===========');
  console.log('PASS ' + counts.PASS + ' · FAIL ' + counts.FAIL + ' · SKIP ' + counts.SKIP + ' · ERROR ' + counts.ERROR + ' （共 ' + results.length + ' 项，' + (totalMs / 1000).toFixed(1) + 's）');
  if (counts.SKIP) {
    console.log('跳过项（缺前置，不算通过）：');
    for (const r of results.filter((x) => x.state === 'SKIP')) console.log('  - ' + label(r.item) + (r.item.conditional ? '：' + r.item.conditional : ''));
  }
  const bad = results.filter((r) => r.state === 'FAIL' || r.state === 'ERROR');
  if (bad.length) console.log('失败项：' + bad.map((r) => label(r.item)).join(', '));

  let ok = counts.FAIL === 0 && counts.ERROR === 0;
  if (STRICT && counts.SKIP > 0) ok = false;
  console.log(ok ? '✓ 回归通过' + (STRICT ? '（strict）' : '') : '✗ 回归未通过' + (STRICT && counts.SKIP && !counts.FAIL && !counts.ERROR ? '（strict：存在 SKIP）' : ''));
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('✗ regress 自身崩溃：' + ((e && e.stack) || e));
  process.exit(2);
});
