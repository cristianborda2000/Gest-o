'use strict';
// Browser-only fixtures: no account, live authorization or external request.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(__dirname, '../.playwright');
const { chromium } = require('playwright');
const origin = 'https://zama.example';
const scope = 'zama:agenda:cancel';
const metadata = {
  issuer: origin, grant_types_supported: ['authorization_code', 'refresh_token'],
  scopes_supported: ['zama:private', 'zama:expenses:write', scope],
  zama_refresh_version: 2,
  zama_refresh_policy: { access_expires_in: 3600, idle_expires_in: 604800, absolute_expires_in: 2592000 },
};
const params = { client_id: 'fixture', redirect_uri: 'https://client.example/callback', state: 'fixture', scope: 'zama:private' };

async function fixture(t) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const state = { metadata: structuredClone(metadata), metadataStatus: 200, posts: [], hold: null };
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
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"server_error"}' });
    }
    const files = {
      '/dot-authorize.html': ['app/dot-authorize.html', 'text/html'],
      '/assets/js/dot-authorize.js': ['app/assets/js/dot-authorize.js', 'application/javascript'],
      '/assets/dot-confirm.css': ['app/assets/dot-confirm.css', 'text/css'],
    };
    if (url.origin === origin && files[url.pathname]) return route.fulfill({ body: readFileSync(files[url.pathname][0]), contentType: files[url.pathname][1] });
    return route.abort();
  });
  return {
    page, state,
    open: (extra = {}) => page.goto(`${origin}/dot-authorize.html?${new URLSearchParams({ ...params, ...extra })}`),
    ready: () => page.waitForFunction(() => !document.getElementById('allow').disabled),
    failed: () => page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Não foi possível')),
  };
}

test('agenda cancel starts unchecked, requires a click and fits the mobile consent page', async t => {
  const f = await fixture(t);
  await f.open(); await f.ready();
  assert.equal(await f.page.locator('#agenda-cancel-option').isVisible(), true);
  assert.equal(await f.page.locator('#agenda-cancel-consent').isChecked(), false);
  assert.equal(await f.page.locator('#direct-consent').isChecked(), false);
  assert.equal(f.state.posts.length, 0);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.match(await f.page.locator('#agenda-cancel-option').textContent(), /mantém o histórico/);
  assert.match(await f.page.locator('#agenda-cancel-option').textContent(), /toda a série exige seu pedido explícito/);
  mkdirSync('test-results/dot', { recursive: true });
  await f.page.screenshot({ path: 'test-results/dot/oauth-agenda-cancel.png', fullPage: true });
  await f.page.locator('#allow').click(); await f.failed();
  assert.equal(f.state.posts.length, 1);
  assert.equal(f.state.posts[0].consent_agenda_cancel, false);
  assert.equal(f.state.posts[0].consent_direct, false);
  assert.equal(f.state.posts[0].allow_refresh, true, 'renewal is independent of cancellation');
});

test('agenda and expense consent are independent and submitted only by explicit approval', async t => {
  const f = await fixture(t);
  for (const [agenda, direct] of [[true, false], [false, true], [true, true]]) {
    await f.open(); await f.ready();
    if (agenda) await f.page.locator('#agenda-cancel-consent').check();
    if (direct) await f.page.locator('#direct-consent').check();
    const permissions = await f.page.locator('#permissions').textContent();
    assert.equal(permissions.includes('cancelar compromissos'), agenda);
    assert.equal(permissions.includes('sem confirmação por lançamento'), direct);
    await f.page.locator('#allow').click(); await f.failed();
    const submitted = f.state.posts.at(-1);
    assert.equal(submitted.consent_agenda_cancel, agenda);
    assert.equal(submitted.consent_direct, direct);
    assert.equal(submitted.request.scope, 'zama:private');
  }
});

test('requested cancellation scope is disclosed and refusal grants neither permission nor renewal', async t => {
  const f = await fixture(t);
  await f.open({ scope: `zama:private ${scope}` }); await f.ready();
  assert.equal(await f.page.locator('#agenda-cancel-option').isVisible(), false);
  const permissions = await f.page.locator('#permissions').textContent();
  assert.match(permissions, /cancelar compromissos e tarefas/);
  assert.match(permissions, /mantendo o histórico/);
  assert.match(permissions, /toda a série exige pedido explícito/);
  await f.page.locator('#deny').click(); await f.failed();
  assert.equal(f.state.posts.length, 1);
  assert.equal(f.state.posts[0].approve, false);
  assert.equal(f.state.posts[0].consent_agenda_cancel, false);
  assert.equal(f.state.posts[0].consent_direct, false);
  assert.equal(f.state.posts[0].allow_refresh, undefined);
  await f.open({ scope: `zama:private ${scope}` }); await f.ready();
  await f.page.locator('#allow').click(); await f.failed();
  assert.equal(f.state.posts[1].approve, true);
  assert.equal(f.state.posts[1].request.scope, `zama:private ${scope}`);
});

test('unavailable cancellation stays hidden and cannot be consented through a stale checkbox', async t => {
  const f = await fixture(t);
  f.state.metadata.scopes_supported = ['zama:private', 'zama:expenses:write'];
  await f.open(); await f.ready();
  assert.equal(await f.page.locator('#agenda-cancel-option').isVisible(), false);
  assert.equal(await f.page.locator('#agenda-cancel-consent').isDisabled(), true);
  await f.page.evaluate(() => { document.getElementById('agenda-cancel-consent').checked = true; });
  await f.page.locator('#allow').click(); await f.failed();
  assert.equal(f.state.posts[0].consent_agenda_cancel, false);
  await f.open({ scope: `zama:private ${scope}` }); await f.failed();
  assert.equal(await f.page.locator('#allow').isDisabled(), true);
  assert.equal(await f.page.locator('#agenda-cancel-consent').isDisabled(), true);
  assert.equal(f.state.posts.length, 1);
});

test('policy loading, discovery failure and session changes disable agenda consent without automatic posts', async t => {
  const f = await fixture(t); let release;
  f.state.hold = new Promise(resolve => { release = resolve; });
  await f.open();
  assert.equal(await f.page.locator('#allow').isDisabled(), true);
  assert.equal(await f.page.locator('#agenda-cancel-consent').isDisabled(), true);
  assert.equal(f.state.posts.length, 0);
  release(); f.state.hold = null; await f.ready();
  await f.page.locator('#agenda-cancel-consent').check();
  await f.page.evaluate(() => window.fixtureAuthChange());
  assert.equal(await f.page.locator('#agenda-cancel-consent').isDisabled(), true);
  assert.equal(await f.page.locator('#agenda-cancel-consent').isChecked(), false);
  assert.equal(await f.page.locator('#allow').isDisabled(), true);
  assert.equal(f.state.posts.length, 0);
  f.state.metadataStatus = 503;
  await f.page.locator('#reload').click(); await f.failed();
  assert.equal(await f.page.locator('#agenda-cancel-consent').isDisabled(), true);
  assert.equal(f.state.posts.length, 0);
});
