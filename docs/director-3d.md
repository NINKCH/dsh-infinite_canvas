# 3D 导演台技术方案（Infinite Canvas）

> 状态：**决策文档**（只定方案与验收判据，不含实现代码）
> 范围：无限画布插件的「3D 导演台」功能——左侧图标列入口、摆位取景、截图当镜头首帧、接视频生成
> 代码快照：2026-10-23，`client.js` 15974 行 / `index.js` 3984 行；并行开发会让行号漂移，**以标识符检索为准**（末尾「引用自查」给出当次实测行号）
> 读者：维护者（第二至六节）+ 用户（第一节专门解释为什么不能直接复制参考实现）

---

## 摘要（结论先行）

1. **不复制参考项目的代码。** 参考实现携带 "Source Available" 许可，其 Part A 第 5 条禁止把它内嵌/打包进另一款产品分发；我们的包是 Apache-2.0 公开 npm 包，搬进来等于混合许可分发，属于明确不做的行为。**可以借鉴的是设计**（数据结构、交互流程、提示词编译思路），因为许可文本明确"独立实现、仅 API 兼容、输出物"不因与参考项目交互而变成 Derivative Work。
2. **现状已有一版 v0 导演台**（Canvas2D 软件光栅、零依赖），已具备：左侧图标列入口、摆位/旋转/拾取、机位取景、提示词编译、截图进资产库并生成图片节点。它是本方案的**基线**与**降级回退**。
3. **渲染内核推荐路线 A**：把 `three@0.186.1` 预构建成**自包含 ESM**（core-only：742,859 B / gzip 190,379 B；含 GLTFLoader+SkeletonUtils：791,434 B / gzip 204,737 B；MIT），放 `assets/vendor/`，用动态 `import()` 从既有 `plugin-asset` 路由加载；接口仍走既有 `directorRenderScene`，WebGL 不可用时回退 v0。理由：这是唯一能真正做到"可信机位取景 + 截图当首帧"的路线，且 743 KB 对本地插件可接受、npm 传输 gzip 后约 186 KB。
4. **推进顺序**：A 文档（本文）→ B1 数据契约与持久化 → B2 渲染内核（含回退）→ C 接进视频生成。每个阶段的验收判据都写成可断言的条目（见第五节）。
5. **不做**：骨骼动画 / GLB 角色（要 GLTFLoader + IK + 蒙皮，另一个量级）、实时渲染视频（只导截图，视频仍交厂商）、改动现有门禁断言（当前 `scripts/regress.mjs --list` 实测 **41 项**，其中条件用例 3 项）。

---

## 一、为什么不能直接复制（给用户的解释）

用户在需求里说"直接从参考项目复制即可"。这一条**不能照做**，原因不在技术，在许可。以下按参考项目 `LICENSE` 的原文条款逐条说明（本文只引用条款要点，不引用其任何代码）。

### 1.1 参考项目是"双段式许可"

参考项目的 `LICENSE` 分两部分：

- **Part A：BeefTV Source Available License 1.0**——适用于"新的、原创的、首次在该许可下发布的材料"（Covered Material）。
- **Part B：历史 MIT**——适用于在特定历史 commit 及更早之前已按 MIT 发布的既有材料。Part A **不撤销、不替换**这些既有权限。

所以"参考项目是 MIT"这句话只对历史部分是成立的；**当前位置上的导演台实现属于 Part A**。我们无法逐文件判定哪些是 2026 年之前的历史 MIT 材料、哪些是新增的 Covered Material——逐文件判定本身就有法律成本，而且判定错了就是混合许可风险。

### 1.2 Part A 第 5 条禁止的行为（关键）

Part A 第 5 条列出"需要另行书面授权"的行为，其中 5(a) 原文要点是：不得为**商业对价**出售、出租、收费许可，或以其他方式提供 Covered Material 或其 Derivative Work，**无论独立、更名、白标、内嵌，还是与另一款产品打包（embedded / bundled with another offering）**。5(b) 禁止为第三方收费安装、部署、迁移、定制交付或运营含该材料的系统；5(c) 禁止把它作为 External Service 提供（无论收费与否、单租户还是多租户）。

对照我们的处境：

| 事实 | 后果 |
|---|---|
| 我们发布 `@ninkch/dsh-infinite-canvas`（Apache-2.0，公开 npm 包） | 包对外承诺的是 Apache-2.0 授权 |
| 若包内含 Part A 材料 | 我们**无权**把 Part A 代码按 Apache-2.0 再授权；包内必须继续携带 Part A 并标注修改（Part A 第 4 条社区分发条件），单一 license 字段会失真 |
| 下游会把插件集成进商业产品 / 二次分发 | 等于把 Covered Material 带进 5(a) 描述的 "embedded / bundled" 场景；风险由我们与下游共同承担 |
| 我们自己的维护成本 | 每次上游变更都要做许可归属审计，长期不可持续 |

结论：**不复制代码，不复制实现文件，不复制注释与命名体系。** 这不是礼貌问题，是能不能合法发布的问题。

### 1.3 为什么"看设计、自己写"是安全的

Part A 第 2 条对 "Derivative Work" 的定义里有一句关键限定：**"Independent implementations, mere API compatibility, and outputs do not become Derivative Works solely because they interact with BeefTV."**（独立实现、仅 API 兼容、以及输出物，不会仅因与它交互就成为衍生作品。）

据此，我们可以合法地：

- 阅读参考实现，提炼**功能清单、数据结构语义、交互流程、提示词编译规则**；
- 用**自己的代码、自己的字段命名、自己的组件结构**重新实现；
- 不追求与参考项目 API 兼容（我们本来也不需要兼容）。

我们不能做的：

- 复制源文件、复制大段注释、沿用其函数/类型/常量命名体系；
- 复制其视觉资产、图标、文案；
- 把参考实现的代码作为"参考"混入本仓库或 npm 包。

> 边界说明：本节是工程侧的合规判断，不构成法律意见。若要把本功能用于商业发行前的正式合规审查，请另行咨询律师。

### 1.4 我们的执行纪律（自动化兜底）

光靠约定不够，所以把"不复制"写成可执行的反向断言。本仓库已有 `scripts/test-director-stage.mjs`（已收录进 `scripts/regress.mjs` 门禁清单）内置两类反向检查：

1. **不得引入 npm 依赖**：断言 `client.js` 中不出现 `require('three')` 或 `from 'three'`——本插件是单文件、无构建步骤的浏览器插件，`require` 只能拿 `react`。
2. **不得出现参考项目标识符**：断言源码不含 `DirectorScene` / `DirectorCamera` / `directorPoseBoneDeltas` / `applyDirectorRigPose` / `quaternius` 等参考实现专有标识符。

这两条断言同时保护了"单文件约束"与"许可边界"，后续任何渲染内核替换（包括路线 A）都必须保持它们通过。

---

## 二、技术约束（现状盘点）

每条都对应真实代码。表中"证据"列只写标识符/路由/字段，全部可在仓库里检索到（末尾「引用自查」给出实测命中行号）。

| # | 约束 | 现状证据（真实标识符 / 文件） | 对导演台的影响 | 需要补的动作 |
|---|---|---|---|---|
| 1 | 单文件客户端、无构建步骤 | `client.js` 顶层是 `window.__ModuleLoader__.load({ id: '@ninkch/dsh-infinite-canvas', factory(require) { const React = require('react'); … } })`；无打包器、无 `node_modules` | 不能 `import` npm 包源码；要引渲染库只能走"预构建静态产物" | 路线 A 的 vendored ESM 单独放 `assets/vendor/`，不进 `client.js` |
| 2 | 只能 `require('react')` | 同上；参考项目视口依赖 React Three Fiber / drei / three-stdlib 那一套，本插件**完全没有**这些依赖 | 不能沿用参考实现的组件树形态，只能用原生 React + 自行渲染 | B2 用自己的组件 + 渲染内核 |
| 3 | 静态资源只有一条路由 | `index.js`：`ctx.webServer.register({ kind: 'exact', path: \`/${NAME}/api/plugin-asset\` … })`，`NAME = 'infinite-canvas'`；读取参数 `rel`，白名单 `^assets\/[\w.\u4e00-\u9fa5/-]+$`，解析到 `HERE/assets` | 渲染库产物只能放在 `assets/` 下；客户端拼 URL 的既有写法是 `'/' + NS + '/api/plugin-asset?rel=' + encodeURIComponent(...)`（`NS = 'infinite-canvas'`） | 产物放 `assets/vendor/`，前端用动态 `import()` 加载 |
| 4 | **MIME 表缺 `js` / `mjs`（关键阻塞）** | `index.js`：`const MIME_BY_EXT = { png, jpg, jpeg, webp, gif, svg, webm, mp4, mov, mkv, wav, mp3, m4a, ogg, json, srt, txt }`，`mimeOf()` 对未知扩展名回退 `application/octet-stream`；路由用 `res.setHeader('content-type', mimeOf(abs))` | `.js/.mjs` 会被当成 `application/octet-stream`：`<script type="module">` 拒绝执行、动态 `import()` 直接失败 | B2 前置：`MIME_BY_EXT` 增加 `js: 'text/javascript; charset=utf-8'`、`mjs: 'text/javascript; charset=utf-8'` |
| 5 | 路由缓存策略偏保守 | 同一路由设置 `cache-control: no-cache`，**没有 ETag / Last-Modified**，`pipeFile(abs, {}, res)` 不支持 Range | 每次打开可能重新传输 743 KB（本地回环可接受）；远程部署会明显变慢 | 可选：给 `assets/vendor/` 加 `immutable` 长缓存（文件名带版本号），或补 ETag |
| 6 | 资产落盘走既有链路 | `saveAssetRecord(projectId, kind, blob, meta)` → `POST /${NS}/api/asset?rel=…` → `hostRpc('assetCreate', …)`；未配置数据根目录时**明确抛错**（`S.dataRoot` 为空即失败） | 导演台截图必须复用这条链路，不能自建第二套存储 | B1 保持复用；导演台只额外记 `source: 'director'`、`category: 'shot'` |
| 7 | 项目文档整份存 SQLite | `index.js` `ensureSchema` 建 `projects` 表，字段 `doc TEXT`；客户端 `flushSave()` 每 450ms 防抖推送 `projectsPut`，`doc` 只装 `ts / nodes / edges / view / tombstones（+ bible 变更时）` | 导演台场景（含对象/机位/灯光）若塞进节点 `data`，会跟着整份文档频繁推送 | 场景写节点 `data.directorScene`，但**只在显式操作后落库**（pointerup/提交/关闭面板），绝不逐帧写 |
| 8 | 文档顶层字段会被裁掉 | `hydrateCanvasFromHost()` 重建画布时只取 `{ nodes, edges, view, tombstones, edgeTombstones }`；`flushSave()` 推送的 `doc` 也只含固定字段 | 想"在项目文档顶端加 directorScenes 数组"会被丢掉 | 场景必须挂在**节点 data** 里（节点对象整体保留） |
| 9 | 节点类型与端口是闭环校验过的 | `PORTS`（8 种：text/shot/script/storyboard/image/video/finalcut/group）、`TYPE_LABEL`、`TYPE_KIND`、`newNode(type, pos)`、`addNodeAt(type, pos)`；`audit.mjs` 会断言"类型清单"与"可运行分支/拒绝分支"一致 | 新增 `director` 节点类型要同步 i18n、`TYPE_KIND`、渲染分支，并保持 `audit.mjs` 绿 | B1 决定：新增 `director` 类型（推荐），或复用现有类型；见 4.3 |
| 10 | 视频提示词只有一个出口 | `buildStructuredVideoPrompt(shots, refs, bible, opts)`：把分镜 `shots` + 参考图 + 设定集组装成厂商「参考生成」六段结构（`subject_definitions` / `summary` / … / `detailed_description`） | 导演台不要自建第二套提示词格式，应产出**同构的 shot** 再交给它 | C 阶段：新写纯函数把布景编译成 shot，不改 `buildStructuredVideoPrompt` |
| 11 | 分镜镜头字段会被归一 | 分镜落库时按固定字段归一（`visual`、`motion`、`tail`、`cam`、`start`、`seg`、`characters`、`scene`、`props`、`duration`、`dialogue`、`sfx` 等），额外键不保留 | 导演台编译出的镜头只能写进这些既有字段（`timeBeats`/`camera`/`vfx` 这类新键会被丢掉） | C 阶段按既有字段映射；详见 4.5 |
| 12 | 门禁是全量脚本清单 | `scripts/regress.mjs` 显式清单，`--list` 实测 **41 项**（含 3 项条件用例）；另有 `scripts/audit.mjs`（i18n/CSS/节点类型/RPC/技能工具一致）、`scripts/smoke-render.mjs`（假 React 渲染冒烟）、`scripts/check-pack.mjs`（npm 打包清单核对） | 任何阶段都不许删/放宽既有断言；新增测试只能**追加** | B1 确认导演台测试仍被清单覆盖，并补数据契约子断言（不得删项） |
| 13 | 打包白名单是硬校验 | `scripts/check-pack.mjs`：`REQUIRED`（17 个必发布文件，含 `assets/*/SKILL.md`、`docs/*.md` 里的两个）与 `ALLOWED` 正则（`assets/[a-z0-9-]+/SKILL\.md`、`assets/support/*`、`docs/*.md`…） | `assets/vendor/three-*.mjs` **会因 ALLOWED 不匹配而打包校验失败** | B2 前置：`package.json` 的 `files` 加 `assets/vendor/*`；`check-pack.mjs` 的 `ALLOWED` 加 `assets/vendor/*`，`REQUIRED` 加产物与 LICENSE |
| 14 | npm 发布字段 | `package.json`：`"license": "Apache-2.0"`、`"version": "0.18.7"`、`files: [index.js, client.js, icon.svg, cordis.patch.yml, locale/*.json, assets/*/SKILL.md, assets/support/*, README.md, README.zh-CN.md, docs/*.md, docs/images/*]` | 本文档 `docs/director-3d.md` 天然随包发布（`docs/*.md`）；vendored 渲染库需要人工加白 | 同上 |
| 15 | UI 有已验收的硬约束 | `docs/UI-RULES.md` 第 10–12 条：图标列无外框/垂直居中/图标顺序固定为"文本 / 剧本 / 分镜表 / 图片 / 视频 / 成片 / 资产 / 设定集 / 运行工作流" | 导演台按钮插入图标列**改变了既有顺序**（当前实现插在"设定集"与"运行工作流"之间） | 合并前必须同步更新 UI-RULES 第 12 条（属产品约束变更，需 PM 确认） |
| 16 | 宿主可能设 CSP | 仓库内未发现 CSP 配置；宿主页面由 DSH 提供 | 若 `script-src` 不含 `'self'` 脚本/不允许动态 import，路线 A 加载会失败 | **待核**：在真实宿主里验证 `import()` 与 `plugin-asset` 脚本加载 |
| 17 | 没有遥测/性能基线 | 无用户端性能上报 | 无法预判 WebGL2 可用率与低端机帧率 | 以"回退 v0"兜底；不做遥测 |

---

## 三、三条候选路线对比

### 3.0 基线：v0 软件光栅（已实现，不是候选而是现状）

当前工作区已有一版导演台，实现要点（全部可检索）：

- 渲染：`directorRenderScene(ctx, w, h, scene, opts)` 用 Canvas2D 画**凸面片**，画家算法按深度排序；`directorLookAt` + `directorProject` 做真实透视投影；`directorActorFaces` / `directorObjectFaces` 生成人偶与 primitive 面片；`directorShadeColor` 做简单兰伯特着色。
- 交互：拖动空白处绕主体旋转机位、拖动对象沿地面移动、`directorPickObject` 按屏幕点拾取。
- 数据：`directorDefaultScene()` 给出默认布景（2 演员 / 1 机位 / 2 灯）；`loadStageDoc` / `saveStageDoc` 读写 `localStorage` 键 `LS_DIRECTOR = 'dsh-ic:director:'` + projectId（**草稿态，未进项目文档**）；`DIRECTOR_VERSION = 1`。
- 提示词：`compileDirectorPrompt(scene, { zh })` 产出"机位/站位/时长/人偶必须画成真人"的提示词块（明确颜色只用于识别站位）。
- 导出：1280×720 `toBlob('image/png')` → `saveAssetRecord(S.activeId, 'image', blob, { source: 'director', category: 'shot', … })` → `newNode('image', …)` 挂 `data.assetId` → `pushHistory()` + `flushSave()`。
- 入口：`IconRail` 内 `data-action: 'open-director'` 按钮（`Ic('camera', 16)`）；全屏浮层 `DirectorStage`（`dshic-studio-overlay` + `dshic-dir-modal`），状态 `S.directorOpen / S.directorSel / S.directorTool`。
- 测试缝隙：`window.__DSH_IC_DIRECTOR__` 暴露 12 个纯函数/组件，供 `scripts/test-director-stage.mjs` 脱 DOM 断言。

**v0 的能力边界**：遮挡靠面片排序（复杂相交几何会出现穿帮）、无阴影贴图、无材质/纹理/反射/景深、无 GLB、几何量级到几百面片后 Canvas2D 填充成本上升。够"摆位取景"，但**不够"可信"**——尤其遮挡错误会直接误导视频模型理解空间关系。

### 3.1 路线 A：vendored three.js（预构建自包含 ESM）

做法：用 esbuild 把 `three@0.186.1`（+ 可选 GLTFLoader / SkeletonUtils）打成**单文件、零外部 import 的 ESM**，放 `assets/vendor/`，运行时 `await import('/' + NS + '/api/plugin-asset?rel=assets/vendor/…')`。`client.js` 本身仍是零依赖单文件（不出现 `require('three')`），既有反向断言继续成立。

- 体积（实测，见 3.4）：core-only 742,859 B（gzip 190,379 B）；含 loader 791,434 B（gzip 204,737 B）。
- 能力：真实深度缓冲（遮挡正确）、阴影、PBR 材质、MSAA、GLB/骨骼（用得上时）、后期（雾/色调映射）。
- 代价：仓库多一个 743 KB 的 vendored 产物 + provenance 记录 + MIME/打包/ALLOWED 三处改动 + 一次渲染内核替换。
- 许可：three 是 **MIT**，允许再分发，但必须随包保留其 LICENSE 文本（3.5 给出清单）。

### 3.2 路线 B：手写原生 WebGL（不引 three）

体积最小（估计 <100 KB，需实测），但摇臂/轨道机位、射线拾取、变换 gizmo、阴影贴图、抗锯齿、材质全要自己写。实现成本高、能力上限低（等价于自研一个迷你渲染引擎），维护成本长期落在本插件上。**不推荐**。

### 3.3 路线 C：CSS 3D transform 伪 3D

成本最低，但 CSS 透视没有真实深度缓冲/遮挡/光照，做不出可信取景；截图当首帧的价值几乎为零。**不推荐**。

### 3.4 对比表

体积指新增加的可分发字节；"实现成本"按一次交付的工作量估计。

| 路线 | 体积（raw / gzip） | 实现成本 | 能力上限 | 许可 | 主要风险 | 结论 |
|---|---|---|---|---|---|---|
| v0 基线（现状） | 0（现有代码，约 770 行） | 已完成 | 中：透视+着色+拾取；**无真实遮挡/阴影/材质/GLB** | 自有 Apache-2.0 | 遮挡错误误导生成；几何量上去后卡 | 保留为**降级回退** |
| **A：vendored three（core）** | **742,859 B / 190,379 B** | 中：内核替换 + 打包链 + MIME/白名单 | **高**：深度/阴影/材质/MSAA/GLB | MIT（随附 LICENSE） | 体积、构建产物 provenance、CSP 待核 | **推荐** |
| A+（含 GLTFLoader/SkeletonUtils） | 791,434 B / 204,737 B | 中 | 高 + 具备 GLB 能力（但 v1 不用） | MIT | 多 49 KB 未用代码 | 需要 GLB 再换 |
| B：手写 WebGL | 估计 <100 KB（待实测） | 高 | 中：能正确遮挡，但材质/阴影/抗锯齿都要自研 | 自有 | 自研渲染器 bug、工期不可控 | 不做 |
| C：CSS 3D | ~0 | 低 | 低：无真实遮挡/光照 | 自有 | 取景不可信 | 不做 |

### 3.5 路线 A 的产物与 provenance（可复核）

固定版本：`three@0.186.1`，构建器 `esbuild@0.28.2`。入口文件是我们自己的 2–3 行（只做 import/re-export，不含参考项目任何内容）：

```js
// entry-core.mjs（我们自己的入口）
import * as THREE from 'three';
export { THREE };
```

构建命令（在临时目录 `npm i three@0.186.1 esbuild@0.28.2` 后执行）：

```bash
npx esbuild entry-core.mjs --bundle --minify --format=esm --legal-comments=eof \
  --outfile=three-0.186.1.core.min.mjs
# 若将来需要 GLB：
#   entry-full.mjs 额外 import { GLTFLoader } 与 * as SkeletonUtils，一并 export
```

实测产物（本机 2026-10-23 复算，`zlib.gzipSync(level:9)` 计算 gzip）：

| 产物 | 字节 | KiB | gzip 字节 | gzip KiB | SHA256（前 16 位，全文见 3.6 记录文件建议） | 静态 import 数 |
|---|---|---|---|---|---|---|
| core-only ESM | 742,859 | 725.4 | 190,379 | 185.9 | `7cee48efcd7b653b` | 0 |
| 含 loader ESM | 791,434 | 772.9 | 204,737 | 199.9 | `fb25fe4569ac3ebc` | 0 |
| core-only IIFE（对照） | 742,876 | 725.5 | 190,386 | 185.9 | — | 0 |
| 含 loader IIFE（对照） | 791,445 | 772.9 | 204,751 | 200.0 | `6938ba84948b0750` | 0 |

> **口径校正（重要）**：任务初期口头测算把"含 loader 的 ESM"记为 742 KB，实测是 **791,434 B**；742 KB 对应的是 **core-only**（官方 `three.module.min.js` 为 742,291 B）。本文一律按实测值记录，避免后续拿错数字做体积预算。

provenance 记录（随产物一起进仓库）：

1. `assets/vendor/README.md`：版本、构建命令、构建日期、产物 SHA256 全文、gzip 结果、是否含 loader；
2. `assets/vendor/three-0.186.1.LICENSE.txt`：three 的 MIT 原文（npm 包内 `LICENSE` 实测 1,081 B）；
3. `package.json` 的 `files` 增加 `assets/vendor/*`；`check-pack.mjs` 的 `ALLOWED` / `REQUIRED` 同步；
4. 升级流程：升版本 = 重新构建 + 换文件名 + 更新 README 的哈希 + 重新跑门禁，**原地覆盖 no**（缓存与溯源都需要文件名带版本）。

### 3.6 推荐与理由

**推荐路线 A（core-only），并按"可回退内核"接入。**

- 只有 A 能同时满足"真实透视 + 真实遮挡 + 可信光照"，这是"截图当首帧"能对视频模型产生正面作用的前提；v0 的画家算法在人物前后交叠时会出现明显穿帮。
- 743 KB 对本地插件可接受：npm 传输 gzip 后约 186 KB；只在打开导演台时才 `import()`，不影响画布首屏。
- 许可干净（MIT），v0 保留为 WebGL 不可用/加载失败时的降级路径，交付风险可控。
- 接口已经预留：`directorRenderScene` 是纯函数接口（v0 注释明确"光栅化换成 WebGL 是后续可选项，接口保持不变"），替换时不动数据层与交互层。
- 若最终确认"v1 不需要真实阴影/材质/GLB，只要摆位取景"，也可以**先交付 B1 + C，把 B2 后置**；本方案的阶段划分允许这个选择（B2 是独立阶段，验收独立）。

### 3.7 路线 A 需要改的现有位置（清单，不含实现）

| 位置 | 改动 | 风险级别 |
|---|---|---|
| `index.js` `MIME_BY_EXT` | 增加 `js` / `mjs` → `text/javascript; charset=utf-8` | 低（纯新增键） |
| `index.js` `plugin-asset` 路由 | 可选：`assets/vendor/` 走长缓存/ETag；保持路径白名单不放宽 | 中（缓存语义） |
| `package.json` `files` | 增加 `assets/vendor/*` | 低 |
| `scripts/check-pack.mjs` | `ALLOWED` 增加 `assets\/vendor\/[A-Za-z0-9._-]+`；`REQUIRED` 增加产物 + LICENSE | 低（改门禁白名单需在提交说明里写清） |
| `client.js` 导演台渲染层 | 新增 WebGL 实现（内部函数），`directorRenderScene` 对外签名不变；保留 v0 实现作回退 | 中 |
| `scripts/regress.mjs` | 确认导演台测试已在清单（当前 41 项）；新增子项只追加 | 低 |
| `docs/UI-RULES.md` | 第 12 条图标顺序加入"导演台" | 中（产品约束变更需确认） |

---

## 四、数据契约映射

参考实现的数据模型有 6 个核心概念。我们**不复制其字段定义**，只按"要表达什么"重新设计自己的最小子集。下表左列是概念语义，右列是我们的落点。

### 4.1 六个概念 → 我们的落点

| 参考概念（语义 / 类型名） | 承载内容 | 我们的 v1 落点 | 最小子集（我们自己的字段） | v1 做 |
|---|---|---|---|---|
| Scene（布景 / `DirectorScene`） | objects/cameras/lights/shot/activeShotId | **画布节点 `data.directorScene`**（纯 JSON） | `version` / `title` / `objects` / `cameras` / `lights` / `activeCameraId` / `shot` / `updatedAt` | 是 |
| Object（对象 / `DirectorObject`） | primitive 或 actor + transform + color + visible | `directorScene.objects[]` | `id` / `kind`（actor/box/sphere/cylinder/plane）/ `name` / `color` / `pos{x,y,z}` / `rotY` / `scale{x,y,z}` / `visible` | 是 |
| Camera（机位 / `DirectorCamera`） | transform + target + focalLength + fov + aperture + keyframes | `directorScene.cameras[]` | `id` / `name` / `pos` / `target` / `fov`（度数）；`focalLength` 由 fov 换算显示，**不存两套** | 是（无关键帧） |
| Light（灯 / `DirectorLight`） | type + transform + color + intensity | `directorScene.lights[]` | `id` / `name` / `dir`（方向光）/ `color` / `intensity`；v1 只做方向光 + 环境光 | 是 |
| Shot（镜头 / `DirectorShot`） | cameraId + duration + shotSize + cameraMove + prompt | `directorScene.shot`（单镜头）+ 导出时生成 shot | `duration` / `shotSize` / `cameraMove` / `note` | 是（单镜头） |
| Keyframe（关键帧 / `DirectorKeyframe`） | 时间轴上的 transform 采样 | **v1 不做**；留给"C2 时间轴" | — | 否 |
| Pose / Rig / Bone（姿势骨骼 / `DirectorPose`） | 人形骨骼与姿势库 | **不做**（见第六节） | — | 否 |

> 说明：参考实现用 `focalLength + fov` 双字段并保证自洽；我们只存 `fov`，UI 上按 35mm 全画幅换算显示焦距（`focalLength ≈ 24 / tan(fov/2)`，待 B2 校准确认口径），避免"两套数字打架"。

### 4.2 场景数据（我们自己的 v1 结构，示意）

```json
{
  "version": 1,
  "title": "未命名布景",
  "objects": [
    { "id": "obj_1", "kind": "actor", "name": "演员 A", "color": "#7aa2f7",
      "pos": { "x": 0, "y": 0, "z": 0 }, "rotY": 0, "scale": { "x": 1, "y": 1, "z": 1 }, "visible": true }
  ],
  "cameras": [
    { "id": "cam_main", "name": "主摄影机", "pos": { "x": 2.6, "y": 1.7, "z": 4.2 },
      "target": { "x": 0.6, "y": 1.1, "z": 0 }, "fov": 42 }
  ],
  "lights": [
    { "id": "lt_key", "name": "主光", "dir": { "x": 0.45, "y": -0.8, "z": 0.35 }, "color": "#fff2d8", "intensity": 0.95 },
    { "id": "lt_amb", "name": "环境光", "dir": { "x": -0.3, "y": -0.4, "z": -0.85 }, "color": "#8fa4c8", "intensity": 0.45 }
  ],
  "activeCameraId": "cam_main",
  "shot": { "duration": 5, "shotSize": "medium", "cameraMove": "static", "note": "" },
  "updatedAt": 0
}
```

硬约束：

- **纯 JSON**：不含 DOM 节点、函数、`Blob`、`data:`/`blob:` URL、循环引用（有测试断言）。
- **数值取整**：坐标/缩放保留 3 位小数（`Math.round(v*1000)/1000`），避免浮点尾数把文档撑大。
- **体积预算**（本方案自定工程约束，非代码既有上限）：默认布景 ≤ 8 KB；50 对象 + 20 关键帧级场景 ≤ 64 KB；超预算时提示用户"对象过多，建议拆分布景"。
- **版本号**：`version` 必须存在；读到不认识的大版本时**拒绝加载并给出提示**，不静默迁移。

### 4.3 存储位置：三个方案与结论

| 方案 | 做法 | 优点 | 致命问题 | 结论 |
|---|---|---|---|---|
| ① 项目文档顶层字段 | `doc.directorScenes = {…}` | 实现最短 | `flushSave()` 推送的 `doc` 只含 `ts/nodes/edges/view/tombstones(+bible)`；`hydrateCanvasFromHost()` 重建只取 5 个字段 → **顶层自定义字段会被裁掉** | 否决 |
| ② 复用现有节点类型（如 `group`） | `group.data.directorScene` | 零类型改动 | `group` 是"节点容器"，有 `members/collapsed` 与 ungroup 语义，混用会让布局/删除/分组逻辑互相污染 | 备选，不推荐 |
| ③ **新增 `director` 节点类型** | `node.type = 'director'`，`node.data.directorScene` | 数据随项目文档落 `canvas.db`、跨端可见、随节点删除清理、可进撤销栈；语义清晰 | 要同步 `TYPE_LABEL`/`TYPE_KIND`/`newNode`/渲染分支/i18n，并保持 `audit.mjs` 绿 | **推荐** |

③ 的落地细节：

- `node.data = { status: 'idle', directorScene, previewAssetId: null }`；节点框展示最近一次截图缩略图或轻量预览。
- 左侧图标列的"导演台"按钮语义 = **新建一个 director 节点并打开导演台**（与"文本/剧本/分镜表"按钮一致），打开已存在节点则从节点进入。
- 兼容 v0：v0 场景存在 `localStorage` 的 `dsh-ic:director:<projectId>` 草稿。B1 做一次性迁移：首次打开该项目的导演台时，若节点不存在而草稿存在 → 建节点承接草稿内容 → 删除草稿键。**不做双向同步**。
- 写入时机：拖动结束（pointerup）、属性提交、添加/删除对象、切换机位、关闭面板。**禁止**在 `pointermove` / 渲染帧里写节点（会打爆 450ms 全量推送）。
- 撤销：一次显式操作 = 一次 `update()` + `pushHistory()`；拖动过程中的中间态不推进历史。

### 4.4 截图 → 图片节点（复用既有链路，不建第二套存储）

v0 已经走通，v1 保持不变并补两个字段：

| 步骤 | 既有标识符 | v1 追加 |
|---|---|---|
| 1. 渲染当前机位到离屏画布 | `document.createElement('canvas')` + `directorRenderScene(ctx, w, h, scene, { showCameras: false })` | WebGL 内核同样渲染到离屏 canvas（`preserveDrawingBuffer` 或同帧读取，B2 实测） |
| 2. 编码 PNG | `cv.toBlob(cb, 'image/png')`，1280×720（16:9） | 可选 1920×1080；沿用节点 `ratio: '16:9'` |
| 3. 落库 | `saveAssetRecord(S.activeId, 'image', blob, { source: 'director', category: 'shot', prompt: compileDirectorPrompt(scene) })` | 无（沿用） |
| 4. 生成画布图片节点 | `newNode('image', {x,y})` → `nd.data.assetId = rec.id` → `nd.data.prompt = compileDirectorPrompt(...)` | `nd.data.label` 用"导演台截图 · 场次"；同时回写 `directorNode.data.previewAssetId = rec.id` |
| 5. 落盘 + 历史 | `pushHistory()` + `flushSave()` | 无 |

> 注意：**不要**在这条链路上改 `saveAssetRecord` 的语义，也不要新增资产类型。导演台产物就是普通 `image` 资产，后续 `@资产名@` 引用、参考图连线、PhotoCraft 调色全部自动可用。

### 4.5 提示词编译：扩展既有出口，还是新建？

**结论：新建导演台专用编译函数（纯函数），不改 `buildStructuredVideoPrompt`。**

理由：

1. `buildStructuredVideoPrompt(shots, refs, bible, opts)` 的输入是**分镜镜头数组**，输出是厂商「参考生成」六段结构；它已经是"镜头 → 厂商提示词"的唯一出口。导演台如果自建出口，会出现两套提示词格式，后续厂商协议变更要改两处。
2. 导演台的自然产物就是一个镜头：它应该编译成**与分镜 `shots` 同构的对象**，再喂给既有出口。
3. 编译分两个纯函数，各司其职：
   - `compileDirectorPrompt(scene, { zh })`（v0 已有）：给人看的"布景说明 + 人偶→真人"提示词块，写入图片节点 `data.prompt`；
   - `directorSceneToShot(scene)`（C 阶段新增）：把布景编译成一个 shot 对象，字段只用既有镜头字段（`visual` / `motion` / `duration` / `characters` / `scene` / `props` / `sfx` / `dialogue` / `tail` / `cam` / `seg`）。
4. 既有镜头字段归一规则（`visual/motion/tail/cam/start/seg/characters/scene/props/duration/dialogue/sfx` 之外的键会被丢弃）意味着：**导演台的景别/机位信息必须写进 `visual`，运镜/时长写进 `motion` 与 `duration`**，不能寄望新字段。

### 4.6 `directorSceneToShot` 的映射口径（C 阶段验收依据）

| shot 字段 | 从布景怎么来 | 判据 |
|---|---|---|
| `visual` | 景别 + 机位高度（由 `pos.y` 与 `target.y` 比较：低机位仰拍/平视/高机位俯拍）+ 主体站位（`pos.x`/`pos.z` 映射画面左中右/远近）+ 朝向（`rotY`）+ 光照方向 | 不含 `shotSize`/`cameraMove` 等枚举 id，中文/英文可读 |
| `motion` | 运镜标签（8 种：static/push_in/pull_out/pan_left/pan_right/orbit_left/orbit_right/handheld）+ "人偶必须画成真人"要求 | 有起点与终点语义（"从…到…"） |
| `duration` | `scene.shot.duration` | 0.3 ≤ d ≤ 30，一位小数 |
| `characters` | `objects` 中 `kind === 'actor'` 的名字 | 与设定集名称一致或为空数组 |
| `scene` | 布景标题 / 用户填的场景名 | 字符串 |
| `sfx` | v1 留空（导演台不生成音效） | 空字符串 |
| `tail` / `cam` / `seg` | C2 阶段再接（需要时间轴/多镜头时） | 初期不写 |

---

## 五、阶段划分与验收判据

原则：**每个阶段独立可验收**；任何阶段都不改动既有 41 项门禁的断言，只能追加测试。

### Phase A：决策文档（本文）

| 判据 | 怎么验 |
|---|---|
| 文档存在且 400–700 行 | `node -e "console.log(require('fs').readFileSync('docs/director-3d.md','utf8').split('\n').length)"` |
| 引用自查 100% 命中（或逐条标注"待核/未命中"） | 本文附录 C，由脚本对 `client.js` / `index.js` / `package.json` / `check-pack.mjs` 逐个标识符检索生成 |
| 许可分析可复核 | 对照参考项目 `LICENSE` Part A 第 2、4、5 条逐条引用要点 |
| 不含参考项目代码/伪代码 | 全文无其函数名、类型名（概念语义除外）、无源码片段 |

### Phase B1：数据契约与持久化（不换渲染内核）

| # | 验收判据（可写成断言） |
|---|---|
| 1 | 新建导演台节点后，`projectsGet` 读回的项目文档里该节点 `data.directorScene.version === 1` |
| 2 | `JSON.stringify(scene)` 不含 `blob:` / `data:` / 函数 / DOM（源码级 + 运行期双断言） |
| 3 | 关闭面板 → 重开面板：场景对象数、机位参数、镜头设置完全一致（深比较） |
| 4 | 页面重载（重新 `projectsGet`）后场景仍在（证明进了 `canvas.db`，不是只存 localStorage） |
| 5 | 删除该节点后重新读文档：`directorScene` 不再存在 |
| 6 | v0 迁移：项目里有 `dsh-ic:director:<pid>` 草稿、无 director 节点时打开导演台 → 自动建节点承接内容，草稿键被删除 |
| 7 | 体积预算：默认场景序列化 ≤ 8 KB；构造 50 对象场景后序列化 ≤ 64 KB，否则给用户提示 |
| 8 | 拖动对象过程中**不产生**节点文档写入（可用 `flushSave` 调用计数或文档 `ts` 变化次数断言）；pointerup 后 1 次写入 |
| 9 | `scripts/test-director-stage.mjs` 已收录进 `scripts/regress.mjs` 清单（当前 41 项），且 B1 新增的数据契约断言并入该脚本后仍绿；`node scripts/regress.mjs --list` 可见 |

### Phase B2：渲染内核切换（路线 A + 回退）

| # | 验收判据 |
|---|---|
| 1 | `plugin-asset` 路由对 `.mjs` 返回 `content-type: text/javascript; charset=utf-8`（用 `curl -I` 或 Node `fetch` 断言） |
| 2 | 浏览器控制台执行 `import('/infinite-canvas/api/plugin-asset?rel=assets/vendor/three-0.186.1.core.min.mjs')` 成功，返回对象含 `THREE.WebGLRenderer` |
| 3 | 打开导演台：视口非空（像素多样性断言），有网格地面、2 个人偶、机位辅助线 |
| 4 | 拖动方块 X 轴 → `data.directorScene.objects[i].pos.x` 变化；pointerup 后 1 次落库 |
| 5 | 切换机位 / 改 FOV → 画面像素签名变化 |
| 6 | 截图：PNG 宽度 ≥ 1280、`saveAssetRecord` 返回 `rec.id` 非空、画布新增 `image` 节点且 `data.assetId === rec.id` |
| 7 | **回退**：模拟 `canvas.getContext('webgl2') === null` 或 `import()` 失败 → 导演台仍能打开并用 v0 软光栅渲染（不崩、可导出） |
| 8 | vendored 产物 provenance 完整：`assets/vendor/README.md` 记录版本/命令/SHA256；`three-0.186.1.LICENSE.txt` 随包；`check-pack.mjs` 通过（`ALLOWED`/`REQUIRED` 已补） |
| 9 | `scripts/audit.mjs`、`scripts/smoke-render.mjs`、`scripts/test-director-stage.mjs` 全绿 |

### Phase C：接进视频生成

| # | 验收判据 |
|---|---|
| 1 | C1（零代码即可用）：导演台截图生成的 `image` 节点连到 `video` 节点的 `frame` 端口后，视频节点提示词包含首帧锚定行（既有 `frameAnchorText` 行为），视频生成成功 |
| 2 | C2：`directorSceneToShot(scene)` 返回的 shot 进入既有 `shots` 数组后，`buildStructuredVideoPrompt([shot], refs, bible, {})` 返回非空且含 `<Subject N>` 绑定（不新增第二套提示词出口） |
| 3 | C2：shot 的 `visual` 不含枚举 id（`shotSize`/`cameraMove` 等原样字样），含景别/机位高度/站位/朝向 |
| 4 | 导演台编译出的提示词保留"人偶必须画成真人、颜色只用于识别站位"的硬要求（`scripts/test-director-stage.mjs` 已有同类断言，扩展到 shot） |
| 5 | 全量门禁（当前 41 项，含导演台测试）`node scripts/regress.mjs` 全 PASS；`--strict` 下条件用例缺前置时按既有语义计失败 |

### 每阶段都不动的东西

- 不删、不放宽 `scripts/regress.mjs` 清单里任何既有脚本的断言；
- 不改 `scripts/audit.mjs` 的检查项（新增 i18n 键/类型自然被它覆盖，但不放松规则）；
- 不改 `saveAssetRecord` / 资产表结构 / `canvas.db` schema；
- 不改 `buildStructuredVideoPrompt` 的输入输出契约；
- 不改左侧图标列既有 6 个节点按钮、资产/设定集/运行按钮的既有行为（只**追加**导演台入口）。

---

## 六、风险与不做的事

### 6.1 明确不做

**三句硬话先写在前面：① 不做骨骼动画 / GLB 角色；② 不做实时渲染视频（只导截图，视频仍交厂商）；③ 不动现有门禁（当前实测 41 项）的任何断言。** 完整清单如下：

| 不做 | 原因 |
|---|---|
| **骨骼动画 / GLB 角色** | 需要 GLTFLoader + 蒙皮 + IK 求解 + 骨骼重定向（参考实现用了 SkeletonUtils 与自带 actor 资源），是另一个量级；v1 用"程序化人偶"表达站位即可，成片人物由视频模型生成 |
| **实时渲染视频** | 导演台只负责"取景 + 截图"；视频仍交给厂商模型（画布既有链路）。实时渲染要编码器、帧同步、音画对齐，收益低 |
| **关键帧/时间轴动画** | v1 只做单帧摆位 + 运镜标签；轨迹动画留给后续（C2 之后再评估） |
| **复制参考实现代码** | 许可见第一节；测试里已有反向断言兜底 |
| **引入 npm 依赖** | 插件无构建步骤；three 只以"预构建静态产物"形式 vendored，`client.js` 不出现 `require('three')` |
| **改动既有门禁断言** | 当前 `regress.mjs` 实测 41 项（条件 3 项）；只能追加。任务书提到的"38 项"是旧口径，以 `--list` 实时输出为准 |
| **把参考项目路径写进任何构建脚本/依赖** | 参考仓库只读、不入包、不进构建 |

### 6.2 风险表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 许可误用 | 法务风险、被迫下架 | 第一节规则 + 测试反向断言 + 只借鉴设计 |
| 743 KB 体积 | 仓库变大、远程部署首开变慢 | 导演台按需 `import()`；gzip 后约 186 KB；产物体积写入 checkpoint |
| MIME 未补 | 动态 import 直接失败（页面报错） | B2 第一件事改 `MIME_BY_EXT`；门禁用 `fetch` 头断言锁死 |
| 宿主 CSP 不允许动态 import | 路线 A 无法加载 | **待核**；回退 v0；必要时改为"宿主注入脚本"方案（另议） |
| Canvas2D 软光栅遮挡穿帮 | 误导数视频模型理解空间关系 | B2 切 WebGL（真实深度缓冲）；过渡期在提示词里写明"以机位关系为准" |
| 节点文档膨胀/推送频繁 | 每 450ms 全量推 doc，场景大时卡顿 | 只在显式操作后写；体积预算 + 用户提示；坐标 3 位小数 |
| UI-RULES 顺序冲突 | 违反已验收约束 | 合并前更新 `docs/UI-RULES.md` 第 12 条（需产品确认） |
| three 版本升级漂移 | 渲染行为变化、产物哈希失效 | 文件名带版本号；升级 = 重建 + 更 README + 全量门禁 |
| 门禁膨胀 | 每次提交变慢 | 导演台测试保持纯函数 + 假 DOM，不引入真实浏览器依赖 |
| 低端机 WebGL2 不可用 | 导演台打不开 | 回退 v0；启动时探测 `getContext('webgl2')` |

### 6.3 门禁纪律（写进 PR 检查单）

1. 提交前：`node scripts/audit.mjs`、`node scripts/smoke-render.mjs`、`node scripts/test-director-stage.mjs`、`node scripts/check-pack.mjs`、`node scripts/regress.mjs` 全绿；
2. 新增测试只能追加到 `regress.mjs` 清单，禁止删除/跳过；
3. 任何门禁本身的放宽（白名单、断言删除）必须在提交说明里单列理由，并由 PM 确认；
4. 涉及 `assets/vendor/` 的提交，必须同时更新 `assets/vendor/README.md` 的哈希记录。

---

## 七、待核清单（写进代码前必须验证）

| # | 待核项 | 怎么核 | 阻塞阶段 |
|---|---|---|---|
| 1 | 宿主 CSP 是否允许 `import()` 加载同源 `/api/plugin-asset` 脚本 | 真实宿主页面控制台执行 `import(url)`；查看响应头与 console 报错 | B2 |
| 2 | `text/javascript` 是否需要 `charset` 参数（ESM 严格 MIME） | 修 MIME 后实测 `import()`；两种写法各试一次 | B2 |
| 3 | `plugin-asset` 是否可被 `import()` 直接使用（不是 `<script>`） | 用最小 ESM 文件做冒烟（不许直接上 743 KB） | B2 |
| 4 | 离屏截图在 WebGL 下的可靠性（`preserveDrawingBuffer` vs 同帧读取） | 在 Chrome/Edge/Safari 三端各截 10 张，比对非空与内容一致 | B2 |
| 5 | 1280×720 PNG 的实际体积 | 实测纯色/复杂场景各 5 张，统计均值（预算：单张 ≤ 800 KB） | B1 |
| 6 | WebGL2 在目标用户群的可用率 | 无遥测，只能灰度观察；结论：以回退兜底为准 | B2 |
| 7 | `docs/UI-RULES.md` 第 12 条图标顺序如何改（放哪一位） | 与 PM/设计确认；本文建议放在"设定集"与"运行工作流"之间（当前实现即此位置） | B1 |
| 8 | 新 `director` 节点类型对布局测试的影响（`test-node-layout.mjs`/`test-panel-layout.mjs` 是否有类型白名单断言） | 读两个测试脚本确认；若有白名单需同步补 | B1 |
| 9 | v0 草稿迁移的边界：多项目、草稿损坏、并发打开 | 构造 3 组用例（正常/损坏/多项目）做迁移断言 | B1 |
| 10 | 参考实现的 5 种开局模板是否都要复刻 | 产品决策；v1 建议只做"空场景 / 单人 / 双人"三种，其余按需 | B1 |

---

## 附录 A：坐标、单位与约定

| 约定 | 取值 | 依据 |
|---|---|---|
| 坐标系 | Y 轴向上，右手系；地面 `y = 0` | v0 渲染代码的人偶/几何体都以 `pos.y` 为脚底高度 |
| 单位 | 米；人偶身高约 1.7 m；机位常见高度 1.5–1.8 m | v0 默认场景（`pos.y: 1.7` 的机位、`y: 1.1` 的注视点） |
| 旋转 | 仅绕 Y 轴（`rotY`，弧度） | v0 对象模型只有 `rotY` |
| 机位 | `pos` + `target` + `fov`（度）；高度关系由 `pos.y` 与 `target.y` 比较得出 | v0 `compileDirectorPrompt` 的仰拍/平视/俯拍判定阈值：`< tgtY-0.35` 仰、`> tgtY+0.9` 俯 |
| 画幅 | 截图固定 16:9（1280×720，B2 可选 1920×1080） | v0 `exportShot` |
| 颜色 | 对象 `color` 只用于"站位身份映射"，不得画进成片 | v0 `compileDirectorPrompt` 的硬要求 + 测试断言 |

## 附录 B：构建与校验命令速查

```bash
# 1) 构建 vendored three（在 _tmp 之类临时目录，不污染仓库）
npm i three@0.186.1 esbuild@0.28.2
npx esbuild entry-core.mjs --bundle --minify --format=esm --legal-comments=eof \
  --outfile=three-0.186.1.core.min.mjs

# 2) 记录体积与哈希
node -e "const b=require('fs').readFileSync('three-0.186.1.core.min.mjs'),z=require('zlib'),c=require('crypto');
console.log(b.length, z.gzipSync(b,{level:9}).length, c.createHash('sha256').update(b).digest('hex'))"

# 3) 运行时自检（B2 之后）
node scripts/test-director-stage.mjs
node scripts/audit.mjs
node scripts/smoke-render.mjs
node scripts/check-pack.mjs
node scripts/regress.mjs --list        # 确认导演台测试已在清单里（应为 41 项）
node scripts/regress.mjs               # 全量门禁
```

## 附录 C：引用自查（代码现状核对）

> 生成方式：Node 脚本读取 `client.js` / `index.js` / `package.json` / `scripts/check-pack.mjs` / `scripts/regress.mjs` / `docs/UI-RULES.md`，对本文引用的每个标识符做一次字面检索。
> 结果口径：**命中** = 该标识符在对应文件里出现；**未命中** = 不存在或已改名（此时必须修正正文，或标注"待核"）。
> 行号是自查时刻的实测值，取该字符串在文件中的**首次出现位置**（同名字符串可能先出现在注释或 i18n 键里）；随并行改动漂移，**以标识符为准**。

| # | 被核对的标识符 / 断言 | 文件 | 结果 | 实测行号 | 备注 |
|---|---|---|---|---|---|
| 1 | `__ModuleLoader__.load` | client.js | ✓ 命中 | 1 |  |
| 2 | `require('react')` | client.js | ✓ 命中 | 4 |  |
| 3 | `const PORTS =` | client.js | ✓ 命中 | 47 |  |
| 4 | `TYPE_LABEL` | client.js | ✓ 命中 | 42 |  |
| 5 | `TYPE_KIND` | client.js | ✓ 命中 | 42 |  |
| 6 | `function newNode(` | client.js | ✓ 命中 | 7963 |  |
| 7 | `function addNodeAt(` | client.js | ✓ 命中 | 8005 |  |
| 8 | `NODE_W =` | client.js | ✓ 命中 | 29 |  |
| 9 | `NODE_H =` | client.js | ✓ 命中 | 30 |  |
| 10 | `const ICONS =` | client.js | ✓ 命中 | 9466 |  |
| 11 | `function IconRail()` | client.js | ✓ 命中 | 13091 |  |
| 12 | `'open-director'` | client.js | ✓ 命中 | 13128 |  |
| 13 | `Ic('camera', 16)` | client.js | ✓ 命中 | 13130 |  |
| 14 | `function DirectorStage(` | client.js | ✓ 命中 | 12812 |  |
| 15 | `directorOpen` | client.js | ✓ 命中 | 7728 |  |
| 16 | `directorSel` | client.js | ✓ 命中 | 427 |  |
| 17 | `directorTool` | client.js | ✓ 命中 | 7730 |  |
| 18 | `function directorDefaultScene(` | client.js | ✓ 命中 | 12385 |  |
| 19 | `function directorLookAt(` | client.js | ✓ 命中 | 12361 |  |
| 20 | `function directorProject(` | client.js | ✓ 命中 | 12375 |  |
| 21 | `function directorActorFaces(` | client.js | ✓ 命中 | 12485 |  |
| 22 | `function directorObjectFaces(` | client.js | ✓ 命中 | 12555 |  |
| 23 | `function directorShadeColor(` | client.js | ✓ 命中 | 12577 |  |
| 24 | `function directorRenderScene(` | client.js | ✓ 命中 | 12589 |  |
| 25 | `function directorPickObject(` | client.js | ✓ 命中 | 12702 |  |
| 26 | `function compileDirectorPrompt(` | client.js | ✓ 命中 | 12758 |  |
| 27 | `function loadStageDoc(` | client.js | ✓ 命中 | 12409 |  |
| 28 | `function saveStageDoc(` | client.js | ✓ 命中 | 12427 |  |
| 29 | `function directorDocKey(` | client.js | ✓ 命中 | 12407 |  |
| 30 | `const LS_DIRECTOR =` | client.js | ✓ 命中 | 12347 |  |
| 31 | `const DIRECTOR_VERSION =` | client.js | ✓ 命中 | 12348 |  |
| 32 | `__DSH_IC_DIRECTOR__` | client.js | ✓ 命中 | 15926 |  |
| 33 | `function saveAssetRecord(` | client.js | ✓ 命中 | 4086 |  |
| 34 | `function pushHistory(` | client.js | ✓ 命中 | 7863 |  |
| 35 | `function flushSave(` | client.js | ✓ 命中 | 7756 |  |
| 36 | `function scheduleSave(` | client.js | ✓ 命中 | 7751 |  |
| 37 | `function hydrateCanvasFromHost(` | client.js | ✓ 命中 | 2610 |  |
| 38 | `function buildStructuredVideoPrompt(` | client.js | ✓ 命中 | 3449 |  |
| 39 | `function frameAnchorText(` | client.js | ✓ 命中 | 3149 |  |
| 40 | `dshic-studio-overlay` | client.js | ✓ 命中 | 1708 |  |
| 41 | `dshic-dir-modal` | client.js | ✓ 命中 | 1727 |  |
| 42 | `DIRECTOR_SHOT_SIZES` | client.js | ✓ 命中 | 12735 |  |
| 43 | `DIRECTOR_MOVES` | client.js | ✓ 命中 | 12743 |  |
| 44 | `setTimeout(flushSave, 450)` | client.js | ✓ 命中 | 7754 |  |
| 45 | `const LS_GRAPH =` | client.js | ✓ 命中 | 15 |  |
| 46 | `hostRpc('projectsPut'` | client.js | ✓ 命中 | 2789 |  |
| 47 | `'image/png'` | client.js | ✓ 命中 | 4089 |  |
| 48 | `1280` | client.js | ✓ 命中 | 4956 |  |
| 49 | `require('three')` | client.js | ✓ 符合（不存在） | — | 反向断言：不得引入 npm 依赖 |
| 50 | `from 'three'` | client.js | ✓ 符合（不存在） | — | 反向断言：不得引入 npm 依赖 |
| 51 | `DirectorScene` | client.js | ✓ 符合（不存在） | — | 反向断言：参考实现专有标识符 |
| 52 | `DirectorCamera` | client.js | ✓ 符合（不存在） | — | 反向断言：参考实现专有标识符 |
| 53 | `directorPoseBoneDeltas` | client.js | ✓ 符合（不存在） | — | 反向断言：参考实现专有标识符 |
| 54 | `applyDirectorRigPose` | client.js | ✓ 符合（不存在） | — | 反向断言：参考实现专有标识符 |
| 55 | `quaternius` | client.js | ✓ 符合（不存在） | — | 反向断言：参考实现专有标识符 |
| 56 | `const NAME = 'infinite-canvas'` | index.js | ✓ 命中 | 17 |  |
| 57 | `plugin-asset` | index.js | ✓ 命中 | 3955 |  |
| 58 | `const MIME_BY_EXT =` | index.js | ✓ 命中 | 964 |  |
| 59 | `function mimeOf(` | index.js | ✓ 命中 | 970 |  |
| 60 | `'application/octet-stream'` | index.js | ✓ 命中 | 972 |  |
| 61 | `'cache-control'` | index.js | ✓ 命中 | 3705 |  |
| 62 | `ctx.webServer.register` | index.js | ✓ 命中 | 3663 |  |
| 63 | `async function projectsPut(` | index.js | ✓ 命中 | 1135 |  |
| 64 | `function ensureSchema(` | index.js | ✓ 命中 | 238 |  |
| 65 | `doc TEXT` | index.js | ✓ 命中 | 243 |  |
| 66 | `canvas.db` | index.js | ✓ 命中 | 188 |  |
| 67 | `function safeJoin(` | index.js | ✓ 命中 | 955 |  |
| 68 | `js:` | index.js | ✓ 符合（不存在） | — | MIME_BY_EXT 当前缺 js 键（B2 待补） |
| 69 | `mjs:` | index.js | ✓ 符合（不存在） | — | MIME_BY_EXT 当前缺 mjs 键（B2 待补） |
| 70 | `Apache-2.0` | package.json | ✓ 命中 | 19 |  |
| 71 | `@ninkch/dsh-infinite-canvas` | package.json | ✓ 命中 | 2 |  |
| 72 | `"docs/*.md"` | package.json | ✓ 命中 | 46 |  |
| 73 | `"assets/*/SKILL.md"` | package.json | ✓ 命中 | 42 |  |
| 74 | `"assets/support/*"` | package.json | ✓ 命中 | 43 |  |
| 75 | `const REQUIRED =` | scripts/check-pack.mjs | ✓ 命中 | 18 |  |
| 76 | `const ALLOWED =` | scripts/check-pack.mjs | ✓ 命中 | 38 |  |
| 77 | `assets\/support\/[A-Za-z0-9._-]+` | scripts/check-pack.mjs | ✓ 命中 | 38 |  |
| 78 | `assets\/[a-z0-9-]+\/SKILL\.md` | scripts/check-pack.mjs | ✓ 命中 | 38 |  |
| 79 | `test-director-stage.mjs` | scripts/regress.mjs | ✓ 命中 | 71 | 门禁清单已收录 |
| 80 | `文本 / 剧本 / 分镜表 / 图片 / 视频 / 成片 / 资产 / 设定集 / 运行工作流` | docs/UI-RULES.md | ✓ 命中 | 25 |  |

事实性断言：

| 断言 | 结果 | 说明 |
|---|---|---|
| 门禁项数 = 41（实测 `regress.mjs --list`） | ✓ 成立 | 实测 41 项 |
| 门禁清单包含导演台测试 | ✓ 成立 | 已收录 |
| package.json version = 0.18.7 | ✓ 成立 | 当前版本 |
| three 为 MIT（npm 包内 LICENSE 1,081 B） | ✓ 成立 | 已核对 |
| 导演台测试脚本存在 | ✓ 成立 |  |
| 本文存在且行数在 400–700 | ✓ 成立 | 实测 578 行（含本表） |

**自查通过率：80/80（100.0%）**；事实性断言 6/6 成立。

---

## 附录 D：决策记录（供后续变更追溯）

| 决策 | 结论 | 理由 | 可回退性 |
|---|---|---|---|
| 是否复制参考实现 | 不复制 | 许可不兼容（第一节） | 不可逆（法律） |
| 是否引 npm 依赖 | 不引；three 以 vendored 静态产物形式引入 | 单文件无构建约束；`client.js` 保持零依赖 | 可回退（删 vendor 目录即可） |
| 渲染内核 | 路线 A（WebGL）为目标态，v0 软光栅为回退 | 可信取景需要真实深度/光照 | 可回退（接口不变） |
| 场景持久化 | 节点 `data.directorScene`（新增 `director` 节点类型） | 顶层 doc 字段会被裁；节点 data 是唯一可靠载体 | 中（节点类型一旦发布，迁移需脚本） |
| 提示词编译 | 新建 `directorSceneToShot`，复用既有视频提示词出口 | 避免两套厂商提示词格式 | 可回退（纯函数） |
| 截图产物 | 复用 `saveAssetRecord` + 图片节点 | 不建第二套存储；自动继承 @引用/参考图/调色能力 | 不可逆（已落库资产兼容） |
