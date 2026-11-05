/**
 * @ninkch/dsh-infinite-canvas — 制作阶段机与流程闸门（0.20.0）
 *
 * 设计原则（借自 dsh-superagent-prototype）：
 *   「提示词负责解释，代码负责禁止」——凡可机械判定的流程规则都在这里用代码强制，
 *   提示词（canvas-studio / canvas-production 技能）只负责解释"为什么"与"怎么补"。
 *
 * 两条铁律：
 *   1. **流程规范 ≠ 内容模板**：本模块只规定"操作顺序"与"花钱/毁数据前的检查"，
 *      绝不规定故事内容——剧情走向永远是作者（用户）的。
 *   2. **用户显式指令永远优先**：每道闸门都可用 override（用户原话）越过，越界行为
 *      全部记入审计（overrides），事后可查。
 *
 * 阶段机（每个画布 = 一集，独立状态，存 <projectHomeDir>/production/<canvasKey>.json）：
 *   brief → bible → assets → script → storyboard → shots_ready → generating → qc → post → delivered
 *   - floor：工具事件只会**抬高**它（写设定集 ≥bible、写剧本 ≥script、出镜头 ≥storyboard…）
 *   - explicit：productionAdvance 显式设定（可回退 = 返工），回退同时下调 floor
 *   - 生效阶段 = explicit ?? max(floor, inferred)；旧项目无状态文件时从文档内容**推断**，不阻塞
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

/** 阶段枚举（顺序即优先级，index 越大越靠后）。 */
export const PRODUCTION_STAGES = ['brief', 'bible', 'assets', 'script', 'storyboard', 'shots_ready', 'generating', 'qc', 'post', 'delivered'];
export const PRODUCTION_STAGE_ZH = {
  brief: '立项', bible: '设定集', assets: '参考图', script: '剧本', storyboard: '分镜',
  shots_ready: '分镜定稿', generating: '生成中', qc: '质检', post: '后期', delivered: '已交付',
};
const STAGE_INDEX = Object.fromEntries(PRODUCTION_STAGES.map((s, i) => [s, i]));

/** 景别规范词（画面描述必须含其一，否则"景别不具体"）。 */
const SHOTSIZE_WORDS = ['大特写', '特写', '近景', '中近景', '中景', '中全景', '全景', '远景'];
/** seg 规范取值（canvas_update_node 已做归一化，这里只认规范值）。 */
const SEG_CANON = new Set(['opening', 'continuation', 'scene_change', 'new_character', 'closeup']);
/** 状态上限：history / overrides 各自最多保留条数。 */
const CAP = 40;

/**
 * 创建制作状态管理器。deps 全部来自 index.js 的模块内函数（运行时才调用，无循环导入问题）：
 *   projectHomeDir(pid)                  项目落盘目录（工作区内嵌 / 数据根）
 *   readToolDoc({projectId,canvasId})    画布文档（项目级字段已合并）
 *   readDoc(pid)                         项目文档（bible 的权威源）
 *   normalizeCanvasId(v)                 画布 id 规范化
 */
export function createProduction(deps) {
  const homeOf = (pid) => {
    try { return deps.projectHomeDir(pid) || null; } catch { return null; }
  };
  const dirOf = (pid) => {
    const home = homeOf(pid);
    return home ? path.join(home, 'production') : null;
  };
  const keyOf = (cid) => {
    let k = 'default';
    try { k = deps.normalizeCanvasId(cid) || 'default'; } catch { k = 'default'; }
    return k;
  };
  const fileOf = (pid, cid) => {
    const d = dirOf(pid);
    return d ? path.join(d, keyOf(cid) + '.json') : null;
  };

  /** 读状态；缺失/损坏一律容错为 null（调用方走推断路径）。 */
  function readState(pid, cid) {
    const f = fileOf(pid, cid);
    if (!f || !existsSync(f)) return null;
    try {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      if (m && typeof m === 'object' && Number.isFinite(m.floor)) return m;
    } catch { /* 损坏 → 视同缺失 */ }
    return null;
  }

  /** 原子写状态：覆盖前留 .backup.json（上次良好状态）。 */
  function writeState(pid, cid, state) {
    const f = fileOf(pid, cid);
    if (!f) return null;
    mkdirSync(path.dirname(f), { recursive: true });
    try { if (existsSync(f)) copyFileSync(f, f + '.backup.json'); } catch { /* 备份失败不阻塞 */ }
    const tmp = f + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    renameSync(tmp, f);
    return f;
  }

  const push = (list, entry) => [...(list || []), entry].slice(-CAP);

  /** 从文档内容推断阶段（旧项目/无状态文件时用）：取所有信号的**最大值**。 */
  function inferStage(doc, projectDoc) {
    const nodes = Object.values((doc && doc.nodes) || {});
    let idx = 0; // brief
    const bible = (projectDoc && projectDoc.bible) || (doc && doc.bible) || {};
    const bibleFull = String(bible.worldview || '').trim() && String(bible.style || '').trim() && (bible.characters || []).length > 0;
    const bibleAny = String(bible.worldview || '').trim() || String(bible.style || '').trim() || (bible.characters || []).length > 0;
    if (bibleAny) idx = Math.max(idx, STAGE_INDEX.bible);
    const isDone = (n) => String((n && n.data && n.data.status) || '') === 'done';
    if (nodes.some((n) => n.type === 'image' && (n.data && (n.data.assetId || isDone(n))))) idx = Math.max(idx, STAGE_INDEX.assets);
    if (nodes.some((n) => n.type === 'script')) idx = Math.max(idx, STAGE_INDEX.script);
    const sbWithShots = nodes.filter((n) => n.type === 'storyboard' && Array.isArray(n.data && n.data.shots) && n.data.shots.length);
    if (sbWithShots.length) {
      idx = Math.max(idx, STAGE_INDEX.storyboard);
      // 推断时顺手跑质量闸门：全部通过才承认 shots_ready（历史数据按现状评估）
      if (sbWithShots.every((n) => gateStoryboard(n.data.shots).ok)) idx = Math.max(idx, STAGE_INDEX.shots_ready);
    }
    if (nodes.some((n) => n.type === 'video' && ['running', 'generating'].includes(String(n.data && n.data.status)))) idx = Math.max(idx, STAGE_INDEX.generating);
    if (nodes.some((n) => n.type === 'video' && isDone(n))) idx = Math.max(idx, STAGE_INDEX.qc);
    if (nodes.some((n) => n.type === 'finalcut' && isDone(n))) idx = Math.max(idx, STAGE_INDEX.post);
    if (bibleFull && idx < STAGE_INDEX.bible) idx = STAGE_INDEX.bible;
    return idx;
  }

  /**
   * 生效阶段（不落盘）：有状态文件 → 以状态为准（floor 由工具事件抬升、explicit 可回退）；
   * 无状态文件（老项目）→ 纯文档推断，绝不阻塞。推断结果在首次 note/advance 时固化进 floor。
   */
  function stageOf(pid, cid) {
    let doc = null;
    let projectDoc = null;
    try { doc = deps.readToolDoc({ projectId: pid, canvasId: cid }); } catch { doc = null; }
    try { projectDoc = deps.readDoc(pid); } catch { projectDoc = null; }
    const inferred = inferStage(doc, projectDoc);
    const state = readState(pid, cid);
    const floor = state ? Math.max(Number(state.floor) || 0, 0) : inferred;
    const explicit = state && Number.isFinite(state.explicit) ? state.explicit : null;
    const idx = explicit != null ? Math.max(explicit, floor) : floor;
    return { idx, stage: PRODUCTION_STAGES[idx], floor, explicit, inferred, state, doc, projectDoc };
  }

  /** 工具事件汇报：只抬高 floor（历史追加）。why 是机器可读的事件名（bible/script/video_run…）。 */
  function noteStage(pid, cid, stageName, why) {
    const to = STAGE_INDEX[stageName];
    if (!Number.isFinite(to)) return null;
    const cur = stageOf(pid, cid);
    const state = cur.state || {
      version: 1, projectId: pid, canvasKey: keyOf(cid),
      floor: cur.inferred, explicit: null, createdAt: Date.now(), updatedAt: 0, history: [], overrides: [],
    };
    const from = Math.max(Number(state.floor) || 0, 0);
    state.floor = Math.max(from, to);
    state.updatedAt = Date.now();
    if (to !== from) {
      state.history = push(state.history, { at: Date.now(), from: PRODUCTION_STAGES[from], to: stageName, why: String(why || ''), by: 'auto' });
    } else if (!cur.state) {
      state.history = push(state.history, { at: Date.now(), from: PRODUCTION_STAGES[from], to: PRODUCTION_STAGES[from], why: 'init', by: 'auto' });
    }
    writeState(pid, cid, state);
    return state;
  }

  /** 显式推进/回退（返工）：同时改 explicit 与 floor（authoritative），必带 reason，进历史。 */
  function advance(pid, cid, toName, reason, by) {
    const to = STAGE_INDEX[toName];
    if (!Number.isFinite(to)) return { ok: false, error: '未知阶段: ' + toName + '（可选：' + PRODUCTION_STAGES.join(' / ') + '）' };
    const why = String((reason || '').trim());
    if (!why) return { ok: false, error: '缺少 reason：显式推进/回退必须说明原因（审计要求）' };
    const cur = stageOf(pid, cid);
    const state = cur.state || {
      version: 1, projectId: pid, canvasKey: keyOf(cid),
      floor: cur.inferred, explicit: null, createdAt: Date.now(), updatedAt: 0, history: [], overrides: [],
    };
    const from = cur.idx;
    state.explicit = to;
    state.floor = to;
    state.updatedAt = Date.now();
    state.history = push(state.history, { at: Date.now(), from: PRODUCTION_STAGES[from], to: toName, why, by: String(by || 'user') });
    writeState(pid, cid, state);
    return { ok: true, from: PRODUCTION_STAGES[from], to: toName, stage: toName };
  }

  /** 审计一条越闸记录（override）。gate=闸门代码，quote=用户原话。 */
  function recordOverride(pid, cid, gate, quote, extra) {
    const cur = stageOf(pid, cid);
    const state = cur.state || {
      version: 1, projectId: pid, canvasKey: keyOf(cid),
      floor: cur.inferred, explicit: null, createdAt: Date.now(), updatedAt: 0, history: [], overrides: [],
    };
    state.overrides = push(state.overrides, { at: Date.now(), gate: String(gate || ''), quote: String(quote || '').slice(0, 200), ...(extra || {}) });
    state.updatedAt = Date.now();
    writeState(pid, cid, state);
  }

  // ── A1 两段式：预算单与一次性批准令牌 ────────────────────────────────

  /** 稳定指纹：同样的镜头/时长/单价 → 同一个 quoteId；任何一项变了 → 指纹变（旧批准自动失效）。 */
  function fingerprint(payload) {
    let h = 5381;
    const s = JSON.stringify(payload);
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'q' + h.toString(36) + '-' + s.length.toString(36);
  }

  /**
   * 预算单（免费段终点）：只统计"将要花钱"的东西——每个分镜表一次视频调用、总秒数、场/镜数。
   * 单价由调用方传入（画布设置里的单价，未配置则不给金额，只给调用次数与秒数）。
   */
  function quote(pid, cid, unitPricePerSecond) {
    const st = stageOf(pid, cid);
    const doc = st.doc || { nodes: {} };
    const nodes = Object.values(doc.nodes || {});
    const sbs = nodes.filter((n) => n.type === 'storyboard' && Array.isArray(n.data && n.data.shots) && n.data.shots.length);
    const videoNodes = nodes.filter((n) => n.type === 'video');
    let totalSeconds = 0;
    const scenes = sbs.map((n, i) => {
      const shots = n.data.shots || [];
      const secs = shots.reduce((a, s) => a + (Number(s && s.duration) || 0), 0);
      totalSeconds += secs;
      return {
        scene: i + 1,
        storyboardId: n.id,
        name: String((n.data && n.data.label) || n.id),
        shots: shots.length,
        seconds: Math.round(secs * 10) / 10,
        hasVideo: videoNodes.some((v) => (doc.edges || []).some((e) => e.fromNode === n.id && e.toNode === v.id)),
      };
    });
    const pending = scenes.filter((s) => !s.hasVideo).length;
    const price = Number(unitPricePerSecond);
    const payload = { pid, cid: keyOf(cid), scenes: scenes.map((s) => [s.storyboardId, s.shots, s.seconds]), pending };
    return {
      ok: true, quoteId: fingerprint(payload),
      projectId: pid, canvasId: keyOf(cid) === 'default' ? null : keyOf(cid),
      stage: st.stage,
      scenes, sceneCount: scenes.length, shotCount: scenes.reduce((a, s) => a + s.shots, 0),
      totalSeconds: Math.round(totalSeconds * 10) / 10,
      videoCalls: pending,
      unitPricePerSecond: Number.isFinite(price) && price > 0 ? price : null,
      estimatedCost: Number.isFinite(price) && price > 0 ? Math.round(price * totalSeconds * 100) / 100 : null,
      note: pending === 0 ? '全部分镜表都已有视频节点：本次只做重生成，不产生新调用' : '批准后只按差分镜表各调用一次视频接口（按秒计费）',
    };
  }

  /** 批准（一次性令牌）：quoteId 必须与当前文档指纹一致，否则拒绝（镜头变了就得重新看预算）。 */
  function approve(pid, cid, quoteId, confirm, unitPricePerSecond) {
    const q = quote(pid, cid, unitPricePerSecond);
    const given = String(quoteId || '').trim();
    if (!given) return { ok: false, error: '缺少 quoteId：先调 autoQuote 生成预算单，用户看过后再批准' };
    if (given !== q.quoteId) return { ok: false, expired: true, error: '预算单已过期（镜头/时长/新增分镜表发生了变化）——请重新 autoQuote 并让用户复核后再批准', current: q.quoteId };
    const words = String(confirm || '').trim();
    if (!words) return { ok: false, error: '缺少 confirm：批准付费生成必须携带用户确认原话（审计要求）' };
    const cur = stageOf(pid, cid);
    const state = cur.state || {
      version: 1, projectId: pid, canvasKey: keyOf(cid),
      floor: cur.inferred, explicit: null, createdAt: Date.now(), updatedAt: 0, history: [], overrides: [],
    };
    state.approval = { quoteId: q.quoteId, at: Date.now(), by: 'user', confirm: words.slice(0, 200), videoCalls: q.videoCalls, totalSeconds: q.totalSeconds };
    state.updatedAt = Date.now();
    writeState(pid, cid, state);
    return { ok: true, approved: true, quoteId: q.quoteId, videoCalls: q.videoCalls, totalSeconds: q.totalSeconds };
  }

  /** 当前批准是否仍然有效（预算指纹未变）；返回 null 表示没有批准。 */
  function approvalOf(pid, cid, unitPricePerSecond) {
    const state = readState(pid, cid);
    if (!state || !state.approval) return null;
    const q = quote(pid, cid, unitPricePerSecond);
    const valid = state.approval.quoteId === q.quoteId;
    return { ...state.approval, valid, currentQuoteId: q.quoteId };
  }

  // ── 闸门 ────────────────────────────────────────────────────────────────

  /**
   * G1 设定集先行（拦**生成**，不拦节点搭建）：剧本/分镜表真正生成内容前，
   * 设定集必须有世界观 + 风格 + ≥1 角色。返回 missing 清单供补全。
   */
  function gateBible(bible) {
    const b = bible || {};
    const missing = [];
    if (!String(b.worldview || '').trim()) missing.push('worldview（世界观/核心设定）');
    if (!String(b.style || '').trim()) missing.push('style（风格基调）');
    if (!Array.isArray(b.characters) || !b.characters.length) missing.push('characters（至少 1 个角色）');
    return { ok: missing.length === 0, code: 'G1', missing };
  }

  /**
   * G2 分镜质量闸门（建/跑视频节点前）：只查**机械可判定**项；
   * 冲突点/因果钩子这类需要创作判断的项放 warns（由 canvas-craft 技能与自检清单负责）。
   */
  function gateStoryboard(shots) {
    const fails = [];
    const warns = [];
    const arr = Array.isArray(shots) ? shots : [];
    if (!arr.length) {
      fails.push('分镜表还没有任何镜头（shots 为空）——先 canvas_run_node 分镜表生成镜头，绝不手工编造镜头表');
      return { ok: false, code: 'G2', fails, warns };
    }
    if (arr.length > 24) fails.push('镜头 ' + arr.length + ' 个超过单表上限 24——请按场景拆分为多个分镜表');
    const normMotion = (s) => String((s && s.motion) || '').trim().toLowerCase();
    arr.forEach((s, i) => {
      const no = '镜' + (i + 1);
      const visual = String((s && s.visual) || '').trim();
      if (!(Number(s && s.duration) > 0)) fails.push(no + ' 缺少时长（duration 必须为正数）');
      if (!visual) fails.push(no + ' 缺少画面描述（visual）');
      else if (!SHOTSIZE_WORDS.some((w) => visual.includes(w))) fails.push(no + ' 景别不具体（画面需含 大特写/特写/近景/中近景/中景/中全景/全景/远景 之一）');
      const seg = String((s && s.seg) || '').trim().toLowerCase();
      if (seg && !SEG_CANON.has(seg)) fails.push(no + ' seg 取值非法：' + seg + '（只能是 opening/continuation/scene_change/new_character/closeup）');
      if (!seg || !String((s && s.tail) || '').trim() || !String((s && s.cam) || '').trim()) {
        warns.push(no + ' 缺衔接字段（' + (['seg', 'tail', 'cam'].filter((k) => !String((s && s[k]) || '').trim()).join('/')) + '）——跨段接戏靠这四个字段，建议 canvas_update_node 补齐');
      }
      const dlg = s && s.dialogue;
      const dlgText = typeof dlg === 'string' ? dlg : Array.isArray(dlg) ? dlg.join(' ') : '';
      if (dlgText.trim() && !dlgText.includes('：') && !dlgText.includes(':')) warns.push(no + ' 台词建议逐行「角色：台词」格式（音画同步依赖它）');
    });
    if (arr.length && !arr.some((s) => String((s && s.visual) || '').includes('大特写'))) {
      fails.push('全表没有一个「大特写」——每场至少 1 个大特写（分镜自检硬项）');
    }
    for (let i = 0; i + 2 < arr.length; i++) {
      const a = normMotion(arr[i]);
      if (a && a === normMotion(arr[i + 1]) && a === normMotion(arr[i + 2])) {
        fails.push('镜' + (i + 1) + '–' + (i + 3) + ' 连续三镜运动完全相同（「' + String(arr[i].motion).trim() + '」）——连续三镜必须不同运动');
        break;
      }
    }
    return { ok: fails.length === 0, code: 'G2', fails, warns };
  }

  /** G6 阶段越序：付费/重操作要求生效阶段到达某一步。 */
  function gateStage(pid, cid, needName) {
    const need = STAGE_INDEX[needName];
    const cur = stageOf(pid, cid);
    return {
      ok: cur.idx >= need, code: 'G6',
      at: cur.stage, atIdx: cur.idx, need: needName, needIdx: need,
    };
  }

  /** G4 禁止逐镜节点：名字含「镜N」的图片/视频节点 = 走错路（一致性靠参考图资产，不靠逐镜节点）。 */
  function gateShotNodeName(name, type) {
    if (type !== 'image' && type !== 'video') return { ok: true };
    if (/[镜]\s*\d+/.test(String(name || ''))) {
      return {
        ok: false, code: 'G4',
        error: '「' + String(name).slice(0, 40) + '」是逐镜节点命名——多镜头一致性靠角色/场景参考图资产（@资产名@ 自动挂载），视频一次生成全部镜头，不要为单个镜头建节点。最多为开场首帧或 1–2 个关键镜头补定帧图（命名不带「镜N」）。',
      };
    }
    return { ok: true };
  }

  /** G3 一表一视频：同一分镜表下已存在视频节点 → 拒绝再建第二个。 */
  function gateOneVideoPerStoryboard(doc, storyboardId) {
    if (!storyboardId) return { ok: true };
    const edges = (doc && doc.edges) || [];
    const fromSb = new Set(edges.filter((e) => e && e.fromNode === storyboardId).map((e) => e.toNode));
    const nodes = (doc && doc.nodes) || {};
    const existing = Object.values(nodes).filter((n) => n && n.type === 'video' && fromSb.has(n.id));
    if (existing.length) {
      return {
        ok: false, code: 'G3',
        error: '该分镜表已有视频节点「' + (existing[0].data && existing[0].data.label || existing[0].id) + '」（一个分镜表 = 一个完整视频）。改提示词/参数用 canvas_update_node 重生成，不要新建第二个视频节点。',
        existingVideoId: existing[0].id,
      };
    }
    return { ok: true };
  }

  /**
   * 状态汇报：模型宣称"完成/可交付"前必须以此为据（ready:true 才允许说完成）。
   * next 按**当前阶段**给下一步建议——只管操作顺序，不管内容。
   */
  function status(pid, cid) {
    const st = stageOf(pid, cid);
    const doc = st.doc || { nodes: {}, edges: [] };
    const nodes = Object.values(doc.nodes || {});
    const bible = (doc && doc.bible) || {};
    const g1 = gateBible(bible);
    const sbs = nodes.filter((n) => n.type === 'storyboard' && Array.isArray(n.data && n.data.shots) && n.data.shots.length);
    const lastSb = sbs.length ? sbs[sbs.length - 1] : null;
    const g2 = lastSb ? gateStoryboard(lastSb.data.shots) : { ok: false, code: 'G2', fails: ['还没有任何分镜表产出镜头'], warns: [] };
    const videos = nodes.filter((n) => n.type === 'video');
    const finalcuts = nodes.filter((n) => n.type === 'finalcut');
    const blockers = [];
    if (!g1.ok) blockers.push({ gate: 'G1', detail: g1.missing });
    if (st.idx >= STAGE_INDEX.storyboard && !g2.ok) blockers.push({ gate: 'G2', detail: g2.fails });
    const NEXT_BY_STAGE = {
      brief: '补全设定集（canvas_update_bible）：世界观/风格/角色/场景/道具——这是全片一致性的唯一依据',
      bible: '写剧本节点（idea → canvas_run_node 生成成稿）；参考图资产可并行生成',
      assets: '写剧本节点；已有参考图的实体直接 @资产名@ 引用',
      script: '按【场N】把剧本铺开到场景文本节点，再逐场建分镜表（源端=场景文本，tail→prev 串联）',
      storyboard: 'canvas_run_node 分镜表生成 shots，读回后按六条自检核对（判定以本工具 gates.storyboard 为准）',
      shots_ready: '过质量闸门后逐场建视频节点（一表一视频）并 canvas_generate_node；生成前本工具会给出预算要素',
      generating: '等待视频完成（canvas_node_status），注意 genWarn 与接缝校验结果',
      qc: '核对一致性告警/接缝/口型；用户验收后进入后期（ArtCraft 家族）',
      post: 'ArtCraft 后期（调色/混音/成片渲染）；执行按钮在画布 UI 上',
      delivered: '本集已交付；开工新一集前先 canvas_read_memory 读调度索引',
    };
    return {
      ok: true,
      projectId: pid,
      canvasId: deps.normalizeCanvasId(cid) || null,
      stage: st.stage,
      stageZh: PRODUCTION_STAGE_ZH[st.stage],
      stageIndex: st.idx,
      explicit: st.explicit != null ? PRODUCTION_STAGES[st.explicit] : null,
      inferred: PRODUCTION_STAGES[st.inferred],
      gates: { bible: g1, storyboard: g2 },
      blockers,
      ready: st.idx >= STAGE_INDEX.shots_ready && g1.ok && g2.ok,
      brief: st.state && st.state.brief,
      evidence: {
        characters: (bible.characters || []).length,
        scenes: (bible.scenes || []).length,
        props: (bible.props || []).length,
        scripts: nodes.filter((n) => n.type === 'script').length,
        scriptsDone: nodes.filter((n) => n.type === 'script' && String((n.data && n.data.output) || '').trim()).length,
        storyboards: nodes.filter((n) => n.type === 'storyboard').length,
        storyboardsWithShots: sbs.length,
        shotsTotal: sbs.reduce((a, n) => a + (n.data.shots || []).length, 0),
        images: nodes.filter((n) => n.type === 'image').length,
        imagesDone: nodes.filter((n) => n.type === 'image' && (n.data && (n.data.assetId || String(n.data.status) === 'done'))).length,
        videos: videos.length,
        videosDone: videos.filter((n) => String((n.data && n.data.status) || '') === 'done').length,
        finalcuts: finalcuts.length,
      },
      next: NEXT_BY_STAGE[st.stage] || '',
      history: (st.state && st.state.history) || [],
      overrides: (st.state && st.state.overrides) || [],
    };
  }

  return {
    readState, writeState, inferStage, stageOf, noteStage, advance, recordOverride, status,
    gateBible, gateStoryboard, gateStage, gateShotNodeName, gateOneVideoPerStoryboard,
    quote, approve, approvalOf,
    stageIndex: (name) => STAGE_INDEX[name], stageName: (idx) => PRODUCTION_STAGES[idx] || null,
  };
}
