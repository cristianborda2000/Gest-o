'use strict';
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');
const { readJsonBody } = require('../http/read-json-body');
const { createRepository } = require('../jarvis/repository');
const scope = 'zama:private';
const tools = ['list_tasks','get_agenda','search_ideas','create_task','create_agenda_event','save_idea','prepare_expense'];
const hash = value => createHash('sha256').update(value).digest('hex');
const problem = (error, status = 400) => Object.assign(new Error(error), { status, oauth: error });
function configuration(env = process.env) {
  if (env.DOT_OAUTH_ENABLED !== 'true') return null;
  const origin = new URL(env.APP_ORIGIN), resource = new URL(env.DOT_MCP_RESOURCE);
  const redirects = JSON.parse(env.DOT_OAUTH_REDIRECT_URIS || '[]');
  if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || resource.origin !== origin.origin || resource.pathname !== '/api/dot-mcp' || resource.search || resource.hash || resource.username || resource.password || !z.uuid().safeParse(env.DOT_OWNER_ID).success || !env.DOT_MCP_CLIENT_ID || !Array.isArray(redirects) || !redirects.length) throw problem('server_error', 503);
  for (const value of redirects) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('*') || url.href !== value) throw problem('server_error', 503);
  }
  return { origin: origin.origin, resource: resource.href, clientId: env.DOT_MCP_CLIENT_ID, ownerId: env.DOT_OWNER_ID, redirects };
}
function unique(params) {
  const out = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(out, key)) throw problem('invalid_request');
    Object.defineProperty(out, key, { value, enumerable: true });
  }
  return out;
}
function validateAuthorization(input, config) {
  const request = z.object({ response_type: z.literal('code'), client_id: z.literal(config.clientId), redirect_uri: z.string(), resource: z.literal(config.resource), scope: z.literal(scope).optional().default(scope), state: z.string().min(1).max(2048), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256') }).strict().safeParse(input);
  if (!request.success || !config.redirects.includes(request.data.redirect_uri)) throw problem('invalid_request');
  return request.data;
}
function metadata(config, protectedResource) {
  if (protectedResource) return { resource: config.resource, authorization_servers: [config.origin], scopes_supported: [scope], bearer_methods_supported: ['header'] };
  return { issuer: config.origin, authorization_endpoint: `${config.origin}/api/dot-oauth/authorize`, token_endpoint: `${config.origin}/api/dot-oauth/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [scope], authorization_response_iss_parameter_supported: true };
}
async function readForm(req) {
  let raw = req.body;
  if (raw !== undefined && typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    // Vercel can parse form bodies before invoking the handler.
    if (!raw || Array.isArray(raw) || Object.entries(raw).some(([k,v]) => typeof v !== 'string' || k.length > 100 || v.length > 4096) || Buffer.byteLength(JSON.stringify(raw)) > 10000) throw problem('invalid_request');
    return raw;
  }
  if (raw === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 10000) throw problem('invalid_request', 413); chunks.push(b); }
    raw = Buffer.concat(chunks);
  }
  if (Buffer.byteLength(raw) > 10000) throw problem('invalid_request', 413);
  return unique(new URLSearchParams(raw.toString()));
}
function createHandler(deps = {}) {
  return async (req, res) => {
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    const redirect = url => { res.statusCode = 302; res.setHeader('Location', url); res.end(); };
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control','no-store'); res.setHeader('Pragma','no-cache'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    try {
      const config = deps.config || configuration();
      if (!config) throw problem('temporarily_unavailable',503);
      if (req.headers.host !== new URL(config.origin).host) throw problem('invalid_request',403);
      const url = new URL(req.url,config.origin);
      // Vercel rewrites public routes to this single function. Each branch still
      // enforces its own method, body format and authentication requirements.
      let path = url.pathname;
      if (path === '/api/dot-oauth') {
        const route = url.searchParams.get('path'); url.searchParams.delete('path');
        path = ({resource:'/.well-known/oauth-protected-resource',metadata:'/.well-known/oauth-authorization-server',authorize:'/api/dot-oauth/authorize',consent:'/api/dot-oauth/consent',token:'/api/dot-oauth/token'})[route] || '';
      }
      // Vercel may retain the public pathname while appending the rewrite's
      // routing parameter. Remove only the exact internal route selector.
      if (path === '/api/dot-oauth/authorize' && url.searchParams.getAll('path').length === 1 && url.searchParams.get('path') === 'authorize') url.searchParams.delete('path');
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/dot-mcp','/.well-known/oauth-authorization-server'].includes(path)) return send(200,metadata(config,path.includes('oauth-protected-resource')));
      const db = deps.client || createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
      // Shared database bucket also covers requests without a session. No
      // attacker-controlled keys are persisted; applies across function instances.
      if (!['/api/dot-oauth/authorize','/api/dot-oauth/consent','/api/dot-oauth/token'].includes(path)) throw problem('invalid_request',404);
      try { await (deps.preRate ? deps.preRate() : createRepository(db,config.ownerId).consumeRate('dot_oauth_public',120,60)); }
      catch (error) { if(error.status===429) { res.setHeader('Retry-After','60'); throw problem('temporarily_unavailable',429); } throw problem('temporarily_unavailable',503); }
      if (path === '/api/dot-oauth/authorize' && req.method === 'GET') {
        validateAuthorization(unique(url.searchParams),config);
        return redirect(`${config.origin}/dot-authorize.html?${url.searchParams}`);
      }
      if (path === '/api/dot-oauth/consent' && req.method === 'POST') {
        if (req.headers.origin !== config.origin) throw problem('access_denied',403);
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('invalid_request',415);
        const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization || '')?.[1];
        if (!token) throw problem('access_denied',401);
        const { data, error } = await db.auth.getUser(token);
        if (error || data?.user?.id !== config.ownerId) throw problem('access_denied',403);
        await (deps.rate ? deps.rate() : createRepository(db,config.ownerId).consumeRate('dot',20,60));
        const body = await readJsonBody(req,{maxBytes:10000,invalidJson:()=>problem('invalid_request'),tooLarge:()=>problem('invalid_request',413)});
        const parsed = z.object({ request:z.record(z.string(),z.string()), approve:z.boolean() }).strict().safeParse(body);
        if (!parsed.success) throw problem('invalid_request');
        const request = validateAuthorization(parsed.data.request,config), target = new URL(request.redirect_uri);
        target.searchParams.set('state',request.state); target.searchParams.set('iss',config.origin);
        if (!parsed.data.approve) { target.searchParams.set('error','access_denied'); return send(200,{redirect:target.href}); }
        const code = randomBytes(32).toString('base64url');
        const saved = await db.from('dot_oauth_codes').insert({ code_hash:hash(code),owner_id:config.ownerId,client_id:config.clientId,resource:config.resource,redirect_uri:request.redirect_uri,challenge:request.code_challenge });
        if (saved.error) throw problem('server_error',503);
        target.searchParams.set('code',code);
        return send(200,{redirect:target.href});
      }
      if (path === '/api/dot-oauth/token' && req.method === 'POST') {
        if (req.headers.authorization) throw problem('invalid_client',401);
        if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('invalid_request',415);
        const input = z.object({grant_type:z.literal('authorization_code'),client_id:z.literal(config.clientId),code:z.string().regex(/^[A-Za-z0-9_-]{43}$/),redirect_uri:z.string(),resource:z.literal(config.resource),code_verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/)}).strict().safeParse(await readForm(req));
        if (!input.success || !config.redirects.includes(input.data.redirect_uri)) throw problem('invalid_grant');
        const v = input.data, id = randomUUID(), accessToken = `zama_dot_v1.${id}.${randomBytes(32).toString('base64url')}`;
        const exchanged = await db.rpc('dot_oauth_exchange',{p_code_hash:hash(v.code),p_owner:config.ownerId,p_client:config.clientId,p_resource:config.resource,p_redirect:v.redirect_uri,p_challenge:createHash('sha256').update(v.code_verifier).digest('base64url'),p_grant:id,p_token_hash:hash(accessToken)});
        if (exchanged.error) throw problem('server_error',503);
        if (exchanged.data !== true) throw problem('invalid_grant');
        return send(200,{access_token:accessToken,token_type:'Bearer',expires_in:3600,scope});
      }
      throw problem('invalid_request',404);
    } catch (error) { return send(error.status || 503,{error:error.oauth || 'server_error'}); }
  };
}
module.exports = { createHandler, configuration, validateAuthorization, metadata, scope, tools };
