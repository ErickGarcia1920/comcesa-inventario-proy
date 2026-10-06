require('dotenv').config({ override: true });

process.env.NODE_ENV ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret-000000000000000000';
process.env.POSTGRES_HOST ||= 'localhost';
process.env.POSTGRES_PORT ||= '5432';
process.env.POSTGRES_DB ||= 'comcesa';
process.env.POSTGRES_USER ||= 'comcesa';
process.env.POSTGRES_PASSWORD ||= 'test-postgres-password-1234';
process.env.REDIS_URL ||= 'redis://localhost:6379';

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
  await pool.query('DELETE FROM users WHERE email = ANY($1)', [[adminEmail, newEmail]]);
  await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')", [adminEmail, await bcrypt.hash(adminPassword, 4)]);
  server = app.listen(0); baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE email = ANY($1)', [[adminEmail, newEmail]]);
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
