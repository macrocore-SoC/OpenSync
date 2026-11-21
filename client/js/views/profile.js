import { api, fmtDate } from '../api.js';
import { confirmDialog, h, toast } from '../ui.js';
import { currentRenderSeq, navigate, stopNotifPolling } from '../app.js';

export async function renderProfile(el, state) {
  const seq = currentRenderSeq();
  const refresh = async () => {
    const { user } = await api.auth.me();
    Object.assign(state.user, user);
  };
  await refresh();
  if (currentRenderSeq() !== seq) return;

  const header = h('div', { class: 'hero' }, [
    h('h1', { class: 'page-title' }, 'profile'),
  ]);

  const pfp = state.user.pfp
    ? h('img', { class: 'pfp-lg', src: state.user.pfp, alt: '' })
    : h('span', { class: 'pfp-lg', text: state.user.username.slice(0, 2).toUpperCase() });
  const userCard = h('div', { class: 'panel flex', style: 'gap:20px;align-items:center;' }, [
    h('div', { class: 'flex', style: 'align-items:center;gap:16px;flex:1;' }, [
      pfp,
      h('div', { style: 'flex:1;' }, [
        h('h2', { style: 'margin-bottom:6px;', text: `@${state.user.username}` }),
        h('div', { class: 'flex', style: 'gap:10px;' }, [
          state.user.role === 'admin' ? h('span', { class: 'badge badge-admin', text: 'admin' }) : null,
          h('span', { class: 'faint small', text: `member since ${fmtDate(state.user.created_at)}` }),
        ]),
      ]),
    ]),
  ]);

  const stats = state.user.stats || {};
  const statGrid = h('div', { class: 'profile-stats' }, [
    statItem(stats.uploaded, 'Games uploaded'),
    statItem(stats.downloaded, 'Games downloaded'),
    statItem(stats.synced, 'Saves synced'),
  ]);

  const statsPanel = h('div', { class: 'panel' }, [
    h('h3', { text: 'Activity' }),
    statGrid,
  ]);

  const pfpInput = h('input', { type: 'file', accept: 'image/jpeg,image/png', style: 'display:none' });
  const pfpZoneText = h('p', {
    class: 'muted small',
    style: 'margin:0;',
    text: 'Choose or drop a JPG or PNG image to update your avatar.',
  });
  const pfpDropzone = h('div', {
    class: 'pfp-dropzone',
    role: 'button',
    tabIndex: 0,
    onclick: () => {
      if (!busy) pfpInput.click();
    },
    onkeydown: (e) => {
      if (!busy && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        pfpInput.click();
      }
    },
  }, [pfpZoneText, pfpInput]);

  const pfpErr = h('div', { class: 'form-error', role: 'alert' });
  const removeBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost btn-sm',
    text: 'remove profile picture',
    hidden: state.user.pfp === '/img/blankpfp.jpg',
    onclick: removePfp,
  });
  const pfpPanel = h('div', { class: 'panel', id: 'pfp-panel' }, [
    h('h3', { text: 'profile picture' }),
    pfpDropzone,
    state.user.pfp !== '/img/blankpfp.jpg' ? h('div', { class: 'flex', style: 'margin-top:10px;' }, [removeBtn]) : null,
    pfpErr,
  ]);

  let busy = false;
  async function uploadPfpFile(file) {
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      pfpErr.textContent = 'profile picture must be jpg or png';
      return;
    }
    busy = true;
    pfpErr.textContent = '';
    pfpDropzone.classList.add('is-busy');
    pfpZoneText.replaceChildren(h('span', { class: 'spinner', style: 'margin-right:8px;' }), 'uploading…');
    try {
      await api.auth.uploadPfp(file);
      toast('profile picture saved');
      await refresh();
      navigate('#/profile');
    } catch (err) {
      pfpErr.textContent = err.message;
      pfpDropzone.classList.remove('is-busy');
      pfpZoneText.textContent = 'Choose or drop a JPG or PNG image to update your avatar.';
    } finally {
      busy = false;
    }
  }

  async function removePfp() {
    pfpErr.textContent = '';
    removeBtn.disabled = true;
    try {
      await api.auth.removePfp();
      toast('profile picture removed');
      await refresh();
      navigate('#/profile');
    } catch (err) {
      pfpErr.textContent = err.message;
      removeBtn.disabled = false;
    }
  }

  pfpInput.addEventListener('change', () => {
    const file = pfpInput.files[0];
    if (file && !busy) uploadPfpFile(file);
  });

  let dragDepth = 0;
  pfpPanel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    pfpPanel.classList.add('drag-over');
  });
  pfpPanel.addEventListener('dragover', (e) => e.preventDefault());
  pfpPanel.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) pfpPanel.classList.remove('drag-over');
  });
  pfpPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    pfpPanel.classList.remove('drag-over');
    const file = [...(e.dataTransfer?.files || [])].find((f) => /^image\/(jpeg|png)$/.test(f.type));
    if (file && !busy) uploadPfpFile(file);
    else if (!file) pfpErr.textContent = 'profile picture must be jpg or png';
  });

  const dangerErr = h('div', { class: 'form-error', role: 'alert' });
  const dangerBtn = h('button', { type: 'button', class: 'btn btn-danger', text: 'delete account' });
  const dangerZone = h('div', { class: 'danger-zone' }, [
    h('h3', { text: 'danger zone' }),
    h('p', {
      class: 'muted small',
      text: 'permanently removes your account and save syncs. games you uploaded stay on the server.',
    }),
    h('div', { class: 'flex' }, [dangerBtn]),
    dangerErr,
  ]);

  dangerBtn.onclick = async () => {
    const ok = await confirmDialog(
      'delete account',
      'This permanently deletes your account and your save syncs. Games you uploaded stay on the server. Continue?',
      { danger: true, confirmText: 'Delete account' },
    );
    if (!ok) return;
    try {
      await api.auth.deleteAccount();
      stopNotifPolling();
      toast('account deleted');
      state.user = null;
      navigate('#/login');
    } catch (e) {
      dangerErr.textContent = e.message;
    }
  };

  el.replaceChildren(header, userCard, statsPanel, pfpPanel, dangerZone);
}

function statItem(num, label) {
  return h('div', { class: 'profile-stat' }, [
    h('div', { class: 'num', text: String(num ?? 0) }),
    h('div', { class: 'label', text: label }),
  ]);
}
