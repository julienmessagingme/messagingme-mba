import { test, expect, type Page } from './aide/test';

/**
 * LE LIEN « COMMENT FAIRE » DE LA BARRE DU HAUT (plan du centre d'aide, tâche 10). Posé une fois dans la coquille, il
 * mène à la page du centre d'aide de l'écran courant, dans la langue de la console, et n'existe pas sur un écran qui
 * n'a pas de page. L'absence ne prouve quelque chose que si la barre du haut est bien rendue : le test l'attend avant.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: Page, locale: 'fr' | 'en' = 'fr') {
  await page.addInitScript(([s, l]) => {
    window.localStorage.setItem('mba.session', s);
    window.localStorage.setItem('mba_locale', l);
  }, [JSON.stringify(SESSION), locale] as const);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // Les bouchons dont les écrans Campagnes et Webhooks ont besoin pour se rendre (voir `aide-console.spec.ts`).
    if (url.includes('/contacts/count')) return json({ total: 0 });
    if (url.includes('/contacts')) return json({ contacts: [], total: 0 });
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/webhook')) return json({ endpoints: [], deliveries: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Le lien « Comment faire »', () => {
  test('🔴 sur Campagnes, il ouvre « Lancer une campagne » dans un nouvel onglet', async ({ page }) => {
    await mock(page);
    await page.goto('/campaigns');
    const lien = page.getByRole('link', { name: 'Comment faire (nouvel onglet)' });
    await expect(lien).toHaveAttribute('href', 'https://app.messagingme.fr/aide/lancer-une-campagne/');
    await expect(lien).toHaveAttribute('target', '_blank');
    await expect(lien).toHaveAttribute('rel', 'noopener');
  });

  test('en anglais, il mène à la page anglaise', async ({ page }) => {
    await mock(page, 'en');
    await page.goto('/campaigns');
    await expect(page.getByRole('link', { name: 'How-to guide (opens in a new tab)' }))
      .toHaveAttribute('href', 'https://app.messagingme.fr/en/help/launch-a-campaign/');
  });

  test('🔴 sur Webhooks, qui n’a pas de page, il n’existe pas', async ({ page }) => {
    await mock(page);
    await page.goto('/webhooks');
    // La barre du haut est rendue (son menu de compte est là) : l'absence du lien n'est pas celle de la barre.
    await expect(page.getByRole('button', { name: /admin@e2e\.test/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Comment faire/ })).toHaveCount(0);
  });
});
