require('dotenv').config();

const sql = require('mssql');
const { pool } = require('../src/backend/config/database');

const BATCH_SIZE = 500;

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
    options: {
      encrypt: process.env.ASPEL_SQLSERVER_ENCRYPT === 'true',
      trustServerCertificate: true,
      ...(instanceName ? { instanceName } : {})
    },
    port: instanceName ? undefined : Number(port || 1433)
  };
}

// Devuelve null si el valor es nulo; si no, el texto sin espacios
function clean(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim();
}

// Inserta o actualiza por lotes con INSERT ... VALUES multi-fila
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

    await pool.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${setClause}`,
      params
    );

    done += chunk.length;
    console.log(`${table}: ${done} de ${rows.length}`);
  }
}

async function syncInventario() {
  const sqlConfig = buildSqlServerConfig();
  const aspelPool = await sql.connect(sqlConfig);

  const articulos = await aspelPool.request().query('SELECT CVE_ART, DESCR, LIN_PROD, UNI_MED FROM dbo.INVE01');
  const existencias = await aspelPool.request().query('SELECT CVE_ART, CVE_ALM, STATUS, CTRL_ALM, EXIST FROM dbo.MULT01');
  console.log(`Leidos de Aspel: ${articulos.recordset.length} articulos y ${existencias.recordset.length} existencias.`);

  const inveMap = new Map();
  for (const row of articulos.recordset) {
    const cve = clean(row.CVE_ART);
    if (!cve) continue;
    inveMap.set(cve, [cve, clean(row.DESCR) ?? '', clean(row.LIN_PROD) || null, clean(row.UNI_MED) ?? '']);
  }

  const multMap = new Map();
  for (const row of existencias.recordset) {
    const cve = clean(row.CVE_ART);
    if (!cve || row.CVE_ALM === null || row.CVE_ALM === undefined) continue;
    multMap.set(`${cve}|${row.CVE_ALM}`, [cve, row.CVE_ALM, clean(row.STATUS) ?? '', clean(row.CTRL_ALM) || null, row.EXIST]);
  }

  await upsertBatches([...inveMap.values()], ['cve_art', 'descr', 'lin_prod', 'uni_med'], ['cve_art'], 'inve');
  await upsertBatches([...multMap.values()], ['cve_art', 'cve_alm', 'status', 'ctrl_alm', 'exist'], ['cve_art', 'cve_alm'], 'mult');

  console.log(`Sincronizados ${inveMap.size} articulos y ${multMap.size} registros de existencias.`);

  await aspelPool.close();
  await pool.end();
}

syncInventario()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error al sincronizar con Aspel SAE:', error.message);
    process.exit(1);
  });