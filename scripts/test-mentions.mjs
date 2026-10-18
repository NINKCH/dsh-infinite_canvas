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
  return { parseMentions, highlightMentions, stripMentionMarks, matchBibleEntity, assetBelongsToEntity, entityLabelOf, entityCategoryOf, buildEffectivePrompt, assetNameFor, nowStamp, repairUnclosedMentions, bibleNames, subjectInfoFromRef, condenseDesc, voiceFromDesc, buildStructuredVideoPrompt };
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

// 1) 解析：位置、多个、双 @ 精确边界、邮箱不误伤
const p = api.parseMentions('@张山@ 走进 @褶皱巷@，手里拿着 @火漆信@。');
eq(p.map((x) => x.name), ['张山', '褶皱巷', '火漆信'], '@名称@ 解析');
eq(p[0].start, 0, '@名称@ 起始位置');
// 双 @ 语法的核心优势：紧挨着写也不会串（闭合 @ 是硬边界），且不会把后文吞进名称
eq(api.parseMentions('@张山@@褶皱巷@').map((x) => x.name), ['张山', '褶皱巷'], '紧邻双引用不串名');
eq(api.parseMentions('@张山在@褶皱巷@旁').map((x) => x.name), ['张山在'], '未闭合的 @ 不会吞后文（只认完整包裹）');
eq(api.parseMentions('a@b.com 不是引用').length, 0, '邮箱中的 @ 不再被误判为引用');

// 2) 去标记
eq(api.stripMentionMarks('@张山@ 走进 @褶皱巷@'), '张山 走进 褶皱巷', 'stripMentionMarks');

// 3) 高亮：@ 符号隐藏 + 名称蓝色加粗 + HTML 转义
const hl = api.highlightMentions('<script> @张山@ & "引号"');
if (!hl.includes('<span class="dshic-mention">张山</span>')) errs.push('高亮未把名称包成 dshic-mention（@ 应隐藏）');
if (!hl.includes('visibility:hidden">@</span>')) errs.push('高亮未隐藏 @ 符号（应占位但不可见）');
if (!hl.includes('&lt;script&gt;')) errs.push('高亮未转义 HTML（存在注入风险）');
if (hl.includes('<script>')) errs.push('高亮输出含未转义的原始标签');

// 4) 设定集匹配（大小写不敏感）
eq(api.matchBibleEntity('张山', bible).kind, 'character', '匹配角色');
eq(api.matchBibleEntity('张山', bible).name, '张山', '匹配角色名称');
eq(api.matchBibleEntity('张山', bible).assetIds.length, 0, '无链接资产时 assetIds 为空');
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

// 6) 有效提示词：@标记去掉 + [图N] 绑定 + 设定描述（视频路径）；图片走 light 模式（剥离设定全文）
const refs = [{ entity: '张山', name: '角色-张山 多视图' }, { name: '某图', category: 'general' }];
const eff = api.buildEffectivePrompt('@张山@ 的中近景', refs, [{ kind: 'character', name: '张山', desc: '40 岁，短发' }], bible);
if (eff.includes('@张山')) errs.push('有效提示词里仍残留 @ 标记');
if (!eff.includes('[图1] 角色 张山（40 岁，短发，深灰风衣）')) errs.push('[图N] 绑定行缺少实体与设定描述');
if (!eff.includes('[图2]')) errs.push('第二个参考图未编号');
if (!eff.includes('设定集：角色 张山：40 岁，短发')) errs.push('未注入命中实体的设定描述');
// light 模式（图片生成）：绑定行只留实体名，不内联设定描述，也不追加「设定集：」段落——
// 参考图是外观事实源；文字渲染型模型会把内联的设定全文直接画进画面（用户实测乱码文字块）
const effLight = api.buildEffectivePrompt('@张山@ 的中近景', refs, [{ kind: 'character', name: '张山', desc: '40 岁，短发' }], bible, true);
if (effLight.includes('@张山')) errs.push('light 提示词里仍残留 @ 标记');
if (!effLight.includes('[图1] 角色 张山')) errs.push('light 模式 [图N] 绑定行缺少实体名');
if (effLight.includes('40 岁，短发')) errs.push('light 模式不应内联实体设定描述');
if (effLight.includes('设定集：')) errs.push('light 模式不应追加「设定集：」段落');
if (!effLight.includes('风格：')) errs.push('light 模式应保留风格行');

// 7) 资产命名：节点名 + 时间（用户规则）→ 实体 + 时间 → 兜底 + 时间
eq(api.assetNameFor({ data: { label: '角色-张山 多视图' } }, [], 'image'), '角色-张山 多视图 ' + api.nowStamp(), '节点名+时间');
eq(api.assetNameFor({ data: {} }, [{ kind: 'scene', name: '褶皱巷' }], 'image'), '场景-褶皱巷 ' + api.nowStamp(), '实体命名+时间');
if (!api.assetNameFor({ data: {} }, [], 'video').startsWith('视频-')) errs.push('兜底命名不正确');
eq(api.entityCategoryOf('character'), 'character', '实体→资产品类');

// 8) 未闭合引用自愈：句尾丢闭合 @ 按已知资产名补全并归一
const fix = (t, names) => api.repairUnclosedMentions(t, names);
eq(fix('@糯糯。', ['糯糯']), '@糯糯@。', '句尾未闭合补全');
eq(fix('@糯糯@', ['糯糯']), '@糯糯@', '已闭合原样保留');
eq(fix('@糯', ['糯糯']), '@糯糯@', '前缀名归一为完整名');
eq(fix('@路人甲。', ['糯糯']), '@路人甲。', '未命中已知名不误伤');
eq(fix('@@', ['糯糯']), '@@', '空名不误伤');
eq(fix('邮箱 a@b.com 保留', ['糯糯']), '邮箱 a@b.com 保留', '邮箱不误伤');
eq(api.bibleNames({ characters: [{ name: '林晚' }], scenes: [{ name: '楼道' }], props: [{ name: '字条' }] }), ['林晚', '楼道', '字条'], 'bibleNames 收集');

// 9) 视频结构化提示词（对齐厂商「参考生成」优化后格式）：主体/分镜/台词/声音显式绑定
{
  const b2 = {
    style: '写实电影感，暖调自然光',
    characters: [
      { name: '瓦力', desc: '纯白色博美犬。外观：圆脸、黑色圆鼻头、雪白蓬松双层被毛。声音：9 岁男孩音，清亮认真。' },
      { name: '糯糯', desc: '橘黄色博美犬。外观：颈部像小狮子鬃毛、尾巴像大菊花。声音：5–6 岁男孩奶音，尾音上扬。' },
    ],
    scenes: [{ name: '青砖小院', desc: '外观：青砖墙、灰瓦顶、院中一棵老槐树、青石台阶。' }],
    props: [],
  };
  const refs2 = [
    { entity: '青砖小院', name: '场景-青砖小院 10-18 12:38', category: 'scene' },
    { entity: '糯糯', name: '角色-糯糯 设定图 10-18 13:22', category: 'character' },
    { entity: '瓦力', name: '角色-瓦力 设定图 10-18 13:30', category: 'character' },
  ];
  const shots2 = [
    { title: '开场', duration: 1.5, visual: '远景，青砖小院 院内晨光斜照，糯糯 在晾衣绳下绕圈', motion: '镜头缓推', sfx: '麻雀叫' },
    { title: '对话', duration: 2, visual: '近景，糯糯 抬头开口说话', motion: '镜头固定', dialogue: [{ role: '糯糯', line: '为什么呀？' }], sfx: '铃铛轻响' },
    { title: '叮嘱', duration: 1.2, visual: '近景，瓦力 蹲在台阶上开口', motion: '镜头固定', dialogue: [{ role: '瓦力', line: '台阶我刚擦干净。' }], sfx: '铃铛轻响' },
  ];
  const sp = api.buildStructuredVideoPrompt(shots2, refs2, b2, { zh: true, music: '温暖的木吉他，缓慢收束' });
  const need = [
    ['subject_definitions:', '缺少 subject_definitions 段'],
    ['<Subject 1> 是 <Picture 1> 中的 青砖小院', '场景主体未绑定 <Picture 1>'],
    ['<Subject 2> 是 <Picture 2> 中的 糯糯', '角色主体编号/图片绑定错误'],
    ['青砖墙、灰瓦顶', '主体描述未取设定集「外观：」片段'],
    ['summary:', '缺少 summary 段'],
    ['retention_analysis:', '缺少 retention_analysis 段'],
    ['[Shot 2]', '保真核对未按镜号列出'],
    ['detailed_description:', '缺少 detailed_description 段'],
    ['[Shot 1] 00:00.000', '镜头起始时间不是绝对时间轴'],
    ['[Shot 2] 00:01.500', '第二镜起始时间错误（应为累加）'],
    ['<Subject 2>（S1） 用5–6 岁男孩奶音，尾音上扬说', '台词未绑定主体+说话人编号+声音描述'],
    ['<d>[Chinese] 为什么呀？</d>', '台词未用 <d>[Chinese] …</d> 包裹'],
    ['overall_soundscape:', '缺少 overall_soundscape 段'],
    ['non_diegetic_music:', '显式给出音乐时未输出该段'],
  ];
  for (const [frag, msg] of need) if (!sp.includes(frag)) errs.push('结构化提示词：' + msg + '（缺片段 ' + frag + '）');
  if (sp.includes('糯糯 抬头')) errs.push('结构化提示词：镜头正文里的实体名未被替换为 <Subject N>');
  if (sp.includes('non_diegetic_music:') && !api.buildStructuredVideoPrompt(shots2, refs2, b2, { zh: true }).includes('overall_soundscape:')) errs.push('无音乐时不应省略声音段');
  if (api.buildStructuredVideoPrompt(shots2, refs2, b2, { zh: true }).includes('non_diegetic_music:')) errs.push('未提供音乐时不应臆造 non_diegetic_music');
  if (api.buildStructuredVideoPrompt(shots2, [], b2, { zh: true }) !== '') errs.push('无参考图时应返回空串（回退普通提示词）');
}

if (errs.length) {
  console.error('✗ @引用解析测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ @引用解析测试全部通过（解析/高亮转义/设定集匹配/资产归属/[图N]绑定/命名/结构化视频提示词）');
