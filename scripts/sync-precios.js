require('dotenv').config();

const sql = require('mssql');
const { pool } = require('../src/backend/config/database');

const BATCH_SIZE = 1000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisa tu .env local.`);
  }
  return value;
}

function buildSqlServerConfig() {
  const instanceName = process.env.ASPEL_SQLSERVER_INSTANCE;
  const port = process.env.ASPEL_SQLSERVER_PORT;

  return {
    server: requireEnv('ASPEL_SQLSERVER_HOST'),
    database: requireEnv('ASPEL_SQLSERVER_DB'),
    user: requireEnv('ASPEL_SQLSERVER_USER'),
    password: requireEnv('ASPEL_SQLSERVER_PASSWORD'),
    connectionTimeout: 30000,
    requestTimeout: 120000,
    options: {
      encrypt: process.env.ASPEL_SQLSERVER_ENCRYPT === 'true',
      trustServerCertificate: true,
      ...(instanceName ? { instanceName } : {})
    },
    port: instanceName ? undefined : Number(port || 1433)
  };
}

function clean(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim();
}

function toBool(value) {
  const v = clean(value);
  return v !== null && ['S', 'SI', 'Y', '1', 'TRUE'].includes(v.toUpperCase());
}

// Reintenta solo errores de conexion; los errores de Postgres (FK, tipos) se propagan
async function withRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      const isServerError = typeof error.code === 'string' && error.code.length === 5;
      if (isServerError || i >= attempts) throw error;
      console.log(`Reintentando (${i}/${attempts - 1}) por: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * i));
    }
  }
}

async function upsertBatches(rows, columns, conflictCols, table) {
  const setClause = columns
    .filter((c) => !conflictCols.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const tuples = chunk.map((row, r) => {
      const placeholders = row.map((value, c) => {
        params.push(value);
        return `$${r * columns.length + c + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    const text =
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${setClause}`;
    await withRetry(() => pool.query(text, params));

    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) {
      console.log(`${table}: ${done} de ${rows.length}`);
    }
  }
}

async function syncPrecios() {
  const aspelPool = await sql.connect(buildSqlServerConfig());

  const listas = await aspelPool.request().query('SELECT CVE_PRECIO, DESCRIPCION, STATUS, UUID, CON_IMPU FROM dbo.PRECIOS01');
  const precios = await aspelPool.request().query('SELECT CVE_ART, CVE_PRECIO, PRECIO, UUID FROM dbo.PRECIO_X_PROD01');
  console.log(`Leidos de Aspel: ${listas.recordset.length} listas y ${precios.recordset.length} precios.`);

  const listasMap = new Map();
  for (const row of listas.recordset) {
    if (row.CVE_PRECIO === null || row.CVE_PRECIO === undefined) continue;
    const cve = String(row.CVE_PRECIO).trim();
    listasMap.set(cve, [
      cve,
      (clean(row.DESCRIPCION) ?? '').slice(0, 100),
      (clean(row.STATUS) || 'A').charAt(0),
      (clean(row.UUID) ?? '').slice(0, 36),
      toBool(row.CON_IMPU)
    ]);
  }

  const { rows: existentes } = await withRetry(() => pool.query('SELECT cve_art FROM inve'));
  const articulos = new Set(existentes.map((r) => r.cve_art));

  const preciosMap = new Map();
  let sinArticulo = 0;
  let sinLista = 0;
  for (const row of precios.recordset) {
    const art = clean(row.CVE_ART);
    if (!art || row.CVE_PRECIO === null || row.CVE_PRECIO === undefined) continue;
    const lista = String(row.CVE_PRECIO).trim();
    if (!articulos.has(art)) { sinArticulo++; continue; }
    if (!listasMap.has(lista)) { sinLista++; continue; }
    preciosMap.set(`${art}|${lista}`, [art, lista, row.PRECIO ?? 0, (clean(row.UUID) ?? '').slice(0, 36)]);
  }

  await upsertBatches([...listasMap.values()], ['cve_precio', 'descripcion', 'status', 'uuid', 'con_impu'], ['cve_precio'], 'precios01');
  await upsertBatches([...preciosMap.values()], ['cve_art', 'cve_precio', 'precio', 'uuid'], ['cve_art', 'cve_precio'], 'precio_x_prod01');

  console.log(`Sincronizadas ${listasMap.size} listas y ${preciosMap.size} precios (omitidos: ${sinArticulo} sin articulo en inve, ${sinLista} sin lista de precios).`);

  await aspelPool.close();
  await pool.end();
}

syncPrecios()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error al sincronizar precios:', error.message);
    process.exit(1);
  });