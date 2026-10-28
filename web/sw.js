// Orco's service worker does one thing: show notifications and bring the app forward when one is
// tapped. It caches nothing and handles no fetches, so the app is always what the server serves.
// There is no Web Push: that would route through a browser vendor's push service, and the Orco
// server makes no outbound calls.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { hash = '', target = null } = event.notification.data ?? {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: 'open', hash, target });
      } else {
        await self.clients.openWindow(`/${hash}`);
      }
    })(),
  );
});
