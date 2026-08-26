import { test, expect } from '@playwright/test';

/**
 * La sortie « Toute autre réponse » : ce que le contact envoie quand il ÉCRIT au lieu de taper un bouton.
 *
 * Signalé par Julien le 2026-08-26 : « je ne peux pas relier le point Toute autre réponse, alors que c'est une
 * bonne idée ». Le canevas la dessine pourtant depuis toujours. Ce test reproduit le geste réel, avec un
 * CONTRÔLE depuis un bouton ordinaire : si le contrôle passe et pas la sortie libre, le défaut est bien sur
 * cette sortie et non sur la mécanique de glisser-déposer.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

const DEUX_BLOCS: Graph = {
  nodes: [
    { id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { wfType: 'quick_message', body: 'Un souci ?', quickReplies: ['Oui', 'Non'] } },
    { id: 'n2', type: 'tag', position: { x: 420, y: 40 }, data: { wfType: 'tag', tag: 'ok' } },
  ],
  edges: [],
};

async function mockBuilder(page: import('@playwright/test').Page, saved: Graph[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: DEUX_BLOCS, createdAt: '', updatedAt: '' };
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
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: DEUX_BLOCS }] });
    if (url.includes('/email/accounts')) return json({ accounts: [] });
    if (url.includes('/email/templates')) return json({ templates: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields/usage')) return json({ total: 0, parChamp: {} });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

/** Tire une flèche de la n-ième poignée de sortie vers la poignée d'ENTRÉE du bloc cible. */
async function relier(page: import('@playwright/test').Page, indexSortie: number) {
  const depart = await page.locator('.react-flow__handle-right').nth(indexSortie).boundingBox();
  const arrivee = await page.locator('.react-flow__handle-top').last().boundingBox();
  await page.mouse.move(depart!.x + depart!.width / 2, depart!.y + depart!.height / 2);
  await page.mouse.down();
  await page.mouse.move(arrivee!.x + arrivee!.width / 2, arrivee!.y + arrivee!.height / 2, { steps: 15 });
  await page.mouse.up();
}

test.describe('Scénario : relier « Toute autre réponse »', () => {
  test('🔴 tirer la sortie libre DANS LE VIDE propose la nature du bloc, comme un bouton', async ({ page }) => {
    // C'est le geste principal de cet éditeur : on tire, on lâche dans le vide, on choisit le bloc à créer.
    await mockBuilder(page, []);
    await page.goto('/workflows?open=wf1');
    const depart = await page.locator('.react-flow__handle-right').nth(2).boundingBox();
    await page.mouse.move(depart!.x + depart!.width / 2, depart!.y + depart!.height / 2);
    await page.mouse.down();
    await page.mouse.move(depart!.x + 200, depart!.y + 220, { steps: 15 });
    await page.mouse.up();
    await expect(page.getByTestId('node-type-chooser')).toBeVisible();
  });

  test('🔴 lâcher la flèche SUR le bloc visé suffit (plus besoin de viser son petit point)', async ({ page }) => {
    // C'est ce qui donnait le sentiment que ça ne marchait pas : par défaut il fallait lâcher à 20 px du
    // point d'entrée, sinon rien ne se passait et l'éditeur avait l'air cassé.
    const saved: Graph[] = [];
    await mockBuilder(page, saved);
    await page.goto('/workflows?open=wf1');
    const depart = await page.locator('.react-flow__handle-right').nth(2).boundingBox();
    const bloc = await page.locator('.react-flow__node').nth(1).boundingBox();
    await page.mouse.move(depart!.x + depart!.width / 2, depart!.y + depart!.height / 2);
    await page.mouse.down();
    // Au CENTRE du bloc cible, pas sur sa poignée.
    await page.mouse.move(bloc!.x + bloc!.width / 2, bloc!.y + bloc!.height / 2, { steps: 15 });
    await page.mouse.up();
    await expect.poll(
      () => saved.some((g) => g.edges.some((e) => e.source === 'n1' && e.target === 'n2' && !e.sourceHandle)),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('contrôle : relier un bouton ordinaire fonctionne', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, saved);
    await page.goto('/workflows?open=wf1');
    await relier(page, 0); // btn:0
    await expect.poll(
      () => saved.some((g) => g.edges.some((e) => e.source === 'n1' && e.sourceHandle === 'btn:0')),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('🔴 relier « Toute autre réponse » crée une arête SANS sourceHandle', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, saved);
    await page.goto('/workflows?open=wf1');
    // Ordre des sorties d'un bloc à 2 réponses : btn:0, btn:1, puis la sortie libre.
    await relier(page, 2);
    await expect.poll(
      () => saved.some((g) => g.edges.some((e) => e.source === 'n1' && !e.sourceHandle)),
      { timeout: 10_000 },
    ).toBe(true);
  });
});
