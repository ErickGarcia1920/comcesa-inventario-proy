const form = document.querySelector('#form');
const message = document.querySelector('#message');
const button = document.querySelector('#submit');

fetch('/api/v1/auth/me', { credentials: 'same-origin' }).then((r) => { if (r.status === 401) window.location.replace('/login'); });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  if (document.querySelector('#new').value !== document.querySelector('#confirm').value) {
    message.textContent = 'Las contraseñas nuevas no coinciden';
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch('/api/v1/auth/change-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: document.querySelector('#current').value, newPassword: document.querySelector('#new').value })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || 'No fue posible cambiar la contraseña');
    }
    window.location.assign('/inventario');
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
