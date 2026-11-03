const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');
const { selectFinanceTab, openFinanceFilters } = require('./finance-ui-helpers');

const pending = { id: 'pending-expense', nome: 'Assinatura da equipe', categoria: 'Ferramentas', tipo: 'Saída', valor: -89.9, status: 'Pendente', prazo: '2026-09-28', data: '2026-09-28' };
const fixture = () => ({ ...structuredClone(seed), financeiro: [...structuredClone(seed.financeiro), pending] });
const workspace = page => page.locator('[data-finance-workspace]');
const tab = (page, name) => workspace(page).getByRole('tab', { name, exact: true });
const row = (page, id) => page.locator(`[data-finance-row="${id}"]`);
const snapshot = page => page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.financeiro);
async function setup(page, data = fixture()) {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await mock(page, data);
  if (page.viewportSize().width <= 720) await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
  await page.locator('.nav [data-module="financeiro"]').click();
}

test('finance tabs support keyboard navigation and summary links open the selected movement without changing records', async ({ page }) => {
  await setup(page);
  const before = await snapshot(page);
  await expect(tab(page, 'Resumo')).toHaveAttribute('aria-selected', 'true');
  await expect(workspace(page).getByRole('tabpanel')).toHaveCount(1);
  await expect(workspace(page).locator('.is-balance')).toContainText('3.719,75');
  await expect(workspace(page).locator('.is-payable')).toContainText('89,90');
  await expect(page.getByRole('button', { name: 'Barras', exact: true })).toHaveCount(0);
  await expect(row(page, pending.id)).toBeHidden();
  await tab(page, 'Resumo').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Lançamentos')).toBeFocused();
  await expect(row(page, pending.id)).toBeVisible();
  await page.keyboard.press('End');
  await expect(tab(page, 'Análises')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Barras', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Resumo')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Análises')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab(page, 'Resumo')).toBeFocused();
  await workspace(page).getByRole('button', { name: `Ver lançamento ${pending.nome}`, exact: true }).click();
  await expect(tab(page, 'Lançamentos')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, pending.id)).toHaveClass('is-expanded');
  expect(await snapshot(page)).toEqual(before);
  expect(await page.evaluate(() => window.testDbWrites)).toEqual([]);
});

test('month shortcuts handle a year boundary, retain category filters and keep cash dates authoritative', async ({ page }) => {
  const data = structuredClone(seed);
  data.financeiro = [
    { id: 'dec', nome: 'Recebido em dezembro', categoria: 'Serviços', tipo: 'Entrada', valor: 500, status: 'Pago', prazo: '2027-01-03', pagoEm: '2026-12-28' },
    { id: 'jan', nome: 'Ferramenta de janeiro', categoria: 'Ferramentas', tipo: 'Saída', valor: -120, status: 'Pago', prazo: '2027-01-02', pagoEm: '2027-01-02' },
    { id: 'jan-pending', nome: 'Serviço a receber', categoria: 'Serviços', tipo: 'Entrada', valor: 200, status: 'Pendente', prazo: '2027-01-08' }
  ];
  await setup(page, data);
  await page.clock.setSystemTime(new Date('2027-01-05T12:00:00-03:00'));
  await page.getByRole('button', { name: 'Este mês', exact: true }).click();
  await expect(workspace(page).locator('.ceo-finance-period-label')).toContainText('01/01/2027 a 31/01/2027');
  await expect(workspace(page).locator('.is-balance')).toContainText('-R$ 120,00');
  await page.getByRole('button', { name: 'Mês anterior', exact: true }).click();
  await expect(workspace(page).locator('.ceo-finance-period-label')).toContainText('01/12/2026 a 31/12/2026');
  await expect(workspace(page).locator('.is-income')).toContainText('500,00');
  await openFinanceFilters(page);
  await workspace(page).getByLabel('Categoria', { exact: true }).selectOption('Serviços');
  await page.getByRole('button', { name: 'Este mês', exact: true }).click();
  await selectFinanceTab(page, 'Lançamentos');
  await expect(workspace(page).locator('[data-finance-row]')).toHaveCount(1);
  await expect(row(page, 'jan-pending')).toBeVisible();
  await expect(workspace(page).locator('.ceo-finance-active-filters')).toContainText('Serviços');
  await selectFinanceTab(page, 'Análises');
  await expect(page.locator('[data-category-chart="income"]')).toContainText('Nenhuma entrada recebida');
  await workspace(page).getByRole('button', { name: 'Remover filtro Categoria: Serviços', exact: true }).click();
  await selectFinanceTab(page, 'Resumo');
  await expect(workspace(page).locator('.is-balance')).toContainText('-R$ 120,00');
  await workspace(page).getByLabel('De', { exact: true }).fill('2027-02-01');
  await workspace(page).getByLabel('De', { exact: true }).blur();
  await expect(workspace(page).locator('.ceo-finance-period-label')).toContainText('01/01/2027 a 31/01/2027');
  expect(await workspace(page).getByLabel('De', { exact: true }).evaluate(input => input.validity.valid)).toBe(false);
  expect(await snapshot(page)).toEqual(data.financeiro);
  expect(await page.evaluate(() => window.testDbWrites)).toEqual([]);
});

test('mobile disclosure preserves the expanded movement through filtering, tabs and payment', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await selectFinanceTab(page, 'Lançamentos');
  const movement = row(page, pending.id);
  const toggle = movement.locator('[data-finance-toggle]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(movement.locator('.finance-dates')).toBeHidden();
  await expect(movement.locator('.finance-value')).toContainText('89,90');
  await toggle.focus();
  await toggle.press('Enter');
  await expect(movement.locator('.finance-dates')).toBeVisible();
  await workspace(page).getByLabel('Pesquisar', { exact: true }).fill('Assinatura');
  await workspace(page).getByLabel('Pesquisar', { exact: true }).blur();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await selectFinanceTab(page, 'Análises');
  await selectFinanceTab(page, 'Lançamentos');
  await movement.locator('.ceo-finance-row-menu > summary').click();
  await movement.getByRole('button', { name: `Editar ${pending.nome}`, exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(movement.locator('.ceo-finance-row-menu')).not.toHaveAttribute('open', '');
  await expect(movement.locator('.ceo-finance-row-menu > summary')).toBeFocused();
  await movement.getByRole('button', { name: `Registrar pagamento de ${pending.nome}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar baixa', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tab(page, 'Lançamentos')).toHaveAttribute('aria-selected', 'true');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(movement.locator('.finance-status')).toHaveText('Pago');
  expect((await snapshot(page)).find(item => item.id === pending.id)).toMatchObject({ valor: -89.9, status: 'Pago', pagoEm: '2026-09-29' });
  await workspace(page).getByRole('button', { name: 'Remover filtro Pesquisa: Assinatura', exact: true }).click();
  await selectFinanceTab(page, 'Resumo');
  await expect(workspace(page).locator('.is-balance')).toContainText('3.629,85');
});

test('large values and long descriptions remain readable on a 320px screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const data = structuredClone(seed);
  data.financeiro = [
    { ...pending, id: 'large', nome: 'PagamentoDeServicosComDescricaoLongaSemEspacos', valor: -9999999999.99 },
    { ...pending, id: 'settled', nome: 'Despesa liquidada', valor: -9999999999.99, status: 'Pago', pagoEm: '2026-09-28' }
  ];
  await setup(page, data);
  await expect(workspace(page).locator('.is-balance')).toContainText('9.999.999.999,99');
  expect(await workspace(page).locator('.is-balance').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await selectFinanceTab(page, 'Lançamentos');
  await expect(row(page, 'large').locator('.finance-value')).toContainText('9.999.999.999,99');
  for (const target of [row(page, 'large'), row(page, 'large').locator('.finance-value')]) {
    expect(await target.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row(page, 'large').screenshot({ path: info.outputPath('large-values-320.png') });
});

for (const width of [1440, 390, 320]) test(`financial tabs and expandable cards fit ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await setup(page);
  for (const [name, file] of [['Resumo', 'summary'], ['Lançamentos', 'ledger'], ['Análises', 'analysis']]) {
    await selectFinanceTab(page, name);
    await expect(workspace(page).getByRole('tabpanel')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const target of [workspace(page), workspace(page).getByRole('tabpanel'), tab(page, name)]) {
      const box = await target.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect((await tab(page, name).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`${file}-${width}.png`), fullPage: true });
  }
  if (width <= 720) {
    await selectFinanceTab(page, 'Lançamentos');
    await row(page, pending.id).locator('[data-finance-toggle]').click();
    await row(page, pending.id).locator('.ceo-finance-row-menu > summary').click();
    expect(await row(page, pending.id).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await row(page, pending.id).screenshot({ path: info.outputPath(`expanded-${width}.png`) });
  }
});
