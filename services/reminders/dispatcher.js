'use strict';
const { timingSafeEqual } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { configuration } = require('./config');
const { createRepository } = require('./repository');
const { createSender } = require('./sender');
const { validateSubscription } = require('./validation');
const { helpers } = require('../../app/assets/js/ceo-agenda');
const WINDOW = 120000;
async function claimCurrent(repository, userId, key, now) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await repository.snapshot(userId);
    if (!snapshot?.data || snapshot.data.reminderReceipts?.[key]) return null;
    // Re-read after edits, completion, disabling preferences or other claims.
    const reminder = helpers.remindersBetween(snapshot.data, now - WINDOW, now).find(item => item.key === key);
    if (!reminder) return null;
    if (await repository.claim(userId, snapshot.updated_at, key, now)) return reminder;
  }
  return null;
}
async function dispatch({ repository, send, config, now = Date.now(), clock = Date.now, maxDuration = 50000 }) {
  const started = clock(), result = { accounts: 0, accepted: 0, skipped: 0, expired: 0, failed: 0, truncated: false };
  // Keep going across pages. The deadline is visible in the result for monitoring;
  // operators must shard/raise capacity if it becomes true in real deployment.
  outer: for (let after = null; ;) {
    const accounts = await repository.accounts(config.keyId, after, 100);
    for (const account of accounts) {
      if (clock() - started > maxDuration) { result.truncated = true; break outer; }
      result.accounts++;
      try {
        const snapshot = await repository.snapshot(account.user_id);
        if (!snapshot?.data) continue;
        const candidates = helpers.remindersBetween(snapshot.data, now - WINDOW, now).filter(item => !snapshot.data.reminderReceipts?.[item.key]);
        if (!candidates.length) continue;
        const devices = [];
        for (const row of await repository.subscriptions(account.user_id, config.keyId)) {
          try { validateSubscription(row.subscription); devices.push(row); }
          catch { await repository.unsubscribe(account.user_id, row.endpoint_hash); result.expired++; }
        }
        for (const candidate of candidates) {
          if (!devices.length) break;
          if (clock() - started > maxDuration) { result.truncated = true; break outer; }
          const reminder = await claimCurrent(repository, account.user_id, candidate.key, now);
          if (!reminder) { result.skipped++; continue; }
          // One account receipt = one recipient, matching the open-app behavior.
          // Pick the last explicitly activated device. Try another only when the
          // provider definitively says this endpoint no longer exists.
          while (devices.length) {
            const device = devices[0];
            try {
              await send(device.subscription, { type: 'zama-reminder', userId: account.user_id, key: reminder.key,
                title: String(reminder.title || 'Lembrete da agenda').slice(0, 120), body: String(reminder.body || '').slice(0, 450),
                day: reminder.task?.prazo || helpers.parts(reminder.dueAt).date, expiresAt: now + WINDOW });
              result.accepted++; break;
            } catch (error) {
              if ([404, 410].includes(error.statusCode)) {
                await repository.unsubscribe(account.user_id, device.endpoint_hash); devices.shift(); result.expired++; continue;
              }
              // Delivery may have reached the provider before a timeout. Keep the
              // receipt to avoid a duplicate; no unsafe blind retry.
              result.failed++; break;
            }
          }
        }
      } catch { result.failed++; }
    }
    if (accounts.length < 100) break;
    // Keyset pagination remains stable when expired subscriptions are deleted.
    after = accounts.at(-1).user_id;
  }
  return result;
}
function authorized(header, secret) {
  if (!secret || secret.length < 32) return false;
  const actual = Buffer.from(header || ''), expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function createHandler(dependencies = {}) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    const config = dependencies.config || configuration();
    if (!authorized(req.headers.authorization, config.cronSecret)) return send(401, { error: 'Não autorizado.' });
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'Método não permitido.' });
    if (!config.enabled) return send(503, { error: 'Lembretes em segundo plano desativados.' });
    try {
      const repository = dependencies.repository || createRepository(createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } }));
      const result = await dispatch({ repository, send: dependencies.send || createSender(config), config, ...(dependencies.clock ? { clock: dependencies.clock, now: dependencies.clock() } : {}) });
      return send(result.truncated || result.failed ? 207 : 200, result);
    } catch { return send(503, { error: 'Serviço de lembretes indisponível.' }); }
  };
}
module.exports = { createHandler, dispatch, claimCurrent, authorized };
