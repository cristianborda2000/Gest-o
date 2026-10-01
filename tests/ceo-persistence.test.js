const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ZamaTime = require('../app/assets/js/ceo-time');

assert.equal(ZamaTime.today('2026-09-30T01:30:00Z'), '2026-09-29');
assert.equal(new Date(ZamaTime.toEpoch('2026-09-29','08:00')).toISOString(), '2026-09-29T11:00:00.000Z');
assert.equal(ZamaTime.addDays('2028-02-28',1),'2028-02-29');
assert.deepEqual(ZamaTime.monthRange('2026-02'),{from:'2026-02-01',to:'2026-02-28'});

async function run() {
  let stored = { data: { financeiro: [{id:'old',nome:'Registro existente',tipo:'Entrada',valor:10.01,status:'Pago',prazo:'2026-09-01'}], setupDone:true, customLegacy:{keep:true} }, updated_at:'v1' };
  let failRead = false, failWrite = false, writes = 0;
  const cache = new Map([['admin-simples-v1',JSON.stringify({financeiro:[{id:'another-user'}]})]]);
  const auth = {getSession:async()=>({data:{session:{user:{id:'account-A'}}}})};
  function from() {
    const filters = {}; let value;
    return {
      select(){return this;}, eq(key,val){filters[key]=val;return this;},
      update(payload){value=payload;return this;},insert(payload){value=payload;return this;},
      async maybeSingle(){
        if(!value) return failRead ? {error:{message:'offline'}} : {data:structuredClone(stored)};
        writes++;
        if(failWrite) return {error:{message:'offline'}};
        if(filters.updated_at && filters.updated_at!==stored.updated_at) return {data:null};
        stored={data:structuredClone(value.data),updated_at:`v${writes+1}`};
        return {data:{updated_at:stored.updated_at}};
      }
    };
  }
  const sandbox={ console,structuredClone,URLSearchParams,Intl,Date,Math, ZamaTime,
    window:{location:{hash:'',search:''},supabase:{createClient:()=>({auth,from})},ZAMA_CONFIG:{supabaseUrl:'test',supabaseAnonKey:'public'},crypto:{randomUUID:()=> 'generated'}},
    localStorage:{getItem:key=>cache.get(key),setItem:(key,val)=>cache.set(key,val)},
    document:{getElementById:()=>null},cloudStatus:null,showToast(){},render(){}
  };
  vm.createContext(sandbox);
  vm.runInContext(['config','core','records'].map(name=>fs.readFileSync(`app/assets/js/${name}.js`,'utf8')).join('\n')+'\nlet state=null; render=()=>{};',sandbox);
  await vm.runInContext('loadState().then(value => { state=value; })',sandbox);
  assert.equal(vm.runInContext('state.financeiro[0].id',sandbox),'old');
  assert.equal(vm.runInContext('state.customLegacy.keep',sandbox),true);
  assert.equal(writes,0,'loading must never write data');
  assert.ok(cache.has('admin-simples-v1:account-A'));
  failWrite=true;
  assert.equal(await vm.runInContext("ceoCommit(draft=>{draft.financeiro[0].valor=99})",sandbox),false);
  assert.equal(vm.runInContext('state.financeiro[0].valor',sandbox),10.01,'failed change must not affect in-memory state');
  failWrite=false;
  assert.equal(await vm.runInContext("ceoCommit(draft=>{draft.financeiro[0].valor=20.02})",sandbox),true);
  assert.equal(stored.data.financeiro[0].valor,20.02);
  stored.updated_at='another-device';
  assert.equal(await vm.runInContext("ceoCommit(draft=>{draft.financeiro[0].valor=999})",sandbox),false);
  assert.equal(stored.data.financeiro[0].valor,20.02,'stale writes must not overwrite another device');
  failRead=true;
  await assert.rejects(vm.runInContext('loadState()',sandbox),/carregar/);
  assert.equal(cache.get('admin-simples-v1'),JSON.stringify({financeiro:[{id:'another-user'}]}),'unowned legacy cache remains untouched');
  console.log('Timezone and safe persistence tests passed.');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
