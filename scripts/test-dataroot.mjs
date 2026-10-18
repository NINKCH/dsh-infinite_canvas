#!/usr/bin/env node
/**
 * v1 文件层回归测试（JSON 降级模式仍在线运行的代码）：
 *  0.18 起主存储 = canvas.db（见 test-db.mjs）；本文件只测仍被复用的文件层机械：
 *  1) 数据目录清单（canvas.meta.json）：文件夹按项目名 + 非法字符清洗 + 改名跟随
 *  2) 逻辑路径（pid）→ 物理路径（项目名文件夹）映射（physicalRel）
 *  3) 旧 pid 布局迁移（dataRootMigrate：文件搬移 + 旧目录清理）
 *  4) 资产元数据索引文件（writeAssetIndex upsert / 整表替换 / 删除）
 *  5) project.json 镜像（mirrorProjectToDataRoot）与一键导入扫描（dataRootImport）
 *
 * 运行：node scripts/test-dataroot.mjs；退出码 0=通过 1=失败
 * 注意：直接写 config.json 提供 dataRoot（不走 setDataRoot，避免触发 SQLite 挂载）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-dataroot-'));
const DATA = path.join(SANDBOX, 'data');
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
const CONFIG = path.join(SANDBOX, 'config.json');
process.env.DSH_IC_CONFIG_PATH = CONFIG;

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const I = mod._internals;
mod.apply({
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
});

// 0) 直接写 config 提供 dataRoot（v1 文件层只读配置，不触碰 SQLite）
fs.writeFileSync(CONFIG, JSON.stringify({ dataRoot: path.resolve(DATA) }), 'utf8');
ok(I.dataRoot() === path.resolve(DATA), 'dataRoot() 未从配置读出目录');

// 1) 清单 + 文件夹按项目名（通过 mirrorProjectToDataRoot 走 ensureProjectFolder）
const doc1 = { id: 'p_v1a', name: '时光邮局', createdAt: 1, updatedAt: 2, nodes: { n1: { id: 'n1', type: 'text', data: { text: 'x' } } }, edges: [] };
I.mirrorProjectToDataRoot(doc1.id, doc1);
ok(fs.existsSync(path.join(DATA, 'projects', '时光邮局', 'project.json')), 'project.json 未镜像到数据目录（按项目名）');
const meta = I.readDataRootMeta();
const entry = meta.projects.find((x) => x.id === doc1.id);
ok(!!entry && entry.folder === '时光邮局', 'canvas.meta.json 缺少项目映射或文件夹名不是项目名');

// 2) 逻辑路径 → 物理路径映射
ok(I.physicalRel(`projects/${doc1.id}/image/x.png`) === 'projects/时光邮局/image/x.png', 'physicalRel 未把 pid 映射为项目名文件夹');
ok(I.physicalRel('projects/未知pid/image/x.png') === 'projects/未知pid/image/x.png', 'physicalRel 对未知 pid 应原样返回');
ok(I.physicalRel('other/x.png') === null, 'physicalRel 对非 projects 路径应返回 null');

// 3) 非法字符清洗 + 改名跟随
const doc2 = { id: 'p_v1b', name: '测试/项目:*名', createdAt: 1, updatedAt: 2, nodes: {}, edges: [] };
I.mirrorProjectToDataRoot(doc2.id, doc2);
const meta2 = I.readDataRootMeta();
const e2 = meta2.projects.find((x) => x.id === doc2.id);
ok(!!e2 && !/[\\/:*?"<>|]/.test(e2.folder), '非法字符未从文件夹名清洗');
I.mirrorProjectToDataRoot(doc1.id, { ...doc1, name: '时光邮局·第二版' });
ok(!fs.existsSync(path.join(DATA, 'projects', '时光邮局')) && fs.existsSync(path.join(DATA, 'projects', '时光邮局·第二版')), '项目改名后物理文件夹未跟随重命名');

// 3.5) 本机项目文件（dataRootMigrate 只迁移 ~/.dsh 里存在的项目）
fs.mkdirSync(process.env.DSH_IC_PROJECTS_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.DSH_IC_PROJECTS_DIR, doc1.id + '.json'), JSON.stringify({ ...doc1, name: '时光邮局·第二版' }), 'utf8');

// 4) 旧 pid 布局迁移：手动造 projects/<pid>/image/old.png → dataRootMigrate 搬到项目名文件夹
const oldDir = path.join(DATA, 'projects', doc1.id, 'image');
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'old.png'), 'PNGDATA');
const mig = I.dataRootMigrate();
ok(mig.ok && mig.filesMoved >= 1, 'dataRootMigrate 未搬移旧布局文件');
ok(fs.existsSync(path.join(DATA, 'projects', '时光邮局·第二版', 'image', 'old.png')), '迁移后文件不在项目名文件夹');
ok(!fs.existsSync(path.join(DATA, 'projects', doc1.id)), '迁移后旧 pid 文件夹未清理');

// 5) 资产元数据索引文件
const idx = I.writeAssetIndex(doc1.id, '时光邮局·第二版', [
  { id: 'a_img1', kind: 'image', name: '角色-陈拾 多视图', rel: `projects/${doc1.id}/image/a.png`, category: 'character' },
  { id: 'a_txt1', kind: 'text', name: '分镜表', rel: `projects/${doc1.id}/text/b.md`, text: '【镜1】3s', category: 'storyboard' },
]);
ok(idx.ok, 'writeAssetIndex 失败');
const assetsJson = JSON.parse(fs.readFileSync(path.join(DATA, 'projects', '时光邮局·第二版', 'assets.json'), 'utf8'));
ok(assetsJson.length === 2 && assetsJson.some((x) => x.id === 'a_txt1' && x.text === '【镜1】3s'), 'assets.json 未正确写入（含文本资产）');

const rm1 = I.removeAssetIndexEntry(doc1.id, '时光邮局·第二版', 'a_img1');
ok(rm1.ok && rm1.removed === true, 'removeAssetIndexEntry 未删除索引条目');
const rm2 = I.removeAssetIndexEntry(doc1.id, '时光邮局·第二版', '不存在的id');
ok(rm2.ok && rm2.removed === false, '删除不存在的索引条目应幂等');
const assetsJson2 = JSON.parse(fs.readFileSync(path.join(DATA, 'projects', '时光邮局·第二版', 'assets.json'), 'utf8'));
ok(assetsJson2.length === 1 && assetsJson2[0].id === 'a_txt1', '索引删除后 assets.json 未保持一致');

// 整表替换语义（JSON 降级模式仍是启动同步路径）：子集替换清幽灵
I.writeAssetIndex(doc1.id, '时光邮局·第二版', [
  { id: 'a_txt1', kind: 'text', name: '第一节分镜表', rel: `projects/${doc1.id}/text/b.md`, text: '【镜1】3s', category: 'storyboard' },
], { replace: true });
const assetsJson3 = JSON.parse(fs.readFileSync(path.join(DATA, 'projects', '时光邮局·第二版', 'assets.json'), 'utf8'));
ok(assetsJson3.length === 1 && assetsJson3[0].id === 'a_txt1', '整表替换后仍残留幽灵条目');

// 6) 一键导入（文件扫描）：本机缺失的项目从 project.json 恢复
const localFile = path.join(process.env.DSH_IC_PROJECTS_DIR, doc1.id + '.json');
const localDoc = JSON.parse(fs.readFileSync(localFile, 'utf8'));
I.mirrorProjectToDataRoot(doc1.id, { ...localDoc, name: '时光邮局·第二版' });
const imp = I.dataRootImport();
ok(imp.ok && imp.assets && Array.isArray(imp.assets[doc1.id]) && imp.assets[doc1.id].some((a) => a.id === 'a_txt1'), '一键导入未扫出资产索引');

try { fs.rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 中文目录偶发 EPERM，清理失败不影响结论 */ }
if (errs.length) {
  console.error('✗ v1 文件层回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ v1 文件层回归测试通过（清单/项目名文件夹/physicalRel/旧布局迁移/索引文件/导入扫描）');
process.exit(0);
