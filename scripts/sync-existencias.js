/**
 * Sincroniza SOLO las existencias (MULT) de Aspel SAE hacia Postgres.
 * Es liviano para correrlo cada 10 minutos desde la PC de la oficina.
 * Solo escribe las filas que cambiaron. Los articulos (INVE) y precios siguen
 * en sync-aspel.js / sync-precios.js (diario).
 *
 * Uso: node scripts/sync-existencias.js
 */
require('dotenv').config();

const sql = require('mssql');
const { pool } = require('../src/backend/config/database');

const BATCH = 1000;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Falta la variable de entorno ${name}`);
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
      trustServerCertificate: true,
      enableArithAbort: true
    },
    connectionTimeout: 15000,
    requestTimeout: 60000
  };
}

async function main() {
  const sqlPool = await sql.connect(sqlConfig());
  try {
    const { recordset } = await sqlPool.request().query('SELECT CVE_ART, CVE_ALM, STATUS, CTRL_ALM, EXIST FROM dbo.[MULT]');
    const known = new Set((await pool.query('SELECT cve_art FROM inve')).rows.map((r) => r.cve_art));
    const rows = recordset.filter((r) => known.has(r.CVE_ART));
    let touched = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const values = []; const params = [];
      chunk.forEach((r, n) => {
        const o = n * 5;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`);
        params.push(r.CVE_ART, r.CVE_ALM, r.STATUS || 'A', r.CTRL_ALM ?? null, r.EXIST ?? 0);
      });
      const result = await pool.query(
        `INSERT INTO mult (cve_art, cve_alm, status, ctrl_alm, exist) VALUES ${values.join(',')}
         ON CONFLICT (cve_art, cve_alm) DO UPDATE
         SET status = EXCLUDED.status, ctrl_alm = EXCLUDED.ctrl_alm, exist = EXCLUDED.exist
         WHERE (mult.status, mult.ctrl_alm, mult.exist) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.ctrl_alm, EXCLUDED.exist)`,
        params
      );
      touched += result.rowCount;
    }
    console.log(`${new Date().toISOString()} MULT leido: ${rows.length}, filas actualizadas: ${touched}`);
  } finally {
    await sqlPool.close();
    await pool.end();
  }
}

main().catch((error) => { console.error('Error en sync-existencias:', error.message); process.exitCode = 1; });
