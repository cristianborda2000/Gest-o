const {test,expect}=require('@playwright/test');
const {mock,seed}=require('./mock-supabase');
test('desktop overview and every existing module render without errors',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await mock(page);
  await expect(page.locator('#moduleTitle')).toHaveText('Visão geral');
  await expect(page.locator('.ceo-metrics')).toContainText('4.200,00');
  await expect(page.locator('.ceo-metrics')).toContainText('3.719,75');
  await page.screenshot({path:'test-results/overview-desktop.png',fullPage:true});
  for(const module of ['financeiro','investimentos','agenda','ideias']){
    await page.locator(`.nav [data-module="${module}"]`).click();
    await expect(page.locator('body')).toHaveAttribute('data-module',module);
    if (module === 'agenda') await page.screenshot({path:'test-results/agenda-desktop.png',fullPage:true});
  }
  expect(errors).toEqual([]);
});
test('mobile overview, calendar day expansion and ideas fit the viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});await mock(page);
  await expect(page.locator('.ceo-metrics')).toBeVisible();
  await page.screenshot({path:'test-results/overview-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.locator('#ceoMenuBtn').click();await page.locator('.nav [data-module="agenda"]').click();
  await page.locator('[data-date="2026-09-29"]').click();
  await expect(page.locator('.za-day-panel')).toContainText('Revisar o financeiro');
  await page.screenshot({path:'test-results/agenda-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.locator('#ceoMenuBtn').click();await page.locator('.nav [data-module="ideias"]').click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Automatizar cobrança');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('empty account has no illustrative records',async({page})=>{
  const empty={...seed,financeiro:[],agenda:[],ideias:[]};await mock(page,empty);
  await expect(page.locator('.ceo-metrics')).toContainText('R$ 0,00');
  await expect(page.locator('.ceo-today-overview')).toContainText('Seu dia está livre');
  await expect(page.locator('#ceoWorkspace')).not.toContainText('Projeto entregue');
});

test('loading errors offer retry without uploading the legacy cache',async({page})=>{
  await page.addInitScript(()=>{window.testFailRead=true;localStorage.setItem('admin-simples-v1',JSON.stringify({financeiro:[{id:'unowned'}]}));});
  await mock(page);
  await expect(page.locator('#ceoWorkspace')).toContainText('Não foi possível carregar seus dados');
  expect(await page.evaluate(()=>localStorage.getItem('test-version'))).toBeNull();
  await page.evaluate(()=>{window.testFailRead=false;});
  await page.getByRole('button',{name:'Tentar novamente'}).click();
  await expect(page.locator('.ceo-metrics')).toContainText('4.200,00');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('test-cloud')).data.financeiro.some(row=>row.id==='unowned'))).toBe(false);
});

test('a stale editor cannot overwrite a change saved in another tab',async({page,context})=>{
  await mock(page);
  const second=await context.newPage();await mock(second);
  for(const tab of [page,second]){
    await tab.locator('.nav [data-module="ideias"]').click();
    await tab.locator('[data-idea-id="idea"]').getByRole('button',{name:'Editar',exact:true}).click();
  }
  await page.locator('#ceoIdeaDialog [name="titulo"]').fill('Alteração mais recente');
  await page.locator('#ceoIdeaDialog').getByRole('button',{name:'Salvar ideia'}).click();
  await expect(page.locator('#ceoIdeaDialog')).toHaveCount(0);
  await second.locator('#ceoIdeaDialog [name="titulo"]').fill('Alteração obsoleta');
  await second.locator('#ceoIdeaDialog').getByRole('button',{name:'Salvar ideia'}).click();
  await expect(second.locator('#ceoIdeaDialog [role="alert"]')).toBeVisible();
  expect(await second.evaluate(()=>JSON.parse(localStorage.getItem('test-cloud')).data.ideias[0].titulo)).toBe('Alteração mais recente');
  await second.reload();await second.locator('.nav [data-module="ideias"]').click();
  await expect(second.locator('[data-idea-id="idea"]')).toContainText('Alteração mais recente');
});

test('overview task completion and the period selector update the real state',async({page})=>{
  await mock(page);
  await page.locator('[data-overview-complete="0"]').check();
  await expect(page.locator('[data-overview-complete="0"]')).toBeChecked();
  await page.reload();await expect(page.locator('[data-overview-complete="0"]')).toBeChecked();
  await page.locator('#overviewMonth').fill('2026-08');await page.locator('#overviewMonth').press('Tab');
  await expect(page.locator('.ceo-metrics')).not.toContainText('4.200,00');
  await expect(page.locator('.ceo-metrics')).toContainText('R$ 0,00');
});

test('tablet workspace keeps the calendar and all main modules within the viewport',async({page})=>{
  await page.setViewportSize({width:1024,height:768});await mock(page);
  for(const module of ['dashboard','financeiro','investimentos','agenda','ideias']){
    await page.locator(`.nav [data-module="${module}"]`).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  }
  await page.locator('.nav [data-module="agenda"]').click();
  await page.screenshot({path:'test-results/agenda-tablet.png',fullPage:true});
});
