import { test, expect } from '@playwright/test';

/**
 * LES POINTS DE LIAISON : viser, et voir la flèche partir du bon endroit.
 *
 * Trois symptômes signalés par Julien le 2026-08-28, et deux causes MESURÉES derrière eux.
 *
 * 🔴 CAUSE 1, la flèche partait de la mauvaise ligne. Une arête enregistrée sans `sourceHandle` (c'est ainsi
 * que le moteur reconnaît « Toute autre réponse ») n'a pas de poignée nommée : React Flow l'ancre alors sur la
 * PREMIÈRE poignée de sortie du bloc. Relier la sortie libre dessinait donc une seconde flèche sur la ligne de
 * la première réponse rapide, d'où « deux flèches partent d'une même réponse » et « la sortie libre ne se relie
 * pas » : elle se reliait, ailleurs. Mesuré dans le DOM : l'arête libre partait à l'ordonnée exacte de `btn:0`.
 *
 * 🔴 CAUSE 2, la cible était minuscule. Sur un canevas réaliste, `fitView` s'installe vers 0,57 : le point fait
 * 5,7 px et deux points voisins sont à 13,7 px. Tolérance de visée mesurée AVANT correction : ±2 px. Personne
 * ne vise ça à la souris ; le geste tombait sur le corps du bloc (qui se déplaçait) ou sous le bloc.
 *
 * Ces deux défauts ne se voient QUE de bout en bout : ils vivent dans la géométrie du DOM et dans la façon
 * dont React Flow résout une poignée, pas dans notre logique.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

/** Un canevas RÉALISTE : assez de blocs pour que `fitView` dézoome comme chez un client. */
const CANEVAS = (edges: Graph['edges'] = []): Graph => ({
  nodes: [
    { id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { wfType: 'quick_message', body: 'Bonjour, souhaitez-vous un rendez-vous ou la brochure ?', quickReplies: ['Rendez-vous', 'Brochure'] } },
    { id: 'n2', type: 'tag', position: { x: 500, y: -220 }, data: { wfType: 'tag', tag: 'rdv' } },
    { id: 'n3', type: 'tag', position: { x: 500, y: 60 }, data: { wfType: 'tag', tag: 'brochure' } },
    { id: 'n4', type: 'tag', position: { x: 500, y: 320 }, data: { wfType: 'tag', tag: 'ecrit' } },
    { id: 'n5', type: 'quick_message', position: { x: 980, y: 0 }, data: { wfType: 'quick_message', body: 'Merci !' } },
    { id: 'n6', type: 'tag', position: { x: 980, y: 320 }, data: { wfType: 'tag', tag: 'fin' } },
  ],
  edges,
});

/** Le même canevas avec un bloc Question à menu, pour la sortie libre à côté des lignes. */
const AVEC_MENU = (): Graph => {
  const g = CANEVAS();
  g.nodes[0] = { id: 'n1', type: 'question', position: { x: 0, y: 0 }, data: { wfType: 'question', body: 'Ça vous convient ?', buttonLabel: 'Répondre', rows: [{ title: 'Oui' }, { title: 'Non' }] } };
  return g;
};

async function mockBuilder(page: import('@playwright/test').Page, graph: Graph, saved: Graph[]) {
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
  await page.goto('/workflows?open=wf1');
  await page.locator('.react-flow__node').first().waitFor();
  await page.waitForTimeout(500);
}

/** Le centre de chaque point de sortie du bloc `n1`, dans l'ordre où ils sont dessinés. */
function pointsDeSortie(page: import('@playwright/test').Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.react-flow__node[data-id="n1"] .react-flow__handle-right')).map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute('data-handleid'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
}

function centreDuBloc(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((n) => {
    const el = document.querySelector(`.react-flow__node[data-id="${n}"]`) as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
}

/** Le geste réel : on tire depuis un point (avec un écart de visée) et on lâche SUR le bloc visé. */
async function tirer(page: import('@playwright/test').Page, de: { x: number; y: number }, vers: { x: number; y: number }, ecart = 0) {
  await page.mouse.move(de.x, de.y + ecart);
  await page.mouse.down();
  await page.mouse.move((de.x + vers.x) / 2, (de.y + vers.y) / 2, { steps: 8 });
  await page.mouse.move(vers.x, vers.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** L'ordonnée ÉCRAN d'où part chaque flèche, pour vérifier qu'elle quitte bien SA ligne. */
function departsDesFleches(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const vp = document.querySelector('.react-flow__viewport') as HTMLElement;
    const tr = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(vp.style.transform);
    const [ty, k] = tr ? [Number(tr[2]), Number(tr[3])] : [0, 1];
    return Array.from(document.querySelectorAll('.react-flow__edge')).map((el) => {
      const d = el.querySelector('path.react-flow__edge-path')?.getAttribute('d') ?? '';
      const m = /^M\s*([-\d.]+)[, ]([-\d.]+)/.exec(d);
      return { label: el.getAttribute('aria-label'), y: m ? Number(m[2]) * k + ty : null };
    });
  });
}

test.describe('Éditeur : viser un point de sortie, et voir la flèche partir de sa ligne', () => {
  test('🔴 la flèche de « Toute autre réponse » part de SA ligne, pas de la première réponse', async ({ page }) => {
    // LE défaut. Sans poignée nommée, React Flow ancrait cette arête sur `btn:0` : deux flèches semblaient
    // partir de la première réponse, et celle qu'on venait de relier n'était pas là où on l'avait tirée.
    const saved: Graph[] = [];
    await mockBuilder(page, CANEVAS([
      { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'btn:0' },
      { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'btn:1' },
      { id: 'e3', source: 'n1', target: 'n4' },
    ]), saved);
    const points = await pointsDeSortie(page);
    expect(points.map((p) => p.id)).toEqual(['btn:0', 'btn:1', 'libre']);
    const departs = await departsDesFleches(page);
    // Trois flèches, trois ordonnées DISTINCTES, dans l'ordre des trois lignes.
    const ys = departs.map((d) => Math.round(d.y!));
    expect(new Set(ys).size, JSON.stringify(departs)).toBe(3);
    expect(ys[0]).toBeLessThan(ys[1]!);
    expect(ys[1]).toBeLessThan(ys[2]!);
  });

  test('🔴 un geste à quelques pixels près attrape quand même le point', async ({ page }) => {
    // Tolérance mesurée AVANT correction : ±2 px sur un point de 5,7 px. La zone de prise fait maintenant la
    // hauteur d'une ligne, donc chaque point possède sa ligne, sans zone morte ni débordement sur la voisine.
    const saved: Graph[] = [];
    await mockBuilder(page, CANEVAS(), saved);
    const points = await pointsDeSortie(page);
    const libre = points[2]!;
    await tirer(page, libre, await centreDuBloc(page, 'n4'), 4);
    await expect.poll(
      () => saved.some((g) => g.edges.some((e) => e.source === 'n1' && !e.sourceHandle && e.target === 'n4')),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('🔴 une réponse rapide ne mène qu’à UN bloc : la seconde flèche remplace la première', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, CANEVAS(), saved);
    const p = await pointsDeSortie(page);
    await tirer(page, p[0]!, await centreDuBloc(page, 'n2'));
    await tirer(page, (await pointsDeSortie(page))[0]!, await centreDuBloc(page, 'n3'));
    await expect.poll(() => {
      const g = saved[saved.length - 1];
      return g ? g.edges.filter((e) => e.source === 'n1' && e.sourceHandle === 'btn:0').length : -1;
    }, { timeout: 10_000 }).toBe(1);
    expect(saved[saved.length - 1]!.edges.find((e) => e.sourceHandle === 'btn:0')!.target).toBe('n3');
  });

  test('🔴 sur un bloc Question, les lignes du menu ET la sortie libre se relient, dans les DEUX ordres', async ({ page }) => {
    // Julien : « si je mappe les réponses, la sortie libre ne se mappe plus ; si je commence par la libre, ce
    // sont les réponses qui ne se mappent plus ». Les deux gestes sont indépendants, et ce test le prouve.
    for (const ordre of [['menu', 'libre'], ['libre', 'menu']] as const) {
      const saved: Graph[] = [];
      await mockBuilder(page, AVEC_MENU(), saved);
      for (const [i, quoi] of ordre.entries()) {
        const p = await pointsDeSortie(page);
        const point = quoi === 'menu' ? p[0]! : p[2]!;
        await tirer(page, point, await centreDuBloc(page, i === 0 ? 'n2' : 'n3'));
      }
      const cibleMenu = ordre[0] === 'menu' ? 'n2' : 'n3';
      const cibleLibre = ordre[0] === 'libre' ? 'n2' : 'n3';
      await expect.poll(() => {
        const g = saved[saved.length - 1];
        if (!g) return false;
        return g.edges.some((e) => e.sourceHandle === 'row:0' && e.target === cibleMenu)
          && g.edges.some((e) => e.source === 'n1' && !e.sourceHandle && e.target === cibleLibre);
      }, { timeout: 10_000 }).toBe(true);
    }
  });

  test('🔴 une réponse AJOUTÉE À L’INSTANT se relie, sans quitter l’écran', async ({ page }) => {
    // Julien, 2026-08-28 : « certains boutons de réponses restent rouge et je ne peux pas les relier [...]
    // puis je vais dans l'inbox et je reviens et là je peux les relier ».
    //
    // La cause est dans React Flow, et elle est SILENCIEUSE. Les positions des poignées sont en cache
    // (`node.internals.handleBounds`), et `onPointerDown` commence par y chercher la poignée de départ :
    // absente du cache, il sort sans rien faire. Le point se voit, se survole, et le glisser ne commence
    // jamais. Une ligne de menu au libellé vide ne dessine AUCUNE poignée ; taper son libellé en ajoute une
    // sans changer la hauteur du bloc, donc sans que React Flow remesure quoi que ce soit.
    //
    // Ce test tire la flèche APRÈS avoir tapé le libellé, et sans recharger : c'est le seul geste qui
    // distingue une poignée vivante d'une poignée dessinée. Les autres tests de ce fichier partent d'un
    // graphe déjà rempli, donc mesuré au montage, et ne pouvaient pas le voir.
    const saved: Graph[] = [];
    await mockBuilder(page, AVEC_MENU(), saved);
    await page.locator('.react-flow__node[data-id="n1"]').click();
    await page.getByTestId('question-add-row').click();
    await page.getByTestId('question-row-title-2').fill('Peut-être');
    await expect(page.getByTestId('sortie-orpheline-row:2')).toBeVisible();

    const point = (await pointsDeSortie(page)).find((p) => p.id === 'row:2');
    expect(point, 'la 3e réponse doit avoir un point de sortie').toBeTruthy();
    await tirer(page, point!, await centreDuBloc(page, 'n2'));

    await expect.poll(
      () => saved.some((g) => g.edges.some((e) => e.sourceHandle === 'row:2' && e.target === 'n2')),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('🔴 un graphe qui porte DEUX arêtes sur la même sortie n’en dessine qu’une', async ({ page }) => {
    // Le moteur suit la PREMIÈRE : dessiner la seconde promettrait une branche que le parcours n'empruntera
    // jamais. Le canevas doit montrer ce qui va se passer, pas ce qui a été enregistré par erreur.
    const saved: Graph[] = [];
    await mockBuilder(page, CANEVAS([
      { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'btn:0' },
      { id: 'e2', source: 'n1', target: 'n3', sourceHandle: 'btn:0' },
    ]), saved);
    expect(await page.locator('.react-flow__edge').count()).toBe(1);
    expect(await page.locator('.react-flow__edge').first().getAttribute('aria-label')).toContain('n2');
  });
});
