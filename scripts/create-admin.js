const bcrypt = require('bcryptjs');
const { pool } = require('../src/backend/config/database');
const { ensureDatabaseSchema } = require('../src/backend/config/schema');

const [emailArgument, password] = process.argv.slice(2);
const email = String(emailArgument || '').trim().toLowerCase();

if (!email || !/^\S+@\S+\.\S+$/.test(email) || !password || password.length < 12) {
  console.error('Uso: npm run admin:create -- correo@empresa.com "Una-contrasena-larga"');
  process.exit(1);
}

async function createAdmin() {
  await ensureDatabaseSchema();
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(`
    INSERT INTO users (email, password_hash, role)
    VALUES ($1, $2, 'admin')
    ON CONFLICT (email)
    DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', active = TRUE, updated_at = NOW()
  `, [email, passwordHash]);
  console.log(`Administrador creado: ${email}`);
  await pool.end();
}

createAdmin().catch(async (error) => {
  console.error('No fue posible crear el administrador', error.message);
  await pool.end();
  process.exit(1);
});