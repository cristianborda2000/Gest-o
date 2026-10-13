const { test, expect } = require('@playwright/test');
const { mock, seed } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  await page.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
});

const devices = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 320, height: 360 },
  { width: 390, height: 360 }
];
const memberEmail = 'colaborador.com.sobrenome.muito.longo@empresa-compartilhada.example';
const fixtures = {
  workspaces: { 'test-account': [{ owner_id: 'test-account', role: 'owner', name: 'Empresa com nome completo para equipe e colaboradores' }] },
  roster: {
    members: [{ user_id: 'colleague', email: memberEmail, role: 'editor' }],
    invites: [{ id: 'pending', email: 'convidado.com.nome.completo@empresa-compartilhada.example', role: 'viewer' }]
  }
};

async function expectUsableControls(scope) {
  const controls = await scope.locator('input:not([type="hidden"]):visible, select:visible, button:visible').evaluateAll(elements => elements.map(el => {
    const bounds = el.getBoundingClientRect();
    return { label: el.getAttribute('aria-label') || el.name || el.id || el.textContent.trim(), height: bounds.height, font: parseFloat(getComputedStyle(el).fontSize), field: /INPUT|SELECT/.test(el.tagName) };
  }));
  for (const control of controls) {
    // DOMRect coordinates can lose floating-point precision at large scroll offsets.
    expect.soft(Math.round(control.height * 1000) / 1000, `${control.label} touch height`).toBeGreaterThanOrEqual(44);
    if (control.field) expect.soft(control.font, `${control.label} field font`).toBeGreaterThanOrEqual(16);
  }
}

async function expectNoHorizontalScroll(scope) {
  const bounds = await scope.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect.soft(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
}

for (const viewport of devices) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`company and team settings fit ${size} and retain reachable controls`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mock(page, seed, fixtures);
    await page.locator('#settingsBtn').click();
    const panel = page.locator('#settingsPanel');
    await expect(panel).toBeVisible();
    await expectUsableControls(panel);
    await expectNoHorizontalScroll(panel);
    const panelBounds = await panel.boundingBox();
    expect.soft(panelBounds.height).toBeGreaterThanOrEqual(viewport.height * .8);
    await page.screenshot({ path: testInfo.outputPath(`settings-company-${size}.png`) });

    await panel.getByLabel('Nome da empresa', { exact: true }).fill('Empresa no celular');
    await page.getByRole('button', { name: 'Salvar dados da empresa' }).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-cloud')).data.companyProfile.nome)).toBe('Empresa no celular');
    await page.getByLabel('E-mail do convidado').fill('novo.colaborador@example.invalid');
    await page.getByRole('combobox', { name: 'Permissão', exact: true }).selectOption('editor');
    await page.getByRole('button', { name: 'Gerar link de convite' }).click();
    await expect(page.getByRole('textbox', { name: 'Link do convite' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Link do convite' }).scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(panel);
    await expectUsableControls(panel);
    await page.screenshot({ path: testInfo.outputPath(`settings-team-${size}.png`) });
    await page.getByRole('combobox', { name: `Permissão de ${memberEmail}` }).selectOption('viewer');
    await expect(page.getByRole('combobox', { name: `Permissão de ${memberEmail}` })).toHaveValue('viewer');
    await page.locator('#logoutBtn').scrollIntoViewIfNeeded();
    await expect(page.locator('#settingsCloseBtn')).toBeInViewport();
    await page.locator('#settingsCloseBtn').click();
    await expect(panel).not.toBeVisible();
  });

  test(`login and password recovery remain usable at ${size}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mock(page);
    await page.evaluate(() => window.testAuthEvent('SIGNED_OUT'));
    const login = page.locator('#loginForm');
    await expect(login).toBeVisible();
    await expectNoHorizontalScroll(page.locator('html'));
    await expectNoHorizontalScroll(login);
    await expectUsableControls(login);
    await page.screenshot({ path: testInfo.outputPath(`login-${size}.png`), fullPage: true });
    await page.locator('#loginEmail').fill('celular@example.invalid');
    await page.locator('#loginPassword').fill('example-password');
    await page.locator('#forgotPasswordBtn').click();
    await expect(page.locator('#authStatus')).toContainText('receberá um link');
    await page.evaluate(() => window.testAuthEvent('PASSWORD_RECOVERY', { id: 'test-account', email: 'celular@example.invalid' }));
    const recovery = page.locator('#resetPasswordForm');
    await expect(recovery).toBeVisible();
    await expectUsableControls(recovery);
    await expectNoHorizontalScroll(recovery);
    await page.locator('#newPassword').fill('nova-senha-celular');
    await page.locator('#confirmPassword').fill('nova-senha-celular');
    await page.screenshot({ path: testInfo.outputPath(`recovery-${size}.png`), fullPage: true });
    await page.locator('#savePasswordBtn').click();
    await expect(page.locator('#authStatus')).toContainText('Senha atualizada');
  });
}
