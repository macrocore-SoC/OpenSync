import { api, fmtDate, humanSize } from '../api.js';
import { currentRenderSeq, navigate } from '../app.js';
import { fadeOutHero, prepareHeroBg, scheduleClearHero, showGameHero } from '../hero.js';
import { h } from '../ui.js';
import { showDownloadDialog } from './game.js';

// Lucide "download" icon (ISC License — https://lucide.dev/icons/download)
const DOWNLOAD_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';

function monogram(name) {
  const words = String(name || 'G').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name || 'G').trim().slice(0, 2).toUpperCase();
}

// Shared placeholder so a broken cover degrades to the same monogram tile
// used when a game has no cover at all — never a broken-image glyph.
function monogramPlaceholder(name) {
  return h('div', { class: 'card-cover-placeholder', 'aria-hidden': 'true' }, [
    h('span', { class: 'card-cover-monogram', text: monogram(name) }),
  ]);
}

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/**
 * Accessible CSS pill dropdown for library sorting. The menu is a child of the
 * trigger wrapper, so it leaves the DOM together with the view; listeners and
 * the detach observer only exist while the menu is open.
 */
function createCssSelect({ options, value, onChange, ariaLabel = 'Sort games' }) {
  const root = h('div', { class: 'css-select' });
  const valueEl = h('span', { class: 'css-select-value' });
  const trigger = h('button', {
    type: 'button',
    class: 'css-select-trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-label': ariaLabel,
  }, [valueEl, h('span', { class: 'css-select-chevron', html: CHEVRON_SVG })]);
  root.append(trigger);

  let selected = options.some((o) => o.value === value) ? value : (options[0]?.value ?? '');
  let activeIndex = Math.max(0, options.findIndex((o) => o.value === selected));
  let menu = null;
  let open = false;
  let observer = null;

  const labelFor = (v) => options.find((o) => o.value === v)?.label ?? v;

  function syncTrigger() {
    valueEl.textContent = labelFor(selected);
    trigger.setAttribute('aria-label', `${ariaLabel}: ${labelFor(selected)}`);
  }

  function paintActive() {
    const items = menu ? [...menu.querySelectorAll('.css-select-option')] : [];
    items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(index) {
    const opt = options[index];
    if (!opt) return;
    selected = opt.value;
    activeIndex = index;
    syncTrigger();
    closeMenu();
    trigger.focus();
    if (typeof onChange === 'function') onChange(selected);
  }

  function closeMenu() {
    if (!open) return;
    open = false;
    observer?.disconnect();
    observer = null;
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onDocKey, true);
    root.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    menu?.remove();
    menu = null;
  }

  function openMenu() {
    if (open) return;
    open = true;
    activeIndex = Math.max(0, options.findIndex((o) => o.value === selected));
    root.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');

    menu = h('div', { class: 'css-select-menu', role: 'listbox', 'aria-label': ariaLabel });
    options.forEach((opt, i) => {
      const item = h('button', {
        type: 'button',
        class: `css-select-option${opt.value === selected ? ' selected' : ''}${i === activeIndex ? ' is-active' : ''}`,
        role: 'option',
        'aria-selected': String(opt.value === selected),
        onclick: (e) => { e.stopPropagation(); pick(i); },
        onpointerenter: () => { activeIndex = i; paintActive(); },
      }, [h('span', { text: opt.label })]);
      if (opt.value === selected) {
        item.append(h('span', { class: 'css-select-check', html: CHECK_SVG }));
      }
      menu.append(item);
    });
    root.append(menu);

    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onDocKey, true);
    observer = new MutationObserver(() => {
      if (!root.isConnected) closeMenu();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function onDocPointer(e) {
    if (!root.contains(e.target)) closeMenu();
  }

  function onDocKey(e) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      trigger.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + dir + options.length) % options.length;
      paintActive();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      pick(activeIndex);
    }
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) closeMenu();
    else openMenu();
  });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openMenu();
    }
  });

  syncTrigger();
  return { element: root, get value() { return selected; } };
}

export async function renderLibrary(el) {
  const seq = currentRenderSeq();
  prepareHeroBg();
  fadeOutHero();
  const titleEl = h('h1', { class: 'page-title' }, 'Game library');
  const controlsHost = h('div', { class: 'lib-header-controls' });
  const header = h('div', { class: 'lib-header' }, [titleEl, controlsHost]);
  const box = h('div', { id: 'lib' });
  box.replaceChildren(
    h('div', { class: 'muted small flex', style: 'gap:8px;padding:12px 0;' }, [
      h('span', { class: 'spinner' }),
      h('span', { text: 'Fetching library…' }),
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
  const sortSelect = createCssSelect({
    options: [
      { value: 'newest', label: 'Newest first' },
      { value: 'name', label: 'Name A–Z' },
      { value: 'size', label: 'Largest first' },
      { value: 'downloads', label: 'Most downloaded' },
    ],
    value: sortBy,
    ariaLabel: 'Sort games',
    onChange: (value) => {
      sortBy = value;
      renderGrid();
    },
  });
  const countLabel = h('span', { class: 'lib-count faint small' });

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    clearBtn.hidden = !query;
    renderGrid();
  });

  controlsHost.replaceChildren(
    h('div', { class: 'search-wrap' }, [searchInput, clearBtn]),
    h('div', { class: 'lib-toolbar-right' }, [countLabel, sortSelect.element]),
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
      fadeOutHero();
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

function attachStatTicker(card, ticker, stats, intervalMs = 1500, firstDelayMs = 450) {
  if (!ticker || !Array.isArray(stats) || stats.length < 2) return;

  let index = 0;
  let firstTimer = null;
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

  const stopTimers = () => {
    if (firstTimer !== null) {
      window.clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const stepNext = () => {
    if (!card.isConnected) {
      stopTimers();
      return false;
    }
    swapTo((index + 1) % stats.length, 'up');
    return true;
  };

  const syncTimer = () => {
    if (hovered || focused) {
      if (firstTimer !== null || timer !== null) return;
      firstTimer = window.setTimeout(() => {
        firstTimer = null;
        if (!stepNext()) return;
        timer = window.setInterval(stepNext, intervalMs);
      }, firstDelayMs);
    } else {
      stopTimers();
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

  let coverFailed = false;
  const media = g.cover
    ? h('img', {
        class: 'card-cover-img',
        alt: g.name,
        loading: 'lazy',
        decoding: 'async',
        // Register the handler before src so even instant failures are caught.
        onerror: (e) => {
          if (coverFailed) return;
          coverFailed = true;
          e.currentTarget.replaceWith(monogramPlaceholder(g.name));
        },
        src: g.cover,
      })
    : monogramPlaceholder(g.name);

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

  const activateHero = () => showGameHero(coverFailed ? null : g.cover);
  const deactivateHero = () => scheduleClearHero(95);
  card.addEventListener('pointerenter', activateHero);
  card.addEventListener('pointerleave', deactivateHero);
  card.addEventListener('focusin', activateHero);
  card.addEventListener('focusout', (e) => {
    if (!card.contains(e.relatedTarget)) deactivateHero();
  });

  attachSteamTilt(card);
  attachStatTicker(card, statTicker, stats, 1500, 450);
  return card;
}
