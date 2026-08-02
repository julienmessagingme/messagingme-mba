import { test, expect } from '@playwright/test';

/**
 * E2E builder : les blocs MBA (envoi vers MBA / désactivation) sont PRÉSENTS dans la palette mais GRISÉS +
 * désactivés tant que MBA n'est pas actif chez le tenant (settings.mbaEnabled=false). Pré-câblage inerte.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

test.describe('Builder : blocs MBA grisés (pré-câblage inerte)', () => {
  test('les blocs MBA sont visibles mais désactivés quand mbaEnabled=false', async ({ page }) => {
    const initial: Graph = { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] };
    const wf = { id: 'wf1', name: 'Scénario E2E', graph: initial, createdAt: '', updatedAt: '' };

    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
      if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: initial }] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {}, returnBehavior: null });
      if (url.includes('/templates')) return json({ templates: [] });
      if (url.includes('/flows')) return json({ flows: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });

    await page.goto('/workflows?open=wf1');

    // Les deux blocs MBA sont dans la palette (préparés) mais désactivés (grisés).
    const handoff = page.getByTestId('add-node-mba_handoff');
    const disable = page.getByTestId('add-node-mba_disable');
    await expect(handoff).toBeVisible();
    await expect(disable).toBeVisible();
    await expect(handoff).toBeDisabled();
    await expect(disable).toBeDisabled();

    // Un bloc utilisable (Action) reste, lui, actif.
    await expect(page.getByTestId('add-node-action')).toBeEnabled();
  });
});
