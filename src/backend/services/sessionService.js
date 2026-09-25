const crypto = require('node:crypto');
const { redis } = require('../config/redis');

const SESSION_COOKIE = 'comcesa_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function sessionKey(token) {
  return `session:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

async function connectRedis() {
  if (redis.status === 'wait') {
    await redis.connect();
  }
}

async function createSession(user) {
  await connectRedis();
  const token = crypto.randomBytes(32).toString('base64url');
  await redis.set(sessionKey(token), JSON.stringify(user), 'EX', SESSION_TTL_SECONDS);
  return token;
}

async function getSession(token) {
  if (!token) return null;
  await connectRedis();
  const value = await redis.get(sessionKey(token));
  return value ? JSON.parse(value) : null;
}

async function destroySession(token) {
  if (!token) return;
  await connectRedis();
  await redis.del(sessionKey(token));
}

function cookieOptions(isProduction) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: SESSION_TTL_SECONDS,
    path: '/'
  };
}

module.exports = {
  SESSION_COOKIE,
  createSession,
  getSession,
  destroySession,
  cookieOptions
};