import { test, expect } from '@playwright/test';

/**
 * Un visuel sur le bloc « message rapide ». Demandé par Julien le 2026-08-25 : le bloc ne savait envoyer que
 * du texte et des boutons, rien d'autre.
 *
 * Le champ est le MÊME que celui du bloc RCS (`imageUrl`, composant `ChampImageHebergee`) : un seul téléversement,
 * une seule convention de stockage, et le visuel sert aux deux canaux (en-tête du message interactif en
 * WhatsApp, carte du message en RCS).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

const AVEC_MESSAGE_RAPIDE: Graph = {
  nodes: [{
    id: 'n1', type: 'quick_message', position: { x: 0, y: 0 },
    data: { wfType: 'quick_message', body: 'Un souci ?', quickReplies: ['Oui'] },
  }],
  edges: [],
};

async function mockBuilder(page: import('@playwright/test').Page, saved: Graph[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph: AVEC_MESSAGE_RAPIDE, createdAt: '', updatedAt: '' };
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
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph: AVEC_MESSAGE_RAPIDE }] });
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

test.describe('Bloc message rapide : le visuel', () => {
  test('🔴 le champ image existe et se persiste dans le bloc', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, saved);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    const champ = page.getByTestId('quick-node-image');
    await expect(champ).toBeVisible();

    await champ.fill('https://mba.messagingme.app/m/abc.png');

    // L'auto-save écrit le MÊME champ que le bloc RCS : c'est ce qui permet à un seul visuel de servir les
    // deux canaux, sans conversion nulle part.
    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) => (n.data as { imageUrl?: string }).imageUrl === 'https://mba.messagingme.app/m/abc.png')),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('le champ reste vide par défaut : un bloc existant ne change pas de comportement', async ({ page }) => {
    await mockBuilder(page, []);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('quick-node-image')).toHaveValue('');
  });
});

/**
 * 🔴 LE VISUEL SE VOIT SUR LE BLOC. Demandé par Julien le 2026-08-28 : « je veux voir cette photo dans la
 * miniature du node et pas que sur la sidebar ». Un scénario se relit d'un coup d'œil sur le canevas ; sans
 * ça, il faut ouvrir chaque bloc pour savoir lequel porte une image.
 */
test.describe('Éditeur : le visuel dans la miniature du bloc', () => {
  test('🔴 un bloc qui porte une image la MONTRE, un bloc sans image ne montre rien', async ({ page }) => {
    await mockBuilder(page, []);
    await page.goto('/workflows?open=wf1');
    // Le graphe de départ n'a pas d'image : aucune vignette.
    await expect(page.getByTestId('node-visuel')).toHaveCount(0);
    // On en pose une par le panneau, comme le ferait un client.
    await page.locator('.react-flow__node').first().click();
    await page.getByTestId('quick-node-image').fill('https://mba.messagingme.app/m/abc.png');
    await page.getByTestId('quick-node-image').blur();
    const vignette = page.getByTestId('node-visuel');
    await expect(vignette).toHaveCount(1);
    await expect(vignette).toHaveAttribute('src', 'https://mba.messagingme.app/m/abc.png');
  });
});
