const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});

const chart = (page, type) => page.locator(`[data-category-chart="${type}"]`);
const categoryLink = (page, name, type = 'Saída') => page.getByRole('button', { name: `Ver lançamentos de ${name} (${type})`, exact: true });
const navigate = page => page.locator('.nav [data-module="financeiro"]').click();

function chartData() {
  const data = structuredClone(seed);
  const row = (nome, tipo, categoria, valor, status, date = '2026-09-05') => ({ id: nome, nome, tipo, categoria, valor: tipo === 'Saída' ? -valor : valor, status, prazo: date, pagoEm: status === 'Pago' ? date : '' });
  data.financeiro = [
    row('Aluguel pago', 'Saída', 'Aluguel', 300, 'Pago'),
    row('Almoço pago', 'Saída', 'Alimentação', 100, 'Pago'),
    row('Consultoria recebida', 'Entrada', 'Consultoria', 600, 'Pago'),
    row('Venda recebida', 'Entrada', 'Vendas', 400, 'Pago', '2026-09-15'),
    row('Aluguel pendente', 'Saída', 'Aluguel', 150, 'Pendente'),
    row('Almoço pendente', 'Saída', 'Alimentação', 50, 'Pendente'),
    row('Receita pendente', 'Entrada', 'Consultoria', 500, 'Pendente'),
    row('Despesa cancelada', 'Saída', 'Aluguel', 9999, 'Cancelado')
  ];
  return data;
}

test('bars and circles share totals, date filters and paid or pending categories', async ({ page }, testInfo) => {
  await mock(page, chartData());
  await navigate(page);
  await expect(page.getByRole('button', { name: 'Barras', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('400,00');
  await expect(chart(page, 'income').locator('.ceo-category-total')).toContainText('1.000,00');

  await page.getByRole('button', { name: 'Círculo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Círculo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart(page, 'expense').locator('svg')).toHaveAttribute('role', 'img');
  await expect(chart(page, 'expense').locator('[data-chart-segment]')).toHaveCount(2);
  await expect(chart(page, 'expense').locator('[data-chart-segment="Aluguel"]')).toHaveAttribute('stroke-dasharray', '75 25');
  await expect(categoryLink(page, 'Aluguel')).toContainText('300,00');
  await expect(categoryLink(page, 'Aluguel')).toContainText('75%');
  await expect(chart(page, 'income').locator('.ceo-category-total')).toContainText('1.000,00');
  await page.locator('.ceo-category-analysis').screenshot({ path: testInfo.outputPath('finance-circle-desktop.png') });

  await page.getByLabel('Até', { exact: true }).fill('2026-09-10');
  await page.getByLabel('Até', { exact: true }).blur();
  await expect(chart(page, 'income').locator('.ceo-category-total')).toContainText('600,00');
  await expect(chart(page, 'income').locator('[data-chart-segment]')).toHaveCount(1);
  await expect(chart(page, 'income').locator('[data-chart-segment]')).toHaveAttribute('stroke-dasharray', '100 0');

  await page.getByRole('button', { name: 'A pagar e receber', exact: true }).click();
  await expect(chart(page, 'expense')).toHaveAttribute('data-chart-view', 'circle');
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('200,00');
  await expect(chart(page, 'income').locator('.ceo-category-total')).toContainText('500,00');
  await expect(categoryLink(page, 'Aluguel')).toContainText('150,00');
  await page.getByRole('button', { name: 'Barras', exact: true }).click();
  await expect(chart(page, 'expense').locator('svg')).toHaveCount(0);
  await expect(categoryLink(page, 'Aluguel')).toContainText('75%');
  await expect(page.getByLabel('Até', { exact: true })).toHaveValue('2026-09-10');
  await expect(page.getByRole('button', { name: 'A pagar e receber', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('circle legends open matching ledger rows and empty circles show no fabricated values', async ({ page }) => {
  await mock(page, chartData());
  await navigate(page);
  await page.getByRole('button', { name: 'Círculo', exact: true }).click();
  await categoryLink(page, 'Alimentação').click();
  const rows = page.locator('[data-finance-ledger] .ceo-table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Almoço pago');
  await expect(page.getByLabel('Categoria', { exact: true })).toHaveValue('Alimentação');
  await expect(page.getByLabel('Situação', { exact: true })).toHaveValue('Liquidado');
  await expect(chart(page, 'expense')).toHaveAttribute('data-chart-view', 'circle');
  await expect(chart(page, 'expense').locator('[data-chart-segment]')).toHaveAttribute('stroke-dasharray', '100 0');
  await expect(categoryLink(page, 'Alimentação')).toContainText('100%');
  await expect(chart(page, 'income').locator('[data-chart-segment]')).toHaveCount(0);
  await expect(chart(page, 'income').getByRole('img')).toHaveAccessibleName('Nenhum valor para distribuir');
  await expect(chart(page, 'income')).toContainText('Nenhuma entrada recebida');

  await page.getByRole('button', { name: 'A pagar e receber', exact: true }).click();
  await categoryLink(page, 'Alimentação').click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Almoço pendente');
  await expect(page.getByLabel('Situação', { exact: true })).toHaveValue('Pendente');
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('50,00');
});

for (const width of [320, 390]) {
  test(`circle charts and long category legends fit a ${width}px phone`, async ({ page }, testInfo) => {
    const data = chartData();
    const longName = 'CategoriaFinanceiraDeViagensDaEquipeEAlimentacaoDuranteProjetosExternos';
    data.financeiro[0].categoria = longName;
    await page.setViewportSize({ width, height: 844 });
    await mock(page, data);
    await page.locator('#ceoMenuBtn').click();
    await navigate(page);
    await page.getByRole('button', { name: 'Círculo', exact: true }).click();
    await expect(chart(page, 'expense').locator('svg')).toBeVisible();
    await expect(categoryLink(page, longName)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(await chart(page, 'expense').evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    await page.locator('.ceo-category-analysis').screenshot({ path: testInfo.outputPath(`finance-circle-${width}.png`) });
    await categoryLink(page, longName).click();
    await expect(page.locator('[data-finance-ledger] .ceo-table tbody tr')).toHaveCount(1);
  });
}
