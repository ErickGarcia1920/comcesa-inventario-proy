const { pool } = require('../config/database');
const { ALLOWED_WAREHOUSES } = require('../config/warehouses');

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
  // Solo las bodegas autorizadas (la lista son enteros validados, no texto del usuario).
  const values = [];
  const conditions = [`m.cve_alm IN (${ALLOWED_WAREHOUSES.join(', ')})`];

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
  // Estado según la existencia: A = Activo (con stock), I = Sin stock (cero o negativa).
  if (filters.status === 'A') conditions.push('m.exist > 0');
  if (filters.status === 'I') conditions.push('m.exist <= 0');

  return { where: `WHERE ${conditions.join(' AND ')}`, values };
}

function selectColumns(includeCosts) {
  return `
      i.cve_art AS article,
      i.descr AS description,
      i.lin_prod AS line,
      i.uni_med AS unit,
      m.cve_alm AS warehouse,
      a.nombre AS warehouse_name,
      m.exist AS stock${includeCosts ? `,
      i.costo_prom AS avg_cost,
      i.ult_costo AS last_cost` : ''}`;
}

const FROM = `
    FROM inve i
    INNER JOIN mult m ON m.cve_art = i.cve_art
    LEFT JOIN almacenes a ON a.cve_alm = m.cve_alm`;

// Los costos solo se piden a la base cuando includeCosts es true (administradores):
// a un consultor nunca le llegan, ni siquiera ocultos en la respuesta.
async function findInventory(filters, { includeCosts = false } = {}) {
  const { where, values } = buildFilter(filters);
  const orderBy = buildOrderBy(filters.sort, filters.direction);
  const offset = (filters.page - 1) * filters.limit;

  const countResult = await pool.query(`SELECT COUNT(*)::integer AS total ${FROM} ${where}`, values);

  const dataValues = [...values, filters.limit, offset];
  const result = await pool.query(`
    SELECT${selectColumns(includeCosts)}
    ${FROM}
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

// Todas las filas que cumplen los filtros (sin paginar), para descargar en Excel (solo administradores).
// Se piden maxRows + 1 filas para poder detectar que se pasó del límite.
async function findInventoryForExport(filters, maxRows) {
  const { where, values } = buildFilter(filters);
  const orderBy = buildOrderBy(filters.sort, filters.direction);
  const result = await pool.query(`
    SELECT${selectColumns(true)}
    ${FROM}
    ${where}
    ORDER BY ${orderBy}
    LIMIT $${values.length + 1}
  `, [...values, maxRows + 1]);
  return result.rows;
}

// Bodegas autorizadas con su nombre (si todavía no se ha cargado el nombre, name = null).
async function findWarehouses() {
  const result = await pool.query(`
    SELECT w.cve_alm AS id, a.nombre AS name
    FROM unnest($1::int[]) AS w(cve_alm)
    LEFT JOIN almacenes a ON a.cve_alm = w.cve_alm
    ORDER BY w.cve_alm
  `, [ALLOWED_WAREHOUSES]);
  return result.rows;
}

module.exports = { findInventory, findInventoryForExport, findWarehouses };
