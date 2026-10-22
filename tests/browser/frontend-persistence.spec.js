const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});

test('company form preserves the saved state and its draft while another change is being saved', async ({ page }) => {
  await mock(page);
  await page.locator('#settingsBtn').click();
  await page.evaluate(() => {
    window.testDelayNextWrite = true;
    window.testBackgroundCommit = ceoCommit(draft => { draft.agenda[0].nome = 'Tarefa atualizada'; });
  });
  await expect.poll(() => page.evaluate(() => window.testPendingWrites.length)).toBe(1);
  const name = page.locator('#companyForm').getByLabel('Nome da empresa', { exact: true });
  await name.fill('Nome ainda não salvo');
  await page.getByRole('button', { name: 'Salvar dados da empresa' }).click();
  expect(await page.evaluate(() => state.companyProfile.nome)).toBe(seed.companyProfile.nome);
  await expect(name).toHaveValue('Nome ainda não salvo');
  await page.evaluate(() => window.testReleaseWrites());
  expect(await page.evaluate(() => window.testBackgroundCommit)).toBe(true);
  await expect(name).toHaveValue('Nome ainda não salvo');
  await page.getByRole('button', { name: 'Salvar dados da empresa' }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.companyProfile.nome)).toBe('Nome ainda não salvo');
});

test('an earlier agenda save does not close the next task draft', async ({ page }) => {
  await mock(page);
  await page.locator('.nav [data-module="agenda"]').click();
  await page.locator('.za-header [data-action="new"]').click();
  let dialog = page.locator('dialog.za-dialog');
  await dialog.getByLabel('Título', { exact: true }).fill('Primeira tarefa');
  await page.evaluate(() => { window.testDelayNextWrite = true; });
  await dialog.getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect.poll(() => page.evaluate(() => window.testPendingWrites.length)).toBe(1);
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await page.locator('.za-header [data-action="new"]').click();
  dialog = page.locator('dialog.za-dialog');
  await dialog.getByLabel('Título', { exact: true }).fill('Próxima tarefa em rascunho');
  await page.evaluate(() => window.testReleaseWrites());
  await expect.poll(() => page.evaluate(() => cloudWritePending)).toBe(false);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Título', { exact: true })).toHaveValue('Próxima tarefa em rascunho');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.agenda.map(task => task.nome))).toContain('Primeira tarefa');
  await dialog.getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.locator('.nav [data-module="agenda"]').click();
  await expect(page.locator('.za-task-title').getByText('Primeira tarefa', { exact: true })).toBeVisible();
  await expect(page.locator('.za-task-title').getByText('Próxima tarefa em rascunho', { exact: true })).toBeVisible();
});
