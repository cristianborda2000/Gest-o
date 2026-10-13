'use strict';
// Real PostgreSQL/WASM with pgcrypto: authorization and ciphertext are not mocked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const migration = fs.readFileSync('database/migrations/20261012_projects.sql', 'utf8');
let db;

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    create table public.app_state(user_id uuid primary key references auth.users(id),data jsonb not null default '{}',updated_at timestamptz default now());
    alter table public.app_state enable row level security; alter table public.app_state force row level security;
    grant select,insert,update,delete on public.app_state to authenticated;
    create policy own on public.app_state to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);`);
  await db.exec(fs.readFileSync('database/migrations/20261005_workspaces.sql', 'utf8'));
  await db.exec(migration);
});
after(async () => db?.close());

async function as(id, fn) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
const save = (user, owner, data) => as(user, () => rpc('select zama_project_save($1,$2) result', [owner, JSON.stringify(data)]));
const list = (user, owner) => as(user, () => rpc('select zama_projects_list($1) result', [owner]));
const secret = (user, owner, id) => as(user, () => rpc('select zama_project_secret($1,$2) result', [owner, id]));
const denied = { code: '42501' };
async function user(confirmed = true) {
  const id = randomUUID(), email = `${id}@zama.test`;
  await db.query('insert into auth.users values($1,$2,$3)', [id, email, confirmed ? new Date().toISOString() : null]);
  return { id, email };
}
async function fixture(role = 'projects') {
  const owner = await user(), member = await user(), stranger = await user();
  await db.query('insert into app_state(user_id,data) values($1,$2)', [owner.id, JSON.stringify({ companyProfile: { nome: 'Empresa privada' }, financeiro: [{ id: 'preservado', valor: 15000 }] })]);
  await db.query('insert into zama_workspace_members(owner_id,user_id,role) values($1,$2,$3)', [owner.id, member.id, role]);
  const project = await save(owner.id, owner.id, {
    title: 'Catálogo cliente', client_name: 'Maria', company_name: 'Loja Maria', client_email: 'loja@zama.test',
    password: 'Segredo-exclusivo!123', responsible_email: member.email.toUpperCase(), responsible_name: 'Responsável',
    access_url: 'https://example.test/login', due_date: '2026-11-02', notes: 'Validar fotos',
    catalog_steps: [{ id: 'photos', label: 'Cadastrar fotos', done: false }],
    onboarding_steps: [{ id: 'profile', label: 'Estruturar perfil', done: false }]
  });
  return { owner, member, stranger, project };
}

test('migration is repeatable, preserves business state and preserves the existing encryption key', async () => {
  const { owner, project } = await fixture();
  const state = await db.query('select * from app_state where user_id=$1', [owner.id]);
  const key = await db.query('select secret from zama_private.project_key');
  await db.exec(migration);
  assert.deepEqual(await db.query('select secret from zama_private.project_key'), key);
  assert.deepEqual(await db.query('select * from app_state where user_id=$1', [owner.id]), state);
  assert.equal(await secret(owner.id, owner.id, project.id), 'Segredo-exclusivo!123');
});

test('project invitations use the existing verified-email acceptance flow and deny company data', async () => {
  const { owner, stranger } = await fixture();
  const pending = await save(owner.id, owner.id, { title: 'Aguardando convite', client_name: 'Cliente convidado', responsible_email: stranger.email });
  assert.deepEqual(await list(stranger.id, owner.id), []);
  const invite = await as(owner.id, () => rpc('select zama_workspace_invite($1,$2) result', [stranger.email.toUpperCase(), 'projects']));
  assert.equal(await as(stranger.id, () => rpc('select zama_workspace_accept($1) result', [invite.token])), owner.id);
  const workspaces = await as(stranger.id, () => db.query('select * from zama_workspace_list()'));
  assert.equal(workspaces.rows.find(row => row.owner_id === owner.id).role, 'projects');
  assert.deepEqual((await list(stranger.id, owner.id)).map(row => row.id), [pending.id]);
  assert.equal(await as(stranger.id, () => rpc('select zama_workspace_access($1,false) result', [owner.id])), false);
  assert.equal(await as(stranger.id, () => rpc('select zama_workspace_access($1,true) result', [owner.id])), false);
  assert.equal((await as(stranger.id, () => db.query('select * from app_state where user_id=$1', [owner.id]))).rows.length, 0);
  assert.equal((await as(stranger.id, () => db.query("update app_state set data='{}' where user_id=$1 returning user_id", [owner.id]))).rows.length, 0);
  assert.equal((await as(stranger.id, () => db.query('delete from app_state where user_id=$1 returning user_id', [owner.id]))).rows.length, 0);
  await assert.rejects(as(stranger.id, () => db.query("insert into app_state(user_id,data) values($1,'{}')", [owner.id])), denied);
});

test('only owner and assigned current members list each project; a finance editor is not implicitly authorized', async () => {
  const { owner, member, stranger, project } = await fixture();
  const unassigned = await save(owner.id, owner.id, { title: 'Somente proprietário', client_name: 'Cliente privado', password: 'Outro segredo' });
  await db.query("insert into zama_workspace_members(owner_id,user_id,role) values($1,$2,'editor')", [owner.id, stranger.id]);
  assert.equal((await list(owner.id, owner.id)).length, 2);
  assert.deepEqual((await list(member.id, owner.id)).map(row => row.id), [project.id]);
  assert.deepEqual(await list(stranger.id, owner.id), []);
  await assert.rejects(secret(member.id, owner.id, unassigned.id), denied);
  await assert.rejects(secret(stranger.id, owner.id, project.id), denied);
  await assert.rejects(save(stranger.id, owner.id, { ...project, notes: 'Intruso' }), denied);
  await assert.rejects(save(member.id, owner.id, { title: 'Novo não autorizado' }), denied);
});

test('responsible can advance both tracks and notes, but cannot alter protected fields or delete', async () => {
  const { owner, member, stranger, project } = await fixture();
  const advanced = await save(member.id, owner.id, {
    ...project, status: 'in_progress', notes: 'Fotos recebidas',
    catalog_steps: [{ ...project.catalog_steps[0], done: true }],
    onboarding_steps: [{ ...project.onboarding_steps[0], done: true }]
  });
  assert.equal(advanced.revision, 2);
  assert.equal(advanced.catalog_steps[0].done, true);
  assert.equal(advanced.onboarding_steps[0].done, true);
  assert.equal(await secret(member.id, owner.id, project.id), 'Segredo-exclusivo!123');
  for (const change of [
    { responsible_email: stranger.email }, { responsible_name: 'Outra pessoa' }, { password: '' },
    { title: 'Alterado' }, { client_email: 'changed@zama.test' }, { access_url: 'https://evil.test' },
    { client_name: 'Outro' }, { company_name: 'Outra' }, { due_date: '2026-12-31' }
  ]) await assert.rejects(save(member.id, owner.id, { id: project.id, revision: advanced.revision, ...change }), denied);
  await assert.rejects(as(member.id, () => rpc('select zama_project_delete($1,$2) result', [owner.id, project.id])), denied);
});

test('viewer may inspect assigned progress but cannot reveal passwords or mutate anything', async () => {
  const { owner, member, project } = await fixture('viewer');
  assert.equal((await list(member.id, owner.id))[0].id, project.id);
  await assert.rejects(secret(member.id, owner.id, project.id), denied);
  await assert.rejects(save(member.id, owner.id, { ...project, status: 'completed' }), denied);
  await as(owner.id, () => rpc('select zama_workspace_set_role($1,$2) result', [member.id, 'editor']));
  assert.equal(await secret(member.id, owner.id, project.id), 'Segredo-exclusivo!123');
  await as(owner.id, () => rpc('select zama_workspace_set_role($1,$2) result', [member.id, 'projects']));
  assert.equal((await as(member.id, () => db.query('select * from app_state where user_id=$1', [owner.id]))).rows.length, 0);
});

test('restricting a member to projects invalidates earlier invitations that could restore company access', async () => {
  const { owner, member, stranger, project } = await fixture('editor');
  const invite = await as(owner.id, () => rpc('select zama_workspace_invite($1,$2) result', [member.email, 'editor']));
  await as(stranger.id, () => rpc('select zama_workspace_set_role($1,$2) result', [member.id, 'projects']));
  assert.equal((await db.query('select revoked_at from zama_workspace_invites where id=$1', [invite.id])).rows[0].revoked_at, null);
  await as(owner.id, () => rpc('select zama_workspace_set_role($1,$2) result', [member.id, 'projects']));
  await assert.rejects(as(member.id, () => rpc('select zama_workspace_accept($1) result', [invite.token])), { code: 'P0001' });
  assert.equal((await as(member.id, () => db.query('select * from app_state where user_id=$1', [owner.id]))).rows.length, 0);
  assert.deepEqual((await list(member.id, owner.id)).map(row => row.id), [project.id]);
});

test('removing a member invalidates pending invitations before they can restore project access', async () => {
  const { owner, member, stranger, project } = await fixture();
  const invite = await as(owner.id, () => rpc('select zama_workspace_invite($1,$2) result', [member.email, 'projects']));
  await as(stranger.id, () => rpc('select zama_workspace_revoke($1) result', [member.id]));
  assert.equal((await db.query('select revoked_at from zama_workspace_invites where id=$1', [invite.id])).rows[0].revoked_at, null);
  await as(owner.id, () => rpc('select zama_workspace_revoke($1) result', [member.id]));
  await assert.rejects(as(member.id, () => rpc('select zama_workspace_accept($1) result', [invite.token])), { code: 'P0001' });
  assert.deepEqual(await list(member.id, owner.id), []);
  await assert.rejects(secret(member.id, owner.id, project.id), denied);
  const replacement = await as(owner.id, () => rpc('select zama_workspace_invite($1,$2) result', [member.email, 'projects']));
  assert.equal(await as(member.id, () => rpc('select zama_workspace_accept($1) result', [replacement.token])), owner.id);
  assert.deepEqual((await list(member.id, owner.id)).map(row => row.id), [project.id]);
});

test('passwords use ciphertext, stay out of list/save results and app_state, and require explicit replacement', async () => {
  const { owner, project } = await fixture();
  const stored = (await db.query('select password_cipher from zama_projects where id=$1', [project.id])).rows[0].password_cipher;
  assert.ok(stored.length > 20);
  assert.ok(!Buffer.from(stored).includes(Buffer.from('Segredo-exclusivo!123')));
  assert.equal(project.has_password, true);
  assert.ok(!Object.hasOwn(project, 'password'));
  assert.ok(!Object.hasOwn(project, 'password_cipher'));
  assert.ok(!JSON.stringify(await list(owner.id, owner.id)).includes('Segredo-exclusivo'));
  assert.ok(!JSON.stringify((await db.query('select data from app_state where user_id=$1', [owner.id])).rows).includes('Segredo-exclusivo'));
  const changed = await save(owner.id, owner.id, { id: project.id, revision: project.revision, notes: 'Sem alterar senha' });
  assert.equal(await secret(owner.id, owner.id, project.id), 'Segredo-exclusivo!123');
  const replacement = await save(owner.id, owner.id, { id: project.id, revision: changed.revision, password: 'Nova senha' });
  assert.equal(await secret(owner.id, owner.id, project.id), 'Nova senha');
  const cleared = await save(owner.id, owner.id, { id: project.id, revision: replacement.revision, password: '' });
  assert.equal(cleared.has_password, false);
  assert.equal(await secret(owner.id, owner.id, project.id), '');
});

test('stale project revisions fail atomically without overwriting progress or credentials', async () => {
  const { owner, member, project } = await fixture();
  const fresh = await save(member.id, owner.id, { id: project.id, revision: project.revision, notes: 'Edição concorrente' });
  await assert.rejects(save(owner.id, owner.id, { ...project, password: 'Senha antiga', notes: 'Perderia edição' }), { code: '40001' });
  await assert.rejects(save(owner.id, owner.id, { id: project.id, notes: 'Sem revisão' }), { code: '40001' });
  assert.deepEqual((await list(owner.id, owner.id))[0], fresh);
  assert.equal(await secret(owner.id, owner.id, project.id), 'Segredo-exclusivo!123');
});

test('revocation, email changes and removal of email confirmation remove access immediately', async () => {
  const { owner, member, project } = await fixture();
  await db.query('update auth.users set email_confirmed_at=null where id=$1', [member.id]);
  assert.deepEqual(await list(member.id, owner.id), []);
  await assert.rejects(secret(member.id, owner.id, project.id), denied);
  await db.query('update auth.users set email_confirmed_at=now(),email=$2 where id=$1', [member.id, 'changed@zama.test']);
  assert.deepEqual(await list(member.id, owner.id), []);
  await db.query('update auth.users set email=$2 where id=$1', [member.id, member.email]);
  assert.equal((await list(member.id, owner.id)).length, 1);
  await as(owner.id, () => rpc('select zama_workspace_revoke($1) result', [member.id]));
  assert.deepEqual(await list(member.id, owner.id), []);
  await assert.rejects(secret(member.id, owner.id, project.id), denied);
  await assert.rejects(save(member.id, owner.id, { ...project, notes: 'Após revogação' }), denied);
});

test('assignment changes revoke the former responsible and grant only the newly assigned member', async () => {
  const { owner, member, stranger, project } = await fixture();
  await db.query("insert into zama_workspace_members(owner_id,user_id,role) values($1,$2,'projects')", [owner.id, stranger.id]);
  const reassigned = await save(owner.id, owner.id, { id: project.id, revision: project.revision, responsible_email: stranger.email });
  assert.deepEqual(await list(member.id, owner.id), []);
  await assert.rejects(secret(member.id, owner.id, project.id), denied);
  assert.deepEqual((await list(stranger.id, owner.id))[0], reassigned);
  assert.equal(await secret(stranger.id, owner.id, project.id), 'Segredo-exclusivo!123');
});

test('cross-tenant owner parameters and project IDs never grant another company access', async () => {
  const a = await fixture(), b = await fixture();
  assert.deepEqual(await list(a.owner.id, b.owner.id), []);
  await assert.rejects(secret(a.owner.id, b.owner.id, b.project.id), denied);
  await assert.rejects(secret(a.owner.id, a.owner.id, b.project.id), denied);
  await assert.rejects(save(a.owner.id, b.owner.id, { ...b.project, notes: 'Outra empresa' }), denied);
  await assert.rejects(save(a.owner.id, a.owner.id, { ...b.project, notes: 'Trocar empresa' }), { code: '40001' });
  await assert.rejects(as(a.owner.id, () => rpc('select zama_project_delete($1,$2) result', [b.owner.id, b.project.id])), denied);
  await as(a.owner.id, () => rpc('select zama_project_delete($1,$2) result', [a.owner.id, b.project.id]));
  assert.equal((await list(b.owner.id, b.owner.id))[0].id, b.project.id);
});

test('direct table/key/helper access is denied even to authenticated owners; anon cannot invoke RPCs', async () => {
  const { owner, project } = await fixture();
  for (const query of [
    'select * from zama_projects', 'select * from zama_private.project_key',
    "select zama_private.project_encrypt('plaintext')", "select zama_private.project_decrypt('x'::bytea)",
    'delete from zama_projects', "update zama_projects set responsible_email='attacker@zama.test'"
  ]) await assert.rejects(as(owner.id, () => db.query(query)), denied);
  await db.exec('set role anon');
  try {
    for (const [query, args] of [
      ['select zama_projects_list($1)', [owner.id]], ['select zama_project_save($1,$2)', [owner.id, '{}']],
      ['select zama_project_secret($1,$2)', [owner.id, project.id]], ['select zama_project_delete($1,$2)', [owner.id, project.id]]
    ]) await assert.rejects(db.query(query, args), denied);
  } finally { await db.exec('reset role'); }
  await db.exec('set role service_role');
  try { await assert.rejects(db.query('select * from zama_private.project_key'), denied); }
  finally { await db.exec('reset role'); }
});

test('invalid data, extra checklist payloads and duplicate task IDs fail before persistence', async () => {
  const { owner, project } = await fixture();
  for (const change of [
    { title: '' }, { title: null }, { status: 'unknown' }, { responsible_email: 'invalid' },
    { access_url: 'javascript:alert(1)' }, { password: null }, { password: 'x'.repeat(4097) },
    { catalog_steps: {} }, { catalog_steps: [{ id: 'x', label: 'X', done: 'true' }] },
    { catalog_steps: [{ id: 'x', label: 'X', done: true, password: 'secret' }] },
    { onboarding_steps: [{ id: 'x', label: 'X', done: true }, { id: 'x', label: 'Y', done: false }] }
  ]) await assert.rejects(save(owner.id, owner.id, { id: project.id, revision: project.revision, ...change }), { code: '22023' });
  assert.deepEqual((await list(owner.id, owner.id))[0], project);
  await as(owner.id, () => rpc('select zama_project_delete($1,$2) result', [owner.id, project.id]));
  assert.deepEqual(await list(owner.id, owner.id), []);
  await assert.rejects(secret(owner.id, owner.id, project.id), denied);
  await assert.rejects(save(owner.id, owner.id, project), { code: '40001' });
});

test('client names are required on creation and protected from blank updates while partial saves preserve them', async () => {
  const { owner, member, project } = await fixture();
  for (const client_name of [undefined, '', '   ', '\t\r\n', null, 123]) {
    await assert.rejects(save(owner.id, owner.id, { title: 'Sem cliente', client_name }), { code: '22023' });
  }
  for (const client_name of ['', '   ', '\t\r\n', null, 123]) {
    await assert.rejects(save(owner.id, owner.id, {
      id: project.id, revision: project.revision, client_name, password: 'Não gravar'
    }), { code: '22023' });
  }
  await assert.rejects(save(owner.id, owner.id, { title: '\t\r\n', client_name: 'Cliente' }), { code: '22023' });
  assert.deepEqual((await list(owner.id, owner.id))[0], project);
  assert.equal(await secret(owner.id, owner.id, project.id), 'Segredo-exclusivo!123');
  const ownerEdit = await save(owner.id, owner.id, { id: project.id, revision: project.revision, notes: 'Atualização parcial' });
  const memberEdit = await save(member.id, owner.id, { id: project.id, revision: ownerEdit.revision, status: 'in_progress' });
  assert.equal(memberEdit.client_name, project.client_name);
  const created = await save(owner.id, owner.id, { title: 'Outro projeto', client_name: '  Ana Lima  ' });
  assert.equal(created.client_name, 'Ana Lima');
});

test('migration resolves pgcrypto installed in public and retains ciphertext across reapplication', async () => {
  const { owner, project } = await fixture();
  await db.exec('alter extension pgcrypto set schema public');
  await db.exec(migration);
  assert.equal(await secret(owner.id, owner.id, project.id), 'Segredo-exclusivo!123');
  const updated = await save(owner.id, owner.id, { id: project.id, revision: project.revision, password: 'Extensão existente' });
  assert.equal(updated.has_password, true);
  assert.equal(await secret(owner.id, owner.id, project.id), 'Extensão existente');
});
