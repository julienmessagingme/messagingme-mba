import { test, expect } from './aide/test';

/**
 * La réserve de numéros fournis dans `/ops`, onglet Réglages (2026-10-28, plan
 * `docs/superpowers/plans/2026-10-28-reserve-numeros-ailleurs.md`). Vécu : le numéro de l'application WhatsApp Business
 * de Julien était `libre` dans la réserve. Ce que ces tests protègent à l'écran : un numéro utilisé ailleurs est
 * signalé et ne compte pas parmi les libres, la sortie de la réserve exige une note et part avec elle, et une API
 * d'avant (sans la route) le dit sans casser la carte. Le serveur est tenu par `tests/ops-numeros.test.ts`.
 */
const SESSION_OPS = { token: 'session-ops-e2e', email: 'exploitant@e2e.test' };
const ID = 'a09d4af6-b35a-466f-bb7a-70dda6706294';

function numero(o: Record<string, unknown>) {
  return { didwwDidId: 'did', tenantId: null, attribueLe: null, creeLe: '2026-10-21T15:30:00Z', dernierCode: null, ...o };
}

async function ouvrir(page: import('@playwright/test').Page, o: { routeAbsente?: boolean } = {}) {
  const sorties: unknown[] = [];
  let sorti = false;
  await page.addInitScript((s) => window.localStorage.setItem('mba.sessionOps', JSON.stringify(s)), SESSION_OPS);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/ops/overview')) return json({ tenants: [], daily: [], queues: [], worker: null });
    if (chemin.endsWith(`/ops/numeros-fournis/${ID}/sortir`)) {
      if (o.routeAbsente) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
      sorties.push(route.request().postDataJSON());
      sorti = true;
      return json({ numero: '441555479304' });
    }
    if (chemin.endsWith('/ops/numeros-fournis')) {
      return json({
        configure: true, libres: 1, numeros: [
          numero({ id: 'n-300', numero: '441555479300', statut: 'libre', ailleurs: null }),
          numero({ id: ID, numero: '441555479304', statut: sorti ? 'bloque' : 'libre', ailleurs: sorti ? null : 'application' }),
        ],
      });
    }
    return json({});
  });
  await page.goto('/ops?tab=reglages');
  const carte = page.getByTestId('numeros-fournis');
  await expect(carte).toBeVisible();
  return { carte, sorties };
}

test.describe('Ops : la réserve de numéros fournis', () => {
  test('🔴 un numéro utilisé ailleurs est signalé et ne compte pas parmi les libres', async ({ page }) => {
    const { carte } = await ouvrir(page);
    await expect(carte.getByTestId('numeros-libres')).toHaveText('1');
    await expect(carte.getByTestId('numero-fourni-441555479304').getByTestId('numero-ailleurs')).toContainText(/application WhatsApp Business|WhatsApp Business app/);
    await expect(carte.getByTestId('numero-fourni-441555479300').getByTestId('numero-ailleurs')).toHaveCount(0);
  });

  test('🔴 sortir de la réserve : la note est obligatoire, part avec la sortie, et la ligne passe hors réserve', async ({ page }) => {
    const { carte, sorties } = await ouvrir(page);
    const ligne = carte.getByTestId('numero-fourni-441555479304');
    await ligne.getByTestId('sortir-de-la-reserve').click();
    await expect(ligne.getByTestId('confirmer-sortie')).toBeDisabled();
    await ligne.getByRole('textbox').fill('mon application WhatsApp Business');
    await ligne.getByTestId('confirmer-sortie').click();
    await expect(carte).toContainText(/sorti de la réserve|out of the reserve/);
    expect(sorties).toEqual([{ note: 'mon application WhatsApp Business' }]);
    await expect(ligne).toContainText(/hors réserve|out of the reserve/);
    await expect(ligne.getByTestId('sortir-de-la-reserve')).toHaveCount(0);
  });

  test('une API d’avant, sans la route : la carte le dit, le numéro reste affiché', async ({ page }) => {
    const { carte } = await ouvrir(page, { routeAbsente: true });
    const ligne = carte.getByTestId('numero-fourni-441555479304');
    await ligne.getByTestId('sortir-de-la-reserve').click();
    await ligne.getByRole('textbox').fill('mon application');
    await ligne.getByTestId('confirmer-sortie').click();
    await expect(carte).toContainText(/pas encore sur cette version|does not exist yet/);
    await expect(ligne).toContainText('+441555479304');
  });
});
