# COMCESA - Sistema de Consulta de Inventario y Precios

## Descripción

Aplicación web responsive de consulta de inventario y precios para la fuerza de ventas de la división automotriz de COMCESA. El frontend se sirve desde el backend y puede utilizarse desde computadora o celular.

## Arquitectura prevista

- Frontend responsive servido por Express.
- Backend en Node.js.
- PostgreSQL para la copia operativa de consulta.
- Redis para sesiones seguras y cache futuro.
- Integración pendiente con la información de Aspel SAE/SQL Server.

## Estructura del proyecto

```text
src/
  backend/
  frontend/
  mobile/
docs/
docker/
tests/
```

## Base de datos

La estructura contempla documentación y scripts relacionados con SQL Server y las tablas `INVE`, `MULT`, `PRECIOS01` y `PRECIO_X_PROD01`.

## Puesta en marcha local

1. Copiar `.env.example` como `.env` y reemplazar todos los valores `REEMPLAZAR_` por secretos locales largos y únicos.
2. Instalar dependencias:

  ```bash
  npm ci
  ```

3. Iniciar PostgreSQL, Redis y el backend desde la raíz del repositorio:

  ```bash
  docker compose -f docker/docker-compose.yml --env-file .env --profile app up -d --build
  ```

  Si la terminal está dentro de `docker/`, utilizar:

  ```bash
  docker compose --env-file ../.env --profile app up -d --build
  ```

4. Crear o actualizar el primer administrador usando una contraseña de al menos 12 caracteres:

  ```bash
  npm run admin:create -- administrador@empresa.com "Escribe-aqui-una-contrasena-segura"
  ```

5. Abrir `http://localhost:3000` desde la computadora o el celular conectado a la misma red.

Para detener los servicios:

```bash
docker compose -f docker/docker-compose.yml --env-file .env --profile app down
```

Para conservar los datos, no agregues `--volumes` al comando anterior.

`SEED_DEMO_DATA=true` permite cargar registros de demostración. Debe permanecer en `false` cuando se conecte la información real de Aspel SAE.

## Pruebas

Ejecutar la suite de integración con PostgreSQL y Redis activos:

```bash
npm run test:integration
```

La suite contiene 30 casos automatizados. El plan y la matriz de trazabilidad están en:

- `docs/pruebas/plan-pruebas.md`
- `docs/pruebas/matriz-trazabilidad.md`

La estrategia usa `node:test` porque el sistema está construido con Node.js. La consigna menciona `pytest + Selenium`; Selenium puede agregarse para evidencia de navegador, pero no reemplaza las pruebas de integración del backend ni es una dependencia necesaria para este stack.

## Seguridad

- La autenticación usa contraseñas con `bcrypt` y sesiones opacas almacenadas en Redis.
- El navegador recibe únicamente una cookie `HttpOnly`, `Secure` en producción y `SameSite=Strict`.
- El frontend no guarda tokens ni contraseñas en `localStorage`.
- Las consultas de inventario son parametrizadas, paginadas y limitadas por filtros validados.
- PostgreSQL y Redis no deben exponerse públicamente en producción.

El despliegue de la aplicación queda fuera del alcance de esta entrega. Actualmente solo se automatizan build y pruebas; no se configuran proveedores, webhooks ni ambientes staging.

## Equipo

- Saúl Osberto Escobar Fuentes
- Ximena Lissett Palencia Palacios
- Yessica Liseth García Almengor
- Erick Josué Garcia Solares
