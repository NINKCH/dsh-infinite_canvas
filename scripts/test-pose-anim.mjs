// 正式回归：姿态过渡动画（poseAnim 相邻姿态帧之间平滑混合）
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'assets/director/engine.js')).href);
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

const packPath = path.join(ROOT, 'assets/director/models/xbot.json');
if (!fs.existsSync(packPath)) { console.error('缺模型包，跳过'); process.exit(0); }
const asset = E.decodeModelPack(JSON.parse(fs.readFileSync(packPath, 'utf8')));

// ① 混合权重语义
{
  const anim = [{ t: 0, poseId: 'arms_up' }, { t: 2, poseId: 'flip' }];
  const at = (t) => E.poseBlendAt(E.BONE_POSES, anim, t);
  ok(at(0).length === 1 && Math.abs(at(0)[0].w - 1) < 1e-6, 't=0 应 100% 取第一个姿态');
  ok(at(2).length === 1 && Math.abs(at(2)[0].w - 1) < 1e-6, 't=末 应 100% 取最后一个姿态');
  const mid = at(1);
  ok(mid.length === 2, 't=中点应返回两段姿态');
  ok(Math.abs(mid[0].w - 0.5) < 1e-6 && Math.abs(mid[1].w - 0.5) < 1e-6, 't=中点权重应为 0.5/0.5，实际 ' + mid.map((m) => m.w.toFixed(3)).join('/'));
  // 边界夹取
  ok(E.poseBlendAt(E.BONE_POSES, anim, -5)[0].w === 1, '负时间应夹到首帧');
  ok(E.poseBlendAt(E.BONE_POSES, anim, 99)[0].w === 1, '超时应在末帧');
  ok(E.poseBlendAt(E.BONE_POSES, [], 1) === null, '空动画应返回 null');
  const noneAt = E.poseBlendAt(E.BONE_POSES, [{ t: 0, poseId: 'none' }], 0);
  ok(noneAt && noneAt[0].dirs.length === 0, "'none' 应解析为空姿态（无方向约束）");
  ok(E.poseBlendAt(E.BONE_POSES, [{ t: 0, poseId: 'not_exist' }], 0) === null, '不存在的 poseId 应返回 null');
}

// ② 过渡必须是连续变化（无跳变）+ 端点与静态姿态一致
{
  const scene = {
    version: 2,
    objects: [{ id: 'm', kind: 'model', assetId: 'xbot', typeId: 'm_standard', pos: { x: 0, y: 0, z: 0 }, h: 1.78, clip: 'idle', animTime: 0, visible: true,
      poseAnim: [{ t: 0, poseId: 'arms_up' }, { t: 1.5, poseId: 'flip' }, { t: 3, poseId: 'crouch' }] }],
    cameras: [{ id: 'c', pos: { x: 0, y: 1.4, z: 3.6 }, target: { x: 0, y: 1, z: 0 }, fov: 40, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: 3 },
  };
  const heightAt = (t) => {
    const ob = E.applyPlayhead(scene, t).objects[0];
    const sk = E.skinModel(asset, ob.clip, ob.animTime, null, null, { poseBlend: ob.poseBlend || undefined });
    let minY = 1e9, maxY = -1e9;
    for (let i = 1; i < sk.pos.length; i += 3) { if (sk.pos[i] < minY) minY = sk.pos[i]; if (sk.pos[i] > maxY) maxY = sk.pos[i]; }
    return { h: maxY - minY, minY };
  };
  let prev = null, maxJump = 0, minJumpAll = Infinity;
  for (let t = 0; t <= 3.0001; t += 0.05) {
    const g = heightAt(t);
    if (prev !== null) maxJump = Math.max(maxJump, Math.abs(g.h - prev));
    prev = g.h;
  }
  ok(maxJump < 0.15, '过渡出现跳变（相邻 0.05s 高差 ' + maxJump.toFixed(3) + 'm）');
  // 端点一致性：t=0 与静态 arms_up；t=1.5 与静态 flip
  const h0 = heightAt(0).h;
  const skA = E.skinModel(asset, 'idle', 0, null, null, { poseId: 'arms_up' });
  let aMin = 1e9, aMax = -1e9;
  for (let i = 1; i < skA.pos.length; i += 3) { if (skA.pos[i] < aMin) aMin = skA.pos[i]; if (skA.pos[i] > aMax) aMax = skA.pos[i]; }
  ok(Math.abs(h0 - (aMax - aMin)) < 0.05, '动画起点应与静态 arms_up 一致');
  const h15 = heightAt(1.5).h;
  const skF = E.skinModel(asset, 'idle', 0, null, null, { poseId: 'flip' });
  let fMin = 1e9, fMax = -1e9;
  for (let i = 1; i < skF.pos.length; i += 3) { if (skF.pos[i] < fMin) fMin = skF.pos[i]; if (skF.pos[i] > fMax) fMax = skF.pos[i]; }
  ok(Math.abs(h15 - (fMax - fMin)) < 0.05, '中间关键帧应与静态 flip 一致');
  // 过渡中应真的出现"既不是起点也不是终点"的中间形态
  const midH = heightAt(0.75).h;
  ok(Math.abs(midH - h0) > 0.1 && Math.abs(midH - h15) > 0.1, '过渡中应有中间形态（实际 ' + midH.toFixed(2) + '）');
}

// ②b 自定义 poseAnim loop：超过循环周期后必须回到周期内的姿态，而不是停在尾帧
{
  const scene = {
    version: 2,
    objects: [{ id: 'loop', kind: 'model', assetId: 'xbot', pos: { x: 0, y: 0, z: 0 }, h: 1.78, clip: 'idle', visible: true,
      poseAnim: [{ t: 0, poseId: 'arms_up' }, { t: 2, poseId: 'flip' }], loop: true, poseLoop: 2 }],
    cameras: [{ id: 'c', pos: { x: 0, y: 1.4, z: 3.6 }, target: { x: 0, y: 1, z: 0 }, fov: 40, keys: [] }],
    lights: [], env: {}, activeCameraId: 'c', shot: { duration: 4 },
  };
  const at = (t) => E.applyPlayhead(scene, t).objects[0].poseBlend;
  const a = at(0.5);
  const b = at(2.5);
  ok(JSON.stringify(a) === JSON.stringify(b), 'poseAnim loop=2 时 t=2.5 应等价于 t=0.5');
}

// ③ UI 入口（预设动作片段已按用户要求移除；姿态关键帧在时间轴，面板只保留基础姿态+保存为动作）
{
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(cli.includes("'dir-pose-anim-add'") || cli.includes('dir-pose-key'), '缺少姿态关键帧入口（时间轴）');
  ok(cli.includes("'dir-action-save'"), '缺少「保存为动作」按钮');
  ok(cli.includes("'dir-pose-clear'"), '缺少「清除姿态」按钮');
  ok(!cli.includes("T('dirActionSeq')"), '预设动作片段 UI 应已移除');
  ok(/o2\.poseAnim = \[\]/.test(cli) || /poseAnim = \[\]; o2\.userActionId = null/.test(cli), '清除姿态必须同时清 poseAnim');
  ok(!cli.includes("T('directorPrompt')"), '右下角提示词框应已移除');
}

if (errs.length) {
  console.error('✗ 姿态过渡动画测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 姿态过渡动画测试通过（权重/端点夹取/连续无跳变/端点一致/中间形态/UI 入口/提示词框已移除）');
process.exit(0);
