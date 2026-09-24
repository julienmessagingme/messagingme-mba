import { test, expect } from '@playwright/test';
// La fenêtre d'observation se DÉRIVE du délai de rejeu du client HTTP, elle ne se devine pas.
import { RETRY_DELAY_MS } from '../lib/http';

/**
 * L'ÉCRAN « PUBLICITÉS », PARTIE LOT 3 : la liste, le bouton Créer, et l'entonnoir.
 *
 * 🔴 CE QUE CE SPEC PROTÈGE, ET QU'AUCUN TEST DE SERVEUR NE PEUT VOIR. Deux choses, et les deux décident de
 * ce qu'un client fait de son argent :
 *
 *  1. **Le bouton Créer n'existe que quand créer a un sens**, et quand il manque, l'écran DIT ce qui manque.
 *     Un bouton présent mais inerte est le motif « offert-et-inerte » que le produit s'interdit ; un bouton
 *     absent sans explication fait chercher une panne là où il n'y a qu'une étape non faite.
 *  2. **« non disponible » ne devient jamais « 0 »** dans l'entonnoir. Le calcul rend `null` côté serveur,
 *     et c'est ICI qu'on peut vérifier que l'écran ne le transforme pas en zéro, ce qui ressemblerait au
 *     meilleur résultat imaginable sur la page qui sert à décider d'arrêter ou de remettre du budget.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONNEXION = {
  // `as string | null` sur les champs qu'un cas REMPLACE par null : sans lui, TypeScript infère `string`
  // depuis la valeur du fixture et refuse l'écrasement. `pageNom` a rejoint ses deux voisins quand
  // l'aperçu a eu besoin du cas « connexion antérieure à 0169 ».
  comptePubId: '111' as string | null, compteNom: 'GMC', pageId: 'p1' as string | null,
  pageNom: 'Page test' as string | null, devise: 'EUR',
  fuseau: 'Europe/Paris', pageLiee: 'oui', connectePar: 'u-1',
  connecteLe: '2026-09-23T08:00:00.000Z', jetonRejeteLe: null as string | null,
};

const PUB_PUBLIEE = {
  id: 'pub-1', campagneId: 'c-1', ensembleId: 'e-1', creaId: 'cr-1', pubId: 'ad-1',
  nom: 'Rentrée 2026', etat: 'publiee', statutMeta: 'ACTIVE', motifRefus: null,
  budgetTotal: 150, debut: '2026-10-01T00:00:00.000Z', fin: '2026-10-31T23:00:00.000Z',
  destination: 'scenario', workflowId: 'wf-1', tagQualification: 'devis', automationId: 'a-1',
  depense: 12.5, clics: 40, luLe: '2026-09-23T20:00:00.000Z', creeLe: '2026-09-23T10:00:00.000Z',
};

const PUB_PRETE = { ...PUB_PUBLIEE, id: 'pub-2', nom: 'Black Friday', etat: 'prete', statutMeta: null, depense: null, clics: null, luLe: null };

/** Un entonnoir dont TOUT est inconnu : c'est l'état d'une publicité qui vient d'être publiée. */
const ENTONNOIR_VIDE = {
  depense: null,
  clics: { nombre: null, cout: null, passage: null },
  leads: { nombre: 0, cout: null, passage: null },
  qualifies: { nombre: 0, cout: null, passage: null },
  nonPrisEnCharge: 0,
};

interface Options {
  connexion?: typeof CONNEXION | null;
  compte?: { statut: number | null; raisonDesactivation: number | null; moyenPaiement: boolean } | null;
  publicites?: unknown[];
  entonnoir?: unknown;
  /**
   * Ce que rend `/settings`. `'vide'` = un 200 SANS la clé `mbaEnabled`, `'panne'` = un 500.
   *
   * 🔴 LES DEUX SONT LE MÊME ÉTAT CÔTÉ ÉCRAN : « nous ne savons pas », qui n'est PAS « éteint ».
   */
  reglages?: boolean | 'vide' | 'panne';
  /**
   * Les scénarios rendus par la LISTE. Vide par défaut, comme avant : l'écran ne propose que les scénarios
   * EN LIGNE, et il le juge sur `nodeCount`, calculé en base sur le graphe PUBLIÉ (`graph->'nodes'`).
   */
  scenarios?: Array<{ id: string; name: string; nodeCount: number }>;
  /**
   * Le DÉTAIL d'un scénario (`GET /workflows/:id`), d'où l'aperçu tire la première réponse.
   *
   * ⚠️ C'est `graph` et jamais `draftGraph` : un lead publicitaire parcourt ce qui est en ligne.
   * `'panne'` rend un 500, pour éprouver que l'écran avoue son échec de lecture au lieu d'inventer.
   */
  detailScenario?: { graph: { nodes: unknown[]; edges: unknown[] } } | 'panne';
  /**
   * Les brouillons rendus par la liste, SANS leurs octets de visuel (c'est le contrat de cette route).
   *
   * `'absent'` rend 404 sur TOUTES les routes de brouillon : c'est la fenetre entre le `git push` qui
   * publie la console chez Vercel et le `up` qui deploie l'API.
   */
  brouillons?: unknown[] | 'absent';
  /** Ce que la lecture d'UN brouillon ajoute au premier de la liste, le visuel notamment. */
  detailBrouillon?: Record<string, unknown>;
  /**
   * `true` fait rendre 404 aux ECRITURES sur UN brouillon, la route existant par ailleurs.
   *
   * C'est le second sens du 404 : « ce brouillon n'existe pas », parce qu'il a ete supprime entre
   * temps. Le confondre avec « la route n'existe pas » perd le travail en silence.
   */
  brouillonDisparu?: boolean;
}

/**
 * Combien de fois `/settings` a été servi depuis le dernier `brancher`.
 *
 * 🔴 IL EXISTE PARCE QUE L'ÉTAT ATTENDU EST AUSSI L'ÉTAT INITIAL. « Nous ne savons pas » vaut `null`,
 * et `null` est la valeur de départ : une assertion posée trop tôt se satisfait donc du départ et passe
 * MÊME SI la lecture finit par dire autre chose. Le cas « panne » l'a prouvé : il restait vert avec le
 * défaut remis, et son verdict dépendait du nombre de workers.
 *
 * ⚠️ SA RAISON A CHANGÉ, ET LE TEXTE PRÉCÉDENT DISAIT ENCORE L'ANCIENNE. Il ne sert plus à atteindre un
 * NOMBRE de lectures (un compte en dur était un contrat avec la politique de rejeu d'un autre fichier),
 * il sert à savoir que quelque chose a BOUGÉ, ce que `attendreLectureRetombee` exploite.
 */
let lecturesReglages = 0;

/** Le corps du dernier `POST /pubs/brouillons`, pour verifier CE QUI PART et pas seulement l'ecran. */
let corpsCreationBrouillon: Record<string, unknown> | null = null;

/**
 * Attend que la lecture des réglages ait CESSÉ de bouger.
 *
 * 🔴 ON NE COMPTE PLUS LES LECTURES EN DUR. Une version précédente attendait exactement deux réponses
 * pour une panne, parce que `web/lib/http.ts` rejoue un GET en échec une fois. Changer cette politique
 * ne rendait pas un échec lisible : le sondage n'atteignait jamais son compte et le cas mourait en
 * timeout, ce qui ressemble à une panne de l'écran.
 *
 * ⚠️ CE QU'ELLE SUPPOSE ENCORE, ET IL FAUT LE DIRE PLUTÔT QUE DE JURER QU'ELLE NE SUPPOSE RIEN : que la
 * fenêtre d'observation reste PLUS LONGUE que tout intervalle de rejeu. Elle est donc dérivée de
 * `RETRY_DELAY_MS`, et non devinée : si ce délai passait au-dessus, la fenêtre retomberait entre deux
 * tentatives, la lecture serait déclarée retombée alors qu'elle est en vol, et les cas redeviendraient
 * verts sur l'état de DÉPART, c'est-à-dire le piège même que cette fonction existe pour fermer.
 *
 * ⚠️ ET LA DÉRIVATION NE PROTÈGE QUE D'UN CHANGEMENT DE VALEUR, PAS DE FORME : elle est juste tant que
 * le rejeu est UNIQUE et à délai CONSTANT. Un second essai en recul (800 ms là où le premier attend
 * 400) retomberait sous la fenêtre sans que rien ne le signale.
 */
const attendreLectureRetombee = async (page: import('@playwright/test').Page) => {
  await expect.poll(async () => {
    const avant = lecturesReglages;
    await page.waitForTimeout(RETRY_DELAY_MS + 300);
    return avant > 0 && avant === lecturesReglages;
  }, { timeout: 15000 }).toBe(true);
};

const brancher = async (page: import('@playwright/test').Page, o: Options = {}) => {
  // ⚠️ APPELABLE DEUX FOIS DANS UN MÊME CAS. Sans ce désarmement, chaque appel empilerait un handler
  // sur le même motif, et le cas ne tiendrait que par la règle non écrite « le dernier enregistré
  // gagne » : le jour où l'un ferait `route.fallback()`, le premier reprendrait la main avec le
  // fixture de la phase précédente, et le test éprouverait silencieusement autre chose.
  await page.unrouteAll();
  lecturesReglages = 0;
  corpsCreationBrouillon = null;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/pubs/connexion')) {
      return json({
        configure: true, configId: 'cfg', appId: 'app', graphVersion: 'v23.0',
        connexion: o.connexion === undefined ? CONNEXION : o.connexion,
        compte: o.compte === undefined ? { statut: 1, raisonDesactivation: 0, moyenPaiement: true } : o.compte,
      });
    }
    // 🔴 LES BROUILLONS AVANT LA PAGE D'UNE PUBLICITÉ, et ce n'est pas cosmétique : `/pubs/brouillons`
    // SATISFAIT la regex `/pubs/<id>` juste en dessous. Sans cet ordre, la liste des brouillons recevait
    // le fixture d'une publicité, `r.brouillons` valait `undefined`, et le repli `?? []` rendait le cas
    // VERT en n'affichant jamais aucun brouillon. C'est le même piège que la ligne suivante décrit déjà.
    if (/\/pubs\/brouillons/.test(url.split('?')[0] ?? '') && o.brouillons === 'absent') {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
    }
    if (/\/pubs\/brouillons$/.test(url.split('?')[0] ?? '')) {
      // 🔴 LE POST AVANT LE GET : les deux tombaient sur la meme branche, donc une creation resolvait
      // avec `id === undefined` et aucun cas ne pouvait eprouver la RE-CREATION d'un brouillon. C'est
      // exactement l'endroit ou le defaut du visuel perdu se cachait.
      if (route.request().method() === 'POST') {
        corpsCreationBrouillon = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'br-2' }) });
      }
      return json({ brouillons: Array.isArray(o.brouillons) ? o.brouillons : [] });
    }
    if (/\/pubs\/brouillons\/[^/]+$/.test(url.split('?')[0] ?? '')) {
      if (route.request().method() !== 'GET') {
        return o.brouillonDisparu === true
          ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'ce brouillon n’existe pas' }) })
          : route.fulfill({ status: 204, body: '' });
      }
      const b = Array.isArray(o.brouillons) ? o.brouillons[0] : undefined;
      return json({ brouillon: { ...(b ?? {}), ...(o.detailBrouillon ?? {}) } });
    }
    // La page d'une publicité, AVANT la liste : `/pubs/pub-1` contient `/pubs`, donc l'ordre compte.
    if (/\/pubs\/[^/]+$/.test(url.split('?')[0] ?? '')) {
      return json({ publicite: PUB_PUBLIEE, entonnoir: o.entonnoir ?? ENTONNOIR_VIDE });
    }
    if (url.includes('/pubs')) return json({ publicites: o.publicites ?? [] });
    // Le DÉTAIL d'un scénario AVANT la liste : `/workflows/wf-1` contient `/workflows`, donc l'ordre
    // compte, exactement comme pour `/pubs/pub-1` vingt lignes plus haut.
    if (/\/workflows\/[^/]+$/.test(url.split('?')[0] ?? '')) {
      if (o.detailScenario === 'panne') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return json({
        workflow: { id: 'wf-1', name: 'Qualification', ...(o.detailScenario ?? { graph: { nodes: [], edges: [] } }) },
      });
    }
    if (url.includes('/workflows')) return json({ workflows: o.scenarios ?? [] });
    if (url.includes('/settings')) {
      lecturesReglages += 1;
      if (o.reglages === 'panne') return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      if (o.reglages === 'vide') return json({});
      return json({ mbaEnabled: o.reglages ?? true });
    }
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/publicites');
};

/**
 * CE QUE LE FORMULAIRE DIT DE L'AGENT DE META, DANS SES TROIS ÉTATS.
 *
 * 🔴 CES CAS EXISTENT PARCE QUE LE MÊME DÉFAUT EST REVENU TROIS FOIS, chaque fois déplacé d'un cran :
 * `!agentMetaOuvert` dans la liste, puis `agentMetaOuvert === true` au passage vers le formulaire. Les
 * gardes écrites à chaque fois lisaient le TEXTE des sources, donc elles pinçaient une PRÉSENCE et
 * n'interdisaient rien : échanger le corps des deux branches, ou ajouter un quatrième paragraphe, les
 * laissait vertes. Un test qui REND l'écran pince la phrase, la branche et l'option d'un seul coup.
 *
 * ⚠️ LA DISTINCTION QUI COMPTE : se FERMER sur l'inconnu est le bon sens d'erreur (proposer l'agent de
 * Meta sans l'avoir lu ferait créer une publicité sans répondeur) ; l'AFFIRMER est un énoncé sur la
 * configuration Meta du client, alors que nous n'avons fait qu'échouer à lire NOTRE réglage.
 */
test.describe('Publicités : ce que le formulaire dit de l’agent de Meta', () => {
  const ouvrirLeFormulaire = async (page: import('@playwright/test').Page) => {
    await page.getByTestId('pubs-creer').click();
    await expect(page.getByTestId('pub-formulaire')).toBeVisible();
  };

  test('agent OUVERT : l’option existe, et aucune des deux phrases ne sort', async ({ page }) => {
    await brancher(page, { reglages: true });
    await ouvrirLeFormulaire(page);
    await expect(page.getByTestId('pub-agent-indispo')).toHaveCount(0);
    await expect(page.getByTestId('pub-agent-inconnu')).toHaveCount(0);
    await expect(page.getByRole('option', { name: /agent de Meta|Meta agent/ })).toHaveCount(1);
    // La quatrieme branche du tri-etat, celle que personne ne rendait.
    await expect(page.getByTestId('pub-agent-ecarte')).toHaveCount(1);
  });

  test('🔴 agent ÉTEINT : l’option disparaît, et l’écran dit que c’est leur numéro', async ({ page }) => {
    await brancher(page, { reglages: false });
    await ouvrirLeFormulaire(page);
    await expect(page.getByTestId('pub-agent-indispo')).toContainText(/pas ouvert à tout le monde|not open to everyone/);
    await expect(page.getByTestId('pub-agent-inconnu')).toHaveCount(0);
    await expect(page.getByRole('option', { name: /agent de Meta|Meta agent/ })).toHaveCount(0);
    // Ancre : ce testid ne naît que sous la destination « scénario », donc un `0` dirait aussi bien
    // « le sous-bloc n'est pas rendu ». Sans elle, l'assertion se viderait le jour où le défaut
    // change.
    await expect(page.getByTestId('pub-scenario')).toBeVisible();
    await expect(page.getByTestId('pub-agent-ecarte')).toHaveCount(0);
  });

  for (const [nom, reglages] of [['une réponse SANS la clé', 'vide'], ['une lecture en PANNE', 'panne']] as const) {
    test(`🔴 ${nom} : l’option disparaît, mais l’écran parle de NOUS, pas de leur numéro`, async ({ page }) => {
      await brancher(page, { reglages });
      // 🔴 ON ATTEND QUE LA LECTURE SOIT RETOMBÉE. Sans ça, l'assertion se satisfait de l'état INITIAL,
      // qui vaut déjà `null`, et le test reste vert avec le défaut remis. C'est le piège « l'état
      // attendu est l'état de départ », et il ne se voit pas en lisant le test.
      await attendreLectureRetombee(page);
      await ouvrirLeFormulaire(page);
      // Le geste d'erreur est bon : l'option reste fermée.
      await expect(page.getByRole('option', { name: /agent de Meta|Meta agent/ })).toHaveCount(0);
      // Mais la PHRASE change, et c'est tout le sujet : on ne déclare pas éteint ce qu'on n'a pas lu.
      await expect(page.getByTestId('pub-agent-inconnu')).toContainText(/n’avons pas pu lire|could not read/);
      await expect(page.getByTestId('pub-agent-indispo')).toHaveCount(0);
      // 🔴 LA QUATRIÈME BRANCHE AUSSI : « l'agent de Meta sera écarté » est un énoncé sur LEUR
      // configuration. Sans ce sens-là, la passer en `!== false` ne faisait tomber aucun test.
      await expect(page.getByTestId('pub-scenario')).toBeVisible();
      await expect(page.getByTestId('pub-agent-ecarte')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(/pas ouvert à tout le monde|not open to everyone/);
    });
  }

  test('🔴 ET LE BANDEAU DE LA LISTE SUIT LA MÊME RÈGLE : éteint le dit, inconnu se tait', async ({ page }) => {
    /**
     * Le bandeau de la liste est l'endroit où ce défaut a vécu EN PREMIER, et il n'était gardé que par des
     * `toContain` sur le texte des sources, c'est-à-dire la forme dont ce lot a montré trois fois qu'elle
     * pince une présence sans rien interdire.
     */
    const pubAgent = { ...PUB_PUBLIEE, id: 'pub-am', destination: 'agent_meta' };
    await brancher(page, { reglages: false, publicites: [pubAgent] });
    await expect(page.getByTestId('pub-agent-eteint-pub-am'))
      .toContainText(/ne répond plus sur ce numéro|no longer answers on this number/);

    await brancher(page, { reglages: 'panne', publicites: [pubAgent] });
    await attendreLectureRetombee(page);
    // ⚠️ ANCRE POSITIVE D'ABORD : `toHaveCount(0)` est aussi l'état d'une page qui n'a rendu AUCUNE
    // publicité. Sans cette ligne, vider la fixture rendait ce cas vert avec le défaut en place,
    // c'est-à-dire le piège que ce même cas existe pour fermer, descendu d'un étage.
    await expect(page.getByTestId('pubs-liste')).toContainText(PUB_PUBLIEE.nom);
    await expect(page.getByTestId('pub-agent-eteint-pub-am')).toHaveCount(0);
  });
});

/**
 * LA LISTE ET LA COQUILLE ONT CHACUNE SON EMPLACEMENT D'ERREUR, ET NE PEUVENT PLUS S'ÉCRASER.
 *
 * 🔴 CE CAS EXISTE PARCE QUE LE PARTAGE A PRODUIT TROIS DÉFAUTS DE SUITE, chacun corrigé par une
 * discipline un peu plus fine : effacer à l'entrée laissait un bandeau périmé, effacer au succès
 * emportait l'erreur des autres, et une étiquette de source y remédiait SAUF si la liste échouait
 * entre-temps, auquel cas elle prenait l'emplacement puis l'effaçait légitimement.
 *
 * ⚠️ LE CAS ÉPROUVE PRÉCISÉMENT L'ORDRE QUE L'ÉTIQUETTE NE FERMAIT PAS : déconnexion ratée, PUIS
 * rafraîchissement de la liste en échec, PUIS rafraîchissement qui repart. Avec deux emplacements, la
 * question de l'ordre ne se pose plus du tout, et c'est le but : une discipline partagée se défait
 * toujours par un cas qu'on n'a pas énuméré, une séparation non.
 */
test.describe('Publicités : l’emplacement d’erreur partagé', () => {
  test('🔴 la liste qui repart n’efface QUE son erreur, pas celle d’une déconnexion ratée', async ({ page }) => {
    let listeEnPanne = false;
    let listeRepartie = false;
    await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const methode = route.request().method();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/pubs/connexion')) {
        if (methode === 'DELETE') {
          return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"deconnexion refusee"}' });
        }
        return json({
          configure: true, configId: 'cfg', appId: 'app', graphVersion: 'v23.0', connexion: CONNEXION,
          compte: { statut: 1, raisonDesactivation: 0, moyenPaiement: true },
        });
      }
      // La bascule d'une publicité réussit toujours : c'est son `recharger` qui nous intéresse.
      if (methode === 'POST' && /\/pubs\/[^/]+\/(pause|reprendre)$/.test(url.split('?')[0] ?? '')) return json({ ok: true });
      if (url.includes('/pubs')) {
        // ⚠️ 422, PAS 500 : un 500 est REJOUÉ par le client HTTP, ce qui décalerait les arrivées et
        // masquerait le défaut par hasard, exactement comme il le masquait en production.
        if (listeEnPanne) return route.fulfill({ status: 422, contentType: 'application/json', body: '{"error":"liste cassee"}' });
        // 🔴 LA TROISIÈME RÉPONSE EST DIFFÉRENTE DES PRÉCÉDENTES, ET C'EST CE QUI REND LE CAS VALIDE.
        // Sans ça, l'assertion finale se satisfaisait du message ENCORE affiché, avant que le
        // rechargement ne l'efface : le cas restait vert avec le défaut remis, vérifié par mutation.
        // Attendre une publicité qu'on n'a jamais servie prouve que le succès a été RENDU.
        return json({ publicites: listeRepartie ? [PUB_PRETE] : [PUB_PUBLIEE] });
      }
      if (url.includes('/workflows')) return json({ workflows: [] });
      if (url.includes('/settings')) return json({ mbaEnabled: true });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/publicites');
    await expect(page.getByTestId('pubs-liste')).toContainText(PUB_PUBLIEE.nom);

    // 1. La déconnexion échoue : son message occupe l'emplacement de la COQUILLE.
    await page.getByRole('button', { name: /^Déconnecter$|^Disconnect$/ }).click();
    await expect(page.getByTestId('pubs-erreur')).toContainText(/deconnexion refusee/);

    // 2. Le rafraîchissement de la liste échoue à son tour. C'est l'ordre que l'étiquette de source ne
    //    fermait PAS : elle réétiquetait l'emplacement partagé, puis l'effaçait au succès suivant.
    listeEnPanne = true;
    await page.getByTestId(`pub-bascule-${PUB_PUBLIEE.id}`).click();
    await expect(page.getByTestId('pubs-liste-erreur')).toContainText(/liste cassee/);
    // Les deux coexistent : chacune dans la sienne.
    await expect(page.getByTestId('pubs-erreur')).toContainText(/deconnexion refusee/);

    // 3. La liste repart. Elle efface la SIENNE, et laisse celle de la déconnexion : c'est le seul
    //    endroit qui dit au client que sa déconnexion n'a pas eu lieu.
    listeEnPanne = false;
    listeRepartie = true;
    await page.getByTestId(`pub-bascule-${PUB_PUBLIEE.id}`).click();
    // On attend que le succès soit RENDU, pas seulement demandé : sans cette ancre, l'assertion
    // suivante se satisferait du message encore affiché, avant l'effacement.
    await expect(page.getByTestId('pubs-liste')).toContainText(PUB_PRETE.nom);
    await expect(page.getByTestId('pubs-liste-erreur')).toHaveCount(0);
    await expect(page.getByTestId('pubs-erreur')).toContainText(/deconnexion refusee/);
  });
});

test.describe('Publicités : la liste et le bouton Créer', () => {
  test('connexion complète et compte qui peut diffuser : le bouton Créer est là', async ({ page }) => {
    await brancher(page);
    await expect(page.getByTestId('pubs-creer')).toBeVisible();
    await expect(page.getByTestId('pubs-creation-bloquee')).toHaveCount(0);
  });

  test('🔴 SANS MOYEN DE PAIEMENT : pas de bouton, et la RAISON est écrite', async ({ page }) => {
    // C'est le pire des cas bloquants, parce que tout a l'air d'avoir marché : la publicité se crée, se
    // publie, et ne part JAMAIS. Le dire avant vaut mieux que de le découvrir en regardant zéro impression.
    await brancher(page, { compte: { statut: 1, raisonDesactivation: 0, moyenPaiement: false } });
    await expect(page.getByTestId('pubs-creer')).toHaveCount(0);
    await expect(page.getByTestId('pubs-creation-bloquee')).toContainText(/moyen de paiement|payment method/);
  });

  test('🔴 JETON REFUSÉ PAR META : pas de bouton, et l’écran dit de se reconnecter', async ({ page }) => {
    await brancher(page, { connexion: { ...CONNEXION, jetonRejeteLe: '2026-09-23T19:00:00.000Z' } });
    await expect(page.getByTestId('pubs-creer')).toHaveCount(0);
    await expect(page.getByTestId('pubs-creation-bloquee')).toContainText(/reconnect/i);
  });

  test('compte ou Page pas encore choisis : pas de bouton, et l’écran dit lequel', async ({ page }) => {
    await brancher(page, { connexion: { ...CONNEXION, comptePubId: null } });
    await expect(page.getByTestId('pubs-creer')).toHaveCount(0);
    await expect(page.getByTestId('pubs-creation-bloquee')).toContainText(/compte publicitaire|ad account/);
  });

  test('⚠️ un état de compte INCONNU ne bloque PAS : c’est Meta qui tranchera', async ({ page }) => {
    // `null` veut dire « nous n'avons pas pu demander », pas « ce compte est mauvais ». Refuser sur une
    // ignorance bloquerait un client dont le compte va très bien.
    await brancher(page, { compte: null });
    await expect(page.getByTestId('pubs-creer')).toBeVisible();
  });

  test('aucune publicité : l’écran le dit, il ne reste pas vide', async ({ page }) => {
    await brancher(page);
    await expect(page.getByTestId('pubs-liste-vide')).toBeVisible();
  });

  test('sans connexion, la section des publicités n’apparaît pas du tout', async ({ page }) => {
    // Avant la connexion il n'y a rien à lister et rien à créer : afficher une section vide donnerait
    // l'impression d'un écran cassé.
    await brancher(page, { connexion: null });
    // 🔴 ANCRE POSITIVE D'ABORD, et elle manquait : `toHaveCount(0)` est aussi l'état d'une page qui
    // n'a RIEN rendu. Vérifié par une relecture à froid, qui a fait avorter toutes les requêtes et vu
    // le cas rester vert : il ne prouvait donc rien sur `connexion: null`.
    await expect(page.getByRole('button', { name: /Connecter|Connect/ })).toBeVisible();
    await expect(page.getByTestId('pubs-section')).toHaveCount(0);
  });
});

test.describe('Publicités : ce que la liste montre', () => {
  test('une publicité publiée montre son nom et son statut Meta en clair', async ({ page }) => {
    await brancher(page, { publicites: [PUB_PUBLIEE] });
    await expect(page.getByTestId('pubs-liste')).toContainText('Rentrée 2026');
    await expect(page.getByTestId('pubs-liste')).toContainText(/Diffuse|Delivering/);
  });

  test('une publicité PRÊTE propose « Publier », une publiée propose la pause', async ({ page }) => {
    await brancher(page, { publicites: [PUB_PRETE, PUB_PUBLIEE] });
    await expect(page.getByTestId('pub-publier-pub-2')).toBeVisible();
    await expect(page.getByTestId('pub-bascule-pub-1')).toBeVisible();
    // Une publicité prête n'a pas de bouton de pause : il n'y a rien à mettre en pause.
    await expect(page.getByTestId('pub-bascule-pub-2')).toHaveCount(0);
  });

  test('🔴 PUBLIER DEMANDE CONFIRMATION, EN ANNONÇANT LA DÉPENSE MAXIMALE', async ({ page }) => {
    // C'est le seul geste de l'écran qui engage de l'argent, et il est irréversible au sens qui compte :
    // une impression payée ne se rembourse pas.
    await brancher(page, { publicites: [PUB_PRETE] });
    let texte = '';
    page.on('dialog', (d) => { texte = d.message(); void d.dismiss(); });
    await page.getByTestId('pub-publier-pub-2').click();
    expect(texte).toContain('150');
  });

  test('une création échouée le DIT, parce que quelque chose peut subsister chez Meta', async ({ page }) => {
    await brancher(page, { publicites: [{ ...PUB_PRETE, etat: 'echec_creation' }] });
    await expect(page.getByTestId('pub-echec')).toBeVisible();
  });
});

test.describe('Publicités : l’entonnoir', () => {
  test('🔴 UN ENTONNOIR SANS CHIFFRES DIT « NON DISPONIBLE », JAMAIS « 0 »', async ({ page }) => {
    await brancher(page, { publicites: [PUB_PUBLIEE] });
    await page.getByTestId('pub-detail-pub-1').click();
    const bloc = page.getByTestId('pub-entonnoir-pub-1');
    await expect(bloc).toBeVisible();
    // Quatre « non disponible » au moins : la dépense, le nombre de clics, et les coûts des étapes.
    await expect(bloc).toContainText(/non disponible|not available/);
    // Et surtout PAS de « 0 € » là où l'on ne sait pas : c'est le chiffre le plus trompeur de cet écran.
    await expect(bloc).not.toContainText('coût 0');
  });

  test('les prospects non pris en charge sont comptés À PART, et nommés', async ({ page }) => {
    await brancher(page, {
      publicites: [PUB_PUBLIEE],
      entonnoir: { ...ENTONNOIR_VIDE, leads: { nombre: 12, cout: null, passage: null }, nonPrisEnCharge: 3 },
    });
    await page.getByTestId('pub-detail-pub-1').click();
    const hors = page.getByTestId('pub-non-pris-pub-1');
    await expect(hors).toContainText('3');
    await expect(hors).toContainText(/désabonnés|unsubscribed/);
    // 🔴 LA QUATRIÈME CAUSE, et c'est la seule RÉPARABLE : une publicité créée et pas encore publiée.
    // Sans elle nommée, le client irait chercher des contacts bloqués qui n'existent pas.
    await expect(hors).toContainText(/sans scénario|no scenario/);
  });

  test('⚠️ l’écran DIT quand les chiffres ont été relus chez Meta', async ({ page }) => {
    // Ils viennent d'un balayage toutes les quinze minutes, pas d'un appel à l'ouverture : sans cette
    // mention, on chercherait une panne là où il n'y a qu'un délai.
    await brancher(page, { publicites: [PUB_PUBLIEE] });
    await page.getByTestId('pub-detail-pub-1').click();
    await expect(page.getByTestId('pub-entonnoir-pub-1')).toContainText(/Relus chez Meta|Read from Meta/);
  });
});

/**
 * L'APERÇU DE LA PUBLICITÉ : ce que le prospect verra, pendant qu'on le saisit.
 *
 * 🔴 CES CAS PINCENT UNE INVERSION, PAS UNE PRÉSENCE. Un aperçu se garde mal : « le panneau existe » est
 * satisfait par un panneau VIDE, et « le texte est sur la page » l'est déjà par le champ de saisie qui le
 * contient. Chaque cas ci-dessous lit donc un emplacement PRÉCIS de l'aperçu et vérifie en plus que le
 * texte de l'autre champ n'y est PAS : c'est la seule forme qui tombe si on échange deux valeurs.
 *
 * ⚠️ LA PAIRE QUI COMPTE EST accueil / message pré-rempli. Ce sont deux chaînes libres, toutes deux
 * valides, qui partent dans le MÊME objet chez Meta (`page_welcome_message`) à deux emplacements
 * différents. Les inverser produit une publicité absurde (le prospect s'accueille lui-même) qu'aucune
 * validation ne peut refuser. Le formulaire porte déjà une note à ce sujet ; l'aperçu est ce qui la rend
 * vérifiable d'un coup d'œil, et ce cas est ce qui l'empêche de régresser.
 */
test.describe('Publicités : l’aperçu de ce que verra le prospect', () => {
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  const ouvrir = async (page: import('@playwright/test').Page) => {
    await page.getByTestId('pubs-creer').click();
    await expect(page.getByTestId('pub-formulaire')).toBeVisible();
  };

  test('à l’ouverture, l’aperçu montre des repères et jamais du vide', async ({ page }) => {
    await brancher(page);
    await ouvrir(page);
    // 🔴 ANCRE POSITIVE. Sans elle, les cas suivants seraient satisfaits par un aperçu qui ne rend rien :
    // on vérifie d'abord que les trois emplacements EXISTENT avant de vérifier ce qu'ils portent.
    await expect(page.getByTestId('pub-apercu')).toBeVisible();
    await expect(page.getByTestId('pub-apercu-texte')).toContainText(/texte principal|primary text/);
    await expect(page.getByTestId('pub-apercu-titre')).toContainText(/titre|headline/);
    await expect(page.getByTestId('pub-apercu-visuel-absent')).toBeVisible();
    await expect(page.getByTestId('pub-apercu-visuel')).toHaveCount(0);
  });

  test('le texte principal et le titre vont chacun à leur place', async ({ page }) => {
    await brancher(page);
    await ouvrir(page);
    await page.locator('#pub-texte').fill('TEXTE-PRINCIPAL-E2E');
    await page.locator('#pub-titre').fill('TITRE-E2E');
    await expect(page.getByTestId('pub-apercu-texte')).toContainText('TEXTE-PRINCIPAL-E2E');
    await expect(page.getByTestId('pub-apercu-titre')).toContainText('TITRE-E2E');
    // Les deux moitiés qui font tomber une inversion.
    await expect(page.getByTestId('pub-apercu-texte')).not.toContainText('TITRE-E2E');
    await expect(page.getByTestId('pub-apercu-titre')).not.toContainText('TEXTE-PRINCIPAL-E2E');
  });

  test('🔴 l’accueil est une bulle reçue, le message pré-rempli est dans la zone de saisie', async ({ page }) => {
    await brancher(page);
    await ouvrir(page);
    await page.locator('#pub-accueil').fill('ACCUEIL-E2E');
    await page.locator('#pub-prerempli').fill('PREREMPLI-E2E');
    await expect(page.getByTestId('pub-apercu-accueil')).toContainText('ACCUEIL-E2E');
    await expect(page.getByTestId('pub-apercu-prerempli')).toContainText('PREREMPLI-E2E');
    // 🔴 LE CŒUR DU CAS : échanger les deux champs le fait tomber, alors qu'il resterait vert si l'on
    // se contentait de chercher les deux chaînes quelque part dans l'aperçu.
    await expect(page.getByTestId('pub-apercu-accueil')).not.toContainText('PREREMPLI-E2E');
    await expect(page.getByTestId('pub-apercu-prerempli')).not.toContainText('ACCUEIL-E2E');
  });

  test('le visuel choisi s’affiche, et le repère d’absence disparaît', async ({ page }) => {
    await brancher(page);
    await ouvrir(page);
    await page.locator('#pub-image').setInputFiles({ name: 'visuel.png', mimeType: 'image/png', buffer: PNG_1x1 });
    // Le `src` est construit depuis le base64 DÉJÀ lu pour le téléversement : rien n'est relu, rien ne part.
    await expect(page.getByTestId('pub-apercu-visuel')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.getByTestId('pub-apercu-visuel-absent')).toHaveCount(0);
  });

  test('l’aperçu nomme la Page connectée, jamais son identifiant', async ({ page }) => {
    await brancher(page);
    await ouvrir(page);
    await expect(page.getByTestId('pub-apercu-page')).toContainText('Page test');
    // ⚠️ `p1` est l'identifiant de la Page dans le fixture : un prospect ne voit JAMAIS un identifiant,
    // et le repli d'un nom manquant doit être un libellé neutre, pas quinze chiffres.
    await expect(page.getByTestId('pub-apercu-page')).not.toContainText('p1');
  });

  test('sans nom de Page (connexion antérieure à 0169), un libellé neutre et pas l’identifiant', async ({ page }) => {
    await brancher(page, { connexion: { ...CONNEXION, pageNom: null } });
    await ouvrir(page);
    await expect(page.getByTestId('pub-apercu-page')).toContainText(/Votre Page|Your Page/);
    await expect(page.getByTestId('pub-apercu-page')).not.toContainText('p1');
  });
});

/**
 * LE TROISIÈME ÉCRAN : ce que le prospect recevra en réponse.
 *
 * 🔴 CE QUI SE JOUE ICI EST UN ÉCART DE RÉGIME DE VÉRITÉ, ET IL DOIT RESTER VISIBLE. Un scénario est
 * déterministe, donc l'aperçu montre ses MOTS EXACTS ; l'agent de Meta compose, donc l'aperçu montre une
 * ILLUSTRATION et le dit. Le jour où quelqu'un unifie les deux affichages « pour simplifier », l'exemple
 * inventé passerait pour une promesse : ce sont ces cas-là qui l'en empêchent.
 *
 * ⚠️ LES DEUX ALERTES VALENT PLUS QUE LE RESTE. Un scénario jamais publié, ou qui n'envoie rien depuis son
 * entrée, veut dire qu'un clic PAYÉ reçoit le silence. C'est la régression que ce lot a déjà corrigée une
 * fois côté serveur ; l'écran doit la montrer AVANT qu'on dépense, pas après.
 */
test.describe('Publicités : l’aperçu de la réponse', () => {
  const EN_LIGNE = [{ id: 'wf-1', name: 'Qualification', nodeCount: 2 }];
  const q = (body: string, data: Record<string, unknown> = {}) =>
    ({ nodes: [{ id: 'a', type: 'quick_message', data: { body, ...data } }], edges: [] });

  const ouvrir = async (page: import('@playwright/test').Page) => {
    await page.getByTestId('pubs-creer').click();
    await expect(page.getByTestId('pub-formulaire')).toBeVisible();
  };

  test('🔴 agent de Meta : un exemple, et l’écran DIT que ce n’en est qu’un', async ({ page }) => {
    await brancher(page, { reglages: true });
    await ouvrir(page);
    await page.getByTestId('pub-destination').selectOption('agent_meta');
    await expect(page.getByTestId('pub-apercu-reponse-texte')).not.toBeEmpty();
    // 🔴 LE CŒUR DU CAS. Sans cette phrase, l'écran montrerait des mots inventés avec l'autorité de mots
    // vrais, et le client croirait avoir validé la première réponse de sa publicité.
    await expect(page.getByTestId('pub-apercu-reponse-note')).toContainText(/les mots non|the words will not/);
  });

  test('scénario publié : les mots EXACTS du scénario, et l’écran le dit aussi', async ({ page }) => {
    await brancher(page, { scenarios: EN_LIGNE, detailScenario: { graph: q('REPONSE-EXACTE-E2E') } });
    await ouvrir(page);
    await page.getByTestId('pub-scenario').selectOption('wf-1');
    await expect(page.getByTestId('pub-apercu-reponse-texte')).toContainText('REPONSE-EXACTE-E2E');
    await expect(page.getByTestId('pub-apercu-reponse-note')).toContainText(/mots exacts|exact words/);
  });

  test('les réponses rapides du scénario apparaissent comme des boutons', async ({ page }) => {
    await brancher(page, {
      scenarios: EN_LIGNE,
      detailScenario: { graph: q('Que cherchez-vous ?', { quickReplies: [{ text: 'BOUTON-A-E2E' }, { text: 'BOUTON-B-E2E' }] }) },
    });
    await ouvrir(page);
    await page.getByTestId('pub-scenario').selectOption('wf-1');
    await expect(page.getByTestId('pub-apercu-reponse')).toContainText('BOUTON-A-E2E');
    await expect(page.getByTestId('pub-apercu-reponse')).toContainText('BOUTON-B-E2E');
  });

  test('🔴 un scénario sans rien en ligne : l’écran ALERTE, il ne se tait pas', async ({ page }) => {
    // ⚠️ CAS DÉFENSIF, ET ASSUMÉ COMME TEL : la liste ne propose que les scénarios en ligne, jugés sur
    // `nodeCount` (le graphe PUBLIÉ). Il reste atteignable si le scénario est dépublié entre le chargement
    // de la liste et le choix. Une publicité qui part dans cet état paie des clics pour du silence.
    await brancher(page, { scenarios: EN_LIGNE, detailScenario: { graph: { nodes: [], edges: [] } } });
    await ouvrir(page);
    await page.getByTestId('pub-scenario').selectOption('wf-1');
    await expect(page.getByTestId('pub-apercu-reponse-alerte')).toContainText(/aucune réponse|no answer/);
  });

  test('🔴 un embranchement en entrée : on AVOUE au lieu de choisir une branche', async ({ page }) => {
    await brancher(page, {
      scenarios: EN_LIGNE,
      detailScenario: { graph: {
        nodes: [{ id: 'a', type: 'condition', data: {} }, { id: 'b', type: 'quick_message', data: { body: 'BRANCHE-VRAIE-E2E' } }],
        edges: [{ source: 'a', target: 'b', sourceHandle: 'true' }],
      } },
    });
    await ouvrir(page);
    await page.getByTestId('pub-scenario').selectOption('wf-1');
    await expect(page.getByTestId('pub-apercu-reponse-note-bloc')).toContainText(/embranchement|branch/);
    // 🔴 LA MOITIÉ QUI COMPTE : le texte de la branche ne doit PAS être présenté comme la réponse. Sans
    // elle, deviner une branche resterait vert.
    await expect(page.getByTestId('pub-apercu-reponse')).not.toContainText('BRANCHE-VRAIE-E2E');
  });

  test('lecture du scénario en échec : on dit NOTRE échec, pas un verdict sur leur scénario', async ({ page }) => {
    await brancher(page, { scenarios: EN_LIGNE, detailScenario: 'panne' });
    await ouvrir(page);
    await page.getByTestId('pub-scenario').selectOption('wf-1');
    await expect(page.getByTestId('pub-apercu-reponse-note-bloc')).toContainText(/n’avons pas pu lire|could not read/);
    // Un échec de lecture n'est pas une alerte sur leur montage : l'écran ne doit pas crier au silence.
    await expect(page.getByTestId('pub-apercu-reponse-alerte')).toHaveCount(0);
  });

  test('le message pré-rempli est repris comme message ENVOYÉ par le prospect', async ({ page }) => {
    await brancher(page, { scenarios: EN_LIGNE, detailScenario: { graph: q('Bien reçu') } });
    await ouvrir(page);
    await page.locator('#pub-prerempli').fill('ENVOI-PROSPECT-E2E');
    // C'est ce qui fait du troisième écran une SUITE du deuxième et pas une vignette indépendante.
    await expect(page.getByTestId('pub-apercu-reponse')).toContainText('ENVOI-PROSPECT-E2E');
  });
});

/**
 * LES BROUILLONS, ET LA LISTE EN TROIS GROUPES (migration 0171, demande de Julien du 2026-09-24).
 *
 * 🔴 CE QUE CES CAS DÉFENDENT : un brouillon ne doit RIEN promettre de ce qu'une publicité promet. Il ne
 * dépense pas, il n'existe pas chez Meta, il n'a ni dépense ni clics. L'afficher dans la même liste que
 * des publicités qui, elles, consomment un budget, est utile mais dangereux : c'est la phrase qui les
 * sépare que ces cas épinglent, pas leur simple présence.
 *
 * ⚠️ ET LE GROUPEMENT SE DÉRIVE DE LA DATE DE FIN, donc les fixtures ci-dessous sont datées EXPRÈS de part
 * et d'autre d'aujourd'hui. Un test qui les daterait toutes dans le passé rendrait le groupe « en cours »
 * vide et passerait sans rien prouver.
 */
test.describe('Publicités : brouillons et groupes', () => {
  const BROUILLON = {
    id: 'br-1', nom: 'Rentrée (brouillon)', titre: 'Un devis', texte: 'Écrivez-nous',
    accueil: 'Bonjour', messagePreRempli: 'Je veux un devis', budgetTotal: '', debut: '', fin: '',
    pays: 'FR', ageMin: '18', ageMax: '65', tagQualification: '', destination: 'scenario',
    workflowId: null, aUnVisuel: true, creeLe: '2026-09-24T08:00:00.000Z', modifieLe: '2026-09-24T08:30:00.000Z',
  };
  const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const PUB_FINIE = { ...PUB_PUBLIEE, id: 'pub-9', nom: 'Soldes d’hiver', fin: '2026-01-31T23:00:00.000Z' };
  const PUB_EN_COURS = { ...PUB_PUBLIEE, fin: '2099-10-31T23:00:00.000Z' };

  test('les brouillons forment leur propre groupe, et disent que rien n’est parti chez Meta', async ({ page }) => {
    await brancher(page, { brouillons: [BROUILLON], publicites: [PUB_EN_COURS] });
    const groupe = page.getByTestId('pubs-groupe-brouillons');
    await expect(groupe).toContainText('Rentrée (brouillon)');
    // 🔴 LA PHRASE QUI SÉPARE. Sans elle, un brouillon ressemble à une publicité dont les chiffres
    // seraient simplement vides, c'est-à-dire à une publicité qui ne marche pas.
    await expect(groupe).toContainText(/Rien n’a été envoyé chez Meta|Nothing sent to Meta/);
    await expect(groupe).toContainText(/visuel enregistré|image saved/);
  });

  test('🔴 « achevée » se lit sur la date de fin, pas sur le statut Meta', async ({ page }) => {
    // Les deux publicités ont le MÊME `statutMeta` (`ACTIVE`) : seule leur date de fin les sépare. Un
    // groupement qui lirait le statut les mettrait donc au même endroit, et ce cas tomberait.
    await brancher(page, { publicites: [PUB_EN_COURS, PUB_FINIE] });
    await expect(page.getByTestId('pubs-groupe-en-cours')).toContainText('Rentrée 2026');
    await expect(page.getByTestId('pubs-groupe-en-cours')).not.toContainText('Soldes d’hiver');
    await expect(page.getByTestId('pubs-groupe-achevees')).toContainText('Soldes d’hiver');
    await expect(page.getByTestId('pubs-groupe-achevees')).not.toContainText('Rentrée 2026');
  });

  test('une publicité SANS date de fin reste « en cours », jamais « achevée »', async ({ page }) => {
    // `null` veut dire « on ne sait pas ». La ranger dans les achevées la masquerait alors qu'elle
    // dépense peut-être, et c'est la seule des deux erreurs qui ne se rattrape pas d'un clic.
    await brancher(page, { publicites: [{ ...PUB_PUBLIEE, fin: null }] });
    await expect(page.getByTestId('pubs-groupe-en-cours')).toContainText('Rentrée 2026');
    await expect(page.getByTestId('pubs-groupe-achevees')).toHaveCount(0);
  });

  test('« Reprendre » rouvre le formulaire rempli, visuel compris', async ({ page }) => {
    await brancher(page, {
      brouillons: [BROUILLON],
      detailBrouillon: { visuel: { type: 'image/png', base64: PNG_1x1 } },
    });
    await page.getByTestId('pub-brouillon-ouvrir-br-1').click();
    await expect(page.getByTestId('pub-formulaire')).toBeVisible();
    await expect(page.locator('#pub-titre')).toHaveValue('Un devis');
    await expect(page.locator('#pub-accueil')).toHaveValue('Bonjour');
    // 🔴 LE VISUEL SURVIT À LA RÉOUVERTURE, et c'est la promesse même de la décision de le stocker. On le
    // lit dans l'APERÇU, pas dans le champ fichier : un `<input type=file>` ne peut pas être prérempli,
    // donc c'est le rendu qui prouve que les octets sont revenus.
    await expect(page.getByTestId('pub-apercu-visuel')).toHaveAttribute('src', /^data:image\/png;base64,/);
    // Le bouton sait qu'il édite un brouillon existant et non qu'il en crée un second.
    await expect(page.getByTestId('pub-enregistrer-brouillon')).toContainText(/modifications|changes/);
  });

  test('🔴 enregistrer un brouillon n’exige RIEN, contrairement à créer', async ({ page }) => {
    await brancher(page);
    await page.getByTestId('pubs-creer').click();
    // Ni visuel, ni budget, ni case de catégorie : « Créer » est bloqué, « Enregistrer » ne l'est pas.
    await expect(page.getByTestId('pub-creer')).toBeDisabled();
    await expect(page.getByTestId('pub-enregistrer-brouillon')).toBeEnabled();
    await page.locator('#pub-nom').fill('BROUILLON-E2E');
    await page.getByTestId('pub-enregistrer-brouillon').click();
    // Après l'enregistrement, l'écran DIT que rien n'est parti chez Meta.
    await expect(page.getByTestId('pub-brouillon-actif')).toContainText(/Rien n’a été envoyé|Nothing was sent/);
  });

  test('le détail met le budget, la dépense et les clics EN FACE', async ({ page }) => {
    await brancher(page, {
      publicites: [PUB_EN_COURS],
      entonnoir: { ...ENTONNOIR_VIDE, depense: 12.5, clics: { nombre: 40, cout: 0.31, passage: null } },
    });
    await page.getByTestId('pub-detail-pub-1').click();
    const bilan = page.getByTestId('pub-bilan-pub-1');
    await expect(bilan).toContainText('150');   // budget initial
    await expect(bilan).toContainText('12.50'); // dépensé à date
    await expect(bilan).toContainText('40');    // clics vers WhatsApp
  });

  test('🔴 dans ce bilan aussi, « non disponible » ne devient JAMAIS zéro', async ({ page }) => {
    // C'est l'invariant du lot 3, et le rapprochement de ces trois nombres le rend plus dangereux encore :
    // un budget de 150 en face d'une dépense affichée « 0 » ressemble au meilleur résultat imaginable.
    await brancher(page, { publicites: [PUB_EN_COURS], entonnoir: ENTONNOIR_VIDE });
    await page.getByTestId('pub-detail-pub-1').click();
    const bilan = page.getByTestId('pub-bilan-pub-1');
    await expect(bilan).toContainText(/non disponible|not available/);
    await expect(bilan).not.toContainText(/\b0\b/);
  });
});

/**
 * 🔴 LA FENÊTRE ENTRE LE PUSH ET LE DÉPLOIEMENT DE L'API.
 *
 * Vercel publie cette console à CHAQUE `git push`, l'API attend son `up -d --build` : entre les deux, un
 * écran appelle une route que la production n'a pas. C'est un défaut CONNU de ce dépôt, payé le
 * 2026-09-21 par l'onglet « Outils », resté en 404 plus d'une heure sur un espace qui avait pourtant des
 * outils publiés.
 *
 * ⚠️ TOLÉRER L'ABSENCE EN LECTURE NE SUFFIT PAS. La liste des brouillons était déjà silencieuse sur un
 * 404 ; c'est le BOUTON d'enregistrement qui restait offert, et un clic y rendait le message brut du
 * routeur. Relevé en relecture à froid, par la session voisine et non par la mienne : mes propres
 * commits, je les relis avec les yeux de leur auteur.
 */
test.describe('Publicités : quand l’API n’a pas encore les brouillons', () => {
  test('🔴 le bouton d’enregistrement DISPARAÎT, et l’écran dit pourquoi', async ({ page }) => {
    await brancher(page, { brouillons: 'absent' });
    await page.getByTestId('pubs-creer').click();
    await expect(page.getByTestId('pub-formulaire')).toBeVisible();
    await expect(page.getByTestId('pub-enregistrer-brouillon')).toHaveCount(0);
    await expect(page.getByTestId('pub-brouillons-indispo')).toContainText(/mise à jour du serveur|server update/);
    // 🔴 ET LA CRÉATION RESTE POSSIBLE. Fermer le brouillon ne doit pas fermer la publicité : sa route,
    // elle, existe en production depuis le lot 3. Sans cette moitié, le correctif casserait l'écran.
    await expect(page.getByTestId('pub-creer')).toBeVisible();
  });

  test('quand l’API les a, le bouton est bien là : l’ancre positive du cas précédent', async ({ page }) => {
    // Sans elle, masquer le bouton EN TOUTES CIRCONSTANCES laisserait le cas ci-dessus vert.
    await brancher(page, { brouillons: [] });
    await page.getByTestId('pubs-creer').click();
    await expect(page.getByTestId('pub-enregistrer-brouillon')).toBeVisible();
    await expect(page.getByTestId('pub-brouillons-indispo')).toHaveCount(0);
  });
});

/**
 * 🔴 LES DEUX SENS DU 404, ET POURQUOI LES CONFONDRE COÛTE UN TRAVAIL.
 *
 * La route des brouillons rend 404 pour deux raisons qui n'ont rien à voir : « je n'existe pas » (la
 * fenêtre entre le push et le déploiement de l'API) et « ce brouillon n'existe pas » (il a été supprimé
 * entre-temps, depuis la liste rendue juste sous le formulaire).
 *
 * ⚠️ CE CAS EXISTE PARCE QU'UN CORRECTIF A CRÉÉ LE DÉFAUT. La première version du traitement du 404 les
 * habillait tous les deux en « le serveur se met à jour » : l'écran annonçait une panne passagère sur un
 * brouillon MORT, l'utilisateur réessayait, recevait le même message rassurant, et son travail était perdu
 * en silence. C'est le motif que ce dépôt a payé plusieurs fois, « chaque relecture trouve un défaut que
 * la précédente avait créé », et c'est la relecture du correctif qui l'a attrapé.
 */
test.describe('Publicités : un brouillon supprimé pendant qu’on l’édite', () => {
  /** Un PNG 1x1 valide, pour que l'aller-retour du visuel soit comparable à l'octet près. */
  const PNG_RE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const BR = {
    id: 'br-1', nom: 'En cours', titre: '', texte: '', accueil: '', messagePreRempli: '',
    budgetTotal: '', debut: '', fin: '', pays: 'FR', ageMin: '18', ageMax: '65',
    tagQualification: '', destination: 'scenario', workflowId: null, aUnVisuel: false,
    creeLe: '2026-09-24T08:00:00.000Z', modifieLe: '2026-09-24T08:00:00.000Z',
  };

  test('🔴 l’écran dit que le brouillon n’existe plus, et PAS que le serveur se met à jour', async ({ page }) => {
    await brancher(page, { brouillons: [BR], brouillonDisparu: true });
    await page.getByTestId('pub-brouillon-ouvrir-br-1').click();
    await expect(page.getByTestId('pub-formulaire')).toBeVisible();
    await page.locator('#pub-nom').fill('TRAVAIL-EN-COURS-E2E');
    await page.getByTestId('pub-enregistrer-brouillon').click();
    await expect(page.getByTestId('pub-form-erreur')).toContainText(/n’existe plus|no longer exists/);
    // 🔴 LA MOITIÉ QUI FAIT TOMBER LE DÉFAUT D'ORIGINE : le message rassurant ne doit PAS sortir ici.
    await expect(page.getByTestId('pub-form-erreur')).not.toContainText(/mise à jour du serveur|server update/);
    // Et le travail reste récupérable : le bouton repropose un enregistrement NEUF, pas une modification.
    await expect(page.getByTestId('pub-enregistrer-brouillon')).toContainText(/Enregistrer le brouillon|Save draft/);
    await expect(page.locator('#pub-nom')).toHaveValue('TRAVAIL-EN-COURS-E2E');
  });

  test('🔴 la re-création emporte le VISUEL, qui se perdait en silence', async ({ page }) => {
    /**
     * Le cas qui lit CE QUI PART, et pas ce que l'écran montre.
     *
     * L'écran continuait d'afficher l'image et d'annoncer « ce brouillon est enregistré » pendant que la
     * re-création partait SANS elle : `champsBrouillon` n'émet la clé `image` que si le visuel a été
     * TOUCHÉ, et rouvrir un brouillon ne le touche pas. Trois assertions d'écran seraient restées vertes ;
     * seule la lecture du CORPS ENVOYÉ fait tomber ce défaut. C'est la règle du dépôt : le test qui compte
     * lit ce qui part, jamais ce que la fonction rend.
     */
    await brancher(page, {
      brouillons: [{ ...BR, aUnVisuel: true }],
      detailBrouillon: { visuel: { type: 'image/png', base64: PNG_RE } },
      brouillonDisparu: true,
    });
    await page.getByTestId('pub-brouillon-ouvrir-br-1').click();
    await expect(page.getByTestId('pub-apercu-visuel')).toHaveAttribute('src', /^data:image\/png;base64,/);

    // Premier clic : la mise à jour échoue, l'écran dit que le brouillon n'existe plus.
    await page.getByTestId('pub-enregistrer-brouillon').click();
    await expect(page.getByTestId('pub-form-erreur')).toContainText(/n’existe plus|no longer exists/);

    // Second clic : celui que le message RÉCLAME. C'est une création, et elle doit porter l'image.
    await page.getByTestId('pub-enregistrer-brouillon').click();
    await expect(page.getByTestId('pub-brouillon-actif')).toBeVisible();
    const corps = await page.evaluate(() => null).then(() => corpsCreationBrouillon);
    expect(corps).not.toBeNull();
    expect(corps?.image).toMatchObject({ type: 'image/png', base64: PNG_RE });
  });
});
