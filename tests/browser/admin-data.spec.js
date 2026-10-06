const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const { mock, seed } = require('./mock-supabase');
const A = require('../../app/assets/js/admin-data');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});
const cloud = page => page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data);
const upload = (page, value, name = 'backup.json') => page.locator('#importInput').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
const fixture = () => ({ ...structuredClone(seed), contractHistory: [], dashboard: [] });
const downloadText = async download => fs.readFile(await download.path(), 'utf8');

test('full backup downloads a restorable envelope with every module', async ({ page }) => {
  await mock(page); await page.locator('#settingsBtn').click();
  const pending = page.waitForEvent('download'); await page.locator('#exportBtn').click();
  const download = await pending, envelope = JSON.parse(await downloadText(download));
  expect(download.suggestedFilename()).toMatch(/^backup-zama-completo-.*\.json$/);
  expect(envelope.type).toBe('zama-backup'); expect(envelope.data.ideias[0].id).toBe('idea');
  expect(A.parseBackup(envelope).data.financeiro).toHaveLength(3);
});

test('reports default to overview month and export the explicit choice as CSV, JSON and printable PDF', async ({ page }) => {
  await mock(page);
  await page.locator('#overviewMonth').fill('2026-08');
  await page.locator('#settingsBtn').click(); await page.locator('#monthlyBackupBtn').click();
  const dialog = page.getByRole('dialog', { name: 'Relatórios mensais' });
  await expect(dialog.getByLabel('Mês do relatório')).toHaveValue('2026-08');
  await dialog.getByLabel('Mês do relatório').fill('2026-09');
  await expect(dialog.locator('[data-summary]')).toContainText('3 movimentações');
  let pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Baixar CSV' }).click();
  let download = await pending;
  expect(download.suggestedFilename()).toBe('relatorio-zama-2026-09.csv');
  expect(await downloadText(download)).toContain('Projeto entregue');
  pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Baixar JSON' }).click();
  download = await pending;
  const report = JSON.parse(await downloadText(download));
  expect(report.mes).toBe('2026-09'); expect(report.totais.balanceCents).toBe(371975);
  expect(report.type).toBe('zama-monthly-report');
  const popupPromise = page.waitForEvent('popup'); await dialog.getByRole('button', { name: 'Imprimir / PDF' }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Resumo por categoria' })).toBeVisible();
  await expect(popup.locator('body')).toContainText('setembro de 2026');
  await expect(popup.locator('body')).toContainText('3.719,75');
  await popup.close();
});

test('monthly and malformed imports cannot change any collection', async ({ page }) => {
  await mock(page); await page.locator('#settingsBtn').click();
  const before = await cloud(page);
  await upload(page, { mes: '2026-09', geradoEm: new Date().toISOString(), financeiro: [], totais: {} }, 'relatorio.json');
  await expect(page.locator('.toast').last()).toContainText('relatório mensal');
  expect(await cloud(page)).toEqual(before);
  await upload(page, { financeiro: [] }, 'incompleto.json');
  await expect(page.locator('.toast').last()).toContainText('Backup incompleto');
  expect(await cloud(page)).toEqual(before);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('restore has a review step, downloads the previous state, and retains the form for retry on failure', async ({ page }) => {
  await mock(page); await page.locator('#settingsBtn').click();
  const candidate = fixture(); candidate.financeiro[0].nome = 'Receita restaurada';
  const before = await cloud(page);
  await upload(page, A.makeBackup(candidate));
  const dialog = page.getByRole('dialog', { name: 'Revisar restauração' });
  await expect(dialog).toContainText('cópia completa dos dados atuais');
  await expect(dialog.getByRole('button', { name: 'Restaurar dados' })).toBeDisabled();
  expect(await cloud(page)).toEqual(before);
  await dialog.getByLabel('Digite RESTAURAR').fill('RESTAURAR');
  await page.evaluate(() => { window.testFailWrite = true; });
  let pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Restaurar dados' }).click();
  const previous = JSON.parse(await downloadText(await pending));
  expect(previous.type).toBe('zama-backup'); expect(previous.data.financeiro[0].nome).toBe(seed.financeiro[0].nome);
  await expect(dialog.locator('[role=alert]')).toContainText('não foi salva');
  await expect(dialog.getByLabel('Digite RESTAURAR')).toHaveValue('RESTAURAR');
  expect(await cloud(page)).toEqual(before);
  await page.evaluate(() => { window.testFailWrite = false; });
  pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Restaurar dados' }).click(); await pending;
  await expect(dialog).not.toBeVisible();
  expect((await cloud(page)).financeiro[0].nome).toBe('Receita restaurada');
  expect((await cloud(page)).ideias[0].id).toBe('idea');
});

test('restoring cents-only amounts preserves finance and fixed expenses after reload', async ({ page }) => {
  await mock(page); await page.locator('#settingsBtn').click();
  const candidate = fixture();
  candidate.financeiro = [
    { id: 'cent-income', nome: 'Receita em centavos', tipo: 'Entrada', status: 'Pago', prazo: '2026-09-02', pagoEm: '2026-09-02', valorCentavos: 12345 },
    { id: 'cent-expense', nome: 'Despesa em centavos', tipo: 'Saída', status: 'Pago', prazo: '2026-09-03', pagoEm: '2026-09-03', valorCentavos: '6789' }
  ];
  candidate.gastosFixos = [{ id: 'cent-fixed', nome: 'Gasto em centavos', dia: 10, status: 'Ativo', valorCentavos: '40025' }];
  await upload(page, A.makeBackup(candidate));
  const dialog = page.getByRole('dialog', { name: 'Revisar restauração' });
  await dialog.getByLabel('Digite RESTAURAR').fill('RESTAURAR');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Restaurar dados' }).click(); await pending;
  await expect(dialog).not.toBeVisible();
  const saved = await cloud(page);
  expect(saved.financeiro.map(row => row.valor)).toEqual([123.45, -67.89]);
  expect(saved.financeiro.map(row => row.valorCentavos)).toEqual([12345, 6789]);
  expect(saved.gastosFixos[0].valor).toBe(-400.25);
  expect(saved.gastosFixos[0].valorCentavos).toBe(40025);
  await page.reload();
  await expect(page.locator('.ceo-metrics')).toContainText('123,45');
  await expect(page.locator('.ceo-metrics')).toContainText('67,89');
  await expect(page.locator('.ceo-metrics')).toContainText('55,56');
});

test('a legacy complete backup preserves modern modules missing from that format', async ({ page }) => {
  await mock(page); await page.locator('#settingsBtn').click();
  const legacy = fixture(); delete legacy.ideias; delete legacy.investimentos; delete legacy.contractHistory;
  legacy.financeiro = [];
  await upload(page, legacy, 'backup-antigo.json');
  const dialog = page.getByRole('dialog', { name: 'Revisar restauração' });
  await expect(dialog).toContainText('formato anterior'); await expect(dialog).toContainText('Preservado');
  await dialog.getByLabel('Digite RESTAURAR').fill('RESTAURAR');
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Restaurar dados' }).click(); await pending;
  await expect(dialog).not.toBeVisible();
  const saved = await cloud(page); expect(saved.financeiro).toHaveLength(0); expect(saved.ideias[0].id).toBe('idea');
});

test('report and restore dialogs remain usable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page); await page.locator('#settingsBtn').click(); await page.locator('#monthlyBackupBtn').click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Mês do relatório')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Imprimir / PDF' })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/admin-report-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.locator('#settingsBtn').click(); await upload(page, A.makeBackup(fixture()));
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Digite RESTAURAR')).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/admin-restore-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect((await cloud(page)).financeiro).toHaveLength(3);
});
