// Guarda la app en el teléfono para que funcione sin internet.
// Al cambiar cualquier archivo de vendor/, sube el número de versión.
const VERSION = 'mi-luz-v4';
const SHARED = 'mi-luz-compartido';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'informe.js', 'historial.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'vendor/tesseract.min.js', 'vendor/worker.min.js',
  'vendor/core/tesseract-core-lstm.wasm.js', 'vendor/core/tesseract-core-simd-lstm.wasm.js',
  'vendor/lang/eng.traineddata.gz',
  'vendor/jspdf.umd.min.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARED).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // Factura compartida desde otra app (correo, WhatsApp, archivos): se guarda y se abre la app.
  if (e.request.method === 'POST' && url.pathname.endsWith('/compartir')) {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const cache = await caches.open(SHARED);
      const file = fd.get('archivo');
      const text = [fd.get('titulo'), fd.get('texto'), fd.get('enlace')].filter(Boolean).join('\n');
      if (file && file.size) {
        await cache.put('archivo', new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-nombre': encodeURIComponent(file.name || 'factura') } }));
      } else if (text) {
        await cache.put('texto', new Response(text));
      }
      return Response.redirect(new URL('./?compartido=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;

  const save = (res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  };
  // Archivos pesados (vendor/): primero lo guardado. Resto: primero internet y, sin internet, lo guardado.
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(save)));
  } else {
    e.respondWith(fetch(e.request).then(save).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
