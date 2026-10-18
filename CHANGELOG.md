# Changelog

All notable changes to `@ninkch/dsh-infinite-canvas` are documented here (newest first).
GitHub Releases carry the same notes in English; maintainer-facing runbooks live in
[`RELEASING.md`](RELEASING.md) and [`docs/release.md`](docs/release.md).

## [0.18.3] — 2026-10-18

### Fixed
- **Reference-image uploads on Compshare rejected mismatched encodings up front**: `Params [Width/Height] not available` came from the asset-registration step, where the platform parses the uploaded file to verify its pixel size. Files whose real encoding did not match their extension (AVIF/HEIC renamed to `.jpg`, common from chat apps and cloud drives) are now detected by **magic-byte sniffing** and rejected with an actionable message (convert to JPG/PNG) instead of a platform-side puzzle. Declared MIME now always matches the actual bytes.
- **Task-API errors name the failing step**: every Compshare error now carries method + path (e.g. `优云图片 API POST /image/v1/tasks 失败：…`), so a failure points at the exact stage instead of a bare gateway message.
- **Provider "Extended params (JSON)" field is visible for every video vendor**: the field was gated on an `openai`/`seedance` whitelist, so a MiniMax H3 (V2) provider showed no place to put `use_context_ir` / `mute_audio` / `skill_id`.

### Changed
- **Character-sheet prompt formalized as the proven six-block structure** (built-in creation skills): 【总起】layout/background/style + all-panels-identical → 【身份锚】reference photos are the only source of identity, ignore temporary accessories in them → 【主体】quantified build with explicit negative exclusions → 【三视图 /* must-have */】→ 【右侧窄栏】face close-up / accessory panel / 6 expressions in two rows, each block drawn exactly once in the whole sheet → 【文字规则 + 画面白名单】≤3-character labels only, plus an anti-hallucination whitelist ("only this character and the panels above; no people, no other animals, no instruments, no watermark"). The studio skill summary mirrors it.

## [0.18.2] — 2026-10-18

### Added
- **Per-node manual extra params**: image and video generation nodes get a dedicated "Extended params (JSON)" field; node-level parameters merge over provider-level extras (node wins). MiniMax H3's `use_context_ir` / `mute_audio` / `skill_id` belong here.
- **Asset re-import script** (`scripts/reimport-assets.mjs`): standalone, idempotent recovery for data directories whose asset index was missed by the one-shot v1→v2 migration (e.g. `canvas.meta.json` absent or empty at first database creation — exactly the "nodes are there, assets are gone" report). Scans folder-by-folder without needing the manifest; project docs missing locally are restored from `project.json` mirrors; records created after 0.18 (already CAS-backed) are never overwritten.

### Fixed
- **Fetch proxy deduplicated forwarded headers** (lowercase normalization): a client-sent `Content-Type` plus the proxy's defaulting `content-type` were forwarded as two headers, which strict gateways reject with `400 Content-Type must be application/json` (observed on Compshare's task API). This removes the same latent risk for every vendor routed through the proxy.
- **Compshare image hosts auto-route to the task API**: an `*.compshare.cn` base URL configured with the OpenAI-compatible style used to 401 (`invalid api key`) because that gateway has no such surface; it now always uses the task API regardless of the configured style. Pasted API keys are trimmed (stray whitespace/newlines used to break auth).
- **Settings changes refresh the canvas immediately**: node model dropdowns and star defaults kept a stale list until an unrelated re-render happened.
- **Node history strips follow asset deletion**: deleting an asset sweeps its entries from every node's generation history (plus stale last-frame references); existing ghost "…" entries self-heal when the node opens — pruning is skipped while the server is unreachable, so valid history is never mistakenly removed.

## [0.18.1] — 2026-10-18

### Fixed
- **Image prompts no longer inject the series bible behind your back** — the effective prompt builder appended the matched entity's full bible description twice (once inside the `[图N]` reference binding, once as a `设定集：…` block) on top of the visible node prompt. Text-rendering image models (Qwen-Image) painted that injected text straight onto the picture (a garbled attribute panel in the corner), story vocabulary leaked in as phantom props (the un-removable violin), and the long text diluted the reference images' control over appearance. Image generation now uses a **light** effective prompt: style line + `[图N]` name bindings + your prompt, nothing else — the reference images are the source of appearance truth. Video generation keeps the full context (video models don't render text, and the bible context helps consistency).
- **Asset-sheet templates go text-free** (built-in creation skills): the sheet layouts no longer ask the model to render attribute panels (name/gender/age lines, costume notes, inscriptions or poems) — long rendered text is guaranteed garbling. Panel text is now limited to ≤4-character labels (panel names / expression names / color names); with reference images connected, the reference appearance is the only source of truth, replicated strictly across every panel.

## [0.18.0] — 2026-10-18

### Added
- **Server-side asset library** (storage architecture change): asset metadata moves from per-browser IndexedDB to a SQLite database (`canvas.db`) inside the data directory — the single source of truth. Every browser, including remote machines reaching the host over a tunnel, now sees the same library. Project documents (nodes/edges/storyboards/setting bible) move into the same database; the old mirror files (`project.json`, `assets.json`, `canvas.meta.json`) are frozen in place as a migration snapshot and no longer written.
- **Content-addressed object store (CAS)**: media files live under `dataRoot/objects/<sha2>/<sha256>` — identical images/videos are stored once (dedup), integrity is hash-verifiable, and content is served by the new `GET /api/object?sha=…` route with immutable caching and Range support (smooth remote video scrubbing). Uploads (`POST /api/object`) hash server-side and dedupe transparently; objects are reference-counted and reclaimed when the last referencing asset is deleted (`objectsGc` maintenance RPC included).
- **Paged, searchable asset panel**: the panel lists assets from the server with keyset pagination (50 per page + load-more) and server-side search — Chinese substring search over names and prompts via an FTS5 trigram index (queries under 3 characters fall back to `LIKE`). Rename, category change and move-between-projects are written through to the server.
- **One-shot v1→v2 migration**: first mount of a data directory auto-imports legacy `assets.json` indexes and project documents (newer-wins by `updatedAt`) into `canvas.db`; legacy media files stay untouched in their old layout with `rel` pointers preserved — zero-risk migration with no file moves. Legacy blobs that never left a browser upload automatically on that browser's next launch.
- **JSON fallback**: hosts without `node:sqlite` (Node < 22.5) fall back to the legacy file storage with the same RPC surface (list emulated, no full-text search) — engine detection never hard-fails the plugin.
- **Migration guide**: [`docs/migration-0.18.md`](docs/migration-0.18.md) covers upgrading the production machine and moving a data directory to a new machine.

### Fixed
- **Assets "disappeared" on other computers**: the library was sourced from per-browser IndexedDB, so any fresh browser showed an empty panel. With the server as the source of truth this class of confusion is gone; the old boot-time full-replace index sync (which could wipe the server index from an empty browser) is removed outright.

### Notes
- Requires the DSH host to run Node ≥ 22.5 (bundled Node 24 satisfies). `node:sqlite` is a core module — no packaging changes, no native dependencies.
- The data directory now **is** the complete data package: copy it to a new machine, point the data root at it, open the canvas — no import step needed. See the migration guide for the exact steps and rollback story.

## [0.17.18] — 2026-10-18

### Added
- **Real-time collision physics for the canvas** — dragging a node now pushes overlapping neighbors away live (all directions get equal treatment, overlapping axis resolved first, cascading up to 4 passes) with no post-release jumping; released positions stick exactly where the collision stopped. Extended to **every size change**: node edge handles (width/height), heightening a text dialog, list resizing and streaming growth — measured on the node root, so every node type is covered (a 260 ms "push everything below" fallback is replaced by the same physical pass).
- **Dialog height memory** — heightening a text dialog with its own bottom-right grip is stored in node data and restored across page switches, project switches and reloads (all prompt fields: generation prompt, scene text, script idea/output, storyboard script/requirements, shot visuals/motion).
- **`canvas-layout` skill** (third built-in skill, agent-facing): canvas layout discipline — one node type per column, strict column order, never overlap, creation rhythm, and `canvas_relayout` for cleanup. Node creation on the host now always appends to the same-type column tail, regardless of which node the edge comes from.

### Fixed
- **A stray dot after the CSS template's closing backtick broke the whole plugin load** (blank unstyled page); fixed, and the render smoke test covers the component tree to catch this class of error.
- **Prompt boxes paint one line past the border**: the highlight overlay behind transparent textareas was not height-locked when the box height was content-driven — the overflowing line stayed fully visible outside the frame. The overlay is now clipped at the rounded box edge and its height is locked to the real textarea height (scroll stays aligned); the focus ring moved to the wrapper so it is not clipped.
- **Storyboard list grip squeezing prompts above**: heightening the shot list on a manually-resized node squeezed the prompt fields above it. Node height now grows together with the list; releasing the grip heals any historical squeeze to the natural content height. The prompt grip previously did nothing inside manually-resized nodes — its drag delta now converts into node height growth. Prompt fields are exempt from flex shrinking in manual-height mode (they keep a readable height; short overflow just clips below).
- **Half-clipped last line at the bottom of prompt boxes** (trailing-newline line-box compensation for the highlight overlay) plus scroll sync after value changes; the remaining plain textareas moved onto the highlight layer so every text surface behaves identically.
- **Mention glyphs misaligned with the caret**: bold mention highlight changed font metrics between the overlay and the transparent textarea — dropped bold (color only); hidden the overlay scrollbar gutter width mismatch.
- **Unclosed `@Name` mentions auto-repaired** against names known from the project at generation time (models often drop the closing `@` at sentence end), producing stray delimiters in prompts and asset matching; the studio skill's mention section rewritten to the `@Name@` double-at syntax. `@Name@` highlighting is now uniform on every text surface.

## [0.17.17] — 2026-10-17

### Added
- **Professional asset-sheet layouts** replace the simple three-view prompts (methodology added to the built-in creation skills, served live):
  - **Character sheet** (16:9): info panel (name/gender/age/identity/personality/palette) + dominant full-body illustration + facial features (front & profile close-ups with annotations) + costume notes + a 2×3 detail-crop grid (each captioned) + a 2×5 expression grid (per-cell labels); the character must look identical across every panel.
  - **Prop sheet (orientation free)**: title + category subtitle, hero shot at 45° with atmosphere, material/part detail crops, side view, and 3–5 named color swatches — horizontal or vertical chosen by the prop's traits (long items favor vertical; composite/scene-like props favor horizontal); the layout logic stays the same either way.
  - **Scene sheet (main view + surrounding panels)**: one dominant establishing view of the scene, surrounded by 3–6 supporting panels — other angles, other times of day/weather, and detail crops (landmark/entry/texture/prop placement), each captioned. Replaces the old equal-sized triptych, which lost the scene's overall sense; the arrangement is a loose reference, not a strict grid, and light/weather must stay consistent with the main view.
- Simple three-view prompts are explicitly disallowed for asset images — they don't carry enough information to sustain character consistency in downstream video generation.

## [0.17.16] — 2026-10-17

### Added
- **Image generation carries reference images in the standard mode**: `/images/generations` no longer ignores reference images — connected refs and `@Name@`-matched assets are sent as an `image` array of data-URLs (the mainstream convention for multi-reference image APIs, in the same order as the `[图N]` binding lines). Vendors that do not support the field report it explicitly.
- **Image requests default to `watermark: false`** on both `/images/generations` and the multipart `/images/edits` path (many image vendors default to watermarked output); extra params can override.

### Fixed
- The edits (multipart) path appended the whole reference meta object instead of the image blob — such requests would have sent `"[object Object]"` as file content.

## [0.17.15] — 2026-10-17

### Added
- **Per-vendor video API audit against official docs** (latest models per vendor): every adapter's parameters, endpoints, result fields and status semantics re-verified from vendor documentation/official SDKs, with fixes listed below.
- **Video vendor routing fixed end-to-end**: the explicitly chosen vendor format now reaches the request layer (previously dropped during settings flattening, falling back to model-name/URL guessing); vendor auto-detection additionally matches by model id (e.g. `wan3.0-video`, `kling-v2.6`, `MiniMax-Hailuo-02`); shared `vendorBase()` normalization strips gateway-style `/v1` suffixes for all runners; every runner accepts **extra params** (top-level override + `parameters` deep-merge) as an escape hatch for gateway quirks.
- **Duration is never silently truncated**: the requested duration is passed through to every vendor (Kling/MiniMax/Vidu/Runway/Luma/PixVerse/Seedance/Wan) — unsupported values surface as explicit API errors instead of hidden clamping; the duration selector extends to 30s (Wan 3.0) and keeps out-of-list values (e.g. a 32s storyboard total).
- **Post-generation self-check**: the real output resolution/duration is probed after each video; mismatches with the node's ratio/duration settings show a visible warning on the node (e.g. "vendor returned 1080×1920 portrait, 16:9 requested").
- **`canvas_relayout` tool**: one call re-arranges a canvas by rows — horizontal data flow decides columns, vertical links (continuity `prev`, first-frame `frame`) stay in the same column, each row is one horizontal group (e.g. "scene N text ↔ scene N storyboard"), with collision avoidance.
- **Node layout on creation**: realistic per-type height estimates (image/video/storyboard cards), brand-new types start their own column, and a minimum-gap collision check prevents overlapping cards.
- **Click-to-front**: clicking a node (or dragging a multi-selection) raises it above all others; the z-order persists.
- **Help & feedback**: a toolbar button and a settings entry open a compact dialog with the GitHub issue link and a WeChat contact QR (shipped inside the plugin via a whitelisted static-asset route).
- **API key reveal toggle**: key fields are masked by default with an eye button to show the plaintext.
- **Short-drama methodology distilled** into the built-in creation skills (canvas-craft/studio): a shot-pacing spectrum (narrative 2–4s, rapid conflict 0.3–0.8s, reversal 1–2s, emotional long take ≥5s — durations may use one decimal and must never be uniform), an emotion→shot-size map, the four-beat scene arc, the six-component director brief and a pitfalls checklist.

### Fixed
- **Wan 3.0**: the adapter used 2.x-era parameters — `size` does not exist in the 3.0 API and `img_url` was ignored, so resolution/ratio were silently defaulted (portrait 1080p) and reference images never reached the model. Now uses the official `parameters.resolution/ratio/duration` (+ stable `watermark:false`, `prompt_extend:true`) and `input.media[]` (`first_frame` / up to 10 `reference_image`, Base64) with the correct gateway prefix handling.
- **Kling**: default model id corrected to the current REST format (`kling-v2-6`; `kling-v2.5-turbo-t2v`-style ids were invalid); `cfg_scale` no longer sent unconditionally (unsupported by v2.x models); new plural `/v1/videos/*` endpoints with singular fallback; result read from `data.task_result.videos[]`; `aspect_ratio` only for text-to-video.
- **MiniMax**: `duration` is an integer (a string was sent); result download is two-step (`file_id` → `/v1/files/retrieve` → `download_url`, 1h validity); `resolution` passes through (512P/720P/768P/1080P).
- **Vidu**: default model `viduq3-pro`; polling hits `/ent/v2/tasks/{id}/creations` (the old path always 404'd); result read from `creations[].url`; `aspect_ratio` only for text-to-video; resolution passes through.
- **PixVerse**: endpoints corrected to the current `/openapi/v2/video/{text,img}/generate`; image-to-video uploads the first frame (`img_id`, the API does not accept Base64); status semantics corrected (1=done, 5/9/10=processing, **7/8=failed** — previously treated as "still running", which could hang forever); default model v6.
- **Runway**: text-to-video defaults to `gen4.5` (`gen4_turbo` is image-to-video only); model passes through (the API now hosts per-model schemas).
- **Veo**: `durationSeconds` was never sent (the official field name; not `duration`); `resolution` passes through; default model `veo-3.1-generate-preview`.
- **Luma**: `aspect_ratio` and resolution pass through (official enums).
- **Seedance (Ark)**: `generate_audio` no longer forced to `false` when the checkbox is unchecked — the vendor default (`true`) applies unless explicitly enabled.
- **Stability**: marked offline — the current official API no longer exposes any video endpoint; the adapter remains only for legacy configs and reports the 404 clearly.
- **Storyboard duration**: the hard 15s cap and automatic longest-shot trimming are removed — shot durations follow the scene's content (pacing spectrum above), and unsupported durations surface as explicit video-API errors instead of silent re-timing.
- **Host/client sync**: an incoming copy without shots no longer wipes an existing storyboard's generated shots (both merge sides protect them) — regenerating the next scene could previously erase the previous scene's results.
- **Consistency warnings use the `@Name@` lexer on the host too**: the old scanner treated every closing `@` as the start of a new mention and reported prose between references as unregistered assets.
- **`canvas_connect` picks the semantic default port** for storyboards (script/text → `script`, storyboard → `prev`) instead of the first input port.
- **Project deletion could crash the host on non-ASCII paths**: `fs.rmSync(recursive)` aborts the Node process on Chinese-named directories — replaced by a safe recursive delete.
- Wiring is drawn as straight lines when ports are vertically aligned; the storyboard `tail`/`prev` dots are centred on their anchors.

## [0.17.14] — 2026-10-15

### Added
- **`@Name@` asset references (double-@ syntax)**: the closing `@` is an explicit terminator, so adjacent or glued references can never swallow the following text. The UI hides both `@`s and renders the name in **bold blue** in prompt fields, text nodes and storyboard shots (typing `@Name@` turns blue as you finish it). Unknown `@Name@` is still reported by the consistency check so the asset gets registered.
- **Asset anchoring in scripts and scene texts**: generated episode scripts wrap every character/scene/prop name as `@Name@`, and the storyboard contract carries those anchors into shots — downstream generation always knows which words are assets.
- **`canvas_relayout` tool**: one call re-arranges a canvas by rows — horizontal data flow decides columns (`text → storyboard → video`), vertical links (continuity `prev`, first-frame `frame`) stay in the same column, each row is one horizontal group (e.g. "scene N text ↔ scene N storyboard"), with collision avoidance and a minimum gap.
- **Help & feedback entry**: a toolbar button plus a one-line settings entry open a compact dialog with the GitHub issue link and the WeChat group QR code (shipped inside the plugin and served through a whitelisted static-asset route).
- **API key reveal toggle**: key fields are masked by default; an eye button shows the plaintext for verification.
- Node auto-layout on the agent side: new nodes land in type-based rows with collision detection (28px minimum gap), so freshly created cards never overlap; the storyboard shot list is drag-resizable and the node grows downward with it.

### Fixed
- **Project deletion could crash the host on non-ASCII paths**: `fs.rmSync(recursive)` aborts the Node process (STATUS_STACK_BUFFER_OVERRUN) on Chinese-named directories — deleting a project could take DSH down with it. Replaced by a safe recursive delete (readdir + unlink/rmdir).
- **Generated shots are no longer lost to stale sync**: both the client merge and the host merge keep an existing storyboard's shots when an incoming copy has none (previously generating the next scene could silently wipe the previous scene's shots).
- **Storyboard wiring picks the right port**: `canvas_connect` without an explicit target port now chooses by semantics (script/text → `script`, storyboard → `prev`) instead of blindly using the first input port.
- **Consistency warnings use the `@Name@` lexer on both sides**: the previous host-side scanner treated every closing `@` as the start of a new mention and reported prose between references as unregistered assets (and bible updates recomputed those bogus entries).
- Continuity wires are drawn as straight lines when the two ports are vertically aligned, and the storyboard `tail` / `prev` dots are centred on their anchors so wires leave the dot centre.
- Packaged files: `assets/support/*` now ships with the plugin, so the WeChat QR is visible for every install (not just the author's machine).

## [0.17.13] — 2026-10-14

### Fixed
- package.json is published without a UTF-8 BOM (the BOM broke DSH plugin validation on install).

## [0.17.12] — 2026-10-14

### Added
- **Storyboard continuity ports**: storyboard nodes now expose a `prev` input ("continue previous tail", top) and a `tail` output (bottom). Wire `prev storyboard.tail → next.prev` and generation injects the previous tail shot as a **hard continuity constraint** — shot 1 continues from the previous last action, overlap ≤ 0.2s, ambient background sound continuous, no re-establishing shots. Wiring is the only continuity source (never name/position matching).
- **Per-node chaining mode** on video nodes with a first-frame input: **Fuse with refs** (default — tail frame becomes reference image #1), **Hard first frame** (true `first_frame` param, drops refs — the gateway forbids mixing), **Ignore frame**.
- **Lip-sync hard rules**: storyboard shots carrying dialogue must show the speaker talking on screen (close/medium-close, face visible, never back-to-camera or off-frame); video prompts state "spoken on screen, lip-synced" per dialogue shot — no more voice-over with closed mouths.
- **Video vendor preset layer**: pick a vendor format in settings, then only Base URL + model id — endpoints, auth, parameter shapes, polling and result download are handled per vendor. Adapters: **Kling** (AK:SK → auto-signed JWT), **Alibaba Wan/DashScope**, **MiniMax Hailuo**, **Vidu**, **Runway Gen-4**, **Google Veo (Gemini API)**, **Luma**, **PixVerse**, **Stability AI**, plus the existing **Volcengine Ark Seedance** and **OpenAI-compatible** formats. Legacy configs auto-detect.
- **Video-asset nodes gain a `last` output** with automatic tail-frame extraction for imported/uploaded videos; every node holding a video (generated or imported) auto-extracts its tail frame.
- Resilient video task polling: gateway blips (5xx/timeouts/network) never abort a task — only the task's own terminal state decides; 2h safety window; **task id + query URL persisted on the node** (and surfaced via `canvas_node_status`) so interrupted runs can be recovered.

### Fixed
- First frame and reference images are never mixed in one request (Seedance gateways reject the combination) — across all protocols.
- Dialogue and SFX annotations now flow through shots into video prompts, the storyboard UI, saved assets and `canvas_node_status` (previously dropped on the way to the video prompt).
- Asset index sync keeps file-backed records (manual data-root registrations survive); saving the same data-root no longer rebuilds the index; "Import from data root" is always clickable.
- Agent-side storyboard writes keep the `sfx` field; continuity notes are no longer duplicated across fallback protocols.
- UI: lightbox viewer for images/videos, selectable+copyable storyboard shots with a drag-resize shot list, video history thumbnails show real covers.

## [0.17.11] — 2026-10-14

### Script → Scene → Storyboard → Video pipeline (macro rework)
- **Script nodes produce one episode** (60–120s of screen time, 4–10 scenes) and every scene must start with its own `【场N】name (location · time)` header — the machine-readable hook for scene expansion.
- **New "Expand to scenes" action on script nodes**: splits the episode by scene headers into per-scene text nodes + storyboard nodes, wired automatically (text → storyboard, one storyboard per 10–15s scene). The agent side replicates the same split via `canvas_create_node` / `canvas_write_node` / `canvas_connect`.
- **Storyboard contract hardened**: full coverage of the wired scene (every action and every line lands in a shot — no summarizing, no cherry-picking); per-shot `dialogue` annotations (verbatim lines with roles — feeds voice-reference extraction); shot count follows the actual action beats (auto mode — never a fixed number); total duration hard-capped to **≤ 15s** (longest shots auto-trimmed after parse).
- Capacity warnings: a wired source far beyond one storyboard's 10–15s budget raises a warning the agent can see on `canvas_node_status`.
- Skill rewritten around the macro flow: episode script → expand to scenes → per-scene multi-shot video → tail-frame chaining; hard rules against wiring a whole episode into one storyboard or manufacturing per-shot image/video nodes.

### Video API compatibility
- **OpenAI-style video endpoints** (JUAI and similar aggregators): URL normalization (bare domain / `/v1` / full endpoint all work), lowercase resolution, first-frame mode forces `ratio: "adaptive"`, references sent as `{url, role}` objects, first-frame and references never mixed, result extracted from `metadata.url`, terminal "completed without URL" reported instead of polling forever.
- **Automatic fallback chain** when the primary submit is rejected: flat format → Seedance-native `content[]` format (poll `GET /v1/video/query?task_id=`) → Sora-style `/v1/videos` (submit / poll / authenticated content download). Covers gateways such as RelayRouter where `/v1/video/generations` does not serve seedance channels.
- Video errors now include the actual request URL and a response excerpt.

### Model configuration: providers + models
- Image/video API settings restructured into **two levels** — a provider (URL/key configured once) with multiple models underneath; star one model as the **default route**.
- Node model dropdowns list configured models directly (the "default config" pseudo-entry is gone): an empty selection routes to the starred default; nothing configured fails the run with a clear error instead of silently generating a demo.
- **Extra params (JSON)** per provider merge vendor-specific keys (`watermark`, `prompt_extend`, `output_format`, `seed`, …) into the request body last — switching vendors needs no code changes.
- Optional video params: `generate_audio` (sent only when checked) and `output_format` (sent only when filled).
- Video downloads retry once with credentials on 401/403 (authenticated content proxies).
- Legacy flat API configs and node-level api ids migrate automatically.

### Voice consistency
- **Character voice references**: audio assets bound to a character (named `角色-<name> 声音` or linked to the bible entry) are attached automatically as `audios[]` (`reference_audio`) to video requests; sync audio is force-enabled when present.
- **"Extract voice reference"** on video/finalcut nodes: type a character name — every dialogue window is located automatically from the storyboard `dialogue` annotations (shot-duration-proportional mapping onto the real timeline with breath padding) and merged into **one WAV** reference file (WebAudio decoding, no external dependencies). Manual time-range mode stays as a fallback.

### Fixes
- Agent-side node deletions are no longer resurrected by stale client pushes: the sync "live canvas wins" exemption now applies only to nodes the user deleted in the UI and restored via undo.
- Storyboard JSON containing unescaped straight quotes inside string values (e.g. `喷漆"拆"字`) is repaired (state-machine scan → 「」) and re-parsed instead of failing the whole generation.
- Reference images and first frames are downscaled (1024px JPEG) before embedding — multi-reference requests no longer exceed the 16MB proxy limit (HTTP 413).

## [0.17.10] — 2026-10-13

### Added
- **Consistency-warning loop closed.** `canvas_node_status` now returns `warnings` for storyboard nodes — the list of entities that appear in shots but are **not registered** in the series bible or **registered with an empty description** (including `@mentions` found in the visual/motion text, which the shot arrays alone could miss). The agent side reads this list and fills every entry via `canvas_update_bible` (names verbatim, workable descriptions) — a hard rule in the skill.
- Warnings **recompute automatically** whenever they could go stale: shots written, the bible updated from the chat side, or the client pushing bible changes — so a filled bible clears the outdated warnings within seconds.
- **Asset categories are now derived from the naming convention** (`角色-`/`场景-`/`道具-`/`剧本-`/`分镜-` prefixes → character/scene/prop/script/storyboard) when `@mentions` don't resolve — generated assets no longer fall into "General" just because the prompt skipped the `@` syntax.
- Startup self-check **re-categorizes legacy assets** that sit in "General" but follow the naming convention (toast reports the count; manually-set categories are never touched).

### Fixed
- Consistency-check ordering: missing entries are auto-registered (with empty descriptions) **before** the check runs, so the warnings no longer flag entities that were just auto-registered; duplicates removed.

## [0.17.9] — 2026-10-12

### Changed
- Data-root card simplified: the **"Migrate existing assets" button was removed** — migration is now fully automatic (on data-root set and on every startup, browser-stored assets are moved to the data root, then the `assets.json` index re-aligns; a toast reports the count).
- "Open folder" and "Import from data root" merged into a single row (with an ⓘ hover hint).

## [0.17.8] — 2026-10-12

### Changed
- Settings redesigned. Card order: Language → Data root → Craft → Skills → Text model → Image → Video → TTS (all model cards grouped together).
- **Text model card selects the model only** — maxTokens/temperature inputs removed; generation parameters always come from Harness (legacy stored values are stripped and never sent).
- **Skills** split into their own card.
- Long explanations moved into ⓘ hover tooltips; the UI keeps controls only.

### Craft (ArtCraft) bridge
- Craft card is **collapsible** (collapsed by default with an "n/n ready" summary; toggle at the far right).
- Status lights now render the **whole Craft family dynamically** — every bin reported by ArtCraft `/status` (12 crafts) gets a light, instead of a hardcoded three.
- Craft file paths unified under the **canvas data root**: FilmCraft timeline/SRT/project/MP4 output, PhotoCraft graded images and synced media all live in `projects/<project>/craft/…` next to scripts, storyboards and assets.
- The separate ArtCraft data-root wording was removed; when ArtCraft's own root differs from the canvas data root, the card shows a red mismatch warning.

## [0.17.7] — 2026-10-12

### Fixed
- **Image APIs finally work from the browser.** All third-party gateway calls are proxied through the Harness host (`/api/fetch-proxy`) — browser-direct calls were blocked by CORS (`Failed to fetch`) because image gateways don't return CORS headers. Covers image `generations`, multi-reference `edits` (multipart), signed-URL downloads, generic video submit+poll, the **Seedance official protocol**, video downloads and TTS. Status codes, bodies and content-types are relayed verbatim; upstream timeouts surface as readable "timeout" errors.

### Added
- **The data root is now a portable data package.** Project folders use the **project name** (project ids stay as logical paths, mapped by the host at the I/O boundary). Each project folder mirrors `project.json` (nodes/edges/**series bible incl. assetIds bindings**) and `assets.json` (asset metadata index) plus media files, updated in real time. `canvas.meta.json` keeps the id→folder map.
- **One-click import**: copy the data folder to a new machine → set it as data root → *Import from data root* restores projects, nodes, bible and assets (newest-wins by `updatedAt`).
- Asset names follow **"node name + time"** everywhere (scripts, storyboards, images, videos, final cuts).
- **Asset deletion syncs the data root** (file deleted via the id→folder mapping + index entry removed).
- The asset index **self-heals**: the startup full sync replaces `assets.json` from the browser library (single source of truth; empty projects align too).
- Storyboard nodes got a manual **"Save as asset"** button; text assets (script/storyboard markdown) persist to the data root.

### Fixed
- **Project deletion resurrection**: deleting no longer pushes the doomed document to the host first (race), and the host now keeps a long-lived deletion tombstone — late `projectsPut`s (debounce races, startup snapshot pushes) are rejected. Importing a project clears its tombstone.
- Bible merging no longer drops `assetIds` bindings; `projectsPut` writes atomically and mirrors to the data root.

## [0.17.6] — 2026-10-12

### Changed
- **Storyboard workflow corrected: one storyboard = one multi-shot generation.** Expanding a storyboard wires it to a *single* video node; all shots (order + per-shot duration) are composed into one multi-shot prompt and the video model renders the whole clip in one call — no per-shot videos, no stitching seams.
- AI storyboard contract rewritten: 2–5 s per shot (one continuous action beat), durations sum to the target length (15 s ≈ 4–7 shots); default shot count 12 → 6; 12 s/15 s added to video durations; agent-created video nodes auto-connect to the latest storyboard.

### Fixed
- Node-deletion resurrection (three rounds): marquee/single-click/Delete-key deletions now record tombstones and push immediately; tombstones respect the in-memory canvas; undo/redo reconciles tombstones.
- Asset-delete confirmation dialog white screen; panel error boundary (crashes show a copyable card instead).

### Added
- Asset library: project scope filter with a **General project**, assets can move between projects, binding dialog v2; storyboards auto-register missing bible entries.

## [0.17.5] — skipped (unreleased)

## [0.17.4] — 2026-10-11

### Added
- **Data root**: images/videos persist to any disk you choose, organized in per-project folders (no longer filling browser IndexedDB on C:); served with HTTP Range support for video seeking.
- System **folder picker** for the data root (no more hand-typing paths).

## [0.17.3] — 2026-10-11

### Fixed
- "Check update" silently doing nothing on old hosts (mixed-version `behind=0` combination).

### Changed
- **Real update install** ("Go upgrade" actually installs): runs `pnpm add <pkg>@<exact>` inside the owning profile, syncs the bundle list, then only *prompts* to restart Harness — never auto-restarts. Graceful degradation to guidance-only when in link/dev mode, pnpm is missing, or the install fails; a supply-chain cooldown is applied automatically.

## [0.17.2] — 2026-10-11

### Added
- **Unified update check** (independent of install mode): latest version = npm registry `latest`; local version = the running `package.json`; outdated → banner with a "Go upgrade" action. Update semantics never compare hashes and never auto-refresh.
- Release tooling: GitHub Actions publish workflow (npm Trusted Publishing / OIDC) and bilingual publishing notes.

### Changed
- Update button shows a text badge instead of a version number; hovering shows the running version.

## [0.17.1] — 2026-10-10

### Fixed
- Black screen caused by a v0.17.0 toolbar scope error.
- Version badge now prefers the actually-running version.

## [0.17.0] — 2026-10-10

### Added
- In-plugin **update check + one-click update**.
- GitHub Actions publish workflow (npm Trusted Publishing / OIDC — no npm token anywhere).

### Changed
- Package renamed to the scoped `@ninkch/dsh-infinite-canvas`.

## [0.16.0] — 2026-10-10

First public npm release: infinite-canvas studio for DeepSeek Harness — script/storyboard/image-gen/video-gen/final-cut nodes, series-bible consistency, `@mention` reference binding, multi-config generation backends (OpenAI-compatible images, generic + Seedance video, TTS), demo mode, ArtCraft (PhotoCraft/FilmCraft/EffectCraft) bridge.
