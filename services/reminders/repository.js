'use strict';
const { ReminderError } = require('./validation');
const { fingerprint } = require('./config');
const fail = error => { if (error) throw new ReminderError('Não foi possível acessar o serviço de lembretes.', 503, 'STORAGE_UNAVAILABLE'); };
function createRepository(client) {
  return {
    async status(userId, hash, keyId) {
      if (!hash) return { registered: false };
      const { data, error } = await client.from('reminder_subscriptions').select('key_id,updated_at').eq('user_id', userId).eq('endpoint_hash', hash).maybeSingle(); fail(error);
      return { registered: Boolean(data && data.key_id === keyId), needsRenewal: Boolean(data && data.key_id !== keyId) };
    },
    async subscribe(userId, subscription, keyId) {
      const { error } = await client.rpc('reminder_subscribe', { p_user_id: userId, p_endpoint_hash: fingerprint(subscription.endpoint), p_subscription: subscription, p_key_id: keyId });
      if (error?.code === '23505') throw new ReminderError('Este navegador está associado a outra conta. Renove a ativação.', 409, 'SUBSCRIPTION_CONFLICT');
      fail(error);
    },
    async unsubscribe(userId, hash) {
      const { error } = await client.from('reminder_subscriptions').delete().eq('user_id', userId).eq('endpoint_hash', hash); fail(error);
    },
    async accounts(keyId, after, limit) {
      const { data, error } = await client.rpc('reminder_accounts', { p_key_id: keyId, p_after: after, p_limit: limit }); fail(error); return data || [];
    },
    async snapshot(userId) {
      const { data, error } = await client.from('app_state').select('data,updated_at').eq('user_id', userId).maybeSingle(); fail(error); return data;
    },
    async subscriptions(userId, keyId) {
      const { data, error } = await client.from('reminder_subscriptions').select('endpoint_hash,subscription').eq('user_id', userId).eq('key_id', keyId).order('updated_at', { ascending: false }); fail(error); return data || [];
    },
    async claim(userId, revision, key, now) {
      const { data, error } = await client.rpc('reminder_claim', { p_user_id: userId, p_revision: revision, p_key: key, p_now: now }); fail(error); return Boolean(data);
    }
  };
}
module.exports = { createRepository };
