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
const ExcelJS = require('exceljs');
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
    VALUES ('TEST-001', 'Articulo de prueba', 'PRUEBAS', 'PZA'), ('TEST-002', 'Filtro demo', 'FILTRACION', 'PZA'), ('TEST-003', 'Cable de prueba', 'PRUEBAS', 'PZA'), ('TEST-004', 'Articulo en bodegas excluidas', 'PRUEBAS', 'PZA'),
      ('TEST-R01', 'Rango uno', 'PRUEBAS', 'PZA'), ('TEST-R02', 'Rango dos', 'PRUEBAS', 'PZA'), ('TEST-R03', 'Rango tres', 'PRUEBAS', 'PZA')
    ON CONFLICT (cve_art) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO mult (cve_art, cve_alm, status, ctrl_alm, exist)
    VALUES
      ('TEST-001', 91, 'A', 'BODEGA-PRUEBA', 15),
      ('TEST-002', 92, 'I', 'BODEGA-INACTIVA', 5),
      ('TEST-003', 93, 'A', 'BODEGA-93', 100),
      ('TEST-003', 94, 'A', 'BODEGA-94', 12000),
      ('TEST-003', 95, 'A', 'BODEGA-95', 0),
      ('TEST-003', 96, 'A', 'BODEGA-96', 500),
      ('TEST-004', 8, 'A', 'BODEGA-8', 10),
      ('TEST-004', 25, 'A', 'BODEGA-25', 10),
      ('TEST-004', 97, 'A', 'BODEGA-97', 10),
      ('TEST-R01', 98, 'A', 'BODEGA-98', 1),
      ('TEST-R02', 98, 'A', 'BODEGA-98', 1),
      ('TEST-R03', 98, 'A', 'BODEGA-98', 1)
    ON CONFLICT (cve_art, cve_alm) DO UPDATE SET status = EXCLUDED.status, exist = EXCLUDED.exist
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

test('CP-31 los registros con existencia en cero no aparecen en el listado', async () => {
  const { body } = await request('/api/v1/inventory?search=TEST-003');
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every((item) => Number(item.stock) > 0));
  assert.equal(body.items.some((item) => item.warehouse === 95), false);
});

test('CP-32 las bodegas de un artículo salen de mayor a menor existencia', async () => {
  const { body } = await request('/api/v1/inventory?search=TEST-003');
  assert.deepEqual(body.items.map((item) => Number(item.stock)), [12000, 500, 100]);
});

test('CP-33 las bodegas 8 y 25 no aparecen en el listado', async () => {
  const { body } = await request('/api/v1/inventory?search=TEST-004');
  assert.deepEqual(body.items.map((item) => item.warehouse), [97]);
});

test('CP-34 filtrar directamente por bodega 8 o 25 no devuelve registros', async () => {
  const bodega8 = await request('/api/v1/inventory?warehouse=8');
  const bodega25 = await request('/api/v1/inventory?warehouse=25');
  assert.equal(bodega8.body.items.length, 0);
  assert.equal(bodega25.body.items.length, 0);
});

test('CP-35 la busqueda por rango de clave incluye ambos extremos', async () => {
  const { body } = await request('/api/v1/inventory?articleFrom=TEST-R01&articleTo=TEST-R02');
  assert.deepEqual(body.items.map((item) => item.article), ['TEST-R01', 'TEST-R02']);
});

test('CP-36 el rango funciona con minusculas y con los extremos invertidos', async () => {
  const { body } = await request('/api/v1/inventory?articleFrom=test-r02&articleTo=test-r01');
  assert.deepEqual(body.items.map((item) => item.article), ['TEST-R01', 'TEST-R02']);
});

async function downloadExcel(query) {
  const response = await fetch(`${baseUrl}/api/v1/inventory/export${query}`, { headers: { cookie: sessionCookie } });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

test('CP-37 la descarga de Excel exige autenticación', async () => {
  const response = await fetch(`${baseUrl}/api/v1/inventory/export`);
  assert.equal(response.status, 401);
});

test('CP-38 la descarga de Excel respeta los filtros y devuelve un archivo válido', async () => {
  const { response, buffer } = await downloadExcel('?search=TEST-003');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="inventario_.*\.xlsx"/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Inventario');
  assert.ok(workbook.getWorksheet('Filtros'));
  assert.equal(sheet.getCell(1, 1).value, 'Artículo');
  const dataRows = [];
  sheet.eachRow((row, number) => { if (number > 1) dataRows.push({ article: row.getCell(1).value, stock: row.getCell(8).value }); });
  assert.deepEqual(dataRows, [
    { article: 'TEST-003', stock: 12000 },
    { article: 'TEST-003', stock: 500 },
    { article: 'TEST-003', stock: 100 }
  ]);
});

test('CP-39 el Excel excluye bodegas ocultas y guarda las claves como texto', async () => {
  const { buffer } = await downloadExcel('?search=TEST-004');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Inventario');
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell(2, 5).value, 97);
  assert.equal(typeof sheet.getCell(2, 1).value, 'string');
});

test('CP-40 la descarga de Excel rechaza filtros inválidos', async () => {
  const { response } = await downloadExcel('?warehouse=abc');
  assert.equal(response.status, 400);
});

test('CP-41 la app se puede instalar en el celular: manifiesto, iconos y service worker', async () => {
  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/inventario');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const iconResponse = await fetch(`${baseUrl}${icon.src}`);
    assert.equal(iconResponse.status, 200);
    assert.match(iconResponse.headers.get('content-type'), /image\/png/);
  }
  const worker = await fetch(`${baseUrl}/sw.js`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);
  const loginPage = await (await fetch(`${baseUrl}/login`)).text();
  assert.match(loginPage, /rel="manifest"/);
  assert.match(loginPage, /apple-touch-icon/);
});
