import { test, expect, type Page } from './aide/test';

/**
 * L'INSCRIPTION VENUE DU CHOIX DU PRO (`/signup?offre=pro`, la fin Pro du guide du numéro de la vitrine, 2026-10-27).
 *
 * 🔴 CE QUE CES TESTS TIENNENT : un espace que Google vient de créer va à la souscription du Pro, jamais au tunnel de la
 * Free ; un compte Google qui existait déjà arrive comme d'habitude ; une demande d'autorisation de Claude (`?demande=`)
 * passe avant le Pro. Le chemin par mot de passe, et celui qui passe par le second facteur, sont dans
 * `e2e/second-facteur.spec.ts`. Les réponses de l'API sont celles de `src/auth/routes.ts`, recopiées à la main.
 */

type Reponse = { status?: number; body: unknown };
type Appel = { chemin: string; methode: string };

const SESSION_ADMIN = { token: 'jeton-session', user: { email: 'a@b.co', role: 'admin', tenantId: 't1' } };

async function monter(page: Page, repondeur: (chemin: string) => Reponse | undefined): Promise<Appel[]> {
  const appels: Appel[] = [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    appels.push({ chemin, methode: req.method() });
    const r = repondeur(chemin)
      ?? (chemin === '/auth/config' ? { body: { googleClientId: 'client-e2e', googleEnabled: true } } : { body: {} });
    return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  // Google Identity Services, simulé comme dans `e2e/autoriser.spec.ts` : un bouton qui rend un jeton d'identité.
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.google = { accounts: { id: {
      initialize: function (cfg) { window.__rappelGoogle = cfg.callback; },
      renderButton: function (el) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Google (simulé)';
        b.setAttribute('data-testid', 'google-simule');
        b.onclick = function () { window.__rappelGoogle({ credential: 'jeton-google-e2e' }); };
        el.appendChild(b);
      },
    } } };`,
  }));
  return appels;
}

test.describe('Inscription venue du choix du Pro', () => {
  test('🔴 par Google, un espace neuf va à la souscription du Pro, jamais au tunnel de la Free', async ({ page }) => {
    const appels = await monter(page, (chemin) => (chemin === '/auth/google' ? { status: 201, body: { ...SESSION_ADMIN, isNew: true } } : undefined));
    await page.goto('/signup?offre=pro');
    await page.getByTestId('google-simule').click();
    await page.waitForURL('**/offre?fonction=console', { timeout: 15_000 });
    expect(appels.filter((a) => a.chemin === '/auth/google')).toHaveLength(1);
  });

  test('par Google, un compte qui existait déjà arrive comme d’habitude', async ({ page }) => {
    await monter(page, (chemin) => (chemin === '/auth/google' ? { body: { ...SESSION_ADMIN, isNew: false } } : undefined));
    await page.goto('/signup?offre=pro');
    await page.getByTestId('google-simule').click();
    await page.waitForURL('**/accueil', { timeout: 15_000 });
  });

  test('🔴 une demande d’autorisation de Claude passe avant le Pro', async ({ page }) => {
    await monter(page, (chemin) => (chemin === '/auth/signup' ? { status: 201, body: SESSION_ADMIN } : undefined));
    await page.goto('/signup?demande=d-e2e&offre=pro');
    await page.getByPlaceholder(/Mon entreprise|My company/).fill('Mon espace');
    await page.locator('input[type="email"]').fill('a@b.co');
    await page.locator('input[type="password"]').fill('motdepasse-long');
    await page.getByRole('button', { name: /Créer mon espace|Create my workspace/ }).click();
    await page.waitForURL('**/autoriser?demande=d-e2e', { timeout: 15_000 });
  });
});
