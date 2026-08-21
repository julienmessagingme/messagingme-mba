import { test, expect } from '@playwright/test';

/**
 * Observation d'un espace client depuis la surface d'exploitation.
 *
 * Ce que ces tests protègent à l'écran : qu'on n'oublie JAMAIS qu'on regarde chez quelqu'un d'autre. La
 * lecture seule, elle, est imposée par le serveur (`tests/ops-observation.test.ts`) ; le bandeau ne protège
 * rien, il évite de prendre les chiffres d'un client pour les siens.
 */
const OPS_TOKEN = 'ops-token-e2e';

test.describe('Ops : observer un espace', () => {
  test('le bouton ouvre une session d’observation et bascule dans l’espace', async ({ page }) => {
    const appels: Array<{ url: string; body: unknown }> = [];
    await page.addInitScript((tok) => window.localStorage.setItem('mba.ops', tok), OPS_TOKEN);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const chemin = url.split('?')[0]!;
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (chemin.endsWith('/ops/observe')) {
        appels.push({ url, body: route.request().postDataJSON() });
        return json({ token: 'jeton-observation', tenantId: 't-client', tenantName: 'Client Démo' });
      }
      if (chemin.endsWith('/ops/overview')) {
        return json({
          tenants: [{
            id: 't-client', name: 'Client Démo', createdAt: '2026-01-01T00:00:00Z', mbaEnabled: false,
            users: 1, contacts: 0, messages: 0, templatesUsed: 0, lastSendAt: null,
            phone: null, phoneStatus: null, quality: null,
          }],
          daily: [], queues: [], worker: null,
        });
      }
      if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
      if (chemin.endsWith('/conversations')) return json({ conversations: [] });
      if (chemin.endsWith('/me')) return json({ email: 'observation:Client Démo', name: 'Observation', role: 'admin' });
      return json({});
    });
    // La confirmation est volontaire : entrer chez un client remplace la session en cours.
    page.on('dialog', (d) => { void d.accept(); });

    await page.goto('/ops');
    await page.getByTestId('observe-t-client').click();
    await expect.poll(() => appels.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(appels[0]?.body).toEqual({ tenantId: 't-client' });

    // On arrive dans l'espace du client, et le bandeau le RAPPELLE en permanence.
    await page.waitForURL('**/inbox', { timeout: 15_000 });
    const bandeau = page.getByTestId('bandeau-observation');
    await expect(bandeau).toBeVisible();
    await expect(bandeau).toContainText('Client Démo');
    await expect(bandeau).toContainText(/Aucune modification n’est possible|No change is possible/);
  });

  test('🔴 une session NORMALE n’affiche aucun bandeau', async ({ page }) => {
    // Sinon le bandeau deviendrait un décor qu'on ne lit plus, et il ne servirait plus à rien le jour où il
    // compte vraiment.
    await page.addInitScript(() => window.localStorage.setItem('mba.session', JSON.stringify({
      token: 'jeton', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e',
    })));
    await page.route('**/api/backend/**', async (route) => {
      const chemin = route.request().url().split('?')[0]!;
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
      if (chemin.endsWith('/conversations')) return json({ conversations: [] });
      if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean', role: 'admin' });
      return json({});
    });
    await page.goto('/inbox');
    await expect(page.getByTestId('bandeau-observation')).toHaveCount(0);
  });
});
