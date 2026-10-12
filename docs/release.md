# 发布与测试流程（Runbook）

> 维护者向导：如何从"本地改动"走到"公众可用的 npm 版本"。
> 铁律见 §0；测试三层漏斗见 §1；日常操作 §2–§5；更新检查逻辑 §6。
> **发版红线与标准流程以仓库根目录 [`RELEASING.md`](../RELEASING.md) 为准绳**（npm 已绑定 GitHub，
> 发布走 GitHub Release → OIDC 自动发布）。

## 0. 铁律（不可违反）

1. **未经用户明确批准，绝不发版**（不建 GitHub Release、不打 v 标签、不合并 main、不 `git push origin main`）。
2. **本机绝不手动 `npm publish`**——本机默认 registry 是淘宝镜像（必 404），npmjs 令牌也无发布权限；
   发布只走 GitHub Release → Actions OIDC（见 `RELEASING.md` 与 `.github/workflows/publish.yml`）。
3. **绝不自动重启 Harness、绝不自动刷新页面。** 更新/安装后只提示（横幅/文案），何时生效由用户决定。
4. **beta 版本号绝不复用**（npm 本身也禁止覆盖已发布版本）；**正式版本号只在 main 上诞生**。
5. **版本单一来源 = `package.json`**；Host 运行时读取它，禁止在代码里硬编码版本号。
6. **版本号一律按 0.0.x（patch）递增**（如 0.17.5 → 0.17.6），不做 minor/major 升级——新功能同样走 patch 号。
7. npm token 只通过命令行注入，**绝不写入任何文件**（且经典令牌已不能发布，仅存档）。

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

## 3. 发布前校验（脚本全绿才算过）

```
node scripts/check-pack.mjs     # 打包清单 + 元数据核对（npm pack --dry-run）
node scripts/smoke-render.mjs   # 渲染冒烟：假 React 走真实组件树
node scripts/test-update.mjs    # 更新检查功能测试（真实 registry 比对）
node scripts/test-tools.mjs     # 对话工具 schema 校验（标准 JSON Schema，防方言错误）
node scripts/test-mentions.mjs  # @引用解析单测（解析/高亮转义/设定集匹配/[图N]绑定/命名）
node scripts/audit.mjs          # 机械化体检（i18n 键对齐/CSS 类/节点类型覆盖/RPC 与工具一致）
node scripts/test-host-hardening.mjs # Host 加固回归（读流错误接管/项目合并与墓碑/来源校验等）
node scripts/test-llm-stream.mjs   # LLM 流式与推理模型重试（思考实时推送/按配置上限重试）
node scripts/test-sync-bible.mjs   # 同步合并回归（设定集拉回/边墓碑防复活）
node scripts/test-user-scenarios.mjs # 用户实测场景定向复验（轮询无损/自动连线/设定集读写）
node scripts/test-dataroot.mjs       # 数据目录回归（项目名文件夹/文档镜像/资产索引/一键导入）
node scripts/test-image-proxy.mjs    # 图片 API 代理回归（CORS 规避：JSON/二进制/状态码透传/超时）
```

`check-pack` 防的三类事故：漏打包（如 locale/icon 没进包）、多打包（`.github`/`scripts` 混入）、元数据漂移（版本/exports/`dsh.bundle.patch`）。

## 4. 层②：Beta 集成测试（已随令牌时代退场，存档）

> 旧流程靠手动注入 npm 令牌发 `--tag next`；经典令牌已不能发布，且发布统一走 OIDC 后
> beta 需要工作流加 prerelease 分支（`--tag next`）才能不占 `latest`——尚未实现。
> 当前集成测试以"dev link 态 + 全量回归脚本 + 重启实测"替代；要发 beta 先在对话里与维护者确认方案。

## 5. 层③：正式发布（需用户批准版本号；流程细则见 `RELEASING.md`）

```
# 1) 确认 package.json version 已是目标版本（版本号的单一来源，发版前自查）
#    dev 分支自测全绿 + 用户明确批准版本号

# 2) 合并（Release 只能打在 main 上；工作流 main 守卫会拒绝 dev 上的发布）
git checkout main
git merge dev
git push origin main dev

# 3) 建 GitHub Release 触发自动发布（无令牌、无 OTP）：
#    GitHub → Releases → Draft a new release → 选/建 tag vX.Y.Z（指向 main）→ Publish release
#    （或 API：POST /repos/NINKCH/dsh-infinite_canvas/releases，tag_name=vX.Y.Z, target_commitish=main）
#    tag 必须与 package.json version 一致（工作流第二步守卫，不一致直接失败）

# 4) 验证（三件套，缺一不可）
#    a. GitHub Actions 的 publish 运行绿
#    b. npm view @ninkch/dsh-infinite-canvas version --registry=https://registry.npmjs.org   # 应为新版
#    c. 重启 Harness 后画布功能正常
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
- [ ] 10 项回归脚本全绿（§3 清单）+ 涉及 UI 的重启实测通过
- [ ] `package.json` version = 目标版本号（自查，勿依赖守卫）
- [ ] **用户明确批准版本号**
- [ ] 合并 main 并推送 → 建 GitHub Release `vX.Y.Z`（指向 main）
- [ ] Actions 绿 + `npm view`（官方源）版本正确
- [ ] 汇报版本号 + "重启 Harness 后生效"
