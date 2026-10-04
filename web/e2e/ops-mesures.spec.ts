import { test, expect, type Page } from '@playwright/test';

/**
 * LES TÂCHES DE FOND ET LE STOCKAGE, SUR `/ops` (audit de performance du 2026-10-02, § 9 et § 11).
 *
 * Ce que ces tests tiennent à l'écran : la tâche la plus lente passe en rouge au-delà de cinq minutes, une tâche
 * normale non ; les lignes ne s'affichent que pour une tâche qui les compte ; le stockage est lu UNE fois, par sa
 * propre route, et ses fichiers passent en rouge au-delà de 500 Mo. Les seuils sont tenus égaux au serveur par
 * `tests/mesure-taches.test.ts`.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const MO = 1024 * 1024;

const tache = (tacheNom: string, maxMs: number, lignes: number | null, echecs = 0) => ({
  process: 'worker-principal', tache: tacheNom, passes: 4, echecs, sautees: 0, sommeMs: maxMs * 2, maxMs,
  lignes, maxLignes: lignes, derniere: '2026-10-04T12:00:00.000Z',
});

async function monter(page: Page, fichiersRcsOctets: number): Promise<{ stockage: number }> {
  const appels = { stockage: 0 };
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) {
      return json({
        tenants: [], daily: [], queues: [], workers: [],
        tachesFond: [tache('agregats-analyse', 6 * 60_000, 120), tache('heartbeat', 4, null)],
      });
    }
    if (chemin.endsWith('/ops/stockage')) {
      appels.stockage += 1;
      return json({
        baseOctets: 47 * MO,
        familles: [
          { famille: 'rcs', elements: 28, octets: fichiersRcsOctets, disqueOctets: fichiersRcsOctets },
          { famille: 'pubs', elements: 0, octets: 0, disqueOctets: 0 },
          { famille: 'flows', elements: 4, octets: 0, disqueOctets: 200 * 1024 },
        ],
        tables: [{ table: 'public.rcs_media', octets: fichiersRcsOctets }],
        mesureLe: '2026-10-04T15:00:00.000Z',
      });
    }
    return json({});
  });
  return appels;
}

test.describe('Ops : tâches de fond et stockage', () => {
  test('🔴 la tâche au-delà de cinq minutes passe en rouge, la normale non ; les lignes seulement si comptées', async ({ page }) => {
    await monter(page, 10 * MO);
    await page.goto('/ops');
    const carte = page.getByTestId('taches-fond');
    await expect(carte).toContainText('agregats-analyse');
    await expect(page.getByTestId('tache-max-worker-principal-agregats-analyse')).toHaveClass(/text-danger/);
    await expect(page.getByTestId('tache-max-worker-principal-heartbeat')).not.toHaveClass(/text-danger/);
    await expect(carte).toContainText('120 ligne(s)');
    // La plus lente en tête : l'ordre du serveur est gardé.
    await expect(carte.locator('span.font-mono').first()).toContainText('agregats-analyse');
  });

  test('🔴 le stockage est lu une fois, et ses fichiers ne sont rouges qu’au-delà du seuil', async ({ page }) => {
    const appels = await monter(page, 10 * MO);
    await page.goto('/ops');
    const carte = page.getByTestId('stockage-base');
    await expect(carte).toContainText('Images RCS');
    await expect(page.getByTestId('stockage-fichiers')).not.toHaveClass(/text-danger/);
    await expect(carte).toContainText('public.rcs_media');
    expect(appels.stockage).toBe(1);
  });

  test('au-delà de 500 Mo de fichiers, rouge', async ({ page }) => {
    await monter(page, 600 * MO);
    await page.goto('/ops');
    await expect(page.getByTestId('stockage-fichiers')).toHaveClass(/text-danger/);
  });
});
