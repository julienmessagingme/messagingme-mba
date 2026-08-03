import { test, expect } from '@playwright/test';

/**
 * E2E Automation (Lot E) : créer une automation « mot-clé » depuis l'écran, et vérifier qu'elle part
 * DÉSACTIVÉE (une automation écrit au client sans relecture humaine : elle ne s'allume jamais toute seule).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const WF = { id: 'wf1', name: 'Prise de RDV', graph: { nodes: [], edges: [] } };

test.describe('Automation : création d’un déclencheur mot-clé', () => {
  test('crée une automation désactivée avec ses mots-clés, puis l’active', async ({ page }) => {
    const posted: Array<Record<string, unknown>> = [];
    const patched: Array<Record<string, unknown>> = [];
    let listed: Array<Record<string, unknown>> = [];

    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.endsWith('/automations') && req.method() === 'POST') {
        const body = req.postDataJSON() as Record<string, unknown>;
        posted.push(body);
        listed = [{ id: 'a1', ...body, conditionGroup: null, startNodeId: null, cooldownSeconds: null }];
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'a1' }) });
      }
      if (/\/automations\/a1$/.test(url) && req.method() === 'PATCH') {
        const body = req.postDataJSON() as Record<string, unknown>;
        patched.push(body);
        return json({ id: 'a1' });
      }
      if (url.endsWith('/automations')) return json({ automations: listed });
      if (url.endsWith('/workflows')) return json({ workflows: [WF] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/automations');

    await page.getByTestId('automation-add').click();
    await page.getByTestId('automation-name').fill('Demande de RDV');
    await page.getByTestId('automation-keywords').fill('rdv, rendez-vous');
    await page.getByTestId('automation-workflow').selectOption('wf1');
    await page.getByTestId('automation-submit').click();

    // Créée DÉSACTIVÉE, avec les mots-clés découpés et nettoyés.
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      name: 'Demande de RDV',
      triggerKind: 'keyword',
      triggerConfig: { keywords: ['rdv', 'rendez-vous'], mode: 'contains' },
      workflowId: 'wf1',
      enabled: false,
    });

    // Elle apparaît dans la liste, désactivée, et le clic l'active.
    const toggle = page.getByTestId('automation-toggle-a1');
    await expect(toggle).toHaveText(/désactivée/);
    await toggle.click();
    await expect.poll(() => patched.length).toBe(1);
    expect(patched[0]).toEqual({ enabled: true });
  });
});
