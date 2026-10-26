const body = document.querySelector('#users-body');
const message = document.querySelector('#message');
const tempBox = document.querySelector('#temp-box');
let me;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
  if (response.status === 401) { window.location.replace('/login'); throw new Error('UNAUTHENTICATED'); }
  if (response.status === 403) {
    const data = await response.clone().json().catch(() => ({}));
    // Sin permisos para la pantalla: se va al inventario. Sin permiso para una acción: solo se avisa.
    if (data.error === 'PASSWORD_CHANGE_REQUIRED') { window.location.replace('/cambiar-password'); throw new Error(data.message); }
    if (data.error === 'FORBIDDEN') { window.location.replace('/inventario'); throw new Error(data.message || 'Sin permiso'); }
    throw new Error(data.message || 'No tienes permiso para hacer esto');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data && data.message) || 'Ocurrió un error');
  return data;
}

function showTemp(email, password) {
  document.querySelector('#temp-email').textContent = email;
  document.querySelector('#temp-password').textContent = password;
  tempBox.hidden = false;
}

function actionButton(label, handler, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `page-button small-button ${extraClass}`.trim();
  button.textContent = label;
  button.addEventListener('click', async () => {
    message.textContent = '';
    try { await handler(); await load(); } catch (error) { message.textContent = error.message; }
  });
  return button;
}

function badge(text, kind) {
  const span = document.createElement('span');
  span.className = `badge ${kind}`;
  span.textContent = text;
  return span;
}

function roleLabel(user) {
  if (user.is_master) return 'Administrador master';
  return user.role === 'admin' ? 'Administrador' : 'Consultor';
}

function render(users) {
  body.replaceChildren();
  users.forEach((user) => {
    const row = document.createElement('tr');

    const emailCell = document.createElement('td');
    emailCell.dataset.col = 'email';
    emailCell.textContent = user.email;

    const roleCell = document.createElement('td');
    roleCell.dataset.col = 'role';
    roleCell.dataset.label = 'Rol';
    roleCell.textContent = roleLabel(user);

    const statusCell = document.createElement('td');
    statusCell.dataset.col = 'status';
    statusCell.dataset.label = 'Estado';
    if (user.lock_state === 'permanent') statusCell.appendChild(badge('Bloqueado: restablecer', 'badge-locked'));
    else if (user.lock_state === 'temporary') statusCell.appendChild(badge(`Bloqueado ${user.lock_minutes} min`, 'badge-locked'));
    else if (!user.active) statusCell.appendChild(badge('Inactivo', 'badge-inactive'));
    else if (user.must_change_password) statusCell.appendChild(badge('Debe cambiar contraseña', 'badge-pending'));
    else statusCell.appendChild(badge('Activo', 'badge-active'));
    if (!user.mfa_enabled) statusCell.appendChild(badge('Falta configurar 2FA', 'badge-pending'));
    if (!user.email_domain_ok) statusCell.appendChild(badge('Correo fuera de @comcesa.net', 'badge-locked'));

    const actions = document.createElement('td');
    actions.dataset.col = 'actions';
    const wrap = document.createElement('div');
    wrap.className = 'inline-actions';
    const allowed = user.permissions;
    if (user.id === me.id) {
      wrap.textContent = 'Tu usuario';
    } else {
      if (allowed.resetPassword) {
        wrap.append(actionButton('Restablecer contraseña', async () => {
          if (!confirm(`¿Generar una nueva contraseña temporal para ${user.email}? También se desbloquea su usuario.`)) throw new Error('');
          const data = await api(`/api/v1/users/${user.id}/reset-password`, { method: 'POST' });
          showTemp(user.email, data.tempPassword);
        }));
      }
      if (allowed.resetPassword && user.mfa_enabled) {
        wrap.append(actionButton('Restablecer 2FA', async () => {
          if (!confirm(`¿Quitar el segundo paso de ${user.email}? En su próximo ingreso tendrá que configurarlo de nuevo (por ejemplo, si perdió el celular).`)) throw new Error('');
          await api(`/api/v1/users/${user.id}/reset-mfa`, { method: 'POST' });
        }));
      }
      if (allowed.unlock && user.lock_state !== 'none') {
        wrap.append(actionButton('Desbloquear', () => api(`/api/v1/users/${user.id}/unlock`, { method: 'POST' })));
      }
      if (allowed.toggleActive) {
        wrap.append(actionButton(user.active ? 'Desactivar' : 'Activar', () => api(`/api/v1/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: !user.active }) })));
      }
      if (allowed.changeRole) {
        wrap.append(actionButton(user.role === 'admin' ? 'Quitar admin' : 'Hacer admin', () => api(`/api/v1/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: user.role === 'admin' ? 'viewer' : 'admin' }) })));
      }
      if (allowed.delete) {
        wrap.append(actionButton('Eliminar', async () => {
          if (!confirm(`¿Eliminar a ${user.email}? Esta acción no se puede deshacer.`)) throw new Error('');
          await api(`/api/v1/users/${user.id}`, { method: 'DELETE' });
        }, 'danger-button'));
      }
      if (!wrap.children.length) {
        const note = document.createElement('span');
        note.className = 'muted-text';
        note.textContent = user.is_master ? 'Protegido (master)' : 'Solo un master puede gestionarlo';
        wrap.append(note);
      }
    }
    actions.appendChild(wrap);

    row.append(emailCell, roleCell, statusCell, actions);
    body.appendChild(row);
  });
}

async function load() {
  render((await api('/api/v1/users')).users);
}

document.querySelector('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  try {
    const data = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({ email: document.querySelector('#new-email').value, role: document.querySelector('#new-role').value }) });
    showTemp(data.user.email, data.tempPassword);
    event.target.reset();
    await load();
  } catch (error) { message.textContent = error.message; }
});

document.querySelector('#copy-temp').addEventListener('click', () => navigator.clipboard.writeText(document.querySelector('#temp-password').textContent));
document.querySelector('#logout-button').addEventListener('click', async () => { await api('/api/v1/auth/logout', { method: 'POST' }); window.location.replace('/login'); });

(async () => {
  try {
    me = (await api('/api/v1/auth/me')).user;
    if (me.role !== 'admin') return window.location.replace('/inventario');
    // Solo un usuario master puede crear administradores.
    if (!me.isMaster) document.querySelector('#new-role option[value="admin"]').remove();
    document.querySelector('#role-hint').textContent = me.isMaster
      ? 'Como usuario master puedes gestionar consultores y administradores.'
      : 'Como administrador puedes gestionar consultores. Para crear o cambiar administradores se necesita un usuario master.';
    await load();
  } catch (error) { if (error.message) message.textContent = error.message; }
})();
