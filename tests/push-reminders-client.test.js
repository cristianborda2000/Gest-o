'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function client() {
  const fixture = { account: 'one', enabled: true, serverRegistered: true, permission: 'granted', configOrigin: 'https://www.zam4.com', messages: [], requests: [], permissionRequests: 0, registrations: 0, unsubscribes: 0, deleteGate: null, deleteStarted: deferred(), unsubscribeGate: null, closed: 0 };
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
  const controls = Object.fromEntries(['status', 'enable', 'disable', 'badge', 'preferences'].map(name => [`[data-push-${name}]`, {}]));
  const region = { isConnected: true, dataset: {}, querySelector: selector => controls[selector] };
  class MessageChannel {
    constructor() { this.port1 = { onmessage: null, close() {} }; this.port2 = { postMessage: value => this.port1.onmessage?.({ data: value }) }; }
  }
  const global = {
    URL, TextEncoder, Uint8Array, AbortController, MessageChannel, setTimeout, clearTimeout, atob,
    isSecureContext: true, crypto: webcrypto, location: { href: 'https://www.zam4.com/' }, document: { querySelectorAll: () => [], createElement: () => region },
    navigator: { serviceWorker: { getRegistration: async () => registration, register: async () => { fixture.registrations++; return registration; } } },
    state: { agendaSettings: { enabled: true, taskEnabled: true } },
    Notification: { get permission() { return fixture.permission; }, requestPermission: async () => { fixture.permissionRequests++; await fixture.permissionGate?.promise; return fixture.permission; } }, PushManager: {},
    fetch: async (url, options) => {
      fixture.requests.push({ url, options });
      if (options.method === 'DELETE') { fixture.deleteStarted.resolve(); await fixture.deleteGate?.promise; }
      if (fixture.fetchError) throw fixture.fetchError;
      return { ok: true, url: url.endsWith('path=config') ? `${fixture.configOrigin}/api/reminders?path=config` : url, json: async () => url.endsWith('path=config') ? { enabled: fixture.enabled, publicKey: 'public', keyId: 'key', appOrigin: fixture.configOrigin, reason: 'Aguardando configuração.' } : { enabled: fixture.enabled, registered: fixture.serverRegistered } };
    },
    supabaseClient: { auth: { getSession: async () => ({ data: { session: fixture.account ? { user: { id: fixture.account }, access_token: `token-${fixture.account}` } : null } }) } }
  };
  global.window = global;
  vm.runInNewContext(readFileSync('app/assets/js/push-reminders.js', 'utf8'), global);
  fixture.api = global.ZamaPushReminders;
  fixture.api.mount({ querySelector: () => null, appendChild() {} });
  fixture.activate = () => controls['[data-push-enable]'].onclick();
  fixture.controls = controls;
  fixture.global = global;
  return fixture;
}
test('initialization never requests notification permission or registers a new service worker', async () => {
  const c = client(); await c.api.init();
  assert.equal(c.permissionRequests, 0); assert.equal(c.registrations, 0); assert.equal(c.messages.at(-1), 'one');
  await c.api.reset();
});

test('apex clients resolve the public canonical URL before sending authenticated requests', async () => {
  const c = client(); c.global.location.href = 'https://zam4.com/';
  await c.api.init();
  const configRequest = c.requests[0], authenticated = c.requests.filter(row => row.options.headers.Authorization);
  assert.equal(configRequest.options.headers.Authorization, undefined);
  assert.equal(configRequest.options.redirect, 'follow');
  assert.ok(authenticated.length);
  for (const request of authenticated) {
    assert.ok(request.url.startsWith('https://www.zam4.com/api/reminders?'));
    assert.equal(request.options.redirect, 'error');
  }
  await c.api.reset();
});

test('untrusted configuration redirects never receive the session token', async () => {
  const c = client(); c.configOrigin = 'https://www.zam4.com.attacker.test';
  await c.api.init();
  assert.equal(c.requests.filter(row => row.options.headers.Authorization).length, 0);
  assert.notEqual(c.controls['[data-push-badge]'].textContent, 'Ativado');
  assert.equal(c.controls['[data-push-enable]'].disabled, true);
  await c.api.reset();
});

test('an authorized subscription with agenda preferences off is shown as paused', async () => {
  const c = client(); c.global.state.agendaSettings.enabled = false;
  await c.api.init();
  assert.equal(c.controls['[data-push-badge]'].textContent, 'Agenda pausada');
  assert.equal(c.controls['[data-push-preferences]'].hidden, false);
  assert.match(c.controls['[data-push-status]'].textContent, /dispositivo está autorizado/);
  c.global.state.agendaSettings.enabled = true; c.api.refresh();
  assert.equal(c.controls['[data-push-badge]'].textContent, 'Ativado');
  await c.api.reset();
});

test('installing the app or granting permission alone does not activate a device', async () => {
  const c = client(); c.subscription = null;
  await c.api.init();
  assert.equal(c.controls['[data-push-badge]'].textContent, 'Dispositivo não ativado');
  assert.equal(c.permissionRequests, 0);
  c.permission = 'denied'; await c.activate();
  assert.equal(c.requests.some(row => row.options.method === 'POST'), false);
  assert.notEqual(c.controls['[data-push-badge]'].textContent, 'Ativado');
  c.permission = 'granted'; c.serverRegistered = false;
  await c.activate();
  assert.notEqual(c.controls['[data-push-badge]'].textContent, 'Ativado');
  assert.match(c.controls['[data-push-status]'].textContent, /não confirmou/);
  c.serverRegistered = true; await c.activate();
  assert.equal(c.controls['[data-push-badge]'].textContent, 'Ativado');
  await c.api.reset();
});

test('disabled server and revoked permission are not reported as device activation', async () => {
  const c = client(); c.enabled = false;
  await c.api.init();
  assert.equal(c.controls['[data-push-badge]'].textContent, 'Servidor indisponível');
  c.enabled = true; c.permission = 'denied'; await c.api.init();
  assert.equal(c.controls['[data-push-badge]'].textContent, 'Permissão bloqueada');
  assert.equal(c.messages.at(-1), '');
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
