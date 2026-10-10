/**
 * Host half of the infinite-canvas bundle.
 *
 * Registers one JSON-RPC style route (`/infinite-canvas/api/rpc`) the browser
 * half calls for AI text generation (剧本 / 分镜提示词). The completion runs
 * through the Harness `llm` Service — the same providers/models the user has
 * configured for the Harness itself, no extra API key handling here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'infinite-canvas';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// 版本单一来源 = 当前副本的 package.json（硬编码常量曾与包版本漂移）
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || VERSION;
} catch { /* 保留默认值 */ }

// 更新检查的唯一信息源 = npm registry latest（与安装方式无关：
// npm 在线安装 / 本地 link 开发态 / 其它方式，一律走同一条逻辑）。
const NPM_LATEST_URL = 'https://registry.npmjs.org/' + encodeURIComponent('@ninkch/dsh-infinite-canvas') + '/latest';

/** 读取 npm registry 上 latest dist-tag 的版本号。 */
async function npmLatestVersion() {
  const res = await fetch(NPM_LATEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('npm registry 返回 HTTP ' + res.status);
  const meta = await res.json();
  if (!meta || typeof meta.version !== 'string') throw new Error('npm registry 响应缺少 version 字段');
  return meta.version;
}

/** 语义化版本比较：a<b → -1，a>b → 1，相等或无法解析 → 0；prerelease 低于同号正式版。 */
function cmpVer(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
    return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ?? null } : null;
  };
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) return A.core[i] < B.core[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
}

function readLocalVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version ?? VERSION;
  } catch { return VERSION; }
}

/**
 * 更新检查（与安装方式无关）：当前副本版本 vs npm registry latest。
 * 本地版本 ≥ 远端 → 最新；仅真正落后才提示。
 * 插件绝不自动安装、绝不自动重启/刷新 —— 安装一律引导到 DSH 插件管理。
 */
async function updateCheck() {
  const runningVersion = readLocalVersion();
  const remoteVersion = await npmLatestVersion();
  const behind = cmpVer(runningVersion, remoteVersion) < 0 ? 1 : 0;
  return { source: 'npm', runningVersion, remoteVersion, behind, upToDate: behind === 0 };
}

export const inject = ['webServer'];

// 仅供诊断 / 自动化测试（不属于 RPC 面，运行时行为不受影响）
export const _internals = { updateCheck, npmLatestVersion, cmpVer, getVersion: () => VERSION };

function resolveModel(providers, want) {
  const byProvider = want && want.provider
    ? providers.find((p) => p.id === want.provider)
    : null;
  const provider = byProvider || providers.find((p) => (p.models ?? []).length) || null;
  if (!provider) return null;
  const byModel = want && want.model
    ? provider.models.find((m) => m.id === want.model)
    : null;
  const model = byModel || provider.models[0] || null;
  if (!model) return null;
  return { provider: provider.id, model: model.id };
}

export function apply(ctx) {
  ctx.effect(() => {
    const llm = () => ctx.get('llm');

    async function listLlmOptions() {
      const service = llm();
      if (!service) return { providers: [], resolved: null, error: 'llm 服务不可用' };
      const out = [];
      const seen = new Set();
      const pushProvider = async (id, name) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        try {
          const models = await service.listModels(id);
          out.push({
            id,
            name: name ?? id,
            models: (models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
          });
        } catch (e) {
          out.push({ id, name: name ?? id, models: [], error: String((e && e.message) || e) });
        }
      };
      try {
        for (const p of (service.listProviders() ?? [])) await pushProvider(p.id, p.name ?? p.id);
      } catch { /* 继续尝试 configurable providers */ }
      try {
        if (typeof service.listConfigurableProviders === 'function') {
          for (const c of (service.listConfigurableProviders() ?? [])) {
            const id = c && (c.id ?? c.key ?? c.settingsNs ?? c.name);
            if (id) await pushProvider(String(id), (c.name ?? c.title) ?? String(id));
          }
        }
      } catch { /* ignore */ }
      return { providers: out, resolved: resolveModel(out) };
    }

    async function complete(args) {
      const service = llm();
      if (!service) throw new Error('llm 服务不可用');
      const want = args ?? {};
      const { providers } = await listLlmOptions();
      const resolved = resolveModel(providers, want);
      if (!resolved) throw new Error('没有可用模型，请先在 Harness 设置中配置模型提供方');
      let text = '';
      const stream = service.stream({
        provider: resolved.provider,
        model: resolved.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: String(want.system ?? '') }] },
          { role: 'user', content: [{ type: 'text', text: String(want.user ?? '') }] },
        ],
        temperature: typeof want.temperature === 'number' ? want.temperature : 0.7,
        maxTokens: typeof want.maxTokens === 'number' ? want.maxTokens : 4000,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
      }
      return { text, provider: resolved.provider, model: resolved.model };
    }

    const methods = {
      async ping() { return { ok: true, version: VERSION }; },
      async llmOptions() { return listLlmOptions(); },
      async llmComplete(args) { return complete(args); },
      async updateCheck() { return updateCheck(); },
      async listSkills() {
        const skills = ctx.get('skills');
        if (!skills) return { skills: [], error: 'skills 服务不可用' };
        try {
          const list = await skills.list({ limit: 200 });
          return {
            skills: (list ?? []).map((s) => ({ name: s.name, description: s.description ?? '' })),
          };
        } catch (e) {
          return { skills: [], error: String((e && e.message) || e) };
        }
    },
      async readSkill(args) {
        const skills = ctx.get('skills');
        if (!skills) throw new Error('skills 服务不可用');
        const name = String((args && args.name) ?? '');
        if (!name) throw new Error('缺少技能名');
        const def = await skills.get(name);
        if (!def) throw new Error('技能不存在: ' + name);
        const text = typeof def === 'string'
          ? def
          : (def.content ?? def.body ?? def.instructions ?? def.markdown ?? null);
        return {
          name,
          text: String(text ?? ((def && typeof def === 'object') ? JSON.stringify(def) : '')).slice(0, 80000),
        };
      },
    };

    return ctx.webServer.register({
      kind: 'exact',
      path: `/${NAME}/api/rpc`,
      async handler(req, res) {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: '仅接受 POST' }));
            return;
          }
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 2e6) throw new Error('请求过大');
          }
          const { method, args } = JSON.parse(raw);
          const fn = methods[method];
          if (!fn) throw new Error('未知操作: ' + method);
          res.end(JSON.stringify(await fn(args ?? {})));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String((e && e.message) || e) }));
        }
      },
    });
  }, `${NAME}: api route`);
}
