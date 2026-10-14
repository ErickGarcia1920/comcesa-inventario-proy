// Service worker mínimo: solo permite instalar la app en el celular.
// No guarda nada en caché: los datos siempre se piden al servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
