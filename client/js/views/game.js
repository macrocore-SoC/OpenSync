import { api, fmtDate, fmtDateTime, humanSize, pfpUrl } from '../api.js';
import { hashFile } from '../sha256.js';
import { uploadChunks } from '../chunker.js';
import { createReqFields } from '../reqfields.js';
import { confirmDialog, h, toast } from '../ui.js';
import { currentRenderSeq, navigate, state, syncGlobalBarVisibility } from '../app.js';

let syncSession = null;
let syncBarHost = null;

function monogram(name) {
  const words = String(name || 'G').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name || 'G').trim().slice(0, 2).toUpperCase();
}

// Shared placeholder: a cover that fails to load becomes the same monogram
// tile as a game with no cover, so no broken-image icon is ever shown.
function monogramPlaceholder(name) {
  return h('div', { class: 'card-cover-placeholder', 'aria-hidden': 'true' }, [
    h('span', { class: 'card-cover-monogram', text: monogram(name) }),
  ]);
}

function gameCoverPlaceholder(name) {
  return h('div', { class: 'game-cover-lg' }, [monogramPlaceholder(name)]);
}

function endSync() {
  syncSession = null;
  syncGlobalBarVisibility();
}

function updateSyncBar() {
  if (!syncBarHost || !syncSession) return;
  const sub = syncBarHost.querySelector('.ub-sync');
  const bar = sub?.querySelector('.uploadbar');
  if (!sub || !bar) return;
  const s = syncSession;
  const pct =
    s.phase === 'hashing'
      ? Math.round((s.done / Math.max(1, s.files)) * 100)
      : s.total > 0
        ? Math.round((s.uploaded / s.total) * 100)
        : 100;
  bar.querySelector('.progress-bar').style.width = `${pct}%`;
  bar.querySelector('.uploadbar-stats').textContent =
    s.phase === 'hashing'
      ? `Checking ${s.done} of ${s.files} files (${pct}%)`
      : `${s.doneCount} of ${s.files} files (${pct}%), ${humanSize(s.uploaded)} of ${humanSize(s.total)}`;
}

function cancelSync() {
  if (!syncSession) return;
  syncSession.cancelled = true;
  syncSession.controller.abort();
  toast('Sync cancelled');
  endSync();
}

export function syncProgress() {
  return syncSession ? { active: true, gameId: syncSession.gameId, name: syncSession.name } : null;
}

export function renderSyncBar(host) {
  syncBarHost = host;
  let sub = host.querySelector(':scope > .ub-sync');
  if (!sub) {
    sub = h('div', { class: 'ub-sync' });
    host.appendChild(sub);
  }
  if (!syncSession || location.hash === `#/game/${syncSession.gameId}`) {
    sub.hidden = true;
    return;
  }
  sub.hidden = false;
  sub.replaceChildren(
    h('div', { class: 'uploadbar' }, [
      h('div', { class: 'flex uploadbar-head' }, [
        h('a', { class: 'uploadbar-name', href: `#/game/${syncSession.gameId}`, text: `Syncing "${syncSession.name}"` }),
        h('div', { class: 'uploadbar-right' }, [
          h('span', { class: 'uploadbar-stats' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Cancel', onclick: cancelSync }),
        ]),
      ]),
      h('div', { class: 'progress' }, [h('div', { class: 'progress-bar' })]),
    ]),
  );
  updateSyncBar();
}

function openCoverLightbox(src, title) {
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const overlay = h('div', {
    class: 'modal-overlay cover-lightbox',
    onclick: (e) => {
      if (e.target === overlay) close();
    },
  }, [
    h('div', { class: 'cover-lightbox-frame pop-dialog' }, [
      h('img', { src, alt: title }),
      h('button', {
        type: 'button',
        class: 'btn btn-sm cover-lightbox-close',
        text: '✕',
        'aria-label': 'Close cover preview',
        onclick: close,
      }),
    ]),
  ]);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
}

export function showDownloadDialog(game) {
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const overlay = h('div', {
    class: 'modal-overlay',
    onclick: (e) => {
      if (e.target === overlay) close();
    },
  });
  const choice = (label, hint, href, primary) =>
    h('a', {
      class: `dl-choice ${primary ? 'dl-choice-primary' : ''}`,
      href,
      download: `${game.name}.zip`,
      onclick: close,
    }, [
      h('span', { class: 'dl-choice-title', text: label }),
      h('span', { class: 'dl-choice-hint small', text: hint }),
    ]);

  const box = h('div', { class: 'panel pop-dialog modal-box', role: 'dialog', 'aria-modal': 'true' }, [
    h('h3', { text: `Download ${game.name}` }),
    h('p', { class: 'muted small', style: 'margin:0 0 12px;', text: 'Choose which version to download:' }),
    h('div', { class: 'dl-choices' }, [
      choice('Synced copy', 'Includes your saved progress', `/api/games/${game.id}/download`, true),
      choice('Clean install', 'Original archive files only', `/api/games/${game.id}/download?fresh=1`, false),
    ]),
    h('div', { class: 'flex', style: 'justify-content:flex-end;margin-top:14px;' }, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel', onclick: close }),
    ]),
  ]);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
}

export async function renderGame(el) {
  const id = location.hash.split('/')[2];
  const seq = currentRenderSeq();
  const box = h('div', { class: 'muted small flex', style: 'gap:8px;padding:24px 0;' }, [
    h('span', { class: 'spinner' }),
    h('span', { text: 'Loading…' }),
  ]);
  el.replaceChildren(box);

  const { game, overlay } = await api.games.get(id);
  if (currentRenderSeq() !== seq) return;
  const canManage = state.user.role === 'admin' || game.uploaded_by === state.user.id;

  if (game.status === 'processing') {
    renderProcessing(el, game);
    return;
  }

  const openCover = () => openCoverLightbox(game.cover, game.name);
  const onCoverKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openCover();
    }
  };
  const swapCoverToPlaceholder = (frame) => {
    if (!frame || frame.dataset.coverFallback) return;
    frame.dataset.coverFallback = '1';
    frame.classList.remove('has-cover');
    frame.removeAttribute('role');
    frame.removeAttribute('tabindex');
    frame.removeAttribute('title');
    frame.removeEventListener('click', openCover);
    frame.removeEventListener('keydown', onCoverKey);
    frame.replaceChildren(monogramPlaceholder(game.name));
  };

  let coverFrame = null;
  const coverEl = game.cover
    ? (() => {
        const img = h('img', {
          alt: game.name,
          // Handler first, so cached/already-failed images are caught too.
          onerror: () => swapCoverToPlaceholder(coverFrame),
          src: game.cover,
        });
        coverFrame = h('div', {
          class: 'game-cover-lg has-cover',
          role: 'button',
          tabIndex: 0,
          title: 'Click to expand cover',
          onclick: openCover,
          onkeydown: onCoverKey,
        }, [img, h('span', { class: 'cover-expand-hint', text: 'Expand' })]);
        if (img.complete && img.naturalWidth === 0) swapCoverToPlaceholder(coverFrame);
        return coverFrame;
      })()
    : gameCoverPlaceholder(game.name);

  el.replaceChildren(
    h('a', { class: 'btn btn-sm btn-ghost', href: '#/', text: 'Back to library' }),
    h('div', { class: 'game-header', style: 'margin-top:18px;' }, [
      coverEl,
      h('div', { style: 'flex:1;min-width:0;' }, [
        h('div', { class: 'flex-between', style: 'align-items:flex-start;' }, [
          h('h1', { text: game.name }),
          overlay.has_overlay ? h('span', { class: 'badge badge-synced', text: 'Synced' }) : null,
        ]),
        h('dl', { class: 'stat-row' }, [
          h('dt', { text: 'Size' }), h('dd', { text: humanSize(game.total_size) }),
          h('dt', { text: 'Uploaded by' }), h('dd', { class: 'dd-uploader' }, [
            game.uploader_pfp ? h('img', { class: 'uploader-pfp', src: pfpUrl(game.uploader_pfp), alt: '' }) : null,
            h('span', { text: `@${game.uploader_name || 'system'}` }),
          ]),
          h('dt', { text: 'Added' }), h('dd', { text: fmtDate(game.created_at) }),
          h('dt', { text: 'Downloads' }), h('dd', { text: String(game.download_count) }),
        ]),
        h('div', { class: 'game-actions' }, [
          h('a', {
            class: 'btn btn-primary',
            href: `/api/games/${game.id}/download`,
            download: `${game.name}.zip`,
            text: 'Download',
            onclick: (e) => {
              if (overlay.has_overlay) {
                e.preventDefault();
                showDownloadDialog(game);
              }
            },
          }),
          h('button', {
            type: 'button',
            class: 'btn',
            text: overlay.has_overlay ? 'Update save' : 'Sync save',
            onclick: () => startSync(el, game),
          }),
          overlay.has_overlay
            ? h('button', { type: 'button', class: 'btn btn-danger', text: 'Clear saved progress', onclick: () => resetOverlay(game) })
            : null,
          canManage ? h('button', { type: 'button', class: 'btn', text: 'Edit details', onclick: () => renderEdit(el, game) }) : null,
          canManage ? h('button', { type: 'button', class: 'btn btn-danger', text: 'Delete', onclick: () => deleteGame(game) }) : null,
        ]),
      ]),
    ]),
  );

  if (game.description) {
    el.append(
      h('div', { class: 'panel' }, [
        h('h3', { text: 'About' }),
        h('p', { class: 'muted small', style: 'white-space:pre-wrap;margin:0;', text: game.description }),
      ]),
    );
  }
  if (game.system_requirements) {
    el.append(
      h('div', { class: 'panel' }, [
        h('h3', { text: 'System requirements' }),
        h('pre', { class: 'codebox small', style: 'margin:0;', text: game.system_requirements }),
      ]),
    );
  }

  renderOverlayStatus(el, overlay);
}

function renderProcessing(el, game) {
  const title = h('div', { class: 'flex', style: 'justify-content:center;gap:10px;margin-bottom:10px;' }, [
    h('span', { class: 'spinner', style: 'width:18px;height:18px;' }),
    h('h2', { style: 'margin:0;', text: 'Processing manifest…' }),
  ]);
  const sub = h('p', { class: 'muted small', text: `Hashing every file for ${game.name}` });
  const progLabel = h('p', { class: 'muted small', style: 'margin-bottom:8px;' });
  const barWrap = h('div', { class: 'progress', style: 'max-width:420px;margin:0 auto 16px;' });
  const bar = h('div', { class: 'progress-bar', style: 'width:0%;' });
  barWrap.appendChild(bar);
  const link = h('a', { class: 'btn btn-ghost', href: '#/', text: 'Back to library' });

  el.replaceChildren(
    h('div', { class: 'panel', style: 'text-align:center;padding:40px;' }, [title, sub, progLabel, barWrap, link]),
  );

  const poll = async () => {
    if (!location.hash.startsWith(`#/game/${game.id}`)) {
      clearInterval(timer);
      return;
    }
    try {
      const st = await api.games.status(game.id);
      if (st.status === 'ready') {
        clearInterval(timer);
        renderGame(el);
        return;
      }
      const p = st.progress;
      if (p && Number.isInteger(p.total) && p.total > 0) {
        const pct = Math.min(100, Math.round((p.done / p.total) * 100));
        bar.style.width = `${pct}%`;
        progLabel.textContent = `Hashing file ${Math.min(p.done + 1, p.total)} of ${p.total}`;
      } else {
        bar.style.width = '6%';
        progLabel.textContent = 'Walking files…';
      }
    } catch {
      /* transient */
    }
  };
  const timer = setInterval(poll, 1000);
  poll();
}

function renderOverlayStatus(el, overlay) {
  const sec = h('div', { class: 'section-title' }, ['Saved progress']);
  const panel = h('div', { class: 'panel' });
  el.append(sec, panel);
  if (!overlay.has_overlay) {
    panel.append(
      h('p', {
        class: 'muted small',
        style: 'margin:0;',
        text: 'No saved progress stored on this server yet. Select Sync save above to upload changes from your local game folder.',
      }),
    );
    return;
  }
  panel.append(
    h('dl', { class: 'stat-row' }, [
      h('dt', { text: 'Changed files' }), h('dd', { text: String(overlay.files) }),
      h('dt', { text: 'Removed files' }), h('dd', { text: String(overlay.deletions) }),
      h('dt', { text: 'Save size' }), h('dd', { text: humanSize(overlay.size) }),
      h('dt', { text: 'Last synced' }), h('dd', { text: fmtDateTime(overlay.updated_at) }),
    ]),
  );
}

function renderEdit(el, game) {
  const existing = el.querySelector('#edit-game-panel');
  if (existing) {
    existing.remove();
    return;
  }

  let coverFile = null;
  const nameInput = h('input', { type: 'text', value: game.name });
  const name = h('div', { class: 'field' }, [h('label', { text: 'Name' }), nameInput]);
  const descInput = h('textarea', {}, game.description || '');
  const desc = h('div', { class: 'field' }, [h('label', { text: 'Description (optional)' }), descInput]);

  const reqs = createReqFields(game.system_requirements || '');
  reqs.wrap.querySelector('label')?.remove();
  const reqDetails = h('details', { class: 'req-details', open: Boolean(game.system_requirements) }, [
    h('summary', { text: 'System requirements (optional)' }),
    h('div', { class: 'req-details-body' }, [reqs.wrap]),
  ]);

  const coverInput = h('input', { type: 'file', accept: 'image/jpeg,image/png', style: 'display:none' });
  const coverImg = h('img', {
    class: 'cover-preview',
    alt: '',
    src: game.cover || '',
    hidden: !game.cover,
  });
  const coverHint = h('span', { class: 'muted small', text: game.cover ? 'Click or drop to replace cover' : 'Click to choose or drop JPG/PNG' });
  const coverPicker = h('div', {
    class: 'cover-picker',
    role: 'button',
    tabIndex: 0,
    onclick: () => coverInput.click(),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        coverInput.click();
      }
    },
  }, [coverImg, coverHint, coverInput]);

  function setCoverFile(file) {
    coverFile = file || null;
    if (coverFile) {
      const url = URL.createObjectURL(coverFile);
      coverImg.onload = () => URL.revokeObjectURL(url);
      coverImg.src = url;
      coverImg.hidden = false;
      coverHint.textContent = coverFile.name;
    }
  }

  coverInput.addEventListener('change', () => {
    if (coverInput.files[0]) setCoverFile(coverInput.files[0]);
  });
  let coverDragDepth = 0;
  coverPicker.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    coverDragDepth += 1;
    coverPicker.classList.add('drag-over');
  });
  coverPicker.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  coverPicker.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    coverDragDepth = Math.max(0, coverDragDepth - 1);
    if (coverDragDepth === 0) coverPicker.classList.remove('drag-over');
  });
  coverPicker.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    coverDragDepth = 0;
    coverPicker.classList.remove('drag-over');
    const f = [...(e.dataTransfer?.files || [])].find((file) => /^image\/(jpeg|png)$/.test(file.type));
    if (f) setCoverFile(f);
    else toast('Cover image must be JPG or PNG', 'warn');
  });

  const cover = h('div', { class: 'field' }, [h('label', { text: 'Cover image (optional)' }), coverPicker]);
  const save = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Save changes' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        await api.games.patch(game.id, {
          name: nameInput.value,
          description: descInput.value,
          system_requirements: reqs.read(),
        });
        if (coverFile) {
          await api.games.cover(game.id, coverFile);
        }
        toast('Changes saved');
        renderGame(el);
      } catch (ex) {
        err.textContent = ex.message;
        save.disabled = false;
        save.textContent = 'Save changes';
      }
    },
  }, [
    h('div', { class: 'upload-meta-row' }, [name, cover]),
    desc,
    reqDetails,
    h('div', { class: 'flex', style: 'margin-top:14px;' }, [
      save,
      h('button', { type: 'button', class: 'btn btn-ghost', text: 'Cancel', onclick: () => panel.remove() }),
    ]),
    err,
  ]);

  const panel = h('div', { id: 'edit-game-panel', class: 'panel' }, [
    h('h3', { text: 'Edit game' }),
    form,
  ]);

  const anchor = el.querySelector('.game-header');
  anchor.after(panel);
  nameInput.focus();
}

async function deleteGame(game) {
  const ok = await confirmDialog(
    'Delete game',
    `This permanently deletes "${game.name}" and all its files from disk.`,
    { danger: true, confirmText: 'Delete' },
  );
  if (!ok) return;
  await api.games.remove(game.id);
  toast('Game deleted');
  navigate('#/');
}

async function resetOverlay(game) {
  const ok = await confirmDialog(
    'Reset save',
    'Remove your save overlay for this game? Your local files are untouched.',
    { danger: true, confirmText: 'Reset save' },
  );
  if (!ok) return;
  await api.games.clearOverlay(game.id);
  toast('Save overlay reset');
  renderGame(document.getElementById('view'));
}

// ---------- sync ----------

async function startSync(el, game) {
  if (syncSession) {
    toast('A sync is already running', 'warn');
    return;
  }
  const picker = h('input', { type: 'file', style: 'display:none' });
  picker.webkitdirectory = true;
  picker.directory = true;
  document.body.appendChild(picker);
  picker.onchange = () => {
    const files = [...picker.files];
    picker.remove();
    if (!files.length) return;
    runSync(el, game, files).catch((e) => {
      endSync();
      toast(e.message || 'Sync failed', 'error');
    });
  };
  picker.click();
}

async function runSync(el, game, files) {
  el.querySelector('#sync-status-panel')?.remove();
  const statusEl = h('div', { id: 'sync-status-panel', class: 'panel' });
  const p1 = h('p', { class: 'muted small', style: 'margin:0;', text: 'Hashing local files…' });
  const p2 = h('p', { class: 'faint small', style: 'margin:6px 0 0;' });
  const barWrap = h('div', { class: 'progress', style: 'margin:10px 0 0;' });
  const bar = h('div', { class: 'progress-bar', style: 'width:0%;' });
  barWrap.appendChild(bar);
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Cancel', onclick: cancelSync });
  statusEl.append(
    h('div', { class: 'flex-between' }, [p1, cancelBtn]),
    p2,
    barWrap,
  );
  el.querySelector('.game-header').after(statusEl);

  const controller = new AbortController();
  syncSession = {
    gameId: game.id,
    name: game.name,
    controller,
    cancelled: false,
    phase: 'hashing',
    done: 0,
    files: files.length,
    uploaded: 0,
    total: 0,
    doneCount: 0,
  };
  syncGlobalBarVisibility();

  const local = new Map(files.map((f) => [f.webkitRelativePath, f]));
  const manifest = await api.games.manifest(game.id);

  let hashed = 0;
  for (const [relPath, file] of local) {
    if (syncSession?.cancelled) return;
    p2.textContent = `Hashing ${relPath} …`;
    const hash = await hashFile(file);
    local.set(relPath, { file, hash });
    hashed += 1;
    const pct = Math.round((hashed / Math.max(1, local.size)) * 100);
    bar.style.width = `${pct}%`;
    if (syncSession) {
      syncSession.done = hashed;
      updateSyncBar();
    }
  }
  p1.textContent = 'Comparing local files with server';

  const clean = new Map(manifest.files.map((f) => [f.path, f]));
  const uploads = [];
  const deletions = [];

  for (const [relPath, entry] of local) {
    const cleanFile = clean.get(relPath);
    if (!cleanFile) {
      uploads.push({ path: relPath, file: entry.file, hash: entry.hash, kind: 'new' });
    } else if (cleanFile.hash !== entry.hash) {
      uploads.push({ path: relPath, file: entry.file, hash: entry.hash, kind: 'changed' });
    }
  }
  for (const [relPath] of clean) {
    if (!local.has(relPath)) deletions.push(relPath);
  }

  if (deletions.length > 0) {
    const pct = Math.round((deletions.length / Math.max(1, clean.size)) * 100);
    const ok = await confirmDialog(
      'Many files missing',
      `${deletions.length} files (${pct}% of the game) are missing from the folder you selected and will be removed from your download. If you only picked your save folder, cancel and select the full game folder.`,
      { danger: true },
    );
    if (!ok) {
      p1.textContent = 'Sync cancelled';
      endSync();
      return;
    }
  }

  if (!uploads.length && !deletions.length) {
    p1.textContent = 'Already up to date';
    p2.textContent = '';
    cancelBtn.hidden = true;
    bar.style.width = '100%';
    endSync();
    return;
  }

  p1.textContent = `Uploading ${uploads.length} file(s), removing ${deletions.length} path(s)`;
  const initState = await api.games.overlayInit(game.id);
  const resume = new Map(initState.files.map((f) => [f.path, f.received]));
  const chunkSize = initState.chunkSize;

  let uploadedBytes = 0;
  const totalBytes = uploads.reduce((s, u) => s + u.file.size, 0);
  let doneCount = 0;
  if (syncSession) {
    syncSession.phase = 'uploading';
    syncSession.files = uploads.length;
    syncSession.total = totalBytes;
    syncSession.doneCount = doneCount;
    updateSyncBar();
  }

  for (const u of uploads) {
    if (syncSession?.cancelled) return;
    p2.textContent = `${u.kind === 'new' ? '+' : '~'} ${u.path}`;
    const totalChunks = Math.max(1, Math.ceil(u.file.size / chunkSize));
    try {
      await uploadChunks({
        url: `/api/games/${game.id}/overlay/files`,
        path: u.path,
        file: u.file,
        chunkSize,
        resumeFrom: resume.get(u.path) || 0,
        extraHeaders: { 'x-hash': u.hash },
        signal: controller.signal,
        onProgress: (bytes, done) => {
          uploadedBytes += bytes - (u._prevBytes || 0);
          u._prevBytes = bytes;
          bar.style.width = `${Math.round((uploadedBytes / Math.max(1, totalBytes)) * 100)}%`;
          if (done === totalChunks) doneCount += 1;
          if (syncSession) {
            syncSession.uploaded = uploadedBytes;
            syncSession.doneCount = doneCount;
            updateSyncBar();
          }
        },
      });
    } catch (e) {
      if (e.name === 'AbortError' || syncSession?.cancelled) {
        p1.textContent = 'Sync cancelled';
        endSync();
        return;
      }
      endSync();
      if (e.code === 'RESUME_REQUIRED') {
        toast('Upload state changed mid-sync; retry', 'warn');
        return;
      }
      throw e;
    }
  }

  p1.textContent = 'Finalizing sync…';
  bar.style.width = '100%';
  try {
    await api.games.syncComplete(game.id, deletions, true);
  } finally {
    endSync();
  }
  toast(`Save synced (${uploads.length} files, ${humanSize(totalBytes)})`);
  if (location.hash === `#/game/${game.id}`) {
    renderGame(el);
  } else {
    cancelBtn.hidden = true;
    p2.textContent = '';
    p1.textContent = `✓ Synced ${uploads.length} files (${humanSize(totalBytes)}), ${deletions.length} deletions`;
    statusEl.append(
      h('div', { class: 'stats-line' }, [
        h('button', { type: 'button', class: 'btn btn-sm', text: 'Refresh', onclick: () => renderGame(el) }),
      ]),
    );
  }
}
