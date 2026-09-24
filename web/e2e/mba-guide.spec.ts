import { test, expect } from '@playwright/test';
import { mockMba } from './support/mba';

/**
 * LE GUIDE DE L'AGENT DE META, ET CE QU'IL N'A PAS LE DROIT DE DIRE.
 *
 * 🔴 CE FICHIER NAÎT PARCE QUE CETTE PAGE N'ÉTAIT COUVERTE PAR RIEN (2026-09-24). Elle est entièrement faite
 * de prose en dur, aucun test ne la lisait, et trois de ses affirmations y ont vieilli jusqu'à devenir
 * fausses. C'est la démonstration exacte de la règle du dépôt : une affirmation qu'aucun test ne lit finit
 * par mentir, et celle-ci est lue par des PROSPECTS.
 *
 * 🔴 ON ÉPINGLE DES NÉGATIONS, PAS DES FORMULATIONS, et c'est délibéré. Le risque ici n'est pas qu'une phrase
 * disparaisse, c'est qu'elle REVIENNE à sa version fausse, ou qu'une prochaine réécriture la réintroduise de
 * bonne foi. Figer les mots exacts d'une page commerciale la rendrait impossible à retoucher ; interdire les
 * trois affirmations fausses laisse la plume libre et garde ce qui compte.
 *
 * Les trois, et pourquoi chacune coûtait quelque chose :
 *  1. « déploiement progressif, secteur par secteur » : Meta documente l'INVERSE, une liste d'EXCLUSION.
 *     Un prospect de la santé lisait « plus tard » quand la réponse est « non », et tous les autres lisaient
 *     « plus tard » quand la réponse est « oui ».
 *  2. « bientôt configurable ici » : la configuration existe depuis mi-août. C'était la dernière chose que
 *     le lecteur voyait, donc elle envoyait attendre devant une porte ouverte.
 *  3. « on les met en place avec vous » à propos des connexions aux systèmes : depuis Tools > Connecteurs
 *     API et le relais, le client le fait lui-même. La phrase rangeait une fonction en libre-service dans la
 *     case « prestation », donc personne ne la trouvait.
 */
test.describe('MBA Guide : les affirmations interdites', () => {
  test('🔴 l’eligibilite est une liste d EXCLUSION, jamais une file d attente', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba');

    const page_ = page.locator('main');
    // Ce que Meta documente, relu sur sa page de reference le 2026-09-24.
    await expect(page_).toContainText(/finance/i);
    await expect(page_).toContainText(/jeux d’argent|gambling/i);
    // 🔴 ET SURTOUT PAS LA FILE D ATTENTE : c est la formulation qui etait fausse.
    await expect(page_, 'le guide annonce de nouveau un deploiement progressif, ce que Meta ne documente pas')
      .not.toContainText(/secteur par secteur|sector by sector/i);
    await expect(page_).not.toContainText(/déploiement est progressif|rollout is gradual/i);
  });

  test('🔴 la configuration n est pas annoncee « bientot » : elle existe, et le guide y mene', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba');

    await expect(page.locator('main'), 'le guide promet de nouveau une configuration « bientot » alors qu elle existe')
      .not.toContainText(/bientôt configurable|configurable here soon/i);
    // Un lien, pas une invitation a chercher : qui lit ce guide ne connait pas encore le menu.
    await expect(page.getByRole('link', { name: /paramètres de l’agent|agent settings/i })).toHaveAttribute('href', '/mba/parametres');
  });

  test('🔴 brancher un systeme est en LIBRE-SERVICE, et le guide ne le range plus en prestation', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba');

    const page_ = page.locator('main');
    await expect(page_).toContainText(/Connecteurs API|API connectors/);
    await expect(page_, 'le guide fait de nouveau de la mise en place un prealable')
      .not.toContainText(/on les met en place avec vous|we set them up with you/i);
  });
});
