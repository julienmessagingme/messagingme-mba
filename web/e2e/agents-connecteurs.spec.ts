import { test, expect } from '@playwright/test';

/**
 * BRANCHER LE SYSTÈME DU CLIENT (lot L2), en DEUX endroits, et c'est le sujet :
 *  - la BIBLIOTHÈQUE du workspace vit dans **Tools > Connecteurs API** (`/connecteurs`) : l'adresse,
 *    l'authentification, le secret, l'épreuve. Un système appartient au client, plusieurs agents tapent dedans ;
 *  - un AGENT n'y déclare que les APPELS qu'il a le droit de faire, avec ses mots à lui.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT VOIT ICI :
 *  - un appel se donne à l'agent par la carte « Appeler un connecteur API », et son outil entre dans la liste des
 *    outils de l'agent comme les autres (RC4 : la section « Vos systèmes » a disparu) ;
 *  - le secret saisi part au serveur mais n'est JAMAIS réaffiché ;
 *  - l'outil déclaré porte son gabarit, ses champs de sortie et le fait qu'il naît INACTIF ;
 *  - l'épreuve rend un verdict lisible, y compris quand elle échoue.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AG = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';

const SOURCE = {
  id: SRC, kind: 'http', label: 'ERP', baseUrl: 'https://api.client.fr/v1',
  authKind: 'bearer', authHeaderName: null, aAuthentification: true,
  status: 'active', lastOkAt: null, lastError: null, outilsActifs: 0, agents: 0,
};

const RQ = '33333333-3333-4333-8333-333333333333';
/**
 * Une REQUETE de la bibliotheque (migration 0105). Ses variables couvrent DEUX origines, parce que c est
 * exactement ce que l ecran doit rendre lisible avant de valider : ce que l agent decide, et ce que la
 * plateforme envoie sans qu il ait son mot a dire.
 */
const REQUETE = {
  id: RQ, tenantId: 't-e2e', sourceId: SRC, label: 'Chercher une commande',
  methode: 'GET', chemin: '/commandes/{ref}',
  parametres: [], entetes: [], corps: { mode: 'aucun' },
  variables: [
    { nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true },
    { nom: 'dit', type: 'string', origine: { type: 'systeme', cle: 'derniere_saisie' } },
  ],
  outputPaths: ['statut', 'livraison.date'], valeursTest: {}, outils: 0,
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const AGENT = {
  id: AG, label: 'Support', status: 'draft', mentionIa: 'Vous échangez avec un assistant automatique.',
  modele: 'zai/glm-4.7-flash', ficheVersion: 1,
  contenu: { nom: '', objectif: 'Aider', ton: '', personnalite: '', reglesTransfert: '', sorties: [] },
  plafonds: { maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000 },
  inactiviteMinutes: 30, contactInconnu: 'lecture_seule',
};

async function mock(page: import('@playwright/test').Page, capture: { posts: Array<{ url: string; body: unknown; method?: string }> }, over: { sources?: unknown[]; outils?: unknown[]; epreuve?: unknown; requetes?: unknown[]; refus?: { methode: string; status: number; error: string }; manquesJusquaActivation?: boolean } = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // PUT aussi : c'est la méthode de l'ACTIVATION d'un outil, qu'on doit voir partir.
    if (req.method() === 'POST' || req.method() === 'PATCH' || req.method() === 'PUT' || req.method() === 'DELETE') {
      capture.posts.push({ url, body: req.postDataJSON() ?? null, method: req.method() });
      // Un refus, tel que la route le rend (un nom déjà pris : 409, `NomOutilDejaPris` ; un nom invalide : 400).
      if (over.refus && req.method() === over.refus.methode) {
        return route.fulfill({ status: over.refus.status, contentType: 'application/json', body: JSON.stringify({ error: over.refus.error }) });
      }
      if (url.includes('/epreuve')) return json(over.epreuve ?? { ok: true, httpStatus: 200 });
      // L ESSAI depuis l ecran de l agent (migration 0150) : il rend les chemins REELLEMENT trouves dans la
      // reponse du systeme du client, que l on coche ensuite. Meme route que le bouton Essayer des
      // connecteurs, parce que c est le meme geste.
      if (url.includes('/agent-requetes/test')) {
        return json({
          ok: true, httpStatus: 200, dureeMs: 12,
          envoye: { url: 'https://api.client.fr/v1/commandes/CMD-1', methode: 'GET', corps: null },
          apercu: '{"statut":"expediee","lignes":[1,2]}',
          chemins: ['statut', 'lignes'],
          risqueMinimum: 'read',
        });
      }
      if (url.includes('/agent-sources')) {
        // La source créée entre dans la liste : c'est ce qui permet de vérifier qu'à la relecture, le champ
        // du secret est VIDE. Le serveur ne le renvoie jamais.
        (over.sources as unknown[] | undefined)?.push(SOURCE);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ source: SOURCE }) });
      }
      if (url.includes('/tools/connecteur')) {
        // La reponse porte AUSSI `envoi` : ce qui partira, en francais, pour que l ecran le fasse confirmer.
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
          outil: { id: 'o9', origin: 'http', sourceId: SRC, requestId: RQ, name: 'lire_commande', title: 'Lire', description: 'd', nePasUtiliser: 'n', params: [], binding: {}, risk: 'read', actif: false, activeLe: null, autonome: false, autonomeLe: null, expose: null },
          envoi: [{ nom: 'ref', libelle: 'decidee par l agent' }, { nom: 'dit', libelle: 'dernier message du contact' }],
        }) });
      }
      return json({ ok: true });
    }
    // Ce qui manque à la fiche, relu par la page après chaque geste du panneau Outils. Le serveur dit la vérité du
    // moment : tant qu'aucune activation n'est partie, « Aucun outil actif ».
    if (/\/manques$/.test(url)) {
      const active = capture.posts.some((p) => /\/activation$/.test(p.url));
      return json({
        manques: over.manquesJusquaActivation && !active
          ? [{ onglet: 'outils', message: 'Aucun outil actif : l’agent peut parler mais ne peut rien faire, pas même terminer.' }]
          : [],
        avertissements: [],
      });
    }
    if (url.includes('/agent-requetes')) return json({ requetes: over.requetes ?? [REQUETE], champs: ['ville'], catalogue: { contact: ['wa_id', 'nom'], systeme: ['derniere_saisie', 'maintenant'], entetesReserves: ['authorization'] } });
    if (url.includes('/agent-sources')) return json({ sources: over.sources ?? [SOURCE] });
    if (/\/agents\/[^/]+\/tools$/.test(url)) return json({ outils: over.outils ?? [], catalogue: [] });
    if (/\/agents\/[^/]+$/.test(url)) return json({ agent: AGENT });
    if (url.endsWith('/agents')) return json({ agents: [{ id: AG, label: 'Support', status: 'draft', modele: 'anthropic/claude-haiku-4.5' }] });
    if (url.includes('/agents/solde')) return json({ soldeMicroEur: 10_000_000 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    return json({});
  });
}

/** La BIBLIOTHÈQUE, dans le menu Tools. C'est là que se déclare un système. */
async function bibliotheque(page: import('@playwright/test').Page) {
  await page.goto('/connecteurs');
  // ⚠️ LE FORMULAIRE EST REPLIÉ : l'écran s'ouvre sur la LISTE des systèmes, et « brancher un système » est
  // un bouton. Déplié en permanence, il séparait les systèmes de leurs appels et faisait croire qu'il fallait
  // le remplir pour continuer.
  await page.getByTestId('source-ajouter').click();
  await expect(page.getByTestId('source-creer')).toBeVisible();
}

/**
 * DÉPLIER un système de la liste : c'est là que vivent l'épreuve, le secret et ses appels.
 *
 * ⚠️ L'écran montrait tout, tout le temps. Il montre maintenant la liste, et on ouvre ce qu'on vient
 * travailler : un client fait le même geste.
 */
async function deplier(page: import('@playwright/test').Page, id: string) {
  await page.getByTestId(`source-ligne-${id}`).click();
}

/** L'onglet Outils d'un agent. Il ne déclare AUCUN système : il puise dans la bibliothèque. */
async function ongletOutils(page: import('@playwright/test').Page) {
  await page.goto(`/agents?id=${AG}&tab=outils`);
  await expect(page.getByTestId('outils-poses')).toBeVisible();
}

/**
 * RC4 : un appel se donne à l'agent par la carte « Appeler un connecteur API » de « Quel outil ajouter ? », comme chez
 * l'agent de Meta. La section « Vos systèmes » a disparu : ses appels sont dans ce panneau, ses outils dans la liste.
 */
async function choixAppel(page: import('@playwright/test').Page) {
  await page.getByTestId('agent-outils-ajouter').click();
  await page.getByTestId('mba-type-connecteur').click();
  await expect(page.getByTestId(`agent-requete-${RQ}`)).toBeVisible();
}

test.describe('Agent : brancher le système du client', () => {
  test('🔴 déclare une source, et le secret ne revient JAMAIS à l’écran', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { sources: [] });
    await bibliotheque(page);

    await page.getByTestId('source-label').fill('ERP');
    await page.getByTestId('source-url').fill('https://api.client.fr/v1');
    await page.getByTestId('source-secret').fill('jeton-tres-secret');
    await page.getByTestId('source-creer').click();

    await expect.poll(() => capture.posts.some((p) => p.url.includes('/agent-sources'))).toBe(true);
    const envoi = capture.posts.find((p) => p.url.includes('/agent-sources'))!;
    expect(envoi.body).toMatchObject({ label: 'ERP', baseUrl: 'https://api.client.fr/v1', authKind: 'bearer', authSecret: 'jeton-tres-secret' });
    // La source relue ne porte pas le secret : l'écran ne peut donc pas le réafficher.
    await deplier(page, SRC);
    await expect(page.getByTestId(`source-secret-${SRC}`)).toHaveValue('');
    /**
     * 🔴 ET L'ÉCRAN DIT POURQUOI IL EST VIDE (Julien, 2026-09-24 : « le bouton Remplacer est tout le temps
     * grisé, c'est donc pas clair »). Le bouton n'a jamais été bloqué, sa seule condition est un champ non
     * vide. Ce qui manquait, c'était de dire que le champ part vide PAR CONSTRUCTION et que le secret
     * enregistré est intact : sans cette phrase, un client conclut qu'il l'a effacé, ou que le remplacement
     * est impossible. Une phrase qu'aucun test ne lit finit par disparaître, comme la ligne du moyen de
     * paiement le 2026-09-23.
     */
    await expect(page.getByTestId(`source-secret-aide-${SRC}`)).toContainText('ne se relit jamais');
  });

  test('🔴 l’ecran DIT la difference entre desactiver et supprimer', async ({ page }) => {
    /**
     * Julien, 2026-09-24 : « la différence entre désactiver et supprimer, je sais pas si ça vaut le coup de
     * garder les 2 notions ». Ils ne se valent pas, mais rien à l'écran ne les distinguait, ce qui est la
     * vraie cause de la question.
     *
     * ⚠️ ET LE MOT « DÉSACTIVER » N'A PAS LE MÊME SENS ICI QUE SUR UN OUTIL : désactiver un OUTIL le retire
     * de la vue du modèle, désactiver un CONNECTEUR laisse l'outil proposé et fait échouer l'appel. C'est cet
     * écart-là que la phrase doit nommer, et c'est lui qu'on tient ici.
     */
    await mock(page, { posts: [] });
    await bibliotheque(page);
    await deplier(page, SRC);
    const phrase = page.getByTestId(`source-deux-gestes-${SRC}`);
    await expect(phrase).toContainText('restent proposés à l’agent');
    await expect(phrase).toContainText('refusé tant qu’un outil actif');
  });

  test('🔴 l’épreuve dit ce qui s’est passé, y compris quand elle ÉCHOUE', async ({ page }) => {
    // Un jeton expiré ne produit aucune erreur applicative : sans cet écran, l'agent dégraderait en silence
    // au milieu d'une conversation.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { epreuve: { ok: false, httpStatus: 401, erreur: 'authentification refusée' } });
    await bibliotheque(page);
    await deplier(page, SRC);
    /**
     * 🔴 CE QU'ELLE ÉPROUVE EST ÉCRIT AVANT MÊME DE CLIQUER (Julien, 2026-09-24 : « à quoi sert Éprouver la
     * connexion, quand on choisit un système déjà branché ? »). La question venait de l'écran, qui offrait un
     * bouton sans dire qu'il fait un VRAI appel avec le VRAI en-tête d'authentification : il passait donc
     * pour une revalidation d'adresse, c'est-à-dire pour rien sur un système déjà en service.
     */
    await expect(page.getByTestId(`source-epreuve-a-quoi-${SRC}`)).toContainText('avec votre authentification');
    await page.getByTestId(`source-eprouver-${SRC}`).click();
    await expect(page.getByTestId(`source-epreuve-${SRC}`)).toContainText(/authentification/i);
  });

  test('🔴 brancher un appel : on ne saisit QUE les mots, et il naît INACTIF', async ({ page }) => {
    // L appel n est plus decrit ici : la methode, le chemin, le corps et les variables viennent de la
    // bibliotheque. Redecrire l appel par agent obligeait a le corriger partout, ou nulle part.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);
    await choixAppel(page);

    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();
    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire une commande');
    await page.getByTestId('outil-description').fill('Quand le client demande ou en est sa commande.');
    await page.getByTestId('outil-nepasutiliser').fill('Jamais pour annuler.');
    await page.getByTestId('outil-creer').click();

    await expect.poll(() => capture.posts.some((p) => p.url.includes('/tools/connecteur'))).toBe(true);
    const envoi = capture.posts.find((p) => p.url.includes('/tools/connecteur'))!;
    expect(envoi.body).toMatchObject({ requeteId: RQ, name: 'lire_commande', title: 'Lire une commande' });
    // NI METHODE NI CHEMIN : l appel n est plus decrit ici, il est DESIGNE.
    expect(envoi.body).not.toHaveProperty('methode');
    expect(envoi.body).not.toHaveProperty('chemin');
    /**
     * ⚠️ MAIS `outputPaths` EST BIEN ENVOYE DEPUIS LA MIGRATION 0150, et cette ligne attendait l inverse.
     * Ce que l agent LIT est redevenu du ressort de l agent : c est le sens meme du chantier. Ce qui reste
     * hors de son ressort, c est la DESCRIPTION de l appel, et c est ce que les deux lignes au-dessus gardent.
     * Ici les champs de l appel pre-remplissent, donc on retrouve ceux de la requete.
     */
    expect(envoi.body).toMatchObject({ nature: 'integre', outputPaths: ['statut', 'livraison.date'] });
  });

  test('🔴 l’ecran DIT ce qui partira, sans rien a cocher', async ({ page }) => {
    // Julien : « il faut bien faire confirmer au client, on envoie telle et telle valeur ». C est le seul
    // moment ou il peut s apercevoir qu un appel enverra le dernier message de ses contacts a un tiers.
    // Sans le caractere bloquant, le resume ne serait qu une decoration qu on survole.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);
    await choixAppel(page);
    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();

    const resume = page.getByTestId('envoi-resume');
    await expect(resume).toContainText('ref');
    await expect(resume).toContainText(/décidée par l’agent|decided by the agent/);
    await expect(resume).toContainText(/dernier message du contact|contact’s last message/);
    /**
     * ⚠️ CE QU IL LIRA EN RETOUR A CHANGE DE PLACE (migration 0150), ET LE CAS EST CONSERVE. Le resume le
     * listait en toutes lettres ; c est desormais la SECONDE QUESTION qui le montre, en cases a cocher, parce
     * qu il n est plus une information a lire mais un choix a faire. Le verifier encore dans le resume
     * passerait pour la mauvaise raison : il n y est plus, et c est voulu.
     */
    await expect(page.getByTestId('nature-integre')).toBeChecked();
    await expect(page.getByTestId('outil-champ-statut')).toBeChecked();

    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire');
    await page.getByTestId('outil-description').fill('d');
    await page.getByTestId('outil-nepasutiliser').fill('n');
    /**
     * 🔴 LA CASE DE CONFIRMATION A DISPARU (migration 0150), ET LE CAS EXERCÉ EST CONSERVÉ : quatre champs
     * remplis, et le bouton final. Ce qui change est la RAISON du gris. Julien, 2026-09-15 : « si on rajoute
     * un outil c est qu on est d accord pour l utiliser », la case demandait un consentement acquis par
     * construction. La question posée à la place est un FAIT que seul le client connaît.
     *
     * ⚠️ Le RÉSUMÉ de ce qui part, lui, reste : c est la seule fois où l on voit qu un appel enverra une
     * donnée de ses contacts à un système tiers, et il n a jamais eu besoin d une case pour être lu.
     */
    await expect(page.getByTestId('envoi-confirme')).toHaveCount(0);
    await expect(page.getByTestId('outil-creer')).toBeEnabled();
    await expect(page.getByTestId('outil-creer-manque')).toHaveCount(0);
  });

  test('🔴 « ça pousse » : aucune question de plus, et rien n est lu en retour', async ({ page }) => {
    // Le cas qui etait impossible a brancher : un appel qui agit et ne rend rien d utile.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);
    await choixAppel(page);
    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();
    await page.getByTestId('nature-pousse').check();
    // La seconde question disparait : elle ne se pose que quand on integre.
    await expect(page.getByTestId('outil-champs')).toHaveCount(0);
    await page.getByTestId('outil-nom').fill('poser_etiquette');
    await page.getByTestId('outil-titre').fill('Poser');
    await page.getByTestId('outil-description').fill('pose une etiquette');
    await page.getByTestId('outil-nepasutiliser').fill('jamais pour retirer');
    await page.getByTestId('outil-creer').click();
    const envoi = capture.posts.find((p) => p.url.includes('/connecteur'));
    expect(envoi?.body).toMatchObject({ nature: 'pousse', outputPaths: [] });
  });

  test('🔴 « ça intègre » : on essaie, on coche, et le bouton dit ce qui manque en attendant', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);
    await choixAppel(page);
    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();
    await page.getByTestId('nature-integre').check();
    // Les champs de l APPEL pre-remplissent, ils ne verrouillent pas : on peut tout decocher.
    await page.getByTestId('outil-champ-statut').uncheck();
    await page.getByTestId('outil-champ-livraison.date').uncheck();
    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire');
    await page.getByTestId('outil-description').fill('lit');
    await page.getByTestId('outil-nepasutiliser').fill('jamais');
    await expect(page.getByTestId('outil-creer')).toBeDisabled();
    await expect(page.getByTestId('outil-creer-manque')).toContainText(/au moins une information|at least one piece/);
    // L essai montre ce que le systeme repond VRAIMENT, et on coche la-dedans.
    await page.getByTestId('outil-essayer').click();
    await page.getByTestId('outil-champ-lignes').check();
    await page.getByTestId('outil-creer').click();
    const envoi = capture.posts.find((p) => p.url.includes('/connecteur'));
    expect(envoi?.body).toMatchObject({ nature: 'integre', outputPaths: ['lignes'] });
  });

  test('🔴 un appel sans champ de reponse est pre-repondu « ça pousse », plus refuse', async ({ page }) => {
    /**
     * 🔴 CE TEST ATTENDAIT UN REFUS LE MATIN MEME, ET LE CAS EXERCE EST CONSERVE : une requete qui ne
     * declare aucun champ, ouverte dans l ecran de l agent. Seul le verdict change, parce que la QUESTION a
     * change. « A finir » supposait que tout appel rend quelque chose ; un POST /subscriber/add-tag ne rend
     * rien d utile et n est pas inacheve pour autant. L ecran le pre-repond donc, au lieu de bloquer.
     */
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { requetes: [{ ...REQUETE, outputPaths: [] }] });
    await ongletOutils(page);
    await choixAppel(page);
    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();
    await expect(page.getByTestId('nature-pousse')).toBeChecked();
    await expect(page.getByTestId('outil-champs')).toHaveCount(0);
    // Et il ne reste que les mots a saisir : rien ne bloque.
    await expect(page.getByTestId('outil-creer-manque')).toContainText(/nom technique|technical name/);
  });

  test('🔴 un outil de connecteur inactif s’active depuis SA ligne, sans être recréé', async ({ page }) => {
    /**
     * Le 2026-10-05, sur l'agent Groupama : l'outil naît inactif, et cet écran n'offrait AUCUN moyen de
     * l'activer (le bouton n'existait que pour les outils maison et MCP). Le recréer butait sur son propre
     * nom, « un outil de cet espace porte déjà ce nom », pour un outil que l'on croyait perdu.
     */
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    const outil = (id: string, inappelable: unknown) => ({
      id, origin: 'http', sourceId: SRC, requestId: RQ, name: `outil_${id}`, title: 'Lire', description: 'd', nePasUtiliser: 'n',
      params: [], binding: {}, risk: 'read', actif: false, activeLe: null, autonome: false, autonomeLe: null,
      expose: null, gestes: [], inappelable,
    });
    await mock(page, capture, { outils: [outil('o5', null), outil('o6', { cause: 'source_inactive' })] });
    await ongletOutils(page);
    // L'appel est déjà posé sur cet agent : l'ajout n'est plus proposé, donc plus de doublon possible.
    await choixAppel(page);
    await expect(page.getByTestId(`requete-deja-${RQ}`)).toBeVisible();
    await expect(page.getByTestId(`requete-nouvel-outil-${RQ}`)).toHaveCount(0);
    // RC4 : l'outil de connecteur est une ligne de la liste, comme les autres. Un outil dont le système est éteint ne
    // s'active pas : la ligne dit pourquoi.
    await expect(page.getByTestId('outil-activer-o6')).toBeDisabled();
    await page.getByTestId('outil-activer-o5').click();
    await expect.poll(() => capture.posts.find((p) => p.url.includes('/o5/activation'))?.body ?? null).toEqual({ valeur: true });
  });

  test('🔴 un système s’active depuis la LISTE, sans déplier son détail', async ({ page }) => {
    // Julien, 2026-10-05 : le bouton vivait dans le détail déplié, et un système resté en brouillon
    // empêchait d'activer ses outils sans qu'on sache où l'allumer.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { sources: [{ ...SOURCE, status: 'draft' }] });
    await page.goto('/connecteurs');
    await expect(page.getByTestId(`source-${SRC}`)).toHaveCount(0);
    await page.getByTestId(`source-statut-${SRC}`).click();
    await expect.poll(() => capture.posts.find((p) => p.url.includes(`/agent-sources/${SRC}`))?.body ?? null).toMatchObject({ status: 'active' });
  });

  test('🔴 la bibliothèque dit combien d’AGENTS tapent dans un système', async ({ page }) => {
    // Sans ce chiffre, on croirait le système lié à l'agent d'où on l'a vu, et on le supprimerait en cassant
    // les autres. C'est ce qui rend la bibliothèque partagée lisible.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { sources: [{ ...SOURCE, agents: 2, outilsActifs: 3 }] });
    await page.goto('/connecteurs');
    await expect(page.getByTestId(`source-usage-${SRC}`)).toContainText('2');
    await expect(page.getByTestId(`source-usage-${SRC}`)).toContainText('3');
  });

  test('🔴 un agent ne met au point AUCUN appel : il renvoie vers la bibliothèque', async ({ page }) => {
    // Mettre au point un appel demande de l EPROUVER, ce qui est un geste de workspace. Le proposer dans un
    // agent ferait croire que l appel lui appartient, et il serait redecrit pour chaque agent.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { sources: [], requetes: [] });
    await ongletOutils(page);
    // RC4 : la carte « Appeler un connecteur API » est grisée, et dit où mettre un appel au point.
    await page.getByTestId('agent-outils-ajouter').click();
    await expect(page.getByTestId('mba-type-connecteur')).toBeDisabled();
    await expect(page.getByTestId('mba-type-connecteur-lien')).toHaveAttribute('href', '/connecteurs');
    // Et le formulaire de declaration d un systeme n est PAS sur cette page.
    await expect(page.getByTestId('source-creer')).toHaveCount(0);
  });
});

test.describe('Agent : un appel dont le système est éteint (règle unique du catalogue, 2026-10-02)', () => {
  test('🔴 la ligne de l’appel DIT que son système est éteint ; un appel vivant ne dit rien', async ({ page }) => {
    // L'agent ne voit plus un appel dont le système est éteint : sans cette ligne, la panne était muette.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    const appel = (id: string, name: string, inappelable: unknown) => ({
      id, origin: 'http', sourceId: SRC, requestId: RQ, name, title: name, description: 'd', nePasUtiliser: 'n',
      params: [], binding: {}, risk: 'read', actif: true, activeLe: '2026-10-01T00:00:00.000Z', autonome: false,
      autonomeLe: null, expose: null, gestes: [], inappelable,
    });
    await mock(page, capture, { outils: [appel('o7', 'lire_commande', { cause: 'source_inactive' }), appel('o8', 'lire_stock', null)] });
    await ongletOutils(page);
    await expect(page.getByTestId('outil-mort-o7')).toContainText('Connecteurs API');
    await expect(page.getByTestId('outil-mort-o8')).toHaveCount(0);
  });
});

test.describe('Agent : modifier un appel déjà posé (2026-10-05)', () => {
  /**
   * Julien, le 2026-10-05, sur l'agent Groupama : « je peux pas le modifier, y a pas un bouton pour le
   * modifier ? ». La ligne portait Activer, Désactiver et Retirer : corriger un mot obligeait à retirer l'appel
   * puis à le redonner, ce qui perdait son activation.
   */
  const POSE = {
    id: 'o5', origin: 'http', sourceId: SRC, requestId: RQ, name: 'lire_commande', title: 'Lire une commande',
    description: 'Quand le client demande où en est sa commande.', nePasUtiliser: 'Jamais pour annuler.',
    // `lignes` n'est pas un champ que l'appel déclare : l'essai l'avait trouvé. Il doit se voir quand même.
    nature: 'integre', outputPaths: ['statut', 'lignes'],
    params: [], binding: {}, risk: 'read', actif: true, activeLe: '2026-10-05T00:00:00.000Z', autonome: false,
    autonomeLe: null, expose: null, gestes: [], inappelable: null,
  };
  const corpsDuPatch = (capture: { posts: Array<{ body: unknown; method?: string }> }) =>
    capture.posts.find((p) => p.method === 'PATCH')?.body ?? null;

  test('🔴 Modifier rouvre le formulaire PRÉ-REMPLI par l’outil, et l’enregistre tout entier', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { outils: [POSE] });
    await ongletOutils(page);

    await page.getByTestId('outil-modifier-o5').click();
    await expect(page.getByTestId('outil-nom')).toHaveValue('lire_commande');
    await expect(page.getByTestId('outil-titre')).toHaveValue('Lire une commande');
    await expect(page.getByTestId('outil-description')).toHaveValue('Quand le client demande où en est sa commande.');
    await expect(page.getByTestId('outil-nepasutiliser')).toHaveValue('Jamais pour annuler.');
    // Ce que l'appel FAIT vient de L'OUTIL, pas de l'appel : `livraison.date`, que l'appel propose par défaut, n'est
    // pas coché, et `lignes`, que seul l'outil lit, l'est.
    await expect(page.getByTestId('nature-integre')).toBeChecked();
    await expect(page.getByTestId('nature-integre')).toBeEnabled();
    await expect(page.getByTestId('outil-champ-lignes')).toBeChecked();
    await expect(page.getByTestId('outil-champ-livraison.date')).not.toBeChecked();

    await page.getByTestId('outil-titre').fill('Lire la commande du client');
    await page.getByTestId('outil-champ-statut').uncheck();
    await page.getByTestId('outil-creer').click();
    await expect.poll(() => corpsDuPatch(capture)).toEqual({
      name: 'lire_commande', title: 'Lire la commande du client',
      description: 'Quand le client demande où en est sa commande.', nePasUtiliser: 'Jamais pour annuler.',
      nature: 'integre', outputPaths: ['lignes'],
    });
    expect(capture.posts.find((p) => p.method === 'PATCH')!.url).toMatch(/\/tools\/o5$/);
    // Le même outil, corrigé : rien n'est recréé.
    expect(capture.posts.some((p) => p.url.includes('/tools/connecteur'))).toBe(false);
    await expect(page.getByTestId('outil-nom')).toHaveCount(0);
  });

  test('🔴 un appel qui intègre peut passer en « ça pousse », et ne lit alors plus rien', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { outils: [POSE] });
    await ongletOutils(page);
    await page.getByTestId('outil-modifier-o5').click();
    await page.getByTestId('nature-pousse').check();
    await expect(page.getByTestId('outil-champs')).toHaveCount(0);
    await page.getByTestId('outil-creer').click();
    await expect.poll(() => corpsDuPatch(capture)).toMatchObject({ nature: 'pousse', outputPaths: [] });
  });

  test('🔴 repasser en « intègre » retrouve les champs de L’OUTIL, pas les défauts de l’appel', async ({ page }) => {
    // Sans ça, un champ volontairement exclu (`livraison.date`) revenait coché, et partait chez le fournisseur du
    // modèle si l'on enregistrait sans regarder (relecture du lot 2).
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { outils: [POSE] });
    await ongletOutils(page);
    await page.getByTestId('outil-modifier-o5').click();
    await page.getByTestId('nature-pousse').check();
    await page.getByTestId('nature-integre').check();
    await expect(page.getByTestId('outil-champ-lignes')).toBeChecked();
    await expect(page.getByTestId('outil-champ-livraison.date')).not.toBeChecked();
  });

  test('🔴 un nom déjà pris se lit DANS le formulaire, et la saisie reste', async ({ page }) => {
    // Le refus s'affichait en haut du bloc, loin du champ, et ne disait pas quoi faire.
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { outils: [POSE], refus: { methode: 'PATCH', status: 409, error: 'un outil de cet espace porte déjà ce nom' } });
    await ongletOutils(page);

    await page.getByTestId('outil-modifier-o5').click();
    await page.getByTestId('outil-nom').fill('lire_stock');
    await page.getByTestId('outil-creer').click();
    await expect(page.getByTestId('outil-erreur')).toContainText(/déjà celui d’un autre outil|already used by another tool/);
    await expect(page.getByTestId('outil-nom')).toHaveValue('lire_stock');
  });

  test('un nom invalide est dit dans le formulaire, avec le message du serveur', async ({ page }) => {
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { outils: [POSE], refus: { methode: 'PATCH', status: 400, error: 'champs invalides : name : minuscules, chiffres et tirets bas, 64 au plus' } });
    await ongletOutils(page);
    await page.getByTestId('outil-modifier-o5').click();
    await page.getByTestId('outil-nom').fill('Lire Stock');
    await page.getByTestId('outil-creer').click();
    await expect(page.getByTestId('outil-erreur')).toContainText('minuscules');
    await expect(page.getByTestId('outil-nom')).toHaveValue('Lire Stock');
  });

  test('🔴 un nom déjà pris À L’AJOUT se lit aussi dans le formulaire', async ({ page }) => {
    // Même refus, même endroit : il s'affichait en haut du bloc jusqu'au lot 1.
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { refus: { methode: 'POST', status: 409, error: 'un outil de cet espace porte déjà ce nom' } });
    await ongletOutils(page);
    await choixAppel(page);
    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();
    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire');
    await page.getByTestId('outil-description').fill('lit');
    await page.getByTestId('outil-nepasutiliser').fill('jamais');
    await page.getByTestId('outil-creer').click();
    await expect(page.getByTestId('outil-erreur')).toContainText(/déjà celui d’un autre outil|already used by another tool/);
    await expect(page.getByTestId('outil-nom')).toHaveValue('lire_commande');
  });

  test('🔴 un appel IRRÉVERSIBLE (DELETE) dit sur sa ligne qu’il est refusé, et « Modifier » offre l’autonomie', async ({ page }) => {
    // RC4 : la ligne d'un connecteur ne montrait ni le risque ni la case, et l'outil était refusé à chaque appel sans
    // qu'aucun geste ne permette de l'autoriser.
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { outils: [{ ...POSE, risk: 'irreversible' }] });
    await ongletOutils(page);
    await expect(page.getByTestId('outil-sans-autonomie-o5')).toBeVisible();
    await page.getByTestId('outil-modifier-o5').click();
    await page.getByTestId('outil-autonomie-o5').getByRole('checkbox').click();
    await expect.poll(() => capture.posts.find((p) => p.url.includes('/o5/autonomie'))?.body ?? null).toEqual({ valeur: true });
  });

  test('🔴 activer un appel depuis sa ligne fait partir « Aucun outil actif » sur-le-champ', async ({ page }) => {
    /**
     * Le défaut du bandeau fantôme des outils maison (agents-construction, 2026-09-11), revenu par la ligne neuve
     * de 362dde63 : le panneau des connecteurs rechargeait sa liste sans prévenir la page, et l'en-tête gardait
     * « Aucun outil actif » après l'activation du premier outil.
     */
    const capture = { posts: [] as Array<{ url: string; body: unknown; method?: string }> };
    await mock(page, capture, { outils: [{ ...POSE, actif: false, activeLe: null }], manquesJusquaActivation: true });
    await ongletOutils(page);
    await expect(page.getByTestId('entete-etape-outils')).toBeVisible();
    await page.getByTestId('outil-activer-o5').click();
    await expect(page.getByTestId('entete-etape-outils')).toHaveCount(0);
  });
});
