import { test, expect } from '@playwright/test';

/**
 * E2E builder : (1) le panneau de droite ne permet PLUS de changer la nature d'un bloc, (2) tirer une flèche
 * dans le vide DEMANDE cette nature, (3) le bloc « Attente » se configure et s'affiche.
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

const UN_BLOC: Graph = {
  nodes: [{ id: 'n1', type: 'tag', position: { x: 0, y: 0 }, data: { wfType: 'tag', tag: 'vip' } }],
  edges: [],
};

test.describe('Builder : nature d’un bloc et bloc Attente', () => {
  test('le panneau de configuration n’expose PLUS de sélecteur de type', async ({ page }) => {
    await mockBuilder(page, UN_BLOC, []);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    // Le panneau est ouvert (il montre le nom du bloc) mais ne propose plus de changer la nature.
    await expect(page.getByText('Nom du bloc')).toBeVisible();
    await expect(page.getByText('Type de bloc')).toHaveCount(0);
    // Le type reste AFFICHÉ, en lecture seule : on doit savoir sur quoi on travaille.
    await expect(page.locator('aside, [class*="rounded-2xl"]').getByText('Ajout de tag').first()).toBeVisible();
  });

  test('la palette permet toujours de créer un bloc Attente, qui se configure', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, UN_BLOC, saved);
    await page.goto('/workflows?open=wf1');

    await page.getByRole('button', { name: /Attente/i }).click();

    // Panneau de config : durée + unité, et l'avertissement sur la fenêtre de 24 h.
    await expect(page.getByText('Attendre avant le bloc suivant')).toBeVisible();
    await page.getByRole('spinbutton').fill('3');
    await page.getByRole('combobox').last().selectOption('days');
    await expect(page.getByText(/seul un envoi de TEMPLATE peut encore partir/i)).toBeVisible();

    // Le bloc résume sa durée, et l'enregistrement persiste délai + unité.
    await expect(page.locator('.react-flow__node').getByText(/attendre 3 j/i)).toBeVisible();
    await page.getByTestId('workflow-autoarrange').click(); // déclenche l'enregistrement, comme les autres specs
    await expect.poll(() => {
      const g = saved[saved.length - 1];
      // À l'enregistrement, `fromRF` sort le type de `data` : le bloc porte `type`, pas `data.wfType`.
      return g?.nodes.find((n) => n.type === 'wait')?.data ?? null;
    }, { timeout: 10_000 }).toMatchObject({ delay: 3, unit: 'days' });
  });

  test('un bloc Attente sans durée affiche « durée à choisir » plutôt qu’un délai inventé', async ({ page }) => {
    const graph: Graph = { nodes: [{ id: 'w', type: 'wait', position: { x: 0, y: 0 }, data: { wfType: 'wait' } }], edges: [] };
    await mockBuilder(page, graph, []);
    await page.goto('/workflows?open=wf1');
    await expect(page.locator('.react-flow__node').getByText(/durée à choisir/i)).toBeVisible();
  });

  test('le + sur une flèche DEMANDE aussi la nature du bloc inséré', async ({ page }) => {
    // Ce chemin devinait « action » en silence : même correction que le lâcher dans le vide.
    const graph: Graph = {
      nodes: [
        { id: 'a', type: 'tag', position: { x: 0, y: 0 }, data: { wfType: 'tag', tag: 'vip' } },
        { id: 'b', type: 'inbox', position: { x: 0, y: 200 }, data: { wfType: 'inbox' } },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    };
    await mockBuilder(page, graph, []);
    await page.goto('/workflows?open=wf1');

    await page.getByTitle(/Insérer un bloc/i).click();
    const chooser = page.getByTestId('node-type-chooser');
    await expect(chooser).toBeVisible();

    await page.getByTestId('node-type-wait').click();
    await expect(chooser).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__node').getByText(/attendre 1 h/i)).toBeVisible();
  });

  test('tirer une flèche dans le vide DEMANDE la nature du bloc', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, UN_BLOC, saved);
    await page.goto('/workflows?open=wf1');

    // Tire depuis la sortie du bloc existant vers une zone vide du canevas.
    const source = page.locator('.react-flow__handle-bottom').first();
    const box = await source.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + 260, box!.y + 160, { steps: 12 });
    await page.mouse.up();

    // La liste des natures s'affiche : c'est le SEUL endroit où l'on choisit un type.
    const chooser = page.getByTestId('node-type-chooser');
    await expect(chooser).toBeVisible();
    await expect(chooser.getByText('Envoi template')).toBeVisible();
    await expect(chooser.getByText('Attente')).toBeVisible();

    await page.getByTestId('node-type-wait').click();
    await expect(chooser).toHaveCount(0);
    // Le bloc créé est bien une Attente, reliée au bloc source, avec la durée par défaut.
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__node').getByText(/attendre 1 h/i)).toBeVisible();
  });
});
