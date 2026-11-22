# OpenSync — Versioning & Release Specification

This specification defines the authoritative versioning rules, synchronized version targets, automated verification, and release workflow for the OpenSync monorepo (`OpenSync` server/WebUI/landing + `launcher/` desktop app and its standalone mirror `OpenSync-Launcher`).

---

## 1. Versioning Scheme

OpenSync uses strict **Lockstep Semantic Versioning 2.0.0** (`MAJOR.MINOR.PATCH[-PRERELEASE]`, Git tag `vMAJOR.MINOR.PATCH[-PRERELEASE]`):

- **Lockstep**: Server/WebUI (`OpenSync`), Desktop Launcher (`OpenSync-Launcher`), Docker container tags, Flatpak/AppImage/Windows packages, and landing-page fallbacks share the exact same version number on every release.
- **Valid grammar**:
  `^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`

### Pre-`1.0.0` & General Bump Rules

| Component | When to bump | Examples |
| --- | --- | --- |
| `MAJOR` | Backwards-incompatible archive format, API contract, or database schema changes; graduating to `1.0.0` stability | `0.x.y` -> `1.0.0` |
| `MINOR` | New user-facing features, WebUI/launcher views, new API capabilities, or non-breaking feature milestones | `0.2.0` -> `0.3.0` |
| `PATCH` | Bug fixes, performance improvements, styling fixes, packaging/CI fixes with no new feature surface | `0.3.0` -> `0.3.1` |
| `PRERELEASE` | Optional release candidates (`0.3.0-rc.1`). Marked pre-release on GitHub and never tagged `:latest` | `v0.3.0-rc.1` |

---

## 2. Single Source of Truth & Synchronized Targets

The canonical version string lives in **`/VERSION`** (single line + trailing newline) and is mirrored identically in **`/launcher/VERSION`** for standalone `OpenSync-Launcher` subtree checkouts.

Every file below **must** stay synchronized with `/VERSION`:

| Target file | Field / Location | Role |
| --- | --- | --- |
| `VERSION` | Entire file (`X.Y.Z`) | Canonical monorepo version |
| `launcher/VERSION` | Entire file (`X.Y.Z`) | Subtree mirror for `OpenSync-Launcher` |
| `package.json` | `.version` | Node server & CLI package version; exposed at runtime via `GET /api/health` and `GET /api/info` |
| `package-lock.json` | `.version`, `.packages[""].version` | npm lockfile metadata parity |
| `launcher/Cargo.toml` | `[workspace.package].version` | Shared Rust version inherited by all 8 crates via `version.workspace = true` |
| `launcher/Cargo.lock` | `[[package]].version` for all 8 local workspace crates | Cargo workspace lockfile parity |
| `launcher/crates/launcher-tauri/tauri.conf.json` | `.version` | Tauri bundle & installer metadata |
| `launcher/packaging/flatpak/io.opensync.launcher.metainfo.xml` | First `<release version="X.Y.Z" date="YYYY-MM-DD" />` | AppStream / Flatpak release metadata |
| `landing/index.html` | `?v=X.Y.Z` asset queries, `#announce-tag`, `#hero-download-label`, `#launcher-release-pill`, `#footer-releases-label`, fallback asset links & Flatpak command | Instant CDN cache-busting & offline/rate-limit fallback links |
| `landing/js/landing.js` | `activeReleaseTag` (`'vX.Y.Z'`) & `PLAYER_TARGETS` fallback download URLs | Runtime fallback URLs before GitHub API resolves |

### Rust Workspace Crates Covered by `[workspace.package].version`

`launcher-db`, `opensync-api`, `opensync-transfer`, `opensync-sync`, `opensync-proton`, `opensync-runner`, `launcher-core`, `launcher-tauri`.

---

## 3. Tooling & Automated Guards

All version operations are handled by `scripts/version.js` (exposed via npm scripts):

- **Verify lockstep consistency**:
  ```bash
  npm run version:check
  ```
  Exits non-zero with a per-file diff report if any target listed in Section 2 drifts from `/VERSION` or does not follow valid SemVer syntax.

- **Bump version across all targets**:
  ```bash
  npm run version:bump -- <patch | minor | major | X.Y.Z> [--date YYYY-MM-DD]
  ```
  Computes (or validates) the target version, updates all files in Section 2 atomically, inserts a new top `<release version="..." date="..." />` entry into `io.opensync.launcher.metainfo.xml`, and runs `check` before exiting.

### Continuous Integration & Test Enforcement

1. `tests/version-guard.test.js` runs `checkVersions()` on every `npm test` execution (both locally and in `.github/workflows/docker.yml`).
2. `server/index.js` reads `package.json` at startup so `GET /api/health` always returns `{ ok: true, name: 'opensync', version }` with no hardcoded string.
3. On `refs/tags/v*`, `.github/workflows/launcher.yml` and `launcher/.github/workflows/build.yml` verify that the pushed Git tag version (`vX.Y.Z` stripped to `X.Y.Z`) matches `launcher/VERSION`, `[workspace.package].version`, and `tauri.conf.json` before packaging artifacts.

---

## 4. Artifact Naming & Tag Contract

Every tagged release `vX.Y.Z` produces the following immutable artifacts:

- **Launcher Linux AppImage (amd64)**: `OpenSync_Launcher_${VERSION}_amd64.AppImage` + `.sha256`
- **Launcher Linux Flatpak (amd64)**: `OpenSync_Launcher_${VERSION}_amd64.flatpak` + `.sha256`
- **Launcher Windows Installer/Executable (x64)**: `OpenSync_Launcher_${VERSION}_x64.exe` + `.sha256`
- **Server Docker Image (`linux/amd64`)**: `ghcr.io/piskevalee-cpu/opensync:${VERSION}` and (for non-prerelease tags) `ghcr.io/piskevalee-cpu/opensync:latest`

---

## 5. Release Runbook

1. Bump all manifests on clean `main`:
   ```bash
   npm run version:bump -- minor   # or patch / major / X.Y.Z
   ```
2. Verify all suites cleanly:
   ```bash
   npm run lint
   HOST=0.0.0.0 npm test
   (cd launcher && cargo check -p launcher-tauri && RUSTFLAGS="-D warnings" cargo test --workspace --exclude launcher-tauri)
   ```
3. Commit the release prep (`release(vX.Y.Z): ...`) and push `OpenSync` `main`.
4. Split and push the `launcher/` subtree to `OpenSync-Launcher` `main`:
   ```bash
   LAUNCHER_SHA=$(git subtree split --prefix=launcher HEAD)
   git push https://github.com/piskevalee-cpu/OpenSync-Launcher.git "$LAUNCHER_SHA:refs/heads/main"
   ```
5. Create and push annotated tags `vX.Y.Z` on **both** `origin` (`HEAD`) and `OpenSync-Launcher` (`$LAUNCHER_SHA`):
   ```bash
   git tag -a "vX.Y.Z" -m "Release vX.Y.Z" HEAD
   git push origin "vX.Y.Z"
   git push https://github.com/piskevalee-cpu/OpenSync-Launcher.git "$LAUNCHER_SHA:refs/tags/vX.Y.Z"
   ```
6. Wait for both GitHub Actions release workflows (`Build OpenSync Launcher` + `docker`) to publish all binaries and container tags, enrich release notes if desired, and confirm every asset + checksum is downloadable.
