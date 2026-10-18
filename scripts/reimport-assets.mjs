#!/usr/bin/env node
/**
 * reimport-assets.mjs — 把数据目录里旧版（≤0.17）的 assets.json 资产索引重新导入 canvas.db。
 *
 * 背景：0.18 首次启动的自动迁移依赖 <数据目录>/canvas.meta.json 清单定位各项目的 assets.json；
 * 清单缺失/为空时（或数据库先于数据就位创建）资产会被漏掉——本脚本按文件夹直接扫描，幂等可重复跑：
 *   · 资产按 id upsert；已有 CAS sha（0.18 后新生成）的记录不会被旧索引回写覆盖
 *   · 本机缺失的项目文档从 project.json 补入（已存在的不动，避免覆盖较新文档）
 *   · 同步维护 FTS 全文索引，结尾做 WAL checkpoint
 *
 * 用法：
 *   node reimport-assets.mjs [数据目录]
 *   不传参数时自动读 %USERPROFILE%\.dsh\infinite-canvas\config.json 的 dataRoot。
 * 建议先退出 Harness 再跑（避免 WAL 写竞争），跑完启动 Harness 即可在资产面板看到资产。
 * 需要 Node ≥ 22.5（node:sqlite；DSH 捆绑的 Node 24 满足，可直接用 DSH 自带 node 运行）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);
const { DatabaseSync } = require2('node:sqlite');

const cfgPath = process.env.DSH_IC_CONFIG_PATH || path.join(os.homedir(), '.dsh', 'infinite-canvas', 'config.json');
let root = process.argv[2] || '';
if (!root) {
  try { root = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).dataRoot || ''; } catch { /* 无配置 */ }
}
if (!root) {
  console.error('未找到数据目录：node reimport-assets.mjs <数据目录>，或先在画布设置里配置数据根目录');
  process.exit(1);
}
root = path.resolve(String(root));
const dbPath = path.join(root, 'canvas.db');
if (!fs.existsSync(dbPath)) {
  console.error('未找到 ' + dbPath + ' —— 先升级到 0.18+ 并启动一次 Harness（自动建库），再运行本脚本');
  process.exit(1);
}
console.log('数据目录:', root);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');

const projectsDir = path.join(root, 'projects');
const dirs = fs.existsSync(projectsDir)
  ? fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
console.log('扫描到项目文件夹:', dirs.length);

const upAsset = db.prepare(`INSERT INTO assets (id,project_id,episode_id,kind,mime,name,rel,sha,bytes,width,height,duration,prompt,category,entity,entities,node_label,text,source,created_at,updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, episode_id=excluded.episode_id, kind=excluded.kind, mime=excluded.mime, name=excluded.name,
 rel=excluded.rel, bytes=excluded.bytes, width=excluded.width, height=excluded.height, duration=excluded.duration, prompt=excluded.prompt,
 category=excluded.category, entity=excluded.entity, entities=excluded.entities, node_label=excluded.node_label, text=excluded.text,
 source=excluded.source, updated_at=excluded.updated_at`);
const ftsDel = db.prepare('DELETE FROM assets_fts WHERE id = ?');
const ftsIns = db.prepare('INSERT INTO assets_fts (id, name, prompt) VALUES (?, ?, ?)');
const hasProj = db.prepare('SELECT id FROM projects WHERE id = ?');
const insProj = db.prepare('INSERT INTO projects (id,name,created_at,updated_at,bible_updated_at,summary,tombstones,doc) VALUES (?,?,?,?,?,?,?,?)');
const getAsset = db.prepare('SELECT id, sha FROM assets WHERE id = ?');

let projAdded = 0;
let assetRows = 0;
let skippedNew = 0;

for (const folder of dirs) {
  const dir = path.join(projectsDir, folder);
  // 1) 项目文档：本机缺失时从 project.json 补入
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')); } catch { /* 无镜像 */ }
  if (doc && doc.id && !hasProj.get(String(doc.id))) {
    const nodes = Object.values(doc.nodes || {}).map((n) => ({
      id: n.id, type: n.type, label: (n.data && n.data.label) || '', status: (n.data && n.data.status) || 'idle',
    }));
    insProj.run(
      String(doc.id), String(doc.name || doc.id).slice(0, 80), Number(doc.createdAt) || 0, Number(doc.updatedAt) || 0,
      Number(doc.bibleUpdatedAt) || 0,
      JSON.stringify({ nodeIds: Object.keys(doc.nodes || {}), nodes, source: doc.source || 'app' }),
      JSON.stringify(doc.tombstones || []), JSON.stringify(doc),
    );
    projAdded++;
  }
  // 2) 资产索引：assets.json → assets 表
  let list = null;
  try { list = JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8')); } catch { continue; }
  if (!Array.isArray(list)) continue;
  for (const a of list) {
    if (!a || !a.id) continue;
    const cur = getAsset.get(String(a.id));
    if (cur && cur.sha && !a.sha) { skippedNew++; continue; } // 0.18 后新生成的 CAS 记录：旧索引不回写
    upAsset.run(
      String(a.id),
      String(a.projectId || ''),
      a.episodeId ? String(a.episodeId) : null,
      String(a.kind || ''),
      String(a.mime || ''),
      String(a.name || ''),
      a.rel ? String(a.rel) : null,
      a.sha ? String(a.sha).toLowerCase() : null,
      Number(a.size || a.bytes || 0) || null,
      Number(a.width || 0) || null,
      Number(a.height || 0) || null,
      Number(a.duration || 0) || null,
      String(a.prompt || ''),
      String(a.category || 'general'),
      a.entity ? String(a.entity) : null,
      Array.isArray(a.entities) ? JSON.stringify(a.entities) : null,
      a.nodeLabel ? String(a.nodeLabel) : null,
      (a.kind === 'text' && typeof a.text === 'string') ? a.text : null,
      String(a.source || ''),
      Number(a.createdAt) || Date.now(),
      Date.now(),
    );
    ftsDel.run(String(a.id));
    ftsIns.run(String(a.id), String(a.name || ''), String(a.prompt || ''));
    assetRows++;
  }
}

try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* Harness 运行中可能失败，无碍 */ }
db.close();
console.log(`完成：补入项目 ${projAdded} 个，导入/更新资产行 ${assetRows} 条${skippedNew ? `（跳过 0.18 后新生成记录 ${skippedNew} 条）` : ''}。`);
console.log('启动 Harness 后资产面板即可见。若个别资产预览 404，说明其媒体文件不在该数据目录里。');
