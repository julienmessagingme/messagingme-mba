import { test, expect } from '@playwright/test';

/**
 * Le menu qui s'ouvre en tirant un fil doit proposer les MÊMES blocs que la palette, RCS et email compris.
 *
 * Le défaut corrigé ici : la palette lisait les trois listes de `nodeMeta.ts`, ce menu n'en lisait qu'une. Les
 * blocs « Message RCS » et « Envoi de mail » y étaient donc structurellement absents, alors qu'ils existaient
 * dans la palette. Signalé par Julien le 2026-08-25 en tirant un fil depuis un bouton de réponse rapide.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

const ACCOUNT = { id: 'a1', label: 'Support', host: 'h', port: 465, secure: true, username: 'u', fromAddress: 'a@b.fr', fromName: null, replyTo: null, verifiedAt: null, createdAt: '', hasPassword: true };

/** Un bloc à réponses rapides : c'est depuis SA poignée de bouton que Julien tirait son fil. */
const AVEC_BOUTONS: Graph = {
  nodes: [{
    id: 'n1', type: 'quick_message', position: { x: 0, y: 0 },
    data: { wfType: 'quick_message', body: 'Un souci ?', quickReplies: ['Oui', 'Non'] },
  }],
  edges: [],
};

async function mockBuilder(
  page: import('@playwright/test').Page,
  saved: Graph[],
  opts: { rcs: boolean; email: boolean },
) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: AVEC_BOUTONS, createdAt: '', updatedAt: '' };
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
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: AVEC_BOUTONS }] });
    // ⚠️ `/email/accounts` contient `/accounts` mais aussi le mot `templates` plus bas : ordre important,
    // même piège que dans workflow-email-node.spec.ts.
    if (url.includes('/email/accounts')) return json({ accounts: opts.email ? [ACCOUNT] : [] });
    if (url.includes('/email/templates')) return json({ templates: [] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: opts.rcs, hubspotListsEnabled: false, campaignsPaused: false });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

/** Tire un fil depuis la poignée du PREMIER bouton de réponse rapide vers une zone vide. */
async function tirerDepuisUnBouton(page: import('@playwright/test').Page) {
  const poignee = page.locator('.react-flow__handle-right').first();
  const box = await poignee.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 280, box!.y + 140, { steps: 12 });
  await page.mouse.up();
}

test.describe('Menu du fil : les mêmes blocs que la palette', () => {
  test('propose « Envoi de mail » et « Message RCS » quand les deux canaux sont prêts', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, saved, { rcs: true, email: true });
    await page.goto('/workflows?open=wf1');

    await tirerDepuisUnBouton(page);

    const chooser = page.getByTestId('node-type-chooser');
    await expect(chooser).toBeVisible();
    // Les 7 blocs de toujours restent là (non-régression) …
    await expect(chooser.getByTestId('node-type-template')).toBeVisible();
    // … et les deux canaux qui manquaient sont désormais proposés ET cliquables.
    await expect(chooser.getByTestId('node-type-email')).toBeEnabled();
    await expect(chooser.getByTestId('node-type-rcs_message')).toBeEnabled();

    // Le bloc choisi est bien créé, et relié au bloc amont.
    await page.getByTestId('node-type-email').click();
    await expect(chooser).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('les deux entrées sont GRISÉES tant que le canal n’est pas prêt, jamais masquées', async ({ page }) => {
    // Proposer un envoi sans agent RCS ni boîte SMTP promettrait un envoi qui finirait en erreur. La palette
    // grise ces blocs plutôt que de les cacher (on prépare son scénario avant) : le menu doit faire pareil.
    const saved: Graph[] = [];
    await mockBuilder(page, saved, { rcs: false, email: false });
    await page.goto('/workflows?open=wf1');

    await tirerDepuisUnBouton(page);

    const chooser = page.getByTestId('node-type-chooser');
    await expect(chooser).toBeVisible();
    await expect(chooser.getByTestId('node-type-email')).toBeDisabled();
    await expect(chooser.getByTestId('node-type-rcs_message')).toBeDisabled();
    // L'infobulle dit POURQUOI, sinon l'entrée grisée est une impasse muette.
    await expect(chooser.getByTestId('node-type-email')).toHaveAttribute('title', /boîte email/i);
    await expect(chooser.getByTestId('node-type-rcs_message')).toHaveAttribute('title', /agent RCS/i);

    // Et un clic sur une entrée grisée ne crée RIEN.
    await chooser.getByTestId('node-type-email').click({ force: true });
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  });
});
