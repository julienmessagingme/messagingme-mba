import { test, expect } from '@playwright/test';

/**
 * Le plafond et les quotas de l'API d'un espace, lisibles dans `/ops` (`GET /ops/plafond-api/:tenantId`).
 *
 * Ce que ces tests protègent à l'écran : la consommation du jour face au plafond qui s'applique, un réglage absent dit
 * « défaut », un plafond désactivé dit « aucun », et un compteur muet donne une consommation INCONNUE, jamais zéro.
 * Le serveur, lui, est tenu par `tests/ops-plafond-api.test.ts`.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const ESPACE = {
  id: 't-essai', name: 'Essai Dupont', createdAt: '2026-10-01T00:00:00Z', mbaEnabled: false,
  users: 1, contacts: 0, messages: 0, templatesUsed: 0, lastSendAt: null, phone: null, phoneStatus: null, quality: null,
};
const fenetre = (reglage: number | null, defaut: number) => ({ reglage, defaut, effectif: (reglage ?? defaut) > 0 ? (reglage ?? defaut) : null });

async function ouvrir(page: import('@playwright/test').Page, aujourdhui: unknown) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json({ tenants: [ESPACE], daily: [], queues: [], worker: null });
    if (chemin.endsWith('/ops/plafond-api/t-essai')) {
      return json({
        tenantId: 't-essai', aujourdhui,
        minute: fenetre(null, 60), heure: fenetre(null, 0), envoisJour: fenetre(500, 2000), fichesJour: fenetre(null, 20000),
      });
    }
    return json({});
  });
  await page.goto('/ops');
  await page.getByTestId('quotas-t-essai').click();
  const modale = page.getByTestId('quotas-api-modale');
  await expect(modale).toBeVisible();
  return modale;
}

test.describe('Ops : les quotas de l’API d’un espace', () => {
  test('la consommation du jour face au plafond qui s’applique', async ({ page }) => {
    const modale = await ouvrir(page, { jour: '2026-10-09', envois: 120, fiches: 3400, remiseAZero: '2026-10-09T22:00:00.000Z' });
    await expect(modale.getByTestId('quota-envois')).toContainText('120');
    await expect(modale.getByTestId('quota-envois')).toContainText('500');
    await expect(modale.getByTestId('quota-envois')).not.toContainText(/défaut|default|n\/d|n\/a/);
    await expect(modale.getByTestId('quota-fiches')).toContainText(/20\s?000 \((défaut|default)\)/);
    await expect(modale.getByTestId('quota-heure')).toContainText(/aucun|none/);
    await expect(modale).toContainText(/Remise à zéro|Reset/);
  });

  test('🔴 un compteur muet : consommation inconnue, jamais zéro', async ({ page }) => {
    const modale = await ouvrir(page, null);
    await expect(modale.getByTestId('quota-envois')).toContainText(/n\/d|n\/a/);
    await expect(modale.getByTestId('quota-fiches')).toContainText(/n\/d|n\/a/);
    await expect(modale).toContainText(/consommation inconnue|usage unknown/);
  });
});
