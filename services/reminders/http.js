'use strict';
const { createClient } = require('@supabase/supabase-js');
const { configuration, publicConfiguration, allowedOrigins } = require('./config');
const { createRepository } = require('./repository');
const { ReminderError, validateSubscription, readBody } = require('./validation');
function createHandler(dependencies = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      const config = dependencies.config || configuration();
      const url = new URL(req.url, 'http://localhost');
      const path = req.query?.path || url.searchParams.get('path') || url.pathname.replace(/^\/api\/reminders\/?/, '');
      const origin = req.headers.origin;
      res.setHeader('Vary', 'Origin');
      if (origin) {
        if (!allowedOrigins(config.origin).includes(origin)) throw new ReminderError('Este endereço não está autorizado para ativar lembretes. Abra a ZAMA pelo endereço oficial e tente novamente.', 403, 'ORIGIN_NOT_ALLOWED');
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (path === 'subscription' && req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.statusCode = 204; res.end(); return;
      }
      if (path === 'config' && req.method === 'GET') return send(200, publicConfiguration(config));
      if (path !== 'subscription' || !['GET', 'POST', 'DELETE'].includes(req.method)) throw new ReminderError('Endpoint não encontrado.', 404);
      const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization || '')?.[1];
      if (!token) throw new ReminderError('Entre na sua conta para configurar lembretes.', 401);
      if (!dependencies.authenticate && (!config.supabaseUrl || !config.supabaseKey)) throw new ReminderError('Serviço de lembretes indisponível.', 503);
      const client = dependencies.client || (dependencies.authenticate ? null : createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }));
      const auth = dependencies.authenticate ? await dependencies.authenticate(token) : await client.auth.getUser(token);
      if (auth?.error || !auth?.data?.user?.id) throw new ReminderError('Sua sessão expirou. Entre novamente.', 401);
      const userId = auth.data.user.id;
      const repository = dependencies.repository || createRepository(client);
      if (req.method === 'GET') {
        const hash = url.searchParams.get('hash') || '';
        if (hash && !/^[a-f0-9]{64}$/.test(hash)) throw new ReminderError('Identificador inválido.');
        return send(200, { ...publicConfiguration(config), ...(await repository.status(userId, hash, config.keyId)) });
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ReminderError('Use application/json.', 415);
      const body = await readBody(req);
      if (req.method === 'DELETE') {
        if (!body || Object.keys(body).length !== 1 || !/^[a-f0-9]{64}$/.test(body.hash)) throw new ReminderError('Identificador inválido.');
        await repository.unsubscribe(userId, body.hash); return send(200, { removed: true });
      }
      if (!config.enabled) throw new ReminderError(publicConfiguration(config).reason, 503, 'FEATURE_DISABLED');
      if (!body || Object.keys(body).sort().join(',') !== 'keyId,subscription' || body.keyId !== config.keyId) throw new ReminderError('Atualize a página para renovar a ativação.', 409, 'KEY_CHANGED');
      await repository.subscribe(userId, validateSubscription(body.subscription), config.keyId);
      return send(200, { registered: true });
    } catch (error) {
      const known = error instanceof ReminderError;
      return send(known ? error.status : 500, { error: known ? error.message : 'Não foi possível configurar os lembretes.', code: known ? error.code : 'INTERNAL_ERROR' });
    }
  };
}
module.exports = { createHandler };
