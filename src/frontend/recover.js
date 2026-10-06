const form = document.querySelector('#form');
const message = document.querySelector('#message');
const fields = document.querySelector('#reset-fields');

async function post(url, data) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : (body.message || 'Ocurrió un error'));
  return body;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  try {
    const body = await post('/api/v1/auth/forgot', { email: document.querySelector('#email').value });
    fields.hidden = false;
    message.textContent = body.emailEnabled
      ? 'Si el correo existe, te enviamos un código (vence en 15 minutos). Revisa también spam.'
      : 'El envío por correo no está activo. Pide a un administrador que restablezca tu contraseña.';
  } catch (error) { message.textContent = error.message; }
});

document.querySelector('#reset').addEventListener('click', async () => {
  message.textContent = '';
  try {
    await post('/api/v1/auth/reset', {
      email: document.querySelector('#email').value,
      code: document.querySelector('#code').value,
      newPassword: document.querySelector('#new').value
    });
    window.location.assign('/login');
  } catch (error) { message.textContent = error.message; }
});
