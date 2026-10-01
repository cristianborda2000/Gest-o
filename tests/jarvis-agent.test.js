'use strict';
// Provider and transport doubles are restricted to tests. Production has no mock fallback.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { createAgent } = require('../services/jarvis/agent');
const { createHandler } = require('../services/jarvis/http');
const { empty } = require('../services/jarvis/repository');
const { configuration } = require('../services/jarvis/config');
const clock = () => new Date('2026-09-30T23:30:00-03:00');
const config = { ...configuration({}), enabled: true, memoryEnabled: true, model: 'test-model', apiKey: 'not-a-real-key', requestsPerMinute: 10, requestsPerDay: 200 };
function memoryRepository(userId = randomUUID(), initial = {}) {
  let snapshot = { jarvis: empty(), state: initial, revision: 0, stateRevision: null }, queue = Promise.resolve();
  const repo = { userId, read: async () => structuredClone(snapshot), consumeRate: async () => {}, transact(fn) {
    const run = queue.then(() => { const candidate = structuredClone(snapshot), result = fn(candidate); if (!result?.unchanged) { candidate.revision++; if (result?.writeState) candidate.stateRevision = String(candidate.revision); else candidate.state = snapshot.state; snapshot = candidate; } return structuredClone(result?.result); });
    queue = run.catch(() => {}); return run;
  } };
  return repo;
}
function provider(calls, answer = 'Concluído conforme as ferramentas.') {
  const requests = []; let n = 0;
  return { requests, responses: { create: async input => {
    requests.push(structuredClone(input));
    const call = calls[n++];
    return call ? { output: [{ type: 'function_call', call_id: `call-${n}`, name: call.name, arguments: JSON.stringify(call.args || {}) }], usage: { input_tokens: 15, output_tokens: 8 } } : { output: [], output_text: typeof answer === 'function' ? answer(input) : answer, usage: { input_tokens: 20, output_tokens: 10 } };
  } } };
}
const send = (agent, message) => agent.send({ message, request_id: randomUUID() });
test('Quanto gastei este mês consulta ledger real, ignora cancelados e não soma investimento duas vezes', async () => {
  const repo = memoryRepository(undefined, { financeiro: [
    { id: 'a', nome: 'Marketing', tipo: 'Saída', valor: -350, status: 'Pago', pagoEm: '2026-09-30', investmentId: 'inv' },
    { id: 'b', valor: -100, tipo: 'Saída', status: 'Cancelado', prazo: '2026-09-30' },
    { id: 'c', valor: 1000, tipo: 'Entrada', status: 'Pago', pagoEm: '2026-09-20' }
  ], investimentos: [{ id: 'inv', status: 'Realizado', valor: 350, data: '2026-09-30' }] });
  const ai = provider([{ name: 'get_financial_summary', args: { period: 'current_month' } }], input => {
    const output = JSON.parse(input.input.find(m => m.type === 'function_call_output').output);
    assert.equal(output.result.expenses_cents, 35000); assert.equal(output.result.balance_cents, 65000);
    return `Você gastou ${output.result.expenses} em setembro.`;
  });
  const response = await send(createAgent({ repository: repo, config, provider: ai, clock }), 'Quanto gastei este mês?');
  assert.match(response.messages.at(-1).content, /350,00/);
  assert.equal(ai.requests[0].tool_choice.name, 'get_financial_summary');
  assert.equal(response.actions[0].tool_name, 'get_financial_summary');
  assert.equal((await repo.read()).jarvis.metrics[0].requests, 1);
});
test('criar tarefa amanhã às 9 grava no usuário correto e datas SP, ideia fica no módulo existente', async () => {
  const repo = memoryRepository('account-A', { agenda: [], ideias: [], clientes: [{ id: 'legacy' }] });
  const ai = provider([{ name: 'create_task', args: { title: 'Finalizar proposta', date: 'amanhã', time: '09:00' } }]);
  await send(createAgent({ repository: repo, config, provider: ai, clock }), 'Crie uma tarefa para amanhã às 9 para finalizar proposta.');
  const state = (await repo.read()).state;
  assert.equal(state.agenda[0].prazo, '2026-10-01'); assert.equal(state.agenda[0].hora, '09:00'); assert.ok(state.agenda[0].jarvisActionId); assert.equal(state.clientes[0].id, 'legacy');
  const ideas = provider([{ name: 'save_idea', args: { title: 'Criar programa de indicação' } }]);
  await send(createAgent({ repository: repo, config, provider: ideas, clock }), 'Salve a ideia de criar um programa de indicação.');
  assert.equal((await repo.read()).state.ideias[0].titulo, 'Criar programa de indicação');
});
test('R$350 pendente, confirmação explícita única, retries e concorrência não duplicam', async () => {
  const repo = memoryRepository(), ai = provider([{ name: 'register_expense', args: { amount: 350, category: 'Marketing', description: 'Anúncios' } }]);
  const agent = createAgent({ repository: repo, config, provider: ai, clock });
  const body = { message: 'Registra R$350 de marketing.', request_id: randomUUID() };
  const response = await agent.send(body), action = response.actions[0];
  assert.equal(action.status, 'pending'); assert.equal((await repo.read()).state.financeiro, undefined);
  assert.equal(action.input.date, '2026-09-30');
  await Promise.all([agent.confirm(action.id, true), agent.confirm(action.id, true)]);
  await agent.confirm(action.id, true); await agent.send(body);
  const saved = await repo.read();
  assert.equal(saved.state.financeiro.length, 1); assert.equal(saved.state.financeiro[0].valor, -350);
  assert.equal(saved.jarvis.actions.length, 1); assert.ok(saved.jarvis.actions[0].confirmed_at);
  assert.equal(saved.jarvis.requests.length, 1); assert.equal(ai.requests.length, 1);
  await assert.rejects(agent.send({ ...body, message: 'Outro pedido' }), /identificador/);
});
test('cancelamento é permanente para aquela ação e confirmação não a executa', async () => {
  const repo = memoryRepository(), agent = createAgent({ repository: repo, config, clock, provider: provider([{ name: 'register_income', args: { amount: 2000, category: 'Receita', description: 'Catálogo' } }]) });
  const response = await send(agent, 'Registra entrada de 2000 pelo catálogo.');
  await agent.confirm(response.actions[0].id, false); await agent.confirm(response.actions[0].id, true);
  assert.equal((await repo.read()).state.financeiro, undefined); assert.equal((await repo.read()).jarvis.actions[0].status, 'cancelled');
});
test('modelo repetindo a mesma escrita na execução não duplica tarefa', async () => {
  const repo = memoryRepository(), call = { name: 'create_task', args: { title: 'Planejar', date: 'amanhã' } };
  const agent = createAgent({ repository: repo, config, clock, provider: provider([call, call]) });
  const response = await send(agent, 'Crie a tarefa de planejar amanhã e consulte minha agenda.');
  assert.equal(response.actions.length, 1);
  assert.equal((await repo.read()).state.agenda.length, 1);
});
test('editar tarefa exige consulta nesta execução e respeita data relativa da ocorrência', async () => {
  const repo = memoryRepository('A', { agenda: [{ id: 'task', nome: 'Proposta', prazo: '2026-09-30', hora: '09:00', duracao: 30, status: 'Pendente', recorrencia: 'daily' }] });
  const call = { name: 'complete_task', args: { id: 'task', occurrence_date: 'hoje' } };
  const rejected = await send(createAgent({ repository: repo, config, clock, provider: provider([call]) }), 'Marca a proposta como concluída.');
  assert.equal(rejected.actions[0].status, 'failed');
  const response = await send(createAgent({ repository: repo, config, clock, provider: provider([{ name: 'list_tasks' }, call]) }), 'Marca a proposta como concluída.');
  assert.equal(response.actions[1].status, 'executed');
  assert.equal((await repo.read()).state.agenda[0].exceptions['2026-09-30'].status, 'Concluído');
});
test('histórico persiste após instanciar agente e usuário B não acessa conversa/ação A', async () => {
  const repoA = memoryRepository('A'), agentA = createAgent({ repository: repoA, config, clock, provider: provider([{ name: 'register_expense', args: { amount: 350, category: 'Marketing', description: 'Anúncios' } }]) });
  const created = await send(agentA, 'Registra 350 de marketing.');
  const reloaded = createAgent({ repository: repoA, config, clock, provider: provider([]) });
  assert.equal((await reloaded.conversation(created.conversation.id)).messages.length, 2);
  const repoB = memoryRepository('B'), b = createAgent({ repository: repoB, config, clock, provider: provider([]) });
  await assert.rejects(b.conversation(created.conversation.id), e => e.status === 404);
  await assert.rejects(b.confirm(created.actions[0].id, true), e => e.status === 404);
  await assert.rejects(b.send({ message: 'Leia a conversa', conversation_id: created.conversation.id, request_id: randomUUID() }), e => e.status === 404);
});
test('tool desconhecida, user_id injetado, write sem pedido e SQL são negados e auditados', async () => {
  for (const call of [
    { name: '__proto__', args: {} }, { name: 'run_sql', args: { sql: 'select * from app_state' } },
    { name: 'create_task', args: { title: 'Injetada', date: 'hoje', user_id: 'B' } },
    { name: 'create_task', args: { title: 'Injetada', date: 'hoje' } }
  ]) {
    const repo = memoryRepository(), agent = createAgent({ repository: repo, config, clock, provider: provider([call]) });
    const response = await send(agent, 'Como está meu dia?');
    assert.equal(response.actions[0].status, 'failed'); assert.deepEqual((await repo.read()).state, {});
  }
});
test('memória exige pedido explícito, flag e nunca substitui financeiro', async () => {
  const args = { content: 'Objetivo de outubro é melhorar o onboarding', scope: 'company', category: 'goal' };
  const repo = memoryRepository();
  await send(createAgent({ repository: repo, config, clock, provider: provider([{ name: 'save_memory', args }]) }), 'Como está meu dia?');
  assert.equal((await repo.read()).jarvis.memories.length, 0);
  await send(createAgent({ repository: repo, config, clock, provider: provider([{ name: 'save_memory', args }]) }), 'Jarvis, lembra que o objetivo de outubro é melhorar o onboarding.');
  assert.equal((await repo.read()).jarvis.memories.length, 1);
  assert.deepEqual((await repo.read()).state, {});
});
test('falha da API preserva efeitos já gravados sem retry duplicado', async () => {
  const repo = memoryRepository(), ai = provider([{ name: 'create_task', args: { title: 'Uma tarefa', date: 'amanhã' } }]);
  const original = ai.responses.create; let requests = 0;
  ai.responses.create = async input => { if (requests++) throw new Error('provider outage with sensitive body'); return original(input); };
  const agent = createAgent({ repository: repo, config, clock, provider: ai });
  const body = { message: 'Crie uma tarefa amanhã e consulte minha agenda.', request_id: randomUUID() };
  const response = await agent.send(body); assert.equal(response.messages.at(-1).metadata.error, true);
  await agent.send(body); assert.equal((await repo.read()).state.agenda.length, 1);
  assert.ok(!JSON.stringify(await repo.read()).includes('sensitive body'));
});
test('orquestrador limita chamadas mesmo se o provedor insistir em tools após o teto', async () => {
  const repo = memoryRepository(), ai = provider(Array.from({ length: 9 }, () => ({ name: 'get_financial_summary' })));
  const agent = createAgent({ repository: repo, config: { ...config, maxTools: 2 }, clock, provider: ai });
  const response = await send(agent, 'Quanto gastei este mês?');
  assert.equal(response.actions.length, 2);
  assert.equal(ai.requests.length, 5);
  assert.equal(ai.requests.at(-1).tool_choice, 'none');
});
async function request(handler, url, method = 'GET', body, token = 'userA') {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.url = `/api/jarvis${url}`; req.method = method; req.headers = { host: 'localhost:5174', origin: 'http://localhost:5174', ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' };
  let value; const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, end(text) { value = JSON.parse(text); } };
  await handler(req, res); return { status: res.statusCode, body: value, headers: res.headers };
}
test('HTTP deriva conta do JWT validado, rejeita user_id e confirmação ambígua, protege todos endpoints', async () => {
  const repos = { userA: memoryRepository('A'), userB: memoryRepository('B') };
  const handler = createHandler({ config, authenticate: async token => ({ data: { user: repos[token] ? { id: token } : null } }), repositoryFactory: id => repos[id], agentFactory: repo => createAgent({ repository: repo, config, clock, provider: provider([]) }) });
  for (const endpoint of ['/config', '/summary', '/conversations', '/memories', '/realtime/token']) assert.equal((await request(handler, endpoint, endpoint.includes('token') ? 'POST' : 'GET', {}, '')).status, 401);
  assert.equal((await request(handler, '/message', 'POST', { message: 'oi', request_id: randomUUID(), user_id: 'B' })).status, 400);
  assert.equal((await request(handler, '/actions/fake/confirm', 'POST', { confirmation: 'sim' })).status, 400);
  assert.equal((await request(handler, '/actions/fake/confirm', 'POST', { confirmation: true })).status, 404);
  assert.equal((await request(handler, '/message', 'POST', { message: 'senha=supersecret', request_id: randomUUID() })).status, 400);
  const response = await request(handler, '/config'); assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.ok(!JSON.stringify(response.body).includes('not-a-real-key'));
});
test('frontend não contém variáveis de secrets ou importação do SDK OpenAI', () => {
  const files = fs.readdirSync('app/assets/js').filter(f => f.endsWith('.js'));
  for (const file of files) {
    const source = fs.readFileSync(path.join('app/assets/js', file), 'utf8');
    assert.doesNotMatch(source, /OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|require\(['"]openai/);
  }
});
test('HTTP accepts URL-encoded action IDs from the actual frontend and confirms once', async () => {
  const repo = memoryRepository('A');
  const ai = provider([{ name: 'register_expense', args: { amount: 350, category: 'Marketing', description: 'Anúncios' } }]);
  const agent = createAgent({ repository: repo, config, provider: ai, clock });
  const handler = createHandler({ config, authenticate: async () => ({ data: { user: { id: 'A' } } }), repositoryFactory: () => repo, agentFactory: () => agent });
  const response = await request(handler, '/message', 'POST', { message: 'Registra R$350 de marketing.', request_id: randomUUID() });
  assert.equal(response.status, 200);
  const actionId = response.body.actions[0].id;
  assert.match(actionId, /:0$/);
  const endpoint = `/actions/${encodeURIComponent(actionId)}/confirm`;
  assert.equal((await request(handler, endpoint, 'POST', { confirmation: true })).status, 200);
  assert.equal((await request(handler, endpoint, 'POST', { confirmation: true })).status, 200);
  assert.equal((await repo.read()).state.financeiro.length, 1);
});
module.exports = { memoryRepository, provider };

test('agendamento natural PT/ES grava e responde com recibo real em uma chamada', async () => {
  for (const phrase of ['Coloca na agenda amanhã às 9: ligar para fornecedor.', 'Jarvis, marca uma reunião amanhã às 9 com fornecedor.', 'Me lembra amanhã às 9 de ligar para fornecedor.', 'Recuérdame mañana a las 9 llamar al proveedor.']) {
    const repo = memoryRepository('A'), ai = provider([{ name: 'create_task', args: { title: 'Ligar para fornecedor', date: 'amanhã', time: '09:00' } }]);
    const body = { message: phrase, request_id: randomUUID() }, agent = createAgent({ repository: repo, config, clock, provider: ai });
    const reply = await agent.send(body);
    assert.equal(reply.actions[0].status, 'executed'); assert.match(reply.messages.at(-1).content, /01\/10\/2026 às 09:00/);
    assert.equal(ai.requests.length, 1); await agent.send(body);
    assert.equal((await repo.read()).state.agenda.length, 1); assert.equal(ai.requests.length, 1);
  }
});

test('detalhe após pergunta completa somente o pedido recente; sim e cancelamento não criam', async () => {
  for (const detail of ['amanhã às 9', 'sim', 'cancele', 'quanto gastei?']) {
    const repo = memoryRepository('A');
    const first = await send(createAgent({ repository: repo, config, clock, provider: provider([], 'Para qual dia e horário devo agendar a ligação ao fornecedor?') }), 'Coloque na agenda ligar ao fornecedor');
    assert.ok(first.messages.at(-1).metadata.pending_write);
    const ai = provider([{ name: 'create_task', args: { title: 'Ligar ao fornecedor', date: 'amanhã', time: '09:00' } }]);
    const result = await createAgent({ repository: repo, config, clock, provider: ai }).send({ message: detail, conversation_id: first.conversation.id, request_id: randomUUID() });
    assert.equal(result.actions[0].status, detail === 'amanhã às 9' ? 'executed' : 'failed');
    assert.equal((await repo.read()).state.agenda?.length || 0, detail === 'amanhã às 9' ? 1 : 0);
  }
});

test('pergunta educativa e negação não autorizam escrita e promessa sem ferramenta é corrigida', async () => {
  for (const phrase of ['Como criar uma tarefa?', 'Não crie uma tarefa amanhã.']) {
    const repo = memoryRepository();
    const reply = await send(createAgent({ repository: repo, config, clock, provider: provider([{ name: 'create_task', args: { title: 'Não autorizada', date: 'amanhã' } }]) }), phrase);
    assert.equal(reply.actions[0].status, 'failed'); assert.equal((await repo.read()).state.agenda, undefined);
  }
  const repo = memoryRepository();
  const reply = await send(createAgent({ repository: repo, config, clock, provider: provider([], 'Pronto, agendado!') }), 'Marque uma reunião amanhã');
  assert.match(reply.messages.at(-1).content, /Ainda não gravei/); assert.equal((await repo.read()).state.agenda, undefined);
});

test('notícias usam busca separada sem histórico privado, persistem fontes e retry não repete busca', async () => {
  const repo = memoryRepository('A', { financeiro: [{ nome: 'SEGREDO_EMPRESARIAL', valor: 200 }] });
  const bulletin = 'Notícia verificada em 30/09/2026.';
  const calls = [];
  const ai = { responses: { create: async body => {
    calls.push(structuredClone(body));
    if (body.tools.some(t => t.type === 'web_search')) return { status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: bulletin, annotations: [{ type: 'url_citation', start_index: 0, end_index: bulletin.length, url: 'https://agenciabrasil.ebc.com.br/noticia', title: 'Fonte de teste' }] }] }], usage: { input_tokens: 40, output_tokens: 20 } };
    return { output: [{ type: 'function_call', name: 'get_daily_news', arguments: '{"category":"technology"}', call_id: 'news' }] };
  } } };
  const agent = createAgent({ repository: repo, config, provider: ai, clock }), body = { message: 'Quais as notícias de tecnologia de hoje?', request_id: randomUUID() };
  const result = await agent.send(body), last = result.messages.at(-1);
  assert.equal(last.content, bulletin); assert.equal(last.metadata.news.sources[0].title, 'Fonte de teste');
  assert.equal(calls.length, 2); assert.doesNotMatch(JSON.stringify(calls[1]), /SEGREDO_EMPRESARIAL/);
  assert.equal(typeof calls[1].input, 'string'); assert.equal(calls[1].tools.length, 1);
  await agent.send(body); assert.equal(calls.length, 2);
  assert.deepEqual((await agent.conversation(result.conversation.id)).messages.at(-1).metadata, last.metadata);
  assert.equal((await repo.read()).jarvis.news_metrics[0].search_calls, 1);
  assert.equal(result.state_changed, false);
});

test('notícias desativadas ou falha de busca não geram manchetes inventadas', async () => {
  for (const enabled of [false, true]) {
    const repo = memoryRepository(), ai = provider([{ name: 'get_daily_news', args: {} }], 'Notícia inventada');
    const result = await send(createAgent({ repository: repo, config: { ...config, newsEnabled: enabled }, provider: ai, clock }), 'Notícias de hoje');
    assert.equal(result.actions[0].status, 'failed'); assert.doesNotMatch(result.messages.at(-1).content, /Notícia inventada/);
    assert.equal(result.messages.at(-1).metadata.news, undefined);
    if (!enabled) assert.ok(!ai.requests[0].tools.some(t => t.name === 'get_daily_news'));
  }
});
