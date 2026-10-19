# ArtCraft ↔ 无限画布 对接手册（画布侧调用契约）

> 供 dsh-artcraft 侧对照实施/实测。本文只描述**画布侧发起的调用与期望**。
> **契约基线（BLK-02 修复后，2026-10-19）**：ArtCraft 是纯桥接插件，**没有自己的数据根**；
> 画布一律传 **`base`（项目绝对目录）+ `path`（相对路径）**，绝不发「无 base 的相对 `rel`」。
> 历史版本（≤0.17.18）基于 `<artcraft dataRoot>/<项目slug>/` 的约定已废弃，见 §7。

## 1. 环境配置（artcraft.config.json）

```jsonc
{
  "bins": {
    "photocraft":  "C:/craft/photocraft-...-portable",   // 目录（自动拼 photocraft-cli.exe）或完整 exe 或 PATH 裸名
    "filmcraft":   "C:/craft/filmcraft-...-portable",
    "effectcraft": "C:/craft/effectcraft-...-portable"
  },
  "control": { "filmcraft": 9876, "effectcraft": 9877 } // 仅 P2 控制通道模式需要
}
```

- **没有 `dataRoot` 配置项**（0.3.x 起移除）。产物落在哪，完全由调用方传的 `base`/`cwd` 决定。
- 画布对 `bins.*.found` 的判定完全信任 `GET /artcraft/api/status`；`note` 字段会原文展示给用户（红灯原因）。
- `/status` 返回 `plugin / version / platform / config / bins / control / jobs / tools`，**不含 dataRoot**；
  画布不再读取 `status.dataRoot`（旧代码读它是恒空，导致「数据目录不一致」提醒永不触发）。

## 2. 画布会发起的 HTTP 调用（逐条）

| # | 调用 | 触发时机 | 画布侧超时 | 期望响应 |
|---|---|---|---|---|
| 1 | `GET /api/status` | 设置卡片/各 Craft 入口挂载时（静默探测） | 20s | `bins.*.found/note`、`version` |
| 2 | `POST /api/fs?action=write&base=<绝对目录>&path=<相对路径>` | 资产同步 / timeline.xml / srt | 180s | `{ok,path,size}`；**body 为原始 Blob**（视频可达数十 MB） |
| 3 | `POST /api/fs`（JSON `{base,path,text}`） | timeline.xml / subs.srt（文本） | 60s | `{ok,path,size}` |
| 4 | `GET /api/fs?op=readtext&base=<绝对目录>&path=<相对路径>` | 读回文本 | 20s | `{path,text}` |
| 5 | `POST /api/job`（含 `cwd` = 项目绝对目录、`outputs` 用相对路径） | PhotoCraft 处理 / FilmCraft 导出 | 30s | `{id,…}` |
| 6 | `GET /api/job?id=…&tail=…` | 轮询（PhotoCraft 1.5s / FilmCraft 2s） | 20s | `{status,stdout,stderr,outputs:[{rel,exists,size}]}` |
| 7 | `POST /api/job/cancel` | 用户点取消 | 20s | 任意 |
| 8 | `GET /api/file?base=<绝对目录>&path=<相对路径>` | 回收产物（graded 图 / final.mp4） | 180s | 原始字节 + 按扩展名 content-type |

- **`base` 必须是绝对路径**，由画布 Host 的 `projectDirGet` RPC 解析：`<画布数据根>/projects/<项目物理文件夹>`；
  `path` 是相对 `base` 的正斜杠路径，形如 `craft/media/x.png`、`craft/timeline.xml`、`craft/out/final.mp4`。
- **画布绝不发「只有 `rel`、没有 `base`」的相对路径**：那样会被 ArtCraft 按**插件进程 cwd** 解析，
  返回 200 却把文件写到 `C:\Users\PC\.dsh\profiles\desktop\`（BLK-02 的现场缺陷）。
- 画布在 status 不可达/404 时全部 Craft 入口置灰并提示，不会发后续调用。

## 3. 画布发起的确切 CLI 命令行（args 内一律绝对路径，`cwd` = 项目绝对目录）

### 3.1 PhotoCraft 单图处理（T4，已实现）

```
photocraft-cli run <项目绝对目录>\craft\media\<assetId>.<ext> --cmd <命令ID> --params <JSON字符串> --out <项目绝对目录>\craft\out\graded\<assetId>-graded<ext>
```

- 已内置命令（下拉可选，用户可自定义任意 cmd）：
  - `filter.sharpen.smartSharpen`，params `{"amount":80}`
  - `layer.newAdjustmentLayer.curves`，params `{"points":[[0,0],[64,48],[192,212],[255,255]]}`
- **需实测确认**：`run` 子命令是否存在；`--params` 是字符串还是文件；`--out` 是文件还是目录；处理 PNG/WEBP 输入是否支持。

### 3.2 PhotoCraft 批量（配方已确认，UI 未接）

```
photocraft-cli batch --actions <项目绝对目录>\craft\grade.json --in <项目绝对目录>\craft\media --out <项目绝对目录>\craft\out\graded
```

grade.json：`{ "actions": [ { "cmd": "...", "params": {...} }, … ] }`

### 3.3 FilmCraft 导出（T5，**待实测回填**）

画布写入两个文件后发起（args 为 JSON 数组，用户可在确认框编辑）：

```
写入 <项目绝对目录>\craft\timeline.xml   （FCP7 XML xmeml v1，单视频轨顺序片段）
写入 <项目绝对目录>\craft\subs.srt       （按片段顺序的字幕）
然后（cwd = 项目绝对目录，outputs = craft/out/final.mp4）：
filmcraft-cli --project <项目绝对目录>\craft\drama.fcproj --import <项目绝对目录>\craft\timeline.xml --export <项目绝对目录>\craft\out\final.mp4
```

- xmeml 的 `<pathurl>` 用 `file://localhost/<媒体绝对路径>`，媒体绝对路径 = 项目绝对目录 + `craft/media/<文件名>`。

**需实测回填的问题**：
1. `--project` 指向的 `.fcproj` 不存在时是否自动创建？还是需要先 `init`？
2. 导入时间线的确切子命令形态（`--import` 一次调用？还是 `import` 子命令 + `export` 子命令两步）？
3. `--export` 的格式参数（h264 预设名/质量参数/CRF？音频是否自动混入源片段音轨？）
4. xmeml 的 `<pathurl>file://localhost/…` 引用是否能自动 relink 到 craft/media/ 下文件（含中文/空格/URL 编码）？
5. 字幕：是否支持 `--subs <srt>` 之类参数烧录/挂载？（画布已生成 subs.srt，参数确定后追加）

### 3.4 EffectCraft（T6 骨架，画布 UI 未接）

```
effectcraft-cli render --comp Main --out <项目绝对目录>\craft\out\intro.mp4 <项目绝对目录>\craft\intro.ecproj
```

## 4. 目录与命名约定（画布侧已实现，artcraft 无需感知，但排错时有用）

```
<画布数据根>/projects/<项目物理文件夹>/
  craft/media/<资产名>-<id尾4><ext>   画布资产（ext 由 mime 优先推断）
  craft/timeline.xml                  FCP7 XML（xmeml v1，30fps，单视频轨）
  craft/subs.srt                      成片字幕（与片段顺序一致）
  craft/grade.json                    （批量调色预留）
  craft/out/graded/<assetId>-graded<ext>
  craft/out/final.mp4
  image/ text/ video/ …               Host 落的资产文件（0.18 起按类型分目录）
```

- **目录基准是项目 id 对应的物理文件夹**，由 Host 维护（`canvas.meta.json` 的 `folder` 字段）；
  清单缺条目时回退为项目 id。**不再使用项目名 slug**（slug 只存在浏览器 localStorage，Host 与 ArtCraft 都无法可靠重建）。
- 同名重复同步 = **覆盖写**（幂等）。

## 5. 退出码与错误约定（画布轮询依赖）

- 退出码 0 → 画布判 `done`，按 `outputs[].exists` 决定是否回收；非 0 → `failed`，画布展示 **stderr 尾 3 行**。
- CLI 必须：无交互、headless 可跑、错误写 stderr、成功写 stderr/stdout 的进度行（画布把 stdout 尾行显示为进度）。
- 任务超时由画布提交时的 `timeoutMs` 控制（photocraft 10min / filmcraft 30min），artcraft 侧默认值被覆盖。

## 6. 联调流程建议

1. `artcraft.config.json` 配好 bins → `GET /api/status` 各灯绿。
2. 画布资产页点"同步全部资产到磁盘"→ 检查 `<画布数据根>/projects/<项目>/craft/media/` 出现文件
   （**不是** DSH profile 目录）。
3. 资产卡 → PhotoCraft 处理 → 选"智能锐化" → 开始处理 → 确认 `craft/out/graded/` 产物入库。
4. 搭一个最小分镜流（2 个视频片段）→ 成片节点 FilmCraft 导出 → 用 `artcraft_cli {bin:"filmcraft",args:["commands"]}`
   （或本地 `filmcraft-cli commands`）核对 3.3 的五个问题 → 回填确认框默认 args。
5. 全绿后把实测参数发回画布侧更新默认模板。

## 7. 历史约定（已废弃，排错时仅作线索）

| 已废弃 | 现状 |
|---|---|
| `artcraft.config.json` 的 `dataRoot` | 0.3.x 移除；画布不再读取 |
| `GET /status` 的 `dataRoot.path/exists` | 不再返回；画布改用自己的 `projectDirGet` |
| `?action=write&rel=<项目slug>/…`（无 base） | 被按插件进程 cwd 解析 → 200 静默错位（BLK-02）；已全部改为 `base`+`path` |
| `?op=readtext&rel=…`、`/file?rel=…` | 同上，全部改 `base`+`path` |
| `<artcraft dataRoot>/<项目slug>/` 目录布局 | 改为 `<画布数据根>/projects/<物理文件夹>/craft/`；历史 slug 目录不迁移、标遗留 |
