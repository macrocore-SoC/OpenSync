import { Router } from 'express';
import { getDb, now } from '../db.js';
import { loadManifest } from '../manifest.js';
import { effectiveFiles } from '../overlay.js';
import { gameFilesDir, overlayDir } from '../storage.js';
import { requireAuth } from '../security.js';
import { streamZipFiles } from '../zip.js';
import path from 'node:path';

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

    req.socket?.setNoDelay(true);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slugFor(game.name)}.zip"`);
    res.flushHeaders();

    const entries = files.map((f) => ({
      path: f.path,
      absPath:
        f.source === 'overlay'
          ? path.join(overlayDir(req.user.id, gameId), f.path)
          : path.join(gameFilesDir(gameId), f.path),
    }));

    getDb()
      .prepare('INSERT INTO downloads (user_id, game_id, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, gameId, now());

    try {
      await streamZipFiles(entries, res, { level });
    } catch (err) {
      if (!res.destroyed) {
        console.error(`[opensync] zip error game=${gameId}:`, err.message);
        res.destroy(err);
      }
    }
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
