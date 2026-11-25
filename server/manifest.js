import { readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clearInFlightHashes } from './chunked.js';
import { GAME_STATUS, USERS_ROOT } from './config.js';
import { getDb } from './db.js';
import { hashFiles } from './hash-worker.js';
import { gameDir, gameFilesDir, gameManifestPath, gameUploadsDir, safeRelPath } from './storage.js';

const STAT_CONCURRENCY = 32;
const MAX_UPLOADED_HASH_CACHE = 50000;

/** In-memory hashing progress per game (reset on server restart). */
const manifestProgress = new Map();
/** Games with a manifest build already in flight (prevents double hashing). */
const processingGames = new Set();
/** Uploaded-file hash cache: resolved absPath -> { size, mtimeMs, hash }. */
const uploadedHashCache = new Map();
/** Parsed clean manifest cache: manifestPath -> { mtimeMs, size, ino, manifest }. */
const manifestCache = new Map();

export function recordUploadedFileHash(absPath, entry) {
  const key = path.resolve(absPath);
  if (uploadedHashCache.size >= MAX_UPLOADED_HASH_CACHE && !uploadedHashCache.has(key)) {
    uploadedHashCache.delete(uploadedHashCache.keys().next().value);
  }
  uploadedHashCache.set(key, entry);
}

export function deleteUploadedFileHash(absPath) {
  uploadedHashCache.delete(path.resolve(absPath));
}

function clearUploadedHashesForPrefix(dirPath) {
  const prefix = path.resolve(dirPath) + path.sep;
  for (const key of uploadedHashCache.keys()) {
    if (key.startsWith(prefix)) uploadedHashCache.delete(key);
  }
}

export function getManifestProgress(gameId) {
  return manifestProgress.get(Number(gameId)) || null;
}

/**
 * Build a manifest from the live files directory of a game.
 * Result: { game_id, files: [{ path, hash, size }] } with POSIX paths,
 * files listed in deterministic (sorted) order.
 */
export async function generateManifest(gameId) {
  const id = Number(gameId);
  const filesDir = gameFilesDir(id);
  const files = [];
  const absPaths = [];

  manifestProgress.set(id, { total: null, done: 0 });

  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, path.posix.join(prefix, entry.name));
      } else if (entry.isFile()) {
        const rel = safeRelPath(path.posix.join(prefix, entry.name));
        if (!rel) continue;
        files.push({ path: rel, hash: '', size: 0 });
        absPaths.push(path.resolve(abs));
      }
    }
  }

  await walk(filesDir, '');
  manifestProgress.set(id, { total: files.length, done: 0 });

  const mtimes = new Array(files.length);
  const statWorkers = Math.min(STAT_CONCURRENCY, files.length);
  let nextStat = 0;
  async function statWorker() {
    while (nextStat < files.length) {
      const i = nextStat++;
      const st = await stat(absPaths[i]);
      files[i].size = st.size;
      mtimes[i] = st.mtimeMs;
    }
  }
  if (statWorkers > 0) {
    await Promise.all(Array.from({ length: statWorkers }, () => statWorker()));
  }

  const misses = [];
  let completed = 0;
  for (let i = 0; i < files.length; i += 1) {
    const cached = uploadedHashCache.get(absPaths[i]);
    if (cached && cached.size === files[i].size && cached.mtimeMs === mtimes[i]) {
      files[i].hash = cached.hash;
      completed += 1;
    } else {
      misses.push(i);
    }
  }

  if (completed > 0) {
    manifestProgress.set(id, { total: files.length, done: completed });
  }

  if (misses.length > 0) {
    await hashFiles(
      misses.map((idx) => absPaths[idx]),
      (missIdx, res) => {
        const fileIdx = misses[missIdx];
        files[fileIdx].hash = res.hash;
        recordUploadedFileHash(absPaths[fileIdx], {
          size: files[fileIdx].size,
          mtimeMs: mtimes[fileIdx],
          hash: res.hash,
        });
        completed += 1;
        manifestProgress.set(id, { total: files.length, done: completed });
      },
    );
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const manifest = { game_id: id, files };
  const manifestPath = gameManifestPath(id);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const mStat = await stat(manifestPath);
  manifestCache.set(manifestPath, { mtimeMs: mStat.mtimeMs, size: mStat.size, ino: mStat.ino, manifest });
  manifestProgress.delete(id);
  return { manifest, totalSize };
}

/**
 * Cleanup stale upload part files + empty uploads dir. Call before generating manifest.
 */
export async function purgeUploads(gameId) {
  const dir = gameUploadsDir(gameId);
  clearInFlightHashes(dir);
  await rm(dir, { recursive: true, force: true });
}

export async function processGame(gameId, { announce = () => {} } = {}) {
  const id = Number(gameId);
  if (processingGames.has(id)) return;
  processingGames.add(id);
  try {
    const database = getDb();
    const game = database.prepare('SELECT id FROM games WHERE id = ?').get(id);
    if (!game) throw new Error('game not found');
    announce({ status: GAME_STATUS.PROCESSING });

    const { manifest, totalSize } = await generateManifest(id);
    await purgeUploads(id);

    database
      .prepare(`UPDATE games SET status = ?, total_size = ? WHERE id = ?`)
      .run(GAME_STATUS.READY, totalSize, id);

    announce({ status: GAME_STATUS.READY, total_size: totalSize });
    return manifest;
  } finally {
    processingGames.delete(id);
  }
}

/**
 * Delete a game entirely (files, manifest, cover, uploads).
 */
export async function deleteGame(gameId) {
  clearInFlightHashes(gameUploadsDir(gameId));
  clearUploadedHashesForPrefix(gameFilesDir(gameId));
  manifestCache.delete(gameManifestPath(gameId));
  await rm(gameDir(gameId), { recursive: true, force: true });
  getDb().prepare('DELETE FROM games WHERE id = ?').run(gameId);
  try {
    const userDirs = await readdir(USERS_ROOT, { withFileTypes: true });
    for (const entry of userDirs) {
      if (!/^\d+$/.test(entry.name) || !entry.isDirectory()) continue;
      await rm(path.join(USERS_ROOT, entry.name, 'games', String(gameId)), { recursive: true, force: true }).catch((err) =>
        console.error(`[opensync] failed to remove overlay dir for game ${gameId}, user ${entry.name}:`, err),
      );
    }
  } catch {
    // USERS_ROOT missing or unreadable — nothing to clean
  }
}

export async function ensureGameDirs(gameId) {
  await mkdir(gameFilesDir(gameId), { recursive: true });
  await mkdir(gameUploadsDir(gameId), { recursive: true });
}

export function loadManifest(gameId) {
  const p = gameManifestPath(gameId);
  try {
    const st = statSync(p);
    const cached = manifestCache.get(p);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.ino === st.ino) {
      return cached.manifest;
    }
    const manifest = JSON.parse(readFileSync(p, 'utf8'));
    manifestCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, manifest });
    return manifest;
  } catch {
    manifestCache.delete(p);
    return null;
  }
}
