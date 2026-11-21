import { api, humanSize } from '../api.js';
import { uploadChunks } from '../chunker.js';
import { createReqFields } from '../reqfields.js';
import { h, toast } from '../ui.js';
import { navigate, syncGlobalBarVisibility } from '../app.js';

let session = null;
let viewRoot = null;
let barHost = null;
let pickerEl = null;

export function renderUploadBar(host) {
  barHost = host;
  let sub = host.querySelector(':scope > .ub-upload');
  if (!sub) {
    sub = h('div', { class: 'ub-upload' });
    host.appendChild(sub);
  }
  if (!session || location.hash === '#/upload') {
    sub.hidden = true;
    return;
  }
  sub.hidden = false;
  sub.replaceChildren(
    h('div', { class: 'uploadbar' }, [
      h('div', { class: 'flex uploadbar-head' }, [
        h('a', { class: 'uploadbar-name', href: '#/upload' }),
        h('div', { class: 'uploadbar-right' }, [
          h('span', { class: 'uploadbar-stats' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'cancel', onclick: cancelUpload }),
        ]),
      ]),
      h('div', { class: 'progress' }, [h('div', { class: 'progress-bar' })]),
    ]),
  );
  updateBar();
}

export function uploadProgress() {
  return session
    ? {
        active: true,
        gameId: session.gameId,
        name: session.name,
        total: session.total,
        uploaded: session.uploaded,
        doneCount: session.doneCount,
        files: session.files.length,
      }
    : null;
}

function fmtEta(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${sec % 60}s`;
}

function updateBar() {
  if (!barHost || !session) return;
  const bar = barHost.querySelector('.ub-upload .uploadbar');
  if (!bar) return;
  const pct = session.total > 0 ? Math.round((session.uploaded / session.total) * 100) : 100;
  bar.querySelector('.uploadbar-name').textContent = `uploading "${session.name}"`;
  bar.querySelector('.progress-bar').style.width = `${pct}%`;
  const parts = [`${session.doneCount}/${session.files.length} files`, `${pct}%`, `${humanSize(session.rate)}/s`];
  if (session.eta != null) parts.push(`ETA ${fmtEta(session.eta)}`);
  bar.querySelector('.uploadbar-stats').textContent = parts.join(' · ');
}

async function cancelUpload() {
  if (!session) return;
  session.cancelled = true;
  session.controller.abort();
  const gid = session.gameId;
  try {
    await api.games.remove(gid);
  } catch {
    /* ignore */
  }
  toast('upload cancelled');
  resetView();
  if (location.hash === '#/upload') navigate('#/upload');
}

function resetView() {
  viewRoot = null;
  session = null;
  if (pickerEl) {
    pickerEl.remove();
    pickerEl = null;
  }
  syncGlobalBarVisibility();
}

export async function renderUpload(el) {
  if (viewRoot) {
    el.replaceChildren(viewRoot);
    return;
  }
  viewRoot = buildUploadView();
  el.replaceChildren(viewRoot);
}

function inferNameFromFiles(list) {
  const first = list[0]?.webkitRelativePath || '';
  const seg = first.split('/')[0];
  if (!seg || seg === first) return '';
  return seg.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildUploadView() {
  let files = [];
  let coverFile = null;

  const picker = h('input', { type: 'file', style: 'display:none' });
  picker.webkitdirectory = true;
  picker.directory = true;
  pickerEl = picker;
  document.body.appendChild(picker);

  const nameInput = h('input', {
    id: 'up-name',
    type: 'text',
    name: 'name',
    placeholder: 'e.g. Cyber Runner 2077',
  });
  const nameField = h('div', { class: 'field' }, [
    h('label', { htmlFor: 'up-name', text: 'name *' }),
    nameInput,
  ]);

  const coverInput = h('input', { type: 'file', accept: 'image/jpeg,image/png', style: 'display:none' });
  const coverImg = h('img', { class: 'cover-preview', alt: '', hidden: true });
  const coverLabelText = h('span', { class: 'muted small', text: 'click to choose or drop jpg/png' });
  const coverRemoveBtn = h('button', {
    type: 'button',
    class: 'btn btn-sm btn-ghost',
    text: 'remove',
    hidden: true,
    onclick: (e) => {
      e.stopPropagation();
      setCoverFile(null);
    },
  });
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
  }, [coverImg, coverLabelText, coverRemoveBtn, coverInput]);

  function setCoverFile(file) {
    coverFile = file || null;
    coverRemoveBtn.hidden = !coverFile;
    if (coverFile) {
      const url = URL.createObjectURL(coverFile);
      coverImg.onload = () => URL.revokeObjectURL(url);
      coverImg.src = url;
      coverImg.hidden = false;
      coverLabelText.textContent = coverFile.name;
    } else {
      coverImg.hidden = true;
      coverImg.removeAttribute('src');
      coverInput.value = '';
      coverLabelText.textContent = 'click to choose or drop jpg/png';
    }
    syncFormControls();
  }

  coverInput.addEventListener('change', () => setCoverFile(coverInput.files[0] || null));

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
    const file = [...(e.dataTransfer?.files || [])].find((f) => /^image\/(jpeg|png)$/.test(f.type));
    if (file) setCoverFile(file);
    else toast('cover image must be jpg or png', 'warn');
  });

  const coverField = h('div', { class: 'field' }, [
    h('label', { text: 'cover image (optional)' }),
    coverPicker,
  ]);

  const descInput = h('textarea', {
    id: 'up-desc',
    placeholder: 'short bio, controls, or install notes…',
  });
  const descField = h('div', { class: 'field' }, [
    h('label', { htmlFor: 'up-desc', text: 'description (optional)' }),
    descInput,
  ]);

  const reqs = createReqFields();
  reqs.wrap.querySelector('label')?.remove();
  const reqDetails = h('details', { class: 'req-details' }, [
    h('summary', { text: 'system requirements (optional)' }),
    h('div', { class: 'req-details-body' }, [reqs.wrap]),
  ]);

  const folderEmpty = h('div', { class: 'folder-dropzone-empty' }, [
    h('div', { class: 'folder-dropzone-title', text: 'drop your game folder here, or click to browse' }),
    h('div', { class: 'faint small', text: 'folder structure is preserved · chunked resumable upload' }),
  ]);
  const folderSummaryText = h('span', { class: 'folder-summary-text' });
  const previewList = h('div', { class: 'upload-preview-list' });
  const folderSelected = h('div', { class: 'folder-selected', hidden: true }, [
    h('div', { class: 'folder-summary flex-between' }, [
      folderSummaryText,
      h('div', { class: 'flex', style: 'gap:8px;' }, [
        h('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: 'change folder',
          onclick: (e) => {
            e.stopPropagation();
            openFolderPicker();
          },
        }),
        h('button', {
          type: 'button',
          class: 'btn btn-sm btn-ghost',
          text: 'clear',
          onclick: (e) => {
            e.stopPropagation();
            setFiles([]);
          },
        }),
      ]),
    ]),
    previewList,
  ]);

  const folderZone = h('div', {
    class: 'folder-dropzone',
    role: 'button',
    tabIndex: 0,
    onclick: () => {
      if (!files.length) openFolderPicker();
    },
    onkeydown: (e) => {
      if (!files.length && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openFolderPicker();
      }
    },
  }, [folderEmpty, folderSelected]);

  let folderDragDepth = 0;
  folderZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    folderDragDepth += 1;
    folderZone.classList.add('drag-over');
  });
  folderZone.addEventListener('dragover', (e) => e.preventDefault());
  folderZone.addEventListener('dragleave', () => {
    folderDragDepth = Math.max(0, folderDragDepth - 1);
    if (folderDragDepth === 0) folderZone.classList.remove('drag-over');
  });
  folderZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    folderDragDepth = 0;
    folderZone.classList.remove('drag-over');
    const dropped = await droppedFiles(e.dataTransfer);
    if (dropped.length) setFiles(dropped);
  });

  const startBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'start upload', disabled: true });
  const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost', text: 'clear form', hidden: true, onclick: clearForm });
  const readinessHint = h('span', { class: 'faint small', text: 'select a folder and enter a name to start' });
  const err = h('div', { class: 'form-error', role: 'alert' });

  const formPanel = h('div', { class: 'panel' }, [
    folderZone,
    h('div', { class: 'upload-meta-row' }, [nameField, coverField]),
    descField,
    reqDetails,
    h('div', { class: 'upload-actions flex-between' }, [
      h('div', { class: 'flex', style: 'gap:10px;flex-wrap:wrap;' }, [startBtn, clearBtn]),
      readinessHint,
    ]),
    err,
  ]);

  const headerName = h('span', { class: 'small muted' });
  const overallWrap = h('div', { class: 'progress', style: 'margin-bottom:8px;' });
  const stats = h('div', { class: 'stats-line', text: '0 / 0 files' });
  const rowsWrap = h('div', { class: 'upload-list' });
  const progressPanel = h('div', { class: 'panel', hidden: true }, [
    h('div', { class: 'flex-between', style: 'margin-bottom:10px;' }, [
      h('div', { class: 'flex', style: 'gap:10px;' }, [
        h('h3', { style: 'margin:0;', text: 'uploading' }),
        headerName,
      ]),
      h('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'cancel upload', onclick: cancelUpload }),
    ]),
    overallWrap,
    stats,
    rowsWrap,
  ]);

  const root = h('div', {}, [
    h('h1', { class: 'page-title' }, 'upload a game'),
    formPanel,
    progressPanel,
  ]);

  function openFolderPicker() {
    if (!picker.isConnected) document.body.appendChild(picker);
    picker.value = '';
    picker.click();
  }

  function hasAnyInput() {
    return Boolean(files.length || nameInput.value.trim() || descInput.value.trim() || coverFile || reqs.read());
  }

  function syncFormControls() {
    const hasFiles = files.length > 0;
    const hasName = Boolean(nameInput.value.trim());
    startBtn.disabled = !(hasFiles && hasName);
    clearBtn.hidden = !hasAnyInput();
    if (!hasFiles && !hasName) readinessHint.textContent = 'select a folder and enter a name to start';
    else if (!hasFiles) readinessHint.textContent = 'select a game folder to start';
    else if (!hasName) readinessHint.textContent = 'enter a game name to start';
    else readinessHint.textContent = `${files.length} files ready (${humanSize(files.reduce((s, f) => s + f.size, 0))})`;
  }

  nameInput.addEventListener('input', syncFormControls);
  descInput.addEventListener('input', syncFormControls);
  reqs.wrap.addEventListener('input', syncFormControls);

  function setFiles(list) {
    files = list.filter((f) => f.webkitRelativePath);
    files.sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
    folderEmpty.hidden = files.length > 0;
    folderSelected.hidden = !files.length;
    folderZone.classList.toggle('has-files', files.length > 0);

    if (files.length) {
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      folderSummaryText.textContent = `${files.length} files · ${humanSize(totalBytes)}`;
      const previewItems = files.slice(0, 50).map((f) =>
        h('div', { class: 'upload-row-name small faint', text: f.webkitRelativePath }),
      );
      if (files.length > 50) {
        previewItems.push(h('div', { class: 'small muted', style: 'margin-top:4px;', text: `+ ${files.length - 50} more files` }));
      }
      previewList.replaceChildren(...previewItems);

      if (!nameInput.value.trim()) {
        const inferred = inferNameFromFiles(files);
        if (inferred) nameInput.value = inferred;
      }
    } else {
      previewList.replaceChildren();
    }
    syncFormControls();
  }

  function clearForm() {
    setFiles([]);
    nameInput.value = '';
    descInput.value = '';
    reqs.fill('');
    setCoverFile(null);
    err.textContent = '';
    syncFormControls();
    toast('form cleared');
  }

  picker.onchange = () => setFiles([...picker.files]);

  startBtn.onclick = async () => {
    err.textContent = '';
    if (!files.length) {
      err.textContent = 'select a folder first';
      return;
    }
    const nameVal = nameInput.value.trim();
    if (!nameVal) {
      err.textContent = 'name is required';
      nameInput.focus();
      return;
    }

    startBtn.disabled = true;
    let createdGame = null;
    try {
      const { game } = await api.games.create({
        name: nameVal,
        description: descInput.value,
        system_requirements: reqs.read(),
      });
      createdGame = game;
      if (coverFile) await api.games.cover(game.id, coverFile);
      await runUpload(game, files, nameVal);
      toast('upload complete — generating manifest');
      resetView();
      navigate(`#/game/${game.id}`);
    } catch (e) {
      if (e?.name === 'AbortError' || session?.cancelled) return;
      if (createdGame) {
        try {
          await api.games.remove(createdGame.id);
        } catch {
          /* ignore */
        }
      }
      session = null;
      syncGlobalBarVisibility();
      progressPanel.hidden = true;
      formPanel.hidden = false;
      err.textContent = e.message || 'upload failed';
      syncFormControls();
    }
  };

  async function runUpload(game, fileList, nameVal) {
    const initState = await api.games.uploadInit(game.id);
    const resume = new Map(initState.files.map((f) => [f.path, f.received]));
    const chunkSize = initState.chunkSize;

    const controller = new AbortController();
    let cancelled = false;
    const total = fileList.reduce((s, f) => s + f.size, 0);
    session = {
      gameId: game.id,
      name: nameVal,
      files: fileList,
      total,
      uploaded: 0,
      doneCount: 0,
      rate: 0,
      eta: null,
      controller,
      cancelled: false,
    };
    syncGlobalBarVisibility();

    formPanel.hidden = true;
    progressPanel.hidden = false;
    headerName.textContent = `"${nameVal}"`;
    const overallBar = h('div', { class: 'progress-bar', style: 'width:0%;' });
    overallWrap.replaceChildren(overallBar);
    stats.textContent = `0 / ${fileList.length} files`;
    const rows = new Map();
    rowsWrap.replaceChildren(...fileList.map((f) => rowEl(f)));

    let uploaded = 0;
    let prevUploaded = 0;
    let prevTime = performance.now();
    const samples = [];
    let doneCount = 0;

    function rowEl(f) {
      const nameEl = h('div', { class: 'upload-row-name', text: f.webkitRelativePath });
      const pct = h('span', { class: 'faint', text: '0%' });
      const bar = h('div', { class: 'progress-bar', style: 'width:0%;' });
      const wrap = h('div', { class: 'progress' }, [bar]);
      const row = h('div', { class: 'upload-row' }, [h('div', { class: 'upload-row-head' }, [nameEl, pct]), wrap]);
      rows.set(f.webkitRelativePath, { bar, pct, file: f, prev: 0 });
      return row;
    }

    function updateOverall() {
      const pct = total > 0 ? Math.round((uploaded / total) * 100) : 100;
      overallBar.style.width = `${pct}%`;

      const now = performance.now();
      const dt = now - prevTime;
      prevTime = now;
      if (dt > 0) {
        samples.push({ bytes: uploaded - prevUploaded, dt });
        prevUploaded = uploaded;
        if (samples.length > 120) samples.shift();
      }
      const win = samples.reduce((a, s) => ({ bytes: a.bytes + s.bytes, dt: a.dt + s.dt }), { bytes: 0, dt: 0 });
      const rate = win.dt > 0 ? (win.bytes / win.dt) * 1000 : 0;
      const remain = Math.max(0, total - uploaded);
      const eta = rate > 0 ? Math.round(remain / rate) : null;

      stats.textContent =
        `${doneCount} / ${fileList.length} files · ${humanSize(uploaded)} / ${humanSize(total)}` +
        ` · ${humanSize(rate)}/s${eta != null ? ` · ETA ${fmtEta(eta)}` : ''}`;

      if (session) {
        session.uploaded = uploaded;
        session.doneCount = doneCount;
        session.rate = rate;
        session.eta = eta;
        updateBar();
      }
    }

    const CONCURRENCY = 3;
    let idx = 0;
    async function worker() {
      while (idx < fileList.length) {
        if (cancelled || session?.cancelled) return;
        const f = fileList[idx++];
        const r = rows.get(f.webkitRelativePath);
        const totalChunks = Math.max(1, Math.ceil(f.size / chunkSize));
        const resumeFrom = Math.min(resume.get(f.webkitRelativePath) || 0, totalChunks);

        if (resumeFrom >= totalChunks) {
          r.bar.style.width = '100%';
          r.pct.textContent = '100%';
          uploaded += f.size;
          doneCount += 1;
          updateOverall();
          continue;
        }

        r.bar.style.width = '4%';
        try {
          await uploadChunks({
            url: `/api/games/${game.id}/files`,
            path: f.webkitRelativePath,
            file: f,
            chunkSize,
            resumeFrom,
            signal: controller.signal,
            onProgress: (bytes, done) => {
              const pct = f.size > 0 ? Math.round((bytes / f.size) * 100) : 100;
              r.bar.style.width = `${pct}%`;
              r.pct.textContent = `${pct}%`;
              uploaded += bytes - r.prev;
              r.prev = bytes;
              if (done === totalChunks) doneCount += 1;
              updateOverall();
            },
          });
          r.bar.style.width = '100%';
          r.pct.textContent = '100%';
        } catch (e) {
          r.pct.textContent = '✕';
          cancelled = true;
          controller.abort();
          throw e;
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (session?.cancelled) throw new DOMException('aborted', 'AbortError');
    overallBar.style.width = '100%';
    doneCount = fileList.length;
    updateOverall();
    await api.games.uploadComplete(game.id);
  }

  return root;
}

/** Walk a DataTransfer (dropped folders/files) into Files with webkitRelativePath set. */
async function droppedFiles(dataTransfer) {
  const files = [];
  if (!dataTransfer) return files;
  const entries = [...dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.() || null)
    .filter(Boolean);
  if (entries.length) {
    async function walkEntry(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (!file) return;
        const rel = prefix ? `${prefix}/${file.name}` : file.name;
        try {
          Object.defineProperty(file, 'webkitRelativePath', { value: rel, configurable: true });
        } catch {
          /* keep the native value */
        }
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
          const sub = prefix ? `${prefix}/${entry.name}` : entry.name;
          for (const child of batch) await walkEntry(child, sub);
        } while (batch.length > 0);
      }
    }
    for (const entry of entries) await walkEntry(entry, '');
  } else {
    for (const f of dataTransfer.files || []) {
      try {
        Object.defineProperty(f, 'webkitRelativePath', { value: f.name, configurable: true });
      } catch {
        /* keep the native value */
      }
      files.push(f);
    }
  }
  return files;
}
