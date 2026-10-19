# Migrating to the 0.18 storage engine

Version 0.18.0 moves all Infinite Canvas data (project documents, the asset library,
and media files) into **one self-contained data directory**. This guide covers
upgrading an existing deployment and moving data to a new machine.

## What changed

| Before (≤ 0.17.x) | After (0.18+) |
|---|---|
| Asset metadata in **each browser's IndexedDB** | **`<dataRoot>/canvas.db`** (SQLite, WAL) — one source of truth for every browser |
| Project documents in `~/.dsh/infinite-canvas/projects/*.json` + a mirror in the data directory | Stored in `canvas.db`; the old files are frozen and no longer written |
| Media in `<dataRoot>/projects/<project>/<kind>/…` + metadata mirror `assets.json` | New uploads go to `<dataRoot>/projects/<project>/<kind>/…` and are recorded in `canvas.db`; legacy files stay where they are and keep working |
| Copying the data directory was not enough to migrate | The data directory **is** the complete data package — copy it, point the data root at it, done |

## A note on `objects/` (versions 0.18.0–0.18.4)

For a few 0.18 releases, newly uploaded media was stored content-addressed under
`<dataRoot>/objects/<sha2>/<sha256>` instead of the project folder. That **write
path has since been retired** — current versions never create new objects — but
**media uploaded during 0.18.0–0.18.4 still lives there and is still served** by
`GET /api/object`. Keep the `objects/` directory when you copy or back up your data
root, otherwise those older assets will fail to load.

Deleting an asset still reclaims its object when no other asset references it, so
the directory does not grow unbounded.

## Upgrade the production machine

1. **Update the plugin to 0.18.0** (in DSH: check updates on the Infinite Canvas
   toolbar, or `updateInstall`). Requires DSH host on Node ≥ 22.5 — the bundled
   Node 24 satisfies this. Restart the Harness when prompted (index.js changed).
2. **Open the canvas once.** On first data-root access the plugin creates
   `canvas.db` and auto-imports everything it finds:
   - project documents from `~/.dsh/infinite-canvas/projects/*.json` **and** the
     data-directory mirrors (newer `updatedAt` wins),
   - asset metadata from the legacy `assets.json` indexes.
   Legacy media files are **not moved** — the database keeps pointing at them, so
   the migration cannot lose media.
3. **Open the canvas once in each old browser** that was used before the upgrade
   (e.g. the desktop app webview). Blobs that were still only in that browser's
   IndexedDB are uploaded to the server automatically, then removed locally.
4. Verify: the asset panel shows your library, previews load, `@Name@` mentions
   resolve. Other machines/browsers now see the same library immediately.

## Move everything to a new machine

1. On the old machine, **quit the Harness** (a clean exit folds the WAL journal
   back into `canvas.db`). If you must copy a running directory, copy all
   `canvas.db*` files (`canvas.db`, `canvas.db-wal`, `canvas.db-shm`).
2. Copy the **entire data directory** to the new machine (e.g. `D:\canvas-data`),
   including `objects/` — the historical object store (see the note above) is still
   needed for media uploaded on 0.18.0–0.18.4. If you started on 0.18.0–0.18.4 and
   never upgraded in between, your newest assets may be in `objects/`; after the
   upgrade, keep that folder.
3. On the new machine, install the plugin (0.18+), open Infinite Canvas →
   Settings → data root → point it at the copied directory. The database mounts
   as-is; if the directory is an old ≤ 0.17 layout (no `canvas.db`), the one-shot
   migration runs automatically.
4. Open the canvas — all projects, storyboards, the bible and the full asset
   library are there. No import button needed.

## Remote access (tunnel / another PC)

Nothing special: with the data root configured on the host machine, any browser
that can reach the Harness web UI gets the same projects and assets. Asset
content is streamed by the host (`/api/object`, `/api/file`), and previews work
remotely. Note that these routes follow your Harness authentication — put your
tunnel behind access control if the content matters.

## Rollback

Downgrade the plugin to 0.17.x and it reads the legacy stores again. Everything
that existed before the upgrade is still in its original location (old project
JSON files, `assets.json`, media files) — 0.18 freezes them rather than deleting.
Data created **after** upgrading lives only in `canvas.db` (and, for media uploaded
on 0.18.0–0.18.4, `objects/`) and will not appear under 0.17.x, so treat rollback as
a one-way door for new data.

## Backup

With the Harness stopped, backing up the data directory is a plain file copy:
`canvas.db` (plus `-wal`/`-shm` if present), `projects/`, and — if you ever ran
0.18.0–0.18.4 — the historical `objects/` directory. To verify integrity after
restoring, open the canvas and spot-check a few assets; the database can be rebuilt
from a frozen ≤ 0.17 layout plus browser-side uploads if ever needed. Unreferenced
objects are reclaimed automatically when the asset that pointed at them is deleted.
