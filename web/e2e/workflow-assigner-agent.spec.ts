import { test, expect } from '@playwright/test';

/**
 * E2E builder : la palette n'offre plus de bloc « retour au MBA », et le bloc qui passe le fil à un humain
 * s'appelle enfin ce qu'il fait.
 *
 * Ce fichier REMPLACE le test des deux blocs MBA grisés. Ils ont été retirés : le retour à l'agent de Meta est
 * implicite (une étape qui n'offre aucun choix relâche le fil), donc un bloc explicite n'ajoutait rien.
 * Le besoin d'« assigner à un agent » était en réalité DÉJÀ couvert par le bloc `inbox`, dont le nom, une
 * destination et non une action, cachait ce qu'il faisait. Il est renommé, pas dupliqué.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

async function ouvrirBuilder(page: import('@playwright/test').Page, initial: Graph, sauvegardes?: Array<Record<string, unknown>>, mbaEnabled = false) {
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: initial, createdAt: '', updatedAt: '' };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (sauvegardes && (req.method() === 'PUT' || req.method() === 'PATCH') && /\/workflows\/wf1/.test(url)) {
      sauvegardes.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ workflow: wf });
    }
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: initial }] });
    if (url.endsWith('/settings')) return json({ mbaEnabled, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/workflows?open=wf1');
}

test.describe('Builder : plus de bloc MBA, et « Assigner à un agent »', () => {
  test('🔴 les deux blocs MBA ont disparu de la palette', async ({ page }) => {
    await ouvrirBuilder(page, { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] });
    // La palette est bien rendue (sinon l'absence des blocs ne prouverait rien).
    await expect(page.getByTestId('add-node-action')).toBeEnabled();
    await expect(page.getByTestId('add-node-mba_handoff')).toHaveCount(0);
    await expect(page.getByTestId('add-node-mba_disable')).toHaveCount(0);
  });

  test('le bloc qui passe le fil à un humain s’appelle « Assigner à un agent »', async ({ page }) => {
    await ouvrirBuilder(page, { nodes: [], edges: [] });
    const bloc = page.getByTestId('add-node-inbox');
    await expect(bloc).toBeVisible();
    await expect(bloc).toContainText(/Assigner à un agent|Assign to an agent/);
  });

  test('🔴 un ancien scénario contenant un bloc MBA reste AFFICHABLE et ENREGISTRABLE', async ({ page }) => {
    // Deux garanties distinctes, et la seconde est celle qui coûterait un incident. L'affichage retombe sur des
    // métadonnées « bloc retiré ». Et l'enregistrement doit passer : `parseGraph` rejette le graphe ENTIER dès
    // qu'un type lui est inconnu, donc si ces types sortaient des types acceptés, l'utilisateur se prendrait un
    // « graphe invalide » sur un scénario qu'il n'a même pas modifié.
    const sauvegardes: Array<Record<string, unknown>> = [];
    await ouvrirBuilder(page, {
      nodes: [
        { id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } },
        { id: 'h', type: 'mba_handoff', position: { x: 240, y: 0 }, data: {} },
      ],
      edges: [{ id: 'e1', source: 't', target: 'h' }],
    }, sauvegardes);

    await expect(page.getByTestId('add-node-action')).toBeEnabled();
    await expect(page.getByText(/Bloc MBA \(retiré\)|MBA block \(removed\)/)).toBeVisible();

    // Une modification déclenche l'auto-save : le bloc legacy doit repartir avec le reste, sans refus.
    await page.getByTestId('add-node-action').click();
    await expect.poll(() => sauvegardes.length, { timeout: 8000 }).toBeGreaterThan(0);
    const graphe = sauvegardes[sauvegardes.length - 1]!.graph as { nodes: Array<{ type: string }> };
    expect(graphe.nodes.map((n) => n.type)).toContain('mba_handoff');
  });
});

/**
 * RC6 : le bloc « Envoyer au MBA » (type NEUF `vers_mba`, jamais `mba_handoff` réveillé). Il est dans la palette, même
 * agent de Meta éteint (on prépare un scénario avant de l'allumer) ; son panneau AVERTIT alors que la conversation ira à
 * l'équipe ; il n'a aucune sortie ; il s'enregistre sous son type.
 */
test.describe('Builder : le bloc « Envoyer au MBA » (RC6)', () => {
  test('🔴 agent de Meta éteint : le bloc se pose, son panneau avertit, sans aucune sortie, et s’enregistre en `vers_mba`', async ({ page }) => {
    const sauvegardes: Array<Record<string, unknown>> = [];
    await ouvrirBuilder(page, { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] }, sauvegardes);
    const bloc = page.getByTestId('add-node-vers_mba');
    await expect(bloc).toBeEnabled();
    await expect(bloc).toContainText(/Envoyer au MBA|Send to MBA/);
    await bloc.click();
    await expect(page.getByTestId('vers-mba-eteint')).toContainText(/ce bloc passe la conversation à l’équipe|this block hands the conversation to the team/);
    await expect.poll(() => sauvegardes.length, { timeout: 8000 }).toBeGreaterThan(0);
    const graphe = sauvegardes[sauvegardes.length - 1]!.graph as { nodes: Array<{ id: string; type: string }> };
    const pose = graphe.nodes.find((n) => n.type === 'vers_mba');
    expect(pose, 'le bloc part sous son type neuf').toBeDefined();
    expect(graphe.nodes.map((n) => n.type)).not.toContain('mba_handoff');
    // Aucune poignée de SORTIE : le moteur ne suivrait aucune flèche tirée d'ici.
    await expect(page.locator(`.react-flow__node[data-id="${pose!.id}"] .react-flow__handle.source`)).toHaveCount(0);
  });

  test('agent de Meta allumé : aucun avertissement', async ({ page }) => {
    await ouvrirBuilder(page, { nodes: [], edges: [] }, undefined, true);
    await page.getByTestId('add-node-vers_mba').click();
    // Ancre positive : le panneau du bloc est ouvert (sa phrase), et l'avertissement n'y est pas.
    await expect(page.getByText(/l’agent de Meta prend la conversation : il répond tout de suite|Meta’s agent takes the conversation: it answers/)).toBeVisible();
    await expect(page.getByTestId('vers-mba-eteint')).toHaveCount(0);
  });
});
