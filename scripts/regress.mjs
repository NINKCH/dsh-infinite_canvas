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
  { name: 'test-canvas-perf.mjs', desc: '画布性能（poster 懒视频 / idbGet 顺序 / imperative 拖动 / memo）' },
  { name: 'test-download-ext.mjs', desc: 'IC-01 下载扩展名按容器判定' },
  { name: 'test-craft-base.mjs', desc: 'BLK-02 画布→ArtCraft base+path 契约' },
  { name: 'test-image-upload.mjs', desc: 'IC-04 参考图上传三件套（嗅探/原始尺寸/登记重试）' },
  { name: 'test-vendor-detect.mjs', desc: 'IC-03 视频厂商识别/前缀归一化/未知厂商降级' },
  { name: 'test-fts-reconcile.mjs', desc: 'IC-B4 FTS 存量孤儿清理（幂等/双向）' },
  { name: 'test-craft-cleanup.mjs', desc: 'IC-B2 删项目清 craft 后期目录（幂等/失败可见）' },
  { name: 'test-ext-mapping.mjs', desc: 'IC-B3 三套扩展名映射分工（单一职责/零混用）' },
  { name: 'test-empty-project.mjs', desc: 'OBS-UI-1 空态不建占位项目、不推送 Host、显式创建完好' },
  // --- 核心链路（历史事故区）---
  { name: 'test-compose.mjs', desc: '成片合成主循环（dur is not defined 事故的网兜）' },
  { name: 'test-tools.mjs', desc: '对话工具 schema 与返回值契约' },
  { name: 'test-skill-inject.mjs', desc: '内置专家人设硬规则 / 技能注入 Harness / 技能快捷键契约' },
  { name: 'test-mentions.mjs', desc: '@引用解析（设定集匹配 / [图N] 绑定 / 资产设定图提示词）' },
  { name: 'test-ref-ownership.mjs', desc: '参考图严格=连线 / 绑定弹窗分页拉全 / 设定文字注入视频提示词' },
  { name: 'test-segment-plan.mjs', desc: '按镜头切段：切点只在换场/特写/新角色 / 连续动作不拆 / 时长上限 / 强弱模型分流 / 提示词四件套' },
  { name: 'test-director-stage.mjs', desc: '3D 导演台：场景可序列化 / 相机投影 / 几何 / 真渲染 / 拾取 / 人偶→真人提示词 / 持久化兜底' },
  { name: 'test-director-structure.mjs', desc: '组件结构：无 TDZ 引用（定义前使用会白屏）/ hooks 顺序正确' },
  { name: 'test-playback-loop.mjs', desc: '动画循环：播放/暂停可控 / cleanup 取消 rAF / 真实时间推进' },
  { name: 'test-camera-math.mjs', desc: '镜头数学：radius→dist（Blender公式）/ 焦距FOV互反 / 8档景别精度 / 画幅比例 / sensor fit' },
  { name: 'test-camera-path.mjs', desc: '运动路径：Catmull-Rom 样条（BKE_where_on_path）/ 切线=运动方向 / FOLLOW 前瞻 / 折线曲线分离' },
  { name: 'test-auto-key.mjs', desc: 'auto-key：拖拽实时覆盖 / 松手在播放头补帧 / 插值不弹回（历史 bug：打关键帧后拖不动）' },
  { name: 'test-dirty-data.mjs', desc: '脏数据守卫：关键帧缺 pos / null 入参 / 导出分步报错（历史事故：导出视频 reading x）' },
  { name: 'test-shot-sequence.mjs', desc: '分镜串联：多镜头按时间切换相机（Sequencer Strip 模型）/ 增删 / 退化 / UI 入口' },
  { name: 'test-pose-keys.mjs', desc: '姿态关键帧：poseKeys 线性插值 / 多骨 / 骨骼增删过渡 / 轴约束 X-Y-Z 锁定' },
  { name: 'test-director-ux.mjs', desc: '导演台可用性：白模导出 / MP4优先 / 工作区文件往返 / 脏标记 / gizmo 轴超环+加粗+悬停' },
  { name: 'test-asset-migration.mjs', desc: '旧 IDB 资产一次性迁移：保留 id 落盘入库 / 清 IDB / 缺失分类 / 无数据根跳过 / 幂等并发 / 无 rel 显示兜底' },
  { name: 'test-director-panels.mjs', desc: '导演台 IK·约束·动作层面板：按钮入口 / 字段写回 / 引擎接线 / 中英 i18n / spec 往返' },
  { name: 'test-body-variants.mjs', desc: '体型变体：男性挂 Explorer 资产 + 形变幅度(storyai 量级) + 姿势库 41 条(awplanet 复刻 19) + 姿势选择器/引擎过期横幅' },
  { name: 'test-action-library.mjs', desc: '内置动作库：成熟动作 clip 可加载、真实播放、连续无跳变、覆盖内置片段' },
  { name: 'test-skill-panel.mjs', desc: '技能页：四层数据(45/36/10/8/15) + 切片反向断言 + 项目隔离 + 三页签零下拉 + 123 图标闭环 + 注入矩阵' },
  { name: 'test-skill-pack.mjs', desc: '技能包 Host 侧：readSkillPack 边界 / 4 份技能注册 / canvas_list_skills / canvas_skill_pack 四档切片' },
  { name: 'test-rig-map.mjs', desc: '通用人形骨架映射：xbot 100% / Mixamo·VRM·Blender·Daz ≥85% / 左右不串 / 非人形低覆盖' },
  { name: 'test-bvh.mjs', desc: 'Phase D 动捕接入：BVH 解析 / rest-delta 重定向 / 动作层 replace·add·loop·influence / 规格透传' },
  { name: 'test-ik.mjs', desc: 'Phase C 两骨解析 IK：命中/轴心/极向量/不可达 + damped_track + limit/copy rotation + 规格透传' },
  { name: 'test-dqs.mjs', desc: 'Phase B 双四元数蒙皮：不塌陷 / 矩阵一致 / xbot 参考实现一致 / 保形不劣于 LBS / 规格透传' },
  { name: 'test-director-anim.mjs', desc: 'Phase A 动画曲线：贝塞尔（Blender 基准）/自动切线/缓动表/四元数 slerp/poseKeys 四元数' },
  { name: 'test-thumbs.mjs', desc: '缩略图：512 派生图 / 节点只用缩略图 / 原图按需 / 缺失负缓存 / 无常驻合成层 / 滚轮非 passive' },
  { name: 'test-director-e2e.mjs', desc: '浏览器端到端：分镜机位切换/隐藏对象/动画循环/规格往返保真/提示词中英景别/UI入口齐备' },
  { name: 'test-director-preview.mjs', desc: '实时渲染预览=成片：颜色材质/地面·阴影·太阳开关/辅助线不入成片/确定性' },
  { name: 'test-director-gizmo.mjs', desc: 'gizmo 几何/拾取：轴长105px/三轴手柄同形/一次点中/远处容差/尺寸单一来源' },
  { name: 'test-director-fly.mjs', desc: '键盘漫游：W/S 前后、A/D 平移、Q/E 升降贴地、Shift 4×、斜向不加速、朝向不变、dt 钳制' },
  { name: 'test-gizmo-pixels.mjs', desc: 'gizmo 像素对齐（浏览器 DPR=2）：轴端颜色与拾取一致、手柄置顶' },
  { name: 'test-director-v2.mjs', desc: '导演台 v2：物体路径运动 / 机位增删 / 暂停不跳页 / gizmo≥1/3身高 / 白模地面光影 / 类型基础色 / 材质UI' },
  { name: 'test-pose-path.mjs', desc: '姿态刚性链（不碎模）/ 路径只拦左键不锁视角 / 地面点反算精确' },
  { name: 'test-render-pipeline.mjs', desc: '渲染管线：WebGL2 + shadow map（DEPTH_COMPONENT24/FBO/PCF 斜率bias+核半径）+ 路径锚定与成片隔离' },
  { name: 'test-pose-semantics.mjs', desc: '姿态语义：举双手过头/下蹲变矮/空翻团身悬空/飞行放平/出拳向前/格斗护面/动画叠加不走样' },
  { name: 'test-pose-anim.mjs', desc: '姿态过渡动画：poseAnim 权重/端点/连续无跳变/中间形态/UI 入口' },
  { name: 'test-pbr-tonemap.mjs', desc: 'PBR：Oren-Nayar 系数/GGX D·G1 公式与峰值/天空环境光/AgX 风格色调映射标定与单调性' },
  { name: 'test-render-pixels.mjs', desc: '像素级渲染验证（无头浏览器）：真阴影/墙面阴影/路径隔离/PBR粗糙度/色调映射/白模环境' },
  { name: 'test-video-record.mjs', desc: '视频导出端到端：真实 MediaRecorder 产出合法 webm + 画面非黑屏（无浏览器则 SKIP）' },
  { name: 'test-stage-spec.mjs', desc: 'AI 场景规格：spec→scene→spec 往返/分镜解析/路径转向/容错/循环动作/Host 工具与客户端接线' },
  { name: 'test-motion-brief-timeline.mjs', desc: '运动驱动（步频防滑步）/ 雾+景深进规格 / 一句话模板库（打斗·追逐·对话）/ 时间轴能力' },
  { name: 'test-cycle-path.mjs', desc: '循环动作（走/跑双相位闭环）+ 路径点拾取/反投影/UI 入口' },
  { name: 'test-theme-locale.mjs', desc: '深色主题跟随宿主 body[data-ds-dark-theme] / 深色变量与对比度 / 面板名中英双语 / locale 快照 active 字段' },
  { name: 'test-expand-assets.mjs', desc: '铺开到画布：缺资产→带设定图提示词的图片节点' },
  { name: 'test-node-merge.mjs', desc: '节点类型合并：旧文档迁移 / 连线与 data 不丢 / 幂等' },
  { name: 'test-node-actions.mjs', desc: '结果操作按钮统一在节点末尾左下角' },
  { name: 'test-node-layout.mjs', desc: '节点尺寸/画面比例、点击任意位置开面板、面板 520 nowrap' },
  { name: 'test-panel-layout.mjs', desc: '面板结构：返回图标/图标列居中/统一弹窗/项目名双击改名/右上角纯图标/多画布目录树' },
  { name: 'test-multi-canvas.mjs', desc: '多画布：默认画布零迁移 / 子画布独立文档 / 登记与 RPC / 工具 canvasId / 删项目清画布' },
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
  { name: 'test-mode-preset.mjs', desc: '媒体创作模式预设：patch 结构/挂载数量/旧包名清零/persona 完整性 + 工作坊技能 + skills.js 快照可达' },
  { name: 'test-image-field-retry.mjs', desc: '图片 API 字段校验型 400 自愈：识别函数口径（中英文 11 例+负例）+ generations 主路径已接入' },
  { name: 'test-addnode-column.mjs', desc: '建点布局强控制：一类型一列 / 碰撞下移 / 新类型起列 / 全图无重叠（nextNodePosClient + addNodeAt 收口）' },
];

const SKIP_MARKERS = [/跳过/, /\bSKIP\b/i, /缺前置/, /未找到.*canvas\.db/];
const CRASH_MARKERS = [/SyntaxError/, /ReferenceError/, /TypeError/, /RangeError/, /\n\s+at .+\(/, /EMPTY_RESPONSE/, /Cannot find module/];

// 浏览器类测试（真实 Chrome 启动）在并发/负载下偶发超时：失败后自动重试一次，避免误报const BROWSER_TESTS = new Set([  'test-render-pixels.mjs', 'test-video-record.mjs', 'test-director-e2e.mjs',]);async function runOneStable(item) {  const first = await runOne(item);  if (first.state === 'PASS') return first;  if (!BROWSER_TESTS.has(item.name)) return first;  const retry = await runOne(item);  if (retry.state === 'PASS') retry.out = '[retried once] ' + retry.out;  return retry;}function runOne(item) {
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
