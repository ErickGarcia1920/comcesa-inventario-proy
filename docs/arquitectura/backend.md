# Arquitectura del backend

## Objetivo

El backend es la unica capa que debe comunicarse con la base de datos y con Redis. La aplicacion web movil consume una API HTTP versionada y nunca recibe credenciales ni se conecta directamente a PostgreSQL.

## Capas

```text
Cliente web responsive
        |
        v
API HTTP /api/v1
        |
        +-- Autenticacion y autorizacion
        +-- Validacion de entrada y limites de peticion
        +-- Servicios de inventario y precios
        |
        +-- PostgreSQL: datos operativos
        +-- Redis: cache, sesiones o rate limiting distribuido
        +-- Adaptador de sincronizacion: Aspel SAE
```

## Modelo de datos

- `INVE` representa el catalogo de articulos.
- `MULT` representa la existencia por articulo y almacen. Su clave compuesta debe ser `(CVE_ART, CVE_ALM)`.
- `PRECIOS01` representa las listas de precios.
- `PRECIO_X_PROD01` resuelve la relacion muchos a muchos entre articulos y listas. Su clave compuesta debe ser `(CVE_ART, CVE_PRECIO)`.

Las consultas de inventario deben permitir filtrar por articulo y almacen. Las consultas de precios deben unir `INVE`, `PRECIO_X_PROD01` y `PRECIOS01`, aplicando `STATUS` y paginacion.

## Seguridad

- HTTPS debe terminar en un proxy o balanceador en produccion.
- Las credenciales se leen desde variables de entorno y nunca desde el cliente.
- Las entradas se validan antes de llegar a los servicios.
- Las consultas deben usar parametros, nunca concatenacion de texto.
- La autenticacion y los permisos deben implementarse antes de exponer datos reales.
- El rate limiting local debe migrarse a Redis cuando haya mas de una instancia del backend.
- Los logs no deben incluir contrasenas, tokens ni datos sensibles.

## Escalabilidad

- El backend debe ser stateless para permitir varias replicas.
- PostgreSQL usa un pool de conexiones con limites definidos.
- Redis puede cachear consultas frecuentes de catalogo y precios con expiracion.
- La sincronizacion con Aspel SAE debe ejecutarse como proceso separado o tarea programada, no dentro de cada solicitud HTTP.
- El endpoint `/api/v1/ready` permite que Docker, Kubernetes o un balanceador retire instancias que no tengan sus dependencias disponibles.

## Estado actual y siguiente limite tecnico

La infraestructura actual usa PostgreSQL y Redis. Las tablas proporcionadas tienen nombres y tipos asociados a Aspel SAE/SQL Server, por lo que antes de crear migraciones se debe decidir una de estas opciones:

1. Migrar una copia normalizada de Aspel SAE a PostgreSQL y consultar esa copia desde la API.
2. Mantener SQL Server como fuente y crear un adaptador de lectura/sincronizacion hacia PostgreSQL.

No se debe conectar el backend productivo directamente a la base operativa de Aspel sin definir permisos de solo lectura, estrategia de sincronizacion y manejo de cambios.