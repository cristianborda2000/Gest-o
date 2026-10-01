'use strict';
// Real local PostgreSQL (WASM): no Supabase project or production data is used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createRepository, empty } = require('../services/jarvis/repository');

const migration = readFileSync(resolve(__dirname, '../database/migrations/20260930_jarvis.sql'), 'utf8');
let db;

before(async () => {
  db = new PGlite();
  // Reproduce the existing app_state schema and authentication roles, without
  // executing the destructive legacy setup script.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    create table public.app_state(
      user_id uuid primary key references auth.users(id) on delete cascade,
      data jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    create function public.set_app_state_updated_at() returns trigger
      language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
    create trigger set_app_state_updated_at before update on public.app_state
      for each row execute function public.set_app_state_updated_at();
    alter table public.app_state enable row level security;
    alter table public.app_state force row level security;
    grant select, insert, update, delete on public.app_state to authenticated, service_role;
    create policy own_state on public.app_state to authenticated
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  `);
  await db.exec(migration);
});
after(async () => { await db?.close(); });

async function account(state) {
  const id = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [id]);
  if (state !== undefined) await db.query('insert into public.app_state(user_id,data) values ($1,$2)', [id, JSON.stringify(state)]);
  return id;
}
async function stateSnapshot(id) {
  return (await db.query('select data,updated_at::text as revision from public.app_state where user_id=$1', [id])).rows[0] || null;
}
async function jarvisSnapshot(id) {
  return (await db.query('select data,revision from public.jarvis_accounts where user_id=$1', [id])).rows[0] || null;
}
async function commit(id, revision, data, stateRevision = null, state) {
  return db.query('select public.jarvis_commit($1,$2,$3,$4,$5,$6) as revision', [
    id, revision, JSON.stringify(data), state !== undefined, stateRevision, state === undefined ? null : JSON.stringify(state)
  ]);
}
async function asRole(role, operation) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  try { return await operation(); } finally { await db.exec('reset role'); }
}

// An adapter of the small Supabase query surface; all persistence, SQL errors,
// transactions, constraints and permission checks execute in PostgreSQL.
function pgClient(onCommit) {
  return {
    from(table) {
      assert.ok(['jarvis_accounts', 'app_state'].includes(table));
      return { select() { return { eq(field, id) {
        assert.equal(field, 'user_id');
        return { async maybeSingle() {
          try {
            const columns = table === 'app_state' ? 'data, updated_at::text as updated_at' : 'data, revision';
            const result = await db.query(`select ${columns} from public.${table} where user_id=$1`, [id]);
            return { data: result.rows[0] || null, error: null };
          } catch (error) { return { data: null, error }; }
        } };
      } }; } };
    },
    async rpc(name, args) {
      try {
        let result;
        if (name === 'jarvis_commit') {
          await onCommit?.(args);
          result = await db.query('select public.jarvis_commit($1,$2,$3,$4,$5,$6) as value', [
            args.p_user_id, args.p_revision, JSON.stringify(args.p_data), args.p_write_state,
            args.p_state_revision, args.p_state === null ? null : JSON.stringify(args.p_state)
          ]);
        } else {
          assert.equal(name, 'jarvis_consume_rate');
          result = await db.query('select public.jarvis_consume_rate($1,$2,$3,$4) as value', [args.p_user_id, args.p_bucket, args.p_limit, args.p_window]);
        }
        return { data: result.rows[0].value, error: null };
      } catch (error) { return { data: null, error }; }
    }
  };
}

test('migration is additive, repeatable and preserves legacy business records', async () => {
  const original = {
    financeiro: [{ id: 'old-expense', descricao: 'Licença', valor: -35.25, status: 'Pago' }],
    agenda: [{ id: 'old-task', nome: 'Planejamento', prazo: '2026-09-30' }],
    clientes: [{ id: 'old-client', nome: 'Preservado' }],
    mensalidades: [{ id: 'old-subscription' }], projetos: [{ id: 'old-project' }],
    marketing: [{ id: 'old-campaign' }], equipe: [{ id: 'old-member' }]
  };
  const id = await account(original);
  const before = await stateSnapshot(id);
  await db.exec(migration);
  assert.deepEqual(await stateSnapshot(id), before);
  assert.equal(await jarvisSnapshot(id), null);
  await commit(id, 0, { ...empty(), memories: [{ content: 'Objetivo explícito' }] });
  assert.deepEqual(await stateSnapshot(id), before, 'read/chat-only commit cannot rewrite ERP data');
});

test('business state, conversation and action audit commit together', async () => {
  const id = await account({ agenda: [], unrelated: { keep: true } });
  const before = await stateSnapshot(id);
  const next = { ...before.data, agenda: [{ id: 'task-1', nome: 'Preparar proposta' }] };
  const record = { ...empty(), actions: [{ id: 'action-1', tool_name: 'create_task', status: 'executed' }], messages: [{ role: 'assistant', content: 'Tarefa criada.' }] };
  assert.equal((await commit(id, 0, record, before.revision, next)).rows[0].revision, 1);
  assert.deepEqual((await stateSnapshot(id)).data, next);
  assert.deepEqual((await jarvisSnapshot(id)).data, record);
});

test('stale Jarvis revision rejects the complete write without changing either row', async () => {
  const id = await account({ financeiro: [] });
  await commit(id, 0, { ...empty(), messages: [{ content: 'Primeiro' }] });
  const state = await stateSnapshot(id);
  const jarvis = await jarvisSnapshot(id);
  await assert.rejects(commit(id, 0, { actions: [{ id: 'stale' }] }, state.revision, { financeiro: [{ id: 'wrong' }] }), { code: '40001' });
  assert.deepEqual(await stateSnapshot(id), state);
  assert.deepEqual(await jarvisSnapshot(id), jarvis);
});

test('stale ERP revision cannot create audit-only success or overwrite newer frontend edits', async () => {
  const id = await account({ agenda: [] });
  const old = await stateSnapshot(id);
  await db.query('update public.app_state set data=$2 where user_id=$1', [id, JSON.stringify({ agenda: [{ id: 'frontend-task' }] })]);
  const current = await stateSnapshot(id);
  await assert.rejects(commit(id, 0, { actions: [{ id: 'must-not-save' }] }, old.revision, { agenda: [{ id: 'stale-task' }] }), { code: '40001' });
  assert.deepEqual(await stateSnapshot(id), current);
  assert.equal(await jarvisSnapshot(id), null, 'creation of the Jarvis account itself also rolls back');
});

test('a database failure in the business mutation rolls back both account and audit', async () => {
  const id = await account({ financeiro: [] });
  const before = await stateSnapshot(id);
  await db.exec(`
    create function public.test_reject_write() returns trigger language plpgsql as $$
      begin if new.data ? 'reject_test_write' then raise exception 'TEST_WRITE_FAILED'; end if; return new; end $$;
    create trigger test_reject_write before update on public.app_state for each row execute function public.test_reject_write();
  `);
  try {
    await assert.rejects(commit(id, 0, { actions: [{ status: 'executed' }] }, before.revision, { reject_test_write: true }), /TEST_WRITE_FAILED/);
    assert.deepEqual(await stateSnapshot(id), before);
    assert.equal(await jarvisSnapshot(id), null);
  } finally { await db.exec('drop trigger test_reject_write on public.app_state; drop function public.test_reject_write()'); }
});

test('first business write creates state; subsequent writes require the actual revision', async () => {
  const id = await account();
  await commit(id, 0, empty(), null, { ideias: [{ id: 'idea-1' }] });
  assert.equal((await stateSnapshot(id)).data.ideias.length, 1);
  await assert.rejects(commit(id, 1, empty(), null, { ideias: [] }), { code: '40001' });
  assert.equal((await stateSnapshot(id)).data.ideias.length, 1);
});

test('commit rejects null identity/revision/flags and invalid payload before any write', async () => {
  const id = await account({ agenda: [] });
  const before = await stateSnapshot(id);
  const valid = [id, 0, '{}', false, null, null];
  const invalid = [
    [0, null], [1, null], [1, -1], [2, null], [2, 'null'], [2, '[]'], [2, '"text"'], [3, null]
  ];
  for (const [index, value] of invalid) {
    const args = [...valid]; args[index] = value;
    await assert.rejects(db.query('select public.jarvis_commit($1,$2,$3,$4,$5,$6)', args), /JARVIS_INVALID_DATA/);
  }
  for (const state of [null, 'null', '[]']) {
    await assert.rejects(db.query('select public.jarvis_commit($1,$2,$3,$4,$5,$6)', [id, 0, '{}', true, before.revision, state]), /JARVIS_INVALID_STATE/);
  }
  assert.equal(await jarvisSnapshot(id), null);
  assert.deepEqual(await stateSnapshot(id), before);
});

test('rate RPC rejects null or invalid arguments without consuming a bucket', async () => {
  const id = await account();
  const valid = [id, 'message', 20, 60];
  for (const [index, value] of [[0, null], [1, null], [1, ''], [1, '   '], [1, 'x'.repeat(81)], [2, null], [2, 0], [2, -1], [3, null], [3, 0], [3, -1]]) {
    const args = [...valid]; args[index] = value;
    await assert.rejects(db.query('select public.jarvis_consume_rate($1,$2,$3,$4)', args), /JARVIS_INVALID_RATE/);
  }
  assert.equal((await db.query('select * from public.jarvis_rate_limits where user_id=$1', [id])).rows.length, 0);
});

test('anon and authenticated roles cannot call RPCs or read private Jarvis tables', async () => {
  const id = await account({ agenda: [] });
  await commit(id, 0, empty());
  for (const role of ['anon', 'authenticated']) {
    await asRole(role, async () => {
      await assert.rejects(db.query('select * from public.jarvis_accounts where user_id=$1', [id]), { code: '42501' });
      await assert.rejects(db.query('select * from public.jarvis_rate_limits'), { code: '42501' });
      await assert.rejects(commit(id, 1, empty()), { code: '42501' });
      await assert.rejects(db.query('select public.jarvis_consume_rate($1,$2,$3,$4)', [id, 'message', 20, 60]), { code: '42501' });
    });
  }
  await asRole('service_role', async () => {
    assert.equal((await commit(id, 1, empty())).rows[0].revision, 2);
    assert.equal((await db.query('select revision from public.jarvis_accounts where user_id=$1', [id])).rows[0].revision, 2);
  });
});

test('existing ERP row-level policy and user-bound repositories isolate accounts', async () => {
  const a = await account({ agenda: [{ id: 'A-private' }] });
  const b = await account({ agenda: [{ id: 'B-private' }] });
  await commit(a, 0, { ...empty(), conversations: [{ id: 'A-conversation' }] });
  await commit(b, 0, { ...empty(), conversations: [{ id: 'B-conversation' }] });
  const repoA = createRepository(pgClient(), a);
  const repoB = createRepository(pgClient(), b);
  assert.equal((await repoA.read()).jarvis.conversations[0].id, 'A-conversation');
  assert.equal((await repoB.read()).state.agenda[0].id, 'B-private');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [a]);
  await asRole('authenticated', async () => {
    assert.equal((await db.query('select * from public.app_state where user_id=$1', [b])).rows.length, 0);
    assert.equal((await db.query('select * from public.app_state where user_id=$1', [a])).rows.length, 1);
    assert.equal((await db.query("update public.app_state set data='{}' where user_id=$1 returning user_id", [b])).rows.length, 0);
  });
  assert.equal((await stateSnapshot(b)).data.agenda[0].id, 'B-private');
});

test('rate limits persist across repository instances and isolate users and buckets', async () => {
  const a = await account(); const b = await account();
  await createRepository(pgClient(), a).consumeRate('message-minute', 2, 60);
  await createRepository(pgClient(), a).consumeRate('message-minute', 2, 60);
  await assert.rejects(createRepository(pgClient(), a).consumeRate('message-minute', 2, 60), { status: 429, code: 'RATE_LIMITED' });
  await createRepository(pgClient(), b).consumeRate('message-minute', 2, 60);
  await createRepository(pgClient(), a).consumeRate('voice-minute', 1, 60);
  await db.query("update public.jarvis_rate_limits set started_at=clock_timestamp()-interval '61 seconds' where user_id=$1 and bucket='message-minute'", [a]);
  await createRepository(pgClient(), a).consumeRate('message-minute', 2, 60);
  assert.equal((await db.query("select hits from public.jarvis_rate_limits where user_id=$1 and bucket='message-minute'", [a])).rows[0].hits, 1);
});

test('repository retries conflict against fresh data without losing existing records', async () => {
  const id = await account({ agenda: [] });
  let injected = false; let attempts = 0;
  const repository = createRepository(pgClient(async () => {
    if (injected) return;
    injected = true;
    await db.query('update public.app_state set data=$2 where user_id=$1', [id, JSON.stringify({ agenda: [{ id: 'concurrent-frontend-task' }] })]);
  }), id);
  const result = await repository.transact(snapshot => {
    attempts++;
    snapshot.state.agenda.push({ id: 'jarvis-task' });
    snapshot.jarvis.actions.push({ id: 'stable-operation-id', status: 'executed' });
    return { writeState: true, result: 'created' };
  });
  assert.equal(result, 'created'); assert.equal(attempts, 2);
  assert.deepEqual((await stateSnapshot(id)).data.agenda.map(task => task.id), ['concurrent-frontend-task', 'jarvis-task']);
  assert.equal((await jarvisSnapshot(id)).data.actions.length, 1);
});

test('persisted action identity can reject replay without a second business mutation', async () => {
  const id = await account({ financeiro: [] });
  const mutate = snapshot => {
    const action = snapshot.jarvis.actions.find(item => item.id === 'confirmed-id');
    if (action) return { unchanged: true, result: action.result };
    const result = { movementId: 'expense-350' };
    snapshot.state.financeiro.push({ id: result.movementId, valor: -350, amountCents: 35000, status: 'Pago' });
    snapshot.jarvis.actions.push({ id: 'confirmed-id', status: 'executed', result });
    return { writeState: true, result };
  };
  const first = await createRepository(pgClient(), id).transact(mutate);
  const second = await createRepository(pgClient(), id).transact(mutate);
  assert.deepEqual(first, second);
  assert.equal((await stateSnapshot(id)).data.financeiro.length, 1);
  assert.equal((await jarvisSnapshot(id)).revision, 1);
});

test('conversation history survives creating a fresh repository instance', async () => {
  const id = await account();
  await createRepository(pgClient(), id).transact(snapshot => {
    snapshot.jarvis.conversations.push({ id: 'conversation-1', title: 'Meu dia' });
    snapshot.jarvis.messages.push({ id: 'message-1', conversation_id: 'conversation-1', role: 'user', content: 'Como está meu dia?' });
    return { result: true };
  });
  const reloaded = await createRepository(pgClient(), id).read();
  assert.equal(reloaded.jarvis.conversations[0].title, 'Meu dia');
  assert.equal(reloaded.jarvis.messages[0].content, 'Como está meu dia?');
  assert.equal(await stateSnapshot(id), null);
});

test('real agent + services + PostgreSQL confirmation is atomic and idempotent across retries', async () => {
  const { createAgent } = require('../services/jarvis/agent');
  const { configuration } = require('../services/jarvis/config');
  const id = await account({ financeiro: [], agenda: [], clientes: [{ id: 'preserved' }] });
  let turn = 0, mutateDuringConfirmation = false, conflictInjected = false;
  const client = pgClient(async args => {
    if (!mutateDuringConfirmation || conflictInjected || !args.p_write_state) return;
    conflictInjected = true;
    // Change only that field atomically. A real UI uses updated_at CAS, so it
    // likewise cannot overwrite a concurrently committed financial movement.
    await db.query("update public.app_state set data=jsonb_set(data,'{agenda}',coalesce(data->'agenda','[]'::jsonb) || $2::jsonb) where user_id=$1", [id, JSON.stringify([{ id: 'frontend-edit', nome: 'Preservar edição concorrente' }])]);
  });
  const repository = createRepository(client, id);
  // Only inference is simulated; these are the actual agent, tools, repository and SQL.
  const provider = { responses: { create: async () => turn++ === 0 ? {
    output: [{ type: 'function_call', call_id: 'expense', name: 'register_expense', arguments: JSON.stringify({ amount: 350, category: 'Marketing', description: 'Anúncios', date: 'hoje' }) }]
  } : { output: [], output_text: 'Confira a confirmação.' } } };
  const config = { ...configuration({}), enabled: true, model: 'test-model' };
  const agent = createAgent({ repository, config, provider, clock: () => new Date('2026-09-30T12:00:00-03:00') });
  const body = { message: 'Registra R$350 de marketing.', request_id: randomUUID() };
  const prepared = await agent.send(body), actionId = prepared.actions[0].id;
  assert.equal(prepared.actions[0].status, 'pending');
  assert.equal((await stateSnapshot(id)).data.financeiro.length, 0);
  mutateDuringConfirmation = true;
  await Promise.all([agent.confirm(actionId, true), agent.confirm(actionId, true)]);
  await agent.confirm(actionId, true);
  await agent.send(body);
  const data = (await stateSnapshot(id)).data;
  assert.equal(data.financeiro.length, 1);
  assert.equal(data.financeiro[0].valor, -350);
  assert.equal(data.financeiro[0].jarvisActionId, actionId);
  assert.equal(data.agenda[0].id, 'frontend-edit');
  assert.equal(data.clientes[0].id, 'preserved');
  const fresh = createAgent({ repository: createRepository(pgClient(), id), config, provider });
  const history = await fresh.conversation(prepared.conversation.id);
  assert.equal(history.actions.length, 1);
  assert.equal(history.actions[0].status, 'executed');
  assert.ok(history.actions[0].confirmed_at);
  assert.equal(history.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(turn, 2, 'request retry must not repeat inference');
});
