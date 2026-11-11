'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const root=resolve(__dirname,'..');
const owner='11111111-1111-4111-8111-111111111111';
const client='fixture',resource='https://zama.example/api/dot-mcp',redirect='https://client.example/cb',challenge='A'.repeat(43);
const hash=()=>createHash('sha256').update(randomUUID()).digest('hex');
const sql=file=>readFileSync(resolve(root,file),'utf8');
const draft=()=>sql('database/dot-oauth-refresh-v2-draft.sql');
const val=async(db,query,args=[])=>(await db.query(query,args)).rows[0].v;
const grant=(db,id)=>val(db,'select row_to_json(g) as v from dot_api_grants g where id=$1',[id]);
const funcs=['dot_oauth_v2_exchange_refresh(text,uuid,text,text,text,text,uuid,text,text,boolean)','dot_oauth_v2_refresh(text,uuid,uuid,text,text,text,text,text,boolean)','dot_oauth_v2_revoke(text,uuid,text,text)','dot_oauth_v1_revoke_by_token(text,uuid,text,text)','dot_oauth_revoke_compatible(text,uuid,text,text)'];
async function fixture(t,{upgrade=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table app_state(user_id uuid primary key references auth.users(id),data jsonb not null default '{}',updated_at timestamptz not null default now());alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;");
 for(const file of ['database/migrations/20260930_jarvis.sql','database/migrations/20261104_dot_grants.sql','database/dot-oauth-draft.sql','database/migrations/20261104_dot_direct_expenses.sql','database/migrations/20261104174518_dot_oauth_refresh.sql'])await db.exec(sql(file));
 await db.query('insert into auth.users values($1)',[owner]);
 if(upgrade)await db.exec(draft());
 return db;
}
async function code(db,{v2=false,direct=true}={}){
 const c=hash();await db.query(`insert into dot_oauth_codes(code_hash,owner_id,client_id,resource,redirect_uri,challenge,allow_direct_expense${v2?',allow_refresh_v2':''})values($1,$2,$3,$4,$5,$6,$7${v2?',$8':''})`,[c,owner,client,resource,redirect,challenge,direct,...(v2?[true]:[])]);return c;
}
async function issue(db,{v2=false,direct=true,codeHash}={}){
 const f={id:randomUUID(),code:codeHash||await code(db,{v2,direct}),access:hash(),refresh:hash(),family:randomUUID()};
 f.args=[f.code,owner,client,resource,redirect,challenge,f.id,f.access,...(v2?[]:[f.family]),f.refresh,direct];
 f.result=await val(db,`select ${v2?'dot_oauth_v2_exchange_refresh':'dot_oauth_exchange_refresh'}(${f.args.map((_,i)=>'$'+(i+1)).join(',')}) as v`,f.args);return f;
}
async function rotate(db,f,{v2=true,...changes}={}){
 const n={id:v2?f.id:randomUUID(),access:hash(),refresh:hash()};
 const a={proof:f.refresh,owner,client,resource,access:n.access,next:n.refresh,direct:true,scope:null,...changes};
 const args=v2?[a.proof,f.id,a.owner,a.client,a.resource,a.access,a.next,a.scope,a.direct]:[a.proof,a.owner,a.client,a.resource,n.id,a.access,a.next,a.direct,a.scope];
 n.result=await val(db,`select ${v2?'dot_oauth_v2_refresh':'dot_oauth_refresh'}($1,$2,$3,$4,$5,$6,$7,$8,$9) as v`,args);return n;
}
const revoke=(db,proof,overrides={})=>{const a={owner,client,resource,...overrides};return val(db,'select dot_oauth_revoke_compatible($1,$2,$3,$4) as v',[proof,a.owner,a.client,a.resource]);};
const guarded=(db,g)=>db.query("select dot_guarded_commit($1,$2,$3,$4,$5,'create_task',0,'{}',false,null,null,true)",[g.id,g.version,g.owner_id,g.client_id,g.resource]);

test('v1 to v2 migration preserves deployed schema definitions, rows and renewable credentials',async t=>{
 const db=await fixture(t,{upgrade:false}),old=await issue(db),plain=randomUUID();
 await db.query("insert into dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at)values($1,$2,$3,$4,$5,array['list_tasks'],clock_timestamp()+interval '1 hour')",[plain,owner,client,resource,hash()]);
 const before=await val(db,"select jsonb_build_object('grants',(select jsonb_agg(g order by id) from dot_api_grants g),'families',(select jsonb_agg(f order by id) from dot_oauth_families f),'tokens',(select jsonb_agg(r order by token_hash) from dot_oauth_refresh_tokens r),'functions',(select jsonb_agg(pg_get_functiondef(oid) order by oid) from pg_proc where pronamespace='public'::regnamespace and proname in ('dot_oauth_refresh','dot_oauth_exchange_refresh','dot_oauth_exchange'))) as v");
 await db.exec(draft());
 const after=await val(db,"select jsonb_build_object('grants',(select jsonb_agg(g order by id) from dot_api_grants g),'families',(select jsonb_agg(f order by id) from dot_oauth_families f),'tokens',(select jsonb_agg(r order by token_hash) from dot_oauth_refresh_tokens r),'functions',(select jsonb_agg(pg_get_functiondef(oid) order by oid) from pg_proc where pronamespace='public'::regnamespace and proname in ('dot_oauth_refresh','dot_oauth_exchange_refresh','dot_oauth_exchange'))) as v");
 assert.deepEqual(after,before);assert.equal(await val(db,'select count(*)::int as v from dot_oauth_v2_sessions'),0);
 assert.equal(await val(db,'select allow_refresh_v2 as v from dot_oauth_codes where code_hash=$1',[old.code]),false);
 const renewed=await rotate(db,old,{v2:false});assert.ok(renewed.result.allowed_tools.includes('record_expense'));assert.ok(!(await grant(db,renewed.id)).revoked_at);
 assert.equal((await issue(db,{v2:true,codeHash:old.code})).result.error,'invalid_grant');
});

test('v2 explicit consent, rotation and replay do not mutate a simultaneous v1 family',async t=>{
 const db=await fixture(t),v1=await issue(db),v1before=await grant(db,v1.id),oldCode=await code(db);
 assert.equal((await issue(db,{v2:true,codeHash:oldCode})).result.error,'invalid_grant');
 const f=await issue(db,{v2:true}),g=await grant(db,f.id);assert.equal(g.oauth_family_id,null);assert.equal(f.result.expires_in,3600);assert.equal(f.result.refresh_token_expires_in,604800);
 const n=await rotate(db,f),after=await grant(db,f.id);assert.equal(n.result.grant_id,f.id);assert.equal(after.version,g.version+1);assert.equal(after.token_hash,n.access);
 await assert.rejects(guarded(db,g),e=>e.code==='42501');await guarded(db,after);
 assert.equal((await rotate(db,f)).result.error,'invalid_grant');assert.ok((await grant(db,f.id)).revoked_at);assert.equal((await rotate(db,n)).result.error,'invalid_grant');
 assert.deepEqual(await grant(db,v1.id),v1before);assert.ok((await rotate(db,v1,{v2:false})).result);
});

test('v2 never widens tools and rejects wrong proof, binding, admin token or lifetime changes',async t=>{
 const db=await fixture(t),f=await issue(db,{v2:true});const before=await grant(db,f.id);
 for(const changes of [{proof:hash()},{owner:randomUUID()},{client:'other'},{resource:'https://other.example/mcp'}]){assert.equal((await rotate(db,f,changes)).result.error,'invalid_grant');assert.deepEqual(await grant(db,f.id),before);}
 for(const scope of ['admin','zama:private zama:private','zama:expenses:write','zama:private  zama:expenses:write'])assert.equal((await rotate(db,f,{scope})).result.error,'invalid_scope');
 const n=await rotate(db,f,{scope:'zama:private'});assert.equal(n.result.scope,'zama:private');
 await db.query("update dot_api_grants set allowed_tools=allowed_tools||array['record_expense'] where id=$1",[f.id]);
 assert.equal((await rotate(db,n)).result.scope,'zama:private');
 for(const mode of ['token','expiry','owner']){const x=await issue(db,{v2:true});if(mode==='token')await db.query('update dot_api_grants set token_hash=$2 where id=$1',[x.id,hash()]);if(mode==='expiry')await db.query("update dot_api_grants set expires_at=expires_at-interval '1 minute' where id=$1",[x.id]);if(mode==='owner')await db.query("update dot_api_grants set client_id='elsewhere' where id=$1",[x.id]);assert.equal((await rotate(db,x)).result.error,'invalid_grant');}
});

test('v2 absolute and idle deadlines, natural access expiry and rollback preserve precise lifetime',async t=>{
 const db=await fixture(t),f=await issue(db,{v2:true});
 await db.query("update dot_api_grants set not_before=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.id]);
 await db.query('update dot_oauth_v2_refresh_tokens set access_expires_at=(select expires_at from dot_api_grants where id=$1) where grant_id=$1',[f.id]);
 await db.query("update dot_oauth_v2_sessions set absolute_expires_at=clock_timestamp()+interval '60 seconds',idle_expires_at=clock_timestamp()+interval '60 seconds' where grant_id=$1",[f.id]);
 const n=await rotate(db,f);assert.ok(n.result.expires_in<=60&&n.result.expires_in>0);assert.ok(n.result.refresh_token_expires_in<=60);
 const other=await issue(db,{v2:true}),before=await grant(db,other.id);await assert.rejects(rotate(db,other,{next:n.refresh}),e=>e.code==='23505');assert.deepEqual(await grant(db,other.id),before);
 assert.equal(await val(db,'select used_at as v from dot_oauth_v2_refresh_tokens where token_hash=$1',[other.refresh]),null);assert.equal((await rotate(db,other)).result.scope,'zama:private zama:expenses:write');
 for(const field of ['idle_expires_at','absolute_expires_at']){const x=await issue(db,{v2:true});await db.query(`update dot_oauth_v2_sessions set created_at=clock_timestamp()-interval '31 days',${field}=clock_timestamp()-interval '1 second',idle_expires_at=clock_timestamp()-interval '1 second' where grant_id=$1`.replace('idle_expires_at=clock_timestamp()-interval \'1 second\',idle_expires_at=','idle_expires_at='),[x.id]);assert.equal((await rotate(db,x)).result.error,'invalid_grant');}
});

test('compatible revocation uses current or retired proof for every generation and no wrong binding',async t=>{
 const db=await fixture(t);
 for(const v2 of [false,true])for(const proofKind of ['oldAccess','oldRefresh','newAccess','newRefresh']){
  const f=await issue(db,{v2}),n=await rotate(db,f,{v2}),proof={oldAccess:f.access,oldRefresh:f.refresh,newAccess:n.access,newRefresh:n.refresh}[proofKind];
  for(const changes of [{client:'other'},{resource:'https://other.example/mcp'},{owner:randomUUID()}]){assert.equal(await revoke(db,proof,changes),true);assert.equal((await grant(db,n.id)).revoked_at,null);}
  assert.equal(await revoke(db,proof),true);assert.ok((await grant(db,n.id)).revoked_at);assert.equal(await revoke(db,proof),true);
  const result=(await rotate(db,n,{v2})).result;assert.ok(v2?result.error==='invalid_grant':result===null);
 }
 const id=randomUUID(),proof=hash();await db.query("insert into dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at)values($1,$2,$3,$4,$5,array['list_tasks'],clock_timestamp()+interval '1 hour')",[id,owner,client,resource,proof]);
 await revoke(db,proof);assert.ok((await grant(db,id)).revoked_at);assert.equal(await revoke(db,hash()),true);
});

test('v2 original code replay revokes stable grant; serial rotation/revoke outcomes cannot resurrect',async t=>{
 const db=await fixture(t),f=await issue(db,{v2:true}),n=await rotate(db,f);
 assert.equal((await issue(db,{v2:true,codeHash:f.code})).result.error,'invalid_grant');assert.ok((await grant(db,n.id)).revoked_at);
 const a=await issue(db,{v2:true});const outcomes=await Promise.all([rotate(db,a),rotate(db,a)]);assert.equal(outcomes.filter(x=>!x.result.error).length,1);assert.ok((await grant(db,a.id)).revoked_at);
 const b=await issue(db,{v2:true});await Promise.all([rotate(db,b),revoke(db,b.refresh)]);assert.ok((await grant(db,b.id)).revoked_at);
 const c=await issue(db,{v2:true});await revoke(db,c.refresh);assert.equal((await rotate(db,c)).result.error,'invalid_grant');
 // PGlite serializes queries: independent PostgreSQL connections remain required for lock evidence.
});

test('v2 inherited privileges removed, RLS forced and RPCs usable only by server role',async t=>{
 const db=await fixture(t);
 for(const role of ['anon','authenticated','service_role']){
  for(const table of ['dot_oauth_v2_sessions','dot_oauth_v2_refresh_tokens'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal(await val(db,'select has_table_privilege($1,$2,$3) as v',[role,table,privilege]),false);
  for(const fn of funcs)assert.equal(await val(db,"select has_function_privilege($1,$2,'EXECUTE') as v",[role,fn]),role==='service_role');
 }
 assert.equal(await val(db,"select bool_and(relrowsecurity and relforcerowsecurity) as v from pg_class where relname in ('dot_oauth_v2_sessions','dot_oauth_v2_refresh_tokens')"),true);
 const f=await issue(db,{v2:true});await db.exec('set role service_role');assert.equal((await rotate(db,f)).result.scope,'zama:private zama:expenses:write');await db.exec('reset role');
 await db.query('delete from auth.users where id=$1',[owner]);assert.equal(await val(db,'select count(*)::int as v from dot_oauth_v2_sessions'),0);assert.equal(await val(db,'select count(*)::int as v from dot_oauth_v2_refresh_tokens'),0);
});

test('v2 code proofs bind owner/client/resource/redirect/PKCE before replay revocation and base consent never expands',async t=>{
 const db=await fixture(t),c=await code(db,{v2:true,direct:false});
 const args=[c,owner,client,resource,redirect,challenge,randomUUID(),hash(),hash(),true];
 for(const [index,value] of [[1,randomUUID()],[2,'other-client'],[3,'https://other.example/mcp'],[4,'https://other.example/cb'],[5,'B'.repeat(43)]]){
  const wrong=[...args];wrong[index]=value;
  assert.equal((await val(db,'select dot_oauth_v2_exchange_refresh($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as v',wrong)).error,'invalid_grant');
  assert.equal(await val(db,'select used_grant_id as v from dot_oauth_codes where code_hash=$1',[c]),null);
 }
 const f=await issue(db,{v2:true,codeHash:c});assert.equal(f.result.scope,'zama:private');const n=await rotate(db,f);assert.equal(n.result.scope,'zama:private');
 const wrongReplay=[...f.args];wrongReplay[5]='B'.repeat(43);wrongReplay[6]=randomUUID();wrongReplay[7]=hash();wrongReplay[8]=hash();
 assert.equal((await val(db,'select dot_oauth_v2_exchange_refresh($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as v',wrongReplay)).error,'invalid_grant');
 assert.equal((await grant(db,f.id)).revoked_at,null);assert.equal((await rotate(db,n,{scope:'zama:private zama:expenses:write'})).result.error,'invalid_scope');
 const expired=await code(db,{v2:true});await db.query("update dot_oauth_codes set expires_at=clock_timestamp()-interval '1 second' where code_hash=$1",[expired]);
 assert.equal((await issue(db,{v2:true,codeHash:expired})).result.error,'invalid_grant');assert.equal(await val(db,'select used_grant_id as v from dot_oauth_codes where code_hash=$1',[expired]),null);
});
