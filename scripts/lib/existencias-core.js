/**
 * Lógica de sincronización continua de existencias (MULT01 de Aspel -> tabla mult de Postgres).
 *
 * Idea: se lee Aspel con frecuencia (es barato, está en la red local) y se compara contra lo último
 * confirmado en Postgres. SOLO si hay diferencias se escribe en Postgres. Así la base gratuita de
 * Neon puede apagarse sola cuando no hay movimientos y no gasta horas de cómputo.
 */

const KEY_SEPARATOR = '|';
const WRITE_BATCH = 1000;

function keyOf(row) {
  return `${row.cve_art}${KEY_SEPARATOR}${row.cve_alm}`;
}

// Fila de Aspel (columnas en mayúsculas) -> formato interno.
function normalizeSourceRow(row) {
  return {
    cve_art: String(row.CVE_ART),
    cve_alm: Number(row.CVE_ALM),
    status: String(row.STATUS ?? 'A').trim().slice(0, 1) || 'A',
    ctrl_alm: row.CTRL_ALM == null ? null : String(row.CTRL_ALM).slice(0, 20),
    exist: Number(row.EXIST ?? 0)
  };
}

// Fila de Postgres (columnas en minúsculas) -> formato interno.
function normalizeDbRow(row) {
  return {
    cve_art: String(row.cve_art),
    cve_alm: Number(row.cve_alm),
    status: String(row.status ?? 'A').trim().slice(0, 1) || 'A',
    ctrl_alm: row.ctrl_alm == null ? null : String(row.ctrl_alm),
    exist: Number(row.exist ?? 0)
  };
}

// Postgres guarda 4 decimales; se compara con esa precisión para no detectar cambios falsos.
function sameRow(a, b) {
  return a.status === b.status
    && (a.ctrl_alm ?? null) === (b.ctrl_alm ?? null)
    && Math.round(a.exist * 1e4) === Math.round(b.exist * 1e4);
}

// Compara el estado anterior (Map) contra las filas actuales de Aspel.
function diffRows(previous, sourceRows) {
  const next = new Map();
  const changed = [];
  for (const row of sourceRows) {
    const key = keyOf(row);
    next.set(key, row);
    const before = previous.get(key);
    if (!before || !sameRow(before, row)) changed.push(row);
  }
  const removed = [];
  for (const [key, row] of previous) {
    if (!next.has(key)) removed.push(row);
  }
  return { changed, removed, next };
}

async function loadDbSnapshot(db) {
  const [mult, inve] = await Promise.all([
    db.query('SELECT cve_art, cve_alm, status, ctrl_alm, exist FROM mult'),
    db.query('SELECT cve_art FROM inve')
  ]);
  const snapshot = new Map();
  for (const raw of mult.rows) {
    const row = normalizeDbRow(raw);
    snapshot.set(keyOf(row), row);
  }
  return { snapshot, known: new Set(inve.rows.map((r) => r.cve_art)) };
}

async function loadKnownArticles(db) {
  const { rows } = await db.query('SELECT cve_art FROM inve');
  return new Set(rows.map((r) => r.cve_art));
}

// Escribe los cambios en una sola transacción: todo o nada.
async function applyChanges(db, changed, removed) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < changed.length; i += WRITE_BATCH) {
      const chunk = changed.slice(i, i + WRITE_BATCH);
      await client.query(
        `INSERT INTO mult (cve_art, cve_alm, status, ctrl_alm, exist)
         SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::numeric[])
         ON CONFLICT (cve_art, cve_alm) DO UPDATE
         SET status = EXCLUDED.status, ctrl_alm = EXCLUDED.ctrl_alm, exist = EXCLUDED.exist`,
        [
          chunk.map((r) => r.cve_art), chunk.map((r) => r.cve_alm), chunk.map((r) => r.status),
          chunk.map((r) => r.ctrl_alm), chunk.map((r) => r.exist)
        ]
      );
    }
    for (let i = 0; i < removed.length; i += WRITE_BATCH) {
      const chunk = removed.slice(i, i + WRITE_BATCH);
      await client.query(
        `DELETE FROM mult USING (SELECT * FROM unnest($1::text[], $2::int[]) AS d(art, alm)) d
         WHERE mult.cve_art = d.art AND mult.cve_alm = d.alm`,
        [chunk.map((r) => r.cve_art), chunk.map((r) => r.cve_alm)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Crea el vigilante. `readSource()` debe devolver las filas de MULT de Aspel (CVE_ART, CVE_ALM,
 * STATUS, CTRL_ALM, EXIST). Cada llamada a tick() hace UNA revisión y devuelve qué pasó.
 */
function createWatcher({ db, readSource, now = () => Date.now(), reconcileMs = 6 * 60 * 60 * 1000, knownRefreshMs = 5 * 60 * 1000 }) {
  let snapshot = null;
  let known = new Set();
  let lastReconcile = 0;
  let lastKnownRefresh = 0;

  async function reconcile() {
    const loaded = await loadDbSnapshot(db);
    snapshot = loaded.snapshot;
    known = loaded.known;
    lastReconcile = now();
    lastKnownRefresh = now();
  }

  async function tick() {
    let sourceRows;
    try {
      sourceRows = (await readSource()).map(normalizeSourceRow);
    } catch (error) {
      return { ok: false, where: 'aspel', error };
    }

    try {
      if (snapshot === null || now() - lastReconcile >= reconcileMs) await reconcile();

      let diff = diffRows(snapshot, sourceRows);
      let unknown = diff.changed.filter((r) => !known.has(r.cve_art));
      if (unknown.length && now() - lastKnownRefresh >= knownRefreshMs) {
        known = await loadKnownArticles(db);
        lastKnownRefresh = now();
        unknown = diff.changed.filter((r) => !known.has(r.cve_art));
      }
      const toWrite = unknown.length ? diff.changed.filter((r) => known.has(r.cve_art)) : diff.changed;

      // Protección: si Aspel devolvió muchísimas filas menos de lo normal, no se borra nada.
      const suspicious = diff.removed.length > Math.max(50, snapshot.size * 0.05);
      const toRemove = suspicious ? [] : diff.removed;

      if (!toWrite.length && !toRemove.length) {
        if (!suspicious) snapshot = diff.next;
        return { ok: true, written: 0, removed: 0, skippedUnknown: unknown.length, suspicious };
      }

      await applyChanges(db, toWrite, toRemove);
      const next = diff.next;
      if (suspicious) for (const row of diff.removed) next.set(keyOf(row), row);
      snapshot = next;
      return { ok: true, written: toWrite.length, removed: toRemove.length, skippedUnknown: unknown.length, suspicious };
    } catch (error) {
      return { ok: false, where: 'neon', error };
    }
  }

  return { tick, get size() { return snapshot ? snapshot.size : 0; } };
}

module.exports = { createWatcher, diffRows, normalizeSourceRow, normalizeDbRow, sameRow, keyOf, applyChanges, loadDbSnapshot };
