const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});
const user = id => ({ id, email: `${id}@example.invalid` });
const company = (name, entry) => ({ ...structuredClone(seed), companyProfile: { nome: name }, financeiro: [{ ...seed.financeiro[0], nome: entry }] });
const spaces = role => ({ 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Minha empresa' }, { owner_id: 'shared-company', role, name: 'Empresa compartilhada' }] });
const rows = () => ({ 'shared-company': company('Empresa compartilhada', 'Receita da equipe'), 'account-b': company('Empresa B', 'Receita confidencial B'), 'account-c': company('Empresa C', 'Receita confidencial C') });

test('SIGNED_OUT clears financial data, state, dialogs, settings and detached callbacks', async ({ page }) => {
  await mock(page); await page.locator('.nav [data-module="financeiro"]').click();
  await page.getByRole('button', { name: 'Nova movimentação' }).click();
  await page.getByRole('dialog').getByLabel('Descrição', { exact: true }).fill('Rascunho privado');
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('.app')).not.toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#ceoWorkspace')).toBeEmpty();
  await expect(page.locator('#workspaceSection')).toBeEmpty();
  await expect(page.locator('#userEmail')).toBeEmpty();
  expect(await page.evaluate(() => ({ state, cloudUserId, cloudOwnerId, cloudSnapshot }))).toEqual({ state: null, cloudUserId: null, cloudOwnerId: null, cloudSnapshot: null });
  await expect(page.locator('body')).not.toContainText('Rascunho privado');
});

test('logging out in one tab clears another open tab with unsaved data', async ({ page, context }) => {
  await mock(page);
  const other = await context.newPage();
  await other.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await mock(other); await other.locator('.nav [data-module="financeiro"]').click();
  await other.getByRole('button', { name: 'Nova movimentação' }).click();
  await other.getByRole('dialog').getByLabel('Descrição', { exact: true }).fill('Somente nesta aba');
  await page.locator('#settingsBtn').click(); await page.locator('#logoutBtn').click();
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(other.locator('#authScreen')).toBeVisible();
  await expect(other.locator('dialog[open]')).toHaveCount(0);
  await expect(other.locator('#ceoWorkspace')).toBeEmpty();
  expect(await other.evaluate(() => state)).toBeNull();
  await other.close();
});

test('a late account read cannot replace the data from a newer signed-in account', async ({ page }) => {
  await mock(page, seed, { rows: rows() });
  await expect(page.locator('#ceoWorkspace')).toContainText('Projeto entregue');
  await page.evaluate(nextUser => { window.testDelayNextRead = true; window.testAuthEvent('SIGNED_IN', nextUser); }, user('account-b'));
  await page.clock.fastForward(1);
  await expect.poll(() => page.evaluate(() => window.testPendingReads.length)).toBe(1);
  await page.evaluate(nextUser => window.testAuthEvent('SIGNED_IN', nextUser), user('account-c'));
  await page.clock.fastForward(1);
  await expect(page.locator('#ceoWorkspace')).toContainText('Receita confidencial C');
  await page.evaluate(() => window.testReleaseReads());
  await expect.poll(() => page.evaluate(() => cloudUserId)).toBe('account-c');
  await expect(page.locator('#ceoWorkspace')).not.toContainText('Receita confidencial B');
  expect(await page.evaluate(() => state.companyProfile.nome)).toBe('Empresa C');
});

test('a late save response after sign-out never recreates the closed session', async ({ page }) => {
  await mock(page); await expect(page.locator('#ceoWorkspace')).toContainText('Projeto entregue');
  await page.evaluate(() => {
    window.testDelayNextWrite = true;
    window.testPendingCommit = ceoCommit(draft => { draft.companyProfile.nome = 'Resposta antiga'; });
  });
  await expect.poll(() => page.evaluate(() => window.testPendingWrites.length)).toBe(1);
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await page.evaluate(() => window.testReleaseWrites());
  expect(await page.evaluate(() => window.testPendingCommit)).toBe(false);
  expect(await page.evaluate(() => state)).toBeNull();
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('#ceoWorkspace')).toBeEmpty();
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('a delayed bootstrap session cannot reopen the app after SIGNED_OUT', async ({ page }) => {
  await mock(page, seed, { delayInitialSession: true });
  await expect.poll(() => page.evaluate(() => window.testPendingSessions.length)).toBe(1);
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await expect(page.locator('#authScreen')).toBeVisible();
  await page.evaluate(() => window.testReleaseSessions());
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('.app')).not.toBeVisible();
  expect(await page.evaluate(() => state)).toBeNull();
});

test('a delayed invitation refresh cannot replace the workspace list of a newer account', async ({ page }) => {
  await mock(page, seed, { workspaces: spaces('viewer'), rows: rows() });
  await page.locator('#settingsBtn').click();
  await page.evaluate(() => {
    sessionStorage.setItem('zama-pending-invite', 'a'.repeat(64));
    const rpc = supabaseClient.rpc.bind(supabaseClient);
    let delay = true;
    supabaseClient.rpc = async (name, params) => {
      const response = await rpc(name, params);
      if (name === 'zama_workspace_list' && delay) {
        delay = false;
        await new Promise(resolve => { window.testReleaseInviteList = resolve; });
      }
      return response;
    };
    ZamaWorkspace.render();
  });
  await page.getByRole('button', { name: 'Aceitar convite' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.testReleaseInviteList))).toBe(true);
  await page.evaluate(nextUser => window.testAuthEvent('SIGNED_IN', nextUser), user('account-b'));
  await page.clock.fastForward(1);
  await expect(page.locator('#ceoWorkspace')).toContainText('Receita confidencial B');
  await page.evaluate(() => window.testReleaseInviteList());
  await page.locator('#settingsBtn').click();
  await expect(page.getByLabel('Empresa em uso').locator('option')).toHaveCount(1);
  await expect(page.getByLabel('Empresa em uso')).toHaveValue('account-b');
});

for (const action of ['login', 'signup']) test(`a delayed ${action} cannot reopen the app after sign-out`, async ({ page }) => {
  await mock(page);
  await page.evaluate(action => {
    window.testAuthEvent('SIGNED_OUT');
    supabaseClient.auth[action === 'login' ? 'signInWithPassword' : 'signUp'] = () => new Promise(resolve => {
      window.testReleaseLogin = () => resolve({ data: { session: { user: { id: 'test-account', email: 'test@example.invalid' } } } });
    });
  }, action);
  await page.locator('#loginEmail').fill('test@example.invalid');
  await page.locator('#loginPassword').fill('example-password');
  await page.locator(action === 'login' ? '#loginSubmitBtn' : '#signupBtn').click();
  await expect.poll(() => page.evaluate(() => Boolean(window.testReleaseLogin))).toBe(true);
  await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
  await page.evaluate(() => window.testReleaseLogin());
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('.app')).not.toBeVisible();
  expect(await page.evaluate(() => ({ state, cloudUserId, cloudOwnerId }))).toEqual({ state: null, cloudUserId: null, cloudOwnerId: null });
});

test('viewer switches to the correct company and cannot save financial changes', async ({ page }) => {
  await mock(page, seed, { workspaces: spaces('viewer'), rows: rows() });
  await page.locator('#settingsBtn').click(); await page.getByLabel('Empresa em uso').selectOption('shared-company');
  await expect(page.locator('#ceoWorkspace')).toContainText('Receita da equipe');
  await expect(page.locator('#workspaceBadge')).toContainText('Somente leitura');
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#importBtn')).toBeDisabled();
  await expect(page.locator('#companyForm input').first()).toBeDisabled();
  await expect(page.locator('#resetBtn')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Gerar link de convite' })).toHaveCount(0);
  await page.locator('#settingsCloseBtn').click();
  await page.locator('.nav [data-module="financeiro"]').click();
  await expect(page.getByRole('button', { name: 'Editar Receita da equipe', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nova movimentação' })).toHaveCount(0);
  // The data boundary also rejects a stale callback from an earlier editor session.
  expect(await page.evaluate(() => ceoCommit(draft => { draft.financeiro[0].nome = 'Tentativa de alteração'; }))).toBe(false);
  await expect(page.locator('.toast').last()).toContainText('somente leitura');
  expect(await page.evaluate(() => window.testDbWrites.length)).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud:shared-company')).data.financeiro[0].nome)).toBe('Receita da equipe');
});

test('editor writes to the shared owner row and switching back restores the private company', async ({ page }) => {
  await mock(page, seed, { workspaces: spaces('editor'), rows: rows() });
  await page.locator('#settingsBtn').click(); await page.getByLabel('Empresa em uso').selectOption('shared-company');
  await expect(page.locator('#workspaceBadge')).toContainText('Pode editar');
  await page.locator('#settingsBtn').click();
  await page.locator('#companyForm [name="nome"]').fill('Equipe atualizada');
  await page.getByRole('button', { name: 'Salvar dados da empresa' }).click();
  await expect(page.locator('.toast').last()).toContainText('Dados salvos');
  expect(await page.evaluate(() => window.testDbWrites.at(-1).userId)).toBe('shared-company');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.companyProfile.nome)).toBe('ZAMA');
  await page.getByLabel('Empresa em uso').selectOption('test-account');
  await expect(page.locator('#ceoWorkspace')).toContainText('Projeto entregue');
  expect(await page.evaluate(() => cloudOwnerId)).toBe('test-account');
  await expect(page.locator('#workspaceBadge')).toContainText('Proprietário');
});

test('owner invitation uses an explicit role, private fragment link and revocation confirmation', async ({ page }) => {
  await mock(page, seed, { workspaces: spaces('viewer'), rows: rows() });
  await page.locator('#settingsBtn').click();
  await page.getByLabel('E-mail do convidado').fill('parceiro@example.invalid');
  await page.getByRole('combobox', { name: 'Permissão', exact: true }).selectOption('editor');
  await page.getByRole('button', { name: 'Gerar link de convite' }).click();
  const link = page.getByRole('textbox', { name: 'Link do convite' });
  await expect(link).toBeVisible();
  expect(await link.inputValue()).toMatch(/\/#invite=[a-f0-9]{64}$/);
  expect(await page.evaluate(() => window.testRpcCalls.find(call => call.name === 'zama_workspace_invite').params)).toEqual({ p_email: 'parceiro@example.invalid', p_role: 'editor' });
  await expect(page.locator('#workspaceSection')).toContainText('parceiro@example.invalid · Pode editar');
  await page.getByRole('button', { name: 'Revogar convite' }).click();
  await expect(page.locator('#confirmDialog')).toBeVisible();
  await page.locator('#confirmCancelBtn').click();
  expect(await page.evaluate(() => window.testRpcCalls.filter(call => call.name === 'zama_workspace_cancel_invite').length)).toBe(0);
  await page.getByRole('button', { name: 'Revogar convite' }).click(); await page.locator('#confirmOkBtn').click();
  await expect(page.getByRole('button', { name: 'Revogar convite' })).toHaveCount(0);
  await expect(link).toHaveCount(0);
  await expect(page.locator('#workspaceSection')).toContainText('Convite revogado.');
});

test('a late team permission failure cannot change a newer account settings', async ({ page }) => {
  await mock(page, seed, {
    workspaces: spaces('viewer'), rows: rows(),
    roster: { members: [{ user_id: 'project-member', email: 'equipe@example.invalid', role: 'editor' }], invites: [] }
  });
  await page.locator('#settingsBtn').click();
  await page.evaluate(() => {
    const original = supabaseClient.rpc.bind(supabaseClient);
    supabaseClient.rpc = (name, params) => name === 'zama_workspace_set_role'
      ? new Promise(resolve => { window.testReleaseRoleChange = () => resolve({ error: { message: 'Falha da empresa anterior.' } }); })
      : original(name, params);
  });
  await page.getByLabel('Permissão de equipe@example.invalid', { exact: true }).selectOption('projects');
  await page.evaluate(nextUser => window.testAuthEvent('SIGNED_IN', nextUser), user('account-b'));
  await page.clock.fastForward(1);
  await expect(page.locator('#ceoWorkspace')).toContainText('Receita confidencial B');
  await page.locator('#settingsBtn').click();
  await page.getByLabel('E-mail do convidado').fill('novo-time@example.invalid');
  await page.evaluate(() => window.testReleaseRoleChange());
  await expect(page.locator('#workspaceSection')).not.toContainText('Falha da empresa anterior.');
  await expect(page.getByLabel('E-mail do convidado')).toHaveValue('novo-time@example.invalid');
  await expect(page.getByLabel('Empresa em uso')).toHaveValue('account-b');
});

test('an older team roster response cannot hide a newly created projects invite', async ({ page }) => {
  await mock(page, seed, { workspaces: spaces('viewer'), rows: rows() });
  await page.locator('#settingsBtn').click();
  await page.evaluate(() => {
    const original = supabaseClient.rpc.bind(supabaseClient);
    let delay = true;
    supabaseClient.rpc = async (name, params) => {
      const result = await original(name, params);
      if (name === 'zama_workspace_roster' && delay) {
        delay = false;
        await new Promise(resolve => { window.testReleaseRoster = resolve; });
      }
      return result;
    };
    ZamaWorkspace.render();
  });
  await expect.poll(() => page.evaluate(() => Boolean(window.testReleaseRoster))).toBe(true);
  await page.getByLabel('E-mail do convidado').fill('projetos@example.invalid');
  await page.getByRole('button', { name: 'Gerar link de convite' }).click();
  await expect(page.getByRole('textbox', { name: 'Link do convite' })).toBeVisible();
  await page.evaluate(() => window.testReleaseRoster());
  await expect(page.getByRole('textbox', { name: 'Link do convite' })).toBeVisible();
  await expect(page.locator('.workspace-roster')).toContainText('projetos@example.invalid · Somente projetos');
});

test('revoking the current workspace closes unsaved dialogs and clears access without asking to keep it', async ({ page }) => {
  await mock(page, seed, { workspaces: spaces('editor'), rows: rows() });
  await page.locator('#settingsBtn').click(); await page.getByLabel('Empresa em uso').selectOption('shared-company');
  await expect(page.locator('#ceoWorkspace')).toContainText('Receita da equipe');
  await page.locator('.nav [data-module="financeiro"]').click();
  await page.getByRole('button', { name: 'Editar Receita da equipe', exact: true }).click();
  await page.evaluate(() => {
    window.testWorkspaceLists['test-account'] = window.testWorkspaceLists['test-account'].filter(item => item.owner_id === 'test-account');
    window.testRefreshAccess = ZamaWorkspace.refreshAccess();
  });
  await expect.poll(() => page.evaluate(() => cloudOwnerId)).toBe('test-account');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#confirmDialog')).not.toBeVisible();
  await expect(page.locator('#ceoWorkspace')).toContainText('Projeto entregue');
  await expect(page.locator('#ceoWorkspace')).not.toContainText('Receita da equipe');
});

test('invitation errors preserve the email and selected permission for retry', async ({ page }) => {
  await mock(page, seed, { workspaces: spaces('viewer'), rows: rows() });
  await page.locator('#settingsBtn').click();
  await page.getByLabel('E-mail do convidado').fill('parceiro@example.invalid');
  await page.getByRole('combobox', { name: 'Permissão', exact: true }).selectOption('editor');
  await page.evaluate(() => { window.testFailRpc = 'zama_workspace_invite'; });
  await page.getByRole('button', { name: 'Gerar link de convite' }).click();
  await expect(page.locator('#workspaceSection')).toContainText('Tente novamente');
  await expect(page.getByLabel('E-mail do convidado')).toHaveValue('parceiro@example.invalid');
  await expect(page.getByRole('combobox', { name: 'Permissão', exact: true })).toHaveValue('editor');
  await page.evaluate(() => { window.testFailRpc = ''; });
  await page.getByRole('button', { name: 'Gerar link de convite' }).click();
  await expect(page.getByRole('textbox', { name: 'Link do convite' })).toBeVisible();
});
