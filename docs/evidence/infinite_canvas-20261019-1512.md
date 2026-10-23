# 测试报告 · 冒烟（A 类数据链路，不依赖浏览器面板）

- 被测插件：dsh-infinite_canvas（画布数据链路）+ dsh-artcraft（只读探测）
- 被测分支/commit：`dev` @ `16f20fe9b6ba38d29f2fa9e0d86c612a1fe933ff`（infinite_canvas，工作区干净）
- 参考版本：dsh-artcraft `dev` @ `e945ba4285cd285b81e20df69ecb1ae16383db6b`（工作区干净）
- 插件版本：artcraft 0.3.1（artcraft_status）
- 测试时间：2026-10-19 15:12 – 15:16
- 测试人：dsh-qa
- 测试项目：`QA-canvas-20261019-1512`（id=pmvex3446bnns，已删除）
- 结论：**PASS（数据链路）+ 1 项缺陷（删除项目未清理磁盘镜像文件）**

## 0. 环境基线

| 项 | 实测 |
|---|---|
| git 读版本 | 全局 `safe.directory` 写入被沙箱拒绝（`C:/Users/PC/.gitconfig: Permission denied`）；改用本工作区配置：文件 `D:\Code\deepseek-plugin\_qa\gitconfig`（`[safe] directory=…` 两条），用法为**每条 git 命令前置** `$env:GIT_CONFIG_GLOBAL='D:\Code\deepseek-plugin\_qa\gitconfig'`（pwsh 每次调用新进程，环境变量不跨调用保留）。两仓库 branch/HEAD 均读取成功。**以后新会话照此用法。** |
| 画布数据根 | `D:\data\canvas-data`（`~/.dsh/infinite-canvas/config.json` 的 dataRoot） |
| 画布存储模式 | SQLite（存在 `canvas.db` + `canvas.db-wal`），另有 `projects\<项目id>\` 文件镜像 |
| 画布现有项目 | 3 个（时空邮递员 / 门缝里的字条 / 画布test）——全部只读，未改动 |
| DSH Web GUI | http://127.0.0.1:3292（HTTP 探测返回 401，服务在线但需鉴权） |
| 浏览器面板 | 未打开 → 所有界面可见性项标「未覆盖-待浏览器面板」 |
| ArtCraft 应用 | `artcraft_live` LIVE 0/4：filmcraft:9876 / effectcraft:9877 / vectorcraft:7979 / lightcraft:7980 均 ECONNREFUSED（未以 `--control` 启动） |

## 1. 测试数据隔离规则（自本轮起对所有测试生效）

1. 测试项目统一命名 `QA-<项目>-<YYYYMMDD-HHmm>`；测完 `canvas_delete_project` 删除。
2. 已有项目（时空邮递员、门缝里的字条、画布test）**只读**，不碰不改不删。
3. 生成类省额度：每轮冒烟 ≤1 张图（1K）+ ≤1 段短视频（480P/≤5s）；本轮未跑视频。

## 2. 用例与结果

| 用例ID | 前置 | 步骤 | 期望 | 实际 | 证据 | 判定 |
|---|---|---|---|---|---|---|
| A-01 建项目 | 已 list 查重 | `canvas_create_project('QA-canvas-20261019-1512')` | 建项目并返回 id；列表可见 | id=pmvex3446bnns，列表 1 节点（QA冒烟-剧本），未产生重复项目 | 创建返回 + `canvas_list_projects` | PASS |
| A-03 设定集写入/读回 | A-01 | `canvas_update_bible` 写世界观/风格/角色2/场景1/道具3 → `canvas_get_bible` | 写后读回一致 | 读回：世界观有、风格有、角色2、场景1、道具3，文字与写入一致 | `canvas_update_bible`/`canvas_get_bible` 原文 | PASS |
| A-04 写剧本 | A-01 | 同节点 idea+output 写入（nodeName=QA冒烟-剧本） | 剧本成稿落在 script 节点，idea 与 output 同节点 | output 为两场剧本正文；节点 status=idle（未触发生成，属预期） | 项目列表 + 节点输出 | PASS |
| A-05 拆分镜 | A-04 | 建 storyboard 并从剧本 `connectFrom`，count=2，触发 | shots 非空；镜头数与要求一致；不复制剧本全文 | status=done，2 镜（递袋3s / 停走的表4.5s，总 7.5s），每镜含景别/画面/动作/台词/音效/接点尾态 | `canvas_generate_node` + `canvas_node_status` | PASS |
| A-05b 一致性告警闭环 | A-05 | 首轮 status 报 12 条「已登记但描述为空」→ 按告警逐项补设定集 → 再读 status | 补全后告警消失 | 补全后 `canvas_node_status` 不再出现 warning 段 | 两次 status 输出对比 | PASS |
| A-06 生成图片 | A-05 | 建 image-gen（16:9 / 1K）触发，wait 300s | done 且有资产；产物文件存在且内容符合提示词 | done，资产 a_mvex4pru513uh；文件 `D:\data\canvas-data\projects\pmvex3446bnns\image\QA冒烟-场1图 10-19 07_13-13uh.png`，1024x576（比例 1.778，16:9），724,089 B；看图内容＝便利店男店员递出白色纸袋，冷白荧光灯、货架虚化，与提示词一致 | read_image + System.Drawing 尺寸 | PASS |
| A-B01 删除项目（画布侧） | 全部用例跑完 | `canvas_delete_project(pmvex3446bnns)` | 项目从画布消失 | 返回「已删除」；全量 list 恢复为原 3 个项目 | `canvas_delete_project` + `canvas_list_projects` | PASS |
| A-B02 删除项目（磁盘侧） | A-B01 | 检查 dataRoot 镜像目录 | 无残留文件/目录 | **残留**：`projects\pmvex3446bnns\image\QA冒烟-场1图 ….png`(724,089B) + `projects\pmvex3446bnns\text\QA冒烟-分镜表 ….md`(1,086B) 仍在 | `Get-ChildItem -Recurse` | **FAIL** |
| B-01 ArtCraft 环境 | — | `artcraft_status` | 13 bin found、tools 无 errors | 13/13 found，register 10 工具，errors=[]，jobs 0 | artcraft_status JSON | PASS |
| B-02 应用在线 | — | `artcraft_live` | 如实报告在线情况 | LIVE 0/4，四端口 ECONNREFUSED | artcraft_live | 未覆盖-环境（App 未启动） |
| B-03 只读命令族 | B-01 | `artcraft_cli photocraft commands` | 返回真实命令注册表 | ok, code=0, 932ms，返回数百条命令（channel.*/image.adjustments.*/actions.* 等），非空非硬编码 | artcraft_cli 原始 stdout | PASS |

## 2.1 删除彻底性检查（本轮起固定项）

数据根 `D:\data\canvas-data\projects\` 目录级统计（项目名 | 文件数 | 字节数）：

| 项目目录 | 测试后（删除前 15:14） | 删除后（15:17 实测） |
|---|---|---|
| 画布test（只读） | 2 文件 / 747 B | 2 文件 / 747 B（一致） |
| 时空邮递员（只读） | 49 文件 / 72,280,080 B | 49 文件 / 72,280,080 B（一致） |
| 门缝里的字条（只读） | 31 文件 / 63,176,810 B | 31 文件 / 63,176,810 B（一致） |
| QA-canvas-20261019-1512（本轮新建） | 2 文件 / 725,175 B | **2 文件 / 725,175 B（未清理）** |

- 只读项目文件数/字节数测试前后一致 ✅ 未被污染。
- QA 项目已从画布列表消失，但 `projects\pmvex3446bnns\` **完整残留**（`image\QA冒烟-场1图 …png` 724,089 B + `text\QA冒烟-分镜表 …md` 1,086 B）❌ → 缺陷 BLK-01。
- 残留**保留**作为证据（QA 决定：留作对照，不清）；已冻结哈希清单：png `885D28…A868`（724,089 B）、md `A2D297…58ED`（1,086 B），合计 725,175 B，明细见缺陷单 §5。回归时该目录仅作 before 快照，判据 1/2 用新建 QA 项目验证。后续每轮报告都记这一节，防垃圾累积。

## 3. 缺陷 / 观察

| 问题ID | 级别 | 复现步骤 | 期望 | 实际 | 证据 |
|---|---|---|---|---|---|
| BLK-01 | 中（非阻塞，建议发版前修） | 1) 建项目并生成 1 张图；2) `canvas_delete_project(<id>)`；3) 看 `D:\data\canvas-data\projects\<id>\` | 项目删除后数据目录镜像一并清理，无残留 | SQLite 模式下删除只清 DB 行与按 sha 的 CAS 对象（index.js:1174-1190），`projects\<id>\` 镜像目录与文件保留 | 残留 image 724,089B + text 1,086B；正式缺陷单：`_qa\BLK-01-删除项目残留-20261019-1512.md`（已发 dsh-pm 登记） |
| OBS-01 | 低 | `canvas_list_projects(keyword='QA-canvas')` 在无匹配时返回「画布上还没有项目」 | 提示应为「没有匹配的项目」，避免误解为画布为空 | 文案误导 | 工具输出 |

## 4. 未覆盖（明确不写通过）

- 所有界面可见性/交互：菜单、按钮、快捷键面板、Alt 拖拽解耦、连线可视化 —— 待浏览器面板打开后补测。
- 刷新/重开状态保持（A-10）、重排 A-09、多语言 zh/en（A-11/12）、边界输入（A-13）、幂等重复生成（A-14）、失败恢复（A-15）—— 本轮未跑。
- 视频生成链路（A-07）：按省额度规则本轮跳过。
- ArtCraft 控制通道类（需 App 以 `--control` 启动）、自然语言真实任务产出与 QC（B-04/B-05）、错误路径 B-06、长任务 B-07、幂等 B-08、多语言 B-09、路径沙箱 B-10。
- 安装/升级路径（`artcraft_update` 需重启 Harness）。

## 5. 结论

- **数据链路 PASS**：建项目 → 写剧本 → 拆分镜（2 镜）→ 告警闭环补设定集 → 1K 出图 → 看图/尺寸核对 → 画布侧删除，全部实测通过。
- **1 项缺陷**：删除项目后磁盘镜像残留（BLK-01），导致「测完不留垃圾」目前不成立；本轮残留文件为 QA 自建项目产物，未手动删除以免破坏证据，请开发者确认是否属预期（如为回收站机制请说明保留策略）。
- 本报告**不构成发版结论**：界面类与 ArtCraft 在线链路尚未覆盖。

## 6. 追加复验（2026-10-19 15:23，同一被测 commit）

**6.1 BLK-01 追加判据 7（FTS 残留）已实测复现**
只读探针：`node D:\Code\deepseek-plugin\_qa\blk01-fts-probe.mjs`（`node:sqlite` readOnly 打开 `D:\data\canvas-data\canvas.db`）
```
projects: [pmv54zuhu6zky 时空邮递员, pmv9hcxrttlrx 门缝里的字条, p_mv0tw70rswdeh 画布test]
assets rows for pmvex3446bnns: [{"n":0}]
FTS MATCH 'QA冒烟': [{"id":"a_mvex3p1wx2oac"},{"id":"a_mvex4pru513uh"}]
FTS MATCH '便利店':  [{"id":"a_mvex3p1wx2oac"},{"id":"a_mvex4pru513uh"}]
FTS 总行数 / assets 总行数: [{"n":58}] / [{"n":56}]
```
→ 项目行、资产行都已删，`assets_fts` 仍留 2 条孤儿行（差 2 正好是本项目），搜索仍能命中已删项目资产。判据已写入缺陷单 §7.1-7。

**6.2 BLK-02 / IC-B2 交叉引用（口径已两次更正）**：契约断点（`?rel=` 400、写入静默错位到 DSH 进程 cwd、`status.dataRoot` 字段缺失）证据见 [`BLK-02-补充证据-契约断点-20261019.md`](D:\Code\deepseek-plugin\_qa\BLK-02-补充证据-契约断点-20261019.md) 与正式单 [`BLK-02-静默错位-20261019.md`](D:\Code\deepseek-plugin\_qa\BLK-02-静默错位-20261019.md)。**最终口径**：BLK-01 范围 = 资产镜像目录 + FTS + 僵尸文件；`craft\` 目录**清理**独立为 backlog 卡 **IC-B2**，**不属 BLK-02**（真因：slug 由 `craftProjectSlug()`（client.js:4511）按项目名生成、只存 localStorage，Host 不知情，且 Host `sanitizeFolderName` 与客户端 `slugifyName` 规则不同 → 猜目录会误删同名项目产物）；IC-B2 评估排在 BLK-02 之后（目录基准正从 slug 改 `<id>`）。BLK-01 判据 1–10 均不含 craft 目录。

**6.3 环境说明更正（按实测）**：QA 侧命令行**可用** —— 15:23 复核：`git rev-parse`（infinite_canvas 16f20fe / artcraft e945ba4）、`node --version`（v24.12.0）、`Invoke-WebRequest`（BLK-02 四条探针）、`Get-ChildItem` 均成功。唯一限制：工作区外写/删被沙箱拒绝（`C:\Users\PC\.dsh\profiles\desktop\blk02-probe-old.txt` 25 B 删不掉，已记待用户清理）。因此本报告未把命令行类用例记 BLOCKED；若后续 QA 侧 shell 被拒再改判并附原始报错。
