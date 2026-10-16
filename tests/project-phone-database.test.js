'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const installer = fs.readFileSync('database/instalar-projetos.sql', 'utf8');
const migration = fs.readFileSync('database/migrations/20261016_project_phone.sql', 'utf8');
let db, legacyOwner, legacyProject, legacyRow, legacyKey;
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
  const phoneStart = installer.indexOf('-- Migration: 20261016_project_phone.sql');
  assert.ok(phoneStart > 0);
  await db.exec(installer.slice(0, phoneStart) + '\ncommit;\n');
  legacyOwner = randomUUID();
  await db.query('insert into auth.users values($1,$2,now())', [legacyOwner, `${legacyOwner}@zama.test`]);
  legacyProject = await save(legacyOwner, legacyOwner, { ...input(), password: 'preserved-secret' });
  legacyRow = (await db.query('select * from zama_projects where id=$1', [legacyProject.id])).rows[0];
  legacyKey = (await db.query('select * from zama_private.project_key')).rows;
  await db.exec(migration);
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
const list = (user, owner, version = 'v3') => as(user, () => rpc(`select zama_projects_list${version ? '_' + version : ''}($1) result`, [owner]));
const capabilities = (user, owner) => as(user, () => rpc('select zama_project_phone_capabilities($1) result', [owner]));
const input = () => ({ title: 'Projeto ZAMA', client_name: 'Cliente', notes: 'Preservar dados', due_date: '2026-11-20',
  production_lists: [{ id: 'delivery', title: 'Entrega', steps: [{ id: 'review', label: 'Revisar', done: false, due_date: '2026-11-12' }] }] });
async function fixture() {
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const [owner, projects, editor, viewer, outsider, pending] = ids;
  for (const id of ids) await db.query('insert into auth.users values($1,$2,$3)', [id, `${id}@zama.test`, id === pending ? null : '2026-01-01']);
  for (const [id, role] of [[projects, 'projects'], [editor, 'editor'], [viewer, 'viewer'], [pending, 'viewer']]) {
    await db.query('insert into zama_workspace_members(owner_id,user_id,role) values($1,$2,$3)', [owner, id, role]);
  }
  return { owner, projects, editor, viewer, outsider, pending };
}

test('upgrading existing projects adds an empty phone without changing metadata or encrypted credentials', async () => {
  const row = (await db.query('select * from zama_projects where id=$1', [legacyProject.id])).rows[0];
  assert.deepEqual(row, { ...legacyRow, client_phone: '' });
  assert.deepEqual(await list(legacyOwner, legacyOwner), [{ ...legacyProject, client_phone: '' }]);
  assert.deepEqual((await db.query('select * from zama_private.project_key')).rows, legacyKey);
  assert.equal(await as(legacyOwner, () => rpc('select zama_project_secret($1,$2) result', [legacyOwner, legacyProject.id])), 'preserved-secret');
});

test('all confirmed company roles can create, edit, list and clear canonical phone numbers', async () => {
  const { owner, projects, editor, viewer } = await fixture();
  for (const user of [owner, projects, editor, viewer]) {
    assert.deepEqual(await capabilities(user, owner), { client_phone: true });
    let project = await save(user, owner, { ...input(), client_phone: '5511999998888' });
    assert.equal(project.client_phone, '5511999998888');
    assert.equal(project.revision, 1);
    for (const version of ['', 'v2', 'v3']) {
      const returned = (await list(viewer, owner, version)).find(row => row.id === project.id);
      assert.deepEqual(returned, project);
      assert.equal(returned.password_cipher, undefined);
      assert.equal(returned.owner_id, undefined);
    }
    project = await save(viewer, owner, { id: project.id, revision: project.revision, client_phone: '14155552671' });
    assert.equal(project.client_phone, '14155552671');
    project = await save(editor, owner, { id: project.id, revision: project.revision, client_phone: '' });
    assert.equal(project.client_phone, '');
    assert.equal((await list(projects, owner)).find(row => row.id === project.id).client_phone, '');
  }
});

test('partial saves and direct checkbox updates preserve the phone and all unrelated project fields', async () => {
  const { owner, viewer } = await fixture();
  let project = await save(owner, owner, { ...input(), client_phone: '5511987654321', password: 'private-password' });
  project = await save(viewer, owner, { id: project.id, revision: project.revision, title: 'Titulo atualizado' });
  assert.equal(project.client_phone, '5511987654321');
  const checked = await as(viewer, () => rpc('select zama_project_step_set($1,$2,$3,$4,$5,$6) result',
    [owner, project.id, 'delivery', 'review', true, project.revision]));
  const expected = structuredClone(project);
  expected.production_lists[0].steps[0].done = true;
  expected.updated_at = checked.updated_at;
  expected.revision++;
  assert.deepEqual(checked, expected);
  assert.ok(!JSON.stringify(checked).includes('private-password'));
  assert.equal(await as(owner, () => rpc('select zama_project_secret($1,$2) result', [owner, project.id])), 'private-password');
});

test('phone accepts only empty text or canonical international digits and failures never mutate a project', async () => {
  const { owner, viewer } = await fixture();
  let project = await save(viewer, owner, input());
  assert.equal(project.client_phone, '');
  for (const phone of ['12345678', '123456789012345', '5511999998888', '442079460123']) {
    project = await save(viewer, owner, { id: project.id, revision: project.revision, client_phone: phone });
    assert.equal(project.client_phone, phone);
  }
  for (const phone of [null, 5511999998888, false, {}, [], '1234567', '1234567890123456', '012345678',
    '+5511999998888', '55 11 99999-8888', '5511999998888\n', ' 5511999998888', '５５１１９９９９９８８８８', 'wa.me/5511999998888']) {
    await assert.rejects(save(viewer, owner, { id: project.id, revision: project.revision, client_phone: phone }), invalid);
    await assert.rejects(save(viewer, owner, { ...input(), client_phone: phone }), invalid);
  }
  assert.deepEqual(await list(viewer, owner), [project]);
  await assert.rejects(db.query('update zama_projects set client_phone=$1 where id=$2', ['+5511999998888', project.id]), { code: '23514' });
});

test('stale edits cannot overwrite a newer phone, and members cannot alter credentials through phone saves', async () => {
  const { owner, viewer, editor } = await fixture();
  const project = await save(owner, owner, { ...input(), client_phone: '5511987654321', password: 'secret', responsible_email: `${editor}@zama.test` });
  const latest = await save(viewer, owner, { id: project.id, revision: project.revision, client_phone: '5511976543210' });
  await assert.rejects(save(viewer, owner, { id: project.id, revision: project.revision, client_phone: '' }), conflict);
  for (const restricted of [{ password: '' }, { password: 'new' }, { responsible_email: `${viewer}@zama.test` }]) {
    await assert.rejects(save(viewer, owner, { id: project.id, revision: latest.revision, client_phone: '', ...restricted }), denied);
  }
  assert.deepEqual(await list(viewer, owner), [latest]);
});

test('outsiders, unconfirmed and revoked members cannot read or edit phone numbers or claim capabilities', async () => {
  const { owner, viewer, outsider, pending } = await fixture();
  const project = await save(owner, owner, { ...input(), client_phone: '5511999998888' });
  await db.query('delete from zama_workspace_members where owner_id=$1 and user_id=$2', [owner, viewer]);
  for (const user of [outsider, pending, viewer]) {
    await assert.rejects(capabilities(user, owner), denied);
    await assert.rejects(save(user, owner, { ...input(), client_phone: '5511999998888' }), denied);
    await assert.rejects(save(user, owner, { id: project.id, revision: project.revision, client_phone: '' }), denied);
    assert.deepEqual(await list(user, owner), []);
  }
  await assert.rejects(capabilities(owner, null), denied);
});

test('anonymous callers and service roles cannot execute the phone capability or access the project table', async () => {
  const { owner, viewer } = await fixture();
  const signature = 'public.zama_project_phone_capabilities(uuid)';
  for (const role of ['anon', 'service_role']) {
    assert.equal(await rpc("select has_function_privilege($1,$2,'execute') result", [role, signature]), false);
    await db.query("select set_config('request.jwt.claim.sub','',false)");
    await db.exec(`set role ${role}`);
    try { await assert.rejects(rpc('select zama_project_phone_capabilities($1) result', [owner]), denied); }
    finally { await db.exec('reset role'); }
  }
  assert.equal(await rpc("select has_function_privilege('authenticated',$1,'execute') result", [signature]), true);
  await assert.rejects(as(viewer, () => db.query('select client_phone from zama_projects')), denied);
});

test('reapplying the migration and the full installer preserves saved phones and all business data', async () => {
  const { owner, viewer } = await fixture();
  let project = await save(owner, owner, { ...input(), client_phone: '5511999998888', password: 'keep-secret' });
  const snapshot = async () => ({ projects: (await db.query('select * from zama_projects order by id')).rows,
    members: (await db.query('select * from zama_workspace_members order by owner_id,user_id')).rows,
    key: (await db.query('select * from zama_private.project_key')).rows });
  const initial = await snapshot();
  await db.exec(migration);
  assert.deepEqual(await snapshot(), initial);
  await db.exec(installer);
  assert.deepEqual(await snapshot(), initial);
  assert.deepEqual(await capabilities(viewer, owner), { client_phone: true });
  assert.equal(await as(owner, () => rpc('select zama_project_secret($1,$2) result', [owner, project.id])), 'keep-secret');
  project = await save(viewer, owner, { id: project.id, revision: project.revision, notes: 'Works after reinstall' });
  assert.equal(project.client_phone, '5511999998888');
});
