'use strict';
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');
const { readJsonBody } = require('../http/read-json-body');
const { createRepository } = require('../jarvis/repository');
const scope = 'zama:private';
const directScope = 'zama:expenses:write';
const refreshPolicy = Object.freeze({ access_expires_in: 3600, idle_expires_in: 604800, absolute_expires_in: 2592000 });
const refreshPattern = /^zama_refresh_v2\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
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
  return { refreshV2Enabled: env.DOT_OAUTH_REFRESH_V2_ENABLED === 'true', refreshEnabled: env.DOT_OAUTH_REFRESH_ENABLED === 'true', directExpensesEnabled: env.DOT_DIRECT_EXPENSES_ENABLED === 'true', origin: origin.origin, resource: resource.href, clientId: env.DOT_MCP_CLIENT_ID, ownerId: env.DOT_OWNER_ID, redirects };
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
  const request = z.object({ response_type: z.literal('code'), client_id: z.literal(config.clientId), redirect_uri: z.string(), resource: z.literal(config.resource), scope: z.string().optional().default(scope), state: z.string().min(1).max(2048), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), ui_locales: z.string().min(1).max(256).regex(/^[A-Za-z0-9-]+(?: [A-Za-z0-9-]+)*$/).optional() }).strict().safeParse(input);
  if (!request.success || !config.redirects.includes(request.data.redirect_uri)) throw problem('invalid_request');
  const scopes=request.data.scope.split(' ');
  if (!scopes.includes(scope) || new Set(scopes).size!==scopes.length || scopes.some(s=>s!==scope && !(config.directExpensesEnabled && s===directScope))) throw problem('invalid_request');
  return {...request.data,scope:[scope,...(scopes.includes(directScope)?[directScope]:[])].join(' ')};
}
function metadata(config, protectedResource) {
  if (protectedResource) return { resource: config.resource, authorization_servers: [config.origin], scopes_supported: config.directExpensesEnabled ? [scope,directScope] : [scope], bearer_methods_supported: ['header'] };
  return { issuer: config.origin, authorization_endpoint: `${config.origin}/api/dot-oauth/authorize`, token_endpoint: `${config.origin}/api/dot-oauth/token`, response_types_supported: ['code'], grant_types_supported: (config.refreshEnabled || config.refreshV2Enabled) ? ['authorization_code','refresh_token'] : ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: config.directExpensesEnabled ? [scope,directScope] : [scope], authorization_response_iss_parameter_supported: true, revocation_endpoint: `${config.origin}/api/dot-oauth/revoke`, revocation_endpoint_auth_methods_supported: ['none'], ...(config.refreshV2Enabled ? { zama_refresh_version: 2, zama_refresh_policy: refreshPolicy } : {}) };
}
function tokenPair(grantId) {
  return { accessToken: `zama_dot_v1.${grantId}.${randomBytes(32).toString('base64url')}`, refreshToken: `zama_refresh_v2.${grantId}.${randomBytes(32).toString('base64url')}` };
}
function renewalResponse(result, pair) {
  if (result.error) throw problem('server_error',503);
  const data = result.data;
  if (data?.error === 'invalid_grant' || data?.error === 'invalid_scope') throw problem(data.error);
  // Reject malformed DB replies rather than returning credentials after a failed RPC.
  if (data?.grant_id !== pair.accessToken.split('.')[1]) throw problem('server_error',503);
  if (!data || !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > refreshPolicy.access_expires_in || !Number.isInteger(data.refresh_token_expires_in) || data.refresh_token_expires_in < 1 || data.refresh_token_expires_in > refreshPolicy.idle_expires_in || ![scope,`${scope} ${directScope}`].includes(data.scope)) throw problem('server_error',503);
  return { access_token: pair.accessToken, refresh_token: pair.refreshToken, token_type: 'Bearer', expires_in: data.expires_in, refresh_token_expires_in: data.refresh_token_expires_in, scope: data.scope };
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
        path = ({resource:'/.well-known/oauth-protected-resource',metadata:'/.well-known/oauth-authorization-server',authorize:'/api/dot-oauth/authorize',consent:'/api/dot-oauth/consent',token:'/api/dot-oauth/token',revoke:'/api/dot-oauth/revoke'})[route] || '';
      }
      // Vercel may retain the public pathname while appending the rewrite's
      // routing parameter. Remove only the exact internal route selector.
      if (path === '/api/dot-oauth/authorize' && url.searchParams.getAll('path').length === 1 && url.searchParams.get('path') === 'authorize') url.searchParams.delete('path');
      if (req.method === 'GET' && ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/dot-mcp','/.well-known/oauth-authorization-server'].includes(path)) return send(200,metadata(config,path.includes('oauth-protected-resource')));
      const db = deps.client || createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
      // Shared database bucket also covers requests without a session. No
      // attacker-controlled keys are persisted; applies across function instances.
      if (!['/api/dot-oauth/authorize','/api/dot-oauth/consent','/api/dot-oauth/token','/api/dot-oauth/revoke'].includes(path)) throw problem('invalid_request',404);
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
        const parsed = z.object({ request:z.record(z.string(),z.string()), approve:z.boolean(), consent_direct:z.boolean().optional().default(false), allow_refresh:z.boolean().optional() }).strict().safeParse(body);
        if (!parsed.success) throw problem('invalid_request');
        if (parsed.data.consent_direct && !config.directExpensesEnabled) throw problem('invalid_request');
        const request = validateAuthorization(parsed.data.request,config), target = new URL(request.redirect_uri);
        target.searchParams.set('state',request.state); target.searchParams.set('iss',config.origin);
        if (!parsed.data.approve) { target.searchParams.set('error','access_denied'); return send(200,{redirect:target.href}); }
        // A versioned opaque code prevents policy changes from silently upgrading old consent.
        if (Boolean(parsed.data.allow_refresh) !== Boolean(config.refreshV2Enabled)) throw problem('invalid_request');
        const code = (config.refreshV2Enabled ? 'zama_code_v2.' : '') + randomBytes(32).toString('base64url');
        const saved = await db.from('dot_oauth_codes').insert({ code_hash:hash(code),owner_id:config.ownerId,client_id:config.clientId,resource:config.resource,redirect_uri:request.redirect_uri,challenge:request.code_challenge, ...(config.refreshV2Enabled ? {allow_refresh_v2:true} : {}), ...(config.directExpensesEnabled ? {allow_direct_expense:request.scope.split(' ').includes(directScope) || parsed.data.consent_direct} : {}) });
        if (saved.error) throw problem('server_error',503);
        target.searchParams.set('code',code);
        return send(200,{redirect:target.href});
      }
      if (path === '/api/dot-oauth/token' && req.method === 'POST') {
        if (req.headers.authorization) throw problem('invalid_client',401);
        if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('invalid_request',415);
        const form = await readForm(req);
        if (form.grant_type === 'refresh_token' && String(form.refresh_token || '').startsWith('zama_refresh_v2.')) {
          if (!config.refreshV2Enabled) throw problem('unsupported_grant_type');
          if (form.client_id !== config.clientId) throw problem('invalid_client',401);
          const parsed = z.object({grant_type:z.literal('refresh_token'),client_id:z.literal(config.clientId),refresh_token:z.string().regex(refreshPattern),resource:z.literal(config.resource).optional().default(config.resource),scope:z.string().min(1).max(256).optional()}).strict().safeParse(form);
          if (!parsed.success) throw problem('invalid_grant');
          const v = parsed.data, parts = refreshPattern.exec(v.refresh_token);
          if (Buffer.from(parts[2],'base64url').toString('base64url') !== parts[2]) throw problem('invalid_grant');
          const pair = tokenPair(parts[1]);
          const rotated = await db.rpc('dot_oauth_v2_refresh',{p_refresh_hash:hash(v.refresh_token),p_grant:parts[1],p_owner:config.ownerId,p_client:config.clientId,p_resource:config.resource,p_token_hash:hash(pair.accessToken),p_next_refresh_hash:hash(pair.refreshToken),p_scope:v.scope ?? null,p_direct_enabled:Boolean(config.directExpensesEnabled)});
          return send(200,renewalResponse(rotated,pair));
        }
        if (form.grant_type === 'refresh_token') {
          if (!config.refreshEnabled) throw problem('unsupported_grant_type');
          const input = z.object({grant_type:z.literal('refresh_token'),client_id:z.literal(config.clientId),refresh_token:z.string().regex(/^zama_refresh_v1\.[A-Za-z0-9_-]{43}$/),resource:z.literal(config.resource).optional(),scope:z.string().optional()}).strict().safeParse(form);
          if (!input.success) throw problem('invalid_grant');
          let requestedScope = null;
          if (input.data.scope !== undefined) {
            const parts = input.data.scope.split(' ');
            if (!parts.includes(scope) || new Set(parts).size !== parts.length || parts.some(item => item !== scope && item !== directScope)) throw problem('invalid_scope');
            requestedScope = [scope,...(parts.includes(directScope)?[directScope]:[])].join(' ');
          }
          const id=randomUUID(),accessToken=`zama_dot_v1.${id}.${randomBytes(32).toString('base64url')}`,refreshToken=`zama_refresh_v1.${randomBytes(32).toString('base64url')}`;
          const rotated=await db.rpc('dot_oauth_refresh',{p_refresh_hash:hash(input.data.refresh_token),p_owner:config.ownerId,p_client:config.clientId,p_resource:config.resource,p_grant:id,p_token_hash:hash(accessToken),p_next_refresh_hash:hash(refreshToken),p_direct_enabled:config.directExpensesEnabled===true,p_scope:requestedScope});
          if (rotated.error) throw problem('server_error',503);
          if (!rotated.data || !Array.isArray(rotated.data.allowed_tools)) throw problem('invalid_grant');
          const issuedScope=scope+(rotated.data.allowed_tools.includes('record_expense')?' '+directScope:'');
          return send(200,{access_token:accessToken,refresh_token:refreshToken,token_type:'Bearer',expires_in:rotated.data.expires_in,scope:issuedScope});
        }
        const input = z.object({grant_type:z.literal('authorization_code'),client_id:z.literal(config.clientId),code:z.string().regex(/^(?:zama_code_v2\.)?[A-Za-z0-9_-]{43}$/),redirect_uri:z.string(),resource:z.literal(config.resource),code_verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/)}).strict().safeParse(form);
        if (!input.success || !config.redirects.includes(input.data.redirect_uri)) throw problem('invalid_grant');
        const v = input.data, id = randomUUID(), accessToken = `zama_dot_v1.${id}.${randomBytes(32).toString('base64url')}`;
        if (v.code.startsWith('zama_code_v2.')) {
          if (!config.refreshV2Enabled) throw problem('invalid_grant');
          const pair = tokenPair(id);
          const issued = await db.rpc('dot_oauth_v2_exchange_refresh',{p_code_hash:hash(v.code),p_owner:config.ownerId,p_client:config.clientId,p_resource:config.resource,p_redirect:v.redirect_uri,p_challenge:createHash('sha256').update(v.code_verifier).digest('base64url'),p_grant:id,p_token_hash:hash(pair.accessToken),p_refresh_hash:hash(pair.refreshToken),p_direct_enabled:Boolean(config.directExpensesEnabled)});
          return send(200,renewalResponse(issued,pair));
        }
        if (config.refreshEnabled) {
          const refreshToken=`zama_refresh_v1.${randomBytes(32).toString('base64url')}`;
          const exchanged=await db.rpc('dot_oauth_exchange_refresh',{p_code_hash:hash(v.code),p_owner:config.ownerId,p_client:config.clientId,p_resource:config.resource,p_redirect:v.redirect_uri,p_challenge:createHash('sha256').update(v.code_verifier).digest('base64url'),p_grant:id,p_token_hash:hash(accessToken),p_family:randomUUID(),p_refresh_hash:hash(refreshToken),p_direct_enabled:config.directExpensesEnabled===true});
          if (exchanged.error) throw problem('server_error',503);
          if (!exchanged.data || !Array.isArray(exchanged.data.allowed_tools)) throw problem('invalid_grant');
          const issuedScope=scope+(exchanged.data.allowed_tools.includes('record_expense')?' '+directScope:'');
          return send(200,{access_token:accessToken,refresh_token:refreshToken,token_type:'Bearer',expires_in:exchanged.data.expires_in,scope:issuedScope});
        }
        const exchanged = await db.rpc('dot_oauth_exchange',{p_code_hash:hash(v.code),p_owner:config.ownerId,p_client:config.clientId,p_resource:config.resource,p_redirect:v.redirect_uri,p_challenge:createHash('sha256').update(v.code_verifier).digest('base64url'),p_grant:id,p_token_hash:hash(accessToken),...(config.directExpensesEnabled?{p_direct_enabled:true}:{})});
        if (exchanged.error) throw problem('server_error',503);
        if (exchanged.data !== true) throw problem('invalid_grant');
        let issuedScope=scope;
        if(config.directExpensesEnabled){const grant=await db.from('dot_api_grants').select('allowed_tools').eq('id',id).maybeSingle();if(grant.error || !grant.data)throw problem('server_error',503);if(grant.data.allowed_tools.includes('record_expense'))issuedScope+=' '+directScope;}
        return send(200,{access_token:accessToken,token_type:'Bearer',expires_in:3600,scope:issuedScope});
      }
      // Keep revocation available when renewal is switched off, including tokens
      // issued before the kill switch. No session or client secret is accepted.
      if (path === '/api/dot-oauth/revoke' && req.method === 'POST') {
        if (req.headers.authorization) throw problem('invalid_client',401);
        if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('invalid_request',415);
        const form = await readForm(req);
        if (form.client_id !== config.clientId) throw problem('invalid_client',401);
        const input = z.object({client_id:z.literal(config.clientId),token:z.string().min(1).max(2048),token_type_hint:z.string().max(128).optional(),resource:z.literal(config.resource).optional()}).strict().safeParse(form);
        if (!input.success) throw problem('invalid_request');
        const revoked = await db.rpc('dot_oauth_revoke_compatible',{p_token_hash:hash(input.data.token),p_owner:config.ownerId,p_client:config.clientId,p_resource:config.resource});
        if (revoked.error || revoked.data !== true) throw problem('server_error',503);
        res.statusCode=200; res.end(); return;
      }
      throw problem('invalid_request',404);
    } catch (error) { return send(error.status || 503,{error:error.oauth || 'server_error'}); }
  };
}
module.exports = { createHandler, configuration, validateAuthorization, metadata, scope, tools };
