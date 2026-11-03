const selectFinanceTab = (page, name) => page.getByRole('tab', { name, exact: true }).click();

async function openFinanceFilters(page) {
  const filters = page.locator('.ceo-finance-more-filters');
  if (await filters.getAttribute('open') === null) await filters.locator('summary').click();
}

async function openFinanceRowActions(page, name) {
  await selectFinanceTab(page, 'Lançamentos');
  const row = page.locator('.ceo-finance-table tbody tr').filter({ has: page.getByText(name, { exact: true }) });
  const toggle = row.locator('.ceo-finance-row-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const menu = row.locator('.ceo-finance-row-menu');
  if (await menu.getAttribute('open') === null) await menu.locator('summary').click();
  return row;
}

module.exports = { selectFinanceTab, openFinanceFilters, openFinanceRowActions };
