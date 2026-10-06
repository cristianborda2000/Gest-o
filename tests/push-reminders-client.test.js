'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function client() {
  const fixture = { account: 'one', enabled: true, messages: [], requests: [], permissionRequests: 0, registrations: 0, unsubscribes: 0, deleteGate: null, deleteStarted: deferred(), unsubscribeGate: null, closed: 0 };
  const makeSubscription = account => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${account}`, async unsubscribe() {
    fixture.unsubscribes++; await fixture.unsubscribeGate?.promise;
    if (fixture.unsubscribeError) throw fixture.unsubscribeError;
    if (fixture.subscription === this) fixture.subscription = null;
    return true;
  }, toJSON() { return { endpoint: this.endpoint }; } });
  fixture.makeSubscription = makeSubscription; fixture.subscription = makeSubscription('one');
  const registration = {
    active: { postMessage(message, ports) { fixture.messages.push(message.userId); ports[0].postMessage({ saved: true }); } },
    pushManager: { getSubscription: async () => fixture.subscription, subscribe: async () => (fixture.subscription = makeSubscription(fixture.account)) },
    getNotifications: async () => [{ close() { fixture.closed++; } }]
  };
  const controls = Object.fromEntries(['status', 'enable', 'disable', 'badge'].map(name => [`[data-push-${name}]`, {}]));
  const region = { isConnected: true, dataset: {}, querySelector: selector => controls[selector] };
  class MessageChannel {
    constructor() { this.port1 = { onmessage: null, close() {} }; this.port2 = { postMessage: value => this.port1.onmessage?.({ data: value }) }; }
  }
  const global = {
    URL, TextEncoder, Uint8Array, AbortController, MessageChannel, setTimeout, clearTimeout, atob,
    isSecureContext: true, crypto: webcrypto, location: { href: 'https://www.zam4.com/' }, document: { querySelectorAll: () => [], createElement: () => region },
    navigator: { serviceWorker: { getRegistration: async () => registration, register: async () => { fixture.registrations++; return registration; } } },
    Notification: { permission: 'granted', requestPermission: async () => { fixture.permissionRequests++; await fixture.permissionGate?.promise; return 'granted'; } }, PushManager: {},
    fetch: async (url, options) => {
      fixture.requests.push({ url, options });
      if (options.method === 'DELETE') { fixture.deleteStarted.resolve(); await fixture.deleteGate?.promise; }
      return { ok: true, json: async () => url.endsWith('path=config') ? { enabled: fixture.enabled, publicKey: 'public', keyId: 'key', reason: 'Aguardando configuração.' } : { enabled: fixture.enabled, registered: true } };
    },
    supabaseClient: { auth: { getSession: async () => ({ data: { session: fixture.account ? { user: { id: fixture.account }, access_token: `token-${fixture.account}` } : null } }) } }
  };
  global.window = global;
  vm.runInNewContext(readFileSync('app/assets/js/push-reminders.js', 'utf8'), global);
  fixture.api = global.ZamaPushReminders;
  fixture.api.mount({ querySelector: () => null, appendChild() {} });
  fixture.activate = () => controls['[data-push-enable]'].onclick();
  fixture.controls = controls;
  return fixture;
}
test('initialization never requests notification permission or registers a new service worker', async () => {
  const c = client(); await c.api.init();
  assert.equal(c.permissionRequests, 0); assert.equal(c.registrations, 0); assert.equal(c.messages.at(-1), 'one');
  await c.api.reset();
});
test('reinitialization and opening while disabled preserve an existing browser subscription', async () => {
  const c = client(), original = c.subscription;
  await c.api.init(); await c.api.init();
  assert.equal(c.unsubscribes, 0); assert.equal(c.subscription, original); assert.equal(c.messages.at(-1), 'one');
  c.enabled = false; await c.api.init();
  assert.equal(c.unsubscribes, 0); assert.equal(c.subscription, original); assert.equal(c.messages.at(-1), '');
  assert.equal(c.permissionRequests, 0); assert.equal(c.registrations, 0);
  assert.equal(c.requests.some(row => row.options.method === 'POST' || row.options.method === 'DELETE'), false);
  await c.api.reset();
});
test('reset invalidates the worker synchronously and new account initialization waits for old unsubscribe', async () => {
  const c = client(); await c.api.init(); c.unsubscribeGate = deferred();
  const oldCleanup = c.api.reset();
  assert.equal(c.messages.at(-1), '', 'worker invalidation is posted before reset returns');
  c.account = 'two';
  let initialized = false;
  const newInit = c.api.init().then(() => { initialized = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(initialized, false, 'new account waits for local cleanup');
  assert.equal(c.messages.includes('two'), false);
  c.unsubscribeGate.resolve(); await oldCleanup; await newInit;
  assert.equal(c.messages.at(-1), ''); assert.equal(c.unsubscribes, 1);
  c.subscription = c.makeSubscription('two'); await c.api.init();
  assert.equal(c.messages.at(-1), 'two', 'new account can become active after cleanup');
  assert.equal(c.messages.slice(1).includes('one'), false, 'old account never reactivates');
  await c.api.reset();
});
test('explicit disconnect revokes using the captured old token and cannot clear a later account', async () => {
  const c = client(); await c.api.init(); c.deleteGate = deferred();
  const disconnect = c.api.disconnect(); c.account = 'two';
  await c.deleteStarted.promise;
  const deletion = c.requests.find(row => row.options.method === 'DELETE');
  assert.ok(deletion); assert.equal(deletion.options.headers.Authorization, 'Bearer token-one');
  c.subscription = c.makeSubscription('two');
  let done = false; const init = c.api.init().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  c.deleteGate.resolve(); await disconnect; await init;
  assert.equal(c.messages.at(-1), 'two'); assert.equal(c.unsubscribes, 1);
  await c.api.reset();
});
test('reinitializing during permission prompt cancels stale activation and leaves controls usable', async () => {
  const c = client(); c.subscription = null; await c.api.init(); c.permissionGate = deferred();
  const activation = c.activate();
  const reinitialization = c.api.init();
  c.permissionGate.resolve(); await activation; await reinitialization;
  assert.equal(c.controls['[data-push-enable]'].disabled, false);
  assert.equal(c.registrations, 0, 'cancelled permission response must not register a worker');
  await c.activate();
  assert.equal(c.requests.filter(row => row.options.method === 'POST').length, 1);
  assert.equal(c.messages.at(-1), 'one');
  await c.api.reset();
});
test('disconnect still revokes the server subscription and closes notifications when browser unsubscribe fails', async () => {
  const c = client(); await c.api.init(); c.unsubscribeError = new Error('browser offline');
  await c.api.disconnect();
  assert.equal(c.messages.at(-1), '');
  assert.equal(c.requests.filter(row => row.options.method === 'DELETE').length, 1);
  assert.equal(c.closed, 1);
});
