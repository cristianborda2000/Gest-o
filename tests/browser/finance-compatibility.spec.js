const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});

const navigate = (page, module) => page.locator(`.nav [data-module="${module}"]`).click();
const cloud = page => page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data);

for (const legacy of [
  { valor: -480.25, responsavel: 'Sistema', status: 'Paga', tipo: 'Saída', categoria: 'Sistema' },
  { valor: 480.25, responsavel: 'Equipamentos', status: 'Cancelada', tipo: 'Saída', categoria: 'Equipamentos' },
  { valor: 480.25, responsavel: 'Receita', status: 'Recebida', tipo: 'Entrada', categoria: 'Receita' }
]) {
  test(`editing a legacy ${legacy.tipo} (${legacy.valor}, ${legacy.status}) preserves its accounting`, async ({ page }) => {
    const data = structuredClone(seed);
    const cancelled = legacy.status === 'Cancelada';
    const savedStatus = cancelled ? 'Cancelado' : 'Pago';
    const paidOn = cancelled ? '' : '2026-09-06';
    data.financeiro = [{ id: 'legacy', nome: 'Registro antigo', valor: legacy.valor, responsavel: legacy.responsavel, status: legacy.status, prazo: '2026-09-05', pagoEm: paidOn }];
    await mock(page, data);
    await navigate(page, 'financeiro');
    const summary = await page.locator('.ceo-finance-summary').innerText();
    await page.getByRole('button', { name: 'Editar Registro antigo', exact: true }).click();
    const form = page.getByRole('dialog');
    await expect(form.getByLabel('Tipo', { exact: true })).toHaveValue(legacy.tipo);
    await expect(form.getByLabel('Categoria', { exact: true })).toHaveValue(legacy.categoria);
    await expect(form.getByLabel('Situação', { exact: true })).toHaveValue(savedStatus);
    if (cancelled) {
      await expect(form.getByLabel('Data do recebimento / pagamento', { exact: true })).toBeDisabled();
    } else {
      await expect(form.getByLabel('Data do recebimento / pagamento', { exact: true })).toBeEnabled();
      await expect(form.getByLabel('Data do recebimento / pagamento', { exact: true })).toHaveValue(paidOn);
    }
    await form.getByLabel('Observações', { exact: true }).fill('Histórico conferido.');
    await form.getByRole('button', { name: 'Salvar movimentação', exact: true }).click();
    await expect(form).not.toBeVisible();
    const saved = (await cloud(page)).financeiro[0];
    expect(saved).toMatchObject({ id: 'legacy', tipo: legacy.tipo, status: savedStatus, categoria: legacy.categoria, valorCentavos: 48025, valor: legacy.tipo === 'Saída' ? -480.25 : 480.25, prazo: '2026-09-05', pagoEm: paidOn });
    await page.reload();
    await navigate(page, 'financeiro');
    await expect(page.locator('.ceo-finance-summary')).toHaveText(summary, { useInnerText: true });
  });
}

for (const [status, investmentStatus, date] of [
  ['Pago', 'Realizado', '2026-09-06'],
  ['Pendente', 'Planejado', '2026-09-05'],
  ['Cancelado', 'Cancelado', '2026-09-05']
]) {
  test(`a new investment adopts the amount, date and status of a selected ${status} expense`, async ({ page }) => {
    const data = structuredClone(seed);
    data.financeiro[1] = { ...data.financeiro[1], status, prazo: '2026-09-05', pagoEm: status === 'Pago' ? date : '' };
    await mock(page, data);
    await navigate(page, 'financeiro');
    const summary = await page.locator('.ceo-finance-summary').innerText();
    await navigate(page, 'investimentos');
    await page.getByRole('button', { name: 'Novo investimento' }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Nome', { exact: true }).fill('Ferramentas e serviços');
    await form.getByLabel('Categoria', { exact: true }).selectOption('Sistema');
    await form.getByLabel('Valor (R$)', { exact: true }).fill('999,99');
    await form.getByLabel('Saída financeira vinculada', { exact: true }).selectOption('expense');
    await expect(form.getByLabel('Valor (R$)', { exact: true })).toHaveValue('480,25');
    await expect(form.getByLabel('Data prevista / realizada', { exact: true })).toHaveValue(date);
    await expect(form.getByLabel('Situação', { exact: true })).toHaveValue(investmentStatus);
    await form.getByRole('button', { name: 'Salvar investimento', exact: true }).click();
    await expect(form).not.toBeVisible();
    await page.reload();
    await navigate(page, 'financeiro');
    await expect(page.locator('.ceo-finance-summary')).toHaveText(summary, { useInnerText: true });
    const saved = await cloud(page);
    expect(saved.financeiro).toHaveLength(seed.financeiro.length);
    expect(saved.investimentos).toHaveLength(1);
    expect(saved.investimentos[0]).toMatchObject({ movementId: 'expense', valorCentavos: 48025, data: date, status: investmentStatus });
    expect(saved.financeiro.find(row => row.id === 'expense')).toMatchObject({ investmentId: saved.investimentos[0].id, valor: -480.25, status });
  });
}
