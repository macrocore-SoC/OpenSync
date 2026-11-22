import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const WORKSPACE_CRATES = [
  'launcher-core',
  'launcher-db',
  'launcher-tauri',
  'opensync-api',
  'opensync-proton',
  'opensync-runner',
  'opensync-sync',
  'opensync-transfer',
];

function relPath(rel) {
  return path.join(ROOT, rel);
}

function readRel(rel) {
  return readFileSync(relPath(rel), 'utf8');
}

function writeRel(rel, content) {
  writeFileSync(relPath(rel), content, 'utf8');
}

export function parseSemver(raw) {
  const m = SEMVER_RE.exec(String(raw || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || '',
    raw: m[0],
  };
}

export function computeNextVersion(currentRaw, targetArg) {
  const explicit = parseSemver(targetArg);
  if (explicit) return explicit.raw;

  const cur = parseSemver(currentRaw);
  if (!cur) throw new Error(`Invalid current VERSION: "${currentRaw}"`);

  if (targetArg === 'major') return `${cur.major + 1}.0.0`;
  if (targetArg === 'minor') return `${cur.major}.${cur.minor + 1}.0`;
  if (targetArg === 'patch') return `${cur.major}.${cur.minor}.${cur.patch + 1}`;
  throw new Error(`Invalid bump target "${targetArg}". Use major, minor, patch, or X.Y.Z[-pre].`);
}

function extractWorkspaceCargoVersion(cargoToml) {
  const wsSection = /\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/.exec(cargoToml);
  if (!wsSection) return null;
  const verMatch = /^\s*version\s*=\s*"([^"]+)"/m.exec(wsSection[1]);
  return verMatch ? verMatch[1] : null;
}

function replaceWorkspaceCargoVersion(cargoToml, nextVer) {
  const wsSection = /(\[workspace\.package\][\s\S]*?)(?=\n\[|$)/.exec(cargoToml);
  if (!wsSection) throw new Error('Missing [workspace.package] in launcher/Cargo.toml');
  const updatedSection = wsSection[1].replace(
    /^(\s*version\s*=\s*")([^"]+)(")/m,
    `$1${nextVer}$3`,
  );
  if (updatedSection === wsSection[1] && !wsSection[1].includes(`"${nextVer}"`)) {
    throw new Error('Could not find workspace.package.version in launcher/Cargo.toml');
  }
  return cargoToml.slice(0, wsSection.index) + updatedSection + cargoToml.slice(wsSection.index + wsSection[0].length);
}

function extractCargoLockCrateVersion(cargoLock, crateName) {
  const re = new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${crateName}"\\r?\\nversion = "([^"]+)"`);
  const m = re.exec(cargoLock);
  return m ? m[1] : null;
}

function replaceCargoLockCrateVersions(cargoLock, nextVer) {
  let out = cargoLock;
  for (const crateName of WORKSPACE_CRATES) {
    const re = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crateName}"\\r?\\nversion = ")([^"]+)(")`);
    if (!re.test(out)) {
      throw new Error(`Missing crate stanza "${crateName}" in launcher/Cargo.lock`);
    }
    out = out.replace(re, `$1${nextVer}$3`);
  }
  return out;
}

function extractTopMetainfoVersion(xml) {
  const releasesMatch = /<releases>([\s\S]*?)<\/releases>/.exec(xml);
  if (!releasesMatch) return null;
  const relMatch = /<release\s+version="([^"]+)"/.exec(releasesMatch[1]);
  return relMatch ? relMatch[1] : null;
}

function upsertMetainfoRelease(xml, nextVer, dateStr) {
  if (new RegExp(`<release\\s+version="${nextVer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(xml)) {
    // Move or keep existing top entry; ensure date matches if already first.
    return xml;
  }
  return xml.replace(
    /(<releases>\r?\n)/,
    `$1    <release version="${nextVer}" date="${dateStr}" />\n`,
  );
}

export function collectVersionMismatches() {
  const mismatches = [];
  const rootRaw = readRel('VERSION').trim();
  const parsed = parseSemver(rootRaw);
  if (!parsed) {
    mismatches.push(`VERSION: invalid SemVer "${rootRaw}"`);
    return { version: rootRaw, mismatches };
  }

  const launcherVer = readRel('launcher/VERSION').trim();
  if (launcherVer !== rootRaw) {
    mismatches.push(`launcher/VERSION: expected "${rootRaw}", got "${launcherVer}"`);
  }

  const pkg = JSON.parse(readRel('package.json'));
  if (pkg.version !== rootRaw) {
    mismatches.push(`package.json: expected "${rootRaw}", got "${pkg.version}"`);
  }

  const lock = JSON.parse(readRel('package-lock.json'));
  if (lock.version !== rootRaw) {
    mismatches.push(`package-lock.json (.version): expected "${rootRaw}", got "${lock.version}"`);
  }
  if (lock.packages?.['']?.version !== rootRaw) {
    mismatches.push(`package-lock.json (.packages[""].version): expected "${rootRaw}", got "${lock.packages?.['']?.version}"`);
  }

  const cargoToml = readRel('launcher/Cargo.toml');
  const cargoVer = extractWorkspaceCargoVersion(cargoToml);
  if (cargoVer !== rootRaw) {
    mismatches.push(`launcher/Cargo.toml ([workspace.package].version): expected "${rootRaw}", got "${cargoVer}"`);
  }

  const cargoLock = readRel('launcher/Cargo.lock');
  for (const crateName of WORKSPACE_CRATES) {
    const cv = extractCargoLockCrateVersion(cargoLock, crateName);
    if (cv !== rootRaw) {
      mismatches.push(`launcher/Cargo.lock (${crateName}): expected "${rootRaw}", got "${cv}"`);
    }
  }

  const tauriConf = JSON.parse(readRel('launcher/crates/launcher-tauri/tauri.conf.json'));
  if (tauriConf.version !== rootRaw) {
    mismatches.push(`launcher/crates/launcher-tauri/tauri.conf.json: expected "${rootRaw}", got "${tauriConf.version}"`);
  }
  if (tauriConf.bundle?.macOS?.bundleVersion && tauriConf.bundle.macOS.bundleVersion !== rootRaw) {
    mismatches.push(`launcher/crates/launcher-tauri/tauri.conf.json (bundle.macOS.bundleVersion): expected "${rootRaw}", got "${tauriConf.bundle.macOS.bundleVersion}"`);
  }

  const metainfo = readRel('launcher/packaging/flatpak/io.opensync.launcher.metainfo.xml');
  const topReleaseVer = extractTopMetainfoVersion(metainfo);
  if (topReleaseVer !== rootRaw) {
    mismatches.push(`launcher/packaging/flatpak/io.opensync.launcher.metainfo.xml: top release expected "${rootRaw}", got "${topReleaseVer}"`);
  }

  const landingHtml = readRel('landing/index.html');
  const expectedHtmlChecks = [
    ['landing/index.html (css cachebuster)', `css/landing.css?v=${rootRaw}`],
    ['landing/index.html (js cachebuster)', `js/landing.js?v=${rootRaw}`],
    ['landing/index.html (#announce-tag)', `id="announce-tag">v${rootRaw}<`],
    ['landing/index.html (#hero-download-label)', `id="hero-download-label">Download v${rootRaw}<`],
    ['landing/index.html (#launcher-release-pill)', `id="launcher-release-pill">Desktop Launcher · v${rootRaw}<`],
    ['landing/index.html (#footer-releases-label)', `id="footer-releases-label">v${rootRaw} releases<`],
    ['landing/index.html (flatpak asset URL)', `/releases/download/v${rootRaw}/OpenSync_Launcher_${rootRaw}_amd64.flatpak`],
    ['landing/index.html (appimage asset URL)', `/releases/download/v${rootRaw}/OpenSync_Launcher_${rootRaw}_amd64.AppImage`],
    ['landing/index.html (windows asset URL)', `/releases/download/v${rootRaw}/OpenSync_Launcher_${rootRaw}_x64.exe`],
  ];
  for (const [label, needle] of expectedHtmlChecks) {
    if (!landingHtml.includes(needle)) {
      mismatches.push(`${label}: missing "${needle}"`);
    }
  }

  const landingJs = readRel('landing/js/landing.js');
  const expectedJsChecks = [
    ['landing/js/landing.js (activeReleaseTag)', `const DEFAULT_RELEASE_TAG = 'v${rootRaw}';`],
    ['landing/js/landing.js (flatpak URL)', `/releases/download/v${rootRaw}/OpenSync_Launcher_${rootRaw}_amd64.flatpak`],
    ['landing/js/landing.js (appimage URL)', `/releases/download/v${rootRaw}/OpenSync_Launcher_${rootRaw}_amd64.AppImage`],
    ['landing/js/landing.js (windows URL)', `/releases/download/v${rootRaw}/OpenSync_Launcher_${rootRaw}_x64.exe`],
  ];
  for (const [label, needle] of expectedJsChecks) {
    if (!landingJs.includes(needle)) {
      mismatches.push(`${label}: missing "${needle}"`);
    }
  }

  return { version: rootRaw, mismatches };
}

function updateLandingFiles(nextVer) {
  let html = readRel('landing/index.html');
  html = html
    .replace(/(href="css\/landing\.css\?v=)[^"]+(")/g, `$1${nextVer}$2`)
    .replace(/(src="js\/landing\.js\?v=)[^"]+(")/g, `$1${nextVer}$2`)
    .replace(/(id="announce-tag">)v[^<]+(<)/g, `$1v${nextVer}$2`)
    .replace(/(id="hero-download-label">)Download v[^<]+(<)/g, `$1Download v${nextVer}$2`)
    .replace(/(id="launcher-release-pill">)Desktop Launcher · v[^<]+(<)/g, `$1Desktop Launcher · v${nextVer}$2`)
    .replace(/(id="footer-releases-label">)v[^< ]+ releases(<)/g, `$1v${nextVer} releases$2`)
    .replace(/(\/releases\/download\/)v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(\/OpenSync_Launcher_)[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(_)/g, `$1v${nextVer}$2${nextVer}$3`);
  writeRel('landing/index.html', html);

  let js = readRel('landing/js/landing.js');
  js = js
    .replace(/(const DEFAULT_RELEASE_TAG = ')v[^']+(';)/g, `$1v${nextVer}$2`)
    .replace(/(\/releases\/download\/)v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(\/OpenSync_Launcher_)[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(_)/g, `$1v${nextVer}$2${nextVer}$3`);
  writeRel('landing/js/landing.js', js);
}

export function bumpAllVersions(targetArg, dateStr = new Date().toISOString().slice(0, 10)) {
  const current = readRel('VERSION').trim();
  const nextVer = computeNextVersion(current, targetArg);

  writeRel('VERSION', `${nextVer}\n`);
  writeRel('launcher/VERSION', `${nextVer}\n`);

  const pkg = JSON.parse(readRel('package.json'));
  pkg.version = nextVer;
  writeRel('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  const lock = JSON.parse(readRel('package-lock.json'));
  lock.version = nextVer;
  if (lock.packages?.['']) {
    lock.packages[''].version = nextVer;
  }
  writeRel('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);

  writeRel('launcher/Cargo.toml', replaceWorkspaceCargoVersion(readRel('launcher/Cargo.toml'), nextVer));
  writeRel('launcher/Cargo.lock', replaceCargoLockCrateVersions(readRel('launcher/Cargo.lock'), nextVer));

  const tauriConf = JSON.parse(readRel('launcher/crates/launcher-tauri/tauri.conf.json'));
  tauriConf.version = nextVer;
  if (tauriConf.bundle?.macOS?.bundleVersion !== undefined) {
    tauriConf.bundle.macOS.bundleVersion = nextVer;
  }
  writeRel('launcher/crates/launcher-tauri/tauri.conf.json', `${JSON.stringify(tauriConf, null, 2)}\n`);

  const metainfo = readRel('launcher/packaging/flatpak/io.opensync.launcher.metainfo.xml');
  writeRel('launcher/packaging/flatpak/io.opensync.launcher.metainfo.xml', upsertMetainfoRelease(metainfo, nextVer, dateStr));

  updateLandingFiles(nextVer);
  return nextVer;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd = 'check', arg, ...rest] = process.argv.slice(2);
  if (cmd === 'check') {
    const { version, mismatches } = collectVersionMismatches();
    if (mismatches.length > 0) {
      console.error(`version check failed (canonical VERSION=${version}):`);
      for (const m of mismatches) console.error(`  - ${m}`);
      process.exit(1);
    }
    console.log(`version ok: ${version}`);
  } else if (cmd === 'bump') {
    if (!arg) {
      console.error('usage: node scripts/version.js bump <major|minor|patch|X.Y.Z> [--date YYYY-MM-DD]');
      process.exit(2);
    }
    let dateStr = new Date().toISOString().slice(0, 10);
    const dateIdx = rest.indexOf('--date');
    if (dateIdx !== -1 && rest[dateIdx + 1]) {
      dateStr = rest[dateIdx + 1];
    }
    const nextVer = bumpAllVersions(arg, dateStr);
    const { mismatches } = collectVersionMismatches();
    if (mismatches.length > 0) {
      console.error(`version bump to ${nextVer} left mismatches:`);
      for (const m of mismatches) console.error(`  - ${m}`);
      process.exit(1);
    }
    console.log(`bumped all OpenSync manifests to ${nextVer}`);
  } else {
    console.error(`unknown subcommand "${cmd}" (expected check | bump)`);
    process.exit(2);
  }
}
