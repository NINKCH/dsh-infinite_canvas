/**
 * vscode.lm 文本后端（Task 6，vsix 壳）——Task 5 llm-channel 的 vscode-lm 通道注入实现，薄封装。
 *
 * 职责单一：把宿主 vscode.lm 命名空间包成 HOST-CONTRACT.md §10 的通道形状
 *   createVscodeLmChannel(vscode) -> { available:boolean(count), count, chat(messages, opts) }
 *   - available = 模型计数真值（selectChatModels 求计数与模型列表；异常/空列表 → false）；
 *   - count 供 probeChannels 报数（『注入可带 count』语义）；
 *   - chat 取列表第一个模型 sendRequest 聚合 stream.text 全量后返回 {text}
 *     （非流式语义对齐 llm-channel：调用方 await chat() + catch 一次即可）。
 *
 * API 形状依据（npm install 后的 @types/vscode d.ts 实读，engines.vscode=^1.90.0 取 floor 版）：
 *   - lm.selectChatModels(selector?) → Thenable<LanguageModelChat[]>（1.90 d.ts L19228，final）；
 *   - model.sendRequest(messages: LanguageModelChatMessage[], options?, token?)（1.90 d.ts L19094
 *     ——形参是消息数组而非裸字符串，故 prompt 以 LanguageModelChatMessage.User(prompt) 单条传入；
 *     1.90 的 LanguageModelChatMessage 无 System 静态构造器（仅 User/Assistant），system 前缀
 *     按 brief『简单拼接（system 前缀 + user 行）』折进 user 文本）；
 *   - response.text: AsyncIterable<string>（1.90 d.ts L19030；1.145 d.ts L20506 同形）——brief
 *     『聚合 stream.text 全量』逐字对齐，无需逐 part 判型；
 *   - registerTool / LanguageModelToolResult / LanguageModelTextPart 在 1.90 d.ts 不存在
 *     （宿主 API 面 ≥1.101 才有）→ 本文件只做通道，不触碰那些类。
 *
 * 失败模式（§10 统一契约）：上游可能同步 throw 也可能 promise reject——chat 内部
 * try { return await ... } catch 收口；Error.message 组装统一过 model-bridge.redact（密钥红线：
 * llm-channel 约定『message 已由各通道 redact』后原样重抛）。vscode.lm 错误虽不含用户密钥，
 * redact 是零成本防御，统一收口。
 */
'use strict';

const bridge = require('../shared/model-bridge.cjs');

/**
 * messages → prompt 的简单拼接（brief 逐字：system 前缀 + user 行）。
 * - system 消息内容按序换行拼接为前缀；user 消息内容按序换行拼接为正文；
 * - assistant 角色不参与（编剧室 5 轮等场景输入为 system+user，brief 未要求多轮上下文回放）；
 * - content 兼容字符串与 part 数组（LanguageModelTextPart 取 .value），其余形态跳过不抛错。
 */
function buildPrompt(messages) {
  const contentOf = (m) => {
    const c = m && m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p && p.value) || '')).join('');
    return '';
  };
  const list = Array.isArray(messages) ? messages : [];
  const system = list.filter((m) => m && m.role === 'system').map(contentOf).filter(Boolean).join('\n');
  const user = list.filter((m) => m && m.role === 'user').map(contentOf).filter(Boolean).join('\n');
  return (system ? system + '\n' : '') + user;
}

/**
 * 通道工厂（异步：selectChatModels 按 d.ts 返回 Thenable）。
 * 任何失败（lm 命名空间缺失 / selectChatModels 抛错 / 空列表）→ available:false，
 * 绝不抛出——通道可用性探测是常态降级而非异常。
 *
 * @param {object} vscode 宿主 vscode 命名空间（仅在本文件与 extension.js 出现）
 * @returns {Promise<{available:boolean, count:number, chat:(messages,opts)=>Promise<{text:string}>}>}
 */
async function createVscodeLmChannel(vscode) {
  let models = [];
  try {
    if (vscode && vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
      models = (await vscode.lm.selectChatModels()) || [];
    }
  } catch {
    models = []; // 探测失败 = 无可用模型，与空列表同语义
  }
  if (!Array.isArray(models)) models = [];
  const model = models[0]; // chat 用列表第一个模型（brief 逐字）

  async function chat(messages, opts) {
    if (!model) throw new Error(bridge.redact('vscode-lm 通道不可用：selectChatModels 无可用模型'));
    const prompt = buildPrompt(messages);
    try {
      // d.ts floor 形状：sendRequest(LanguageModelChatMessage[], options?, token?)；
      // opts（temperature 等）1.90 的 LanguageModelChatRequestOptions 无对应字段，接受但不透传。
      void opts;
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)]);
      let text = '';
      for await (const chunk of response.text) text += chunk; // 聚合 stream.text 全量
      return { text };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(bridge.redact('vscode-lm 请求失败: ' + reason));
    }
  }

  return { available: models.length > 0, count: models.length, chat };
}

module.exports = { createVscodeLmChannel, buildPrompt };
