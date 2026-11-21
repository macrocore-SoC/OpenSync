import { api, fmtDateTime } from './api.js';
import { confirmDialog, h } from './ui.js';
import { renderAuth } from './views/auth.js';
import { renderProfile } from './views/profile.js';
import { renderLibrary } from './views/library.js';
import { renderGame, renderSyncBar, syncProgress } from './views/game.js';
import { renderUpload, renderUploadBar, uploadProgress } from './views/upload.js';
import { renderAdmin } from './views/admin.js';

const state = {
  user: null,
};

const routes = [
  { match: () => location.hash === '#/login', view: 'login', render: renderAuth },
  { match: () => location.hash === '' || location.hash === '#/' || location.hash === '#/library', view: 'library', render: renderLibrary },
  { match: () => location.hash.startsWith('#/game/'), view: 'game', render: renderGame },
  { match: () => location.hash === '#/upload', view: 'upload', render: renderUpload },
  { match: () => location.hash === '#/profile', view: 'profile', render: renderProfile },
  { match: () => location.hash === '#/admin', view: 'admin', render: renderAdmin },
  { match: () => true, view: 'library', render: renderLibrary },
];

const topbar = document.getElementById('topbar');
const viewEl = document.getElementById('view');

let renderSeq = 0;
export function currentRenderSeq() {
  return renderSeq;
}

const BELL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

let notifTimer = null;
let notifDismissCleanup = null;

async function refreshNotifBadge(badge) {
  if (!badge) return;
  try {
    const { unread } = await api.notifications.list();
    badge.hidden = !unread;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  } catch {
    /* ignore */
  }
}

export function startNotifPolling() {
  clearInterval(notifTimer);
  notifTimer = setInterval(() => {
    const badge = document.querySelector('.notif-badge');
    if (badge) refreshNotifBadge(badge);
  }, 30000);
}

export function stopNotifPolling() {
  clearInterval(notifTimer);
  notifTimer = null;
}

function closeNotifDropdown(bell) {
  if (notifDismissCleanup) {
    notifDismissCleanup();
    notifDismissCleanup = null;
  }
  const drop = bell?.querySelector('.notif-drop') || document.querySelector('.notif-drop');
  if (!drop) return;
  drop.classList.add('notif-out');
  setTimeout(() => drop.remove(), 140);
}

async function populateNotifDropdown(bell, drop) {
  let items;
  try {
    items = await api.notifications.list();
  } catch {
    items = { notifications: [], unread: 0 };
  }
  const badge = bell.querySelector('.notif-badge');
  if (badge) {
    badge.hidden = !items.unread;
    badge.textContent = items.unread > 99 ? '99+' : String(items.unread);
  }

  const head = h('div', { class: 'notif-head flex-between' }, [
    h('span', { class: 'small bold', text: 'notifications' }),
    h('div', { class: 'flex', style: 'gap:6px;' }, [
      items.unread
        ? h('button', {
            type: 'button',
            class: 'btn btn-sm btn-ghost',
            text: 'mark all read',
            onclick: async () => {
              await api.notifications.markAllRead();
              await populateNotifDropdown(bell, drop);
            },
          })
        : null,
      items.notifications.length
        ? h('button', {
            type: 'button',
            class: 'btn btn-sm btn-ghost',
            text: 'clear',
            onclick: async () => {
              await api.notifications.clearAll();
              await populateNotifDropdown(bell, drop);
            },
          })
        : null,
    ]),
  ]);

  const listEl = h('div', { class: 'notif-list' });
  if (!items.notifications.length) {
    listEl.append(h('p', { class: 'faint small', style: 'padding:14px;margin:0;', text: 'no notifications yet.' }));
  }
  for (const n of items.notifications) {
    const item = h('a', {
      class: `notif-item ${n.read_at ? '' : 'notif-unread'}`,
      href: n.link || '#/',
      onclick: async () => {
        if (!n.read_at) await api.notifications.markRead(n.id);
        closeNotifDropdown(bell);
        refreshNotifBadge(bell.querySelector('.notif-badge'));
      },
    }, [
      h('div', { class: 'notif-title', text: n.title }),
      n.body ? h('div', { class: 'notif-body', text: n.body }) : null,
      h('div', { class: 'notif-meta', text: fmtDateTime(n.created_at) }),
    ]);
    listEl.append(item);
  }
  drop.replaceChildren(head, listEl);
}

async function toggleNotifDropdown(bell) {
  const btn = bell.querySelector('.bell-btn');
  btn.classList.remove('bell-ring');
  void btn.offsetWidth;
  btn.classList.add('bell-ring');

  if (bell.querySelector('.notif-drop')) {
    closeNotifDropdown(bell);
    return;
  }

  const drop = h('div', { class: 'notif-drop panel' }, [
    h('div', { class: 'muted small flex', style: 'gap:8px;padding:14px;' }, [
      h('span', { class: 'spinner' }),
      h('span', { text: 'loading…' }),
    ]),
  ]);
  bell.append(drop);

  const onDocClick = (e) => {
    if (!bell.contains(e.target)) closeNotifDropdown(bell);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeNotifDropdown(bell);
  };
  setTimeout(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
  }, 0);
  notifDismissCleanup = () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeyDown);
  };

  await populateNotifDropdown(bell, drop);
}

function renderBell() {
  const bell = h('div', { class: 'bell' }, [
    h('button', {
      type: 'button',
      class: 'bell-btn',
      'aria-label': 'Notifications',
      title: 'Notifications',
      html: BELL_SVG,
      onclick: () => toggleNotifDropdown(bell),
    }),
    h('span', { class: 'notif-badge', hidden: true, text: '0' }),
  ]);
  refreshNotifBadge(bell.querySelector('.notif-badge'));
  return bell;
}

function renderTopbar() {
  if (!state.user || state.view === 'login') {
    topbar.hidden = true;
    topbar.style.display = 'none';
    return;
  }
  topbar.hidden = false;
  topbar.style.display = '';
  topbar.replaceChildren(
    h('a', { class: 'logo', href: '#/', title: 'OpenSync' }, [h('img', { src: '/img/opensync.png', alt: 'OpenSync' })]),
    h('nav', { class: 'nav' }, [
      h('a', { href: '#/', class: state.view === 'library' ? 'active' : '', text: 'library' }),
      h('a', { href: '#/upload', class: state.view === 'upload' ? 'active' : '', text: 'upload' }),
      state.user.role === 'admin' ? h('a', { href: '#/admin', class: state.view === 'admin' ? 'active' : '', text: 'admin' }) : null,
    ]),
    h('div', { class: 'topbar-user' }, [
      renderBell(),
      h('a', {
        href: '#/profile',
        title: 'Profile',
        class: `topbar-profile-link ${state.view === 'profile' ? 'active' : ''}`,
      }, [
        state.user.pfp ? h('img', { class: 'topbar-pfp', src: state.user.pfp, alt: '' }) : null,
        h('span', { text: state.user.username }),
        state.user.role === 'admin' ? h('span', { class: 'badge badge-admin', text: 'admin' }) : null,
      ]),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'logout', onclick: () => onLogout() }),
    ]),
  );
}

async function onLogout() {
  const ok = await confirmDialog('logout', 'Sign out of this session?');
  if (!ok) return;
  try {
    await api.auth.logout();
  } catch {
    /* ignore */
  }
  stopNotifPolling();
  state.user = null;
  navigate('#/login');
}

export function syncGlobalBarVisibility() {
  const bar = document.getElementById('uploadbar');
  if (!bar) return;
  renderUploadBar(bar);
  renderSyncBar(bar);
  const up = uploadProgress();
  const sy = syncProgress();
  const showUp = Boolean(up && location.hash !== '#/upload');
  const showSy = Boolean(sy && location.hash !== `#/game/${sy.gameId}`);
  bar.hidden = !(showUp || showSy);
}

function route() {
  const found = routes.find((r) => r.match());
  ++renderSeq;
  state.view = found.view;
  if (notifDismissCleanup) {
    notifDismissCleanup();
    notifDismissCleanup = null;
  }
  document.querySelector('.notif-drop')?.remove();
  viewEl.replaceChildren(
    h('div', { class: 'muted small flex', style: 'gap:8px;padding:24px 0;' }, [
      h('span', { class: 'spinner' }),
      h('span', { text: 'loading…' }),
    ]),
  );
  renderTopbar();
  syncGlobalBarVisibility();
  viewEl.classList.remove('view-switch');
  void viewEl.offsetWidth;
  viewEl.classList.add('view-switch');
  found
    .render(viewEl, state)
    .catch((err) => {
      viewEl.replaceChildren(
        h('div', { class: 'panel' }, [
          h('h2', { text: 'error' }),
          h('pre', { class: 'codebox', text: err.message || String(err) }),
        ]),
      );
    });
}

export function navigate(hash) {
  if (location.hash !== hash) location.hash = hash;
  else route();
}

window.addEventListener('hashchange', route);

async function init() {
  try {
    const { user } = await api.auth.me();
    state.user = user;
  } catch {
    state.user = null;
  }
  if (!state.user && location.hash !== '#/login') {
    location.hash = '#/login';
  }
  route();
  if (state.user) startNotifPolling();
}

window.addEventListener('DOMContentLoaded', init);

export { state };
