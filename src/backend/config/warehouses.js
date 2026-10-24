// Bodegas autorizadas para consulta. Cualquier otra bodega nunca se muestra ni se descarga.
// Se puede cambiar con la variable de entorno ALLOWED_WAREHOUSES (por ejemplo "1,3,4,11").
const DEFAULT_WAREHOUSES = [1, 3, 4, 11, 14, 15, 16, 18, 20, 23, 24, 28, 31, 35, 36];

function parseWarehouses(value) {
  if (!value || !String(value).trim()) return null;
  const list = String(value).split(',').map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0);
  return list.length ? [...new Set(list)] : null;
}

const ALLOWED_WAREHOUSES = parseWarehouses(process.env.ALLOWED_WAREHOUSES) || DEFAULT_WAREHOUSES;

module.exports = { ALLOWED_WAREHOUSES, DEFAULT_WAREHOUSES };
