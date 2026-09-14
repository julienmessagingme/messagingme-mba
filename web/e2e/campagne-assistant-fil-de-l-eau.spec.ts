import { test, expect, type Page } from '@playwright/test';
import { poserFaux, ouvrirAssistant, type Options } from './aide/assistant';

/**
 * LA CAMPAGNE AU FIL DE L'EAU : au lieu d'une liste figée, on désigne une ADRESSE (Tools > Webhooks) et la
 * campagne prend chaque contact qui arrive par elle.
 *
 * ⚠️ CE FICHIER REMPLACE `campaign-webhook.spec.ts`, qui exerçait ces cas sur l'écran retiré le
 * 2026-09-13. Les avertissements et le nettoyage d'une adresse morte n'ont pas été refaits : le panneau a
 * été extrait tel quel dans `SourceWebhook`, et ce sont les mêmes cas qui le gardent.
 *
 * 🔴 DEUX CHOSES NE SE VOIENT QUE DE BOUT EN BOUT :
 *  - une campagne devient lançable SANS aucun contact coché, ce qui est refusé partout ailleurs ;
 *  - le corps de la requête porte l'ADRESSE et AUCUNE liste. Le serveur refuse les deux ensemble, et
 *    surtout ce serait mentir sur ce qui va partir.
 */

const WEBHOOKS = [
  { id: 'wh1', name: 'Leads du site', enabled: true, code: 'ab12', url: 'https://x/w/ab', hasSecret: false, mapping: [], createContact: true, optIn: true, workflowId: null, startNodeId: null, cooldownSeconds: null, lastPayload: null, lastReceivedAt: null, contactsCreated: 0, createdAt: '2026-08-20T09:00:00.000Z' },
  { id: 'wh2', name: 'Salon (sans consentement)', enabled: true, code: 'cd12', url: 'https://x/w/cd', hasSecret: false, mapping: [], createContact: false, optIn: false, workflowId: null, startNodeId: null, cooldownSeconds: null, lastPayload: null, lastReceivedAt: null, contactsCreated: 0, createdAt: '2026-08-20T09:00:00.000Z' },
  { id: 'wh3', name: 'Adresse éteinte', enabled: false, code: 'ef12', url: 'https://x/w/ef', hasSecret: false, mapping: [], createContact: true, optIn: true, workflowId: null, startNodeId: null, cooldownSeconds: null, lastPayload: null, lastReceivedAt: null, contactsCreated: 0, createdAt: '2026-08-20T09:00:00.000Z' },
];

/** Une campagne nommée, avec son modèle, arrêtée à l'étape Audience. */
async function jusquALAudience(page: Page): Promise<void> {
  await ouvrirAssistant(page, { etape: 'nom' });
  await page.getByTestId('assistant-nom').fill('Leads en continu');
  await page.getByRole('button', { name: 'Suivant' }).click(); // canal
  // ⚠️ LE CANAL SE CHOISIT, DEPUIS LE 2026-09-14 : il n'a plus de defaut, et « Suivant » est garde tant
  // qu'aucune des trois entrees n'est cochee. Ce parcours traversait l'etape sans rien y toucher.
  await page.getByRole('radio', { name: 'WhatsApp', exact: true }).check();
  await page.getByRole('button', { name: 'Suivant' }).click(); // contenu
  await page.getByTestId('etage-1').click();
  await page.getByTestId('modele-1').selectOption('promo');
  await page.getByRole('button', { name: 'Suivant' }).click(); // audience
  await expect(page.getByTestId('etape-audience')).toBeVisible({ timeout: 15_000 });
}

const faux = (page: Page, o: Options = {}) => poserFaux(page, { webhooks: WEBHOOKS, ...o });

test.describe('Assistant : le choix de la source', () => {
  test('🔴 HubSpot n’apparaît PAS quand le connecteur est éteint sur l’accueil', async ({ page }) => {
    // Un bouton grisé pour une intégration qu'on n'a pas est du bruit, pas une information (Julien, 2026-08-26).
    await faux(page, { settings: { hubspotListsEnabled: false } });
    await jusquALAudience(page);
    await expect(page.getByTestId('audience-source-hubspot')).toHaveCount(0);
    // Le fil de l'eau, lui, est toujours là : il ne dépend d'aucune intégration tierce.
    await expect(page.getByTestId('audience-source-webhook')).toBeVisible();
  });

  test('HubSpot apparaît quand le connecteur est activé', async ({ page }) => {
    await faux(page, { settings: { hubspotListsEnabled: true } });
    await jusquALAudience(page);
    await expect(page.getByTestId('audience-source-hubspot')).toBeVisible();
  });

  // ⚠️ EN PAUSE, IL S'AFFICHE GRISÉ AVEC SA RAISON : l'empêchement se lève d'un clic sur l'accueil, à la
  // différence de l'absence du connecteur.
  test('🔴 HubSpot en PAUSE reste visible, mais éteint', async ({ page }) => {
    await faux(page, { settings: { hubspotListsEnabled: true, campaignsPaused: true } });
    await jusquALAudience(page);
    await expect(page.getByTestId('audience-source-hubspot')).toBeDisabled();
  });
});

test.describe('Assistant : la campagne au fil de l’eau', () => {
  test('🔴 une adresse suffit, SANS aucun contact coché, et le corps ne porte AUCUNE liste', async ({ page }) => {
    const f = await faux(page);
    await jusquALAudience(page);
    await page.getByTestId('audience-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await page.getByRole('button', { name: 'Suivant' }).click(); // récapitulatif
    await expect(page.getByTestId('etape-recap')).toBeVisible({ timeout: 15_000 });
    // ⚠️ AUCUN PROBLÈME ANNONCÉ : c'est le cas que la garde « aucun contact sélectionné » bloquait.
    await expect(page.getByTestId('recap-probleme')).toHaveCount(0);

    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]).toMatchObject({ webhookId: 'wh1' });
    expect(f.creations[0]!.contactIds, 'une liste est partie avec l’adresse').toBeUndefined();
    expect(f.creations[0]!.contactTarget, 'des filtres sont partis avec l’adresse').toBeUndefined();
  });

  test('🔴 sans adresse choisie, le lancement est refusé avec sa raison', async ({ page }) => {
    const f = await faux(page);
    await jusquALAudience(page);
    await page.getByTestId('audience-source-webhook').click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await expect(page.getByTestId('recap-probleme')).toContainText(/adresse/i, { timeout: 15_000 });
    await expect(page.getByTestId('bouton-lancer')).toBeDisabled();
    expect(f.creations).toHaveLength(0);
  });

  /**
   * 🔴 ZÉRO DESTINATAIRE N'EST PAS UNE ERREUR ICI. Sur une liste, c'est l'alerte rouge « rien ne partira ».
   * Au fil de l'eau, c'est l'état NORMAL de départ : confondre les deux bloquerait la seule création valide
   * de ce mode.
   */
  test('🔴 zéro destinataire à la création n’est PAS une erreur au fil de l’eau', async ({ page }) => {
    const f = await faux(page, { creation: { campaignId: 'camp-1', recipientCount: 0, skipped: [] } });
    await jusquALAudience(page);
    await page.getByTestId('audience-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('bouton-lancer').click();
    await expect(page.getByTestId('recap-lancee')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Aucun destinataire/)).toHaveCount(0);
    expect(f.lancements).toHaveLength(1);
  });

  test('🔴 une adresse qui n’affirme pas le consentement est signalée AVANT le lancement', async ({ page }) => {
    // Sinon la campagne marketing part, écarte tout le monde pour « pas de consentement », et l'opérateur
    // découvre le problème après coup dans le détail des destinataires.
    await faux(page);
    await jusquALAudience(page);
    await page.getByTestId('audience-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh2');
    await expect(page.getByTestId('campaign-webhook-optin')).toBeVisible();
    // Et la même adresse ne crée pas les contacts inconnus : deuxième limite, dite elle aussi.
    await expect(page.getByTestId('campaign-webhook-creation')).toBeVisible();
    // L'adresse qui affirme le consentement, elle, ne déclenche aucun avertissement.
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await expect(page.getByTestId('campaign-webhook-optin')).toHaveCount(0);
  });

  test('une adresse DÉSACTIVÉE n’est pas proposée', async ({ page }) => {
    await faux(page);
    await jusquALAudience(page);
    await page.getByTestId('audience-source-webhook').click();
    const select = page.getByTestId('campaign-webhook-select');
    await expect(select.locator('option', { hasText: 'Leads du site' })).toHaveCount(1);
    await expect(select.locator('option', { hasText: 'Adresse éteinte' })).toHaveCount(0);
  });

  /**
   * 🔴 REVENIR SUR LA LISTE DE CONTACTS N'ENVOIE PLUS L'ADRESSE. Elle RESTE dans l'état (pour ne pas la
   * reperdre à chaque aller-retour), et c'est la SOURCE qui tranche au moment de construire la requête :
   * sans ça, une campagne partirait « au fil de l'eau » alors que l'opérateur a sous les yeux une liste.
   */
  test('🔴 revenir sur la liste de contacts n’emporte plus l’adresse', async ({ page }) => {
    const f = await faux(page);
    await jusquALAudience(page);
    await page.getByTestId('audience-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await page.getByRole('button', { name: '📇 Liste de contacts' }).click();
    await page.getByRole('button', { name: 'Suivant' }).click();
    await page.getByTestId('bouton-lancer').click();
    await expect.poll(() => f.creations.length, { timeout: 15_000 }).toBe(1);
    expect(f.creations[0]!.webhookId, 'l’adresse est partie sur une campagne à liste').toBeUndefined();
    expect(f.creations[0]!.contactTarget).toBeDefined();
  });

  /**
   * 🔴 UNE ADRESSE DISPARUE NE DOIT PAS FAIRE PARTIR UNE CAMPAGNE SUR UNE ADRESSE MORTE. Le sélecteur
   * l'afficherait VIDE alors que l'état la porte encore : l'écran aurait l'air prêt, et le serveur
   * refuserait la création en 400 sans que personne comprenne pourquoi.
   */
  test('🔴 un brouillon dont l’adresse a disparu ne part pas sur une adresse morte', async ({ page }) => {
    await faux(page, {
      brouillons: [{
        id: 'd1', name: 'Repris', updatedAt: '2026-09-13T09:00:00.000Z',
        state: { source: 'webhook', webhookId: 'wh-supprime', mode: 'template', templateName: 'promo', templateLanguage: 'fr', vars: [] },
      }],
    });
    await ouvrirAssistant(page, { etape: 'audience', brouillon: 'd1' });
    await expect(page.getByTestId('campaign-webhook-select')).toHaveValue('', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Suivant' }).click();
    await expect(page.getByTestId('recap-probleme')).toContainText(/adresse/i, { timeout: 15_000 });
  });

  // ⚠️ L'AUTRE SENS : une adresse qui existe TOUJOURS est bien retrouvée. Sans ce cas, un nettoyage
  // systématique passerait celui du dessus et effacerait toutes les reprises.
  test('un brouillon dont l’adresse existe TOUJOURS la retrouve', async ({ page }) => {
    await faux(page, {
      brouillons: [{
        id: 'd1', name: 'Repris', updatedAt: '2026-09-13T09:00:00.000Z',
        state: { source: 'webhook', webhookId: 'wh1', mode: 'template', templateName: 'promo', templateLanguage: 'fr', vars: [] },
      }],
    });
    await ouvrirAssistant(page, { etape: 'audience', brouillon: 'd1' });
    await expect(page.getByTestId('campaign-webhook-select')).toHaveValue('wh1', { timeout: 15_000 });
  });

  /** ⚠️ LE RÉCAPITULATIF NE COMPTE PAS DES CONTACTS QUI N'EXISTENT PAS ENCORE : « 0 » serait lu comme une panne. */
  test('🔴 le récapitulatif ne montre AUCUN compte, il dit ce qui se passera', async ({ page }) => {
    await faux(page);
    await jusquALAudience(page);
    await page.getByTestId('audience-source-webhook').click();
    await page.getByTestId('campaign-webhook-select').selectOption('wh1');
    await page.getByRole('button', { name: 'Suivant' }).click();
    await expect(page.getByTestId('lien-audience')).toContainText(/fil de l/i, { timeout: 15_000 });
    await expect(page.getByTestId('lien-audience')).not.toContainText(/0 contacts retenus/);
    await expect(page.getByTestId('bloc-cout')).toContainText(/tant que la campagne reste ouverte/i);
  });
});
