const { parse } = require('cookie');
const { SESSION_COOKIE, getSession } = require('../services/sessionService');

async function requireAuth(request, response, next) {
  try {
    const cookies = parse(request.headers.cookie || '');
    const user = await getSession(cookies[SESSION_COOKIE]);

    if (!user) {
      return response.status(401).json({
        error: 'UNAUTHENTICATED',
        message: 'La sesion no es valida o ha expirado'
      });
    }

    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireAuth };