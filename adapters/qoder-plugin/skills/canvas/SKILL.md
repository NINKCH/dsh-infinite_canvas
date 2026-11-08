---
name: canvas
description: 无限画布（可视化创作工作台）操作指南。当用户要求创建/编辑画布项目、编排剧本分镜节点、生成图片/视频、维护世界观设定集或排查画布生成问题时使用。涵盖先查项目、设定集先行、迭代更新、生成与状态查询的完整工作流。
---

# 无限画布操作指南（dsh-infinite-canvas）

画布是节点式可视化创作工作台：项目 → 节点（文本/图片/视频）→ 连线编排成片。所有操作经本插件的 MCP 工具完成。

## 操作铁律

1. **先看再动**：任何操作前先调 `canvas_list_projects` 获取项目清单与真实 id，不要凭记忆猜 id。
2. **设定集先行**：开始创作前用 `canvas_update_bible` 写入世界观/角色/风格设定，后续节点生成才有统一口径；设定变更随改随更。
3. **迭代用更新**：修改节点一律 `canvas_update_node`，**不要**删除重建——重建会丢产物、丢连线、丢制作状态。
4. **生成前提**：`canvas_run_node` / `canvas_generate_node` 执行生成时，画布页面必须已在浏览器打开（见下节）；生成是异步的，提交后用 `canvas_node_status` 查询节点产物状态，不要假设成功。
5. **文本通道排查**：文本生成报错或无响应时，先 `canvas_llm_probe` 探测可用 LLM 通道，按探测结果提示用户配置，不要盲目重试。

## 典型工作流

- **新项目创作**：`canvas_create_project` → `canvas_update_bible`（设定集）→ `canvas_write_node` / `canvas_create_node`（剧本/分镜节点）→ `canvas_connect`（连线编排）→ `canvas_run_node` / `canvas_generate_node`（生成）→ `canvas_node_status`（查产物）。
- **已有项目迭代**：`canvas_list_projects` → `canvas_update_node`（改内容）→ 重新生成 → 状态确认。

## 打开画布（浏览器）

Qoder 无内嵌画布面板，画布 UI 在本机浏览器使用。让用户运行（或经同意后代跑）：

```bash
node "<QODER_PLUGIN_ROOT>/dist/canvas-web.cjs" --open
```

`--open` = 起服务后自动打开默认浏览器；默认端口 3210，被占用自动顺延。画布生成与预览都要求该服务可达。

## 工具参数

本插件注册 31 个工具（30 个 `canvas_*` + `canvas_llm_probe`）。**各工具的参数 schema 以 `tools/list` 实时返回为准**——不要背、不要猜参数名，调用前现查。
