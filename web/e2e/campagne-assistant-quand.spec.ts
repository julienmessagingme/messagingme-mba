import { test, expect } from '@playwright/test';
import { poserFaux, ouvrirAssistant } from './aide/assistant';
import { TREIZE_POUCES, empiles, pasDeDebordement, pasDeChevauchement } from './aide/largeur';

/**
 * QUAND LA CAMPAGNE PART, ET DANS QUELS CRÉNEAUX ELLE A LE DROIT DE COURIR.
 *
 * 🔴 CE SONT DEUX QUESTIONS DIFFÉRENTES, ET ELLES SE CUMULENT. « Plus tard » fixe le moment du
 * DÉCLENCHEMENT ; « heures ouvrées » borne les créneaux d'envoi. Les confondre ferait disparaître l'une
 * des deux, et une campagne programmée à 22 h sur un espace fermé la nuit doit être déclenchée à 22 h puis
 * mise en pause jusqu'à l'ouverture.
 *
 * ⚠️ CE FICHIER REMPLACE `campagne-heures-ouvrees.spec.ts`, qui exerçait les mêmes charges utiles sur
 * l'écran retiré le 2026-09-13. Les trois cas qu'il portait (cochée en départ immédiat, cochée en
 * programmation, DÉCOCHÉE rien n'est envoyé) sont repris tels quels : c'est ce qui garantit que le parc
 * existant garde son comportement.
 *
 * 🔴 CE QUI PROUVE QUELQUE CHOSE ICI EST LE CORPS DE LA REQUÊTE, pas ce que l'écran affiche. Un écran peut
 * montrer une case cochée et n'en rien envoyer.
 */

/**
 * Mène l'assistant jusqu'au récapitulatif, prêt à lancer : un modèle sur un canal seul, tout le monde visé.
 *
 * 🔴 IL PASSE PAR L'ÉTAPE DU NOM, ET CE N'EST PAS UN DÉTOUR : sans nom, la garde de lancement refuse
 * (« cette campagne n'a pas de nom ») et le bouton reste éteint. Un raccourci par l'adresse laisserait donc
 * tous les cas ci-dessous passer pour la mauvaise raison.
 */
async function jusquAuRecap(
  page: import('@playwright/test').Page,
  surLeCanal?: (p: import('@playwright/test').Page) => Promise<void>,
): Promise<void> {
  await ouvrirAssistant(page, { etape: 'nom' });
  await page.getByTestId('assistant-nom').fill('Campagne E2E');
  await page.getByRole('button', { name: 'Suivant' }).click(); // -> canal
  await expect(page.getByTestId('etape-canal')).toBeVisible({ timeout: 15_000 });
  if (surLeCanal) await surLeCanal(page);
  await page.getByRole('button', { name: 'Suivant' }).click(); // -> contenu
  await page.getByTestId('etage-1').click();
  await page.getByTestId('modele-1').selectOption('promo');
  await page.getByRole('button', { name: 'Suivant' }).click(); // -> audience
  await page.getByRole('button', { name: 'Suivant' }).click(); // -> récapitulatif
  await expect(page.getByTestId('etape-recap')).toBeVisible({ timeout: 15_000 });
}

/** La case des heures ouvrées, désignée par son NOM ACCESSIBLE : le `<label>` ne porte que son libellé. */
const caseHoraires = (page: import('@playwright/test').Page) =>
  page.getByRole('checkbox', { name: 'Envoyer uniquement pendant les heures ouvrées' });

test.describe('Assistant : les heures ouvrées', () => {
  test('🔴 cochée, la contrainte part avec la campagne', async ({ page }) => {
    const faux = await poserFaux(page);
    await jusquAuRecap(page, async (p) => {
      const coche = caseHoraires(p);
      await expect(coche).not.toBeChecked(); // le défaut ne contraint personne
      await coche.check();
      // L'écran DIT ce qui se passera hors créneau : sans ça, une campagne en pause ressemble à une panne.
      await expect(p.getByText(/attend la prochaine ouverture/i)).toBeVisible();
    });
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => faux.creations.length, { timeout: 15_000 }).toBe(1);
    expect(faux.creations[0]).toMatchObject({ businessHoursOnly: true });
  });

  test('🔴 cochée, elle part AUSSI avec un lancement « Plus tard »', async ({ page }) => {
    // L'autre bouton, l'autre charge utile. Julien a demandé les deux, et un seul des deux chemins vérifié
    // aurait laissé passer l'oubli sur l'autre.
    const faux = await poserFaux(page);
    await jusquAuRecap(page, async (p) => { await caseHoraires(p).check(); });
    await page.getByTestId('quand-plus_tard').click();
    await page.getByTestId('campagne-date').fill('2099-01-01T09:00');
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => faux.creations.length, { timeout: 15_000 }).toBe(1);
    expect(faux.creations[0]).toMatchObject({ businessHoursOnly: true });
  });

  /**
   * 🔴 DÉCOCHÉE, C'EST `false` QUI PART, ET SURTOUT PAS `true`. La preuve inverse : sans elle, une valeur
   * toujours transmise à `true` passerait les deux cas du dessus et imposerait au parc entier une
   * contrainte que personne n'a demandée.
   */
  test('🔴 DÉCOCHÉE, la campagne n’est PAS contrainte', async ({ page }) => {
    const faux = await poserFaux(page);
    await jusquAuRecap(page);
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => faux.creations.length, { timeout: 15_000 }).toBe(1);
    expect(faux.creations[0]!.businessHoursOnly).toBe(false);
  });
});

test.describe('Assistant : « Maintenant » ou « Plus tard »', () => {
  /**
   * 🔴 LE CAS QUI SÉPARE : `runCampaign` SANS date LANCE IMMÉDIATEMENT. Une implémentation qui validerait
   * la date d'un côté et la perdrait de l'autre enverrait une campagne programmée pour la semaine
   * prochaine sur-le-champ, à de vraies personnes, sans que rien à l'écran ne le montre.
   */
  test('🔴 « Plus tard » envoie la date au LANCEMENT, en instant absolu', async ({ page }) => {
    const faux = await poserFaux(page);
    await jusquAuRecap(page);
    await page.getByTestId('quand-plus_tard').click();
    await page.getByTestId('campagne-date').fill('2099-03-04T09:30');
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => faux.lancements.length, { timeout: 15_000 }).toBe(1);
    const corps = faux.lancements[0]!.body as { scheduledAt?: string };
    expect(corps.scheduledAt, 'la date n’est pas partie : la campagne serait lancée tout de suite').toBeTruthy();
    expect(new Date(corps.scheduledAt!).getTime()).toBe(new Date('2099-03-04T09:30').getTime());
  });

  // 🔴 L'AUTRE SENS : « Maintenant » ne porte AUCUNE date. Sans ce cas, une implémentation qui enverrait
  // toujours un `scheduledAt` passerait celui du dessus et programmerait tout, y compris l'envoi immédiat.
  test('🔴 « Maintenant » ne porte aucune date', async ({ page }) => {
    const faux = await poserFaux(page);
    await jusquAuRecap(page);
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => faux.lancements.length, { timeout: 15_000 }).toBe(1);
    expect(faux.lancements[0]!.body).toBeNull();
  });

  test('🔴 une date PASSÉE est refusée, et la campagne ne part pas', async ({ page }) => {
    const faux = await poserFaux(page);
    await jusquAuRecap(page);
    await page.getByTestId('quand-plus_tard').click();
    await page.getByTestId('campagne-date').fill('2020-01-01T09:00');
    await expect(page.getByTestId('recap-probleme')).toContainText(/futur/i);
    await expect(page.getByTestId('bouton-lancer')).toBeDisabled();
    expect(faux.creations).toHaveLength(0);
  });

  test('« Plus tard » sans date choisie est refusé, avec sa raison', async ({ page }) => {
    await poserFaux(page);
    await jusquAuRecap(page);
    await page.getByTestId('quand-plus_tard').click();
    await expect(page.getByTestId('recap-probleme')).toContainText(/date/i);
    await expect(page.getByTestId('bouton-lancer')).toBeDisabled();
  });

  /**
   * 🔴 CRÉER SANS ENVOYER EST UN GESTE À PART, ET IL EXISTAIT DEPUIS TOUJOURS DANS L'ÉCRAN RETIRÉ. Il
   * calcule les destinataires et s'arrête là : c'est ainsi qu'on vérifie QUI est retenu avant d'engager
   * le moindre message.
   */
  test('🔴 « Créer sans envoyer » crée la campagne et NE LANCE RIEN', async ({ page }) => {
    const faux = await poserFaux(page);
    await jusquAuRecap(page);
    await page.getByTestId('bouton-creer-sans-lancer').click();
    await expect(page.getByTestId('recap-creee')).toBeVisible({ timeout: 15_000 });
    expect(faux.creations).toHaveLength(1);
    expect(faux.lancements, 'la campagne a été lancée alors qu’on demandait seulement de la créer').toHaveLength(0);
  });

  /**
   * 🔴 ZÉRO DESTINATAIRE = TOUS ÉCARTÉS, ET ON NE LANCE PAS. Sans cette garde, l'écran annoncerait « la
   * campagne est lancée » sur un envoi qui n'atteindra personne, et l'opérateur ne l'apprendrait qu'en
   * ouvrant le rapport.
   */
  test('🔴 zéro destinataire retenu : la campagne n’est PAS lancée, et l’écran dit le motif', async ({ page }) => {
    const faux = await poserFaux(page, {
      creation: { campaignId: 'camp-1', recipientCount: 0, skipped: [{ contactId: 'c1', toE164: '+33', reason: 'not_opted_in' }] },
    });
    await jusquAuRecap(page);
    await page.getByTestId('bouton-lancer').click();
    await expect(page.getByTestId('recap-erreur')).toContainText(/consentement/i, { timeout: 15_000 });
    expect(faux.creations).toHaveLength(1);
    expect(faux.lancements, 'un envoi est parti alors qu’il n’atteindrait personne').toHaveLength(0);
  });

  // ⚠️ L'AVERTISSEMENT DE PALIER N'EST PAS UN REFUS : la campagne part, se met en pause au plafond et
  // reprend. Il s'affiche donc À CÔTÉ du succès, et il est rédigé par le SERVEUR, jamais reformulé ici.
  test('l’avertissement de palier s’affiche sans empêcher le lancement', async ({ page }) => {
    const faux = await poserFaux(page, {
      creation: { campaignId: 'camp-1', recipientCount: 3, skipped: [], avertissement: 'Ce numéro ne passera que 250 conversations en 24 h.' },
    });
    await jusquAuRecap(page);
    await page.getByTestId('bouton-lancer').click();
    await expect(page.getByTestId('recap-avertissement')).toContainText('250 conversations', { timeout: 15_000 });
    await expect(page.getByTestId('recap-lancee')).toBeVisible();
    expect(faux.lancements).toHaveLength(1);
  });

  /** 🔴 LA GARDE DE LARGEUR sur le récapitulatif, qui porte désormais trois blocs empilés. */
  test('🔴 à 1280 px, le récapitulatif ne déborde pas et ses blocs ne se chevauchent pas', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await poserFaux(page);
    await jusquAuRecap(page);
    await page.getByTestId('quand-plus_tard').click();
    await pasDeDebordement(page);
    // ⚠️ UN CONTRÔLE DE DÉGÂT NE REMPLACE PAS UN CONTRÔLE DE DISPOSITION : trois blocs côte à côte
    // passeraient le contrôle de débordement. Seule une assertion d'EMPILEMENT les attrape.
    await pasDeChevauchement(page, ['repartition', 'bloc-quand', 'bloc-cout']);
    await empiles(page, ['repartition', 'bloc-quand', 'bloc-cout']);
  });
});
