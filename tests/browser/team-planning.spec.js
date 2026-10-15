const {test,expect}=require('@playwright/test');
const {mock,seed}=require('./mock-supabase');
const company='shared-company';
const project=(id,title,email,date)=>({id,title,client_name:'Cliente ZAMA',company_name:'Estúdio Aurora',responsible_name:'Ana',responsible_email:email,status:'in_progress',due_date:'2026-10-10',notes:'Preparar a próxima entrega.',revision:1,updated_at:'2026-09-29T10:00:00Z',production_lists:[{id:'video',title:'Produção do vídeo',steps:[{id:'brief',label:'Revisar briefing',done:true},{id:'film',label:'Gravar vídeo',done:false,due_date:date},{id:'send',label:'Enviar material',done:false}]}]});
const projects=[project('11111111-1111-4111-8111-111111111111','Campanha Aurora','test@example.invalid','2026-09-28'),project('22222222-2222-4222-8222-222222222222','Lançamento de outubro','other@example.invalid','2026-10-02')];
const dialog=page=>page.locator('#ceoProjectDialog');
async function team(page,role='projects') {
  await mock(page,{...structuredClone(seed),agenda:[{...seed.agenda[0],nome:'Minha agenda particular'}],ideias:[{...seed.ideias[0],titulo:'Ideia pessoal reservada'}]}, {
    workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'},{owner_id:company,role,name:'ZAMA'}]},
    rows:{[company]:{...structuredClone(seed),agenda:[{...seed.agenda[0],nome:'Agenda privada do administrador'}],ideias:[{...seed.ideias[0],titulo:'Ideia compartilhada da ZAMA'}],financeiro:[{...seed.financeiro[0],nome:'Financeiro reservado do administrador'}]}},
    projects:{[company]:projects}
  });
  await expect(page.getByRole('heading',{name:'Projetos de clientes'})).toBeVisible();
}
async function owner(page,options={}) {
  await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'ZAMA'}]},projects:{'test-account':projects},...options});
  if(page.viewportSize().width<=720) await page.getByRole('button',{name:'Abrir menu',exact:true}).click();
  await page.locator('.nav [data-module="projetos"]').click();
  await expect(page.getByRole('heading',{name:'Projetos de clientes'})).toBeVisible();
}
test('team sees exactly three modules, every project and only their own agenda',async({page})=>{
  await page.addInitScript(()=>{
    sessionStorage.setItem('zama-workspace:test-account','test-account');
    localStorage.setItem('admin-simples-v1:test-account:shared-company','legacy-private-agenda');
    localStorage.setItem('admin-simples-v1:test-account:other-company','another-legacy-agenda');
  });
  await team(page);
  expect(await page.locator('.nav [data-module]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.module).sort())).toEqual(['agenda','ideias','projetos']);
  await expect(page.getByRole('button',{name:'Abrir projeto Lançamento de outubro',exact:true})).toBeVisible();
  await page.locator('.nav [data-module="agenda"]').click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Minha agenda particular');
  await expect(page.locator('body')).not.toContainText('Agenda privada do administrador');
  const reads=await page.evaluate(()=>window.testDbReads);
  expect(reads.every(read=>read.userId==='test-account')).toBe(true);
  expect(await page.evaluate(()=>JSON.stringify({state,cloudSnapshot}))).not.toContain('Financeiro reservado do administrador');
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('admin-simples-v1:test-account:')))).toEqual([]);
  await page.evaluate(()=>goToModule('financeiro'));
  await expect(page.getByRole('heading',{name:'Projetos de clientes'})).toBeVisible();
});

test('viewer keeps a private editable agenda but cannot edit shared ideas after filtering',async({page})=>{
  await team(page,'viewer');
  await page.locator('.nav [data-module="ideias"]').click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Ideia compartilhada da ZAMA');
  await page.locator('[data-idea-filter="search"]').fill('ZAMA');
  await expect(page.getByRole('button',{name:'+ Nova ideia',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Editar',exact:true})).toBeDisabled();
  await expect(page.locator('[data-idea-move]')).toBeDisabled();
  expect(await page.evaluate(()=>ceoCommit(draft=>{draft.agenda[0].nome='Meu planejamento privado';}))).toBe(true);
  expect(await page.evaluate(()=>window.testDbWrites.at(-1).userId)).toBe('test-account');
});

test('a stale shared idea edit preserves its draft and does not overwrite the newer revision',async({page})=>{
  await team(page); await page.locator('.nav [data-module="ideias"]').click();
  await page.getByRole('button',{name:'Editar',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Título',{exact:true}).fill('Meu rascunho');
  await page.evaluate(()=>{
    const key='test-cloud:shared-company',row=JSON.parse(localStorage.getItem(key));
    row.data.ideias[0].titulo='Alteração de outra pessoa'; row.updated_at='newer-revision';
    localStorage.setItem(key,JSON.stringify(row));
  });
  await page.getByRole('dialog').getByRole('button',{name:'Salvar ideia',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('alteradas por outra pessoa');
  await expect(page.getByRole('dialog').getByLabel('Título',{exact:true})).toHaveValue('Meu rascunho');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('test-cloud:shared-company')).data.ideias[0].titulo)).toBe('Alteração de outra pessoa');
  await page.getByRole('dialog').getByRole('button',{name:'Cancelar',exact:true}).click();
  await page.getByRole('button',{name:'Atualizar ideias',exact:true}).click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Alteração de outra pessoa');
});

test('a delayed shared ideas response cannot reopen content after sign-out',async({page})=>{
  await team(page);
  await page.evaluate(()=>{
    const rpc=supabaseClient.rpc.bind(supabaseClient);
    supabaseClient.rpc=async(name,params)=>{
      const result=await rpc(name,params);
      if(name==='zama_team_ideas_get') await new Promise(resolve=>{window.releaseIdeas=resolve;});
      return result;
    };
  });
  await page.locator('.nav [data-module="ideias"]').click();
  await expect.poll(()=>page.evaluate(()=>Boolean(window.releaseIdeas))).toBe(true);
  await page.evaluate(()=>window.testAuthEvent('SIGNED_OUT'));
  await page.evaluate(()=>window.releaseIdeas());
  await expect(page.locator('#ceoWorkspace')).toBeEmpty();
  await expect(page.locator('#authScreen')).toBeVisible();
  expect(await page.evaluate(()=>state)).toBeNull();
});
test('shared ideas persist for the company without copying its agenda into a member account',async({page})=>{
  await team(page);
  await page.locator('.nav [data-module="ideias"]').click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Ideia compartilhada da ZAMA');
  await expect(page.locator('#ceoWorkspace')).not.toContainText('Ideia pessoal reservada');
  await page.getByRole('button',{name:'+ Nova ideia',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Título',{exact:true}).fill('Nossa próxima campanha');
  await page.getByRole('dialog').getByRole('button',{name:'Salvar ideia',exact:true}).click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Nossa próxima campanha');
  const snapshot=await page.evaluate(()=>({own:JSON.parse(localStorage.getItem('test-cloud')).data,team:JSON.parse(localStorage.getItem('test-cloud:shared-company')).data}));
  expect(snapshot.own.agenda[0].nome).toBe('Minha agenda particular');
  expect(snapshot.own.ideias[0].titulo).toBe('Ideia pessoal reservada');
  expect(snapshot.team.agenda[0].nome).toBe('Agenda privada do administrador');
  expect(snapshot.team.ideias.some(idea=>idea.titulo==='Nossa próxima campanha')).toBe(true);
  await page.reload(); await page.locator('.nav [data-module="ideias"]').click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Nossa próxima campanha');
});
test('converting a shared idea creates only a private task and never publishes its schedule',async({page})=>{
  await team(page); await page.locator('.nav [data-module="ideias"]').click();
  const card=page.locator('.ceo-idea-card').filter({hasText:'Ideia compartilhada da ZAMA'});
  await card.getByRole('button',{name:'Criar tarefa',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Horário',{exact:true}).fill('17:35');
  await page.getByRole('dialog').getByRole('button',{name:'Criar tarefa',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const snapshot=await page.evaluate(()=>({own:JSON.parse(localStorage.getItem('test-cloud')).data,team:JSON.parse(localStorage.getItem('test-cloud:shared-company')).data}));
  expect(snapshot.own.agenda.some(task=>task.nome==='Ideia compartilhada da ZAMA'&&task.hora==='17:35')).toBe(true);
  expect(JSON.stringify(snapshot.team)).not.toContain('17:35');
  expect(snapshot.team.ideias[0].etapa).toBe('avaliacao');
});
test('priority filters include overdue steps and deadlines persist after reloading',async({page})=>{
  await owner(page);
  await page.locator('[data-priority="overdue"]').click();
  await expect(page.locator('[data-project-board] .ceo-project-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Abrir projeto Campanha Aurora',exact:true}).click();
  await page.getByRole('button',{name:'Editar projeto',exact:true}).click();
  await dialog(page).getByLabel('Prazo da etapa: Gravar vídeo',{exact:true}).fill('2026-10-04');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await dialog(page).getByRole('button',{name:'Fechar',exact:true}).click();
  await page.reload(); await page.locator('.nav [data-module="projetos"]').click();
  await page.locator('[data-priority="overdue"]').click();
  await expect(page.locator('[data-project-board] .ceo-project-card')).toHaveCount(0);
  await page.locator('[data-priority="upcoming"]').click();
  await expect(page.locator('[data-project-board] .ceo-project-card')).toHaveCount(2);
});
test('production templates preserve drafts and copy only clean structure with new IDs',async({page})=>{
  await owner(page);
  await page.getByRole('button',{name:'Abrir projeto Campanha Aurora',exact:true}).click();
  await page.getByRole('button',{name:'Editar projeto',exact:true}).click();
  await dialog(page).locator('summary').click();
  await dialog(page).getByLabel('Nome do modelo',{exact:true}).fill('Modelo de vídeo');
  await dialog(page).getByRole('button',{name:'Salvar como modelo',exact:true}).click();
  await expect(dialog(page).locator('[data-template-message]')).toContainText('Modelo salvo');
  const saved=await page.evaluate(()=>window.testRpcCalls.find(call=>call.name==='zama_project_template_save').params.p_template);
  expect(Object.keys(saved).sort()).toEqual(['production_lists','title']);
  expect(saved.production_lists[0].steps.every(step=>!step.done&&!step.due_date)).toBe(true);
  await dialog(page).getByRole('button',{name:'Cancelar',exact:true}).first().click();
  await page.getByRole('button',{name:'+ Novo projeto',exact:true}).click();
  await dialog(page).getByLabel('Nome do projeto',{exact:true}).fill('Rascunho preservado');
  await dialog(page).locator('summary').click();
  await expect(dialog(page).getByLabel('Modelo de produção',{exact:true})).toContainText('Modelo de vídeo');
  await dialog(page).getByLabel('Modelo de produção',{exact:true}).selectOption({label:'Modelo de vídeo'});
  await dialog(page).getByRole('button',{name:'Adicionar modelo',exact:true}).click();
  await expect(dialog(page).getByLabel('Nome do projeto',{exact:true})).toHaveValue('Rascunho preservado');
  await expect(dialog(page).locator('[data-production-list]')).toHaveCount(1);
  await expect(dialog(page).locator('[data-step-done]:checked')).toHaveCount(0);
  expect(await dialog(page).locator('[data-step-due]').evaluateAll(inputs=>inputs.every(input=>!input.value))).toBe(true);
  expect(await dialog(page).locator('[data-production-list]').getAttribute('data-list-id')).not.toBe(saved.production_lists[0].id);
});
for(const width of [1440,390,320]) test(`team project design fits ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:1000}); await owner(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`projects-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'Abrir projeto Campanha Aurora',exact:true}).click();
  await page.getByRole('button',{name:'Editar projeto',exact:true}).click();
  await dialog(page).locator('summary').click();
  expect(await dialog(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`editor-${width}.png`),fullPage:true});
});
