'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
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
  await db.exec(fs.readFileSync('database/instalar-projetos.sql','utf8'));
});
after(async () => db?.close());
async function as(user, work) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]); await db.exec('set role authenticated');
  try { return await work(); } finally { await db.exec('reset role'); }
}
const rpc = async (sql, args=[]) => (await db.query(sql,args)).rows[0]?.result;
const denied = { code:'42501' };
const idea = {id:'shared',titulo:'Ideia ZAMA',descricao:'Produção',categoria:'Geral',prioridade:'Alta',data:'2026-10-15',etapa:'capturada',arquivada:false};
async function fixture() {
  const ids = [randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  for (const id of ids) {
    await db.query('insert into auth.users values($1,$2,now())',[id,`${id}@zama.test`]);
    await db.query('insert into app_state(user_id,data) values($1,$2)',[id,JSON.stringify({companyProfile:{nome:'ZAMA'},agenda:[{id:`private-${id}`,nome:'Agenda privada'}],financeiro:[{id:'finance-secret'}],ideias:[{...idea,taskId:'private-task-link'}]})]);
  }
  const [owner,a,b,stranger]=ids;
  await db.query("insert into zama_workspace_members(owner_id,user_id,role) values($1,$2,'projects'),($1,$3,'editor')",[owner,a,b]);
  return {owner,a,b,stranger};
}
const lists = (date='2026-10-17') => [{id:'production',title:'Produção',steps:[{id:'first',label:'Gravar',done:false,due_date:date}]}];
const save = (user,owner,value) => as(user,()=>rpc('select zama_project_save($1,$2) result',[owner,JSON.stringify(value)]));
test('all verified company members see every project while outsiders and revoked members cannot',async()=>{
  const {owner,a,b,stranger}=await fixture();
  const project=await save(owner,owner,{title:'Visível à equipe',client_name:'Cliente',responsible_email:`${a}@zama.test`,password:'client-secret',production_lists:lists()});
  for(const id of [a,b]) assert.equal((await as(id,()=>rpc('select zama_projects_list_v3($1) result',[owner])))[0].id,project.id);
  assert.deepEqual(await as(stranger,()=>rpc('select zama_projects_list_v3($1) result',[owner])),[]);
  assert.equal(await as(a,()=>rpc('select zama_project_secret($1,$2) result',[owner,project.id])),'client-secret');
  await assert.rejects(as(b,()=>rpc('select zama_project_secret($1,$2) result',[owner,project.id])),denied);
  await save(b,owner,{id:project.id,revision:project.revision,notes:'Contribuição da equipe'});
  await as(owner,()=>rpc('select zama_workspace_revoke($1) result',[b]));
  assert.deepEqual(await as(b,()=>rpc('select zama_projects_list_v3($1) result',[owner])),[]);
});
test('every agenda is private, including from legacy editors and the company owner',async()=>{
  const {owner,a,b}=await fixture();
  for(const reader of [owner,a,b]) {
    const visible=await as(reader,()=>db.query('select user_id from app_state'));
    assert.deepEqual(visible.rows,[{user_id:reader}]);
    for(const other of [owner,a,b].filter(id=>id!==reader)) {
      assert.equal((await as(reader,()=>db.query("update app_state set data='{}' where user_id=$1 returning user_id",[other]))).rows.length,0);
    }
  }
});
test('shared ideas expose only ideas and never private agenda, finances or task links',async()=>{
  const {owner,a,b,stranger}=await fixture();
  const data=await as(a,()=>rpc('select zama_team_ideas_get($1) result',[owner]));
  assert.equal(data.ideas[0].titulo,idea.titulo);
  assert.ok(!JSON.stringify(data).includes('private-')); assert.ok(!JSON.stringify(data).includes('finance-secret'));
  const ownBefore=(await db.query('select data from app_state where user_id=$1',[a])).rows[0].data;
  const updated=await as(a,()=>rpc('select zama_team_ideas_save($1,$2,$3) result',[owner,data.revision,JSON.stringify([{...idea,titulo:'Ideia de todos'}])]));
  assert.equal((await as(b,()=>rpc('select zama_team_ideas_get($1) result',[owner]))).ideas[0].titulo,'Ideia de todos');
  assert.deepEqual((await db.query('select data from app_state where user_id=$1',[a])).rows[0].data,ownBefore);
  const company=(await db.query('select data from app_state where user_id=$1',[owner])).rows[0].data;
  assert.equal(company.agenda[0].id,`private-${owner}`); assert.equal(company.financeiro[0].id,'finance-secret');
  assert.equal(company.ideias[0].taskId,'private-task-link');
  assert.ok(!JSON.stringify(updated).includes('private-task-link'));
  await assert.rejects(as(a,()=>rpc('select zama_team_ideas_save($1,$2,$3) result',[owner,data.revision,'[]'])),{code:'40001'});
  await assert.rejects(as(stranger,()=>rpc('select zama_team_ideas_get($1) result',[owner])),denied);
  await assert.rejects(as(b,()=>rpc('select zama_team_ideas_save($1,$2,$3) result',[owner,updated.revision,JSON.stringify([{...idea,taskId:'private-link'}])])),{code:'22023'});
});
test('viewer can read shared ideas but cannot write; unconfirmed and revoked members lose access',async()=>{
  const {owner,a}=await fixture();
  await as(owner,()=>rpc("select zama_workspace_set_role($1,'viewer') result",[a]));
  const data=await as(a,()=>rpc('select zama_team_ideas_get($1) result',[owner]));
  await assert.rejects(as(a,()=>rpc('select zama_team_ideas_save($1,$2,$3) result',[owner,data.revision,'[]'])),denied);
  await db.query('update auth.users set email_confirmed_at=null where id=$1',[a]);
  await assert.rejects(as(a,()=>rpc('select zama_team_ideas_get($1) result',[owner])),denied);
});
test('step deadlines survive old clients, explicit null removes them, and invalid dates roll back',async()=>{
  const {owner,b}=await fixture();
  let project=await save(owner,owner,{title:'Prazos',client_name:'Cliente',production_lists:lists()});
  const legacy=lists(); delete legacy[0].steps[0].due_date; legacy[0].steps[0].done=true;
  project=await save(b,owner,{id:project.id,revision:project.revision,production_lists:legacy});
  assert.equal(project.production_lists[0].steps[0].due_date,'2026-10-17');
  for(const invalid of ['2026-02-30','15/10/2026',42]) await assert.rejects(save(owner,owner,{id:project.id,revision:project.revision,production_lists:lists(invalid)}),{code:'22023'});
  project=await save(b,owner,{id:project.id,revision:project.revision,production_lists:lists(null)});
  assert.equal(project.production_lists[0].steps[0].due_date,null);
});
test('templates reset progress and dates, reject credentials, isolate owners and check revisions',async()=>{
  const {owner,a}=await fixture(); const structure=lists(); structure[0].steps[0].done=true;
  const model=await as(owner,()=>rpc('select zama_project_template_save($1) result',[JSON.stringify({title:'Vídeo',production_lists:structure})]));
  assert.equal(model.production_lists[0].steps[0].done,false); assert.equal(model.production_lists[0].steps[0].due_date,undefined);
  assert.deepEqual(await as(a,()=>rpc('select zama_project_templates_list() result')),[]);
  await assert.rejects(as(a,()=>rpc('select zama_project_template_delete($1,$2) result',[model.id,model.revision])),denied);
  await assert.rejects(as(owner,()=>rpc('select zama_project_template_save($1) result',[JSON.stringify({title:'Bad',production_lists:structure,password:'secret'})])),{code:'22023'});
  await assert.rejects(as(owner,()=>rpc('select zama_project_template_delete($1,$2) result',[model.id,0])),{code:'40001'});
  await db.exec(fs.readFileSync('database/instalar-projetos.sql','utf8'));
  assert.deepEqual(await as(owner,()=>rpc('select zama_project_templates_list() result')),[model]);
});
test('anonymous and direct table access cannot bypass the shared-space RPCs',async()=>{
  const {owner,a}=await fixture();
  await assert.rejects(as(a,()=>db.query('select * from zama_project_templates')),denied);
  await db.exec('set role anon');
  try { await assert.rejects(rpc('select zama_team_ideas_get($1) result',[owner]),denied); }
  finally { await db.exec('reset role'); }
});
