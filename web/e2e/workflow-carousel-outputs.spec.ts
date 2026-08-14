import { test, expect } from '@playwright/test';

/**
 * E2E builder : un bloc « envoi de template » qui envoie un CAROUSEL expose UNE SORTIE PAR BOUTON DE CARTE.
 * Avant, le bloc lisait les boutons de PREMIER NIVEAU du template ; un carousel n'en a aucun (ils vivent dans
 * les cartes), donc le bloc n'affichait aucune sortie et rien ne pouvait être branché après lui.
 *
 * Le nom de chaque sortie est celui que l'envoi pose en payload chez Meta (`card:<carte>:btn:<bouton>`), sinon
 * un tap ne retrouverait pas la branche reliée. On ne pilote PAS le drag React Flow (fragile) : le câblage est
 * vérifié via un graphe pré-câblé qui doit survivre à une sauvegarde.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

const CAROUSEL = {
  id: 'C1', name: 'exempleju2', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Notre sélection', headerFormat: null, isCarousel: true, editable: false,
  carousel: {
    cards: [
      { mediaUrl: 'https://cdn.example/a.jpg', body: 'Masterclass', buttons: [{ type: 'QUICK_REPLY', text: 'Je viens' }, { type: 'URL', text: 'Le site', url: 'https://a.fr' }] },
      { mediaUrl: 'https://cdn.example/b.jpg', body: 'Portes ouvertes', buttons: [{ type: 'QUICK_REPLY', text: 'Ça m’intéresse' }, { type: 'URL', text: 'Le site', url: 'https://b.fr' }] },
    ],
  },
};

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
    if (url.includes('/templates')) return json({ templates: [CAROUSEL] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

/** Bloc template déjà configuré sur le carousel : les sorties sont dérivées à la sélection du template. */
const CABLE: Graph = {
  nodes: [
    {
      id: 'n1', type: 'template', position: { x: 0, y: 0 },
      data: {
        wfType: 'template', templateName: 'exempleju2', language: 'fr', templateButtons: [],
        templateCards: [
          { type: 'QUICK_REPLY', text: 'Je viens', handle: 'card:0:btn:0', cardIndex: 0 },
          { type: 'URL', text: 'Le site', handle: 'card:0:btn:1', cardIndex: 0 },
          { type: 'QUICK_REPLY', text: 'Ça m’intéresse', handle: 'card:1:btn:0', cardIndex: 1 },
          { type: 'URL', text: 'Le site', handle: 'card:1:btn:1', cardIndex: 1 },
        ],
      },
    },
    { id: 'n2', type: 'tag', position: { x: 300, y: -60 }, data: { wfType: 'tag', tag: 'venu' } },
    { id: 'n3', type: 'tag', position: { x: 300, y: 60 }, data: { wfType: 'tag', tag: 'curieux' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'card:0:btn:0' },
    { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'card:1:btn:0' },
  ],
};

test.describe('Builder : sorties d’un bloc carousel', () => {
  test('une sortie par bouton de carte, étiquetée par carte, les liens non reliables', async ({ page }) => {
    await mockBuilder(page, CABLE, []);
    await page.goto('/workflows?open=wf1');

    // Les 4 boutons des 2 cartes sont listés sur le bloc, chacun rattaché à SA carte.
    await expect(page.getByText('Je viens').first()).toBeVisible();
    await expect(page.getByText('Ça m’intéresse').first()).toBeVisible();
    await expect(page.getByText('C1', { exact: true })).toHaveCount(2);
    await expect(page.getByText('C2', { exact: true })).toHaveCount(2);

    // Seules les réponses rapides sont reliables : un lien ouvre le navigateur et ne renvoie rien.
    await expect(page.locator('[data-handleid^="card:"]')).toHaveCount(2);
    await expect(page.locator('[data-handleid="card:0:btn:0"]')).toHaveCount(1);
    await expect(page.locator('[data-handleid="card:1:btn:0"]')).toHaveCount(1);
    await expect(page.locator('[data-handleid="card:0:btn:1"]')).toHaveCount(0); // le lien n'a pas de poignée
  });

  test('les fils reliés à des boutons de cartes DIFFÉRENTES survivent à une sauvegarde', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, CABLE, saved);
    await page.goto('/workflows?open=wf1');
    await expect(page.getByText('Je viens').first()).toBeVisible();

    await page.getByTestId('workflow-autoarrange').click();

    await expect.poll(() => {
      const g = saved[saved.length - 1];
      if (!g) return null;
      return g.edges.filter((e) => e.source === 'n1').map((e) => e.sourceHandle).sort();
    }, { timeout: 10_000 }).toEqual(['card:0:btn:0', 'card:1:btn:0']);
  });
});
