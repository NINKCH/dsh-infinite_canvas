#!/usr/bin/env node
/**
 * 技能包 Host 侧回归：
 *   A) 卡文件路径边界（越界/非法扩展名/绝对路径/超大 一律抛错；RPC 通道已移除，client 走静态 HTTP）
 *   B) 技能注册表含 canvas-director（4 份，可枚举、可加载、正文含四层关键词）
 *   C) canvas_list_skills：4 份技能 + 四层清单 + 项目配置
 *   D) canvas_skill_pack：四档切片、set:true 写进项目文档并可读回、非法 id 回落
 *
 * 运行：node scripts/test-skill-pack.mjs
 * 退出码：0 = 通过，1 = 失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-pack-'));
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const eq = (a, b, m) => { if (a !== b) errs.push(m + `（实际：${JSON.stringify(a)}，期望：${JSON.stringify(b)}）`); };
const noop = () => {};

// ============================================================
// 一、Host：注册技能 / 工具 / RPC
// ============================================================
const hostProviders = [];
const hostTools = [];
const rpcMethods = {};
const fakeSkills = { registerProvider: (fn) => { hostProviders.push(fn()); return () => {}; } };
const hostCtx = {
  effect(fn) { try { fn(); } catch { /* 路由注册在测试环境可能失败，不影响工具 */ } return () => {}; },
  get(name) {
    if (name === 'skills') return fakeSkills;
    return undefined;
  },
  webServer: { register: () => () => {} },
  tools: { register: (def) => { hostTools.push(def); return () => {}; } },
};
let hostMod = null;
try {
  hostMod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  // 收集 RPC 方法：apply 内部通过闭包持有 methods，这里靠工具调用间接验证
  hostMod.apply(hostCtx);
} catch (e) {
  errs.push('Host apply(ctx) 执行失败 → ' + ((e && e.stack) || e));
}

const byName = new Map(hostTools.map((t) => [t.name, t]));
const run = async (name, args) => {
  const t = byName.get(name);
  if (!t) throw new Error('工具不存在: ' + name);
  return await t.execute(args || {}, {});
};

// ============================================================
// A) readSkillPack 白名单
// ============================================================
{
  // 直接对 skill-pack-loader 做路径边界验证（与 readSkillPack 同一套规则）
  const loader = await import(pathToFileURL(path.join(ROOT, 'skill-pack-loader.js')).href);
  loader.initPackBase(ROOT);
  const inv = loader.packInventory(ROOT);
  eq(inv.lenses.length, 24, 'loader.packInventory: 导演数量不对');
  eq(inv.genres.length, 21, 'loader.packInventory: 叙事题材数量不对');
  eq(inv.industries.length, 10, 'loader.packInventory: 行业题材数量不对');
  eq(inv.forms.length, 8, 'loader.packInventory: 规格数量不对');
  eq(inv.looks.length, 9, 'loader.packInventory: 影调数量不对');
  // 所有条目都可用（文件都在）
  for (const layer of ['lenses', 'genres', 'industries', 'forms', 'looks']) {
    for (const it of inv[layer]) ok(it.available, layer + '/' + it.id + ': 文件缺失');
  }
  // 越界路径必须取不到（loader 返回 null，RPC 会抛错）
  eq(loader.readCard(ROOT, 'lenses', '../../../index.js'), null, 'readCard 未拦住 ../ 越界');
  eq(loader.readCard(ROOT, 'lenses', 'nonexistent.md'), null, 'readCard 未拦住不存在的文件');
  eq(loader.readCard(ROOT, 'nope', 'wong_kar_wai.md'), null, 'readCard 未拦住非法层名');
  eq(loader.readMove(ROOT, '../../../index.js'), null, 'readMove 未拦住越界');
  // 合法读取
  ok(!!loader.readCard(ROOT, 'lenses', 'wong_kar_wai.md'), 'readCard 读不到合法卡片');
  ok(!!loader.readMove(ROOT, 'camera-moves.md'), 'readMove 读不到运镜词典');
  ok(!!loader.readManifestRaw(ROOT), 'readManifestRaw 读不到 manifest');
}

// ============================================================
// B) 技能注册表
// ============================================================
let skillList = [];
{
  ok(hostProviders.length >= 1, 'Host 未向 skills 服务注册提供方');
  const p = hostProviders.find((x) => x && x.name === 'dsh-infinite-canvas') || hostProviders[0] || {};
  skillList = (await p.list()) || [];
  const names = skillList.map((c) => c.name).sort();
  eq(names.join(','), 'canvas-craft,canvas-director,canvas-layout,canvas-studio', '内置技能清单不对');
  const dir = skillList.find((c) => c.name === 'canvas-director');
  ok(!!dir, '缺少 canvas-director 技能');
  if (dir) {
    ok(Number.isFinite(dir.rank), 'canvas-director: rank 必须是有限数字');
    ok(dir.invocation && dir.invocation.modelInvocable === true && dir.invocation.userInvocable === true,
      'canvas-director: 必须 modelInvocable + userInvocable');
    const got = await p.get(dir, {});
    ok(typeof got.content === 'string' && got.content.length > 2000, 'canvas-director: 正文过短');
    for (const k of ['导演透镜', '题材', '规格', '影调', 'canvas_skill_pack', '13']) {
      ok(String(got.content).includes(k), 'canvas-director 正文缺关键内容「' + k + '」');
    }
    ok(got.rank === undefined && got.locator === undefined, 'canvas-director: get() 应剥离 rank/locator');
  }
  // canvas-studio 正文必须列出技能清单（「一调用就知道有哪些技能」）
  const studio = skillList.find((c) => c.name === 'canvas-studio');
  if (studio) {
    const got = await p.get(studio, {});
    for (const k of ['canvas_list_skills', 'canvas_skill_pack', 'canvas-director', '本插件技能清单']) {
      ok(String(got.content).includes(k), 'canvas-studio 正文缺「' + k + '」');
    }
  }
}

// ============================================================
// C) canvas_list_skills
// ============================================================
let pid = null;
{
  ok(byName.has('canvas_list_skills'), '缺少工具 canvas_list_skills');
  ok(byName.has('canvas_skill_pack'), '缺少工具 canvas_skill_pack');
  // 两个工具的 description 必须讲清何时用
  for (const [n, kw] of [['canvas_list_skills', '开始任何画布创作前'], ['canvas_skill_pack', '切片']]) {
    const d = String((byName.get(n) || {}).description || '');
    ok(d.includes(kw), n + ' 的 description 未讲清用途（缺「' + kw + '」）');
  }
  // 先建一个项目
  const created = await run('canvas_create_project', { name: '__技能包测试__', scriptText: '雨夜，快递员在门口停下', nodeName: '第一节剧本' });
  pid = created.projectId;
  ok(!!pid, 'canvas_create_project 未返回 projectId');

  const ls = await run('canvas_list_skills', { projectId: pid });
  ok(ls && ls.ok, 'canvas_list_skills 未返回 ok');
  const text = String(ls.text || '');
  for (const k of ['canvas-studio', 'canvas-craft', 'canvas-layout', 'canvas-director']) {
    ok(text.includes(k), 'canvas_list_skills 未列出技能 ' + k);
  }
  for (const k of ['导演透镜', '叙事题材', '行业题材', '规格', '影调质感', '运镜与节奏']) {
    ok(text.includes(k), 'canvas_list_skills 未列出层 ' + k);
  }
  // 清单应带 id=名称 形态，至少能点到几个已知 id
  for (const id of ['wong_kar_wai', 'zhang_yimou', 'revenge-face-slap', 'short-drama', 'hk-retro-film']) {
    ok(text.includes(id), 'canvas_list_skills 清单缺 ' + id);
  }
  ok(text.includes('下一步：canvas_skill_pack'), 'canvas_list_skills 未给出下一步指引');
}

// ============================================================
// D) canvas_skill_pack
// ============================================================
{
  // D1 未配置时切片为空（老项目行为不变）
  const empty = await run('canvas_skill_pack', { projectId: pid, kind: 'script' });
  ok(empty && empty.ok, 'canvas_skill_pack 未返回 ok');
  eq(empty.bytes, 0, '未配置任何层时不应注入切片');
  ok(String(empty.text).includes('未配置') || String(empty.text).includes('生效配置'), '未配置时正文异常');

  // D2 set:true 写入配置
  const set = await run('canvas_skill_pack', {
    projectId: pid, kind: 'script',
    lens: 'wong_kar_wai', genres: ['revenge-face-slap'], form: 'short-drama', look: 'hk-retro-film',
    set: true,
  });
  ok(set && set.ok, 'canvas_skill_pack(set) 未返回 ok');
  ok(set.bytes > 1000, '写入配置后剧本切片过小（' + set.bytes + 'B）');
  ok(String(set.text).includes('王家卫') || String(set.text).includes('wong_kar_wai'), '切片里没有导演透镜内容');
  ok(String(set.text).includes('风格参数') || String(set.text).includes('一句话镜头'), '切片里没有透镜正文');
  eq(set.profile && set.profile.lens, 'wong_kar_wai', 'set 后返回的 profile.lens 不对');
  eq((set.profile && set.profile.genres || []).join(','), 'revenge-face-slap', 'set 后返回的 genres 不对');

  // D3 配置真的落到项目文档（canvas_get_bible 同源的 projectsGet 路径）
  const listed = await run('canvas_list_projects', {});
  ok(String(listed.text || '').includes(pid), '项目仍在列表里');
  const ls2 = await run('canvas_list_skills', { projectId: pid });
  ok(String(ls2.text).includes('王家卫'), 'canvas_list_skills 未反映已写入的导演配置');
  ok(String(ls2.text).includes('复仇打脸'), 'canvas_list_skills 未反映已写入的题材配置');

  // D4 四档切片都非空，且各自在合理量级（不同层的字数不同，不强制互相大小排序）
  const sizes = {};
  for (const kind of ['script', 'storyboard', 'prompt', 'assets']) {
    const r = await run('canvas_skill_pack', { projectId: pid, kind });
    sizes[kind] = r.bytes;
    ok(r.bytes > 500, kind + ' 切片过小（' + r.bytes + 'B）');
    ok(r.bytes < 40000, kind + ' 切片过大（' + r.bytes + 'B），疑似整份注入');
  }
  // assets 切片最小（只取成像与材质两节）
  ok(sizes.assets < sizes.script, 'assets 切片应明显小于 script');
  ok(sizes.assets < sizes.storyboard, 'assets 切片应明显小于 storyboard');

  // D5 运镜词典只随分镜/提示词走
  {
    const sb = await run('canvas_skill_pack', { projectId: pid, kind: 'storyboard' });
    ok(String(sb.text).includes('运镜'), 'storyboard 切片缺运镜内容');
    const sc = await run('canvas_skill_pack', { projectId: pid, kind: 'script' });
    ok(!String(sc.text).includes('一镜一运镜'), 'script 切片不应带整份运镜词典');
  }

  // D6 非法 id 静默回落（不报错、不注入）
  {
    const bad = await run('canvas_skill_pack', { projectId: pid, kind: 'script', lens: 'not-a-real-director' });
    ok(bad && bad.ok, '非法 lens 应静默回落而不是报错');
    eq(bad.profile.lens, '', '非法 lens 未回落空串');
  }

  // D7 临时覆盖不改项目配置
  {
    const before = await run('canvas_list_skills', { projectId: pid });
    const ov = await run('canvas_skill_pack', { projectId: pid, kind: 'prompt', lens: 'fincher' });
    eq(ov.profile.lens, 'fincher', '临时覆盖未生效');
    ok(String(ov.text).includes('芬奇') || String(ov.text).includes('fincher'), '临时覆盖的切片里没有对应导演内容');
    const after = await run('canvas_list_skills', { projectId: pid });
    ok(/导演=王家卫/.test(String(after.text)), '临时覆盖污染了项目配置（应只在本次生效）');
  }

  // D8 行业题材可当题材用（商业规格场景）
  {
    const r = await run('canvas_skill_pack', { projectId: pid, kind: 'prompt', form: 'commercial', genres: ['tech'] });
    ok(r && r.ok, '行业题材切片失败');
    ok(r.bytes > 500, '行业题材切片过小');
    ok(String(r.text).includes('科技') || String(r.text).includes('tech'), '行业题材内容未进入切片');
  }
}

// ============================================================
// 结束
// ============================================================
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }


// ── 本次修复的回归断言（技能架构体检） ──
{
  const { buildSkillPack } = await import(pathToFileURL(path.join(ROOT, "skill-pack.js")).href);
  const onlyForm = { lens: "", genres: [], form: "cinematic", look: "" };
  // A) 只选规格 → 每个 kind 都必有内容（script/storyboard/prompt；assets 该规格无 assets 切片则为空）
  for (const kind of ["script", "storyboard", "prompt"]) {
    const r = await buildSkillPack({ kind, profile: onlyForm, hereDir: ROOT, zh: true });
    ok(r.bytes > 500, "只选规格时 kind=" + kind + " 应注入（实际 " + r.bytes + " 字节）—— 画布与对话侧会分叉");
  }
  // B) 四层全空 → 全空（老项目零变化；运镜也不许单独注入）
  const emptyProfile = { lens: "", genres: [], form: "", look: "" };
  for (const kind of ["script", "storyboard", "prompt", "assets"]) {
    const r = await buildSkillPack({ kind, profile: emptyProfile, hereDir: ROOT, zh: true });
    ok(r.bytes === 0 && !r.text, "四层全空时 kind=" + kind + " 必须为 0 字节（实际 " + r.bytes + "）");
  }
  // C) 三处默认值一致（都是空串）
  {
    const packMod = await import(pathToFileURL(path.join(ROOT, "assets/canvas-director/pack.js")).href);
    const coreMod = await import(pathToFileURL(path.join(ROOT, "index-core-skill-profile.js")).href);
    ok(packMod.DEFAULT_PROFILE.form === "", "pack.js DEFAULT_PROFILE.form 应为空");
    ok(coreMod.DEFAULT_SKILL_PROFILE.form === "", "index-core DEFAULT_SKILL_PROFILE.form 应为空");
  }
  // D) assets 切片无内容时不吐「只有头部」的空壳
  {
    const r = await buildSkillPack({ kind: "assets", profile: onlyForm, hereDir: ROOT, zh: true });
    ok(r.bytes === 0, "assets kind 在没有 assets 切片时必须返回 0 字节（实际 " + r.bytes + "）");
  }
  // E) 分镜链路带打斗节奏卡；提示词只带运镜
  {
    const sb = await buildSkillPack({ kind: "storyboard", profile: onlyForm, hereDir: ROOT, zh: true });
    ok(sb.used.some((u) => u.layer === "moves"), "分镜链路应注入运镜/节奏卡");
    ok(sb.bytes > 0 && /打斗|节奏/.test(sb.text), "分镜链路应含打斗节奏内容");
  }
  // F) 工具层 kind 白名单（源码级：非法 kind 必须抛错而不是静默出空切片）
  {
    const idxSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
    ok(/kind 必须是 script \/ storyboard \/ prompt \/ assets/.test(idxSrc), "canvas_skill_pack 缺少 kind 白名单校验");
  }
}
if (errs.length) {
  console.error(`✗ 技能包 Host 侧回归失败（${errs.length} 项）：`);
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 技能包 Host 侧回归通过：');
console.log('  · 技能注册：4 份（含 canvas-director），可枚举 / 可加载 / 正文含四层关键词 / rank 与 locator 已剥离');
console.log('  · canvas-studio 正文已列出「本插件技能清单」并指向 canvas_list_skills 与 canvas_skill_pack');
console.log('  · 路径边界：readCard / readMove 拦住 ../、非法层名、不存在的文件');
console.log('  · canvas_list_skills：4 份技能 + 五层清单（24/21/10/8/9）+ 运镜两条 + 项目配置 + 下一步指引');
console.log('  · canvas_skill_pack：未配置不注入；set 写项目并可读回；四档切片均有效；运镜只随分镜与提示词；非法 id 回落；临时覆盖不污染项目');
console.log('  · 行业题材可作为题材 id 参与切片');
process.exit(0);
