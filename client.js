window.__ModuleLoader__.load({
  id: '@local/infinite-canvas',
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
    const DB_STORE = 'assets';
    const NODE_W = 240;

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
      'storyboard': { inputs: [{ id: 'script', kind: 'text' }], outputs: [] },
      'image-gen': {
        inputs: [{ id: 'prompt', kind: 'text' }, { id: 'ref', kind: 'image' }],
        outputs: [{ id: 'out', kind: 'image' }],
      },
      'video-gen': {
        inputs: [{ id: 'prompt', kind: 'text' }, { id: 'frame', kind: 'image' }],
        outputs: [{ id: 'out', kind: 'video' }],
      },
      'image-asset': { inputs: [{ id: 'in', kind: 'image' }], outputs: [{ id: 'out', kind: 'image' }] },
      'video-asset': { inputs: [{ id: 'in', kind: 'video' }], outputs: [{ id: 'out', kind: 'video' }] },
      'finalcut': { inputs: [{ id: 'in', kind: 'video' }], outputs: [] },
    };
    // 允许多条入线的输入端口（参考图类），其余输入端口保持单线
    const MULTI_INPUT_PORTS = new Set(['ref', 'char', 'scene', 'prop']);
    // 分镜端口期望的资产分类（仅用于连接时的非阻断提示）
    const PORT_CATEGORY = { char: 'character', scene: 'scene', prop: 'prop' };
    const CATEGORIES = ['character', 'scene', 'prop', 'script', 'storyboard', 'general'];
    const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
    const IMAGE_SIZES = ['1K', '2K', '4K'];
    const VIDEO_DURATIONS = [4, 5, 6, 8, 10];
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
      'expandDone': '已铺开 {n} 个分镜到画布',
      'aiNeedScript': '请先连接或填写剧本',
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
      'expandDone': 'Expanded {n} shots onto the canvas',
      'aiNeedScript': 'Connect or paste a script first',
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
  cursor:grab;min-height:96px;}
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
.dshic-node-body{padding:8px;display:flex;flex-direction:column;gap:6px;font-size:12px;}
.dshic-textarea{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);
  border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;
  line-height:18px;padding:6px 8px;outline:none;user-select:text;-webkit-user-select:text;cursor:text;}
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
  border:2px solid var(--dsw-alias-label-secondary);cursor:crosshair;z-index:5;box-sizing:border-box;padding:0;}
.dshic-port.k-image{border-color:var(--dsw-alias-brand-primary);}
.dshic-port.k-video{border-color:var(--dsw-alias-state-success-primary);}
.dshic-port:hover,.dshic-port.is-active{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent);}
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
.dshic-modal-name{font-weight:600;color:var(--dsw-alias-label-primary);}
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
  font:inherit;font-size:11px;line-height:15px;padding:6px 7px;overflow:hidden;text-align:left;display:block;white-space:pre-wrap;}
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
      textLlm: { provider: '', model: '' },
      imageApis: [],   // [{id, name, baseUrl, apiKey, model, mode}]
      videoApis: [],   // [{id, name, url, apiKey, model}]
      imageApiId: '',
      videoApiId: '',
      lang: '',        // '' = 跟随 Harness
      skillScript: '',       // '' = 内置编剧专家
      skillStoryboard: '',   // '' = 内置分镜专家
    };
    function loadSettings() {
      const s = lsGet(LS_SETTINGS, {}) || {};
      const out = {
        textLlm: { ...DEFAULT_SETTINGS.textLlm, ...(s.textLlm || {}) },
        imageApis: Array.isArray(s.imageApis) ? s.imageApis : [],
        videoApis: Array.isArray(s.videoApis) ? s.videoApis : [],
        imageApiId: s.imageApiId || '',
        videoApiId: s.videoApiId || '',
        lang: s.lang || '',
        skillScript: s.skillScript || '',
        skillStoryboard: s.skillStoryboard || '',
      };
      // v0.3 及以前的单配置自动迁移为列表
      if (!out.imageApis.length && s.imageApi && s.imageApi.baseUrl) {
        out.imageApis = [{
          id: uid('cfg'), name: T('defaultImageCfg'),
          baseUrl: s.imageApi.baseUrl || '', apiKey: s.imageApi.apiKey || '',
          model: s.imageApi.model || '', mode: s.imageApi.mode || 'generations',
        }];
        out.imageApiId = out.imageApis[0].id;
      }
      if (!out.videoApis.length && s.videoApi && s.videoApi.url) {
        out.videoApis = [{
          id: uid('cfg'), name: T('defaultVideoCfg'),
          url: s.videoApi.url || '', apiKey: s.videoApi.apiKey || '', model: s.videoApi.model || '',
        }];
        out.videoApiId = out.videoApis[0].id;
      }
      return out;
    }
    function saveSettings(s) { lsSet(LS_SETTINGS, s); }

    function emptyGraph() { return { nodes: {}, edges: [], view: { x: 60, y: 40, scale: 1 } }; }
    function loadGraphDoc(pid) { return lsGet(LS_GRAPH + pid, null); }
    function saveGraphDoc(pid, graph) { lsSet(LS_GRAPH + pid, graph); }

    // ============================================================
    // 项目设定集（Series Bible）：跨集/跨镜一致性的唯一事实源
    // ============================================================
    const LS_BIBLE = 'dsh-ic:bible:';
    function emptyBible() { return { style: '', characters: [], scenes: [], props: [] }; }
    function loadBible(pid) {
      if (!pid) return emptyBible();
      const b = lsGet(LS_BIBLE + pid, null);
      if (!b) return emptyBible();
      return {
        style: b.style || '',
        characters: Array.isArray(b.characters) ? b.characters : [],
        scenes: Array.isArray(b.scenes) ? b.scenes : [],
        props: Array.isArray(b.props) ? b.props : [],
      };
    }
    function saveBible(pid, b) { if (pid) lsSet(LS_BIBLE + pid, b); }
    function bibleBlock(b) {
      if (!b) return '';
      const lines = [];
      if ((b.style || '').trim()) lines.push('风格基调：' + b.style.trim());
      for (const c of b.characters || []) if ((c.name || '').trim()) lines.push(`角色 ${c.name.trim()}：${(c.desc || '').trim()}`);
      for (const c of b.scenes || []) if ((c.name || '').trim()) lines.push(`场景 ${c.name.trim()}：${(c.desc || '').trim()}`);
      for (const c of b.props || []) if ((c.name || '').trim()) lines.push(`道具 ${c.name.trim()}：${(c.desc || '').trim()}`);
      return lines.join('\n');
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
    async function assetUrl(id) {
      if (!id) return null;
      if (assetUrlCache.has(id)) return assetUrlCache.get(id);
      const rec = await idbGet(id);
      if (!rec || !rec.blob) return null;
      const url = URL.createObjectURL(rec.blob);
      assetUrlCache.set(id, url);
      return url;
    }
    async function saveAssetRecord(projectId, kind, blob, meta) {
      const rec = {
        id: uid('a'), projectId, kind,
        mime: blob.type || (kind === 'image' ? 'image/png' : 'video/webm'),
        name: (meta && meta.name) || (kind === 'image' ? 'image' : 'video') + '-' + Date.now().toString(36),
        blob,
        createdAt: Date.now(),
        prompt: (meta && meta.prompt) || '',
        source: (meta && meta.source) || 'demo',
        category: (meta && meta.category) || 'general',
      };
      await idbPut(rec);
      return rec;
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

    async function apiImage(prompt, refBlobs, s, opts) {
      if (!s.baseUrl) throw new Error('未配置图片 API');
      const base = s.baseUrl.replace(/\/+$/, '');
      const refs = refBlobs || [];
      const auth = s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {};
      // 参考图编辑模式：multipart 上传到 /images/edits（OpenAI gpt-image-1 兼容）
      if (refs.length && s.mode === 'edits') {
        const fd = new FormData();
        if (s.model) fd.append('model', s.model);
        fd.append('prompt', prompt);
        fd.append('n', '1');
        if (s.size) fd.append('size', s.size);
        refs.forEach((b, i) => fd.append('image[]', b, 'ref-' + i + '.png'));
        const res = await fetch(base + '/images/edits', { method: 'POST', headers: auth, body: fd });
        if (!res.ok) throw new Error('图片编辑 API HTTP ' + res.status + '：' + (await res.text()).slice(0, 300));
        const j = await res.json();
        const d = j && j.data && j.data[0];
        if (d && d.b64_json) return base64ToBlob(d.b64_json, 'image/png');
        if (d && d.url) {
          const r2 = await fetch(d.url);
          if (!r2.ok) throw new Error('下载生成图片失败 HTTP ' + r2.status);
          return await r2.blob();
        }
        throw new Error('图片编辑 API 响应中没有 data[0].b64_json / url');
      }
      const body = {
        ...(s.model ? { model: s.model } : {}),
        prompt, n: 1,
        response_format: 'b64_json',
      };
      // 分辨率 × 比例 → 像素尺寸（WxH），节点上可调
      const dims = imageDimsFor(opts);
      body.size = `${dims.w}x${dims.h}`;
      // 文生图模式下参考图以扩展字段附带，由网关自行取舍
      if (refs.length) body.images = await Promise.all(refs.map((b) => blobToDataUrl(b)));
      const res = await fetch(base + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('图片 API HTTP ' + res.status + '：' + (await res.text()).slice(0, 300));
      const j = await res.json();
      const d = j && j.data && j.data[0];
      if (d && d.b64_json) return base64ToBlob(d.b64_json, 'image/png');
      if (d && d.url) {
        const r2 = await fetch(d.url);
        if (!r2.ok) throw new Error('下载生成图片失败 HTTP ' + r2.status);
        return await r2.blob();
      }
      throw new Error('图片 API 响应中没有 data[0].b64_json / url');
    }

    function extractVideoUrl(j) {
      if (typeof j === 'string' && /^https?:/.test(j)) return j;
      if (!j || typeof j !== 'object') return null;
      const cands = [
        j.video_url, j.videoUrl, j.url,
        j.video && j.video.url,
        j.output && (j.output.url || j.output.video_url),
        j.result && (j.result.url || j.result.video_url),
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
    async function downloadVideo(url, headers) {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error('下载视频失败 HTTP ' + r.status);
      return await r.blob();
    }
    async function apiVideo(prompt, frameBlob, s, opts) {
      if (!s.url) throw new Error('未配置视频 API');
      const base = s.url.replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}) };
      const o = opts || {};
      const body = {
        ...(s.model ? { model: s.model } : {}),
        prompt,
        duration: Number(o.duration) || 5,
        resolution: o.resolution || '720P',
        ratio: o.ratio || '16:9',
      };
      if (frameBlob) {
        try { body.image = await blobToDataUrl(frameBlob); } catch { /* 忽略首帧编码失败 */ }
      }
      const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('视频 API HTTP ' + res.status + '：' + (await res.text()).slice(0, 300));
      let j = null;
      try { j = await res.json(); } catch { /* 非 JSON 响应 */ }
      const direct = extractVideoUrl(j);
      if (direct) return await downloadVideo(direct, {});
      const taskId = extractTaskId(j);
      if (!taskId) throw new Error('视频 API 响应中没有任务 id 或视频地址');
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(3000);
        const r2 = await fetch(base + '/' + taskId, { headers });
        if (!r2.ok) throw new Error('查询视频任务失败 HTTP ' + r2.status);
        let st = null;
        try { st = await r2.json(); } catch { /* 忽略 */ }
        const u = extractVideoUrl(st);
        if (u) return await downloadVideo(u, {});
        const raw = JSON.stringify(st || {}).toLowerCase();
        if (raw.includes('"fail') || raw.includes('"error"')) throw new Error('视频任务失败：' + raw.slice(0, 200));
      }
      throw new Error('视频生成超时（15 分钟）');
    }

    function resolveApiCfg(list, defId, wantId) {
      if (!Array.isArray(list) || !list.length) return null;
      return list.find((x) => x.id === wantId) || list.find((x) => x.id === defId) || list[0];
    }
    async function generateImage(prompt, refMetas, opts) {
      const settings = loadSettings();
      const cfg = resolveApiCfg(settings.imageApis, settings.imageApiId, opts && opts.apiId);
      const blobs = (refMetas || []).map((m) => (m && m.blob) ? m.blob : m);
      const blob = cfg ? await apiImage(prompt, blobs, cfg, opts || {}) : await demoImageBlob(prompt, blobs, imageDimsFor(opts));
      return { blob, demo: !cfg };
    }
    async function generateVideo(prompt, frameBlob, opts) {
      const settings = loadSettings();
      const cfg = resolveApiCfg(settings.videoApis, settings.videoApiId, opts && opts.apiId);
      const blob = cfg ? await apiVideo(prompt, frameBlob, cfg, opts || {}) : await demoVideoBlob(prompt, videoDimsFor(opts), ((opts && opts.duration) || 5) * 1000);
      return { blob, demo: !cfg };
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
        totalMs += isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : 8000;
        vids.push({ v, name: seg.name, sub: seg.sub || '', withAudio: seg.withAudio !== false, started: false, srcNode: null });
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
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate || 6000000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { rec.onstop = res; });
      rec.start(200);
      function startPlayback(item) {
        if (item.started) return;
        item.started = true;
        const v = item.v;
        const wantAudio = !!audio && opts.keepAudio !== false && item.withAudio;
        if (wantAudio) {
          v.muted = false; v.volume = 1;
          try { item.srcNode = audio.ac.createMediaElementSource(v); item.srcNode.connect(audio.dest); } catch { item.srcNode = null; }
        } else {
          v.muted = true;
        }
        try { v.currentTime = 0; } catch { /* 忽略 */ }
        const p = v.play();
        if (p && p.catch) p.catch(() => { /* 由安全超时兜底 */ });
      }
      function stopItem(item) {
        try { item.v.pause(); } catch { /* 忽略 */ }
        if (item.srcNode) { try { item.srcNode.disconnect(); } catch { /* 忽略 */ } item.srcNode = null; }
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
          const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
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
          const ended = v.ended || (dur > 0 && v.currentTime >= dur - 0.03);
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
    function videoDimsFor(opts) {
      const base = { '480P': 480, '720P': 720, '1080P': 1080 }[(opts && opts.resolution) || '720P'] || 720;
      const d = dimsFromRatio(opts && opts.ratio, base, base);
      // 演示合成性能保护：长边不超过 1280
      const long = Math.max(d.w, d.h);
      if (long > 1280) {
        const k = 1280 / long;
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
    async function aiComplete({ system, user, temperature, maxTokens, model }) {
      const settings = loadSettings();
      let provider;
      let modelId;
      if (model && String(model).includes('|')) {
        [provider, modelId] = String(model).split('|');
      } else {
        provider = settings.textLlm.provider || undefined;
        modelId = settings.textLlm.model || undefined;
      }
      const res = await hostRpc('llmComplete', {
        provider, model: modelId, system, user, temperature, maxTokens,
      });
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

    async function aiScriptNodes(idea, model) {
      const settings = loadSettings();
      const bible = bibleBlock(loadBible(S.activeId));
      const zh = effLang() !== 'en';
      const rules = await loadSkillRules(settings.skillScript, zh)
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
      return await aiComplete({ system, user, temperature: 0.7, maxTokens: 4000, model });
    }
    async function aiStoryboardShots(scriptText, requirement, count, model) {
      const settings = loadSettings();
      const bible = bibleBlock(loadBible(S.activeId));
      const zh = effLang() !== 'en';
      const jsonContract = zh
        ? [
            '把剧本拆解为用于「参考图生图 + 图生视频」管线的短剧分镜。',
            '只输出一个 JSON 对象：{"shots":[{"title":"…","visual":"…","motion":"…","characters":["…"],"scene":"…","props":["…"],"duration":5}]}。',
            '规则：',
            '- visual 是首帧静态画面描述（景别、人物外观与站位、场景、光线、构图，60 字内），供图片生成当提示词；',
            '- motion 是本镜动作与运镜（动作节拍、镜头运动、节奏，50 字内），供视频生成当提示词；两者不重复；',
            '- characters/scene/props 使用剧本与设定集中的名称，便于匹配资产；无道具给空数组；',
            '- duration 为该镜视频秒数，3-10 的整数；镜头之间保持剧情连续；',
            '- 只输出 JSON，不要输出任何其他内容。',
          ].join('\n')
        : [
            'Break the script into shots for a "reference-to-image first frame + image-to-video" pipeline.',
            'Output only one JSON object: {"shots":[{"title":"…","visual":"…","motion":"…","characters":["…"],"scene":"…","props":["…"],"duration":5}]}.',
            'Rules:',
            '- visual = static first-frame description (shot size, wardrobe, staging, light, framing, <=60 words) used as the image prompt;',
            '- motion = action & camera for the video prompt (<=50 words); do not repeat visual;',
            '- characters/scene/props must use names from the script and series bible so assets match; empty props array if none;',
            '- duration is seconds per shot, an integer 3-10; keep narrative continuity;',
            '- Output JSON only.',
          ].join('\n');
      const methodology = await loadSkillRules(settings.skillStoryboard, zh);
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
      const text = await aiComplete({ system, user, temperature: 0.5, maxTokens: 4000, model });
      const parsed = parseJsonBalanced(text);
      const shots = parsed && Array.isArray(parsed.shots) ? parsed.shots : null;
      if (!shots || !shots.length) throw new Error(T('errParseStoryboard'));
      return shots.slice(0, 24).map((s, i) => ({
        title: String(s.title || (T('shotPrefix') + (i + 1))).slice(0, 24),
        visual: String(s.visual || ''),
        motion: String(s.motion || ''),
        characters: Array.isArray(s.characters) ? s.characters.map(String).slice(0, 6) : [],
        scene: String(s.scene || ''),
        props: Array.isArray(s.props) ? s.props.map(String).slice(0, 6) : [],
        duration: Number.isFinite(Number(s.duration)) ? clamp(Math.round(Number(s.duration)), 3, 10) : 5,
      }));
    }
    /** 本地一致性检查：分镜里出现的角色/场景/道具名是否都能在设定集或图片资产中找到。 */
    async function checkShotConsistency(shots) {
      const bible = loadBible(S.activeId);
      const known = new Set();
      const addName = (n) => { const q = String(n || '').trim().toLowerCase(); if (q) known.add(q); };
      (bible.characters || []).forEach((c) => addName(c.name));
      (bible.scenes || []).forEach((c) => addName(c.name));
      (bible.props || []).forEach((c) => addName(c.name));
      try {
        const recs = await idbByProject(S.activeId);
        recs.forEach((r) => addName(r.name));
      } catch { /* 忽略 */ }
      const warnings = [];
      for (const sh of shots) {
        const items = [
          ...sh.characters.map((n) => [n, T('catCharacter')]),
          [sh.scene, T('catScene')],
          ...sh.props.map((n) => [n, T('catProp')]),
        ];
        for (const [nm, kind] of items) {
          const q = String(nm || '').trim().toLowerCase();
          if (!q) continue;
          if (![...known].some((k) => k.includes(q) || q.includes(k))) {
            warnings.push(`${sh.title} · ${kind}「${nm}」${T('warnUnregistered')}`);
          }
        }
      }
      return warnings.slice(0, 12);
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
      await idbPut(rec);
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
    };
    const listeners = new Set();
    let saveTimer = null;
    let commitViewTimer = null;

    function notify() { S.tick++; for (const fn of listeners) fn(); }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function update(fn, opts) {
      fn(S);
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
      V.x = S.graph.view.x; V.y = S.graph.view.y; V.scale = S.graph.view.scale;
      S.ready = true;
    }
    function switchProject(pid) {
      if (pid === S.activeId) return;
      flushSave();
      const doc = loadGraphDoc(pid) || emptyGraph();
      update((s) => {
        s.activeId = pid;
        s.graph = { nodes: doc.nodes || {}, edges: doc.edges || [], view: doc.view || { x: 60, y: 40, scale: 1 } };
        s.sel = new Set(); s.selEdge = null; s.running = false;
        V.x = s.graph.view.x; V.y = s.graph.view.y; V.scale = s.graph.view.scale;
        applyViewToDom();
      });
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
      update((s) => {
        s.graph.nodes = doc.nodes;
        s.graph.edges = doc.edges;
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
      return {
        id: uid('n'), type,
        x: Math.round(pos.x), y: Math.round(pos.y),
        w: NODE_W, h: 96 + portRows * 4,
        data,
      };
    }
    function addNodeAt(type, pos) {
      const n = newNode(type, pos);
      update((s) => { s.graph.nodes[n.id] = n; s.sel = new Set([n.id]); s.selEdge = null; });
      pushHistory();
      return n;
    }
    function removeNodes(ids) {
      update((s) => {
        for (const id of ids) delete s.graph.nodes[id];
        s.graph.edges = s.graph.edges.filter((e) => !ids.includes(e.fromNode) && !ids.includes(e.toNode));
        s.sel = new Set([...s.sel].filter((x) => ids.includes(x) === false));
        if (s.selEdge && !s.graph.edges.some((e) => e.id === s.selEdge)) s.selEdge = null;
      });
      pushHistory();
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
        script: T('nScript'), storyboard: T('nStoryboard'), general: T('catGeneral'),
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
        }
      }
      return (n.data.prompt || '').trim();
    }
    async function resolveAssetBlob(nodeId, portId) {
      const e = S.graph.edges.find((x) => x.toNode === nodeId && x.toPort === portId);
      if (!e) return null;
      const src = S.graph.nodes[e.fromNode];
      if (!src || !src.data.assetId) return null;
      const rec = await idbGet(src.data.assetId);
      return rec ? rec.blob : null;
    }
    // 多参考图：收集接入 ref / char / scene / prop 端口的全部图片（带名称与分类，用于提示词绑定）
    async function resolveRefBlobs(nodeId, portId) {
      const metas = await resolveRefMetas(nodeId, portId);
      return metas.map((m) => m.blob);
    }
    async function resolveRefMetas(nodeId, portId) {
      const es = S.graph.edges.filter((x) => x.toNode === nodeId && x.toPort === portId);
      const metas = [];
      for (const e of es) {
        const src = S.graph.nodes[e.fromNode];
        if (!src || !src.data.assetId) continue;
        try {
          const rec = await idbGet(src.data.assetId);
          if (rec && rec.blob) metas.push({ blob: rec.blob, name: rec.name || '', category: rec.category || 'general' });
        } catch { /* 单个参考图读取失败不影响其余 */ }
      }
      return metas;
    }

    // ============================================================
    // 工作流执行
    // ============================================================
    const cancelRef = { cancelled: false };

    async function runGenNode(n) {
      const type = n.type;
      update((s) => {
        const nd = s.graph.nodes[n.id];
        if (nd) { nd.data.status = 'running'; nd.data.error = null; }
      });
      try {
        const prompt = resolvePrompt(n);
        if (type === 'image-gen') {
          const metas = await resolveRefMetas(n.id, 'ref');
          const bible = loadBible(S.activeId);
          const bibleDesc = (cat, name) => {
            const key = cat === 'character' ? 'characters' : cat === 'scene' ? 'scenes' : 'props';
            const hit = (bible[key] || []).find((x) => (x.name || '').trim() === String(name || '').trim());
            return hit && hit.desc ? hit.desc.trim() : '';
          };
          const bind = metas.map((m, i) => {
            const d = bibleDesc(m.category, m.name);
            return `[${T('refCount')}${i + 1}] ${catLabel(m.category)}：${m.name}${d ? '（' + d + '）' : ''}`;
          }).join('；');
          const p = [
            (bible.style || '').trim() ? '风格：' + bible.style.trim() : '',
            bind ? `${T('refCount')} → ${bind}` : '',
            prompt,
          ].filter(Boolean).join('\n');
          const { blob, demo } = await generateImage(p, metas, { size: n.data.size, ratio: n.data.ratio, apiId: n.data.imageApiId });
          const rec = await saveAssetRecord(S.activeId, 'image', blob, { prompt, source: demo ? 'demo' : 'api' });
          commitGenResult(n.id, rec.id, demo, 'image');
        } else {
          const frameBlob = await resolveAssetBlob(n.id, 'frame');
          const bible = loadBible(S.activeId);
          const p = [
            (bible.style || '').trim() ? '风格：' + bible.style.trim() : '',
            prompt,
          ].filter(Boolean).join('\n');
          const { blob, demo } = await generateVideo(p, frameBlob, {
            duration: n.data.duration, resolution: n.data.resolution, ratio: n.data.ratio, apiId: n.data.videoApiId,
          });
          const rec = await saveAssetRecord(S.activeId, 'video', blob, { prompt, source: demo ? 'demo' : 'api' });
          commitGenResult(n.id, rec.id, demo, 'video');
        }
        return true;
      } catch (err) {
        update((s) => {
          const nd = s.graph.nodes[n.id];
          if (nd) { nd.data.status = 'error'; nd.data.error = String((err && err.message) || err); }
        });
        return false;
      }
    }
    function commitGenResult(nodeId, assetId, demo, kind) {
      const downstream = [];
      update((s) => {
        const nd = s.graph.nodes[nodeId];
        if (nd) { nd.data.status = 'done'; nd.data.assetId = assetId; nd.data.demo = !!demo; }
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
          if (n.type === 'image-gen' || n.type === 'video-gen') {
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
      drag.nodeStarts = ids.map((id) => {
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
        const dxw = dxs / V.scale, dyw = dys / V.scale;
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
        const ids = [...S.sel];
        update((s) => {
          for (const id of ids) delete s.graph.nodes[id];
          if (s.selEdge) {
            s.graph.edges = s.graph.edges.filter((x) => x.id !== s.selEdge);
            s.selEdge = null;
          }
          s.graph.edges = s.graph.edges.filter((x) => !ids.includes(x.fromNode) && !ids.includes(x.toNode));
          s.sel = new Set();
        });
        pushHistory();
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
    });
    const TYPE_KIND = { 'text': 'text', 'shot': 'shot', 'script': 'script', 'storyboard': 'shot', 'image-gen': 'image', 'video-gen': 'video', 'image-asset': 'image', 'video-asset': 'video', 'finalcut': 'video' };

    // 节点尺寸自适应：RO 上报高度，供连线端口定位
    function observeNodeHeight(id, el) {
      if (!el) return;
      const ro = new ResizeObserver(() => {
        const nd = S.graph.nodes[id];
        if (nd && el.offsetHeight && Math.abs((nd.h || 0) - el.offsetHeight) > 1) {
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

    const TYPE_ICON = { 'text': 'text', 'shot': 'shot', 'script': 'script', 'storyboard': 'board', 'image-gen': 'spark', 'video-gen': 'video', 'image-asset': 'image', 'video-asset': 'video' };

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
      return h('div', {
        'data-node-id': n.id,
        className: cls('dshic-node', 'type-' + n.type, 'st-' + st, selected && 'is-selected'),
        style: { left: n.x, top: n.y, width: n.w },
        ref: refCb,
        onPointerDown: (e) => onNodePointerDown(e, n),
      },
        h('div', { className: 'dshic-node-head' },
          h('span', { className: 'dshic-head-ic' }, Ic(TYPE_ICON[n.type] || 'text', 12)),
          h('span', { className: 'dshic-node-title' }, n.data.label || TYPE_LABEL()[n.type]),
          (n.data.status === 'running') ? h('span', { className: 'dshic-spin' }) : null,
          h('button', {
            type: 'button', className: 'dshic-node-x', title: T('delete'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => removeNodes([n.id]),
          }, '✕')),
        h('div', { className: 'dshic-node-body' }, nodeBody(n)),
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
    function portLabel(pid) {
      const map = {
        prompt: T('portPrompt'), ref: T('portRef'), frame: T('portFrame'),
        in: T('portIn'), out: T('portOut'),
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
      const cfgs = kind === 'image' ? (settings.imageApis || []) : (settings.videoApis || []);
      const cfgValue = (kind === 'image' ? n.data.imageApiId : n.data.videoApiId) || '';
      const setCfg = (v) => update((s) => {
        const nd = s.graph.nodes[n.id];
        if (!nd) return;
        if (kind === 'image') nd.data.imageApiId = v; else nd.data.videoApiId = v;
      });
      // 两行布局，避免超出 240px 节点宽度
      return h('div', { key: 'set', style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('div', { className: 'dshic-node-row' },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h(MiniSelect, {
              value: cfgValue, title: T('modelLabel'), width: '100%',
              options: [{ value: '', label: T('defaultCfg') }].concat(cfgs.map((c) => ({ value: c.id, label: (c.name || c.id) }))),
              onChange: setCfg,
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

    function GenNodeBody({ n, kind }) {
      const promptEdge = S.graph.edges.some((x) => x.toNode === n.id && x.toPort === 'prompt');
      const refEdges = S.graph.edges.filter((x) => x.toNode === n.id && (kind === 'image' ? x.toPort === 'ref' : x.toPort === 'frame'));
      const assetUrlV = useAssetUrl(n.data.assetId);
      return [
        h('textarea', {
          key: 'p', className: 'dshic-textarea', value: n.data.prompt || '',
          placeholder: promptEdge ? T('connected') : T('promptPlaceholder'),
          disabled: !!promptEdge,
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.prompt = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
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
        refEdges.length
          ? h('div', { key: 'ref', className: 'dshic-hint' },
              (kind === 'image' ? T('refCount') : T('portFrame')) + ' × ' + refEdges.length + ' · ' + T('connected'))
          : null,
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
              h('div', { className: 'dshic-flex' }),
            )
          : null,
        !assetUrlV && !n.data.error && n.data.status !== 'running' ? h('div', { key: 'none', className: 'dshic-hint' }, T('noResult')) : null,
      ];
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
        const rec = await saveAssetRecord(S.activeId, kind, f, { name: f.name, source: 'upload', category: 'general' });
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
      return h('div', { className: 'dshic-shot-fields' },
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

    function ScriptNodeBody({ n }) {
      const running = n.data.aiStatus === 'running';
      const generate = async () => {
        if (!String(n.data.idea || '').trim()) { toast(T('needIdea')); return; }
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.aiStatus = 'running'; nd.data.aiError = null; } });
        try {
          const text = await aiScriptNodes(n.data.idea, n.data.model);
          update((s) => {
            const nd = s.graph.nodes[n.id];
            if (nd) { nd.data.output = text; nd.data.aiStatus = 'idle'; }
            s.assetsTick++;
          });
          await saveTextAssetRecord(S.activeId, { name: T('scriptAssetPrefix') + new Date().toISOString().slice(5, 16).replace('T', ' '), text, category: 'script', prompt: n.data.idea });
          update((s) => { s.assetsTick++; });
        } catch (e) {
          update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.aiStatus = 'error'; nd.data.aiError = String(e.message || e); } });
        }
      };
      return [
        h('div', { key: 'mrow', className: 'dshic-node-row' },
          h(ModelSelect, { value: n.data.model, title: T('llmLabel'), onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.model = v; }) }),
          h('div', { className: 'dshic-flex' }),
        ),
        h('span', { key: 'l1', className: 'dshic-shot-label' }, T('ideaLabel')),
        h('textarea', {
          key: 'idea', className: 'dshic-textarea', style: { minHeight: 48 }, value: n.data.idea || '',
          placeholder: T('ideaPlaceholder'),
          onChange: (e) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.idea = e.target.value; }),
          onPointerDown: (e) => e.stopPropagation(),
        }),
        h('button', { key: 'gen', type: 'button', className: 'dshic-gen', disabled: running, onClick: generate, onPointerDown: (e) => e.stopPropagation() },
          running ? h('span', { className: 'dshic-spin' }) : Ic('spark', 12), running ? T('aiRunning') : T('aiScript')),
        h('div', { key: 'btns', className: 'dshic-node-row' },
          h('div', { className: 'dshic-flex' }),
          n.data.output ? h('button', {
            type: 'button', className: 'dshic-mini is-ghost', title: T('saveTextAsset'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: async () => {
              await saveTextAssetRecord(S.activeId, { name: T('scriptAssetPrefix') + new Date().toISOString().slice(5, 16).replace('T', ' '), text: n.data.output, category: 'script', prompt: n.data.idea });
              update((s) => { s.assetsTick++; });
              toast(T('savedOk'));
            },
          }, Ic('download', 11), T('saveTextAsset')) : null,
        ),
        n.data.aiError ? h('div', { key: 'err', className: 'dshic-err' }, n.data.aiError) : null,
        h('span', { key: 'l2', className: 'dshic-shot-label' }, T('scriptOutputLabel')),
        h('textarea', {
          key: 'out', className: 'dshic-textarea', style: { minHeight: 120 }, value: n.data.output || '',
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
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.aiStatus = 'running'; nd.data.aiError = null; nd.data.warnings = []; } });
        try {
          const shots = await aiStoryboardShots(st, n.data.requirement, n.data.count || 6, n.data.model);
          const warnings = await checkShotConsistency(shots);
          update((s) => {
            const nd = s.graph.nodes[n.id];
            if (nd) { nd.data.shots = shots; nd.data.aiStatus = 'idle'; nd.data.warnings = warnings; }
            s.assetsTick++;
          });
          await saveTextAssetRecord(S.activeId, {
            name: T('storyboardAssetPrefix') + new Date().toISOString().slice(5, 16).replace('T', ' '),
            text: shots.map((x) => `【${x.title}】${x.duration}s\n画面：${x.visual}\n动作：${x.motion}\n角色：${x.characters.join('、') || '-'}｜场景：${x.scene || '-'}｜道具：${x.props.join('、') || '-'}`).join('\n\n'),
            category: 'storyboard', prompt: st.slice(0, 200),
          });
          update((s) => { s.assetsTick++; });
        } catch (e) {
          update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.aiStatus = 'error'; nd.data.aiError = String(e.message || e); } });
        }
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
            options: [3, 4, 5, 6, 8, 10, 12].map((x) => ({ value: String(x), label: x + ' ' + T('shotsUnit') })),
            onChange: (v) => update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.count = Number(v); }),
          }),
          h('div', { className: 'dshic-flex' }),
        ),
        h('button', { key: 'gen', type: 'button', className: 'dshic-gen', disabled: running, onClick: generate, onPointerDown: (e) => e.stopPropagation() },
          running ? h('span', { className: 'dshic-spin' }) : Ic('spark', 12), running ? T('aiRunning') : T('aiStoryboard')),
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
          ? h('button', { key: 'expand', type: 'button', className: 'dshic-mini', style: { alignSelf: 'flex-start' }, onClick: () => expandStoryboard(n), onPointerDown: (e) => e.stopPropagation() },
              Ic('expandAll', 11), T('expand') + ` (${shots.length})`)
          : null,
      ];
    }

    // 分镜表 → 画布：每个分镜一份「分镜节点 + 图片生成(参考图) + 视频生成(首帧) + 视频资产」，
    // 资产按名称匹配已有节点，缺失的生成待补充占位节点。
    async function expandStoryboard(n) {
      const shots = (n.data.shots || []).slice();
      if (!shots.length) { toast(T('expandNoShots')); return; }
      // 项目资产名称索引（用于把角色/场景/道具连接到已有资产节点）
      const recs = await idbByProject(S.activeId).catch(() => []);
      const recById = new Map(recs.map((r) => [r.id, r]));
      const norm = (s) => String(s || '').trim().toLowerCase();
      const nameIndex = recs.filter((r) => r.kind === 'image').map((r) => ({ id: r.id, name: norm(r.name), category: r.category }));
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
        const baseX = n.x + n.w + 80;
        const baseY = n.y - 60;
        shots.forEach((shot, i) => {
          const col = Math.floor(i / 4);
          const row = i % 4;
          const cx = baseX + col * 980;
          const cy = baseY + row * 760;
          const mk = (type, x, y, dataOver, label) => {
            const nd = newNode(type, { x, y });
            if (dataOver) nd.data = { ...nd.data, ...dataOver };
            if (label) nd.data.label = label;
            s.graph.nodes[nd.id] = nd;
            return nd;
          };
          const shotNode = mk('shot', cx, cy, { visual: shot.visual, motion: shot.motion }, shot.title);
          const imageGen = mk('image-gen', cx + 300, cy - 20, { prompt: shot.visual });
          const videoGen = mk('video-gen', cx + 300, cy + 300, { prompt: shot.motion, duration: shot.duration });
          const videoAsset = mk('video-asset', cx + 600, cy + 300);
          const wireRef = (names, port) => {
            let plcRow = 0;
            for (const nm of names) {
              let an = findAssetNode(nm);
              if (!an) {
                an = mk('image-asset', cx - 300, cy - 40 + plcRow * 120, { placeholderName: nm });
                plcRow++;
              }
              if (port) linkRaw(an, 'out', shotNode, port);
              linkRaw(an, 'out', imageGen, 'ref');
            }
          };
          wireRef(shot.characters, 'char');
          if (shot.scene) wireRef([shot.scene], 'scene');
          wireRef(shot.props, 'prop');
          linkRaw(shotNode, 'visual', imageGen, 'prompt');
          linkRaw(imageGen, 'out', videoGen, 'frame');
          linkRaw(shotNode, 'motion', videoGen, 'prompt');
          linkRaw(videoGen, 'out', videoAsset, 'in');
        });
        s.sel = new Set();
      });
      pushHistory();
      toast(T('expandDone').replace('{n}', String(shots.length)));
      setTimeout(() => fitView(), 60);
    }

    function FinalCutNodeBody({ n }) {
      const running = n.data.status === 'running';
      const segEdges = S.graph.edges.filter((x) => x.toNode === n.id && x.toPort === 'in');
      const segs = segEdges
        .map((e) => ({ e, nd: S.graph.nodes[e.fromNode] }))
        .filter((x) => x.nd)
        .sort((a, b) => (a.nd.y - b.nd.y) || (a.nd.x - b.nd.x));
      const assetUrlV = useAssetUrl(n.data.assetId);
      const compose = async () => {
        if (!segs.length) { toast(T('noSegments')); return; }
        const defSub = (x) => (x.nd.type === 'video-gen' ? (x.nd.data.prompt || '') : (x.nd.data.label || TYPE_LABEL()[x.nd.type]));
        const getSub = (x) => {
          const v = n.data.subs && n.data.subs[x.e.id];
          return v != null ? v : defSub(x);
        };
        const metas = [];
        for (const x of segs) {
          if (!x.nd.data.assetId) continue;
          try {
            const rec = await idbGet(x.nd.data.assetId);
            if (rec && rec.blob) metas.push({ url: URL.createObjectURL(rec.blob), name: rec.name || 'seg', sub: getSub(x), withAudio: n.data.keepAudio !== false });
          } catch { /* 跳过加载失败的片段 */ }
        }
        if (!metas.length) { toast(T('noSegments')); return; }
        update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.status = 'running'; nd.data.error = null; nd.data.progress = '0%'; } });
        try {
          const dims = videoDimsFor({ resolution: n.data.resolution, ratio: n.data.ratio });
          const blob = await composeFinalCut(metas, { width: dims.w, height: dims.h, keepAudio: n.data.keepAudio !== false, transition: n.data.transition }, (frac, name) => {
            update((s) => { const nd = s.graph.nodes[n.id]; if (nd) nd.data.progress = Math.round(frac * 100) + '% · ' + name; });
          });
          const rec = await saveAssetRecord(S.activeId, 'video', blob, {
            name: T('finalCutDone') + '-' + new Date().toISOString().slice(5, 16).replace('T', ' '),
            prompt: metas.length + ' segments', source: 'finalcut',
          });
          metas.forEach((m) => URL.revokeObjectURL(m.url));
          update((s) => {
            const nd = s.graph.nodes[n.id];
            if (nd) { nd.data.status = 'done'; nd.data.assetId = rec.id; nd.data.progress = null; }
            s.assetsTick++;
          });
          toast(T('composeDone'));
        } catch (e) {
          metas.forEach((m) => URL.revokeObjectURL(m.url));
          update((s) => { const nd = s.graph.nodes[n.id]; if (nd) { nd.data.status = 'error'; nd.data.error = String(e.message || e); nd.data.progress = null; } });
        }
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
            h('div', { className: 'dshic-flex' }),
          ),
        ),
        h('span', { key: 'l1', className: 'dshic-shot-label' }, T('segmentsLabel')),
        h('div', { key: 'list', className: 'dshic-shot-list' },
          segs.length
            ? segs.map((x, i) => {
                const defSub = x.nd.type === 'video-gen' ? (x.nd.data.prompt || '') : (x.nd.data.label || TYPE_LABEL()[x.nd.type]);
                const val = (n.data.subs && n.data.subs[x.e.id] != null) ? n.data.subs[x.e.id] : defSub;
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
          { label: T('delete'), icon: 'trash', danger: true, fn: () => removeNodes([n.id]) },
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
        flushSave();
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
        try {
          const recs = await idbByProject(pid);
          for (const r of recs) { try { await idbDelete(r.id); } catch { /* 逐个容错 */ } }
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
      const [scope, setScope] = useState('current');
      const [search, setSearch] = useState('');
      const fileRef = useRef(null);
      useEffect(() => {
        let ok = true;
        (async () => {
          try {
            const list = scope === 'current' ? await idbByProject(S.activeId) : await idbAll();
            if (ok) setAssets(list);
          } catch { if (ok) setAssets([]); }
        })();
        return () => { ok = false; };
      }, [S.activeId, tick, S.assetsTick, scope]);
      const projectName = (pid) => {
        const p = S.projects.find((x) => x.id === pid);
        return p ? p.name : '';
      };
      const addNodeFor = (a) => {
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
        for (const f of files) {
          const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : null;
          if (!kind) continue;
          await saveAssetRecord(S.activeId, kind, f, { name: f.name, source: 'upload', category: 'general' });
        }
        if (files.length) setTick((x) => x + 1);
      };
      const del = async (a) => {
        await idbDelete(a.id);
        update((s) => {
          for (const nd of Object.values(s.graph.nodes)) {
            if (nd.data && nd.data.assetId === a.id) { nd.data.assetId = null; nd.data.status = 'idle'; }
          }
          s.assetsTick++;
        });
        setTick((x) => x + 1);
      };
      const q = search.trim().toLowerCase();
      const shown = assets.filter((a) => {
        if (scope !== 'all' && scope !== 'current' && a.projectId !== scope) return false;
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
          options: [{ value: 'current', label: T('currentProject') }, { value: 'all', label: T('allProjects') }]
            .concat(S.projects.filter((p) => p.id !== S.activeId).map((p) => ({ value: p.id, label: p.name }))),
          onChange: (v) => setScope(v),
        }),
        h('button', { key: 'imp', type: 'button', className: 'dshic-mini', style: { alignSelf: 'flex-start' }, onClick: () => { if (fileRef.current) fileRef.current.click(); } }, Ic('upload', 11), T('import')),
        h('input', { key: 'file', ref: fileRef, type: 'file', accept: 'image/*,video/*', multiple: true, style: { display: 'none' }, onChange: onImport }),
        shown.length === 0
          ? h('div', { key: 'empty', className: 'dshic-hint' }, T('emptyAssets'))
          : h('div', { key: 'grid', className: 'dshic-asset-grid' },
              shown.map((a) => h(AssetCard, {
                key: a.id, a, onAdd: addNodeFor, onDel: del, onCat: changeCategory,
                showProject: scope !== 'current', projectName: projectName(a.projectId),
              })),
            ),
      ];
    }
    function AssetCard({ a, onAdd, onDel, onCat, showProject, projectName }) {
      const url = useAssetUrl(a.kind === 'text' ? null : a.id);
      const downloadName = (a.name || 'asset') + (a.kind === 'image' ? '.png' : a.kind === 'video' ? '.webm' : '.md');
      return h('div', { className: 'dshic-asset', onClick: () => onAdd(a), title: a.kind === 'text' ? T('textAssetHint') : T('addAssetNode') },
        a.kind === 'text'
          ? h('div', { className: 'dshic-textcard' }, (a.text || '').slice(0, 260) || '…')
          : a.kind === 'image'
            ? h('img', { className: 'dshic-asset-thumb', src: url || '', draggable: false })
            : h('video', { className: 'dshic-asset-thumb', src: url ? url + '#t=0.1' : '', muted: true, preload: 'metadata' }),
        h('div', { className: 'dshic-asset-actions' },
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
        h('div', { className: 'dshic-asset-meta' },
          h('select', {
            className: 'dshic-cat', title: T('catLabel'), value: a.category || 'general',
            onClick: (e) => e.stopPropagation(),
            onPointerDown: (e) => e.stopPropagation(),
            onChange: (e) => { e.stopPropagation(); onCat(a, e.target.value); },
          },
            CATEGORIES.map((c) => h('option', { key: c, value: c }, catLabel(c)))),
          showProject && a.projectId ? h('span', { className: 'dshic-projchip', title: projectName }, projectName) : null,
          h('div', { style: { flex: 1 } }),
          h('span', {}, fmtTime(a.createdAt))),
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
      const options = [{ value: '', label: T('builtinExpert') }].concat((data.skills || []).map((x) => ({ value: x.name, label: x.name })));
      return h('div', { className: 'dshic-field' },
        h('span', { className: 'dshic-field-label' }, label),
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
        h('div', { className: 'dshic-hint' }, T('llmHint')),
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
    function ApiListEditor({ kind }) {
      const [s, setS] = useState(loadSettings);
      const listKey = kind === 'image' ? 'imageApis' : 'videoApis';
      const defKey = kind === 'image' ? 'imageApiId' : 'videoApiId';
      const labelKey = kind === 'image' ? 'imageApisLabel' : 'videoApisLabel';
      const icon = kind === 'image' ? 'image' : 'video';
      const persist = (next) => { setS(next); saveSettings(next); };
      const mutate = (fn) => {
        const next = JSON.parse(JSON.stringify(s));
        next[listKey] = fn(next[listKey] || []);
        persist(next);
      };
      const add = () => mutate((list) => list.concat([{
        id: uid('cfg'),
        name: (kind === 'image' ? T('defaultImageCfg') : T('defaultVideoCfg')) + ' ' + ((s[listKey] || []).length + 1),
        ...(kind === 'image'
          ? { baseUrl: '', apiKey: '', model: '', mode: 'generations' }
          : { url: '', apiKey: '', model: '' }),
      }]));
      const patch = (id, k, v) => mutate((list) => list.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
      const remove = (id) => mutate((list) => list.filter((x) => x.id !== id));
      const list = s[listKey] || [];
      return h('div', { className: 'dshic-card' },
        h('div', { className: 'dshic-row' },
          Ic(icon, 12),
          h('strong', { style: { fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, T(labelKey)),
          h('button', { type: 'button', className: 'dshic-mini', onClick: add, onPointerDown: (e) => e.stopPropagation() }, Ic('plus', 11), T('addConfig')),
        ),
        list.length === 0 ? h('div', { className: 'dshic-hint' }, T('noCfgHint')) : null,
        list.map((cfg) => h('div', { key: cfg.id, className: 'dshic-card', style: { padding: 8, gap: 6, background: 'var(--dsw-alias-bg-layer-1)' } },
          h('div', { className: 'dshic-row' },
            h('input', {
              className: 'dshic-input', style: { flex: 1, minWidth: 0, fontWeight: 600 }, value: cfg.name || '',
              placeholder: T('cfgName'),
              onChange: (e) => patch(cfg.id, 'name', e.target.value),
              onPointerDown: (e) => e.stopPropagation(),
            }),
            s[defKey] === cfg.id
              ? h('span', { className: 'dshic-tag api' }, T('isDefault'))
              : h('button', {
                  type: 'button', className: 'dshic-mini is-ghost', title: T('setDefault'),
                  onPointerDown: (e) => e.stopPropagation(),
                  onClick: () => { const next = { ...s, [defKey]: cfg.id }; persist(next); },
                }, '★'),
            h('button', {
              type: 'button', className: 'dshic-iconbtn is-danger', title: T('delConfig'),
              onPointerDown: (e) => e.stopPropagation(),
              onClick: () => remove(cfg.id),
            }, Ic('trash', 11)),
          ),
          h(Field, { label: T('baseUrl'), value: cfg.baseUrl ?? cfg.url ?? '', onChange: (v) => patch(cfg.id, kind === 'image' ? 'baseUrl' : 'url', v), placeholder: kind === 'image' ? 'https://api.example.com/v1' : 'https://api.example.com/v1/video/generations' }),
          h(Field, { label: T('apiKey'), value: cfg.apiKey || '', onChange: (v) => patch(cfg.id, 'apiKey', v), placeholder: 'sk-…', password: true }),
          h(Field, { label: T('model'), value: cfg.model || '', onChange: (v) => patch(cfg.id, 'model', v) }),
          kind === 'image'
            ? h('div', { className: 'dshic-field' },
                h('span', { className: 'dshic-field-label' }, T('imgMode')),
                h('select', {
                  className: 'dshic-select', value: cfg.mode || 'generations',
                  onChange: (e) => patch(cfg.id, 'mode', e.target.value),
                  onPointerDown: (e) => e.stopPropagation(),
                },
                  h('option', { value: 'generations' }, T('modeGenerations')),
                  h('option', { value: 'edits' }, T('modeEdits'))))
            : null,
        )),
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
        h('div', { key: 'llm', className: 'dshic-card' },
          h('div', { className: 'dshic-row' }, Ic('spark', 12), h('strong', { style: { fontSize: 12 } }, T('llmLabel'))),
          h(LlmModelSelect),
          h('div', { className: 'dshic-hint' }, T('skillEnhance')),
          h(SkillSelect, { label: T('skillScript'), value: s.skillScript, onChange: (v) => apply((d) => { d.skillScript = v; }) }),
          h(SkillSelect, { label: T('skillStoryboard'), value: s.skillStoryboard, onChange: (v) => apply((d) => { d.skillStoryboard = v; }) }),
        ),
        h(ApiListEditor, { key: 'imglist', kind: 'image' }),
        h(ApiListEditor, { key: 'vidlist', kind: 'video' }),
        h('div', { key: 'note', className: 'dshic-hint' }, 'DeepSeek Harness · @local/infinite-canvas v0.9.0'),
      ];
    }

    /** 项目设定集（Series Bible）：风格 + 角色/场景/道具卡，注入所有 AI 生成保证跨集一致。 */
    function BibleTab() {
      const [bible, setBible] = useState(() => loadBible(S.activeId));
      useEffect(() => { setBible(loadBible(S.activeId)); }, [S.activeId]);
      const persist = (next) => { setBible(next); saveBible(S.activeId, next); };
      const listEditor = (key, labelKey) => h('div', { className: 'dshic-card' },
        h('div', { className: 'dshic-row' },
          h('strong', { style: { fontSize: 12 } }, T(labelKey)),
          h('div', { className: 'dshic-flex' }),
          h('button', {
            type: 'button', className: 'dshic-mini',
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => persist({ ...bible, [key]: [...(bible[key] || []), { name: '', desc: '' }] }),
          }, Ic('plus', 11), T('bibleAdd')),
        ),
        ...(bible[key] || []).map((item, i) => h('div', { key: i, className: 'dshic-row' },
          h('input', {
            className: 'dshic-input', style: { width: 84, flex: 'none' }, value: item.name || '',
            placeholder: T('bibleNamePh'),
            onChange: (e) => { const arr = [...bible[key]]; arr[i] = { ...arr[i], name: e.target.value }; persist({ ...bible, [key]: arr }); },
            onPointerDown: (e) => e.stopPropagation(),
          }),
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
      );
      return [
        h('div', { key: 'proj', className: 'dshic-hint' },
          `${T('bibleTab')} · ${T('currentProject')}：${(S.projects.find((p) => p.id === S.activeId) || {}).name || ''}`),
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

    // ============================================================
    // 主面板
    // ============================================================
    let applyViewToDomSoon = () => {};
    function useApp() {
      const [, force] = useState(0);
      useEffect(() => subscribe(() => force((x) => x + 1)), []);
      return S;
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
              nodes.map((n) => h(NodeShell, { key: n.id, n })),
              h('div', {
                className: 'dshic-marquee', style: { display: 'none' },
                ref: (el) => { marqueeEl = el; },
              }),
            ),
            nodes.length === 0 ? h('div', { className: 'dshic-empty' },
              h('div', { className: 'dshic-empty-card' },
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
          // 后台路由探活：失败时在画布顶部给出可操作的提示
          hostRpc('ping').then(() => { S.hostOk = true; S.hostError = null; notify(); }).catch((e) => {
            S.hostOk = false;
            S.hostError = String((e && e.message) || e);
            notify();
          });
          return () => { unsub(); };
        }, 'infinite-canvas: store & locale');
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 100,
          label: () => T('panel'),
          locale: NS,
        }, PanelIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, CanvasPage));
      },
    };
  },
});
