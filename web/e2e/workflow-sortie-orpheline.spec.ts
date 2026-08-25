import { test, expect } from '@playwright/test';

/**
 * Un bouton proposé au contact mais branché sur RIEN est un trou de montage : il tape, et il ne reçoit rien.
 *
 * Vécu par Julien le 2026-08-25. Rien ne le signalait, ni dans l'éditeur, ni à l'exécution : le parcours se
 * terminait sur-le-champ, en silence. L'éditeur marque désormais la sortie non reliée sur SA ligne, là où la
 * flèche se tire, et l'exécuteur remonte la conversation à un humain quand le cas se produit quand même.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

/** « Oui » est relié, « Non » ne l'est pas : c'est exactement la forme du défaut. */
const UN_BOUTON_ORPHELIN: Graph = {
  nodes: [
    { id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { wfType: 'quick_message', body: 'Un souci ?', quickReplies: ['Oui', 'Non'] } },
    { id: 'n2', type: 'tag', position: { x: 320, y: 0 }, data: { wfType: 'tag', tag: 'ok' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'btn:0' }],
};

async function mockBuilder(page: import('@playwright/test').Page, graph: Graph) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph, createdAt: '', updatedAt: '' };
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) return json({ ok: true });
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph }] });
    if (url.includes('/email/accounts')) return json({ accounts: [] });
    if (url.includes('/email/templates')) return json({ templates: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Éditeur : une sortie qui ne mène nulle part', () => {
  test('🔴 le bouton NON relié est signalé, celui qui est relié ne l’est pas', async ({ page }) => {
    await mockBuilder(page, UN_BOUTON_ORPHELIN);
    await page.goto('/workflows?open=wf1');

    // « Non » (btn:1) ne mène nulle part : il porte la marque, avec l'explication en infobulle.
    const marque = page.getByTestId('sortie-orpheline-btn:1');
    await expect(marque).toBeVisible();
    await expect(marque).toHaveAttribute('title', /ne mène nulle part/);

    // « Oui » (btn:0) est relié : aucune marque, sinon l'avertissement crierait au loup sur tout le monde.
    await expect(page.getByTestId('sortie-orpheline-btn:0')).toHaveCount(0);
  });

  test('aucune fausse alerte : tous les boutons reliés, et la sortie « toute autre réponse » jamais signalée', async ({ page }) => {
    // La sortie libre non reliée est un CHOIX documenté (le parcours s arrête, l agent reprend la parole),
    // pas un oubli. La signaler ferait crier au loup sur la quasi-totalité des scénarios, et l avertissement
    // ne voudrait plus rien dire là où il compte.
    await mockBuilder(page, {
      nodes: UN_BOUTON_ORPHELIN.nodes,
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'btn:0' },
        { id: 'e2', source: 'n1', target: 'n2', sourceHandle: 'btn:1' },
      ],
    });
    await page.goto('/workflows?open=wf1');
    await expect(page.locator('.react-flow__node')).toHaveCount(2); // le graphe est bien chargé
    await expect(page.locator('[data-testid^="sortie-orpheline-"]')).toHaveCount(0);
  });
});
