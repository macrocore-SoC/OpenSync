import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CHUNK_SIZE } from './config.js';
import { hashFile } from './hash-worker.js';

/** Incremental SHA-256 states for multi-chunk uploads: resolved partPath -> { hash, offset }. */
const inFlightHashes = new Map();
const MAX_INFLIGHT_HASHES = 4096;

export function clearInFlightHashes(dirPrefix) {
  const prefix = path.resolve(dirPrefix) + path.sep;
  for (const key of inFlightHashes.keys()) {
    if (key.startsWith(prefix)) inFlightHashes.delete(key);
  }
}

async function openWithMkdir(filePath, flags) {
  try {
    return await open(filePath, flags);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await mkdir(path.dirname(filePath), { recursive: true });
    return await open(filePath, flags);
  }
}

async function renameWithMkdir(src, dest) {
  try {
    await rename(src, dest);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(src, dest);
  }
}

async function writevAll(fh, chunks) {
  if (chunks.length === 0) return;
  if (chunks.length === 1) {
    let offset = 0;
    const buf = chunks[0];
    while (offset < buf.length) {
      const { bytesWritten } = await fh.write(buf, offset, buf.length - offset);
      if (bytesWritten === 0) throw new Error('short write to part file');
      offset += bytesWritten;
    }
    return;
  }
  let idx = 0;
  let totalRemaining = 0;
  for (let i = 0; i < chunks.length; i += 1) totalRemaining += chunks[i].length;
  while (totalRemaining > 0 && idx < chunks.length) {
    const slice = idx === 0 ? chunks : chunks.slice(idx);
    const { bytesWritten } = await fh.writev(slice);
    if (bytesWritten === 0) throw new Error('short writev to part file');
    totalRemaining -= bytesWritten;
    let rem = bytesWritten;
    while (rem > 0 && idx < chunks.length) {
      const cur = chunks[idx];
      if (rem >= cur.length) {
        rem -= cur.length;
        idx += 1;
      } else {
        chunks[idx] = cur.subarray(rem);
        rem = 0;
      }
    }
  }
}

function mismatchError(relPath, expected, actual) {
  const err = new Error('hash mismatch');
  err.status = 422;
  err.mismatch = { path: relPath, expected, actual };
  return err;
}

/**
 * Receive one binary chunk from req and write it to a `.part` file.
 * Chunks must arrive sequentially. On the final chunk the part file is finalized
 * to its real destination and `validate` is invoked (if provided).
 *
 * Returns a result object:
 *  - { done: false, received }
 *  - { done: true, file?, hash, size, mtimeMs, finalPath }
 * Throws { status, error } HTTP-style errors.
 */
export async function receiveChunk({
  rootDir,
  partDir = rootDir,
  finalDir = rootDir,
  relPath,
  index,
  total,
  declaredSize,
  req,
  declaredHash = null,
  outOfOrderMessage = 'chunk out of order; re-init first',
  onChunk = null,
  validate = null,
}) {
  if (!relPath) {
    const err = new Error('invalid file path');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 0 || index >= total) {
    const err = new Error('invalid chunk index/total');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(declaredSize) || declaredSize < 0) {
    const err = new Error('invalid file size');
    err.status = 400;
    throw err;
  }

  const partPath = path.resolve(partDir, `${relPath}.part`);
  const expectedOffset = index * CHUNK_SIZE;
  const existingStat = await stat(partPath).catch(() => null);
  const current = existingStat ? existingStat.size : 0;
  if (current !== expectedOffset) {
    const err = new Error(outOfOrderMessage);
    err.status = 409;
    err.received = Math.floor(current / CHUNK_SIZE);
    throw err;
  }

  const isSingleChunk = index === 0 && total === 1;
  const isLastChunk = index === total - 1;

  if (isSingleChunk) {
    const chunks = [];
    const hash = createHash('sha256');
    let receivedBytes = 0;
    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (receivedBytes > CHUNK_SIZE) {
        const err = new Error('chunk too large');
        err.status = 413;
        throw err;
      }
      hash.update(chunk);
      chunks.push(chunk);
    }

    if (receivedBytes !== declaredSize) {
      const err = new Error(`size mismatch: got ${receivedBytes}, expected ${declaredSize}`);
      err.status = 400;
      throw err;
    }

    const actualHash = hash.digest('hex');
    if (declaredHash && actualHash !== declaredHash) {
      throw mismatchError(relPath, declaredHash, actualHash);
    }

    const fh = await openWithMkdir(partPath, 'w');
    try {
      await writevAll(fh, chunks);
    } finally {
      await fh.close();
    }
    if (onChunk) onChunk(receivedBytes);

    const finalPath = path.resolve(finalDir, relPath);
    await renameWithMkdir(partPath, finalPath);
    const finalStat = await stat(finalPath);
    const precomputed = { hash: actualHash, size: finalStat.size, mtimeMs: finalStat.mtimeMs };
    if (validate) {
      return { done: true, file: await validate(relPath, finalPath, precomputed), ...precomputed, finalPath };
    }
    return { done: true, ...precomputed, finalPath };
  }

  // Multi-chunk path (total > 1)
  let hashEntry = null;
  if (index === 0) {
    inFlightHashes.delete(partPath);
    hashEntry = { hash: createHash('sha256'), offset: 0 };
  } else {
    const existing = inFlightHashes.get(partPath);
    if (existing && existing.offset === expectedOffset) {
      hashEntry = existing;
    } else {
      inFlightHashes.delete(partPath);
    }
  }

  const chunks = [];
  let receivedBytes = 0;
  try {
    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (receivedBytes > CHUNK_SIZE) {
        const err = new Error('chunk too large');
        err.status = 413;
        throw err;
      }
      chunks.push(chunk);
    }
  } catch (err) {
    inFlightHashes.delete(partPath);
    throw err;
  }

  const partSize = current + receivedBytes;
  if (isLastChunk && partSize !== declaredSize) {
    inFlightHashes.delete(partPath);
    await rm(partPath, { force: true });
    const err = new Error(`size mismatch: got ${partSize}, expected ${declaredSize}`);
    err.status = 400;
    throw err;
  }

  if (hashEntry) {
    for (let i = 0; i < chunks.length; i += 1) {
      hashEntry.hash.update(chunks[i]);
    }
    hashEntry.offset = partSize;
  }

  const fh = await openWithMkdir(partPath, 'a');
  try {
    await writevAll(fh, chunks);
  } catch (err) {
    inFlightHashes.delete(partPath);
    throw err;
  } finally {
    await fh.close();
  }

  if (!isLastChunk && hashEntry) {
    if (inFlightHashes.size >= MAX_INFLIGHT_HASHES && !inFlightHashes.has(partPath)) {
      inFlightHashes.delete(inFlightHashes.keys().next().value);
    }
    inFlightHashes.set(partPath, hashEntry);
  }
  if (onChunk) onChunk(partSize);

  if (!isLastChunk) {
    return { done: false, received: Math.floor(partSize / CHUNK_SIZE) };
  }

  inFlightHashes.delete(partPath);
  const actualHash = hashEntry ? hashEntry.hash.digest('hex') : (await hashFile(partPath)).hash;
  if (declaredHash && actualHash !== declaredHash) {
    await rm(partPath, { force: true });
    throw mismatchError(relPath, declaredHash, actualHash);
  }

  const finalPath = path.resolve(finalDir, relPath);
  await renameWithMkdir(partPath, finalPath);
  const finalStat = await stat(finalPath);
  const precomputed = { hash: actualHash, size: finalStat.size, mtimeMs: finalStat.mtimeMs };
  if (validate) {
    return { done: true, file: await validate(relPath, finalPath, precomputed), ...precomputed, finalPath };
  }
  return { done: true, ...precomputed, finalPath };
}
