import { test, expect } from '@playwright/test';

/**
 * Une adresse, plusieurs espaces : l'écran de choix.
 *
 * L'ancienne règle « un email = un compte » évitait la question « lequel ouvrir ? » en interdisant le cas.
 * La réponse est désormais de DEMANDER, et ces tests vérifient qu'on ne répond jamais à la place de
 * l'utilisateur, sans pour autant ajouter un écran à ceux qui n'ont qu'un seul espace.
 */
async function mock(page: import('@playwright/test').Page, reponseLogin: unknown, status = 200) {
  const appels: Array<{ chemin: string; body: unknown }> = [];
  await page.route('**/api/backend/**', async (route) => {
    const chemin = route.request().url().split('?')[0]!;
    const json = (b: unknown, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/auth/login')) {
      appels.push({ chemin, body: route.request().postDataJSON() });
      return json(reponseLogin, status);
    }
    if (chemin.endsWith('/auth/choose-workspace')) {
      appels.push({ chemin, body: route.request().postDataJSON() });
      return json({ token: 'jeton-espace', user: { email: 'a@b.co', role: 'agent', tenantId: 't-beta' } });
    }
    if (chemin.endsWith('/auth/config')) return json({ googleClientId: '', googleEnabled: false });
    return json({});
  });
  return appels;
}

async function seConnecter(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('a@b.co');
  await page.locator('input[type="password"]').fill('motdepasse');
  await page.getByRole('button', { name: /Se connecter|Sign in/ }).click();
}

test.describe('Connexion : plusieurs espaces', () => {
  const CHOIX = {
    choiceToken: 'jeton-de-choix',
    workspaces: [
      { tenantId: 't-alpha', tenantName: 'Espace Alpha', role: 'admin' },
      { tenantId: 't-beta', tenantName: 'Espace Beta', role: 'agent' },
    ],
  };

  test('🔴 plusieurs espaces -> on DEMANDE, on n’entre nulle part tout seul', async ({ page }) => {
    await mock(page, CHOIX);
    await seConnecter(page);
    const bloc = page.getByTestId('choix-espace');
    await expect(bloc).toBeVisible();
    await expect(bloc).toContainText('Espace Alpha');
    await expect(bloc).toContainText('Espace Beta');
    // On est TOUJOURS sur /login : aucune session n'a été ouverte à l'insu de l'utilisateur.
    expect(page.url()).toContain('/login');
  });

  test('choisir un espace y fait entrer', async ({ page }) => {
    const appels = await mock(page, CHOIX);
    await seConnecter(page);
    await page.getByTestId('espace-t-beta').click();
    await expect.poll(() => appels.filter((a) => a.chemin.endsWith('/auth/choose-workspace')).length, { timeout: 15_000 }).toBe(1);
    expect(appels.at(-1)?.body).toEqual({ choiceToken: 'jeton-de-choix', tenantId: 't-beta' });
    // Un agent atterrit sur l'inbox : la page d'arrivée suit le rôle DE CET espace.
    await page.waitForURL('**/inbox', { timeout: 15_000 });
  });

  test('🔴 UN seul espace : aucun écran de plus', async ({ page }) => {
    // Le cas de tout le monde aujourd'hui. Ajouter un clic pour un seul choix possible serait une régression
    // pour l'immense majorité des connexions.
    await mock(page, { token: 'jeton', user: { email: 'a@b.co', role: 'admin', tenantId: 't1' } });
    await seConnecter(page);
    await expect(page.getByTestId('choix-espace')).toHaveCount(0);
    await page.waitForURL('**/accueil', { timeout: 15_000 });
  });

  test('on peut repartir vers une autre adresse depuis le choix', async ({ page }) => {
    await mock(page, CHOIX);
    await seConnecter(page);
    await expect(page.getByTestId('choix-espace')).toBeVisible();
    await page.getByRole('button', { name: /Utiliser une autre adresse|Use another address/ }).click();
    await expect(page.getByTestId('choix-espace')).toHaveCount(0);
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});
