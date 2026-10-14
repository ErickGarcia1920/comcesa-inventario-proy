/**
 * Vigilante de existencias: mantiene la tabla mult de Postgres al día con MULT01 de Aspel SAE.
 *
 * - Revisa Aspel cada WATCH_INTERVAL_SECONDS (por defecto 20 s).
 * - Solo escribe en Postgres cuando hubo movimientos (así Neon gratis puede apagarse solo).
 * - Lee Aspel con NOLOCK para no frenar nunca la facturación.
 * - Se recupera solo si Aspel o Neon fallan un momento.
 *
 * Uso: node scripts/watch-existencias.js   (normalmente lo inicia iniciar-watch-existencias.ps1)
 * Código de salida 2 = ya hay otro vigilante corriendo.
 */
require('dotenv').config();

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const sql = require('mssql');
const { pool } = require('../src/backend/config/database');
const { createWatcher } = require('./lib/existencias-core');

const INTERVAL_MS = Math.max(5, Number(process.env.WATCH_INTERVAL_SECONDS || 20)) * 1000;
const MULT_TABLE = process.env.ASPEL_MULT_TABLE || 'MULT01';
const LOCK_PORT = Number(process.env.WATCH_LOCK_PORT || 47831);
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'watch-existencias.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

if (!/^[A-Za-z0-9_]+$/.test(MULT_TABLE)) {
  console.error('ASPEL_MULT_TABLE solo puede tener letras, números y guion bajo.');
  process.exit(1);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, ".old.log"));
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* si no se puede escribir el archivo, igual sigue funcionando */ }
}

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

// Una sola instancia a la vez: se reserva un puerto local (se libera solo si el proceso muere).
function acquireSingleInstance() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => (error.code === 'EADDRINUSE' ? resolve(null) : reject(error)));
    server.listen(LOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

let sqlPool = null;

async function readSource() {
  try {
    if (!sqlPool) {
      const candidate = new sql.ConnectionPool(sqlConfig());
      candidate.on('error', () => { sqlPool = null; });
      try { await candidate.connect(); } catch (error) { candidate.close().catch(() => {}); throw error; }
      sqlPool = candidate;
    }
    const result = await sqlPool.request().query(
      `SELECT CVE_ART, CVE_ALM, STATUS, CTRL_ALM, EXIST FROM dbo.[${MULT_TABLE}] WITH (NOLOCK)`
    );
    return result.recordset;
  } catch (error) {
    const broken = sqlPool;
    sqlPool = null;
    if (broken) broken.close().catch(() => {});
    throw error;
  }
}

let stopping = false;
let wakeUp = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeUp = () => { clearTimeout(timer); resolve(); };
  });
}

async function shutdown(lock) {
  stopping = true;
  if (wakeUp) wakeUp();
  log('Deteniendo el vigilante...');
  if (sqlPool) await sqlPool.close().catch(() => {});
  await pool.end().catch(() => {});
  if (lock) lock.close();
}

async function main() {
  const lock = await acquireSingleInstance();
  if (!lock) {
    console.error('Ya hay un vigilante de existencias en ejecución. No se inicia otro.');
    process.exit(2);
  }
  process.on('SIGINT', () => shutdown(lock).then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown(lock).then(() => process.exit(0)));

  log(`Vigilante iniciado. Revisa Aspel (${MULT_TABLE}) cada ${INTERVAL_MS / 1000} s y solo escribe cuando hay movimientos.`);
  const watcher = createWatcher({ db: pool, readSource });
  let failures = 0;
  let lastError = '';
  let writtenThisHour = 0;
  let lastHeartbeat = Date.now();

  while (!stopping) {
    const result = await watcher.tick();
    if (result.ok) {
      if (failures) { log(`Recuperado después de ${failures} revisión(es) con error.`); failures = 0; lastError = ''; }
      if (result.written || result.removed) {
        writtenThisHour += result.written;
        log(`Movimientos aplicados: ${result.written} existencia(s) actualizada(s)${result.removed ? `, ${result.removed} eliminada(s)` : ''}.`);
      }
      if (result.skippedUnknown) log(`Aviso: ${result.skippedUnknown} existencia(s) de artículos que aún no están en la base (se cargan con la sincronización diaria).`);
      if (result.suspicious) log('AVISO: Aspel devolvió muchas menos filas que antes; no se borró nada.');
    } else {
      failures += 1;
      const message = `${result.where === 'aspel' ? 'Aspel' : 'Neon'}: ${result.error.message}`;
      if (failures === 1 || failures % 30 === 0 || message !== lastError) log(`Error (revisión fallida #${failures}) - ${message}`);
      lastError = message;
    }
    if (Date.now() - lastHeartbeat >= 60 * 60 * 1000) {
      log(`Activo. Filas vigiladas: ${watcher.size}. Existencias actualizadas en la última hora: ${writtenThisHour}.`);
      writtenThisHour = 0;
      lastHeartbeat = Date.now();
    }
    if (!stopping) await sleep(INTERVAL_MS);
  }
}

main().catch((error) => { console.error('Error fatal en el vigilante:', error.message); process.exit(1); });
