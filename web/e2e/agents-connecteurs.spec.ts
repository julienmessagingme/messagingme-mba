import { test, expect } from '@playwright/test';

/**
 * BRANCHER LE SYSTÈME DU CLIENT (lot L2), en DEUX endroits, et c'est le sujet :
 *  - la BIBLIOTHÈQUE du workspace vit dans **Tools > Connecteurs API** (`/connecteurs`) : l'adresse,
 *    l'authentification, le secret, l'épreuve. Un système appartient au client, plusieurs agents tapent dedans ;
 *  - un AGENT n'y déclare que les APPELS qu'il a le droit de faire, avec ses mots à lui.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT VOIT ICI :
 *  - la section des connecteurs est SÉPARÉE du catalogue maison (le client ne doit pas confondre ce qu'on
 *    garantit et ce qu'il branche lui-même) ;
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

async function mock(page: import('@playwright/test').Page, capture: { posts: Array<{ url: string; body: unknown }> }, over: { sources?: unknown[]; outils?: unknown[]; epreuve?: unknown; requetes?: unknown[] } = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' || req.method() === 'PATCH' || req.method() === 'DELETE') {
      capture.posts.push({ url, body: req.postDataJSON() ?? null });
      if (url.includes('/epreuve')) return json(over.epreuve ?? { ok: true, httpStatus: 200 });
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
    if (url.includes('/agent-requetes')) return json({ requetes: over.requetes ?? [REQUETE], champs: ['ville'], catalogue: { contact: ['wa_id', 'nom'], systeme: ['derniere_saisie', 'maintenant'], entetesReserves: ['authorization'] } });
    if (url.includes('/agent-sources')) return json({ sources: over.sources ?? [SOURCE] });
    if (/\/agents\/[^/]+\/tools$/.test(url)) return json({ outils: over.outils ?? [], catalogue: [] });
    if (/\/agents\/[^/]+$/.test(url)) return json({ agent: AGENT });
    if (url.endsWith('/agents')) return json({ agents: [{ id: AG, label: 'Support', status: 'draft' }] });
    if (url.includes('/agents/solde')) return json({ soldeMicroEur: 10_000_000 });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.includes('/settings')) return json({ mbaEnabled: false, rcsEnabled: false, hubspotListsEnabled: false, campaignsPaused: false });
    return json({});
  });
}

/** La BIBLIOTHÈQUE, dans le menu Tools. C'est là que se déclare un système. */
async function bibliotheque(page: import('@playwright/test').Page) {
  await page.goto('/connecteurs');
  await expect(page.getByTestId('source-creer')).toBeVisible();
}

/** L'onglet Outils d'un agent. Il ne déclare AUCUN système : il puise dans la bibliothèque. */
async function ongletOutils(page: import('@playwright/test').Page) {
  await page.goto(`/agents?id=${AG}&tab=outils`);
  await expect(page.getByTestId(`agent-requete-${RQ}`).or(page.getByTestId('connecteurs-aucune-requete'))).toBeVisible();
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
    await expect(page.getByTestId(`source-secret-${SRC}`)).toHaveValue('');
  });

  test('🔴 l’épreuve dit ce qui s’est passé, y compris quand elle ÉCHOUE', async ({ page }) => {
    // Un jeton expiré ne produit aucune erreur applicative : sans cet écran, l'agent dégraderait en silence
    // au milieu d'une conversation.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture, { epreuve: { ok: false, httpStatus: 401, erreur: 'authentification refusée' } });
    await bibliotheque(page);
    await page.getByTestId(`source-eprouver-${SRC}`).click();
    await expect(page.getByTestId(`source-epreuve-${SRC}`)).toContainText(/authentification/i);
  });

  test('🔴 brancher un appel : on ne saisit QUE les mots, et il naît INACTIF', async ({ page }) => {
    // L appel n est plus decrit ici : la methode, le chemin, le corps et les variables viennent de la
    // bibliotheque. Redecrire l appel par agent obligeait a le corriger partout, ou nulle part.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);

    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();
    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire une commande');
    await page.getByTestId('outil-description').fill('Quand le client demande ou en est sa commande.');
    await page.getByTestId('outil-nepasutiliser').fill('Jamais pour annuler.');
    await page.getByTestId('envoi-confirme').check();
    await page.getByTestId('outil-creer').click();

    await expect.poll(() => capture.posts.some((p) => p.url.includes('/tools/connecteur'))).toBe(true);
    const envoi = capture.posts.find((p) => p.url.includes('/tools/connecteur'))!;
    expect(envoi.body).toMatchObject({ requeteId: RQ, name: 'lire_commande', title: 'Lire une commande' });
    // Ni methode, ni chemin, ni champs a lire : ils ne sont plus du ressort de l agent.
    expect(envoi.body).not.toHaveProperty('methode');
    expect(envoi.body).not.toHaveProperty('outputPaths');
  });

  test('🔴 l’ecran DIT ce qui partira, et la confirmation est BLOQUANTE', async ({ page }) => {
    // Julien : « il faut bien faire confirmer au client, on envoie telle et telle valeur ». C est le seul
    // moment ou il peut s apercevoir qu un appel enverra le dernier message de ses contacts a un tiers.
    // Sans le caractere bloquant, le resume ne serait qu une decoration qu on survole.
    const capture = { posts: [] as Array<{ url: string; body: unknown }> };
    await mock(page, capture);
    await ongletOutils(page);
    await page.getByTestId(`requete-nouvel-outil-${RQ}`).click();

    const resume = page.getByTestId('envoi-resume');
    await expect(resume).toContainText('ref');
    await expect(resume).toContainText(/décidée par l’agent|decided by the agent/);
    await expect(resume).toContainText(/dernier message du contact|contact’s last message/);
    // Et ce qu il lira en retour, qui est l autre moitie de la question.
    await expect(resume).toContainText('statut');

    await page.getByTestId('outil-nom').fill('lire_commande');
    await page.getByTestId('outil-titre').fill('Lire');
    await page.getByTestId('outil-description').fill('d');
    await page.getByTestId('outil-nepasutiliser').fill('n');
    // Tout est rempli, mais la case n est pas cochee : le bouton reste inactif.
    await expect(page.getByTestId('outil-creer')).toBeDisabled();
    await page.getByTestId('envoi-confirme').check();
    await expect(page.getByTestId('outil-creer')).toBeEnabled();
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
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await expect(page.getByTestId('connecteurs-aucune-requete')).toBeVisible();
    // Et le formulaire de declaration d un systeme n est PAS sur cette page.
    await expect(page.getByTestId('source-creer')).toHaveCount(0);
  });
});
