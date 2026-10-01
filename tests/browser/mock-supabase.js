// Isolated browser tests: no requests or writes to the production account.
const seed = {
  setupDone:true,companyProfile:{nome:'ZAMA'},
  financeiro:[
    {id:'income',nome:'Projeto entregue',tipo:'Entrada',responsavel:'Receita',valor:4200,status:'Pago',prazo:'2026-09-02',pagoEm:'2026-09-02'},
    {id:'expense',nome:'Ferramentas e serviços',tipo:'Saída',responsavel:'Sistema',valor:-480.25,status:'Pago',prazo:'2026-09-05',pagoEm:'2026-09-05'},
    {id:'pending',nome:'Conta a receber',tipo:'Entrada',responsavel:'Receita',valor:300,status:'Pendente',prazo:'2026-09-30'}
  ],
  agenda:[{id:'task',nome:'Revisar o financeiro',prazo:'2026-09-29',hora:'14:00',status:'Pendente',valor:5,duracao:45,observacoes:'Conferir pagamentos da semana.'}],
  ideias:[{id:'idea',titulo:'Automatizar cobrança',descricao:'Estudar alternativas para as mensalidades.',categoria:'Financeiro',prioridade:'Alta',etapa:'avaliacao',data:'2026-09-29'}],
  investimentos:[],clientes:[],mensalidades:[],projetos:[],marketing:[],rh:[],gastosFixos:[]
};
function sdk(seed) {
  const session={access_token:'test-access-token',user:{id:'test-account',email:'test@example.invalid'}};
  if(!localStorage.getItem('test-cloud')) localStorage.setItem('test-cloud',JSON.stringify({data:seed,updated_at:'initial'}));
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session}}),onAuthStateChange(){},signOut:async()=>({}),updateUser:async()=>({}),resetPasswordForEmail:async()=>({})},
    from:()=>{ const filters={};let payload;
      return {select(){return this;},eq(k,v){filters[k]=v;return this;},update(p){payload=p;return this;},insert(p){payload=p;return this;},
        async maybeSingle(){
          if(window.testFailRead && !payload)return {error:{message:'offline'}};
          const old=JSON.parse(localStorage.getItem('test-cloud'));
          if(!payload)return {data:old};
          if(window.testFailWrite)return {error:{message:'offline'}};
          if(filters.updated_at && old.updated_at!==filters.updated_at)return {data:null};
          const next={data:payload.data,updated_at:String(Number(localStorage.getItem('test-version')||0)+1)};
          localStorage.setItem('test-version',next.updated_at);localStorage.setItem('test-cloud',JSON.stringify(next));
          return {data:{updated_at:next.updated_at}};
        }
      };
    },
    channel:()=>({on(){return this;},subscribe(fn){fn('SUBSCRIBED');return this;}}),removeChannel:async()=>{}
  })};
}
async function mock(page, data = seed) {
  await page.clock.install({time:new Date('2026-09-29T12:00:00-03:00')});
  await page.route('**/*.supabase.co/**',route=>route.abort());
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',route=>route.fulfill({contentType:'text/javascript',body:`(${sdk.toString()})(${JSON.stringify(data)})`}));
  await page.goto('/');
}
module.exports={mock,seed};
