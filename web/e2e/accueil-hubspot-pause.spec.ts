import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * F3-a : la synchro HubSpot par numéro distingue PAUSE (paused_at renseigné) de COUPÉ (jamais activé), et une
 * REPRISE après pause affiche l'avis de rattrapage. Le bloc synchro n'apparaît que si un portail est relié.
 */
const PORTAL = { connected: true, hubId: '139615673', hubDomain: 'cobaye.hubspot.com', listsScopeGranted: true };

test.describe('Accueil : pause / reprise de la synchro HubSpot (F3-a)', () => {
  test('numéro connecté : couper ouvre le dialogue ; « Mettre en pause » affiche « en pause »', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: true, hubspotPausedAt: null, hubspotPortal: PORTAL } });
    const state = page.getByTestId('hubspot-sync-state');
    await expect(state).toContainText('activée');
    await page.getByTestId('hubspot-sync-toggle').click(); // couper -> dialogue Pause/Déconnexion (candidat 2)
    await expect(page.getByTestId('hubspot-disconnect-dialog')).toBeVisible();
    await page.getByTestId('hubspot-pause-btn').click();
    await expect(state).toContainText('en pause'); // pas « coupée » : c'est une pause volontaire
  });

  test('fixture en pause (connected=false + pausedAt) : libellé « en pause », distinct de « coupée »', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: false, hubspotPausedAt: '2026-07-20T10:00:00Z', hubspotPortal: PORTAL } });
    const state = page.getByTestId('hubspot-sync-state');
    await expect(state).toContainText('en pause');
    await expect(state).not.toContainText('coupée');
  });

  test('fixture jamais activé (connected=false + pausedAt null) : libellé « coupée », pas « en pause »', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: false, hubspotPausedAt: null, hubspotPortal: PORTAL } });
    const state = page.getByTestId('hubspot-sync-state');
    await expect(state).toContainText('coupée');
    await expect(state).not.toContainText('en pause');
  });

  test('reprise après pause -> avis de rattrapage affiché (catchupTriggered)', async ({ page }) => {
    await mockAccueil(page, {
      account: { hubspotConnected: false, hubspotPausedAt: '2026-07-20T10:00:00Z', hubspotPortal: PORTAL },
      catchupTriggered: true,
    });
    await expect(page.getByTestId('hubspot-catchup-notice')).toHaveCount(0); // rien avant la reprise
    await page.getByTestId('hubspot-sync-toggle').click(); // reprise
    await expect(page.getByTestId('hubspot-catchup-notice')).toBeVisible();
    await expect(page.getByTestId('hubspot-sync-state')).toContainText('activée');
  });

  test('reprise SANS rattrapage (catchupTriggered=false) -> aucun avis', async ({ page }) => {
    await mockAccueil(page, {
      account: { hubspotConnected: false, hubspotPausedAt: null, hubspotPortal: PORTAL },
      catchupTriggered: false,
    });
    await page.getByTestId('hubspot-sync-toggle').click();
    await expect(page.getByTestId('hubspot-catchup-notice')).toHaveCount(0);
  });
});
