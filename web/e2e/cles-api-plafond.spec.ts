import { test, expect, type Page } from './aide/test';

/**
 * LE PLAFOND DE CLÉS ACTIVES, VU DE LA CONSOLE (2026-10-04, par offre depuis la spec offres v2).
 *
 * 🔴 CE QUE CES TESTS TIENNENT : au plafond de l'offre (2 en Free, 10 en Pro, sans limite en Entreprise), « Créer la clé »
 * est grisé et l'écran dit quoi faire ; dix en repli quand l'offre est inconnue ; la clé du relais de l'agent de Meta et
 * les clés révoquées ne comptent pas ; un refus 402 du serveur (deux admins en même temps) s'affiche tel quel. Le plafond
 * lui-même est tenu en base (`tests/integration/api-keys-plafond.integration.test.ts`).
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const cle = (id: string, scopes: string[], revokedAt: string | null = null) => ({
  id, name: `Clé ${id}`, scopes, createdAt: '2026-10-01T08:00:00.000Z', lastUsedAt: null, revokedAt,
});
const actives = (n: number) => Array.from({ length: n }, (_, i) => cle(`k${i}`, ['contacts:write']));
const RELAIS = cle('relais', ['mba:relais']);
const REVOQUEES = [cle('r1', ['contacts:write'], '2026-10-02T08:00:00.000Z'), cle('r2', ['sends:create'], '2026-10-02T08:00:00.000Z')];

/** Une vue de l'offre lisible par la console, au plafond de clés donné (`null` = sans limite). */
const limites = (clesApi: number | null) => ({
  utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
  adressesWebhook: null, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true,
  clesApi,
});
const vueOffre = (offre: 'free' | 'entreprise', clesApi: number | null) => ({
  offre, fonctions: [], limites: limites(clesApi), usage: { envoisModelesMois: null, contacts: 0, automations: 0, membres: 1 },
  grille: { free: { fonctions: [], limites: limites(2) }, pro: { fonctions: [], limites: limites(10) }, entreprise: { fonctions: [], limites: limites(null) } },
  upgradeUrl: 'https://console.e2e.test/offre',
});

async function monter(page: Page, cles: unknown[], o: { creation?: { status: number; body: unknown }; offre?: unknown } = {}): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Admin', role: 'admin' });
    if (chemin.endsWith('/offre') && o.offre) return json(o.offre);
    if (chemin.endsWith('/api-keys') && req.method() === 'POST' && o.creation) return json(o.creation.body, o.creation.status);
    if (chemin.endsWith('/api-keys')) return json({ keys: cles });
    if (chemin.endsWith('/oauth/autorisations')) return json({ autorisations: [] });
    return json({});
  });
}

const NOM = 'Nom (ex. « intégration site web »)';

test.describe('Clés d’API : le plafond de clés actives de l’offre', () => {
  test('🔴 offre inconnue : dix en repli, la création est grisée et l’écran dit de révoquer', async ({ page }) => {
    await monter(page, [...actives(10), RELAIS, ...REVOQUEES]);
    await page.goto('/developers/keys');
    await expect(page.getByRole('row')).toHaveCount(14);
    await expect(page.getByTestId('compte-cles')).toHaveText('10 sur 10 clés actives');
    await page.getByPlaceholder(NOM).fill('Une de trop');
    await expect(page.getByRole('button', { name: 'Créer la clé' })).toBeDisabled();
    await expect(page.getByTestId('plafond-cles')).toHaveText('10 clés actives au maximum avec votre offre (la clé « Agent de Meta » ne compte pas) : révoquez-en une pour en créer une autre.');
  });

  test('🔴 la clé du relais et les révoquées ne comptent pas : à neuf, on crée encore', async ({ page }) => {
    await monter(page, [...actives(9), RELAIS, ...REVOQUEES]);
    await page.goto('/developers/keys');
    await expect(page.getByRole('row')).toHaveCount(13);
    // Le relais et les révoquées hors du compte : neuf, pas douze.
    await expect(page.getByTestId('compte-cles')).toHaveText('9 sur 10 clés actives');
    await page.getByPlaceholder(NOM).fill('La dixième');
    await expect(page.getByRole('button', { name: 'Créer la clé' })).toBeEnabled();
    await expect(page.getByTestId('plafond-cles')).toHaveCount(0);
  });

  test('🔴 une Free est au plafond à deux clés, le relais mis à part', async ({ page }) => {
    await monter(page, [...actives(2), RELAIS], { offre: vueOffre('free', 2) });
    await page.goto('/developers/keys');
    await expect(page.getByTestId('compte-cles')).toHaveText('2 sur 2 clés actives');
    await page.getByPlaceholder(NOM).fill('La troisième');
    await expect(page.getByRole('button', { name: 'Créer la clé' })).toBeDisabled();
    await expect(page.getByTestId('plafond-cles')).toHaveText('2 clés actives au maximum avec votre offre (la clé « Agent de Meta » ne compte pas) : révoquez-en une pour en créer une autre.');
  });

  test('une Entreprise est sans limite : à douze clés, on crée encore', async ({ page }) => {
    await monter(page, actives(12), { offre: vueOffre('entreprise', null) });
    await page.goto('/developers/keys');
    await expect(page.getByTestId('compte-cles')).toHaveText('12 clés actives');
    await page.getByPlaceholder(NOM).fill('La treizième');
    await expect(page.getByRole('button', { name: 'Créer la clé' })).toBeEnabled();
    await expect(page.getByTestId('plafond-cles')).toHaveCount(0);
  });

  test('un refus 402 du serveur s’affiche tel quel', async ({ page }) => {
    const message = 'Limite de votre offre atteinte : 2 clés d’API actives (révoquez-en une pour en créer une autre ; la clé de l’agent de Meta ne compte pas). Passez en Pro pour la lever : https://console.e2e.test/offre';
    await monter(page, actives(1), {
      offre: vueOffre('free', 2),
      creation: { status: 402, body: { error: message, code: 'plan_limit_reached', limite: 'clesApi', max: 2, upgradeUrl: 'https://console.e2e.test/offre' } },
    });
    await page.goto('/developers/keys');
    await page.getByPlaceholder(NOM).fill('Course');
    await page.getByRole('button', { name: 'Créer la clé' }).click();
    await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
  });
});
