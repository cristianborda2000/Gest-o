'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { z } = require('zod');
const { registry, validateTool } = require('../jarvis/tools');
const Direct = require('./direct-expense');
const { JarvisError } = require('../jarvis/errors');
const allowed = ['list_tasks', 'get_agenda', 'search_ideas', 'create_task', 'create_agenda_event', 'save_idea', 'register_expense'];
const publicName = name => name === 'register_expense' ? 'prepare_expense' : name;
const internalName = name => name === 'prepare_expense' ? 'register_expense' : name;
const envelope = z.object({ name: z.enum([...allowed.map(publicName), 'record_expense']), arguments: z.record(z.string(), z.unknown()), request_id: z.uuid() }).strict();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (message, status = 400, code = 'DOT_INVALID') => { throw new JarvisError(message, status, code); };
function definitions({ includeDirect = false } = {}) {
  const standard = allowed.map(name => {
    const inputSchema = z.toJSONSchema(registry[name].schema); delete inputSchema.$schema;
    inputSchema.properties.request_id = { type: 'string', format: 'uuid', description: 'UUID único por pedido. Reutilize exatamente o mesmo UUID e argumentos após timeout; nunca gere outro para repetir o mesmo pedido.' };
    inputSchema.required = [...(inputSchema.required || []), 'request_id'];
    return { name: publicName(name), description: registry[name].description + ' Conta pessoal do proprietário. Só escreva mediante pedido explícito. Datas usam America/Sao_Paulo.', inputSchema,
      annotations: { readOnlyHint: registry[name].risk === 'read', destructiveHint: false, idempotentHint: true, openWorldHint: false } };
  });
  return includeDirect ? [...standard, Direct.definition()] : standard;
}
function createService({ repository, ownerId, origin, clock = () => new Date(), directExpensesEnabled = false, allowedTools = [] }) {
  if (!ownerId || repository.userId !== ownerId) fail('Acesso restrito ao proprietário configurado.', 403, 'DOT_OWNER_ONLY');
  const context = id => ({ now: clock(), operationId: id });
  const find = (snapshot, id) => {
    const action = snapshot.jarvis.actions.find(a => a.id === id && a.source === 'dot' && a.actor_id === ownerId && a.owner_id === ownerId);
    if (!action) fail('Ação não encontrada.', 404, 'DOT_NOT_FOUND');
    return action;
  };
  const receipt = action => ({ action_id: action.id, status: action.status, result: action.result, expires_at: action.expires_at,
    ...(action.requires_confirmation && action.status === 'pending' ? { confirmation_url: `${origin}/dot-confirm.html?action=${encodeURIComponent(action.id)}`, requires_confirmation: true } : {}) });
  async function call(raw) {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) fail('Ferramenta, argumentos ou request_id inválidos.');
    const input = parsed.data, name = internalName(input.name), fingerprint = digest(input);
    if (input.name === 'record_expense') {
      if (!directExpensesEnabled || !allowedTools.includes('record_expense')) fail('Lançamento direto não autorizado.',403,'DOT_DIRECT_FORBIDDEN');
      return Direct.record({repository,ownerId,input,fingerprint,clock,receipt});
    }
    const id = randomUUID(), time = clock().toISOString();
    return repository.transact(snapshot => {
      const previous = snapshot.jarvis.actions.find(a => a.source === 'dot' && a.request_id === input.request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('request_id já usado com outros argumentos.', 409, 'DOT_IDEMPOTENCY_CONFLICT');
        return { unchanged: true, result: receipt(previous) };
      }
      const { tool, args } = validateTool(name, input.arguments, { now: time, operationId: id });
      const result = tool.execute(tool.risk === 'sensitive' ? structuredClone(snapshot.state) : snapshot.state, args, { now: time, operationId: id });
      if (tool.risk === 'sensitive') delete result.id;
      const action = { id, source: 'dot', actor_id: ownerId, owner_id: ownerId, channel: 'mcp', request_id: input.request_id, fingerprint,
        tool_name: name, input: args, result, status: tool.risk === 'sensitive' ? 'pending' : 'executed', created_at: time,
        requires_confirmation: tool.risk === 'sensitive', ...(tool.risk === 'sensitive' ? { expires_at: new Date(Date.parse(time) + 86400000).toISOString() } : { executed_at: time }) };
      snapshot.jarvis.actions.push(action);
      return { writeState: tool.risk === 'write', result: receipt(action) };
    });
  }
  async function preview(id) {
    const action = find(await repository.read(), id);
    return { ...receipt(action), input: action.input, owner_id: ownerId, confirmation_digest: digest({ id: action.id, input: action.input }) };
  }
  async function decide(id, raw) {
    const parsed = z.object({ confirmation: z.boolean(), confirmation_digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().safeParse(raw);
    if (!parsed.success) fail('Revise a operação na tela antes de confirmar.');
    return repository.transact(snapshot => {
      const action = find(snapshot, id);
      if (action.tool_name !== 'register_expense' || !action.requires_confirmation) fail('Esta ação não aceita confirmação.', 403);
      if (parsed.data.confirmation_digest !== digest({ id: action.id, input: action.input })) fail('Os dados mudaram. Revise novamente.', 409);
      if (action.status !== 'pending') return { unchanged: true, result: receipt(action) };
      if (Date.parse(action.expires_at) <= +clock()) fail('Confirmação expirada. Prepare um novo pedido.', 410);
      const time = clock().toISOString();
      if (!parsed.data.confirmation) { action.status = 'cancelled'; action.cancelled_at = time; }
      else {
        const { tool, args } = validateTool('register_expense', action.input, context(action.id));
        action.result = tool.execute(snapshot.state, args, context(action.id));
        action.status = 'executed'; action.confirmed_at = time; action.executed_at = time;
        action.confirmed_by = ownerId; action.confirmation_channel = 'zama-web';
      }
      return { writeState: parsed.data.confirmation, result: receipt(action) };
    });
  }
  return { call, preview, decide };
}
module.exports = { createService, definitions };
