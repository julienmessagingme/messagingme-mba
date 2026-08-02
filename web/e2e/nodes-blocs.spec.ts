import { test, expect } from '@playwright/test';

/**
 * E2E Contenu > Blocs : le tableau montre la colonne « Nom » (plus « Contenu »), et le nom libre d'un bloc s'affiche
 * (repli sur le résumé si pas de nom). Backend intercepté, aucune base (pattern des E2E accueil).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const NODES = [
  { code: 'nod_ab12cd_0123456789ABCDEFGHJKMNPQRS', type: 'template', name: 'Message de bienvenue', workflowId: 'w1', workflowName: 'Onboarding', summary: 'promo_ete' },
  { code: null, type: 'tag', name: '', workflowId: 'w1', workflowName: 'Onboarding', summary: 'VIP' },
];

test.describe('Contenu > Blocs : colonne Nom', () => {
  test('affiche la colonne Nom (pas Contenu) et le nom libre du bloc, repli sur le résumé sinon', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/nodes')) return json({ nodes: NODES });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/nodes');

    // En-tête : « Nom » présent, « Contenu » retiré.
    await expect(page.getByRole('columnheader', { name: 'Nom' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Contenu' })).toHaveCount(0);

    // Le bloc nommé affiche son nom ; le bloc sans nom retombe sur son résumé.
    await expect(page.getByText('Message de bienvenue')).toBeVisible();
    await expect(page.getByText('VIP')).toBeVisible();
  });
});
