function originGuard(request, response, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    return next();
  }

  const origin = request.get('origin');
  const host = `${request.protocol}://${request.get('host')}`;

  if (origin && origin !== host) {
    return response.status(403).json({
      error: 'ORIGIN_NOT_ALLOWED',
      message: 'Origen no permitido'
    });
  }

  next();
}

module.exports = originGuard;