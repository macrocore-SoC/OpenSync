/** Tiny hyperscript helper: h('div', {class:'x', onclick: fn}, [children]). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'value' && typeof v !== 'function') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  if (!container) return;
  const t = h('div', { class: `toast ${type}`, role: 'status', text: message });
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 180);
  };
  t.addEventListener('click', dismiss);
  container.appendChild(t);
  setTimeout(dismiss, 3800);
}

export async function confirmDialog(
  title,
  message,
  { danger = false, confirmText = 'Confirm', cancelText = 'Cancel' } = {},
) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };

    const overlay = h('div', {
      class: 'modal-overlay',
      onclick: (e) => {
        if (e.target === overlay) finish(false);
      },
    });
    const cancelBtn = h('button', {
      type: 'button',
      class: 'btn btn-ghost',
      text: cancelText,
      onclick: () => finish(false),
    });
    const confirmBtn = h('button', {
      type: 'button',
      class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
      text: confirmText,
      onclick: () => finish(true),
    });
    const box = h('div', { class: 'panel pop-dialog modal-box', role: 'dialog', 'aria-modal': 'true' }, [
      h('h3', { text: title }),
      h('p', { class: 'muted small', style: 'margin:0;', text: message }),
      h('div', { class: 'flex', style: 'justify-content:flex-end;margin-top:16px;' }, [cancelBtn, confirmBtn]),
    ]);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    (danger ? cancelBtn : confirmBtn).focus();
  });
}
