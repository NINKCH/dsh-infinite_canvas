/**
 * @ninkch/dsh-infinite-canvas — 战斗语义纯函数（宿主侧权威，0.20.5）
 *
 * 与 client.js 里的同名函数**逐字同构**（漂移守卫：scripts/test-combat-semantics.mjs
 * 用 vm 加载真实 client.js，把 window.__DSH_IC_SEGMENT__ 的导出与本模块在同一组
 * fixtures 上断言输出一致——两端漂移 = 按场检测/契约块/因果句口径分叉，测试红必须人工对齐）。
 *
 * 为什么有本文件：canvas_skill_pack（对话侧）在 Host 进程里拼切片，够不着 client.js
 * 的内部函数——按场打斗检测、契约块、词表必须有一份宿主可 import 的权威实现。
 * 零 npm 依赖、零 DOM 依赖，Node 直接跑。
 *
 * 来源：_refs/LucianAIGC-打斗skill-V3.1 的战斗因果状态链（出招→接招→反击→攻守转换）
 * 嫁接到画布 tail→prevTail→衔接块管道；动作词表反哺自 assets/director/engine.js
 * BONE_POSES 打斗段 12 式的关节力学语义。
 * 注入口径（用户定稿）：只在真实有打斗的场注入，按场检测 + 三态覆盖，绝不按题材整表灌。
 */

/** 打斗动作语义词表：把 3D 导演台 BONE_POSES 打斗段（assets/director/engine.js，12 式）
 *  的关节力学翻译成「可见身体发力词」。id 与 3D 姿势 id 对齐（回归断言两表一致）。 */
export const COMBAT_ACTION_LEXICON = [
  { id: 'spear_ready', zh: '侧身沉肩、重心压到后腿、双手前后持械', en: 'side-on stance, shoulders sunk, weight on the back leg, weapon held fore-aft' },
  { id: 'spear_thrust', zh: '腰胯先拧、后腿蹬地发力把双手推出、前腿落成弓步', en: 'hips twist first, back leg drives the arms forward, front leg lands in a bow stance' },
  { id: 'palm_block', zh: '单臂斜上架、掌面外翻、上身侧倾把力卸向体侧', en: 'one arm angles up, palm turned out, torso tilts to shed the force sideways' },
  { id: 'dodge_lean', zh: '髋部后坐、上身后仰避开来势、双手收回护身', en: 'hips sit back, upper body leans away from the strike, hands pull in to guard' },
  { id: 'dash_forward', zh: '前腿蹬直、上身前压、双臂前后摆开冲刺', en: 'front leg extends, torso presses forward, arms swing in opposition while dashing' },
  { id: 'grit_advance', zh: '上身前探、双臂收紧、下颌压低逼近', en: 'torso leans in, arms tighten, jaw drops while closing in' },
  { id: 'low_sweep', zh: '深蹲转体、持械手贴地横扫、另一手撑地', en: 'deep-squat pivot, weapon hand sweeps low along the ground, other hand plants on the floor' },
  { id: 'spear_ground', zh: '单膝下沉、持械手直下压、上身俯冲', en: 'one knee sinks, weapon hand drives straight down, torso dives' },
  { id: 'crouch_low', zh: '单膝跪地、上身压到近地、持械手垂落收势', en: 'kneeling, torso pressed near the ground, weapon hand settling low' },
  { id: 'ult_charge', zh: '抬头挺胸、双臂外展上举、重心拔起蓄力', en: 'chest open, both arms spread and raised, weight rising as power gathers' },
  { id: 'hit_recoil', zh: '上身后折、双臂散开、后脚撤半步卸力', en: 'upper body folds back, arms fly open, rear foot steps back to absorb the hit' },
  { id: 'knockdown', zh: '全身放倒、四肢摊开、重心彻底失守', en: 'body laid flat, limbs sprawled, balance fully broken' },
];

/** 按场打斗检测（纯函数）：命中词 = 明确动作谓语；对白行与回忆/讲述语境排除；
 *  mode: auto=按文本判定，on=强制开，off=强制关（用户显式覆盖优先于检测）。 */
export function detectCombatScene(text, opts) {
  const o = opts || {};
  const mode = String(o.mode || o.combatMode || 'auto').toLowerCase();
  if (mode === 'on') return { hit: true, matched: [], mode: 'on' };
  if (mode === 'off') return { hit: false, matched: [], mode: 'off' };
  const t = String(text || '');
  if (!t.trim()) return { hit: false, matched: [], mode: 'auto' };
  const HIT = new RegExp([
    '出招', '过招', '交手', '开打', '对打', '搏杀', '厮杀', '互殴', '挥拳', '出拳', '出腿',
    '肘击', '膝撞', '挥刀', '拔刀', '挥剑', '出剑', '劈', '砍', '斩', '刺出', '突刺', '横扫',
    '扫堂腿', '鞭腿', '摆拳', '勾拳', '直拳', '抡', '格挡', '招架', '挡开', '架开', '闪避',
    '躲开', '闪身', '翻滚', '侧身避开', '击中', '命中', '打中', '一拳', '一掌', '一剑', '一刀',
    '一枪', '受击', '挨打', '被打', '击退', '击飞', '打飞', '撂倒', '打倒', '击倒', '摔倒',
    '摔出', '撞飞', '撞碎', '掀翻', '锁喉', '擒拿', '反关节', '压制', '按倒', '反击', '还击',
    '回击', '追击', '对轰', '火并', '枪战', '交火', '开枪', '射击', '扫射', '暗器', '箭矢',
    '刀光', '剑气', '掌风', '拳风', '破甲', '贯穿', '震飞', '踹', '砸向',
  ].join('|'), 'g');
  const DIALOGUE = /说道|说：|说道：|喊道|念道|心里想|暗想|旁白|字幕|歌词/;
  const PAST = /(曾|当年|想起|回忆|听说|讲述|史料|新闻|棋局|牌局|谈判|演习|训练|梦里|梦中|传说|故事里|电影里)/;
  const lines = t.split(/\n|。|；|;|！|？|!|\?/);
  const matched = [];
  for (const ln of lines) {
    if (!ln || DIALOGUE.test(ln)) continue;
    const ms = ln.match(HIT) || [];
    for (const w of ms) {
      const i = ln.indexOf(w);
      if (PAST.test(ln.slice(Math.max(0, i - 6), i))) continue;
      matched.push(w);
      break;
    }
    if (matched.length >= 6) break;
  }
  return { hit: matched.length > 0, matched, mode: 'auto' };
}

/** 打斗镜判定（纯函数）：任一战斗字段非空即为打斗镜。 */
export function shotIsCombat(s) {
  const sh = s || {};
  return ['attack', 'reaction', 'impact', 'initiative', 'nextCombat'].some((k) => String(sh[k] || '').trim());
}

/** 分镜契约战斗扩展块（纯函数）：命中打斗的场才注入。 */
export function combatContractAddendum(zh) {
  if (!zh) {
    return [
      '',
      '**[COMBAT STORYBOARD - HARD] this script contains real combat. Shots may carry combat fields (all optional; leave them empty on non-combat shots, never invent):**',
      '- **attack**: "attacker -> target, locked body part, trajectory", e.g. "@Li@->@Shen@, locked on chest/shoulder, spear thrust from lower-left to upper-right" - an attack MUST point at a concrete opponent on screen;',
      '- **reaction (required when attack exists)**: the opponent\'s visible block/dodge/hit action - never a statue receiving a blow, never just "blocked it";',
      '- **impact**: contact part, force direction, knockback/imbalance and environmental damage;',
      '- **initiative**: who holds the attack and who turns to counter at the end of this shot;',
      '- **nextCombat**: the next shot\'s combat intent, echoing the tail\'s combat state;',
      '- **tail gains a combat state**: write "picture tail state | combat state: who holds the attack, where the weapon/effect is, the hit party\'s state, damage residue" - cross-shot momentum rides entirely on this;',
      '- **timeBeats on combat shots use attack-defense beats**: strike -> opponent receives/counters -> counter or displacement (each beat a visible body state);',
      '- **action lexicon (visible body force, take directly):** ' + COMBAT_ACTION_LEXICON.map((x) => x.en).join('; ') + ';',
      '- **never**: move names ("Crouching Tiger style"), summary verbs ("releases a skill / launches an attack / energy explodes"), unexplained teleports, glide drifting, statue trading; write visible body-force chains + opponent response + physical results;',
      '- for materialized-technique shots write vfx as a picture that could be a keyframe still; when expanding prefer keyframe-then-video (hard first frame).',
    ];
  }
  return [
    '',
    '**【打斗分镜·战斗因果（本剧本命中打斗，以下为硬规则）】分镜镜头可携带战斗字段（全部可选；非打斗镜一律留空，绝不臆造）：**',
    '- **attack（攻击）**：「攻击者→目标，锁定部位，轨迹方向」，如「@李寒@→@沈铁@，锁定胸肩，自左下向右上横枪突刺」——**攻击必须指向画面里的具体对手**，写明轨迹与锁定部位；',
    '- **reaction（对手回应；有 attack 必写）**：对手的可见防御/闪避/受击动作（如「@沈铁@ 单臂斜上架、掌面外翻、上身侧倾卸力」）——**禁止站桩接招、禁止只写「挡下了」**；',
    '- **impact（接触与受力）**：接触部位、受力方向、击退/失衡与环境破坏（如「枪尖擦肩、沈铁后撤半步、身后木栏断裂」）；',
    '- **initiative（攻守归属）**：本镜结束时谁持攻、谁转入反击；',
    '- **nextCombat（下一镜战斗意图）**：如「@沈铁@ 借卸力之势低身横扫」——与 tail 的战斗态呼应；',
    '- **tail 追加战斗态**：接点尾态写成「画面尾态｜战斗态：攻势在谁、武器/技能位于何处、受击者状态、破坏残留」——**跨镜攻势全靠它传递**；',
    '- **timeBeats 打斗镜用攻防三拍**：出招 → 对手接招/受击 → 反击或位移（每拍写可见身体状态）；',
    '- **动作词表（可见身体发力，直接取用）**：' + COMBAT_ACTION_LEXICON.map((x) => x.zh).join('；') + '；',
    '- **禁止**：招式名（「回风落雁式」）、概括词（「释放技能/发动攻击/能量爆炸/华丽连招」）、无因瞬移、滑步漂移、站桩对轰；写**可见的身体发力链 + 对手回应 + 物理结果**；',
    '- 具象化招式镜（能量成形/武器光效）的 vfx 写成可直接出设定图的画面，铺开时优先「先出关键帧设定图 → 图生视频（hard 首帧）」。',
  ];
}

/** 逐镜因果句（纯函数）：视频提示词编译时追加到打斗镜。只拼存在的字段；空镜返回 ''。 */
export function combatCausalityText(s, zh) {
  const sh = s || {};
  if (!shotIsCombat(sh)) return '';
  const g = (k) => String(sh[k] || '').trim();
  const bits = [];
  if (zh) {
    if (g('attack')) bits.push('攻击（必须朝向该对手）：' + g('attack'));
    if (g('reaction')) bits.push('对手回应（必须演出）：' + g('reaction'));
    if (g('impact')) bits.push('接触与受力：' + g('impact'));
    if (g('initiative')) bits.push('攻守归属：' + g('initiative'));
    if (g('nextCombat')) bits.push('下一镜从该攻势继续：' + g('nextCombat'));
    return bits.length ? '【打斗因果】' + bits.join('；') : '';
  }
  if (g('attack')) bits.push('attack (must point at that opponent): ' + g('attack'));
  if (g('reaction')) bits.push('opponent response (must be performed): ' + g('reaction'));
  if (g('impact')) bits.push('contact & force: ' + g('impact'));
  if (g('initiative')) bits.push('initiative: ' + g('initiative'));
  if (g('nextCombat')) bits.push('next shot continues from this momentum: ' + g('nextCombat'));
  return bits.length ? '[COMBAT CAUSALITY] ' + bits.join('; ') : '';
}

/** 打斗镜几何最小校验（纯函数）：机械可判的四条检查，失败产生可见告警，绝不拦截生成。 */
export function validateCombatGeometry(s, zh) {
  const sh = s || {};
  const out = [];
  const g = (k) => String(sh[k] || '').trim();
  const pre = String(sh.title || '').trim() ? String(sh.title).trim() + ' · ' : '';
  if (!shotIsCombat(sh)) return out;
  if (g('attack') && !g('reaction')) out.push(zh ? pre + '有攻击但无对手回应：每次攻击必须写对手的可见防御/闪避/受击（禁站桩）' : pre + 'attack without reaction: every attack needs a visible response (no statues)');
  if (g('attack') && !/→|@/.test(g('attack'))) out.push(zh ? pre + '攻击未指向具体对手（缺少 @对手名@ 或 →）' : pre + 'attack lacks an explicit target (@name@ or ->)');
  const vis = String(sh.visual || '');
  if (/背对|背面|背影/.test(vis) && /表情|眼神|眼眸|面容|脸上的|嘴角/.test(vis)) out.push(zh ? pre + '可见性矛盾：背对镜头却写了表情/眼神' : pre + 'visibility conflict: back to camera yet describing facial expression');
  if (g('attack') && g('tail') && !/战斗态|combat state/i.test(g('tail'))) out.push(zh ? pre + 'tail 建议补「｜战斗态：…」（跨镜攻势靠它传递）' : pre + 'tail should append "| combat state: ..." (cross-shot momentum rides on it)');
  return out;
}
