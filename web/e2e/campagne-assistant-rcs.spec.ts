import { test, expect, type Page } from '@playwright/test';
import { poserFaux, ouvrirAssistant } from './aide/assistant';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * LE CANAL RCS DANS L'ASSISTANT : son message, son VISUEL, et ce que le visuel change.
 *
 * ⚠️ CE FICHIER REMPLACE `campaign-rcs.spec.ts`, qui vérifiait sur l'écran retiré que choisir le RCS
 * remplaçait le numéro Meta par un agent de marque et le modèle par un message. L'assistant pose la même
 * question autrement (une chaîne d'étages), et le canal grisé sans agent reste vérifié à l'étape Canal.
 *
 * 🔴 CE QUE CE FICHIER AJOUTE, ET QUI N'EXISTAIT PAS DANS L'ASSISTANT : le VISUEL. Ce n'est pas une
 * décoration, c'est le FORMAT du message. Avec une image, `versMessageRcs` bascule en CARTE : l'image
 * passe au-dessus du texte, les boutons deviennent des boutons pleine largeur empilés DANS la carte
 * (4 au plus) au lieu de pastilles éphémères sous la bulle (11 au plus), et le plafond de texte descend
 * de 3 072 à 2 000 caractères.
 *
 * 🔴 ET SEUL LE CORPS DE LA REQUÊTE LE PROUVE. L'écran peut afficher le visuel, le téléverser, le montrer
 * en aperçu, et n'en rien envoyer : c'est exactement ce que faisait cet assistant, dont le constructeur
 * de message était un littéral `kind: 'text'`.
 */

const MESSAGES_RCS = [
  {
    id: 'm1', name: 'Offre du jour', createdAt: '', updatedAt: '',
    content: { kind: 'card', card: { description: 'Bonjour, votre offre', mediaUrl: 'https://exemple.test/v.jpg', mediaHeight: 'TALL', suggestions: [{ kind: 'reply', text: 'Oui', postbackData: 'p1' }] } },
  },
  // UN CARROUSEL : proposé depuis le 2026-09-21, et posé EN ENTIER sur l'étage (copie figée).
  {
    id: 'm2', name: 'Carrousel promo', createdAt: '', updatedAt: '',
    content: {
      kind: 'carousel',
      cards: [
        { title: 'Nice', mediaUrl: 'https://exemple.test/a.jpg', mediaHeight: 'TALL' },
        { title: 'Lyon', mediaUrl: 'https://exemple.test/b.jpg', mediaHeight: 'TALL' },
      ],
    },
  },
];

/** Une campagne nommée, sur un canal RCS SEUL, ouverte sur le cadre de son étage. */
async function surLEtageRcs(page: Page): Promise<void> {
  await ouvrirAssistant(page, { etape: 'nom', canal: 'rcs' });
  await page.getByTestId('assistant-nom').fill('Promo RCS');
  await page.getByRole('button', { name: 'Suivant' }).click(); // canal
  await page.getByRole('button', { name: 'Suivant' }).click(); // contenu
  await page.getByTestId('etage-1').click();
  await expect(page.getByTestId('rcs-texte')).toBeVisible({ timeout: 15_000 });
}

/** Mène jusqu'au lancement depuis l'étage RCS déjà rempli. */
async function lancer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Suivant' }).click(); // audience
  await page.getByRole('button', { name: 'Suivant' }).click(); // récapitulatif
  await expect(page.getByTestId('etape-recap')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('bouton-lancer').click();
}

test.describe('Assistant : le canal RCS', () => {
  test('sans agent déposé, le canal RCS est VISIBLE mais éteint et non cliquable', async ({ page }) => {
    // Le canal reste montré (on prépare son projet), mais rien ne partirait tant qu'aucun agent n'est
    // déposé. Les autres canaux, eux, restent cliquables.
    await poserFaux(page, { settings: { rcsEnabled: false } });
    await ouvrirAssistant(page, { etape: 'canal' });
    const rcs = page.getByRole('radio', { name: /RCS/ }).first();
    await expect(rcs).toBeVisible({ timeout: 15_000 });
    await expect(rcs).toBeDisabled();
    await expect(page.getByRole('radio', { name: /WhatsApp/ }).first()).toBeEnabled();
  });

  test('🔴 un visuel fait partir le message en CARTE, avec son image', async ({ page }) => {
    const f = await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    // Partir d'un message enregistré, qui porte déjà son visuel : c'est le chemin le plus court vers une
    // image, et il exerce en même temps la COPIE depuis la bibliothèque.
    await page.getByTestId('rcs-bibliotheque-1').selectOption('m1');
    await expect(page.getByTestId('rcs-texte')).toContainText('votre offre', { timeout: 15_000 });
    await lancer(page);
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.rcsMessage).toMatchObject({
      kind: 'card',
      card: { description: 'Bonjour, votre offre', mediaUrl: 'https://exemple.test/v.jpg', mediaHeight: 'TALL' },
    });
  });

  /**
   * 🔴 L'AUTRE SENS, ET C'EST LUI QUI SÉPARE. Sans visuel, le message reste un TEXTE : une implémentation
   * qui produirait toujours une carte passerait le cas du dessus et changerait la forme de toutes les
   * campagnes RCS existantes.
   */
  test('🔴 sans visuel, le message reste un TEXTE', async ({ page }) => {
    const f = await poserFaux(page);
    await surLEtageRcs(page);
    await page.getByTestId('rcs-texte').fill('Bonjour tout le monde');
    await lancer(page);
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.rcsMessage).toMatchObject({ kind: 'text', text: 'Bonjour tout le monde' });
  });

  /**
   * 🔴 UN CARROUSEL ENREGISTRÉ EST PROPOSÉ DEPUIS LE 2026-09-21, ET C'EST LUI QUI PART. Il se pose en ENTIER,
   * en copie figée : l'assistant ne l'édite pas, il le montre. Le texte masqué derrière lui ne part pas.
   *
   * ⚠️ CE CAS REMPLACE « un carrousel enregistré n'est PAS proposé » : la règle a changé, et le cas qu'il
   * exerçait (CE QUI EST PROPOSÉ dans la bibliothèque) est conservé, un message simple et un carrousel.
   */
  test('🔴 un carrousel enregistré est proposé, se dessine, et c est LUI qui part', async ({ page }) => {
    const f = await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    const select = page.getByTestId('rcs-bibliotheque-1');
    await expect(select.locator('option', { hasText: 'Offre du jour' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'Carrousel promo (carrousel)' })).toHaveCount(1);
    await page.getByTestId('rcs-texte').fill('texte masqué');
    await select.selectOption('m2');
    await expect(page.getByTestId('rcs-carrousel-apercu-carte-1')).toContainText('Lyon');
    await expect(page.getByTestId('rcs-texte')).toHaveCount(0);
    await lancer(page);
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.rcsMessage).toEqual(MESSAGES_RCS[1]!.content);
  });

  test('« Revenir à un message simple » rend le texte saisi, et c est lui qui part', async ({ page }) => {
    const f = await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    await page.getByTestId('rcs-texte').fill('Bonjour');
    await page.getByTestId('rcs-bibliotheque-1').selectOption('m2');
    await page.getByTestId('rcs-carrousel-retirer-1').click();
    await expect(page.getByTestId('rcs-texte')).toHaveText('Bonjour');
    await lancer(page);
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.rcsMessage).toMatchObject({ kind: 'text', text: 'Bonjour' });
  });

  test('🔴 à 1280 px, l étage portant un carrousel ne déborde pas', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    await page.getByTestId('rcs-bibliotheque-1').selectOption('m2');
    await expect(page.getByTestId('rcs-carrousel-apercu')).toBeVisible();
    await pasDeDebordement(page);
  });

  /**
   * 🔴 UN BOUTON INCOMPLET FAIT REFUSER TOUT LE MESSAGE côté serveur, pas seulement le bouton. Le lien
   * sans adresse est le cas courant, et il se voit à l'écran bien avant l'envoi.
   */
  test('🔴 un bouton de lien sans adresse empêche le lancement, avec sa raison', async ({ page }) => {
    const f = await poserFaux(page);
    await surLEtageRcs(page);
    await page.getByTestId('rcs-texte').fill('Bonjour');
    await page.getByRole('button', { name: /Ajouter une suggestion/ }).click();
    await page.getByTestId('campagne-rcs-1-bouton-kind-0').selectOption('openUrl');
    // Le libellé est rempli, l'adresse NON : c'est ce que la garde doit attraper.
    await page.getByPlaceholder('Libellé du bouton').fill('Voir l’offre');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await expect(page.getByTestId('recap-probleme')).toContainText(/bouton/i, { timeout: 15_000 });
    await expect(page.getByTestId('bouton-lancer')).toBeDisabled();
    expect(f.creations).toHaveLength(0);
  });

  /** 🔴 LA GARDE DE LARGEUR : l'éditeur de suggestions est le composant le plus large de la console. */
  test('🔴 à 1280 px, le cadre RCS avec son visuel et ses boutons ne déborde pas', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await poserFaux(page, { rcsMessages: MESSAGES_RCS });
    await surLEtageRcs(page);
    await page.getByTestId('rcs-bibliotheque-1').selectOption('m1');
    await page.getByRole('button', { name: /Ajouter une suggestion/ }).click();
    await pasDeDebordement(page);
  });
});
