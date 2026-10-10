# ArtCraft ↔ 无限画布 对接手册（画布侧需求书）

> 供 dsh-artcraft 侧对照实施/实测。本文只描述**画布侧发起的调用与期望**，
> 契约基础：`dsh-artcraft/README.md`（已实现并验证其 HTTP 形状）。
> 画布侧代码：`dsh-infinite_canvas/client.js` 中 `craft*` 相关段（v0.16.0）。

## 1. 环境配置（artcraft.config.json）

```jsonc
{
  "dataRoot": "C:/craft-workspace",          // 任意可写目录；画布按 <dataRoot>/<项目slug>/ 隔离
  "bins": {
    "photocraft":  "C:/craft/photocraft-...-portable",   // 目录（自动拼 photocraft-cli.exe）或完整 exe 或 PATH 裸名
    "filmcraft":   "C:/craft/filmcraft-...-portable",
    "effectcraft": "C:/craft/effectcraft-...-portable"
  },
  "control": { "filmcraft": 9876, "effectcraft": 9877 } // 仅 P2 控制通道模式需要
}
```

- 画布对 bins.*.found 的判定完全信任 `GET /artcraft/api/status`；`note` 字段会原文展示给用户（红灯原因）。
- `dataRoot.path` 会被拼进 FCP7 XML 的 `file://localhost/` 绝对引用——**必须是 FilmCraft 能访问的本机绝对路径**。

## 2. 画布会发起的 HTTP 调用（逐条）

| # | 调用 | 触发时机 | 画布侧超时 | 期望响应 |
|---|---|---|---|---|
| 1 | `GET /api/status` | 设置卡片/各 Craft 入口挂载时（静默探测） | 20s | `dataRoot.path/exists`、`bins.*.found/note` |
| 2 | `POST /api/fs?action=write&rel=…` | 资产同步 / timeline.xml / srt / grade.json | 180s | `{ok,rel,size}`；**body 为原始 Blob**（视频可达数十 MB） |
| 3 | `POST /api/job` | PhotoCraft 处理 / FilmCraft 导出 | 30s | `{id,…}` |
| 4 | `GET /api/job?id=…&tail=…` | 轮询（PhotoCraft 1.5s / FilmCraft 2s） | 20s | `{status,stdout,stderr,outputs:[{rel,exists,size}]}` |
| 5 | `POST /api/job/cancel` | 用户点取消 | 20s | 任意 |
| 6 | `GET /api/file?rel=…` | 回收产物（graded 图 / final.mp4） | 180s | 原始字节 + 按扩展名 content-type |

- rel 一律**相对 dataRoot、正斜杠、无前导 /**，形如 `<项目slug>/media/…`。
- 画布在 status 不可达/404 时全部 Craft 入口置灰并提示，不会发后续调用。

## 3. 画布发起的确切 CLI 命令行（cwd = dataRoot）

### 3.1 PhotoCraft 单图处理（T4，已实现）

```
photocraft-cli run <项目slug>/media/<assetId>.<ext> --cmd <命令ID> --params <JSON字符串> --out <项目slug>/out/graded/<assetId>-graded<ext>
```

- 已内置命令（下拉可选，用户可自定义任意 cmd）：
  - `filter.sharpen.smartSharpen`，params `{"amount":80}`
  - `layer.newAdjustmentLayer.curves`，params `{"points":[[0,0],[64,48],[192,212],[255,255]]}`
- **需实测确认**：`run` 子命令是否存在；`--params` 是字符串还是文件；`--out` 是文件还是目录；处理 PNG/WEBP 输入是否支持。

### 3.2 PhotoCraft 批量（配方已确认，UI 未接）

```
photocraft-cli batch --actions <项目slug>/craft/grade.json --in <项目slug>/media --out <项目slug>/out/graded
```

grade.json：`{ "actions": [ { "cmd": "...", "params": {...} }, … ] }`

### 3.3 FilmCraft 导出（T5，**待实测回填**）

画布写入两个文件后发起（args 为 JSON 数组，用户可在确认框编辑）：

```
写入 <项目slug>/craft/timeline.xml   （FCP7 XML xmeml v1，单视频轨顺序片段）
写入 <项目slug>/craft/subs.srt       （按片段顺序的字幕）
然后：
filmcraft-cli --project <项目slug>/craft/drama.fcproj --import <项目slug>/craft/timeline.xml --export <项目slug>/out/final.mp4
```

**需实测回填的问题**：
1. `--project` 指向的 `.fcproj` 不存在时是否自动创建？还是需要先 `init`？
2. 导入时间线的确切子命令形态（`--import` 一次调用？还是 `import` 子命令 + `export` 子命令两步）？
3. `--export` 的格式参数（h264 预设名/质量参数/CRF？音频是否自动混入源片段音轨？）
4. xmeml 的 `<pathurl>file://localhost/…` 引用是否能自动 relink 到 media/ 下文件（含中文/空格/URL 编码）？
5. 字幕：是否支持 `--subs <srt>` 之类参数烧录/挂载？（画布已生成 subs.srt，参数确定后追加）

### 3.4 EffectCraft（T6 骨架，画布 UI 未接）

```
effectcraft-cli render --comp Main --out <项目slug>/out/intro.mp4 <项目slug>/craft/intro.ecproj
```

## 4. 目录与命名约定（画布侧已实现，artcraft 无需感知，但排错时有用）

```
<dataRoot>/<项目slug>/
  media/<assetId><ext>        画布资产（ext 由 mime/name 推断：png/jpg/webp/webm/mp4/mp3/wav）
  craft/timeline.xml          FCP7 XML（xmeml v1，30fps，单视频轨）
  craft/subs.srt              成片字幕（与片段顺序一致）
  craft/grade.json            （批量调色预留）
  out/graded/<assetId>-graded<ext>
  out/final.mp4
```

- `<项目slug>`：项目名去掉 `\/:*?"<>|` 后保留中文；重名冲突加 `-<项目id尾4>` 后缀；slug 一经分配稳定不变（映射画布侧持久化）。
- 同名重复同步 = **覆盖写**（幂等）。

## 5. 退出码与错误约定（画布轮询依赖）

- 退出码 0 → 画布判 `done`，按 `outputs[].exists` 决定是否回收；非 0 → `failed`，画布展示 **stderr 尾 3 行**。
- CLI 必须：无交互、headless 可跑、错误写 stderr、成功写 stderr/stdout 的进度行（画布把 stdout 尾行显示为进度）。
- 任务超时由画布提交时的 `timeoutMs` 控制（photocraft 10min / filmcraft 30min），artcraft 侧默认值被覆盖。

## 6. 联调流程建议

1. `artcraft.config.json` 配好三 bins + dataRoot → `GET /api/status` 三绿灯。
2. 画布资产页点"同步全部资产到磁盘"→ 检查 `<dataRoot>/<项目>/media/` 出现文件。
3. 资产卡 → PhotoCraft 处理 → 选"智能锐化" → 开始处理 → 确认 `out/graded/` 产物入库。
4. 搭一个最小分镜流（2 个视频片段）→ 成片节点 FilmCraft 导出 → 用 `artcraft_cli {bin:"filmcraft",args:["commands"]}`（或本地 `filmcraft-cli commands`）核对 3.3 的五个问题 → 回填确认框默认 args。
5. 全绿后把实测参数发回画布侧更新默认模板。
