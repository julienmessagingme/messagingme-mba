import { test, expect } from './aide/test';

/**
 * QUANTITATIF > SHOPIFY : le chiffre d'affaires attribué aux envois WhatsApp (plan 2026-10-30, lot 2, tâche 5).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : deux devises restent deux chiffres, jamais un total ; les commandes de test s'annoncent
 * à part, sans entrer dans le chiffre ; l'entrée de la barre n'existe que pour un espace qui a une boutique ; et la
 * console publiée avant l'API dit « pas encore disponible ». Le calcul est tenu sans navigateur (`tests/shopify-chiffre`).
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const VENTES = {
  periode: { from: '2026-10-01', to: '2026-10-30' },
  reel: {
    totaux: [{ devise: 'EUR', brut: '170.5', prouve: '100.5', commandes: 3 }, { devise: 'USD', brut: '30', prouve: '0', commandes: 1 }],
    sources: [
      { source: 'campagne', campaignId: 'k1', nom: 'Soldes', devise: 'EUR', brut: '150.5', prouve: '100.5', commandes: 2 },
      { source: 'campagne', campaignId: null, nom: null, devise: 'EUR', brut: '20', prouve: '0', commandes: 1 },
      { source: 'agent', campaignId: null, nom: null, devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
    ],
  },
  test: { totaux: [{ devise: 'USD', brut: '2148.85', prouve: '1548.85', commandes: 4 }], sources: [] },
  paniers: { relances: 7, recuperes: 2, montants: [{ devise: 'EUR', montant: '40' }], recuperesTest: 1 },
};

const BOUTIQUE = { domaine: 'essai.myshopify.com', nom: 'Essai', etat: 'connectee', dernierEvenementLe: null, delaiPanierMinutes: 15, origine: 'console' };

async function mock(page: import('@playwright/test').Page, opts: { boutique?: unknown; ventes?: unknown; statut?: number } = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/ventes')) {
      // Le 404 du ROUTEUR, celui d'une API qui ne connaît pas encore la route.
      if (opts.statut === 404) return json({ message: 'Route GET:/tenants/t-e2e/stats/ventes not found', error: 'Not Found', statusCode: 404 }, 404);
      return json(opts.ventes ?? VENTES);
    }
    if (url.includes('/integrations/shopify')) {
      return json({ boutique: opts.boutique === undefined ? BOUTIQUE : opts.boutique, messages: [], compteurs: {}, paniers: {}, pageApps: null, attentes: [] });
    }
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Quantitatif > Shopify', () => {
  test('🔴 deux devises, deux chiffres ; les sources, les paniers, et les commandes de test à part', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard/shopify');
    await expect(page.getByTestId('ventes-total-EUR')).toContainText(/170,50\s€|€170\.50/);
    await expect(page.getByTestId('ventes-total-USD')).toContainText(/30,00\s\$US|\$30\.00/);
    await expect(page.getByTestId('ventes-total-EUR')).toContainText(/100,50\s€|€100\.50/);
    await expect(page.getByTestId('ventes-regle')).toContainText(/5 jours|5 days/);
    // Le reste n'est qu'une concordance dans le temps, et l'écran le dit (anti-but de la spec ; relecture du lot B).
    await expect(page.getByTestId('ventes-regle')).toContainText(/concordance dans le temps|match in time/);
    await expect(page.getByTestId('ventes-sources')).toContainText(/Campagne « Soldes »|Campaign “Soldes”/);
    await expect(page.getByTestId('ventes-sources')).toContainText(/Campagne supprimée|Deleted campaign/);
    await expect(page.getByTestId('ventes-relances')).toHaveText('7');
    await expect(page.getByTestId('ventes-recuperes')).toHaveText('2');
    await expect(page.getByTestId('ventes-montant-recupere')).toContainText(/40,00\s€|€40\.00/);
    // Les tests s'annoncent, sans entrer dans le chiffre : aucun total de 2 148,85 ailleurs que sur leur ligne.
    await expect(page.getByTestId('ventes-tests')).toContainText(/4 commandes de test|4 test orders/);
    await expect(page.getByTestId('ventes-tests')).toContainText(/2\s148,85|2,148\.85/);
    // Leur part prouvée et le panier récupéré en test se lisent aussi : l'essai réel n'a que des commandes de test.
    await expect(page.getByTestId('ventes-tests')).toContainText(/dont 1\s548,85\s\$US prouvés|of which \$1,548\.85 proven/);
    await expect(page.getByTestId('ventes-tests')).toContainText(/1 panier relancé récupéré|1 reminded checkout recovered/);
    await expect(page.getByTestId('ventes-total-USD')).not.toContainText(/2\s148|2,148/);
  });

  test('🔴 l’entrée de la barre existe avec une boutique, et disparaît sans', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard/performance');
    await expect(page.locator('nav a[href="/dashboard/shopify"]')).toHaveCount(1);
  });

  test('🔴 sans boutique, pas d’entrée Shopify dans Quantitatif', async ({ page }) => {
    await mock(page, { boutique: null });
    // La lecture de la boutique doit avoir RÉPONDU avant l'assertion : sinon l'entrée, encore cachée faute de réponse,
    // ferait passer le test sur une lecture fautive (relecture du lot B).
    const lue = page.waitForResponse((r) => r.url().includes('/integrations/shopify'));
    await page.goto('/dashboard/performance');
    await lue;
    await expect(page.locator('nav a[href="/dashboard/performance"]').first()).toBeVisible();
    await expect(page.locator('nav a[href="/dashboard/shopify"]')).toHaveCount(0);
  });

  test('aucune vente : la phrase le dit, jamais un zéro sans explication', async ({ page }) => {
    await mock(page, { ventes: { reel: { totaux: [], sources: [] }, test: { totaux: [], sources: [] }, paniers: { relances: 0, recuperes: 0, montants: [], recuperesTest: 0 } } });
    await page.goto('/dashboard/shopify');
    await expect(page.getByTestId('ventes-vide')).toBeVisible();
    await expect(page.getByTestId('ventes-tests')).toHaveCount(0);
  });

  test('un panier récupéré en test sans commande de test sur la période : la ligne le dit, sans « 0 commandes »', async ({ page }) => {
    await mock(page, { ventes: { reel: { totaux: [], sources: [] }, test: { totaux: [], sources: [] }, paniers: { relances: 1, recuperes: 0, montants: [], recuperesTest: 1 } } });
    await page.goto('/dashboard/shopify');
    await expect(page.getByTestId('ventes-tests')).toContainText(/1 panier relancé récupéré|1 reminded checkout recovered/);
    await expect(page.getByTestId('ventes-tests')).not.toContainText(/0 commandes|0 test orders/);
  });

  test('la console publiée avant l’API : « pas encore disponible »', async ({ page }) => {
    await mock(page, { statut: 404 });
    await page.goto('/dashboard/shopify');
    await expect(page.getByTestId('ventes-indisponible')).toBeVisible();
  });
});
