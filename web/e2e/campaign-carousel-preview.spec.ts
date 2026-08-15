import { test, expect } from '@playwright/test';

/**
 * E2E campagne : quand le 1er bloc du scénario est un CAROUSEL, l'écran de création montre les VRAIES
 * cartes. Avant, il affichait le corps du template dans une bulle de texte, ce qui ne disait rien de ce que
 * le contact allait recevoir. Même règle pour une campagne à template direct.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const WF_CAROUSEL = {
  id: 'wf-car', name: 'Promo carousel', graph: {
    nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo_carousel', language: 'fr' } }], edges: [],
  },
};

const TEMPLATES = [
  {
    id: 't2', name: 'promo_carousel', status: 'APPROVED', category: 'marketing', language: 'fr',
    body: 'Découvrez la sélection', headerFormat: null, isCarousel: true, editable: false,
    carousel: {
      cards: [
        { mediaUrl: 'https://exemple.test/carte1.jpg', body: 'Séjour à Nice', buttons: [{ type: 'QUICK_REPLY', text: 'Ça m’intéresse' }] },
        { mediaUrl: 'https://exemple.test/carte2.jpg', body: 'Séjour à Lyon', buttons: [{ type: 'QUICK_REPLY', text: 'Ça m’intéresse' }] },
      ],
    },
  },
];

test.describe('Campagnes : miniature réelle d’un carousel', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/workflows')) return json({ workflows: [WF_CAROUSEL] });
      if (url.includes('/templates')) return json({ templates: TEMPLATES });
      if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33500000000', verifiedName: 'Test' }] });
      if (url.includes('/campaigns')) return json({ campaigns: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {}, returnBehavior: null });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/campaigns');
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    await page.getByTestId('campaign-name').fill('Campagne E2E');
  });

  test('scénario ouvrant par un carousel -> les cartes sont affichées, pas un simple encadré', async ({ page }) => {
    await page.getByRole('button', { name: 'Un scénario', exact: true }).click();
    const wfSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Choisir un scénario' }) });
    await expect(wfSelect).toBeVisible({ timeout: 15_000 });
    await wfSelect.selectOption('wf-car');

    // Attente allongée, comme le fait déjà campaign-workflow-filter.spec.ts pour la même raison : sous la
    // charge de la suite complète, les workers partagent UN serveur de dev et 5 s ne suffisent pas toujours.
    // Les assertions elles-mêmes sont inchangées, seule la patience l'est.
    await expect(page.getByTestId('carousel-cards')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Séjour à Nice')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Séjour à Lyon')).toBeVisible({ timeout: 15_000 });
  });

  test('template carousel choisi DIRECTEMENT -> même aperçu (le choix suit le template, pas l’écran)', async ({ page }) => {
    const tplSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Choisir un template' }) });
    await expect(tplSelect).toBeVisible({ timeout: 15_000 });
    await tplSelect.selectOption('promo_carousel');
    await expect(page.getByTestId('carousel-cards')).toBeVisible({ timeout: 15_000 });
  });
});
