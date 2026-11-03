const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

for (const width of [1440, 390]) test(`cash balance stays visible and independent of finance filters at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const data = structuredClone(seed);
  data.financeiro = [
    { id: 'prior', nome: 'Receita anterior', tipo: 'Entrada', valor: 1000, status: 'Recebido', pagoEm: '2026-08-10', prazo: '2026-08-10' },
    { id: 'paid', nome: 'Saída paga', tipo: 'Saída', valor: -250, status: 'Pago', pagoEm: '2026-09-10', prazo: '2026-10-10' },
    { id: 'future', nome: 'Receita futura', tipo: 'Entrada', valor: 9000, status: 'Pago', pagoEm: '2026-10-10', prazo: '2026-09-01' },
    { id: 'cancel', nome: 'Cancelada', tipo: 'Saída', valor: -800, status: 'Cancelado', prazo: '2026-09-01' },
    { id: 'pending', nome: 'Despesa pendente', tipo: 'Saída', valor: -50, status: 'Pendente', prazo: '2026-09-20' }
  ];
  await mock(page, data);
  const go = async name => {
    if (width <= 720) await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
    await page.locator(`.nav [data-module="${name}"]`).click();
  };
  await go('financeiro');
  const cash = page.locator('#financeCashBalance'), value = cash.locator('output');
  await expect(value).toHaveText('R$ 750,00');
  // Works against both the published financial screen and the local tabbed layout.
  const tabs = page.getByRole('tab');
  for (let i = 0; i < await tabs.count(); i++) {
    await tabs.nth(i).click();
    await expect(value).toHaveText('R$ 750,00');
  }
  const filters = page.locator('.ceo-finance-more-filters');
  if (await filters.count()) await filters.locator('summary').click();
  await page.locator('[data-filter="from"]').fill('2026-10-01');
  await page.locator('[data-filter="to"]').fill('2026-10-31');
  await page.locator('[data-filter="to"]').blur();
  await expect(value).toHaveText('R$ 750,00');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const box = await cash.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThan(844);
  await page.getByRole('button', { name: 'Gastos fixos', exact: true }).click();
  await expect(value).toHaveText('R$ 750,00');
  await page.screenshot({ path: test.info().outputPath('cash.png'), fullPage: true });
  // A saved payment must update the banner, not just its filtered period totals.
  await page.evaluate(async () => ceoCommit(draft => ZamaFinance.settleMovement(draft, 'pending', '2026-09-29')));
  await expect(value).toHaveText('R$ 700,00');
  await go('clientes');
  await expect(cash).toBeHidden();
  await go('financeiro');
  await expect(value).toHaveText('R$ 700,00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
