import { test, expect } from '@playwright/test';
import { repondre } from './aide/confirmation';

/**
 * Onglet OUTILS d'un agent IA, présenté comme celui de l'agent de Meta (RC4, décision de Julien du 2026-10-06).
 *
 * Ce qu'on vérifie vraiment ici :
 *  - « Toujours là » : un interrupteur par geste propre à l'agent IA ; allumer POSE l'outil s'il manque puis l'ACTIVE,
 *    éteindre le désactive sans le retirer ;
 *  - « Quel outil ajouter ? » : la grille de l'agent de Meta, ses six cartes, et une CIBLE fixée par l'administrateur
 *    pour le tag, l'information, le bloc et le scénario ; l'outil naît inactif ;
 *  - la liste des outils posés, au format des lignes de l'agent de Meta, connecteurs API et outils MCP compris ;
 *  - ce que l'agent IA a en plus est gardé : l'autonomie d'une action irréversible (un troisième geste), les gestes du
 *    moment, et le schéma RÉEL envoyé au modèle, parce que ce sont les mots du client qui pilotent l'appel de fonction.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AG = '11111111-1111-4111-8111-111111111111';
const WF = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const RQ = '33333333-3333-4333-8333-333333333333';
const SRC = '22222222-2222-4222-8222-222222222222';
const CODE_PHOTO = 'nod_te2e_01HZX5Y6Z7A8B9C0D1E2F3G4H5';

const modele = (handler: string, titre: string, risk: string, params: unknown[] = []) => ({
  handler, nomDefaut: `mba_${handler}`, titre: { fr: titre, en: titre }, description: { fr: `${titre}.`, en: `${titre}.` },
  nePasUtiliser: { fr: 'Pas au hasard.', en: 'Not at random.' }, risk, params,
});
const CATALOGUE = [
  modele('terminer', 'Terminer par une règle d’arrêt', 'read', [{ name: 'sortie', edition: 'derive_des_sorties' }]),
  modele('escalader', 'Passer la main à un humain', 'write'),
  modele('marquer_urgent', 'Marquer la conversation urgente', 'write'),
  modele('chercher_connaissance', 'Chercher dans la base de connaissance', 'read', [{ name: 'requete', edition: 'aucune' }]),
  modele('lire_contact', 'Lire la fiche du contact', 'read'),
  modele('poser_tag', 'Poser un tag sur le contact', 'write'),
  modele('ecrire_variable', 'Enregistrer une information sur le contact', 'write', [{ name: 'valeur', edition: 'aucune' }]),
  modele('envoyer_bloc', 'Envoyer un bloc de votre scénario', 'irreversible'),
  modele('lancer_scenario', 'Lancer un scénario', 'irreversible'),
];

const base = {
  origin: 'mba', sourceId: null, requestId: null, description: 'Marque le contact.', nePasUtiliser: 'Pas de tag inventé.',
  params: [], gestes: [], actif: false, activeLe: null, autonome: false, autonomeLe: null, inappelable: null,
};
const SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: false };
const TAG = {
  ...base, id: 'o1', name: 'tag_rdv', title: 'Tag rendez-vous', binding: { handler: 'poser_tag', tag: 'rdv_pris' }, risk: 'write',
  expose: { name: 'tag_rdv', description: 'Marque le contact.', parameters: SCHEMA },
};
const BLOC = {
  ...base, id: 'o2', name: 'envoyer_photo', title: 'Envoyer la photo', risk: 'irreversible',
  binding: { handler: 'envoyer_bloc', workflowId: WF, code: CODE_PHOTO },
  expose: { name: 'envoyer_photo', description: 'Envoie.', parameters: SCHEMA },
};
/** Actif, mais le modèle n'en voit RIEN : c'est le cas de « terminer » sans règle d'arrêt sur la fiche. */
const MUET = {
  ...base, id: 'o3', name: 'mba_terminer', title: 'Terminer par une règle d’arrêt', binding: { handler: 'terminer' },
  risk: 'read', actif: true, activeLe: '2026-08-28T10:00:00.000Z', expose: null,
};
/**
 * 🔴 UN OUTIL MCP MORT, SUR L'ÉCRAN OÙ LE CLIENT REDONNE SON AUTORISATION : il tient le contrat d'un vrai outil MCP
 * (`binding.outilDistant`, aucun `handler`), sans quoi il masquerait toute logique indexée sur `binding.handler`.
 */
const MCP_MORT = {
  ...base, id: 'o4', origin: 'mcp', sourceId: 's1', name: 'notion_lignes', title: 'Lire les lignes', risk: 'read',
  binding: { outilDistant: 'lignes' },
  expose: { name: 'notion_lignes', description: 'Lire les lignes', parameters: SCHEMA },
  mcpNonActivable: 'le paramètre « lignes » est un tableau', mcpIndisponibleLe: null,
  inappelable: { cause: 'non_activable', detail: 'le paramètre « lignes » est un tableau' },
};

const REQUETE = {
  id: RQ, tenantId: 't-e2e', sourceId: SRC, label: 'Chercher une commande', methode: 'GET', chemin: '/commandes/{ref}',
  parametres: [], entetes: [], corps: { mode: 'aucun' },
  variables: [{ nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true }],
  outputPaths: ['statut'], valeursTest: {}, outils: 0, updatedAt: '2026-09-02T00:00:00.000Z',
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
type Outil = Record<string, unknown> & { id: string };

/**
 * Un serveur EN MÉMOIRE : ce qu'on pose, active, modifie ou retire se relit à la ligne suivante. Sans cet état, un test
 * « l'outil apparaît dans la liste » passerait sur une liste figée, donc ne prouverait rien.
 */
async function mock(page: import('@playwright/test').Page, appels: Appel[], depart: Outil[], offrables: unknown[] = []) {
  const outils: Outil[] = depart.map((o) => ({ ...o }));
  let n = 0;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const corps = (method === 'GET' ? null : req.postDataJSON()) as Record<string, unknown> | null;
    if (method !== 'GET') appels.push({ method, url, body: corps });

    if (/\/tools\/offrables(\?|$)/.test(url)) return json({ outils: offrables });
    if (/\/tools\/connecteur$/.test(url)) {
      const cree: Outil = {
        ...base, id: `n${++n}`, origin: 'http', sourceId: SRC, requestId: RQ, name: String(corps?.name), title: String(corps?.title),
        description: String(corps?.description), nePasUtiliser: String(corps?.nePasUtiliser), binding: {}, risk: 'read',
        nature: corps?.nature, outputPaths: corps?.outputPaths, expose: null,
      };
      outils.push(cree);
      return json({ outil: cree, envoi: [] }, 201);
    }
    const sur = /\/tools\/([^/?]+)(\/[a-z]+)?$/.exec(url);
    if (/\/tools(\?|$)/.test(url)) {
      if (method === 'GET') return json({ outils, catalogue: CATALOGUE });
      // POST : la cible fixée vit dans `binding`, à côté du handler, comme la pose du serveur l'écrit.
      const handler = String(corps?.handler);
      const m = CATALOGUE.find((x) => x.handler === handler)!;
      const cible = (corps?.cible ?? {}) as Record<string, unknown>;
      const cree: Outil = {
        ...base, id: `n${++n}`, name: String(corps?.name ?? m.nomDefaut), title: m.titre.fr, description: m.description.fr,
        binding: { ...cible, handler }, risk: m.risk, expose: { name: String(corps?.name ?? m.nomDefaut), description: '', parameters: SCHEMA },
      };
      outils.push(cree);
      return json({ outil: cree }, 201);
    }
    if (sur && sur[2] === '/rattachement') {
      // Rattacher : l'outil offert entre dans la liste de CET agent, inactif.
      const offert = (offrables as Outil[]).find((x) => x.id === sur[1]);
      if (offert) outils.push({ ...offert, actif: false });
      return json({ rattache: true });
    }
    if (sur) {
      const o = outils.find((x) => x.id === sur[1]);
      if (!o) return json({ error: 'outil introuvable' }, 404);
      if (method === 'DELETE') { outils.splice(outils.indexOf(o), 1); return route.fulfill({ status: 204, body: '' }); }
      if (sur[2] === '/activation') Object.assign(o, { actif: corps?.valeur === true });
      else if (sur[2] === '/autonomie') Object.assign(o, { autonome: corps?.valeur === true });
      else {
        const { cible, ...reste } = corps ?? {};
        Object.assign(o, reste, cible ? { binding: { ...(cible as object), handler: (o.binding as { handler: string }).handler } } : {});
      }
      return json({ outil: o });
    }
    if (/\/mba-outils\/blocs/.test(url)) {
      return json({ blocs: [
        { workflowId: WF, scenario: 'Prise de rendez-vous', code: CODE_PHOTO, nom: 'La photo de la résidence', type: 'template', envoyable: true, raison: null },
        { workflowId: WF, scenario: 'Prise de rendez-vous', code: 'nod_te2e_01HZX5Y6Z7A8B9C0D1E2F3G4H6', nom: 'Un choix', type: 'quick_message', envoyable: false, raison: 'ce bloc attend une réponse du client : utilisez « Lancer un scénario »' },
      ] });
    }
    if (/\/workflows(\?|$)/.test(url)) return json({ workflows: [{ id: WF, name: 'Prise de rendez-vous', nodeCount: 3 }] });
    if (/\/user-fields(\?|$)/.test(url)) return json({ fields: [{ key: 'statut', label: 'Statut', type: 'text' }] });
    if (/\/tags(\?|$)/.test(url)) return json({ tags: [{ tag: 'rdv_pris', count: 3 }] });
    if (url.includes('/agent-requetes')) return json({ requetes: [REQUETE], champs: [], catalogue: { contact: [], systeme: [], entetesReserves: [] } });
    if (url.includes('/agent-sources')) return json({ sources: [{ id: SRC, kind: 'http', label: 'ERP', status: 'active' }] });
    if (new RegExp(`/agents/${AG}$`).test(url)) return json({ agent: AGENT });
    if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [], modele: 'anthropic/claude-haiku-4.5' }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

const onglet = async (page: import('@playwright/test').Page) => {
  await page.goto(`/agents?id=${AG}&tab=outils`);
  await expect(page.getByTestId('outils-toujours-la')).toBeVisible();
};
const postsOutil = (appels: Appel[]) => appels.filter((a) => a.method === 'POST' && /\/tools$/.test(a.url));

test.describe('Agents IA : « Toujours là »', () => {
  test('🔴 allumer « Marquer urgent » le POSE puis l’ACTIVE ; l’éteindre le désactive sans le retirer', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, []);
    await onglet(page);
    // Les cinq gestes propres à l'agent IA sont là, éteints, avant même d'avoir rien posé.
    for (const h of ['terminer', 'escalader', 'chercher_connaissance', 'lire_contact', 'marquer_urgent']) {
      await expect(page.getByTestId(`toujours-${h}`)).not.toBeChecked();
    }

    await page.getByTestId('toujours-marquer_urgent').click();
    await expect.poll(() => appels.map((a) => `${a.method} ${a.url.replace(/^.*\/tools/, '/tools')}`), { timeout: 5000 })
      .toEqual(['POST /tools', 'PUT /tools/n1/activation']);
    expect(postsOutil(appels)[0]!.body).toEqual({ handler: 'marquer_urgent' });
    expect(appels[1]!.body).toEqual({ valeur: true });
    await expect(page.getByTestId('toujours-marquer_urgent')).toBeChecked();

    await page.getByTestId('toujours-marquer_urgent').click();
    await expect.poll(() => appels.at(-1)?.body, { timeout: 5000 }).toEqual({ valeur: false });
    expect(appels.at(-1)!.url).toMatch(/\/tools\/n1\/activation$/);
    // Éteint, pas retiré : aucune suppression, et l'outil garde ses réglages.
    expect(appels.some((a) => a.method === 'DELETE')).toBe(false);
    await expect(page.getByTestId('toujours-marquer_urgent')).not.toBeChecked();
  });

  test('🔴 un « terminer » actif que le modèle ne VOIT PAS est signalé, et « Régler » montre pourquoi', async ({ page }) => {
    await mock(page, [], [MUET]);
    await onglet(page);
    await expect(page.getByTestId('toujours-muet-terminer')).toContainText('le modèle n’en voit rien');
    await page.getByTestId('toujours-regler-terminer').click();
    await page.getByTestId('outil-schema-bouton-o3').click();
    await expect(page.getByTestId('outil-schema-o3')).toContainText('aucune valeur possible');
  });

  test('🔴 le nom vu par le modèle est NORMALISÉ sous les yeux du client', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [MUET]);
    await onglet(page);
    await page.getByTestId('toujours-regler-terminer').click();
    await page.getByTestId('outil-nom-o3').fill('Terminer la conversâtion');
    await expect(page.getByTestId('outil-nom-normalise-o3')).toHaveText('terminer_la_conversation');
    await page.getByTestId('outil-description-o3').click(); // sortie du champ
    await expect.poll(() => appels.some((a) => a.method === 'PATCH' && (a.body as { name?: string })?.name === 'terminer_la_conversation'), { timeout: 5000 }).toBe(true);
  });

  /**
   * 🔴 LES GESTES DU MOMENT, ET LA PHRASE QUI LES ACCOMPAGNE (migration 0158) : l'écran dit qu'ils partent MÊME SI
   * l'appel échoue, sans quoi le client écrit « rendez-vous pris » dans son mini-CRM sur un appel raté.
   */
  test('🔴 on ajoute un geste au moment, et l’écran DIT qu’il part même si l’appel échoue', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [MUET]);
    await onglet(page);
    await page.getByTestId('toujours-regler-terminer').click();
    await expect(page.getByTestId('outil-gestes-o3')).toContainText('même si l’appel ci-dessus échoue');
    await page.getByTestId('outil-geste-valeur-o3').fill('rendez_vous_demande');
    await page.getByTestId('outil-geste-ajouter-o3').click();
    await expect.poll(() => appels.find((a) => a.method === 'PATCH' && (a.body as { gestes?: unknown })?.gestes !== undefined)?.body, { timeout: 5000 })
      .toEqual({ gestes: [{ type: 'tag', valeur: 'rendez_vous_demande' }] });
  });

  test('un geste « écrire dans un champ » porte SON champ, pas seulement une valeur', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [MUET]);
    await onglet(page);
    await page.getByTestId('toujours-regler-terminer').click();
    await page.getByTestId('outil-geste-type-o3').selectOption('variable');
    await page.getByTestId('outil-geste-champ-o3').fill('origine');
    await page.getByTestId('outil-geste-valeur-o3').fill('agent');
    await page.getByTestId('outil-geste-ajouter-o3').click();
    await expect.poll(() => appels.find((a) => a.method === 'PATCH' && (a.body as { gestes?: unknown })?.gestes !== undefined)?.body, { timeout: 5000 })
      .toEqual({ gestes: [{ type: 'variable', champ: 'origine', valeur: 'agent' }] });
  });
});

test.describe('Agents IA : « Quel outil ajouter ? »', () => {
  test('🔴 la grille de l’agent de Meta, ses six cartes, et aucun mot sur l’agent de Meta', async ({ page }) => {
    await mock(page, [], []);
    await onglet(page);
    await page.getByTestId('agent-outils-ajouter').click();
    for (const type of ['tag', 'champ', 'bloc', 'scenario', 'connecteur', 'mcp']) {
      await expect(page.getByTestId(`mba-type-${type}`)).toBeVisible();
    }
    await expect(page.getByTestId('mba-types')).not.toContainText('agent de Meta');
    await expect(page.getByTestId('mba-type-scenario')).toContainText('l’agent se retire');
  });

  test('🔴 poser un tag FIXE par la grille : il part avec sa cible, naît inactif, et entre dans la liste', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, []);
    await onglet(page);
    await page.getByTestId('agent-outils-ajouter').click();
    await page.getByTestId('mba-type-tag').click();
    await page.getByTestId('mba-cible-tag').fill('rdv_pris');
    // La note sur les automations décrit l'agent de Meta : elle ne vaut pas pour un agent IA.
    await expect(page.getByTestId('mba-cible-tag-note')).toHaveCount(0);
    await page.getByTestId('agent-outil-form-titre').fill('Rendez-vous demandé');
    await expect(page.getByTestId('agent-outil-form-nom')).toHaveValue('rendez_vous_demande');
    await expect(page.getByTestId('agent-outil-form-enregistrer')).toBeDisabled();
    await page.getByTestId('agent-outil-form-quand').fill('Appelle cet outil dès que le contact demande un rendez-vous.');
    await page.getByTestId('agent-outil-form-enregistrer').click();

    await expect.poll(() => postsOutil(appels).map((a) => a.body), { timeout: 5000 })
      .toEqual([{ handler: 'poser_tag', name: 'rendez_vous_demande', cible: { tag: 'rdv_pris' } }]);
    await expect.poll(() => appels.find((a) => a.method === 'PATCH')?.body).toMatchObject({
      title: 'Rendez-vous demandé', description: 'Appelle cet outil dès que le contact demande un rendez-vous.',
    });
    // Né inactif : l'activation reste un geste séparé.
    expect(appels.some((a) => /activation$/.test(a.url))).toBe(false);
    await expect(page.getByTestId('outil-cible-n1')).toHaveText('Tag : rdv_pris');
    await expect(page.getByTestId('outil-etat-n1')).toContainText('inactif');
  });

  test('🔴 poser « Lancer un scénario » : le scénario FIXÉ, l’agent qui se retire, et l’autonomie demandée', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, []);
    await onglet(page);
    await page.getByTestId('agent-outils-ajouter').click();
    await page.getByTestId('mba-type-scenario').click();
    await page.getByTestId('mba-cible-scenario').selectOption(WF);
    await expect(page.getByTestId('mba-cible-scenario-note')).toContainText('l’agent se retire');
    // Le titre suit le scénario choisi.
    await expect(page.getByTestId('agent-outil-form-titre')).toHaveValue('Prise de rendez-vous');
    await page.getByTestId('agent-outil-form-quand').fill('Appelle cet outil dès que le contact veut prendre rendez-vous.');
    await page.getByTestId('agent-outil-form-autonomie').getByRole('checkbox').check();
    await page.getByTestId('agent-outil-form-enregistrer').click();

    await expect.poll(() => postsOutil(appels).map((a) => a.body), { timeout: 5000 })
      .toEqual([{ handler: 'lancer_scenario', name: 'prise_de_rendez_vous', cible: { workflowId: WF } }]);
    await expect.poll(() => appels.find((a) => /\/autonomie$/.test(a.url))?.body).toEqual({ valeur: true });
    await expect(page.getByTestId('outil-cible-n1')).toHaveText('Scénario : Prise de rendez-vous');
  });

  test('🔴 « Envoyer un bloc » : le scénario, puis UN bloc de ce scénario, qui part seul', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, []);
    await onglet(page);
    await page.getByTestId('agent-outils-ajouter').click();
    await page.getByTestId('mba-type-bloc').click();
    await page.getByTestId('mba-cible-bloc-scenario').selectOption(WF);
    // Un bloc qui attend une réponse ne part pas seul : grisé, avec sa raison.
    await expect(page.getByTestId('mba-cible-bloc-nod_te2e_01HZX5Y6Z7A8B9C0D1E2F3G4H6')).toBeDisabled();
    await page.getByTestId(`mba-cible-bloc-${CODE_PHOTO}`).check();
    await expect(page.getByTestId('agent-outil-form-titre')).toHaveValue('La photo de la résidence');
    await page.getByTestId('agent-outil-form-quand').fill('Appelle cet outil dès que le contact veut voir la résidence.');
    await page.getByTestId('agent-outil-form-enregistrer').click();
    await expect.poll(() => postsOutil(appels).map((a) => a.body), { timeout: 5000 })
      .toEqual([{ handler: 'envoyer_bloc', name: 'la_photo_de_la_residence', cible: { workflowId: WF, code: CODE_PHOTO } }]);
    await expect(page.getByTestId('outil-cible-n1')).toHaveText('Bloc « La photo de la résidence » du scénario Prise de rendez-vous');
  });

  test('🔴 un connecteur API ajouté par sa carte apparaît dans la liste, comme les autres outils', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, []);
    await onglet(page);
    await page.getByTestId('agent-outils-ajouter').click();
    await page.getByTestId('mba-type-connecteur').click();
    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();
    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire une commande');
    await page.getByTestId('outil-description').fill('Quand le client demande où en est sa commande.');
    await page.getByTestId('outil-nepasutiliser').fill('Jamais pour annuler.');
    await page.getByTestId('outil-creer').click();
    await expect.poll(() => appels.some((a) => /\/tools\/connecteur$/.test(a.url)), { timeout: 5000 }).toBe(true);
    await expect(page.getByTestId('outil-type-n1')).toContainText('Connecteur API');
    await expect(page.getByTestId('outil-cible-n1')).toHaveText('Appel : Chercher une commande');
    // La section « Vos systèmes » a disparu en tant que section : le panneau de choix s'est refermé.
    await expect(page.getByTestId('agent-choix-appel')).toHaveCount(0);
  });

  test('🔴 un outil MCP importé mais PAS ENCORE donné est proposé par sa carte, et le clic le rattache', async ({ page }) => {
    const appels: Appel[] = [];
    const IMPORTE = { ...MCP_MORT, id: 'o9', name: 'notion_search', title: 'Chercher Notion', mcpNonActivable: null, inappelable: null };
    await mock(page, appels, [TAG], [IMPORTE]);
    await onglet(page);
    await page.getByTestId('agent-outils-ajouter').click();
    await page.getByTestId('mba-type-mcp').click();
    await expect(page.getByTestId('mcp-a-rattacher')).toBeVisible();
    await page.getByTestId('mcp-rattacher-o9').click();
    await expect.poll(() => appels.some((a) => /o9\/rattachement$/.test(a.url) && (a.body as { valeur?: boolean })?.valeur === true), { timeout: 5000 }).toBe(true);
    await expect(page.getByTestId('outil-type-o9')).toContainText('MCP');
  });

  test('🔴 la carte MCP montre CE QUE LE SERVEUR OFFRE, sans refiltrer (règle unique du 2026-10-02)', async ({ page }) => {
    const appels: Appel[] = [];
    const OFFERT = { ...MCP_MORT, id: 'o8', name: 'notion_offert', title: 'Offert par le serveur', mcpNonActivable: null, mcpPropose: false, inappelable: null };
    await mock(page, appels, [TAG], [OFFERT]);
    await onglet(page);
    await page.getByTestId('agent-outils-ajouter').click();
    await page.getByTestId('mba-type-mcp').click();
    await expect(page.getByTestId('mcp-rattacher-o8')).toBeVisible();
    // Montrer ne rattache rien.
    expect(appels).toEqual([]);
  });
});

test.describe('Agents IA : la liste des outils posés', () => {
  test('l’activation d’une ligne est un aller-retour, et le geste porte sur cet outil', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await onglet(page);
    await expect(page.getByTestId('outil-cible-o1')).toHaveText('Tag : rdv_pris');
    await page.getByTestId('outil-activer-o1').click();
    await expect.poll(() => appels.some((a) => /o1\/activation$/.test(a.url) && (a.body as { valeur?: boolean })?.valeur === true), { timeout: 5000 }).toBe(true);
  });

  test('🔴 un outil MCP MORT le DIT sur sa ligne, et ne s’active pas', async ({ page }) => {
    await mock(page, [], [TAG, MCP_MORT]);
    await onglet(page);
    await expect(page.getByTestId('outil-mort-o4')).toContainText('lignes');
    await expect(page.getByTestId('outil-activer-o4')).toBeDisabled();
    // ⚠️ LA PREUVE INVERSE : sans elle, un bandeau affiché en permanence passerait le test.
    await expect(page.getByTestId('outil-mort-o1')).toHaveCount(0);
    await expect(page.getByTestId('outil-activer-o1')).toBeEnabled();
  });

  test('🔴 un outil dont le SERVEUR est éteint le dit', async ({ page }) => {
    const ETEINT = { ...MCP_MORT, id: 'o5', mcpNonActivable: null, inappelable: { cause: 'source_inactive' } };
    await mock(page, [], [TAG, ETEINT]);
    await onglet(page);
    await expect(page.getByTestId('outil-mort-o5')).toContainText('Connecteurs MCP');
    await expect(page.getByTestId('outil-activer-o5')).toBeDisabled();
  });

  test('🔴 l’autonomie n’est proposée QUE sur une action irréversible, et son absence se DIT sur la ligne', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG, BLOC]);
    await onglet(page);
    // Sans autonomie, le tronc commun refuse chaque appel : la ligne le dit, sans attendre qu'on l'ouvre.
    await expect(page.getByTestId('outil-sans-autonomie-o2')).toBeVisible();
    await expect(page.getByTestId('outil-sans-autonomie-o1')).toHaveCount(0);

    await page.getByTestId('outil-modifier-o1').click();
    await expect(page.getByTestId('agent-outil-form')).toBeVisible();
    await expect(page.getByTestId('outil-autonomie-o1')).toHaveCount(0);
    await page.getByTestId('outil-modifier-o2').click();
    await page.getByTestId('outil-autonomie-o2').getByRole('checkbox').click();
    await expect.poll(() => appels.some((a) => /o2\/autonomie$/.test(a.url) && (a.body as { valeur?: boolean })?.valeur === true), { timeout: 5000 }).toBe(true);
  });

  test('🔴 « Modifier » rouvre le formulaire PRÉ-REMPLI, et la cible changée part sous le handler de l’outil', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await onglet(page);
    await page.getByTestId('outil-modifier-o1').click();
    await expect(page.getByTestId('mba-cible-tag')).toHaveValue('rdv_pris');
    await expect(page.getByTestId('agent-outil-form-titre')).toHaveValue('Tag rendez-vous');
    await page.getByTestId('mba-cible-tag').fill('rdv_confirme');
    await page.getByTestId('agent-outil-form-enregistrer').click();
    await expect.poll(() => appels.find((a) => a.method === 'PATCH')?.body, { timeout: 5000 }).toEqual({
      title: 'Tag rendez-vous', description: 'Marque le contact.', nePasUtiliser: 'Pas de tag inventé.', cible: { tag: 'rdv_confirme' },
    });
    await expect(page.getByTestId('outil-cible-o1')).toHaveText('Tag : rdv_confirme');
  });

  test('le schéma réellement envoyé au modèle est consultable', async ({ page }) => {
    await mock(page, [], [TAG]);
    await onglet(page);
    await page.getByTestId('outil-modifier-o1').click();
    await page.getByTestId('outil-schema-bouton-o1').click();
    await expect(page.getByTestId('outil-schema-o1')).toContainText('"additionalProperties": false');
  });

  test('retirer un outil le retire, après confirmation', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels, [TAG]);
    await onglet(page);
    // Refusée : rien ne part.
    await page.getByTestId('outil-retirer-o1').click();
    await repondre(page, false, 'supprimés');
    expect(appels.some((a) => a.method === 'DELETE')).toBe(false);
    // Acceptée : le retrait part, et la ligne s'en va.
    await page.getByTestId('outil-retirer-o1').click();
    await repondre(page, true);
    await expect.poll(() => appels.some((a) => a.method === 'DELETE'), { timeout: 5000 }).toBe(true);
    await expect(page.getByTestId('outil-ligne-o1')).toHaveCount(0);
    await expect(page.getByTestId('outils-vide')).toBeVisible();
  });
});
