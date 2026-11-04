'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve(__dirname, '../.playwright');
const { chromium } = require('playwright');
const { createService } = require('../services/dot/service');
const { createHandler } = require('../services/dot/http');
test('tela real: nenhuma escrita ao abrir, dados como texto, confirmação única e cancelamento', async () => {
  const owner = randomUUID(), origin = 'https://zama.example';
  let snapshot = { state: {}, jarvis: { actions: [] } }, decisions = 0, dropDecisionResponse = true;
  const repo = { userId: owner, consumeRate: async () => {}, read: async () => structuredClone(snapshot), transact: async fn => { const copy = structuredClone(snapshot), change = fn(copy); if (!change.unchanged) { if (!change.writeState) copy.state = snapshot.state; snapshot = copy; } return structuredClone(change.result); } };
  const service = createService({ repository: repo, ownerId: owner, origin });
  const pending = await service.call({ name: 'prepare_expense', request_id: randomUUID(), arguments: { amount: 50, category: 'Marketing', description: '<img src=x onerror=alert(1)>', notes: 'Revisão' } });
  const handler = createHandler({ config: { enabled: true, ownerId: owner, origin }, authenticate: async () => ({ data: { user: { id: owner } } }), repositoryFactory: () => repo });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({ contentType: 'application/javascript', body: `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'test-session',user:{id:'${owner}',email:'owner@example.test'}}}}),onAuthStateChange:()=>({})}})};` });
      if (url.pathname === '/assets/js/env.js') return route.fulfill({ contentType: 'application/javascript', body: "window.ZAMA_CONFIG={supabaseUrl:'https://supabase.example',supabaseAnonKey:'test-public'};" });
      if (url.pathname === '/api/dot') {
        if (url.searchParams.get('operation') === 'decide') decisions++;
        const req = Readable.from([request.postData() || '']); req.url = url.pathname + url.search; req.method = request.method(); req.headers = request.headers();
        let result; const headers = {}; const res = { setHeader(k, v) { headers[k] = v; }, end(body) { result = { status: this.statusCode, headers, body }; } };
        await handler(req, res);
        // The server committed, but the browser did not receive the response.
        if (url.searchParams.get('operation') === 'decide' && dropDecisionResponse) { dropDecisionResponse = false; return route.abort('connectionfailed'); }
        return route.fulfill(result);
      }
      const paths = { '/dot-confirm.html': ['app/dot-confirm.html', 'text/html'], '/assets/dot-confirm.css': ['app/assets/dot-confirm.css', 'text/css'], '/assets/js/dot-confirm.js': ['app/assets/js/dot-confirm.js', 'application/javascript'] };
      if (paths[url.pathname]) return route.fulfill({ body: readFileSync(resolve(__dirname, '..', paths[url.pathname][0])), contentType: paths[url.pathname][1] });
      return route.abort();
    });
    await page.goto(pending.confirmation_url);
    await page.waitForFunction(() => !document.getElementById('confirm').disabled);
    assert.equal(decisions, 0); assert.equal(snapshot.state.financeiro, undefined);
    assert.equal(await page.locator('#details img').count(), 0); assert.ok((await page.locator('#details').innerText()).includes('<img src=x onerror=alert(1)>'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#confirm').click(); await page.waitForFunction(() => document.getElementById('status').textContent === 'Despesa registrada.');
    assert.equal(decisions, 1); assert.equal(snapshot.state.financeiro.length, 1); assert.equal(await page.locator('#confirm').isDisabled(), true);
    await page.reload(); await page.waitForFunction(() => document.getElementById('status').textContent === 'Despesa registrada.'); assert.equal(decisions, 1);
    const second = await service.call({ name: 'prepare_expense', request_id: randomUUID(), arguments: { amount: 30, category: 'Marketing', description: 'Cancelar' } });
    await page.goto(second.confirmation_url); await page.waitForFunction(() => !document.getElementById('cancel').disabled); await page.locator('#cancel').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Pedido cancelado.'));
    assert.equal(snapshot.state.financeiro.length, 1);
    mkdirSync(resolve(__dirname, '../test-results/dot'), { recursive: true });
    await page.screenshot({ path: resolve(__dirname, '../test-results/dot/confirmation-preview.png'), fullPage: true });
  } finally { await browser.close(); }
});
