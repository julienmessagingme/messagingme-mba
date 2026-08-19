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

// Positions DISTINCTES, comme dans un vrai scenario : le canevas les respecte, et des blocs empiles au meme
// point se recouvriraient (le clic irait au dernier rendu, pas a celui qu'on vise).
const GRAPH = {
  nodes: [
    { id: 'tag1', type: 'action', position: { x: 0, y: 400 }, data: { actionKind: 'add_tag', tag: 'vu' } },
    { id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } },
    { id: 'n2', type: 'quick_message', position: { x: 0, y: 200 }, data: { body: 'Ça te va ?', quickReplies: [{ text: 'Oui' }, { text: 'Non' }] } },
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
  const sauvegardes: Array<Record<string, unknown>> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/workflow-reports')) {
      if (route.request().method() === 'POST') {
        const b = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
        sauvegardes.push(b);
        return json({ report: { id: 'rp1', workflowId: b.workflowId, name: b.name, mesures: b.mesures, updatedAt: '2026-08-19T10:00:00.000Z' } });
      }
      return json({ reports: [] });
    }
    if (url.includes('/stats/workflow/')) return json({ counts: COUNTS });
    if (/\/workflows\/wf-1(\?|$)/.test(url)) return json({ workflow: { id: 'wf-1', name: 'Parcours promo', graph: GRAPH } });
    if (url.endsWith('/workflows')) return json({ workflows: [{ id: 'wf-1', name: 'Parcours promo', graph: GRAPH }] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/dashboard/tableaux');
  await expect(page.getByTestId('tableaux-scenario')).toBeVisible({ timeout: 15_000 });
  return { sauvegardes };
}

test.describe('Analytics : Mes tableaux', () => {
  test('🔴 le SCENARIO s’affiche tel qu’il est dessine, et les non-messages sont grises', async ({ page }) => {
    // Le canevas rend les blocs a leurs positions d'origine, avec leurs fleches : l'operateur retrouve son
    // scenario au lieu d'en lire une transcription. L'ORDRE du parcours, lui, n'est plus une propriete du DOM :
    // il sert au regroupement du tableau, et il est couvert par les tests de `mesures-scenario`.
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await expect(page.getByTestId('scenario-canvas')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('bloc-mesurable')).toHaveCount(2);
    await expect(page.getByTestId('bloc-grise')).toHaveCount(1);
    // Les fleches du scenario sont bien dessinees : sans elles, ce ne serait plus le scenario.
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  });

  test('🔴 cliquer un bloc GRISE n’ouvre rien', async ({ page }) => {
    // Un bloc qui n'envoie pas de message n'a rien a mesurer. Le laisser ouvrir un panneau vide ferait chercher
    // une configuration qui n'existe pas.
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await expect(page.getByTestId('scenario-canvas')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('bloc-grise').click();
    await expect(page.getByTestId('bloc-mesures')).toHaveCount(0);
  });

  test('🔴 choisir des mesures compose le tableau, et un choix est nommé par son TEXTE', async ({ page }) => {
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await expect(page.getByTestId('scenario-canvas')).toBeVisible({ timeout: 15_000 });

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
    await expect(page.getByTestId('scenario-canvas')).toBeVisible({ timeout: 15_000 });

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

test.describe('Mes tableaux : l’histogramme', () => {
  test('🔴 UNE seule ligne d’abscisse pour tout le tableau', async ({ page }) => {
    // C'est elle qui dit que les groupes appartiennent au meme parcours. Un axe par bloc donnerait trois
    // graphes cote a cote, et on ne compare pas trois graphes.
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();
    await page.getByTestId('bloc-mesurable').nth(1).click();
    await page.getByTestId('mesure-sent').check();
    await expect(page.getByTestId('barre')).toHaveCount(2);
    await expect(page.getByTestId('tableaux-graphe').locator('svg line')).toHaveCount(1);
  });

  test('🔴 une MEME nature garde la meme couleur d’un bloc a l’autre', async ({ page }) => {
    // C'est ce qui permet de comparer « envoyes » du bloc 1 a « envoyes » du bloc 2 sans relire la legende.
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();
    await page.getByTestId('bloc-mesurable').nth(1).click();
    await page.getByTestId('mesure-sent').check();

    const couleurs = await page.getByTestId('barre').locator('rect').evaluateAll((n) => n.map((r) => r.getAttribute('fill')));
    expect(couleurs[0]).toBe(couleurs[1]);
    // Et la legende ne repete pas deux fois « Envoyes » : c'est une cle de lecture, pas une liste de barres.
    await expect(page.getByTestId('tableau-legende').getByText('Envoyés')).toHaveCount(1);
  });

  test('une barre a ZERO reste dessinee, avec sa valeur', async ({ page }) => {
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-read').check();
    await expect(page.getByTestId('barre')).toHaveCount(1);
    await expect(page.getByTestId('tableaux-graphe')).toContainText('0');
  });
});

test.describe('Mes tableaux : enregistrement', () => {
  test('🔴 nommer puis enregistrer envoie le scénario ET la sélection', async ({ page }) => {
    const { sauvegardes } = await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();

    await page.getByTestId('tableau-nom').fill('Entonnoir Randstad');
    await page.getByTestId('tableau-enregistrer').click();

    await expect.poll(() => sauvegardes.length).toBe(1);
    expect(sauvegardes[0]).toMatchObject({ workflowId: 'wf-1', name: 'Entonnoir Randstad' });
    expect((sauvegardes[0]!.mesures as unknown[])).toHaveLength(1);
    await expect(page.getByTestId('tableau-etat')).toContainText(/enregistré/i);
  });

  test('🔴 le bouton reste INACTIF sans nom', async ({ page }) => {
    // Un tableau sans nom serait introuvable dans le sélecteur : autant ne pas le laisser créer.
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();
    await expect(page.getByTestId('tableau-enregistrer')).toBeDisabled();
  });

  test('la zone d’enregistrement n’apparaît qu’une fois une mesure choisie', async ({ page }) => {
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');
    await expect(page.getByTestId('tableau-nom')).toHaveCount(0);
    await page.getByTestId('bloc-mesurable').first().click();
    await page.getByTestId('mesure-sent').check();
    await expect(page.getByTestId('tableau-nom')).toBeVisible();
  });

  test('🔴 « Échecs » et « Délivrés » ne sont proposés que sur le 1er bloc de message', async ({ page }) => {
    await monter(page);
    await page.getByTestId('tableaux-scenario').selectOption('wf-1');

    await page.getByTestId('bloc-mesurable').first().click();
    await expect(page.getByTestId('mesure-failed')).toHaveCount(1);
    await expect(page.getByTestId('mesure-delivered')).toHaveCount(1);

    // Un SEUL panneau est ouvert a la fois : ouvrir le 2e bloc referme le 1er.
    await page.getByTestId('bloc-mesurable').nth(1).click();
    const panneau = page.getByTestId('bloc-mesures');
    await expect(panneau).toHaveCount(1);
    await expect(panneau.getByTestId('mesure-failed')).toHaveCount(0);
    await expect(panneau.getByTestId('mesure-delivered')).toHaveCount(0);
    // Le reste est bien la : on n'a pas vide le panneau par accident.
    await expect(panneau.getByTestId('mesure-sent')).toHaveCount(1);
    await expect(panneau.getByTestId('mesure-read')).toHaveCount(1);
  });
});
