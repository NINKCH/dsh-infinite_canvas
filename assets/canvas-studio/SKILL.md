---
name: canvas-studio
description: 用无限画布（Infinite Canvas）做短剧/视频创作时使用：创建或复用项目、写剧本与分镜、触发生成、查看结果、命名与清理。用户提到画布、无限画布、短剧项目、剧本节点、分镜、生成视频，或要求"建个画布项目/把内容写进画布"时，先加载本技能再动手。Load this skill before operating the infinite canvas.
---

# 无限画布操作规程（硬约束）

画布是一个按项目组织的节点工作台：剧本 → 分镜 → 图片 → 视频 → 成片。你（对话模型）是操作者，
**所有画布操作只能通过 canvas_* 工具完成**，不要臆造节点或项目状态。

## 一、硬约束（违反即视为操作失败）

1. **同一个请求最多创建一个项目。** 调用 `canvas_create_project` 之前**必须先** `canvas_list_projects` 查重：
   已存在同名或同主题项目 → **直接复用它的 projectId**，绝不重复创建。重复建项目会留下空壳项目，用户非常反感。
2. **绝不为单个节点新建项目。** 往已有项目加内容一律用 `canvas_write_node(projectId=…)`；
   只有用户**明确要求"另开一个项目"**时才调用 `canvas_create_project`。
3. **失败重试不要重建资源。** 工具报错时先 `canvas_list_projects` 看是否已经创建成功（可能只是返回值校验问题），
   已存在就复用，绝不靠"再建一个"来重试。
4. **每个节点都要有可识别的名字。** 新建节点时传 `name`（如「创作意图」「第一节剧本」「分镜表」「第2集剧本」）；
   同名节点必须加区分后缀。
5. **一个剧本节点必须同时有 `idea` 与 `output`——绝不把一个剧本拆成两个节点。**
   - `idea`＝创作意图/提示词；`output`＝**完整剧本正文**（分场、场景描述、人物动作、对白）
   - 正确：一次调用写全 → `canvas_write_node({ projectId, text: 剧本正文, target: 'output', idea: 创作意图, name: '第一节剧本' })`
   - 或建项目时写全 → `canvas_create_project({ name, scriptText: 创作意图, scriptOutput: 剧本正文, nodeName: '第一节剧本' })`
   - **禁止**：一个只有 `idea` 的剧本节点 + 另一个只有 `output` 的剧本节点；**禁止**只写提纲、计划或"待生成"占位
   - 若要单独记录整体设定/基调，请用 **text 节点**，不要用第二个 script 节点
6. **删除是破坏性操作。** 先 `canvas_list_projects` 确认 id，且仅在用户明确要求时执行
   （`canvas_delete_node` / `canvas_delete_project`）。
7. **完成后让用户看到结果**：调用 `canvas_open({ projectId })`，画布会在数秒内自动跳转。
8. **汇报固定要素**：项目名 + 项目 id + 节点名/id + 成稿摘要（若已生成）；有错误如实说明。

## 二、标准工作流

1. `canvas_list_projects` —— 查重 + 拿到 projectId 与节点 id
2. 需要新项目才 `canvas_create_project({ name, scriptText, scriptOutput, nodeName })`；否则复用已有 projectId
3. 产出内容 → `canvas_write_node({ projectId, text, target, name, idea })`
   - `target: 'idea'`：提示词、创作意图、约束
   - `target: 'output'`：**成稿**（剧本正文、分镜结果）；不传 nodeId 时会自动落到项目里已有的剧本节点，不另建节点
   - 同一次调用可用 `idea` 参数把创作意图与成稿一起写进同一个剧本节点
4. 需要画布用**自身配置的模型/接口**真实生成（剧本/分镜/图片/视频）：
   `canvas_run_node({ projectId, nodeId })` → 之后用 `canvas_node_status({ projectId, nodeId })` 轮询状态与成稿
5. `canvas_open({ projectId })` —— 让用户看到画布结果

## 三、节点类型与字段

| 类型 | 用途 | 主要字段 |
| --- | --- | --- |
| `script` | 剧本 | `idea`＝创作意图/提示词，`output`＝剧本成稿 |
| `storyboard` | 分镜表 | 由剧本拆镜头（画布内生成） |
| `image-gen` | 图片生成 | `prompt`＝画面提示词 |
| `video-gen` | 视频生成 | `prompt`＝运动/画面提示词 |
| `text` | 自由文本 | `text` |

## 四、生成能力（必须真的产出内容）

1. **文本类（剧本 / 分镜）**：可由你直接生成完整正文，用
   `canvas_write_node({ projectId, nodeId, text: 完整正文, target: 'output' })` 写入；
   也可让画布用它自己配置的模型生成：`canvas_run_node({ projectId, nodeId })`。
2. **图片 / 视频**：只能由画布生成（使用用户在画布设置里配置的图片/视频接口）：
   `canvas_run_node({ projectId, nodeId })` 触发 → `canvas_node_status` 轮询直到 `status` 变为
   `done`（成功）或 `error`（失败，读 `error` 字段并向用户说明）。
3. **模型为空/报错时**：`canvas_node_status` 会给出错误文本（例如"模型未返回文本"）——
   如实转达，并建议用户在画布设置里更换文本模型；**不要谎报已生成**。
4. **生成需要时间**：图片/视频可能几十秒到数分钟。触发后用 `canvas_node_status` 间隔轮询
   （建议 ≥10 秒一次），不要反复触发同一个节点。

## 五、生成参数来源（不要臆造参数）

- **文本模型**：走 Harness 里已配置的 provider/model 与其默认参数。画布设置里可填「输出上限」「温度」，
  **留空即不下发该字段**（用 Harness/模型的默认值）。
- **图片 / 视频 / 配音**：走用户在画布设置里配置的 API 与其参数；仅当用户填写了覆盖项
  （如图片 `size`、`response_format`、Seedance 的音频/水印）才发送，否则用 API 默认。
- **不要**向用户断言某个模型的上下文/输出上限数值——以 Harness 配置与厂商文档为准
  （例：GLM-5.3 / GLM-5.3-Flash 为 1M 上下文、最大输出 128K）。
- 生成失败时，插件会回传真实原因（含 chunk 类型统计）；如实转达，不要猜测。

## 六、ArtCraft 后期全流程（PhotoCraft / FilmCraft / EffectCraft）

前置：用户需安装 `dsh-artcraft` 插件并配置三个 CLI 路径（画布设置 → Craft 后期 卡片会显示
就绪/缺失状态与数据目录）。资产会同步到 Craft 工作区按项目分目录存放。

流程顺序（每一步的输出是下一步的输入）：

1. **素材就绪**：剧本 → 分镜 → 图片/视频生成完成（节点 `status=done`，有 `assetId`）。
2. **资产落盘**：把节点产物同步到 Craft 工作区（画布 UI 的"同步"按钮；对话侧通过
   `canvas_node_status` 确认产物已生成）。
3. **PhotoCraft（调色/修图）**：对单张或批量图片做无头调色，产物为调色后的图片资产。
4. **EffectCraft（片头/特效）**：生成片头动画（Lottie/序列），作为成片开场。
5. **FilmCraft（成片渲染）**：把分镜视频片段 + 配音 + 字幕合成成片。
   画布上的「成片（finalcut）」节点会把片段合成 MP4，并可导出 **FCP7 XML + SRT** 交给
   FilmCraft 渲染正式成片。
6. **交付**：成片资产可在「资产」页下载；数据根目录下 `projects/<项目>/…` 有对应文件。

**当前边界（务必如实告知用户）**：PhotoCraft / FilmCraft / EffectCraft 的**执行按钮在画布 UI 上**
（节点内的 Craft 按钮、成片节点的导出按钮），对话工具目前不能代替点击这些按钮。
你能做的是：准备节点与提示词、写入成稿、触发生成、检查状态、并在完成后引导用户到画布执行后期步骤。
如果用户希望"对话直接驱动后期"，请明确提出——这需要为 ArtCraft 增加对应工具。

**排查建议**：Craft 卡片显示"未找到可执行文件"时，先让用户在画布设置里配置 CLI 路径，
再重试；`effectcraft` 若未配置只影响片头，不阻塞成片。

## 四、必须避免的错误

- ❌ 一次请求里创建多个项目（含"重试式重建"）→ 先查重、复用
- ❌ 每个节点都新建项目 → 用 `canvas_write_node` 往同一 projectId 追加
- ❌ 只写提示词、不写剧本正文 → 成稿必须进 `output`
- ❌ 节点不留名字 → 一律用 `name` 命名
- ❌ 未经确认就删除项目/节点 → 先列表确认、再按用户明确要求删除
