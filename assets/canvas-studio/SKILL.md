---
name: canvas-studio
description: 用无限画布（Infinite Canvas）做短剧/视频创作时使用：创建或复用项目、写剧本与分镜、触发生成、查看结果、命名与清理。用户提到画布、无限画布、短剧项目、剧本节点、分镜、生成视频，或要求"建个画布项目/把内容写进画布"时，先加载本技能再动手。Load this skill before operating the infinite canvas.
---

# 无限画布操作规程（流程手册）

画布 = 按项目组织的节点工作台：剧本 → 分镜 → 图片 → 视频 → 成片。你（对话模型）是操作者：
**所有画布操作只能通过 canvas_* 工具完成**，不要臆造节点或项目状态。
本篇是**流程与纪律**；"怎么写好"看 `canvas-craft`，风格口径看 `canvas-director`，节点摆放看 `canvas-layout`。

## 〇、阶段机与闸门（先读这一节）

每个画布（= 一集）有宿主强制的**制作阶段**：

```
brief → bible → assets → script → storyboard → shots_ready → generating → qc → post → delivered
```

- **随时可查**：`canvas_production_status` → 当前阶段、闸门通过情况、缺失清单、证据计数、下一步。
- **完成语义**：宣称"完成/可交付"前必须调它；只有 `ready:true` 或用户明确验收才允许说完成。
- **阶段不是内容模板**：只规定"现在该做哪类操作"；剧情、人物、风格永远由你和用户决定。
- **六道代码闸门**（宿主直接拒绝，不是建议）：

| 闸门 | 触发 | 要求 |
|---|---|---|
| G1 设定集先行 | 生成剧本/分镜前 | 世界观 + 风格 + ≥1 角色 |
| G2 分镜质量 | 建/跑视频节点前 | 时长/画面/景别/大特写/三镜不同运动/seg 合法 |
| G3 一表一视频 | 建视频节点 | 该分镜表下不能有第二个视频（改参数用 `canvas_update_node`） |
| G4 禁逐镜节点 | 建图片/视频 | 名字不得含「镜N」（一致性靠参考图资产） |
| G5 破坏性确认 | 删节点/项目 | 必须带 `confirm`（用户确认原话） |
| G6 阶段越序 | 触发视频 | 阶段 ≥ shots_ready |

- **逃生舱**：用户明确要求时传 `override: { by: 'user-explicit', quote: '用户原话' }` 放行（写入审计）；
  绝不用 override 绕过用户没同意的事。
- **显式推进/回退**：`canvas_production_advance`（必须带 reason）；日常推进自动，不需要调它。

## 一、本插件技能清单（分工与口径入口）

| 技能 | 管什么 | 何时加载 |
|---|---|---|
| `canvas-studio`（本篇） | 操作流程：建项目/写节点/触发/查状态 | 任何时候先读 |
| `canvas-craft` | 剧本四要素、分镜六要素、术语勘误、资产图版式 | 写剧本/分镜/提示词前 |
| `canvas-layout` | 一类型一列、绝不重叠 | 批量建节点前 |
| `canvas-director` | 导演透镜/题材/规格/影调/运镜 | 定风格前 |

- 调 `canvas_list_skills`：一次返回四份技能说明 + 四层完整清单（id 与名称）+ 项目已选配置。
- 调 `canvas_skill_pack({ projectId, kind })` 取切片（script/storyboard/prompt/assets），
  **不要整份读技能包文件**；`set:true` 写进项目配置 = 对话与画布自生成同口径的唯一入口。

## 二、硬约束（违反 = 操作失败）

1. **设定集先行**：写剧本/分镜/生成前必须 `canvas_get_bible` 读、缺则 `canvas_update_bible` 补
   （用户已给创意按其创意写，不另起一套）。创作意图/世界观/风格**只进设定集**，
   【禁止】为它们建任何节点；角色/场景/道具参考图从设定集条目生成（image 节点 → `canvas_run_node`）。
2. **同一请求最多建一个项目**：`canvas_create_project` 前先 `canvas_list_projects` 查重，同名/同主题直接复用。
3. **绝不为单个节点建项目**：加内容用 `canvas_write_node`；只有用户明确"另开项目"才新建。
4. **失败重试不重建资源**：先查是否已创建成功，复用，不靠"再建一个"。
5. **每个节点都要有名字**（`name`），同名加区分后缀。
6. **一个剧本节点同时有 `idea` 与 `output`**：正常由节点生成（idea → `canvas_run_node`）；
   仅用户明确"直接写稿"才 `target:'output'`。【禁止】拆成两个半残节点、只写提纲占位；
   分镜内容只能放分镜表节点。
7. **删除是破坏性操作**（G5）：`canvas_delete_node` / `canvas_delete_project` 先列表确认 id，
   仅在用户明确要求时执行，必须带 `confirm`（用户原话）；改内容永远走 `canvas_update_node`，不需要删。
8. **完成后让用户看到**：`canvas_open({ projectId })`。
9. **一致性告警闭环**：`canvas_node_status` 的 `warnings` 非空时逐条 `canvas_update_bible`
   （名称逐字一致、描述可生成），绝不忽略或只补一半；设定集更新后告警自动重算，以最新一次为准。
10. **分镜粒度**：一个分镜表 = 一个完整场景视频；各镜时长按节奏谱系（普通 2–4s / 快切 0.3–0.8s /
    反转 1–2s / 情绪长镜 ≥5s），支持一位小数、拒绝均匀分布；长剧本按【场N】拆成多个场景剧本节点，
    整集剧本只作总纲不连分镜表；`shots` 上限 24；镜头数按内容节拍（3–10 镜都正常），绝不凑数。
11. **汇报固定要素**：项目名 + id + 节点名/id + 成稿摘要；有错误如实说明；`genWarn` 必须转达。
12. **生成前置检查单**：① 镜头清单只来自分镜表 `shots`（读不到就问用户，绝不编造）；
    ② 一个分镜表只建一个视频节点（G3）；③ 先建 1 个、`canvas_node_status` 验证、再继续。
13. **读不到就问**：必需状态读不到 = 向用户确认的缺口，绝不把"编一份"当替代。
14. **连贯靠连线**：上一场分镜表 `tail` → 本场 `prev`（`canvas_connect`）；生成后第 1 镜自动承接
    上一场尾镜（重叠 ≤0.2s、背景声连续）。【禁止】用名字/序号猜衔接；补连后重跑该分镜表即可修正。
15. **口型同步**：带 `dialogue` 的镜头必须让说话角色画面内开口（近/中近景、脸部可见），
    台词绝不能变画外音；`visual`/`motion` 写明「开口说话、口型清晰可见」。
16. **分段接戏四字段**：`tail`（动作进行中）/`cam`（可延续）/`start`（仅非续帧）/`seg`
    （只能 opening/continuation/scene_change/new_character/closeup）；改 `shots` 必须**整表替换**
    并保留这四字段；只有 `continuation` 接力尾帧。视频优先用 `tailpick` → `frame`；
    衔接模式三选（参考图融合默认 / 硬首帧 / 忽略首帧）；接缝校验偏跳时调低运动或改硬首帧。
17. **分镜质量闸门（G2）**：生成视频前按六条自检（每场冲突点 / 每场 1 个大特写 / 连续三镜不同运动 /
    景别具体 / 因果钩子 / 六要素齐全）；不过先重生成或改 `shots`——**绝不带粗分镜烧视频**。
    术语统一：「大特写」「调度」；motion 写「起点→方式→终点」（勘误表见 canvas-craft）。
18. **多画布**：`canvas_list_projects` 列出 `canvasId` 清单；用户指明画布时所有工具**显式带 `canvasId`**；
    资产与设定集按项目共享，不重复建。
19. **记忆先行 + 会话=画布**：开工先 `canvas_my_canvas` 自证「我是哪一集」；绑定会话**代码级禁止**
    跨画布/跨项目（确需切换请用户先解绑）；写本集前 `canvas_read_memory`（先调度索引后本集正文；
    设定集存静态、记忆存动态）；收尾必 `canvas_write_memory`（title/summary≤120 字/keywords/body/status）。

## 三、标准工作流

0. **读/补设定集**：`canvas_get_bible` → `canvas_update_bible`（worldview/style/characters/scenes/props）。
1. `canvas_list_projects` 查重，拿 projectId 与节点 id。
2. **剧本节点**（一集 60–120s，按【场N】分场）：新项目 `canvas_create_project({ name, scriptText: 提示词 })`；
   已有项目 `canvas_write_node({ target:'idea', name:'第X节剧本' })` → `canvas_run_node` → 轮询状态。
   提示词必须点名两条叙事硬约束：每场结尾因果钩子（可拍摄的动作/物件，禁总结句）+ 每场至少一个冲突点
   （目标—阻碍—转折—代价）。生成契约自动注入：4–10 场、每场 10–30s、每场以「【场N】场景名（地点·时间）」
   单独一行开头、对白逐行「角色：台词」、结尾附人物/场景/道具清单。
3. **铺开到场景**：逐场建「场Y文本」（`canvas_write_node` 写该场原文）+ 「场Y分镜表」
   （`canvas_create_node({ type:'storyboard', connectFrom: 文本节点 })`）；
   上一场分镜表 `tail` → 本场 `prev` 依次串联，**连好再生成**该场分镜（重生成分镜免费）。
4. **逐场视频**：`canvas_run_node` 分镜表 → 读 `shots` → 过 G2 六条 → `canvas_create_node({ type:'video',
   connectFrom: 分镜表, duration: 各镜之和 })` → `canvas_generate_node({ waitSeconds })`。
   多镜头一次生成，**禁止逐镜建节点**（G4）；最多为开场首帧/关键镜头补 1–2 张定帧图；
   参考图连视频 `ref` 口，`@资产名@` 命中自动挂载。跨段首帧画布自动接力（连好 `tail→prev` 即可用）。
5. **参考图**：为设定集每条目建 image 节点（命名规范见下节），prompt 按 canvas-craft「资产设定图版式」
   写足（角色六段式/场景主图+环绕/道具 45° 主图+色卡），不留空壳节点。
6. `canvas_open({ projectId })` 让用户看到结果。**布局**：要精准摆放（对齐/指定坐标/分列）先 `canvas_layout_get` 读全图坐标，再 `canvas_layout_node` 批量精摆（可 `pinned:true` 钉住）；只是想"整体理一下"才用 `canvas_relayout`（粗排兜底，钉住的节点不动）。

## 四、@引用与资产命名（跨集一致性核心）

提示词用 `@资产名@` 精确引用设定集条目（前后各一个 @，句末也要闭合）；
命中后自动带外观描述 + 参考图资产 `[图N]`。命名规范（`canvas_create_node` 的 `name` 直接写）：

| 用途 | 命名 | 例 |
|---|---|---|
| 角色 | `角色-<名> 设定图` / `参考图` | `角色-张山 设定图` |
| 场景 | `场景-<名>` | `场景-褶皱巷` |
| 道具 | `道具-<名>` | `道具-火漆信` |
| 分镜整段视频 | `<集数>-<场次> 多镜头视频` | `第1集-场3 多镜头视频` |

纪律：只沿用设定集已有名称、**绝不改名**；已生成参考图持续复用；缺参考图先补再生成。
同一角色的声音一致性：用视频/成片节点「提取声音参考」（输入角色名，自动按 `dialogue` 定位拼接）。

## 五、节点类型与生成能力

| 类型 | 用途 | 要点 |
|---|---|---|
| `script` | 剧本 | `idea`=创作提示词，`output`=成稿 |
| `storyboard` | 分镜表 | 源端=场景文本连线；`shots` 结构化镜头 |
| `image` | 图片（合并类型） | 有 `assetId` 即资产；面板不渲染成段文字（≤4 字标签） |
| `video` | 视频（合并类型） | 多镜头一次生成；`duration`=各镜之和 |
| `text` / `finalcut` | 自由文本 / 成片 | finalcut 导出 FCP7 XML + SRT 交 FilmCraft |

- **改不删**：改内容一律 `canvas_update_node`（prompt/idea/output/text/shots/ration/duration 等；
  结构字段不可改）+ 重新生成；用户改提示词/换参数全程不需要删节点。
- **生成**：图片 30–120s、视频数分钟；`canvas_generate_node({ waitSeconds })` 一次等终态
  （画布页面须打开），或 `waitSeconds:0` 后轮询 `canvas_node_status`（≥10s 一次，不反复触发）。
- **视频提示词自动结构化**（分镜+参考图+设定集 → 厂商参考生成格式）：你只需保证
  ① 每镜 `dialogue` 有「角色名+逐字台词」② 设定集条目带「外观：」「声音：」③ 参考图已连线。
- **失败如实说**：`canvas_node_status` 的 error / `genWarn`（截断、忽略参数、接缝校验）必须转达，
  绝不谎报已生成；模型未配置时建议用户在画布设置里更换。
- **参数不臆造**：文本走 Harness 默认（画布可覆盖输出上限/温度）；图片/视频仅发送用户配置的覆盖项。

## 六、ArtCraft 后期（PhotoCraft / EffectCraft / FilmCraft）

前置：安装 `dsh-artcraft` 并配置 CLI 路径（设置 → Craft 卡片显示就绪状态）。
顺序：素材就绪 → 资产落盘（同步按钮）→ PhotoCraft 调色 → EffectCraft 片头 → FilmCraft 成片渲染 → 交付。
**边界如实告知**：后期执行按钮在画布 UI 上，对话侧负责准备节点/提示词/触发生成并引导用户点击；
先 `artcraft_status` 探活，链 id 以 `artcraft_recipes` 返回为准（不背名单）；QC PASS 前不宣告完成。

## 七、必须避免的错误

- ❌ 一次请求建多个项目 / 每个节点建项目 → 查重复用 + `canvas_write_node`
- ❌ 只写提示词不给成稿落点 / 节点不留名字
- ❌ 未经确认删除（G5 会拒）→ 先列表确认，再按用户明确要求执行
- ❌ 粗分镜直接生成视频（G2 会拒）→ 重生成分镜不花钱，视频按秒计费
- ❌ 景别写"镜头/画面"、大特写写成"大豆" → 按 canvas-craft 术语勘误统一
- ❌ 整集剧本直连分镜表 / 逐镜建图片视频节点（G4 会拒）→ 场景拆分 + 参考图资产
- ❌ 跨集不开工不读记忆、收尾不回写 → 下一集重复创作、丢伏笔

## 附：3D 导演台（预演）

`canvas_director_stage`：`action=help` 列姿态/道具/片段；`action=apply` + JSON 规格写入并落盘；
`action=get` 读回。规格：`title/duration/env/characters[]/props[]/cameras[]/shots[]`（详见工具描述）。
