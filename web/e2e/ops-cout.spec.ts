import { test, expect, type Page } from './aide/test';

/**
 * LE COÛT SCALEWAY DU MOIS DANS `/ops` (refonte, lot 3). Ce que ces tests tiennent à l'écran : le total, la projection et
 * les postes en français quand la clé est posée ; « non configuré » sans clé ; « indisponible » quand la facturation n'a
 * pas répondu ; et rien du tout devant une API d'avant le lot 3 (404), la page tenant.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const SEUILS = {
  accuses: { orange: 60, rouge: 120 }, entrants: { orange: 5, rouge: 30 }, connexions: { orange: 70, rouge: 85 },
  erreurs: { orange: 1, rouge: 5 }, battement: { orange: 120, rouge: 300 },
};
const CAPACITE = { jours: 30, heures: [], files: [], seuils: SEUILS };
const COUT = {
  periode: '2026-10', totalHt: 103.28, remiseHt: 100, projectionHt: 113.15, joursEcoules: 28.3, joursDuMois: 31,
  postes: [{ categorie: 'Managed Databases', montantHt: 55.52 }, { categorie: 'Compute', montantHt: 18.48 }, { categorie: 'Serverless', montantHt: 17.17 }],
  lignes: [{ produit: 'Managed Database DB-DEV-M', categorie: 'Managed Databases', montantHt: 40.1 }],
  majLe: '2026-10-29T08:04:24.569Z',
};

async function monter(page: Page, cout: { status: number; body: unknown }): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json({ tenants: [], daily: [], queues: [], workers: [] });
    if (chemin.endsWith('/ops/capacite')) return json(CAPACITE);
    if (chemin.endsWith('/ops/cout')) return json(cout.body, cout.status);
    return json({});
  });
}

test.describe('Ops : le coût Scaleway du mois', () => {
  test('🔴 la clé posée : le total, la projection, les postes en français, la remise annoncée', async ({ page }) => {
    await monter(page, { status: 200, body: { configure: true, cout: COUT } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-cout-total')).toContainText(/103,28|103\.28/);
    await expect(page.getByTestId('ops-cout-projection')).toContainText(/113,15|113\.15/);
    await expect(page.getByTestId('ops-cout-postes')).toContainText(/Bases de données|Managed Databases/);
    await expect(page.getByTestId('ops-cout')).toContainText(/Remise annoncée|Discount announced/);
  });

  test('sans clé : il le dit', async ({ page }) => {
    await monter(page, { status: 200, body: { configure: false } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-cout-non-configure')).toContainText('SCW_FACTURATION_CLE');
  });

  test('la facturation muette : indisponible, la page tient', async ({ page }) => {
    await monter(page, { status: 200, body: { configure: true, cout: null } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-cout-indisponible')).toBeVisible();
    await expect(page.getByTestId('ops-capacite-copies')).toBeVisible();
  });

  test('⚠️ une API d’avant le lot 3 (404) : aucune carte, aucun message', async ({ page }) => {
    await monter(page, { status: 404, body: { error: 'Not Found' } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-capacite-copies')).toBeVisible();
    await expect(page.getByTestId('ops-cout')).toHaveCount(0);
    await expect(page.getByTestId('ops-cout-indisponible')).toHaveCount(0);
  });
});
