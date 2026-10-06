// Persistent display for both foreground reminders and authenticated Web Push.
// No access/refresh tokens or private VAPID key are stored in this worker.
const sessionCache = 'zama-push-session-v1';
const sessionUrl = new URL('__push_account__', self.registration.scope).href;
let workerQueue = Promise.resolve();
function enqueue(operation) {
  workerQueue = workerQueue.catch(() => {}).then(operation);
  return workerQueue;
}
async function currentAccount() {
  const response = await (await caches.open(sessionCache)).match(sessionUrl);
  return response ? response.text() : '';
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'zama-push-account') return;
  // Only a same-origin page can establish the active account marker.
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  // Serialize account updates so a delayed login write cannot overtake logout.
  event.waitUntil(enqueue(async () => {
    const userId = /^[a-zA-Z0-9-]{1,100}$/.test(event.data.userId || '') ? event.data.userId : '';
    await (await caches.open(sessionCache)).put(sessionUrl, new Response(userId));
    if (!userId) (await self.registration.getNotifications()).forEach(notification => notification.close());
    event.ports?.[0]?.postMessage({ saved: true });
  }));
});
self.addEventListener('push', event => {
  event.waitUntil(enqueue(async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    if (payload?.type !== 'zama-reminder' || !payload.userId || payload.userId !== await currentAccount()) return;
    if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now() || typeof payload.key !== 'string') return;
    await self.registration.showNotification(String(payload.title || 'Lembrete da agenda').slice(0, 120), {
      body: String(payload.body || '').slice(0, 450), tag: payload.key.slice(0, 1000),
      icon: new URL('zama-logo.png', self.registration.scope).href,
      data: { day: /^\d{4}-\d{2}-\d{2}$/.test(payload.day || '') ? payload.day : '', userId: payload.userId }
    });
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const day = event.notification.data?.day || '';
  const target = new URL('./', self.registration.scope);
  target.searchParams.set('view', 'agenda');
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) target.searchParams.set('day', day);
  event.waitUntil(enqueue(async () => {
    if (event.notification.data?.userId && event.notification.data.userId !== await currentAccount()) return;
    const windows = await clients.matchAll({type:'window',includeUncontrolled:true});
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      existing.postMessage({type:'zama-open-agenda',day});
      return existing.focus();
    }
    return clients.openWindow(target.href);
  }));
});
