const bcrypt = require('bcryptjs');
const express = require('express');
const { parse, serialize } = require('cookie');
const rateLimit = require('express-rate-limit');
const { pool } = require('../config/database');
const env = require('../config/env');
const { z } = require('zod');
const { requireAuthAllowPending } = require('../middlewares/auth');
const { newPasswordSchema, hashPassword } = require('../services/passwordService');
const { createResetCode, consumeResetCode } = require('../services/resetService');
const { sendMail, mailConfigured } = require('../services/mailer');
const {
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  destroySession
} = require('../services/sessionService');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 });
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 });

router.post('/login', loginLimiter, async (request, response, next) => {
  try {
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');

    if (!email || !password || password.length > 200) {
      return response.status(400).json({ error: 'INVALID_CREDENTIALS', message: 'Credenciales invalidas' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, role, must_change_password FROM users WHERE email = $1 AND active = TRUE LIMIT 1',
      [email]
    );
    const user = result.rows[0];
    const validPassword = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!validPassword) {
      return response.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Credenciales invalidas' });
    }

    const token = await createSession({ id: user.id, email: user.email, role: user.role });
    response.setHeader('Set-Cookie', serialize(SESSION_COOKIE, token, cookieOptions(env.NODE_ENV === 'production')));
    response.json({ user: { email: user.email, role: user.role }, mustChangePassword: user.must_change_password });
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireAuthAllowPending, (request, response) => {
  response.json({ user: request.user });
});

router.post('/logout', async (request, response, next) => {
  try {
    const cookies = parse(request.headers.cookie || '');
    await destroySession(cookies[SESSION_COOKIE]);
    response.setHeader('Set-Cookie', serialize(SESSION_COOKIE, '', {
      ...cookieOptions(env.NODE_ENV === 'production'),
      maxAge: 0
    }));
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/change-password', requireAuthAllowPending, async (request, response, next) => {
  try {
    const currentPassword = String(request.body.currentPassword || '');
    const parsed = newPasswordSchema.safeParse(request.body.newPassword);
    if (!parsed.success) {
      return response.status(400).json({ error: 'WEAK_PASSWORD', message: parsed.error.issues[0].message });
    }
    if (parsed.data === currentPassword) {
      return response.status(400).json({ error: 'SAME_PASSWORD', message: 'La nueva contraseña debe ser distinta a la actual' });
    }
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [request.user.id]);
    const valid = result.rows[0] ? await bcrypt.compare(currentPassword, result.rows[0].password_hash) : false;
    if (!valid) {
      return response.status(400).json({ error: 'INVALID_CURRENT_PASSWORD', message: 'La contraseña actual no es correcta' });
    }
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2',
      [await hashPassword(parsed.data), request.user.id]
    );
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

// Siempre responde igual para no revelar si el correo existe.
router.post('/forgot', forgotLimiter, async (request, response, next) => {
  try {
    const email = String(request.body.email || '').trim().toLowerCase();
    if (z.string().email().safeParse(email).success && mailConfigured()) {
      const result = await pool.query('SELECT 1 FROM users WHERE email = $1 AND active = TRUE', [email]);
      if (result.rowCount > 0) {
        const code = await createResetCode(email);
        await sendMail({
          to: email,
          subject: 'COMCESA - Código para recuperar tu contraseña',
          text: `Tu código de recuperación es: ${code}\n\nVence en 15 minutos. Si no lo solicitaste, ignora este mensaje.`
        });
      }
    }
    response.json({ ok: true, emailEnabled: mailConfigured() });
  } catch (error) {
    next(error);
  }
});

router.post('/reset', resetLimiter, async (request, response, next) => {
  try {
    const email = String(request.body.email || '').trim().toLowerCase();
    const code = String(request.body.code || '').trim();
    const parsed = newPasswordSchema.safeParse(request.body.newPassword);
    if (!parsed.success) {
      return response.status(400).json({ error: 'WEAK_PASSWORD', message: parsed.error.issues[0].message });
    }
    if (!/^\d{6}$/.test(code) || !(await consumeResetCode(email, code))) {
      return response.status(400).json({ error: 'INVALID_CODE', message: 'El código no es válido o ya venció' });
    }
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE email = $2 AND active = TRUE',
      [await hashPassword(parsed.data), email]
    );
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;