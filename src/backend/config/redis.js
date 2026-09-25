const Redis = require('ioredis');
const env = require('./env');

const redis = new Redis(env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false
});

redis.on('error', (error) => {
  console.error('Redis error', error.message);
});

async function checkRedis() {
  if (redis.status === 'wait') {
    await redis.connect();
  }
  await redis.ping();
}

module.exports = { redis, checkRedis };