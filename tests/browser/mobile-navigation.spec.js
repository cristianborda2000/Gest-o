const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

const nav = page => page.getByRole('navigation', { name: 'Navegação rápida' });
const launcher = page => page.getByRole('button', { name: 'Adicionar registro', exact: true });
async function create(page, label) {
  await launcher(page).click();
  await page.locator('#mobileCreateDialog').getByRole('button', { name: label }).click();
}
async function team(page, role = 'projects') {
  await mock(page, structuredClone(seed), {
    workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Minha empresa' }, { owner_id: 'shared-company', role, name: 'ZAMA equipe' }] },
    rows: { 'shared-company': { ...structuredClone(seed), ideias: [{ ...seed.ideias[0], titulo: 'Ideia da equipe' }] } },
    projects: { 'shared-company': [] },
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/@vite/client', route => route.abort());
});

test('phone shortcuts navigate, open the full menu and fit a 320px screen', async ({ page }, info) => {
  await mock(page);
  await expect(nav(page)).toBeVisible();
  await expect(nav(page).locator('button')).toHaveText(['Início', 'Agenda', 'Novo', 'Projetos', 'Finanças', 'Mais']);
  await expect(nav(page).getByRole('button', { name: 'Início', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav(page).getByRole('button', { name: 'Agenda', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-module', 'agenda');
  await expect(nav(page).getByRole('button', { name: 'Agenda', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav(page).getByRole('button', { name: 'Mais opções', exact: true }).click();
  await expect(page.locator('#ceoSidebar')).toHaveAttribute('aria-modal', 'true');
  await expect(nav(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(nav(page).getByRole('button', { name: 'Mais opções', exact: true })).toBeFocused();
  await nav(page).getByRole('button', { name: 'Mais opções', exact: true }).click();
  await page.locator('.nav [data-module="ideias"]').click();
  await expect(nav(page).getByRole('button', { name: 'Mais opções', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav(page).getByRole('button', { name: 'Início', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const box of await nav(page).locator('button').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath('mobile-home-320.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(nav(page)).toBeHidden();
  await expect(launcher(page)).toBeHidden();
});

test('the create action stays inside the dock and the last content scrolls above it', async ({ page }, info) => {
  await mock(page);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 });
    const dock = await nav(page).boundingBox();
    const add = await launcher(page).boundingBox();
    expect(add.y).toBeGreaterThanOrEqual(dock.y);
    expect(add.y + add.height).toBeLessThanOrEqual(dock.y + dock.height);
    expect(add.width).toBeGreaterThanOrEqual(44);
    expect(add.height).toBeGreaterThanOrEqual(44);
    expect(dock.y + dock.height).toBe(700);
    expect(await nav(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const font of await nav(page).locator('button').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)))) expect(font).toBeGreaterThanOrEqual(11);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastContent = await page.locator('.ceo-footnote').boundingBox();
    expect(lastContent.y + lastContent.height).toBeLessThanOrEqual(dock.y);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`mobile-dock-${width}.png`) });
  }
});

test('quick task uses the existing editor, saves and restores the mobile controls', async ({ page }) => {
  await mock(page);
  await create(page, 'Nova tarefa');
  const dialog = page.locator('dialog.za-dialog');
  await expect(dialog).toBeVisible();
  await expect(nav(page)).toBeHidden();
  await expect(page.locator('#mobileCreateDialog')).toHaveCount(0);
  await dialog.locator('[name="nome"]').fill('Tarefa pelo atalho');
  await expect(dialog.locator('[name="prazo"]')).toHaveValue('2026-09-29');
  await dialog.getByRole('button', { name: 'Salvar tarefa', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(nav(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.agenda.some(row => row.nome === 'Tarefa pelo atalho'))).toBe(true);
});

test('quick actions open finance and ideas from another module, with escape focus return', async ({ page }, info) => {
  await mock(page);
  await launcher(page).click();
  await expect(page.locator('#mobileCreateDialog')).toBeVisible();
  await page.screenshot({ path: info.outputPath('quick-create-390.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#mobileCreateDialog')).toHaveCount(0);
  await expect(launcher(page)).toBeFocused();
  await create(page, 'Nova movimentação');
  await expect(page.locator('dialog.ceo-dialog')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-module', 'financeiro');
  await page.locator('dialog.ceo-dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
  await create(page, 'Nova ideia');
  await expect(page.locator('#ceoIdeaDialog')).toBeVisible();
  await page.locator('#ceoIdeaDialog').getByLabel('Título', { exact: true }).fill('Ideia pelo atalho');
  await page.locator('#ceoIdeaDialog').getByRole('button', { name: 'Salvar ideia', exact: true }).click();
  await expect(page.locator('#ceoWorkspace')).toContainText('Ideia pelo atalho');
  await page.locator('#settingsBtn').click();
  await expect(nav(page)).toBeHidden();
  await page.locator('#settingsCloseBtn').click();
  await expect(nav(page)).toBeVisible();
});

test('team shortcuts respect scope and quick ideas save to the shared company', async ({ page }) => {
  await team(page);
  await expect(nav(page).locator('button')).toHaveText(['Agenda', 'Projetos', 'Novo', 'Ideias', 'Mais']);
  await launcher(page).click();
  await expect(page.locator('[data-mobile-new="financeiro"]')).toHaveCount(0);
  await page.locator('[data-mobile-new="ideias"]').click();
  const dialog = page.locator('#ceoIdeaDialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Título', { exact: true }).fill('Ideia compartilhada pelo atalho');
  await dialog.getByRole('button', { name: 'Salvar ideia', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const result = await page.evaluate(() => ({ own: JSON.parse(localStorage.getItem('test-cloud')).data, company: JSON.parse(localStorage.getItem('test-cloud:shared-company')).data }));
  expect(result.company.ideias.some(idea => idea.titulo === 'Ideia compartilhada pelo atalho')).toBe(true);
  expect(result.own.ideias.some(idea => idea.titulo === 'Ideia compartilhada pelo atalho')).toBe(false);
});

test('viewer gets only a private task action and logout removes open quick actions', async ({ page }) => {
  await team(page, 'viewer');
  await launcher(page).click();
  await expect(page.locator('[data-mobile-new]')).toHaveCount(1);
  await expect(page.locator('[data-mobile-new]')).toHaveAttribute('data-mobile-new', 'agenda');
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('#mobileCreateDialog')).toHaveCount(0);
  await expect(nav(page)).toBeHidden();
});

test('a delayed shared idea load cannot open an editor after navigation or logout', async ({ page }) => {
  await team(page);
  await page.evaluate(() => {
    const rpc = supabaseClient.rpc.bind(supabaseClient);
    supabaseClient.rpc = async (name, params) => {
      const result = await rpc(name, params);
      if (name === 'zama_team_ideas_get') await new Promise(resolve => { window.releaseQuickIdeas = resolve; });
      return result;
    };
  });
  await create(page, 'Nova ideia');
  await expect.poll(() => page.evaluate(() => Boolean(window.releaseQuickIdeas))).toBe(true);
  await nav(page).getByRole('button', { name: 'Agenda', exact: true }).click();
  await page.evaluate(() => window.releaseQuickIdeas());
  await expect(page.locator('#ceoIdeaDialog')).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-module', 'agenda');
  await launcher(page).click();
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await expect(page.locator('#mobileCreateDialog')).toHaveCount(0);
  await expect(page.locator('#authScreen')).toBeVisible();
});

test('opening the full menu cancels an idea shortcut still waiting for shared data', async ({ page }) => {
  await team(page);
  await page.evaluate(() => {
    const rpc = supabaseClient.rpc.bind(supabaseClient);
    supabaseClient.rpc = async (name, params) => {
      const result = await rpc(name, params);
      if (name === 'zama_team_ideas_get') await new Promise(resolve => { window.releaseQuickIdeas = resolve; });
      return result;
    };
  });
  await create(page, 'Nova ideia');
  await expect.poll(() => page.evaluate(() => Boolean(window.releaseQuickIdeas))).toBe(true);
  await page.locator('#ceoMenuBtn').click();
  await page.evaluate(() => window.releaseQuickIdeas());
  await expect(page.locator('[data-idea-new]')).toBeAttached();
  await expect(page.locator('#ceoIdeaDialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(nav(page)).toBeVisible();
  await expect(page.locator('#ceoIdeaDialog')).toHaveCount(0);
});
