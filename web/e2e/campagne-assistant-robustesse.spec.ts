import { test, expect, type Page } from '@playwright/test';
import { poserFaux, ouvrirAssistant } from './aide/assistant';

/**
 * CE QUE L'ASSISTANT DOIT TENIR QUAND LE SERVEUR RÉPOND MAL, ET CE QU'IL ENVOIE VRAIMENT.
 *
 * ⚠️ CE FICHIER REMPLACE `campaign-contacts-degrades.spec.ts`, `campaign-cible-filtre.spec.ts`,
 * `campaign-workflow-filter.spec.ts` et `campaign-enchainer.spec.ts`, qui exerçaient ces cas sur l'écran
 * retiré le 2026-09-13. Les invariants n'ont pas changé de nature : une réponse incomplète ne doit pas
 * démonter l'écran, la cible part en INTENTION et non en liste d'identifiants, et le sélecteur de
 * scénarios ne propose que ceux qu'une campagne peut lancer.
 */

const CONTACTS = [
  { id: 'c1', phoneE164: '+33600000001', profileName: 'Alice', tags: [], fields: {}, optInStatus: 'opted_in' },
  { id: 'c2', phoneE164: '+33600000002', profileName: 'Bob', tags: [], fields: {}, optInStatus: 'opted_in' },
];

const WF_OK = {
  id: 'wf-ok', name: 'Relance promo', campaignEligible: true,
  graph: { nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo', language: 'fr' } }], edges: [] },
};
/** Un scénario qui ouvre par un FORMULAIRE : valide, mais pas lançable sur une audience froide. */
const WF_FLOW = {
  id: 'wf-flow', name: 'Formulaire seul', campaignEligible: false,
  graph: { nodes: [{ id: 'n1', type: 'flow', position: { x: 0, y: 0 }, data: { flowId: 'fl1', flowName: 'RDV' } }], edges: [] },
};

async function jusquAuContenu(page: Page): Promise<void> {
  await ouvrirAssistant(page, { etape: 'nom' });
  await page.getByTestId('assistant-nom').fill('Campagne E2E');
  await page.getByRole('button', { name: 'Suivant' }).click();
  // ⚠️ LE CANAL SE CHOISIT, DEPUIS LE 2026-09-14 : il n'a plus de defaut, et « Suivant » est garde tant
  // qu'aucune des trois entrees n'est cochee. Ce parcours traversait l'etape sans rien y toucher.
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page.getByTestId('etape-contenu')).toBeVisible({ timeout: 15_000 });
}

/**
 * ATTENDRE QUE LA LISTE SOIT CHARGÉE AVANT DE TOUCHER UNE CASE.
 *
 * 🔴 SANS CETTE ATTENTE, UNE COCHE EST SILENCIEUSEMENT ANNULÉE. Le chargement de la liste RECOCHE tout et
 * vide les exclusions, ce qui est le bon comportement (des filtres qui changent désignent un autre
 * ensemble), mais il arrive 350 ms après le montage de l'étape : agir avant qu'il ne tombe fait perdre ce
 * qu'on vient de faire, et le test échouerait pour une raison qui n'est pas celle qu'il vérifie.
 *
 * ⚠️ LE SIGNAL EST LE TOTAL AFFICHÉ, pas une temporisation : « … contacts » tant que ça charge, le compte
 * réel ensuite.
 */
async function attendreLaListe(page: Page, total: number): Promise<void> {
  await expect(page.getByTestId('destinataires-total')).toContainText(String(total), { timeout: 15_000 });
}

test.describe('Assistant : une réponse incomplète de l’API des contacts', () => {
  /**
   * 🔴 UN 200 SANS LE CHAMP `contacts` NE DOIT PAS FAIRE TOMBER L'ÉCRAN. Le `catch` n'y peut rien : il n'y
   * a aucune erreur. C'est `undefined` qui entre dans un état typé tableau, et le `.length` du rendu
   * suivant démonte TOUT l'écran, pas seulement la liste.
   */
  test('🔴 un 200 SANS le champ `contacts` ne fait pas tomber l’écran', async ({ page }) => {
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await poserFaux(page, { contacts: undefined });
    await page.route('**/api/backend/**/contacts?**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await ouvrirAssistant(page, { etape: 'audience' });
    // L'écran reste vivant et utilisable : si React avait démonté la branche, rien de tout cela ne serait là.
    await expect(page.getByTestId('etape-audience')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('audience-sources')).toBeVisible();
    expect(erreurs, `exception de rendu : ${erreurs.join(' | ')}`).toEqual([]);
  });

  /**
   * 🔴 UN TOTAL ABSENT NE S'INVENTE PAS À PARTIR DES LIGNES REÇUES. Le repli tentant était `liste.length`,
   * plafonné par la limite de la requête : on aurait affiché « 2 » pour une base de dix mille contacts.
   * Et zéro est une RÉPONSE (« personne ne correspond »), pas une panne : les confondre ferait croire à
   * une audience vide alors que l'écran n'a simplement pas pu compter.
   */
  test('🔴 un total ABSENT s’annonce comme illisible, il ne vaut pas le nombre de lignes', async ({ page }) => {
    await poserFaux(page, { contacts: CONTACTS });
    await page.route('**/api/backend/**/contacts/count**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await ouvrirAssistant(page, { etape: 'audience' });
    // ⚠️ L'apostrophe du rendu est la DROITE (le JSX y écrit `&apos;`), pas la typographique : une classe
    // de caractères la couvre sans figer laquelle, et sans rendre ce cas faux le jour où la phrase change.
    await expect(page.getByTestId('audience-compte')).toContainText(/n.a pas pu être lu/, { timeout: 15_000 });
    await expect(page.getByTestId('audience-compte')).not.toContainText('2 contacts retenus');
  });

  test('une réponse COMPLÈTE reste évidemment nominale', async ({ page }) => {
    // Le contrôle positif : sans lui, les deux cas ci-dessus passeraient aussi sur un écran qui n'affiche
    // jamais rien.
    await poserFaux(page, { contacts: CONTACTS, total: 2 });
    await ouvrirAssistant(page, { etape: 'audience' });
    await expect(page.getByTestId('audience-compte')).toContainText('2 contacts retenus', { timeout: 15_000 });
  });
});

test.describe('Assistant : la cible part en INTENTION, pas en liste d’identifiants', () => {
  /**
   * 🔴 C'EST CE QUI RETIRE LE PIÈGE DES GROSSES SÉLECTIONS. « Tout sélectionner » rapatriait jusqu'à
   * 100 000 identifiants dans le navigateur puis les renvoyait tous dans la requête, plafonnée à 1 Mo :
   * la création échouait vers 25 000 contacts, donc bien AVANT la limite que l'écran annonçait, et sans
   * rien dire.
   */
  test('🔴 « tout ce qui correspond » envoie les FILTRES, jamais les identifiants', async ({ page }) => {
    const f = await poserFaux(page, { contacts: CONTACTS, total: 1200 });
    await jusquAuContenu(page);
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo');
    await page.getByRole('button', { name: 'Suivant' }).click(); // audience
    // Le mode par défaut est déjà « tout ce qui correspond », et il se VOIT : l'écran n'affiche que deux
    // lignes pour une campagne qui en vise 1200.
    await expect(page.getByTestId('campagne-cible-filtre')).toContainText('1200', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Suivant' }).click(); // récapitulatif
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.contactTarget).toBeDefined();
    expect(f.creations[0]!.contactIds, '1200 identifiants sont partis dans la requête').toBeUndefined();
  });

  /**
   * 🔴 L'AUTRE SENS, ET C'EST LE DÉFAUT QUE LE LOT 7 A TROUVÉ : une sélection ligne à ligne était
   * affichée, comptée, et JAMAIS envoyée. La cible partait sur les filtres quoi qu'on ait coché, donc à
   * plus de monde que ce que l'opérateur avait sous les yeux. Sans ce cas, une implémentation qui
   * poserait TOUJOURS `contactTarget` passerait celui du dessus.
   */
  test('🔴 une sélection ligne à ligne envoie les IDENTIFIANTS, jamais les filtres', async ({ page }) => {
    const f = await poserFaux(page, { contacts: CONTACTS, total: 1200 });
    await jusquAuContenu(page);
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await attendreLaListe(page, 1200);
    // « Vider » quitte le mode « tout ce qui correspond » ; on coche alors UNE ligne, et une seule.
    await page.getByRole('button', { name: 'Vider' }).click();
    await page.locator('label').filter({ hasText: 'Alice' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.contactIds).toEqual(['c1']);
    expect(f.creations[0]!.contactTarget, 'les filtres sont partis avec la liste : le serveur refuse les deux').toBeUndefined();
  });

  /**
   * 🔴 UNE EXCLUSION VOYAGE, ET C'EST LA MOITIÉ QUI COÛTE LE PLUS CHER À PERDRE. En mode « tout ce qui
   * correspond », perdre une exclusion fait viser quelqu'un que l'opérateur avait EXPLICITEMENT retiré :
   * perdre une sélection envoie à MOINS de monde, perdre une exclusion envoie à PLUS.
   */
  test('🔴 décocher une ligne envoie une EXCLUSION, pas une liste', async ({ page }) => {
    const f = await poserFaux(page, { contacts: CONTACTS, total: 1200 });
    await jusquAuContenu(page);
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await attendreLaListe(page, 1200);
    await page.locator('label').filter({ hasText: 'Bob' }).getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.contactTarget).toMatchObject({ excludeIds: ['c2'] });
    expect(f.creations[0]!.contactIds).toBeUndefined();
  });

  test('🔴 changer de SOURCE oublie le mode « tout ce qui correspond »', async ({ page }) => {
    // Le bandeau et le compteur ne sont rendus que dans la branche CRM : hors d'elle, plus rien à l'écran
    // ne dirait ce qui est visé, et l'ancienne cible resterait armée.
    await poserFaux(page, { contacts: CONTACTS, total: 1200 });
    await ouvrirAssistant(page, { etape: 'audience' });
    await expect(page.getByTestId('campagne-cible-filtre')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '📄 Import fichier' }).click();
    await expect(page.getByTestId('campagne-cible-filtre')).toHaveCount(0);
  });
});

/**
 * LE SÉLECTEUR DE SCÉNARIOS NE PROPOSE QUE CEUX LANÇABLES EN CAMPAGNE.
 *
 * 🔴 UNE CAMPAGNE PART SUR UNE AUDIENCE FROIDE : le PREMIER message envoyé doit être un modèle configuré.
 * Un scénario qui démarre par un formulaire reste parfaitement valide ailleurs, mais il n'a rien à faire
 * ici : rien ne partirait.
 */
test.describe('Assistant : les scénarios lançables en campagne', () => {
  test('🔴 seul le scénario qui OUVRE par un modèle est proposé', async ({ page }) => {
    await poserFaux(page, { workflows: [WF_OK, WF_FLOW] });
    await jusquAuContenu(page);
    await page.getByTestId('etage-1').click();
    await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
    const select = page.getByTestId('scenario-1');
    await expect(select).toBeVisible({ timeout: 15_000 });
    // Assertions RE-TENTANTES sur les options : la liste arrive d'un effet asynchrone, et une lecture
    // unique ne réessaierait pas. Les deux négatives seules seraient satisfaites À VIDE.
    await expect(select.locator('option', { hasText: 'Relance promo' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'Formulaire seul' })).toHaveCount(0);
  });
});

/**
 * ENCHAÎNER UNE SECONDE CAMPAGNE.
 *
 * 🔴 CE QUE PROTÉGEAIT `campaign-enchainer.spec.ts` : après un lancement, l'opérateur doit pouvoir en
 * repartir une autre SANS rafraîchir la page. Sur l'écran retiré, les boutons d'action disparaissaient
 * après l'envoi et le formulaire restait pourtant éditable : on saisissait une seconde campagne devant un
 * écran qui ne proposait plus que d'effacer sa saisie. L'assistant règle la question autrement, et c'est
 * la STRUCTURE qui le règle : il rend la main à la liste, d'où l'on repart sur un écran NEUF.
 */
test.describe('Assistant : enchaîner une seconde campagne', () => {
  test('🔴 après un lancement, l’écran rend la main à la liste, d’où l’on repart', async ({ page }) => {
    test.setTimeout(90_000);
    const f = await poserFaux(page);
    await jusquAuContenu(page);
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('bouton-lancer').click();
    // L'accusé de réception s'affiche AVANT la redirection : partir tout de suite priverait l'opérateur du
    // seul retour qu'il aura, et il relancerait.
    await expect(page.getByTestId('recap-lancee')).toBeVisible({ timeout: 15_000 });
    expect(f.creations).toHaveLength(1);
    await expect(page.getByRole('button', { name: /Ajouter une campagne/i })).toBeVisible({ timeout: 30_000 });

    // ---- la seconde campagne repart d'un écran NEUF ----
    await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
    await expect(page.getByTestId('assistant-nom')).toHaveValue('', { timeout: 30_000 });
  });
});
