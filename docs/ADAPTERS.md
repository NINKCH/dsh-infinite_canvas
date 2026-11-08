# 多宿主适配器（adapters/）— 六宿主矩阵与接入指南

> 本文是 `adapters/` 多宿主适配层的文档入口。全部事实来自 multi-host-adapters 分支的实现与
> 逆向调研，技术契约底本为 [`adapters/shared/HOST-CONTRACT.md`](../adapters/shared/HOST-CONTRACT.md)。
> 宿主 API 面为**静态探明**结论，全部**待实测（Task 11）**回填（见 §4 探针记录区）；未知项一律
> 标「待实测」，不编造。

## 1. 六宿主矩阵

| 宿主 | 交付形态 | 工具通道 | 文本模型通道 | 画布 UI |
| --- | --- | --- | --- | --- |
| VS Code | `dsh-infinite-canvas-0.3.0.vsix` | lm-tools（30 工具直挂）或 mcp-provider | vscode-lm（四能力全有 + sampling） | WebviewPanel iframe（CSP `frame-src localhost`） |
| CodeBuddy | 同上 vsix | lm-tools / mcp-provider（有） | bridge（sampling 无） | 同 VS Code |
| Trae | 同上 vsix | lm-tools / mcp-provider（同 CodeBuddy） | bridge（实测可达：workbuddy 网关，见 §4）；registerLanguageModelChat 有（静态探明），豆包未暴露给 vscode.lm（实测 selectChatModels 无模型） | 同 VS Code |
| Cursor | 同上 vsix | 仅 cursor-mcp | bridge（not-planned，见 §5） | 同 VS Code |
| Qoder | `dsh-infinite-canvas-qoder-0.3.0.zip` | MCP（`.mcp.json`） | bridge（恒空，最终结论见 §5）> sampling（待实测） | 浏览器打开（完整画布 UI，0.3.0 浏览器化） |
| WorkBuddy | `workbuddy-marketplace/`（本地目录市场，含 `dsh-marketplace-workbuddy-0.3.0.zip`） | MCP（`.mcp.json`，stdio command 走 PATH node，样本实证） | bridge（**已验证**：`~/.workbuddy/models.json` 官方网关直调，UA 包装宿主客户端）> sampling | 浏览器打开（完整画布 UI，0.3.0 浏览器化） |

> vsix 能力探测链（四路择一）：`lm-tools` → `mcp-provider` → `cursor-mcp` → `manual`（手配
> mcp.json 兜底，片段见 §3）。探测在扩展激活时进行，命中即注册对应工具通道。

## 2. 文本 LLM 四级通道

文本生成通道按优先级编排（`llm-channel.cjs`，`resolveTextLLM`）：

1. **vscode-lm** —— 仅 vsix 壳注入：`selectChatModels` → `sendRequest`。
2. **bridge** —— 宿主官方网关直调（`model-bridge.cjs`）：读宿主本机配置的官方网关模型清单
   （WorkBuddy 已验证；Qoder 恒空=最终结论，见 §5 第 3 条；Cursor not-planned）。全链路脱敏：错误消息
   **先脱敏后截断**，apiKey 不进日志/错误/工具返回。
3. **sampling** —— MCP 客户端能力（`sampling/createMessage`）。三壳均未实测，待实测
   （Task 11）确认。
4. **byok** —— **MCP 承载恒不可用**：core 无 BYOK url/apiKey 存储，`llmOptions` 是 Harness
   llm 服务视图（`ctx.get('llm')`），MCP 承载的假 ctx 内该服务不可达，byok 恒 false。
   「画布设置页 BYOK」仅存在于 DSH Harness 语境，与 adapters 无关。
5. **none** —— 兜底：拒绝并给指引（配置渠道后重试），不抛裸错。

会话内可用 `canvas_llm_probe` 工具探测当前通道状态（`probeChannels`：只含计数与布尔，
绝不携带密钥）。通道优先级是逐级回落：高优先级通道可用即用，不可用才看下一级。

## 3. 各宿主安装指南

**环境要求（通用）**：MCP 宿主需 PATH 中有 node，或 `${QODER_NODE_RUNTIME}`（Qoder 内置
runtime）。画布数据根：`~/.dsh-infinite-canvas/`（env `DSH_IC_HOME` 可覆盖），升级/重装不清
用户数据。画布 HTTP 缺省端口 **3210**：已有画布服务则复用不双开；被其他服务占用（EADDRINUSE）
则 +1 递增换口（上限 +10）。

构建（三壳统一入口）：`node adapters/scripts/build-adapters.mjs` → 产物在 `adapters/dist/`。

### vsix（VS Code / CodeBuddy / Trae / Cursor 通用）

1. 构建或取件：`adapters/dist/dsh-infinite-canvas-0.3.0.vsix`。
2. 安装：扩展面板 `…` 菜单 → **从 VSIX 安装…**（四家同源 VS Code 系，入口名称或有差异）。
3. 重载窗口后扩展激活，能力探测链自动选择工具通道；画布面板在 WebviewPanel iframe 中打开
   （CSP `frame-src` 指向 localhost:3210）。
4. 入口（0.2.0 起）：标题栏右上 `$(browser)` 按钮（`window/title`；Trae 自定义标题栏是否渲染
   待实机验证）/ 状态栏右下常驻 `$(browser) 画布`（任何窗口可见）/ 命令面板三条 `无限画布:` 命令。

**manual mcp.json 兜底片段**（探测链落到 manual、或用户手动配 MCP 时；与 extension.js 的
`MCP_ARGS` / `MCP_ENV` 常量逐字对齐——`--core-dir` 必传，缺省路径解析在 vsix 内不成立）：

```json
{
  "mcpServers": {
    "dsh-infinite-canvas": {
      "command": "<宿主内置 node（vsix 系 Electron + ELECTRON_RUN_AS_NODE=1）或 PATH node>",
      "args": ["<扩展目录>/shared/canvas-mcp.cjs", "--core-dir", "<扩展目录>/shared/core"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### Qoder

产物：`adapters/dist/dsh-infinite-canvas-qoder-0.3.0.zip`（ZIP 根直接含
`.qoder-plugin/plugin.json`、`.mcp.json`、`skills/`、`dist/`）。两种安装法，细节以
[`adapters/qoder-plugin/README.md`](../adapters/qoder-plugin/README.md) 为准：

- **方式 A（推荐）**：在 Qoder 中让 agent 调官方 `install_extension` 工具，
  `{"source": "local", "kind": "plugin", "filePath": "<ZIP 绝对路径>"}`，装完重启 Qoder。
- **方式 B（手动 cache 注册，`install_extension` 不可用时）**：先备份
  `~/.qoder-cn/plugins/installed_plugins_v2.json` 与 `~/.qoder-cn/settings.json`，解压 ZIP 到
  `~/.qoder-cn/plugins/cache/local/dsh-infinite-canvas/0.3.0/`，再 read-merge 注册
  `dsh-infinite-canvas@local` 并在 `enabledPlugins` 置 true，重启 Qoder。**绝不整文件覆盖。**

### WorkBuddy

产物：`adapters/dist/workbuddy-marketplace/`（staging 目录，可直接作市场源）+
`dsh-marketplace-workbuddy-0.3.0.zip`。装插件 = **加一个本地目录市场**，细节以
[`adapters/workbuddy-plugin/marketplace/plugins/dsh-infinite-canvas/README.md`](../adapters/workbuddy-plugin/marketplace/plugins/dsh-infinite-canvas/README.md) 为准：

1. 构建 staging：`node adapters/scripts/build-workbuddy.mjs`。
2. 在 WorkBuddy 市场设置中把 staging 目录加为本地市场源（`known_marketplaces.json` 的
   `directory` 条目，`path` 指向目录根——其下直接是 `.codebuddy-plugin/marketplace.json`）。
3. 市场中安装 `dsh-infinite-canvas`，重启 WorkBuddy。zip URL 源同样受支持（ZIP 根含市场清单）。
   手改 `known_marketplaces.json` 务必先备份、只 read-merge。

> 两包当前都**未执行注册动作**（配置写入竞态，用户配合重启时执行）——见各自 README。

## 4. 探针结果记录区（Task 11 回填）

> 静态探明的宿主 API 面（VS Code=四能力全有+sampling；CodeBuddy=lmTools/mcpProvider 有、
> sampling 无；Trae=同 CodeBuddy 且 registerLanguageModelChat 有；Cursor=仅 cursorMcp）
> **全部待实机验证**。实机探针跑完后回填本表，一行一宿主。

| 宿主 | 探测路径命中 | selectChatModels 清单 | sampling | 实测日期 |
| --- | --- | --- | --- | --- |
| VS Code | 待实测（Task 11） | 待实测 | 待实测 | 待实测 |
| CodeBuddy | 待实测（Task 11） | 待实测 | 待实测 | 待实测 |
| Trae | **lm-tools**（Trae CN 3.4.15，host vscode 1.107.1；能力 lmTools/mcpProvider/sampling=true, cursorMcp=false） | vscode.lm：无模型（豆包未开放给扩展 API） | sampling=n/a（进程内语义）；通道探测 bridge=workbuddy:52，文本通道=bridge | 2026-11-08 |
| Cursor | 待实测（Task 11） | 待实测 | 待实测 | 待实测 |
| Qoder | 待实测（Task 11） | 待实测 | 待实测 | 待实测 |
| WorkBuddy | 待实测（Task 11） | 待实测 | 待实测 | 待实测 |

## 5. 已知限制（如实）

1. **画布 UI 已浏览器化（0.3.0，Task 14）**：`/` 面板从状态页升级为**完整画布 UI**——三 script
   装载壳：vendor React UMD（`adapters/shared/vendor/react.production.min.js`，react@18.3.1 官方
   UMD 构建、MIT、保留上游 license banner；**vendor 静态资产非 npm 依赖**，零运行时依赖红线不破）
   → 内联 `__ModuleLoader__` shim（`require('react')` 返回 `window.React`）→ `client.js`
   （§4 RUNTIME_FILES 回归，装载契约实证：自包含、唯一外部 require 是 react、hostRpc 自 POST
   `/api/rpc`、CTX 全守卫无 harness 回退全屏面板）。原状态页挪 `/status`（诊断）。静态契约
   （三 script 齐活 + 两条资产路由字节一致）已被测试钉死；**浏览器内 React 渲染待用户实机
   验证**——若实测报 JS 错（1.4MB 前端无法穷举的 harness 依赖残留），下一轮修。
2. **byok 在 MCP 宿主不可用**：core 无 BYOK url/apiKey 存储，MCP 承载下 byok 恒 false
   （见 §2 第 4 级）。
3. **qoder 模型桥接恒空（最终结论，非待验证）**：`~/.qoder-cn/.models` 本地模型目录为加密
   blob（catalog-v7，非 JSON），不可解析——桥接恒空为实证终局，与 cursor 同列 not-planned
   （逆向加密/云鉴权涉 ToS 敏感，不做）。Qoder 文本通道实际=sampling（待实测）或 none。
4. **cursor 桥接 not-planned**：后端 API 未公开 + ToS 敏感，不做。
5. **三壳 sampling 未实测**：MCP `sampling/createMessage` 在 qoder / workbuddy（及 vsix manual
   路径）宿主的实际可用性待 Task 11 实测确认。
6. **Trae 入口形态（实测 2026-11-08）**：Trae SOLO 首页为自研任务台，扩展入口在 IDE 模式
   （打开项目后）；0.2.0 起状态栏/标题栏入口在空白窗口亦可用（untrustedWorkspaces 已声明支持）。

## 6. RPC 面与工具面：两张表，勿混淆

| 面 | 名字形态 | 数量 | 承载 | 消费方 |
| --- | --- | --- | --- | --- |
| **RPC 面** | camelCase（`ping` / `projectsList` / `llmOptions` / `canvasCreateProject` …） | **67** 个方法 | POST `/infinite-canvas/api/rpc`，原始 JSON `{method, args}`（非 JSON-RPC 2.0 信封） | 浏览器前端（client.js，经 canvas-web 页面装载） |
| **工具面** | snake_case（`canvas_list_projects` / `canvas_create_node` …） | **30** 个 `canvas_*` + `canvas_llm_probe` | MCP `tools/list` / `tools/call`（stdio） | LLM（宿主 agent 会话） |

**混淆会 400**：把 `canvas_list_projects` 这类工具名 POST 到 `/api/rpc` 会得到 400「未知操作」
——工具注册表与 RPC 方法表是 core 内部两张独立的表，名字互不通用。给前端写页面走 RPC 面，
给模型接工具走 MCP 工具面。
