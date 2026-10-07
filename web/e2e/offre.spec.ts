import { test, expect, type Page } from '@playwright/test';

/**
 * L'OFFRE DANS LA CONSOLE (lot 6, tâche 7). Une Base voit grisé ce que son offre n'ouvre pas (menus, onglets), n'ouvre
 * jamais l'écran d'une fonction fermée (l'encart de l'offre le remplace), lit ce qu'elle consomme sur `/offre`, et un
 * geste refusé (la 101e fiche) montre la phrase du serveur avec le chemin vers l'offre. Une Entreprise ne voit rien de
 * grisé. Et sans la route (API plus ancienne), rien ne l'est non plus. Depuis la livraison B1, une Base paie le Pro sur la
 * page de Stripe, un Pro gère son abonnement au portail, et un Pro pas encore en vente renvoie au Support.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const TOUTES = ['inbox', 'scenarios', 'statistiques', 'agent_meta', 'aide', 'assistants', 'analyse', 'publicites', 'email', 'chaines', 'crm', 'rcs', 'performance_lab'];
const PRO = TOUTES.slice(0, 10);
const limites = (o: 'base' | 'pro' | 'entreprise') => ({
  utilisateurs: o === 'base' ? 1 : o === 'pro' ? 3 : null, admins: o === 'base' ? 1 : o === 'pro' ? 2 : null,
  contacts: o === 'base' ? 100 : null, envoisModelesMois: o === 'base' ? 1000 : null, automations: o === 'base' ? 10 : null,
  suppressionsJour: o === 'base' ? 10 : null, adressesWebhook: o === 'base' ? 1 : 5, journalWebhooksJours: o === 'base' ? 3 : 30,
  conservationJours: o === 'base' ? 30 : 90, commissionPct: o === 'base' ? 50 : 10, badge: o === 'base', numeroInclus: o !== 'base',
});
const GRILLE = {
  base: { fonctions: [], limites: limites('base') },
  pro: { fonctions: PRO, limites: limites('pro') },
  entreprise: { fonctions: TOUTES, limites: limites('entreprise') },
};
const vue = (o: 'base' | 'pro' | 'entreprise') => ({
  offre: o, fonctions: GRILLE[o].fonctions, limites: limites(o),
  usage: { envoisModelesMois: o === 'base' ? 250 : null, contacts: 100, automations: 3, membres: 1 },
  grille: GRILLE, upgradeUrl: 'https://console.e2e.test/offre',
});
const PHRASE_LIMITE = 'Limite de votre offre atteinte : 100 contacts. Passez en Pro pour la lever : https://console.e2e.test/offre';

const PRIX_PRO = { moisCentimes: 4900, anCentimes: 49000 };
const CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_e2e';
const PORTAIL = 'https://billing.stripe.com/p/session/e2e';

type Reponse = { status: number; corps: unknown };
async function monter(page: Page, offre: unknown, o: { paiement?: Reponse } = {}) {
  const appels: string[] = [];
  const paiements: unknown[] = [];
  // Les pages de Stripe ne sont jamais jointes : une page factice suffit à prouver la redirection.
  await page.route(/^https:\/\/(checkout|billing)\.stripe\.com\//, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Stripe</h1>' }));
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    appels.push(`${req.method()} ${chemin}`);
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && chemin.endsWith('/offre/paiement')) {
      paiements.push(req.postDataJSON());
      return o.paiement ? json(o.paiement.corps, o.paiement.status) : json({ url: CHECKOUT, portail: false });
    }
    if (req.method() === 'POST' && chemin.endsWith('/offre/portail')) return json({ url: PORTAIL });
    if (chemin.endsWith('/offre')) return offre === null ? json({ error: 'Not Found' }, 404) : json(offre);
    if (req.method() === 'POST' && chemin.endsWith('/contacts')) {
      return json({ error: PHRASE_LIMITE, code: 'plan_limit_reached', limite: 'contacts', max: 100, upgradeUrl: 'https://console.e2e.test/offre' }, 402);
    }
    if (chemin.includes('/contacts/count')) return json({ count: 0 });
    if (chemin.includes('/user-fields')) return json({ fields: [] });
    if (chemin.includes('/tags')) return json({ tags: [] });
    if (chemin.includes('/contacts')) return json({ contacts: [] });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { appels, paiements };
}

test.describe('une Base', () => {
  test('🔴 les menus et les onglets des fonctions fermées sont grisés et mènent à l’offre', async ({ page }) => {
    await monter(page, vue('base'));
    await page.goto('/contacts');
    await expect(page.getByTestId('nav-verrou-chaine')).toBeVisible();
    await expect(page.getByTestId('nav-verrou-publicites')).toHaveAttribute('href', '/offre?fonction=publicites');
    await expect(page.getByTestId('onglet-inbox')).toHaveAttribute('data-verrouille', 'oui');
    await expect(page.getByTestId('onglet-inbox')).toHaveAttribute('href', '/offre?fonction=inbox');
    await expect(page.getByTestId('onglet-perf')).toHaveAttribute('data-verrouille', 'oui');
  });

  test('🔴 l’écran d’une fonction fermée n’est pas monté : l’encart de l’offre le remplace, sans appel à la fonction', async ({ page }) => {
    const { appels } = await monter(page, vue('base'));
    await page.goto('/chaine');
    await expect(page.getByTestId('encart-offre')).toBeVisible();
    await expect(page.getByTestId('encart-offre')).toContainText('Pro');
    expect(appels.filter((a) => a.includes('/channels-me'))).toEqual([]);
  });

  test('🔴 la pastille des non-lus ne part pas : la route est dans le module de l’Inbox', async ({ page }) => {
    const { appels } = await monter(page, vue('base'));
    await page.goto('/contacts');
    await expect(page.getByTestId('nav-verrou-chaine')).toBeVisible();
    expect(appels.filter((a) => a.includes('unread-count'))).toEqual([]);
  });

  test('la page de l’offre : l’offre, ce qui est consommé, la grille, et « Passer en Pro »', async ({ page }) => {
    await monter(page, vue('base'));
    await page.goto('/offre?fonction=inbox');
    await expect(page.getByTestId('offre-actuelle')).toHaveText('Base');
    await expect(page.getByTestId('offre-raison')).toContainText('Pro');
    await expect(page.getByTestId('offre-usage-contacts')).toContainText('100 / 100');
    await expect(page.getByTestId('offre-usage-modeles')).toContainText('250 / 1');
    await expect(page.getByTestId('offre-colonne-pro')).toBeVisible();
    await expect(page.getByTestId('offre-passer-pro')).toHaveAttribute('href', '/support?sujet=pro');
    await page.getByTestId('offre-passer-pro').click();
    await expect(page.getByTestId('support-sujet')).toHaveValue('Passer en Pro');
  });

  test('🔴 la 101e fiche est refusée : la phrase du serveur, et le chemin vers l’offre', async ({ page }) => {
    await monter(page, vue('base'));
    await page.goto('/contacts');
    await page.getByTestId('contacts-ajouter-menu').click();
    await page.getByTestId('contact-ajouter').click();
    await page.getByTestId('ajout-telephone').fill('06 12 34 56 78');
    await page.getByTestId('ajout-valider').click();
    await expect(page.getByTestId('refus-offre')).toBeVisible();
    await expect(page.getByTestId('refus-offre-phrase')).toHaveText('Limite de votre offre atteinte : 100 contacts. Passez en Pro pour la lever.');
    await page.getByTestId('refus-offre-lien').click();
    await expect(page).toHaveURL(/\/offre$/);
  });
});

test.describe('payer le Pro (livraison B1)', () => {
  test('🔴 une Base paie le Pro : le clic demande le paiement à l’API, puis part sur la page de Stripe', async ({ page }) => {
    const { paiements } = await monter(page, { ...vue('base'), prixPro: PRIX_PRO });
    await page.goto('/offre');
    await expect(page.getByTestId('offre-payer-mois')).toContainText('49 € HT');
    await expect(page.getByTestId('offre-payer-an')).toContainText('490 € HT');
    await expect(page.getByTestId('offre-passer-pro')).toHaveCount(0);
    await page.getByTestId('offre-payer-an').click();
    await expect(page).toHaveURL(CHECKOUT);
    expect(paiements).toEqual([{ periodicite: 'an' }]);
  });

  test('🔴 le Pro pas encore en vente (503) : le Support prend le relais, sans message d’erreur', async ({ page }) => {
    await monter(page, { ...vue('base'), prixPro: PRIX_PRO }, { paiement: { status: 503, corps: { error: 'pas encore en vente', code: 'pro_indisponible' } } });
    await page.goto('/offre');
    await page.getByTestId('offre-payer-mois').click();
    await expect(page.getByTestId('offre-passer-pro')).toHaveAttribute('href', '/support?sujet=pro');
    await expect(page.getByTestId('offre-paiement-erreur')).toHaveCount(0);
  });

  test('un autre refus se dit, et les boutons restent', async ({ page }) => {
    await monter(page, { ...vue('base'), prixPro: PRIX_PRO }, { paiement: { status: 502, corps: { error: 'Stripe ne répond pas' } } });
    await page.goto('/offre');
    await page.getByTestId('offre-payer-mois').click();
    await expect(page.getByTestId('offre-paiement-erreur')).toBeVisible();
    await expect(page.getByTestId('offre-payer-mois')).toBeEnabled();
  });

  test('🔴 un Pro gère son abonnement : le portail de Stripe, et plus de bouton de paiement', async ({ page }) => {
    await monter(page, { ...vue('pro'), prixPro: PRIX_PRO });
    await page.goto('/offre');
    await expect(page.getByTestId('offre-payer-mois')).toHaveCount(0);
    await page.getByTestId('offre-portail').click();
    await expect(page).toHaveURL(PORTAIL);
  });

  test('le retour de Stripe : paiement reçu, ou abandonné sans débit', async ({ page }) => {
    await monter(page, { ...vue('base'), prixPro: PRIX_PRO });
    await page.goto('/offre?pro=recu');
    await expect(page.getByTestId('offre-paiement-recu')).toBeVisible();
    await page.goto('/offre?pro=abandon');
    await expect(page.getByTestId('offre-paiement-abandon')).toBeVisible();
    await expect(page.getByTestId('offre-paiement-recu')).toHaveCount(0);
  });
});

test.describe('une Entreprise, et une API sans la route', () => {
  test('🔴 une Entreprise ne voit rien de grisé, et l’écran d’une fonction s’ouvre', async ({ page }) => {
    await monter(page, vue('entreprise'));
    await page.goto('/chaine');
    await expect(page.getByTestId('onglet-inbox')).not.toHaveAttribute('data-verrouille', 'oui');
    await expect(page.locator('[data-testid^="nav-verrou-"]')).toHaveCount(0);
    await expect(page.getByTestId('encart-offre')).toHaveCount(0);
  });

  test('🔴 une API sans la route (404) : rien n’est grisé, tout reste ouvert', async ({ page }) => {
    await monter(page, null);
    await page.goto('/contacts');
    await expect(page.getByTestId('contacts-ajouter-menu')).toBeVisible();
    await expect(page.locator('[data-testid^="nav-verrou-"]')).toHaveCount(0);
    await expect(page.getByTestId('onglet-inbox')).toHaveAttribute('href', '/inbox');
  });
});
