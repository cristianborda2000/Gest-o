const {test,expect}=require('@playwright/test');
const {mock,seed}=require('./mock-supabase');
const id='11111111-1111-4111-8111-111111111111',owner='shared-company';
const project={id,title:'Campanha ZAMA',client_name:'Cliente Aurora',company_name:'Aurora',responsible_email:'other@example.invalid',responsible_name:'Ana',status:'planning',due_date:'2026-10-20',notes:'Notas preservadas',revision:1,updated_at:'2026-09-28T15:00:00Z',production_lists:[{id:'video',title:'Produção',steps:[{id:'brief',label:'Conferir briefing',done:false,due_date:'2026-10-02'},{id:'film',label:'Gravar vídeo',done:false}]}]};
const dialog=page=>page.locator('#ceoProjectDialog');
const card=page=>page.locator(`[data-project-id="${id}"]`);
const check=(page,step)=>card(page).locator(`[data-quick-step="${step}"]`);
async function expand(page) {
  const toggle=card(page).locator('[data-project-toggle]');
  await expect(toggle).toBeVisible();
  if(await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
  await expect(card(page).locator('[data-project-details]')).toBeVisible();
}
async function setup(page,options={}) {
  await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'},{owner_id:owner,role:'viewer',name:'ZAMA'}]},rows:{[owner]:seed},projects:{[owner]:[project]},...options});
  await expect(card(page)).toBeVisible();
  await expand(page);
}
test('every team member can create in a column and edit project metadata',async({page})=>{
  await setup(page);
  await expect(page.locator('.ceo-project-column')).toHaveCount(4);
  await page.locator('[data-column-add="in_progress"]').click();
  await dialog(page).getByLabel('Nome do projeto',{exact:true}).fill('Projeto criado pela equipe');
  await dialog(page).getByLabel('Nome do cliente',{exact:true}).fill('Cliente da equipe');
  await expect(dialog(page).getByLabel('Situação do projeto',{exact:true})).toHaveValue('in_progress');
  await expect(dialog(page).locator('[name="password"]')).toHaveCount(0);
  await dialog(page).getByRole('button',{name:'Criar projeto',exact:true}).click();
  await expect(dialog(page)).toContainText('Projeto criado pela equipe');
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
  await dialog(page).getByLabel('Nome do projeto',{exact:true}).fill('Projeto atualizado pela equipe');
  await dialog(page).getByLabel('Prazo da entrega',{exact:true}).fill('2026-10-25');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expect(dialog(page)).toContainText('25/10/2026');
  await expect(dialog(page).getByRole('button',{name:'Excluir projeto',exact:true})).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-project-column="in_progress"]')).toContainText('Projeto atualizado pela equipe');
  const writes=await page.evaluate(()=>window.testDbWrites);
  expect(writes).toEqual([]);
});
test('rapid checks serialize revisions and persist the final choice without changing other fields',async({page})=>{
  await setup(page);
  await page.evaluate(()=>window.testDelayNextProjectRpc='zama_project_step_set');
  await check(page,'brief').check();
  await expect.poll(()=>page.evaluate(()=>window.testPendingProjectRpcs.length)).toBe(1);
  await check(page,'film').check();await check(page,'brief').uncheck();
  await page.evaluate(()=>window.testReleaseProjectRpcs());
  await expect(card(page)).toHaveAttribute('aria-busy','false');
  const calls=await page.evaluate(()=>window.testRpcCalls.filter(call=>call.name==='zama_project_step_set'));
  expect(calls.map(call=>[call.params.p_step_id,call.params.p_done,call.params.p_revision])).toEqual([['brief',true,1],['film',true,2],['brief',false,3]]);
  await page.reload();await expand(page);await expect(check(page,'film')).toBeChecked();await expect(check(page,'brief')).not.toBeChecked();
  await card(page).getByRole('button',{name:'Abrir projeto Campanha ZAMA',exact:true}).click();
  await expect(dialog(page)).toContainText('Notas preservadas');await expect(dialog(page)).toContainText('02/10/2026');
});
for(const returnWhileSaving of [false,true])test(`queued checks survive module navigation${returnWhileSaving?' and returning before save finishes':''}`,async({page})=>{
  await setup(page);
  await page.evaluate(()=>window.testDelayNextProjectRpc='zama_project_step_set');
  await check(page,'brief').check();
  await expect.poll(()=>page.evaluate(()=>window.testPendingProjectRpcs.length)).toBe(1);
  await check(page,'film').check();
  await page.locator('.nav [data-module="agenda"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-module','agenda');
  await expect(card(page)).toHaveCount(0);
  if(returnWhileSaving) {
    await page.locator('.nav [data-module="projetos"]').click();
    await expand(page);
    await expect(check(page,'brief')).toBeChecked();await expect(check(page,'film')).toBeChecked();
  }
  await page.evaluate(()=>window.testReleaseProjectRpcs());
  await expect.poll(()=>page.evaluate(()=>window.testRpcCalls.filter(call=>call.name==='zama_project_step_set').length)).toBe(2);
  if(!returnWhileSaving) {
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('body')).toHaveAttribute('data-module','agenda');
    await page.locator('.nav [data-module="projetos"]').click();
    await expand(page);
  }
  await expect(card(page)).toHaveAttribute('aria-busy','false');
  await page.reload();await expand(page);await expect(check(page,'brief')).toBeChecked();await expect(check(page,'film')).toBeChecked();
});
test('a queued failure outside Projects warns the user and keeps only the saved checks',async({page})=>{
  await setup(page);
  await page.evaluate(()=>window.testDelayNextProjectRpc='zama_project_step_set');
  await check(page,'brief').check();
  await expect.poll(()=>page.evaluate(()=>window.testPendingProjectRpcs.length)).toBe(1);
  await check(page,'film').check();
  await page.locator('.nav [data-module="agenda"]').click();
  await page.evaluate(()=>{window.testFailRpc='zama_project_step_set';window.testReleaseProjectRpcs();});
  await expect(page.locator('.toast').last()).toContainText('Alterações de projetos não salvas');
  await expect(page.locator('body')).toHaveAttribute('data-module','agenda');
  await expect(card(page)).toHaveCount(0);
  await page.evaluate(()=>window.testFailRpc='');
  await page.locator('.nav [data-module="projetos"]').click();
  await expand(page);
  await expect(check(page,'brief')).toBeChecked();await expect(check(page,'film')).not.toBeChecked();
  await page.reload();await expand(page);await expect(check(page,'brief')).toBeChecked();await expect(check(page,'film')).not.toBeChecked();
});
test('checkbox keyboard access works in the detail without closing it or losing focus',async({page})=>{
  await setup(page);await card(page).getByRole('button',{name:'Abrir projeto Campanha ZAMA',exact:true}).click();
  await dialog(page).getByRole('tab',{name:'Processos',exact:true}).click();
  const input=dialog(page).getByRole('checkbox',{name:'Concluir etapa: Conferir briefing',exact:true});
  await input.focus();await input.press('Space');
  await expect(dialog(page).locator('[data-quick-feedback]')).toContainText('salvas');
  await expect(input).toBeChecked();await expect(input).toBeFocused();
  await expect(dialog(page)).toBeVisible();
  expect((await input.locator('..').boundingBox()).height).toBeGreaterThanOrEqual(44);
});
test('changing the column saves status and keeps unfinished checklist items',async({page})=>{
  await setup(page);await card(page).getByLabel('Situação de Campanha ZAMA',{exact:true}).selectOption('completed');
  await expect(page.locator('[data-project-column="completed"] [data-project-id]')).toHaveAttribute('aria-busy','false');
  await page.reload();await expect(page.locator('[data-project-column="completed"]')).toContainText('Campanha ZAMA');
  await expand(page);
  await expect(check(page,'brief')).not.toBeChecked();
});
test('failed and conflicting checks roll back visibly without overwriting newer changes',async({page})=>{
  await setup(page);await page.evaluate(()=>window.testFailRpc='zama_project_step_set');
  await check(page,'brief').click();await expect(page.locator('[data-project-feedback]')).toContainText('não salvas');
  await expect(check(page,'brief')).not.toBeChecked();
  await page.evaluate(async({id,owner})=>{
    window.testFailRpc='';
    await supabaseClient.rpc('zama_project_save',{p_owner:owner,p_project:{id,revision:1,notes:'Atualização remota preservada'}});
  },{id,owner});
  await check(page,'brief').click();await expect(page.locator('[data-project-feedback]')).toContainText('outra sessão');
  await expect(check(page,'brief')).not.toBeChecked();
  await page.getByRole('button',{name:'Atualizar',exact:true}).click();
  await card(page).getByRole('button',{name:'Abrir projeto Campanha ZAMA',exact:true}).click();
  await expect(dialog(page)).toContainText('Atualização remota preservada');
});
test('a late checkbox response after sign-out cannot restore private content',async({page})=>{
  await setup(page);await page.evaluate(()=>window.testDelayNextProjectRpc='zama_project_step_set');
  await check(page,'brief').check();await expect.poll(()=>page.evaluate(()=>window.testPendingProjectRpcs.length)).toBe(1);
  await check(page,'film').check();
  await page.evaluate(()=>window.testAuthEvent('SIGNED_OUT'));await page.evaluate(()=>window.testReleaseProjectRpcs());
  await expect(page.locator('#ceoWorkspace')).toBeEmpty();await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('#loginEmail')).toHaveCSS('color','rgb(23, 26, 32)');
  expect(await page.evaluate(()=>window.testRpcCalls.filter(call=>call.name==='zama_project_step_set').length)).toBe(1);
});
test('a project with credentials does not allow a collaborator to self-assign or see its secret',async({page})=>{
  await setup(page,{projects:{[owner]:[{...project,password:'fixture-private-client-secret'}]}});
  await card(page).getByRole('button',{name:'Abrir projeto Campanha ZAMA',exact:true}).click();
  await dialog(page).getByRole('tab',{name:'Acessos',exact:true}).click();
  await expect(dialog(page).getByRole('button',{name:'Mostrar senha',exact:true})).toHaveCount(0);
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
  await expect(dialog(page).getByLabel('E-mail do responsável',{exact:true})).toBeDisabled();
  await expect(dialog(page).getByLabel('Nome do projeto',{exact:true})).toBeEnabled();
  await expect(dialog(page).locator('[name="password"]')).toHaveCount(0);
});
test('old database keeps viewer creation disabled until the collaborative migration is installed',async({page})=>{
  await setup(page,{collaborationUnavailable:true});
  await expect(page.getByRole('button',{name:'+ Novo projeto',exact:true})).toHaveCount(0);
  await expect(check(page,'brief')).toBeDisabled();
});
for(const role of ['projects','editor'])test(`old database saves direct checks through the existing RPC for ${role}`,async({page})=>{
  await setup(page,{collaborationUnavailable:true,workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'},{owner_id:owner,role,name:'ZAMA'}]}});
  await check(page,'brief').check();
  await expect(card(page)).toHaveAttribute('aria-busy','false');
  const calls=await page.evaluate(()=>window.testRpcCalls.filter(call=>['zama_project_save','zama_project_step_set'].includes(call.name)));
  expect(calls).toHaveLength(1);expect(calls[0].name).toBe('zama_project_save');
  expect(calls[0].params.p_owner).toBe(owner);
  expect(calls[0].params.p_project).toEqual({id,revision:1,production_lists:[{...project.production_lists[0],steps:[{...project.production_lists[0].steps[0],done:true},project.production_lists[0].steps[1]]}]});
  await page.reload();await expand(page);await expect(check(page,'brief')).toBeChecked();await expect(check(page,'film')).not.toBeChecked();
});
for(const width of [320,390,1440])test(`pastel collaborative board and editor fit ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:950});await setup(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await card(page).evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.locator('body').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgb(246, 247, 249)');
  const toggle=card(page).locator('[data-project-toggle]');
  const toggleBox=await toggle.boundingBox();
  expect(toggleBox.width).toBeGreaterThanOrEqual(44);expect(toggleBox.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:info.outputPath(`board-expanded-${width}.png`),fullPage:true});
  await toggle.click();
  await expect(card(page).locator('[data-project-details]')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`board-collapsed-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'+ Novo projeto',exact:true}).click();
  const box=await dialog(page).boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
  await page.screenshot({path:info.outputPath(`editor-${width}.png`),fullPage:true});
});
