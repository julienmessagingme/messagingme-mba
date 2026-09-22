import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * « Activer le numéro » sur l'Accueil.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Depuis la v4 de l'inscription, un client peut terminer le parcours Meta avec
 * un numéro NON vérifié : Meta affiche « Your account is connected » et le numéro ne peut pas envoyer. Sans
 * cet écran, il n'a aucun recours dans la console (vécu le 2026-09-22 : passage par WhatsApp Manager).
 *
 * ⚠️ ET LE PLUS IMPORTANT EST UN TEST QUI VÉRIFIE UNE ABSENCE : le bloc ne s'affiche PAS quand on ignore le
 * statut du numéro. Annoncer une panne qu'on n'a pas constatée est pire que de se taire.
 */

const NON_VERIFIE = { numberStatus: 'PENDING', codeVerificationStatus: 'NOT_VERIFIED' };

test('numéro non vérifié : le bloc le dit, et l’activation demande un code', async ({ page }) => {
  await mockAccueil(page, { account: NON_VERIFIE });

  const bloc = page.getByTestId('activer-numero');
  await expect(bloc).toBeVisible();
  await expect(bloc).toContainText('pas encore activé');

  // Tant qu'aucun code n'est saisi, on ne peut pas activer : un register sans vérification serait refusé par
  // Meta et brûlerait un des dix essais permis sur 72 heures.
  await expect(page.getByTestId('activer-bouton')).toBeDisabled();

  await page.getByTestId('demander-code').click();
  await expect(bloc).toContainText('Meta appelle le numéro'); // VOICE par défaut, pas SMS

  await page.getByTestId('champ-code').fill('123456');
  await expect(page.getByTestId('activer-bouton')).toBeEnabled();
});

test('numéro déjà vérifié : aucun canal à choisir, on active tout de suite', async ({ page }) => {
  await mockAccueil(page, { account: { numberStatus: 'PENDING', codeVerificationStatus: 'VERIFIED' } });

  const bloc = page.getByTestId('activer-numero');
  await expect(bloc).toBeVisible();
  await expect(bloc).toContainText('Le numéro est vérifié');
  // Meta refuse un code sur un numéro déjà vérifié (136024) : ne pas offrir le geste est la seule façon de ne
  // pas le faire échouer.
  await expect(page.getByTestId('demander-code')).toHaveCount(0);
  await expect(page.getByTestId('activer-bouton')).toBeEnabled();
});

test('numéro CONNECTED : aucun bloc d’activation (la carte normale, inchangée)', async ({ page }) => {
  await mockAccueil(page);
  await expect(page.getByTestId('numero-card')).toBeVisible();
  await expect(page.getByTestId('activer-numero')).toHaveCount(0);
});

test('statut inconnu (null) : aucun bloc, on n’affirme pas une panne qu’on n’a pas constatée', async ({ page }) => {
  await mockAccueil(page, { account: { numberStatus: null, codeVerificationStatus: null } });
  await expect(page.getByTestId('numero-card')).toBeVisible();
  await expect(page.getByTestId('activer-numero')).toHaveCount(0);
});

test('refus de Meta : son message s’affiche, et rien ne relance tout seul', async ({ page }) => {
  await mockAccueil(page, { account: NON_VERIFIE, codeNumeroRefus: 'Meta a refusé l’envoi du code : Graph 400 (#133016)' });

  await page.getByTestId('demander-code').click();
  await expect(page.getByTestId('activer-erreur')).toContainText('133016');
  // Aucune relance automatique : une seconde après, l'erreur est toujours là et rien n'a été retenté.
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('activer-erreur')).toContainText('133016');
});
