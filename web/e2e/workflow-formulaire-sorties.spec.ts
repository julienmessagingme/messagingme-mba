import { test, expect } from './aide/test';

/**
 * 🔴 LE BLOC FORMULAIRE A DEUX SORTIES (Julien, 2026-10-15) : « Formulaire rempli » (poignée `rempli`) et « Toute autre
 * réponse » (l'arête LIBRE, enregistrée sans poignée). Avant, sa sortie unique recevait tout. Un montage d'avant, une
 * seule flèche libre, doit garder sa flèche telle quelle : c'est elle qui devient « Toute autre réponse ».
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

/** Un montage d'AVANT : le formulaire et sa flèche unique, sans poignée. */
const MONTAGE_D_AVANT: Graph = {
  nodes: [
    { id: 'n1', type: 'flow', position: { x: 0, y: 0 }, data: { wfType: 'flow', flowId: 'fl1', flowName: 'RDV' } },
    { id: 'n2', type: 'tag', position: { x: 420, y: -60 }, data: { wfType: 'tag', tag: 'autre' } },
    { id: 'n3', type: 'tag', position: { x: 420, y: 160 }, data: { wfType: 'tag', tag: 'rempli' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

async function mockBuilder(page: import('@playwright/test').Page, saved: Graph[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: MONTAGE_D_AVANT, createdAt: '', updatedAt: '' };
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
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: MONTAGE_D_AVANT }] });
    if (url.includes('/email/accounts')) return json({ accounts: [] });
    if (url.includes('/email/templates')) return json({ templates: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [{ id: 'fl1', name: 'RDV', status: 'PUBLISHED' }] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields/usage')) return json({ total: 0, parChamp: {} });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Bloc Formulaire : « Formulaire rempli » et « Toute autre réponse »', () => {
  test('🔴 le bloc montre ses deux sorties, et « Formulaire rempli » se relie et s’enregistre sous `rempli`', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, saved);
    await page.goto('/workflows?open=wf1');
    const bloc = page.locator('.react-flow__node[data-id="n1"]');
    await expect(bloc.getByText('Formulaire rempli')).toBeVisible();
    await expect(bloc.getByText('Toute autre réponse')).toBeVisible();

    const depart = await bloc.locator('.react-flow__handle[data-handleid="rempli"]').boundingBox();
    const arrivee = await page.locator('.react-flow__node[data-id="n3"] .react-flow__handle-top').boundingBox();
    await page.mouse.move(depart!.x + depart!.width / 2, depart!.y + depart!.height / 2);
    await page.mouse.down();
    await page.mouse.move(arrivee!.x + arrivee!.width / 2, arrivee!.y + arrivee!.height / 2, { steps: 15 });
    await page.mouse.up();

    // La nouvelle flèche part de `rempli` ; celle du montage d'avant reste LIBRE (sans poignée), donc « Toute autre
    // réponse » : le moteur continue de lui envoyer tout ce qui n'est pas un formulaire renvoyé.
    await expect.poll(() => saved.at(-1)?.edges.map((e) => `${e.source}>${e.target}:${String(e.sourceHandle ?? 'libre')}`).sort(), { timeout: 10_000 })
      .toEqual(['n1>n2:libre', 'n1>n3:rempli']);
  });
});
