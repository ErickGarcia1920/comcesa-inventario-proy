/**
 * Crea o actualiza un administrador.
 * Uso: npm run admin:create -- correo@empresa.com "ContrasenaSegura123"
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/backend/config/database');
const { ensureDatabaseSchema } = require('../src/backend/config/schema');

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 12) {
    throw new Error('Uso: npm run admin:create -- correo "contrasena de al menos 12 caracteres"');
  }
  await ensureDatabaseSchema();
  await pool.query(
    `INSERT INTO users (email, password_hash, role, active, must_change_password)
     VALUES ($1, $2, 'admin', TRUE, FALSE)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', active = TRUE, must_change_password = FALSE, updated_at = NOW()`,
    [email.toLowerCase(), await bcrypt.hash(password, 12)]
  );
  console.log(`Administrador listo: ${email.toLowerCase()}`);
  await pool.end();
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
