/**
 * Sincroniza desde Aspel dos catálogos pequeños hacia Postgres:
 *   1) Nombres de las bodegas autorizadas (tabla almacenes).
 *   2) Costo promedio y último costo de cada artículo (columnas costo_prom y ult_costo de inve).
 * Solo escribe lo que cambió. Se ejecuta una vez al día dentro de sync-todo.bat.
 *
 * Si Aspel usa otros nombres de tabla o columna, el script lo dice y muestra las opciones que encontró.
 * Se pueden indicar con variables en el .env: ASPEL_ALMACENES_TABLE, ASPEL_ALMACENES_ID_COL,
 * ASPEL_ALMACENES_NAME_COL, ASPEL_INVE_TABLE, ASPEL_COL_COSTO_PROM, ASPEL_COL_ULT_COSTO.
 */
require('dotenv').config();

const sql = require('mssql');
const { pool } = require('../src/backend/config/database');
const { ALLOWED_WAREHOUSES } = require('../src/backend/config/warehouses');

const IDENT = /^[A-Za-z0-9_]+$/;
function ident(name, fallback) {
  const value = process.env[name] || fallback;
  if (!IDENT.test(value)) throw new Error(`${name} solo puede tener letras, números y guion bajo.`);
  return value;
}

const ALMACENES_TABLE = ident('ASPEL_ALMACENES_TABLE', 'ALMACENES01');
const ALMACENES_ID = ident('ASPEL_ALMACENES_ID_COL', 'CVE_ALM');
const ALMACENES_NAME = ident('ASPEL_ALMACENES_NAME_COL', 'DESCR');
const INVE_TABLE = ident('ASPEL_INVE_TABLE', 'INVE01');
const COL_COSTO_PROM = ident('ASPEL_COL_COSTO_PROM', 'COSTO_PROM');
const COL_ULT_COSTO = ident('ASPEL_COL_ULT_COSTO', 'ULT_COSTO');

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Falta la variable de entorno ${name}.`);
  return process.env[name];
}

function sqlConfig() {
  const instanceName = process.env.ASPEL_SQLSERVER_INSTANCE;
  const port = process.env.ASPEL_SQLSERVER_PORT;
  return {
    server: requireEnv('ASPEL_SQLSERVER_HOST'),
    database: requireEnv('ASPEL_SQLSERVER_DB'),
    user: requireEnv('ASPEL_SQLSERVER_USER'),
    password: requireEnv('ASPEL_SQLSERVER_PASSWORD'),
    ...(port ? { port: Number(port) } : {}),
    options: {
      ...(instanceName && !port ? { instanceName } : {}),
      encrypt: process.env.ASPEL_SQLSERVER_ENCRYPT === 'true',
      trustServerCertificate: true
    },
    connectionTimeout: 15000,
    requestTimeout: 60000
  };
}

// Cuando una tabla o columna no existe, muestra qué hay parecido para poder corregir el .env.
async function describeCandidates(aspel, tablePattern, columnPattern) {
  const tables = await aspel.request().query(
    `SELECT TOP 20 TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '${tablePattern}' ORDER BY TABLE_NAME`
  );
  console.log(`  Tablas parecidas a ${tablePattern}: ${tables.recordset.map((r) => r.TABLE_NAME).join(', ') || '(ninguna)'}`);
  if (columnPattern) {
    const columns = await aspel.request().query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE ${columnPattern} ORDER BY TABLE_NAME, COLUMN_NAME`
    );
    const shown = columns.recordset.slice(0, 40).map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`);
    console.log(`  Columnas parecidas: ${shown.join(', ') || '(ninguna)'}`);
  }
}

async function syncWarehouseNames(aspel) {
  console.log(`Nombres de bodegas: leyendo ${ALMACENES_TABLE}.${ALMACENES_NAME}...`);
  let rows;
  try {
    const result = await aspel.request().query(
      `SELECT ${ALMACENES_ID} AS id, ${ALMACENES_NAME} AS nombre FROM dbo.[${ALMACENES_TABLE}] WITH (NOLOCK) WHERE ${ALMACENES_ID} IN (${ALLOWED_WAREHOUSES.join(', ')})`
    );
    rows = result.recordset;
  } catch (error) {
    console.log(`  NO SE PUDO leer los nombres de bodegas: ${error.message}`);
    await describeCandidates(aspel, '%ALMAC%', "TABLE_NAME LIKE '%ALMAC%' AND (COLUMN_NAME LIKE '%DESC%' OR COLUMN_NAME LIKE '%NOMB%' OR COLUMN_NAME LIKE '%CVE%')");
    return false;
  }
  const names = rows
    .map((r) => ({ id: Number(r.id), nombre: String(r.nombre ?? '').trim().slice(0, 100) }))
    .filter((r) => Number.isInteger(r.id) && r.nombre);
  if (!names.length) {
    console.log('  Aspel no devolvió nombres para las bodegas autorizadas.');
    return false;
  }
  const result = await pool.query(`
    INSERT INTO almacenes (cve_alm, nombre)
    SELECT * FROM unnest($1::int[], $2::text[])
    ON CONFLICT (cve_alm) DO UPDATE SET nombre = EXCLUDED.nombre WHERE almacenes.nombre IS DISTINCT FROM EXCLUDED.nombre
  `, [names.map((r) => r.id), names.map((r) => r.nombre)]);
  const missing = ALLOWED_WAREHOUSES.filter((id) => !names.some((r) => r.id === id));
  console.log(`  Bodegas con nombre: ${names.length} de ${ALLOWED_WAREHOUSES.length} (cambios guardados: ${result.rowCount}).`);
  for (const r of names) console.log(`    ${r.id} = ${r.nombre}`);
  if (missing.length) console.log(`  Sin nombre en Aspel: ${missing.join(', ')}`);
  return true;
}

async function syncCosts(aspel) {
  console.log(`Costos: leyendo ${INVE_TABLE}.${COL_COSTO_PROM} y ${INVE_TABLE}.${COL_ULT_COSTO}...`);
  let rows;
  try {
    const result = await aspel.request().query(
      `SELECT CVE_ART, ${COL_COSTO_PROM} AS costo_prom, ${COL_ULT_COSTO} AS ult_costo FROM dbo.[${INVE_TABLE}] WITH (NOLOCK)`
    );
    rows = result.recordset;
  } catch (error) {
    console.log(`  NO SE PUDO leer los costos: ${error.message}`);
    await describeCandidates(aspel, `${INVE_TABLE}`, `TABLE_NAME = '${INVE_TABLE}' AND COLUMN_NAME LIKE '%COST%'`);
    return false;
  }
  const art = []; const prom = []; const ult = [];
  for (const row of rows) {
    const code = row.CVE_ART === null || row.CVE_ART === undefined ? '' : String(row.CVE_ART).trim();
    if (!code) continue;
    art.push(code);
    prom.push(row.costo_prom === null || row.costo_prom === undefined ? null : Number(row.costo_prom));
    ult.push(row.ult_costo === null || row.ult_costo === undefined ? null : Number(row.ult_costo));
  }
  let changed = 0;
  const BATCH = 2000;
  for (let i = 0; i < art.length; i += BATCH) {
    const result = await pool.query(`
      UPDATE inve SET costo_prom = d.cp, ult_costo = d.uc
      FROM unnest($1::text[], $2::numeric[], $3::numeric[]) AS d(art, cp, uc)
      WHERE inve.cve_art = d.art AND (inve.costo_prom IS DISTINCT FROM d.cp OR inve.ult_costo IS DISTINCT FROM d.uc)
    `, [art.slice(i, i + BATCH), prom.slice(i, i + BATCH), ult.slice(i, i + BATCH)]);
    changed += result.rowCount;
  }
  console.log(`  Artículos leídos: ${art.length}. Costos actualizados: ${changed}.`);
  return true;
}

// La conexión con Aspel a veces falla en el primer intento: se reintenta hasta 3 veces.
async function connectWithRetry(attempts = 3) {
  const waitMs = Number(process.env.CATALOGOS_RETRY_WAIT_MS || 20000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const candidate = new sql.ConnectionPool(sqlConfig());
    try {
      await candidate.connect();
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.close().catch(() => {});
      console.log(`Intento ${attempt} de ${attempts} para conectar con Aspel: ${error.message}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

async function main() {
  const aspel = await connectWithRetry();
  let ok = true;
  try {
    ok = (await syncWarehouseNames(aspel)) && ok;
    ok = (await syncCosts(aspel)) && ok;
  } finally {
    await aspel.close().catch(() => {});
    await pool.end().catch(() => {});
  }
  if (!ok) {
    console.log('ATENCIÓN: una parte no se pudo sincronizar. Revisa los mensajes de arriba.');
    process.exit(3);
  }
  console.log('Catálogos sincronizados.');
}

main().catch((error) => {
  console.error('Error al sincronizar catálogos con Aspel SAE:', error.message);
  process.exit(1);
});
