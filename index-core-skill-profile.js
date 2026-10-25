/**
 * 技能配置（四层：导演透镜 / 题材 / 类型规格 / 影调）的字段规范化。
 *
 * 单独成文件是为了让 index.js 与 skill-pack.js 都能引用而不产生循环依赖。
 * 与 normalizeBible 同风格：字符串裁剪、空值剔除、非法值静默回落（不抛错，老项目零迁移）。
 * 枚举白名单由调用方按 manifest 传 allowed —— 避免「清单改了要改两处」。
 */
export function normalizeSkillProfile(raw, allowed) {
  const b = (raw && typeof raw === 'object') ? raw : {};
  const a = allowed || {};
  const pick = (v, list) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (Array.isArray(list) && list.length && !list.includes(s)) return '';
    return s.slice(0, 80);
  };
  const genres = Array.isArray(b.genres)
    ? [...new Set(b.genres.map((x) => String(x == null ? '' : x).trim()).filter(Boolean))]
      .filter((x) => !Array.isArray(a.genres) || !a.genres.length || a.genres.includes(x))
      .slice(0, 12)
    : [];
  const sec = Number(b.targetSec);
  const mode = (b.genreMode === 'narrative' || b.genreMode === 'industry') ? b.genreMode : 'auto';
  return {
    lens: pick(b.lens, a.lenses),
    genres,
    form: pick(b.form, a.forms),
    aspect: pick(b.aspect, a.aspects),
    targetSec: Number.isFinite(sec) && sec > 0 ? Math.min(3600, Math.round(sec)) : 0,
    platform: pick(b.platform, a.platforms),
    look: pick(b.look, a.looks),
    genreMode: mode,
  };
}

/** 默认配置（老项目无该字段时就是它，保证行为与未引入技能包前完全一致）。 */
export const DEFAULT_SKILL_PROFILE = {
  lens: '', genres: [], form: '', aspect: '', targetSec: 0, platform: '', look: '', genreMode: 'auto',
};
