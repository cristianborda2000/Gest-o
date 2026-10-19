const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

const stages = ['planning', 'in_progress', 'waiting', 'completed'];
const projects = stages.map((status, index) => ({
  id: `${index + 1}1111111-1111-4111-8111-111111111111`, title: ['Campanha Aurora', 'Catálogo de produtos', 'Site da cafeteria', 'Identidade visual'][index],
  client_name: 'Cliente de teste', company_name: 'Estúdio Aurora', responsible_name: 'Ana', status,
  due_date: '2026-10-20', revision: 1, updated_at: '2026-09-28T15:00:00Z',
  production_lists: [{ id: 'production', title: 'Produção', steps: [{ id: 'brief', label: 'Conferir briefing', done: false }, { id: 'deliver', label: 'Enviar apresentação', done: true }] }]
}));
const card = (page, index = 0) => page.locator(`[data-project-id="${projects[index].id}"]`);
const toggle = (page, index = 0) => card(page, index).locator('[data-project-toggle]');
const panel = (page, index = 0) => card(page, index).locator('[data-project-details]');
async function setup(page) {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await mock(page, seed, { workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Minha empresa' }] }, projects: { 'test-account': projects } });
  await page.locator('.nav [data-module="projetos"]').click();
  await expect(card(page)).toBeVisible();
}

test('cards start collapsed and independently expose their controls using mouse or keyboard', async ({ page }) => {
  await setup(page);
  for (let index = 0; index < projects.length; index++) {
    await expect(toggle(page, index)).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page, index)).toBeHidden();
    await expect(card(page, index).getByRole('button', { name: `Abrir projeto ${projects[index].title}`, exact: true })).toBeVisible();
  }
  await toggle(page).focus();
  await toggle(page).press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute('aria-controls', await panel(page).getAttribute('id'));
  await expect(card(page).getByRole('checkbox', { name: 'Concluir etapa: Conferir briefing', exact: true })).toBeVisible();
  await toggle(page, 1).click();
  await toggle(page).press('Space');
  await expect(panel(page)).toBeHidden();
  await expect(panel(page, 1)).toBeVisible();
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => /_save$|_step_set$|_status_set$/.test(call.name)))).toEqual([]);
});

test('an expanded card stays open through saving, filtering and refresh, and resets on module exit', async ({ page }) => {
  await setup(page);
  await toggle(page).click();
  await card(page).getByRole('checkbox', { name: 'Concluir etapa: Conferir briefing', exact: true }).check();
  await expect(card(page)).toHaveAttribute('aria-busy', 'false');
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(card(page).locator('.ceo-project-total')).toHaveText('2/2 etapas');
  await page.getByRole('searchbox', { name: 'Pesquisar projetos' }).fill('Catálogo');
  await expect(card(page)).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Pesquisar projetos' }).fill('');
  await expect(panel(page)).toBeVisible();
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Atualizar', exact: true })).toBeEnabled();
  await expect(panel(page)).toBeVisible();
  await expect(card(page).getByRole('checkbox', { name: 'Concluir etapa: Conferir briefing', exact: true })).toBeChecked();
  await page.locator('.nav [data-module="agenda"]').click();
  await page.locator('.nav [data-module="projetos"]').click();
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  await toggle(page).click();
  await expect(card(page).getByRole('checkbox', { name: 'Concluir etapa: Conferir briefing', exact: true })).toBeChecked();
});

test('pastel stages stay labeled and follow status changes without closing the card', async ({ page }, info) => {
  await setup(page);
  const colors = [];
  for (let index = 0; index < projects.length; index++) {
    colors.push(await card(page, index).locator('.ceo-project-status').evaluate(node => getComputedStyle(node).backgroundColor));
    await expect(card(page, index).locator('.ceo-project-status')).not.toBeEmpty();
  }
  expect(new Set(colors).size).toBe(4);
  await page.locator('.ceo-project-board').screenshot({ path: info.outputPath('pastel-board-collapsed.png') });
  await toggle(page).click();
  await card(page).getByLabel('Situação de Campanha Aurora', { exact: true }).selectOption('completed');
  await expect(card(page)).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-project-column="completed"]')).toContainText('Campanha Aurora');
  await expect(panel(page)).toBeVisible();
  await expect(card(page).locator('.ceo-project-status')).toHaveCSS('background-color', colors[3]);
  await expect(card(page).getByRole('checkbox', { name: 'Concluir etapa: Conferir briefing', exact: true })).not.toBeChecked();
  await page.locator('.ceo-project-board').screenshot({ path: info.outputPath('pastel-board-expanded.png') });
  await page.reload();
  await page.locator('.nav [data-module="projetos"]').click();
  await expect(card(page)).toHaveAttribute('data-project-status', 'completed');
  await expect(panel(page)).toBeHidden();
});
