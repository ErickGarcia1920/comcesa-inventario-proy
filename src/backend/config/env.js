const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config();

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(32),
  ADMIN_EMAIL: z.preprocess((value) => value === '' ? undefined : value, z.string().email().optional()),
  ADMIN_PASSWORD: z.preprocess((value) => value === '' ? undefined : value, z.string().min(12).optional()),
  SEED_DEMO_DATA: z.preprocess((value) => value === 'true' || value === true, z.boolean()).default(false),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  POSTGRES_DB: z.string().default('comcesa'),
  POSTGRES_USER: z.string().default('comcesa'),
  POSTGRES_PASSWORD: z.string().min(16).optional(),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().max(65535).default(5432)
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  console.error('Configuracion de entorno invalida', parsedEnvironment.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = parsedEnvironment.data;
