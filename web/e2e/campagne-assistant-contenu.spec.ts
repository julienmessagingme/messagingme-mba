import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * E2E de l'assistant de campagne, étape Contenu.
 *
 * 🔴 C'EST L'ÉTAPE LA PLUS EXPOSÉE AU DÉBORDEMENT : trois cadres d'étage, un éditeur de modèle, un
 * éditeur de suggestions RCS (le composant le plus large de la console) et le bloc du devenir de la
 * conversation. Deux cas la mesurent à 1280 x 800, et l'un d'eux vérifie en plus l'EMPILEMENT, qui est
 * la décision de conception qui évite le problème au lieu de le détecter.
 *
 * ⚠️ L'ÉTAT D'OUVERTURE PASSE PAR L'ADRESSE (`?etape=contenu&canal=repli&troisieme=email`). Sans cela,
 * chaque cas devrait rejouer l'étape Canal au clic, ce qui ferait dépendre ces vérifications-ci du bon
 * fonctionnement de l'écran d'à côté : un test de l'étape 3 qui rougit parce que l'étape 2 a bougé ne
 * dit plus ce qu'il vérifie.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATES = [
  { id: 't1', name: 'promo_rentree', status: 'APPROVED', category: 'MARKETING', language: 'fr' },
  { id: 't2', name: 'rappel_rdv', status: 'APPROVED', category: 'UTILITY', language: 'fr' },
  // ⚠️ Un non approuvé : le sélecteur ne doit jamais proposer ce qui ne partira pas.
  { id: 't3', name: 'brouillon_promo', status: 'PENDING', category: 'MARKETING', language: 'fr' },
];
const WORKFLOWS = [{ id: 'wf1', name: 'Prise de RDV', campaignEligible: true }];
const EMAIL_TEMPLATES = [{ id: 'em1', name: 'Relance e-mail', format: 'html', subject: 's', body: 'b', createdAt: '', updatedAt: '' }];
/**
 * L'ÉQUIPE TELLE QUE LE SERVEUR LA REND, ET TELLE QUE LE VRAI MONDE EST FAIT.
 *
 * 🔴 CETTE FIXTURE DÉCRIT L'ESPACE DE JULIEN, PAS CE QUE LE CODE ATTEND. Trois comptes, dont DEUX qui
 * n'ont jamais accepté leur invitation : c'est exactement ce qu'il a ouvert le 2026-09-12, et l'écran
 * n'en montrait qu'un. Une fixture où tout le monde serait activé aurait laissé passer le filtre
 * silencieux sans rien dire, parce qu'elle aurait reproduit l'hypothèse du code plutôt que la réalité.
 *
 * ⚠️ `pending` EST CALCULÉ PAR LE SERVEUR SUR `last_login_at is null`, pas sur le mot de passe : un
 * compte Google n'a aucun `password_hash` et n'est pourtant PAS en attente. C'est le défaut qui a produit
 * le symptôme, et il est corrigé côté serveur ; cette fixture rend la valeur que l'API renvoie vraiment.
 */
const USERS = [
  { id: 'u1', email: 'alice@e2e.test', name: 'Alice', role: 'admin', disabled: false, pending: false },
  { id: 'u2', email: 'bob@e2e.test', name: 'Bob', role: 'agent', disabled: false, pending: true },
  { id: 'u3', email: 'chloe@e2e.test', name: 'Chloé', role: 'agent', disabled: false, pending: true },
];

async function monter(
  page: Page,
  sur: { canal?: string; troisieme?: string; agents?: unknown[]; users?: unknown[]; sansContenu?: boolean; sansCanal?: boolean } = {},
): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const chemin = new URL(route.request().url()).pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: true, rcsEnabled: true,
        hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
        timezone: 'Europe/Paris', businessHours: {},
      });
    }
    /**
     * 🔴 L'ADRESSE RÉELLE EST `/email/templates`, PAS `/email-templates` (corrigé le 2026-09-14). Ce faux
     * a porté la mauvaise adresse depuis sa création : l'appel retombait sur la règle `/templates` juste
     * en dessous, et la console recevait donc la liste des modèles WHATSAPP comme gabarits d'e-mail. Rien
     * ne le signalait tant qu'aucun test ne remplissait un étage e-mail.
     */
    if (chemin.endsWith('/email/templates')) return json({ templates: EMAIL_TEMPLATES });
    if (chemin.endsWith('/templates')) return json({ templates: TEMPLATES });
    if (chemin.endsWith('/workflows')) return json({ workflows: WORKFLOWS });
    if (chemin.endsWith('/users')) return json({ users: sur.users ?? USERS });
    if (chemin.endsWith('/agents')) return json({ agents: sur.agents ?? [{ id: 'ag1', label: 'Conseiller', status: 'actif', sorties: [] }] });
    return json({});
  });
  const q = new URLSearchParams({
    etape: 'contenu',
    // ⚠️ `sansCanal` OUVRE L'ETAPE AVEC UNE CHAINE VIDE : c'est ce qu'on obtient en tapant l'adresse a la
    // main, ou en reprenant un brouillon abandonne avant le choix du canal.
    ...(sur.sansCanal === true ? {} : { canal: sur.canal ?? 'repli' }),
    ...(sur.troisieme ? { troisieme: sur.troisieme } : {}),
  });
  await page.goto(`/campaigns/nouvelle?${q.toString()}`);
  await expect(page.getByTestId('etape-contenu')).toBeVisible();
  /**
   * 🔴 TOUTE LA CHAINE EST REMPLIE PAR DEFAUT, ET C'EST UN ELARGISSEMENT DU 2026-09-14. Le bloc du
   * devenir de la conversation n'apparait QUE lorsque plus aucun etage ne manque (demande de Julien :
   * « d'abord se concentrer sur le contenu, etage 1, etage 2 si campagne avec fallback ; ne pas faire
   * apparaitre de suite la question »). Remplir l'etage 1 ne suffit plus : une dizaine de cas ci-dessous
   * chercheraient un bloc que l'ecran masque a juste titre, et rougiraient en accusant le devenir alors
   * que c'est le contenu de l'etage 2 qui manque.
   *
   * ⚠️ ON REPLIE LE CADRE APRES, pour rendre l'ecran exactement dans l'etat d'avant : les deux cas de
   * largeur deplient eux-memes celui qu'ils mesurent, et un cadre deja ouvert changerait ce qu'ils
   * mesurent sans qu'on l'ait voulu.
   */
  if (sur.sansContenu !== true) {
    const canal = sur.canal ?? 'repli';
    await page.getByTestId('etage-1').click();
    if (canal === 'rcs') await page.getByTestId('rcs-texte').fill('coucou');
    else await page.getByTestId('modele-1').selectOption('promo_rentree');
    await page.getByTestId('etage-1').click();
    // L'etage 2 d'une chaine « avec repli » part en RCS : le second canal se deduit du premier.
    if (canal === 'repli') {
      await page.getByTestId('etage-2').click();
      await page.getByTestId('rcs-texte').fill('repli RCS');
      await page.getByTestId('etage-2').click();
    }
    if (sur.troisieme === 'email') {
      await page.getByTestId('etage-3').click();
      await page.getByTestId('email-modele').selectOption('em1');
      await page.getByTestId('etage-3').click();
    }
  }
}

test('un cadre par etage, dans l ordre de la chaine', async ({ page }) => {
  await monter(page);
  await expect(page.getByRole('group', { name: /Étage 1 . WhatsApp/ })).toBeVisible();
  await expect(page.getByRole('group', { name: /Étage 2 . RCS/ })).toBeVisible();
});

test('🔴 un canal SEUL ne montre qu un cadre : la chaine commande, pas un nombre fixe', async ({ page }) => {
  // Sans ce cas, un écran qui afficherait toujours trois cadres passerait le cas du dessus.
  await monter(page, { canal: 'whatsapp' });
  await expect(page.getByTestId('etage-1')).toBeVisible();
  await expect(page.getByTestId('etage-2')).toHaveCount(0);
});

test('le devenir de la conversation est demande UNE SEULE FOIS, pas par etage', async ({ page }) => {
  await monter(page, { troisieme: 'email' });
  await expect(page.getByText('Que se passe-t-il quand le contact répond ?')).toHaveCount(1);
});

/**
 * 🔴 CE CAS DISAIT L'INVERSE JUSQU'AU 2026-09-14, ET C'EST JULIEN QUI L'A RETOURNE : « si la personne
 * choisit Modele + scenario, il ne faut PAS faire apparaitre la question Que se passe-t-il quand le
 * contact repond ; en effet, la logique qui repond, est-ce un agent IA ou un collab, est geree dans le
 * scenario ». L'ancien titre etait « le devenir est demande aussi quand un scenario est choisi ».
 *
 * ⚠️ ON NE LAISSE PAS UN VIDE A LA PLACE : l'ecran DIT que le scenario s'en charge. Une question qui
 * disparait sans un mot se lit comme un bug, et le produit grise ailleurs ses options indisponibles AVEC
 * leur raison plutot que de les faire disparaitre.
 *
 * 🔴 LE SCENARIO EST CHOISI, ET CE CLIC N'EST PAS DE LA CEREMONIE : basculer la formule sans choisir de
 * scenario laisse l'etage sans rien a envoyer, donc le bloc se masquerait de toute facon, pour l'AUTRE
 * raison. Le test ne prouverait alors rien de ce qu'il annonce.
 */
test('🔴 « Modele et scenario » RETIRE la question du devenir, et dit pourquoi', async ({ page }) => {
  await monter(page, { canal: 'whatsapp' });
  await page.getByTestId('etage-1').click(); // deplie le cadre WhatsApp
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await page.getByTestId('scenario-1').selectOption('wf1');
  await expect(page.getByTestId('bloc-devenir')).toHaveCount(0);
  await expect(page.getByTestId('devenir-dans-le-scenario')).toContainText(/réglé dans le scénario/i);
});

/**
 * 🔴 L'AUTRE SENS, ET IL EST INDISPENSABLE : sans lui, un ecran qui aurait perdu le bloc pour de bon
 * passerait le cas ci-dessus sans rien garantir. « Modele seul » repose la question, immediatement.
 */
test('🔴 « Modele seul » repose la question du devenir', async ({ page }) => {
  await monter(page, { canal: 'whatsapp' });
  await expect(page.getByTestId('bloc-devenir')).toBeVisible();
  await page.getByTestId('etage-1').click();
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await page.getByTestId('scenario-1').selectOption('wf1');
  await expect(page.getByTestId('bloc-devenir')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Modèle seul' }).check();
  await page.getByTestId('modele-1').selectOption('promo_rentree');
  await expect(page.getByTestId('bloc-devenir')).toBeVisible();
});

/**
 * 🔴 UN SEUL ETAGE HORS SCENARIO SUFFIT A REPOSER LA QUESTION, et c'est le cas que la regle « tout en
 * scenario » ferait perdre si elle etait ecrite trop large : sur une chaine dont l'etage 1 ouvre un
 * parcours et l'etage 2 envoie un modele seul, les contacts joints au SECOND repondent sans qu'aucun
 * scenario ne les prenne.
 */
test('🔴 un etage de repli hors scenario garde la question', async ({ page }) => {
  await monter(page); // chaine « avec repli », les deux etages remplis
  await page.getByTestId('etage-1').click();
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await page.getByTestId('scenario-1').selectOption('wf1');
  // L'etage 2 reste un message RCS direct : la question reste posee.
  await expect(page.getByTestId('bloc-devenir')).toBeVisible();
});

test('l assignation a une personne affiche le NOMBRE avant de valider', async ({ page }) => {
  await monter(page);
  await page.getByRole('radio', { name: 'Assignée à une personne' }).check();
  await expect(page.getByText(/conversations lui seront attribuées/)).toBeVisible();
});

test('🔴 sans assignation a une personne, aucune phrase d attribution', async ({ page }) => {
  // L'autre sens : une phrase affichée en permanence passerait le cas du dessus sans rien garantir.
  await monter(page);
  await expect(page.getByText(/conversations lui seront attribuées/)).toHaveCount(0);
});

test('le RCS garde ses suggestions, il ne se reduit pas a un lien', async ({ page }) => {
  await monter(page);
  await page.getByTestId('etage-2').click(); // deplie le cadre RCS
  await expect(page.getByRole('button', { name: 'Ajouter une suggestion' })).toBeVisible();
});

test('🔴 un agent IA absent est grise AVEC SA RAISON, pas masque', async ({ page }) => {
  await monter(page, { agents: [] });
  await expect(page.getByRole('radio', { name: 'Un agent IA prend la main' })).toBeDisabled();
  await expect(page.getByText(/aucun agent IA actif/i)).toBeVisible();
});

// 🔴 L'ÉTAPE LA PLUS EXPOSÉE AU DÉBORDEMENT : trois cadres d'étage, un éditeur de modèle, un
// éditeur de suggestions RCS et le bloc du devenir de la conversation.
test('les cadres d etage sont EMPILES, jamais cote a cote, et rien ne deborde en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page, { troisieme: 'email' });
  await page.getByTestId('etage-1').click(); // deplie le premier
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['etage-1', 'etage-2', 'etage-3', 'bloc-devenir']);

  // Les cadres sont empiles : chacun commence SOUS le precedent, jamais a sa droite.
  const un = (await page.getByTestId('etage-1').boundingBox())!;
  const deux = (await page.getByTestId('etage-2').boundingBox())!;
  expect(deux.y).toBeGreaterThanOrEqual(un.y + un.height);
});

// ⚠️ L'editeur de suggestions RCS est le composant le plus large de l'ecran : un cadre deplie
// avec onze suggestions est le pire cas realiste.
test('onze suggestions RCS ne font pas deborder le cadre', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page, { troisieme: 'email' });
  await page.getByTestId('etage-2').click();
  for (let i = 0; i < 11; i += 1) {
    await page.getByRole('button', { name: 'Ajouter une suggestion' }).click();
  }
  // 🔴 ONZE EST LE PLAFOND DU RCS : au douzième, le bouton d'ajout disparaît. Le vérifier ici garantit
  // que les onze clics ont bien produit onze suggestions, et non dix plus un clic tombé dans le vide.
  await expect(page.getByRole('button', { name: 'Ajouter une suggestion' })).toHaveCount(0);
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['etage-1', 'etage-2', 'etage-3', 'bloc-devenir']);
});

/**
 * 🔴 TROIS MEMBRES, PAS UN. C'est le premier retour d'un œil humain sur cet écran : Julien a ouvert la
 * liste d'affectation et y a vu UNE personne alors que son espace en compte trois. Les deux absentes
 * avaient simplement une invitation en attente, et rien ne le disait.
 *
 * ⚠️ LE COMPTE EXACT EST L'ASSERTION QUI COMPTE. « Alice est visible » passerait aussi sur l'écran
 * fautif ; seul un COMPTE sépare l'implémentation juste de celle qui filtre en silence.
 */
test('les membres non actives sont la, grises, avec leur raison', async ({ page }) => {
  await monter(page, { canal: 'whatsapp' });
  await page.getByRole('radio', { name: 'Assignée à une personne' }).check();
  const select = page.getByTestId('assignation-personne');
  await expect(select.locator('option')).toHaveCount(4); // « Choisir... » + les trois membres
  await expect(select.locator('option[disabled]')).toHaveCount(2);
  await expect(select).toContainText('Bob (invitation en attente)');
  await expect(select).toContainText('Chloé (invitation en attente)');
  await expect(page.getByTestId('membres-en-attente')).toBeVisible();
});

/**
 * ⚠️ L'AUTRE SENS : un membre ACTIF ne porte ni la mention ni le grisé, et la phrase d'explication ne
 * s'affiche pas sur une équipe entièrement activée. Sans ce cas, un écran qui griserait TOUT LE MONDE
 * passerait celui du dessus.
 */
test('un membre actif n est ni grise ni annote', async ({ page }) => {
  await monter(page, { canal: 'whatsapp', users: [USERS[0]!] });
  await page.getByRole('radio', { name: 'Assignée à une personne' }).check();
  const select = page.getByTestId('assignation-personne');
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option[disabled]')).toHaveCount(0);
  await expect(select).not.toContainText('invitation en attente');
  await expect(page.getByTestId('membres-en-attente')).toHaveCount(0);
});

/**
 * 🔴 LA QUESTION DU DEVENIR ATTEND QUE L'ETAGE 1 SOIT REMPLI (2026-09-13, essai reel de Julien).
 *
 * ⚠️ LES DEUX SENS DANS LE MEME CAS, ET C'EST VOLONTAIRE : un test qui ne verifierait que l'absence
 * passerait aussi sur un ecran qui aurait perdu le bloc pour de bon.
 */
test('🔴 le devenir n apparait qu une fois le contenu choisi', async ({ page }) => {
  // ⚠️ SUR UN CANAL SEUL, pour que « le contenu » et « l'etage 1 » soient la meme chose : la chaine de
  // repli a son propre cas juste en dessous, et il exerce l'elargissement du 2026-09-14.
  await monter(page, { canal: 'whatsapp', sansContenu: true });
  await expect(page.getByTestId('bloc-devenir')).toHaveCount(0);
  await expect(page.getByTestId('contenu-incomplet')).toBeVisible();
  // Le bouton de l'assistant refuse aussi d'avancer, et c'est la MEME regle qui le decide.
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeDisabled();

  await page.getByTestId('etage-1').click();
  await page.getByTestId('modele-1').selectOption('promo_rentree');
  await expect(page.getByTestId('bloc-devenir')).toBeVisible();
});

/**
 * 🔴 UN ETAGE DE REPLI VIDE MASQUE AUSSI LE DEVENIR DEPUIS LE 2026-09-14, et ce cas disait le contraire
 * la veille (« il ne masque PAS le devenir : on doit pouvoir le regler sans descendre remplir l'etage 2 »).
 * Julien a tranche dans l'autre sens : « d'abord se concentrer sur le contenu, etage 1, etage 2 si
 * campagne avec fallback ». Le confort que l'ancienne regle protegeait n'avait ete demande par personne.
 *
 * ⚠️ LES DEUX SENS DANS LE MEME CAS : on remplit l'etage manquant et le bloc revient, sans quoi ce test
 * passerait aussi sur un ecran qui aurait perdu le bloc pour de bon.
 */
test('🔴 un etage de repli vide bloque le passage ET masque le devenir', async ({ page }) => {
  await monter(page, { sansContenu: true });
  await page.getByTestId('etage-1').click();
  await page.getByTestId('modele-1').selectOption('promo_rentree');
  await page.getByTestId('etage-1').click();
  await expect(page.getByTestId('bloc-devenir')).toHaveCount(0);
  await expect(page.getByTestId('contenu-incomplet')).toContainText('2');
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeDisabled();

  await page.getByTestId('etage-2').click();
  await page.getByTestId('rcs-texte').fill('repli RCS');
  await expect(page.getByTestId('bloc-devenir')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suivant' })).toBeEnabled();
});

/**
 * 🔴 LE BUG DU 2026-09-13, SIGNALE PAR JULIEN : « le user ne doit pas choisir un modele puis un
 * scenario, il doit choisir uniquement un scenario ».
 *
 * L ecran laissait le selecteur de Modele affiche a cote de celui du scenario. Ce n etait pas une
 * question de trop : choisir un modele a la main ECRASE les variables de l etage, alors que le modele
 * qui PART est celui du premier bloc du scenario. Le paramMapping ne decrivait plus le modele envoye,
 * et Meta refuse la campagne ENTIERE sur un compte de parametres qui ne correspond pas.
 *
 * ⚠️ LES DEUX SENS : sans le second cas, un ecran qui aurait perdu le selecteur pour de bon passerait
 * le premier sans rien dire.
 */
test('🔴 « Modele et scenario » ne propose QUE le scenario', async ({ page }) => {
  await monter(page, { canal: 'whatsapp' });
  await page.getByTestId('etage-1').click();
  await expect(page.getByTestId('modele-1')).toBeVisible();
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await expect(page.getByTestId('modele-1')).toHaveCount(0);
  await expect(page.getByTestId('scenario-1')).toBeVisible();
  // ⚠️ La creation de modele a la volee suit la meme regle : elle n a de sens que sur « modele seul ».
  await expect(page.getByRole('button', { name: /Créer un modèle/i })).toHaveCount(0);
});

test('et « Modele seul » le repropose : on peut revenir en arriere', async ({ page }) => {
  await monter(page, { canal: 'whatsapp' });
  await page.getByTestId('etage-1').click();
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await expect(page.getByTestId('modele-1')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Modèle seul' }).check();
  await expect(page.getByTestId('modele-1')).toBeVisible();
});

/**
 * 🔴 SANS CANAL, L'ETAPE CONTENU N'A AUCUN ETAGE A MONTRER, ET ELLE LE DIT (releve en revue le
 * 2026-09-14). Le canal n'ayant plus de defaut, l'adresse `?etape=contenu` seule, ou un brouillon
 * abandonne avant le choix, arrivent ici avec une chaine VIDE. L'ecran affichait alors son titre, une
 * phrase qui parle de cadres, et rien : l'allure exacte d'une page a moitie chargee.
 */
test('🔴 l etape Contenu sans canal dit ce qui manque, au lieu de rester vide', async ({ page }) => {
  await monter(page, { sansCanal: true, sansContenu: true });
  await expect(page.getByTestId('contenu-sans-canal')).toContainText(/revenez à l.étape Canal/i);
  await expect(page.getByTestId('etage-1')).toHaveCount(0);
  await expect(page.getByTestId('bloc-devenir')).toHaveCount(0);
});

/**
 * ⚠️ DEUX SCENARIOS, DEUX FOIS « SCENARIO » AU PLURIEL. Une chaine de repli porte un scenario PAR ETAGE :
 * une phrase au singulier devant deux d'entre eux ferait chercher lequel des deux decide.
 */
test('la phrase du scenario se met au pluriel quand la chaine en porte deux', async ({ page }) => {
  await monter(page);
  await page.getByTestId('etage-1').click();
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await page.getByTestId('scenario-1').selectOption('wf1');
  await page.getByTestId('etage-1').click();
  await page.getByTestId('etage-2').click();
  await page.getByRole('radio', { name: 'Message et scénario' }).check();
  await page.getByTestId('scenario-2').selectOption('wf1');
  await expect(page.getByTestId('devenir-dans-le-scenario')).toContainText(/dans les scénarios/i);
});
