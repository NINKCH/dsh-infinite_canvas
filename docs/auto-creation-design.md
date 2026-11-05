# 多智能体自动创作 — M3 实施设计（0.20.0）

> 状态：**待 M0 真机验证**。本文档是可直接落地的实施方案：`productionCapabilities.multiAgent === true`
> 确认后，按 §3 粘贴预设、按 §4 落地 runner。若 `multiAgent === false`，整个 M3 保持休眠，
> 不影响 M1（阶段机）与 M4 数据面（预算/批准）——它们已经上线且默认关闭。

## 0. 前置事实（已验证）

| 事实 | 来源 |
|---|---|
| 宿主 0.2.1-rc.3 在 superagent 的 peer 范围内 | 本机 `runtime.json` |
| 第三方 bundle 可注入 `agents` / `sessionController` / `sessionPersistence` / `permissionPresets` | superagent `src/index.ts` 的 `inject` |
| 会话创建带 `agentPreset` 参数；预设 = patch 里的 `@deepseek-ai/dsh-agent-preset` 实例 | superagent `src/app/sessions.ts` `ensure()` |
| 本插件懒探测（`ctx.get`，不加 `inject`）与宿主握手的安全模式 | 本插件 `wsSessionContext` 同款 |

## 1. 铁律（贯穿所有角色）

1. **流程规范 ≠ 内容模板**：角色章程只写"怎么工作"，绝不写"写什么故事"。
2. **用户显式指令 > 一切流程**：所有闸门都有 override + 审计。
3. **一次一个具体问题**：只有监制可以问用户（`human_action` 语义），其余角色只对监制报告。
4. **诚实交付**：草稿就是 blocked；"完成"必须由 `canvas_production_status.ready:true` 支撑。
5. **窄启动**：先跑免费段（到分镜+预算单），批准令牌到手才进付费段。

## 2. 角色与工具矩阵

| 角色 | 预设 id | 职责 | 工具 | 禁止 |
|---|---|---|---|---|
| 监制 | `ic-producer` | 收 brief、派工、推进阶段、预算与批准流转 | canvas 只读 + production 工具 + 提问 | 写任何内容 |
| 调研 | `ic-researcher` | 热门题材/风格/平台惯例，带来源与日期 | tool-web（搜索）、todo | 画布写 |
| 编剧 A/B | `ic-writer-a` / `ic-writer-b` | 独立提案 → 互评 → 按决策定稿 | 画布写 bible/剧本、todo | 建生成节点、触发付费 |
| 分镜 | `ic-storyboarder` | 剧本 → 场景 → 分镜表（必须过 G2） | 画布写分镜 | 触发视频 |
| 生成 | `ic-generator` | 建图/视频节点并触发（仅批准后） | 画布全量 | 跳过闸门 |
| 质检 | `ic-qc` | 一致性/接缝/口型/术语复核 → ready/blocked | 只读 + production | 写 |

## 3. 预设 YAML 草案（M0 通过后粘贴进 `cordis.patch.yml` 的 `insert:` 列表）

> 通用骨架（每个角色复制改 4 处：id / name / description / persona 正文）。
> 只挂**已在本机宿主出现过的插件**（persona / agent-instructions / time-context /
> skill-filesystem / tool-skill / tool-web / tool-todo）——M0 时逐一 `ctx.get()` 探测，
> 缺哪个就从对应预设里删哪行（探测清单见 §5）。

```yaml
    - id: preset-ic-producer
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ic-producer
        name: 自动创作·监制
        description: 多智能体自动创作专用（实验）：只路由与决策，不写内容。由「自动创作」按钮创建，勿手动选择。
        order: 90
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你是自动创作流水线的监制（producer）：接收用户的一句话创意，把它拆成工单派给
                调研/编剧/分镜/生成/质检各角色，推进制作阶段（canvas_production_status 驱动），
                管理预算与批准令牌。你**不写任何创作内容**：提案、剧本、分镜、提示词都由对应角色产出。
                纪律：
                - 一次只向用户问一个具体问题；其余决策在角色内部完成并记录理由。
                - 每个阶段推进前先看 canvas_production_status；blockers 未清零不推进。
                - 付费生成只在 autoApprove 通过后开始；批准过期立即停下重新要预算。
                - 讨论决策必须写进画布（会议记录文本节点 + canvas_update_bible），不留只在对话里的决定。
                - 流程只规定顺序，绝不规定剧情；创意取舍以用户 brief 为唯一源头。
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
```

> 其余六个角色同骨架，差异：
> - `ic-researcher`：追加 `@deepseek-ai/dsh-tool-web`（fetch:false，只留搜索）；persona 强调
>   「每条结论必须带来源 URL + 日期；拿不到来源就写"未证实"，绝不编造趋势」。
> - `ic-writer-a` / `ic-writer-b`：persona 为「编剧」章程——第一轮各自独立提案（logline + 3 节拍），
>   互不可见；第二轮互相批评（冲突强度 / 动机可信 / 成本可行性，各 ≤3 条）；定稿由监制决策，
>   你只执行；把世界观/角色写进 canvas_update_bible，剧本写进剧本节点 idea（生成由节点完成）。
> - `ic-storyboarder`：persona 为「分镜师」——每场一个分镜表、`tail→prev` 串联、四字段必写；
>   生成前用 canvas_production_status 确认 G2 通过。
> - `ic-generator`：persona 为「生成执行」——只做 canvas_create_node/generate_node；
>   开跑前必须确认 autoStatus 的 approval.valid === true；绝不重试超过 2 次，失败如实报告。
> - `ic-qc`：persona 为「质检」——只读画布 + production_status，复核一致性告警/接缝/口型/术语；
>   结论只能是 ready / blocked（附逐条证据）。

## 4. Runner（宿主侧，`production.js` 旁新增 `autorun.js`）

```
autoStart({projectId, canvasId, brief})
  1. autoEnabled() && caps.multiAgent，否则拒绝
  2. 阶段必须在 brief/storyboard 之前或明确返工；否则拒绝
  3. 建「第X集-编剧室会议」文本节点（讨论记录载体）
  4. 派工序列（串行，单会话逐轮 prompt）：
     researcher → writerA(提案) → writerB(提案) → writerA(评B) → writerB(评A)
     → producer(决策落盘) → storyboarder(逐场) → [G2] → autoQuote → 停，等批准
  5. 每轮产物：追加进会议节点 + canvas_update_bible / 剧本 idea / 分镜表
autoResume({projectId, canvasId})   // 批准后：generator → qc → 交付
autoAbort({projectId, canvasId})    // 取消在跑会话；保留已产出内容
```

- 会话适配层：`sessionEnsure(id, cwd, title, presetId)` / `sessionPrompt(id, text)`，内部
  `ctx.get('sessionController')`（缺则 `ctx.get('agents')`）；**测试注入 fake**（test-auto.mjs）。
- 每轮 prompt ≤ 2000 字：只发任务卡 + 上一轮产物的**引用**（节点 id / 文件路径），不复制全文。
- 轮次上限：互评 2 轮；任一角色连续 2 次失败 → 整体 blocked + 如实通知。
- 运行记录：`production/<cid>.json` 增加 `runs[]`（每轮 {role, at, summary, artifactRefs}）。

## 5. M0 真机验证清单（重启 Harness 后执行）

1. `POST /infinite-canvas/api/rpc {"method":"productionCapabilities"}` → `multiAgent` 值。
2. 若 true：逐个探测服务存在性：`sessionController` / `agents` / `sessionPersistence` / `permissionPresets`。
3. 用最小 patch 插入**一个**试验预设（ic-producer），重启确认插件加载成功（audit/regress 不红）。
4. 手动建一个 ic-producer 会话，确认工具面与 persona 生效。
5. 全部通过 → 按 §3 铺开七个预设 + §4 runner。

## 6. 回退

- `multiAgent === false`：M3 整体不激活；开关打开时 UI 显示「宿主不支持会话派生（需升级/重启）」。
- 预设插入导致加载失败：从 patch 移除该预设即回退（预设是纯声明，无代码耦合）。
