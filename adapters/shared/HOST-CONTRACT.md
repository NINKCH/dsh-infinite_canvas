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
| 1 | `/infinite-canvas/api/rpc` | **已核实（Task 3 HTTP 实测 + 源码 L5560–5586）**：POST 原始 JSON `{method, args}`（**非** JSON-RPC 2.0 信封，无 `jsonrpc`/`id` 字段）→ 方法表分派 → `res.end(JSON.stringify(await fn(args ?? {})))`；非 POST 405 JSON；未知方法/坏 JSON/异常 400 JSON；请求体上限 8MB。**方法表是 core 内部 camelCase 方法（67 个，`_internals.rpcMethods()` 实测键集：ping / projectsList / llmOptions / canvasCreateProject / …）——30 个 `canvas_*` 名是工具注册表（ctx.tools.register，走 MCP 承载），不在 RPC 方法表里**，POST `canvas_list_projects` → 400「未知操作」（Task 3 探针实测钉死） |
| 2 | `/infinite-canvas/api/llm-stream` | POST，流式生成，请求体上限 4MB |
| 3 | `/infinite-canvas/api/asset` | （未逐一核对） |
| 4 | `/infinite-canvas/api/fetch-proxy` | （未逐一核对） |
| 5 | `/infinite-canvas/api/file` | （未逐一核对） |
| 6 | `/infinite-canvas/api/poster` | （未逐一核对） |
| 7 | `/infinite-canvas/api/thumb` | （未逐一核对） |
| 8 | `/infinite-canvas/api/object` | （未逐一核对） |
| 9 | `/infinite-canvas/api/plugin-asset` | GET 静态资源；白名单 `assets/` 目录、拒绝路径穿越 |

**面板路由核实结论（Task 3）**：core **不注册任何 HTML/静态面板路由**——9 条全为 `/infinite-canvas/api/*` API（源码 L5560–5918 逐条核对 + 探针实测 `GET /` → 404）。画布面板页由 `canvas-web.cjs` 自备：exact `/`，200 `text/html; charset=utf-8`，挂载点特征子串 **`id="infinite-canvas-root"`**（探活标识；页内经 RPC `projectsList` 列项目，不复制 core 语义）。计划原文「core 已含 `/infinite-canvas/` 静态面板路由」与实际不符，以本条为准。

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

> **client.js 勘误（Task 7 controller 裁定，2026-11-08）**：仓库根 `client.js` 是 DSH Harness
> 控制台前端（`window.__ModuleLoader__.load` 形态），index.js 不 import（仅注释提及「与 client.js
> 同一映射」）——**不属 RUNTIME_FILES**，不随 adapters 发布物（qoder dist 曾按 task-7-brief
> Step 1 断言随包，1.4MB 死重，已剔除）。上表与 index.js 实际顶层 import 清单已逐项核对一致。
> vsix 副本待 Task 9 重跑 sync 后同步瘦身。

运行时**读取**（非 import，打包须随行）：

- `assets/canvas-{studio,craft,layout,director}/SKILL.md`（L2046，缺失 → 跳过该内置技能，不崩）。
- `assets/canvas-director/**`（技能包 manifest/pack/slices/moves，`PACK_DIR_REL = 'assets/canvas-director'`）。

数据目录约定（env，import 时读一次）：

- `DSH_IC_CONFIG_PATH`（默认 `~/.dsh/infinite-canvas/config.json`，L140）。
- `DSH_IC_PROJECTS_DIR`（默认 `~/.dsh/infinite-canvas/projects`，L1088）；项目、画布文档、资产库、
  `production.js` 的 `<项目目录>/production/*.json` 都落在这棵树内。
- 适配器存储根（数据根裁定，Task 7 落地）：缺省 `<homedir>/.dsh-infinite-canvas/`（env `DSH_IC_HOME`
  可覆盖，homeDir option 优先级最高，见 §6），经 `DSH_IC_PROJECTS_DIR=<root>/projects`、
  `DSH_IC_CONFIG_PATH=<root>/config.json` 注入 core。旧「仓库内 adapters/.tmp-home/」缺省废弃
  （包内数据随插件升级清空用户创作资产，Task 6 评审 Minor #2 升格）；该路径仍可作测试显式注入目录
  （Task 2/3/4 测试用法，已在 .gitignore 排除）。

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
                       // 缺省按布局自解析（defaultCorePath()）：发布布局取 <__dirname>/core/index.js
                       // （HOST-CONTRACT §5，dist/ 内五模块与 core/ 同级——宿主 .mcp.json 无需 --core-dir），
                       // 开发布局（core 不在同级）退仓库根 index.js
  homeDir?: string,    // 存储根；缺省见下方「数据根缺省」（option 优先级最高）
});
// ctx    : { effect(fn, label?), get(name) → undefined,
//            tools: { register(def) → disposer }, webServer: { register(route) → disposer } }
// tools  : Def[]    —— §2.1 形状，30 个，逐字复用 index.js 注册表（不改名、不裁剪）
// routes : Route[]  —— §2.2 形状，9 条
// dispose(): 依次调用全部收集到的 disposer（工具/路由/effect），幂等容忍重复调用
```

- **数据根缺省（数据根裁定，Task 7 落地；Task 6 评审 Minor #2 升格）**：优先级
  `homeDir option > env DSH_IC_HOME > <homedir>/.dsh-infinite-canvas/`。旧缺省「仓库内
  adapters/.tmp-home/」废弃——包内数据随插件升级清空用户创作资产；新缺省落用户目录，
  升级/重装不丢数据。测试一律经 homeDir option 或 env DSH_IC_HOME 显式注入临时目录（密闭），
  绝不触碰真实用户目录。canvas-mcp / canvas-web 的 `--home` 缺省跟随本裁定（无独立缺省）。
- 另导出 `defaultCorePath()`（发布布局自解析，见上方 corePath 注释）：canvas-mcp / canvas-web
  的 `--core-dir` 缺省复用它。

- CJS 形态是刻意的：六家 IDE 宿主加载器以 `require` 为主，发布物也是 `.cjs`（§5）。
- `get(name)` 返回 `undefined`：所有 get 用点均已核实为防御式降级（§2 表格），不需要假服务。
- `effect(fn)`：立即执行 fn、收集其返回的 disposer——与 cordis 同步 effect 语义一致，
  这正是「apply 同步注册完一切」的机制（§1）。
- **core 单例**：同一进程内第二次 `createHostAdapter({ corePath })` 命中 ESM 模块缓存——两个 adapter
  共享同一 core 实例，`DSH_IC_*` env 也不会重读（core 在首次 import 时定格）。因此每进程只建一个
  adapter；多承载（MCP + HTTP）复用同一个 adapter 的 tools/routes 即可，不要各自 create。

## 7. MCP stdio 承载契约（Task 2 产出 canvas-mcp.cjs，供 Task 3/5 与宿主接入对齐）

- CLI：`node canvas-mcp.cjs [--core-dir <path>] [--home <dir>] [--port <n>]`；`--core-dir` 为 core 入口所在目录
  （内含 index.js，缺省按布局自解析：发布布局 core/ 同级优先、开发布局仓库根，§6 defaultCorePath）；
  `--home` 为存储根（缺省走 host-adapter 数据根缺省：env `DSH_IC_HOME` || `~/.dsh-infinite-canvas/`）。
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
- `--port <n>`（Task 3 接线，可选）：给定时 MCP server 启动后经 canvas-web 的 startWeb 顺带起
  画布 HTTP（复用同一 adapter 的 routes，§6 单例）；失败仅 stderr 告警不退出；未给定时行为与
  Task 2 完全一致。

## 8. HTTP 承载契约（Task 3 产出 canvas-web.cjs，供 Task 6+ 与宿主接入对齐）

- CLI：`node canvas-web.cjs [--core-dir <path>] [--home <dir>] [--port <n>] [--open]`；
  `--core-dir`/`--home` 语义同 §7；`--port` 缺省 **3210**；`--open` 起服务后用平台默认浏览器
  打开画布 url（仅用户手动运行；测试只测命令构造，不真开浏览器）。
- 导出（供测试与 canvas-mcp 复用）：
  - `startWeb({coreDir?, home?, port?, routes?}) -> {url, server, isReuse}`——
    **routes 传既有 adapter 的 routes 时不再自建 adapter**（§6 单例：进程内已有 adapter 的
    调用方必须传；CLI main() 是进程内无 adapter 的唯一例外，由 startWeb 自建）。
  - `pickOpenCommand(platform) -> string|null`：win32 `cmd /c start "" "<url>"`（完整语义模板，
    `<url>` 占位）、darwin `open`、linux `xdg-open`，其余平台 null。
- 面板页（§2.2 核实结论）：core 无面板路由，canvas-web 自备 exact `/`（200 HTML，挂载点
  `id="infinite-canvas-root"`）；未命中路由一律 404 JSON `{error}`。
- 端口复用（Review Focus #4，两条路径均有测试钉死）：
  1. 启动前 GET `http://127.0.0.1:<port>/`（超时 1.5s）→ 200 且含 `id="infinite-canvas-root"`
     → 判定已有画布服务：返回 `{url, isReuse:true, server:null}`，**不起新 server 不双开**；
  2. 探活失败（ECONNREFUSED / 404 / 无特征串 / 超时）→ listen；目标端口被**其他服务**占用
     （EADDRINUSE）→ 端口 +1 递增重试，上限 **+10**，返回实际 url；全部占用则抛错。
- 路由分发纪律：routes 原样透传（handler 不改名、不包装、不改写语义），分发层仅做 exact
  pathname 匹配 + 未命中 404 + 兜底 500（core handler 自含错误处理，兜底只为不崩 server）。

## 9. 模型桥接契约（Task 4 产出 model-bridge.cjs，供 Task 5 llm 通道消费）

- 形态：CommonJS、零依赖（仅 node:http/https/fs/path/os 内置）；发布物 `dist/model-bridge.cjs`
  （§5）；无 CLI——承载进程（canvas-mcp / canvas-web / Task 5 llm 通道）经 require 调用。
  协议自适应：真实网关是 https、测试 mock 是 http，按 `url.protocol` 选 node:https /
  node:http（模块顶层同时 require 两者），不为此引入抽象。

```js
// adapters/shared/model-bridge.cjs（导出六件，Task 5 只消费 discoverHosts / chat / 脱敏出口）
discoverHosts({paths?, log?}?) -> { workbuddy: Model[], qoder: Model[], cursor: Model[] }
redactModel(model) -> { ...model, apiKey: '[redacted]' }
redact(s) -> s
buildUserAgent(host, version) -> string
detectHostVersions() -> { workbuddy?: string, qoder?: string }
chat(model, messages, opts?) -> { text, usage? }   // Promise；opts: { timeout?, body?, hostVersion? }
```

- **discoverHosts**：`paths` 测试注入 `{ workbuddyModels?, qoderModelsDir? }`（**测试绝不触真实
  home**）；缺省 `<homedir>/.workbuddy/models.json`、`<homedir>/.qoder-cn/.models`。
  **Task 5 Ruling（继承 Task 4 评审 Minor #2）**：新增可选 `{ log?: boolean }`，**缺省静默**
  （qoder 探测行不输出）；canvas-mcp / llm-channel 一律静默调用，观测时显式传 `log: true`。
  `Model = { host:'workbuddy'|'qoder'|'cursor', id, vendor, url, apiKey,
  supportsToolCall?, supportsImages?, supportsReasoning? }`（apiKey 仅内存持有）。
  降级矩阵（**绝不抛错**，宿主未登录/无配置是常态）：models.json 文件不存在 / 坏 JSON /
  非 JSON 数组 / 空数组 → `[]`；条目缺 url 或 apiKey / 非对象条目 → 跳过。
  workbuddy 结构已实测验证（全部走官方网关 `/v1/chat/completions`，OpenAI 兼容）；
  qoder 目录结构（`<dir>/<uid>/`，uid 目录名枚举）**未经验证，首版恒 `[]`**（Task 11 探针后补），
  `QODER_OPENAPI_ENDPOINT` 存在性只记布尔到 stderr、不发请求；cursor 恒 `[]`（后端未公开、
  ToS 敏感）。
- **chat**：非流式 POST `model.url`，body `{model: model.id, messages, ...opts.body?}`
  （messages 数组直传）；`opts.timeout` 缺省 120000ms，AbortController 中止。headers：
  `content-type: application/json`、`authorization: Bearer <apiKey>`、`user-agent` =
  `buildUserAgent(host, 版本)`——版本经 detectHostVersions（读安装目录 product.json /
  package.json，尽力而为）**在请求路径上调用一次并模块级缓存**；`opts.hostVersion` 可注入覆盖
  （测试用它避开真实安装目录读取）。响应 `choices[0].message.content` → text，`usage` 存在则
  透传。非 2xx → `throw Error('<host>/<id> HTTP <status>: ' + redact(bodyText) 截断 500 字符)`
  （**先脱敏后截断**——评审修复：先截断会让横跨截断边界的 key 残片（`sk-` + ≤7 字）逃过
  `{8,}` 正则；非 JSON 响应路径的 200 字符截断同款顺序）；网络错误/超时 → `throw Error`
  （message 含 host/id/原因，同样经 redact）。
- **密钥红线（Review Focus #3/#5）**：apiKey 不进仓库/日志/错误消息/工具返回/产物包；
  model-bridge 内**所有 Error.message 组装统一过 redact 收口**，stderr 日志函数自身也过
  redact；任何把 Model 序列化出去的路径必须先过 redactModel（原对象不被改动）。测试断言：
  mock 500 回显 `sk-abc123def456` → Error.message 只见 `[redacted]`、body 片段 ≤ 500 字符。
- UA：`buildUserAgent('workbuddy', v)` → `WorkBuddy/<v>`、`('qoder', v)` → `QoderCN/<v>`；
  版本缺失/非法（或宿主未知）→ `dsh-bridge/0.1.0`（不冒充宿主客户端）。
- 测试：`scripts/test-adapters-model-bridge.mjs`（本地 mock 网关 + 临时目录，8 组：discover
  保真/降级、chat 请求断言（URL/auth/UA/body/text/usage）、500 脱敏截断、超时（AbortController
  ≈timeout 生效）与 ECONNREFUSED、空配置降级与条目跳过、qoder/cursor 恒空与 env 布尔
  （该观测用例显式 `log:true`）、redactModel、redact/buildUserAgent 纯函数）。

## 10. LLM 通道编排契约（Task 5 产出 llm-channel.cjs + canvas-mcp 接线，供 Task 6/7/8/11 消费）

- 形态：`adapters/shared/llm-channel.cjs`（CommonJS、零依赖、**不 require 任何兄弟模块**——
  纯决策 + 委托，不碰网络；网络在各通道实现里）。发布物 `dist/llm-channel.cjs`（§5）。无 CLI。

```js
// adapters/shared/llm-channel.cjs（导出两件）
resolveTextLLM(channels) -> { channel:'vscode-lm'|'bridge'|'sampling'|'byok'|'none',
                              chat(messages, opts?) -> Promise<{ text, usage? }> }
probeChannels(channels) -> { vscodeLm:'n/a'|number, bridge:{<host>:count,...}|{},
                             sampling:boolean|'unsupported', byok:boolean }
```

- **channels 注入对象（全部可注入，测试用 fake）**：
  - `vscodeLm?: { available:boolean, count?:number, chat(messages, opts) }`（仅 vsix 壳注入，
    MCP server 场景恒缺省）
  - `bridge?: { available:boolean|Model[], chat(model, messages, opts) }`——available 为
    discoverHosts 过滤出的**第一个非空 host** 的模型列表（顺序 workbuddy > qoder > cursor）；
    chat 用列表第一个模型（后续可扩展选型）
  - `sampling?: { available:boolean, chat(messages, opts) }`
  - `byok?: { available:boolean, chat(messages, opts) }`
- **resolveTextLLM**：优先级 `vscode-lm > bridge > sampling > byok > none`（逐个看 available
  真值；bridge 的空数组视为不可用——「第一个非空 host」语义）。返回的 chat 绑定所选通道。
  **失败模式统一**（Task 4 遗留事实：上游可能同步 throw 也可能 promise reject）：chat 内部
  `try { return await upstream(...) } catch` 包裹（await 把同步 throw 一并收进 catch），调用方
  只需 `await chat()` + catch 一次；上游 Error 原样重抛（message 已由各通道 redact），非 Error
  抛出物包装为 Error。none 通道 chat 恒 reject：`无可用文本 LLM 通道，请在画布设置页配置 BYOK`
  （brief 逐字；含指引、不含任何 key）。
- **probeChannels**：vscodeLm——注入存在给模型数（注入可带 count；未带按 available 记 1/0），
  缺省字面 `'n/a'`；bridge——available 数组按 host 分组计数（零计数 host 省略），空数组/非数组/
  无注入 → `{}`；sampling——`available===true → true`，false/未注入 → `'unsupported'`；byok——
  布尔直传（缺省 false）。**序列化安全（Review Focus #3）**：结果只含计数与布尔，绝不携带
  Model/apiKey——上游注入带完整 Model（含 apiKey）时输出也只留数字，JSON.stringify 全文无 `sk-`。
- **canvas-mcp 接线**（测试测接线后的 probe 应答，不直接测通道构造函数）：
  - initialize 记录 client `capabilities.sampling` 布尔（存在即支持，MCP 规范）。
  - server→client 请求（增量，帧解析不动）：`sampling/createMessage` 以 JSON-RPC request 发出
    （params 按 MCP 规范最小形态 `{messages, maxTokens}`，message content 为
    `{type:'text',text}`），应答帧（无 method、带 id 且 pending 表在等）路由回等待者；超时
    60s、client 拒答/失败 → chat 抛错（redact 后）。
  - bridge：**静默** discoverHosts（§9 Ruling）→ 第一个非空 host；chat 走 modelBridge.chat。
  - byok：见下方探明结论。
  - probe 应答语义（相对 Task 2 固定默认值的变化）：`bridge: [] → {}`（对象计数）、
    `sampling: 'unknown' → true|'unsupported'`；`vscodeLm` 恒 `'n/a'`；tools/list 的
    inputSchema 不变。
- **byok 探明结论（HOST-CONTRACT §10 关键事实，brief 假设与 core 实际不符，按 fallback
  条款如实实现）**：
  - core **没有** BYOK url/apiKey 存储：index.js 全文 grep `apiKey|baseUrl|byok` 零命中；
    `llmOptions` RPC（L3986 → `listLlmOptions()` L3606）读的是 **Harness llm 服务**
    （`ctx.get('llm')`），返回 `{providers:[{id,name,models:[{id,name}],error?}],
    resolved:{provider,model}|null, error?}`——「画布设置页配置 BYOK key」在 core 语义中不存在，
    core 的文本生成一律走 Harness llm 服务的 `service.stream()`。
  - available 判断（按 core 语义）：llmOptions 的 `resolved` 非 null（= llm 服务已配置至少一个
    可用模型）；`error` 字段（如 MCP 承载假 ctx `get('llm')` 恒 undefined →
    `llm 服务不可用`）→ false。**MCP 承载场景 byok 现状恒 false**（诚实降级，宿主侧 llm 服务
    不在假 ctx 内）。
  - chat 实现：不走「url/apiKey 构造 Model + model-bridge 直调」（该配置在 core 不存在，不硬造），
    改走 core 原生文本生成路径 `/infinite-canvas/api/llm-stream`——**进程内调用路由 handler**
    （invokeRoute：最小 fake req/res，headersSent 语义对齐真实 node：write 才置位），
    messages → `complete(args)` 形状（system = 各 system 消息 content 拼接、user = 最后一条
    user 消息 content；opts.temperature/maxTokens 透传），SSE 解析：`t:'x'` 累积、`t:'done'`
    为权威全文、`t:'fail'`/非 200 → 抛错（先 redact）。
  - Task 11 实测注意：byok=true 只会出现在 llm 服务可达的宿主（vsix 壳等，Task 6+），MCP stdio
    承载下恒 false 是预期行为而非缺陷。
- 测试：`scripts/test-adapters-llm-channel.mjs`（全 fake 注入，5 组：优先级矩阵 7 例、chat
  委托透传、失败模式统一 3 例、probeChannels 计数/布尔/脱敏、返回形状）；`scripts/test-adapters-mcp.mjs`
  断言 1b 钉接线后 probe 应答（sampling 能力记录 + bridge 对象形态 + 无 `sk-`）。

## 11. vsix 壳契约（Task 6 产出 adapters/vsix/，供 Task 11 四家实机探针消费）

- **布局（sync-shared.mjs 产物，随仓提交；改 shared/core 后必须重跑 `npm run sync`）**：
  `extension.js` + `lib/detect.cjs`（纯逻辑零依赖，可单测）+ `lib/llm-vscode.cjs` +
  `shared/*.cjs`（五模块原样拷贝）+ `shared/core/`（§4 RUNTIME_FILES 6 文件 +
  `assets/canvas-{studio,craft,layout,director}/SKILL.md` + `assets/canvas-director/**`）。
  **vscode 依赖面纪律：vscode 只出现在 extension.js 与 lib/llm-vscode.cjs。**
- **detect（lib/detect.cjs）**：`detect({lmTools,mcpProvider,cursorMcp,sampling}) ->
  {path:'lm-tools'|'mcp-provider'|'cursor-mcp'|'manual', sampling}`；严格 `=== true` 才算真
  （缺字段/多传/非布尔一律按 false，不抛错）。测试 `scripts/test-adapters-vsix-detect.mjs`。
- **d.ts 裁决（静态 contributes 路线）**：最新 @types/vscode（1.145.0 实读）`lm.registerTool`
  注释逐字要求『The tool must also be registered in the package.json `languageModelTools`
  contribution point』；`lm.registerMcpServerDefinitionProvider` 注释要求先声明
  `contributes.mcpServerDefinitionProviders` 同 id。两者都以静态声明落地：
  - `adapters/vsix/scripts/generate-tools-contribution.mjs` 从 host-adapter defs 一次性生成
    `contributes.languageModelTools`（name/modelDescription/inputSchema 逐字搬运；
    canBeReferencedInPrompt:false）→ 再生成命令：adapters/ 内 `npm run generate:tools`
    （**core 工具面变更后必须重跑，否则静态声明漂移**）。脚本自带写后逐条对账。
  - vsix package.json 手工维护 `contributes.mcpServerDefinitionProviders:
    [{id:'dsh-canvas.mcp',...}]`，与 extension.js 的 `MCP_PROVIDER_ID` 同字面。
  - vsce 校验 @types/vscode 与 engines.vscode 同 major.minor → adapters devDeps 锁
    `@types/vscode@~1.90.0`（=engines ^1.90.0 floor）；API 形状以 1.145.0 d.ts 实读为准。
- **floor API 形状（1.90 d.ts 实读）**：`sendRequest(messages: LanguageModelChatMessage[],
  ...)`——prompt 以 `LanguageModelChatMessage.User(prompt)` 单条传入（1.90 无 System 静态
  构造器，system 前缀按 brief『简单拼接』折进 user 文本）；`response.text: AsyncIterable<string>`
  （1.145 同形）。`registerTool`/`LanguageModelToolResult`/`LanguageModelTextPart`/
  `McpStdioServerDefinition` 在 1.90 d.ts 不存在 → extension.js 一律 `typeof` 特性探测后
  才调用（detect 链兜底）。
- **lm-tools 路径**：activate 时 `getAdapter()` 一次收集并持有（§6 单例），30 个 defs 经
  `vscode.lm.registerTool(def.name, {invoke})` 直挂；invoke → `def.execute(options.input)`，
  结果包 `LanguageModelToolResult([LanguageModelTextPart(JSON.stringify(result))])`；
  prepareInvocation 可省。dispose 链挂 context.subscriptions（含 adapter.dispose 幂等）。
- **mcp-provider 路径**：`McpStdioServerDefinition(label, process.execPath,
  [canvas-mcp.cjs, '--core-dir', core], {ELECTRON_RUN_AS_NODE:'1'})`（1.145 d.ts L20739：
  cwd 不在构造器形参内）。**--core-dir 必传**：canvas-mcp/host-adapter 的缺省 REPO_ROOT
  解析（自身 `../..`）在 vsix 内指向扩展根而非 core 目录。resolveMcpServerDefinition 可省
  （无用户交互）。
- **cursor-mcp 路径**：`vscode.cursor.mcp.registerServer({...同款 stdio 形状})`——Cursor 专有、
  无 d.ts，形状为尽力传入（Task 11 实机校准）；注册抛错只记录降级到手配引导，不影响 activate。
- **openCanvas**：`startWeb({port:3210, routes: adapter.routes})`（§6/§8：routes 传入不自建）；
  WebviewPanel iframe html CSP 含 brief 逐字 `frame-src http://127.0.0.1:3210 http://127.0.0.1:*`；
  `createWebviewPanel` 抛错 → `env.openExternal` 落浏览器。端口复用/换口语义全在 canvas-web（§8）。
- **probeHost**：四能力布尔 + 决策路径 + selectChatModels 模型 id 清单 + Task 5 probeChannels
  （vscodeLm 注入 llm-vscode 通道（带 count）；bridge 静默 discoverHosts 后第一个非空 host 列表
  + `modelBridge.chat`；sampling 报告面恒 `'n/a'`（进程内语义，MCP server→client sampling 不适用）；
  byok=false）——**每行经 model-bridge.redact**（Review Focus #3）。
- **命令纪律**：三命令处理器统一 try/catch，错误 `showErrorMessage` + OutputChannel，message 全过
  redact；deactivate 幂等 dispose adapter。
- **存储与资源边界**：homeDir 走 host-adapter 缺省（数据根裁定 Task 7 后即 `<homedir>/.dsh-infinite-canvas/`，
  env `DSH_IC_HOME` 可覆盖；extension.js 未传 homeDir，Task 6 时为扩展目录沙盒的旧缺省已废弃；
  最终落位 globalStorage 待 Task 11 实测后定）；
  `assets/director/**`（3D 引擎静态资源，npm files 有、§4 清单无）**不随 vsix**——画布 UI 若在
  实机发现 director 引擎 404，补 sync 清单即可（数据补齐非代码变更）。
- **打包**：adapters/ 内 `npm run package`（sync → generate:tools → vsce package）→
  `adapters/dist/dsh-infinite-canvas-0.1.0.vsix`；.vscodeignore 排除 scripts/（构建期），
  **lib/ 必须随包**（extension.js 运行时 require）。自检断言：zip 条目含
  `extension/extension.js`、`extension/shared/canvas-mcp.cjs`、`extension/shared/core/index.js`。
- **vsce/发布事实**：vsce 3.9.2 打包通过（142 files / 867.73 KB）；README/repository/LICENSE 齐
  无告警；vsce 会把 README 规范化为 `readme.md`、LICENSE 规范化为 `LICENSE.txt`（zip 条目名）。

## 12. workbuddy 壳契约（Task 8 产出 adapters/workbuddy-plugin/，本地目录市场形态）

- **分发形态**：WorkBuddy（OpenCode 系 Electron）装插件 = 加 marketplace：市场根含
  `.codebuddy-plugin/marketplace.json`，plugins[] 条目 `{name, description, version,
  source:"./plugins/<name>"}`（codebuddy 官方市场样例实证）；插件目录 = `.codebuddy-plugin/plugin.json`
  + `.mcp.json` + `skills/` + `dist/`。known_marketplaces.json 实证 `directory` / zip URL 两种市场源
  type。无扩展页 → 画布面板走本机浏览器（canvas-web，§8）。
- **三个 JSON 冻结（task-8-brief 逐字，键序即文件字节序）**：市场根 `marketplace.json`
  （`dsh-marketplace`/owner ninkch/单插件条目）；插件 `plugin.json`（**无** displayName/skills 字段，
  与 qoder §11 形态不同，`mcpServers` 指向 `./.mcp.json`）；插件 `.mcp.json`
  （`command:"node"` 走 PATH——官方样本 godot-mcp 实证合法，stdio command 强制插件根内由
  `${CODEBUDDY_PLUGIN_ROOT}` args 指向保证）。源文件随仓提交于 `adapters/workbuddy-plugin/marketplace/`。
- **build（adapters/scripts/build-workbuddy.mjs，自足零依赖，导出 buildWorkbuddy 供 Task 9 复用）**：
  shared 五模块**枚举清单 + 缺失报错**（勿 readdir 自动发现——Task 7 评审 Minor #2 教训）；core 按
  §4 RUNTIME_FILES 6 文件 + assets 技能 ×4 拷进 `marketplace/plugins/dsh-infinite-canvas/dist/`
  （布局照 §5）；**client.js 不随包**（§4 勘误）；**版本号单源：从 plugin.json 读**（Task 7 评审
  Minor #3），并与 marketplace.json 条目版本一致性对账（漂移即报错）。产物：staging 完整市场
  `adapters/dist/workbuddy-marketplace/`（目录本身可作 directory 源）+ zip `tar -a -c -f`（同 §7
  手法，ZIP 根直接含 `.codebuddy-plugin/marketplace.json`）→
  `adapters/dist/dsh-marketplace-workbuddy-<version>.zip`。**不改 build-qoder.mjs**（零跨任务回归面，
  两脚本小重复可接受，Task 9 总编排再统一）。
- **测试**：`scripts/test-adapters-workbuddy-pkg.mjs`（staging 树 / 三 JSON 逐字 / client.js 反向
  断言 / zip 根条目 tar -tf / SKILL frontmatter `name: canvas` / sk- 密钥形状扫描 / staging 产物
  冒烟：DSH_IC_HOME 注入 + GET 面板 200 + POST ping 200 + projects/ 落 env 根）。
- **gitignore**：生成物全被 `adapters/.gitignore` 的无锚点 `dist/` 覆盖（staging、插件 dist、zip
  三路径 check-ignore 实证），无需新增行。
- **红线**：build/test **绝不写 `~/.workbuddy`**（本会话正运行在 WorkBuddy 内；注册 = 加
  known_marketplaces 条目，延后 Task 11，用户配合执行）；README 注明本任务未执行注册 +
  known_marketplaces 手改须备份与 read-merge。SKILL.md 同 Task 7 语义（六条铁律：qoder 五条 +
  tools/list 参数自查升格为第六条；浏览器打开 `<CODEBUDDY_PLUGIN_ROOT>/dist/canvas-web.cjs --open`）。
