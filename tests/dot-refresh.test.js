'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {createHash,randomUUID}=require('node:crypto');
const {Readable}=require('node:stream');
const {PGlite}=require('@electric-sql/pglite');
const {createHandler,metadata,configuration}=require('../services/dot/oauth');
const {createApiKeyAuthenticator}=require('../services/dot/api-key-auth');

const owner='11111111-1111-4111-8111-111111111111',origin='https://zama.example',resource=origin+'/api/dot-mcp',clientId='fixture',redirect='https://chatgpt.com/cb';
const config={ownerId:owner,origin,resource,clientId,redirects:[redirect],directExpensesEnabled:true,refreshEnabled:true};
const sha=value=>createHash('sha256').update(value).digest('hex');
const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
const authorization={response_type:'code',client_id:clientId,redirect_uri:redirect,resource,scope:'zama:private',state:'fixture',code_challenge:challenge,code_challenge_method:'S256'};
const migration='database/migrations/20261104174518_dot_oauth_refresh.sql';

async function invoke(handler,body,path='/api/dot-oauth/token',headers={}) {
 const form=path.endsWith('token');
 const req=Readable.from([form?new URLSearchParams(body).toString():JSON.stringify(body)]);
 req.method='POST';req.url=path;req.headers={host:'zama.example','content-type':form?'application/x-www-form-urlencoded':'application/json',...headers};
 let result;const responseHeaders={};
 await handler(req,{setHeader(k,v){responseHeaders[k]=v;},end(body){result={status:this.statusCode,headers:responseHeaders,body:JSON.parse(body)};}});
 return result;
}
async function fixture(t,{inherited=false}={}) {
 const db=new PGlite();t.after(()=>db.close());
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table app_state(user_id uuid primary key references auth.users(id),data jsonb not null default '{}',updated_at timestamptz not null default now());");
 if(inherited)await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;');
 for(const file of ['database/migrations/20260930_jarvis.sql','database/migrations/20261104_dot_grants.sql','database/dot-oauth-draft.sql','database/migrations/20261104_dot_direct_expenses.sql'])await db.exec(readFileSync(file,'utf8'));
 await db.query('insert into auth.users values($1)',[owner]);
 const old=randomUUID();await db.query("insert into dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at)values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')",[old,owner,clientId,resource,sha(old),['prepare_expense']]);
 const before=(await db.query('select * from dot_api_grants where id=$1',[old])).rows[0];
 await db.exec(readFileSync(migration,'utf8'));
 const after=(await db.query('select * from dot_api_grants where id=$1',[old])).rows[0];delete after.oauth_family_id;assert.deepEqual(after,before);
 const rpcKeys={
  dot_oauth_exchange:['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_direct_enabled'],
  dot_oauth_exchange_refresh:['p_code_hash','p_owner','p_client','p_resource','p_redirect','p_challenge','p_grant','p_token_hash','p_family','p_refresh_hash','p_direct_enabled'],
  dot_oauth_refresh:['p_refresh_hash','p_owner','p_client','p_resource','p_grant','p_token_hash','p_next_refresh_hash','p_direct_enabled','p_scope'],
 };
 const client={auth:{getUser:async()=>({data:{user:{id:owner}}})},from(table){assert.equal(table,'dot_oauth_codes');return {insert:async row=>{await db.query('insert into dot_oauth_codes(code_hash,owner_id,client_id,resource,redirect_uri,challenge,allow_direct_expense)values($1,$2,$3,$4,$5,$6,$7)',[row.code_hash,row.owner_id,row.client_id,row.resource,row.redirect_uri,row.challenge,row.allow_direct_expense||false]);return {};}};},async rpc(name,args){assert.ok(rpcKeys[name]);try{const values=rpcKeys[name].map(key=>args[key]??(key==='p_direct_enabled'?false:null));return {data:(await db.query(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) as value`,values)).rows[0].value};}catch(error){return {error};}}};
 const handler=(overrides={})=>createHandler({config:{...config,...overrides},client,preRate:async()=>{},rate:async()=>{}});
 async function issue({direct=true,handlerOptions={}}={}) {
   const h=handler(handlerOptions),consent=await invoke(h,{request:authorization,approve:true,consent_direct:direct},'/api/dot-oauth/consent',{origin,authorization:'Bearer fixture'});
   assert.equal(consent.status,200);
   const code=new URL(consent.body.redirect).searchParams.get('code');
   const form={grant_type:'authorization_code',client_id:clientId,code,redirect_uri:redirect,resource,code_verifier:verifier};
   const response=await invoke(h,form);assert.equal(response.status,200);
   return {...response.body,form};
 }
 const refresh=(token,extra={},overrides={})=>invoke(handler(overrides),{grant_type:'refresh_token',client_id:clientId,refresh_token:token,...extra});
 const grantId=token=>token.split('.')[1];
 const auth=createApiKeyAuthenticator({ownerId:owner,clientId,resource,store:{find:async id=>{const g=(await db.query('select * from dot_api_grants where id=$1',[id])).rows[0];if(g)for(const key of ['not_before','expires_at','revoked_at'])if(g[key] instanceof Date)g[key]=g[key].toISOString();return g;}}});
 return {db,client,handler,issue,refresh,grantId,auth};
}

test('refresh is feature gated and metadata advertises only implemented grant types',()=>{
 assert.deepEqual(metadata(config,false).grant_types_supported,['authorization_code','refresh_token']);
 assert.deepEqual(metadata({...config,refreshEnabled:false},false).grant_types_supported,['authorization_code']);
 const env={DOT_OAUTH_ENABLED:'true',APP_ORIGIN:origin,DOT_MCP_RESOURCE:resource,DOT_OWNER_ID:owner,DOT_MCP_CLIENT_ID:clientId,DOT_OAUTH_REDIRECT_URIS:JSON.stringify([redirect])};
 assert.equal(configuration(env).refreshEnabled,false);assert.equal(configuration({...env,DOT_OAUTH_REFRESH_ENABLED:'true'}).refreshEnabled,true);
});

test('consent checkbox cannot silently widen base permission; requires owner session and enabled direct flag',async()=>{
 const rows=[];let actor=owner;const client={auth:{getUser:async()=>({data:{user:{id:actor}}})},from:()=>({insert:async row=>{rows.push(row);return {};}})};
 const h=overrides=>createHandler({config:{...config,...overrides},client,preRate:async()=>{},rate:async()=>{}});
 const headers={origin,authorization:'Bearer fixture'};
 assert.equal((await invoke(h(),{request:authorization,approve:true},'/api/dot-oauth/consent',headers)).status,200);
 assert.equal(rows[0].allow_direct_expense,false);
 assert.equal((await invoke(h(),{request:authorization,approve:true,consent_direct:true},'/api/dot-oauth/consent',headers)).status,200);
 assert.equal(rows[1].allow_direct_expense,true);
 assert.equal((await invoke(h({directExpensesEnabled:false}),{request:authorization,approve:true,consent_direct:true},'/api/dot-oauth/consent',headers)).status,400);
 actor=randomUUID();assert.equal((await invoke(h(),{request:authorization,approve:true,consent_direct:true},'/api/dot-oauth/consent',headers)).status,403);
 assert.equal(rows.length,2);
});

test('code exchange issues hashed refresh; expired access renews without consent, rotates and preserves scopes',async t=>{
 const f=await fixture(t),first=await f.issue();assert.equal(first.scope,'zama:private zama:expenses:write');
 assert.match(first.refresh_token,/^zama_refresh_v1\.[A-Za-z0-9_-]{43}$/);assert.equal(first.expires_in,3600);
 const rows=(await f.db.query('select * from dot_oauth_refresh_tokens')).rows;assert.equal(rows.length,1);assert.equal(rows[0].token_hash,sha(first.refresh_token));assert.ok(!JSON.stringify(rows).includes(first.refresh_token));
 const id=f.grantId(first.access_token);
 // Move only the fixture's wall-clock boundary; keep its authorized version in sync.
 await f.db.query("update dot_api_grants set not_before=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 second' where id=$1",[id]);
 await f.db.query('update dot_oauth_families set current_grant_version=(select version from dot_api_grants where id=$1)',[id]);
 assert.equal(await f.auth(first.access_token,{resource}),null);
 const renewed=await f.refresh(first.refresh_token);assert.equal(renewed.status,200);assert.equal(renewed.body.scope,first.scope);assert.notEqual(renewed.body.refresh_token,first.refresh_token);
 assert.ok(await f.auth(renewed.body.access_token,{resource}));
 const family=(await f.db.query('select * from dot_oauth_families')).rows[0];assert.ok(new Date(family.idle_expires_at)-new Date(family.last_used_at)>=30*86400000-100);
 assert.equal((await f.db.query('select count(*)::int as n from app_state')).rows[0].n,0);
 assert.equal((await f.db.query('select count(*)::int as n from jarvis_accounts')).rows[0].n,0);
});

test('refresh rejects wrong proofs and bindings without revoking valid family; scope never expands',async t=>{
 const f=await fixture(t),first=await f.issue({direct:false});
 for(const change of [{client_id:'wrong'},{resource:'https://other.example/api/dot-mcp'},{refresh_token:'zama_refresh_v1.'+'A'.repeat(43)},{scope:'zama:private zama:expenses:write'},{scope:'admin'},{scope:'zama:private zama:private'},{owner_id:owner}])assert.equal((await f.refresh(first.refresh_token,change)).status,400);
 const correctHash=sha(first.refresh_token),args={p_refresh_hash:correctHash,p_owner:randomUUID(),p_client:clientId,p_resource:resource,p_grant:randomUUID(),p_token_hash:sha('unissued'),p_next_refresh_hash:sha('unissued-next'),p_direct_enabled:true,p_scope:null};
 assert.equal((await f.client.rpc('dot_oauth_refresh',args)).data,null);
 const renewed=await f.refresh(first.refresh_token);assert.equal(renewed.status,200);assert.equal(renewed.body.scope,'zama:private');
 const full=await f.issue(),narrowed=await f.refresh(full.refresh_token,{scope:'zama:private'});assert.equal(narrowed.body.scope,'zama:private');
 assert.equal((await f.refresh(narrowed.body.refresh_token,{scope:'zama:private zama:expenses:write'})).status,400);
 const off=await f.issue(),reduced=await f.refresh(off.refresh_token,{}, {directExpensesEnabled:false});assert.equal(reduced.body.scope,'zama:private');
 assert.equal((await f.refresh(reduced.body.refresh_token)).body.scope,'zama:private');
});

test('proven refresh replay and concurrent reuse revoke all descendant credentials',async t=>{
 const f=await fixture(t),first=await f.issue(),second=await f.refresh(first.refresh_token),third=await f.refresh(second.body.refresh_token);
 assert.equal((await f.refresh(first.refresh_token)).status,400);
 assert.equal(await f.auth(third.body.access_token,{resource}),null);assert.equal((await f.refresh(third.body.refresh_token)).status,400);
 const other=await f.issue(),race=await Promise.all([f.refresh(other.refresh_token),f.refresh(other.refresh_token)]);
 assert.deepEqual(race.map(x=>x.status).sort(),[200,400]);
 assert.equal(await f.auth(race.find(x=>x.status===200).body.access_token,{resource}),null);
});

test('legacy authorization-code replay after rotations revokes current access and refresh family',async t=>{
 const f=await fixture(t),first=await f.issue(),second=await f.refresh(first.refresh_token),third=await f.refresh(second.body.refresh_token);
 const replay=await invoke(f.handler({refreshEnabled:false}),first.form);assert.equal(replay.status,400);
 assert.equal(await f.auth(third.body.access_token,{resource}),null);assert.equal((await f.refresh(third.body.refresh_token)).status,400);
});

test('family/grant revocation, version changes and idle expiry block refresh and guarded commits',async t=>{
 const f=await fixture(t);
 for(const reason of ['family','grant','version','idle','not_before']){
  const issued=await f.issue(),id=f.grantId(issued.access_token),g=(await f.db.query('select * from dot_api_grants where id=$1',[id])).rows[0];
  if(reason==='family')await f.db.query('update dot_oauth_families set revoked_at=clock_timestamp() where id=$1',[g.oauth_family_id]);
  if(reason==='grant')await f.db.query('update dot_api_grants set revoked_at=clock_timestamp() where id=$1',[id]);
  if(reason==='version')await f.db.query("update dot_api_grants set allowed_tools=array['prepare_expense']::text[] where id=$1",[id]);
  if(reason==='idle')await f.db.query("update dot_oauth_families set idle_expires_at=clock_timestamp()-interval '1 second' where id=$1",[g.oauth_family_id]);
  if(reason==='not_before')await f.db.query("update dot_api_grants set not_before=clock_timestamp()+interval '5 minutes' where id=$1",[id]);
  assert.equal((await f.refresh(issued.refresh_token)).status,400,reason);
  assert.equal(await f.auth(issued.access_token,{resource}),null,reason);
  await assert.rejects(f.db.query('select dot_guarded_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,g.version,owner,clientId,resource,'prepare_expense',0,'{}',false,null,null,true]),error=>error.code==='42501');
 }
});

test('rotation failures roll back token consumption; refresh tables and functions reject browser roles',async t=>{
 const f=await fixture(t,{inherited:true}),issued=await f.issue(),hash=sha(issued.refresh_token);
 const collision={p_refresh_hash:hash,p_owner:owner,p_client:clientId,p_resource:resource,p_grant:randomUUID(),p_token_hash:sha('new-access'),p_next_refresh_hash:hash,p_direct_enabled:true,p_scope:null};
 assert.equal((await f.client.rpc('dot_oauth_refresh',collision)).error.code,'23505');
 assert.equal((await f.db.query('select used_at from dot_oauth_refresh_tokens where token_hash=$1',[hash])).rows[0].used_at,null);
 assert.ok(await f.auth(issued.access_token,{resource}));assert.equal((await f.refresh(issued.refresh_token)).status,200);
 for(const role of ['anon','authenticated','service_role'])for(const table of ['dot_oauth_families','dot_oauth_refresh_tokens'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await f.db.query('select has_table_privilege($1,$2,$3) as ok',[role,table,privilege])).rows[0].ok,false);
 for(const role of ['anon','authenticated'])for(const signature of ['dot_oauth_refresh(text,uuid,text,text,uuid,text,text,boolean,text)','dot_oauth_exchange_refresh(text,uuid,text,text,text,text,uuid,text,uuid,text,boolean)','dot_oauth_revoke_family(uuid)','dot_oauth_family_revoked()'])assert.equal((await f.db.query('select has_function_privilege($1,$2,\'EXECUTE\') as ok',[role,signature])).rows[0].ok,false);
 assert.equal((await f.db.query("select has_function_privilege('service_role','dot_oauth_refresh(text,uuid,text,text,uuid,text,text,boolean,text)','EXECUTE') as ok")).rows[0].ok,true);
});
