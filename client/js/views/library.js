import { api, fmtDate, humanSize } from '../api.js';
import { currentRenderSeq, navigate } from '../app.js';
import { h } from '../ui.js';
import { showDownloadDialog } from './game.js';

// Lucide "download" icon (ISC License — https://lucide.dev/icons/download)
const DOWNLOAD_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';

function monogram(name) {
  const words = String(name || 'G').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name || 'G').trim().slice(0, 2).toUpperCase();
}

export async function renderLibrary(el) {
  const seq = currentRenderSeq();
  const titleEl = h('h1', { class: 'page-title' }, 'game library');
  const controlsHost = h('div', { class: 'lib-header-controls' });
  const header = h('div', { class: 'lib-header' }, [titleEl, controlsHost]);
  const box = h('div', { id: 'lib' });
  box.replaceChildren(
    h('div', { class: 'muted small flex', style: 'gap:8px;padding:12px 0;' }, [
      h('span', { class: 'spinner' }),
      h('span', { text: 'fetching library…' }),
    ]),
  );
  el.replaceChildren(header, box);

  const { games } = await api.games.list();
  if (currentRenderSeq() !== seq) return;
  if (!games.length) {
    box.replaceChildren(
      h('div', { class: 'empty' }, [
        h('p', { text: 'No games on this server yet.' }),
        h('a', { class: 'btn btn-primary', href: '#/upload', text: 'Upload the first one' }),
      ]),
    );
    return;
  }

  let query = '';
  let sortBy = 'newest';

  const searchInput = h('input', {
    type: 'text',
    class: 'search-input',
    placeholder: 'Filter by name or uploader…',
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
    h('option', { value: 'newest', text: 'Newest first' }),
    h('option', { value: 'name', text: 'Name A–Z' }),
    h('option', { value: 'size', text: 'Largest first' }),
    h('option', { value: 'downloads', text: 'Most downloaded' }),
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

  controlsHost.replaceChildren(
    h('div', { class: 'search-wrap' }, [searchInput, clearBtn]),
    h('div', { class: 'lib-toolbar-right' }, [countLabel, sortSelect]),
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
          h('p', { text: `No games match "${searchInput.value.trim()}".` }),
          h('button', {
            type: 'button',
            class: 'btn btn-sm',
            text: 'Clear filter',
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

function attachSteamTilt(card) {
  const MAX_TILT_X = 7;
  const MAX_TILT_Y = 8;

  card.addEventListener('pointermove', (e) => {
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1; // -1..1
    const py = ((e.clientY - rect.top) / rect.height) * 2 - 1; // -1..1
    const rx = (-py * MAX_TILT_X).toFixed(2);
    const ry = (px * MAX_TILT_Y).toFixed(2);
    const gx = (((e.clientX - rect.left) / rect.width) * 100).toFixed(1);
    const gy = (((e.clientY - rect.top) / rect.height) * 100).toFixed(1);
    card.style.setProperty('--rx', `${rx}deg`);
    card.style.setProperty('--ry', `${ry}deg`);
    card.style.setProperty('--gx', `${gx}%`);
    card.style.setProperty('--gy', `${gy}%`);
  });

  card.addEventListener('pointerleave', () => {
    card.style.removeProperty('--rx');
    card.style.removeProperty('--ry');
    card.style.removeProperty('--gx');
    card.style.removeProperty('--gy');
  });
}

function buildWebCardStats(g, isReady) {
  if (!isReady) return ['Processing…'];
  const stats = [humanSize(g.total_size)];
  const dlCount = Number(g.download_count || 0);
  stats.push(
    dlCount > 0
      ? `${dlCount} ${dlCount === 1 ? 'download' : 'downloads'}`
      : 'No downloads yet',
  );
  if (g.has_overlay) {
    stats.push('Save synced');
  }
  if (g.created_at) {
    stats.push(`Added ${fmtDate(g.created_at)}`);
  }
  if (g.uploader_name) {
    stats.push(`By @${g.uploader_name}`);
  }
  return stats;
}

function attachStatTicker(card, ticker, stats, intervalMs = 2000) {
  if (!ticker || !Array.isArray(stats) || stats.length < 2) return;

  let index = 0;
  let timer = null;
  let hovered = false;
  let focused = false;

  const swapTo = (nextIndex, direction = 'up') => {
    if (nextIndex === index) return;
    index = nextIndex;

    const outClass = direction === 'down' ? 'is-leaving-down' : 'is-leaving';
    const inClass = direction === 'down' ? 'is-entering-down' : 'is-entering';

    for (const stale of ticker.querySelectorAll('.is-leaving, .is-leaving-down')) {
      stale.remove();
    }

    const current = ticker.querySelector('.card-stat-item');
    const next = h('span', { class: `card-stat-item ${inClass}`, text: stats[index] });
    ticker.appendChild(next);

    if (current) {
      current.classList.remove('is-entering', 'is-entering-down');
      current.classList.add(outClass);
      current.setAttribute('aria-hidden', 'true');
      let removed = false;
      const cleanup = () => {
        if (removed) return;
        removed = true;
        current.remove();
      };
      current.addEventListener('animationend', cleanup, { once: true });
      window.setTimeout(cleanup, 460);
    }

    next.addEventListener('animationend', () => {
      next.classList.remove('is-entering', 'is-entering-down');
    }, { once: true });
  };

  const syncTimer = () => {
    if (hovered || focused) {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (!card.isConnected) {
          window.clearInterval(timer);
          timer = null;
          return;
        }
        swapTo((index + 1) % stats.length, 'up');
      }, intervalMs);
    } else {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      if (index !== 0) {
        swapTo(0, 'down');
      }
    }
  };

  card.addEventListener('pointerenter', () => {
    hovered = true;
    syncTimer();
  });
  card.addEventListener('pointerleave', () => {
    hovered = false;
    syncTimer();
  });
  card.addEventListener('focusin', () => {
    focused = true;
    syncTimer();
  });
  card.addEventListener('focusout', (e) => {
    if (!card.contains(e.relatedTarget)) {
      focused = false;
      syncTimer();
    }
  });
}

function gameCard(g) {
  const isReady = g.status === 'ready';
  const size = isReady ? humanSize(g.total_size) : 'Processing…';
  const stats = buildWebCardStats(g, isReady);

  const media = g.cover
    ? h('img', { class: 'card-cover-img', src: g.cover, alt: g.name, loading: 'lazy' })
    : h('div', { class: 'card-cover-placeholder', 'aria-hidden': 'true' }, [
        h('span', { class: 'card-cover-monogram', text: monogram(g.name) }),
      ]);

  const cornerBadge = g.status === 'processing'
    ? h('span', { class: 'badge badge-processing card-cover-badge', text: 'Processing' })
    : g.has_overlay
      ? h('span', { class: 'badge badge-synced card-cover-badge', text: 'Synced' })
      : null;

  const downloadAction = isReady
    ? h('a', {
        class: 'btn btn-sm card-glass-dl',
        href: `/api/games/${g.id}/download`,
        download: `${g.name}.zip`,
        'aria-label': `Download ${g.name}`,
        title: `Download ${g.name}`,
        html: DOWNLOAD_SVG,
        onclick: (e) => {
          e.stopPropagation();
          if (g.has_overlay) {
            e.preventDefault();
            showDownloadDialog(g);
          }
        },
      })
    : null;

  const statTicker = h('span', { class: 'card-stat-ticker' }, [
    h('span', { class: 'card-stat-item', text: stats[0] }),
  ]);

  const footer = h('div', { class: 'card-glass-footer' }, [
    h('div', { class: 'card-glass-info' }, [
      h('a', {
        class: 'card-glass-title',
        href: `#/game/${g.id}`,
        text: g.name,
        onclick: (e) => e.stopPropagation(),
      }),
      h('div', { class: 'card-glass-meta' }, [statTicker]),
    ]),
    downloadAction,
  ]);

  const card = h('article', {
    class: 'card steam-card',
    title: `${g.name} — ${size}, added ${fmtDate(g.created_at)}`,
    onclick: () => navigate(`#/game/${g.id}`),
  }, [
    media,
    h('div', { class: 'card-glass-sheen', 'aria-hidden': 'true' }),
    cornerBadge,
    footer,
  ]);

  attachSteamTilt(card);
  attachStatTicker(card, statTicker, stats, 2000);
  return card;
}
