import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * HubSpot est un BLOC À PART sur l'accueil depuis le 2026-08-23.
 *
 * Il vivait imbriqué dans la carte du numéro WhatsApp, où il passait inaperçu alors qu'il gouverne une
 * intégration entière. Demande de Julien.
 */
test.describe('Accueil : HubSpot est un bloc séparé', () => {
  test('🔴 la carte HubSpot existe, et n’est PAS imbriquée dans celle du numéro', async ({ page }) => {
    await mockAccueil(page, { account: { hasNumber: true } });
    await expect(page.getByTestId('hubspot-card')).toBeVisible();
    // La vraie garantie : ce n'est pas un descendant de la carte du numéro. Se contenter de « la carte
    // existe » laisserait passer un bloc resté imbriqué mais portant le testid.
    const imbrique = await page.evaluate(() => {
      const hs = document.querySelector('[data-testid="hubspot-card"]');
      const numero = document.querySelector('[data-testid="numero-card"]');
      return Boolean(hs && numero && numero.contains(hs));
    });
    expect(imbrique, 'la carte HubSpot est encore imbriquée dans celle du numéro').toBe(false);
  });

  test('sans numéro rattaché, la carte HubSpot ne s’affiche pas', async ({ page }) => {
    // Sans numéro il n'y a rien à synchroniser : afficher le bloc donnerait une action sans effet.
    await mockAccueil(page, { account: { hasNumber: false } });
    await expect(page.getByTestId('hubspot-card')).toHaveCount(0);
  });
});
