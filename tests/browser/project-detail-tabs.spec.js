const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

const password = 'fixture-tabs-password';
const project = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Identidade visual Aurora',
  client_name: 'Marina Costa', company_name: 'Aurora Studio',
  responsible_name: 'Ana Oliveira', responsible_email: 'test@example.invalid',
  client_email: 'equipe.producao.aurora@example.invalid', access_url: 'https://example.invalid/acesso',
  client_phone: '+5511999999999', password, status: 'in_progress', due_date: '2026-10-15',
  notes: 'Apresentar a proposta ao cliente e registrar a aprovação antes de finalizar os arquivos.',
  revision: 1, updated_at: '2026-09-28T15:00:00Z',
  production_lists: [
    { id: 'design', title: 'Criação e aprovação', status: 'in_progress', responsible_name: 'Ana Oliveira',
      due_date: '2026-10-08', description: 'Revisar as referências aprovadas.\nPreparar a apresentação com as aplicações da marca.',
      links: [{ label: 'Briefing e referências', url: 'https://example.invalid/briefing' }],
      steps: [{ id: 'briefing', label: 'Aprovar briefing', done: true }, { id: 'proposal', label: 'Apresentar proposta', done: false, due_date: '2026-10-05' }] },
    { id: 'delivery', title: 'Entrega dos arquivos', status: 'waiting', responsible_name: 'Pedro Souza',
      due_date: '2026-10-15', description: 'Organizar as versões finais e conferir os formatos de exportação.',
      steps: [{ id: 'export', label: 'Exportar arquivos finais', done: false }] }
  ]
};
const dialog = page => page.getByRole('dialog', { name: project.title, exact: true });
const tab = (page, name) => dialog(page).getByRole('tab', { name, exact: true });
async function setup(page) {
  await mock(page, seed, {
    workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'ZAMA' }] },
    projects: { 'test-account': [project] }
  });
  if (page.viewportSize().width <= 720) await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
  await page.locator('.nav [data-module="projetos"]').click();
  await page.getByRole('button', { name: `Abrir projeto ${project.title}`, exact: true }).click();
}

test('project tabs open the summary and support keyboard navigation without losing project context', async ({ page }) => {
  await setup(page);
  await expect(tab(page, 'Resumo')).toHaveAttribute('aria-selected', 'true');
  await expect(dialog(page).getByRole('tabpanel')).toHaveCount(1);
  await expect(dialog(page).getByRole('tabpanel', { name: 'Resumo' })).toContainText(project.notes);
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(0);
  await tab(page, 'Resumo').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Processos')).toBeFocused();
  await expect(dialog(page).getByRole('tabpanel', { name: 'Processos' })).toBeVisible();
  await expect(dialog(page).getByRole('checkbox', { name: 'Concluir etapa: Apresentar proposta', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(tab(page, 'Acessos')).toBeFocused();
  await expect(dialog(page).getByRole('tabpanel', { name: 'Acessos' })).toContainText(project.client_email);
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Resumo')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Acessos')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab(page, 'Resumo')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog(page).getByRole('tabpanel', { name: 'Resumo' })).toBeFocused();
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_project_secret'))).toEqual([]);
});

test('changing tabs cancels a pending password reveal and clears an already revealed password', async ({ page }) => {
  await setup(page);
  await tab(page, 'Acessos').click();
  const input = dialog(page).getByLabel('Senha do cliente', { exact: true });
  await page.evaluate(() => { window.testDelayNextProjectRpc = 'zama_project_secret'; });
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testPendingProjectRpcs.length)).toBe(1);
  await tab(page, 'Resumo').click();
  await tab(page, 'Acessos').click();
  await page.evaluate(() => window.testReleaseProjectRpcs());
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('type', 'password');
  await expect(dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true })).toBeEnabled();
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(input).toHaveValue(password);
  await tab(page, 'Processos').click();
  await expect(input).toHaveValue('');
  await tab(page, 'Acessos').click();
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('type', 'password');
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state, cloudSnapshot }))).not.toContain(password);
});

test('a step save preserves the selected tab and updates the summary progress and next step', async ({ page }) => {
  await setup(page);
  await expect(dialog(page).locator('[data-detail-overview] progress')).toHaveAttribute('value', '1');
  await tab(page, 'Processos').click();
  await dialog(page).getByRole('checkbox', { name: 'Concluir etapa: Apresentar proposta', exact: true }).check();
  await expect(dialog(page).getByRole('button', { name: 'Editar projeto', exact: true })).toBeEnabled();
  await expect(tab(page, 'Processos')).toHaveAttribute('aria-selected', 'true');
  await expect(dialog(page).getByRole('checkbox', { name: 'Concluir etapa: Apresentar proposta', exact: true })).toBeChecked();
  await tab(page, 'Resumo').click();
  await expect(dialog(page).locator('[data-detail-overview] progress')).toHaveAttribute('value', '2');
  await expect(dialog(page).locator('[data-detail-overview]')).toContainText('Exportar arquivos finais');
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.reload();
  await page.locator('.nav [data-module="projetos"]').click();
  await page.getByRole('button', { name: `Abrir projeto ${project.title}`, exact: true }).click();
  await expect(dialog(page).locator('[data-detail-overview] progress')).toHaveAttribute('value', '2');
});

for (const width of [1440, 320]) test(`project tabs and content fit a ${width}px screen`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await setup(page);
  for (const [name, slug] of [['Resumo', 'summary'], ['Processos', 'processes'], ['Acessos', 'access']]) {
    await tab(page, name).click();
    const panel = dialog(page).getByRole('tabpanel', { name, exact: true });
    await expect(panel).toBeVisible();
    await expect(dialog(page).getByRole('tabpanel')).toHaveCount(1);
    for (const target of [dialog(page), panel, tab(page, name)]) {
      const box = await target.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await target.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    expect((await tab(page, name).boundingBox()).height).toBeGreaterThanOrEqual(44);
    await dialog(page).evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath(`${slug}-${width}.png`) });
  }
});
