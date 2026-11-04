'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createRepository } = require('../services/jarvis/repository');
const { createService } = require('../services/dot/service');
test('dot + repository + PostgreSQL real: conflito, confirmação e nova instância preservam dados', async () => {
  const db = new PGlite(), owner = randomUUID(), other = randomUUID(); let injectConflict = false;
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create table app_state(user_id uuid primary key references auth.users(id),data jsonb not null default '{}'::jsonb,updated_at timestamptz not null default now());`);
    await db.exec(readFileSync(resolve(__dirname, '../database/migrations/20260930_jarvis.sql'), 'utf8'));
    await db.query('insert into auth.users values ($1),($2)', [owner, other]);
    await db.query('insert into app_state(user_id,data) values($1,$2),($3,$4)', [owner, JSON.stringify({ clientes: [{ id: 'preservado' }] }), other, JSON.stringify({ agenda: [{ id: 'privado' }] })]);
    const client = {
      from(table) {
        assert.ok(['app_state', 'jarvis_accounts'].includes(table));
        return { select: () => ({ eq: (column, user) => ({ maybeSingle: async () => {
          assert.equal(column, 'user_id');
          const sql = table === 'app_state' ? 'select data,updated_at::text as updated_at from app_state where user_id=$1' : 'select data,revision from jarvis_accounts where user_id=$1';
          return { data: (await db.query(sql, [user])).rows[0] || null };
        } }) }) };
      },
      async rpc(name, args) {
        assert.equal(name, 'jarvis_commit');
        if (injectConflict && args.p_write_state) {
          injectConflict = false;
          await db.query("update app_state set data=jsonb_set(data,'{agenda}',$2::jsonb),updated_at=clock_timestamp() where user_id=$1", [owner, JSON.stringify([{ id: 'frontend-concorrente', nome: 'Preservar' }])]);
        }
        try { return { data: (await db.query('select jarvis_commit($1,$2,$3,$4,$5,$6) as value', [args.p_user_id, args.p_revision, JSON.stringify(args.p_data), args.p_write_state, args.p_state_revision, args.p_state == null ? null : JSON.stringify(args.p_state)])).rows[0].value }; }
        catch (error) { return { error }; }
      }
    };
    const make = () => createService({ repository: createRepository(client, owner), ownerId: owner, origin: 'https://zama.example' });
    const request = { name: 'prepare_expense', arguments: { amount: 25, description: 'Teste isolado', category: 'Marketing' }, request_id: randomUUID() };
    const service = make(), pending = await service.call(request), preview = await service.preview(pending.action_id);
    assert.equal((await db.query('select data from app_state where user_id=$1', [owner])).rows[0].data.financeiro, undefined);
    injectConflict = true;
    const confirmation = { confirmation: true, confirmation_digest: preview.confirmation_digest };
    await Promise.all([service.decide(pending.action_id, confirmation), make().decide(pending.action_id, confirmation)]);
    assert.equal((await make().call(request)).status, 'executed');
    const state = (await db.query('select data from app_state where user_id=$1', [owner])).rows[0].data;
    assert.equal(state.financeiro.length, 1); assert.equal(state.financeiro[0].valor, -25); assert.equal(state.agenda[0].id, 'frontend-concorrente'); assert.equal(state.clientes[0].id, 'preservado');
    const audit = (await db.query('select data from jarvis_accounts where user_id=$1', [owner])).rows[0].data.actions;
    assert.equal(audit.length, 1); assert.equal(audit[0].status, 'executed'); assert.equal(audit[0].confirmed_by, owner);
    assert.equal((await db.query('select data from app_state where user_id=$1', [other])).rows[0].data.agenda[0].id, 'privado');
    await make().call({ name: 'create_task', arguments: { title: 'Tarefa persistida', date: '2026-11-10' }, request_id: randomUUID() });
    await make().call({ name: 'create_agenda_event', arguments: { title: 'Compromisso persistido', date: '2026-11-10', time: '10:00', reminder_minutes: 60 }, request_id: randomUUID() });
    await make().call({ name: 'save_idea', arguments: { title: 'Ideia persistida' }, request_id: randomUUID() });
    const tasks = await make().call({ name: 'get_agenda', arguments: { from: '2026-11-10', to: '2026-11-10' }, request_id: randomUUID() });
    const ideas = await make().call({ name: 'search_ideas', arguments: { query: 'persistida' }, request_id: randomUUID() });
    assert.equal(tasks.result.tasks.length, 2); assert.equal(ideas.result.total, 1);
    const finalState = (await db.query('select data from app_state where user_id=$1', [owner])).rows[0].data;
    assert.equal(finalState.financeiro.length, 1); assert.equal(finalState.agenda.find(row => row.nome === 'Compromisso persistido').reminderMinutes, 60);
    assert.equal(finalState.clientes[0].id, 'preservado');
  } finally { await db.close(); }
});
