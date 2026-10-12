const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.setViewportSize({ width: 390, height: 844 });
});

async function navigate(page, module) {
  await page.locator('#ceoMenuBtn').click();
  await page.locator(`.nav [data-module="${module}"]`).click();
}

async function controlsStayVisible(page, height) {
  const dialog = page.getByRole('dialog');
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBe(0);
  expect(bounds.y).toBe(0);
  expect(bounds.width).toBe(390);
  expect(bounds.height).toBe(height);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Fechar', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator('[type="submit"]')).toBeInViewport({ ratio: 1 });
  const head = await dialog.locator('.mobile-form-header').boundingBox();
  const body = await dialog.locator('.mobile-form-fields').boundingBox();
  const foot = await dialog.locator('.mobile-form-actions').boundingBox();
  expect(body.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
  expect(body.y + body.height).toBeLessThanOrEqual(foot.y + 1);
  expect(body.height).toBeGreaterThan(100);
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).toBe('fixed');
}

const editors = [
  { id: 'finance', module: 'financeiro', button: 'Nova movimentação', title: 'Descrição', field: 'Observações', collection: 'financeiro', key: 'nome', amount: true },
  { id: 'investment', module: 'investimentos', button: 'Novo investimento', title: 'Nome', field: 'Observações', collection: 'investimentos', key: 'nome', amount: true },
  { id: 'idea', module: 'ideias', button: '+ Nova ideia', title: 'Título', field: 'Descrição', collection: 'ideias', key: 'titulo' },
  { id: 'agenda', module: 'agenda', button: '+ Nova tarefa', title: 'Título', field: 'Descrição', collection: 'agenda', key: 'nome' }
];

for (const editor of editors) {
  test(`mobile ${editor.id} editor stays full screen while scrolling, saving and retrying`, async ({ page }, info) => {
    await mock(page);
    await navigate(page, editor.module);
    await page.getByRole('button', { name: editor.button.replace(/^\+ /, '') }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveClass(/mobile-form-page/);
    await controlsStayVisible(page, 844);
    const name = `Cadastro mobile ${editor.id}`;
    await dialog.getByLabel(editor.title, { exact: true }).fill(name);
    if (editor.amount) await dialog.getByLabel('Valor (R$)', { exact: true }).fill('45,90');
    const description = dialog.getByLabel(editor.field, { exact: true });
    await description.fill('Dados preservados quando a conexão falha.');
    await page.screenshot({ path: info.outputPath(`${editor.id}-390x844.png`) });

    // A reduced viewport exercises the layout used while a phone keyboard is
    // open. Real iOS permission/keyboard behavior still needs device testing.
    await page.setViewportSize({ width: 390, height: 360 });
    await expect(dialog).toHaveCSS('height', '360px');
    await controlsStayVisible(page, 360);
    await description.focus();
    await expect(description).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`${editor.id}-short-focused.png`) });
    await page.evaluate(() => { window.testFailWrite = true; });
    await dialog.locator('[type="submit"]').click();
    const error = dialog.locator('[role="alert"]');
    await expect(error).toContainText('Não foi possível');
    await expect(error).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByLabel(editor.title, { exact: true })).toHaveValue(name);
    await controlsStayVisible(page, 360);
    await page.screenshot({ path: info.outputPath(`${editor.id}-failed-save.png`) });
    expect(await page.evaluate(({ collection, key, name }) => JSON.parse(localStorage.getItem('test-cloud')).data[collection].some(row => row[key] === name), { ...editor, name })).toBe(false);
    await page.evaluate(() => { window.testFailWrite = false; });
    await dialog.locator('[type="submit"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/mobile-form-open/);
    expect(await page.evaluate(() => getComputedStyle(document.body).position)).not.toBe('fixed');
    expect(await page.evaluate(({ collection, key, name }) => JSON.parse(localStorage.getItem('test-cloud')).data[collection].some(row => row[key] === name), { ...editor, name })).toBe(true);
  });
}

test('closing a phone editor restores the page scroll and resizing restores desktop layout', async ({ page }, info) => {
  const data = structuredClone(seed);
  data.financeiro.push(...Array.from({ length: 8 }, (_, index) => ({ id: `extra-${index}`, nome: `Movimentação ${index}`, tipo: 'Entrada', valor: 20, prazo: '2026-09-29', status: 'Pendente' })));
  await mock(page, data);
  await navigate(page, 'financeiro');
  const edit = page.getByRole('button', { name: 'Editar Movimentação 7', exact: true });
  await edit.scrollIntoViewIfNeeded();
  await edit.evaluate(el => el.addEventListener('click', () => { window.testEditorScroll = window.scrollY; }, { capture: true, once: true }));
  await edit.click();
  await controlsStayVisible(page, 844);
  const before = await page.evaluate(() => window.testEditorScroll);
  expect(before).toBeGreaterThan(100);
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  await edit.click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('html')).not.toHaveClass(/mobile-form-open/);
  const dialog = page.getByRole('dialog');
  expect((await dialog.boundingBox()).width).toBeLessThan(700);
  expect(await dialog.locator('.mobile-form-fields').evaluate(el => getComputedStyle(el).display)).toBe('contents');
  await page.screenshot({ path: info.outputPath('desktop-finance-editor.png') });
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('phone editor follows a panned visual viewport without hiding the focused field', async ({ page }, info) => {
  await mock(page);
  await navigate(page, 'financeiro');
  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Observações', { exact: true }).fill('Teclado aberto');
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 360 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 60 });
    visualViewport.dispatchEvent(new Event('resize'));
    visualViewport.dispatchEvent(new Event('scroll'));
  });
  await expect(dialog).toHaveCSS('height', '360px');
  await expect(dialog).toHaveCSS('top', '60px');
  const field = await dialog.getByLabel('Observações', { exact: true }).boundingBox();
  const body = await dialog.locator('.mobile-form-fields').boundingBox();
  expect(field.y).toBeGreaterThanOrEqual(body.y);
  expect(field.y + field.height).toBeLessThanOrEqual(body.y + body.height);
  const save = await dialog.locator('[type="submit"]').boundingBox();
  expect(save.y + save.height).toBeLessThanOrEqual(420);
  await page.screenshot({ path: info.outputPath('visual-viewport-offset.png') });
});
