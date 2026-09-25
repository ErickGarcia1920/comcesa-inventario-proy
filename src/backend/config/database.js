const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool(env.DATABASE_URL ? {
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
} : {
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  database: env.POSTGRES_DB,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

async function checkDatabase() {
  await pool.query('SELECT 1');
}

module.exports = { pool, checkDatabase };