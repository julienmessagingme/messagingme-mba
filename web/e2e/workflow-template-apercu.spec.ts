import { test, expect } from '@playwright/test';

/**
 * E2E builder : un bloc « envoi de template » CLASSIQUE montre l'aperçu compact du message (demande de Julien
 * du 2026-09-29) : la bande de l'en-tête, puis le début du texte. Avant, seul le nom du template s'affichait, et
 * il fallait ouvrir chaque bloc pour savoir ce qu'il envoyait.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Graph = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

const AVEC_IMAGE = {
  id: 'T1', name: 'promo_hiver', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  headerFormat: 'IMAGE', headerMediaUrl: 'https://cdn.example/hiver.jpg',
  body: 'Bonjour {{1}}, la neige est tombée sur Serre Chevalier.',
  buttons: [{ type: 'QUICK_REPLY', text: 'En savoir plus' }],
  isCarousel: false, editable: false,
};
const AVEC_TITRE = {
  id: 'T2', name: 'rappel_rdv', status: 'APPROVED', category: 'UTILITY', language: 'fr',
  headerFormat: 'TEXT', headerText: 'Votre rendez-vous', body: 'Il a lieu demain à 10 h.',
  isCarousel: false, editable: false,
};

function blocTemplate(id: string, templateName: string, y: number) {
  return {
    id, type: 'template', position: { x: 0, y },
    data: { wfType: 'template', templateName, language: 'fr', templateButtons: [], templateCards: [] },
  };
}

async function mockBuilder(page: import('@playwright/test').Page, graph: Graph) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const wf = { id: 'wf1', name: 'Scénario E2E', graph, createdAt: '', updatedAt: '' };
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/workflows\/wf1$/.test(url)) return json({ workflow: wf });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf1', name: 'Scénario E2E', graph }] });
    if (url.includes('/templates')) return json({ templates: [AVEC_IMAGE, AVEC_TITRE] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Builder : aperçu d’un bloc template classique', () => {
  test('en-tête image et début du texte ; en-tête texte en titre ; rien pour un template introuvable', async ({ page }) => {
    await mockBuilder(page, {
      nodes: [blocTemplate('n1', 'promo_hiver', 0), blocTemplate('n2', 'rappel_rdv', 300), blocTemplate('n3', 'disparu', 600)],
      edges: [],
    });
    await page.goto('/workflows?open=wf1');

    const image = page.locator('.react-flow__node[data-id="n1"]');
    await expect(image.getByTestId('node-apercu-template')).toBeVisible();
    await expect(image.getByTestId('node-apercu-entete')).toHaveAttribute('src', 'https://cdn.example/hiver.jpg');
    await expect(image.getByText('la neige est tombée', { exact: false })).toBeVisible();

    const titre = page.locator('.react-flow__node[data-id="n2"]');
    await expect(titre.getByText('Votre rendez-vous')).toBeVisible();
    await expect(titre.getByText('Il a lieu demain à 10 h.')).toBeVisible();
    await expect(titre.getByTestId('node-apercu-entete')).toHaveCount(0);

    // Un template supprimé depuis : aucun aperçu, plutôt qu'un cadre vide.
    await expect(page.locator('.react-flow__node[data-id="n3"]').getByTestId('node-apercu-template')).toHaveCount(0);
  });
});
