# OpenSync Launcher — Architecture & Design Specification

**Status:** v0.2 (Tauri v2 + Rust Core)  
**Target Stack:** Rust workspace + [Tauri v2](https://v2.tauri.app/) (native OS WebView frontend + Rust core backend)  
**Platforms:** Linux (primary, native + Proton), Windows (native), macOS (client/archive browsing)  
**Backend Target:** Self-hosted OpenSync server (`>= 1.0.0`)

---

## 1. Product Vision & Subject Grounding

OpenSync Launcher is a native desktop game cabinet and runner for your personal, self-hosted OpenSync archive.

Unlike storefront launchers (Steam, Epic, GOG Galaxy), OpenSync Launcher has **no store, no ads, no recommendations, and no social feed**. Its audience is people running their own LAN or Tailscale game server who want their offline library to feel as effortless as a console: connect once, download at full wire speed, press **Play** (whether the game is native Linux or Windows via Proton), track playtime automatically, and have saves synced back to the server the moment a session ends.

### Primary Jobs
1. **Connect securely** to one or more self-hosted OpenSync instances (LAN IP, hostname, or HTTPS domain).
2. **Download reliably and fast** from your archive with streaming verification, pause/resume, and a dedicated Download Manager.
3. **Launch effortlessly** — native binaries and Windows `.exe` builds via auto-detected or one-click-installed Proton.
4. **Sync saves automatically** before launch and after exit using OpenSync's per-user differential overlay protocol.
5. **Track screen time** accurately across native and Proton process trees, ignoring system sleep/suspend.

---

## 2. Visual Design Plan (Two-Pass Studio Process)

### Pass 1 — Initial Design Proposal

- **Color tokens (Pass 1):**
  - `#0A0A0C` canvas, `#14141A` panels, `#26262F` borders, `#E6E6E6` text, `#7DFA9B` acid-green accent.
- **Type (Pass 1):**
  - Inter everywhere, Joystix pixel headings, uppercase tracked labels, middle-dot metadata strings (`24.3 GB · 14h · Proton 9`).
- **Layout (Pass 1):**
  - Top navbar + uniform 4-column rounded card grid mirroring the web app, plus a modal for downloads.
- **Motion (Pass 1):**
  - Fade-and-slide-up animations on view changes and bounce hover transitions on every card.

### Pass 2 — Critique Against Brief & Revisions

Reviewing Pass 1 honestly reveals several generic defaults that do not serve a native GPU-accelerated desktop launcher:

1. **Near-black + acid-green default:** `#0A0A0C` with `#7DFA9B` reads as a generic terminal-AI default on desktop, even though the web app uses it. **Revision:** Shift to a grounded, hardware-inspired **Obsidian Slate** (`#121417`) and **Graphite Deck** (`#1A1E24`) surface pair with a calmer, high-contrast **Phosphor Jade** (`#46D39A`) primary action accent and **Amber Brass** (`#E5A93B`) strictly for compatibility/warning states. This stays unmistakably within the OpenSync family while feeling like a physical console deck rather than a webpage in a frame.
2. **Identical SaaS cards + top navbar:** Desktop launchers have wide aspect ratios and persistent multitasking (downloading while browsing or launching). A uniform card wall wastes horizontal space and hides active downloads. **Revision:** Use a **slim 56px vertical icon rail** on the left, a **full-bleed cover hero stage** as the single bold visual centerpiece when inspecting a game, and a dedicated **Download Manager** view + slim bottom transport strip only while a transfer or game is running.
3. **Template chrome (ALL-CAPS labels, middle dots, `→` button arrows, spaced em dashes):** Strip all uppercase transforms from labels, remove `·` metadata chains in favor of clean spaced tabular columns, remove decorative arrows from buttons, and write every label in plain, active-voice sentence case (`Play`, `Install`, `Syncing saves`, `Pause download`).
4. **Unfocused motion:** Drop generic section fade-ins and uniform card bounces. Spend GPUI's 60/120fps motion budget deliberately in **two signature places**:
   - **Cover Showcase:** Universal **2:3 Steam capsule aspect ratio (`600×900`)** with Bazzite/Steam-style 3D perspective tilt, diagonal fake-glass specular sheen on hover, and a **frosted glass footer** floating over the bottom of the cover displaying the game name and a frosted glass **Play** button (or **Download** on the web archive).
   - **Download Transport:** Live animated throughput waveform, streaming chunk bar with directional pulse while bytes move, and crisp state transitions (`Downloading` → `Verifying` → `Ready`).

### Revised Design System Tokens

#### Palette (5 Core Hex Values)
| Token | Hex | Role |
|---|---|---|
| `canvas` | `#121417` | Main window background (deep blue-tinted slate) |
| `surface` | `#1A1E24` | Sidebar rail, panels, download rows, dialogs |
| `stroke` | `#2A303A` | 1px structural dividers and control borders (no muddy drop shadows) |
| `ink` | `#ECEEE9` | Primary text (`#8B94A2` muted secondary at 60% visual weight) |
| `jade` | `#46D39A` | Primary CTA (`Play`, `Install`), active transfer progress, synced status |
| `brass` | `#E5A93B` | Proton/runtime notices, paused state, conflict prompts |

*(Destructive actions use muted coral `#E56B6B` strictly on confirmation states.)*

#### Typography
- **Primary UI & Display:** `Plus Jakarta Sans` (bundled as an embedded GPUI font asset) — geometric, legible at 12–14px, confident at 28–36px display sizes (`-0.02em` tracking on game titles).
- **Numeric & Technical Readouts:** `JetBrains Mono` (strictly for tabular counters: `112.4 MB/s`, `42h 18m`, disk sizes, SHA-256 progress, Proton build versions) with `tabular-nums` enabled so live figures never jitter.
- **Rules:**
  - Sentence case everywhere — no `UPPERCASE` labels or eyebrows.
  - Prose (game descriptions, empty states, error guidance) left-aligned and capped at `68ch`.
  - Vocabulary stays user-facing: "Saved progress" instead of "overlay", "Clean install" instead of "fresh manifest", "Game files" instead of "archive payload".

#### Layout Concept & ASCII Wireframes

**Option A — Split Cabinet (Recommended for Desktop ≥ 1100px)**  
Left-aligned content hierarchy; right-aligned numeric readouts and transport actions. Cover art owns the upper stage of the selected game; everything around it stays quiet.

```text
+----+---------------------------+--------------------------------------------------+
| OS | Library                   | [ Full-bleed 21:9 Game Cover Stage             ] |
|    | [ Search games...       ] | [ Subtle bottom scrim + title + Play / Sync    ] |
| [] | All (18)   Installed (6)  |                                                  |
| [] |                           |  Fogwoods                                        |
|  3 | [img] Fogwoods     14h 20m|  [ Play ]  [ Sync now ]  [ Proton 9-20 v ]  [...] |
|    | [img] Hollow Kn..  48h 05m|                                                  |
|    | [img] Celeste       6h 12m|  Installed  2.4 GB   Last played  Yesterday      |
|    | [img] Cyber Run..   Ready |  Save sync  Up to date (2 files, 184 KB)         |
|    |                           |                                                  |
|    |                           |  About                                           |
|    |                           |  Explore mist-covered timberlines, tune radio    |
|    |                           |  towers, and uncover what happened on the ridge. |
| [] |                           |                                                  |
+----+---------------------------+--------------------------------------------------+
| Downloading Cyber Runner 2077   [=============>        ]  64%   94.2 MB/s  1m 12s |
+-----------------------------------------------------------------------------------+
```

**Option B — Cover Shelf Grid (Toggleable View / Narrow Window < 1100px)**  
For browsing large libraries visually; clicking any cover expands smoothly into the full Game Stage.

```text
+----+------------------------------------------------------------------------------+
| OS | Library                          [ Search...        ]  [ Recently played v ] |
|    |                                                                              |
| [] | +-------------------+  +-------------------+  +-------------------+          |
| [] | |  [ Cover Art ]    |  |  [ Cover Art ]    |  |  [ Cover Art ]    |          |
|  3 | |  (hover: Play /   |  |                   |  |                   |          |
|    | |   Install scrim)  |  |                   |  |                   |          |
|    | +-------------------+  +-------------------+  +-------------------+          |
|    |  Fogwoods               Hollow Knight           Celeste                      |
|    |  Installed  14h 20m     Installed  48h 05m      412 MB  In archive           |
+----+------------------------------------------------------------------------------+
```

**Download Manager View**  
Dedicated workspace reached from the left rail (badge shows active count + subtle circular progress ring).

```text
+----+------------------------------------------------------------------------------+
| OS | Downloads                                          412 GB free on /games     |
|    |                                                                              |
| [] | Active                                                                       |
| [] | +--------------------------------------------------------------------------+ |
| [3]| | [cover] Cyber Runner 2077                    94.2 MB/s    1m 12s left    | |
|    | |         Extracting & verifying 18.4 GB of 28.6 GB                        | |
|    | |         [~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  live speed waveform ~~~~~] | |
|    | |         [============================>                ] 64%              | |
|    | |                                              [ Pause ]   [ Cancel ]      | |
|    | +--------------------------------------------------------------------------+ |
|    |                                                                              |
|    | Queued                                                                       |
|    | +--------------------------------------------------------------------------+ |
|    | | [cover] Hollow Knight       2.1 GB   Waiting       [ Move up ] [ Remove ]| |
|    | | [cover] GE-Proton 9-25    465 MB     Runtime       [ Move up ] [ Remove ]| |
|    | +--------------------------------------------------------------------------+ |
|    |                                                                              |
|    | Completed                                                                    |
|    | +--------------------------------------------------------------------------+ |
|    | | [cover] Fogwoods           64 KB     Verified 2m ago           [ Play ]  | |
|    | +--------------------------------------------------------------------------+ |
+----+------------------------------------------------------------------------------+
```

---

## 3. System Architecture (Rust + GPUI)

### Workspace Layout
```text
opensync-launcher/
├── Cargo.toml                  # Workspace root
├── crates/
│   ├── launcher-ui/            # GPUI views, theme tokens, animations, cover cache
│   ├── launcher-core/          # App state, event bus, settings, install coordinator
│   ├── opensync-api/           # Async HTTP client (reqwest + rustls), auth, manifests
│   ├── opensync-transfer/      # Streaming download/unzip, SHA-256 verifier, queue, throttling
│   ├── opensync-sync/          # Parallel folder scanner, diff engine, chunked overlay uploader
│   ├── opensync-runner/        # Process launcher, executable discovery, session & screen-time tracker
│   ├── opensync-proton/        # Proton discovery, GE-Proton downloader, prefix & umu-launcher integration
│   └── launcher-db/            # Local SQLite store (rusqlite + WAL) for metadata, installs, playtime
└── assets/
    ├── fonts/                  # Plus Jakarta Sans, JetBrains Mono
    └── icons/                  # Crisp monochrome SVG icons
```

### Core Technical Choices
- **UI Framework:** `gpui` (GPU-rendered at display refresh rate, native Wayland/X11/Windows/macOS windows, custom canvas painting for the live download speed waveform).
- **Async Runtime:** `tokio` bridged cleanly onto GPUI's background executor (`cx.background_executor()`) so disk hashing, streaming decompression, and HTTP transfers never block the UI thread.
- **HTTP & TLS:** `reqwest` with `rustls` (zero OpenSSL system dependency issues).
- **Hashing:** `sha2` + `rayon` thread pool for multi-gigabyte local diff scans at disk speed.
- **Database:** Local SQLite (`rusqlite`, WAL mode) at `$XDG_DATA_HOME/opensync-launcher/launcher.db` (or `%LOCALAPPDATA%\OpenSyncLauncher\`).

---

## 4. Instance Connection & Security

### Connecting to an OpenSync Server
1. User enters server address (e.g., `http://192.168.1.50:3000` or `https://games.lan`).
2. Launcher probes `GET /api/health` and `GET /api/info` to verify reachability and latency.
3. User signs in with `POST /api/auth/login` (or registers via `POST /api/auth/register`).
4. Multiple server profiles are supported (e.g., Home LAN + Friend's server) with instant switching.

### Security Model
- **Credential Storage:** The `ohs` session cookie (or future bearer token) is stored in the OS keyring (`keyring` crate: Linux Secret Service / KWallet, macOS Keychain, Windows Credential Manager) — **never** written in plaintext to config JSON or SQLite.
- **TLS & LAN Safety:**
  - Standard CA verification for public HTTPS domains.
  - Explicit **Trust-On-First-Use (TOFU)** certificate fingerprint pinning dialog for self-signed LAN HTTPS servers (displays SHA-256 cert fingerprint; warns loudly if the cert ever changes).
  - Clear subtle indicator when connected over plain HTTP on a private RFC1918/Tailscale LAN, and explicit confirmation warning if connecting over plain HTTP to a non-LAN host.
- **Path Traversal & Archive Integrity:**
  - Every zip entry path extracted during download is sanitized (rejecting absolute paths, `..`, symlinks escaping the game install root, and NUL bytes).
  - Every extracted file's SHA-256 is verified against `GET /api/games/:id/manifest` (or the merged overlay manifest) before marking the install `Ready`.

---

## 5. Download Engine & Download Manager

### Zero-Temp-File Streaming Pipeline
OpenSync's `GET /api/games/:id/download` streams an uncompressed (`STORE`) zip on the fly at disk/NIC speed. Rather than downloading a 40 GB `.zip` file and needing 80 GB free to unpack it, `opensync-transfer` streams directly to the install directory:

1. **Preflight:** Fetch `GET /api/games/:id/manifest` to compute exact required bytes and check free disk space (`statvfs` / `GetDiskFreeError`).
2. **Stream & Unpack:** Stream the HTTP response through an incremental ZIP parser (`STORE` entries require zero decompression CPU), writing each file into `<install_root>/.staging/<game_id>/` while computing SHA-256 inline via a tee writer.
3. **Atomic Commit:** Once all entries verify against the manifest, atomically move the staged directory into `<install_root>/<slug>/` and record `installed_manifest_hash` in SQLite.
4. **Pause / Resume & Delta Updates:**
   - **Works today (OpenSync 1.0):** Completed files in `.staging/` are tracked; resuming skips already-verified files or restarts cleanly if server-side zip streaming is interrupted.
   - **Recommended v1.1 Server Extension:** Add `GET /api/games/:id/file?path=<relPath>` with HTTP `Range` support (and optional `?overlay=1`). This unlocks true byte-exact pause/resume per file, multi-connection parallel downloads, and **delta updates** when a game is re-uploaded on the server.

### Download Manager UX & Animations
- **Queue controls:** Pause, resume, cancel (with automatic `.staging/` cleanup), move to top, and optional global speed cap (e.g., `50 MB/s` so LAN downloads don't saturate a shared connection).
- **Deliberate GPUI Animations:**
  - **Live Throughput Waveform:** Custom GPUI `canvas` element rendering a smooth 60fps spline of rolling throughput (last 30 seconds) with a soft `jade` fill fading cleanly to transparent at the baseline. Drops smoothly to a flat line when paused.
  - **Active Progress Bar:** Spring-eased width interpolation with a subtle luminous leading pulse strictly while bytes are moving; pauses immediately when stalled or paused.
  - **Rail Activity Ring:** The Download icon in the left rail draws a crisp circular progress arc around the icon when transfers are active in the background.
  - **Completion Morph:** When verification finishes, the row transitions cleanly from `Verifying` into a compact `Play` CTA with a single subtle highlight flash.

---

## 6. Seamless Launching & Proton Support (Windows Games on Linux)

### Automatic Executable Discovery
When a game finishes installing, `opensync-runner` inspects the install folder once and ranks launch candidates:
1. Read file magic bytes (first 4 bytes) rather than trusting extensions alone:
   - `\x7fELF` → **Native Linux executable** (automatically ensures `+x` permission bit).
   - `MZ` (PE header) → **Windows executable** (requires Proton on Linux).
   - `#!` script / `.AppImage` → **Native Linux script / AppImage**.
2. Filter out noise (`unins*.exe`, `UnityCrashHandler*.exe`, `vcredist*.exe`, `dxsetup.exe`, `DirectX/`, `_CommonRedist/`).
3. Prefer top-level executables matching the game name or largest primary binary; save the selection in SQLite and let the user change it in 1 click from the Game Settings popover (including custom launch arguments and working directory).

### Proton Auto-Detection (Linux)
When launching a Windows PE binary on Linux, `opensync-proton` scans for installed Proton runtimes in priority order:
1. OpenSync-managed runtimes: `~/.local/share/opensync-launcher/proton/*`
2. Steam custom compatibility tools (GE-Proton, etc.):
   - `~/.local/share/Steam/compatibilitytools.d/*`
   - `~/.steam/root/compatibilitytools.d/*`
   - `~/.var/app/com.valvesoftware.Steam/data/Steam/compatibilitytools.d/*`
3. Official Steam Proton installs:
   - `~/.local/share/Steam/steamapps/common/Proton*`
   - Additional Steam library folders parsed from `libraryfolders.vdf`
4. Heroic / Lutris Wine-GE / Proton directories (optional fallback).

Each discovered runtime is validated (contains `proton` script + `files/bin/wine` or `dist/bin/wine`) and surfaced in a clean runtime selector (global default + per-game override).

### One-Click Proton Download & Runtime Sandboxing
If **no Proton installation is detected** (or the user opens *Settings → Compatibility* to install a newer build):
1. Clicking **Play** on a Windows game opens a concise, friendly sheet:
   - *"This is a Windows game. Install GE-Proton to run it on Linux."*
   - Offers **Download latest GE-Proton** (shows exact version & size, e.g., `GE-Proton9-25, 465 MB`) or **Locate existing Proton folder**.
2. **Verified Download:**
   - Queries GitHub Releases API for `GloriousEggroll/proton-ge-custom`.
   - Enqueues the `.tar.gz` archive into the **same Download Manager** (full speed waveform + progress!) alongside its `.sha512sum` file.
   - Verifies SHA-512 checksum, extracts into `~/.local/share/opensync-launcher/proton/<tag>/`, and automatically resumes launching the game.
3. **Clean Execution via `umu-launcher` (Optional / Recommended):**
   - Each Windows game gets an isolated Wine/Proton prefix at `~/.local/share/opensync-launcher/prefixes/<game_id>/` (`STEAM_COMPAT_DATA_PATH`).
   - Uses `umu-run` (bundled or auto-downloaded) when available to run Proton inside the Steam Linux Runtime (Sniper) container without requiring the Steam client to be running, falling back to direct `proton run <exe>` when `umu-run` is absent.

---

## 7. Automatic Per-Session Differential Save Sync

OpenSync already implements a rock-solid server-side differential overlay (`/storage/users/{uid}/games/{gid}/overlay/`) with clean-manifest comparison and SHA-256 verification. The launcher makes this completely invisible and automatic.

### Session Sync Lifecycle
```text
[User clicks Play]
       │
       ▼
1. Pre-launch check (GET /api/games/:id + overlay info)
   ├─ Server overlay newer than local synced_at?
   │    ├─ Local dirty? → Show Conflict Sheet (Keep local / Use server / Inspect files)
   │    └─ Local clean? → Download changed overlay files + apply deletions
   └─ Already up to date (or server offline → launch offline seamlessly)
       │
       ▼
2. Launch game process (native or Proton prefix) + start session timer
       │
       ▼
3. Monitor entire process tree until full exit (including Proton/wineserver children)
       │
       ▼
4. Post-exit auto-sync (background task, non-blocking UI)
   ├─ Fast scan: compare local game folder (+ mapped Proton prefix save dirs) against
   │  cached mtime+size index, then parallel SHA-256 hash changed/new files
   ├─ Diff against clean manifest.json (never chained — matches server architecture)
   ├─ Mass-deletion safety check (>50% missing → pause and ask user before syncing)
   ├─ Upload changed/new files via chunked POST /api/games/:id/overlay/files (x-hash)
   ├─ Finalize via POST /api/games/:id/sync/complete
   └─ Update local synced_at timestamp; if server unreachable, persist to Offline Sync Queue
```

### Windows / Proton Save Location Awareness
Many older/indie Windows games write saves inside the game directory (captured automatically by the game-folder diff), while others write to the Wine prefix (`drive_c/users/steamuser/AppData/...` or `Documents/My Games/...`).
- The launcher supports an optional per-game **Extra Save Paths** mapping (stored locally, and optionally synced as a small `.opensync-saves.json` metadata file inside the overlay) that mirrors specified prefix save paths into a virtual `_opensync_prefix_saves/` subtree during diffing and restores them on download/pre-launch!

### Offline Resilience
- If the LAN server is unreachable when exiting a game, the launcher computes the diff summary, saves a pending sync entry in SQLite, displays a quiet `Pending sync` indicator on the game, and flushes the upload automatically as soon as `/api/health` responds again.

---

## 8. Screen Time Tracking

### Accurate Session Measurement
- **Process Tree Tracking:**
  - On Linux, launch each game inside a dedicated process group / transient systemd user scope (or `prctl(PR_SET_CHILD_SUBREAPER)`) so launchers, splash wrappers, and Proton child processes are tracked until the **actual game** terminates.
- **Suspend / Sleep Protection:**
  - Compare monotonic clock delta against wall-clock delta on a lightweight 5-second heartbeat. If a jump > 15 seconds occurs (laptop lid closed / system suspended), exclude the suspended gap from recorded playtime so screen time is never inflated.
- **Local Ledger (`play_sessions` table):**
  - `id`, `game_id`, `instance_id`, `started_at`, `ended_at`, `duration_secs`, `runtime` (`native` / `GE-Proton9-25`), `synced_to_server`.
- **UI Presentation:**
  - Total playtime (`14h 20m` or `45m`) and `Last played` shown quietly alongside install size on the Game Stage.
  - Compact **Activity** summary in the user profile panel (playtime this week, most-played titles, total sessions) without gamified badges or clutter.

---

## 9. OpenSync Server Compatibility & Recommended v1.1 Extensions

### Works Out of the Box (Current OpenSync v1.0)
| Launcher Capability | Existing OpenSync Endpoint |
|---|---|
| Server probe & status | `GET /api/health`, `GET /api/info` |
| Sign in / register / session check | `POST /api/auth/login`, `POST /api/auth/register`, `GET /api/auth/me` |
| Library catalog & overlay flags | `GET /api/games`, `GET /api/games/:id`, `GET /api/games/:id/cover` |
| Manifest & SHA-256 verification | `GET /api/games/:id/manifest` |
| Full game download (synced or clean) | `GET /api/games/:id/download` (`?fresh=1`) |
| Differential save sync upload | `GET /api/games/:id/overlay/init`, `POST /api/games/:id/overlay/files`, `POST /api/games/:id/sync/complete`, `DELETE /api/games/:id/overlay` |

### Optional Server v1.1 Enhancements (Backwards-Compatible)
1. **Per-File Resumable Download (`GET /api/games/:id/file?path=...&overlay=1`):** Enables HTTP `Range` pause/resume, multi-stream downloads, and delta updates without re-downloading unchanged files.
2. **Device API Tokens (`POST /api/auth/tokens`):** Long-lived revocable per-machine bearer tokens (`Authorization: Bearer ...`) so launcher sessions are managed cleanly per device in the web Profile page.
3. **Playtime Sync (`POST /api/games/:id/sessions`, `GET /api/auth/me/playtime`):** Aggregates screen time across multiple machines connected to the same OpenSync account.
4. **Overlay Manifest Endpoint (`GET /api/games/:id/overlay/manifest`):** Lets the launcher pull *only* changed save files before launching instead of downloading the full archive when a game is already installed locally.

---

## 10. Phased Implementation Roadmap

- **Milestone 1 — Core Shell & Instance Connection**
  - Cargo workspace, GPUI window + theme tokens (`Obsidian Slate`, `Graphite Deck`, `Phosphor Jade`), keyring auth, `GET /api/games` shelf & Game Stage with cover caching.
- **Milestone 2 — Streaming Download Manager**
  - Streaming zip unpacker + inline SHA-256 verification, queue controls, disk-space preflight, live GPUI throughput waveform & rail progress ring.
- **Milestone 3 — Native Launch & Screen Time**
  - Executable auto-discovery, process-tree tracking with suspend guard, SQLite `play_sessions` ledger, playtime display.
- **Milestone 4 — Proton Auto-Detection & Installer**
  - Steam/GE-Proton scanner, isolated prefix creation, one-click GE-Proton download + SHA-512 verification via Download Manager, optional `umu-run` integration.
- **Milestone 5 — Automatic Save Sync & Offline Queue**
  - Pre-launch overlay check, post-exit parallel SHA-256 diff & chunked overlay upload, conflict resolution sheet, offline retry queue, and optional v1.1 server endpoints (`overlay/manifest`, `file` range downloads, playtime sync).
