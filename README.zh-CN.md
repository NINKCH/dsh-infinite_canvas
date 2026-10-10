# 无限画布（DeepSeek Harness 版）

**DeepSeek Harness 内的节点式短剧工作室。** 从一句话创意出发，在无限画布上完成剧本、分镜、角色资产、画面生成、视频生成，直到带转场、字幕、配音的成片。

[English](./README.md) | 简体中文

<!-- 徽标位：发布后在顶部添加 CI / npm / license 徽标 -->

## 这是什么？

无限画布是一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件：它在 Web 界面左侧栏加入一个完整的创作工作室。你不需要在对话里反复描述需求，而是像导演一样工作——无限画布上的节点连成流水线：剧本、分镜、角色与场景资产、图片生成、视频生成，最终在成片节点完成转场、字幕与配音。

全部本地运行于你的 Harness。生成后端自带或自配均可；未配置任何 API 时有内置演示模式，整条流水线离线可学可测。

## 工作方式

```mermaid
flowchart LR
    A[剧本节点<br>AI 编剧] --> B[分镜表节点<br>AI 拆分镜]
    B --> C[铺开到画布<br>1 镜 = 1 组节点]
    C --> D[图片生成<br>多参考图]
    D --> E[视频生成<br>首帧 + 参考图]
    E --> F[成片<br>转场 · 字幕 · 配音]
    F --> G[导出<br>WebM 预览 / FilmCraft MP4]
```

## 核心亮点

### 角色一致，跨镜跨集
项目级**设定集**（风格基调 + 角色/场景/道具卡）会注入每一次 AI 调用，服装、场景、道具在镜头之间、剧集之间保持一致。每次生成分镜后，本地一致性检查会标出尚未登记的名称。

### 参考图真正"绑定"
参考图以**有序、可见**的列表接入——`[图1] 角色：林宁`、`[图2] 场景：老屋`——这个顺序就是发给模型的顺序。多角色画面不再混淆；火山引擎 **Seedance** 的原生 `[图N]` 约定全链路支持（首帧、最多 4 张参考图、官方任务 API）。

### 从分镜到能看的成片
**成片节点**按顺序拼接分镜视频——叠化/黑场转场、字幕烧录、原声与 TTS 配音混音——即时导出预览版。要做真正的后期，一键把 **FCP7 XML 时间线 + SRT** 写到磁盘，交给 [ArtCraft](#artcraft-桥接)（FilmCraft）渲染成 MP4。

### 剪辑器级画布
平移缩放、框选、对齐参考线、可折叠分组、小地图、60 步撤销重做、节点媒体历史（最近 8 次）、蒙版局部重绘——画布的手感应该是剪辑软件，而不是聊天侧栏。

### 模型自带
文本模型直接用 Harness 配置（无需额外 Key）。图片、视频、TTS 后端支持**多配置**——配任意多个接口、设默认、节点上按需选择。什么都没配？演示模式在本地合成占位图与动画视频，整条流水线离线可跑。

## 快速开始

1. 安装插件（bundle 目录），重启一次 Harness。
2. 点左侧栏的 **无限画布** 按钮。
3. 加一个 **剧本** 节点，输入一句话创意，点 *AI 生成剧本*。
4. 连到 **分镜表** 节点 → *AI 生成分镜* → *铺开到画布*。
5. 给占位资产节点上传角色图，点 *运行工作流*，再打开 **成片** 节点导出。

> 未配置任何生成 API 时，每一步都走演示模式——整条流水线离线可用。

## 生成后端

| 类型 | 协议 | 说明 |
|---|---|---|
| 文本 | Harness LLM 服务 | 剧本与分镜写手；可选任意已配置模型，节点上可覆盖 |
| 图片 | OpenAI 兼容 `/images/generations`，多参考走 `/images/edits` | 清晰度（1K/2K/4K）× 比例；蒙版重绘走 `edits` + PNG 蒙版 |
| 视频 | 通用提交+轮询，或 **火山 Seedance 官方任务** | 时长 4–10s、480P/720P/1080P、比例、首帧、最多 4 张参考图 |
| TTS | OpenAI 兼容 `/audio/speech` | 逐段配音，混入成片 |

## ArtCraft 桥接

安装配套的 [`dsh-artcraft`](../dsh-artcraft/README.md) 插件后，画布通过同源 HTTP 调用本地 **PhotoCraft / FilmCraft / EffectCraft** 工具链：资产同步到按项目隔离的数据目录，图片走 PhotoCraft 无头调色（单张或批量），成片导出 FCP7 XML + SRT 交给 FilmCraft 渲染 MP4。状态灯、优雅降级与完整契约见 [`docs/artcraft-handoff.md`](./docs/artcraft-handoff.md)。

## 发布（维护者）

发布走 **npm Trusted Publishing**（OIDC）——不依赖任何 npm 令牌：

- **Release 流程**：GitHub 仓库创建 Release（tag `v0.17.0`…）→ Actions 自动发布该版本。
- **手动流程**：仓库 → Actions → *publish* → Run workflow → 输入版本号。
- `publish.yml` 从 release tag（或手动输入）解析版本号，发布时带 `provenance` 徽标。

## 数据与隐私

- 画布文档、项目、设置与设定集存于浏览器 `localStorage`（`dsh-ic:*`）；资产存于 IndexedDB（`dsh-infinite-canvas`）。
- AI 文本经 Harness 宿主进程调用（使用你已配置的模型，无需额外 Key）。
- 图片/视频/TTS 请求由浏览器直连你配置的地址——请注意 CORS 与密钥保管。
- 插件自身不向任何第三方上传数据。

## 环境与限制

- DeepSeek Harness 0.2.0-rc.2+；演示视频导出依赖 MediaRecorder（Chromium）。
- 预览成片为实时录制的 WebM；要多轨精修的 MP4 母版，请配合 ArtCraft FilmCraft 或任意非线性编辑软件。
- 图片 `edits`/蒙版重绘需要模型支持该端点（如 gpt-image-1）。
- 插件 Host 半侧更新需重启一次 Harness；网页半侧热更新。

## 许可

Apache-2.0
