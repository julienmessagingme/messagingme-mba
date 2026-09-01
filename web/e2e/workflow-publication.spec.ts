import { test, expect } from '@playwright/test';

/**
 * E2E : le bouton « Publier » (lot 7).
 *
 * Ce qui est vérifié ici et nulle part ailleurs : l'ORDRE des appels. Enregistrer et publier sont deux
 * requêtes distinctes, séparées par 1,2 s de debounce, et l'utilisateur clique naturellement dans cet
 * intervalle. Si la publication passait devant l'enregistrement, elle mettrait en ligne l'avant-dernière
 * version, l'écran afficherait « en ligne », et personne ne verrait la différence avant qu'un contact la
 * reçoive.
 *
 * Backend intercepté, aucune base (pattern des autres E2E du builder).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

interface Ouverture {
  /** Les appels dans l'ORDRE où le serveur les a reçus : « PATCH » (enregistrement) ou « PUBLISH ». */
  appels: string[];
  /** Les graphes envoyés par l'auto-save. */
  saved: Graph[];
}

/**
 * Ouvre le builder sur un scénario. `brouillon` = un brouillon attend déjà (le bouton doit être là dès
 * l'ouverture) ; sinon le scénario est en ligne et le bouton n'apparaît qu'après une modification.
 */
async function ouvrirBuilder(page: import('@playwright/test').Page, brouillon: boolean): Promise<Ouverture> {
  const appels: string[] = [];
  const saved: Graph[] = [];
  const enLigne: Graph = { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] };
  const brouillonGraph: Graph = { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo-v2' } }], edges: [] };
  const wf = {
    id: 'wf1', name: 'Scénario E2E', graph: enLigne,
    draftGraph: brouillon ? brouillonGraph : null,
    publishedAt: '2026-08-01T09:00:00.000Z', createdAt: '', updatedAt: '',
  };

  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/workflows\/wf1\/publish$/.test(url)) {
      appels.push('PUBLISH');
      return json({ id: 'wf1', graph: enLigne, publishedAt: '2026-09-01T10:00:00.000Z' });
    }
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
      appels.push('PATCH');
      const body = (req.postDataJSON() ?? {}) as { graph?: Graph };
      if (body.graph) saved.push(body.graph);
      // Le faux serveur répond comme le vrai : « reste-t-il un brouillon ? » se décide en COMPARANT au graphe
      // en ligne. Répondre `true` à tout coup masquerait le cas mesuré le 2026-09-01 : ouvrir un scénario
      // déclenche UN enregistrement (React Flow mesure les blocs au montage), et si celui-là posait un
      // brouillon, tout scénario simplement consulté réclamerait d'être publié.
      const memeQueLigne = body.graph !== undefined && JSON.stringify(body.graph.nodes.map((nd) => nd.type)) === JSON.stringify(enLigne.nodes.map((nd) => nd.type));
      // Marque l'enregistrement qui porte le bloc « Attente » ajouté par le test de la course : sans ça,
      // l'enregistrement d'ouverture (il y en a toujours un) suffirait à faire passer l'ordre attendu.
      if (body.graph?.nodes.some((nd) => nd.type === 'wait')) appels[appels.length - 1] = 'PATCH-attente';
      return json({ id: 'wf1', brouillon: !memeQueLigne });
    }
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [wf] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });

  await page.goto('/workflows?open=wf1');
  return { appels, saved };
}

test.describe('Scénario : publier une version', () => {
  test('🔴 OUVRIR un scénario ne réclame pas de le publier, alors que ça l’enregistre bien une fois', async ({ page }) => {
    const { appels } = await ouvrirBuilder(page, false);
    await expect(page.getByTestId('workflow-publie')).toBeVisible();
    // Mesuré le 2026-09-01 : la seule ouverture provoque UN enregistrement. Il ne doit rien mettre en attente.
    await expect.poll(() => appels.length, { timeout: 6_000 }).toBe(1);
    await expect(page.getByTestId('workflow-publier')).toHaveCount(0);
    await expect(page.getByTestId('workflow-publie')).toBeVisible();
  });

  test('un brouillon en attente affiche « Publier » dès l’ouverture, et le clic met en ligne', async ({ page }) => {
    const { appels } = await ouvrirBuilder(page, true);
    const publier = page.getByTestId('workflow-publier');
    await expect(publier).toBeVisible();
    await publier.click();
    await expect.poll(() => appels.filter((a) => a === 'PUBLISH').length, { timeout: 10_000 }).toBe(1);
    // Le bouton laisse place à l'état « en ligne » : rien ne reste à publier.
    await expect(page.getByTestId('workflow-publie')).toBeVisible();
    await expect(publier).toHaveCount(0);
  });

  test('🔴 publier JUSTE APRÈS une modification enregistre d’abord, publie ensuite', async ({ page }) => {
    // Ouvert AVEC un brouillon en attente : le bouton est là dès le départ, donc le clic peut vraiment tomber
    // dans la fenêtre de 1,2 s du debounce. Sans ce départ, Playwright attendrait l'apparition du bouton,
    // c'est-à-dire la réponse de l'enregistrement, et la course ne se produirait jamais.
    const { appels, saved } = await ouvrirBuilder(page, true);
    await expect(page.getByTestId('workflow-publier')).toBeVisible();

    // Une modification, puis un clic AVANT la fin du debounce : c'est le geste courant.
    await page.getByTestId('add-node-wait').click();
    await page.getByTestId('workflow-publier').click();

    await expect.poll(() => appels.includes('PUBLISH'), { timeout: 10_000 }).toBe(true);
    // La modification est partie AVANT la publication. Sinon on aurait mis en ligne la version d'AVANT le
    // bloc ajouté, en affichant « en ligne » : l'erreur serait invisible jusqu'à ce qu'un contact la reçoive.
    expect(appels.indexOf('PATCH-attente')).toBeGreaterThanOrEqual(0);
    expect(appels.indexOf('PATCH-attente')).toBeLessThan(appels.indexOf('PUBLISH'));
    expect(saved.some((g) => g.nodes.some((nd) => nd.type === 'wait'))).toBe(true);
  });
});
