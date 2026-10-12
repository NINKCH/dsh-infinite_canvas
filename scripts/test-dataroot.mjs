#!/usr/bin/env node
/**
 * 数据目录（可迁移数据包）回归测试：
 *  1) 设置数据根目录 → 项目文档镜像（project.json 含设定集/assetIds 绑定）+ canvas.meta.json 清单
 *  2) 文件夹按项目名（非法字符清洗）；改名 → 物理文件夹跟随重命名
 *  3) 逻辑路径（pid）→ 物理路径（项目名）映射（physicalRel）
 *  4) 旧 pid 布局迁移（dataRootMigrate：文件搬移 + 旧目录清理）
 *  5) 资产元数据索引（assetIndexPut → assets.json）
 *  6) 一键导入（本机较新跳过；本机缺失时从 project.json 恢复）
 *  7) 项目删除 → 数据目录镜像一并清理
 *
 * 运行：node scripts/test-dataroot.mjs；退出码 0=通过 1=失败
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
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

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

// 1) 设置数据根目录（内含自动迁移）
const setRes = I.setDataRoot(DATA);
if (!setRes.ok || setRes.dataRoot !== path.resolve(DATA)) errs.push('setDataRoot 未生效');

// 2) 建项目 → project.json 镜像 + meta 清单（文件夹按项目名）
const p = await I.canvasCreateProject({ name: '时光邮局', scriptText: '意图', nodeName: '第一节剧本' });
const pid = p.projectId;
await I.canvasWriteNode({ projectId: pid, nodeId: p.nodeId, target: 'output', text: '第一节正文', overwrite: true });
await I.canvasUpdateBible({ projectId: pid, bible: { worldview: '邮局时空穿越', style: '写实电影感', characters: [{ name: '陈拾', desc: '26 岁邮递员', assetIds: ['a_chen'] }], scenes: [], props: [] } });
const projJsonPath = path.join(DATA, 'projects', '时光邮局', 'project.json');
ok(fs.existsSync(projJsonPath), 'project.json 未镜像到数据目录（按项目名）');
const projJson = JSON.parse(fs.readFileSync(projJsonPath, 'utf8'));
ok(projJson.id === pid, 'project.json 缺少项目 id');
ok(!!(projJson.bible && projJson.bible.characters[0] && projJson.bible.characters[0].name === '陈拾'), 'project.json 未包含设定集');
ok(JSON.stringify(projJson.bible.characters[0].assetIds) === JSON.stringify(['a_chen']), 'project.json 设定集丢失 assetIds 资产绑定');
ok(!!(projJson.nodes && projJson.nodes[p.nodeId]), 'project.json 未包含节点文档');
const meta = I.readDataRootMeta();
const entry = meta.projects.find((x) => x.id === pid);
ok(!!entry && entry.folder === '时光邮局', 'canvas.meta.json 缺少项目映射或文件夹名不是项目名');

// 3) 逻辑路径 → 物理路径映射
ok(I.physicalRel(`projects/${pid}/image/x.png`) === 'projects/时光邮局/image/x.png', 'physicalRel 未把 pid 映射为项目名文件夹');
ok(I.physicalRel('projects/未知pid/image/x.png') === 'projects/未知pid/image/x.png', 'physicalRel 对未知 pid 应原样返回');
ok(I.physicalRel('other/x.png') === null, 'physicalRel 对非 projects 路径应返回 null');

// 4) 项目名含非法字符 → 清洗
const p2 = await I.canvasCreateProject({ name: '测试/项目:*名', scriptText: 'x', nodeName: 'n' });
const meta2 = I.readDataRootMeta();
const e2 = meta2.projects.find((x) => x.id === p2.projectId);
ok(!!e2 && !/[\\/:*?"<>|]/.test(e2.folder), '非法字符未从文件夹名清洗');

// 5) 改名 → 物理文件夹跟随
await I.projectsPut({ id: pid, name: '时光邮局·第二版', doc: { nodes: {}, edges: [] } });
ok(!fs.existsSync(path.join(DATA, 'projects', '时光邮局')) && fs.existsSync(path.join(DATA, 'projects', '时光邮局·第二版')), '项目改名后物理文件夹未跟随重命名');

// 6) 旧 pid 布局迁移：手动造 projects/<pid>/image/old.png → dataRootMigrate 搬到项目名文件夹
const oldDir = path.join(DATA, 'projects', pid, 'image');
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'old.png'), 'PNGDATA');
const mig = I.dataRootMigrate();
ok(mig.ok && mig.filesMoved >= 1, 'dataRootMigrate 未搬移旧布局文件');
ok(fs.existsSync(path.join(DATA, 'projects', '时光邮局·第二版', 'image', 'old.png')), '迁移后文件不在项目名文件夹');
ok(!fs.existsSync(path.join(DATA, 'projects', pid)), '迁移后旧 pid 文件夹未清理');

// 7) 资产元数据索引
const idx = I.writeAssetIndex(pid, '时光邮局·第二版', [
  { id: 'a_img1', kind: 'image', name: '角色-陈拾 多视图', rel: `projects/${pid}/image/a.png`, category: 'character' },
  { id: 'a_txt1', kind: 'text', name: '分镜表', rel: `projects/${pid}/text/b.md`, text: '【镜1】3s', category: 'storyboard' },
]);
ok(idx.ok, 'writeAssetIndex 失败');
const assetsJson = JSON.parse(fs.readFileSync(path.join(DATA, 'projects', '时光邮局·第二版', 'assets.json'), 'utf8'));
ok(assetsJson.length === 2 && assetsJson.some((x) => x.id === 'a_txt1' && x.text === '【镜1】3s'), 'assets.json 未正确写入（含文本资产）');

// 8) 一键导入：本机较新 → 跳过
const imp1 = I.dataRootImport();
ok(imp1.ok && !imp1.imported.some((x) => x.id === pid), '本机文档较新时导入不应覆盖');

// 9) 一键导入：本机项目缺失 → 从 project.json 恢复
const localFile = path.join(process.env.DSH_IC_PROJECTS_DIR, pid + '.json');
fs.unlinkSync(localFile);
const imp2 = I.dataRootImport();
ok(imp2.ok && imp2.imported.some((x) => x.id === pid), '本机缺失的项目未被导入恢复');
const restored = await I.projectsGet({ id: pid });
ok(restored && restored.name === '时光邮局·第二版' && restored.bible && restored.bible.worldview === '邮局时空穿越', '导入恢复的项目文档不完整（节点/设定集丢失）');

// 10) 项目删除 → 数据目录镜像一并清理
await I.canvasDeleteProject({ projectId: p2.projectId });
ok(!fs.existsSync(path.join(DATA, 'projects', e2.folder)), '删除项目后数据目录镜像未清理');
const meta3 = I.readDataRootMeta();
ok(!meta3.projects.some((x) => x.id === p2.projectId), '删除项目后清单条目未清理');

fs.rmSync(SANDBOX, { recursive: true, force: true });
if (errs.length) {
  console.error('✗ 数据目录回归测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 数据目录回归测试通过（镜像/项目名文件夹/逻辑路径映射/迁移/资产索引/一键导入/删除清理）');
process.exit(0);
