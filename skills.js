/**
 * @ninkch/dsh-infinite-canvas — 技能提供者（媒体创作预设随本包分发）
 *
 * 模式沿用 @ninkch/dsh-artcraft/skills：`inject: ['skills']` 是硬依赖，
 * 单独成行，即使某环境没有 skills 服务也只影响本行，不拖垮预设其余部分。
 *
 * 技能来源：包内 skills/<name>/SKILL.md（YAML frontmatter: name + description）。
 * rank 600 与内置技能同级 —— 项目级（100/200）与用户级（400/500）技能可覆盖同名技能。
 * 随包分发：装好本包 = 导演工作坊引导技能自动就位，无需手工拷贝到 ~/.dsh/skills。
 *
 * ── 版本无关性（v1.2.0 起）───────────────────────────────────────────────
 * 预设正文不写透镜/题材/规格/影调/编排链的份数与名单：它们会随
 * @ninkch/dsh-infinite-canvas 与 @ninkch/dsh-artcraft 的版本增长。
 * 本文件在**加载技能时**用 require.resolve 定位这两个已安装的包，实时读取
 *
 *   <canvas>/assets/canvas-director/manifest.json   → lenses/genres/industries/forms/looks/moves
 *   <artcraft>/recipes/recipes.json                 → chains/recipes
 *
 * 并把当期清单作为附录拼在技能正文末尾。读不到（包未装、版本过旧、路径异常）时
 * **静默省略，绝不抛错**——技能本体永远可用。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(HERE, 'skills');
const PROVIDER = 'media-studio';
const RANK = 600;

const CANVAS_PKG = '@ninkch/dsh-infinite-canvas';
const ARTCRAFT_PKG = '@ninkch/dsh-artcraft';

/** 附录默认上限（字符）。技能正文约 2.6k，DSH 工具结果修剪阈值 8192，
 * 故附录留到 5000 以内，保证"正文+附录"整体不被修剪截断。 */
const DEFAULT_SNAPSHOT_MAX = 5000;

const CANVAS_LAYERS = [
  ['lenses', '导演透镜'],
  ['genres', '叙事题材'],
  ['industries', '行业题材'],
  ['forms', '规格'],
  ['looks', '影调质感'],
];

/** Cordis 插件名 */
export const name = 'media-studio-skills';
/** 需要技能服务 */
export const inject = ['skills'];

/** 解析 SKILL.md 的 YAML frontmatter（只取扁平的 name/description 标量，够用且不引入依赖） */
function parseSkill(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  if (!meta.name || !meta.description) return null;
  return { name: meta.name, description: meta.description, content: raw.slice(m[0].length).trim() };
}

/** 扫描包内技能目录，产出候选清单 */
async function loadCatalog() {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return out; // 无 skills/ 目录 → 空目录（不报错）
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, ent.name, 'SKILL.md');
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = parseSkill(raw);
      if (!parsed) continue;
      out.push({
        name: parsed.name,
        description: parsed.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER,
        source: 'bundled',
        rank: RANK,
        resourceBase: { kind: 'directory', path: path.dirname(file) },
        locator: file,
      });
    } catch { /* 单个技能读取失败不影响其余 */ }
  }
  return out;
}

// ── 上游清单快照 ────────────────────────────────────────────────────────────

/** require.resolve 的解析锚点：包自身 → 往上逐级找 node_modules（覆盖 profile/开发目录两种安装形态）。 */
function resolveAnchors() {
  const anchors = [path.join(HERE, 'package.json')];
  let dir = HERE;
  for (let i = 0; i < 6; i += 1) {
    dir = path.dirname(dir);
    if (!dir || dir === path.dirname(dir)) break;
    anchors.push(path.join(dir, 'package.json'));
  }
  return anchors;
}

/**
 * 定位已安装的上游包目录；失败返回 null（不抛错）。
 *
 * 覆盖三种安装形态：
 *   A. 预设与上游同在 profile 的 node_modules（npm 安装）—— 锚点向上 6 级必命中；
 *   B. 预设为 link:（本地开发）、上游也在同一工作区 —— 向上查找同样覆盖；
 *   C. 预设 npm 安装、上游为 link: 指到别处 —— 上面的锚点走不出去，
 *      再从 DSH 标准目录（环境变量 DSH_HOME 或主目录下的 .dsh，及其每个
 *      profile 的 node_modules）兜底。
 * 目录一律来自运行时环境，不写死任何机器路径。
 */
function resolvePkgDir(pkgName) {
  const spec = `${pkgName}/package.json`;
  for (const anchor of resolveAnchors()) {
    try {
      return path.dirname(createRequire(anchor).resolve(spec));
    } catch { /* 换下一个锚点 */ }
  }
  // C 形态兜底：扫描 DSH 标准目录下的 profile node_modules（同步、一次性、量级为个位数）
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const profiles = path.join(home, 'profiles');
    for (const name of fsSync.readdirSync(profiles)) {
      const nm = path.join(profiles, name, 'node_modules');
      const direct = path.join(nm, ...pkgName.split('/'));
      try {
        if (fsSync.statSync(path.join(direct, 'package.json')).isFile()) return direct;
      } catch { /* 该 profile 没有此包 */ }
    }
  } catch { /* 无 DSH 目录或不可读 */ }
  return null;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readVersion(pkgDir) {
  const pkg = pkgDir ? await readJson(path.join(pkgDir, 'package.json')) : null;
  return (pkg && typeof pkg.version === 'string') ? pkg.version : '';
}

function toList(v) {
  return Array.isArray(v) ? v : [];
}

/** `id=名字`，或仅 `id`。 */
function renderItems(list, withName) {
  return list
    .map((x) => {
      const id = x && x.id != null ? String(x.id) : '';
      if (!id) return '';
      if (!withName) return id;
      const nm = x && x.name != null ? String(x.name) : '';
      return nm ? `${id}=${nm}` : id;
    })
    .filter(Boolean)
    .join('　');
}

function groupBy(list) {
  const by = new Map();
  for (const it of list) {
    const g = (it && it.group != null) ? String(it.group) : '';
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(it);
  }
  return by;
}

/**
 * 画布清单块。
 * level 0 = 分组 + id=名字；1 = 每层 id 列表；2 = 只报份数。
 */
function renderCanvas(manifest, level) {
  const out = [];
  for (const [key, label] of CANVAS_LAYERS) {
    const list = toList(manifest[key]);
    if (!list.length) continue;
    if (level === 0) {
      out.push(`- ${label}（${list.length}）`);
      for (const [g, arr] of groupBy(list)) {
        out.push(`  · ${g ? `${g}：` : ''}${renderItems(arr, true)}`);
      }
    } else if (level === 1) {
      out.push(`- ${label}（${list.length}）：${renderItems(list, false)}`);
    } else {
      out.push(`- ${label}（${list.length}）`);
    }
  }
  const moves = toList(manifest.moves);
  if (moves.length) {
    out.push(level === 2
      ? `- 运镜与节奏（${moves.length}）`
      : `- 运镜与节奏（${moves.length}）：${renderItems(moves, level === 0)}`);
  }
  return out.join('\n');
}

/** ArtCraft 编排链块。level 0 = id=标题；1 = 仅 id；2 = 只报份数。 */
function renderArtcraft(recipes, level) {
  const chains = toList(recipes.chains);
  const formula = toList(recipes.recipes);
  const out = [];
  if (chains.length) {
    out.push(`- 编排链（${chains.length}）`);
    if (level === 2) {
      /* 只报份数 */
    } else {
      out.push(`  · ${renderItems(chains, level === 0)}`);
    }
  }
  if (formula.length) {
    out.push(level === 2
      ? `- 配方（${formula.length}）`
      : `- 配方（${formula.length}）：${renderItems(formula, false)}`);
  }
  return out.join('\n');
}

/**
 * 组装快照附录。分级降级：画布给全量中文名（选导演必需）→ 画布仅 id →
 * 全层只报份数；仍超限则截断。ArtCraft 链始终只给 id（标题可由
 * artcraft_recipes 现场取，不值得占快照预算）。任何一步失败都返回 ''。
 */
async function buildSnapshot(maxChars) {
  // 画布 manifest 与本文件同包（assets/canvas-director/manifest.json），优先自定位；
  // resolvePkgDir 仅作为异常兜底（例如安装形态导致的路径重排）。
  const canvasDir = fsSync.existsSync(path.join(HERE, 'assets', 'canvas-director', 'manifest.json'))
    ? HERE
    : resolvePkgDir(CANVAS_PKG);
  const artDir = resolvePkgDir(ARTCRAFT_PKG);
  if (!canvasDir && !artDir) return '';

  const [canvasVersion, artVersion] = await Promise.all([
    readVersion(canvasDir),
    readVersion(artDir),
  ]);

  const manifest = canvasDir
    ? await readJson(path.join(canvasDir, 'assets', 'canvas-director', 'manifest.json'))
    : null;
  const recipes = artDir
    ? await readJson(path.join(artDir, 'recipes', 'recipes.json'))
    : null;

  if (!manifest && !recipes) return '';

  const head = [
    '',
    '',
    '---',
    '',
    '## 当期清单快照（加载时自动生成，勿手改）',
    '',
    '> 本段由 `@ninkch/dsh-infinite-canvas/skills` 在本技能加载时，实时读取**这台机器上已安装**的包生成。',
    '> 它只代表当前机器与当前版本；与你的工具返回值冲突时，**一律以工具返回值（`canvas_list_skills` / `artcraft_recipes`）为准**。',
    '',
  ].join('\n');

  const build = (canvasLevel, artLevel) => {
    const parts = [head];
    if (manifest) {
      const block = renderCanvas(manifest, canvasLevel);
      if (block) {
        parts.push(`### ${CANVAS_PKG}${canvasVersion ? ` v${canvasVersion}` : ''}`);
        parts.push(block);
      }
    }
    if (recipes) {
      const block = renderArtcraft(recipes, artLevel);
      if (block) {
        parts.push('');
        parts.push(`### ${ARTCRAFT_PKG}${artVersion ? ` v${artVersion}` : ''}`);
        parts.push(block);
      }
    }
    // 两段都没渲染出内容 → 无意义附录，返回空串让调用方跳过
    return parts.length > 1 ? parts.join('\n').replace(/\n{3,}/g, '\n\n') : '';
  };

  // 画布中文名优先；画布降级到 1/2 时，ArtCraft 也跟着降。
  for (const [cl, al] of [[0, 1], [0, 2], [1, 1], [1, 2], [2, 2]]) {
    const text = build(cl, al);
    if (text.length <= maxChars) {
      return cl === 2
        ? `${text}\n\n（篇幅所限，仅报份数；具体名单请调 canvas_list_skills / artcraft_recipes。）`
        : text;
    }
  }

  return '';
}

export function apply(ctx, config = {}) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const includeSnapshot = cfg.includeLiveSnapshot !== false;
  const maxChars = Number.isFinite(cfg.snapshotMaxChars) && cfg.snapshotMaxChars > 0
    ? Math.floor(cfg.snapshotMaxChars)
    : DEFAULT_SNAPSHOT_MAX;

  const provider = {
    name: PROVIDER,
    list: () => loadCatalog(),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate;
      const raw = await fs.readFile(locator, { encoding: 'utf8', signal: options?.signal });
      const parsed = parseSkill(raw);
      let content = parsed ? parsed.content : raw;

      // 附加当期上游清单（失败静默降级，绝不影响技能本体）
      if (includeSnapshot && !options?.signal?.aborted) {
        try {
          const snapshot = await buildSnapshot(maxChars);
          if (snapshot) content = `${content}${snapshot}`;
        } catch { /* 快照是增强，不是必需 */ }
      }

      // 每次加载都重读文件：改技能正文无需版本号或缓存失效
      // Host 合同：get() 必须返回**扁平的 skill 对象**（name/description/invocation/provider/source
      // /resourceBase/content 直接在顶层）。此前返回 { summary, content }，Host 读 definition.name
      // 得到 undefined → "loaded skill name must be a string"，director-workshop 技能加载失败。
      return {
        name: summary.name,
        description: summary.description,
        invocation: summary.invocation,
        provider: summary.provider,
        source: summary.source,
        rank: summary.rank,
        resourceBase: summary.resourceBase,
        content,
      };
    },
  };
  ctx.skills.registerProvider(() => provider);
}
