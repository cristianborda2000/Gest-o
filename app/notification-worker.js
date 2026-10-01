// Display fallback for mobile browsers that require a service worker.
// Scheduling stays in the open app; this worker does not send push messages.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const day = event.notification.data?.day || '';
  const target = new URL('./', self.registration.scope);
  target.searchParams.set('view', 'agenda');
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) target.searchParams.set('day', day);
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(windows => {
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      existing.postMessage({type:'zama-open-agenda',day});
      return existing.focus();
    }
    return clients.openWindow(target.href);
  }));
});
