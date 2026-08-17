import { test, expect } from '@playwright/test';

/**
 * Bloc RCS dans le builder : il s'ajoute depuis la palette, se configure (texte du message), rend ses DEUX
 * sorties « Envoyé » / « Non joignable en RCS », et l'auto-save persiste le graphe (texte + arêtes typées
 * sent/unreachable). Backend intercepté (aucune base), même pattern que le spec du node Condition.
 *
 * Ce qu'on vérifie vraiment ici : la sortie « non joignable » EXISTE et SURVIT à une sauvegarde. C'est elle
 * qui porte la cascade RCS -> WhatsApp ; si elle se perd à l'enregistrement, le repli disparaît en silence et
 * les contacts non joignables tombent dans le vide.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

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

test.describe('Builder : bloc RCS', () => {
  test('s’ajoute depuis la palette, rend ses 2 sorties, et l’auto-save persiste son texte', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] }, saved);

    await page.goto('/workflows?open=wf1');

    await page.getByTestId('add-node-rcs_message').click();

    // Les deux sorties typées sont rendues sur le bloc.
    await expect(page.getByText('Envoyé').first()).toBeVisible();
    await expect(page.getByText('Non joignable en RCS').first()).toBeVisible();

    // Le panneau de configuration expose le texte du message.
    const zone = page.getByPlaceholder('Votre message…');
    await expect(zone).toBeVisible();
    await zone.fill('Bonjour, offre du jour');

    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) => n.type === 'rcs_message' && (n.data as { text?: string }).text === 'Bonjour, offre du jour')),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('un graphe pré-câblé (RCS -> Envoyé / Non joignable) preserve ses 2 aretes a la sauvegarde', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(
      page,
      {
        nodes: [
          { id: 'r', type: 'rcs_message', position: { x: 0, y: 0 }, data: { text: 'Bonjour en RCS' } },
          { id: 'suite', type: 'action', position: { x: 300, y: -60 }, data: { actionKind: 'add_tag', tag: 'rcs-recu' } },
          { id: 'repli', type: 'template', position: { x: 300, y: 80 }, data: { templateName: 'relance' } },
        ],
        edges: [
          { id: 'e1', source: 'r', target: 'suite', sourceHandle: 'sent' },
          { id: 'e2', source: 'r', target: 'repli', sourceHandle: 'unreachable' },
        ],
      },
      saved,
    );

    await page.goto('/workflows?open=wf1');
    await expect(page.getByText('Non joignable en RCS').first()).toBeVisible();

    // Provoque une sauvegarde en touchant le graphe (ajout d'un bloc sans lien avec le câblage RCS).
    await page.getByTestId('add-node-wait').click();

    await expect.poll(
      () => saved.some((g) => {
        const sent = g.edges.some((e) => e.source === 'r' && e.sourceHandle === 'sent' && e.target === 'suite');
        const repli = g.edges.some((e) => e.source === 'r' && e.sourceHandle === 'unreachable' && e.target === 'repli');
        return sent && repli;
      }),
      { timeout: 10_000 },
    ).toBe(true);
  });
});
