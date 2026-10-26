require('dotenv').config({ override: true });

process.env.NODE_ENV ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret-000000000000000000';
process.env.POSTGRES_HOST ||= 'localhost';
process.env.POSTGRES_PORT ||= '5432';
process.env.POSTGRES_DB ||= 'comcesa';
process.env.POSTGRES_USER ||= 'comcesa';
process.env.POSTGRES_PASSWORD ||= 'test-postgres-password-1234';
process.env.REDIS_URL ||= 'redis://localhost:6379';
// En estas pruebas el segundo paso es obligatorio (es la configuración normal).
process.env.MFA_REQUIRED = 'true';
process.env.MASTER_EMAILS = 'master-mfa-test@comcesa.net';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const { pool } = require('../../src/backend/config/database');
const { ensureDatabaseSchema } = require('../../src/backend/config/schema');
const { redis } = require('../../src/backend/config/redis');
const app = require('../../src/backend/app');
const totp = require('../../src/backend/services/totpService');
const { encryptSecret } = require('../../src/backend/services/mfaCrypto');

const PASSWORD = 'Clave-de-prueba-2026';
const em = (name) => `${name}-mfa-test@comcesa.net`;
let server; let baseUrl;

// Cliente que guarda TODAS las cookies (la de sesión y la del segundo paso).
function client() {
  const jar = new Map();
  async function call(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(line)) jar.delete(name); else jar.set(name, value);
    }
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed, response };
  }
  call.jar = jar;
  return call;
}

async function insertUser(email, role = 'viewer') {
  await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = TRUE, password_hash = EXCLUDED.password_hash, totp_enabled = FALSE, totp_secret_enc = NULL, totp_last_step = NULL`,
    [email, await bcrypt.hash(PASSWORD, 4), role]
  );
}

// Deja al usuario con el segundo paso ya configurado (atajo para las pruebas que no son del alta).
async function enrolled(email, role = 'viewer') {
  await insertUser(email, role);
  const secret = totp.generateSecret();
  await pool.query('UPDATE users SET totp_secret_enc = $2, totp_enabled = TRUE, totp_last_step = NULL WHERE email = $1', [email, encryptSecret(secret)]);
  return secret;
}

async function loginFull(email, secret) {
  await pool.query('UPDATE users SET totp_last_step = NULL WHERE email = $1', [email]);
  const call = client();
  const first = await call('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(first.status, 200, `login de ${email}`);
  assert.equal(first.body.stage, 'verify');
  const second = await call('/api/v1/auth/mfa/verify', { method: 'POST', body: { code: totp.generateCode(secret) } });
  assert.equal(second.status, 200, `segundo paso de ${email}`);
  return call;
}

const otherCode = (secret) => {
  const good = totp.generateCode(secret);
  return good === '000000' ? '111111' : '000000';
};

before(async () => {
  await ensureDatabaseSchema();
  await pool.query("DELETE FROM users WHERE email LIKE '%-mfa-test@comcesa.net'");
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE '%-mfa-test@comcesa.net'");
  server.close();
  await pool.end();
  await redis.quit();
});

const shared = {};

test('primer ingreso: la contraseña sola no entra; se configura la aplicación y se entregan códigos de respaldo', async () => {
  await insertUser(em('nuevo'));
  const call = client();
  const login = await call('/api/v1/auth/login', { method: 'POST', body: { email: em('nuevo'), password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.deepEqual([login.body.mfaRequired, login.body.stage], [true, 'enroll']);
  assert.equal(call.jar.has('comcesa_session'), false, 'todavía no hay sesión');
  assert.equal((await call('/api/v1/auth/me')).status, 401);

  // La cookie del segundo paso es corta, solo para HTTP y limitada a su ruta
  const cookieLine = login.response.headers.getSetCookie().find((line) => line.startsWith('comcesa_mfa='));
  assert.match(cookieLine, /HttpOnly/i);
  assert.match(cookieLine, /SameSite=Strict/i);
  assert.match(cookieLine, /Path=\/api\/v1\/auth\/mfa/);

  const setup = await call('/api/v1/auth/mfa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.body.qr, /^data:image\/gif;base64,/);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const secret = setup.body.secret.replace(/\s/g, '');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal((await call('/api/v1/auth/mfa/setup')).body.secret, setup.body.secret, 'al recargar sigue la misma clave');

  const wrong = await call('/api/v1/auth/mfa/enable', { method: 'POST', body: { code: otherCode(secret) } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'INVALID_CODE');

  const enable = await call('/api/v1/auth/mfa/enable', { method: 'POST', body: { code: totp.generateCode(secret) } });
  assert.equal(enable.status, 200);
  assert.equal(enable.body.recoveryCodes.length, 10);
  assert.ok(enable.body.recoveryCodes.every((code) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(code)));
  assert.equal((await call('/api/v1/auth/me')).status, 200);

  const { rows } = await pool.query('SELECT totp_enabled, totp_secret_enc FROM users WHERE email = $1', [em('nuevo')]);
  assert.equal(rows[0].totp_enabled, true);
  assert.ok(!rows[0].totp_secret_enc.includes(secret), 'el secreto no se guarda en claro');
  const recovery = await pool.query('SELECT COUNT(*)::int AS n FROM mfa_recovery_codes mrc JOIN users u ON u.id = mrc.user_id WHERE u.email = $1 AND mrc.used_at IS NULL', [em('nuevo')]);
  assert.equal(recovery.rows[0].n, 10);
  Object.assign(shared, { secret, recoveryCodes: enable.body.recoveryCodes });
});

test('ingresos siguientes: piden el código y un código usado no se puede reutilizar', async () => {
  const email = em('nuevo');
  const first = client();
  const login = await first('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.deepEqual([login.body.mfaRequired, login.body.stage], [true, 'verify']);
  assert.equal((await first('/api/v1/auth/mfa/verify', { method: 'POST', body: { code: otherCode(shared.secret) } })).status, 401);

  // El código del periodo siguiente es válido (tolera diferencia de reloj) y aún no se había usado
  const nextCode = totp.generateCode(shared.secret, Date.now() + 30000);
  assert.equal((await first('/api/v1/auth/mfa/verify', { method: 'POST', body: { code: nextCode } })).status, 200);
  assert.equal((await first('/api/v1/auth/me')).status, 200);

  const replay = client();
  await replay('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  const again = await replay('/api/v1/auth/mfa/verify', { method: 'POST', body: { code: nextCode } });
  assert.equal(again.status, 401, 'el mismo código no sirve dos veces');
});

test('códigos de respaldo: cada uno sirve una sola vez y se aceptan en minúsculas y sin guion', async () => {
  const email = em('nuevo');
  const useCode = async (recoveryCode) => {
    const call = client();
    await call('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    return call('/api/v1/auth/mfa/verify', { method: 'POST', body: { recoveryCode } });
  };
  const first = await useCode(shared.recoveryCodes[0]);
  assert.equal(first.status, 200);
  assert.equal(first.body.recoveryCodesLeft, 9);
  assert.equal((await useCode(shared.recoveryCodes[0])).status, 401, 'ya se usó');
  const relaxed = await useCode(shared.recoveryCodes[1].toLowerCase().replace('-', ''));
  assert.equal(relaxed.status, 200);
  assert.equal(relaxed.body.recoveryCodesLeft, 8);
});

test('un código incorrecto cuenta para el bloqueo: 3 fallos = 15 minutos, aun con la contraseña correcta', async () => {
  const email = em('bloqueo');
  const secret = await enrolled(email);
  const call = client();
  assert.equal((await call('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.stage, 'verify');
  const bad = () => call('/api/v1/auth/mfa/verify', { method: 'POST', body: { code: otherCode(secret) } });
  assert.equal((await bad()).status, 401);
  assert.equal((await bad()).status, 401);
  const third = await bad();
  assert.equal(third.status, 423);
  assert.equal(third.body.error, 'TEMPORARILY_LOCKED');

  const again = await client()('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(again.status, 423);

  await pool.query("UPDATE users SET locked_until = NOW() - INTERVAL '1 minute' WHERE email = $1", [email]);
  const ok = await loginFull(email, secret);
  assert.equal((await ok('/api/v1/auth/me')).status, 200);
});

test('sin haber puesto la contraseña no se puede usar ninguna pantalla del segundo paso', async () => {
  const anonymous = client();
  assert.equal((await anonymous('/api/v1/auth/mfa/verify', { method: 'POST', body: { code: '123456' } })).body.error, 'MFA_SESSION_EXPIRED');
  assert.equal((await anonymous('/api/v1/auth/mfa/setup')).status, 401);
  assert.equal((await anonymous('/api/v1/auth/mfa/enable', { method: 'POST', body: { code: '123456' } })).status, 401);

  // Un usuario que ya tiene el segundo paso no puede pedir una clave nueva
  const email = em('yaconfigurado');
  await enrolled(email);
  const call = client();
  await call('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal((await call('/api/v1/auth/mfa/setup')).status, 401);
});

test('un administrador restablece el segundo paso según sus permisos', async () => {
  const adminSecret = await enrolled(em('admin'), 'admin');
  await enrolled(em('admin2'), 'admin');
  await enrolled(em('consultor'), 'viewer');
  const masterSecret = await enrolled(em('master'), 'admin');
  const admin = await loginFull(em('admin'), adminSecret);

  const users = (await admin('/api/v1/users')).body.users;
  const find = (name) => users.find((user) => user.email === em(name));
  assert.equal(find('consultor').mfa_enabled, true);

  assert.equal((await admin(`/api/v1/users/${find('consultor').id}/reset-mfa`, { method: 'POST' })).body.user.mfa_enabled, false);
  assert.equal((await admin(`/api/v1/users/${find('admin2').id}/reset-mfa`, { method: 'POST' })).status, 403);
  assert.equal((await admin(`/api/v1/users/${find('master').id}/reset-mfa`, { method: 'POST' })).status, 403);
  assert.equal((await admin(`/api/v1/users/${find('admin').id}/reset-mfa`, { method: 'POST' })).status, 400);

  // La persona a la que se le restableció debe configurar de nuevo en su próximo ingreso
  const relogin = await client()('/api/v1/auth/login', { method: 'POST', body: { email: em('consultor'), password: PASSWORD } });
  assert.equal(relogin.body.stage, 'enroll');

  const master = await loginFull(em('master'), masterSecret);
  assert.equal((await master(`/api/v1/users/${find('admin2').id}/reset-mfa`, { method: 'POST' })).status, 200);
  const stored = await pool.query('SELECT totp_enabled, totp_secret_enc FROM users WHERE email = $1', [em('admin2')]);
  assert.deepEqual([stored.rows[0].totp_enabled, stored.rows[0].totp_secret_enc], [false, null]);
});

test('los usuarios nuevos solo pueden ser correos @comcesa.net', async () => {
  const adminSecret = await enrolled(em('admincorreo'), 'admin');
  const admin = await loginFull(em('admincorreo'), adminSecret);
  for (const email of ['persona@gmail.com', 'persona@comcesa.net.evil.com', 'persona@mail.comcesa.net', 'persona@comcesa.com', '@comcesa.net', 'sin-arroba']) {
    const result = await admin('/api/v1/users', { method: 'POST', body: { email, role: 'viewer' } });
    assert.equal(result.status, 400, email);
    assert.equal(result.body.error, 'INVALID_EMAIL_DOMAIN', email);
  }
  const created = await admin('/api/v1/users', { method: 'POST', body: { email: `Persona-Nueva-mfa-test@COMCESA.NET`, role: 'viewer' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.email, 'persona-nueva-mfa-test@comcesa.net');
  assert.equal(created.body.user.email_domain_ok, true);
  assert.equal(created.body.user.mfa_enabled, false);
});

test('interruptor de emergencia: MFA_REQUIRED=false permite entrar solo con contraseña', async () => {
  await insertUser(em('emergencia'));
  process.env.MFA_REQUIRED = 'false';
  try {
    const call = client();
    const login = await call('/api/v1/auth/login', { method: 'POST', body: { email: em('emergencia'), password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(login.body.mfaRequired, undefined);
    assert.equal((await call('/api/v1/auth/me')).status, 200);
  } finally {
    process.env.MFA_REQUIRED = 'true';
  }
  const normal = await client()('/api/v1/auth/login', { method: 'POST', body: { email: em('emergencia'), password: PASSWORD } });
  assert.equal(normal.body.mfaRequired, true);
});
