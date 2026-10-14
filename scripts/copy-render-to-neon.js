/**
 * Copia los datos de la base de Render a la base de Neon (la del .env).
 * Uso (CMD, dentro de la carpeta del proyecto):
 *   set SOURCE_URL=postgresql://...render.com/comcesa
 *   node scripts/copy-render-to-neon.js
 * Se puede correr varias veces sin duplicar datos.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { ensureDatabaseSchema } = require('../src/backend/config/schema');

const SOURCE_URL = process.env.SOURCE_URL;
const TARGET_URL = process.env.DATABASE_URL;

if (!SOURCE_URL || !TARGET_URL) {
  console.error('Falta SOURCE_URL (Render) o DATABASE_URL (Neon, en el .env).');
  process.exit(1);
}
if (SOURCE_URL === TARGET_URL) {
  console.error('SOURCE_URL y DATABASE_URL son iguales. Revisa que el .env apunte a Neon.');
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };
const src = new Pool({ connectionString: SOURCE_URL, ssl, max: 2 });
const dst = new Pool({ connectionString: TARGET_URL, ssl, max: 2 });

// Orden importante por las llaves foraneas.
const TABLES = [
  { name: 'users', conflict: ['email'] },
  { name: 'inve', conflict: ['cve_art'] },
  { name: 'precios01', conflict: ['cve_precio'] },
  { name: 'mult', conflict: ['cve_art', 'cve_alm'] },
  { name: 'precio_x_prod01', conflict: ['cve_art', 'cve_precio'] }
];

const CHUNK = 1000;

async function copyTable({ name, conflict }) {
  const { rows } = await src.query(`SELECT * FROM ${name}`);
  if (!rows.length) {
    console.log(`${name}: 0 filas (nada que copiar)`);
    return;
  }
  const cols = Object.keys(rows[0]);
  const updatable = cols.filter((c) => !conflict.includes(c) && c !== 'id');
  const onConflict = updatable.length
    ? `DO UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
    : 'DO NOTHING';

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params = [];
    const values = slice.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await dst.query(
      `INSERT INTO ${name} (${cols.join(', ')}) VALUES ${values.join(', ')}
       ON CONFLICT (${conflict.join(', ')}) ${onConflict}`,
      params
    );
    console.log(`${name}: ${Math.min(i + CHUNK, rows.length)} de ${rows.length}`);
  }
}

async function main() {
  console.log('Verificando tablas en Neon...');
  await ensureDatabaseSchema();
  for (const table of TABLES) {
    await copyTable(table);
  }
  const counts = [];
  for (const { name } of TABLES) {
    const { rows } = await dst.query(`SELECT COUNT(*)::int AS n FROM ${name}`);
    counts.push(`${name}=${rows[0].n}`);
  }
  console.log('LISTO. Filas en Neon:', counts.join(', '));
}

main()
  .catch((error) => {
    console.error('ERROR:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
    const { pool } = require('../src/backend/config/database');
    await pool.end().catch(() => {});
  });
