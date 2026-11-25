import { open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

const ZIP64_LIMIT = 0xffffffff;
const ZIP64_ENTRY_LIMIT = 0xffff;
const DEFLATE_ZIP64_THRESHOLD = 0xff000000;

// Bit 3: Data Descriptor follows entry payload; Bit 11: UTF-8 filename encoding.
const FLAGS_DD_UTF8 = 0x0808;

const READ_BUF_SIZE = 1024 * 1024;
const SMALL_FILE_LIMIT = 64 * 1024;
const DEFLATE_CHUNK_SIZE = 256 * 1024;
const MAX_POOL_BUFFERS = 4;
const CD_BATCH_SIZE = 512 * 1024;

function toDosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(0, Math.min(127, d.getFullYear() - 1980));
  const dosDate = (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { dosTime, dosDate };
}

function buildLocalHeader(nameBuf, method, dosTime, dosDate, entryZip64) {
  const extraLen = entryZip64 ? 20 : 0;
  const buf = Buffer.allocUnsafe(30 + nameBuf.length + extraLen);
  buf.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
  buf.writeUInt16LE(entryZip64 ? 45 : 20, 4);
  buf.writeUInt16LE(FLAGS_DD_UTF8, 6);
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(dosTime, 10);
  buf.writeUInt16LE(dosDate, 12);
  buf.writeUInt32LE(0, 14);
  buf.writeUInt32LE(entryZip64 ? ZIP64_LIMIT : 0, 18);
  buf.writeUInt32LE(entryZip64 ? ZIP64_LIMIT : 0, 22);
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(extraLen, 28);
  nameBuf.copy(buf, 30);
  if (entryZip64) {
    const o = 30 + nameBuf.length;
    buf.writeUInt16LE(0x0001, o);
    buf.writeUInt16LE(16, o + 2);
    buf.writeBigUInt64LE(0n, o + 4);
    buf.writeBigUInt64LE(0n, o + 12);
  }
  return buf;
}

function buildDataDescriptor(crc, compSize, uncompSize, entryZip64) {
  if (entryZip64) {
    const buf = Buffer.allocUnsafe(24);
    buf.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
    buf.writeUInt32LE(crc >>> 0, 4);
    buf.writeBigUInt64LE(BigInt(compSize), 8);
    buf.writeBigUInt64LE(BigInt(uncompSize), 16);
    return buf;
  }
  const buf = Buffer.allocUnsafe(16);
  buf.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
  buf.writeUInt32LE(crc >>> 0, 4);
  buf.writeUInt32LE(compSize >>> 0, 8);
  buf.writeUInt32LE(uncompSize >>> 0, 12);
  return buf;
}

function writeCentralEntry(buf, pos, e) {
  const needUncomp64 = e.uncompSize >= ZIP64_LIMIT;
  const needComp64 = e.compSize >= ZIP64_LIMIT;
  const needOffset64 = e.localHeaderOffset >= ZIP64_LIMIT;
  const extraPayloadLen = (needUncomp64 ? 8 : 0) + (needComp64 ? 8 : 0) + (needOffset64 ? 8 : 0);
  const extraLen = extraPayloadLen > 0 ? 4 + extraPayloadLen : 0;
  const entryZip64 = extraLen > 0;

  buf.writeUInt32LE(CENTRAL_DIR_SIG, pos);
  buf.writeUInt16LE(entryZip64 ? 45 : 20, pos + 4);
  buf.writeUInt16LE(entryZip64 ? 45 : 20, pos + 6);
  buf.writeUInt16LE(FLAGS_DD_UTF8, pos + 8);
  buf.writeUInt16LE(e.method, pos + 10);
  buf.writeUInt16LE(e.dosTime, pos + 12);
  buf.writeUInt16LE(e.dosDate, pos + 14);
  buf.writeUInt32LE(e.crc >>> 0, pos + 16);
  buf.writeUInt32LE(needComp64 ? ZIP64_LIMIT : e.compSize >>> 0, pos + 20);
  buf.writeUInt32LE(needUncomp64 ? ZIP64_LIMIT : e.uncompSize >>> 0, pos + 24);
  buf.writeUInt16LE(e.nameBuf.length, pos + 28);
  buf.writeUInt16LE(extraLen, pos + 30);
  buf.writeUInt16LE(0, pos + 32);
  buf.writeUInt16LE(0, pos + 34);
  buf.writeUInt16LE(0, pos + 36);
  buf.writeUInt32LE(0, pos + 38);
  buf.writeUInt32LE(needOffset64 ? ZIP64_LIMIT : e.localHeaderOffset >>> 0, pos + 42);
  e.nameBuf.copy(buf, pos + 46);

  let o = pos + 46 + e.nameBuf.length;
  if (entryZip64) {
    buf.writeUInt16LE(0x0001, o);
    buf.writeUInt16LE(extraPayloadLen, o + 2);
    o += 4;
    if (needUncomp64) {
      buf.writeBigUInt64LE(BigInt(e.uncompSize), o);
      o += 8;
    }
    if (needComp64) {
      buf.writeBigUInt64LE(BigInt(e.compSize), o);
      o += 8;
    }
    if (needOffset64) {
      buf.writeBigUInt64LE(BigInt(e.localHeaderOffset), o);
      o += 8;
    }
  }
  return o;
}

function buildEndRecords(entryCount, cdSize, cdOffset) {
  const needZip64 =
    entryCount >= ZIP64_ENTRY_LIMIT || cdSize >= ZIP64_LIMIT || cdOffset >= ZIP64_LIMIT;
  const buf = Buffer.allocUnsafe(needZip64 ? 98 : 22);
  let pos = 0;

  if (needZip64) {
    const zip64EocdOffset = cdOffset + cdSize;
    buf.writeUInt32LE(ZIP64_EOCD_SIG, pos);
    buf.writeBigUInt64LE(44n, pos + 4);
    buf.writeUInt16LE(45, pos + 12);
    buf.writeUInt16LE(45, pos + 14);
    buf.writeUInt32LE(0, pos + 16);
    buf.writeUInt32LE(0, pos + 20);
    buf.writeBigUInt64LE(BigInt(entryCount), pos + 24);
    buf.writeBigUInt64LE(BigInt(entryCount), pos + 32);
    buf.writeBigUInt64LE(BigInt(cdSize), pos + 40);
    buf.writeBigUInt64LE(BigInt(cdOffset), pos + 48);
    pos += 56;

    buf.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIG, pos);
    buf.writeUInt32LE(0, pos + 4);
    buf.writeBigUInt64LE(BigInt(zip64EocdOffset), pos + 8);
    buf.writeUInt32LE(1, pos + 16);
    pos += 20;
  }

  buf.writeUInt32LE(EOCD_SIG, pos);
  buf.writeUInt16LE(0, pos + 4);
  buf.writeUInt16LE(0, pos + 6);
  buf.writeUInt16LE(entryCount >= ZIP64_ENTRY_LIMIT ? ZIP64_ENTRY_LIMIT : entryCount, pos + 8);
  buf.writeUInt16LE(entryCount >= ZIP64_ENTRY_LIMIT ? ZIP64_ENTRY_LIMIT : entryCount, pos + 10);
  buf.writeUInt32LE(cdSize >= ZIP64_LIMIT ? ZIP64_LIMIT : cdSize, pos + 12);
  buf.writeUInt32LE(cdOffset >= ZIP64_LIMIT ? ZIP64_LIMIT : cdOffset, pos + 16);
  buf.writeUInt16LE(0, pos + 20);
  return buf;
}

/**
 * Stream files as a ZIP/ZIP64 archive directly into a Node Writable stream.
 * Uses native SIMD zlib.crc32, reused 1 MB buffers, and backpressure-aware writes.
 *
 * @param {Array<{path: string, absPath?: string, data?: Buffer|Uint8Array, mtime?: Date}>} files
 * @param {import('node:stream').Writable} writable
 * @param {{ level?: number }} [opts]
 * @returns {Promise<{ bytesWritten: number, aborted: boolean }>}
 */
export async function streamZipFiles(files, writable, { level = 0 } = {}) {
  const compressionLevel = Number.isInteger(level) && level >= 1 && level <= 9 ? level : 0;
  const method = compressionLevel > 0 ? 8 : 0;

  let offset = 0;
  let aborted = Boolean(writable.destroyed || writable.writableEnded);
  let streamErr = null;
  let drainResolve = null;
  let poolWaiter = null;
  let activeDeflater = null;
  let allocated = 0;
  const pool = [];

  function acquireBuf() {
    if (aborted) return null;
    if (pool.length > 0) return pool.pop();
    if (allocated < MAX_POOL_BUFFERS) {
      allocated++;
      return Buffer.allocUnsafe(READ_BUF_SIZE);
    }
    return new Promise((resolve) => {
      poolWaiter = resolve;
    });
  }

  function releaseBuf(buf) {
    if (poolWaiter) {
      const w = poolWaiter;
      poolWaiter = null;
      w(aborted ? null : buf);
    } else if (!aborted) {
      pool.push(buf);
    }
  }

  function wakeWaiters() {
    if (drainResolve) {
      const r = drainResolve;
      drainResolve = null;
      r();
    }
    if (poolWaiter) {
      const w = poolWaiter;
      poolWaiter = null;
      w(null);
    }
    if (activeDeflater && !activeDeflater.destroyed) {
      activeDeflater.destroy();
    }
  }

  function onDrain() {
    if (activeDeflater && !activeDeflater.destroyed) {
      activeDeflater.resume();
    }
    if (drainResolve) {
      const r = drainResolve;
      drainResolve = null;
      r();
    }
  }

  function onClose() {
    if (!writable.writableFinished) {
      aborted = true;
      wakeWaiters();
    }
  }

  function onError(err) {
    streamErr = err;
    aborted = true;
    wakeWaiters();
  }

  writable.on('drain', onDrain);
  writable.on('close', onClose);
  writable.on('error', onError);

  function waitDrain() {
    if (aborted) return null;
    return new Promise((resolve) => {
      drainResolve = resolve;
    });
  }

  function writeChunk(chunk, bufToRelease = null) {
    if (aborted) {
      if (bufToRelease) releaseBuf(bufToRelease);
      return null;
    }
    offset += chunk.length;
    const ok = bufToRelease
      ? writable.write(chunk, () => releaseBuf(bufToRelease))
      : writable.write(chunk);
    if (!ok && !aborted) return waitDrain();
    return null;
  }

  async function writeEntryDeflate(entryZip64, feedFn) {
    const deflater = createDeflateRaw({ level: compressionLevel, chunkSize: DEFLATE_CHUNK_SIZE });
    activeDeflater = deflater;
    let compSize = 0;
    let dErr = null;
    let dDrainResolve = null;
    let dDoneResolve = null;

    const dDone = new Promise((resolve) => {
      dDoneResolve = resolve;
    });

    deflater.on('data', (chunk) => {
      if (aborted) return;
      compSize += chunk.length;
      offset += chunk.length;
      if (!writable.write(chunk) && !aborted) {
        deflater.pause();
      }
    });
    deflater.on('drain', () => {
      if (dDrainResolve) {
        const r = dDrainResolve;
        dDrainResolve = null;
        r();
      }
    });
    deflater.on('error', (err) => {
      dErr = err;
      if (dDrainResolve) {
        const r = dDrainResolve;
        dDrainResolve = null;
        r();
      }
      dDoneResolve();
    });
    deflater.on('close', () => {
      if (dDrainResolve) {
        const r = dDrainResolve;
        dDrainResolve = null;
        r();
      }
      dDoneResolve();
    });
    deflater.on('end', () => {
      dDoneResolve();
    });

    function waitDeflaterDrain() {
      if (aborted || dErr) return null;
      return new Promise((resolve) => {
        dDrainResolve = resolve;
      });
    }

    try {
      await feedFn(deflater, waitDeflaterDrain, () => aborted || Boolean(dErr));
      if (!aborted && !dErr) {
        deflater.end();
      }
      await dDone;
      if (dErr && !aborted) throw dErr;
      if (!aborted && writable.writableNeedDrain) {
        const p = waitDrain();
        if (p) await p;
      }
      return compSize;
    } finally {
      activeDeflater = null;
      if (!deflater.destroyed) deflater.destroy();
    }
  }

  const cdEntries = [];
  let completedNormally = false;

  try {
    if (aborted) {
      if (streamErr) throw streamErr;
      return { bytesWritten: 0, aborted: true };
    }

    for (const f of files) {
      if (aborted) break;

      const nameBuf = Buffer.from(f.path, 'utf8');
      const localHeaderOffset = offset;

      if (f.data != null) {
        const data = Buffer.isBuffer(f.data)
          ? f.data
          : Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength);
        const uncompSize = data.length;
        const { dosTime, dosDate } = toDosDateTime(f.mtime);
        const entryZip64 =
          method === 0 ? uncompSize >= ZIP64_LIMIT : uncompSize >= DEFLATE_ZIP64_THRESHOLD;

        const lp = writeChunk(buildLocalHeader(nameBuf, method, dosTime, dosDate, entryZip64));
        if (lp) await lp;
        if (aborted) break;

        const crc = uncompSize > 0 ? crc32(data) : 0;
        let compSize = 0;

        if (method === 0) {
          for (let pos = 0; pos < uncompSize && !aborted; pos += READ_BUF_SIZE) {
            const end = Math.min(pos + READ_BUF_SIZE, uncompSize);
            const p = writeChunk(data.subarray(pos, end));
            if (p) await p;
          }
          compSize = uncompSize;
        } else {
          compSize = await writeEntryDeflate(entryZip64, async (deflater, waitDeflaterDrain, isDone) => {
            for (let pos = 0; pos < uncompSize && !isDone(); pos += DEFLATE_CHUNK_SIZE) {
              const end = Math.min(pos + DEFLATE_CHUNK_SIZE, uncompSize);
              if (!deflater.write(data.subarray(pos, end)) && !isDone()) {
                const p = waitDeflaterDrain();
                if (p) await p;
              }
            }
          });
        }
        if (aborted) break;

        const dp = writeChunk(buildDataDescriptor(crc, compSize, uncompSize, entryZip64));
        if (dp) await dp;
        if (aborted) break;

        cdEntries.push({
          nameBuf,
          method,
          dosTime,
          dosDate,
          crc,
          compSize,
          uncompSize,
          localHeaderOffset,
        });
        continue;
      }

      const fh = await open(f.absPath, 'r');
      try {
        const st = await fh.stat();
        const fileSize = st.size;
        const { dosTime, dosDate } = toDosDateTime(f.mtime ?? st.mtime);
        const entryZip64 =
          method === 0 ? fileSize >= ZIP64_LIMIT : fileSize >= DEFLATE_ZIP64_THRESHOLD;

        const lp = writeChunk(buildLocalHeader(nameBuf, method, dosTime, dosDate, entryZip64));
        if (lp) await lp;
        if (aborted) break;

        let crc = 0;
        let uncompSize = 0;
        let compSize = 0;

        if (method === 0) {
          if (fileSize > 0 && fileSize <= SMALL_FILE_LIMIT) {
            const smallBuf = Buffer.allocUnsafe(fileSize);
            let filled = 0;
            while (filled < fileSize && !aborted) {
              const { bytesRead } = await fh.read(smallBuf, filled, fileSize - filled, null);
              if (bytesRead === 0) break;
              filled += bytesRead;
            }
            if (!aborted && filled > 0) {
              const slice = filled === smallBuf.length ? smallBuf : smallBuf.subarray(0, filled);
              crc = crc32(slice);
              uncompSize = filled;
              const p = writeChunk(slice);
              if (p) await p;
            }
          } else if (fileSize > 0) {
            while (!aborted) {
              const buf = await acquireBuf();
              if (!buf || aborted) break;
              let bytesRead = 0;
              try {
                ({ bytesRead } = await fh.read(buf, 0, READ_BUF_SIZE, null));
              } catch (err) {
                releaseBuf(buf);
                throw err;
              }
              if (bytesRead === 0) {
                releaseBuf(buf);
                break;
              }
              const slice = bytesRead === READ_BUF_SIZE ? buf : buf.subarray(0, bytesRead);
              crc = crc32(slice, crc);
              uncompSize += bytesRead;
              const p = writeChunk(slice, buf);
              if (p) await p;
            }
          }
          compSize = uncompSize;
        } else {
          compSize = await writeEntryDeflate(entryZip64, async (deflater, waitDeflaterDrain, isDone) => {
            if (fileSize === 0) return;
            while (!isDone()) {
              const buf = await acquireBuf();
              if (!buf || isDone()) {
                if (buf) releaseBuf(buf);
                break;
              }
              let bytesRead = 0;
              try {
                ({ bytesRead } = await fh.read(buf, 0, READ_BUF_SIZE, null));
              } catch (err) {
                releaseBuf(buf);
                throw err;
              }
              if (bytesRead === 0) {
                releaseBuf(buf);
                break;
              }
              const slice = bytesRead === READ_BUF_SIZE ? buf : buf.subarray(0, bytesRead);
              crc = crc32(slice, crc);
              uncompSize += bytesRead;
              const ok = deflater.write(slice, () => releaseBuf(buf));
              if (!ok && !isDone()) {
                const p = waitDeflaterDrain();
                if (p) await p;
              }
            }
          });
        }

        if (aborted) break;

        const dp = writeChunk(buildDataDescriptor(crc, compSize, uncompSize, entryZip64));
        if (dp) await dp;
        if (aborted) break;

        cdEntries.push({
          nameBuf,
          method,
          dosTime,
          dosDate,
          crc,
          compSize,
          uncompSize,
          localHeaderOffset,
        });
      } finally {
        await fh.close().catch(() => {});
      }
    }

    if (streamErr) throw streamErr;
    if (aborted) return { bytesWritten: offset, aborted: true };

    const cdOffset = offset;
    let cdSize = 0;
    let batchBuf = Buffer.allocUnsafe(CD_BATCH_SIZE);
    let batchPos = 0;

    for (const e of cdEntries) {
      const needUncomp64 = e.uncompSize >= ZIP64_LIMIT;
      const needComp64 = e.compSize >= ZIP64_LIMIT;
      const needOffset64 = e.localHeaderOffset >= ZIP64_LIMIT;
      const extraPayloadLen = (needUncomp64 ? 8 : 0) + (needComp64 ? 8 : 0) + (needOffset64 ? 8 : 0);
      const recLen = 46 + e.nameBuf.length + (extraPayloadLen > 0 ? 4 + extraPayloadLen : 0);
      cdSize += recLen;

      if (batchPos + recLen > batchBuf.length) {
        if (batchPos > 0) {
          const p = writeChunk(batchBuf.subarray(0, batchPos));
          if (p) await p;
          if (aborted) break;
          batchBuf = Buffer.allocUnsafe(Math.max(CD_BATCH_SIZE, recLen));
          batchPos = 0;
        } else {
          batchBuf = Buffer.allocUnsafe(recLen);
        }
      }
      batchPos = writeCentralEntry(batchBuf, batchPos, e);
    }

    if (!aborted && batchPos > 0) {
      const p = writeChunk(batchBuf.subarray(0, batchPos));
      if (p) await p;
    }
    if (streamErr) throw streamErr;
    if (aborted) return { bytesWritten: offset, aborted: true };

    const endBuf = buildEndRecords(cdEntries.length, cdSize, cdOffset);
    const ep = writeChunk(endBuf);
    if (ep) await ep;
    if (streamErr) throw streamErr;
    if (aborted) return { bytesWritten: offset, aborted: true };

    completedNormally = true;
    await new Promise((resolve, reject) => {
      const onFinish = () => {
        cleanupEnd();
        resolve();
      };
      const onEndErr = (err) => {
        cleanupEnd();
        reject(err);
      };
      const onEndClose = () => {
        cleanupEnd();
        resolve();
      };
      function cleanupEnd() {
        writable.off('finish', onFinish);
        writable.off('error', onEndErr);
        writable.off('close', onEndClose);
      }
      writable.on('finish', onFinish);
      writable.on('error', onEndErr);
      writable.on('close', onEndClose);
      writable.end();
    });

    if (streamErr) throw streamErr;
    return { bytesWritten: offset, aborted: false };
  } finally {
    writable.off('drain', onDrain);
    writable.off('close', onClose);
    writable.off('error', onError);
    if (!completedNormally) wakeWaiters();
  }
}

/**
 * Measure in-memory ZIP throughput for a given buffer and compression level
 * using the same streaming ZIP engine as HTTP downloads.
 *
 * @param {Buffer|Uint8Array} buf
 * @param {number} [level]
 * @returns {Promise<{ method: string, mbps: number, out_mb: number }>}
 */
export async function benchmarkZipBuffer(buf, level = 0) {
  const start = process.hrtime.bigint();
  let bytes = 0;
  const sink = new Writable({
    highWaterMark: 4 * 1024 * 1024,
    write(chunk, _encoding, cb) {
      bytes += chunk.length;
      cb();
    },
  });
  await streamZipFiles([{ path: 'bench.bin', data: buf }], sink, { level });
  const secs = Number(process.hrtime.bigint() - start) / 1e9;
  const inputMb = buf.length / 1048576;
  return {
    method: level === 0 ? 'store' : `deflate-${level}`,
    mbps: Math.round((inputMb / secs) * 10) / 10,
    out_mb: Math.round((bytes / 1048576) * 10) / 10,
  };
}
