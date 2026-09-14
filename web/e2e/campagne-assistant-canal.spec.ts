import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * E2E de l'assistant de campagne, étapes Nom et Canal.
 *
 * Ce que ces specs protègent, et qu'aucun test unitaire ne peut voir :
 *
 *  1. 🔴 LA LARGEUR SUR UN 13 POUCES. C'est la demande explicite de Julien (2026-09-12), et elle n'est
 *     vérifiable que dans un vrai navigateur, à une taille de fenêtre FIXÉE. Un test qui ne la fixe pas
 *     mesure l'écran de la machine qui l'exécute : il passe chez nous et rate chez le client.
 *  2. 🔴 LE NOM ACCESSIBLE DES COMMANDES. « WhatsApp », « WhatsApp et RCS, avec repli » et « WhatsApp en
 *     premier » se contiennent l'un l'autre : c'est le genre de collision qui ne se voit qu'en
 *     interrogeant le DOM rendu, et qui rend un écran impilotable au clavier comme au test.
 *  3. Les conditions d'apparition (le repli ouvre deux sous-questions, le rattrapage n'apparaît que
 *     quand quelque chose peut le déclencher), qui sont des règles de rendu, pas de calcul.
 *
 * ⚠️ `exact: true` SUR LES CANAUX, ET CE N'EST PAS UN DÉTAIL. `getByRole(..., { name })` cherche une
 * SOUS-CHAÎNE par défaut : « RCS » désignerait aussi « WhatsApp et RCS, avec repli » et « RCS en
 * premier », donc trois nœuds, donc une violation du mode strict. Le libellé exact est ce que l'écran
 * affiche, et c'est ce qu'on vise.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Les heures d'ouverture d'un espace qui en a. */
const HEURES_OUVREES = {
  '0': { closed: true, open: '', close: '' },
  '1': { closed: false, open: '09:00', close: '18:00' },
  '2': { closed: false, open: '09:00', close: '18:00' },
  '3': { closed: false, open: '09:00', close: '18:00' },
  '4': { closed: false, open: '09:00', close: '18:00' },
  '5': { closed: false, open: '09:00', close: '18:00' },
  '6': { closed: true, open: '', close: '' },
};

async function monter(
  page: Page,
  sur: { rcsEnabled?: boolean; businessHours?: unknown; etape?: string } = {},
): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: false,
        rcsEnabled: sur.rcsEnabled ?? true,
        hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
        timezone: 'Europe/Paris',
        businessHours: sur.businessHours === undefined ? HEURES_OUVREES : sur.businessHours,
      });
    }
    // Tout le reste de la coquille (badges de navigation, etc.) : une réponse vide suffit, l'écran
    // testé n'en dépend pas et une 404 ferait remonter une erreur sans rapport.
    return json({});
  });
  await page.goto(`/campaigns/nouvelle${sur.etape ? `?etape=${sur.etape}` : ''}`);
  await expect(page.getByTestId('assistant-campagne')).toBeVisible();
}

/** Ouvre l'assistant directement sur l'étape Canal, l'écran que la plupart de ces cas exercent. */
async function surCanal(page: Page, sur: { rcsEnabled?: boolean; businessHours?: unknown } = {}): Promise<void> {
  await monter(page, { ...sur, etape: 'canal' });
  await expect(page.getByTestId('etape-canal')).toBeVisible();
}

/**
 * 🔴 A L'OUVERTURE, UNE SEULE QUESTION : LE CANAL (2026-09-14, demande de Julien). « Tu poses d'abord
 * la question du canal, avant de faire apparaitre (ou pas) Reessayer les envois qui echouent, car ce truc
 * ne doit apparaitre que si la personne choisit WhatsApp ou choisit RCS ; de meme Envoyer uniquement
 * pendant les heures ouvrees, tu le fais apparaitre quand on a rempli le reste. »
 *
 * 🔴 ET LE CANAL N'A PLUS DE DEFAUT : aucune des trois entrees n'est cochee. C'est ce qui rend le
 * parcours honnete, et c'est le cas le plus facile a perdre en reintroduisant un `formule: 'whatsapp'`
 * dans l'etat initial : l'ecran redeviendrait celui d'avant sans qu'aucun autre test ne le voie.
 */
test('🔴 a l ouverture, seule la question du canal est posee', async ({ page }) => {
  await surCanal(page);
  await expect(page.getByRole('radio', { name: 'WhatsApp', exact: true })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'RCS', exact: true })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' })).toHaveCount(0);
  await expect(page.getByTestId('bloc-horaires')).toHaveCount(0);
  // 🔴 UN BOUTON GRISE DIT POURQUOI IL L'EST : sans canal, on n'avance pas, et l'ecran l'explique.
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeDisabled();
  await expect(page.getByTestId('canal-a-choisir')).toBeVisible();
});

test('🔴 le choix du canal fait apparaitre la suite, et elle disparait avec lui', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' })).toBeVisible();
  await expect(page.getByTestId('bloc-horaires')).toBeVisible();
  await expect(page.getByTestId('canal-a-choisir')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeEnabled();

  // ⚠️ LE REPLI N'EST PAS UN CANAL SEUL : le reessai s'en va, la question horaire reste. Sans ce second
  // temps, le cas ci-dessus passerait aussi sur un ecran qui montrerait tout des le premier clic.
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' })).toHaveCount(0);
  await expect(page.getByTestId('choix-ordre')).toBeVisible();
  await expect(page.getByTestId('bloc-horaires')).toBeVisible();
});

test('les trois entrees de canal, et la sous-question du premier canal', async ({ page }) => {
  await monter(page);
  await page.getByLabel('Nom de la campagne').fill('Essai');
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByText('Lequel part en premier ?')).toBeVisible();
});

test('🔴 le nom est obligatoire : sans lui, on n avance pas', async ({ page }) => {
  // Sans cette garde, la campagne arriverait sans nom à l'étape suivante et il faudrait la redemander
  // plus tard, c'est-à-dire poser deux fois la première question de l'assistant.
  await monter(page);
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeDisabled();
  await page.getByLabel('Nom de la campagne').fill('Essai');
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeEnabled();
});

test('un canal non configure est grise AVEC SA RAISON, pas masque', async ({ page }) => {
  // Espace sans agent RCS.
  await surCanal(page, { rcsEnabled: false });
  const entree = page.getByRole('radio', { name: 'RCS', exact: true });
  await expect(entree).toBeDisabled();
  await expect(page.getByText(/aucun agent RCS/i)).toBeVisible();
  // 🔴 ET LE REPLI AVEC : il a besoin des DEUX canaux. Le laisser sélectionnable construirait une
  // chaîne dont le second étage ne peut rien envoyer, et l'échec n'apparaîtrait qu'à l'envoi.
  await expect(page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' })).toBeDisabled();
});

/**
 * 🔴 IL N'Y A PLUS QU'UNE SEULE QUESTION D'HORAIRE (2026-09-13, tranche par Julien sur son essai reel).
 * L'ecran en portait DEUX, et ces tests gardaient la seconde. Elles disaient toutes deux « heures
 * d'ouverture » avec des sens OPPOSES sur l'absence d'horaires : « ne sert a rien, on a juste besoin
 * d'Envoyer uniquement pendant les heures ouvrees, cette option vaut pour les primo messages et pour les
 * relances, avec fallback ou pas ». La colonne `rattrapage_hors_horaires` est desormais DERIVEE de cette
 * case unique, et c'est `entreeDeCreation` qui l'ecrit (teste dans `lib/campagne-creation.test.ts`).
 */
test('🔴 la question du rattrapage a disparu, sur un canal seul comme sur une chaine', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' }).check();
  // Cocher le reessai etait LA cause qui faisait apparaitre la seconde question. Elle ne revient plus.
  await expect(page.getByTestId('bloc-rattrapage')).toHaveCount(0);
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByTestId('bloc-rattrapage')).toHaveCount(0);
  // ⚠️ L'AUTRE SENS, sans quoi ce test passerait aussi sur un ecran qui aurait perdu les DEUX questions.
  await expect(page.getByTestId('bloc-horaires')).toBeVisible();
});

test('🔴 le reessai n est pas propose sur une chaine : « le renvoi, c est le fallback »', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' })).toBeVisible();
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' })).toHaveCount(0);
});

// ⚠️ DEUX ENTRÉES SONT GRISÉES, ET POUR DEUX RAISONS DIFFÉRENTES qu'il vaut mieux ne pas confondre : le
// SMS n'a aucune brique fournisseur, l'e-mail a toute sa chaîne SAUF un sender de campagne. Vu de
// l'utilisateur c'est le même écran, donc le même traitement ; vu du code ce sont deux chantiers distincts.
test('SMS et e-mail sont visibles et non selectionnables', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByRole('radio', { name: /SMS/ })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /E-mail/ })).toBeDisabled();
  // 🔴 DEUX, PAS UN : `getByText` seul passerait en mode strict si une seule entrée portait le badge, donc
  // ce compte est ce qui empêche d'en dégriser une sans que ce test le dise.
  await expect(page.getByText('bientôt')).toHaveCount(2);
});

/**
 * 🔴 DEUX CAS ONT ETE RETIRES ICI, ET IL FAUT DIRE POURQUOI (2026-09-13). Ils s'appelaient « un espace
 * sans heures d ouverture le DIT au moment ou on coche » et son miroir, et ils designaient leur cible
 * par le LIBELLE `/heures d.ouverture/i`. Ce libelle ne correspondait PAS a « Envoyer uniquement pendant
 * les heures OUVREES » mais a « Ne pas envoyer le rattrapage en dehors des heures D'OUVERTURE », la
 * seconde question, retiree ce jour-la. Ils ne gardaient donc plus rien.
 *
 * ⚠️ LEUR CAS N'EST PAS PERDU, il est deja couvert plus bas, et mieux : « la case des heures ouvrees
 * previent quand l espace n a AUCUN horaire » et « un espace QUI a des horaires ne recoit pas cet
 * avertissement » exercent les deux sens sur la case qui RESTE, en la designant par son nom complet.
 * Les reecrire ici en aurait fait deux exemplaires du meme controle.
 *
 * 🔴 LA LECON, ET ELLE VAUT AU-DELA DE CE FICHIER : un test qui designe un element par son TEXTE ne
 * nomme aucun symbole, donc aucun `grep` sur le nom du champ ou sur le `data-testid` ne le trouve quand
 * on retire ce qu'il gardait. C'est la CI qui l'a dit, pas la revue.
 */

test('le second canal du repli s AFFICHE et suit le premier', async ({ page }) => {
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByText(/le repli part en RCS/i)).toBeVisible();
  await page.getByRole('radio', { name: 'RCS en premier' }).check();
  await expect(page.getByText(/le repli part en WhatsApp/i)).toBeVisible();
});

/**
 * 🔴 UNE SEULE QUESTION HORAIRE SUR L'ENVOI, ET LA JAUGE N'EST PLUS ICI (2026-09-12). L'ecran a porte
 * une journee trois « intentions de cadence » (au plus vite, etale, heures ouvrees) qui n'avaient jamais
 * ete demandees et qui retiraient la jauge de debit de l'ecran en service. Ce cas verifie les DEUX sens :
 * la question horaire est la, et aucune trace des intentions ne l'est.
 */
test('une seule question horaire sur l envoi, et plus aucune intention de cadence', async ({ page }) => {
  await surCanal(page);
  // ⚠️ LE CANAL D'ABORD, DEPUIS LE 2026-09-14 : la question horaire ne s'affiche qu'une fois le canal
  // choisi. Sans ce clic, ce cas chercherait une case que l'ecran masque a juste titre.
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Envoyer uniquement pendant les heures ouvrées' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Au plus vite' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Étalé sur la journée' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Heures ouvrées seulement' })).toHaveCount(0);
  // ⚠️ ET LA JAUGE NON PLUS : elle vit a l'etape 5, la ou l'audience est connue. La voir ici voudrait dire
  // qu'elle a ete posee deux fois, donc deux valeurs a tenir d'accord.
  await expect(page.getByTestId('campagne-debit')).toHaveCount(0);
});

/**
 * 🔴 SANS AUCUN JOUR OUVERT, CETTE CASE N'AJOURNE PAS L'ENVOI : ELLE L'ANNULE. Verifie dans le code :
 * `withinBusinessHours` rend faux sur des horaires vides, le moteur met la campagne en pause
 * `hors_horaires`, `prochaineOuverture` ne trouve aucune reprise donc `paused_until` reste nul, et le
 * balayage de reprise exige `paused_until is not null`. La campagne ne repart JAMAIS.
 *
 * ⚠️ CE FUT L'INVERSE DE LA CASE DU RATTRAPAGE, qui vivait juste au-dessus et pour qui l'absence
 * d'horaires rendait la fenetre TOUJOURS ouverte. Deux cases voisines, deux comportements opposes sur la
 * meme absence : c'est une des raisons pour lesquelles la seconde a ete retiree le 2026-09-13.
 */
test('la case des heures ouvrees previent quand l espace n a AUCUN horaire', async ({ page }) => {
  await surCanal(page, { businessHours: {} });
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await expect(page.getByTestId('horaires-absentes')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Envoyer uniquement pendant les heures ouvrées' }).check();
  await expect(page.getByTestId('horaires-absentes')).toContainText(/sans jamais la reprendre/);
});

test('un espace QUI a des horaires ne recoit pas cet avertissement', async ({ page }) => {
  // L'autre sens : sans ce cas, un avertissement affiche en permanence passerait le test precedent.
  await surCanal(page);
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Envoyer uniquement pendant les heures ouvrées' }).check();
  await expect(page.getByTestId('horaires-absentes')).toHaveCount(0);
});

// 🔴 LA GARDE DE LARGEUR, sur l'etape la plus chargee : trois entrees de canal, deux
// sous-questions, deux cases a cocher et un encart d'avertissement.
test('rien ne deborde ni ne se chevauche en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await surCanal(page, { businessHours: {} });
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await page.getByRole('radio', { name: 'RCS en premier' }).check();
  // ⚠️ L'E-MAIL NE SE COCHE PLUS (2026-09-12) : il est grisé tant qu'aucun sender de campagne ne sert ce
  // canal. Ce test le CONSTATE au lieu de le cliquer, ce qui lui ajoute une garde utile : le jour où
  // quelqu'un le rend cochable sans avoir écrit le sender, c'est ici que ça rougira.
  await expect(page.getByRole('radio', { name: /E-mail/ })).toBeDisabled();
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['choix-canal', 'choix-ordre', 'choix-troisieme']);
  // ⚠️ Le bloc des horaires est le DERNIER de l'etape : l'omettre laisserait le seul bloc non mesure
  // etre celui qui deborde.
  await pasDeChevauchement(page, ['choix-troisieme', 'bloc-horaires']);
});
