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
async function ownerProjects(page, projects = [assigned]) {
  await mock(page, seed, { workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Minha empresa' }] }, projects: { 'test-account': projects } });
  if (page.viewportSize().width <= 720) await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
  await page.locator('.nav [data-module="projetos"]').click();
}

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
  await expect(page.getByRole('button', { name: 'Acesso do time', exact: true })).toHaveCount(0);
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

test('owner opens team access from projects and invites with projects-only access by default', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ownerProjects(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Acesso do time', exact: true }).click();
  await expect(page.getByLabel('E-mail do convidado')).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Permissão', exact: true })).toHaveValue('projects');
  await page.getByLabel('E-mail do convidado').fill('time@example.invalid');
  await page.getByRole('button', { name: 'Gerar link de convite', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Link do convite', exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
  expect(await page.evaluate(() => window.testRpcCalls.find(call => call.name === 'zama_workspace_invite').params)).toEqual({ p_email: 'time@example.invalid', p_role: 'projects' });
});

test('viewer can follow assigned projects but cannot edit or reveal client passwords', async ({ page }) => {
  await restricted(page, 'viewer');
  await expect(page.getByRole('button', { name: 'Acesso do time', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Novo projeto', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Projeto reservado a outra pessoa');
  await openProject(page);
  await expect(dialog(page).getByLabel('Senha do cliente', { exact: true })).toHaveValue('');
  for (const name of ['Mostrar senha', 'Atualizar andamento', 'Editar projeto', 'Excluir projeto', 'Gerar convite para projetos']) {
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
  await dialog(page).getByRole('button', { name: 'Gerar convite para projetos', exact: true }).click();
  await expect(dialog(page).getByLabel('Link de acesso do responsável', { exact: true })).toHaveValue(/#invite=[a-f0-9]{64}$/);
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
