'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, emailHash } = require('../services/project-access/config');
const { createHandler } = require('../services/project-access/http');
const owner = { id: 'owner-id', email: 'admin@example.invalid', email_confirmed_at: '2026-10-14T12:00:00Z' };
const password = 'test-password-123!';
const config = configuration({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-secret', APP_ORIGIN: 'https://www.zam4.com', PROJECT_ACCESS_ADMIN_EMAIL: owner.email });
const headers = { authorization: 'Bearer admin-token', 'content-type': 'application/json', origin: config.origin };
function fixture(settings = {}) {
  const calls = [];
  const admin = {
    auth: {
      getUser: async token => ({ data: { user: token === 'admin-token' ? settings.owner || owner : null } }),
      admin: {
        createUser: async input => {
          calls.push(['create', { ...input }]);
          if (settings.createThrows) throw new Error('private-provider-error');
          return settings.createError ? { error: settings.createError } : { data: { user: { id: 'new-user-id', email: input.email } } };
        },
        deleteUser: async id => { calls.push(['delete', id]); return { error: settings.rollbackError }; }
      }
    },
    from: table => ({ insert: async row => { calls.push(['insert', table, row]); return { error: settings.bindingError }; } })
  };
  const scoped = { rpc: async (name, args) => {
    calls.push(['rpc', name, args]);
    if (name === 'zama_workspace_invite') return settings.inviteError ? { error: settings.inviteError } : { data: { id: 'invite-id', token: 'a'.repeat(64) } };
    if (settings.cancelThrows) throw new Error('private-cancel-error');
    return {};
  } };
  const createClient = (url, key, options) => {
    calls.push(['client', url, key, options]);
    return options.global?.headers?.Authorization ? scoped : admin;
  };
  const api = createHandler({ config: settings.config || config, createClient });
  return { api, calls };
}
async function request(api, { method = 'POST', body = { email: 'new@example.invalid', password }, bodyChunks, requestHeaders = headers } = {}) {
  let result;
  const responseHeaders = {};
  const req = { method, url: '/api/project-access', headers: requestHeaders };
  if (bodyChunks) req[Symbol.asyncIterator] = async function* () { yield* bodyChunks; };
  else req.body = structuredClone(body);
  await api(req, {
    setHeader(name, value) { responseHeaders[name] = value; },
    set statusCode(status) { this.status = status; },
    end(raw) { result = { status: this.status, body: raw ? JSON.parse(raw) : null, headers: responseHeaders }; }
  });
  return result;
}
test('configuration fails closed and account creation requires the authorized confirmed administrator', async () => {
  assert.equal(configuration({}).enabled, false);
  assert.equal(config.adminHash, emailHash(owner.email));
  for (const scenario of [
    { config: { ...config, enabled: false }, status: 503 },
    { owner: { ...owner, email: 'someone@example.invalid' }, status: 403 },
    { owner: { ...owner, email_confirmed_at: null }, status: 403 }
  ]) {
    const f = fixture(scenario); assert.equal((await request(f.api)).status, scenario.status);
    assert.equal(f.calls.filter(call => ['create', 'insert', 'rpc'].includes(call[0])).length, 0);
  }
  const f = fixture();
  assert.equal((await request(f.api, { requestHeaders: {} })).status, 401);
  assert.equal((await request(f.api, { requestHeaders: { ...headers, authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await request(f.api, { requestHeaders: { ...headers, origin: 'https://www.zam4.com.attacker.invalid' } })).status, 403);
  assert.equal((await request(f.api, { method: 'DELETE' })).status, 405);
  assert.equal((await request(f.api, { method: 'OPTIONS' })).status, 204);
});
test('GET exposes capability only; passwords, service keys, and administrative identity are never returned', async () => {
  const f = fixture(); const response = await request(f.api, { method: 'GET' });
  assert.equal(response.status, 200); assert.deepEqual(response.body, { enabled: true });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(f.calls.some(call => call[0] === 'rpc' || call[0] === 'create'), false);
});
test('creation uses caller JWT for permission/rate check and grants only projects with a confirmed new account', async () => {
  const f = fixture(); const response = await request(f.api, { body: { email: ' New@Example.Invalid ', password } });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { created: true, email: 'new@example.invalid', role: 'projects', loginUrl: 'https://www.zam4.com/' });
  assert.deepEqual(f.calls.find(call => call[0] === 'create')[1], { email: 'new@example.invalid', password, email_confirm: true });
  assert.equal(f.calls.filter(call => call[0] === 'client')[1][3].global.headers.Authorization, 'Bearer admin-token');
  assert.deepEqual(f.calls.find(call => call[0] === 'rpc').slice(1), ['zama_workspace_invite', { p_email: 'new@example.invalid', p_role: 'projects' }]);
  assert.deepEqual(f.calls.find(call => call[0] === 'insert').slice(1), ['zama_workspace_members', { owner_id: owner.id, user_id: 'new-user-id', role: 'projects' }]);
  assert.deepEqual(f.calls.at(-1), ['rpc', 'zama_workspace_cancel_invite', { p_id: 'invite-id' }]);
  assert.equal(f.calls.some(call => call[0] === 'delete'), false);
  for (const secret of [password, config.supabaseKey, 'a'.repeat(64), 'admin-token']) assert.ok(!JSON.stringify(response).includes(secret));
});
test('untrusted roles, owner IDs, invalid credentials and oversized input cannot reach account creation', async () => {
  for (const body of [{ email: 'new@example.invalid', password, role: 'owner' }, { email: 'new@example.invalid', password, owner_id: 'victim' }, { email: 'bad', password }, { email: 'new@example.invalid', password: 'short' }, { email: 'new@example.invalid', password: 'a'.repeat(73) }, { email: 'new@example.invalid', password: '😊'.repeat(30) }, { email: owner.email, password }, { email: 'x'.repeat(3000), password }]) {
    const f = fixture(); const response = await request(f.api, { body });
    assert.ok([400, 413].includes(response.status));
    assert.equal(f.calls.some(call => call[0] === 'create' || call[0] === 'rpc'), false);
  }
  const f = fixture(); assert.equal((await request(f.api, { requestHeaders: { ...headers, 'content-type': 'text/plain' } })).status, 415);
});
test('streamed JSON preserves UTF-8 credentials across chunk boundaries', async () => {
  const unicodePassword = 'test-password-\u{1f60a}';
  const raw = Buffer.from(JSON.stringify({ email: 'new@example.invalid', password: unicodePassword }));
  const offset = raw.indexOf(Buffer.from('\u{1f60a}'));
  const f = fixture();
  const response = await request(f.api, { bodyChunks: [raw.subarray(0, offset + 1), raw.subarray(offset + 1, offset + 3), raw.subarray(offset + 3)] });
  assert.equal(response.status, 201);
  assert.equal(f.calls.find(call => call[0] === 'create')[1].password, unicodePassword);
});
test('streamed JSON enforces the body limit in bytes before any mutation', async () => {
  const body = JSON.stringify({ email: 'new@example.invalid', password: '\u00e9'.repeat(1100) });
  const raw = Buffer.from(body);
  assert.ok(body.length < 2048 && raw.length > 2048);
  const f = fixture();
  const response = await request(f.api, { bodyChunks: [raw.subarray(0, 1000), raw.subarray(1000)] });
  assert.equal(response.status, 413);
  assert.equal(f.calls.some(call => ['create', 'insert', 'rpc'].includes(call[0])), false);
});
test('existing account is never modified or linked by password creation', async () => {
  const f = fixture({ createError: { code: 'email_exists', message: 'secret-provider-response' } });
  const response = await request(f.api); assert.equal(response.status, 409); assert.equal(response.body.code, 'ACCOUNT_EXISTS');
  assert.equal(f.calls.some(call => call[0] === 'delete' || call[0] === 'insert'), false);
  assert.equal(f.calls.at(-1)[1], 'zama_workspace_cancel_invite');
  assert.ok(!JSON.stringify(response).includes('secret-provider-response'));
});
test('rate limit and unavailable company checks fail before account creation', async () => {
  for (const [inviteError, status] of [[{ message: 'Limite de convites atingido.' }, 429], [{ code: 'PGRST202' }, 503], [{ message: 'Salve os dados da sua empresa antes de gerar um convite.' }, 400]]) {
    const f = fixture({ inviteError }); assert.equal((await request(f.api)).status, status);
    assert.equal(f.calls.some(call => call[0] === 'create' || call[0] === 'insert'), false);
  }
});
test('failed binding rolls back only the just-created account and preserves secrets', async () => {
  const f = fixture({ bindingError: { message: 'private-db-error' } }); const response = await request(f.api);
  assert.equal(response.status, 503); assert.equal(response.body.code, 'PROJECT_UNAVAILABLE');
  assert.deepEqual(f.calls.find(call => call[0] === 'delete'), ['delete', 'new-user-id']);
  assert.ok(!JSON.stringify(response).includes('private-db-error'));
  const broken = fixture({ bindingError: {}, rollbackError: { message: 'private-rollback-error' } });
  assert.equal((await request(broken.api)).body.code, 'ACCOUNT_SETUP_INCOMPLETE');
});
test('ambiguous auth creation and cleanup failures cannot falsely report account setup failure after a completed binding', async () => {
  const uncertain = fixture({ createThrows: true });
  const response = await request(uncertain.api); assert.equal(response.body.code, 'ACCOUNT_SETUP_INCOMPLETE');
  assert.equal(uncertain.calls.some(call => call[0] === 'delete' || call[0] === 'insert'), false);
  const completed = fixture({ cancelThrows: true });
  assert.equal((await request(completed.api)).status, 201);
  assert.equal(completed.calls.some(call => call[0] === 'delete'), false);
});
