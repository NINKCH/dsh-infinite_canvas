// 正式回归：跨项目角色库（静态契约）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const has = (s, m) => ok(cli.includes(s), m);

// 数据层：全局 localStorage + 归一化 + 通用项目资产复制
has("const LS_SUBJECTS = 'dsh-ic:subjects'", '缺少跨项目角色库存储键');
has('function normalizeSubject(x)', '缺少 normalizeSubject');
has("assetIds: Array.isArray(s.assetIds) ? s.assetIds.map(String).filter(Boolean).slice(0, 16) : []", '参考图 assetIds 未归一化/限长');
has('function loadSubjects()', '缺少 loadSubjects');
has('function upsertSubject(entry)', '缺少 upsertSubject');
has('async function copySubjectAssetsToGeneral(ids)', '缺少复制到通用项目');
has('saveAssetRecord(GENERAL_PID, kind, blob', '复制资产未落到 GENERAL_PID');
has('if (rec && rec.projectId === GENERAL_PID)', '已是通用资产时未跳过复制');

// 应用到画布：建参考图节点 + ref 连线 + @角色名@
has('async function applySubjectToCanvas(subject, targetNodeId)', '缺少 applySubjectToCanvas');
has("if (connect(nd, 'out', target, 'ref')) added++;", '应用角色未接 ref 口');
has("const mention = '@' + sub.name + '@';", '应用角色未写入 @角色名@');
has('function createSubjectSheetNode(subject)', '缺少角色设定图节点');
has("g.data.subjectId = sub.id;", '设定图节点未记录 subjectId');
has('function linkAssetToSubject(nodeId, assetId)', '缺少生成结果回挂');
has('linkAssetToSubject(nodeId, assetId);', 'commitGenResult 未调用回挂');

// 统一弹窗 + 图标列 + 生成器入口
has("tabBtn('subjects', T('subjTab'))", '统一弹窗缺少角色库页签');
has("'data-action': 'open-subjects'", '图标列缺少角色库入口');
has("'data-action': 'composer-subjects'", '生成器缺少角色库入口');
has('function SubjectsTab({ targetNodeId })', '缺少 SubjectsTab');
has("data-subtab", '缺少我的/本系列/官方模板分栏');
has('function SubjectThumb', '缺少角色缩略图');
has('subjFromBibleHint', '缺少本系列导入说明');
has('subjTargetHint', '缺少目标节点提示');

// 官方模板：至少 6 个，且带中英文名称/描述
const officialCount = (cli.match(/\{ id: 'off_/g) || []).length;
ok(officialCount >= 6, '官方角色模板少于 6 个（实际 ' + officialCount + '）');
has('官方角色模板（无参考图）', '缺少官方模板说明');

// 样式
has('.dshic-subj-grid{', '缺少角色宫格样式');
has('.dshic-subj-card{', '缺少角色卡样式');
has('.dshic-subj-thumb{', '缺少角色缩略图样式');

if (errs.length) {
  console.error('✗ 跨项目角色库测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 跨项目角色库测试通过（全局存储 / 通用资产复制 / 应用接线 / 生成器入口 / 官方模板 / 宫格样式）');
process.exit(0);
