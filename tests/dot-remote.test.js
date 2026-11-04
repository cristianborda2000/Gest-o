'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createMcpHandler } = require('../services/dot/mcp-http');
const { definitions } = require('../services/dot/service');
const owner = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-11-04T12:00:00Z');
function memory() {
 let saved = { state: {}, jarvis: { actions: [] } }, chain = Promise.resolve();
 return { userId: owner, consumeRate: async()=>{}, read:async()=>structuredClone(saved), transact(fn) {
 const job=chain.then(()=>{const snap=structuredClone(saved), change=fn(snap); if(!change.unchanged){if(!change.writeState)snap.state=saved.state;saved=snap;}return structuredClone(change.result);});chain=job.catch(()=>{});return job;
 } };
}
async function fixture(t, options={}) {
 const repository=memory(); let revoked=false, calls=0;
 const config={enabled:true,localTest:true,appOrigin:'https://zama.example',ownerId:owner,clientId:'test-client',allowedOrigins:['https://zama.example']};
 const principal={userId:owner,clientId:'test-client',active:true,expiresAt:now.getTime()+60000,allowedTools:definitions().map(x=>x.name)};
 let handler;
 const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 config.resource=`http://127.0.0.1:${server.address().port}/mcp`;
 principal.audience=config.resource;
 handler=createMcpHandler({config,clock:()=>now,authenticate:async(token)=>{calls++;return token==='fixture-only' ? {...principal,active:!revoked && principal.active}:null;},repositoryFactory:()=>repository,...options});
 const request=(body,headers={},method='POST',path='')=>new Promise((resolve,reject)=>{
 const request=http.request(config.resource+path,{method,headers:{authorization:'Bearer fixture-only',accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-11-25',...headers}},response=>{
 const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>{try{const text=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode,headers:new Headers(response.headers),body:text?JSON.parse(text):null});}catch(e){reject(e);}});
 });request.on('error',reject);if(method==='POST')request.write(typeof body==='string'?body:JSON.stringify(body));request.end();
 });
 const rpc=(method,params={})=>({jsonrpc:'2.0',id:1,method,params});
 const call=(name,args={},id=randomUUID())=>request(rpc('tools/call',{name,arguments:{...args,request_id:id}}));
 return {repository,config,principal,request,rpc,call,revoke:()=>{revoked=true;},calls:()=>calls};
}
test('remote HTTP negotiates versions, exposes catalog, accepts notification, declines SSE',async t=>{
 const f=await fixture(t);
 for(const version of ['2025-03-26','2025-06-18','2025-11-25']) {
 const r=await f.request(f.rpc('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'independent-test',version:'1'}}));
 assert.equal(r.status,200);assert.equal(r.body.result.protocolVersion,version);assert.equal(r.headers.get('mcp-session-id'),null);
 }
 assert.equal((await f.request({jsonrpc:'2.0',method:'notifications/initialized'})).status,202);
 assert.equal((await f.request(f.rpc('tools/list'))).body.result.tools.length,7);
 assert.equal((await f.request(null,{},'GET')).status,405);
 assert.equal((await f.request(null,{},'DELETE')).status,405);
 assert.deepEqual((await f.request(f.rpc('ping'))).body.result,{});
});
test('remote HTTP creates and reads all supported areas without financial execution',async t=>{
 const f=await fixture(t), id=randomUUID();
 const create=()=>f.call('create_task',{title:'Teste remoto',date:'hoje'},id);
 const receipts=await Promise.all(Array.from({length:8},create));
 assert.ok(receipts.every(r=>r.body.result.isError===false));
 assert.equal(new Set(receipts.map(r=>r.body.result.structuredContent.action_id)).size,1);
 assert.equal((await f.call('list_tasks')).body.result.structuredContent.result.total,1);
 assert.equal((await f.call('create_agenda_event',{title:'Reunião',date:'amanhã',time:'10:00',reminder_minutes:60})).body.result.isError,false);
 assert.equal((await f.call('get_agenda',{from:'hoje',to:'amanhã'})).body.result.structuredContent.result.total,2);
 await f.call('save_idea',{title:'Ideia remota',description:'Fictícia'});
 assert.equal((await f.call('search_ideas',{query:'remota'})).body.result.structuredContent.result.total,1);
 const expense=await f.call('prepare_expense',{amount:10,category:'Marketing',description:'Fictícia',date:'hoje'});
 assert.equal(expense.body.result.structuredContent.status,'pending');
 assert.match(expense.body.result.structuredContent.confirmation_url,/^https:\/\/zama.example\/dot-confirm.html/);
 assert.equal((await f.repository.read()).state.financeiro,undefined);
 assert.equal((await f.call('confirm_expense')).body.error.code,-32602);
});
test('remote authentication is revalidated, revoked/expired/wrong audience denied',async t=>{
 const f=await fixture(t), body=f.rpc('tools/list');
 assert.equal((await f.request(body,{authorization:''})).status,401);
 assert.equal((await f.request(body,{authorization:'Bearer account-token'})).status,401);
 assert.equal((await f.request(body)).status,200);
 for(const [key,value] of [['active',false],['expiresAt',now.getTime()-1],['audience','https://other.example/mcp'],['userId','other'],['clientId','other']]) {
 const previous=f.principal[key];f.principal[key]=value;assert.ok([401,403].includes((await f.request(body)).status));f.principal[key]=previous;
 }
 f.revoke();assert.equal((await f.request(body)).status,401);assert.ok(f.calls()>=8);
 assert.deepEqual((await f.repository.read()).state,{});
});
test('remote scopes filter discovery and block writes and unapproved confirmation',async t=>{
 const f=await fixture(t);f.principal.allowedTools=['list_tasks'];
 assert.deepEqual((await f.request(f.rpc('tools/list'))).body.result.tools.map(x=>x.name),['list_tasks']);
 assert.equal((await f.call('create_task',{title:'Blocked',date:'hoje'})).body.error.code,-32602);
 assert.equal((await f.call('decide')).body.error.code,-32602);
 assert.deepEqual((await f.repository.read()).state,{});
});
test('remote rejects origins, rebinding, versions, content, batches and bad JSON',async t=>{
 const f=await fixture(t), body=f.rpc('tools/list');
 for(const [headers,status] of [[{origin:'https://evil.example'},403],[{host:'evil.example'},403],[{'mcp-protocol-version':'invalid'},400],[{accept:'application/json'},406],[{'content-type':'text/plain'},415]])assert.equal((await f.request(body,headers)).status,status);
 assert.equal((await f.request(body,{},'POST','?operation=decide')).status,404);
 assert.equal((await f.request([body])).body.error.code,-32600);
 assert.equal((await f.request('{')).body.error.code,-32700);
 assert.equal((await f.request({jsonrpc:'2.0',method:'tools/call',params:{name:'create_task'}})).status,400);
 assert.equal((await f.request({...body,padding:'x'.repeat(21000)})).status,413);
 assert.deepEqual((await f.repository.read()).state,{});
});
test('remote is disabled without explicit configuration and provider dependencies',async t=>{
 const f=await fixture(t,{authenticate:undefined});assert.equal((await f.request(f.rpc('tools/list'))).status,503);
});
