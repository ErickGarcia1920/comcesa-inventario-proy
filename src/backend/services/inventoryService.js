const { pool } = require('../config/database');

const sortableFields = {
  article: 'i.cve_art',
  description: 'i.descr',
  warehouse: 'm.cve_alm',
  stock: 'm.exist'
};

async function findInventory(filters) {
  const conditions = [];
  const values = [];

  if (filters.search) {
    values.push(`%${filters.search}%`);
    conditions.push(`(i.cve_art ILIKE $${values.length} OR i.descr ILIKE $${values.length})`);
  }
  if (filters.warehouse !== undefined) {
    values.push(filters.warehouse);
    conditions.push(`m.cve_alm = $${values.length}`);
  }
  if (filters.line) {
    values.push(filters.line);
    conditions.push(`i.lin_prod = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`m.status = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = sortableFields[filters.sort] || sortableFields.article;
  const direction = filters.direction === 'desc' ? 'DESC' : 'ASC';
  const offset = (filters.page - 1) * filters.limit;

  const countResult = await pool.query(`
    SELECT COUNT(*)::integer AS total
    FROM inve i
    INNER JOIN mult m ON m.cve_art = i.cve_art
    ${where}
  `, values);

  const dataValues = [...values, filters.limit, offset];
  const result = await pool.query(`
    SELECT
      i.cve_art AS article,
      i.descr AS description,
      i.lin_prod AS line,
      i.uni_med AS unit,
      m.cve_alm AS warehouse,
      m.status,
      m.ctrl_alm AS warehouse_name,
      m.exist AS stock
    FROM inve i
    INNER JOIN mult m ON m.cve_art = i.cve_art
    ${where}
    ORDER BY ${orderBy} ${direction}
    LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}
  `, dataValues);

  return {
    items: result.rows,
    page: filters.page,
    limit: filters.limit,
    total: countResult.rows[0].total,
    totalPages: Math.ceil(countResult.rows[0].total / filters.limit)
  };
}

module.exports = { findInventory };