const crypto = require('node:crypto');

// Códigos de un solo uso por tiempo (TOTP, RFC 6238): SHA-1, 6 dígitos, cambian cada 30 segundos.
// Es el formato estándar que usan Microsoft Authenticator, Google Authenticator y Authy.
const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'COMCESA Inventario';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Clave base32 inválida');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160 bits aleatorios, como recomienda el estándar.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function counterBuffer(step) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(step));
  return buffer;
}

function codeForStep(secretBase32, step) {
  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counterBuffer(step)).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function stepAt(timeMs) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

// Código vigente para un instante (se usa en las pruebas y para verificar).
function generateCode(secretBase32, timeMs = Date.now()) {
  return codeForStep(secretBase32, stepAt(timeMs));
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Verifica un código aceptando el periodo anterior y el siguiente (tolera ~30 s de diferencia de reloj).
 * Devuelve el número de periodo que coincidió, o null. `afterStep` evita reutilizar un código ya usado.
 */
function verifyCode(secretBase32, code, { timeMs = Date.now(), afterStep = null } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const current = stepAt(timeMs);
  let matched = null;
  for (const step of [current - 1, current, current + 1]) {
    if (afterStep !== null && afterStep !== undefined && step <= Number(afterStep)) continue;
    if (safeEqual(codeForStep(secretBase32, step), clean) && (matched === null || step > matched)) matched = step;
  }
  return matched;
}

function otpauthUrl(email, secretBase32) {
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// La clave se muestra en grupos de 4 para escribirla con facilidad: "ABCD EFGH ...".
function formatSecret(secretBase32) {
  return secretBase32.match(/.{1,4}/g).join(' ');
}

module.exports = { STEP_SECONDS, ISSUER, generateSecret, generateCode, verifyCode, stepAt, otpauthUrl, formatSecret, base32Encode, base32Decode };
