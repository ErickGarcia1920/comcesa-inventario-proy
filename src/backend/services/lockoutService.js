const { pool } = require('../config/database');

// Política de bloqueo por contraseña incorrecta:
//  - 3 intentos fallidos -> bloqueo de 15 minutos (ronda 1)
//  - otros 3 intentos fallidos -> otros 15 minutos (ronda 2)
//  - otros 3 intentos fallidos -> usuario bloqueado hasta que un administrador lo restablezca (ronda 3)
const MAX_ATTEMPTS = 3;
const LOCK_MINUTES = 15;
const MAX_LOCK_ROUNDS = 3;

const LOCK_FIELDS = `
  locked_permanently,
  COALESCE(locked_until > NOW(), FALSE) AS temp_locked,
  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())) / 60))::integer AS lock_minutes`;

const MESSAGES = {
  permanent: 'Tu usuario ha sido bloqueado. Contacta al administrador para que restablezca tu usuario y contraseña.',
  temporary: (minutes) => `Tu usuario está bloqueado temporalmente por demasiados intentos. Intenta de nuevo en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
  justLocked: (minutes) => `Superaste los ${MAX_ATTEMPTS} intentos permitidos. Tu usuario quedó bloqueado por ${minutes} minutos.`
};

// Registra un intento fallido y devuelve el estado de bloqueo resultante (todo en una sola consulta).
async function registerFailure(userId) {
  const result = await pool.query(`
    UPDATE users SET
      failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
      lockout_level = CASE WHEN failed_attempts + 1 >= $2 THEN lockout_level + 1 ELSE lockout_level END,
      locked_permanently = CASE WHEN failed_attempts + 1 >= $2 AND lockout_level + 1 >= $3 THEN TRUE ELSE locked_permanently END,
      locked_until = CASE WHEN failed_attempts + 1 >= $2 AND lockout_level + 1 < $3 THEN NOW() + make_interval(mins => $4) ELSE locked_until END,
      updated_at = NOW()
    WHERE id = $1
    RETURNING ${LOCK_FIELDS}
  `, [userId, MAX_ATTEMPTS, MAX_LOCK_ROUNDS, LOCK_MINUTES]);
  return result.rows[0];
}

// Un ingreso correcto reinicia los contadores (solo escribe si hacía falta).
async function registerSuccess(userId) {
  await pool.query(`
    UPDATE users SET failed_attempts = 0, lockout_level = 0, locked_until = NULL
    WHERE id = $1 AND (failed_attempts <> 0 OR lockout_level <> 0 OR locked_until IS NOT NULL)
  `, [userId]);
}

// Texto SQL para desbloquear (se usa al restablecer la contraseña o al desbloquear).
const UNLOCK_SQL = 'failed_attempts = 0, lockout_level = 0, locked_until = NULL, locked_permanently = FALSE';

module.exports = { MAX_ATTEMPTS, LOCK_MINUTES, MAX_LOCK_ROUNDS, LOCK_FIELDS, MESSAGES, UNLOCK_SQL, registerFailure, registerSuccess };
