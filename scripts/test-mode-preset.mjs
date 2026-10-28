#!/usr/bin/env node
/**
 * 模式预设回归：「媒体创作」预设随画布包分发（cordis.patch.yml + skills.js + director-workshop）。
 *
 * 为什么需要它：预设并入画布包后，patch 是 profile 加载的第一入口——YAML 手误或
 * 重复挂载会让整个 profile 加载失败；skills.js 改名/搬目录会让「媒体创作」模式
 * 静默失去导演工作坊技能。这些都必须在门禁里拦住，而不是等装包后才发现。
 *
 * 断言：
 *   1  cordis.patch.yml 存在且含 preset-media-studio / media-studio-skills / order: 5
 *   2  patch 挂载画布插件行恰好 1 条（0 = 忘挂自身，≥2 = 路由冲突）；不挂 ArtCraft
 *   3  skills 提供者指向 @ninkch/dsh-infinite-canvas/skills（随包分发口径）
 *   4  patch 无旧包名 @ninkch/dsh-media-studio-preset 残留
 *   5  skills/director-workshop/SKILL.md frontmatter 合法（name/description）
 *   6  skills.js 可动态 import：name === 'media-studio-skills'、inject 含 'skills'
 *   7  skills.js 快照逻辑读得到本包 manifest（45 透镜/36 题材/15 影调当期数）
 * 运行：node scripts/test-mode-preset.mjs；退出码 0=通过 1=失败
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// ---------- 1) patch 结构 ----------
const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
ok(patch.charCodeAt(0) !== 0xFEFF, 'cordis.patch.yml 带 BOM');
ok(patch.includes('preset-media-studio'), 'patch 缺 preset-media-studio（媒体创作模式条目）');
ok(patch.includes("id: media-studio"), 'patch 缺 id: media-studio（模式 id）');
ok(patch.includes('order: 5'), 'patch 缺 order: 5（与内置预设排序错开）');
ok(patch.includes("id: media-studio-skills"), 'patch 缺 media-studio-skills（技能提供者条目）');
ok(patch.includes("name: '@ninkch/dsh-infinite-canvas/skills'"), 'patch 的 skills 提供者未指向 @ninkch/dsh-infinite-canvas/skills');

// ---------- 2) 挂载数量（防重复挂载 = 路由冲突） ----------
const canvasRows = (patch.match(/name: '@ninkch\/dsh-infinite-canvas'\s*$/gm) || []).length;
ok(canvasRows === 1, 'patch 画布插件行应为 1 条，实际 ' + canvasRows + '（0=忘挂自身，≥2=路由冲突）');
ok(!/name: '@ninkch\/dsh-artcraft'\s*$/m.test(patch), 'patch 不得挂载 @ninkch/dsh-artcraft（重复挂载）');

// ---------- 3) 旧包名清零 ----------
ok(!patch.includes('@ninkch/dsh-media-studio-preset'), 'patch 残留旧包名 @ninkch/dsh-media-studio-preset');

// ---------- 4) persona 关键节仍在（防合并时被截断） ----------
for (const k of ['开工前自检', '引导式创作', '端到端流水线', '导演工作纪律', '节点生命周期']) {
  ok(patch.includes(k), 'patch persona 缺关键节「' + k + '」');
}

// ---------- 5) director-workshop 技能 ----------
const skill = readFileSync(path.join(ROOT, 'skills', 'director-workshop', 'SKILL.md'), 'utf8');
ok(skill.charCodeAt(0) !== 0xFEFF, 'director-workshop/SKILL.md 带 BOM');
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);
ok(!!fm, 'director-workshop/SKILL.md 缺 frontmatter');
if (fm) {
  ok(/^name:\s*\S/m.test(fm[1]), 'director-workshop frontmatter 缺 name');
  ok(/^description:\s*\S/m.test(fm[1]), 'director-workshop frontmatter 缺 description');
}
ok(!skill.includes('@ninkch/dsh-media-studio-preset'), 'director-workshop 正文残留旧包名');
ok(skill.includes('canvas_list_skills'), 'director-workshop 正文缺 canvas_list_skills 探活口径');
ok(skill.includes('canvas_update_node'), 'director-workshop 缺 canvas_update_node 重生成链路（改提示词重生成，不许删节点重建）');

// ---------- 6) skills.js 可加载 ----------
const skillsJs = await import('file:///' + path.join(ROOT, 'skills.js').replace(/\\/g, '/'));
ok(skillsJs.name === 'media-studio-skills', "skills.js name 应为 media-studio-skills，实际 " + skillsJs.name);
ok(Array.isArray(skillsJs.inject) && skillsJs.inject.includes('skills'), "skills.js inject 缺 'skills'");

// provider.get() 合同：Host 的 validateDefinition 直接读返回值顶层字段。此前返回
// { summary, content }，Host 读 name 得 undefined → "loaded skill name must be a string"，
// 技能加载失败（0.19.7 测试机实证）。此断言保证返回形状永远符合合同。
{
  const providerMod = await import('file:///' + path.join(ROOT, 'skills.js').replace(/\\/g, '/'));
  const registered = [];
  providerMod.apply({ skills: { registerProvider: (fn) => registered.push(fn) } }, { includeLiveSnapshot: false });
  ok(registered.length === 1, 'skills.js apply 未注册 provider');
  const provider = registered[0]();
  const cands = await provider.list();
  ok(cands.length >= 1, 'provider.list() 返回空');
  for (const cand of cands) {
    const def = await provider.get(cand, {});
    for (const k of ['name', 'description', 'provider', 'source', 'content']) {
      ok(typeof def[k] === 'string' && def[k].length > 0, 'get() 返回缺 ' + k + ' 或非字符串（Host 合同违规）');
    }
    ok(def.invocation && typeof def.invocation === 'object', 'get() 返回缺 invocation');
    ok(def.name === 'director-workshop', 'get() name 应为 director-workshop，实际 ' + def.name);
  }
}

// ---------- 7) 当期清单快照可达（本包 manifest） ----------
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets', 'canvas-director', 'manifest.json'), 'utf8'));
ok(manifest.lenses.length === 45, 'manifest 透镜应为 45，实际 ' + manifest.lenses.length);
ok(manifest.genres.length === 36, 'manifest 题材应为 36，实际 ' + manifest.genres.length);
ok(manifest.looks.length === 15, 'manifest 影调应为 15，实际 ' + manifest.looks.length);
// skills.js 的自定位锚点必须命中本包（fsSync.existsSync 由 import 校验过的实现提供）
const src = readFileSync(path.join(ROOT, 'skills.js'), 'utf8');
ok(src.includes("path.join(HERE, 'assets', 'canvas-director', 'manifest.json')"), 'skills.js 缺本包自定位锚点（快照将读不到清单）');

// ---------- 输出 ----------
if (errs.length) {
  console.error('✗ 模式预设回归未通过（' + errs.length + '）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 模式预设回归通过：patch 结构/挂载数量/旧包名清零/persona 完整性 + 工作坊技能 frontmatter + skills.js 可加载 + 当期清单快照可达');
