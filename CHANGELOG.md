# Changelog

All notable changes to `@ninkch/dsh-infinite-canvas` are documented here (newest first).
GitHub Releases carry the same notes in English; maintainer-facing runbooks live in
[`RELEASING.md`](RELEASING.md) and [`docs/release.md`](docs/release.md).

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
