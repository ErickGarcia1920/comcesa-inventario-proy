# Despliegue en la nube y pipeline de CI/CD

## Arquitectura de datos (por que no conectamos SQL Server directo a la nube)

El SQL Server de Aspel SAE (`SERVER\SERVER`, base `SAE80Empre01`) vive en la
red local de COMCESA y no tiene una IP publica ni certificado TLS: exponerlo a
internet para que el backend en la nube lo consulte directamente seria un
riesgo de seguridad grave y probablemente ni sea posible desde la red de la
empresa. Por eso la arquitectura usa un patron de copia operativa:

`scripts/sync-aspel.js` es el unico componente que toca SQL Server, con el
usuario `Consulta` (solo lectura). Se ejecuta desde un equipo dentro de la red
de COMCESA (Programador de tareas de Windows o cron), no desde el pipeline en
la nube.

## CI (GitHub Actions)

`.github/workflows/ci.yml` corre en cada push/PR a `main`, `dev` y `qa`:

1. Levanta Postgres y Redis como servicios efimeros.
2. `npm ci`
3. `npm run test:integration`
4. Construye la imagen Docker (valida que el `Dockerfile` compile).
5. Si todo pasa y el push fue a `main`, dispara el deploy hook de Render.

El job de `deploy` no corre en Pull Requests, solo en push directo a `main`,
para que el pipeline pueda bloquear el merge si las pruebas fallan (ver
entregable E9).

## Despliegue (Render, capa gratuita)

1. Crear cuenta en [render.com](https://render.com) (no pide tarjeta).
2. "New" -> "Blueprint" -> conectar este repositorio. Render detecta
   `render.yaml` y crea automaticamente:
   - Web service (Docker, `docker/backend/Dockerfile`)
   - Base de datos PostgreSQL (free, 1&nbsp;GB, expira en 30 dias salvo que se
     actualice antes de esa fecha)
   - Instancia Redis/Key Value (free)
3. En el dashboard del web service, definir las variables marcadas como
   `sync: false` en `render.yaml`:
   - `CORS_ORIGIN`: la URL publica que Render asigna (ej.
     `https://comcesa-inventario.onrender.com`)
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD`: para crear el primer administrador
4. Copiar la URL del "Deploy Hook" del web service (Settings -> Deploy Hook) y
   guardarla como secreto de GitHub: `Settings -> Secrets and variables ->
   Actions -> New repository secret -> RENDER_DEPLOY_HOOK_URL`.
5. Hacer push a `main`: el pipeline corre pruebas y, si pasan, dispara el
   deploy en Render.
6. Una vez desplegado, correr una sola vez (Render Shell o localmente contra
   `DATABASE_URL` de produccion):
   
### Importante: vencimiento de la base de datos free de Render

La base Postgres free expira 30 dias despues de creada (con 14 dias de
gracia). Si se crea hoy (25 de septiembre), venceria alrededor del 25 de
octubre, antes de la entrega de la fase 2 (30 de octubre). Antes de esa fecha,
hay que actualizar la base a un plan pago o recrearla y volver a correr
`sync-aspel.js` para repoblarla. Dejarlo anotado en la bitacora del equipo
(entregable E8/E16) como una decision tecnica documentada.

## Variables de entorno en Render vs. variables locales

| Variable | Donde vive |
|---|---|
| `SESSION_SECRET`, `DATABASE_URL`, `REDIS_URL` | Render (generadas/inyectadas automaticamente) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CORS_ORIGIN` | Render (definidas manualmente en el dashboard) |
| `ASPEL_SQLSERVER_*` | Solo en el `.env` del equipo dentro de la red de COMCESA. Nunca en Render, nunca en GitHub Actions, nunca en el repositorio. |
| `RENDER_DEPLOY_HOOK_URL` | GitHub Actions Secrets |
