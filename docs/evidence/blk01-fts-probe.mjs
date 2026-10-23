// BLK-01 追加判据探针：删除项目后 assets_fts 是否仍命中已删项目资产
// 只读打开画布库，不写入
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/data/canvas-data/canvas.db', { readOnly: true });
const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return 'ERR: ' + e.message; } };
console.log('projects:', JSON.stringify(q('SELECT id,name FROM projects')));
console.log('assets rows for pmvex3446bnns:', JSON.stringify(q("SELECT COUNT(*) n FROM assets WHERE project_id='pmvex3446bnns'")));
console.log("FTS MATCH 'QA冒烟':", JSON.stringify(q("SELECT id FROM assets_fts WHERE assets_fts MATCH 'QA冒烟'")));
console.log("FTS MATCH '便利店':", JSON.stringify(q("SELECT id FROM assets_fts WHERE assets_fts MATCH '便利店'")));
console.log('FTS 总行数 / assets 总行数:', JSON.stringify(q('SELECT COUNT(*) n FROM assets_fts')), JSON.stringify(q('SELECT COUNT(*) n FROM assets')));
console.log('assets 中 name 含 QA冒烟:', JSON.stringify(q("SELECT id,name,project_id FROM assets WHERE name LIKE '%QA冒烟%'")));
db.close();
