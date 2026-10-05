import { test, expect } from '@playwright/test';
import { mockAccueil } from './support/accueil';

/**
 * 🔴 UN COMPTE WHATSAPP REVENU SANS NUMÉRO NE LAISSE PAS UN ÉCRAN MUET (relecture de la livraison A du lot 3b).
 *
 * La fenêtre de Meta peut se finir SANS numéro. L'API relie alors le compte et rend 200 avec un avertissement qui
 * dit quoi faire, au lieu de l'ancien 422. Or l'Accueil ne montrait ses avertissements que dans la carte d'un espace
 * QUI A un numéro : l'espace n'en ayant toujours pas, la zone de connexion revenait, sans un mot.
 *
 * La fenêtre de Meta est simulée par un faux SDK : `FB.login` rend un code, et aucun message n'annonce le compte
 * (le cas « code seul », que l'API repêche).
 */
const FAUX_SDK = 'window.FB={init:function(){},login:function(cb){setTimeout(function(){cb({authResponse:{code:"code-e2e"}})},10)}};';

test('🔴 compte relié SANS numéro : l’avertissement s’affiche, et la zone de connexion reste', async ({ page }) => {
  await page.route('https://connect.facebook.net/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: FAUX_SDK }));
  const posts: unknown[] = [];
  await mockAccueil(page, {
    account: { hasNumber: false, phoneNumberId: null, number: null, numberStatus: null, codeVerificationStatus: null, status: { dot: 'grey', label: 'Aucun numéro', reason: 'Aucun numéro connecté.' } },
    inscription: {
      complete: { connected: false, sansNumero: true, wabaId: 'w-e2e', warnings: ['Ton compte WhatsApp est relié, sans numéro pour l’instant.'] },
      posts,
    },
  });

  const bouton = page.getByRole('button', { name: 'Connecter mon compte WhatsApp' });
  await bouton.click();

  // L'écoute attend 6 s un message de la fenêtre avant d'envoyer le code seul.
  await expect(page.getByTestId('avertissements-connexion')).toContainText('sans numéro', { timeout: 15_000 });
  expect(posts).toEqual([{ code: 'code-e2e' }]);
  await expect(page.getByRole('button', { name: 'Connecter mon compte WhatsApp' })).toBeVisible();
  // Pas « Connecté » : l'espace n'a pas de numéro.
  await expect(page.getByTestId('avertissements-connexion')).not.toContainText('Connecté');
});
