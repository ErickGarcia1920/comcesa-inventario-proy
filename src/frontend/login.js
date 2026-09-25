const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginMessage = document.querySelector('#login-message');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginButton.innerHTML = 'Validando <span class="button-spinner" aria-hidden="true"></span>';
  loginMessage.textContent = '';
  const formData = new FormData(loginForm);

  try {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: formData.get('email'), password: formData.get('password') })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(response.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : (body.message || 'Credenciales invalidas'));
    }
    window.location.assign('/inventario');
  } catch (error) {
    loginMessage.textContent = error.message;
    loginButton.disabled = false;
    loginButton.innerHTML = 'Ingresar <span aria-hidden="true">→</span>';
  }
});