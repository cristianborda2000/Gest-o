const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

async function openIdeas(page, data = seed) {
  await mock(page, data);
  await expect(page.locator('.ceo-metrics')).toBeVisible();
  await page.locator('.nav [data-module="ideias"]').click();
  await expect(page.locator('.ceo-ideas-board')).toBeVisible();
}

const cloudData = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data);

test('ideas can be captured, edited, searched, filtered, moved, archived and restored', async ({ page }) => {
  await openIdeas(page);
  await page.getByRole('button', { name: '+ Nova ideia', exact: true }).click();
  const dialog = page.locator('#ceoIdeaDialog');
  await dialog.getByLabel('Título', { exact: true }).fill('Lançar tutoriais em vídeo');
  await dialog.getByLabel('Descrição', { exact: true }).fill('Gravar as dúvidas mais frequentes dos clientes.');
  await dialog.getByLabel('Categoria', { exact: true }).fill('Conteúdo');
  await dialog.getByLabel('Prioridade', { exact: true }).selectOption('Baixa');
  await dialog.getByLabel('Data', { exact: true }).fill('2026-09-30');
  await dialog.getByRole('button', { name: 'Salvar ideia', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  let card = page.locator('.ceo-idea-card').filter({ hasText: 'Lançar tutoriais em vídeo' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('30/09/2026');

  await page.locator('[data-idea-filter="search"]').fill('tutoriais em video');
  await expect(page.locator('.ceo-idea-card')).toHaveCount(1);
  await page.locator('[data-idea-filter="category"]').selectOption('Conteúdo');
  await page.locator('[data-idea-filter="priority"]').selectOption('Alta');
  await expect(page.locator('.ceo-idea-card')).toHaveCount(0);
  await page.locator('[data-idea-filter="priority"]').selectOption('Baixa');
  await expect(page.locator('.ceo-idea-card')).toHaveCount(1);
  await card.getByRole('button', { name: 'Editar', exact: true }).click();
  await dialog.getByLabel('Título', { exact: true }).fill('Lançar tutoriais em vídeo para clientes');
  await dialog.getByLabel('Categoria', { exact: true }).fill('Educação');
  await dialog.getByLabel('Descrição', { exact: true }).fill('Gravar três vídeos para o primeiro acesso.');
  await dialog.getByRole('button', { name: 'Salvar ideia', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // Renaming the last category clears its now-invalid filter instead of hiding the row.
  await expect(page.locator('[data-idea-filter="category"]')).toHaveValue('');
  card = page.locator('.ceo-idea-card').filter({ hasText: 'Lançar tutoriais em vídeo para clientes' });
  await expect(card).toContainText('Gravar três vídeos');
  await card.locator('[data-idea-move]').selectOption('avaliacao');
  await expect(card.locator('[data-idea-move]')).toHaveValue('avaliacao');
  await page.locator('[data-idea-filter="stage"]').selectOption('avaliacao');
  await expect(page.locator('.ceo-idea-card')).toHaveCount(1);

  await card.getByRole('button', { name: 'Arquivar', exact: true }).click();
  await expect(page.locator('.ceo-idea-card')).toHaveCount(0);
  await page.locator('[data-idea-filter="archived"]').selectOption('archived');
  await expect(card).toContainText('Arquivada');
  await card.getByRole('button', { name: 'Restaurar', exact: true }).click();
  await expect(page.locator('.ceo-idea-card')).toHaveCount(0);
  await page.locator('[data-idea-filter="archived"]').selectOption('active');
  await expect(card).toBeVisible();

  const stored = await cloudData(page);
  const saved = stored.ideias.find((idea) => idea.titulo === 'Lançar tutoriais em vídeo para clientes');
  expect(saved).toMatchObject({ categoria: 'Educação', prioridade: 'Baixa', etapa: 'avaliacao', arquivada: false, data: '2026-09-30' });
  expect(stored.ideias).toHaveLength(2);
  await page.reload();
  await expect(page.locator('.ceo-metrics')).toBeVisible();
  await page.locator('.nav [data-module="ideias"]').click();
  await expect(page.locator('.ceo-idea-card').filter({ hasText: saved.titulo })).toContainText('Gravar três vídeos');
});

test('idea conversion saves one agenda task with stable links after reload and archive', async ({ page }) => {
  await openIdeas(page);
  const card = page.locator('[data-idea-id="idea"]');
  await card.getByRole('button', { name: 'Criar tarefa', exact: true }).click();
  const dialog = page.locator('#ceoIdeaDialog');
  await dialog.getByLabel('Data da tarefa', { exact: true }).fill('2026-10-02');
  await dialog.getByLabel('Horário', { exact: true }).fill('15:30');
  await dialog.getByLabel('Duração em minutos', { exact: true }).fill('45');
  await dialog.getByRole('button', { name: 'Criar tarefa', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(card).toContainText('Tarefa vinculada · 02/10/2026 às 15:30');
  await expect(card.locator('[data-idea-move]')).toHaveValue('execucao');
  await expect(card.getByRole('button', { name: 'Criar tarefa', exact: true })).toHaveCount(0);
  let data = await cloudData(page);
  const task = data.agenda.find((row) => row.ideaId === 'idea');
  expect(task).toMatchObject({ prazo: '2026-10-02', hora: '15:30', duracao: 45, prioridade: 'Alta', status: 'Pendente' });
  expect(data.ideias.find((row) => row.id === 'idea').taskId).toBe(task.id);
  expect(data.agenda.filter((row) => row.ideaId === 'idea')).toHaveLength(1);

  await page.reload();
  await expect(page.locator('.ceo-metrics')).toBeVisible();
  await page.locator('.nav [data-module="ideias"]').click();
  await expect(card).toContainText('Tarefa vinculada');
  await expect(card.getByRole('button', { name: 'Criar tarefa', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Arquivar', exact: true }).click();
  await page.locator('[data-idea-filter="archived"]').selectOption('archived');
  await card.getByRole('button', { name: 'Restaurar', exact: true }).click();
  await page.locator('[data-idea-filter="archived"]').selectOption('active');
  await expect(card).toContainText('Tarefa vinculada');
  data = await cloudData(page);
  expect(data.agenda.filter((row) => row.ideaId === 'idea')).toHaveLength(1);
  expect(data.ideias.find((row) => row.id === 'idea').taskId).toBe(task.id);
  expect(data.agenda.find((row) => row.id === task.id).ideaId).toBe('idea');
  await page.locator('.nav [data-module="agenda"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-module', 'agenda');
});

test('failed idea writes keep the saved record and allow retry without duplicate records', async ({ page }) => {
  await openIdeas(page);
  await page.evaluate(() => { window.testFailWrite = true; });
  const card = page.locator('[data-idea-id="idea"]');
  await card.locator('[data-idea-move]').selectOption('concluida');
  await expect(card.locator('[data-idea-move]')).toHaveValue('avaliacao');
  await expect(card.locator('[data-idea-move]')).toBeEnabled();
  await card.getByRole('button', { name: 'Arquivar', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Arquivar', exact: true })).toBeEnabled();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Editar', exact: true }).click();
  const dialog = page.locator('#ceoIdeaDialog');
  await dialog.getByLabel('Título', { exact: true }).fill('Cobrança automatizada');
  await dialog.getByRole('button', { name: 'Salvar ideia', exact: true }).click();
  await expect(dialog.locator('[role="alert"]')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Salvar ideia', exact: true })).toBeEnabled();
  expect((await cloudData(page)).ideias[0].titulo).toBe(seed.ideias[0].titulo);
  await page.evaluate(() => { window.testFailWrite = false; });
  await dialog.getByRole('button', { name: 'Salvar ideia', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(card).toContainText('Cobrança automatizada');
  const data = await cloudData(page);
  expect(data.ideias).toHaveLength(1);
  expect(data.ideias[0]).toMatchObject({ id: 'idea', titulo: 'Cobrança automatizada', etapa: 'avaliacao', arquivada: false });
});

test('mobile idea editor and long categories fit the screen and save normally', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await mock(page, { ...seed, ideias: [] });
  await expect(page.locator('.ceo-metrics')).toBeVisible();
  await page.locator('#ceoMenuBtn').click();
  await page.locator('.nav [data-module="ideias"]').click();
  await page.getByRole('button', { name: '+ Nova ideia', exact: true }).click();
  const dialog = page.locator('#ceoIdeaDialog');
  await dialog.getByLabel('Título', { exact: true }).fill('Ideia registrada pelo celular');
  await dialog.getByLabel('Categoria', { exact: true }).fill('PlanejamentoEstratégicoDoRelacionamentoComClientes');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await dialog.getByRole('button', { name: 'Salvar ideia', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.ceo-idea-card')).toContainText('Ideia registrada pelo celular');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('.ceo-idea-card [data-idea-move]').selectOption('concluida');
  await expect(page.locator('.ceo-idea-card [data-idea-move]')).toHaveValue('concluida');
  expect((await cloudData(page)).ideias[0].etapa).toBe('concluida');
});
