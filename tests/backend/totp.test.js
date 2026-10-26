process.env.NODE_ENV ||= 'test';
process.env.SESSION_SECRET ||= 'test-session-secret-000000000000000000';
process.env.POSTGRES_HOST ||= 'localhost';
process.env.POSTGRES_PORT ||= '5432';
process.env.POSTGRES_DB ||= 'comcesa';
process.env.POSTGRES_USER ||= 'comcesa';
process.env.POSTGRES_PASSWORD ||= 'test-postgres-password-1234';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const totp = require('../../src/backend/services/totpService');
const { encryptSecret, decryptSecret } = require('../../src/backend/services/mfaCrypto');

// Vectores oficiales del estándar RFC 6238 (SHA-1, clave "12345678901234567890"), a 6 dígitos.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];

test('TOTP: coincide con los vectores oficiales del estándar RFC 6238', () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    assert.equal(totp.generateCode(RFC_SECRET, seconds * 1000), expected, `t=${seconds}`);
  }
});

test('TOTP: base32 de ida y vuelta, aceptando espacios y minúsculas', () => {
  const secret = totp.generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Encode(totp.base32Decode(secret)), secret);
  assert.equal(totp.base32Encode(totp.base32Decode(totp.formatSecret(secret).toLowerCase())), secret);
  assert.throws(() => totp.base32Decode('NO-ES-BASE32-1'));
});

test('TOTP: acepta el periodo anterior y el siguiente, pero no más lejos', () => {
  const now = 1700000000000;
  const step = totp.stepAt(now);
  const at = (offset) => totp.generateCode(RFC_SECRET, now + offset * 30000);
  assert.equal(totp.verifyCode(RFC_SECRET, at(0), { timeMs: now }), step);
  assert.equal(totp.verifyCode(RFC_SECRET, at(-1), { timeMs: now }), step - 1);
  assert.equal(totp.verifyCode(RFC_SECRET, at(1), { timeMs: now }), step + 1);
  assert.equal(totp.verifyCode(RFC_SECRET, at(2), { timeMs: now }), null);
  assert.equal(totp.verifyCode(RFC_SECRET, at(-2), { timeMs: now }), null);
});

test('TOTP: un código ya usado no se puede reutilizar', () => {
  const now = 1700000000000;
  const code = totp.generateCode(RFC_SECRET, now);
  const step = totp.verifyCode(RFC_SECRET, code, { timeMs: now });
  assert.ok(step);
  assert.equal(totp.verifyCode(RFC_SECRET, code, { timeMs: now, afterStep: step }), null);
});

test('TOTP: rechaza códigos con formato inválido', () => {
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5', null, undefined]) {
    assert.equal(totp.verifyCode(RFC_SECRET, bad), null);
  }
  const good = totp.generateCode(RFC_SECRET);
  assert.ok(totp.verifyCode(RFC_SECRET, `${good.slice(0, 3)} ${good.slice(3)}`));
});

test('TOTP: el enlace para la aplicación trae cuenta, emisor, 6 dígitos y 30 segundos', () => {
  const url = new URL(totp.otpauthUrl('rosa@comcesa.net', 'JBSWY3DPEHPK3PXP'));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.hostname, 'totp');
  assert.equal(decodeURIComponent(url.pathname), '/COMCESA Inventario:rosa@comcesa.net');
  assert.equal(url.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(url.searchParams.get('issuer'), 'COMCESA Inventario');
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
});

test('cifrado de secretos: ida y vuelta, no guarda el secreto en claro y detecta alteraciones', () => {
  delete process.env.MFA_ENCRYPTION_KEY;
  const secret = totp.generateSecret();
  const stored = encryptSecret(secret);
  assert.ok(stored.startsWith('k0:'));
  assert.ok(!stored.includes(secret));
  assert.notEqual(encryptSecret(secret), stored);
  assert.equal(decryptSecret(stored), secret);
  const parts = stored.split(':');
  parts[3] = Buffer.from(Buffer.from(parts[3], 'base64').map((byte, i) => (i === 0 ? byte ^ 1 : byte))).toString('base64');
  assert.throws(() => decryptSecret(parts.join(':')));
});

test('cifrado de secretos: con llave propia se usa k1 y los secretos anteriores (k0) siguen funcionando', () => {
  delete process.env.MFA_ENCRYPTION_KEY;
  const secret = totp.generateSecret();
  const oldStored = encryptSecret(secret);
  process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  try {
    const newStored = encryptSecret(secret);
    assert.ok(newStored.startsWith('k1:'));
    assert.equal(decryptSecret(newStored), secret);
    assert.equal(decryptSecret(oldStored), secret);
    delete process.env.MFA_ENCRYPTION_KEY;
    assert.throws(() => decryptSecret(newStored), /MFA_ENCRYPTION_KEY/);
    process.env.MFA_ENCRYPTION_KEY = 'corta';
    assert.throws(() => encryptSecret(secret), /32 bytes/);
  } finally {
    delete process.env.MFA_ENCRYPTION_KEY;
  }
});
