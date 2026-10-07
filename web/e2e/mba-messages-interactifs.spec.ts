import { test, expect } from '@playwright/test';
import { mockMba, appelsMba } from './support/mba';
import { repondreSurPlace } from './aide/confirmation';

/**
 * L'onglet « Messages interactifs » de l'agent de Meta (spec `docs/superpowers/specs/2026-10-07-messages-interactifs-design.md`).
 * L'ajout se fait comme l'ajout d'un outil : un bouton, une grille de neuf cartes, puis une fiche qui commence par
 * « Quand l'envoyer ».
 */

const OUVRIR = '/mba/parametres?tab=messages_interactifs';
const PUBLIE = { id: '111', name: 'Check-in', status: 'PUBLISHED', fields: [] };
const BROUILLON = { id: '222', name: 'Brouillon', status: 'DRAFT', fields: [] };
const EXISTANT = {
  id: 'm1', titre: 'boutons-rdv', type: 'interactive_reply_buttons', actif: true,
  consigne: 'Quand : le client veut un rendez-vous\nTexte du message : Quel créneau ?\nBoutons : Matin, Soir',
  formulaireId: null, creeLe: 1, modifieLe: 1,
};

test.describe('MBA Paramètres : messages interactifs', () => {
  test('🔴 la grille propose les neuf composants, et grise « Formulaire » sans formulaire publié', async ({ page }) => {
    await mockMba(page, { flows: [BROUILLON] });
    await page.goto(OUVRIR);
    await page.getByTestId('mba-messages-ajouter').click();
    await expect(page.getByTestId('mba-messages-types')).toBeVisible();
    for (const type of ['interactive_reply_buttons', 'interactive_list', 'cta_url', 'flow', 'image', 'location', 'location_request', 'carousel_url', 'carousel_quick_reply']) {
      await expect(page.getByTestId(`mba-message-type-${type}`)).toBeVisible();
    }
    // Un brouillon ne compte pas : seul un formulaire publié peut être ouvert par l'agent.
    await expect(page.getByTestId('mba-message-type-flow')).toBeDisabled();
    await expect(page.getByTestId('mba-message-type-flow-lien')).toHaveAttribute('href', '/flows');
    await expect(page.getByTestId('mba-message-type-cta_url')).toBeEnabled();
  });

  test('🔴 la fiche commence par « Quand l’envoyer », pré-remplit le canevas, et envoie une consigne composée', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto(OUVRIR);
    await page.getByTestId('mba-messages-ajouter').click();
    await page.getByTestId('mba-message-type-interactive_reply_buttons').click();

    await expect(page.getByTestId('mba-message-fiche-type')).toContainText('Boutons de réponse');
    await expect(page.getByTestId('mba-message-contenu')).toHaveValue(/Boutons \(1 à 3/);
    // Sans « quand », rien ne part : c'est ce qui dit à l'agent dans quelle situation envoyer le message.
    await expect(page.getByTestId('mba-message-enregistrer')).toBeDisabled();
    await page.getByTestId('mba-message-quand').fill('le client veut un rendez-vous');
    await page.getByTestId('mba-message-contenu').fill('Texte du message : Quel créneau ?\nBoutons : Matin, Soir');

    // Le nom suit la règle de Meta (un slug), mis en forme pendant la frappe comme celui d'une consigne.
    await page.getByTestId('mba-message-titre').fill('');
    await page.getByTestId('mba-message-titre').pressSequentially('Boutons RDV');
    await expect(page.getByTestId('mba-message-titre')).toHaveValue('boutons-rdv');
    await page.getByTestId('mba-message-enregistrer').click();

    await expect.poll(() => appelsMba(calls, 'POST', '/messages-interactifs')[0]?.body).toEqual({
      type: 'interactive_reply_buttons',
      titre: 'boutons-rdv',
      consigne: 'Quand : le client veut un rendez-vous\nTexte du message : Quel créneau ?\nBoutons : Matin, Soir',
    });
    await expect(page.getByTestId('mba-message-m-neuf')).toContainText('Boutons de réponse');
  });

  test('🔴 un formulaire : seuls les formulaires PUBLIÉS sont proposés, et l’identifiant part avec', async ({ page }) => {
    const calls = await mockMba(page, { flows: [PUBLIE, BROUILLON] });
    await page.goto(OUVRIR);
    await page.getByTestId('mba-messages-ajouter').click();
    await page.getByTestId('mba-message-type-flow').click();
    const options = page.getByTestId('mba-message-formulaire').locator('option');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveText('Check-in');
    await page.getByTestId('mba-message-quand').fill('le client veut faire son check-in');
    await page.getByTestId('mba-message-enregistrer').click();
    await expect.poll(() => appelsMba(calls, 'POST', '/messages-interactifs')[0]?.body).toMatchObject({ type: 'flow', formulaireId: '111' });
  });

  test('🔴 modifier : la fiche se rouvre séparée, le type est figé, et seuls titre et consigne partent', async ({ page }) => {
    const calls = await mockMba(page, { messagesInteractifs: [EXISTANT] });
    await page.goto(OUVRIR);
    await page.getByTestId('mba-message-modifier-m1').click();
    await expect(page.getByTestId('mba-message-quand')).toHaveValue('le client veut un rendez-vous');
    await expect(page.getByTestId('mba-message-contenu')).toHaveValue('Texte du message : Quel créneau ?\nBoutons : Matin, Soir');
    await expect(page.getByTestId('mba-message-fiche-type-fige')).toBeVisible();
    await page.getByTestId('mba-message-quand').fill('le client demande un créneau');
    await page.getByTestId('mba-message-enregistrer').click();
    await expect.poll(() => appelsMba(calls, 'PUT', '/messages-interactifs/m1')[0]?.body).toEqual({
      titre: 'boutons-rdv',
      consigne: 'Quand : le client demande un créneau\nTexte du message : Quel créneau ?\nBoutons : Matin, Soir',
    });
  });

  test('🔴 une fiche ouverte verrouille la liste : on ne passe pas d’un message à l’autre en emportant ses champs', async ({ page }) => {
    // Le défaut trouvé par la relecture de la livraison B : « Modifier » A puis « Modifier » B, sans annuler, gardait le
    // texte de A dans la fiche de B, et « Enregistrer » l'écrivait sur B, sans trace.
    const AUTRE = { ...EXISTANT, id: 'm2', titre: 'liste-creneaux', type: 'interactive_list', consigne: 'Quand : le client demande les créneaux\nTexte du message : Les créneaux libres' };
    await mockMba(page, { messagesInteractifs: [EXISTANT, AUTRE] });
    await page.goto(OUVRIR);
    await page.getByTestId('mba-message-modifier-m1').click();
    await page.getByTestId('mba-message-quand').fill('texte saisi pour boutons-rdv');
    await expect(page.getByTestId('mba-message-modifier-m2')).toBeDisabled();
    await expect(page.getByTestId('mba-message-supprimer-m2')).toBeDisabled();
    await expect(page.getByTestId('mba-message-actif-m2')).toBeDisabled();
    await page.getByTestId('mba-message-annuler').click();
    await page.getByTestId('mba-message-modifier-m2').click();
    await expect(page.getByTestId('mba-message-quand')).toHaveValue('le client demande les créneaux');
    await expect(page.getByTestId('mba-message-titre')).toHaveValue('liste-creneaux');
  });

  test('une erreur du serveur s’affiche et la fiche reste ouverte, saisie comprise', async ({ page }) => {
    await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && url.includes('/messages-interactifs')) {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'titre invalide : minuscules, chiffres et tirets seulement' }) });
          return true;
        }
        return false;
      },
    });
    await page.goto(OUVRIR);
    await page.getByTestId('mba-messages-ajouter').click();
    await page.getByTestId('mba-message-type-cta_url').click();
    await expect(page.getByTestId('mba-message-quand-invite')).toBeVisible();
    await page.getByTestId('mba-message-quand').fill('la réservation est faite');
    await expect(page.getByTestId('mba-message-quand-invite')).toHaveCount(0);
    await page.getByTestId('mba-message-enregistrer').click();
    await expect(page.getByTestId('mba-messages-erreur')).toContainText('titre invalide');
    await expect(page.getByTestId('mba-message-quand')).toHaveValue('la réservation est faite');
  });

  test('le titre de départ est unique : un deuxième message du même type ne reprend pas le nom du premier', async ({ page }) => {
    await mockMba(page, { messagesInteractifs: [{ ...EXISTANT, titre: 'boutons-de-reponse' }] });
    await page.goto(OUVRIR);
    await page.getByTestId('mba-messages-ajouter').click();
    await page.getByTestId('mba-message-type-interactive_reply_buttons').click();
    await expect(page.getByTestId('mba-message-titre')).toHaveValue('boutons-de-reponse-2');
  });

  test('l’interrupteur ne change que l’état, et la suppression demande confirmation', async ({ page }) => {
    const calls = await mockMba(page, { messagesInteractifs: [EXISTANT] });
    await page.goto(OUVRIR);
    await page.getByTestId('mba-message-actif-m1').click();
    await expect.poll(() => appelsMba(calls, 'PUT', '/messages-interactifs/m1')[0]?.body).toEqual({ actif: false });
    await page.getByTestId('mba-message-supprimer-m1').click();
    await repondreSurPlace(page, true);
    await expect.poll(() => appelsMba(calls, 'DELETE', '/messages-interactifs/m1').length).toBe(1);
  });

  test('agent pas encore créé : le même motif que les consignes, aucun bouton', async ({ page }) => {
    await mockMba(page, { status: { onboarded: false, agentId: null } });
    await page.goto(OUVRIR);
    await expect(page.getByTestId('mba-messages-no-agent')).toBeVisible();
    await expect(page.getByTestId('mba-messages-ajouter')).toHaveCount(0);
  });

  test('le banc « Tester » prévient qu’un message interactif ne s’y affiche pas', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba/parametres?tab=test');
    await expect(page.getByTestId('mba-test-messages-interactifs')).toBeVisible();
  });

  test('🔴 le diff de l’assistant montre la consigne entière d’un message interactif, pas seulement son nom', async ({ page }) => {
    await mockMba(page, {
      custom: async (route, method, url) => {
        if (method === 'POST' && new URL(url).pathname.endsWith('/mba/assistant')) {
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
              message: 'Je propose ce message.',
              operations: [{
                type: 'message_interactif.ajouter', libelle: 'Message interactif : paiement', titre: 'paiement',
                composant: 'cta_url', consigne: 'Quand : la réservation est faite\nAdresse : https://paiement.exemple.fr',
              }],
            }),
          });
          return true;
        }
        return false;
      },
    });
    await page.goto('/mba/parametres?tab=assistant');
    await page.getByTestId('mba-assistant-saisie').fill('Ajoute un bouton de paiement');
    await page.getByTestId('mba-assistant-envoyer').click();
    await expect(page.getByTestId('mba-assistant-diff')).toContainText('Message interactif : paiement');
    await expect(page.getByTestId('mba-assistant-detail-message')).toContainText('Bouton lien');
    await expect(page.getByTestId('mba-assistant-detail-message')).toContainText('https://paiement.exemple.fr');
  });
});
