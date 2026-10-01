const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const now = Date.parse('2026-09-29T12:00:20-03:00');
let remote = { updated_at:'v1', data:{
  agenda:[{id:'task',nome:'Título atualizado no outro dispositivo',prazo:'2026-09-29',hora:'12:15',status:'Pendente'}],
  agendaSettings:{enabled:true,dailyEnabled:false,taskEnabled:true,leadMinutes:15},
  financeiro:[{id:'keep',valor:100}],legacy:{keep:true}
} };
let writes=0;
function device() {
  const sandbox={Date,Intl,console,structuredClone,window:{},state:structuredClone(remote.data),storageKey:'test',cloudStateTable:'app_state',localStorage:{setItem(){}},
    supabaseClient:{
      auth:{getSession:async()=>({data:{session:{user:{id:'same-account'}}}})},
      from(){let payload;const filters={};return {
        select(){return this;},eq(key,value){filters[key]=value;return this;},update(value){payload=value;return this;},
        async maybeSingle(){
          if(!payload)return {data:structuredClone(remote)};
          if(filters.updated_at!==remote.updated_at)return {data:null};
          remote={data:structuredClone(payload.data),updated_at:`saved-${++writes}`};
          return {data:{updated_at:remote.updated_at}};
        }
      };}
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('app/assets/js/ceo-agenda.js','utf8'),sandbox);
  sandbox.ZamaAgenda=sandbox.window.ZamaAgenda;
  vm.runInContext(fs.readFileSync('app/assets/js/core.js','utf8')+"\ncloudUserId='same-account';cloudRevision='v1';cloudSnapshot=structuredClone(state);",sandbox);
  sandbox.now=now;
  sandbox.key=sandbox.ZamaAgenda.helpers.remindersBetween(remote.data,now-60000,now)[0]?.key;
  return sandbox;
}
(async()=>{
  const a=device(), b=device();
  const results=await Promise.all([vm.runInContext('claimCloudReminder(key,now)',a),vm.runInContext('claimCloudReminder(key,now)',b)]);
  assert.equal(results.filter(Boolean).length,1,'only one device may claim the same reminder');
  assert.equal(writes,1);
  assert.equal(results.find(Boolean).title,'Título atualizado no outro dispositivo');
  assert.equal(remote.data.financeiro[0].valor,100);
  assert.equal(remote.data.legacy.keep,true);
  assert.equal(await vm.runInContext('claimCloudReminder(key,now)',device()),false,'a newly opened device sees the durable receipt');
  delete remote.data.reminderReceipts;
  remote.data.agenda[0].status='Concluído';
  assert.equal(await vm.runInContext('claimCloudReminder(key,now)',a),false,'remote completion cancels a stale local reminder');
  remote.data.agenda[0].status='Pendente';remote.data.agendaSettings.enabled=false;
  assert.equal(await vm.runInContext('claimCloudReminder(key,now)',b),false,'remote settings cancel delivery');
  console.log('Cross-device reminder receipts and remote cancellation tests passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
