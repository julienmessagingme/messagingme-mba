import { test, expect } from '@playwright/test';

/**
 * E2E campagne : le sélecteur de scénarios ne propose QUE ceux lançables en broadcast (entrée = template
 * configuré). Depuis le Lot D, un scénario peut démarrer par un formulaire / message rapide : il reste valide,
 * mais une campagne part sur une audience froide, donc il ne doit PAS apparaître ici.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const WF_OK = {
  id: 'wf-ok', name: 'Relance promo', graph: {
    nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } }], edges: [],
  },
};
const WF_FLOW = {
  id: 'wf-flow', name: 'Formulaire seul', graph: {
    nodes: [{ id: 'n1', type: 'flow', position: { x: 0, y: 0 }, data: { flowId: 'fl1', flowName: 'RDV' } }], edges: [],
  },
};
const WF_TPL_VIDE = {
  id: 'wf-vide', name: 'Template pas encore choisi', graph: {
    nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: {} }], edges: [],
  },
};

test.describe('Campagnes : sélecteur de scénarios filtré (Lot D)', () => {
  test('seul le scénario démarrant par un template configuré est proposé', async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/workflows')) return json({ workflows: [WF_OK, WF_FLOW, WF_TPL_VIDE] });
      if (url.includes('/templates')) return json({ templates: [{ name: 'promo', language: 'fr', status: 'APPROVED', category: 'marketing', body: 'Bonjour' }] });
      if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33500000000', verifiedName: 'Test' }] });
      if (url.includes('/campaigns')) return json({ campaigns: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/campaigns');

    // Ouvre l'écran de création. Le nom est obligatoire en étape 0 (il grise le reste du formulaire), puis on
    // passe en mode « scénario » (le défaut est l'envoi d'un template direct).
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    await page.getByTestId('campaign-name').fill('Campagne E2E');
    await page.getByRole('button', { name: 'Un scénario', exact: true }).click();

    const wfSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Choisir un scénario' }) });
    // Le sélecteur n'existe qu'une fois la liste des scénarios chargée : sous la charge de la suite complète
    // (serveur de dev partagé entre workers), 5 s ne suffisent pas toujours. L'assertion est inchangée.
    await expect(wfSelect).toBeVisible({ timeout: 15_000 });
    // Assertions RE-TENTANTES sur les options : une lecture unique (`allInnerTexts`) ne réessaie pas, alors
    // que la liste arrive d'un useEffect asynchrone. Pire, les deux assertions négatives étaient satisfaites
    // À VIDE : le spec pouvait passer pour la mauvaise raison, et ne tombait que sur la positive.
    await expect(wfSelect.locator('option', { hasText: 'Relance promo' })).toHaveCount(1);
    await expect(wfSelect.locator('option', { hasText: 'Formulaire seul' })).toHaveCount(0);
    await expect(wfSelect.locator('option', { hasText: 'Template pas encore choisi' })).toHaveCount(0);
  });
});
