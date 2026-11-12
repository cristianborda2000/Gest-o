'use strict';
// Synthetic identities and tokens only. The real HTTP handler talks to local PGlite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { Readable } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createHandler, metadata, configuration, validateAuthorization } = require('../services/dot/oauth');

const migration = 'database/migrations/20261112200806_dot_agenda_cancel.sql';
const owner = '11111111-1111-4111-8111-111111111111', origin = 'https://zama.example';
const resource = origin + '/api/dot-mcp', redirect = 'https://client.example/callback', clientId = 'fixture';
const baseScope = 'zama:private', cancelScope = baseScope + ' zama:agenda:cancel';
const allScopes = baseScope + ' zama:expenses:write zama:agenda:cancel';
const hash = value => createHash('sha256').update(value).digest('hex');
const verifier = 'fixture-verifier-'.repeat(4);
const authorization = { response_type: 'code', client_id: clientId, resource, redirect_uri: redirect, state: 'fixture-state', scope: baseScope, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
const config = { ownerId: owner, origin, resource, clientId, redirects: [redirect], refreshV2Enabled: true, directExpensesEnabled: true, agendaCancelEnabled: true };
const rpcKeys = {
  dot_oauth_exchange: ['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_direct_enabled'],
  dot_oauth_exchange_refresh: ['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_family','p_refresh_hash','p_direct_enabled'],
  dot_oauth_refresh: ['p_refresh_hash','p_owner','p_client','p_resource','p_grant','p_token_hash','p_next_refresh_hash','p_direct_enabled','p_scope'],
  dot_oauth_v2_exchange_refresh: ['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_refresh_hash','p_direct_enabled'],
  dot_oauth_v2_refresh: ['p_refresh_hash','p_grant','p_owner','p_client','p_resource','p_token_hash','p_next_refresh_hash','p_scope','p_direct_enabled'],
  dot_oauth_revoke_compatible: ['p_token_hash','p_owner','p_client','p_resource'],
};

async function invoke(handler, path, body, headers = {}, method = 'POST') {
  const isForm = path.endsWith('/token') || path.endsWith('/revoke');
  const req = Readable.from(body === undefined ? [] : [isForm ? new URLSearchParams(body).toString() : JSON.stringify(body)]);
  req.method = method; req.url = path; req.headers = { host: 'zama.example', 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers };
  let result;
  await handler(req, { setHeader() {}, end(value) { result = { status: this.statusCode, body: value ? JSON.parse(value) : null }; } });
  return result;
}
const tokenForm = code => ({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, resource, code_verifier: verifier });
const renewalForm = (token, scope) => ({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, ...(scope === undefined ? {} : { scope }) });

async function fixture(t, { applyMigration = true } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table app_state(user_id uuid primary key references auth.users(id),data jsonb not null default '{}',updated_at timestamptz not null default now());");
  for (const path of ['database/migrations/20260930_jarvis.sql','database/migrations/20261104_dot_grants.sql','database/dot-oauth-draft.sql','database/migrations/20261104_dot_direct_expenses.sql','database/migrations/20261104174518_dot_oauth_refresh.sql','database/dot-oauth-refresh-v2-draft.sql']) await db.exec(readFileSync(path, 'utf8'));
  await db.query('insert into auth.users values ($1)', [owner]);
  if (applyMigration) await db.exec(readFileSync(migration, 'utf8'));
  let actor = owner;
  async function runtime(fn) { await db.exec('set role service_role'); try { return await fn(); } finally { await db.exec('reset role'); } }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: actor } } }) },
    from(table) {
      assert.ok(['dot_oauth_codes','dot_api_grants'].includes(table));
      return {
        async insert(row) {
          assert.equal(table, 'dot_oauth_codes');
          const columns = Object.keys(row); assert.ok(columns.every(key => ['code_hash','owner_id','client_id','resource','redirect_uri','challenge','allow_direct_expense','allow_refresh_v2','allow_agenda_cancel'].includes(key)));
          try { await runtime(() => db.query(`insert into dot_oauth_codes(${columns.join(',')}) values(${columns.map((_, i) => '$' + (i + 1)).join(',')})`, columns.map(key => row[key]))); return {}; } catch (error) { return { error }; }
        },
        select() { return { eq(key, id) { assert.equal(key, 'id'); return { maybeSingle: async () => ({ data: (await runtime(() => db.query('select allowed_tools from dot_api_grants where id=$1', [id]))).rows[0] }) }; } }; },
      };
    },
    async rpc(name, args) {
      assert.ok(Object.hasOwn(rpcKeys, name));
      const keys = rpcKeys[name].filter(key => Object.hasOwn(args, key));
      try { return { data: (await runtime(() => db.query(`select public.${name}(${keys.map((key, i) => key + ' => $' + (i + 1)).join(',')}) as result`, keys.map(key => args[key])))).rows[0].result }; } catch (error) { return { error }; }
    },
  };
  const handler = overrides => createHandler({ config: { ...config, ...overrides }, client, preRate: async () => {}, rate: async () => {} });
  const consent = (overrides = {}, handlerOptions = {}) => invoke(handler(handlerOptions), '/api/dot-oauth/consent', { request: authorization, approve: true, ...(handlerOptions.refreshV2Enabled === false ? {} : { allow_refresh: true }), ...overrides }, { origin, authorization: 'Bearer fixture-session' });
  async function issue(overrides = {}, handlerOptions = {}) {
    const approved = await consent(overrides, handlerOptions); assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirect).searchParams.get('code'); assert.ok(code);
    const exchanged = await invoke(handler(handlerOptions), '/api/dot-oauth/token', tokenForm(code)); assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    return { ...exchanged.body, code };
  }
  const refresh = (token, scope, options = {}) => invoke(handler(options), '/api/dot-oauth/token', renewalForm(token, scope));
  const grant = async token => (await db.query('select * from dot_api_grants where id=$1', [token.split('.')[1]])).rows[0];
  return { db, client, runtime, handler, consent, issue, refresh, grant, actor(value) { actor = value; } };
}

test('agenda cancellation scope is explicitly feature gated and canonicalized without changing existing scopes', () => {
  const env = { DOT_OAUTH_ENABLED: 'true', APP_ORIGIN: origin, DOT_MCP_RESOURCE: resource, DOT_OWNER_ID: owner, DOT_MCP_CLIENT_ID: clientId, DOT_OAUTH_REDIRECT_URIS: JSON.stringify([redirect]) };
  assert.equal(configuration(env).agendaCancelEnabled, false);
  assert.equal(configuration({ ...env, DOT_AGENDA_CANCEL_ENABLED: 'true' }).agendaCancelEnabled, true);
  assert.equal(configuration({ ...env, DOT_AGENDA_CANCEL_ENABLED: 'TRUE' }).agendaCancelEnabled, false);
  for (const protectedResource of [true, false]) assert.deepEqual(metadata(config, protectedResource).scopes_supported, allScopes.split(' '));
  assert.deepEqual(metadata({ ...config, agendaCancelEnabled: false }, false).scopes_supported, [baseScope,'zama:expenses:write']);
  assert.equal(validateAuthorization({ ...authorization, scope: 'zama:agenda:cancel zama:private zama:expenses:write' }, config).scope, allScopes);
  for (const scope of [cancelScope, allScopes]) assert.throws(() => validateAuthorization({ ...authorization, scope }, { ...config, agendaCancelEnabled: false }));
  for (const scope of ['zama:agenda:cancel', cancelScope + ' zama:agenda:cancel', baseScope + ' unknown', cancelScope + ' ']) assert.throws(() => validateAuthorization({ ...authorization, scope }, config));
});

test('owner consent is required separately: base requests do not silently gain cancellation', async t => {
  const f = await fixture(t);
  const base = await f.issue(); assert.equal(base.scope, baseScope); assert.ok(!(await f.grant(base.access_token)).allowed_tools.includes('cancel_agenda_event'));
  const opted = await f.issue({ consent_agenda_cancel: true }); assert.equal(opted.scope, cancelScope); assert.ok((await f.grant(opted.access_token)).allowed_tools.includes('cancel_agenda_event'));
  const requested = await f.issue({ request: { ...authorization, scope: cancelScope } }); assert.equal(requested.scope, cancelScope);
  assert.equal((await f.consent({ consent_agenda_cancel: true }, { agendaCancelEnabled: false })).status, 400);
  f.actor(randomUUID()); assert.equal((await f.consent({ consent_agenda_cancel: true })).status, 403); f.actor(owner);
  const count = async () => (await f.db.query('select count(*)::int as n from dot_oauth_codes')).rows[0].n;
  const before = await count(), denied = await f.consent({ approve: false, consent_agenda_cancel: true });
  assert.equal(new URL(denied.body.redirect).searchParams.get('error'), 'access_denied'); assert.equal(await count(), before);
});

test('migration preserves existing grants and both session formats; old codes cannot acquire cancellation', async t => {
  const f = await fixture(t, { applyMigration: false });
  const legacy = await f.issue({}, { agendaCancelEnabled: false, refreshV2Enabled: false, refreshEnabled: true });
  const v2 = await f.issue({}, { agendaCancelEnabled: false });
  const codeResponse = await f.consent({}, { agendaCancelEnabled: false });
  const oldCode = new URL(codeResponse.body.redirect).searchParams.get('code');
  const snapshot = async () => Promise.all(['dot_api_grants','dot_oauth_families','dot_oauth_v2_sessions','dot_oauth_refresh_tokens','dot_oauth_v2_refresh_tokens'].map(async table => (await f.db.query(`select row_to_json(t) as value from ${table} t order by 1::text`)).rows));
  const before = await snapshot(); await f.db.exec(readFileSync(migration, 'utf8')); assert.deepEqual(await snapshot(), before);
  assert.equal((await f.db.query('select count(*)::int as n from dot_oauth_codes where allow_agenda_cancel')).rows[0].n, 0);
  const exchanged = await invoke(f.handler(), '/api/dot-oauth/token', tokenForm(oldCode)); assert.equal(exchanged.status, 200); assert.equal(exchanged.body.scope, baseScope);
  for (const [issued, options] of [[legacy,{ refreshV2Enabled: false, refreshEnabled: true }],[v2,{}]]) {
    const denied = await f.refresh(issued.refresh_token, cancelScope, options); assert.equal(denied.status, 400);
    const renewed = await f.refresh(issued.refresh_token, undefined, options); assert.equal(renewed.status, 200); assert.equal(renewed.body.scope, baseScope);
    assert.ok(!(await f.grant(renewed.body.access_token)).allowed_tools.includes('cancel_agenda_event'));
  }
});

for (const [name, options] of [['V2',{}],['V1',{ refreshV2Enabled: false, refreshEnabled: true }],['nonrenewable',{ refreshV2Enabled: false, refreshEnabled: false }]]) {
  test(name + ' issues exactly the approved cancellation and finance scopes', async t => {
    const f = await fixture(t), issued = await f.issue({ consent_agenda_cancel: true, consent_direct: true }, options);
    assert.equal(issued.scope, allScopes); assert.ok((await f.grant(issued.access_token)).allowed_tools.includes('cancel_agenda_event'));
    if (name === 'nonrenewable') { assert.equal(issued.refresh_token, undefined); return; }
    const renewed = await f.refresh(issued.refresh_token, undefined, { ...options, agendaCancelEnabled: false });
    assert.equal(renewed.status, 200); assert.equal(renewed.body.scope, allScopes, 'feature switch does not silently revoke previously approved permission');
  });
}

test('nonrenewable token reports approved cancellation even if its feature is switched off after consent', async t => {
  const f = await fixture(t), options = { refreshV2Enabled: false, refreshEnabled: false, directExpensesEnabled: false };
  const approved = await f.consent({ consent_agenda_cancel: true }, options); assert.equal(approved.status, 200);
  const code = new URL(approved.body.redirect).searchParams.get('code');
  const exchanged = await invoke(f.handler({ ...options, agendaCancelEnabled: false }), '/api/dot-oauth/token', tokenForm(code));
  assert.equal(exchanged.status, 200); assert.equal(exchanged.body.scope, cancelScope);
  assert.ok((await f.grant(exchanged.body.access_token)).allowed_tools.includes('cancel_agenda_event'));
});

test('nonrenewable exchange fails closed when the issued grant cannot be read', async () => {
  for (const reply of [{ error: { message: 'private database detail' } }, { data: null }, { data: { allowed_tools: null } }]) {
    const client = { rpc: async () => ({ data: true }), from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => reply }) }) }) };
    const h = createHandler({ config: { ...config, refreshV2Enabled: false, directExpensesEnabled: false, agendaCancelEnabled: false }, client, preRate: async () => {} });
    const result = await invoke(h, '/api/dot-oauth/token', tokenForm('A'.repeat(43)));
    assert.equal(result.status, 503); assert.deepEqual(result.body, { error: 'server_error' });
  }
});

for (const [name, options] of [['V2',{}],['V1',{ refreshV2Enabled: false, refreshEnabled: true }]]) {
  test(name + ' supports cancellation downscope and cannot add permissions during renewal', async t => {
    const f = await fixture(t);
    const issued = await f.issue({ consent_agenda_cancel: true, consent_direct: true }, options);
    for (const scope of [allScopes + ' unknown', allScopes + ' zama:agenda:cancel']) assert.equal((await f.refresh(issued.refresh_token, scope, options)).status, 400);
    const down = await f.refresh(issued.refresh_token, cancelScope, options); assert.equal(down.status, 200); assert.equal(down.body.scope, cancelScope);
    assert.ok(!(await f.grant(down.body.access_token)).allowed_tools.includes('record_expense'));
    assert.equal((await f.refresh(down.body.refresh_token, allScopes, options)).status, 400);
    const base = await f.refresh(down.body.refresh_token, baseScope, options); assert.equal(base.status, 200); assert.equal(base.body.scope, baseScope);
    assert.ok(!(await f.grant(base.body.access_token)).allowed_tools.includes('cancel_agenda_event'));
    assert.equal((await f.refresh(base.body.refresh_token, cancelScope, options)).status, 400);
    assert.equal((await f.refresh(base.body.refresh_token, undefined, options)).status, 200);
  });
}

test('cancellation migration keeps RPCs server-only, tables protected and application data unchanged', async t => {
  const f = await fixture(t);
  const signatures = [
    'dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean)',
    'dot_oauth_refresh(text,uuid,text,text,uuid,text,text,boolean,text)',
    'dot_oauth_v2_exchange_refresh(text,uuid,text,text,text,text,uuid,text,text,boolean)',
    'dot_oauth_v2_refresh(text,uuid,uuid,text,text,text,text,text,boolean)',
  ];
  for (const signature of signatures) for (const role of ['anon','authenticated','service_role']) {
    const can = (await f.db.query("select has_function_privilege($1,$2,'EXECUTE') as can", [role, 'public.' + signature])).rows[0].can;
    assert.equal(can, role === 'service_role');
  }
  const tables = (await f.db.query("select relrowsecurity,relforcerowsecurity from pg_class where relname=any($1)", [['dot_api_grants','dot_oauth_codes','dot_oauth_families','dot_oauth_v2_sessions','dot_oauth_v2_refresh_tokens']])).rows;
  assert.equal(tables.length, 5); assert.ok(tables.every(row => row.relrowsecurity && row.relforcerowsecurity));
  assert.equal((await f.db.query('select count(*)::int as n from app_state')).rows[0].n, 0);
  for (const role of ['anon','authenticated']) assert.equal((await f.db.query("select has_table_privilege($1,'public.dot_oauth_codes','INSERT') as can", [role])).rows[0].can, false);
});
