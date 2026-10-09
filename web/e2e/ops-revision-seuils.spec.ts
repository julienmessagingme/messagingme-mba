import { test, expect } from '@playwright/test';

/**
 * `/ops` : la révision de l'API sous le titre, et le seuil de latence de CHAQUE file (lots 2 et 4 du plan de performance).
 *
 * Ce que ces tests protègent à l'écran : la révision rendue par le serveur s'affiche, et une file de fond à 40 s reste
 * verte (son seuil, envoyé par le serveur, est de 90 s) quand une file d'entrants au même chiffre passe au rouge. Le
 * serveur, lui, dérive le seuil de la cadence (`tests/ops.test.ts`).
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const ligne = (queue: string, seuilSecondes: number) => ({
  queue, echantillons: 12, attenteP50Secondes: 5, attenteP95Secondes: 40, boutEnBoutP95Secondes: 41, boutEnBoutMaxSecondes: 50, seuilSecondes,
});

test('la révision de l’API, et la couleur de latence selon le seuil de la file', async ({ page }) => {
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) {
      return json({ tenants: [], daily: [], queues: [], worker: null, revision: 'abc1234', latences: [ligne('webhook', 30), ligne('webhook-status', 90)] });
    }
    return json({});
  });
  await page.goto('/ops');
  await expect(page.getByTestId('ops-revision')).toContainText('abc1234');

  for (const mesure of ['p95', 'bout-en-bout']) {
    await expect(page.getByTestId(`latence-${mesure}-webhook`)).toHaveClass(/text-danger/);
    await expect(page.getByTestId(`latence-${mesure}-webhook-status`)).not.toHaveClass(/text-danger/);
  }
});
