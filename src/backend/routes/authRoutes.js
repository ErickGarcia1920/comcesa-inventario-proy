const bcrypt = require('bcryptjs');
const express = require('express');
const { parse, serialize } = require('cookie');
const rateLimit = require('express-rate-limit');
const { pool } = require('../config/database');
const env = require('../config/env');
const { requireAuth } = require('../middlewares/auth');
const {
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  destroySession
} = require('../services/sessionService');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 });

router.post('/login', loginLimiter, async (request, response, next) => {
  try {
    const email = String(request.body.email || '').trim().toLowerCase();
    const password = String(request.body.password || '');

    if (!email || !password || password.length > 200) {
      return response.status(400).json({ error: 'INVALID_CREDENTIALS', message: 'Credenciales invalidas' });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, role FROM users WHERE email = $1 AND active = TRUE LIMIT 1',
      [email]
    );
    const user = result.rows[0];
    const validPassword = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!validPassword) {
      return response.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Credenciales invalidas' });
    }

    const token = await createSession({ id: user.id, email: user.email, role: user.role });
    response.setHeader('Set-Cookie', serialize(SESSION_COOKIE, token, cookieOptions(env.NODE_ENV === 'production')));
    response.json({ user: { email: user.email, role: user.role } });
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireAuth, (request, response) => {
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

module.exports = router;