import { test, expect, type Page } from '@playwright/test';

/**
 * LE BLOC « ALLER À » ET LE BOUTON « COPIER LE CODE » (RC5, livraison B), DE BOUT EN BOUT DANS L'ÉDITEUR.
 *
 * Ce qu'aucun test unitaire ne voit : que la palette propose le bloc, que le panneau choisisse une cible par le
 * sélecteur (ce scénario, puis un autre) ou par un code collé, que la carte la nomme sans dessiner de sortie, que le
 * bouton du coin copie le code d'un bloc, grisé tant que le serveur ne lui en a pas posé un, et qu'un refus de
 * publication du serveur arrive à l'écran avec sa raison.
 *
 * Backend intercepté, aucune base (pattern des autres E2E du builder). Le faux serveur garde le dernier graphe
 * enregistré et, comme le vrai (`mintNodeCodes`), pose un code aux blocs qui n'en ont pas.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Node = { id: string; type: string; data: Record<string, unknown> } & Record<string, unknown>;
type Graph = { nodes: Node[]; edges: Array<{ id?: string; source: string; target: string; sourceHandle?: string }> };

const code = (k: number): string => `nod_k7m2p3_01J${String(k).padStart(23, '0')}`;
const C_MENU = code(1);
const C_TAG = code(2);
const C_AILLEURS = code(9);

interface Etat { courant: Graph; saved: Graph[]; mint: number; publication: 'ok' | 'refus' }

const INITIAL: Graph = {
  nodes: [
    { id: 'q', type: 'question', position: { x: 0, y: 0 }, data: { name: 'Menu', body: 'Menu ?', rows: [{ title: 'Infos' }], code: C_MENU } },
    { id: 't', type: 'tag', position: { x: 0, y: 220 }, data: { tag: 'vu', code: C_TAG } },
  ],
  edges: [{ id: 'e0', source: 'q', target: 't', sourceHandle: 'row:0' }],
};

/** Les blocs PUBLIÉS de l'espace, tels que `GET /nodes` les rend : ceux de ce scénario et ceux d'un autre. */
const BLOCS_PUBLIES = [
  { code: C_MENU, type: 'question', name: 'Menu', workflowId: 'wf1', workflowName: 'Scénario E2E', summary: 'Menu ?' },
  { code: C_AILLEURS, type: 'question', name: 'Question 2', workflowId: 'wf2', workflowName: 'Menu principal', summary: 'Et ensuite ?' },
];

async function ouvrir(page: Page, etat: Etat): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  // Le presse-papiers est remplacé par un relevé : on lit ce que le bouton a copié, sans dépendre des permissions.
  await page.addInitScript(() => {
    const w = window as unknown as { __copies: string[] };
    w.__copies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { w.__copies.push(t); } } });
  });
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && /\/workflows\/wf1\/publish$/.test(url)) {
      if (etat.publication === 'refus') {
        return json({ error: 'Publication refusée : le bloc « Aller à » ne vise aucun bloc : choisissez sa cible, ou retirez-le.', code: 'aller_a_invalide' }, 422);
      }
      return json({ id: 'wf1', graph: etat.courant, publishedAt: '2026-10-07T10:00:00.000Z' });
    }
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
      const body = (req.postDataJSON() ?? {}) as { graph?: Graph };
      if (body.graph) {
        // Comme `mintNodeCodes` : un bloc sans code en reçoit un, un code valide est gardé.
        const graph: Graph = {
          ...body.graph,
          nodes: body.graph.nodes.map((n) => (typeof n.data.code === 'string' && n.data.code !== '' ? n : { ...n, data: { ...n.data, code: code(100 + (etat.mint += 1)) } })),
        };
        etat.saved.push(graph);
        etat.courant = graph;
        return json({ id: 'wf1', graph, brouillon: true });
      }
      return json({ id: 'wf1', brouillon: true });
    }
    const wf = { id: 'wf1', name: 'Scénario E2E', graph: etat.courant, draftGraph: null, publishedAt: null, createdAt: '', updatedAt: '' };
    const autre = { id: 'wf2', name: 'Menu principal', nodeCount: 1, hasDraft: false, publishedAt: null, createdAt: '', updatedAt: '' };
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [wf, autre] });
    if (/\/nodes(\?|$)/.test(url)) return json({ nodes: BLOCS_PUBLIES });
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
  await page.locator('.react-flow__node[data-id="q"]').waitFor();
  await page.waitForTimeout(500);
}

/** Le bloc « Aller à » du dernier graphe enregistré. */
function sautEnregistre(etat: Etat): Node | undefined {
  return etat.saved[etat.saved.length - 1]?.nodes.find((n) => n.type === 'aller_a');
}

test.describe('Bloc « Aller à »', () => {
  test('🔴 la cible se choisit dans ce scénario puis dans un autre ; la carte la nomme, sans aucune sortie', async ({ page }) => {
    const etat: Etat = { courant: INITIAL, saved: [], mint: 0, publication: 'ok' };
    await ouvrir(page, etat);

    await page.getByTestId('add-node-aller_a').click();
    await expect(page.getByTestId('panneau-aller-a')).toBeVisible();
    await expect(page.getByTestId('aller-a-sans-cible')).toBeVisible();

    // Ce scénario : ses blocs qui ont un code, par leur nom et leur type.
    await expect(page.getByTestId('aller-a-scenario')).toHaveValue('wf1');
    await page.getByTestId('aller-a-bloc').selectOption(C_MENU);
    await expect(page.getByTestId('aller-a-cible')).toHaveText('→ Menu');
    await expect.poll(() => sautEnregistre(etat)?.data.cible).toBe(C_MENU);
    expect(sautEnregistre(etat)?.data.cibleLibelle).toBe('Menu');

    const id = sautEnregistre(etat)!.id;
    const carte = page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(carte).toContainText('→ Menu');
    // Aucune poignée de sortie : la suite est là où le bloc mène.
    await expect(carte.locator('.react-flow__handle.source')).toHaveCount(0);

    // Un autre scénario : ses blocs PUBLIÉS.
    await page.getByTestId('aller-a-scenario').selectOption('wf2');
    await page.getByTestId('aller-a-bloc').selectOption(C_AILLEURS);
    await expect(carte).toContainText('→ Menu principal, Question 2');
    await expect.poll(() => sautEnregistre(etat)?.data.cible).toBe(C_AILLEURS);
    expect(sautEnregistre(etat)?.data.cibleLibelle).toBe('Menu principal, Question 2');
  });

  test('un code collé est nommé quand on le connaît, et un code inconnu est signalé', async ({ page }) => {
    const etat: Etat = { courant: INITIAL, saved: [], mint: 0, publication: 'ok' };
    await ouvrir(page, etat);
    await page.getByTestId('add-node-aller_a').click();
    await page.getByTestId('aller-a-code').fill(C_AILLEURS);
    await expect(page.getByTestId('aller-a-cible')).toHaveText('→ Menu principal, Question 2');
    // Le sélecteur se cale sur le scénario de la cible collée.
    await expect(page.getByTestId('aller-a-scenario')).toHaveValue('wf2');
    await page.getByTestId('aller-a-code').fill(code(777));
    await expect(page.getByTestId('aller-a-inconnu')).toBeVisible();
  });

  test('🔴 un refus de publication du serveur arrive à l’écran avec sa raison', async ({ page }) => {
    const etat: Etat = { courant: INITIAL, saved: [], mint: 0, publication: 'refus' };
    await ouvrir(page, etat);
    await page.getByTestId('add-node-aller_a').click();
    await page.getByTestId('workflow-publier').click();
    await expect(page.getByTestId('workflow-publier-erreur')).toContainText('ne vise aucun bloc');
  });
});

test.describe('Copier le code d’un bloc', () => {
  test('🔴 le bouton copie le code ; grisé tant que le bloc n’en a pas, actif dès que le serveur lui en a posé un', async ({ page }) => {
    const etat: Etat = { courant: INITIAL, saved: [], mint: 0, publication: 'ok' };
    await ouvrir(page, etat);

    const copierMenu = page.getByTestId('node-copier-q');
    await expect(copierMenu).toBeEnabled();
    await copierMenu.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copies: string[] }).__copies)).toEqual([C_MENU]);
    // Le clic ne sélectionne pas le bloc : le panneau de droite reste sur son invitation.
    await expect(page.getByText('Cliquez sur un bloc pour le configurer', { exact: false })).toBeVisible();

    // Un bloc neuf n'a pas encore de code : le bouton est grisé et dit pourquoi.
    await page.getByTestId('add-node-aller_a').click();
    const neuf = page.locator('[data-testid^="node-copier-"][disabled]');
    await expect(neuf).toHaveCount(1);
    await expect(neuf).toHaveAttribute('title', 'Enregistrez pour obtenir le code');
    const testid = await neuf.getAttribute('data-testid');

    // L'enregistrement automatique part ; le serveur pose le code ; la carte le reçoit.
    await expect(page.getByTestId(testid!)).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId(testid!).click();
    const copies = await page.evaluate(() => (window as unknown as { __copies: string[] }).__copies);
    expect(copies).toHaveLength(2);
    expect(copies[1]).toBe(sautEnregistre(etat)?.data.code);
  });
});
