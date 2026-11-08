# 无限画布 Infinite Canvas（VS Code / CodeBuddy / Trae / Cursor 通用壳）

一个 VSIX 同时覆盖四家 VS Code 系宿主的「无限画布」插件壳。扩展在启动时做**能力探测**，
按宿主实际 API 面自动选择工具通道；画布 UI 经 WebviewPanel 内嵌 iframe 承载（本机 HTTP）；
文本 LLM 注入 `vscode.lm` 作为通道后端。

## 能力探测链（自动，无需配置）

| 优先级 | 通道 | 触发条件 | 适用宿主（实测） |
| --- | --- | --- | --- |
| ① | `lm-tools` | `vscode.lm.registerTool` 可用 | VS Code、CodeBuddy、Trae |
| ② | `mcp-provider` | `vscode.lm.registerMcpServerDefinitionProvider` 可用 | CodeBuddy、Trae 等 |
| ③ | `cursor-mcp` | `vscode.cursor.mcp.registerServer` 可用 | Cursor |
| ④ | `manual` | 以上皆无 → 输出面板给出 mcp.json 手配片段 | 兜底 |

文本 LLM 按 `vscode-lm > bridge > sampling > byok > none` 优先级选路（详见仓库
`adapters/shared/HOST-CONTRACT.md` §10）。

## 命令

- **无限画布: 打开画布**（`dsh-canvas.openCanvas`）——启动本机画布 HTTP（127.0.0.1:3210，
  端口占用自动递增），优先以 WebviewPanel iframe 呈现；WebviewPanel 创建失败自动落默认浏览器。
- **无限画布: 探测宿主能力**（`dsh-canvas.probeHost`）——在输出面板输出探测报告：
  四能力布尔 + 决策路径 + `selectChatModels` 模型清单 + LLM 通道探测（全部经脱敏）。
- **无限画布: 打开设置页**（`dsh-canvas.openSettings`）——打开画布页并提示设置区位置。

## 入口（0.2.0 起）

三处入口指向同一个 `dsh-canvas.openCanvas`：

- **标题栏按钮**：窗口右上角 `$(browser)` 图标（`window/title` navigation@1；Trae 自定义标题栏
  是否渲染该按钮待实机验证，状态栏是保底入口）。
- **状态栏**：右下角常驻 `$(browser) 画布`，**任何窗口可见**（含空白欢迎窗口/受限窗口），
  不依赖工具通道构建成功；点击后的错误经命令处理器呈现。
- **命令面板**：`无限画布: 打开画布` 等三条命令不变。

扩展清单已声明 `"untrustedWorkspaces": { "supported": true }` 与 `"virtualWorkspaces": true`
（并声明 `extensionKind: ["ui"]`）——空白/受限窗口不再出现「环境已禁用此扩展」（Trae 3.4.15
实测反馈的修复）。

## 手动配置 MCP（manual 通道）

在宿主 `mcp.json` 加入（路径以输出面板实际输出为准）：

```json
{
  "mcpServers": {
    "dsh-infinite-canvas": {
      "command": "<node>",
      "args": ["<扩展目录>/shared/canvas-mcp.cjs", "--core-dir", "<扩展目录>/shared/core"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

## 隐私与安全

- 探测报告与错误消息全部经脱敏出口（`sk-` 形状的密钥替换为 `[redacted]`）；
- 画布数据目录为用户目录 `~/.dsh-infinite-canvas/`（可用环境变量 `DSH_IC_HOME` 重定向），
  升级/重装不丢用户创作数据；
- 扩展零运行时依赖：随包只带本仓库 `shared/` 与 core 运行时文件。

## 开发（仓库内）

```bash
cd adapters
npm install
npm run sync             # 同步 shared 五模块 + core 运行时文件到 vsix/shared/
npm run generate:tools   # core 工具面变更后重新生成 contributes.languageModelTools
npm run package          # 打包 → dist/dsh-infinite-canvas-<版本>.vsix（vsce 依 vsix/package.json version 命名，当前 0.3.0）
```
