'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const installer = fs.readFileSync('database/instalar-projetos.sql', 'utf8');
const migration = fs.readFileSync('database/migrations/20261019_project_processes.sql', 'utf8');
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
  await db.exec(installer);
});
after(async () => db?.close());
const denied = { code: '42501' }, conflict = { code: '40001' }, invalid = { code: '22023' };
async function as(user, work) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('set role authenticated');
  try { return await work(); } finally { await db.exec('reset role'); }
}
const rpc = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
const save = (user, owner, value) => as(user, () => rpc('select zama_project_save($1,$2) result', [owner, JSON.stringify(value)]));
const list = (user, owner) => as(user, () => rpc('select zama_projects_list_v3($1) result', [owner]));
const capability = (user, owner) => as(user, () => rpc('select zama_project_process_capabilities($1) result', [owner]));
const process = (id = 'catalog') => ({ id, title: 'Produção interna', description: 'Conferir briefing\nSalvar a versão aprovada.',
  responsible_name: 'Pessoa do time', due_date: '2026-11-20', status: 'in_progress',
  links: [{ label: 'Briefing', url: 'https://example.test/briefing?project=1' }, { label: '', url: 'http://example.test/referencia' }],
  steps: [{ id: 'review', label: 'Revisar', done: false, due_date: '2026-11-19' }] });
const input = () => ({ title: 'Projeto interno', client_name: 'Cliente', production_lists: [process()] });
async function fixture() {
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const [owner, projects, editor, viewer, stranger] = ids;
  for (const id of ids) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${id}@zama.test`]);
    await db.query('insert into app_state(user_id,data) values($1,$2)', [id, JSON.stringify({ financeiro: [{ id: `private-${id}` }] })]);
  }
  for (const [id, role] of [[projects, 'projects'], [editor, 'editor'], [viewer, 'viewer']]) {
    await db.query('insert into zama_workspace_members(owner_id,user_id,role) values($1,$2,$3)', [owner, id, role]);
  }
  return { owner, projects, editor, viewer, stranger };
}

test('internal process fields round-trip for the owner and every company role, without exposing credentials', async () => {
  const { owner, projects, editor, viewer, stranger } = await fixture();
  const state = (await db.query('select * from app_state order by user_id')).rows;
  let project = await save(owner, owner, { ...input(), password: 'private-project-password' });
  for (const [index, member] of [owner, projects, editor, viewer].entries()) {
    assert.deepEqual(await capability(member, owner), { process_details: true });
    const details = { ...process(), description: `Instruções da revisão ${index}`, status: ['planning', 'in_progress', 'waiting', 'completed'][index] };
    project = await save(member, owner, { id: project.id, revision: project.revision, production_lists: [details] });
    assert.deepEqual(project.production_lists, [details]);
    assert.equal(project.has_password, true);
    assert.equal(project.password_cipher, undefined);
    assert.ok(!JSON.stringify(project).includes('private-project-password'));
    assert.deepEqual(await list(member, owner), [project]);
  }
  assert.deepEqual(await list(stranger, owner), []);
  assert.deepEqual((await db.query('select * from app_state order by user_id')).rows, state);
});

test('legacy saves and direct step checks preserve process records and step deadlines', async () => {
  const { owner, viewer } = await fixture();
  let project = await save(owner, owner, { ...input(), production_lists: [process(), process('extra')] });
  const legacy = project.production_lists.map(({ id, title, steps }) => ({ id, title, steps: steps.map(({ due_date, ...step }) => step) }));
  project = await save(viewer, owner, { id: project.id, revision: project.revision, production_lists: legacy });
  assert.deepEqual(project.production_lists, [process(), process('extra')]);
  project = await save(viewer, owner, { id: project.id, revision: project.revision, catalog_steps: [{ id: 'review', label: 'Revisado', done: true }] });
  const expected = process(); expected.steps[0].label = 'Revisado'; expected.steps[0].done = true;
  assert.deepEqual(project.production_lists, [expected, process('extra')]);
  project = await as(viewer, () => rpc('select zama_project_step_set($1,$2,$3,$4,$5,$6) result',
    [owner, project.id, 'catalog', 'review', false, project.revision]));
  expected.steps[0].done = false;
  assert.deepEqual(project.production_lists, [expected, process('extra')]);
  project = await save(viewer, owner, { id: project.id, revision: project.revision, title: 'Título atualizado' });
  assert.deepEqual(project.production_lists, [expected, process('extra')]);
});

test('explicit clearing works and deleted or renamed processes never inherit unrelated details', async () => {
  const { owner } = await fixture();
  let project = await save(owner, owner, { ...input(), production_lists: [process(), process('extra')] });
  const cleared = { ...process(), description: '', responsible_name: '', due_date: null, links: [], status: 'planning',
    steps: [{ id: 'review', label: 'Revisar', done: false, due_date: null }] };
  const fresh = { id: 'new', title: 'Novo processo', steps: [{ id: 'review', label: 'Nova revisão', done: false }] };
  project = await save(owner, owner, { id: project.id, revision: project.revision, production_lists: [cleared, fresh] });
  assert.deepEqual(project.production_lists, [cleared, fresh]);
  project = await save(owner, owner, { id: project.id, revision: project.revision, production_lists: [] });
  assert.deepEqual(project.production_lists, []);
  assert.deepEqual(project.catalog_steps, []);
});

test('malformed process fields and unsafe links are rejected atomically', async () => {
  const { owner, viewer } = await fixture();
  const project = await save(owner, owner, input());
  const badFields = [
    { description: null }, { description: true }, { description: 'x'.repeat(10001) },
    { responsible_name: null }, { responsible_name: {} }, { responsible_name: 'x'.repeat(255) },
    { due_date: '' }, { due_date: 20261120 }, { due_date: '2026-2-03' }, { due_date: '2026-02-30' },
    { status: null }, { status: 'done' }, { status: false }, { unknown: 'must not save' },
    { links: null }, { links: {} }, { links: Array.from({ length: 21 }, () => ({ label: '', url: 'https://example.test' })) },
    ...[null, 'https://example.test', {}, { label: '', url: 'javascript:alert(1)' }, { label: '', url: 'data:text/html,bad' },
      { label: '', url: '//example.test' }, { label: '', url: 'file:///private' }, { label: '', url: 'https://' },
      { label: '', url: 'https://example.test/with space' }, { label: '', url: 'https://example.test/\nnext' },
      { label: '', url: 'https://example.test/' + 'x'.repeat(2048) }, { label: null, url: 'https://example.test' },
      { label: 'x'.repeat(255), url: 'https://example.test' }, { url: 'https://example.test' },
      { label: '', url: 12 }, { label: '', url: 'https://example.test', secret: true }].map(link => ({ links: [link] }))
  ];
  for (const fields of badFields) {
    await assert.rejects(save(viewer, owner, { id: project.id, revision: project.revision,
      title: 'Must roll back', production_lists: [{ ...process(), ...fields }] }), invalid);
  }
  assert.deepEqual(await list(owner, owner), [project]);
  const maximum = { ...process(), description: 'x'.repeat(10000), responsible_name: 'x'.repeat(254),
    links: Array.from({ length: 20 }, () => ({ label: 'x'.repeat(254), url: 'https://example.test/' + 'x'.repeat(2027) })) };
  assert.equal(maximum.links[0].url.length, 2048);
  assert.deepEqual((await save(owner, owner, { id: project.id, revision: project.revision, production_lists: [maximum] })).production_lists, [maximum]);
});

test('process records retain project ACLs and revision conflicts, including revoked and unconfirmed members', async () => {
  const { owner, viewer, stranger } = await fixture();
  const project = await save(owner, owner, input());
  const latest = await save(viewer, owner, { id: project.id, revision: project.revision,
    production_lists: [{ ...process(), description: 'Última revisão do time' }] });
  await assert.rejects(save(owner, owner, { id: project.id, revision: project.revision, production_lists: [process()] }), conflict);
  for (const member of [stranger, viewer]) {
    if (member === viewer) await db.query('update auth.users set email_confirmed_at=null where id=$1', [viewer]);
    await assert.rejects(capability(member, owner), denied);
    await assert.rejects(save(member, owner, { id: project.id, revision: latest.revision, production_lists: [process()] }), denied);
  }
  await db.query('update auth.users set email_confirmed_at=now() where id=$1', [viewer]);
  await db.query('delete from zama_workspace_members where owner_id=$1 and user_id=$2', [owner, viewer]);
  await assert.rejects(capability(viewer, owner), denied);
  await assert.rejects(capability(owner, null), denied);
  assert.deepEqual(await list(owner, owner), [latest]);
  for (const role of ['anon', 'service_role']) {
    assert.equal(await rpc("select has_function_privilege($1,'public.zama_project_process_capabilities(uuid)','execute') result", [role]), false);
  }
  for (const signature of ['zama_private.project_validate_lists(jsonb)', 'zama_private.project_preserve_step_dates(jsonb,jsonb)']) {
    assert.equal(await rpc("select has_function_privilege('authenticated',$1,'execute') result", [signature]), false);
  }
});

test('reusable templates strip internal process data, completion and deadlines', async () => {
  const { owner } = await fixture();
  const details = process(); details.steps[0].done = true;
  const template = await as(owner, () => rpc('select zama_project_template_save($1) result', [JSON.stringify({ title: 'Modelo de processo', production_lists: [details] })]));
  assert.deepEqual(template.production_lists, [{ id: 'catalog', title: 'Produção interna', steps: [{ id: 'review', label: 'Revisar', done: false }] }]);
  const stored = await as(owner, () => rpc('select zama_project_templates_list() result'));
  assert.deepEqual(stored, [template]);
});

test('both standalone migration and full installer can be reapplied without losing process records or encrypted credentials', async () => {
  const { owner, viewer } = await fixture();
  const project = await save(owner, owner, { ...input(), password: 'preserved-secret' });
  const snapshot = async () => ({
    projects: (await db.query('select * from zama_projects order by id')).rows,
    key: (await db.query('select * from zama_private.project_key')).rows,
    templates: (await db.query('select * from zama_project_templates order by id')).rows
  });
  const before = await snapshot();
  for (const sql of [migration, installer]) {
    await db.exec(sql);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await capability(viewer, owner), { process_details: true });
    assert.deepEqual(await list(viewer, owner), [project]);
    assert.equal(await as(owner, () => rpc('select zama_project_secret($1,$2) result', [owner, project.id])), 'preserved-secret');
  }
});
