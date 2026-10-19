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

**唯一入口**：

```
node scripts/regress.mjs --strict     # 发版门禁：四态输出，SKIP 也算失败
node scripts/regress.mjs              # 日常开发：条件用例缺前置记 SKIP，不算失败
node scripts/regress.mjs --list       # 看当前清单
```

清单以 `scripts/regress.mjs` 的 `SUITE` 为**唯一事实源**（与 `RELEASING.md` §标准发版流程第 1 步逐项一致），
**当前项数与分组以 `node scripts/regress.mjs --list` 实时输出为准——runbook 不写死项数**（门禁新增脚本时这里是必漏之地）。

| 分组 | 脚本 |
| --- | --- |
| 静态审计 | `audit.mjs` |
| 渲染与组件 | `smoke-render.mjs`、`test-drag-alt.mjs`、`test-download-ext.mjs`、`test-craft-base.mjs` |
| 核心链路（历史事故区） | `test-compose.mjs`、`test-tools.mjs`、`test-mentions.mjs`、`test-llm-stream.mjs`、`test-sync-bible.mjs`、`test-user-scenarios.mjs`、`test-host-hardening.mjs` |
| 存储与数据目录 | `test-db.mjs`、`test-delete-project.mjs`、`test-dataroot.mjs` |
| 网络与条件用例 | `test-image-proxy.mjs`、`test-update.mjs`（需网络）、`test-real-project.mjs`、`test-real-project-graph.mjs`（需真实数据根） |
| 打包 | `check-pack.mjs` |

**为什么要有 regress**：此前最危险的成片链路（`test-compose.mjs`）**不在任何门禁清单里**——历史上
`bc77bb8e fix(finalcut): 每次合成都崩(ReferenceError: dur is not defined)` 正是只在用户点"合成"时炸、
静态审计抓不到的典型，而修复它时这条链路连跑都没人跑。

**条件用例纪律**：`test-real-project.mjs` / `test-real-project-graph.mjs` 读真实数据根
（默认 `D:/data/canvas-data`，可用 `DSH_IC_DATA_ROOT` 覆盖）、`test-update.mjs` 打真实 npm registry。
缺前置时它们会打印"跳过"并 exit 0 —— 这是**假绿**，所以发版一律 `--strict`（SKIP 判失败），
且 SKIP 时必须打印"原因 + 缺失的前置"。

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
- [ ] `node scripts/regress.mjs --strict` 全绿（项数以 `node scripts/regress.mjs --list` 为准，不在此写死；SKIP 算失败）+ 涉及 UI 的重启实测通过
- [ ] `package.json` version = 目标版本号（自查，勿依赖守卫）
- [ ] **用户明确批准版本号**
- [ ] 合并 main（**`git push origin main` 由维护者本人执行**）→ 建 GitHub Release `vX.Y.Z`（指向 main）
- [ ] Actions 绿 + `npm view`（官方源）版本正确
- [ ] 汇报版本号 + "重启 Harness 后生效"
