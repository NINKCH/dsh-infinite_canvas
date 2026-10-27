/**
 * canvas-director 技能包：切片与索引的共享纯函数。
 *
 * 设计约束（务必遵守）：
 *  - 纯函数：不读写 fs、不碰 DOM、不带副作用 → Host 与 Client 同源，且可直接单测。
 *  - 按「生成能力」切片，绝不整份注入：一份透镜全文 12–22KB，全注入会吃掉几千 token，
 *    而剧本只关心叙事与节奏、分镜只关心镜头语言、提示词只关心风格参数与负向词。
 *  - 切片靠 Markdown 里的 `<!-- slice:xxx yyy -->` 标记 + `## ` 标题双重定位；
 *    标记缺失时回落到纯标题匹配（保证「复制过来就能用」的鲁棒性）。
 *
 * 术语：kind = 生成能力（script / storyboard / prompt / assets），
 *       layer = 数据层（lens 导演 / genre 叙事题材 / industry 行业题材 / form 规格 / look 影调 / moves 运镜）。
 */

/** Markdown 里 slice 标记的格式：`<!-- slice:story prompt -->`（一个标记可声明归属多个能力）。 */
export const SLICE_RE = /^<!--\s*slice:([a-z ]+?)\s*-->\s*$/;

/** 每张小节的「缺省归属」——标记缺失时用它兜底，避免老文件一个切片也取不到。 */
export const SECTION_DEFAULT_SLICE = {
  // 透镜
  '一句话镜头 / Lens in one line': 'story shot prompt',
  '适用场景': 'story',
  '反例：这不是什么 / What this lens is NOT': 'story shot',
  '核心风格关键词': 'story shot prompt',
  '叙事方法': 'story',
  '镜头语言': 'story shot',
  '灯光与色彩': 'shot prompt assets',
  '剪辑节奏': 'story',
  '声音与音乐': 'story',
  '人物与表演': 'story shot',
  '风格参数 / Style parameters': 'shot prompt assets',
  '可迁移拍摄清单': 'storyboard shot',
  '提示词模板 / Prompt templates': 'prompt',
  '落地示例 / Worked example': 'prompt',
  // 叙事题材卡
  '题材核心与观众为什么看': 'story',
  '压力来源与冲突发动机': 'story',
  '人物策略与信息权限': 'story',
  '观众回报与情绪落点': 'story',
  '常见场面颗粒': 'story prompt',
  '集尾钩子取向': 'story',
  '前中后期打法': 'story',
  '制作难点': 'story shot',
  '禁止漂移': 'story shot',
  '证据与置信度': 'story',
  // 行业题材卡
  '视觉母题': 'story prompt',
  '证据点': 'story prompt',
  '常见承诺': 'story prompt',
  '禁项': 'prompt',
  '参考镜头': 'prompt',
  // 规格卡
  '交付规格': 'story shot prompt',
  '结构块': 'story',
  '这个类型的观众契约': 'story shot',
  '与导演透镜冲突时的改写': 'story shot',
  '类型级负向词': 'prompt',
  // 影调卡
  '成像底层': 'story shot prompt',
  '形体与骨相': 'story shot prompt',
  '影调与光比': 'shot prompt assets',
  '色彩命题': 'shot prompt assets',
  '空气与介质': 'shot prompt assets',
  '光学与镜头': 'shot prompt assets',
  '材质响应': 'prompt assets',
  '特效语言': 'shot prompt',
  '针对性禁项': 'prompt',
  '负向词块': 'prompt',
};

/**
 * 把一份 Markdown 切成 { title, slice, body } 的小节数组。
 * - 首个 `## ` 之前的内容（frontmatter + 一级标题 + 前言）归入 `preamble`。
 * - 小节内的 ``` 代码围栏不打断（围栏内的 `## ` 不算标题）。
 */
export function splitSections(md) {
  const lines = String(md || '').split(/\r?\n/);
  const sections = [];
  let cur = null;
  let pendingSlice = null;
  let inFence = false;
  const preamble = [];
  for (const ln of lines) {
    if (/^\s*```/.test(ln)) inFence = !inFence;
    if (!inFence) {
      const sm = SLICE_RE.exec(ln.trim());
      if (sm) { pendingSlice = sm[1].trim(); continue; }
      const hm = /^##\s+(.+)$/.exec(ln);
      if (hm) {
        if (cur) sections.push(cur);
        const title = hm[1].trim();
        cur = {
          title,
          slice: pendingSlice || SECTION_DEFAULT_SLICE[title] || 'story',
          body: [],
        };
        pendingSlice = null;
        continue;
      }
    }
    if (cur) cur.body.push(ln);
    else preamble.push(ln);
  }
  if (cur) sections.push(cur);
  return sections.map((s) => ({ title: s.title, slice: s.slice, body: s.body.join('\n').replace(/^\n+|\n+$/g, '') }));
}

/** 按标题名精确取小节正文；找不到返回空串。 */
export function sectionText(md, title) {
  const hit = splitSections(md).find((s) => s.title === title);
  return hit ? hit.body : '';
}

/** 生成能力 → 该能力需要的小节标签集合（kind 与 slice 标签不是同一套词，必须显式映射）。 */
export const KIND_SLICES = {
  // 剧本：叙事与节奏为主，镜头细节交给分镜；不取「镜头语言/风格参数/提示词模板」那些给分镜与提示词的节
  script: ['story'],
  // 分镜：镜头语言 + 灯光 + 可迁移清单；不取提示词模板与落地示例
  storyboard: ['shot', 'storyboard'],
  // 提示词：只取风格参数与提示词模板（外加灯光）；不取叙事、剪辑、表演
  prompt: ['prompt'],
  // 资产设定图：只取成像与材质相关
  assets: ['assets'],
};

/** 取一份 Markdown 在某个生成能力下的全部小节正文（按出现顺序拼接）。 */
export function pickSections(md, kind) {
  const want = KIND_SLICES[String(kind || '').trim()];
  if (!want) return '';
  return splitSections(md)
    .filter((s) => s.slice.split(/\s+/).some((t) => want.includes(t)))
    .map((s) => '## ' + s.title + '\n\n' + s.body)
    .join('\n\n');
}

/** 抽出 ```yaml 风格参数块原文（含围栏内文本，不含围栏本身）。没有则空串。 */
export function yamlBlock(md) {
  const m = /```ya?ml\s*\n([\s\S]*?)```/.exec(String(md || ''));
  return m ? m[1].replace(/\s+$/, '') : '';
}

/** 抽出负向词：优先取「负向词块」小节里的英文逗号短语，其次取 yaml 的 negative_prompt_adds。 */
export function negativePhrases(md) {
  const text = String(md || '');
  const sec = sectionText(text, '负向词块') || sectionText(text, '类型级负向词');
  const fromSec = sec
    ? sec.replace(/```[a-z]*\n?/g, '').split(/[,，\n]/)
      .map((s) => s.replace(/^[-*\d.\s]+/, '').trim())
      .filter((s) => /^[a-z][a-z0-9 '\-/]{2,}$/i.test(s))
    : [];
  if (fromSec.length) return [...new Set(fromSec)];
  const y = yamlBlock(text);
  const m = /negative_prompt_adds:\s*\[([^\]]*)\]/m.exec(y);
  if (!m) return [];
  return [...new Set(m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean))];
}

/** 从 frontmatter 读一个标量字段（不带引号处理之外的 YAML 特性）。 */
export function frontmatterField(md, key) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || ''));
  if (!fm) return '';
  const m = new RegExp('^' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+)$', 'm').exec(fm[1]);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/** 从 frontmatter 读一个内联数组字段（`a: [x, y]` 或 `a: x`）。 */
export function frontmatterList(md, key) {
  const raw = frontmatterField(md, key);
  if (!raw) return [];
  const inner = /^\[([\s\S]*)\]$/.exec(raw);
  const body = inner ? inner[1] : raw;
  return body.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** 从 frontmatter 读 spec 子块的键（`spec:\n  aspect: [...]` 这类两层缩进）。 */
export function frontmatterSpec(md) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || ''));
  if (!fm) return {};
  const out = {};
  let inSpec = false;
  for (const ln of fm[1].split(/\r?\n/)) {
    if (/^spec:\s*$/.test(ln)) { inSpec = true; continue; }
    if (inSpec) {
      if (/^\S/.test(ln)) { inSpec = false; continue; }         // 缩进归零 = spec 块结束
      const m = /^\s+([A-Za-z0-9_]+):\s*(.+)$/.exec(ln);
      if (!m) continue;
      const v = m[2].trim().replace(/\s+#.*$/, '');
      if (/^\[/.test(v)) out[m[1]] = frontmatterList('---\n' + m[1] + ': ' + v + '\n---', m[1]);
      else if (/^-?\d+(\.\d+)?$/.test(v)) out[m[1]] = Number(v);
      else out[m[1]] = v.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

/** 拼装一段可注入的文本块：标题 + 分区，并返回字节数（UTF-8）。 */
export function composePackText(blocks, opts) {
  const o = opts || {};
  const head = String(o.head || '').trim();
  const parts = [];
  if (head) parts.push(head);
  for (const b of blocks || []) {
    if (!b) continue;
    const title = String(b.title || '').trim();
    const body = String(b.body || '').trim();
    if (!body) continue;
    parts.push((title ? '### ' + title + '\n' : '') + body);
  }
  const text = parts.join('\n\n').trim();
  return { text, bytes: utf8Bytes(text) };
}

/** UTF-8 字节数（不依赖 TextEncoder，纯算，便于在无环境桩下运行）。 */
export function utf8Bytes(str) {
  const s = String(str || '');
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; } // 代理对
    else n += 3;
  }
  return n;
}

/** 校验并归一 manifest；返回 { ok, errors, manifest }。 */
export function parseManifest(json) {
  const errors = [];
  const m = (typeof json === 'string') ? safeJson(json) : (json || {});
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest 不是对象'], manifest: null };
  const LAYERS = ['lenses', 'genres', 'industries', 'forms', 'looks'];
  const out = {};
  const ids = new Map();
  for (const layer of LAYERS) {
    const list = m[layer];
    if (!Array.isArray(list)) { errors.push('缺少数组 ' + layer); out[layer] = []; continue; }
    out[layer] = [];
    for (const it of list) {
      if (!it || typeof it !== 'object') { errors.push(layer + ' 含非对象项'); continue; }
      const id = String(it.id || '').trim();
      const name = String(it.name || '').trim();
      if (!id) { errors.push(layer + ' 有项缺 id'); continue; }
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) { errors.push(layer + '/' + id + ': id 只允许小写字母数字下划线连字符'); }
      if (ids.has(id)) errors.push('id 重复：' + id + '（' + ids.get(id) + ' 与 ' + layer + '）');
      ids.set(id, layer);
      if (!name) errors.push(layer + '/' + id + ': 缺 name');
      if (!String(it.file || '').trim()) errors.push(layer + '/' + id + ': 缺 file');
      out[layer].push({
        id,
        name,
        group: String(it.group || '').trim(),
        file: String(it.file || '').trim(),
        glyph: String(it.glyph || id).trim(),
        oneliner: String(it.oneliner || '').trim(),
        tier: String(it.tier || '').trim(),
        aliases: Array.isArray(it.aliases) ? it.aliases.map(String) : [],
      });
    }
  }
  return { ok: errors.length === 0, errors, manifest: out };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 组装某个生成能力下的注入文本。
 * items: [{ layer, md, meta }]，顺序即拼接顺序。
 * 返回 { text, bytes, used: [{layer,id,bytes}] }
 */
export function buildPackText(kind, items, opts) {
  const o = opts || {};
  const zh = o.zh !== false;
  const blocks = [];
  const used = [];
  for (const it of items || []) {
    if (!it || !it.md) continue;
    const meta = it.meta || {};
    const name = meta.name || meta.id || it.layer;
    let body = '';
    if (it.layer === 'moves') {
      body = String(it.md || '').trim();                        // 运镜词典整份注入（本身已是短条目）
    } else {
      body = pickSections(it.md, kind);
    }
    if (!body.trim()) continue;
    blocks.push({ title: layerLabel(it.layer, zh) + '：' + name + (meta.oneliner ? ' —— ' + meta.oneliner : ''), body });
    used.push({ layer: it.layer, id: meta.id || '', bytes: utf8Bytes(body) });
  }
  // 一条切片都没切出来 → 返回空：否则调用方只会拿到一段光秃秃的头部
  // （典型场景：kind=assets 时某层没有 assets 小节，不该产出「只有标题」的空壳）。
  if (!blocks.length) return { text: '', bytes: 0, used: [] };
  const head = o.head || '';
  const r = composePackText(blocks, { head });
  return { text: r.text, bytes: r.bytes, used };
}

/** 层的中文标签。 */
export function layerLabel(layer, zh) {
  const ZH = { lens: '导演透镜', genre: '题材', industry: '行业题材', form: '规格', look: '影调', moves: '运镜与节奏' };
  const EN = { lens: 'Director lens', genre: 'Genre', industry: 'Industry', form: 'Spec', look: 'Look', moves: 'Camera & rhythm' };
  const m = zh === false ? EN : ZH;
  return m[layer] || layer;
}

/** 默认配置（老项目无该字段时就是它，保证行为与未引入技能包前完全一致）。 */
export const DEFAULT_PROFILE = {
  lens: '',
  genres: [],
  form: '',
  look: '',
  genreMode: 'auto',
};

/** 归一技能配置：字符串裁剪、枚举由调用方给、非法回落、空值剔除。 */
export function normalizeProfile(raw, allowed) {
  const b = (raw && typeof raw === 'object') ? raw : {};
  const a = allowed || {};
  const pick = (v, list) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (Array.isArray(list) && list.length && !list.includes(s)) return '';
    return s;
  };
  const genres = Array.isArray(b.genres)
    ? [...new Set(b.genres.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))]
      .filter((x) => !Array.isArray(a.genres) || !a.genres.length || a.genres.includes(x))
      .slice(0, 12)
    : [];
  return {
    lens: pick(b.lens, a.lenses),
    genres,
    form: pick(b.form, a.forms) || DEFAULT_PROFILE.form,
    look: pick(b.look, a.looks),
    genreMode: (b.genreMode === 'narrative' || b.genreMode === 'industry') ? b.genreMode : 'auto',
  };
}
