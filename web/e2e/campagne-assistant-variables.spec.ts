import { test, expect, type Page } from '@playwright/test';
import { TREIZE_POUCES, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * E2E de l'assistant de campagne : l'ASSOCIATION DES VARIABLES d'un modèle.
 *
 * 🔴 C'EST LE SEUL RÉGLAGE DE L'ASSISTANT DONT L'OUBLI COÛTE LA CAMPAGNE ENTIÈRE. Meta compare le nombre
 * de paramètres fournis à celui du modèle approuvé : un modèle qui porte `{{1}}` envoyé sans paramètre
 * est un refus global, pas un destinataire sauté. Tant que l'assistant n'envoyait aucun `paramMapping`,
 * il ne savait créer que des campagnes à modèle sans variable, c'est-à-dire le cas rare.
 *
 * 🔴 ET CE QUI SE VÉRIFIE ICI, C'EST LE CORPS DE LA REQUÊTE, PAS L'ÉCRAN. Une liste de variables bien
 * affichée mais absente du `POST /campaigns` est exactement le défaut qu'on ferme : le seul contrôle qui
 * le voit est la lecture de ce qui part.
 *
 * ⚠️ LA LISTE DES VARIABLES GRANDIT AVEC LE MODÈLE, donc c'est un candidat au débordement : dix variables
 * dans un cadre d'étage sont le pire cas réaliste, et le dernier cas le mesure en 1280 x 800.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATES = [
  { id: 't1', name: 'promo_deux', status: 'APPROVED', category: 'MARKETING', language: 'fr', body: 'Bonjour {{1}}, rendez-vous à {{2}}' },
  { id: 't2', name: 'simple', status: 'APPROVED', category: 'UTILITY', language: 'fr', body: 'Bonjour, à bientôt' },
  { id: 't3', name: 'ouverture_scenario', status: 'APPROVED', category: 'MARKETING', language: 'fr', body: 'Bonjour {{1}}' },
  { id: 't4', name: 'promo_dix', status: 'APPROVED', category: 'MARKETING', language: 'fr', body: '{{1}} {{2}} {{3}} {{4}} {{5}} {{6}} {{7}} {{8}} {{9}} {{10}}' },
];
const CHAMPS = [
  { key: 'ville', label: 'Ville de résidence du contact', type: 'text' },
  { key: 'email', label: 'Adresse e-mail', type: 'text' },
];
const WORKFLOWS = [{ id: 'wf1', name: 'Prise de RDV', campaignEligible: true }];
const GRAPHE_SCENARIO = {
  nodes: [{ id: 'n1', type: 'template', data: { templateName: 'ouverture_scenario', language: 'fr' } }],
  edges: [],
};

/** Ce que le dernier `POST /campaigns` a porté. `null` tant que rien n'a été créé. */
interface Espion { corps: Record<string, unknown> | null }

async function monter(
  page: Page,
  sur: { etape?: string; canal?: string; indices?: unknown[] } = {},
): Promise<Espion> {
  const espion: Espion = { corps: null };
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = new URL(route.request().url());
    const chemin = url.pathname.replace('/api/backend', '');
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/settings')) {
      return json({
        controlHandbackSeconds: null, mbaHandoffMode: null, mbaEnabled: true, rcsEnabled: true,
        hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true,
        timezone: 'Europe/Paris', businessHours: {},
      });
    }
    if (chemin.endsWith('/param-hints')) return json({ hints: sur.indices ?? [] });
    if (chemin.endsWith('/contacts/count')) return json({ total: 120 });
    /**
     * 🔴 L'ADRESSE RÉELLE EST `/email/templates`, PAS `/email-templates` (corrigé le 2026-09-14). Ce faux
     * a porté la mauvaise adresse depuis sa création : l'appel retombait sur la règle `/templates` juste
     * en dessous, et la console recevait donc la liste des modèles WHATSAPP comme gabarits d'e-mail. Rien
     * ne le signalait tant qu'aucun test ne remplissait un étage e-mail.
     */
    if (chemin.endsWith('/email/templates')) return json({ templates: [] });
    if (chemin.endsWith('/templates')) return json({ templates: TEMPLATES });
    if (chemin.endsWith('/workflows/wf1')) return json({ workflow: { id: 'wf1', name: 'Prise de RDV', graph: GRAPHE_SCENARIO } });
    if (chemin.endsWith('/workflows')) return json({ workflows: WORKFLOWS });
    if (chemin.endsWith('/users')) return json({ users: [] });
    if (chemin.endsWith('/agents')) return json({ agents: [] });
    if (chemin.endsWith('/tags')) return json({ tags: [] });
    if (chemin.endsWith('/user-fields')) return json({ fields: CHAMPS });
    if (chemin.endsWith('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33 5 25 68 02 50', verifiedName: 'Engage Me' }] });
    if (chemin.endsWith('/rcs-agents')) return json({ agents: [{ agentId: 'ag1', brandName: 'Marque', status: 'LAUNCHED' }] });
    if (chemin.endsWith('/campaigns') && route.request().method() === 'POST') {
      espion.corps = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      return json({ campaignId: 'c-e2e' });
    }
    if (chemin.endsWith('/run')) return json({ ok: true });
    return json({});
  });
  /**
   * \u26a0\ufe0f ON ENTRE PAR L'\u00c9TAPE DU NOM, ET ON AVANCE EN CLIQUANT. Ouvrir directement `?etape=recap`
   * laisserait la campagne SANS NOM, et le r\u00e9capitulatif refuserait le lancement pour cette raison-l\u00e0 :
   * les cas qui v\u00e9rifient une garde de VARIABLES liraient alors un refus qui ne parle pas d'elles. L'adresse
   * ne porte que l'\u00e9tape d'ouverture et la formule de canal, jamais l'\u00e9tat saisi.
   */
  const q = new URLSearchParams({ etape: 'nom', canal: sur.canal ?? 'whatsapp' });
  await page.goto(`/campaigns/nouvelle?${q.toString()}`);
  await page.getByTestId('assistant-nom').fill('Campagne de test');
  for (let i = 0; i < (sur.etape === 'canal' ? 1 : 2); i += 1) {
    await page.getByRole('button', { name: 'Suivant' }).click();
  }
  return espion;
}

/** Ouvre le cadre de l'étage 1 et y choisit un modèle. */
async function choisirModele(page: Page, nom: string): Promise<void> {
  await expect(page.getByTestId('etape-contenu')).toBeVisible();
  await page.getByTestId('etage-1').click();
  await page.getByTestId('modele-1').selectOption(nom);
}

test('un modele a deux variables affiche deux lignes a associer', async ({ page }) => {
  await monter(page);
  await choisirModele(page, 'promo_deux');
  await expect(page.getByTestId('variables-1')).toBeVisible();
  await expect(page.getByTestId('variable-1-1')).toBeVisible();
  await expect(page.getByTestId('variable-1-2')).toBeVisible();
});

/**
 * 🔴 L'AUTRE SENS, ET SANS LUI UN ÉCRAN QUI AFFICHERAIT TOUJOURS DEUX LIGNES PASSERAIT LE CAS DU DESSUS.
 * Un modèle sans variable ne doit rien demander : une liste vide à remplir ferait croire à un réglage
 * oublié sur la campagne la plus simple du produit.
 */
test('un modele SANS variable n affiche aucune ligne', async ({ page }) => {
  await monter(page);
  await choisirModele(page, 'simple');
  await expect(page.getByTestId('variables-1')).toHaveCount(0);
});

/**
 * ⚠️ CHANGER DE MODÈLE REFAIT LA LISTE. Garder les deux lignes de l'ancien modèle sur un modèle qui n'en
 * porte qu'une enverrait un paramètre de trop, que Meta refuse exactement comme un paramètre manquant.
 */
test('changer de modele refait la liste des variables', async ({ page }) => {
  await monter(page);
  await choisirModele(page, 'promo_deux');
  await expect(page.getByTestId('variable-1-2')).toBeVisible();
  await page.getByTestId('modele-1').selectOption('ouverture_scenario');
  await expect(page.getByTestId('variable-1-1')).toBeVisible();
  await expect(page.getByTestId('variable-1-2')).toHaveCount(0);
});

/**
 * 🔴 CE QUI PART DANS LE CORPS DE LA REQUÊTE, et c'est le seul contrôle qui voit le défaut d'origine.
 * L'écran peut afficher deux lignes impeccables ; si `paramMapping` n'est pas dans le `POST`, Meta refuse
 * la campagne entière.
 */
test('le paramMapping choisi part vraiment dans la creation', async ({ page }) => {
  const espion = await monter(page);
  await choisirModele(page, 'promo_deux');
  await page.getByTestId('variable-1-1').selectOption('sys:prenom');
  await page.getByTestId('variable-1-2').selectOption('literal');
  await page.getByTestId('variable-1-2-texte').fill('Paris');

  await page.getByRole('button', { name: 'Suivant' }).click(); // audience
  await page.getByRole('button', { name: 'Suivant' }).click(); // recap
  await expect(page.getByTestId('bouton-lancer')).toBeEnabled();
  await page.getByTestId('bouton-lancer').click();
  await expect(page.getByTestId('recap-lancee')).toBeVisible();

  expect(espion.corps?.paramMapping).toEqual([
    { position: 1, source: { type: 'field', key: 'prenom' } },
    { position: 2, source: { type: 'literal', value: 'Paris' } },
  ]);
});

/**
 * 🔴 LA GARDE QUI PROTÈGE LE CLIENT : un texte fixe laissé à blanc est un paramètre VIDE, que Meta refuse
 * comme un paramètre manquant. Le lancement est bloqué AVEC SA RAISON, pas envoyé puis refusé au loin.
 */
test('un texte fixe laisse vide bloque le lancement, avec sa raison', async ({ page }) => {
  await monter(page);
  await choisirModele(page, 'promo_deux');
  await page.getByTestId('variable-1-2').selectOption('literal');
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByTestId('recap-probleme')).toContainText(/vide/i);
  await expect(page.getByTestId('bouton-lancer')).toBeDisabled();
});

/**
 * ⚠️ LES INDICES POSÉS À LA CRÉATION DU MODÈLE PRÉ-REMPLISSENT LA LISTE, c'est la sémantique de l'ancien
 * formulaire et on n'en invente pas une seconde. Un indice `literal` porte l'exemple choisi au design.
 */
test('les indices du modele pre-remplissent l association', async ({ page }) => {
  await monter(page, {
    indices: [
      { position: 1, source: { type: 'field', key: 'ville' } },
      { position: 2, source: { type: 'literal', value: 'Lyon' } },
    ],
  });
  await choisirModele(page, 'promo_deux');
  await expect(page.getByTestId('variable-1-1')).toHaveValue('field:ville');
  await expect(page.getByTestId('variable-1-2-texte')).toHaveValue('Lyon');
});

/**
 * 🔴 UN SCÉNARIO AUSSI A DES VARIABLES À FOURNIR, et ce ne sont pas celles du sélecteur « Modèle » : la
 * campagne DÉMARRE un parcours dont le premier bloc envoie SON modèle, et ce mapping-là lui est passé
 * déjà résolu (`explicitParams`, `src/workflow/wiring.ts`). Vide, c'est le même refus global de Meta.
 */
test('un scenario fait apparaitre les variables du modele par lequel il ouvre', async ({ page }) => {
  await monter(page);
  await expect(page.getByTestId('etape-contenu')).toBeVisible();
  await page.getByTestId('etage-1').click();
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await page.getByTestId('scenario-1').selectOption('wf1');
  // `ouverture_scenario` porte UNE variable : c'est elle qu'on doit associer, pas celles d'un autre modèle.
  await expect(page.getByTestId('variable-1-1')).toBeVisible();
  await expect(page.getByTestId('variable-1-2')).toHaveCount(0);
});

/**
 * 🔴 UN REPLI SUR UN MODÈLE À VARIABLES EST REFUSÉ, ET C'EST UN FAIT DE SCHÉMA, PAS UNE PRUDENCE :
 * `campaigns.param_mapping` décrit le rang 1, `campaign_etages` n'a pas de colonne pour un second, et
 * `campaign_recipients.resolved_params` est calculé UNE fois depuis ce mapping unique. Laisser passer
 * enregistrerait une chaîne dont le repli échouerait chez Meta des jours plus tard, sur un chemin que
 * personne ne regarde.
 *
 * ⚠️ LE CHEMIN PASSE PAR L'ÉTAPE CANAL parce que c'est la seule façon d'obtenir « RCS en premier », donc
 * un étage WhatsApp au rang 2. L'adresse ne porte que la FORMULE, pas l'ordre.
 */
test('un repli WhatsApp sur un modele a variables est refuse au recapitulatif', async ({ page }) => {
  await monter(page, { etape: 'canal' });
  await expect(page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' })).toBeVisible();
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await page.getByRole('radio', { name: 'RCS en premier' }).check();
  await page.getByRole('button', { name: 'Suivant' }).click();

  await expect(page.getByTestId('etape-contenu')).toBeVisible();
  await page.getByTestId('etage-1').click(); // rang 1 : RCS
  await page.getByTestId('rcs-texte').fill('coucou');
  await page.getByTestId('etage-1').click(); // referme
  await page.getByTestId('etage-2').click(); // rang 2 : WhatsApp
  await page.getByTestId('modele-2').selectOption('promo_deux');

  await page.getByRole('button', { name: 'Suivant' }).click(); // audience
  await page.getByRole('button', { name: 'Suivant' }).click(); // recap
  await expect(page.getByTestId('recap-probleme')).toContainText(/repli/i);
  await expect(page.getByTestId('bouton-lancer')).toBeDisabled();
});

/**
 * 🔴 L'AUTRE SENS, ET IL SÉPARE LA BONNE GARDE DE LA FAUSSE. Un refus posé sur TOUT étage WhatsApp de
 * rang 2 passerait le cas du dessus en cassant le repli le plus utile du produit. Un modèle SANS variable
 * reste parfaitement lançable en repli.
 */
test('un repli WhatsApp sur un modele SANS variable reste lancable', async ({ page }) => {
  await monter(page, { etape: 'canal' });
  await expect(page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' })).toBeVisible();
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await page.getByRole('radio', { name: 'RCS en premier' }).check();
  await page.getByRole('button', { name: 'Suivant' }).click();

  await expect(page.getByTestId('etape-contenu')).toBeVisible();
  await page.getByTestId('etage-1').click();
  await page.getByTestId('rcs-texte').fill('coucou');
  await page.getByTestId('etage-1').click();
  await page.getByTestId('etage-2').click();
  await page.getByTestId('modele-2').selectOption('simple');

  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByTestId('bouton-lancer')).toBeEnabled();
});

/**
 * 🔴 LA LISTE GRANDIT AVEC LE MODÈLE : dix variables dans un cadre d'étage sont le pire cas réaliste sur
 * un 13 pouces. Un `<select>` qui ne rétrécit pas pousse le champ de texte hors du cadre, et cela ne se
 * voit pas sur l'écran de celui qui l'écrit.
 */
test('dix variables ne font pas deborder l ecran en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await monter(page);
  await choisirModele(page, 'promo_dix');
  await expect(page.getByTestId('variable-1-10')).toBeVisible();
  // Le pire cas de largeur : chaque ligne porte AUSSI son champ de texte fixe.
  for (let i = 1; i <= 10; i += 1) {
    await page.getByTestId(`variable-1-${i}`).selectOption('literal');
  }
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['etage-1']);

  /**
   * 🔴 UN CONTRÔLE DE DÉGÂT NE REMPLACE PAS UN CONTRÔLE DE DISPOSITION (leçon du lot 4). Trois cadres
   * côte à côte passent les deux contrôles ci-dessus sans rien déclencher : seule une assertion
   * d'EMPILEMENT les attrape. Ici, les dix lignes doivent s'empiler, jamais se mettre côte à côte.
   */
  const un = (await page.getByTestId('variable-1-1').boundingBox())!;
  const deux = (await page.getByTestId('variable-1-2').boundingBox())!;
  expect(deux.y).toBeGreaterThanOrEqual(un.y + un.height);
  // Et chaque ligne reste DANS le cadre de son étage, texte fixe compris.
  const cadre = (await page.getByTestId('etage-1').boundingBox())!;
  const texte = (await page.getByTestId('variable-1-10-texte').boundingBox())!;
  expect(texte.x + texte.width).toBeLessThanOrEqual(cadre.x + cadre.width);
});
