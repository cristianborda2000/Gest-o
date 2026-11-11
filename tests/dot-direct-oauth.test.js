'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{readFileSync}=require('node:fs'),{PGlite}=require('@electric-sql/pglite');
const {validateAuthorization,metadata,createHandler}=require('../services/dot/oauth');
const {Readable}=require('node:stream');
const owner='11111111-1111-4111-8111-111111111111',origin='https://zama.example',resource=origin+'/api/dot-mcp';
const config={ownerId:owner,origin,resource,clientId:'fixture',redirects:['https://chatgpt.com/cb'],directExpensesEnabled:true};
const request={response_type:'code',client_id:'fixture',redirect_uri:config.redirects[0],resource,scope:'zama:private zama:expenses:write',state:'test',code_challenge:'A'.repeat(43),code_challenge_method:'S256'};
test('direct OAuth scope opt-in: base preserved, unknown/duplicate/off rejected',()=>{assert.equal(validateAuthorization(request,config).scope,request.scope);assert.equal(validateAuthorization({...request,scope:'zama:private'},config).scope,'zama:private');assert.throws(()=>validateAuthorization(request,{...config,directExpensesEnabled:false}));for(const scope of ['zama:expenses:write','zama:private admin','zama:private zama:private'])assert.throws(()=>validateAuthorization({...request,scope},config));assert.deepEqual(metadata({...config,directExpensesEnabled:false},true).scopes_supported,['zama:private']);assert.ok(metadata(config,true).scopes_supported.includes('zama:expenses:write'));});
async function invoke(h,body){const req=Readable.from([JSON.stringify(body)]);req.url='/api/dot-oauth/consent';req.method='POST';req.headers={host:'zama.example',origin,authorization:'Bearer fixture','content-type':'application/json'};let result;await h(req,{setHeader(){},end(s){result={status:this.statusCode,body:JSON.parse(s)};}});return result;}
test('consent stores direct permission only for explicit approved direct scope',async()=>{const rows=[],client={auth:{getUser:async()=>({data:{user:{id:owner}}})},from:()=>({insert:async row=>{rows.push(row);return {};}})};const h=createHandler({config,client,preRate:async()=>{},rate:async()=>{}});assert.equal((await invoke(h,{request,approve:false})).status,200);assert.equal(rows.length,0);await invoke(h,{request,approve:true});await invoke(h,{request:{...request,scope:'zama:private'},approve:true});assert.deepEqual(rows.map(x=>x.allow_direct_expense),[true,false]);});
test('SQL migration preserves old grants; only new direct consent plus enabled exchange grants direct',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table app_state(user_id uuid primary key references auth.users(id),data jsonb not null default '{}',updated_at timestamptz not null default now());");
 for(const f of ['database/migrations/20260930_jarvis.sql','database/migrations/20261104_dot_grants.sql','database/dot-oauth-draft.sql'])await db.exec(readFileSync(f,'utf8'));
 await db.query('insert into auth.users values($1)',[owner]);const old=randomUUID();await db.query("insert into dot_api_grants(id,owner_id,client_id,resource,token_hash,allowed_tools,expires_at)values($1,$2,'fixture',$3,$4,$5,clock_timestamp()+interval '1 hour')",[old,owner,resource,'a'.repeat(64),['prepare_expense']]);const before=(await db.query('select * from dot_api_grants where id=$1',[old])).rows[0];
 await db.exec(readFileSync('database/migrations/20261104_dot_direct_expenses.sql','utf8'));assert.deepEqual((await db.query('select * from dot_api_grants where id=$1',[old])).rows[0],before);
 let i=0;for(const [consented,enabled,expected] of [[false,false,false],[false,true,false],[true,false,false],[true,true,true]]){
  const code=String(++i).repeat(64),id=randomUUID();await db.query('insert into dot_oauth_codes(code_hash,owner_id,client_id,resource,redirect_uri,challenge,allow_direct_expense)values($1,$2,$3,$4,$5,$6,$7)',[code,owner,'fixture',resource,config.redirects[0],'A'.repeat(43),consented]);
  const values=[code,owner,'fixture',resource,config.redirects[0],'A'.repeat(43),id,String(i+5).repeat(64),enabled];assert.equal((await db.query('select dot_oauth_exchange($1,$2,$3,$4,$5,$6,$7,$8,$9)as ok',values)).rows[0].ok,true);
  const grant=(await db.query('select * from dot_api_grants where id=$1',[id])).rows[0];assert.equal(grant.allowed_tools.includes('record_expense'),expected);
  const commit=[id,grant.version,owner,'fixture',resource,'record_expense',0,'{}',false,null,null,true];
  if(expected){
    const client={from(table){return {select:()=>({eq:(column,value)=>({maybeSingle:async()=>({data:(await db.query(table==='app_state'?'select data,updated_at::text as updated_at from app_state where user_id=$1':'select data,revision from jarvis_accounts where user_id=$1',[value])).rows[0]||null})})})};},async rpc(name,a){assert.equal(name,'dot_guarded_commit');try{return {data:(await db.query('select dot_guarded_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)as v',[a.p_grant_id,a.p_version,a.p_user_id,a.p_client_id,a.p_resource,a.p_tool,a.p_revision,JSON.stringify(a.p_data),a.p_write_state,a.p_state_revision,a.p_state===null?null:JSON.stringify(a.p_state),a.p_unchanged])).rows[0].v};}catch(error){return {error};}}};
    const principal={userId:owner,clientId:'fixture',audience:resource,grantId:id,grantVersion:grant.version,allowedTools:grant.allowed_tools};
    const repo=require('../services/dot/guarded-repository').createGuardedRepository(client,principal).withTool('record_expense');
    const service=require('../services/dot/service').createService({repository:repo,ownerId:owner,origin,directExpensesEnabled:true,allowedTools:principal.allowedTools});
    const request={name:'record_expense',request_id:randomUUID(),arguments:{amount:'10000000000.01',status:'pending',category:'Marketing',description:'DB fixture',date:'2026-11-04'}};
    await service.call(request);await service.call(request);
    const audit=(await db.query('select data from jarvis_accounts')).rows[0].data.actions;assert.equal(audit.length,1);assert.equal(audit[0].grant_id,id);
    assert.equal((await db.query('select data from app_state')).rows[0].data.financeiro.length,1);
    await db.query('update dot_api_grants set revoked_at=clock_timestamp() where id=$1',[id]);await assert.rejects(service.call(request),e=>e.code==='DOT_GRANT_DENIED');
  }
  await assert.rejects(db.query('select dot_guarded_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',commit),e=>e.code==='42501');
 }
 assert.equal((await db.query("select has_function_privilege('authenticated','dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text,boolean)','EXECUTE')as ok")).rows[0].ok,false);
 assert.equal((await db.query('select count(*) from app_state')).rows[0].count,1);
});
