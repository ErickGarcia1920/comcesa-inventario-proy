const { pool } = require('../config/database');
const { ALLOWED_WAREHOUSES } = require('../config/warehouses');

// ---------- Lista de precios que se muestra ----------
// Por defecto la lista "1" (se cambia con la variable DEFAULT_PRICE_LIST). Si esa lista no existe,
// se usa la primera lista activa que haya. El resultado se guarda 1 minuto para no consultarlo en cada búsqueda.
let priceListCache = { at: 0, value: null };

async function getDefaultPriceList() {
  if (Date.now() - priceListCache.at < 60 * 1000) return priceListCache.value;
  const wanted = process.env.DEFAULT_PRICE_LIST || '1';
  let result = await pool.query('SELECT cve_precio, descripcion, con_impu FROM precios01 WHERE cve_precio = $1', [wanted]);
  if (!result.rowCount) {
    result = await pool.query("SELECT cve_precio, descripcion, con_impu FROM precios01 ORDER BY (status = 'A') DESC, cve_precio LIMIT 1");
  }
  const row = result.rows[0];
  const value = row ? { id: row.cve_precio, name: String(row.descripcion || '').trim(), withTax: Boolean(row.con_impu) } : null;
  priceListCache = { at: Date.now(), value };
  return value;
}

function resetPriceListCache() {
  priceListCache = { at: 0, value: null };
}

// Un precio en cero se toma como "sin precio" (se muestra "—"); lo demás llega como número.
function cleanPrice(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

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

function selectColumns(includeCosts, priceParam) {
  const price = priceParam
    ? `(SELECT x.precio FROM precio_x_prod01 x WHERE x.cve_art = i.cve_art AND x.cve_precio = $${priceParam})`
    : 'NULL::numeric';
  return `
      i.cve_art AS article,
      i.descr AS description,
      i.lin_prod AS line,
      i.uni_med AS unit,
      m.cve_alm AS warehouse,
      a.nombre AS warehouse_name,
      m.exist AS stock,
      ${price} AS price${includeCosts ? `,
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

  const priceList = await getDefaultPriceList();
  const dataValues = [...values];
  let priceParam = null;
  if (priceList) { dataValues.push(priceList.id); priceParam = dataValues.length; }
  dataValues.push(filters.limit, offset);
  const result = await pool.query(`
    SELECT${selectColumns(includeCosts, priceParam)}
    ${FROM}
    ${where}
    ORDER BY ${orderBy}
    LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}
  `, dataValues);

  return {
    items: result.rows.map((row) => ({ ...row, price: cleanPrice(row.price) })),
    page: filters.page,
    limit: filters.limit,
    total: countResult.rows[0].total,
    totalPages: Math.ceil(countResult.rows[0].total / filters.limit),
    priceList
  };
}

// Todas las filas que cumplen los filtros (sin paginar), para descargar en Excel (solo administradores).
// Se piden maxRows + 1 filas para poder detectar que se pasó del límite.
async function findInventoryForExport(filters, maxRows) {
  const { where, values } = buildFilter(filters);
  const orderBy = buildOrderBy(filters.sort, filters.direction);
  const priceList = await getDefaultPriceList();
  const dataValues = [...values];
  let priceParam = null;
  if (priceList) { dataValues.push(priceList.id); priceParam = dataValues.length; }
  dataValues.push(maxRows + 1);
  const result = await pool.query(`
    SELECT${selectColumns(true, priceParam)}
    ${FROM}
    ${where}
    ORDER BY ${orderBy}
    LIMIT $${dataValues.length}
  `, dataValues);
  return result.rows.map((row) => ({ ...row, price: cleanPrice(row.price) }));
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

module.exports = { findInventory, findInventoryForExport, findWarehouses, getDefaultPriceList, resetPriceListCache };
