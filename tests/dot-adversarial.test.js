'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { createService } = require('../services/dot/service');
const { createHandler } = require('../services/dot/http');
const { createBridge } = require('../plugin/zama-private/server');
const origin = 'https://zama.example';
function repository(userId = randomUUID(), state = {}) {
  let saved = { state, jarvis: { actions: [] } }, queue = Promise.resolve(), failing = false;
  return { userId, failNextCommit() { failing = true; }, read: async () => structuredClone(saved), consumeRate: async () => {}, transact(fn) {
    const job = queue.then(() => { const copy = structuredClone(saved), change = fn(copy); if (!change.unchanged) { if (failing) { failing = false; throw new Error('Simulated commit failure'); } if (!change.writeState) copy.state = saved.state; saved = copy; } return structuredClone(change.result); }); queue = job.catch(() => {}); return job;
  } };
}
const service = repo => createService({ repository: repo, ownerId: repo.userId, origin, clock: () => new Date('2026-11-04T23:30:00-03:00') });
const input = (name, args = {}, request_id = randomUUID()) => ({ name, arguments: args, request_id });
const sample = {
  create_task: { title: 'Preparar material', date: 'amanhã' },
  create_agenda_event: { title: 'Reunião', date: 'amanhã', time: '10:00', reminder_minutes: 60 },
  save_idea: { title: 'Nova campanha', description: 'Apenas dados de teste' },
  prepare_expense: { amount: 19.99, category: 'Marketing', description: 'Despesa fictícia', date: 'hoje' }
};
for (const [name, args] of Object.entries(sample)) {
  test(`${name}: 16 repetições concorrentes e recriação do serviço preservam um único registro`, async () => {
    const repo = repository(), api = service(repo), request = input(name, args);
    const replies = await Promise.all(Array.from({ length: 16 }, () => api.call(structuredClone(request))));
    for (const reply of replies) assert.deepEqual(reply, replies[0]);
    assert.deepEqual(await service(repo).call({ ...request, arguments: Object.fromEntries(Object.entries(args).reverse()) }), replies[0]);
    const saved = await repo.read(); assert.equal(saved.jarvis.actions.length, 1);
    if (name === 'prepare_expense') { assert.equal(saved.state.financeiro, undefined); assert.equal((await api.preview(replies[0].action_id)).result.amount_cents, 1999); }
    else if (name === 'save_idea') assert.equal((await api.call(input('search_ideas', { query: 'campanha' }))).result.total, 1);
    else { const list = await api.call(input('get_agenda', { from: 'amanhã', to: 'amanhã' })); assert.equal(list.result.tasks.length, 1); assert.equal(list.result.tasks[0].date, '2026-11-05'); }
  });
  test(`${name}: falha de commit não deixa dado nem auditoria parcial; repetição é recuperável`, async () => {
    const repo = repository(), api = service(repo), request = input(name, args); repo.failNextCommit();
    await assert.rejects(api.call(request), /commit failure/);
    assert.deepEqual(await repo.read(), { state: {}, jarvis: { actions: [] } });
    const result = await api.call(request); assert.ok(['executed', 'pending'].includes(result.status)); assert.equal((await repo.read()).jarvis.actions.length, 1);
  });
}
test('duas contas com mesmo request_id não compartilham dados, propostas ou confirmações', async () => {
  const a = repository(), b = repository(), aa = service(a), bb = service(b), id = randomUUID();
  await aa.call(input('save_idea', { title: 'Somente A' }, id)); await bb.call(input('save_idea', { title: 'Somente B' }, id));
  assert.equal((await aa.call(input('search_ideas', { query: 'Somente B' }))).result.total, 0);
  assert.equal((await bb.call(input('search_ideas', { query: 'Somente A' }))).result.total, 0);
  const pending = await aa.call(input('prepare_expense', sample.prepare_expense)), preview = await aa.preview(pending.action_id);
  await assert.rejects(bb.preview(pending.action_id), { status: 404 });
  await assert.rejects(bb.decide(pending.action_id, { confirmation: true, confirmation_digest: preview.confirmation_digest }), { status: 404 });
  assert.equal((await a.read()).state.financeiro, undefined); assert.equal((await b.read()).state.financeiro, undefined);
});
test('valor inválido, nome de ferramenta proibido e parâmetros de identidade não produzem registros', async () => {
  const repo = repository(), api = service(repo);
  for (const amount of [-1, 0, 1.001, 10000000000]) await assert.rejects(api.call(input('prepare_expense', { ...sample.prepare_expense, amount })));
  for (const name of ['confirm_expense', 'register_income', 'delete_task', '__proto__']) await assert.rejects(api.call(input(name)));
  await assert.rejects(api.call(input('save_idea', { title: 'Teste', owner_id: randomUUID() })));
  await assert.rejects(api.call(input('create_task', { title: 'Teste', date: '31/02/2026' })));
  assert.deepEqual(await repo.read(), { state: {}, jarvis: { actions: [] } });
});
test('confirmação não aceita texto/sim, falha atômica pode ser retomada e cancelar concorre sem duplicação', async () => {
  const repo = repository(), api = service(repo), pending = await api.call(input('prepare_expense', sample.prepare_expense)), preview = await api.preview(pending.action_id);
  for (const confirmation of ['sim', 'true', 1, null]) await assert.rejects(api.decide(pending.action_id, { confirmation, confirmation_digest: preview.confirmation_digest }));
  repo.failNextCommit(); const decision = { confirmation: true, confirmation_digest: preview.confirmation_digest };
  await assert.rejects(api.decide(pending.action_id, decision), /commit failure/); assert.equal((await api.preview(pending.action_id)).status, 'pending'); assert.equal((await repo.read()).state.financeiro, undefined);
  await Promise.all([api.decide(pending.action_id, { ...decision, confirmation: false }), api.decide(pending.action_id, decision)]);
  assert.equal((await api.preview(pending.action_id)).status, 'cancelled'); assert.equal((await repo.read()).state.financeiro, undefined);
});
async function http(handler, { method = 'POST', body = {}, query = '', token = 'session-A', raw, headers = {} } = {}) {
  const req = Readable.from([raw ?? JSON.stringify(body)]); req.url = '/api/dot' + query; req.method = method; req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers };
  let response; await handler(req, { setHeader() {}, end(text) { response = { status: this.statusCode, body: JSON.parse(text) }; } }); return response;
}
test('HTTP revalida autenticação a cada pedido e não consulta repositório após sessão expirar', async () => {
  const repo = repository(); let active = true, lookups = 0;
  const handler = createHandler({ config: { enabled: true, ownerId: repo.userId, origin }, authenticate: async token => active && token === 'session-A' ? { data: { user: { id: repo.userId } } } : { error: new Error('expired') }, repositoryFactory: () => { lookups++; return repo; } });
  const request = input('create_task', sample.create_task); assert.equal((await http(handler, { body: request })).status, 200);
  active = false; assert.equal((await http(handler, { body: request })).status, 401); assert.equal(lookups, 1);
  active = true; assert.equal((await http(handler, { raw: '{broken' })).status, 400);
  assert.equal((await http(handler, { method: 'DELETE' })).status, 405);
  assert.equal((await http(handler, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await repo.read()).state.agenda.length, 1);
});
async function bridgeReady(fetchImpl, env = { ZAMA_API_ORIGIN: origin, ZAMA_ACCESS_TOKEN: 'synthetic-session' }) {
  const bridge = createBridge({ fetchImpl, env });
  await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'independent-test', version: '1' } } });
  await bridge.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); return bridge;
}
const message = (name, args) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
test('resposta perdida após commit no servidor recupera mesmo recibo via MCP sem novo cadastro', async () => {
  const repo = repository(), api = service(repo); let lost = true;
  const bridge = await bridgeReady(async (_url, options) => { const result = await api.call(JSON.parse(options.body)); if (lost) { lost = false; throw new Error('response lost'); } return new Response(JSON.stringify(result)); });
  const request = message('create_task', { ...sample.create_task, request_id: randomUUID() });
  const uncertain = await bridge.handle(request); assert.equal(uncertain.result.isError, true); assert.match(uncertain.result.content[0].text, /OUTCOME_UNKNOWN/);
  const recovered = await bridge.handle(request); assert.equal(recovered.result.structuredContent.status, 'executed'); assert.equal((await repo.read()).state.agenda.length, 1);
});
test('MCP nunca converte corpo inválido HTTP 200 em sucesso de negócio', async () => {
  for (const data of [{}, { error: 'proxy error' }, { status: 'executed' }, { action_id: randomUUID(), status: 'invented', result: {} }, { action_id: randomUUID(), status: 'executed', result: {} }]) {
    const bridge = await bridgeReady(async () => new Response(JSON.stringify(data)));
    const response = await bridge.handle(message('create_task', { ...sample.create_task, request_id: randomUUID() }));
    assert.equal(response.result.isError, true, JSON.stringify(data));
  }
});
test('MCP recusa destino não HTTPS e não expõe corpo remoto de erro', async () => {
  let contacted = 0;
  const wrong = await bridgeReady(async () => { contacted++; }, { ZAMA_API_ORIGIN: 'http://localhost:9', ZAMA_ACCESS_TOKEN: 'synthetic-session' });
  assert.equal((await wrong.handle(message('list_tasks', { request_id: randomUUID() }))).result.isError, true); assert.equal(contacted, 0);
  const remote = await bridgeReady(async () => new Response('PRIVATE_UPSTREAM_DETAIL', { status: 401 }));
  const response = await remote.handle(message('list_tasks', { request_id: randomUUID() })); assert.ok(!JSON.stringify(response).includes('PRIVATE_UPSTREAM_DETAIL')); assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /HTTP_401/);
});
test('MCP rejeita proposta com link externo, ação divergente ou corpo acima do limite', async () => {
  const id = randomUUID(), base = { action_id: id, status: 'pending', result: { amount: 'R$ 10' }, requires_confirmation: true, expires_at: '2026-11-05T00:00:00Z' };
  for (const data of [{ ...base, confirmation_url: `https://evil.example/dot-confirm.html?action=${id}` }, { ...base, confirmation_url: `${origin}/dot-confirm.html?action=${randomUUID()}` }]) {
    const bridge = await bridgeReady(async () => new Response(JSON.stringify(data)));
    assert.equal((await bridge.handle(message('prepare_expense', { ...sample.prepare_expense, request_id: randomUUID() }))).result.isError, true);
  }
  const large = await bridgeReady(async () => new Response(' '.repeat(262145)));
  assert.equal((await large.handle(message('list_tasks', { request_id: randomUUID() }))).result.isError, true);
});
test('as sete ferramentas retornam recibos aceitos pelo adaptador, com consulta de tarefa, agenda, ideia e proposta', async () => {
  const repo = repository(), api = service(repo), bridge = await bridgeReady(async (_url, options) => new Response(JSON.stringify(await api.call(JSON.parse(options.body)))));
  const calls = [['create_task', sample.create_task], ['create_agenda_event', sample.create_agenda_event], ['save_idea', sample.save_idea], ['prepare_expense', sample.prepare_expense], ['list_tasks', { from: 'amanhã', to: 'amanhã' }], ['get_agenda', { from: 'amanhã', to: 'amanhã' }], ['search_ideas', { query: 'campanha' }]];
  const results = {};
  for (const [name, args] of calls) { const response = await bridge.handle(message(name, { ...args, request_id: randomUUID() })); assert.equal(response.result.isError, false, name); results[name] = response.result.structuredContent; }
  assert.equal(results.list_tasks.result.tasks.length, 2); assert.equal(results.get_agenda.result.tasks.length, 2); assert.equal(results.search_ideas.result.total, 1);
  assert.equal(results.prepare_expense.status, 'pending'); assert.equal((await api.preview(results.prepare_expense.action_id)).result.amount_cents, 1999);
  assert.equal((await repo.read()).state.financeiro, undefined);
});
