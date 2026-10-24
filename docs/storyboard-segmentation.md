# 分镜切段与视频生成衔接改造调研

> 本文是「分镜 → 视频生成」链路的技术调研 + 改造方案。只做设计说明，不包含代码改动，也不引用第三方实现。
> §1 的"现状/行号"以**修复前基线 `452f647`** 为对象，用来解释动机；当前 HEAD 为 `94d1f47`，其中 `0a5b96d` 已按本文方案落地主链路（切段规划器 / 分段提示词 / 按段铺开 / 弱模型判定），逐项状态见 **§3.5**。检索以函数名为准。

| 项 | 内容 |
|---|---|
| 目标 | 让"生成段边界 = 真实镜头切点"，使两次视频生成之间**不需要硬接**；每段内部动作连贯、特效可执行 |
| 直接影响 | `client.js`（分镜生成 / 视频提示词 / 画布铺开 / 视频节点运行）、`assets/canvas-craft/SKILL.md`（分镜纪律） |
| 不改 | 视频厂商协议、资产库、成片合成链路、既有 JSON 结果字段（新增字段一律可选） |
| 只读参考 | `_refs/BeefTV-main`（source-available，**只提炼设计思想，不复制代码**，见 §5.3） |

---

## 一、问题定位

### 1.1 用户反馈（原话）

> 当前项目产出的分镜脚本 + 任务图片去生成视频后，动作都是极简的，甚至可以说只会平移，而且没有特效，切分的也不是很合理。假设视频上限一次 15s，分镜脚本非得切成 10–14 之间等比例很规范，而不是按实际镜头去分组。比如说两个镜头衔接着同一个角色的一个画面，却被封到了两个场景脚本里，这样第二次生成很难和第一个视频衔接上；就算加了首帧参考，第二个视频首帧重复一下，剪辑时不是重影就是卡顿，不流畅。能不能尽可能让场景的切分就是"要换镜头了"的那种切法，这样两次生成的视频就不用去硬接前一个视频？每个视频的动作应该是连贯的。特别是用 MiniMax 时，它没有 Seedance-2.5 那么强，衔接上很难处理。

### 1.2 现状生成链路（修复前基线 `452f647`）

| # | 环节 | 代码位置 | 实际行为 |
|---|---|---|---|
| 1 | 剧本分场 | `parseScriptScenes` L10973 / `expandScriptToScenes` L10996 | 按 `【场N】` 文本标记切场景，**一场 = 一个文本节点 + 一个分镜表节点**；注释自述"每场 10-15s" |
| 2 | 生成分镜 | `genStoryboardNode` L8138 → `aiStoryboardShots` L7074 | 一次 LLM 调用产出整表 `shots[]`；单表最多 24 镜（L7238），总时长**不设上限、不做压缩**（L7104、L8157-8158） |
| 3 | 铺开到画布 | `expandStoryboard` L11170 | **一个分镜表只建一个视频节点**（L11166 注释、L11238）；节点 `duration = round(各镜时长之和)`（L11236-11238） |
| 4 | 运行视频节点 | `runGenNode` L8262 → `plan` L8337 | 首镜 `seg: continuation` 时才 `chain`（L8354）；自动找上一段视频并取 0.8s 尾窗里的"最佳帧"当首帧（`autoPrevVideoNode` L5690、`extractTailFrames` L8371） |
| 5 | 组装提示词 | `buildStoryboardVideoPrompt` L7935 或 `buildStructuredVideoPrompt` L3150 | 一张表的所有镜头塞进**一条提示词**；给的是累计绝对时间轴（L3213），单镜时长最小被抬到 1s（L7952） |
| 6 | 调用厂商 | `apiVideo` L5223；节点时长来自 `n.data.duration`（L8434-8436） | 一个请求 = 一段视频；超出厂商上限时由厂商钳制/报错，事后才对比实际时长告警（L8466-8477） |
| 7 | 事后校验 | `frameSeamMetrics` L3030 / `seamVerdict` L3066，调用点 L8510-8522 | 只比较"本段首帧 vs 上段尾帧"的**灰度相似度**，不校验动作相位/速度 |

### 1.3 根因清单

| # | 根因 | 代码证据（文件 · 函数 · 行） | 直接后果 |
|---|---|---|---|
| R1 | **生成单位错位**：生成单位是"分镜表（≈一场）"，不是"镜头边界" | `client.js` · `expandStoryboard` L11166 注释「一个分镜表 = 一次视频生成」；L11238 只 `mk('video', …)` 一个节点 | 表内几十秒内容被硬塞进一次生成，模型只能自行删减/均摊 |
| R2 | **片段上限不是规划输入**：没有任何 `maxClipSeconds` 参与分镜生成或铺开 | 全文件无 `maxDuration/maxSeconds/clipSeconds` 能力字段；`aiStoryboardShots` L7104 明写"总时长按内容需要写足（不设硬上限）"；`genStoryboardNode` L8157-8158 明写"时长本身不设上限，不做压缩" | 15s 上限的模型拿到 30–60s 提示词，只能压缩成"平移式"极简动作 |
| R3 | **时长被压成一个整数**：整表时长求和后取整，丢节奏 | `expandStoryboard` L11236-11238 `total = Σ max(1,duration)`、`duration = max(1, Math.round(total))`；`buildStoryboardVideoPrompt` L7952 把 0.6s 快切抬成 1s | 快切/长短对比在请求发出前就失真；"10–14s 等比例"的观感由此而来 |
| R4 | **切点来源是剧本分场，不是镜头 cut**：分场是叙事/时空单位 | `parseScriptScenes` L10973 按 `【场N】` 正则切分；`expandScriptToScenes` L10996 一场一表 | 同一角色的同一段连续动作只要跨了分场，就被切成两次生成，首帧接力也救不回动作相位 |
| R5 | **跨段衔接只有"尾帧 + 文字"**：新段仍是一次独立采样 | `plan.chain` L8354；`autoPrevVideoNode` L5690；`extractTailFrames(vb,{span:0.8})` L8371；`storyboardContinuityNote` L2926-2941 只把上段尾镜的 tail/cam 当文字约束 | 首帧能接受"画面位置"，但运动向量、速度、相位不连续 → 剪辑点重影/卡顿 |
| R6 | **段内衔接字段无法跨段兑现**：`tail/cam/start/seg` 是"镜头间"契约，却被生成边界截断 | `shotContinuityPlan` L2875（`chain = seg==='continuation' && !!prevShot` L2900）；`shotContinuityBlock` L2947 只在本表内逐镜生成衔接块 | 被切到两段的那一对 continuation 镜头，其 `tail → 承接` 关系没有执行者 |
| R7 | **弱模型没有可行接力策略**：首帧与参考图互斥、部分厂商 0 参考图、时长按 6/10 取整 | `VIDEO_REF_CAPS` L5213-5222（`minimax: {img:0}`）；L5233-5235 注释「hard 硬首帧必须放弃参考图」；`anchorRole` L8387；`VIDEO_VENDORS.minimax` L4694「时长按官方 6/10s 取整」 | MiniMax 一类模型上"续帧接力"≈ 用更差的输入换一次重采样，越接越糟 |
| R8 | **提示词只声明、不强制镜头边界**：单条提示词给累计时间轴，模型没有逐镜硬切的结构保证 | `buildStructuredVideoPrompt` L3212-3214 由 `Σ duration` 推算 `[Shot N]` 起止时间；`buildStoryboardVideoPrompt` L7943 只写"每镜时长不可变" | 模型把 10–14s 均分成"差不多长"的镜头，`seg` 语义形同虚设 |

### 1.4 一个具体事故链（13 镜 / 62s 分镜表，模型上限 15s）

1. `aiStoryboardShots` 按内容正常产出 13 镜、合计 62s（L7104 明确不限总时长）；
2. `expandStoryboard` 建 **1 个** video 节点，`duration = round(62) = 62`（L11236-11238）；
3. 运行时会话把 62s 压进厂商 15s 请求（或厂商钳制），提示词仍写 13 个镜头与累计时间轴；
4. 模型只能压缩：动作退化为平移/微动，切点不再落在真实镜头边界，特效被省略；
5. 用户为"接上"而拆成两场重生成：新段首帧来自上段尾帧（L8371），但两段是独立采样；
6. 剪辑点处首帧重复 + 动作相位不连续 → 重影/卡顿（`seamVerdict` 只能测画面相似度，L8510-8522 捕捉不到）。

### 1.5 影响面

| 维度 | 影响 |
|---|---|
| 内容质量 | 动作极简、只有平移、无物理特效；分镜表里的 `seg`/`tail`/`cam` 设计被浪费 |
| 返工成本 | 用户手工拆场景/重生成；每次重生成都按秒计费 |
| 弱模型体验 | MiniMax 等弱衔接模型上几乎无法通过"首帧接力"补齐，越接越差 |
| 下游链路 | 成片合成只能做兜底拼接，救不回没写在切点上的动作 |

---

## 二、BeefTV 做对了什么

> 只读参考：`_refs/BeefTV-main`。以下只提炼设计思想与接口形态，**不复制其代码**（许可说明见 §5.3）。

| # | 设计 | 出处 | 设计要点 | 对本项目的启示 |
|---|---|---|---|---|
| B1 | **镜头行是一等公民**：`StoryboardRow` 20+ 字段，含 `timeBeats / mustHave / optionalDetails / continuityOut / negativePrompt / assetBindings` | `web/src/types/canvas.ts` L97-143 | 每个镜头不是一段散文，而是一份带"必达项、时间节拍、负面项、连续性出口"的执行合同 | 我们的 `shots[]` 需要补 `timeBeats/camera/vfx/negative` 四类可选字段，让"动作/特效"可被逐镜声明 |
| B2 | **受保护执行契约**：单镜最多 2 名主要角色、1 个主运镜、1 条主动作链、3 个 `timeBeats`、3 个 `mustHave`，超限必须拆镜 | `backend/internal/prompts/prompt_template_defaults.go` L337-349 | 颗粒度上限是**机械可校验**的，不靠模型自觉 | 分镜生成提示词加入"每镜动作节拍 ≤3、每镜一个主动作"的硬上限 |
| B3 | **首帧/运动职责分离 + 台词按时长预算**：`visualPrompt` 只描述首帧，`videoPrompt` 只描述运动与结尾状态；`dialogue` 按 1 秒≈5 个中文字符（至少 24 字）限长 | 同上 L342、L345 | 首帧与运动不重复；台词长度与镜头时长绑定 | 我们的 `visual`/`motion` 已是这个结构（统一成"起点→方式→终点"）；分镜生成按 `duration` 反推台词上限，超限拆镜 |
| B4 | **26 种运镜预设**：`push_in / pull_out / pan / tilt / truck / dolly / crane / orbit / handheld / whip_pan / rack_focus / zoom / low_angle_push / foreground_pass / static_hold …`，每种带 label + 可执行 prompt | `web/src/lib/canvas/cinematic-video-tools.ts` L14-41 | "运镜"是可枚举、可选的专业词汇，不是自由文本动词 | 我们的 `motion` 提供 8–10 个基础预设 + 起点/终点模板；其余保持自由文本 |
| B5 | **时间节拍模板**：6/9/10/15s 各有 `[0s]/[3s]/[6s]…[Ns]` 的分段节拍 | 同上 L43-84 | 用"时间点 + 该时点发生什么"约束模型，而不是只给总时长 | `timeBeats` 字段直接落地为 3 个时间点（0 / 中段 / 尾点） |
| B6 | **机位-镜头-焦段-光圈四层提示词库**：8 机位、8 镜头、11 焦段、10 光圈；模板明确声明"这是摄影参数，不是画面里的物体" | `web/src/lib/canvas/camera-prompt-library.ts` L41-230、L253-280 | 把"只会平移"升级为可执行的光学语言；并防止模型把摄影机画进画面 | 我们的 `camera` 字段用"机位 + 焦段/光圈 + 运动"三件套；模板加同款防误绘声明 |
| B7 | **模型能力表**：`VideoCapabilityConfig.duration`（`selection: range/enum`、min/max/step/values、`fractionalMin`）、`references.maxVideoDurationSeconds / maxVideoTotalDurationSeconds` | `web/src/lib/model-capabilities.ts` L66-114 | 切段前先知道"这台模型一次能吃多少秒、什么离散值" | 新增能力表，`maxClipSeconds` 从能力表来；未知模型按最保守值处理 |
| B8 | **行级产出绑定**：一行通过 `imageNodeId / videoNodeId` 绑定素材；行时长 1–60s，默认 6s；`row:<id>` 作为生成输入句柄 | `docs/content/docs/backend/storyboard-operations.mdx` L11、L18、L24；`web/src/components/canvas/canvas-node-generation.ts` L435-471 | **镜头行就是生成边界**；行内字段（含 `continuityOut`）跨行显式传递连续性 | 我们保留"多镜合并以省调用"，但合并必须发生在**切点处**；同时让每个视频节点知道自己负责哪几镜 |

**不照搬的三点**：

| 不照搬 | 原因 |
|---|---|
| 一行一生成的默认粒度 | 调用次数与成本显著上升；我们的画布以"一段视频 = 一镜到底多镜硬切"为卖点，应保留合并能力，只在切点处分组 |
| 行时长上限 60s、默认 6s | 这是它的编辑器默认值，不是我们的厂商上限模型；我们改用 `maxClipSeconds` 能力表 |
| 其 Web 端 26 运镜 / 8 机位的完整枚举 | 枚举越多，模型选择成本越高；我们先落 8–10 个高频预设，其余自由文本，减少提示词膨胀 |

---

## 三、改造方案

> 本节是方案全文。`0a5b96d` 已按本方案落地主链路；**§3.5 给出逐项落地状态与差异**，未落地项继续按本节执行。

### 3.0 目标与不变量

| 不变量 | 说明 | 保证方式 |
|---|---|---|
| JSON 结构不变 | `{"shots":[…]}` 仍是唯一输出；`title/visual/motion/tail/cam/start/seg/characters/scene/props/duration/dialogue/sfx` 保持原义 | 新增字段全部可选；解析器沿用现有 `aiStoryboardShots` 的映射，不改字段名 |
| 旧项目行为不变 | 没有分段信息的分镜表仍走"一表一视频节点"旧路径 | `videoSegment` 缺省 = 旧行为；`expandStoryboard` 保留原分支 |
| `seg/tail/cam/start` 语义不变 | 切段只**选择边界**，不改镜头间契约 | 切段规划器复用 `shotContinuityPlan` 的 `seg` 推断（L2875） |
| 参考图链路不变 | 参考图仍只来自 `ref` 连线，`@实体@` 只注入设定文字 | 沿用 `collectRefs`（L3666）/ `buildStructuredVideoPrompt` 现有主体绑定逻辑 |

### 3.1 切段规划器 segmentation planner

> 设计中的纯函数（`planShotSegments`）已在 `0a5b96d` 落地（HEAD `94d1f47` · L3070），输出字段与本节一致；未落地的差异项见 §3.5。

#### 3.1.1 输入 / 输出

| 方向 | 字段 | 说明 |
|---|---|---|
| 输入 | `shots[]` | 分镜镜头数组；每镜至少 `visual` 或 `motion`，`duration` 为秒（可为小数），`seg` 可缺省 |
| 输入 | `maxClipSeconds` | 本模型单次生成上限（默认 15，来自能力表 §3.2） |
| 输入 | `minSeconds` | 单段软下限（默认 2），避免切得太碎 |
| 输出 | `segments[]` | 见 §3.1.6 |
| 输出 | `total / max / cutMode / warnings[]` | 总时长、上限、整表是否"天然可切"、需要用户看到的告警 |

#### 3.1.2 什么算"合法切点"

边界只能落在**镜头边界**，且满足下列任一：

| 形态 | 条件 | 语义 | 下一段是否需要接力 |
|---|---|---|---|
| A. 新段首镜就是换镜头 | 下一镜 `seg ∈ {scene_change, closeup, new_character}` | 下一段本来就换空间/机位/插入特写 | 否（天然切） |
| B. 本段末镜就是换镜头 | 本镜 `seg ∈ {closeup, scene_change, new_character}` | 本段以插入/换场收尾，下一段是"切回来"的新镜头 | 否（剪辑上就是新镜头） |
| C. 首镜 | `index === 0` | 全表第一段 | 否 |
| D. 显式重设 | 下一镜 `start` 明确写"重新建立"（如"切至全景，重新建立空间"） | 作者显式声明这是新镜头 | 否（判定：`start` 命中重设词表；**当前 `shotContinuityPlan` 不解析该语义，属新增，待核**） |

不构成切点的典型：连续 `continuation` 的两镜之间；`opening` 出现在非首镜（`shotContinuityPlan` L2896 已把非首 `opening` 归一为 `continuation`，沿用）。

#### 3.1.3 算法（伪代码）

```text
PLAN(shots, maxSeconds, minSeconds):
  plans = [ shotContinuityPlan(shots[i], shots[i-1], i) for i in 0..n-1 ]   // 复用现有 seg 推断
  segments = []; i = 0
  while i < n:
      acc = 0; bestEnd = -1
      for j = i .. n-1:
          if acc + dur[j] > maxSeconds: break          // 再加一镜就超限 → 停止累积
          acc += dur[j]
          if boundary(i..j) is legal: bestEnd = j      // 记住"最近一个合法断点"
          if j == n-1: bestEnd = j
      forced = false
      if bestEnd < i:                                  // 单镜超限 / 从未出现合法断点
          bestEnd = last j with acc <= maxSeconds      // 至少吃镜到上限
          forced = true                                // 本段将标记 seamRisk='forced'
      if bestEnd < i: bestEnd = i; forced = true       // 单镜本身就超限
      segments.push(记录本段 i..bestEnd（forced 标记）)
      i = bestEnd + 1
  return segments
```

`boundary(i..j)` 合法 = 「j+1 是切点镜头」或「j 是切点镜头」或「j 是最后一镜」（对应 §3.1.2 的 A/B/C）。

#### 3.1.4 规则与降级

| 规则 | 内容 | 违反时的动作 |
|---|---|---|
| S1 | 连续 `continuation` 镜头必须整段留在同一生成段（动作相位不可拆） | 规划器只在切点断；切点之外的 `continuation` 不产生边界 |
| S2 | 贪心累积到"再加一镜就超 `maxClipSeconds`"，在**最近合法切点**断 | 合法切点之前仍有空余也接受（宁短勿裂） |
| S3 | 段内找不到切点且必须断 → 降级：在断点处**改写镜头**（把长动作拆成两镜，第二镜标 `scene_change` 或 `closeup`），该段 `seamRisk='forced'`，UI 必须显示 | 在 `warnings[]` 写明"第 k 镜起的段是硬切，建议改分镜"；提示词里写明"本段从切点开始，不承接上一段画面" |
| S4 | 单镜时长 > `maxClipSeconds` → 该段只含此镜，`seamRisk='forced'`，不截断内容；由厂商钳制/报错并可见 | `warnings` 给出"拆镜或降低时长"的建议；不静默压缩 |
| S5 | 第 1 段无前驱，恒 `needsTailChain=false` | — |
| S6 | 空表 / 全部镜头无 `visual` 与 `motion` → 0 段 + 提示，不建任何节点 | 直接返回 `warnings:['没有可用镜头']` |

#### 3.1.5 示例（可机械复核）

原始 13 镜（`seg` 为示意，实际由 `shotContinuityPlan` 推断）：

| 镜 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 时长(s) | 2.0 | 3.0 | 2.5 | 1.5 | 4.0 | 2.0 | 2.5 | 3.5 | 2.0 | 1.5 | 3.0 | 2.0 | 3.0 |
| seg | opening | cont | cont | closeup | scene_change | cont | cont | new_character | cont | closeup | cont | cont | scene_change |

`maxClipSeconds = 15` 时切段结果：

| 段 | 镜范围 | 时长 | 首/末 seg | 断点依据 | seamRisk | needsTailChain |
|---|---|---|---|---|---|---|
| 1 | 1–4 | 9.0s | opening / closeup | B：本段以特写收尾，下一段换场 | none | 否 |
| 2 | 5–9 | 14.0s | scene_change / continuation | A：第 5 镜是换场；再加第 10 镜 15.5s 超限 | none | 否（首镜切点） |
| 3 | 10–13 | 9.5s | closeup / scene_change | A：第 10 镜是特写插入；到表尾 | none | 否 |

合计 32.5s = 原始总时长；三段都在切点起步/收尾，**不需要尾帧硬接**。对照反例（6 镜 ×3s 全 continuation，上限 15s）：段 1 = 前 5 镜 15.0s，段 2 首镜仍是 continuation → `seamRisk='forced'`，需按 S3 把第 6 镜改写为 `closeup`（或拆镜），否则退回旧式接力。

#### 3.1.6 `segments[]` 字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `index` | int | 段序号（从 0 起） |
| `shotIds` | int[] | 本段包含的镜头下标（连续、有序、全表恰好一次） |
| `duration` | number | 本段总时长（一位小数） |
| `firstSeg / lastSeg` | string | 首镜/末镜的 `seg` |
| `opensOnCut / closesOnCut` | bool | 是否以切点开始/收尾 |
| `seamRisk` | `'none'｜'chain'｜'forced'` | 无风险 / 需尾帧接力 / 硬切 |
| `needsTailChain` | bool | 见 §3.2；仅"上段末镜与本段首镜同为 continuation 且模型支持硬首帧"时为 true |
| `reason` | string | 人类可读的切段依据（面板可见） |
| `forcedRewrite` | object? | `{shotIndex, action:'split'｜'relabel', newSeg}`；S3 降级时给出。**落地状态：未实现**——当前用 `warnings[]` + `cutMode='forced'` 表达，不做自动拆镜（见 §3.5） |
| `warnings[]` | string[] | 需要用户看到的告警（不静默） |

#### 3.1.7 与现有代码的接线点

| 现有函数 | 改动 | 兼容性 |
|---|---|---|
| `shotContinuityPlan` L2875 | 原样复用：切段只消费其 `seg`，不改 `tail/cam/start` 语义 | 零改动 |
| `buildStoryboardVideoPrompt` L7935 | 增加可选 `segment` 参数：只输出本段 `shotIds` 对应镜头（其余逻辑不变） | 不传 = 旧行为 |
| `resolvePrompt` L7967 | 视频节点有 `data.videoSegment` 时把它传给上面的构建函数 | 无分段 = 旧路径 |
| `runGenNode` L8262（`plan` L8337） | 用本段首镜算 `seg/join`；`chain` 改为 `segment.needsTailChain` | 旧节点无 `videoSegment` 时沿用现逻辑 |
| `expandStoryboard` L11170 | 新增"按镜头切段"分支：N 镜 → M 个 video 节点；其余（参考图、资产节点）逻辑复用 | 旧入口保留 |
| `autoPrevVideoNode` L5690 | 保持不变；分段节点依靠顺序/位置 + 显式 `frame` 连线找到上一段 | 不改语义 |
| `buildStructuredVideoPrompt` L3150 | 逐镜行追加 `timeBeats/camera/vfx`；段末追加 `negative` | 可选字段缺省不输出 |

### 3.2 强弱衔接模型分流

#### 3.2.1 能力表（设计目标；现状为轻量替代：分镜表 `segMaxSeconds` + 模型名正则，见 §3.5）

| 字段 | 取值示例 | 用途 |
|---|---|---|
| `maxClipSeconds` | 15 / 10 / enum `[5,10]` | 切段上限；枚举型按最近合法值吸附 |
| `durationMode` | `'enum'｜'range'｜'int'` | 决定节点 `duration` 如何取整 |
| `supportsHardFirstFrame` | true/false | 决定 `needsTailChain` 是否允许 |
| `firstFrameVsRefExclusive` | true/false | 决定走 `hard` 还是 `auto`（参考图优先） |
| `maxRefImages` | 0/8/9 | 对齐现有 `VIDEO_REF_CAPS`（L5213-5222） |
| `multiShotReliable` | true/false | 决定一段内允许多少镜（弱模型建议 1–3 镜/段） |

#### 3.2.2 模型分类与路由

| 类别 | 典型 | 判定依据（现状证据） | 切段策略 | `needsTailChain` |
|---|---|---|---|---|
| A 强衔接 | Seedance 2.5 / Kling 等支持硬首帧 + 多镜的模型 | `frameMode='hard'` 可用；参考图与首帧二选一时优先硬首帧 | 允许 10–15s 段；段内可 3–6 镜 | 仅当上段末镜与本段首镜同为 `continuation` 且允许硬首帧 |
| B 中等 | MiniMax H3/v2、Wan 等 | 支持首帧/参考图但互斥（L5233-5235、L8387） | 优先切点分段；段长 ≤ 能力值；必要时软锚定 | 同 A，但提示词用软锚定（`frameAnchorText`） |
| C 弱衔接 | MiniMax V1（海螺）等 | `VIDEO_REF_CAPS.minimax.img = 0`（L5218-5221）；时长按 6/10s 取整（L4694、L4931） | **禁止接力**：每段以切点开始/收尾，独立成镜；段长按枚举吸附 | 恒 false |
| 未知 | 未登记模型 | 无能力字段 | 按 C 处理（安全默认） | false |

#### 3.2.3 `needsTailChain` 判定（唯一公式）

```text
needsTailChain =
      segment.index > 0
  AND prev.lastSeg === 'continuation'
  AND segment.firstSeg === 'continuation'
  AND caps.supportsHardFirstFrame
```

说明：
- 只要边界两侧任一侧是切点（A/B 形态），就**不该**接力——接力会把"换镜头"重新焊回"同一镜头"；
- 弱模型（C/未知）恒 false，并在 UI 明示"本模型不支持可靠首帧接力，已按独立镜头切分"；
- 旧路径（无分段信息）保持现逻辑：首镜 `continuation` 且 `cont` 开启才接力（L8354）。

### 3.3 提示词升级

#### 3.3.1 `shots[]` 新增可选字段（向后兼容）

| 字段 | 内容 | 约束 | 示例 |
|---|---|---|---|
| `timeBeats` | 3 个时间点 + 该点发生什么 | **≤3 个**；覆盖 0–100% 时长；一镜只一条动作链 | `0–1.2s 抬手；1.2–2.8s 指尖触到封口；2.8–4s 停住并抬眼` |
| `camera` | 机位 + 焦段/光圈 + 运动（起点→终点） | 一镜一种主运镜；焦段/光圈从预设取 | `右后过肩中近景；50mm f/2；静止 → 缓慢推近 → 停在眼部` |
| `vfx` | 物理特效清单（可执行、非魔法） | 只写物理可发生的效果；≤3 项 | `雨打湿肩线、纸屑被风卷起、门缝光带扫过墙面` |
| `negative` | 本镜负面项（换脸/漂移/穿模/闪烁/口型） | 与全局负面合并去重 | `不要笑、不要看镜头、不要戴帽子` |

#### 3.3.2 字段 → 提示词段落映射

| 提示词段落（`buildStructuredVideoPrompt` 现有结构） | 注入内容 |
|---|---|
| `subject_definitions:`（L3228） | 不变（主体与 `<Picture N>` 绑定） |
| `retention_analysis:`（L3247） | 不变（保真核对） |
| `detailed_description:` 的 `[Shot N]` 行（L3266-3310） | 现有 `visual` + `motion` + `台词` + `音效`，追加 `时间节拍：…`、`镜头：…`、`物理特效：…` |
| `continuity:`（L3322-3327） | 段首跨段承接（有 `needsTailChain` 时才有）保持现状 |
| 新增 `negative:` 段末段 | 全局负面 + 各镜 `negative` 合并去重 |

升级后的单镜行示例（示意）：

```text
[Shot 2] 00:02.000 起（掏信）：中近景，右后过肩，主体偏左；
  时间节拍：0–1.2s 右手抬到胸口；1.2–2.8s 指尖触到火漆封口；2.8–4s 停住并抬眼；
  镜头：50mm f/2，静止→缓慢推近→停在眼部；物理特效：雨珠沿袖口滑落、信封边角被风掀动；
  台词：陈拾：这封信……；音效：纸页摩擦、远处车流
```

#### 3.3.3 运镜最小预设（先落 8–10 个，其余自由文本）

| id | 名称 | 起点→终点写法 |
|---|---|---|
| `push_in` | 缓推 | 中景静止 → 匀速推近 → 停在近景（背景压缩） |
| `pull_out` | 缓拉 | 近景 → 匀速后拉 → 环境全景（显露处境） |
| `pan` | 摇镜 | 主体 A → 水平摇向 → 主体 B（同轴） |
| `truck` | 横移跟拍 | 与主体同速横移 → 保持距离 → 停在遮挡处 |
| `follow` | 跟拍 | 主体起步 → 同向跟随 → 主体停下 |
| `orbit` | 环绕 | 正面 → 半环绕 → 侧面（主体居中） |
| `crane` | 升降 | 人物高度 → 升起 → 俯视全景 |
| `handheld` | 手持逼近 | 中景 → 手持抖动 + 加速逼近 → 半臂处急停 |
| `whip` | 甩镜 | 主体 A → 快速甩动（运动模糊）→ 新构图 B |
| `static` | 定镜 | 构图不动 → 只有主体与环境细节变化 |

焦段/光圈默认规则：大特写 85–135mm / f/1.8–2.8；近景 50–85mm / f/2–2.8；中景 35–50mm / f/2.8–4；全景 24–35mm / f/4–5.6。模板声明沿用 BeefTV 的防误绘思路：**"这是虚拟摄影参数，不是画面里的摄影机"**。

#### 3.3.4 负面清单（默认全段生效）

`换脸、五官漂移、服装变化、手部畸形、多指、穿模、画面闪烁、风格突变、动作僵硬、人物凭空出现或消失、口型与台词不同步`；各镜 `negative` 追加到本段。提示词长度超预算时，按 `vfx > timeBeats > camera` 顺序裁剪，**不得裁剪 visual/motion/seg/tail**。

### 3.4 画布交互

#### 3.4.1 交互入口「按镜头切段」

**落地状态**：`0a5b96d` 已把切段作为 `expandStoryboard` 的默认路径（`segMaxSeconds` 在生成面板配置、分镜表节点显示切段预览、铺开时按段建节点）；下方"独立按钮"是可选增强（若需要显式入口再加，行为同表）。

位置：分镜表节点底部操作栏（若新增独立按钮，与 `expandStoryboard` 现有入口并列）；仅当 `shots.length > 0` 时可见。

| 步 | 行为 |
|---|---|
| 1 | 读取分镜表 `shots[]` 与当前视频模型能力（§3.2）；无能力信息 → 按弱模型默认 |
| 2 | 调 `planShotSegments(shots, maxClipSeconds)` |
| 3 | 在分镜表右侧按段建 M 个 video 节点（沿用 `expandStoryboard` 的参考图/资产节点布局，资产只建一次） |
| 4 | 每个视频节点写 `data.videoSegment = {index, total, shotIds, startIndex, endIndex, seamRisk, needsTailChain}`；`duration` 按能力表吸附到合法值 |
| 5 | 只对 `needsTailChain=true` 的段，从上一段 video 的 `tailpick/last` 口连 `frame`；其余段**不连 frame** |
| 6 | 节点标签：`场N · 段k/M`；徽标：`切点` / `接力` / `硬切(forced)` / `弱模型·不接力` |
| 7 | 所有节点一次性 `pushHistory()` + `flushSave()`；失败可整体撤销 |
| 8 | 弹一条汇总：`已按镜头切成 M 段（切点 k 个，硬切 j 个，预估生成 M 次）` |

#### 3.4.2 节点数据与旧路径

| 情况 | 行为 |
|---|---|
| 新切段节点（有 `videoSegment`） | `resolvePrompt`/`runGenNode` 只取本段镜头；`chain` 由 `needsTailChain` 决定 |
| 旧节点（无 `videoSegment`） | 完全沿用旧逻辑（整表一次生成、首镜 continuation 才接力） |
| 分镜表在切段后被编辑 | 对比 `shotIds` 对应镜头的 `visual/motion/seg/duration` 哈希；不一致 → 节点标记「分段已过期」并给「重新切段」入口（不自动删除用户已有视频） |
| 关闭切段开关 | `expandStoryboard` 仍可走旧入口；切段是新增分支，不是替换 |

#### 3.4.3 实施顺序（每阶段可独立验收）

> 本节是原始实施顺序；`0a5b96d` 已基本按 P1→P4 落地，保留用于回溯与后续补项拆分。

| 阶段 | 内容 | 可独立验收 |
|---|---|---|
| P1 | 纯函数规划器 + 单元测试（不接 UI、不改行为） | §4 的 A1–A6、A13 |
| P2 | `shots[]` 可选字段 + 提示词构建升级（旧数据不变） | §4 的 A8、A14、负面/节拍断言 |
| P3 | 切段铺开 + 节点数据 + frame 连线规则 | §4 的 A7、A9、A10、A11 |
| P4 | 能力表、弱模型分流、UI 徽标与告警、技能文档同步 | §4 的 A12、A15 |

### 3.5 落地状态对照（HEAD `94d1f47` / `0a5b96d`）

| 方案项 | HEAD 落地情况 | 状态 |
|---|---|---|
| 3.1 切段规划器 | `isCutPoint` L3049、`planShotSegments` L3070；输出 `index/shotIds/shots/startIndex/endIndex/duration/firstSeg/lastSeg/opensOnCut/closesOnCut/seamRisk/needsTailChain/reason` + `total/max/cutMode/warnings` | **已落地**；差异：无 `forcedRewrite` 字段（用 `warnings` + `cutMode='forced'` 表达） |
| 3.1 `needsTailChain` 公式 | 规划器内为 `index>0 && !isCutPoint(firstSeg)`；模型能力在运行期另由 `segmentNeedsHardFrame` 判定 | **部分落地**：公式少了"上段末镜同属 continuation"这一项，可能把"上段以 closeup 收尾、本段 continuation"误标为需接力（低风险，建议按 §3.2.3 收紧） |
| 3.2 弱衔接分流 | `segmentNeedsHardFrame(seg, modelName)` L3168：模型名正则 `minimax\|hailuo\|kling-?1\|pika\|stability\|svd` 判弱，弱模型返回 false（不接力） | **部分落地**；差异：未引入 §3.2.1 能力表，靠模型名正则（新增厂商易漏，**待核**） |
| 3.3 提示词升级 | `aiStoryboardShots` 的 JSON 契约 L7249-7271 已输出 `timeBeats/camera/vfx/negative`；`buildStoryboardVideoPrompt` L8126 逐镜注入并按段过滤；段级 `negative` 已合并 | **已落地**（字段名 `timeBeats` 为数组，与 §3.3.1 的"3 个时间点"一致） |
| 3.3 单镜时长不再抬到 1s | `buildStoryboardVideoPrompt` 内 `durOf = max(0.3, …)`，快切 0.6s 不再被抬成 1s | **已落地**（R3 根因修复） |
| 3.4 按段铺开 | `expandStoryboard` L11443 按 planner 建多个 video 节点；节点字段 `segShotFrom/segShotTo`；`videoSegmentOf` L8214；`segMaxSeconds` 面板配置 L10471、节点切段预览 L11319 | **已落地**（不是独立按钮，而是铺开默认路径 + 预览；独立按钮为可选增强） |
| 3.4 frame 连线只给需接力的段 | `expandStoryboard` L11708-11714 循环里 `if (!segs[k].needsTailChain) continue` 才连 `frame`；`runGenNode` L8496 起 `chain` 使用 `segMeta.needsTailChain` + `segmentNeedsHardFrame` | **已落地** |
| 3.4 分段过期检测（哈希） | 未发现 `segShotFrom/To` 与分镜镜头内容的哈希对比 | **未落地**（风险保留于 §5.1） |
| 3.1 S3 自动拆镜/改写 | 仅 `warnings` 提示"拆成两镜/标换场"，不自动改写 | **未落地**（当前降级策略是"告警 + 由用户改分镜"） |
| 验收测试 | `scripts/test-segment-plan.mjs`（275 行）覆盖规划器、弱模型判定、分段提示词、节点字段 | **已落地**（覆盖范围见 §4 末尾说明） |
| 技能同步 | `assets/canvas-craft/SKILL.md` 已补 timeBeats/camera/vfx/negative 与"切段友好"纪律 | **已落地**（0a5b96d 中 +169 行） |

---

## 四、验收口径

> 下表的测试已部分落地为 `scripts/test-segment-plan.mjs`（覆盖 A1–A6、A8、A12、A15 + 源码级防回退）；**待补项**见本节末尾。

| ID | 断言 | 怎么测 |
|---|---|---|
| A1 | 同一 `continuation` 镜头不得跨段；段与段之间的边界必须落在合法切点（§3.1.2 A/B/C/D 之一） | 遍历相邻两段（上段末镜、本段首镜）断言边界合法；随机 shots 属性测试 |
| A2 | 每段 `duration ≤ maxClipSeconds`（单镜超长例外，且必须 `seamRisk='forced'`） | 表驱动 + 随机边界（0.3s/15s/15.1s） |
| A3 | 第 1 段之外，每段首镜必须是切点镜头（A 形态）或上一段末镜是切点镜头（B 形态）；否则 `seamRisk='forced'` | 遍历段首/上段末镜断言 |
| A4 | 镜头恰好被覆盖一次：`segments.flatMap(shotIds)` 与 `[0..n)` 完全相等且有序 | 集合/数组相等断言 |
| A5 | 时长守恒：`Σ segments.duration == Σ shots.duration`（±0.1s） | 数值断言 |
| A6 | `needsTailChain=true` ⇒ 上段 `lastSeg==='continuation'` 且本段 `firstSeg==='continuation'` 且模型能力允许硬首帧 | 直接对输出对象断言；弱模型能力表下恒 false |
| A7 | `seamRisk='forced'` ⇒ `warnings` 非空且 `forcedRewrite` 存在；提示词含「不承接上一段画面」 | 断言对象 + 提示词字符串包含 |
| A8 | 每个视频节点提示词的镜头数 = 本段 `shotIds.length`（解析 `[Shot N]` 出现次数）；不出现其它段镜头标题 | 以段落文本断言，防止"整表提示词"漏进分段节点 |
| A9 | `frame` 连线只存在于 `needsTailChain=true` 的段；弱模型下为 0 条 | 用假图（节点/边对象）跑 `expandStoryboard` 分支后统计边 |
| A10 | 节点 `duration` 落在能力表合法集合内；非法值吸附并产生可见告警 | 能力表枚举/区间两种配置各跑一遍 |
| A11 | 旧项目（无 `videoSegment`）铺开后仍只有 1 个 video 节点，提示词与旧版逐字一致 | 快照/字符串对比 |
| A12 | 未登记模型按 C 类（不接力、段长保守）处理 | 清空能力表后重跑规划 + 断言 |
| A13 | 空表 → 0 段、不建节点、有可见提示 | 空 `shots` 调用 |
| A14 | 段末镜的 `tail` 出现在下一段首镜提示词的承接块里（仅 `needsTailChain=true`） | 拼接两段提示词做包含断言 |
| A15 | 单镜 > 上限：该段只含此镜，`seamRisk='forced'`，`warnings` 含"拆镜/降时长"，且不截断内容 | 构造 18s 单镜 × 1 的表 |

**已覆盖**（`scripts/test-segment-plan.mjs`）：A1–A6、A8（段内提示词只含本段镜头）、A12（MiniMax/Seedance 判定）、A15（20s 单镜告警），以及"规划器/字段存在、`expandStoryboard` 未退回单节点"的源码级防回退。
**待补**：A7（`forcedRewrite` 未实现，只能断言告警）、A9（frame 连线数量）、A10（能力表时长吸附）、A11（旧路径快照）、A13（空表）、A14（跨段 `tail` 文本）。

---

## 五、风险与不做的事

### 5.1 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 生成次数上升 | 成本与等待时间增加（M 段 = M 次调用） | 默认只在超限时切；面板显示"预估 M 次"；允许用户手动合并相邻段（合并会标 `chain` 风险） |
| 段间仍不连续（弱模型） | 用户仍可能看到接缝 | C 类模型明确"不接力、按切点独立成镜"；UI 写清原因，不承诺像素级连续 |
| `seg` 推断误判 | 切点选错（例如把普通续帧判成 `closeup`） | 规划器只信 `seg` 字段；推断仅兜底（`shotContinuityPlan` L2879-2894）；面板显示"切点来源：手写/推断"并提供手改 |
| 分镜手改后分段过期 | 视频节点还在用旧段落 | 哈希对比 + "分段已过期"徽标 + 重新切段入口；不自动删除已生成视频 |
| 厂商忽略/钳制 duration | 段长与设置不一致 | 沿用现有 `probeVideoMeta` 事后告警（L8466-8477）；能力表吸附降低概率 |
| 提示词膨胀 | token 成本与模型注意力下降 | 新字段按需输出；超预算按 §3.3.4 顺序裁剪 |
| 单镜超长 | 无法切、厂商拒绝 | S4：不截断内容，单独成段 + 明确告警 + 建议拆镜 |
| 并发生成顺序错乱 | 后续段拿不到上一段尾帧 | 依赖 `frame` 边的段在 UI 上建议顺序生成；`autoPrevVideoNode` 已按位置/链上溯，保留兜底 |
| 旧数据/旧项目兼容 | 升级后旧画布异常 | 字段全可选、旧路径保留；回归 A11 快照 |

### 5.2 明确不做的事

1. **不复制、不移植 BeefTV 代码**（含类型定义、提示词模板、运镜表的具体文本）；只借鉴接口形态与设计思想，见 §5.3。
2. **不做镜头内插帧/光流补间**：动作相位问题用"切点分段"解决，不引入逐帧生成。
3. **不自动重写剧本分场**：分场仍由编剧/技能维护；切段只是消费既有 `seg` 信息。
4. **不做成片级重编码拼接**：画布已有成片合成链路，切段不替代它。
5. **不承诺厂商物理时长**：厂商会钳制/忽略 `duration`，只保证"请求值合法 + 实际值可见"。
6. **不删除旧单节点路径**：切段是新增分支，可一键退回。
7. **不把"`start` 重设"自动判定为切点**：先作为可选规则（§3.1.2 D），命中词表策略**待核**，避免误切。

### 5.3 许可与合规

`_refs/BeefTV-main` 采用 **BeefTV Source Available License 1.0（Part A）**：允许个人/研究/组织内部使用与修改，但它**不是 OSI 开源许可**，且与 Apache-2.0 的再分发条款不兼容（其 `LICENSE` 明确 Part A 只覆盖新原创部分，历史 MIT 部分另行保留）。因此：

- 本仓库（Apache-2.0）**不得**引入、抄写或改写 BeefTV 的任何代码/提示词文本/类型定义；
- 本文只记录"它有哪些设计、为什么有效"，具体实现必须由我们独立编写；
- 若未来需要更详细对照，只能阅读接口与文档，不得复制实现片段。

---

## 附录 A：引用自查

**方法**：用 Node 读取 `client.js`（并对照 `git show HEAD:client.js`），把本文提到的每个函数/常量名做一次 `includes` 检查。

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('client.js','utf8');\
const names=[...];let p=0,f=[];for(const n of names){s.includes(n)?p++:f.push(n);}\
console.log(JSON.stringify({total:names.length,pass:p,fail:f}))"
```

**自查名单（30 个）**：`shotContinuityPlan`、`storyboardContinuityNote`、`shotContinuityBlock`、`frameAnchorText`、`frameSeamMetrics`、`seamVerdict`、`buildStructuredVideoPrompt`、`buildEffectivePrompt`、`extractTailFrames`、`apiVideo`、`autoPrevVideoNode`、`EXPERT_STORYBOARD`、`buildExpertContext`、`checkShotConsistency`、`aiStoryboardShots`、`buildStoryboardVideoPrompt`、`resolvePrompt`、`prevSceneTail`、`runGenNode`、`genStoryboardNode`、`parseScriptScenes`、`expandScriptToScenes`、`expandStoryboard`、`minimax`、`minimaxv2`、`VIDEO_DURATIONS`、`VIDEO_REF_CAPS`、`VIDEO_VENDORS`、`planShotSegments`、`videoSegmentOf`

| 类别 | 数量 | 结果 |
|---|---|---|
| 修复前基线 `452f647` 中已存在 | 28 | **28 / 28 通过**，失败 0 |
| 本文方案新增、`0a5b96d` 已合入 HEAD | 2（`planShotSegments` / `videoSegmentOf`） | **2 / 2 通过**，失败 0 |
| **合计（HEAD `94d1f47`）** | **30** | **30 / 30 通过，失败 0** |

**自查脚本实际输出**：

```text
HEAD(94d1f47): {"total":30,"pass":30,"fail":[]}
WORK:          {"total":30,"pass":30,"fail":[]}
```

> 行号说明：§1 的行号对应修复前基线 `452f647`（用于解释问题）；§3.5 的行号对应 HEAD `94d1f47`。两者若随代码演进偏移，请按函数名检索。本文不包含代码改动。
