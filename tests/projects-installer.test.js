'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');

const installer = fs.readFileSync('database/instalar-projetos.sql', 'utf8');
let db;
const owner = randomUUID(), member = randomUUID(), outsider = randomUUID();
const originalState = { companyProfile: { nome: 'Empresa existente' }, financeiro: [{ id: 'preservado', valor: 15000 }] };
const fixtureSql = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
  $$;
  grant usage on schema auth,public to authenticated,anon,service_role;
  create table public.app_state(
    user_id uuid primary key references auth.users(id),
    data jsonb not null default '{}',updated_at timestamptz default now()
  );
  alter table public.app_state enable row level security;
  alter table public.app_state force row level security;
  grant select,insert,update,delete on public.app_state to authenticated;
  create policy own on public.app_state to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
`;

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(fixtureSql);
  for (const id of [owner, member, outsider]) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${id}@zama.test`]);
  }
  await db.query('insert into app_state(user_id,data) values($1,$2)', [owner, JSON.stringify(originalState)]);
  await db.exec(installer);
});
after(async () => db?.close());

async function as(id, fn) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function rpc(sql, args = []) { return (await db.query(sql, args)).rows[0]?.result; }

test('checked-in installer matches the migrations and has one outer transaction', async () => {
  const { buildProjectsSetup } = await import('../scripts/build-projects-setup.mjs');
  assert.equal(installer, buildProjectsSetup());
  assert.equal((installer.match(/^begin;$/gm) || []).length, 1);
  assert.equal((installer.match(/^commit;$/gm) || []).length, 1);
});

test('full installer activates manual lists and is safe to reapply with existing projects-only members', async () => {
  const invite = await as(owner, () => rpc('select zama_workspace_invite($1,$2) result', [`${member}@zama.test`, 'projects']));
  assert.equal(await as(member, () => rpc('select zama_workspace_accept($1) result', [invite.token])), owner);
  // Keep a pending invitation too: reinstalling must not change membership or invite state.
  await as(owner, () => rpc('select zama_workspace_invite($1,$2) result', [`${outsider}@zama.test`, 'viewer']));
  const lists = [{ id: 'films', title: 'Minha produção', steps: [{ id: 'review', label: 'Revisar roteiro', done: true }] }];
  const project = await as(owner, () => rpc('select zama_project_save($1,$2) result', [owner, JSON.stringify({
    title: 'Vídeo personalizado', client_name: 'Cliente existente', responsible_email: `${member}@zama.test`,
    password: 'Senha de teste preservada', production_lists: lists
  })]));
  const snapshot = async () => ({
    appState: (await db.query('select * from app_state order by user_id')).rows,
    members: (await db.query('select * from zama_workspace_members order by owner_id,user_id')).rows,
    invites: (await db.query('select * from zama_workspace_invites order by id')).rows,
    projects: (await db.query('select * from zama_projects order by id')).rows,
    key: (await db.query('select * from zama_private.project_key')).rows
  });
  const initial = await snapshot();
  assert.deepEqual(initial.appState[0].data, originalState);
  assert.deepEqual(project.production_lists, lists);
  await db.exec(installer);
  assert.deepEqual(await snapshot(), initial);
  assert.deepEqual(await as(member, () => rpc('select zama_projects_list_v2($1) result', [owner])), [project]);
  assert.equal(await as(member, () => rpc('select zama_project_secret($1,$2) result', [owner, project.id])), 'Senha de teste preservada');
  assert.deepEqual((await as(member, () => db.query('select * from app_state where user_id=$1', [owner]))).rows, []);
  assert.deepEqual(await as(outsider, () => rpc('select zama_projects_list_v2($1) result', [owner])), []);
  await assert.rejects(as(member, () => db.query('select * from zama_private.project_key')), { code: '42501' });
  await assert.rejects(as(member, () => db.query('select * from zama_projects')), { code: '42501' });
  assert.equal(await rpc("select has_function_privilege('anon','public.zama_projects_list_v2(uuid)','execute') result"), false);
  assert.equal(await rpc("select has_function_privilege('authenticated','public.zama_projects_list_v2(uuid)','execute') result"), true);
});

test('a late installation failure rolls back the whole bundle without changing business data', async () => {
  const rollbackDb = new PGlite({ extensions: { pgcrypto } });
  try {
    await rollbackDb.exec(fixtureSql);
    await rollbackDb.query('insert into auth.users values($1,$2,now())', [owner, `${owner}@zama.test`]);
    await rollbackDb.query('insert into app_state(user_id,data) values($1,$2)', [owner, JSON.stringify(originalState)]);
    const state = (await rollbackDb.query('select * from app_state')).rows;
    const brokenInstaller = installer.replace(/\ncommit;\s*$/, '\nselect intentional_installer_failure();\ncommit;\n');
    await assert.rejects(rollbackDb.exec(brokenInstaller), { code: '42883' });
    await rollbackDb.exec('rollback;');
    assert.deepEqual((await rollbackDb.query('select * from app_state')).rows, state);
    assert.deepEqual((await rollbackDb.query(`select to_regclass('public.zama_workspace_members') members,
      to_regclass('public.zama_projects') projects,to_regclass('zama_private.project_key') key`)).rows,
    [{ members: null, projects: null, key: null }]);
  } finally { await rollbackDb.close(); }
});
