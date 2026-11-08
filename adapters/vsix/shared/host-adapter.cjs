/**
 * 假 ctx 适配器（host-adapter）——adapters/ 的公共底座。
 *
 * 职责单一：伪造 index.js（core）要求的 cordis ctx（依赖面见同目录 HOST-CONTRACT.md），
 * 把 apply(ctx) 注册的 canvas_* 工具定义与 webServer 路由原样收集起来，交给上层承载
 * （MCP / HTTP / 模型桥接）消费。不改名、不裁剪、不包装注册对象。
 *
 * 契约（HOST-CONTRACT.md §6）：
 *   const { ctx, tools, routes, dispose } = await createHostAdapter({ corePath?, homeDir? });
 *   - tools[i]  : Def   = { name, description, parameters, output?, timeoutMs?, execute(args, exec) }
 *   - routes[i] : Route = { kind: 'exact', path, handler(req, res) }
 *   - dispose() : 依次调用全部收集到的 disposer，幂等
 *
 * 零依赖（仅 node 内置）。CommonJS：六家 IDE 宿主加载器以 require 为主，发布物也是 .cjs。
 * 存储根（数据根裁定，Task 7）：import core 之前设置 DSH_IC_PROJECTS_DIR / DSH_IC_CONFIG_PATH
 * （core 模块顶层常量，import 后不可变）。缺省 = env DSH_IC_HOME，再缺省 = 用户目录
 * ~/.dsh-infinite-canvas/（包内 .tmp-home 随插件升级清空创作资产，已废弃——用户数据落用户目录，
 * 升级/重装不丢）。homeDir option 优先级最高；测试一律显式注入临时目录，绝不触碰真实用户数据。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// 仓库根：本文件位于 adapters/shared/，向上两级即仓库根（开发期默认 core 入口所在地）。
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * core 入口缺省解析（发布布局自解析，无需 --core-dir）：
 * 发布布局（HOST-CONTRACT.md §5）：本文件与 core/ 同目录（dist/host-adapter.cjs + dist/core/）
 *   → 缺省取 <__dirname>/core/index.js；
 * 开发布局（adapters/shared/，core 不在同级）→ 退仓库根 index.js。
 * 返回路径不保证存在（调用方负责报错语义：corePath 缺失时 import 失败即抛）。
 */
function defaultCorePath() {
  const published = path.join(__dirname, 'core', 'index.js');
  return fs.existsSync(published) ? published : path.join(REPO_ROOT, 'index.js');
}

async function createHostAdapter(options) {
  const opts = options || {};
  // corePath 可配；绝对路径直接用，相对路径相对仓库根解析。缺省按布局自解析（见 defaultCorePath）。
  const corePath = opts.corePath
    ? (path.isAbsolute(opts.corePath) ? opts.corePath : path.resolve(REPO_ROOT, opts.corePath))
    : defaultCorePath();
  // 存储根（数据根裁定，Task 7）：homeDir option > env DSH_IC_HOME > 用户目录 ~/.dsh-infinite-canvas/。
  // 经 DSH_IC_* 注入 core（import 前必须生效）。
  const homeDir = opts.homeDir
    ? path.resolve(opts.homeDir)
    : (process.env.DSH_IC_HOME ? path.resolve(process.env.DSH_IC_HOME) : path.join(os.homedir(), '.dsh-infinite-canvas'));
  const projectsDir = path.join(homeDir, 'projects');
  for (const dir of [homeDir, projectsDir]) fs.mkdirSync(dir, { recursive: true });
  process.env.DSH_IC_PROJECTS_DIR = projectsDir;
  process.env.DSH_IC_CONFIG_PATH = path.join(homeDir, 'config.json');

  // core 是 ESM：CJS 侧用动态 import 装载（HOST-CONTRACT.md §1：apply 同步注册，import 返回即收集完成）。
  const core = await import(pathToFileURL(corePath).href);
  if (typeof core.apply !== 'function') {
    throw new Error('core 入口没有 export function apply(ctx): ' + corePath);
  }

  const tools = [];
  const routes = [];
  const disposers = []; // LIFO：dispose() 按注册逆序撤销，与 cordis teardown 语义一致
  let disposed = false;
  const track = (off) => {
    if (typeof off === 'function') disposers.push(off);
    return off;
  };

  const ctx = {
    /** cordis effect：立即同步执行 fn，fn 返回的清理函数收集到 dispose 链。label 仅诊断用。 */
    effect(fn, label) {
      if (typeof fn !== 'function') return;
      track(fn()); // fn 同步跑完所有注册（HOST-CONTRACT.md §1：core 全部注册在单个 effect 里）
      void label;
    },
    /** 可选服务一律防御式降级（core 每个 get 用点都有守卫），假宿主恒返回 undefined。 */
    get() { return undefined; },
    tools: {
      register(def) {
        tools.push(def);
        return track(() => {
          const i = tools.indexOf(def);
          if (i >= 0) tools.splice(i, 1);
        });
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return track(() => {
          const i = routes.indexOf(route);
          if (i >= 0) routes.splice(i, 1);
        });
      },
    },
  };

  core.apply(ctx); // 同步：返回时 tools/routes 已收集完毕

  return {
    ctx,
    tools,
    routes,
    /** 撤销全部注册（effect 清理链含 core 自己的总清理，内部再逐个调用工具/路由 disposer）。幂等。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (let i = disposers.length - 1; i >= 0; i--) {
        try { disposers[i](); } catch { /* 单个 disposer 失败不阻塞其余 */ }
      }
      disposers.length = 0;
      tools.length = 0;
      routes.length = 0;
    },
  };
}

module.exports = { createHostAdapter, defaultCorePath };
