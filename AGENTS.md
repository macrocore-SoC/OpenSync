# OpenSync — Agent Instructions

Two apps in one repo: the **Node/Express server + vanilla-JS web UI** at the root, and a separate **Rust/Tauri v2 desktop launcher** in `launcher/`. Product: self-hosted LAN game archive with differential save sync.

## Commands

```
npm run dev                      # node --watch server/index.js
npm start                        # production
npm test                         # node --test tests/*.test.js
node --test tests/<file>.test.js # single test file
npm run lint                     # node --check + no-console scan (scripts/lint.js)
npm run db:init                  # creates storage/ + schema; migrations auto-apply via getDb()
bash install.sh                  # one-shot installer + `opensync` CLI symlink
cd launcher && cargo test        # launcher Rust workspace tests
cd launcher && cargo run -p launcher-tauri   # needs WebKitGTK/GTK3 dev libs (launcher/README.md)
```

Env: `PORT` (3000), `HOST` (0.0.0.0), `OPENSYNC_STORAGE` (./storage), `OPENSYNC_SECRET`.
Lint rule: no `console.log`/`console.debug` in non-CLI files; use `console.error` server-side. Exempt: `server/index.js`, `server/db.js`, `scripts/*`.

## Server stack (verified — don't rethink)

- **Node ≥ 22.13**, ESM, Express 5. Floor is 22.13, not 22 (`node:sqlite` was experimental before 22.13). Keep `package.json` `engines`, `install.sh` `MIN_NODE_MAJOR/MIN_NODE_MINOR`, and README in sync.
- **`node:sqlite` `DatabaseSync`** (`getDb()` in `server/db.js`) — not better-sqlite3. **archiver v8**: `createRequire` → `const { ZipArchive } = require('archiver')` → `new ZipArchive(...)` (not `archiver('zip')`).
- Passwords: `crypto.scrypt`. Sessions: HMAC-signed stateless cookies; logout bumps `users.session_version` (token carries `sv`).
- `server/config.js` is the only env/path parser (`STORAGE_ROOT`, `GAMES_ROOT`, `USERS_ROOT`, `DB_PATH`, `SECRET_PATH`, `CHUNK_SIZE`, `SESSION_TTL`, `COOKIE_NAME`, `ROLES`) — never read `process.env` in routes. Secret lives at `storage/server-secret` unless `OPENSYNC_SECRET` is set.
- Web hashing is a hand-rolled streaming SHA-256 in `client/js/sha256.js` (Web Crypto has no incremental digest).

## Architecture constraints (non-negotiable)

- Games are **live folders** (`storage/games/{id}/files/`), never archives. Manifest is JSON per game (`manifest.json` = `{game_id, files:[{path, hash, size}]}`). SQLite holds metadata only.
- Downloads **stream** via `res.flushHeaders()` — no cached zips. Merge order clean + overlay − deletions, sorted by path. Compression OFF (`STORE`) by default; `?deflate=1..9` opts in (invalid → store); `?fresh=1|true` streams clean manifest only. Game view offers a fresh/synced choice only when `has_overlay`. Admin `GET /api/admin/bench` measures in-memory zip throughput.
- Overlays: `storage/users/{uid}/games/{gid}/{overlay/, deletions.json, overlay_manifest.json}`. **Diff is always against the clean manifest, never chained.** Server re-hashes every received overlay file (`x-hash`); mismatch → 422 + file deleted.
- `safeRelPath` in `server/storage.js` is the single gate for all client-supplied paths (rejects absolute, `..`, backslash, NUL). Never bypass it.

## Server gotchas that are easy to get wrong

- **Chunked uploads**: fixed 4 MB (`CHUNK_SIZE`), must arrive in order (409 otherwise), oversized → 413 (both `games.js` and `chunked.js`), 0-byte files allowed. Resume via `upload/init`. Last chunk + empty uploads dir triggers a 2 s `AUTO_COMPLETE_DELAY` timer calling `processGame` (only while `processing`); `processGame` has a module-level in-flight guard so the timer can't race an explicit `upload/complete`. `upload/complete` on a ready game 409s unless new files were posted (`reuploadedReady` Set, process-local) — then it regenerates the manifest and restores `ready` on failure.
- Stale-upload sweep in `server/index.js` every 5 min deletes `processing` games inactive for 10+ min — keep chunk activity flowing.
- **Deletions** are versioned: `deletions.json` = `{manifest_hash, paths}`; stale (old manifest / legacy bare array) ignored at download. `sync/complete` 400s if deletions cover >50% of the manifest unless `force: true` (client confirms first).
- Orphan cleanup: self-delete and admin user-delete `rm(USERS_ROOT/{uid})`; `deleteGame` removes all users' overlays for that game; boot GC sweeps numeric-name orphan dirs. Comments survive deletion (`ON DELETE SET NULL`, rendered as `deleted`).
- First user = admin; last admin can't be demoted/deleted; self-demote blocked (self-delete via `DELETE /api/auth/me` still guards last admin).
- Username normalization (`server/usernames.js`): trim + NFC, then Unicode lowercase → `username_norm` unique index. Register, login, and admin-create must all use it.
- Optional pfp: NULL coalesces to `/img/blankpfp.jpg` via `pfpOf()`/maps; stored pfp is a per-user URL `/api/auth/users/{id}/pfp`. Comments/notifications use threaded `parent_id` + @mentions matched by `username_norm`.

## Web UI

Dark theme, CSS vars in `client/css/terminal.css`; Inter body, Joystix 24px `page-title` with a consistent 18px vertical rhythm (no extra top padding), 730-weight green stat numbers. Nav active state is a green underline only.
Uploads survive navigation (module-level `session` + cached DOM in `views/upload.js`); the global `#uploadbar` also carries sync progress and is shown on any active route. Topbar hidden on `#/login` via `style.display`. Comment inputs have an @mention picker (`attachMentionPicker` in `game.js`).

## Tests

`NODE_ENV=test` makes `server/index.js` export `app` without listening; `tests/helpers.js` sets `OPENSYNC_STORAGE` to a tmp dir *before* the first import. `node:sqlite`/dynamic imports are process-cached: one shared server per test file, so use unique usernames and returned `game.id` (never hardcode 1); first registrant is admin. Clean-DB tests live in `tests/bootstrap.test.js`.
Windows-only artifacts, not bugs: `rmSync` after `server.close()` throws EPERM (whole file marked failed though assertions pass — run the single file); `cli.test.js` skips without `script`/`setsid` bash ptys. `docker.test.js` and `version-guard.test.js` are static (no daemon). Install deps first.

## Launcher (`launcher/`)

- **Tauri v2 + Rust workspace**, not GPUI: 8 crates (`launcher-db`, `opensync-api`, `opensync-transfer`, `opensync-sync`, `opensync-proton`, `opensync-runner`, `launcher-core`, `launcher-tauri`). Frontend is plain JS in `crates/launcher-tauri/ui/` (`index.html`, `js/`, `css/launcher.css`, `img/`, `fonts/`); Rust shell is `launcher-tauri/src/{main.rs,commands.rs}`. **`docs/launcher-spec.md` is an older aspirational GPUI design — trust code + `launcher/README.md`.**
- **Icons come from the user's Downloads folder**: use `~/Downloads/opensync-app-logo.png` (1024×1024) as the source artwork for launcher branding — not the web `Art/` assets. Already derived: `icons/icon.png` (512) → `128x128@2x`, `128x128`, `32x32` and `ui/img/favicon.png`; wordmark variants are `ui/img/opensync-nav-1x|2x|3x.png` and `opensync-auth-1x|2x|3x.png`. Keep `tauri.conf.json` `bundle.icon`, `index.html` logo/favicon, and `app.js` auth-logo `srcset` in sync when refreshing branding.
- **Card hover animation**: the launcher's `.card.steam-card` rules in `crates/launcher-tauri/ui/css/launcher.css` are intentionally **visually identical** to `client/css/terminal.css` (same tilt defaults 3.5/-4.5deg, `--gx/--gy` moving sheen, tilt constants 7/8, frosted `backdrop-filter` footer/center button/pill, animated box-shadow + border, 0.28s/0.45s curves, stat-ticker blur, keyframe pulse). WebKitGTK repaint cost is trimmed without changing the look: `attachSteamTilt()` (`ui/js/app.js`) rAF-throttles pointer tracking, caches the rect on `pointerenter`, and skips redundant CSS-var writes; `will-change: transform, opacity` is set on sheen/pill/footer/center button. Don't diverge the CSS values without changing the web UI too.
- `normalize_server_url` rewrites wildcard binds (`0.0.0.0`, `[::]`) to `127.0.0.1` in both JS (`ui/js/app.js`) and Rust (`opensync-api`), since the server prints `0.0.0.0` as its LAN URL. Login/register errors surface the server's message (Rust `extract_auth` + JS `formatAuthError`) rather than a generic session-expired error.
- **Single `settings` view** (nav/#settings) replaced the old `proton` + `instances` tabs: it stacks Games directory, Proton, and Instances sections (`renderSettingsView()` → `renderGamesDirSetting`/`renderProtonSection`/`renderProfilesSection` in `ui/js/app.js`); gamepad `${TAB_ORDER}` is `library/downloads/settings`.
- **Games directory** = where server downloads are installed. Auto (`launcher-core::default_games_dir()`) = `~/Games/OpenSync`, or `~/games/OpenSync` if lowercase exists; if neither exists it creates `~/Games/OpenSync`. Override via the settings input, `OPENSYNC_LAUNCHER_GAMES_DIR`, or the `app_state` key `games_dir`; `LauncherCore::set_games_dir()` persists + swaps `library_root` at runtime, existing installs keep their absolute SQLite `install_dir`. The top-right chip shows **user first** (avatar monogram + username), instance label second.

## Docker, CI, install/CLI

`Dockerfile`: node:24-alpine, `npm ci --omit=dev`, copies only `server/`+`client/`, runs as `node`, data in `/data` volume, healthcheck on `/api/health`. Data (uploads, overlays, DB, secret) must live on the volume. CI pushes `ghcr.io/piskevalee-cpu/opensync` — `:latest` on main, version tags on `v*`; **amd64 only** (ARM users use `install.sh`). Keep the image name consistent across README, compose, workflow, and tests.
`opensync` (`scripts/cli.sh`) is a PID-file service (`storage/opensync.pid`, log `storage/opensync.log`); active requires live PID **and** `GET /api/health` on 127.0.0.1:PORT. Dashboard is a cbreak TUI (alt screen, redraw only on change); `[q]` quits **and stops** the server; falls back to one-shot status when not a TTY. `install.sh` and `scripts/lib.sh` carry duplicate banner/helper copies — keep them in sync; `read -p` writes to stderr, so under `curl | bash` prompts must `printf >/dev/tty` before `read </dev/tty`.
