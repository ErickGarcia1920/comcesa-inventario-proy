const assert = require('node:assert/strict');
const http = require('node:http');
const { Writable } = require('node:stream');
const { test } = require('node:test');
const pinoHttp = require('pino-http');
const { loggerOptions } = require('../../src/backend/config/logging');

test('el registro de peticiones no guarda cookies de sesión ni credenciales', async () => {
  let output = '';
  const stream = new Writable({ write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
  const logger = pinoHttp(loggerOptions, stream);

  const server = http.createServer((request, response) => {
    logger(request, response);
    response.setHeader('Set-Cookie', 'comcesa_session=TOKEN_SECRETO_RESPUESTA; HttpOnly');
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  await new Promise((resolve, reject) => {
    const request = http.request({
      port, host: '127.0.0.1', path: '/prueba',
      headers: { cookie: 'comcesa_session=TOKEN_SECRETO_PETICION', authorization: 'Bearer CLAVE_SECRETA' }
    }, (response) => { response.resume(); response.on('end', resolve); });
    request.on('error', reject);
    request.end();
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  server.close();

  assert.ok(output.includes('/prueba'), 'la petición sí debe quedar registrada');
  assert.ok(!output.includes('TOKEN_SECRETO_PETICION'), 'la cookie de la petición no debe aparecer');
  assert.ok(!output.includes('TOKEN_SECRETO_RESPUESTA'), 'la cookie de la respuesta no debe aparecer');
  assert.ok(!output.includes('CLAVE_SECRETA'), 'el encabezado authorization no debe aparecer');
  assert.ok(output.includes('[oculto]'));
});
