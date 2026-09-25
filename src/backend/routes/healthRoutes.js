const express = require('express');
const { checkDatabase } = require('../config/database');
const { checkRedis } = require('../config/redis');

const router = express.Router();

router.get('/health', (request, response) => {
  response.json({ status: 'ok', service: 'comcesa-backend' });
});

router.get('/ready', async (request, response, next) => {
  try {
    await Promise.all([checkDatabase(), checkRedis()]);
    response.json({ status: 'ready' });
  } catch (error) {
    error.statusCode = 503;
    error.code = 'DEPENDENCY_UNAVAILABLE';
    next(error);
  }
});

module.exports = router;