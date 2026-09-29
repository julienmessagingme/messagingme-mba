import { test, expect } from '@playwright/test';
import { mockMba } from './support/mba';

/**
 * CE QUI RESTE VRAI DU GUIDE DE L'AGENT DE META, retiré le 2026-09-29 (décision de Julien).
 *
 * `mba-guide.spec.ts` épinglait trois affirmations fausses que le guide ne devait plus dire. Deux ne vivaient que sur
 * sa page (« bientôt configurable », « on les met en place avec vous ») et sont parties avec elle. La troisième,
 * l'éligibilité, se dit désormais à l'endroit où elle bloque : le bandeau du numéro pas encore ouvert. Et c'est là
 * qu'elle était fausse : il annonçait encore une ouverture « progressive, par pays et par secteur ».
 *
 * 🔴 ON ÉPINGLE DES NÉGATIONS, PAS DES FORMULATIONS, comme le faisait le guide : figer les mots exacts rendrait le
 * texte impossible à retoucher ; interdire l'affirmation fausse garde ce qui compte.
 */
test.describe('MBA : l’éligibilité, et l’adresse du guide retiré', () => {
  test('🔴 l’adresse /mba mène aux paramètres de l’agent', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba');
    await expect(page).toHaveURL(/\/mba\/parametres$/);
  });

  test('🔴 le bandeau du numéro pas encore ouvert dit une liste d’EXCLUSION, jamais une file d’attente', async ({ page }) => {
    await mockMba(page, { status: { eligible: false, onboarded: false, agentId: null, settings: null } });
    await page.goto('/mba/parametres');
    const bandeau = page.getByTestId('mba-gate-not-eligible');
    await expect(bandeau).toBeVisible();
    // Ce que Meta documente (page de référence relue le 2026-09-24).
    await expect(bandeau).toContainText(/finance/i);
    await expect(bandeau).toContainText(/jeux d’argent|gambling/i);
    await expect(bandeau, 'le bandeau annonce de nouveau une ouverture progressive, ce que Meta ne documente pas')
      .not.toContainText(/progressivement|gradually|secteur par secteur|sector by sector/i);
    // Plus aucun renvoi vers le guide retiré : le seul lien relit l'état du numéro.
    await expect(bandeau.getByRole('link')).toHaveAttribute('href', '/mba/parametres');
  });
});
