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
  comptePubId: '111' as string | null, compteNom: 'GMC', pageId: 'p1' as string | null, pageNom: 'Page test', devise: 'EUR',
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
    // La page d'une publicité, AVANT la liste : `/pubs/pub-1` contient `/pubs`, donc l'ordre compte.
    if (/\/pubs\/[^/]+$/.test(url.split('?')[0] ?? '')) {
      return json({ publicite: PUB_PUBLIEE, entonnoir: o.entonnoir ?? ENTONNOIR_VIDE });
    }
    if (url.includes('/pubs')) return json({ publicites: o.publicites ?? [] });
    if (url.includes('/workflows')) return json({ workflows: [] });
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
