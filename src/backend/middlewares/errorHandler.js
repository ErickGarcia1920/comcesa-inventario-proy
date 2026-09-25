function notFoundHandler(request, response) {
  response.status(404).json({
    error: 'NOT_FOUND',
    message: 'Recurso no encontrado'
  });
}

function errorHandler(error, request, response, next) {
  request.log.error({ err: error }, 'request_failed');

  if (response.headersSent) {
    return next(error);
  }

  response.status(error.statusCode || 500).json({
    error: error.code || 'INTERNAL_SERVER_ERROR',
    message: error.statusCode ? error.message : 'Error interno del servidor'
  });
}

module.exports = { notFoundHandler, errorHandler };