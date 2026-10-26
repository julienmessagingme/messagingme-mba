import { test, expect, type Page } from './aide/test';

/**
 * TOOLS > INTÉGRATIONS (2026-10-26) : les cartes Batch, HubSpot, Salesforce et Shopify ont quitté Paramètres > Général.
 * Une ancienne ancre (`/parametres#integration-…`, dans des e-mails déjà partis et la page d'aide publique) mène à la même
 * carte, Général dit où elles sont parties, et un manager n'entre pas dans l'écran (il est aux admins, comme ses routes).
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function monter(page: Page, role = 'admin') {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), { ...ADMIN, role });
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/integrations/batch')) return json({ branche: false });
    if (chemin.endsWith('/settings')) return json({ timezone: 'Europe/Paris' });
    if (chemin.endsWith('/settings/agents-peuvent-prendre')) return json({ actif: false });
    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: [] });
    if (chemin.endsWith('/unread-count')) return json({ count: 0 });
    if (chemin.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role });
    return json({});
  });
}

test('🔴 « Intégrations » est la première entrée de Tools, et la page porte les cartes', async ({ page }) => {
  await monter(page);
  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Intégrations', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Intégrations', exact: true })).toHaveAttribute('href', '/integrations');
  await expect(page.getByTestId('integration-hubspot')).toBeVisible();
  await expect(page.getByTestId('integration-shopify')).toBeVisible();
});

test('🔴 une ancienne ancre de Paramètres mène à la même carte dans Intégrations', async ({ page }) => {
  await monter(page);
  await page.goto('/parametres#integration-shopify');
  await expect(page).toHaveURL(/\/integrations#integration-shopify$/);
  await expect(page.getByTestId('integration-shopify')).toBeVisible();
});

test('Paramètres > Général n’a plus les cartes, et dit où elles sont parties', async ({ page }) => {
  await monter(page);
  await page.goto('/parametres');
  await expect(page.getByTestId('param-integrations-deplacees').getByRole('link')).toHaveAttribute('href', '/integrations');
  await expect(page.getByTestId('integration-hubspot')).toHaveCount(0);
  await expect(page.getByTestId('integration-shopify')).toHaveCount(0);
});

test('🔴 un manager n’entre pas dans Intégrations', async ({ page }) => {
  await monter(page, 'manager');
  await page.goto('/integrations');
  await expect(page).toHaveURL(/\/inbox/);
});
