/**
 * 宿主能力探测决策表（Task 6，vsix 壳）——纯逻辑，零 vscode 依赖、零 node 内置以外依赖，可单测。
 *
 * 输入 capabilities 由 extension.js 从真实 vscode 命名空间探测后传入（typeof 函数存在性）：
 *   { lmTools:boolean, mcpProvider:boolean, cursorMcp:boolean, sampling:boolean }
 *
 * 决策（brief 逐字）：
 *   lmTools      → 'lm-tools'     （① vscode.lm.registerTool 直挂 30 工具）
 *   否则 mcpProvider → 'mcp-provider'（② MCP definition provider 动态发布 stdio server）
 *   否则 cursorMcp   → 'cursor-mcp'  （③ Cursor 专有 vscode.cursor.mcp.registerServer）
 *   否则             → 'manual'      （④ 输出 mcp.json 手配片段引导）
 *   sampling 直传（vscode.lm.selectChatModels 可用性，决定文本 LLM 注入是否可用）。
 *
 * 非法输入（缺字段 / 多传 / undefined / 非布尔真值）一律按 false 处理，绝不抛错——
 * 探测决策在任何宿主上都必须给出一条可走的路径。返回形状恒两键 { path, sampling }。
 */
'use strict';

const PATHS = ['lm-tools', 'mcp-provider', 'cursor-mcp', 'manual'];

/**
 * 布尔规范化：严格 true 才算 true，其余（缺字段/非布尔/假值）一律 false。
 * 不抛错、不改写输入。
 */
function asBool(v) {
  return v === true;
}

/**
 * 决策表主函数（接口见文件头，brief 逐字）。
 * @param {object|undefined} capabilities 四能力布尔（可缺字段、可多传、可为 null/undefined）
 * @returns {{ path: 'lm-tools'|'mcp-provider'|'cursor-mcp'|'manual', sampling: boolean }}
 */
function detect(capabilities) {
  const c = capabilities && typeof capabilities === 'object' ? capabilities : {};

  let path = PATHS[3]; // 缺省 manual
  if (asBool(c.lmTools)) path = 'lm-tools';
  else if (asBool(c.mcpProvider)) path = 'mcp-provider';
  else if (asBool(c.cursorMcp)) path = 'cursor-mcp';

  return { path, sampling: asBool(c.sampling) };
}

module.exports = { detect, PATHS };
