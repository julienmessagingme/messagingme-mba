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
    cards: Array.from({ length: 5 }, (_, i) => ({
      mediaUrl: `https://cdn.example/c${i}.jpg`,
      body: `Carte numero ${i + 1}`,
      buttons: [{ type: 'QUICK_REPLY', text: `Reponse ${i + 1}` }, { type: 'URL', text: 'Le site', url: 'https://a.fr' }],
    })),
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
        // Vide À DESSEIN : les sorties sont alors déduites du template vivant, ce qui évite d'avoir à
        // re-sélectionner son template dans chaque scénario déjà construit.
        templateCards: [],
      },
    },
    { id: 'n2', type: 'tag', position: { x: 300, y: -60 }, data: { wfType: 'tag', tag: 'venu' } },
    { id: 'n3', type: 'tag', position: { x: 300, y: 60 }, data: { wfType: 'tag', tag: 'curieux' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'card:0:btn:0' },
    { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'card:4:btn:0' },
  ],
};

test.describe('Builder : aperçu et sorties d’un bloc carousel', () => {
  test('le bloc montre l’aperçu du message : bulle d’intro, vignette et boutons des cartes', async ({ page }) => {
    await mockBuilder(page, CABLE, []);
    await page.goto('/workflows?open=wf1');

    const bloc = page.locator('.react-flow__node').first();
    await expect(bloc.getByText('Notre sélection')).toBeVisible();  // bulle d'introduction
    await expect(bloc.locator('img')).toHaveCount(5);               // une vignette par carte
    await expect(bloc.getByText('Carte numero 1')).toBeVisible();
  });

  test('les cartes DÉFILENT : le bloc reste compact au lieu de s’étaler', async ({ page }) => {
    await mockBuilder(page, CABLE, []);
    await page.goto('/workflows?open=wf1');
    const zone = page.locator('.react-flow__node .nowheel').first();
    await expect(zone).toBeVisible();

    // Le contenu dépasse la hauteur visible : c'est ce qui garde le bloc petit même avec 10 cartes.
    const { scroll, client } = await zone.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(scroll).toBeGreaterThan(client);

    // Hauteur RÉELLE du bloc (offsetHeight : la boundingBox est multipliée par le zoom du canevas).
    const h = await page.locator('.react-flow__node').first().evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(h).toBeLessThan(380);
  });

  test('les points de liaison sont HORS de la zone qui défile (sinon les flèches partent dans le vide)', async ({ page }) => {
    // Invariant mesuré : une poignée sortie du cadre défilant est mesurée à sa position de mise en page, soit
    // des centaines de pixels sous le bloc, et React Flow y fait démarrer la flèche. Les sorties vivent donc
    // sous l'aperçu, toujours visibles. Ce test casse si on les remet à l'intérieur.
    await mockBuilder(page, CABLE, []);
    await page.goto('/workflows?open=wf1');
    await expect(page.locator('[data-handleid^="card:"]')).toHaveCount(5); // 1 par réponse rapide
    await expect(page.locator('.nowheel [data-handleid^="card:"]')).toHaveCount(0);
    await expect(page.locator('[data-handleid="card:0:btn:1"]')).toHaveCount(0); // un lien ne se relie pas
  });

  test('chaque sortie nomme sa carte, et une flèche part bien de la poignée', async ({ page }) => {
    await mockBuilder(page, CABLE, []);
    await page.goto('/workflows?open=wf1');
    for (let i = 1; i <= 5; i += 1) await expect(page.getByText(`C${i}`, { exact: true })).toHaveCount(1);

    // La flèche de la carte 5 démarre à la hauteur de SA poignée (à quelques pixels près), pas ailleurs.
    const dep = await page.evaluate(() => {
      const p = document.querySelector('.react-flow__edge[data-id="e2"] path.react-flow__edge-path') as SVGPathElement;
      const m = /^M([\d.]+),([\d.]+)/.exec(p.getAttribute('d') ?? '');
      const pt = p.ownerSVGElement!.createSVGPoint(); pt.x = Number(m![1]); pt.y = Number(m![2]);
      const ecran = pt.matrixTransform((p.parentNode as SVGGElement).getScreenCTM()!);
      const h = document.querySelector('[data-handleid="card:4:btn:0"]')!.getBoundingClientRect();
      return Math.abs(ecran.y - (h.top + h.height / 2));
    });
    expect(dep).toBeLessThan(12);
  });

  test('les fils reliés à des boutons de cartes DIFFÉRENTES survivent à une sauvegarde', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, CABLE, saved);
    await page.goto('/workflows?open=wf1');
    await expect(page.getByText('Reponse 1').first()).toBeVisible();

    await page.getByTestId('workflow-autoarrange').click();

    await expect.poll(() => {
      const g = saved[saved.length - 1];
      if (!g) return null;
      return g.edges.filter((e) => e.source === 'n1').map((e) => e.sourceHandle).sort();
    }, { timeout: 10_000 }).toEqual(['card:0:btn:0', 'card:4:btn:0']);
  });
});
