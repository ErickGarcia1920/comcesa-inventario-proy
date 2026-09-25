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
    // Nunca se usan mas privilegios que SELECT: el usuario
