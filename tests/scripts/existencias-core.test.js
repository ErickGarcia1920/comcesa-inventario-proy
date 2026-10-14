require('dotenv').config({ override: true });

process.env.POSTGRES_HOST ||= 'localhost';
process.env.POSTGRES_PORT ||= '5432';
process.env.POSTGRES_DB ||= 'comcesa';
process.env.POSTGRES_USER ||= 'comcesa';
process.env.POSTGRES_PASSWORD ||= 'test-postgres-password-1234';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Pool } = require('pg');
const { createWatcher, diffRows, normalizeSourceRow, keyOf } = require('../../scripts/lib/existencias-core');

const schema = `watch_test_${process.pid}`;
const connection = {
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
};
const admin = new Pool(connection);
// Esquema propio: estas pruebas no tocan las tablas reales ni las de otras pruebas.
const pool = new Pool({ ...connection, options: `-c search_path=${schema}` });

let calls = 0;
let failNextConnect = false;
const db = {
  query: (...args) => { calls += 1; return pool.query(...args); },
  connect: (...args) => {
    calls += 1;
    if (failNextConnect) { failNextConnect = false; return Promise.reject(new Error('Neon no responde')); }
    return pool.connect(...args);
  }
};

const src = (art, alm, exist, status = 'A', ctrl = 'BODEGA') => ({ CVE_ART: art, CVE_ALM: alm, STATUS: status, CTRL_ALM: ctrl, EXIST: exist });
const stockOf = async (art, alm) => {
  const { rows } = await pool.query('SELECT exist FROM mult WHERE cve_art = $1 AND cve_alm = $2', [art, alm]);
  return rows[0] ? Number(rows[0].exist) : null;
};

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE inve (cve_art VARCHAR(20) PRIMARY KEY, descr VARCHAR(100) NOT NULL, lin_prod VARCHAR(20), uni_med VARCHAR(10) NOT NULL);
    CREATE TABLE mult (
      cve_art VARCHAR(20) NOT NULL REFERENCES inve(cve_art), cve_alm INTEGER NOT NULL,
      status CHAR(1) NOT NULL DEFAULT 'A', ctrl_alm VARCHAR(20), exist NUMERIC(18, 4) NOT NULL DEFAULT 0,
      PRIMARY KEY (cve_art, cve_alm)
    );
    INSERT INTO inve VALUES ('A1', 'Uno', 'L', 'PZA'), ('A2', 'Dos', 'L', 'PZA'), ('A3', 'Tres', 'L', 'PZA');
    INSERT INTO mult VALUES ('A1', 1, 'A', 'BODEGA', 10), ('A1', 2, 'A', 'BODEGA', 5), ('A2', 1, 'A', 'BODEGA', 7);
  `);
});

after(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
  await admin.end();
});

test('diffRows detecta cambios, filas nuevas y filas eliminadas', () => {
  const before = new Map([['A1|1', normalizeSourceRow(src('A1', 1, 10))], ['A1|2', normalizeSourceRow(src('A1', 2, 5))]]);
  const result = diffRows(before, [src('A1', 1, 8), src('A3', 1, 20)].map(normalizeSourceRow));
  assert.deepEqual(result.changed.map(keyOf).sort(), ['A1|1', 'A3|1']);
  assert.deepEqual(result.removed.map(keyOf), ['A1|2']);
});

test('diffRows ignora diferencias menores a 4 decimales', () => {
  const before = new Map([['A1|1', normalizeSourceRow(src('A1', 1, 10))]]);
  assert.equal(diffRows(before, [normalizeSourceRow(src('A1', 1, 10.00001))]).changed.length, 0);
  assert.equal(diffRows(before, [normalizeSourceRow(src('A1', 1, 10.0001))]).changed.length, 1);
});

test('el vigilante solo escribe cuando hay movimientos y no toca la base si no hay cambios', async () => {
  let source = [src('A1', 1, 10), src('A1', 2, 5), src('A2', 1, 7)];
  let clock = 0;
  const watcher = createWatcher({ db, readSource: async () => source, now: () => clock });

  let result = await watcher.tick();
  assert.equal(result.ok, true);
  assert.equal(result.written, 0);

  calls = 0;
  result = await watcher.tick();
  assert.equal(result.written, 0);
  assert.equal(calls, 0, 'sin movimientos no debe haber ninguna consulta a la base');

  // Una venta baja A1/1, entra A3 (artículo conocido) y A2/1 desaparece.
  source = [src('A1', 1, 8), src('A1', 2, 5), src('A3', 1, 20)];
  result = await watcher.tick();
  assert.deepEqual([result.ok, result.written, result.removed], [true, 2, 1]);
  assert.equal(await stockOf('A1', 1), 8);
  assert.equal(await stockOf('A3', 1), 20);
  assert.equal(await stockOf('A2', 1), null);

  calls = 0;
  result = await watcher.tick();
  assert.equal(result.written, 0);
  assert.equal(calls, 0);
});

test('un artículo desconocido no rompe la sincronización ni se reintenta en cada revisión', async () => {
  let source = [src('A1', 1, 8), src('A1', 2, 5), src('A3', 1, 20), src('ZZ', 1, 99)];
  const watcher = createWatcher({ db, readSource: async () => source, now: () => 0 });
  let result = await watcher.tick();
  assert.deepEqual([result.ok, result.written, result.skippedUnknown], [true, 0, 1]);
  assert.equal(await stockOf('ZZ', 1), null);

  calls = 0;
  result = await watcher.tick();
  assert.equal(result.skippedUnknown, 0);
  assert.equal(calls, 0);

  source = [src('A1', 1, 7), src('A1', 2, 5), src('A3', 1, 20), src('ZZ', 1, 99)];
  result = await watcher.tick();
  assert.equal(result.written, 1);
  assert.equal(await stockOf('A1', 1), 7);
});

test('si Aspel falla no se toca la base y se recupera en la siguiente revisión', async () => {
  let fail = false;
  let source = [src('A1', 1, 7), src('A1', 2, 5), src('A3', 1, 20)];
  const watcher = createWatcher({ db, readSource: async () => { if (fail) throw new Error('Failed to connect'); return source; }, now: () => 0 });
  await watcher.tick();

  fail = true;
  calls = 0;
  let result = await watcher.tick();
  assert.deepEqual([result.ok, result.where], [false, 'aspel']);
  assert.equal(calls, 0);

  fail = false;
  source = [src('A1', 1, 6), src('A1', 2, 5), src('A3', 1, 20)];
  result = await watcher.tick();
  assert.deepEqual([result.ok, result.written], [true, 1]);
  assert.equal(await stockOf('A1', 1), 6);
});

test('si Neon falla el cambio no se pierde: se reintenta en la siguiente revisión', async () => {
  let source = [src('A1', 1, 6), src('A1', 2, 5), src('A3', 1, 20)];
  const watcher = createWatcher({ db, readSource: async () => source, now: () => 0 });
  await watcher.tick();

  source = [src('A1', 1, 4), src('A1', 2, 5), src('A3', 1, 20)];
  failNextConnect = true;
  let result = await watcher.tick();
  assert.deepEqual([result.ok, result.where], [false, 'neon']);
  assert.equal(await stockOf('A1', 1), 6);

  result = await watcher.tick();
  assert.deepEqual([result.ok, result.written], [true, 1]);
  assert.equal(await stockOf('A1', 1), 4);
});

test('protección: si Aspel devuelve muy pocas filas no se borra nada', async () => {
  const values = [];
  for (let i = 0; i < 200; i += 1) values.push(`('A1', ${1000 + i}, 'A', 'BODEGA', 1)`);
  await pool.query(`INSERT INTO mult VALUES ${values.join(',')}`);
  const watcher = createWatcher({ db, readSource: async () => [src('A1', 1, 4)], now: () => 0 });
  const result = await watcher.tick();
  assert.equal(result.ok, true);
  assert.equal(result.suspicious, true);
  assert.equal(result.removed, 0);
  assert.equal(await stockOf('A1', 1000), 1);
});
