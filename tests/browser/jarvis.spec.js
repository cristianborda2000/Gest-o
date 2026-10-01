// API responses here are controlled fixtures. No OpenAI or production database calls.
const {test,expect}=require('@playwright/test');
const {mock,seed}=require('./mock-supabase');
const conversationId='10000000-0000-4000-8000-000000000001';
const actionId='20000000-0000-4000-8000-000000000001';
const conversation={id:conversationId,title:'Organizar meu dia',created_at:'2026-09-29T15:00:00Z',updated_at:'2026-09-29T15:00:00Z'};
const pendingAction={id:actionId,tool_name:'register_expense',status:'pending',requires_confirmation:true,input:{amount:350,description:'Anúncios de setembro',category:'Marketing',date:'2026-09-29',due_date:'2026-09-29',status:'paid'},result:{},created_at:'2026-09-29T15:00:00Z'};
const summary={date:'2026-09-29',tasks:{total:1,tasks:[{title:'Revisar o financeiro',priority:'Alta',status:'Pendente'}]},overdue:{total:0},financial:{expenses:'R$ 480,25'},nextAppointment:{title:'Revisar o financeiro',date:'2026-09-29',time:'14:00'}};

async function jarvisMock(page,options={}){
  const api={requests:[],messages:options.messages||[],actions:options.actions||[],history:options.history||[],messageFailures:options.messageFailures||0,confirmationFailures:options.confirmationFailures||0,confirmed:0};
  await page.route('**/api/jarvis/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/jarvis','');
    const body=request.postDataJSON();
    api.requests.push({path,method:request.method(),body,authorization:request.headers().authorization});
    const respond=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(path==='/config'){
      if(options.configGate)await options.configGate;
      if(options.configError)return respond({error:options.configError},503);
      return respond({enabled:true,configured:true,memoryEnabled:false,voiceEnabled:false,...options.config});
    }
    if(path==='/summary')return options.summaryError?respond({error:options.summaryError},503):respond({summary});
    if(path==='/conversations')return respond({conversations:api.history});
    if(path===`/conversations/${conversationId}`)return respond({conversation,messages:api.messages,actions:api.actions});
    if(path==='/message'){
      if(api.messageFailures-->0)return respond({error:'Falha temporária de rede. Tente novamente.'},503);
      api.history=[conversation];
      api.messages=[{id:'m1',role:'user',content:body.message},{id:'m2',role:'assistant',content:options.reply||'Neste mês, as saídas pagas somam R$ 480,25.'}];
      if(options.pendingExpense)api.actions=[structuredClone(pendingAction)];
      return respond({conversation,messages:api.messages,actions:api.actions,state_changed:false});
    }
    if(path===`/actions/${actionId}/confirm`){
      // Simulate a committed request whose response was lost. Repeating it is safe.
      if(!api.confirmed){
        api.confirmed++;
        api.actions=api.actions.map(a=>({...a,status:'executed'}));
        await page.evaluate(({actionId})=>{
          const cloud=JSON.parse(localStorage.getItem('test-cloud'));
          cloud.data.financeiro.push({id:actionId,nome:'Anúncios de setembro',tipo:'Saída',responsavel:'Marketing',valor:-350,status:'Pago',prazo:'2026-09-29',pagoEm:'2026-09-29'});
          cloud.updated_at='jarvis-confirmed';localStorage.setItem('test-cloud',JSON.stringify(cloud));
        },{actionId});
      }
      if(api.confirmationFailures-->0)return respond({error:'Resposta interrompida. Tente confirmar novamente.'},503);
      return respond({action:api.actions[0],state_changed:true});
    }
    if(path===`/actions/${actionId}/cancel`){api.actions=api.actions.map(a=>({...a,status:'cancelled'}));return respond({action:api.actions[0],state_changed:false});}
    return respond({error:`Endpoint de teste inesperado: ${path}`},404);
  });
  await mock(page,options.seed||seed);
  return api;
}
async function openJarvis(page){
  if(await page.locator('#ceoMenuBtn').isVisible())await page.locator('#ceoMenuBtn').click();
  await page.locator('.nav [data-module="jarvis"]').click();
  await expect(page.getByLabel('Mensagem para o JARVIS')).toBeEnabled();
}
async function send(page,message){await page.getByLabel('Mensagem para o JARVIS').fill(message);await page.getByRole('button',{name:'Enviar',exact:false}).click();}

test('Jarvis desktop uses real summary contract and preserves the legacy data of removed modules',async({page})=>{
  const legacy={...seed,clientes:[{id:'old-client',nome:'Cliente anterior'}],mensalidades:[{id:'old-monthly',nome:'Mensalidade anterior'}],projetos:[{id:'old-project',nome:'Projeto anterior'}],marketing:[{id:'old-marketing',nome:'Campanha anterior'}],rh:[{id:'old-team',nome:'Equipe anterior'}]};
  const api=await jarvisMock(page,{seed:legacy});await openJarvis(page);
  await expect(page.locator('.jarvis-home-grid')).toContainText('480,25');
  await expect(page.locator('.jarvis-home-grid')).toContainText('Revisar o financeiro');
  await expect(page.locator('.jarvis-welcome')).toContainText('Boa tarde.');
  await page.screenshot({path:'test-results/jarvis-desktop.png',fullPage:true});
  for(const name of ['clientes','mensalidades','projetos','marketing','rh']){
    await expect(page.locator(`.nav [data-module="${name}"]`)).toHaveCount(0);
    await page.evaluate(name=>goToModule(name),name);
    await expect(page.locator('body')).toHaveAttribute('data-module','dashboard');
    expect(await page.evaluate(name=>JSON.parse(localStorage.getItem('test-cloud')).data[name],name)).toEqual(legacy[name]);
  }
  expect(api.requests.every(r=>r.authorization==='Bearer test-access-token')).toBe(true);
});

test('global launcher preserves the draft between views and exposes truthful voice status',async({page})=>{
  await jarvisMock(page);await page.locator('#jarvisLauncher').click();
  await expect(page.getByRole('dialog',{name:'JARVIS — acesso rápido'})).toBeVisible();
  await page.getByLabel('Mensagem para o JARVIS').fill('Organize amanhã às 9h');
  await page.getByRole('button',{name:'Informações sobre voz'}).click();
  await expect(page.locator('.jarvis-error')).toContainText('microfone permanece desligado');
  await expect(page.getByLabel('Mensagem para o JARVIS')).toHaveValue('Organize amanhã às 9h');
  await page.getByRole('button',{name:'Fechar JARVIS'}).click();await openJarvis(page);
  await expect(page.getByLabel('Mensagem para o JARVIS')).toHaveValue('Organize amanhã às 9h');
  await page.evaluate(()=>render());
  await expect(page.getByLabel('Mensagem para o JARVIS')).toHaveValue('Organize amanhã às 9h');
});

test('message retry keeps request id and saved history survives a browser reload with escaped HTML',async({page})=>{
  const reply='<img src=x onerror="window.jarvisXss=true"> Resumo do mês: R$ 480,25.';
  const api=await jarvisMock(page,{messageFailures:1,reply});await openJarvis(page);
  await send(page,'Quanto gastei este mês?');await expect(page.locator('.jarvis-error')).toContainText('Falha temporária');
  await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();
  await expect(page.locator('.jarvis-message.assistant')).toContainText(reply);
  const posts=api.requests.filter(r=>r.path==='/message');expect(posts).toHaveLength(2);expect(posts[0].body.request_id).toBe(posts[1].body.request_id);
  expect(await page.evaluate(()=>Boolean(window.jarvisXss))).toBe(false);await expect(page.locator('.jarvis-message img')).toHaveCount(0);
  await page.reload();await openJarvis(page);await page.getByLabel('Histórico de conversas').selectOption(conversationId);
  await expect(page.locator('.jarvis-message.assistant')).toContainText(reply);
});

test('financial action waits for explicit confirmation and recovers safely after a lost confirmation response',async({page})=>{
  const api=await jarvisMock(page,{pendingExpense:true,confirmationFailures:1});await openJarvis(page);
  await send(page,'Registra R$350 de marketing.');
  const card=page.locator(`[data-action-id="${actionId}"]`);
  await expect(card).toContainText('Aguardando confirmação');await expect(card).toContainText('350,00');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('test-cloud')).data.financeiro.length)).toBe(3);
  await card.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(page.locator('.jarvis-error')).toContainText('Resposta interrompida');
  await card.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(card).toContainText('Concluída');
  expect(api.confirmed).toBe(1);expect(api.requests.filter(r=>r.path.endsWith('/confirm')).every(r=>r.body.confirmation===true)).toBe(true);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('test-cloud')).data.financeiro.filter(row=>row.id==='20000000-0000-4000-8000-000000000001').length)).toBe(1);
  await page.locator('.nav [data-module="financeiro"]').click();await expect(page.locator('#ceoWorkspace')).toContainText('Anúncios de setembro');
});

test('cancelling an action changes no financial records',async({page})=>{
  const api=await jarvisMock(page,{pendingExpense:true});await openJarvis(page);await send(page,'Registra R$350 de marketing.');
  await page.locator(`[data-action-id="${actionId}"]`).getByRole('button',{name:'Cancelar',exact:true}).click();
  await expect(page.locator(`[data-action-id="${actionId}"]`)).toContainText('Cancelada');
  expect(api.confirmed).toBe(0);expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('test-cloud')).data.financeiro.length)).toBe(3);
});

test('unconfigured backend accepts drafts but never sends before setup',async({page})=>{
  const api=await jarvisMock(page,{config:{configured:false,reason:'Configure OPENAI_API_KEY no servidor para usar o JARVIS.'}});
  await openJarvis(page);
  await expect(page.locator('.jarvis-notice')).toContainText('Configure OPENAI_API_KEY no servidor');
  await expect(page.locator('.jarvis-composer-hint')).toContainText('envio aguarda a configuração');
  const input=page.getByLabel('Mensagem para o JARVIS');
  await input.fill('Como está meu dia?');await input.press('Enter');
  await expect(input).toHaveValue('Como está meu dia?\n');
  await expect(page.getByRole('button',{name:'Enviar',exact:false})).toBeDisabled();
  await page.getByRole('button',{name:'Atualizar JARVIS',exact:true}).click();
  await expect(page.locator('.jarvis-composer-hint')).toContainText('envio aguarda a configuração');
  await expect(input).toHaveValue('Como está meu dia?\n');
  expect(api.requests.filter(r=>r.path==='/message')).toHaveLength(0);
});

for(const failure of [{configError:'Integração do servidor não configurada.'},{summaryError:'Não foi possível carregar os dados do JARVIS.'}]){
  test(`draft remains editable when ${Object.keys(failure)[0]} prevents initialization`,async({page})=>{
    const api=await jarvisMock(page,failure);await openJarvis(page);
    await expect(page.locator('.jarvis-error')).toContainText(Object.values(failure)[0]);
    await page.getByLabel('Mensagem para o JARVIS').fill('Salva uma ideia: plano anual');
    await expect(page.getByRole('button',{name:'Enviar',exact:false})).toBeDisabled();
    await expect(page.locator('.jarvis-composer-hint')).toContainText('use Atualizar');
    expect(api.requests.filter(r=>r.path==='/message')).toHaveLength(0);
  });
}

test('typing while configuration loads preserves the draft and cursor when ready',async({page})=>{
  let release;const configGate=new Promise(resolve=>{release=resolve;});
  await jarvisMock(page,{configGate});await openJarvis(page);
  const input=page.getByLabel('Mensagem para o JARVIS');
  await expect(page.locator('.jarvis-composer-hint')).toContainText('verificamos a conexão');
  await input.fill('Organize meu dia');
  await input.evaluate(el=>el.setSelectionRange(8,8));
  await expect(page.getByRole('button',{name:'Enviar',exact:false})).toBeDisabled();
  release();
  await expect(page.getByRole('button',{name:'Enviar',exact:false})).toBeEnabled();
  await expect(input).toHaveValue('Organize meu dia');await expect(input).toBeFocused();
  expect(await input.evaluate(el=>el.selectionStart)).toBe(8);
});

for(const viewport of [{width:390,height:844},{width:1024,height:768}]){
  test(`Jarvis page and global panel fit ${viewport.width}px viewport`,async({page})=>{
    await page.setViewportSize(viewport);await jarvisMock(page);await openJarvis(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'+ Ideia',exact:true}).click();await expect(page.getByLabel('Mensagem para o JARVIS')).toHaveValue('Salva uma ideia: ');
    await expect(page.getByLabel('Mensagem para o JARVIS')).toHaveCSS('outline-style','none');
    await expect(page.locator('.jarvis-composer')).toHaveCSS('border-top-color','rgb(38, 38, 38)');
    await expect(page.locator('.jarvis-microphone')).toHaveCSS('background-color','rgb(245, 245, 245)');
    if(viewport.width===390)await page.screenshot({path:'test-results/jarvis-mobile.png',fullPage:true});
    await page.evaluate(()=>goToModule('dashboard'));await page.locator('#jarvisLauncher').click();
    await expect(page.getByRole('dialog',{name:'JARVIS — acesso rápido'})).toBeVisible();
    expect(await page.evaluate(()=>document.querySelector('.jarvis-dialog').scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Fechar JARVIS'}).click();
  });
}
