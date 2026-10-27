import { test, expect } from './aide/test';
import { mockMba } from './support/mba';

/**
 * Meta a déjà appliqué le geste : perdre cet avertissement inviterait le client à cliquer une seconde fois.
 * Les cinq surfaces qui rendent cet état ont chacune un témoin d'interface.
 */

const suppressions = [
  {
    nom: 'FAQ', tab: 'faq', liste: 'mba-faq-list', avertissement: 'mba-faq-history-warning', bouton: /Supprimer|Delete/,
    fixture: { faqs: [{ id: 'f1', question: 'Horaires ?', answer: '9 h à 18 h' }] },
  },
  {
    nom: 'consigne', tab: 'competences', liste: 'mba-skills-list', avertissement: 'mba-skills-history-warning', bouton: /Supprimer|Delete/,
    fixture: { skills: [{ id: 's1', title: 'prise-rdv', description: 'Quand le client demande', skill: 'Proposer deux créneaux' }] },
  },
  {
    nom: 'site', tab: 'sites', liste: 'mba-websites-list', avertissement: 'mba-websites-history-warning', bouton: /Retirer|Remove/,
    fixture: { websites: [{ id: 'w1', url: 'https://exemple.fr', crawl_status: 'completed' }] },
  },
  {
    nom: 'fichier', tab: 'fichiers', liste: 'mba-files-list', avertissement: 'mba-files-history-warning', bouton: /Supprimer|Delete/,
    fixture: { files: [{ id: 'd1', file_name: 'conditions.pdf', status: 'ready' }] },
  },
  {
    nom: 'message interactif', tab: 'messages_interactifs', liste: 'mba-messages-liste', avertissement: 'mba-messages-history-warning', bouton: /Supprimer|Delete/,
    fixture: { messagesInteractifs: [{ id: 'm1', titre: 'boutons-rdv', type: 'interactive_reply_buttons', actif: true, consigne: 'Quand : rendez-vous', formulaireId: null, creeLe: 1, modifieLe: 1 }] },
  },
];

for (const cas of suppressions) {
  test(`suppression ${cas.nom} : le succès Meta sans historique avertit de ne pas recommencer`, async ({ page }) => {
    await mockMba(page, { ...cas.fixture, historiqueIndisponible: true });
    await page.goto(`/mba/parametres?tab=${cas.tab}`);

    await page.getByTestId(cas.liste).getByRole('button', { name: cas.bouton }).click();
    await page.getByTestId('confirmation-oui').click();

    await expect(page.getByTestId(cas.avertissement)).toContainText(/Ne recommencez pas|Do not try it again/);
  });
}

test('assistant : une modification appliquée sans historique reste un avertissement, pas un échec', async ({ page }) => {
  await mockMba(page, {
    custom: async (route, method, url) => {
      const chemin = new URL(url).pathname;
      if (method === 'POST' && chemin.endsWith('/mba/assistant/appliquer')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            passees: ['FAQ : Horaires ?'],
            echec: null,
            nonTentees: [],
            avertissements: [{
              libelle: 'FAQ : Horaires ?',
              message: 'La modification a bien été appliquée chez Meta, mais son historique est indisponible. Ne la renvoyez pas.',
            }],
          }),
        });
        return true;
      }
      if (method === 'POST' && chemin.endsWith('/mba/assistant')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Je peux ajouter cette question.',
            operations: [{ type: 'faq.ajouter', question: 'Horaires ?', reponse: '9 h à 18 h', libelle: 'FAQ : Horaires ?' }],
          }),
        });
        return true;
      }
      return false;
    },
  });
  await page.goto('/mba/parametres?tab=assistant');
  await page.getByTestId('mba-assistant-saisie').fill('Ajoute les horaires');
  await page.getByTestId('mba-assistant-envoyer').click();
  await page.getByTestId('mba-assistant-appliquer').click();

  const avertissement = page.getByTestId('mba-assistant-avertissements');
  await expect(avertissement).toContainText('FAQ : Horaires ?');
  await expect(avertissement).toContainText(/Ne la renvoyez pas|Do not resend it/);
});
