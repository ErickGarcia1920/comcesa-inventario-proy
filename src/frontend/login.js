const $ = (selector) => document.querySelector(selector);
const steps = { login: $('#step-login'), verify: $('#step-verify'), enroll: $('#step-enroll'), recovery: $('#step-recovery') };
let afterLogin = '/inventario';
let recoveryCodes = [];
let recoveryMode = false;

function show(name) {
  Object.entries(steps).forEach(([key, element]) => { element.hidden = key !== name; });
  const focusTarget = { login: '#email', verify: '#verify-code', enroll: '#enable-code' }[name];
  if (focusTarget) $(focusTarget).focus();
}

async function post(url, data) {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 429 ? 'Demasiados intentos. Espera unos minutos.' : (body.message || 'Ocurrió un error'));
    error.code = body.error;
    throw error;
  }
  return body;
}

function busy(button, text) { button.disabled = true; button.dataset.label = button.innerHTML; button.innerHTML = `${text} <span class="button-spinner" aria-hidden="true"></span>`; }
function idle(button) { button.disabled = false; button.innerHTML = button.dataset.label || button.innerHTML; }

function backToLogin(message = '') {
  $('#password').value = '';
  $('#login-message').textContent = message;
  show('login');
}

// ---------- Paso 1: correo y contraseña ----------
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-button');
  busy(button, 'Validando');
  $('#login-message').textContent = '';
  const form = new FormData(event.target);
  try {
    const result = await post('/api/v1/auth/login', { email: form.get('email'), password: form.get('password') });
    if (result.mfaRequired) {
      if (result.stage === 'enroll') await startEnroll(); else startVerify();
    } else {
      window.location.assign(result.mustChangePassword ? '/cambiar-password' : '/inventario');
    }
  } catch (error) {
    $('#login-message').textContent = error.message;
  } finally {
    idle(button);
  }
});

// ---------- Paso 2 (cada ingreso) ----------
function startVerify() {
  recoveryMode = false;
  setRecoveryMode(false);
  $('#verify-code').value = '';
  $('#verify-message').textContent = '';
  show('verify');
}

function setRecoveryMode(on) {
  recoveryMode = on;
  const input = $('#verify-code');
  input.value = '';
  input.maxLength = on ? 11 : 7;
  input.inputMode = on ? 'text' : 'numeric';
  input.placeholder = on ? 'XXXXX-XXXXX' : '123 456';
  input.autocomplete = on ? 'off' : 'one-time-code';
  $('#verify-label').textContent = on ? 'Código de respaldo' : 'Código de 6 dígitos';
  $('#verify-help').innerHTML = on
    ? 'Escribe uno de tus códigos de respaldo. Cada uno sirve una sola vez.'
    : 'Abre <strong>Microsoft Authenticator</strong> y escribe el código de 6 dígitos de <em>COMCESA Inventario</em>.';
  $('#toggle-recovery').textContent = on ? 'Usar el código de la aplicación' : 'Usar un código de respaldo';
}

$('#toggle-recovery').addEventListener('click', () => { $('#verify-message').textContent = ''; setRecoveryMode(!recoveryMode); $('#verify-code').focus(); });
$('#verify-back').addEventListener('click', () => backToLogin());

$('#verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#verify-button');
  busy(button, 'Verificando');
  $('#verify-message').textContent = '';
  const value = $('#verify-code').value;
  try {
    const result = await post('/api/v1/auth/mfa/verify', recoveryMode ? { recoveryCode: value } : { code: value });
    window.location.assign(result.mustChangePassword ? '/cambiar-password' : '/inventario');
  } catch (error) {
    if (error.code === 'MFA_SESSION_EXPIRED' || error.code === 'ACCOUNT_LOCKED' || error.code === 'TEMPORARILY_LOCKED') return backToLogin(error.message);
    $('#verify-message').textContent = error.message;
    $('#verify-code').select();
  } finally {
    idle(button);
  }
});

// Al escribir los 6 dígitos se envía solo (más cómodo en el celular).
$('#verify-code').addEventListener('input', () => {
  if (!recoveryMode && $('#verify-code').value.replace(/\s/g, '').length === 6) $('#verify-form').requestSubmit();
});

// ---------- Paso 2 (primera vez): configurar la aplicación ----------
async function startEnroll() {
  $('#enable-code').value = '';
  $('#enable-message').textContent = '';
  const response = await fetch('/api/v1/auth/mfa/setup', { credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'No se pudo preparar la verificación en dos pasos');
  $('#qr-image').src = body.qr;
  $('#secret-text').textContent = body.secret;
  $('#otpauth-link').href = body.otpauthUrl;
  // En el celular no se puede escanear la propia pantalla: se muestra de una vez la clave para escribir.
  $('.same-phone').open = window.matchMedia('(max-width: 860px)').matches;
  show('enroll');
}

$('#enroll-back').addEventListener('click', () => backToLogin());
$('#copy-secret').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#secret-text').textContent.replace(/\s/g, '')); $('#copy-secret').textContent = 'Clave copiada'; } catch { $('#copy-secret').textContent = 'Copia la clave a mano'; }
});

$('#enable-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#enable-button');
  busy(button, 'Activando');
  $('#enable-message').textContent = '';
  try {
    const result = await post('/api/v1/auth/mfa/enable', { code: $('#enable-code').value });
    afterLogin = result.mustChangePassword ? '/cambiar-password' : '/inventario';
    recoveryCodes = result.recoveryCodes || [];
    showRecovery();
  } catch (error) {
    if (error.code === 'MFA_SESSION_EXPIRED' || error.code === 'ACCOUNT_LOCKED' || error.code === 'TEMPORARILY_LOCKED') return backToLogin(error.message);
    $('#enable-message').textContent = error.message;
    $('#enable-code').select();
  } finally {
    idle(button);
  }
});

$('#enable-code').addEventListener('input', () => {
  if ($('#enable-code').value.replace(/\s/g, '').length === 6) $('#enable-form').requestSubmit();
});

// ---------- Códigos de respaldo (se muestran una sola vez) ----------
function showRecovery() {
  const list = $('#recovery-list');
  list.replaceChildren(...recoveryCodes.map((code) => { const item = document.createElement('li'); item.textContent = code; return item; }));
  show('recovery');
}

$('#copy-recovery').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(recoveryCodes.join('\n')); $('#copy-recovery').textContent = 'Códigos copiados'; } catch { $('#copy-recovery').textContent = 'Cópialos a mano'; }
});

$('#download-recovery').addEventListener('click', () => {
  const text = `COMCESA Inventario - códigos de respaldo\nCada código sirve una sola vez. Guárdalos en un lugar seguro.\n\n${recoveryCodes.join('\n')}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'comcesa-codigos-de-respaldo.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

$('#recovery-saved').addEventListener('change', () => { $('#recovery-continue').disabled = !$('#recovery-saved').checked; });
$('#recovery-continue').addEventListener('click', () => window.location.assign(afterLogin));
