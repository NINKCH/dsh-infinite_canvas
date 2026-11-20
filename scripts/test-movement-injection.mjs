#!/usr/bin/env node
/**
 * 移动语义「注入链路」回归（P2）：
 *   ① 画布自生成：aiStoryboardShots 必须按场检测并把移动契约块拼进 system
 *   ② 对话侧：canvas_skill_pack(kind:'storyboard', sceneText) 命中时注入 movement-rhythm
 *   ③ 数据层：高武异能题材卡 + 移动卡 + manifest 注册存在且 fx_motion 开启
 *   ④ 硬规则让位：canvas-craft / camera-moves / FX 速度铁律必须给连续位移留例外
 *
 * 运行：node scripts/test-movement-injection.mjs
 * 退出码：0 = 通过；1 = 失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const src = read('client.js');
const packSrc = read('skill-pack.js');
const craft = read('assets/canvas-craft/SKILL.md');
const cameraMoves = read('assets/canvas-director/moves/camera-moves.md');
const manifest = JSON.parse(read('assets/canvas-director/manifest.json'));

// ---------------- ① 画布自生成链路 ----------------
{
  const start = src.indexOf('async function aiStoryboardShots');
  const end = src.indexOf('\n    async function ', start + 10);
  const body = src.slice(start, end > 0 ? end : src.length);
  ok(start > 0, '未能定位 aiStoryboardShots');
  ok(/detectMovementScene\(scriptText/.test(body), 'aiStoryboardShots 未按场检测移动/追逐');
  ok(/movementContractAddendum\(zh\)/.test(body), 'aiStoryboardShots 未把移动契约块拼进 system');
  ok(/movement\.hit/.test(body), 'aiStoryboardShots 未按 movement.hit 条件注入');
  ok(/timeBeats/.test(body), 'aiStoryboardShots 契约块缺 timeBeats 语义');
}

// ---------------- ② 对话侧 Host 切片 ----------------
{
  ok(/detectMovementScene/.test(packSrc), 'skill-pack.js 未接入 detectMovementScene');
  ok(/movement-rhythm/.test(packSrc), 'skill-pack.js 未定义 movement-rhythm 注入');
  const { buildSkillPack } = await import(pathToFileURL(path.join(ROOT, 'skill-pack.js')).href);
  const scene = '【场1】山门石阶（夜）\n@陈拾@ 一步跨过三级石阶，脚尖在栏杆上一点，翻上屋脊；@怪物@ 贴着墙面奔行，随后蹬墙扑下。';
  const profile = { lens: 'tsui_hark', genres: ['high-martial'], form: 'cinematic', look: '', genreMode: 'auto' };
  const on = await buildSkillPack({ kind: 'storyboard', profile, hereDir: ROOT, zh: true, sceneText: scene, combatMode: 'auto', movementMode: 'auto' });
  ok(on.used.some((x) => x.id === 'movement-rhythm'), '命中移动场时未注入 movement-rhythm（used=' + JSON.stringify(on.used.map((x) => x.id)) + '）');
  ok(on.text.includes('移动/追逐'), '注入文本缺移动/追逐契约标题');
  ok(on.text.includes('3–5 阶'), '注入文本缺台阶 3–5 阶规则');
  // 用户实际配置（王晶 + 高武异能）也必须拿到移动卡：不能被透镜的 motion_budget 吞掉。
  const wong = await buildSkillPack({ kind: 'storyboard', profile: { ...profile, lens: 'wong_jing' }, hereDir: ROOT, zh: true, sceneText: scene, combatMode: 'auto', movementMode: 'auto' });
  ok(wong.used.some((x) => x.id === 'movement-rhythm'), 'wong_jing + 高武异能时未注入 movement-rhythm（透镜运动预算吞掉了移动卡）');
  const off = await buildSkillPack({ kind: 'storyboard', profile, hereDir: ROOT, zh: true, sceneText: scene, combatMode: 'auto', movementMode: 'off' });
  ok(!off.used.some((x) => x.id === 'movement-rhythm'), 'movementMode=off 仍注入 movement-rhythm');
  const calm = await buildSkillPack({ kind: 'storyboard', profile, hereDir: ROOT, zh: true, sceneText: '两人对坐喝茶，谈起旧事。', combatMode: 'auto', movementMode: 'auto' });
  ok(!calm.used.some((x) => x.id === 'movement-rhythm'), '无移动场仍注入 movement-rhythm');
}

// ---------------- ③ 数据层 ----------------
{
  const genre = manifest.genres.find((x) => x.id === 'high-martial');
  ok(!!genre, 'manifest.genres 缺 high-martial（高武异能）');
  ok(genre && genre.file === 'high-martial.md', 'high-martial 的 file 不是 high-martial.md');
  const genreMd = read('assets/canvas-director/genres/high-martial.md');
  ok(/fx_motion:\s*true/.test(genreMd), '高武异能卡未开启 fx_motion');
  ok(/轻功/.test(genreMd), '高武异能卡未把轻功写成默认移动');
  ok(/飞檐走壁|墙跑|墙面/.test(genreMd), '高武异能卡缺墙跑/飞檐走壁');
  const move = (manifest.moves || []).find((x) => x.id === 'movement-rhythm');
  ok(!!move, 'manifest.moves 缺 movement-rhythm');
  const moveMd = read('assets/canvas-director/moves/movement-rhythm.md');
  ok(/接触点/.test(moveMd), '移动卡缺接触点规则');
  ok(/3–5 阶/.test(moveMd), '移动卡缺台阶 3–5 阶');
  ok(/禁止镜内高速位移/.test(moveMd) === false, '移动卡不应沿用「禁止镜内高速位移」');
}

// ---------------- ④ 硬规则让位 ----------------
{
  ok(/连续位移/.test(craft), 'canvas-craft 未给连续位移留例外');
  ok(/接触点/.test(craft), 'canvas-craft 未写明拆镜只拆接触点');
  ok(/连续位移镜允许 2–5s/.test(craft), 'canvas-craft 未写明连续位移 2–5s');
  ok(/连续位移/.test(cameraMoves), 'camera-moves 未给连续位移留例外');
  const speedZh = src.includes('连续位移（轻功/飞行/攀爬/墙跑）必须镜内完成');
  const speedEn = src.includes('continuous traversal (qinggong/flight/climb/wall-run) must happen inside the shot');
  ok(speedZh && speedEn, 'FX 速度铁律未区分「瞬时事件」与「连续位移」');
}

// ---------------- ⑤ 工具/节点接线 ----------------
{
  const hostSrc = read('index.js');
  ok(/movementMode/.test(hostSrc), 'canvas_skill_pack / canvas_update_node 未暴露 movementMode');
  ok(/args\.sceneText !== undefined/.test(hostSrc), 'sceneText 单独传入时未转发（自然调用静默无效）');
  ok(/kind === 'storyboard' \|\| kind === 'prompt'/.test(hostSrc), 'kind=prompt 时 sceneText/movementMode 未生效');
  ok(/movementMode: String\(n\.data\.movementMode/.test(src), 'runGenNode 未把节点的 movementMode 传给 aiStoryboardShots');
  ok(/动作\/异能\/奇观场至少 3 镜要有 vfx/.test(src), 'jsonContract 的 vfx 必填未限定到动作/异能场（纯对话场仍被强制加光效）');
}

if (errs.length) {
  console.error('✗ 移动语义注入链路测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 移动语义注入链路通过（画布 / Host / 数据层 / 硬规则让位）');
