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
const denied = { code:'42501' }, conflict = { code:'40001' }, invalid = { code:'22023' };
async function as(user, work) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]); await db.exec('set role authenticated');
  try { return await work(); } finally { await db.exec('reset role'); }
}
const rpc = async (sql,args=[]) => (await db.query(sql,args)).rows[0]?.result;
const save = (user,owner,value) => as(user,()=>rpc('select zama_project_save($1,$2) result',[owner,JSON.stringify(value)]));
const step = (user,owner,project,done,overrides={}) => as(user,()=>rpc('select zama_project_step_set($1,$2,$3,$4,$5,$6) result',
  [owner,overrides.id||project.id,overrides.list||'catalog',overrides.step||'review',done,overrides.revision===undefined?project.revision:overrides.revision]));
const structure = () => [
  {id:'catalog',title:'Catálogo',steps:[{id:'review',label:'Revisar',done:false,due_date:'2026-11-12'},{id:'send',label:'Enviar',done:false,due_date:null}]},
  {id:'other',title:'Produção extra',steps:[{id:'review',label:'Editar',done:false,due_date:'2026-11-13'}]}
];
const input = () => ({title:'Produção ZAMA',client_name:'Cliente',production_lists:structure(),due_date:'2026-11-20',notes:'Preservar'});
async function fixture() {
  const ids=Array.from({length:5},()=>randomUUID()); const [owner,projects,editor,viewer,stranger]=ids;
  for(const id of ids) {
    await db.query('insert into auth.users values($1,$2,now())',[id,`${id}@zama.test`]);
    await db.query('insert into app_state(user_id,data) values($1,$2)',[id,JSON.stringify({
      agenda:[{id:`private-${id}`}],financeiro:[{id:'finance-secret'}],ideias:[]
    })]);
  }
  for(const [id,role] of [[projects,'projects'],[editor,'editor'],[viewer,'viewer']]) {
    await db.query('insert into zama_workspace_members(owner_id,user_id,role) values($1,$2,$3)',[owner,id,role]);
  }
  return {owner,projects,editor,viewer,stranger};
}

test('all company roles create and edit full project metadata, including projects assigned to somebody else',async()=>{
  const {owner,projects,editor,viewer}=await fixture();
  for(const member of [projects,editor,viewer]) {
    assert.deepEqual(await as(member,()=>rpc('select zama_project_collaboration_capabilities($1) result',[owner])),{can_edit:true,shared_creation:true});
    let project=await save(member,owner,{...input(),responsible_email:`${editor}@zama.test`});
    assert.equal(project.revision,1); assert.equal(project.has_password,false);
    const change={title:'Novo título',client_name:'Outro cliente',company_name:'Empresa',client_email:' CLIENTE@ZAMA.TEST ',
      access_url:'https://example.test/acesso',responsible_email:`${projects}@zama.test`,responsible_name:'Colega',
      due_date:'2026-12-01',status:'in_progress',notes:'Trabalho compartilhado',production_lists:structure().slice(0,1)};
    project=await save(viewer,owner,{id:project.id,revision:project.revision,...change});
    for(const key of Object.keys(change)) assert.deepEqual(project[key],key==='client_email'?'cliente@zama.test':change[key]);
    assert.equal(project.revision,2);
    assert.equal(project.password_cipher,undefined); assert.equal(project.owner_id,undefined);
  }
});

test('outsiders, pending users and revoked members cannot create, edit, check steps or claim capabilities',async()=>{
  const {owner,viewer,stranger}=await fixture();
  const project=await save(owner,owner,input());
  for(const member of [stranger,viewer]) {
    if(member===viewer) await db.query('update auth.users set email_confirmed_at=null where id=$1',[member]);
    await assert.rejects(save(member,owner,input()),denied);
    await assert.rejects(save(member,owner,{id:project.id,revision:project.revision,title:'Inválido'}),denied);
    await assert.rejects(step(member,owner,project,true),denied);
    await assert.rejects(as(member,()=>rpc('select zama_project_collaboration_capabilities($1) result',[owner])),denied);
  }
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[viewer]);
  await db.query('delete from zama_workspace_members where owner_id=$1 and user_id=$2',[owner,viewer]);
  await assert.rejects(save(viewer,owner,input()),denied);
  await assert.rejects(step(viewer,owner,project,true),denied);
});

test('collaboration leaves agenda isolation and viewer idea permissions unchanged',async()=>{
  const {owner,projects,viewer}=await fixture();
  const before=(await db.query('select user_id,data from app_state order by user_id')).rows;
  await save(viewer,owner,input());
  for(const member of [owner,projects,viewer]) {
    assert.deepEqual((await as(member,()=>db.query('select user_id from app_state'))).rows,[{user_id:member}]);
  }
  const ideas=await as(viewer,()=>rpc('select zama_team_ideas_get($1) result',[owner]));
  await assert.rejects(as(viewer,()=>rpc('select zama_team_ideas_save($1,$2,$3) result',[owner,ideas.revision,'[]'])),denied);
  assert.deepEqual((await db.query('select user_id,data from app_state order by user_id')).rows,before);
});

test('stored credentials cannot be changed or self-assigned by collaborators, even via an empty password',async()=>{
  const {owner,projects,editor,viewer}=await fixture();
  let project=await save(owner,owner,{...input(),responsible_email:`${projects}@zama.test`,password:'owner-secret'});
  for(const member of [projects,editor,viewer]) {
    for(const password of ['',null,'replacement']) {
      await assert.rejects(save(member,owner,{...input(),password}),denied);
      await assert.rejects(save(member,owner,{id:project.id,revision:project.revision,password}),denied);
    }
    await assert.rejects(save(member,owner,{id:project.id,revision:project.revision,responsible_email:`${viewer}@zama.test`}),denied);
    await assert.rejects(save(member,owner,{id:project.id,revision:project.revision,responsible_email:''}),denied);
  }
  project=await save(viewer,owner,{id:project.id,revision:project.revision,title:'Pode editar',responsible_name:'Nome atualizado'});
  assert.equal(project.title,'Pode editar'); assert.equal(project.has_password,true);
  assert.equal(await as(projects,()=>rpc('select zama_project_secret($1,$2) result',[owner,project.id])),'owner-secret');
  for(const member of [editor,viewer]) await assert.rejects(as(member,()=>rpc('select zama_project_secret($1,$2) result',[owner,project.id])),denied);
  project=await save(owner,owner,{id:project.id,revision:project.revision,responsible_email:`${viewer}@zama.test`});
  await assert.rejects(as(viewer,()=>rpc('select zama_project_secret($1,$2) result',[owner,project.id])),denied);
  project=await save(owner,owner,{id:project.id,revision:project.revision,password:''});
  project=await save(viewer,owner,{id:project.id,revision:project.revision,responsible_email:`${editor}@zama.test`});
  assert.equal(project.has_password,false); assert.equal(project.responsible_email,`${editor}@zama.test`);
});

test('a direct checkbox changes exactly one step, keeps status and deadlines, and returns no secrets',async()=>{
  const {owner,viewer}=await fixture();
  const project=await save(owner,owner,{...input(),password:'private-credential'});
  const result=await step(viewer,owner,project,true);
  const expected=structuredClone(project); expected.production_lists[0].steps[0].done=true;
  expected.catalog_steps[0].done=true; expected.revision++; expected.updated_at=result.updated_at;
  assert.deepEqual(result,expected); assert.equal(result.status,'planning');
  assert.ok(!JSON.stringify(result).includes('private-credential')); assert.equal(result.password_cipher,undefined);
  const undone=await step(viewer,owner,result,false);
  assert.equal(undone.production_lists[0].steps[0].done,false); assert.equal(undone.revision,3);
});

test('stale checkbox/edit revisions conflict and malformed/missing steps cannot mutate a project',async()=>{
  const {owner,viewer,editor}=await fixture();
  const project=await save(viewer,owner,input());
  const latest=await save(editor,owner,{id:project.id,revision:project.revision,title:'Mudança do colega'});
  await assert.rejects(step(viewer,owner,project,true),conflict);
  await assert.rejects(save(viewer,owner,{id:project.id,revision:project.revision,title:'Perda de dados'}),conflict);
  await assert.rejects(step(viewer,owner,latest,true,{revision:null}),conflict);
  for(const overrides of [{list:'missing'},{step:'missing'},{list:'x'.repeat(81)},{step:'x'.repeat(81)}]) {
    await assert.rejects(step(viewer,owner,latest,true,overrides),invalid);
  }
  await assert.rejects(step(viewer,owner,latest,null),invalid);
  const rows=await as(viewer,()=>rpc('select zama_projects_list_v3($1) result',[owner]));
  assert.deepEqual(rows,[latest]);
});

test('collaborators preserve legacy deadlines and custom lists; validation still rolls back bad payloads',async()=>{
  const {owner,viewer}=await fixture();
  let project=await save(viewer,owner,input());
  const legacy=project.catalog_steps.map(({due_date,...rest})=>({...rest,done:true}));
  project=await save(viewer,owner,{id:project.id,revision:project.revision,catalog_steps:legacy});
  assert.equal(project.production_lists[0].steps[0].due_date,'2026-11-12');
  assert.equal(project.production_lists[1].steps[0].due_date,'2026-11-13');
  for(const bad of [{title:'  '},{client_name:''},{client_email:'invalid'},{access_url:'javascript:alert(1)'},{status:'unknown'},
    {production_lists:[{id:'a',title:'A',steps:[{id:'x',label:'Etapa',done:true,due_date:'2026-02-30'}]}]},
    {production_lists:[{id:'a',title:'A',steps:[{id:'x',label:'Etapa',done:'yes'}]}]}]) {
    await assert.rejects(save(viewer,owner,{id:project.id,revision:project.revision,...bad}),invalid);
  }
  const lists=structure(); lists[0].steps[0].due_date=null;
  project=await save(viewer,owner,{id:project.id,revision:project.revision,production_lists:lists});
  assert.equal(project.production_lists[0].steps[0].due_date,null);
});

test('deletion stays owner-only, and private tables/functions plus anonymous RPCs stay inaccessible',async()=>{
  const {owner,projects,editor,viewer}=await fixture();
  const project=await save(viewer,owner,input());
  for(const member of [projects,editor,viewer]) {
    await assert.rejects(as(member,()=>rpc('select zama_project_delete($1,$2) result',[owner,project.id])),denied);
    await assert.rejects(as(member,()=>db.query('select * from zama_projects')),denied);
    await assert.rejects(as(member,()=>rpc("select zama_private.project_access($1,'',true) result",[owner])),denied);
  }
  for(const signature of ['public.zama_project_step_set(uuid,uuid,text,text,boolean,integer)','public.zama_project_collaboration_capabilities(uuid)']) {
    for(const role of ['anon','service_role']) assert.equal(await rpc('select has_function_privilege($1,$2,\'execute\') result',[role,signature]),false);
    assert.equal(await rpc('select has_function_privilege(\'authenticated\',$1,\'execute\') result',[signature]),true);
  }
  await as(owner,()=>rpc('select zama_project_delete($1,$2) result',[owner,project.id]));
  assert.deepEqual(await as(viewer,()=>rpc('select zama_projects_list_v3($1) result',[owner])),[]);
});

test('reapplying the full installer preserves projects, secret encryption and collaboration permissions',async()=>{
  const {owner,viewer}=await fixture();
  let project=await save(owner,owner,{...input(),password:'preserved-secret'});
  project=await step(viewer,owner,project,true);
  const snapshot=async()=>(await db.query('select * from zama_projects order by id')).rows;
  const before=await snapshot(); const key=(await db.query('select * from zama_private.project_key')).rows;
  await db.exec(fs.readFileSync('database/instalar-projetos.sql','utf8'));
  assert.deepEqual(await snapshot(),before); assert.deepEqual((await db.query('select * from zama_private.project_key')).rows,key);
  assert.equal(await as(owner,()=>rpc('select zama_project_secret($1,$2) result',[owner,project.id])),'preserved-secret');
  assert.equal((await step(viewer,owner,project,false)).production_lists[0].steps[0].done,false);
});
