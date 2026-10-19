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
      'storyboard': {
        // 承接端口（按数组顺序自上而下排布）：顶部「衔接上一镜」← 上一个分镜表的「尾镜」输出
        inputs: [{ id: 'prev', kind: 'text' }, { id: 'script', kind: 'text' }],
        outputs: [{ id: 'out', kind: 'text' }, { id: 'tail', kind: 'text' }],
      },
      'image-gen': {
        inputs: [{ id: 'prompt', kind: 'text' }, { id: 'ref', kind: 'image' }],
        outputs: [{ id: 'out', kind: 'image' }],
      },
      'video-gen': {
        inputs: [{ id: 'prompt', kind: 'text' }, { id: 'frame', kind: 'image' }, { id: 'ref', kind: 'image' }],
        outputs: [{ id: 'out', kind: 'video' }, { id: 'last', kind: 'image' }],
      },
      'image-asset': { inputs: [{ id: 'in', kind: 'image' }], outputs: [{ id: 'out', kind: 'image' }] },
      'video-asset': { inputs: [{ id: 'in', kind: 'video' }], outputs: [{ id: 'out', kind: 'video' }, { id: 'last', kind: 'image' }] },
      'finalcut': { inputs: [{ id: 'in', kind: 'video' }], outputs: [] },
      'group': { inputs: [], outputs: [] },
    };
    // 允许多条入线的输入端口（参考图类），其余输入端口保持单线
    const MULTI_INPUT_PORTS = new Set(['ref', 'char', 'scene', 'prop']);
    // 分镜端口期望的资产分类（仅用于连接时的非阻断提示）
    const PORT_CATEGORY = { char: 'character', scene: 'scene', prop: 'prop' };
    const CATEGORIES = ['character', 'scene', 'prop', 'script', 'storyboard', 'audio', 'finalcut', 'image', 'general'];
    const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
    const IMAGE_SIZES = ['1K', '2K', '4K'];
    // 时长选项放宽到 30s（万相 3.0 等支持长视频）；各厂商上限不同——超限由接口报错，系统不做静默截断
    const VIDEO_DURATIONS = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30];
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
    /** 参考图/首帧压缩：长边 ≤ maxEdge、JPEG 重编码。
     *  参考图不需要 2K 原图——多张 2K PNG base64 后会击穿 Host 代理 16MB 上限（HTTP 413）。
     *  画布/解码失败时回退原始 base64。 */
    async function blobToDataUrlScaled(blob, maxEdge = 1024) {
      try {
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(bmp, 0, 0, w, h);
        bmp.close && bmp.close();
        return c.toDataURL('image/jpeg', 0.85);
      } catch { return await blobToDataUrl(blob); }
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
      'catImage': '图片',
      'catLabel': '分类',
      'rename': '重命名',
      'cancel': '取消',
      'doDelete': '删除',
      'delProjectTitle': '删除项目',
      'delProjectWarn': '将删除该项目及其全部资产（共 {n} 个），且无法恢复。请输入项目名以确认：',
      'delProjectInput': '项目名',
      'imgMode': '参考图模式',
      'modeGenerations': '生图 /images/generations（支持多参考图）',
      'modeEdits': '参考图编辑 /images/edits（多参考图上传）',
      'modeCompshare': '优云智算任务式 /image/v1/tasks（Qwen-Image，参考图登记 + 提示词优化）',
      'catMismatch': '提示：资产分类为「{a}」，端口期望「{b}」，已保留连接',
      'nStoryboard': '分镜表',
      'nScript': '剧本',
      'vendorLabel': '厂商格式（选后只需填 Base URL + 模型 id）',
      'showKey': '显示明文',
      'hideKey': '隐藏（脱敏显示）',
      'supportBtn': '帮助与反馈',
      'supportTitle': '帮助与反馈',
      'supportNote': '有问题或改进建议，提 Issue 或进群反馈。',
      'supportGithub': 'GitHub 仓库',
      'supportIssues': '访问 GitHub，提 Issue',
      'supportWechat': '交流群',
      'supportWechatHint': '扫码添加，进入交流群',
      'supportCopy': '复制地址',
      'supportCopied': '已复制到剪贴板',
      'supportOpen': '打开',
      'supportQrMissing': '二维码待放置：assets/support/wechat.png',
      'supportClose': '关闭',
      'portScript': '剧本',
      'portPrev': '衔接上一镜',
      'portTail': '尾镜输出',
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
      'zoomView': '放大查看',
      'copyAll': '复制全部',
      'copiedOk': '已复制到剪贴板',
      'copyFail': '复制失败：请手动选择文本复制',
      'lbHint': '点击空白处或按 Esc 关闭',
      'resizeList': '拖拽调整分镜列表高度',
      'frameModeLabel': '衔接',
      'frameModeHint': '首帧来源的处理方式（首帧=上一段尾帧，用于跨段接戏）。网关禁止首帧与参考图混用：融合=尾帧降级为第1张参考图（保留实体参考图，衔接为软约束+提示词锚定）；硬首帧=用真首帧参数（画面绝对承接，但放弃参考图）；忽略=不使用首帧。即使没有连 frame 线，续帧段也会自动取上一段尾帧作首帧',
      'frameModeAuto': '参考图融合',
      'frameModeHard': '硬首帧（弃参考图）',
      'frameModeOff': '忽略首帧',
      'contFrom': '承接',
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
      'warnScriptTooLong': '剧本较长（{n} 字）≈ 超过单个分镜的镜头容量（24 镜）：请按场景拆分为多个场景剧本节点（每个分镜只连一个场景剧本）',
      'warnEmptyDesc': '已登记但描述为空（待补全）',
      'catMention': '提及',
      'assetCategoriesFixed': '已按命名规范纠正 {n} 个资产的分类',
      'cfgExtra': '扩展参数（JSON，可选）',
      'cfgExtraHint': 'JSON 对象，逐键合并进请求体（留空不发送）——厂商专属参数如 watermark、prompt_extend、output_format、seed 等在此填写，换厂商无需改代码',
      'vidProtocolHint': '通用 = OpenAI 风格任务接口（JUAI 等聚合平台，URL 填完整 /v1/video/generations）；Seedance 官方 = 火山方舟 contents/generations/tasks',
      'vidAudioOpt': '生成同步音频（勾选才发送 generate_audio）',
      'vidOutFormat': '输出格式 output_format（留空不发送）',
      'voiceExtractBtn': '提取声音参考',
      'voiceRole': '角色名',
      'voiceRolePh': '陈拾',
      'voiceRoleNeeded': '需要角色名',
      'voiceStart': '开始秒',
      'voiceEnd': '结束秒（留空 = 到片尾）',
      'voiceTip': '选一段"该角色独占台词"的窗口（多角色同屏的段落不适合做声音参考）。片段将存为「角色-<名> 声音」并绑定实体，之后 @<名> 自动携带音色参考。需要降噪/精细分离时可在 Craft（SoundCraft）中处理后再按同一规范导入。',
      'voiceExtractDone': '已存为声音参考：{name}',
      'voiceExtractSrc': '提取自',
      'expandScenes': '铺开到场景',
      'expandScenesDone': '已铺开 {n} 个场景（每场：文本节点 → 分镜表 已连线）',
      'expandNeedScenes': '未识别到场景分隔标记——剧本需按「【场N】场景名（地点·时间）」分场书写（重新生成或手动补分场标题）',
      'autoShots': '自动（按内容节拍）',
      'voiceAutoHint': '输入角色名 → 自动按分镜台词定位该角色的全部时间窗，并拼接为一个声音参考文件（无需手动找时间点）',
      'voiceRolesInShots': '分镜台词中的角色：',
      'voiceSegs': '命中镜头',
      'voiceNoDialogue': '未找到分镜表或分镜表无镜头——自动定位需要分镜台词标注，请先生成/铺开分镜',
      'voiceManual': '手动指定时间窗',
      'voiceRoleNotFound': '分镜台词中没有该角色。可选角色：{roles}',
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
      'stoppedNote': '已手动停止',
      'stoppedTaskKept': '视频任务 id 已保留，可凭 id 回查结果',
      'stoppedToast': '已手动停止生成',
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
      'tailPick': '尾帧选帧',
      'tailPickHint': '续帧接力用的尾帧：从片尾多帧里选「动作进行中、清晰、不抖」的一帧，而不是机械取最后一帧',
      'chainNext': '接续下一镜',
      'chainInfo': '续帧：首帧来自上一段尾帧',
      'chainAuto': '自动取上一段尾帧作首帧',
      'chainManual': '首帧来自连线',
      'contToggle': '分镜衔接',
      'contToggleHint': '开启后，分镜会为每镜写出「承接上镜尾态 / 接点尾态（动作进行中）/ 运镜延续 / 段落类型」——分段生成才能接得上',
      'shotTail': '接点尾态',
      'segOpening': '首段·交代',
      'segContinuation': '续帧',
      'segNew_character': '新角色入场',
      'segScene_change': '换场',
      'segCloseup': '特写插入',
      'seamOk': '接缝通过',
      'seamFail': '接缝偏跳',
      'seamHint': '接缝校验：本段首帧与上一段尾帧的画面相似度',
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
      'catImage': 'Image',
      'catLabel': 'Category',
      'rename': 'Rename',
      'cancel': 'Cancel',
      'doDelete': 'Delete',
      'delProjectTitle': 'Delete project',
      'delProjectWarn': 'This deletes the project and all its assets ({n}). Type the project name to confirm:',
      'delProjectInput': 'Project name',
      'imgMode': 'Reference mode',
      'modeGenerations': 'image /images/generations (with references)',
      'modeEdits': 'image edit /images/edits (multi-reference upload)',
      'modeCompshare': 'Compshare task /image/v1/tasks (Qwen-Image, reference upload)',
      'catMismatch': 'Note: asset category is "{a}", port expects "{b}". Connected anyway.',
      'nStoryboard': 'Storyboard',
      'nScript': 'Script',
      'portScript': 'script',
      'vendorLabel': 'Vendor format (then just Base URL + model id)',
      'showKey': 'Show key',
      'hideKey': 'Hide key (masked)',
      'supportBtn': 'Help & feedback',
      'supportTitle': 'Help & feedback',
      'supportNote': 'Found a bug or have an idea? File an issue or join the group.',
      'supportGithub': 'GitHub repository',
      'supportIssues': 'Visit GitHub & file an issue',
      'supportWechat': 'Community group',
      'supportWechatHint': 'Scan to join the group',
      'supportCopy': 'Copy URL',
      'supportCopied': 'Copied to clipboard',
      'supportOpen': 'Open',
      'supportQrMissing': 'QR not added yet: assets/support/wechat.png',
      'supportClose': 'Close',
      'portPrev': 'Continue prev tail',
      'portTail': 'Tail shot (for next)',
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
      'zoomView': 'View large',
      'copyAll': 'Copy all',
      'copiedOk': 'Copied to clipboard',
      'copyFail': 'Copy failed — select the text manually',
      'lbHint': 'Click outside or press Esc to close',
      'resizeList': 'Drag to resize the shot list',
      'frameModeLabel': 'Chaining',
      'frameModeHint': 'How the first frame is sourced (first frame = previous segment tail, for cross-segment continuity). The gateway forbids mixing first_frame with reference_image: Fuse = tail frame becomes reference image #1 (keeps entity refs; soft constraint + prompt anchoring); Hard = true first_frame param (exact continuity, drops refs); Ignore = no frame. Even without a frame wire, continuation segments auto-take the previous tail',
      'frameModeAuto': 'Fuse with refs',
      'frameModeHard': 'Hard first frame',
      'frameModeOff': 'Ignore frame',
      'contFrom': 'Continues',
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
      'warnScriptTooLong': 'Script is long ({n} chars) ≈ beyond one storyboard\'s shot capacity (24 shots): split the script into multiple scene script nodes (each storyboard takes ONE scene)',
      'warnEmptyDesc': 'registered but description is empty (fill it in)',
      'catMention': 'Mention',
      'assetCategoriesFixed': 'Re-categorized {n} assets by naming convention',
      'cfgExtra': 'Extra params (JSON, optional)',
      'cfgExtraHint': 'A JSON object merged into the request body (empty = not sent) — vendor-specific params like watermark, prompt_extend, output_format, seed go here; switching vendors needs no code changes',
      'vidProtocolHint': 'Generic = OpenAI-style task API (JUAI etc., URL = full /v1/video/generations); Seedance official = Volcano Ark contents/generations/tasks',
      'vidAudioOpt': 'Generate synced audio (only sent when checked)',
      'vidOutFormat': 'Output format output_format (empty = not sent)',
      'voiceExtractBtn': 'Extract voice reference',
      'voiceRole': 'Character',
      'voiceRolePh': 'e.g. Chen Shi',
      'voiceRoleNeeded': 'Character name required',
      'voiceStart': 'Start (s)',
      'voiceEnd': 'End (s, empty = to end)',
      'voiceTip': 'Pick a window where this character speaks alone (overlapping-dialogue segments are bad references). The clip is saved as "Character-<name> voice" bound to the entity; @<name> then carries the voice automatically. For降噪/fine separation process in Craft (SoundCraft) and import with the same naming.',
      'voiceExtractDone': 'Saved voice reference: {name}',
      'voiceExtractSrc': 'Extracted from',
      'expandScenes': 'Expand to scenes',
      'expandScenesDone': 'Expanded {n} scenes (each: text node → storyboard, wired)',
      'expandNeedScenes': 'No scene separators found — the script must use "【SCENE N】name (location · time)" per-scene headers (regenerate or add scene headers manually)',
      'autoShots': 'Auto (by content beats)',
      'voiceAutoHint': 'Type the character name — all dialogue windows for that role are located automatically from the storyboard and merged into ONE voice reference file',
      'voiceRolesInShots': 'Characters found in shot dialogue: ',
      'voiceSegs': 'Matched shots',
      'voiceNoDialogue': 'No storyboard with shots found — auto location needs the dialogue annotations; generate the storyboard first',
      'voiceManual': 'Manual time window',
      'voiceRoleNotFound': 'Role not found in shot dialogue. Available: {roles}',
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
      'stoppedNote': 'Manually stopped',
      'stoppedTaskKept': 'video task id kept for lookup',
      'stoppedToast': 'Generation stopped',
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
      'tailPick': 'Tail pick',
      'tailPickHint': 'Tail frame used for chaining: the best "mid-motion, sharp, stable" frame near the end, not blindly the last one',
      'chainNext': 'Chain next shot',
      'chainInfo': 'Chained: first frame comes from the previous segment tail',
      'chainAuto': 'Auto: previous segment tail as first frame',
      'chainManual': 'First frame from wire',
      'contToggle': 'Continuity',
      'contToggleHint': 'When on, the storyboard writes a tail state / start state / camera carry-over / segment type for every shot — that is what makes separately generated segments connect',
      'shotTail': 'Hand-off tail',
      'segOpening': 'Opening',
      'segContinuation': 'Continuation',
      'segNew_character': 'New character',
      'segScene_change': 'Scene change',
      'segCloseup': 'Insert',
      'seamOk': 'Seam OK',
      'seamFail': 'Seam jump',
      'seamHint': 'Seam check: similarity between this segment first frame and the previous tail frame',
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
/* 手动拉过高高度的节点：主体内的文本框随节点一起拉伸（拖高=对话框变高，而不是只撑外框）；
   文本框不允许被 flex 压扁（分镜列表/流式变高时宁可下方截断，输入框保持自身可读高度） */
.dshic-node.h-manual .dshic-node-body{overflow:hidden;}
.dshic-node.h-manual .dshic-node-body > .dshic-textarea{flex:1 1 auto;min-height:0;}
.dshic-node.h-manual .dshic-node-body > .dshic-prompt{flex:1 1 auto;display:flex;flex-direction:column;flex-shrink:0;}
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
/* 角点端口（分镜尾镜输出/衔接输入）：显式以锚点为中心，保证连线正好从点位中心垂直穿出 */
.dshic-port.is-corner{left:-5.5px;top:-5.5px;}
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
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);user-select:text;-webkit-user-select:text;cursor:text;}
.dshic-shot-item strong{color:var(--dsw-alias-label-primary);font-size:11px;}
.dshic-shot-grip{position:absolute;right:3px;bottom:3px;width:18px;height:14px;display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;cursor:ns-resize;opacity:.6;user-select:none;-webkit-user-select:none;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;}
.dshic-shot-grip:hover{opacity:1;color:var(--dsw-alias-label-primary);}
.dshic-lightbox{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;}
.dshic-lightbox img,.dshic-lightbox video{max-width:92vw;max-height:80vh;border-radius:8px;background:#000;box-shadow:0 12px 48px rgba(0,0,0,.5);}
.dshic-lightbox-cap{font-size:12px;color:#eee;user-select:text;-webkit-user-select:text;max-width:80vw;word-break:break-all;text-align:center;}
.dshic-textcard{width:100%;height:86px;box-sizing:border-box;border:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:18px;padding:7px 9px;overflow:hidden;text-align:left;display:block;white-space:pre-wrap;}
/* 文本（剧本等）资产卡：只展示标题与项目标签，不展开正文 */
.dshic-textcard.is-title{display:flex;flex-direction:column;gap:6px;justify-content:center;padding:10px 9px;color:inherit;}
.dshic-textcard-title{font-size:12px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary);word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.dshic-textcard-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);}
/* @引用高亮输入框：字号/行高/内距与 .dshic-textarea 完全一致（背景层与透明输入框必须逐像素对齐） */
/* overflow+圆角：背层是绝对定位，父级高度由 textarea 撑开时 bottom/inset 不一定能把背层锁死，
   多出来的行会画出边框。裁切必须做在由输入框撑高的这一层上，框内保留、框外遮住（含圆角）。 */
.dshic-prompt{position:relative;display:block;width:100%;overflow:hidden;border-radius:8px;}
.dshic-prompt-back,.dshic-prompt-input{font:inherit;font-size:12px;line-height:18px;padding:7px 9px;box-sizing:border-box;
  white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}
.dshic-prompt-back{position:absolute;top:0;left:0;right:0;height:100%;overflow:hidden;pointer-events:none;color:var(--dsw-alias-label-primary);
  border:1px solid transparent;border-radius:8px;}
.dshic-prompt-ph{color:var(--dsw-alias-label-tertiary);}
.dshic-prompt-input{position:relative;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary);
  resize:vertical;overflow-y:auto;scrollbar-width:none;}
/* 隐藏输入框滚动条：滚动条占位会让透明输入框与背层的换行点不一致（错位的另一来源）；滚轮滚动不受影响 */
.dshic-prompt-input::-webkit-scrollbar{width:0;height:0;}
.dshic-prompt-input::placeholder{color:transparent;}
.dshic-mention{color:#2f7cf6;}
/* 注意：@名称 高亮不能加粗——加粗字形更宽，背层与透明输入框宽度不一致会导致逐字错位 */
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
.dshic-hist-thumb img,.dshic-hist-thumb video{width:100%;height:100%;object-fit:cover;display:block;}
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

/* ── 视觉精修层（统一质感；追加在基础规则之后生效）──────────────── */
.dshic-node{border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.10),0 6px 18px rgba(0,0,0,.10);}
.dshic-node:hover{box-shadow:0 2px 4px rgba(0,0,0,.10),0 10px 26px rgba(0,0,0,.14);}
.dshic-node.is-selected{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 38%,transparent),0 10px 26px rgba(0,0,0,.14);}
.dshic-node.st-running{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent),0 8px 22px rgba(0,0,0,.12);}
.dshic-node-head{height:32px;padding:0 10px;}
.dshic-node-head .dshic-node-label,.dshic-node-head strong{font-weight:600;letter-spacing:.2px;}
.dshic-node-body{padding:10px;display:flex;flex-direction:column;gap:8px;}
.dshic-gen{height:32px;font-weight:600;letter-spacing:.3px;box-shadow:0 1px 3px rgba(0,0,0,.18);}
.dshic-gen:hover:not(:disabled){box-shadow:0 2px 6px rgba(0,0,0,.22);}
.dshic-textarea:focus,.dshic-input:focus,.dshic-prompt-input:focus{border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);}
/* 高亮框自己 overflow:hidden，子元素的光圈会被裁掉；光圈画在外层，外层自己的阴影不受自身 overflow 影响 */
.dshic-prompt:focus-within{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);}
.dshic-prompt:focus-within .dshic-prompt-input{box-shadow:none;}
.dshic-shot-label{font-size:10px;letter-spacing:.4px;color:var(--dsw-alias-label-secondary);}
.dshic-hint{line-height:15px;}
.dshic-card{border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.06);}
.dshic-mini{border-radius:7px;}
.dshic-toolbar{backdrop-filter:blur(6px);}
.dshic-node .dshic-textarea,.dshic-node .dshic-input{border-radius:8px;}
.dshic-preview{border-radius:10px;}
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
    function saveSettings(s) {
      lsSet(LS_SETTINGS, s);
      notify(); // 设置即改即存（无保存按钮），但必须通知画布重渲染——否则节点上的模型下拉/星标一直是旧快照
    }

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
          // vendor 必须带出去：否则「显式选了厂商」在请求侧丢失，只能靠模型名/URL 猜协议（曾把万相误判成 Seedance）
          out.push({ ref: p.id + '|' + m.id, providerId: p.id, providerName: p.name || p.id, modelId: m.id, model: String(m.model).trim(), url: p.url || '', apiKey: p.apiKey || '', extra: p.extra || '', outputFormat: p.outputFormat || '', generateAudio: p.generateAudio, protocol: p.protocol || 'generic', watermark: p.watermark, vendor: p.vendor || '' });
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
    /** @资产名@ 的词法（双 @ 精确包裹）：终止符是闭合 @，绝不可能把后文吞进名称；
     *  名称内禁止 @、空白与常见标点。前端渲染时隐藏两个 @，名称显示为蓝色加粗。 */
    const MENTION_RE = /@([^@\s，。；：、,.;:!?！？()（）\[\]【】"'“”<>《》/\\|]{1,64}?)@/g;
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
    /** 把提示词转成高亮 HTML：@资产名@ 两个 @ 隐藏（占位但不可见），名称显示为蓝色加粗。 */
    function highlightMentions(text) {
      const src = String(text || '');
      let out = '';
      let last = 0;
      const re = new RegExp(MENTION_RE.source, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        out += escapeHtml(src.slice(last, m.index));
        out += '<span style="visibility:hidden">@</span><span class="dshic-mention">' + escapeHtml(m[1]) + '</span><span style="visibility:hidden">@</span>';
        last = m.index + m[0].length;
      }
      out += escapeHtml(src.slice(last));
      return out === '' ? '' : out + '\n'; // 末尾补换行，保证背景层与 textarea 行高对齐
    }
    /** 送给模型前去掉 @ 包裹标记（保留名称本体）。 */
    function stripMentionMarks(text) {
      return String(text || '').replace(new RegExp(MENTION_RE.source, 'g'), '$1');
    }
    /** 展示用：把 @资产名@ 渲染为「蓝色加粗资产名」（隐藏两个 @，前后各留 2px 视觉空隙）。 */
    function mentionNodes(text) {
      const src = String(text || '');
      const out = [];
      const re = new RegExp(MENTION_RE.source, 'g');
      let m;
      let last = 0;
      while ((m = re.exec(src)) !== null) {
        if (m.index > last) out.push(src.slice(last, m.index));
        out.push(h('span', { className: 'dshic-mention', style: { margin: '0 2px' } }, m[1]));
        last = m.index + m[0].length;
      }
      if (last < src.length) out.push(src.slice(last));
      return out.length ? out : [src];
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
    /** 生成用提示词：@标记去掉 + [图N] 绑定 + 命中实体的设定描述。
     *  light=true（图片生成专用）：只保留风格行与 [图N] 名称绑定——参考图本身就是外观事实源，
     *  内联设定全文会稀释参考图约束，且文字渲染型模型（Qwen-Image）会把追加文本直接画进画面（用户实测：
     *  设定集全文被渲染成画面右下角的乱码文字块、剧情词凭空生成道具）。视频路径不用 light（不渲染文字，上下文有益）。 */
    function buildEffectivePrompt(prompt, refs, entities, bible, light) {
      const zh = effLang() !== 'en';
      const bind = refs.map((r, i) => {
        if (r.entity) {
          const ent = matchBibleEntity(r.entity, bible);
          const desc = light ? '' : ((ent && ent.desc) || '');
          return `[图${i + 1}] ${entityLabelOf((ent || {}).kind || 'prop')} ${r.entity}${desc ? '（' + desc + '）' : ''}`;
        }
        return `[图${i + 1}] ${catLabel(r.category)}：${r.name}`;
      }).join('；');
      const entLines = light ? [] : entities.map((e) => `${entityLabelOf(e.kind)} ${e.name}：${e.desc}`);
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
        /** 修复未闭合的 @引用：模型在句尾常丢闭合 @（写作 @糯糯。 而非 @糯糯@。）——
     *  未闭合引用不会被词法识别，参考图会静默丢失。这里按已知资产名自动补全并归一为完整名；
     *  无法对上已知名的裸 @ 原样保留（不误伤普通文本）。 */
    function repairUnclosedMentions(text, knownNames) {
      const t = String(text || '');
      const names = (knownNames || []).filter((x) => x && String(x).trim()).map((x) => String(x).trim());
      if (!t || !names.length) return t;
      const stop = /[\s@，。；：、！？…（）【】\[\]"'“”<>《》/\\|]/;
      let out = '';
      let i = 0;
      while (i < t.length) {
        if (t[i] !== '@') { out += t[i]; i++; continue; }
        let j = i + 1;
        while (j < t.length && !stop.test(t[j])) j++;
        const name = t.slice(i + 1, j);
        if (!name) { out += t[i]; i++; continue; }
        if (t[j] === '@') { out += t.slice(i, j + 1); i = j + 1; continue; } // 已闭合：原样
        const hit = names.find((k) => k === name || name.startsWith(k) || k.startsWith(name));
        if (hit) { out += '@' + hit + '@'; i = j; continue; } // 补闭合 + 归一为完整名
        out += t.slice(i, j + 1); i = j + 1; // 未命中：原样保留（含终止符）
      }
      return out;
    }
    /** 设定集里的全部资产名（角色/场景/道具），供未闭合引用修复与一致性检查使用。 */
    function bibleNames(bible) {
      const b = bible || {};
      return [].concat(b.characters || [], b.scenes || [], b.props || [])
        .map((x) => (x && x.name ? String(x.name).trim() : '')).filter(Boolean);
    }

    // ---------- 分镜衔接（续帧接力 / 段落调度 / 接缝校验）----------
    //  为什么需要它：每段视频是**独立采样**的，模型不知道上一段最后发生了什么。分镜只写"本镜拍什么"、
    //  不写"接在哪、怎么接"，模型就自己脑补起点 → 每段各演各的。行业解法不是提示词玄学，而是三层工程：
    //   ① 分镜层写「承接上镜尾态 / 本镜起始态 / 接点尾态（动作进行中）/ 运镜延续」；
    //   ② 生成层把上一段尾帧作为本段首帧（首尾帧模式优先，其次尾帧降级为第 1 张参考图并软锚定）；
    //   ③ 剪辑/校验层比对接缝（尾帧 vs 下段首帧），超阈值打回。
    /** 归一到 0-1 的相似度（0.8 以上视为同一画面）。数字或 null。 */
    function normSim(x) {
      const v = Number(x);
      if (!Number.isFinite(v)) return null;
      return Math.max(0, Math.min(1, v > 1.0001 ? v / 100 : v));
    }
    /** 镜头画面文本（visual + motion），用于衔接描述与相似度兜底。 */
    function shotVisualText(sh) {
      if (!sh) return '';
      return [String(sh.visual || '').trim(), String(sh.motion || '').trim()].filter(Boolean).join('；');
    }
    /**
     * 镜头衔接规划：把「尾部状态 / 起始状态 / 运镜延续 / 段落类型 / 接缝档位」统一解出来。
     * 分镜字段可手写（tail/start/cam），缺失时用 visual 兜底——**绝不编造剧情**，只做"能确认的推断"。
     * seg:   'opening'（首段，交代）| 'continuation'（续帧，默认）| 'new_character'（新角色入场，参考图模式）
     *        | 'scene_change'（换场，不接尾帧）| 'closeup'（特写/细节插入，接缝不被画面盯着看 → 标准放宽）
     * join:  'strict'（同步长硬接）| 'loose'（跨场/换景，允许软接）| 'cut'（特写插入，跳切合理，不接力）
     * @returns {{seg,name,join,fromTail,fromShot,tail,start,cam,chain,note}}
     */
    function shotContinuityPlan(sh, prev, idx) {
      const s = sh || {};
      const i = Number.isFinite(Number(idx)) ? Number(idx) : 0;
      const prevShot = i > 0 ? (prev || null) : null;
      const segRaw = String(s.seg || '').trim().toLowerCase();
      const SEG_ALIAS = {
        opening: 'opening', open: 'opening', '首段': 'opening', '开场': 'opening',
        continuation: 'continuation', cont: 'continuation', '续': 'continuation', '续帧': 'continuation', '承接': 'continuation',
        new_character: 'new_character', newchar: 'new_character', '新角色': 'new_character', '入场': 'new_character',
        scene_change: 'scene_change', scene: 'scene_change', '换场': 'scene_change', '转场': 'scene_change',
        closeup: 'closeup', insert: 'closeup', '特写': 'closeup', '插入': 'closeup',
      };
      let seg = SEG_ALIAS[segRaw] || '';
      const boxed = (k) => String(s[k] || '').trim();
      if (!seg) {
        if (!prevShot) seg = 'opening';
        else if (/换场|场景切换|转场|另一处|另一场景|切至|切到|次日|翌日|与此同时|数日后|[Cc]ut to/.test(shotVisualText(s))) seg = 'scene_change';
        else if (/新角色|首次出场|走进来|入镜|入场|冒出|推门进|[Ee]nters?/.test(shotVisualText(s))) seg = 'new_character';
        else if (Number(s.duration) > 0 && Number(s.duration) < 1.5 && !(s.dialogue || []).length) seg = 'cut';
        else seg = 'continuation';
      }
      if (seg === 'opening' && prevShot) seg = 'continuation'; // 首段只能在第 1 镜；后面标"开场"视为续帧
      const join = seg === 'scene_change' ? 'loose' : seg === 'cut' ? 'cut' : seg === 'new_character' ? 'loose' : 'strict';
      const tail = boxed('tail') || (prevShot ? shotVisualText(s).slice(0, 80) : '');
      const start = boxed('start') || (prevShot ? ('承接上一镜结尾：' + (boxed('tail') || shotVisualText(prevShot).slice(0, 80))) : '');
      const cam = boxed('cam');
      const chain = (seg === 'continuation' || seg === 'new_character') && !!prevShot;
      return {
        idx: i, seg, join, fromTail: i > 0, fromShot: i > 0, chain,
        name: String(s.title || '').trim(),
        tail, start, cam,
        note: boxed('note'),
      };
    }
    /**
     * 由上一段分镜的尾镜推出本分镜的「承接约束」（跨分镜表接戏）。
     * 与 aiStoryboardShots 的 prevTail 契约一致：{ label, text, shot }，但这里显式带出衔接字段。
     */
    function storyboardContinuityNote(prevShots, label, zh) {
      const arr = (prevShots || []).filter(Boolean);
      const tailShot = arr.length ? arr[arr.length - 1] : null;
      if (!tailShot) return null;
      const plan = shotContinuityPlan(tailShot, null, 0);
      const text = [
        zh ? '尾镜画面：' : 'Tail frame: ', String(tailShot.visual || '').trim(),
        zh && plan.tail ? '\n尾镜结束状态：' + plan.tail : (plan.tail ? '\nTail end state: ' + plan.tail : ''),
        zh && plan.cam ? '\n尾镜运镜：' + plan.cam : (plan.cam ? '\nTail camera: ' + plan.cam : ''),
        String(tailShot.motion || '').trim() ? '\n' + (zh ? '尾镜最后动作：' : 'Tail last action: ') + String(tailShot.motion).trim() : '',
      ].filter(Boolean).join('');
      return { label: String(label || ''), text: text + '\n', shot: tailShot, plan };
    }
    /**
     * 镜头衔接块（写进视频提示词）：让模型知道"接在哪、从哪起、留什么给下一段"。
     * 只在分镜明确给出衔接信息或确属跨分镜承接时生成；普通首镜（无上游）返回 ''，绝不无中生有。
     */
    function shotContinuityBlock(plan, opts) {
      const p = plan || {};
      const o = opts || {};
      const zh = o.zh !== false;
      if (!p.fromShot) return '';
      const isFirst = p.idx === 0;
      // 段类型：本分镜表内续帧 / 承接上一个分镜表 / 不接（换场·特写插入）
      let kindLine = '';
      if (p.seg === 'scene_change') kindLine = zh ? '段落类型：换场（不承接上一镜画面，直接建立新空间；环境声可延续）' : 'Segment type: scene change (do not continue the previous frame; establish the new space; ambience may carry over)';
      else if (p.seg === 'cut') kindLine = zh ? '段落类型：特写/细节插入（可与上一镜跳切，不要求画面连续）' : 'Segment type: insert close-up (jump cut allowed, no frame continuity required)';
      else if (p.seg === 'new_character') kindLine = zh ? '段落类型：新角色入场（新角色须在画面中自然进入，不得凭空出现）' : 'Segment type: new character enters (must enter naturally, never pop in)';
      else if (p.seg === 'continuation') kindLine = zh
        ? (isFirst ? '段落类型：承接上一个分镜表（本分镜第 1 镜从上一镜结尾继续，不重演、不重新建立场景）' : '段落类型：续帧（从上一镜结尾继续，不重演）')
        : (isFirst ? 'Segment type: continues the previous storyboard (no re-establishing, no replay)' : 'Segment type: continuation (continue from the previous shot, no replay)');
      const parts = [];
      if (p.tail && (p.seg === 'continuation' || p.seg === 'new_character')) parts.push((zh ? '承接上镜结尾（本镜起始态，不得重置姿态/位置/手持物）：' : 'Continue from the previous shot end state (start exactly here; do not reset posture/position/handheld props): ') + p.tail);
      else if (p.start && p.seg === 'continuation') parts.push((zh ? '本镜起始态：' : 'Start state: ') + p.start);
      if (p.cam) parts.push((zh ? '运镜延续：' : 'Camera continues: ') + p.cam + (zh ? '（方向与速度保持，不反向、不突变）' : ' (same direction and speed; no reversal, no sudden change)'));
      if (p.note) parts.push((zh ? '接戏要求：' : 'Continuity requirement: ') + p.note);
      if (!kindLine && !parts.length) return '';
      const head = zh ? '【衔接】' : '[Continuity] ';
      const end = zh
        ? '禁止重启姿态、禁止重新建立场景、禁止改变人物朝向与站位（除非剧情明确要求）'
        : 'Never reset posture, never re-establish the scene, never change facing or blocking unless the story demands it';
      const body = [kindLine].concat(parts, [end]).filter(Boolean);
      // 统一标点：拼接前去掉各自尾部标点，避免出现「。；」这种叠标点
      const clean = body.map((x) => String(x).replace(/[。；;.、\s]+$/, '')).filter(Boolean);
      return head + clean.join(zh ? '；' : '; ') + (zh ? '。' : '.');
    }
    /**
     * 首帧（上一段尾帧）的软锚定说明：把首帧图钉在"第 1 帧"，模型只允许往后运动。
     * 接口不支持硬首帧时这是**提高权重**，不是锁像素——调用方要给用户可见的告警。
     */
    function frameAnchorText(opts) {
      const o = opts || {};
      const zh = o.zh !== false;
      if (!o.hasFrame) return '';
      const asFirst = o.role === 'first_frame';
      return zh
        ? (asFirst
          ? '【首帧锚定】本次输入的首帧图就是上一段视频的结尾画面：第 1 帧必须与该图完全一致（构图、人物位置、朝向、手持道具、光线），只允许从第 1 帧之后继续运动。'
          : '【首帧锚定】[图1] 是上一段视频的结尾画面（衔接参考，非风格参考）：第 1 帧必须与 [图1] 的画面一致——构图、人物位置、朝向、手持道具、主光方向都不得改动，只允许往后延续运动。')
        : (asFirst
          ? '[First-frame anchor] The input first frame IS the last frame of the previous segment: frame 1 must match it exactly (framing, blocking, facing, handheld props, light) and motion starts only after frame 1.'
          : '[First-frame anchor] [Picture 1] is the last frame of the previous segment (a continuity reference, not a style reference): frame 1 must match it - framing, blocking, facing, handheld props and key light unchanged; only continue the motion.');
    }
    /**
     * 尾帧选帧评分：不是"取最后一帧"——最后一帧常落在动作顶点/运动模糊/遮挡/收敛抖动上。
     * 返回 0-1 分，越高越适合当下一段首帧（动作进行中、清晰、无遮挡、不抖）。
     * @param m { motion（相邻帧差 0-1）, sharp（清晰度 0-1）, coverage（前景占比 0-1）, jitter（模型收敛抖动 0-1）, complete（动作完成度 0-1） }
     */
    function tailFrameScore(m) {
      const c = (x, d) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(1, Number(x))) : d);
      const motion = c(m && m.motion, 0.5);
      const sharp = c(m && m.sharp, 0.5);
      const coverage = c(m && m.coverage, 1);
      const jitter = c(m && m.jitter, 0);
      const complete = c(m && m.complete, 0.5);
      // 动作"进行中"最好：太快（模糊/顶点）或完全静止（定格）都扣分
      const motionFit = 1 - Math.abs(motion - 0.45) / 0.55;
      // 动作完成度：留 30% 未完成最利于续接（完成度 0.7 附近满分，1=完成态扣分）
      const incomplete = 1 - Math.abs(complete - 0.7) / 0.7;
      const score = 0.34 * Math.max(0, motionFit) + 0.30 * sharp + 0.16 * coverage + 0.14 * Math.max(0, incomplete) - 0.22 * jitter;
      return Math.max(0, Math.min(1, score));
    }
    /**
     * 帧间相似度（接缝校验）：只比较缩略灰度图，抗压缩噪声。
     * 指标：MAD（平均绝对差）、粗糙结构相关（16 宫格均值相关）——两者都要过才算接得上。
     * @param a/b { data: Uint8ClampedArray|number[]（RGBA）, w, h }（同尺寸，调用方先缩到 32×32 灰度或同等）
     */
    function frameSeamMetrics(a, b) {
      const ga = a && a.data, gb = b && b.data;
      if (!ga || !gb || !ga.length || ga.length !== gb.length) return null;
      const n = ga.length;
      let sad = 0;
      let ma = 0, mb = 0;
      for (let i = 0; i < n; i++) { sad += Math.abs(ga[i] - gb[i]); ma += ga[i]; mb += gb[i]; }
      ma /= n; mb /= n;
      let cov = 0, va = 0, vb = 0;
      for (let i = 0; i < n; i++) { const da = ga[i] - ma, db = gb[i] - mb; cov += da * db; va += da * da; vb += db * db; }
      const corr = (va > 1e-6 && vb > 1e-6) ? cov / Math.sqrt(va * vb) : (Math.abs(ma - mb) < 6 ? 1 : 0);
      // 宫格结构相似：把图切成 G×G 求每格均值，再做相关（对整体位移/缩放不敏感，抓"画面是否同一空间"）
      const G = 16;
      const side = Math.round(Math.sqrt(n)) || 1;
      const cellA = new Array(G * G).fill(0), cellB = new Array(G * G).fill(0), cnt = new Array(G * G).fill(0);
      for (let i = 0; i < n; i++) {
        const x = i % side, y = Math.floor(i / side);
        const gx = Math.min(G - 1, Math.floor((x / side) * G));
        const gy = Math.min(G - 1, Math.floor((y / side) * G));
        const k = gy * G + gx;
        cellA[k] += ga[i]; cellB[k] += gb[i]; cnt[k]++;
      }
      let cm = 0;
      const ca = cellA.map((v, k) => (cnt[k] ? v / cnt[k] : 0)), cb = cellB.map((v, k) => (cnt[k] ? v / cnt[k] : 0));
      for (let k = 0; k < ca.length; k++) cm += ca[k] / ca.length;
      let cv = 0, cv2 = 0, cva = 0, cvb = 0;
      for (let k = 0; k < ca.length; k++) { const da = ca[k] - cm, db = cb[k] - cm; cv += da * db; cva += da * da; cvb += db * db; }
      const gridCorr = (cva > 1e-6 && cvb > 1e-6) ? cv / Math.sqrt(cva * cvb) : 0;
      return {
        mad: sad / n, // 0-255
        corr, // -1..1
        gridCorr, // -1..1
        sim: Math.max(0, Math.min(1, 0.35 * corr + 0.65 * gridCorr)), // 0-1 综合相似度
      };
    }
    /** 接缝判定：超过档位阈值才算"接得上"，否则给出明确原因（供 UI 打回/告警）。 */
    function seamVerdict(metrics, join) {
      if (!metrics) return { ok: true, sim: null, note: '' };
      const thr = join === 'loose' ? 0.35 : join === 'cut' ? 0.15 : 0.55;
      const sim = metrics.sim;
      const ok = sim >= thr;
      return {
        ok, sim, thr,
        note: ok ? '' : ('接缝相似度 ' + sim.toFixed(2) + ' < 阈值 ' + thr.toFixed(2) + '（' + (join === 'loose' ? '跨场/换景' : join === 'cut' ? '特写插入' : '同场续帧') + '）：画面可能跳变'),
      };
    }

    // ---------- 视频「参考生成」结构化提示词（对齐 MiniMax H3 / 优云智算的优化后格式）----------
    //  为什么需要它：机械拼装（风格 + [图N] 绑定 + 镜头列表 + 设定集全文）会让模型把台词/场景判错；
    //  这个格式把「素材 → 主体 → 分镜 → 台词 → 声音」显式绑定，模型据此做音画同步与口型对齐。
    /** 参考图 → 主体信息：实体名（@引用或资产名解析）、品类、设定集描述。 */
    function subjectInfoFromRef(ref, bible) {
      const raw = String((ref && ref.name) || '').trim();
      let name = String((ref && ref.entity) || '').trim();
      let kind = ref && ref.category === 'character' ? 'character' : ref && ref.category === 'scene' ? 'scene' : ref && ref.category === 'prop' ? 'prop' : '';
      if (!name) {
        const m = /^(角色|场景|道具)[-_／/]/.exec(raw);
        if (m) kind = m[1] === '角色' ? 'character' : m[1] === '场景' ? 'scene' : 'prop';
        name = raw
          .replace(/^(角色|场景|道具)[-_／/]\s*/, '')
          .replace(/\s*\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}[\s\S]*$/, '')
          .replace(/\s*(设定图|参考图|多视图|三视图)[\s\S]*$/, '')
          .trim();
      }
      const ent = bible && name ? matchBibleEntity(name, bible) : null;
      return { name: ent ? ent.name : name, kind: (ent && ent.kind) || kind, desc: ent ? String(ent.desc || '') : '' };
    }
    /** 描述压缩成一句：优先「外观：…」片段，其次首句，最长 80 字。 */
    function condenseDesc(desc) {
      const s = String(desc || '').replace(/\s+/g, ' ').trim();
      if (!s) return '';
      const ap = /外观[：:]\s*([^。；]+)/.exec(s);
      const seg = ap ? ap[1] : s.split(/[。；]/)[0];
      const one = String(seg || '').replace(/^[，,、\s]+/, '').trim();
      return one.length > 80 ? one.slice(0, 80) + '…' : one;
    }
    /** 设定集描述里的「声音：…」→ 说话人声音标注（台词的音色依据）。 */
    function voiceFromDesc(desc) {
      const m = /声音[：:]\s*([^。；]+)/.exec(String(desc || ''));
      return m ? m[1].trim() : '';
    }
    /**
     * 由分镜表 + 参考图生成「参考生成」结构化提示词。
     * 段名保持英文（与厂商优化后的协议一致），正文用中文；没有参考图时返回 ''（调用方回退到普通提示词）。
     * @param shots 分镜镜头（visual/motion/duration/dialogue/sfx/title/characters/scene/props）
     * @param refs  collectRefs 结果（顺序即 <Picture N>）
     * @param bible 设定集（desc 提供外观/声音信息）
     * @param opts  { zh, prompt（节点上手写的补充说明）, music（非叙事音乐，来自扩展参数） }
     */
    function buildStructuredVideoPrompt(shots, refs, bible, opts) {
      const o = opts || {};
      const zh = o.zh !== false;
      const list = (shots || []).filter((s) => s && (String(s.visual || '').trim() || String(s.motion || '').trim() || (s.dialogue || []).length));
      if (!list.length) return '';
      // 主体分配：一个实体一个 Subject，可对应多张 Picture；顺序 = 参考图中首次出现
      const subjects = [];
      const byKey = new Map();
      (refs || []).forEach((r, i) => {
        const info = subjectInfoFromRef(r, bible);
        if (!info || !info.name) return;
        const key = info.name.toLowerCase();
        let sub = byKey.get(key);
        if (!sub) {
          sub = { name: info.name, kind: info.kind, desc: info.desc, voice: voiceFromDesc(info.desc), pics: [], voiced: false };
          subjects.push(sub);
          byKey.set(key, sub);
        }
        if (!sub.pics.includes(i + 1)) sub.pics.push(i + 1);
      });
      if (!subjects.length) return '';
      const sid = (sub) => subjects.indexOf(sub) + 1;
      const pic = (n2) => '<Picture ' + n2 + '>';
      // 名称 → <Subject N>（长名优先，避免"瓦力"吃掉"瓦力的铃铛"）；顺带清掉 @引用@ 的包裹符号，
      // 否则会留下「@<Subject 2>@」这种残迹（@ 是画布内的引用语法，不该发给视频模型）
      const ordered = subjects.slice().sort((a, b) => b.name.length - a.name.length);
      const mentionRe = /@([^@\s，。；、,;:.!?！？「」（）()]{1,24})@/g;
      const rewrite = (text) => {
        let out = String(text || '');
        if (out.includes('@')) {
          out = out.replace(mentionRe, (all, inner) => {
            const hit = subjects.find((sub) => sub.name.toLowerCase() === String(inner).trim().toLowerCase());
            if (hit) return '<Subject ' + sid(hit) + '>';
            return inner; // 未登记的 @名称@ 去掉包裹符号（不要再把画布语法发给模型）
          });
        }
        for (const sub of ordered) {
          if (!sub.name) continue;
          out = out.split(sub.name).join('<Subject ' + sid(sub) + '>');
        }
        return out;
      };
      // 说话人编号：跨镜台词按首次出现顺序 (S1)、(S2)…
      const speakers = [];
      const speakerId = (roleName) => {
        const nm = String(roleName || '').trim();
        if (!nm) return '';
        let i = speakers.findIndex((x) => x.name === nm);
        if (i < 0) { speakers.push({ name: nm, voiced: false }); i = speakers.length - 1; }
        return 'S' + (i + 1);
      };
      // 绝对时间轴
      let acc = 0;
      const starts = list.map((s) => { const st = acc; acc += Math.max(0.1, Number(s.duration) || 3); return st; });
      const total = acc;
      const fmtT = (sec) => {
        const ms = Math.max(0, Math.round(sec * 1000));
        const m = Math.floor(ms / 60000);
        const s2 = Math.floor((ms % 60000) / 1000);
        return String(m).padStart(2, '0') + ':' + String(s2).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0');
      };
      const appearsIn = (sub) => list.map((_, i) => i + 1).filter((idx) => {
        const s = list[idx - 1];
        const hay = [s.visual, s.motion, s.title, (s.characters || []).join(' '), s.scene, (s.props || []).join(' '), (s.dialogue || []).map((d) => d && d.role).join(' ')].join(' ');
        return hay.includes(sub.name);
      });
      const outs = [];
      // ① 主体定义（素材绑定）
      outs.push('subject_definitions:');
      subjects.forEach((sub, i) => {
        const brief = condenseDesc(sub.desc);
        outs.push('<Subject ' + (i + 1) + '> 是 ' + sub.pics.map(pic).join('、') + ' 中的 ' + sub.name
          + (brief ? '：' + brief : (sub.kind ? '（' + entityLabelOf(sub.kind) + '）' : '')));
      });
      // ② 总述（只写事实，不臆造剧情）
      const first = String(list[0].title || '').trim();
      const last = String(list[list.length - 1].title || '').trim();
      outs.push('summary:');
      outs.push('[参考生成] 目标视频共 ' + list.length + ' 镜、总时长 ' + (Math.round(total * 10) / 10) + ' 秒'
        + (first || last ? '：从「' + (first || '起始镜') + '」开始，到「' + (last || '收束镜') + '」结束' : '')
        + '。主体：' + subjects.map((s) => '<Subject ' + sid(s) + '>').join('、') + '。'
        + (o.prompt ? ' ' + String(o.prompt).trim() : ''));
      // ③ 保真核对（每个主体出现在哪些镜）
      outs.push('retention_analysis:');
      subjects.forEach((sub) => {
        const where = appearsIn(sub);
        const brief = condenseDesc(sub.desc) || (sub.kind ? entityLabelOf(sub.kind) : sub.name);
        outs.push('<Subject ' + sid(sub) + '>（出现于 ' + (where.length ? where.map((i) => '[Shot ' + i + ']').join('、') : '未明确出现') + '）：fully_preserved —— 保持' + brief + '。');
      });
      // ④ 逐镜描述（画面 + 运镜 + 台词 + 音效）
      outs.push('detailed_description:');
      const style = String((bible && bible.style) || '').trim();
      if (style) outs.push((zh ? '风格：' : 'Style: ') + style);
      const hasDialogue = list.some((s) => (s.dialogue || []).some((d) => String((d && d.line) || '').trim()));
      if (hasDialogue) {
        outs.push(zh
          ? '台词必须由画面内对应的主体当场开口说出（口型与台词同步、语气贴合情绪）；严禁画外音/旁白。'
          : 'Dialogue must be spoken on screen by the matching subject with lip-sync; never voice-over.');
      }
      // 跨段续帧：首帧锚定（上一段尾帧作为本段第 1 帧）——放在逐镜之前，权重最高
      const anchor = frameAnchorText({ hasFrame: !!o.hasFrame, role: o.frameRole, zh });
      if (anchor) outs.push(anchor);
      list.forEach((s, i) => {
        const parts = [];
        // 镜头衔接：段类型 + 承接上镜尾态 + 运镜延续（只对**本分镜表内**的镜头生成；
        // 第 1 镜跨段承接由 frameAnchorText/调用方负责，避免同一句话说两遍）
        const plan = shotContinuityPlan(s, list[i - 1], i);
        if (i > 0) {
          const cb = shotContinuityBlock(plan, { zh });
          // 衔接块自带句末标点，作为段落级前置说明独立成句（去掉句末标点后由上层分隔符统一）
          if (cb) parts.push(rewrite(cb).replace(/[。.]+$/, ''));
        }
        const visual = rewrite(String(s.visual || '').trim());
        if (visual) parts.push(visual);
        const motion = rewrite(String(s.motion || '').trim());
        if (motion) parts.push((zh ? '运镜/动作：' : 'Camera/Action: ') + motion);
        const dls = (s.dialogue || [])
          .map((d) => ({ role: String((d && d.role) || '').trim(), line: String((d && d.line) || '').trim() }))
          .filter((d) => d.line);
        if (dls.length) {
          const txt = dls.map((d) => {
            const sp = speakerId(d.role);
            const sub = subjects.find((x) => x.name === d.role);
            const spk = speakers.find((x) => x.name === d.role);
            const useVoice = !!(sub && sub.voice && spk && !spk.voiced);
            if (useVoice) spk.voiced = true;
            const who = sub ? ('<Subject ' + sid(sub) + '>（' + sp + '）') : (d.role ? d.role + '（' + sp + '）' : sp);
            const lang = /[\u4e00-\u9fa5]/.test(d.line) ? 'Chinese' : 'English';
            return who + (useVoice ? ' 用' + sub.voice + '说' : ' 说') + '：<d>[' + lang + '] ' + d.line + '</d>';
          }).join('；');
          parts.push((zh ? '台词：' : 'Dialogue: ') + txt);
        }
        const sfx = rewrite(String(s.sfx || '').trim());
        if (sfx) parts.push((zh ? '音效：' : 'SFX: ') + sfx);
        const title = String(s.title || '').trim();
        outs.push('[Shot ' + (i + 1) + '] ' + fmtT(starts[i]) + (zh ? ' 起' : '')
          + (title ? '（' + title + '）' : '') + '：' + parts.join(zh ? '；' : '; '));
      });
      // ⑤ 声音景观（各镜音效合并）
      const sfxAll = [...new Set(list.map((s) => String(s.sfx || '').trim()).filter(Boolean))];
      outs.push('overall_soundscape:');
      outs.push(sfxAll.length ? sfxAll.join('；') : (zh ? '仅保留场景环境声，不添加额外音效' : 'Ambient scene sound only'));
      // ⑥ 非叙事音乐（仅在用户显式给出时输出，绝不臆造）
      const music = String(o.music || '').trim();
      if (music) {
        outs.push('non_diegetic_music:');
        outs.push(music);
      }
      // ⑦ 跨段接戏（仅当本段承接上一段：有首帧尾帧接力或分镜标了承接）
      const contLine = String(o.continuity || '').trim();
      if (contLine) {
        outs.push('continuity:');
        outs.push(contLine);
      }
      return outs.join('\n');
    }
// <<<MENTION_PURE_END>>>

      /** 解析提示词里的 @引用：返回命中实体 + 其名下的参考图资产与**声音参考资产**（按实体出现顺序、各实体内按生成时间）。
       *  实体的参考资产来源：① 设定条目里**链接的资产**（assetIds，绑定关系优先）
       *                  ② 其次按命名/实体字段匹配的资产（角色-张山 多视图 / 角色-张山 声音 等）。 */
      async function resolveMentionBundle(prompt, bible, projectId) {
        const entities = [];
        for (const m of parseMentions(prompt)) {
          const hit = matchBibleEntity(m.name, bible);
          if (hit && !entities.some((e) => e.name === hit.name)) entities.push(hit);
        }
        if (!entities.length) return { entities: [], refs: [], audioRefs: [] };
        let all = [];
        try { all = (await idbByProject(projectId)).concat(await idbByProject(GENERAL_PID)); } catch { all = []; }
        const byId = new Map(all.map((r) => [r.id, r]));
        const refs = [];
        const audioRefs = [];
        for (const ent of entities) {
          const owned = [];
          const ownedAudio = [];
          // ① 条目链接的资产（绑定优先，任何类型都认；生成时图片当参考图、音频当声音参考）
          for (const aid of ent.assetIds || []) {
            const rec = byId.get(aid);
            if (rec && rec.kind === 'image') owned.push(rec);
            if (rec && rec.kind === 'audio') ownedAudio.push(rec);
          }
          // ② 命名/实体匹配的资产
          for (const r of all) {
            if (r.kind === 'image' && assetBelongsToEntity(r, ent) && !owned.some((x) => x.id === r.id)) owned.push(r);
            if (r.kind === 'audio' && assetBelongsToEntity(r, ent) && !ownedAudio.some((x) => x.id === r.id)) ownedAudio.push(r);
          }
          owned.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          ownedAudio.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          for (const r of owned) if (!refs.some((x) => x.assetId === r.id)) refs.push({ assetId: r.id, entity: ent.name, kind: ent.kind, name: r.name });
          for (const r of ownedAudio) if (!audioRefs.some((x) => x.assetId === r.id)) audioRefs.push({ assetId: r.id, entity: ent.name, name: r.name });
        }
        return { entities, refs, audioRefs };
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
      // 声音参考：@引用命中实体名下的音频资产（角色音色一致性用），视频生成时作为 audios[] 传出
      const audioBlobs = [];
      for (const r of (bundle.audioRefs || [])) {
        try {
          const rec = await idbGet(r.assetId);
          const blob = await assetBlob(r.assetId);
          if (blob) audioBlobs.push({ blob, name: (rec && rec.name) || r.name, entity: r.entity, assetId: r.assetId });
        } catch { /* 忽略 */ }
      }
      return { refs: out, entities: bundle.entities, audioBlobs };
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
    const assetMem = new Map(); // id -> rec：服务端元数据缓存（0.18 起服务端是资产库唯一事实源）
    async function idbGetRaw(id) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const rq = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => reject(rq.error);
      });
    }
    /** 资产记录读取（0.18）：内存缓存 → 服务端 → 旧 IndexedDB 兜底（迁移期遗留 blob）。 */
    async function idbGet(id) {
      if (!id) return null;
      if (assetMem.has(id)) return assetMem.get(id) || null;
      const local = await idbGetRaw(id).catch(() => null);
      if (local) return local;
      try {
        const r = await hostRpc('assetsGet', { ids: [id] });
        const rec = (r && r.items && r.items[0]) || null;
        if (rec) { assetMem.set(rec.id, rec); assetNameCache.set(rec.id, rec.name); }
        return rec;
      } catch { return null; }
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
    async function idbByProjectRaw(pid) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const idx = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).index('projectId');
        const rq = idx.getAll(pid);
        rq.onsuccess = () => resolve((rq.result || []).sort((a, b) => b.createdAt - a.createdAt));
        rq.onerror = () => reject(rq.error);
      });
    }
    /** 项目资产清单（0.18）：服务端分页拉全 + 旧 IndexedDB 遗留合并（服务端不可用时本地兜底）。 */
    async function idbByProject(pid) {
      const out = [];
      try {
        let cursor = null;
        for (;;) {
          const r = await hostRpc('assetsList', { projectId: pid, limit: 200, cursor }).catch(() => null);
          if (!r || !Array.isArray(r.items)) break;
          for (const rec of r.items) {
            out.push(rec);
            if (rec) { assetMem.set(rec.id, rec); assetNameCache.set(rec.id, rec.name); }
          }
          if (!r.nextCursor) break;
          cursor = r.nextCursor;
        }
      } catch { /* 服务端不可用 → 本地兜底 */ }
      try {
        const locals = await idbByProjectRaw(pid);
        const have = new Set(out.map((x) => x.id));
        for (const l of locals) if (l && !have.has(l.id)) out.push(l);
      } catch { /* 忽略 */ }
      return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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
    /** 资产内容 URL：CAS 对象（sha）→ /api/object（immutable，远程可拉）；旧落盘（rel）→ /api/file；本地 blob → objectURL。 */
    function contentUrlFor(rec) {
      if (!rec) return null;
      if (rec.sha) return '/' + NS + '/api/object?sha=' + encodeURIComponent(rec.sha) + (rec.mime ? '&mime=' + encodeURIComponent(rec.mime) : '');
      if (rec.rel) return fileUrlFor(rec.rel);
      return null;
    }
    async function assetUrl(id) {
      if (!id) return null;
      if (assetUrlCache.has(id)) return assetUrlCache.get(id);
      const rec = await idbGet(id);
      if (!rec) return null;
      let url = contentUrlFor(rec);
      if (!url && rec.blob) {
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
    /** 取资产 Blob：CAS/磁盘资产经 Host 文件服务拉取（远程同样可用），旧资产直接读 IndexedDB。 */
    async function assetBlob(id) {
      const rec = await idbGet(id);
      if (!rec) return null;
      if (rec.blob) return rec.blob;
      const url = contentUrlFor(rec);
      if (url) {
        const r = await fetch(url);
        if (!r.ok) throw new Error('资产读取失败 HTTP ' + r.status);
        return await r.blob();
      }
      return null;
    }
    async function saveAssetRecord(projectId, kind, blob, meta) {
      const id = uid('a');
      const mime = blob.type && blob.type !== 'application/octet-stream' ? blob.type
        : (kind === 'image' ? 'image/png' : 'video/mp4');
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
      // 【硬规则】资产文件一律落数据目录的项目文件夹（projects/<项目>/<类型>/<文件>），元数据进
      // canvas.db；IndexedDB 已废弃——未配置数据目录时明确报错，绝不静默塞进浏览器。
      if (!S.dataRoot) {
        throw new Error('未设置数据根目录：资产无法持久化（浏览器 IndexedDB 存储已废弃）。请在 画布 → 设置 → 数据根目录 里配置后重新生成。');
      }
      const rel = `projects/${projectId}/${kind}/${assetFileBase(rec)}.${extFromMime(mime)}`;
      const r = await fetch('/' + NS + '/api/asset?rel=' + encodeURIComponent(rel), { method: 'POST', body: blob });
      if (!r.ok) throw new Error('资产落盘失败: ' + (await r.text()));
      rec.rel = rel;
      rec.size = blob.size;
      rec.stored = 'disk';
      const proj = S.projects.find((p) => p.id === projectId);
      if (S.store === 'sqlite') {
        // 主路径：文件落项目文件夹 + 元数据进 canvas.db（任意浏览器/远程立即可见）
        const saved = await hostRpc('assetCreate', { asset: assetIndexRecord(rec), projectName: (proj && proj.name) || '' });
        const out = (saved && saved.asset) || rec;
        assetMem.set(out.id, out);
        assetNameCache.set(out.id, out.name);
        return out;
      }
      await idbPut(rec); // JSON 降级模式（宿主缺 node:sqlite）：本机元数据缓存
      assetNameCache.set(rec.id, rec.name);
      mirrorAssetIndex(rec); // 元数据镜像进 assets.json
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
      if (rec.sha) { out.sha = rec.sha; out.size = rec.size || 0; }
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
    /** 数据根目录就绪后：把浏览器 IndexedDB 里的存量 blob 资产搬到数据目录的项目文件夹
     *  （projects/<项目>/<类型>/<文件>），搬完从 IndexedDB 移除——**IndexedDB 只减不增，最终清零**。 */
    async function autoMigrateAssetsToRoot() {
      if (!S.dataRoot) return;
      try {
        const all = await idbAll();
        const pending = all.filter((r) => r && r.blob && !r.rel && !r.sha);
        if (!pending.length) return;
        let done = 0;
        for (const rec of pending) {
          try {
            const mime = rec.blob.type || rec.mime || (rec.kind === 'image' ? 'image/png' : 'video/mp4');
            const rel = `projects/${rec.projectId}/${rec.kind}/${assetFileBase(rec)}.${extFromMime(mime)}`;
            const r = await fetch('/' + NS + '/api/asset?rel=' + encodeURIComponent(rel), { method: 'POST', body: rec.blob });
            if (!r.ok) continue;
            const meta = { ...rec, rel, size: rec.size || rec.blob.size };
            delete meta.blob;
            meta.stored = 'disk';
            const proj = S.projects.find((p) => p.id === rec.projectId);
            await hostRpc('assetCreate', { asset: assetIndexRecord(meta), projectName: (proj && proj.name) || '' });
            try { await idbDelete(rec.id); } catch { /* 本地清理失败不阻塞迁移 */ }
            done++;
          } catch { /* 单个失败继续下一个 */ }
        }
        if (done) {
          toast(T('dataRootMigrated').replace('{n}', String(done)));
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
      // mp4 优先（现代 Chrome/Edge 原生支持 H.264 录制）：webm 只是兜底，保证产物统一为 mp4
      const mimes = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
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
      const auth = s.apiKey ? { Authorization: 'Bearer ' + String(s.apiKey).trim() } : {};
      // 节点级扩展参数（手动参数框）与供应商扩展参数合并（节点优先）
      const nodeExtra = String((opts && opts.nodeExtra) || '').trim();
      let extraSrc = String(s.extra || '');
      if (nodeExtra) {
        try {
          extraSrc = JSON.stringify({ ...(extraSrc.trim() ? JSON.parse(extraSrc) : {}), ...JSON.parse(nodeExtra) });
        } catch (e) { throw new Error('节点扩展参数需为 JSON 对象：' + ((e && e.message) || e)); }
      }
      const extra = parseExtraParams(extraSrc); // 厂商专属参数（留空不发送）
      // 优云智算（compshare）任务式：Qwen-Image 异步任务（提交 → 轮询 → output_url 下载）
      if (s.mode === 'compshare') return await compshareImageTask(prompt, refs, { ...s, extra: extraSrc }, opts);
      // 协议自动路由：优云智算的图片 API 只有任务式（/image/v1/tasks）——误配成通用模式
      // 会在 /v1/images/generations 上拿到 401 "invalid api key"（该面不存在），按域名自动切任务式
      try { if (/compshare\.cn$/i.test(new URL(base).hostname)) return await compshareImageTask(prompt, refs, { ...s, extra: extraSrc }, opts); } catch { /* URL 异常由后续流程报错 */ }
      const upstreamTimeout = Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 120000; // 商汤等同步接口 20s+，默认 120s
      // 参考图编辑模式：multipart 上传到 /images/edits（OpenAI gpt-image-1 兼容）
      if (refs.length && s.mode === 'edits') {
        const fd = new FormData();
        if (s.model) fd.append('model', s.model);
        fd.append('prompt', prompt);
        fd.append('n', '1');
        if (s.size) fd.append('size', s.size);
        fd.append('watermark', 'false'); // 稳定默认：去水印优先（与 generations 路径一致）
        refs.forEach((b, i) => fd.append('image[]', b.blob || b, 'ref-' + i + '.png'));
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
        // 稳定默认（总是发送）：去水印优先——多数图片厂商该参数默认 true 会加水印；扩展参数可覆盖
        watermark: false,
      };
      // 多参考生图：generations 模式同样携带参考图（主流约定 image 数组 + data:URL，按 collectRefs 顺序对应提示词里的 [图N]）。
      // 厂商不支持该字段时会明确报错——此时换 edits 模式或在扩展参数里调整字段名。
      if (refs.length) {
        const imgs = [];
        for (const b of refs) imgs.push(await blobToDataUrlScaled(b.blob || b));
        body.image = imgs;
      }
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

    // —— 优云智算（compshare）Qwen-Image 任务式图片 API ——
    //  提交 POST /image/v1/tasks（Idempotency-Key 必填，UUID）→ 3s 轮询 GET /image/v1/tasks/{id}
    //  → succeeded 取 task.output_url 下载；failed/cancelled/blocked 抛出明确原因。
    //  参考图走三步上传（upload_urls → PUT 签名直传 → assets 登记）换 asset_id；
    //  登记结果缓存在画布资产元数据（compAssetIdCache）：同一张 CAS 资产不重复上传。
    const compAssetIdCache = new Map(); // 画布资产 id → 优云 asset_id
    /** 从文件头字节解析像素尺寸（PNG IHDR / JPEG SOF）——与平台服务端解析口径一致：
     *  createImageBitmap 会按 EXIF 方向旋转并交换宽高，平台读原始文件，两者不一致时登记会被拒。 */
    function rawImageDims(u8) {
      try {
        // PNG：签名 8 字节 + 长度 4 + 'IHDR' → 偏移 16 起是宽高（大端 32 位）
        if (u8[0] === 0x89 && u8[1] === 0x50) {
          return {
            w: ((u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19]) >>> 0,
            h: ((u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23]) >>> 0,
          };
        }
        // JPEG：顺序扫描段，命中 SOF0..SOF15（排除 DHT/DAC/RSTn）后取段内高/宽
        if (u8[0] === 0xff && u8[1] === 0xd8) {
          let i = 2;
          while (i + 9 < u8.length) {
            if (u8[i] !== 0xff) { i++; continue; }
            const marker = u8[i + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            const len = (u8[i + 2] << 8) | u8[i + 3];
            if (len < 2) break;
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
              return { w: (u8[i + 7] << 8) | u8[i + 8], h: (u8[i + 5] << 8) | u8[i + 6] };
            }
            i += 2 + len;
          }
        }
      } catch { /* 解析失败返回 null */ }
      return null;
    }
    /** 参考图上传前置：魔数嗅探真实编码（平台仅收 JPG/PNG/WebP，且校验声明 MIME 与实际字节一致——
     *  改后缀的 AVIF/HEIC 会在登记时报 "Params [Width/Height] not available"）+ 测像素尺寸
     *  （同时给出解码尺寸与文件原始尺寸，登记不一致时用原始尺寸重试）。 */
    async function imageBlobMeta(input) {
      const blob = input.blob || input;
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
        && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
      if (!isPng && !isJpg && !isWebp) {
        throw new Error('参考图编码不受支持：平台仅接受 JPG/PNG/WebP 原生编码（当前文件的实际字节不是这三类，常见于改后缀的 AVIF/HEIC）——请转成 JPG/PNG 后重新挂参考图');
      }
      const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/webp';
      const ext = isPng ? 'png' : isJpg ? 'jpg' : 'webp';
      let raw = null;
      try { raw = rawImageDims(new Uint8Array(await blob.slice(0, 262144).arrayBuffer())); } catch { /* 忽略 */ }
      let width = 0;
      let height = 0;
      try {
        const bmp = await createImageBitmap(blob);
        width = bmp.width;
        height = bmp.height;
        try { bmp.close && bmp.close(); } catch { /* 忽略 */ }
      } catch { /* 解码失败时退回文件头尺寸 */ }
      if (!width || !height) { if (raw) { width = raw.w; height = raw.h; } }
      if (!width || !height) throw new Error('参考图尺寸测量失败');
      return { blob, mime, ext, width, height, rawWidth: raw ? raw.w : width, rawHeight: raw ? raw.h : height };
    }
    async function compshareImageTask(prompt, refs, s, opts) {
      const o = opts || {};
      let base = String(s.baseUrl || '').trim().replace(/\/+$/, '');
      base = base.replace(/\/image\/v1$/i, ''); // 粘贴了完整路径前缀也兼容
      if (!base) throw new Error('未配置图片 API 地址（优云智算：https://cp.compshare.cn）');
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + String(s.apiKey || '').trim() };
      const extra = parseExtraParams(s.extra); // 透传：optimize_prompt / use_context_ir 等任务级字段
      if (o.warn && Array.isArray(refs) && refs.length > 10) o.warn('参考图 ' + refs.length + ' 张超过优云上限 10 张，本次只使用前 10 张');
      // 报错附带实际发出的参数：登记/提交被拒时一眼看到缺什么、值是多少（不再靠猜）
      const bodySummary = (b) => {
        if (!b || typeof b !== 'object') return '';
        const parts = [];
        for (const [k, v] of Object.entries(b)) {
          if (v === undefined) { parts.push(k + '=undefined'); continue; }
          if (v === null) { parts.push(k + '=null'); continue; }
          if (typeof v === 'object') { parts.push(k + '=[' + (Array.isArray(v) ? v.length + ' 项' : '对象') + ']'); continue; }
          const t = String(v);
          parts.push(k + '=' + (t.length > 40 ? t.slice(0, 40) + '…' : t));
        }
        return parts.join(' ');
      };
      const api = async (method, path, body, idem) => {
        const h = { ...headers };
        if (idem) h['Idempotency-Key'] = idem;
        const r = await fetchViaProxy(base + path, { method, headers: h, ...(body !== undefined ? { body } : {}), timeoutMs: 120000, label: '优云图片 ' + method });
        if (!r.ok) throw new Error(`优云图片 API ${method} ${path} HTTP ${r.status}：` + r.text.slice(0, 300));
        let j = null; try { j = JSON.parse(r.text); } catch { throw new Error(`优云图片 API ${method} ${path} 响应非 JSON：` + r.text.slice(0, 200)); }
        // 网关业务错误可能 HTTP 200：RetCode≠0 或 {type:'error'} 都算失败
        if ((j.RetCode != null && Number(j.RetCode) !== 0) || j.type === 'error') {
          throw new Error(`优云图片 API ${method} ${path} 失败：` + ((j.error && j.error.message) || j.Message || JSON.stringify(j).slice(0, 200))
            + (body ? '｜已发送参数：' + bodySummary(body) : ''));
        }
        return j;
      };
      // 参考图：三步上传换 asset_id（≤10 张，顺序生效；已登记过的资产直接复用）
      const referenceImages = [];
      for (const ref of (refs || []).slice(0, 10)) {
        const cached = ref.assetId ? compAssetIdCache.get(ref.assetId) : null;
        if (cached) { referenceImages.push({ asset_id: cached }); continue; }
        const meta = await imageBlobMeta(ref);
        const fileName = 'ref-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.' + meta.ext;
        const up = await api('POST', '/image/v1/upload_urls', { file_name: fileName, content_type: meta.mime, file_size: meta.blob.size });
        const put = await fetchViaProxy(up.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': meta.mime, Authorization: up.authorization, bucket: up.bucket, ufile_indicated_region: up.region },
          bodyRaw: arrayBufferToBase64(await meta.blob.arrayBuffer()),
          bodyContentType: meta.mime,
          timeoutMs: 180000,
          label: '参考图上传',
        });
        if (!put.ok) throw new Error('参考图上传失败 HTTP ' + put.status + '：' + put.text.slice(0, 200));
        // 登记：宽高必须与平台解析出的文件尺寸一致。浏览器解码尺寸与文件原始尺寸在
        // EXIF 旋转图上不同 → 先用解码尺寸，被拒（Params [Width/Height] not available）时用原始尺寸重试一次
        const regPayload = (w, h) => ({ object_key: up.object_key, file_name: fileName, content_type: meta.mime, file_size: meta.blob.size, width: w, height: h });
        let reg = null;
        try {
          reg = await api('POST', '/image/v1/assets', regPayload(meta.width, meta.height));
        } catch (e) {
          const msg = String((e && e.message) || e);
          const alt = meta.rawWidth && meta.rawHeight && (meta.rawWidth !== meta.width || meta.rawHeight !== meta.height);
          if (!/width\/?height/i.test(msg) || !alt) throw e;
          try {
            reg = await api('POST', '/image/v1/assets', regPayload(meta.rawWidth, meta.rawHeight));
            console.info('[infinite-canvas] 参考图登记改用文件原始尺寸成功：' + meta.rawWidth + '×' + meta.rawHeight);
          } catch (e2) {
            throw new Error(msg + '；改用文件原始尺寸 ' + meta.rawWidth + '×' + meta.rawHeight + ' 重试仍失败：' + ((e2 && e2.message) || e2));
          }
        }
        const aid = reg && reg.reference && reg.reference.asset_id;
        if (!aid) throw new Error('参考图登记失败：响应中没有 reference.asset_id');
        if (ref.assetId) compAssetIdCache.set(ref.assetId, aid);
        referenceImages.push({ asset_id: aid });
      }
      // 任务体：用户可变项透传（比例/清晰度原样发送，厂商不支持会明确报错）；文本任务不带模型字段（端点即 Qwen-Image）
      const body = {
        prompt,
        aspect_ratio: String(o.ratio || '1:1'),
        resolution: String(o.size || '1K'),
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
        ...(extra || {}),
      };
      const idem = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('idem-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
      const j1 = await api('POST', '/image/v1/tasks', body, idem);
      const tid = j1 && j1.task_id;
      if (!tid) throw new Error('优云图片任务创建失败：响应中没有 task_id');
      if (o.onTask) { try { o.onTask(tid, base + '/image/v1/tasks/' + encodeURIComponent(tid)); } catch { /* 忽略 */ } }
      const FINAL = { failed: 1, cancelled: 1, blocked: 1 };
      const deadline = Date.now() + 20 * 60 * 1000;
      for (;;) {
        await sleep(3000); // 官方推荐 3s 轮询
        if (genAborted()) {
          try { await api('POST', '/image/v1/tasks/' + encodeURIComponent(tid) + '/cancel', {}); } catch { /* 取消失败不影响中断（积分自动释放） */ }
          throw new Error(T('stoppedNote'));
        }
        const q = await api('GET', '/image/v1/tasks/' + encodeURIComponent(tid)).catch((e) => { console.warn('[infinite-canvas] 优云图片轮询失败（继续）:', String((e && e.message) || e)); return null; });
        if (!q || !q.task) continue;
        const st = String(q.task.status || '');
        if (st === 'succeeded') {
          if (!q.task.output_url) throw new Error('优云图片任务成功但没有 output_url');
          const dl = await fetchViaProxy(q.task.output_url, { method: 'GET', timeoutMs: 180000, label: '下载生成图片' });
          if (!dl.ok) throw new Error('下载生成图片失败 HTTP ' + dl.status);
          return dl.blob;
        }
        if (FINAL[st]) throw new Error('优云图片任务' + (st === 'blocked' ? '被审核拦截' : st) + '：' + (q.task.error_message || q.task.error_code || st));
        if (Date.now() > deadline) throw new Error('优云图片任务超过 20 分钟未完成（任务 id ' + tid + '，可凭 id 继续回查）');
      }
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
    /** 跨镜衔接标注（短剧分镜链式生成的行业标准做法）：图1=上一镜尾帧（仅用于衔接），
     *  图2..N=实体参考图（名称与 o.refNames 对齐）。Seedance 的 first_frame 与 reference_image 互斥，
     *  尾帧+参考图同连时尾帧降级为第一张衔接参考图，靠顺序+标注控制用途。 */
    function videoRefNote(refNames) {
      const names = (refNames || []).map((x) => String(x || '').trim()).filter(Boolean);
      const parts = ['【衔接硬约束】[图1] 是上一镜的尾帧：本镜视频的第 1 帧必须与 [图1] 画面一致，并从该画面自然延续——不得跳回远景、不得重新建立场景、不得切换机位'];
      names.forEach((nm, i) => { parts.push('[图' + (i + 2) + '] 为「' + nm + '」的参考图'); });
      parts.push('除 [图1] 用于衔接外，各实体外观须与对应参考图一致');
      return '（' + parts.join('；') + '）';
    }
    /** 火山方舟 Seedance 官方协议：创建任务 → 轮询 → 下载（支持首帧 + 最多 4 张参考图）。 */
    async function seedanceVideo(prompt, frameBlob, refs, s, opts) {
      if (!s.url) throw new Error('未配置视频 API');
      if (!s.model) throw new Error('请在设置里为该视频 API 填写模型名（Seedance 协议要求显式指定模型）');
      const headers = { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}) };
      const o = opts || {};
      // 端点归一化：配置里常填「基础地址」（裸域或 …/v1），此前直接 POST 到基础地址 → 404 Invalid URL。
      //  · 已带任务路径（contents/generations/tasks）→ 原样用（方舟官方）
      //  · 方舟官方域名 → 补官方任务路径
      //  · 其余（中转站/网关，如 api.relayrouter.ai/v1）→ 走 content[] 提交端点 /v1/video/generations + /v1/video/query 轮询
      let base = String(s.url).replace(/\/+$/, '');
      if (!/contents\/generations\/tasks$/.test(base)) {
        const host = base.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
        const isArkHost = /(^|\.)volces\.com$/.test(host) || /(^|\.)volcengineapi\.com$/.test(host) || /^ark\./.test(host);
        if (isArkHost) {
          base = base + '/api/v3/contents/generations/tasks';
        } else {
          const gw = /\/v1$/.test(base) ? base : base + '/v1';
          // 衔接说明前置（网关 content[] 路径不重复添加，由这里负责）
          const gwRefs = o.hardFrame ? [] : (o.refs || []).slice(0, 8);
          const gwText = (frameBlob && gwRefs.length) ? (videoRefNote(o.refNames) + '\n' + prompt) : prompt;
          return await relayVideoContentFallback(gw + '/video/generations', gwText, frameBlob, o, s, headers);
        }
      }
      // first_frame 与 reference_image 互斥（网关 400）。跨镜衔接（尾帧+参考图同连）→
      // 首帧降级为第一张衔接参考图：全部按 reference_image 传、提示词按序标注、比例不锁 adaptive
      const rawRefs = o.hardFrame ? [] : (refs || []).slice(0, 8);
      const downgrade = Boolean(frameBlob && rawRefs.length);
      const refBlobs = downgrade ? [frameBlob].concat(rawRefs) : rawRefs;
      let text = prompt;
      if (downgrade) {
        text = videoRefNote(o.refNames) + '\n' + text; // 前置硬约束：衔接要求放在最前，否则模型容易忽略
      } else if (refBlobs.length && !/\[图\d\]/.test(prompt)) {
        text += '\n（' + [...Array(refBlobs.length)].map((_, i) => '[图' + (i + 1) + ']').join('') + ' 为参考图，请保持其人物/场景/道具特征一致）';
      }
      const content = [{ type: 'text', text }];
      if (frameBlob && !downgrade) content.push({ type: 'image_url', image_url: { url: await blobToDataUrlScaled(frameBlob) }, role: 'first_frame' });
      for (const b of refBlobs) content.push({ type: 'image_url', image_url: { url: await blobToDataUrlScaled(b) }, role: 'reference_image' });
      const body = {
        model: s.model,
        content,
        duration: Number(o.duration) || 5,
        resolution: (o.resolution || '720P').toLowerCase(),
        watermark: s.watermark === true,
        // generate_audio 官方默认 true（2.5/2.0 系列）——仅在用户勾选时显式发送 true；不发送时用厂商默认，
        // 避免"未勾选就被静默静音"（透传原则：厂商默认优先）
        ...(s.generateAudio === true ? { generate_audio: true } : {}),
      };
      try { const extra = parseExtraParams(s.extra); if (extra) Object.assign(body, extra); } catch (e) { throw new Error('视频 API 扩展参数配置有误：' + ((e && e.message) || e)); }
      body.ratio = (frameBlob && !downgrade) ? 'adaptive' : (o.ratio || '16:9');
      const res = await fetchViaProxy(base, { headers, body, timeoutMs: Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 120000, label: 'Seedance 视频 API' });
      if (!res.ok) throw new Error('Seedance HTTP ' + res.status + '：' + res.text.slice(0, 300));
      const j = JSON.parse(res.text || '{}');
      const taskId = j && j.id;
      if (!taskId) throw new Error('Seedance 响应中没有任务 id');
      if (o.onTask) { try { o.onTask(taskId, base + '/' + taskId); } catch { /* 持久化失败不影响生成 */ } }
      const deadline = Date.now() + 120 * 60 * 1000; // 2 小时：视频任务含排队可能很久，查询层绝不先放弃
      while (Date.now() < deadline) {
        await sleep(10000);
        if (genAborted()) throw new Error(T('stoppedNote'));
        let r2 = null;
        try { r2 = await fetchViaProxy(base + '/' + taskId, { method: 'GET', headers, timeoutMs: 60000, label: '查询 Seedance 任务' }); } catch { /* 网络抖动重试 */ }
        if (!r2 || !r2.ok) continue; // 查询层任何失败（网关 5xx/429/断连）都不算任务失败——只等生成任务自身的终态
        let st = null;
        try { st = JSON.parse(r2.text || '{}'); } catch { continue; }
        if (st.status === 'succeeded') {
          const u = st.content && st.content.video_url;
          if (!u) throw new Error('Seedance 任务成功但未返回视频地址');
          return await downloadVideo(u, {});
        }
        if (['failed', 'expired', 'canceled', 'cancelled', 'error'].includes(st.status)) {
          throw new Error('Seedance 任务失败：' + ((st.error && st.error.message) || st.status));
        }
      }
      throw new Error('Seedance 任务超过 2 小时未返回（任务 id 已保存在节点上，可凭 id 回查结果）');
    }
    /** Seedance 原生 content[] 格式兜底（RelayRouter 等：POST /v1/video/generations {model, content, metadata}，
     *  轮询 GET /v1/video/query?task_id=...）。首帧/参考图角色与 Seedance 原生协议一致（图压缩内联）。 */
    async function relayVideoContentFallback(base, prompt, frameBlob, o, s, headers) {
      // 尾帧+参考图同连（跨镜衔接）→ 尾帧降级为第一张衔接参考图（first_frame/reference_image 互斥）
      const rawRefs = o.hardFrame ? [] : (o.refs || []).slice(0, 8);
      const downgrade = Boolean(frameBlob && rawRefs.length);
      const refBlobs = downgrade ? [frameBlob].concat(rawRefs) : rawRefs;
      // 注意：prompt 由调用方（apiVideo 通用路径）传入，downgrade 时的 videoRefNote 已在通用路径前置，这里不重复
      const text = prompt;
      const content = [{ type: 'text', text }];
      if (frameBlob && !downgrade) content.push({ type: 'image_url', image_url: { url: await blobToDataUrlScaled(frameBlob) }, role: 'first_frame' });
      for (const b of refBlobs) content.push({ type: 'image_url', image_url: { url: await blobToDataUrlScaled(b) }, role: 'reference_image' });
      const body = {
        model: s.model,
        content,
        metadata: {
          duration: Math.round(Number(o.duration)) || 5,
          ratio: o.ratio || '16:9',
          resolution: String(o.resolution || '720p').toLowerCase(),
        },
      };
      const r1 = await fetchViaProxy(base, { headers, body, timeoutMs: 120000, label: '视频 API(content)' });
      if (!r1.ok) throw new Error('HTTP ' + r1.status + '：' + r1.text.slice(0, 200));
      let j1 = null;
      try { j1 = JSON.parse(r1.text); } catch { /* 非 JSON */ }
      const taskId = extractTaskId(j1);
      if (!taskId) throw new Error('响应中没有任务 id：' + r1.text.slice(0, 200));
      let queryEp = '';
      try { queryEp = new URL(base).origin + '/v1/video/query'; } catch { throw new Error('无法构造轮询地址'); }
      if (o.onTask) { try { o.onTask(taskId, queryEp + '?task_id=' + encodeURIComponent(taskId)); } catch { /* 持久化失败不影响生成 */ } }
      const dlHeaders = (u) => { try { return new URL(u).origin === new URL(base).origin ? headers : {}; } catch { return {}; } };
      const deadline = Date.now() + 120 * 60 * 1000; // 2 小时：查询层绝不先放弃
      while (Date.now() < deadline) {
        await sleep(6000);
        if (genAborted()) throw new Error(T('stoppedNote'));
        let r2 = null;
        try { r2 = await fetchViaProxy(queryEp + '?task_id=' + encodeURIComponent(taskId), { method: 'GET', headers, timeoutMs: 60000, label: '查询视频任务' }); } catch { /* 网络抖动重试 */ }
        if (!r2 || !r2.ok) continue; // 查询层失败 ≠ 任务失败，只等生成任务自身的终态
        let st = null;
        try { st = JSON.parse(r2.text); } catch { /* 忽略 */ }
        const u = extractVideoUrl(st);
        if (u) return await downloadVideo(u, dlHeaders(u), headers);
        const failed = taskFailureOf(st);
        if (failed) throw new Error('视频任务失败：' + failed);
        const status = taskStatusOf(st);
        if (['failed', 'expired', 'canceled', 'cancelled', 'error'].includes(status)) throw new Error('视频任务失败：' + status);
      }
      throw new Error('视频生成超过 2 小时未返回（任务 id 已保存在节点上，可凭 id 回查结果）');
    }
    /** Sora 风格 /v1/videos 兜底（RelayRouter 等网关：/v1/video/generations 不接某些视频渠道时）。
     *  提交 POST {model, prompt, seconds, size} → 轮询 GET /v1/videos/{id} →
     *  完成后优先取响应里的地址，否则经 /content 端点（带鉴权）下载。
     *  注意：该格式暂不支持首帧注入——跨段连贯由提示词承接。 */
    async function soraVideosFallback(base, prompt, o, s, headers) {
      const root = base.replace(/\/v1\/video\/generations$/i, '').replace(/\/+$/, '');
      const ep = root + '/v1/videos';
      const secs = String(Math.round(Number(o.duration)) || 5);
      const vertical = (o.ratio || '16:9') === '9:16';
      const hd = String(o.resolution || '720p').toLowerCase().includes('1080');
      const size = hd ? (vertical ? '1080x1920' : '1920x1080') : (vertical ? '720x1280' : '1280x720');
      const body = { model: s.model, prompt, seconds: secs, size };
      const r1 = await fetchViaProxy(ep, { headers, body, timeoutMs: 120000, label: '视频 API(/v1/videos)' });
      if (!r1.ok) throw new Error('HTTP ' + r1.status + ' @ ' + ep + '：' + r1.text.slice(0, 200));
      let j1 = null;
      try { j1 = JSON.parse(r1.text); } catch { /* 非 JSON */ }
      const taskId = j1 && (j1.id || j1.task_id || (j1.data && j1.data[0] && j1.data[0].id));
      if (!taskId) throw new Error('/v1/videos 响应中没有任务 id：' + r1.text.slice(0, 200));
      if (o.onTask) { try { o.onTask(taskId, ep + '/' + taskId); } catch { /* 持久化失败不影响生成 */ } }
      const deadline = Date.now() + 120 * 60 * 1000; // 2 小时：查询层绝不先放弃
      while (Date.now() < deadline) {
        await sleep(6000);
        if (genAborted()) throw new Error(T('stoppedNote'));
        let r2 = null;
        try { r2 = await fetchViaProxy(ep + '/' + taskId, { method: 'GET', headers, timeoutMs: 60000, label: '查询视频任务' }); } catch { /* 网络抖动重试 */ }
        if (!r2 || !r2.ok) continue; // 查询层失败 ≠ 任务失败，只等生成任务自身的终态
        let st = null;
        try { st = JSON.parse(r2.text); } catch { /* 忽略 */ }
        const u = extractVideoUrl(st);
        if (u) return await downloadVideo(u, {}, headers);
        const failed = taskFailureOf(st);
        if (failed) throw new Error('视频任务失败：' + failed);
        const status = taskStatusOf(st);
        if (taskDoneOf(st)) return await downloadVideo(ep + '/' + taskId + '/content', {}, headers);
        if (['failed', 'expired', 'canceled', 'cancelled', 'error'].includes(status)) throw new Error('视频任务失败：' + status);
      }
      throw new Error('视频生成超过 2 小时未返回（任务 id 已保存在节点上，可凭 id 回查结果）');
    }
    // ============================================================
    // 视频厂商预设层：用户只配「厂商格式 + Base URL + 模型 id」，
    // 端点路径/鉴权方式/参数格式/轮询语义全部由代码按各家官方 API 适配。
    // ============================================================
    const VIDEO_VENDORS = {
      openai:    { label: 'OpenAI 兼容格式（通用/中转站）', note: '适配 /v1/video/generations、Seedance content[]、/v1/videos 三段自动降级' },
      seedance:  { label: '火山方舟 · Seedance（豆包视频）', base: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', keyPh: 'ARK API Key', note: 'Base URL 填方舟提交端点或 /api/v3 均可；模型 id 如 doubao-seedance-2-0-260128' },
      kling:     { label: '快手可灵 Kling', base: 'https://api.klingai.com', keyPh: 'AK:SK（冒号分隔）', note: 'Key 填 AK:SK，代码自动签 JWT；国际站把 Base URL 改为 api-singapore.klingai.com；时长按官方 5/10s 取整' },
      wan:       { label: '阿里通义万相 Wan（DashScope）', base: 'https://dashscope.aliyuncs.com', note: '异步任务制；国际站把 Base URL 改为 dashscope-intl.aliyuncs.com；图生视频走 img_url' },
      minimax:   { label: 'MiniMax 海螺视频（V1 协议）', base: 'https://api.minimaxi.com', note: '异步任务制；时长按官方 6/10s 取整；首帧图支持 base64' },
      minimaxv2: { label: 'MiniMax H3 · V2 协议（优云智算 / 官方）', base: 'https://cp.compshare.cn', keyPh: 'sk-ml-…', note: 'V2 协议自动适配：优云智算走 /minimax/v2，官方（api.minimax.io/.cn）走 /v2；content[] 多模态（首帧/尾帧/参考图≤9/视频≤3/音频≤3），原生音频，分辨率 480P/768P/1080P/2K/4K（大小写敏感），时长 4-30s；use_context_ir / mute_audio 等走扩展参数' },
      vidu:      { label: '生数科技 Vidu', base: 'https://api.vidu.com', note: '图片支持 base64；时长按官方 4/8s 取整' },
      runway:    { label: 'Runway Gen-4', base: 'https://api.dev.runwayml.com', note: '代码自动带 X-Runway-Version 头；时长 5/10s；首帧图支持 dataURL' },
      veo:       { label: 'Google Veo（Gemini API）', base: 'https://generativelanguage.googleapis.com', keyPh: 'API Key', note: '模型 id 如 veo-3.0-fast-generate-preview；图生视频走 inlineData base64' },
      luma:      { label: 'Luma Dream Machine', base: 'https://api.lumalabs.ai/dream-machine/v1', note: '图生视频需要公网图片 URL（本地图片仅支持文生视频）' },
      pixverse:  { label: 'PixVerse', base: 'https://app-api.pixverse.ai/openapi/v2', keyPh: 'API-KEY', note: '图片支持 base64；时长 5/8s；清晰度映射 540p/720p/1080p' },
      stability: { label: 'Stability AI 图生视频（已下线）', base: 'https://api.stability.ai', note: '⚠ 官方 API 已不再提供视频端点（2026 审计：现行 spec 0 条 video 路径）——保留适配器仅为历史配置，调用会报 404' },
    };
    /** 厂商 base URL 归一化：网关常把地址写成 …/v1 或 …/api/v1，直接拼接会变成 …/v1/v1/… 而 404。
     *  各厂商预设 base 本身都不以 /v1 结尾，所以安全地剥掉拖尾的 /v1、/api/v1。 */
    function vendorBase(raw, fallback) {
      let b = String(raw || fallback || '').trim().replace(/\/+$/, '');
      b = b.replace(/\/(api\/)?v1$/i, '');
      return b;
    }
    /** 已知网关的厂商路径前缀：网关把各厂商 API 挂在各自前缀下（如 RelayRouter 的百炼 = /alibailian）。
     *  不在表里的网关，把前缀直接写进 Base URL 即可（如 https://gw.example.com/alibailian）。 */
    const KNOWN_GATEWAY_PREFIX = [
      { host: /(^|\.)relayrouter\.ai$/i, wan: '/alibailian' },
    ];
    function gatewayPrefixFor(hostname, vendor) {
      const h = String(hostname || '').toLowerCase();
      for (const g of KNOWN_GATEWAY_PREFIX) { if (g.host.test(h)) return g[vendor] || ''; }
      return '';
    }
    /** 万相（DashScope/百炼）端点推导。兼容四种写法：
     *  1) 官方域名 https://dashscope.aliyuncs.com            → /api/v1/services/...
     *  2) 网关裸域 https://api.relayrouter.ai               → 自动补厂商前缀 /alibailian
     *  3) 网关带前缀 https://api.relayrouter.ai/alibailian  → 前缀原样保留
     *  4) 直接粘贴完整端点 …/…/video-synthesis              → 反推前缀
     *  另外统一剥掉误写的拖尾 /v1、/api/v1。返回 { apiRoot, submitUrl, taskUrl }。 */
    function wanEndpoints(rawUrl) {
      const u = new URL(String(rawUrl).trim());
      let path = u.pathname.replace(/\/+$/, '');
      const full = /\/api\/v1\/services\/aigc\/video-generation\/video-synthesis$/.exec(path);
      if (full) path = path.slice(0, full.index); // 完整端点 → 取其前缀部分
      else path = path.replace(/\/(api\/)?v1$/i, ''); // 误带 /v1 或 /api/v1 → 剥掉
      if (!path) path = gatewayPrefixFor(u.hostname, 'wan'); // 裸域：已知网关自动补厂商前缀
      const apiRoot = u.origin + path;
      return {
        apiRoot,
        submitUrl: apiRoot + '/api/v1/services/aigc/video-generation/video-synthesis',
        taskUrl: (tid) => apiRoot + '/api/v1/tasks/' + encodeURIComponent(tid),
      };
    }
    /** 读取生成视频的真实尺寸与时长（用于「厂商是否忽略了参数」的可见校验）。 */
    function probeVideoMeta(blob) {
      return new Promise((resolve) => {
        let url = '';
        try {
          url = URL.createObjectURL(blob);
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.muted = true;
          const done = (r) => { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } resolve(r); };
          v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
          v.onerror = () => done(null);
          setTimeout(() => done(null), 10000);
          v.src = url;
        } catch { resolve(null); }
      });
    }
    /** 扩展参数透传（所有厂商 runner 通用）：顶层字段直接覆盖 body；
     *  若 body.parameters 存在则深合并；不存在时若扩展参数里带了 parameters 则整体挂上。
     *  这是厂商/网关参数名不一致时的统一逃生舱。 */
    function mergeExtra(body, s) {
      try {
        const ex = parseExtraParams(s && s.extra);
        if (!ex) return body;
        const exParams = ex.parameters;
        Object.assign(body, ex);
        if (exParams && typeof exParams === 'object') body.parameters = { ...(body.parameters || {}), ...exParams };
      } catch (e) { throw new Error('扩展参数配置有误：' + ((e && e.message) || e)); }
      return body;
    }
    function detectVideoVendor(s) {
      if (!s) return 'openai';
      if (s.vendor) return s.vendor;
      const url = String(s.url || '').toLowerCase();
      const model = String(s.model || '').toLowerCase();
      // 模型名优先：第三方网关（relayrouter 等）的 URL 看不出真实厂商，只有模型名能说明
      if (/wanx|万相|(^|[^a-z])wan(\d|[-_]\d|x)/.test(model)) return 'wan';
      if (/minimax-?h3|hailuo-?03/.test(model)) return 'minimaxv2'; // H3 走 V2 协议（必须先于 V1 minimax 判定）
      if (/(^|[^a-z])kling/.test(model)) return 'kling';
      if (/minimax|hailuo/.test(model)) return 'minimax';
      if (/vidu/.test(model)) return 'vidu';
      if (/runway/.test(model)) return 'runway';
      if (/(^|[^a-z])veo/.test(model)) return 'veo';
      if (/luma|ray[-_]?[12]/.test(model)) return 'luma';
      if (/pixverse/.test(model)) return 'pixverse';
      if (/stable-?video|(^|[^a-z])svd/.test(model)) return 'stability';
      if (/seedance/.test(model)) return 'seedance';
      // URL 兜底识别
      if (url.includes('dashscope')) return 'wan';
      if (url.includes('klingai')) return 'kling';
      if (url.includes('minimax')) return 'minimax';
      if (url.includes('vidu')) return 'vidu';
      if (url.includes('runway')) return 'runway';
      if (url.includes('generativelanguage')) return 'veo';
      if (url.includes('lumalabs')) return 'luma';
      if (url.includes('pixverse')) return 'pixverse';
      if (url.includes('stability')) return 'stability';
      if (s.protocol === 'seedance' || url.includes('contents/generations/tasks')) return 'seedance';
      return 'openai';
    }
    function b64Pure(blob) {      return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] || '');
        r.onerror = () => rej(new Error('图片编码失败'));
        r.readAsDataURL(blob);
      });
    }
    /** 厂商任务轮询：查询层任何失败（网络/5xx）都不判死——只认任务自身的终态；2 小时兜底。 */
    async function vendorPoll(label, step, query) {
      const deadline = Date.now() + 120 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(step);
        if (genAborted()) throw new Error(T('stoppedNote'));
        let r = null;
        try { r = await query(); } catch { continue; }
        if (!r) continue;
        if (r.state === 'done') return r.url;
        if (r.state === 'fail') throw new Error(label + '任务失败：' + (r.error || '未知原因'));
      }
      throw new Error(label + '超过 2 小时未返回（任务 id 已保存在节点上，可凭 id 回查结果）');
    }
    const VIDEO_VENDOR_RUNNERS = {
      // —— 快手可灵 Kling：JWT(AK:SK) 鉴权，i2v/t2v，轮询 task_id ——
      async kling(prompt, frameBlob, s, o) {
        const [ak, sk] = String(s.apiKey || '').split(':');
        if (!ak || !sk) throw new Error('可灵的 Key 请填 AK:SK（冒号分隔，在可灵开放平台获取）');
        const enc = new TextEncoder();
        const b64u = (u8) => btoa(String.fromCharCode.apply(null, u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const hj = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
        const now = Math.floor(Date.now() / 1000);
        const pj = b64u(enc.encode(JSON.stringify({ iss: ak, exp: now + 1800, nbf: now - 5 })));
        const key = await crypto.subtle.importKey('raw', enc.encode(sk), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sg = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(hj + '.' + pj))));
        const jwt = hj + '.' + pj + '.' + sg;
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt };
        const base = vendorBase(s.url, VIDEO_VENDORS.kling.base);
        const path = frameBlob ? 'image2video' : 'text2video';
        const body = {
          model_name: s.model || 'kling-v2-6', prompt,
          mode: 'std', // cfg_scale 仅 v1.x 支持（官方 SDK 注明 v2.x 不支持）→ 不默认发送，需要时走扩展参数
          ...(frameBlob ? {} : { aspect_ratio: (o.ratio || '16:9') === '9:16' ? '9:16' : (o.ratio || '16:9') === '1:1' ? '1:1' : '16:9' }),
          duration: String(Math.round(Number(o.duration)) || 5),
        };
        if (frameBlob) body.image = await blobToDataUrlScaled(frameBlob);
        mergeExtra(body, s);
        // 端点单复数兼容：2026 起新版官方 provider 用 /v1/videos/*，旧文档为单数 /v1/video/* —— 404 自动回退
        let r1 = await fetchViaProxy(base + '/v1/videos/' + path, { headers, body, label: 'Kling 提交' });
        if (r1.status === 404) r1 = await fetchViaProxy(base + '/v1/video/' + path, { headers, body, label: 'Kling 提交(旧端点)' });
        if (!r1.ok) throw new Error('Kling 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        const j1 = JSON.parse(r1.text || '{}');
        const tid = j1 && j1.data && j1.data.task_id;
        if (!tid) throw new Error('Kling 响应中没有 task_id：' + r1.text.slice(0, 200));
        const url = await vendorPoll('Kling', 8000, async () => {
          let r = await fetchViaProxy(base + '/v1/videos/' + path + '/' + tid, { method: 'GET', headers, timeoutMs: 60000, label: 'Kling 查询' });
          if (r && r.status === 404) r = await fetchViaProxy(base + '/v1/video/' + path + '/' + tid, { method: 'GET', headers, timeoutMs: 60000, label: 'Kling 查询(旧端点)' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          const st = j && j.data && j.data.task_status;
          if (st === 'succeed') {
            // 官方结果字段：data.task_result.videos[]（含 url/watermark_url/duration）；旧网关可能是 data.result.videos
            const v = (j.data.task_result && j.data.task_result.videos && j.data.task_result.videos[0])
              || (j.data.result && j.data.result.videos && j.data.result.videos[0]);
            return v && v.url ? { state: 'done', url: v.url } : { state: 'fail', error: '成功但无视频地址' };
          }
          if (st === 'failed') return { state: 'fail', error: (j.data && j.data.task_status_msg) || st };
          return { state: 'wait' };
        });
        return await downloadVideo(url, {});
      },
      // —— 阿里通义万相 Wan：DashScope 异步，X-DashScope-Async ——
      async wan(prompt, frameBlob, s, o) {
        // 端点推导（官方域名 / 网关裸域 / 网关带厂商前缀 / 完整端点 四种写法都支持）
        let ep;
        try { ep = wanEndpoints(String(s.url || VIDEO_VENDORS.wan.base)); } catch { throw new Error('万相视频 API 地址无效：' + String(s.url || '')); }
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.apiKey || ''), 'X-DashScope-Async': 'enable' };
        // 万相 3.0 官方参数（百炼文档）：parameters = { resolution: 1080P/720P/480P, ratio: adaptive/21:9/16:9/4:3/1:1/3:4/9:16,
        //   duration: [2,30], audio, seed, prompt_extend, watermark } —— **没有 size 参数**（那是 2.x 旧版的）。
        //  · 用户可变项（透传，不转换）：resolution / ratio / duration —— 节点上设什么发什么
        //  · 稳定默认（总是发送）：watermark:false 去水印优先、prompt_extend:true 提示词扩展
        //  · 媒体走 input.media[]：first_frame（≤1）/ reference_image（≤10），支持 Base64；首帧与参考图同传时
        //    首帧降级为首张参考图（与网关组合限制对齐，衔接说明前置）
        const rawRefs = o.hardFrame ? [] : (o.refs || []).slice(0, 10);
        let text = prompt;
        if (frameBlob && rawRefs.length) text = videoRefNote(o.refNames) + '\n' + prompt;
        const media = [];
        if (frameBlob) media.push({ type: rawRefs.length ? 'reference_image' : 'first_frame', url: await blobToDataUrlScaled(frameBlob) });
        for (const b of rawRefs) media.push({ type: 'reference_image', url: await blobToDataUrlScaled(b) });
        const body = {
          model: s.model || 'wan3.0-video',
          input: { prompt: text, ...(media.length ? { media } : {}) },
          parameters: {
            resolution: String(o.resolution || '1080P'),
            ratio: o.ratio || '16:9',
            duration: Math.round(Number(o.duration)) || 5,
            watermark: false,
            prompt_extend: true,
          },
        };
        // 扩展参数：厂商/网关参数名不一致时的逃生舱（顶层字段直接覆盖，parameters 内做深合并）
        // 例：{"parameters":{"audio":false}} 或 {"parameters":{"seed":42}}
        try {
          const ex = parseExtraParams(s.extra);
          if (ex) {
            const exParams = ex.parameters;
            Object.assign(body, ex);
            if (exParams && typeof exParams === 'object') body.parameters = { ...body.parameters, ...exParams };
          }
        } catch (e) { throw new Error('万相扩展参数配置有误：' + ((e && e.message) || e)); }
        const r1 = await fetchViaProxy(ep.submitUrl, { headers, body, label: 'Wan 提交' });
        if (!r1.ok) throw new Error('Wan 提交 HTTP ' + r1.status + ' @ ' + ep.submitUrl + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('Wan 响应非 JSON：' + r1.text.slice(0, 200)); }
        const tid = j1 && j1.output && j1.output.task_id;
        if (!tid) throw new Error('Wan 响应中没有 task_id：' + r1.text.slice(0, 200));
        if (o.onTask) { try { o.onTask(tid, ep.taskUrl(tid)); } catch { /* 持久化失败不影响生成 */ } }
        const url = await vendorPoll('Wan', 8000, async () => {
          const r = await fetchViaProxy(ep.taskUrl(tid), { method: 'GET', headers: { Authorization: 'Bearer ' + (s.apiKey || '') }, timeoutMs: 60000, label: 'Wan 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          const st = j && j.output && j.output.task_status;
          if (st === 'SUCCEEDED') return j.output.video_url ? { state: 'done', url: j.output.video_url } : { state: 'fail', error: '成功但无视频地址' };
          if (st === 'FAILED' || st === 'CANCELED') return { state: 'fail', error: (j.output && j.output.message) || st };
          return { state: 'wait' };
        });
        return await downloadVideo(url, {});
      },
      // —— MiniMax 海螺：异步 task_id + query 接口 ——
      async minimax(prompt, frameBlob, s, o) {
        const base = vendorBase(s.url, VIDEO_VENDORS.minimax.base);
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.apiKey || '') };
        const body = {
          model: s.model || 'MiniMax-Hailuo-02', prompt,
          duration: Math.round(Number(o.duration)) || 6, // 官方为整数（2.3/02 在 768P 下 6 或 10，1080P 仅 6）
          resolution: String(o.resolution || '768P'), // 透传（官方枚举 512P/720P/768P/1080P，按模型×时长受限）
        };
        if (frameBlob) body.first_frame_image = await blobToDataUrlScaled(frameBlob);
        mergeExtra(body, s);
        const r1 = await fetchViaProxy(base + '/v1/video_generation', { headers, body, label: 'MiniMax 提交' });
        if (!r1.ok) throw new Error('MiniMax 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('MiniMax 响应非 JSON'); }
        const tid = j1 && (j1.task_id || (j1.data && j1.data.task_id));
        if (!tid) throw new Error('MiniMax 响应中没有 task_id：' + r1.text.slice(0, 200));
        const url = await vendorPoll('MiniMax', 8000, async () => {
          const r = await fetchViaProxy(base + '/v1/query/video_generation?task_id=' + encodeURIComponent(tid), { method: 'GET', headers, timeoutMs: 60000, label: 'MiniMax 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          const st = String(j.status || '').toLowerCase();
          if (st === 'success' || st === 'file_downloaded') {
            // 官方两步：任务成功先得 file_id，再经 /v1/files/retrieve 换 download_url（1 小时时效）
            const fid = j.file_id || (j.file && j.file.file_id);
            if (!fid) return { state: 'fail', error: '成功但响应中没有 file_id' };
            const fr = await fetchViaProxy(base + '/v1/files/retrieve?file_id=' + encodeURIComponent(fid), { method: 'GET', headers, timeoutMs: 60000, label: 'MiniMax 取文件' });
            if (!fr || !fr.ok) return { state: 'fail', error: '取文件信息 HTTP ' + (fr ? fr.status : '无响应') };
            let fj = null; try { fj = JSON.parse(fr.text); } catch { return { state: 'fail', error: '文件信息非 JSON' }; }
            const u = fj && fj.file && (fj.file.download_url || fj.file.url);
            return u ? { state: 'done', url: u } : { state: 'fail', error: '成功但无视频下载地址' };
          }
          if (st === 'fail') return { state: 'fail', error: (j.base_resp && j.base_resp.status_msg) || '失败' };
          return { state: 'wait' };
        });
        return await downloadVideo(url, {});
      },
      // —— MiniMax H3 · V2 协议（优云智算 /minimax/v2，官方 api.minimax.io|api.minimaxi.com /v2）：
      //    content[] 多模态自动路由（文生/首尾帧/参考素材），原生音频，分辨率大小写敏感 ——
      async minimaxv2(prompt, frameBlob, s, o) {
        const base = vendorBase(s.url, VIDEO_VENDORS.minimaxv2.base);
        const ex = (() => { try { return parseExtraParams(s.extra) || {}; } catch (e) { throw new Error('扩展参数配置有误：' + ((e && e.message) || e)); } })();
        // 路径风格：优云智算网关挂 /minimax/v2/...，MiniMax 官方裸 /v2/...；扩展参数 pathPrefix 可显式覆盖
        const prefix = String(ex.pathPrefix || (/compshare/i.test(base) ? '/minimax' : ''));
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + String(s.apiKey || '').trim() };
        // 分辨率大小写敏感（480P/768P/1080P/2K/4K）：画布的 720P 语义等同原生 768P，显式映射不依赖厂商静默降级
        const RESO = { '480P': '480P', '720P': '768P', '768P': '768P', '1080P': '1080P', '2K': '2K', '4K': '4K' };
        const resolution = String(ex.resolution || RESO[String(o.resolution || '').toUpperCase()] || '768P');
        // content[] 组装：H3 规则——首尾帧与参考素材不可混用；参考音频不能独立使用（必须伴随图/视频）
        const refs = o.hardFrame ? [] : (o.refs || []).slice(0, 9);
        const auds = (o.audioRefs || []).slice(0, 3);
        const refMode = refs.length > 0 || auds.length > 0; // 有参考素材（含音频）→ 全部走参考模式
        const content = [{ type: 'text', text: prompt }];
        if (frameBlob && !refMode) {
          content.push({ type: 'image_url', image_url: { url: await blobToDataUrlScaled(frameBlob) }, role: 'first_frame' });
        } else {
          if (frameBlob) content[0].text = videoRefNote(o.refNames) + '\n' + prompt; // 首帧降级为首张参考图，衔接标注前置
          if (frameBlob) content.push({ type: 'image_url', image_url: { url: await blobToDataUrlScaled(frameBlob) }, role: 'reference_image' });
          for (const b of refs.slice(0, refMode && frameBlob ? 8 : 9)) content.push({ type: 'image_url', image_url: { url: await blobToDataUrlScaled(b) }, role: 'reference_image' });
          for (const b of auds) content.push({ type: 'audio_url', audio_url: { url: await blobToDataUrl(b) }, role: 'reference_audio' }); // 音色对齐（原生音画联合）
        }
        const body = {
          model: s.model || 'MiniMax-H3',
          content,
          resolution,
          duration: Math.round(Number(o.duration)) || 5, // 官方 4-30s 整数（优云智算扩展上限 30）
          ratio: (frameBlob && !refMode) ? 'adaptive' : (o.ratio || '16:9'), // 纯首帧模式比例跟随素材；其余用节点比例
          aigc_watermark: false, // 稳定默认：不加 AIGC 水印
        };
        // 扩展参数透传：use_context_ir / skill_id / mute_audio / pathPrefix / resolution 覆盖等
        for (const k of ['use_context_ir', 'skill_id', 'mute_audio', 'pathPrefix', 'resolution', 'callback_url', 'callback_token']) { if (ex[k] !== undefined) body[k] = ex[k]; }
        const r1 = await fetchViaProxy(base + prefix + '/v2/video_generation', { headers, body, label: 'H3 提交' });
        if (!r1.ok) throw new Error('H3 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('H3 响应非 JSON：' + r1.text.slice(0, 200)); }
        const tid = j1 && (j1.task_id || (j1.data && j1.data.task_id));
        if (!tid) throw new Error('H3 响应中没有 task_id：' + r1.text.slice(0, 200));
        if (o.onTask) { try { o.onTask(tid, base + prefix + '/v2/query/video_generation/' + encodeURIComponent(tid)); } catch { /* 持久化失败不影响生成 */ } }
        const url = await vendorPoll('H3', 8000, async () => {
          const r = await fetchViaProxy(base + prefix + '/v2/query/video_generation/' + encodeURIComponent(tid), { method: 'GET', headers, timeoutMs: 60000, label: 'H3 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          const t = (j && j.task) || j;
          const st = String((t && t.status) || '').toLowerCase();
          if (st === 'succeeded') {
            const u = t && t.content && t.content.url;
            return u ? { state: 'done', url: u } : { state: 'fail', error: '成功但响应中没有 content.url' };
          }
          if (st === 'failed') return { state: 'fail', error: (t && t.error && (t.error.message || t.error.code)) || '失败' };
          if (st === 'cancelled' || st === 'expired') return { state: 'fail', error: '任务' + st };
          return { state: 'wait' };
        });
        return await downloadVideo(url, {});
      },
      // —— 生数 Vidu：img2video/text2video，图片 base64 直传 ——
      async vidu(prompt, frameBlob, s, o) {
        const base = vendorBase(s.url, VIDEO_VENDORS.vidu.base);
        const headers = { 'Content-Type': 'application/json', Authorization: 'Token ' + (s.apiKey || '') };
        const path = frameBlob ? 'img2video' : 'text2video';
        const body = {
          model: s.model || 'viduq3-pro', prompt,
          duration: Math.round(Number(o.duration)) || 5,
          resolution: String(o.resolution || '720p').toLowerCase(), // 官方枚举 540p/720p/1080p（Q4 另有 2K/4K）
          ...(frameBlob ? {} : { aspect_ratio: o.ratio || '16:9' }), // aspect_ratio 仅文生视频有（i2v 比例跟随首帧图）
        };
        if (frameBlob) body.images = [await blobToDataUrlScaled(frameBlob)]; // images 数组：URL 或 data:base64（首尾帧时传 2 张）
        mergeExtra(body, s);
        const r1 = await fetchViaProxy(base + '/ent/v2/' + path, { headers, body, label: 'Vidu 提交' });
        if (!r1.ok) throw new Error('Vidu 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('Vidu 响应非 JSON'); }
        const tid = j1 && (j1.task_id || j1.id);
        if (!tid) throw new Error('Vidu 响应中没有 task_id：' + r1.text.slice(0, 200));
        const url = await vendorPoll('Vidu', 8000, async () => {
          const r = await fetchViaProxy(base + '/ent/v2/tasks/' + tid + '/creations', { method: 'GET', headers, timeoutMs: 60000, label: 'Vidu 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          const st = String(j.state || '').toLowerCase();
          if (st === 'success') {
            // 官方结果：creations[].url（24 小时时效，需转存）
            const vids = (Array.isArray(j.creations) && j.creations) || (j.resp && (j.resp.videos || j.resp.creations)) || [];
            const v = vids[0] || {};
            const u = v.url || v.video_url;
            return u ? { state: 'done', url: u } : { state: 'fail', error: '成功但无视频地址' };
          }
          if (st === 'failed') return { state: 'fail', error: j.err_msg || ('err_code ' + j.err_code) || '失败' };
          return { state: 'wait' };
        });
        return await downloadVideo(url, {});
      },
      // —— Runway Gen-4：X-Runway-Version 头，tasks 轮询 ——
      async runway(prompt, frameBlob, s, o) {
        const base = vendorBase(s.url, VIDEO_VENDORS.runway.base);
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.apiKey || ''), 'X-Runway-Version': '2024-11-06' };
        const ratio = (o.ratio || '16:9') === '9:16' ? '720:1280' : '1280:720';
        const dur = Math.round(Number(o.duration)) || 5;
        let ep = '/v1/text_to_video', body = { model: s.model || 'gen4.5', promptText: prompt, ratio, duration: dur };
        if (frameBlob) { ep = '/v1/image_to_video'; body = { model: s.model || 'gen4_turbo', promptImage: await blobToDataUrlScaled(frameBlob), promptText: prompt, ratio, duration: dur }; }
        mergeExtra(body, s);
        const r1 = await fetchViaProxy(base + ep, { headers, body, label: 'Runway 提交' });
        if (!r1.ok) throw new Error('Runway 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('Runway 响应非 JSON'); }
        const tid = j1 && j1.id;
        if (!tid) throw new Error('Runway 响应中没有任务 id：' + r1.text.slice(0, 200));
        const url = await vendorPoll('Runway', 8000, async () => {
          const r = await fetchViaProxy(base + '/v1/tasks/' + tid, { method: 'GET', headers, timeoutMs: 60000, label: 'Runway 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          if (j.status === 'SUCCEEDED') return (j.output && j.output[0]) ? { state: 'done', url: j.output[0] } : { state: 'fail', error: '成功但无视频地址' };
          if (j.status === 'FAILED') return { state: 'fail', error: j.failure || j.status };
          return { state: 'wait' };
        });
        return await downloadVideo(url, {});
      },
      // —— Google Veo（Gemini API）：predictLongRunning + operation 轮询 ——
      async veo(prompt, frameBlob, s, o) {
        const base = vendorBase(s.url, VIDEO_VENDORS.veo.base);
        const model = s.model || 'veo-3.1-generate-preview';
        const ep = base + '/v1beta/models/' + encodeURIComponent(model) + ':predictLongRunning?key=' + encodeURIComponent(s.apiKey || '');
        const inst = { prompt };
        if (frameBlob) inst.image = { bytesBase64Encoded: await b64Pure(await blobToDataUrlScaled(frameBlob)), mimeType: 'image/png' };
        // 官方字段（Gemini API SDK）：parameters.{aspectRatio(16:9|9:16), durationSeconds(int), resolution(720p|1080p)}
        const body = { instances: [inst], parameters: {
          aspectRatio: (o.ratio || '16:9') === '9:16' ? '9:16' : '16:9',
          durationSeconds: Math.round(Number(o.duration)) || 5,
          ...(o.resolution ? { resolution: String(o.resolution).toLowerCase() } : {}),
        } };
        mergeExtra(body, s);
        const r1 = await fetchViaProxy(ep, { headers: { 'Content-Type': 'application/json' }, body, label: 'Veo 提交' });
        if (!r1.ok) throw new Error('Veo 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('Veo 响应非 JSON'); }
        const op = j1 && j1.name;
        if (!op) throw new Error('Veo 响应中没有 operation name：' + r1.text.slice(0, 200));
        const url = await vendorPoll('Veo', 10000, async () => {
          const r = await fetchViaProxy(base + '/v1beta/' + op + '?key=' + encodeURIComponent(s.apiKey || ''), { method: 'GET', timeoutMs: 60000, label: 'Veo 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          if (!j.done) return { state: 'wait' };
          if (j.error) return { state: 'fail', error: j.error.message || '失败' };
          const g = j.response && (j.response.generateVideoResponse || j.response);
          const sample = g && ((g.generatedSamples && g.generatedSamples[0]) || (g.videos && g.videos[0]));
          const u = sample && (sample.video ? sample.video.uri : sample.uri);
          return u ? { state: 'done', url: u + (u.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(s.apiKey || '') } : { state: 'fail', error: '成功但无视频地址' };
        });
        return await downloadVideo(url, {});
      },
      // —— Luma Dream Machine：图片需公网 URL，本地图片仅文生视频 ——
      async luma(prompt, frameBlob, s, o) {
        // Luma 的 base 本身以 /v1 结尾（路径只拼 /generations），不能用 vendorBase 剥掉 → 这里改为「保证以 /v1 结尾」
        let base = String(s.url || VIDEO_VENDORS.luma.base).trim().replace(/\/+$/, '');
        if (!/\/v1$/i.test(base)) base = base + '/v1';
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.apiKey || '') };
        const body = { prompt, model: s.model || 'ray-2',
          resolution: String(o.resolution || '720p').toLowerCase(), // 官方枚举 540p/720p/1080p/4k
          duration: (Math.round(Number(o.duration)) || 5) + 's', // 官方为字符串 "5s"/"9s"
          aspect_ratio: o.ratio || '16:9' }; // 官方枚举 1:1/16:9/9:16/4:3/3:4/21:9/9:21
        if (frameBlob) throw new Error('Luma 图生视频需要公网图片 URL——本地图片请改用文生视频，或换其他厂商');
        mergeExtra(body, s);
        const r1 = await fetchViaProxy(base + '/generations', { headers, body, label: 'Luma 提交' });
        if (!r1.ok) throw new Error('Luma 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('Luma 响应非 JSON'); }
        const tid = j1 && j1.id;
        if (!tid) throw new Error('Luma 响应中没有任务 id：' + r1.text.slice(0, 200));
        const url = await vendorPoll('Luma', 8000, async () => {
          const r = await fetchViaProxy(base + '/generations/' + tid, { method: 'GET', headers, timeoutMs: 60000, label: 'Luma 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          if (j.state === 'completed') return (j.assets && j.assets.video) ? { state: 'done', url: j.assets.video } : { state: 'fail', error: '成功但无视频地址' };
          if (j.state === 'failed') return { state: 'fail', error: j.failure_reason || '失败' };
          return { state: 'wait' };
        });
        return await downloadVideo(url, {});
      },
      // —— PixVerse：API-KEY 头 + Ai-trace-id，base64 图片 ——
      async pixverse(prompt, frameBlob, s, o) {
        const base = vendorBase(s.url, VIDEO_VENDORS.pixverse.base);
        const headers = { 'Content-Type': 'application/json', 'API-KEY': s.apiKey || '', 'Ai-trace-id': 'dshic-' + Date.now().toString(36) };
        // 官方端点（Apidog 文档）：文生 /video/text/generate、图生 /video/img/generate（旧 /video/text2video 已弃用）
        const path = frameBlob ? 'img/generate' : 'text/generate';
        // 图生视频的图片必须是 img_id（整数）——先用 multipart 上传拿 id（官方不收 base64/URL 字段）
        let imgId = null;
        if (frameBlob) {
          const fd = new FormData();
          fd.append('image', frameBlob, 'frame.png');
          const ser = new Response(fd);
          const up = await fetchViaProxy(base + '/openapi/v2/image/upload', { headers: { 'API-KEY': headers['API-KEY'], 'Ai-trace-id': headers['Ai-trace-id'] }, bodyRaw: arrayBufferToBase64(await ser.arrayBuffer()), bodyContentType: ser.headers.get('content-type'), label: 'PixVerse 上传图片' });
          if (!up || !up.ok) throw new Error('PixVerse 上传图片 HTTP ' + (up ? up.status : '无响应') + '：' + (up ? up.text.slice(0, 200) : ''));
          let uj = null; try { uj = JSON.parse(up.text); } catch { throw new Error('PixVerse 上传响应非 JSON'); }
          imgId = uj && uj.Resp && uj.Resp.img_id;
          if (!imgId) throw new Error('PixVerse 上传响应中没有 img_id：' + up.text.slice(0, 200));
        }
        const body = {
          model: s.model || 'v6', prompt,
          duration: Math.round(Number(o.duration)) || 5, // C1/V6: 1-15 任意整数；v5.5/v5.6 仅 5/8/10
          quality: String(o.resolution || '720p').toLowerCase(), // 官方枚举 360p/540p/720p/1080p
          ...(frameBlob ? {} : { aspect_ratio: (o.ratio || '16:9') === '9:16' ? '9:16' : '16:9' }), // aspect_ratio 仅文生视频有（i2v 跟随输入图）
        };
        if (frameBlob) body.img_id = imgId;
        mergeExtra(body, s);
        const r1 = await fetchViaProxy(base + '/openapi/v2/video/' + path, { headers, body, label: 'PixVerse 提交' });
        if (!r1.ok) throw new Error('PixVerse 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('PixVerse 响应非 JSON'); }
        const vid = j1 && j1.Resp && j1.Resp.video_id;
        if (!vid) throw new Error('PixVerse 响应中没有 video_id：' + r1.text.slice(0, 200));
        const url = await vendorPoll('PixVerse', 8000, async () => {
          const r = await fetchViaProxy(base + '/video/result/' + vid, { method: 'GET', headers, timeoutMs: 60000, label: 'PixVerse 查询' });
          if (!r || !r.ok) return { state: 'wait' };
          let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'wait' }; }
          const resp = j && j.Resp;
          if (!resp) return { state: 'wait' };
          // 官方状态语义（现行文档）：1=完成（Resp.url 可用）；5=生成中、9=排队、10=处理中；7=审核失败、8=失败（6=已删除）
          if (resp.status === 1 && resp.url) return { state: 'done', url: resp.url };
          if (resp.status === 7 || resp.status === 8) return { state: 'fail', error: resp.msg || ('status ' + resp.status) };
          return { state: 'wait' }; // 5/9/10（历史 2/3）= 排队/处理中
        });
        return await downloadVideo(url, {});
      },
      // —— Stability AI：SVD 纯图生视频（multipart，无提示词），结果为 base64 JSON ——
      async stability(prompt, frameBlob, s, o) {
        const base = vendorBase(s.url, VIDEO_VENDORS.stability.base);
        if (!frameBlob) throw new Error('Stability 图生视频必须有首帧图（该服务不支持纯文生视频、无提示词输入）');
        const fd = new FormData();
        fd.append('image', frameBlob, 'frame.png');
        fd.append('cfg_scale', '1.8');
        fd.append('motion_bucket_id', '127');
        const serialized = new Response(fd);
        const bodyRaw = arrayBufferToBase64(await serialized.arrayBuffer());
        const r1 = await fetchViaProxy(base + '/v2beta/image-to-video', { method: 'POST', headers: { Authorization: 'Bearer ' + (s.apiKey || '') }, bodyRaw, bodyContentType: serialized.headers.get('content-type'), label: 'Stability 提交' });
        if (!r1.ok) throw new Error('Stability 提交 HTTP ' + r1.status + '：' + r1.text.slice(0, 300));
        let j1 = null; try { j1 = JSON.parse(r1.text); } catch { throw new Error('Stability 响应非 JSON'); }
        const tid = j1 && j1.id;
        if (!tid) throw new Error('Stability 响应中没有任务 id：' + r1.text.slice(0, 200));
        const url = await vendorPoll('Stability', 10000, async () => {
          const r = await fetchViaProxy(base + '/v2beta/image-to-video/result/' + tid, { method: 'GET', headers: { Authorization: 'Bearer ' + (s.apiKey || ''), Accept: 'video/*' }, timeoutMs: 120000, label: 'Stability 查询' });
          if (!r) return { state: 'wait' };
          if (r.status === 202) return { state: 'wait' };
          if (r.status === 200) {
            let j = null; try { j = JSON.parse(r.text); } catch { return { state: 'fail', error: '结果非 JSON' }; }
            if (j.video) {
              const u8 = Uint8Array.from(atob(j.video), (c) => c.charCodeAt(0));
              const rec = await saveAssetRecord(S.activeId, 'video', new Blob([u8], { type: 'video/mp4' }), { name: 'stability-' + tid.slice(-6), source: 'api', category: 'finalcut' });
              return { state: 'done', url: fileUrlFor(rec.rel) };
            }
          }
          return { state: 'fail', error: 'HTTP ' + r.status + '：' + r.text.slice(0, 200) };
        });
        return await downloadVideo(url, {});
      },
    };
    /** 各视频厂商的参考素材上限（与各 runner 内部的截断口径一致）：
     *  超出上限会被截断——必须显式告警（o.warn → 节点 genWarn），绝不静默丢素材。 */
    const VIDEO_REF_CAPS = {
      wan: { img: 10 },
      minimaxv2: { img: 9, audio: 3 },
      openai: { img: 8 },
      seedance: { img: 8 },
      kling: { img: 1 }, vidu: { img: 1 }, runway: { img: 1 }, veo: { img: 1 },
      luma: { img: 1 }, pixverse: { img: 1 }, minimax: { img: 1 }, stability: { img: 1 },
    };
    async function apiVideo(prompt, frameBlob, s, opts) {
      const o = opts || {};
      // 节点级扩展参数（手动参数框）与供应商扩展参数合并（节点优先），各 runner 的 mergeExtra 自动生效
      const nodeExtra = String(o.nodeExtra || '').trim();
      if (nodeExtra) {
        try {
          const baseExtra = String(s.extra || '').trim();
          s = { ...s, extra: JSON.stringify({ ...(baseExtra ? JSON.parse(baseExtra) : {}), ...JSON.parse(nodeExtra) }) };
        } catch (e) { throw new Error('节点扩展参数需为 JSON 对象：' + ((e && e.message) || e)); }
      }
      // 衔接模式：auto=尾帧降级为参考图（保留实体参考图）；hard=硬首帧（放弃参考图，画面绝对承接）；
      // off=忽略首帧。网关禁止 first_frame 与 reference_image 混用，故 hard 模式必须放弃参考图。
      if (o.frameMode === 'off') frameBlob = null;
      if (o.frameMode === 'hard' && frameBlob) o.hardFrame = true;
      // 厂商预设层：显式选择了厂商格式（或旧配置自动识别）→ 走该厂商的官方协议适配器
      const vendor = detectVideoVendor(s);
      // 参考素材上限检查：超出即告警（截断发生在各 runner 内，这里先把事实说清楚）
      if (o.warn) {
        const caps = VIDEO_REF_CAPS[vendor] || { img: 1 };
        const refCount = o.hardFrame ? 0 : (Array.isArray(o.refs) ? o.refs.length : 0);
        if (refCount > (caps.img || 0)) o.warn('参考图 ' + refCount + ' 张超过该厂商上限 ' + caps.img + ' 张，本次只使用前 ' + caps.img + ' 张');
        const audCount = Array.isArray(o.audioRefs) ? o.audioRefs.length : 0;
        if (audCount > (caps.audio || 0)) o.warn('参考音频 ' + audCount + ' 条超过该厂商上限 ' + (caps.audio || 0) + ' 条，本次只使用前 ' + (caps.audio || 0) + ' 条');
      }
      if (vendor !== 'openai' && vendor !== 'seedance') {
        const run = VIDEO_VENDOR_RUNNERS[vendor];
        if (!run) throw new Error('暂未适配的视频厂商格式：' + vendor);
        return await run(prompt, frameBlob, s, o);
      }
      // OpenAI 风格视频接口（JUAI 等：/v1/video/generations）优先识别——
      // 即使误把协议设成 seedance 也不走火山官方协议（两者状态/结果字段不同）
      if (vendor === 'seedance' && ((s.protocol === 'seedance' || (s.url || '').includes('contents/generations/tasks')) && !(s.url || '').includes('/video/generations'))) {
        return await seedanceVideo(prompt, frameBlob, o.hardFrame ? [] : (o.refs || []), s, o);
      }
      if (!s.url) throw new Error('未配置视频 API');
      // URL 归一化：裸域 → /v1/video/generations；/v1 → /video/generations；完整端点原样使用
      let base = s.url.replace(/\/+$/, '').replace(/\/video\/generations$/, '');
      if (!base.replace(/^https?:\/\//i, '').includes('/')) base = base + '/v1';
      else if (/\/v1$/.test(base)) base = base + '/video/generations';
      const isOpenaiVideo = /\/video\/generations$/.test(base);
      const headers = { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}) };
      // 尾帧+参考图同连（跨镜衔接）→ 尾帧降级为第一张衔接参考图（first_frame/reference_image 互斥），标注写在提示词里
      const vRefs = o.hardFrame ? [] : (o.refs || []).slice(0, 8);
      const downgrade = Boolean(frameBlob && vRefs.length);
      if (downgrade) prompt = videoRefNote(o.refNames) + '\n' + prompt; // 前置硬约束
      const body = {
        ...(s.model ? { model: s.model } : {}),
        prompt,
        duration: Number(o.duration) || 5,
        // 分辨率一律小写（Seedance 系为 '720p'/'1080p'；'720P' 会被部分网关判为不支持）
        resolution: (o.resolution || '720p').toLowerCase(),
        ratio: o.ratio || '16:9',
      };
      // 首帧图生视频：构图以首帧为准——Seedance 系要求首帧模式必须 ratio=adaptive（仅纯首帧模式）
      if (frameBlob && !downgrade) {
        body.ratio = 'adaptive';
        try { body.image = await blobToDataUrlScaled(frameBlob); } catch { /* 忽略首帧编码失败 */ }
      } else if (vRefs.length) {
        const imgs = downgrade ? [frameBlob].concat(vRefs) : vRefs;
        body.images = isOpenaiVideo
          ? await Promise.all(imgs.map(async (b) => ({ url: await blobToDataUrlScaled(b), role: 'reference_image' })))
          : await Promise.all(imgs.map((b) => blobToDataUrlScaled(b)));
      }
      // 可选参数：勾选才发送 generate_audio；output_format 留空不发送
      if (s.generateAudio === true) body.generate_audio = true;
      if (String(s.outputFormat || '').trim()) body.output_format = String(s.outputFormat).trim();
      // 角色声音参考（@引用实体名下的音频资产）→ audios[]：模型生成的对白/声音向参考音色对齐；
      // 带声音参考时强制开启同步音频（否则参考无意义）
      if (o.audioRefs && o.audioRefs.length) {
        body.audios = await Promise.all(o.audioRefs.map((b) => blobToDataUrl(b)));
        body.generate_audio = true;
      }
      // 厂商专属扩展参数最后合并（可覆盖以上任何字段）：换厂商不需要改代码
      try {
        const extra = parseExtraParams(s.extra);
        if (extra) Object.assign(body, extra);
      } catch (e) { throw new Error('视频 API 扩展参数配置有误：' + ((e && e.message) || e)); }
      const res = await fetchViaProxy(base, { headers, body, timeoutMs: Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 120000, label: '视频 API' });
      if (!res.ok) {
        if (isOpenaiVideo) {
          // 降级链：① Seedance 原生 content[] 格式（RelayRouter 等，轮询 /v1/video/query）
          //          ② Sora 风格 /v1/videos
          let e1 = null, e2 = null;
          try {
            return await relayVideoContentFallback(base, prompt, frameBlob, o, s, headers);
          } catch (e) { e1 = e; }
          try {
            return await soraVideosFallback(base, prompt, o, s, headers);
          } catch (e) { e2 = e; }
          throw new Error('视频 API HTTP ' + res.status + ' @ ' + base + '：' + res.text.slice(0, 160)
            + '；降级链失败——[content格式] ' + ((e1 && e1.message) || e1) + '；[/v1/videos] ' + ((e2 && e2.message) || e2));
        }
        throw new Error('视频 API HTTP ' + res.status + ' @ ' + base + '：' + res.text.slice(0, 300));
      }
      let j = null;
      try { j = JSON.parse(res.text); } catch { /* 非 JSON 响应 */ }
      // 同源结果地址（如认证内容代理）带上鉴权下载；外部公开地址不带
      const apiOrigin = (() => { try { return new URL(base).origin; } catch { return ''; } })();
      const dlHeaders = (u) => { try { return new URL(u).origin === apiOrigin ? headers : {}; } catch { return {}; } };
      const direct = extractVideoUrl(j);
      if (direct) return await downloadVideo(direct, dlHeaders(direct), headers);
      const taskId = extractTaskId(j);
      if (!taskId) throw new Error('视频 API 响应中没有任务 id 或视频地址');
      if (o.onTask) { try { o.onTask(taskId, base + '/' + taskId); } catch { /* 持久化失败不影响生成 */ } }
      const deadline = Date.now() + 120 * 60 * 1000; // 2 小时：查询层绝不先放弃
      while (Date.now() < deadline) {
        await sleep(3000);
        if (genAborted()) throw new Error(T('stoppedNote'));
        let r2 = null;
        try { r2 = await fetchViaProxy(base + '/' + taskId, { method: 'GET', headers, timeoutMs: 60000, label: '查询视频任务' }); } catch { /* 网络抖动重试 */ }
        if (!r2 || !r2.ok) continue; // 查询层失败 ≠ 任务失败，只等生成任务自身的终态
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
      throw new Error('视频生成超过 2 小时未返回（任务 id 已保存在节点上，可凭 id 回查结果）');
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

    /** PCM 采样数组 → WAV Blob（单声道 16-bit，声音参考不需要立体声）。 */
    function pcmToWavBlob(samples, sampleRate) {
      const n = samples.length;
      const data = new ArrayBuffer(44 + n * 2);
      const dv = new DataView(data);
      const wstr = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
      wstr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wstr(8, 'WAVE'); wstr(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true); wstr(36, 'data'); dv.setUint32(40, n * 2, true);
      let off = 44;
      for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true); off += 2;
      }
      return new Blob([data], { type: 'audio/wav' });
    }
    /** 解码媒体音轨并按绝对秒区间取 PCM 拼接（多段合成一条）→ WAV Blob。 */
    async function extractWavRanges(mediaBlob, rangesSec) {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      try {
        const buf = await ac.decodeAudioData(await mediaBlob.arrayBuffer());
        const chans = [];
        for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
        const sr = buf.sampleRate;
        const pcm = [];
        for (const [a, b] of rangesSec) {
          const s0 = Math.max(0, Math.floor(a * sr));
          const s1 = Math.min(buf.length, Math.ceil(b * sr));
          for (let i = s0; i < s1; i++) {
            let v = 0;
            for (let c = 0; c < chans.length; c++) v += chans[c][i];
            pcm.push(v / chans.length);
          }
        }
        if (!pcm.length) throw new Error('裁剪区间为空');
        return { blob: pcmToWavBlob(pcm, sr) };
      } finally { try { ac.close(); } catch { /* 忽略 */ } }
    }
    /** 台词驱动的声音参考提取：按分镜 shots 的 dialogue 找到该角色的全部镜头，
     *  以镜头时长占比把**真实视频时长**映射回各镜头时间窗（±0.15s 呼吸垫），
     *  逐窗取 PCM **拼接为一个 WAV**（一个角色一个总的声音参考文件）。 */
    async function extractVoiceAuto(videoBlob, shots, role) {
      const rl = String(role || '').trim().toLowerCase();
      const windows = [];
      let t = 0;
      for (const s of shots) {
        const d = Number(s.duration) || 0;
        const lines = (s.dialogue || []).filter((l) => String(l.role || '').trim().toLowerCase() === rl);
        if (lines.length) windows.push({ title: s.title, from: t, to: t + d, lines });
        t += d;
      }
      if (!windows.length) {
        const roles = [...new Set((shots || []).flatMap((s) => (s.dialogue || []).map((l) => String(l.role || '').trim()).filter(Boolean)))];
        throw new Error(T('voiceRoleNotFound').replace('{roles}', roles.join('、') || '—'));
      }
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      try {
        const buf = await ac.decodeAudioData(await videoBlob.arrayBuffer());
        const sumDur = shots.reduce((a, s) => a + (Number(s.duration) || 0), 0) || 1;
        const k = buf.duration / sumDur; // 请求时长 → 实际时长的比例映射（模型未必精确跟时长）
        const chans = [];
        for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
        const sr = buf.sampleRate;
        const pcm = [];
        const pad = 0.15; // 呼吸垫：防止窗口边缘切字
        const segs = [];
        for (const w of windows) {
          const a = Math.max(0, w.from * k - (w.from > 0 ? pad : 0));
          const b = Math.min(buf.duration, w.to * k + pad);
          const s0 = Math.max(0, Math.floor(a * sr));
          const s1 = Math.min(buf.length, Math.ceil(b * sr));
          for (let i = s0; i < s1; i++) {
            let v = 0;
            for (let c = 0; c < chans.length; c++) v += chans[c][i];
            pcm.push(v / chans.length);
          }
          segs.push({ title: w.title, from: Math.round(a * 10) / 10, to: Math.round(b * 10) / 10, lines: w.lines.map((l) => l.role + '：' + l.line) });
        }
        if (!pcm.length) throw new Error('裁剪区间为空');
        return { blob: pcmToWavBlob(pcm, sr), segs, duration: Math.round(buf.duration * 10) / 10 };
      } finally { try { ac.close(); } catch { /* 忽略 */ } }
    }
    /** 手动模式：按用户给定的绝对秒区间提取。 */
    async function extractVoiceClip(mediaBlob, startSec, endSec) {
      const r = await extractWavRanges(mediaBlob, [[startSec || 0, endSec || 0]]);
      return { blob: r.blob };
    }

    /** 从视频 Blob 提取最后一帧为 PNG（通用：任何 API 生成的视频都能取尾帧）。 */
    async function extractLastFrame(videoBlob) {
      const r = await extractTailFrames(videoBlob, { count: 2, span: 0.2 });
      if (!r || !r.last) throw new Error('尾帧提取失败');
      return r.last;
    }
    /**
     * 尾帧候选抽取（续帧接力的关键）：**不取最后一帧**。
     * 最后一帧常落在动作顶点、运动模糊、遮挡、模型收敛抖动上——用它当下一段首帧，接缝必然跳。
     * 做法：取末尾若干帧做候选，给每帧打「动作进行中 / 清晰 / 无遮挡 / 不抖」分，取最高分那帧。
     * @returns { blobs: Blob[], picks: Array<{ t, blob, score, metrics }>, best: { blob, t, score } | null }
     */
    async function extractTailFrames(videoBlob, opts) {
      const o = opts || {};
      const count = Math.max(2, Math.min(24, Number(o.count) || 9)); // 候选帧数（末段采样）
      const span = Math.max(0.1, Math.min(2, Number(o.span) || 0.8)); // 采样窗口：结尾前 0.8s
      const url = URL.createObjectURL(videoBlob);
      let v = null;
      try {
        v = document.createElement('video');
        v.src = url; v.muted = true; v.preload = 'auto';
        await new Promise((res, rej) => {
          v.onloadedmetadata = () => res();
          v.onerror = () => rej(new Error('视频解码失败'));
          setTimeout(res, 12000);
        });
        const dur = Number(v.duration);
        if (!isFinite(dur) || dur <= 0) throw new Error('视频时长不可用');
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth || 1280;
        canvas.height = v.videoHeight || 720;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        // 采样时刻：结尾前 span 秒内均匀取 count 帧，最后一帧贴近片尾
        const t0 = Math.max(0, dur - span);
        const times = [];
        for (let i = 0; i < count; i++) times.push(Math.min(dur - 0.02, t0 + (span * i) / Math.max(1, count - 1)));
        times[times.length - 1] = Math.max(0, dur - 0.04);
        const grabs = [];
        for (const t of times) {
          await new Promise((res) => {
            let done = false;
            const fin = () => { if (!done) { done = true; res(); } };
            v.onseeked = fin;
            try { v.currentTime = t; } catch { fin(); }
            setTimeout(fin, 4000);
          });
          await new Promise((res) => {
            if (v.readyState >= 2) return res();
            v.oncanplay = res;
            setTimeout(res, 2000);
          });
          try {
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          } catch { continue; }
          // 缩略灰度（64×36）：算清晰度/运动/结构用，够用且极快
          const tw = 64, th = Math.max(1, Math.round((64 * canvas.height) / Math.max(1, canvas.width)));
          const small = document.createElement('canvas');
          small.width = tw; small.height = th;
          const sctx = small.getContext('2d', { willReadFrequently: true });
          sctx.drawImage(canvas, 0, 0, tw, th);
          const img = sctx.getImageData(0, 0, tw, th);
          const gray = new Uint8ClampedArray(tw * th);
          let sum = 0;
          for (let i = 0; i < gray.length; i++) {
            const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
            const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            gray[i] = y; sum += y;
          }
          // 清晰度：拉普拉斯响应均值（越高越锐利）
          let lap = 0, lapN = 0;
          for (let y2 = 1; y2 < th - 1; y2++) {
            for (let x2 = 1; x2 < tw - 1; x2++) {
              const i = y2 * tw + x2;
              const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - tw] - gray[i + tw];
              lap += Math.abs(l); lapN++;
            }
          }
          const sharpRaw = lapN ? lap / lapN : 0;
          // 前景占比：与画面均值的偏离度（粗估有人/物主体的程度）
          let dev = 0;
          const mean = sum / gray.length;
          for (let i = 0; i < gray.length; i++) dev += Math.abs(gray[i] - mean);
          const coverageRaw = gray.length ? dev / gray.length : 0;
          grabs.push({ t, gray, sharpRaw, coverageRaw, full: null });
          // 全分辨率 PNG 只对最终入选帧生成（省内存）
        }
        if (!grabs.length) throw new Error('尾帧采样失败');
        // 帧间差（运动幅度）+ 收敛抖动（相邻帧差突然变小 = 定格；突然变大 = 抖）
        const diffs = [];
        for (let i = 1; i < grabs.length; i++) {
          const a = grabs[i - 1].gray, b = grabs[i].gray;
          let s2 = 0;
          for (let k = 0; k < a.length; k++) s2 += Math.abs(a[k] - b[k]);
          diffs.push(a.length ? s2 / a.length / 255 : 0); // 0-1
        }
        const maxSharp = Math.max(...grabs.map((g) => g.sharpRaw), 1e-6);
        const picks = grabs.map((g, i) => {
          const prevDiff = i > 0 ? diffs[i - 1] : (diffs[0] || 0);
          const nextDiff = i < diffs.length ? diffs[i] : prevDiff;
          const motion = Math.max(0, Math.min(1, (prevDiff * 6))); // 归一：0.17/帧 ≈ 满运动
          const sharp = Math.max(0, Math.min(1, g.sharpRaw / maxSharp));
          const coverage = Math.max(0, Math.min(1, g.coverageRaw / 60));
          // 收敛抖动：自身运动相对邻域突变（模型末端常见突变）
          const jitter = Math.min(1, Math.abs(prevDiff - nextDiff) * 8);
          // 动作完成度：越接近片尾越可能"演完了"（末 3 帧按时间梯度推断）
          const complete = Math.max(0, Math.min(1, 0.35 + (i / Math.max(1, grabs.length - 1)) * 0.65));
          const score = tailFrameScore({ motion, sharp, coverage, jitter, complete });
          return { t: g.t, score, metrics: { motion, sharp, coverage, jitter, complete }, gray: g.gray, idx: i };
        });
        const best = picks.slice().sort((a, b) => b.score - a.score)[0];
        // 为入选帧 + 末帧各生成一张全分辨率 PNG（末帧始终产出，保证 last 端口行为不变）
        const wanted = new Set([best.idx, grabs.length - 1]);
        const blobs = new Map();
        for (const gi of [...wanted].sort((a, b) => a - b)) {
          const g = grabs[gi];
          await new Promise((res) => {
            let done = false;
            const fin = () => { if (!done) { done = true; res(); } };
            v.onseeked = fin;
            try { v.currentTime = g.t; } catch { fin(); }
            setTimeout(fin, 4000);
          });
          await new Promise((res) => { if (v.readyState >= 2) return res(); v.oncanplay = res; setTimeout(res, 2000); });
          try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); } catch { continue; }
          const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
          if (blob) blobs.set(gi, blob);
        }
        const lastBlob = blobs.get(grabs.length - 1) || blobs.get(best.idx) || null;
        const bestBlob = blobs.get(best.idx) || lastBlob;
        return {
          last: lastBlob,
          best: bestBlob,
          bestT: best.t,
          bestScore: best.score,
          picks: picks.map((p) => ({ t: p.t, score: p.score, metrics: p.metrics })),
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    /** 缩略灰度（接缝校验用）：任意图 Blob → 32×32 RGBA。 */
    async function grayThumb(blob, size) {
      const n = Math.max(8, Math.min(128, Number(size) || 32));
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await new Promise((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error('图片解码失败'));
          setTimeout(res, 8000);
        });
        const cv = document.createElement('canvas');
        cv.width = n; cv.height = n;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        // 保持比例居中裁切（letterbox 会稀释位移信号，直接拉伸更敏感）
        ctx.drawImage(img, 0, 0, n, n);
        const im = ctx.getImageData(0, 0, n, n);
        const gray = new Uint8ClampedArray(n * n);
        for (let i = 0; i < gray.length; i++) {
          gray[i] = Math.round(0.299 * im.data[i * 4] + 0.587 * im.data[i * 4 + 1] + 0.114 * im.data[i * 4 + 2]);
        }
        return { data: gray, w: n, h: n };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    /** 首帧抽取（末段续帧时校验用）：视频开头第一帧 PNG。 */
    async function extractFirstFrame(videoBlob) {
      const url = URL.createObjectURL(videoBlob);
      try {
        const v = document.createElement('video');
        v.src = url; v.muted = true; v.preload = 'auto';
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (!done) { done = true; res(); } };
          v.onloadedmetadata = fin;
          v.onerror = fin;
          setTimeout(fin, 10000);
        });
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (!done) { done = true; res(); } };
          v.onseeked = fin;
          try { v.currentTime = 0.02; } catch { fin(); }
          setTimeout(fin, 4000);
        });
        await new Promise((res) => { if (v.readyState >= 2) return res(); v.oncanplay = res; setTimeout(res, 2000); });
        const cv = document.createElement('canvas');
        cv.width = v.videoWidth || 1280; cv.height = v.videoHeight || 720;
        cv.getContext('2d').drawImage(v, 0, 0);
        return await new Promise((res) => cv.toBlob(res, 'image/png'));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    /** 续帧链：找到"上一个视频生成节点"。
     *  优先 ① frame 口连线的来源视频 ② 同一上游分镜表被连出的其它视频节点中已生成、且位置最靠上的那个。 */
    function autoPrevVideoNode(n) {
      const frameEdge = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'frame');
      if (frameEdge) {
        const src = S.graph.nodes[frameEdge.fromNode];
        if (src && src.type === 'video-gen' && src.data.assetId) return src;
      }
      const promptEdge = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'prompt');
      if (!promptEdge) return null;
      const sbId = promptEdge.fromNode;
      const sibs = S.graph.edges
        .filter((x) => x.fromNode === sbId && x.toNode !== n.id)
        .map((x) => S.graph.nodes[x.toNode])
        .filter((v) => v && v.type === 'video-gen' && v.data.assetId && (v.y < n.y || (v.y === n.y && v.x < n.x)));
      if (!sibs.length) return null;
      sibs.sort((a, b) => (b.y - a.y) || (b.x - a.x)); // 最近的一段（同列/同排里最靠近的上一段）
      return sibs[0];
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
          nd2.data.frameMode = 'hard'; // 链式下一镜：画面绝对承接 → 默认硬首帧
        }
        // 尾帧接力：优先「最佳选帧」（动作进行中/清晰），退到真·尾帧
        s.graph.edges.push({ id: uid('e'), fromNode: n.id, fromPort: (n.data.lastPickAssetId ? 'tailpick' : 'last'), toNode: nn.id, toPort: 'frame' });
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
      // mp4 优先（含音轨：H.264 + AAC）：webm 只是兜底，保证成片统一为 mp4
      const mimes = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
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
        update((s) => { s.dataRoot = r.dataRoot || null; s.dataRootExists = !!r.exists; s.dataRootSupported = true; s.store = r.store || (r.sql ? 'sqlite' : (r.dataRoot ? 'json' : null)); });
      } catch (e) {
        update((s) => { s.dataRoot = null; s.store = null; s.dataRootSupported = !/未知操作/.test(String((e && e.message) || e)); });
      }
    }
    // ---------- 对话 ↔ 画布同步：轮询 Host 项目索引 + 跳转请求 ----------
    let hostSyncStopped = false;
    let hostSyncBusy = false; // hostSyncTick 互斥：单次 tick 可能超过 3 秒
    let syncWarned = false;   // 同步失败只提示一次，避免刷屏
    // 用户在 UI 里删除过的节点（id → 时间戳）：同步的"内存画布为准"豁免只认这里——
    // 对话侧/Host 删除的节点不在此列，必须照常本地清除（否则旧内存副本会把对话侧刚删的节点复活）
    const userDeletedNodes = new Map();
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
        const cur = nodes[nid];
        // 生成产物保护：本地分镜已有 shots 而主机副本没有 → 主机副本是竞态过期数据，保留本地
        // （否则刚生成完的分镜会被一次过期合并清空，客户端再推回去就永久丢失）
        if (cur && cur.type === 'storyboard' && Array.isArray(cur.data && cur.data.shots) && cur.data.shots.length
          && !(n && n.data && Array.isArray(n.data.shots) && n.data.shots.length)) continue;
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
            // "内存画布为准"的豁免**仅限用户自己的撤销恢复**：用户在 UI 删除过（userDeletedNodes 有记录）
            // 且节点当前 live = 它是被撤销恢复的，Host 墓碑已过期 → 暂不删（等本机推送清墓碑）。
            // 对话侧(Host)删除的节点不在 userDeletedNodes 里 → 照常本地删除，
            // 否则旧内存副本会把对话侧刚删的节点复活（陈旧推送 + 过宽豁免的组合 bug）。
            const liveNodes = (hp.id === S.activeId && S.graph) ? S.graph.nodes : null;
            const deadEff = liveNodes
              ? dead.filter((nid) => !(liveNodes[nid] && userDeletedNodes.has(nid)))
              : dead;
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
          signal: genAbort.ctl ? genAbort.ctl.signal : undefined, // 停止按钮：立即中断流式读取
        });
      } catch (e) {
        if (genAborted()) throw e; // 手动打断：保持 abort 语义供上层识别
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
      if (genAborted()) throw new Error(T('stoppedNote')); // 流结束后仍被打断 → 走打断路径
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
        '- 本节点输出**一集**的剧本：成片时长 1-2 分钟（60-120 秒），共 4-10 个场景；',
        '- **每个场景必须以「【场N】场景名（地点·时间）」单独一行开头**（如【场1】城市街头（夜））——这是后续自动铺开到分镜的分场标记，格式不可省略或改写；',
        '- 每场按内容写足（成片 10–30 秒量级，约 150–400 字含该场全部对白）；全部场景时长之和 ≈ 1-3 分钟；',
        '- 场景头之后：可视化动作描写 + 对白（角色：台词，单独成行）；需要的声音（环境音/旁白）标注在括号里；',
        '- **【资产锚定·硬性】正文中所有角色/场景/道具名称一律写成 @名称@ 引用形式**（前后各一个 @ 精确包裹，名称与设定集逐字一致，如「@陈拾@ 在 @城市街头@ 的 @铁皮围挡@ 旁」）——下游分镜生成靠这些锚点识别资产并挂接参考图；叙述性文字正常书写，不要把动作描述包进 @…@；',
        '- 结尾单独一行「人物：」与「场景/道具：」清单，便于后续资产制作。',
      ].join('\n') : [
        `Idea / source:\n${String(idea ?? '').trim()}`,
        'Requirements:',
        '- This node outputs ONE episode: 1-2 minutes of screen time (60-120s), 4-10 scenes;',
        '- **Every scene MUST start with its own line "【SCENE N】name (location · time)"** — this marker drives the automatic per-scene expansion and must not be omitted;',
        '- Each scene is written to what it needs (10-30 seconds of screen time, ≈150-400 words incl. dialogue); all scenes sum to ≈1-3 minutes;',
        '- After each scene header: visual action + dialogue ("Character: line" on its own lines); mark sounds in brackets;',
        '- **[ASSET ANCHORING - HARD] wrap every character/scene/prop name as @Name@** (an @ on each side, names verbatim from the bible, e.g. "@Chen@ stands by @Wall@ at @Street@") - downstream storyboard generation relies on these anchors to attach references; keep narration text normal, never wrap action descriptions inside @...@;',
        '- End with "Characters:" and "Locations/Props:" lists for asset production.',
      ].join('\n');
      return await aiCompleteStream({
        system, user, model,
        onReasoning: (d) => onDelta && onDelta('reasoning', d),
        onText: (d) => onDelta && onDelta('text', d),
      });
    }
    /** 修复 JSON 字符串值内部未转义的半角引号（模型把 喷漆"拆"字 这类引用原样写进值里）。
     *  状态机扫描：跟踪是否处于字符串内；串内引号看其后第一个非空白字符——
     *  是 JSON 结构符（, } ] :）→ 这是字符串结束；否则是值内引号 → 转为全角「 / 」。 */
    function repairJsonInnerQuotes(s) {
      const src = String(s);
      let out = '';
      let inStr = false, esc = false, innerOpen = false;
      for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (!inStr) {
          if (ch === '"') inStr = true;
          out += ch;
          continue;
        }
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch !== '"') { out += ch; continue; }
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j])) j++;
        const nxt = src[j] || '';
        if (nxt === ',' || nxt === '}' || nxt === ']' || nxt === ':' || nxt === '') { inStr = false; innerOpen = false; out += ch; }
        else { out += innerOpen ? '」' : '「'; innerOpen = !innerOpen; }
      }
      return out;
    }
    async function aiStoryboardShots(scriptText, requirement, count, model, onDelta, prevTail, opts) {
      const settings = loadSettings();
      const bible = bibleBlock(loadBible(S.activeId));
      const zh = effLang() !== 'en';
      const contOn = !(opts && opts.cont === false); // 分镜衔接开关（默认开）
      const contFields = (() => {
        if (zh) {
          return contOn
            ? '{"title":"…","visual":"…","motion":"…","tail":"…","cam":"…","start":"…","seg":"continuation","characters":["…"],"scene":"…","props":["…"],"duration":3,"dialogue":[{"role":"陈拾","line":"收件时间，1999……"}],"sfx":"邮包搭扣声、撕纸声"}'
            : '{"title":"…","visual":"…","motion":"…","characters":["…"],"scene":"…","props":["…"],"duration":3,"dialogue":[{"role":"陈拾","line":"收件时间，1999……"}],"sfx":"邮包搭扣声、撕纸声"}';
        }
        return contOn
          ? '{"title":"…","visual":"…","motion":"…","tail":"…","cam":"…","start":"…","seg":"continuation","characters":["…"],"scene":"…","props":["…"],"duration":3,"dialogue":[{"role":"Chen","line":"…"}],"sfx":"zipper snap, paper tear"}'
          : '{"title":"…","visual":"…","motion":"…","characters":["…"],"scene":"…","props":["…"],"duration":3,"dialogue":[{"role":"Chen","line":"…"}],"sfx":"zipper snap, paper tear"}';
      })();
      const jsonContract = zh
        ? [
            '把剧本拆解为「多镜头一次性视频生成」的分镜脚本：铺开后由**一个视频生成节点**把全部镜头按顺序与时长写进同一条提示词，由视频模型一次性生成整段视频（镜头间由模型直接硬切，不是一镜一视频再拼接）。',
            '只输出一个 JSON 对象：{"shots":[' + contFields + ']}。',
            '规则：',
            '- visual 是本镜画面描述（景别、人物外观与站位、场景、光线、构图，60 字内）；',
            '- **visual 与 motion 里的角色/场景/道具必须写成 @资产名@ 引用形式**（前后各一个 @ 精确包裹，如「@陈拾@ 在 @城市街头@ 的围挡旁拿起 @奇怪快递件@」）；名称必须与设定集/资产**逐字一致**；剧本原文里已出现的 @资产名@ 锚点要在镜头中原样保留（名称逐字一致）；名称内不得含 @、空格或标点；@ 后绝不允许直接跟其他文字（必须以 @ 闭合）——系统会隐藏两个 @ 并把名称显示为蓝色加粗，未登记的 @名称@ 会被一致性检查提示补充；',
            '- motion 是本镜动作与运镜（主体动作节拍、机位运动方向与速度、情绪节奏，50 字内）；与 visual 不重复；',
            '- characters/scene/props 使用剧本与设定集中的名称（不带 @），便于匹配资产；无道具给空数组；',
            '- **dialogue 是本镜的角色台词**：把剧本中落在这一镜的对白逐行搬进来（{"role":"角色名","line":"台词原文"}），台词必须**逐字来自剧本**、不新写不改写；本镜无台词给空数组；一镜尽量只放一个角色的台词（单说话人镜头利于声音参考提取）；',
            '- **【音话同步·硬性】有台词的镜头必须让说话角色在画面内开口说话**：景别用近景/中近景，脸部朝向可见（正面或 3/4 侧脸），禁止背对镜头、脸部被遮挡、人物出画；visual 或 motion 里必须写明「开口说话、口型清晰可见」；台词**绝不能**处理成画外音/旁白（否则成片里人嘴是闭的、声音飘在背景里）；若某句台词在剧本里说话人无法入画，就把这句台词安排到能看见他说话的那一镜；',
            '- **sfx 是本镜的音效/环境音**：剧本里括号标注的「（音效：…）（环境音：…）」按内容对齐到最贴近的镜头**逐字搬入**（多个用顿号连接）；无音效的镜头给空字符串——音效是成片声音设计的一部分，绝不丢弃；',
            '- **【完整覆盖】分镜必须覆盖所给剧本的全部内容**：每一个动作、每一句对白都要落在某个镜头里——不概述、不省略、不跳过、不"挑选重点"；镜头数量与总时长由剧本体量自然决定，宁多勿漏（容量超限由上层拆分剧本处理，不由分镜偷工减料）；',
            '- **镜头按实际内容切分**：一个连续动作段落 = 一镜，数量由内容自然决定（3-10 镜都正常）——绝不凑数、绝不使用固定数量；',
            '- **JSON 字符串值内部禁止出现半角双引号 "**——引用文字（牌匾/字幕/台词原文）一律用「」；',
            '- duration 为该镜时长，**支持一位小数**；**按节奏谱系分配、拒绝均匀分布**：普通叙事/对话/环境交代 2–4s，快速冲突/打斗/追逐 0.3–0.8s（快切），重要反转/冲击/卡点 1–2s，长镜头情绪沉淀 ≥5s——同一场里至少制造一次明显的节奏变化（例：3s 叙事 → 0.6s 快切×2 → 1.5s 反转 → 5s 情绪长镜），画面再精致、时长全一样就没有节奏感；总时长按内容需要写足（不设硬上限）；镜头顺序即叙事顺序，末镜收束情绪；**若下方给了「承接约束」，第 1 镜必须承接上一场尾镜的画面与人物状态（不得重新建立场景/跳回远景），无承接约束时首镜才交代场景**；',
            '- **按情绪选景别**：孤独/绝望/宏大危机=远景；对峙/动作/关系建立=全景；对话/试探/信息交换=中景；震惊/怀疑/内心动摇=近景；崩溃/嘶吼/情绪爆发=特写；关键细节/道具揭示=大特写——冲突用全景、揭秘转近景、爆发给特写、反转可拉远，景别变化本身在讲情绪；',
            '- **快切镜头（<1.5s）的 visual/motion 要极短**（一个动作、一句画内信息），信息量大的镜头才配长时长——时长与内容量必须匹配；',
            '- 只输出 JSON，不要输出任何其他内容。',
          ].concat(contOn ? [
            '',
            '**【分镜衔接·硬性】成片是分段生成的，每段模型看不到上一段画面——衔接只能靠写在分镜里的"接点"。除末镜外，每镜都必须写 tail 与 cam：**',
            '- **tail（接点尾态）**：本镜**最后一刻**的状态，一行写清——人物姿势停在哪个动作的中途、朝向、视线落点、手持物位置、位置关系（如「右手抬到胸口一半，视线仍锁在 @陈拾@ 脸上，@糯糯@ 停在他左后方半步」「已侧身转到 3/4 面，还没完全转身面对对方」）。**必须是"动作进行中"的状态，不能写成"已经完成/站定/看向"**——切点停在静止定格，下一镜就没有动作可接，接缝必然暴露；',
            '- **cam（运镜延续）**：本镜运镜的方向与速度，写成下一镜可以直接"接着走"的形式（如「右移横移，匀速，未停」「缓推向面部，接近停住」）；末镜写「收束静止」；**全片避免相邻镜反向运镜**（上一镜右移、下一镜突然左移 = 观众立刻感觉跳），需要反向时把切点设计成遮挡/过肩/特写插入；',
            '- **start（仅第 1 镜或 seg 非续帧的镜头需要）**：本镜起始状态；续帧镜头不写 start（它会自动承接上一镜 tail）；',
            '- **seg（段落类型）**：`continuation` 续帧（默认，绝大多数镜头）、`scene_change` 换场/切换地点时间、`new_character` 新角色首次出场、`closeup` 特写/细节插入（允许跳切）、`opening` 仅第 1 镜且无上游承接时；',
            '- **一镜只做一个主动作**：转身、走路、推镜、换表情不要塞进同一镜——模型只会执行前半段，下一镜就对不上；',
            '- **一段一运镜**：不要又推又横移又摇；',
            '- **大位移拆镜**：人物横移超过画面 1/4、或场景大换位，就再拆一镜（用不同景别接，而不是一镜硬走）；',
            '- **轴线一致**：两人对话，同一轴线关系（如男左女右）在相邻镜必须保持一致，不得越轴。',
          ] : []).join('\n')
        : [
            'Break the script into shots for ONE multi-shot video generation: after expansion, a single video-gen node composes ALL shots (in order, with durations) into one prompt, and the video model generates the whole clip in one call (hard cuts inside the model — not one video per shot stitched together).',
            'Output only one JSON object: {"shots":[' + contFields + ']}.',
            'Rules:',
            '- visual = the shot\'s frame description (shot size, wardrobe, staging, light, framing, <=60 words);',
            '- **characters/scenes/props inside visual and motion must be written as @Name@ references** (an @ on each side, e.g. "@Chen@ picks up @Parcel@ by @Street@"); names must match the bible/assets VERBATIM, with no @, space or punctuation inside; an @ must never be followed directly by other text (always close with @) - the UI hides the @s and shows the name in blue bold; unregistered @Name@ is flagged by the consistency check;',
            '- motion = action & camera for the shot (action beats, camera move, emotional rhythm, <=50 words); do not repeat visual;',
            '- characters/scene/props arrays must use plain names from the script and series bible (no @) so assets match; empty props array if none;',
            '- **dialogue = the character lines that fall in this shot**, moved verbatim from the script ({"role":"Name","line":"exact line"}); never rewrite lines; empty array if none; keep one speaker per shot when possible (helps voice-reference extraction);',
            '- **[LIP-SYNC - HARD] any shot carrying dialogue must show the speaker TALKING ON SCREEN**: use a close-up / medium close-up with the face visible (frontal or 3/4), never back-to-camera, never obscured, never off-frame; state "speaks on screen, mouth clearly visible" in visual or motion; dialogue must NEVER become voice-over/narration (otherwise the final cut has a closed mouth with the voice floating in the background); if a line cannot be on camera in the script, move that line to the shot where the speaker is visible;',
            '- **sfx = sound cues / ambience for this shot**: bracketed notes like (SFX: ...) (Ambience: ...) from the script are moved verbatim into the closest matching shot (join multiples with commas); empty string if none — sound design is part of the film, never drop it;',
            '- **[FULL COVERAGE] the shots must cover EVERYTHING in the given script**: every action and every line must land in some shot — no summarizing, no omitting, no cherry-picking; shot count and total duration follow naturally from the script size (more is better than missing); capacity overflow is handled upstream by splitting the script, never by thinning the shots;',
            '- **Never use straight double quotes " inside JSON string values** — quoted text (signs/subtitles/lines) uses 「」 instead;',
            '- **Split shots by actual content**: one continuous action beat = one shot; the count is decided by the content (3-10 shots are all normal) — never pad, never use a fixed number;',
            '- duration is the shot length in seconds, **one decimal allowed**; **assign by pacing spectrum, never uniform**: normal narrative/dialogue 2-4s, fast conflict/fight/chase 0.3-0.8s (rapid cuts), key reversal/impact 1-2s, long emotional take >=5s — every scene must contain at least one obvious rhythm change (e.g. 3s narrative -> 0.6s cuts x2 -> 1.5s reversal -> 5s emotional take); identical durations kill the rhythm; total duration follows what the scene needs - no hard cap (vendor limits differ and change; if exceeded the video call reports it explicitly, then you split or adjust); shot order = narrative order; last shot lands the emotion; **if a CONTINUITY CONSTRAINT is given below, shot 1 must continue the previous scene\'s last frame and character state (no re-establishing, no wide reset); only without a constraint does shot 1 establish the scene**;',
            '- **Pick the shot size by emotion**: loneliness/despair/grand crisis = wide; confrontation/action/relationship = full; dialogue/probing/info exchange = medium; shock/suspicion/inner shake = close-up; breakdown/screaming/emotional burst = extreme close-up; key detail/prop reveal = big close-up — conflicts play wide, reveals move close, bursts go extreme, reversals can pull wide; the changing distance itself tells the emotion;',
            '- **Rapid cuts (<1.5s) get minimal visual/motion** (one action, one piece of in-frame information); long durations are earned by information density — duration must match content;',
            '- Output JSON only.',
          ].concat(contOn ? [
            '',
            '**[CONTINUITY - HARD] the film is generated in segments and each segment cannot see the previous one, so the "hand-off point" must be written into the storyboard. Every shot except the last MUST carry tail and cam:**',
            '- **tail (hand-off tail state)**: the state at the LAST instant of this shot, in one line - where the posture stops mid-motion, facing, gaze target, hand/prop position, blocking (e.g. "right hand half-way up to the chest, eyes still locked on @Chen@, @Nuonuo@ half a step behind his left shoulder"). It MUST be a mid-motion state, never a settled/completed pose: a cut on a static freeze leaves nothing for the next shot to continue, which is exactly what makes the seam visible;',
            '- **cam (camera carry-over)**: the move direction and speed of this shot, written so the next shot can continue it (e.g. "lateral right, constant speed, never stops"; "slow push-in, almost settled"). Last shot: "settle to static". Avoid reversing direction on adjacent shots (right pan then sudden left pan reads as a jump); if you need a reversal, make the cut a wipe/over-shoulder/insert close-up;',
            '- **start**: the start state, needed only for shot 1 or shots whose seg is not a continuation; continuation shots omit it (they inherit the previous tail);',
            '- **seg (segment type)**: `continuation` (default, most shots), `scene_change` (new place/time), `new_character` (a character appears for the first time), `closeup` (insert/detail, jump cut allowed), `opening` (only shot 1 with no upstream continuation);',
            '- **one primary action per shot**: never pack a turn + walk + push-in + expression change into one shot - the model only executes the first half and the next shot cannot match it;',
            '- **one camera move per shot**;',
            '- **split big displacements**: if a character crosses more than 1/4 of the frame, or the staging changes a lot, break it into another shot (different shot size) instead of one long move;',
            '- **keep the axis**: in a dialogue, the same side relationship (e.g. man left / woman right) must hold across adjacent shots - never cross the line.',
          ] : []).join('\n');
      const methodology = await loadSkillRules(settings.skillStoryboard, zh)
        || await loadSkillRules(CRAFT_SKILL, zh); // 未选技能时默认注入内置创作方法论
      const system = [
        EXPERT_STORYBOARD(zh),
        methodology || '',
        jsonContract,
        bible ? (zh ? '项目设定集（名称必须与之一致）：\n' : 'Series bible (names must match):\n') + bible : '',
        outLangLine(),
      ].filter(Boolean).join('\n');
      const countLine = (Number(count) > 0)
        ? `${zh ? '参考镜头数量' : 'Reference shot count'}：约 ${count} 镜（**仅作参考**——必须按实际动作节拍切分，内容需要更多就更多，绝不凑数）`
        : `${zh ? '镜头数量' : 'Shot count'}：**不固定**——按实际动作节拍切分，由内容自然决定`;
      // 承接约束：由连线指定（分镜表「衔接上一镜」输入口 ← 上游分镜表「尾镜」输出口）。
      // 只承接尾镜的**结尾瞬间**（≤0.2s 重叠），不重演上一镜——视频模型按秒计费，重演等于白花钱。
      const cont = (() => {
        if (!prevTail) return null;
        const label = prevTail.label || (zh ? '上一分镜' : 'previous storyboard');
        if (prevTail.text) {
          return zh
            ? `【承接约束·硬性】本分镜承接上游提供的衔接说明：\n${prevTail.text}\n`
              + `要求：第 1 镜从该衔接点**继续**（不重演），与上一镜画面重叠不超过 0.2 秒，人物位置/朝向/情绪/光线连续，背景环境声连续。`
            : `[CONTINUITY CONSTRAINT - HARD] Continue from the upstream hand-off note:\n${prevTail.text}\n`
              + `Shot 1 must continue from that point (no replay); overlap with the previous shot <= 0.2s; keep character position/facing/emotion/light and the ambient background sound continuous.`;
        }
        const sh = prevTail.shot;
        if (!sh) return null;
        const dl = (sh.dialogue || []).map((d) => d.role + (zh ? '：' : ': ') + d.line).join(zh ? '；' : '; ');
        const tailState = String(sh.tail || '').trim();
        const camState = String(sh.cam || '').trim();
        return zh
          ? `【承接约束·硬性】本分镜承接「${label}」的最后一镜——**只承接它的结尾瞬间，不要重演它**：\n`
            + `  尾镜画面：${String(sh.visual || '').trim()}\n`
            + `  尾镜最后动作：${String(sh.motion || '').trim()}\n`
            + (tailState ? `  尾镜接点尾态（本分镜第 1 镜必须从这里继续，动作处于进行中）：${tailState}\n` : '')
            + (camState ? `  尾镜运镜（第 1 镜须同向延续，不得反向、不得突变）：${camState}\n` : '')
            + (dl ? `  尾镜台词：${dl}\n` : '')
            + (String(sh.sfx || '').trim() ? `  尾镜音效/环境声：${String(sh.sfx).trim()}\n` : '')
            + `要求：\n`
            + `  1) 第 1 镜从上一镜的**最后一个动作**继续（人物位置、朝向、情绪、光线保持一致），不得重新建立场景、不得跳回远景交代、不得切换地点；\n`
            + `  2) 与上一镜的画面重叠**不超过 0.2 秒**（不要重演上一镜的内容）；\n`
            + `  3) **背景声连续**：环境音/音效自然延续（风声、电流声、街道底噪等），不得突然静音或更换环境声；\n`
            + `  4) 第 1 镜的画面描述里明确写出承接关系（如「承接上一镜，<角色>保持<姿态>，继续…」）；\n`
            + `  5) 第 1 镜的 seg 标 continuation，并**不要写 start**（自动承接上一镜 tail）。`
          : `[CONTINUITY CONSTRAINT - HARD] This storyboard continues the LAST SHOT of "${label}" - continue only its final instant, do NOT replay it:\n`
            + `  Tail frame: ${String(sh.visual || '').trim()}\n`
            + `  Tail last action: ${String(sh.motion || '').trim()}\n`
            + (tailState ? `  Tail hand-off state (shot 1 must continue from here, mid-motion): ${tailState}\n` : '')
            + (camState ? `  Tail camera (shot 1 continues the same direction, no reversal, no sudden change): ${camState}\n` : '')
            + (dl ? `  Tail dialogue: ${dl}\n` : '')
            + (String(sh.sfx || '').trim() ? `  Tail SFX/ambience: ${String(sh.sfx).trim()}\n` : '')
            + `Requirements:\n`
            + `  1) Shot 1 continues from the LAST ACTION of the previous shot (same position, facing, emotion, light) - no re-establishing, no wide reset, no location change;\n`
            + `  2) overlap with the previous shot must be <= 0.2s (do not replay the previous shot);\n`
            + `  3) ambient background sound continues naturally (wind, electrical hum, street noise) - never cut to silence or swap ambience;\n`
            + `  4) state the continuity explicitly in shot 1's frame description;\n`
            + `  5) shot 1 uses seg=continuation and omits start (it inherits the previous tail).`;
      })();
      const prevLine = cont || '';
      const user = [
        `${zh ? '剧本' : 'Script'}：\n${String(scriptText ?? '').trim()}`,
        `${zh ? '额外要求' : 'Extra requirements'}：${String(requirement ?? '').trim() || (zh ? '无' : 'none')}`,
        countLine,
        prevLine,
      ].filter(Boolean).join('\n\n');
      const text = await aiCompleteStream({
        system, user, model,
        onReasoning: (d) => onDelta && onDelta('reasoning', d),
        onText: (d) => onDelta && onDelta('text', d),
      });
      if (genAborted()) throw new Error(T('stoppedNote'));
      // 解析 + 修复重试：模型常把剧本里的引用文字（如 喷漆"拆"字）原样写进 JSON 字符串值，
      // 半角引号未转义 → JSON 非法。修复策略：把"闭合引号后不跟 JSON 结构符"的引号对换成「」。
      let parsed = parseJsonBalanced(text);
      if (!parsed || !Array.isArray(parsed.shots)) {
        try { parsed = parseJsonBalanced(repairJsonInnerQuotes(text)); } catch { /* 修复失败保持原错误 */ }
      }
      const shots = parsed && Array.isArray(parsed.shots) ? parsed.shots : null;
      if (!shots || !shots.length) {
        // 解析失败必须带上下文（长度 + 首尾原文），才能判断是被截断还是格式跑偏
        const raw = String(text || '').trim();
        const head = raw.slice(0, 160);
        const tail = raw.slice(-160);
        throw new Error(T('errParseStoryboard') + '（正文 ' + raw.length + ' 字；开头: ' + head + '；结尾: ' + tail + '）');
      }
      // 不做时长压缩：镜头时长由内容决定（各视频厂商单次上限不同，超限时由视频接口明确报错，
      // 比系统静默砍戏更好——用户要求「不要强行截断」）。仅做数据合法性兜底（≥1 的整数）。
      return shots.slice(0, 24).map((s, i) => ({
        title: String(s.title || (T('shotPrefix') + (i + 1))).slice(0, 24),
        visual: String(s.visual || ''),
        motion: String(s.motion || ''),
        // 分镜衔接（分段生成的接戏依据）：接点尾态 / 运镜延续 / 起始态 / 段落类型
        tail: String(s.tail || '').trim().slice(0, 120),
        cam: String(s.cam || '').trim().slice(0, 80),
        start: String(s.start || '').trim().slice(0, 120),
        seg: String(s.seg || '').trim().toLowerCase().slice(0, 20),
        characters: Array.isArray(s.characters) ? s.characters.map(String).slice(0, 6) : [],
        scene: String(s.scene || ''),
        props: Array.isArray(s.props) ? s.props.map(String).slice(0, 6) : [],
        duration: Number.isFinite(Number(s.duration)) ? Math.max(0.3, Math.round(Number(s.duration) * 10) / 10) : 3,
        dialogue: Array.isArray(s.dialogue)
          ? s.dialogue.slice(0, 6).map((d) => ({ role: String(d && d.role || '').trim().slice(0, 24), line: String(d && d.line || '').trim().slice(0, 200) })).filter((d) => d.role && d.line)
          : [],
        sfx: String(s.sfx || '').trim().slice(0, 120),
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
        // visual/motion 文本里的 @资产名@ 提及同样纳入检查（未登记的会提示补充资产——这是检查的价值所在）
        const text = String(sh.visual || '') + ' ' + String(sh.motion || '');
        for (const mm of parseMentions(text)) check(title, T('catMention'), mm.name);
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
      // 文本资产：文件（.md）落数据目录的项目文件夹，正文同时进 canvas.db（预览/下载不必回读文件）。
      // 未设数据目录时明确报错（IndexedDB 已废弃），绝不静默。
      if (!S.dataRoot) throw new Error('未设置数据根目录：文本资产无法持久化（IndexedDB 已废弃）。请在设置里配置数据根目录。');
      const rel = `projects/${projectId}/text/${assetFileBase(rec)}.md`;
      const blob = new Blob([rec.text], { type: 'text/markdown' });
      const r = await fetch('/' + NS + '/api/asset?rel=' + encodeURIComponent(rel), { method: 'POST', body: blob });
      if (!r.ok) throw new Error('文本资产落盘失败: ' + (await r.text()));
      rec.rel = rel;
      rec.size = blob.size;
      rec.stored = 'disk';
      const proj = S.projects.find((p) => p.id === projectId);
      if (S.store === 'sqlite') {
        const saved = await hostRpc('assetCreate', { asset: assetIndexRecord(rec), projectName: (proj && proj.name) || '' });
        const out = (saved && saved.asset) || rec;
        assetMem.set(out.id, out);
        assetNameCache.set(out.id, out.name);
        return out;
      }
      await idbPut(rec);
      assetNameCache.set(rec.id, rec.name);
      mirrorAssetIndex(rec); // JSON 降级模式：镜像进 assets.json
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
      store: null,           // 服务端存储模式：'sqlite'（0.18 主路径）| 'json'（降级）| null（未就绪/未设置）
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
        // 撤销恢复的节点同步撤销"用户删除"记账：同步豁免随之失效，墓碑由推送清除
        for (const id of live) userDeletedNodes.delete(id);
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
        data.script = ''; data.requirement = ''; data.count = 0; // 0 = 自动：镜头数按内容节拍，不锚定固定数量
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
      // 用户删除记账：同步的"内存画布为准"豁免只认这里——对话侧(Host)删除的节点不在此列，
      // 会被正常本地清除（否则旧内存副本会把对话侧刚删的节点复活）
      for (const id of ids) {
        userDeletedNodes.set(id, Date.now());
        if (userDeletedNodes.size > 300) {
          const oldest = userDeletedNodes.keys().next().value;
          userDeletedNodes.delete(oldest);
        }
      }
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
        audio: T('ttsCategory'), finalcut: T('finalcutCategory'), image: T('catImage'), general: T('catGeneral'),
      };
      return map[c] || c;
    }
    function portWorldPos(nodeId, portId, dir) {
      const n = S.graph.nodes[nodeId];
      if (!n) return { x: 0, y: 0 };
      // 分镜承接端口专属位置（用户设计）：tail=节点底部右侧（输出）、prev=节点顶部右侧（输入）
      if (n.type === 'storyboard' && portId === 'tail') return { x: n.x + n.w - 48, y: n.y + n.h };
      if (n.type === 'storyboard' && portId === 'prev') return { x: n.x + n.w - 48, y: n.y };
      const list = dir === 'out' ? (PORTS[n.type].outputs || []) : (PORTS[n.type].inputs || []);
      const i = list.findIndex((p) => p.id === portId);
      const stack = (n.type === 'storyboard' && dir === 'in' && i > 0) ? i - 1 : i; // prev 是角点不占常规队列
      const y = n.y + 38 + Math.max(0, stack) * 22;
      return { x: dir === 'out' ? n.x + n.w : n.x, y };
    }
    function edgeGeom(e) {
      const a = portWorldPos(e.fromNode, e.fromPort, 'out');
      const b = portWorldPos(e.toNode, e.toPort, 'in');
      const off = Math.abs(b.x - a.x);
      // 端口横向对齐（同一列上下相接，如分镜承接链）：直接连直线，不再外扩控制点画弯线
      if (off < 12 && Math.abs(b.y - a.y) > 24) {
        return {
          d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
        };
      }
      const dx = Math.max(42, off * 0.5);
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
      const hasDialogue = shots.some((s) => (s.dialogue || []).length);
      const lines = [
        zh
          ? `【多镜头一次性生成】共 ${shots.length} 镜、总时长 ${total} 秒。严格按下列顺序与时长切镜（每镜时长不可变），镜头之间直接硬切，不要叠加转场：`
          : `[Multi-shot single generation] ${shots.length} shots, ${total}s total. Cut strictly in this order with exact per-shot durations, hard cuts only, no transitions:`,
      ];
      if (hasDialogue) {
        lines.push(zh
          ? '标注「台词」的对白必须由**画面内可见的角色当场开口说出**（口型与台词同步、语气贴合情绪、面部朝镜头可见）；严禁处理成画外音/旁白；同步音频开启时按台词生成人声。'
          : 'Dialogue must be SPOKEN ON SCREEN by the visible character (lip-synced to the line, matching emotion, face toward camera); never render it as voice-over/narration; generate speech when synced audio is on.');
      }
      shots.forEach((s, i) => {
        const dur = Math.max(1, Number(s.duration) || 3);
        const parts = [];
        if (String(s.visual || '').trim()) parts.push(String(s.visual).trim());
        if (String(s.motion || '').trim()) parts.push((zh ? '运镜/动作：' : 'Camera/Action: ') + String(s.motion).trim());
        const dls = (s.dialogue || []).map((d) => String(d && d.role || '').trim() + '：' + String(d && d.line || '').trim()).filter((x) => x.replace('：', '').trim());
        if (dls.length) {
          parts.push(zh
            ? '台词（由' + (s.dialogue || []).map((d) => String(d && d.role || '').trim()).filter(Boolean).join('、') + '在画面内开口说出，口型与台词同步）：' + dls.join('；')
            : 'Dialogue (spoken on screen by ' + (s.dialogue || []).map((d) => String(d && d.role || '').trim()).filter(Boolean).join(', ') + ', lip-synced): ' + dls.join('; '));
        }
        if (String(s.sfx || '').trim()) parts.push((zh ? '音效：' : 'SFX: ') + String(s.sfx).trim());
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
      // tailpick = 尾帧「最佳选帧」（续帧接力首选：动作进行中/清晰/不抖）
      if (fromPort === 'tailpick') return src.data.lastPickAssetId || src.data.lastAssetId || null;
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

    /** 承接来源（**只认连线，不靠名字**）：本分镜「衔接上一镜」输入口(prev) 连到的上游分镜表，
     *  取它的**最后一镜**作为本场第 1 镜的承接依据；未连线返回 null（不加约束）。
     *  也允许连文本节点：直接把文本作为承接描述使用。 */
    function prevSceneTail(n) {
      const e = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'prev');
      if (!e) return null;
      const src = S.graph.nodes[e.fromNode];
      if (!src || !src.data) return null;
      if (src.type === 'storyboard') {
        const shots = src.data.shots || [];
        if (!shots.length) return { label: String(src.data.label || ''), shot: null };
        return { label: String(src.data.label || ''), shot: shots[shots.length - 1] };
      }
      if (src.type === 'text' || src.type === 'script') {
        const txt = String(src.data.text || src.data.output || '').trim();
        if (!txt) return null;
        return { label: String(src.data.label || ''), shot: null, text: txt };
      }
      return null;
    }

    // ============================================================
    // 工作流执行
    // ============================================================
    const cancelRef = { cancelled: false };
    const genAbort = { ctl: null }; // 当前生成的 AbortController（停止按钮真正中断底层流/轮询）
    let genActive = 0; // 活跃生成计数（工作流与单节点触发统一计数）
    function genAborted() { return !!(genAbort.ctl && genAbort.ctl.signal && genAbort.ctl.signal.aborted); }
    function stopActiveGen() {
      cancelRef.cancelled = true;
      if (genAbort.ctl) { try { genAbort.ctl.abort(); } catch { /* 忽略 */ } }
    }

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
        const fixedText = repairUnclosedMentions(text, bibleNames(loadBible(S.activeId)));
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.output = fixedText; nd.data.prevOutput = null; nd.data.aiStatus = 'idle'; nd.data.status = 'done'; nd.data.error = null; } s.assetsTick++; });
        await saveTextAssetRecord(S.activeId, {
          name: (String(n.data.label || '').trim() || T('scriptAssetPrefix')) + ' ' + nowStamp(),
          text: fixedText, category: 'script', prompt: n.data.idea,
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
      return (shots || []).map((x) => {
        const dls = (x.dialogue || []).map((d) => `${d.role}：${d.line}`).join('\n');
        const sfx = String(x.sfx || '').trim();
        return `【${x.title}】${x.duration}s\n画面：${x.visual}\n动作：${x.motion}`
          + (dls ? `\n${dls}` : '')
          + (sfx ? `\n音效：${sfx}` : '')
          + `\n角色：${(x.characters || []).join('、') || '-'}｜场景：${x.scene || '-'}｜道具：${(x.props || []).join('、') || '-'}`;
      }).join('\n\n');
    }

    /** 分镜节点：剧本 → 镜头列表（含一致性检查）。 */
    async function genStoryboardNode(n) {
      const st = storyboardScriptText(n);
      if (!st) throw new Error(T('aiNeedScript'));
      update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.aiStatus = 'running'; nd.data.aiError = null; nd.data.warnings = []; } });
      aiStreamClear(n.id);
      flushSave();
      try {
        const prev = prevSceneTail(n); // 场 N-1 的尾镜 → 作为本场第 1 镜的硬性承接约束
        const shots = await aiStoryboardShots(st, n.data.requirement, n.data.count || 6, n.data.model, (kind, d) => aiStreamAppend(n.id, kind, d), prev, { cont: n.data.cont !== false });
        // 未闭合引用自愈：句尾丢闭合 @ 的引用按设定集名补全（否则参考图静默丢失）
        const _known = bibleNames(loadBible(S.activeId));
        for (const sh of shots) {
          sh.visual = repairUnclosedMentions(sh.visual, _known);
          sh.motion = repairUnclosedMentions(sh.motion, _known);
          sh.sfx = repairUnclosedMentions(sh.sfx, _known);
        }
        // 先自动补录缺失条目（空描述），再算一致性告警：否则告警标志的条目其实马上就被自动补录了，"未登记"语义会误导用户与对话侧
        try { await autoRegisterBibleEntries(shots); } catch { /* 补录失败不影响分镜 */ }
        const warnings = await checkShotConsistency(shots);
        // 容量告警：镜头数上限 24（UI/数据上限）。剧本过长说明应该按场景拆分成多个场景剧本节点，
        // 而不是让一个分镜表硬吃全集（shots 上限 24 会截断覆盖面）。时长本身不设上限，不做压缩。
        const stLen = st.length;
        if (stLen > 600) {
          warnings.push(T('warnScriptTooLong').replace('{n}', String(stLen)));
        }
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.shots = shots; nd.data.aiStatus = 'idle'; nd.data.warnings = warnings; nd.data.status = 'done'; nd.data.error = null; nd.data.contFrom = prev ? prev.label : null; }
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
      const ctl = new AbortController();
      genAbort.ctl = ctl;
      genActive++;
      // 生成告警收集器：参考素材截断、厂商参数落空等"需要用户知道"的事实，一律挂到节点上（绝不静默）
      const addWarn = (msg) => {
        if (!msg) return;
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (!nd) return;
          const prev = String(nd.data.genWarn || '').trim();
          if (prev.includes(msg)) return;
          nd.data.genWarn = prev ? (prev + '；' + msg) : String(msg);
        });
      };
      update((s) => {
        const nd = s.graph.nodes[n.id];
        if (nd) { nd.data.status = 'running'; nd.data.error = null; nd.data.stopNote = null; nd.data.genWarn = null; }
        s.running = true; // 单节点触发（对话/节点按钮）也显示停止按钮
      });
      flushSave(); // 立刻落盘 + 推送 Host：切走画面/对话查询都能看到"运行中"
      try {
        if (type === 'script') { await genScriptNode(n); return true; }
        if (type === 'storyboard') { await genStoryboardNode(n); return true; }
        if (type === 'finalcut') { await genFinalCutNode(n); return true; }
        if (type !== 'image-gen' && type !== 'video-gen') throw new Error(T('nodeNotRunnable'));
        let prompt = resolvePrompt(n);
        const bible = loadBible(S.activeId);
        // 未闭合引用自愈：@糯糯。 → @糯糯@（按设定集名归一），修复结果回写节点让用户可见
        const _fixed = repairUnclosedMentions(prompt, bibleNames(bible));
        if (_fixed !== prompt) { prompt = _fixed; update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.prompt = _fixed; }); }
        if (type === 'image-gen') {
          // 参考图 = 连线（用户顺序）+ @引用命中的设定集资产（按出现顺序）
          const { refs, entities } = await collectRefs(n, prompt, bible);
          const metas = refs.map((r) => ({ blob: r.blob, name: r.name, category: r.category, assetId: r.assetId }));
          const p = buildEffectivePrompt(prompt, refs, entities, bible, true); // light：图片不内联设定全文（防文字渲染污染 + 参考图约束稀释）
          // 模型解析：节点选择优先，未指定路由到星标默认模型；都没有 = 明确报错（不再静默走演示模式）
          const mcfg = resolveImageModelCfg(settings, nodeImageModelRef(n));
          if (!mcfg) throw new Error(T('errNoImageModel'));
          const blob = await apiImage(p, metas, mcfg, { size: n.data.size, ratio: n.data.ratio, nodeExtra: n.data.imgExtra, warn: addWarn });
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
          const { refs, entities, audioBlobs } = await collectRefs(n, prompt, bible);
          // 上游是分镜表 → 走厂商「参考生成」结构化提示词（主体/分镜/台词/声音显式绑定，音画同步；
          // 机械拼装会让模型把台词与场景判错）；节点上已手写结构化提示词则原样尊重。
          const sbUp = (() => {
            const e2 = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'prompt');
            const src = e2 && S.graph.nodes[e2.fromNode];
            return src && src.type === 'storyboard' ? src : null;
          })();
          const shotList = sbUp && Array.isArray(sbUp.data.shots) ? sbUp.data.shots : [];
          const handWritten = String(n.data.prompt || '').trim();
          // 分镜衔接规划：段落类型（续帧/换场/新角色/特写插入）+ 首镜承接口 + 是否接力尾帧
          const zh = effLang() !== 'en';
          const plan = (() => {
            if (!shotList.length) return { first: null, chain: false, join: 'loose', seg: 'opening', fromShot: false };
            const first = shotContinuityPlan(shotList[0], null, 0);
            // 跨分镜表承接：上游分镜表「衔接上一镜」输入口 ← 上一个分镜表「尾镜」输出口
            const prevSb = (() => {
              const e2 = S.graph.edges.find((x) => x.toNode === (sbUp && sbUp.id) && x.toPort === 'prev');
              const src = e2 && S.graph.nodes[e2.fromNode];
              return src && src.type === 'storyboard' ? src : null;
            })();
            const prevNote = prevSb ? storyboardContinuityNote(prevSb.data.shots || [], String(prevSb.data.label || ''), zh) : null;
            let seg = first.seg;
            // 第 1 镜没有表内上一镜时，可承接上一个分镜表 → 实质是续帧
            if (seg === 'opening' && prevNote) seg = 'continuation';
            const join = seg === 'scene_change' ? 'loose' : seg === 'cut' ? 'cut' : seg === 'new_character' ? 'loose' : 'strict';
            return { first, chain: seg === 'continuation', seg, join, fromShot: !!prevNote };
          })();
          // 首帧来源：① frame 口连线（用户显式）② 续帧链自动取「上一个视频」的尾帧
          let frameBlob = await resolveAssetBlob(n.id, 'frame');
          let frameAuto = false;
          if (!frameBlob && plan.chain) {
            const prevVid = autoPrevVideoNode(n);
            if (prevVid && prevVid.data.assetId) {
              try {
                const vb = await assetBlob(prevVid.data.assetId);
                if (vb) {
                  // 优先复用它已选好的最佳尾帧（避免重复解码整段视频）；没有再现场选帧
                  if (prevVid.data.lastPickAssetId && prevVid.data.lastAssetVideo === prevVid.data.assetId) {
                    frameBlob = await assetBlob(prevVid.data.lastPickAssetId).catch(() => null);
                  }
                  if (!frameBlob) {
                    const tail = await extractTailFrames(vb, { count: 9, span: 0.8 }).catch(() => null);
                    frameBlob = (tail && (tail.best || tail.last)) || null;
                  }
                  if (frameBlob) {
                    frameAuto = true;
                    addWarn('已自动取「' + String(prevVid.data.label || '上一段视频') + '」的尾帧作为本段首帧（续帧接力）');
                  }
                }
              } catch { /* 取不到尾帧则降级为纯参考图生成 */ }
            }
          }
          const frameMode = n.data.frameMode || 'auto';
          const useFrame = frameMode !== 'off' && !!frameBlob;
          // 硬首帧只在"不挂实体参考图"时可用（多数厂商 first_frame 与 reference_image 互斥）；
          // 续帧段若还要实体参考图 → 尾帧降级为首张参考图 + 软锚定（frameAnchorText 会写明）
          const hardFrame = useFrame && frameMode === 'hard';
          const anchorRole = (useFrame && !hardFrame && refs.length) ? 'reference_image' : 'first_frame';
          let music = '';
          try { const ex2 = parseExtraParams(n.data.vidExtra); if (ex2 && typeof ex2.music === 'string') music = ex2.music; } catch { /* 扩展参数非法时忽略音乐提示 */ }
          // 跨段承接说明：本分镜第 1 镜承接上一个分镜表尾镜（续帧时首帧图已带画面，这里补文字约束）
          const continuity = (() => {
            if (!plan.fromShot) return '';
            const st = shotList[0] || {};
            const tail = String(st.tail || '').trim();
            const bits = [];
            if (plan.seg === 'continuation') {
              bits.push(zh ? '本段是上一段的直接续帧：第 1 帧从上一段结尾接着演，不重演、不重新建立场景、不切换机位' : 'This segment continues the previous one: start from its last frame, no replay, no re-establishing, no camera reset');
              if (tail) bits.push((zh ? '起始状态：' : 'Start state: ') + tail);
            } else if (plan.seg === 'scene_change') {
              bits.push(zh ? '本段换场：不承接上一段画面，但环境声/情绪可延续' : 'Scene change: do not continue the previous frame; ambience and mood may carry over');
            } else if (plan.seg === 'new_character') {
              bits.push(zh ? '本段有新角色入场：新角色必须从画面内自然进入（走入/被带入），不得凭空出现' : 'A new character enters: they must enter naturally from within the frame, never pop in');
            }
            return bits.join(zh ? '；' : '; ');
          })();
          let p;
          if (handWritten.includes('subject_definitions')) {
            p = handWritten; // 高级用法：手写结构化提示词，原样发送
          } else if (shotList.length) {
            p = buildStructuredVideoPrompt(shotList, refs, bible, {
              zh, prompt: handWritten, music, hasFrame: useFrame, frameRole: anchorRole, continuity,
            });
            if (!p) p = buildEffectivePrompt(prompt, refs, entities, bible); // 无参考图时回退
          } else {
            p = buildEffectivePrompt(prompt, refs, entities, bible);
          }
          // 非结构化路径（无参考图/手写提示词）也要有首帧锚定与承接说明
          if (!shotList.length || !p.includes('subject_definitions')) {
            const pre = [frameAnchorText({ hasFrame: useFrame, role: anchorRole, zh }), continuity].filter(Boolean).join(zh ? '；' : '; ');
            if (pre) p = pre + '\n' + p;
          }
          const mcfg = resolveVideoModelCfg(settings, nodeVideoModelRef(n));
          if (!mcfg) throw new Error(T('errNoVideoModel'));
          const blob = await apiVideo(p, useFrame ? frameBlob : null, mcfg, {
            duration: n.data.duration, resolution: n.data.resolution, ratio: n.data.ratio,
            frameMode, // auto=尾帧降级为参考图（保留实体参考图）/ hard=硬首帧（放弃参考图）/ off=忽略首帧
            hardFrame,
            refs: refs.map((r) => r.blob),
            refNames: refs.map((r) => r.entity || r.name || ''), // 跨镜衔接标注用（图2..N 的实体名）
            nodeExtra: n.data.vidExtra, // 节点级扩展参数（手动参数框，如 {"use_context_ir":true}）
            warn: addWarn, // 参考素材超限等告警回传（节点上可见）
            // 任务提交成功即持久化 task id：轮询中断/页面关闭后仍可凭 id 回查结果（钱花了就必须能找回）
            onTask: (tid, qurl) => {
              update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.taskId = String(tid || ''); nd.data.taskQueryUrl = String(qurl || ''); } });
              flushSave();
            },
            audioRefs: audioBlobs.map((a) => a.blob), // 角色声音参考（@引用实体名下的音频资产）
          });
          const rec = await saveAssetRecord(S.activeId, 'video', blob, {
            name: assetNameFor(n, entities, 'video'),
            prompt: stripMentionMarks(prompt), effectivePrompt: p,
            source: 'api',
            entity: entities.length ? entities[0].name : undefined,
            entities: entities.map((e) => e.name),
            nodeLabel: (n.data && n.data.label) || '',
            category: 'finalcut', // 节点生成的视频 = 成片（实体归属由 entities 字段承担，不占用分类）
          });
          // 记录续帧来源（节点上可追溯：本段是从哪一段接过来的）
          if (useFrame) {
            update((s) => {
              const nd = s.graph.nodes[n.id];
              if (nd) { nd.data.chainFrom = frameAuto ? (autoPrevVideoNode(n) || {}).id || null : 'wired'; }
            });
          }
          commitGenResult(n.id, rec.id, false, 'video');
          // 实测结果与设置不一致时留可见提示（厂商忽略 size/duration 是常见情况，必须让人看见而不是静默）
          try {
            const meta = await probeVideoMeta(blob);
            if (meta && meta.w && meta.h) {
              const wantRatio = String((n.data && n.data.ratio) || '16:9');
              const gotLandscape = meta.w > meta.h;
              const notes = [];
              if (wantRatio === '16:9' && !gotLandscape) notes.push('厂商返回 ' + meta.w + '×' + meta.h + '（竖屏），与设置的 16:9 不符：该厂商可能忽略 size 参数，可在供应商「扩展参数」里覆盖（如 {"parameters":{"size":"1920*1080"}}）');
              else if (wantRatio === '9:16' && gotLandscape) notes.push('厂商返回 ' + meta.w + '×' + meta.h + '（横屏），与设置的 9:16 不符');
              const wantDur = Number(n.data && n.data.duration) || 0;
              if (wantDur && meta.d && Math.abs(meta.d - wantDur) > 1.5) notes.push('实际时长 ' + meta.d.toFixed(1) + 's ≠ 设置 ' + wantDur + 's（厂商单次上限或已钳制）');
              if (notes.length) update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.genWarn = notes.join('；'); });
            }
          } catch { /* 探测失败不影响生成 */ }
          // 尾帧抽取（续帧接力的关键）：末段多帧候选里选「动作进行中/清晰/不抖」的一帧，
          // 而不是机械取最后一帧（最后一帧常在动作顶点/模糊/抖动上）。
          try {
            const tail = await extractTailFrames(blob, { count: 9, span: 0.8 });
            if (tail && tail.last) {
              const fRec = await saveAssetRecord(S.activeId, 'image', tail.last, {
                name: T('lastFrame') + '-' + (n.data.label || n.id.slice(-4)),
                prompt: 'last frame of ' + prompt.slice(0, 60), source: 'api', category: 'image',
              });
              // 最佳选帧单独存一份（last 口保持"真·最后一帧"语义，接力用"最佳帧"）
              let pickRec = null;
              if (tail.best && tail.best !== tail.last) {
                pickRec = await saveAssetRecord(S.activeId, 'image', tail.best, {
                  name: T('tailPick') + '-' + (n.data.label || n.id.slice(-4)),
                  prompt: 'continuity tail pick t=' + Number(tail.bestT || 0).toFixed(2) + 's; ' + prompt.slice(0, 40),
                  source: 'api', category: 'image',
                });
              }
              update((s) => {
                const nd = s.graph.nodes[n.id];
                if (nd) {
                  nd.data.lastAssetId = fRec.id; nd.data.lastAssetVideo = rec.id;
                  nd.data.lastPickAssetId = pickRec ? pickRec.id : fRec.id;
                  nd.data.tailPickMeta = { t: Number(tail.bestT || 0), score: Math.round((tail.bestScore || 0) * 100) / 100 };
                }
                s.assetsTick++;
              });
            }
          } catch { /* 尾帧提取失败不影响主流程 */ }
          // 接缝校验：本段首帧 vs 上一段尾帧（续帧段才有意义）。不达标 → 节点上可见告警（不静默）
          if (useFrame && plan.chain) {
            try {
              const first = await extractFirstFrame(blob);
              if (first) {
                const ga = await grayThumb(frameBlob, 32);
                const gb = await grayThumb(first, 32);
                const met = frameSeamMetrics(ga, gb);
                const v = seamVerdict(met, plan.join);
                update((s) => {
                  const nd = s.graph.nodes[n.id];
                  if (nd) nd.data.seam = { ok: v.ok, sim: v.sim == null ? null : Math.round(v.sim * 100) / 100, thr: v.thr, note: v.note, at: Date.now() };
                });
                if (!v.ok) addWarn('接缝校验未通过：' + v.note + '（建议：调低运动幅度重生成，或改用"硬首帧"模式）');
              }
            } catch { /* 校验失败不影响产物 */ }
          }
        }
        return true;
      } catch (err) {
        const stopped = !!(ctl.signal && ctl.signal.aborted);
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (!nd) return;
          if (stopped) {
            // 手动打断：回到待命而不是报错；视频任务 id 已持久化，可凭 id 回查结果
            nd.data.status = 'idle';
            nd.data.error = null;
            if (nd.type === 'script' || nd.type === 'storyboard') nd.data.aiStatus = 'idle';
            nd.data.stopNote = T('stoppedNote') + (nd.data.taskId ? '；' + T('stoppedTaskKept') : '');
          } else {
            nd.data.status = 'error';
            nd.data.error = String((err && err.message) || err);
          }
        });
        flushSave(); // 让对话侧的 canvas_node_status 也能读到失败原因
        if (stopped) toast(T('stoppedToast'));
        return false;
      } finally {
        genActive = Math.max(0, genActive - 1);
        if (genActive === 0) update((s) => { s.running = false; });
        if (genAbort.ctl === ctl) genAbort.ctl = null;
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
    function stopRun() {
      stopActiveGen();
      toast(T('stoppedToast'));
    }

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
      // 点击即置顶：被点的节点（含拖动中的整组）绘制在最上层，避免被其他节点盖住
      update((s) => {
        const z = (s.zTop || 100) + 1;
        s.zTop = z;
        const ids = s.sel.has(n.id) ? [...s.sel, n.id] : [n.id];
        for (const id of ids) { const nd = s.graph.nodes[id]; if (nd) nd.z = z; }
      });
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
        // —— 实时碰撞推挤（物理感）：拖动节点碰到谁，谁沿远离方向实时让位；被推者再推别人（级联）。
        //    上下左右同理：下节点上移碰到上节点 → 上节点实时上移；全程无弹跳，松手即定格。
        resolvePushNow(movedIds);
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
      eye: 'M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
      eyeOff: 'M4 4l16 16M9.9 5.1A9.6 9.6 0 0112 5c6 0 9.5 7 9.5 7a17 17 0 01-3.3 4.2M6.2 7.4A17 17 0 002.5 12S6 19 12 19a9.4 9.4 0 003.9-.8M10 10a3 3 0 004 4',
      help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.4 9.4a2.6 2.6 0 114.2 2.1c-.9.7-1.6 1.2-1.6 2.3M12 17h.01',
      link: 'M10 13a5 5 0 007.1 0l2.4-2.4a5 5 0 00-7.1-7.1L11 4.9M14 11a5 5 0 00-7.1 0L4.5 13.4a5 5 0 007.1 7.1L13 19.1',
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

    /** 节点框相交判定（含最小间距，默认 24px）。 */
    /** 实时碰撞推挤共享核心（拖动 / 节点尺寸变化共用）：与 movers 里节点相交的其他节点，
     *  沿远离主动节点的方向让位（重叠较少的轴先动，上下左右机会均等），被推者再推别人，级联最多 4 轮。
     *  高频路径：直接写模型坐标并同步被推节点的 DOM（不触发 React 重渲染），由调用方在静止时收尾落盘。 */
    function resolvePushNow(movers) {
      const PUSH_GAP = 8; // 触距：小于静止间距，贴近"贴上就推"的手感
      let frontier = [...movers];
      for (let pass = 0; pass < 4 && frontier.length; pass++) {
        const next = [];
        for (const fid of frontier) {
          const a = S.graph.nodes[fid];
          if (!a) continue;
          const al = a.x, ar = a.x + (a.w || 240), at = a.y, ab = a.y + (a.h || 96);
          for (const other of Object.values(S.graph.nodes)) {
            if (!other || movers.has(other.id) || other.type === 'group' || (other.data && other.data.hidden)) continue;
            const bl = other.x, br = other.x + (other.w || 240), bt = other.y, bb = other.y + (other.h || 96);
            if (al >= br + PUSH_GAP || ar + PUSH_GAP <= bl || at >= bb + PUSH_GAP || ab + PUSH_GAP <= bt) continue; // 未相交
            // 沿重叠较小的轴推开，方向 = 远离主动节点
            const penX = Math.min(ar, br) - Math.max(al, bl);
            const penY = Math.min(ab, bb) - Math.max(at, bt);
            const acx = (al + ar) / 2, acy = (at + ab) / 2;
            const bcx = (bl + br) / 2, bcy = (bt + bb) / 2;
            if (penX <= penY) {
              other.x = Math.round(bcx >= acx ? ar + PUSH_GAP : al - (br - bl) - PUSH_GAP);
            } else {
              other.y = Math.round(bcy >= acy ? ab + PUSH_GAP : at - (bb - bt) - PUSH_GAP);
            }
            const oel = nodeEls.get(other.id);
            if (oel) { oel.style.left = other.x + 'px'; oel.style.top = other.y + 'px'; }
            movers.add(other.id);
            next.push(other.id);
          }
        }
        frontier = next;
      }
      return movers;
    }

    /** 节点尺寸自适应：RO 上报最新尺寸（拖节点边、拉长内容输入框、流式长高、宽度变化都算），
     *  尺寸一变就实时推开相交的邻居（resolvePushNow，与拖动碰撞同一套物理推挤，所有节点类型统一走这里）；
     *  静止约 260ms 后收尾：通知 React + 记撤销快照 + 落盘。
     *  分组框高度由创建/折叠样式决定，不采集；首次测量只登记尺寸，避免载入时画面自行跳动。 */
    function observeNodeHeight(id, el) {
      if (!el) return;
      let raf = 0;
      let settleTimer = null;
      let touched = false;
      const scheduleSettle = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (!touched) return;
          touched = false;
          notify();
          pushHistory();
          flushSave();
        }, 260);
      };
      const ro = new ResizeObserver(() => {
        const nd = S.graph.nodes[id];
        if (!nd || nd.type === 'group') return;
        const w = el.offsetWidth, h = el.offsetHeight;
        if (!w || !h) return;
        if (Math.abs((nd.h || 0) - h) <= 1 && Math.abs((nd.w || 0) - w) <= 1) return;
        const first = !(nd.h || 0) && !(nd.w || 0);
        nd.w = w; nd.h = h;
        for (const e of S.graph.edges) {
          if (e.fromNode === id || e.toNode === id) {
            const p = edgePathEls.get(e.id);
            if (p) p.setAttribute('d', edgePath(e));
          }
        }
        if (!first && !raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            try {
              const pushed = resolvePushNow(new Set([id]));
              if (pushed.size > 1) { touched = true; scheduleSettle(); }
            } catch { /* 布局自愈失败不影响内容 */ }
          });
        }
      });
      ro.observe(el);
      return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); if (settleTimer) clearTimeout(settleTimer); };
    }

    function PortEl({ n, port, dir, corner }) {
      const isActive = drag.mode === 'link' && drag.linkFrom && drag.linkFrom.node.id === n.id && drag.linkFrom.port === port.id;
      let compat = false;
      const link = drag.mode === 'link' ? drag.linkFrom : null;
      if (link && dir === 'in' && link.node.id !== n.id) {
        const op = (PORTS[link.node.type].outputs || []).find((p) => p.id === link.port);
        compat = !!op && op.kind === port.kind;
      }
      return h('button', {
        type: 'button',
        className: cls('dshic-port', 'k-' + port.kind, corner && 'is-corner', isActive && 'is-active', compat && 'is-compat'),
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
          flushSave(); // 拖拽结束立即落盘：否则防抖期间切换页面会丢失 w/h/hManual
          try { if (resolvePushNow(new Set([n.id])).size > 1) notify(); } catch { /* 布局自愈失败不影响尺寸 */ }
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
        style: { left: n.x, top: n.y, width: n.w, zIndex: Number(n.z) || 1, ...(n.hManual ? { height: n.hManual } : {}) },
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
        ...(PORTS[n.type].inputs || []).map((p, i) => {
          const isCorner = n.type === 'storyboard' && p.id === 'prev'; // 分镜承接：顶部右侧角点
          const stack = (n.type === 'storyboard' && i > 0) ? i - 1 : i;
          return h('div', { key: 'in-' + p.id, style: { position: 'absolute', left: isCorner ? undefined : -5.5, right: isCorner ? 48 : undefined, top: isCorner ? 0 : 32.5 + stack * 22 }, className: 'dshic-port-wrap' },
            h(PortEl, { n, port: p, dir: 'in', corner: isCorner }),
            h('span', { className: 'dshic-port-label', style: isCorner ? { right: -6, top: -22 } : { left: 14, top: 0 } }, portLabel(p.id)));
        }),
        ...(PORTS[n.type].outputs || []).map((p, i) => {
          const isCorner = n.type === 'storyboard' && p.id === 'tail'; // 分镜尾镜：底部右侧角点
          return h('div', { key: 'out-' + p.id, style: { position: 'absolute', right: isCorner ? 48 : -5.5, bottom: isCorner ? 0 : undefined, top: isCorner ? undefined : 32.5 + i * 22 }, className: 'dshic-port-wrap' },
            h(PortEl, { n, port: p, dir: 'out', corner: isCorner }),
            h('span', { className: 'dshic-port-label', style: isCorner ? { right: -6, top: 12 } : { right: 14, top: 0 } }, portLabel(p.id)));
        }),
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
        prev: T('portPrev'), tail: T('portTail'),
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
      // 当前选中模型的厂商：H3（V2 协议）分辨率档位扩展为 480P/768P/1080P/2K/4K（大小写敏感）
      const videoModelName = (() => {
        if (kind !== 'video') return '';
        const [pid, mid] = String(cur || '').split('|');
        const p = (settings.videoProviders || []).find((x) => x.id === pid);
        const m = p && (p.models || []).find((x) => x.id === mid);
        return (m && m.model) || '';
      })();
      const isH3 = kind === 'video' && /minimax-?h3|hailuo-?03/i.test(videoModelName);
      const resos = (kind === 'video' && isH3)
        ? (['480P', '768P', '1080P', '2K', '4K'].includes(String(n.data.resolution)) ? ['480P', '768P', '1080P', '2K', '4K'] : ['480P', '768P', '1080P', '2K', '4K'].concat([String(n.data.resolution || '')]))
        : (VIDEO_RESOLUTIONS.includes(String(n.data.resolution)) ? VIDEO_RESOLUTIONS : VIDEO_RESOLUTIONS.concat([String(n.data.resolution || '')]));
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
                  // 当前值不在预设列表里（如分镜总时长 32s）也要能显示与保留：动态并入选项
                  options: (VIDEO_DURATIONS.includes(Number(n.data.duration))
                    ? VIDEO_DURATIONS
                    : [...VIDEO_DURATIONS, Math.round(Number(n.data.duration) || 5)].sort((a, b) => a - b))
                    .map((x) => ({ value: String(x), label: x + 's' })),
                  onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.duration = Number(v); }),
                }),
                h(MiniSelect, {
                  key: 'res', value: n.data.resolution || '720P', title: T('resolutionLabel'), width: 68,
                  options: resos.map((x) => ({ value: x, label: x })),
                  onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.resolution = v; }),
                }),
              ],
          h('div', { className: 'dshic-flex' }),
        ),
        h('input', {
          key: 'nextra', className: 'dshic-input', value: (kind === 'video' ? n.data.vidExtra : n.data.imgExtra) || '',
          placeholder: '扩展参数 JSON，如 {"use_context_ir":true}',
          title: '节点级扩展参数：合并进供应商扩展参数，节点值优先',
          onChange: (e) => update((s) => {
            const nd = s.graph.nodes[n.id];
            if (!nd) return;
            if (kind === 'video') nd.data.vidExtra = e.target.value; else nd.data.imgExtra = e.target.value;
          }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
      );
    }

    /** 声音参考提取：输入**角色名** → 自动按分镜表 dialogue 定位该角色的全部台词时间窗，
     *  逐窗取音轨 PCM **拼接为一个 WAV**（一个角色一个总的声音参考文件，无需手动找时间点）；
     *  分镜缺少台词标注时降级为手动起止秒模式。 */
    function VoiceExtractDialog({ nodeId, onClose }) {
      const n = S.graph.nodes[nodeId];
      const srcId = (n && n.data && (n.data.assetId || n.data.fcAssetId)) || null;
      const url = useAssetUrl(srcId);
      // 分镜来源：视频节点 → 上游分镜表；成片节点 → 经片段视频节点的上游分镜表
      const shots = (() => {
        const seen = new Set();
        const out = [];
        const collect = (nid) => {
          for (const e of S.graph.edges.filter((x) => x.toNode === nid && x.toPort === 'prompt')) {
            const sbn = S.graph.nodes[e.fromNode];
            if (sbn && sbn.type === 'storyboard' && Array.isArray(sbn.data.shots) && sbn.data.shots.length && !seen.has(sbn.id)) { seen.add(sbn.id); out.push(...sbn.data.shots); }
          }
        };
        collect(nodeId);
        if (!out.length) {
          for (const e of S.graph.edges.filter((x) => x.toNode === nodeId && x.toPort === 'in')) {
            collect(e.fromNode); // 片段视频节点的上游分镜
          }
        }
        return out;
      })();
      const roles = [...new Set(shots.flatMap((s) => (s.dialogue || []).map((l) => String(l.role || '').trim()).filter(Boolean)))];
      const [role, setRole] = useState('');
      const [manual, setManual] = useState(false);
      const [startS, setStartS] = useState('0');
      const [endS, setEndS] = useState('');
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const [done, setDone] = useState(null); // {segs}
      const windows = (() => {
        const rl = String(role || '').trim().toLowerCase();
        if (!rl) return [];
        const out = [];
        let t = 0;
        for (const s of shots) {
          const d = Number(s.duration) || 0;
          const lines = (s.dialogue || []).filter((l) => String(l.role || '').trim().toLowerCase() === rl);
          if (lines.length) out.push({ title: s.title, from: t, to: t + d, lines: lines.map((l) => l.role + '：' + l.line) });
          t += d;
        }
        return out;
      })();
      const submit = async () => {
        const role2 = String(role || '').trim();
        if (!role2) { setErr(T('voiceRoleNeeded')); return; }
        if (!url) { setErr(T('noResult')); return; }
        setBusy(true); setErr(null);
        try {
          const blob = await (await fetch(url)).blob();
          let wav = null;
          let segs = [];
          if (!manual) {
            const r = await extractVoiceAuto(blob, shots, role2);
            wav = r.blob; segs = r.segs;
          } else {
            const r = await extractWavRanges(blob, [[Number(startS) || 0, Number(endS) || Number(startS) || 0]]);
            wav = r.blob; segs = [{ title: T('voiceManual'), from: Number(startS) || 0, to: Number(endS) || 0, lines: [] }];
          }
          const rec = await saveAssetRecord(S.activeId, 'audio', wav, {
            name: '角色-' + role2 + ' 声音', entity: role2,
            prompt: T('voiceExtractSrc') + '：' + ((n.data && n.data.label) || nodeId) + (segs.length ? '（' + segs.map((x) => x.title + ' ' + x.from + '-' + x.to + 's').join('、') + '）' : ''),
            source: 'voice-extract', category: 'audio',
          });
          setDone(segs);
          update((s2) => { s2.assetsTick++; });
          toast(T('voiceExtractDone').replace('{name}', rec.name));
        } catch (e) { setErr(String((e && e.message) || e)); }
        setBusy(false);
      };
      return h('div', { className: 'dshic-modal-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'dshic-modal', style: { width: 440 } },
          h('div', { className: 'dshic-modal-title' }, T('voiceExtractBtn') + ' — ' + ((n && n.data && n.data.label) || '')),
          shots.length
            ? h('div', { className: 'dshic-modal-warn' }, T('voiceAutoHint'))
            : h('div', { className: 'dshic-modal-warn' }, T('voiceNoDialogue')),
          h(Field, { key: 'role', label: T('voiceRole'), value: role, onChange: setRole, placeholder: T('voiceRolePh') }),
          roles.length && !manual
            ? h('div', { className: 'dshic-modal-warn' }, T('voiceRolesInShots') + roles.join('、'))
            : null,
          !manual && windows.length
            ? h('div', { key: 'segs', className: 'dshic-modal-warn' },
                T('voiceSegs') + '（' + windows.length + '）：',
                windows.map((w) => h('div', { key: w.title + w.from, style: { marginTop: 2 } }, '· ' + w.title + ' ' + Math.round(w.from * 10) / 10 + '-' + Math.round(w.to * 10) / 10 + 's — ' + w.lines.join(' / '))))
            : null,
          manual
            ? [
                h('div', { className: 'dshic-row' },
                  h(Field, { key: 's', label: T('voiceStart'), value: startS, onChange: setStartS, placeholder: '0' }),
                  h(Field, { key: 'e', label: T('voiceEnd'), value: endS, onChange: setEndS, placeholder: '—' }),
                ),
              ]
            : null,
          h('label', { className: 'dshic-row', style: { gap: 6, fontSize: 11 } },
            h('input', { type: 'checkbox', checked: manual, onChange: (e) => setManual(e.target.checked), onPointerDown: (e) => e.stopPropagation() }),
            h('span', {}, T('voiceManual'))),
          done ? h('div', { className: 'dshic-modal-warn' }, T('voiceExtractDone').replace('{name}', '角色-' + (String(role || '').trim() || '—') + ' 声音') + '（' + done.map((x) => x.title).join('、') + '）') : null,
          err ? h('div', { className: 'dshic-err' }, err) : null,
          h('div', { className: 'dshic-modal-actions' },
            h('button', { type: 'button', className: 'dshic-btn dshic-btn-outline', onClick: onClose, onPointerDown: (e) => e.stopPropagation() }, T('cancel')),
            h('button', { type: 'button', className: 'dshic-gen', style: { width: 'auto', padding: '0 14px' }, disabled: busy || (!manual && !windows.length), onClick: submit, onPointerDown: (e) => e.stopPropagation() }, busy ? h('span', { className: 'dshic-spin' }) : Ic('audio', 12), T('voiceExtractBtn'))),
        ));
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
      const [voiceDlg, setVoiceDlg] = useState(false);
      useEffect(() => { probeCraft(); }, []);
      // 视频产物自动提取尾帧（含外部注入/导入的视频）：last 口与跨镜衔接不依赖"必须由本节点生成"
      useEffect(() => {
        if (kind !== 'video' || !n.data.assetId) return;
        if (n.data.lastAssetId && n.data.lastAssetVideo === n.data.assetId) return;
        let cancelled = false;
        (async () => {
          try {
            const blob = await assetBlob(n.data.assetId);
            if (!blob || cancelled) return;
            const fBlob = await extractLastFrame(blob);
            if (!fBlob || cancelled) return;
            const rec = await saveAssetRecord(S.activeId, 'image', fBlob, {
              name: T('lastFrame') + '-' + (n.data.label || n.id.slice(-4)),
              prompt: 'last frame of ' + String(n.data.label || ''), source: 'api', category: 'image',
            });
            update((s) => {
              const nd = s.graph.nodes[n.id];
              if (nd && nd.data.assetId === n.data.assetId) { nd.data.lastAssetId = rec.id; nd.data.lastAssetVideo = n.data.assetId; }
              s.assetsTick++;
            });
          } catch { /* 提取失败静默：不影响视频预览与 out 口 */ }
        })();
        return () => { cancelled = true; };
      }, [kind, n.data.assetId, n.data.label, S.assetsTick]);
      // 历史条自愈：已被删除的资产（渲染成 … 的幽灵格）自动从节点 history 剔除；
      // 服务端不可达时跳过本轮（宁可不修剪，绝不误删有效历史）
      useEffect(() => {
        const histList = n.data.history || [];
        if (!histList.length) return;
        let ok = true;
        (async () => {
          let alive = null;
          if (S.store) {
            const r = await hostRpc('assetsGet', { ids: histList.map((x) => x.assetId) }).catch(() => null);
            if (!r) return;
            alive = new Set((r.items || []).map((x) => x.id));
          } else {
            const recs = await Promise.all(histList.map((x) => idbGetRaw(x.assetId).catch(() => null)));
            alive = new Set(histList.filter((_, i) => recs[i]).map((x) => x.assetId));
          }
          if (!ok) return;
          const dead = histList.filter((x) => !alive.has(x.assetId)).map((x) => x.assetId);
          if (!dead.length) return;
          update((s) => {
            const nd = s.graph.nodes[n.id];
            if (!nd || !Array.isArray(nd.data.history)) return;
            const next = nd.data.history.filter((x) => !dead.includes(x.assetId));
            if (next.length === nd.data.history.length) return;
            nd.data.history = next;
            if (nd.data.assetId && dead.includes(nd.data.assetId)) nd.data.assetId = next.length ? next[next.length - 1].assetId : null;
          });
        })();
        return () => { ok = false; };
      }, [n.id, S.assetsTick, S.store]);
      const promptEdge = S.graph.edges.find((x) => x.toNode === n.id && x.toPort === 'prompt');
      const promptSrc = promptEdge && S.graph.nodes[promptEdge.fromNode];
      const fromStoryboard = !!(promptSrc && promptSrc.type === 'storyboard');
      const refEdges = S.graph.edges.filter((x) => x.toNode === n.id && (kind === 'image' ? x.toPort === 'ref' : x.toPort === 'frame'));
      const vrCount = S.graph.edges.filter((x) => x.toNode === n.id && x.toPort === 'ref').length;
      const assetUrlV = useAssetUrl(n.data.assetId);
      return [
        promptEdge
          ? h(PromptArea, {
              key: 'p', value: n.data.prompt || '', minHeight: 72, readOnly: true,
              ...phBind(n, 'p'),
              placeholder: fromStoryboard ? T('multiShotHint') : T('connected'),
              onChange: () => { /* 只读展示：内容由上游连线组合 */ },
            })
          : h(PromptArea, {
              key: 'p', value: n.data.prompt || '', minHeight: 72,
              ...phBind(n, 'p'),
              placeholder: T('promptPlaceholder'),
              onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.prompt = v; }),
            }),
        h(GenSettingsRow, { key: 'set', n, kind }),
        h('button', {
          key: 'gen', type: 'button', className: 'dshic-gen',
          onPointerDown: (e) => e.stopPropagation(),
          onClick: () => { if (n.data.status === 'running') { stopActiveGen(); toast(T('stoppedToast')); } else { runGenNode(n); } },
        }, n.data.status === 'running' ? [Ic('stop', 12), T('stop')] : [Ic('play', 12), T('generate')]),
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
        kind === 'video' && S.graph.edges.some((x) => x.toNode === n.id && x.toPort === 'frame')
          ? h('div', { key: 'fmode', className: 'dshic-node-row' },
              h('span', { className: 'dshic-shot-label', style: { flex: 'none' } }, T('frameModeLabel')),
              h('select', {
                className: 'dshic-select', style: { flex: 1, minWidth: 0 }, title: T('frameModeHint'),
                value: n.data.frameMode || 'auto',
                onPointerDown: (e) => e.stopPropagation(),
                onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.frameMode = e.target.value; }),
              },
                h('option', { value: 'auto' }, T('frameModeAuto')),
                h('option', { value: 'hard' }, T('frameModeHard')),
                h('option', { value: 'off' }, T('frameModeOff')),
              ),
            )
          : null,
        h(RefRows, { key: 'refrows', n, portId: 'ref' }),
        h(MentionInfo, { key: 'mn', n }),
        n.data.genWarn ? h('div', { key: 'gw', className: 'dshic-hint', style: { color: 'var(--dsw-alias-state-warning-primary, #d08700)' } }, '⚠ ' + n.data.genWarn) : null,
        n.data.stopNote ? h('div', { key: 'sn', className: 'dshic-hint' }, '⏹ ' + n.data.stopNote) : null,
        n.data.error ? h('div', { key: 'err', className: 'dshic-err' }, n.data.error) : null,
        // 续帧状态：本段首帧来自哪里（上一段尾帧 / 连线）+ 接缝校验结果（不达标必须让人看见）
        kind === 'video' && (n.data.chainFrom || n.data.seam)
          ? h('div', { key: 'chain', className: 'dshic-hint', style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
              n.data.chainFrom
                ? h('span', { title: T('chainInfo') }, '🔗 ' + (n.data.chainFrom === 'wired' ? T('chainManual') : T('chainAuto')))
                : null,
              n.data.seam
                ? h('span', {
                    title: T('seamHint'),
                    style: { color: n.data.seam.ok ? 'var(--dsw-alias-state-success-primary, #2f9e44)' : 'var(--dsw-alias-state-warning-primary, #d08700)' },
                  }, (n.data.seam.ok ? '✓ ' : '⚠ ') + (n.data.seam.ok ? T('seamOk') : T('seamFail')) + (n.data.seam.sim != null ? ' ' + n.data.seam.sim : ''))
                : null,
              n.data.tailPickMeta
                ? h('span', { title: T('tailPickHint') }, '✂ ' + T('tailPick') + ' ' + Number(n.data.tailPickMeta.t || 0).toFixed(1) + 's')
                : null,
            )
          : null,
        assetUrlV && kind === 'image'
          ? h('img', { key: 'img', className: 'dshic-preview', src: assetUrlV, draggable: false, 'data-no-drag': '1', style: { cursor: 'zoom-in' }, onPointerDown: (e) => e.stopPropagation(), onClick: (e) => { e.stopPropagation(); openLightbox('image', assetUrlV, n.data.label); } })
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
              kind === 'video' && assetUrlV
                ? h('button', {
                    type: 'button', className: 'dshic-mini is-ghost', title: T('voiceExtractBtn') + '（' + T('voiceTip') + '）',
                    onPointerDown: (e) => e.stopPropagation(),
                    onClick: () => setVoiceDlg(true),
                  }, Ic('audio', 11), T('voiceExtractBtn'))
                : null,
              h('div', { className: 'dshic-flex' }),
            )
          : null,
        showMask && assetUrlV ? h(MaskEditor, { key: 'mask', nodeId: n.id, onClose: () => setShowMask(false) }) : null,
        voiceDlg && assetUrlV ? h(VoiceExtractDialog, { key: 'voice', nodeId: n.id, onClose: () => setVoiceDlg(false) }) : null,
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
      const [kind, setKind] = useState('');
      useEffect(() => {
        let ok = true;
        idbGet(assetId).then((r) => { if (ok) setKind((r && r.kind) || ''); }).catch(() => { /* 忽略 */ });
        return () => { ok = false; };
      }, [assetId]);
      return h('div', {
        className: cls('dshic-hist-thumb', active && 'is-active'),
        title: T('history'),
        onClick: (e) => { e.stopPropagation(); onClick(); },
        onPointerDown: (e) => e.stopPropagation(),
      }, url
        ? (kind === 'video'
          ? h('video', { src: url + '#t=0.1', muted: true, preload: 'metadata', draggable: false })
          : h('img', { src: url, draggable: false }))
        : h('span', {}, '…'));
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
      // 视频资产自动提取尾帧：外部导入的视频也能走 last → frame 跨镜衔接（生成后/换视频后触发一次）
      useEffect(() => {
        if (kind !== 'video' || !n.data.assetId) return;
        if (n.data.lastAssetId && n.data.lastAssetVideo === n.data.assetId) return; // 已提取过当前视频
        let cancelled = false;
        (async () => {
          try {
            const blob = await assetBlob(n.data.assetId);
            if (!blob || cancelled) return;
            const fBlob = await extractLastFrame(blob);
            if (!fBlob || cancelled) return;
            const rec = await saveAssetRecord(S.activeId, 'image', fBlob, {
              name: T('lastFrame') + '-' + (n.data.label || n.data.placeholderName || n.id.slice(-4)),
              prompt: 'last frame of imported video', source: 'upload', category: 'image',
            });
            update((s) => {
              const nd = s.graph.nodes[n.id];
              if (nd && nd.data.assetId === n.data.assetId) { nd.data.lastAssetId = rec.id; nd.data.lastAssetVideo = n.data.assetId; }
              s.assetsTick++;
            });
          } catch { /* 尾帧提取失败静默：不影响视频预览与 out 口输出 */ }
        })();
        return () => { cancelled = true; };
      }, [kind, n.data.assetId, n.data.label, S.assetsTick]);
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
          if (nd) { nd.data.assetId = rec.id; nd.data.status = 'done'; nd.data.placeholderName = null; if (kind === 'video') { nd.data.lastAssetId = null; nd.data.lastAssetVideo = null; } }
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
          ? h('img', { key: 'img', className: 'dshic-preview', src: assetUrlV, draggable: false, 'data-no-drag': '1', style: { cursor: 'zoom-in' }, onPointerDown: (e) => e.stopPropagation(), onClick: (e) => { e.stopPropagation(); openLightbox('image', assetUrlV, n.data.label || n.data.placeholderName); } })
          : null,
        assetUrlV && kind === 'video'
          ? h('video', { key: 'vid', className: 'dshic-video', src: assetUrlV, controls: true, preload: 'metadata', 'data-no-drag': '1', onPointerDown: (e) => e.stopPropagation() })
          : null,
        !assetUrlV ? h('div', { key: 'hint', className: 'dshic-hint' },
          n.data.placeholderName ? `${T('placeholderAsset')}：${n.data.placeholderName}` : T('pickAsset')) : null,
      ];
    }

    function TextNodeBody({ n }) {
      // 文本节点同样走高亮输入层：输入 @资产名@ 自动显示为蓝色加粗（两个 @ 隐藏），与资产库强绑定
      return h(PromptArea, {
        value: n.data.text || '',
        placeholder: T('textPlaceholder'),
        minHeight: 96,
        ...phBind(n, 'text'),
        onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.text = v; }),
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
        h(PromptArea, {
          value: n.data.visual || '', minHeight: 52,
          ...phBind(n, 'visual'),
          placeholder: T('shotVisualPlaceholder'),
          onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.visual = v; }),
        }),
        h('span', { className: 'dshic-shot-label' }, T('motionLabel')),
        h(PromptArea, {
          value: n.data.motion || '', minHeight: 44,
          ...phBind(n, 'motion'),
          placeholder: T('shotMotionPlaceholder'),
          onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.motion = v; }),
        }),
      );
    }

    /** 文本框独立拉高的记忆：PromptArea 的原生 grip 拖高写进节点 data.ph[key]，
     *  换页/刷新重挂载后原样恢复（不再退回 minHeight）。key 在同一节点内需唯一。 */
    function phBind(n, key) {
      return {
        phH: (n.data.ph && n.data.ph[key]) || null,
        onPh: (px) => update((s) => {
          const nd = s.graph.nodes[n.id];
          if (!nd) return;
          nd.data.ph = { ...(nd.data.ph || {}), [key]: px };
        }),
        // 手动高度节点里拖原生 grip 拉对话框：视觉高度被 flex 定死，但 inline height 的增量=拖动量，
        // 换算成节点 hManual 的增量 → 对话框随节点一起变长；自适应节点不需要（高度本来就跟内容走）。
        grow: (d) => update((s) => {
          const nd = s.graph.nodes[n.id];
          if (!nd || !d || !nd.hManual) return;
          nd.hManual = Math.max(96, Math.round(nd.hManual + d));
          nd.h = nd.hManual;
        }),
      };
    }

    /**
     * 提示词输入框：@名称 蓝色加粗高亮。
     * 与主流工具同一做法——透明文字的 textarea 叠在同步滚动的背景层上，
     * 背景层渲染同一段文本并给 @名称 上色，光标/选区/中文输入法都不受影响。
     */
    function PromptArea({ value, onChange, placeholder, minHeight, style, readOnly, phH, onPh, grow }) {
      const taRef = useRef(null);
      const backRef = useRef(null);
      // 记忆高度的基准：React 上一次写进 textarea 的 height（null=未设置）。
      // 原生 grip 拉高会直接改 inline style，与基准不同即视为用户改动 → 回调存进节点数据。
      const hBaseRef = useRef(null);
      // grip 拖动轨迹：inline height 的上一次值（手动高度节点用它把拖动量换算成节点高度增量）
      const lastInlineRef = useRef(null);
      useEffect(() => {
        hBaseRef.current = phH || null;
        lastInlineRef.current = phH || null;
      }, [phH]);
      const sync = () => {
        const ta = taRef.current;
        const back = backRef.current;
        if (!ta || !back) return;
        // 父级高度不定时绝对定位的 bottom 会失效，背层随文字撑高并画出边框。
        // 用输入框的实际高度锁死背层，滚动才对齐；外层 overflow:hidden 再兜底裁切。
        const h = ta.offsetHeight;
        if (h > 0 && back.style.height !== h + 'px') back.style.height = h + 'px';
        back.scrollTop = ta.scrollTop;
        back.scrollLeft = ta.scrollLeft;
      };
      useEffect(() => {
        sync();
        const ta = taRef.current;
        if (!ta || typeof ResizeObserver === 'undefined') return undefined;
        let hRaf = 0;
        const ro = new ResizeObserver(() => {
          sync();
          if (!onPh) return;
          const px = parseInt(ta.style.height, 10) || 0;
          if (px > 0 && px !== (hBaseRef.current || 0) && !hRaf) {
            hRaf = requestAnimationFrame(() => {
              hRaf = 0;
              const cur = parseInt(ta.style.height, 10) || 0;
              if (cur > 0 && cur !== (hBaseRef.current || 0)) {
                if (grow && lastInlineRef.current != null) grow(cur - lastInlineRef.current);
                lastInlineRef.current = cur;
                onPh(cur);
              }
            });
          }
        });
        ro.observe(ta);
        return () => { ro.disconnect(); if (hRaf) cancelAnimationFrame(hRaf); };
      }, []);
      // 值变化后补一次滚动同步：在末尾输入时 textarea 会自动滚动到光标，但背层不一定收到 scroll 事件
      useEffect(() => { sync(); }, [value]);
      // 结尾换行补偿：<textarea> 的结尾 \n 会多出一条空行，而 pre-wrap 的 <div> 不生成该行盒
      // → 两层 scrollHeight 差一行，滚到底时背层露出半截错位文字。补零宽字符让行盒存在。
      const html = highlightMentions(value || '').replace(/\n$/, '\n\u200b');
      const ph = placeholder ? '<span class="dshic-prompt-ph">' + escapeHtml(placeholder) + '</span>' : '';
      return h('div', { className: 'dshic-prompt' },
        h('div', {
          ref: backRef, className: 'dshic-prompt-back', 'aria-hidden': 'true',
          dangerouslySetInnerHTML: { __html: html || ph },
        }),
        h('textarea', {
          ref: taRef, className: 'dshic-textarea dshic-prompt-input', value: value || '',
          placeholder: html ? undefined : placeholder,
          readOnly: readOnly === true,
          style: { minHeight: minHeight || 72, height: phH || undefined, ...(style || {}) },
          onChange: (e) => onChange(e.target.value),
          onScroll: sync,
          onPointerDown: (e) => e.stopPropagation(),
          onKeyUp: sync,
          onClick: sync,
        }),
      );
    }

    /** 剧本输出 → 场景数组：按分场标记（【场N】/ 场N：/ ## 场N / SCENE N）切分；
     *  尾部的「人物：/场景/道具：」清单从最后一场剥离（资产生产参考，不属于场景正文）。 */
    function parseScriptScenes(output) {
      const text = String(output || '').replace(/\r\n/g, '\n');
      const head = /^\s*(?:【\s*场\s*\d+[^】]*】|【?\s*场\s*\d+\s*】?\s*[：:、．.]|场\s*\d+\s*[：:、．.]|#{1,4}\s*场?\s*\d+|SCENE\s*\d+\b)/i;
      const scenes = [];
      let cur = null;
      for (const line of text.split('\n')) {
        if (head.test(line)) {
          if (cur && cur.text.trim()) scenes.push(cur);
          cur = { title: line.trim().replace(/^#{1,4}\s*/, '').slice(0, 60), text: line + '\n' };
        } else if (cur) {
          cur.text += line + '\n';
        }
      }
      if (cur && cur.text.trim()) scenes.push(cur);
      if (scenes.length) {
        const last = scenes[scenes.length - 1];
        const i = last.text.search(/\n(?:人物|角色)\s*[:：][\s\S]*$/);
        if (i >= 0) last.text = last.text.slice(0, i) + '\n';
      }
      return scenes.filter((s) => s.text.trim());
    }
    /** 剧本节点「铺开到场景」：按【场N】分场标记把整集剧本拆成
     *  「场景文本节点 → 分镜表节点」组合（每场一组，连线一次生成场景分镜；每场 10-15s）。 */
    function expandScriptToScenes(n) {
      const scenes = parseScriptScenes(n.data.output);
      if (scenes.length < 2) { toast(T('expandNeedScenes')); return; }
      update((s) => {
        let row = 0;
        for (const sc of scenes) {
          const y = n.y + row * 320;
          const label = sc.title.slice(0, 40);
          const tx = newNode('text', { x: n.x + n.w + 160, y });
          tx.data.label = label;
          tx.data.text = sc.text.trim();
          s.graph.nodes[tx.id] = tx;
          const sb = newNode('storyboard', { x: n.x + n.w + 520, y });
          sb.data.label = label;
          s.graph.nodes[sb.id] = sb;
          s.graph.edges.push({ id: uid('e'), fromNode: tx.id, fromPort: 'out', toNode: sb.id, toPort: 'script' });
          row++;
        }
        s.sel = new Set();
      });
      pushHistory();
      flushSave();
      toast(T('expandScenesDone').replace('{n}', String(scenes.length)));
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
        h(PromptArea, {
          key: 'idea', value: n.data.idea || '', minHeight: 72,
          ...phBind(n, 'idea'),
          placeholder: T('ideaPlaceholder'),
          onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.idea = v; }),
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
            type: 'button', className: 'dshic-mini is-ghost', title: T('expandScenes') + '（每场 → 文本+分镜表 组合）',
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => expandScriptToScenes(n),
          }, Ic('expandAll', 11), T('expandScenes')) : null,
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
        h(PromptArea, {
          key: 'out', value: n.data.output || '', minHeight: 180,
          ...phBind(n, 'out'),
          placeholder: running ? T('aiRunning') : '',
          onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.output = v; }),
        }),
      ];
    }

    function StoryboardNodeBody({ n }) {
      const running = n.data.aiStatus === 'running';
      // 分镜列表高度：右下角手柄拖拽调整（存进节点数据，随画布持久化）
      const listH = Math.max(80, Math.min(1200, Number(n.data.shotsListH) || 180));
      const startResize = (e) => {
        e.stopPropagation(); e.preventDefault();
        const startY = e.clientY; const startH = listH; const startNodeH = Number(n.h) || 0;
        const startHManual = n.hManual ? Number(n.hManual) : 0;
        const onMove = (ev) => {
          const nh = Math.max(80, Math.min(1200, startH + (ev.clientY - startY)));
          const dh = nh - startH;
          update((s) => {
            const nd = s.graph.nodes[n.id]; if (!nd) return;
            nd.data.shotsListH = nh;
            if (startHManual > 0) {
              // 手动高度节点：列表加多高，节点就长多高（否则固定高度会把上方输入框挤扁）
              nd.hManual = Math.max(120, startHManual + dh);
              nd.h = nd.hManual;
            } else if (startNodeH > 0) {
              nd.h = Math.max(120, startNodeH + dh);
            }
          });
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          try {
            // 收尾对齐：手动高度若还截着内容（此前被挤压过的存量节点），按内容自然高度补齐一次
            const el = nodeEls.get(n.id);
            const body = el && el.querySelector('.dshic-node-body');
            if (body && body.scrollHeight > body.clientHeight + 1) {
              const deficit = body.scrollHeight - body.clientHeight;
              update((s) => { const nd = s.graph.nodes[n.id]; if (nd && nd.hManual) nd.hManual = Math.round(nd.hManual + deficit); });
            }
          } catch { /* 布局自愈失败不影响功能 */ }
          flushSave();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      };
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
        h(PromptArea, {
          key: 'script', value: n.data.script || '', minHeight: 56, readOnly: !!scriptEdge,
          ...phBind(n, 'script'),
          placeholder: scriptEdge ? T('connected') : T('storyboardScriptLabel'),
          onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.script = v; }),
        }),
        h(PromptArea, {
          key: 'req', value: n.data.requirement || '', minHeight: 40,
          ...phBind(n, 'req'),
          placeholder: T('storyboardReqLabel'),
          onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.requirement = v; }),
        }),
        h('div', { key: 'row', className: 'dshic-node-row' },
          h(MiniSelect, {
            value: String(n.data.count || 0), title: T('storyboardCountLabel'), width: 88,
            options: [{ value: '0', label: T('autoShots') }].concat([3, 4, 6, 8, 10, 12, 16].map((x) => ({ value: String(x), label: x + ' ' + T('shotsUnit') }))),
            onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.count = Number(v); }),
          }),
          // 分镜衔接：写作时强制每镜带「承接上镜尾态 / 接点尾态 / 运镜延续」，并可标记段落类型
          h('button', {
            key: 'cont', type: 'button',
            className: 'dshic-mini' + (n.data.cont !== false ? '' : ' is-ghost'),
            title: T('contToggleHint'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.cont = nd.data.cont === false; }),
          }, (n.data.cont !== false ? '✓ ' : '') + T('contToggle')),
          h('div', { className: 'dshic-flex' }),
        ),
        h('button', { key: 'gen', type: 'button', className: 'dshic-gen', disabled: running, onClick: generate, onPointerDown: (e) => e.stopPropagation() },
          running ? h('span', { className: 'dshic-spin' }) : Ic('spark', 12), running ? T('aiRunning') : T('aiStoryboard')),
        running && aiStreamLine(n.id)
          ? h('div', { key: 'stream', className: 'dshic-stream', title: aiStreamLine(n.id) },
              h('span', { className: 'dshic-stream-dot' }), aiStreamLine(n.id))
          : null,
        n.data.contFrom
          ? h('div', { key: 'cont', className: 'dshic-hint' }, '↩ ' + T('contFrom') + '：' + n.data.contFrom + ' ' + T('lastFrame'))
          : null,
        n.data.aiError ? h('div', { key: 'err', className: 'dshic-err' }, n.data.aiError) : null,
        (n.data.warnings || []).length
          ? h('div', { key: 'warn', className: 'dshic-card', style: { padding: 6, gap: 3 } },
              h('div', { className: 'dshic-shot-label' }, T('consistencyTitle')),
              n.data.warnings.map((w, i) => h('div', { key: i, className: 'dshic-err', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '· ' + w)),
            )
          : null,
        shots.length
          ? h('div', { key: 'listwrap', style: { position: 'relative', alignSelf: 'stretch' } },
              h('div', { key: 'list', className: 'dshic-shot-list', style: { maxHeight: listH + 'px' } },
                shots.map((sh, i) => {
                  const pl = shotContinuityPlan(sh, shots[i - 1], i);
                  return h('div', { key: i, className: 'dshic-shot-item', onPointerDown: (e) => e.stopPropagation() },
                  h('strong', {}, `${sh.title} · ${sh.duration}s `), ...mentionNodes(sh.visual),
                  pl.seg !== 'continuation'
                    ? h('div', { className: 'dshic-shot-label', style: { marginTop: 2, opacity: 0.9 } }, '〔' + T('seg' + pl.seg.charAt(0).toUpperCase() + pl.seg.slice(1)) + '〕')
                    : null,
                  String(sh.tail || '').trim()
                    ? h('div', { className: 'dshic-shot-label', style: { marginTop: 2, opacity: 0.9 } }, '↳ ' + T('shotTail') + '：' + String(sh.tail).trim())
                    : null,
                  String(sh.cam || '').trim()
                    ? h('div', { className: 'dshic-shot-label', style: { marginTop: 2, opacity: 0.85 } }, '🎥 ' + String(sh.cam).trim())
                    : null,
                  (sh.dialogue || []).length
                    ? h('div', { className: 'dshic-shot-label', style: { marginTop: 3 } }, '台词 ' + sh.dialogue.map((d) => `${d.role}：${d.line}`).join('；'))
                    : null,
                  String(sh.sfx || '').trim()
                    ? h('div', { className: 'dshic-shot-label', style: { marginTop: 2, opacity: 0.85 } }, '音效 ' + String(sh.sfx).trim())
                    : null,
                );
                }),
              ),
              h('div', { key: 'grip', className: 'dshic-shot-grip', title: T('resizeList'), onPointerDown: startResize }, '⌟'),
            )
          : null,
        shots.length
          ? h('div', { key: 'acts', className: 'dshic-node-row', style: { alignSelf: 'flex-start' } },
              h('button', {
                key: 'copy', type: 'button', className: 'dshic-mini is-ghost', title: T('copyAll'),
                onPointerDown: (e) => e.stopPropagation(),
                onClick: async () => {
                  try { await navigator.clipboard.writeText(storyboardAssetText(shots)); toast(T('copiedOk')); }
                  catch { toast(T('copyFail')); }
                },
              }, T('copyAll')),
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
        const videoGen = mk('video-gen', baseX + 360, baseY + 20, { prompt: '', duration: Math.max(1, Math.round(total)) });
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
      const [voiceDlg, setVoiceDlg] = useState(false);
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
                h('button', {
                  type: 'button', className: 'dshic-mini is-ghost', title: T('voiceExtractBtn'),
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: () => setVoiceDlg(true),
                }, Ic('audio', 11), T('voiceExtractBtn')),
                h('div', { className: 'dshic-flex' })),
            ]
          : null,
        voiceDlg && (n.data.fcAssetId || n.data.assetId) ? h(VoiceExtractDialog, { key: 'vcdlg', nodeId: n.id, onClose: () => setVoiceDlg(false) }) : null,
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
        h(Btn, { onClick: () => update((s) => { s.supportOpen = true; }), title: T('supportBtn') }, Ic('help', 13), T('supportBtn')),
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
        if (!S.store) {
          // IndexedDB 模式（未设数据目录）：本地逐个清理
          try {
            const recs = await idbByProjectRaw(pid);
            for (const r of recs) {
              try { await idbDelete(r.id); } catch { /* 逐个容错 */ }
            }
          } catch { /* 资产清理失败不影响项目删除 */ }
        } else {
          assetMem.clear(); // 服务端随项目删除资产行；清本地元数据缓存
        }
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
      const [qDeb, setQDeb] = useState('');
      const [total, setTotal] = useState(0);
      const [cursor, setCursor] = useState(null);
      const [craftFor, setCraftFor] = useState(null);
      const [delTarget, setDelTarget] = useState(null); // 待确认删除的资产（确认框见 DeleteAssetModal）
      const [assetName, setAssetName] = useState(''); // 删除确认框的输入内容
      const fileRef = useRef(null);
      // 搜索防抖：0.18 起检索在服务端（SQLite trigram 中文全文索引）
      useEffect(() => {
        const t = setTimeout(() => setQDeb(search), 300);
        return () => clearTimeout(t);
      }, [search]);
      useEffect(() => {
        probeCraft();
        let ok = true;
        (async () => {
          try {
            if (!S.store) {
              // IndexedDB 模式（未设数据目录）：本地全量
              let list;
              if (scope === 'all') list = await idbAll();
              else list = (await idbAll()).filter((a) => a.projectId === scope || a.projectId === GENERAL_PID);
              if (ok) { setAssets(list); setTotal(list.length); setCursor(null); }
              return;
            }
            // 服务端分页：首屏 50 条，滚动到底「加载更多」
            const r = await hostRpc('assetsList', {
              projectId: scope === 'all' ? '' : scope,
              category: filter === 'all' ? '' : filter,
              q: qDeb.trim(), limit: 50, cursor: null,
            }).catch(() => null);
            if (ok && r) { setAssets(r.items || []); setTotal(r.total || 0); setCursor(r.nextCursor || null); }
          } catch { if (ok) setAssets([]); }
        })();
        return () => { ok = false; };
      }, [S.activeId, tick, S.assetsTick, scope, filter, qDeb, S.store]);
      const loadMore = async () => {
        if (!cursor) return;
        const r = await hostRpc('assetsList', {
          projectId: scope === 'all' ? '' : scope,
          category: filter === 'all' ? '' : filter,
          q: qDeb.trim(), limit: 50, cursor,
        }).catch(() => null);
        if (!r) return;
        setAssets((prev) => prev.concat(r.items || []));
        setCursor(r.nextCursor || null);
      };
      const projectName = (pid) => {
        if (pid === GENERAL_PID) return T('generalProject');
        const p = S.projects.find((x) => x.id === pid);
        return p ? p.name : '';
      };
      /** 资产改所属项目（通用/其它项目）：通用资产多项目共用。 */
      const moveAsset = async (a, targetPid) => {
        if (!targetPid || targetPid === (a.projectId || '')) return;
        if (S.store) {
          try {
            const r = await hostRpc('assetUpdate', { id: a.id, patch: { projectId: targetPid } });
            if (r && r.asset) assetMem.set(r.asset.id, r.asset);
          } catch { /* 服务端失败不动本地 */ }
        } else {
          const rec = await idbGet(a.id);
          if (!rec) return;
          rec.projectId = targetPid;
          await idbPut(rec);
        }
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
        if (S.store) hostRpc('assetUpdate', { id: a.id, patch: { category } }).catch(() => {});
        else idbPut(a).catch(() => {});
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
        // 服务端删除（SQL：行 + FTS + CAS 引用计数；JSON：文件 + assets.json），随后清本地缓存
        const proj = S.projects.find((p) => p.id === (a.projectId || S.activeId));
        try {
          await hostRpc('assetDelete', { projectId: a.projectId || S.activeId, projectName: (proj && proj.name) || '', id: a.id, rel: a.rel || '' });
        } catch { /* 磁盘/索引清理失败不阻塞 */ }
        try { await idbDelete(a.id); } catch { /* 本地无记录则忽略 */ }
        assetMem.delete(a.id);
        update((s) => {
          for (const nd of Object.values(s.graph.nodes)) {
            const d = nd.data;
            if (!d) continue;
            if (d.assetId === a.id) { d.assetId = null; d.status = 'idle'; }
            if (d.lastAssetId === a.id) d.lastAssetId = null; // 尾帧引用同步清理
            if (Array.isArray(d.history) && d.history.some((x) => x.assetId === a.id)) d.history = d.history.filter((x) => x.assetId !== a.id); // 历史条同步清理
          }
          s.assetsTick++;
        });
        setTick((x) => x + 1);
      };
      // 资产重命名：服务端写回（SQL/JSON 各自落库）+ 刷新名称缓存（@引用与连线名称都吃这份缓存）
      const rename = async (a, name) => {
        if (S.store) {
          try {
            const r = await hostRpc('assetUpdate', { id: a.id, patch: { name } });
            if (r && r.asset) assetMem.set(r.asset.id, r.asset);
          } catch { /* 服务端失败时仍更新本地缓存保持 UI 一致 */ }
        } else {
          const rec = await idbGet(a.id);
          if (!rec) return;
          rec.name = name;
          await idbPut(rec);
        }
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
        cursor
          ? h('button', { key: 'more', type: 'button', className: 'dshic-mini', style: { alignSelf: 'flex-start' }, onClick: loadMore, onPointerDown: (e) => e.stopPropagation() },
              '加载更多 / Load more（' + assets.length + ' / ' + total + '）')
          : null,
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
          (a.kind === 'image' || a.kind === 'video')
            ? h('button', {
                type: 'button', className: 'dshic-iconbtn', title: T('zoomView'),
                onClick: (e) => { e.stopPropagation(); openLightbox(a.kind, url, a.name); },
                onPointerDown: (e) => e.stopPropagation(),
              }, Ic('expandAll', 11))
            : null,
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
    function Field({ label, value, onChange, placeholder, password, tip }) {
      // 敏感字段（API Key）：默认脱敏，点击小眼睛切换明文显示
      const [reveal, setReveal] = useState(false);
      if (!password) {
        return h('div', { className: 'dshic-field' },
          h('span', { className: 'dshic-field-label' }, label, tip ? InfoTip(tip) : null),
          h('input', {
            className: 'dshic-input', type: 'text', value, placeholder: placeholder || '',
            onChange: (e) => onChange(e.target.value),
            onPointerDown: (e) => e.stopPropagation(),
          }));
      }
      return h('div', { className: 'dshic-field' },
        h('span', { className: 'dshic-field-label' }, label),
        h('div', { style: { position: 'relative', display: 'flex', alignItems: 'center' } },
          h('input', {
            className: 'dshic-input', type: reveal ? 'text' : 'password', value, placeholder: placeholder || '',
            style: { paddingRight: 30 },
            onChange: (e) => onChange(e.target.value),
            onPointerDown: (e) => e.stopPropagation(),
          }),
          h('button', {
            type: 'button', className: 'dshic-iconbtn',
            title: reveal ? T('hideKey') : T('showKey'),
            'aria-label': reveal ? T('hideKey') : T('showKey'),
            style: { position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', width: 22, height: 22 },
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => setReveal((v) => !v),
          }, reveal ? Ic('eyeOff', 12) : Ic('eye', 12)),
        ));
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
              kind === 'video' ? h('div', { key: 'vendor', className: 'dshic-field' },
                h('div', { className: 'dshic-row' },
                  h('span', { className: 'dshic-field-label' }, T('vendorLabel')),
                  InfoTip((VIDEO_VENDORS[detectVideoVendor(p)] || {}).note || '')),
                h('select', {
                  className: 'dshic-select', value: detectVideoVendor(p),
                  onPointerDown: (e) => e.stopPropagation(),
                  onChange: (e) => { const v = e.target.value; const vd = VIDEO_VENDORS[v]; patchProvider(p.id, 'vendor', v); if (vd && vd.base && !p[urlKey]) patchProvider(p.id, urlKey, vd.base); },
                },
                  Object.entries(VIDEO_VENDORS).map(([id, vd]) => h('option', { key: id, value: id }, vd.label))),
              ) : null,
              h(Field, { key: 'u', label: T('baseUrl'), value: p[urlKey] || '', onChange: (v) => patchProvider(p.id, urlKey, v), placeholder: kind === 'video' ? ((VIDEO_VENDORS[detectVideoVendor(p)] || {}).base || urlPh) : urlPh }),
              h(Field, { key: 'k', label: T('apiKey'), value: p.apiKey || '', onChange: (v) => patchProvider(p.id, 'apiKey', v), placeholder: kind === 'video' ? ((VIDEO_VENDORS[detectVideoVendor(p)] || {}).keyPh || 'sk-…') : 'sk-…', password: true }),
              kind === 'image' ? [
                h(Field, { key: 'size', label: T('imgSizeOverride'), value: p.size || '', onChange: (v) => patchProvider(p.id, 'size', v), placeholder: T('imgSizePlaceholder') }),
                h(Field, { key: 'rf', label: T('imgResponseFormat'), value: p.responseFormat || '', onChange: (v) => patchProvider(p.id, 'responseFormat', v), placeholder: 'b64_json / url（留空=API 默认）' }),
                h('div', { key: 'mode', className: 'dshic-field' },
                  h('span', { className: 'dshic-field-label' }, T('imgMode')),
                  h('select', { className: 'dshic-select', value: p.mode || 'generations', onChange: (e) => patchProvider(p.id, 'mode', e.target.value), onPointerDown: (e) => e.stopPropagation() },
                    h('option', { value: 'generations' }, T('modeGenerations')),
                    h('option', { value: 'edits' }, T('modeEdits')),
                    h('option', { value: 'compshare' }, T('modeCompshare')))),
              ] : [
                (detectVideoVendor(p) === 'openai' || detectVideoVendor(p) === 'seedance') ? h(Field, { key: 'of', label: T('vidOutFormat'), value: p.outputFormat || '', onChange: (v) => patchProvider(p.id, 'outputFormat', v), placeholder: 'mp4（留空不发送）' }) : null,
                (detectVideoVendor(p) === 'openai' || detectVideoVendor(p) === 'seedance') ? h('label', { key: 'ga', className: 'dshic-row', style: { gap: 6, fontSize: 11 } },
                  h('input', { type: 'checkbox', checked: p.generateAudio === true, onChange: (e) => patchProvider(p.id, 'generateAudio', e.target.checked), onPointerDown: (e) => e.stopPropagation() }),
                  h('span', {}, T('vidAudioOpt'))) : null,
              ],
              (kind === 'image' || kind === 'video') ? [
                h(Field, { key: 'extra', label: T('cfgExtra'), value: p.extra || '', onChange: (v) => patchProvider(p.id, 'extra', v), placeholder: '{"watermark":false,"prompt_extend":false}', tip: T('cfgExtraHint') }),
              ] : null,
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
                ? h(Field, { key: 'extra', label: T('cfgExtra'), value: cfg.extra || '', onChange: (v) => patch(cfg.id, 'extra', v), placeholder: '{"watermark":false,"prompt_extend":false}', tip: T('cfgExtraHint') })
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
      const [stats, setStats] = useState(null); // 存储实况：是否真在用 SQLite、库在哪、多少数据
      const loadStats = () => { hostRpc('dbStats').then((r) => setStats(r || null)).catch(() => setStats({ error: true })); };
      useEffect(() => { if (S.dataRoot) setVal(S.dataRoot); }, [S.dataRoot]);
      useEffect(() => { loadStats(); }, [S.dataRoot, S.assetsTick]);
      const save = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const same = S.dataRoot && val.trim() && S.dataRoot === val.trim().replace(/[\\/]+$/, '');
          await hostRpc('dataRootSet', { root: val.trim() });
          await refreshDataRoot();
          toast(T('dataRootSaved') + (S.dataRoot ? '：' + S.dataRoot : ''));
          if (same) { setBusy(false); return; } // 同目录重复保存：不重复迁移
          autoMigrateAssetsToRoot(); // 换了目录：把本地遗留 blob 搬进新目录（v1 旧布局由 Host 侧自动迁移）
          assetMem.clear();
          update((s) => { s.assetsTick++; });
        } catch (e) { toast('设置失败：' + ((e && e.message) || e)); }
        setBusy(false);
      };
      const applyRoot = async (root) => {
        const same = S.dataRoot && root && S.dataRoot === String(root).replace(/[\\/]+$/, '');
        await hostRpc('dataRootSet', { root });
        await refreshDataRoot();
        setVal(S.dataRoot || root);
        toast(T('dataRootSaved') + '：' + S.dataRoot);
        if (same) return; // 同目录：不重复迁移
        autoMigrateAssetsToRoot(); // 换了目录：把本地遗留 blob 搬进新目录
        assetMem.clear();
        update((s) => { s.assetsTick++; });
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
          if (!S.dataRoot) { await refreshDataRoot(); } // 未就绪先拉一次；仍无目录才提示（不必先点"设置此目录"）
          if (!S.dataRoot) { toast(T('dataRootHint')); setBusy(false); return; }
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
              h('div', { className: 'dshic-row', key: 'stats', style: { alignItems: 'center', gap: 6 } },
                h('span', { className: 'dshic-hint', style: { flex: 1, minWidth: 0 } },
                  !stats ? '存储实况：读取中…'
                    : stats.error ? '存储实况：无法读取（后端未提供该接口）'
                    : (stats.store === 'sqlite'
                      ? '存储实况：SQLite 库' + (stats.dbExists ? '（' + (stats.dbBytes / 1048576).toFixed(2) + ' MB' + (stats.walBytes ? ' + WAL ' + (stats.walBytes / 1048576).toFixed(2) + ' MB' : '') + '）' : '（未创建）') + ' · ' + stats.projects + ' 项目 · ' + stats.assets + ' 资产 · 检索 ' + (stats.fts || '-')
                      : stats.store === 'json'
                        ? '存储实况：JSON 降级模式（宿主运行时缺 node:sqlite，数据仍在数据目录的文件里）'
                        : '存储实况：未设置数据目录（资产存浏览器本地 IndexedDB）')),
                h('button', {
                  type: 'button', className: 'dshic-mini is-ghost', title: '重新检测存储实况',
                  onPointerDown: (e) => e.stopPropagation(), onClick: loadStats,
                }, '↻'),
              ),
              stats && stats.dbPath ? h('div', { key: 'dbpath', className: 'dshic-hint' }, '库文件：' + stats.dbPath) : null,
              h('div', { className: 'dshic-row', key: 'row2' },
                S.dataRoot ? h('button', { type: 'button', className: 'dshic-mini', onPointerDown: (e) => e.stopPropagation(), onClick: openDir }, T('dataRootOpen')) : null,
                h('button', { type: 'button', className: 'dshic-mini is-ghost', disabled: busy || picking, title: T('dataRootImportHint'), onPointerDown: (e) => e.stopPropagation(), onClick: importFromRoot }, Ic('folder', 11), T('dataRootImportBtn')),
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
        // 帮助与反馈：一行入口（点开弹窗看二维码与提 Issue）
        h('div', {
          key: 'support', className: 'dshic-card', style: { cursor: 'pointer' },
          onClick: () => update((s) => { s.supportOpen = true; }),
        },
          h('div', { className: 'dshic-row' },
            Ic('help', 12),
            h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0 } }, T('supportBtn')),
            h('span', { className: 'dshic-hint', style: { flex: 'none' } }, T('supportIssues') + ' / ' + T('supportWechat') + ' ›'),
          ),
        ),
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
                className: 'dshic-marquee', style: { display: 'none', zIndex: 9999 },
                ref: (el) => { marqueeEl = el; },
              }),
              h('div', { className: 'dshic-guide-v', style: { display: 'none', zIndex: 9999 }, ref: (el) => { vGuidEl = el; } }),
              h('div', { className: 'dshic-guide-h', style: { display: 'none', zIndex: 9999 }, ref: (el) => { hGuidEl = el; } }),
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
        S.lightbox ? h(Lightbox) : null,
        S.supportOpen ? h(SupportDialog) : null,
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
    // 灯箱：图片/视频放大查看（节点预览与资产面板共用）
    // ============================================================
    function openLightbox(kind, url, name) {
      if (!url) return;
      update((s) => { s.lightbox = { kind, url, name: String(name || '') }; });
    }
    function closeLightbox() {
      update((s) => { s.lightbox = null; });
    }
    function Lightbox() {
      const lb = S.lightbox;
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') closeLightbox(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);
      return h('div', { className: 'dshic-lightbox', onPointerDown: (e) => { if (e.target === e.currentTarget) closeLightbox(); } },
        h('div', { className: 'dshic-lightbox-cap' }, (lb.name ? lb.name + ' · ' : '') + T('lbHint')),
        lb.kind === 'video'
          ? h('video', { src: lb.url, controls: true, preload: 'metadata', style: { maxWidth: '92vw', maxHeight: '80vh' } })
          : h('img', { src: lb.url, draggable: false, style: { maxWidth: '92vw', maxHeight: '80vh', objectFit: 'contain' } }),
        h('button', { type: 'button', className: 'dshic-mini is-ghost', style: { color: '#eee', borderColor: 'rgba(255,255,255,.35)' }, onClick: closeLightbox }, '✕'),
      );
    }

    // ============================================================
    // 帮助与反馈：GitHub 仓库/Issue + 微信交流群二维码（插件静态资源）
    // ============================================================
    const SUPPORT_GITHUB = 'https://github.com/NINKCH/dsh-infinite_canvas';
    const SUPPORT_ISSUES = 'https://github.com/NINKCH/dsh-infinite_canvas/issues/new';
    const SUPPORT_QR_URL = '/' + NS + '/api/plugin-asset?rel=' + encodeURIComponent('assets/support/wechat.png');
    function copyText(text, okMsg) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(() => toast(okMsg)).catch(() => toast(text)); return; }
      } catch { /* 降级 */ }
      toast(text);
    }
    function SupportDialog() {
      const [qrFailed, setQrFailed] = useState(false);
      const close = () => update((s) => { s.supportOpen = false; });
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);
      return h('div', { className: 'dshic-modal-overlay', onPointerDown: (e) => { if (e.target === e.currentTarget) close(); } },
        h('div', { className: 'dshic-modal', style: { width: 300, alignItems: 'center', textAlign: 'center' } },
          h('div', { className: 'dshic-modal-title' }, T('supportTitle')),
          h('div', { className: 'dshic-modal-warn', style: { marginTop: 6 } }, T('supportNote')),
          h('div', { style: { marginTop: 10 } },
            qrFailed
              ? h('div', { className: 'dshic-hint' }, T('supportQrMissing'))
              : h('img', {
                  src: SUPPORT_QR_URL, alt: 'WeChat group QR', draggable: false,
                  style: { width: 180, height: 180, objectFit: 'contain', borderRadius: 8, background: '#fff', padding: 6 },
                  onError: () => setQrFailed(true),
                })),
          h('div', { className: 'dshic-hint', style: { marginTop: 6 } }, T('supportWechatHint')),
          h('button', {
            type: 'button', className: 'dshic-mini is-ghost', style: { marginTop: 10 },
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => { try { window.open(SUPPORT_ISSUES, '_blank'); } catch { copyText(SUPPORT_ISSUES, T('supportCopied')); } },
          }, T('supportIssues') + ' ↗'),
          h('div', { className: 'dshic-modal-actions', style: { marginTop: 8, justifyContent: 'center' } },
            h('button', { type: 'button', className: 'dshic-mini', onPointerDown: (e) => e.stopPropagation(), onClick: close }, T('supportClose')),
          ),
        ));
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
          // 数据根目录（Host 旧版静默降级为 IndexedDB 模式）；就绪后把本地遗留 blob 搬进服务端（v1 旧布局由 Host 侧自动迁移）
          refreshDataRoot().then(() => autoMigrateAssetsToRoot()).catch(() => { /* 静默 */ });
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

