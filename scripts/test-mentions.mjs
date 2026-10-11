// @引用解析的单测：从 client.js 抽取 MENTION_PURE 区块（无副作用纯函数）在沙箱里执行
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(root, 'client.js'), 'utf8');
const m = /\/\/ <<<MENTION_PURE_BEGIN>>>([\s\S]*?)\/\/ <<<MENTION_PURE_END>>>/.exec(src);
if (!m) {
  console.error('✗ 未找到 MENTION_PURE 区块（client.js 结构被改动？）');
  process.exit(1);
}
const body = m[1];
// 沙箱：只提供用到的环境（catLabel 由下方 stub 提供；纯函数本身不依赖 DOM）
const catLabel = (c) => ({ character: '角色', scene: '场景', prop: '道具', general: '通用' }[c] || '通用');
const effLang = () => 'zh';
const factory = new Function('catLabel', 'effLang', body + `
  return { parseMentions, highlightMentions, stripMentionMarks, matchBibleEntity, assetBelongsToEntity, entityLabelOf, entityCategoryOf, buildEffectivePrompt, assetNameFor };
`);
const api = factory(catLabel, effLang);

const errs = [];
const eq = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) errs.push(`${label}\n    期望 ${JSON.stringify(b)}\n    实际 ${JSON.stringify(a)}`); };

const bible = {
  worldview: '时空邮局', style: '写实电影感',
  characters: [{ name: '张山', desc: '40 岁，短发，深灰风衣' }, { name: '林小满', desc: '17 岁学生' }],
  scenes: [{ name: '褶皱巷', desc: '雨夜窄巷' }],
  props: [{ name: '火漆信', desc: '火漆封蜡' }],
};

// 1) 解析：位置、多个、标点边界、邮箱不误伤
const p = api.parseMentions('@张山 走进 @褶皱巷，手里拿着 @火漆信。');
eq(p.map((x) => x.name), ['张山', '褶皱巷', '火漆信'], '@名称解析');
eq(p[0].start, 0, '@名称起始位置');
if (api.parseMentions('a@b.com 不是引用').length !== 1) errs.push('邮箱/普通文本中的 @ 会被误判为引用（应保留可识别但可容忍）');

// 2) 去标记
eq(api.stripMentionMarks('@张山 走进 @褶皱巷'), '张山 走进 褶皱巷', 'stripMentionMarks');

// 3) 高亮：蓝色加粗 span + HTML 转义
const hl = api.highlightMentions('<script> @张山 & "引号"');
if (!hl.includes('<span class="dshic-mention">@张山</span>')) errs.push('高亮未包裹 @名称');
if (!hl.includes('&lt;script&gt;')) errs.push('高亮未转义 HTML（存在注入风险）');
if (hl.includes('<script>')) errs.push('高亮输出含未转义的原始标签');

// 4) 设定集匹配（大小写不敏感）
eq(api.matchBibleEntity('张山', bible), { kind: 'character', name: '张山', desc: '40 岁，短发，深灰风衣' }, '匹配角色');
eq(api.matchBibleEntity('褶皱巷', bible).kind, 'scene', '匹配场景');
eq(api.matchBibleEntity('火漆信', bible).kind, 'prop', '匹配道具');
eq(api.matchBibleEntity('不存在的人', bible), null, '未命中返回 null');

// 5) 资产归属：entity 字段优先，其次标准命名
const ent = { kind: 'character', name: '张山' };
eq(api.assetBelongsToEntity({ name: '随便什么', entity: '张山' }, ent), true, '显式 entity 字段');
eq(api.assetBelongsToEntity({ name: '角色-张山 多视图' }, ent), true, '标准命名 角色-名称');
eq(api.assetBelongsToEntity({ name: '张山' }, ent), true, '同名资产');
eq(api.assetBelongsToEntity({ name: '角色-张山峰' }, ent), false, '前缀相似但不同名不应命中');
eq(api.assetBelongsToEntity({ name: '场景-褶皱巷' }, ent), false, '其他类型前缀不命中');

// 6) 有效提示词：@标记去掉 + [图N] 绑定 + 设定描述
const refs = [{ entity: '张山', name: '角色-张山 多视图' }, { name: '某图', category: 'general' }];
const eff = api.buildEffectivePrompt('@张山 的中近景', refs, [{ kind: 'character', name: '张山', desc: '40 岁，短发' }], bible);
if (eff.includes('@张山')) errs.push('有效提示词里仍残留 @ 标记');
if (!eff.includes('[图1] 角色 张山（40 岁，短发，深灰风衣）')) errs.push('[图N] 绑定行缺少实体与设定描述');
if (!eff.includes('[图2]')) errs.push('第二个参考图未编号');
if (!eff.includes('设定集：角色 张山：40 岁，短发')) errs.push('未注入命中实体的设定描述');

// 7) 资产命名：节点名优先 → 实体 → 兜底
eq(api.assetNameFor({ data: { label: '角色-张山 多视图' } }, [], 'image'), '角色-张山 多视图', '节点名优先');
eq(api.assetNameFor({ data: {} }, [{ kind: 'scene', name: '褶皱巷' }], 'image'), '场景-褶皱巷', '实体命名');
if (!api.assetNameFor({ data: {} }, [], 'video').startsWith('视频-')) errs.push('兜底命名不正确');
eq(api.entityCategoryOf('character'), 'character', '实体→资产品类');

if (errs.length) {
  console.error('✗ @引用解析测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ @引用解析测试全部通过（解析/高亮转义/设定集匹配/资产归属/[图N]绑定/命名）');
