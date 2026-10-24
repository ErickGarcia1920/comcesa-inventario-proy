require('dotenv').config({ override: true });

process.env.NODE_ENV ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret-000000000000000000';
process.env.POSTGRES_HOST ||= 'localhost';
process.env.POSTGRES_PORT ||= '5432';
process.env.POSTGRES_DB ||= 'comcesa';
process.env.POSTGRES_USER ||= 'comcesa';
process.env.POSTGRES_PASSWORD ||= 'test-postgres-password-1234';
process.env.REDIS_URL ||= 'redis://localhost:6379';
// Usuarios master solo para estas pruebas.
process.env.MASTER_EMAILS = 'master1-users-test@comcesa.local,master2-users-test@comcesa.local,master3-users-test@comcesa.local';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const { pool } = require('../../src/backend/config/database');
const { ensureDatabaseSchema } = require('../../src/backend/config/schema');
const { redis } = require('../../src/backend/config/redis');
const app = require('../../src/backend/app');

const adminEmail = 'admin-users-test@comcesa.local';
const adminPassword = 'Admin-prueba-2026!';
const newEmail = 'nuevo-users-test@comcesa.local';
let server; let baseUrl;

function client() {
  let cookie;
  return async function call(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

before(async () => {
  await ensureDatabaseSchema();
  await pool.query("DELETE FROM users WHERE email LIKE '%-users-test@comcesa.local'");
  await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')", [adminEmail, await bcrypt.hash(adminPassword, 4)]);
  server = app.listen(0); baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query("DELETE FROM users WHERE email LIKE '%-users-test@comcesa.local'");
  await new Promise((resolve) => server.close(resolve));
  await pool.end(); redis.disconnect();
});

test('flujo completo: crear usuario, cambio obligatorio, reset y eliminación', async () => {
  const admin = client();
  assert.equal((await admin('/api/v1/auth/login', { method: 'POST', body: { email: adminEmail, password: adminPassword } })).status, 200);

  const created = await admin('/api/v1/users', { method: 'POST', body: { email: newEmail, role: 'viewer' } });
  assert.equal(created.status, 201);
  const tempPassword = created.body.tempPassword;
  assert.ok(tempPassword.length >= 12);
  assert.equal((await admin('/api/v1/users', { method: 'POST', body: { email: newEmail } })).status, 409);

  const user = client();
  const login = await user('/api/v1/auth/login', { method: 'POST', body: { email: newEmail, password: tempPassword } });
  assert.equal(login.body.mustChangePassword, true);
  assert.equal((await user('/api/v1/inventory')).body.error, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await user('/api/v1/users')).status, 403);

  assert.equal((await user('/api/v1/auth/change-password', { method: 'POST', body: { currentPassword: tempPassword, newPassword: 'corta1' } })).status, 400);
  assert.equal((await user('/api/v1/auth/change-password', { method: 'POST', body: { currentPassword: tempPassword, newPassword: 'MiClaveNueva2026' } })).status, 204);
  assert.equal((await user('/api/v1/inventory')).status, 200);
  assert.equal((await user('/api/v1/users')).status, 403);

  const list = await admin('/api/v1/users');
  const id = list.body.users.find((u) => u.email === newEmail).id;
  const reset = await admin(`/api/v1/users/${id}/reset-password`, { method: 'POST' });
  assert.equal(reset.status, 200);
  const again = client();
  assert.equal((await again('/api/v1/auth/login', { method: 'POST', body: { email: newEmail, password: reset.body.tempPassword } })).body.mustChangePassword, true);

  assert.equal((await admin(`/api/v1/users/${id}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await user('/api/v1/inventory')).status, 401);

  const me = (await admin('/api/v1/auth/me')).body.user;
  assert.equal((await admin(`/api/v1/users/${me.id}`, { method: 'DELETE' })).status, 400);
  assert.equal((await admin(`/api/v1/users/${id}`, { method: 'DELETE' })).status, 204);
});

test('recuperación: responde igual aunque el correo no exista y rechaza códigos falsos', async () => {
  const anon = client();
  assert.equal((await anon('/api/v1/auth/forgot', { method: 'POST', body: { email: 'nadie@comcesa.local' } })).status, 200);
  assert.equal((await anon('/api/v1/auth/reset', { method: 'POST', body: { email: adminEmail, code: '123456', newPassword: 'OtraClave2026x' } })).status, 400);
});

const PASSWORD = 'Clave-de-prueba-2026';
const em = (name) => `${name}-users-test@comcesa.local`;
async function insertUser(email, role) {
  await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = TRUE', [email, await bcrypt.hash(PASSWORD, 4), role]);
}
async function loginAs(email) {
  const call = client();
  const result = await call('/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(result.status, 200, `login de ${email}`);
  return call;
}
const idOf = async (call, email) => (await call('/api/v1/users')).body.users.find((u) => u.email === email).id;

test('perfiles: un administrador solo gestiona consultores', async () => {
  await insertUser(em('master1'), 'admin');
  await insertUser(em('admin2'), 'admin');
  await insertUser(em('consultor'), 'viewer');
  await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [await bcrypt.hash(PASSWORD, 4), adminEmail]);
  const admin = await loginAs(adminEmail);

  // No puede crear administradores ni masters
  assert.equal((await admin('/api/v1/users', { method: 'POST', body: { email: em('nuevoadmin'), role: 'admin' } })).status, 403);
  assert.equal((await admin('/api/v1/users', { method: 'POST', body: { email: em('master3'), role: 'viewer' } })).status, 403);
  // Sí puede crear consultores
  assert.equal((await admin('/api/v1/users', { method: 'POST', body: { email: em('nuevoconsultor'), role: 'viewer' } })).status, 201);

  const consultorId = await idOf(admin, em('consultor'));
  const admin2Id = await idOf(admin, em('admin2'));
  const master1Id = await idOf(admin, em('master1'));

  // No puede tocar a otros administradores ni a masters
  for (const id of [admin2Id, master1Id]) {
    assert.equal((await admin(`/api/v1/users/${id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await admin(`/api/v1/users/${id}/reset-password`, { method: 'POST' })).status, 403);
    assert.equal((await admin(`/api/v1/users/${id}`, { method: 'PATCH', body: { active: false } })).status, 403);
    assert.equal((await admin(`/api/v1/users/${id}/unlock`, { method: 'POST' })).status, 403);
  }
  // No puede ascender a un consultor a administrador
  assert.equal((await admin(`/api/v1/users/${consultorId}`, { method: 'PATCH', body: { role: 'admin' } })).status, 403);

  // La lista le indica qué puede hacer con cada uno
  const users = (await admin('/api/v1/users')).body.users;
  const perms = (email) => users.find((u) => u.email === email).permissions;
  assert.deepEqual(perms(em('admin2')), { delete: false, toggleActive: false, changeRole: false, resetPassword: false, unlock: false });
  assert.deepEqual(perms(em('master1')), { delete: false, toggleActive: false, changeRole: false, resetPassword: false, unlock: false });
  assert.deepEqual(perms(em('consultor')), { delete: true, toggleActive: true, changeRole: false, resetPassword: true, unlock: true });
  assert.equal(users.find((u) => u.email === em('master1')).is_master, true);
  assert.equal(users.find((u) => u.email === em('admin2')).is_master, false);

  // Sí puede gestionar consultores
  assert.equal((await admin(`/api/v1/users/${consultorId}/reset-password`, { method: 'POST' })).status, 200);
  assert.equal((await admin(`/api/v1/users/${consultorId}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await admin(`/api/v1/users/${consultorId}`, { method: 'DELETE' })).status, 204);
});

test('perfiles: el usuario master gestiona administradores y nadie elimina a un master', async () => {
  await insertUser(em('master1'), 'admin');
  await insertUser(em('master2'), 'admin');
  await insertUser(em('admin3'), 'admin');
  await insertUser(em('consultor2'), 'viewer');
  const master = await loginAs(em('master1'));

  const me = (await master('/api/v1/auth/me')).body.user;
  assert.equal(me.isMaster, true);

  // Crea administradores; un correo master siempre nace como administrador
  const createdAdmin = await master('/api/v1/users', { method: 'POST', body: { email: em('creadoadmin'), role: 'admin' } });
  assert.equal(createdAdmin.status, 201);
  assert.equal(createdAdmin.body.user.role, 'admin');
  const createdMaster = await master('/api/v1/users', { method: 'POST', body: { email: em('master3'), role: 'viewer' } });
  assert.equal(createdMaster.status, 201);
  assert.equal(createdMaster.body.user.role, 'admin');
  assert.equal(createdMaster.body.user.is_master, true);

  // Asciende y degrada
  const consultorId = await idOf(master, em('consultor2'));
  assert.equal((await master(`/api/v1/users/${consultorId}`, { method: 'PATCH', body: { role: 'admin' } })).body.user.role, 'admin');
  assert.equal((await master(`/api/v1/users/${consultorId}`, { method: 'PATCH', body: { role: 'viewer' } })).body.user.role, 'viewer');

  // Gestiona a otro administrador
  const admin3Id = await idOf(master, em('admin3'));
  assert.equal((await master(`/api/v1/users/${admin3Id}/reset-password`, { method: 'POST' })).status, 200);
  assert.equal((await master(`/api/v1/users/${admin3Id}`, { method: 'DELETE' })).status, 204);

  // Protección de masters: ni otro master puede eliminarlos, desactivarlos ni quitarles el rol
  const master2Id = await idOf(master, em('master2'));
  assert.equal((await master(`/api/v1/users/${master2Id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await master(`/api/v1/users/${master2Id}`, { method: 'PATCH', body: { active: false } })).status, 403);
  assert.equal((await master(`/api/v1/users/${master2Id}`, { method: 'PATCH', body: { role: 'viewer' } })).status, 403);
  // pero otro master sí puede restablecer su contraseña
  assert.equal((await master(`/api/v1/users/${master2Id}/reset-password`, { method: 'POST' })).status, 200);
  // y nadie puede actuar sobre sí mismo
  assert.equal((await master(`/api/v1/users/${me.id}`, { method: 'DELETE' })).status, 400);
});

test('al iniciar, los usuarios master quedan siempre como administradores', async () => {
  await insertUser(em('master3'), 'viewer');
  await ensureDatabaseSchema();
  const { rows } = await pool.query('SELECT role FROM users WHERE email = $1', [em('master3')]);
  assert.equal(rows[0].role, 'admin');
});

test('bloqueo: 3 intentos = 15 min; otros 3 = 15 min; otros 3 = bloqueado hasta que un administrador lo restablezca', async () => {
  await insertUser(em('bloqueo'), 'viewer');
  const attempt = (password) => client()('/api/v1/auth/login', { method: 'POST', body: { email: em('bloqueo'), password } });
  const expireLock = () => pool.query("UPDATE users SET locked_until = NOW() - INTERVAL '1 minute' WHERE email = $1", [em('bloqueo')]);
  const state = async () => (await pool.query('SELECT failed_attempts, lockout_level, locked_permanently FROM users WHERE email = $1', [em('bloqueo')])).rows[0];

  // Ronda 1: dos intentos fallidos solo avisan; el tercero bloquea 15 minutos
  assert.equal((await attempt('mala-1')).status, 401);
  assert.equal((await attempt('mala-2')).status, 401);
  const third = await attempt('mala-3');
  assert.equal(third.status, 423);
  assert.equal(third.body.error, 'TEMPORARILY_LOCKED');
  assert.match(third.body.message, /15 minutos/);
  // Mientras dure el bloqueo, ni la contraseña correcta entra
  const during = await attempt(PASSWORD);
  assert.equal(during.status, 423);
  assert.match(during.body.message, /Intenta de nuevo en/);

  // Ronda 2: pasan los 15 minutos y vuelve a tener 3 oportunidades
  await expireLock();
  assert.equal((await attempt('mala-4')).status, 401);
  assert.equal((await attempt('mala-5')).status, 401);
  assert.equal((await attempt('mala-6')).status, 423);
  assert.equal((await state()).lockout_level, 2);
  assert.equal((await attempt(PASSWORD)).status, 423);

  // Ronda 3: otros 3 intentos fallidos y queda bloqueado hasta que un administrador intervenga
  await expireLock();
  assert.equal((await attempt('mala-7')).status, 401);
  assert.equal((await attempt('mala-8')).status, 401);
  const last = await attempt('mala-9');
  assert.equal(last.status, 423);
  assert.equal(last.body.error, 'ACCOUNT_LOCKED');
  assert.match(last.body.message, /Contacta al administrador/);
  assert.equal((await state()).locked_permanently, true);

  // Ya no sirve esperar ni la contraseña correcta
  await expireLock();
  const afterWait = await attempt(PASSWORD);
  assert.equal(afterWait.status, 423);
  assert.equal(afterWait.body.error, 'ACCOUNT_LOCKED');

  // El administrador restablece la contraseña: se desbloquea y obliga a cambiarla
  const admin = client();
  await admin('/api/v1/auth/login', { method: 'POST', body: { email: adminEmail, password: PASSWORD } });
  const id = await idOf(admin, em('bloqueo'));
  const listed = (await admin('/api/v1/users')).body.users.find((u) => u.id === id);
  assert.equal(listed.lock_state, 'permanent');
  const reset = await admin(`/api/v1/users/${id}/reset-password`, { method: 'POST' });
  assert.equal(reset.status, 200);
  const back = await attempt(reset.body.tempPassword);
  assert.equal(back.status, 200);
  assert.equal(back.body.mustChangePassword, true);
  assert.deepEqual(await state(), { failed_attempts: 0, lockout_level: 0, locked_permanently: false });
});

test('bloqueo: un ingreso correcto reinicia el conteo y el administrador puede desbloquear sin cambiar la contraseña', async () => {
  await insertUser(em('conteo'), 'viewer');
  const attempt = (password) => client()('/api/v1/auth/login', { method: 'POST', body: { email: em('conteo'), password } });

  assert.equal((await attempt('mala')).status, 401);
  assert.equal((await attempt('mala')).status, 401);
  assert.equal((await attempt(PASSWORD)).status, 200);
  // Después de entrar bien, vuelve a tener 3 oportunidades completas
  assert.equal((await attempt('mala')).status, 401);
  assert.equal((await attempt('mala')).status, 401);
  assert.equal((await attempt(PASSWORD)).status, 200);

  assert.equal((await attempt('mala')).status, 401);
  assert.equal((await attempt('mala')).status, 401);
  assert.equal((await attempt('mala')).status, 423);
  const admin = client();
  await admin('/api/v1/auth/login', { method: 'POST', body: { email: adminEmail, password: PASSWORD } });
  const id = await idOf(admin, em('conteo'));
  assert.equal((await admin(`/api/v1/users/${id}/unlock`, { method: 'POST' })).body.user.lock_state, 'none');
  assert.equal((await attempt(PASSWORD)).status, 200);
});
