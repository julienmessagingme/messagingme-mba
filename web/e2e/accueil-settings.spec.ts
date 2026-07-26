import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * F1 : la carte Meta Business Agent est remontée en tête, et la reprise après opérateur vit sous le toggle MBA.
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

  test('le champ de reprise après opérateur est DANS la carte MBA, sous le toggle', async ({ page }) => {
    await mockAccueil(page);
    // Colocalisation : le handback est un descendant de la carte MBA (settings-card), plus de la carte Numéro.
    await expect(page.locator('[data-testid="settings-card"] [data-testid="handback-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="numero-card"] [data-testid="handback-input"]')).toHaveCount(0);
  });

  test('le toggle MBA bascule (optimiste) au clic', async ({ page }) => {
    await mockAccueil(page);
    const toggle = page.getByTestId('mba-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});
