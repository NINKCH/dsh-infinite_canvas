# 无限画布（dsh-infinite-canvas）· Qoder 插件

Qoder CN 的插件壳：`.qoder-plugin` ZIP = manifest + skills + `.mcp.json`。30 个 `canvas_*` 工具经
MCP 承载（Qoder 无自定义插件 UI），画布面板走本机浏览器。构建产物：

```
node adapters/scripts/build-qoder.mjs
→ adapters/dist/dsh-infinite-canvas-qoder-0.3.3.zip
```

ZIP 根直接含 `.qoder-plugin/plugin.json`（官方规范）、`skills/canvas/SKILL.md`、`.mcp.json`、`dist/`。

## 安装方式 A：官方 install_extension（推荐）

在 Qoder 中让 agent 调用官方 `install_extension` 工具：

```json
{"source": "local", "kind": "plugin", "filePath": "<本 ZIP 的绝对路径>"}
```

安装完成后**重启 Qoder** 生效。

## 安装方式 B：手动 cache 注册

> 适用于 `install_extension` 不可用的场景。**每一步都先备份，配置文件只 read-merge、绝不整文件覆盖。**

1. **备份**：复制并保存 `~/.qoder-cn/plugins/installed_plugins_v2.json` 与 `~/.qoder-cn/settings.json`。
2. **解压**：把 ZIP 解压到 `~/.qoder-cn/plugins/cache/local/dsh-infinite-canvas/0.3.3/`
   （解压后该目录下直接是 `.qoder-plugin/`、`skills/`、`.mcp.json`、`dist/`）。
3. **注册（read-merge）**：
   - `installed_plugins_v2.json`：读入 JSON，合并写入键 `"dsh-infinite-canvas@local"`
     （值结构参考文件内既有条目；文件不存在则新建 `{"dsh-infinite-canvas@local": {...}}`）；
   - `settings.json`：读入 JSON，在 `enabledPlugins` 里合并加入 `"dsh-infinite-canvas@local": true`。
4. **重启 Qoder**。

## 数据目录

画布数据（项目/设定集/生成产物）落 `~/.dsh-infinite-canvas/`（可用环境变量 `DSH_IC_HOME` 重定向）。
数据在**用户目录**，不随插件升级/重装清空。

## 本包未执行注册

**当前版本只提供可安装产物与本说明，未执行任何注册动作**——运行中的 Qoder 存在配置写入竞态，
注册动作延后到后续任务（用户配合重启时执行）。手动安装务必遵守上面的备份与 read-merge 纪律。

## 隐私与安全

本 ZIP 不含任何 API 密钥（打包测试有 `sk-` 密钥形状全文扫描）；bridge 通道读取的宿主模型配置
仅内存持有，不落盘、不进日志（详见 `adapters/shared/HOST-CONTRACT.md` §9/§10）。
