'use strict';
const { createHash, createECDH } = require('node:crypto');
const fingerprint = key => createHash('sha256').update(key).digest('hex');
function allowedOrigins(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) return [];
    // These two verified first-party hosts serve the same ZAMA application.
    // Do not infer trust for arbitrary subdomains or other hosting tenants.
    if (['https://zam4.com', 'https://www.zam4.com'].includes(origin)) return [origin, origin === 'https://zam4.com' ? 'https://www.zam4.com' : 'https://zam4.com'];
    return [origin];
  } catch { return []; }
}
function configuration(env = process.env) {
  const value = {
    requested: env.PUSH_REMINDERS_ENABLED === 'true',
    supabaseUrl: env.SUPABASE_URL || '', supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    origin: env.APP_ORIGIN || '', publicKey: env.VAPID_PUBLIC_KEY || '', privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || '', cronSecret: env.CRON_SECRET || ''
  };
  let keysValid = false;
  try {
    const key = createECDH('prime256v1'); key.setPrivateKey(Buffer.from(value.privateKey, 'base64url'));
    keysValid = key.getPublicKey().toString('base64url') === value.publicKey;
  } catch {}
  const originValid = allowedOrigins(value.origin).length > 0;
  value.configured = Boolean(keysValid && originValid && value.supabaseUrl && value.supabaseKey && value.cronSecret.length >= 32 && /^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/.test(value.subject));
  value.enabled = value.requested && value.configured;
  value.keyId = value.publicKey ? fingerprint(value.publicKey) : '';
  return value;
}
function publicConfiguration(config) {
  return { enabled: config.enabled, publicKey: config.enabled ? config.publicKey : '', keyId: config.enabled ? config.keyId : '',
    appOrigin: allowedOrigins(config.origin)[0] || '',
    reason: config.enabled ? '' : 'Lembretes com o aplicativo fechado aguardam ativação no servidor. Os avisos com o aplicativo aberto continuam disponíveis.' };
}
module.exports = { configuration, publicConfiguration, fingerprint, allowedOrigins };
