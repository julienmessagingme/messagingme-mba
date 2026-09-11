import { test, expect } from '@playwright/test';

/**
 * Un BOUTON DE LIEN sur le bloc « message rapide ». Demandé par Julien le 2026-09-11 : « quand on fasse une
 * bouton de réponse rapide, ce bouton puisse pointer vers une URL ».
 *
 * 🔴 CE QUE CET ÉCRAN DIT, ET POURQUOI IL DOIT LE DIRE ICI. Chez Meta, une réponse rapide ne PEUT PAS porter
 * d'adresse : `button` (jusqu'à trois réponses qui REVIENNENT dans le scénario) et `cta_url` (un bouton qui
 * OUVRE une page) sont deux TYPES de messages interactifs différents, et un message n'a qu'un type. La
 * contrainte n'est pas négociable, elle est seulement déplaçable : soit le client la découvre au moment où
 * son message est refusé, soit l'écran la lui dit quand il coche la case. C'est le second qu'on a construit.
 *
 * ⚠️ Cocher la case VIDE les réponses rapides au lieu de les masquer, et c'est le point que ce test garde :
 * l'exclusivité vit dans la DONNÉE, donc les trois lecteurs de `quickReplies` (le moteur, la miniature du
 * bloc, les alertes de montage) continuent de voir un simple message texte sans qu'aucun n'ait à connaître
 * la nouvelle case.
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

test.describe('Bloc message rapide : le bouton de lien', () => {
  test('la case n’est pas cochée par défaut : un bloc existant ne change pas de comportement', async ({ page }) => {
    await mockBuilder(page, []);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('quick-node-lien-actif')).not.toBeChecked();
    // Les réponses rapides sont là, comme avant.
    await expect(page.getByTestId('quick-node-qr-desactivees')).toHaveCount(0);
  });

  test('🔴 cocher la case ouvre le libellé et l’adresse, et RETIRE les réponses rapides', async ({ page }) => {
    const saved: Graph[] = [];
    await mockBuilder(page, saved);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();

    await page.getByTestId('quick-node-lien-actif').check();
    await expect(page.getByTestId('quick-node-lien-texte')).toBeVisible();
    await expect(page.getByTestId('quick-node-lien-url')).toBeVisible();
    // La raison est ÉCRITE là où la fonctionnalité manque, pas dans une note de bas de page.
    await expect(page.getByTestId('quick-node-qr-desactivees')).toBeVisible();

    await page.getByTestId('quick-node-lien-texte').fill('Télécharger');
    await page.getByTestId('quick-node-lien-url').fill('https://exemple.fr/b.pdf');

    await expect.poll(
      () => saved.some((g) => g.nodes.some((n) => {
        const d = n.data as { lienActif?: boolean; lienTexte?: string; lienUrl?: string; quickReplies?: unknown[] };
        return d.lienActif === true && d.lienTexte === 'Télécharger' && d.lienUrl === 'https://exemple.fr/b.pdf'
          && Array.isArray(d.quickReplies) && d.quickReplies.length === 0;
      })),
      { timeout: 10_000 },
    ).toBe(true);
  });

  test('⚠️ une adresse mal formée est signalée AVANT l’envoi, pas après', async ({ page }) => {
    // Une adresse sans schéma, ou porteuse d'une variable, fait refuser le message ENTIER par Meta. Le dire
    // au moment de la saisie évite un scénario qui se montre cassé seulement en production.
    await mockBuilder(page, []);
    await page.goto('/workflows?open=wf1');
    await page.locator('.react-flow__node').first().click();
    await page.getByTestId('quick-node-lien-actif').check();

    await page.getByTestId('quick-node-lien-url').fill('exemple.fr');
    await expect(page.getByTestId('quick-node-lien-erreur')).toBeVisible();

    await page.getByTestId('quick-node-lien-url').fill('https://exemple.fr/{{prenom}}');
    await expect(page.getByTestId('quick-node-lien-erreur')).toBeVisible();

    await page.getByTestId('quick-node-lien-url').fill('https://exemple.fr');
    await expect(page.getByTestId('quick-node-lien-erreur')).toHaveCount(0);
  });
});
