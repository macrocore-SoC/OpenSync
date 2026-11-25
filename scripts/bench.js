import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { hashFile, Sha256 } from '../client/js/sha256.js';

const CHUNK_SIZE = 4 * 1024 * 1024;
const MB = 1024 * 1024;

function makeBuffer(bytes) {
  const buf = Buffer.allocUnsafe(bytes);
  for (let i = 0; i + 4 <= bytes; i += 4) {
    buf.writeUInt32LE((i * 2654435761) >>> 0, i);
  }
  return buf;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function fmtResult(label, bytes, ms) {
  const mb = bytes / MB;
  const mbps = ms > 0 ? mb / (ms / 1000) : 0;
  console.log(`  ${label.padEnd(42)} ${ms.toFixed(1).padStart(8)} ms  ${mbps.toFixed(1).padStart(8)} MB/s`);
}

async function main() {
  const totalStart = performance.now();
  const tempDir = mkdtempSync(path.join(tmpdir(), 'opensync-bench-'));
  let server = null;

  try {
    process.env.OPENSYNC_STORAGE = tempDir;
    process.env.NODE_ENV = 'test';

    const [{ app }, { generateManifest }, { gameFilesDir }] = await Promise.all([
      import('../server/index.js'),
      import('../server/manifest.js'),
      import('../server/storage.js'),
    ]);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    console.log('OpenSync Benchmark Suite');
    console.log('========================');

    // 1. Browser Sha256
    console.log('\n[1] Browser Sha256 (client/js/sha256.js)');
    const buf16 = new Uint8Array(makeBuffer(16 * MB));
    let t0 = performance.now();
    new Sha256().update(buf16).digestHex();
    fmtResult('Sha256.update(16 MB).digestHex()', buf16.byteLength, performance.now() - t0);

    const blob16 = new Blob([buf16]);
    t0 = performance.now();
    await hashFile(blob16);
    fmtResult('hashFile(16 MB Blob)', buf16.byteLength, performance.now() - t0);

    // 2. Server generateManifest
    console.log('\n[2] Server generateManifest (server/manifest.js)');
    const smallDir = gameFilesDir(9001);
    mkdirSync(smallDir, { recursive: true });
    const smallFileBuf = makeBuffer(64 * 1024);
    for (let i = 0; i < 200; i++) {
      writeFileSync(path.join(smallDir, `file-${String(i).padStart(3, '0')}.bin`), smallFileBuf);
    }
    t0 = performance.now();
    await generateManifest(9001);
    fmtResult('generateManifest (200 x 64 KB = 12.8 MB)', 200 * 64 * 1024, performance.now() - t0);

    const largeDir = gameFilesDir(9002);
    mkdirSync(largeDir, { recursive: true });
    const largeFileBuf = makeBuffer(16 * MB);
    for (let i = 0; i < 4; i++) {
      writeFileSync(path.join(largeDir, `pak-${i}.bin`), largeFileBuf);
    }
    t0 = performance.now();
    await generateManifest(9002);
    fmtResult('generateManifest (4 x 16 MB = 64 MB)', 4 * 16 * MB, performance.now() - t0);

    // Register admin user for HTTP benchmarks
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'benchadmin', password: 'benchpassword123' }),
    });
    if (!regRes.ok) throw new Error(`register failed: ${regRes.status} ${await regRes.text()}`);
    const cookie = regRes.headers.get('set-cookie').split(';')[0];
    const authHeaders = { cookie };

    // 3. Server chunked upload (32 MB + 50 x 32 KB)
    console.log('\n[3] Server chunked upload (POST /api/games/:id/files)');
    const createRes = await fetch(`${base}/api/games`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'BenchGame32MB' }),
    });
    if (!createRes.ok) throw new Error(`create game failed: ${createRes.status}`);
    const { game } = await createRes.json();

    const bigUploadBuf = makeBuffer(32 * MB);
    const smallUploadBuf = makeBuffer(32 * 1024);
    const totalUploadBytes = bigUploadBuf.length + 50 * smallUploadBuf.length;

    t0 = performance.now();
    const totalChunks = bigUploadBuf.length / CHUNK_SIZE;
    for (let i = 0; i < totalChunks; i++) {
      const chunk = bigUploadBuf.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const r = await fetch(`${base}/api/games/${game.id}/files`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'x-path': encodeURIComponent('main.pak'),
          'x-index': String(i),
          'x-total': String(totalChunks),
          'x-size': String(bigUploadBuf.length),
        },
        body: chunk,
      });
      if (!r.ok) throw new Error(`chunk upload failed: ${r.status}`);
    }
    for (let i = 0; i < 50; i++) {
      const r = await fetch(`${base}/api/games/${game.id}/files`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'x-path': encodeURIComponent(`assets/item-${i}.dat`),
          'x-index': '0',
          'x-total': '1',
          'x-size': String(smallUploadBuf.length),
        },
        body: smallUploadBuf,
      });
      if (!r.ok) throw new Error(`small file upload failed: ${r.status}`);
    }
    fmtResult('Upload 32 MB (8x4MB) + 50x32 KB', totalUploadBytes, performance.now() - t0);

    await fetch(`${base}/api/games/${game.id}/upload/complete`, { method: 'POST', headers: authHeaders });
    for (let i = 0; i < 120; i++) {
      const st = await (await fetch(`${base}/api/games/${game.id}/status`, { headers: authHeaders })).json();
      if (st.status === 'ready') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // 4. Server overlay upload + sync/complete
    console.log('\n[4] Server overlay upload + sync/complete');
    const unchangedBuf = makeBuffer(16 * 1024);
    const unchangedHash = sha256Hex(unchangedBuf);
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/api/games/${game.id}/overlay/files`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'x-path': encodeURIComponent(`saves/slot-${i}.sav`),
          'x-index': '0',
          'x-total': '1',
          'x-size': String(unchangedBuf.length),
          'x-hash': unchangedHash,
        },
        body: unchangedBuf,
      });
      if (!r.ok) throw new Error(`seed overlay failed: ${r.status}`);
    }
    await fetch(`${base}/api/games/${game.id}/sync/complete`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ deletions: [] }),
    });

    const overlayBuf = makeBuffer(1 * MB);
    const overlayHash = sha256Hex(overlayBuf);
    t0 = performance.now();
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/api/games/${game.id}/overlay/files`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'x-path': encodeURIComponent(`saves/new-${i}.sav`),
          'x-index': '0',
          'x-total': '1',
          'x-size': String(overlayBuf.length),
          'x-hash': overlayHash,
        },
        body: overlayBuf,
      });
      if (!r.ok) throw new Error(`overlay upload failed: ${r.status}`);
    }
    const syncRes = await fetch(`${base}/api/games/${game.id}/sync/complete`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ deletions: [] }),
    });
    if (!syncRes.ok) throw new Error(`sync/complete failed: ${syncRes.status}`);
    fmtResult('4x1 MB overlay + 20 unchanged + sync', 4 * MB, performance.now() - t0);

    // 5. Server HTTP streaming ZIP download
    console.log('\n[5] Server HTTP streaming ZIP download (32 MB game)');
    t0 = performance.now();
    const dlStoreRes = await fetch(`${base}/api/games/${game.id}/download`, { headers: authHeaders });
    if (!dlStoreRes.ok) throw new Error(`download store failed: ${dlStoreRes.status}`);
    const dlStoreBuf = await dlStoreRes.arrayBuffer();
    fmtResult('GET /download (STORE)', dlStoreBuf.byteLength, performance.now() - t0);

    t0 = performance.now();
    const dlDeflateRes = await fetch(`${base}/api/games/${game.id}/download?deflate=1`, { headers: authHeaders });
    if (!dlDeflateRes.ok) throw new Error(`download deflate=1 failed: ${dlDeflateRes.status}`);
    const dlDeflateBuf = await dlDeflateRes.arrayBuffer();
    fmtResult('GET /download?deflate=1', dlDeflateBuf.byteLength, performance.now() - t0);

    // 6. /api/admin/bench
    console.log('\n[6] /api/admin/bench (64 MB in-memory zip)');
    const benchRes = await fetch(`${base}/api/admin/bench`, { headers: authHeaders });
    if (!benchRes.ok) throw new Error(`admin bench failed: ${benchRes.status}`);
    const benchJson = await benchRes.json();
    for (const r of benchJson.results) {
      console.log(`  ${r.method.padEnd(42)} ${String(r.out_mb).padStart(6)} MB  ${String(r.mbps).padStart(8)} MB/s`);
    }

    const totalMs = performance.now() - totalStart;
    console.log(`\nCompleted in ${(totalMs / 1000).toFixed(2)}s`);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
