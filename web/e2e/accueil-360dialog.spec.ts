import { test, expect } from './aide/test';
import { mockAccueil } from './support/accueil';

/**
 * LE BOUTON « ONBOARD WITH 360DIALOG » (lot 3) ET UN ESPACE RELIÉ PAR 360DIALOG (livraison D), sur l'Accueil.
 *
 * Sans numéro, le bouton est à côté de « Connecter mon compte WhatsApp » ; la clé collée part vers la route, et l'Accueil
 * relit le compte : la zone de connexion disparaît (les deux boutons à la fois), la carte du numéro arrive. Relié par
 * 360dialog, l'Accueil masque ce qui ne parle qu'à Meta : la carte de l'agent de Meta, « Renouveler la connexion Meta »,
 * la qualité ; il propose de recoller la clé.
 */
const SANS_NUMERO = { hasNumber: false, phoneNumberId: null, number: null, numberStatus: null, codeVerificationStatus: null, status: { dot: 'grey', label: 'Aucun numéro', reason: 'Aucun numéro connecté.' } };
const RELIE_360 = {
  hasNumber: true, phoneNumberId: 'PN360', number: null, numberStatus: null, codeVerificationStatus: null, quality: 'UNKNOWN',
  fournisseur: '360dialog', status: { dot: 'grey', label: 'Compte connecté', reason: 'Numéro relié par 360dialog : sa qualité ne se lit pas depuis la console.' },
};

test('sans numéro : la clé collée relie le numéro, et les deux boutons de connexion disparaissent ensemble', async ({ page }) => {
  const posts: unknown[] = [];
  await mockAccueil(page, { account: SANS_NUMERO, inscription: { complete: {} }, connexion360: { posts, compteApres: RELIE_360 } });

  await expect(page.getByRole('button', { name: 'Connecter mon compte WhatsApp' })).toBeVisible();
  await page.getByTestId('connecter-360dialog').click();
  await page.getByTestId('cle-360dialog').fill('cle-du-numero-360dialog');
  await page.getByTestId('numero-360dialog').fill('+33 4 23 50 07 16');
  await page.getByTestId('valider-360dialog').click();

  await expect(page.getByTestId('numero-card')).toBeVisible();
  expect(posts).toEqual([{ cle: 'cle-du-numero-360dialog', numeroAffiche: '+33 4 23 50 07 16' }]);
  await expect(page.getByRole('button', { name: 'Connecter mon compte WhatsApp' })).toHaveCount(0);
  await expect(page.getByTestId('connecter-360dialog')).toHaveCount(0);
});

test('une clé refusée : le message reste dans la fenêtre, rien n’est relié', async ({ page }) => {
  const posts: unknown[] = [];
  await mockAccueil(page, { account: SANS_NUMERO, connexion360: { posts, refus: 'clé refusée par 360dialog' } });
  await page.getByTestId('connecter-360dialog').click();
  await page.getByTestId('cle-360dialog').fill('cle-fausse-0000000');
  await page.getByTestId('valider-360dialog').click();
  await expect(page.getByTestId('erreur-360dialog')).toContainText('clé refusée par 360dialog');
  await expect(page.getByTestId('modale-360dialog')).toBeVisible();
});

test('relié par 360dialog : ni agent de Meta ni « Renouveler », mais « Recoller la clé 360dialog »', async ({ page }) => {
  const posts: unknown[] = [];
  await mockAccueil(page, { account: RELIE_360, inscription: { complete: {} }, connexion360: { posts, compteApres: RELIE_360 } });
  await expect(page.getByTestId('numero-card')).toBeVisible();
  await expect(page.getByTestId('numero-card')).toContainText('Numéro relié par 360dialog');
  await expect(page.getByTestId('settings-card')).toHaveCount(0);
  await expect(page.getByTestId('renouveler-connexion')).toHaveCount(0);
  await expect(page.getByTestId('waba-status-panel')).toHaveCount(0);
  await expect(page.getByTestId('recoller-cle-360dialog')).toBeVisible();

  // Recoller : seule la clé part (le numéro est déjà relié), et la fenêtre se ferme.
  await page.getByTestId('recoller-cle-360dialog').click();
  await expect(page.getByTestId('numero-360dialog')).toHaveCount(0);
  await page.getByTestId('cle-360dialog').fill('nouvelle-cle-360dialog');
  await page.getByTestId('valider-360dialog').click();
  await expect(page.getByTestId('modale-360dialog')).toHaveCount(0);
  expect(posts).toEqual([{ cle: 'nouvelle-cle-360dialog' }]);
});
