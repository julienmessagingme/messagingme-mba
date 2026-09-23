import { test, expect } from '@playwright/test';

/**
 * La FICHE d'une campagne, ouverte en cliquant une ligne du tableau du coût (demande de Julien du
 * 2026-09-09).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et ce n'est pas l'affichage : les quatre décisions qui rendent les chiffres
 * lisibles. Le dénominateur est le LANCEMENT et pas tous les envois ; les échecs sont montrés à part ;
 * « lu » n'est pas une interaction ; et la fiche couvre toute la VIE de la campagne alors que le tableau
 * d'où l'on vient est sur la période. Chacune se casse sans qu'aucun test de calcul ne bouge, parce
 * qu'elles vivent dans ce que l'écran MONTRE.
 *
 * Le calcul, lui, est tenu par `tests/cout-campagne.test.ts`, sans navigateur.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const COUT = {
  lignes: [
    { campaignId: 'c-promo', nom: 'Promo été', template: 'promo', envoyes: 120, cout: 17.17, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: 8, coutParClic: 2.1463 },
    { campaignId: 'c-parcours', nom: 'Parcours bienvenue', template: null, envoyes: 40, cout: 5.72, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0, clics: null, coutParClic: null },
  ],
  currency: 'EUR', hasRates: true, tronque: false,
};

/** Une campagne à SCÉNARIO : lancement, relances hors ratio, et trois étapes dont une sans interaction. */
const DETAIL_SCENARIO = {
  campaignId: 'c-parcours', nom: 'Parcours bienvenue', template: null, workflowId: 'wf-1', devise: 'EUR',
  lancement: {
    envoyes: 40, cout: 5.72, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0,
    echecs: 3, clics: null, coutParClic: null, reponses: 21, boutons: 14,
  },
  relances: { envoyes: 12, cout: 1.72, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0 },
  etapes: [
    { nodeId: 'n1', envoyes: { gestes: 40, personnes: 40 }, liens: { gestes: 7 }, boutons: { gestes: 14, personnes: 11 }, reponses: { gestes: 6, personnes: 6 }, interactions: 27, coutParInteraction: 0.2119 },
    // Un bloc qui a bien ENVOYÉ et été LU, mais où personne n'a agi : aucun ratio.
    { nodeId: 'n3', envoyes: { gestes: 5, personnes: 5 }, liens: { gestes: 0 }, boutons: { gestes: 0, personnes: 0 }, reponses: { gestes: 0, personnes: 0 }, interactions: 0, coutParInteraction: null },
  ],
  clicsAnonymes: 4,
};

/** Une campagne à template DIRECT : pas de scénario, donc pas d'étapes, mais des clics mesurés. */
const DETAIL_DIRECT = {
  campaignId: 'c-promo', nom: 'Promo été', template: 'promo', workflowId: null, devise: 'EUR',
  lancement: {
    envoyes: 120, cout: 17.17, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0,
    echecs: 0, clics: 8, coutParClic: 2.1463, reponses: 12, boutons: 5,
  },
  relances: { envoyes: 0, cout: null, nonChiffrables: 0, sansCategorie: 0, sansTarif: 0 },
  etapes: [],
  clicsAnonymes: 0,
};

const GRAPH = {
  nodes: [
    { id: 'n1', type: 'template', data: { templateName: 'bienvenue' } },
    { id: 'n3', type: 'template', data: { templateName: 'relance_j3' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n3' }],
};

async function mock(page: import('@playwright/test').Page, detail: unknown = DETAIL_SCENARIO, statutDetail = 200) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // ⚠️ La fiche AVANT le tableau : les deux adresses se ressemblent, et `/campaigns` seul attraperait
    // aussi `/campaigns/<id>`. C'est le genre d'ordre qui rend un test vert pour la mauvaise raison.
    if (/\/stats\/cost\/campaigns\/[^/?]+/.test(url)) {
      return statutDetail === 200
        ? json(detail)
        : route.fulfill({ status: statutDetail, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) });
    }
    if (url.includes('/stats/cost/campaigns')) return json(COUT);
    if (/\/workflows\/wf-1/.test(url)) return json({ workflow: { id: 'wf-1', name: 'Parcours', graph: GRAPH } });
    if (url.includes('/stats/conversations/nuage')) return json({ points: [], moyenne: null, mesurees: 0, sansMesure: 0 });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

/**
 * ⚠️ LE TABLEAU DES CAMPAGNES EST DANS UN ACCORDEON DEPUIS LE 2026-09-17 : la carte de synthese ne montre
 * plus qu un chiffre par ligne, et le detail se deplie. La fiche s ouvre donc en DEUX gestes au lieu d un,
 * et ce helper porte le premier. Les CAS exerces plus bas n ont pas bouge d un mot.
 */
/**
 * ⚠️ LES CHIFFRES EXACTS SONT REPLIES DEPUIS LE 2026-09-17 : la fiche montre d abord l entonnoir en
 * barres, et le tableau derriere un depliant (Julien : « je veux voir un autre truc que ton tableau
 * pourri »). Les CAS exerces plus bas n ont pas bouge ; seul le geste pour y arriver est nouveau.
 */
async function ouvrirChiffres(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('detail-etapes-table').locator('summary').click();
}

async function ouvrirEngagement(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('cout-bascule-engagement').click();
}

test.describe('Performance Lab : la fiche d’une campagne', () => {
  test('cliquer une ligne ouvre la fiche, avec le nom de la campagne', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await expect(page.getByTestId('detail-lancement')).toHaveCount(0);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('detail-lancement')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('Parcours bienvenue');
  });

  test('🔴 la fiche DIT qu’elle ne suit pas la période du tableau', async ({ page }) => {
    // Le tableau est sur 30 jours, la fiche sur toute la vie de la campagne : deux chiffres différents pour
    // la même campagne, à deux centimètres l'un de l'autre. Sans la phrase, l'écart se lit comme un bug.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByRole('dialog')).toContainText(/toute la vie de la campagne|whole life/i);
  });

  test('🔴 les ÉCHECS sont montrés, et à part du coût', async ({ page }) => {
    // La question de Julien entre parenthèses (« tu enlèves bien les failed j'espère ! »). Ils sont hors du
    // coût par construction ; l'écran doit le MONTRER, sinon rien ne distingue « exclus » de « oubliés ».
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('detail-echecs')).toContainText('3');
    await expect(page.getByTestId('detail-cout')).toContainText('5,72');
  });

  test('🔴 les RELANCES du scénario sont affichées, et hors du ratio', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('detail-relances')).toContainText('12');
    await expect(page.getByTestId('detail-relances')).toContainText('1,72');
    // Le coût du lancement, lui, ne les compte pas : 5,72 et non 7,44.
    await expect(page.getByTestId('detail-cout')).toContainText('5,72');
    await expect(page.getByTestId('detail-cout')).not.toContainText('7,44');
  });

  test('les étapes portent le NOM des blocs, lu dans le graphe du scénario', async ({ page }) => {
    // Les libellés viennent de `mesures-scenario.ts`, la seule source de ces noms dans le dépôt. Sans lui,
    // le tableau afficherait des identifiants techniques à un opérateur.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await ouvrirChiffres(page);
    await expect(page.getByTestId('detail-etape-n1')).toContainText('bienvenue');
    await expect(page.getByTestId('detail-etape-n3')).toContainText('relance_j3');
  });

  test('🔴 les deux unités : gestes, et personnes quand elles diffèrent', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await ouvrirChiffres(page);
    // 14 taps par 11 personnes : les deux, parce qu'ils répondent à deux questions.
    await expect(page.getByTestId('detail-etape-n1')).toContainText(/14 \(11/);
    // 6 réponses par 6 personnes : « 6 (6 pers.) » n'ajoute rien et alourdit la colonne.
    await expect(page.getByTestId('detail-etape-n1')).not.toContainText('(6');
  });

  test('🔴 un bloc ENVOYÉ mais sans geste n’a pas de coût par interaction', async ({ page }) => {
    // Le piège du lot : compter « envoyé » ou « lu » comme une interaction ferait tomber le ratio au prix
    // d'un envoi, donc ferait passer une campagne que personne n'a lue pour parfaitement efficace.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await ouvrirChiffres(page);
    await expect(page.getByTestId('detail-etape-n3')).toContainText('5');
    await expect(page.getByTestId('detail-ratio-n3')).toHaveText('—');
    await expect(page.getByTestId('detail-ratio-n1')).toContainText('0,2119');
  });

  test('🔴 les clics de lien ATTRIBUÉS ont leur colonne, et comptent dans le ratio', async ({ page }) => {
    // Cette colonne a failli ne pas exister, sur une justification fausse (« un clic n'identifie
    // personne »). La migration 0106 écrit `tracked_link_clicks.contact_id` : c'est vrai d'un lien SANS
    // jeton, faux de tous les autres. Le test garde la colonne ET son dénominateur commun.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await ouvrirChiffres(page);
    await expect(page.getByTestId('detail-liens-n1')).toHaveText('7');
    // 1,43... non : 5,72 / 27 = 0,2119. Le ratio porte bien sur les TROIS natures.
    await expect(page.getByTestId('detail-ratio-n1')).toContainText('0,2119');
  });

  test('🔴 les clics ANONYMES sont dits, avec leur raison et leur date', async ({ page }) => {
    // Ils ne sont dans aucune colonne : les taire laisserait croire la colonne complète, les y ajouter
    // affirmerait qu'ils viennent d'ici. La phrase dit les deux, et ce qui les rend définitifs.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await ouvrirChiffres(page);
    await expect(page.getByTestId('detail-liens-reserve')).toContainText('4');
    await expect(page.getByTestId('detail-liens-reserve')).toContainText(/2 septembre 2026|2 September 2026/);
    await expect(page.getByTestId('detail-liens-reserve')).not.toContainText(/n’identifie personne|identifies nobody/);
  });

  test('une campagne à template DIRECT n’a pas de section « étape par étape »', async ({ page }) => {
    await mock(page, DETAIL_DIRECT);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-promo').click();
    await expect(page.getByTestId('detail-lancement')).toBeVisible();
    await expect(page.getByTestId('detail-etapes')).toHaveCount(0);
    await expect(page.getByTestId('detail-cout-clic')).toContainText('2,15');
  });

  test('Échap ferme la fiche', async ({ page }) => {
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('detail-lancement')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('detail-lancement')).toHaveCount(0);
  });

  test('🔴 un backend qui refuse -> un message, pas une fiche vide ni une page morte', async ({ page }) => {
    await mock(page, DETAIL_SCENARIO, 500);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('detail-erreur')).toBeVisible();
    // Et le tableau derrière est intact : une fiche qui échoue n'emporte pas l'écran.
    await expect(page.getByTestId('cout-ligne-c-promo')).toBeVisible();
  });

  test('🔴 une API plus ANCIENNE que les colonnes ne tue pas la fiche', async ({ page }) => {
    // La console part sur Vercel a chaque push, l'API se deploie a la main sur le VPS : il existe une
    // fenetre ou le nouveau front interroge l'ancienne API, qui rend des etapes sans `liens`. Un acces
    // direct y jetterait EN PLEIN RENDU, ce qui n'emporte pas la colonne mais la PAGE.
    const ancien = {
      ...DETAIL_SCENARIO,
      etapes: [{ nodeId: 'n1', envoyes: { gestes: 40, personnes: 40 }, boutons: { gestes: 14, personnes: 11 }, reponses: { gestes: 6, personnes: 6 }, interactions: 20, coutParInteraction: 0.286 }],
      clicsAnonymes: undefined,
    };
    await mock(page, ancien);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await ouvrirChiffres(page);
    await expect(page.getByTestId('detail-etape-n1')).toBeVisible();
    await expect(page.getByTestId('detail-liens-n1')).toHaveText('0');
    await expect(page.getByTestId('detail-ratio-n1')).toContainText('0,2860');
  });

  test('🔴 L ENTONNOIR EN BARRES est ce qu on voit d abord, le tableau est replie', async ({ page }) => {
    // Julien, le 2026-09-17 : « je veux voir un autre truc que ton tableau pourri [...] un tableau avec
    // des barres verticales ». Les barres repondent a la question qu on se pose en ouvrant la fiche ; le
    // tableau garde les chiffres exacts, mais derriere un depliant.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('funnel-nodes')).toBeVisible();
    await expect(page.getByTestId('funnel-node-n1')).toBeVisible();
    await expect(page.getByTestId('detail-etape-n1')).toBeHidden();
  });

  test('🔴 les barres comptent des PERSONNES, sauf les liens qui comptent des GESTES et le disent', async ({ page }) => {
    // EtapeCoutCampagne.liens n a PAS de compte de personnes et n en aura jamais : les clics s agregent
    // par CODE de lien, pas par contact. Afficher un nombre de personnes y serait une invention, et
    // aligner silencieusement deux unites dans le meme graphe est exactement le chiffre plausible et faux
    // que cet ecran doit eviter.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    // n1 : 14 gestes de bouton pour 11 personnes. La barre montre 11.
    await expect(page.getByTestId('funnel-boutons-n1')).toHaveText('11');
    await expect(page.getByTestId('funnel-legende')).toContainText(/gestes|gestures/);
  });

  test('⚠️ une API plus ANCIENNE, sans la colonne des liens, ne fait pas tomber les barres', async ({ page }) => {
    const ancien = {
      ...DETAIL_SCENARIO,
      etapes: [{ nodeId: 'n1', envoyes: { gestes: 40, personnes: 40 }, boutons: { gestes: 14, personnes: 11 }, reponses: { gestes: 6, personnes: 6 }, interactions: 20, coutParInteraction: 0.286 }],
    };
    await mock(page, ancien);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('funnel-liens-n1')).toHaveText('0');
    await expect(page.getByTestId('funnel-envoyes-n1')).toHaveText('40');
  });
  test('🔴 le titre de la fiche MÈNE aux résultats de la campagne (Quantitatif > Funnel)', async ({ page }) => {
    // Demande de Julien du 2026-09-23. On lit un coût, on veut voir ce qu'il a produit : le nom de la
    // campagne est le chemin le plus court, et c'est un LIEN (clic du milieu, copie, partage), avec la même
    // adresse que le bouton « Voir les résultats » de l'onglet Campagnes.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ligne-c-parcours').click();
    await expect(page.getByTestId('modale-titre-lien')).toHaveAttribute('href', '/dashboard/funnel?campagne=c-parcours');
  });

  test('le nom de la campagne est un vrai bouton, donc atteignable au clavier', async ({ page }) => {
    // Un `<tr onClick>` seul est invisible d'un lecteur d'écran et inatteignable sans souris.
    await mock(page);
    await page.goto('/performance');
    await ouvrirEngagement(page);
    await page.getByTestId('cout-ouvrir-c-parcours').press('Enter');
    await expect(page.getByTestId('detail-lancement')).toBeVisible();
  });
});
