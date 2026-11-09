# 无限画布（dsh-infinite-canvas）· WorkBuddy 插件（本地目录市场形态）

WorkBuddy（OpenCode 系 Electron 应用）的插件分发走 **marketplace**：市场根含
`.codebuddy-plugin/marketplace.json`，插件目录 = `.codebuddy-plugin/plugin.json` + `.mcp.json` +
`skills/` + `dist/`。装插件 = **加一个本地目录市场**（无扩展页，画布面板走本机浏览器）。

## 构建

```
node adapters/scripts/build-workbuddy.mjs
→ adapters/dist/workbuddy-marketplace/          # staging 完整市场（目录形态，可直接作市场源）
→ adapters/dist/dsh-marketplace-workbuddy-0.3.3.zip   # zip 分发物（ZIP 根含 .codebuddy-plugin/marketplace.json）
```

dist/ 为生成物，不进 git——先构建再安装。staging 目录与仓库内
`adapters/workbuddy-plugin/marketplace/` 内容一致，两者任选其一作市场源。

## 安装方式 A：本地目录市场（directory 源，推荐）

WorkBuddy 的市场清单实证支持 `directory` 类型本地源。在 WorkBuddy 中添加本地目录市场，
目录指向 staging（或仓库内 `marketplace/` 目录，先构建出 `plugins/dsh-infinite-canvas/dist/`）：

1. 运行构建脚本得到 staging：`adapters/dist/workbuddy-marketplace/`。
2. 在 WorkBuddy 市场设置里把该目录加为本地市场源（即 `known_marketplaces.json` 的
   `directory` 条目，`path` 指向该目录——目录下直接是 `.codebuddy-plugin/marketplace.json`）。
3. 在市场中安装 `dsh-infinite-canvas`，**重启 WorkBuddy** 生效。

## 安装方式 B：zip URL 模式

`known_marketplaces.json` 实证同样支持 zip URL 源：把 `dsh-marketplace-workbuddy-0.3.3.zip`
放到可访问的 URL（或本地文件路径），按 zip 源添加市场后安装插件。ZIP 根直接含
`.codebuddy-plugin/marketplace.json`（官方规范），插件 `.mcp.json` 用
`${CODEBUDDY_PLUGIN_ROOT}` 指向插件根（stdio command 强制插件根内）。

> **手动改 `known_marketplaces.json` 的纪律**：先备份原文件；只 read-merge（读入 JSON、合并
> 写入新条目），**绝不整文件覆盖**；条目结构参考文件内既有条目。改完重启 WorkBuddy。

## 数据目录

画布数据（项目/设定集/生成产物）落 `~/.dsh-infinite-canvas/`（可用环境变量 `DSH_IC_HOME`
重定向）。数据在**用户目录**，不随插件升级/重装清空（插件缓存按版本更替，用户数据不受影响）。

## 本包未执行注册

**当前版本只提供可安装产物与本说明，未执行任何注册动作**——本会话正运行在 WorkBuddy 内，
存在配置写入竞态，注册（加本地市场/改 known_marketplaces.json）延后到后续任务（用户配合重启时
执行）。手动安装务必遵守上面的备份与 read-merge 纪律。

## 隐私与安全

本市场产物不含任何 API 密钥（打包测试有 `sk-` 密钥形状全文扫描）；bridge 通道读取的宿主模型
配置仅内存持有，不落盘、不进日志（详见 `adapters/shared/HOST-CONTRACT.md` §9/§10）。
