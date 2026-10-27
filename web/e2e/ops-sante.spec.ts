import { test, expect, type Page } from './aide/test';

/**
 * LES ONGLETS SANTÉ ET CAPACITÉ DE `/ops` (refonte, lot 1 : `docs/superpowers/specs/2026-10-27-ops-refonte-design.md`).
 *
 * Ce que ces tests tiennent à l'écran : Santé est l'onglet par défaut, une pastille par brique dans l'état que le
 * SERVEUR a jugé (`tests/ops-sante.test.ts` tient le jugement), l'onglet vit dans l'adresse, et une API qui ne
 * connaît pas encore les routes (la console part au push, l'API à son déploiement) le dit sans faire tomber la page.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const SEUILS = {
  accuses: { orange: 60, rouge: 120 }, entrants: { orange: 5, rouge: 30 }, connexions: { orange: 70, rouge: 85 },
  erreurs: { orange: 1, rouge: 5 }, battement: { orange: 120, rouge: 300 },
};
const SANTE = {
  briques: [
    { cle: 'api', etat: 'vert', mesure: 0 },
    { cle: 'workers', etat: 'vert', mesure: 12, detail: 'principal' },
    { cle: 'base', etat: 'orange', mesure: 75 },
    { cle: 'entrants', etat: 'vert', mesure: null },
    { cle: 'accuses', etat: 'rouge', mesure: 150 },
  ],
  jauge: { margePourcent: 0, signal: 'accuses' },
  connexions: { utilisees: 110, max: 147 },
  meta: { dernierMessage: '2026-10-27T09:00:00.000Z', dernierAccuse: null },
  incidents: { erreurs5xx: 2, tachesEnEchec: 0, fileEchec: 1, demarrages: [{ role: 'principal', demarreLe: '2026-10-27T08:00:00.000Z' }] },
  seuils: SEUILS,
};
const heure = new Date(Date.now() - 2 * 3600_000).toISOString();
const CAPACITE = {
  jours: 30,
  heures: [{ heure, copiesMax: 2, minutesDeuxCopiesOuPlus: 30, attentesApi: 1, attentesWorkers: 0, maxAttenteMs: 40 }],
  files: [{ file: 'webhook-status', heure, echantillons: 40, attenteP95Secondes: 1, boutEnBoutP95Secondes: 2.5, boutEnBoutMaxSecondes: 4 }],
  seuils: SEUILS,
};

async function monter(page: Page, routesNeuves = true): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json({ tenants: [], daily: [], queues: [], workers: [] });
    if (chemin.endsWith('/ops/sante')) return routesNeuves ? json(SANTE) : json({ error: 'Not Found' }, 404);
    if (chemin.endsWith('/ops/capacite')) return routesNeuves ? json(CAPACITE) : json({ error: 'Not Found' }, 404);
    return json({});
  });
}

test.describe('Ops : Santé et Capacité', () => {
  test('🔴 Santé par défaut : une pastille par brique, dans l’état jugé par le serveur', async ({ page }) => {
    await monter(page);
    await page.goto('/ops');
    await expect(page.getByTestId('mba-tab-sante')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ops-brique-accuses')).toHaveAttribute('data-etat', 'rouge');
    await expect(page.getByTestId('ops-brique-base')).toHaveAttribute('data-etat', 'orange');
    await expect(page.getByTestId('ops-brique-base')).toContainText('110');
    await expect(page.getByTestId('ops-brique-entrants')).toHaveAttribute('data-etat', 'vert');
    await expect(page.getByTestId('ops-jauge')).toContainText('0 %');
    await expect(page.getByTestId('ops-incidents')).toContainText('principal');
    // Les autres onglets ne sont pas rendus : la table des clients attend le sien.
    await expect(page.getByTestId('ops-capacite')).toHaveCount(0);
  });

  test('🔴 l’onglet vit dans l’adresse : un clic la réécrit, et elle rouvre le même onglet', async ({ page }) => {
    await monter(page);
    await page.goto('/ops');
    await page.getByTestId('mba-tab-capacite').click();
    await expect(page).toHaveURL(/\/ops\?tab=capacite$/);
    await expect(page.getByTestId('ops-capacite-copies')).toContainText(/1 montée|1 rise/);
    await page.reload();
    await expect(page.getByTestId('mba-tab-capacite')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('ops-sante')).toHaveCount(0);
    await page.getByTestId('mba-tab-sante').click();
    await expect(page).toHaveURL(/\/ops$/);
  });

  test('⚠️ une API d’avant le lot (404) : chaque onglet le dit, et la page tient', async ({ page }) => {
    await monter(page, false);
    await page.goto('/ops');
    await expect(page.getByTestId('ops-sante-erreur')).toContainText(/prochain déploiement|next API deployment/);
    await expect(page.getByTestId('ops-exploitant')).toHaveText('exploitant@e2e.test');
    await page.getByTestId('mba-tab-capacite').click();
    await expect(page.getByTestId('ops-capacite-erreur')).toContainText(/prochain déploiement|next API deployment/);
  });
});
