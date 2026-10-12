# Changelog

All notable changes to `@ninkch/dsh-infinite-canvas` are documented here (newest first).
GitHub Releases carry the same notes in English; maintainer-facing runbooks live in
[`RELEASING.md`](RELEASING.md) and [`docs/release.md`](docs/release.md).

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
