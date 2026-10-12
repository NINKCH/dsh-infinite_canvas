# 发布流程与红线（必须遵守）

本仓库：`@ninkch/dsh-infinite-canvas`（无限画布插件）。
npm 发布**完全由 GitHub Actions 自动完成**（npm 已绑定 GitHub，Trusted Publishing / OIDC）——
**禁止在本机手动 `npm publish`**（本机默认 registry 是淘宝镜像，不能发布；npmjs 令牌也无发布权限）。

## 红线

1. **未经维护者（NINKCH）在对话中明确批准版本号，不得发版**（不打标签、不建 Release、不触发发布）。
2. **npm `latest` 是正式渠道**：任何未经验证的版本不得进入。别人的机器会直接装到它。
3. **发布只允许从 main 分支切**：Release 必须打在 main 的提交上；工作流内置守卫——
   release 提交不在 main 上时自动拒绝发布（重试 3 次后失败）。
4. **tag 必须与 package.json 的 version 一致**（`vX.Y.Z` ↔ `X.Y.Z`）；工作流第二步守卫会校验，
   不一致直接失败。
5. 本插件是给别人用的产品：每个进入 npm 的版本都默认"别人要用"，按产品质量对待。

## 分支模型

| 分支 | 用途 | 发布权限 |
|---|---|---|
| `dev` | 开发/测试分支：所有改动先进 dev，在这里自测 | 不发布（Release 打在 dev 上会被 main 守卫拒绝） |
| `main` | 稳定分支：dev 测试通过 + 维护者批准后合并进入 | 建 `vX.Y.Z` Release → 触发 OIDC 自动发布 |

**版本号规则（维护者规定）**：一律 patch 递增 —— `0.17.x → 0.17.x+1`。
**未经维护者明确批准，不得提升递增等级**（不得改成 0.18.0 / 1.0.0 等）。
无论改动多大，都只走 patch +1；等级提升是维护者保留的显式动作。

## 发布机制（不用记原理，记流程）

- 触发：GitHub 仓库 → **Releases → Draft a new release** → 选/建 tag `vX.Y.Z` → **Publish release**。
- 执行：`.github/workflows/publish.yml` 在 Release published 时自动运行：
  main 守卫 → tag=version 校验 → `npm publish --access public`（OIDC 可信发布，无令牌无 OTP）。
- npm 侧前提（一次性配置，Trusted Publisher）：
  npmjs.com → 包设置 → Trusted Publisher：
  `Organization or user: NINKCH` / `Repository: dsh-infinite-canvas` /
  `Workflow filename: publish.yml` / Environment 留空 / ☑ Allow npm publish。
  若 Actions 日志报 OIDC/权限错误，先来这里补配置再重发。

## 标准发版流程

1. 在 `dev` 完成改动并自测（全绿才算过）：
   - `node --check index.js client.js`
   - 12 项回归测试：`scripts/audit.mjs`、`smoke-render.mjs`、`test-tools.mjs`、`test-mentions.mjs`、
     `test-update.mjs`、`test-host-hardening.mjs`、`test-llm-stream.mjs`、`test-sync-bible.mjs`、
     `test-user-scenarios.mjs`、`test-dataroot.mjs`、`test-image-proxy.mjs`、`check-pack.mjs`
   - 涉及 UI/工作流的：重启 Harness + 刷新后人工验证（画布操作是给用户用的，必须真实点一遍）
2. **向维护者汇报"改了什么 + 测了什么 + 结果 + 建议版本号"，获得明确批准**。
3. 确认 `package.json` 的 `version` 已是目标版本号（发版前自查，别指望守卫兜底）。
4. **发版记录用英文**：先在 [`CHANGELOG.md`](CHANGELOG.md) 顶部新增 `## [X.Y.Z] — 日期` 英文段落，
   GitHub Release 的 body 从 CHANGELOG 复制英文段落——**GitHub 面向公众，一律英文**（早期版本正文
   曾因编码通道损坏出现整段 `???`，已全部重写为英文；中文汇报只留在对话里给维护者看）。
5. 合并进 main 并推送：`git switch main && git merge dev && git push origin main dev`。
6. 建 GitHub Release 触发发布（两种方式任选）：
   - 网页：GitHub → Releases → Draft a new release → 选/建 tag `vX.Y.Z`（指向 main）→ Publish release；
   - API/脚本：POST `/repos/NINKCH/dsh-infinite_canvas/releases`
     （`tag_name: vX.Y.Z`、`target_commitish: main`、`name`、`body`）。
7. 发布后验证（三件套，缺一不可）：
   - GitHub Actions 的 publish 运行**绿**；
   - `npm view @ninkch/dsh-infinite-canvas version` 显示新版本（注意本机默认是淘宝镜像，
     镜像同步有延迟，验证请显式 `--registry https://registry.npmjs.org`）；
   - 本机重启 Harness 后画布功能正常。

## 已知教训（不要再犯）

- **禁止本机 `npm publish`**：本机默认 registry 是淘宝镜像（`registry.npmmirror.com`），发布必 404；
  即使显式指定官方源，存储的 npmjs 令牌也早已无发布权限（新政策下经典令牌不能发布）。
  发布只走 GitHub Release → OIDC。
- **PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 UTF-8 BOM** → DSH 加载器 `JSON.parse` 失败，
  整包"异常"。改文件一律用编辑工具（write/edit），或 PS7 的 `-Encoding utf8NoBOM`。发版前扫一遍 BOM。
- **打 Release 前必须同步 package.json 的 version**：工作流有守卫（tag ≠ package.json → 直接失败），
  但根上要在打标签前自查，别浪费一轮 Actions。
- bypass-2FA 令牌不能 unpublish；删除已发布包只能维护者在 npmjs.com 网页操作。
- 检查更新的语义：**只对比 npm 版本号**（本地领先不算待更新、版本相同即最新），绝不比较 SHA；
  更新完成后只提示 + 等用户决定何时重启，绝不自动刷新/重启页面。
- 本机调试与线上安装的关系（与 dsh-artcraft 同规）：profile 依赖若是 `link:` 则本地改动直接生效；
  若是 npm 实体安装，必须走完整发版后更新，**禁止把本地代码直接拷进 node_modules**（弗兰肯斯坦补丁）。
