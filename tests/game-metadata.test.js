import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createGame, headers, register, startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

test('game metadata: POST with executable persists it and it is returned everywhere', async () => {
  const { cookie } = await register(srv.base, 'meta_exec_owner');
  const created = await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Exec Game', executable: 'bin/Game.exe' }),
  });
  assert.equal(created.status, 201);
  const { game } = await created.json();
  assert.equal(game.executable, 'bin/Game.exe');

  const list = await (await fetch(`${srv.base}/api/games`, { headers: headers(cookie) })).json();
  const fromList = list.games.find((g) => g.id === game.id);
  assert.equal(fromList.executable, 'bin/Game.exe');
});

test('game metadata: POST without executable leaves it null', async () => {
  const { cookie } = await register(srv.base, 'meta_noexec');
  const { game } = await (await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'No Exec' }),
  })).json();
  assert.equal(game.executable, null);
});

test('game metadata: invalid executable paths are rejected with 400', async () => {
  const { cookie } = await register(srv.base, 'meta_badexec');
  for (const bad of ['../escape.exe', '/etc/passwd', 'a\\b.exe', 'up/../../../down.exe']) {
    const res = await fetch(`${srv.base}/api/games`, {
      method: 'POST',
      headers: { ...headers(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Bad ${bad}`, executable: bad }),
    });
    assert.equal(res.status, 400, `executable ${JSON.stringify(bad)} must be rejected`);
  }
});

test('game metadata: paths that normalize inside the game root are accepted normalized', async () => {
  const { cookie } = await register(srv.base, 'meta_normalize');
  const { game } = await (await fetch(`${srv.base}/api/games`, {
    method: 'POST',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Norm', executable: 'bin/../Game.exe' }),
  })).json();
  assert.equal(game.executable, 'Game.exe');
});

test('game metadata: manager PATCH sets, clears, and keeps executable', async () => {
  const { cookie } = await register(srv.base, 'meta_patch');
  const game = await createGame(srv.base, cookie, 'Patch Game', [{ path: 'game.exe', data: 'x' }]);

  const set = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ executable: 'root/game.exe' }),
  });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).game.executable, 'root/game.exe');

  const clear = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ executable: null }),
  });
  assert.equal((await clear.json()).game.executable, null);

  const keep = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ executable: 'bin/keep.exe' }),
  });
  assert.equal((await keep.json()).game.executable, 'bin/keep.exe');

  const noop = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'unchanged executable' }),
  });
  assert.equal((await noop.json()).game.executable, 'bin/keep.exe');

  const bad = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ executable: '../escape.exe' }),
  });
  assert.equal(bad.status, 400);
});

test('game metadata: non-manager PATCH of executable is 403', async () => {
  const admin = await register(srv.base, 'meta_admin');
  const other = await register(srv.base, 'meta_other');
  const game = await createGame(srv.base, admin.cookie, 'Owner Game', [{ path: 'a.exe', data: 'y' }]);
  const res = await fetch(`${srv.base}/api/games/${game.id}`, {
    method: 'PATCH',
    headers: { ...headers(other.cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ executable: 'a.exe' }),
  });
  assert.equal(res.status, 403);
});
