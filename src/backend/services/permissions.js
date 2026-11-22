const { isMasterEmail } = require('../config/masters');

// Un usuario master es un administrador cuyo correo está en la lista de masters.
function isMasterUser(user) {
  return Boolean(user) && user.role === 'admin' && isMasterEmail(user.email);
}

/**
 * Qué puede hacer `actor` sobre `target`. Reglas:
 *  - Nadie actúa sobre sí mismo aquí (para eso están "cambiar contraseña" y la pantalla de acceso).
 *  - Un master no se puede eliminar, desactivar ni cambiar de rol (otro master sí puede restablecer su contraseña o desbloquearlo).
 *  - Un administrador solo gestiona consultores.
 *  - Un master gestiona consultores y administradores, y es el único que puede crear/quitar administradores.
 */
function permissionsFor(actor, target) {
  const none = { delete: false, toggleActive: false, changeRole: false, resetPassword: false, unlock: false };
  if (!actor || !target || actor.id === target.id) return none;
  const actorIsMaster = isMasterUser(actor);
  if (!actorIsMaster && actor.role !== 'admin') return none;

  if (isMasterUser(target)) {
    return actorIsMaster ? { ...none, resetPassword: true, unlock: true } : none;
  }
  if (target.role === 'admin') {
    return actorIsMaster ? { delete: true, toggleActive: true, changeRole: true, resetPassword: true, unlock: true } : none;
  }
  // Consultor
  return { delete: true, toggleActive: true, changeRole: actorIsMaster, resetPassword: true, unlock: true };
}

module.exports = { isMasterUser, permissionsFor };
