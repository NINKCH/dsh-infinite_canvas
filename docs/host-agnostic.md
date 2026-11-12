# 宿主无关化（Host-agnostic）

> 本文说明 0.21.0 的边界：**核心（core）不绑定 DeepSeek Harness**；独立画布服务 / MCP / CLI 由
> `multi-host-adapters` 分支承载，主 npm 包不重复打包一套 server。

## 1. Core 契约（本仓 `index.js`）

`apply(ctx)` 只强制依赖三个成员：

| 成员 | 用途 | 缺失时 |
| --- | --- | --- |
| `ctx.effect(fn)` | 同步执行注册并收集清理函数 | 必需 |
| `ctx.tools.register(def)` | 注册 `canvas_*` 工具（当前 34 个） | 有守卫，缺失则跳过工具面 |
| `ctx.webServer.register(route)` | 注册 9 条 `/infinite-canvas/api/*` 路由 | 必需 |

可选增强服务（缺失只降级，不抛错）：

- `ctx.get('llm')`：文本模型；缺失时相关 RPC 返回「llm 服务不可用」。
- `ctx.get('skills')`：技能包；缺失时跳过技能注册。
- `ctx.get('attachments')` / `ctx.attachments`：视觉拉片的图片附件；缺失时拉片明确报错。
- `ctx.get('workspaceRegistry')`：工作区项目；缺失时 watcher 跳过。
- `ctx.get('sessionController')` / `ctx.get('agents')`：自动创作多 Agent 探针；缺失时 `multiAgent:false`。

自检：

```bash
node scripts/test-host-contract.mjs
# ✓ 宿主契约通过（最小 ctx 同步注册 34 工具 / 9 路由；增强服务缺失可降级）
```

## 2. 独立画布服务 / MCP / CLI

实现位于 **`multi-host-adapters` 分支（0.3.3）**，运行时零 npm 依赖：

| 文件 | 作用 |
| --- | --- |
| `adapters/shared/host-adapter.cjs` | 伪造最小 ctx，加载 core，收集 tools / routes |
| `adapters/shared/canvas-web.cjs` | 本地 HTTP 画布服务（React UMD 壳 + `/api/rpc`） |
| `adapters/shared/canvas-mcp.cjs` | MCP stdio server（initialize / tools/list / tools/call） |
| `adapters/shared/HOST-CONTRACT.md` | 逐条依赖面与实测契约 |

开发态启动（core 指向本仓）：

```bash
node adapters/shared/canvas-web.cjs --core-dir <path-to-dsh-infinite_canvas> --port 3210 --open
node adapters/shared/canvas-mcp.cjs --core-dir <path-to-dsh-infinite_canvas> --port 3210
```

已验证：该 adapter 对 **0.21.0 dev 核心**可同步收集 **34 个工具 / 9 条路由**；画布 UI 由
`canvas-web.cjs` 自带，core 不注册 HTML 面板路由。

## 3. 分发边界

- **主 npm 包**（`@ninkch/dsh-infinite-canvas`）：Harness 插件本体，轻量、无 server/vendor。
- **adapter 发行物**（VSIX / Qoder / WorkBuddy zip）：随 `multi-host-adapters` 分支单独构建，
  内置 core 副本与 React vendor。
- 两条线共享同一套数据根与本地成果物；Agent 只负责传话/取件，画布资产仍在用户本地。

## 4. 为什么不把 server 搬进主包

1. 主包已由 Harness 提供面板与 webServer；再带一套 HTTP server 会造成双实例/端口冲突。
2. adapter 需要自带 React UMD 与宿主探针，体量属于独立发行物。
3. 分支已通过独立回归（`test-adapters-*`）；主包只维护 core 契约，避免两套实现漂移。
