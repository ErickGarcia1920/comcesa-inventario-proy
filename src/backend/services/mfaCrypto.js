const crypto = require('node:crypto');
const env = require('../config/env');

// Los secretos del autenticador se guardan CIFRADOS (AES-256-GCM): quien vea la base de datos
// no puede generar códigos. Formato guardado: "<llave>:<iv>:<etiqueta>:<texto cifrado>".
//  - k1: llave propia en la variable MFA_ENCRYPTION_KEY (32 bytes en base64). Es la recomendada.
//  - k0: llave derivada de SESSION_SECRET. Sirve para que funcione sin configurar nada más, pero
//        no se debe cambiar SESSION_SECRET mientras haya secretos guardados con k0.
const KEYS = {
  k0: () => Buffer.from(crypto.hkdfSync('sha256', env.SESSION_SECRET, 'comcesa-mfa', 'totp-secret-encryption', 32)),
  k1: () => {
    const raw = process.env.MFA_ENCRYPTION_KEY;
    if (!raw) throw new Error('Falta MFA_ENCRYPTION_KEY para descifrar este secreto');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY debe ser de 32 bytes en base64');
    return key;
  }
};

function currentKeyId() {
  return process.env.MFA_ENCRYPTION_KEY ? 'k1' : 'k0';
}

function encryptSecret(plain) {
  const keyId = currentKeyId();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEYS[keyId](), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [keyId, iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(stored) {
  const [keyId, iv, tag, data] = String(stored).split(':');
  if (!KEYS[keyId] || !iv || !tag || !data) throw new Error('Secreto con formato inválido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEYS[keyId](), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret, currentKeyId };
