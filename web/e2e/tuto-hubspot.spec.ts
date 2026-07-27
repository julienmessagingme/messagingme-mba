import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * F4 : tuto d'onboarding HubSpot. Page publique /tuto-hubspot (comment ajouter la carte à la vue contact) + lien
 * contextuel sur l'accueil, dans les deux états (portail connecté et CTA « Connecter HubSpot »).
 */
const PORTAL = { connected: true, hubId: '139615673', hubDomain: 'cobaye.hubspot.com', listsScopeGranted: true };

test.describe('F4 : tuto onboarding HubSpot', () => {
  test('la page /tuto-hubspot rend les étapes clés (publique, sans session)', async ({ page }) => {
    await page.goto('/tuto-hubspot');
    await expect(page.getByRole('heading', { name: /Configurer HubSpot/i })).toBeVisible();
    await expect(page.getByText('Ajouter la carte Messaging Me à la fiche contact')).toBeVisible();
    await expect(page.getByText(/Personnalisation de la fiche/i)).toBeVisible();
  });

  test('accueil (portail connecté) : lien tuto vers /tuto-hubspot', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: true, hubspotPausedAt: null, hubspotPortal: PORTAL } });
    const link = page.getByTestId('hubspot-tuto-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/tuto-hubspot');
  });

  test('accueil (non connecté) : lien tuto près du CTA « Connecter HubSpot »', async ({ page }) => {
    await mockAccueil(page, { account: { hubspotConnected: false, hubspotPausedAt: null, hubspotPortal: { connected: false } } });
    const link = page.getByTestId('hubspot-tuto-link-cta');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/tuto-hubspot');
  });
});
