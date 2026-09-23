import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * E2E de l'étape Audience de l'assistant, après son retour au niveau de l'écran en service.
 *
 * 🔴 CE QUE CES CAS PROTÈGENT, ET POURQUOI ILS EXISTENT. L'étape a été livrée réduite à deux boutons
 * radio (« tous » / « ceux qui portent un de ces tags ») alors que l'ancien formulaire offrait les filtres
 * complets du mini-CRM, les exclusions, l'import de fichier, les listes HubSpot et la sélection ligne à
 * ligne. Aucun test ne pouvait le voir : ils vérifiaient ce que l'écran FAISAIT, pas ce qu'il avait
 * cessé de savoir faire. Chaque cas ci-dessous nomme une capacité qui doit rester là.
 *
 * 🔴 LE DERNIER CAS LIT LE CORPS DE LA REQUÊTE, ET C'EST LE SEUL QUI PROUVE QUELQUE CHOSE. Un écran peut
 * afficher des cases, les cocher, compter juste, et n'en rien envoyer : c'était exactement l'état de
 * `entreeDeCreation`, qui posait `contactTarget: { filters }` quoi qu'on ait coché. Une campagne serait
 * partie à tout ce que les filtres décrivent, donc à plus de monde que ce que l'opérateur a validé.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATES = [{ id: 't1', name: 'promo_rentree', status: 'APPROVED', category: 'MARKETING', language: 'fr', body: 'Bonjour' }];
const CHAMPS = [{ key: 'ville', label: 'Ville', type: 'text' }];

/** Trois contacts affichables, dont un opt-out : c'est ce que le mini-CRM rend vraiment. */
const CONTACTS = [
  { id: 'c1', phoneE164: '+33600000001', bsuid: null, profileName: 'Anna', optInStatus: 'opted_in', fields: {}, tags: ['vip'], createdAt: '' },
  { id: 'c2', phoneE164: '+33600000002', bsuid: null, profileName: 'Bruno', optInStatus: 'opted_in', fields: {}, tags: [], createdAt: '' },
  { id: 'c3', phoneE164: '+33600000003', bsuid: null, profileName: 'Chloé', optInStatus: 'opted_out', fields: {}, tags: [], createdAt: '' },
];

interface Options {
  etape?: string;
  hubspot?: boolean;
  hubspotEnPause?: boolean;
  /**
   * Un portail HubSpot est-il LIE (lot 9, 2026-09-23) ? `undefined` = une API anterieure a ce lot ne rend
   * pas le champ, et l'ecran garde alors le comportement d'hier.
   */
  portail?: boolean;
  /** Le total SERVEUR. Plus grand que la liste affichée = « Tout sélectionner (N) » apparaît. */
  total?: number;
  /** Les corps des POST de création, remplis au fil de l'eau. */
  creations?: Array<Record<string, unknown>>;
}

async function monter(page: Page, sur: Options = {}): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = new URL(route.request().url());
    const chemin = url.pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: false, rcsEnabled: false,
        hubspotListsEnabled: sur.hubspot === true, campaignsPaused: sur.hubspotEnPause === true,
        ...(sur.portail === undefined ? {} : { hubspotPortalConnecte: sur.portail }),
        autoRetryEnabled: true, timezone: 'Europe/Paris', businessHours: {},
      });
    }
    if (chemin.endsWith('/contacts/count')) return json({ total: sur.total ?? CONTACTS.length });
    if (chemin.endsWith('/contacts')) return json({ contacts: CONTACTS });
    if (chemin.endsWith('/templates')) return json({ templates: TEMPLATES });
    if (chemin.endsWith('/user-fields')) return json({ fields: CHAMPS });
    if (chemin.endsWith('/tags')) return json({ tags: [{ tag: 'vip', count: 1 }] });
    if (chemin.endsWith('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33 5 25 68 02 50', verifiedName: 'Engage Me' }] });
    if (chemin.endsWith('/campaigns') && route.request().method() === 'POST') {
      sur.creations?.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
      return json({ campaignId: 'camp-1', recipientCount: 2, skipped: [] });
    }
    if (chemin.endsWith('/run')) return json({ ok: true });
    return json({});
  });
  const q = new URLSearchParams({ etape: sur.etape ?? 'audience', canal: 'whatsapp' });
  await page.goto(`/campaigns/nouvelle?${q.toString()}`);
  if ((sur.etape ?? 'audience') === 'audience') await expect(page.getByTestId('etape-audience')).toBeVisible();
}

test('les filtres du mini-CRM sont la, pas deux boutons radio', async ({ page }) => {
  await monter(page);
  // 🔴 LE PANNEAU PARTAGÉ, RECONNAISSABLE À SES COMMANDES : consentement, joignabilité, étiquettes,
  // champs. Les rapatrier à la main aurait donné un second moteur de recherche à tenir d'accord.
  await expect(page.getByTestId('filtre-joignabilite')).toBeVisible();
  await expect(page.getByRole('combobox').first()).toBeVisible();
  await expect(page.getByText('Réinitialiser les filtres')).toBeVisible();
  // ⚠️ Et plus aucune trace de l'écran réduit : deux radios pour toute l'audience.
  await expect(page.getByRole('radio', { name: 'Ceux qui portent un de ces tags' })).toHaveCount(0);
});

test('la liste des contacts est cochable, et decocher retire du compte', async ({ page }) => {
  await monter(page);
  await expect(page.getByTestId('audience-compte')).toHaveText(/3 contacts retenus/);
  // Par défaut, l'audience vise « tout ce qui correspond » : décocher une ligne l'EXCLUT.
  await expect(page.getByTestId('campagne-cible-filtre')).toBeVisible();
  await page.getByTestId('destinataires-liste').getByRole('checkbox').first().uncheck();
  await expect(page.getByTestId('audience-compte')).toHaveText(/2 contacts retenus/);
});

/**
 * 🔴 L'AUTRE MODE, ET IL EST INVERSE. « Vider » bascule sur une LISTE : plus personne n'est visé tant
 * qu'on n'a rien coché, et cocher ajoute. Une implémentation qui ne tiendrait qu'un seul des deux modes
 * passerait le cas du dessus et enverrait à tout l'espace ici.
 */
test('vider bascule sur une selection ligne a ligne', async ({ page }) => {
  await monter(page);
  // ⚠️ ON ATTEND UN ÉTAT RENDU AVANT D'AGIR. Le chargement de la liste RECOCHE (des filtres qui changent
  // désignent un autre ensemble) : cliquer « Vider » pendant qu'il est en vol ferait recocher juste
  // après, et le test mesurerait une course plutôt que le comportement.
  await expect(page.getByTestId('audience-compte')).toHaveText(/3 contacts retenus/);
  await page.getByRole('button', { name: 'Vider' }).click();
  await expect(page.getByTestId('campagne-cible-filtre')).toHaveCount(0);
  await expect(page.getByTestId('audience-compte')).toHaveText(/0 contacts retenus/);
  await page.getByTestId('destinataires-liste').getByRole('checkbox').nth(1).check();
  await expect(page.getByTestId('audience-compte')).toHaveText(/1 contacts retenus/);
});

/**
 * ⚠️ « TOUT SÉLECTIONNER » N'APPARAÎT QUE QUAND LE TOTAL DÉPASSE L'AFFICHAGE, et c'est là qu'il compte :
 * il retient une INTENTION plutôt que de rapatrier jusqu'à 100 000 identifiants dans le navigateur.
 */
test('tout selectionner vise le total serveur, pas les lignes affichees', async ({ page }) => {
  await monter(page, { total: 1200 });
  await expect(page.getByTestId('audience-compte')).toHaveText(/1\s?200 contacts retenus/);
  await page.getByRole('button', { name: 'Vider' }).click();
  await page.getByRole('button', { name: /Tout sélectionner \(1200\)/ }).click();
  await expect(page.getByTestId('campagne-cible-filtre')).toContainText('1200');
  await expect(page.getByTestId('audience-compte')).toHaveText(/1\s?200 contacts retenus/);
});

test('l import de fichier est une source de l etape', async ({ page }) => {
  await monter(page);
  await page.getByRole('button', { name: '📄 Import fichier' }).click();
  // Le composant d'import partagé avec l'écran en service : sa zone de dépôt le désigne sans ambiguïté.
  await expect(page.getByTestId('destinataires-liste')).toHaveCount(0);
  await expect(page.getByText(/CSV/i).first()).toBeVisible();
});

/**
 * ⚠️ HUBSPOT EST MASQUÉ QUAND LE CONNECTEUR EST ÉTEINT, GRISÉ QUAND IL EST EN PAUSE, et les deux sont
 * délibérés : un bouton grisé pour une intégration qu'on n'a pas est du bruit (demande de Julien du
 * 2026-08-26), alors qu'une pause se lève d'un clic et mérite donc d'être vue.
 */
test('la source HubSpot suit le connecteur : absente, presente, ou grisee', async ({ page }) => {
  await monter(page);
  await expect(page.getByTestId('audience-source-hubspot')).toHaveCount(0);
});

test('HubSpot branche mais en pause : visible et grise', async ({ page }) => {
  await monter(page, { hubspot: true, hubspotEnPause: true });
  await expect(page.getByTestId('audience-source-hubspot')).toBeDisabled();
});

test('HubSpot branche et actif : cliquable', async ({ page }) => {
  await monter(page, { hubspot: true });
  await expect(page.getByTestId('audience-source-hubspot')).toBeEnabled();
});

test('🔴 interrupteur ALLUME mais AUCUN portail lie : la source disparait', async ({ page }) => {
  /**
   * LE DEFAUT QUE CE CAS INTERDIT (arbitrage de Julien du 2026-09-23). La source se masquait sur le seul
   * `hubspotListsEnabled`, qui est un INTERRUPTEUR d'espace : un client qui DELIE son portail gardait son
   * interrupteur allume, donc la source restait offerte et ne menait nulle part. Les deux drapeaux
   * repondent a deux questions, « ce client VEUT-il cette source ? » et « est-elle seulement POSSIBLE ? ».
   */
  await monter(page, { hubspot: true, portail: false });
  await expect(page.getByTestId('audience-source-hubspot')).toHaveCount(0);
});

test('🔴 interrupteur allume ET portail lie : la source revient', async ({ page }) => {
  // La preuve inverse : sans elle, un masquage qui cacherait TOUT passerait le cas du dessus.
  await monter(page, { hubspot: true, portail: true });
  await expect(page.getByTestId('audience-source-hubspot')).toBeEnabled();
});

test('⚠️ une API qui ne rend PAS le drapeau garde le comportement d hier', async ({ page }) => {
  // La fenetre entre le deploiement de la console et celui de l'API : traiter `undefined` comme « pas
  // connecte » ferait disparaitre la source d'un client qui l'a, sans recours, pendant toute la fenetre.
  await monter(page, { hubspot: true });
  await expect(page.getByTestId('audience-source-hubspot')).toBeEnabled();
});

test('l etape tient dans un 13 pouces, filtres et liste compris', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page);
  await expect(page.getByTestId('destinataires-liste')).toBeVisible();
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['audience-sources', 'destinataires-liste', 'audience-compte']);
});

/**
 * 🔴 LE SEUL CAS QUI PROUVE QUE LA SÉLECTION PART. Tout le reste vérifie un écran ; celui-ci lit le
 * CORPS de la requête de création. `entreeDeCreation` posait `contactTarget: { filters }` quoi qu'on ait
 * coché : l'écran montrait deux contacts et la campagne partait à tout l'espace, sans qu'aucun
 * compilateur, aucun test unitaire d'écran et aucune relecture d'interface ne puisse le voir.
 */
test('🔴 ce qui est coche est ce qui PART', async ({ page }) => {
  const creations: Array<Record<string, unknown>> = [];
  await monter(page, { etape: 'nom', creations });

  await page.getByLabel('Nom de la campagne').fill('Essai audience');
  await page.getByRole('button', { name: 'Suivant' }).click(); // -> canal
  await expect(page.getByTestId('etape-canal')).toBeVisible();
  // ⚠️ LE CANAL SE CHOISIT, DEPUIS LE 2026-09-14 : il n'a plus de defaut, et « Suivant » est garde tant
  // qu'aucune des trois entrees n'est cochee. Ce parcours traversait l'etape sans rien y toucher.
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await page.getByRole('button', { name: 'Suivant' }).click(); // -> contenu
  await expect(page.getByTestId('etape-contenu')).toBeVisible();
  // ⚠️ Le cadre d'un étage est REPLIÉ tant qu'on ne l'ouvre pas : sans ce clic, le sélecteur de modèle
  // n'est pas monté, et l'échec ressemble à un modèle manquant plutôt qu'à un panneau fermé.
  await page.getByRole('button', { name: /Étage 1/ }).click();
  await page.getByTestId('modele-1').selectOption('promo_rentree');
  await page.getByRole('button', { name: 'Suivant' }).click(); // -> audience

  await expect(page.getByTestId('etape-audience')).toBeVisible();
  await expect(page.getByTestId('audience-compte')).toHaveText(/3 contacts retenus/);
  await page.getByRole('button', { name: 'Vider' }).click();
  await page.getByTestId('destinataires-liste').getByRole('checkbox').nth(0).check();
  await page.getByTestId('destinataires-liste').getByRole('checkbox').nth(1).check();
  await expect(page.getByTestId('audience-compte')).toHaveText(/2 contacts retenus/);

  await page.getByRole('button', { name: 'Suivant' }).click(); // -> recap
  await page.getByTestId('bouton-lancer').click();
  await expect(page.getByTestId('recap-lancee')).toBeVisible();

  expect(creations).toHaveLength(1);
  expect(creations[0]!.contactIds).toEqual(['c1', 'c2']);
  // ⚠️ ET SURTOUT PAS LES DEUX : le serveur refuse une création qui porte une liste ET des filtres, et
  // laisser passer les filtres ici viserait tout l'espace pendant que l'écran annonce deux personnes.
  expect(creations[0]!.contactTarget).toBeUndefined();
});
