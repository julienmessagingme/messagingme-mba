import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * F1 : la carte Meta Business Agent est remontée en tête. La reprise après opérateur, elle, a quitté cet
 * écran pour MBA > Paramètres > Activation, où elle vit avec le passage de main.
 */
test.describe('Accueil : carte MBA + reprise opérateur (F1)', () => {
  test('la carte MBA est AVANT la carte Numéro dans le DOM', async ({ page }) => {
    await mockAccueil(page);
    await expect(page.getByTestId('settings-card')).toBeVisible();
    await expect(page.getByTestId('numero-card')).toBeVisible();
    const order = await page.$$eval('[data-testid]', (els) =>
      els
        .map((e) => e.getAttribute('data-testid'))
        .filter((id): id is string => id === 'settings-card' || id === 'numero-card'),
    );
    expect(order).toEqual(['settings-card', 'numero-card']);
  });

  test('la reprise après opérateur ne se règle plus ICI : l’accueil renvoie vers l’écran Activation', async ({ page }) => {
    await mockAccueil(page);
    await expect(page.getByTestId('handback-input')).toHaveCount(0);
    const lien = page.locator('[data-testid="settings-card"] [data-testid="lien-activation"]');
    await expect(lien).toBeVisible();
    await expect(lien).toHaveAttribute('href', '/mba/parametres?tab=activation');
  });

  test('le toggle MBA bascule (optimiste) au clic', async ({ page }) => {
    await mockAccueil(page);
    const toggle = page.getByTestId('mba-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});
