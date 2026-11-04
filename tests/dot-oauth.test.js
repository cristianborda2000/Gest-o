'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream'),{readFileSync}=require('node:fs'),{createHash,randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {createHandler,configuration}=require('../services/dot/oauth');
const {createPrivateMcpHandler}=require('../services/dot/private-runtime');
const owner='11111111-1111-4111-8111-111111111111',origin='https://zama.example',resource=origin+'/api/dot-mcp',redirect='https://chatgpt.com/connector_platform_oauth_redirect';
const config={origin,resource,ownerId:owner,clientId:'fixture',redirects:[redirect]};
const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url');
const request={response_type:'code',client_id:'fixture',redirect_uri:redirect,resource,scope:'zama:private',state:'opaque-state',code_challenge:challenge,code_challenge_method:'S256'};
test('pre-authentication persistent limit blocks anonymous requests and fails closed',async()=>{
 let bucket;
 const db={rpc:async(name,args)=>{assert.equal(name,'jarvis_consume_rate');bucket=args;return {data:false};}};
 const h=createHandler({config,client:db});
 const r=await invoke(h,'/api/dot-oauth/token','POST','',{'content-type':'application/x-www-form-urlencoded'});
 assert.equal(r.status,429);assert.equal(r.headers['Retry-After'],'60');assert.equal(bucket.p_bucket,'dot_oauth_public');assert.equal(bucket.p_limit,120);
 db.rpc=async()=>({error:{message:'fixture outage'}});assert.equal((await invoke(h,'/api/dot-oauth/authorize')).status,503);
 assert.equal((await invoke(h,'/.well-known/oauth-authorization-server')).status,200);
});
async function invoke(handler,path,method='GET',body,headers={}) {
 const req=Readable.from(body===undefined?[]:[typeof body==='string'?body:JSON.stringify(body)]);req.url=path;req.method=method;req.headers={host:'zama.example',...headers};let result;
 const h={};await handler(req,{setHeader(k,v){h[k]=v;},removeHeader(k){delete h[k];},end(b){result={status:this.statusCode,headers:h,body:b?JSON.parse(b):null};}});return result;
}
function stub(){const rows=[];let actor=owner;return {rows,setActor(v){actor=v;},auth:{async getUser(){return {data:{user:{id:actor}}};}},from(){return {insert:async row=>{rows.push(row);return {};}};}};}
test('OAuth remains opt-in and configuration rejects unsafe redirects',()=>{
 assert.equal(configuration({}),null);
 const env={DOT_OAUTH_ENABLED:'true',APP_ORIGIN:origin,DOT_MCP_RESOURCE:resource,DOT_OWNER_ID:owner,DOT_MCP_CLIENT_ID:'fixture',DOT_OAUTH_REDIRECT_URIS:JSON.stringify([redirect])};
 assert.equal(configuration(env).redirects[0],redirect);
 for(const uri of ['http://evil.example/cb','https://evil.example/*','https://user@evil.example/cb','https://evil.example/#x']) assert.throws(()=>configuration({...env,DOT_OAUTH_REDIRECT_URIS:JSON.stringify([uri])}));
});
test('discovery and authorization GET expose no data and issue no code',async()=>{
 const db=stub(),h=createHandler({config,client:db,rate:async()=>{},preRate:async()=>{}});
 const m=await invoke(h,'/.well-known/oauth-authorization-server');assert.deepEqual(m.body.code_challenge_methods_supported,['S256']);assert.deepEqual(m.body.token_endpoint_auth_methods_supported,['none']);assert.equal(m.body.authorization_response_iss_parameter_supported,true);
 assert.equal((await invoke(h,'/api/dot-oauth?path=resource')).body.resource,resource);
 assert.equal((await invoke(h,'/api/dot-oauth/authorize?'+new URLSearchParams(request))).status,302);assert.equal(db.rows.length,0);
 for(const changes of [{redirect_uri:'https://evil.example/cb'},{resource:'https://evil.example/mcp'},{client_id:'other'},{code_challenge_method:'plain'},{scope:'admin'}]) assert.equal((await invoke(h,'/api/dot-oauth/authorize?'+new URLSearchParams({...request,...changes}))).status,400);
 assert.equal((await invoke(h,'/api/dot-oauth/authorize?'+new URLSearchParams(request)+'&state=second')).status,400);
});
test('consent requires same-origin owner session, denial creates no credential',async()=>{
 const db=stub(),h=createHandler({config,client:db,rate:async()=>{},preRate:async()=>{}}),headers={origin,authorization:'Bearer fixture','content-type':'application/json'};
 assert.equal((await invoke(h,'/api/dot-oauth/consent','POST',{request,approve:true},{...headers,origin:'https://evil.example'})).status,403);
 db.setActor('22222222-2222-4222-8222-222222222222');assert.equal((await invoke(h,'/api/dot-oauth/consent','POST',{request,approve:true},headers)).status,403);db.setActor(owner);
 const denied=await invoke(h,'/api/dot-oauth/consent','POST',{request,approve:false},headers);assert.equal(new URL(denied.body.redirect).searchParams.get('error'),'access_denied');assert.equal(db.rows.length,0);
 const allowed=await invoke(h,'/api/dot-oauth/consent','POST',{request,approve:true},headers),url=new URL(allowed.body.redirect);
 assert.equal(url.searchParams.get('iss'),origin);assert.equal(url.searchParams.get('state'),request.state);assert.equal(db.rows[0].code_hash,createHash('sha256').update(url.searchParams.get('code')).digest('hex'));assert.ok(!JSON.stringify(db.rows).includes(url.searchParams.get('code')));
});
async function setup(t){const db=new PGlite();t.after(()=>db.close());await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table app_state(user_id uuid primary key references auth.users(id),data jsonb not null default \'{}\',updated_at timestamptz not null default now());');for(const f of ['database/migrations/20260930_jarvis.sql','database/migrations/20261104_dot_grants.sql','database/dot-oauth-draft.sql'])await db.exec(readFileSync(f,'utf8'));await db.query('insert into auth.users values($1)',[owner]);return db;}
test('real SQL exchange is one-use, enforces bindings and revokes on proven replay',async t=>{
 const db=await setup(t),code='a'.repeat(64),grant=randomUUID(),tokenHash='b'.repeat(64);
 await db.query('insert into dot_oauth_codes(code_hash,owner_id,client_id,resource,redirect_uri,challenge)values($1,$2,$3,$4,$5,$6)',[code,owner,'fixture',resource,redirect,challenge]);
 const values=[code,owner,'fixture',resource,redirect,challenge,grant,tokenHash];
 const exchange=async v=>(await db.query('select dot_oauth_exchange($1,$2,$3,$4,$5,$6,$7,$8) as ok',v)).rows[0].ok;
 for(const index of [1,2,3,4,5]){const v=[...values];v[index]=index===1?randomUUID():'wrong';assert.equal(await exchange(v),false);}
 assert.equal(await exchange(values),true);
 const g=(await db.query('select * from dot_api_grants where id=$1',[grant])).rows[0];assert.equal(g.allowed_tools.length,7);assert.equal(g.revoked_at,null);assert.ok(new Date(g.expires_at)-new Date(g.not_before)<=3600100);
 assert.equal(await exchange(values),false);assert.ok((await db.query('select revoked_at from dot_api_grants where id=$1',[grant])).rows[0].revoked_at);
 assert.equal((await db.query("select has_table_privilege('anon','dot_oauth_codes','SELECT') as allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_table_privilege('service_role','dot_api_grants','INSERT') as allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_function_privilege('authenticated','dot_oauth_exchange(text,uuid,text,text,text,text,uuid,text)','EXECUTE') as allowed")).rows[0].allowed,false);
});
test('token HTTP validates PKCE form and delegates atomic exchange; refresh unsupported',async()=>{
 let call;const db={rpc:async(name,args)=>{call={name,args};return {data:true};}};
 const h=createHandler({config,client:db,preRate:async()=>{}}),input={grant_type:'authorization_code',client_id:'fixture',code:'A'.repeat(43),redirect_uri:redirect,resource,code_verifier:verifier};
 const headers={'content-type':'application/x-www-form-urlencoded'};
 const ok=await invoke(h,'/api/dot-oauth/token','POST',new URLSearchParams(input).toString(),headers);assert.equal(ok.status,200);assert.equal(ok.body.expires_in,3600);assert.equal(ok.body.refresh_token,undefined);assert.equal(call.args.p_challenge,challenge);assert.equal(call.args.p_token_hash,createHash('sha256').update(ok.body.access_token).digest('hex'));
 for(const changes of [{grant_type:'refresh_token'},{code_verifier:'short'},{redirect_uri:'https://evil.example'},{resource:'https://evil.example'}])assert.equal((await invoke(h,'/api/dot-oauth/token','POST',new URLSearchParams({...input,...changes}).toString(),headers)).status,400);
 assert.equal((await invoke(h,'/api/dot-oauth/token','POST',new URLSearchParams(input)+'&code=second',headers)).status,400);
});
test('MCP advertises OAuth discovery without accepting an account session as plugin token',async()=>{
 const env={DOT_MCP_ENABLED:'true',DOT_OAUTH_ENABLED:'true',APP_ORIGIN:origin,DOT_MCP_RESOURCE:resource,DOT_OWNER_ID:owner,DOT_MCP_CLIENT_ID:'fixture',DOT_OAUTH_REDIRECT_URIS:JSON.stringify([redirect])};
 const h=createPrivateMcpHandler({env,client:{}}),r=await invoke(h,'/api/dot-mcp');assert.equal(r.status,401);assert.ok(r.headers['WWW-Authenticate'].includes('/.well-known/oauth-protected-resource'));
});

test('consent to SQL token exchange authenticates the same scoped principal; expired codes fail',async t=>{
 const db=await setup(t);
 const client={auth:{getUser:async()=>({data:{user:{id:owner}}})},from:()=>({insert:async r=>{await db.query('insert into dot_oauth_codes(code_hash,owner_id,client_id,resource,redirect_uri,challenge)values($1,$2,$3,$4,$5,$6)',[r.code_hash,r.owner_id,r.client_id,r.resource,r.redirect_uri,r.challenge]);return {};}}),rpc:async(name,args)=>{assert.equal(name,'dot_oauth_exchange');const {rows}=await db.query('select dot_oauth_exchange($1,$2,$3,$4,$5,$6,$7,$8) as ok',[args.p_code_hash,args.p_owner,args.p_client,args.p_resource,args.p_redirect,args.p_challenge,args.p_grant,args.p_token_hash]);return {data:rows[0].ok};}};
 const h=createHandler({config,client,rate:async()=>{},preRate:async()=>{}});
 const consent=await invoke(h,'/api/dot-oauth/consent','POST',{request,approve:true},{origin,authorization:'Bearer fixture-session','content-type':'application/json'});
 const code=new URL(consent.body.redirect).searchParams.get('code');
 const form=new URLSearchParams({grant_type:'authorization_code',client_id:'fixture',code,redirect_uri:redirect,resource,code_verifier:verifier}).toString();
 const issued=await invoke(h,'/api/dot-oauth/token','POST',form,{'content-type':'application/x-www-form-urlencoded'});assert.equal(issued.status,200);
 const {createApiKeyAuthenticator}=require('../services/dot/api-key-auth');
 const auth=createApiKeyAuthenticator({ownerId:owner,clientId:'fixture',resource,store:{find:async id=>{const row=(await db.query('select * from dot_api_grants where id=$1',[id])).rows[0];return row?{...row,expires_at:row.expires_at.toISOString(),not_before:row.not_before.toISOString()}:null;}}});
 const principal=await auth(issued.body.access_token,{resource});assert.equal(principal.userId,owner);assert.equal(principal.allowedTools.length,7);assert.ok(!principal.allowedTools.includes('confirm_expense'));
 assert.equal((await invoke(h,'/api/dot-oauth/token','POST',form,{'content-type':'application/x-www-form-urlencoded'})).status,400);assert.equal(await auth(issued.body.access_token,{resource}),null);
 const second=await invoke(h,'/api/dot-oauth/consent','POST',{request,approve:true},{origin,authorization:'Bearer fixture-session','content-type':'application/json'});
 const expiredCode=new URL(second.body.redirect).searchParams.get('code');await db.query("update dot_oauth_codes set expires_at=clock_timestamp()-interval '1 second' where code_hash=$1",[createHash('sha256').update(expiredCode).digest('hex')]);
 const expiredForm=new URLSearchParams({grant_type:'authorization_code',client_id:'fixture',code:expiredCode,redirect_uri:redirect,resource,code_verifier:verifier}).toString();
 assert.equal((await invoke(h,'/api/dot-oauth/token','POST',expiredForm,{'content-type':'application/x-www-form-urlencoded'})).status,400);
 assert.equal((await db.query('select count(*)::int as n from dot_api_grants')).rows[0].n,1);
});
