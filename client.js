window.__ModuleLoader__.load({
  id: '@ninkch/dsh-infinite-canvas',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;

    // ============================================================
    // 常量
    // ============================================================
    const NS = 'infinite-canvas';
    const PANEL_ID = 'infinite-canvas';
    const LS_PROJECTS = 'dsh-ic:projects';
    const LS_ACTIVE = 'dsh-ic:active';
    const LS_GRAPH = 'dsh-ic:graph:';
    const LS_SETTINGS = 'dsh-ic:settings';
    const DB_NAME = 'dsh-infinite-canvas';
    const GENERAL_PID = 'general'; // 通用项目：多项目共用的资产挂在这里
    const DB_STORE = 'assets';
    const NODE_W = 240;
    const CRAFT_SKILL = 'canvas-craft'; // 内置创作方法论技能（未选技能时默认注入）

    const NODE_TYPES = ['text', 'shot', 'image-gen', 'video-gen', 'image-asset', 'video-asset'];

    // 每类节点的端口定义（kind: text | image | video）
    const PORTS = {
      'text': { inputs: [], outputs: [{ id: 'out', kind: 'text' }] },
      'shot': {
        inputs: [
          { id: 'char', kind: 'image' },
          { id: 'scene', kind: 'image' },
          { id: 'prop', kind: 'image' },
        ],
        outputs: [{ id: 'visual', kind: 'text' }, { id: 'motion', kind: 'text' }],
      },
      'script': { inputs: [], outputs: [{ id: 'out', kind: 'text' }] },
      'storyboard': { inputs: [{ id: 'script', kind: 'text' }], outputs: [{ id: 'out', kind: 'text' }] },
      'image-gen': {
        inputs: [{ id: 'prompt', kind: 'text' }, { id: 'ref', kind: 'image' }],
        outputs: [{ id: 'out', kind: 'image' }],
      },
      'video-gen': {
        inputs: [{ id: 'prompt', kind: 'text' }, { id: 'frame', kind: 'image' }, { id: 'ref', kind: 'image' }],
        outputs: [{ id: 'out', kind: 'video' }, { id: 'last', kind: 'image' }],
      },
      'image-asset': { inputs: [{ id: 'in', kind: 'image' }], outputs: [{ id: 'out', kind: 'image' }] },
      'video-asset': { inputs: [{ id: 'in', kind: 'video' }], outputs: [{ id: 'out', kind: 'video' }] },
      'finalcut': { inputs: [{ id: 'in', kind: 'video' }], outputs: [] },
      'group': { inputs: [], outputs: [] },
    };
    // 允许多条入线的输入端口（参考图类），其余输入端口保持单线
    const MULTI_INPUT_PORTS = new Set(['ref', 'char', 'scene', 'prop']);
    // 分镜端口期望的资产分类（仅用于连接时的非阻断提示）
    const PORT_CATEGORY = { char: 'character', scene: 'scene', prop: 'prop' };
    const CATEGORIES = ['character', 'scene', 'prop', 'script', 'storyboard', 'audio', 'finalcut', 'general'];
    const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
    const IMAGE_SIZES = ['1K', '2K', '4K'];
    const VIDEO_DURATIONS = [4, 5, 6, 8, 10, 12, 15];
    const VIDEO_RESOLUTIONS = ['480P', '720P', '1080P'];

    // ============================================================
    // 工具函数
    // ============================================================
    const cls = (...xs) => xs.filter(Boolean).join(' ');
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function hashStr(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function base64ToBlob(b64, mime) {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime || 'application/octet-stream' });
    }
    function arrayBufferToBase64(buf) {
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(bin);
    }
    function blobToDataUrl(blob) {
      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(blob);
      });
    }
    function downloadBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name || 'asset';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    // ============================================================
    // 多语言：默认跟随 Harness 语言；设置里可一键覆盖（全中文 / 全英文）
    // ============================================================
    let CTX = null;
    let LANG_OVERRIDE = ''; // '' = 跟随宿主
    function hostLang() {
      try {
        const snap = CTX && CTX.locale && CTX.locale.getLocale ? CTX.locale.getLocale() : null;
        const id = typeof snap === 'string' ? snap : ((snap && (snap.locale || snap.id)) || '');
        return String(id).toLowerCase().startsWith('en') ? 'en' : 'zh';
      } catch { return 'zh'; }
    }
    function effLang() { return (LANG_OVERRIDE === 'en' || LANG_OVERRIDE === 'zh') ? LANG_OVERRIDE : hostLang(); }
    function T(k) {
      const d = effLang() === 'en' ? DICT_EN : DICT_ZH;
      return (d && d[k] != null) ? d[k] : k;
    }

    const DICT_ZH = {
      'panel': '无限画布',
      'back': '返回会话',
      'addNode': '添加节点',
      'run': '运行工作流',
      'running': '运行中…',
      'stop': '停止',
      'fit': '适应视图',
      'zoomIn': '放大',
      'zoomOut': '缩小',
      'projects': '项目',
      'assets': '资产',
      'settings': '设置',
      'toggleRight': '切换侧栏',
      'nText': '文本',
      'nImageGen': '图片生成',
      'nVideoGen': '视频生成',
      'nImageAsset': '图片资产',
      'nVideoAsset': '视频资产',
      'portPrompt': '提示词',
      'portRef': '参考图',
      'portFrame': '首帧',
      'portIn': '输入',
      'portOut': '输出',
      'textPlaceholder': '输入文本内容，作为下游节点的提示词…',
      'promptPlaceholder': '描述想生成的画面…',
      'generate': '生成',
      'emptyNodeTitle': '画布是空的',
      'emptyNodeHint': '从上方工具栏或右键菜单添加节点，拖动端口连线搭建工作流。',
      'delete': '删除',
      'duplicate': '复制节点 (Ctrl+D)',
      'confirmDel': '确认删除?',
      'newProject': '新建项目',
      'projectName': '项目名称',
      'renameHint': '双击名称重命名',
      'delProjectHint': '删除项目及其资产',
      'import': '导入图片/视频',
      'addAssetNode': '添加到画布',
      'download': '下载',
      'delAsset': '删除资产',
      'emptyAssets': '还没有资产。运行工作流或导入文件后，生成的图片/视频会沉淀在这里。',
      'imageApi': '图片 API（OpenAI images 兼容）',
      'videoApi': '视频 API（提交 + 轮询）',
      'baseUrl': '接口地址',
      'apiKey': 'API Key',
      'model': '模型',
      'size': '尺寸',
      'apiHintImage': '留空则使用内置演示模式（本地合成占位图）。配置后请求 POST {baseUrl}/images/generations。',
      'apiHintVideo': 'POST 接口地址提交任务，轮询 GET {url}/{taskId} 直到返回视频地址；留空则使用演示模式（本地合成动画视频）。',
      'demoTag': '演示',
      'apiTag': 'API',
      'upload': '上传',
      'sourceRef': '参考图',
      'sourceFrame': '首帧',
      'result': '结果',
      'noResult': '尚未生成',
      'connected': '已连接上游',
      'errCycle': '工作流中存在循环连接，无法运行',
      'pickAsset': '从资产库选择资产（点击右侧"资产"标签页中的条目）',
      'clearRef': '清除',
      'projCreatedAt': '创建于',
      'nodes': '节点',
      'kindImage': '图片',
      'kindVideo': '视频',
      'statusRunning': '生成中',
      'statusDone': '完成',
      'statusError': '失败',
      'nShot': '分镜',
      'portChar': '角色',
      'portScene': '场景',
      'portProp': '道具',
      'portVisual': '画面',
      'portMotion': '动作',
      'visualLabel': '画面描述（生成分镜首帧）',
      'motionLabel': '动作 / 运镜（驱动视频）',
      'shotVisualPlaceholder': '这一帧长什么样：人物穿什么、在什么场景、什么构图…',
      'shotMotionPlaceholder': '接下来怎么动：动作、镜头运动、节奏…',
      'refCount': '参考图',
      'catAll': '全部',
      'catCharacter': '角色',
      'catScene': '场景',
      'catProp': '道具',
      'catGeneral': '通用',
      'catLabel': '分类',
      'rename': '重命名',
      'cancel': '取消',
      'doDelete': '删除',
      'delProjectTitle': '删除项目',
      'delProjectWarn': '将删除该项目及其全部资产（共 {n} 个），且无法恢复。请输入项目名以确认：',
      'delProjectInput': '项目名',
      'imgMode': '参考图模式',
      'modeGenerations': '文生图 /images/generations（忽略参考图）',
      'modeEdits': '参考图编辑 /images/edits（多参考图上传）',
      'catMismatch': '提示：资产分类为「{a}」，端口期望「{b}」，已保留连接',
      'nStoryboard': '分镜表',
      'nScript': '剧本',
      'portScript': '剧本',
      'aiScript': 'AI 生成剧本',
      'aiStoryboard': 'AI 生成分镜',
      'expand': '铺开到画布',
      'ideaLabel': '创意 / 一句话 / 小说片段',
      'ideaPlaceholder': '一句话创意或小说片段，AI 将它写成可拍摄的短剧剧本…',
      'scriptOutputLabel': '剧本（可编辑）',
      'storyboardScriptLabel': '剧本来源（连接剧本节点，或粘贴在此）',
      'storyboardReqLabel': '额外要求（风格、节奏、镜头语言…）',
      'storyboardCountLabel': '分镜数量',
      'shotsLabel': '分镜列表',
      'settingsLabel': '生成设置',
      'durationLabel': '时长',
      'resolutionLabel': '分辨率',
      'ratioLabel': '比例',
      'sizeLabel': '清晰度',
      'llmLabel': '文本模型（DeepSeek）',
      'llmHint': '剧本与分镜提示词使用 Harness 当前配置的模型生成，无需另配 Key。',
      'saveTextAsset': '存为资产',
      'textAssetHint': '文本资产点击可放入画布文本节点',
      'placeholderAsset': '待补充',
      'searchLabel': '搜索名称 / 提示词 / 内容 / 项目',
      'projectFilter': '项目',
      'allProjects': '全部项目',
      'currentProject': '当前项目',
      'expandDone': '已铺开为一次多镜头生成：{n} 镜合成为一条视频（时长 = 各镜之和）',
      'multiShotHint': '多镜头模式：提示词由上游分镜表组合（全部镜头按顺序+时长合成一条提示词），一次性生成整段视频',
      'aiNeedScript': '分镜节点还没有剧本来源：连线上游剧本节点，或在节点里粘贴剧本',
      'upstreamStillRunning': '上游剧本节点还没生成完成（有连线时内容只从连线取）；等它完成后再生成分镜',
      'expandNoShots': '还没有分镜，请先 AI 生成',
      'aiRunning': 'AI 生成中…',
      'langLabel': '界面语言',
      'langFollow': '跟随 Harness',
      'langZh': '中文',
      'langEn': 'English',
      'followSettings': '跟随设置',
      'defaultCfg': '默认配置',
      'defaultImageCfg': '默认图片模型',
      'defaultVideoCfg': '默认视频模型',
      'imageApisLabel': '图片模型（可配多个）',
      'videoApisLabel': '视频模型（可配多个）',
      'addConfig': '新增配置',
      'setDefault': '设为默认',
      'isDefault': '默认',
      'cfgName': '名称',
      'delConfig': '删除此配置',
      'noCfgHint': '尚未配置；生成节点将使用演示模式',
      'bibleTab': '设定集',
      'bibleStyle': '风格基调（画风、年代、色调…跨集保持一致）',
      'bibleCharacters': '角色设定',
      'bibleScenes': '场景设定',
      'bibleProps': '道具设定',
      'bibleNamePh': '名称',
      'bibleDescPh': '外观 / 特征描述（注入 AI，保证一致性）',
      'bibleAdd': '添加',
      'modelLabel': '模型',
      'pickImageFile': '请选择图片文件',
      'pickVideoFile': '请选择视频文件',
      'hostUnavailable': 'Host 服务不可用',
      'connectFailed': '无法连接 Host 服务',
      'errParseStoryboard': '分镜结果无法解析，请重试或更换文本模型',
      'needIdea': '请先填写创意',
      'scriptAssetPrefix': '剧本-',
      'storyboardAssetPrefix': '分镜-',
      'defaultProject': '我的画布',
      'shotPrefix': '镜',
      'shotsUnit': '镜',
      'savedOk': '已存为资产',
      'warnUnregistered': '未在设定集/资产中登记',
      'warnEmptyDesc': '已登记但描述为空（待补全）',
      'catMention': '提及',
      'assetCategoriesFixed': '已按命名规范纠正 {n} 个资产的分类',
      'cfgExtra': '扩展参数（JSON，可选）',
      'cfgExtraHint': 'JSON 对象，逐键合并进请求体（留空不发送）——厂商专属参数如 watermark、prompt_extend、output_format、seed 等在此填写，换厂商无需改代码',
      'vidProtocolHint': '通用 = OpenAI 风格任务接口（JUAI 等聚合平台，URL 填完整 /v1/video/generations）；Seedance 官方 = 火山方舟 contents/generations/tasks',
      'vidAudioOpt': '生成同步音频（勾选才发送 generate_audio）',
      'vidOutFormat': '输出格式 output_format（留空不发送）',
      'providerLabel': '供应商',
      'addProvider': '新增供应商',
      'addModel': '添加模型',
      'modelsLabel': '模型',
      'modelNamePh': '模型 ID（如 doubao-seedance-2.0）',
      'starDefault': '设为默认模型（节点未指定时自动路由到这里）',
      'noModelsCfg': '未配置模型——节点运行将报错',
      'errNoImageModel': '未指定图片模型：请在设置里配置图片模型并星标默认模型，或在节点上选择模型',
      'errNoVideoModel': '未指定视频模型：请在设置里配置视频模型并星标默认模型，或在节点上选择模型',
      'consistencyTitle': '一致性检查',
      'restartHint': '插件后台尚未加载最新版本：请重启一次 DeepSeek Harness 后重试（仅首次更新需要）',
      'rpcFail': '请求失败',
      'skillEnhance': '技能增强（用已安装技能替代内置专家方法论）',
      'skillScript': '剧本技能',
      'skillStoryboard': '分镜技能',
      'builtinExpert': '内置专家',
      'undo': '撤销 (Ctrl+Z)',
      'redo': '重做 (Ctrl+Y)',
      'copyNode': '复制节点',
      'runNode': '运行此节点',
      'zoomReset': '点击重置为 100%',
      'regen': '重新生成',
      'addMenuHint': '双击空白处或右键也可添加节点',
      'nFinalCut': '成片',
      'segmentsLabel': '片段列表（按来源节点上下位置排序）',
      'compose': '合成导出',
      'composing': '合成中',
      'noSegments': '请先连接视频片段（可用"铺开到画布"自动生成分镜组）',
      'composeHint': '按顺序实时录制各片段（字幕烧录进画面），时长=片段总时长',
      'composeDone': '成片已生成并存入资产库',
      'finalCutDone': '成片',
      'subtitlesLabel': '字幕（自动取各段提示词，可逐段编辑）',
      'subPlaceholder': '本段字幕（留空则不显示）',
      'keepAudio': '保留原声',
      'on': '开',
      'off': '关',
      'transition': '转场',
      'transNone': '无',
      'transFade': '叠化',
      'transBlack': '黑场',
      'ttsApisLabel': 'TTS 配音（可配多个）',
      'defaultTtsCfg': '默认TTS',
      'tts': '配音',
      'ttsGen': '生成配音',
      'ttsRunning': '生成中',
      'voice': '音色',
      'errNoTts': '未配置 TTS 配音接口（设置 → TTS 配音）',
      'ttsCategory': '配音',
      'audioKind': '音频',
      'finalcutCategory': '成片',
      'updateBtn': '检查更新',
      'updateAvailable': '新版本可用',
      'updateNow': '一键更新',
      'updateUpToDate': '已是最新版本',
      'updateInstalling': '正在安装更新…',
      'updateInstalled': '已安装',
      'updateInstalledHint': '重启 Harness 后生效（网页部分刷新页面即可）',
      'updateFailGuide': '自动安装未成功，请在 DSH 插件管理 中升级',
      'updatePolicySkipped': '（已按你的点击跳过 24 小时新版本冷却期）',
      'dataRootLabel': '数据根目录',
      'dataRootPlaceholder': '如 D:\\canvas-data',
      'dataRootHint': '资产与视频按项目落盘到该目录（不再占用 C 盘 IndexedDB）。留空 = 浏览器 IndexedDB。',
      'dataRootSave': '设置此目录',
      'dataRootOpen': '打开目录',
      'dataRootMigrate': '迁移历史资产',
      'dataRootMigrated': '已迁移 {n} 个资产到数据根目录',
      'collapse': '折叠',
      'foldOpen': '展开',
      'craftReadyCount': '{r}/{n} 就绪',
      'craftDirLabel': '当前项目后期目录',
      'craftDataRootNeed': '请先在上方设置画布数据根目录：Craft 后期文件将存放于 数据根目录\\projects\\<项目>\\craft',
      'craftRootMismatch': 'ArtCraft 自身数据目录与画布数据根目录不一致：请在 ArtCraft 设置里把数据目录改成同一根目录，否则后期文件会落到两处',
      'dataRootImportBtn': '从数据目录导入',
      'dataRootImported': '导入完成：合并 {n} 个项目、补入 {a} 条资产元数据',
      'dataRootImportHint': '换电脑迁移：把整个数据目录拷到新机器 → 设置为数据根目录 → 点"从数据目录导入"即可恢复项目/节点/设定集/资产',
      'dataRootMigratedDone': '已迁移',
      'dataRootMigrating': '迁移中',
      'dataRootUnsupported': '当前插件后台版本较旧（不支持数据根目录）：重启 Harness 后可用',
      'dataRootSaved': '数据根目录已设置',
      'resizeHint': '拖动左右上下边可调宽高（右键头调宽、底边调高、右下角同时）',
      'resizeHeightHint': '拖动调高；双击恢复「随内容自适应」',
      'aiEmptyResult': '模型返回了空内容——请检查画布设置里的文本模型，或换一个模型重试',
      'aiInterrupted': '上次生成被页面刷新或关闭中断，请重新生成',
      'skillHint': '默认已含内置专家 + 创作方法论（canvas-craft）；也可选择其它已安装技能覆盖',
      'nodeNotRunnable': '该节点类型不支持运行（请用画布上的对应按钮）',
      'delAssetTitle': '删除资产',
      'delAssetWarn': '将删除该资产及其文件，且无法恢复；引用它的节点会清空引用。请输入资产名以确认：',
      'delAssetInput': '资产名',
      'renameAsset': '重命名',
      'renamed': '已重命名',
      'llmMaxTokens': '输出上限 maxTokens',
      'llmTemperature': '温度 temperature',
      'llmParamAuto': '留空 = 用 Harness/模型默认',
      'llmParamHint': '留空则不下发该参数，直接使用你在 Harness 里为该模型配置的默认值（插件不会写死任何生成参数）',
      'imgSizeOverride': '尺寸覆盖 size',
      'imgSizePlaceholder': '如 1024x1024（留空=按清晰度×比例）',
      'imgResponseFormat': '响应格式 response_format',
      'seedanceAudio': '生成音频（Seedance）',
      'seedanceWatermark': '添加水印（Seedance）',
      'seedanceHint': '仅 Seedance 协议生效；模型名必填（协议要求显式指定）',
      'bibleWorldview': '世界观 / 核心设定',
      'bibleWorldviewPh': '题材、年代、核心规则、主线与暗线（会注入所有 AI 生成，保证跨集一致）',
      'bibleDraft': 'AI 起草设定集',
      'bibleDrafted': '已根据创作意图起草设定集，请检查后再生成本',
      'bibleDraftEmpty': '没能起草出设定集：请先在剧本/文本节点写点创作意图，或检查文本模型配置',
      'bibleOrderHint': '设定集先行：世界观/风格/角色/场景/道具先定好 → 生成剧本 → 为角色/场景/道具生成参考图 → 再拆解分镜',
      'bibleLinkAssets': '链接资产',
      'bibleLinkTitle': '链接资产到设定条目',
      'bibleLinkHint': '勾选要绑定的图片/音频/视频（可多选）；@引用该条目时会优先把这些资产作为参考图',
      'bibleLinkApply': '完成',
      'generalProject': '通用项目',
      'moved': '已移动到指定项目',
      'pagePrev': '上一页',
      'pageNext': '下一页',
      'bibleAutoAdd': '已把 {n} 个新元素补进设定集（描述待补充）',
      'kindAudio': '音频',
      'mentionRefs': '@引用命中',
      'mentionAssets': '可用参考图 {n} 张',
      'mentionNoAsset': '暂无参考图',
      'mentionNoAssetHint': '该实体还没有参考图：先建一个图片节点生成（建议命名「角色-名称 多视图」），之后所有 @名称 的提示词都会自动带上它',
      'craftTimeout': 'Craft 任务超时（可在任务面板重试或取消）',
      'errNoImageApi': '未配置图片 API：请到画布设置里添加（未配置时可用演示模式）',
      'photoCmd': 'Craft 命令',
      'bitrate': '码率',
      'bitrateAuto': '自动（浏览器默认）',
      'runRequestFailed': '对话触发的生成未能执行',
      'apiTimeout': '请求超时（毫秒）',
      'uploadFailed': '导入失败',
      'syncFailed': '与 Host 同步失败',
      'dataRootBrowse': '浏览选择目录',
      'dataRootPicking': '请在弹出的窗口中选择目录（可直接取消）…',
      'dataRootPickUnsupported': '当前平台不支持目录选择器，请手动填写路径',
      'updateCurrent': '当前',
      'updateGo': '去升级',
      'npmUpgradeHint': '请在 DSH 插件管理 中升级到最新版（本插件绝不自动安装或重启）；安装完成后重启 Harness 生效',
      'releaseNotes': '发布说明',
      'reloadPage': '刷新页面',
      'history': '历史版本',
      'refList': '参考图（[图N] 按此顺序绑定进提示词）',
      'moveUp': '上移',
      'moveDown': '下移',
      'unbind': '解除连线',
      'group': '分组',
      'createGroup': '创建分组（框住所选）',
      'collapse': '折叠',
      'unfold': '展开',
      'ungroup': '解散分组',
      'redraw': '重绘',
      'lastFrame': '尾帧',
      'chainNext': '接续下一镜',
      'craftCard': 'Craft 后期（ArtCraft）',
      'craftUnreachable': 'Craft 未连接：确认 dsh-artcraft 插件已安装/启用并重启过 Harness',
      'craftDataRoot': '数据目录',
      'craftProjectDir': '本项目目录',
      'craftReady': '就绪',
      'craftMissing': '未找到',
      'craftCliMissing': '{name} CLI 未找到（检查 artcraft.config.json 或 PATH）',
      'craftSyncAll': '同步全部资产到磁盘',
      'craftSyncOne': '同步到磁盘',
      'craftSyncDone': '同步完成：成功 {ok} / 失败 {fail}',
      'photoCraft': 'PhotoCraft 处理',
      'photoParams': '参数（JSON）',
      'photoCustom': '自定义',
      'photoRun': '开始处理',
      'filmcraftExport': 'FilmCraft 导出',
      'filmcraftParams': 'FilmCraft 导出参数（CLI 子命令未实测，默认取自配方，可编辑）',
      'filmcraftArgs': 'CLI 参数（JSON 数组）',
      'filmcraftOut': '输出文件（相对数据目录）',
      'filmcraftSubmit': '提交 FilmCraft 任务',
      'craftCancel': '取消任务',
      'craftJobDone': 'Craft 产物已入库',
      'craftInvalidJson': 'JSON 无效',
      'maskRedraw': '蒙版重绘',
      'brushSize': '笔刷大小',
      'clearMask': '清除蒙版',
      'applyGen': '应用生成',
      'maskHint': '涂抹需要重新生成的区域（红色区=重绘区）；需使用支持 images/edits 的图片模型（如 gpt-image-1）',
      'vidProtocol': '接口协议',
      'protoGeneric': '标准（提交+轮询）',
      'protoSeedance': '火山 Seedance（官方任务）',
    };
    const DICT_EN = {
      'panel': 'Infinite Canvas',
      'back': 'Back to session',
      'addNode': 'Add node',
      'run': 'Run workflow',
      'running': 'Running…',
      'stop': 'Stop',
      'fit': 'Fit view',
      'zoomIn': 'Zoom in',
      'zoomOut': 'Zoom out',
      'projects': 'Projects',
      'assets': 'Assets',
      'settings': 'Settings',
      'toggleRight': 'Toggle sidebar',
      'nText': 'Text',
      'nImageGen': 'Image Gen',
      'nVideoGen': 'Video Gen',
      'nImageAsset': 'Image Asset',
      'nVideoAsset': 'Video Asset',
      'portPrompt': 'prompt',
      'portRef': 'ref',
      'portFrame': 'first frame',
      'portIn': 'in',
      'portOut': 'out',
      'textPlaceholder': 'Type text used as prompt by downstream nodes…',
      'promptPlaceholder': 'Describe what to generate…',
      'generate': 'Generate',
      'emptyNodeTitle': 'Empty canvas',
      'emptyNodeHint': 'Add nodes from the toolbar or right-click menu, then drag between ports to wire a workflow.',
      'delete': 'Delete',
      'duplicate': 'Duplicate (Ctrl+D)',
      'confirmDel': 'Confirm delete?',
      'newProject': 'New project',
      'projectName': 'Project name',
      'renameHint': 'Double-click to rename',
      'delProjectHint': 'Delete project and its assets',
      'import': 'Import image/video',
      'addAssetNode': 'Add to canvas',
      'download': 'Download',
      'delAsset': 'Delete asset',
      'emptyAssets': 'No assets yet. Generated images/videos will land here after a run or import.',
      'imageApi': 'Image API (OpenAI images compatible)',
      'videoApi': 'Video API (submit + poll)',
      'baseUrl': 'Base URL',
      'apiKey': 'API Key',
      'model': 'Model',
      'size': 'Size',
      'apiHintImage': 'Leave empty to use the built-in demo mode (local placeholder images). When set, requests go to POST {baseUrl}/images/generations.',
      'apiHintVideo': 'POSTs the task to the URL and polls GET {url}/{taskId} until a video URL appears; leave empty for demo mode.',
      'demoTag': 'demo',
      'apiTag': 'API',
      'upload': 'Upload',
      'sourceRef': 'ref',
      'sourceFrame': 'frame',
      'result': 'Result',
      'noResult': 'Not generated yet',
      'connected': 'Upstream connected',
      'errCycle': 'Workflow contains a cycle and cannot run',
      'pickAsset': 'Pick an asset from the library (Assets tab on the right)',
      'clearRef': 'Clear',
      'projCreatedAt': 'Created',
      'nodes': 'nodes',
      'kindImage': 'image',
      'kindVideo': 'video',
      'statusRunning': 'running',
      'statusDone': 'done',
      'statusError': 'failed',
      'nShot': 'Shot',
      'portChar': 'character',
      'portScene': 'scene',
      'portProp': 'prop',
      'portVisual': 'visual',
      'portMotion': 'motion',
      'visualLabel': 'Visual description (first frame)',
      'motionLabel': 'Action / camera (drives video)',
      'shotVisualPlaceholder': 'What this frame looks like: wardrobe, location, framing…',
      'shotMotionPlaceholder': 'What happens next: actions, camera move, pacing…',
      'refCount': 'refs',
      'catAll': 'All',
      'catCharacter': 'Character',
      'catScene': 'Scene',
      'catProp': 'Prop',
      'catGeneral': 'General',
      'catLabel': 'Category',
      'rename': 'Rename',
      'cancel': 'Cancel',
      'doDelete': 'Delete',
      'delProjectTitle': 'Delete project',
      'delProjectWarn': 'This deletes the project and all its assets ({n}). Type the project name to confirm:',
      'delProjectInput': 'Project name',
      'imgMode': 'Reference mode',
      'modeGenerations': 'text-to-image /images/generations (refs ignored)',
      'modeEdits': 'image edit /images/edits (multi-reference upload)',
      'catMismatch': 'Note: asset category is "{a}", port expects "{b}". Connected anyway.',
      'nStoryboard': 'Storyboard',
      'nScript': 'Script',
      'portScript': 'script',
      'aiScript': 'AI write script',
      'aiStoryboard': 'AI break into shots',
      'expand': 'Expand to canvas',
      'ideaLabel': 'Idea / logline / novel excerpt',
      'ideaPlaceholder': 'A one-line idea or novel excerpt — AI turns it into a shootable script…',
      'scriptOutputLabel': 'Script (editable)',
      'storyboardScriptLabel': 'Script source (connect a script node, or paste here)',
      'storyboardReqLabel': 'Extra requirements (style, pacing, camera language…)',
      'storyboardCountLabel': 'Shot count',
      'shotsLabel': 'Shots',
      'settingsLabel': 'Generation settings',
      'durationLabel': 'Duration',
      'resolutionLabel': 'Resolution',
      'ratioLabel': 'Ratio',
      'sizeLabel': 'Quality',
      'llmLabel': 'Text model (DeepSeek)',
      'llmHint': 'Scripts and storyboard prompts use the model configured in Harness — no extra key needed.',
      'saveTextAsset': 'Save as asset',
      'textAssetHint': 'Click a text asset to place it as a canvas text node',
      'placeholderAsset': 'missing',
      'searchLabel': 'Search name / prompt / content / project',
      'projectFilter': 'Project',
      'allProjects': 'All projects',
      'currentProject': 'Current project',
      'expandDone': 'Expanded to one multi-shot generation: {n} shots composed into a single video',
      'multiShotHint': 'Multi-shot mode: the prompt is composed from the upstream storyboard (all shots, in order, with durations) and generated as one clip',
      'aiNeedScript': 'The storyboard has no script source: connect an upstream script node, or paste a script into the node',
      'upstreamStillRunning': 'The upstream script node is still generating (with a wire, content comes only from the wire); wait for it before splitting shots',
      'expandNoShots': 'No shots yet — run AI generation first',
      'aiRunning': 'AI generating…',
      'langLabel': 'UI language',
      'langFollow': 'Follow Harness',
      'langZh': '中文',
      'langEn': 'English',
      'followSettings': 'From settings',
      'defaultCfg': 'Default',
      'defaultImageCfg': 'Default image model',
      'defaultVideoCfg': 'Default video model',
      'imageApisLabel': 'Image models (multiple)',
      'videoApisLabel': 'Video models (multiple)',
      'addConfig': 'Add config',
      'setDefault': 'Make default',
      'isDefault': 'default',
      'cfgName': 'Name',
      'delConfig': 'Delete this config',
      'noCfgHint': 'Nothing configured yet; generation nodes will use demo mode',
      'bibleTab': 'Bible',
      'bibleStyle': 'Style baseline (art, era, palette… kept across episodes)',
      'bibleCharacters': 'Characters',
      'bibleScenes': 'Scenes',
      'bibleProps': 'Props',
      'bibleNamePh': 'Name',
      'bibleDescPh': 'Appearance / traits (injected into AI for consistency)',
      'bibleAdd': 'Add',
      'modelLabel': 'Model',
      'pickImageFile': 'Please pick an image file',
      'pickVideoFile': 'Please pick a video file',
      'hostUnavailable': 'Host service unavailable',
      'connectFailed': 'Cannot reach the Host service',
      'errParseStoryboard': 'Could not parse the storyboard result — retry or switch the text model',
      'needIdea': 'Write the idea first',
      'scriptAssetPrefix': 'Script-',
      'storyboardAssetPrefix': 'Shots-',
      'defaultProject': 'My Canvas',
      'shotPrefix': 'Shot ',
      'shotsUnit': 'shots',
      'savedOk': 'Saved as asset',
      'warnUnregistered': 'not in bible/assets',
      'warnEmptyDesc': 'registered but description is empty (fill it in)',
      'catMention': 'Mention',
      'assetCategoriesFixed': 'Re-categorized {n} assets by naming convention',
      'cfgExtra': 'Extra params (JSON, optional)',
      'cfgExtraHint': 'A JSON object merged into the request body (empty = not sent) — vendor-specific params like watermark, prompt_extend, output_format, seed go here; switching vendors needs no code changes',
      'vidProtocolHint': 'Generic = OpenAI-style task API (JUAI etc., URL = full /v1/video/generations); Seedance official = Volcano Ark contents/generations/tasks',
      'vidAudioOpt': 'Generate synced audio (only sent when checked)',
      'vidOutFormat': 'Output format output_format (empty = not sent)',
      'providerLabel': 'Provider',
      'addProvider': 'Add provider',
      'addModel': 'Add model',
      'modelsLabel': 'Models',
      'modelNamePh': 'Model id (e.g. doubao-seedance-2.0)',
      'starDefault': 'Set as default model (nodes without a selection route here)',
      'noModelsCfg': 'No models configured — node runs will fail',
      'errNoImageModel': 'No image model selected: configure image models in Settings and star a default, or pick one on the node',
      'errNoVideoModel': 'No video model selected: configure video models in Settings and star a default, or pick one on the node',
      'consistencyTitle': 'Consistency check',
      'restartHint': 'The plugin backend is not loaded yet: restart DeepSeek Harness once and retry (first update only)',
      'rpcFail': 'Request failed',
      'skillEnhance': 'Skill boost (use installed Harness skills instead of built-in experts)',
      'skillScript': 'Script skill',
      'skillStoryboard': 'Storyboard skill',
      'builtinExpert': 'Built-in expert',
      'undo': 'Undo (Ctrl+Z)',
      'redo': 'Redo (Ctrl+Y)',
      'copyNode': 'Duplicate node',
      'runNode': 'Run this node',
      'zoomReset': 'Click to reset to 100%',
      'regen': 'Regenerate',
      'addMenuHint': 'Double-click empty space or right-click to add nodes',
      'nFinalCut': 'Final Cut',
      'segmentsLabel': 'Segments (ordered by source node position)',
      'compose': 'Compose & export',
      'composing': 'Composing',
      'noSegments': 'Connect video segments first (use "Expand to canvas" to auto-generate shot groups)',
      'composeHint': 'Records segments in order with burned-in subtitles; duration = total',
      'composeDone': 'Final cut saved to assets',
      'finalCutDone': 'Final cut',
      'subtitlesLabel': 'Subtitles (auto from prompts, editable per segment)',
      'subPlaceholder': 'Subtitle for this segment (empty = none)',
      'keepAudio': 'Keep original audio',
      'on': 'On',
      'off': 'Off',
      'transition': 'Transition',
      'transNone': 'None',
      'transFade': 'Crossfade',
      'transBlack': 'Black',
      'ttsApisLabel': 'TTS voices (multiple)',
      'defaultTtsCfg': 'Default TTS',
      'tts': 'Voice',
      'ttsGen': 'Generate voice',
      'ttsRunning': 'Generating',
      'voice': 'Voice',
      'errNoTts': 'No TTS config (Settings → TTS voices)',
      'ttsCategory': 'Voice',
      'audioKind': 'Audio',
      'finalcutCategory': 'Final cut',
      'updateBtn': 'Check updates',
      'updateAvailable': 'New version available',
      'updateNow': 'Update now',
      'updateUpToDate': 'Up to date',
      'updateInstalling': 'Installing update…',
      'updateInstalled': 'Installed',
      'updateInstalledHint': 'restart Harness to take effect (refresh the page for the web part)',
      'updateFailGuide': 'Auto-install failed — please upgrade via the DSH Plugin Manager',
      'updatePolicySkipped': '(skipped the 24-hour release cool-down at your click)',
      'dataRootLabel': 'Data root',
      'dataRootPlaceholder': 'e.g. D:\\canvas-data',
      'dataRootHint': 'Assets and videos are stored per project under this folder (no more C: IndexedDB). Empty = browser IndexedDB.',
      'dataRootSave': 'Set directory',
      'dataRootOpen': 'Open folder',
      'dataRootMigrate': 'Migrate existing assets',
      'dataRootMigrated': 'Migrated {n} assets to the data root',
      'collapse': 'Collapse',
      'foldOpen': 'Expand',
      'craftReadyCount': '{r}/{n} ready',
      'craftDirLabel': 'Project craft dir',
      'craftDataRootNeed': 'Set the canvas data root above first: craft files go to <root>\\projects\\<project>\\craft',
      'craftRootMismatch': "ArtCraft's own data root differs from the canvas data root — point ArtCraft at the same root or craft files will land in two places",
      'dataRootImportBtn': 'Import from data root',
      'dataRootImported': 'Imported: {n} projects merged, {a} asset records added',
      'dataRootImportHint': 'Migration: copy the whole data folder to the new machine, set it as data root, then click "Import from data root" to restore projects/nodes/bible/assets',
      'dataRootMigratedDone': 'Migrated',
      'dataRootMigrating': 'Migrating',
      'dataRootUnsupported': 'The plugin backend is older and lacks data-root support — restart Harness to enable',
      'dataRootSaved': 'Data root set',
      'resizeHint': 'Drag any edge to resize (top/bottom = height, left/right = width, corner = both)',
      'resizeHeightHint': 'Drag to set height; double-click to fit content again',
      'aiEmptyResult': 'The model returned empty content — check the text model in canvas settings or try another model',
      'aiInterrupted': 'The previous generation was interrupted by a page reload; please run it again',
      'skillHint': 'Defaults to built-in experts plus the canvas-craft methodology; pick another installed skill to override',
      'nodeNotRunnable': 'This node type cannot be run (use its button on the canvas)',
      'delAssetTitle': 'Delete asset',
      'delAssetWarn': 'The asset and its file will be deleted permanently; nodes referencing it will lose the reference. Type the asset name to confirm:',
      'delAssetInput': 'Asset name',
      'renameAsset': 'Rename',
      'renamed': 'Renamed',
      'llmMaxTokens': 'Output cap (maxTokens)',
      'llmTemperature': 'Temperature',
      'llmParamAuto': 'empty = Harness/model default',
      'llmParamHint': 'Left empty, the parameter is not sent at all — the model uses the default you configured in Harness. The plugin never hardcodes generation parameters.',
      'imgSizeOverride': 'Size override',
      'imgSizePlaceholder': 'e.g. 1024x1024 (empty = clarity × ratio)',
      'imgResponseFormat': 'response_format',
      'seedanceAudio': 'Generate audio (Seedance)',
      'seedanceWatermark': 'Watermark (Seedance)',
      'seedanceHint': 'Seedance protocol only; the model name is required by the protocol',
      'bibleWorldview': 'Worldview / core settings',
      'bibleWorldviewPh': 'Genre, era, core rules, main and hidden threads (injected into all generation for consistency)',
      'bibleDraft': 'Draft bible with AI',
      'bibleDrafted': 'Bible drafted from your intent — review it before generating the script',
      'bibleDraftEmpty': 'Nothing drafted: write some intent in a script/text node first, or check the text model',
      'bibleOrderHint': 'Bible first: set worldview/style/characters/scenes/props → generate the script → generate reference images → then break down the storyboard',
      'bibleLinkAssets': 'Link assets',
      'bibleLinkTitle': 'Link assets to this bible entry',
      'bibleLinkHint': 'Pick images/audio/video to bind (multi-select); @mentions of this entry will use them as references first',
      'bibleLinkApply': 'Done',
      'generalProject': 'General',
      'moved': 'Moved to the target project',
      'pagePrev': 'Prev page',
      'pageNext': 'Next page',
      'bibleAutoAdd': 'Added {n} new entries to the bible (descriptions pending)',
      'kindAudio': 'Audio',
      'mentionRefs': '@mention hits',
      'mentionAssets': '{n} reference image(s) available',
      'mentionNoAsset': 'no reference image yet',
      'mentionNoAssetHint': 'No reference image for this entity yet: create an image node (name it like "角色-张山 多视图") and every later @mention will pick it up automatically',
      'craftTimeout': 'Craft job timed out (retry or cancel it in the job panel)',
      'errNoImageApi': 'No image API configured — add one in canvas settings (demo mode is available without one)',
      'photoCmd': 'Craft command',
      'bitrate': 'Bitrate',
      'bitrateAuto': 'Auto (browser default)',
      'runRequestFailed': 'Chat-triggered generation failed',
      'apiTimeout': 'Request timeout (ms)',
      'uploadFailed': 'Import failed',
      'syncFailed': 'Failed to sync with Host',
      'dataRootBrowse': 'Browse for folder',
      'dataRootPicking': 'Pick a folder in the dialog (cancel anytime)…',
      'dataRootPickUnsupported': 'No folder picker on this platform — type the path instead',
      'updateCurrent': 'current',
      'updateGo': 'Upgrade',
      'npmUpgradeHint': 'Please upgrade via the DSH Plugin Manager (this plugin never auto-installs or restarts); restart Harness after installing',
      'releaseNotes': 'release notes',
      'reloadPage': 'Reload page',
      'history': 'History',
      'refList': 'Refs ([图N] bound to prompt in this order)',
      'moveUp': 'Move up',
      'moveDown': 'Move down',
      'unbind': 'Unlink',
      'group': 'Group',
      'createGroup': 'Group selection',
      'collapse': 'Collapse',
      'unfold': 'Expand',
      'ungroup': 'Ungroup',
      'redraw': 'Redraw from this',
      'lastFrame': 'Last frame',
      'chainNext': 'Chain next shot',
      'craftCard': 'Craft post (ArtCraft)',
      'craftUnreachable': 'Craft not connected: make sure dsh-artcraft is installed/enabled and Harness was restarted',
      'craftDataRoot': 'Data root',
      'craftProjectDir': 'Project dir',
      'craftReady': 'Ready',
      'craftMissing': 'Not found',
      'craftCliMissing': '{name} CLI not found (check artcraft.config.json or PATH)',
      'craftSyncAll': 'Sync all assets to disk',
      'craftSyncOne': 'Sync to disk',
      'craftSyncDone': 'Sync finished: ok {ok} / fail {fail}',
      'photoCraft': 'PhotoCraft process',
      'photoParams': 'Params (JSON)',
      'photoCustom': 'Custom',
      'photoRun': 'Run',
      'filmcraftExport': 'FilmCraft export',
      'filmcraftParams': 'FilmCraft export params (CLI subcommands untested; defaults from recipe, editable)',
      'filmcraftArgs': 'CLI args (JSON array)',
      'filmcraftOut': 'Output file (relative to data root)',
      'filmcraftSubmit': 'Submit FilmCraft job',
      'craftCancel': 'Cancel job',
      'craftJobDone': 'Craft output saved to assets',
      'craftInvalidJson': 'Invalid JSON',
      'maskRedraw': 'Mask inpaint',
      'brushSize': 'Brush size',
      'clearMask': 'Clear mask',
      'applyGen': 'Apply & generate',
      'maskHint': 'Paint the region to regenerate (red = repainted); requires an images/edits model (e.g. gpt-image-1)',
      'vidProtocol': 'Protocol',
      'protoGeneric': 'Generic (submit + poll)',
      'protoSeedance': 'Volcano Seedance (official tasks)',
    };

    // ============================================================
    // 样式（只使用 --dsw-alias-* 主题 token，深浅色自动适配）
    // ============================================================
    const CSS = `
.dshic-page{position:relative;height:100%;display:flex;flex-direction:column;box-sizing:border-box;
  padding-top:var(--dsh-frame-top-clearance,0px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:14px;line-height:22px;overflow:hidden;user-select:none;-webkit-user-select:none;}
.dshic-toolbar{flex:none;display:flex;align-items:center;gap:6px;min-height:44px;padding:4px 10px;flex-wrap:wrap;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);position:relative;z-index:20;}
.dshic-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;
  border:none;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;
  white-space:nowrap;flex:none;}
.dshic-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);}
.dshic-btn.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-brand-primary);}
.dshic-btn.is-danger{color:var(--dsw-alias-state-error-primary);}
.dshic-btn:disabled{opacity:.45;cursor:default;background:transparent;}
.dshic-btn.dshic-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);}
.dshic-btn.dshic-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 85%,var(--dsw-alias-label-primary));}
.dshic-toolbar-sep{width:1px;height:18px;background:var(--dsw-alias-border-l2);margin:0 4px;flex:none;}
.dshic-toolbar-title{font-weight:600;font-size:14px;margin-left:2px;}
.dshic-flex{flex:1;}
.dshic-zoom{min-width:56px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dshic-main{flex:1;display:flex;min-height:0;}
.dshic-canvas{flex:1;position:relative;overflow:hidden;background-color:var(--dsw-alias-bg-base);
  background-image:radial-gradient(color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent) 1px,transparent 1px);
  outline:none;}
.dshic-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform;}
.dshic-edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;}
.dshic-edge{fill:none;stroke-width:2;pointer-events:none;}
.dshic-edge.kind-text{stroke:var(--dsw-alias-label-secondary);}
.dshic-edge.kind-image{stroke:var(--dsw-alias-brand-primary);}
.dshic-edge.kind-video{stroke:var(--dsw-alias-state-success-primary);}
.dshic-edge.is-selected{stroke-width:3.5;filter:drop-shadow(0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent));}
.dshic-edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer;}
.dshic-edge-temp{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:2;stroke-dasharray:6 5;pointer-events:none;}
.dshic-node{position:absolute;box-sizing:border-box;width:${NODE_W}px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 4px 14px color-mix(in srgb,var(--dsw-alias-bg-base) 40%,transparent);
  cursor:grab;min-height:96px;display:flex;flex-direction:column;}
.dshic-node:active{cursor:grabbing;}
.dshic-node.is-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);}
.dshic-node.st-running{border-color:var(--dsw-alias-brand-primary);}
.dshic-node.st-done{border-color:var(--dsw-alias-state-success-primary);}
.dshic-node.st-error{border-color:var(--dsw-alias-state-error-primary);}
.dshic-node-head{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px;border-bottom:1px solid var(--dsw-alias-border-l1);
  border-radius:12px 12px 0 0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);cursor:grab;}
.dshic-dot{width:8px;height:8px;border-radius:50%;flex:none;}
.dshic-dot.k-text{background:var(--dsw-alias-label-secondary);}
.dshic-dot.k-image{background:var(--dsw-alias-brand-primary);}
.dshic-dot.k-video{background:var(--dsw-alias-state-success-primary);}
.dshic-node-title{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshic-node-x{flex:none;width:18px;height:18px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;font-size:13px;line-height:18px;padding:0;display:inline-flex;align-items:center;justify-content:center;}
.dshic-node-x:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary);}
/* 节点尺寸把手：上下左右四条边 + 右下角；双击底边恢复随内容自适应 */
.dshic-rs{position:absolute;z-index:6;}
.dshic-rs:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);border-radius:4px;}
.dshic-rs-e{right:-3px;top:14px;bottom:14px;width:7px;cursor:ew-resize;}
.dshic-rs-w{left:-3px;top:14px;bottom:14px;width:7px;cursor:ew-resize;}
.dshic-rs-s{bottom:-3px;left:14px;right:14px;height:7px;cursor:ns-resize;}
.dshic-rs-n{top:-3px;left:14px;right:14px;height:7px;cursor:ns-resize;}
.dshic-rs-se{right:-4px;bottom:-4px;width:16px;height:16px;cursor:nwse-resize;}
.dshic-node-body{padding:8px;display:flex;flex-direction:column;gap:6px;font-size:12px;flex:1;min-height:0;overflow:auto;}
/* 手动拉过高高度的节点：主体内的文本框随节点一起拉伸（拖高=对话框变高，而不是只撑外框） */
.dshic-node.h-manual .dshic-node-body{overflow:hidden;}
.dshic-node.h-manual .dshic-node-body > .dshic-textarea{flex:1 1 auto;min-height:0;}
.dshic-node.h-manual .dshic-node-body > .dshic-prompt{flex:1 1 auto;display:flex;flex-direction:column;}
.dshic-node.h-manual .dshic-node-body > .dshic-prompt > .dshic-prompt-input{flex:1 1 auto;min-height:0;}
.dshic-textarea{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);
  border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;
  /* 节点内文本统一字号/行高/内距：与 .dshic-prompt-back/.dshic-prompt-input 必须逐项一致（透明叠层对齐） */
  font-size:12px;line-height:18px;padding:7px 9px;outline:none;user-select:text;-webkit-user-select:text;cursor:text;}
.dshic-textarea:focus{border-color:var(--dsw-alias-brand-primary);}
.dshic-textarea:disabled{opacity:.6;}
.dshic-input{width:100%;box-sizing:border-box;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 8px;outline:none;
  user-select:text;-webkit-user-select:text;}
.dshic-input:focus{border-color:var(--dsw-alias-brand-primary);}
.dshic-preview{width:100%;border-radius:8px;background:var(--dsw-alias-bg-layer-2);object-fit:contain;max-height:190px;display:block;}
.dshic-video{width:100%;max-height:190px;border-radius:8px;background:#000;display:block;}
.dshic-node-row{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;}
.dshic-node-row .dshic-flex{flex:1;min-width:0;}
.dshic-mini{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:7px;border:none;cursor:pointer;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;
  white-space:nowrap;flex:none;}
.dshic-mini:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);}
.dshic-mini:disabled{opacity:.45;cursor:default;}
.dshic-mini.is-ghost{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-secondary);}
.dshic-tag{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:5px;font-size:10px;line-height:16px;flex:none;white-space:nowrap;}
.dshic-tag.demo{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 20%,transparent);color:var(--dsw-alias-state-warn-primary);}
.dshic-tag.api{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-brand-primary);}
.dshic-tag.st{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-secondary);}
.dshic-tag.st-running{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-brand-primary);}
.dshic-tag.st-done{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);color:var(--dsw-alias-state-success-primary);}
.dshic-tag.st-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);color:var(--dsw-alias-state-error-primary);}
.dshic-err{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:15px;word-break:break-all;user-select:text;-webkit-user-select:text;}
.dshic-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;}
.dshic-port{position:absolute;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);
  border:2px solid var(--dsw-alias-label-secondary);cursor:crosshair;z-index:9;box-sizing:border-box;padding:0;}
.dshic-port.k-image{border-color:var(--dsw-alias-brand-primary);}
.dshic-port.k-video{border-color:var(--dsw-alias-state-success-primary);}
.dshic-port:hover,.dshic-port.is-active{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent);}
.dshic-port-wrap{position:absolute;width:0;height:0;}
.dshic-port-label{position:absolute;font-size:9px;color:var(--dsw-alias-label-secondary);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s;}
.dshic-node:hover .dshic-port-label{opacity:1;}
.dshic-marquee{position:absolute;border:1px solid var(--dsw-alias-brand-primary);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);pointer-events:none;z-index:30;}
.dshic-rightbar{flex:none;width:300px;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1);
  border-left:1px solid var(--dsw-alias-border-l1);}
.dshic-tabs{flex:none;display:flex;gap:2px;padding:8px 8px 0;}
.dshic-tab{flex:1;height:28px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;padding:0 4px;overflow:hidden;text-overflow:ellipsis;}
.dshic-tab:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);}
.dshic-tab.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600;}
.dshic-rb-body{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;min-height:0;}
.dshic-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;
  display:flex;flex-direction:column;gap:8px;}
.dshic-row{display:flex;align-items:center;gap:6px;min-width:0;}
.dshic-row .dshic-flex{flex:1;min-width:0;}
.dshic-proj{display:flex;align-items:center;gap:6px;padding:7px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent;}
.dshic-proj:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);}
.dshic-proj.is-active{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);}
.dshic-proj-name{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshic-proj-meta{font-size:10px;color:var(--dsw-alias-label-secondary);flex:none;}
.dshic-iconbtn{flex:none;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;}
.dshic-iconbtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary);}
.dshic-iconbtn.is-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary);}
.dshic-asset-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.dshic-asset{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);}
.dshic-asset:hover{border-color:var(--dsw-alias-brand-primary);}
.dshic-asset-thumb{width:100%;height:86px;object-fit:cover;display:block;background:var(--dsw-alias-bg-layer-2);}
.dshic-asset-meta{display:flex;align-items:center;gap:4px;padding:3px 6px;font-size:10px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}
.dshic-asset-actions{position:absolute;top:4px;right:4px;display:flex;gap:3px;opacity:0;transition:opacity .12s;}
.dshic-asset:hover .dshic-asset-actions{opacity:1;}
/* 资产名称行：所有媒体类资产统一显示名称，旁边 ✎ 重命名（与节点改名同一支笔图标） */
.dshic-asset-name{display:flex;align-items:center;gap:4px;padding:0 7px 6px;}
.dshic-asset-name-text{flex:1;min-width:0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text;-webkit-user-select:text;}
.dshic-asset-name .dshic-input{height:24px;font-size:11px;padding:0 6px;}
/* 资产所属项目下拉：改到通用/其它项目（多项目共用） */
.dshic-asset-project{width:100%;box-sizing:border-box;height:22px;margin:0 0 6px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;
  padding:0 5px;outline:none;cursor:pointer;text-align:left;}
.dshic-asset-actions .dshic-iconbtn{width:20px;height:20px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent);
  color:var(--dsw-alias-label-primary);backdrop-filter:blur(4px);}
.dshic-field{display:flex;flex-direction:column;gap:3px;}
.dshic-field-label{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dshic-menu{position:fixed;z-index:60;min-width:168px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  border-radius:10px;box-shadow:0 10px 30px color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);padding:4px;display:flex;flex-direction:column;}
.dshic-menu-item{display:flex;align-items:center;gap:8px;height:30px;padding:0 9px;border:none;border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;text-align:left;white-space:nowrap;}
.dshic-menu-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);}
.dshic-overlay{position:fixed;inset:0;z-index:50;background:transparent;}
.dshic-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}
.dshic-empty-card{pointer-events:auto;text-align:center;display:flex;flex-direction:column;gap:10px;align-items:center;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:26px 30px;}
.dshic-empty-title{font-size:15px;font-weight:600;}
.dshic-empty-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}
.dshic-spin{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);
  border-top-color:var(--dsw-alias-brand-primary);animation:dshic-rot 0.9s linear infinite;flex:none;}
@keyframes dshic-rot{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){.dshic-spin{animation:none;}}
.dshic-dot.k-shot{background:var(--dsw-alias-state-warn-primary);}
.dshic-shot-fields{display:flex;flex-direction:column;gap:5px;}
.dshic-shot-label{font-size:10px;color:var(--dsw-alias-label-secondary);}
.dshic-chips{display:flex;flex-wrap:wrap;gap:4px;}
.dshic-chip{height:22px;padding:0 9px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;flex:none;}
.dshic-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.dshic-chip.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dshic-cat{height:20px;max-width:76px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;padding:0 2px;outline:none;cursor:pointer;}
.dshic-modal-overlay{position:fixed;inset:0;z-index:80;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);
  display:flex;align-items:center;justify-content:center;}
.dshic-modal{width:340px;max-width:calc(100vw - 48px);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  border-radius:14px;box-shadow:0 18px 50px color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent);padding:16px;display:flex;flex-direction:column;gap:10px;}
.dshic-modal-title{font-size:14px;font-weight:600;}
.dshic-modal-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.dshic-modal-name{font-weight:600;color:var(--dsw-alias-label-primary);user-select:text;-webkit-user-select:text;cursor:text;}
.dshic-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px;}
.dshic-btn-outline{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);}
.dshic-btn-outline:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);}
.dshic-select{width:100%;box-sizing:border-box;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px;outline:none;cursor:pointer;}
.dshic-msel{height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:0 3px;outline:none;cursor:pointer;flex:none;}
.dshic-shot-list{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto;}
.dshic-shot-item{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:5px 7px;font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}
.dshic-shot-item strong{color:var(--dsw-alias-label-primary);font-size:11px;}
.dshic-textcard{width:100%;height:86px;box-sizing:border-box;border:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:18px;padding:7px 9px;overflow:hidden;text-align:left;display:block;white-space:pre-wrap;}
/* 文本（剧本等）资产卡：只展示标题与项目标签，不展开正文 */
.dshic-textcard.is-title{display:flex;flex-direction:column;gap:6px;justify-content:center;padding:10px 9px;color:inherit;}
.dshic-textcard-title{font-size:12px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary);word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.dshic-textcard-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);}
/* @引用高亮输入框：字号/行高/内距与 .dshic-textarea 完全一致（背景层与透明输入框必须逐像素对齐） */
.dshic-prompt{position:relative;display:block;width:100%;}
.dshic-prompt-back,.dshic-prompt-input{font:inherit;font-size:12px;line-height:18px;padding:7px 9px;box-sizing:border-box;
  white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}
.dshic-prompt-back{position:absolute;inset:0;overflow:hidden;pointer-events:none;color:var(--dsw-alias-label-primary);
  border:1px solid transparent;border-radius:6px;}
.dshic-prompt-ph{color:var(--dsw-alias-label-tertiary);}
.dshic-prompt-input{position:relative;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary);
  resize:vertical;}
.dshic-prompt-input::placeholder{color:transparent;}
.dshic-mention{color:#2f7cf6;font-weight:700;}
/* 生成中的一行思考内容：单行、省略号，让用户看到"在动"而不是卡住 */
.dshic-stream{display:flex;align-items:center;gap:5px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px;font-variant-numeric:tabular-nums;}
.dshic-stream-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:dshic-pulse 1.1s ease-in-out infinite;}
@keyframes dshic-pulse{0%,100%{opacity:.25;}50%{opacity:1;}}
.dshic-projchip{flex:none;height:15px;padding:0 5px;border-radius:4px;font-size:9px;line-height:15px;
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary);max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* 节点类型色条：左缘 accent */
.dshic-node{border-left:3px solid var(--acc, var(--dsw-alias-label-secondary));}
.dshic-node.type-text{--acc:var(--dsw-alias-label-secondary);}
.dshic-node.type-script{--acc:var(--dsw-alias-brand-primary);}
.dshic-node.type-shot, .dshic-node.type-storyboard{--acc:var(--dsw-alias-state-warn-primary);}
.dshic-node.type-image-gen, .dshic-node.type-image-asset{--acc:var(--dsw-alias-brand-primary);}
.dshic-node.type-video-gen, .dshic-node.type-video-asset{--acc:var(--dsw-alias-state-success-primary);}
.dshic-node-head .dshic-head-ic{color:var(--acc);}
/* 主操作按钮 */
.dshic-gen{width:100%;height:30px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base);font:inherit;font-size:12px;font-weight:600;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;}
.dshic-gen:disabled{opacity:.5;cursor:default;}
.dshic-gen:hover:not(:disabled){filter:brightness(1.1);}
/* 节点悬停阴影 */
.dshic-node{transition:box-shadow .15s, border-color .15s;}
.dshic-node:hover{box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);}
/* 媒体历史 */
.dshic-hist{display:flex;gap:4px;overflow-x:auto;}
.dshic-hist-thumb{width:44px;height:44px;border-radius:6px;border:2px solid var(--dsw-alias-border-l2);overflow:hidden;cursor:pointer;flex:none;
  background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);}
.dshic-hist-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.dshic-hist-thumb.is-active{border-color:var(--dsw-alias-brand-primary);}
/* 分组框 */
.dshic-group{position:absolute;box-sizing:border-box;border:1.5px dashed var(--dsw-alias-brand-primary);border-radius:14px;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent);cursor:grab;pointer-events:auto;}
.dshic-group.is-selected{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);}
.dshic-group.is-collapsed{background:var(--dsw-alias-bg-overlay);}
.dshic-group-head{display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;color:var(--dsw-alias-brand-primary);
  cursor:grab;user-select:none;-webkit-user-select:none;}
/* 对齐参考线 */
.dshic-guide-v{position:absolute;top:-5000px;width:1px;height:12000px;background:var(--dsw-alias-brand-primary);opacity:.65;pointer-events:none;z-index:40;}
.dshic-guide-h{position:absolute;left:-5000px;height:1px;width:12000px;background:var(--dsw-alias-brand-primary);opacity:.65;pointer-events:none;z-index:40;}
/* 蒙版编辑器 */
.dshic-mask-overlay{position:fixed;inset:0;z-index:90;background:color-mix(in srgb,var(--dsw-alias-bg-base) 62%,transparent);
  display:flex;align-items:center;justify-content:center;padding:16px;}
.dshic-mask-card{width:min(720px, 94vw);max-height:92vh;overflow:auto;background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;}
.dshic-mask-stage{position:relative;display:inline-block;align-self:center;max-width:100%;line-height:0;
  border:1px solid var(--dsw-alias-border-l2);}
.dshic-mask-stage img{max-width:100%;max-height:52vh;display:block;}
.dshic-mask-paint{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;}
.dshic-mask-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
/* 小地图 */
.dshic-minimap{position:absolute;right:12px;bottom:12px;width:160px;height:100px;background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;z-index:15;overflow:hidden;cursor:pointer;box-sizing:border-box;
  box-shadow:0 6px 18px color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent);touch-action:none;}
.dshic-mm-node{position:absolute;background:color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent);border-radius:1px;}
.dshic-mm-node.is-sel{background:var(--dsw-alias-brand-primary);}
.dshic-mm-view{position:absolute;border:1.5px solid var(--dsw-alias-brand-primary);border-radius:2px;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);pointer-events:none;}
/* 连线悬停删除 */
.dshic-edge-delwrap{opacity:0;cursor:pointer;pointer-events:all;transition:opacity .12s;}
.dshic-edge-g:hover .dshic-edge-delwrap{opacity:1;}
.dshic-edge-delbg{fill:var(--dsw-alias-bg-overlay);stroke:var(--dsw-alias-border-l2);stroke-width:1;}
.dshic-edge-delx{stroke:var(--dsw-alias-state-error-primary);stroke-width:1.6;stroke-linecap:round;pointer-events:none;}
/* 兼容端口高亮 */
.dshic-port{transition:transform .12s, box-shadow .12s, background .12s, border-color .12s;}
.dshic-port.is-compat{transform:scale(1.3);box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);}
/* 缩放组合按钮 */
.dshic-zoom-group{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;}
.dshic-zoom-group .dshic-btn{border-radius:0;height:26px;}
.dshic-zoom-val{min-width:52px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;cursor:pointer;background:transparent;border:none;height:26px;font:inherit;font-size:12px;}
.dshic-zoom-val:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary);}
`;

    // ============================================================
    // 本地持久化：项目 / 画布文档 / 设置
    // ============================================================
    function lsGet(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    }
    function lsSet(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略配额错误 */ }
    }
    const DEFAULT_SETTINGS = {
      // 文本模型全部用 Harness 的当前模型与默认参数：画布只选择模型，不单独配置生成参数
      textLlm: { provider: '', model: '' },
      // 供应商 + 模型两级：一个供应商（URL/Key）配一次，下面挂多个模型；★星标模型 = 节点未指定时的默认路由
      imageProviders: [],  // [{id, name, baseUrl, apiKey, extra, size?, responseFormat?, mode?, models: [{id, model}]}]
      videoProviders: [],  // [{id, name, url, apiKey, extra, outputFormat?, generateAudio?, protocol?, watermark?, models: [{id, model}]}]
      imageStar: '',       // 'providerId|modelId'
      videoStar: '',
      ttsApis: [],     // [{id, name, baseUrl, apiKey, model, voice}]
      ttsApiId: '',
      lang: '',        // '' = 跟随 Harness
      skillScript: '',       // '' = 内置编剧专家
      skillStoryboard: '',   // '' = 内置分镜专家
    };
    function loadSettings() {
      const s = lsGet(LS_SETTINGS, {}) || {};
      const out = {
        textLlm: { provider: (s.textLlm && s.textLlm.provider) || '', model: (s.textLlm && s.textLlm.model) || '' },
        imageProviders: Array.isArray(s.imageProviders) ? s.imageProviders : [],
        videoProviders: Array.isArray(s.videoProviders) ? s.videoProviders : [],
        imageStar: s.imageStar || '',
        videoStar: s.videoStar || '',
        ttsApis: Array.isArray(s.ttsApis) ? s.ttsApis : [],
        ttsApiId: s.ttsApiId || '',
        lang: s.lang || '',
        skillScript: s.skillScript || '',
        skillStoryboard: s.skillStoryboard || '',
      };
      // v0.3 及以前的单配置自动迁移为列表
      // 注意：id 必须**确定性**——loadSettings 是高频调用（每次渲染/生成都会走），
      // 若这里用 uid() 每次生成新 id，节点上保存的 apiId 会永远匹配不上、默认项也会漂移
      if (!out.imageProviders.length && !out.imageApis?.length && s.imageApi && s.imageApi.baseUrl) {
        out.imageProviders = [{
          id: 'legacy-image', name: T('defaultImageCfg'),
          baseUrl: s.imageApi.baseUrl || '', apiKey: s.imageApi.apiKey || '',
          mode: s.imageApi.mode || 'generations', models: [{ id: 'legacy-image-m', model: s.imageApi.model || '' }],
        }];
        out.imageStar = 'legacy-image|legacy-image-m';
      }
      if (!out.videoProviders.length && !out.videoApis?.length && s.videoApi && s.videoApi.url) {
        out.videoProviders = [{
          id: 'legacy-video', name: T('defaultVideoCfg'),
          url: s.videoApi.url || '', apiKey: s.videoApi.apiKey || '',
          models: [{ id: 'legacy-video-m', model: s.videoApi.model || '' }],
        }];
        out.videoStar = 'legacy-video|legacy-video-m';
      }
      // v0.17.x 扁平 API（一配置一模型）→ 供应商 + 模型列表：
      // 派生 id 确定性沿用旧 cfg id，节点上的旧 apiId 可通过 legacy 映射懒迁移
      if (!out.imageProviders.length && Array.isArray(s.imageApis) && s.imageApis.length) {
        out.imageProviders = s.imageApis.map((cfg) => ({
          id: 'p_' + cfg.id, name: cfg.name || T('defaultImageCfg'),
          baseUrl: cfg.baseUrl || '', apiKey: cfg.apiKey || '', extra: cfg.extra || '',
          size: cfg.size || '', responseFormat: cfg.responseFormat || '', mode: cfg.mode || 'generations',
          models: [{ id: 'm_' + cfg.id, model: cfg.model || '' }],
        }));
        out.imageStar = (s.imageApiId && 'p_' + s.imageApiId + '|m_' + s.imageApiId) || (out.imageProviders[0] ? out.imageProviders[0].id + '|' + out.imageProviders[0].models[0].id : '');
        legacyImageApiRefMap = {};
        for (const cfg of s.imageApis) legacyImageApiRefMap[cfg.id] = 'p_' + cfg.id + '|m_' + cfg.id;
      }
      if (!out.videoProviders.length && Array.isArray(s.videoApis) && s.videoApis.length) {
        out.videoProviders = s.videoApis.map((cfg) => ({
          id: 'p_' + cfg.id, name: cfg.name || T('defaultVideoCfg'),
          url: cfg.url || '', apiKey: cfg.apiKey || '', extra: cfg.extra || '',
          outputFormat: cfg.outputFormat || '', generateAudio: cfg.generateAudio, protocol: cfg.protocol || 'generic', watermark: cfg.watermark,
          models: [{ id: 'm_' + cfg.id, model: cfg.model || '' }],
        }));
        out.videoStar = (s.videoApiId && 'p_' + s.videoApiId + '|m_' + s.videoApiId) || (out.videoProviders[0] ? out.videoProviders[0].id + '|' + out.videoProviders[0].models[0].id : '');
        legacyVideoApiRefMap = {};
        for (const cfg of s.videoApis) legacyVideoApiRefMap[cfg.id] = 'p_' + cfg.id + '|m_' + cfg.id;
      }
      return out;
    }
    function saveSettings(s) { lsSet(LS_SETTINGS, s); }

    // ---------- 供应商 + 模型（图片/视频）：扁平视图与解析 ----------
    let legacyImageApiRefMap = {}; // 旧扁平配置 id → 'providerId|modelId'（节点字段懒迁移用）
    let legacyVideoApiRefMap = {};
    /** 供应商列表 → 扁平模型视图（ref = 'providerId|modelId'）；未填模型名的条目不进下拉。 */
    function flattenImageModels(settings) {
      const out = [];
      for (const p of settings.imageProviders || []) {
        for (const m of (p.models || [])) {
          if (!m || !m.id || !String(m.model || '').trim()) continue;
          out.push({ ref: p.id + '|' + m.id, providerId: p.id, providerName: p.name || p.id, modelId: m.id, model: String(m.model).trim(), baseUrl: p.baseUrl || '', apiKey: p.apiKey || '', extra: p.extra || '', size: p.size || '', responseFormat: p.responseFormat || '', mode: p.mode || 'generations' });
        }
      }
      return out;
    }
    function flattenVideoModels(settings) {
      const out = [];
      for (const p of settings.videoProviders || []) {
        for (const m of (p.models || [])) {
          if (!m || !m.id || !String(m.model || '').trim()) continue;
          out.push({ ref: p.id + '|' + m.id, providerId: p.id, providerName: p.name || p.id, modelId: m.id, model: String(m.model).trim(), url: p.url || '', apiKey: p.apiKey || '', extra: p.extra || '', outputFormat: p.outputFormat || '', generateAudio: p.generateAudio, protocol: p.protocol || 'generic', watermark: p.watermark });
        }
      }
      return out;
    }
    /** 解析节点上的模型引用：空 = 星标默认模型；都没有 = null（运行时报错）。 */
    function resolveImageModelCfg(settings, ref) {
      const list = flattenImageModels(settings);
      const use = String(ref || '').trim() || settings.imageStar || '';
      return list.find((x) => x.ref === use) || null;
    }
    function resolveVideoModelCfg(settings, ref) {
      const list = flattenVideoModels(settings);
      const use = String(ref || '').trim() || settings.videoStar || '';
      return list.find((x) => x.ref === use) || null;
    }
    /** 节点上的模型引用（兼容旧扁平 apiId 的懒迁移）。 */
    function nodeImageModelRef(n) {
      const d = (n && n.data) || {};
      if (d.imageModel) return d.imageModel;
      return legacyImageApiRefMap[d.imageApiId] || '';
    }
    function nodeVideoModelRef(n) {
      const d = (n && n.data) || {};
      if (d.videoModel) return d.videoModel;
      return legacyVideoApiRefMap[d.videoApiId] || '';
    }

    function emptyGraph() { return { nodes: {}, edges: [], view: { x: 60, y: 40, scale: 1 } }; }
    function loadGraphDoc(pid) { return lsGet(LS_GRAPH + pid, null); }
    function saveGraphDoc(pid, graph) { lsSet(LS_GRAPH + pid, graph); }

    // ============================================================
    // 项目设定集（Series Bible）：跨集/跨镜一致性的唯一事实源
    // ============================================================
    const LS_BIBLE = 'dsh-ic:bible:';
    const LS_BIBLE_SYNC = 'dsh-ic:biblesync:';
    function emptyBible() { return { worldview: '', style: '', characters: [], scenes: [], props: [] }; }
    function loadBible(pid) {
      if (!pid) return emptyBible();
      const b = lsGet(LS_BIBLE + pid, null);
      if (!b) return emptyBible();
      return {
        worldview: b.worldview || '',
        style: b.style || '',
        characters: Array.isArray(b.characters) ? b.characters : [],
        scenes: Array.isArray(b.scenes) ? b.scenes : [],
        props: Array.isArray(b.props) ? b.props : [],
      };
    }
    /** 只写本地（用于接收 Host 侧改写，避免回推形成环）。 */
    function saveBibleLocal(pid, b) { if (pid) lsSet(LS_BIBLE + pid, b); }
    // 上一次已同步给 Host 的设定集快照：避免每次画布保存都把（可能已被对话改过的）本地版本推回去覆盖
    const biblePushSnap = new Map();
    function bibleSnapshot(pid) { try { return JSON.stringify(loadBible(pid)); } catch { return ''; } }
    /** 需要时才推送设定集：本地内容与上次同步的一致 → 不带 bible 字段，Host 保留对话侧的新版本。 */
    function bibleFieldForPush(pid) {
      const snap = bibleSnapshot(pid);
      if (biblePushSnap.get(pid) === snap) return {};
      return { bible: loadBible(pid), __bibleChanged: true };
    }
    /** 把设定集同步到 Host：对话侧才能读写设定集（设定集先行）。内容未变则不推送（避免覆盖对话侧的新版本）。 */
    function pushBible(pid, b) {
      if (!pid) return;
      const bible = b || loadBible(pid);
      if (biblePushSnap.get(pid) === JSON.stringify(bible)) return;
      try {
        const proj = S.projects.find((p) => p.id === pid);
        const doc = loadGraphDoc(pid) || emptyGraph();
        hostRpc('projectsPut', { id: pid, name: (proj && proj.name) || pid, doc: { ...doc, bible } })
          .then((r) => {
            if (r && r.bibleUpdatedAt) {
              lsSet(LS_BIBLE_SYNC + pid, r.bibleUpdatedAt);
              biblePushSnap.set(pid, JSON.stringify(bible));
            }
          })
          .catch(() => { /* 静默 */ });
      } catch { /* 忽略 */ }
    }
    const biblePushTimers = new Map();
    /** 设定集保存：本地立即写，推送防抖（输入过程中不逐字打网络）。 */
    function saveBible(pid, b) {
      if (!pid) return;
      saveBibleLocal(pid, b);
      if (biblePushTimers.has(pid)) clearTimeout(biblePushTimers.get(pid));
      biblePushTimers.set(pid, setTimeout(() => { biblePushTimers.delete(pid); pushBible(pid, loadBible(pid)); }, 800));
    }
    function bibleBlock(b) {
      if (!b) return '';
      const lines = [];
      if ((b.worldview || '').trim()) lines.push('世界观/核心设定：' + b.worldview.trim());
      if ((b.style || '').trim()) lines.push('风格基调：' + b.style.trim());
      for (const c of b.characters || []) if ((c.name || '').trim()) lines.push(`角色 ${c.name.trim()}：${(c.desc || '').trim()}`);
      for (const c of b.scenes || []) if ((c.name || '').trim()) lines.push(`场景 ${c.name.trim()}：${(c.desc || '').trim()}`);
      for (const c of b.props || []) if ((c.name || '').trim()) lines.push(`道具 ${c.name.trim()}：${(c.desc || '').trim()}`);
      return lines.join('\n');
    }

    // ============================================================
    // @ 引用（mention）：提示词里写 @张山 → 自动带上该实体的设定集描述与其参考图资产
    // 以下为纯函数（无副作用），供 scripts/test-mentions.mjs 抽取单测
    // <<<MENTION_PURE_BEGIN>>>
    /** @名称 的词法：到空白或常见标点为止（支持中英文名与 - _ ·） */
    const MENTION_RE = /@([^\s@，。；：、,.;:!?！？()（）\[\]【】"'“”<>《》/\\|]{1,24})/g;
    /** 解析提示词里的 @名称（含位置，按出现顺序）。 */
    function parseMentions(text) {
      const out = [];
      const src = String(text || '');
      const re = new RegExp(MENTION_RE.source, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        const name = String(m[1] || '').trim();
        if (name) out.push({ name, start: m.index, end: m.index + m[0].length });
      }
      return out;
    }
    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    /** 把提示词转成高亮 HTML：@名称 用 .dshic-mention（蓝色加粗）标记。 */
    function highlightMentions(text) {
      const src = String(text || '');
      let out = '';
      let last = 0;
      const re = new RegExp(MENTION_RE.source, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        out += escapeHtml(src.slice(last, m.index));
        out += '<span class="dshic-mention">' + escapeHtml(m[0]) + '</span>';
        last = m.index + m[0].length;
      }
      out += escapeHtml(src.slice(last));
      return out === '' ? '' : out + '\n'; // 末尾补换行，保证背景层与 textarea 行高对齐
    }
    /** 送给模型前去掉 @ 标记（保留名称本体）。 */
    function stripMentionMarks(text) {
      return String(text || '').replace(new RegExp(MENTION_RE.source, 'g'), '$1');
    }
    function entityLabelOf(kind) {
      return kind === 'character' ? '角色' : kind === 'scene' ? '场景' : kind === 'prop' ? '道具' : '元素';
    }
    function entityCategoryOf(kind) {
      return kind === 'character' ? 'character' : kind === 'scene' ? 'scene' : kind === 'prop' ? 'prop' : 'general';
    }
    /** 按命名规范前缀推导资产品类：角色-/场景-/道具-/剧本-/分镜- → 对应分类（无前缀返回 ''）。
     *  用于 @引用未命中时（如对话侧直接写角色名）的兜底分类。 */
    function categoryFromName(name) {
      const n = String(name || '').trim();
      if (/^角色[-_／/]/.test(n)) return 'character';
      if (/^场景[-_／/]/.test(n)) return 'scene';
      if (/^道具[-_／/]/.test(n)) return 'prop';
      if (/^剧本[-_／/]/.test(n)) return 'script';
      if (/^分镜(表)?[-_／/]/.test(n)) return 'storyboard';
      return '';
    }
    /** 在设定集里按名称找实体（角色/场景/道具），携带其链接的资产 id。 */
    function matchBibleEntity(name, bible) {
      const want = String(name || '').trim().toLowerCase();
      if (!want) return null;
      for (const [kind, key] of [['character', 'characters'], ['scene', 'scenes'], ['prop', 'props']]) {
        for (const it of (bible && bible[key]) || []) {
          if (String((it && it.name) || '').trim().toLowerCase() === want) {
            return {
              kind, name: String(it.name).trim(), desc: String((it.desc || '')).trim(),
              assetIds: Array.isArray(it.assetIds) ? it.assetIds.map(String).filter(Boolean) : [],
            };
          }
        }
      }
      return null;
    }
    /** 资产是否属于某实体：优先显式 entity 字段，其次标准命名「角色-名称 …」（名称后须为边界，避免张山/张山峰混淆）。 */
    function assetBelongsToEntity(rec, ent) {
      if (!rec || !ent) return false;
      if (rec.entity && String(rec.entity).trim().toLowerCase() === ent.name.toLowerCase()) return true;
      const nm = String(rec.name || '').trim();
      if (!nm) return false;
      if (nm.toLowerCase() === ent.name.toLowerCase()) return true;
      const pref = entityLabelOf(ent.kind) + '-' + ent.name;
      if (!nm.startsWith(pref)) return false;
      const rest = nm.slice(pref.length);
      return rest === '' || !/[\p{L}\p{N}]/u.test(rest[0]);
    }
    /** 生成用提示词：@标记去掉 + [图N] 绑定 + 命中实体的设定描述。 */
    function buildEffectivePrompt(prompt, refs, entities, bible) {
      const zh = effLang() !== 'en';
      const bind = refs.map((r, i) => {
        if (r.entity) {
          const ent = matchBibleEntity(r.entity, bible);
          const desc = ent ? ent.desc : '';
          return `[图${i + 1}] ${entityLabelOf(ent ? ent.kind : 'prop')} ${r.entity}${desc ? '（' + desc + '）' : ''}`;
        }
        return `[图${i + 1}] ${catLabel(r.category)}：${r.name}`;
      }).join('；');
      const entLines = entities.map((e) => `${entityLabelOf(e.kind)} ${e.name}：${e.desc}`);
      return [
        (bible.style || '').trim() ? (zh ? '风格：' : 'Style: ') + bible.style.trim() : '',
        bind ? (zh ? '参考图 → ' : 'Refs -> ') + bind : '',
        stripMentionMarks(prompt),
        entLines.length ? (zh ? '设定集：' : 'Series bible: ') + entLines.join('；') : '',
      ].filter(Boolean).join('\n');
    }
    /** 资产命名时间戳（MM-DD HH:MM）：同节点多次生成靠它区分。 */
    function nowStamp() {
      return new Date().toISOString().slice(5, 16).replace('T', ' ');
    }
    /** 资产命名：**节点名 + 时间**（用户规则）；无节点名退回实体名/类型前缀 + 时间。 */
    function assetNameFor(node, entities, fallbackKind) {
      const label = String((node && node.data && node.data.label) || '').trim();
      if (label) return label + ' ' + nowStamp();
      if (entities && entities.length) return entityLabelOf(entities[0].kind) + '-' + entities[0].name + ' ' + nowStamp();
      return (fallbackKind === 'video' ? '视频' : '图片') + '-' + nowStamp();
    }
    // <<<MENTION_PURE_END>>>

    /** 解析提示词里的 @引用：返回命中实体 + 其名下的参考图资产（按实体出现顺序、各实体内按生成时间）。
     *  实体的参考图来源：① 设定条目里**链接的资产**（assetIds，绑定关系优先）
     *                  ② 其次按命名/实体字段匹配的资产（角色-张山 多视图 等）。 */
    async function resolveMentionBundle(prompt, bible, projectId) {
      const entities = [];
      for (const m of parseMentions(prompt)) {
        const hit = matchBibleEntity(m.name, bible);
        if (hit && !entities.some((e) => e.name === hit.name)) entities.push(hit);
      }
      if (!entities.length) return { entities: [], refs: [] };
      let all = [];
      try { all = (await idbByProject(projectId)).concat(await idbByProject(GENERAL_PID)); } catch { all = []; }
      const byId = new Map(all.map((r) => [r.id, r]));
      const refs = [];
      for (const ent of entities) {
        const owned = [];
        // ① 条目链接的资产（绑定优先，任何类型都认；生成时只有图片能当参考图）
        for (const aid of ent.assetIds || []) {
          const rec = byId.get(aid);
          if (rec && rec.kind === 'image') owned.push(rec);
        }
        // ② 命名/实体匹配的资产
        for (const r of all) {
          if (r.kind === 'image' && assetBelongsToEntity(r, ent) && !owned.some((x) => x.id === r.id)) owned.push(r);
        }
        owned.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        for (const r of owned) if (!refs.some((x) => x.assetId === r.id)) refs.push({ assetId: r.id, entity: ent.name, kind: ent.kind, name: r.name });
      }
      return { entities, refs };
    }
    /** 合成参考图列表：连线（用户显式顺序）优先，其后追加 @引用命中的设定集资产（去重）。 */
    async function collectRefs(n, prompt, bible) {
      const out = [];
      const edges = S.graph.edges.filter((x) => x.toNode === n.id && x.toPort === 'ref');
      const order = (n.data.refOrder || []).filter((id) => edges.some((e) => e.id === id));
      for (const e of edges) if (!order.includes(e.id)) order.push(e.id);
      for (const id of order) {
        const e = edges.find((x) => x.id === id);
        const src = e && S.graph.nodes[e.fromNode];
        if (!src) continue;
        const aid = servedAssetId(src, e.fromPort);
        if (!aid) continue;
        try {
          const rec = await idbGet(aid);
          const blob = await assetBlob(aid);
          if (blob) out.push({ assetId: aid, blob, name: (rec && rec.name) || '', category: (rec && rec.category) || 'general', source: 'wired' });
        } catch { /* 单个失败不影响其余 */ }
      }
      const bundle = await resolveMentionBundle(prompt, bible, S.activeId);
      for (const r of bundle.refs) {
        if (out.some((x) => x.assetId === r.assetId)) continue;
        try {
          const rec = await idbGet(r.assetId);
          const blob = await assetBlob(r.assetId);
          if (blob) out.push({ assetId: r.assetId, blob, name: (rec && rec.name) || r.name, category: (rec && rec.category) || 'general', source: 'mention', entity: r.entity });
        } catch { /* 忽略 */ }
      }
      return { refs: out, entities: bundle.entities };
    }

    function outLangLine() {
      return effLang() === 'en'
        ? 'Write all narrative content in English.'
        : '所有叙事内容使用中文书写。';
    }

    // ============================================================
    // 资产库（IndexedDB）
    // ============================================================
    let dbPromise = null;
    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            const os = db.createObjectStore(DB_STORE, { keyPath: 'id' });
            os.createIndex('projectId', 'projectId', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }
    async function idbPut(rec) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(rec);
        tx.oncomplete = () => resolve(rec.id);
        tx.onerror = () => reject(tx.error);
      });
    }
    async function idbGet(id) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const rq = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      });
    }
    async function idbDelete(id) {
      assetNameCache.delete(id);
      // 释放该资产的 objectURL：否则 Blob（视频可达几十 MB）会被 URL 钉在内存里直到刷新
      if (assetUrlCache.has(id)) {
        const u = assetUrlCache.get(id);
        assetUrlCache.delete(id);
        if (typeof u === 'string' && u.startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch { /* 忽略 */ } }
      }
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    async function idbByProject(pid) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const idx = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).index('projectId');
        const rq = idx.getAll(pid);
        rq.onsuccess = () => resolve((rq.result || []).sort((a, b) => b.createdAt - a.createdAt));
        rq.onerror = () => reject(rq.error);
      });
    }
    async function idbAll() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const rq = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
        rq.onsuccess = () => resolve((rq.result || []).sort((a, b) => b.createdAt - a.createdAt));
        rq.onerror = () => reject(rq.error);
      });
    }
    const assetUrlCache = new Map();
    const assetNameCache = new Map(); // assetId -> name（连线绑定的同步名称查询）
    function fileUrlFor(rel) { return '/' + NS + '/api/file?rel=' + encodeURIComponent(rel); }
    function extFromMime(mime) {
      const sub = String(mime || '').split(';')[0].split('/')[1] || 'bin';
      return /^[a-z0-9]{1,8}$/i.test(sub) ? sub : 'bin';
    }
    async function assetUrl(id) {
      if (!id) return null;
      if (assetUrlCache.has(id)) return assetUrlCache.get(id);
      const rec = await idbGet(id);
      if (!rec) return null;
      let url = null;
      if (rec.rel) url = fileUrlFor(rec.rel);              // 磁盘资产：Host 文件服务（支持 Range）
      else if (rec.blob) {
        // IndexedDB 资产：objectURL 有内存成本 → 缓存总量设上限，超出时释放最早的一批
        if (assetUrlCache.size >= 60) {
          const first = assetUrlCache.keys().next();
          if (!first.done) {
            const oldUrl = assetUrlCache.get(first.value);
            assetUrlCache.delete(first.value);
            if (typeof oldUrl === 'string' && oldUrl.startsWith('blob:')) { try { URL.revokeObjectURL(oldUrl); } catch { /* 忽略 */ } }
          }
        }
        url = URL.createObjectURL(rec.blob);
      }
      if (url) assetUrlCache.set(id, url);
      return url;
    }
    /** 取资产 Blob：磁盘资产经 Host 文件服务拉取，旧资产直接读 IndexedDB。 */
    async function assetBlob(id) {
      const rec = await idbGet(id);
      if (!rec) return null;
      if (rec.blob) return rec.blob;
      if (rec.rel) {
        const r = await fetch(fileUrlFor(rec.rel));
        if (!r.ok) throw new Error('资产读取失败 HTTP ' + r.status);
        return await r.blob();
      }
      return null;
    }
    async function saveAssetRecord(projectId, kind, blob, meta) {
      const id = uid('a');
      const mime = blob.type || (kind === 'image' ? 'image/png' : 'video/webm');
      const rec = {
        id, projectId, kind,
        mime,
        name: (meta && meta.name) || (kind === 'image' ? 'image' : 'video') + '-' + Date.now().toString(36),
        createdAt: Date.now(),
        prompt: (meta && meta.prompt) || '',
        source: (meta && meta.source) || 'demo',
        category: (meta && meta.category) || 'general',
      };
      // 设定集绑定（@引用解析依据）：entity=主实体名，entities=全部命中实体，nodeLabel=来源节点名
      if (meta && meta.entity) rec.entity = meta.entity;
      if (meta && Array.isArray(meta.entities) && meta.entities.length) rec.entities = meta.entities;
      if (meta && meta.nodeLabel) rec.nodeLabel = meta.nodeLabel;
      if (meta && meta.effectivePrompt) rec.effectivePrompt = meta.effectivePrompt;
      if (S.dataRoot) {
        // 数据根目录已配置：落盘到 <root>/projects/<项目>/<类型>/<可读名>-<id尾号>.<ext>，IndexedDB 只存元数据
        const rel = `projects/${projectId}/${kind}/${assetFileBase(rec)}.${extFromMime(mime)}`;
        const r = await fetch('/' + NS + '/api/asset?rel=' + encodeURIComponent(rel), { method: 'POST', body: blob });
        if (!r.ok) throw new Error('资产落盘失败: ' + (await r.text()));
        rec.rel = rel;
        rec.size = blob.size;
        rec.stored = 'disk';
      } else {
        rec.blob = blob;
        rec.stored = 'idb';
      }
      await idbPut(rec);
      assetNameCache.set(rec.id, rec.name);
      mirrorAssetIndex(rec); // 资产元数据镜像进数据目录 assets.json（迁移便利，失败静默）
      return rec;
    }
    /** 资产元数据索引记录（去 blob；文本资产保留 text 以便导入端免读文件即可预览）。 */
    function assetIndexRecord(rec) {
      const out = {
        id: rec.id, projectId: rec.projectId, kind: rec.kind, mime: rec.mime,
        name: rec.name, createdAt: rec.createdAt, prompt: rec.prompt || '',
        source: rec.source || '', category: rec.category || 'general',
      };
      if (rec.rel) { out.rel = rec.rel; out.size = rec.size || 0; }
      if (rec.entity) out.entity = rec.entity;
      if (Array.isArray(rec.entities) && rec.entities.length) out.entities = rec.entities;
      if (rec.nodeLabel) out.nodeLabel = rec.nodeLabel;
      if (rec.kind === 'text' && typeof rec.text === 'string') out.text = rec.text;
      return out;
    }
    /** 把资产元数据镜像进数据目录的 assets.json（失败静默：索引是迁移便利，不是主存储）。 */
    function mirrorAssetIndex(rec) {
      if (!S.dataRoot || !rec || !rec.id) return;
      const proj = S.projects.find((p) => p.id === rec.projectId);
      hostRpc('assetIndexPut', {
        projectId: rec.projectId, projectName: (proj && proj.name) || rec.projectId, asset: assetIndexRecord(rec),
      }).catch(() => { /* 索引失败不影响资产本身 */ });
    }
    /** 启动/设置数据目录后：一次性把 IndexedDB 里的全部资产元数据同步进 assets.json（补齐历史资产索引）。
     *  全量**替换**语义（含空项目占位）：IndexedDB 是资产库唯一事实源，借此自愈删除后残留的幽灵条目。 */
    let assetIndexSynced = false;
    async function syncAssetIndexToHost() {
      if (assetIndexSynced || !S.dataRoot) return;
      assetIndexSynced = true;
      try {
        const all = await idbAll();
        const items = [];
        const seen = new Set();
        const projName = new Map(S.projects.map((p) => [p.id, p.name]));
        for (const rec of all) {
          if (!rec || !rec.id || !rec.projectId) continue;
          seen.add(rec.projectId);
          items.push({ projectId: rec.projectId, projectName: projName.get(rec.projectId) || rec.projectId, asset: assetIndexRecord(rec) });
        }
        // 本机已知但没有任何资产的项目也要发占位：assets.json 清空对齐（否则删除后会残留幽灵条目）
        for (const p of S.projects) {
          if (!seen.has(p.id)) items.push({ projectId: p.id, projectName: p.name, asset: null });
        }
        if (items.length) await hostRpc('assetIndexBulkPut', { items });
      } catch { /* 索引同步失败不影响 */ }
    }
    /** 一次性把 IndexedDB 里的历史资产迁移到数据根目录（保留元数据，移除 blob）。 */
    async function migrateAssetsToDisk(onProgress) {
      if (!S.dataRoot) throw new Error('请先设置数据根目录');
      const all = await idbAll();
      // 二进制资产（有 blob）与文本资产（text，此前从不落盘）都要迁移
      const targets = all.filter((r) => (r.blob && !r.rel) || (r.kind === 'text' && !r.rel && typeof r.text === 'string' && r.text.length));
      let done = 0;
      for (const rec of targets) {
        const isText = rec.kind === 'text' && !rec.blob;
        const rel = `projects/${rec.projectId}/${rec.kind}/${assetFileBase(rec)}.${isText ? 'md' : extFromMime(rec.mime)}`;
        const blob = isText ? new Blob([rec.text || ''], { type: 'text/markdown' }) : rec.blob;
        const r = await fetch('/' + NS + '/api/asset?rel=' + encodeURIComponent(rel), { method: 'POST', body: blob });
        if (!r.ok) throw new Error('迁移失败: ' + rel + ' — ' + (await r.text()));
        const next = { ...rec, rel, size: blob.size, stored: 'disk' };
        if (isText) next.text = rec.text; // 文本保留在元数据里：预览/下载不必回读文件
        else delete next.blob;
        await idbPut(next);
        mirrorAssetIndex(next); // 迁移后刷新数据目录 assets.json（补 rel/size）
        assetUrlCache.delete(rec.id); // 旧 objectURL 失效，改走文件 URL
        done++;
        if (onProgress) onProgress(done, targets.length);
      }
      return { migrated: done, total: targets.length };
    }
    /** 启动自检：把分类为「通用」但命名符合规范前缀（角色-/场景-/道具-/剧本-/分镜-）的存量资产纠正分类。 */
    async function fixGeneralCategories() {
      try {
        const all = await idbAll();
        let fixed = 0;
        for (const rec of all) {
          if (!rec || !rec.id || (rec.kind !== 'image' && rec.kind !== 'video')) continue;
          if ((rec.category || 'general') !== 'general') continue;
          const c = categoryFromName(rec.name);
          if (!c) continue;
          const next = { ...rec, category: c };
          await idbPut(next);
          mirrorAssetIndex(next);
          fixed++;
        }
        if (fixed) {
          update((s) => { s.assetsTick++; });
          toast(T('assetCategoriesFixed').replace('{n}', String(fixed)));
        }
      } catch { /* 静默：失败不影响主流程，下次启动再试 */ }
    }
    /** 数据根目录就绪后自动把浏览器 IndexedDB 里的存量资产搬到磁盘（替代原"迁移历史资产"按钮，全自动无需手动触发）。 */
    async function autoMigrateAssetsToRoot() {
      if (!S.dataRoot) return;
      try {
        const all = await idbAll();
        const pending = all.some((r) => r && r.blob && !r.rel);
        if (!pending) return;
        const r = await migrateAssetsToDisk();
        if (r.migrated) {
          toast(T('dataRootMigrated').replace('{n}', String(r.migrated)));
          update((s) => { s.assetsTick++; });
        }
      } catch { /* 静默：迁移失败不影响主流程，下次设置数据根目录时再试 */ }
    }
    function useAssetUrl(id) {
      const [url, setUrl] = useState(null);
      useEffect(() => {
        let ok = true;
        assetUrl(id).then((u) => { if (ok) setUrl(u); });
        return () => { ok = false; };
      }, [id]);
      return url;
    }

    // ============================================================
    // 生成能力：演示模式（本地合成）+ 自定义 API
    // ============================================================
    async function demoImageBlob(prompt, refBlobs, dims) {
      const w = (dims && dims.w) || 512;
      const hgt = (dims && dims.h) || 512;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = hgt;
      const g = cv.getContext('2d');
      const refs = refBlobs || [];
      const rnd = mulberry32(hashStr((prompt || '无限画布') + '#' + refs.length));
      const hue = Math.floor(rnd() * 360);
      const bg = g.createLinearGradient(0, 0, w, hgt);
      bg.addColorStop(0, `hsl(${hue} 70% 22%)`);
      bg.addColorStop(1, `hsl(${(hue + 80) % 360} 75% 40%)`);
      g.fillStyle = bg;
      g.fillRect(0, 0, w, hgt);
      for (let i = 0; i < 6; i++) {
        const x = rnd() * w, y = rnd() * hgt, r = (0.18 + rnd() * 0.3) * w;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        const hu = (hue + i * 47 + rnd() * 30) % 360;
        gr.addColorStop(0, `hsl(${hu} 90% ${55 + rnd() * 20}% / ${0.5 + rnd() * 0.35})`);
        gr.addColorStop(1, `hsl(${hu} 90% 50% / 0)`);
        g.fillStyle = gr;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 0.22;
      g.strokeStyle = `hsl(${(hue + 180) % 360} 90% 80%)`;
      for (let i = 0; i < 3; i++) {
        g.lineWidth = 1 + rnd() * 2;
        g.beginPath();
        g.arc(rnd() * w, rnd() * hgt, (0.1 + rnd() * 0.25) * w, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
      for (let i = 0; i < 900; i++) {
        g.fillStyle = `hsla(0,0%,100%,${rnd() * 0.05})`;
        g.fillRect(rnd() * w, rnd() * hgt, 1.5, 1.5);
      }
      // 演示模式：把参考图作为"拍立得"贴到画面上，直观呈现参考图已被使用
      if (refs.length) {
        const show = refs.slice(0, 3);
        for (let i = 0; i < show.length; i++) {
          try {
            const bmp = await createImageBitmap(show[i]);
            const pw = w * 0.3, ph = pw * (bmp.height / bmp.width);
            const px = w * (0.08 + i * 0.3), py = hgt - ph - hgt * 0.08;
            g.save();
            g.translate(px + pw / 2, py + ph / 2);
            g.rotate((rnd() - 0.5) * 0.14);
            g.fillStyle = 'hsla(0,0%,100%,0.92)';
            g.fillRect(-pw / 2 - 6, -ph / 2 - 6, pw + 12, ph + 12);
            g.drawImage(bmp, -pw / 2, -ph / 2, pw, ph);
            g.restore();
          } catch { /* 跳过无法解码的参考图 */ }
        }
      }
      return await new Promise((res) => cv.toBlob(res, 'image/png'));
    }

    async function demoVideoBlob(prompt, dims, ms = 5000) {
      const w = (dims && dims.w) || 480;
      const hgt = (dims && dims.h) || 270;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = hgt;
      const g = cv.getContext('2d');
      const rnd = mulberry32(hashStr(prompt || 'demo'));
      const hues = [0, 1, 2, 3].map(() => Math.floor(rnd() * 360));
      const mimes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
      const mime = (typeof MediaRecorder !== 'undefined') && mimes.find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('当前环境不支持 MediaRecorder，无法使用演示视频生成');
      const stream = cv.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1500000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { rec.onstop = res; });
      rec.start(100);
      const t0 = performance.now();
      await new Promise((res) => {
        function frame() {
          const t = (performance.now() - t0) / 1000;
          const bg = g.createLinearGradient(0, 0, w, hgt);
          bg.addColorStop(0, `hsl(${(hues[0] + t * 20) % 360} 70% ${18 + 6 * Math.sin(t * 1.3)}%)`);
          bg.addColorStop(1, `hsl(${(hues[1] + t * 20) % 360} 72% ${30 + 6 * Math.cos(t * 1.1)}%)`);
          g.fillStyle = bg;
          g.fillRect(0, 0, w, hgt);
          for (let i = 0; i < 5; i++) {
            const ph = i * 1.7;
            const x = w / 2 + Math.sin(t * 0.9 + ph) * w * 0.28;
            const y = hgt / 2 + Math.cos(t * 0.7 + ph * 1.3) * hgt * 0.28;
            const r = (0.16 + 0.08 * Math.sin(t + i)) * w;
            const gr = g.createRadialGradient(x, y, 0, x, y, r);
            gr.addColorStop(0, `hsl(${(hues[i % 4] + t * 40) % 360} 90% 62% / 0.55)`);
            gr.addColorStop(1, `hsl(${(hues[i % 4] + t * 40) % 360} 90% 60% / 0)`);
            g.fillStyle = gr;
            g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
          }
          if (performance.now() - t0 < ms) requestAnimationFrame(frame);
          else res();
        }
        requestAnimationFrame(frame);
      });
      rec.stop();
      await stopped;
      stream.getTracks().forEach((tr) => tr.stop());
      return new Blob(chunks, { type: mime.split(';')[0] });
    }

    /** 外部 API 请求统一经 Host 代理（图片/视频/音频网关都走这里）：浏览器直连第三方接口会被
     *  CORS 拦截（带 Authorization 的 POST 触发预检，网关不返回 CORS 头 → TypeError: Failed to fetch）。
     *  返回 { ok, status, contentType, text, blob }。 */
    async function fetchViaProxy(url, { method = 'POST', headers = {}, body = null, bodyRaw = null, bodyContentType = '', timeoutMs = 120000, label = '请求' } = {}) {
      const payload = { url, method, headers, timeoutMs };
      if (bodyRaw != null) { payload.bodyRaw = bodyRaw; payload.bodyContentType = bodyContentType; }
      else if (body != null) payload.body = body;
      // 客户端→Host 的预算比上游超时多 15s：让上游超时（504/带原因）先到，而不是客户端先断
      const res = await fetchT('/' + NS + '/api/fetch-proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, Number(timeoutMs) + 15000, label + '(代理)');
      const ct = res.headers.get('content-type') || '';
      const buf = await res.arrayBuffer();
      const blob = new Blob([buf], { type: ct || 'application/octet-stream' });
      let text = '';
      if (!ct || /json|text|plain/.test(ct)) { try { text = new TextDecoder().decode(buf); } catch { text = ''; } }
      return { ok: res.ok, status: res.status, contentType: ct, text, blob };
    }
    /** 扩展参数（JSON 字符串 → 对象）：厂商专属参数的通用出口（watermark/prompt_extend/output_format/seed…）。
     *  非空但不是合法 JSON 对象时抛错（配置错误应当立刻暴露，而不是被静默吞掉）。 */
    function parseExtraParams(json) {
      const t = String(json || '').trim();
      if (!t) return null;
      const v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('扩展参数必须是 JSON 对象（如 {"watermark":false}）');
      return v;
    }
    async function apiImage(prompt, refBlobs, s, opts) {
      if (!s.baseUrl) throw new Error('未配置图片 API');
      // URL 归一化：裸域 → /v1；粘贴完整端点也不会被二次拼接
      let base = s.baseUrl.replace(/\/+$/, '').replace(/\/images\/generations$/, '');
      if (!base.replace(/^https?:\/\//i, '').includes('/')) base = base + '/v1';
      const refs = refBlobs || [];
      const auth = s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {};
      const extra = parseExtraParams(s.extra); // 厂商专属参数（留空不发送）
      const upstreamTimeout = Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 120000; // 商汤等同步接口 20s+，默认 120s
      // 参考图编辑模式：multipart 上传到 /images/edits（OpenAI gpt-image-1 兼容）
      if (refs.length && s.mode === 'edits') {
        const fd = new FormData();
        if (s.model) fd.append('model', s.model);
        fd.append('prompt', prompt);
        fd.append('n', '1');
        if (s.size) fd.append('size', s.size);
        refs.forEach((b, i) => fd.append('image[]', b, 'ref-' + i + '.png'));
        // FormData 经 Response 序列化为 multipart 字节（含 boundary）→ base64 经代理原样转发
        const serialized = new Response(fd);
        const bodyRaw = arrayBufferToBase64(await serialized.arrayBuffer());
        const bodyContentType = serialized.headers.get('content-type') || 'multipart/form-data';
        const res = await fetchViaProxy(base + '/images/edits', { headers: auth, bodyRaw, bodyContentType, timeoutMs: upstreamTimeout, label: '图片编辑 API' });
        if (!res.ok) throw new Error('图片编辑 API HTTP ' + res.status + '：' + res.text.slice(0, 300));
        let j = null;
        try { j = JSON.parse(res.text); } catch { j = null; }
        const d = j && j.data && j.data[0];
        if (d && d.b64_json) return base64ToBlob(d.b64_json, 'image/png');
        if (d && d.url) {
          const r2 = await fetchViaProxy(d.url, { method: 'GET', timeoutMs: 120000, label: '下载图片' });
          if (!r2.ok) throw new Error('下载生成图片失败 HTTP ' + r2.status);
          return r2.blob;
        }
        throw new Error('图片编辑 API 响应中没有 data[0].b64_json / url');
      }
      const body = {
        ...(s.model ? { model: s.model } : {}),
        prompt, n: 1,
      };
      // 响应格式：留空 = 用 API 默认（响应解析同时支持 b64_json 与 url）
      if (String(s.responseFormat || '').trim()) body.response_format = String(s.responseFormat).trim();
      // 尺寸：留空 = 按节点上的「清晰度 × 比例」计算；填了就用你配置的值
      const sizeOverride = String(s.size || '').trim();
      if (sizeOverride) body.size = sizeOverride;
      else { const dims = imageDimsFor(opts); body.size = `${dims.w}x${dims.h}`; }
      // 厂商专属扩展参数最后合并（可覆盖以上任何字段）：换厂商不需要改代码
      if (extra) Object.assign(body, extra);
      const res = await fetchViaProxy(base + '/images/generations', {
        headers: { 'Content-Type': 'application/json', ...auth },
        body, timeoutMs: upstreamTimeout, label: '图片 API',
      });
      if (!res.ok) throw new Error('图片 API HTTP ' + res.status + '：' + res.text.slice(0, 300));
      let j = null;
      try { j = JSON.parse(res.text); } catch { j = null; }
      const d = j && j.data && j.data[0];
      if (d && d.b64_json) return base64ToBlob(d.b64_json, 'image/png');
      if (d && d.url) {
        const r2 = await fetchViaProxy(d.url, { method: 'GET', timeoutMs: 120000, label: '下载图片' });
        if (!r2.ok) throw new Error('下载生成图片失败 HTTP ' + r2.status);
        return r2.blob;
      }
      throw new Error('图片 API 响应中没有 data[0].b64_json / url');
    }

    /** 带超时的 fetch：网关挂住时不会让节点永久处于 running（停止/刷新仍能恢复）。 */
    async function fetchT(url, init, timeoutMs, label) {
      const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => { try { if (ctrl) ctrl.abort(); } catch { /* 忽略 */ } }, ms);
      try {
        return await fetch(url, { ...(init || {}), ...(ctrl ? { signal: ctrl.signal } : {}) });
      } catch (e) {
        if (ctrl && ctrl.signal && ctrl.signal.aborted) throw new Error((label || '请求') + '超时（' + Math.round(ms / 1000) + ' 秒）');
        throw e;
      } finally { clearTimeout(timer); }
    }
    function extractVideoUrl(j) {
      if (typeof j === 'string' && /^https?:/.test(j)) return j;
      if (!j || typeof j !== 'object') return null;
      const cands = [
        j.video_url, j.videoUrl, j.url,
        j.video && j.video.url,
        j.output && (j.output.url || j.output.video_url),
        j.result && (j.result.url || j.result.video_url),
        // OpenAI 风格视频任务（如 JUAI）：完成响应把结果放在 metadata.url
        j.metadata && (j.metadata.url || j.metadata.video_url),
        Array.isArray(j.data) && j.data[0] && (j.data[0].url || j.data[0].video_url),
      ];
      return cands.find((u) => typeof u === 'string' && /^https?:/.test(u)) || null;
    }
    function extractTaskId(j) {
      if (!j || typeof j !== 'object') return null;
      return j.id ?? j.task_id ?? j.taskId ?? j.request_id
        ?? (j.data && (j.data.task_id ?? j.data.id ?? j.data.taskId))
        ?? (j.output && (j.output.task_id ?? j.output.id));
    }
    async function downloadVideo(url, headers, authFallback) {
      // 经 Host 代理：签名下载直连同样会被 CORS 拦
      let r = await fetchViaProxy(url, { method: 'GET', headers: headers || {}, timeoutMs: 300000, label: '下载视频' });
      // 认证内容代理（如 JUAI /v1/videos/{id}/content）返回 401/403 时：用 API 鉴权头重试一次
      if (!r.ok && (r.status === 401 || r.status === 403) && authFallback && Object.keys(authFallback).length) {
        r = await fetchViaProxy(url, { method: 'GET', headers: authFallback, timeoutMs: 300000, label: '下载视频' });
      }
      if (!r.ok) throw new Error('下载视频失败 HTTP ' + r.status);
      return r.blob;
    }
    /** 火山方舟 Seedance 官方协议：创建任务 → 轮询 → 下载（支持首帧 + 最多 4 张参考图）。 */
    async function seedanceVideo(prompt, frameBlob, refs, s, opts) {
      if (!s.url) throw new Error('未配置视频 API');
      if (!s.model) throw new Error('请在设置里为该视频 API 填写模型名（Seedance 协议要求显式指定模型）');
      const base = s.url.replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}) };
      const o = opts || {};
      const refBlobs = (refs || []).slice(0, 4);
      let text = prompt;
      if (refBlobs.length && !/\[图\d\]/.test(prompt)) {
        text += '\n（' + [...Array(refBlobs.length)].map((_, i) => '[图' + (i + 1) + ']').join('') + ' 为参考图，请保持其人物/场景/道具特征一致）';
      }
      const content = [{ type: 'text', text }];
      if (frameBlob) content.push({ type: 'image_url', image_url: { url: await blobToDataUrl(frameBlob) }, role: 'first_frame' });
      for (const b of refBlobs) content.push({ type: 'image_url', image_url: { url: await blobToDataUrl(b) }, role: 'reference_image' });
      const body = {
        model: s.model,
        content,
        duration: Number(o.duration) || 5,
        resolution: (o.resolution || '720P').toLowerCase(),
        watermark: s.watermark === true,
        // 勾选才发送/置 true：与通用路径的显式语义一致（默认不发送，用网关默认值）
        generate_audio: s.generateAudio === true,
      };
      try { const extra = parseExtraParams(s.extra); if (extra) Object.assign(body, extra); } catch (e) { throw new Error('视频 API 扩展参数配置有误：' + ((e && e.message) || e)); }
      body.ratio = frameBlob ? 'adaptive' : (o.ratio || '16:9');
      const res = await fetchViaProxy(base, { headers, body, timeoutMs: Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 120000, label: 'Seedance 视频 API' });
      if (!res.ok) throw new Error('Seedance HTTP ' + res.status + '：' + res.text.slice(0, 300));
      const j = JSON.parse(res.text || '{}');
      const taskId = j && j.id;
      if (!taskId) throw new Error('Seedance 响应中没有任务 id');
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(10000);
        const r2 = await fetchViaProxy(base + '/' + taskId, { method: 'GET', headers, timeoutMs: 60000, label: '查询 Seedance 任务' });
        if (!r2.ok) throw new Error('查询 Seedance 任务失败 HTTP ' + r2.status);
        const st = JSON.parse(r2.text || '{}');
        if (st.status === 'succeeded') {
          const u = st.content && st.content.video_url;
          if (!u) throw new Error('Seedance 任务成功但未返回视频地址');
          return await downloadVideo(u, {});
        }
        if (['failed', 'expired', 'canceled', 'cancelled', 'error'].includes(st.status)) {
          throw new Error('Seedance 任务失败：' + ((st.error && st.error.message) || st.status));
        }
      }
      throw new Error('Seedance 任务超时（15 分钟）');
    }
    async function apiVideo(prompt, frameBlob, s, opts) {
      const o = opts || {};
      // OpenAI 风格视频接口（JUAI 等：/v1/video/generations）优先识别——
      // 即使误把协议设成 seedance 也不走火山官方协议（两者状态/结果字段不同）
      if ((s.protocol === 'seedance' || (s.url || '').includes('contents/generations/tasks')) && !(s.url || '').includes('/video/generations')) {
        return await seedanceVideo(prompt, frameBlob, o.refs || [], s, o);
      }
      if (!s.url) throw new Error('未配置视频 API');
      // URL 归一化：裸域 → /v1/video/generations；/v1 → /video/generations；完整端点原样使用
      let base = s.url.replace(/\/+$/, '').replace(/\/video\/generations$/, '');
      if (!base.replace(/^https?:\/\//i, '').includes('/')) base = base + '/v1';
      else if (/\/v1$/.test(base)) base = base + '/video/generations';
      const isOpenaiVideo = /\/video\/generations$/.test(base);
      const headers = { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}) };
      const body = {
        ...(s.model ? { model: s.model } : {}),
        prompt,
        duration: Number(o.duration) || 5,
        // 分辨率一律小写（Seedance 系为 '720p'/'1080p'；'720P' 会被部分网关判为不支持）
        resolution: (o.resolution || '720p').toLowerCase(),
        ratio: o.ratio || '16:9',
      };
      // 首帧图生视频：构图以首帧为准——Seedance 系要求首帧模式必须 ratio=adaptive
      if (frameBlob) body.ratio = 'adaptive';
      if (frameBlob) {
        try { body.image = await blobToDataUrl(frameBlob); } catch { /* 忽略首帧编码失败 */ }
        // OpenAI 风格接口禁止首帧与参考图混用（首帧模式只认 first_frame）→ 有首帧时不带参考图
        if (!(isOpenaiVideo && o.refs && o.refs.length)) {
          if (o.refs && o.refs.length) body.images = await Promise.all(o.refs.map((b) => blobToDataUrl(b)));
        }
      } else if (o.refs && o.refs.length) {
        body.images = isOpenaiVideo
          ? await Promise.all(o.refs.map(async (b) => ({ url: await blobToDataUrl(b), role: 'reference_image' })))
          : await Promise.all(o.refs.map((b) => blobToDataUrl(b)));
      }
      // 可选参数：勾选才发送 generate_audio；output_format 留空不发送
      if (s.generateAudio === true) body.generate_audio = true;
      if (String(s.outputFormat || '').trim()) body.output_format = String(s.outputFormat).trim();
      // 厂商专属扩展参数最后合并（可覆盖以上任何字段）：换厂商不需要改代码
      try {
        const extra = parseExtraParams(s.extra);
        if (extra) Object.assign(body, extra);
      } catch (e) { throw new Error('视频 API 扩展参数配置有误：' + ((e && e.message) || e)); }
      const res = await fetchViaProxy(base, { headers, body, timeoutMs: Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 120000, label: '视频 API' });
      if (!res.ok) throw new Error('视频 API HTTP ' + res.status + '：' + res.text.slice(0, 300));
      let j = null;
      try { j = JSON.parse(res.text); } catch { /* 非 JSON 响应 */ }
      // 同源结果地址（如认证内容代理）带上鉴权下载；外部公开地址不带
      const apiOrigin = (() => { try { return new URL(base).origin; } catch { return ''; } })();
      const dlHeaders = (u) => { try { return new URL(u).origin === apiOrigin ? headers : {}; } catch { return {}; } };
      const direct = extractVideoUrl(j);
      if (direct) return await downloadVideo(direct, dlHeaders(direct), headers);
      const taskId = extractTaskId(j);
      if (!taskId) throw new Error('视频 API 响应中没有任务 id 或视频地址');
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(3000);
        const r2 = await fetchViaProxy(base + '/' + taskId, { method: 'GET', headers, timeoutMs: 60000, label: '查询视频任务' });
        if (!r2.ok) throw new Error('查询视频任务失败 HTTP ' + r2.status);
        let st = null;
        try { st = JSON.parse(r2.text); } catch { /* 忽略 */ }
        const u = extractVideoUrl(st);
        if (u) return await downloadVideo(u, dlHeaders(u), headers);
        // 失败判定必须看状态字段，不能拿整串 JSON 做子串匹配：
        // 很多网关在 processing 阶段返回 {"status":"processing","error":null}，子串匹配会误判失败
        const failed = taskFailureOf(st);
        if (failed) throw new Error('视频任务失败：' + failed);
        // 已完成却没有可提取的地址：明确报错并附响应原文，绝不无限轮询
        if (taskDoneOf(st)) throw new Error('任务已完成但响应中没有视频地址：' + JSON.stringify(st).slice(0, 300));
      }
      throw new Error('视频生成超时（15 分钟）');
    }
    /** 从任务轮询响应里取状态字符串（小写）。 */
    function taskStatusOf(st) {
      if (!st || typeof st !== 'object') return '';
      const pick = (v) => {
        if (typeof v === 'string') return v.toLowerCase();
        if (v && typeof v === 'object' && typeof v.status === 'string') return v.status.toLowerCase();
        return '';
      };
      return pick(st.status) || pick(st.state) || pick(st.task_status)
        || pick(st.data && st.data.status) || pick(st.output && st.output.status) || pick(st.result && st.result.status);
    }
    /** 从任务轮询响应里判断是否真的失败（白名单状态 + 显式错误信息），返回失败原因或 null。 */
    function taskFailureOf(st) {
      if (!st || typeof st !== 'object') return null;
      const status = taskStatusOf(st);
      const FAIL = ['failed', 'fail', 'error', 'canceled', 'cancelled', 'expired', 'rejected'];
      const DONE = ['succeeded', 'success', 'completed', 'complete', 'done', 'finished'];
      if (status && FAIL.includes(status)) {
        const msg = (st.error && (st.error.message || st.error.msg)) || st.message || st.msg || st.reason
          || (st.data && st.data.error && (st.data.error.message || st.data.error)) || status;
        return String(msg).slice(0, 300);
      }
      if (status && DONE.includes(status)) return null; // 成功但没解析出地址：交给调用方超时/后续处理
      // 状态未知（如 processing/queued/running/空）：仅在明确带有错误对象时才算失败
      const errObj = st.error || (st.data && st.data.error) || (st.output && st.output.error);
      if (errObj && (typeof errObj === 'string' ? errObj.trim() : Object.keys(errObj).length)) {
        return typeof errObj === 'string' ? errObj.slice(0, 300) : JSON.stringify(errObj).slice(0, 300);
      }
      return null;
    }
    /** 任务是否已到达成功终态——轮询方据此终止，绝不无限轮询已完成的任务。 */
    function taskDoneOf(st) {
      return ['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(taskStatusOf(st));
    }

    function resolveApiCfg(list, defId, wantId) {
      if (!Array.isArray(list) || !list.length) return null;
      return list.find((x) => x.id === wantId) || list.find((x) => x.id === defId) || list[0];
    }

    /** 从视频 Blob 提取最后一帧为 PNG（通用：任何 API 生成的视频都能取尾帧）。 */
    async function extractLastFrame(videoBlob) {
      const url = URL.createObjectURL(videoBlob);
      try {
        const v = document.createElement('video');
        v.src = url; v.muted = true; v.preload = 'auto';
        await new Promise((res, rej) => {
          v.onloadedmetadata = () => res();
          v.onerror = () => rej(new Error('视频解码失败'));
          setTimeout(res, 10000);
        });
        if (!isFinite(v.duration) || v.duration <= 0) throw new Error('视频时长不可用');
        await new Promise((res) => {
          v.onseeked = res;
          try { v.currentTime = Math.max(0, v.duration - 0.05); } catch { res(); }
          setTimeout(res, 5000);
        });
        await new Promise((res) => {
          if (v.readyState >= 2) return res();
          v.oncanplay = res;
          setTimeout(res, 3000);
        });
        const cv = document.createElement('canvas');
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        cv.getContext('2d').drawImage(v, 0, 0);
        const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
        if (!blob) throw new Error('尾帧提取失败');
        return blob;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    /** 链式下一镜：以本镜尾帧为首帧，克隆一个视频生成节点并自动连线。 */
    function chainNext(n) {
      const c = { x: n.x + 320, y: n.y + 60 };
      const nn = addNodeAt('video-gen', c);
      update((s) => {
        const nd2 = s.graph.nodes[nn.id];
        if (nd2) {
          nd2.data.prompt = n.data.prompt || '';
          nd2.data.duration = n.data.duration || 5;
          nd2.data.resolution = n.data.resolution || '720P';
          nd2.data.ratio = n.data.ratio || '16:9';
          nd2.data.videoModel = nodeVideoModelRef(n);
        }
        s.graph.edges.push({ id: uid('e'), fromNode: n.id, fromPort: 'last', toNode: nn.id, toPort: 'frame' });
      });
      pushHistory();
      toast(T('lastFrame') + ' → ' + T('portFrame') + ' ✓');
    }

    // ============================================================
    // 成片合成：按顺序把视频片段实时录制为一条成片（Canvas + MediaRecorder，含片段原声与字幕烧录）
    // ============================================================
    function drawSubtitle(g, W, H, text) {
      const t = String(text || '').trim();
      if (!t) return;
      const fs = Math.max(14, Math.round(H * 0.042));
      g.font = `600 ${fs}px sans-serif`;
      const maxW = W * 0.88;
      const lh = fs * 1.4;
      const maxLines = 3;
      // 中英混排换行：CJK 逐字、拉丁按词
      const tokens = t.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]|[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+|\s/g) || [t];
      const lines = [];
      let line = '';
      for (const tk of tokens) {
        const cand = line + tk;
        if (g.measureText(cand).width > maxW && line) {
          lines.push(line.trim());
          line = /\S/.test(tk) ? tk : '';
          if (lines.length >= maxLines) break;
        } else {
          line = cand;
        }
      }
      if (line && lines.length < maxLines) lines.push(line.trim());
      if (!lines.length) return;
      if (lines.length >= maxLines) lines[maxLines - 1] += '…';
      const boxH = lines.length * lh + fs * 0.5;
      const boxY = H - boxH - H * 0.05;
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, boxY, W, boxH);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      lines.forEach((ln, i) => g.fillText(ln, W / 2, boxY + fs * 0.25 + lh * (i + 0.5)));
      g.textAlign = 'start';
      g.textBaseline = 'alphabetic';
    }
    async function composeFinalCut(segments, opts, onProgress) {
      const W = opts.width, H = opts.height;
      const transition = opts.transition || 'none';
      const td = 600; // 叠化时长（毫秒）
      const vids = [];
      let totalMs = 0;
      for (const seg of segments) {
        const v = document.createElement('video');
        v.src = seg.url; v.preload = 'auto'; v.playsInline = true;
        await new Promise((res, rej) => {
          v.onloadedmetadata = () => res();
          v.onerror = () => rej(new Error('视频加载失败: ' + seg.name));
          setTimeout(res, 15000);
        });
        const trimSec = seg.dur && seg.dur > 0 ? Math.min(seg.dur, (isFinite(v.duration) && v.duration > 0 ? v.duration : seg.dur)) : 0;
        totalMs += trimSec * 1000 || (isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : 8000);
        vids.push({ v, name: seg.name, sub: seg.sub || '', withAudio: seg.withAudio !== false, ttsUrl: seg.ttsUrl || null, ttsEl: null, ttsSrc: null, started: false, srcNode: null, dur: seg.dur || null, startAt: 0 });
      }
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const mimes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
      const mime = (typeof MediaRecorder !== 'undefined') && mimes.find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('当前环境不支持视频录制');
      const stream = cv.captureStream(30);
      // 音频：AudioContext 汇聚各片段原声；初始化失败则降级为无声
      let audio = null;
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const dest = ac.createMediaStreamDestination();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
        audio = { ac, dest };
      } catch { audio = null; }
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        // 码率：仅在用户显式选择时指定，否则交给浏览器/编码器默认（不在代码里写死）
        ...(opts.bitrate ? { videoBitsPerSecond: Number(opts.bitrate) } : {}),
      });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { rec.onstop = res; });
      rec.start(200);
      function startPlayback(item) {
        if (item.started) return;
        item.started = true;
        item.startAt = performance.now();
        const v = item.v;
        const wantAudio = !!audio && opts.keepAudio !== false && item.withAudio;
        if (wantAudio) {
          v.muted = false; v.volume = 1;
          try { item.srcNode = audio.ac.createMediaElementSource(v); item.srcNode.connect(audio.dest); } catch { item.srcNode = null; }
        } else {
          v.muted = true;
        }
        // TTS 配音与画面同步播放（经同一 AudioContext 汇聚录制）
        if (item.ttsUrl && audio) {
          try {
            const el = new Audio(item.ttsUrl);
            const sn = audio.ac.createMediaElementSource(el);
            sn.connect(audio.dest);
            item.ttsEl = el; item.ttsSrc = sn;
          } catch { item.ttsEl = null; }
        }
        try { v.currentTime = 0; } catch { /* 忽略 */ }
        const p = v.play();
        if (p && p.catch) p.catch(() => { /* 由安全超时兜底 */ });
        if (item.ttsEl) { try { item.ttsEl.currentTime = 0; item.ttsEl.play().catch(() => { /* 忽略 */ }); } catch { /* 忽略 */ } }
      }
      function stopItem(item) {
        try { item.v.pause(); } catch { /* 忽略 */ }
        if (item.srcNode) { try { item.srcNode.disconnect(); } catch { /* 忽略 */ } item.srcNode = null; }
        if (item.ttsEl) { try { item.ttsEl.pause(); } catch { /* 忽略 */ } }
        if (item.ttsSrc) { try { item.ttsSrc.disconnect(); } catch { /* 忽略 */ } item.ttsSrc = null; }
      }
      function letterbox(src) {
        if (src.videoWidth) {
          const scale = Math.min(W / src.videoWidth, H / src.videoHeight);
          const dw = src.videoWidth * scale, dh = src.videoHeight * scale;
          g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
        }
      }
      let idx = 0;
      let done = false;
      let blackUntil = 0;
      let lastProgressIdx = -1;
      startPlayback(vids[0]);
      await new Promise((resolve) => {
        function frame() {
          if (done) return resolve();
          const now = performance.now();
          const item = vids[idx];
          const v = item.v;
          // 黑场过渡窗口
          if (blackUntil && now < blackUntil) {
            g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
            requestAnimationFrame(frame);
            return;
          }
          blackUntil = 0;
          startPlayback(item);
          if (lastProgressIdx !== idx) { lastProgressIdx = idx; if (onProgress) onProgress(idx / Math.max(1, vids.length), item.name); }
          const clipDur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
          const effDur = item.dur && item.dur > 0 ? Math.min(item.dur, clipDur || item.dur) : clipDur;
          const elapsed = item.startAt ? (now - item.startAt) / 1000 : 0;
          const remainMs = dur ? (dur - v.currentTime) * 1000 : Infinity;
          // 叠化：临近结束时提前启动下一片段
          let next = null;
          if (transition === 'fade' && idx < vids.length - 1 && remainMs <= td) {
            next = vids[idx + 1];
            startPlayback(next);
          }
          // 绘制当前片段
          g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
          letterbox(v);
          let fadeT = 0;
          if (next && next.started) {
            fadeT = clamp(1 - remainMs / td, 0, 1);
            if (next.v.videoWidth) {
              g.save(); g.globalAlpha = fadeT; letterbox(next.v); g.restore();
            }
          }
          // 字幕随叠化淡出/淡入
          if (next && fadeT > 0.5) {
            g.save(); g.globalAlpha = fadeT; drawSubtitle(g, W, H, next.sub); g.restore();
          } else {
            g.save(); g.globalAlpha = 1 - fadeT; drawSubtitle(g, W, H, item.sub); g.restore();
          }
          // 推进
          const ended = v.ended || (effDur > 0 && elapsed >= effDur - 0.03);
          if (ended) {
            stopItem(item);
            idx++;
            if (idx >= vids.length) { done = true; resolve(); return; }
            if (transition === 'black') blackUntil = now + 350;
          }
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
        setTimeout(() => { done = true; resolve(); }, totalMs + 30000);
      });
      vids.forEach(stopItem);
      rec.stop();
      await stopped;
      if (audio) { try { audio.ac.close(); } catch { /* 忽略 */ } }
      return new Blob(chunks, { type: mime.split(';')[0] });
    }

    // ============================================================
    // ArtCraft 后期工具链（同源 HTTP /artcraft/api/*，磁盘契约见 dsh-artcraft/README.md）
    // 优雅降级：任何 Craft 故障只影响 Craft 功能，不触碰生成/MediaRecorder 链路。
    // ============================================================
    const CRAFT_BASE = '/artcraft/api';
    async function craftFetch(tail, opts = {}, timeoutMs = 20000, silent = false) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const res = await fetch(CRAFT_BASE + tail, { ...(opts || {}), signal: ctrl ? ctrl.signal : undefined });
        if (!res.ok) {
          let msg = 'HTTP ' + res.status;
          try { const j = await res.clone().json(); if (j && j.error) msg = j.error; } catch { /* 保留状态码 */ }
          const e = new Error(msg);
          if (!silent) toast('Craft: ' + msg);
          throw e;
        }
        return res;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          const err = new Error(T('craftTimeout'));
          if (!silent) toast('Craft: ' + err.message);
          throw err;
        }
        if (!silent) toast('Craft: ' + ((e && e.message) || e));
        throw e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const craft = {
      status: async () => { const r = await craftFetch('/status', {}, 20000, true); return await r.json(); },
      projects: async () => { const r = await craftFetch('/projects'); return await r.json(); },
      write: async (rel, blob) => { const r = await craftFetch('/fs?action=write&rel=' + encodeURIComponent(rel), { method: 'POST', body: blob }, 180000); return await r.json(); },
      writeText: async (rel, text) => { const r = await craftFetch('/fs?action=write&rel=' + encodeURIComponent(rel), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rel, text }) }, 60000); return await r.json(); },
      readText: async (rel) => { const r = await craftFetch('/fs?op=readtext&rel=' + encodeURIComponent(rel)); return (await r.json()).text; },
      file: async (rel) => { const r = await craftFetch('/file?rel=' + encodeURIComponent(rel), {}, 180000); return await r.blob(); },
      jobStart: async (p) => { const r = await craftFetch('/job', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }, 30000); return await r.json(); },
      jobGet: async (id, tail) => { const r = await craftFetch('/job?id=' + encodeURIComponent(id) + '&tail=' + (tail || 12)); return await r.json(); },
      jobCancel: async (id) => { const r = await craftFetch('/job/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }); return await r.json(); },
      control: async (p) => { const r = await craftFetch('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }, 45000); return await r.json(); },
    };
    async function probeCraft() {
      let data = null;
      try {
        const r = await fetch(CRAFT_BASE + '/status');
        if (r.ok) data = await r.json();
      } catch { data = null; }
      update((s) => { s.craftStatus = { at: Date.now(), data }; });
      return data;
    }
    async function craftStatusSafe() {
      try { return await craft.status(); } catch { toast(T('craftUnreachable')); return null; }
    }
    function craftOkCached() {
      const cs = S.craftStatus;
      if (!cs || !cs.at || Date.now() - cs.at > 120000 || !cs.data || !cs.data.bins) return false;
      return Object.keys(cs.data.bins).some((k) => cs.data.bins[k] && cs.data.bins[k].found);
    }
    function slugifyName(name) {
      return String(name || '').replace(/[\\/:*?"<>|]/g, '').trim() || 'project';
    }
    function craftProjectSlug() {
      const p = S.projects.find((x) => x.id === S.activeId);
      if (!p) return 'project';
      if (!p.slug) {
        let base = slugifyName(p.name);
        const taken = new Set(S.projects.filter((x) => x.id !== p.id && x.slug).map((x) => x.slug));
        if (taken.has(base)) base = base + '-' + p.id.slice(-4);
        p.slug = base;
        lsSet(LS_PROJECTS, S.projects);
      }
      return p.slug;
    }
    // 资产 assetId → dataRoot 相对路径 映射（项目级元数据，localStorage）
    function craftMapLoad(pid) { return lsGet('dsh-ic:craftmap:' + pid, {}) || {}; }
    function craftMapSave(pid, map) { lsSet('dsh-ic:craftmap:' + pid, map); }
    function craftMapSet(pid, assetId, rel) { const m = craftMapLoad(pid); m[assetId] = rel; craftMapSave(pid, m); }
    function extForMime(mime, name) {
      const fromName = String(name || '').match(/(\.[a-z0-9]{2,5})$/i);
      if (fromName) return fromName[1].toLowerCase();
      const m = String(mime || '').toLowerCase();
      if (m.includes('png')) return '.png';
      if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
      if (m.includes('webp')) return '.webp';
      if (m.includes('webm')) return '.webm';
      if (m.includes('mp4')) return '.mp4';
      if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
      if (m.includes('wav')) return '.wav';
      return '.bin';
    }
    /** 资产落盘到 <项目>/media/（force=false 时已有映射则复用；force=true 覆盖写）。 */
    /** ArtCraft 工作区里的文件名：资产名（人工可读，如「角色-张山 多视图」）+ id 尾号（唯一，避免同名覆盖）。 */
    function assetFileBase(rec) {
      const raw = String((rec && rec.name) || '').trim() || String((rec && rec.id) || 'asset');
      const safe = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
      const tail = String((rec && rec.id) || '').slice(-4);
      return (safe || 'asset') + '-' + tail;
    }
    async function syncAssetToDisk(rec, opts = {}) {
      const pid = S.activeId;
      const map = craftMapLoad(pid);
      if (!opts.force && map[rec.id]) return map[rec.id];
      // Craft 后期数据统一放在**画布数据根目录**的项目目录下：projects/<项目>/<slug 前缀去掉>/craft/…
      // （ArtCraft 数据根目录 = 画布数据根目录时，即落在 <root>/projects/<项目>/craft/media/）
      const rel = 'projects/' + craftProjectSlug() + '/craft/media/' + assetFileBase(rec) + extForMime(rec.mime, rec.name);
      const blob = rec.blob || await assetBlob(rec.id);
      if (!blob) throw new Error('资产内容不可用: ' + rec.id);
      await craft.write(rel, blob);
      craftMapSet(pid, rec.id, rel);
      return rel;
    }
    async function ensureAssetOnDisk(rec) { return syncAssetToDisk(rec, { force: false }); }
    async function videoDurationOf(blob) {
      const url = URL.createObjectURL(blob);
      try {
        const v = document.createElement('video');
        v.src = url; v.muted = true; v.preload = 'metadata';
        await new Promise((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('视频解码失败')); setTimeout(res, 8000); });
        return isFinite(v.duration) && v.duration > 0 ? v.duration : 5;
      } finally { URL.revokeObjectURL(url); }
    }
    function xmlEsc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    /** FCP7 XML（xmeml v1）：媒体引用用本机绝对路径（file://localhost/...）。 */
    function buildFcp7Xml(items, o) {
      const tb = 30;
      const frames = (s) => Math.round(s * tb);
      let t = 0;
      const clipitems = [];
      items.forEach((sg, i) => {
        const id = i + 1;
        const start = frames(t), end = frames(t + sg.dur);
        const abs = String(o.dataRoot || '').replace(/\\/g, '/') + '/' + sg.rel;
        const pathurl = 'file://localhost/' + encodeURI(abs).replace(/#/g, '%23');
        clipitems.push(
          '        <clipitem id="clip-' + id + '">\n' +
          '          <name>' + xmlEsc(sg.name) + '</name>\n' +
          '          <duration>' + frames(sg.dur) + '</duration>\n' +
          '          <rate><timebase>' + tb + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
          '          <start>' + start + '</start>\n' +
          '          <end>' + end + '</end>\n' +
          '          <in>0</in>\n' +
          '          <out>' + frames(sg.dur) + '</out>\n' +
          '          <file id="file-' + id + '">\n' +
          '            <name>' + xmlEsc(sg.name) + '</name>\n' +
          '            <pathurl>' + pathurl + '</pathurl>\n' +
          '            <rate><timebase>' + tb + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
          '            <duration>' + frames(sg.dur) + '</duration>\n' +
          '            <media>\n' +
          '              <video>\n' +
          '                <samplecharacteristics>\n' +
          '                  <rate><timebase>' + tb + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
          '                  <width>' + o.width + '</width>\n' +
          '                  <height>' + o.height + '</height>\n' +
          '                </samplecharacteristics>\n' +
          '              </video>\n' +
          '              <audio><channelcount>2</channelcount></audio>\n' +
          '            </media>\n' +
          '          </file>\n' +
          '        </clipitem>');
        t += sg.dur;
      });
      return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE xmeml>\n' +
        '<xmeml version="1">\n' +
        '  <sequence id="sequence-1">\n' +
        '    <name>' + xmlEsc(o.name) + '</name>\n' +
        '    <duration>' + frames(t) + '</duration>\n' +
        '    <rate><timebase>' + tb + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
        '    <media>\n' +
        '      <video>\n' +
        '        <format>\n' +
        '          <samplecharacteristics>\n' +
        '            <rate><timebase>' + tb + '</timebase><ntsc>FALSE</ntsc></rate>\n' +
        '            <width>' + o.width + '</width>\n' +
        '            <height>' + o.height + '</height>\n' +
        '          </samplecharacteristics>\n' +
        '        </format>\n' +
        '        <track>\n' + clipitems.join('\n') + '\n        </track>\n' +
        '      </video>\n' +
        '      <audio>\n        <track/>\n      </audio>\n' +
        '    </media>\n' +
        '  </sequence>\n' +
        '</xmeml>';
    }
    function buildSrt(items) {
      const fmt = (s) => {
        const ms = Math.round(s * 1000);
        const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
        const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
        const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        const mss = String(ms % 1000).padStart(3, '0');
        return h + ':' + m + ':' + sec + ',' + mss;
      };
      let t = 0;
      const out = [];
      items.forEach((it, i) => {
        const start = t;
        t += it.dur;
        const text = String(it.sub || '').trim();
        if (!text) return;
        out.push((i + 1) + '\n' + fmt(start) + ' --> ' + fmt(t) + '\n' + text + '\n');
      });
      return out.join('\n');
    }
    /** FilmCraft 任务后台轮询：状态写回节点，done 后回收产物入资产库。 */
    async function pollFilmcraftJob(nodeId, jobId, outRel) {
      const deadline = Date.now() + 30 * 60 * 1000; // 与 jobStart 的 timeoutMs 对齐：绝不无限轮询
      for (;;) {
        if (Date.now() > deadline) {
          update((s) => { const nd = s.graph.nodes[nodeId]; if (nd) { nd.data.fcStatus = T('craftTimeout'); nd.data.fcJobId = null; } });
          return;
        }
        await sleep(2000);
        let snap;
        try { snap = await craft.jobGet(jobId, 10); } catch (e) {
          update((s) => { const nd = s.graph.nodes[nodeId]; if (nd) nd.data.fcStatus = 'error: ' + e.message; });
          return;
        }
        const tail = (snap.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || '';
        update((s) => {
          const nd = s.graph.nodes[nodeId];
          if (nd) nd.data.fcStatus = snap.status + (tail ? ' · ' + tail.slice(-90) : '');
        });
        if (snap.status === 'done') {
          try {
            const blob = await craft.file(outRel);
            const rec = await saveAssetRecord(S.activeId, 'video', blob, {
              name: T('finalCutDone') + '-FC-' + new Date().toISOString().slice(5, 16).replace('T', ' '),
              prompt: 'filmcraft export', source: 'filmcraft', category: 'finalcut',
            });
            update((s) => {
              const nd = s.graph.nodes[nodeId];
              if (nd) { nd.data.fcAssetId = rec.id; nd.data.fcStatus = null; nd.data.fcJobId = null; }
              s.assetsTick++;
            });
            toast(T('craftJobDone'));
          } catch (e) {
            update((s) => { const nd = s.graph.nodes[nodeId]; if (nd) nd.data.fcStatus = 'error: ' + e.message; });
          }
          return;
        }
        if (['failed', 'timeout', 'canceled', 'cancelled', 'error'].includes(snap.status)) {
          const detail = (snap.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
          update((s) => { const nd = s.graph.nodes[nodeId]; if (nd) nd.data.fcStatus = snap.status + '：' + detail; nd.data.fcJobId = null; });
          return;
        }
      }
    }
    const CRAFT_PRESETS = [
      { cmd: 'filter.sharpen.smartSharpen', params: { amount: 80 } },
      { cmd: 'layer.newAdjustmentLayer.curves', params: { points: [[0, 0], [64, 48], [192, 212], [255, 255]] } },
    ];
    // TODO(effectcraft 片头节点，P2 骨架)：
    //  1) 标题/时长/字体 → 生成 .ecproj（版本化 JSON）写入 <项目>/craft/intro.ecproj
    //  2) craft.jobStart({bin:'effectcraft', args:['render','--comp','Main','--out', outRel, projRel], outputs:[outRel]})
    //  3) craft.file(outRel) 回收入库；预留 file.exportLottie 导出按钮位（Lottie 可在画布网页内预览）
    //  实现时复用 craft.jobStart/craft.file 与 PhotoCraftDialog 的任务轮询模式。

    // ============================================================
    // 自动更新：当前副本版本 vs npm registry latest（与安装方式无关）
    // 有新版本 → 横幅 + "去升级"；点击后由 Host 在所属 profile 内
    // pnpm add 精确版本（绝不自动重启/刷新）；旧 Host / 开发态 / 失败 → 回退为纯引导
    // ============================================================
    async function checkUpdate(silent) {
      update((s) => { s.updateInfo = null; s.updateChecking = true; s.updateMsg = null; });
      try {
        const info = await hostRpc('updateCheck');
        // 兼容旧 Host（SHA 比较语义会给出 upToDate=false 但 behind=0）：
        // 只要有 behind 数值，就统一按"落后 N 版"判定最新与否
        if (info && typeof info.behind === 'number') info.upToDate = info.behind === 0;
        update((s) => { s.updateInfo = info; s.updateChecking = false; });
        return info;
      } catch (e) {
        update((s) => { s.updateInfo = null; s.updateChecking = false; s.updateMsg = silent ? null : String(e.message || e); });
        if (!silent) toast('更新检查失败：' + (e.message || e));
        return null;
      }
    }
    async function applyUpdate() {
      update((s) => { s.updateBusy = true; s.updateMsg = T('updateInstalling'); });
      try {
        const res = await hostRpc('updateInstall');
        if (res && res.ok && res.changed) {
          const relaxed = res.policyRelaxed ? ' ' + T('updatePolicySkipped') : '';
          update((s) => { s.updateBusy = false; s.updateMsg = T('updateInstalled') + ' v' + res.version + ' — ' + T('updateInstalledHint') + relaxed; });
        } else if (res && res.ok) {
          update((s) => { s.updateBusy = false; s.updateMsg = T('updateUpToDate') + (res.version ? ' v' + res.version : ''); });
        } else {
          const reason = res && res.output ? '（' + String(res.output).slice(-120) + '）' : '';
          update((s) => { s.updateBusy = false; s.updateMsg = T('updateFailGuide') + (res && res.version ? ' → v' + res.version : '') + reason; });
        }
      } catch (e) {
        // 旧 Host 没有 updateInstall RPC → 回退为纯引导（方案 A 兜底）
        update((s) => { s.updateBusy = false; s.updateMsg = T('npmUpgradeHint') + ((S.updateInfo && S.updateInfo.remoteVersion) ? ' → v' + S.updateInfo.remoteVersion : ''); });
      }
    }
    /** 从 Host 拉取数据根目录配置（Host 旧版无此 RPC → 标记不支持）。 */
    async function refreshDataRoot() {
      try {
        const r = await hostRpc('dataRootGet');
        update((s) => { s.dataRoot = r.dataRoot || null; s.dataRootExists = !!r.exists; s.dataRootSupported = true; });
      } catch (e) {
        update((s) => { s.dataRoot = null; s.dataRootSupported = !/未知操作/.test(String((e && e.message) || e)); });
      }
    }
    // ---------- 对话 ↔ 画布同步：轮询 Host 项目索引 + 跳转请求 ----------
    let hostSyncStopped = false;
    let hostSyncBusy = false; // hostSyncTick 互斥：单次 tick 可能超过 3 秒
    let syncWarned = false;   // 同步失败只提示一次，避免刷屏
    async function importHostProject(hp) {
      const full = await hostRpc('projectsGet', { id: hp.id });
      update((s) => {
        if (!s.projects.some((p) => p.id === hp.id)) {
          s.projects.push({ id: hp.id, name: hp.name || hp.id, createdAt: full.createdAt || Date.now(), updatedAt: full.updatedAt || Date.now() });
        }
      });
      lsSet(LS_PROJECTS, S.projects);
      saveGraphDoc(hp.id, { nodes: full.nodes || {}, edges: full.edges || [], view: full.view || { x: 60, y: 40, scale: 1 } });
      if (full.bible) {
        saveBibleLocal(hp.id, full.bible);
        if (full.bibleUpdatedAt) lsSet(LS_BIBLE_SYNC + hp.id, full.bibleUpdatedAt);
      }
    }
    const LS_DOCSYNC = 'dsh-ic:docsync:';
    /** Host 侧改动了项目文档（Agent 建节点/连线/写内容/补设定集）→ 拉回并合并到本地画布。 */
    function mergeHostDoc(pid, full) {
      if (!full) return;
      const local = loadGraphDoc(pid) || emptyGraph();
      // 节点墓碑：本地已删除的节点，绝不允许从 Host 拉回复活（删除后 3 秒内的同步拉取曾把节点又带回来）。
      // 墓碑以**内存中的当前画布**为准（可能还没落盘），否则 450ms 防抖窗口内的拉取会复活节点。
      const live = (pid === S.activeId && S.graph) ? S.graph : null;
      const deadNodes = new Set([
        ...((local.tombstones) || []),
        ...((full.tombstones) || []),
        ...((live && live.tombstones) || []),
      ]);
      // 节点以内存画布为种子（与下方 edges 的 live 优先同理）：450ms 防抖窗口内新建的节点、
      // 刚被 Ctrl+Z 恢复的节点都只存在于内存，若从落盘文档起合并会被本次合并结果抹掉
      const nodes = { ...((live && live.nodes) ? live.nodes : local.nodes) };
      for (const [nid, n] of Object.entries(full.nodes || {})) {
        if (deadNodes.has(nid)) continue;
        nodes[nid] = n; // Host 为准（Agent 写入是有意的）
      }
      const deadEdges = new Set([...(local.edgeTombstones || []), ...(full.edgeTombstones || []), ...((live && live.edgeTombstones) || [])]);
      const edges = (live && live.edges) ? [...live.edges] : [...(local.edges || [])];
      for (const e of (full.edges || [])) {
        if (deadEdges.has(e.id)) continue;
        const i = edges.findIndex((x) => x.id === e.id);
        if (i >= 0) edges[i] = e;
        else edges.push(e);
      }
      const keep = edges.filter((e) => !deadEdges.has(e.id) && nodes[e.fromNode] && nodes[e.toNode]);
      const tombOut = [...new Set([...(local.tombstones || []), ...((live && live.tombstones) || [])])].slice(-200);
      saveGraphDoc(pid, { nodes, edges: keep, view: local.view, tombstones: tombOut, edgeTombstones: local.edgeTombstones || [] });
      // 设定集随全量文档一起合并：Agent 用 canvas_update_bible 补的设定集在这里落地
      if (full.bible) {
        saveBibleLocal(pid, full.bible);
        if (full.bibleUpdatedAt) lsSet(LS_BIBLE_SYNC + pid, full.bibleUpdatedAt);
      }
      if (pid === S.activeId) update((s) => { s.graph = { nodes, edges: keep, view: s.graph.view, tombstones: tombOut, edgeTombstones: local.edgeTombstones || [] }; s.assetsTick++; });
    }
    async function hostSyncTick() {
      if (hostSyncStopped) return;
      if (hostSyncBusy) return; // 单次 tick 可能超过 3 秒：加互斥，避免两个 tick 交错写回旧文档副本
      hostSyncBusy = true;
      try {
        const r = await hostRpc('projectsSync');
        // 对话删除的项目：从本地一并移除（否则本地下次推送会把它复活）
        if (Array.isArray(r.deletedProjects) && r.deletedProjects.length) {
          const gone = new Set(r.deletedProjects);
          update((s) => {
            s.projects = s.projects.filter((p) => !gone.has(p.id));
            if (gone.has(s.activeId)) {
              if (s.projects.length === 0) {
                const p = { id: uid('p'), name: T('defaultProject'), createdAt: Date.now(), updatedAt: Date.now() };
                s.projects.push(p);
                s.activeId = p.id;
                s.graph = emptyGraph();
              } else {
                s.activeId = s.projects[0].id;
                const d0 = loadGraphDoc(s.activeId) || emptyGraph();
                s.graph = { nodes: d0.nodes || {}, edges: d0.edges || [], view: d0.view || { x: 60, y: 40, scale: 1 } };
              }
              V.x = s.graph.view.x; V.y = s.graph.view.y; V.scale = s.graph.view.scale;
              s.sel = new Set(); s.selEdge = null;
            }
          });
          for (const pid of r.deletedProjects) {
            try { localStorage.removeItem(LS_GRAPH + pid); } catch { /* 忽略 */ }
            try { localStorage.removeItem(LS_BIBLE + pid); } catch { /* 忽略 */ }
          }
          lsSet(LS_PROJECTS, S.projects);
          lsSet(LS_ACTIVE, S.activeId);
          applyViewToDomSoon();
        }
        // Agent 改动了项目文档（建节点/连线/写内容）→ 拉回合并，画布几秒内可见
        if (r.docChanged && r.docChanged.projectId) {
          const pid = r.docChanged.projectId;
          const stamp = Number(lsGet(LS_DOCSYNC + pid, 0)) || 0;
          if ((r.docChanged.at || 0) > stamp) {
            lsSet(LS_DOCSYNC + pid, String(r.docChanged.at || Date.now()));
            try {
              if (!S.projects.some((p) => p.id === pid)) {
                const hp = (r.projects || []).find((x) => x.id === pid);
                if (hp) await importHostProject(hp);
              } else {
                const full = await hostRpc('projectsGet', { id: pid });
                mergeHostDoc(pid, full);
              }
            } catch { /* 下一轮 sync 会重试不到（信号已清）——由 missing-node 路径兜底 */ }
          }
        }
        for (const hp of r.projects || []) {
        // 逐项目容错：任何一个项目合并失败（网络抖动/文件问题）都不得中断整轮，
          // 否则排在它后面的项目的设定集/节点拉取会被连累跳过
          try {
            const known = S.projects.some((p) => p.id === hp.id);
            const doc = known ? loadGraphDoc(hp.id) : null;
            // 设定集：Host 侧（对话改写）更新过 → 拉回本地（设定集先行，故优先于节点合并）
            if (known && hp.bibleUpdatedAt && hp.bibleUpdatedAt > (Number(lsGet(LS_BIBLE_SYNC + hp.id, 0)) || 0)) {
              try {
                const full = await hostRpc('projectsGet', { id: hp.id });
                if (full && full.bible) {
                  saveBibleLocal(hp.id, full.bible);
                  lsSet(LS_BIBLE_SYNC + hp.id, hp.bibleUpdatedAt);
                  biblePushSnap.set(hp.id, JSON.stringify(full.bible)); // 已是最新：后续保存不必回推
                  if (hp.id === S.activeId) update((s) => { s.assetsTick++; });
                }
              } catch { /* 忽略 */ }
            }
            // 对话删过的节点（墓碑）：本地同步删除，避免被推送复活
            const dead = (hp.tombstones || []).filter((nid) => doc && doc.nodes[nid]);
            // 内存画布为准：当前画布上还存在的节点不算死（撤销恢复后 Host 可能仍留旧墓碑）
            const liveNodes = (hp.id === S.activeId && S.graph) ? S.graph.nodes : null;
            const deadEff = liveNodes ? dead.filter((nid) => !liveNodes[nid]) : dead;
            if (known && deadEff.length) {
              for (const nid of deadEff) delete doc.nodes[nid];
              doc.edges = (doc.edges || []).filter((e) => !deadEff.includes(e.fromNode) && !deadEff.includes(e.toNode));
              saveGraphDoc(hp.id, doc);
              if (hp.id === S.activeId) {
                update((s) => {
                  for (const nid of deadEff) delete s.graph.nodes[nid];
                  s.graph.edges = s.graph.edges.filter((e) => !deadEff.includes(e.fromNode) && !deadEff.includes(e.toNode));
                  s.sel = new Set([...s.sel].filter((x) => !deadEff.includes(x)));
                  s.assetsTick++;
                });
              }
            }
            // 缺失节点拉回：跳过本地已标墓碑的节点（本地删除后 Host 尚未落地时的拉取不能让节点复活）。
            // 墓碑以内存中的当前画布为准（防抖窗口内的删除也要生效）。
            const liveT = (hp.id === S.activeId && S.graph) ? (S.graph.tombstones || []) : [];
            const localDead = new Set([...((doc && doc.tombstones) || []), ...liveT]);
            // 内存画布为准：撤销恢复的节点虽然墓碑可能还没清干净，但画布上还在 → 不能当死节点拦掉拉回
            if (hp.id === S.activeId && S.graph) {
              for (const nid of [...localDead]) { if (S.graph.nodes[nid]) localDead.delete(nid); }
            }
            const missing = (hp.nodeIds || []).filter((nid) => (!doc || !doc.nodes[nid]) && !localDead.has(nid));
            if (!known) await importHostProject(hp);
            else if (missing.length && doc) {
              const full = await hostRpc('projectsGet', { id: hp.id });
              for (const nid of missing) { if (full.nodes && full.nodes[nid]) doc.nodes[nid] = full.nodes[nid]; }
              saveGraphDoc(hp.id, doc);
              if (hp.id === S.activeId) update((s) => { for (const nid of missing) { if (full.nodes && full.nodes[nid]) s.graph.nodes[nid] = full.nodes[nid]; } s.assetsTick++; });
            }
          } catch (e) {
            if (/未知操作/.test(String((e && e.message) || e))) { hostSyncStopped = true; return; }
            // 其余失败记入控制台，继续下一个项目
            console.warn('[infinite-canvas] 项目合并失败（下轮重试）:', hp.id, e);
          }
        }
        // 一次性请求（Host 读取即清空，绝不能因后面出错而丢失）：
        // 放在逐项目循环之后、独立 try —— 循环里任何异常都不会让 runRequest 被静默吞掉
        try {
          if (r.runRequest) await handleRunRequest(r.runRequest);
        } catch (e) {
          toast(T('runRequestFailed') + '：' + String((e && e.message) || e));
        }
        try {
          if (r.openRequest) {
            const pid = r.openRequest.projectId || null;
            if (pid && !S.projects.some((p) => p.id === pid)) {
              const hp = (r.projects || []).find((x) => x.id === pid);
              if (hp) await importHostProject(hp);
            }
            if (!pid || S.projects.some((p) => p.id === pid)) {
              if (pid && pid !== S.activeId) switchProject(pid);
              try { if (CTX && CTX.layout && CTX.layout.selectPanel) CTX.layout.selectPanel(PANEL_ID); } catch { /* 忽略 */ }
            }
          }
        } catch { /* 打开失败不阻断后续同步 */ }
      } catch (e) {
        if (/未知操作/.test(String((e && e.message) || e))) hostSyncStopped = true; // 旧 Host：停止轮询
      } finally {
        hostSyncBusy = false;
      }
    }
    /** 处理对话触发的节点执行：切到目标项目 → 用画布内配置的模型/接口真实运行 → 结果回写 Host。 */
    async function handleRunRequest(runRequest) {
      const pid = runRequest.projectId;
      const nodeId = runRequest.nodeId;
      if (pid && pid !== S.activeId && S.projects.some((p) => p.id === pid)) {
        switchProject(pid);
        try { if (CTX && CTX.layout && CTX.layout.selectPanel) CTX.layout.selectPanel(PANEL_ID); } catch { /* 忽略 */ }
      }
      const node = S.graph.nodes[nodeId];
      if (!node) throw new Error('节点不存在: ' + nodeId);
      if (node.data && node.data.status === 'running') return; // 已在运行：不重复触发
      await runGenNode(node);
      flushSave();
    }
    /** 启动时把本地全部项目推给 Host：让对话能看到并操作画布上已有的项目（客户端为内容权威）。 */
    async function pushAllProjectsToHost() {
      if (hostSyncStopped) return;
      for (const p of [...S.projects]) {
        try {
          const doc = loadGraphDoc(p.id) || emptyGraph();
          await hostRpc('projectsPut', { id: p.id, name: p.name || p.id, doc });
        } catch (e) {
          if (/未知操作/.test(String((e && e.message) || e))) { hostSyncStopped = true; return; }
        }
      }
    }

    // ============================================================
    // 尺寸 / 比例（Toonflow 式：清晰度 × 比例 → 像素）
    // ============================================================
    function dimsFromRatio(ratio, longSide, shortSide) {
      const [rw, rh] = String(ratio || '16:9').split(':').map(Number);
      let w; let h;
      if (rw >= rh) { w = longSide; h = Math.round(longSide * rh / rw); }
      else { w = Math.round(shortSide * rw / rh); h = shortSide; }
      const even = (x) => Math.max(2, Math.round(x / 2) * 2);
      return { w: even(w), h: even(h) };
    }
    function imageDimsFor(opts) {
      const base = { '1K': 1024, '2K': 2048, '4K': 4096 }[(opts && opts.size) || '2K'] || 2048;
      return dimsFromRatio(opts && opts.ratio, base, base);
    }
    function videoDimsFor(opts, limits) {
      const base = { '480P': 480, '720P': 720, '1080P': 1080 }[(opts && opts.resolution) || '720P'] || 720;
      const d = dimsFromRatio(opts && opts.ratio, base, base);
      // 仅演示/本地合成路径限制长边（浏览器合成性能保护）；真实 API 与成片按你选的分辨率
      const cap = limits && Number(limits.capLong);
      if (!cap) return d;
      const long = Math.max(d.w, d.h);
      if (long > cap) {
        const k = cap / long;
        return { w: Math.round(d.w * k / 2) * 2, h: Math.round(d.h * k / 2) * 2 };
      }
      return d;
    }

    // ============================================================
    // AI 文本（剧本 / 分镜提示词）— 走 Harness 配置的 DeepSeek 模型
    // ============================================================
    async function hostRpc(method, args) {
      let res;
      try {
        res = await fetch('/infinite-canvas/api/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args: args ?? {} }),
        });
      } catch (e) {
        throw new Error(T('connectFailed') + '：' + e.message);
      }
      const raw = await res.text();
      let body = null;
      try { body = JSON.parse(raw); } catch { /* SPA 兜底页返回 HTML → Host 后台未加载最新插件 */ }
      if (!body) throw new Error(T('restartHint'));
      if (!res.ok || body.error) throw new Error(body.error || (T('rpcFail') + ' HTTP ' + res.status));
      return body;
    }
    /** 从模型输出中提取第一个平衡的 JSON 对象（兼容 ```json 围栏与 think 块）。 */
    function parseJsonBalanced(rawText) {
      const text = String(rawText ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '');
      const candidates = [];
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) candidates.push(fence[1]);
      const start = text.indexOf('{');
      if (start !== -1) {
        let depth = 0; let inStr = false; let esc = false;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
          }
          if (ch === '"') { inStr = true; continue; }
          if (ch === '{') depth++;
          if (ch === '}') {
            depth--;
            if (depth === 0) { candidates.push(text.slice(start, i + 1)); break; }
          }
        }
      }
      for (const candidate of candidates) {
        try { return JSON.parse(candidate.trim()); } catch { /* 尝试下一个候选 */ }
      }
      return null;
    }
    // AI 流式进度（不落盘：只用于"生成中"时显示一行思考内容，让用户知道没卡住）
    const AI_STREAM = new Map(); // nodeId -> { reasoning, text }
    const AI_STREAM_KEEP = 600;   // 只保留尾部若干字符，避免长思考占内存
    let aiStreamFlushTimer = null;
    function aiStreamAppend(nodeId, kind, d) {
      if (!d) return;
      const cur = AI_STREAM.get(nodeId) || { reasoning: '', text: '' };
      const next = { reasoning: cur.reasoning, text: cur.text };
      if (kind === 'reasoning') next.reasoning = (cur.reasoning + d).slice(-AI_STREAM_KEEP);
      else next.text = (cur.text + d).slice(-AI_STREAM_KEEP);
      AI_STREAM.set(nodeId, next);
      // 节流：思考内容每秒可能来几十段，重渲染节流到 300ms 一次（只展示最后一行足够了）
      if (aiStreamFlushTimer) return;
      aiStreamFlushTimer = setTimeout(() => {
        aiStreamFlushTimer = null;
        update((s) => { s.aiTick = (s.aiTick || 0) + 1; }, { quiet: true });
        notify();
      }, 300);
    }
    function aiStreamClear(nodeId) {
      AI_STREAM.delete(nodeId);
      if (aiStreamFlushTimer) { clearTimeout(aiStreamFlushTimer); aiStreamFlushTimer = null; }
    }
    /** 生成中显示的一行动态内容：优先思考，其次正文；压缩空白并只留尾部。 */
    function aiStreamLine(nodeId) {
      const s = AI_STREAM.get(nodeId);
      if (!s) return '';
      const tail = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(-180);
      return tail(s.reasoning) || tail(s.text);
    }

    /**
     * 走 Host 的流式接口生成文本：实时把「思考/正文」增量喂给 onDelta。
     * 旧 Host 没有该路由时自动回退到一次性 RPC（功能不受影响，只是没有实时预览）。
     */
    async function aiCompleteStream({ system, user, model, onReasoning, onText }) {
      const settings = loadSettings();
      let provider;
      let modelId;
      if (model && String(model).includes('|')) {
        [provider, modelId] = String(model).split('|');
      } else {
        provider = settings.textLlm.provider || undefined;
        modelId = settings.textLlm.model || undefined;
      }
      const cfg = settings.textLlm || {};
      const args = { provider, model: modelId, system, user };
      const maxTokens = Number(String(cfg.maxTokens ?? '').trim());
      if (String(cfg.maxTokens ?? '').trim() !== '' && Number.isFinite(maxTokens) && maxTokens > 0) args.maxTokens = maxTokens;
      const temperature = Number(String(cfg.temperature ?? '').trim());
      if (String(cfg.temperature ?? '').trim() !== '' && Number.isFinite(temperature)) args.temperature = temperature;
      let res;
      try {
        res = await fetch('/' + NS + '/api/llm-stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        });
      } catch (e) {
        throw new Error(T('connectFailed') + '：' + String((e && e.message) || e));
      }
      if (res.status === 404 || !res.body) return await aiComplete({ system, user, model }); // 旧 Host 回退
      if (!res.ok) throw new Error((await res.text()).slice(0, 300) || T('rpcFail'));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let final = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let msg = null;
          try { msg = JSON.parse(line.slice(6)); } catch { continue; }
          if (msg.t === 'r' && onReasoning) onReasoning(String(msg.d || ''));
          else if (msg.t === 'x' && onText) onText(String(msg.d || ''));
          else if (msg.t === 'attempt' && onReasoning) onReasoning('');
          else if (msg.t === 'done') final = msg.d || {};
          else if (msg.t === 'fail') throw new Error(String(msg.d || T('rpcFail')));
        }
      }
      if (!final) throw new Error(T('rpcFail'));
      return final.text || '';
    }

    async function aiComplete({ system, user, model }) {
      const settings = loadSettings();
      let provider;
      let modelId;
      if (model && String(model).includes('|')) {
        [provider, modelId] = String(model).split('|');
      } else {
        provider = settings.textLlm.provider || undefined;
        modelId = settings.textLlm.model || undefined;
      }
      // 生成参数一律来自设置；留空则**不发该字段**，由 Harness 适配器/模型用已配置的默认值
      const cfg = settings.textLlm || {};
      const args = { provider, model: modelId, system, user };
      const maxTokens = Number(String(cfg.maxTokens ?? '').trim());
      if (String(cfg.maxTokens ?? '').trim() !== '' && Number.isFinite(maxTokens) && maxTokens > 0) args.maxTokens = maxTokens;
      const temperature = Number(String(cfg.temperature ?? '').trim());
      if (String(cfg.temperature ?? '').trim() !== '' && Number.isFinite(temperature)) args.temperature = temperature;
      const res = await hostRpc('llmComplete', args);
      return res.text;
    }

    // 内置专家团：每个 AI 能力由对应专家 persona 驱动，并强制注入项目设定集保证一致性。
    // persona 方法论参考主流开源编剧/分镜技能（三幕结构、镜头语言、连续性规范）提炼。
    const EXPERT_SCRIPT = (zh) => zh
      ? '你是内置的「短剧编剧专家」：精通三幕结构（建置-对抗-解决）与短剧节奏。每场写清「人物目标 → 冲突 → 转折」；开场 10 秒建立钩子，结尾留下悬念；对白口语化短句，单场对话不超过 6 个来回；动作只写可拍摄的可视行为，不写心理描写。'
      : 'You are the built-in "Short-drama Screenwriter Expert": master of three-act structure and short-drama pacing. Every scene states "goal -> conflict -> turn"; hook within the first 10 seconds, cliffhanger at the end; colloquial short dialogue (max 6 exchanges per scene); visual, filmable actions only, no inner thoughts.';
    const EXPERT_STORYBOARD = (zh) => zh
      ? '你是内置的「分镜导演专家」：精通景别（远/全/中/近/特）与运镜（固定/推/拉/摇/移/跟）语言。visual 必须包含「景别 + 主体姿态 + 环境 + 光线 + 构图重心」；motion 包含「动作节拍 + 运镜方式 + 节奏」，一镜一个主体动作；相邻镜头遵守 180° 轴线、服装与光线连续；首帧信息不得与动作描述重复。'
      : 'You are the built-in "Storyboard Director Expert": fluent in shot sizes (wide/full/medium/close/ECU) and camera moves (static/push/pull/pan/track/follow). visual must include "shot size + subject pose + environment + light + framing focus"; motion includes "action beats + camera move + pacing", one subject action per shot; keep the 180-degree axis, wardrobe and lighting continuous; never duplicate first-frame info in motion.';

    async function loadSkillRules(skillName, zh) {
      if (!skillName) return null;
      try {
        const sk = await hostRpc('readSkill', { name: skillName });
        return (zh ? '严格遵循以下专业技能指引完成本任务：\n' : 'Strictly follow this professional skill guide:\n') + sk.text;
      } catch { return null; /* 技能读取失败回退内置专家 */ }
    }

    async function aiScriptNodes(idea, model, onDelta) {
      const settings = loadSettings();
      const bible = bibleBlock(loadBible(S.activeId));
      const zh = effLang() !== 'en';
      // 未选技能时默认注入内置创作方法论 canvas-craft（与内置专家 persona 叠加，互为补充）
      const rules = await loadSkillRules(settings.skillScript, zh)
        || await loadSkillRules(CRAFT_SKILL, zh)
        || (zh ? '把输入的创意或片段写成可直接拍摄的短剧剧本。只输出剧本正文，不要解释。' : 'Turn the idea or excerpt into a shootable short-drama script. Output the script only.');
      const system = [
        EXPERT_SCRIPT(zh),
        rules,
        bible ? (zh ? '项目设定集（角色/场景/道具名称与设定必须严格一致，禁止私自改名或新增设定）：\n' : 'Series bible (names and settings must strictly match; do not invent changes):\n') + bible : '',
        outLangLine(),
      ].filter(Boolean).join('\n');
      const user = zh ? [
        `创意 / 原文：\n${String(idea ?? '').trim()}`,
        '要求：',
        '- 3-8 个场次，总片长 1-3 分钟；',
        '- 每场以「场X 地点（日/夜）· 出场人物」开头；',
        '- 动作用可视化描述，不写心理；对白单独成行；需要的声音（环境音/旁白）标注在括号里；',
        '- 结尾单独一行「人物：」与「场景/道具：」清单，便于后续资产制作。',
      ].join('\n') : [
        `Idea / source:\n${String(idea ?? '').trim()}`,
        'Requirements:',
        '- 3-8 scenes, 1-3 minutes total;',
        '- Each scene starts with "SCENE X location (day/night) · characters";',
        '- Visual actions only, no inner thoughts; dialogue on its own lines; mark sounds in brackets;',
        '- End with "Characters:" and "Locations/Props:" lists for asset production.',
      ].join('\n');
      return await aiCompleteStream({
        system, user, model,
        onReasoning: (d) => onDelta && onDelta('reasoning', d),
        onText: (d) => onDelta && onDelta('text', d),
      });
    }
    async function aiStoryboardShots(scriptText, requirement, count, model, onDelta) {
      const settings = loadSettings();
      const bible = bibleBlock(loadBible(S.activeId));
      const zh = effLang() !== 'en';
      const jsonContract = zh
        ? [
            '把剧本拆解为「多镜头一次性视频生成」的分镜脚本：铺开后由**一个视频生成节点**把全部镜头按顺序与时长写进同一条提示词，由视频模型一次性生成整段视频（镜头间由模型直接硬切，不是一镜一视频再拼接）。',
            '只输出一个 JSON 对象：{"shots":[{"title":"…","visual":"…","motion":"…","characters":["…"],"scene":"…","props":["…"],"duration":3}]}。',
            '规则：',
            '- visual 是本镜画面描述（景别、人物外观与站位、场景、光线、构图，60 字内）；',
            '- **visual 与 motion 里的角色/场景/道具必须写成 @名称 引用形式**（如 `@张山`、`@褶皱巷`），插件会自动带上该实体的设定描述与其参考图资产，保证跨镜一致；',
            '- motion 是本镜动作与运镜（主体动作节拍、机位运动方向与速度、情绪节奏，50 字内）；与 visual 不重复；',
            '- characters/scene/props 使用剧本与设定集中的名称（不带 @），便于匹配资产；无道具给空数组；',
            '- duration 为该镜时长，2-5 的整数（一个镜头拍一个连续动作段落）；全部 duration 之和 = 目标视频总时长（如 15 秒 ≈ 4-7 镜）；镜头顺序即叙事顺序，首镜交代场景、末镜收束情绪；',
            '- 只输出 JSON，不要输出任何其他内容。',
          ].join('\n')
        : [
            'Break the script into shots for ONE multi-shot video generation: after expansion, a single video-gen node composes ALL shots (in order, with durations) into one prompt, and the video model generates the whole clip in one call (hard cuts inside the model — not one video per shot stitched together).',
            'Output only one JSON object: {"shots":[{"title":"…","visual":"…","motion":"…","characters":["…"],"scene":"…","props":["…"],"duration":3}]}.',
            'Rules:',
            '- visual = the shot\'s frame description (shot size, wardrobe, staging, light, framing, <=60 words);',
            '- **characters/scenes/props inside visual and motion must be written as @name references** (e.g. `@ZhangSan`); the plugin then attaches that entity\'s bible description and reference images automatically;',
            '- motion = action & camera for the shot (action beats, camera move, emotional rhythm, <=50 words); do not repeat visual;',
            '- characters/scene/props arrays must use plain names from the script and series bible (no @) so assets match; empty props array if none;',
            '- duration is the shot length in seconds, integer 2-5 (one continuous action beat per shot); the sum of durations = the target total video length (e.g. 15s ≈ 4-7 shots); shot order = narrative order; first shot establishes the scene, last shot lands the emotion;',
            '- Output JSON only.',
          ].join('\n');
      const methodology = await loadSkillRules(settings.skillStoryboard, zh)
        || await loadSkillRules(CRAFT_SKILL, zh); // 未选技能时默认注入内置创作方法论
      const system = [
        EXPERT_STORYBOARD(zh),
        methodology || '',
        jsonContract,
        bible ? (zh ? '项目设定集（名称必须与之一致）：\n' : 'Series bible (names must match):\n') + bible : '',
        outLangLine(),
      ].filter(Boolean).join('\n');
      const user = [
        `${zh ? '剧本' : 'Script'}：\n${String(scriptText ?? '').trim()}`,
        `${zh ? '额外要求' : 'Extra requirements'}：${String(requirement ?? '').trim() || (zh ? '无' : 'none')}`,
        `${zh ? '目标分镜数量' : 'Shot count'}：${count}`,
      ].join('\n\n');
      const text = await aiCompleteStream({
        system, user, model,
        onReasoning: (d) => onDelta && onDelta('reasoning', d),
        onText: (d) => onDelta && onDelta('text', d),
      });
      const parsed = parseJsonBalanced(text);
      const shots = parsed && Array.isArray(parsed.shots) ? parsed.shots : null;
      if (!shots || !shots.length) {
        // 解析失败必须带上下文（长度 + 首尾原文），才能判断是被截断还是格式跑偏
        const raw = String(text || '').trim();
        const head = raw.slice(0, 160);
        const tail = raw.slice(-160);
        throw new Error(T('errParseStoryboard') + '（正文 ' + raw.length + ' 字；开头: ' + head + '；结尾: ' + tail + '）');
      }
      return shots.slice(0, 24).map((s, i) => ({
        title: String(s.title || (T('shotPrefix') + (i + 1))).slice(0, 24),
        visual: String(s.visual || ''),
        motion: String(s.motion || ''),
        characters: Array.isArray(s.characters) ? s.characters.map(String).slice(0, 6) : [],
        scene: String(s.scene || ''),
        props: Array.isArray(s.props) ? s.props.map(String).slice(0, 6) : [],
        duration: Number.isFinite(Number(s.duration)) ? clamp(Math.round(Number(s.duration)), 1, 15) : 3,
      }));
    }
    /** 本地一致性检查：分镜里出现的角色/场景/道具（含 visual/motion 文本里的 @提及）是否都在
     *  设定集/资产中登记；两级告警——「未登记」与「已登记但描述为空（待补全）」。 */
    async function checkShotConsistency(shots) {
      const bible = loadBible(S.activeId);
      const entries = [];
      const addEntry = (kind, name, desc) => {
        const nm = String(name || '').trim();
        if (nm) entries.push({ kind, name: nm, desc: String(desc || ''), lower: nm.toLowerCase() });
      };
      (bible.characters || []).forEach((c) => addEntry(T('catCharacter'), c && c.name, c && c.desc));
      (bible.scenes || []).forEach((c) => addEntry(T('catScene'), c && c.name, c && c.desc));
      (bible.props || []).forEach((c) => addEntry(T('catProp'), c && c.name, c && c.desc));
      const known = new Set(entries.map((e) => e.lower));
      try { ((await idbByProject(S.activeId)).concat(await idbByProject(GENERAL_PID))).forEach((r) => { const q = String(r && r.name || '').trim().toLowerCase(); if (q) known.add(q); }); } catch { /* 忽略 */ }
      const warnings = [];
      const seen = new Set();
      const warn = (line) => { if (!seen.has(line) && warnings.length < 12) { seen.add(line); warnings.push(line); } };
      const check = (title, kind, name) => {
        const q = String(name || '').trim().toLowerCase();
        if (!q) return;
        const exact = entries.find((e) => e.lower === q);
        if (exact) {
          if (!exact.desc.trim()) warn(`${title} · ${kind}「${exact.name}」${T('warnEmptyDesc')}`);
          return;
        }
        for (const k of known) { if (k.includes(q) || q.includes(k)) return; }
        warn(`${title} · ${kind}「${String(name).trim()}」${T('warnUnregistered')}`);
      };
      for (const sh of shots) {
        const title = String(sh.title || '').trim() || T('shotPrefix');
        for (const nm of (sh.characters || [])) check(title, T('catCharacter'), nm);
        check(title, T('catScene'), sh.scene);
        for (const nm of (sh.props || [])) check(title, T('catProp'), nm);
        // visual/motion 文本里的 @提及 同样纳入检查（数组外的实体也要登记，杜绝检查漏）
        const text = String(sh.visual || '') + ' ' + String(sh.motion || '');
        for (const m of (text.match(/@[^\s@，。；、！？:：（）"'）)]+/g) || [])) {
          check(title, T('catMention'), m.slice(1).replace(/[）)]+$/, ''));
        }
      }
      return warnings;
    }
    /** 分镜生成后：把设定集里没有的角色/场景/道具自动补进设定集（描述留空待用户补充）。 */
    async function autoRegisterBibleEntries(shots) {
      const bible = loadBible(S.activeId);
      const known = new Set();
      const addName = (n) => { const q = String(n || '').trim().toLowerCase(); if (q) known.add(q); };
      (bible.characters || []).forEach((c) => addName(c.name));
      (bible.scenes || []).forEach((c) => addName(c.name));
      (bible.props || []).forEach((c) => addName(c.name));
      try { ((await idbByProject(S.activeId)).concat(await idbByProject(GENERAL_PID))).forEach((r) => addName(r.name)); } catch { /* 忽略 */ }
      const next = { characters: [...bible.characters], scenes: [...bible.scenes], props: [...bible.props] };
      let added = 0;
      const push = (kind, name) => {
        const q = String(name || '').trim();
        if (!q) return;
        const ql = q.toLowerCase();
        if ([...known].some((k) => k.includes(ql) || ql.includes(k))) return;
        known.add(ql);
        next[kind].push({ name: q, desc: '', assetIds: [] });
        added++;
      };
      for (const sh of shots) {
        (sh.characters || []).forEach((n) => push('characters', n));
        push('scenes', sh.scene);
        (sh.props || []).forEach((n) => push('props', n));
      }
      if (added) {
        saveBible(S.activeId, { ...bible, ...next });
        toast(T('bibleAutoAdd').replace('{n}', String(added)));
      }
    }
    async function saveTextAssetRecord(projectId, meta) {
      const rec = {
        id: uid('a'), projectId, kind: 'text',
        mime: 'text/markdown',
        name: (meta && meta.name) || 'text-' + Date.now().toString(36),
        text: String((meta && meta.text) ?? ''),
        blob: null,
        createdAt: Date.now(),
        prompt: (meta && meta.prompt) || '',
        source: (meta && meta.source) || 'ai',
        category: (meta && meta.category) || 'script',
      };
      // 文本资产同样落盘到数据根目录（<root>/projects/<项目>/text/<名>.md），
      // IndexedDB 保留元数据与 text 字段（文本很小，预览/下载不必回读文件）。
      // 落盘失败降级为仅 IndexedDB（绝不阻塞生成主流程），控制台留痕。
      if (S.dataRoot) {
        try {
          const rel = `projects/${projectId}/text/${assetFileBase(rec)}.md`;
          const blob = new Blob([rec.text], { type: 'text/markdown' });
          const r = await fetch('/' + NS + '/api/asset?rel=' + encodeURIComponent(rel), { method: 'POST', body: blob });
          if (!r.ok) throw new Error(await r.text());
          rec.rel = rel;
          rec.size = blob.size;
          rec.stored = 'disk';
        } catch (err) {
          console.warn('[infinite-canvas] 文本资产落盘失败（降级为浏览器存储）:', String((err && err.message) || err));
        }
      }
      await idbPut(rec);
      assetNameCache.set(rec.id, rec.name);
      mirrorAssetIndex(rec); // 文本资产元数据同样镜像进 assets.json
      return rec;
    }

    // ============================================================
    // 应用状态（模块级单例；面板卸载/重挂载不丢状态）
    // ============================================================
    const S = {
      ready: false,
      projects: [],
      activeId: null,
      graph: emptyGraph(),
      sel: new Set(),
      selEdge: null,
      running: false,
      rightOpen: true,
      rightTab: 'projects',
      menu: null,          // {x, y, kind:'add'}
      assetsTick: 0,
      tick: 0,
      craftStatus: null, // {at, data} | {at, error}
      dataRoot: null,        // 数据根目录（Host 配置）；null = 未设置（资产走 IndexedDB）
      dataRootExists: false,
      dataRootSupported: true,
      updateInfo: null,      // Host updateCheck 结果
      updateChecking: false,
      updateBusy: false,
      updateMsg: null,
      updateDismissed: false,
    };
    const listeners = new Set();
    let saveTimer = null;
    let commitViewTimer = null;

    function notify() { S.tick++; for (const fn of listeners) fn(); }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function update(fn, opts) {
      const edgesBefore = S.graph ? S.graph.edges : null; // 引用比较：fn 换了数组说明发生过边增删
      fn(S);
      // 边墓碑：画布上删除的连线自动记录，Host 合并时据此判定"真的被删了"（否则会被并回来）
      if (S.graph && S.graph.edges && edgesBefore && S.graph.edges !== edgesBefore) {
        const gone = new Set(edgesBefore.map((e) => e.id));
        for (const e of S.graph.edges) gone.delete(e.id);
        if (gone.size) S.graph.edgeTombstones = [...new Set([...(S.graph.edgeTombstones || []), ...gone])].slice(-400);
      }
      if (!opts || !opts.quiet) notify();
      scheduleSave();
    }
    function scheduleSave() {
      if (!S.ready) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSave, 450);
    }
    function flushSave() {
      if (!S.ready || !S.activeId) return;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      saveGraphDoc(S.activeId, S.graph);
      const proj = S.projects.find((p) => p.id === S.activeId);
      if (proj) proj.updatedAt = Date.now();
      lsSet(LS_PROJECTS, S.projects);
      lsSet(LS_ACTIVE, S.activeId);
      try {
        // 设定集只在本地确实变化时才带上：否则会把对话侧刚改的版本覆盖回去
        const bibleField = bibleFieldForPush(S.activeId);
        hostRpc('projectsPut', {
          id: S.activeId, name: (proj && proj.name) || S.activeId,
          doc: {
            ts: Date.now(), // 推送发出时刻：Host 据此区分"撤销恢复"（清墓碑）与"陈旧推送"（墓碑继续生效）
            nodes: S.graph.nodes, edges: S.graph.edges, view: S.graph.view,
            tombstones: S.graph.tombstones || [], // 本地删除标记：Host 依据它判定节点真的被删
            ...(bibleField.__bibleChanged ? { bible: bibleField.bible } : {}),
          },
        }).then((r) => {
          if (bibleField.__bibleChanged && r && r.bibleUpdatedAt) {
            lsSet(LS_BIBLE_SYNC + S.activeId, r.bibleUpdatedAt);
            biblePushSnap.set(S.activeId, JSON.stringify(bibleField.bible));
          }
        }).catch((err) => {
          // 同步失败必须让用户知道：否则对话侧看到的是旧内容，用户以为"刚写的对话里查不到"
          if (!syncWarned) { syncWarned = true; toast(T('syncFailed') + '：' + String((err && err.message) || err)); }
        });
      } catch { /* 忽略 */ }
    }
    function initStore() {
      S.projects = lsGet(LS_PROJECTS, []);
      if (!Array.isArray(S.projects) || S.projects.length === 0) {
        S.projects = [{ id: uid('p'), name: T('defaultProject'), createdAt: Date.now(), updatedAt: Date.now() }];
        lsSet(LS_PROJECTS, S.projects);
      }
      const active = lsGet(LS_ACTIVE, null);
      S.activeId = S.projects.some((p) => p.id === active) ? active : S.projects[0].id;
      const doc = loadGraphDoc(S.activeId) || emptyGraph();
      S.graph = { nodes: doc.nodes || {}, edges: doc.edges || [], view: doc.view || { x: 60, y: 40, scale: 1 } };
      // 页面刷新/关闭会中断进行中的生成：清理残留的 running 状态，避免节点永远卡在"运行中"
      let stale = false;
      for (const n of Object.values(S.graph.nodes || {})) {
        if (n && n.data && (n.data.status === 'running' || n.data.aiStatus === 'running')) {
          n.data.status = 'idle';
          if (n.data.aiStatus === 'running') { n.data.aiStatus = 'error'; n.data.aiError = T('aiInterrupted'); }
          n.data.progress = null;
          stale = true;
        }
      }
      if (stale) { try { saveGraphDoc(S.activeId, S.graph); } catch { /* 忽略 */ } }
      V.x = S.graph.view.x; V.y = S.graph.view.y; V.scale = S.graph.view.scale;
      S.ready = true;
      // 预热设定集快照：页面加载时视本地版本为"已同步"，避免把旧版本推回覆盖对话侧的新设定
      for (const p of S.projects) biblePushSnap.set(p.id, bibleSnapshot(p.id));
    }
    function switchProject(pid) {
      if (pid === S.activeId) return;
      flushSave();
      const doc = loadGraphDoc(pid) || emptyGraph();
      update((s) => {
        s.activeId = pid;
        s.graph = { nodes: doc.nodes || {}, edges: doc.edges || [], view: doc.view || { x: 60, y: 40, scale: 1 } };
        s.sel = new Set(); s.selEdge = null;
        // 注意：不复位 s.running —— 否则运行中切项目会让"运行工作流"重新可点，并发跑同一节点
        V.x = s.graph.view.x; V.y = s.graph.view.y; V.scale = s.graph.view.scale;
        applyViewToDom();
      });
      // 撤销栈必须按项目隔离：否则在新项目里按 Ctrl+Z 会把上一个项目的节点写进来（覆盖数据）
      history.stack = [];
      history.idx = -1;
      pushHistory();
    }

    // ============================================================
    // 撤销 / 重做（图快照，文本输入不逐字入栈）
    // ============================================================
    const history = { stack: [], idx: -1 };
    function snapshotGraph() {
      return JSON.stringify({ nodes: S.graph.nodes, edges: S.graph.edges });
    }
    function pushHistory() {
      const snap = snapshotGraph();
      if (history.stack[history.idx] === snap) return;
      history.stack = history.stack.slice(0, history.idx + 1);
      history.stack.push(snap);
      if (history.stack.length > 60) history.stack.shift();
      history.idx = history.stack.length - 1;
    }
    function restoreHistory() {
      const snap = history.stack[history.idx];
      if (!snap) return;
      const doc = JSON.parse(snap);
      const prevIds = S.graph ? Object.keys(S.graph.nodes || {}) : [];
      update((s) => {
        s.graph.nodes = doc.nodes;
        s.graph.edges = doc.edges;
        // 撤销/重做必须对齐墓碑：快照里消失的节点=这次撤销动作删掉的（补墓碑，防同步复活）；
        // 快照里出现的节点=被恢复的（撤墓碑，否则 Ctrl+Z 恢复的节点会被下一轮同步按旧墓碑再次抹掉）
        const live = new Set(Object.keys(s.graph.nodes || {}));
        s.graph.tombstones = [...new Set([...(s.graph.tombstones || []), ...prevIds])]
          .filter((id) => !live.has(id)).slice(-200);
        s.sel = new Set();
        s.selEdge = null;
      });
    }
    function undo() {
      if (history.idx <= 0) return;
      history.idx--;
      restoreHistory();
    }
    function redo() {
      if (history.idx >= history.stack.length - 1) return;
      history.idx++;
      restoreHistory();
    }

    // ============================================================
    // 视口（直接驱动 DOM，交互结束才提交到状态）
    // ============================================================
    const V = { x: 60, y: 40, scale: 1 };
    let worldEl = null;
    let canvasEl = null;
    const nodeEls = new Map();     // nodeId -> HTMLElement
    const edgePathEls = new Map(); // edgeId -> SVGPathElement
    let tempEdgeEl = null;
    let marqueeEl = null;
    let vGuidEl = null;
    let hGuidEl = null;
    function showGuides(vx, hy) {
      if (vGuidEl) { if (vx != null) { vGuidEl.style.display = 'block'; vGuidEl.style.left = vx + 'px'; } else vGuidEl.style.display = 'none'; }
      if (hGuidEl) { if (hy != null) { hGuidEl.style.display = 'block'; hGuidEl.style.top = hy + 'px'; } else hGuidEl.style.display = 'none'; }
    }
    function hideGuides() {
      if (vGuidEl) vGuidEl.style.display = 'none';
      if (hGuidEl) hGuidEl.style.display = 'none';
    }

    function applyViewToDom() {
      if (worldEl) worldEl.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.scale})`;
      if (canvasEl) {
        canvasEl.style.backgroundSize = `${22 * V.scale}px ${22 * V.scale}px`;
        canvasEl.style.backgroundPosition = `${V.x}px ${V.y}px`;
      }
    }
    function setView(x, y, scale, commit) {
      V.x = x; V.y = y; V.scale = scale;
      applyViewToDom();
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      if (commit) {
        S.graph.view = { x, y, scale };
        scheduleSave();
      } else {
        commitTimer = setTimeout(() => {
          commitTimer = null;
          S.graph.view = { x: V.x, y: V.y, scale: V.scale };
          scheduleSave();
        }, 240);
      }
    }
    let commitTimer = null;

    function containerRect() { return canvasEl ? canvasEl.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 }; }
    function screenToWorld(sx, sy) {
      const r = containerRect();
      return { x: (sx - r.left - V.x) / V.scale, y: (sy - r.top - V.y) / V.scale };
    }
    function worldCenter() {
      const r = containerRect();
      return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
    }

    // ============================================================
    // 图模型操作
    // ============================================================
    function newNode(type, pos) {
      const inputs = PORTS[type].inputs, outputs = PORTS[type].outputs;
      const portRows = Math.max(inputs.length, outputs.length);
      const data = { status: 'idle', error: null };
      if (type === 'text') data.text = '';
      if (type === 'shot') { data.visual = ''; data.motion = ''; }
      if (type === 'script') { data.idea = ''; data.output = ''; data.aiStatus = 'idle'; data.aiError = null; }
      if (type === 'storyboard') {
        data.script = ''; data.requirement = ''; data.count = 6;
        data.shots = []; data.aiStatus = 'idle'; data.aiError = null;
      }
      if (type === 'image-gen' || type === 'video-gen') {
        data.prompt = ''; data.assetId = null; data.demo = false;
        if (type === 'image-gen') { data.size = '2K'; data.ratio = '16:9'; }
        else { data.duration = 5; data.resolution = '720P'; data.ratio = '16:9'; }
      }
      if (type === 'image-asset' || type === 'video-asset') data.assetId = null;
      if (type === 'finalcut') {
        data.resolution = '720P'; data.ratio = '16:9'; data.transition = 'none';
        data.status = 'idle'; data.error = null; data.progress = null; data.assetId = null;
        data.subs = {}; data.keepAudio = true;
      }
      if (type === 'group') {
        data.members = []; data.collapsed = false; data.hidden = false;
        data.label = T('group');
      }
      return {
        id: uid('n'), type,
        x: Math.round(pos.x), y: Math.round(pos.y),
        w: type === 'script' ? 340 : type === 'storyboard' ? 360 : type === 'text' ? 280 : NODE_W,
        h: 96 + portRows * 4,
        data,
      };
    }
    function addNodeAt(type, pos) {
      const n = newNode(type, pos);
      update((s) => { s.graph.nodes[n.id] = n; s.sel = new Set([n.id]); s.selEdge = null; });
      pushHistory();
      return n;
    }
    function removeNodes(ids, edgeId) {
      update((s) => {
        for (const id of ids) delete s.graph.nodes[id];
        s.graph.edges = s.graph.edges.filter((e) => !ids.includes(e.fromNode) && !ids.includes(e.toNode) && (!edgeId || e.id !== edgeId));
        s.sel = new Set([...s.sel].filter((x) => ids.includes(x) === false));
        if (s.selEdge && !s.graph.edges.some((e) => e.id === s.selEdge)) s.selEdge = null;
        // 本地删除也要留墓碑：Host 侧据此判定"真的被删了"，
        // 否则 Host 合并（保留对话新节点）会把用户刚删的节点又留下来
        if (ids.length) s.graph.tombstones = [...new Set([...(s.graph.tombstones || []), ...ids])].slice(-200);
      });
      pushHistory();
      flushSave(); // 删除立即推送（不等 450ms 防抖）：同步把 Host 上的节点删掉，压缩"拉回复活"的时间窗
    }
    function duplicateSelection() {
      const clones = [];
      update((s) => {
        for (const id of s.sel) {
          const src = s.graph.nodes[id];
          if (!src) continue;
          const copy = JSON.parse(JSON.stringify(src));
          copy.id = uid('n');
          copy.x += 26; copy.y += 26;
          copy.data = { ...copy.data, status: 'idle', error: null };
          s.graph.nodes[copy.id] = copy;
          clones.push(copy.id);
        }
        if (clones.length) s.sel = new Set(clones);
      });
      pushHistory();
    }
    function reaches(fromId, targetId) {
      const adj = {};
      for (const e of S.graph.edges) (adj[e.fromNode] = adj[e.fromNode] || []).push(e.toNode);
      const stack = [fromId], seen = new Set();
      while (stack.length) {
        const x = stack.pop();
        if (x === targetId) return true;
        if (seen.has(x)) continue;
        seen.add(x);
        (adj[x] || []).forEach((y) => stack.push(y));
      }
      return false;
    }
    function canConnect(fromNode, fromPort, toNode, toPort) {
      if (fromNode.id === toNode.id) return '不能连接到自身';
      const op = (PORTS[fromNode.type].outputs || []).find((p) => p.id === fromPort);
      const ip = (PORTS[toNode.type].inputs || []).find((p) => p.id === toPort);
      if (!op || !ip) return '端口不存在';
      if (op.kind !== ip.kind) return '端口类型不匹配（' + op.kind + ' → ' + ip.kind + '）';
      const multi = MULTI_INPUT_PORTS.has(toPort) || (toNode.type === 'finalcut' && toPort === 'in');
      if (!multi && S.graph.edges.some((e) => e.toNode === toNode.id && e.toPort === toPort)) return '该输入端口已被占用';
      if (reaches(toNode.id, fromNode.id)) return '不能形成循环连接';
      return null;
    }
    function connect(fromNode, fromPort, toNode, toPort) {
      const err = canConnect(fromNode, fromPort, toNode, toPort);
      if (err) { toast(err); return false; }
      update((s) => {
        s.graph.edges.push({ id: uid('e'), fromNode: fromNode.id, fromPort, toNode: toNode.id, toPort });
      });
      pushHistory();
      // 分类提示（不阻断）：分镜端口的期望分类 vs 资产实际分类
      if (PORT_CATEGORY[toPort] && fromNode.data && fromNode.data.assetId) {
        idbGet(fromNode.data.assetId).then((rec) => {
          if (rec && rec.category && rec.category !== 'general' && rec.category !== PORT_CATEGORY[toPort]) {
            toast(T('catMismatch').replace('{a}', catLabel(rec.category)).replace('{b}', catLabel(PORT_CATEGORY[toPort])));
          }
        }).catch(() => {});
      }
      return true;
    }
    function catLabel(c) {
      const map = {
        character: T('catCharacter'), scene: T('catScene'), prop: T('catProp'),
        script: T('nScript'), storyboard: T('nStoryboard'),
        audio: T('ttsCategory'), finalcut: T('finalcutCategory'), general: T('catGeneral'),
      };
      return map[c] || c;
    }
    function portWorldPos(nodeId, portId, dir) {
      const n = S.graph.nodes[nodeId];
      if (!n) return { x: 0, y: 0 };
      const list = dir === 'out' ? (PORTS[n.type].outputs || []) : (PORTS[n.type].inputs || []);
      const i = list.findIndex((p) => p.id === portId);
      const y = n.y + 38 + Math.max(0, i) * 22;
      return { x: dir === 'out' ? n.x + n.w : n.x, y };
    }
    function edgeGeom(e) {
      const a = portWorldPos(e.fromNode, e.fromPort, 'out');
      const b = portWorldPos(e.toNode, e.toPort, 'in');
      const dx = Math.max(42, Math.abs(b.x - a.x) * 0.5);
      const c1x = a.x + dx, c2x = b.x - dx;
      return {
        d: `M ${a.x} ${a.y} C ${c1x} ${a.y}, ${c2x} ${b.y}, ${b.x} ${b.y}`,
        mx: (a.x + 3 * c1x + 3 * c2x + b.x) / 8,
        my: (a.y + 3 * a.y + 3 * b.y + b.y) / 8,
      };
    }
    function edgePath(e) { return edgeGeom(e).d; }
    function edgeKind(e) {
      const from = S.graph.nodes[e.fromNode];
      if (!from) return 'text';
      const op = (PORTS[from.type].outputs || []).find((p) => p.id === e.fromPort);
      return op ? op.kind : 'text';
    }
    function topoOrder(graph) {
      const ids = Object.keys(graph.nodes);
      const indeg = {};
      ids.forEach((id) => { indeg[id] = 0; });
      for (const e of graph.edges) {
        if (indeg[e.toNode] == null || indeg[e.fromNode] == null) continue;
        indeg[e.toNode]++;
      }
      const queue = ids.filter((id) => indeg[id] === 0);
      const order = [];
      const out = {};
      for (const e of graph.edges) (out[e.fromNode] = out[e.fromNode] || []).push(e.toNode);
      while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const nx of out[id] || []) {
          indeg[nx]--;
          if (indeg[nx] === 0) queue.push(nx);
        }
      }
      if (order.length !== ids.length) return null; // 存在环
      return order;
    }

    // 输入解析：生成节点的实际 prompt（文本节点 / 分镜节点的画面、动作输出）
    /** 分镜表 → 一次多镜头视频生成的提示词：所有镜头按顺序、按时长写进同一条提示词，
     *  由支持多镜头的视频模型**一次性生成整段视频**（而不是一镜一视频再拼接）。
     *  各镜内的 @实体 引用原样保留，collectRefs 会自动挂上对应参考图资产。 */
    function buildStoryboardVideoPrompt(sb) {
      const shots = ((sb && sb.data && sb.data.shots) || []).filter((s) => s && (String(s.visual || '').trim() || String(s.motion || '').trim()));
      if (!shots.length) return '';
      const zh = effLang() !== 'en';
      const total = shots.reduce((a, s) => a + Math.max(1, Number(s.duration) || 3), 0);
      const lines = [
        zh
          ? `【多镜头一次性生成】共 ${shots.length} 镜、总时长 ${total} 秒。严格按下列顺序与时长切镜（每镜时长不可变），镜头之间直接硬切，不要叠加转场：`
          : `[Multi-shot single generation] ${shots.length} shots, ${total}s total. Cut strictly in this order with exact per-shot durations, hard cuts only, no transitions:`,
      ];
      shots.forEach((s, i) => {
        const dur = Math.max(1, Number(s.duration) || 3);
        const parts = [];
        if (String(s.visual || '').trim()) parts.push(String(s.visual).trim());
        if (String(s.motion || '').trim()) parts.push((zh ? '运镜/动作：' : 'Camera/Action: ') + String(s.motion).trim());
        lines.push((zh ? `镜头${i + 1}（${dur}s）：` : `Shot ${i + 1} (${dur}s): `) + parts.join(zh ? '；' : '; '));
      });
      return lines.join('\n');
    }
    function resolvePrompt(n) {
      const e = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'prompt');
      if (e) {
        const src = S.graph.nodes[e.fromNode];
        if (src) {
          if (src.type === 'text' && (src.data.text || '').trim()) return src.data.text.trim();
          if (src.type === 'shot') {
            const field = e.fromPort === 'motion' ? 'motion' : 'visual';
            const v = (src.data[field] || '').trim();
            if (v) return v;
          }
          // 上游是分镜表 → 多镜头一次性生成：全部镜头组合成一条提示词（时长 = 各镜之和）
          if (src.type === 'storyboard') {
            const composed = buildStoryboardVideoPrompt(src);
            if (composed) return composed;
          }
        }
      }
      return (n.data.prompt || '').trim();
    }
    // 节点输出端口所服务的资产（视频生成 last 端口 → 尾帧图资产）
    function servedAssetId(src, fromPort) {
      if (!src || !src.data) return null;
      if (fromPort === 'last') return src.data.lastAssetId || null;
      return src.data.assetId || null;
    }
    async function resolveAssetBlob(nodeId, portId) {
      const e = S.graph.edges.find((x) => x.toNode === nodeId && x.toPort === portId);
      if (!e) return null;
      const src = S.graph.nodes[e.fromNode];
      if (!src) return null;
      const aid = servedAssetId(src, e.fromPort);
      if (!aid) return null;
      return await assetBlob(aid);
    }
    // 多参考图：按节点上的显式顺序（refOrder，未排序时按连线先后）解析，带名称/分类供 [图N] 绑定
    async function resolveRefMetas(nodeId, portId) {
      const n = S.graph.nodes[nodeId];
      const es = S.graph.edges.filter((x) => x.toNode === nodeId && x.toPort === portId);
      const order = (n && n.data.refOrder ? n.data.refOrder : []).filter((id) => es.some((e) => e.id === id));
      for (const e of es) if (!order.includes(e.id)) order.push(e.id);
      const metas = [];
      for (const id of order) {
        const e = es.find((x) => x.id === id);
        const src = e && S.graph.nodes[e.fromNode];
        if (!src) continue;
        const aid = servedAssetId(src, e.fromPort);
        if (!aid) continue;
        try {
          const rec = await idbGet(aid);
          const blob = await assetBlob(aid);
          if (blob) metas.push({ blob, name: (rec && rec.name) || '', category: (rec && rec.category) || 'general' });
        } catch { /* 单个参考图读取失败不影响其余 */ }
      }
      return metas;
    }

    // ============================================================
    // 工作流执行
    // ============================================================
    const cancelRef = { cancelled: false };

    /** 分镜节点的剧本来源：**连线上游与手动粘贴二选一**——
     *  连了线就只用连线（上游没生成完会明确报错，绝不偷用粘贴的文本混着来）。 */
    function storyboardScriptText(n) {
      const e = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'script');
      if (e) {
        const src = S.graph.nodes[e.fromNode];
        if (!src) throw new Error(T('aiNeedScript'));
        if (src.type === 'script') {
          const out = String(src.data.output || '').trim();
          if (!out) throw new Error(T('upstreamStillRunning'));
          return out;
        }
        if (src.type === 'text') {
          const txt = String(src.data.text || '').trim();
          if (!txt) throw new Error(T('upstreamStillRunning'));
          return txt;
        }
        throw new Error(T('aiNeedScript'));
      }
      return String(n.data.script || '').trim();
    }
    const setNodeAiError = (nodeId, message) => update((s) => {
      const nd = s.graph.nodes[nodeId];
      if (nd) { nd.data.aiStatus = 'error'; nd.data.aiError = String(message || ''); nd.data.status = 'error'; }
    });

    /** 剧本节点：idea → 成稿。按钮与对话触发的 canvas_run_node 共用同一实现。 */
    async function genScriptNode(n) {
      if (!String(n.data.idea || '').trim()) throw new Error(T('needIdea'));
      update((s) => {
        const nd = s.graph.nodes[n.id];
        if (nd) {
          // 生成开始即清空结果框（旧稿备份，失败自动还原）：避免"还在生成中，结果框却挂着上一版"的误解
          nd.data.prevOutput = nd.data.output || '';
          nd.data.output = '';
          nd.data.aiStatus = 'running';
          nd.data.aiError = null;
        }
      });
      aiStreamClear(n.id);
      flushSave();
      try {
        const text = await aiScriptNodes(n.data.idea, n.data.model, (kind, d) => aiStreamAppend(n.id, kind, d));
        if (!String(text || '').trim()) throw new Error(T('aiEmptyResult'));
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.output = text; nd.data.prevOutput = null; nd.data.aiStatus = 'idle'; nd.data.status = 'done'; nd.data.error = null; } s.assetsTick++; });
        await saveTextAssetRecord(S.activeId, {
          name: (String(n.data.label || '').trim() || T('scriptAssetPrefix')) + ' ' + nowStamp(),
          text, category: 'script', prompt: n.data.idea,
        });
        update((s) => { s.assetsTick++; });
        flushSave();
        return text;
      } catch (e) {
        update((s) => {
          const nd = s.graph.nodes[n.id];
          // 失败时还原上一版成稿，不让用户白丢内容
          if (nd && !String(nd.data.output || '').trim() && nd.data.prevOutput) { nd.data.output = nd.data.prevOutput; nd.data.prevOutput = null; }
        });
        setNodeAiError(n.id, (e && e.message) || e);
        flushSave();
        throw e;
      } finally {
        aiStreamClear(n.id);
      }
    }

    /** 分镜节点的资产文本（自动入库与手动"存为资产"共用，避免两处格式漂移）。 */
    function storyboardAssetText(shots) {
      return (shots || []).map((x) => `【${x.title}】${x.duration}s\n画面：${x.visual}\n动作：${x.motion}\n角色：${(x.characters || []).join('、') || '-'}｜场景：${x.scene || '-'}｜道具：${(x.props || []).join('、') || '-'}`).join('\n\n');
    }

    /** 分镜节点：剧本 → 镜头列表（含一致性检查）。 */
    async function genStoryboardNode(n) {
      const st = storyboardScriptText(n);
      if (!st) throw new Error(T('aiNeedScript'));
      update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.aiStatus = 'running'; nd.data.aiError = null; nd.data.warnings = []; } });
      aiStreamClear(n.id);
      flushSave();
      try {
        const shots = await aiStoryboardShots(st, n.data.requirement, n.data.count || 6, n.data.model, (kind, d) => aiStreamAppend(n.id, kind, d));
        // 先自动补录缺失条目（空描述），再算一致性告警：否则告警标志的条目其实马上就被自动补录了，"未登记"语义会误导用户与对话侧
        try { await autoRegisterBibleEntries(shots); } catch { /* 补录失败不影响分镜 */ }
        const warnings = await checkShotConsistency(shots);
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.shots = shots; nd.data.aiStatus = 'idle'; nd.data.warnings = warnings; nd.data.status = 'done'; nd.data.error = null; }
          s.assetsTick++;
        });
        await saveTextAssetRecord(S.activeId, {
          name: (String(n.data.label || '').trim() || T('storyboardAssetPrefix')) + ' ' + nowStamp(),
          text: storyboardAssetText(shots),
          category: 'storyboard', prompt: st.slice(0, 200),
        });
        update((s) => { s.assetsTick++; });
        flushSave();
        return shots;
      } catch (e) {
        setNodeAiError(n.id, (e && e.message) || e);
        flushSave();
        throw e;
      } finally {
        aiStreamClear(n.id);
      }
    }

    /** 成片节点：片段（+配音） → MP4。 */
    async function genFinalCutNode(n) {
      const segEdges = S.graph.edges.filter((x) => x.toNode === n.id && x.toPort === 'in');
      const segs = segEdges
        .map((e) => ({ e, nd: S.graph.nodes[e.fromNode] }))
        .filter((x) => x.nd)
        .sort((a, b) => (a.nd.y - b.nd.y) || (a.nd.x - b.nd.x));
      if (!segs.length) throw new Error(T('noSegments'));
      const getSub = (x) => {
        const defSub = x.nd.type === 'video-gen' ? (x.nd.data.prompt || '') : (x.nd.data.label || TYPE_LABEL()[x.nd.type]);
        const v = n.data.subs && n.data.subs[x.e.id];
        return v != null ? v : defSub;
      };
      const metas = [];
      for (const x of segs) {
        if (!x.nd.data.assetId) continue;
        try {
          const rec = await idbGet(x.nd.data.assetId);
          const blob = await assetBlob(x.nd.data.assetId);
          if (blob) {
            const ttsId = n.data.tts && n.data.tts[x.e.id] && n.data.tts[x.e.id].assetId;
            const ttsUrl = ttsId ? await assetUrl(ttsId) : null;
            // 分镜的编辑时长（1-3s 级）作为成片裁剪依据：API 生成的片段偏长，成片时裁到分镜时长
            const editDur = Number(x.nd.data.editDuration) || null;
            metas.push({ url: URL.createObjectURL(blob), name: (rec && rec.name) || 'seg', sub: getSub(x), ttsUrl, dur: editDur || undefined });
          }
        } catch { /* 跳过加载失败的片段 */ }
      }
      if (!metas.length) throw new Error(T('noSegments'));
      update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.status = 'running'; nd.data.error = null; nd.data.progress = '0%'; } });
      flushSave();
      try {
        const dims = videoDimsFor({ resolution: n.data.resolution, ratio: n.data.ratio });
        const blob = await composeFinalCut(metas, {
          width: dims.w, height: dims.h, keepAudio: n.data.keepAudio !== false, transition: n.data.transition,
          bitrate: n.data.bitrate ? Number(n.data.bitrate) : undefined,
        }, (frac, name) => {
          update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.progress = Math.round(frac * 100) + '% · ' + name; });
        });
        const rec = await saveAssetRecord(S.activeId, 'video', blob, {
          name: (String(n.data.label || '').trim() || T('finalCutDone')) + ' ' + nowStamp(),
          prompt: metas.length + ' segments', source: 'finalcut', category: 'finalcut',
        });
        metas.forEach((m) => URL.revokeObjectURL(m.url));
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.status = 'done'; nd.data.assetId = rec.id; nd.data.progress = null; }
          s.assetsTick++;
        });
        flushSave();
        return rec.id;
      } catch (e) {
        metas.forEach((m) => URL.revokeObjectURL(m.url));
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.status = 'error'; nd.data.error = String((e && e.message) || e); nd.data.progress = null; }
        });
        flushSave();
        throw e;
      }
    }

    async function runGenNode(n) {
      const type = n.type;
      const settings = loadSettings(); // 模型解析（供应商+模型）用
      update((s) => {
        const nd = s.graph.nodes[n.id];
        if (nd) { nd.data.status = 'running'; nd.data.error = null; }
      });
      flushSave(); // 立刻落盘 + 推送 Host：切走画面/对话查询都能看到"运行中"
      try {
        if (type === 'script') { await genScriptNode(n); return true; }
        if (type === 'storyboard') { await genStoryboardNode(n); return true; }
        if (type === 'finalcut') { await genFinalCutNode(n); return true; }
        if (type !== 'image-gen' && type !== 'video-gen') throw new Error(T('nodeNotRunnable'));
        const prompt = resolvePrompt(n);
        const bible = loadBible(S.activeId);
        if (type === 'image-gen') {
          // 参考图 = 连线（用户顺序）+ @引用命中的设定集资产（按出现顺序）
          const { refs, entities } = await collectRefs(n, prompt, bible);
          const metas = refs.map((r) => ({ blob: r.blob, name: r.name, category: r.category }));
          const p = buildEffectivePrompt(prompt, refs, entities, bible);
          // 模型解析：节点选择优先，未指定路由到星标默认模型；都没有 = 明确报错（不再静默走演示模式）
          const mcfg = resolveImageModelCfg(settings, nodeImageModelRef(n));
          if (!mcfg) throw new Error(T('errNoImageModel'));
          const blob = await apiImage(p, metas, mcfg, { size: n.data.size, ratio: n.data.ratio });
          const rec = await saveAssetRecord(S.activeId, 'image', blob, {
            name: assetNameFor(n, entities, 'image'),
            prompt: stripMentionMarks(prompt), effectivePrompt: p,
            source: 'api',
            entity: entities.length ? entities[0].name : undefined,
            entities: entities.map((e) => e.name),
            nodeLabel: (n.data && n.data.label) || '',
            // 分类：@引用命中的实体品类优先；无引用时按命名规范前缀（角色-/场景-/道具-）兜底
            category: entities.length ? entityCategoryOf(entities[0].kind) : (categoryFromName(n.data.label) || 'general'),
          });
          commitGenResult(n.id, rec.id, false, 'image');
        } else {
          const frameBlob = await resolveAssetBlob(n.id, 'frame');
          const { refs, entities } = await collectRefs(n, prompt, bible);
          const p = buildEffectivePrompt(prompt, refs, entities, bible);
          const mcfg = resolveVideoModelCfg(settings, nodeVideoModelRef(n));
          if (!mcfg) throw new Error(T('errNoVideoModel'));
          const blob = await apiVideo(p, frameBlob, mcfg, {
            duration: n.data.duration, resolution: n.data.resolution, ratio: n.data.ratio,
            refs: refs.map((r) => r.blob),
          });
          const rec = await saveAssetRecord(S.activeId, 'video', blob, {
            name: assetNameFor(n, entities, 'video'),
            prompt: stripMentionMarks(prompt), effectivePrompt: p,
            source: 'api',
            entity: entities.length ? entities[0].name : undefined,
            entities: entities.map((e) => e.name),
            nodeLabel: (n.data && n.data.label) || '',
            category: entities.length ? entityCategoryOf(entities[0].kind) : (categoryFromName(n.data.label) || 'general'),
          });
          commitGenResult(n.id, rec.id, false, 'video');
          // 尾帧提取（通用）：供 last 端口输出与链式下一镜使用
          try {
            const fBlob = await extractLastFrame(blob);
            const fRec = await saveAssetRecord(S.activeId, 'image', fBlob, {
              name: T('lastFrame') + '-' + (n.data.label || n.id.slice(-4)),
              prompt: 'last frame of ' + prompt.slice(0, 60), source: 'api', category: 'general',
            });
            update((s) => {
              const nd = s.graph.nodes[n.id];
              if (nd) nd.data.lastAssetId = fRec.id;
              s.assetsTick++;
            });
          } catch { /* 尾帧提取失败不影响主流程 */ }
        }
        return true;
      } catch (err) {
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.status = 'error'; nd.data.error = String((err && err.message) || err); }
        });
        flushSave(); // 让对话侧的 canvas_node_status 也能读到失败原因
        return false;
      }
    }
    function commitGenResult(nodeId, assetId, demo, kind) {
      const downstream = [];
      update((s) => {
        const nd = s.graph.nodes[nodeId];
        if (nd) {
          nd.data.status = 'done'; nd.data.assetId = assetId; nd.data.demo = !!demo;
          // 媒体历史：保留最近 8 次结果，可在节点内切换
          const h = [{ assetId, ts: Date.now() }].concat(nd.data.history || []);
          nd.data.history = h.filter((x, i, arr) => arr.findIndex((y) => y.assetId === x.assetId) === i).slice(0, 8);
        }
        for (const e of s.graph.edges) {
          if (e.fromNode === nodeId && e.fromPort === 'out') downstream.push(e.toNode);
        }
        for (const tid of downstream) {
          const tn = s.graph.nodes[tid];
          if (tn && (tn.type === 'image-asset' || tn.type === 'video-asset')) {
            tn.data.assetId = assetId;
            tn.data.status = 'done';
          }
        }
        s.assetsTick++;
      });
      void kind;
    }
    async function runWorkflow() {
      if (S.running) return;
      const order = topoOrder(S.graph);
      if (!order) {
        toast(T('errCycle'));
        return;
      }
      cancelRef.cancelled = false;
      update((s) => { s.running = true; });
      try {
        for (const id of order) {
          if (cancelRef.cancelled) break;
          const n = S.graph.nodes[id];
          if (!n) continue;
          // 已在生成中的节点跳过：避免与对话触发的 canvas_run_node 并发调用同一节点（重复计费/重复资产）
          if (n.data && n.data.status === 'running') continue;
          if (n.type === 'image-gen' || n.type === 'video-gen' || n.type === 'script' || n.type === 'storyboard' || n.type === 'finalcut') {
            await runGenNode(n);
          }
        }
      } finally {
        update((s) => { s.running = false; });
        flushSave();
      }
    }
    function stopRun() { cancelRef.cancelled = true; }

    // ============================================================
    // 轻量提示
    // ============================================================
    let toastTimer = null;
    function toast(msg) {
      S._toast = msg;
      notify();
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (S._toast) { S._toast = null; notify(); } }, 2600);
    }

    // ============================================================
    // 画布交互（平移 / 缩放 / 拖动 / 连线 / 框选）
    // ============================================================
    const drag = { mode: null, sx: 0, sy: 0, moved: false, nodeStarts: null, marquee: null, linkFrom: null, shift: false };

    function onCanvasPointerDown(e) {
      const target = e.target;
      const onBackground = !(target.closest && target.closest('[data-node-id]'));
      if (e.button === 1) {
        e.preventDefault();
        startPan(e);
        return;
      }
      if (e.button !== 0) return;
      if (!onBackground) return; // 节点自身处理
      closeMenu();
      if (e.shiftKey) startMarquee(e);
      else {
        if (S.sel.size || S.selEdge) { update((s) => { s.sel = new Set(); s.selEdge = null; }); }
        startPan(e);
      }
    }
    function startPan(e) {
      drag.mode = 'pan';
      drag.sx = e.clientX; drag.sy = e.clientY;
      try { canvasEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    function startMarquee(e) {
      drag.mode = 'marquee';
      drag.sx = e.clientX; drag.sy = e.clientY;
      const w = screenToWorld(e.clientX, e.clientY);
      drag.marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
      try { canvasEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    function onNodePointerDown(e, n) {
      if (e.button === 2 || e.button === 1) return;
      const t = e.target;
      if (t.closest && t.closest('input,textarea,select,button,video,a,label,[data-no-drag]')) return;
      e.stopPropagation();
      closeMenu();
      if (e.shiftKey) {
        const next = new Set(S.sel);
        if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
        update((s) => { s.sel = next; });
        if (!next.has(n.id)) return;
      } else if (!S.sel.has(n.id)) {
        update((s) => { s.sel = new Set([n.id]); s.selEdge = null; });
      }
      drag.mode = 'node';
      drag.sx = e.clientX; drag.sy = e.clientY;
      drag.moved = false;
      const ids = S.sel.has(n.id) ? [...S.sel] : [n.id];
      // 分组拖动时携带其成员
      const allIds = [];
      for (const id of ids) {
        allIds.push(id);
        const nd = S.graph.nodes[id];
        if (nd && nd.type === 'group') {
          for (const mid of (nd.data.members || [])) {
            if (!allIds.includes(mid) && S.graph.nodes[mid]) allIds.push(mid);
          }
        }
      }
      drag.nodeStarts = allIds.map((id) => {
        const nd = S.graph.nodes[id];
        return nd ? { id, x: nd.x, y: nd.y } : null;
      }).filter(Boolean);
      try { canvasEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    function onPortPointerDown(e, n, port, dir) {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      closeMenu();
      drag.mode = 'link';
      drag.linkFrom = { node: n, port: port.id, dir };
      try { canvasEl.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      updateTempEdge(e.clientX, e.clientY);
      notify();
    }
    function updateTempEdge(cx, cy) {
      if (!tempEdgeEl || !drag.linkFrom) return;
      const lf = drag.linkFrom;
      const a = portWorldPos(lf.node.id, lf.port, lf.dir);
      const w = screenToWorld(cx, cy);
      const b = lf.dir === 'out' ? w : a;
      const a2 = lf.dir === 'out' ? a : w;
      const dx = Math.max(42, Math.abs(b.x - a2.x) * 0.5);
      const d = lf.dir === 'out'
        ? `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
        : `M ${a2.x} ${a2.y} C ${a2.x + dx} ${a2.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
      tempEdgeEl.setAttribute('d', d);
      tempEdgeEl.style.display = 'block';
    }
    function onCanvasPointerMove(e) {
      if (!drag.mode) return;
      const dxs = e.clientX - drag.sx;
      const dys = e.clientY - drag.sy;
      if (drag.mode === 'pan') {
        setView(V.x + dxs, V.y + dys, V.scale, false);
        drag.sx = e.clientX; drag.sy = e.clientY;
      } else if (drag.mode === 'node') {
        if (Math.abs(dxs) + Math.abs(dys) > 2) drag.moved = true;
        let dxw = dxs / V.scale, dyw = dys / V.scale;
        // 对齐吸附：以首个拖动节点为基准，与其他节点左/中/右、上/中/下对齐（容差 6px）
        const prim = drag.nodeStarts[0];
        const ndP = prim && S.graph.nodes[prim.id];
        if (ndP && !e.shiftKey && drag.nodeStarts.length) {
          const snap = 6 / V.scale;
          const ph = ndP.h || 96;
          const px = prim.x + dxw, py = prim.y + dyw;
          const pm = { l: px, cx: px + ndP.w / 2, r: px + ndP.w, t: py, cy: py + ph / 2, b: py + ph };
          let bestV = null, bestH = null;
          for (const other of Object.values(S.graph.nodes)) {
            if (!other || other.id === prim.id || other.type === 'group') continue;
            const oh = other.h || 96;
            const om = { l: other.x, cx: other.x + other.w / 2, r: other.x + other.w, t: other.y, cy: other.y + oh / 2, b: other.y + oh };
            for (const pk of ['l', 'cx', 'r']) for (const ok of ['l', 'cx', 'r']) {
              const d = Math.abs(pm[pk] - om[ok]);
              if (d <= snap && (!bestV || d < bestV.d)) bestV = { d, line: om[ok], delta: om[ok] - pm[pk] };
            }
            for (const pk of ['t', 'cy', 'b']) for (const ok of ['t', 'cy', 'b']) {
              const d = Math.abs(pm[pk] - om[ok]);
              if (d <= snap && (!bestH || d < bestH.d)) bestH = { d, line: om[ok], delta: om[ok] - pm[pk] };
            }
          }
          if (bestV) dxw += bestV.delta;
          if (bestH) dyw += bestH.delta;
          showGuides(bestV ? bestV.line : null, bestH ? bestH.line : null);
        }
        const movedIds = new Set();
        for (const st of drag.nodeStarts) {
          const el = nodeEls.get(st.id);
          const nd = S.graph.nodes[st.id];
          if (!el || !nd) continue;
          const nx = Math.round(st.x + dxw), ny = Math.round(st.y + dyw);
          nd.x = nx; nd.y = ny; // 直接写模型（尚未通知 React）
          el.style.left = nx + 'px';
          el.style.top = ny + 'px';
          movedIds.add(st.id);
        }
        if (movedIds.size) {
          for (const e2 of S.graph.edges) {
            if (!movedIds.has(e2.fromNode) && !movedIds.has(e2.toNode)) continue;
            const p = edgePathEls.get(e2.id);
            if (p) p.setAttribute('d', edgePath(e2));
          }
        }
      } else if (drag.mode === 'marquee') {
        const w = screenToWorld(e.clientX, e.clientY);
        drag.marquee.x1 = w.x; drag.marquee.y1 = w.y;
        if (marqueeEl) {
          const x = Math.min(drag.marquee.x0, drag.marquee.x1);
          const y = Math.min(drag.marquee.y0, drag.marquee.y1);
          const wd = Math.abs(drag.marquee.x1 - drag.marquee.x0);
          const ht = Math.abs(drag.marquee.y1 - drag.marquee.y0);
          marqueeEl.style.display = 'block';
          marqueeEl.style.left = x + 'px';
          marqueeEl.style.top = y + 'px';
          marqueeEl.style.width = wd + 'px';
          marqueeEl.style.height = ht + 'px';
        }
      } else if (drag.mode === 'link') {
        updateTempEdge(e.clientX, e.clientY);
      }
    }
    function onCanvasPointerUp(e) {
      if (!drag.mode) return;
      const mode = drag.mode;
      if (mode === 'node' && drag.moved) {
        // 拖动期间直接写了模型坐标，这里只需通知 + 保存
        notify();
        pushHistory();
        scheduleSave();
        hideGuides();
      } else if (mode === 'marquee' && drag.marquee) {
        const { x0, y0, x1, y1 } = drag.marquee;
        const rx0 = Math.min(x0, x1), rx1 = Math.max(x0, x1);
        const ry0 = Math.min(y0, y1), ry1 = Math.max(y0, y1);
        const picked = Object.values(S.graph.nodes).filter((n) => {
          const nx1 = (n.x ?? 0) + n.w, ny1 = (n.y ?? 0) + (n.h ?? 96);
          return n.x < rx1 && nx1 > rx0 && n.y < ry1 && ny1 > ry0;
        }).map((n) => n.id);
        update((s) => { s.sel = new Set(picked); });
        if (marqueeEl) marqueeEl.style.display = 'none';
      } else if (mode === 'link' && drag.linkFrom) {
        if (tempEdgeEl) tempEdgeEl.style.display = 'none';
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const portEl = el && el.closest && el.closest('[data-port-in]');
        if (portEl) {
          const toNodeId = portEl.getAttribute('data-node-id');
          const toPortId = portEl.getAttribute('data-port-in');
          const toNode = S.graph.nodes[toNodeId];
          if (toNode) {
            connect(drag.linkFrom.node, drag.linkFrom.port, toNode, toPortId);
          }
        }
      }
      drag.mode = null;
      drag.nodeStarts = null;
      drag.marquee = null;
      drag.linkFrom = null;
      notify();
    }
    function onCanvasDoubleClick(e) {
      if (e.target.closest && e.target.closest('[data-node-id]')) return;
      e.preventDefault();
      closeMenu();
      S.menu = { x: e.clientX, y: e.clientY, kind: 'add' };
      notify();
    }
    function onCanvasContextMenu(e) {
      e.preventDefault();
      closeMenu();
      const nodeEl = e.target.closest && e.target.closest('[data-node-id]');
      if (nodeEl) {
        const nodeId = nodeEl.getAttribute('data-node-id');
        if (S.graph.nodes[nodeId]) {
          S.menu = { x: e.clientX, y: e.clientY, kind: 'node', nodeId };
          notify();
          return;
        }
      }
      S.menu = { x: e.clientX, y: e.clientY, kind: 'add' };
      notify();
    }
    function closeMenu() {
      if (S.menu) { S.menu = null; notify(); }
    }
    function fitView() {
      const nodes = Object.values(S.graph.nodes);
      const r = containerRect();
      if (!nodes.length) { setView(60, 40, 1, true); return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) {
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + (n.h || 96));
      }
      const pad = 60;
      const bw = x1 - x0 + pad * 2, bh = y1 - y0 + pad * 2;
      const scale = clamp(Math.min(r.width / bw, r.height / bh), 0.15, 1.4);
      const x = r.width / 2 - (x0 + (x1 - x0) / 2) * scale;
      const y = r.height / 2 - (y0 + (y1 - y0) / 2) * scale;
      setView(x, y, scale, true);
    }
    function zoomStep(factor) {
      const r = containerRect();
      const cx = r.width / 2, cy = r.height / 2;
      const s = clamp(V.scale * factor, 0.15, 3);
      const wx = (cx - V.x) / V.scale, wy = (cy - V.y) / V.scale;
      setView(cx - wx * s, cy - wy * s, s, true);
    }
    function resetZoom() {
      const r = containerRect();
      const cx = r.width / 2, cy = r.height / 2;
      const wx = (cx - V.x) / V.scale, wy = (cy - V.y) / V.scale;
      setView(cx - wx, cy - wy, 1, true);
    }

    // 全局键盘：删除 / 复制
    function onWindowKeyDown(e) {
      if (!S.ready) return;
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
      if (e.key === 'Escape') {
        if (S.menu) { closeMenu(); return; }
        if (!typing) update((s) => { s.sel = new Set(); s.selEdge = null; });
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault(); undo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault(); redo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        if (S.sel.size) { e.preventDefault(); duplicateSelection(); }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (S.sel.size || S.selEdge)) {
        e.preventDefault();
        // 必须走 removeNodes（记节点墓碑 + 立即推送）。此前这里是裸删：不记墓碑、不立即推送，
        // Host 合并把删除的节点当"Host 独有"并回来 —— 表现为 Delete 键删除后自动恢复，而 × 删除正常
        removeNodes([...S.sel], S.selEdge || undefined);
      }
    }

    // ============================================================
    // 小组件
    // ============================================================
    function Icon({ d, size = 14, children }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': true, style: { flex: 'none' },
      }, ...(d ? [h('path', { d })] : []), ...(children || []));
    }
    const ICONS = {
      back: 'M15 6l-6 6 6 6',
      undoIc: 'M9 14L4 9l5-5M4 9h10a6 6 0 016 6v1',
      redoIc: 'M15 14l5-5-5-5M20 9H10a6 6 0 00-6 6v1',
      plus: 'M12 5v14M5 12h14',
      play: 'M8 5.5v13l10-6.5-10-6.5z',
      stop: 'M7 7h10v10H7z',
      fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
      zoomIn: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4M8.5 11h5M11 8.5v5',
      zoomOut: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4M8.5 11h5',
      folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
      image: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4L16 11l4 4M15.5 8.5h.01',
      video: 'M4 6h11v12H4zM15 10l5-3v10l-5-3',
      text: 'M5 6h14M12 6v13',
      settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 01-2 1.2L14 21h-4l-.5-2.6a7 7 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7 7 0 015 12a7 7 0 01.1-1.2l-2-1.6 2-3.4 2.4 1a7 7 0 012-1.2L10 3h4l.5 2.6a7 7 0 012 1.2l2.4-1 2 3.4-2 1.6c.07.4.1.8.1 1.2z',
      trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
      download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
      upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
      sidebar: 'M4 5h16v14H4zM14 5v14',
      spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z',
      shot: 'M4 8h16v11H4zM4 8l1.8-3.5L10 5.6 8.2 9M10 5.6l4.2 1.1-1.8 3.4M14.2 6.7l4.2 1.1-1.8 3.3M4 12h16',
      audio: 'M11 5L6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 010 7M18.5 6a9 9 0 010 12',
      film: 'M4 5h16v14H4zM10 9.5l5 3.5-5 3.5zM4 8h16',
      pencil: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z',
      script: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7M9 8h3',
      board: 'M4 4h16v16H4zM4 9h16M9 4v5M15 4v5M9 13h6M9 17h6',
      expandAll: 'M4 12h6M4 12l3-3M4 12l3 3M20 12h-6M20 12l-3-3M20 12l-3 3M12 4v6M12 4l-3 3M12 4l3 3M12 20v-6M12 20l-3-3M12 20l3-3',
    };
    function Ic(name, size) { return h(Icon, { d: ICONS[name], size: size || 14 }); }

    function Btn({ onClick, title, active, disabled, primary, danger, children }) {
      return h('button', {
        type: 'button', className: cls('dshic-btn', active && 'is-active', primary && 'dshic-primary', danger && 'is-danger'),
        onClick, title, disabled,
      }, children);
    }

    const TYPE_LABEL = () => ({
      'text': T('nText'),
      'shot': T('nShot'),
      'script': T('nScript'),
      'storyboard': T('nStoryboard'),
      'image-gen': T('nImageGen'),
      'video-gen': T('nVideoGen'),
      'image-asset': T('nImageAsset'),
      'video-asset': T('nVideoAsset'),
      'finalcut': T('nFinalCut'),
      'group': T('group'),
    });
    const TYPE_KIND = { 'text': 'text', 'shot': 'shot', 'script': 'script', 'storyboard': 'shot', 'image-gen': 'image', 'video-gen': 'video', 'image-asset': 'image', 'video-asset': 'video', 'finalcut': 'video', 'group': 'text' };

    /** 节点尺寸自适应：RO 上报高度，供连线端口定位（分组框高度由创建/折叠样式决定，不采集） */
    function observeNodeHeight(id, el) {
      if (!el) return;
      const ro = new ResizeObserver(() => {
        const nd = S.graph.nodes[id];
        if (!nd || nd.type === 'group') return;
        if (el.offsetHeight && Math.abs((nd.h || 0) - el.offsetHeight) > 1) {
          nd.h = el.offsetHeight;
          for (const e of S.graph.edges) {
            if (e.fromNode === id || e.toNode === id) {
              const p = edgePathEls.get(e.id);
              if (p) p.setAttribute('d', edgePath(e));
            }
          }
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }

    function PortEl({ n, port, dir }) {
      const isActive = drag.mode === 'link' && drag.linkFrom && drag.linkFrom.node.id === n.id && drag.linkFrom.port === port.id;
      let compat = false;
      const link = drag.mode === 'link' ? drag.linkFrom : null;
      if (link && dir === 'in' && link.node.id !== n.id) {
        const op = (PORTS[link.node.type].outputs || []).find((p) => p.id === link.port);
        compat = !!op && op.kind === port.kind;
      }
      return h('button', {
        type: 'button',
        className: cls('dshic-port', 'k-' + port.kind, isActive && 'is-active', compat && 'is-compat'),
        'data-node-id': n.id,
        ...(dir === 'out' ? { 'data-port-out': port.id } : { 'data-port-in': port.id }),
        'data-kind': port.kind,
        title: port.id,
        onPointerDown: (e) => onPortPointerDown(e, n, port, dir),
      });
    }

    const TYPE_ICON = { 'text': 'text', 'shot': 'shot', 'script': 'script', 'storyboard': 'board', 'image-gen': 'spark', 'video-gen': 'video', 'image-asset': 'image', 'video-asset': 'video', 'finalcut': 'film', 'group': 'folder' };

    function ungroupNode(id) {
      update((s) => {
        const g = s.graph.nodes[id];
        if (g && g.type === 'group') {
          for (const mid of (g.data.members || [])) {
            const m = s.graph.nodes[mid];
            if (m) m.data.hidden = false;
          }
        }
        delete s.graph.nodes[id];
        s.graph.edges = s.graph.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
        // 解散分组也是删除节点：不记墓碑会被 Host 合并复活
        s.graph.tombstones = [...new Set([...(s.graph.tombstones || []), id])].slice(-200);
        s.sel.delete(id);
      });
      pushHistory();
      flushSave();
    }
    function createGroupFromSelection() {
      const ids = [...S.sel].filter((id) => S.graph.nodes[id] && S.graph.nodes[id].type !== 'group');
      if (!ids.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) {
        const nd = S.graph.nodes[id];
        x0 = Math.min(x0, nd.x); y0 = Math.min(y0, nd.y);
        x1 = Math.max(x1, nd.x + nd.w); y1 = Math.max(y1, nd.y + (nd.h || 96));
      }
      const pad = 24;
      const g = newNode('group', { x: Math.round(x0 - pad), y: Math.round(y0 - pad) });
      g.w = Math.round(x1 - x0 + pad * 2);
      g.h = Math.round(y1 - y0 + pad * 2);
      g.data.members = ids;
      update((s) => { s.graph.nodes[g.id] = g; s.sel = new Set([g.id]); });
      pushHistory();
    }

    function NodeShell({ n }) {
      const st = n.data.status || 'idle';
      const selected = S.sel.has(n.id);
      const refCb = useCallback((el) => {
        if (el) {
          nodeEls.set(n.id, el);
          const dispose = observeNodeHeight(n.id, el);
          if (dispose) { el.__dshicDisposeRO = dispose; }
        } else {
          const old = nodeEls.get(n.id);
          if (old && old.__dshicDisposeRO) old.__dshicDisposeRO();
          nodeEls.delete(n.id);
        }
      }, [n.id]);
      // 【顺序要求】所有 hook 必须先无条件执行，再决定渲染什么：
      // 否则分组折叠切换 data.hidden 时 hook 数量变化，React 会抛错并卸载整个画布（白屏）
      const [renaming, setRenaming] = useState(false);
      const [nameVal, setNameVal] = useState('');
      // 注意：这里**不做**任何"随内容自动增高"——高度只能由用户拖节点边改变，
      // 文本框内容超出就在框内滚动。此前的自动增高会在流式刷新时被反复触发，
      // 造成"生成中节点自己不断变长"的 bug（用户实测）。
      if (n.data.hidden) return null; // 分组折叠时隐藏成员
      if (n.type === 'group') return h(GroupShell, { n });
      const commitName = () => {
        const v = nameVal.trim();
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.label = v; });
        pushHistory();
        setRenaming(false);
      };
      const startRename = () => { setNameVal(n.data.label || ''); setRenaming(true); };
      // 统一的尺寸拖拽：dir = 'e' | 'w' | 's' | 'n' | 'se'
      // 左右改宽（左边缘同时改 x，视觉上"从左边拉"），上下改高，右下角同时改宽高。
      // 竖向一旦手动拖过 → 记 hManual（固定高度，内容超出则节点内滚动）；双击底边恢复自适应。
      const startResize = (e, dir) => {
        e.stopPropagation();
        e.preventDefault();
        const sx = e.clientX;
        const sy = e.clientY;
        const scale = V.scale || 1;
        const cur = S.graph.nodes[n.id] || n;
        const w0 = cur.w || NODE_W;
        const h0 = cur.h || 120;
        const x0 = cur.x;
        const y0 = cur.y;
        const move = (ev) => {
          const dx = (ev.clientX - sx) / scale;
          const dy = (ev.clientY - sy) / scale;
          update((s) => {
            const nd = s.graph.nodes[n.id];
            if (!nd) return;
            if (dir.includes('e')) nd.w = Math.round(Math.max(200, Math.min(1200, w0 + dx)));
            if (dir.includes('w')) {
              const w = Math.round(Math.max(200, Math.min(1200, w0 - dx)));
              nd.w = w;
              nd.x = Math.round(x0 + (w0 - w));
            }
            if (dir.includes('s')) nd.hManual = Math.round(Math.max(96, Math.min(2400, h0 + dy)));
            if (dir.includes('n')) {
              const h = Math.round(Math.max(96, Math.min(2400, h0 - dy)));
              nd.hManual = h;
              nd.y = Math.round(y0 + (h0 - h));
            }
          });
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          pushHistory();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };
      const resetHeight = (e) => {
        e.stopPropagation();
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.hManual = null; });
        pushHistory();
      };
      return h('div', {
        'data-node-id': n.id,
        className: cls('dshic-node', 'type-' + n.type, 'st-' + st, selected && 'is-selected', n.hManual && 'h-manual'),
        style: { left: n.x, top: n.y, width: n.w, ...(n.hManual ? { height: n.hManual } : {}) },
        ref: refCb,
        onPointerDown: (e) => onNodePointerDown(e, n),
      },
        h('div', { className: 'dshic-node-head' },
          h('span', { className: 'dshic-head-ic' }, Ic(TYPE_ICON[n.type] || 'text', 12)),
          renaming
            ? h('input', {
                className: 'dshic-input', style: { height: 22, flex: 1, minWidth: 0 }, autoFocus: true, value: nameVal,
                placeholder: TYPE_LABEL()[n.type],
                onChange: (e) => setNameVal(e.target.value),
                onPointerDown: (e) => e.stopPropagation(),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') setRenaming(false);
                },
                onBlur: commitName,
              })
            : h('span', {
                className: 'dshic-node-title', title: T('renameHint'),
                onDoubleClick: (e) => { e.stopPropagation(); startRename(); },
              }, n.data.label || TYPE_LABEL()[n.type]),
          (n.data.status === 'running') ? h('span', { className: 'dshic-spin' }) : null,
          h('button', {
            type: 'button', className: 'dshic-node-x', title: T('renameHint'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: startRename,
          }, '✎'),
          h('button', {
            type: 'button', className: 'dshic-node-x', title: T('delete'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => removeNodes([n.id]),
          }, '✕')),
        h('div', { className: 'dshic-node-body' }, nodeBody(n)),
        // 尺寸把手：右/左/下/上四条边 + 右下角（双击底边恢复"随内容自适应"）
        h('div', { className: 'dshic-rs dshic-rs-e', title: T('resizeHint'), onPointerDown: (e) => startResize(e, 'e') }),
        h('div', { className: 'dshic-rs dshic-rs-w', title: T('resizeHint'), onPointerDown: (e) => startResize(e, 'w') }),
        h('div', { className: 'dshic-rs dshic-rs-s', title: T('resizeHeightHint'), onPointerDown: (e) => startResize(e, 's'), onDoubleClick: resetHeight }),
        h('div', { className: 'dshic-rs dshic-rs-n', title: T('resizeHint'), onPointerDown: (e) => startResize(e, 'n') }),
        h('div', { className: 'dshic-rs dshic-rs-se', title: T('resizeHint'), onPointerDown: (e) => startResize(e, 'se') }),
        ...(PORTS[n.type].inputs || []).map((p, i) =>
          h('div', { key: 'in-' + p.id, style: { position: 'absolute', left: -5.5, top: 32.5 + i * 22 }, className: 'dshic-port-wrap' },
            h(PortEl, { n, port: p, dir: 'in' }),
            h('span', { className: 'dshic-port-label', style: { left: 14, top: 0 } }, portLabel(p.id)))),
        ...(PORTS[n.type].outputs || []).map((p, i) =>
          h('div', { key: 'out-' + p.id, style: { position: 'absolute', right: -5.5, top: 32.5 + i * 22 }, className: 'dshic-port-wrap' },
            h(PortEl, { n, port: p, dir: 'out' }),
            h('span', { className: 'dshic-port-label', style: { right: 14, top: 0 } }, portLabel(p.id)))),
      );
    }

    /** 分组框：框住成员一起拖动，可折叠/解散。 */
    function GroupShell({ n }) {
      const collapsed = !!n.data.collapsed;
      const members = (n.data.members || []).filter((id) => S.graph.nodes[id]);
      const stop = (e) => e.stopPropagation();
      return h('div', {
        'data-node-id': n.id,
        className: cls('dshic-group', S.sel.has(n.id) && 'is-selected', collapsed && 'is-collapsed'),
        style: { left: n.x, top: n.y, width: n.w, height: collapsed ? 36 : (n.h || 200) },
        onPointerDown: (e) => onNodePointerDown(e, n),
      },
        h('div', { className: 'dshic-group-head' },
          Ic('folder', 12),
          h('span', { className: 'dshic-node-title' }, (n.data.label || T('group')) + ' · ' + members.length + ' ' + T('nodes')),
          h('button', {
            type: 'button', className: 'dshic-node-x', title: collapsed ? T('unfold') : T('collapse'),
            onPointerDown: stop,
            onClick: () => update((s) => {
              const nd = s.graph.nodes[n.id];
              if (!nd) return;
              nd.data.collapsed = !collapsed;
              for (const id of members) { const m = s.graph.nodes[id]; if (m) m.data.hidden = !collapsed; }
            }),
          }, collapsed ? '▸' : '▾'),
          h('button', {
            type: 'button', className: 'dshic-node-x', title: T('ungroup'),
            onPointerDown: stop,
            onClick: () => ungroupNode(n.id),
          }, '⟲'),
        ),
      );
    }
    function portLabel(pid) {
      const map = {
        prompt: T('portPrompt'), ref: T('portRef'), frame: T('portFrame'),
        in: T('portIn'), out: T('portOut'), last: T('lastFrame'),
        char: T('portChar'), scene: T('portScene'), prop: T('portProp'),
        visual: T('portVisual'), motion: T('portMotion'), script: T('portScript'),
      };
      return map[pid] || pid;
    }

    function StatusTag({ n }) {
      const st = n.data.status || 'idle';
      if (st === 'idle') return null;
      const label = st === 'running' ? T('statusRunning') : st === 'done' ? T('statusDone') : T('statusError');
      return h('span', { className: 'dshic-tag st st-' + st }, st === 'running' ? h('span', { className: 'dshic-spin' }) : null, label);
    }

    let LLM_CACHE = null;
    function useLlmOptions() {
      const [opts, setOpts] = useState(LLM_CACHE);
      useEffect(() => {
        if (LLM_CACHE && Date.now() - LLM_CACHE.at < 60000) return;
        hostRpc('llmOptions').then((r) => {
          LLM_CACHE = { ...r, at: Date.now() };
          setOpts(LLM_CACHE);
        }).catch(() => { /* 静默：无模型时下拉只显示"跟随设置" */ });
      }, []);
      return opts;
    }
    function ModelSelect({ value, onChange, title }) {
      const opts = useLlmOptions();
      const options = [{ value: '', label: T('followSettings') }];
      for (const p of ((opts && opts.providers) || [])) {
        for (const m of (p.models || [])) options.push({ value: p.id + '|' + m.id, label: `${p.name} · ${m.name}` });
      }
      return h(MiniSelect, { value: value || '', options, onChange, title, width: 118 });
    }

    function MiniSelect({ value, options, onChange, title, width }) {
      return h('select', {
        className: 'dshic-msel', value, title,
        style: width ? { width } : undefined,
        onChange: (e) => onChange(e.target.value),
        onPointerDown: (e) => e.stopPropagation(),
      }, options.map((o) => h('option', { key: String(o.value), value: String(o.value) }, o.label)));
    }

    function GenSettingsRow({ n, kind }) {
      const settings = loadSettings();
      const models = kind === 'image' ? flattenImageModels(settings) : flattenVideoModels(settings);
      const star = kind === 'image' ? settings.imageStar : settings.videoStar;
      const cur = kind === 'image' ? nodeImageModelRef(n) : nodeVideoModelRef(n);
      const setModel = (v) => update((s) => {
        const nd = s.graph.nodes[n.id];
        if (!nd) return;
        if (kind === 'image') { nd.data.imageModel = v; delete nd.data.imageApiId; }
        else { nd.data.videoModel = v; delete nd.data.videoApiId; }
      });
      // 模型下拉：只列配置的模型（供应商 · 模型，星标者带 ★）；留空 = 路由到默认模型；没配置 = 空（运行报错）
      return h('div', { key: 'set', style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('div', { className: 'dshic-node-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h(MiniSelect, {
              value: cur, title: T('modelLabel'), width: '100%',
              disabled: !models.length,
              options: models.length
                ? models.map((m) => ({ value: m.ref, label: (m.ref === star ? '★ ' : '') + m.providerName + ' · ' + m.model }))
                : [{ value: '', label: T('noModelsCfg') }],
              onChange: setModel,
            })),
          h(MiniSelect, {
            value: n.data.ratio || '16:9', title: T('ratioLabel'), width: 64,
            options: RATIOS.map((r) => ({ value: r, label: r })),
            onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.ratio = v; }),
          }),
        ),
        h('div', { className: 'dshic-node-row' },
          kind === 'image'
            ? h(MiniSelect, {
                value: n.data.size || '2K', title: T('sizeLabel'), width: 64,
                options: IMAGE_SIZES.map((x) => ({ value: x, label: x })),
                onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.size = v; }),
              })
            : [
                h(MiniSelect, {
                  key: 'dur', value: String(n.data.duration || 5), title: T('durationLabel'), width: 60,
                  options: VIDEO_DURATIONS.map((x) => ({ value: String(x), label: x + 's' })),
                  onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.duration = Number(v); }),
                }),
                h(MiniSelect, {
                  key: 'res', value: n.data.resolution || '720P', title: T('resolutionLabel'), width: 68,
                  options: VIDEO_RESOLUTIONS.map((x) => ({ value: x, label: x })),
                  onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.resolution = v; }),
                }),
              ],
          h('div', { className: 'dshic-flex' }),
        ),
      );
    }

    /** 蒙版级局部重绘：涂抹区域导出 mask PNG，走 images/edits 多部分请求。 */
    function MaskEditor({ nodeId, onClose }) {
      const n = S.graph.nodes[nodeId];
      const url = useAssetUrl(n && n.data.assetId);
      const [brush, setBrush] = useState(28);
      const [running, setRunning] = useState(false);
      const [err, setErr] = useState(null);
      const imgEl = useRef(null);
      const overRef = useRef(null);
      const maskRef = useRef(null);
      const drawing = useRef(false);
      const lastPt = useRef(null);
      const dims = useRef({ w: 0, h: 0 });

      if (!n) return null;

      const initCanvases = () => {
        const img = imgEl.current;
        if (!img) return;
        dims.current = { w: img.naturalWidth || 512, h: img.naturalHeight || 512 };
        const over = overRef.current, mk = maskRef.current;
        if (over) { over.width = dims.current.w; over.height = dims.current.h; }
        if (mk) {
          mk.width = dims.current.w; mk.height = dims.current.h;
          const c = mk.getContext('2d');
          c.fillStyle = '#000';
          c.fillRect(0, 0, mk.width, mk.height);
        }
      };
      const pt = (e) => {
        const over = overRef.current;
        const rect = over.getBoundingClientRect();
        const d = dims.current;
        return {
          x: (e.clientX - rect.left) * (d.w / rect.width),
          y: (e.clientY - rect.top) * (d.h / rect.height),
          scale: d.w / rect.width,
        };
      };
      const stroke = (a, b) => {
        const over = overRef.current, mk = maskRef.current;
        if (!over || !mk) return;
        const o = over.getContext('2d'), m = mk.getContext('2d');
        const lw = Math.max(2, brush * (a.scale || 1));
        o.strokeStyle = 'rgba(255,48,48,0.55)'; o.lineWidth = lw; o.lineCap = 'round'; o.lineJoin = 'round';
        o.beginPath(); o.moveTo(a.x, a.y); o.lineTo(b.x, b.y); o.stroke();
        m.globalCompositeOperation = 'destination-out';
        m.strokeStyle = '#000'; m.lineWidth = lw; m.lineCap = 'round'; m.lineJoin = 'round';
        m.beginPath(); m.moveTo(a.x, a.y); m.lineTo(b.x, b.y); m.stroke();
        m.globalCompositeOperation = 'source-over';
      };
      const clearMask = () => {
        const mk = maskRef.current, over = overRef.current;
        if (mk) { const c = mk.getContext('2d'); c.globalCompositeOperation = 'source-over'; c.fillStyle = '#000'; c.fillRect(0, 0, mk.width, mk.height); }
        if (over) over.getContext('2d').clearRect(0, 0, over.width, over.height);
      };
      const apply = async () => {
        const settings = loadSettings();
        const cfg = resolveImageModelCfg(settings, nodeImageModelRef(n));
        if (!cfg) { toast(T('errNoImageModel')); return; }
        setRunning(true); setErr(null);
        try {
          const mk = maskRef.current;
          const maskBlob = await new Promise((res) => mk.toBlob(res, 'image/png'));
          const baseBlob = await (await fetch(url)).blob();
          const fd = new FormData();
          fd.append('image[]', baseBlob, 'base.png');
          fd.append('mask', maskBlob, 'mask.png');
          fd.append('prompt', String(n.data.prompt || '').trim() || T('redraw'));
          if (cfg.model) fd.append('model', cfg.model);
          fd.append('n', '1');
          fd.append('size', dims.current.w + 'x' + dims.current.h);
          const res2 = await fetch((cfg.baseUrl || '').replace(/\/+$/, '') + '/images/edits', {
            method: 'POST',
            headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {},
            body: fd,
          });
          if (!res2.ok) throw new Error('HTTP ' + res2.status + '：' + (await res2.text()).slice(0, 300));
          const j = await res2.json();
          const d = j && j.data && j.data[0];
          let blob;
          if (d && d.b64_json) blob = base64ToBlob(d.b64_json, 'image/png');
          else if (d && d.url) blob = await (await fetch(d.url)).blob();
          else throw new Error(T('noResult'));
          const rec = await saveAssetRecord(S.activeId, 'image', blob, { prompt: '蒙版重绘: ' + (n.data.prompt || ''), source: 'api' });
          commitGenResult(n.id, rec.id, false, 'image');
          onClose();
        } catch (e) {
          setErr(String(e.message || e));
        } finally { setRunning(false); }
      };
      return h('div', { className: 'dshic-mask-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'dshic-mask-card' },
          h('div', { className: 'dshic-modal-title' }, T('maskRedraw') + ' — ' + (n.data.label || T('nImageGen'))),
          h('div', { className: 'dshic-hint' }, T('maskHint')),
          h('div', { className: 'dshic-mask-stage' },
            h('img', { ref: imgEl, src: url || '', onLoad: initCanvases, draggable: false }),
            h('canvas', {
              ref: overRef, className: 'dshic-mask-paint',
              onPointerDown: (e) => {
                e.stopPropagation();
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
                drawing.current = true;
                const p = pt(e); lastPt.current = p; stroke(p, p);
              },
              onPointerMove: (e) => { if (!drawing.current) return; const p = pt(e); stroke(lastPt.current || p, p); lastPt.current = p; },
              onPointerUp: () => { drawing.current = false; },
              onPointerCancel: () => { drawing.current = false; },
            }),
            h('canvas', { ref: maskRef, style: { display: 'none' } }),
          ),
          h('div', { className: 'dshic-mask-toolbar' },
            h('span', { className: 'dshic-field-label' }, T('brushSize')),
            h('input', { type: 'range', min: 8, max: 90, value: brush, style: { flex: 1, minWidth: 120 }, onChange: (e) => setBrush(Number(e.target.value)), onPointerDown: (e) => e.stopPropagation() }),
            h('button', { type: 'button', className: 'dshic-mini is-ghost', onClick: clearMask, onPointerDown: (e) => e.stopPropagation() }, Ic('trash', 11), T('clearMask')),
            h('div', { className: 'dshic-flex' }),
            h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', onClick: onClose, onPointerDown: (e) => e.stopPropagation() }, T('cancel')),
            h('button', { type: 'button', className: 'dshic-gen', style: { width: 'auto', padding: '0 14px' }, disabled: running, onClick: apply, onPointerDown: (e) => e.stopPropagation() },
              running ? h('span', { className: 'dshic-spin' }) : Ic('spark', 12), running ? T('aiRunning') : T('applyGen')),
          ),
          err ? h('div', { className: 'dshic-err' }, err) : null,
        ));
    }

    function GenNodeBody({ n, kind }) {
      const [showMask, setShowMask] = useState(false);
      const [showCraft, setShowCraft] = useState(false);
      useEffect(() => { probeCraft(); }, []);
      const promptEdge = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'prompt');
      const promptSrc = promptEdge && S.graph.nodes[promptEdge.fromNode];
      const fromStoryboard = !!(promptSrc && promptSrc.type === 'storyboard');
      const refEdges = S.graph.edges.filter((x) => x.toNode === n.id && (kind === 'image' ? x.toPort === 'ref' : x.toPort === 'frame'));
      const vrCount = S.graph.edges.filter((x) => x.toNode === n.id && x.toPort === 'ref').length;
      const assetUrlV = useAssetUrl(n.data.assetId);
      return [
        promptEdge
          ? h('textarea', {
              key: 'p', className: 'dshic-textarea', value: n.data.prompt || '',
              placeholder: fromStoryboard ? T('multiShotHint') : T('connected'), disabled: true,
              onPointerDown: (e) => e.stopPropagation(),
            })
          : h(PromptArea, {
              key: 'p', value: n.data.prompt || '', minHeight: 72,
              placeholder: T('promptPlaceholder'),
              onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.prompt = v; }),
            }),
        h(GenSettingsRow, { key: 'set', n, kind }),
        h('button', {
          key: 'gen', type: 'button', className: 'dshic-gen', disabled: S.running || n.data.status === 'running',
          onPointerDown: (e) => e.stopPropagation(),
          onClick: () => { runGenNode(n); },
        }, n.data.status === 'running' ? h('span', { className: 'dshic-spin' }) : Ic('play', 12), n.data.status === 'running' ? T('aiRunning') : T('generate')),
        h('div', { key: 'r', className: 'dshic-node-row' },
          h('div', { className: 'dshic-flex' }),
          n.data.demo && n.data.assetId ? h('span', { className: 'dshic-tag demo' }, T('demoTag')) : null,
          (!n.data.demo && n.data.assetId) ? h('span', { className: 'dshic-tag api' }, T('apiTag')) : null,
          h(StatusTag, { n }),
        ),
        refEdges.length && kind === 'video'
          ? h('div', { key: 'ref', className: 'dshic-hint' },
              T('portFrame') + ' × ' + refEdges.length + ' · ' + T('connected'))
          : null,
        h(RefRows, { key: 'refrows', n, portId: 'ref' }),
        h(MentionInfo, { key: 'mn', n }),
        n.data.error ? h('div', { key: 'err', className: 'dshic-err' }, n.data.error) : null,
        assetUrlV && kind === 'image'
          ? h('img', { key: 'img', className: 'dshic-preview', src: assetUrlV, draggable: false, 'data-no-drag': '1' })
          : null,
        assetUrlV && kind === 'video'
          ? h('video', { key: 'vid', className: 'dshic-video', src: assetUrlV, controls: true, preload: 'metadata', 'data-no-drag': '1', onPointerDown: (e) => e.stopPropagation() })
          : null,
        assetUrlV
          ? h('div', { key: 'acts', className: 'dshic-node-row' },
              h('button', {
                type: 'button', className: 'dshic-mini is-ghost',
                onPointerDown: (e) => e.stopPropagation(),
                onClick: () => downloadBlobFromUrl(assetUrlV, (kind === 'image' ? 'image' : 'video') + '-' + n.id.slice(-5) + (kind === 'image' ? '.png' : '.webm')),
              }, Ic('download', 11), T('download')),
              h('button', {
                type: 'button', className: 'dshic-mini is-ghost', disabled: S.running || n.data.status === 'running',
                onPointerDown: (e) => e.stopPropagation(),
                onClick: () => { runGenNode(n); },
              }, Ic('spark', 11), T('regen')),
              kind === 'image'
                ? h('button', {
                    type: 'button', className: 'dshic-mini is-ghost', title: T('redraw'),
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => {
                      const c = { x: n.x + 300, y: n.y };
                      const nn = addNodeAt('image-gen', c);
                      update((s) => {
                        const nd2 = s.graph.nodes[nn.id];
                        if (nd2) {
                          nd2.data.prompt = n.data.prompt || '';
                          nd2.data.imageModel = nodeImageModelRef(n);
                          nd2.data.size = n.data.size || '2K';
                          nd2.data.ratio = n.data.ratio || '16:9';
                        }
                        s.graph.edges.push({ id: uid('e'), fromNode: n.id, fromPort: 'out', toNode: nn.id, toPort: 'ref' });
                      });
                      pushHistory();
                    },
                  }, Ic('pencil', 11), T('redraw'))
                : null,
              kind === 'image'
                ? h('button', {
                    type: 'button', className: 'dshic-mini is-ghost', title: T('maskRedraw'),
                    disabled: S.running || n.data.status === 'running',
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => setShowMask(true),
                  }, Ic('pencil', 11), T('maskRedraw'))
                : null,
              kind === 'image'
                ? h('button', {
                    type: 'button', className: 'dshic-mini is-ghost', title: craftOkCached() ? T('photoCraft') : T('craftUnreachable'),
                    disabled: !craftOkCached(),
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => setShowCraft(true),
                  }, Ic('image', 11), T('photoCraft'))
                : null,
              kind === 'video' && n.data.lastAssetId
                ? h('button', {
                    type: 'button', className: 'dshic-mini is-ghost', title: T('chainNext') + '（' + T('lastFrame') + ' → ' + T('portFrame') + '）',
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => chainNext(n),
                  }, Ic('film', 11), T('chainNext'))
                : null,
              h('div', { className: 'dshic-flex' }),
            )
          : null,
        showMask && assetUrlV ? h(MaskEditor, { key: 'mask', nodeId: n.id, onClose: () => setShowMask(false) }) : null,
        showCraft && n.data.assetId ? h(PhotoCraftDialog, { key: 'pccd', assetId: n.data.assetId, onClose: () => setShowCraft(false) }) : null,
        (n.data.history || []).length > 1
          ? h('div', { key: 'hist', className: 'dshic-hist' },
              (n.data.history || []).map((hh) => h(HistThumb, {
                key: hh.assetId, assetId: hh.assetId, active: hh.assetId === n.data.assetId,
                onClick: () => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.assetId = hh.assetId; }),
              })),
            )
          : null,
        !assetUrlV && !n.data.error && n.data.status !== 'running' ? h('div', { key: 'none', className: 'dshic-hint' }, T('noResult')) : null,
      ];
    }

    function HistThumb({ assetId, active, onClick }) {
      const url = useAssetUrl(assetId);
      return h('div', {
        className: cls('dshic-hist-thumb', active && 'is-active'),
        title: T('history'),
        onClick: (e) => { e.stopPropagation(); onClick(); },
        onPointerDown: (e) => e.stopPropagation(),
      }, url ? h('img', { src: url, draggable: false }) : h('span', {}, '…'));
    }

    /** 参考图排序列表：[图N] 顺序即提示词绑定顺序，可上移/下移/解除。 */
    /** @引用解析预览：提示词里 @名称 命中的设定集条目与其参考图资产（标注将成为第几张）。
     *  连线参考图排在前面，故 @ 资产的序号从连线数之后开始。 */
    function MentionInfo({ n }) {
      const prompt = n.data.prompt || '';
      const [rows, setRows] = useState([]);
      useEffect(() => {
        let ok = true;
        // 防抖：输入过程中不必每个按键都查一次资产库
        const timer = setTimeout(async () => {
          try {
            const bible = loadBible(S.activeId);
            const bundle = await resolveMentionBundle(prompt, bible, S.activeId);
            if (ok) setRows(bundle.entities.map((e) => ({ ...e, count: bundle.refs.filter((r) => r.entity === e.name).length })));
          } catch { if (ok) setRows([]); }
        }, 350);
        return () => { ok = false; clearTimeout(timer); };
      }, [prompt, S.assetsTick, S.activeId]);
      if (!rows.length) return null;
      const all = rows.reduce((a, r) => a + r.count, 0);
      return h('div', { className: 'dshic-shot-list' },
        h('div', { className: 'dshic-shot-label' }, T('mentionRefs') + '（' + rows.length + '）'),
        ...rows.map((r, i) => h('div', { key: r.name, className: 'dshic-row', style: { gap: 5 } },
          h('span', { className: 'dshic-mention' }, '@' + r.name),
          h('span', { style: { flex: 1, minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            entityLabelOf(r.kind) + ' · ' + (r.count ? T('mentionAssets').replace('{n}', String(r.count)) : T('mentionNoAsset'))),
        )),
        all === 0 ? h('div', { className: 'dshic-hint' }, T('mentionNoAssetHint')) : null,
      );
    }

    function RefRows({ n, portId }) {
      const [rows, setRows] = useState([]);
      const es = S.graph.edges.filter((x) => x.toNode === n.id && x.toPort === portId);
      const idsKey = es.map((e) => e.id).join(',');
      useEffect(() => {
        let ok = true;
        (async () => {
          const order = (n.data.refOrder || []).filter((id) => es.some((e) => e.id === id));
          for (const e of es) if (!order.includes(e.id)) order.push(e.id);
          const out = [];
          for (const id of order) {
            const e = es.find((x) => x.id === id);
            const src = e && S.graph.nodes[e.fromNode];
            if (!src) continue;
            let name = src.data.placeholderName || src.data.label || '';
            let cat = 'general';
            const aid = servedAssetId(src, e.fromPort);
            if (aid) {
              const cached = assetNameCache.get(aid);
              if (cached != null) name = cached;
              try {
                const rec = await idbGet(aid);
                if (rec) { name = rec.name || name; cat = rec.category || 'general'; }
              } catch { /* 忽略 */ }
            }
            out.push({ edgeId: id, name: name || '…', cat });
          }
          if (ok) setRows(out);
        })();
        return () => { ok = false; };
      }, [idsKey, S.assetsTick, (n.data.refOrder || []).join(',')]); // refOrder 变化必须重建：否则 [图N] 与实际上送顺序不一致
      if (!es.length) return null;
      const move = (id, dir) => {
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (!nd) return;
          const order = (nd.data.refOrder || []).filter((x2) => es.some((e) => e.id === x2));
          for (const e of es) if (!order.includes(e.id)) order.push(e.id);
          const i = order.indexOf(id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= order.length) return;
          order.splice(j, 0, order.splice(i, 1)[0]);
          nd.data.refOrder = order;
        });
      };
      const unbind = (edgeId) => update((s) => { s.graph.edges = s.graph.edges.filter((x) => x.id !== edgeId); });
      return h('div', { className: 'dshic-shot-list' },
        h('div', { className: 'dshic-shot-label' }, T('refList')),
        rows.map((r, i) => h('div', { key: r.edgeId, className: 'dshic-row' },
          h('span', { className: 'dshic-tag api' }, '[图' + (i + 1) + ']'),
          h('span', { style: { flex: 1, minWidth: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, catLabel(r.cat) + '：' + r.name),
          h('button', { type: 'button', className: 'dshic-iconbtn', disabled: i === 0, title: T('moveUp'), onPointerDown: (e) => e.stopPropagation(), onClick: () => move(r.edgeId, -1) }, '↑'),
          h('button', { type: 'button', className: 'dshic-iconbtn', disabled: i === rows.length - 1, title: T('moveDown'), onPointerDown: (e) => e.stopPropagation(), onClick: () => move(r.edgeId, 1) }, '↓'),
          h('button', { type: 'button', className: 'dshic-iconbtn is-danger', title: T('unbind'), onPointerDown: (e) => e.stopPropagation(), onClick: () => unbind(r.edgeId) }, '✕'),
        )),
      );
    }

    function AssetNodeBody({ n, kind }) {
      const assetUrlV = useAssetUrl(n.data.assetId);
      const fileRef = useRef(null);
      const onFiles = async (e) => {
        const f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        const isImg = f.type.startsWith('image/');
        const isVid = f.type.startsWith('video/');
        if (kind === 'image' ? !isImg : !isVid) { toast(kind === 'image' ? T('pickImageFile') : T('pickVideoFile')); return; }
        const rec = await saveAssetRecord(S.activeId, kind, f, { name: f.name, source: 'upload', category: 'general' }).catch((err) => {
          toast(T('uploadFailed') + '：' + String((err && err.message) || err));
          return null;
        });
        if (!rec) return;
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.assetId = rec.id; nd.data.status = 'done'; nd.data.placeholderName = null; }
          s.assetsTick++;
        });
      };
      return [
        h('div', { key: 'row', className: 'dshic-node-row' },
          h('button', {
            type: 'button', className: 'dshic-mini is-ghost',
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => { if (fileRef.current) fileRef.current.click(); },
          }, Ic('upload', 11), T('upload')),
          n.data.assetId ? h('button', {
            type: 'button', className: 'dshic-mini is-ghost',
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.assetId = null; }),
          }, T('clearRef')) : null,
          h('div', { className: 'dshic-flex' }),
          h(StatusTag, { n }),
        ),
        h('input', { key: 'file', ref: fileRef, type: 'file', accept: kind === 'image' ? 'image/*' : 'video/*', style: { display: 'none' }, onChange: onFiles }),
        assetUrlV && kind === 'image'
          ? h('img', { key: 'img', className: 'dshic-preview', src: assetUrlV, draggable: false, 'data-no-drag': '1' })
          : null,
        assetUrlV && kind === 'video'
          ? h('video', { key: 'vid', className: 'dshic-video', src: assetUrlV, controls: true, preload: 'metadata', 'data-no-drag': '1', onPointerDown: (e) => e.stopPropagation() })
          : null,
        !assetUrlV ? h('div', { key: 'hint', className: 'dshic-hint' },
          n.data.placeholderName ? `${T('placeholderAsset')}：${n.data.placeholderName}` : T('pickAsset')) : null,
      ];
    }

    function TextNodeBody({ n }) {
      return h('textarea', {
        className: 'dshic-textarea', value: n.data.text || '',
        placeholder: T('textPlaceholder'),
        onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.text = e.target.value; }),
        onPointerDown: (e) => e.stopPropagation(),
      });
    }

    function ShotNodeBody({ n }) {
      const refLines = [['char', T('portChar')], ['scene', T('portScene')], ['prop', T('portProp')]]
        .map(([port, lb]) => ({
          lb,
          names: S.graph.edges
            .filter((x) => x.toNode === n.id && x.toPort === port)
            .map((x) => {
              const src = S.graph.nodes[x.fromNode];
              if (!src) return null;
              const aid = servedAssetId(src, x.fromPort);
              if (aid) return assetNameCache.get(aid) || '…';
              return src.data.placeholderName || null;
            })
            .filter(Boolean),
        }))
        .filter((x) => x.names.length);
      return h('div', { className: 'dshic-shot-fields' },
        refLines.length
          ? h('div', { key: 'refs', className: 'dshic-hint' },
              refLines.map((x) => x.lb + '：' + x.names.join('、')).join(' ｜ '))
          : null,
        h('span', { className: 'dshic-shot-label' }, T('visualLabel')),
        h('textarea', {
          className: 'dshic-textarea', style: { minHeight: 52 }, value: n.data.visual || '',
          placeholder: T('shotVisualPlaceholder'),
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.visual = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
        h('span', { className: 'dshic-shot-label' }, T('motionLabel')),
        h('textarea', {
          className: 'dshic-textarea', style: { minHeight: 44 }, value: n.data.motion || '',
          placeholder: T('shotMotionPlaceholder'),
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.motion = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
      );
    }

    /**
     * 提示词输入框：@名称 蓝色加粗高亮。
     * 与主流工具同一做法——透明文字的 textarea 叠在同步滚动的背景层上，
     * 背景层渲染同一段文本并给 @名称 上色，光标/选区/中文输入法都不受影响。
     */
    function PromptArea({ value, onChange, placeholder, minHeight, style }) {
      const taRef = useRef(null);
      const backRef = useRef(null);
      const sync = () => {
        if (backRef.current && taRef.current) {
          backRef.current.scrollTop = taRef.current.scrollTop;
          backRef.current.scrollLeft = taRef.current.scrollLeft;
        }
      };
      const html = highlightMentions(value || '');
      const ph = placeholder ? '<span class="dshic-prompt-ph">' + escapeHtml(placeholder) + '</span>' : '';
      return h('div', { className: 'dshic-prompt' },
        h('div', {
          ref: backRef, className: 'dshic-prompt-back', 'aria-hidden': 'true',
          dangerouslySetInnerHTML: { __html: html || ph },
        }),
        h('textarea', {
          ref: taRef, className: 'dshic-textarea dshic-prompt-input', value: value || '',
          placeholder: html ? undefined : placeholder,
          style: { minHeight: minHeight || 72, ...(style || {}) },
          onChange: (e) => onChange(e.target.value),
          onScroll: sync,
          onPointerDown: (e) => e.stopPropagation(),
          onKeyUp: sync,
          onClick: sync,
        }),
      );
    }

    function ScriptNodeBody({ n }) {
      const running = n.data.aiStatus === 'running';
      const generate = async () => {
        try { await genScriptNode(n); } catch (e) { toast(String((e && e.message) || e)); }
      };
      return [
        h('div', { key: 'mrow', className: 'dshic-node-row' },
          h(ModelSelect, { value: n.data.model, title: T('llmLabel'), onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.model = v; }) }),
          h('div', { className: 'dshic-flex' }),
        ),
        h('span', { key: 'l1', className: 'dshic-shot-label' }, T('ideaLabel')),
        h('textarea', {
          key: 'idea', className: 'dshic-textarea', style: { minHeight: 72 }, value: n.data.idea || '',
          placeholder: T('ideaPlaceholder'),
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.idea = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
        h('button', { key: 'gen', type: 'button', className: 'dshic-gen', disabled: running, onClick: generate, onPointerDown: (e) => e.stopPropagation() },
          running ? h('span', { className: 'dshic-spin' }) : Ic('spark', 12), running ? T('aiRunning') : T('aiScript')),
        running && aiStreamLine(n.id)
          ? h('div', { key: 'stream', className: 'dshic-stream', title: aiStreamLine(n.id) },
              h('span', { className: 'dshic-stream-dot' }), aiStreamLine(n.id))
          : null,
        h('div', { key: 'btns', className: 'dshic-node-row' },
          h('div', { className: 'dshic-flex' }),
          n.data.output ? h('button', {
            type: 'button', className: 'dshic-mini is-ghost', title: T('saveTextAsset'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: async () => {
              await saveTextAssetRecord(S.activeId, { name: (String(n.data.label || '').trim() || T('scriptAssetPrefix')) + ' ' + nowStamp(), text: n.data.output, category: 'script', prompt: n.data.idea });
              update((s) => { s.assetsTick++; });
              toast(T('savedOk'));
            },
          }, Ic('download', 11), T('saveTextAsset')) : null,
        ),
        n.data.aiError ? h('div', { key: 'err', className: 'dshic-err' }, n.data.aiError) : null,
        h('span', { key: 'l2', className: 'dshic-shot-label' }, T('scriptOutputLabel')),
        h('textarea', {
          key: 'out', className: 'dshic-textarea', style: { minHeight: 180 }, value: n.data.output || '',
          placeholder: running ? T('aiRunning') : '',
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.output = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
      ];
    }

    function StoryboardNodeBody({ n }) {
      const running = n.data.aiStatus === 'running';
      const scriptEdge = S.graph.edges.some((x) => x.toNode === n.id && x.toPort === 'script');
      const scriptText = () => {
        if (scriptEdge) {
          const e = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'script');
          const src = e && S.graph.nodes[e.fromNode];
          if (src && src.type === 'script' && (src.data.output || '').trim()) return src.data.output.trim();
          if (src && src.type === 'text' && (src.data.text || '').trim()) return src.data.text.trim();
        }
        return String(n.data.script || '').trim();
      };
      const generate = async () => {
        const st = scriptText();
        if (!st) { toast(T('aiNeedScript')); return; }
        try { await genStoryboardNode(n); } catch (e) { toast(String((e && e.message) || e)); }
      };
      const shots = n.data.shots || [];
      return [
        h('div', { key: 'mrow', className: 'dshic-node-row' },
          h(ModelSelect, { value: n.data.model, title: T('llmLabel'), onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.model = v; }) }),
          h('div', { className: 'dshic-flex' }),
        ),
        h('span', { key: 'l1', className: 'dshic-shot-label' }, T('storyboardScriptLabel') + (scriptEdge ? ' · ' + T('connected') : '')),
        h('textarea', {
          key: 'script', className: 'dshic-textarea', style: { minHeight: 56 }, value: n.data.script || '',
          placeholder: scriptEdge ? T('connected') : T('storyboardScriptLabel'),
          disabled: !!scriptEdge,
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.script = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
        h('textarea', {
          key: 'req', className: 'dshic-textarea', style: { minHeight: 40 }, value: n.data.requirement || '',
          placeholder: T('storyboardReqLabel'),
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.requirement = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
        h('div', { key: 'row', className: 'dshic-node-row' },
          h(MiniSelect, {
            value: String(n.data.count || 6), title: T('storyboardCountLabel'), width: 72,
            options: [3, 4, 6, 8, 10, 12, 16].map((x) => ({ value: String(x), label: x + ' ' + T('shotsUnit') })),
            onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.count = Number(v); }),
          }),
          h('div', { className: 'dshic-flex' }),
        ),
        h('button', { key: 'gen', type: 'button', className: 'dshic-gen', disabled: running, onClick: generate, onPointerDown: (e) => e.stopPropagation() },
          running ? h('span', { className: 'dshic-spin' }) : Ic('spark', 12), running ? T('aiRunning') : T('aiStoryboard')),
        running && aiStreamLine(n.id)
          ? h('div', { key: 'stream', className: 'dshic-stream', title: aiStreamLine(n.id) },
              h('span', { className: 'dshic-stream-dot' }), aiStreamLine(n.id))
          : null,
        n.data.aiError ? h('div', { key: 'err', className: 'dshic-err' }, n.data.aiError) : null,
        (n.data.warnings || []).length
          ? h('div', { key: 'warn', className: 'dshic-card', style: { padding: 6, gap: 3 } },
              h('div', { className: 'dshic-shot-label' }, T('consistencyTitle')),
              n.data.warnings.map((w, i) => h('div', { key: i, className: 'dshic-err', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '· ' + w)),
            )
          : null,
        shots.length
          ? h('div', { key: 'list', className: 'dshic-shot-list' },
              shots.map((sh, i) => h('div', { key: i, className: 'dshic-shot-item' },
                h('strong', {}, `${sh.title} · ${sh.duration}s `), sh.visual)),
            )
          : null,
        shots.length
          ? h('div', { key: 'acts', className: 'dshic-node-row', style: { alignSelf: 'flex-start' } },
              // 手动"存为资产"：AI 生成已自动入库（category=storyboard），这里用于留存当前分镜的一版快照
              h('button', {
                key: 'save', type: 'button', className: 'dshic-mini is-ghost', title: T('saveTextAsset'),
                onPointerDown: (e) => e.stopPropagation(),
                onClick: async () => {
                  try {
                    await saveTextAssetRecord(S.activeId, {
                      name: (String(n.data.label || '').trim() || T('storyboardAssetPrefix')) + ' ' + nowStamp(),
                      text: storyboardAssetText(shots), category: 'storyboard',
                      prompt: String(n.data.script || '').slice(0, 200),
                    });
                    update((s) => { s.assetsTick++; });
                    toast(T('savedOk'));
                  } catch (err) { toast(String((err && err.message) || err)); }
                },
              }, Ic('download', 11), T('saveTextAsset')),
              h('button', { key: 'expand', type: 'button', className: 'dshic-mini', onClick: () => expandStoryboard(n), onPointerDown: (e) => e.stopPropagation() },
                Ic('expandAll', 11), T('expand') + ` (${shots.length})`),
            )
          : null,
      ];
    }

    // 分镜表 → 画布（现代多镜头工作流）：**一个分镜表 = 一次视频生成**。
    // 分镜表(镜头脚本)连到 1 个视频生成节点的 prompt 端口（运行时把全部镜头按顺序+时长组合成
    // 一条多镜头提示词，一次性生成整段视频）；角色/场景/道具参考图按实体**跨镜去重**后连到 ref 端口；
    // 视频生成 → 1 个视频资产。不再一镜一视频、无需拼接。
    async function expandStoryboard(n) {
      const shots = (n.data.shots || []).slice();
      if (!shots.length) { toast(T('expandNoShots')); return; }
      // 项目资产名称索引（用于把角色/场景/道具连接到已有资产节点）
      const recs = await idbByProject(S.activeId).catch(() => []);
      const norm = (s) => String(s || '').trim().toLowerCase();
      const nameIndex = recs.filter((r) => r.kind === 'image').map((r) => ({ id: r.id, name: norm(r.name), category: r.category }));
      // 跨镜去重的实体清单：所有镜头共用的角色/场景/道具各一个参考图节点
      const entityNames = [];
      const pushName = (nm) => {
        const q = String(nm || '').trim();
        if (q && !entityNames.some((x) => x.toLowerCase() === q.toLowerCase())) entityNames.push(q);
      };
      for (const sh of shots) {
        (sh.characters || []).forEach(pushName);
        if (sh.scene) pushName(sh.scene);
        (sh.props || []).forEach(pushName);
      }
      update((s) => {
        const findAssetNode = (name) => {
          const q = norm(name);
          if (!q) return null;
          const hit = nameIndex.find((x) => x.name === q) || nameIndex.find((x) => x.name.includes(q) || q.includes(x.name));
          if (!hit) return null;
          for (const nd of Object.values(s.graph.nodes)) {
            if (nd.type === 'image-asset' && nd.data.assetId === hit.id) return nd;
          }
          return null;
        };
        const linkRaw = (from, fp, to, tp) => {
          if (!from || !to) return;
          if (from.id === to.id) return;
          if (!MULTI_INPUT_PORTS.has(tp) && s.graph.edges.some((e) => e.toNode === to.id && e.toPort === tp)) return;
          if (reaches(to.id, from.id)) return;
          s.graph.edges.push({ id: uid('e'), fromNode: from.id, fromPort: fp, toNode: to.id, toPort: tp });
        };
        const mk = (type, x, y, dataOver, label) => {
          const nd = newNode(type, { x, y });
          if (dataOver) nd.data = { ...nd.data, ...dataOver };
          if (label) nd.data.label = label;
          s.graph.nodes[nd.id] = nd;
          return nd;
        };
        const baseX = n.x + n.w + 140;
        const baseY = n.y - 40;
        // 生成时长 = 各镜时长之和（多镜头一次性生成的总时长），由视频模型内部切镜
        const total = shots.reduce((a, sh) => a + Math.max(1, Number(sh.duration) || 3), 0);
        const videoGen = mk('video-gen', baseX + 360, baseY + 20, { prompt: '', duration: Math.max(3, Math.min(20, total)) });
        const videoAsset = mk('video-asset', baseX + 720, baseY + 20);
        entityNames.forEach((nm, i) => {
          let an = findAssetNode(nm);
          if (!an) an = mk('image-asset', baseX, baseY + i * 130, { placeholderName: nm });
          linkRaw(an, 'out', videoGen, 'ref');
        });
        linkRaw(n, 'out', videoGen, 'prompt'); // 多镜头提示词来自上游分镜表（不复制文本）
        linkRaw(videoGen, 'out', videoAsset, 'in');
        s.sel = new Set([videoGen.id]);
      });
      pushHistory();
      flushSave(); // 批量铺开立即推送，Host 侧立即可见
      toast(T('expandDone').replace('{n}', String(shots.length)));
      setTimeout(() => fitView(), 60);
    }

    function FinalCutNodeBody({ n }) {
      const running = n.data.status === 'running';
      const [fcDialog, setFcDialog] = useState(null);
      const segEdges = S.graph.edges.filter((x) => x.toNode === n.id && x.toPort === 'in');
      const segs = segEdges
        .map((e) => ({ e, nd: S.graph.nodes[e.fromNode] }))
        .filter((x) => x.nd)
        .sort((a, b) => (a.nd.y - b.nd.y) || (a.nd.x - b.nd.x));
      const assetUrlV = useAssetUrl(n.data.assetId);
      const fcUrl = useAssetUrl(n.data.fcAssetId);
      useEffect(() => { probeCraft(); }, []);
      const getSub = (x) => {
        const defSub = x.nd.type === 'video-gen' ? (x.nd.data.prompt || '') : (x.nd.data.label || TYPE_LABEL()[x.nd.type]);
        const v = n.data.subs && n.data.subs[x.e.id];
        return v != null ? v : defSub;
      };
      const genTts = async (x) => {
        const settings = loadSettings();
        const cfg = resolveApiCfg(settings.ttsApis, settings.ttsApiId, null);
        if (!cfg) { toast(T('errNoTts')); return; }
        const text = String(getSub(x) || '').trim();
        if (!text) { toast(T('subPlaceholder')); return; }
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.tts = nd.data.tts || {}; nd.data.tts[x.e.id] = { status: 'running' }; } });
        try {
          // TTS 也走 Host 代理：浏览器直连 TTS 网关同样会被 CORS 拦
          const res = await fetchViaProxy((cfg.baseUrl || '').replace(/\/+$/, '') + '/audio/speech', {
            headers: { ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}) },
            body: { ...(cfg.model ? { model: cfg.model } : {}), input: text, voice: cfg.voice || 'alloy', response_format: 'mp3' },
            timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 120000,
            label: 'TTS API',
          });
          if (!res.ok) throw new Error('TTS HTTP ' + res.status + '：' + res.text.slice(0, 200));
          const blob = /^audio\//.test(res.contentType) ? res.blob : new Blob([res.blob], { type: 'audio/mpeg' });
          const rec = await saveAssetRecord(S.activeId, 'audio', blob, { name: 'TTS-' + text.slice(0, 12), prompt: text, source: 'api', category: 'audio' });
          update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.tts = nd.data.tts || {}; nd.data.tts[x.e.id] = { status: 'done', assetId: rec.id }; } s.assetsTick++; });
        } catch (e) {
          update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.tts = nd.data.tts || {}; nd.data.tts[x.e.id] = { status: 'error', error: String(e.message || e) }; } });
        }
      };
      const compose = async () => {
        if (!segs.length) { toast(T('noSegments')); return; }
        try { await genFinalCutNode(n); toast(T('composeDone')); } catch (e) { toast(String((e && e.message) || e)); }
      };
      const filmcraftExport = async () => {
        const st = await craftStatusSafe();
        if (!st) return;
        if (!(st.bins && st.bins.filmcraft && st.bins.filmcraft.found)) { toast(T('craftCliMissing').replace('{name}', 'filmcraft')); return; }
        const items = [];
        for (const x of segs) {
          if (!x.nd.data.assetId) continue;
          try {
            const rec = await idbGet(x.nd.data.assetId);
            const blob = await assetBlob(x.nd.data.assetId);
            if (!blob) continue;
            const rel = await ensureAssetOnDisk({ ...(rec || {}), id: x.nd.data.assetId, blob });
            const vd = await videoDurationOf(blob);
            const ed = Number(x.nd.data.editDuration) || 0;
            items.push({ rel, name: (rec && rec.name) || 'seg', sub: getSub(x), dur: ed > 0 ? Math.min(ed, vd) : vd });
          } catch (e) { toast('Craft: ' + (e.message || e)); return; }
        }
        if (!items.length) { toast(T('noSegments')); return; }
        const slug = craftProjectSlug();
        const dims = videoDimsFor({ resolution: n.data.resolution, ratio: n.data.ratio });
        const xml = buildFcp7Xml(items, {
          name: (S.projects.find((p) => p.id === S.activeId) || {}).name || 'project',
          dataRoot: (st.dataRoot && st.dataRoot.path) || '',
          width: dims.w, height: dims.h,
        });
        try {
          await craft.writeText('projects/' + slug + '/craft/timeline.xml', xml);
          await craft.writeText('projects/' + slug + '/craft/subs.srt', buildSrt(items));
        } catch (e) { return; /* craftFetch 已提示 */ }
        setFcDialog({
          args: JSON.stringify(['--project', 'projects/' + slug + '/craft/drama.fcproj', '--import', 'projects/' + slug + '/craft/timeline.xml', '--export', 'projects/' + slug + '/craft/out/final.mp4'], null, 1),
          outRel: 'projects/' + slug + '/craft/out/final.mp4',
        });
      };
      const submitFc = (args, outRel) => {
        craft.jobStart({ bin: 'filmcraft', args, outputs: [outRel], timeoutMs: 30 * 60 * 1000 }).then((job) => {
          update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.fcJobId = job.id; nd.data.fcStatus = 'running'; } });
          setFcDialog(null);
          pollFilmcraftJob(n.id, job.id, outRel);
        }).catch(() => { /* craftFetch 已提示 */ });
      };
      return [
        h('div', { key: 'set', style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          h('div', { className: 'dshic-node-row' },
            h(MiniSelect, {
              value: n.data.resolution || '720P', title: T('resolutionLabel'), width: 68,
              options: VIDEO_RESOLUTIONS.map((x) => ({ value: x, label: x })),
              onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.resolution = v; }),
            }),
            h(MiniSelect, {
              value: n.data.ratio || '16:9', title: T('ratioLabel'), width: 64,
              options: RATIOS.map((r) => ({ value: r, label: r })),
              onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.ratio = v; }),
            }),
            h(MiniSelect, {
              value: n.data.transition || 'none', title: T('transition'), width: 64,
              options: [{ value: 'none', label: T('transNone') }, { value: 'fade', label: T('transFade') }, { value: 'black', label: T('transBlack') }],
              onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.transition = v; }),
            }),
          ),
          h('div', { className: 'dshic-node-row' },
            h(MiniSelect, {
              value: n.data.keepAudio === false ? 'off' : 'on', title: T('keepAudio'), width: 76,
              options: [{ value: 'on', label: T('keepAudio') + ' ' + T('on') }, { value: 'off', label: T('keepAudio') + ' ' + T('off') }],
              onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.keepAudio = v !== 'off'; }),
            }),
            h(MiniSelect, {
              value: n.data.bitrate || '', title: T('bitrate'), width: 92,
              options: [
                { value: '', label: T('bitrateAuto') },
                { value: '4000000', label: '4 Mbps' },
                { value: '8000000', label: '8 Mbps' },
                { value: '12000000', label: '12 Mbps' },
              ],
              onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.bitrate = v; }),
            }),
            h('div', { className: 'dshic-flex' }),
          ),
        ),
        h('span', { key: 'l1', className: 'dshic-shot-label' }, T('segmentsLabel')),
        h('div', { key: 'list', className: 'dshic-shot-list' },
          segs.length
            ? segs.map((x, i) => {
                const defSub = x.nd.type === 'video-gen' ? (x.nd.data.prompt || '') : (x.nd.data.label || TYPE_LABEL()[x.nd.type]);
                const val = (n.data.subs && n.data.subs[x.e.id] != null) ? n.data.subs[x.e.id] : defSub;
                const tts = (n.data.tts && n.data.tts[x.e.id]) || {};
                return h('div', { key: x.e.id, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  h('div', { className: 'dshic-shot-item' },
                    h('strong', {}, (i + 1) + '. '), x.nd.data.label || TYPE_LABEL()[x.nd.type]),
                  h('input', {
                    className: 'dshic-input', value: val, placeholder: T('subPlaceholder'),
                    onChange: (e) => update((s) => {
                      const nd = s.graph.nodes[n.id];
                      if (nd) { nd.data.subs = nd.data.subs || {}; nd.data.subs[x.e.id] = e.target.value; }
                    }),
                    onPointerDown: (e) => e.stopPropagation(),
                  }),
                  h('div', { className: 'dshic-node-row' },
                    h('button', {
                      type: 'button', className: 'dshic-mini is-ghost',
                      disabled: tts.status === 'running',
                      onPointerDown: (e) => e.stopPropagation(),
                      onClick: () => genTts(x),
                    }, Ic('audio', 11),
                      tts.status === 'running' ? T('ttsRunning')
                        : tts.assetId ? T('tts') + ' ✓'
                        : T('ttsGen')),
                    tts.error ? h('span', { className: 'dshic-err' }, tts.error) : null,
                  ),
                );
              })
            : h('div', { className: 'dshic-hint' }, T('noSegments')),
        ),
        h('div', { key: 'hint', className: 'dshic-hint' }, T('composeHint')),
        n.data.error ? h('div', { key: 'err', className: 'dshic-err' }, n.data.error) : null,
        h('button', {
          key: 'go', type: 'button', className: 'dshic-gen', disabled: running,
          onPointerDown: (e) => e.stopPropagation(),
          onClick: compose,
        }, running ? h('span', { className: 'dshic-spin' }) : Ic('film', 12),
          running ? T('composing') + (n.data.progress ? ' ' + n.data.progress : '…') : T('compose')),
        h('button', {
          key: 'fc', type: 'button', className: 'dshic-mini', style: { alignSelf: 'flex-start' },
          disabled: !segs.length || !craftOkCached(),
          title: craftOkCached() ? T('filmcraftExport') : T('craftUnreachable'),
          onPointerDown: (e) => e.stopPropagation(),
          onClick: filmcraftExport,
        }, Ic('film', 11), T('filmcraftExport')),
        n.data.fcJobId || n.data.fcStatus
          ? h('div', { key: 'fcst', className: 'dshic-node-row' },
              h('span', { className: 'dshic-hint', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'FilmCraft: ' + (n.data.fcStatus || '')),
              n.data.fcJobId
                ? h('button', {
                    type: 'button', className: 'dshic-mini is-ghost', title: T('craftCancel'),
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => { craft.jobCancel(n.data.fcJobId).catch(() => { /* 已提示 */ }); },
                  }, Ic('stop', 11), T('craftCancel'))
                : null,
            )
          : null,
        n.data.fcAssetId && fcUrl
          ? [
              h('div', { key: 'fclb', className: 'dshic-hint' }, 'FilmCraft MP4'),
              h('video', { key: 'fcv', className: 'dshic-video', src: fcUrl, controls: true, preload: 'metadata', 'data-no-drag': '1', onPointerDown: (e) => e.stopPropagation() }),
              h('div', { key: 'fcda', className: 'dshic-node-row' },
                h('button', {
                  type: 'button', className: 'dshic-mini is-ghost',
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: () => downloadBlobFromUrl(fcUrl, 'finalcut-fc-' + n.id.slice(-5) + '.mp4'),
                }, Ic('download', 11), T('download')),
                h('div', { className: 'dshic-flex' })),
            ]
          : null,
        fcDialog ? h(FilmcraftArgsDialog, { key: 'fcdlg', info: fcDialog, onSubmit: submitFc, onClose: () => setFcDialog(null) }) : null,
        assetUrlV
          ? [
              h('video', { key: 'vid', className: 'dshic-video', src: assetUrlV, controls: true, preload: 'metadata', 'data-no-drag': '1', onPointerDown: (e) => e.stopPropagation() }),
              h('div', { key: 'acts', className: 'dshic-node-row' },
                h('button', {
                  type: 'button', className: 'dshic-mini is-ghost',
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: () => downloadBlobFromUrl(assetUrlV, 'finalcut-' + n.id.slice(-5) + '.webm'),
                }, Ic('download', 11), T('download')),
                h('div', { className: 'dshic-flex' }),
              ),
            ]
          : null,
      ];
    }

    function nodeBody(n) {
      if (n.type === 'text') return h(TextNodeBody, { n });
      if (n.type === 'shot') return h(ShotNodeBody, { n });
      if (n.type === 'script') return h(ScriptNodeBody, { n });
      if (n.type === 'storyboard') return h(StoryboardNodeBody, { n });
      if (n.type === 'image-gen') return h(GenNodeBody, { n, kind: 'image' });
      if (n.type === 'video-gen') return h(GenNodeBody, { n, kind: 'video' });
      if (n.type === 'image-asset') return h(AssetNodeBody, { n, kind: 'image' });
      if (n.type === 'video-asset') return h(AssetNodeBody, { n, kind: 'video' });
      if (n.type === 'finalcut') return h(FinalCutNodeBody, { n });
      return null;
    }

    function EdgeLayer() {
      const setTemp = useCallback((el) => { tempEdgeEl = el; }, []);
      return h('svg', { className: 'dshic-edges' },
        h('path', { ref: setTemp, className: 'dshic-edge-temp', style: { display: 'none' } }),
        S.graph.edges.map((e) => {
          const kind = edgeKind(e);
          const sel = S.selEdge === e.id;
          const g = edgeGeom(e);
          return h('g', { key: e.id, className: 'dshic-edge-g' },
            h('path', {
              d: g.d, className: 'dshic-edge-hit', 'data-edge-id': e.id,
              onPointerDown: (ev) => { ev.stopPropagation(); update((s) => { s.selEdge = e.id; s.sel = new Set(); }); },
            }),
            h('path', {
              ref: (el) => { if (el) edgePathEls.set(e.id, el); else edgePathEls.delete(e.id); },
              d: g.d, className: cls('dshic-edge', 'kind-' + kind, sel && 'is-selected'),
            }),
            // 悬停中点显示删除按钮（Toonflow 式）
            h('g', {
              className: 'dshic-edge-delwrap', transform: `translate(${g.mx}, ${g.my})`,
              onPointerDown: (ev) => {
                ev.stopPropagation();
                update((s) => { s.graph.edges = s.graph.edges.filter((x) => x.id !== e.id); if (s.selEdge === e.id) s.selEdge = null; });
                pushHistory();
                flushSave(); // 边删除立即推送：压缩 450ms 防抖窗口内的"拉回复活"
              },
            },
              h('circle', { r: 9, className: 'dshic-edge-delbg' }),
              h('path', { d: 'M-3 -3 L3 3 M3 -3 L-3 3', className: 'dshic-edge-delx' }),
            ),
          );
        }),
      );
    }

    // ============================================================
    // 工具栏 / 菜单
    // ============================================================
    function ContextMenu({ menu }) {
      const labels = TYPE_LABEL();
      if (menu.kind === 'node') {
        const n = S.graph.nodes[menu.nodeId];
        if (!n) return null;
        const canRun = n.type === 'image-gen' || n.type === 'video-gen';
        const items = [
          { label: T('copyNode'), icon: 'plus', fn: () => { update((s) => { s.sel = new Set([n.id]); }); duplicateSelection(); } },
          ...(canRun ? [{ label: T('runNode'), icon: 'play', fn: () => { runGenNode(n); } }] : []),
          ...(S.sel.size >= 2 ? [{ label: T('createGroup'), icon: 'folder', fn: () => createGroupFromSelection() }] : []),
          ...(n.type === 'group' ? [{ label: T('ungroup'), icon: 'folder', fn: () => ungroupNode(n.id) }] : []),
          { label: T('delete'), icon: 'trash', danger: true, fn: () => (n.type === 'group' ? ungroupNode(n.id) : removeNodes([n.id])) },
        ];
        return [
          h('div', { key: 'ov', className: 'dshic-overlay', onPointerDown: closeMenu, onContextMenu: (e) => { e.preventDefault(); closeMenu(); } }),
          h('div', { key: 'm', className: 'dshic-menu', style: { left: menu.x, top: menu.y } },
            items.map((it) => h('button', {
              key: it.label, type: 'button', className: 'dshic-menu-item',
              style: it.danger ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
              onClick: () => { it.fn(); closeMenu(); },
            }, Ic(it.icon, 12), it.label)),
          ),
        ];
      }
      const items = [
        { type: 'text', icon: 'text' },
        { type: 'script', icon: 'script' },
        { type: 'storyboard', icon: 'board' },
        { type: 'image-gen', icon: 'spark' },
        { type: 'video-gen', icon: 'video' },
        { type: 'image-asset', icon: 'image' },
        { type: 'video-asset', icon: 'video' },
        { type: 'finalcut', icon: 'film' },
      ];
      const add = (type) => {
        const c = worldCenter();
        addNodeAt(type, { x: c.x + (Math.random() * 60 - 30), y: c.y + (Math.random() * 60 - 30) });
        closeMenu();
      };
      return [
        h('div', { key: 'ov', className: 'dshic-overlay', onPointerDown: closeMenu, onContextMenu: (e) => { e.preventDefault(); closeMenu(); } }),
        h('div', { key: 'm', className: 'dshic-menu', style: { left: menu.x, top: menu.y } },
          items.map((it) => h('button', {
            key: it.type, type: 'button', className: 'dshic-menu-item',
            onClick: () => add(it.type),
          }, Ic(it.icon, 13), labels[it.type])),
        ),
      ];
    }

    function Toolbar() {
      const labels = TYPE_LABEL();
      const [naming, setNaming] = useState(false);
      const proj = S.projects.find((p) => p.id === S.activeId);
      return h('div', { className: 'dshic-toolbar' },
        h(Btn, { onClick: () => CTX && CTX.layout.selectPanel(null), title: T('back') }, Ic('back', 13), h('span', { className: 'dshic-toolbar-title' }, T('back'))),
        h('div', { className: 'dshic-toolbar-sep' }),
        h(Btn, {
          onClick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            S.menu = { x: r.left, y: r.bottom + 4, kind: 'add' };
            notify();
          },
          title: T('addNode'),
        }, Ic('plus', 13), T('addNode')),
        S.running
          ? h(Btn, { onClick: stopRun, title: T('stop') }, Ic('stop', 12), T('running'))
          : h(Btn, { onClick: runWorkflow, primary: true, title: T('run') }, Ic('play', 12), T('run')),
        h(Btn, { onClick: fitView, title: T('fit') }, Ic('fit', 13)),
        h(Btn, { onClick: undo, title: T('undo'), disabled: history.idx <= 0 }, Ic('undoIc', 13)),
        h(Btn, { onClick: redo, title: T('redo'), disabled: history.idx >= history.stack.length - 1 }, Ic('redoIc', 13)),
        h('div', { className: 'dshic-flex' }),
        h('div', { className: 'dshic-zoom-group' },
          h(Btn, { onClick: () => zoomStep(0.85), title: T('zoomOut') }, Ic('zoomOut', 12)),
          h('button', { type: 'button', className: 'dshic-zoom-val', title: T('zoomReset'), onClick: () => resetZoom() }, Math.round(V.scale * 100) + '%'),
          h(Btn, { onClick: () => zoomStep(1.18), title: T('zoomIn') }, Ic('zoomIn', 12)),
        ),
        h('div', { className: 'dshic-toolbar-sep' }),
        naming
          ? h('input', {
              className: 'dshic-input', style: { width: 160 }, autoFocus: true, defaultValue: proj ? proj.name : '',
              onBlur: (e) => { const v = e.target.value.trim(); if (v && proj) update((s) => { const p = s.projects.find((x) => x.id === s.activeId); if (p) p.name = v; }); setNaming(false); },
              onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setNaming(false); },
            })
          : h('button', { type: 'button', className: 'dshic-btn', style: { fontWeight: 600, maxWidth: 180, overflow: 'hidden' }, onDoubleClick: () => setNaming(true), title: T('renameHint') },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, proj ? proj.name : '')),
        h('div', { className: 'dshic-toolbar-sep' }),
        h('button', {
          type: 'button', className: cls('dshic-btn'), style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', gap: 4 },
          title: T('updateBtn') + ((S.updateInfo && S.updateInfo.runningVersion) ? '（当前 v' + S.updateInfo.runningVersion + '）' : ''), disabled: S.updateChecking,
          onClick: () => { checkUpdate(false).then((info) => { if (info && info.upToDate) toast(T('updateUpToDate') + (info.runningVersion ? ' v' + info.runningVersion : '')); }); },
        }, T('updateBtn'), S.updateChecking ? h('span', { className: 'dshic-spin' }) : ((S.updateInfo && !S.updateInfo.upToDate) ? ' ⬆' : '')),
        h('div', { className: 'dshic-toolbar-sep' }),
        h(Btn, {
          active: S.rightOpen, title: T('toggleRight'),
          onClick: () => update((s) => { s.rightOpen = !s.rightOpen; }),
        }, Ic('sidebar', 13)),
      );
    }

    // ============================================================
    // 右侧边栏：项目 / 资产 / 设置
    // ============================================================
    function ProjectsTab() {
      const [creating, setCreating] = useState(false);
      const [name, setName] = useState('');
      const [editId, setEditId] = useState(null);
      const [editName, setEditName] = useState('');
      const [delTarget, setDelTarget] = useState(null);
      const [delName, setDelName] = useState('');
      const [delCount, setDelCount] = useState(0);

      const create = () => {
        const nm = name.trim() || (T('projectName') + ' ' + (S.projects.length + 1));
        const p = { id: uid('p'), name: nm, createdAt: Date.now(), updatedAt: Date.now() };
        update((s) => { s.projects.push(p); });
        switchProject(p.id);
        try { hostRpc('projectsPut', { id: p.id, name: nm, doc: emptyGraph() }).catch(() => { /* 静默 */ }); } catch { /* 忽略 */ }
        setCreating(false); setName('');
      };
      const commitRename = () => {
        const v = editName.trim();
        if (v && editId) {
          update((s) => {
            const p = s.projects.find((x) => x.id === editId);
            if (p) { p.name = v; p.updatedAt = Date.now(); }
          });
          lsSet(LS_PROJECTS, S.projects);
          try {
            const doc = loadGraphDoc(editId) || emptyGraph();
            hostRpc('projectsPut', { id: editId, name: v, doc }).catch(() => { /* 静默 */ });
          } catch { /* 忽略 */ }
        }
        setEditId(null);
      };
      const openDel = (p) => {
        setDelTarget(p);
        setDelName('');
        idbByProject(p.id).then((rs) => setDelCount(rs.length)).catch(() => setDelCount(0));
      };
      // 删除流程：先同步移除并立即持久化（UI 立刻生效），再后台清理资产；
      // 任何 IDB 失败都不会阻止项目被删除。
      const confirmDel = async () => {
        const pid = delTarget && delTarget.id;
        if (!pid) return;
        // 只刷"非待删项目"的待存文档：flushSave 推的是 S.activeId 的全量文档，
        // 若推的正是待删项目，会与 projectsDelete 竞速把项目原地复活（资产/设定集已清的残废形态）
        if (pid !== S.activeId) flushSave();
        update((s) => {
          s.projects = s.projects.filter((p) => p.id !== pid);
          try { localStorage.removeItem(LS_GRAPH + pid); } catch { /* 忽略 */ }
          try { localStorage.removeItem(LS_BIBLE + pid); } catch { /* 忽略 */ }
          if (s.activeId === pid) {
            if (s.projects.length === 0) {
              const p = { id: uid('p'), name: T('defaultProject'), createdAt: Date.now(), updatedAt: Date.now() };
              s.projects.push(p);
              s.activeId = p.id;
              s.graph = emptyGraph();
            } else {
              s.activeId = s.projects[0].id;
              const doc = loadGraphDoc(s.activeId) || emptyGraph();
              s.graph = { nodes: doc.nodes || {}, edges: doc.edges || [], view: doc.view || { x: 60, y: 40, scale: 1 } };
            }
            V.x = s.graph.view.x; V.y = s.graph.view.y; V.scale = s.graph.view.scale;
            applyViewToDomSoon();
            s.sel = new Set(); s.selEdge = null;
          }
          s.assetsTick++;
        });
        lsSet(LS_PROJECTS, S.projects);
        lsSet(LS_ACTIVE, S.activeId);
        try { hostRpc('projectsDelete', { id: pid }).catch(() => { /* 静默 */ }); } catch { /* 忽略 */ }
        try {
          const recs = await idbByProject(pid);
          for (const r of recs) {
            try {
              if (r.rel) { try { await hostRpc('assetDelete', { rel: r.rel }); } catch { /* 磁盘清理失败不阻塞 */ } }
              await idbDelete(r.id);
            } catch { /* 逐个容错 */ }
          }
        } catch { /* 资产清理失败不影响项目删除 */ }
        setDelTarget(null);
      };
      return [
        creating
          ? h('div', { key: 'new', className: 'dshic-row' },
              h('input', {
                className: 'dshic-input', autoFocus: true, value: name,
                placeholder: T('projectName'),
                onChange: (e) => setName(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') create();
                  if (e.key === 'Escape') setCreating(false);
                },
                onPointerDown: (e) => e.stopPropagation(),
              }),
              h('button', { type: 'button', className: 'dshic-mini', title: '✓', onClick: create }, '✓'),
              h('button', { type: 'button', className: 'dshic-mini is-ghost', title: T('cancel'), onClick: () => setCreating(false) }, '✕'),
            )
          : h('button', { key: 'newbtn', type: 'button', className: 'dshic-mini', style: { alignSelf: 'flex-start' }, onClick: () => { setCreating(true); setName(''); } }, Ic('plus', 11), T('newProject')),
        ...S.projects.map((p) => {
          const editing = editId === p.id;
          return h('div', {
            key: p.id,
            className: cls('dshic-proj', p.id === S.activeId && 'is-active'),
            onClick: () => { if (!editing) switchProject(p.id); },
            title: editing ? undefined : T('renameHint'),
          },
            Ic('folder', 13),
            editing
              ? h('input', {
                  className: 'dshic-input', autoFocus: true, value: editName,
                  onChange: (e) => setEditName(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditId(null);
                  },
                  onBlur: commitRename,
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: (e) => e.stopPropagation(),
                  style: { flex: 1, minWidth: 0 },
                })
              : h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { className: 'dshic-proj-name' }, p.name),
                  h('div', { className: 'dshic-proj-meta' }, T('projCreatedAt') + ' ' + fmtTime(p.createdAt))),
            editing
              ? h('button', {
                  type: 'button', className: 'dshic-iconbtn', title: '✓',
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: (e) => { e.stopPropagation(); commitRename(); },
                }, '✓')
              : h('button', {
                  type: 'button', className: 'dshic-iconbtn', title: T('rename'),
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: (e) => { e.stopPropagation(); setEditId(p.id); setEditName(p.name); },
                }, Ic('pencil', 11)),
            h('button', {
              type: 'button', className: 'dshic-iconbtn is-danger', title: T('doDelete'),
              onPointerDown: (e) => e.stopPropagation(),
              onClick: (e) => { e.stopPropagation(); openDel(p); },
            }, Ic('trash', 12)),
          );
        }),
        delTarget ? h(DeleteProjectModal, {
          key: 'delmodal', target: delTarget, name: delName, setName: setDelName, count: delCount,
          onCancel: () => setDelTarget(null), onConfirm: confirmDel,
        }) : null,
      ];
    }

    function DeleteProjectModal({ target, name, setName, count, onCancel, onConfirm }) {
      const matched = name.trim() === target.name && name.trim() !== '';
      useEffect(() => {
        const fn = (e) => { if (e.key === 'Escape') onCancel(); };
        window.addEventListener('keydown', fn);
        return () => window.removeEventListener('keydown', fn);
      }, [onCancel]);
      return h('div', { className: 'dshic-modal-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget) onCancel(); } },
        h('div', { className: 'dshic-modal' },
          h('div', { className: 'dshic-modal-title' }, T('delProjectTitle')),
          h('div', { className: 'dshic-modal-warn' },
            T('delProjectWarn').replace('{n}', String(count)),
            h('div', { className: 'dshic-modal-name', style: { marginTop: 4 } }, target.name)),
          h('div', { className: 'dshic-field' },
            h('span', { className: 'dshic-field-label' }, T('delProjectInput')),
            h('input', {
              className: 'dshic-input', autoFocus: true, value: name,
              placeholder: target.name,
              onChange: (e) => setName(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && matched) onConfirm(); },
              onPointerDown: (e) => e.stopPropagation(),
            })),
          h('div', { className: 'dshic-modal-actions' },
            h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', onClick: onCancel }, T('cancel')),
            h('button', {
              type: 'button', className: 'dshic-btn is-danger dshic-btn-outline', disabled: !matched,
              style: matched ? { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' } : null,
              onClick: () => { if (matched) onConfirm(); },
            }, T('doDelete'))),
        ));
    }

    function AssetsTab() {
      const [assets, setAssets] = useState([]);
      const [tick, setTick] = useState(0);
      const [filter, setFilter] = useState('all');
      const [scope, setScope] = useState(S.activeId || 'all'); // 打开资产面板默认定位到当前项目
      const prevActiveRef = useRef(S.activeId);
      useEffect(() => {
        // 当前项目变化时，资产筛选跟随（面板重开也会重置为当前项目）
        if (S.activeId && S.activeId !== prevActiveRef.current) { prevActiveRef.current = S.activeId; setScope(S.activeId); }
      }, [S.activeId]);
      const [search, setSearch] = useState('');
      const [craftFor, setCraftFor] = useState(null);
      const [delTarget, setDelTarget] = useState(null); // 待确认删除的资产（确认框见 DeleteAssetModal）
      const [assetName, setAssetName] = useState(''); // 删除确认框的输入内容
      const fileRef = useRef(null);
      useEffect(() => {
        probeCraft();
        let ok = true;
        (async () => {
          try {
            let list;
            if (scope === 'all') list = await idbAll();
            else list = (await idbAll()).filter((a) => a.projectId === scope || a.projectId === GENERAL_PID);
            if (ok) setAssets(list);
          } catch { if (ok) setAssets([]); }
        })();
        return () => { ok = false; };
      }, [S.activeId, tick, S.assetsTick, scope]);
      const projectName = (pid) => {
        if (pid === GENERAL_PID) return T('generalProject');
        const p = S.projects.find((x) => x.id === pid);
        return p ? p.name : '';
      };
      /** 资产改所属项目（通用/其它项目）：通用资产多项目共用。 */
      const moveAsset = async (a, targetPid) => {
        if (!targetPid || targetPid === (a.projectId || '')) return;
        const rec = await idbGet(a.id);
        if (!rec) return;
        rec.projectId = targetPid;
        await idbPut(rec);
        update((s) => { s.assetsTick++; });
        setTick((x) => x + 1);
        toast(T('moved'));
      };
      const addNodeFor = (a) => {
        if (a.kind === 'audio') return; // 音频资产在卡片内直接试听
        if (a.kind === 'text') {
          const c = worldCenter();
          const nd = addNodeAt('text', { x: c.x - 120, y: c.y - 60 });
          update((s) => { const n2 = s.graph.nodes[nd.id]; if (n2) n2.data.text = a.text || ''; });
          return;
        }
        const c = worldCenter();
        const type = a.kind === 'image' ? 'image-asset' : 'video-asset';
        const n = addNodeAt(type, { x: c.x + (Math.random() * 60 - 30), y: c.y + (Math.random() * 60 - 30) });
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.assetId = a.id; nd.data.status = 'done'; }
        });
      };
      const changeCategory = (a, category) => {
        a.category = category;
        idbPut(a).catch(() => {});
        update((s) => { s.assetsTick++; });
      };
      const onImport = async (e) => {
        const files = [...((e.target.files) || [])];
        e.target.value = '';
        let failed = 0;
        for (const f of files) {
          const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
          if (!kind) continue;
          try {
            await saveAssetRecord(S.activeId, kind, f, { name: f.name, source: 'upload', category: 'general' });
          } catch { failed++; } // 单个失败不影响其余文件
        }
        if (failed) toast(T('uploadFailed') + '（' + failed + '/' + files.length + '）');
        if (files.length) setTick((x) => x + 1);
      };
      const del = async (a) => {
        // 数据目录同步：删文件（逻辑路径由 Host 映射到项目名文件夹）+ 清 assets.json 索引
        const proj = S.projects.find((p) => p.id === (a.projectId || S.activeId));
        try {
          await hostRpc('assetDelete', { projectId: a.projectId || S.activeId, projectName: (proj && proj.name) || '', id: a.id, rel: a.rel || '' });
        } catch { /* 磁盘/索引清理失败不阻塞 */ }
        await idbDelete(a.id);
        update((s) => {
          for (const nd of Object.values(s.graph.nodes)) {
            if (nd.data && nd.data.assetId === a.id) { nd.data.assetId = null; nd.data.status = 'idle'; }
          }
          s.assetsTick++;
        });
        setTick((x) => x + 1);
      };
      // 资产重命名：写回 IndexedDB 记录并刷新名称缓存（@引用与连线名称都吃这份缓存）
      const rename = async (a, name) => {
        const rec = await idbGet(a.id);
        if (!rec) return;
        rec.name = name;
        await idbPut(rec);
        assetNameCache.set(a.id, name);
        update((s) => { s.assetsTick++; });
        setTick((x) => x + 1);
        toast(T('renamed'));
      };
      const q = search.trim().toLowerCase();
      const syncAll = async () => {
        const st = await craftStatusSafe();
        if (!st) return;
        const recs = assets.filter((a) => a.blob || a.rel);
        let okN = 0, failN = 0;
        for (const a of recs) {
          try { await syncAssetToDisk(a, { force: true }); okN++; } catch { failN++; }
        }
        toast(T('craftSyncDone').replace('{ok}', String(okN)).replace('{fail}', String(failN)));
      };
      const shown = assets.filter((a) => {
        if (scope !== 'all' && scope !== GENERAL_PID && a.projectId !== scope && a.projectId !== GENERAL_PID) return false;
        if (filter !== 'all' && (a.category || 'general') !== filter) return false;
        if (!q) return true;
        const hay = [
          a.name, a.prompt || '', a.text || '', catLabel(a.category || 'general'),
          projectName(a.projectId), a.kind === 'image' ? T('kindImage') : a.kind === 'video' ? T('kindVideo') : 'text',
        ].join(' ').toLowerCase();
        return hay.includes(q);
      });
      return [
        h('div', { key: 'chips', className: 'dshic-chips' },
          [{ id: 'all', label: T('catAll') }].concat(CATEGORIES.map((c) => ({ id: c, label: catLabel(c) }))).map((c) =>
            h('button', {
              key: c.id, type: 'button',
              className: cls('dshic-chip', filter === c.id && 'is-active'),
              onClick: () => setFilter(c.id),
            }, c.label)),
        ),
        h('input', {
          key: 'search', className: 'dshic-input', value: search,
          placeholder: T('searchLabel'),
          onChange: (e) => setSearch(e.target.value),
          onPointerDown: (e) => e.stopPropagation(),
        }),
        h(MiniSelect, {
          key: 'scope', value: scope, title: T('projectFilter'),
          options: [{ value: 'all', label: T('allProjects') }, { value: GENERAL_PID, label: T('generalProject') }]
            .concat(S.projects.map((p) => ({ value: p.id, label: p.name }))),
          onChange: (v) => setScope(v),
        }),
        h('button', { key: 'craftsync', type: 'button', className: 'dshic-mini', style: { alignSelf: 'flex-start' }, disabled: !craftOkCached(), title: craftOkCached() ? T('craftSyncAll') : T('craftUnreachable'), onClick: syncAll, onPointerDown: (e) => e.stopPropagation() }, Ic('upload', 11), T('craftSyncAll')),
        h('button', { key: 'imp', type: 'button', className: 'dshic-mini', style: { alignSelf: 'flex-start' }, onClick: () => { if (fileRef.current) fileRef.current.click(); } }, Ic('upload', 11), T('import')),
        h('input', { key: 'file', ref: fileRef, type: 'file', accept: 'image/*,video/*', multiple: true, style: { display: 'none' }, onChange: onImport }),
        shown.length === 0
          ? h('div', { key: 'empty', className: 'dshic-hint' }, T('emptyAssets'))
          : h('div', { key: 'grid', className: 'dshic-asset-grid' },
              shown.map((a) => h(AssetCard, {
                key: a.id, a, onAdd: addNodeFor, onDel: (x) => setDelTarget(x), onCat: changeCategory,
                onRename: rename, onMove: moveAsset,
                projectName: projectName(a.projectId),
              })),
            ),
        delTarget ? h(DeleteAssetModal, {
          key: 'delasset', target: delTarget, name: assetName, setName: setAssetName,
          onCancel: () => { setDelTarget(null); setAssetName(''); },
          onConfirm: async () => { const t = delTarget; setDelTarget(null); setAssetName(''); await del(t); },
        }) : null,
      ];
    }
    /** 删除资产确认框：与项目删除同一套交互 —— 名字可选中，手打确认，不做一键填入。 */
    function DeleteAssetModal({ target, name = '', setName = () => {}, onCancel = () => {}, onConfirm = () => {} }) {
      const matched = String(name || '').trim() === (target.name || '') && String(name || '').trim() !== '';
      useEffect(() => {
        const fn = (e) => { if (e.key === 'Escape') onCancel(); };
        window.addEventListener('keydown', fn);
        return () => window.removeEventListener('keydown', fn);
      }, [onCancel]);
      return h('div', { className: 'dshic-modal-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget) onCancel(); } },
        h('div', { className: 'dshic-modal' },
          h('div', { className: 'dshic-modal-title' }, T('delAssetTitle')),
          h('div', { className: 'dshic-modal-warn' },
            T('delAssetWarn'),
            h('div', { className: 'dshic-modal-name', style: { marginTop: 4 } }, target.name || '—')),
          h('div', { className: 'dshic-field' },
            h('span', { className: 'dshic-field-label' }, T('delAssetInput')),
            h('input', {
              className: 'dshic-input', autoFocus: true, value: name,
              placeholder: target.name,
              onChange: (e) => setName(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && matched) onConfirm(); },
              onPointerDown: (e) => e.stopPropagation(),
            })),
          h('div', { className: 'dshic-modal-actions' },
            h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', onClick: onCancel }, T('cancel')),
            h('button', {
              type: 'button', className: 'dshic-btn is-danger dshic-btn-outline', disabled: !matched,
              style: matched ? { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' } : null,
              onClick: () => { if (matched) onConfirm(); },
            }, T('doDelete'))),
        ));
    }

    function AssetCard({ a, onAdd, onDel, onCat, onRename, onMove, projectName }) {
      const url = useAssetUrl(a.kind === 'text' ? null : a.id);
      const [craftFor, setCraftFor] = useState(false);
      const [renaming, setRenaming] = useState(false);
      const [nameVal, setNameVal] = useState('');
      const startRename = (e) => { e.stopPropagation(); setNameVal(a.name || ''); setRenaming(true); };
      const commitRename = () => {
        const v = nameVal.trim();
        setRenaming(false);
        if (v && v !== (a.name || '')) onRename(a, v);
      };
      const nameInput = h('input', {
        className: 'dshic-input', autoFocus: true, value: nameVal,
        onChange: (e) => setNameVal(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); },
        onBlur: commitRename,
        onPointerDown: (e) => e.stopPropagation(),
        onClick: (e) => e.stopPropagation(),
      });
      const renameBtn = h('button', {
        type: 'button', className: 'dshic-iconbtn', title: T('renameAsset'),
        onPointerDown: (e) => e.stopPropagation(),
        onClick: startRename,
      }, Ic('pencil', 11));
      const downloadName = (a.name || 'asset') + (a.kind === 'image' ? '.png' : a.kind === 'video' ? '.webm' : a.kind === 'audio' ? '.mp3' : '.md');
      return h('div', { className: 'dshic-asset', onClick: a.kind === 'audio' ? undefined : () => onAdd(a), title: a.kind === 'text' ? T('textAssetHint') : a.kind === 'audio' ? '' : T('addAssetNode') },
        a.kind === 'text'
          ? h('div', { className: 'dshic-textcard is-title' },
              renaming ? nameInput : h('div', { className: 'dshic-textcard-title', title: a.name || '' }, a.name || T('scriptAssetPrefix')),
              h('div', { className: 'dshic-textcard-sub' },
                projectName
                  ? h('span', { className: 'dshic-projchip', title: projectName }, projectName)
                  : h('span', { className: 'dshic-projchip' }, catLabel(a.category || 'script')),
                h('span', { style: { flex: 1 } }),
                renameBtn),
            )
          : a.kind === 'image'
            ? h('img', { className: 'dshic-asset-thumb', src: url || '', draggable: false })
            : a.kind === 'video'
              ? h('video', { className: 'dshic-asset-thumb', src: url ? url + '#t=0.1' : '', muted: true, preload: 'metadata' })
              : h('div', { className: 'dshic-asset-thumb', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-brand-primary)' } },
                  Ic('audio', 26)),
        a.kind !== 'text'
          ? h('div', { className: 'dshic-asset-name' },
              renaming ? nameInput : h('span', { className: 'dshic-asset-name-text', title: a.name || '' }, a.name || '—'),
              renameBtn)
          : null,
        a.kind !== 'text'
          ? h('select', {
              className: 'dshic-asset-project', title: T('projectFilter'),
              value: a.projectId || GENERAL_PID,
              onClick: (e) => e.stopPropagation(),
              onPointerDown: (e) => e.stopPropagation(),
              onChange: (e) => { e.stopPropagation(); onMove(a, e.target.value); },
            },
              h('option', { value: GENERAL_PID }, T('generalProject')),
              S.projects.map((pp) => h('option', { key: pp.id, value: pp.id }, pp.name)),
            )
          : null,
        h('div', { className: 'dshic-asset-actions' },
          a.kind === 'image'
            ? h('button', {
                type: 'button', className: 'dshic-iconbtn', title: T('photoCraft'),
                onClick: (e) => { e.stopPropagation(); setCraftFor(true); },
                onPointerDown: (e) => e.stopPropagation(),
              }, Ic('spark', 11))
            : null,
          a.blob
            ? h('button', {
                type: 'button', className: 'dshic-iconbtn', title: T('craftSyncOne'),
                onClick: (e) => { e.stopPropagation(); syncAssetToDisk(a, { force: true }).then(() => toast(T('craftSyncOne') + ' ✓')).catch(() => { /* craftFetch 已提示 */ }); },
                onPointerDown: (e) => e.stopPropagation(),
              }, Ic('upload', 11))
            : null,
          h('button', {
            type: 'button', className: 'dshic-iconbtn', title: T('download'),
            onClick: (e) => {
              e.stopPropagation();
              if (a.kind === 'text') downloadBlob(new Blob([a.text || ''], { type: 'text/markdown' }), downloadName);
              else if (url) downloadBlobFromUrl(url, downloadName);
            },
          }, Ic('download', 11)),
          h('button', {
            type: 'button', className: 'dshic-iconbtn is-danger', title: T('delAsset'),
            onClick: (e) => { e.stopPropagation(); onDel(a); },
          }, Ic('trash', 11))),
        a.kind === 'audio' && url
          ? h('audio', { src: url, controls: true, style: { width: '100%', height: 30 }, onPointerDown: (e) => e.stopPropagation(), onClick: (e) => e.stopPropagation(), preload: 'metadata' })
          : null,
        h('div', { className: 'dshic-asset-meta' },
          h('select', {
            className: 'dshic-cat', title: T('catLabel'), value: a.category || 'general',
            onClick: (e) => e.stopPropagation(),
            onPointerDown: (e) => e.stopPropagation(),
            onChange: (e) => { e.stopPropagation(); onCat(a, e.target.value); },
          },
            CATEGORIES.map((c) => h('option', { key: c, value: c }, catLabel(c)))),
          h('div', { style: { flex: 1 } }),
          h('span', {}, fmtTime(a.createdAt))),
        craftFor ? h(PhotoCraftDialog, { key: 'pc', assetId: a.id, onClose: () => setCraftFor(false) }) : null,
      );
    }
    function downloadBlobFromUrl(url, name) {
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function useSkills() {
      const [data, setData] = useState(null);
      useEffect(() => {
        let ok = true;
        hostRpc('listSkills').then((r) => { if (ok) setData(r); }).catch(() => { if (ok) setData({ skills: [] }); });
        return () => { ok = false; };
      }, []);
      return data || { skills: [] };
    }
    function SkillSelect({ label, value, onChange }) {
      const data = useSkills();
      // 默认项 = 内置专家 persona + 内置创作方法论 canvas-craft（自动叠加）
      const options = [{ value: '', label: T('builtinExpert') }].concat((data.skills || []).map((x) => ({ value: x.name, label: x.name })));
      return h('div', { className: 'dshic-field' },
        h('span', { className: 'dshic-field-label' }, label, InfoTip(T('skillHint'))),
        h('select', {
          className: 'dshic-select', value: value || '',
          onChange: (e) => onChange(e.target.value),
          onPointerDown: (e) => e.stopPropagation(),
        }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label))));
    }

    function LlmModelSelect() {
      const [opts, setOpts] = useState(null);
      const [s, setS] = useState(loadSettings);
      useEffect(() => {
        let ok = true;
        hostRpc('llmOptions').then((r) => { if (ok) setOpts(r); }).catch((e) => { if (ok) setOpts({ providers: [], resolved: null, error: String((e && e.message) || e) }); });
        return () => { ok = false; };
      }, []);
      const current = s.textLlm.provider ? (s.textLlm.provider + '|' + s.textLlm.model) : '';
      const options = [];
      let firstError = (opts && opts.error) || '';
      for (const p of ((opts && opts.providers) || [])) {
        if (p.error && !(p.models || []).length) firstError = firstError || `${p.name}: ${p.error}`;
        for (const m of (p.models || [])) options.push({ value: p.id + '|' + m.id, label: `${p.name} · ${m.name}` });
      }
      const applyTextLlm = (provider, model) => {
        setS((prev) => {
          const next = JSON.parse(JSON.stringify(prev));
          next.textLlm = { provider: provider || '', model: model || '' };
          saveSettings(next);
          return next;
        });
      };
      return h('div', { className: 'dshic-field' },
        h('span', { className: 'dshic-field-label' }, T('llmLabel')),
        h('select', {
          className: 'dshic-select', value: current,
          disabled: !options.length,
          onChange: (e) => {
            const [provider, model] = e.target.value.split('|');
            applyTextLlm(provider, model);
          },
          onPointerDown: (e) => e.stopPropagation(),
        },
          options.length
            ? options.map((o) => h('option', { key: o.value, value: o.value }, o.label))
            : [h('option', { key: 'none', value: '' }, firstError || '…')],
        ),
        // 兜底：Provider 枚举不可用时允许手动填 provider|model
        h('input', {
          className: 'dshic-input', value: current,
          placeholder: 'provider|model（手动覆盖）',
          onChange: (e) => {
            const [provider, model] = e.target.value.split('|');
            applyTextLlm(provider, model);
          },
          onPointerDown: (e) => e.stopPropagation(),
        }),
      );
    }

    /** 图片/视频模型多配置列表：名称 / 地址 / Key / 模型（/模式），可增删、设默认。 */
    function Field({ label, value, onChange, placeholder, password }) {
      return h('div', { className: 'dshic-field' },
        h('span', { className: 'dshic-field-label' }, label),
        h('input', {
          className: 'dshic-input', type: password ? 'password' : 'text', value, placeholder: placeholder || '',
          onChange: (e) => onChange(e.target.value),
          onPointerDown: (e) => e.stopPropagation(),
        }));
    }
    /** ⓘ 悬停说明：界面简洁化——长解释一律收进悬停提示（原生 title），不再平铺文字。 */
    function InfoTip(text) {
      return h('span', {
        title: String(text || ''), 'aria-label': String(text || ''),
        style: { flex: 'none', width: 14, height: 14, lineHeight: '13px', textAlign: 'center', fontSize: 10, borderRadius: '50%', border: '1px solid var(--dsw-alias-border-secondary, #777)', color: 'var(--dsw-alias-label-secondary, #999)', cursor: 'help', userSelect: 'none', opacity: 0.85 },
      }, 'i');
    }
    /** 图片/视频模型配置（供应商 + 模型两级）：一个供应商配一次 URL/Key，下面挂多个模型；
     *  ★星标模型 = 节点未指定时的默认路由。 */
    function ModelProviderEditor({ kind }) {
      const [s, setS] = useState(loadSettings);
      const [openId, setOpenId] = useState(null);
      const listKey = kind === 'image' ? 'imageProviders' : 'videoProviders';
      const starKey = kind === 'image' ? 'imageStar' : 'videoStar';
      const icon = kind === 'image' ? 'image' : 'video';
      const labelKey = kind === 'image' ? 'imageApisLabel' : 'videoApisLabel';
      const nameKey = kind === 'image' ? 'defaultImageCfg' : 'defaultVideoCfg';
      const urlKey = kind === 'image' ? 'baseUrl' : 'url';
      const urlPh = kind === 'image'
        ? 'https://api.example.com/v1（或完整 /images/generations 端点）'
        : 'https://api.example.com/v1/video/generations（或裸域 / /v1）';
      const persist = (next) => { setS(next); saveSettings(next); };
      const mutate = (fn) => { const next = JSON.parse(JSON.stringify(s)); fn(next); persist(next); };
      const addProvider = () => {
        const id = uid('prov');
        mutate((d) => { d[listKey] = (d[listKey] || []).concat([{ id, name: T(nameKey) + ' ' + ((d[listKey] || []).length + 1), [urlKey]: '', apiKey: '', extra: '', models: [], ...(kind === 'image' ? { mode: 'generations' } : {}) }]); });
        setOpenId(id);
      };
      const removeProvider = (id) => {
        mutate((d) => { d[listKey] = (d[listKey] || []).filter((x) => x.id !== id); if (d[starKey] && d[starKey].startsWith(id + '|')) d[starKey] = ''; });
        if (openId === id) setOpenId(null);
      };
      const patchProvider = (id, k, v) => mutate((d) => { d[listKey] = (d[listKey] || []).map((x) => (x.id === id ? { ...x, [k]: v } : x)); });
      const addModel = (pid) => mutate((d) => { const p = (d[listKey] || []).find((x) => x.id === pid); if (p) p.models = (p.models || []).concat([{ id: uid('m'), model: '' }]); });
      const patchModel = (pid, mid, k, v) => mutate((d) => { const p = (d[listKey] || []).find((x) => x.id === pid); if (!p) return; p.models = (p.models || []).map((x) => (x.id === mid ? { ...x, [k]: v } : x)); });
      const removeModel = (pid, mid) => mutate((d) => {
        const p = (d[listKey] || []).find((x) => x.id === pid); if (!p) return;
        p.models = (p.models || []).filter((x) => x.id !== mid);
        if (d[starKey] === pid + '|' + mid) d[starKey] = '';
      });
      const toggleStar = (pid, mid) => { const ref = pid + '|' + mid; mutate((d) => { d[starKey] = d[starKey] === ref ? '' : ref; }); };
      const list = s[listKey] || [];
      const modelCount = (p) => (p.models || []).filter((m) => String(m.model || '').trim()).length;
      return h('div', { className: 'dshic-card' },
        h('div', { className: 'dshic-row' },
          Ic(icon, 12),
          h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, T(labelKey)),
          h('span', { className: 'dshic-tag st' }, String(list.length)),
          h('button', { type: 'button', className: 'dshic-mini', onClick: addProvider, onPointerDown: (e) => e.stopPropagation() }, Ic('plus', 11), T('addProvider')),
        ),
        list.length === 0 ? h('div', { className: 'dshic-hint' }, T('noCfgHint')) : null,
        list.map((p) => {
          const open = openId === p.id;
          return h('div', { key: p.id, className: 'dshic-card', style: { padding: open ? 8 : 5, gap: 6, background: 'var(--dsw-alias-bg-layer-1)' } },
            h('div', { className: 'dshic-row' },
              h('button', { type: 'button', className: 'dshic-iconbtn', title: open ? T('collapse') : T('unfold'), onPointerDown: (e) => e.stopPropagation(), onClick: () => setOpenId(open ? null : p.id) }, open ? '▾' : '▸'),
              open
                ? h('input', { className: 'dshic-input', style: { flex: 1, minWidth: 0, fontWeight: 600 }, value: p.name || '', placeholder: T('cfgName'), autoFocus: true, onChange: (e) => patchProvider(p.id, 'name', e.target.value), onPointerDown: (e) => e.stopPropagation() })
                : h('span', { style: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' }, onClick: () => setOpenId(p.id), onPointerDown: (e) => e.stopPropagation(), title: (p[urlKey] || '—') }, p.name || T('cfgName')),
              h('span', { className: 'dshic-tag st' }, T('modelsLabel') + ' ' + modelCount(p)),
              h('button', { type: 'button', className: 'dshic-iconbtn', title: T('doDelete'), onPointerDown: (e) => e.stopPropagation(), onClick: () => removeProvider(p.id) }, '×'),
            ),
            open ? [
              h(Field, { key: 'u', label: T('baseUrl'), value: p[urlKey] || '', onChange: (v) => patchProvider(p.id, urlKey, v), placeholder: urlPh }),
              h(Field, { key: 'k', label: T('apiKey'), value: p.apiKey || '', onChange: (v) => patchProvider(p.id, 'apiKey', v), placeholder: 'sk-…', password: true }),
              kind === 'image' ? [
                h(Field, { key: 'size', label: T('imgSizeOverride'), value: p.size || '', onChange: (v) => patchProvider(p.id, 'size', v), placeholder: T('imgSizePlaceholder') }),
                h(Field, { key: 'rf', label: T('imgResponseFormat'), value: p.responseFormat || '', onChange: (v) => patchProvider(p.id, 'responseFormat', v), placeholder: 'b64_json / url（留空=API 默认）' }),
                h('div', { key: 'mode', className: 'dshic-field' },
                  h('span', { className: 'dshic-field-label' }, T('imgMode')),
                  h('select', { className: 'dshic-select', value: p.mode || 'generations', onChange: (e) => patchProvider(p.id, 'mode', e.target.value), onPointerDown: (e) => e.stopPropagation() },
                    h('option', { value: 'generations' }, T('modeGenerations')),
                    h('option', { value: 'edits' }, T('modeEdits')))),
              ] : [
                h(Field, { key: 'of', label: T('vidOutFormat'), value: p.outputFormat || '', onChange: (v) => patchProvider(p.id, 'outputFormat', v), placeholder: 'mp4（留空不发送）' }),
                h('label', { key: 'ga', className: 'dshic-row', style: { gap: 6, fontSize: 11 } },
                  h('input', { type: 'checkbox', checked: p.generateAudio === true, onChange: (e) => patchProvider(p.id, 'generateAudio', e.target.checked), onPointerDown: (e) => e.stopPropagation() }),
                  h('span', {}, T('vidAudioOpt'))),
              ],
              h(Field, { key: 'extra', label: T('cfgExtra'), value: p.extra || '', onChange: (v) => patchProvider(p.id, 'extra', v), placeholder: '{"watermark":false,"prompt_extend":false}' }),
              h('div', { className: 'dshic-hint' }, T('cfgExtraHint')),
              h('div', { className: 'dshic-row', style: { marginTop: 4 } },
                h('span', { className: 'dshic-field-label', style: { flex: 1, minWidth: 0 } }, T('modelsLabel')),
                h('button', { type: 'button', className: 'dshic-mini', onPointerDown: (e) => e.stopPropagation(), onClick: () => addModel(p.id) }, Ic('plus', 11), T('addModel')),
              ),
              (p.models || []).map((m) => h('div', { key: m.id, className: 'dshic-row' },
                h('button', {
                  type: 'button', className: 'dshic-mini is-ghost', title: T('starDefault'),
                  style: { color: s[starKey] === p.id + '|' + m.id ? 'var(--dsw-alias-state-warn-primary)' : 'inherit' },
                  onPointerDown: (e) => e.stopPropagation(), onClick: () => toggleStar(p.id, m.id),
                }, s[starKey] === p.id + '|' + m.id ? '★' : '☆'),
                h('input', { className: 'dshic-input', style: { flex: 1, minWidth: 0 }, value: m.model || '', placeholder: T('modelNamePh'), onChange: (e) => patchModel(p.id, m.id, 'model', e.target.value), onPointerDown: (e) => e.stopPropagation() }),
                h('button', { type: 'button', className: 'dshic-iconbtn', title: T('doDelete'), onPointerDown: (e) => e.stopPropagation(), onClick: () => removeModel(p.id, m.id) }, '×'),
              )),
              !(p.models || []).length ? h('div', { className: 'dshic-hint' }, T('noModelsCfg')) : null,
            ] : null,
          );
        }),
      );
    }
    function ApiListEditor({ kind }) {
      const [s, setS] = useState(loadSettings);
      const [openId, setOpenId] = useState(null);
      const listKey = kind === 'image' ? 'imageApis' : kind === 'video' ? 'videoApis' : 'ttsApis';
      const defKey = kind === 'image' ? 'imageApiId' : kind === 'video' ? 'videoApiId' : 'ttsApiId';
      const labelKey = kind === 'image' ? 'imageApisLabel' : kind === 'video' ? 'videoApisLabel' : 'ttsApisLabel';
      const icon = kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'audio';
      const nameKey = kind === 'image' ? 'defaultImageCfg' : kind === 'video' ? 'defaultVideoCfg' : 'defaultTtsCfg';
      const persist = (next) => { setS(next); saveSettings(next); };
      const mutate = (fn) => {
        const next = JSON.parse(JSON.stringify(s));
        next[listKey] = fn(next[listKey] || []);
        persist(next);
      };
      const add = () => {
        const id = uid('cfg');
        mutate((list) => list.concat([{
          id,
          name: T(nameKey) + ' ' + ((s[listKey] || []).length + 1),
          [kcUrlKey(kind)]: '',
          apiKey: '',
          model: '',
          ...(kind === 'image' ? { mode: 'generations' } : {}),
          ...(kind === 'tts' ? { voice: 'alloy' } : {}),
        }]));
        setOpenId(id);
      };
      const patch = (id, k, v) => mutate((list) => list.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
      const remove = (id) => {
        mutate((list) => list.filter((x) => x.id !== id));
        if (openId === id) setOpenId(null);
      };
      const list = s[listKey] || [];
      const urlPh = kind === 'image' ? 'https://api.example.com/v1' : kind === 'video' ? 'https://api.example.com/v1/video/generations' : 'https://api.example.com/v1';
      const urlKey = kind === 'image' ? 'baseUrl' : 'url';
      return h('div', { className: 'dshic-card' },
        h('div', { className: 'dshic-row' },
          Ic(icon, 12),
          h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, T(labelKey)),
          h('span', { className: 'dshic-tag st' }, String(list.length)),
          h('button', { type: 'button', className: 'dshic-mini', onClick: add, onPointerDown: (e) => e.stopPropagation() }, Ic('plus', 11), T('addConfig')),
        ),
        list.length === 0 ? h('div', { className: 'dshic-hint' }, T('noCfgHint')) : null,
        list.map((cfg) => {
          const open = openId === cfg.id;
          const isDef = s[defKey] === cfg.id;
          return h('div', { key: cfg.id, className: 'dshic-card', style: { padding: open ? 8 : 5, gap: 6, background: 'var(--dsw-alias-bg-layer-1)' } },
            // 折叠头：箭头 + 名称 + 默认标记 + 删除
            h('div', { className: 'dshic-row' },
              h('button', {
                type: 'button', className: 'dshic-iconbtn', title: open ? T('collapse') : T('unfold'),
                onPointerDown: (e) => e.stopPropagation(),
                onClick: () => setOpenId(open ? null : cfg.id),
              }, open ? '▾' : '▸'),
              open
                ? h('input', {
                    className: 'dshic-input', style: { flex: 1, minWidth: 0, fontWeight: 600 }, value: cfg.name || '',
                    placeholder: T('cfgName'), autoFocus: true,
                    onChange: (e) => patch(cfg.id, 'name', e.target.value),
                    onPointerDown: (e) => e.stopPropagation(),
                  })
                : h('span', {
                    style: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' },
                    onClick: () => setOpenId(cfg.id),
                    onPointerDown: (e) => e.stopPropagation(),
                    title: T('baseUrl') + ': ' + (cfg[kcUrlKey(kind)] || '—'),
                  }, cfg.name || T('cfgName')),
              isDef
                ? h('span', { className: 'dshic-tag api' }, T('isDefault'))
                : h('button', {
                    type: 'button', className: 'dshic-mini is-ghost', title: T('setDefault'),
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => { const next = { ...s, [defKey]: cfg.id }; persist(next); },
                  }, '★'),
              cfg.model ? h('span', { className: 'dshic-tag st' }, String(cfg.model).slice(0, 18)) : null,
              h('button', {
                type: 'button', className: 'dshic-iconbtn is-danger', title: T('delConfig'),
                onPointerDown: (e) => e.stopPropagation(),
                onClick: () => remove(cfg.id),
              }, Ic('trash', 11)),
            ),
            open ? [
              h(Field, { key: 'u', label: T('baseUrl'), value: cfg[kcUrlKey(kind)] || '', onChange: (v) => patch(cfg.id, urlKey, v), placeholder: urlPh }),
              h(Field, { key: 'k', label: T('apiKey'), value: cfg.apiKey || '', onChange: (v) => patch(cfg.id, 'apiKey', v), placeholder: 'sk-…', password: true }),
              h(Field, { key: 'm', label: T('model'), value: cfg.model || '', onChange: (v) => patch(cfg.id, 'model', v) }),
              h(Field, {
                key: 'to', label: T('apiTimeout'), value: cfg.timeoutMs || '',
                placeholder: T('llmParamAuto'),
                onChange: (v) => patch(cfg.id, 'timeoutMs', v),
              }),
              kind === 'image'
                ? h(Field, { key: 'size', label: T('imgSizeOverride'), value: cfg.size || '', onChange: (v) => patch(cfg.id, 'size', v), placeholder: T('imgSizePlaceholder') })
                : null,
              kind === 'image'
                ? h(Field, { key: 'rf', label: T('imgResponseFormat'), value: cfg.responseFormat || '', onChange: (v) => patch(cfg.id, 'responseFormat', v), placeholder: 'b64_json / url（留空=API 默认）' })
                : null,
              kind === 'image'
                ? h('div', { key: 'mode', className: 'dshic-field' },
                    h('span', { className: 'dshic-field-label' }, T('imgMode')),
                    h('select', {
                      className: 'dshic-select', value: cfg.mode || 'generations',
                      onChange: (e) => patch(cfg.id, 'mode', e.target.value),
                      onPointerDown: (e) => e.stopPropagation(),
                    },
                      h('option', { value: 'generations' }, T('modeGenerations')),
                      h('option', { value: 'edits' }, T('modeEdits'))))
                : null,
              kind === 'video'
                ? h('div', { key: 'proto', className: 'dshic-field' },
                    h('span', { className: 'dshic-field-label' }, T('vidProtocol'), InfoTip(T('vidProtocolHint'))),
                    h('select', {
                      className: 'dshic-select', value: cfg.protocol || 'generic',
                      onChange: (e) => patch(cfg.id, 'protocol', e.target.value),
                      onPointerDown: (e) => e.stopPropagation(),
                    },
                      h('option', { value: 'generic' }, T('protoGeneric')),
                      h('option', { value: 'seedance' }, T('protoSeedance'))))
                : null,
              kind === 'video'
                ? h('label', { key: 'ga', className: 'dshic-row', style: { gap: 6, fontSize: 11 } },
                    h('input', {
                      type: 'checkbox', checked: cfg.generateAudio === true,
                      onChange: (e) => patch(cfg.id, 'generateAudio', e.target.checked),
                      onPointerDown: (e) => e.stopPropagation(),
                    }),
                    h('span', {}, T('vidAudioOpt')))
                : null,
              kind === 'video'
                ? h(Field, { key: 'of', label: T('vidOutFormat'), value: cfg.outputFormat || '', onChange: (v) => patch(cfg.id, 'outputFormat', v), placeholder: 'mp4（留空不发送）' })
                : null,
              kind === 'video' && cfg.protocol === 'seedance'
                ? h('label', { key: 'wm', className: 'dshic-row', style: { gap: 6, fontSize: 11 } },
                    h('input', {
                      type: 'checkbox', checked: cfg.watermark === true,
                      onChange: (e) => patch(cfg.id, 'watermark', e.target.checked),
                      onPointerDown: (e) => e.stopPropagation(),
                    }),
                    h('span', {}, T('seedanceWatermark')))
                : null,
              (kind === 'image' || kind === 'video')
                ? h(Field, { key: 'extra', label: T('cfgExtra'), value: cfg.extra || '', onChange: (v) => patch(cfg.id, 'extra', v), placeholder: '{"watermark":false,"prompt_extend":false}' })
                : null,
              (kind === 'image' || kind === 'video')
                ? h('div', { className: 'dshic-hint' }, T('cfgExtraHint'))
                : null,
              kind === 'tts'
                ? h(Field, { key: 'voice', label: T('voice'), value: cfg.voice || '', onChange: (v) => patch(cfg.id, 'voice', v), placeholder: 'alloy' })
                : null,
            ] : null,
          );
        }),
      );
    }
    function kcUrlKey(kind) { return kind === 'image' ? 'baseUrl' : 'url'; }

    /** T2：设置面板 Craft 后期卡片（连接状态 / 工具灯 / 数据目录）。 */
    function CraftCard() {
      const [, force] = useState(0);
      const [open, setOpen] = useState(false); // 默认折叠：界面简洁，摘要常显
      useEffect(() => { probeCraft().then(() => force((x) => x + 1)); }, []);
      const cs = S.craftStatus;
      const data = cs && cs.data;
      const slug = craftProjectSlug();
      // Craft 后期目录 = **画布数据根目录** + 项目目录 + \craft（不再有 ArtCraft 独立数据目录的 second 口径）
      const craftDir = S.dataRoot ? (S.dataRoot.replace(/[\\/]+$/, '') + '\\projects\\' + slug + '\\craft') : '';
      // ArtCraft 自身的数据目录若与画布数据根目录不一致 → 后期文件会落到两处，必须提醒
      const artRoot = data && data.dataRoot ? data.dataRoot.path : '';
      const rootMismatch = !!(S.dataRoot && artRoot && artRoot.replace(/[\\/]+$/, '') !== S.dataRoot.replace(/[\\/]+$/, ''));
      // Craft 家族全量动态渲染：ArtCraft /status 返回几款 bins 就渲染几款（当前 12 款），不再写死
      const binKeys = (data && data.bins ? Object.keys(data.bins) : []).sort();
      const readyCount = binKeys.filter((k) => data.bins[k] && data.bins[k].found).length;
      const binRow = (key) => {
        const info = data && data.bins ? data.bins[key] : null;
        const ok = !!(info && info.found);
        return h('div', { className: 'dshic-row' },
          h('span', { style: { color: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', width: 12, flex: 'none' } }, ok ? '●' : '○'),
          h('span', { style: { fontSize: 12, flex: 'none' } }, key),
          h('span', { className: 'dshic-hint', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            ok ? T('craftReady') : (info && info.note ? info.note : T('craftMissing'))),
        );
      };
      return h('div', { className: 'dshic-card' },
        h('div', {
          className: 'dshic-row', style: { cursor: 'pointer' },
          onPointerDown: (e) => e.stopPropagation(), onClick: () => setOpen((x) => !x),
          title: open ? T('collapse') : T('foldOpen'),
        },
          Ic('film', 12),
          h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0 } }, T('craftCard')),
          data ? h('span', { className: 'dshic-hint', style: { flex: 'none' } }, T('craftReadyCount').replace('{r}', String(readyCount)).replace('{n}', String(binKeys.length))) : null,
          h('button', { type: 'button', className: 'dshic-mini is-ghost', onPointerDown: (e) => e.stopPropagation(), onClick: (e) => { e.stopPropagation(); probeCraft().then(() => force((x) => x + 1)); } }, '↻'),
          h('span', { style: { flex: 'none', fontSize: 10, transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' } }, '▶'),
        ),
        open ? [
          craftDir ? h('div', { className: 'dshic-hint' }, T('craftDirLabel') + '：' + craftDir) : h('div', { className: 'dshic-err' }, T('craftDataRootNeed')),
          rootMismatch ? h('div', { className: 'dshic-err' }, T('craftRootMismatch')) : null,
          ...(data ? binKeys.map((k) => binRow(k)) : []),
        ] : null,
      );
    }

    /** T4：PhotoCraft 处理对话框（单资产：run --cmd --params --out；进度/stderr/取消）。 */
    function PhotoCraftDialog({ assetId, onClose }) {
      const [rec, setRec] = useState(null);
      const [presetIdx, setPresetIdx] = useState('0');
      const [cmd, setCmd] = useState(CRAFT_PRESETS[0].cmd);
      const [paramsText, setParamsText] = useState(JSON.stringify(CRAFT_PRESETS[0].params));
      const [running, setRunning] = useState(false);
      const [progress, setProgress] = useState('');
      const [err, setErr] = useState(null);
      const [jobId, setJobId] = useState(null);
      useEffect(() => {
        let ok = true;
        idbGet(assetId).then((r) => { if (ok) setRec(r); });
        return () => { ok = false; };
      }, [assetId]);
      const run = async () => {
        const st = await craftStatusSafe();
        if (!st) return;
        if (!(st.bins && st.bins.photocraft && st.bins.photocraft.found)) { toast(T('craftCliMissing').replace('{name}', 'photocraft')); return; }
        let paramsObj;
        try { paramsObj = JSON.parse(paramsText || '{}'); } catch { toast(T('craftInvalidJson')); return; }
        if (!rec || (!rec.blob && !rec.rel)) { toast(T('noResult')); return; }
        setRunning(true); setErr(null); setProgress('…');
        try {
          const mediaRel = await ensureAssetOnDisk(rec);
          const outRel = 'projects/' + craftProjectSlug() + '/craft/out/graded/' + rec.id + '-graded' + extForMime(rec.mime, rec.name);
          const job = await craft.jobStart({
            bin: 'photocraft',
            args: ['run', mediaRel, '--cmd', cmd, '--params', JSON.stringify(paramsObj), '--out', outRel],
            outputs: [outRel], timeoutMs: 600000,
          });
          setJobId(job.id);
          let status = 'running';
          while (status === 'running') {
            await sleep(1500);
            const snap = await craft.jobGet(job.id, 12);
            status = snap.status;
            const tail = (snap.stdout || '').split('\n').filter(Boolean).slice(-1)[0] || status;
            setProgress(tail.slice(0, 120));
            if (status === 'done' || status === 'failed' || status === 'timeout') {
              if (status !== 'done') {
                throw new Error('PhotoCraft ' + status + '：' + ((snap.stderr || '').split('\n').filter(Boolean).slice(-3).join('\n') || ''));
              }
              if (!(snap.outputs && snap.outputs[0] && snap.outputs[0].exists)) throw new Error('任务完成但未找到输出文件');
              const blob = await craft.file(outRel);
              const rec2 = await saveAssetRecord(S.activeId, 'image', blob, {
                name: (rec.name || 'image') + '-graded',
                prompt: 'photocraft ' + cmd, source: 'craft', category: rec.category || 'general',
              });
              update((s) => { s.assetsTick++; });
              toast(T('craftJobDone'));
              onClose();
              return;
            }
          }
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setRunning(false); setProgress(''); setJobId(null);
        }
      };
      return h('div', { className: 'dshic-mask-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget && !running) onClose(); } },
        h('div', { className: 'dshic-mask-card' },
          h('div', { className: 'dshic-modal-title' }, T('photoCraft') + ' — ' + (rec ? (rec.name || rec.id) : '…')),
          h('div', { className: 'dshic-field' },
            h('span', { className: 'dshic-field-label' }, T('photoCmd')),
            h('select', {
              className: 'dshic-select', value: presetIdx,
              onChange: (e) => {
                setPresetIdx(e.target.value);
                if (e.target.value !== 'custom') {
                  const p = CRAFT_PRESETS[Number(e.target.value)];
                  setCmd(p.cmd); setParamsText(JSON.stringify(p.params));
                } else setCmd('');
              },
              onPointerDown: (e) => e.stopPropagation(),
            },
              CRAFT_PRESETS.map((p, i) => h('option', { key: i, value: String(i) }, p.cmd)),
              h('option', { value: 'custom' }, T('photoCustom')))),
          presetIdx === 'custom'
            ? h('div', { className: 'dshic-field' },
                h('span', { className: 'dshic-field-label' }, T('photoCmd')),
                h('input', { className: 'dshic-input', value: cmd, placeholder: 'filter.sharpen.smartSharpen', onChange: (e) => setCmd(e.target.value), onPointerDown: (e) => e.stopPropagation() }))
            : null,
          h('div', { className: 'dshic-field' },
            h('span', { className: 'dshic-field-label' }, T('photoParams')),
            h('textarea', {
              className: 'dshic-textarea', style: { minHeight: 64, fontFamily: 'var(--ds-font-family-code, monospace)' },
              value: paramsText, onChange: (e) => setParamsText(e.target.value), onPointerDown: (e) => e.stopPropagation(),
            })),
          running || progress ? h('div', { className: 'dshic-hint' }, T('composing') + ' ' + progress) : null,
          err ? h('div', { className: 'dshic-err' }, err) : null,
          h('div', { className: 'dshic-modal-actions' },
            jobId ? h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', onPointerDown: (e) => e.stopPropagation(), onClick: () => { craft.jobCancel(jobId).catch(() => {}); } }, T('craftCancel')) : null,
            h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', disabled: running, onClick: onClose, onPointerDown: (e) => e.stopPropagation() }, T('cancel')),
            h('button', { type: 'button', className: 'dshic-gen', style: { width: 'auto', padding: '0 14px' }, disabled: running, onClick: run, onPointerDown: (e) => e.stopPropagation() },
              running ? h('span', { className: 'dshic-spin' }) : Ic('spark', 12), running ? T('ttsRunning') : T('photoRun'))),
        ));
    }

    /** T5：FilmCraft 导出参数确认框（args JSON 可编辑，默认取自 README 配方）。 */
    function FilmcraftArgsDialog({ info, onSubmit, onClose }) {
      const [argsText, setArgsText] = useState(info.args);
      const [outRel, setOutRel] = useState(info.outRel);
      const [err, setErr] = useState(null);
      const submit = () => {
        let args;
        try { args = JSON.parse(argsText); } catch { setErr(T('craftInvalidJson')); return; }
        if (!Array.isArray(args)) { setErr(T('craftInvalidJson')); return; }
        onSubmit(args, String(outRel || '').trim());
      };
      return h('div', { className: 'dshic-mask-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'dshic-mask-card' },
          h('div', { className: 'dshic-modal-title' }, T('filmcraftParams')),
          h('div', { className: 'dshic-hint' }, T('filmcraftOut') + '：' + info.outRel),
          h('div', { className: 'dshic-field' },
            h('span', { className: 'dshic-field-label' }, T('filmcraftArgs')),
            h('textarea', {
              className: 'dshic-textarea', style: { minHeight: 96, fontFamily: 'var(--ds-font-family-code, monospace)' },
              value: argsText, onChange: (e) => setArgsText(e.target.value), onPointerDown: (e) => e.stopPropagation(),
            })),
          err ? h('div', { className: 'dshic-err' }, err) : null,
          h('div', { className: 'dshic-modal-actions' },
            h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', onClick: onClose, onPointerDown: (e) => e.stopPropagation() }, T('cancel')),
            h('button', { type: 'button', className: 'dshic-gen', style: { width: 'auto', padding: '0 14px' }, onClick: submit, onPointerDown: (e) => e.stopPropagation() }, Ic('film', 12), T('filmcraftSubmit'))),
        ));
    }

    /** 数据根目录卡片：设置/打开/迁移历史资产。 */
    function DataRootCard() {
      const [val, setVal] = useState('');
      const [busy, setBusy] = useState(false);
      const [picking, setPicking] = useState(false);
      useEffect(() => { if (S.dataRoot) setVal(S.dataRoot); }, [S.dataRoot]);
      const save = async () => {
        if (busy) return;
        setBusy(true);
        try {
          await hostRpc('dataRootSet', { root: val.trim() });
          await refreshDataRoot();
          toast(T('dataRootSaved') + (S.dataRoot ? '：' + S.dataRoot : ''));
          assetIndexSynced = false; // 换了目录：索引要往新目录重建
          autoMigrateAssetsToRoot().then(() => syncAssetIndexToHost()); // 先搬存量资产，再对齐索引
        } catch (e) { toast('设置失败：' + ((e && e.message) || e)); }
        setBusy(false);
      };
      const applyRoot = async (root) => {
        await hostRpc('dataRootSet', { root });
        await refreshDataRoot();
        setVal(S.dataRoot || root);
        toast(T('dataRootSaved') + '：' + S.dataRoot);
        assetIndexSynced = false; // 换了目录：索引要往新目录重建
        autoMigrateAssetsToRoot().then(() => syncAssetIndexToHost());
      };
      const browse = async () => {
        if (busy || picking) return;
        setBusy(true); setPicking(true);
        try {
          const r = await hostRpc('pickFolder');
          if (r && r.ok && r.path) await applyRoot(r.path);
          else if (r && r.unsupported) toast(T('dataRootPickUnsupported'));
          // cancelled → 静默
        } catch (e) {
          const msg = String((e && e.message) || e);
          toast(/未知操作/.test(msg) ? T('dataRootUnsupported') : '目录选择失败：' + msg);
        }
        setPicking(false); setBusy(false);
      };
      const openDir = async () => { try { await hostRpc('dataRootReveal'); } catch (e) { toast((e && e.message) || e); } };
      const importFromRoot = async () => {
        if (busy || picking) return;
        setBusy(true);
        try {
          const r = await hostRpc('dataRootImport');
          // 资产元数据 → IndexedDB（本机已存在的同 id 资产跳过，绝不覆盖）
          let assets = 0;
          const byProject = r.assets || {};
          for (const pid of Object.keys(byProject)) {
            for (const rec of byProject[pid] || []) {
              if (!rec || !rec.id) continue;
              const cur = await idbGet(rec.id).catch(() => null);
              if (cur && (cur.rel || cur.blob)) continue;
              await idbPut({ ...rec, projectId: pid, stored: rec.rel ? 'disk' : 'idb' });
              assets++;
            }
          }
          if (assets) update((s) => { s.assetsTick++; });
          toast(T('dataRootImported').replace('{n}', String((r.imported || []).length)).replace('{a}', String(assets)));
          // 项目文档 Host 侧已合并：立即拉一轮同步，把新项目带进画布
          try { await hostSyncTick(); } catch { /* 下一轮 3s 轮询会带 */ }
          await refreshDataRoot();
        } catch (e) { toast('导入失败：' + ((e && e.message) || e)); }
        setBusy(false);
      };
      return h('div', { key: 'dataroot', className: 'dshic-card' },
        h('div', { className: 'dshic-row' },
          Ic('image', 12),
          h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0 } }, T('dataRootLabel')),
          InfoTip(T('dataRootHint')),
        ),
        S.dataRootSupported === false
          ? h('div', { className: 'dshic-hint' }, T('dataRootUnsupported'))
          : [
              h('div', { className: 'dshic-row', key: 'row1' },
                h('input', {
                  className: 'dshic-input', value: val, placeholder: T('dataRootPlaceholder'),
                  onChange: (e) => setVal(e.target.value), onPointerDown: (e) => e.stopPropagation(),
                }),
                h('button', { type: 'button', className: 'dshic-mini', title: T('dataRootBrowse'), disabled: busy || picking, onPointerDown: (e) => e.stopPropagation(), onClick: browse }, Ic('folder', 12)),
                h('button', { type: 'button', className: 'dshic-mini', disabled: busy || picking, onPointerDown: (e) => e.stopPropagation(), onClick: save }, T('dataRootSave')),
              ),
              picking ? h('div', { className: 'dshic-hint', key: 'picking' }, T('dataRootPicking')) : null,
              h('div', { className: 'dshic-row', key: 'row2' },
                S.dataRoot ? h('button', { type: 'button', className: 'dshic-mini', onPointerDown: (e) => e.stopPropagation(), onClick: openDir }, T('dataRootOpen')) : null,
                S.dataRoot ? h('button', { type: 'button', className: 'dshic-mini is-ghost', disabled: busy || picking, onPointerDown: (e) => e.stopPropagation(), onClick: importFromRoot }, Ic('folder', 11), T('dataRootImportBtn')) : null,
                S.dataRoot ? InfoTip(T('dataRootImportHint')) : null,
                h('div', { className: 'dshic-flex' }),
              ),
            ],
      );
    }
    function SettingsTab() {
      const [s, setS] = useState(loadSettings);
      const apply = (fn) => {
        setS((prev) => {
          const next = JSON.parse(JSON.stringify(prev));
          fn(next);
          saveSettings(next);
          return next;
        });
      };
      const field = (label, value, onChange, placeholder, password) => h(Field, { label, value, onChange, placeholder, password });
      return [
        h('div', { key: 'lang', className: 'dshic-card' },
          h('div', { className: 'dshic-row' }, Ic('text', 12), h('strong', { style: { fontSize: 12 } }, T('langLabel'))),
          h('select', {
            className: 'dshic-select', value: s.lang || '',
            onChange: (e) => {
              apply((d) => { d.lang = e.target.value; });
              LANG_OVERRIDE = e.target.value;
              notify();
            },
            onPointerDown: (e) => e.stopPropagation(),
          },
            h('option', { value: '' }, T('langFollow')),
            h('option', { value: 'zh' }, T('langZh')),
            h('option', { value: 'en' }, T('langEn'))),
        ),
        h(DataRootCard, { key: 'dataroot' }),
        h(CraftCard, { key: 'craft' }),
        // 专家与技能卡：独立于模型选择
        h('div', { key: 'skills', className: 'dshic-card' },
          h('div', { className: 'dshic-row' },
            Ic('spark', 12),
            h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0 } }, T('skillEnhance')),
            InfoTip(T('skillHint')),
          ),
          h(SkillSelect, { label: T('skillScript'), value: s.skillScript, onChange: (v) => apply((d) => { d.skillScript = v; }) }),
          h(SkillSelect, { label: T('skillStoryboard'), value: s.skillStoryboard, onChange: (v) => apply((d) => { d.skillStoryboard = v; }) }),
        ),
        // 文本模型卡：只选模型，参数全用 Harness 默认；紧挨图片/视频/TTS 模型卡片
        h('div', { key: 'llm', className: 'dshic-card' },
          h('div', { className: 'dshic-row' },
            Ic('spark', 12),
            h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0 } }, T('llmLabel')),
            InfoTip(T('llmHint')),
          ),
          h(LlmModelSelect),
        ),
        h(ModelProviderEditor, { key: 'imglist', kind: 'image' }),
        h(ModelProviderEditor, { key: 'vidlist', kind: 'video' }),
        h(ApiListEditor, { key: 'ttslist', kind: 'tts' }),
        h('div', { key: 'note', className: 'dshic-hint' }, 'DeepSeek Harness · dsh-infinite-canvas' + ((S.updateInfo && S.updateInfo.runningVersion) ? ' v' + S.updateInfo.runningVersion : '')),
      ];
    }

    /** 从项目现有创作意图/剧本一键起草设定集（世界观/风格/角色/场景/道具）。 */
    async function aiDraftBible(cur) {
      const settings = loadSettings();
      const zh = effLang() !== 'en';
      const ideas = Object.values(S.graph.nodes || {})
        .filter((n) => n && (n.type === 'script' || n.type === 'text'))
        .map((n) => String((n.type === 'script' ? n.data.idea : n.data.text) || '').trim())
        .filter(Boolean)
        .join('\n---\n')
        .slice(0, 6000);
      const existing = bibleBlock(cur);
      const system = [
        await loadSkillRules(settings.skillScript, zh) || await loadSkillRules(CRAFT_SKILL, zh) || '',
        zh
          ? '你是短剧设定集策划：根据创作意图提炼世界观与风格，并列出角色/场景/道具设定，供后续剧本与画面生成保持一致。只输出 JSON。'
          : 'You are a series-bible planner for short drama: derive worldview and style from the intent, and list characters/scenes/props so later script and image generation stay consistent. Output JSON only.',
      ].filter(Boolean).join('\n');
      const user = zh ? [
        ideas ? '项目现有创作意图/剧本：\n' + ideas : '（项目暂无创作意图，请给出一个可用的短剧设定草案）',
        existing ? '已有设定集（请在其基础上补全，不要丢弃已有条目）：\n' + existing : '',
        '输出 JSON：{"worldview":"世界观/核心设定（题材、年代、核心规则、主线暗线）","style":"风格基调（画风、色调、质感）",'
          + '"characters":[{"name":"…","desc":"外观与性格关键词"}],"scenes":[{"name":"…","desc":"外观关键词"}],"props":[{"name":"…","desc":"外观关键词"}]}',
        '要求：名称唯一且可直接用于检索；desc 写可复现的外观关键词（年龄/发型/服装/材质/光线），不要写抽象评价。',
      ].filter(Boolean).join('\n') : [
        ideas ? 'Existing intent/script:\n' + ideas : '(No intent yet — produce a usable draft)',
        existing ? 'Existing bible (extend it, keep existing entries):\n' + existing : '',
        'Output JSON: {"worldview":"…","style":"…","characters":[{"name":"…","desc":"…"}],"scenes":[…],"props":[…]}',
        'Names must be unique and searchable; desc must be reproducible visual keywords.',
      ].filter(Boolean).join('\n');
      const text = await aiComplete({ system, user });
      const raw = parseJsonBalanced(text);
      const obj = raw && typeof raw === 'object' ? raw : {};
      const list = (v) => (Array.isArray(v) ? v : [])
        .map((x) => ({ name: String((x && x.name) || '').trim(), desc: String((x && x.desc) || '').trim() }))
        .filter((x) => x.name);
      const merge = (base, incoming) => {
        const out = [...(base || [])];
        for (const item of incoming) {
          const i = out.findIndex((x) => String(x.name).trim() === item.name);
          if (i >= 0) out[i] = { ...out[i], ...item };
          else out.push(item);
        }
        return out;
      };
      const next = {
        worldview: String(obj.worldview || cur.worldview || '').trim(),
        style: String(obj.style || cur.style || '').trim(),
        characters: merge(cur.characters, list(obj.characters)),
        scenes: merge(cur.scenes, list(obj.scenes)),
        props: merge(cur.props, list(obj.props)),
      };
      if (!next.worldview && !next.style && !next.characters.length) throw new Error(T('bibleDraftEmpty'));
      return next;
    }

    /** 设定条目 ↔ 资产绑定对话框：从当前项目的资产库里多选图片/音频/视频。 */
    /** 绑定对话框的资产行：组件化以便用 useAssetUrl 显示缩略图。 */
    function AssetPickRow({ a, checked, onToggle }) {
      const url = useAssetUrl(a.kind === 'image' ? a.id : null);
      return h('label', { className: 'dshic-row', style: { gap: 6, fontSize: 11, cursor: 'pointer', alignItems: 'center' }, onPointerDown: (e) => e.stopPropagation(), onClick: () => onToggle() },
        h('input', { type: 'checkbox', checked, onChange: () => onToggle(), onPointerDown: (e) => e.stopPropagation() }),
        a.kind === 'image' && url
          ? h('img', { src: url, style: { width: 26, height: 26, objectFit: 'cover', borderRadius: 4, flex: 'none' }, draggable: false })
          : h('span', { className: 'dshic-tag st', style: { flex: 'none' } }, a.kind === 'video' ? T('kindVideo') : T('kindAudio')),
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.name || a.id),
        a.projectId === GENERAL_PID ? h('span', { className: 'dshic-projchip' }, T('generalProject')) : null,
      );
    }

    /** 设定条目 ↔ 资产绑定对话框：项目可切换、搜索、分页（资产会越来越多）。 */
    function BibleLinkDialog({ entry, onApply, onClose }) {
      const PAGE_SIZE = 24;
      const [assets, setAssets] = useState(null);
      const [picked, setPicked] = useState(() => new Set((entry.assetIds || []).map(String)));
      const [q, setQ] = useState('');
      const [scope, setScope] = useState(S.activeId || 'all');
      const [page, setPage] = useState(0);
      useEffect(() => {
        let ok = true;
        (async () => {
          try {
            const all = await idbAll();
            if (ok) setAssets(all.filter((a) => a.kind !== 'text'));
          } catch { if (ok) setAssets([]); }
        })();
        return () => { ok = false; };
      }, []);
      const toggle = (id) => {
        const next = new Set(picked);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setPicked(next);
      };
      const ql = q.trim().toLowerCase();
      const scoped = (assets || []).filter((a) => {
        if (scope === GENERAL_PID) return a.projectId === GENERAL_PID;
        if (scope === 'all') return true;
        return a.projectId === scope || a.projectId === GENERAL_PID; // 项目视图含通用资产（多项目共用）
      });
      const list = scoped.filter((a) => !ql || String(a.name || '').toLowerCase().includes(ql));
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      const pageSafe = Math.min(page, pages - 1);
      const pageItems = list.slice(pageSafe * PAGE_SIZE, pageSafe * PAGE_SIZE + PAGE_SIZE);
      return h('div', { className: 'dshic-modal-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'dshic-modal', style: { width: 560 } },
          h('div', { className: 'dshic-modal-title' }, T('bibleLinkTitle') + ' — ' + (entry.name || '…')),
          h('div', { className: 'dshic-hint' }, T('bibleLinkHint')),
          h('div', { className: 'dshic-node-row' },
            h(MiniSelect, {
              value: scope, title: T('projectFilter'), width: 150,
              options: [{ value: 'all', label: T('allProjects') }, { value: GENERAL_PID, label: T('generalProject') }]
                .concat(S.projects.map((pp) => ({ value: pp.id, label: pp.name }))),
              onChange: (v) => { setScope(v); setPage(0); },
            }),
            h('input', { className: 'dshic-input', style: { flex: 1 }, value: q, placeholder: T('searchLabel'), onChange: (e) => { setQ(e.target.value); setPage(0); }, onPointerDown: (e) => e.stopPropagation() }),
          ),
          h('div', { className: 'dshic-shot-list', style: { maxHeight: 420 } },
            assets === null
              ? h('div', { className: 'dshic-hint' }, T('aiRunning'))
              : pageItems.length === 0
                ? h('div', { className: 'dshic-hint' }, T('emptyAssets'))
                : pageItems.map((a) => h(AssetPickRow, { key: a.id, a, checked: picked.has(a.id), onToggle: () => toggle(a.id) }))),
          h('div', { className: 'dshic-node-row' },
            h('button', { type: 'button', className: 'dshic-mini', disabled: pageSafe <= 0, onClick: () => setPage(pageSafe - 1), onPointerDown: (e) => e.stopPropagation() }, '‹ ' + T('pagePrev')),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, (pageSafe + 1) + ' / ' + pages + ' · ' + list.length),
            h('button', { type: 'button', className: 'dshic-mini', disabled: pageSafe >= pages - 1, onClick: () => setPage(pageSafe + 1), onPointerDown: (e) => e.stopPropagation() }, T('pageNext') + ' ›'),
            h('div', { className: 'dshic-flex' }),
          ),
          h('div', { className: 'dshic-modal-actions' },
            h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', onClick: onClose }, T('cancel')),
            h('button', {
              type: 'button', className: 'dshic-btn',
              onClick: () => onApply([...picked]),
            }, T('bibleLinkApply') + (picked.size ? '（' + picked.size + '）' : ''))),
        ));
    }
/** 项目设定集（Series Bible）：世界观 + 风格 + 角色/场景/道具卡，注入所有 AI 生成保证跨集一致。 */
    function BibleTab() {
      const [bible, setBible] = useState(() => loadBible(S.activeId));
      const [busy, setBusy] = useState(false);
      useEffect(() => { setBible(loadBible(S.activeId)); }, [S.activeId, S.assetsTick]);
      const persist = (next) => { setBible(next); saveBible(S.activeId, next); };
      /** 从项目里的创作意图/剧本一键起草设定集（设定集先行）。 */
      const draft = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const next = await aiDraftBible(bible);
          persist(next);
          toast(T('bibleDrafted'));
        } catch (e) { toast(String((e && e.message) || e)); }
        setBusy(false);
      };
      const [linkFor, setLinkFor] = useState(null); // { key, index, entry } —— 正在编辑链接资产的设定条目
      const listEditor = (key, labelKey) => h('div', { className: 'dshic-card' },
        h('div', { className: 'dshic-row' },
          h('strong', { style: { fontSize: 12 } }, T(labelKey)),
          h('div', { className: 'dshic-flex' }),
          h('button', {
            type: 'button', className: 'dshic-mini',
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => persist({ ...bible, [key]: [...(bible[key] || []), { name: '', desc: '', assetIds: [] }] }),
          }, Ic('plus', 11), T('bibleAdd')),
        ),
        ...(bible[key] || []).map((item, i) => h('div', { key: i, className: 'dshic-row' },
          h('input', {
            className: 'dshic-input', style: { width: 76, flex: 'none' }, value: item.name || '',
            placeholder: T('bibleNamePh'),
            onChange: (e) => { const arr = [...bible[key]]; arr[i] = { ...arr[i], name: e.target.value }; persist({ ...bible, [key]: arr }); },
            onPointerDown: (e) => e.stopPropagation(),
          }),
          // 链接资产栏：把该条目绑定到资产库的图片/音频/视频（多选），@引用与参考图解析会优先用它
          h('button', {
            type: 'button', className: cls('dshic-mini', (item.assetIds || []).length && 'is-active'),
            title: T('bibleLinkAssets'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => setLinkFor({ key, index: i, entry: item }),
          }, Ic('image', 11), (item.assetIds || []).length ? ' ' + item.assetIds.length : ''),
          h('input', {
            className: 'dshic-input', style: { flex: 1, minWidth: 0 }, value: item.desc || '',
            placeholder: T('bibleDescPh'),
            onChange: (e) => { const arr = [...bible[key]]; arr[i] = { ...arr[i], desc: e.target.value }; persist({ ...bible, [key]: arr }); },
            onPointerDown: (e) => e.stopPropagation(),
          }),
          h('button', {
            type: 'button', className: 'dshic-iconbtn is-danger',
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => { const arr = [...bible[key]]; arr.splice(i, 1); persist({ ...bible, [key]: arr }); },
          }, '✕'),
        )),
        linkFor && linkFor.key === key
          ? h(BibleLinkDialog, {
              key: 'link', entry: linkFor.entry, onClose: () => setLinkFor(null),
              onApply: (assetIds) => {
                const arr = [...bible[key]];
                arr[linkFor.index] = { ...arr[linkFor.index], assetIds };
                persist({ ...bible, [key]: arr });
                setLinkFor(null);
              },
            })
          : null,
      );
      return [
        h('div', { key: 'proj', className: 'dshic-hint' },
          `${T('bibleTab')} · ${T('currentProject')}：${(S.projects.find((p) => p.id === S.activeId) || {}).name || ''}`),
        h('div', { key: 'order', className: 'dshic-hint' }, T('bibleOrderHint')),
        h('div', { key: 'draft', className: 'dshic-row' },
          h('button', {
            type: 'button', className: 'dshic-mini', disabled: busy,
            onPointerDown: (e) => e.stopPropagation(), onClick: draft,
          }, busy ? h('span', { className: 'dshic-spin' }) : Ic('spark', 11), busy ? T('aiRunning') : T('bibleDraft')),
        ),
        h('div', { key: 'world', className: 'dshic-card' },
          h('span', { className: 'dshic-shot-label' }, T('bibleWorldview')),
          h('textarea', {
            className: 'dshic-textarea', style: { minHeight: 110 }, value: bible.worldview || '',
            placeholder: T('bibleWorldviewPh'),
            onChange: (e) => persist({ ...bible, worldview: e.target.value }),
            onPointerDown: (e) => e.stopPropagation(),
          }),
        ),
        h('div', { key: 'style', className: 'dshic-card' },
          h('span', { className: 'dshic-shot-label' }, T('bibleStyle')),
          h('textarea', {
            className: 'dshic-textarea', style: { minHeight: 52 }, value: bible.style || '',
            onChange: (e) => persist({ ...bible, style: e.target.value }),
            onPointerDown: (e) => e.stopPropagation(),
          }),
        ),
        listEditor('characters', 'bibleCharacters'),
        listEditor('scenes', 'bibleScenes'),
        listEditor('props', 'bibleProps'),
      ];
    }

    function Rightbar() {
      const tabs = [
        { id: 'projects', label: T('projects'), icon: 'folder' },
        { id: 'assets', label: T('assets'), icon: 'image' },
        { id: 'bible', label: T('bibleTab'), icon: 'script' },
        { id: 'settings', label: T('settings'), icon: 'settings' },
      ];
      return h('div', { className: 'dshic-rightbar', 'data-rb': '1', onPointerDown: (e) => e.stopPropagation() },
        h('div', { className: 'dshic-tabs' },
          tabs.map((t) => h('button', {
            key: t.id, type: 'button',
            className: cls('dshic-tab', S.rightTab === t.id && 'is-active'),
            onClick: () => update((s) => { s.rightTab = t.id; }),
          }, t.label)),
        ),
        h('div', { className: 'dshic-rb-body' },
          S.rightTab === 'projects' ? h(ProjectsTab) : null,
          S.rightTab === 'assets' ? h(AssetsTab) : null,
          S.rightTab === 'bible' ? h(BibleTab) : null,
          S.rightTab === 'settings' ? h(SettingsTab) : null,
        ),
      );
    }

    /** 小地图：节点总览 + 视口指示 + 点击/拖拽导航。 */
    function Minimap() {
      const nodes = Object.values(S.graph.nodes);
      const dragRef = useRef(false);
      if (!nodes.length || !canvasEl) return null;
      const MW = 160, MH = 100, pad = 6;
      const r = containerRect();
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const nd of nodes) {
        bx0 = Math.min(bx0, nd.x); by0 = Math.min(by0, nd.y);
        bx1 = Math.max(bx1, nd.x + nd.w); by1 = Math.max(by1, nd.y + (nd.h || 96));
      }
      const vx = -V.x / V.scale, vy = -V.y / V.scale;
      const vw = r.width / V.scale, vh = r.height / V.scale;
      bx0 = Math.min(bx0, vx); by0 = Math.min(by0, vy);
      bx1 = Math.max(bx1, vx + vw); by1 = Math.max(by1, vy + vh);
      const bw = Math.max(1, bx1 - bx0), bh = Math.max(1, by1 - by0);
      const s2 = Math.min((MW - pad * 2) / bw, (MH - pad * 2) / bh);
      const ox = pad + (MW - pad * 2 - bw * s2) / 2;
      const oy = pad + (MH - pad * 2 - bh * s2) / 2;
      const navigateTo = (clientX, clientY, commit) => {
        const rect = canvasEl.getBoundingClientRect();
        const mx = clientX - rect.left - (r.width - MW), my = clientY - rect.top - (r.height - MH);
        const wx = bx0 + (mx - ox) / s2, wy = by0 + (my - oy) / s2;
        setView(r.width / 2 - wx * V.scale, r.height / 2 - wy * V.scale, V.scale, !!commit);
      };
      return h('div', {
        className: 'dshic-minimap',
        onPointerDown: (e) => {
          e.stopPropagation();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
          dragRef.current = true;
          navigateTo(e.clientX, e.clientY, false);
        },
        onPointerMove: (e) => { if (dragRef.current) { e.stopPropagation(); navigateTo(e.clientX, e.clientY, false); } },
        onPointerUp: (e) => { dragRef.current = false; e.stopPropagation(); setView(V.x, V.y, V.scale, true); },
        onPointerCancel: (e) => { dragRef.current = false; },
      },
        nodes.map((nd) => {
          const px = ox + (nd.x - bx0) * s2, py = oy + (nd.y - by0) * s2;
          return h('div', {
            key: nd.id,
            className: cls('dshic-mm-node', S.sel.has(nd.id) && 'is-sel'),
            style: { left: px, top: py, width: Math.max(3, nd.w * s2), height: Math.max(2, (nd.h || 96) * s2) },
          });
        }),
        h('div', {
          className: 'dshic-mm-view',
          style: {
            left: ox + (vx - bx0) * s2, top: oy + (vy - by0) * s2,
            width: Math.max(6, vw * s2), height: Math.max(6, vh * s2),
          },
        }),
      );
    }

    // ============================================================
    // 主面板
    // ============================================================
    let applyViewToDomSoon = () => {};
    function useApp() {
      const [, force] = useState(0);
      useEffect(() => subscribe(() => force((x) => x + 1)), []);
      return S;
    }
    // 错误边界：任何渲染期崩溃都不再白屏——显示错误与堆栈 + 重载按钮（用户可直接把内容发回来修）
    const BoundaryBase = (React && React.Component) ? React.Component : class {}; // 冒烟桩 React 没有 Component，兜底
    class PanelErrorBoundary extends BoundaryBase {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error || new Error('未知渲染错误') };
      }
      componentDidCatch(error, info) {
        try { console.error('[infinite-canvas] 渲染错误', error, info && info.componentStack); } catch { /* 忽略 */ }
      }
      render() {
        if (!this.state.error) return this.props.children;
        const msg = String(this.state.error && this.state.error.message || this.state.error);
        const stack = String(this.state.error && this.state.error.stack || '').split('\n').slice(0, 6).join('\n');
        return h('div', { style: { padding: 24, color: 'var(--dsw-alias-state-error-primary, #e5544b)', fontSize: 13, lineHeight: 20, whiteSpace: 'pre-wrap', userSelect: 'text' } },
          h('div', { style: { fontWeight: 700, marginBottom: 8 } }, '⚠ 画布界面出现了一个渲染错误（已拦截，不会丢失已保存的数据）'),
          h('div', { style: { marginBottom: 8 } }, msg),
          stack ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12, userSelect: 'text' } }, stack) : null,
          h('button', {
            type: 'button', className: 'dshic-btn',
            onClick: () => { this.setState({ error: null }); },
          }, '恢复界面'),
          h('button', {
            type: 'button', className: 'dshic-btn', style: { marginLeft: 8 },
            onClick: () => { try { window.location.reload(); } catch { /* 忽略 */ } },
          }, '重载页面'),
        );
      }
    }

    function CanvasPage() {
      useApp();
      const rootRef = useRef(null);
      useLayoutEffect(() => {
        canvasEl = rootRef.current;
        applyViewToDom();
        return () => { canvasEl = null; worldEl = null; nodeEls.clear(); edgePathEls.clear(); tempEdgeEl = null; marqueeEl = null; };
      }, []);
      useEffect(() => {
        applyViewToDomSoon = () => applyViewToDom();
        window.addEventListener('keydown', onWindowKeyDown);
        return () => window.removeEventListener('keydown', onWindowKeyDown);
      }, []);
      useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const fn = (e) => {
          // 文本/下拉等交互区域保持原生滚动，不缩放画布
          const t = e.target;
          if (t && t.closest && t.closest('textarea, input, select, .dshic-shot-list')) return;
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
          const factor = Math.pow(1.0015, -e.deltaY);
          const ns = clamp(V.scale * factor, 0.15, 3);
          const wx = (sx - V.x) / V.scale, wy = (sy - V.y) / V.scale;
          setView(sx - wx * ns, sy - wy * ns, ns, false);
        };
        el.addEventListener('wheel', fn, { passive: false });
        return () => el.removeEventListener('wheel', fn);
      }, []);
      const nodes = Object.values(S.graph.nodes);
      const upd = S.updateInfo;
      const updAvail = upd && upd.behind > 0; // 仅真正落后（npm latest 更新）才提示；本地版本相同/更新则不提示
      return h('div', { className: 'dshic-page' },
        !S.hostOk && S.hostError
          ? h('div', {
              style: {
                flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)',
                color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12, lineHeight: '18px',
              },
            },
              h('span', {}, '⚠ ' + T('restartHint')),
              h('span', { style: { opacity: 0.75, fontSize: 11 } }, '(' + S.hostError + ')'),
            )
          : null,
        updAvail && !S.updateDismissed
          ? h('div', {
              style: {
                flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
                color: 'var(--dsw-alias-state-success-primary)', fontSize: 12, lineHeight: '18px',
              },
            },
              h('span', {}, '🚀 ' + T('updateAvailable') + ' v' + (upd.remoteVersion || '') + (upd.runningVersion ? '（' + T('updateCurrent') + ' v' + upd.runningVersion + '）' : '')),
              S.updateBusy
                ? h('span', { className: 'dshic-spin' })
                : h('button', {
                    type: 'button', className: 'dshic-mini',
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: applyUpdate,
                  }, Ic('download', 11), T('updateGo')),
              h('a', {
                href: 'https://github.com/NINKCH/dsh-infinite_canvas/releases', target: '_blank', rel: 'noreferrer',
                style: { color: 'inherit', opacity: 0.8, fontSize: 11 },
                onPointerDown: (e) => e.stopPropagation(),
              }, T('releaseNotes') + ' ↗'),
              h('span', { style: { flex: 1 } }),
              h('button', {
                type: 'button', className: 'dshic-node-x', title: T('cancel'),
                onPointerDown: (e) => e.stopPropagation(),
                onClick: () => update((s) => { s.updateDismissed = true; }),
              }, '✕'),
            )
          : null,
        S.updateMsg
          ? h('div', {
              style: {
                flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', fontSize: 12,
                background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)',
                color: 'var(--dsw-alias-brand-primary)',
              },
            },
              S.updateMsg,
              S.updateReloadable
                ? h('button', {
                    type: 'button', className: 'dshic-mini',
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => location.reload(),
                  }, T('reloadPage'))
                : null,
            )
          : null,
        h(Toolbar),
        h('div', { className: 'dshic-main' },
          h('div', {
            ref: rootRef,
            className: 'dshic-canvas',
            onPointerDown: onCanvasPointerDown,
            onPointerMove: onCanvasPointerMove,
            onPointerUp: onCanvasPointerUp,
            onPointerCancel: onCanvasPointerUp,
            onContextMenu: onCanvasContextMenu,
            onDoubleClick: onCanvasDoubleClick,
          },
            h('div', {
              className: 'dshic-world',
              ref: (el) => { worldEl = el; if (el) applyViewToDom(); },
            },
              h(EdgeLayer),
              nodes.filter((nd) => nd.type === 'group').map((n) => h(NodeShell, { key: n.id, n })),
              nodes.filter((nd) => nd.type !== 'group').map((n) => h(NodeShell, { key: n.id, n })),
              h('div', {
                className: 'dshic-marquee', style: { display: 'none' },
                ref: (el) => { marqueeEl = el; },
              }),
              h('div', { className: 'dshic-guide-v', style: { display: 'none' }, ref: (el) => { vGuidEl = el; } }),
              h('div', { className: 'dshic-guide-h', style: { display: 'none' }, ref: (el) => { hGuidEl = el; } }),
            ),
            h(Minimap),
            nodes.length === 0 ? h('div', { className: 'dshic-empty' },              h('div', { className: 'dshic-empty-card' },
                h('div', { className: 'dshic-empty-title' }, T('emptyNodeTitle')),
                h('div', { className: 'dshic-hint', style: { maxWidth: 320 } }, T('emptyNodeHint')),
                h('div', { className: 'dshic-empty-row' },
                  h('button', { type: 'button', className: 'dshic-mini', onClick: () => { const c = worldCenter(); addNodeAt('script', { x: c.x - 320, y: c.y }); } }, Ic('script', 11), T('nScript')),
                  h('button', { type: 'button', className: 'dshic-mini', onClick: () => { const c = worldCenter(); addNodeAt('storyboard', { x: c.x - 320, y: c.y + 180 }); } }, Ic('board', 11), T('nStoryboard')),
                  h('button', { type: 'button', className: 'dshic-mini', onClick: () => { const c = worldCenter(); addNodeAt('image-gen', { x: c.x, y: c.y - 30 }); } }, Ic('spark', 11), T('nImageGen')),
                  h('button', { type: 'button', className: 'dshic-mini', onClick: () => { const c = worldCenter(); addNodeAt('video-gen', { x: c.x, y: c.y + 30 }); } }, Ic('video', 11), T('nVideoGen')),
                ),
              ),
            ) : null,
          ),
          S.rightOpen ? h(Rightbar) : null,
        ),
        S.menu ? h(ContextMenu, { menu: S.menu }) : null,
        S._toast ? h('div', {
          style: {
            position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 70,
            background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 10, padding: '8px 14px', fontSize: 12, boxShadow: '0 8px 24px rgba(0,0,0,.25)',
            maxWidth: 420,
          },
        }, S._toast) : null,
      );
    }

    // ============================================================
    // 侧栏图标
    // ============================================================
    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
      },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 4.5, stroke: 'currentColor', 'stroke-width': 1.6 }),
        h('circle', { cx: 8.5, cy: 9.2, r: 2, fill: 'currentColor' }),
        h('rect', { x: 13.8, y: 7.4, width: 3.6, height: 3.6, rx: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 15.4, cy: 15.6, r: 2, fill: 'currentColor' }),
        h('path', { d: 'M10.5 9.2h3.3', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
        h('path', { d: 'M9.6 11c1.8 1.4 2.6 2.2 3.9 3.4', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
        h('path', { d: 'M15.4 13.6v-2.4', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
      );
    }

    // ============================================================
    // 插件入口
    // ============================================================
    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        CTX = ctx;
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'infinite-canvas: dictionaries');
        ctx.effect(() => {
          const el = document.createElement('style');
          el.id = 'dsh-ic-styles';
          el.textContent = CSS;
          document.head.appendChild(el);
          return () => el.remove();
        }, 'infinite-canvas: styles');
        ctx.effect(() => {
          initStore();
          pushHistory();
          LANG_OVERRIDE = loadSettings().lang || '';
          const unsub = ctx.locale.subscribe(() => notify());
          // ArtCraft 后期工具链状态探测（失败静默，Craft 功能各自降级）
          probeCraft();
          // 检查更新（Host RPC；Host 旧版未带此方法时静默）
          checkUpdate(true);
          // 数据根目录（Host 旧版静默降级为 IndexedDB 模式）；就绪后自动搬存量资产到磁盘、纠正分类，再对齐索引
          refreshDataRoot().then(() => autoMigrateAssetsToRoot()).then(() => fixGeneralCategories()).then(() => syncAssetIndexToHost()).catch(() => { /* 静默 */ });
          // 对话 ↔ 画布同步（启动一次 + 3s 轮询；旧 Host 自动停轮询）
          hostSyncTick().then(() => pushAllProjectsToHost());
          const hostSyncTimer = setInterval(() => hostSyncTick(), 3000);
          // 后台路由探活：失败时在画布顶部给出可操作的提示
          hostRpc('ping').then(() => { S.hostOk = true; S.hostError = null; notify(); }).catch((e) => {
            S.hostOk = false;
            S.hostError = String((e && e.message) || e);
            notify();
          });
          return () => { unsub(); clearInterval(hostSyncTimer); };
        }, 'infinite-canvas: store & locale');
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 100,
          label: () => T('panel'),
          locale: NS,
        }, PanelIcon));
        // 面板根：包一层错误边界——任何渲染期崩溃都不再白屏，而是显示可复制的错误卡片
        PanelErrorBoundary.__dshicClass = true; // 冒烟 walker 标记
    function PanelRoot() {
          return h(PanelErrorBoundary, null, h(CanvasPage));
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, PanelRoot));
        // 冒烟测试专用缝隙（仅在 smoke-render.mjs 设置了该标记时存在）：
        // 直接暴露各页签组件与同步入口，让测试能逐个渲染/驱动，抓白屏与同步断链问题
        if (typeof window !== 'undefined' && window.__DSH_IC_SMOKE__) {
          window.__DSH_IC_TABS__ = { ProjectsTab, AssetsTab, BibleTab, SettingsTab, CanvasPage };
          window.__DSH_IC_SYNC__ = {
            hostSyncTick, mergeHostDoc, loadBible, loadGraphDoc,
            removeNodes, ungroupNode, undo, redo, pushHistory,
            graph: () => JSON.parse(JSON.stringify(S.graph)),
            state: () => ({ stopped: hostSyncStopped, busy: hostSyncBusy, projects: S.projects.map((p) => p.id), activeId: S.activeId, ready: S.ready }),
          };
        }
      },
    };
  },
});

