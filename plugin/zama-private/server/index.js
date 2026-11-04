'use strict';
// Dependency-free bounded MCP stdio subset: initialize, ping, tools/list, tools/call.
// No credentials in package files, stdout, arguments, errors, or tool results.
const { StringDecoder } = require('node:string_decoder');
const definitions = require('./tools.json');
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function validReceipt(data, name, origin) {
  if (!data || Array.isArray(data) || typeof data !== 'object' || !uuid(data.action_id) || !['executed', 'pending', 'cancelled'].includes(data.status) || !data.result || Array.isArray(data.result) || typeof data.result !== 'object') return false;
  if (name !== 'prepare_expense' && data.status !== 'executed') return false;
  const value = data.result, nonempty = text => typeof text === 'string' && text.trim().length > 0;
  if (['list_tasks', 'get_agenda'].includes(name) && (!Array.isArray(value.tasks) || !Number.isSafeInteger(value.total) || value.total < 0)) return false;
  if (name === 'search_ideas' && (!Array.isArray(value.ideas) || !Number.isSafeInteger(value.total) || value.total < 0)) return false;
  if (['create_task', 'create_agenda_event', 'save_idea'].includes(name) && (!nonempty(value.id) || !nonempty(value.title))) return false;
  if (name === 'prepare_expense' && (!nonempty(value.title) || !nonempty(value.amount) || !Number.isSafeInteger(value.amount_cents) || value.amount_cents <= 0)) return false;
  if (data.status === 'pending') {
    if (data.requires_confirmation !== true || typeof data.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) return false;
    try { const url = new URL(data.confirmation_url); if (url.origin !== origin || url.pathname !== '/dot-confirm.html' || url.username || url.password || url.hash || url.searchParams.get('action') !== data.action_id || [...url.searchParams].length !== 1) return false; }
    catch { return false; }
  }
  return true;
}
const instructions = 'ZAMA privado: só crie registros mediante pedido explícito. Despesas são apenas preparadas; entregue confirmation_url e nunca confirme nem clique pelo usuário. Reutilize request_id e argumentos após resultado incerto. Datas usam America/Sao_Paulo. reminder_minutes:60 registra antecedência, sem garantir entrega. Não solicite credenciais no chat. Esta versão não oferece acesso à equipe, OAuth ou telefonia.';
function createBridge({ env = process.env, fetchImpl = fetch } = {}) {
  let initialized = false, ready = false;
  const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  async function handle(message) {
    const id = message?.id ?? null;
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && typeof id !== 'string' && typeof id !== 'number')) return error(null, -32600, 'Invalid Request');
    const notification = !Object.hasOwn(message, 'id');
    if (notification) { if (message.method === 'notifications/initialized' && initialized) ready = true; return null; }
    const result = data => ({ jsonrpc: '2.0', id, result: data });
    if (message.method === 'initialize') {
      if (initialized || typeof message.params?.protocolVersion !== 'string' || !message.params?.clientInfo || !message.params?.capabilities) return error(id, -32602, 'Invalid initialization');
      initialized = true;
      return result({ protocolVersion: versions.includes(message.params.protocolVersion) ? message.params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'zama-private', version: '0.1.2' }, instructions });
    }
    if (message.method === 'ping') return result({});
    if (!ready) return error(id, -32000, 'Initialize first');
    if (message.method === 'tools/list') {
      if (message.params?.cursor) return error(id, -32602, 'Invalid cursor');
      return result({ tools: definitions });
    }
    if (message.method !== 'tools/call') return error(id, -32601, 'Method not found');
    const params = message.params;
    if (!definitions.some(t => t.name === params?.name) || !params?.arguments || Array.isArray(params.arguments) || typeof params.arguments !== 'object') return error(id, -32602, 'Invalid tool');
    const { request_id, ...args } = params.arguments;
    if (typeof request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request_id)) return error(id, -32602, 'A UUID request_id is required');
    const fail = (code, text) => result({ content: [{ type: 'text', text: JSON.stringify({ code, message: text, request_id }) }], isError: true });
    let origin;
    try { origin = new URL(env.ZAMA_API_ORIGIN); if (origin.protocol !== 'https:' || origin.origin !== env.ZAMA_API_ORIGIN || origin.username || origin.password) throw new Error(); }
    catch { return fail('NOT_CONFIGURED', 'Configure a origem HTTPS ZAMA no ambiente do host.'); }
    const token = env.ZAMA_ACCESS_TOKEN;
    if (!token || !/^[A-Za-z0-9._-]+$/.test(token)) return fail('NOT_CONNECTED', 'Conecte a sessão temporária no ambiente seguro do host. Não envie credenciais pelo chat.');
    try {
      const response = await fetchImpl(`${origin.origin}/api/dot`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: params.name, arguments: args, request_id }) });
      if (!response.ok) {
        await response.body?.cancel();
        return fail(`HTTP_${response.status}`, response.status === 401 ? 'Sessão expirada. Reconecte pelo host.' : response.status === 403 ? 'Acesso negado para esta conta.' : 'Pedido não concluído. Preserve o request_id para verificar ou repetir.');
      }
      // Bound streaming output rather than buffering an unbounded response.
      const reader = response.body.getReader(); let length = 0; const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 262144) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value)); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validReceipt(data, params.name, origin.origin)) throw new Error('Invalid receipt');
      return result({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
    } catch { return fail('OUTCOME_UNKNOWN', 'Sem confirmação do servidor. A operação pode ter sido gravada. Reutilize exatamente o mesmo request_id e argumentos; não crie um novo pedido.'); }
  }
  return { handle };
}
function start(input = process.stdin, output = process.stdout) {
  const bridge = createBridge(), decoder = new StringDecoder('utf8'); let buffer = '', pending = 0, chain = Promise.resolve(), stopped = false;
  const write = value => { if (value) output.write(JSON.stringify(value) + '\n'); };
  const stop = () => { stopped = true; input.pause(); input.destroy(); process.exitCode = 1; };
  input.on('data', chunk => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > 65536 || pending >= 32) { stop(); return; }
      pending++;
      chain = chain.then(async () => {
        try { let message; try { message = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; } write(await bridge.handle(message)); }
        catch { write({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }); }
        finally { pending--; }
      });
    }
    if (Buffer.byteLength(buffer) > 65536) stop();
  });
  input.on('end', () => { if (buffer.trim()) process.exitCode = 1; });
}
if (require.main === module) start();
module.exports = { createBridge, start };
