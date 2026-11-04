'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createService } = require('../services/dot/service');
const { dispatch } = require('../services/reminders/dispatcher');
// Fixed public curve point and dummy bytes only. No private key or real subscription.
const publicPoint = Buffer.from('046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5', 'hex').toString('base64url');
async function scenario({ enabled = true, devices = true, date = '2026-11-05', time = '10:00' } = {}) {
  const owner = randomUUID(); let revision = 0, saved = { state: { agendaSettings: { enabled, dailyEnabled: false, taskEnabled: true, leadMinutes: 15 } }, jarvis: { actions: [] } };
  const domain = { userId: owner, read: async () => structuredClone(saved), transact: async fn => { const copy = structuredClone(saved), change = fn(copy); if (!change.unchanged) { if (!change.writeState) copy.state = saved.state; saved = copy; revision++; } return structuredClone(change.result); } };
  const api = createService({ repository: domain, ownerId: owner, origin: 'https://zama.example', clock: () => new Date('2026-11-04T12:00:00Z') });
  await api.call({ name: 'create_agenda_event', arguments: { title: 'Compromisso fictício', date, time, reminder_minutes: 60 }, request_id: randomUUID() });
  const subscriptions = devices ? [{ endpoint_hash: 'fixture', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fictional-never-contacted', expirationTime: null, keys: { p256dh: publicPoint, auth: Buffer.alloc(16).toString('base64url') } } }] : [];
  const repository = {
    accounts: async (_key, after) => after ? [] : [{ user_id: owner }],
    snapshot: async user => { assert.equal(user, owner); return { data: structuredClone(saved.state), updated_at: String(revision) }; },
    subscriptions: async () => subscriptions,
    unsubscribe: async () => { subscriptions.length = 0; },
    claim: async (_user, expected, key, at) => { if (expected !== String(revision) || saved.state.reminderReceipts?.[key]) return false; saved.state.reminderReceipts = { ...saved.state.reminderReceipts, [key]: at }; revision++; return true; }
  };
  return { owner, repository, state: () => saved.state, mutate(fn) { fn(saved.state); revision++; } };
}
const at = Date.parse('2026-11-05T09:00:20-03:00');
test('dot → agenda → dispatcher: duas execuções concorrentes enviam uma vez ao remetente falso às 9h', async () => {
  const s = await scenario(), calls = [], params = { repository: s.repository, config: { keyId: 'fixture' }, now: at, send: async (_device, payload) => calls.push(payload) };
  assert.equal((await dispatch({ ...params, now: at - 60000 })).accepted, 0);
  const result = await Promise.all([dispatch(params), dispatch(params)]);
  assert.equal(result.reduce((sum, r) => sum + r.accepted, 0), 1); assert.equal(calls.length, 1); assert.equal(calls[0].userId, s.owner); assert.equal(calls[0].day, '2026-11-05');
  await dispatch(params); assert.equal(calls.length, 1); assert.equal(s.state().agendaSettings.leadMinutes, 15);
});
test('sem dispositivo ou com agenda pausada, configuração de 60 minutos não produz envio', async () => {
  for (const options of [{ devices: false }, { enabled: false }]) {
    const s = await scenario(options); let calls = 0;
    const result = await dispatch({ repository: s.repository, config: { keyId: 'fixture' }, now: at, send: async () => { calls++; } });
    assert.equal(calls, 0); assert.equal(result.accepted, 0); assert.equal(s.state().agenda[0].reminderMinutes, 60);
  }
});
test('conclusão e reagendamento antes da reivindicação invalidam o aviso já identificado', async () => {
  for (const change of [state => { state.agenda[0].status = 'Concluído'; }, state => { state.agenda[0].hora = '11:00'; }]) {
    const s = await scenario(), original = s.repository.subscriptions;
    s.repository.subscriptions = async () => { s.mutate(change); return original(); };
    const result = await dispatch({ repository: s.repository, config: { keyId: 'fixture' }, now: at, send: async () => assert.fail('Não pode enviar após mudança') });
    assert.equal(result.accepted, 0); assert.equal(result.skipped, 1);
  }
});
test('timeout do remetente falso permanece incerto e não causa repetição; janela perdida não é recuperada', async () => {
  const s = await scenario(); let calls = 0;
  const params = { repository: s.repository, config: { keyId: 'fixture' }, now: at, send: async () => { calls++; throw new Error('synthetic timeout'); } };
  assert.equal((await dispatch(params)).failed, 1); await dispatch(params); assert.equal(calls, 1);
  const missed = await scenario();
  assert.equal((await dispatch({ ...params, repository: missed.repository, now: at + 180000 })).accepted, 0); assert.equal(calls, 1);
});
test('aviso uma hora antes de 00:30 ocorre no dia anterior e aponta para o dia do compromisso', async () => {
  const s = await scenario({ time: '00:30' }), calls = [];
  const result = await dispatch({ repository: s.repository, config: { keyId: 'fixture' }, now: Date.parse('2026-11-04T23:30:20-03:00'), send: async (_device, payload) => calls.push(payload) });
  assert.equal(result.accepted, 1); assert.equal(calls[0].day, '2026-11-05');
});
