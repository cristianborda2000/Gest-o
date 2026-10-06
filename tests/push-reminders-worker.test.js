'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
function worker() {
  const handlers = {}, stored = new Map(), notifications = [], windows = [];
  const context = {
    URL, Response, Date, caches: { open: async () => ({ match: async key => stored.has(key) ? new Response(stored.get(key)) : null, put: async (key, response) => stored.set(key, await response.text()) }) },
    clients: { matchAll: async () => [], openWindow: async url => windows.push(url) },
    self: { location: { origin: 'https://www.zam4.com' }, clients: { claim: async () => {} }, skipWaiting: async () => {},
      registration: { scope: 'https://www.zam4.com/', getNotifications: async () => [], showNotification: async (title, options) => notifications.push({ title, options }) },
      addEventListener(type, callback) { handlers[type] = callback; }
    }
  };
  vm.runInNewContext(readFileSync('app/notification-worker.js', 'utf8'), context);
  return { notifications, windows, async emit(type, event) { let promise; handlers[type]({ ...event, waitUntil(value) { promise = value; } }); await promise; } };
}
const account = userId => ({ data: { type: 'zama-push-account', userId }, source: { url: 'https://www.zam4.com/' } });
const push = (userId, extra = {}) => ({ data: { json: () => ({ type: 'zama-reminder', userId, key: 'task:1', title: 'Reunião', body: '12:00', day: '2026-10-05', expiresAt: Date.now() + 120000, ...extra }) } });
test('worker displays valid encrypted-push payload only for its active account', async () => {
  const w = worker();
  await w.emit('push', push('one')); assert.equal(w.notifications.length, 0, 'no account before consent');
  await w.emit('message', account('one'));
  await w.emit('push', push('two')); assert.equal(w.notifications.length, 0, 'wrong account');
  await w.emit('push', push('one', { expiresAt: Date.now() - 1 })); assert.equal(w.notifications.length, 0, 'expired');
  await w.emit('push', { data: { json() { throw new Error('bad json'); } } });
  await w.emit('push', push('one')); assert.equal(w.notifications.length, 1);
  assert.equal(w.notifications[0].options.tag, 'task:1'); assert.equal(w.notifications[0].options.data.userId, 'one');
  await w.emit('message', account('')); await w.emit('push', push('one')); assert.equal(w.notifications.length, 1, 'logout rejects later pushes');
});
test('worker ignores foreign-origin account mutations and serializes logout after login', async () => {
  const w = worker();
  await w.emit('message', { ...account('one'), source: { url: 'https://attacker.test/' } });
  await w.emit('push', push('one')); assert.equal(w.notifications.length, 0);
  await Promise.all([w.emit('message', account('one')), w.emit('message', account(''))]);
  await w.emit('push', push('one')); assert.equal(w.notifications.length, 0);
});
test('clicking stale notifications after logout cannot open another account agenda', async () => {
  const w = worker(); let closed = 0;
  await w.emit('message', account('one'));
  await w.emit('message', account(''));
  await w.emit('notificationclick', { notification: { close() { closed++; }, data: { userId: 'one', day: '2026-10-05' } } });
  assert.equal(closed, 1); assert.equal(w.windows.length, 0);
  await w.emit('message', account('one'));
  await w.emit('notificationclick', { notification: { close() {}, data: { userId: 'one', day: '2026-10-05' } } });
  const url = new URL(w.windows[0]); assert.equal(url.origin, 'https://www.zam4.com'); assert.equal(url.searchParams.get('view'), 'agenda'); assert.equal(url.searchParams.get('day'), '2026-10-05');
});
