function notFoundHandler(request, response) {
  response.status(404).json({
    error: 'NOT_FOUND',
    message: 'Recurso no encontrado'
  });
}

function errorHandler(error, request, response, next) {
  if (request.log) {
    request.log.error({ err: error }, 'request_failed');
  } else {
    console.error('request_failed', error.message);
  }

  if (response.headersSent) {
    return next(error);
  }

  const isPayloadTooLarge = error.type === 'entity.too.large';
  const statusCode = isPayloadTooLarge ? 413 : (error.status || error.statusCode || 500);

  response.status(statusCode).json({
    error: error.code || (statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_SERVER_ERROR'),
    message: statusCode < 500 ? error.message : 'Error interno del servidor'
  });
}

module.exports = { notFoundHandler, errorHandler };