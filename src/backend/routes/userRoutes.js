const express = require('express');
const { z } = require('zod');
const { pool } = require('../config/database');
const { requireAuth, requireAdmin } = require('../middlewares/auth');
const { generateTempPassword, hashPassword } = require('../services/passwordService');

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

router.get('/', async (request, response, next) => {
  try {
    const result = await pool.query(`SELECT ${COLUMNS} FROM users ORDER BY role, email`);
    response.json({ users: result.rows });
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
    const tempPassword = generateTempPassword();
    try {
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, TRUE) RETURNING ${COLUMNS}`,
        [parsed.data.email, await hashPassword(tempPassword), parsed.data.role]
      );
      response.status(201).json({ user: result.rows[0], tempPassword });
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

router.post('/:id/reset-password', async (request, response, next) => {
  try {
    if (!idSchema.safeParse(request.params.id).success) {
      return response.status(400).json({ error: 'INVALID_ID', message: 'Id inválido' });
    }
    const tempPassword = generateTempPassword();
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW()
       WHERE id = $2 RETURNING ${COLUMNS}`,
      [await hashPassword(tempPassword), request.params.id]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'NOT_FOUND', message: 'Usuario no encontrado' });
    response.json({ user: result.rows[0], tempPassword });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (request, response, next) => {
  try {
    const parsed = updateSchema.safeParse(request.body);
    if (!idSchema.safeParse(request.params.id).success || !parsed.success) {
      return response.status(400).json({ error: 'INVALID_USER', message: 'Datos inválidos' });
    }
    if (request.params.id === request.user.id) {
      return response.status(400).json({ error: 'SELF_CHANGE', message: 'No puedes cambiar tu propio rol o estado' });
    }
    const result = await pool.query(
      `UPDATE users SET role = COALESCE($1, role), active = COALESCE($2, active), updated_at = NOW()
       WHERE id = $3 RETURNING ${COLUMNS}`,
      [parsed.data.role ?? null, parsed.data.active ?? null, request.params.id]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'NOT_FOUND', message: 'Usuario no encontrado' });
    response.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (request, response, next) => {
  try {
    if (!idSchema.safeParse(request.params.id).success) {
      return response.status(400).json({ error: 'INVALID_ID', message: 'Id inválido' });
    }
    if (request.params.id === request.user.id) {
      return response.status(400).json({ error: 'SELF_DELETE', message: 'No puedes eliminar tu propio usuario' });
    }
    const result = await pool.query('DELETE FROM users WHERE id = $1', [request.params.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'NOT_FOUND', message: 'Usuario no encontrado' });
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
