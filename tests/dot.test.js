'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { createService, definitions } = require('../services/dot/service');
const { createHandler } = require('../services/dot/http');
const { createBridge } = require('../plugin/zama-private/server');
const origin = 'https://zama.example', owner = randomUUID();
function memory(state = {}) {
  let saved = { state, jarvis: { actions: [] } }, queue = Promise.resolve();
  return { userId: owner, consumeRate: async () => {}, read: async () => structuredClone(saved), transact(fn) {
    const run = queue.then(() => { const snapshot = structuredClone(saved), change = fn(snapshot); if (!change.unchanged) { if (!change.writeState) snapshot.state = saved.state; saved = snapshot; } return structuredClone(change.result); }); queue = run.catch(() => {}); return run;
  } };
}
const make = (repo, clock) => createService({ repository: repo, ownerId: owner, origin, clock: clock || (() => new Date('2026-11-04T12:00:00Z')) });
const input = (name, args = {}, request_id = randomUUID()) => ({ name, arguments: args, request_id });
const expense = () => input('prepare_expense', { amount: 50, category: 'Marketing', description: 'Anúncio', date: 'hoje' });
async function invoke(handler, { body = {}, method = 'POST', operation = '', headers = {} } = {}) {
  const req = Readable.from([JSON.stringify(body)]); req.url = '/api/dot' + operation; req.method = method; req.headers = { authorization: 'Bearer test-session', 'content-type': 'application/json', ...headers };
  let result; const res = { setHeader() {}, end(text) { result = { status: this.statusCode, body: JSON.parse(text) }; } }; await handler(req, res); return result;
}
test('criação pessoal preserva outros módulos e salva aviso de uma hora; retries concorrentes não duplicam', async () => {
  const repo = memory({ clientes: [{ id: 'preservar' }], financeiro: [] }), service = make(repo);
  const request = input('create_agenda_event', { title: 'Reunião', date: 'amanhã', time: '10:00', reminder_minutes: 60 });
  const results = await Promise.all([service.call(request), service.call(request)]);
  assert.deepEqual(results[0], results[1]);
  const s = await repo.read(); assert.equal(s.state.agenda.length, 1); assert.equal(s.state.agenda[0].prazo, '2026-11-05'); assert.equal(s.state.agenda[0].reminderMinutes, 60); assert.equal(s.state.clientes[0].id, 'preservar'); assert.deepEqual(s.state.financeiro, []);
  assert.equal(s.jarvis.actions[0].actor_id, owner); assert.equal(s.jarvis.actions[0].source, 'dot');
  await assert.rejects(service.call({ ...request, arguments: { ...request.arguments, title: 'Outro' } }), /request_id/);
  await assert.rejects(service.call(input('create_task', { title: 'Sem hora', date: 'hoje', reminder_minutes: 60 })), /horário/);
});
test('ideias e tarefas são consultáveis, e leitura não altera app_state', async () => {
  const repo = memory(), service = make(repo);
  await service.call(input('save_idea', { title: 'Programa de indicação', description: 'Proposta' }));
  await service.call(input('create_task', { title: 'Planejar', date: 'hoje' }));
  const before = (await repo.read()).state;
  const ideas = await service.call(input('search_ideas', { query: 'indicação' })); assert.equal(ideas.result.total, 1);
  const tasks = await service.call(input('list_tasks')); assert.equal(tasks.result.tasks[0].title, 'Planejar');
  await service.call(input('get_agenda', { from: 'hoje', to: 'amanhã' }));
  assert.deepEqual((await repo.read()).state, before);
});
test('preparação financeira não grava ledger; confirmação vinculada aos dados é atômica e idempotente', async () => {
  const repo = memory(), service = make(repo), request = expense();
  const pending = await service.call(request); assert.equal(pending.status, 'pending'); assert.equal((await repo.read()).state.financeiro, undefined);
  assert.ok(pending.confirmation_url.startsWith(origin + '/dot-confirm.html?action='));
  const preview = await service.preview(pending.action_id);
  await assert.rejects(service.decide(pending.action_id, { confirmation: true, confirmation_digest: '0'.repeat(64) }), /mudaram/);
  assert.equal((await repo.read()).state.financeiro, undefined);
  const confirmation = { confirmation: true, confirmation_digest: preview.confirmation_digest };
  await Promise.all([service.decide(pending.action_id, confirmation), service.decide(pending.action_id, confirmation)]);
  const saved = await repo.read(); assert.equal(saved.state.financeiro.length, 1); assert.equal(saved.state.financeiro[0].valor, -50); assert.equal(saved.jarvis.actions[0].confirmed_by, owner);
  assert.equal((await service.call(request)).status, 'executed'); assert.equal((await repo.read()).state.financeiro.length, 1);
});
test('cancelamento, expiração, payload extra e proprietário incorreto não gravam finanças', async () => {
  const repo = memory(); let time = new Date('2026-11-04T12:00:00Z'); const service = make(repo, () => time);
  const first = await service.call(expense()), preview = await service.preview(first.action_id);
  await service.decide(first.action_id, { confirmation: false, confirmation_digest: preview.confirmation_digest });
  assert.equal((await service.decide(first.action_id, { confirmation: true, confirmation_digest: preview.confirmation_digest })).status, 'cancelled');
  const second = await service.call(expense()), p2 = await service.preview(second.action_id); time = new Date('2026-11-06T12:00:00Z');
  await assert.rejects(service.decide(second.action_id, { confirmation: true, confirmation_digest: p2.confirmation_digest }), /expirada/);
  await assert.rejects(service.call({ ...expense(), owner_id: randomUUID() }), /inválidos/);
  await assert.rejects(service.call(input('create_task', { title: 'Teste', date: 'hoje', user_id: randomUUID() })), /inválidos/);
  await assert.rejects(service.call(input('register_income', {})), /inválidos/);
  assert.throws(() => createService({ repository: repo, ownerId: randomUUID(), origin }), /proprietário/);
  assert.equal((await repo.read()).state.financeiro, undefined);
});
test('HTTP valida sessão, proprietário, feature flag, origem e confirmação pela página', async () => {
  const repo = memory(), config = { enabled: true, ownerId: owner, origin }, auth = async () => ({ data: { user: { id: owner } } });
  const handler = createHandler({ config, authenticate: auth, repositoryFactory: () => repo });
  assert.equal((await invoke(handler, { headers: { authorization: '' } })).status, 401);
  assert.equal((await invoke(handler, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await invoke(createHandler({ config: { ...config, enabled: false } }))).status, 503);
  assert.equal((await invoke(createHandler({ config, authenticate: async () => ({ data: { user: { id: randomUUID() } } }) }))).status, 403);
  assert.equal((await invoke(createHandler({ config, authenticate: async () => ({ error: new Error('Expired') }) }))).status, 401);
  const prepared = await invoke(handler, { body: expense() }); assert.equal(prepared.status, 200);
  const id = prepared.body.action_id;
  const preview = await invoke(handler, { method: 'GET', operation: `?operation=preview&action=${id}` }); assert.equal(preview.status, 200);
  const body = { confirmation: true, confirmation_digest: preview.body.confirmation_digest };
  assert.equal((await invoke(handler, { body, operation: `?operation=decide&action=${id}` })).status, 403);
  assert.equal((await invoke(handler, { body, operation: `?operation=decide&action=${id}`, headers: { origin } })).status, 200);
  assert.equal((await repo.read()).state.financeiro.length, 1);
  assert.equal((await invoke(handler, { body: { text: 'x'.repeat(21000) } })).status, 413);
});
async function initialize(bridge) {
  await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await bridge.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
test('MCP publica apenas sete ferramentas e nunca confirmação; configuração ausente falha fechada', async () => {
  assert.deepEqual(definitions(), require('../plugin/zama-private/server/tools.json'));
  const bridge = createBridge({ env: {} }); await initialize(bridge);
  const listing = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); assert.equal(listing.result.tools.length, 7); assert.ok(!listing.result.tools.some(t => /confirm|delete|income/.test(t.name)));
  const response = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tasks', arguments: { request_id: randomUUID() } } }); assert.equal(response.result.isError, true); assert.match(response.result.content[0].text, /NOT_CONFIGURED/);
});
test('MCP chama exclusivamente API permitida, não segue redirects, não vaza token e mantém ID em falha incerta', async () => {
  const id = randomUUID(), token = 'test-token-not-real'; let captured;
  const bridge = createBridge({ env: { ZAMA_API_ORIGIN: origin, ZAMA_ACCESS_TOKEN: token }, fetchImpl: async (url, options) => { captured = { url, options }; throw new Error(token); } }); await initialize(bridge);
  const response = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: { request_id: id, title: 'Teste', date: 'hoje' } } });
  assert.equal(captured.url, origin + '/api/dot'); assert.equal(captured.options.redirect, 'error'); assert.equal(JSON.parse(captured.options.body).request_id, id);
  assert.match(JSON.stringify(response), /OUTCOME_UNKNOWN/); assert.ok(!JSON.stringify(response).includes(token)); assert.ok(JSON.stringify(response).includes(id));
  assert.ok((await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'confirm_expense', arguments: { request_id: id } } })).error);
});
test('protocolo stdio real inicializa e lista ferramentas sem rede ou credenciais', async () => {
  const child = spawn(process.execPath, [resolve(__dirname, '../plugin/zama-private/server/index.js')], { env: { ...process.env, ZAMA_ACCESS_TOKEN: '', ZAMA_API_ORIGIN: '' }, windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }].map(JSON.stringify).join('\n') + '\n');
  assert.equal(await done, 0); assert.equal(stderr, ''); const responses = stdout.trim().split('\n').map(JSON.parse); assert.equal(responses.length, 2); assert.equal(responses[1].result.tools.length, 7);
});
test('MCP até HTTP e persistência: sucesso retorna recibo e repetição preserva uma única tarefa', async () => {
  const repo = memory(), handler = createHandler({ config: { enabled: true, ownerId: owner, origin }, authenticate: async () => ({ data: { user: { id: owner } } }), repositoryFactory: () => repo });
  const bridge = createBridge({ env: { ZAMA_API_ORIGIN: origin, ZAMA_ACCESS_TOKEN: 'test-session' }, fetchImpl: async (url, options) => {
    assert.equal(url, origin + '/api/dot');
    const response = await invoke(handler, { body: JSON.parse(options.body), headers: { authorization: options.headers.Authorization } });
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  } }); await initialize(bridge);
  const message = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: { request_id: randomUUID(), title: 'Integração completa', date: 'hoje' } } };
  const first = await bridge.handle(message), retry = await bridge.handle({ ...message, id: 4 });
  assert.equal(first.result.isError, false); assert.deepEqual(first.result.structuredContent, retry.result.structuredContent); assert.equal((await repo.read()).state.agenda.length, 1);
});
test('guia MCP de confirmação é recebido mesmo sem a skill instalada', async () => {
  const bridge = createBridge({ env: {} });
  const init = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.result.serverInfo.version, require('../plugin/zama-private/plugin.json').version);
  assert.ok(init.result.instructions.length <= 512); assert.match(init.result.instructions, /nunca confirme/); assert.match(init.result.instructions, /request_id/);
});
test('compromisso criado pelo dot gera candidato de aviso uma hora antes no helper real; agenda pausada não gera', async () => {
  const { helpers } = require('../app/assets/js/ceo-agenda');
  const repo = memory({ agendaSettings: { enabled: true, dailyEnabled: false, taskEnabled: true, leadMinutes: 15 } }), service = make(repo);
  const created = await service.call(input('create_agenda_event', { title: 'Reunião ZAMA', date: '2026-11-05', time: '10:00', reminder_minutes: 60 }));
  const state = (await repo.read()).state, at = Date.parse('2026-11-05T09:00:00-03:00');
  assert.equal(created.result.reminder.time, '09:00'); assert.equal(created.result.reminder.timezone, 'America/Sao_Paulo');
  assert.equal(helpers.remindersBetween(state, at - 60000, at + 1000).length, 1);
  assert.equal(helpers.remindersBetween(state, at - 120000, at - 1000).length, 0);
  assert.equal(state.agendaSettings.leadMinutes, 15);
  state.agendaSettings.enabled = false;
  assert.equal(helpers.remindersBetween(state, at - 60000, at + 1000).length, 0);
});
