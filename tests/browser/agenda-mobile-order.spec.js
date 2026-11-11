const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

async function navigate(page, module) {
  await page.locator('#ceoMenuBtn').click();
  await page.locator(`.nav [data-module="${module}"]`).click();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.abort());
});

for (const width of [320, 390]) {
  test(`agenda shows selected tasks before reminder settings at ${width}px and preserves desktop columns`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const data = structuredClone(seed);
    data.agenda.push({ id: 'undated', nome: 'Planejar próxima entrega', prazo: '', status: 'Pendente' });
    await mock(page, data);
    await navigate(page, 'agenda');
    const calendar = page.locator('.za-calendar');
    const tasks = page.locator('.za-day-panel');
    const reminders = page.locator('.za-reminders');
    const undated = page.locator('.za-undated');
    await expect(tasks).toHaveCount(1);
    await expect(tasks).toContainText('Revisar o financeiro');
    expect(await page.locator('.za-main > section').evaluateAll(nodes => nodes.map(node => [...node.classList].find(name => name.startsWith('za-'))))).toEqual(['za-calendar', 'za-day-panel', 'za-reminders', 'za-undated']);
    const boxes = await Promise.all([calendar, tasks, reminders, undated].map(locator => locator.boundingBox()));
    for (let index = 1; index < boxes.length; index++) expect(boxes[index].y).toBeGreaterThanOrEqual(boxes[index - 1].y + boxes[index - 1].height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`agenda-order-${width}.png`), fullPage: true });

    await page.locator('[data-date="2026-09-30"]').click();
    await expect(tasks).toContainText('Seu dia está livre');
    await tasks.getByRole('button', { name: 'Adicionar tarefa' }).click();
    await expect(page.locator('dialog.za-dialog [name="prazo"]')).toHaveValue('2026-09-30');
    await page.locator('dialog.za-dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const desktopCalendar = await calendar.boundingBox();
    const desktopTasks = await tasks.boundingBox();
    const desktopReminders = await reminders.boundingBox();
    expect(desktopTasks.x).toBeGreaterThan(desktopCalendar.x);
    expect(desktopTasks.y).toBe(desktopCalendar.y);
    expect(desktopReminders.x).toBe(desktopCalendar.x);
    expect(desktopReminders.y).toBeGreaterThan(desktopCalendar.y + desktopCalendar.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`idea filters stay in two columns below search and remain usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const data = structuredClone(seed);
    data.ideias.push({ ...seed.ideias[0], id: 'long-category', titulo: 'Outra ideia', categoria: 'Uma categoria com descrição muito longa para a tela do celular', prioridade: 'Baixa' });
    await mock(page, data);
    await navigate(page, 'ideias');
    const search = page.locator('[data-idea-filter="search"]');
    const category = page.locator('[data-idea-filter="category"]');
    const priority = page.locator('[data-idea-filter="priority"]');
    const stage = page.locator('[data-idea-filter="stage"]');
    const archived = page.locator('[data-idea-filter="archived"]');
    const [searchBox, categoryBox, priorityBox, stageBox, archivedBox] = await Promise.all([search, category, priority, stage, archived].map(locator => locator.boundingBox()));
    expect(searchBox.width).toBeGreaterThan(categoryBox.width * 1.8);
    expect(categoryBox.y).toBe(priorityBox.y);
    expect(stageBox.y).toBe(archivedBox.y);
    expect(priorityBox.x).toBeGreaterThan(categoryBox.x);
    expect(stageBox.y).toBeGreaterThan(categoryBox.y);
    for (const field of [search, category, priority, stage, archived]) {
      const box = await field.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await field.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    }
    await category.selectOption('Financeiro');
    await expect(page.locator('[data-idea-id]')).toHaveCount(1);
    await expect(page.locator('[data-idea-id]')).toContainText('Automatizar cobrança');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`idea-filters-${width}.png`), fullPage: true });
  });
}
