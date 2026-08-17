import { test, expect } from '@playwright/test';

/**
 * Duplication d'un template. Le piège que ce test verrouille : le formulaire s'ouvre PRÉ-REMPLI d'un template
 * existant, et il ne doit surtout pas le MODIFIER. Pré-remplir et éditer étaient la même chose (`initial`),
 * d'où un troisième mode explicite. Un envoi en PATCH renverrait le template d'origine en validation Meta.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATE = {
  id: 'tpl-1',
  name: 'promo_ete',
  status: 'APPROVED',
  category: 'MARKETING',
  language: 'fr',
  body: 'Bonjour, profitez de nos offres.',
  headerFormat: null,
  isCarousel: false,
  editable: true,
};

async function ouvrir(page: import('@playwright/test').Page, appels: { method: string; url: string; body: unknown }[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() !== 'GET') appels.push({ method: req.method(), url, body: req.postDataJSON() ?? null });
    if (req.method() === 'POST' && url.includes('/templates')) return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ name: 'promo_ete_copie', language: 'fr', status: 'PENDING' }) });
    if (url.includes('/templates/hints')) return json({ hints: [] });
    if (url.includes('/templates')) return json({ templates: [TEMPLATE] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/templates');
}

test.describe('dupliquer un template', () => {
  test('ouvre le formulaire PRÉ-REMPLI, avec un nom libre suffixé « _copie »', async ({ page }) => {
    await ouvrir(page, []);
    await page.getByTestId('template-dupliquer-promo_ete').click();

    // Le corps est repris, et le nom est MODIFIABLE (en édition il est verrouillé).
    const nom = page.locator('input[value="promo_ete_copie"]');
    await expect(nom).toBeVisible();
    await expect(nom).toBeEnabled();
    // Le corps apparaît DEUX fois : dans le champ et dans l'aperçu du message. On vise le premier.
    await expect(page.getByText('Bonjour, profitez de nos offres.').first()).toBeVisible();

    // Le bandeau dit que rien n'est encore parti chez Meta.
    await expect(page.getByTestId('template-duplication-bandeau')).toContainText('Créer le template');
  });

  test('🔴 l’envoi CRÉE (POST) et ne modifie jamais le template d’origine', async ({ page }) => {
    const appels: { method: string; url: string; body: unknown }[] = [];
    await ouvrir(page, appels);
    await page.getByTestId('template-dupliquer-promo_ete').click();
    await page.getByRole('button', { name: /Créer le template/ }).click();

    await expect.poll(() => appels.filter((a) => a.method === 'POST').length).toBe(1);
    // Aucun PATCH : le template source n'est pas renvoyé en validation Meta.
    expect(appels.filter((a) => a.method === 'PATCH')).toHaveLength(0);
    expect((appels.find((a) => a.method === 'POST')?.body as { name?: string })?.name).toBe('promo_ete_copie');
  });
});
