/**
 * @ninkch/dsh-infinite-canvas — 移动/追逐语义纯函数（宿主侧权威）
 *
 * 与 client.js 里的同名函数**逐字同构**（漂移守卫：scripts/test-movement-semantics.mjs
 * 用 vm 加载真实 client.js，把 window.__DSH_IC_SEGMENT__ 的导出与本模块在同一组
 * fixtures 上断言输出一致——两端漂移 = 按场检测/契约块口径分叉，测试红必须人工对齐）。
 *
 * 为什么有本文件：canvas_skill_pack（对话侧）在 Host 进程里拼切片，够不着 client.js
 * 的内部函数——按场移动检测与契约块必须有一份宿主可 import 的权威实现。
 * 零 npm 依赖、零 DOM 依赖，Node 直接跑。
 *
 * 口径（与打斗语义同构）：只在真实有移动/追逐的场注入，按场检测 + 三态覆盖，
 * 绝不按题材整表灌。高武/异能题材卡负责世界观，本文件负责「位移怎么被拍出来」。
 */

/** 移动动作语义词表：把 3D 导演台已有姿势（engine.js BONE_POSES 的 fly/crouch/dash_forward）
 *  和墙跑/怪物/落地补成「可见的身体状态词」。模型演不出「轻功」这个名词，只能演接触点、
 *  重心与受力——给它可见词，timeBeats 才有真动作可写。 */
export const MOVEMENT_ACTION_LEXICON = [
  { id: 'dash_forward', zh: '前腿蹬直、上身前压、双臂前后摆开冲刺', en: 'front leg extends, torso presses forward, arms swing in opposition while dashing' },
  { id: 'fly', zh: '身体前倾腾空、前腿屈膝收于裆前、后腿向后舒展、衣袂后拖、抬头锁定落点', en: 'body pitched forward in the air, front knee tucked, rear leg extended back, cloth trailing, eyes locked on the landing point' },
  { id: 'crouch', zh: '前脚掌先触地、膝盖深屈卸力、重心下沉、尘从脚边外扩', en: 'forefoot lands first, knees fold deep to absorb, weight sinks, dust blooms outward from the feet' },
  { id: 'wall_contact', zh: '脚掌贴墙、身体与墙成 30–45°、重心向墙内压、手指或爪尖抓住砖缝', en: 'sole planted on the wall, body angled 30-45 degrees to it, weight pressed into the wall, fingers or claws hooking a seam' },
  { id: 'wall_push', zh: '屈膝蓄力后蹬墙、墙体碎屑落下、身体沿墙面斜向弹出', en: 'knees load and drive off the wall, debris falls, body launches diagonally away from the surface' },
  { id: 'monster_pounce', zh: '四肢着地压低、脊柱弓起、后肢蹬地、爪尖抓地', en: 'body low on all fours, spine arched, hind legs drive, claws dig into the ground' },
  { id: 'land_roll', zh: '落地顺势前滚、肩背依次触地、起身继续跑', en: 'land and roll forward, shoulder and back contacting in sequence, rise back into the run' },
];

/** 按场移动检测（纯函数）：命中词 = 明确的位移/追逐/攀爬谓语；对白行与回忆/讲述语境排除；
 *  mode: auto=按文本判定，on=强制开，off=强制关（用户显式覆盖优先于检测）。
 *  自动检测目前覆盖中文剧本；英文剧本请用 movementMode:'on' 强制注入。
 *  刻意不收录「追」「跑」「飞」这类单字：它们在「追查/追问/跑业务/飞涨」里会大面积误判。 */
export function detectMovementScene(text, opts) {
  const o = opts || {};
  const mode = String(o.mode || o.movementMode || 'auto').toLowerCase();
  if (mode === 'on') return { hit: true, matched: [], mode: 'on' };
  if (mode === 'off') return { hit: false, matched: [], mode: 'off' };
  const t = String(text || '');
  if (!t.trim()) return { hit: false, matched: [], mode: 'auto' };
  const HIT = new RegExp([
    '追逐', '追赶', '追逃', '追上', '追来', '追去', '追进', '追出', '追击',
    '逃走', '逃开', '逃向', '逃进', '逃出', '逃亡',
    '狂奔', '疾跑', '疾奔', '奔跑', '飞奔', '跑下', '跑上', '跑过', '跑进', '跑出',
    '冲下', '冲上', '冲向', '冲进', '冲出',
    '飞跃', '飞跨', '飞掠', '飞身', '飞行', '飞翔', '腾空', '掠出', '掠向', '窜上', '窜出', '窜向',
    '攀上', '攀爬', '攀越', '翻墙', '翻上', '翻越', '飞檐走壁', '踏墙', '蹬墙', '墙面奔', '沿墙',
    '轻功', '俯冲', '扑下', '扑击', '连跨', '纵身一跃', '跃下', '跃上', '跃过', '跃起',
    '跳下', '跳上', '跳过', '翻身', '翻过',
  ].join('|'), 'g');
  const CROSS = /跨过|跨上|跨下/;
  const PATH = /(台阶|石阶|阶|沟|墙|栏|屋顶|屋脊|水面|裂缝|槛|檐)/;
  const DIALOGUE = /说道|说：|喊道|念道|心里想|暗想|旁白|字幕|歌词/g;
  const PAST = /回忆起|回想起|当年|梦里|梦中|传说|故事里|电影里/;
  const lines = t.split(/\n|。|；|;|！|？|!|\?/);
  const matched = [];
  for (const raw of lines) {
    if (!raw) continue;
    // 只剥引号内对白与说话标签，保留同一句里的动作（「说道，纵身跃上屋脊」仍要命中）。
    const ln = raw
      .replace(/「[^」]*」|“[^”]*”|"[^"]*"/g, ' ')
      .replace(DIALOGUE, ' ');
    if (!ln.trim()) continue;
    if (PAST.test(ln)) continue;
    const ms = ln.match(HIT) || [];
    if (!ms.length && CROSS.test(ln) && PATH.test(ln)) ms.push('跨过');
    for (const w of ms) {
      matched.push(w);
      break;
    }
    if (matched.length >= 6) break;
  }
  return { hit: matched.length > 0, matched, mode: 'auto' };
}

/** 分镜契约·移动扩展块（纯函数）：命中移动的场才注入。
 *  核心三件事：① 连续位移算一个主动作；② 拆镜只拆接触点；③ 接触点/重量/墙面反馈写成可见节拍。
 *  本条显式覆盖 canvas-craft「一镜一主动作」与 camera-moves「位移>1/4 拆镜」的默认读法，
 *  否则轻功会被拆成逐阶跑、怪物会被拍成贴图平移。 */
export function movementContractAddendum(zh) {
  if (!zh) {
    return [
      '',
      '**[MOVEMENT / CHASE STORYBOARD - PHYSICS OF TRAVERSAL (this script contains movement; hard rules)]**',
      '- **A continuous displacement is ONE primary action**: qinggong, flight, climbing, wall-running, multi-step leaps - the whole traversal is one action, not several; never split it into one shot per step. The craft rule "one primary action per shot" means one continuous displacement, not one step;',
      '- **Overrides the jsonContract three-beat rule**: this movement clause covers the three-beat rule: traversal shots use 2-4 contact-point beats; the three-beat rule only governs ordinary body-action shots;',
      '- **Overrides the lens "one clip, one piece of information" bias**: a traversal shot needs at least 2 contact points (take-off + landing); that bias applies to information/dialogue shots, not to continuous displacement;',
      '- **Split only at contact points**: take-off, wall contact, landing. One shot may carry 2-4 contact points; never cut between every stair or every wall touch. The camera-moves rule "split when displacement exceeds 1/4 frame" yields to this clause: if the camera can hold the whole arc, one continuous tracking shot is legal;',
      '- **Duration**: a continuous traversal shot may run 2-5s (2-4 contact points per shot); never shatter it into 0.3-0.8s rapid cuts just because it is a chase - save rapid cuts for the reaction/attack after contact;',
      '- **User-fixed total duration wins**: when `targetDuration` fixes the total, compress per-shot durations; keep the contact points;',
      '- **Do not use state_jump for traversal**: qinggong / wall-run / chase are visible trajectories and must happen inside the shot; state_jump is only for teleport / appearance / vanishing;',
      '- **timeBeats are contact-point beats**: e.g. ["0s forefoot presses the 3rd step, knee deep","0.7s airborne, lead leg forward, cloth trailing","1.6s toe touches the 5th step, second push-off","2.4s landing absorbs, dust blooms outward"];',
      '- **Stairs**: one stride covers 3-5 steps; never stair-by-stair running, never feet off the surface, never sliding in place;',
      '- **Wall-run / climb**: write the foot or claw contact point, body-to-wall angle (about 30-45 degrees), weight pressed into the wall, debris/claw marks, and the landing point;',
      '- **Monsters / beasts**: write mass and inertia - ground/tile/beam deformation on landing, a real turning radius; never texture-slide across the scene;',
      '- **Chase**: write distance change, occlusion, eyeline lock, environmental damage (overturned stalls, broken tiles, dust);',
      '- **Camera**: wide lens / low side tracking / long-lens compression follow the director lens; the framing must hold the whole arc; one continuous tracking shot is allowed; never shatter the follow into rapid cuts just to obey "one camera move per shot";',
      '- **Action lexicon (visible body states, take directly):** ' + MOVEMENT_ACTION_LEXICON.map((x) => x.en).join('; ') + ';',
      '- **Never**: stair-by-stair running, cutting per step, feet not contacting, weightless floating, wire-fu, sliding in place, constant-speed translation, stiff mechanical limbs, texture-sliding monsters.',
    ];
  }
  return [
    '',
    '**【移动/追逐分镜·身法与空间（本剧本命中移动场面，以下为硬规则）】**',
    '- **连续位移是一个主动作**：轻功、飞行、攀爬、墙跑、连续跨阶，整段位移算「一个主动作」，不是「多个动作」；不要把它拆成一阶一镜。`canvas-craft` 的「一镜一主动作」在这里指「一段连续位移」，不是「每一步」；',
    '- **覆盖 jsonContract 的「三拍」**：移动镜按接触点写 **2–4 拍**；三拍规则只约束普通身体动作镜；',
    '- **覆盖透镜的「一镜一信息」**：移动镜至少写 2 个接触点（起跳 + 落点）；透镜的「一镜一信息」只适用于信息镜/对话镜，不适用于连续位移；',
    '- **拆镜只拆在接触点**：起跳点、墙面接触点、落点。一镜容纳 2–4 个接触点；不要在每一级台阶/每一个墙面之间切。`camera-moves` 的「位移超过画面 1/4 就拆镜」在移动段让位于本条：机位能容纳整条位移弧线时，允许一镜连续跟拍；',
    '- **时长**：连续位移镜允许 2–5s（一镜 2–4 个接触点）；不要为了「追逐=快切」把它切成 0.3–0.8s 的碎镜——快切留给接触后的反应/攻击；',
    '- **用户固定总时长优先**：`targetDuration` 固定总时长时，按总时长压缩每镜；先压时长，不删接触点；',
    '- **不要用 state_jump 代替位移**：轻功/墙跑/追逐是可见轨迹，必须镜内完成；state_jump 只用于瞬移/现身/消失；',
    '- **timeBeats 用接触点写**：如 ["0s 前脚掌压住第 3 级台阶，膝盖深屈","0.7s 腾空、前腿领先、衣袂后拖","1.6s 脚尖点在第 5 级台阶边缘、二次蹬出","2.4s 落地卸力、尘从脚边外扩"]；',
    '- **台阶级差**：一步跨 3–5 阶；禁止逐阶跑、禁止脚不接触、禁止原地滑步；',
    '- **墙跑/攀爬**：写明脚掌或爪尖的接触点、身体与墙夹角（约 30–45°）、重心压向墙、墙体碎屑/爪痕、离墙落点；',
    '- **怪物/异兽**：写明质量与惯性——落地时地面/瓦片/木梁的变形，转向有半径；禁止像贴图一样平移；',
    '- **追逐**：写明距离变化、遮挡关系、视线锁定、环境破坏（撞翻的摊/断瓦/扬尘）；',
    '- **镜头**：广角/低机位侧向跟拍/长焦压缩按导演透镜；机位必须能容纳整个位移弧线，允许一镜连续跟拍；不要为了「一镜一运镜」把跟拍拆成碎切；',
    '- **动作词表（可见身体状态，直接取用）**：' + MOVEMENT_ACTION_LEXICON.map((x) => x.zh).join('；') + '；',
    '- **负向**：一阶一阶跑、逐阶切镜、脚不接触、无重量、钢丝感、原地滑步、匀速平移、机械抬手、怪物贴图滑动。',
  ];
}
