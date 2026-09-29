import { test, expect } from '@playwright/test';

/**
 * QUANTITATIF > PERFORMANCE : le temps de réponse et de résolution de l'équipe (cadrage du 2026-09-29).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : un chiffre INCONNU s'écrit « non disponible », jamais 0. Une médiane de rien
 * affichée à zéro dirait qu'une équipe répond instantanément, et c'est sur cet écran qu'un client la jugera. Et la
 * console part sur Vercel AVANT l'API : tant que la route n'existe pas, l'écran dit « pas encore disponible » au lieu
 * d'une erreur brute. Le calcul lui-même est tenu sans navigateur (`tests/stats-performance.test.ts`).
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const PERF = {
  mesureDepuis: '2026-09-29T08:30:00.000Z',
  mode: 'ouvre',
  fuseau: 'Europe/Paris',
  reponse: { mediane: 240_000, p90: 900_000, n: 3 },
  // Aucune demande résolue avec réponse : la résolution est INCONNUE, pas nulle.
  resolution: { mediane: null, p90: null, n: 0 },
  demandes: 5,
  resolues: 0,
  resoluesSansReponse: 2,
  ouvertes: 3,
  plusAncienneOuverte: '2026-09-29T09:00:00.000Z',
  parJour: [{ jour: '2026-09-29', demandes: 5, reponseMediane: 240_000, resolutionMediane: null }],
  parCollaborateur: [
    { qui: { genre: 'collaborateur', userId: 'u-marie', nom: 'Marie' }, reponses: 3, reponseMediane: 240_000, closes: 0, resolutionMediane: null },
    { qui: { genre: 'automatique' }, reponses: 0, reponseMediane: null, closes: 2, resolutionMediane: null },
  ],
};

const VIDE = {
  ...PERF,
  reponse: { mediane: null, p90: null, n: 0 },
  resolution: { mediane: null, p90: null, n: 0 },
  demandes: 0, resolues: 0, resoluesSansReponse: 0, ouvertes: 0, plusAncienneOuverte: null, parJour: [], parCollaborateur: [],
};

async function mock(page: import('@playwright/test').Page, opts: { perf?: unknown; statut?: number } = {}) {
  const appels: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/performance')) {
      appels.push(url);
      // Le 404 du ROUTEUR, celui d'une API qui ne connaît pas encore la route.
      if (opts.statut === 404) return json({ message: 'Route GET:/tenants/t-e2e/stats/performance not found', error: 'Not Found', statusCode: 404 }, 404);
      return json(opts.perf ?? PERF);
    }
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  return { appels };
}

test.describe('Quantitatif > Performance', () => {
  test('les quatre chiffres, les compteurs, la courbe et le tableau par collaborateur', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard/performance');
    await expect(page.getByTestId('perf-kpi-reponse-mediane')).toHaveText('4 min');
    await expect(page.getByTestId('perf-kpi-reponse-p90')).toHaveText('15 min');
    await expect(page.getByTestId('perf-demandes')).toHaveText('5');
    await expect(page.getByTestId('perf-sans-reponse')).toHaveText('2');
    await expect(page.getByTestId('perf-ouvertes')).toHaveText('3');
    // Une demande répondue mais pas close est OUVERTE, pas « en attente » : la phrase dit ce qui est vrai.
    await expect(page.getByTestId('perf-plus-ancienne')).toContainText(/ouverte depuis|open since/);
    await expect(page.getByTestId('perf-mesure-depuis')).toContainText(/29\/09\/2026|Mesuré depuis/);
    await expect(page.getByTestId('perf-mode')).toContainText(/heures d.ouverture|opening hours/);
    await expect(page.getByTestId('perf-courbe')).toBeVisible();
    await expect(page.getByTestId('perf-collab-u-marie')).toContainText('Marie');
    await expect(page.getByTestId('perf-collab-automatique')).toContainText(/Automatique|Automatic/);
  });

  test('🔴 un temps INCONNU s’écrit « non disponible », jamais 0', async ({ page }) => {
    await mock(page);
    await page.goto('/dashboard/performance');
    await expect(page.getByTestId('perf-kpi-resolution-mediane')).toHaveText(/non disponible|not available/);
    await expect(page.getByTestId('perf-kpi-resolution-p90')).toHaveText(/non disponible|not available/);
    await expect(page.getByTestId('perf-collab-automatique')).not.toContainText(/\b0 s\b/);
  });

  test('🔴 aucune demande sur la période : « non disponible » partout, et une phrase à la place de la courbe', async ({ page }) => {
    await mock(page, { perf: VIDE });
    await page.goto('/dashboard/performance');
    for (const id of ['perf-kpi-reponse-mediane', 'perf-kpi-reponse-p90', 'perf-kpi-resolution-mediane', 'perf-kpi-resolution-p90']) {
      await expect(page.getByTestId(id)).toHaveText(/non disponible|not available/);
    }
    await expect(page.getByTestId('perf-courbe-vide')).toBeVisible();
    await expect(page.getByTestId('perf-courbe')).toHaveCount(0);
  });

  test('🔴 la route absente (404, API pas encore déployée) : « pas encore disponible », pas une erreur', async ({ page }) => {
    await mock(page, { statut: 404 });
    await page.goto('/dashboard/performance');
    await expect(page.getByTestId('perf-indisponible')).toBeVisible();
    await expect(page.getByTestId('perf-kpi-reponse-mediane')).toHaveCount(0);
  });

  test('un espace sans heures d’ouverture : l’écran dit qu’il compte en temps brut', async ({ page }) => {
    await mock(page, { perf: { ...PERF, mode: 'brut' } });
    await page.goto('/dashboard/performance');
    await expect(page.getByTestId('perf-mode')).toContainText(/temps brut|raw time/);
  });

  // 45 h 12 : presque une semaine de bureau en heures ouvrées, que « 1 j 21 h » ferait lire « presque deux jours ».
  const LONGUE = { ...PERF, reponse: { mediane: 45 * 3_600_000 + 12 * 60_000, p90: 45 * 3_600_000 + 12 * 60_000, n: 1 } };

  test('🔴 en heures d’ouverture, une durée ne s’écrit JAMAIS en jours', async ({ page }) => {
    await mock(page, { perf: LONGUE });
    await page.goto('/dashboard/performance');
    await expect(page.getByTestId('perf-kpi-reponse-mediane')).toHaveText('45 h 12');
  });

  test('en temps brut, un jour est un vrai jour, et il s’écrit', async ({ page }) => {
    await mock(page, { perf: { ...LONGUE, mode: 'brut' } });
    await page.goto('/dashboard/performance');
    await expect(page.getByTestId('perf-kpi-reponse-mediane')).toHaveText(/^1 (j|d) 21 h$/);
  });

  test('changer de période relance la lecture sur la nouvelle plage', async ({ page }) => {
    const { appels } = await mock(page);
    await page.goto('/dashboard/performance');
    await expect(page.getByTestId('perf-kpi-reponse-mediane')).toHaveText('4 min');
    const du = (u: string): string | null => /from=(\d{4}-\d{2}-\d{2})/.exec(u)?.[1] ?? null;
    const premier = du(appels[0] ?? '');
    expect(premier).not.toBeNull();
    await page.getByTestId('range-bar').getByRole('button', { name: /^7 / }).click();
    // Sept jours au lieu de trente : un début plus récent que celui de la première lecture.
    await expect.poll(() => appels.map(du).some((d) => d !== null && d > premier!)).toBe(true);
  });
});
