// Opciones del registro de peticiones (pino-http).
// Importante: nunca se deben escribir en los registros las cookies de sesión ni credenciales.
const loggerOptions = {
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    censor: '[oculto]'
  }
};

module.exports = { loggerOptions };
