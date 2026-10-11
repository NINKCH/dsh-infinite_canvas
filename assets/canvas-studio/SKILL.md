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
5. **用户要剧本就要给完整正文。** 把**完整剧本内容**（分场、场景描述、人物动作、对白）写入 `target: "output"`；
   创作意图/提示词写入 `target: "idea"`。**禁止只写提纲、计划、或"待生成"占位**。
6. **删除是破坏性操作。** 先 `canvas_list_projects` 确认 id，且仅在用户明确要求时执行
   （`canvas_delete_node` / `canvas_delete_project`）。
7. **完成后让用户看到结果**：调用 `canvas_open({ projectId })`，画布会在数秒内自动跳转。
8. **汇报固定要素**：项目名 + 项目 id + 节点名/id + 成稿摘要（若已生成）；有错误如实说明。

## 二、标准工作流

1. `canvas_list_projects` —— 查重 + 拿到 projectId 与节点 id
2. 需要新项目才 `canvas_create_project({ name, scriptText, nodeName })`；否则复用已有 projectId
3. 产出内容 → `canvas_write_node({ projectId, text, target, name })`
   - `target: 'idea'`：提示词、创作意图、约束
   - `target: 'output'`：**成稿**（剧本正文、分镜结果）
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

## 四、必须避免的错误

- ❌ 一次请求里创建多个项目（含"重试式重建"）→ 先查重、复用
- ❌ 每个节点都新建项目 → 用 `canvas_write_node` 往同一 projectId 追加
- ❌ 只写提示词、不写剧本正文 → 成稿必须进 `output`
- ❌ 节点不留名字 → 一律用 `name` 命名
- ❌ 未经确认就删除项目/节点 → 先列表确认、再按用户明确要求删除
