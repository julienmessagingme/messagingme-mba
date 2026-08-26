import { test, expect } from '@playwright/test';

/**
 * Bloc QUESTION dans l'éditeur : une question au contact, avec un MENU déroulant de réponses, chacune reliable
 * à un bloc différent.
 *
 * Ce que seul un test de bout en bout peut voir, et ce qui casserait sans lui :
 *  - le bloc est dans la palette ET dans le menu qui s'ouvre quand on tire une flèche (deux lecteurs
 *    distincts de la même liste, la dérive du commit c1b8441) ;
 *  - chaque ligne du menu produit SA sortie `row:<i>`, et l'index suit la ligne affichée ;
 *  - la sortie « Pas de réponse » n'apparaît QUE si un délai est posé : sans délai elle ne partirait jamais,
 *    l'afficher promettrait une branche morte ;
 *  - la sortie libre est là même quand le menu existe, parce qu'un contact peut toujours écrire.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

/** Question à deux lignes, sans délai : le cas de départ le plus courant. */
const QUESTION: Graph = {
  nodes: [
    { id: 'n1', type: 'question', position: { x: 0, y: 0 }, data: { wfType: 'question', body: 'Ça vous convient ?', buttonLabel: 'Répondre', rows: [{ title: 'Oui' }, { title: 'Non' }] } },
    { id: 'n2', type: 'tag', position: { x: 360, y: 0 }, data: { wfType: 'tag', tag: 'ok' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'row:0' }],
};

async function mockBuilder(page: import('@playwright/test').Page, graph: Graph, saved: Graph[] = []) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph, createdAt: '', updatedAt: '' };
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
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph }] });
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

test.describe('Éditeur : le bloc Question', () => {
  test('🔴 est proposé DANS la palette ET dans le menu du fil', async ({ page }) => {
    // Deux lecteurs distincts de la même liste. En août, deux blocs sont restés inatteignables au fil pendant
    // un mois parce que seule la palette avait été mise à jour.
    await mockBuilder(page, QUESTION);
    await page.goto('/workflows?open=wf1');
    await expect(page.getByTestId('add-node-question')).toBeVisible();

    // Tirer une flèche dans le vide ouvre le menu de nature : il doit y proposer la question.
    const depart = await page.locator('.react-flow__handle-right').first().boundingBox();
    await page.mouse.move(depart!.x + depart!.width / 2, depart!.y + depart!.height / 2);
    await page.mouse.down();
    await page.mouse.move(depart!.x + 160, depart!.y + 240, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByTestId('node-type-chooser')).toBeVisible();
    await expect(page.getByTestId('node-type-question')).toBeVisible();
  });

  test('🔴 une sortie par ligne du menu, plus la sortie libre', async ({ page }) => {
    await mockBuilder(page, QUESTION);
    await page.goto('/workflows?open=wf1');
    const bloc = page.locator('.react-flow__node').first();
    await expect(bloc).toContainText('Oui');
    await expect(bloc).toContainText('Non');
    // Un menu n'empêche pas d'écrire : ce cas doit rester prévisible.
    await expect(bloc).toContainText('Toute autre réponse');
    // « Oui » est relié (row:0), « Non » ne l'est pas : seul le second porte la marque du trou de montage.
    await expect(page.getByTestId('sortie-orpheline-row:1')).toBeVisible();
    await expect(page.getByTestId('sortie-orpheline-row:0')).toHaveCount(0);
  });

  test('🔴 « Pas de réponse » n’apparaît QUE si un délai est posé', async ({ page }) => {
    await mockBuilder(page, QUESTION);
    await page.goto('/workflows?open=wf1');
    // Sans délai : la sortie n'existe pas, elle ne partirait jamais.
    await expect(page.locator('.react-flow__node').first()).not.toContainText('Pas de réponse');

    await page.locator('.react-flow__node').first().click();
    await page.getByTestId('question-node-timeout').fill('30');
    await page.getByTestId('question-node-timeout-unit').selectOption('minutes');
    await expect(page.locator('.react-flow__node').first()).toContainText('Pas de réponse');
  });

  test('le panneau écrit bien la question, les réponses et le délai dans le graphe', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, QUESTION, saved);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    await page.getByTestId('question-add-row').click();
    await page.getByTestId('question-row-title-2').fill('Peut-être');
    await page.getByTestId('question-node-button').fill('Voir');

    await expect.poll(
      () => saved.some((g) => {
        const n = g.nodes.find((x) => x.id === 'n1') as { data?: { rows?: Array<{ title?: string }>; buttonLabel?: string } } | undefined;
        return n?.data?.buttonLabel === 'Voir' && n?.data?.rows?.[2]?.title === 'Peut-être';
      }),
      { timeout: 10_000 },
    ).toBe(true);
    // La 3e ligne a bien produit SA sortie, à son index.
    await expect(page.getByTestId('sortie-orpheline-row:2')).toBeVisible();
  });

  test('une question SANS menu garde la sortie libre : elle attend une réponse écrite', async ({ page }) => {
    const sansMenu: Graph = {
      nodes: [{ id: 'n1', type: 'question', position: { x: 0, y: 0 }, data: { wfType: 'question', body: 'Ton code postal ?', rows: [] } }],
      edges: [],
    };
    await mockBuilder(page, sansMenu);
    await page.goto('/workflows?open=wf1');
    const bloc = page.locator('.react-flow__node').first();
    await expect(bloc).toContainText('Toute autre réponse');
    await expect(bloc).toContainText('Ton code postal ?');
  });
});

test.describe('Éditeur : supprimer une réponse du menu', () => {
  /** Trois lignes, chacune reliée à un bloc différent : la forme exacte où le décalage se voit. */
  const TROIS: Graph = {
    nodes: [
      { id: 'n1', type: 'question', position: { x: 0, y: 0 }, data: { wfType: 'question', body: 'Q', rows: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] } },
      { id: 'na', type: 'tag', position: { x: 360, y: -80 }, data: { wfType: 'tag', tag: 'a' } },
      { id: 'nb', type: 'tag', position: { x: 360, y: 0 }, data: { wfType: 'tag', tag: 'b' } },
      { id: 'nc', type: 'tag', position: { x: 360, y: 80 }, data: { wfType: 'tag', tag: 'c' } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'na', sourceHandle: 'row:0' },
      { id: 'e2', source: 'n1', target: 'nb', sourceHandle: 'row:1' },
      { id: 'e3', source: 'n1', target: 'nc', sourceHandle: 'row:2' },
    ],
  };

  test('🔴 retirer la 2e réponse emporte SA branche et fait suivre les suivantes', async ({ page }) => {
    // L'index d'une ligne EST sa sortie. Renuméroter les données sans toucher aux arêtes envoyait le contact
    // qui choisit « C » dans la branche de « B », la réponse SUPPRIMÉE, et rendait la branche de « C »
    // inatteignable. Rien ne l'aurait signalé : la pastille d'orpheline ne regarde que les sorties NON reliées.
    const saved: Graph[] = [];
    await mockBuilder(page, TROIS, saved);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();
    await page.getByTestId('question-row-del-1').click();

    await expect.poll(
      () => {
        const g = saved.at(-1);
        if (!g) return null;
        const n = g.nodes.find((x) => x.id === 'n1') as { data?: { rows?: Array<{ title?: string }> } } | undefined;
        const aretes = g.edges
          .filter((e) => (e as { source?: string }).source === 'n1')
          .map((e) => `${(e as { sourceHandle?: string }).sourceHandle}->${(e as { target?: string }).target}`)
          .sort();
        return { titres: n?.data?.rows?.map((r) => r.title), aretes };
      },
      { timeout: 10_000 },
    ).toEqual({ titres: ['A', 'C'], aretes: ['row:0->na', 'row:1->nc'] });
  });
});
