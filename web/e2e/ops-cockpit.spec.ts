import { test, expect, type Page } from './aide/test';

/**
 * COCKPIT ET LA MÉMOIRE DES WORKERS DANS `/ops` (refonte, lot 2). Ce que ces tests tiennent à l'écran : les quatre
 * briques neuves mises en mots (une mesure de Cockpit absente dit « Cockpit ne répond pas », pas une panne), les courbes
 * de Capacité avec ou sans Cockpit, et une API d'avant le lot 2 qui ne fait rien apparaître ni tomber.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const SEUILS = {
  accuses: { orange: 60, rouge: 120 }, entrants: { orange: 5, rouge: 30 }, connexions: { orange: 70, rouge: 85 },
  erreurs: { orange: 1, rouge: 5 }, battement: { orange: 120, rouge: 300 },
  processeurBase: { orange: 60, rouge: 80 }, processeurMachine: { orange: 60, rouge: 80 }, memoireWorker: { orange: 70, rouge: 85 },
};
const SANTE = {
  briques: [
    { cle: 'api', etat: 'vert', mesure: 0 },
    { cle: 'workers', etat: 'vert', mesure: 12, detail: 'principal' },
    { cle: 'memoire-workers', etat: 'orange', mesure: 75, detail: 'analyse' },
    { cle: 'machine', etat: 'orange', mesure: null, indisponible: true },
    { cle: 'base', etat: 'vert', mesure: 17 },
    { cle: 'processeur-base', etat: 'vert', mesure: 6.7 },
    { cle: 'entrants', etat: 'vert', mesure: null },
    { cle: 'accuses', etat: 'vert', mesure: null },
    { cle: 'hubspot', etat: 'vert', mesure: 0 },
  ],
  jauge: { margePourcent: 12, signal: 'memoire-workers', partielle: true },
  connexions: { utilisees: 25, max: 147 },
  meta: { dernierMessage: null, dernierAccuse: null },
  incidents: { erreurs5xx: 0, tachesEnEchec: 0, fileEchec: 0, demarrages: [] },
  seuils: SEUILS,
};
const heure = new Date(Date.now() - 2 * 3600_000).toISOString();
const point = (valeur: number) => [{ heure, valeur }];
const CAPACITE_BASE = { jours: 30, heures: [], files: [], seuils: SEUILS };
const MEMOIRES = [{ role: 'principal', heure, maxOctets: 134e6, limiteOctets: 1073741824 }];
const SERIES = {
  baseProcesseur: point(6.7), baseMemoire: point(28), baseDisque: point(5.6), baseConnexions: point(16.7),
  machineProcesseur: point(1.6), machineMemoire: point(27), apiMemoire: point(22),
};

async function monter(page: Page, capacite: unknown, sante: unknown = SANTE): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json({ tenants: [], daily: [], queues: [], workers: [] });
    if (chemin.endsWith('/ops/sante')) return json(sante);
    if (chemin.endsWith('/ops/capacite')) return json(capacite);
    return json({});
  });
}

test.describe('Ops : Cockpit et la mémoire des workers', () => {
  test('🔴 Santé : les briques du lot 2 mises en mots ; Cockpit muet n’est pas une panne', async ({ page }) => {
    await monter(page, { ...CAPACITE_BASE, memoires: MEMOIRES, cockpit: { configure: true, series: SERIES } });
    await page.goto('/ops');
    await expect(page.getByTestId('ops-brique-memoire-workers')).toHaveAttribute('data-etat', 'orange');
    await expect(page.getByTestId('ops-brique-memoire-workers')).toContainText(/analyse à 75 %|analyse at 75 %/);
    await expect(page.getByTestId('ops-brique-machine')).toContainText(/Cockpit ne répond pas|Cockpit is not answering/);
    await expect(page.getByTestId('ops-brique-processeur-base')).toContainText(/7 % sur 15 min|7 % over 15 min/);
    await expect(page.getByTestId('ops-brique-hubspot')).toContainText(/endormie|asleep/);
    await expect(page.getByTestId('ops-jauge')).toContainText(/mémoire des workers|workers memory/);
    await expect(page.getByTestId('ops-jauge-partielle')).toBeVisible();
  });

  test('🔴 Capacité avec Cockpit : processeur, mémoire (dont chaque worker), connexions et disque', async ({ page }) => {
    await monter(page, { ...CAPACITE_BASE, memoires: MEMOIRES, cockpit: { configure: true, series: SERIES } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-capacite-processeur')).toContainText(/Machine des workers|Workers machine/);
    await expect(page.getByTestId('ops-capacite-memoire')).toContainText(/Copie d’API|API copy/);
    // Les workers sur leur propre courbe : un seul rôle relevé, sans légende, le principal à 12,5 % de sa limite.
    await expect(page.getByTestId('ops-capacite-memoire-workers')).toContainText(/12[,.]5/);
    await expect(page.getByTestId('ops-capacite-base')).toContainText(/Disque|Disk/);
    await expect(page.getByTestId('ops-cockpit-etat')).toHaveCount(0);
  });

  test('sans jeton Cockpit : il le dit, et la mémoire des workers se trace quand même', async ({ page }) => {
    await monter(page, { ...CAPACITE_BASE, memoires: MEMOIRES, cockpit: { configure: false } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-cockpit-etat')).toContainText(/pas configuré|not configured/);
    // Une seule série, sans légende : le principal à 12,5 % de sa limite (134 Mo sur 1 Gio).
    await expect(page.getByTestId('ops-capacite-memoire-workers')).toContainText(/12[,.]5/);
    await expect(page.getByTestId('ops-capacite-processeur')).toHaveCount(0);
    await expect(page.getByTestId('ops-capacite-memoire')).toHaveCount(0);
  });

  test('Cockpit muet : il le dit, sans courbe de Cockpit, sans tomber', async ({ page }) => {
    await monter(page, { ...CAPACITE_BASE, memoires: [], cockpit: { configure: true, series: null } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-cockpit-etat')).toContainText(/indisponibles|unavailable/);
    await expect(page.getByTestId('ops-capacite-memoire')).toHaveCount(0);
    await expect(page.getByTestId('ops-capacite-memoire-workers')).toHaveCount(0);
    await expect(page.getByTestId('ops-capacite-copies')).toBeVisible();
  });

  test('⚠️ une API d’avant le lot 2 : aucune courbe neuve, aucun message, la page tient', async ({ page }) => {
    await monter(page, CAPACITE_BASE);
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('ops-capacite-copies')).toBeVisible();
    await expect(page.getByTestId('ops-cockpit-etat')).toHaveCount(0);
    await expect(page.getByTestId('ops-capacite-processeur')).toHaveCount(0);
  });
});
