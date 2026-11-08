# HOST-CONTRACT — core（index.js）对宿主 ctx 的依赖面

> Task 1 探明产物，供 adapters/ 全部后续任务引用。基准：`index.js`（0.20.1，5926 行）。
> 后续任务**不得**重新探测 ctx 面；若 core 变更导致本文失真，先改本文再动代码。
>
> **勘误（2026-11，controller 确认）**：计划原文写「23 个工具」，实测 30 个（0.20.0 新增
> production_status/advance + auto_status/start/budget/generate/abort 共 7 个）；计划原文把工具
> 方法名写作 `handler(args, exec)`，实测注册表用 `execute(args, exec)`。本文与测试均按实测修正。

## 1. 插件入口与结构

- ESM 导出（无默认导出）：
  - `export const inject = ['webServer', 'tools']`（L3581）——硬依赖仅这两个服务。
  - `export function apply(ctx)`（L3602）。
  - `export const _internals`（L3584）——仅供诊断/自动化测试，宿主接入**不**消费。
- **apply(ctx) 函数体 = 单个 `ctx.effect(callback, 'infinite-canvas: api routes')`**（L3603–5924）。
  callback **同步**执行完所有工具与路由注册并返回总清理函数，没有 await 或事件延迟；
  `await createHostAdapter(...)`（内部 `await import(corePath)`）返回后即可安全断言收集完成。
  （后续若 core 改成异步注册，宿主须等待工具数稳定后再断言——目前不需要。）
- 常量：`NAME = 'infinite-canvas'`（L29，所有路由前缀 `/infinite-canvas/api/...`）；
  `VERSION` 在 **import 时同步读 package.json**（L38）→ 打包时 package.json 必须随 core 走。

## 2. ctx 依赖清单（apply 的全量消费面，`grep "ctx\." 汇总`）

| 成员 | 用点 | 语义 | 缺失时行为 |
| --- | --- | --- | --- |
| `ctx.effect(fn, label?)` | L3603、L4557 | cordis effect 作用域：**立即同步执行 fn**；fn 返回函数则作为清理回调收集，label 仅诊断用 | 无守卫，**必需** |
| `ctx.get('llm')` | L3604（闭包内懒取） | 模型桥接数据面：`listProviders()` / `listModels(id)` / `listConfigurableProviders()` | 可选；返回 undefined → 相关 RPC 返回「llm 服务不可用」 |
| `ctx.get('skills')` | L2042、L4258、L4270 | 技能服务：`registerProvider(fn)` / `list({limit})` / `get(name)` | 可选；缺失 → 跳过技能注册、canvas_list_skills 返回错误文本 |
| `ctx.get('workspaceRegistry')` | L3751、L4560 | 工作区项目：`list()`；core 以 5s setInterval 轮询 | 可选；缺失 → watcher tick 直接跳过 |
| `ctx.get('sessionController')` / `ctx.get('agents')` | L4294–4295 | 生产能力探针（multiAgent 布尔） | 可选；缺失 → multiAgent:false，自动创作入口隐藏 |
| `ctx.tools.register(def)` | L4571（守卫）、L4627 | 注册工具，返回 disposer | 有守卫：服务不存在 → 整个工具注册块跳过 |
| `ctx.webServer.register(route)` | L5560–5894（×9） | 注册 HTTP 路由，返回 disposer | 无守卫，**必需** |

- **不存在的成员**：ctx.console / ctx.logger / 任何 ctx 存储 API——**均不存在**。core 的持久化全部
  走 env（DSH_IC_*，见 §4）+ `node:fs` 自管。「存储类 stub」的正确承载方式：在 `import` core
  **之前**设置 `DSH_IC_PROJECTS_DIR` / `DSH_IC_CONFIG_PATH`（两者是模块顶层常量，import 后不可变）。
- inject 语义（L4554 注释）：cordis 的 inject = 服务不存在则插件挂起等待；core 对可选服务一律
  防御式 `get` + 降级。因此假适配器 `get(name)` 返回 `undefined` **永远安全**，不会让 apply 抛错。

### 2.1 Def 形状（`ctx.tools.register(def)` 入参，逐字复用 index.js 注册表）

```js
{
  name: 'canvas_xxx',                  // 30 个，见 §3
  description: string,
  parameters: { /* 标准 JSON Schema */ },
  output?: { schema: object, render(args, value) },   // 部分工具有
  timeoutMs?: number,                  // 部分工具有（如 30000）
  execute: async (args, exec) => result,   // ← 计划原文误写 handler，实测名 execute
}
```

- core 注册时会给 `execute` 再包一层（会话绑定注入 + stripUndefined 无损 JSON 清洗，L4587–4629），
  adapter 收集到的是**包装后的最终版**；宿主直接 `await def.execute(args, exec)` 即可。
- `exec`：core 从中嗅探会话身份做画布绑定；假宿主不传（undefined）→ 静默回退旧行为，安全。

### 2.2 Route 形状（`ctx.webServer.register(route)` 入参）与实测路由清单

```js
{ kind: 'exact', path: '/infinite-canvas/api/...', handler: async (req, res) => {} }
```

9 条，全部 `kind: 'exact'`，注册顺序：

| # | path | 已核实的行为 |
| --- | --- | --- |
| 1 | `/infinite-canvas/api/rpc` | POST JSON：`{method, args}` → methods 表分派；非 POST 405；未知方法/异常 400；请求体上限 8MB |
| 2 | `/infinite-canvas/api/llm-stream` | POST，流式生成，请求体上限 4MB |
| 3 | `/infinite-canvas/api/asset` | （未逐一核对） |
| 4 | `/infinite-canvas/api/fetch-proxy` | （未逐一核对） |
| 5 | `/infinite-canvas/api/file` | （未逐一核对） |
| 6 | `/infinite-canvas/api/poster` | （未逐一核对） |
| 7 | `/infinite-canvas/api/thumb` | （未逐一核对） |
| 8 | `/infinite-canvas/api/object` | （未逐一核对） |
| 9 | `/infinite-canvas/api/plugin-asset` | GET 静态资源；白名单 `assets/` 目录、拒绝路径穿越 |

## 3. CANVAS_METHODS（30 个工具名，index.js 注册顺序，实测）

```js
const CANVAS_METHODS = [
  'canvas_list_projects',
  'canvas_create_project',
  'canvas_write_node',
  'canvas_run_node',
  'canvas_node_status',
  'canvas_update_node',
  'canvas_generate_node',
  'canvas_delete_node',
  'canvas_relayout',
  'canvas_layout_get',
  'canvas_layout_node',
  'canvas_director_stage',
  'canvas_delete_project',
  'canvas_get_bible',
  'canvas_update_bible',
  'canvas_read_memory',
  'canvas_write_memory',
  'canvas_my_canvas',
  'canvas_production_status',
  'canvas_production_advance',
  'canvas_auto_status',
  'canvas_auto_start',
  'canvas_auto_budget',
  'canvas_auto_generate',
  'canvas_auto_abort',
  'canvas_create_node',
  'canvas_connect',
  'canvas_open',
  'canvas_list_skills',
  'canvas_skill_pack',
];
```

（#1–18、#26–30 为 0.19.x 既有的 23 个；#19–25 为 0.20.0 新增的制作阶段机/自动创作 7 个——
计划原文的「23」即漏掉了这 7 个。测试同时断言数量与 CANVAS_METHODS 逐项一致。）

## 4. RUNTIME_FILES（运行时最小文件清单）

顶层 import（`index.js` L9–19）：

- node 内置：`node:child_process`、`node:fs/promises`、`node:fs`、`node:os`、`node:path`、`node:url`、`node:module`。
- 仓库内（import 闭包，无更深层的仓库内文件）：

| 仓库路径 | dist/core/ 下路径 | 说明 |
| --- | --- | --- |
| `index.js` | `core/index.js` | 入口：`apply` / `inject` |
| `index-core-skill-profile.js` | `core/index-core-skill-profile.js` | 技能口径常量 |
| `skill-pack-loader.js` | `core/skill-pack-loader.js` | 技能包加载（`initPackBase(HERE)`） |
| `skill-pack.js` | `core/skill-pack.js` | 技能目录/切片渲染（依赖 index-core-skill-profile） |
| `production.js` | `core/production.js` | 制作阶段机 |
| `package.json` | `core/package.json` | L38 **import 时同步读** VERSION，缺了会崩 |

运行时**读取**（非 import，打包须随行）：

- `assets/canvas-{studio,craft,layout,director}/SKILL.md`（L2046，缺失 → 跳过该内置技能，不崩）。
- `assets/canvas-director/**`（技能包 manifest/pack/slices/moves，`PACK_DIR_REL = 'assets/canvas-director'`）。

数据目录约定（env，import 时读一次）：

- `DSH_IC_CONFIG_PATH`（默认 `~/.dsh/infinite-canvas/config.json`，L140）。
- `DSH_IC_PROJECTS_DIR`（默认 `~/.dsh/infinite-canvas/projects`，L1088）；项目、画布文档、资产库、
  `production.js` 的 `<项目目录>/production/*.json` 都落在这棵树内。
- 假适配器存储根：`adapters/.tmp-home/`（`DSH_IC_PROJECTS_DIR=<root>/projects`、
  `DSH_IC_CONFIG_PATH=<root>/config.json`），已在 `.gitignore` 排除。

## 5. dist 布局契约（冻结，供 Task 2+ 打包任务对齐）

```
dist/
  canvas-mcp.cjs        # MCP stdio 承载
  canvas-web.cjs        # HTTP 承载（webServer 路由面）
  model-bridge.cjs      # 模型桥接
  llm-channel.cjs       # llm 通道
  host-adapter.cjs      # adapters/shared/host-adapter.cjs 的发布拷贝
  core/                 # <RUNTIME_FILES>（§4 表格的 dist/core/ 列，含 assets/ 与 package.json）
```

## 6. createHostAdapter 接口契约（Task 1 产出，Task 2+ 消费）

```js
// adapters/shared/host-adapter.cjs（CommonJS，零依赖，仅 node 内置）
const { ctx, tools, routes, dispose } = await createHostAdapter({
  corePath?: string,   // core 入口（index.js）路径；绝对路径直接用，相对路径相对仓库根解析；
                       // 缺省 = 仓库根 index.js（相对 host-adapter.cjs 的 ../../../index.js，开发期用）
  homeDir?: string,    // 假存储根；缺省 = adapters/.tmp-home/（设置 DSH_IC_* 于 import core 前）
});
// ctx    : { effect(fn, label?), get(name) → undefined,
//            tools: { register(def) → disposer }, webServer: { register(route) → disposer } }
// tools  : Def[]    —— §2.1 形状，30 个，逐字复用 index.js 注册表（不改名、不裁剪）
// routes : Route[]  —— §2.2 形状，9 条
// dispose(): 依次调用全部收集到的 disposer（工具/路由/effect），幂等容忍重复调用
```

- CJS 形态是刻意的：六家 IDE 宿主加载器以 `require` 为主，发布物也是 `.cjs`（§5）。
- `get(name)` 返回 `undefined`：所有 get 用点均已核实为防御式降级（§2 表格），不需要假服务。
- `effect(fn)`：立即执行 fn、收集其返回的 disposer——与 cordis 同步 effect 语义一致，
  这正是「apply 同步注册完一切」的机制（§1）。
- **core 单例**：同一进程内第二次 `createHostAdapter({ corePath })` 命中 ESM 模块缓存——两个 adapter
  共享同一 core 实例，`DSH_IC_*` env 也不会重读（core 在首次 import 时定格）。因此每进程只建一个
  adapter；多承载（MCP + HTTP）复用同一个 adapter 的 tools/routes 即可，不要各自 create。

## 7. MCP stdio 承载契约（Task 2 产出 canvas-mcp.cjs，供 Task 3/5 与宿主接入对齐）

- CLI：`node canvas-mcp.cjs [--core-dir <path>] [--home <dir>]`；`--core-dir` 为 core 入口所在目录
  （内含 index.js，缺省仓库根）；`--home` 为存储根（缺省走 host-adapter 默认 `adapters/.tmp-home/`）。
- 帧：newline-delimited JSON-RPC 2.0 over stdio；**Buffer 级切帧**（chunk 累积 + 按字节
  `indexOf(0x0A)` + 整行 concat 后一次性 utf8 解码）——禁止 readline / toString 后 split，
  中文（3 字节 UTF-8）跨 chunk 边界会碎帧（测试 `scripts/test-adapters-mcp.mjs` 断言 5 已验证）。
- 协议面（刻意最小）：`initialize`（protocolVersion 回显 client 版本，缺省 `2025-06-18`；
  serverInfo `dsh-infinite-canvas@0.1.0`；capabilities.tools）/ `tools/list`（31 个：
  30 个 canvas_* 顺序同 §3，`inputSchema = def.parameters`，末位追加 `canvas_llm_probe`，
  其 inputSchema 固定 `{type:'object',properties:{}}`）/ `tools/call`（成功 →
  `content:[{type:'text',text:JSON.stringify(result)}]`）。通知一律不回包；未知工具 →
  error `-32602`；`execute` 抛错 → `isError:true` tool result（text 含错误消息），进程不退出。
- **勘误（Task 2 实测）**：`canvas_list_projects` 返回 `{count, text}`，**没有** `ok` 字段
  （index.js L4674）——计划原文「canvas_list_projects 含 "ok":true」的断言落到
  `canvas_create_project`（返回 `{ok:true,...}`）。
- 日志红线：stdout 只写 JSON-RPC 消息；stderr 日志只记方法名/错误消息，**绝不记工具参数**（apiKey）。
