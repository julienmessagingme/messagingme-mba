import { test, expect } from '@playwright/test';

/**
 * LA CARTE « COUTS » DE LA SYNTHESE : trois chiffres, et le detail derriere un accordeon.
 *
 * 🔴 CE QUE CE FICHIER PROTEGE : les cases qui doivent rester VIDES plutot que d afficher zero. Un zero est
 * une affirmation (« ca n a rien coute », « personne ne s est engage ») ; l absence dit « on ne peut pas
 * repondre », et c est la verite dans ces cas-la. Le client decide de son budget sur cet ecran : un zero de
 * trop y coute plus cher qu une case vide.
 *
 * ⚠️ CE FICHIER A ETE REECRIT LE 2026-09-17, QUAND LE TABLEAU EST DEVENU UNE CARTE A TROIS LIGNES. Trois
 * cas qu il exercait ont change de gardien plutot que de disparaitre, et c est dit ici pour qu on puisse le
 * verifier :
 *  - les CLICS et le cout par clic ne sont plus dans la synthese : ils vivent dans la fiche d une campagne,
 *    tenue par `performance-detail-campagne.spec.ts` (colonne des liens, clics anonymes avec leur date) ;
 *  - la reserve « template approuve avant le 2026-09-02 » a suivi les clics dans la meme fiche ;
 *  - le compte des envois non chiffrables est passe de la ligne « engagement » a la ligne « messages », ou
 *    il est verifie plus bas.
 * Le calcul lui-meme reste tenu sans navigateur : `tests/cost.test.ts`, `tests/cout-messages.test.ts` et
 * `web/lib/cout-moyen.test.ts`.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const COUT = {
  lignes: [
    // Une campagne complete : un cout, des engages, donc un ratio.
    { campaignId: 'c-promo', nom: 'Promo été', template: 'promo', envoyes: 120, cout: 17.17, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: 8, coutParClic: 2.1463, engagements: 10, coutParEngagement: 1.717 },
    // Une campagne a SCENARIO : pas de template, mais des gens qui ont repondu.
    { campaignId: 'c-parcours', nom: 'Parcours bienvenue', template: null, envoyes: 40, cout: 5.72, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null, engagements: 4, coutParEngagement: 1.43 },
    // Une campagne dont AUCUN envoi n est chiffrable : elle sort du calcul, des DEUX termes.
    { campaignId: 'c-inconnue', nom: 'Relance', template: 'relance', envoyes: 30, cout: null, nonChiffrables: 30, sansCategorie: 30, sansTarif: 0, clics: 0, coutParClic: null, engagements: 2, coutParEngagement: null },
  ],
  currency: 'EUR',
  hasRates: true,
  tronque: false,
};

const MESSAGES = {
  templates: { marketing: 17.17, utility: 3.2 },
  service: {
    envoyes: 340, factures: 0, cout: 0,
    parMois: [{ mois: '2026-09', consommes: 340, plafond: 1000, factures: 0 }],
  },
  rcs: { simple: 10, conversationnel: 5, cout: 1 },
  total: 21.37,
  // 🔴 LA DEVISE VIENT DE CETTE ROUTE-CI, pas de celle des campagnes : c est ce que la revue du
  // 2026-09-17 a corrige, et le test « les deux autres gardent leur devise » le garde.
  currency: 'EUR',
  nonChiffrables: 30,
  sansCategorie: 30,
  sansTarif: 0,
};

const IA = {
  coutMicroEur: 1_250_000,
  tokensEntree: 4000,
  tokensSortie: 900,
  sessions: 2,
  tours: [
    { id: 's1', agentId: 'a1', tours: 3, tokensEntree: 2500, tokensSortie: 600, coutMicroEur: 800_000, at: '2026-09-15T10:00:00Z' },
    { id: 's2', agentId: 'a1', tours: 1, tokensEntree: 1500, tokensSortie: 300, coutMicroEur: 450_000, at: '2026-09-14T09:00:00Z' },
  ],
  tronque: false,
};

async function mock(
  page: import('@playwright/test').Page,
  opts: { cout?: unknown; messages?: unknown; ia?: unknown; statutCout?: number } = {},
) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ LES TROIS ADRESSES DE COUT SE RESSEMBLENT, et l ordre compte : `/stats/cost/campaigns` seul
    // attraperait aussi `/stats/cost/messages` si on le testait par prefixe. C est le genre d ordre qui rend
    // un test vert pour la mauvaise raison.
    if (url.includes('/stats/cost/messages')) return json(opts.messages ?? MESSAGES);
    if (url.includes('/stats/cost/ia')) return json(opts.ia ?? IA);
    if (url.includes('/stats/cost/campaigns')) {
      if (opts.statutCout && opts.statutCout !== 200) {
        return route.fulfill({ status: opts.statutCout, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) });
      }
      return json(opts.cout ?? COUT);
    }
    if (url.includes('/stats/conversations/nuage')) return json({ points: [], moyenne: null, mesurees: 0, sansMesure: 0 });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Performance Lab : la carte des couts', () => {
  test('🔴 UN SEUL CHIFFRE par ligne, et le detail reste replie', async ({ page }) => {
    // Demande de Julien du 2026-09-17 : « je veux 1 seul chiffre a ce niveau la ». Le tableau des campagnes
    // ne doit pas etre visible tant qu on n a pas deplie, sinon la carte redevient ce qu elle etait.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-valeur-engagement')).toBeVisible();
    await expect(page.getByTestId('cout-ligne-c-promo')).toHaveCount(0);
  });

  test('🔴 le chiffre est le RAPPORT DES TOTAUX, pas la moyenne des ratios', async ({ page }) => {
    // (17,17 + 5,72) / (10 + 4) = 1,635. La moyenne des ratios rendrait (1,717 + 1,43) / 2 = 1,5735.
    // La campagne sans cout chiffrable sort des DEUX termes, elle ne pese sur aucun des deux.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-valeur-engagement')).toContainText('1,64');
  });

  test('🔴 le DENOMINATEUR REEL est dit, sinon le lecteur refait la division et trouve autre chose', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-engagement').click();
    await expect(page.getByTestId('cout-denominateur')).toContainText('2');
    await expect(page.getByTestId('cout-denominateur')).toContainText(/écartée|left out/);
  });

  test('deplie, chaque campagne montre envoyes, engages et son ratio', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-engagement').click();
    await expect(page.getByTestId('cout-engages-c-promo')).toHaveText('10');
    await expect(page.getByTestId('cout-ratio-engage-c-promo')).toContainText('1,72');
  });

  test('🔴 une campagne sans cout chiffrable a une case VIDE, pas un zero', async ({ page }) => {
    // Un zero se lirait « cette campagne n a rien coute », alors que la verite est « on ne sait pas ce
    // qu elle a coute ». Les deux appellent des gestes opposes.
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-engagement').click();
    await expect(page.getByTestId('cout-ratio-engage-c-inconnue')).toHaveText('—');
  });

  test('🔴 zero clic mais des engages : la colonne engagement est REMPLIE', async ({ page }) => {
    // Le cas reel de Julien (2026-09-13) : « le destinataire n a pas clique mais en revanche il a repondu,
    // c est comme un clic ». La campagne a scenario n a aucun clic mesurable et quatre personnes engagees.
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-engagement').click();
    await expect(page.getByTestId('cout-engages-c-parcours')).toHaveText('4');
    await expect(page.getByTestId('cout-ratio-engage-c-parcours')).not.toHaveText('—');
  });

  test('⚠️ une reponse SANS les champs d engagement ne casse pas l ecran', async ({ page }) => {
    // 🔴 LE CAS EST REEL : la console part sur Vercel a chaque push, l API se deploie a la main sur le VPS.
    // Entre les deux, `engagements` est absent de la reponse. `undefined` n est pas zero.
    const sansChamps = { ...COUT, lignes: [{ ...COUT.lignes[0], engagements: undefined, coutParEngagement: undefined }] };
    await mock(page, { cout: sansChamps });
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-engagement').click();
    await expect(page.getByTestId('cout-engages-c-promo')).toHaveText('—');
    await expect(page.getByTestId('cout-ratio-engage-c-promo')).toHaveText('—');
  });

  test('🔴 Meta ne rend aucun tarif -> la carte le DIT au lieu d afficher des zeros', async ({ page }) => {
    const sansTarif = {
      ...COUT, hasRates: false,
      lignes: [{ ...COUT.lignes[0], cout: null, coutParClic: null, coutParEngagement: null }],
    };
    await mock(page, { cout: sansTarif });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-valeur-engagement')).toContainText('—');
    await expect(page.getByTestId('cout-bloc-engagement')).toContainText(/mesurable|measurable/);
  });

  test('aucune campagne sur la periode -> une phrase, pas un chiffre invente', async ({ page }) => {
    await mock(page, { cout: { ...COUT, lignes: [] } });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-bloc-engagement')).toContainText(/mesurable|measurable/);
  });

  test('🔴 la periode compte plus de campagnes que le tableau -> il le DIT', async ({ page }) => {
    // Une troncature muette se lit comme un inventaire complet.
    await mock(page, { cout: { ...COUT, tronque: true } });
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-engagement').click();
    await expect(page.getByTestId('cout-tronque')).toBeVisible();
  });

  test('🔴 un corps MAL FORME ne tue pas la page : les autres lignes restent affichees', async ({ page }) => {
    // 🔴 LE TYPE MENT SUR UNE DONNEE DE RESEAU. Un `.map` sur un corps sans `lignes` jette EN PLEIN RENDU,
    // et ce n est pas la carte qui tombe alors, c est la PAGE, donc aussi le nuage d a cote qui n a rien
    // demande. Mesure le 2026-09-08 sur l ancienne carte, garde ici.
    await mock(page, { cout: { pas: 'la bonne forme' } });
    // ⚠️ Le nuage doit RENDRE SON CONTENU, pas seulement exister : c est ce que l ancienne version de ce
    // test exigeait, et un cadre vide ne prouverait pas que la page a survecu au corps mal forme.
    await page.route('**/stats/conversations/nuage**', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ points: [{ satisfaction: 4, urgence: 6, n: 1 }], moyenne: { satisfaction: 4, urgence: 6 }, mesurees: 1, sansMesure: 0 }),
    }));
    await page.goto('/performance');
    await expect(page.getByTestId('cout-erreur-engagement')).toBeVisible();
    // Les deux autres lignes de la carte, et la carte d a cote, sont intactes.
    await expect(page.getByTestId('cout-valeur-messages')).toContainText('21,37');
    await expect(page.getByTestId('nuage-point-4-6')).toBeVisible();
  });

  test('🔴 un backend qui refuse -> un message sur CETTE ligne, et les deux autres vivent', async ({ page }) => {
    // C est la raison d etre des trois appels separes : une panne d un tiers du contenu ne doit pas faire
    // disparaitre les deux autres tiers.
    await mock(page, { statutCout: 503 });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-erreur-engagement')).toBeVisible();
    await expect(page.getByTestId('cout-valeur-ia')).toBeVisible();
  });

  test('🔴 ...et les deux autres gardent leur DEVISE, pas seulement leur nombre', async ({ page }) => {
    /**
     * 🔴 CE TEST EXISTE PARCE QUE LE PRECEDENT PASSAIT DEJA SANS LUI, SUR UN ECRAN FAUX. La premiere version
     * de la carte prenait la devise de la route des campagnes pour TOUTE la carte : quand cette route
     * tombait, le total des messages s affichait « 21,37 » au lieu de « 21,37 € ». Le nombre etait bien la,
     * donc « les deux autres vivent » restait vert. Une assertion qui passe dans les deux cas ne prouve
     * rien, et c est precisement ce que la revue du 2026-09-17 a trouve.
     *
     * ⚠️ MUTATION VERIFIEE : en faisant revenir la devise de la route des campagnes, ce test echoue et
     * l autre reste vert.
     */
    await mock(page, { statutCout: 503 });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-valeur-messages')).toContainText('€');
  });

  test('⚠️ aucune campagne sur la periode : l accordeon ne s ouvre pas sur un tableau vide', async ({ page }) => {
    // ⚠️ MAIS IL S OUVRE QUAND DES CAMPAGNES EXISTENT SANS ETRE MESURABLES : le tableau montre alors
    // lesquelles et pourquoi leur case est vide, ce qui est l explication qu on vient chercher. Le critere
    // est donc « y a-t-il des lignes », pas « y a-t-il un chiffre ».
    await mock(page, { cout: { ...COUT, lignes: [] } });
    await page.goto('/performance');
    await expect(page.getByTestId('cout-bascule-engagement')).toBeDisabled();
  });
});

test.describe('Performance Lab : le cout des messages', () => {
  test('le total s affiche, et le detail se deplie en quatre postes', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-valeur-messages')).toContainText('21,37');
    await page.getByTestId('cout-bascule-messages').click();
    await expect(page.getByTestId('cout-bloc-messages')).toContainText(/Templates marketing|Marketing templates/);
    await expect(page.getByTestId('cout-bloc-messages')).toContainText('RCS');
  });

  test('🔴 la FRANCHISE est celle du MOIS, sur une ligne a part de la periode', async ({ page }) => {
    // Decision de Julien du 2026-09-17. Proratiser 1000 sur sept jours aurait produit un nombre invente,
    // et un client construit un budget dessus.
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-messages').click();
    await expect(page.getByTestId('cout-franchise')).toContainText('340');
    await expect(page.getByTestId('cout-franchise')).toContainText('1');
    await expect(page.getByTestId('cout-franchise')).toContainText('2026-09');
  });

  test('🔴 une periode a cheval sur DEUX mois montre DEUX franchises', async ({ page }) => {
    // La franchise se remet a zero le 1er. Une seule ligne ferait croire a une franchise unique sur la
    // periode, donc a mille messages offerts au lieu de deux mille.
    const deuxMois = {
      ...MESSAGES,
      service: {
        ...MESSAGES.service,
        parMois: [
          { mois: '2026-09', consommes: 1200, plafond: 1000, factures: 200 },
          { mois: '2026-10', consommes: 300, plafond: 1000, factures: 0 },
        ],
      },
    };
    await mock(page, { messages: deuxMois });
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-messages').click();
    await expect(page.getByTestId('cout-franchise')).toContainText('2026-09');
    await expect(page.getByTestId('cout-franchise')).toContainText('2026-10');
  });

  test('🔴 les envois NON CHIFFRABLES sont comptes, et leurs DEUX causes distinguees', async ({ page }) => {
    // ⚠️ CE CAS VIENT DE LA LIGNE « engagement », ou il vivait avant le 2026-09-17. Les deux causes ne se
    // reparent pas pareil : une categorie absente est un heritage clos, un tarif manquant est une panne du
    // jour. Un seul nombre les confondrait.
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-messages').click();
    await expect(page.getByTestId('cout-non-chiffrables')).toContainText('30');
    await expect(page.getByTestId('cout-non-chiffrables')).toContainText(/catégorie enregistrée|recorded category/);
  });

  test('🔴 la ligne renvoie vers la FACTURE REELLE de Meta, que cette carte ne porte pas', async ({ page }) => {
    // L ecart entre notre estimation et ce que Meta facture est la question qui revient a chaque lecture,
    // et le seul ecran qui y repond est le sous-onglet Couts.
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-messages').click();
    await expect(page.getByTestId('cout-vers-facture')).toHaveAttribute('href', '/dashboard/couts');
  });
});

test.describe('Performance Lab : le cout de l IA', () => {
  test('le total s affiche en euros, depuis des micro-euros', async ({ page }) => {
    // 1 250 000 micro-euros = 1,25 euro. L arrondi est un geste d AFFICHAGE : le serveur ne l a pas fait,
    // sinon le total divergerait de la somme de ses lignes.
    await mock(page);
    await page.goto('/performance');
    await expect(page.getByTestId('cout-valeur-ia')).toContainText('1,25');
  });

  test('🔴 la ligne DIT ce qu elle ne compte pas : le Meta Business Agent', async ({ page }) => {
    // Il tourne CHEZ Meta, qui le facture au message de service : son cout est dans la ligne du dessus.
    // Sans cette phrase, un client qui voit son agent Meta repondre toute la journee conclura que la mesure
    // est fausse.
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-ia').click();
    await expect(page.getByTestId('cout-ia-perimetre')).toContainText(/Meta Business Agent/);
  });

  test('deplie, chaque tour montre ses tokens et son cout', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-ia').click();
    await expect(page.getByTestId('cout-ia-ligne')).toHaveCount(2);
    // 2500 + 600 = 3100 tokens sur le premier tour.
    await expect(page.getByTestId('cout-ia-ligne').first()).toContainText('3');
  });

  test('🔴 aucune consommation n est un etat NORMAL, pas une panne', async ({ page }) => {
    // Mesure le 2026-09-17 : `agent_sessions` est VIDE en production. La carte doit le dire, jamais
    // afficher un tiret qui se lirait comme une mesure manquante.
    await mock(page, { ia: { coutMicroEur: 0, tokensEntree: 0, tokensSortie: 0, sessions: 0, tours: [], tronque: false } });
    await page.goto('/performance');
    await page.getByTestId('cout-bascule-ia').click();
    await expect(page.getByTestId('cout-ia-vide')).toBeVisible();
  });
});
