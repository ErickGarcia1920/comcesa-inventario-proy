const bcrypt = require('bcryptjs');
const { pool } = require('./database');
const env = require('./env');
const { MASTER_EMAILS } = require('./masters');

async function ensureDatabaseSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash VARCHAR(100) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
    -- Bloqueo por intentos fallidos de contraseña
    ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS lockout_level INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_permanently BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS inve (
      cve_art VARCHAR(20) PRIMARY KEY,
      descr VARCHAR(100) NOT NULL,
      lin_prod VARCHAR(20),
      uni_med VARCHAR(10) NOT NULL
    );

    -- Segundo paso de verificación (aplicación autenticadora)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
    CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes(user_id);

    -- Costos de Aspel (solo los ven los administradores)
    ALTER TABLE inve ADD COLUMN IF NOT EXISTS costo_prom NUMERIC(18, 4);
    ALTER TABLE inve ADD COLUMN IF NOT EXISTS ult_costo NUMERIC(18, 4);

    -- Nombres de las bodegas
    CREATE TABLE IF NOT EXISTS almacenes (
      cve_alm INTEGER PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mult (
      cve_art VARCHAR(20) NOT NULL REFERENCES inve(cve_art),
      cve_alm INTEGER NOT NULL,
      status CHAR(1) NOT NULL DEFAULT 'A',
      ctrl_alm VARCHAR(20),
      exist NUMERIC(18, 4) NOT NULL DEFAULT 0,
      PRIMARY KEY (cve_art, cve_alm)
    );

    CREATE TABLE IF NOT EXISTS precios01 (
      cve_precio VARCHAR(10) PRIMARY KEY,
      descripcion VARCHAR(100) NOT NULL,
      status CHAR(1) NOT NULL DEFAULT 'A',
      uuid VARCHAR(36) NOT NULL,
      version_sinc INTEGER NOT NULL DEFAULT 0,
      con_impu BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS precio_x_prod01 (
      cve_art VARCHAR(20) NOT NULL REFERENCES inve(cve_art),
      cve_precio VARCHAR(10) NOT NULL REFERENCES precios01(cve_precio),
      precio NUMERIC(18, 2) NOT NULL DEFAULT 0,
      uuid VARCHAR(36) NOT NULL,
      version_sinc INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (cve_art, cve_precio)
    );

    CREATE INDEX IF NOT EXISTS idx_inve_descr ON inve (descr);
    CREATE INDEX IF NOT EXISTS idx_inve_lin_prod ON inve (lin_prod);
    CREATE INDEX IF NOT EXISTS idx_mult_cve_alm ON mult (cve_alm);
  `);

  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
    await pool.query(`
      INSERT INTO users (email, password_hash, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (email) DO NOTHING
    `, [env.ADMIN_EMAIL.toLowerCase(), passwordHash]);
  }

  // Los usuarios master siempre son administradores.
  await pool.query(
    "UPDATE users SET role = 'admin', updated_at = NOW() WHERE email = ANY($1) AND role <> 'admin'",
    [MASTER_EMAILS]
  );

  if (env.SEED_DEMO_DATA) {
    await pool.query(`
      INSERT INTO inve (cve_art, descr, lin_prod, uni_med)
      VALUES
        ('ART-001', 'Balatas delanteras', 'FRENOS', 'PZA'),
        ('ART-002', 'Aceite sintetico 5W30', 'LUBRICANTES', 'LT'),
        ('ART-003', 'Filtro de aire', 'FILTRACION', 'PZA')
      ON CONFLICT (cve_art) DO NOTHING;

      INSERT INTO mult (cve_art, cve_alm, status, ctrl_alm, exist)
      VALUES
        ('ART-001', 1, 'A', 'ALM-CENTRAL', 24.0000),
        ('ART-001', 2, 'A', 'ALM-NORTE', 8.0000),
        ('ART-002', 1, 'A', 'ALM-CENTRAL', 57.0000),
        ('ART-003', 1, 'A', 'ALM-CENTRAL', 12.0000)
      ON CONFLICT (cve_art, cve_alm) DO NOTHING;
    `);
  }
}

module.exports = { ensureDatabaseSchema };