const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
let db;
const owner = randomUUID(), viewer = randomUUID(), editor = randomUUID(), stranger = randomUUID();
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated,anon,service_role;
    create table public.app_state(user_id uuid primary key references auth.users(id), data jsonb not null default '{}',updated_at timestamptz default now());
    alter table public.app_state enable row level security; alter table public.app_state force row level security;
    grant select,insert,update,delete on public.app_state to authenticated;
    create policy own on public.app_state to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);`);
  for (const [id,email] of [[owner,'owner@zama.test'],[viewer,'viewer@zama.test'],[editor,'editor@zama.test'],[stranger,'stranger@zama.test']]) {
    await db.query('insert into auth.users values($1,$2,now())',[id,email]);
  }
  await db.query('insert into app_state(user_id,data) values($1,$2)',[owner,JSON.stringify({companyProfile:{nome:'Empresa principal'},financeiro:[{id:'preservado'}]})]);
  const sql = fs.readFileSync('database/migrations/20261005_workspaces.sql','utf8');
  await db.exec(sql); await db.exec(sql);
});
after(async () => db?.close());
async function as(id, fn) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rpc = async (sql,args=[]) => (await db.query(sql,args)).rows[0]?.result;
test('migration is repeatable and preserves existing data; users only see their own companies', async () => {
  assert.equal((await db.query('select data from app_state where user_id=$1',[owner])).rows[0].data.financeiro[0].id,'preservado');
  assert.equal((await as(stranger, () => db.query('select * from app_state'))).rows.length,0);
  const list = await as(stranger, () => db.query('select * from zama_workspace_list()'));
  assert.equal(list.rows.length,1); assert.equal(list.rows[0].owner_id,stranger);
});
test('only the confirmed invite email may accept; viewer reads but cannot mutate or delegate', async () => {
  const invitation = await as(owner, () => rpc("select zama_workspace_invite('VIEWER@zama.test','viewer') result"));
  await assert.rejects(as(stranger, () => rpc('select zama_workspace_accept($1) result',[invitation.token])),/outro e-mail/);
  assert.equal(await as(viewer, () => rpc('select zama_workspace_accept($1) result',[invitation.token])),owner);
  assert.equal(await as(viewer, () => rpc('select zama_workspace_accept($1) result',[invitation.token])),owner);
  assert.equal((await as(viewer, () => db.query('select * from app_state'))).rows.length,1);
  assert.equal((await as(viewer, () => db.query("update app_state set data='{}' where user_id=$1 returning user_id",[owner]))).rows.length,0);
  assert.equal((await as(viewer, () => db.query('delete from app_state where user_id=$1 returning user_id',[owner]))).rows.length,0);
  await assert.rejects(as(viewer, () => db.query("insert into zama_workspace_members values($1,$2,'editor',now())",[owner,stranger])),/permission denied/);
  assert.deepEqual(await as(viewer, () => rpc('select zama_workspace_roster() result')), { members:[],invites:[] });
});
test('editor writes shared data but cannot transfer ownership or delete company; revoke is immediate', async () => {
  const invitation = await as(owner, () => rpc("select zama_workspace_invite('editor@zama.test','editor') result"));
  await as(editor, () => rpc('select zama_workspace_accept($1) result',[invitation.token]));
  assert.equal((await as(editor, () => db.query("update app_state set data=jsonb_set(data,'{marker}','true') where user_id=$1 returning user_id",[owner]))).rows.length,1);
  await assert.rejects(as(editor, () => db.query('update app_state set user_id=$1 where user_id=$2',[editor,owner])),/proprietário/);
  assert.equal((await as(editor, () => db.query('delete from app_state where user_id=$1 returning user_id',[owner]))).rows.length,0);
  await as(stranger, () => rpc('select zama_workspace_revoke($1) result',[editor]));
  assert.equal((await as(editor, () => db.query('select * from app_state'))).rows.length,1);
  await as(owner, () => rpc('select zama_workspace_set_role($1,$2) result',[editor,'viewer']));
  assert.equal((await as(editor, () => db.query("update app_state set data='{}' where user_id=$1 returning user_id",[owner]))).rows.length,0);
  await as(owner, () => rpc('select zama_workspace_revoke($1) result',[editor]));
  assert.equal((await as(editor, () => db.query('select * from app_state'))).rows.length,0);
  await assert.rejects(as(editor, () => rpc('select zama_workspace_accept($1) result',[invitation.token])),/já foi utilizado/);
});
test('expired/revoked tokens fail, roster never exposes token hashes, invalid roles rejected', async () => {
  const invitation = await as(owner, () => rpc("select zama_workspace_invite('stranger@zama.test','viewer') result"));
  await db.query("update zama_workspace_invites set expires_at=now()-interval '1 minute' where id=$1",[invitation.id]);
  await assert.rejects(as(stranger, () => rpc('select zama_workspace_accept($1) result',[invitation.token])),/expirado/);
  const second = await as(owner, () => rpc("select zama_workspace_invite('stranger@zama.test','viewer') result"));
  const roster = await as(owner, () => rpc('select zama_workspace_roster() result'));
  assert.ok(!JSON.stringify(roster).includes('token'));
  await as(owner, () => rpc('select zama_workspace_cancel_invite($1) result',[second.id]));
  await assert.rejects(as(stranger, () => rpc('select zama_workspace_accept($1) result',[second.token])),/expirado/);
  await assert.rejects(as(owner, () => rpc("select zama_workspace_invite('stranger@zama.test','owner') result")),/inválido/);
  await assert.rejects(as(owner, () => db.query('select * from zama_workspace_invites')),/permission denied/);
  await db.exec('set role anon');
  try { await assert.rejects(db.query('select zama_workspace_list()'),/permission denied/); }
  finally { await db.exec('reset role'); }
});
