const express = require('express');
const { z } = require('zod');
const { pool } = require('../config/database');
const { isMasterEmail } = require('../config/masters');
const { requireAuth, requireAdmin } = require('../middlewares/auth');
const { generateTempPassword, hashPassword } = require('../services/passwordService');
const { isMasterUser, permissionsFor } = require('../services/permissions');
const { LOCK_FIELDS, UNLOCK_SQL } = require('../services/lockoutService');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['admin', 'viewer']).default('viewer')
});
const updateSchema = z.object({
  role: z.enum(['admin', 'viewer']).optional(),
  active: z.boolean().optional()
}).refine((value) => value.role !== undefined || value.active !== undefined);
const idSchema = z.string().uuid();

const COLUMNS = 'id, email, role, active, must_change_password, created_at';
const COLUMNS_WITH_LOCK = `${COLUMNS}, ${LOCK_FIELDS}`;

function forbidden(response, message = 'No tienes permiso para hacer esto con ese usuario') {
  return response.status(403).json({ error: 'ACTION_FORBIDDEN', message });
}

// Datos que se envían al navegador: sin hash y con el estado de bloqueo y los permisos ya calculados.
function present(actor, row) {
  const lockState = row.locked_permanently ? 'permanent' : (row.temp_locked ? 'temporary' : 'none');
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active,
    must_change_password: row.must_change_password,
    created_at: row.created_at,
    is_master: isMasterUser(row),
    lock_state: lockState,
    lock_minutes: lockState === 'temporary' ? row.lock_minutes : 0,
    permissions: permissionsFor(actor, row)
  };
}

async function findTarget(request, response) {
  if (!idSchema.safeParse(request.params.id).success) {
    response.status(400).json({ error: 'INVALID_ID', message: 'Id inválido' });
    return null;
  }
  const result = await pool.query(`SELECT ${COLUMNS_WITH_LOCK} FROM users WHERE id = $1`, [request.params.id]);
  if (!result.rowCount) {
    response.status(404).json({ error: 'NOT_FOUND', message: 'Usuario no encontrado' });
    return null;
  }
  return result.rows[0];
}

router.get('/', async (request, response, next) => {
  try {
    const result = await pool.query(`SELECT ${COLUMNS_WITH_LOCK} FROM users ORDER BY role, email`);
    response.json({ users: result.rows.map((row) => present(request.user, row)) });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (request, response, next) => {
  try {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: 'INVALID_USER', message: 'Correo o rol inválido' });
    }
    const actorIsMaster = isMasterUser(request.user);
    let { role } = parsed.data;
    if (isMasterEmail(parsed.data.email)) {
      if (!actorIsMaster) return forbidden(response, 'Solo un usuario master puede crear a otro usuario master');
      role = 'admin';
    }
    if (role === 'admin' && !actorIsMaster) {
      return forbidden(response, 'Solo un usuario master puede crear administradores');
    }
    const tempPassword = generateTempPassword();
    try {
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, TRUE) RETURNING ${COLUMNS_WITH_LOCK}`,
        [parsed.data.email, await hashPassword(tempPassword), role]
      );
      response.status(201).json({ user: present(request.user, result.rows[0]), tempPassword });
    } catch (error) {
      if (error.code === '23505') {
        return response.status(409).json({ error: 'USER_EXISTS', message: 'Ese correo ya existe' });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

// Restablecer la contraseña también desbloquea el usuario.
router.post('/:id/reset-password', async (request, response, next) => {
  try {
    const target = await findTarget(request, response);
    if (!target) return null;
    if (target.id === request.user.id) {
      return response.status(400).json({ error: 'SELF_CHANGE', message: 'Para cambiar tu propia contraseña usa la opción de cambiar contraseña' });
    }
    if (!permissionsFor(request.user, target).resetPassword) return forbidden(response);
    const tempPassword = generateTempPassword();
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE, ${UNLOCK_SQL}, updated_at = NOW()
       WHERE id = $2 RETURNING ${COLUMNS_WITH_LOCK}`,
      [await hashPassword(tempPassword), target.id]
    );
    return response.json({ user: present(request.user, result.rows[0]), tempPassword });
  } catch (error) {
    return next(error);
  }
});

router.post('/:id/unlock', async (request, response, next) => {
  try {
    const target = await findTarget(request, response);
    if (!target) return null;
    if (target.id === request.user.id) {
      return response.status(400).json({ error: 'SELF_CHANGE', message: 'No puedes cambiar tu propio estado' });
    }
    if (!permissionsFor(request.user, target).unlock) return forbidden(response);
    const result = await pool.query(
      `UPDATE users SET ${UNLOCK_SQL}, updated_at = NOW() WHERE id = $1 RETURNING ${COLUMNS_WITH_LOCK}`,
      [target.id]
    );
    return response.json({ user: present(request.user, result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

router.patch('/:id', async (request, response, next) => {
  try {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: 'INVALID_USER', message: 'Datos inválidos' });
    }
    const target = await findTarget(request, response);
    if (!target) return null;
    if (target.id === request.user.id) {
      return response.status(400).json({ error: 'SELF_CHANGE', message: 'No puedes cambiar tu propio rol o estado' });
    }
    const allowed = permissionsFor(request.user, target);
    if (parsed.data.role !== undefined && parsed.data.role !== target.role && !allowed.changeRole) return forbidden(response);
    if (parsed.data.active !== undefined && parsed.data.active !== target.active && !allowed.toggleActive) return forbidden(response);
    const result = await pool.query(
      `UPDATE users SET role = COALESCE($1, role), active = COALESCE($2, active), updated_at = NOW()
       WHERE id = $3 RETURNING ${COLUMNS_WITH_LOCK}`,
      [parsed.data.role ?? null, parsed.data.active ?? null, target.id]
    );
    return response.json({ user: present(request.user, result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

router.delete('/:id', async (request, response, next) => {
  try {
    const target = await findTarget(request, response);
    if (!target) return null;
    if (target.id === request.user.id) {
      return response.status(400).json({ error: 'SELF_DELETE', message: 'No puedes eliminar tu propio usuario' });
    }
    if (!permissionsFor(request.user, target).delete) {
      return forbidden(response, isMasterUser(target)
        ? 'Los usuarios master no se pueden eliminar'
        : 'Solo un usuario master puede eliminar administradores');
    }
    await pool.query('DELETE FROM users WHERE id = $1', [target.id]);
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
