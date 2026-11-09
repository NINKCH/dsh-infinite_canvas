/**
 * @ninkch/dsh-infinite-canvas — 按镜头切段（宿主侧权威估算器，0.20.2）
 *
 * 本模块是 client.js 里 planShotSegments 的**逐字移植**（零 npm 依赖的纯函数 ES module）：
 *   - shotVisualText       ← client.js L4189-4192
 *   - shotContinuityPlan   ← client.js L4201-4249
 *   - isCutPoint           ← client.js L4368-4370
 *   - planShotSegments     ← client.js L4389-4514
 *
 * 为什么必须逐字：真实视频调用次数由客户端切段决定（client.js expandStoryboard /
 * StoryboardNodeBody 都以 `planShotSegments(shots, { maxSeconds: Number(n.data.segMaxSeconds) || 15 })`
 * 的结果为准——一个分镜表 ≠ 一次生成）。宿主预算单（production.js quote）按这里的输出
 * 估算 videoCalls；任何语义简化都会让预算再次失真（#8：显示 4 次、实际 14 次）。
 *
 * 同步契约：改动 client.js 的切段算法时必须同步本文件，反之亦然。
 * 漂移守卫：scripts/test-quote-segments.mjs 用 vm 加载真实 client.js，把
 * window.__DSH_IC_SEGMENT__.planShotSegments 与本模块在同一组 fixtures 上断言输出一致——
 * 宿主估算与客户端执行漂移 = 预算单再次失真，测试红了就必须人工对齐两端。
 */

/** 镜头画面文本（visual + motion），用于衔接描述与相似度兜底。 */
function shotVisualText(sh) {
  if (!sh) return '';
  return [String(sh.visual || '').trim(), String(sh.motion || '').trim()].filter(Boolean).join('；');
}
/**
 * 镜头衔接规划：把「尾部状态 / 起始状态 / 运镜延续 / 段落类型 / 接缝档位」统一解出来。
 * 分镜字段可手写（tail/start/cam），缺失时用 visual 兜底——**绝不编造剧情**，只做"能确认的推断"。
 * seg:   'opening'（首段，交代）| 'continuation'（续帧，默认）| 'new_character'（新角色入场，参考图模式）
 *        | 'scene_change'（换场，不接尾帧）| 'closeup'（特写/细节插入，接缝不被画面盯着看 → 标准放宽）
 * join:  'strict'（同步长硬接）| 'loose'（跨场/换景，允许软接）| 'cut'（特写插入，跳切合理，不接力）
 * @returns {{seg,name,join,fromTail,fromShot,tail,start,cam,chain,note}}
 */
function shotContinuityPlan(sh, prev, idx) {
  const s = sh || {};
  const i = Number.isFinite(Number(idx)) ? Number(idx) : 0;
  const prevShot = i > 0 ? (prev || null) : null;
  const segRaw = String(s.seg || '').trim().toLowerCase();
  const SEG_ALIAS = {
    opening: 'opening', open: 'opening', '首段': 'opening', '开场': 'opening',
    continuation: 'continuation', cont: 'continuation', '续': 'continuation', '续帧': 'continuation', '承接': 'continuation',
    new_character: 'new_character', newchar: 'new_character', '新角色': 'new_character', '入场': 'new_character',
    scene_change: 'scene_change', scene: 'scene_change', '换场': 'scene_change', '转场': 'scene_change',
    closeup: 'closeup', insert: 'closeup', '特写': 'closeup', '插入': 'closeup',
    // 同机位状态跳变：切前不在/切后在（灯闪现身、影子凭空在场、影化实）——奇幻特效叙事的合法段落
    state_jump: 'state_jump', jump: 'state_jump', '跳变': 'state_jump', '状态跳变': 'state_jump',
  };
  let seg = SEG_ALIAS[segRaw] || '';
  const boxed = (k) => String(s[k] || '').trim();
  if (!seg) {
    if (!prevShot) seg = 'opening';
    else if (/换场|场景切换|转场|另一处|另一场景|切至|切到|次日|翌日|与此同时|数日后|[Cc]ut to/.test(shotVisualText(s))) seg = 'scene_change';
    else if (/新角色|首次出场|走进来|入镜|入场|冒出|推门进|[Ee]nters?/.test(shotVisualText(s))) seg = 'new_character';
    else if (Number(s.duration) > 0 && Number(s.duration) < 1.5 && !(s.dialogue || []).length) seg = 'closeup';
    else seg = 'continuation';
  }
  if (seg === 'opening' && prevShot) seg = 'continuation'; // 首段只能在第 1 镜；后面标"开场"视为续帧
  // 接缝档位：换场/新角色入场都放宽（新角色段本就不承接上段画面），特写插入与状态跳变允许跳切
  const join = (seg === 'scene_change' || seg === 'new_character') ? 'loose' : (seg === 'closeup' || seg === 'state_jump') ? 'cut' : 'strict';
  // 只有真正需要画面承接的段落才接力尾帧；新角色入场首帧若来自上一段，新角色反而无从进入
  const chain = seg === 'continuation' && !!prevShot;
  // ownTail = 本镜的接点尾态（留给**下一镜**）；cam = 本镜运镜（同样留给下一镜延续）
  const tail = boxed('tail');
  const cam = boxed('cam');
  // prevTail = **上一镜**的接点尾态 = 本镜的起始态（衔接块要引用的是它，不是本镜自己的 tail）。
  // 旧分镜没写 tail 时退到上一镜的「最后动作」——诚实标注来源，而不是拿本镜画面冒充。
  let prevTail = '';
  let prevTailSource = '';
  if (prevShot) {
    const pt = String(prevShot.tail || '').trim();
    const pm = String(prevShot.motion || '').trim();
    if (pt) { prevTail = pt; prevTailSource = 'tail'; }
    else if (pm) { prevTail = pm; prevTailSource = 'motion'; }
  }
  const start = boxed('start');
  return {
    idx: i, seg, join, fromTail: i > 0, fromShot: i > 0, chain,
    name: String(s.title || '').trim(),
    tail, cam, start, prevTail, prevTailSource,
    note: boxed('note'),
  };
}
/** 该 seg 是否构成一个"可以安全开始新生成段"的切点。opening 只在全表第 1 镜成立。
 *  state_jump（同机位状态跳变）也是合法切点：跳变本身就是"切"——前后镜只差状态、不接动作。 */
function isCutPoint(seg) {
  return seg === 'scene_change' || seg === 'closeup' || seg === 'new_character' || seg === 'opening' || seg === 'state_jump';
}
/**
 * 把一张分镜表的镜头按「真实镜头边界」切成若干生成段。
 *
 * @param shots 分镜镜头数组（data.shots）
 * @param opts  { maxSeconds（单次生成上限，默认 15）, minSeconds（单段下限，默认 2）,
 *                hardMax（厂商物理上限，超了必须拆，默认同 maxSeconds） }
 * @returns {{ segments: Array, total: number, max: number, cutMode: string, warnings: string[] }}
 *   segments[i] = {
 *     index, shotIds, shots, startIndex, endIndex,
 *     duration,             // 本段总时长（秒，一位小数）
 *     firstSeg, lastSeg,    // 本段首/末镜的段落类型
 *     opensOnCut,           // 本段是否从一个合法切点开始（第 1 段恒真）
 *     closesOnCut,          // 本段末镜是否本身就是"换镜头"（=下一段天然切点，无需接力）
 *     seamRisk,             // 'none' | 'chain'（靠尾帧接力）| 'forced'（找不到切点被硬切）
 *     needsTailChain,       // 是否需要把上一段尾帧接到本段首帧
 *     reason,               // 人类可读的切段依据（面板上显示）
 *   }
 */
function planShotSegments(shots, opts) {
  const o = opts || {};
  const list = (Array.isArray(shots) ? shots : []).filter((s) => s && (String(s.visual || '').trim() || String(s.motion || '').trim() || (Array.isArray(s.dialogue) && s.dialogue.length)));
  const maxSeconds = Math.max(1, Number(o.maxSeconds) || 15);
  const minSeconds = Math.max(0, Math.min(Number(o.minSeconds) || 2, maxSeconds));
  const warnings = [];
  const durOf = (s) => Math.max(0.3, Math.round((Number(s && s.duration) || 3) * 10) / 10);
  // 预解每镜的段落类型（与 shotContinuityPlan 同一套推断，保证分段与提示词口径一致）
  const plans = list.map((s, i) => shotContinuityPlan(s, list[i - 1] || null, i));
  const total = Math.round(list.reduce((a, s) => a + durOf(s), 0) * 10) / 10;
  if (!list.length) return { segments: [], total: 0, max: maxSeconds, cutMode: 'empty', warnings: ['分镜表里没有可用镜头'] };

  /** 从 from 开始贪心找到一个"可以在 to 前断开"的位置：
   *  返回该段的结束下标（含）；-1 表示从 from 开始连第一镜都放不下。 */
  const findBreak = (from) => {
    let acc = 0;
    let bestCut = -1;   // 最近一次合法切点之后的位置（即"下一镜是新镜头"的下标）
    for (let i = from; i < list.length; i++) {
      const d = durOf(list[i]);
      if (acc + d > maxSeconds + 1e-6) {
        // 放不下了。若当前累计还没超过下限，也要至少吃一镜（单镜超长的情况由下面兜底）
        break;
      }
      acc += d;
      // 判断"i 之后可以断开"：下一镜是切点，或本镜本身就是换镜头（切在它之后）
      const nextIsCut = i + 1 < list.length && isCutPoint(plans[i + 1] && plans[i + 1].seg);
      const thisIsCut = isCutPoint(plans[i] && plans[i].seg);
      // 切点镜的正确归属：**下一段的首镜**。
      // 旧写法 thisIsCut → bestCut = i，把换场/特写镜留在本段末尾，下一段只能从它后面那一镜（多半是
      // continuation）开始 → 必然报"从镜中开始"的硬切。修好后：i>from 时断在 i-1，让切点镜去开新段。
      if (nextIsCut) bestCut = i;
      else if (thisIsCut) bestCut = i > from ? i - 1 : i;
      if (i === list.length - 1) bestCut = i;
    }
    if (bestCut < from) {
      // 连一镜都塞不进上限：退化为"只取这一镜"，交给下面标记 forced
      return { end: from, forced: true, acc: durOf(list[from]) };
    }
    return { end: bestCut, forced: false, acc };
  };

  const segments = [];
  let i = 0;
  let warnMark = warnings.length;
  while (i < list.length && segments.length < 128) {
    // 段首必须是切点；若不是（说明上一段是被 forced 断开的），本镜保持原 seg
    warnMark = warnings.length;
    const brk = findBreak(i);
    let end = brk.end;
    let seamRisk = 'none';
    let reason = '';
    const firstSeg = (plans[i] && plans[i].seg) || 'continuation';
    const opensOnCut = segments.length === 0 || isCutPoint(firstSeg);
    if (!opensOnCut) {
      seamRisk = 'forced';
      reason = '上一段超长被迫硬切，本段从镜中断点继续，动作相位可能不连续';
      warnings.push(`第 ${i + 1} 镜起的一段是硬切（上一段超长且找不到换镜头切点）：这一段与上一段的接缝只能靠尾帧+提示词硬接`);
    }
    // 段内若含"必须承接"的 continuation，且不是首段、且首镜也不是切点 → 需要尾帧接力
    const needsTailChain = segments.length > 0 && !isCutPoint(firstSeg);
    if (needsTailChain) {
      seamRisk = seamRisk === 'forced' ? 'forced' : 'chain';
      reason = reason || '本段首镜是续帧镜头，需用上一段尾帧接力';
    }
    const segShots = list.slice(i, end + 1);
    const duration = Math.round(segShots.reduce((a, s) => a + durOf(s), 0) * 10) / 10;
    const lastSeg = (plans[end] && plans[end].seg) || 'continuation';
    const closesOnCut = isCutPoint(lastSeg) || end === list.length - 1;
    if (!reason) {
      reason = closesOnCut
        ? '本段以换镜头收尾，下一段天然切换、无需接力'
        : '本段在换镜头切点处开始';
    }
    segments.push({
      index: segments.length,
      shotIds: segShots.map((s, k) => i + k),
      shots: segShots,
      startIndex: i,
      endIndex: end,
      duration,
      firstSeg,
      lastSeg,
      opensOnCut,
      closesOnCut,
      seamRisk,
      needsTailChain,
      reason,
      warnMark,
    });
    if (end === i && brk.forced) {
      warnings.push(`第 ${i + 1} 镜单镜时长 ${durOf(list[i])}s 已超单次生成上限 ${maxSeconds}s：这一段只能单独生成，并期望厂商钳制或报错`);
    }
    i = end + 1;
  }
  // 尾部碎段并回上一段：把 20.8s 切成「19.8 + 1.0」既没意义又必然误报硬切（1 秒那段一定从镜中开始）。
  // 只有"末段很短且并回去只超上限一点点"才合并；中段碎块不动，避免掩盖真正的切点问题。
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    const prev = segments[segments.length - 2];
    const tol = Math.max(0.6, maxSeconds * 0.1);
    const tinyTail = last.duration <= Math.max(2.5, maxSeconds * 0.2);
    const fits = (prev.duration + last.duration) <= maxSeconds + tol;
    if (tinyTail && fits) {
      warnings.length = last.warnMark; // 丢弃为这一段产生的告警（它已不存在）
      prev.shots = prev.shots.concat(last.shots);
      prev.endIndex = last.endIndex;
      prev.shotIds = prev.shots.map((x, k) => prev.startIndex + k);
      prev.duration = Math.round((prev.duration + last.duration) * 10) / 10;
      prev.lastSeg = last.lastSeg;
      prev.closesOnCut = last.closesOnCut;
      segments.pop();
      warnings.push(`末段只有 ${last.duration}s，已并回上一段（合并后 ${prev.duration}s，超出单次上限 ${Math.round((prev.duration - maxSeconds) * 10) / 10}s 以内）：比切出一个 1 秒的碎片更好生成`);
    }
  }

  // cutMode：整表能不能被整齐切成"每次都是换镜头"的段——决定要不要提示用户重拆分镜
  const cleanCuts = segments.every((s) => s.opensOnCut);
  const cutMode = cleanCuts ? 'clean' : 'forced';
  if (cutMode === 'forced') {
    warnings.push('本次切段存在硬切点：建议把超长的续帧段在分镜里拆成两镜（第二镜标换场/特写插入），让切点落在真实镜头上');
  }
  if (segments.length > 1 && !cleanCuts) {
    warnings.push(`共 ${segments.length} 段，其中 ${segments.filter((s) => !s.opensOnCut).length} 段从镜中断点开始——弱衔接模型（如 MiniMax）对这些段会明显吃力`);
  }
  return { segments, total, max: maxSeconds, cutMode, warnings };
}

export { planShotSegments, isCutPoint, shotContinuityPlan, shotVisualText };
