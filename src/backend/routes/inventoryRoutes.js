const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middlewares/auth');
const rateLimit = require('express-rate-limit');
const { findInventory, findInventoryForExport } = require('../services/inventoryService');
const { writeInventoryWorkbook } = require('../services/exportService');

const router = express.Router();
const filtersSchema = z.object({
  search: z.string().trim().max(100).optional(),
  articleFrom: z.string().trim().max(40).optional(),
  articleTo: z.string().trim().max(40).optional(),
  warehouse: z.coerce.number().int().positive().optional(),
  line: z.string().trim().max(20).optional(),
  status: z.string().length(1).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['article', 'description', 'warehouse', 'stock']).default('article'),
  direction: z.enum(['asc', 'desc']).optional()
});

// Límite de filas por archivo y de descargas por usuario (protege el servidor gratuito).
const MAX_EXPORT_ROWS = 50000;
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Hiciste muchas descargas seguidas. Espera unos minutos e intenta de nuevo.' }
});

router.get('/export', requireAuth, exportLimiter, async (request, response, next) => {
  try {
    const parsed = filtersSchema.safeParse(request.query);
    if (!parsed.success) {
      return response.status(400).json({ error: 'INVALID_FILTERS', message: 'Los filtros no son validos' });
    }
    const rows = await findInventoryForExport(parsed.data, MAX_EXPORT_ROWS);
    if (rows.length > MAX_EXPORT_ROWS) {
      return response.status(413).json({ error: 'TOO_MANY_ROWS', message: 'Hay demasiados registros para descargar. Aplica un filtro e intenta de nuevo.' });
    }
    await writeInventoryWorkbook(response, rows, parsed.data);
  } catch (error) {
    if (response.headersSent) { response.destroy(error); return; }
    next(error);
  }
});

router.get('/', requireAuth, async (request, response, next) => {
  try {
    const parsed = filtersSchema.safeParse(request.query);
    if (!parsed.success) {
      return response.status(400).json({ error: 'INVALID_FILTERS', message: 'Los filtros no son validos' });
    }
    response.json(await findInventory(parsed.data));
  } catch (error) {
    next(error);
  }
});

module.exports = router;