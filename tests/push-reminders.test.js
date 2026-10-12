'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createECDH, randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { configuration, publicConfiguration, fingerprint, allowedOrigins } = require('../services/reminders/config');
const { validateSubscription, validateEndpoint } = require('../services/reminders/validation');
const { createHandler: createHttp } = require('../services/reminders/http');
const { createHandler: createCron, dispatch } = require('../services/reminders/dispatcher');
const { createRepository } = require('../services/reminders/repository');
const { publicAddress } = require('../services/reminders/sender');
const { helpers } = require('../app/assets/js/ceo-agenda');
const key = createECDH('prime256v1'); key.generateKeys();
const config = configuration({ PUSH_REMINDERS_ENABLED: 'true', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-secret', APP_ORIGIN: 'https://www.zam4.com', VAPID_PUBLIC_KEY: key.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: key.getPrivateKey().toString('base64url'), VAPID_SUBJECT: 'mailto:admin@example.com', CRON_SECRET: 'c'.repeat(32) });
const sub = suffix => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix || 'test'}`, expirationTime: null, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
const now = Date.parse('2026-10-05T12:00:20-03:00');
const state = () => ({ agenda: [{ id: 'meeting', nome: 'Reunião', prazo: '2026-10-05', hora: '12:15', status: 'Pendente' }], agendaSettings: { enabled: true, dailyEnabled: false, taskEnabled: true, leadMinutes: 15 }, financeiro: [{ id: 'keep', valor: 900 }], legacy: { keep: true } });
async function request(handler, { method = 'GET', path = 'subscription', headers = {}, body } = {}) {
  const req = { method, url: `/api/reminders?path=${path}`, headers, body };
  let response;
  const responseHeaders = {};
  await handler(req, { setHeader(name, value) { responseHeaders[name] = value; }, set statusCode(value) { this.status = value; }, end(value) { response = { status: this.status, body: value ? JSON.parse(value) : null, headers: responseHeaders }; } });
  return response;
}
const authHeaders = { authorization: 'Bearer valid-token', 'content-type': 'application/json', origin: config.origin };
test('opt-in configuration checks key pair and keeps all secrets out of public JSON', () => {
  assert.equal(configuration({}).enabled, false);
  assert.equal(config.enabled, true);
  assert.equal(configuration({ PUSH_REMINDERS_ENABLED: 'true' }).enabled, false);
  const publicJson = JSON.stringify(publicConfiguration(config));
  assert.ok(!publicJson.includes(config.privateKey)); assert.ok(!publicJson.includes('server-secret')); assert.ok(!publicJson.includes(config.cronSecret));
});

test('CORS permits only the configured origin and the verified ZAMA apex/www pair', async () => {
  const api = createHttp({ config, authenticate: async () => ({ data: { user: { id: 'owner' } } }), repository: { status: async () => ({ registered: false }) } });
  for (const origin of ['https://zam4.com', 'https://www.zam4.com']) {
    const preflight = await request(api, { method: 'OPTIONS', headers: { origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['Access-Control-Allow-Origin'], origin);
    assert.equal(preflight.headers['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
    const status = await request(api, { headers: { ...authHeaders, origin } });
    assert.equal(status.status, 200);
    assert.equal(status.headers['Vary'], 'Origin');
    assert.equal((await request(api, { headers: { origin } })).status, 401);
  }
  for (const origin of ['http://zam4.com', 'https://admin.zam4.com', 'https://www.zam4.com.attacker.test', 'null']) {
    const response = await request(api, { method: 'OPTIONS', headers: { origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers['Access-Control-Allow-Origin'], undefined);
  }
  assert.deepEqual(allowedOrigins('https://another.example'), ['https://another.example']);
  assert.deepEqual(allowedOrigins('https://zam4.com/'), []);
  assert.deepEqual(allowedOrigins('http://zam4.com'), []);
  assert.equal(publicConfiguration(config).appOrigin, config.origin);
});
test('push endpoints cannot reach arbitrary, internal, credential-bearing or deceptive URLs', () => {
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a', 'https://fcm.googleapis.com.evil.test/a', 'https://fcm.googleapis.com@127.0.0.1/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://169.254.169.254/latest/meta-data', 'https://web.push.apple.com/a#secret', 'https://user:pass@fcm.googleapis.com/a', 'https://evil.notify.windows.com.evil.test/a']) assert.throws(() => validateEndpoint(endpoint));
  assert.equal(validateSubscription(sub()).endpoint, 'https://fcm.googleapis.com/fcm/send/test');
  assert.throws(() => validateSubscription({ ...sub(), keys: { p256dh: 'A'.repeat(87), auth: 'A'.repeat(22) } }));
  for (const address of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '192.168.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
test('API validates Supabase auth, own-account scope, origin, key rotation and disabled flag', async () => {
  const writes = [];
  const repository = { status: async userId => ({ registered: userId === 'owner' }), subscribe: async (...args) => writes.push(args), unsubscribe: async (...args) => writes.push(args) };
  const api = createHttp({ config, repository, authenticate: async token => ({ data: { user: token === 'valid-token' ? { id: 'owner' } : null } }) });
  assert.equal((await request(api, { path: 'config' })).status, 200);
  assert.equal((await request(api)).status, 401);
  assert.equal((await request(api, { headers: { authorization: 'Bearer bad-token' } })).status, 401);
  assert.equal((await request(api, { headers: { ...authHeaders, origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await request(api, { method: 'POST', headers: authHeaders, body: { subscription: sub(), keyId: 'old' } })).status, 409);
  assert.equal((await request(api, { method: 'POST', headers: authHeaders, body: { subscription: sub(), keyId: config.keyId, userId: 'victim' } })).status, 409);
  assert.equal((await request(api, { method: 'POST', headers: authHeaders, body: { subscription: sub(), keyId: config.keyId } })).status, 200);
  assert.equal(writes[0][0], 'owner');
  assert.equal((await request(api, { method: 'DELETE', headers: authHeaders, body: { hash: 'a'.repeat(64) } })).status, 200);
  assert.deepEqual(writes[1], ['owner', 'a'.repeat(64)]);
  const disabled = createHttp({ config: { ...config, enabled: false }, repository, authenticate: async () => ({ data: { user: { id: 'owner' } } }) });
  assert.equal((await request(disabled, { method: 'POST', headers: authHeaders, body: { subscription: sub(), keyId: config.keyId } })).status, 503);
  assert.equal((await request(disabled, { method: 'DELETE', headers: authHeaders, body: { hash: 'a'.repeat(64) } })).status, 200, 'revocation remains available while sending is disabled');
});
function memoryRepository() {
  let data = state(), revision = 0;
  const devices = [{ endpoint_hash: 'a', subscription: sub('newest') }, { endpoint_hash: 'b', subscription: sub('older') }];
  return {
    get data() { return data; }, change(operation) { operation(data); revision++; },
    accounts: async (_key, offset) => offset ? [] : [{ user_id: 'owner' }],
    snapshot: async () => ({ data: structuredClone(data), updated_at: String(revision) }),
    subscriptions: async () => [...devices],
    unsubscribe: async (_user, hash) => { const index = devices.findIndex(item => item.endpoint_hash === hash); if (index !== -1) devices.splice(index, 1); },
    claim: async (_user, expected, reminderKey, timestamp) => {
      if (String(revision) !== expected || data.reminderReceipts?.[reminderKey]) return false;
      data.reminderReceipts = { ...data.reminderReceipts, [reminderKey]: timestamp }; revision++; return true;
    }
  };
}
test('concurrent cron runs and a later run send each account reminder only once', async () => {
  const repository = memoryRepository(), calls = [];
  const params = { repository, config, now, send: async (...args) => calls.push(args) };
  const results = await Promise.all([dispatch(params), dispatch(params)]);
  assert.equal(calls.length, 1); assert.equal(calls[0][0].endpoint, sub('newest').endpoint);
  assert.equal(calls[0][1].userId, 'owner'); assert.equal(calls[0][1].day, '2026-10-05');
  assert.equal(results.reduce((sum, result) => sum + result.accepted, 0), 1);
  await dispatch(params); assert.equal(calls.length, 1);
  assert.equal(repository.data.financeiro[0].valor, 900); assert.equal(repository.data.legacy.keep, true);
});
test('a daily digest delivered after midnight opens the date it summarizes', async () => {
  const repository = memoryRepository(), calls = [];
  repository.change(data => {
    data.agendaSettings = { enabled: true, dailyEnabled: true, taskEnabled: false, dailyTime: '23:59' };
  });
  const midnight = Date.parse('2026-10-06T00:00:20-03:00');
  const result = await dispatch({ repository, config, now: midnight, send: async (_subscription, payload) => calls.push(payload) });
  assert.equal(result.accepted, 1);
  assert.equal(calls[0].day, '2026-10-05');
});
test('revalidation cancels reminders after remote completion, disabling or rescheduling', async () => {
  for (const mutate of [data => { data.agenda[0].status = 'Concluído'; }, data => { data.agendaSettings.enabled = false; }, data => { data.agenda[0].hora = '13:00'; }]) {
    const repository = memoryRepository(), original = repository.subscriptions;
    repository.subscriptions = async (...args) => { repository.change(mutate); return original(...args); };
    let sent = 0; await dispatch({ repository, config, now, send: async () => sent++ }); assert.equal(sent, 0);
  }
});
test('expired provider subscriptions are removed; uncertain delivery is never blindly retried', async () => {
  const repository = memoryRepository(), calls = [];
  const result = await dispatch({ repository, config, now, send: async subscription => { calls.push(subscription.endpoint); if (calls.length === 1) throw Object.assign(new Error('gone'), { statusCode: 410 }); } });
  assert.equal(result.expired, 1); assert.equal(result.accepted, 1); assert.equal(calls.length, 2);
  const uncertain = memoryRepository(); let attempts = 0;
  const params = { repository: uncertain, config, now, send: async () => { attempts++; throw new Error('timeout after provider acceptance'); } };
  assert.equal((await dispatch(params)).failed, 1); await dispatch(params); assert.equal(attempts, 1);
});
test('deleting expired subscriptions does not skip accounts on the next page', async () => {
  const ids = new Set(Array.from({ length: 101 }, (_, index) => String(index).padStart(4, '0')));
  const repository = {
    accounts: async (_key, after, limit) => [...ids].filter(id => !after || id > after).slice(0, limit).map(user_id => ({ user_id })),
    snapshot: async () => ({ data: state(), updated_at: 'v1' }),
    subscriptions: async userId => [{ endpoint_hash: userId, subscription: { ...sub(), expirationTime: 1 } }],
    unsubscribe: async userId => ids.delete(userId)
  };
  const result = await dispatch({ repository, config, now, send: async () => assert.fail('expired subscriptions cannot receive a push') });
  assert.equal(result.accounts, 101); assert.equal(result.expired, 101); assert.equal(ids.size, 0);
});
test('cron requires long constant-time secret and refuses to send while disabled', async () => {
  const repository = memoryRepository(); let calls = 0;
  const handler = createCron({ config, repository, clock: () => now, send: async () => calls++ });
  assert.equal((await request(handler)).status, 401);
  assert.equal((await request(handler, { headers: { authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await request(handler, { headers: { authorization: `Bearer ${config.cronSecret}` } })).status, 200); assert.equal(calls, 1);
  const disabled = createCron({ config: { ...config, enabled: false }, repository, send: async () => calls++ });
  assert.equal((await request(disabled, { headers: { authorization: `Bearer ${config.cronSecret}` } })).status, 503); assert.equal(calls, 1);
});
test('SQL migration preserves state, seals subscriptions and arbitrates foreground/background receipts', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      grant usage on schema public,auth to anon,authenticated,service_role;
      create table public.app_state(user_id uuid primary key references auth.users(id),data jsonb not null,updated_at timestamptz not null default clock_timestamp());
      grant select,update on public.app_state to authenticated,service_role;`);
    const migration = readFileSync('database/migrations/20261005_reminders.sql', 'utf8');
    await db.exec(migration); await db.exec(migration);
    const user = randomUUID(), other = randomUUID();
    await db.query('insert into auth.users values ($1),($2)', [user, other]);
    await db.query('insert into public.app_state(user_id,data) values($1,$2)', [user, JSON.stringify(state())]);
    const initial = (await db.query('select data,updated_at::text as revision from public.app_state where user_id=$1', [user])).rows[0];
    const reminderKey = helpers.remindersBetween(state(), now - 60000, now)[0].key;
    await db.exec('set role service_role');
    const claim = await db.query('select public.reminder_claim($1,$2,$3,$4) as claimed', [user, initial.revision, reminderKey, now]);
    assert.equal(claim.rows[0].claimed, true);
    const lost = await db.query('update public.app_state set data=$1 where user_id=$2 and updated_at=$3 returning user_id', [JSON.stringify(initial.data), user, initial.revision]);
    assert.equal(lost.rows.length, 0, 'foreground CAS loses after background claims');
    const duplicate = await db.query('select public.reminder_claim($1,updated_at,$2,$3) as claimed from public.app_state where user_id=$1', [user, reminderKey, now]);
    assert.equal(duplicate.rows[0].claimed, false);
    const saved = (await db.query('select data from public.app_state where user_id=$1', [user])).rows[0].data;
    assert.deepEqual(saved.financeiro, initial.data.financeiro); assert.deepEqual(saved.legacy, initial.data.legacy);
    const hash = fingerprint(sub().endpoint);
    await db.query('select public.reminder_subscribe($1,$2,$3,$4)', [user, hash, JSON.stringify(sub()), config.keyId]);
    await assert.rejects(db.query('select public.reminder_subscribe($1,$2,$3,$4)', [other, hash, JSON.stringify(sub()), config.keyId]), /REMINDER_SUBSCRIPTION_OWNED/);
    for (const role of ['authenticated', 'anon']) {
      await db.exec(`reset role; set role ${role}`);
      await assert.rejects(db.query('select * from public.reminder_subscriptions'), /permission denied/);
      await assert.rejects(db.query('select public.reminder_claim($1,$2,$3,$4)', [user, initial.revision, reminderKey, now]), /permission denied/);
    }
    await db.exec('reset role');
    const reversedKey = `${reminderKey}:browser-first`;
    await db.query("update public.app_state set data=jsonb_set(data,'{reminderReceipts}',(data->'reminderReceipts') || jsonb_build_object($2::text,$3::bigint)),updated_at=clock_timestamp() where user_id=$1", [user, reversedKey, now]);
    const reversed = await db.query('select public.reminder_claim($1,updated_at,$2,$3) as claimed from public.app_state where user_id=$1', [user, reversedKey, now]);
    assert.equal(reversed.rows[0].claimed, false, 'background loses after foreground claims');
  } finally { await db.close(); }
});
