const { parse } = require('cookie');
const { pool } = require('../config/database');
const { SESSION_COOKIE, getSession } = require('../services/sessionService');

// El usuario se vuelve a leer de la base de datos en cada peticion: asi un
// usuario eliminado, desactivado o con otro rol pierde acceso de inmediato.
async function loadUser(request) {
  const cookies = parse(request.headers.cookie || '');
  const session = await getSession(cookies[SESSION_COOKIE]);
  if (!session) return null;
  const result = await pool.query(
    'SELECT id, email, role, active, must_change_password FROM users WHERE id = $1',
    [session.id]
  );
  const user = result.rows[0];
  if (!user || !user.active) return null;
  return { id: user.id, email: user.email, role: user.role, mustChangePassword: user.must_change_password };
}

function buildMiddleware({ allowPasswordPending }) {
  return async function authMiddleware(request, response, next) {
    try {
      const user = await loadUser(request);
      if (!user) {
        return response.status(401).json({ error: 'UNAUTHENTICATED', message: 'La sesion no es valida o ha expirado' });
      }
      if (user.mustChangePassword && !allowPasswordPending) {
        return response.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED', message: 'Debes cambiar tu contraseña antes de continuar' });
      }
      request.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const requireAuth = buildMiddleware({ allowPasswordPending: false });
const requireAuthAllowPending = buildMiddleware({ allowPasswordPending: true });

function requireAdmin(request, response, next) {
  if (request.user?.role !== 'admin') {
    return response.status(403).json({ error: 'FORBIDDEN', message: 'Solo un administrador puede hacer esto' });
  }
  next();
}

module.exports = { requireAuth, requireAuthAllowPending, requireAdmin };
