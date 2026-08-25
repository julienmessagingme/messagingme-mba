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

const MIXTE = [
  { code: null, type: 'template', name: 'Message de bienvenue', workflowId: 'w1', workflowName: 'Onboarding', summary: 'promo_ete' },
  { code: null, type: 'rcs_message', name: '', workflowId: 'w1', workflowName: 'Onboarding', summary: 'Bonjour en RCS' },
  { code: null, type: 'email', name: '', workflowId: 'w1', workflowName: 'Onboarding', summary: 'Mail vers client@ex.fr' },
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

  test('les puces de filtre couvrent AUSSI « Message RCS » et « Envoi de mail »', async ({ page }) => {
    // Ces deux blocs existaient dans les scénarios sans qu'aucune puce ne permette de les isoler : l'écran ne
    // construisait ses filtres que depuis NODE_ORDER, la même liste unique qui rendait ces canaux
    // inatteignables dans le menu du fil.
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/nodes')) return json({ nodes: MIXTE });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/nodes');
    await expect(page.getByText('Bonjour en RCS')).toBeVisible();

    // Les deux puces existent…
    const puceRcs = page.getByRole('button', { name: /Message RCS/ });
    const puceMail = page.getByRole('button', { name: /Envoi de mail/ });
    await expect(puceRcs).toBeVisible();
    await expect(puceMail).toBeVisible();

    // … et elles filtrent réellement.
    await puceRcs.click();
    await expect(page.getByText('Bonjour en RCS')).toBeVisible();
    await expect(page.getByText('Message de bienvenue')).toHaveCount(0);

    await puceMail.click();
    await expect(page.getByText('Mail vers client@ex.fr')).toBeVisible();
    await expect(page.getByText('Bonjour en RCS')).toHaveCount(0);
  });
});
