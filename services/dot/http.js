'use strict';
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');
const { createRepository } = require('../jarvis/repository');
const { JarvisError } = require('../jarvis/errors');
const { readJsonBody } = require('../http/read-json-body');
const { createService } = require('./service');
function configuration(env = process.env) {
  return { enabled: env.DOT_ENABLED === 'true', ownerId: env.DOT_OWNER_ID || '', origin: env.APP_ORIGIN || '', supabaseUrl: env.SUPABASE_URL || '', supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '' };
}
function createHandler(deps = {}) {
  return async (req, res) => {
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const config = deps.config || configuration();
      if (!config.enabled) throw new JarvisError('Integração dot desativada.', 503, 'DOT_DISABLED');
      if (!z.uuid().safeParse(config.ownerId).success || !config.origin || new URL(config.origin).origin !== config.origin) throw new JarvisError('Configuração dot incompleta.', 503, 'DOT_NOT_CONFIGURED');
      if (req.headers.origin && req.headers.origin !== config.origin) throw new JarvisError('Origem não autorizada.', 403, 'FORBIDDEN');
      const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization || '')?.[1];
      if (!token) throw new JarvisError('Entre na sua conta ZAMA.', 401, 'UNAUTHORIZED');
      const client = deps.client || (!deps.authenticate ? createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null);
      const auth = await (deps.authenticate ? deps.authenticate(token) : client.auth.getUser(token));
      if (auth.error || !auth.data?.user?.id) throw new JarvisError('Sessão inválida ou expirada.', 401, 'UNAUTHORIZED');
      if (auth.data.user.id !== config.ownerId) throw new JarvisError('Acesso restrito ao proprietário configurado.', 403, 'DOT_OWNER_ONLY');
      const repository = deps.repositoryFactory ? deps.repositoryFactory(auth.data.user.id) : createRepository(client, auth.data.user.id);
      await repository.consumeRate('dot', 60, 60);
      const service = createService({ repository, ownerId: config.ownerId, origin: config.origin, clock: deps.clock });
      const url = new URL(req.url, config.origin), operation = url.searchParams.get('operation') || 'call';
      if (operation === 'preview' && req.method === 'GET') return send(200, await service.preview(z.uuid().parse(url.searchParams.get('action'))));
      if (req.method !== 'POST') throw new JarvisError('Método não permitido.', 405);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new JarvisError('Use application/json.', 415);
      const body = await readJsonBody(req, { maxBytes: 20000, tooLarge: () => new JarvisError('Pedido muito grande.', 413), invalidJson: () => new JarvisError('JSON inválido.') });
      if (operation === 'call') return send(200, await service.call(body));
      if (operation === 'decide') {
        // No MCP tool exposes this endpoint. Browser requests must be same-origin.
        if (req.headers.origin !== config.origin) throw new JarvisError('Confirme na tela ZAMA.', 403, 'DOT_CONFIRM_ON_WEB');
        return send(200, await service.decide(z.uuid().parse(url.searchParams.get('action')), body));
      }
      throw new JarvisError('Operação não encontrada.', 404);
    } catch (error) {
      if (error instanceof JarvisError) return send(error.status, { error: error.message, code: error.code });
      if (error instanceof z.ZodError) return send(400, { error: 'Identificador inválido.', code: 'DOT_INVALID' });
      return send(500, { error: 'Não foi possível concluir. Reutilize o request_id ao tentar novamente.', code: 'DOT_INTERNAL' });
    }
  };
}
module.exports = { createHandler, configuration };
