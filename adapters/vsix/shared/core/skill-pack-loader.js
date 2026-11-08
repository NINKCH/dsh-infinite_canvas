/**
 * canvas-director 技能包的 Host 侧加载器。
 *
 * 职责：
 *  - 读 manifest.json 并缓存（文件未变不重复解析）；
 *  - 按层读卡文件（带缓存）；
 *  - 用 pack.js 的纯函数按生成能力切片并拼装；
 *  - 提供层清单供 canvas_list_skills 展示。
 *
 * 一切路径限制在 assets/canvas-director/ 之内；缺文件不抛错（该层跳过，由调用方决定是否提示）。
 */
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PACK_DIR_REL = 'assets/canvas-director';
export const LAYER_DIRS = {
  lenses: 'lenses',
  genres: 'genres',
  industries: 'industries',
  forms: 'forms',
  looks: 'looks',
};
/** 单数层名 → manifest 里的复数数组名（cards 用 lens/genre/... ，索引用 lenses/genres/...）。 */
export const LAYER_OF = {
  lens: 'lenses',
  genre: 'genres',
  industry: 'industries',
  form: 'forms',
  look: 'looks',
};
/** 复数数组名 → 读文件用的子目录名。 */
export const DIR_OF = LAYER_DIRS;

/** manifest 与各卡文件的缓存：key = 绝对路径，value = { mtimeMs, size, data }。 */
const fileCache = new Map();
/** pack.js 模块缓存。 */
let PACK_MOD = null;

/** 读文件并缓存（按 mtime+size 失效）。文件不存在返回 null。 */
function readCached(abs) {
  let st;
  try { st = statSync(abs); } catch { return null; }
  const hit = fileCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  const data = readFileSync(abs, 'utf8');
  fileCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

/** 清空缓存（测试用）。 */
export function clearPackCache() { fileCache.clear(); PACK_MOD = null; }

/** 懒加载 pack.js（纯函数模块，与 Client 同源）。 */
export async function getPackModule() {
  if (PACK_MOD) return PACK_MOD;
  const abs = path.join(HERE_DIR, PACK_DIR_REL, 'pack.js');
  if (!existsSync(abs)) throw new Error('缺少 pack.js：' + abs);
  PACK_MOD = await import(pathToFileURL(abs).href);
  return PACK_MOD;
}

/** 由 index.js 在模块初始化时注入（避免本文件反向依赖 index）。 */
let HERE_DIR = '';
export function initPackBase(hereDir) { HERE_DIR = String(hereDir || ''); }

/** 读 manifest（未解析的原始对象）。缺失返回 null。 */
export function readManifestRaw(hereDir) {
  const base = hereDir || HERE_DIR;
  const abs = path.join(base, PACK_DIR_REL, 'manifest.json');
  const raw = readCached(abs);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 读一层里的一张卡（按 manifest 的 file 字段）。layers 用 manifest 的复数名（lenses/genres/...）。缺失返回 null。 */
export function readCard(hereDir, layer, file) {
  const base = hereDir || HERE_DIR;
  const plural = LAYER_OF[layer] || layer;         // 允许传单数
  const dir = DIR_OF[plural];
  if (!dir) return null;
  const rel = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  const abs = path.join(base, PACK_DIR_REL, dir, rel);
  const baseDir = path.join(base, PACK_DIR_REL);
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) return null;
  return readCached(resolved);
}

/** 读 moves 下的文件（不属五层索引，按文件名直取）。 */
export function readMove(hereDir, file) {
  const base = hereDir || HERE_DIR;
  const rel = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  const abs = path.resolve(path.join(base, PACK_DIR_REL, 'moves', rel));
  const baseDir = path.resolve(path.join(base, PACK_DIR_REL, 'moves'));
  if (!abs.startsWith(baseDir + path.sep)) return null;
  return readCached(abs);
}

/** 层清单（给 canvas_list_skills 用）：每层数组，元素含 id/name/group/oneliner/tier/available。 */
export function packInventory(hereDir) {
  const base = hereDir || HERE_DIR;
  const raw = readManifestRaw(base);
  const out = { lenses: [], genres: [], industries: [], forms: [], looks: [], moves: [] };
  if (!raw) return out;
  for (const layer of Object.keys(LAYER_DIRS)) {
    const list = Array.isArray(raw[layer]) ? raw[layer] : [];
    out[layer] = list.map((it) => ({
      id: String(it.id || ''),
      name: String(it.name || ''),
      group: String(it.group || ''),
      oneliner: String(it.oneliner || ''),
      tier: String(it.tier || ''),
      aliases: Array.isArray(it.aliases) ? it.aliases.map(String) : [],
      glyph: String(it.glyph || it.id || ''),
      file: String(it.file || ''),
      available: !!readCard(base, layer, it.file),
    }));
  }
  const moves = Array.isArray(raw.moves) ? raw.moves : [];
  out.moves = moves.map((it) => ({
    id: String(it.id || ''),
    name: String(it.name || ''),
    file: String(it.file || ''),
    oneliner: String(it.oneliner || ''),
    available: !!readMove(base, it.file),
  }));
  return out;
}

/** 从 inventory 取某层某 id 的条目（layer 可传单数或复数）。 */
export function findEntry(inv, layer, id) {
  const plural = LAYER_OF[layer] || layer;
  const list = (inv && inv[plural]) || [];
  return list.find((x) => x.id === id) || null;
}

/** 全部合法 id（给 normalizeSkillProfile 的枚举用）。 */
export function allowedIds(inv) {
  return {
    lenses: ((inv && inv.lenses) || []).filter((x) => x.available).map((x) => x.id),
    genres: [...((inv && inv.genres) || []), ...((inv && inv.industries) || [])].filter((x) => x.available).map((x) => x.id),
    forms: ((inv && inv.forms) || []).filter((x) => x.available).map((x) => x.id),
    looks: ((inv && inv.looks) || []).filter((x) => x.available).map((x) => x.id),
  };
}
