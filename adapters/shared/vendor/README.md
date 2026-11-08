# vendor/ — canvas-web 面板壳的第三方静态资产

本目录是 **vendor 静态资产**（随 adapters 发布物走），**不是 npm 依赖**——adapters 三壳
（vsix / qoder / workbuddy）的运行时依赖红线仍是零 npm 依赖，本文件由构建脚本按枚举清单
原样拷贝（build-qoder / build-workbuddy → `dist/vendor/`；vsix sync-shared → `shared/vendor/`），
由 `canvas-web.cjs` 的静态路由 `/infinite-canvas/api/vendor/react.production.min.js` 服务给
浏览器面板壳（Task 14：画布真 UI 浏览器化）。

## 内容

| 文件 | 来源 | 用途 | 许可 |
| --- | --- | --- | --- |
| `react.production.min.js` | `react@18.3.1` 官方 UMD 构建（`npm pack react@18.3.1` → `package/umd/react.production.min.js`，未修改一字） | 面板壳经 `<script>` 全局装载为 `window.React`，供 `__ModuleLoader__` shim 的 `require('react')` 返回——client.js 唯一外部 require | MIT（文件头保留上游 license banner） |
| `react-dom.production.min.js` | `react-dom@18.3.1` 官方 UMD 构建（`npm pack react-dom@18.3.1` → `package/umd/react-dom.production.min.js`，未修改一字） | 面板壳经 `<script>` 全局装载为 `window.ReactDOM`（依赖先装载的 `window.React`），供 shim 调 `ReactDOM.createRoot(el).render(...)` 全屏挂载 slots.register 捕获的画布组件（Task 15：壳内模拟 Harness） | MIT（文件头保留上游 license banner） |

## 升级方法

1. `npm pack react@<新版本>`（react-dom 同法）→ 解包取 `package/umd/react.production.min.js`
   覆盖本目录文件（保留上游 MIT license banner，不做任何修改）。
2. 版本选择约束：client.js 只用 `createElement` / hooks（`useState` 等），React 17/18 UMD 均
   兼容；**不要升 React 19**——19 的 UMD 构建已移除（19 只有 ESM），本壳依赖 UMD 全局形态。
3. 更新本 README 的来源行；跑 `node scripts/test-adapters-canvas-web.mjs`（断言 vendor 路由
   200 且含 `React`）与 `node scripts/test-adapters-build.mjs`（断言三产物含 vendor 拷贝）。
