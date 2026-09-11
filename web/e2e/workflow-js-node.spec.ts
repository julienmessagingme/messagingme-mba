import { test, expect } from '@playwright/test';

/**
 * E2E builder : le bloc « Fonction JS », ses deux demandes de Julien du 2026-09-11.
 *
 * 1. Creer un champ de contact SANS quitter le scenario (« il faut que je puisse creer a la volee un
 *    nouveau champ, qui se repercutera bien sur partout, y compris jusqu au mini-CRM »).
 * 2. N ecrire que l INTERIEUR de la fonction (« on va pas demander au user d ecrire toute la fonction
 *    avec function(variable){ xxxx } »). C etait deja le cas cote serveur, et il ne s en est pas apercu :
 *    l enveloppe est donc MONTREE au lieu d etre decrite en une phrase.
 *
 * Backend intercepte, aucune base.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

async function ouvrirBuilder(page: import('@playwright/test').Page, opts: { creationRefusee?: boolean } = {}) {
  const saved: Graph[] = [];
  const crees: Array<Record<string, unknown>> = [];
  const champs: Array<{ key: string; label: string; type: string }> = [{ key: 'ville', label: 'Ville', type: 'text' }];
  const initial: Graph = { nodes: [{ id: 't', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo' } }], edges: [] };
  const wf = { id: 'wf1', name: 'Scenario E2E', graph: initial, createdAt: '', updatedAt: '' };

  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'PATCH' && /\/workflows\/wf1$/.test(url)) {
      const body = (req.postDataJSON() ?? {}) as { graph?: Graph };
      if (body.graph) saved.push(body.graph);
      return json({ ok: true });
    }
    if (req.method() === 'POST' && /\/user-fields$/.test(url)) {
      const b = (req.postDataJSON() ?? {}) as { label?: string; type?: string };
      crees.push(b);
      if (opts.creationRefusee) return json({ error: 'un champ existe deja pour cette cle' }, 409);
      const cree = { key: 'statut_commande', label: String(b.label), type: String(b.type) };
      champs.push(cree);
      return json(cree, 201);
    }
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scenario E2E', graph: initial }] });
    if (url.includes('/user-fields')) return json({ fields: champs });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });

  await page.goto('/workflows?open=wf1');
  await page.getByTestId('add-node-js').click();
  return { saved, crees };
}

test.describe('Builder : le bloc Fonction JS', () => {
  test('🔴 un champ se CREE a la volee, et il est selectionne aussitot', async ({ page }) => {
    const { saved, crees } = await ouvrirBuilder(page);

    await page.getByTestId('js-node-cible-nouveau').click();
    await page.getByTestId('js-node-cible-nom').fill('Statut commande');
    await page.getByTestId('js-node-cible-creer').click();

    // Cree en TEXTE : le bloc range ce que la fonction rend, converti en texte.
    await expect.poll(() => crees, { timeout: 5000 }).toEqual([{ label: 'Statut commande', type: 'text' }]);
    // 🔴 ET SELECTIONNE : creer puis devoir le chercher dans la liste serait le geste fait a moitie.
    await expect(page.getByTestId('js-node-cible')).toHaveValue('statut_commande');
    // Le formulaire de creation se referme, sinon on croit que rien ne s est passe.
    await expect(page.getByTestId('js-node-cible-nom')).toHaveCount(0);
    // Et il part dans le graphe enregistre.
    await expect.poll(
      () => saved.some((g) => g.nodes.some((nd) => (nd.data as { champCible?: unknown }).champCible === 'statut_commande')),
      { timeout: 5000 },
    ).toBe(true);
  });

  test('🔴 un nom REFUSE le dit, au lieu d un bouton qui ne fait rien', async ({ page }) => {
    // Sans ce message, le client reessaierait le meme nom en croyant a une panne.
    await ouvrirBuilder(page, { creationRefusee: true });
    await page.getByTestId('js-node-cible-nouveau').click();
    await page.getByTestId('js-node-cible-nom').fill('Ville');
    await page.getByTestId('js-node-cible-creer').click();
    await expect(page.getByTestId('js-node-cible-refus')).toContainText(/pris|taken/);
    // Le champ cible n'a pas bouge : on n'annonce pas un rangement qui n'a pas eu lieu.
    await expect(page.getByTestId('js-node-cible')).toHaveValue('');
  });

  test('🔴 l ENVELOPPE de la fonction est montree, on ne tape que l interieur', async ({ page }) => {
    // Elle etait deja ajoutee par le serveur, et decrite en une phrase. Une phrase se lit ou ne se lit pas.
    await ouvrirBuilder(page);
    await expect(page.getByText('function (valeur) {', { exact: true })).toBeVisible();
    await expect(page.getByText(/Ecrivez seulement l|Écrivez seulement l|Write only the inside/)).toBeVisible();
  });
});
