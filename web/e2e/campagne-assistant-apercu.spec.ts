import { test, expect } from '@playwright/test';
import { poserFaux, ouvrirAssistant } from './aide/assistant';
import { TREIZE_POUCES, pasDeDebordement } from './aide/largeur';

/**
 * L'APERÇU DU MODÈLE DANS L'ASSISTANT : carousel, en-tête média et boutons compris.
 *
 * 🔴 SANS LUI, L'OPÉRATEUR VALIDE UN ENVOI DE MASSE SUR UN NOM DE MODÈLE. C'est la capacité qui manquait
 * le plus à l'usage, et la dernière que l'écran retiré le 2026-09-13 portait seul. Ce fichier remplace
 * `campaign-carousel-preview.spec.ts`, qui exerçait les deux mêmes cas sur cet écran-là : un carousel
 * choisi DIRECTEMENT, et un carousel atteint par le scénario qui l'ouvre.
 *
 * 🔴 LE CHOIX CAROUSEL OU BULLE SE FAIT SUR LE CONTENU DU MODÈLE, JAMAIS SUR L'ÉCRAN. C'est ce que le
 * composant partagé garantit : les trois endroits du produit qui montrent un modèle approuvé (Inbox,
 * campagne directe, campagne par scénario) montrent la même chose, parce que c'est le même composant.
 */

const CAROUSEL = {
  id: 't-car', name: 'promo_carousel', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Découvrez la sélection', headerFormat: null, isCarousel: true,
  carousel: {
    cards: [
      { mediaUrl: 'https://exemple.test/carte1.jpg', body: 'Séjour à Nice', buttons: [{ type: 'QUICK_REPLY', text: 'Ça m’intéresse' }] },
      { mediaUrl: 'https://exemple.test/carte2.jpg', body: 'Séjour à Lyon', buttons: [{ type: 'QUICK_REPLY', text: 'Ça m’intéresse' }] },
    ],
  },
};

/** ⚠️ UN EN-TÊTE IMAGE AVEC SON URL : c'est le seul morceau du modèle que l'aperçu de campagne JETAIT. */
const AVEC_IMAGE = {
  id: 't-img', name: 'promo_visuel', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Bonjour {{1}}', headerFormat: 'IMAGE', headerMediaUrl: 'https://exemple.test/entete.jpg',
  footer: 'Répondez STOP pour ne plus recevoir', isCarousel: false,
  buttons: [{ type: 'URL', text: 'Voir l’offre', url: 'https://exemple.test' }],
};

const SCENARIO_CAROUSEL = {
  id: 'wf-car', name: 'Promo carousel', campaignEligible: true,
  graph: { nodes: [{ id: 'n1', type: 'template', position: { x: 0, y: 0 }, data: { templateName: 'promo_carousel', language: 'fr' } }], edges: [] },
};

test.describe('Assistant : l’aperçu du modèle', () => {
  test('🔴 un modèle choisi DIRECTEMENT montre sa vraie bulle, pas seulement son nom', async ({ page }) => {
    await poserFaux(page, { templates: [AVEC_IMAGE] });
    await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo_visuel');
    await expect(page.getByTestId('apercu-1')).toBeVisible({ timeout: 15_000 });
    // Le corps réel, avec la variable remplacée par son exemple lisible (le défaut est « Nom »).
    await expect(page.getByTestId('apercu-1')).toContainText('Bonjour');
    // Le BOUTON du modèle : ce que le contact verra sous la bulle.
    await expect(page.getByTestId('apercu-1')).toContainText('Voir l’offre');
  });

  /**
   * 🔴 L'EN-TÊTE MÉDIA ÉTAIT LE SEUL MORCEAU JETÉ PAR L'APERÇU DE CAMPAGNE. L'écran Modèles l'affichait
   * depuis toujours ; la campagne montrait une bulle SANS le visuel que le destinataire recevra, ce qui
   * est exactement l'inverse de ce qu'un aperçu promet.
   */
  test('🔴 l’en-tête MÉDIA du modèle est affiché, et son pied de page aussi', async ({ page }) => {
    await poserFaux(page, { templates: [AVEC_IMAGE] });
    await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo_visuel');
    const apercu = page.getByTestId('apercu-1');
    await expect(apercu).toBeVisible({ timeout: 15_000 });
    await expect(apercu.locator('img[src="https://exemple.test/entete.jpg"]')).toHaveCount(1);
    await expect(apercu).toContainText('Répondez STOP');
  });

  test('un modèle CAROUSEL montre ses vraies cartes, pas un encadré de texte', async ({ page }) => {
    await poserFaux(page, { templates: [CAROUSEL] });
    await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo_carousel');
    await expect(page.getByTestId('carousel-cards')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Séjour à Nice')).toBeVisible();
    await expect(page.getByText('Séjour à Lyon')).toBeVisible();
  });

  /**
   * 🔴 EN FORMULE « MODÈLE ET SCÉNARIO », CE N'EST PAS LE MODÈLE DU SÉLECTEUR QUI PART : c'est celui par
   * lequel le scénario OUVRE. Montrer le premier afficherait une bulle que personne ne recevra, juste à
   * côté de la liste de variables du second.
   */
  test('🔴 un scénario montre le modèle par lequel il OUVRE, pas celui du sélecteur', async ({ page }) => {
    await poserFaux(page, {
      templates: [CAROUSEL],
      workflows: [SCENARIO_CAROUSEL],
      graphe: SCENARIO_CAROUSEL.graph,
    });
    await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
    await page.getByTestId('etage-1').click();
    await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
    await page.getByTestId('scenario-1').selectOption('wf-car');
    await expect(page.getByTestId('apercu-1')).toContainText('modèle envoyé par le scénario', { timeout: 15_000 });
    await expect(page.getByTestId('carousel-cards')).toBeVisible({ timeout: 15_000 });
  });

  test('sans modèle choisi, il n’y a AUCUN cadre d’aperçu : un cadre vide ressemble à une panne', async ({ page }) => {
    await poserFaux(page, { templates: [AVEC_IMAGE] });
    await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
    await page.getByTestId('etage-1').click();
    await expect(page.getByTestId('modele-1')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('apercu-1')).toHaveCount(0);
  });

  /**
   * 🔴 LA GARDE DE LARGEUR. `PhoneFrame` est FLUIDE : sans borne, il rendrait une bulle de téléphone large
   * comme la colonne de 768 px, et un carousel y déborderait. Le développeur travaille en 1920, l'opérateur
   * ouvre la console sur un 13 pouces, et le débordement n'apparaît que chez lui.
   */
  test('🔴 à 1280 px, l’aperçu ne déborde pas et reste borné dans sa colonne', async ({ page }) => {
    await page.setViewportSize(TREIZE_POUCES);
    await poserFaux(page, { templates: [CAROUSEL] });
    await ouvrirAssistant(page, { etape: 'contenu', canal: 'whatsapp' });
    await page.getByTestId('etage-1').click();
    await page.getByTestId('modele-1').selectOption('promo_carousel');
    await expect(page.getByTestId('apercu-1')).toBeVisible({ timeout: 15_000 });
    await pasDeDebordement(page);
    // Et il reste DANS son cadre d'étage : un débordement masqué par `overflow-hidden` ne se verrait pas
    // au contrôle ci-dessus, seule la comparaison des boîtes l'attrape.
    const cadre = (await page.getByTestId('etage-1').boundingBox())!;
    const apercu = (await page.getByTestId('apercu-1').boundingBox())!;
    expect(apercu.x + apercu.width, 'l’aperçu sort de son cadre d’étage')
      .toBeLessThanOrEqual(cadre.x + cadre.width + 1);
  });
});
