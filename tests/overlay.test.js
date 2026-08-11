import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGame, headers, register, startServer, syncComplete, uploadOverlayFile } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

test('overlay: changed, new, and deleted paths computed server-side', async () => {
  const { cookie, user } = await register(srv.base, 'overlay_player');
  const uid = String(user.id);
  const game = await createGame(srv.base, cookie, 'SyncGame', [
    { path: 'keep.bin', data: 'unchanged content' },
    { path: 'change.bin', data: 'original bytes' },
    { path: 'gone.bin', data: 'will be deleted' },
  ]);

  const changed = Buffer.from('NEW OVERLAY BYTES');
  const added = Buffer.from('brand new file');
  const changedHash = createHash('sha256').update(changed).digest('hex');
  const addedHash = createHash('sha256').update(added).digest('hex');

  for (const [p, data, hash] of [
    ['change.bin', changed, changedHash],
    ['new.bin', added, addedHash],
  ]) {
    const r = await uploadOverlayFile(srv.base, cookie, game.id, p, data, hash);
    assert.equal(r.status, 200, `overlay upload of ${p} failed: ${await r.text()}`);
  }

  const done = await syncComplete(srv.base, cookie, game.id, ['gone.bin']);
  assert.equal(done.status, 200);
  const { overlay } = await done.json();
  assert.equal(overlay.has_overlay, true);
  assert.equal(overlay.files, 2);
  assert.equal(overlay.deletions, 1);

  const deletions = JSON.parse(await readFile(path.join(srv.dir, 'users', uid, 'games', String(game.id), 'deletions.json'), 'utf8'));
  assert.deepEqual(deletions.paths, ['gone.bin']);
  assert.match(deletions.manifest_hash, /^[0-9a-f]{64}$/);
  const om = JSON.parse(await readFile(path.join(srv.dir, 'users', uid, 'games', String(game.id), 'overlay_manifest.json'), 'utf8'));
  const omByPath = new Map(om.files.map((f) => [f.path, f]));
  assert.equal(omByPath.get('change.bin').hash, changedHash);
  assert.equal(omByPath.get('new.bin').hash, addedHash);
  assert.equal(omByPath.get('keep.bin'), undefined);
});

test('overlay: server rejects mismatched hashes (trust-but-verify)', async () => {
  const { cookie } = await register(srv.base, 'overlay_verify');
  const game = await createGame(srv.base, cookie, 'Verify', [{ path: 'a.bin', data: 'base' }]);

  const r = await uploadOverlayFile(srv.base, cookie, game.id, 'a.bin', 'tampered data', 'f'.repeat(64));
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.equal(body.error, 'hash mismatch');
  assert.equal(body.mismatch.expected, 'f'.repeat(64));

  const info = await (await fetch(`${srv.base}/api/games/${game.id}/overlay`, { headers: headers(cookie) })).json();
  assert.equal(info.overlay.has_overlay, false);
});

test('overlay: client-supplied deletions are validated against clean manifest', async () => {
  const { cookie } = await register(srv.base, 'overlay_del');
  const game = await createGame(srv.base, cookie, 'DelCheck', [{ path: 'real.bin', data: 'x' }]);

  const done = await syncComplete(srv.base, cookie, game.id, ['real.bin', '../not-a-path', 'nonexistent.bin']);
  const { overlay } = await done.json();
  assert.equal(overlay.deletions, 1);
});

test('overlay: reset deletes my overlay and it no longer affects downloads', async () => {
  const { cookie } = await register(srv.base, 'overlay_reset');
  const game = await createGame(srv.base, cookie, 'ResetGame', [{ path: 'base.bin', data: 'original' }]);

  await uploadOverlayFile(srv.base, cookie, game.id, 'base.bin', 'changed', createHash('sha256').update('changed').digest('hex'));
  await syncComplete(srv.base, cookie, game.id, []);

  const before = await (await fetch(`${srv.base}/api/games/${game.id}/overlay`, { headers: headers(cookie) })).json();
  assert.equal(before.overlay.has_overlay, true);

  const reset = await fetch(`${srv.base}/api/games/${game.id}/overlay`, { method: 'DELETE', headers: headers(cookie) });
  assert.equal(reset.status, 200);
  const after = await (await fetch(`${srv.base}/api/games/${game.id}/overlay`, { headers: headers(cookie) })).json();
  assert.equal(after.overlay.has_overlay, false);
});

test('overlay reserved filenames are rejected', async () => {
  const { cookie } = await register(srv.base, 'overlay_reserved');
  const game = await createGame(srv.base, cookie, 'Reserved', [{ path: 'a.bin', data: 'x' }]);
  const r = await uploadOverlayFile(srv.base, cookie, game.id, 'deletions.json', '[]', createHash('sha256').update('[]').digest('hex'));
  assert.equal(r.status, 400);
});

test('overlay: empty (0-byte) files are supported', async () => {
  const { cookie } = await register(srv.base, 'overlay_empty');
  const game = await createGame(srv.base, cookie, 'EmptyOverlay', [{ path: 'a.bin', data: 'base' }]);

  const emptyHash = createHash('sha256').update('').digest('hex');
  const r = await uploadOverlayFile(srv.base, cookie, game.id, 'empty.bin', '', emptyHash);
  assert.equal(r.status, 200, await r.text());

  const done = await syncComplete(srv.base, cookie, game.id, []);
  assert.equal(done.status, 200);
  const { overlay } = await done.json();
  assert.equal(overlay.files, 1);
});

test('overlay: mass deletions (>50% of the manifest) require force:true', async () => {
  const { cookie } = await register(srv.base, 'overlay_force');
  const game = await createGame(srv.base, cookie, 'MassDel', [
    { path: 'a.bin', data: 'a' },
    { path: 'b.bin', data: 'b' },
    { path: 'c.bin', data: 'c' },
    { path: 'd.bin', data: 'd' },
  ]);

  const changed = Buffer.from('changed a');
  await uploadOverlayFile(srv.base, cookie, game.id, 'a.bin', changed, createHash('sha256').update(changed).digest('hex'));

  const post = (body) =>
    fetch(`${srv.base}/api/games/${game.id}/sync/complete`, {
      method: 'POST',
      headers: { ...headers(cookie), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const noForce = await post({ deletions: ['b.bin', 'c.bin', 'd.bin'] });
  assert.equal(noForce.status, 400);
  const err = await noForce.json();
  assert.match(err.error, /3 of 4 files/);
  assert.match(err.error, /force/);

  const stillBlocked = await post({ deletions: ['b.bin', 'c.bin', 'd.bin'], force: false });
  assert.equal(stillBlocked.status, 400);

  const forced = await post({ deletions: ['b.bin', 'c.bin', 'd.bin'], force: true });
  assert.equal(forced.status, 200);
  const { overlay } = await forced.json();
  assert.equal(overlay.deletions, 3);
});

test('overlay: stale .part files are excluded from the rebuilt manifest', async () => {
  const { cookie, user } = await register(srv.base, 'overlay_part');
  const game = await createGame(srv.base, cookie, 'PartGame', [{ path: 'a.bin', data: 'base' }]);

  const overlayRoot = path.join(srv.dir, 'users', String(user.id), 'games', String(game.id), 'overlay');
  await mkdir(overlayRoot, { recursive: true });
  await writeFile(path.join(overlayRoot, 'stale.bin.part'), 'partial bytes');

  const done = await syncComplete(srv.base, cookie, game.id, []);
  assert.equal(done.status, 200);
  const { overlay } = await done.json();
  assert.equal(overlay.files, 0, '.part files must never enter the overlay manifest');
  assert.equal(existsSync(path.join(overlayRoot, 'stale.bin.part')), false, 'sync/complete must purge leftover part files');
});

test('overlay: GET /:id/overlay exposes file_list while keeping files as a count', async () => {
  const { cookie } = await register(srv.base, 'overlay_filelist');
  const game = await createGame(srv.base, cookie, 'FileList', [{ path: 'base.bin', data: 'original' }]);

  const changed = Buffer.from('changed bytes');
  const changedHash = createHash('sha256').update(changed).digest('hex');
  await uploadOverlayFile(srv.base, cookie, game.id, 'base.bin', changed, changedHash);
  await uploadOverlayFile(srv.base, cookie, game.id, 'new.bin', 'added', createHash('sha256').update('added').digest('hex'));
  await syncComplete(srv.base, cookie, game.id, []);

  const { overlay } = await (await fetch(`${srv.base}/api/games/${game.id}/overlay`, { headers: headers(cookie) })).json();
  assert.equal(overlay.files, 2, 'files must remain the numeric count for the web UI');
  const byPath = new Map(overlay.file_list.map((f) => [f.path, f]));
  assert.equal(byPath.size, 2);
  assert.equal(byPath.get('base.bin').hash, changedHash);
  assert.equal(byPath.get('new.bin').size, 5);
  assert.ok(overlay.file_list.every((f) => /^[0-9a-f]{64}$/.test(f.hash)));
});

test('overlay: GET /:id/effective lists clean+overlay with sources and honors deletions', async () => {
  const { cookie } = await register(srv.base, 'overlay_effective');
  const game = await createGame(srv.base, cookie, 'EffGame', [
    { path: 'keep.bin', data: 'keep' },
    { path: 'change.bin', data: 'orig' },
    { path: 'gone.bin', data: 'gone' },
  ]);

  const changed = Buffer.from('new overlay');
  const changedHash = createHash('sha256').update(changed).digest('hex');
  await uploadOverlayFile(srv.base, cookie, game.id, 'change.bin', changed, changedHash);
  await uploadOverlayFile(srv.base, cookie, game.id, 'added.bin', 'add', createHash('sha256').update('add').digest('hex'));
  await syncComplete(srv.base, cookie, game.id, ['gone.bin']);

  const res = await fetch(`${srv.base}/api/games/${game.id}/effective`, { headers: headers(cookie) });
  assert.equal(res.status, 200);
  const { files, deletions } = await res.json();
  assert.deepEqual(deletions, ['gone.bin']);
  const byPath = new Map(files.map((f) => [f.path, f]));
  assert.equal(byPath.get('keep.bin').source, 'clean');
  assert.equal(byPath.get('change.bin').source, 'overlay');
  assert.equal(byPath.get('change.bin').hash, changedHash);
  assert.equal(byPath.get('added.bin').source, 'overlay');
  assert.equal(byPath.get('gone.bin'), undefined);
  assert.deepEqual(files.map((f) => f.path), ['added.bin', 'change.bin', 'keep.bin'], 'sorted by path');
});

test('overlay: effective excludes stale deletions after a re-upload changes the manifest', async () => {
  const { cookie } = await register(srv.base, 'overlay_stale');
  const game = await createGame(srv.base, cookie, 'StaleGame', [
    { path: 'a.bin', data: 'aaa' },
    { path: 'b.bin', data: 'bbb' },
  ]);
  await syncComplete(srv.base, cookie, game.id, ['b.bin']);

  const before = await (await fetch(`${srv.base}/api/games/${game.id}/effective`, { headers: headers(cookie) })).json();
  assert.equal(before.deletions.length, 1);

  const buf = Buffer.from('AAA-CHANGED');
  const total = Math.max(1, Math.ceil(buf.length / 4194304));
  for (let i = 0; i < total; i++) {
    const chunk = buf.subarray(i * 4194304, (i + 1) * 4194304);
    const r = await fetch(`${srv.base}/api/games/${game.id}/files`, {
      method: 'POST',
      headers: { ...headers(cookie), 'x-path': encodeURIComponent('a.bin'), 'x-index': String(i), 'x-total': String(total), 'x-size': String(buf.length) },
      body: new Uint8Array(chunk),
    });
    assert.equal(r.status, 200, await r.text());
  }
  await fetch(`${srv.base}/api/games/${game.id}/upload/complete`, { method: 'POST', headers: headers(cookie) });
  for (let i = 0; i < 60; i++) {
    const st = await (await fetch(`${srv.base}/api/games/${game.id}/status`, { headers: headers(cookie) })).json();
    if (st.status === 'ready') break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const after = await (await fetch(`${srv.base}/api/games/${game.id}/effective`, { headers: headers(cookie) })).json();
  assert.equal(after.deletions.length, 0, 'stale deletions must be dropped');
  assert.ok(after.files.some((f) => f.path === 'b.bin' && f.source === 'clean'), 'the deleted file is back');
});

test('overlay: effective 404s unknown games and 409s processing games', async () => {
  const { cookie } = await register(srv.base, 'overlay_eff_err');
  const missing = await fetch(`${srv.base}/api/games/999999/effective`, { headers: headers(cookie) });
  assert.equal(missing.status, 404);

  const created = await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'EffProcessing' }),
  });
  const { game } = await created.json();
  const res = await fetch(`${srv.base}/api/games/${game.id}/effective`, { headers: headers(cookie) });
  assert.equal(res.status, 409);
});
