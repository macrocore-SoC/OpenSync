import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import os from 'node:os';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';

const MAX_WORKERS = Math.min(8, Math.max(2, os.cpus().length));
const IDLE_TIMEOUT_MS = 5000;
const WORKER_URL = new URL(import.meta.url);
const BUF_SIZE = 1024 * 1024;

const workers = [];
const queue = [];
let nextTaskId = 1;
let activeCount = 0;
let idleTimer = null;
let exitHookRegistered = false;

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleCleanup() {
  clearIdleTimer();
  if (activeCount === 0 && queue.length === 0 && workers.length > 0) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (activeCount === 0 && queue.length === 0) {
        terminateHashPool();
      }
    }, IDLE_TIMEOUT_MS);
    idleTimer.unref();
  }
}

export function terminateHashPool() {
  clearIdleTimer();
  while (workers.length > 0) {
    const entry = workers.pop();
    if (entry.currentTask) {
      const task = entry.currentTask;
      entry.currentTask = null;
      activeCount = Math.max(0, activeCount - 1);
      task.reject(new Error('hash worker pool terminated'));
    }
    entry.worker.terminate().catch(() => {});
  }
}

function removeWorker(entry) {
  const idx = workers.indexOf(entry);
  if (idx !== -1) workers.splice(idx, 1);
}

function dispatchToWorker(entry, task) {
  entry.busy = true;
  entry.currentTask = task;
  activeCount += 1;
  entry.worker.ref();
  entry.worker.postMessage({ id: task.id, absPath: task.absPath });
}

function spawnWorker() {
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once('beforeExit', () => {
      if (activeCount === 0 && queue.length === 0) {
        terminateHashPool();
      }
    });
  }

  const worker = new Worker(WORKER_URL, { execArgv: [] });
  worker.unref();
  const entry = { worker, busy: false, currentTask: null };

  worker.on('message', (msg) => {
    const task = entry.currentTask;
    entry.currentTask = null;
    entry.busy = false;
    activeCount = Math.max(0, activeCount - 1);

    if (task && msg.id === task.id) {
      if (msg.error) {
        const err = new Error(msg.error);
        if (msg.code) err.code = msg.code;
        task.reject(err);
      } else {
        task.resolve({ hash: msg.hash, size: msg.size, mtimeMs: msg.mtimeMs });
      }
    }

    if (queue.length > 0) {
      dispatchToWorker(entry, queue.shift());
    } else {
      worker.unref();
      scheduleIdleCleanup();
    }
  });

  worker.on('error', (err) => {
    const task = entry.currentTask;
    entry.currentTask = null;
    if (entry.busy) {
      entry.busy = false;
      activeCount = Math.max(0, activeCount - 1);
    }
    removeWorker(entry);
    if (task) task.reject(err);
    pumpQueue();
  });

  worker.on('exit', (code) => {
    const task = entry.currentTask;
    entry.currentTask = null;
    if (entry.busy) {
      entry.busy = false;
      activeCount = Math.max(0, activeCount - 1);
    }
    removeWorker(entry);
    if (task) {
      task.reject(new Error(`hash worker exited unexpectedly with code ${code}`));
    }
    if (queue.length > 0) {
      pumpQueue();
    } else {
      scheduleIdleCleanup();
    }
  });

  workers.push(entry);
  return entry;
}

function pumpQueue() {
  while (queue.length > 0) {
    let idle = workers.find((w) => !w.busy);
    if (!idle) {
      if (workers.length < MAX_WORKERS) {
        idle = spawnWorker();
      } else {
        break;
      }
    }
    dispatchToWorker(idle, queue.shift());
  }
}

/**
 * Hash a single file on the worker pool. Returns `{ hash, size, mtimeMs }`.
 */
export function hashFile(absPath) {
  clearIdleTimer();
  return new Promise((resolve, reject) => {
    queue.push({ id: nextTaskId++, absPath, resolve, reject });
    pumpQueue();
  });
}

/**
 * Hash multiple files in parallel across the worker pool, preserving input order.
 * Optional `onItemDone(index, result)` fires as each file finishes.
 */
export async function hashFiles(absPaths, onItemDone) {
  if (absPaths.length === 0) return [];
  const results = new Array(absPaths.length);
  await Promise.all(
    absPaths.map((absPath, idx) =>
      hashFile(absPath).then((res) => {
        results[idx] = res;
        if (onItemDone) onItemDone(idx, res);
      }),
    ),
  );
  return results;
}

if (!isMainThread && parentPort) {
  const buf = Buffer.allocUnsafe(BUF_SIZE);
  parentPort.on('message', async ({ id, absPath }) => {
    let fh;
    try {
      fh = await open(absPath, 'r');
      const hash = createHash('sha256');
      while (true) {
        const { bytesRead } = await fh.read(buf, 0, BUF_SIZE, null);
        if (bytesRead === 0) break;
        hash.update(bytesRead === BUF_SIZE ? buf : buf.subarray(0, bytesRead));
      }
      const st = await fh.stat();
      parentPort.postMessage({ id, hash: hash.digest('hex'), size: st.size, mtimeMs: st.mtimeMs });
    } catch (err) {
      parentPort.postMessage({ id, error: err?.message || String(err), code: err?.code });
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  });
}
