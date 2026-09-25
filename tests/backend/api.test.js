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

const testEmail = 'automated-test@comcesa.local';
const testPassword = 'Prueba-segura-2026!';
let server;
let baseUrl;
let sessionCookie;

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (sessionCookie) headers.cookie = sessionCookie;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { response, body };
}

async function login() {
  const { response } = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: testPassword })
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  sessionCookie = setCookie.split(';')[0];
}

before(async () => {
  await ensureDatabaseSchema();
  const passwordHash = await bcrypt.hash(testPassword, 12);
  await pool.query(`
    INSERT INTO users (email, password_hash, role, active)
    VALUES ($1, $2, 'admin', TRUE)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE
  `, [testEmail, passwordHash]);
  await pool.query(`
    INSERT INTO inve (cve_art, descr, lin_prod, uni_med)
    VALUES ('TEST-001', 'Articulo de prueba', 'PRUEBAS', 'PZA'), ('TEST-002', 'Filtro demo', 'FILTRACION', 'PZA')
    ON CONFLICT (cve_art) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO mult (cve_art, cve_alm, status, ctrl_alm, exist)
    VALUES ('TEST-001', 91, 'A', 'BODEGA-PRUEBA', 15), ('TEST-002', 92, 'I', 'BODEGA-INACTIVA', 0)
    ON CONFLICT (cve_art, cve_alm) DO NOTHING
  `);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await pool.query('DELETE FROM mult WHERE cve_art LIKE $1', ['TEST-%']);
  await pool.query('DELETE FROM inve WHERE cve_art LIKE $1', ['TEST-%']);
  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
  server.close();
  await pool.end();
  if (redis.status !== 'wait' && redis.status !== 'end') await redis.quit();
});

test('CP-01 health responde correctamente', async () => {
  const { response, body } = await request('/api/v1/health');
  assert.equal(response.status, 200); assert.equal(body.status, 'ok');
});

test('CP-02 readiness confirma PostgreSQL y Redis', async () => {
  const { response, body } = await request('/api/v1/ready');
  assert.equal(response.status, 200); assert.equal(body.status, 'ready');
});

test('CP-03 la página de login se sirve', async () => {
  const { response, body } = await request('/login');
  assert.equal(response.status, 200); assert.match(body, /login-form/);
});

test('CP-04 la página de inventario se sirve separada', async () => {
  const { response, body } = await request('/inventario');
  assert.equal(response.status, 200); assert.match(body, /filters-form/); assert.doesNotMatch(body, /login-form/);
});

test('CP-05 una ruta inexistente devuelve 404', async () => {
  const { response, body } = await request('/ruta-inexistente');
  assert.equal(response.status, 404); assert.equal(body.error, 'NOT_FOUND');
});

test('CP-06 login sin datos devuelve 400', async () => {
  const { response } = await request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400);
});

test('CP-07 login con contraseña incorrecta devuelve 401', async () => {
  const { response } = await request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: testEmail, password: 'incorrecta-2026!' }) });
  assert.equal(response.status, 401);
});

test('CP-08 login válido crea una sesión', async () => {
  await login(); assert.match(sessionCookie, /^comcesa_session=/);
});

test('CP-09 la cookie de sesión tiene HttpOnly y SameSite', async () => {
  const { response } = await request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: testEmail, password: testPassword }) });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
});

test('CP-10 me devuelve el usuario autenticado', async () => {
  const { response, body } = await request('/api/v1/auth/me');
  assert.equal(response.status, 200); assert.equal(body.user.email, testEmail);
});

test('CP-11 inventario exige autenticación', async () => {
  const oldCookie = sessionCookie; sessionCookie = undefined;
  const { response } = await request('/api/v1/inventory');
  sessionCookie = oldCookie; assert.equal(response.status, 401);
});

test('CP-12 inventario devuelve resultados paginados', async () => {
  const { response, body } = await request('/api/v1/inventory?limit=2');
  assert.equal(response.status, 200); assert.ok(Array.isArray(body.items)); assert.equal(body.limit, 2);
});

test('CP-13 filtro de búsqueda encuentra artículo', async () => {
  const { body } = await request('/api/v1/inventory?search=TEST-001');
  assert.ok(body.items.some((item) => item.article === 'TEST-001'));
});

test('CP-14 filtro por bodega funciona', async () => {
  const { body } = await request('/api/v1/inventory?warehouse=91');
  assert.ok(body.items.length > 0); assert.ok(body.items.every((item) => item.warehouse === 91));
});

test('CP-15 filtro por línea funciona', async () => {
  const { body } = await request('/api/v1/inventory?line=PRUEBAS');
  assert.ok(body.items.some((item) => item.line === 'PRUEBAS'));
});

test('CP-16 filtro por estado funciona', async () => {
  const { body } = await request('/api/v1/inventory?status=I');
  assert.ok(body.items.some((item) => item.status === 'I'));
});

test('CP-17 ordenamiento descendente funciona', async () => {
  const { body } = await request('/api/v1/inventory?sort=stock&direction=desc');
  const stocks = body.items.map((item) => Number(item.stock));
  assert.deepEqual(stocks, [...stocks].sort((a, b) => b - a));
});

test('CP-18 límite máximo de paginación es validado', async () => {
  const { response } = await request('/api/v1/inventory?limit=101');
  assert.equal(response.status, 400);
});

test('CP-19 bodega inválida es rechazada', async () => {
  const { response } = await request('/api/v1/inventory?warehouse=-1');
  assert.equal(response.status, 400);
});

test('CP-20 búsqueda con caracteres SQL no rompe la consulta', async () => {
  const { response } = await request('/api/v1/inventory?search=%27%20OR%201%3D1--');
  assert.equal(response.status, 200);
});

test('CP-21 búsqueda sin coincidencias devuelve lista vacía', async () => {
  const { response, body } = await request('/api/v1/inventory?search=NO-EXISTE-999');
  assert.equal(response.status, 200); assert.equal(body.items.length, 0);
});

test('CP-22 la respuesta no expone password_hash', async () => {
  const { body } = await request('/api/v1/auth/me');
  assert.equal(Object.hasOwn(body.user, 'password_hash'), false);
});

test('CP-23 solicitud mutante de origen externo es rechazada', async () => {
  const { response } = await request('/api/v1/auth/logout', { method: 'POST', headers: { origin: 'https://sitio-no-autorizado.example' } });
  assert.equal(response.status, 403);
});

test('CP-24 headers de seguridad están presentes', async () => {
  const { response } = await request('/api/v1/health');
  assert.ok(response.headers.get('x-content-type-options')); assert.ok(response.headers.get('content-security-policy'));
});

test('CP-25 cuerpo de petición excesivo es rechazado', async () => {
  const { response } = await request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: testEmail, password: 'x'.repeat(110000) }) });
  assert.equal(response.status, 413);
});

test('CP-26 contraseña almacenada usa bcrypt', async () => {
  const result = await pool.query('SELECT password_hash FROM users WHERE email = $1', [testEmail]);
  assert.match(result.rows[0].password_hash, /^\$2[aby]\$12\$/);
});

test('CP-27 clave de inventario conserva artículo y bodega', async () => {
  const result = await pool.query('SELECT COUNT(*)::integer AS total FROM mult WHERE cve_art = $1 AND cve_alm = $2', ['TEST-001', 91]);
  assert.equal(result.rows[0].total, 1);
});

test('CP-28 logout invalida la sesión', async () => {
  const { response } = await request('/api/v1/auth/logout', { method: 'POST' });
  assert.equal(response.status, 204);
});

test('CP-29 sesión cerrada no accede al inventario', async () => {
  const { response } = await request('/api/v1/inventory');
  assert.equal(response.status, 401); await login();
});

test('CP-30 filtros combinados funcionan', async () => {
  const { response, body } = await request('/api/v1/inventory?search=TEST&warehouse=91&status=A');
  assert.equal(response.status, 200); assert.ok(body.items.every((item) => item.warehouse === 91 && item.status === 'A'));
});