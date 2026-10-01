const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

// Parallel contributors can edit files while this suite runs. Disable Vite's
// development-only reload client so an in-progress form is not replaced.
test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});

const navigate = (page, module) => page.locator(`.nav [data-module="${module}"]`).click();
const cloud = page => page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data);
const financeRow = (page, name) => page.locator('.ceo-table tbody tr').filter({ has: page.getByText(name, { exact: true }) });

async function fillMovement(page, values = {}) {
  const form = page.getByRole('dialog');
  await form.getByLabel('Descrição', { exact: true }).fill(values.nome || 'Compra de equipamento');
  await form.getByLabel('Valor (R$)', { exact: true }).fill(values.valor || '1250,51');
  await form.getByLabel('Tipo', { exact: true }).selectOption(values.tipo || 'Saída');
  await form.getByLabel('Categoria', { exact: true }).fill(values.categoria || 'Equipamentos');
  await form.getByLabel('Data do lançamento', { exact: true }).fill('2026-09-29');
  await form.getByLabel('Vencimento', { exact: true }).fill('2026-09-30');
  await form.getByLabel('Situação', { exact: true }).selectOption(values.status || 'Pendente');
  await form.getByLabel('Observações', { exact: true }).fill('Registro isolado de teste.');
  return form;
}

test('financial CRUD, payable filter and cent-accurate persistence work through the UI', async ({ page }) => {
  await mock(page);
  await navigate(page, 'financeiro');
  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  let form = await fillMovement(page);
  await form.getByRole('button', { name: 'Salvar movimentação' }).click();
  await expect(form).not.toBeVisible();
  await expect(financeRow(page, 'Compra de equipamento')).toContainText('1.250,51');
  await expect(page.locator('.ceo-finance-summary')).toContainText('3.719,75');

  await page.getByRole('button', { name: 'Contas a pagar', exact: true }).click();
  await expect(page.locator('.ceo-table tbody tr')).toHaveCount(1);
  await expect(financeRow(page, 'Compra de equipamento')).toContainText('Pendente');
  await financeRow(page, 'Compra de equipamento').getByRole('button', { name: 'Editar Compra de equipamento', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('Valor (R$)', { exact: true }).fill('1250,52');
  await form.getByLabel('Situação', { exact: true }).selectOption('Pago');
  await form.getByLabel('Data do recebimento / pagamento', { exact: true }).fill('2026-09-29');
  await form.getByRole('button', { name: 'Salvar movimentação' }).click();
  await expect(form).not.toBeVisible();
  await expect(page.locator('.ceo-empty')).toContainText('Nenhuma movimentação');
  await page.getByRole('button', { name: 'Todas as movimentações', exact: true }).click();
  await expect(financeRow(page, 'Compra de equipamento')).toContainText('1.250,52');
  await expect(page.locator('.ceo-finance-summary')).toContainText('2.469,23');
  let record = (await cloud(page)).financeiro.find(row => row.nome === 'Compra de equipamento');
  expect(record.valorCentavos).toBe(125052);
  expect(record.valor).toBe(-1250.52);
  expect(record.pagoEm).toBe('2026-09-29');

  await page.reload();
  await navigate(page, 'financeiro');
  await expect(financeRow(page, 'Compra de equipamento')).toContainText('Pago');
  await expect(page.locator('.ceo-finance-summary')).toContainText('2.469,23');
  await financeRow(page, 'Compra de equipamento').getByRole('button', { name: 'Excluir Compra de equipamento', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('indicadores serão recalculados');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(financeRow(page, 'Compra de equipamento')).toBeVisible();
  await financeRow(page, 'Compra de equipamento').getByRole('button', { name: 'Excluir Compra de equipamento', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar exclusão', exact: true }).click();
  await expect(financeRow(page, 'Compra de equipamento')).toHaveCount(0);
  await expect(page.locator('.ceo-finance-summary')).toContainText('3.719,75');
  expect((await cloud(page)).financeiro).toHaveLength(seed.financeiro.length);
});

test('a planned investment becomes one paid outgoing movement and stays unique after reload', async ({ page }) => {
  await mock(page);
  await navigate(page, 'investimentos');
  await page.getByRole('button', { name: 'Novo investimento' }).click();
  let form = page.getByRole('dialog');
  await form.getByLabel('Nome', { exact: true }).fill('Campanha de crescimento');
  await form.getByLabel('Valor (R$)', { exact: true }).fill('8000,21');
  await form.getByLabel('Categoria', { exact: true }).fill('Marketing');
  await form.getByLabel('Data prevista / realizada', { exact: true }).fill('2026-09-29');
  await form.getByLabel('Objetivo', { exact: true }).fill('Aumentar a aquisição de clientes.');
  await form.getByLabel('Situação', { exact: true }).selectOption('Planejado');
  await expect(form.locator('[name="geraSaida"]')).toBeChecked();
  await form.getByRole('button', { name: 'Salvar investimento' }).click();
  await expect(form).not.toBeVisible();
  await expect(page.locator('.ceo-investment-card')).toContainText('Incluído nas contas a pagar');
  let stored = await cloud(page);
  expect(stored.investimentos).toHaveLength(1);
  const investmentId = stored.investimentos[0].id;
  const movementId = stored.investimentos[0].movementId;
  expect(stored.financeiro.filter(row => row.investmentId === investmentId)).toHaveLength(1);
  expect(stored.financeiro.find(row => row.id === movementId).status).toBe('Pendente');

  await navigate(page, 'financeiro');
  await page.getByRole('button', { name: 'Contas a pagar', exact: true }).click();
  await expect(financeRow(page, 'Campanha de crescimento')).toContainText('8.000,21');
  await financeRow(page, 'Campanha de crescimento').getByRole('button', { name: 'Editar Campanha de crescimento', exact: true }).click();
  form = page.getByRole('dialog');
  await expect(form).toContainText('Editar investimento');
  await form.getByLabel('Situação', { exact: true }).selectOption('Realizado');
  await form.getByRole('button', { name: 'Salvar investimento' }).click();
  await expect(form).not.toBeVisible();
  await navigate(page, 'dashboard');
  await expect(page.locator('.ceo-metrics')).toContainText('8.000,21');
  await expect(page.locator('.ceo-metrics')).toContainText('4.280,46');

  await page.reload();
  await expect(page.locator('.ceo-metrics')).toContainText('8.000,21');
  stored = await cloud(page);
  expect(stored.investimentos[0].status).toBe('Realizado');
  expect(stored.investimentos[0].movementId).toBe(movementId);
  expect(stored.financeiro).toHaveLength(seed.financeiro.length + 1);
  expect(stored.financeiro.filter(row => row.investmentId === investmentId)).toHaveLength(1);
  expect(stored.financeiro.find(row => row.id === movementId).valor).toBe(-8000.21);
  expect(stored.financeiro.find(row => row.id === movementId).status).toBe('Pago');

  await navigate(page, 'investimentos');
  await page.getByRole('button', { name: 'Excluir Campanha de crescimento', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('saída financeira vinculada serão excluídos');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar exclusão', exact: true }).click();
  await expect(page.locator('.ceo-investment-card')).toHaveCount(0);
  stored = await cloud(page);
  expect(stored.investimentos).toHaveLength(0);
  expect(stored.financeiro).toHaveLength(seed.financeiro.length);
});

test('failed financial saves preserve the modal, entered values and previously saved data', async ({ page }) => {
  await mock(page);
  await navigate(page, 'financeiro');
  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  const form = await fillMovement(page, { nome: 'Registro com falha de conexão', valor: '42,19' });
  await page.evaluate(() => { window.testFailWrite = true; });
  await form.getByRole('button', { name: 'Salvar movimentação' }).click();
  await expect(form).toBeVisible();
  await expect(form.locator('[role="alert"]')).toContainText('Não foi possível salvar');
  await expect(form.getByLabel('Descrição', { exact: true })).toHaveValue('Registro com falha de conexão');
  await expect(form.getByLabel('Valor (R$)', { exact: true })).toHaveValue('42,19');
  expect((await cloud(page)).financeiro).toHaveLength(seed.financeiro.length);

  await page.evaluate(() => { window.testFailWrite = false; });
  await form.getByRole('button', { name: 'Salvar movimentação' }).click();
  await expect(form).not.toBeVisible();
  await expect(financeRow(page, 'Registro com falha de conexão')).toContainText('42,19');
  expect((await cloud(page)).financeiro).toHaveLength(seed.financeiro.length + 1);
});

test('financial filters and forms remain contained on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.locator('#ceoMenuBtn').click();
  await navigate(page, 'financeiro');
  await expect(page.locator('.ceo-finance-summary')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  const form = await fillMovement(page, { nome: 'Cadastro pelo celular' });
  expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await form.getByRole('button', { name: 'Salvar movimentação' }).click();
  await expect(form).not.toBeVisible();
  await expect(financeRow(page, 'Cadastro pelo celular')).toContainText('1.250,51');
});
