// Browser capabilities are simulated; no installation or production writes occur.
const { test, expect } = require('@playwright/test');
const { mock } = require('./mock-supabase');

async function openSettings(page) {
  await page.route('**/api/jarvis/**', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({enabled: false, configured: false, memoryEnabled: false})
  }));
  await mock(page);
  await page.getByRole('button', { name: 'Abrir configurações' }).click();
  await expect(page.locator('#pwaInstallSection')).toBeVisible();
}

test('PWA prompts only after an explicit install click and hides install after appinstalled', async ({ page }) => {
  await openSettings(page);
  await page.evaluate(() => {
    window.testInstallPrompts = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { window.testInstallPrompts++; };
    event.userChoice = Promise.resolve({outcome: 'accepted'});
    window.dispatchEvent(event);
    window.testDefaultPrevented = event.defaultPrevented;
  });
  expect(await page.evaluate(() => window.testInstallPrompts)).toBe(0);
  expect(await page.evaluate(() => window.testDefaultPrevented)).toBe(true);
  await page.getByRole('button', { name: 'Instalar ZAMA', exact: true }).click();
  expect(await page.evaluate(() => window.testInstallPrompts)).toBe(1);
  await expect(page.locator('#pwaInstallBtn')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(page.locator('#pwaInstallBtn')).toBeHidden();
  await expect(page.locator('#pwaInstallSection')).toContainText('ZAMA instalada');
  await page.evaluate(() => window.ZamaPwa.openInstall());
  expect(await page.evaluate(() => window.testInstallPrompts)).toBe(1);
});

test('dismissed native prompt is consumed and a later install click shows manual help', async ({ page }) => {
  await openSettings(page);
  await page.evaluate(() => {
    window.testInstallPrompts = 0;
    const event = new Event('beforeinstallprompt', {cancelable: true});
    event.prompt = async () => { window.testInstallPrompts++; };
    event.userChoice = Promise.resolve({outcome: 'dismissed'});
    window.dispatchEvent(event);
  });
  await page.locator('#pwaInstallBtn').click();
  await expect(page.locator('#pwaInstallSection')).toContainText('Instalação cancelada');
  await page.locator('#pwaInstallBtn').click();
  await expect(page.getByRole('dialog', {name: 'Instalar ZAMA'})).toBeVisible();
  expect(await page.evaluate(() => window.testInstallPrompts)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', {name: 'Instalar ZAMA'})).toBeHidden();
  await expect(page.locator('#pwaInstallBtn')).toBeFocused();
});

test('iPhone installation help fits mobile and describes Safari home screen flow', async ({ page }) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'}));
  await openSettings(page);
  await page.locator('#pwaInstallBtn').click();
  const dialog = page.getByRole('dialog', {name: 'Instalar ZAMA'});
  await expect(dialog).toContainText('Compartilhar');
  await expect(dialog).toContainText('Adicionar à Tela de Início');
  await expect(dialog).toContainText('Abrir como App da Web');
  await expect(dialog).not.toContainText('No Android');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({path: 'test-results/pwa-iphone.png'});
  await page.getByRole('button', {name: 'Entendi', exact: true}).click();
  await expect(dialog).toBeHidden();
});

test('Android without native prompt displays Chrome menu installation help', async ({ page }) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {get: () => 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/143.0.0.0 Mobile Safari/537.36'}));
  await openSettings(page);
  await page.locator('#pwaInstallBtn').click();
  const dialog = page.getByRole('dialog', {name: 'Instalar ZAMA'});
  await expect(dialog).toContainText('Chrome');
  await expect(dialog).toContainText('três pontos');
  await expect(dialog).toContainText('Instalar aplicativo');
  await expect(dialog).not.toContainText('No iPhone');
});

test('installed standalone app does not offer a duplicate install', async ({ page }) => {
  await page.addInitScript(() => {
    const match = window.matchMedia.bind(window);
    window.matchMedia = query => query === '(display-mode: standalone)' ? {matches: true, addEventListener() {}} : match(query);
  });
  await openSettings(page);
  await expect(page.locator('#pwaInstallBtn')).toBeHidden();
  await expect(page.locator('#pwaInstallSection')).toContainText('já está aberta ou instalada');
  await page.evaluate(() => window.ZamaPwa.openInstall());
  await expect(page.getByRole('dialog', {name: 'Instalar ZAMA'})).toHaveCount(0);
});
