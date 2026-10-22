'use strict';
const { z } = require('zod');
const { ECDH } = require('node:crypto');
const { readJsonBody } = require('../http/read-json-body');
class ReminderError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
// Push endpoints are credentials, not arbitrary webhooks. Do not broaden this to
// an environment-controlled wildcard or let a client select an alternate host.
function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new ReminderError('Endereço de notificação inválido.'); }
  const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !url.pathname || url.pathname === '/' || value.length > 2048) throw new ReminderError('Serviço de notificação não permitido.');
  return url.href;
}
const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2048), expirationTime: z.number().nonnegative().nullable().optional(),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]+$/).max(100), auth: z.string().regex(/^[A-Za-z0-9_-]+$/).max(30) }).strict()
}).strict();
function validateSubscription(input) {
  const result = subscriptionSchema.safeParse(input);
  if (!result.success) throw new ReminderError('Assinatura de notificação inválida.');
  const sub = result.data;
  sub.endpoint = validateEndpoint(sub.endpoint);
  try {
    const key = Buffer.from(sub.keys.p256dh, 'base64url');
    if (key.length !== 65 || key[0] !== 4 || Buffer.from(sub.keys.auth, 'base64url').length !== 16) throw new Error();
    ECDH.convertKey(key, 'prime256v1');
  } catch { throw new ReminderError('Chaves de notificação inválidas.'); }
  if (sub.expirationTime != null && sub.expirationTime <= Date.now()) throw new ReminderError('A assinatura expirou. Ative os lembretes novamente.');
  return sub;
}
async function readBody(req) {
  return readJsonBody(req, { maxBytes: 8192,
    tooLarge: () => new ReminderError('Solicitação muito grande.', 413),
    invalidJson: () => new ReminderError('JSON inválido.') });
}
module.exports = { ReminderError, validateEndpoint, validateSubscription, readBody };
