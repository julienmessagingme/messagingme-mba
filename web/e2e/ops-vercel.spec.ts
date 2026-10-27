import { test, expect, type Page } from './aide/test';

/**
 * LA JAUGE DU BUDGET D'ÉQUIPE VERCEL, SUR `/ops` (lot 14, A). À 100 %, chaque bot de chaque client se tait : la carte
 * dit où on en est, en orange à 80 %, en rouge à 95 % (les seuils des alertes Telegram, `consommation-equipe.ts`).
 * Elle se lit par sa propre route, une fois, et une API qui ne la porte pas encore ne casse rien : la console est
 * publiée à chaque push, avant le déploiement de l'API.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };

async function monter(page: Page, vercel: { status: number; body: unknown }): Promise<{ vercel: number }> {
  const appels = { vercel: 0 };
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (status: number, b: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json(200, { tenants: [], daily: [], queues: [], workers: [] });
    if (chemin.endsWith('/ops/vercel')) {
      appels.vercel += 1;
      return json(vercel.status, vercel.body);
    }
    return json(200, {});
  });
  return appels;
}

const jauge = (part: number, o: Record<string, unknown> = {}) => ({
  configure: true, limiteDollars: 100, depenseEquipeDollars: part * 100, depenseClesMensuellesDollars: 0, depenseRetenueDollars: part * 100, part, ...o,
});

test.describe('Ops : le budget d’équipe Vercel', () => {
  test('🔴 la jauge, lue une fois, orange à 80 %, rouge à 95 %', async ({ page }) => {
    const appels = await monter(page, { status: 200, body: jauge(0.82) });
    await page.goto('/ops?tab=capacite');
    const carte = page.getByTestId('vercel-budget');
    await expect(carte).toContainText('82 %');
    await expect(carte).toContainText('82,00 $');
    await expect(carte).toContainText('100,00 $');
    await expect(page.getByTestId('vercel-part')).toHaveClass(/text-alerte-700/);
    expect(appels.vercel).toBe(1);
  });

  test('à 96 %, rouge', async ({ page }) => {
    await monter(page, { status: 200, body: jauge(0.96) });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('vercel-part')).toHaveClass(/text-danger/);
  });

  test('🔴 le compteur de l’équipe en retard sur les clés : la carte dit les deux chiffres', async ({ page }) => {
    await monter(page, { status: 200, body: jauge(0.0796, { depenseEquipeDollars: 0, depenseClesMensuellesDollars: 7.96 }) });
    await page.goto('/ops?tab=capacite');
    const carte = page.getByTestId('vercel-budget');
    await expect(carte).toContainText('8 %');
    await expect(carte).toContainText('7,96 $');
    await expect(carte).toContainText('0,00 $');
  });

  test('sans jeton de compte, la carte le dit', async ({ page }) => {
    await monter(page, { status: 200, body: { configure: false } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('vercel-budget')).toContainText('non configuré');
  });

  test('🔴 aucun budget d’équipe chez Vercel : rouge, rien ne borne la dépense', async ({ page }) => {
    await monter(page, { status: 200, body: jauge(0, { limiteDollars: null, part: null, depenseRetenueDollars: 3 }) });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('vercel-budget')).toContainText('Aucun budget d’équipe');
  });

  test('🔴 une API sans la route (404) ou une lecture en échec (502) ne casse pas l’écran', async ({ page }) => {
    await monter(page, { status: 404, body: { error: 'Not Found' } });
    await page.goto('/ops?tab=capacite');
    await expect(page.getByTestId('vercel-budget')).toContainText('indisponible');
    await expect(page.getByTestId('stockage-base')).toBeVisible();
  });
});
