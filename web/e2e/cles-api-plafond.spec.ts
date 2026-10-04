import { test, expect, type Page } from '@playwright/test';

/**
 * AU PLUS DIX CLÉS ACTIVES PAR ESPACE, VU DE LA CONSOLE (2026-10-04).
 *
 * 🔴 CE QUE CES TESTS TIENNENT : à dix clés actives, « Créer la clé » est grisé et l'écran dit quoi faire ; la clé du
 * relais de l'agent de Meta et les clés révoquées ne comptent pas ; un refus 409 du serveur (deux admins en même
 * temps) s'affiche tel quel. Le plafond lui-même est tenu en base (`tests/integration/api-keys-plafond.integration.test.ts`).
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const cle = (id: string, scopes: string[], revokedAt: string | null = null) => ({
  id, name: `Clé ${id}`, scopes, createdAt: '2026-10-01T08:00:00.000Z', lastUsedAt: null, revokedAt,
});
const actives = (n: number) => Array.from({ length: n }, (_, i) => cle(`k${i}`, ['contacts:write']));
const RELAIS = cle('relais', ['mba:relais']);
const REVOQUEES = [cle('r1', ['contacts:write'], '2026-10-02T08:00:00.000Z'), cle('r2', ['sends:create'], '2026-10-02T08:00:00.000Z')];

async function monter(page: Page, cles: unknown[], creation?: { status: number; body: unknown }): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Admin', role: 'admin' });
    if (chemin.endsWith('/api-keys') && req.method() === 'POST' && creation) return json(creation.body, creation.status);
    if (chemin.endsWith('/api-keys')) return json({ keys: cles });
    if (chemin.endsWith('/oauth/autorisations')) return json({ autorisations: [] });
    return json({});
  });
}

test.describe('Clés d’API : le plafond de dix clés actives', () => {
  test('🔴 à dix clés actives, la création est grisée et l’écran dit de révoquer', async ({ page }) => {
    await monter(page, [...actives(10), RELAIS, ...REVOQUEES]);
    await page.goto('/developers/keys');
    await expect(page.getByRole('row')).toHaveCount(14);
    await expect(page.getByTestId('compte-cles')).toHaveText('10 sur 10 clés actives');
    await page.getByPlaceholder('Nom (ex. « intégration site web »)').fill('Une de trop');
    await expect(page.getByRole('button', { name: 'Créer la clé' })).toBeDisabled();
    await expect(page.getByTestId('plafond-cles')).toHaveText('10 clés actives au maximum par espace (la clé « Agent de Meta » ne compte pas) : révoquez-en une pour en créer une autre.');
  });

  test('🔴 la clé du relais et les révoquées ne comptent pas : à neuf, on crée encore', async ({ page }) => {
    await monter(page, [...actives(9), RELAIS, ...REVOQUEES]);
    await page.goto('/developers/keys');
    await expect(page.getByRole('row')).toHaveCount(13);
    // Le relais et les révoquées hors du compte : neuf, pas douze.
    await expect(page.getByTestId('compte-cles')).toHaveText('9 sur 10 clés actives');
    await page.getByPlaceholder('Nom (ex. « intégration site web »)').fill('La dixième');
    await expect(page.getByRole('button', { name: 'Créer la clé' })).toBeEnabled();
    await expect(page.getByTestId('plafond-cles')).toHaveCount(0);
  });

  test('un refus 409 du serveur s’affiche tel quel', async ({ page }) => {
    const message = '10 clés actives au maximum par espace (la clé « Agent de Meta » ne compte pas) : révoquez-en une pour en créer une autre';
    await monter(page, actives(9), { status: 409, body: { error: message } });
    await page.goto('/developers/keys');
    await page.getByPlaceholder('Nom (ex. « intégration site web »)').fill('Course');
    await page.getByRole('button', { name: 'Créer la clé' }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
  });
});
