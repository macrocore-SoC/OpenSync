import { api } from '../api.js';
import { h } from '../ui.js';
import { navigate, startNotifPolling, state } from '../app.js';

let infoPromise = null;
function getInfo() {
  if (!infoPromise) {
    infoPromise = api.info().catch(() => ({ has_admin: true }));
  }
  return infoPromise;
}

const EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// AG-DESIGN tokens: obsidian canvas, emerald accent, full-pill controls.
const UI_FONT = "font-family:'Plus Jakarta Sans','Inter',sans-serif;";
const PILL = 'border-radius:9999px;min-height:46px;padding:10px 22px;font-weight:600;letter-spacing:-0.01em;';
const PILL_SM = 'border-radius:9999px;';
const TAB_ACTIVE = `${PILL}border:1px solid rgba(125,250,155,0.35);background:rgba(125,250,155,0.12);color:var(--accent);`;
const TAB_IDLE = `${PILL}border:1px solid transparent;background:transparent;color:var(--muted);`;
const CANVAS_STYLE = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;display:block;';
const WRAP_STYLE = `${UI_FONT}position:relative;z-index:1;border-radius:24px;padding:28px 26px 24px;`;

/**
 * Lightweight emerald directional particle field behind the auth panel.
 * Short, round-capped dashes point away from the canvas centre (or the
 * pointer), drift on a trig phase and repel softly near the cursor. The
 * animation pauses on visibilitychange, is skipped under reduced motion and
 * tears itself down (observer, listeners, rAF and canvas) as soon as
 * #auth-body detaches from the DOM.
 */
function attachParticleField(canvas, authBody) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => canvas.remove();

  // Every stroke is a green shade — no blue or neutral particles.
  const COLORS = [
    'rgba(125, 250, 155, 0.85)',
    'rgba(125, 250, 155, 0.55)',
    'rgba(74, 222, 128, 0.45)',
    'rgba(187, 247, 208, 0.32)',
  ];
  const pointer = { x: -1, y: -1 };
  let width = 0;
  let height = 0;
  let particles = [];
  let rafId = 0;
  let running = false;
  let cleaned = false;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Use viewport metrics: #view carries a brief transform animation which
    // would otherwise become the containing block for this fixed canvas.
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(26, Math.min(90, Math.round((width * height) / 18000)));
    particles = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * width,
      y: Math.random() * height,
      phase: Math.random() * Math.PI * 2,
      speed: 0.15 + Math.random() * 0.35,
      amp: 6 + Math.random() * 14,
      len: 3 + Math.random() * 5,
      color: COLORS[i % COLORS.length],
    }));
    if (!running) draw(0);
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    const originX = pointer.x >= 0 ? pointer.x : width / 2;
    const originY = pointer.y >= 0 ? pointer.y : height / 2;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    for (const p of particles) {
      const angle = Math.atan2(p.y - originY, p.x - originX);
      let px = p.x + Math.cos(time * 0.0004 * p.speed + p.phase) * p.amp;
      let py = p.y + Math.sin(time * 0.00035 * p.speed + p.phase) * p.amp;
      if (pointer.x >= 0) {
        const rx = px - pointer.x;
        const ry = py - pointer.y;
        const dist = Math.hypot(rx, ry);
        if (dist < 140 && dist > 0) {
          const push = ((140 - dist) / 140) * 26;
          px += (rx / dist) * push;
          py += (ry / dist) * push;
        }
      }
      const dx = Math.cos(angle) * p.len * 0.5;
      const dy = Math.sin(angle) * p.len * 0.5;
      ctx.strokeStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(px - dx, py - dy);
      ctx.lineTo(px + dx, py + dy);
      ctx.stroke();
    }
  }

  function tick(time) {
    draw(time);
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (running || cleaned) return;
    running = true;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onVisibility() {
    if (document.hidden) stop();
    else if (!reduce.matches) start();
  }

  function onMotionChange() {
    if (reduce.matches) {
      stop();
      draw(0);
    } else if (!document.hidden) {
      start();
    }
  }

  function onPointerMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }

  function onPointerLeave() {
    pointer.x = -1;
    pointer.y = -1;
  }

  const observer = new MutationObserver(() => {
    if (!authBody.isConnected) cleanup();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    stop();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('blur', onPointerLeave);
    if (reduce.removeEventListener) reduce.removeEventListener('change', onMotionChange);
    canvas.remove();
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('blur', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('pointerleave', onPointerLeave);
  if (reduce.addEventListener) reduce.addEventListener('change', onMotionChange);

  resize();
  if (reduce.matches) draw(0);
  else start();

  return cleanup;
}

export async function renderAuth(el) {
  let mode = 'login';
  let pfpFile = null;
  let showPassword = false;
  let savedUsername = '';
  let savedPassword = '';

  const loginTab = h('button', {
    type: 'button',
    class: 'active',
    style: TAB_ACTIVE,
    text: 'Sign in',
    onclick: () => switchMode('login'),
  });
  const registerTab = h('button', {
    type: 'button',
    style: TAB_IDLE,
    text: 'Create account',
    onclick: () => switchMode('register'),
  });
  const body = h('div', { id: 'auth-body' });
  const errEl = h('div', { id: 'auth-error', class: 'form-error', role: 'alert' });

  const wrap = h('div', { class: 'auth-wrap panel', style: WRAP_STYLE }, [
    h('img', { class: 'auth-logo', src: '/img/opensync.png', alt: 'OpenSync' }),
    h('p', { class: 'muted small auth-tagline', text: 'LAN game archive and save sync' }),
    h('div', {
      class: 'auth-tabs',
      role: 'tablist',
      style: 'border-bottom:none;justify-content:center;gap:8px;margin-bottom:20px;',
    }, [loginTab, registerTab]),
    body,
    errEl,
  ]);
  const canvas = h('canvas', { class: 'auth-particles', 'aria-hidden': 'true', style: CANVAS_STYLE });
  el.replaceChildren(canvas, wrap);
  attachParticleField(canvas, body);

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.remove('shake');
    void errEl.offsetWidth;
    if (msg) errEl.classList.add('shake');
  }

  function switchMode(next) {
    if (mode === next) return;
    const uIn = body.querySelector('input[name="username"]');
    const pIn = body.querySelector('input[name="password"]');
    if (uIn) savedUsername = uIn.value;
    if (pIn) savedPassword = pIn.value;
    mode = next;
    const isLogin = mode === 'login';
    loginTab.classList.toggle('active', isLogin);
    registerTab.classList.toggle('active', !isLogin);
    loginTab.style.cssText = isLogin ? TAB_ACTIVE : TAB_IDLE;
    registerTab.style.cssText = isLogin ? TAB_IDLE : TAB_ACTIVE;
    renderBody(true);
  }

  async function renderBody(isSwitch = false) {
    showError('');
    const prevH = body.offsetHeight;

    const uInput = h('input', {
      id: 'auth-username',
      type: 'text',
      name: 'username',
      autocomplete: 'username',
      placeholder: 'Your handle',
    });
    uInput.value = savedUsername;

    const pInput = h('input', {
      id: 'auth-password',
      type: showPassword ? 'text' : 'password',
      name: 'password',
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
      placeholder: mode === 'register' ? 'At least 6 characters' : '••••••••',
    });
    pInput.value = savedPassword;

    const pwToggle = h('button', {
      type: 'button',
      class: 'pw-toggle',
      'aria-label': showPassword ? 'Hide password' : 'Show password',
      title: showPassword ? 'Hide password' : 'Show password',
      html: showPassword ? EYE_OFF_SVG : EYE_OPEN_SVG,
      onclick: () => {
        showPassword = !showPassword;
        pInput.type = showPassword ? 'text' : 'password';
        pwToggle.innerHTML = showPassword ? EYE_OFF_SVG : EYE_OPEN_SVG;
        pwToggle.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
        pwToggle.title = showPassword ? 'Hide password' : 'Show password';
        pInput.focus();
      },
    });

    const usernameField = h('div', { class: 'field' }, [
      h('label', { htmlFor: 'auth-username', text: 'Username' }),
      uInput,
    ]);
    const passwordField = h('div', { class: 'field' }, [
      h('label', { htmlFor: 'auth-password', text: 'Password' }),
      h('div', { class: 'input-pw-wrap' }, [pInput, pwToggle]),
    ]);

    let pfpField = null;
    if (mode === 'register') {
      const pfpInput = h('input', { type: 'file', accept: 'image/jpeg,image/png', style: 'display:none' });
      const pfpImg = h('img', { class: 'pfp-lg pfp-preview', src: '/img/blankpfp.jpg', alt: '' });
      const pfpHint = h('div', { class: 'pfp-picker-copy' }, [
        h('div', { class: 'small', text: 'Click to choose or drop an image' }),
        h('div', { class: 'faint small', text: 'JPG or PNG, max 8 MB' }),
      ]);
      const removePfpBtn = h('button', {
        type: 'button',
        class: 'btn btn-sm btn-ghost',
        style: PILL_SM,
        text: 'Remove',
        hidden: !pfpFile,
        onclick: (e) => {
          e.stopPropagation();
          setPfpFile(null);
        },
      });
      const pfpPicker = h('div', {
        class: 'pfp-picker',
        role: 'button',
        tabIndex: 0,
        onclick: () => pfpInput.click(),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pfpInput.click();
          }
        },
      }, [pfpImg, pfpHint, removePfpBtn, pfpInput]);

      function setPfpFile(file) {
        pfpFile = file || null;
        removePfpBtn.hidden = !pfpFile;
        if (pfpFile) {
          const url = URL.createObjectURL(pfpFile);
          pfpImg.onload = () => URL.revokeObjectURL(url);
          pfpImg.src = url;
        } else {
          pfpImg.src = '/img/blankpfp.jpg';
          pfpInput.value = '';
        }
      }

      if (pfpFile) setPfpFile(pfpFile);

      pfpInput.addEventListener('change', () => {
        if (pfpInput.files[0]) setPfpFile(pfpInput.files[0]);
      });

      let pfpDragDepth = 0;
      pfpPicker.addEventListener('dragenter', (e) => {
        e.preventDefault();
        pfpDragDepth += 1;
        pfpPicker.classList.add('drag-over');
      });
      pfpPicker.addEventListener('dragover', (e) => e.preventDefault());
      pfpPicker.addEventListener('dragleave', () => {
        pfpDragDepth = Math.max(0, pfpDragDepth - 1);
        if (pfpDragDepth === 0) pfpPicker.classList.remove('drag-over');
      });
      pfpPicker.addEventListener('drop', (e) => {
        e.preventDefault();
        pfpDragDepth = 0;
        pfpPicker.classList.remove('drag-over');
        const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
        if (file) setPfpFile(file);
      });

      pfpField = h('div', { class: 'field' }, [
        h('label', { text: 'Profile picture (optional)' }),
        pfpPicker,
      ]);
    }

    const submit = h('button', {
      type: 'submit',
      class: 'btn btn-primary btn-block',
      style: PILL,
      text: mode === 'login' ? 'Sign in' : 'Create account',
    });

    const hints = [];
    if (mode === 'register' && !(await getInfo()).has_admin) {
      hints.push(h('p', { class: 'faint small auth-note', text: 'The first account on this server becomes the administrator.' }));
    }
    hints.push(
      h('p', { class: 'faint small auth-switch' }, [
        mode === 'login' ? 'No account yet? ' : 'Already have an account? ',
        h('button', {
          type: 'button',
          class: 'link-btn',
          text: mode === 'login' ? 'Create one' : 'Sign in',
          onclick: () => switchMode(mode === 'login' ? 'register' : 'login'),
        }),
      ]),
    );

    const formEl = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        showError('');
        const u = uInput.value.trim();
        const p = pInput.value;
        if (!u) {
          showError('Username is required');
          uInput.focus();
          return;
        }
        if (mode === 'register' && p.length < 6) {
          showError('Password must be at least 6 characters');
          pInput.focus();
          return;
        }
        if (mode === 'login' && !p) {
          showError('Password is required');
          pInput.focus();
          return;
        }

        submit.disabled = true;
        submit.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';
        try {
          let pfpDataUrl = null;
          if (mode === 'register' && pfpFile) {
            if (!/^image\/(jpeg|png)$/.test(pfpFile.type)) throw new Error('Profile picture must be JPG or PNG');
            if (pfpFile.size > 8 * 1024 * 1024) throw new Error('Profile picture too large (max 8 MB)');
            pfpDataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('Could not read profile picture'));
              reader.readAsDataURL(pfpFile);
            });
          }
          const { user } = mode === 'login'
            ? await api.auth.login(u, p)
            : await api.auth.register(u, p, pfpDataUrl);
          infoPromise = null;
          state.user = user;
          startNotifPolling();
          navigate('#/');
        } catch (err) {
          showError(err.message);
          submit.disabled = false;
          submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
        }
      },
    }, [usernameField, passwordField, pfpField, submit, ...hints]);

    body.replaceChildren(formEl);

    const targetH = body.scrollHeight;
    if (isSwitch && prevH > 0 && targetH !== prevH) {
      body.style.height = `${prevH}px`;
      void body.offsetHeight;
      body.style.height = `${targetH}px`;
      body.addEventListener('transitionend', () => { body.style.height = ''; }, { once: true });
    }

    if (!uInput.value) uInput.focus();
    else if (!pInput.value) pInput.focus();
    else uInput.focus();
  }

  renderBody(false);
}
