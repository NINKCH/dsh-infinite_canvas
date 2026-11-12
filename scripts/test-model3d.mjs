#!/usr/bin/env node
/**
 * 精细 3D 资产 Host 契约（dev-only）：用假 Meshy 网关跑完整
 * preview → refine → rigging → text-to-motion → animation → 下载 → 入库 流程。
 * 不访问外网、不消耗 Meshy 额度。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-model3d-'));
const DATA = path.join(SANDBOX, 'data');
fs.mkdirSync(DATA, { recursive: true });
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');
fs.writeFileSync(process.env.DSH_IC_CONFIG_PATH, JSON.stringify({ dataRoot: DATA }), 'utf8');

const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const calls = [];
const glb = Buffer.from('glTF' + '0'.repeat(28));
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String((opts && opts.method) || 'GET').toUpperCase();
  calls.push(method + ' ' + u);
  if (u === 'https://mock.meshy/glb' || u === 'https://mock.meshy/anim') return new Response(glb, { status: 200 });
  if (u.endsWith('/openapi/v2/text-to-3d') && method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    return json({ result: body.mode === 'refine' ? 'refine1' : 'preview1' });
  }
  if (u.endsWith('/openapi/v2/text-to-3d/preview1')) return json({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://mock.meshy/glb' } });
  if (u.endsWith('/openapi/v2/text-to-3d/refine1')) return json({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://mock.meshy/glb' } });
  if (u.endsWith('/openapi/v1/rigging') && method === 'POST') return json({ result: 'rig1' });
  if (u.endsWith('/openapi/v1/rigging/rig1')) return json({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://mock.meshy/glb' } });
  if (u.endsWith('/openapi/v1/text-to-motion') && method === 'POST') return json({ result: 'motion1' });
  if (u.endsWith('/openapi/v1/text-to-motion/motion1')) return json({ status: 'SUCCEEDED', progress: 100 });
  if (u.endsWith('/openapi/v1/animations') && method === 'POST') return json({ result: 'anim1' });
  if (u.endsWith('/openapi/v1/animations/anim1')) return json({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://mock.meshy/anim' } });
  return new Response('not found: ' + u, { status: 404 });
};

const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get() { return undefined; },
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
mod.apply(fakeCtx);
const rpc = mod._internals.rpcMethods();
const proj = mod._internals.canvasCreateProject({ name: '3D 资产测试' });
ok(proj && proj.ok, '创建测试项目失败');

const args = {
  projectId: proj.projectId, provider: 'meshy', apiKey: 'msy_test', baseUrl: 'https://mock.meshy',
  prompt: 'a detailed detective in a trench coat', name: '侦探', rig: true, animationPrompt: 'draw gun and turn', duration: 4,
};
const start = await rpc.model3dStart(args);
ok(start && start.ok && start.jobId, 'model3dStart 失败');
let st = null;
for (let i = 0; i < 20; i++) {
  st = await rpc.model3dStatus({ jobId: start.jobId });
  if (!st || st.status === 'SUCCEEDED' || st.status === 'FAILED') break;
}
ok(st && st.ok && st.status === 'SUCCEEDED' && st.assetId, '完整 Meshy 流水线未成功：' + JSON.stringify(st));
ok(calls.some((x) => x.includes('/openapi/v1/rigging')) && calls.some((x) => x.includes('/openapi/v1/text-to-motion')) && calls.some((x) => x.includes('/openapi/v1/animations')), '未走自动绑定/动作/动画流水线');
const asset = await mod._internals.dbAssetsGet([st.assetId]);
const rec = Array.isArray(asset) ? asset[0] : (asset && asset.items && asset.items[0]);
ok(rec && rec.kind === 'model' && rec.mime === 'model/gltf-binary', '模型资产未入库');
const dir = await rpc.projectDirGet({ projectId: proj.projectId });
const abs = path.join(dir.abs, 'model');
const files = fs.existsSync(abs) ? fs.readdirSync(abs) : [];
ok(files.some((f) => f.endsWith('.glb')), 'GLB 未写到项目 model 目录');

if (errs.length) {
  console.error('✗ 3D 资产流水线测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 3D 资产流水线通过（preview→refine→rig→motion→animate→GLB 入库）');
process.exit(0);
