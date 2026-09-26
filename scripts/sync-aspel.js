require('dotenv').config();

const sql = require('mssql');
const { pool } = require('../src/backend/config/database');

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Falta la variable de entorno ${name}. Revisa tu .env local.`);
	}
	return value;
}

function buildSqlServerConfig() {
	const instanceName = process.env.ASPEL_SQLSERVER_INSTANCE;
	const port = process.env.ASPEL_SQLSERVER_PORT;

	return {
		server: requireEnv('ASPEL_SQLSERVER_HOST'),
		database: requireEnv('ASPEL_SQLSERVER_DB'),
		user: requireEnv('ASPEL_SQLSERVER_USER'),
		password: requireEnv('ASPEL_SQLSERVER_PASSWORD'),
		options: {
			encrypt: process.env.ASPEL_SQLSERVER_ENCRYPT === 'true',
			trustServerCertificate: true,
			...(instanceName ? { instanceName } : {})
		},
		port: instanceName ? undefined : Number(port || 1433)
	};
}

async function syncInventario() {
	const sqlConfig = buildSqlServerConfig();
	const aspelPool = await sql.connect(sqlConfig);

	const articulos = await aspelPool.request().query('SELECT CVE_ART, DESCR, LIN_PROD, UNI_MED FROM dbo.INVE');
	const existencias = await aspelPool.request().query('SELECT CVE_ART, CVE_ALM, STATUS, CTRL_ALM, EXIST FROM dbo.MULT');

	for (const row of articulos.recordset) {
		await pool.query(`
			INSERT INTO inve (cve_art, descr, lin_prod, uni_med)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (cve_art) DO UPDATE SET descr = EXCLUDED.descr, lin_prod = EXCLUDED.lin_prod, uni_med = EXCLUDED.uni_med
		`, [row.CVE_ART.trim(), row.DESCR.trim(), row.LIN_PROD ? row.LIN_PROD.trim() : null, row.UNI_MED.trim()]);
	}

	for (const row of existencias.recordset) {
		await pool.query(`
			INSERT INTO mult (cve_art, cve_alm, status, ctrl_alm, exist)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (cve_art, cve_alm) DO UPDATE SET status = EXCLUDED.status, ctrl_alm = EXCLUDED.ctrl_alm, exist = EXCLUDED.exist
		`, [row.CVE_ART.trim(), row.CVE_ALM, row.STATUS.trim(), row.CTRL_ALM ? row.CTRL_ALM.trim() : null, row.EXIST]);
	}

	console.log(`Sincronizados ${articulos.recordset.length} articulos y ${existencias.recordset.length} registros de existencias.`);

	await aspelPool.close();
	await pool.end();
}

syncInventario()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error('Error al sincronizar con Aspel SAE:', error.message);
		process.exit(1);
	});
