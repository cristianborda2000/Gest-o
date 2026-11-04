'use strict';
// Stateless Streamable HTTP JSON-response subset; authentication is supplied by the private runtime.
const { z } = require('zod');
const { createService, definitions } = require('./service');
const { JarvisError } = require('../jarvis/errors');
const { readJsonBody } = require('../http/read-json-body');
const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const instructions = 'Crie registros apenas mediante pedido explícito. Despesas são propostas: entregue confirmation_url e nunca confirme pelo usuário. Preserve request_id após resultado incerto. reminder_minutes:60 não garante entrega. Não solicite credenciais no chat.';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (status, code, message) => { throw new JarvisError(message, status, code); };
function createMcpHandler({ config = {}, authenticate, repositoryFactory, clock = () => new Date() } = {}) {
  return async (req, res) => {
    let id = null;
    const send = (status, body) => { res.statusCode = status; res.end(body === undefined ? undefined : JSON.stringify(body)); };
    const rpcError = (status, code, message) => send(status, { jsonrpc: '2.0', id, error: { code, message } });
    const result = value => send(200, { jsonrpc: '2.0', id, result: value });
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (config.enabled !== true || typeof authenticate !== 'function' || typeof repositoryFactory !== 'function') fail(503, 'NOT_CONFIGURED', 'Remote integration is not configured.');
      let resource, origin;
      try { resource = new URL(config.resource); origin = new URL(config.appOrigin); } catch { fail(503, 'NOT_CONFIGURED', 'Invalid configuration.'); }
      const local = config.localTest === true && resource.protocol === 'http:' && resource.hostname === '127.0.0.1';
      if ((!local && resource.protocol !== 'https:') || resource.username || resource.password || resource.search || resource.hash || origin.protocol !== 'https:' || origin.origin !== config.appOrigin || !z.uuid().safeParse(config.ownerId).success || !config.clientId) fail(503, 'NOT_CONFIGURED', 'Invalid configuration.');
      if (req.headers.host !== resource.host) fail(403, 'FORBIDDEN', 'Host not allowed.');
      if (req.url !== resource.pathname) fail(404, 'NOT_FOUND', 'Endpoint not found.');
      if (req.headers.origin && !(config.allowedOrigins || []).includes(req.headers.origin)) fail(403, 'FORBIDDEN', 'Origin not allowed.');
      const token = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/.exec(req.headers.authorization || '')?.[1];
      if (!token || token.length > 8192) fail(401, 'UNAUTHORIZED', 'Connection required.');
      // Provider must validate signature/hash, issuer, audience, expiry and live grant revocation.
      // Do not accept a Supabase account token as a plugin credential.
      let principal; try { principal = await authenticate(token, { resource: config.resource }); } catch { fail(401, 'UNAUTHORIZED', 'Connection invalid.'); }
      if (!principal || principal.active !== true || !Number.isFinite(principal.expiresAt) || principal.expiresAt <= clock().getTime() || principal.audience !== config.resource) fail(401, 'UNAUTHORIZED', 'Connection invalid or expired.');
      if (principal.userId !== config.ownerId || principal.clientId !== config.clientId || !Array.isArray(principal.allowedTools)) fail(403, 'FORBIDDEN', 'Connection not authorized.');
      const repository = await repositoryFactory(principal);
      if (repository.userId !== config.ownerId) fail(403, 'FORBIDDEN', 'Account not authorized.');
      await repository.consumeRate('dot', 60, 60);
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); fail(405, 'METHOD_NOT_ALLOWED', 'No SSE stream or session deletion supported.'); }
      const accepts = (req.headers.accept || '').split(',').map(v => v.trim().toLowerCase());
      if (!accepts.includes('application/json') || !accepts.includes('text/event-stream')) fail(406, 'NOT_ACCEPTABLE', 'Accept application/json and text/event-stream.');
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'CONTENT_TYPE', 'Use application/json.');
      if (!versions.includes(req.headers['mcp-protocol-version'] || '2025-03-26')) fail(400, 'VERSION', 'Unsupported protocol version.');
      const message = await readJsonBody(req, { maxBytes: 20000, tooLarge: () => new JarvisError('Request too large.', 413), invalidJson: () => new JarvisError('Invalid JSON.', 400, 'PARSE_ERROR') });
      if (!object(message) || message.jsonrpc !== '2.0') return rpcError(400, -32600, 'Invalid Request');
      const hasId = Object.hasOwn(message, 'id');
      if (hasId && !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)))) return rpcError(400, -32600, 'Invalid Request');
      id = hasId ? message.id : null;
      if (typeof message.method !== 'string' || (message.params !== undefined && !object(message.params))) return rpcError(400, -32600, 'Invalid Request');
      if (!hasId) { if (!message.method.startsWith('notifications/')) return rpcError(400, -32600, 'Request id required.'); res.removeHeader('Content-Type'); return send(202); }
      const params = message.params || {};
      if (message.method === 'initialize') {
        if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') return rpcError(200, -32602, 'Invalid initialization');
        return result({ protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'zama-private-remote', version: '0.2.1' }, instructions });
      }
      if (message.method === 'ping') return result({});
      const catalog = definitions().filter(tool => principal.allowedTools.includes(tool.name)).map(tool => config.oauthMetadata ? {...tool,securitySchemes:[{type:'oauth2',scopes:['zama:private']}]} : tool);
      if (message.method === 'tools/list') { if (params.cursor !== undefined) return rpcError(200, -32602, 'Cursor not supported'); return result({ tools: catalog }); }
      if (message.method !== 'tools/call') return rpcError(200, -32601, 'Method not found');
      if (!catalog.some(tool => tool.name === params.name) || !object(params.arguments)) return rpcError(200, -32602, 'Tool not permitted or invalid arguments');
      const { request_id, ...args } = params.arguments;
      try {
        const scopedRepository = repository.withTool ? repository.withTool(params.name) : repository;
        const service = createService({ repository: scopedRepository, ownerId: config.ownerId, origin: config.appOrigin, clock });
        const receipt = await service.call({ name: params.name, arguments: args, request_id });
        return result({ content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt, isError: false });
      } catch (error) {
        const known = error instanceof JarvisError && error.status < 500;
        return result({ content: [{ type: 'text', text: JSON.stringify({ code: known ? error.code : 'OUTCOME_UNKNOWN', message: known ? 'Pedido rejeitado. Verifique os argumentos e preserve request_id.' : 'Resultado incerto. Reutilize exatamente o mesmo request_id e argumentos.' }) }], isError: true });
      }
    } catch (error) {
      if (error.status === 401) res.setHeader('WWW-Authenticate', config.oauthMetadata ? `Bearer resource_metadata="${config.oauthMetadata}", error="invalid_token", error_description="Connect your ZAM4 account"` : 'Bearer');
      return rpcError(error instanceof JarvisError ? error.status : 500, error.code === 'PARSE_ERROR' ? -32700 : -32000, error instanceof JarvisError ? error.message : 'Request failed.');
    }
  };
}
module.exports = { createMcpHandler };
