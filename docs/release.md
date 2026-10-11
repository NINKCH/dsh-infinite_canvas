# 发布与测试流程（Runbook）

> 维护者向导：如何从"本地改动"走到"公众可用的 npm 版本"。
> 铁律见 §0；测试三层漏斗见 §1；日常操作 §2–§5；更新检查逻辑 §6。

## 0. 铁律（不可违反）

1. **未经用户明确批准，绝不 `npm publish`、绝不合并 main、绝不 `git push origin main`。**
2. **绝不自动重启 Harness、绝不自动刷新页面。** 更新/安装后只提示（横幅/文案），何时生效由用户决定。
3. **beta 版本号绝不复用**（npm 本身也禁止覆盖已发布版本）；**正式版本号只在 main 上诞生**。
4. **版本单一来源 = `package.json`**。改版本一律用 `npm version …`，不手改；Host 运行时读取它，禁止在代码里硬编码版本号。
5. **版本号一律按 0.0.x（patch）递增**（如 0.17.3 → 0.17.4），不做 minor/major 升级——新功能同样走 patch 号。
6. npm token 只通过命令行注入，**绝不写入任何文件**。

## 1. 测试三层漏斗

| 层 | 目的 | 载体 | 代价 |
| --- | --- | --- | --- |
| ① 开发自测 | 验证代码逻辑；改动即时可见 | profile 以 `link:` 符号链接直连本仓库 | 零发布物 |
| ② Beta 集成测试 | 验证 100% 真实 npm 安装链路（包内容、`dsh.bundle.patch`、安装器行为） | npm prerelease + `--tag next` | 一个公开的 beta 版本号（无害，可留存） |
| ③ 正式发布 | 公众 `latest` | main 分支 + `npm publish` | 需用户批准 |

三层是递进关系：改动至少过 ①；要发版必须过 ②（除非纯文档改动）。

## 2. 层①：开发自测循环

**切换到开发态**（改动即时生效）：

1. 编辑 `C:\Users\PC\.dsh\profiles\desktop\package.json`：
   `"@ninkch/dsh-infinite-canvas": "link:D:/code/deepseek-plugin/dsh-infinite_canvas"`
2. 在该 profile 目录执行 `pnpm install`
3. **手动重启 Harness**（Host 代码只在重启时加载）

**每轮改动的固定动作**（dev 分支）：

```
node --check client.js
node --check index.js
node scripts/smoke-render.mjs   # 渲染冒烟：抓渲染期 ReferenceError（黑屏级联卸载）
```

- 仅 client.js 改动 → 刷新页面即生效
- index.js 改动 → 需手动重启 Harness
- 测完切回正式版：依赖改回版本号 → `pnpm install` → 重启

## 3. 发布前校验（两个脚本都必须绿）

```
node scripts/check-pack.mjs     # 打包清单 + 元数据核对（npm pack --dry-run）
node scripts/smoke-render.mjs   # 渲染冒烟：假 React 走真实组件树
node scripts/test-update.mjs    # 更新检查功能测试（真实 registry 比对）
```

`check-pack` 防的三类事故：漏打包（如 locale/icon 没进包）、多打包（`.github`/`scripts` 混入）、元数据漂移（版本/exports/`dsh.bundle.patch`）。

## 4. 层②：Beta 集成测试

```
# 1) 打 beta 号（每轮自增，绝不复用；dev 分支上操作）
npm version 0.17.3-beta.0        # 显式指定；或 npm version prerelease --preid=beta

# 2) 提交 beta 号变更到 dev
git add package.json && git commit -m "chore: v0.17.3-beta.0" && git push origin dev

# 3) 经用户批准后发布到 next 标签（绝不占 latest）
npm publish --tag next --access public --registry=https://registry.npmjs.org '--//registry.npmjs.org/:_authToken=<TOKEN>'

# 4) 安装测试
#    在插件管理安装 @ninkch/dsh-infinite-canvas 精确版本 0.17.3-beta.0
#    → 手动重启 Harness → 冒烟：RPC ping + 页面渲染 + 核心流程

# 5) 回滚（任何问题）：安装回正式精确版本 → 重启，零残留
```

说明：

- prerelease 排序低于同号正式版，安装器不会把 beta 当"更新"推给正式用户；beta 留在 registry 无害。
- 清理 next 标签（可选）：`npm dist-tag rm @ninkch/dsh-infinite-canvas next`

## 5. 层③：正式发布（全部需用户批准）

```
# 1) 合并
git checkout main
git merge dev
git push origin main

# 2) 出正式号（在 main 上打）
npm version 0.17.3
git push origin main --follow-tags   # npm version 会自动打 git tag vX.Y.Z

# 3) 发布（两条路任选）
#    a. GitHub Actions Trusted Publishing（首选，无 token）：GitHub 建 Release vX.Y.Z → Actions 自动发布
#    b. 手动注入：
npm publish --access public --registry=https://registry.npmjs.org '--//registry.npmjs.org/:_authToken=<TOKEN>'

# 4) 验证
npm view @ninkch/dsh-infinite-canvas version   # 应为新版
GET /infinite-canvas/api/rpc ping               # 安装重启后 version 应为新版
```

发布完成汇报模板：**"已发布 vX.Y.Z，重启 Harness 后生效"**（绝不替用户重启）。

## 6. 插件内"检查更新"（面向公众的统一逻辑）

与安装方式**完全无关**（npm 在线安装 / 本地 link 开发态 / 其它，同一条逻辑）：

- **当前版本** = 当前加载副本的 `package.json`（Host 启动时读取）
- **最新版本** = npm registry `…/@ninkch%2Fdsh-infinite-canvas/latest`（即 `latest` dist-tag，beta 不会出现）
- 本地版本 ≥ 远端 → 视为最新；仅真正落后 → 画布顶部横幅"新版本可用 vX（当前 vY）"
- 横幅"去升级"按钮 → **真实安装**：Host 在所属 profile 内执行 `pnpm add <pkg>@<精确版本> --save-exact` 并同步 bundles 列表；完成后仅提示"已安装 vX — 重启 Harness 后生效"
- **降级为纯引导**的情形：开发态（link/.git）、找不到 pnpm、安装失败、旧 Host 无 `updateInstall` RPC
- **绝不自动刷新、绝不自动重启**；网络失败静默（手动点击才提示错误）

实现位置：`index.js` `updateCheck()` / `updateInstall()`（RPC 同名）；文案 key：`updateGo` / `updateInstalling` / `updateInstalled` / `updateInstalledHint` / `updateFailGuide` / `updateCurrent`。

## 7. 发布日检查清单

- [ ] dev 全部改动已提交并推送
- [ ] `node --check` × 2 + `smoke-render` + `check-pack` 全绿
- [ ] beta 版实测通过（层②）
- [ ] **用户明确批准发布**
- [ ] 合并 main → `npm version` → publish → 确认 registry
- [ ] 汇报版本号 + "重启 Harness 后生效"
