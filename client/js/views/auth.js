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

export async function renderAuth(el) {
  let mode = 'login';
  let pfpFile = null;
  let showPassword = false;
  let savedUsername = '';
  let savedPassword = '';

  const loginTab = h('button', { type: 'button', class: 'active', text: 'Sign in', onclick: () => switchMode('login') });
  const registerTab = h('button', { type: 'button', text: 'Create account', onclick: () => switchMode('register') });
  const body = h('div', { id: 'auth-body' });
  const errEl = h('div', { id: 'auth-error', class: 'form-error', role: 'alert' });

  const wrap = h('div', { class: 'auth-wrap panel' }, [
    h('img', { class: 'auth-logo', src: '/img/opensync.png', alt: 'OpenSync' }),
    h('p', { class: 'muted small auth-tagline', text: 'LAN game archive and save sync' }),
    h('div', { class: 'auth-tabs', role: 'tablist' }, [loginTab, registerTab]),
    body,
    errEl,
  ]);
  el.replaceChildren(wrap);

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
    loginTab.classList.toggle('active', mode === 'login');
    registerTab.classList.toggle('active', mode === 'register');
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
      placeholder: 'your handle',
    });
    uInput.value = savedUsername;

    const pInput = h('input', {
      id: 'auth-password',
      type: showPassword ? 'text' : 'password',
      name: 'password',
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
      placeholder: mode === 'register' ? 'at least 6 characters' : '••••••••',
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
        h('div', { class: 'small', text: 'click to choose or drop an image' }),
        h('div', { class: 'faint small', text: 'jpg or png, max 8 MB' }),
      ]);
      const removePfpBtn = h('button', {
        type: 'button',
        class: 'btn btn-sm btn-ghost',
        text: 'remove',
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
          showError('username is required');
          uInput.focus();
          return;
        }
        if (mode === 'register' && p.length < 6) {
          showError('password must be at least 6 characters');
          pInput.focus();
          return;
        }
        if (mode === 'login' && !p) {
          showError('password is required');
          pInput.focus();
          return;
        }

        submit.disabled = true;
        submit.textContent = mode === 'login' ? 'signing in…' : 'creating account…';
        try {
          let pfpDataUrl = null;
          if (mode === 'register' && pfpFile) {
            if (!/^image\/(jpeg|png)$/.test(pfpFile.type)) throw new Error('profile picture must be jpeg or png');
            if (pfpFile.size > 8 * 1024 * 1024) throw new Error('profile picture too large (max 8 MB)');
            pfpDataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('could not read profile picture'));
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
          submit.textContent = mode === 'login' ? 'sign in' : 'create account';
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
