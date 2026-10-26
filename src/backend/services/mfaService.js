const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const qrcode = require('qrcode-generator');
const { pool } = require('../config/database');
const { redis } = require('../config/redis');
const { decryptSecret } = require('./mfaCrypto');
const totp = require('./totpService');

// Interruptor de emergencia: poniendo MFA_REQUIRED=false en Render se vuelve a entrar solo con contraseña.
function isMfaRequired() {
  return process.env.MFA_REQUIRED !== 'false';
}

// ---------- Estado "ya puso la contraseña, falta el segundo paso" (vive 10 minutos en Redis) ----------
const MFA_COOKIE = 'comcesa_mfa';
const PENDING_TTL_SECONDS = 10 * 60;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const pendingKey = (token) => `mfa:pending:${sha256(token)}`;

async function connectRedis() {
  if (redis.status === 'wait') await redis.connect();
}

async function createPending(userId, stage) {
  await connectRedis();
  const token = crypto.randomBytes(32).toString('base64url');
  await redis.set(pendingKey(token), JSON.stringify({ userId, stage }), 'EX', PENDING_TTL_SECONDS);
  return token;
}

async function getPending(token) {
  if (!token) return null;
  await connectRedis();
  const value = await redis.get(pendingKey(token));
  return value ? JSON.parse(value) : null;
}

async function updatePending(token, data) {
  await connectRedis();
  const ttl = await redis.ttl(pendingKey(token));
  if (ttl > 0) await redis.set(pendingKey(token), JSON.stringify(data), 'EX', ttl);
}

async function deletePending(token) {
  if (!token) return;
  await connectRedis();
  await redis.del(pendingKey(token));
}

function pendingCookieOptions(isProduction, maxAge = PENDING_TTL_SECONDS) {
  return { httpOnly: true, secure: isProduction, sameSite: 'strict', maxAge, path: '/api/v1/auth/mfa' };
}

// ---------- Códigos de respaldo (10, de un solo uso, guardados con bcrypt) ----------
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const bcryptCost = () => (process.env.NODE_ENV === 'test' ? 4 : 10);
const normalizeRecovery = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newRecoveryCode() {
  let raw = '';
  for (let i = 0; i < 10; i += 1) raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

// Reemplaza todos los códigos de respaldo del usuario (dentro de la transacción que se pase).
async function replaceRecoveryCodes(client, userId) {
  await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  for (const code of codes) {
    await client.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, await bcrypt.hash(normalizeRecovery(code), bcryptCost())]);
  }
  return codes;
}

async function consumeRecoveryCode(userId, input) {
  const normalized = normalizeRecovery(input);
  if (normalized.length !== 10) return false;
  const { rows } = await pool.query('SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
  for (const row of rows) {
    if (await bcrypt.compare(normalized, row.code_hash)) {
      const claimed = await pool.query('UPDATE mfa_recovery_codes SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id', [row.id]);
      return claimed.rowCount === 1;
    }
  }
  return false;
}

async function countRecoveryCodes(userId) {
  const { rows } = await pool.query('SELECT COUNT(*)::integer AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
  return rows[0].n;
}

// ---------- Verificación del código de 6 dígitos de un usuario ya inscrito ----------
// Un mismo código no sirve dos veces: se guarda el último periodo usado (de forma atómica).
async function verifyUserCode(user, code) {
  const secret = decryptSecret(user.totp_secret_enc);
  const step = totp.verifyCode(secret, code, { afterStep: user.totp_last_step });
  if (step === null) return false;
  const claimed = await pool.query(
    'UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id',
    [user.id, step]
  );
  return claimed.rowCount === 1;
}

function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 4);
}

module.exports = {
  MFA_COOKIE, isMfaRequired, createPending, getPending, updatePending, deletePending, pendingCookieOptions,
  replaceRecoveryCodes, consumeRecoveryCode, countRecoveryCodes, verifyUserCode, qrDataUrl
};
