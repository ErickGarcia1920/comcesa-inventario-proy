const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');

const newPasswordSchema = z.string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres')
  .max(200)
  .regex(/[A-Za-z]/, 'La contraseña debe incluir al menos una letra')
  .regex(/\d/, 'La contraseña debe incluir al menos un número');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generateTempPassword() {
  while (true) {
    let value = '';
    for (let i = 0; i < 12; i += 1) value += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (newPasswordSchema.safeParse(value).success) return value;
  }
}

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

module.exports = { newPasswordSchema, generateTempPassword, hashPassword };
