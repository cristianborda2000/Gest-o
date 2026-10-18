const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});

const navigate = page => page.locator('.nav [data-module="financeiro"]').click();
const cloud = page => page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data);
const chart = (page, type) => page.locator(`[data-category-chart="${type}"]`);
const categoryBar = (page, name, type = 'Saída') => page.getByRole('button', { name: `Ver lançamentos de ${name} (${type})`, exact: true });
const ledgerRows = page => page.locator('[data-finance-ledger] .ceo-table tbody tr');

async function suggestions(form) {
  return form.getByLabel('Categoria', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value));
}

async function addCategory(page, name, type) {
  await page.getByRole('button', { name: 'Categorias', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Categorias financeiras', exact: true });
  await form.getByLabel('Usar em', { exact: true }).selectOption(type);
  await form.getByLabel('Nome da categoria', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'Cadastrar categoria', exact: true }).click();
  await expect(form).not.toBeVisible();
}

async function fillPaidExpense(page, name, category, amount = '45,67') {
  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Descrição', { exact: true }).fill(name);
  await form.getByLabel('Tipo', { exact: true }).selectOption('Saída');
  await form.getByRole('button', { name: 'Nova categoria', exact: false }).click();
  await form.getByLabel('Nome da nova categoria', { exact: true }).fill(category);
  await form.getByLabel('Valor (R$)', { exact: true }).fill(amount);
  await form.getByLabel('Data do lançamento', { exact: true }).fill('2026-09-29');
  await form.getByLabel('Vencimento', { exact: true }).fill('2026-09-29');
  await form.getByLabel('Situação', { exact: true }).selectOption('Pago');
  await form.getByLabel('Data do recebimento / pagamento', { exact: true }).fill('2026-09-29');
  return form;
}

test('custom categories survive reload and suggestions follow the movement direction', async ({ page }) => {
  await mock(page);
  await navigate(page);
  await addCategory(page, 'Refeições da equipe', 'Saída');
  await addCategory(page, 'Patrocínios de eventos', 'Entrada');
  await page.reload();
  await navigate(page);

  const stored = await cloud(page);
  expect(stored.financeCategories).toEqual(expect.arrayContaining([
    expect.objectContaining({ nome: 'Refeições da equipe', tipo: 'Saída' }),
    expect.objectContaining({ nome: 'Patrocínios de eventos', tipo: 'Entrada' })
  ]));
  expect(stored.financeiro).toHaveLength(seed.financeiro.length);
  expect(stored.financeiro).toEqual(expect.arrayContaining(seed.financeiro.map(row => expect.objectContaining(row))));

  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Tipo', { exact: true }).selectOption('Saída');
  expect(await suggestions(form)).toContain('Refeições da equipe');
  expect(await suggestions(form)).not.toContain('Patrocínios de eventos');
  await form.getByLabel('Tipo', { exact: true }).selectOption('Entrada');
  expect(await suggestions(form)).toContain('Patrocínios de eventos');
  expect(await suggestions(form)).not.toContain('Refeições da equipe');
});

test('category charts distinguish paid and pending money, exclude cancellations and respect dates', async ({ page }, testInfo) => {
  const data = structuredClone(seed);
  const movement = (id, tipo, categoria, valor, status, date) => ({ id, nome: id, tipo, categoria, valor: tipo === 'Saída' ? -valor : valor, status, data: date, prazo: date, ...(status === 'Pago' ? { pagoEm: date } : {}) });
  data.financeiro = [
    movement('Almoço pago', 'Saída', 'Alimentação', 100, 'Pago', '2026-09-02'),
    movement('Aluguel pago', 'Saída', 'Aluguel', 300, 'Pago', '2026-09-15'),
    movement('Serviço recebido', 'Entrada', 'Serviços', 600, 'Pago', '2026-09-03'),
    movement('Venda recebida', 'Entrada', 'Vendas', 400, 'Pago', '2026-09-15'),
    movement('Almoço previsto', 'Saída', 'Alimentação', 50, 'Pendente', '2026-09-29'),
    movement('Aluguel previsto', 'Saída', 'Aluguel', 150, 'Pendente', '2026-09-30'),
    movement('Serviço previsto', 'Entrada', 'Serviços', 200, 'Pendente', '2026-09-30'),
    movement('Venda prevista', 'Entrada', 'Vendas', 300, 'Pendente', '2026-09-30'),
    movement('Despesa cancelada', 'Saída', 'Aluguel', 9999, 'Cancelado', '2026-09-15'),
    movement('Receita cancelada', 'Entrada', 'Serviços', 9999, 'Cancelado', '2026-09-15'),
    { ...movement('Baixa no mês anterior', 'Saída', 'Aluguel', 1234, 'Pago', '2026-09-02'), pagoEm: '2026-08-31' }
  ];
  await mock(page, data);
  await navigate(page);
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('400,00');
  await expect(chart(page, 'income').locator('.ceo-category-total')).toContainText('1.000,00');
  await expect(categoryBar(page, 'Alimentação')).toContainText('25%');
  await expect(categoryBar(page, 'Aluguel')).toContainText('75%');
  await expect(categoryBar(page, 'Serviços', 'Entrada')).toContainText('60%');
  await expect(categoryBar(page, 'Vendas', 'Entrada')).toContainText('40%');
  await page.locator('.ceo-category-analysis').screenshot({ path: testInfo.outputPath('finance-category-charts.png') });

  await page.getByRole('button', { name: 'A pagar e receber', exact: true }).click();
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('200,00');
  await expect(chart(page, 'income').locator('.ceo-category-total')).toContainText('500,00');
  await expect(categoryBar(page, 'Aluguel')).toContainText('150,00');
  await expect(categoryBar(page, 'Aluguel')).toContainText('75%');
  await expect(categoryBar(page, 'Serviços', 'Entrada')).toContainText('40%');
  await expect(categoryBar(page, 'Vendas', 'Entrada')).toContainText('60%');

  await page.getByRole('button', { name: 'Pagos e recebidos', exact: true }).click();
  await page.getByLabel('Até', { exact: true }).fill('2026-09-10');
  await page.getByLabel('Até', { exact: true }).blur();
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('100,00');
  await expect(chart(page, 'income').locator('.ceo-category-total')).toContainText('600,00');
  await expect(categoryBar(page, 'Alimentação')).toContainText('100%');
  await expect(categoryBar(page, 'Aluguel')).toHaveCount(0);
  await expect(categoryBar(page, 'Serviços', 'Entrada')).toContainText('100%');
});

test('saving a movement creates a reusable category and its chart drills into the matching ledger', async ({ page }) => {
  await mock(page);
  await navigate(page);
  const form = await fillPaidExpense(page, 'Peça para manutenção', 'Peças de reposição');
  await form.getByRole('button', { name: 'Salvar movimentação', exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('525,92');
  await expect(categoryBar(page, 'Peças de reposição')).toContainText('45,67');
  await expect(categoryBar(page, 'Peças de reposição')).toContainText('8,7%');

  await categoryBar(page, 'Peças de reposição').click();
  await expect(ledgerRows(page)).toHaveCount(1);
  await expect(ledgerRows(page)).toContainText('Peça para manutenção');
  await expect(page.getByLabel('Categoria', { exact: true })).toHaveValue('Peças de reposição');
  await expect(page.getByLabel('Tipo', { exact: true })).toHaveValue('Saída');
  await expect(page.getByLabel('Situação', { exact: true })).toHaveValue('Liquidado');
  await expect(categoryBar(page, 'Peças de reposição')).toContainText('100%');

  await page.reload();
  await navigate(page);
  const stored = await cloud(page);
  expect(stored.financeCategories).toContainEqual(expect.objectContaining({ nome: 'Peças de reposição', tipo: 'Saída' }));
  expect(stored.financeiro.find(row => row.nome === 'Peça para manutenção')).toMatchObject({ categoria: 'Peças de reposição', valorCentavos: 4567, valor: -45.67 });
  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  await page.getByRole('dialog').getByLabel('Tipo', { exact: true }).selectOption('Saída');
  expect(await suggestions(page.getByRole('dialog'))).toContain('Peças de reposição');
});

test('category chart drilldown finds legacy rows with blank categories and fallback labels', async ({ page }) => {
  const data = structuredClone(seed);
  const movement = (id, categoria, responsavel, valor) => ({ id, nome: id, tipo: 'Saída', categoria, responsavel, valor: -valor, status: 'Pago', prazo: '2026-09-05', pagoEm: '2026-09-05' });
  data.financeiro = [
    movement('Aluguel legado', ' \t ', '  Aluguel   da sala  ', 10),
    movement('Complemento do aluguel', null, 'ALUGUEL DA SALA', 20),
    movement('Despesa sem categoria', ' ', '\t', 5),
    movement('Ferramenta', 'Sistema', 'Sistema', 7)
  ];
  await mock(page, data);
  await navigate(page);

  await expect(categoryBar(page, 'Aluguel da sala')).toContainText('30,00');
  await categoryBar(page, 'Aluguel da sala').click();
  await expect(ledgerRows(page)).toHaveCount(2);
  await expect(ledgerRows(page).filter({ hasText: 'Aluguel legado' })).toHaveCount(1);
  await expect(ledgerRows(page).filter({ hasText: 'Complemento do aluguel' })).toHaveCount(1);
  await expect(page.getByLabel('Categoria', { exact: true })).toHaveValue('Aluguel da sala');
  await expect(categoryBar(page, 'Aluguel da sala')).toContainText('100%');
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('30,00');

  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
  await categoryBar(page, 'Outro').click();
  await expect(ledgerRows(page)).toHaveCount(1);
  await expect(ledgerRows(page)).toContainText('Despesa sem categoria');
  await expect(chart(page, 'expense').locator('.ceo-category-total')).toContainText('5,00');
  expect((await cloud(page)).financeiro).toEqual(data.financeiro);
});

test('failed category and movement saves preserve drafts without persisting partial categories', async ({ page }) => {
  await mock(page);
  await navigate(page);
  await page.getByRole('button', { name: 'Categorias', exact: true }).click();
  let form = page.getByRole('dialog');
  await form.getByLabel('Nome da categoria', { exact: true }).fill('Categoria sem conexão');
  await page.evaluate(() => { window.testFailWrite = true; });
  await form.getByRole('button', { name: 'Cadastrar categoria', exact: true }).click();
  await expect(form.locator('[role="alert"]')).toContainText('Não foi possível salvar');
  await expect(form.getByLabel('Nome da categoria', { exact: true })).toHaveValue('Categoria sem conexão');
  expect((await cloud(page)).financeCategories || []).toHaveLength(0);
  await form.getByRole('button', { name: 'Cancelar', exact: true }).click();

  form = await fillPaidExpense(page, 'Movimento sem conexão', 'Custos de instalação');
  expect(await suggestions(form)).not.toContain('Categoria sem conexão');
  await form.getByRole('button', { name: 'Salvar movimentação', exact: true }).click();
  await expect(form.locator('[role="alert"]')).toContainText('Não foi possível salvar');
  await expect(form.getByLabel('Nome da nova categoria', { exact: true })).toHaveValue('Custos de instalação');
  await expect(form.getByLabel('Valor (R$)', { exact: true })).toHaveValue('45,67');
  expect((await cloud(page)).financeCategories || []).toHaveLength(0);
  expect((await cloud(page)).financeiro).toHaveLength(seed.financeiro.length);

  await page.evaluate(() => { window.testFailWrite = false; });
  await form.getByRole('button', { name: 'Salvar movimentação', exact: true }).click();
  await expect(form).not.toBeVisible();
  expect((await cloud(page)).financeCategories).toEqual([expect.objectContaining({ nome: 'Custos de instalação', tipo: 'Saída' })]);
  expect((await cloud(page)).financeiro.filter(row => row.nome === 'Movimento sem conexão')).toHaveLength(1);
});

for (const scenario of [{ type: 'Entrada', name: 'Licenciamento de conteúdo', width: 1440 }, { type: 'Saída', name: 'Alimentação nas gravações', width: 390 }]) {
  test(`inline category creation follows ${scenario.type} and saves with the movement at ${scenario.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await mock(page);
    if (scenario.width < 720) await page.locator('#ceoMenuBtn').click();
    await navigate(page);
    await page.getByRole('button', { name: 'Nova movimentação' }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Descrição', { exact: true }).fill(`Registro de ${scenario.name}`);
    await form.getByLabel('Valor (R$)', { exact: true }).fill('60,20');
    const type = form.getByLabel('Tipo', { exact: true });
    const select = form.getByLabel('Categoria', { exact: true });
    await type.selectOption(scenario.type);
    await expect(select).toHaveValue(scenario.type === 'Saída' ? 'Outro' : 'Receita');
    await form.getByRole('button', { name: 'Nova categoria', exact: false }).click();
    const name = form.getByLabel('Nome da nova categoria', { exact: true });
    await name.fill('   ');
    expect(await name.evaluate(element => element.checkValidity())).toBe(false);
    await name.fill(scenario.name);
    await expect(select).toBeDisabled();
    await type.selectOption(scenario.type === 'Entrada' ? 'Saída' : 'Entrada');
    await expect(name).toHaveValue(scenario.name);
    await type.selectOption(scenario.type);
    await expect(form.locator('[data-new-category-hint]')).toContainText(scenario.type === 'Saída' ? 'saídas' : 'entradas');
    expect((await cloud(page)).financeCategories || []).toHaveLength(0);

    await form.getByRole('button', { name: 'Cancelar nova categoria', exact: true }).click();
    await expect(select).toBeEnabled();
    await expect(name).toBeDisabled();
    await form.getByRole('button', { name: 'Nova categoria', exact: false }).click();
    await expect(name).toHaveValue(scenario.name);
    expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`inline-category-${scenario.width}.png`) });
    await form.getByRole('button', { name: 'Salvar movimentação', exact: true }).click();
    await expect(form).not.toBeVisible();
    const stored = await cloud(page);
    expect(stored.financeCategories).toEqual([expect.objectContaining({ nome: scenario.name, tipo: scenario.type })]);
    expect(stored.financeiro.find(row => row.nome === `Registro de ${scenario.name}`)).toMatchObject({ tipo: scenario.type, categoria: scenario.name, valorCentavos: 6020 });
    await page.reload();
    if (scenario.width < 720) await page.locator('#ceoMenuBtn').click();
    await navigate(page);
    await page.getByRole('button', { name: 'Nova movimentação' }).click();
    await page.getByRole('dialog').getByLabel('Tipo', { exact: true }).selectOption(scenario.type);
    await page.getByRole('dialog').getByLabel('Categoria', { exact: true }).selectOption(scenario.name);
  });
}

test('editing a legacy category keeps the equivalent saved category when switching directions', async ({ page }) => {
  const data = structuredClone(seed);
  data.financeCategories = [{ id: 'rent-category', nome: 'Aluguel', tipo: 'Saída' }];
  data.financeiro = [{ id: 'legacy-rent', nome: 'Aluguel legado', categoria: 'ALUGUEL', tipo: 'Saída', valor: -150, status: 'Pago', data: '2026-09-29', prazo: '2026-09-29', pagoEm: '2026-09-29' }];
  await mock(page, data);
  await navigate(page);
  await page.getByRole('button', { name: 'Editar Aluguel legado', exact: true }).click();
  const form = page.getByRole('dialog');
  const select = form.getByLabel('Categoria', { exact: true });
  await expect(select).toHaveValue('Aluguel');
  expect((await suggestions(form)).filter(name => name.toLowerCase() === 'aluguel')).toHaveLength(1);
  await form.getByLabel('Tipo', { exact: true }).selectOption('Entrada');
  await form.getByLabel('Tipo', { exact: true }).selectOption('Saída');
  await expect(select).toHaveValue('Aluguel');
  await form.getByRole('button', { name: 'Salvar movimentação', exact: true }).click();
  await expect(form).not.toBeVisible();
  expect((await cloud(page)).financeiro[0]).toMatchObject({ categoria: 'Aluguel', valor: -150 });
  expect((await cloud(page)).financeCategories).toEqual(data.financeCategories);
});

test('switching directions uses the canonical fallback category from legacy labels', async ({ page }) => {
  const data = structuredClone(seed);
  data.financeiro.forEach(row => { row.responsavel = row.tipo === 'Entrada' ? 'RECEITA' : 'OUTRO'; });
  data.financeiro.push({ id: 'system', nome: 'Sistema pago', tipo: 'Saída', categoria: 'Sistema', valor: -10, status: 'Pago', prazo: '2026-09-05', pagoEm: '2026-09-05' });
  await mock(page, data);
  await navigate(page);

  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  let form = page.getByRole('dialog');
  await expect(form.getByLabel('Categoria', { exact: true })).toHaveValue('RECEITA');
  await form.getByLabel('Tipo', { exact: true }).selectOption('Saída');
  await expect(form.getByLabel('Categoria', { exact: true })).toHaveValue('OUTRO');
  await form.getByRole('button', { name: 'Cancelar', exact: true }).click();

  await page.getByRole('button', { name: 'Editar Sistema pago', exact: true }).click();
  form = page.getByRole('dialog');
  await form.getByLabel('Tipo', { exact: true }).selectOption('Entrada');
  await expect(form.getByLabel('Categoria', { exact: true })).toHaveValue('RECEITA');
});

test('long category charts and the category form fit a phone viewport', async ({ page }, testInfo) => {
  const longName = 'CategoriaFinanceiraDeViagensDaEquipeEAlimentacaoDuranteProjetosExternos';
  const data = structuredClone(seed);
  data.financeiro[1].categoria = longName;
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, data);
  await page.locator('#ceoMenuBtn').click();
  await navigate(page);
  await expect(categoryBar(page, longName)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await chart(page, 'expense').evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await page.locator('.ceo-category-analysis').screenshot({ path: testInfo.outputPath('finance-category-mobile.png') });

  await page.getByRole('button', { name: 'Categorias', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Nome da categoria', { exact: true }).fill('Alimentação nas viagens');
  expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
  await form.getByRole('button', { name: 'Cadastrar categoria', exact: true }).click();
  await expect(form).not.toBeVisible();
  expect((await cloud(page)).financeCategories).toContainEqual(expect.objectContaining({ nome: 'Alimentação nas viagens', tipo: 'Saída' }));
});
