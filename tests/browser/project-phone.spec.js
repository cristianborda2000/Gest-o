const {test,expect}=require('@playwright/test');
const {mock,seed}=require('./mock-supabase');

const id='11111111-1111-4111-8111-111111111111',owner='shared-company';
const project={id,title:'Campanha ZAMA',client_name:'Cliente Aurora',client_phone:'5511987654321',company_name:'Aurora',responsible_email:'other@example.invalid',responsible_name:'Ana',status:'planning',notes:'Notas preservadas',revision:1,updated_at:'2026-09-28T15:00:00Z',production_lists:[{id:'video',title:'Produção',steps:[{id:'brief',label:'Conferir briefing',done:false}]}]};
const dialog=page=>page.locator('#ceoProjectDialog');
const card=(page,projectId=id)=>page.locator(`[data-project-id="${projectId}"]`);
const phoneInput=page=>dialog(page).getByLabel('WhatsApp do cliente',{exact:true});
const whatsapp=(scope,client='Cliente Aurora')=>scope.getByRole('link',{name:`Abrir WhatsApp de ${client}`,exact:true});
const saves=page=>page.evaluate(()=>window.testRpcCalls.filter(call=>call.name==='zama_project_save'));

async function setup(page,options={}) {
  await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'},{owner_id:owner,role:'viewer',name:'ZAMA'}]},rows:{[owner]:seed},projects:{[owner]:[project]},...options});
  await expect(card(page)).toBeVisible();
}
async function edit(page) {
  await card(page).getByRole('button',{name:'Abrir projeto Campanha ZAMA',exact:true}).click();
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
}
async function expectWhatsApp(scope,phone,client='Cliente Aurora') {
  await expect(scope).toBeVisible();
  const toggle=scope.locator('[data-project-toggle]');
  if(await toggle.count() && await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
  const link=whatsapp(scope,client);
  await expect(link).toBeVisible();
  await expect(link).toContainText('Abrir WhatsApp');
  await expect(link).toHaveAttribute('href',`https://wa.me/${phone}`);
  await expect(link).toHaveAttribute('target','_blank');
  expect((await link.getAttribute('rel')).split(/\s+/)).toEqual(expect.arrayContaining(['noopener','noreferrer']));
}

test('a team member can add, reload, edit and remove the client WhatsApp number',async({page})=>{
  await setup(page);
  await page.getByRole('button',{name:'+ Novo projeto',exact:true}).click();
  await dialog(page).getByLabel('Nome do projeto',{exact:true}).fill('Projeto com WhatsApp');
  await dialog(page).getByLabel('Nome do cliente',{exact:true}).fill('Cliente Bela');
  await expect(phoneInput(page)).toHaveAttribute('type','tel');
  await phoneInput(page).fill('(11) 98765-4321');
  await dialog(page).getByRole('button',{name:'Criar projeto',exact:true}).click();
  await expectWhatsApp(dialog(page),'5511987654321','Cliente Bela');
  expect((await saves(page)).at(-1).params.p_project.client_phone).toBe('5511987654321');
  await page.reload();
  const newCard=page.locator('[data-project-id]').filter({hasText:'Projeto com WhatsApp'});
  await expectWhatsApp(newCard,'5511987654321','Cliente Bela');
  await newCard.getByRole('button',{name:'Abrir projeto Projeto com WhatsApp',exact:true}).click();
  await expect(dialog(page)).toContainText('+55 (11) 98765-4321');
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
  await expect(phoneInput(page)).toHaveValue('+55 (11) 98765-4321');
  await phoneInput(page).fill('(21) 99876-5432');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expectWhatsApp(dialog(page),'5521998765432','Cliente Bela');
  await dialog(page).getByRole('button',{name:'Editar projeto',exact:true}).click();
  await phoneInput(page).fill('');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expect(whatsapp(dialog(page),'Cliente Bela')).toHaveCount(0);
  expect((await saves(page)).at(-1).params.p_project.client_phone).toBe('');
  await page.reload();
  await expect(newCard).toBeVisible();
  await expect(whatsapp(newCard,'Cliente Bela')).toHaveCount(0);
});

for(const [input,canonical] of [
  ['(55) 99999-1234','5555999991234'],
  ['55 (11) 98765-4321','5511987654321'],
  ['+1 (202) 555-0123','12025550123']
])test(`normalizes ${input} without duplicating or dropping the country code`,async({page})=>{
  await setup(page);await edit(page);
  await phoneInput(page).fill(input);
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expectWhatsApp(dialog(page),canonical);
  expect((await saves(page)).at(-1).params.p_project.client_phone).toBe(canonical);
  await page.reload();await expectWhatsApp(card(page),canonical);
});

test('an invalid number blocks saving and preserves the project draft',async({page})=>{
  await setup(page);await edit(page);
  await dialog(page).getByLabel('Nome do projeto',{exact:true}).fill('Meu rascunho preservado');
  await phoneInput(page).fill('123');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(dialog(page).getByLabel('Nome do projeto',{exact:true})).toHaveValue('Meu rascunho preservado');
  await expect(phoneInput(page)).toHaveValue('123');
  expect(await saves(page)).toHaveLength(0);
});

test('the card and project details expose the same safe WhatsApp destination',async({page})=>{
  await setup(page);await expectWhatsApp(card(page),'5511987654321');
  await card(page).getByRole('button',{name:'Abrir projeto Campanha ZAMA',exact:true}).click();
  await expectWhatsApp(dialog(page),'5511987654321');
});

test('empty and unsafe stored phone values never create a WhatsApp link',async({page})=>{
  const emptyId='22222222-2222-4222-8222-222222222222';
  await setup(page,{projects:{[owner]:[{...project,client_phone:'javascript:alert(1)'},{...project,id:emptyId,title:'Projeto sem telefone',client_phone:''}]}});
  await expect(card(page).getByRole('link',{name:/Abrir WhatsApp/})).toHaveCount(0);
  await expect(card(page,emptyId).getByRole('link',{name:/Abrir WhatsApp/})).toHaveCount(0);
  await card(page).getByRole('button',{name:'Abrir projeto Campanha ZAMA',exact:true}).click();
  await expect(dialog(page).getByRole('link',{name:/Abrir WhatsApp/})).toHaveCount(0);
});

test('checking a project step preserves the registered client phone',async({page})=>{
  await setup(page);
  await expectWhatsApp(card(page),'5511987654321');
  await card(page).getByRole('checkbox',{name:'Concluir etapa: Conferir briefing',exact:true}).check();
  await expect(card(page)).toHaveAttribute('aria-busy','false');
  await page.reload();
  await expectWhatsApp(card(page),'5511987654321');
  await expect(card(page).getByRole('checkbox',{name:'Concluir etapa: Conferir briefing',exact:true})).toBeChecked();
});

test('the older database disables phone editing while other project fields still save',async({page})=>{
  await setup(page,{phoneUnavailable:true});await edit(page);
  await expect(phoneInput(page)).toBeDisabled();
  await dialog(page).getByLabel('Nome do projeto',{exact:true}).fill('Projeto atualizado sem telefone');
  await dialog(page).getByRole('button',{name:'Salvar alterações',exact:true}).click();
  await expect(dialog(page)).toContainText('Projeto atualizado sem telefone');
  const payload=(await saves(page)).at(-1).params.p_project;
  expect(Object.hasOwn(payload,'client_phone')).toBe(false);
  await page.reload();await expect(card(page)).toContainText('Projeto atualizado sem telefone');
});

test('the WhatsApp action and editor fit a 320px mobile viewport',async({page},info)=>{
  await page.setViewportSize({width:320,height:900});await setup(page);
  await expectWhatsApp(card(page),'5511987654321');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const linkBox=await whatsapp(card(page)).boundingBox();
  expect(linkBox.x).toBeGreaterThanOrEqual(0);expect(linkBox.x+linkBox.width).toBeLessThanOrEqual(320);
  await page.screenshot({path:info.outputPath('whatsapp-card-320.png'),fullPage:true});
  await edit(page);await expect(phoneInput(page)).toBeVisible();
  const inputBox=await phoneInput(page).boundingBox();
  expect(inputBox.x).toBeGreaterThanOrEqual(0);expect(inputBox.x+inputBox.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('whatsapp-editor-320.png'),fullPage:true});
});
