const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});
const companyOptions = { workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Empresa com nome longo para testar a navegação no celular' }] } };
async function navigate(page, module) {
  await page.locator('#ceoMenuBtn').click();
  await page.locator(`.nav [data-module="${module}"]`).click();
  await expect(page.locator('#ceoMenuBtn')).toHaveAttribute('aria-expanded', 'false');
}
async function withinViewport(locator, width) {
  const bounds = await locator.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
}

for (const width of [320, 390, 430]) {
  test(`mobile header and menu stay readable and usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 700 });
    await mock(page, seed, companyOptions);
    const title = page.locator('#moduleTitle');
    await expect(title).toHaveText('Visão geral');
    expect((await title.boundingBox()).width).toBeGreaterThanOrEqual(180);
    expect((await title.boundingBox()).height).toBeLessThan(40);
    await withinViewport(page.locator('#workspaceBadge'), width);
    await page.screenshot({ path: info.outputPath('overview.png') });

    await page.locator('#ceoMenuBtn').click();
    await expect(page.locator('#ceoMenuCloseBtn')).toBeFocused();
    expect(await page.locator('.main').evaluate(el => el.inert)).toBe(true);
    await withinViewport(page.locator('#ceoSidebar'), width);
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.nav [data-module="ideias"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#ceoMenuCloseBtn')).toBeFocused();
    await page.screenshot({ path: info.outputPath('menu.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('#ceoMenuBtn')).toBeFocused();
    expect(await page.locator('.main').evaluate(el => el.inert)).toBe(false);
    await page.locator('#ceoMenuBtn').click();
    await page.locator('#ceoMenuBackdrop').click({ position: { x: width - 8, y: 150 } });
    await expect(page.locator('#ceoMenuBackdrop')).not.toBeVisible();
    for (const module of ['financeiro', 'investimentos', 'agenda', 'ideias']) {
      await navigate(page, module);
      await withinViewport(title, width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.locator('#ceoMenuBtn').click();
    await page.setViewportSize({ width: 1024, height: 768 });
    expect(await page.locator('.main').evaluate(el => el.inert)).toBe(false);
    await expect(page.locator('#ceoMenuBackdrop')).not.toBeVisible();
  });
}

test('mobile finance exposes readable cards, dates and actions without sideways scrolling', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const data = structuredClone(seed);
  data.financeiro[0].nome = 'Descrição longa de uma receita que deve continuar legível no celular';
  data.gastosFixos = [{ id: 'fixed', nome: 'Assinatura de ferramentas e serviços da empresa', valor: -125.5, dia: 5, status: 'Ativo' }];
  await mock(page, data, companyOptions); await navigate(page, 'financeiro');
  const table = page.locator('.ceo-finance-table');
  expect(await table.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const row = table.locator('tbody tr').filter({ hasText: data.financeiro[0].nome });
  await withinViewport(row, 320);
  expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const button of await row.locator('button').all()) {
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await withinViewport(button, 320);
  }
  expect((await page.locator('[data-filter="from"]').boundingBox()).width).toBeGreaterThan(200);
  await page.screenshot({ path: info.outputPath('finance.png'), fullPage: true });
  await row.getByRole('button', { name: `Editar ${data.financeiro[0].nome}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  expect(await dialog.getByLabel('Descrição', { exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await page.setViewportSize({ width: 320, height: 360 });
  const save = dialog.getByRole('button', { name: 'Salvar movimentação' });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Gastos fixos', exact: true }).click();
  await expect(page.locator('.ceo-fixed-table')).toContainText('Assinatura de ferramentas');
  expect(await page.locator('.ceo-fixed-table').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('fixed-expenses.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(await page.locator('.ceo-fixed-table tr').last().evaluate(el => getComputedStyle(el).display)).toBe('table-row');
});

test('mobile agenda exposes touch controls and task form in a short viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mock(page); await navigate(page, 'agenda');
  for (const name of ['Mês anterior', 'Próximo mês', 'Hoje']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.locator('[data-date="2026-09-29"]').click();
  const selected = page.locator('.za-day-panel');
  await expect(selected).toContainText('Revisar o financeiro');
  expect((await selected.getByRole('button', { name: 'Editar', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
  await selected.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 360 });
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const fields = await dialog.locator('input:not([type=checkbox]), select, textarea').evaluateAll(els => els.map(el => parseFloat(getComputedStyle(el).fontSize)));
  expect(fields.every(size => size >= 16)).toBe(true);
  const save = dialog.getByRole('button', { name: 'Salvar tarefa' });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await page.screenshot({ path: info.outputPath('agenda-editor.png') });
});
