import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * Candidat 2 : couper la synchro HubSpot ouvre un dialogue Pause vs Déconnexion complète. La déconnexion coupe SANS
 * pause (libellé « coupée », pas « en pause »). Avertissement multi-numéros si le tenant a plusieurs numéros.
 */
const PORTAL = { connected: true, hubId: '139615673', hubDomain: 'cobaye.hubspot.com', listsScopeGranted: true };

test.describe('Accueil : déconnexion complète HubSpot (candidat 2)', () => {
  test('couper -> dialogue ; « Déconnexion complète » délie le portail (bascule vers « Connecter HubSpot », plus de toggle)', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: true, hubspotPausedAt: null, hubspotPortal: PORTAL } });
    await expect(page.getByTestId('hubspot-sync-state')).toContainText('activée');
    await page.getByTestId('hubspot-sync-toggle').click();
    await expect(page.getByTestId('hubspot-disconnect-dialog')).toBeVisible();
    await page.getByTestId('hubspot-disconnect-btn').click();
    // Portail délié (optimiste) -> le bloc synchro et son toggle disparaissent, le CTA « Connecter HubSpot » apparaît :
    // plus de toggle fantôme qui reposerait hubspot_connected=true sans portail lié.
    await expect(page.getByText('HubSpot non connecté')).toBeVisible();
    await expect(page.getByTestId('hubspot-sync-toggle')).toHaveCount(0);
  });

  test('Annuler ferme le dialogue sans rien couper', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: true, hubspotPausedAt: null, hubspotPortal: PORTAL } });
    await page.getByTestId('hubspot-sync-toggle').click();
    const dialog = page.getByTestId('hubspot-disconnect-dialog');
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('hubspot-sync-state')).toContainText('activée'); // toujours connecté
  });

  test('tenant à plusieurs numéros : avertissement « tous vos numéros » dans le dialogue', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: true, hubspotPausedAt: null, hubspotPortal: PORTAL }, numbersCount: 2 });
    await page.getByTestId('hubspot-sync-toggle').click();
    await expect(page.getByTestId('hubspot-disconnect-multi-warning')).toBeVisible();
  });

  test('tenant mono-numéro : pas d\'avertissement multi-numéros', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: true, hubspotPausedAt: null, hubspotPortal: PORTAL }, numbersCount: 1 });
    await page.getByTestId('hubspot-sync-toggle').click();
    await expect(page.getByTestId('hubspot-disconnect-dialog')).toBeVisible();
    await expect(page.getByTestId('hubspot-disconnect-multi-warning')).toHaveCount(0);
  });
});
