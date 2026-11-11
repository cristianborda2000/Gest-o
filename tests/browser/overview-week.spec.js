const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.abort());
});

const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const day = (page, date) => page.locator(`[data-overview-date="${date}"]`);
const sample = () => ({
  ...seed,
  agenda: [
    { id: 'routine', nome: 'Rotina diária', prazo: '2026-09-21', hora: '09:00', recorrencia: 'daily', status: 'Pendente', exceptions: {
      '2026-09-28': { deleted: true },
      '2026-09-29': { nome: 'Reunião transferida', prazo: '2026-10-01', hora: '10:00' },
      '2026-10-02': { status: 'Concluída' }
    } },
    { id: 'outside', nome: 'Semana seguinte', prazo: '2026-10-05', status: 'Pendente' },
    { id: 'cancelled', nome: 'Reunião cancelada', prazo: '2026-09-30', status: 'Cancelada' }
  ]
});

test('overview shows this Monday–Sunday across month boundaries, occurrences and exceptions', async ({ page }) => {
  await mock(page, sample());
  await expect(page.locator('[data-overview-date]')).toHaveCount(7);
  expect(await page.locator('[data-overview-date]').evaluateAll(nodes => nodes.map(node => node.dataset.overviewDate))).toEqual(dates);
  await expect(day(page, '2026-09-29')).toHaveClass(/is-today/);
  await expect(day(page, '2026-09-28')).toContainText('Sem tarefas');
  await expect(day(page, '2026-09-29')).toContainText('Sem tarefas');
  await expect(day(page, '2026-10-01').locator('.ceo-week-task')).toHaveCount(2);
  await expect(day(page, '2026-10-01')).toContainText('Reunião transferida');
  await expect(day(page, '2026-10-02').getByRole('checkbox')).toBeChecked();
  await expect(day(page, '2026-09-30').getByRole('checkbox', { name: 'Concluir Reunião cancelada' })).toBeDisabled();
  await expect(page.locator('.ceo-week-summary')).toHaveText('5 pendentes · 1 concluída · 1 cancelada');
  await expect(page.locator('.ceo-week-overview')).not.toContainText('Semana seguinte');
  await page.locator('#overviewMonth').fill('2025-01');
  await page.locator('#overviewMonth').press('Tab');
  expect(await page.locator('[data-overview-date]').evaluateAll(nodes => nodes.map(node => node.dataset.overviewDate))).toEqual(dates);
});

test('overview edits and completes only the selected recurring occurrence and persists it', async ({ page }) => {
  await mock(page, sample());
  await day(page, '2026-10-01').getByRole('checkbox', { name: /^(Concluir|Reabrir) Reunião transferida$/ }).check();
  await expect(day(page, '2026-10-01').getByRole('checkbox', { name: 'Reabrir Reunião transferida' })).toBeChecked();
  await expect(day(page, '2026-10-01').getByRole('checkbox', { name: 'Concluir Rotina diária' })).not.toBeChecked();
  await day(page, '2026-10-01').getByRole('button', { name: 'Editar Reunião transferida em 01/10' }).click();
  const dialog = page.locator('dialog.za-dialog');
  await expect(dialog.locator('[name="scope"]')).toHaveValue('occurrence');
  await dialog.locator('[name="nome"]').fill('Reunião revisada');
  await dialog.getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(day(page, '2026-10-01').getByRole('checkbox', { name: 'Reabrir Reunião revisada' })).toBeChecked();
  await expect(day(page, '2026-10-03')).toContainText('Rotina diária');
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.agenda.find(row => row.id === 'routine'));
  expect(persisted.status).toBe('Pendente');
  expect(persisted.exceptions['2026-09-29']).toMatchObject({ nome: 'Reunião revisada', prazo: '2026-10-01', status: 'Concluído' });
});

test('overview follows São Paulo Sunday and Monday even when UTC date is already Monday', async ({ page }) => {
  await mock(page, { ...seed, agenda: [] });
  await page.clock.setFixedTime(new Date('2026-10-05T01:00:00Z'));
  await page.reload();
  await expect(page.locator('.ceo-week-day.is-today')).toHaveAttribute('data-overview-date', '2026-10-04');
  await expect(page.locator('[data-overview-date]').first()).toHaveAttribute('data-overview-date', '2026-09-28');
  await page.clock.setFixedTime(new Date('2026-10-05T03:01:00Z'));
  await page.reload();
  await expect(page.locator('[data-overview-date]').first()).toHaveAttribute('data-overview-date', '2026-10-05');
  await expect(page.locator('[data-overview-date]').last()).toHaveAttribute('data-overview-date', '2026-10-11');
  await expect(page.locator('.ceo-week-empty')).toContainText('Sua semana está livre');
  await page.getByRole('button', { name: '+ Tarefa', exact: true }).click();
  await expect(page.locator('dialog.za-dialog [name="prazo"]')).toHaveValue('2026-10-05');
});

test('mobile prioritizes today, expands the week on demand and keeps the desktop overview', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = sample();
  data.agenda.push({ id: 'long', nome: 'Organizar os compromissos da empresa e conferir os pagamentos programados desta semana', prazo: '2026-09-29', status: 'Pendente' });
  await mock(page, data);
  await expect(page.locator('.ceo-overview-layout > :first-child')).toHaveClass(/ceo-week-overview/);
  await expect(page.locator('.ceo-today-heading').first()).toHaveText('Hoje');
  await expect(page.locator('[data-today-task]')).toHaveCount(1);
  await expect(page.locator('#overviewWeekContent')).not.toBeVisible();
  await expect(page.locator('[data-overview-week]')).toHaveAttribute('aria-expanded', 'false');
  const week = await page.locator('.ceo-week-overview').boundingBox();
  const metrics = await page.locator('.ceo-metrics').boundingBox();
  expect(week.y).toBeLessThan(metrics.y);
  expect(week.y).toBeLessThan(300);
  expect(metrics.y).toBeLessThan(650);
  const dock = await page.locator('.mobile-tabbar').boundingBox();
  expect(metrics.y + metrics.height).toBeLessThanOrEqual(dock.y);
  await expect(page.locator('#overviewChart')).not.toBeVisible();
  await page.locator('[data-overview-chart]').click();
  await expect(page.locator('#overviewChart')).toBeVisible();
  await page.locator('[data-overview-chart]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('overview-today-mobile.png'), fullPage: true });
  await page.screenshot({ path: testInfo.outputPath('overview-today-phone.png') });
  await page.locator('[data-overview-week]').click();
  await expect(page.locator('#overviewWeekContent')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tarefas da semana', exact: true })).toBeVisible();
  await expect(page.locator('.ceo-today-focus')).not.toBeVisible();
  await expect(day(page, '2026-10-01')).toContainText('Reunião transferida');
  await page.locator('[data-overview-week]').click();
  await expect(page.locator('[data-overview-week]')).toBeFocused();
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('#overviewWeekContent')).toBeVisible();
  await expect(page.locator('#overviewChart')).toBeVisible();
  await expect(page.locator('.ceo-today-focus')).not.toBeVisible();
  const desktopWeek = await page.locator('.ceo-week-overview').boundingBox();
  const desktopFinancial = await page.locator('.ceo-financial-overview').boundingBox();
  expect(desktopWeek.y).toBe(desktopFinancial.y);
  expect(desktopWeek.x).toBeGreaterThan(desktopFinancial.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('overview-week-desktop.png'), fullPage: true });
});

test('today actions preserve recurring occurrences and only show three pending tasks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, { ...seed, agenda: [
    { id: 'recurring', nome: 'Rotina de hoje', prazo: '2026-09-28', hora: '08:00', recorrencia: 'daily', status: 'Pendente' },
    ...Array.from({ length: 4 }, (_, index) => ({ id: `task-${index}`, nome: `Compromisso ${index}`, prazo: '2026-09-29', hora: `${10 + index}:00`, status: 'Pendente' })),
    { id: 'cancelled', nome: 'Cancelada hoje', prazo: '2026-09-29', status: 'Cancelada' }
  ] });
  await expect(page.locator('[data-today-task]')).toHaveCount(3);
  await expect(page.locator('.ceo-today-summary')).toHaveText('5 tarefas pendentes');
  // Completion removes the row from today's pending list, so assert the result
  // instead of asking Playwright to re-check a control that no longer exists.
  await page.locator('.ceo-today-focus').getByRole('checkbox', { name: 'Concluir Rotina de hoje', exact: true }).click();
  await expect(page.locator('.ceo-today-summary')).toHaveText('4 tarefas pendentes · 1 concluída');
  await page.reload();
  await expect(page.locator('.ceo-today-summary')).toHaveText('4 tarefas pendentes · 1 concluída');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.agenda.find(row => row.id === 'recurring'));
  expect(saved.status).toBe('Pendente');
  expect(saved.exceptions['2026-09-29'].status).toBe('Concluído');
  await page.locator('[data-today-task]').first().click();
  await expect(page.locator('dialog.za-dialog [name="nome"]')).toHaveValue('Compromisso 0');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ver todas as 4 tarefas de hoje' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-module', 'agenda');
  await expect(page.locator('.za-day-panel')).toContainText('Compromisso 3');
});

test('a failed completion keeps today pending and allows retry without a false checkmark', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.evaluate(() => { window.testFailWrite = true; });
  const task = page.locator('[data-today-complete]').first();
  await task.click();
  await expect(page.locator('#ceoSync')).toHaveClass(/error/);
  await expect(task).not.toBeChecked();
  await expect(task).toBeEnabled();
  await expect(page.locator('.ceo-today-summary')).toHaveText('1 tarefa pendente');
  await page.evaluate(() => { window.testFailWrite = false; });
  await task.click();
  await expect(page.locator('.ceo-today-summary')).toHaveText('0 tarefas pendentes · 1 concluída');
});
