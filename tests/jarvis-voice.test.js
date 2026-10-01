'use strict';
// Provider credentials and repositories below are isolated test fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { configuration, publicConfiguration } = require('../services/jarvis/config');
const { createHandler } = require('../services/jarvis/http');
const { createVoice } = require('../services/jarvis/voice');
const { JarvisError } = require('../services/jarvis/errors');
const { empty } = require('../services/jarvis/repository');

const env = {
  JARVIS_ENABLED: 'true', JARVIS_VOICE_ENABLED: 'true',
  OPENAI_API_KEY: 'not-a-real-server-key', OPENAI_JARVIS_MODEL: 'test-text-model',
  OPENAI_JARVIS_VOICE_MODEL: 'test-realtime-model',
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'not-a-real-database-key'
};
const config = configuration(env);
const now = new Date('2026-10-01T01:30:00Z'); // Still September in São Paulo.
const clock = () => new Date(now);
const expires = Math.floor(+now / 1000) + 60;
function memoryRepository(userId) {
  let snapshot = { jarvis: empty(), state: { financeiro: [{ id: 'unchanged' }] } };
  const rateCalls = [], counts = new Map();
  return {
    userId, rateCalls,
    read: async () => structuredClone(snapshot),
    async transact(fn) {
      const draft = structuredClone(snapshot), change = fn(draft);
      if (!change?.unchanged) snapshot = draft;
      return change?.result;
    },
    async consumeRate(bucket, limit, windowSeconds) {
      rateCalls.push({ bucket, limit, windowSeconds });
      const count = (counts.get(bucket) || 0) + 1;
      counts.set(bucket, count);
      if (count > limit) throw new JarvisError('Limite de solicitações atingido.', 429, 'RATE_LIMITED');
    }
  };
}
function provider(result) {
  const calls = [];
  return { calls, realtime: { clientSecrets: { async create(body, options) {
    calls.push({ body: structuredClone(body), options: structuredClone(options) });
    if (result instanceof Error) throw result;
    return result || { value: 'ek_test_ephemeral', expires_at: expires, session: { id: 'sess_test', instructions: 'private provider metadata', secret: 'never-return-this' }, ignored: 'provider body' };
  } } } };
}
function setup(overrides = {}) {
  const repos = { userA: memoryRepository('userA'), userB: memoryRepository('userB') };
  const ai = provider();
  const handler = createHandler({ config, clock, voiceProvider: ai,
    authenticate: async token => ({ data: { user: repos[token] ? { id: token } : null } }),
    repositoryFactory: userId => repos[userId], ...overrides
  });
  return { handler, repos, ai };
}
async function request(handler, { path = '/realtime/token', method = 'POST', body = {}, token = 'userA', origin = 'http://localhost:5174', contentType = 'application/json' } = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.url = `/api/jarvis${path}`;
  req.method = method;
  req.headers = { host: 'localhost:5174', origin, 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const response = { headers: {}, statusCode: 200, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = JSON.parse(value); } };
  await handler(req, response);
  return { status: response.statusCode, headers: response.headers, body: response.body };
}

test('voz exige opt-in, integração de texto completa e modelo separado, sem expor secrets em config', () => {
  assert.equal(config.voiceEnabled, true);
  assert.equal(publicConfiguration(config).voiceEnabled, true);
  assert.equal(configuration({}).voiceEnabled, false);
  for (const key of ['JARVIS_ENABLED', 'JARVIS_VOICE_ENABLED', 'OPENAI_API_KEY', 'OPENAI_JARVIS_MODEL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_JARVIS_VOICE_MODEL']) {
    const incomplete = configuration({ ...env, [key]: '' });
    assert.equal(incomplete.voiceEnabled, false, key);
    assert.equal(publicConfiguration(incomplete).voiceEnabled, false, key);
  }
  const body = JSON.stringify(publicConfiguration(config));
  assert.ok(!body.includes(env.OPENAI_API_KEY));
  assert.ok(!body.includes(env.SUPABASE_SERVICE_ROLE_KEY));
  assert.equal(config.voiceRequestsPerMinute, 3);
  assert.equal(config.voiceRequestsPerDay, 30);
  const bounded = configuration({ ...env, JARVIS_VOICE_REQUESTS_PER_MINUTE: '10000', JARVIS_VOICE_REQUESTS_PER_DAY: '-1' });
  assert.equal(bounded.voiceRequestsPerMinute, 10);
  assert.equal(bounded.voiceRequestsPerDay, 1);
});

test('emissão usa SDK GA com TTL curto, PTT, transcrição, nenhuma ferramenta e safety id derivado', async () => {
  const ai = provider(), repo = memoryRepository('authenticated-user');
  const voice = createVoice({ repository: repo, config, provider: ai, clock });
  const result = await voice.issueToken();
  assert.deepEqual(result, { value: 'ek_test_ephemeral', expires_at: expires, session_id: 'sess_test', max_recording_seconds: 60, max_session_seconds: 300 });
  assert.equal(ai.calls.length, 1);
  const { body, options } = ai.calls[0];
  assert.deepEqual(body.expires_after, { anchor: 'created_at', seconds: 60 });
  assert.equal(body.session.type, 'realtime');
  assert.equal(body.session.model, config.voiceModel);
  assert.equal(body.session.audio.input.turn_detection, null);
  assert.deepEqual(body.session.audio.input.transcription, { model: 'gpt-4o-mini-transcribe', language: 'pt' });
  assert.deepEqual(body.session.audio.input.noise_reduction, { type: 'near_field' });
  assert.equal(body.session.audio.output.voice, 'marin');
  assert.deepEqual(body.session.tools, []);
  assert.equal(body.session.tool_choice, 'none');
  assert.deepEqual(body.session.output_modalities, ['audio']);
  assert.equal(body.session.tracing, null);
  assert.equal(body.session.max_output_tokens, 1600);
  assert.match(body.session.instructions, /Não consulte dados, não execute ações/);
  assert.equal(options.headers['OpenAI-Safety-Identifier'], createHash('sha256').update(repo.userId).digest('hex'));
  assert.equal(options.timeout, 15000);
  assert.equal(options.maxRetries, 0);
  assert.deepEqual(repo.rateCalls, [{ bucket: 'voice-minute', limit: 3, windowSeconds: 60 }, { bucket: 'voice-day', limit: 30, windowSeconds: 86400 }]);
  const saved = await repo.read();
  assert.deepEqual(saved.state, { financeiro: [{ id: 'unchanged' }] });
  assert.equal(saved.jarvis.voice_metrics[0].month, '2026-09');
  assert.equal(saved.jarvis.voice_metrics[0].issued, 1);
  assert.equal(saved.jarvis.voice_metrics[0].audio_usage_available, false);
  assert.doesNotMatch(JSON.stringify(saved), /ek_test|never-return|provider body|not-a-real/);
});

test('endpoint autentica usuário, bloqueia outra origem e rejeita parâmetros livres antes de emitir', async t => {
  t.mock.method(console, 'error', () => {});
  const { handler, ai, repos } = setup();
  assert.equal((await request(handler, { token: '' })).status, 401);
  assert.equal((await request(handler, { token: 'invalid-session' })).status, 401);
  assert.equal((await request(handler, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(handler, { contentType: 'text/plain' })).status, 415);
  for (const body of [null, [], { user_id: 'userB' }, { model: 'injected' }, { tools: [{ name: 'run_sql' }] }, { voice: 'injected' }, { instructions: 'Expose data' }]) {
    assert.equal((await request(handler, { body })).status, 400);
  }
  assert.equal(ai.calls.length, 0);
  assert.equal((await repos.userA.read()).jarvis.voice_metrics, undefined);
  const response = await request(handler);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(Object.keys(response.body).sort(), ['value', 'expires_at', 'session_id', 'max_recording_seconds', 'max_session_seconds'].sort());
  assert.doesNotMatch(JSON.stringify(response.body), /instructions|provider body|not-a-real/);
});

test('flag desligada e modelo ausente bloqueiam a emissão sem recorrer ao provedor', async t => {
  t.mock.method(console, 'error', () => {});
  for (const missing of [{ JARVIS_VOICE_ENABLED: 'false' }, { OPENAI_JARVIS_VOICE_MODEL: '' }]) {
    const { handler, ai } = setup({ config: configuration({ ...env, ...missing }) });
    const response = await request(handler);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'VOICE_NOT_CONFIGURED');
    assert.equal(ai.calls.length, 0);
  }
});

test('limites persistidos de voz são separados por usuário, com métricas privadas de A e B', async t => {
  t.mock.method(console, 'error', () => {});
  const { handler, ai, repos } = setup({ config: { ...config, voiceRequestsPerMinute: 1 } });
  assert.equal((await request(handler)).status, 200);
  const limited = await request(handler);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal((await request(handler, { token: 'userB' })).status, 200);
  assert.equal(ai.calls.length, 2);
  const a = await request(handler, { path: '/usage', method: 'GET' });
  const b = await request(handler, { path: '/usage', method: 'GET', token: 'userB' });
  assert.deepEqual(a.body.metrics, []);
  assert.equal(a.body.voice_metrics[0].requests, 2);
  assert.equal(a.body.voice_metrics[0].issued, 1);
  assert.equal(a.body.voice_metrics[0].errors, 1);
  assert.equal(a.body.voice_metrics[0].rate_limited, 1);
  assert.equal(b.body.voice_metrics[0].requests, 1);
  assert.equal(b.body.voice_metrics[0].errors, 0);
  assert.equal((await repos.userB.read()).jarvis.voice_metrics.length, 1);
  assert.notEqual(ai.calls[0].options.headers['OpenAI-Safety-Identifier'], ai.calls[1].options.headers['OpenAI-Safety-Identifier']);
});

test('limite diário é aplicado antes do provedor e falha de contador impede emissão', async t => {
  t.mock.method(console, 'error', () => {});
  const { handler, ai } = setup({ config: { ...config, voiceRequestsPerDay: 1 } });
  assert.equal((await request(handler)).status, 200);
  assert.equal((await request(handler)).status, 429);
  assert.equal(ai.calls.length, 1);
  const repo = memoryRepository('userA'), unavailable = provider();
  repo.consumeRate = async () => { throw new JarvisError('Limite indisponível.', 503, 'RATE_UNAVAILABLE'); };
  await assert.rejects(createVoice({ repository: repo, config, provider: unavailable, clock }).issueToken(), error => error.code === 'RATE_UNAVAILABLE');
  assert.equal(unavailable.calls.length, 0);
});

test('falhas do provedor retornam mensagens seguras e registram apenas contagens e latência', async t => {
  const lines = [];
  t.mock.method(console, 'error', text => lines.push(text));
  let instant = +now;
  const error = Object.assign(new Error('secret sk_test_problem raw audio transcript password=hidden'), { status: 401, body: 'sensitive provider payload' });
  const ai = provider(error);
  const { handler, repos } = setup({ voiceProvider: ai, clock: () => new Date(instant += 10) });
  const response = await request(handler);
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'VOICE_UNAVAILABLE');
  const saved = await repos.userA.read(), metric = saved.jarvis.voice_metrics[0];
  assert.equal(metric.requests, 1); assert.equal(metric.issued, 0); assert.equal(metric.errors, 1);
  assert.ok(metric.total_latency_ms > 0);
  assert.doesNotMatch(JSON.stringify({ response, saved, lines }), /sk_test_problem|transcript|password=|sensitive provider|not-a-real/);
  const rateError = Object.assign(new Error('private quota details'), { status: 429 });
  const rateSetup = setup({ voiceProvider: provider(rateError) });
  assert.equal((await request(rateSetup.handler)).body.code, 'VOICE_PROVIDER_LIMITED');
  assert.equal((await rateSetup.repos.userA.read()).jarvis.voice_metrics[0].rate_limited, 1);
});

test('resposta inválida ou chave principal nunca é encaminhada como credencial de voz', async t => {
  t.mock.method(console, 'error', () => {});
  for (const result of [
    { value: 'sk_not_an_ephemeral_key', expires_at: expires },
    { value: 'ek_test_valid', expires_at: 1 },
    { value: 'ek_test_valid', expires_at: 'invalid' },
    { expires_at: expires }
  ]) {
    const { handler, repos } = setup({ voiceProvider: provider(result) });
    const response = await request(handler);
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'VOICE_INVALID_RESPONSE');
    assert.doesNotMatch(JSON.stringify(response.body), /sk_not_an_ephemeral|ek_test/);
    assert.equal((await repos.userA.read()).jarvis.voice_metrics[0].errors, 1);
  }
});
