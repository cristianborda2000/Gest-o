const {test,expect}=require('@playwright/test');
const {mock,seed}=require('./mock-supabase');

const id='11111111-1111-4111-8111-111111111111',owner='shared-company';
const planning={id:'planning',title:'Planejamento',description:'Conferir briefing e registrar a aprovação interna.\nGuardar a versão revisada.',responsible_name:'Ana Produção',due_date:'2026-10-12',status:'in_progress',links:[{label:'Briefing interno',url:'https://example.invalid/briefing?projeto=aurora'}],steps:[{id:'brief',label:'Conferir briefing',done:false,due_date:'2026-10-02'}]};
const delivery={id:'delivery',title:'Entrega',description:'Revisar os arquivos finais.',responsible_name:'João Revisão',due_date:'2026-10-18',status:'waiting',links:[{label:'Pasta de entrega',url:'https://example.invalid/entrega'}],steps:[{id:'review',label:'Revisar arquivos',done:false}]};
const project={id,title:'Projeto interno Aurora',client_name:'Cliente Aurora',company_name:'Aurora',responsible_name:'Marina',responsible_email:'other@example.invalid',status:'planning',notes:'Registro geral do projeto',revision:1,updated_at:'2026-09-28T15:00:00Z',production_lists:[planning,delivery]};
const dialog=page=>page.locator('#ceoProjectDialog');
const card=page=>page.locator(`[data-project-id="${id}"]`);
const process=(page,listId)=>dialog(page).locator(`[data-production-list][data-list-id="${listId}"]`);
const track=(page,title)=>dialog(page).locator('.ceo-project-detail-track').filter({has:page.getByRole('heading',{name:title,exact:true})});
const saves=page=>page.evaluate(()=>window.testRpcCalls.filter(call=>call.name==='zama_project_save'));
async function setup(page,options={}) {
  await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'},{owner_id:owner,role:'viewer',name:'ZAMA'}]},rows:{[owner]:seed},projects:{[owner]:[project]},...options});
  await expect(card(page)).toBeVisible();
}
async function open(page) {
  await card(page).getByRole('button',{name:'Abrir projeto Projeto interno Aurora',exact:true}).click();
}
async function edit(page) {
  await open(page);
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
}
async function expand(page) {
  await expect(card(page)).toBeVisible();
  const toggle=card(page).locator('[data-project-toggle]');
  if(await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
  await expect(card(page).locator('[data-project-details]')).toBeVisible();
}
async function save(page) {
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expect(dialog(page).locator('.ceo-project-detail-track').first()).toBeVisible();
}
async function expectSafeLink(scope,label,url) {
  const link=scope.getByRole('link').filter({hasText:label});
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href',url);
  await expect(link).toHaveAttribute('target','_blank');
  expect((await link.getAttribute('rel')).split(/\s+/)).toEqual(expect.arrayContaining(['noopener','noreferrer']));
}

test('a team member saves independent internal process records and sees them after reload',async({page},info)=>{
  const bareLists=project.production_lists.map(({id,title,steps})=>({id,title,steps}));
  await setup(page,{projects:{[owner]:[{...project,production_lists:bareLists}]}});await edit(page);
  for(const record of [planning,delivery]) {
    const form=process(page,record.id);
    await form.getByLabel('Descrição e instruções do processo',{exact:true}).fill(record.description);
    await form.getByLabel('Responsável pelo processo',{exact:true}).fill(record.responsible_name);
    await form.getByLabel('Prazo do processo',{exact:true}).fill(record.due_date);
    await form.getByLabel('Andamento do processo',{exact:true}).selectOption(record.status);
    await form.locator('[data-process-link-add]').click();
    await form.locator('[data-process-link-label]').fill(record.links[0].label);
    await form.locator('[data-process-link-url]').fill(record.links[0].url);
  }
  await save(page);
  const payload=(await saves(page)).at(-1).params.p_project;
  expect(payload.production_lists).toMatchObject([planning,delivery]);
  expect(payload.status).toBe('planning');
  await page.reload();await expand(page);
  const preview=card(page).locator(`[data-list-preview="${id}:planning"]`);
  await expect(preview).toContainText(planning.responsible_name);
  await expect(preview).toContainText('12/10/2026');
  await expectSafeLink(preview,planning.links[0].label,planning.links[0].url);
  await open(page);
  for(const record of [planning,delivery]) {
    const detail=track(page,record.title);
    await expect(detail).toContainText(record.description.split('\n')[0]);
    await expect(detail).toContainText(record.responsible_name);
    await expectSafeLink(detail,record.links[0].label,record.links[0].url);
  }
  await expect(track(page,'Planejamento')).toContainText('Em andamento');
  await expect(track(page,'Entrega')).toContainText('Aguardando');
  await track(page,'Planejamento').evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));
  await page.screenshot({path:info.outputPath('process-detail-desktop.png')});
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
  await expect(process(page,'planning').locator('[data-process-description]')).toHaveValue(planning.description);
  await expect(process(page,'delivery').locator('[data-process-responsible]')).toHaveValue(delivery.responsible_name);
  await process(page,'planning').evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));
  await page.screenshot({path:info.outputPath('process-editor-desktop.png')});
  expect(await page.evaluate(()=>window.testDbWrites)).toEqual([]);
});

test('clearing a process removes its saved metadata without changing the other process',async({page})=>{
  await setup(page);await edit(page);
  const form=process(page,'planning');
  await form.locator('[data-process-description]').fill('');
  await form.locator('[data-process-responsible]').fill('');
  await form.locator('[data-process-due]').fill('');
  await form.locator('[data-process-status]').selectOption('planning');
  await form.locator('[data-process-link-remove]').click();
  await save(page);
  const lists=(await saves(page)).at(-1).params.p_project.production_lists;
  expect(lists[0]).toEqual(expect.objectContaining({description:'',responsible_name:'',due_date:null,status:'planning',links:[]}));
  expect(lists[1]).toMatchObject(delivery);
  await page.reload();await edit(page);
  await expect(form.locator('[data-process-description]')).toHaveValue('');
  await expect(form.locator('[data-process-responsible]')).toHaveValue('');
  await expect(form.locator('[data-process-due]')).toHaveValue('');
  await expect(form.locator('[data-process-link]')).toHaveCount(0);
  await expect(process(page,'delivery').locator('[data-process-link-url]')).toHaveValue(delivery.links[0].url);
});

for(const collaborationUnavailable of [false,true])test(`checking an internal step preserves process records${collaborationUnavailable?' through the older save RPC':''}`,async({page})=>{
  await setup(page,{collaborationUnavailable,workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'},{owner_id:owner,role:'projects',name:'ZAMA'}]}});
  await expand(page);
  await card(page).locator('[data-quick-step="brief"]').check();
  await expect(card(page)).toHaveAttribute('aria-busy','false');
  await page.reload();await expand(page);
  await expect(card(page).locator('[data-quick-step="brief"]')).toBeChecked();
  await open(page);
  for(const record of [planning,delivery]) {
    await expect(track(page,record.title)).toContainText(record.responsible_name);
    await expect(track(page,record.title)).toContainText(record.description.split('\n')[0]);
    await expectSafeLink(track(page,record.title),record.links[0].label,record.links[0].url);
  }
  await expect(track(page,'Planejamento')).toContainText('Em andamento');
});

test('a failed save retains all process drafts and a retry persists them',async({page})=>{
  await setup(page);await edit(page);
  const form=process(page,'planning');
  await form.locator('[data-process-description]').fill('Instruções ainda não salvas');
  await form.locator('[data-process-responsible]').fill('Beatriz');
  await form.locator('[data-process-due]').fill('2026-11-05');
  await form.locator('[data-process-status]').selectOption('completed');
  await form.locator('[data-process-link-url]').fill('https://example.invalid/revisao-final');
  await page.evaluate(()=>window.testFailRpc='zama_project_save');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(form.locator('[data-process-description]')).toHaveValue('Instruções ainda não salvas');
  await expect(form.locator('[data-process-responsible]')).toHaveValue('Beatriz');
  await expect(form.locator('[data-process-due]')).toHaveValue('2026-11-05');
  await expect(form.locator('[data-process-status]')).toHaveValue('completed');
  await expect(form.locator('[data-process-link-url]')).toHaveValue('https://example.invalid/revisao-final');
  await page.evaluate(()=>window.testFailRpc='');await save(page);
  await page.reload();await open(page);
  await expect(track(page,'Planejamento')).toContainText('Instruções ainda não salvas');
  await expect(track(page,'Planejamento')).toContainText('Beatriz');
  await expect(track(page,'Planejamento')).toContainText('05/11/2026');
  await expect(track(page,'Planejamento')).toContainText('Concluído');
});

test('unsafe link input cannot save or discard the process draft',async({page})=>{
  await setup(page);await edit(page);
  const form=process(page,'planning');
  await form.locator('[data-process-description]').fill('Meu registro preservado');
  await form.locator('[data-process-link-url]').fill('javascript:alert(1)');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expect(form.locator('[data-process-description]')).toHaveValue('Meu registro preservado');
  await expect(form.locator('[data-process-link-url]')).toHaveValue('javascript:alert(1)');
  expect(await saves(page)).toHaveLength(0);
  await form.locator('[data-process-link-url]').fill('https://example.invalid/corrigido');await save(page);
  await expectSafeLink(track(page,'Planejamento'),planning.links[0].label,'https://example.invalid/corrigido');
});

test('unsafe stored process URLs are never rendered as actionable links',async({page})=>{
  const links=[...planning.links,{label:'Link inválido',url:'javascript:alert(1)'},{label:'Arquivo inseguro',url:'data:text/html,<script>alert(1)</script>'}];
  await setup(page,{projects:{[owner]:[{...project,production_lists:[{...planning,links},delivery]}]}});
  await expand(page);await expect(card(page).locator('a[href^="javascript:"],a[href^="data:"]')).toHaveCount(0);
  await open(page);await expect(dialog(page).locator('a[href^="javascript:"],a[href^="data:"]')).toHaveCount(0);
  await expectSafeLink(track(page,'Planejamento'),planning.links[0].label,planning.links[0].url);
});

test('an older database hides process editing while existing project and step fields still save',async({page})=>{
  const bareLists=project.production_lists.map(({id,title,steps})=>({id,title,steps}));
  await setup(page,{processesUnavailable:true,projects:{[owner]:[{...project,production_lists:bareLists}]}});await edit(page);
  await expect(dialog(page).locator('[data-process-description],[data-process-responsible],[data-process-due],[data-process-status],[data-process-link-add]')).toHaveCount(0);
  await dialog(page).getByLabel('Nome do projeto',{exact:true}).fill('Projeto interno atualizado');
  await process(page,'planning').locator('[data-step-label]').fill('Briefing revisado');
  await save(page);
  const payload=(await saves(page)).at(-1).params.p_project;
  expect(payload.production_lists[0].steps[0].label).toBe('Briefing revisado');
  for(const list of payload.production_lists) for(const key of ['description','responsible_name','due_date','status','links']) expect(Object.hasOwn(list,key)).toBe(false);
  await page.reload();await expect(card(page)).toContainText('Projeto interno atualizado');
});

test('applying and saving a template preserves process drafts but copies only list and step structure',async({page})=>{
  const template={id:'22222222-2222-4222-8222-222222222222',title:'Modelo de planejamento',revision:1,production_lists:[{...planning,steps:[{...planning.steps[0],done:true}]}]};
  await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'ZAMA'}]},projects:{'test-account':[]},templates:[template]});
  await page.locator('.nav [data-module="projetos"]').click();
  await page.getByRole('button',{name:'+ Novo projeto',exact:true}).click();
  const original=dialog(page).locator('[data-production-list]').first();
  await expect(original.locator('[data-step-id]')).toHaveCount(0);
  await expect(original.locator('[data-list-title]')).toHaveValue('Lista de produção');
  const originalId=await original.getAttribute('data-list-id');
  await original.locator('[data-process-description]').fill('Instruções do processo ainda em elaboração');
  await original.locator('[data-process-responsible]').fill('Equipe de planejamento');
  await original.locator('[data-process-due]').fill('2026-11-01');
  await original.locator('[data-process-status]').selectOption('in_progress');
  await original.locator('[data-process-link-add]').click();
  await original.locator('[data-process-link-label]').fill('Rascunho interno');
  await original.locator('[data-process-link-url]').fill('https://example.invalid/rascunho');
  await dialog(page).locator('.ceo-project-templates > summary').click();
  await expect(dialog(page).locator('[data-template-select]')).toBeEnabled();
  await dialog(page).locator('[data-template-select]').selectOption(template.id);
  await dialog(page).locator('[data-template-apply]').click();
  await expect(dialog(page).locator('[data-production-list]')).toHaveCount(2);
  await expect(original).toHaveAttribute('data-list-id',originalId);
  await expect(original.locator('[data-process-description]')).toHaveValue('Instruções do processo ainda em elaboração');
  await expect(original.locator('[data-process-responsible]')).toHaveValue('Equipe de planejamento');
  await expect(original.locator('[data-process-due]')).toHaveValue('2026-11-01');
  await expect(original.locator('[data-process-status]')).toHaveValue('in_progress');
  await expect(original.locator('[data-process-link-url]')).toHaveValue('https://example.invalid/rascunho');
  const applied=dialog(page).locator('[data-production-list]').nth(1);
  await expect(applied.locator('[data-list-title]')).toHaveValue(planning.title);
  await expect(applied.locator('[data-process-description]')).toHaveValue('');
  await expect(applied.locator('[data-process-responsible]')).toHaveValue('');
  await expect(applied.locator('[data-process-due]')).toHaveValue('');
  await expect(applied.locator('[data-process-status]')).toHaveValue('planning');
  await expect(applied.locator('[data-process-link]')).toHaveCount(0);
  await expect(applied.locator('[data-step-done]')).not.toBeChecked();
  await expect(applied.locator('[data-step-due]')).toHaveValue('');
  await dialog(page).locator('[data-template-name]').fill('Estrutura reutilizável');
  await dialog(page).locator('[data-template-save]').click();
  await expect(dialog(page).locator('[data-template-message]')).toContainText('Modelo salvo');
  const saved=await page.evaluate(()=>window.testRpcCalls.find(call=>call.name==='zama_project_template_save').params.p_template);
  expect(saved.production_lists).toHaveLength(2);
  for(const list of saved.production_lists) {
    expect(Object.keys(list).sort()).toEqual(['id','steps','title']);
    for(const step of list.steps) expect(Object.keys(step).sort()).toEqual(['done','id','label']);
  }
  expect(saved.production_lists[1].steps[0].done).toBe(false);
  expect(await saves(page)).toHaveLength(0);
});

test('internal process forms and long links fit a 320px viewport',async({page},info)=>{
  await page.setViewportSize({width:320,height:950});
  const longLink={label:'Pasta com todos os documentos e referências internas do projeto Aurora',url:`https://example.invalid/documentos/${'a'.repeat(120)}`};
  await setup(page,{projects:{[owner]:[{...project,production_lists:[{...planning,links:[longLink]},delivery]}]}});
  await expand(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expectSafeLink(card(page),longLink.label,longLink.url);
  await page.screenshot({path:info.outputPath('process-card-320.png'),fullPage:true});
  await open(page);
  await track(page,'Planejamento').evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));
  await page.screenshot({path:info.outputPath('process-detail-320.png')});
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
  for(const selector of ['[data-process-description]','[data-process-responsible]','[data-process-due]','[data-process-status]','[data-process-link-label]','[data-process-link-url]']) {
    const input=process(page,'planning').locator(selector);
    await expect(input).toBeVisible();
    const box=await input.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);
  }
  expect(await dialog(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await process(page,'planning').locator('[data-process-description]').evaluate(node=>node.scrollIntoView({block:'start',behavior:'instant'}));
  await page.screenshot({path:info.outputPath('process-editor-320.png')});
});
