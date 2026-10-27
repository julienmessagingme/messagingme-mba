import { test, expect } from './aide/test';

/**
 * L'offre Entreprise d'un espace, posée depuis `/ops` (demande de Julien du 2026-10-13 ; route du lot 6,
 * `GET` et `PUT /ops/offre/:tenantId`, tenue côté serveur par `tests/ops-offre.test.ts`).
 *
 * Ce que ces tests protègent à l'écran : l'état actuel lu avant tout geste, la note obligatoire, la limite
 * d'utilisateurs (ou sans limite), le retour en Base, et 🔴 la conservation JAMAIS envoyée sans qu'on coche « la
 * changer », avec l'avertissement rouge d'un raccourcissement, parce qu'il purge des conversations sans retour.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const ESPACE = {
  id: 't-essai', name: 'Essai Dupont', createdAt: '2026-10-01T00:00:00Z', mbaEnabled: false,
  users: 1, contacts: 0, messages: 0, templatesUsed: 0, lastSendAt: null, phone: null, phoneStatus: null, quality: null,
};

async function ouvrir(page: import('@playwright/test').Page, offre: Record<string, unknown>) {
  const ecrits: unknown[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json({ tenants: [ESPACE], daily: [], queues: [], worker: null });
    if (chemin.endsWith('/ops/offre/t-essai')) {
      if (route.request().method() === 'PUT') {
        const corps = route.request().postDataJSON() as Record<string, unknown>;
        ecrits.push(corps);
        return json({ tenantId: 't-essai', entreprise: corps.entreprise, utilisateurs: corps.utilisateurs, conservationJours: 'conservationJours' in corps ? corps.conservationJours : offre.conservationJours, utilisateursProposes: 10 });
      }
      return json({ tenantId: 't-essai', utilisateursProposes: 10, ...offre });
    }
    return json({});
  });
  await page.goto('/ops?tab=clients');
  await page.getByTestId('offre-t-essai').click();
  const modale = page.getByTestId('offre-modale');
  await expect(modale).toBeVisible();
  return { modale, ecrits };
}

test.describe('Ops : l’offre Entreprise d’un espace', () => {
  test('🔴 passer un espace en Entreprise : 10 proposés, note obligatoire, conservation NON envoyée', async ({ page }) => {
    const { modale, ecrits } = await ouvrir(page, { entreprise: false, utilisateurs: null, conservationJours: 90 });
    await expect(modale.getByTestId('offre-actuelle')).toContainText(/hors Entreprise|not on Enterprise/);
    await modale.getByTestId('offre-entreprise').check();
    await expect(modale.getByTestId('offre-utilisateurs')).toHaveValue('10');
    // Sans note, rien ne part.
    await expect(modale.getByTestId('offre-enregistrer')).toBeDisabled();
    await modale.getByTestId('offre-note').fill('Devis signé le 13/10');
    await modale.getByTestId('offre-enregistrer').click();
    await expect(modale.getByTestId('offre-message')).toContainText(/Entreprise|Enterprise/);
    expect(ecrits).toEqual([{ entreprise: true, utilisateurs: 10, note: 'Devis signé le 13/10' }]);
    await expect(modale.getByTestId('offre-actuelle')).toContainText(/10 utilisateurs au plus|10 users at most/);
  });

  test('🔴 les contacts et la commission du devis (spec offres v2) ne partent que si on coche « Régler »', async ({ page }) => {
    const { modale, ecrits } = await ouvrir(page, { entreprise: true, utilisateurs: 10, conservationJours: null, contacts: null, commissionPct: null });
    await modale.getByTestId('offre-changer-devis').check();
    await modale.getByTestId('offre-commission').fill('7.5');
    // Une commission décimale rendrait la vue illisible : rien ne part.
    await modale.getByTestId('offre-note').fill('Devis signé');
    await expect(modale.getByTestId('offre-enregistrer')).toBeDisabled();
    await modale.getByTestId('offre-contacts').fill('20000');
    await modale.getByTestId('offre-commission').fill('7');
    await modale.getByTestId('offre-enregistrer').click();
    await expect(modale.getByTestId('offre-message')).toBeVisible();
    expect(ecrits).toEqual([{ entreprise: true, utilisateurs: 10, contacts: 20000, commissionPct: 7, note: 'Devis signé' }]);
  });

  test('sans limite d’utilisateurs : `null` part', async ({ page }) => {
    const { modale, ecrits } = await ouvrir(page, { entreprise: false, utilisateurs: null, conservationJours: null });
    await modale.getByTestId('offre-entreprise').check();
    await modale.getByTestId('offre-sans-limite').check();
    await modale.getByTestId('offre-note').fill('Grand compte');
    await modale.getByTestId('offre-enregistrer').click();
    await expect(modale.getByTestId('offre-message')).toBeVisible();
    expect(ecrits).toEqual([{ entreprise: true, utilisateurs: null, note: 'Grand compte' }]);
  });

  test('ramener en Base : Entreprise décochée, la limite repart à « sans limite »', async ({ page }) => {
    const { modale, ecrits } = await ouvrir(page, { entreprise: true, utilisateurs: 25, conservationJours: 0 });
    await expect(modale.getByTestId('offre-actuelle')).toContainText(/25 utilisateurs au plus|25 users at most/);
    await expect(modale.getByTestId('offre-retour-base')).toHaveCount(0);
    await modale.getByTestId('offre-entreprise').uncheck();
    // Le retour en Base gèle des membres et, après la grâce, purge : il se dit avant l'enregistrement, avec le compte.
    await expect(modale.getByTestId('offre-retour-base')).toContainText(/il en compte 1|it has 1/);
    await modale.getByTestId('offre-note').fill('Fin du contrat');
    await modale.getByTestId('offre-enregistrer').click();
    await expect(modale.getByTestId('offre-message')).toContainText(/hors Entreprise|out of Enterprise/);
    expect(ecrits).toEqual([{ entreprise: false, utilisateurs: null, note: 'Fin du contrat' }]);
  });

  test('🔴 une conservation raccourcie s’annonce en rouge, et ne part que si on l’a cochée', async ({ page }) => {
    const { modale, ecrits } = await ouvrir(page, { entreprise: true, utilisateurs: 10, conservationJours: 365 });
    await modale.getByTestId('offre-changer-conservation').check();
    await modale.getByTestId('offre-conservation').fill('30');
    await expect(modale.getByTestId('offre-purge')).toBeVisible();
    // Un allongement ne prévient pas.
    await modale.getByTestId('offre-conservation').fill('730');
    await expect(modale.getByTestId('offre-purge')).toHaveCount(0);
    await modale.getByTestId('offre-conservation').fill('30');
    await modale.getByTestId('offre-note').fill('Demande du client');
    await modale.getByTestId('offre-enregistrer').click();
    await expect(modale.getByTestId('offre-message')).toBeVisible();
    expect(ecrits).toEqual([{ entreprise: true, utilisateurs: 10, conservationJours: 30, note: 'Demande du client' }]);
  });
});
