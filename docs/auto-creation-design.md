# 自动创作（0.20.0 已实现版）

> 状态：**已实现并随 0.20.0 交付**（进程内执行器）。本文描述**当前真实实现**；
> 「真会话多智能体」（sessionController 派生七角色）保留在文末作为后续升级路径，
> 需要宿主确认 `productionCapabilities.multiAgent === true` 后再启用。

## 0. 设计铁律（不变）

1. **流程规范 ≠ 内容模板**：规则只管操作顺序与花钱/毁数据前的检查，绝不规定剧情。
2. **用户显式指令 > 一切流程**：所有闸门都有 override（用户原话）+ 审计。
3. **自动模式绝不提问**：brief 不足由编剧室自拟 3 个方向并选定，理由写进会议记录。
4. **诚实交付**：草稿就是 blocked；"完成"必须由 `canvas_production_status.ready:true` 支撑。
5. **窄启动**：免费段（到分镜+预算单）零付费；一次性批准令牌后才进入付费生成。

## 1. 当前实现（进程内执行器）

**入口**（三处，同一引擎）：
- 设置卡「自动创作（实验）」：开关 + 一句话创意 + 启动/中止 + 预算单/批准/生成；
- 对话工具：`canvas_auto_status` / `canvas_auto_start` / `canvas_auto_budget` / `canvas_auto_generate` / `canvas_auto_abort`；
- 人格分支：`canvas_auto_status.enabled=true` 时禁止提问，必须同一轮 `canvas_auto_start`。

**免费段**（`autoRoom`，五轮角色提示词 + 落盘 + 生成编排）：
```
调研(离线,标注) → 编剧A/B 独立提案(互不可见) → 互评(各≤3条)
→ 监制决策(择一/融合+理由) → 落盘：会议节点+设定集+剧本idea
→ canvas_open 自动开画布 → 剧本节点生成(轮询)
→ 按【场N】拆分 → 场景文本+分镜表(tail→prev 串联) → 分镜生成(轮询)
→ G2 校验(不过自动重生成一次) → 预算单 → 停，等批准
```
- 角色分工 = 独立系统提示词的轮次（同一进程，顺序执行）；讨论记录 = 「编剧室会议」文本节点。
- **上下文继承**：设定集按名称合并不覆盖；已有节点不重建。

**付费段**（`autoPaid`，批准后）：
```
逐分镜表：建 video 节点(G2/G3 把关) → canvas_open → 触发 → 轮询(失败重试2次)
→ 全部完成 → 建「成片」节点
```
- 一次性批准令牌绑定预算指纹（镜头/时长一变即失效）；`autoAbort` 可中止付费段（保留已完成视频）。
- 画布页面必须打开（节点生成由客户端执行）；关闭时 runner 如实报"等待画布"。

## 2. 关键组件

| 组件 | 位置 | 职责 |
|---|---|---|
| 阶段机 + 六闸门 | `production.js` | `brief→…→delivered`、G1–G6、override 审计、`status/quote/approve` |
| 编剧室/付费段 | `index.js`（`autoRoom`/`autoPaid`/`AUTO_RUNS`） | 轮次编排、讨论落盘、生成编排 |
| RPC | `autoModeGet/Set`、`autoStart/Status/Abort`、`autoQuote/Approve/Generate` | 设置卡与工具共用 |
| 工具 | `canvas_auto_*` 五个 | 对话智能体的入口 |
| 客户端 | `AutoModeCard`（设置卡）+ `ProjectsTab` 阶段行 | 开关/创意/预算/批准/进度 |

## 3. 测试

`scripts/test-production.mjs`：注入假 LLM + 假画布执行桩，端到端覆盖——
免费段全流程（2 场 → 2 分镜 → 预算单）、未批准拒绝付费、批准后 2 视频 + 成片节点、
六闸门正反例、override 审计、阶段推进/回退、预算指纹失效。

## 4. 后续升级路径（未实现，需探针确认）

- **真会话执行器**：`productionCapabilities.multiAgent === true` 时，把"角色轮次"换成
  `sessionController` 派生的独立会话（角色章程 = 首条 prompt，预设用 `standard`），
  可并行、互不可见性更强；轮次协议与落盘格式不变，`autoRoom` 的步骤函数换成会话调用。
- **联网调研**：会话执行器下给调研角色挂 `tool-web`；进程内版本暂为离线知识（已如实标注）。
- **多集连续生产**：按集派生 run，复用同一批准预算上限。

## 5. 回退

- 开关关闭 → 全部 `auto*` 拒绝，UI 无入口，行为与 0.19.21 一致；
- 任一步失败 → run 标记 `failed` 并保留已产出内容；重试不重建已存在节点（闸门拦截）。
