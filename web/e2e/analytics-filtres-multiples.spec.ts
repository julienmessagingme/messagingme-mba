import { test, expect } from '@playwright/test';

/**
 * E2E Analytics : les filtres « campagnes » et « templates » acceptent PLUSIEURS valeurs, et la série est
 * compilée sur l'ensemble.
 *
 * Ce que le test regarde vraiment, c'est la requête qui part : c'est le seul endroit où l'on voit que les deux
 * valeurs choisies sont bien envoyées ensemble, et non la dernière seule. Les deux axes sont mutuellement
 * exclusifs, parce que les croiser décrirait leur intersection et pas leur union.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CAMPAGNES = [
  { id: 'camp-a', name: 'Promo A', status: 'sent', createdAt: '2026-08-01T09:00:00.000Z', counts: { queued: 0, sent: 3, delivered: 3, read: 1, failed: 0 } },
  { id: 'camp-b', name: 'Promo B', status: 'sent', createdAt: '2026-08-02T09:00:00.000Z', counts: { queued: 0, sent: 2, delivered: 2, read: 0, failed: 0 } },
];
const TEMPLATES = { total: 5, breakdown: [{ name: 'tpl-un', category: 'marketing', count: 3 }, { name: 'tpl-deux', category: 'utility', count: 2 }] };
const COUT = { marketing: [], utility: [], total: 12.5, hasRates: true, currency: 'EUR' };

/** Monte /dashboard et rend les URL de la route de coût, dans l'ordre où elles partent. */
async function monter(page: import('@playwright/test').Page) {
  const appelsCout: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/cost')) {
      appelsCout.push(url);
      return json(COUT);
    }
    if (url.includes('/stats/templates')) return json(TEMPLATES);
    if (url.includes('/stats/errors')) {
      return json({ errors: [{ code: 131026, count: 4, templateName: 'tpl-un' }, { code: 131047, count: 2, templateName: 'tpl-deux' }] });
    }
    if (url.includes('/stats')) return json({ contacts: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [] });
    if (url.includes('/campaigns')) return json({ campaigns: CAMPAGNES });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/dashboard');
  await expect(page.getByTestId('cout-campagnes')).toBeVisible({ timeout: 15_000 });
  return { appelsCout };
}

test.describe('Analytics : filtres multiples', () => {
  test('🔴 deux campagnes choisies partent ENSEMBLE dans la requête (série compilée)', async ({ page }) => {
    const { appelsCout } = await monter(page);
    await page.getByTestId('cout-campagnes').selectOption('camp-a');
    await page.getByTestId('cout-campagnes').selectOption('camp-b');

    await expect.poll(() => appelsCout.some((u) => {
      const v = new URL(u).searchParams.get('campaignIds');
      return v === 'camp-a,camp-b';
    }), { timeout: 15_000 }).toBe(true);
  });

  test('🔴 les deux axes sont mutuellement exclusifs : choisir un template vide les campagnes', async ({ page }) => {
    // Les croiser produirait l'INTERSECTION (campagne A ET template B), qui ne décrit rien d'utile.
    const { appelsCout } = await monter(page);
    await page.getByTestId('cout-campagnes').selectOption('camp-a');
    await page.getByTestId('cout-templates').selectOption('tpl-un');

    await expect.poll(() => {
      const dernier = appelsCout[appelsCout.length - 1];
      if (dernier === undefined) return false;
      const p = new URL(dernier).searchParams;
      return p.get('templateNames') === 'tpl-un' && p.get('campaignIds') === null;
    }, { timeout: 15_000 }).toBe(true);
  });

  test('une valeur retenue se retire, et le filtre repart à « tout »', async ({ page }) => {
    const { appelsCout } = await monter(page);
    await page.getByTestId('cout-campagnes').selectOption('camp-a');
    // La pastille du groupe, pas n'importe quel « Promo A » de la page : le nom apparait aussi ailleurs.
    const pastille = page.getByTestId('cout-campagnes-retenu');
    await expect(pastille).toHaveText(/Promo A/);
    await pastille.getByRole('button').click();
    await expect(pastille).toHaveCount(0);

    await expect.poll(() => {
      const dernier = appelsCout[appelsCout.length - 1];
      return dernier !== undefined && new URL(dernier).searchParams.get('campaignIds') === null;
    }, { timeout: 15_000 }).toBe(true);
  });

  test('🔴 carte Erreurs : plusieurs templates -> breakdown compilé', async ({ page }) => {
    // Filtre LOCAL (le breakdown est déjà chargé) : ce qui compte est que les deux codes restent visibles
    // quand les deux templates sont retenus, et qu'un seul les réduise.
    await monter(page);
    await expect(page.getByText('131026')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('erreurs-templates').selectOption('tpl-un');
    await expect(page.getByText('131047')).toHaveCount(0);

    await page.getByTestId('erreurs-templates').selectOption('tpl-deux');
    await expect(page.getByText('131026')).toBeVisible();
    await expect(page.getByText('131047')).toBeVisible();
  });
});
