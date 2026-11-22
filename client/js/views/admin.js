import { api, fmtDateTime, humanSize, pfpUrl } from '../api.js';
import { currentRenderSeq } from '../app.js';
import { confirmDialog, h, toast } from '../ui.js';

let adminTimer = null;
let lastSig = null;
let benchResult = null;

function benchTable() {
  const rows = benchResult.results.map((r) =>
    h('tr', {}, [
      h('td', { class: 'muted small', text: r.method }),
      h('td', { text: `${r.mbps} MB/s` }),
      h('td', { class: 'muted small', text: `${r.out_mb} MB` }),
    ]),
  );
  return h('div', { class: 'table-wrap', style: 'margin-top:12px;' }, [
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [h('th', { text: 'Zip method' }), h('th', { text: 'Throughput' }), h('th', { text: 'Output (64 MB input)' })])]),
      h('tbody', {}, rows),
    ]),
  ]);
}

export async function renderAdmin(el, state) {
  const seq = currentRenderSeq();
  const [statsRes, usersRes] = await Promise.all([api.admin.stats(), api.admin.users()]);
  if (currentRenderSeq() !== seq) return;
  const { stats } = statsRes;
  const { users } = usersRes;

  const kpis = h('div', { class: 'kpis' }, [
    kpi(stats.users, 'Users'),
    kpi(stats.games, 'Games'),
    kpi(stats.downloads, 'Downloads'),
    kpi(humanSize(stats.storage_bytes), 'Storage used'),
  ]);

  const usersTable = h('table', { class: 'tbl' }, [
    h('thead', {}, [
      h('tr', {}, ['ID', 'User', 'Role', 'Games', 'Downloads', 'Joined', 'Actions'].map((c) => h('th', { text: c }))),
    ]),
    h('tbody', {}, users.map((u) => userRow(u))),
  ]);

  const nuUser = h('input', { type: 'text', id: 'nu-user', class: 'admin-input', placeholder: 'Username', autocomplete: 'off' });
  const nuPass = h('input', { type: 'password', id: 'nu-pass', class: 'admin-input', placeholder: 'Password (6+ chars)', autocomplete: 'new-password' });
  const createBtn = h('button', { type: 'submit', class: 'btn btn-sm btn-primary', text: 'Create user' });
  const createForm = h('form', {
    class: 'admin-create-form',
    onsubmit: async (e) => {
      e.preventDefault();
      createBtn.disabled = true;
      try {
        await api.admin.createUser({ username: nuUser.value, password: nuPass.value });
        toast('User created');
        renderAdmin(document.getElementById('view'), state);
      } catch (err) {
        toast(err.message, 'error');
        createBtn.disabled = false;
      }
    },
  }, [nuUser, nuPass, createBtn]);

  const benchBtn = h('button', { type: 'button', class: 'btn btn-sm', text: 'Run benchmark' });
  benchBtn.onclick = async () => {
    benchBtn.disabled = true;
    benchBtn.textContent = 'Benchmarking…';
    try {
      benchResult = await api.admin.bench();
    } catch (e) {
      toast(e.message, 'error');
    }
    renderAdmin(document.getElementById('view'), state);
  };

  el.replaceChildren(
    h('h1', { class: 'page-title' }, 'Admin panel'),
    kpis,
    h('div', { class: 'section-title' }, ['Zip benchmark']),
    h('div', { class: 'panel' }, [
      h('div', { class: 'flex' }, [benchBtn]),
      benchResult
        ? benchTable()
        : h('p', { class: 'faint small', style: 'margin:10px 0 0;', text: 'Measures archiver zip throughput on this server in memory.' }),
    ]),
    h('div', { class: 'section-title' }, ['Users']),
    h('div', { class: 'panel' }, [createForm, h('div', { class: 'table-wrap' }, [usersTable])]),
  );

  const recentSec = h('div', { class: 'section-title' }, ['Recent downloads']);
  el.append(recentSec);
  const recentPanel = h('div', { class: 'panel' });
  el.append(recentPanel);
  if (!stats.recent_downloads.length) {
    recentPanel.append(h('p', { class: 'faint small', style: 'margin:0;', text: 'No downloads yet.' }));
  } else {
    const table = h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [h('th', { text: 'When' }), h('th', { text: 'User' }), h('th', { text: 'Game' })])]),
      h('tbody', {}, stats.recent_downloads.map((r) =>
        h('tr', {}, [
          h('td', { class: 'muted small', text: fmtDateTime(r.created_at) }),
          h('td', {}, [
            h('div', { class: 'cell-user' }, [
              r.user_pfp ? h('img', { class: 'admin-pfp', src: pfpUrl(r.user_pfp), alt: '' }) : null,
              h('span', { text: `@${r.user}` }),
            ]),
          ]),
          h('td', { text: r.game }),
        ]))),
    ]);
    recentPanel.append(h('div', { class: 'table-wrap' }, [table]));
  }

  function kpi(num, label) {
    return h('div', { class: 'kpi' }, [
      h('div', { class: 'num', text: String(num) }),
      h('div', { class: 'label', text: label }),
    ]);
  }

  function userRow(u) {
    const isSelf = Number(u.id) === Number(state?.user?.id);
    return h('tr', {}, [
      h('td', { class: 'muted small', text: String(u.id) }),
      h('td', {}, [
        h('div', { class: 'cell-user' }, [
          u.pfp ? h('img', { class: 'admin-pfp', src: pfpUrl(u.pfp), alt: '' }) : null,
          h('span', { text: `@${u.username}` }),
        ]),
      ]),
      h('td', {}, [
        u.role === 'admin'
          ? h('span', { class: 'badge badge-admin', text: 'Admin' })
          : h('span', { class: 'pill', text: 'User' }),
      ]),
      h('td', { class: 'muted small', text: String(u.games_count) }),
      h('td', { class: 'muted small', text: String(u.downloads_count) }),
      h('td', { class: 'muted small', text: fmtDateTime(u.created_at) }),
      h('td', {}, [
        h('div', { class: 'flex' }, [
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-ghost',
            text: u.role === 'admin' ? 'Demote' : 'Promote',
            disabled: isSelf,
            title: isSelf ? 'Cannot change your own role' : '',
            onclick: async () => {
              try {
                await api.admin.setRole(u.id, u.role === 'admin' ? 'user' : 'admin');
                toast('Role updated');
                renderAdmin(document.getElementById('view'), state);
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          }),
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-ghost btn-danger',
            text: 'Delete',
            disabled: isSelf,
            title: isSelf ? 'Cannot delete your own account here' : '',
            onclick: async () => {
              const ok = await confirmDialog(
                'Delete user',
                `Delete @${u.username}? Their overlays are removed from disk.`,
                { danger: true, confirmText: 'Delete' },
              );
              if (!ok) return;
              try {
                await api.admin.removeUser(u.id);
                toast('User deleted');
                renderAdmin(document.getElementById('view'), state);
              } catch (e) {
                toast(e.message, 'error');
              }
            },
          }),
        ]),
      ]),
    ]);
  }

  clearInterval(adminTimer);
  lastSig = JSON.stringify([stats, users]);
  adminTimer = setInterval(async () => {
    if (!location.hash.startsWith('#/admin') || !el.isConnected) {
      clearInterval(adminTimer);
      adminTimer = null;
      lastSig = null;
      return;
    }
    try {
      const [sRes, uRes] = await Promise.all([api.admin.stats(), api.admin.users()]);
      const sig = JSON.stringify([sRes.stats, uRes.users]);
      if (sig === lastSig) return;
      lastSig = sig;
      const nu = document.getElementById('nu-user');
      const saved = nu ? { u: nu.value, p: document.getElementById('nu-pass')?.value ?? '' } : null;
      await renderAdmin(el, state);
      if (saved) {
        const u = document.getElementById('nu-user');
        if (u) u.value = saved.u;
        const p = document.getElementById('nu-pass');
        if (p) p.value = saved.p;
      }
    } catch {
      /* keep current view */
    }
  }, 8000);
}
