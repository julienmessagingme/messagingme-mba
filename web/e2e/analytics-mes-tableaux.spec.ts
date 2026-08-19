import { test, expect } from '@playwright/test';

/**
 * E2E « Analytics > Mes tableaux ».
 *
 * Ce que le test regarde : que les blocs apparaissent DANS L'ORDRE DU PARCOURS, que ceux qui n'envoient pas de
 * message soient inertes, que le choix des mesures compose le tableau, et surtout qu'une mesure sans donnée
 * s'affiche à ZÉRO au lieu de disparaître. Une mesure choisie qui vaut zéro est une information ; la masquer
 * laisserait croire à un oubli de configuration.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const GRAPH = {
  nodes: [
    { id: 'tag1', type: 'action', position: { x: 0, y: 0 }, data: { actionKind: 'add_tag', tag: 'vu' } },
    { id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } },
    { id: 'n2', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: 'Ça te va ?', quickReplies: [{ text: 'Oui' }, { text: 'Non' }] } },
  ],
  edges: [
    { id: 'e0', source: 'n1', target: 'n2' },
    { id: 'e1', source: 'n2', target: 'tag1', sourceHandle: 'btn:0' },
  ],
};

const COUNTS = [
  { nodeId: 'n1', kind: 'sent', handle: null, count: 40, contacts: 40 },
  { nodeId: 'n2', kind: 'reply_button', handle: 'btn:0', count: 12, contacts: 9 },
];

async function monter(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/workflow/')) return json({ counts: COUNTS });
    if (/\/workflows\/wf-1(\?|$)/.test(url)) return json({ workflow: { id: 'wf-1', name: 'Parcours promo', graph: GRAPH } });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf-1', name: 'Parcours promo', graph: GRAPH }] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/dashboard/tableaux');
  await expect(page.getByTestId('tableaux-scenario')).toBeVisible({ timeout: 15_000 });
}

test.describe('Analytics : Mes tableaux', () => {
  test('🔴 les blocs sortent dans l’ordre du PARCOURS, et les non-messages sont inertes', async ({ page }) => {
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await expect(page.getByTestId('tableaux-blocs')).toBeVisible({ timeout: 15_000 });

    // L'ordre de stockage du graphe place le bloc « tag » en premier ; le parcours, lui, commence au template.
    const libelles = await page.getByTestId('tableaux-blocs').locator('li button').allInnerTexts();
    expect(libelles[0]).toContain('promo');
    expect(libelles[2]).toContain('Action');

    await expect(page.getByTestId('bloc-mesurable')).toHaveCount(2);
    await expect(page.getByTestId('bloc-grise')).toHaveCount(1);
    await expect(page.getByTestId('bloc-grise')).toBeDisabled();
  });

  test('🔴 choisir des mesures compose le tableau, et un choix est nommé par son TEXTE', async ({ page }) => {
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await expect(page.getByTestId('tableaux-blocs')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();
    await expect(page.getByTestId('barre')).toHaveCount(1);
    await expect(page.getByTestId('tableaux-graphe')).toContainText('40');

    // 2e bloc : le clic sur « Oui » est propose sous son texte, pas sous `btn:0`.
    await page.getByTestId('bloc-mesurable').nth(1).click();
    await expect(page.getByText('A cliqué « Oui »')).toBeVisible();
    await page.getByTestId('mesure-reply_button').first().check();
    await expect(page.getByTestId('barre')).toHaveCount(2);
    // 12 clics pour 9 personnes : les deux chiffres sont montres, parce qu'ils different.
    await expect(page.getByTestId('tableaux-graphe')).toContainText('12');
    await expect(page.getByTestId('tableaux-graphe')).toContainText('9');
  });

  test('🔴 une mesure SANS donnée s’affiche à zéro, elle ne disparaît pas', async ({ page }) => {
    // « Lus » n'existe pas dans les compteurs de ce scenario. La barre doit quand meme apparaitre a 0 : c'est
    // une reponse (« personne »), pas une absence de configuration.
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await expect(page.getByTestId('tableaux-blocs')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-read').check();
    await expect(page.getByTestId('barre')).toHaveCount(1);
    await expect(page.getByTestId('tableaux-graphe')).toContainText('0');
  });

  test('🔴 l’écran dit que les mesures ne sont pas rétroactives', async ({ page }) => {
    // Sans cette phrase, une periode anterieure a la mise en service se lit comme une panne.
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();
    await expect(page.getByText(/démarrent à la mise en service/)).toBeVisible();
  });

  test('changer de scénario repart d’un tableau vide', async ({ page }) => {
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();
    await expect(page.getByTestId('barre')).toHaveCount(1);

    await page.getByTestId('tableaux-scenario').selectOption('');
    await expect(page.getByTestId('barre')).toHaveCount(0);
  });
});
