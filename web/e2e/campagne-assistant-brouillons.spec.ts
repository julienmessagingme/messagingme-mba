import { test, expect, type Page } from '@playwright/test';
import { poserFaux, ouvrirAssistant, type Brouillon, type Faux } from './aide/assistant';

/**
 * LES BROUILLONS DE COMPOSITION : une campagne qu'on a commencé à écrire se retrouve après avoir quitté
 * l'écran.
 *
 * ⚠️ CE FICHIER REMPLACE `campaign-drafts.spec.ts`, qui exerçait ces cas sur l'écran retiré le
 * 2026-09-13. Ce qu'ils protègent n'a pas changé : qu'UN SEUL brouillon soit créé (et non un par frappe),
 * qu'il disparaisse dès que la vraie campagne existe (sinon la liste montrerait les deux), et surtout que
 * les DESTINATAIRES en fassent partie.
 *
 * 🔴 ET UN CAS DE PLUS, QUI EST LA CONDITION DU RETRAIT : un brouillon écrit par l'ANCIEN écran doit
 * rester lisible. Son `state` est un `jsonb` de forme LIBRE que le serveur ne valide pas ; l'écran qui
 * l'a écrit était seul à savoir le relire. Retirer cet écran sans savoir relire ce qu'il a écrit jetterait
 * sans un mot la campagne que quelqu'un avait commencée.
 */

/** La case d'une ligne de contact. Les lignes sont des `<label>`, pas des lignes de tableau. */
const caseDe = (page: Page, nom: string) =>
  page.locator('label').filter({ hasText: nom }).getByRole('checkbox');

/** L'état enregistré du premier brouillon, tel que le faux serveur l'a reçu. */
function etatDu(f: Faux): Record<string, unknown> {
  return (f.brouillons[0]?.state ?? {}) as Record<string, unknown>;
}
function audienceDu(f: Faux): Record<string, unknown> {
  return (etatDu(f).audience ?? {}) as Record<string, unknown>;
}

/** Ouvre une création neuve et lui donne un nom, ce qui déclenche le premier enregistrement. */
async function nommer(page: Page, nom = 'Promo été'): Promise<void> {
  await ouvrirAssistant(page, { etape: 'nom' });
  await page.getByTestId('assistant-nom').fill(nom);
  await expect(page.getByTestId('brouillon-enregistre')).toBeVisible({ timeout: 15_000 });
}

test.describe('Assistant : l’enregistrement du brouillon', () => {
  test('saisir un nom enregistre UN brouillon', async ({ page }) => {
    const f = await poserFaux(page);
    await nommer(page);
    expect(f.brouillons).toHaveLength(1);
    expect(f.brouillons[0]!.name).toBe('Promo été');
  });

  test('🔴 continuer à écrire ne crée PAS un second brouillon', async ({ page }) => {
    const f = await poserFaux(page);
    await nommer(page);
    await page.getByTestId('assistant-nom').fill('Promo été 2026');
    await expect.poll(() => f.brouillons[0]!.name, { timeout: 10_000 }).toBe('Promo été 2026');
    expect(f.brouillons, 'un second brouillon a été créé pour la même campagne').toHaveLength(1);
  });

  /**
   * 🔴 DEUX ÉCRITURES AVANT LA RÉPONSE DU SERVEUR NE CRÉENT QU'UN BROUILLON. Sans la file d'attente, les
   * deux partiraient en parallèle, toutes deux SANS identifiant, et créeraient deux brouillons pour une
   * seule campagne. La latence du faux est ce qui rend ce cas reproductible.
   */
  test('🔴 deux écritures AVANT la réponse du serveur ne créent qu’UN brouillon', async ({ page }) => {
    const f = await poserFaux(page, { delaiCreationBrouillonMs: 1500 });
    await ouvrirAssistant(page, { etape: 'nom' });
    await page.getByTestId('assistant-nom').fill('Promo');
    await page.waitForTimeout(1400);
    await page.getByTestId('assistant-nom').fill('Promo été');
    await expect(page.getByTestId('brouillon-enregistre')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2500);
    expect(f.brouillons).toHaveLength(1);
  });

  test('un nom VIDE n’enregistre rien (pas de brouillon fantôme)', async ({ page }) => {
    const f = await poserFaux(page);
    await ouvrirAssistant(page, { etape: 'nom' });
    await page.getByTestId('assistant-nom').fill('   ');
    await page.waitForTimeout(2500);
    expect(f.brouillons).toHaveLength(0);
    await expect(page.getByTestId('brouillon-enregistre')).toHaveCount(0);
  });

  /**
   * 🔴 LE BROUILLON SUIT TOUT L'ÉCRAN, PAS SEULEMENT LE NOM. Julien, le 2026-09-08 : « je ne sélectionne
   * que quelques contacts... si je ferme le site et que je reviens, la campagne est enregistrée mais il
   * faut à nouveau que je sélectionne les personnes ». Le nom est la PREMIÈRE chose qu'on tape : un
   * enregistrement déclenché par lui seul ne peut photographier qu'un écran vide.
   */
  test('🔴 une sélection PARTIELLE part dans le brouillon, sans retoucher au nom', async ({ page }) => {
    const f = await poserFaux(page);
    await nommer(page);
    await page.getByRole('button', { name: 'Suivant' }).click(); // canal
    await page.getByRole('button', { name: 'Suivant' }).click(); // contenu
    await page.getByRole('button', { name: 'Suivant' }).click(); // audience
    // 🔴 ATTENDRE QUE LA LISTE SOIT CHARGÉE : elle RECOCHE tout à son arrivée (des filtres qui changent
    // désignent un autre ensemble), donc une coche posée avant serait silencieusement annulée.
    await expect(page.getByTestId('destinataires-total')).toContainText('3', { timeout: 15_000 });
    await expect(caseDe(page, 'Bob')).toBeChecked();
    // Tout est coché par défaut : on retire Bob. Le nom n'est plus jamais touché à partir d'ici.
    await caseDe(page, 'Bob').click();
    await expect.poll(() => (audienceDu(f).exclus as string[] | undefined), { timeout: 10_000 }).toEqual(['c2']);
  });

  test('🔴 le contenu de l’étage part aussi dans le brouillon', async ({ page }) => {
    // Même raison : tout ce qui suit le nom était perdu. Le modèle est la seconde chose qu'on choisit.
    const f = await poserFaux(page);
    await nommer(page);
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo');
    await expect
      .poll(() => ((etatDu(f).contenus as Record<string, { templateName?: string }> | undefined)?.['1']?.templateName), { timeout: 10_000 })
      .toBe('promo');
  });

  /**
   * 🔴 LE BROUILLON DISPARAÎT DÈS QUE LA VRAIE CAMPAGNE EXISTE, sinon la liste montrerait les deux et on
   * ne saurait plus laquelle est la bonne.
   */
  test('🔴 lancer la campagne RETIRE son brouillon', async ({ page }) => {
    const f = await poserFaux(page);
    await nommer(page);
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('bouton-lancer').click();
    await expect(page.getByTestId('recap-lancee')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => f.brouillons.length, { timeout: 15_000 }).toBe(0);
  });
});

test.describe('Assistant : la reprise d’un brouillon', () => {
  const AVEC_SELECTION: Brouillon = {
    id: 'd1', name: 'Promo été', updatedAt: '2026-09-13T10:00:00.000Z',
    state: {
      assistant: 1,
      contenus: { 1: { formule: 'seul', templateName: 'promo', templateLanguage: 'fr', suggestions: [] } },
      audience: { source: 'crm', webhookId: '', filtres: {}, toutFiltre: false, selected: ['c1', 'c3'], exclus: [] },
    },
  };

  test('un brouillon repris retrouve son nom et son modèle', async ({ page }) => {
    await poserFaux(page, { brouillons: [AVEC_SELECTION] });
    await ouvrirAssistant(page, { etape: 'nom', brouillon: 'd1' });
    await expect(page.getByTestId('assistant-nom')).toHaveValue('Promo été', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('etage-1').click();
    await expect(page.getByTestId('modele-1')).toHaveValue('promo');
  });

  /**
   * 🔴 À LA REPRISE, LA SÉLECTION EST REMISE, PAS RE-COCHÉE ENTIÈREMENT. Le chargement de la liste recoche
   * tout par défaut, et c'est le bon comportement quand les filtres changent. À la reprise, il tombe juste
   * après la restauration et l'efface : c'est exactement le défaut signalé le 2026-09-08.
   */
  test('🔴 à la reprise, la sélection est REMISE, pas re-cochée entièrement', async ({ page }) => {
    await poserFaux(page, { brouillons: [AVEC_SELECTION] });
    await ouvrirAssistant(page, { etape: 'audience', brouillon: 'd1' });
    await expect(caseDe(page, 'Alice')).toBeChecked({ timeout: 15_000 });
    await expect(caseDe(page, 'Chloe')).toBeChecked();
    await expect(caseDe(page, 'Bob')).not.toBeChecked();
  });

  // 🔴 PREUVE INVERSE : sans brouillon repris, tout reste coché. Sans ce cas, ne plus JAMAIS recocher
  // passerait celui du dessus, et une campagne neuve s'ouvrirait sur une liste entièrement décochée.
  test('🔴 preuve inverse : SANS brouillon repris, tout reste coché par défaut', async ({ page }) => {
    await poserFaux(page);
    await ouvrirAssistant(page, { etape: 'audience' });
    for (const nom of ['Alice', 'Bob', 'Chloe']) await expect(caseDe(page, nom)).toBeChecked({ timeout: 15_000 });
    await expect(page.getByTestId('selection-reduite')).toHaveCount(0);
  });

  test('un contact DISPARU de la sélection reprise est retiré, et l’écran le DIT', async ({ page }) => {
    // Se taire ferait revenir l'opérateur sur une campagne qui vise moins de monde qu'il ne l'a laissée,
    // sans qu'il puisse s'en apercevoir.
    await poserFaux(page, {
      brouillons: [{
        ...AVEC_SELECTION,
        state: { ...AVEC_SELECTION.state, audience: { source: 'crm', webhookId: '', filtres: {}, toutFiltre: false, selected: ['c1', 'c3', 'c-efface'], exclus: [] } },
      }],
    });
    await ouvrirAssistant(page, { etape: 'audience', brouillon: 'd1' });
    await expect(page.getByTestId('selection-reduite')).toContainText('1', { timeout: 15_000 });
    await expect(caseDe(page, 'Alice')).toBeChecked();
    await expect(caseDe(page, 'Bob')).not.toBeChecked();
  });

  /**
   * 🔴 LES EXCLUSIONS TIENNENT AUSSI, et c'est la pire moitié à perdre. En mode « tout ce qui
   * correspond », perdre une exclusion fait viser quelqu'un que l'opérateur avait explicitement retiré :
   * perdre une sélection envoie à MOINS de monde, perdre une exclusion envoie à PLUS.
   */
  test('🔴 en mode « tout ce qui correspond », les EXCLUSIONS reprises tiennent', async ({ page }) => {
    await poserFaux(page, {
      brouillons: [{
        ...AVEC_SELECTION,
        state: { ...AVEC_SELECTION.state, audience: { source: 'crm', webhookId: '', filtres: {}, toutFiltre: true, selected: [], exclus: ['c2'] } },
      }],
    });
    await ouvrirAssistant(page, { etape: 'audience', brouillon: 'd1' });
    // Le bandeau du mode « tout ce qui correspond » est rendu : c'est bien ce mode qui a été repris.
    await expect(page.getByTestId('campagne-cible-filtre')).toBeVisible({ timeout: 15_000 });
    // Bob reste EXCLU. Décoché = exclu, dans ce mode.
    await expect(caseDe(page, 'Bob')).not.toBeChecked();
    await expect(caseDe(page, 'Alice')).toBeChecked();
  });

  /**
   * 🔴 LA MARQUE DE REPRISE MEURT AVEC LA SOURCE. Le chargement de la liste ne tourne QUE sur la source
   * CRM : un brouillon repris sur « Import fichier » laisserait sa marque ARMÉE, et le premier passage au
   * CRM appliquerait une sélection appartenant à une autre source, en pratique VIDE. Rien ne serait coché
   * là où tout devrait l'être.
   */
  test('🔴 un brouillon repris sur une AUTRE source ne vide pas le CRM quand on y revient', async ({ page }) => {
    await poserFaux(page, {
      brouillons: [{
        ...AVEC_SELECTION,
        state: { ...AVEC_SELECTION.state, audience: { source: 'fichier', webhookId: '', filtres: {}, toutFiltre: false, selected: [], exclus: [] } },
      }],
    });
    await ouvrirAssistant(page, { etape: 'audience', brouillon: 'd1' });
    await page.getByRole('button', { name: '📇 Liste de contacts' }).click();
    for (const nom of ['Alice', 'Bob', 'Chloe']) await expect(caseDe(page, nom)).toBeChecked({ timeout: 15_000 });
  });

  test('un identifiant de brouillon INCONNU ouvre une création neuve, pas un écran bloqué', async ({ page }) => {
    await poserFaux(page);
    await ouvrirAssistant(page, { etape: 'nom', brouillon: 'jamais-vu' });
    await expect(page.getByTestId('assistant-nom')).toHaveValue('', { timeout: 15_000 });
  });
});

/**
 * UN BROUILLON ÉCRIT PAR L'ANCIEN FORMULAIRE, ET C'EST LA CONDITION DU RETRAIT.
 *
 * 🔴 LES CLÉS CI-DESSOUS SONT CELLES DE SON `etatDuFormulaire`, recopiées verbatim, pas inventées. Une
 * charge écrite d'après le code qui la relit reproduirait les hypothèses de ce code et ne prouverait rien.
 */
test.describe('Assistant : un brouillon de l’ANCIEN formulaire reste lisible', () => {
  const ANCIEN: Brouillon = {
    id: 'd1', name: 'Campagne d’avant', updatedAt: '2026-09-12T10:00:00.000Z',
    state: {
      category: 'utility', mode: 'template', source: 'crm', webhookId: '', phoneNumberId: 'pn1',
      templateName: 'promo', templateLanguage: 'fr', vars: [], workflowId: '',
      rcsAgentId: '', rcsText: '', rcsImage: '', ratePerMinute: 30,
      timing: 'later', scheduledLocal: '2099-05-06T08:15', heuresOuvrees: true,
      filters: {}, selected: ['c1', 'c3'], toutFiltre: false, exclus: [],
    },
  };

  test('🔴 son modèle, sa catégorie et ses contacts cochés reviennent', async ({ page }) => {
    await poserFaux(page, { brouillons: [ANCIEN] });
    await ouvrirAssistant(page, { etape: 'nom', brouillon: 'd1' });
    await expect(page.getByTestId('assistant-nom')).toHaveValue('Campagne d’avant', { timeout: 15_000 });
    // La catégorie « Service » (utility) : c'est elle qui décide du consentement exigé.
    await expect(page.getByTestId('choix-categorie').getByRole('radio', { name: /^Service/ })).toBeChecked();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('etage-1').click();
    await expect(page.getByTestId('modele-1')).toHaveValue('promo');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await expect(caseDe(page, 'Alice')).toBeChecked({ timeout: 15_000 });
    await expect(caseDe(page, 'Bob')).not.toBeChecked();
  });

  /**
   * 🔴 UNE PROGRAMMATION REVIENT PROGRAMMÉE, JAMAIS EN DÉPART IMMÉDIAT. `timing` s'appelait autrement, et
   * ses valeurs aussi : relire la clé sans traduire la valeur rendrait « maintenant » par défaut, et une
   * campagne programmée pour la semaine prochaine repartirait TOUT DE SUITE à la reprise.
   */
  test('🔴 une programmation revient programmée, avec sa date', async ({ page }) => {
    await poserFaux(page, { brouillons: [ANCIEN] });
    await ouvrirAssistant(page, { etape: 'recap', brouillon: 'd1' });
    await expect(page.getByTestId('campagne-date')).toHaveValue('2099-05-06T08:15', { timeout: 15_000 });
    await expect(page.getByTestId('debit-valeur')).toContainText('30');
  });

  test('un message RCS d’avant revient sur un étage RCS, avec son visuel', async ({ page }) => {
    await poserFaux(page, {
      brouillons: [{
        ...ANCIEN,
        state: { ...ANCIEN.state, mode: 'rcs', rcsText: 'Bonjour du passé', rcsImage: 'https://exemple.test/v.jpg' },
      }],
    });
    await ouvrirAssistant(page, { etape: 'contenu', brouillon: 'd1' });
    await page.getByTestId('etage-1').click();
    await expect(page.getByTestId('rcs-texte')).toContainText('Bonjour du passé', { timeout: 15_000 });
  });
});
