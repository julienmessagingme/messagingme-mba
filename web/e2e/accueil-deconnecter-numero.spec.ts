import { test, expect, type Page } from '@playwright/test';
import { mockAccueil, defaultAccount } from './support/accueil';

/**
 * « Déconnecter le numéro » sur la carte d'un espace QUI A son numéro, à côté de « Renouveler la connexion Meta ».
 *
 * 🔴 CE QUE CES TESTS PROTÈGENT. Le geste est irréversible (le numéro oublié, les conversations effacées) : il ne part
 * qu'après un bilan lu sur le serveur et le numéro retapé, avec `{ confirme: true }`. Après lui, la carte n'est plus
 * celle du numéro mais la zone « Connecter », puisque l'espace peut en connecter un autre.
 */
const BILAN = {
  phoneNumberId: 'PN1', affiche: '+33 5 25 68 02 50', wabaId: 'W1', partage: false, jeton: 'propre', numeroFourni: null,
  conversations: 12, campagnesArretees: 2, mbaAllume: true, contactsSurLaListe: 3,
};
const SANS_NUMERO = {
  ...defaultAccount, hasNumber: false, phoneNumberId: null, number: null, numberStatus: null, codeVerificationStatus: null,
  status: { dot: 'grey', label: 'Aucun numéro', reason: 'Aucun numéro connecté.' },
};

async function monter(page: Page, o: { bilan?: Record<string, unknown>; refus?: string; inscription?: boolean; etapes?: unknown[] } = {}) {
  const posts: unknown[] = [];
  let deconnecte = false;
  await mockAccueil(page, o.inscription === false ? {} : { inscription: { complete: {} } });
  // Enregistrées APRÈS le faux serveur, ces routes passent devant lui.
  await page.route('**/account-status', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(deconnecte ? SANS_NUMERO : defaultAccount),
  }));
  await page.route('**/numero/deconnexion', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ...BILAN, ...o.bilan }),
  }));
  await page.route('**/numero/deconnecter', (route) => {
    posts.push(route.request().postDataJSON());
    if (o.refus) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: o.refus, cause: 'purge' }) });
    deconnecte = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deconnecte: true, conversations: 12, campagnesArretees: 2, etapes: o.etapes ?? [] }) });
  });
  return { posts };
}

test('🔴 le geste complet : bilan, numéro retapé, puis la zone « Connecter » remplace la carte du numéro', async ({ page }) => {
  const { posts } = await monter(page);
  // Côte à côte avec « Renouveler la connexion Meta ».
  await expect(page.getByRole('button', { name: 'Renouveler la connexion Meta' })).toBeVisible();
  await page.getByRole('button', { name: 'Déconnecter le numéro' }).click();

  const fenetre = page.getByTestId('deconnexion-confirmation');
  await expect(fenetre).toBeVisible();
  await expect(page.getByTestId('deconnexion-bilan')).toContainText('12 conversation(s) effacée(s) définitivement');
  await expect(page.getByTestId('deconnexion-bilan')).toContainText('2 campagne(s) WhatsApp');
  await expect(page.getByTestId('deconnexion-bilan')).toContainText('Messaging Me se retire de votre compte WhatsApp');
  await expect(page.getByTestId('deconnexion-numero-fourni')).toHaveCount(0);

  // 🔴 Tant que le numéro n'est pas retapé, rien ne part.
  const ok = page.getByTestId('deconnexion-ok');
  await expect(ok).toBeDisabled();
  await page.getByTestId('deconnexion-saisie').fill('+33 5 25 68 02 51');
  await expect(ok).toBeDisabled();
  await page.getByTestId('deconnexion-saisie').fill('+33525680250');
  await expect(ok).toBeEnabled();
  await ok.click();

  await expect(fenetre).toHaveCount(0);
  expect(posts).toEqual([{ confirme: true }]);
  await expect(page.getByTestId('numero-deconnecte')).toContainText('12 conversation(s) effacée(s), 2 campagne(s) arrêtée(s)');
  await expect(page.getByTestId('numero-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Déconnecter le numéro' })).toHaveCount(0);
  // Tout s'est bien passé chez Meta : aucun avertissement.
  await expect(page.getByTestId('numero-deconnecte-meta')).toHaveCount(0);
});

test('🔴 une étape chez Meta en échec se DIT après coup : le numéro a quitté la console, plus rien d’autre ne la montrerait', async ({ page }) => {
  await monter(page, { etapes: [
    { etape: 'conversations', etat: 'fait', detail: '12 effacée(s)' },
    { etape: 'mba_eteint', etat: 'echec', detail: '(#100) refus' },
    { etape: 'detachement', etat: 'fait', detail: null },
  ] });
  await page.getByRole('button', { name: 'Déconnecter le numéro' }).click();
  await page.getByTestId('deconnexion-saisie').fill('+33525680250');
  await page.getByTestId('deconnexion-ok').click();
  await expect(page.getByTestId('numero-deconnecte')).toBeVisible();
  await expect(page.getByTestId('numero-deconnecte-meta')).toContainText('l’agent de Meta peut encore répondre');
});

test('un refus du serveur s’affiche dans la fenêtre, qui reste ouverte, et la carte du numéro reste', async ({ page }) => {
  await monter(page, { refus: 'L’effacement des conversations a échoué : le numéro est toujours connecté. Recommencez dans un instant.' });
  await page.getByRole('button', { name: 'Déconnecter le numéro' }).click();
  await page.getByTestId('deconnexion-saisie').fill('+33 5 25 68 02 50');
  await page.getByTestId('deconnexion-ok').click();
  await expect(page.getByTestId('deconnexion-erreur')).toContainText('toujours connecté');
  await expect(page.getByTestId('deconnexion-confirmation')).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByTestId('numero-card')).toBeVisible();
});

test('🔴 un numéro fourni est annoncé perdu, et un objet partagé ne touche rien chez Meta', async ({ page }) => {
  await monter(page, { bilan: { numeroFourni: { numero: '33525680250', vuDeMeta: true }, partage: true } });
  await page.getByRole('button', { name: 'Déconnecter le numéro' }).click();
  await expect(page.getByTestId('deconnexion-numero-fourni')).toContainText('il est perdu');
  await expect(page.getByTestId('deconnexion-bilan')).toContainText('rien n’est changé chez Meta');
});

test('sans inscription Meta configurée : pas de « Renouveler », mais « Déconnecter » reste', async ({ page }) => {
  await monter(page, { inscription: false });
  await expect(page.getByTestId('numero-card')).toBeVisible();
  await expect(page.getByTestId('renouveler-connexion')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Déconnecter le numéro' })).toBeVisible();
});
