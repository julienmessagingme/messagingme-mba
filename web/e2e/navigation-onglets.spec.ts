import { test, expect } from '@playwright/test';

/**
 * Les trois onglets de premier niveau, et ce qu'ils rangent.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE. Deux choses, et la seconde ne se voit pas à la lecture du code :
 *
 *  1. qu'AUCUNE adresse n'ait bougé. Les onglets sont un niveau de regroupement au-dessus de la navigation,
 *     pas un nouveau routage : un favori ou un lien partagé doit continuer d'ouvrir la même page ;
 *  2. que l'onglet actif se DÉDUISE de la page plutôt que d'être passé par elle. Ça ne se vérifie qu'en
 *     ARRIVANT DIRECTEMENT sur une page profonde, ce qui est le cas d'un favori et le cas que personne
 *     n'essaie à la main.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AGENT = { token: 'e2e-token', email: 'agent@e2e.test', role: 'agent', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page, session: typeof ADMIN) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/todo-count')) return json({ count: 0 });
    if (url.includes('/conversations')) return json({ conversations: [] });
    if (url.includes('/contacts/count')) return json({ total: 0 });
    if (url.includes('/contacts')) return json({ contacts: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.endsWith('/me')) return json({ email: session.email, name: 'Jean Test', role: session.role });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Navigation : les trois onglets', () => {
  // Une page de chaque profondeur, dans chaque onglet : premier niveau (`/accueil`), deuxième
  // (`/templates`, sous « Contenu > WhatsApp ») et un sous-onglet du Quantitatif.
  for (const [chemin, attendu] of [
    ['/accueil', 'console'],
    ['/campaigns', 'console'],
    ['/templates', 'console'],
    ['/inbox', 'inbox'],
    ['/dashboard', 'perf'],
    ['/dashboard/couts', 'perf'],
    // La synthese, adresse NEUVE du lot F (2026-09-08). C'est la seule que la refonte des menus ait
    // creee, donc la seule qui pouvait n'appartenir a aucun arbre : elle est ici pour cette raison.
    ['/performance', 'perf'],
  ] as const) {
    test(`arriver sur ${chemin} active l’onglet « ${attendu} »`, async ({ page }) => {
      await mock(page, ADMIN);
      await page.goto(chemin);
      await expect(page.getByTestId(`onglet-${attendu}`)).toHaveAttribute('aria-current', 'page');
      // 🔴 Et l'adresse n'a pas bougé : les onglets ne redirigent rien.
      expect(new URL(page.url()).pathname).toBe(chemin);
    });
  }

  test('🔴 l’onglet Inbox n’a AUCUN menu de navigation', async ({ page }) => {
    // C'est la demande : « dans l'onglet inbox, il n'y aura plus la sidebar ». Son écran portera son propre
    // menu de dossiers (lot B), qui n'est pas une barre de navigation.
    await mock(page, ADMIN);
    await page.goto('/inbox');
    await expect(page.getByTestId('onglet-inbox')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Campagnes' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Mes tableaux/ })).toHaveCount(0);
  });

  test('🔴 le Performance Lab montre l’arbre Analytics, et PAS le reste de la console', async ({ page }) => {
    await mock(page, ADMIN);
    await page.goto('/dashboard/couts');
    await expect(page.getByRole('link', { name: /Mes tableaux/ })).toBeVisible();
    // Preuve inverse : sans elle, une barre qui montrerait TOUT passerait l'assertion ci-dessus.
    await expect(page.getByRole('link', { name: 'Campagnes' })).toHaveCount(0);
    // Le bloc bas (Developers) appartient à la Console : il n'a rien à faire sous ce menu.
    await expect(page.getByTestId('nav-groupe-developers')).toHaveCount(0);
  });

  test('la Console garde son menu, Analytics en moins', async ({ page }) => {
    await mock(page, ADMIN);
    await page.goto('/accueil');
    await expect(page.getByRole('link', { name: 'Campagnes' })).toBeVisible();
    await expect(page.getByTestId('nav-groupe-developers')).toBeVisible();
    await expect(page.getByRole('link', { name: /Mes tableaux/ })).toHaveCount(0);
    // L'Inbox a quitté ce MENU : elle est un onglet, plus une entrée de barre latérale.
    // ⚠️ Cerné sur `aside` à dessein : un lien nommé « Inbox » existe toujours dans l'entête, c'est
    // l'onglet lui-même. Sans ce cernage, l'assertion échouerait sur la preuve que le lot a marché.
    await expect(page.locator('aside').getByRole('link', { name: 'Inbox', exact: true })).toHaveCount(0);
  });

  test('🔴 un compte agent ne voit qu’UN onglet', async ({ page }) => {
    // Lui en montrer trois dont deux le renverraient aussitôt à l'inbox serait lui promettre deux portes
    // fermées.
    await mock(page, AGENT);
    await page.goto('/inbox');
    await expect(page.getByTestId('onglet-inbox')).toBeVisible();
    await expect(page.getByTestId('onglet-console')).toHaveCount(0);
    await expect(page.getByTestId('onglet-perf')).toHaveCount(0);
  });

  test('🔴 la pastille de non-lus se voit depuis les AUTRES onglets', async ({ page }) => {
    /**
     * La pastille vivait sur l'entrée « Inbox » de la barre latérale. L'Inbox étant devenue un onglet, cette
     * entrée n'existe plus dans aucun menu : la pastille avait DISPARU, et c'est l'E2E qui l'a signalé.
     *
     * Remise sur l'onglet, elle y gagne : elle est visible depuis les trois, alors qu'elle ne l'était que
     * dans la barre. Un opérateur qui lit ses chiffres dans le Performance Lab voit qu'on lui écrit. C'est
     * cette capacité NEUVE que ce cas garde ; `inbox-unread-carousel.spec.ts` garde la pastille elle-même.
     */
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/unread-count')) return json({ count: 4 });
      if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
      return json({});
    });
    for (const chemin of ['/accueil', '/dashboard/couts']) {
      await page.goto(chemin);
      await expect(page.getByTestId('nav-badge-inbox'), chemin).toHaveText('4');
    }
  });

  test('cliquer sur un onglet emmène à sa page d’entrée', async ({ page }) => {
    /**
     * ⚠️ LA DESTINATION A CHANGÉ LE 2026-09-08, LE CAS NON. Le Performance Lab ouvrait `/dashboard` faute
     * de mieux : le lot A avait refusé de créer la page de synthèse tant qu'elle n'aurait rien à montrer.
     * Le lot F lui donne son premier contenu, donc l'onglet ouvre `/performance`. Ce que ce test garde est
     * inchangé : un onglet emmène à SA page d'entrée, et s'y marque courant.
     */
    await mock(page, ADMIN);
    await page.goto('/accueil');
    await page.getByTestId('onglet-perf').click();
    await expect(page).toHaveURL(/\/performance$/);
    await expect(page.getByTestId('onglet-perf')).toHaveAttribute('aria-current', 'page');
  });
});
