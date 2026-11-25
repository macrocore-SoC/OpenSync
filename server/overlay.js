import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clearInFlightHashes } from './chunked.js';
import { hashFile, hashFiles } from './hash-worker.js';
import { loadManifest } from './manifest.js';
import {
  deletionsPath,
  overlayDir,
  overlayFilePath,
  overlayManifestPath,
  safeRelPath,
  userGameDir,
} from './storage.js';

const STAT_CONCURRENCY = 32;
const MAX_OVERLAY_HASH_CACHE = 50000;

/** Cached parsed deletions.json: filePath -> { mtimeMs, size, ino, value } */
const deletionsCache = new Map();
/** Cached parsed overlay_manifest.json: filePath -> { mtimeMs, size, ino, value } */
const overlayManifestCache = new Map();
/** Validated overlay file hashes: resolved absPath -> { size, mtimeMs, hash } */
const overlayHashCache = new Map();

function recordOverlayFileHash(absPath, entry) {
  const key = path.resolve(absPath);
  if (overlayHashCache.size >= MAX_OVERLAY_HASH_CACHE && !overlayHashCache.has(key)) {
    overlayHashCache.delete(overlayHashCache.keys().next().value);
  }
  overlayHashCache.set(key, entry);
}

function clearOverlayHashesForPrefix(dirPath) {
  const prefix = path.resolve(dirPath) + path.sep;
  for (const key of overlayHashCache.keys()) {
    if (key.startsWith(prefix)) overlayHashCache.delete(key);
  }
}

/**
 * Fingerprint of the clean manifest: deletions recorded under this hash only
 * apply while the manifest is byte-identical (a re-upload invalidates them).
 */
function fingerprint(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) return null;
  const sortedFiles = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(JSON.stringify(sortedFiles)).digest('hex');
}

function readDeletionsEntry(userId, gameId) {
  const p = deletionsPath(userId, gameId);
  try {
    const st = statSync(p);
    const cached = deletionsCache.get(p);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.ino === st.ino) {
      return { value: cached.value, mtimeMs: st.mtimeMs };
    }
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    let value;
    if (Array.isArray(parsed)) value = { hash: null, paths: parsed };
    else if (parsed && Array.isArray(parsed.paths)) value = { hash: parsed.manifest_hash ?? null, paths: parsed.paths };
    else value = { hash: null, paths: [] };
    deletionsCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, value });
    return { value, mtimeMs: st.mtimeMs };
  } catch {
    deletionsCache.delete(p);
    return { value: { hash: null, paths: [] }, mtimeMs: null };
  }
}

export function loadDeletions(userId, gameId) {
  return readDeletionsEntry(userId, gameId).value;
}

function readOverlayManifestEntry(userId, gameId) {
  const p = overlayManifestPath(userId, gameId);
  try {
    const st = statSync(p);
    const cached = overlayManifestCache.get(p);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.ino === st.ino) {
      return { value: cached.value, mtimeMs: st.mtimeMs };
    }
    const value = JSON.parse(readFileSync(p, 'utf8'));
    overlayManifestCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, value });
    return { value, mtimeMs: st.mtimeMs };
  } catch {
    overlayManifestCache.delete(p);
    return { value: null, mtimeMs: null };
  }
}

export function loadOverlayManifest(userId, gameId) {
  return readOverlayManifestEntry(userId, gameId).value;
}

export function hasOverlay(userId, gameId) {
  const overlayManifest = loadOverlayManifest(userId, gameId);
  if (overlayManifest?.files.length) return true;
  const deletions = loadDeletions(userId, gameId);
  return deletions.paths.length > 0;
}

export async function loadOverlayInfo(userId, gameId) {
  const { value: overlayManifest, mtimeMs: omMtime } = readOverlayManifestEntry(userId, gameId);
  const { value: deletions, mtimeMs: delMtime } = readDeletionsEntry(userId, gameId);
  const has = Boolean(overlayManifest?.files.length) || deletions.paths.length > 0;

  let overlaySize = 0;
  if (overlayManifest) {
    for (let i = 0; i < overlayManifest.files.length; i += 1) {
      overlaySize += overlayManifest.files[i].size;
    }
  }

  let updatedAt = omMtime;
  if (delMtime && (!updatedAt || delMtime > updatedAt)) updatedAt = delMtime;

  return {
    has_overlay: has,
    files: overlayManifest ? overlayManifest.files.length : 0,
    deletions: deletions.paths.length,
    size: overlaySize,
    updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

export async function clearOverlay(userId, gameId) {
  deletionsCache.delete(deletionsPath(userId, gameId));
  overlayManifestCache.delete(overlayManifestPath(userId, gameId));
  const dir = overlayDir(userId, gameId);
  clearOverlayHashesForPrefix(dir);
  clearInFlightHashes(dir);
  await rm(userGameDir(userId, gameId), { recursive: true, force: true });
}

export async function saveDeletions(userId, gameId, deletions, manifest = null) {
  const clean = [...new Set(deletions)].sort();
  const manifestHash = fingerprint(manifest);
  const data = { manifest_hash: manifestHash, paths: clean };
  const p = deletionsPath(userId, gameId);
  try {
    await writeFile(p, JSON.stringify(data));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await mkdir(userGameDir(userId, gameId), { recursive: true });
    await writeFile(p, JSON.stringify(data));
  }
  const st = await stat(p);
  deletionsCache.set(p, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    ino: st.ino,
    value: { hash: manifestHash, paths: clean },
  });
}

/**
 * Re-validate an uploaded overlay file against its declared hash.
 * Throws { status: 422, mismatch } on hash mismatch (caller cleans up the file).
 */
export async function validateOverlayFile(userId, gameId, relPath, declaredHash, precomputed = null) {
  const finalPath = path.resolve(overlayFilePath(userId, gameId, relPath));
  if (precomputed) {
    if (declaredHash && precomputed.hash !== declaredHash) {
      await rm(finalPath, { force: true });
      const err = new Error('hash mismatch');
      err.status = 422;
      err.mismatch = { path: relPath, expected: declaredHash, actual: precomputed.hash };
      throw err;
    }
    recordOverlayFileHash(finalPath, {
      size: precomputed.size,
      mtimeMs: precomputed.mtimeMs,
      hash: precomputed.hash,
    });
    return { path: relPath, hash: precomputed.hash, size: precomputed.size };
  }

  const { hash: actualHash, size, mtimeMs } = await hashFile(finalPath);
  if (declaredHash && actualHash !== declaredHash) {
    await rm(finalPath, { force: true });
    const err = new Error('hash mismatch');
    err.status = 422;
    err.mismatch = { path: relPath, expected: declaredHash, actual: actualHash };
    throw err;
  }
  recordOverlayFileHash(finalPath, { size, mtimeMs, hash: actualHash });
  return { path: relPath, hash: actualHash, size };
}

/**
 * Rebuild overlay_manifest.json by reusing cached hashes for unchanged files
 * and hashing any uncached files in parallel via the worker pool.
 */
export async function rebuildOverlayManifest(userId, gameId) {
  const dir = overlayDir(userId, gameId);
  const prevManifest = loadOverlayManifest(userId, gameId);
  const prevByPath = new Map((prevManifest?.files || []).map((f) => [f.path, f]));

  const entries = [];
  const partRemovals = [];
  async function walk(relDir) {
    let dirEntries = [];
    try {
      dirEntries = await readdir(path.join(dir, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of dirEntries) {
      if (e.isDirectory()) {
        await walk(path.posix.join(relDir, e.name));
      } else if (e.isFile()) {
        if (e.name.endsWith('.part')) {
          partRemovals.push(rm(path.join(dir, relDir, e.name), { force: true }).catch(() => {}));
          continue;
        }
        const rel = safeRelPath(path.posix.join(relDir, e.name));
        if (!rel) continue;
        entries.push({ path: rel, abs: path.resolve(dir, rel) });
      }
    }
  }
  await walk('');
  if (partRemovals.length > 0) await Promise.all(partRemovals);

  const files = new Array(entries.length);
  const statWorkers = Math.min(STAT_CONCURRENCY, entries.length);
  const stats = new Array(entries.length);
  let nextStat = 0;
  async function statWorker() {
    while (nextStat < entries.length) {
      const i = nextStat++;
      stats[i] = await stat(entries[i].abs);
    }
  }
  if (statWorkers > 0) {
    await Promise.all(Array.from({ length: statWorkers }, () => statWorker()));
  }

  const misses = [];
  for (let i = 0; i < entries.length; i += 1) {
    const { path: rel, abs } = entries[i];
    const { size, mtimeMs } = stats[i];
    const cached = overlayHashCache.get(abs);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      files[i] = { path: rel, hash: cached.hash, size, mtimeMs };
      continue;
    }
    const prev = prevByPath.get(rel);
    if (prev && prev.size === size && prev.mtimeMs === mtimeMs) {
      recordOverlayFileHash(abs, { size, mtimeMs, hash: prev.hash });
      files[i] = { path: rel, hash: prev.hash, size, mtimeMs };
      continue;
    }
    misses.push(i);
  }

  if (misses.length > 0) {
    const hashed = await hashFiles(misses.map((idx) => entries[idx].abs));
    for (let m = 0; m < misses.length; m += 1) {
      const idx = misses[m];
      const { path: rel, abs } = entries[idx];
      const { size, mtimeMs } = stats[idx];
      const { hash } = hashed[m];
      recordOverlayFileHash(abs, { size, mtimeMs, hash });
      files[idx] = { path: rel, hash, size, mtimeMs };
    }
  }

  const manifest = { game_id: Number(gameId), files };
  const omPath = overlayManifestPath(userId, gameId);
  try {
    await writeFile(omPath, JSON.stringify(manifest));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await mkdir(userGameDir(userId, gameId), { recursive: true });
    await writeFile(omPath, JSON.stringify(manifest));
  }
  const omStat = await stat(omPath);
  overlayManifestCache.set(omPath, {
    mtimeMs: omStat.mtimeMs,
    size: omStat.size,
    ino: omStat.ino,
    value: manifest,
  });
  return manifest;
}

/**
 * Effective file set for a user: clean manifest + overlay - deletions.
 * Shared by the zip download path and sync validation.
 */
export async function effectiveFiles(userId, gameId) {
  const clean = loadManifest(gameId);
  const cleanFiles = clean ? clean.files : [];
  const cleanByPath = new Map(cleanFiles.map((f) => [f.path, f]));
  const dels = loadDeletions(userId, gameId);
  const deletions = dels.hash && dels.hash === fingerprint(clean) ? new Set(dels.paths) : new Set();
  const overlayManifest = loadOverlayManifest(userId, gameId);
  const overlayByPath = new Map((overlayManifest?.files || []).map((f) => [f.path, f]));

  const merged = [];
  for (const f of cleanFiles) {
    if (deletions.has(f.path)) continue;
    const overlay = overlayByPath.get(f.path);
    if (overlay) merged.push({ path: overlay.path, source: 'overlay', size: overlay.size, hash: overlay.hash });
    else merged.push({ path: f.path, source: 'clean', size: f.size, hash: f.hash });
  }
  for (const f of overlayManifest?.files || []) {
    if (!cleanByPath.has(f.path)) merged.push({ path: f.path, source: 'overlay', size: f.size, hash: f.hash });
  }
  merged.sort((a, b) => a.path.localeCompare(b.path));
  return { files: merged, deletions: [...deletions] };
}
