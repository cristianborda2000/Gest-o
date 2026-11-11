'use strict';
// All routes, sessions and credentials are local fixtures. No live OAuth flow.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(__dirname, '../.playwright');
const { chromium } = require('playwright');
const origin = 'https://zama.example';
const policy = { access_expires_in: 3600, idle_expires_in: 604800, absolute_expires_in: 2592000 };
const baseMetadata = { issuer: origin, grant_types_supported: ['authorization_code'], scopes_supported: ['zama:private', 'zama:expenses:write'] };
const v2Metadata = { ...baseMetadata, grant_types_supported: ['authorization_code', 'refresh_token'], zama_refresh_version: 2, zama_refresh_policy: policy };
const params = { client_id: 'fixture', redirect_uri: 'https://client.example/callback', state: 'fixture', scope: 'zama:private' };

async function fixture(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const state = { metadata: structuredClone(v2Metadata), metadataStatus: 200, posts: [], responseStatus: 503, hold: null };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'application/javascript', body: "window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'fixture',user:{id:'fixture-owner',email:'owner@example.test'}}}}),onAuthStateChange:callback=>{window.fixtureAuthChange=callback;return {};}}})};" });
    if (url.pathname === '/assets/js/env.js') return route.fulfill({ contentType: 'application/javascript', body: "window.ZAMA_CONFIG={supabaseUrl:'https://supabase.example',supabaseAnonKey:'fixture'};" });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (state.hold) await state.hold;
      return route.fulfill({ status: state.metadataStatus, contentType: 'application/json', body: JSON.stringify(state.metadata) });
    }
    if (url.pathname === '/api/dot-oauth/consent') {
      state.posts.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: state.responseStatus, contentType: 'application/json', body: '{"error":"invalid_request"}' });
    }
    const files = { '/dot-authorize.html': ['app/dot-authorize.html', 'text/html'], '/assets/js/dot-authorize.js': ['app/assets/js/dot-authorize.js', 'application/javascript'], '/assets/dot-confirm.css': ['app/assets/dot-confirm.css', 'text/css'] };
    if (url.origin === origin && files[url.pathname]) return route.fulfill({ body: readFileSync(files[url.pathname][0]), contentType: files[url.pathname][1] });
    return route.abort();
  });
  const open = async (overrides = {}) => { await page.goto(`${origin}/dot-authorize.html?${new URLSearchParams({ ...params, ...overrides })}`); };
  const ready = () => page.waitForFunction(() => !document.getElementById('allow').disabled);
  const failed = () => page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Não foi possível'));
  return { page, state, open, ready, failed };
}

test('legacy metadata keeps existing lifetime and direct opt-in without granting v2 renewal', async t => {
  const f = await fixture(t);
  for (const renewable of [false, true]) {
    f.state.metadata = { ...baseMetadata, grant_types_supported: ['authorization_code', ...(renewable ? ['refresh_token'] : [])] };
    await f.open(); await f.ready();
    const lifetime = await f.page.locator('#connection-lifetime').textContent();
    assert.match(lifetime, renewable ? /30 dias sem uso/ : /O acesso dura uma hora/);
    if (renewable) assert.match(lifetime, /sem prazo absoluto adicional/);
    assert.doesNotMatch(lifetime, /7 dias/);
    assert.equal(await f.page.locator('#direct-consent').isChecked(), false);
    assert.equal(await f.page.locator('#direct-option').isVisible(), true);
    assert.equal(f.state.posts.length, renewable ? 1 : 0);
    await f.page.locator('#direct-consent').check();
    assert.match(await f.page.locator('#permissions').textContent(), /sem confirmação por lançamento/);
    await f.page.locator('#allow').click(); await f.failed();
    const submitted = f.state.posts.at(-1);
    assert.equal(submitted.consent_direct, true);
    assert.equal(submitted.allow_refresh, undefined);
    assert.equal(submitted.request.scope, 'zama:private');
  }
});

test('v2 requires displayed policy before consent and preserves explicit expense opt-in', async t => {
  const f = await fixture(t); let release;
  f.state.hold = new Promise(resolve => { release = resolve; });
  await f.open();
  assert.equal(await f.page.locator('#allow').isDisabled(), true);
  assert.equal(await f.page.locator('#direct-consent').isDisabled(), true);
  assert.equal(f.state.posts.length, 0);
  release(); f.state.hold = null; await f.ready();
  const lifetime = await f.page.locator('#connection-lifetime').textContent();
  assert.match(lifetime, /por até 30 dias/); assert.match(lifetime, /7 dias sem renovação/);
  assert.match(lifetime, /até uma hora/); assert.match(lifetime, /permissões aprovadas/);
  assert.equal(await f.page.locator('#direct-consent').isChecked(), false);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  mkdirSync('test-results/dot', { recursive: true });
  await f.page.screenshot({ path: 'test-results/dot/oauth-v2-integrated.png', fullPage: true });
  await f.page.locator('#allow').click(); await f.failed();
  assert.equal(f.state.posts.length, 1);
  assert.equal(f.state.posts[0].allow_refresh, true);
  assert.equal(f.state.posts[0].consent_direct, false, 'renewal does not imply expense consent');
  await f.open(); await f.ready(); await f.page.locator('#direct-consent').check();
  await f.page.evaluate(() => { document.getElementById('allow').click(); document.getElementById('allow').click(); });
  await f.failed(); assert.equal(f.state.posts.length, 2, 'double activation submits once');
  assert.equal(f.state.posts[1].consent_direct, true); assert.equal(f.state.posts[1].allow_refresh, true);
  assert.equal(await f.page.locator('#allow').isDisabled(), true);
});

test('requested direct scope stays visible and refusal never grants direct access or renewal', async t => {
  const f = await fixture(t);
  await f.open({ scope: 'zama:private zama:expenses:write' }); await f.ready();
  assert.equal(await f.page.locator('#direct-option').isVisible(), false);
  const permissions = await f.page.locator('#permissions').textContent();
  assert.match(permissions, /sem confirmação por lançamento/); assert.match(permissions, /deverá perguntar/);
  assert.match(permissions, /Sem teto comercial/);
  await f.page.locator('#deny').click(); await f.failed();
  assert.equal(f.state.posts.length, 1); assert.equal(f.state.posts[0].approve, false);
  assert.equal(f.state.posts[0].consent_direct, false); assert.equal(f.state.posts[0].allow_refresh, undefined);
});

test('discovery fails closed for unknown versions, missing policy, issuer and contradictory lifetimes', async t => {
  const f = await fixture(t);
  const variants = [
    { ...v2Metadata, zama_refresh_policy: undefined },
    { ...v2Metadata, zama_refresh_version: undefined },
    { ...v2Metadata, zama_refresh_version: 3 },
    { ...v2Metadata, zama_refresh_version: '2' },
    { ...v2Metadata, zama_refresh_policy: { ...policy, idle_expires_in: 2592000 } },
    { ...v2Metadata, zama_refresh_policy: { ...policy, absolute_expires_in: 31536000 } },
    { ...v2Metadata, grant_types_supported: ['authorization_code'] },
    { ...v2Metadata, issuer: 'https://other.example' },
    { ...v2Metadata, grant_types_supported: ['authorization_code', 'refresh_token', 'refresh_token'] },
    { ...v2Metadata, scopes_supported: 'zama:private' },
  ];
  for (const metadata of variants) {
    f.state.metadata = metadata; await f.open(); await f.failed();
    assert.equal(await f.page.locator('#allow').isDisabled(), true);
    assert.equal(await f.page.locator('#deny').isDisabled(), true);
    assert.equal(await f.page.locator('#direct-consent').isDisabled(), true);
    assert.equal(f.state.posts.length, 0);
  }
  f.state.metadata = v2Metadata; f.state.metadataStatus = 503;
  await f.open(); await f.failed(); assert.equal(f.state.posts.length, 0);
  f.state.metadataStatus = 200; await f.page.locator('#reload').click(); await f.ready();
  assert.equal(f.state.posts.length, 0);
});

test('stale policy rejection and auth changes require explicit reload without automatic consent retries', async t => {
  const f = await fixture(t);
  f.state.responseStatus = 400; await f.open(); await f.ready();
  await f.page.locator('#allow').click(); await f.failed();
  assert.equal(f.state.posts.length, 1); assert.equal(f.state.posts[0].allow_refresh, true);
  assert.equal(await f.page.locator('#allow').isDisabled(), true);
  await f.page.locator('#reload').click(); await f.ready();
  await f.page.evaluate(() => window.fixtureAuthChange());
  assert.equal(await f.page.locator('#allow').isDisabled(), true);
  assert.equal(await f.page.locator('#direct-consent').isDisabled(), true);
  assert.equal(f.state.posts.length, 1);
});
