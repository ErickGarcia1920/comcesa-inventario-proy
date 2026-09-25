/**
 * scripts/sync-aspel.js
 *
 * Sincroniza (solo lectura del lado de SQL Server) las tablas de Aspel SAE
 * hacia la copia operativa en PostgreSQL que usa el backend para consultas.
 *
 * IMPORTANTE:
 * - Este script solo ejecuta SELECT contra SQL Server. Nunca escribe en Aspel SAE.
 * - El servidor SQL Server de Aspel SAE normalmente vive en la red local de la
 *   empresa y NO es accesible desde el servicio desplegado en la nube. Por eso
 *   este script se ejecuta desde dentro de la red de COMCESA (una laptop, un
 *   mini PC o un servidor local con Node.js), y empuja los datos a la base de
 *   datos Postgres que SI esta expuesta al backend en la nube. Puede
 *   programarse con el Programador de tareas de Windows o un cron local.
 *
 * Variables de entorno esperadas (definir en un .env local, NUNCA commitear):
 *   ASPEL_SQLSERVER_HOST      -> host o IP del servidor (ej. "SERVER")
 *   ASPEL_SQLSERVER_INSTANCE  -> nombre de instancia (ej. "SERVER" en "SERVER\SERVER")
 *   ASPEL_SQLSERVER_PORT      -> opcional, si no se usa instanceName (ej. 1433)
 *   ASPEL_SQLSERVER_DB        -> ej. "SAE80Empre01"
 *   ASPEL_SQLSERVER_USER      -> ej. "Consulta"
 *   ASPEL_SQLSERVER_PASSWORD  -> la clave (secreta, solo en el .env local)
 *   ASPEL_SQLSERVER_ENCRYPT   -> "true" | "false" (SQL Server viejo sin TLS -> false)
 *
 *   POSTGRES_* o DATABASE_URL -> igual que el resto del backend (ver .env.example)
 *
 * Uso:
 *   node scripts/sync-aspel.js
 */

require('dotenv').config();

const sql = require('mssql');
const { pool } = require('../src/backend/config/database');

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
    // Nunca se usan mas privilegios que SELECT: el usuario "Consulta" ya esta
    // restringido a solo lectura del lado del servidor, y aqui no se ejecuta
    // ningun INSERT/UPDATE/DELETE contra SQL Server.
    ...(port ? { port: Number(port) } : {}),
    options: {
      ...(instanceName && !port ? { instanceName } : {}),
      encrypt: process.env.ASPEL_SQLSERVER_ENCRYPT === 'true',
      trustServerCertificate: true,
      enableArithAbort: true
    },
    connectionTimeout: 15000,
    requestTimeout: 30000
  };
}

async function fetchTable(sqlPool, tableName) {
  const result = await sqlPool.request().query(`SELECT * FROM dbo.[${tableName}]`);
  return result.recordset;
}

async function syncInve(sqlPool) {
  const rows = await fetchTable(sqlPool, 'INVE');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM precio_x_prod01');
    await client.query('DELETE FROM mult');
    await client.query('DELETE FROM inve');
    for (const row of rows) {
      await client.query(
        `INSERT INTO inve (cve_art, descr, lin_prod, uni_med)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cve_art) DO UPDATE
         SET descr = EXCLUDED.descr, lin_prod = EXCLUDED.lin_prod, uni_med = EXCLUDED.uni_med`,
        [row.CVE_ART, row.DESCR, row.LIN_PROD, row.UNI_MED]
      );
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function syncMult(sqlPool) {
  const rows = await fetchTable(sqlPool, 'MULT');
  for (const row of rows) {
    await pool.query(
      `INSERT INTO mult (cve_art, cve_alm, status, ctrl_alm, exist)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cve_art, cve_alm) DO UPDATE
       SET status = EXCLUDED.status, ctrl_alm = EXCLUDED.ctrl_alm, exist = EXCLUDED.exist`,
      [row.CVE_ART, row.CVE_ALM, row.STATUS, row.CTRL_ALM, row.EXIST]
    );
  }
  return rows.length;
}

async function syncPrecios01(sqlPool) {
  const rows = await fetchTable(sqlPool, 'PRECIOS01');
  for (const row of rows) {
    await pool.query(
      `INSERT INTO precios01 (cve_precio, descripcion, status, uuid, version_sinc, con_impu)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cve_precio) DO UPDATE
       SET descripcion = EXCLUDED.descripcion, status = EXCLUDED.status,
           uuid = EXCLUDED.uuid, version_sinc = EXCLUDED.version_sinc, con_impu = EXCLUDED.con_impu`,
      [row.CVE_PRECIO, row.DESCRIPCION, row.STATUS, row.UUID, row.VERSION_SINC, Boolean(row.CON_IMPU)]
    );
  }
  return rows.length;
}

async function syncPrecioXProd01(sqlPool) {
  const rows = await fetchTable(sqlPool, 'PRECIO_X_PROD01');
  for (const row of rows) {
    await pool.query(
      `INSERT INTO precio_x_prod01 (cve_art, cve_precio, precio, uuid, version_sinc)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cve_art, cve_precio) DO UPDATE
       SET precio = EXCLUDED.precio, uuid = EXCLUDED.uuid, version_sinc = EXCLUDED.version_sinc`,
      [row.CVE_ART, row.CVE_PRECIO, row.PRECIO, row.UUID, row.VERSION_SINC]
    );
  }
  return rows.length;
}

async function main() {
  const sqlPool = await sql.connect(buildSqlServerConfig());
  try {
    console.log('Conectado a SQL Server (solo lectura). Iniciando sincronizacion...');

    const inveCount = await syncInve(sqlPool);
    console.log(`INVE sincronizado: ${inveCount} articulos`);

    const multCount = await syncMult(sqlPool);
    console.log(`MULT sincronizado: ${multCount} existencias por almacen`);

    const preciosCount = await syncPrecios01(sqlPool);
    console.log(`PRECIOS01 sincronizado: ${preciosCount} listas de precios`);

    const precioXProdCount = await syncPrecioXProd01(sqlPool);
    console.log(`PRECIO_X_PROD01 sincronizado: ${precioXProdCount} precios por producto`);

    console.log('Sincronizacion completada con exito.');
  } finally {
    await sqlPool.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Error durante la sincronizacion con Aspel SAE:', error);
  process.exitCode = 1;
});
