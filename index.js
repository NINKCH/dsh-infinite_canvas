/**
 * Host half of the infinite-canvas bundle.
 *
 * Registers one JSON-RPC style route (`/infinite-canvas/api/rpc`) the browser
 * half calls for AI text generation (剧本 / 分镜提示词). The completion runs
 * through the Harness `llm` Service — the same providers/models the user has
 * configured for the Harness itself, no extra API key handling here.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'infinite-canvas';
const VERSION = '0.17.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 运行 git 子命令（cwd = 插件目录 = 仓库根）。 */
function runGit(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdout = [];
    const stderr = [];
    let child;
    try {
      child = spawn('git', args.map(String), { cwd: HERE, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, Math.max(5000, timeoutMs));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => stdout.push(String(d)));
    child.stderr?.on('data', (d) => stderr.push(String(d)));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stdout: stdout.join(''), stderr: String(e?.message ?? e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.join(''), stderr: stderr.join(''), ms: Date.now() - started });
    });
  });
}

/** 更新检查：fetch 当前分支上游 + 对比；本地领先（ahead）不算待更新。 */
async function updateCheck() {
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
  const upstream = branch === 'HEAD' ? 'origin/main' : 'origin/' + branch;
  const fetchRes = await runGit(['fetch', 'origin', branch, '--quiet'], 60000);
  if (!fetchRes.ok) throw new Error('git fetch 失败：' + (fetchRes.stderr || '').slice(0, 300));
  const head = (await runGit(['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const remoteHead = (await runGit(['rev-parse', '--short', upstream])).stdout.trim();
  const behind = Number((await runGit(['rev-list', '--count', 'HEAD..' + upstream])).stdout.trim()) || 0;
  const ahead = Number((await runGit(['rev-list', '--count', upstream + '..HEAD'])).stdout.trim()) || 0;
  let remoteVersion = null;
  try {
    const pj = await runGit(['show', upstream + ':package.json']);
    remoteVersion = JSON.parse(pj.stdout).version ?? null;
  } catch { /* 远端无 package.json 时忽略 */ }
  let runningVersion = null;
  try { runningVersion = JSON.parse(await fs.readFile(path.join(HERE, 'package.json'), 'utf8')).version ?? null; } catch { /* 忽略 */ }
  return { branch, head, remoteHead, behind, ahead, remoteVersion, runningVersion, upToDate: behind === 0 };
}

/** 应用更新：merge --ff-only 当前分支上游；绝不自动重启/刷新；报告 index.js 是否变更。 */
async function updateApply() {
  const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
  const upstream = 'origin/' + (branch === 'HEAD' ? 'origin/main' : 'origin/' + branch);
  const before = (await runGit(['rev-parse', 'HEAD:index.js'])).stdout.trim();
  await runGit(['fetch', 'origin', branch, '--quiet'], 60000);
  const pull = await runGit(['merge', '--ff-only', upstream], 180000);
  const after = (await runGit(['rev-parse', 'HEAD:index.js'])).stdout.trim();
  let version = null;
  try { version = JSON.parse(await fs.readFile(path.join(HERE, 'package.json'), 'utf8')).version ?? null; } catch { /* 忽略 */ }
  return {
    ok: pull.ok,
    output: ((pull.stdout || '') + '\n' + (pull.stderr || '')).trim().slice(-1500),
    hostChanged: pull.ok && before !== after,
    version,
  };
}

export const inject = ['webServer'];

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
      async updateApply() { return updateApply(); },
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
