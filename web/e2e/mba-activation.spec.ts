import { test, expect } from '@playwright/test';
import { mockMba } from './support/mba';

/**
 * MBA > Paramètres > Activation : les deux réglages qui décident QUI parle au client, réunis.
 *
 * Ce que ces tests protègent, au-delà du rendu : que le choix parte bien au serveur (un écran qui affiche la
 * sélection sans jamais l'enregistrer passerait un test purement visuel), et que le délai de reprise, déplacé
 * ici depuis l'Accueil, écrive toujours des SECONDES alors que la saisie est en minutes.
 */
test.describe('MBA : le plafond de dépense de l’agent', () => {
  test('sans plafond, l’écran le dit ; poser un plafond en réponses l’envoie et l’affiche', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=activation');
    await expect(page.getByTestId('mba-plafond-actuel')).toContainText(/Aucun plafond|No cap/);
    await page.getByTestId('mba-plafond-unite-ai_turn').check();
    await page.getByTestId('mba-plafond-max').fill('500');
    await page.getByTestId('mba-plafond-fenetre').selectOption('seven_days');
    // L'ordre de grandeur en dollars : 500 réponses à 4 ou 5 cents.
    await expect(page.getByTestId('mba-plafond-estimation')).toContainText(/20/);
    await page.getByTestId('mba-plafond-enregistrer').click();
    await expect.poll(() => calls.filter((c) => c.url.includes('/mba-budget') && c.method === 'PUT').length).toBe(1);
    expect(calls.find((c) => c.url.includes('/mba-budget') && c.method === 'PUT')?.body)
      .toEqual({ plafond: { unite: 'ai_turn', fenetre: 'seven_days', max: 500 } });
    await expect(page.getByTestId('mba-plafond-actuel')).toContainText('500');
  });

  test('un plafond existant s’affiche, et « Retirer » part avec `plafond: null`', async ({ page }) => {
    const calls = await mockMba(page, { plafond: { unite: 'token', fenetre: 'thirty_days', max: 10_000_000 } });
    await page.goto('/mba/parametres?tab=activation');
    await expect(page.getByTestId('mba-plafond-actuel')).toContainText(/jetons|tokens/);
    await page.getByTestId('mba-plafond-retirer').click();
    await expect.poll(() => calls.filter((c) => c.url.includes('/mba-budget') && c.method === 'PUT').length).toBe(1);
    expect(calls.find((c) => c.url.includes('/mba-budget') && c.method === 'PUT')?.body).toEqual({ plafond: null });
    await expect(page.getByTestId('mba-plafond-actuel')).toContainText(/Aucun plafond|No cap/);
  });
});

test.describe('MBA : écran Activation', () => {
  test('les trois choix de passage de main sont proposés, avec le défaut usine sélectionné', async ({ page }) => {
    await mockMba(page);
    await page.goto('/mba/parametres?tab=activation');
    // Rien n'a jamais été réglé (mbaHandoffMode: null) -> l'écran montre le défaut usine, « il passe la main ».
    await expect(page.getByTestId('handoff-always').locator('input')).toBeChecked();
    await expect(page.getByTestId('handoff-business_hours').locator('input')).not.toBeChecked();
    await expect(page.getByTestId('handoff-never').locator('input')).not.toBeChecked();
  });

  test('choisir « heures d’ouverture » l’envoie au serveur et propose de régler les horaires', async ({ page }) => {
    const calls = await mockMba(page);
    await page.goto('/mba/parametres?tab=activation');
    await page.getByTestId('handoff-business_hours').locator('input').check();

    await expect.poll(() => calls.filter((c) => c.url.includes('/settings/mba-handoff')).length).toBeGreaterThan(0);
    const patch = calls.filter((c) => c.url.includes('/settings/mba-handoff')).at(-1);
    expect(patch?.method).toBe('PATCH');
    expect(patch?.body).toEqual({ mode: 'business_hours' });
    // Le lien n'apparaît qu'avec ce choix : sans horaires réglés, l'option ne veut rien dire.
    await expect(page.getByRole('link', { name: /Régler mes horaires|Set my opening hours/ })).toBeVisible();
  });

  test('un mode déjà enregistré est celui qui s’affiche à l’ouverture', async ({ page }) => {
    await mockMba(page, { reglagesTenant: { mbaHandoffMode: 'never' } });
    await page.goto('/mba/parametres?tab=activation');
    await expect(page.getByTestId('handoff-never').locator('input')).toBeChecked();
    await expect(page.getByTestId('handoff-always').locator('input')).not.toBeChecked();
  });

  test('le délai de reprise se saisit en MINUTES et part en secondes', async ({ page }) => {
    const calls = await mockMba(page, { reglagesTenant: { controlHandbackSeconds: 7200 } });
    await page.goto('/mba/parametres?tab=activation');
    const champ = page.getByTestId('handback-input');
    await expect(champ).toHaveValue('120'); // 7200 s lues, affichées en minutes

    await champ.fill('10');
    await champ.blur();
    await expect.poll(() => calls.filter((c) => c.url.includes('/settings/control-handback')).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.url.includes('/settings/control-handback')).at(-1)?.body).toEqual({ seconds: 600 });
  });

  test('🔴 le texte du délai parle de la DERNIÈRE réponse ou du dernier « Traité », qui ne rend pas la main', async ({ page }) => {
    // Chaque réponse humaine sur un fil tenu par l'équipe, et chaque « Traité », remettent `control_changed_at` à
    // maintenant (`PgInboxStore.recordOutbound`, `basculerRangement`) : le délai court depuis le plus récent des deux.
    // Ce test affirmait l'inverse (« première réponse ») et gardait donc un texte faux.
    await mockMba(page);
    await page.goto('/mba/parametres?tab=activation');
    const texte = page.getByText(/dernière réponse ou le dernier « Traité »|last reply or the last “Done”/);
    await expect(texte).toBeVisible();
    await expect(texte).toContainText(/ne rend pas la main, il relance le délai|does not hand the thread back, it restarts the delay/);
    await expect(page.getByText(/première réponse|first reply/)).toHaveCount(0);
  });
});
