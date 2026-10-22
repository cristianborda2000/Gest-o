const {test,expect}=require('@playwright/test');
const {mock,seed}=require('./mock-supabase');

const projectId='11111111-1111-4111-8111-111111111111';
const company='shared-company';
const password='fixture-navigation-password-2026';
const project={
  id:projectId,title:'Acessos do projeto Aurora',client_name:'Cliente Aurora',company_name:'Aurora',
  client_email:'cliente.aurora@example.invalid',access_url:'https://example.invalid/acesso',
  responsible_email:'test@example.invalid',responsible_name:'Responsável da equipe',
  status:'in_progress',password,revision:1,updated_at:'2026-09-28T15:00:00Z',
  production_lists:[{id:'production',title:'Produção',steps:[{id:'review',label:'Revisar arquivos',done:false}]}]
};
const card=page=>page.locator(`[data-project-id="${projectId}"]`);
const preview=page=>card(page).locator('.ceo-project-access-preview');
const dialog=page=>page.locator('#ceoProjectDialog');
const credentials=page=>dialog(page).locator('.ceo-project-credentials');
const secretCalls=page=>page.evaluate(()=>window.testRpcCalls.filter(call=>call.name==='zama_project_secret'));
async function setup(page,{role='projects',record=project}={}) {
  if(role==='owner') {
    await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'ZAMA'}]},projects:{'test-account':[record]}});
    if(page.viewportSize().width<=720) await page.getByRole('button',{name:'Abrir menu',exact:true}).click();
    await page.locator('.nav [data-module="projetos"]').click();
  } else {
    await page.addInitScript(()=>sessionStorage.setItem('zama-workspace:test-account','shared-company'));
    await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'},{owner_id:company,role,name:'ZAMA'}]},rows:{[company]:seed},projects:{[company]:[record]}});
    if(role!=='projects') await page.locator('.nav [data-module="projetos"]').click();
  }
  await expect(card(page)).toBeVisible();
}
async function expand(page) {
  await card(page).locator('[data-project-toggle]').click();
  await expect(preview(page)).toBeVisible();
}
async function openAccess(page) {
  await card(page).getByRole('button',{name:'Ver dados de acesso',exact:true}).click();
  await expect(dialog(page).getByRole('tab',{name:'Acessos',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(credentials(page)).toBeVisible();
  await expect(credentials(page)).toHaveAttribute('tabindex','-1');
  await expect(credentials(page)).toBeFocused();
  await expect(credentials(page)).toBeInViewport();
}
async function noPersistedPassword(page) {
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},state,cloudSnapshot}))).not.toContain(password);
}

for(const role of ['owner','projects'])test(`${role} reaches registered credentials from the expanded card and reveals only on demand`,async({page})=>{
  await setup(page,{role});
  await expect(preview(page)).toBeHidden();
  expect(await secretCalls(page)).toEqual([]);
  await expand(page);
  await expect(preview(page).getByRole('heading',{name:'Acessos do cliente',exact:true})).toBeVisible();
  await expect(preview(page)).toContainText(project.client_email);
  await expect(preview(page)).toContainText(/senha\s*cadastrada/i);
  await expect(preview(page)).not.toContainText(password);
  expect(await secretCalls(page)).toEqual([]);
  await openAccess(page);
  await expect(credentials(page)).toContainText(project.client_email);
  const secret=credentials(page).getByLabel('Senha do cliente',{exact:true});
  await expect(secret).toHaveValue('');
  await expect(secret).toHaveAttribute('type','password');
  expect(await secretCalls(page)).toEqual([]);
  await credentials(page).getByRole('button',{name:'Mostrar senha',exact:true}).click();
  await expect(secret).toHaveValue(password);
  expect(await secretCalls(page)).toHaveLength(1);
  await noPersistedPassword(page);
  await dialog(page).getByRole('button',{name:'Fechar',exact:true}).click();
  await expect(dialog(page)).toHaveCount(0);
  await openAccess(page);
  await expect(secret).toHaveValue('');
  expect(await secretCalls(page)).toHaveLength(1);
});

for(const [role,responsibleEmail] of [['viewer','test@example.invalid'],['projects','other@example.invalid']])test(`${role} without secret permission can navigate to the access email without exposing the password`,async({page})=>{
  await setup(page,{role,record:{...project,responsible_email:responsibleEmail}});
  await expand(page);
  await expect(preview(page)).toContainText(project.client_email);
  await expect(preview(page)).toContainText(/senha\s*cadastrada/i);
  await openAccess(page);
  await expect(credentials(page)).toContainText(project.client_email);
  await expect(credentials(page).getByLabel('Senha do cliente',{exact:true})).toHaveValue('');
  await expect(credentials(page).getByRole('button',{name:'Mostrar senha',exact:true})).toHaveCount(0);
  expect(await secretCalls(page)).toEqual([]);
  await noPersistedPassword(page);
});

test('projects without registered credentials show clear empty states and keep the access action available',async({page})=>{
  await setup(page,{role:'owner',record:{...project,client_email:'',access_url:'',password:''}});
  await expand(page);
  await expect(preview(page)).toContainText(/não informado/i);
  await expect(preview(page)).toContainText(/não cadastrada/i);
  await openAccess(page);
  await expect(credentials(page)).toContainText('Não informado');
  await expect(credentials(page).getByLabel('Senha do cliente',{exact:true})).toHaveAttribute('placeholder','Não cadastrada');
  await expect(credentials(page).getByRole('button',{name:'Mostrar senha',exact:true})).toHaveCount(0);
  expect(await secretCalls(page)).toEqual([]);
});

test('expanded access summary and credential dialog fit a 320px screen with a long email',async({page},info)=>{
  await page.setViewportSize({width:320,height:950});
  const email='time.interno.producao.projetos@example.invalid';
  await setup(page,{record:{...project,client_email:email}});
  await expand(page);
  await expect(preview(page)).toContainText(email);
  for(const target of [card(page),preview(page),preview(page).getByRole('button',{name:'Ver dados de acesso',exact:true})]) {
    const box=await target.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);
  }
  const buttonBox=await preview(page).getByRole('button',{name:'Ver dados de acesso',exact:true}).boundingBox();
  expect(buttonBox.height).toBeGreaterThanOrEqual(44);
  expect(await preview(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await preview(page).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('project-access-preview-320.png')});
  await openAccess(page);
  await expect(credentials(page)).toContainText(email);
  for(const target of [dialog(page),credentials(page)]) {
    const box=await target.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(320);
    expect(await target.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  }
  await page.screenshot({path:info.outputPath('project-access-dialog-320.png')});
  expect(await secretCalls(page)).toEqual([]);
});
