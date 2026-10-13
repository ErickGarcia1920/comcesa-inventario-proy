const { pool } = require('../config/database');

// Bodegas que no deben mostrarse nunca. Se pueden cambiar con la variable de
// entorno EXCLUDED_WAREHOUSES (por ejemplo "8,25"). Solo se aceptan enteros.
const EXCLUDED_WAREHOUSES = (process.env.EXCLUDED_WAREHOUSES ?? '8,25')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

// Dentro de cada artículo, las bodegas se ordenan de mayor a menor existencia.
// El último criterio (m.cve_alm) mantiene estable el orden entre páginas.
function buildOrderBy(sort, direction) {
  switch (sort) {
    case 'description':
      return 'i.descr ASC, i.cve_art COLLATE "C" ASC, m.exist DESC, m.cve_alm ASC';
    case 'warehouse':
      return 'm.cve_alm ASC, m.exist DESC, i.cve_art COLLATE "C" ASC';
    case 'stock':
      return `m.exist ${direction === 'asc' ? 'ASC' : 'DESC'}, i.cve_art COLLATE "C" ASC, m.cve_alm ASC`;
    default:
      return 'i.cve_art COLLATE "C" ASC, m.exist DESC, m.cve_alm ASC';
  }
}

function buildFilter(filters) {
  // Solo se muestran registros con existencia mayor a cero.
  const conditions = ['m.exist > 0'];
  const values = [];
  if (EXCLUDED_WAREHOUSES.length) {
    conditions.push(`m.cve_alm NOT IN (${EXCLUDED_WAREHOUSES.join(', ')})`);
  }

  if (filters.search) {
    values.push(`%${filters.search}%`);
    conditions.push(`(i.cve_art ILIKE $${values.length} OR i.descr ILIKE $${values.length})`);
  }
  let articleFrom = (filters.articleFrom || '').toUpperCase();
  let articleTo = (filters.articleTo || '').toUpperCase();
  if (articleFrom && articleTo && articleFrom > articleTo) [articleFrom, articleTo] = [articleTo, articleFrom];
  if (articleFrom) {
    values.push(articleFrom);
    conditions.push(`UPPER(i.cve_art) COLLATE "C" >= $${values.length}`);
  }
  if (articleTo) {
    values.push(articleTo);
    conditions.push(`UPPER(i.cve_art) COLLATE "C" <= $${values.length}`);
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
  return { where, values };
}

const SELECT_COLUMNS = `
      i.cve_art AS article,
      i.descr AS description,
      i.lin_prod AS line,
      i.uni_med AS unit,
      m.cve_alm AS warehouse,
      m.status,
      m.ctrl_alm AS warehouse_name,
      m.exist AS stock`;

async function findInventory(filters) {
  const { where, values } = buildFilter(filters);
  const orderBy = buildOrderBy(filters.sort, filters.direction);
  const offset = (filters.page - 1) * filters.limit;

  const countResult = await pool.query(`
    SELECT COUNT(*)::integer AS total
    FROM inve i
    INNER JOIN mult m ON m.cve_art = i.cve_art
    ${where}
  `, values);

  const dataValues = [...values, filters.limit, offset];
  const result = await pool.query(`
    SELECT${SELECT_COLUMNS}
    FROM inve i
    INNER JOIN mult m ON m.cve_art = i.cve_art
    ${where}
    ORDER BY ${orderBy}
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

// Todas las filas que cumplen los filtros (sin paginar), para descargar en Excel.
// Se piden maxRows + 1 filas para poder detectar que se pasó del límite.
async function findInventoryForExport(filters, maxRows) {
  const { where, values } = buildFilter(filters);
  const orderBy = buildOrderBy(filters.sort, filters.direction);
  const result = await pool.query(`
    SELECT${SELECT_COLUMNS}
    FROM inve i
    INNER JOIN mult m ON m.cve_art = i.cve_art
    ${where}
    ORDER BY ${orderBy}
    LIMIT $${values.length + 1}
  `, [...values, maxRows + 1]);
  return result.rows;
}

module.exports = { findInventory, findInventoryForExport };