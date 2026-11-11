'use strict';
// All identities, session strings, URLs and credentials below are local fixtures.
// No HTTP server or external network is used: the real handler talks to PGlite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createHandler, configuration } = require('../services/dot/oauth');
const { createApiKeyAuthenticator } = require('../services/dot/api-key-auth');

const owner = '11111111-1111-4111-8111-111111111111';
const origin = 'https://zama.example';
const resource = `${origin}/api/dot-mcp`;
const redirect = 'https://client.example/callback';
const scope = 'zama:private';
const directScope = `${scope} zama:expenses:write`;
const config = { origin, resource, ownerId: owner, clientId: 'fixture-client', redirects: [redirect], refreshV2Enabled: true };
const verifier = 'fixture-verifier-'.repeat(4);
const hash = value => createHash('sha256').update(value).digest('hex');
const authorization = {
  response_type: 'code', client_id: config.clientId, redirect_uri: redirect,
  resource, scope, state: 'fixture-state', code_challenge_method: 'S256',
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
};
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };
const consentHeaders = { origin, authorization: 'Bearer fixture-session', 'content-type': 'application/json' };
const rpcArgs = {
  dot_oauth_exchange: ['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_direct_enabled'],
  dot_oauth_exchange_refresh: ['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_family','p_refresh_hash','p_direct_enabled'],
  dot_oauth_refresh: ['p_refresh_hash','p_owner','p_client','p_resource','p_grant','p_token_hash','p_next_refresh_hash','p_direct_enabled','p_scope'],
  dot_oauth_v2_exchange_refresh: ['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_refresh_hash','p_direct_enabled'],
  dot_oauth_v2_refresh: ['p_refresh_hash','p_grant','p_owner','p_client','p_resource','p_token_hash','p_next_refresh_hash','p_scope','p_direct_enabled'],
  dot_oauth_revoke_compatible: ['p_token_hash','p_owner','p_client','p_resource'],
};

async function invoke(handler, path, method = 'GET', body, headers = {}, parsedBody) {
  const raw = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)];
  const req = Readable.from(raw);
  req.url = path; req.method = method; req.headers = { host: 'zama.example', ...headers };
  if (parsedBody !== undefined) req.body = parsedBody;
  const responseHeaders = {}; let result;
  await handler(req, {
    setHeader(key, value) { responseHeaders[key] = value; },
    end(text) { result = { status: this.statusCode, headers: responseHeaders, body: text ? JSON.parse(text) : null }; },
  });
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Pragma, 'no-cache');
  return result;
}
const form = (handler, values, path = '/api/dot-oauth/token') => invoke(handler, path, 'POST', new URLSearchParams(values).toString(), formHeaders);
const refreshForm = token => ({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: token });
const codeForm = code => ({ grant_type: 'authorization_code', client_id: config.clientId, code, redirect_uri: redirect, resource, code_verifier: verifier });

async function fixture(t, direct = false) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create table app_state(user_id uuid primary key references auth.users(id),data jsonb not null default '{}',updated_at timestamptz not null default now());");
  for (const name of ['database/migrations/20260930_jarvis.sql','database/migrations/20261104_dot_grants.sql','database/dot-oauth-draft.sql', 'database/migrations/20261104_dot_direct_expenses.sql', 'database/migrations/20261104174518_dot_oauth_refresh.sql', 'database/dot-oauth-refresh-v2-draft.sql']) {
    await db.exec(readFileSync(name, 'utf8'));
  }
  await db.query('insert into auth.users values ($1)', [owner]);
  const calls = [];
  // Exercise actual table grants and SECURITY DEFINER RPC permissions.
  async function asRuntime(operation) {
    await db.exec('set role service_role');
    try { return await operation(); } finally { await db.exec('reset role'); }
  }
  const client = {
    auth: { async getUser(session) { assert.equal(session, 'fixture-session'); return { data: { user: { id: owner } } }; } },
    from(table) {
      assert.ok(['dot_oauth_codes', 'dot_api_grants'].includes(table));
      return {
        async insert(row) {
          assert.equal(table, 'dot_oauth_codes');
          const columns = ['code_hash','owner_id','client_id','resource','redirect_uri','challenge','allow_refresh_v2', ...(direct ? ['allow_direct_expense'] : [])];
          try {
            await asRuntime(() => db.query(`insert into public.dot_oauth_codes(${columns.join(',')}) values(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(key => row[key] ?? false)));
            return {};
          } catch (error) { return { error }; }
        },
        select() { return { eq(key, id) { assert.equal(key, 'id'); return { async maybeSingle() { return { data: (await asRuntime(() => db.query('select allowed_tools from public.dot_api_grants where id=$1', [id]))).rows[0] || null }; } }; } }; },
      };
    },
    async rpc(name, args) {
      assert.ok(Object.hasOwn(rpcArgs, name)); calls.push({ name, args });
      const names = rpcArgs[name].filter(key => Object.hasOwn(args, key));
      try {
        const response = await asRuntime(() => db.query(`select public.${name}(${names.map((_, i) => `$${i + 1}`).join(',')}) as result`, names.map(key => args[key])));
        return { data: response.rows[0].result };
      } catch (error) { return { error }; }
    },
  };
  const handler = overrides => createHandler({ config: { ...config, directExpensesEnabled: direct, ...overrides }, client, preRate: async () => {}, rate: async () => {} });
  const auth = createApiKeyAuthenticator({ ownerId: owner, clientId: config.clientId, resource, store: { async find(id) {
    const row = (await db.query('select * from public.dot_api_grants where id=$1', [id])).rows[0];
    return row ? { ...row, expires_at: row.expires_at.toISOString(), not_before: row.not_before.toISOString() } : null;
  } } });
  const h = handler();
  async function consent(activeHandler = h, overrides = {}) {
    return invoke(activeHandler, '/api/dot-oauth/consent', 'POST', { request: { ...authorization, scope: direct ? directScope : scope }, approve: true, allow_refresh: true, ...overrides }, consentHeaders);
  }
  async function issue(activeHandler = h, overrides = {}) {
    const allowed = await consent(activeHandler, overrides); assert.equal(allowed.status, 200);
    const code = new URL(allowed.body.redirect).searchParams.get('code'); assert.ok(code);
    const response = await form(activeHandler, codeForm(code)); assert.equal(response.status, 200, JSON.stringify(response.body));
    return { ...response.body, code };
  }
  return { db, client, calls, handler, h, auth: token => auth(token, { resource }), consent, issue };
}

test('refresh discovery is opt-in and adds a bounded policy plus revocation metadata', async () => {
  const env = { DOT_OAUTH_ENABLED: 'true', APP_ORIGIN: origin, DOT_MCP_RESOURCE: resource, DOT_OWNER_ID: owner, DOT_MCP_CLIENT_ID: config.clientId, DOT_OAUTH_REDIRECT_URIS: JSON.stringify([redirect]) };
  assert.equal(configuration(env).refreshV2Enabled, false);
  assert.equal(configuration({ ...env, DOT_OAUTH_REFRESH_V2_ENABLED: 'true' }).refreshV2Enabled, true);
  assert.equal(configuration({ ...env, DOT_OAUTH_REFRESH_V2_ENABLED: 'TRUE' }).refreshV2Enabled, false);
  for (const enabled of [false, true]) {
    const h = createHandler({ config: { ...config, refreshV2Enabled: enabled } });
    const result = await invoke(h, '/api/dot-oauth?path=metadata');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.grant_types_supported, enabled ? ['authorization_code','refresh_token'] : ['authorization_code']);
    assert.equal(result.body.revocation_endpoint, `${origin}/api/dot-oauth/revoke`);
    assert.deepEqual(result.body.revocation_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(result.body.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(result.body.zama_refresh_policy, enabled ? { access_expires_in: 3600, idle_expires_in: 604800, absolute_expires_in: 2592000 } : undefined);
  }
});

test('fresh disclosure is required and old consent codes cannot silently gain renewal', async t => {
  const f = await fixture(t);
  for (const allow_refresh of [undefined, false]) {
    const denied = await f.consent(f.h, { allow_refresh }); assert.equal(denied.status, 400);
  }
  assert.equal((await f.db.query('select count(*)::int as n from dot_oauth_codes')).rows[0].n, 0);
  const legacy = f.handler({ refreshV2Enabled: false });
  assert.equal((await f.consent(legacy)).status, 400, 'stale enabled policy is rejected after disable');
  const allowed = await f.consent(legacy, { allow_refresh: false }); assert.equal(allowed.status, 200);
  const code = new URL(allowed.body.redirect).searchParams.get('code');
  const issued = await form(f.h, codeForm(code)); // Legacy consent remains valid, with no v2 renewal. assert.equal(issued.status, 200);
  assert.equal(issued.body.refresh_token, undefined); assert.equal(issued.body.expires_in, 3600);
  assert.equal((await f.db.query('select count(*)::int as n from dot_oauth_v2_sessions')).rows[0].n, 0);
  assert.ok(await f.auth(issued.body.access_token));
});

test('HTTP to real SQL renewal replaces access while preserving the bound principal and storing only hashes', async t => {
  const f = await fixture(t), issued = await f.issue();
  const before = await f.auth(issued.access_token); assert.ok(before);
  const refreshed = await form(f.h, refreshForm(issued.refresh_token)); assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  const after = await f.auth(refreshed.body.access_token); assert.ok(after);
  assert.equal(await f.auth(issued.access_token), null);
  for (const key of ['userId','clientId','audience','grantId']) assert.equal(after[key], before[key]);
  assert.deepEqual(after.allowedTools, before.allowedTools);
  assert.ok(after.grantVersion > before.grantVersion);
  assert.notEqual(refreshed.body.refresh_token, issued.refresh_token);
  assert.equal(refreshed.body.scope, scope);
  const rows = JSON.stringify((await f.db.query('select * from dot_oauth_v2_refresh_tokens')).rows);
  for (const token of [issued.access_token, issued.refresh_token, refreshed.body.access_token, refreshed.body.refresh_token]) assert.ok(!rows.includes(token));
  assert.ok(rows.includes(hash(issued.refresh_token)));
  const rpc = f.calls.find(call => call.name === 'dot_oauth_v2_refresh');
  assert.equal(rpc.args.p_resource, resource, 'omitted resource uses the existing bound resource');
  assert.equal(rpc.args.p_token_hash, hash(refreshed.body.access_token));
  assert.equal(rpc.args.p_next_refresh_hash, hash(refreshed.body.refresh_token));
});

test('legacy pending codes and refresh tokens survive v2 activation without changing policy or scopes', async t => {
  const f = await fixture(t, true);
  const legacy = f.handler({ refreshV2Enabled:false, refreshEnabled:true });
  const both = f.handler({ refreshV2Enabled:true, refreshEnabled:true });
  const allowed = await f.consent(legacy, { request:authorization, allow_refresh:false });
  assert.equal(allowed.status,200);
  const code = new URL(allowed.body.redirect).searchParams.get('code');
  assert.match(code,/^[A-Za-z0-9_-]{43}$/);
  // A changed code cannot opt a legacy authorization into the new policy.
  assert.equal((await form(both,codeForm('zama_code_v2.'+code))).body.error,'invalid_grant');
  const issued = await form(both,codeForm(code));
  assert.equal(issued.status,200);
  assert.match(issued.body.refresh_token,/^zama_refresh_v1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.body.scope,scope);
  assert.equal((await f.db.query('select count(*)::int as n from dot_oauth_v2_sessions')).rows[0].n,0);
  const renewed = await form(both,refreshForm(issued.body.refresh_token));
  assert.equal(renewed.status,200);
  assert.equal(renewed.body.scope,scope);
  const renewedAgain = await form(legacy,refreshForm(renewed.body.refresh_token));
  assert.equal(renewedAgain.status,200,'turning v2 off does not stop authorized v1 refresh');
  const revoked = await form(both,{client_id:config.clientId,token:issued.body.access_token},'/api/dot-oauth/revoke');
  assert.equal(revoked.status,200);
  assert.equal(await f.auth(renewedAgain.body.access_token),null,'historical v1 access revokes descendants');
  assert.equal((await form(both,refreshForm(renewedAgain.body.refresh_token))).body.error,'invalid_grant');
});

test('v2 pending codes cannot downgrade on the legacy path or after a feature switch', async t => {
  const f = await fixture(t);
  const consent = await f.consent();
  const code = new URL(consent.body.redirect).searchParams.get('code');
  assert.match(code,/^zama_code_v2\.[A-Za-z0-9_-]{43}$/);
  const disabled = f.handler({refreshV2Enabled:false,refreshEnabled:true});
  assert.equal((await form(disabled,codeForm(code))).body.error,'invalid_grant');
  assert.equal((await form(disabled,codeForm(code.slice('zama_code_v2.'.length)))).body.error,'invalid_grant');
  const issued = await form(f.h,codeForm(code));
  assert.equal(issued.status,200);
  assert.match(issued.body.refresh_token,/^zama_refresh_v2\./);
});

test('replayed refresh and replayed original authorization code each revoke the stable family', async t => {
  const f = await fixture(t);
  for (const replay of ['refresh','code']) {
    const issued = await f.issue();
    const refreshed = await form(f.h, refreshForm(issued.refresh_token)); assert.equal(refreshed.status, 200);
    const rejected = await form(f.h, replay === 'refresh' ? refreshForm(issued.refresh_token) : codeForm(issued.code));
    assert.equal(rejected.status, 400); assert.deepEqual(rejected.body, { error: 'invalid_grant' });
    assert.equal(await f.auth(refreshed.body.access_token), null);
    assert.deepEqual((await form(f.h, refreshForm(refreshed.body.refresh_token))).body, { error: 'invalid_grant' });
  }
});

test('expired access can renew, but inactivity, absolute expiry and administrative revocation cannot', async t => {
  const f = await fixture(t), expired = await f.issue();
  const grant = expired.access_token.split('.')[1];
  // Move both copies of the access deadline together to model time passing;
  // changing only the grant deadline intentionally represents an admin action.
  await f.db.query("update dot_api_grants set not_before=now()-interval '2 hours',expires_at=now()-interval '1 minute' where id=$1", [grant]);
  await f.db.query('update dot_oauth_v2_refresh_tokens set access_expires_at=(select expires_at from dot_api_grants where id=$1) where grant_id=$1 and used_at is null', [grant]);
  assert.equal(await f.auth(expired.access_token), null);
  const renewed = await form(f.h, refreshForm(expired.refresh_token)); assert.equal(renewed.status, 200);
  assert.ok(await f.auth(renewed.body.access_token));
  const mutations = [
    "update dot_oauth_v2_sessions set idle_expires_at=now()-interval '1 second' where grant_id=$1",
    "update dot_oauth_v2_sessions set created_at=now()-interval '31 days',absolute_expires_at=now()-interval '1 second',idle_expires_at=now()-interval '1 second' where grant_id=$1",
    'update dot_api_grants set revoked_at=now() where id=$1',
    "update dot_api_grants set expires_at=expires_at-interval '1 minute' where id=$1",
  ];
  for (const sql of mutations) {
    const issued = await f.issue(); await f.db.query(sql, [issued.access_token.split('.')[1]]);
    assert.deepEqual((await form(f.h, refreshForm(issued.refresh_token))).body, { error: 'invalid_grant' });
  }
  const reduced = await f.issue();
  await f.db.query("update dot_api_grants set allowed_tools=array['list_tasks'] where id=$1", [reduced.access_token.split('.')[1]]);
  const response = await form(f.h, refreshForm(reduced.refresh_token)); assert.equal(response.status, 200);
  assert.deepEqual((await f.auth(response.body.access_token)).allowedTools, ['list_tasks']);
});

test('bad client, audience, scope and forged refresh cannot burn a valid token', async t => {
  const f = await fixture(t), issued = await f.issue();
  const cases = [
    [{ client_id: 'other-client' }, 'invalid_client'],
    [{ resource: 'https://other.example/api/dot-mcp' }, 'invalid_grant'],
    [{ scope: 'admin' }, 'invalid_scope'],
    [{ scope: directScope }, 'invalid_scope'],
    [{ refresh_token: `${issued.refresh_token.slice(0, -43)}${'A'.repeat(43)}` }, 'invalid_grant'],
  ];
  for (const [changes, error] of cases) {
    const result = await form(f.h, { ...refreshForm(issued.refresh_token), ...changes });
    assert.equal(result.body.error, error);
    assert.ok(await f.auth(issued.access_token));
  }
  const result = await form(f.h, refreshForm(issued.refresh_token)); assert.equal(result.status, 200);
  assert.ok(await f.auth(result.body.access_token));
});

test('pending direct permission is preserved only while authorized and may be narrowed without restoring it', async t => {
  const f = await fixture(t, true), issued = await f.issue();
  assert.equal(issued.scope, directScope); assert.ok((await f.auth(issued.access_token)).allowedTools.includes('record_expense'));
  const first = await form(f.h, refreshForm(issued.refresh_token)); assert.equal(first.status, 200);
  assert.equal(first.body.scope, directScope);
  const narrowed = await form(f.h, { ...refreshForm(first.body.refresh_token), scope }); assert.equal(narrowed.status, 200);
  assert.equal(narrowed.body.scope, scope); assert.ok(!(await f.auth(narrowed.body.access_token)).allowedTools.includes('record_expense'));
  assert.deepEqual((await form(f.h, { ...refreshForm(narrowed.body.refresh_token), scope: directScope })).body, { error: 'invalid_scope' });
  const next = await form(f.h, refreshForm(narrowed.body.refresh_token)); assert.equal(next.status, 200);
  assert.equal(next.body.scope, scope);
  const another = await f.issue();
  const disabled = await form(f.handler({ directExpensesEnabled: false }), refreshForm(another.refresh_token));
  assert.equal(disabled.status, 200); assert.equal(disabled.body.scope, scope);
});

test('revocation accepts current or retired tokens, unknown tokens and hints without leaking existence', async t => {
  const f = await fixture(t);
  for (const tokenKind of ['access_token','refresh_token']) {
    const issued = await f.issue();
    const rotated = await form(f.h, refreshForm(issued.refresh_token)); assert.equal(rotated.status, 200);
    const revoke = { client_id: config.clientId, token: issued[tokenKind], token_type_hint: 'unrecognized-hint' };
    assert.equal((await form(f.h, { ...revoke, client_id: 'other-client' }, '/api/dot-oauth/revoke')).body.error, 'invalid_client');
    assert.ok(await f.auth(rotated.body.access_token));
    for (const path of ['/api/dot-oauth?path=revoke','/api/dot-oauth/revoke']) {
      const result = await form(f.h, revoke, path); assert.equal(result.status, 200); assert.equal(result.body, null);
    }
    assert.equal(await f.auth(rotated.body.access_token), null);
    assert.equal((await form(f.h, refreshForm(rotated.body.refresh_token))).body.error, 'invalid_grant');
  }
  const unknown = await form(f.h, { client_id: config.clientId, token: 'unknown-fixture' }, '/api/dot-oauth/revoke');
  assert.equal(unknown.status, 200); assert.equal(unknown.body, null);
});

test('kill switch stops renewals while revocation remains available and existing access is finite', async t => {
  const f = await fixture(t), issued = await f.issue(), disabled = f.handler({ refreshV2Enabled: false });
  assert.deepEqual((await form(disabled, refreshForm(issued.refresh_token))).body, { error: 'unsupported_grant_type' });
  assert.ok(await f.auth(issued.access_token));
  const result = await form(disabled, { client_id: config.clientId, token: issued.refresh_token }, '/api/dot-oauth/revoke');
  assert.equal(result.status, 200); assert.equal(await f.auth(issued.access_token), null);
});

test('strict forms reject malformed or duplicate values, support parsed Vercel forms and hide DB errors', async t => {
  const f = await fixture(t), issued = await f.issue(), input = refreshForm(issued.refresh_token);
  const valid = new URLSearchParams(input).toString();
  const invalidRequests = [
    [valid + '&refresh_token=duplicate', formHeaders, undefined, 400],
    [valid, { 'content-type': 'application/json' }, undefined, 415],
    [valid, { ...formHeaders, authorization: 'Bearer fixture-session' }, undefined, 401],
    [valid, { ...formHeaders, host: 'evil.example' }, undefined, 403],
    ['', formHeaders, { ...input, refresh_token: [issued.refresh_token, issued.refresh_token] }, 400],
    ['x'.repeat(10001), formHeaders, undefined, 413],
  ];
  for (const [body, headers, parsed, status] of invalidRequests) {
    const response = await invoke(f.h, '/api/dot-oauth/token', 'POST', body, headers, parsed);
    assert.equal(response.status, status); assert.ok(await f.auth(issued.access_token));
  }
  const parsed = await invoke(f.h, '/api/dot-oauth/token', 'POST', undefined, formHeaders, input);
  assert.equal(parsed.status, 200); assert.ok(await f.auth(parsed.body.access_token));
  const dbError = createHandler({ config, client: { rpc: async () => ({ error: { message: `sensitive internal text ${parsed.body.refresh_token}` } }) }, preRate: async () => {} });
  assert.deepEqual((await form(dbError, refreshForm(parsed.body.refresh_token))).body, { error: 'server_error' });
  for (const data of [true, null, {}, { expires_in: 999999, refresh_token_expires_in: 604800, scope }, { expires_in: 3600, refresh_token_expires_in: 604800, scope: 'admin' }]) {
    const badResult = createHandler({ config, client: { rpc: async () => ({ data }) }, preRate: async () => {} });
    const result = await form(badResult, refreshForm(parsed.body.refresh_token)); assert.equal(result.status, 503); assert.deepEqual(result.body, { error: 'server_error' });
  }
});

test('renewal and revocation share the existing persistent pre-authentication rate limit', async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: false }; } };
  const h = createHandler({ config, client });
  for (const path of ['/api/dot-oauth/token','/api/dot-oauth/revoke']) {
    const result = await form(h, { client_id: config.clientId, token: 'fixture' }, path);
    assert.equal(result.status, 429); assert.equal(result.headers['Retry-After'], '60');
  }
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.name, 'jarvis_consume_rate'); assert.equal(call.args.p_bucket, 'dot_oauth_public'); assert.equal(call.args.p_limit, 120); }
});

test('revocation requires a confirmed database result before reporting success', async () => {
  for (const data of [false,null,undefined,{},'true']) {
    const h=createHandler({config,client:{rpc:async()=>({data})},preRate:async()=>{}});
    const result=await form(h,{client_id:config.clientId,token:'synthetic'},'/api/dot-oauth/revoke');
    assert.equal(result.status,503);
    assert.deepEqual(result.body,{error:'server_error'});
  }
});
