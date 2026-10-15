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
function sdk(seed, options = {}) {
  let session={access_token:'test-access-token',user:{id:'test-account',email:'test@example.invalid'}};
  const authListeners = [];
  window.testAuthEvent = (event, user = null) => {
    session = user ? { access_token:`test-token-${user.id}`,user } : null;
    authListeners.forEach(listener => listener(event, session));
  };
  window.addEventListener('storage', event => {
    if (event.key === 'test-auth-event' && event.newValue) {
      const value = JSON.parse(event.newValue); window.testAuthEvent(value.event, value.user);
    }
  });
  window.testDbReads = []; window.testDbWrites = []; window.testRpcCalls = [];
  window.testPendingReads = []; window.testPendingWrites = [];
  window.testPendingSessions = [];
  window.testPendingProjectRpcs = [];
  window.testProjectRpcError = options.projectRpcError || null;
  window.testReleaseProjectRpcs = () => { window.testPendingProjectRpcs.splice(0).forEach(resolve => resolve()); };
  window.testReleaseSessions = () => { window.testPendingSessions.splice(0).forEach(resolve => resolve()); };
  window.testReleaseReads = () => { window.testPendingReads.splice(0).forEach(resolve => resolve()); };
  window.testReleaseWrites = () => { window.testPendingWrites.splice(0).forEach(resolve => resolve()); };
  window.testWorkspaceLists = options.workspaces || null;
  window.testWorkspaceRoster = options.roster || { members: [], invites: [] };
  if(!localStorage.getItem('test-cloud')) localStorage.setItem('test-cloud',JSON.stringify({data:seed,updated_at:'initial'}));
  for (const [id,data] of Object.entries(options.rows || {})) if (!localStorage.getItem(`test-cloud:${id}`)) localStorage.setItem(`test-cloud:${id}`,JSON.stringify({data,updated_at:'initial'}));
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>{
      const snapshot = session;
      if(options.delayInitialSession){options.delayInitialSession=false;await new Promise(resolve=>window.testPendingSessions.push(resolve));}
      return {data:{session:snapshot}};
    },onAuthStateChange(listener){authListeners.push(listener);return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{
      window.testAuthEvent('SIGNED_OUT');
      localStorage.setItem('test-auth-event',JSON.stringify({event:'SIGNED_OUT',nonce:Math.random()}));
      return {};
    },updateUser:async()=>({}),resetPasswordForEmail:async()=>({})},
    ...(options.workspaces || options.projects ? {rpc:async(name, params={}) => {
      window.testRpcCalls.push({ name, params });
      if(window.testFailRpc === name) return {error:{message:'Não foi possível atualizar. Tente novamente.'}};
      if(name.startsWith('zama_project')) {
        if(window.testProjectRpcError) return {error:structuredClone(window.testProjectRpcError)};
        const response=await fetch('/__test/projects', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,params,user:session?.user})});
        const result=await response.json();
        if(window.testDelayNextProjectRpc===name){window.testDelayNextProjectRpc='';await new Promise(resolve=>window.testPendingProjectRpcs.push(resolve));}
        return result;
      }
      const own = { owner_id:session.user.id,role:'owner',name:'Minha empresa' };
      if(name==='zama_workspace_list') return {data:structuredClone(window.testWorkspaceLists?.[session.user.id] || [own])};
      if(name==='zama_workspace_roster') return {data:structuredClone(window.testWorkspaceRoster)};
      if(name==='zama_workspace_invite') {
        const invite={id:'invite-1',email:params.p_email,role:params.p_role};
        window.testWorkspaceRoster.invites.push(invite);
        return {data:{...invite,token:'a'.repeat(64),expires_at:'2026-10-06T12:00:00Z'}};
      }
      if(name==='zama_workspace_accept') return {data:options.inviteOwner || 'shared-company'};
      if(name==='zama_workspace_set_role'||name==='zama_workspace_revoke') {
        const member=window.testWorkspaceRoster.members.find(member=>member.user_id===params.p_user);
        if(member) {
          window.testWorkspaceRoster.invites=window.testWorkspaceRoster.invites.filter(invite=>invite.email!==member.email);
          if(name==='zama_workspace_set_role') member.role=params.p_role;
          else window.testWorkspaceRoster.members=window.testWorkspaceRoster.members.filter(item=>item.user_id!==params.p_user);
        }
      }
      if(name==='zama_workspace_cancel_invite') window.testWorkspaceRoster.invites=window.testWorkspaceRoster.invites.filter(invite=>invite.id!==params.p_id);
      return {data:null};
    }} : {}),
    from:()=>{ const filters={};let payload;
      return {select(){return this;},eq(k,v){filters[k]=v;return this;},update(p){payload=p;return this;},insert(p){payload=p;return this;},
        async maybeSingle(){
          if(window.testFailRead && !payload)return {error:{message:'offline'}};
          const userId=filters.user_id || payload?.user_id || session?.user.id;
          const key=userId==='test-account'?'test-cloud':`test-cloud:${userId}`;
          const old=JSON.parse(localStorage.getItem(key));
          if(!payload){
            window.testDbReads.push({userId});
            if(window.testDelayNextRead){window.testDelayNextRead=false;await new Promise(resolve=>window.testPendingReads.push(resolve));}
            return {data:old};
          }
          window.testDbWrites.push({userId,data:structuredClone(payload.data)});
          if(window.testDelayNextWrite){window.testDelayNextWrite=false;await new Promise(resolve=>window.testPendingWrites.push(resolve));}
          if(window.testFailWrite)return {error:{message:'offline'}};
          if(filters.updated_at && old?.updated_at!==filters.updated_at)return {data:null};
          const next={data:payload.data,updated_at:String(Number(localStorage.getItem('test-version')||0)+1)};
          localStorage.setItem('test-version',next.updated_at);localStorage.setItem(key,JSON.stringify(next));
          return {data:{updated_at:next.updated_at}};
        }
      };
    },
    channel:()=>({on(){return this;},subscribe(fn){fn('SUBSCRIBED');return this;}}),removeChannel:async()=>{}
  })};
}
async function mock(page, data = seed, { jarvisVisible = false, projects, ...sdkOptions } = {}) {
  await page.route('**/api/project-access', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_CONFIGURED', error: 'Cadastro com senha indisponível neste teste.' }) }));
  if(projects) {
    // This fixture lives in the test process, like the real remote store. It must
    // not put client credentials in browser storage to simulate persistence.
    const projectRows=structuredClone(projects);
    const publicProject=row=>Object.fromEntries(Object.entries({...row,has_password:Boolean(row.password)}).filter(([key])=>key!=='password'&&key!=='owner_id'));
    await page.route('**/__test/projects',async route=>{
      const {name,params,user}=route.request().postDataJSON();
      const rows=projectRows[params.p_owner] ||= [];
      const own=params.p_owner===user?.id;
      const assigned=row=>own||row.responsible_email===user?.email;
      const error=message=>({error:{message}});
      let result;
      if(name==='zama_projects_list_v2') result={data:rows.filter(assigned).map(publicProject)};
      else if(name==='zama_project_save') {
        const input=params.p_project, old=rows.find(row=>row.id===input.id);
        if(!own&&!old || old&&!assigned(old)) result=error('Acesso não autorizado.');
        else if(old&&input.revision!==old.revision) result=error('Os dados foram alterados. Atualize antes de salvar.');
        else {
          const saved={...old,...structuredClone(input),id:old?.id||require('node:crypto').randomUUID(),revision:(old?.revision||0)+1,created_at:old?.created_at||'2026-09-29T15:00:00Z',updated_at:'2026-09-29T15:00:00Z'};
          if(old) rows.splice(rows.indexOf(old),1,saved); else rows.push(saved);
          result={data:publicProject(saved)};
        }
      } else if(name==='zama_project_secret') {
        const row=rows.find(row=>row.id===params.p_id); result=row&&assigned(row)?{data:row.password||''}:error('Acesso não autorizado.');
      } else if(name==='zama_project_delete') {
        if(!own) result=error('Acesso não autorizado.');
        else {const index=rows.findIndex(row=>row.id===params.p_id);if(index!==-1) rows.splice(index,1);result={data:null};}
      } else result=error('RPC de projeto desconhecida.');
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    sdkOptions.projects=true;
  }
  await page.clock.install({time:new Date('2026-09-29T12:00:00-03:00')});
  await page.route('**/*.supabase.co/**',route=>route.abort());
  await page.route('**/assets/js/env.js*', route => route.fulfill({contentType:'text/javascript',body:`window.ZAMA_CONFIG = ${JSON.stringify({cloudStateTable:'app_state',supabaseUrl:'https://test.supabase.co',supabaseAnonKey:'fixture-public-key',jarvisVisible})};`}));
  await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',route=>route.fulfill({contentType:'text/javascript',body:`(${sdk.toString()})(${JSON.stringify(data)},${JSON.stringify(sdkOptions)})`}));
  await page.goto('/');
}
module.exports={mock,seed};
