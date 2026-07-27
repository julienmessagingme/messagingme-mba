import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * F6 : toggle « Relancer automatiquement les échecs » sur l'accueil (dans la carte Meta Business Agent). Optimiste,
 * admin only. L'effet réel (sweeper) est différé/invisible ; le libellé explique la politique.
 */
test.describe('Accueil : toggle auto-relance des échecs (F6)', () => {
  test('le toggle est rendu et bascule (optimiste)', async ({ page }) => {
    await mockAccueil(page, { account: { hasNumber: true } });
    const toggle = page.getByTestId('auto-retry-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('part activé si le réglage le dit', async ({ page }) => {
    await mockAccueil(page, {
      account: { hasNumber: true },
      settings: { controlHandbackSeconds: null, mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: true },
    });
    await expect(page.getByTestId('auto-retry-toggle')).toHaveAttribute('aria-pressed', 'true');
  });
});
