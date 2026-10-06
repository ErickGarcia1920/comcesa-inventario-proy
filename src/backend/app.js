const cors = require('cors');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('node:path');
const pinoHttp = require('pino-http');
const env = require('./config/env');
const { ensureDatabaseSchema } = require('./config/schema');
const authRoutes = require('./routes/authRoutes');
const healthRoutes = require('./routes/healthRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const userRoutes = require('./routes/userRoutes');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');
const originGuard = require('./middlewares/originGuard');

const app = express();
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use(helmet({
	contentSecurityPolicy: {
		directives: {
			...helmet.contentSecurityPolicy.getDefaultDirectives(),
			'img-src': ["'self'", 'data:', 'https://comcesa.net']
		}
	}
}));
app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()) }));
app.use(express.json({ limit: '100kb' }));
app.use(pinoHttp());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));
app.use(originGuard);

app.use('/api/v1', healthRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/users', userRoutes);
app.get(['/', '/login'], (request, response) => {
	response.sendFile(path.join(__dirname, '../frontend/login.html'));
});
app.get('/inventario', (request, response) => {
	response.sendFile(path.join(__dirname, '../frontend/inventory.html'));
});
const pages = { '/cambiar-password': 'change-password.html', '/recuperar': 'recover.html', '/usuarios': 'users.html' };
Object.entries(pages).forEach(([route, file]) => {
	app.get(route, (request, response) => response.sendFile(path.join(__dirname, '../frontend', file)));
});
app.use(express.static(path.join(__dirname, '../frontend')));
app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
	ensureDatabaseSchema()
		.then(() => app.listen(env.PORT, () => {
			console.log(`Backend escuchando en el puerto ${env.PORT}`);
		}))
		.catch((error) => {
			console.error('No fue posible inicializar la base de datos', error.message);
			process.exit(1);
		});
}

module.exports = app;
