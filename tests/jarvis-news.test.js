'use strict';
// Provider doubles only validate our protocol; production always runs web search.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { definition, schema, isNewsRequest, createNews } = require('../services/jarvis/news');
const config = { apiKey: 'private-server-key', model: 'configured-text-model', newsModel: 'configured-news-model' };
const clock = () => new Date('2026-10-02T01:30:00Z');
const userId = 'private-account-id';
const paragraph = (text = 'Notícia de hoje.', url = 'https://example.com/noticia', title = 'Fonte pública') => ({ type: 'output_text', text, annotations: [{ type: 'url_citation', start_index: 0, end_index: text.length, url, title }] });
const response = (parts = [paragraph()]) => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['internal-provider-query'] } },
  { type: 'message', role: 'assistant', content: parts }
], usage: { input_tokens: 23, output_tokens: 31 }, metadata: { private: 'must-not-return' } });
function setup(result = response(), options = {}) {
  const requests = [];
  const provider = { responses: { create: async request => { requests.push(structuredClone(request)); if (result instanceof Error) throw result; return structuredClone(result); } } };
  return { requests, get: createNews({ provider, config, userId, clock, ...options }) };
}
const unavailable = error => error.code === 'NEWS_UNAVAILABLE' && error.status === 503 && !/secret|stack|query|private/.test(error.message);

test('notícias usam apenas busca pública obrigatória, limite de calls e data de São Paulo', async () => {
  const { requests, get } = setup();
  const news = await get({ category: 'business' });
  const request = requests[0];
  assert.equal(request.model, config.newsModel); assert.equal(request.store, false);
  assert.equal(request.max_tool_calls, 2); assert.equal(request.max_output_tokens, 800); assert.equal(request.tool_choice, 'required');
  assert.deepEqual(request.tools, [{ type: 'web_search', external_web_access: true, search_context_size: 'low', user_location: { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' } }]);
  assert.match(request.input, /2026-10-01/); assert.match(request.input, /22:30/); assert.match(request.input, /economia e negócios/);
  assert.match(request.instructions, /data do acontecimento e a data da publicação/); assert.match(request.instructions, /Se não houver fontes de hoje/);
  assert.equal(request.safety_identifier, createHash('sha256').update(userId).digest('hex'));
  const sent = JSON.stringify(request); assert.ok(!sent.includes(userId)); assert.ok(!sent.includes(config.apiKey));
  assert.deepEqual(Object.keys(request).sort(), ['model', 'store', 'max_output_tokens', 'max_tool_calls', 'safety_identifier', 'tools', 'tool_choice', 'instructions', 'input'].sort());
  assert.equal(news.as_of, '2026-10-01'); assert.equal(news.searched_at, '2026-10-02T01:30:00.000Z');
  assert.deepEqual(news.usage, { input_tokens: 23, output_tokens: 31, search_calls: 1, model: config.newsModel });
  assert.ok(!JSON.stringify(news).includes('must-not-return')); assert.ok(!JSON.stringify(news).includes('internal-provider-query'));
});

test('schema não permite consulta livre, histórico, usuário ou categoria arbitrária', async () => {
  assert.equal(definition.type, 'function'); assert.equal(definition.name, 'get_daily_news'); assert.equal(definition.strict, false);
  assert.equal(definition.parameters.additionalProperties, false); assert.ok(schema.safeParse({}).success);
  const { requests, get } = setup();
  for (const invalid of [{ query: 'segredo da empresa' }, { category: 'company' }, { history: 'dados privados' }, { category: 'general', user_id: 'B' }, null, []]) {
    await assert.rejects(get(invalid), error => error.code === 'INVALID_NEWS_REQUEST');
  }
  assert.equal(requests.length, 0);
});

test('categoria padrão e modelo de texto são reutilizados, sem cache de notícias antigas', async () => {
  const { requests, get } = setup(response(), { config: { model: config.model } });
  assert.equal((await get()).category, 'general'); await get();
  assert.equal(requests.length, 2); assert.equal(requests[0].model, config.model);
});

test('citações mantêm offsets de vários blocos de texto e fontes são deduplicadas', async () => {
  const first = paragraph('Primeira notícia.');
  const second = paragraph('Segunda notícia.', 'https://example.com/segunda', 'Segunda fonte');
  const result = response([first, second, paragraph('Outra menção.')]);
  const news = await setup(result).get();
  assert.equal(news.text, 'Primeira notícia.\n\nSegunda notícia.\n\nOutra menção.');
  assert.equal(news.sources.length, 2); assert.equal(news.citations.length, 3);
  assert.equal(news.citations[1].start_index, first.text.length + 2);
  assert.equal(news.text.slice(news.citations[1].start_index, news.citations[1].end_index), second.text);
  assert.equal(news.citations[2].start_index, first.text.length + second.text.length + 4);
  assert.deepEqual(Object.keys(news.citations[0]).sort(), ['start_index', 'end_index', 'url', 'title'].sort());
});

test('citações rejeitam credenciais, esquemas executáveis, localhost e IPs privados', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,attack', 'file:///secret', 'https://user:password@example.com/path', 'http://localhost/a', 'http://sub.localhost/a', 'http://server.internal/a', 'http://127.0.0.1/a', 'http://127.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://10.0.0.1/a', 'http://169.254.169.254/a', 'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'https://exa\nmple.com/a']) {
    await assert.rejects(setup(response([paragraph('Notícia.', url)])).get(), unavailable, url);
  }
});

test('citação com índice inválido não autoriza boletim sem fontes', async () => {
  for (const values of [{ start_index: -1 }, { start_index: 1.2 }, { end_index: 200 }, { end_index: 0 }, { end_index: NaN }]) {
    const part = paragraph(); Object.assign(part.annotations[0], values);
    await assert.rejects(setup(response([part])).get(), unavailable);
  }
  const part = paragraph(); part.annotations = [{ type: 'file_citation', file_id: 'private-file' }];
  await assert.rejects(setup(response([part])).get(), unavailable);
});

test('sem busca real concluída, erro ou recusa não há notícia inventada de fallback', async () => {
  const notSearched = response(); notSearched.output.shift();
  const failed = response(); failed.output[0].status = 'failed';
  const partial = response(); partial.status = 'incomplete';
  const refusal = response([{ type: 'refusal', refusal: 'No' }]);
  const plainOnly = { output_text: 'Uma notícia sem fontes.', output: [] };
  const noCitations = response([{ type: 'output_text', text: 'Mensagem sem citação.', annotations: [] }]);
  for (const result of [notSearched, failed, partial, refusal, plainOnly, noCitations, new Error('secret API key stack')]) await assert.rejects(setup(result).get(), unavailable);
});

test('resposta e fontes são limitadas, metadados ou consumo inválido não escapam', async () => {
  const parts = Array.from({ length: 25 }, (_, i) => paragraph(`Notícia ${i}.`, `https://example.com/${i}`, 'x'.repeat(400)));
  const result = response(parts); result.usage = { input_tokens: -1, output_tokens: Infinity, secret: 'sensitive' }; result.model = 'untrusted-provider-model';
  const news = await setup(result).get();
  assert.equal(news.sources.length, 10); assert.equal(news.citations.length, 10); assert.equal(news.sources[0].title.length, 240);
  assert.deepEqual(news.usage, { input_tokens: 0, output_tokens: 0, search_calls: 1, model: config.newsModel });
  await assert.rejects(setup(response([paragraph('a'.repeat(8001))])).get(), unavailable);
});

test('detecção reconhece português e espanhol sem confundir consultas empresariais', () => {
  for (const text of ['Quais as notícias do dia?', 'Jarvis, noticias de tecnología', 'Leia as manchetes', 'Me dê o noticiário', 'Any news?', 'Titulares de hoy']) assert.ok(isNewsRequest(text), text);
  for (const text of ['Como está meu dia?', 'Quanto gastei este mês?', 'Novas tarefas de hoje', 'Agende reunião amanhã', 'Minha newsletter está pronta?']) assert.equal(isNewsRequest(text), false, text);
});
