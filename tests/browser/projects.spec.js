const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const { mock, seed } = require('./mock-supabase');

const password = 'fixture-client-password-42';
const assigned = {
  id: 'd4da2553-1a44-4506-82bd-c12c399017c6', title: 'Catálogo Aurora', client_name: 'Ana Lima', company_name: 'Loja Aurora',
  client_email: 'ana@example.invalid', access_url: 'https://example.invalid/admin', responsible_email: 'test@example.invalid', responsible_name: 'Responsável de teste',
  status: 'in_progress', due_date: '2026-10-15', notes: 'Revisar as fotos dos produtos.', password, revision: 1,
  catalog_steps: [{ id: 'photos', label: 'Receber fotos dos produtos', done: false }, { id: 'publish', label: 'Publicar catálogo', done: false }],
  onboarding_steps: [{ id: 'structure', label: 'Estruturar o cliente', done: false }], created_at: '2026-09-28T15:00:00Z', updated_at: '2026-09-28T15:00:00Z'
};
const spaces = role => ({ 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Minha empresa' }, { owner_id: 'shared-company', role, name: 'Empresa compartilhada' }] });
const fixture = role => ({
  workspaces: spaces(role), projects: { 'test-account': [], 'shared-company': [assigned, { ...assigned, id: 'b1c31366-fbc7-4a81-9cc7-138677c12b81', title: 'Projeto reservado a outra pessoa', responsible_email: 'other@example.invalid', password: 'other-fixture-secret' }] },
  rows: { 'shared-company': { ...structuredClone(seed), companyProfile: { nome: 'Empresa compartilhada' }, financeiro: [{ ...seed.financeiro[0], nome: 'Receita confidencial da empresa' }] } }
});
const dialog = page => page.locator('#ceoProjectDialog');
const openProject = page => page.getByRole('button', { name: 'Abrir projeto Catálogo Aurora', exact: true }).click();
async function restricted(page, role = 'projects') {
  await page.addInitScript(() => sessionStorage.setItem('zama-workspace:test-account', 'shared-company'));
  await mock(page, seed, {jarvisVisible:true,...fixture(role)});
  if(role !== 'projects') await page.locator('.nav [data-module="projetos"]').click();
  await expect(page.getByRole('heading', { name: 'Projetos de clientes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir projeto Catálogo Aurora', exact: true })).toBeVisible();
}
async function noPersistedPassword(page) {
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state, cloudSnapshot }))).not.toContain(password);
}
async function ownerProjects(page, projects = [assigned], options = {}) {
  await mock(page, seed, { workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Minha empresa' }] }, projects: { 'test-account': projects }, ...options });
  if (page.viewportSize().width <= 720) await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
  await page.locator('.nav [data-module="projetos"]').click();
}

const accountPassword = 'Fixture-access-secret-2026!';
const accountEmail = 'person@example.invalid';
async function accountApi(page, { delayGet = false, delayPost = false, postError = null } = {}) {
  const calls = [], pending = [];
  async function respond(route, updateRoster = true) {
    if (route.request().method() === 'GET') return route.fulfill({ json: { enabled: true } });
    if (postError) return route.fulfill({ status: postError.status, json: { code: postError.code, error: postError.error } });
    const { email } = route.request().postDataJSON();
    if (updateRoster) await page.evaluate(address => { window.testWorkspaceRoster.members.push({ user_id: 'new-projects-user', email: address, role: 'projects' }); }, email);
    return route.fulfill({ status: 201, json: { created: true, email, role: 'projects', loginUrl: 'https://www.zam4.com/' } });
  }
  await page.route('**/api/project-access', async route => {
    calls.push({ method: route.request().method(), authorization: route.request().headers().authorization, body: route.request().postDataJSON() });
    if ((route.request().method() === 'GET' && delayGet) || (route.request().method() === 'POST' && delayPost)) { pending.push(route); return; }
    await respond(route);
  });
  return { calls, pending, respond };
}
async function openAccountForm(page, email = accountEmail) {
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill(email);
  await expect(dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true })).toBeEnabled();
}
async function fillAccountPassword(page, confirmation = accountPassword) {
  await dialog(page).getByLabel('Senha de acesso', { exact: true }).fill(accountPassword);
  await dialog(page).getByLabel('Confirmar senha', { exact: true }).fill(confirmation);
}
async function noPersistedAccountPassword(page) {
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state, cloudSnapshot, calls: window.testRpcCalls }))).not.toContain(accountPassword);
  expect(await page.content()).not.toContain(accountPassword);
}

test('direct project account creation exposes masked credentials only until copied or expired', async ({ page }, info) => {
  await ownerProjects(page, [{ ...assigned, responsible_email: accountEmail }]);
  const api = await accountApi(page);
  let copied = '';
  await page.exposeFunction('testCopyAccountCredentials', value => { copied = value; });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: value => window.testCopyAccountCredentials(value) } }));
  await openAccountForm(page, accountEmail.toUpperCase());
  await expect(dialog(page).locator('[data-team-preview]')).toContainText('Catálogo Aurora');
  await fillAccountPassword(page);
  await page.screenshot({ path: info.outputPath('project-account-form-desktop.png') });
  await dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true }).click();
  const secret = dialog(page).getByLabel('Senha cadastrada', { exact: true });
  await expect(secret).toHaveValue(accountPassword);
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(secret).toHaveAttribute('readonly', '');
  await expect(dialog(page).getByLabel('Senha de acesso', { exact: true })).toHaveValue('');
  await expect(dialog(page).getByLabel('Confirmar senha', { exact: true })).toHaveValue('');
  await expect(dialog(page).locator('[data-team-roster]')).toContainText(accountEmail);
  expect(api.calls).toEqual([{ method: 'GET', authorization: 'Bearer test-access-token', body: null }, { method: 'POST', authorization: 'Bearer test-access-token', body: { email: accountEmail, password: accountPassword } }]);
  expect(copied).toBe('');
  await noPersistedAccountPassword(page);
  await page.screenshot({ path: info.outputPath('project-account-success-desktop.png') });
  await dialog(page).getByRole('button', { name: 'Copiar dados de acesso', exact: true }).click();
  expect(copied).toBe(`Site: https://www.zam4.com/\nE-mail: ${accountEmail}\nSenha: ${accountPassword}`);
  await page.clock.fastForward(60001);
  await expect(secret).toHaveValue('');
  copied = '';
  await dialog(page).getByRole('button', { name: 'Dados de acesso copiados', exact: true }).click();
  await expect(dialog(page).locator('[data-team-notice]')).toContainText('senha já foi apagada');
  expect(copied).toBe('');
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill(accountEmail);
  await expect(dialog(page).getByRole('button', { name: 'Acesso já ativo', exact: true })).toBeDisabled();
  await expect(dialog(page).getByLabel('Senha cadastrada', { exact: true })).toHaveCount(0);
  await noPersistedAccountPassword(page);
});

test('direct project account validation blocks mismatched and oversized passwords but preserves manual invitations', async ({ page }) => {
  await ownerProjects(page);
  const api = await accountApi(page);
  await openAccountForm(page);
  await fillAccountPassword(page, 'Different-password-2026!');
  await dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('senhas não coincidem');
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  await dialog(page).getByLabel('Senha de acesso', { exact: true }).fill('é'.repeat(37));
  await dialog(page).getByLabel('Confirmar senha', { exact: true }).fill('é'.repeat(37));
  await dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('72 bytes');
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  await fillAccountPassword(page, 'Different-password-2026!');
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  await noPersistedAccountPassword(page);
});

test('direct project account existing-email conflict keeps the current account intact and offers invitation', async ({ page }) => {
  await ownerProjects(page);
  const api = await accountApi(page, { postError: { status: 409, code: 'ACCOUNT_EXISTS', error: 'Este e-mail já possui uma conta. A senha existente não foi alterada. Use o convite para vincular essa conta.' } });
  await openAccountForm(page);
  await fillAccountPassword(page);
  await dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('senha existente não foi alterada');
  await expect(dialog(page).getByLabel('Senha cadastrada', { exact: true })).toHaveCount(0);
  await expect(dialog(page).getByLabel('Senha de acesso', { exact: true })).toHaveValue('');
  await expect(dialog(page).getByLabel('Confirmar senha', { exact: true })).toHaveValue('');
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  await noPersistedAccountPassword(page);
});

test('direct project account controls never replace an existing member password', async ({ page }) => {
  await ownerProjects(page, [assigned], { roster: { members: [{ user_id: 'member-editor', email: accountEmail, role: 'editor' }], invites: [] } });
  const api = await accountApi(page);
  await openAccountForm(page, 'new-person@example.invalid');
  await fillAccountPassword(page);
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill(accountEmail);
  await expect(dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true })).not.toBeVisible();
  await expect(dialog(page).getByLabel('Senha de acesso', { exact: true })).toHaveValue('');
  await expect(dialog(page).getByLabel('Senha de acesso', { exact: true })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Limitar acesso a Projetos', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Acesso já ativo', exact: true })).toBeDisabled();
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
});

test('project access Enter creates an invitation when password accounts are unavailable', async ({ page }) => {
  await ownerProjects(page);
  const methods = [];
  page.on('request', request => { if (request.url().endsWith('/api/project-access')) methods.push(request.method()); });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  const email = dialog(page).getByLabel('E-mail da pessoa', { exact: true });
  await email.fill(accountEmail);
  await expect(dialog(page).locator('[data-team-capability]')).toContainText('indisponível');
  await expect(dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true })).toBeEnabled();
  await email.press('Enter');
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(methods).toEqual(['GET']);
});

test('project access Enter limits an existing member without creating a password account', async ({ page }) => {
  await ownerProjects(page, [assigned], { roster: { members: [{ user_id: 'member-editor', email: accountEmail, role: 'editor' }], invites: [] } });
  const api = await accountApi(page);
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  const email = dialog(page).getByLabel('E-mail da pessoa', { exact: true });
  await email.fill(accountEmail);
  await expect(dialog(page).getByRole('button', { name: 'Limitar acesso a Projetos', exact: true })).toBeEnabled();
  await email.press('Enter');
  await expect(dialog(page).getByRole('button', { name: 'Acesso já ativo', exact: true })).toBeDisabled();
  await expect(dialog(page).locator('[data-team-notice]')).toContainText('atualizado: somente Projetos');
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_workspace_set_role'))).toEqual([{ name: 'zama_workspace_set_role', params: { p_user: 'member-editor', p_role: 'projects' } }]);
});

test('project access Enter during capability loading creates only the visible invitation action', async ({ page }) => {
  await ownerProjects(page);
  const api = await accountApi(page, { delayGet: true });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  const email = dialog(page).getByLabel('E-mail da pessoa', { exact: true });
  await email.fill(accountEmail);
  await expect.poll(() => api.pending.length).toBe(1);
  await expect(dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true })).toBeEnabled();
  await expect(dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true })).not.toBeVisible();
  await email.press('Enter');
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  await api.respond(api.pending[0]);
  await expect(dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true })).toBeEnabled();
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  await expect(dialog(page).getByLabel('Senha cadastrada', { exact: true })).toHaveCount(0);
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
});

test('direct project account creation rejects a different authenticated session before sending a password', async ({ page }) => {
  await ownerProjects(page);
  const api = await accountApi(page);
  await openAccountForm(page);
  await fillAccountPassword(page);
  await page.evaluate(() => { supabaseClient.auth.getSession = async () => ({ data: { session: { access_token: 'different-token', user: { id: 'account-b' } } } }); });
  await dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('sessão expirou');
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
  await noPersistedAccountPassword(page);
});

for (const action of ['blur', 'close', 'switch account']) test(`direct project account late creation cannot reveal credentials after ${action}`, async ({ page }) => {
  await ownerProjects(page);
  const api = await accountApi(page, { delayPost: true });
  await openAccountForm(page);
  await fillAccountPassword(page);
  await dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true }).click();
  await expect.poll(() => api.pending.length).toBe(1);
  await expect(dialog(page).locator('[data-team-submit]')).toBeDisabled();
  await expect(dialog(page).locator('[data-team-create]')).toBeDisabled();
  if (action === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  else if (action === 'close') {
    await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  } else {
    await page.evaluate(() => window.testAuthEvent('SIGNED_IN', { id: 'account-b', email: 'account-b@example.invalid' }));
    await page.clock.fastForward(1);
    await expect.poll(() => page.evaluate(() => cloudUserId)).toBe('account-b');
  }
  await api.respond(api.pending[0], action === 'blur');
  if (action === 'blur') {
    await expect(dialog(page).getByLabel('Senha cadastrada', { exact: true })).toHaveValue('');
    await expect(dialog(page).locator('[data-team-notice]')).toContainText('já pode entrar');
  } else {
    await expect(page.getByLabel('Senha cadastrada', { exact: true })).toHaveCount(0);
    if (action === 'close') await expect(dialog(page).getByLabel('E-mail da pessoa', { exact: true })).toHaveValue('');
    else await expect(dialog(page)).toHaveCount(0);
  }
  expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  await noPersistedAccountPassword(page);
});

test('direct project account late capability response cannot enable a closed dialog', async ({ page }) => {
  await ownerProjects(page);
  const api = await accountApi(page, { delayGet: true });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await expect.poll(() => api.pending.length).toBe(1);
  await expect(dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true })).not.toBeVisible();
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await api.respond(api.pending[0]);
  await expect(dialog(page)).toHaveCount(0);
  expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
});

for (const width of [320, 390]) test(`direct project account credentials fit a ${width}px phone`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await ownerProjects(page);
  await accountApi(page);
  await openAccountForm(page, 'responsavel.producao.nome.completo@example.invalid');
  await fillAccountPassword(page);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog(page).getByRole('button', { name: 'Criar acesso com senha', exact: true }).click();
  await expect(dialog(page).getByLabel('Senha cadastrada', { exact: true })).toHaveValue(accountPassword);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`project-account-${width}.png`) });
});

test('owner builds multiple production lists, reorders stages and keeps the order after reload', async ({ page }) => {
  await ownerProjects(page, []);
  await page.getByRole('button', { name: '+ Novo projeto', exact: true }).click();
  await dialog(page).getByLabel('Nome do projeto', { exact: true }).fill('Produção sob medida');
  await dialog(page).getByLabel('Nome do cliente', { exact: true }).fill('Cliente de teste');
  const lists = dialog(page).locator('[data-production-list]');
  await expect(lists).toHaveCount(1);
  await expect(lists.locator('[data-step-id]')).toHaveCount(0);
  await lists.first().locator('[data-list-title]').fill('Gravação e edição');
  for (const label of ['Gravar depoimento', 'Editar vídeo', 'Revisar legendas']) {
    await lists.first().locator('[data-step-add]').click();
    await lists.first().locator('[data-step-label]').last().fill(label);
  }
  await lists.first().getByRole('checkbox', { name: 'Concluir etapa: Gravar depoimento', exact: true }).check();
  await lists.first().locator('[data-step-id]').first().locator('[data-step-down]').click();
  await expect.poll(() => lists.first().locator('[data-step-label]').evaluateAll(inputs => inputs.map(input => input.value))).toEqual(['Editar vídeo', 'Gravar depoimento', 'Revisar legendas']);
  await lists.first().locator('[data-step-id]').last().locator('[data-step-up]').click();
  await expect.poll(() => lists.first().locator('[data-step-label]').evaluateAll(inputs => inputs.map(input => input.value))).toEqual(['Editar vídeo', 'Revisar legendas', 'Gravar depoimento']);
  await dialog(page).locator('[data-list-add]').click();
  await lists.last().locator('[data-list-title]').fill('Entrega <final>');
  await lists.last().locator('[data-step-add]').click();
  await lists.last().locator('[data-step-label]').fill('Enviar arquivos ao cliente');
  await dialog(page).locator('[data-list-add]').click();
  await lists.last().locator('[data-list-title]').fill('Lista descartada');
  await lists.last().locator('[data-step-add]').click();
  await lists.last().locator('[data-step-label]').fill('Etapa descartada');
  await lists.last().locator('[data-list-remove]').click();
  await expect(lists).toHaveCount(2);
  await dialog(page).getByRole('button', { name: 'Criar projeto', exact: true }).click();
  await expect(dialog(page)).toContainText('Entrega <final>');
  await expect(dialog(page)).not.toContainText('Etapa descartada');
  const saved = await page.evaluate(() => window.testRpcCalls.findLast(call => call.name === 'zama_project_save').params.p_project.production_lists);
  expect(saved.map(list => list.title)).toEqual(['Gravação e edição', 'Entrega <final>']);
  expect(saved[0].steps.map(step => ({ label: step.label, done: step.done }))).toEqual([
    { label: 'Editar vídeo', done: false }, { label: 'Revisar legendas', done: false }, { label: 'Gravar depoimento', done: true }
  ]);
  await page.reload();
  await page.locator('.nav [data-module="projetos"]').click();
  await page.getByRole('button', { name: 'Abrir projeto Produção sob medida', exact: true }).click();
  await expect(dialog(page).locator('.ceo-project-detail-track')).toHaveCount(2);
  await expect(dialog(page).locator('.ceo-project-detail-track').first().locator('li')).toHaveText(['Editar vídeo', 'Revisar legendas', /Gravar depoimento/]);
  await dialog(page).getByRole('button', { name: 'Editar projeto', exact: true }).click();
  await expect.poll(() => lists.first().locator('[data-step-label]').evaluateAll(inputs => inputs.map(input => input.value))).toEqual(['Editar vídeo', 'Revisar legendas', 'Gravar depoimento']);
  await expect(lists.last().locator('[data-list-title]')).toHaveValue('Entrega <final>');
  await expect(lists.first().getByRole('checkbox', { name: 'Concluir etapa: Gravar depoimento', exact: true })).toBeChecked();
});

test('owner can save an empty production list and remove every list without restoring defaults', async ({ page }) => {
  await ownerProjects(page, []);
  await page.getByRole('button', { name: '+ Novo projeto', exact: true }).click();
  await dialog(page).getByLabel('Nome do projeto', { exact: true }).fill('Projeto para organizar depois');
  await dialog(page).getByLabel('Nome do cliente', { exact: true }).fill('Cliente de teste');
  await expect(dialog(page).locator('[data-step-id]')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Criar projeto', exact: true }).click();
  await expect(dialog(page).locator('.ceo-project-detail-track')).toHaveCount(1);
  await expect(dialog(page)).toContainText('Nenhuma etapa cadastrada.');
  await dialog(page).getByRole('button', { name: 'Editar projeto', exact: true }).click();
  await dialog(page).locator('[data-list-remove]').click();
  await dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(dialog(page).locator('.ceo-project-detail-track')).toHaveCount(0);
  expect(await page.evaluate(() => window.testRpcCalls.findLast(call => call.name === 'zama_project_save').params.p_project.production_lists)).toEqual([]);
  await page.reload();
  await page.locator('.nav [data-module="projetos"]').click();
  await page.getByRole('button', { name: 'Abrir projeto Projeto para organizar depois', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Editar projeto', exact: true }).click();
  await expect(dialog(page).locator('[data-production-list]')).toHaveCount(0);
  await expect(dialog(page).locator('[data-step-id]')).toHaveCount(0);
  await dialog(page).locator('[data-list-add]').click();
  await expect(dialog(page).locator('[data-production-list]')).toHaveCount(1);
});

test('explicitly empty manual lists do not bring back legacy catalog or onboarding stages', async ({ page }) => {
  await ownerProjects(page, [{ ...assigned, production_lists: [] }]);
  await openProject(page);
  await expect(dialog(page)).not.toContainText('Receber fotos dos produtos');
  await expect(dialog(page)).not.toContainText('Estruturar o cliente');
  await expect(dialog(page).locator('.ceo-project-detail-track')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Editar projeto', exact: true }).click();
  await expect(dialog(page).locator('[data-production-list]')).toHaveCount(0);
});

test('missing project database configuration shows a recoverable error and disables creation', async ({ page }) => {
  await mock(page, seed, {
    workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Minha empresa' }] },
    projects: { 'test-account': [] },
    projectRpcError: { code: 'PGRST202', message: 'Could not find public.zama_projects_list_v2 in the schema cache' }
  });
  await page.locator('.nav [data-module="projetos"]').click();
  await expect(page.locator('#ceoWorkspace').getByRole('alert')).toContainText('A configuração do banco de dados precisa ser concluída');
  await expect(page.getByRole('button', { name: '+ Novo projeto', exact: true })).toBeDisabled();
  await expect(page.locator('[data-project-board]')).toHaveCount(0);
  await page.evaluate(() => { window.testProjectRpcError = null; });
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ Novo projeto', exact: true })).toBeEnabled();
  await expect(page.locator('#ceoWorkspace').getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '+ Novo projeto', exact: true }).click();
  await expect(dialog(page).locator('[data-step-id]')).toHaveCount(0);
});

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});

test('projects-only access loads assigned projects without reading finance or exposing other modules', async ({ page }) => {
  const requests=[]; page.on('request',request=>requests.push(request.url()));
  await restricted(page);
  await expect(page.locator('#workspaceBadge')).toContainText('Somente projetos');
  await expect(page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Receita confidencial da empresa');
  await expect(page.locator('body')).not.toContainText('Projeto reservado a outra pessoa');
  for(const module of ['dashboard','financeiro','investimentos','agenda','ideias','jarvis']) await expect(page.locator(`.nav [data-module="${module}"]`)).not.toBeVisible();
  expect(await page.evaluate(() => window.testDbReads)).toEqual([]);
  expect(await page.evaluate(() => ceoCommit(draft => { draft.financeiro = [{ nome: 'Tentativa' }]; }))).toBe(false);
  await page.evaluate(() => goToModule('financeiro'));
  await expect(page.getByRole('heading', { name: 'Projetos de clientes' })).toBeVisible();
  await page.locator('#settingsBtn').click();
  for(const id of ['exportBtn','monthlyBackupBtn','legacyBackupBtn','importBtn','resetBtn']) await expect(page.locator(`#${id}`)).not.toBeVisible();
  const downloads=[]; page.on('download', value=>downloads.push(value));
  await page.evaluate(() => ['exportBtn','monthlyBackupBtn','legacyBackupBtn'].forEach(id=>document.getElementById(id).click()));
  expect(downloads).toHaveLength(0);
  expect(requests.filter(url=>/\/api\/(jarvis|reminders)/.test(url))).toEqual([]);
  await noPersistedPassword(page);
});

test('owner creates a projects-only invitation inside the project area and previews assigned projects', async ({ page }) => {
  await ownerProjects(page, [{ ...assigned, responsible_email: 'time@example.invalid' }]);
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Acesso somente a Projetos', exact: true })).toBeVisible();
  await expect(dialog(page).getByLabel('E-mail da pessoa', { exact: true })).toBeFocused();
  await expect(dialog(page).getByRole('combobox', { name: 'Permissão', exact: true })).toHaveCount(0);
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('TIME@EXAMPLE.INVALID');
  await expect(dialog(page).locator('[data-team-preview]')).toContainText('Catálogo Aurora');
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect(dialog(page).getByRole('textbox', { name: 'Link de acesso a Projetos', exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(await page.evaluate(() => window.testRpcCalls.find(call => call.name === 'zama_workspace_invite').params)).toEqual({ p_email: 'time@example.invalid', p_role: 'projects' });
  await expect(dialog(page)).toContainText(/senha/i);
  await expect(dialog(page)).toContainText(/aceit/i);
  await expect(dialog(page)).toContainText(/financ/i);
  await expect(page.locator('#settingsPanel')).not.toBeVisible();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('another-person@example.invalid');
  await expect(dialog(page).getByRole('textbox', { name: 'Link de acesso a Projetos', exact: true })).not.toBeVisible();
  await expect(dialog(page).locator('[data-team-preview]')).not.toContainText('Catálogo Aurora');
});

test('project access explains how to assign projects without granting unrelated projects', async ({ page }) => {
  await ownerProjects(page);
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('new-person@example.invalid');
  await expect(dialog(page).locator('[data-team-preview]')).toContainText(/E-mail do responsável/i);
  await expect(dialog(page).locator('[data-team-preview]')).not.toContainText('Catálogo Aurora');
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_project_save'))).toEqual([]);
});

test('project access lists only restricted members and invitations and supports revoking both', async ({ page }) => {
  await ownerProjects(page, [{ ...assigned, responsible_email: 'time@example.invalid' }, { ...assigned, id: 'b1c31366-fbc7-4a81-9cc7-138677c12b81', title: 'Produção futura', responsible_email: 'invited@example.invalid' }], {
    roster: {
      members: [{ user_id: 'member-projects', email: 'time@example.invalid', role: 'projects' }, { user_id: 'member-editor', email: 'editor@example.invalid', role: 'editor' }, { user_id: 'member-viewer', email: 'viewer@example.invalid', role: 'viewer' }],
      invites: [{ id: 'pending-projects', email: 'invited@example.invalid', role: 'projects' }, { id: 'pending-editor', email: 'future-editor@example.invalid', role: 'editor' }]
    }
  });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  const roster = dialog(page).locator('[data-team-roster]');
  await expect(roster.locator('[data-team-entry]')).toHaveCount(2);
  await expect(roster).not.toContainText('editor@example.invalid');
  await expect(roster).not.toContainText('viewer@example.invalid');
  const member = roster.locator('[data-team-entry]').filter({ hasText: 'time@example.invalid' });
  const invite = roster.locator('[data-team-entry]').filter({ hasText: 'invited@example.invalid' });
  await expect(member).toContainText('Catálogo Aurora');
  await expect(invite).toContainText('Produção futura');
  await member.getByRole('button', { name: 'Remover acesso', exact: true }).click();
  await expect(member.getByRole('button', { name: 'Confirmar remoção', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_workspace_revoke'))).toEqual([]);
  await member.getByRole('button', { name: 'Manter acesso', exact: true }).click();
  await expect(member.getByRole('button', { name: 'Remover acesso', exact: true })).toBeVisible();
  await member.getByRole('button', { name: 'Remover acesso', exact: true }).click();
  await member.getByRole('button', { name: 'Confirmar remoção', exact: true }).click();
  await expect(member).toHaveCount(0);
  expect(await page.evaluate(() => window.testRpcCalls.find(call => call.name === 'zama_workspace_revoke').params)).toEqual({ p_user: 'member-projects' });
  await invite.getByRole('button', { name: 'Cancelar convite', exact: true }).click();
  await expect(invite).toHaveCount(0);
  expect(await page.evaluate(() => window.testRpcCalls.find(call => call.name === 'zama_workspace_cancel_invite').params)).toEqual({ p_id: 'pending-projects' });
});

for (const role of ['editor', 'viewer']) test(`owner explicitly replaces existing ${role} access with projects-only access`, async ({ page }) => {
  await ownerProjects(page, [{ ...assigned, responsible_email: 'time@example.invalid' }], { roster: { members: [{ user_id: 'existing-member', email: 'time@example.invalid', role }], invites: [] } });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('TIME@example.invalid');
  await expect(dialog(page).getByRole('button', { name: 'Limitar acesso a Projetos', exact: true })).toBeEnabled();
  await expect(dialog(page)).toContainText(/acesso atual|acesso amplo|outros módulos/i);
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_workspace_set_role'))).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Limitar acesso a Projetos', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Acesso já ativo', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.testRpcCalls.find(call => call.name === 'zama_workspace_set_role').params)).toEqual({ p_user: 'existing-member', p_role: 'projects' });
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_workspace_invite'))).toEqual([]);
  await expect(dialog(page).locator('[data-team-roster] [data-team-entry]')).toContainText('time@example.invalid');
});

test('an existing projects-only member is marked active instead of receiving another invitation', async ({ page }) => {
  await ownerProjects(page, [{ ...assigned, responsible_email: 'time@example.invalid' }], { roster: { members: [{ user_id: 'existing-member', email: 'time@example.invalid', role: 'projects' }], invites: [] } });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('TIME@example.invalid');
  await expect(dialog(page).getByRole('button', { name: 'Acesso já ativo', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => ['zama_workspace_invite', 'zama_workspace_set_role'].includes(call.name)))).toEqual([]);
});

test('canceling a freshly generated project invitation also clears its displayed link', async ({ page }) => {
  await ownerProjects(page);
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('time@example.invalid');
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  const entry = dialog(page).locator('[data-team-entry]').filter({ hasText: 'time@example.invalid' });
  await entry.getByRole('button', { name: 'Cancelar convite', exact: true }).click();
  await expect(entry).toHaveCount(0);
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).not.toBeVisible();
});

test('roster failures prevent creating ambiguous project access and a reopened dialog can retry', async ({ page }) => {
  await ownerProjects(page);
  await page.evaluate(() => { window.testFailRpc = 'zama_workspace_roster'; });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText(/Não foi possível/i);
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('time@example.invalid');
  await expect(dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_workspace_invite'))).toEqual([]);
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await page.evaluate(() => { window.testFailRpc = ''; });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('time@example.invalid');
  await expect(dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true })).toBeEnabled();
});

test('a successful removal followed by a roster failure keeps new access disabled until refreshed', async ({ page }) => {
  await ownerProjects(page, [assigned], { roster: { members: [{ user_id: 'existing-member', email: 'time@example.invalid', role: 'projects' }], invites: [] } });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  const member = dialog(page).locator('[data-team-entry]').filter({ hasText: 'time@example.invalid' });
  await member.getByRole('button', { name: 'Remover acesso', exact: true }).click();
  await page.evaluate(() => { window.testFailRpc = 'zama_workspace_roster'; });
  await member.getByRole('button', { name: 'Confirmar remoção', exact: true }).click();
  await expect(dialog(page).locator('[data-team-notice]')).toContainText('Acesso removido');
  await expect(dialog(page).getByRole('alert')).toContainText(/Não foi possível/i);
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('new-person@example.invalid');
  await expect(dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.testFailRpc = ''; });
  await dialog(page).getByRole('button', { name: 'Atualizar acessos', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true })).toBeEnabled();
  await expect(member).toHaveCount(0);
});

for (const action of ['close', 'switch account']) test(`a late project invitation cannot populate a dialog after ${action}`, async ({ page }) => {
  await ownerProjects(page);
  await page.evaluate(() => {
    const rpc = supabaseClient.rpc.bind(supabaseClient);
    supabaseClient.rpc = async (name, params) => {
      const result = await rpc(name, params);
      if (name === 'zama_workspace_invite') await new Promise(resolve => { window.testReleaseTeamInvite = resolve; });
      return result;
    };
  });
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill('time@example.invalid');
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.testReleaseTeamInvite))).toBe(true);
  if (action === 'close') {
    await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
    await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
    await expect(dialog(page).getByLabel('E-mail da pessoa', { exact: true })).toHaveValue('');
  } else {
    await page.evaluate(() => window.testAuthEvent('SIGNED_IN', { id: 'account-b', email: 'account-b@example.invalid' }));
    await page.clock.fastForward(1);
    await expect.poll(() => page.evaluate(() => cloudUserId)).toBe('account-b');
    await expect(dialog(page)).toHaveCount(0);
  }
  await page.evaluate(() => window.testReleaseTeamInvite());
  await expect(page.getByLabel('Link de acesso a Projetos', { exact: true })).not.toBeVisible();
  if (action === 'close') await expect(dialog(page).getByLabel('E-mail da pessoa', { exact: true })).toHaveValue('');
  else await expect(dialog(page)).toHaveCount(0);
});

for (const width of [320, 390]) test(`projects-only access and invitation links fit a ${width}px phone`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const email = 'responsavel.producao.nome.completo@example.invalid';
  await ownerProjects(page, [{ ...assigned, responsible_email: email }]);
  await page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await dialog(page).getByLabel('E-mail da pessoa', { exact: true }).fill(email);
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width, height: 360 });
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`project-access-${width}.png`) });
});

test('viewer can follow assigned projects but cannot edit or reveal client passwords', async ({ page }) => {
  await restricted(page, 'viewer');
  await expect(page.locator('#ceoWorkspace').getByRole('button', { name: 'Criar acesso', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Novo projeto', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Projeto reservado a outra pessoa');
  await openProject(page);
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveValue('');
  for (const name of ['Mostrar senha', 'Atualizar andamento', 'Editar projeto', 'Excluir projeto', 'Gerenciar acesso do responsável']) {
    await expect(dialog(page).getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => ['zama_project_secret', 'zama_project_save'].includes(call.name)))).toEqual([]);
  await noPersistedPassword(page);
});

test('responsible person can customize legacy production lists and stages with persistence', async ({ page }) => {
  await restricted(page); await openProject(page);
  await expect(dialog(page).locator('.ceo-project-detail-track')).toHaveCount(2);
  await expect(dialog(page).locator('.ceo-project-detail-track').first()).toContainText('Catálogo');
  await expect(dialog(page).locator('.ceo-project-detail-track').last()).toContainText('Estruturação');
  await dialog(page).getByRole('button', { name: 'Atualizar andamento', exact: true }).click();
  const catalog = dialog(page).locator('[data-production-list]').first();
  await expect(catalog.locator('[data-list-title]')).toHaveValue('Catálogo');
  await catalog.locator('[data-list-title]').fill('Produção personalizada');
  await catalog.locator('[data-step-label]').first().fill('Revisar fotos recebidas');
  await catalog.getByRole('checkbox', { name: 'Concluir etapa: Revisar fotos recebidas', exact: true }).check();
  await catalog.getByRole('button', { name: 'Remover etapa: Publicar catálogo', exact: true }).click();
  await catalog.locator('[data-step-add]').click();
  await catalog.locator('[data-step-label]').last().fill('Aprovar capa com o cliente');
  await catalog.getByRole('checkbox', { name: 'Concluir etapa: Aprovar capa com o cliente', exact: true }).check();
  await dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(dialog(page)).toContainText('Revisar fotos recebidas');
  await expect(dialog(page)).toContainText('Aprovar capa com o cliente');
  await expect(dialog(page)).not.toContainText('Publicar catálogo');
  const savedLists = await page.evaluate(() => window.testRpcCalls.findLast(call => call.name === 'zama_project_save').params.p_project.production_lists);
  expect(savedLists.map(list => list.title)).toEqual(['Produção personalizada', 'Estruturação']);
  expect(savedLists[0].steps.map(step => ({ label: step.label, done: step.done }))).toEqual([
    { label: 'Revisar fotos recebidas', done: true }, { label: 'Aprovar capa com o cliente', done: true }
  ]);
  expect(savedLists[1].steps).toEqual(assigned.onboarding_steps);
  await page.reload(); await openProject(page);
  const stages = dialog(page).locator('.ceo-project-detail-track').first();
  await expect(stages).toContainText('Produção personalizada');
  await expect(stages.locator('progress')).toHaveAttribute('value', '2');
  await expect(stages.locator('progress')).toHaveAttribute('max', '2');
  await expect(stages).toContainText('Aprovar capa com o cliente');
});

test('owner can keep, replace and remove the client password without exposing it in storage', async ({ page }) => {
  await ownerProjects(page); await openProject(page);
  await dialog(page).getByRole('button', { name: 'Editar projeto', exact: true }).click();
  await expect(dialog(page).getByLabel('Nova senha (opcional)', { exact: true })).toHaveValue('');
  await dialog(page).getByLabel('Notas e próximos passos', { exact: true }).fill('Senha mantida ao atualizar o projeto.');
  await dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveValue(password);
  await dialog(page).getByRole('button', { name: 'Editar projeto', exact: true }).click();
  const replacement = 'replacement-client-password-43';
  await dialog(page).getByLabel('Nova senha (opcional)', { exact: true }).fill(replacement);
  await dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveValue(replacement);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state, cloudSnapshot }))).not.toContain(replacement);
  await dialog(page).getByRole('button', { name: 'Editar projeto', exact: true }).click();
  await dialog(page).getByLabel('Remover a senha cadastrada', { exact: true }).check();
  await expect(dialog(page).getByLabel('Nova senha (opcional)', { exact: true })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true })).toHaveCount(0);
  await page.reload(); await page.locator('.nav [data-module="projetos"]').click(); await openProject(page);
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveAttribute('placeholder', 'Não cadastrada');
  await expect(dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true })).toHaveCount(0);
  await noPersistedPassword(page);
});

test('responsible person updates both tracks and notes, with persistence across reload', async ({ page }) => {
  await restricted(page); await openProject(page);
  await expect(dialog(page).getByRole('button', { name: 'Editar projeto', exact: true })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Excluir projeto', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Atualizar andamento', exact: true }).click();
  await expect(dialog(page).locator('[name="client_name"]')).toHaveCount(0);
  await dialog(page).getByRole('checkbox', { name: 'Concluir etapa: Receber fotos dos produtos', exact: true }).check();
  await dialog(page).getByRole('checkbox', { name: 'Concluir etapa: Estruturar o cliente', exact: true }).check();
  await dialog(page).getByLabel('Situação do projeto', { exact: true }).selectOption('waiting');
  await dialog(page).getByLabel('Notas e próximos passos', { exact: true }).fill('Aguardando a aprovação das fotos.');
  await dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(dialog(page)).toContainText('Aguardando a aprovação das fotos.');
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(page.locator('[data-project-id]').first()).toContainText('67%');
  await page.reload(); await openProject(page);
  await expect(dialog(page)).toContainText('Aguardando a aprovação das fotos.');
  await expect(dialog(page)).toContainText('Aguardando cliente');
  expect(await page.evaluate(() => window.testDbWrites)).toEqual([]);
  await noPersistedPassword(page);
});

test('credentials are revealed on demand and cleared on hide, close, timeout and sign-out', async ({ page }) => {
  await restricted(page); await openProject(page);
  const secret=dialog(page).getByLabel('Senha do cliente', { exact: true });
  await expect(secret).toHaveValue('');
  expect(await page.evaluate(() => window.testRpcCalls.filter(call=>call.name==='zama_project_secret'))).toHaveLength(0);
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(secret).toHaveValue(password); await noPersistedPassword(page);
  await dialog(page).getByRole('button', { name: 'Ocultar senha', exact: true }).click();
  await expect(secret).toHaveValue('');
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(secret).toHaveValue(password);
  await page.clock.fastForward(60001); await expect(secret).toHaveValue('');
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(secret).toHaveValue(password);
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await openProject(page); await expect(secret).toHaveValue('');
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(secret).toHaveValue(password);
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await expect(dialog(page)).toHaveCount(0); await expect(page.locator('#ceoWorkspace')).toBeEmpty();
  await noPersistedPassword(page);
});

test('late credential responses cannot fill a closed or signed-out project dialog', async ({ page }) => {
  await restricted(page); await openProject(page);
  await page.evaluate(() => {window.testDelayNextProjectRpc='zama_project_secret';});
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testPendingProjectRpcs.length)).toBe(1);
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await openProject(page); await page.evaluate(() => window.testReleaseProjectRpcs());
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveValue('');
  await page.evaluate(() => {window.testDelayNextProjectRpc='zama_project_secret';});
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.testPendingProjectRpcs.length)).toBe(1);
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await page.evaluate(() => window.testReleaseProjectRpcs());
  await expect(dialog(page)).toHaveCount(0); await expect(page.locator('#ceoWorkspace')).toBeEmpty();
  await noPersistedPassword(page);
});

test('owner creates credentials and manual project stages, invites with projects role and excludes secrets from backup', async ({ page }) => {
  await mock(page, seed, { workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'}]},projects:{'test-account':[]} });
  await page.locator('.nav [data-module="projetos"]').click();
  await page.getByRole('button', { name: '+ Novo projeto', exact: true }).click();
  await dialog(page).getByLabel('Nome do projeto', { exact: true }).fill('Catálogo Aurora');
  await dialog(page).getByLabel('Nome do cliente', { exact: true }).fill('Ana Lima');
  await dialog(page).getByLabel('Nome da empresa', { exact: true }).fill('Loja Aurora');
  await dialog(page).getByLabel('E-mail de acesso', { exact: true }).fill('ana@example.invalid');
  await dialog(page).getByLabel('Senha do cliente', { exact: true }).fill(password);
  await dialog(page).getByLabel('Nome do responsável', { exact: true }).fill('Pedro');
  await dialog(page).getByLabel('E-mail do responsável', { exact: true }).fill('pedro@example.invalid');
  const list = dialog(page).locator('[data-production-list]');
  await expect(list).toHaveCount(1);
  await expect(list.locator('[data-list-title]')).toHaveValue('Lista de produção');
  await expect(list.locator('[data-step-id]')).toHaveCount(0);
  await list.locator('[data-list-title]').fill('Identidade visual');
  await list.locator('[data-step-add]').click();
  await list.locator('[data-step-label]').fill('Definir paleta de cores');
  await list.getByRole('checkbox', { name: 'Concluir etapa: Definir paleta de cores', exact: true }).check();
  await dialog(page).getByRole('button', { name: 'Criar projeto', exact: true }).click();
  await expect(dialog(page)).toContainText('Loja Aurora');
  await expect(dialog(page)).toContainText('Identidade visual');
  await expect(dialog(page)).toContainText('Definir paleta de cores');
  const createdLists = await page.evaluate(() => window.testRpcCalls.find(call => call.name === 'zama_project_save').params.p_project.production_lists);
  expect(createdLists).toEqual([{ id: expect.any(String), title: 'Identidade visual', steps: [{ id: expect.any(String), label: 'Definir paleta de cores', done: true }] }]);
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveValue('');
  await dialog(page).getByRole('button', { name: 'Gerenciar acesso do responsável', exact: true }).click();
  await expect(dialog(page).getByLabel('E-mail da pessoa', { exact: true })).toHaveValue('pedro@example.invalid');
  await dialog(page).getByRole('button', { name: 'Gerar link de acesso', exact: true }).click();
  await expect(dialog(page).getByLabel('Link de acesso a Projetos', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(await page.evaluate(() => window.testRpcCalls.find(call=>call.name==='zama_workspace_invite').params)).toEqual({p_email:'pedro@example.invalid',p_role:'projects'});
  await dialog(page).getByRole('button', { name: 'Fechar', exact: true }).click();
  await noPersistedPassword(page);
  await page.locator('#settingsBtn').click();
  const pending=page.waitForEvent('download'); await page.locator('#exportBtn').click();
  const download=await pending, backup=await readFile(await download.path(),'utf8');
  expect(backup).not.toContain(password); expect(backup).not.toContain('Loja Aurora');
  await page.locator('#settingsCloseBtn').click();
  await page.reload(); await page.locator('.nav [data-module="projetos"]').click(); await openProject(page);
  await dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveValue(password);
});

test('a live role downgrade clears shared finance, its cache and unsaved dialogs', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('zama-workspace:test-account', 'shared-company'));
  await mock(page, seed, fixture('editor'));
  await expect(page.locator('#ceoWorkspace')).toContainText('Receita confidencial da empresa');
  await page.locator('.nav [data-module="financeiro"]').click();
  await page.getByRole('button', { name: 'Editar Receita confidencial da empresa', exact: true }).click();
  await page.evaluate(() => {
    window.testWorkspaceLists['test-account'].find(item=>item.owner_id==='shared-company').role='projects';
    window.testDbReads=[]; window.testRefreshProjectsRole=ZamaWorkspace.refreshAccess();
  });
  await expect(page.getByRole('heading', { name: 'Projetos de clientes' })).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Receita confidencial da empresa');
  expect(await page.evaluate(() => ({ finance:state.financeiro, reads:window.testDbReads, cached:Object.keys(localStorage).filter(key=>!key.startsWith('test-')).map(key=>localStorage.getItem(key)).join('') }))).toEqual({ finance:[], reads:[], cached:expect.not.stringContaining('Receita confidencial da empresa') });
});

test('accepting a projects invite while using the same company replaces previous financial access', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('zama-workspace:test-account', 'shared-company'));
  await mock(page, seed, fixture('editor'));
  await expect(page.locator('#ceoWorkspace')).toContainText('Receita confidencial da empresa');
  await page.locator('#settingsBtn').click();
  await page.evaluate(() => {
    sessionStorage.setItem('zama-pending-invite','a'.repeat(64));
    const original=supabaseClient.rpc.bind(supabaseClient);
    supabaseClient.rpc=async(name,params)=>{
      const result=await original(name,params);
      if(name==='zama_workspace_accept') window.testWorkspaceLists['test-account'].find(item=>item.owner_id==='shared-company').role='projects';
      return result;
    };
    ZamaWorkspace.render();
  });
  await page.getByRole('button', {name:'Aceitar convite',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Projetos de clientes'})).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Receita confidencial da empresa');
  expect(await page.evaluate(()=>state.financeiro)).toEqual([]);
  await expect(page.locator('.nav [data-module="financeiro"]')).not.toBeVisible();
});

test('failed saves preserve project edits for retry and late list responses cannot reopen a signed-out workspace', async ({ page }) => {
  await restricted(page); await openProject(page);
  await dialog(page).getByRole('button', {name:'Atualizar andamento',exact:true}).click();
  await dialog(page).getByLabel('Notas e próximos passos', {exact:true}).fill('Andamento preservado para nova tentativa.');
  await page.evaluate(()=>{window.testFailRpc='zama_project_save';});
  await dialog(page).getByRole('button', {name:'Salvar alterações',exact:true}).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Não foi possível');
  await expect(dialog(page).getByLabel('Notas e próximos passos', {exact:true})).toHaveValue('Andamento preservado para nova tentativa.');
  await page.evaluate(()=>{window.testFailRpc='';});
  await dialog(page).getByRole('button', {name:'Salvar alterações',exact:true}).click();
  await expect(dialog(page)).toContainText('Andamento preservado para nova tentativa.');
  await dialog(page).getByRole('button', {name:'Fechar',exact:true}).click();
  await page.evaluate(()=>{window.testDelayNextProjectRpc='zama_projects_list_v2';});
  await page.getByRole('button', {name:'Atualizar',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.testPendingProjectRpcs.length)).toBe(1);
  await page.evaluate(()=>window.testAuthEvent('SIGNED_OUT'));
  await page.evaluate(()=>window.testReleaseProjectRpcs());
  await expect(page.locator('#ceoWorkspace')).toBeEmpty();
  await expect(page.locator('#authScreen')).toBeVisible();
});

test('project board renders representative desktop and mobile cards', async ({ page }, info) => {
  const projects=[assigned,{...assigned,id:'e1c31366-fbc7-4a81-9cc7-138677c12b81',title:'Campanha · Café Botânico',company_name:'Café Botânico',client_name:'Lucas Santos',status:'waiting',responsible_name:'Mariana',production_lists:[{id:'video',title:'Vídeos para aprovação',steps:[{id:'shoot',label:'Gravar os produtos',done:true},{id:'edit',label:'Editar os vídeos',done:true}]},{id:'deliver',title:'Entrega final',steps:[{id:'approve',label:'Aprovar com o cliente',done:false}]}]},{...assigned,id:'f1c31366-fbc7-4a81-9cc7-138677c12b81',title:'Identidade visual · Estúdio Clara',company_name:'Estúdio Clara',client_name:'Clara Souza',status:'planning',responsible_name:'Pedro',production_lists:[{id:'design',title:'Design',steps:[]}]}].map(({password,...row})=>row);
  await mock(page,seed,{workspaces:{'test-account':[{owner_id:'test-account',role:'owner',name:'Minha empresa'}]},projects:{'test-account':projects}});
  await page.locator('.nav [data-module="projetos"]').click();
  await expect(page.locator('[data-project-id]')).toHaveCount(3);
  await page.screenshot({path:info.outputPath('projects-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('projects-mobile.png'),fullPage:true});
});

for(const width of [320,390]) test(`project progress and credential dialog fit a ${width}px phone`, async ({ page }, info) => {
  await page.setViewportSize({width,height:844}); await restricted(page); await openProject(page);
  await expect(dialog(page).getByRole('button', { name: 'Mostrar senha', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await dialog(page).evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await dialog(page).getByRole('button', { name: 'Atualizar andamento', exact: true }).click();
  await expect(dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true })).toBeInViewport({ratio:1});
  await page.setViewportSize({width,height:360});
  await expect(dialog(page).getByRole('button', { name: 'Salvar alterações', exact: true })).toBeInViewport({ratio:1});
  expect(await dialog(page).evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`projects-${width}-keyboard.png`)});
});
