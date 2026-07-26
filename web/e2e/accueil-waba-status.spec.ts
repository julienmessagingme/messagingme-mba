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
