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
  // `origin` et `sourceId` : le serveur les rend toujours depuis le lot L2, et l'écran s'en sert pour
  // séparer les outils MAISON des connecteurs du client. Un fixe qui les omettrait ne testerait plus la
  // même page que celle qui tourne.
  id: 'o1', origin: 'mba', sourceId: null, name: 'mba_poser_tag', title: 'Poser un tag sur le contact',
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
/**
 * 🔴 UN OUTIL MCP MORT, SUR L ECRAN OU LE CLIENT REDONNE SON AUTORISATION. Le serveur envoyait deja ces
 * deux champs, le type front ne les declarait pas : un outil dont le schema n est plus representable, ou
 * qui a DISPARU du serveur distant, ressemblait exactement a un outil vivant. Or c est precisement
 * l ecran que le recit anti-IDOR nomme (« le client le redonne depuis AI Agent > Outils, qui n est PAS
 * l ecran de clouage »), et le client ne l apprenait qu en recevant un refus.
 */
const MCP_MORT = {
  ...TAG, id: 'o4', origin: 'mcp', sourceId: 's1', name: 'notion_lignes', title: 'Lire les lignes',
  /**
   * ⚠️ IL TIENT LE CONTRAT D UN VRAI OUTIL MCP. Construit par `...TAG`, il heritait d un
   * `binding: { handler: 'poser_tag' }` et d un `expose.name: 'mba_poser_tag'`, c est-a-dire d un outil
   * MAISON portant un nom MCP. Un faux qui ne tient pas le contrat du vrai masquerait toute logique
   * indexee sur `binding.handler`, et ce depot a deja paye ce defaut cinq fois aujourd hui.
   */
  binding: { outilDistant: 'lignes' },
  requestId: null,
  expose: { name: 'notion_lignes', description: 'Lire les lignes', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  mcpNonActivable: 'le paramètre « lignes » est un tableau', mcpIndisponibleLe: null,
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

async function mock(page: import('@playwright/test').Page, appels: Appel[], outils: unknown[], bibliotheque: unknown[] = []) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    // La BIBLIOTHEQUE de l espace : c est elle qui porte les outils MCP importes mais pas encore
    // rattaches a cet agent. Sans cette route, l ecran ne peut pas les proposer.
    if (/\/agent-tools(\?|$)/.test(url)) return json({ outils: bibliotheque });
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
    /* Les blocs des scénarios, d'où le choisisseur tire sa liste. `sce-b` n'a AUCUN bloc agent : il ne doit
       donc jamais apparaître, l'outil ne pouvant envoyer que dans le scénario où le contact se trouve. */
    if (/\/nodes(\?|$)/.test(url)) {
      return json({ nodes: [
        { code: null, type: 'agent', name: 'Le conseiller', workflowId: 'w1', workflowName: 'Séjours', summary: 'Agent IA' },
        { code: 'nod_photo', type: 'template', name: 'La photo de la résidence', workflowId: 'w1', workflowName: 'Séjours', summary: 'Modèle photo' },
        { code: 'nod_form', type: 'flow', name: '', workflowId: 'w1', workflowName: 'Séjours', summary: 'Formulaire de rappel' },
        { code: 'nod_attente', type: 'wait', name: 'Patienter 2 h', workflowId: 'w1', workflowName: 'Séjours', summary: 'Attente' },
        { code: 'nod_autre', type: 'template', name: 'Bloc d un scénario sans agent', workflowId: 'w2', workflowName: 'Relances', summary: 'Modèle' },
      ] });
    }
    if (new RegExp(`/agents/${AG}$`).test(url)) return json({ agent: AGENT });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }] });
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

  /**
   * 🔴 LE CAS EST CONSERVÉ, SA RÉPONSE A CHANGÉ (2026-09-18).
   *
   * Ce test vérifiait qu'un outil déjà déclaré dans l'espace se BRANCHE au lieu de se recréer, parce que le
   * nom était unique par ESPACE et que « Ajouter » se faisait refuser en 409. La migration 0157 a supprimé
   * la CAUSE : une ACTION appartient désormais à l'agent, deux agents peuvent chacun avoir leur
   * « terminer », et la collision n'existe plus.
   *
   * ⚠️ CE QUI EST CONSERVÉ : la préoccupation du client, « l'écran ne doit pas me proposer un geste qui
   * échouera ». CE QUI CHANGE : la bonne réponse n'est plus de brancher, c'est de créer, et de réussir.
   */
  test('🔴 une définition du MÊME handler dans l espace n empeche plus l ajout', async ({ page }) => {
    const appels: Appel[] = [];
    const dansLEspace = {
      id: 'o7', name: 'mba_poser_tag', title: 'Poser un tag sur le contact',
      description: 'Marque le contact.', origin: 'mba', risk: 'write', sourceId: null,
      mcpNonActivable: null, mcpIndisponibleLe: null, consommateurs: [],
    };
    await mock(page, appels, [], [dansLEspace]);
    await page.goto(`/agents?id=${AG}&tab=outils`);

    // Pas de bouton « Brancher » : ce chemin n'a plus de raison d'exister, et un chemin qui ne peut plus se
    // produire est un chemin qui mentira le jour où quelqu'un s'y fiera.
    await expect(page.getByTestId('outil-brancher-poser_tag')).toHaveCount(0);
    await page.getByTestId('outil-ajouter-poser_tag').click();
    await expect.poll(() => appels.some((a) => a.method === 'POST' && (a.body as { handler?: string })?.handler === 'poser_tag'), { timeout: 5000 }).toBe(true);
  });

  /**
   * 🔴 LES GESTES DU MOMENT, ET LA PHRASE QUI LES ACCOMPAGNE (migration 0158).
   *
   * Un moment porte UNE réponse principale, que le modèle appelle, et des gestes que NOUS exécutons. L'écran
   * doit dire qu'ils partent MÊME SI l'appel échoue, sans quoi le client écrit « rendez-vous pris » et met
   * dans son mini-CRM une vérité fausse sur laquelle une automation partira ensuite.
   */
  test('🔴 on ajoute un geste au moment, et l ecran DIT qu il part meme si l appel echoue', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await page.goto(`/agents?id=${AG}&tab=outils`);

    await expect(page.getByTestId(`outil-gestes-${TAG.id}`)).toContainText('MÊME SI');
    await expect(page.getByTestId(`outil-gestes-${TAG.id}`)).toContainText('rendez-vous demandé');

    await page.getByTestId(`outil-geste-valeur-${TAG.id}`).fill('rendez_vous_demande');
    await page.getByTestId(`outil-geste-ajouter-${TAG.id}`).click();
    await expect.poll(() => appels.find((a) => a.method === 'PATCH' && (a.body as { gestes?: unknown })?.gestes !== undefined)?.body, { timeout: 5000 })
      .toEqual({ gestes: [{ type: 'tag', valeur: 'rendez_vous_demande' }] });
  });

  test('un geste « écrire dans un champ » porte SON champ, pas seulement une valeur', async ({ page }) => {
    // La preuve inverse du cas précédent : sans le champ, les deux types de geste produiraient le même
    // corps, et l'écriture partirait dans le vide.
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await page.getByTestId(`outil-geste-type-${TAG.id}`).selectOption('variable');
    await page.getByTestId(`outil-geste-champ-${TAG.id}`).fill('origine');
    await page.getByTestId(`outil-geste-valeur-${TAG.id}`).fill('agent');
    await page.getByTestId(`outil-geste-ajouter-${TAG.id}`).click();
    await expect.poll(() => appels.find((a) => a.method === 'PATCH' && (a.body as { gestes?: unknown })?.gestes !== undefined)?.body, { timeout: 5000 })
      .toEqual({ gestes: [{ type: 'variable', champ: 'origine', valeur: 'agent' }] });
  });


  test('l activation est un aller-retour, et le geste porte sur cet outil', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await page.getByTestId('outil-activer-o1').click();
    await expect.poll(() => appels.some((a) => /o1\/activation$/.test(a.url) && (a.body as { valeur?: boolean })?.valeur === true), { timeout: 5000 }).toBe(true);
  });

  test('🔴 un outil MCP importé mais PAS ENCORE rattaché est proposé, et le clic le rattache', async ({ page }) => {
    /**
     * 🔴 SANS CETTE LISTE, LA SECTION « Vos serveurs MCP » EST VIDE POUR TOUJOURS, et c est la troisieme
     * porte sans producteur de ce chantier. L autorisation se fait en DEUX gestes, rattacher puis
     * activer : la section ne livrait que le second. Or `listOutils` fait une jointure INTERNE sur les
     * consommateurs (delibere : cet ecran montre ce que CET agent utilise), et l import n ecrit aucune
     * ligne de consommateur. Un client declarait son serveur, importait ses outils, ouvrait
     * AI Agent > Outils, et ne voyait RIEN, sans aucun bouton pour en sortir.
     */
    const appels: Appel[] = [];
    const IMPORTE = { ...MCP_MORT, id: 'o9', name: 'notion_search', title: 'Chercher Notion', mcpNonActivable: null };
    // La bibliotheque de l espace le porte, la liste de CET agent non : il est importe, pas rattache.
    await mock(page, appels, [TAG], [IMPORTE]);
    await page.goto(`/agents?id=${AG}&tab=outils`);

    await expect(page.getByTestId('mcp-a-rattacher')).toBeVisible();
    await page.getByTestId('mcp-rattacher-o9').click();
    await expect
      .poll(() => appels.some((a) => /o9\/rattachement$/.test(a.url)
        && (a.body as { valeur?: boolean })?.valeur === true), { timeout: 5000 })
      .toBe(true);
  });
  test('🔴 un outil MCP MORT le DIT, sur l ecran meme ou l on redonne son autorisation', async ({ page }) => {
    /**
     * Le serveur envoyait deja l etat MCP, le type front ne le declarait pas : un outil non activable ou
     * disparu du serveur distant ressemblait exactement a un outil vivant, et le client ne l apprenait
     * qu en cliquant « activer » et en recevant un 409. C est le motif « une capacite cablee sur deux
     * consommateurs sur trois » : la bibliotheque de l espace montrait la pastille, cet ecran-ci non.
     */
    const appels: Appel[] = [];
    await mock(page, appels, [TAG, MCP_MORT]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await expect(page.getByTestId('agent-outils-mcp'), 'la section MCP existe').toBeVisible();
    await expect(page.getByTestId('outil-mcp-mort-o4')).toBeVisible();
    // La RAISON vient du serveur : le client ne peut pas la corriger, mais il doit pouvoir la montrer.
    await expect(page.getByTestId('outil-mcp-mort-o4')).toContainText('lignes');
    // ⚠️ LA PREUVE INVERSE : sans elle, un bandeau affiche en permanence passerait le test.
    await expect(page.getByTestId('outil-mcp-mort-o1')).toHaveCount(0);
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

  test('retirer une action la retire, après confirmation : elle est supprimée avec ses réglages', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    const dialogues: string[] = [];
    let accepter = false;
    page.on('dialog', (d) => { dialogues.push(d.message()); void (accepter ? d.accept() : d.dismiss()); });
    await page.goto(`/agents?id=${AG}&tab=outils`);
    // Refusée : rien ne part.
    await page.getByTestId('outil-retirer-o1').click();
    await expect.poll(() => dialogues.length).toBe(1);
    expect(dialogues[0]).toContain('supprimés');
    expect(appels.some((a) => a.method === 'DELETE')).toBe(false);
    // Acceptée : le retrait part.
    accepter = true;
    await page.getByTestId('outil-retirer-o1').click();
    await expect.poll(() => appels.some((a) => a.method === 'DELETE'), { timeout: 5000 }).toBe(true);
  });
});

test.describe('Agents IA : choisir le bloc que l agent peut envoyer', () => {
  test('🔴 les blocs se COCHENT dans une liste, ils ne se tapent plus en « nod_… »', async ({ page }) => {
    /**
     * Question de Julien, le 2026-09-11 : « comment le user choisit le bloc ? ». Il ne pouvait pas. Le
     * paramètre réclamait des codes « nod_… » qui ne sont écrits nulle part dans la console.
     */
    const appels: Appel[] = [];
    await mock(page, appels, [BLOC]);
    await page.goto(`/agents?id=${AG}&tab=outils`);

    // Le bloc du scénario QUI A un agent est proposé, avec son nom lisible et non son seul code.
    await expect(page.getByTestId('outil-bloc-o2-nod_photo')).toContainText('La photo de la résidence');
    // Un bloc sans nom retombe sur son résumé : une ligne vide ne se choisit pas.
    await expect(page.getByTestId('outil-bloc-o2-nod_form')).toContainText('Formulaire de rappel');

    // 🔴 LES PREUVES INVERSES, sans lesquelles « tout afficher » passerait le test.
    // Une Attente : l'exécuteur la refuse à coup sûr, la proposer promettrait un geste qui échoue toujours.
    await expect(page.getByTestId('outil-bloc-o2-nod_attente')).toHaveCount(0);
    // Un bloc d'un scénario SANS agent : le contact n'y sera jamais quand l'agent tient le fil.
    await expect(page.getByTestId('outil-bloc-o2-nod_autre')).toHaveCount(0);
    await expect(page.getByText('Relances')).toHaveCount(0);

    await page.getByTestId('outil-bloc-o2-nod_photo').click();
    await expect.poll(
      () => appels.some((a) => JSON.stringify((a.body as { enums?: unknown })?.enums ?? {}).includes('nod_photo')),
      { timeout: 5000 },
    ).toBe(true);
  });

  test('🔴 un code enregistré qui n’existe plus reste RETIRABLE', async ({ page }) => {
    // Sinon il resterait invisible sur un outil qui échouerait en silence, sans aucun moyen de le corriger.
    const appels: Appel[] = [];
    const avecFantome = { ...BLOC, params: [{ name: 'code', type: 'string', source: 'modele', required: true, enum: ['nod_disparu'] }] };
    await mock(page, appels, [avecFantome]);
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await expect(page.getByTestId('outil-bloc-inconnu-nod_disparu')).toContainText(/n’existe plus/);
  });
});
