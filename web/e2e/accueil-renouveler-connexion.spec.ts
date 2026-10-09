import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * « Renouveler la connexion Meta » sur la carte d'un espace QUI A DÉJÀ son numéro.
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Un espace relié avant la v4 de l'inscription porte un jeton à 60 jours, et la zone
 * « Connecter » ne s'affiche que sans numéro : sans ce bouton, il cessait d'envoyer à l'expiration, sans recours. Le
 * geste rejoue la même inscription (même fenêtre, même route) ; le serveur l'accepte sur le même numéro.
 *
 * La fenêtre de Meta est simulée par un faux SDK : `FB.login` rend un code, et aucun message n'annonce le compte (le cas
 * « code seul », que l'API repêche depuis le jeton).
 */
const FAUX_SDK = 'window.FB={init:function(){},login:function(cb){setTimeout(function(){cb({authResponse:{code:"code-e2e"}})},10)}};';
const RELIE = { connected: true, wabaId: 'w-e2e', phoneNumberId: 'pn-e2e', displayPhoneNumber: '+33 6 12 34 56 78' };

test('🔴 numéro relié, admin : le bouton rejoue l’inscription, et la carte reste celle du numéro', async ({ page }) => {
  await page.route('https://connect.facebook.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: FAUX_SDK }));
  const posts: unknown[] = [];
  await mockAccueil(page, { inscription: { complete: RELIE, posts } });

  const bouton = page.getByRole('button', { name: 'Renouveler la connexion Meta' });
  await expect(bouton).toBeVisible();
  await bouton.click();

  // L'écoute attend 6 s un message de la fenêtre avant d'envoyer le code seul.
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
  expect(posts).toEqual([{ code: 'code-e2e' }]);
  await expect(page.getByRole('button', { name: 'Renouveler la connexion Meta' })).toBeEnabled();
  await expect(page.getByTestId('numero-card')).toBeVisible();
  await expect(page.getByTestId('renouveler-erreur')).toHaveCount(0);
});

test('un refus du serveur s’affiche sous le bouton, avec sa raison', async ({ page }) => {
  await page.route('https://connect.facebook.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: FAUX_SDK }));
  await mockAccueil(page, { inscription: { complete: RELIE } });
  // Enregistrée APRÈS le faux serveur, cette route passe devant lui : l'inscription refuse un autre numéro.
  await page.route('**/embedded-signup/complete', (route) => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'Cet espace utilise déjà le numéro pn-e2e. Un espace ne peut piloter qu’un seul numéro WhatsApp.' }),
  }));

  await page.getByRole('button', { name: 'Renouveler la connexion Meta' }).click();
  await expect(page.getByTestId('renouveler-erreur')).toContainText('un seul numéro', { timeout: 15_000 });
});

test('sans inscription Meta configurée sur l’instance : aucun bouton', async ({ page }) => {
  await mockAccueil(page);
  await expect(page.getByTestId('numero-card')).toBeVisible();
  await expect(page.getByTestId('renouveler-connexion')).toHaveCount(0);
});
