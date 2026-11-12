'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {randomUUID,createHash}=require('node:crypto');
const {createService,definitions}=require('../services/dot/service');
const {createMcpHandler}=require('../services/dot/mcp-http');
const {createApiKeyAuthenticator}=require('../services/dot/api-key-auth');
const owner='11111111-1111-4111-8111-111111111111', origin='https://zama.example';
const now=new Date('2026-11-12T12:00:00Z');
function memory(){
  let saved={state:{agenda:[{id:'event-1',nome:'Reunião',tipo:'Compromisso',prazo:'2026-11-13',hora:'10:00',status:'Pendente',recorrencia:'none',exceptions:{}}],clientes:[{id:'keep'}]},jarvis:{actions:[]}},chain=Promise.resolve();
  return {userId:owner,consumeRate:async()=>{},read:async()=>structuredClone(saved),transact(fn){const job=chain.then(()=>{const snapshot=structuredClone(saved),change=fn(snapshot);if(!change.unchanged)saved=snapshot;return structuredClone(change.result);});chain=job.catch(()=>{});return job;}};
}
const request=()=>({name:'cancel_agenda_event',arguments:{id:'event-1',reason:'Pedido explícito de teste'},request_id:randomUUID()});
const service=(repository,extra={})=>createService({repository,ownerId:owner,origin,clock:()=>now,agendaCancelEnabled:true,allowedTools:['cancel_agenda_event'],...extra});
test('Dot cancellation requires both feature and permission before touching records',async()=>{
  const repo=memory(),before=await repo.read();
  for(const options of [{agendaCancelEnabled:false},{allowedTools:['create_agenda_event']},{agendaCancelEnabled:false,allowedTools:[]}]){
    await assert.rejects(service(repo,options).call(request()),e=>e.code==='DOT_AGENDA_CANCEL_FORBIDDEN');
    assert.deepEqual(await repo.read(),before);
  }
  assert.equal(definitions().some(t=>t.name==='cancel_agenda_event'),false);
  const tool=definitions({includeAgendaCancel:true}).find(t=>t.name==='cancel_agenda_event');
  assert.equal(tool.annotations.destructiveHint,true);assert.equal(tool.annotations.idempotentHint,true);
});
test('Dot cancellation is audited, preserves records and retries once under concurrency',async()=>{
  const repo=memory(),s=service(repo),input=request();
  const results=await Promise.all(Array.from({length:8},()=>s.call(input)));
  assert.equal(new Set(results.map(r=>r.action_id)).size,1);
  assert.equal(results[0].status,'executed');assert.equal(results[0].result.status,'Cancelada');
  const saved=await repo.read();assert.equal(saved.state.agenda.length,1);assert.equal(saved.state.agenda[0].status,'Cancelado');
  assert.deepEqual(saved.state.clientes,[{id:'keep'}]);assert.equal(saved.jarvis.actions.length,1);
  assert.equal(saved.jarvis.actions[0].owner_id,owner);assert.equal(saved.jarvis.actions[0].tool_name,'cancel_agenda_event');
  await assert.rejects(s.call({...input,arguments:{id:'event-1',reason:'different'}}),e=>e.code==='DOT_IDEMPOTENCY_CONFLICT');
  assert.equal((await repo.read()).jarvis.actions.length,1);
});
async function invoke(handler,method,params={}){
  const req=Readable.from([JSON.stringify({jsonrpc:'2.0',id:1,method,params})]);req.method='POST';req.url='/api/dot-mcp';
  req.headers={host:'zama.example',authorization:'Bearer fixture-only',accept:'application/json, text/event-stream','content-type':'application/json'};
  let out;await handler(req,{setHeader(){},end(body){out={status:this.statusCode,body:JSON.parse(body)};}});return out;
}
test('MCP discovers cancellation upgrade but old grant cannot execute it or gain permission',async()=>{
  const repo=memory(),config={enabled:true,agendaCancelEnabled:true,resource:origin+'/api/dot-mcp',appOrigin:origin,ownerId:owner,clientId:'fixture',oauthMetadata:origin+'/.well-known/oauth-protected-resource'};
  const principal={active:true,userId:owner,clientId:'fixture',audience:config.resource,expiresAt:now.getTime()+60000,allowedTools:['get_agenda']};
  const handler=createMcpHandler({config,clock:()=>now,authenticate:async()=>principal,repositoryFactory:()=>repo});
  const tool=(await invoke(handler,'tools/list')).body.result.tools.find(t=>t.name==='cancel_agenda_event');
  assert.deepEqual(tool.securitySchemes[0].scopes,['zama:private','zama:agenda:cancel']);
  assert.deepEqual(tool._meta.securitySchemes,tool.securitySchemes);
  const before=await repo.read(),input=request(),args={name:input.name,arguments:{...input.arguments,request_id:input.request_id}};
  const denied=(await invoke(handler,'tools/call',args)).body.result;
  assert.equal(denied.isError,true);assert.match(denied._meta['mcp/www_authenticate'][0],/scope="zama:private zama:agenda:cancel"/);
  assert.deepEqual(principal.allowedTools,['get_agenda']);assert.deepEqual(await repo.read(),before);
  principal.allowedTools.push('cancel_agenda_event');
  const allowed=(await invoke(handler,'tools/call',args)).body.result;
  assert.equal(allowed.isError,false);assert.equal(allowed.structuredContent.result.status,'Cancelada');
  config.agendaCancelEnabled=false;
  assert.equal((await invoke(handler,'tools/list')).body.result.tools.some(t=>t.name===input.name),false);
  assert.equal((await invoke(handler,'tools/call',args)).body.error.code,-32602);
  assert.equal((await repo.read()).jarvis.actions.length,1);
});
test('opaque authentication accepts new scoped grant and leaves old permissions unchanged',async()=>{
  const id=randomUUID(),token=`zama_dot_v1.${id}.${'A'.repeat(43)}`,resource=origin+'/api/dot-mcp';
  const grant={id,owner_id:owner,client_id:'fixture',resource,token_hash:createHash('sha256').update(token).digest('hex'),allowed_tools:['get_agenda'],not_before:'2026-11-12T11:00:00Z',expires_at:'2026-11-12T13:00:00Z',revoked_at:null,version:1};
  const auth=createApiKeyAuthenticator({store:{find:async()=>structuredClone(grant)},ownerId:owner,clientId:'fixture',resource,clock:()=>now});
  assert.deepEqual((await auth(token,{resource})).allowedTools,['get_agenda']);
  grant.allowed_tools.push('cancel_agenda_event');assert.ok((await auth(token,{resource})).allowedTools.includes('cancel_agenda_event'));
  grant.revoked_at=now.toISOString();assert.equal(await auth(token,{resource}),null);
});
