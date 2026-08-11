import { Router } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { getDb, now } from '../db.js';
import { loadManifest } from '../manifest.js';
import { effectiveFiles } from '../overlay.js';
import { gameFilesDir, overlayDir, safeRelPath } from '../storage.js';
import { requireAuth } from '../security.js';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ZipArchive } = require('archiver');

export const downloadRouter = Router();

downloadRouter.use(requireAuth);

downloadRouter.get('/:id/manifest', (req, res) => {
  const game = getDb().prepare('SELECT status FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'game not found' });
  if (game.status !== 'ready') return res.status(409).json({ error: 'game is being processed' });
  const manifest = loadManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'manifest not found' });
  res.json(manifest);
});

// Per-file download with Range resume. Resolves overlay-first: a file in the
// user's overlay shadows the clean copy, so the launcher can pull overlay
// changes through this same endpoint. Does NOT record a `downloads` row
// (the zip endpoint keeps download_count semantics).
downloadRouter.get('/:id/files/*path', async (req, res, next) => {
  try {
    const gameId = Number(req.params.id);
    const game = getDb().prepare('SELECT status FROM games WHERE id = ?').get(gameId);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (game.status !== 'ready') return res.status(409).json({ error: 'game is being processed' });

    let relPath;
    try {
      const segments = req.params.path;
      const raw = Array.isArray(segments) ? segments.join('/') : String(segments);
      relPath = safeRelPath(decodeURIComponent(raw));
    } catch {
      relPath = null;
    }
    if (!relPath) return res.status(400).json({ error: 'invalid file path' });

    let abs = path.join(gameFilesDir(gameId), relPath);
    const overlay = path.join(overlayDir(req.user.id, gameId), relPath);
    if (existsSync(overlay)) abs = overlay;

    let size;
    try {
      size = (await stat(abs)).size;
    } catch {
      return res.status(404).json({ error: 'file not found' });
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start;
      let end;
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          const n = Number(m[2]);
          if (Number.isSafeInteger(n) && n > 0) {
            start = Math.max(0, size - n);
            end = size - 1;
          }
        } else {
          start = Number(m[1]);
          end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
        }
        if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) {
          return res.status(416).json({ error: 'range not satisfiable' });
        }
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        res.status(206);
        return createReadStream(abs, { start, end }).pipe(res);
      }
    }

    res.setHeader('Content-Length', size);
    if (req.method === 'HEAD') return res.end();
    createReadStream(abs).pipe(res);
  } catch (err) {
    next(err);
  }
});

downloadRouter.get('/:id/download', async (req, res, next) => {
  try {
    const gameId = Number(req.params.id);
    const manifest = loadManifest(gameId);
    if (!manifest) return res.status(404).json({ error: 'game not found or not ready' });
    const game = getDb().prepare('SELECT name, status FROM games WHERE id = ?').get(gameId);
    if (!game) return res.status(404).json({ error: 'game not found' });
    if (game.status !== 'ready') return res.status(409).json({ error: 'game is being processed' });

    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    const { files } = fresh
      ? { files: (manifest.files || []).map((f) => ({ path: f.path, source: 'clean', size: f.size, hash: f.hash })) }
      : await effectiveFiles(req.user.id, gameId);
    if (files.length === 0) return res.status(404).json({ error: 'game has no files' });

    const deflate = Number(req.query.deflate);
    const level = Number.isInteger(deflate) && deflate >= 1 && deflate <= 9 ? deflate : 0;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slugFor(game.name)}.zip"`);
    res.flushHeaders();

    const archive = new ZipArchive({ zlib: { level } });
    archive.on('error', (err) => {
      console.error(`[opensync] zip error game=${gameId}:`, err.message);
      res.destroy(err);
    });

    for (const f of files) {
      const abs =
        f.source === 'overlay'
          ? path.join(overlayDir(req.user.id, gameId), f.path)
          : path.join(gameFilesDir(gameId), f.path);
      archive.file(abs, { name: f.path });
    }

    getDb()
      .prepare('INSERT INTO downloads (user_id, game_id, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, gameId, now());

    archive.pipe(res);
    archive.finalize();
  } catch (err) {
    next(err);
  }
});

function slugFor(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'game';
}
