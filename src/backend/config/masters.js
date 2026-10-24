// Usuarios MASTER: son administradores que además pueden crear, eliminar y cambiar
// a otros administradores. Nadie puede eliminarlos ni quitarles el rol desde el sistema.
// Para agregar el tercero, súmalo a esta lista (o usa la variable MASTER_EMAILS en Render,
// con TODOS los correos separados por coma).
const DEFAULT_MASTERS = ['csr@comcesa.net', 'ricardo@comcesa.net'];

function parseEmails(value) {
  if (!value || !String(value).trim()) return null;
  const list = String(value).split(',').map((item) => item.trim().toLowerCase()).filter((item) => /^[^\s@]+@[^\s@]+$/.test(item));
  return list.length ? [...new Set(list)] : null;
}

const MASTER_EMAILS = parseEmails(process.env.MASTER_EMAILS) || DEFAULT_MASTERS;

function isMasterEmail(email) {
  return MASTER_EMAILS.includes(String(email || '').trim().toLowerCase());
}

module.exports = { MASTER_EMAILS, DEFAULT_MASTERS, isMasterEmail };
