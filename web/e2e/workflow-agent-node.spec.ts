import { test, expect } from '@playwright/test';

/**
 * Bloc « Agent IA » dans le builder : il est grisé tant qu'aucun agent n'est actif, il s'ajoute, on choisit
 * l'agent qui tiendra la conversation, et le bloc rend ses sorties. Backend intercepté (aucune base), même
 * pattern que le spec du bloc RCS.
 *
 * Ce qu'on vérifie vraiment ici : les SORTIES existent et SURVIVENT à une sauvegarde. Ce sont les seules
 * façons de ressortir d'un bloc agent (il n'a pas de sortie libre : tant que l'agent tient la conversation,
 * les réponses du contact lui reviennent à lui). Si une arête typée se perd à l'enregistrement, le parcours
 * s'arrête là où le client croyait avoir prévu la suite.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

const AGENT = {
  id: 'ag1',
  label: 'Conseiller séjours',
  sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }, { code: 'hors_sujet', label: 'Hors sujet' }],
};

async function mockBuilder(page: import('@playwright/test').Page, initial: Graph, saved: Graph[], agents: unknown[] = [AGENT]) {
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
    if (url.includes('/agents')) return json({ agents });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    if (url.includes('/rcs-messages')) return json({ messages: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

const VIDE: Graph = { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] };

test.describe('Builder : bloc Agent IA', () => {
  test('🔴 sans agent actif, la brique est VISIBLE mais grisée', async ({ page }) => {
    // Même doctrine que RCS et email : le bloc se prépare, mais ne peut tenir aucune conversation sans agent
    // derrière. Le proposer promettrait une réponse qui ne viendrait jamais.
    await mockBuilder(page, VIDE, [], []);
    await page.goto('/workflows?open=wf1');

    const brique = page.getByTestId('add-node-agent');
    await expect(brique).toBeVisible();
    await expect(brique).toBeDisabled();
    await expect(page.getByTestId('add-node-template')).toBeEnabled();
  });

  test('avec un agent actif, la brique s ajoute et le bloc rend ses sorties réservées', async ({ page }) => {
    await mockBuilder(page, VIDE, []);
    await page.goto('/workflows?open=wf1');

    await expect(page.getByTestId('add-node-agent')).toBeEnabled();
    await page.getByTestId('add-node-agent').click();

    // Les sorties que la plateforme pose TOUJOURS, sans lesquelles un parcours n'a aucun repli.
    await expect(page.getByText('Pas de réponse').first()).toBeVisible();
    await expect(page.getByText('Aucune source').first()).toBeVisible();
    await expect(page.getByText('Plafond atteint').first()).toBeVisible();
    await expect(page.getByText('Échec technique').first()).toBeVisible();
  });

  test('choisir l agent COPIE ses règles d arrêt dans le bloc, et l auto-save les persiste', async ({ page }) => {
    // La copie est ce qui rend le graphe auto-suffisant : le moteur route sur les handles du graphe, sans
    // aller relire la fiche de l'agent.
    const saved: Graph[] = [];
    await mockBuilder(page, VIDE, saved);
    await page.goto('/workflows?open=wf1');
    await page.getByTestId('add-node-agent').click();

    await page.getByTestId('agent-node-select').selectOption('ag1');

    await expect(page.getByText('Besoin cerné').first()).toBeVisible();
    await expect(page.getByText('Hors sujet').first()).toBeVisible();

    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) => {
        const d = n.data as { agentId?: string; sorties?: Array<{ code?: string }> };
        return d.agentId === 'ag1' && (d.sorties ?? []).some((s) => s.code === 'besoin_cerne');
      })),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('🔴 un graphe pré-câblé garde ses arêtes typées à la sauvegarde', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      {
        nodes: [
          { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { wfType: 'agent', agentId: 'ag1', agentLabel: 'Conseiller séjours', sorties: AGENT.sorties } },
          { id: 'rdv', type: 'template', position: { x: 300, y: -60 }, data: { templateName: 'prise-rdv' } },
          { id: 'humain', type: 'inbox', position: { x: 300, y: 80 }, data: {} },
        ],
        edges: [
          { id: 'e1', source: 'a', target: 'rdv', sourceHandle: 'sortie:besoin_cerne' },
          { id: 'e2', source: 'a', target: 'humain', sourceHandle: 'sortie:sans_source' },
        ],
      },
      saved,
    );

    await page.goto('/workflows?open=wf1');
    await expect(page.getByText('Besoin cerné').first()).toBeVisible();

    // Provoque une sauvegarde en touchant le graphe, sans rien changer au câblage de l'agent.
    await page.getByTestId('add-node-wait').click();

    await expect.poll(
      () => saved.some((g) => {
        const cerne = g.edges.some((e) => e.source === 'a' && e.sourceHandle === 'sortie:besoin_cerne' && e.target === 'rdv');
        const sansSource = g.edges.some((e) => e.source === 'a' && e.sourceHandle === 'sortie:sans_source' && e.target === 'humain');
        return cerne && sansSource;
      }),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('une règle d arrêt NON reliée porte l alerte « ne mène nulle part »', async ({ page }) => {
    await mockBuilder(
      page,
      {
        nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { wfType: 'agent', agentId: 'ag1', agentLabel: 'Conseiller séjours', sorties: AGENT.sorties } }],
        edges: [],
      },
      [],
    );
    await page.goto('/workflows?open=wf1');
    await expect(page.getByTestId('sortie-orpheline-sortie:besoin_cerne')).toBeVisible();
  });

  test('🔴 effacer l agent EMPORTE les arêtes de ses règles d arrêt', async ({ page }) => {
    // Sans ça, elles restent enregistrées sans poignée pour les voir. Et un bloc agent SANS agent est un
    // passe-plat : il partait dans la première arête venue, donc dans une branche que personne n a choisie.
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      {
        nodes: [
          { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { wfType: 'agent', agentId: 'ag1', agentLabel: 'Conseiller séjours', sorties: AGENT.sorties } },
          { id: 'rdv', type: 'template', position: { x: 300, y: 0 }, data: { templateName: 'prise-rdv' } },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'rdv', sourceHandle: 'sortie:besoin_cerne' }],
      },
      saved,
    );
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    await page.getByTestId('agent-node-select').selectOption('');

    await expect.poll(
      () => saved.some((g) => g.edges.every((e) => e.sourceHandle !== 'sortie:besoin_cerne')),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('un agent DÉSACTIVÉ depuis est signalé sur le bloc qui l utilise encore', async ({ page }) => {
    // Sans ce signal, le sélecteur retomberait sur « choisir un agent » et le client croirait à un bug
    // d'affichage, alors que son parcours ne répond plus.
    await mockBuilder(
      page,
      {
        nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { wfType: 'agent', agentId: 'ag-parti', agentLabel: 'Ancien conseiller', sorties: [] } }],
        edges: [],
      },
      [],
      [AGENT],
    );
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('agent-node-absent')).toBeVisible();
  });
});
