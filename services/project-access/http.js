'use strict';
const { createClient } = require('@supabase/supabase-js');
const { configuration, emailHash, allowedOrigins } = require('./config');
const { readJsonBody } = require('../http/read-json-body');

class AccessError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
async function readBody(req) {
  return readJsonBody(req, { maxBytes: 2048,
    tooLarge: () => new AccessError('Solicitação muito grande.', 413),
    invalidJson: () => new AccessError('Solicitação inválida.') });
}
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'email,password') throw new AccessError('Informe somente o e-mail e a senha do novo acesso.');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(email)) throw new AccessError('Informe um e-mail válido.');
  if (typeof body.password !== 'string' || body.password.length < 10 || Buffer.byteLength(body.password) > 72 || !body.password.trim() || body.password.includes('\0')) throw new AccessError('Use uma senha com pelo menos 10 caracteres e no máximo 72 bytes.', 400, 'INVALID_PASSWORD');
  return { email, password: body.password };
}
function inviteError(error) {
  if (/Limite de convites/.test(error?.message || '')) return new AccessError('Limite de cadastros atingido. Tente novamente mais tarde.', 429, 'RATE_LIMITED');
  if (/PGRST202|42883/.test(error?.code || '')) return new AccessError('A configuração de Projetos no banco ainda precisa ser concluída.', 503, 'PROJECT_UNAVAILABLE');
  if (/Salve os dados/.test(error?.message || '')) return new AccessError('Salve os dados da sua empresa antes de criar um acesso.');
  return new AccessError('Não foi possível autorizar o cadastro. Atualize a página e tente novamente.', 403, 'FORBIDDEN');
}
function accountError(error) {
  if (['email_exists', 'user_already_exists'].includes(error?.code) || /already (?:been )?registered|already exists/i.test(error?.message || '')) return new AccessError('Este e-mail já possui uma conta. A senha existente não foi alterada. Gere um novo convite para vincular essa conta.', 409, 'ACCOUNT_EXISTS');
  if (['weak_password', 'validation_failed'].includes(error?.code)) return new AccessError('A senha não atende aos requisitos do cadastro. Use uma senha mais forte.', 400, 'INVALID_PASSWORD');
  return new AccessError('Não foi possível confirmar a criação da conta. Confira os usuários no Supabase antes de tentar novamente.', 503, 'ACCOUNT_SETUP_INCOMPLETE');
}
function createHandler(dependencies = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Vary', 'Origin');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      const config = dependencies.config || configuration();
      const origin = req.headers.origin;
      if (origin) {
        if (!allowedOrigins(config.origin).includes(origin)) throw new AccessError('Endereço não autorizado.', 403, 'FORBIDDEN');
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.statusCode = 204; res.end(); return;
      }
      if (!['GET', 'POST'].includes(req.method)) throw new AccessError('Método não permitido.', 405);
      const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization || '')?.[1];
      if (!token) throw new AccessError('Entre na sua conta para criar acessos.', 401, 'UNAUTHORIZED');
      if (!config.enabled) throw new AccessError('O cadastro com senha aguarda configuração no servidor.', 503, 'NOT_CONFIGURED');
      const factory = dependencies.createClient || createClient;
      const options = {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (url, init = {}) => fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000) }) }
      };
      const admin = factory(config.supabaseUrl, config.supabaseKey, options);
      const auth = await admin.auth.getUser(token);
      const owner = auth?.data?.user;
      if (auth?.error || !owner?.id) throw new AccessError('Sua sessão expirou. Entre novamente.', 401, 'UNAUTHORIZED');
      if (!owner.email_confirmed_at || emailHash(owner.email) !== config.adminHash) throw new AccessError('Somente a conta administrativa autorizada pode criar usuários com senha.', 403, 'FORBIDDEN');
      if (req.method === 'GET') return send(200, { enabled: true });
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AccessError('Use application/json.', 415);
      let input = validate(await readBody(req));
      if (input.email === String(owner.email).toLowerCase()) throw new AccessError('Use um e-mail diferente da sua conta administrativa.');
      // The existing RPC validates company ownership and rate limits in the
      // database. It must run as the caller, never with the service-role JWT.
      const ownerClient = factory(config.supabaseUrl, config.supabaseKey, { ...options, global: { ...options.global, headers: { Authorization: `Bearer ${token}` } } });
      let invitation = null, createdId = null, linked = false, resultBody;
      try {
        const prepared = await ownerClient.rpc('zama_workspace_invite', { p_email: input.email, p_role: 'projects' });
        if (prepared.error) throw inviteError(prepared.error);
        invitation = prepared.data;
        if (!invitation?.id) throw new AccessError('Não foi possível preparar o cadastro.', 503, 'PROJECT_UNAVAILABLE');
        let result;
        try { result = await admin.auth.admin.createUser({ email: input.email, password: input.password, email_confirm: true }); }
        catch { throw accountError(); }
        input.password = '';
        if (result.error) throw accountError(result.error);
        createdId = result.data?.user?.id;
        if (!createdId || createdId === owner.id || String(result.data.user.email).toLowerCase() !== input.email) {
          createdId = null;
          throw new AccessError('Não foi possível confirmar a criação da conta. Confira os usuários no Supabase.', 503, 'ACCOUNT_SETUP_INCOMPLETE');
        }
        const binding = await admin.from('zama_workspace_members').insert({ owner_id: owner.id, user_id: createdId, role: 'projects' });
        if (binding.error) throw new Error('PROJECT_BIND_FAILED');
        linked = true;
        resultBody = { created: true, email: input.email, role: 'projects', loginUrl: `${config.origin}/` };
      } catch (error) {
        // Compensate only the account just created in this request. Existing
        // accounts are never updated, assigned a password, or deleted.
        if (createdId && !linked) {
          try {
            const rollback = await admin.auth.admin.deleteUser(createdId);
            if (rollback.error) throw rollback.error;
          } catch {
            throw new AccessError('A conta foi criada, mas o vínculo não foi concluído. Confira este usuário no Supabase antes de tentar novamente.', 503, 'ACCOUNT_SETUP_INCOMPLETE');
          }
          throw new AccessError('Não foi possível liberar os projetos. O cadastro incompleto foi desfeito; tente novamente.', 503, 'PROJECT_UNAVAILABLE');
        }
        throw error;
      } finally {
        input.password = ''; input = null;
        if (req.body && typeof req.body === 'object' && 'password' in req.body) req.body.password = '';
        else if (typeof req.body === 'string') req.body = '';
        // The prepared token is never emailed or returned. If cancellation
        // fails, it grants only the same projects role and is not disclosed.
        if (invitation?.id) { try { await ownerClient.rpc('zama_workspace_cancel_invite', { p_id: invitation.id }); } catch {} }
      }
      return send(201, resultBody);
    } catch (error) {
      const known = error instanceof AccessError;
      return send(known ? error.status : 500, { error: known ? error.message : 'Não foi possível criar o acesso. Tente novamente.', code: known ? error.code : 'INTERNAL_ERROR' });
    }
  };
}
module.exports = { createHandler, validate };
