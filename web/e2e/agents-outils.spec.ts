import { test, expect } from '@playwright/test';

/**
 * Onglet OUTILS d'un agent IA.
 *
 * Ce qu'on vérifie vraiment ici : donner un outil et l'ACTIVER sont deux gestes séparés (l'activation est le
 * consentement humain que la spec MCP demande avant l'invocation d'un outil, et que notre agent n'a pas au
 * runtime), l'autonomie sur une action irréversible en est un troisième, et le client peut lire le schéma
 * RÉEL envoyé au modèle, parce que ce sont ses mots qui pilotent l'appel de fonction.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AG = '11111111-1111-4111-8111-111111111111';

const CATALOGUE = [
  {
    handler: 'poser_tag', nomDefaut: 'mba_poser_tag',
    titre: { fr: 'Poser un tag sur le contact', en: 'Tag the contact' },
    description: { fr: 'Marque le contact.', en: 'Marks the contact.' },
    nePasUtiliser: { fr: 'Pas de tag inventé.', en: 'No invented tag.' },
    risk: 'write',
    params: [{ name: 'tag', edition: 'enum', aideEnum: { fr: 'Les tags autorisés.', en: 'Allowed tags.' } }],
  },
  {
    handler: 'envoyer_bloc', nomDefaut: 'mba_envoyer_bloc',
    titre: { fr: 'Envoyer un bloc de votre scénario', en: 'Send a block from your scenario' },
    description: { fr: 'Envoie un bloc que vous avez dessiné.', en: 'Sends a block you designed.' },
    nePasUtiliser: { fr: 'Pas pour dire ce qu’un message dirait.', en: 'Not for what a message would say.' },
    risk: 'irreversible',
    params: [{ name: 'code', edition: 'enum' }],
  },
];

const TAG = {
  id: 'o1', name: 'mba_poser_tag', title: 'Poser un tag sur le contact',
  description: 'Marque le contact.', nePasUtiliser: 'Pas de tag inventé.',
  params: [{ name: 'tag', type: 'string', source: 'modele', required: true }],
  binding: { handler: 'poser_tag' }, risk: 'write',
  actif: false, activeLe: null, autonome: false, autonomeLe: null,
  expose: { name: 'mba_poser_tag', description: 'Marque le contact.', parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'], additionalProperties: false } },
};
const BLOC = {
  ...TAG, id: 'o2', name: 'mba_envoyer_bloc', title: 'Envoyer un bloc de votre scénario',
  binding: { handler: 'envoyer_bloc' }, risk: 'irreversible', params: [{ name: 'code', type: 'string', source: 'modele', required: true }],
};
/** Actif, mais le modèle n'en voit RIEN : c'est le cas de « terminer » sans règle d'arrêt sur la fiche. */
const MUET = {
  ...TAG, id: 'o3', name: 'mba_terminer', title: 'Terminer par une règle d’arrêt',
  binding: { handler: 'terminer' }, risk: 'read', actif: true, activeLe: '2026-08-28T10:00:00.000Z', expose: null,
};

const AGENT = {
  id: AG, label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule',
  contenu: { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] },
  ficheVersion: 4,
};

type Appel = { method: string; url: string; body: unknown };

async function mock(page: import('@playwright/test').Page, appels: Appel[], outils: unknown[]) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/tools/.test(url)) {
      if (method === 'GET') return json({ outils, catalogue: CATALOGUE });
      appels.push({ method, url, body: req.postDataJSON() });
      if (method === 'DELETE') return route.fulfill({ status: 204, body: '' });
      if (method === 'POST') return json({ outil: TAG }, 201);
      const corps = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      if (/\/activation$/.test(url)) return json({ outil: { ...TAG, actif: corps.valeur === true } });
      if (/\/autonomie$/.test(url)) return json({ outil: { ...BLOC, autonome: corps.valeur === true } });
      return json({ outil: { ...TAG, ...corps } });
    }
    if (new RegExp(`/agents/${AG}$`).test(url)) return json({ agent: AGENT });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [] }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Agents IA : les outils', () => {
  test('🔴 donner un outil et l ACTIVER sont deux gestes séparés', async ({ page }) => {
    // Un outil actif est exécutable par le modèle, donc par un texte qu'un contact influence. L'activation
    // est le consentement humain que la spec MCP demande, déplacé du runtime vers la configuration.
    const appels: Appel[] = [];
    await mock(page, appels, []);
    await page.goto(`/agents?id=${AG}&tab=outils`);

    await expect(page.getByTestId('outils-vide')).toBeVisible();
    await page.getByTestId('outil-ajouter-poser_tag').click();
    await expect.poll(() => appels.some((a) => a.method === 'POST' && (a.body as { handler?: string })?.handler === 'poser_tag'), { timeout: 5000 }).toBe(true);
    // Ajouté, il n'est PAS actif : le serveur le crée inactif et l'écran le dit.
    expect(appels.filter((a) => /activation$/.test(a.url))).toHaveLength(0);
  });

  test('l activation est un aller-retour, et le geste porte sur cet outil', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await page.getByTestId('outil-activer-o1').click();
    await expect.poll(() => appels.some((a) => /o1\/activation$/.test(a.url) && (a.body as { valeur?: boolean })?.valeur === true), { timeout: 5000 }).toBe(true);
  });

  test('🔴 l autonomie n est proposée QUE sur une action irréversible', async ({ page }) => {
    // Un message parti chez un contact ne se rappelle pas, et il est facturé. Proposer la case ailleurs
    // banaliserait le geste ; ne pas la proposer là rendrait l'outil inutilisable sans explication.
    const appels: Appel[] = [];
    await mock(page, appels, [TAG, BLOC]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await expect(page.getByTestId('outil-autonomie-o1')).toHaveCount(0);
    await expect(page.getByTestId('outil-autonomie-o2')).toBeVisible();

    // `click` et non `check` : la liste est rechargée après l'appel, et le double de test rend toujours la
    // même liste, donc la case revient à son état d'origine. C'est l'APPEL qu'on vérifie, pas le pixel.
    await page.getByTestId('outil-autonomie-o2').getByRole('checkbox').click();
    await expect.poll(() => appels.some((a) => /o2\/autonomie$/.test(a.url) && (a.body as { valeur?: boolean })?.valeur === true), { timeout: 5000 }).toBe(true);
  });

  test('🔴 un outil actif que le modèle ne VOIT PAS est signalé', async ({ page }) => {
    // « terminer » sans règle d'arrêt sur la fiche : actif, mais rien à offrir. Sans ce message, le client
    // croit son agent réglé et ne comprend pas pourquoi il ne termine jamais.
    await mock(page, [], [MUET]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await expect(page.getByText('le modèle n’en voit RIEN')).toBeVisible();
    await page.getByTestId('outil-schema-bouton-o3').click();
    await expect(page.getByTestId('outil-schema-o3')).toContainText('aucune valeur possible');
  });

  test('le schéma réellement envoyé au modèle est consultable', async ({ page }) => {
    await mock(page, [], [TAG]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await page.getByTestId('outil-schema-bouton-o1').click();
    await expect(page.getByTestId('outil-schema-o1')).toContainText('"additionalProperties": false');
  });

  test('🔴 le nom vu par le modèle est NORMALISÉ sous les yeux du client', async ({ page }) => {
    // La base n'accepte que [a-z0-9_] : montrer la règle en direct vaut mieux qu'un 400 sur un champ que le
    // client croyait bon.
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await page.getByTestId('outil-nom-o1').fill('Poser un tâg');
    await expect(page.getByTestId('outil-nom-normalise-o1')).toHaveText('poser_un_tag');
    await page.getByTestId('outil-description-o1').click(); // sortie du champ
    await expect.poll(() => appels.some((a) => a.method === 'PATCH' && (a.body as { name?: string })?.name === 'poser_un_tag'), { timeout: 5000 }).toBe(true);
  });

  test('les valeurs autorisées d un paramètre s ajoutent et se retirent', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [{ ...TAG, params: [{ name: 'tag', type: 'string', source: 'modele', required: true, enum: ['vip'] }] }]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await expect(page.getByTestId('outil-valeur-o1-vip')).toBeVisible();

    await page.getByTestId('outil-valeur-saisie-o1-tag').fill('relance');
    await page.getByTestId('outil-valeur-ajouter-o1-tag').click();
    await expect.poll(
      () => appels.some((a) => a.method === 'PATCH' && JSON.stringify((a.body as { enums?: unknown })?.enums) === JSON.stringify({ tag: ['vip', 'relance'] })),
      { timeout: 5000 },
    ).toBe(true);
  });

  test('retirer un outil le retire', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await page.getByTestId('outil-retirer-o1').click();
    await expect.poll(() => appels.some((a) => a.method === 'DELETE'), { timeout: 5000 }).toBe(true);
  });
});
