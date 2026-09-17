import { test, expect } from '@playwright/test';

/**
 * Onglet CONSTRUIRE EN PARLANT, et le blocage d'activation qui va avec.
 *
 * Ce qu'on vérifie vraiment ici : l'assistant ne change RIEN tout seul (chaque proposition passe par un diff
 * que le client garde ou jette), et un agent incomplet ne peut pas être activé, avec la LISTE de ce qui
 * manque plutôt qu'un refus sans mode d'emploi.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const AG = '11111111-1111-4111-8111-111111111111';

const FICHE = { nom: '', objectif: 'Aider.', ton: '', personnalite: '', reglesTransfert: '', sorties: [] };
const AGENT = {
  id: AG, label: 'Conseiller séjours', status: 'draft',
  mentionIa: 'Vous échangez avec un assistant automatique.', modele: 'modele-test',
  maxTours: 8, maxAppelsOutils: 12, budgetMicroEur: 30000, inactiviteMinutes: 30,
  contactInconnu: 'lecture_seule', contenu: FICHE, ficheVersion: 4,
};

const PROPOSITION = {
  message: 'Je propose de préciser l’objectif et d’ajouter une règle d’arrêt.',
  proposition: {
    fiche: { objectif: 'Cerner le besoin de séjour puis proposer un rendez-vous.', sorties: [{ code: 'rdv_pris', label: 'Rendez-vous pris' }] },
    outils: [],
  },
  changements: [
    { champ: 'fiche.objectif', label: 'Objectif de l’agent', avant: 'Aider.', apres: 'Cerner le besoin de séjour puis proposer un rendez-vous.' },
    { champ: 'fiche.sorties', label: 'Règles d’arrêt', avant: '', apres: 'rdv_pris : Rendez-vous pris' },
  ],
  usage: { tokensIn: 800, tokensOut: 90 },
};

type Appel = { method: string; url: string; body: unknown };

async function mock(page: import('@playwright/test').Page, appels: Appel[], opts: { setup?: { status: number; body: unknown }; activation?: { status: number; body: unknown }; outilsEnEchec?: boolean; pieceJointe?: unknown; manques?: unknown[]; avertissements?: unknown[] } = {}) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/setup\/piece-jointe$/.test(url)) {
      appels.push({ method, url, body: req.postDataJSON() });
      return json(opts.pieceJointe ?? { fiches: 1, titres: ['Doc'], nature: 'texte' }, 201);
    }
    if (/\/setup$/.test(url)) {
      // Depuis le 2026-08-31 l'entretien est TENU PAR LE SERVEUR : le GET l'hydrate à l'ouverture de
      // l'onglet, le POST envoie UN message, le DELETE recommence. Sans ce GET, l'écran resterait bloqué sur
      // « Chargement… » et rien ne serait cliquable.
      if (method === 'GET') return json({ messages: [], couverture: { manquants: [], total: 9, pointOuvert: null } });
      if (method === 'DELETE') return json({ efface: true, couverture: { manquants: [], total: 9, pointOuvert: null } });
      appels.push({ method, url, body: req.postDataJSON() });
      const r = opts.setup ?? { status: 200, body: PROPOSITION };
      return json(r.body, r.status);
    }
    if (/\/tools/.test(url)) {
      if (method === 'GET') return json({ outils: [], catalogue: [] });
      if (opts.outilsEnEchec) return json({ error: 'un outil de cet agent porte déjà ce nom' }, 409);
      return json({ outil: { id: 'o1' } }, method === 'POST' ? 201 : 200);
    }
    if (/\/knowledge/.test(url)) return json({ fiches: [] });
    // Les manques se LISENT désormais à l'ouverture de la fiche (2026-09-08), sans attendre un refus
    // d'activation : un faux qui ignorerait cette route laisserait l'écran croire qu'il ne manque rien.
    if (/\/manques$/.test(url)) return json({ manques: opts.manques ?? [], avertissements: opts.avertissements ?? [] });
    if (new RegExp(`/agents/${AG}$`).test(url)) {
      if (method === 'DELETE') { appels.push({ method, url, body: null }); return json({ supprime: true }); }
      if (method === 'PATCH') {
        const corps = (req.postDataJSON() ?? {}) as Record<string, unknown>;
        appels.push({ method, url, body: corps });
        if (corps.status === 'active' && opts.activation) return json(opts.activation.body, opts.activation.status);
        return json({ agent: { ...AGENT, ...corps } });
      }
      return json({ agent: AGENT });
    }
    if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [] }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Agents IA : construire en parlant', () => {
  test('🔴 l assistant PROPOSE, et rien ne s écrit avant « Garder »', async ({ page }) => {
    // C'est le seul point de cet écran qui ne se négocie pas. Écrire en silence (ce que fait le GPT Builder)
    // ferait un réglage que personne ne peut relire ni défaire.
    const appels: Appel[] = [];
    await mock(page, appels);
    await page.goto(`/agents?id=${AG}&tab=construction`);

    await expect(page.getByTestId('setup-vide')).toBeVisible();
    await page.getByTestId('setup-saisie').fill('Mon agent qualifie les demandes de séjour.');
    await page.getByTestId('setup-envoyer').click();

    await expect(page.getByTestId('setup-diff')).toBeVisible();
    await expect(page.getByTestId('setup-diff-fiche.objectif')).toContainText('Cerner le besoin de séjour');
    // Le AVANT est montré barré : le client voit ce qu'il perd, pas seulement ce qu'il gagne.
    await expect(page.getByTestId('setup-diff-fiche.objectif')).toContainText('Aider.');
    // Et surtout : AUCUN patch n'est encore parti.
    expect(appels.filter((a) => a.method === 'PATCH')).toHaveLength(0);
  });

  test('« Garder » applique par le PATCH, avec le verrou de version', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels);
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Mon agent qualifie les demandes.');
    await page.getByTestId('setup-envoyer').click();
    await page.getByTestId('setup-garder').click();

    await expect.poll(
      () => appels.some((a) => a.method === 'PATCH' && (a.body as { ficheVersionAttendue?: number })?.ficheVersionAttendue === 4),
      { timeout: 5000 },
    ).toBe(true);
    // Le patch ne porte QUE ce que la proposition mentionne.
    const patch = appels.find((a) => a.method === 'PATCH')!.body as { contenu?: Record<string, unknown> };
    expect(Object.keys(patch.contenu ?? {}).sort()).toEqual(['objectif', 'sorties']);
  });

  test('🔴 TANT QUE LE PÉRIMÈTRE N EST PAS COUVERT, on discute : aucun diff', async ({ page }) => {
    // Julien, 2026-08-28 : « je préfère qu'au début on discute avant d'afficher ce que le bot a compris ».
    // Le serveur retient le diff pendant l'entretien ; l'écran doit le DIRE, sinon il serait simplement muet
    // et le client croirait que l'assistant n'a rien compris à ce qu'il raconte.
    await mock(page, [], {
      setup: { status: 200, body: { ...PROPOSITION, couverture: { manquants: ['bascules', 'humain'], total: 6 } } },
    });
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Mon agent qualifie les demandes de séjour.');
    await page.getByTestId('setup-envoyer').click();

    await expect(page.getByTestId('setup-entretien')).toContainText('2 points');
    await expect(page.getByTestId('setup-diff')).toHaveCount(0);
  });

  test('🔴 on peut n en JETER QU UNE : les autres règles partent quand même', async ({ page }) => {
    // Julien, 2026-08-28 : « il n'y a qu'un seul bouton Garder ou Jeter à la fin, alors que potentiellement le
    // mec ne veut en changer qu'une et le reste lui convient ». Un lot indivisible force à tout refuser pour
    // corriger une ligne, donc à relancer la conversation en espérant que le modèle ne défasse pas le reste.
    const appels: Appel[] = [];
    await mock(page, appels);
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Mon agent qualifie les demandes.');
    await page.getByTestId('setup-envoyer').click();

    await page.getByTestId('setup-bascule-fiche.sorties').click();
    await page.getByTestId('setup-garder').click();

    await expect.poll(() => {
      const patch = appels.find((a) => a.method === 'PATCH')?.body as { contenu?: Record<string, unknown> } | undefined;
      return patch ? Object.keys(patch.contenu ?? {}).sort() : null;
    }, { timeout: 5000 }).toEqual(['objectif']);
  });

  test('🔴 une règle se CORRIGE sur place, et c est le texte du client qui part', async ({ page }) => {
    // L'autre moitié de la même demande : le client ne veut pas toujours jeter, il veut souvent amender.
    const appels: Appel[] = [];
    await mock(page, appels);
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Mon agent qualifie les demandes.');
    await page.getByTestId('setup-envoyer').click();

    await page.getByTestId('setup-texte-fiche.objectif').fill('Cerner le besoin, puis passer la main.');
    await page.getByTestId('setup-garder').click();

    await expect.poll(() => {
      const patch = appels.find((a) => a.method === 'PATCH')?.body as { contenu?: { objectif?: string } } | undefined;
      return patch?.contenu?.objectif ?? null;
    }, { timeout: 5000 }).toBe('Cerner le besoin, puis passer la main.');
  });

  test('« Jeter » n écrit rien et fait disparaître le diff', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, appels);
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Mon agent qualifie les demandes.');
    await page.getByTestId('setup-envoyer').click();
    await page.getByTestId('setup-jeter').click();

    await expect(page.getByTestId('setup-diff')).toHaveCount(0);
    expect(appels.filter((a) => a.method === 'PATCH')).toHaveLength(0);
  });

  test('une proposition sans effet le DIT, au lieu d un bouton qui ne ferait rien', async ({ page }) => {
    await mock(page, [], { setup: { status: 200, body: { ...PROPOSITION, changements: [] } } });
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Rien à changer ?');
    await page.getByTestId('setup-envoyer').click();
    await expect(page.getByTestId('setup-sans-changement')).toBeVisible();
    await expect(page.getByTestId('setup-garder')).toHaveCount(0);
  });

  test('une panne de l assistant est ANNONCÉE, pas avalée', async ({ page }) => {
    await mock(page, [], { setup: { status: 503, body: { error: 'assistant de construction indisponible (aucun modèle configuré)' } } });
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Bonjour');
    await page.getByTestId('setup-envoyer').click();
    await expect(page.getByTestId('setup-erreur')).toContainText('indisponible');
  });

  test('🔴 un échec APRÈS l écriture de la fiche le DIT, au lieu d une erreur muette', async ({ page }) => {
    // Ces écritures ne sont pas dans une transaction : la fiche part par une route, les outils par une autre.
    // Sans ce message, le client réessaierait « Garder » et se ferait refuser en 409 sur un numéro de version
    // périmé, c'est-à-dire une erreur qui ne parle pas du tout de ce qui s'est passé.
    const appels: Appel[] = [];
    await mock(page, appels, {
      setup: {
        status: 200,
        body: {
          ...PROPOSITION,
          proposition: {
            fiche: { objectif: 'Cerner le besoin.' },
            outils: [{ handler: 'poser_tag', description: 'Tague le contact.', nePasUtiliser: 'Pas de tag inventé.' }],
          },
        },
      },
      outilsEnEchec: true,
    });
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Mon agent qualifie les demandes.');
    await page.getByTestId('setup-envoyer').click();
    await page.getByTestId('setup-garder').click();

    await expect(page.getByTestId('setup-erreur')).toContainText('La fiche est enregistrée, mais un outil n’a pas pu l’être');
    // La fiche, elle, est bien partie : le message ne ment pas.
    expect(appels.some((a) => a.method === 'PATCH' && (a.body as { contenu?: unknown })?.contenu !== undefined)).toBe(true);
  });

  test('🔴 un agent incomplet ne s active pas, et l écran DIT ce qui manque', async ({ page }) => {
    // Un refus sans mode d'emploi laisserait le client chercher. Chaque manque est un lien vers l'onglet où
    // il se comble.
    await mock(page, [], {
      activation: {
        status: 422,
        body: {
          error: 'agent incomplet',
          manques: [
            { onglet: 'connaissance', message: 'La base de connaissance est vide : l’agent transférerait toutes les questions de fond.' },
            { onglet: 'outils', message: 'Aucun outil actif : l’agent peut parler mais ne peut rien faire, pas même terminer.' },
          ],
        },
      },
    });
    await page.goto(`/agents?id=${AG}&tab=identite`);
    await page.getByTestId('agent-activer').click();

    await expect(page.getByTestId('agent-manques')).toBeVisible();
    await expect(page.getByTestId('agent-manque-connaissance')).toBeVisible();
    // Le lien mène à l'onglet où ça se corrige.
    await page.getByTestId('agent-manque-outils').click();
    await expect(page).toHaveURL(/tab=outils/);
  });

  test('🔴 un réglage HORS FICHE part vraiment au serveur, même SEUL', async ({ page }) => {
    /**
     * 🔴 LE DÉFAUT TROUVÉ EN REVUE LE 2026-09-11, ET IL ÉTAIT MUET DE BOUT EN BOUT. `appliquerProposition`
     * n'envoyait que `contenu` : l'entretien posait la question, le diff affichait le changement, l'écran
     * disait « C'est enregistré », et RIEN n'atteignait la base. Pire, quand la proposition ne touchait
     * QU'UN réglage hors fiche (le cas le plus probable, puisque l'entretien a un point dédié à chacun),
     * aucun appel ne partait du tout.
     *
     * ⚠️ CE TEST PORTE SUR CE QUI EST ENVOYÉ, pas sur ce qui est calculé. Les trois tests unitaires de
     * `restreindreProposition` passaient déjà : elle calcule bien ces champs. C'est la fonction d'à côté,
     * celle qui ÉCRIT, que personne n'éprouvait. Tester celle qui calcule au lieu de celle qui écrit donne
     * un vert qui ne prouve rien.
     *
     * ⚠️ Et le verrou de version N'ACCOMPAGNE PAS un réglage scalaire : l'envoyer ferait échouer en 409 un
     * réglage qui n'a aucune raison de se heurter à une réécriture de fiche.
     */
    const appels: Appel[] = [];
    await mock(page, appels, {
      setup: {
        status: 200,
        body: {
          message: 'Je propose de laisser deux heures.',
          proposition: { fiche: {}, outils: [], inactiviteMinutes: 120 },
          changements: [{ champ: 'inactiviteMinutes', label: 'Silence du contact : quand l’agent lâche', avant: '30 minutes', apres: '2 heures' }],
          usage: { tokensIn: 100, tokensOut: 20 },
        },
      },
    });
    await page.goto(`/agents?id=${AG}&tab=construction`);
    await page.getByTestId('setup-saisie').fill('Deux heures sans réponse, il lâche.');
    await page.getByTestId('setup-envoyer').click();
    await page.getByTestId('setup-garder').click();

    await expect.poll(() => appels.find((a) => a.method === 'PATCH')?.body, { timeout: 5000 })
      .toEqual({ inactiviteMinutes: 120 });
  });

  test('🔴 activer un outil fait DISPARAÎTRE son avertissement sur-le-champ', async ({ page }) => {
    /**
     * Le bandeau fantôme signalé par Julien le 2026-09-11 : il activait ses outils et « Aucun outil actif »
     * restait à l'écran. Il a fallu quitter l'agent et y revenir pour qu'il parte, ce qui lui a fait croire
     * que l'activation elle-même n'avait pas pris.
     *
     * LA CAUSE : les manques étaient relus après chaque écriture de la FICHE, et le panneau Outils écrit
     * dans SA table, sans passer par là. Un avertissement qui survit au geste qui le règle devient du bruit
     * qu'on apprend à ignorer, et c'est la fin de son utilité.
     */
    await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
    let outilActif = false;
    const manques: string[] = [];
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/activation$/.test(url)) { outilActif = true; return json({ outil: { id: 'o1' } }); }
      if (/\/tools/.test(url)) {
        return json({
          outils: [{
            id: 'o1', origin: 'mba', sourceId: null, name: 'mba_chercher_connaissance',
            title: 'Chercher dans la base de connaissance', description: 'Cherche une réponse dans les fiches.',
            nePasUtiliser: '', params: { type: 'object', properties: {} }, binding: { handler: 'chercher_connaissance' },
            risk: 'lecture', actif: outilActif, activeLe: null, autonome: false, autonomeLe: null, expose: null,
          }],
          catalogue: [],
        });
      }
      if (/\/manques$/.test(url)) {
        manques.push(url);
        // Le serveur dit la vérité du moment : c'est justement ce que l'écran ne redemandait pas.
        return json({ manques: outilActif ? [] : [{ onglet: 'outils', message: 'Aucun outil actif : l’agent peut parler mais ne peut rien faire, pas même terminer.' }] });
      }
      if (/\/setup$/.test(url)) return json({ messages: [], couverture: { manquants: [], total: 9, pointOuvert: null } });
      if (/\/knowledge/.test(url)) return json({ fiches: [] });
      if (new RegExp(`/agents/${AG}$`).test(url)) return json({ agent: AGENT });
      if (/\/agents(\?|$)/.test(url)) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [] }] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto(`/agents?id=${AG}&tab=outils`);
    await expect(page.getByTestId('agent-manques')).toBeVisible();
    const avant = manques.length;

    await page.getByTestId('outil-activer-o1').click();

    // 🔴 SANS QUITTER L'AGENT : c'est tout le défaut. Le bandeau part parce que les manques ont été RELUS.
    await expect(page.getByTestId('agent-manques')).toHaveCount(0, { timeout: 5000 });
    expect(manques.length).toBeGreaterThan(avant);
  });

  test('🔴 ce qui manque s’affiche À L’OUVERTURE, sans avoir cliqué « activer »', async ({ page }) => {
    /**
     * Le défaut vécu par Julien le 2026-09-08 : son agent avait 10 fiches de connaissance et l'outil de
     * recherche DÉSACTIVÉ. Le contrôle existait déjà, mais il ne parlait que dans le corps d'un 422, donc
     * seulement si on cliquait « activer ». Lui essayait son agent dans le bac à sable, où rien ne trouvait
     * rien, et la réponse était calculée et tue.
     */
    await mock(page, [], {
      manques: [{
        onglet: 'outils',
        message: 'La base de connaissance est remplie mais l’outil « Chercher dans la base de connaissance » n’est pas actif : l’agent ne peut pas la lire.',
      }],
    });
    await page.goto(`/agents?id=${AG}&tab=tester`);
    // Aucun clic sur « activer » : le bandeau est là dès l'ouverture, et sur l'onglet où l'on constate le
    // symptôme.
    await expect(page.getByTestId('agent-manques')).toBeVisible();
    await expect(page.getByTestId('agent-manque-outils')).toContainText(/Chercher dans la base/);
  });

  test('🔴 un outil MCP debranche par un rafraichissement apparait, NOMME, dans son propre bandeau', async ({ page }) => {
    /**
     * 🔴 LA PERTE ETAIT MUETTE. Quand le schema d un outil MCP change, son autorisation TOMBE (0127 : elle
     * porte sur un outil PRECIS) ; c est la bonne decision, mais elle se prenait en silence. L agent
     * perdait une capacite que quelqu un avait explicitement autorisee, sans cause visible nulle part.
     *
     * ⚠️ UN BANDEAU A PART, ET LA SEPARATION EST MECANIQUE. Cote serveur, la liste des manques est AUSSI la
     * garde dure de l activation : y verser ce cas donnerait a un serveur TIERS un droit de veto sur
     * l activation de l agent d un client. C est l ecart assume avec l etape 5 du plan, qui prescrivait
     * `agent-manques`.
     */
    await mock(page, [], {
      manques: [],
      avertissements: [{
        onglet: 'outils',
        message: 'L’outil « notion_search » a été désactivé par un rafraîchissement du serveur MCP '
          + '(son schéma a changé, ou il a disparu) : il faut le réautoriser.',
      }],
    });
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await expect(page.getByTestId('agent-avertissements')).toBeVisible();
    await expect(page.getByTestId('agent-avertissement-outils')).toContainText('notion_search');
    // 🔴 IL NE SE DEGUISE PAS EN MANQUE : le bandeau bloquant reste absent, donc l activation reste possible.
    await expect(page.getByTestId('agent-manques')).toHaveCount(0);
  });

  test('sans manque, aucun bandeau : preuve inverse', async ({ page }) => {
    // Sans ce cas, un bandeau affiché en permanence passerait le test ci-dessus.
    await mock(page, [], { manques: [] });
    await page.goto(`/agents?id=${AG}&tab=tester`);
    await expect(page.getByTestId('agent-manques')).toHaveCount(0);
    // Sans ce cas, un bandeau d avertissement affiche en permanence passerait le test ci-dessus.
    await expect(page.getByTestId('agent-avertissements')).toHaveCount(0);
  });

  test('🔴 l entretien est PERSISTANT : on rouvre l onglet et la conversation est là', async ({ page }) => {
    // Julien, 2026-08-31 : « je veux que la conversation qui a été tenue préalablement soit persistante quand
    // on revient plus tard sur l'onglet ». Avant, elle ne vivait que dans l'état du composant : passer par
    // l'inbox et revenir effaçait tout, et le client recommençait un entretien déjà mené.
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const req = route.request();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/setup$/.test(req.url())) {
        return json({
          messages: [
            { role: 'user', content: 'Mon agent qualifie les demandes de séjour.' },
            { role: 'assistant', content: 'De quoi ne doit-il jamais parler ?' },
          ],
          couverture: { manquants: ['perimetre', 'connaissance'], total: 9, pointOuvert: 'perimetre' },
        });
      }
      if (/\/tools/.test(req.url())) return json({ outils: [], catalogue: [] });
      if (/\/knowledge/.test(req.url())) return json({ fiches: [] });
      if (new RegExp(`/agents/${AG}$`).test(req.url())) return json({ agent: AGENT });
      if (/\/agents(\?|$)/.test(req.url())) return json({ agents: [{ id: AG, label: 'Conseiller séjours', status: 'draft', sorties: [] }] });
      return json({});
    });
    await page.goto(`/agents?id=${AG}&tab=construction`);

    await expect(page.getByTestId('setup-tour-user')).toContainText('qualifie les demandes de séjour');
    await expect(page.getByTestId('setup-tour-assistant')).toContainText('jamais parler');
    // L'écran d'accueil ne s'affiche PAS par-dessus une conversation déjà tenue.
    await expect(page.getByTestId('setup-vide')).toHaveCount(0);
    // Et l'avancement de l'entretien est celui du serveur, pas un compte local.
    await expect(page.getByTestId('setup-recommencer')).toBeVisible();
  });

  test('🔴 « Construire en parlant » est l onglet d ENTRÉE, pas « Identité et ton »', async ({ page }) => {
    // Julien, 2026-08-31 : « je voudrais que la fenêtre Construire en parlant apparaisse en premier ». On
    // tombait sur un formulaire vide, alors que tout l intérêt de cet écran est de ne pas avoir à savoir quoi
    // y écrire.
    await mock(page, []);
    await page.goto('/agents');
    await page.getByTestId(`agent-ligne-${AG}`).click();
    await expect(page).toHaveURL(/tab=construction/);
    await expect(page.getByTestId('setup-saisie')).toBeVisible();
  });

  test('🔴 une PIÈCE JOINTE devient de la connaissance, et l assistant en est informé', async ({ page }) => {
    // Julien, 2026-08-31 : « il faut aussi qu'on puisse rajouter des pièces jointes (images, documents, …)
    // dans la conversation (notamment pour rajouter des base de connaissance) ». Un client arrive avec ses
    // procédures déjà écrites ; les retaper fiche par fiche est le travail qu'on lui promet d'éviter.
    const appels: Appel[] = [];
    await mock(page, appels, { pieceJointe: { fiches: 3, titres: ['Nos horaires', 'Nos tarifs', 'L acces'], nature: 'texte' } });
    await page.goto(`/agents?id=${AG}&tab=construction`);

    await page.getByTestId('setup-fichier').setInputFiles({
      name: 'Guide sejours.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(['Nos horaires', 'La piscine ouvre a 9h.'].join('\n'), 'utf8'),
    });

    // Le fichier part en data URL, sous un nom SANS son extension (il devient le titre par defaut des fiches).
    await expect.poll(() => appels.some((a) => /piece-jointe$/.test(a.url))).toBe(true);
    const envoi = appels.find((a) => /piece-jointe$/.test(a.url))!.body as { nom: string; dataUrl: string };
    expect(envoi.nom).toBe('Guide sejours');
    expect(envoi.dataUrl.startsWith('data:')).toBe(true);
    // Et l assistant est informe par un message ORDINAIRE : pas de chemin special dans la conversation.
    await expect(page.getByTestId('setup-tour-user')).toContainText('3 fiches ajoutées');
  });

  test('🔴 un agent se supprime DEPUIS LA LISTE, sans avoir à entrer dedans', async ({ page }) => {
    // Julien, 2026-08-31 : « il faut pouvoir supprimer un agent (quand on appuie sur other AI agent) ».
    const appels: Appel[] = [];
    await mock(page, appels);
    page.on('dialog', (d) => void d.accept());
    await page.goto('/agents');
    await page.getByTestId(`agent-supprimer-${AG}`).click();
    await expect.poll(() => appels.some((a) => a.method === 'DELETE')).toBe(true);
  });
});
