const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middlewares/auth');
const { findInventory } = require('../services/inventoryService');

const router = express.Router();
const filtersSchema = z.object({
  search: z.string().trim().max(100).optional(),
  warehouse: z.coerce.number().int().positive().optional(),
  line: z.string().trim().max(20).optional(),
  status: z.string().length(1).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['article', 'description', 'warehouse', 'stock']).default('article'),
  direction: z.enum(['asc', 'desc']).default('asc')
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