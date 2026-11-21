const { pool } = require('../config/database');

// Las líneas se comparan sin importar mayúsculas, minúsculas ni espacios sobrantes.
// La línea vacía ('') significa "artículos sin línea".
const NO_LINE_TOKEN = '__SIN_LINEA__';
const normalizeLine = (value) => String(value ?? '').trim().toUpperCase();

// Cómo se ve la línea de un artículo en SQL (misma regla que normalizeLine).
const LINE_SQL = "UPPER(COALESCE(TRIM(i.lin_prod), ''))";

// Todas las líneas que existen, con cuántos artículos tiene cada una.
async function listAllLines() {
  const { rows } = await pool.query(`
    SELECT UPPER(COALESCE(TRIM(lin_prod), '')) AS line, COUNT(*)::integer AS articles
    FROM inve GROUP BY 1 ORDER BY 1`);
  return rows.map((row) => ({ line: row.line, label: row.line || 'Sin línea', articles: row.articles }));
}

async function getUserLineAccess(userId) {
  const user = await pool.query('SELECT restrict_lines FROM users WHERE id = $1', [userId]);
  if (!user.rowCount) return null;
  const lines = await pool.query('SELECT line FROM user_allowed_lines WHERE user_id = $1 ORDER BY line', [userId]);
  return { restricted: user.rows[0].restrict_lines, lines: lines.rows.map((row) => row.line) };
}

// restricted = false -> ve todas las líneas (se borra la lista).
// restricted = true  -> solo ve las líneas indicadas.
async function setUserLineAccess(userId, restricted, lines) {
  const clean = [...new Set((lines || []).map(normalizeLine))].slice(0, 1000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET restrict_lines = $2, updated_at = NOW() WHERE id = $1', [userId, Boolean(restricted)]);
    await client.query('DELETE FROM user_allowed_lines WHERE user_id = $1', [userId]);
    if (restricted && clean.length) {
      await client.query('INSERT INTO user_allowed_lines (user_id, line) SELECT $1, unnest($2::text[])', [userId, clean]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { restricted: Boolean(restricted), lines: restricted ? clean.sort() : [] };
}

// Líneas que puede ver quien hace la petición: null = todas (administradores y consultores sin restricción).
async function allowedLinesFor(user) {
  if (!user || user.role === 'admin' || !user.restrictLines) return null;
  const { rows } = await pool.query('SELECT line FROM user_allowed_lines WHERE user_id = $1', [user.id]);
  return rows.map((row) => row.line);
}

module.exports = { NO_LINE_TOKEN, LINE_SQL, normalizeLine, listAllLines, getUserLineAccess, setUserLineAccess, allowedLinesFor };
