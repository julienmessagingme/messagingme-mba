import { test, expect } from '@playwright/test';

/**
 * 1er E2E du builder de scénario : le node Condition s'ajoute, se configure (constructeur de clauses), rend ses DEUX
 * sorties « Si réunie » / « Sinon », et l'auto-save persiste le graphe (clauses + arêtes typées true/false). Backend
 * intercepté (aucune base), pattern des E2E accueil. On n'exerce PAS le drag React Flow (fragile) : le câblage des
 * sorties est vérifié via un graphe pré-câblé qui doit survivre à une sauvegarde.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

/** Intercepte les appels du builder ; renvoie le graphe `initial`, et pousse chaque graphe PATCHé dans `saved`. */
async function mockBuilder(page: import('@playwright/test').Page, initial: Graph, saved: Graph[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: initial, createdAt: '', updatedAt: '' };
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
      const body = (req.postDataJSON() ?? {}) as { graph?: Graph };
      if (body.graph) saved.push(body.graph);
      return json({ ok: true });
    }
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: initial }] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Builder : node Condition', () => {
  test('ajoute un node Condition, configure une clause, et l’auto-save le persiste', async ({ page }) => {
    const saved: Graph[] = [];
    // Graphe de départ : un template (ouverture légale) pour ne pas déclencher la garde fenêtre 24 h.
    await mockBuilder(page, { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] }, saved);

    await page.goto('/workflows?open=wf1');

    // Ajoute un bloc Condition via la palette.
    await page.getByTestId('add-node-condition').click();

    // Le node rend ses deux sorties typées.
    await expect(page.getByText('Si réunie').first()).toBeVisible();
    await expect(page.getByText('Sinon').first()).toBeVisible();

    // Le ConfigPanel du node condition (sélectionné à la création) propose le constructeur de clauses.
    const addClause = page.getByRole('button', { name: /ajouter une condition/ });
    await expect(addClause).toBeVisible();
    await addClause.click();

    // L'auto-save doit persister un graphe contenant un node 'condition' AVEC au moins une clause.
    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) => n.type === 'condition' && Array.isArray((n.data as { clauses?: unknown }).clauses) && ((n.data as { clauses: unknown[] }).clauses.length >= 1))),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('un graphe pré-câblé (condition -> Oui/Sinon) rend ses 2 sorties et l’auto-save préserve les arêtes true/false', async ({ page }) => {
    const saved: Graph[] = [];
    const initial: Graph = {
      nodes: [
        { id: 'tpl', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } },
        { id: 'c', type: 'condition', position: { x: 0, y: 120 }, data: { match: 'all', clauses: [{ kind: 'tag', op: 'has', tag: 'vip' }] } },
        { id: 'g', type: 'tag', position: { x: 200, y: 60 }, data: { tag: 'gold' } },
        { id: 's', type: 'tag', position: { x: 200, y: 180 }, data: { tag: 'std' } },
      ],
      edges: [
        { id: 'e0', source: 'tpl', target: 'c' },
        { id: 'e1', source: 'c', target: 'g', sourceHandle: 'true' },
        { id: 'e2', source: 'c', target: 's', sourceHandle: 'false' },
      ],
    };
    await mockBuilder(page, initial, saved);
    await page.goto('/workflows?open=wf1');

    // Les 2 sorties du node condition sont rendues.
    await expect(page.getByText('Si réunie').first()).toBeVisible();
    await expect(page.getByText('Sinon').first()).toBeVisible();

    // Déclenche une sauvegarde sans toucher aux arêtes (auto-arranger repositionne -> auto-save).
    await page.getByTestId('workflow-autoarrange').click();

    // Le graphe sauvé conserve les DEUX arêtes typées true/false (fromRF préserve sourceHandle).
    await expect.poll(() => {
      const g = saved[saved.length - 1];
      if (!g) return null;
      const handles = g.edges.filter((e) => e.source === 'c').map((e) => e.sourceHandle).sort();
      return handles;
    }, { timeout: 10_000 }).toEqual(['false', 'true']);
  });
});
