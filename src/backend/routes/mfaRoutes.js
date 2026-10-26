const express = require('express');
const rateLimit = require('express-rate-limit');
const { parse, serialize } = require('cookie');
const { pool } = require('../config/database');
const env = require('../config/env');
const { SESSION_COOKIE, cookieOptions, createSession } = require('../services/sessionService');
const { isMasterUser } = require('../services/permissions');
const { MESSAGES, LOCK_FIELDS, registerFailure, registerSuccess } = require('../services/lockoutService');
const { encryptSecret, decryptSecret } = require('../services/mfaCrypto');
const totp = require('../services/totpService');
const mfa = require('../services/mfaService');

const router = express.Router();
const isProduction = () => env.NODE_ENV === 'production';
// Igual que el inicio de sesión: solo cuentan los intentos fallidos.
const mfaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true });

function clearPendingCookie() {
  return serialize(mfa.MFA_COOKIE, '', mfa.pendingCookieOptions(isProduction(), 0));
}

function expired(response) {
  response.setHeader('Set-Cookie', clearPendingCookie());
  return response.status(401).json({ error: 'MFA_SESSION_EXPIRED', message: 'Tu verificación venció. Vuelve a iniciar sesión.' });
}

// Busca a quién corresponde el segundo paso en curso (cookie corta que se da al poner bien la contraseña).
async function pendingContext(request, response, stage) {
  const token = parse(request.headers.cookie || '')[mfa.MFA_COOKIE];
  const pending = await mfa.getPending(token);
  if (!pending || pending.stage !== stage) { expired(response); return null; }
  const result = await pool.query(
    `SELECT id, email, role, must_change_password, totp_secret_enc, totp_enabled, totp_last_step, ${LOCK_FIELDS}
     FROM users WHERE id = $1 AND active = TRUE`,
    [pending.userId]
  );
  const user = result.rows[0];
  if (!user) { await mfa.deletePending(token); expired(response); return null; }
  if (user.locked_permanently) { await mfa.deletePending(token); response.status(423).json({ error: 'ACCOUNT_LOCKED', message: MESSAGES.permanent }); return null; }
  if (user.temp_locked) { await mfa.deletePending(token); response.status(423).json({ error: 'TEMPORARILY_LOCKED', message: MESSAGES.temporary(user.lock_minutes) }); return null; }
  return { token, pending, user };
}

// Un código incorrecto cuenta igual que una contraseña incorrecta (3 intentos, 15 min, etc.).
async function codeFailed(response, token, user) {
  const state = await registerFailure(user.id);
  if (state.locked_permanently) {
    await mfa.deletePending(token);
    return response.status(423).json({ error: 'ACCOUNT_LOCKED', message: MESSAGES.permanent });
  }
  if (state.temp_locked) {
    await mfa.deletePending(token);
    return response.status(423).json({ error: 'TEMPORARILY_LOCKED', message: MESSAGES.justLocked(state.lock_minutes) });
  }
  return response.status(401).json({
    error: 'INVALID_CODE',
    message: 'Código incorrecto o vencido. Revisa que la hora de tu celular esté en automático e intenta con el código nuevo.'
  });
}

async function finishLogin(response, token, user, extra = {}) {
  await registerSuccess(user.id);
  await mfa.deletePending(token);
  const session = await createSession({ id: user.id, email: user.email, role: user.role });
  response.setHeader('Set-Cookie', [serialize(SESSION_COOKIE, session, cookieOptions(isProduction())), clearPendingCookie()]);
  response.json({
    user: { email: user.email, role: user.role, isMaster: isMasterUser(user) },
    mustChangePassword: user.must_change_password,
    ...extra
  });
}

// Primera vez: entrega la clave y el código QR para agregar la cuenta en la aplicación.
router.get('/setup', async (request, response, next) => {
  try {
    const context = await pendingContext(request, response, 'enroll');
    if (!context) return null;
    const { token, pending, user } = context;
    let secret;
    if (pending.enrollSecretEnc) {
      secret = decryptSecret(pending.enrollSecretEnc);
    } else {
      secret = totp.generateSecret();
      await mfa.updatePending(token, { ...pending, enrollSecretEnc: encryptSecret(secret) });
    }
    const url = totp.otpauthUrl(user.email, secret);
    response.setHeader('Cache-Control', 'no-store');
    return response.json({ email: user.email, secret: totp.formatSecret(secret), otpauthUrl: url, qr: mfa.qrDataUrl(url) });
  } catch (error) {
    return next(error);
  }
});

// Primera vez: confirma con un código que la aplicación quedó bien configurada y activa el segundo paso.
router.post('/enable', mfaLimiter, async (request, response, next) => {
  try {
    const context = await pendingContext(request, response, 'enroll');
    if (!context) return null;
    const { token, pending, user } = context;
    if (!pending.enrollSecretEnc) {
      return response.status(400).json({ error: 'SETUP_REQUIRED', message: 'Primero escanea el código QR o escribe la clave en la aplicación.' });
    }
    const secret = decryptSecret(pending.enrollSecretEnc);
    const step = totp.verifyCode(secret, request.body.code);
    if (step === null) return codeFailed(response, token, user);

    const client = await pool.connect();
    let recoveryCodes;
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET totp_secret_enc = $2, totp_enabled = TRUE, totp_last_step = $3, updated_at = NOW() WHERE id = $1',
        [user.id, encryptSecret(secret), step]
      );
      recoveryCodes = await mfa.replaceRecoveryCodes(client, user.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return finishLogin(response, token, user, { recoveryCodes });
  } catch (error) {
    return next(error);
  }
});

// Cada ingreso: código de 6 dígitos de la aplicación, o uno de los códigos de respaldo.
router.post('/verify', mfaLimiter, async (request, response, next) => {
  try {
    const context = await pendingContext(request, response, 'verify');
    if (!context) return null;
    const { token, user } = context;
    if (request.body.recoveryCode) {
      if (!(await mfa.consumeRecoveryCode(user.id, request.body.recoveryCode))) return codeFailed(response, token, user);
      return finishLogin(response, token, user, { recoveryCodesLeft: await mfa.countRecoveryCodes(user.id) });
    }
    if (!(await mfa.verifyUserCode(user, request.body.code))) return codeFailed(response, token, user);
    return finishLogin(response, token, user);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
