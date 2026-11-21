import { api, fmtDate, humanSize, pfpUrl } from '../api.js';
import { currentRenderSeq, navigate } from '../app.js';
import { h } from '../ui.js';
import { showDownloadDialog } from './game.js';

function monogram(name) {
  const words = String(name || 'G').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name || 'G').trim().slice(0, 2).toUpperCase();
}

export async function renderLibrary(el) {
  const seq = currentRenderSeq();
  const hero = h('div', { class: 'hero' }, [
    h('h1', { class: 'page-title' }, 'game library'),
    h('p', { class: 'sub small' }, 'offline games, always on the LAN'),
  ]);
  const toolbarHost = h('div', { id: 'lib-toolbar-host' });
  const box = h('div', { id: 'lib' });
  box.replaceChildren(
    h('div', { class: 'muted small flex', style: 'gap:8px;padding:12px 0;' }, [
      h('span', { class: 'spinner' }),
      h('span', { text: 'fetching library…' }),
    ]),
  );
  el.replaceChildren(hero, toolbarHost, box);

  const { games } = await api.games.list();
  if (currentRenderSeq() !== seq) return;
  if (!games.length) {
    box.replaceChildren(
      h('div', { class: 'empty' }, [
        h('p', { text: 'no games on this server yet.' }),
        h('a', { class: 'btn btn-primary', href: '#/upload', text: 'upload the first one' }),
      ]),
    );
    return;
  }

  let query = '';
  let sortBy = 'newest';

  const searchInput = h('input', {
    type: 'text',
    class: 'search-input',
    placeholder: 'filter by name or uploader…',
    'aria-label': 'Filter games',
  });
  const clearBtn = h('button', {
    type: 'button',
    class: 'search-clear',
    text: '×',
    'aria-label': 'Clear filter',
    hidden: true,
    onclick: () => {
      query = '';
      searchInput.value = '';
      clearBtn.hidden = true;
      renderGrid();
      searchInput.focus();
    },
  });
  const sortSelect = h('select', { class: 'sort-select', 'aria-label': 'Sort games' }, [
    h('option', { value: 'newest', text: 'newest first' }),
    h('option', { value: 'name', text: 'name A–Z' }),
    h('option', { value: 'size', text: 'largest first' }),
    h('option', { value: 'downloads', text: 'most downloaded' }),
  ]);
  const countLabel = h('span', { class: 'lib-count faint small' });

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    clearBtn.hidden = !query;
    renderGrid();
  });
  sortSelect.addEventListener('change', () => {
    sortBy = sortSelect.value;
    renderGrid();
  });

  toolbarHost.replaceChildren(
    h('div', { class: 'lib-toolbar' }, [
      h('div', { class: 'search-wrap' }, [searchInput, clearBtn]),
      h('div', { class: 'lib-toolbar-right' }, [countLabel, sortSelect]),
    ]),
  );

  function renderGrid() {
    let list = games;
    if (query) {
      list = games.filter((g) => {
        const hay = `${g.name} ${g.uploader_name || ''} ${g.description || ''}`.toLowerCase();
        return hay.includes(query);
      });
    }
    const sorted = [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'size') return (b.total_size || 0) - (a.total_size || 0);
      if (sortBy === 'downloads') return (b.download_count || 0) - (a.download_count || 0);
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });

    countLabel.textContent = query
      ? `${sorted.length} of ${games.length} games`
      : `${games.length} ${games.length === 1 ? 'game' : 'games'}`;

    if (!sorted.length) {
      box.replaceChildren(
        h('div', { class: 'empty' }, [
          h('p', { text: `no games match "${searchInput.value.trim()}".` }),
          h('button', {
            type: 'button',
            class: 'btn btn-sm',
            text: 'clear filter',
            onclick: () => {
              query = '';
              searchInput.value = '';
              clearBtn.hidden = true;
              renderGrid();
              searchInput.focus();
            },
          }),
        ]),
      );
      return;
    }

    box.replaceChildren(h('div', { class: 'grid' }, sorted.map(gameCard)));
  }

  renderGrid();
}

function gameCard(g) {
  const isReady = g.status === 'ready';
  const size = isReady ? humanSize(g.total_size) : 'processing…';

  const media = g.cover
    ? h('img', { src: g.cover, alt: g.name, loading: 'lazy' })
    : h('div', { class: 'card-cover-placeholder', 'aria-hidden': 'true' }, [
        h('span', { class: 'card-cover-monogram', text: monogram(g.name) }),
      ]);

  const cornerBadge = g.status === 'processing'
    ? h('span', { class: 'badge badge-processing card-cover-badge', text: 'processing' })
    : g.has_overlay
      ? h('span', { class: 'badge badge-synced card-cover-badge', text: 'synced' })
      : null;

  const overlayDesc = g.description?.trim()
    ? h('p', { class: 'card-cover-desc', text: g.description.trim() })
    : h('p', { class: 'card-cover-desc card-cover-summary', text: `${size} · ${g.download_count} downloads` });

  const downloadAction = isReady
    ? h('a', {
        class: 'btn btn-primary btn-sm',
        href: `/api/games/${g.id}/download`,
        download: `${g.name}.zip`,
        text: '⤓ download',
        onclick: (e) => {
          e.stopPropagation();
          if (g.has_overlay) {
            e.preventDefault();
            showDownloadDialog(g);
          }
        },
      })
    : null;

  const cover = h('div', {
    class: 'card-cover',
    onclick: () => navigate(`#/game/${g.id}`),
  }, [
    media,
    cornerBadge,
    h('div', { class: 'card-cover-overlay' }, [
      overlayDesc,
      h('div', { class: 'card-cover-actions' }, [
        h('a', {
          class: 'btn btn-sm card-open-btn',
          href: `#/game/${g.id}`,
          text: 'open →',
          onclick: (e) => e.stopPropagation(),
        }),
        downloadAction,
      ]),
    ]),
  ]);

  return h('article', { class: 'card' }, [
    cover,
    h('div', { class: 'card-body' }, [
      h('div', { class: 'card-title' }, [h('a', { href: `#/game/${g.id}`, text: g.name })]),
      h('div', { class: 'card-meta' }, [
        h('span', { text: size }),
        h('span', { class: 'meta-dot', text: '·' }),
        h('span', { text: `${g.download_count}↓` }),
        h('span', { class: 'meta-dot', text: '·' }),
        h('span', { class: 'faint', text: fmtDate(g.created_at) }),
      ]),
      h('div', { class: 'card-uploader' }, [
        g.uploader_pfp ? h('img', { class: 'uploader-pfp', src: pfpUrl(g.uploader_pfp), alt: '' }) : null,
        h('span', { class: 'faint small', text: `@${g.uploader_name || 'system'}` }),
      ]),
    ]),
  ]);
}
