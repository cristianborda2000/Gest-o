const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

const agendaNav = page => page.locator('.nav [data-module="agenda"]').click();
const taskCard = (page, title) => page.locator('.za-task').filter({ has: page.locator('.za-task-title strong', { hasText: title }) });
const dialog = page => page.locator('dialog.za-dialog');

test('agenda preserves a custom lead saved by Jarvis when editing and reloading', async ({ page }) => {
  await mock(page, { ...seed, agenda: [{ id: 'jarvis-reminder', nome: 'Reunião', prazo: '2026-09-29', hora: '10:00', duracao: 30, status: 'Pendente', prioridade: 'Média', recorrencia: 'none', reminderMinutes: 20, jarvisActionId: 'test-action' }] });
  await agendaNav(page);
  await expect(taskCard(page, 'Reunião').locator('.za-task-reminder')).toContainText('09:40');
  await taskCard(page, 'Reunião').getByRole('button', { name: 'Editar' }).click();
  await expect(dialog(page).getByLabel('Lembrete', { exact: true })).toHaveValue('20');
  await dialog(page).getByLabel('Título', { exact: true }).fill('Reunião revisada');
  await dialog(page).getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.reload(); await agendaNav(page);
  await expect(taskCard(page, 'Reunião revisada').locator('.za-task-reminder')).toContainText('09:40');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.agenda[0].reminderMinutes)).toBe(20);
});
async function addTask(page, values = {}) {
  await page.locator('.za-header [data-action="new"]').click();
  const form = dialog(page);
  await form.locator('[name="nome"]').fill(values.nome || 'Rotina do CEO');
  await form.locator('[name="prazo"]').fill(values.prazo || '2026-09-29');
  await form.locator('[name="hora"]').fill(values.hora || '09:00');
  if (values.recorrencia) await form.locator('[name="recorrencia"]').selectOption(values.recorrencia);
  await form.getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect(dialog(page)).toHaveCount(0);
}

test('agenda selects days, persists CRUD, and scopes recurring edits and completion', async ({ page }) => {
  await mock(page);
  await agendaNav(page);
  await addTask(page, { recorrencia: 'weekly' });
  await expect(taskCard(page, 'Rotina do CEO')).toBeVisible();
  await page.locator('[data-date="2026-09-30"]').click();
  await expect(taskCard(page, 'Rotina do CEO')).toHaveCount(0);
  await page.locator('[data-date="2026-09-29"]').click();
  await taskCard(page, 'Rotina do CEO').getByRole('button', { name: 'Editar' }).click();
  await expect(dialog(page).locator('[name="scope"]')).toHaveValue('occurrence');
  await dialog(page).locator('[name="nome"]').fill('Rotina excepcional');
  await dialog(page).locator('[name="prazo"]').fill('2026-09-30');
  await dialog(page).locator('[name="hora"]').fill('10:00');
  await dialog(page).getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect(taskCard(page, 'Rotina excepcional')).toContainText('10:00');
  await page.locator('[data-date="2026-09-29"]').click();
  await expect(taskCard(page, 'Rotina do CEO')).toHaveCount(0);
  await page.getByRole('button', { name: 'Próximo mês', exact: true }).click();
  await page.locator('[data-date="2026-10-06"]').click();
  await expect(taskCard(page, 'Rotina do CEO')).toContainText('09:00');
  await taskCard(page, 'Rotina do CEO').getByRole('checkbox').check();
  await expect(taskCard(page, 'Rotina do CEO')).toContainText('Concluída');
  await page.reload();
  await agendaNav(page);
  await page.getByRole('button', { name: 'Próximo mês', exact: true }).click();
  await page.locator('[data-date="2026-10-06"]').click();
  await expect(taskCard(page, 'Rotina do CEO').getByRole('checkbox')).toBeChecked();
  await page.locator('[data-date="2026-10-13"]').click();
  await expect(taskCard(page, 'Rotina do CEO').getByRole('checkbox')).not.toBeChecked();
  await taskCard(page, 'Rotina do CEO').getByRole('button', { name: 'Excluir' }).click();
  await expect(dialog(page).locator('[name="scope"]')).toHaveValue('occurrence');
  await dialog(page).getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(taskCard(page, 'Rotina do CEO')).toHaveCount(0);
  await page.locator('[data-date="2026-10-20"]').click();
  await expect(taskCard(page, 'Rotina do CEO')).toBeVisible();
  await taskCard(page, 'Rotina do CEO').getByRole('button', { name: 'Excluir' }).click();
  await dialog(page).locator('[name="scope"]').selectOption('series');
  await dialog(page).getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(taskCard(page, 'Rotina do CEO')).toHaveCount(0);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.agenda);
  expect(persisted).toHaveLength(1);
  expect(persisted[0].id).toBe('task');
});

test('agenda retains the form on persistence error and saves successfully after retry', async ({ page }) => {
  await mock(page);
  await agendaNav(page);
  await page.locator('.za-header [data-action="new"]').click();
  await dialog(page).locator('[name="nome"]').fill('Não perder esta tarefa');
  await page.evaluate(() => { window.testFailWrite = true; });
  await dialog(page).getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect(dialog(page).locator('[data-error]')).toContainText('Não foi possível salvar');
  await expect(dialog(page).locator('[name="nome"]')).toHaveValue('Não perder esta tarefa');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.agenda.length)).toBe(1);
  await page.evaluate(() => { window.testFailWrite = false; });
  await dialog(page).getByRole('button', { name: 'Salvar tarefa' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(taskCard(page, 'Não perder esta tarefa')).toBeVisible();
  await page.reload();
  await agendaNav(page);
  await expect(taskCard(page, 'Não perder esta tarefa')).toBeVisible();
});

test('notifications request permission only on explicit activation and deduplicate after reload', async ({ page }) => {
  await page.addInitScript(() => {
    window.Notification = class Notification {
      constructor(title, options) {
        const items = JSON.parse(localStorage.getItem('test-notifications') || '[]');
        items.push({ title, ...options });
        localStorage.setItem('test-notifications', JSON.stringify(items));
      }
      close() {}
      static get permission() { return localStorage.getItem('test-permission') || 'default'; }
      static async requestPermission() {
        localStorage.setItem('test-permission-requests', String(Number(localStorage.getItem('test-permission-requests') || 0) + 1));
        localStorage.setItem('test-permission', 'granted');
        return 'granted';
      }
    };
  });
  await mock(page, { ...seed, agenda: [{ id: 'soon', nome: 'Tarefa próxima', prazo: '2026-09-29', hora: '12:15', duracao: 30, status: 'Pendente' }] });
  expect(await page.evaluate(() => localStorage.getItem('test-permission-requests'))).toBeNull();
  await agendaNav(page);
  await page.getByRole('button', { name: 'Configurar', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('test-permission-requests'))).toBeNull();
  await dialog(page).locator('[name="enabled"]').check();
  await dialog(page).getByRole('button', { name: 'Salvar preferências' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-permission-requests'))).toBe('1');
  await page.clock.fastForward(20000);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-notifications') || '[]').length)).toBe(1);
  await page.clock.fastForward(20000);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-notifications')).length)).toBe(1);
  await page.reload();
  await expect(page.locator('#ceoWorkspace')).toBeVisible();
  await page.clock.fastForward(20000);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-notifications')).length)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('test-permission-requests'))).toBe('1');
});

test('agenda mobile expands the chosen day and task editor fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.locator('#ceoMenuBtn').click();
  await agendaNav(page);
  await page.locator('[data-date="2026-09-30"]').click();
  await expect(page.locator('.za-selected-title')).toContainText('30 de setembro');
  await expect(page.locator('.za-day-panel')).toContainText('Seu dia está livre');
  await page.locator('.za-add-day').click();
  await expect(dialog(page).locator('[name="prazo"]')).toHaveValue('2026-09-30');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await dialog(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/agenda-editor-mobile.png', fullPage: true });
  await dialog(page).getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
});
