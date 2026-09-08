import { test, expect } from '@playwright/test';
import { mockAccueil, defaultAccount } from './support/accueil';

/**
 * F2 : panneau statut WABA. Cap d'envoi 24 h (pas le débit/s), MM Lite, revue, vérif, business, bloc paiement
 * honnête vers le Business Manager. Repli honnête quand Meta n'a pas évalué le palier.
 */
test.describe('Accueil : panneau statut WhatsApp Business (F2)', () => {
  test('affiche le cap d\'envoi 24 h et PAS le débit par seconde', async ({ page }) => {
    await mockAccueil(page);
    const numero = page.getByTestId('numero-card');
    await expect(numero.getByText("Cap d'envoi 24 h")).toBeVisible();
    await expect(numero.getByText('1 000 clients / 24 h')).toBeVisible();
    // Le débit brut (identique pour tous) a été retiré.
    await expect(page.getByText('messages / seconde')).toHaveCount(0);
    await expect(page.getByText('Débit', { exact: true })).toHaveCount(0);
  });

  test('le panneau montre MM Lite approuvé + revue + vérification', async ({ page }) => {
    await mockAccueil(page);
    const panel = page.getByTestId('waba-status-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('API MM Lite')).toBeVisible();
    await expect(panel.getByText('Approuvé', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText('Revue du compte')).toBeVisible();
    await expect(panel.getByText("Vérification d'entreprise")).toBeVisible();
  });

  test('bloc paiement : renvoi honnête vers le Business Manager (lien billing_hub)', async ({ page }) => {
    await mockAccueil(page);
    const link = page.getByTestId('waba-status-panel').getByRole('link', { name: 'Business Manager Meta' });
    await expect(link).toHaveAttribute('href', /business\.facebook\.com\/billing_hub/);
  });

  test('🔴 la pastille du numéro s’affiche quand Meta en rend une', async ({ page }) => {
    // Demande de Julien du 2026-09-08 : montrer sur l'Accueil la pastille que Meta affiche dans le Business
    // Manager, à côté du numéro.
    await mockAccueil(page, { account: { ...defaultAccount, photoProfilUrl: 'https://exemple.test/pastille.png' } });
    const pastille = page.getByTestId('numero-pastille');
    await expect(pastille).toBeVisible();
    await expect(pastille).toHaveAttribute('src', 'https://exemple.test/pastille.png');
  });

  test('🔴 sans photo, AUCUN cadre vide : le numéro s’affiche seul', async ({ page }) => {
    // C'est le cas ORDINAIRE : les deux numéros du parc n'avaient pas de photo le 2026-09-08. Un cadre gris
    // ou une icône de repli se lirait comme un chargement en échec, et on chercherait une panne inexistante.
    await mockAccueil(page, { account: { ...defaultAccount, photoProfilUrl: null } });
    await expect(page.getByTestId('numero-card')).toBeVisible();
    await expect(page.getByTestId('numero-pastille')).toHaveCount(0);
  });

  test('palier non évalué -> repli honnête (pas de faux chiffre)', async ({ page }) => {
    await mockAccueil(page, { account: { ...defaultAccount, tier: null } });
    await expect(page.getByTestId('numero-card').getByText('Pas encore évalué par Meta')).toBeVisible();
  });

  test('aucun tiret cadratin dans le panneau statut', async ({ page }) => {
    await mockAccueil(page);
    const text = (await page.getByTestId('waba-status-panel').innerText()) ?? '';
    expect(text).not.toMatch(/[—–]/);
  });
});
