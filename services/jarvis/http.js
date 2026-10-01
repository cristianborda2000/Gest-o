'use strict';
const { z } = require('zod');
const { createClient } = require('@supabase/supabase-js');
const { configuration, publicConfiguration } = require('./config');
const { createRepository } = require('./repository');
const { createAgent } = require('./agent');
const { createVoice } = require('./voice');
const { JarvisError } = require('./errors');
const messageSchema = z.object({ message: z.string().trim().min(1).max(4000), conversation_id: z.uuid().optional(), request_id: z.uuid() }).strict();
const credentials = /\b(sk-[\w-]{15,}|eyJ[\w-]{15,}\.[\w-]{15,}\.[\w-]+)|(?:api[_ -]?key|access_token|refresh_token|senha|password)\s*[:=]\s*\S+/i;
async function readBody(req) {
  if (req.body !== undefined) {
    if (Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) > 20000) throw new JarvisError('Mensagem muito grande.', 413);
    try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw new JarvisError('JSON inválido.'); }
  }
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 20000) throw new JarvisError('Mensagem muito grande.', 413); }
  try { return body ? JSON.parse(body) : {}; } catch { throw new JarvisError('JSON inválido.'); }
}
function createHandler(dependencies = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    try {
      const config = dependencies.config || configuration();
      const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization || '')?.[1];
      if (!token) throw new JarvisError('Entre na sua conta para usar o JARVIS.', 401, 'UNAUTHORIZED');
      const origin = req.headers.origin;
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (origin && origin !== config.origin && new URL(origin).host !== host) throw new JarvisError('Origem não autorizada.', 403, 'FORBIDDEN');
      if (!dependencies.authenticate && (!config.supabaseUrl || !config.supabaseKey)) throw new JarvisError('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no servidor.', 503, 'NOT_CONFIGURED');
      const client = dependencies.client || (dependencies.authenticate ? null : createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }));
      const auth = dependencies.authenticate ? await dependencies.authenticate(token) : await client.auth.getUser(token);
      const user = auth?.data?.user;
      if (auth?.error || !user?.id) throw new JarvisError('Sua sessão expirou. Entre novamente.', 401, 'UNAUTHORIZED');
      const url = new URL(req.url, 'http://localhost');
      const routed = req.query?.path || url.searchParams.get('path');
      let path;
      try { path = '/' + decodeURIComponent(String(routed || url.pathname.replace(/^\/api\/jarvis\/?/, ''))).replace(/^\/+|\/+$/g, ''); }
      catch { throw new JarvisError('Caminho inválido.'); }
      if (path === '/config' && req.method === 'GET') return send(200, publicConfiguration(config));
      if (!config.enabled) throw new JarvisError('JARVIS desativado no servidor.', 503, 'FEATURE_DISABLED');
      const repository = dependencies.repositoryFactory ? dependencies.repositoryFactory(user.id) : createRepository(client, user.id);
      await repository.consumeRate('all', 120, 60);
      const agent = dependencies.agentFactory ? dependencies.agentFactory(repository, config) : createAgent({ repository, config });
      if (path === '/summary' && req.method === 'GET') return send(200, { summary: await agent.summary() });
      if (path === '/conversations' && req.method === 'GET') {
        const s = await repository.read();
        return send(200, { conversations: s.jarvis.conversations.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 100) });
      }
      if (/^\/conversations\/[\w-]+$/.test(path) && req.method === 'GET') return send(200, await agent.conversation(path.split('/')[2]));
      if (path === '/memories' && req.method === 'GET') {
        if (!config.memoryEnabled) throw new JarvisError('Memória desativada.', 403);
        return send(200, { memories: (await repository.read()).jarvis.memories.filter(m => m.is_active) });
      }
      if (/^\/memories\/[\w:-]+$/.test(path) && req.method === 'DELETE') {
        if (!config.memoryEnabled) throw new JarvisError('Memória desativada.', 403);
        const memoryId = path.split('/')[2];
        return send(200, await repository.transact(s => {
          const memory = s.jarvis.memories.find(m => m.id === memoryId); if (!memory) throw new JarvisError('Memória não encontrada.', 404);
          memory.is_active = false; memory.updated_at = new Date().toISOString();
          s.jarvis.actions.push({ id: require('node:crypto').randomUUID(), tool_name: 'deactivate_memory', status: 'executed', input: { id: memoryId }, result: { deactivated: true }, requires_confirmation: false, created_at: memory.updated_at });
          return { result: { success: true } };
        }));
      }
      if (path === '/usage' && req.method === 'GET') {
        const { jarvis } = await repository.read();
        return send(200, { metrics: jarvis.metrics, voice_metrics: jarvis.voice_metrics || [], news_metrics: jarvis.news_metrics || [] });
      }
      if (req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new JarvisError('Use application/json.', 415);
        const body = await readBody(req);
        if (path === '/message') {
          const parsed = messageSchema.safeParse(body); if (!parsed.success) throw new JarvisError('Mensagem ou identificador inválido.');
          if (credentials.test(parsed.data.message)) throw new JarvisError('Remova senhas, tokens e chaves da mensagem antes de enviá-la.');
          if (!config.apiKey || !config.model) throw new JarvisError('Configure OPENAI_API_KEY e OPENAI_JARVIS_MODEL no servidor.', 503, 'NOT_CONFIGURED');
          // Persisted limits work across multiple serverless instances.
          await repository.consumeRate('message-minute', config.requestsPerMinute, 60);
          await repository.consumeRate('message-day', config.requestsPerDay, 86400);
          return send(200, await agent.send(parsed.data));
        }
        const action = /^\/actions\/([\w:-]+)\/(confirm|cancel)$/.exec(path);
        if (action) {
          const schema = action[2] === 'confirm' ? z.object({ confirmation: z.literal(true) }).strict() : z.object({}).strict();
          if (!schema.safeParse(body).success) throw new JarvisError('Confirmação explícita obrigatória.', 400, 'CONFIRMATION_REQUIRED');
          return send(200, await agent.confirm(action[1], action[2] === 'confirm'));
        }
        if (path === '/realtime/token') {
          if (!z.object({}).strict().safeParse(body).success) throw new JarvisError('A sessão de voz não aceita parâmetros do navegador.');
          const voice = createVoice({ repository, config, provider: dependencies.voiceProvider, clock: dependencies.clock });
          return send(200, await voice.issueToken());
        }
      }
      throw new JarvisError('Endpoint não encontrado.', 404, 'NOT_FOUND');
    } catch (error) {
      // Operational logs deliberately contain no token, prompt, financial data or provider body.
      const known = error instanceof JarvisError;
      console.error(JSON.stringify({ component: 'jarvis', code: known ? error.code : 'INTERNAL_ERROR', status: known ? error.status : 500, at: new Date().toISOString() }));
      return send(known ? error.status : 500, { error: known ? error.message : 'Não foi possível atender agora. Tente novamente.', code: known ? error.code : 'INTERNAL_ERROR' });
    }
  };
}
module.exports = { createHandler };
