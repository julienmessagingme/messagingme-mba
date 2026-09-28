import { test, expect, type Page } from '@playwright/test';

/**
 * LA CONNEXION À LA CONSOLE D'EXPLOITATION (plan `docs/superpowers/plans/2026-09-28-ops-nominatif.md`).
 *
 * 🔴 CE QUE CES TESTS TIENNENT : plus de champ « jeton » ; on entre avec son compte (`ops: true`) PUIS son code ;
 * la session d'exploitation est gardée à part de la session d'espace, et aucune session d'espace ne naît d'une
 * connexion d'exploitation ; un 401 ramène au formulaire ; l'ancien jeton partagé est effacé du navigateur.
 * La décision (qui entre, le second facteur, la liste relue à chaque requête) est au serveur,
 * `tests/ops-nominatif.test.ts` : ici, les réponses de l'API sont recopiées à la main.
 */

type Appel = { chemin: string; methode: string; corps: Record<string, unknown> | null; autorisation?: string };
type Reponse = { status?: number; body: unknown };

const OVERVIEW = { tenants: [], daily: [], queues: [], worker: null };

async function monter(page: Page, repondeur: (chemin: string) => Reponse | undefined): Promise<Appel[]> {
  const appels: Appel[] = [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    appels.push({ chemin, methode: req.method(), corps: req.postData() ? (req.postDataJSON() as Record<string, unknown>) : null, autorisation: req.headers().authorization });
    const r = repondeur(chemin)
      ?? (chemin === '/auth/config' ? { body: { googleClientId: '', googleEnabled: false } } : { body: {} });
    return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return appels;
}

const stockage = (page: Page, cle: string): Promise<string | null> => page.evaluate((c) => window.localStorage.getItem(c), cle);

async function formulaire(page: Page, email = 'exploitant@e2e.test'): Promise<void> {
  await page.goto('/ops');
  await expect(page.getByTestId('ops-connexion')).toBeVisible();
  await page.locator('#ops-email').fill(email);
  await page.locator('#ops-password').fill('motdepasse-long');
  await page.getByRole('button', { name: /Se connecter|Sign in/ }).click();
}

test.describe('Ops : se connecter', () => {
  test('🔴 le compte, PUIS le code, puis la vue ; aucune session d’espace n’est ouverte', async ({ page }) => {
    const appels = await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { mfaToken: 'jeton-mfa-ops' } };
      if (chemin === '/auth/mfa/verifier') return { body: { sessionOps: 'session-ops-e2e', email: 'exploitant@e2e.test' } };
      if (chemin === '/ops/overview') return { body: OVERVIEW };
      return undefined;
    });
    await formulaire(page);
    // Le mot de passe est passé, mais rien n'est ouvert : l'étape du code.
    await expect(page.getByTestId('etape-code')).toBeVisible();
    expect(await stockage(page, 'mba.sessionOps')).toBeNull();
    expect(appels.find((a) => a.chemin === '/auth/login')?.corps).toEqual({ email: 'exploitant@e2e.test', password: 'motdepasse-long', ops: true });

    await page.getByTestId('code-connexion').fill('123456');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await expect(page.getByTestId('ops-exploitant')).toHaveText('exploitant@e2e.test');
    expect(JSON.parse((await stockage(page, 'mba.sessionOps')) ?? '{}')).toEqual({ token: 'session-ops-e2e', email: 'exploitant@e2e.test' });
    // La session d'exploitation n'est PAS une session de la console : elle n'y est jamais posée.
    expect(await stockage(page, 'mba.session')).toBeNull();
    // Et la vue se lit avec elle, en `Authorization`.
    expect(appels.find((a) => a.chemin === '/ops/overview')?.autorisation).toBe('Bearer session-ops-e2e');
  });

  test('🔴 une adresse hors de la liste : le refus du serveur s’affiche, et aucune étape ne s’ouvre', async ({ page }) => {
    await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { status: 403, body: { error: 'adresse non autorisée pour l’exploitation' } };
      return undefined;
    });
    await formulaire(page, 'admin@client.test');
    await expect(page.getByTestId('ops-connexion-erreur')).toHaveText(/adresse non autorisée pour l’exploitation/);
    await expect(page.getByTestId('second-facteur')).toHaveCount(0);
  });

  test('⚠️ une API d’avant le lot (qui ignore `ops`) : l’écran le dit, et ne garde rien', async ({ page }) => {
    // La console part au `git push`, l'API à son `up` : dans cette fenêtre, l'API rend une connexion d'ESPACE.
    await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { mfaToken: 'jeton-mfa-espace' } };
      if (chemin === '/auth/mfa/verifier') return { body: { token: 'jeton-espace', user: { email: 'exploitant@e2e.test', role: 'admin', tenantId: 't1' } } };
      return undefined;
    });
    await formulaire(page);
    await page.getByTestId('code-connexion').fill('123456');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await expect(page.getByTestId('ops-connexion-erreur')).toHaveText(/ne connaît pas encore la connexion d’exploitation|does not support the operations sign-in/);
    expect(await stockage(page, 'mba.sessionOps')).toBeNull();
    expect(await stockage(page, 'mba.session')).toBeNull();
  });

  test('🔴 une session refusée (401) ramène au formulaire, et le dit', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('mba.sessionOps', JSON.stringify({ token: 'session-perimee', email: 'exploitant@e2e.test' })));
    await monter(page, (chemin) => (chemin === '/ops/overview' ? { status: 401, body: { error: 'ops: non autorisé' } } : undefined));
    await page.goto('/ops');
    await expect(page.getByTestId('ops-connexion')).toBeVisible();
    await expect(page.getByTestId('ops-connexion-erreur')).toHaveText(/reconnectez-vous|sign in again/);
  });

  test('🔴 l’ancien jeton partagé est effacé du navigateur, et il n’ouvre rien', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('mba.ops', 'ancien-jeton-partage'));
    const appels = await monter(page, () => undefined);
    await page.goto('/ops');
    await expect(page.getByTestId('ops-connexion')).toBeVisible();
    await expect.poll(() => stockage(page, 'mba.ops')).toBeNull();
    // Aucun appel à `/ops` ne part avec lui : sans session d'exploitation, l'écran demande de se connecter.
    expect(appels.filter((a) => a.chemin.startsWith('/ops'))).toEqual([]);
  });
});

test.describe('Ops : le lien du menu du compte', () => {
  async function menu(page: Page, me: Record<string, unknown>): Promise<void> {
    await page.addInitScript(() => window.localStorage.setItem('mba.session', JSON.stringify({
      token: 'jeton', email: 'julien@e2e.test', role: 'admin', tenantId: 't-e2e',
    })));
    await monter(page, (chemin) => {
      if (chemin.endsWith('/conversations/todo-count')) return { body: { count: 0 } };
      if (chemin.endsWith('/conversations')) return { body: { conversations: [] } };
      if (chemin.endsWith('/me')) return { body: me };
      return undefined;
    });
    await page.goto('/inbox');
    // Le menu demande `/me` à sa première ouverture : on attend CETTE réponse, pour que l'absence du lien
    // ne se constate pas avant qu'il ait pu apparaître.
    const lu = page.waitForResponse((r) => r.url().endsWith('/t-e2e/me'));
    await page.getByTestId('menu-compte').click();
    await lu;
    await expect(page.getByTestId('menu-mon-compte')).toBeVisible();
  }

  test('une adresse de l’exploitation voit le lien vers /ops', async ({ page }) => {
    await menu(page, { email: 'julien@e2e.test', name: 'Julien', role: 'admin', exploitation: true });
    await expect(page.getByTestId('menu-exploitation')).toHaveAttribute('href', '/ops');
  });

  test('🔴 les autres ne le voient pas', async ({ page }) => {
    await menu(page, { email: 'julien@e2e.test', name: 'Julien', role: 'admin' });
    await expect(page.getByTestId('menu-exploitation')).toHaveCount(0);
  });
});
