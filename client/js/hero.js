const heroBlurCache = new Map();

let heroSeq = 0;
let activeLayer = 0;
let fadeOutTimer = null;

function getHeroNodes() {
  const bg = document.getElementById('detail-hero-bg');
  if (!bg) return { bg: null, imgs: [] };
  const imgs = [...bg.querySelectorAll('.detail-hero-img')];
  return { bg, imgs };
}

function makeBlurredHeroDataUrl(srcUrl) {
  return new Promise((resolve) => {
    if (!srcUrl || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        if (!w || !h) {
          resolve(null);
          return;
        }
        // Multi-step small offscreen downscale produces a smooth edge-free wash
        // with minimal GPU work while scrolling or hovering cards.
        const insetW = Math.max(1, Math.round(w * 0.88));
        const insetH = Math.max(1, Math.round(h * 0.62));
        const sx = Math.round((w - insetW) * 0.5);
        const sy = Math.round((h - insetH) * 0.25);

        const c1 = document.createElement('canvas');
        c1.width = 48;
        c1.height = 27;
        const ctx1 = c1.getContext('2d');
        if (!ctx1) {
          resolve(null);
          return;
        }
        ctx1.imageSmoothingEnabled = true;
        ctx1.imageSmoothingQuality = 'high';
        ctx1.drawImage(img, sx, sy, insetW, insetH, 0, 0, 48, 27);

        const c2 = document.createElement('canvas');
        c2.width = 96;
        c2.height = 54;
        const ctx2 = c2.getContext('2d');
        if (!ctx2) {
          resolve(null);
          return;
        }
        ctx2.imageSmoothingEnabled = true;
        ctx2.imageSmoothingQuality = 'high';
        if ('filter' in ctx2) {
          ctx2.filter = 'blur(4px)';
        }
        ctx2.drawImage(c1, 0, 0, 96, 54);
        resolve(c2.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = srcUrl;
  });
}

function cancelFadeTimer() {
  if (fadeOutTimer !== null) {
    window.clearTimeout(fadeOutTimer);
    fadeOutTimer = null;
  }
}

export function prepareHeroBg() {
  const { bg } = getHeroNodes();
  if (!bg) return;
  bg.hidden = false;
}

export function fadeOutHero() {
  cancelFadeTimer();
  heroSeq += 1;
  const { bg, imgs } = getHeroNodes();
  if (!bg) return;
  bg.classList.remove('is-active');
  for (const img of imgs) {
    img.classList.remove('is-visible');
  }
}

export function scheduleClearHero(delayMs = 95) {
  cancelFadeTimer();
  if (delayMs <= 0) {
    fadeOutHero();
    return;
  }
  fadeOutTimer = window.setTimeout(() => {
    fadeOutTimer = null;
    fadeOutHero();
  }, delayMs);
}

export function invalidateHeroCache(coverUrl) {
  if (coverUrl) heroBlurCache.delete(coverUrl);
}

export function clearGameHeroImmediate() {
  cancelFadeTimer();
  heroSeq += 1;
  const { bg, imgs } = getHeroNodes();
  if (!bg) return;
  bg.hidden = true;
  bg.classList.remove('is-active');
  for (const img of imgs) {
    img.classList.remove('is-visible');
    img.removeAttribute('src');
  }
}

export async function showGameHero(coverUrl) {
  const { bg, imgs } = getHeroNodes();
  if (!bg) return;

  cancelFadeTimer();
  const seq = ++heroSeq;
  bg.hidden = false;
  // Defer adding .is-active by one frame if just unhidden so opacity transition fires cleanly.
  if (!bg.classList.contains('is-active')) {
    void bg.offsetWidth;
    bg.classList.add('is-active');
  }

  if (!coverUrl) {
    for (const img of imgs) img.classList.remove('is-visible');
    return;
  }

  let blurredUrl = heroBlurCache.get(coverUrl);
  if (blurredUrl === undefined) {
    blurredUrl = await makeBlurredHeroDataUrl(coverUrl);
    heroBlurCache.set(coverUrl, blurredUrl);
  }
  if (seq !== heroSeq || bg.hidden) return;

  if (!blurredUrl || imgs.length === 0) {
    for (const img of imgs) img.classList.remove('is-visible');
    return;
  }

  const currentImg = imgs[activeLayer];
  if (currentImg && currentImg.getAttribute('src') === blurredUrl && currentImg.classList.contains('is-visible')) {
    return;
  }

  const nextLayer = imgs.length > 1 ? (activeLayer + 1) % imgs.length : 0;
  const nextImg = imgs[nextLayer];
  activeLayer = nextLayer;

  if (nextImg.getAttribute('src') !== blurredUrl) {
    nextImg.classList.remove('is-visible');
    nextImg.src = blurredUrl;
  }
  void nextImg.offsetWidth;
  nextImg.classList.add('is-visible');
  for (let i = 0; i < imgs.length; i += 1) {
    if (i !== activeLayer) {
      imgs[i].classList.remove('is-visible');
    }
  }
}
