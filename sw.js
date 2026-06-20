// Service Worker mínimo para a Festa do Arthur
// Por enquanto não faz cache offline, só evita o erro 404 no registro.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Passa direto pra rede, sem cache por enquanto.
  event.respondWith(fetch(event.request));
});
