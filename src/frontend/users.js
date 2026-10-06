const body = document.querySelector('#users-body');
const message = document.querySelector('#message');
const tempBox = document.querySelector('#temp-box');
let me;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
  if (response.status === 401) { window.location.replace('/login'); throw new Error('UNAUTHENTICATED'); }
  if (response.status === 403) {
    const data = await response.clone().json().catch(() => ({}));
    if (data.error === 'PASSWORD_CHANGE_REQUIRED') window.location.replace('/cambiar-password');
    else window.location.replace('/inventario');
    throw new Error(data.message || 'Sin permiso');
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

function actionButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'page-button small-button';
  button.textContent = label;
  button.addEventListener('click', async () => {
    message.textContent = '';
    try { await handler(); await load(); } catch (error) { message.textContent = error.message; }
  });
  return button;
}

function render(users) {
  body.replaceChildren();
  users.forEach((user) => {
    const row = document.createElement('tr');
    const status = !user.active ? 'Inactivo' : (user.must_change_password ? 'Pendiente de cambiar contraseña' : 'Activo');
    [user.email, user.role === 'admin' ? 'Administrador' : 'Consulta', status].forEach((value) => {
      const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
    });
    const actions = document.createElement('td');
    actions.className = 'inline-actions';
    if (user.id !== me.id) {
      actions.append(
        actionButton('Restablecer contraseña', async () => {
          if (!confirm(`¿Generar una nueva contraseña temporal para ${user.email}?`)) throw new Error('');
          const data = await api(`/api/v1/users/${user.id}/reset-password`, { method: 'POST' });
          showTemp(user.email, data.tempPassword);
        }),
        actionButton(user.active ? 'Desactivar' : 'Activar', () => api(`/api/v1/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: !user.active }) })),
        actionButton(user.role === 'admin' ? 'Quitar admin' : 'Hacer admin', () => api(`/api/v1/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: user.role === 'admin' ? 'viewer' : 'admin' }) })),
        actionButton('Eliminar', async () => {
          if (!confirm(`¿Eliminar a ${user.email}? Esta acción no se puede deshacer.`)) throw new Error('');
          await api(`/api/v1/users/${user.id}`, { method: 'DELETE' });
        })
      );
    } else {
      actions.textContent = '(tu usuario)';
    }
    row.appendChild(actions);
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
    await load();
  } catch (error) { if (error.message) message.textContent = error.message; }
})();
