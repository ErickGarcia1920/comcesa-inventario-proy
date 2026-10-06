const crypto = require('node:crypto');
const { redis } = require('../config/redis');

const RESET_TTL_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 5;

const keyFor = (email) => `reset:${email}`;
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

async function connect() {
  if (redis.status === 'wait') await redis.connect();
}

async function createResetCode(email) {
  await connect();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await redis.set(keyFor(email), JSON.stringify({ hash: hashCode(code), attempts: 0 }), 'EX', RESET_TTL_SECONDS);
  return code;
}

async function consumeResetCode(email, code) {
  await connect();
  const raw = await redis.get(keyFor(email));
  if (!raw) return false;
  const data = JSON.parse(raw);
  if (data.attempts >= MAX_ATTEMPTS) { await redis.del(keyFor(email)); return false; }
  const expected = Buffer.from(data.hash, 'hex');
  const received = Buffer.from(hashCode(code), 'hex');
  if (!crypto.timingSafeEqual(expected, received)) {
    data.attempts += 1;
    const ttl = await redis.ttl(keyFor(email));
    await redis.set(keyFor(email), JSON.stringify(data), 'EX', Math.max(ttl, 1));
    return false;
  }
  await redis.del(keyFor(email));
  return true;
}

module.exports = { createResetCode, consumeResetCode };
