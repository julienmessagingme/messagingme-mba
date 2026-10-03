import { test, expect, type Page } from '@playwright/test';

/**
 * LE CONSENTEMENT DE CLAUDE (`/autoriser`, spec `docs/superpowers/specs/2026-10-03-oauth-mcp-design.md`, section 3).
 *
 * 🔴 CE QUE CES TESTS TIENNENT : le client, l'hôte de retour, les droits et la phrase sur Anthropic s'affichent AVANT
 * tout bouton ; aucun appel d'autorisation ne part avant un clic ; le bouton direct n'existe que pour une session
 * admin ; après Google, un bouton par espace où la personne est admin ; au clic, la page part vers l'adresse rendue,
 * et seulement si elle vise l'hôte montré ; aucun 401 ne vide la session de la console. Les décisions (rôle relu,
 * preuve liée à la demande) sont au serveur, `tests/http-oauth.test.ts` : ici, ses réponses sont recopiées à la main.
 */

type Appel = { chemin: string; methode: string; corps: Record<string, unknown> | null; autorisation?: string };
type Reponse = { status?: number; body: unknown };

const DEMANDE = { client: 'Claude Code', hoteDeRetour: 'localhost', droits: ['mcp:read', 'mcp:write'] };
const RETOUR = 'http://localhost:5555/callback?code=mbc_e2e&state=etat-e2e&iss=https%3A%2F%2Fapi.e2e.test';
const SESSION_ADMIN = { token: 'jeton-console', email: 'admin@e2e.test', role: 'admin', tenantId: 't1' };

async function monter(page: Page, repondeur: (chemin: string, methode: string) => Reponse | undefined): Promise<Appel[]> {
  const appels: Appel[] = [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    appels.push({ chemin, methode: req.method(), corps: req.postData() ? (req.postDataJSON() as Record<string, unknown>) : null, autorisation: req.headers().authorization });
    const r = repondeur(chemin, req.method())
      ?? (chemin === '/auth/config' ? { body: { googleClientId: 'client-e2e', googleEnabled: true } } : { body: {} });
    return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  // Google Identity Services, simulé : un bouton qui rend un jeton d'identité au composant de la console.
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
  // L'adresse de retour de Claude Code, simulée : la page y navigue au clic.
  await page.route('http://localhost:5555/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>callback</p>' }));
  return appels;
}

async function avecSession(page: Page, session: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
}
const stockage = (page: Page, cle: string): Promise<string | null> => page.evaluate((c) => window.localStorage.getItem(c), cle);
const autorisations = (appels: Appel[]): Appel[] => appels.filter((a) => a.chemin.endsWith('/autoriser'));

test.describe('Autoriser Claude : ce que la page montre', () => {
  test('🔴 sans demande dans l’adresse : la page le dit, et rien n’est appelé', async ({ page }) => {
    const appels = await monter(page, () => undefined);
    await page.goto('/autoriser');
    await expect(page.getByTestId('autoriser-absente')).toContainText(/Relancez la connexion depuis Claude/);
    expect(appels).toEqual([]);
  });

  test('🔴 demande expirée : « relancez la connexion depuis Claude », et aucun bouton', async ({ page }) => {
    await monter(page, (chemin) => (chemin === '/oauth/consentement/demande'
      ? { status: 400, body: { error: 'demande expirée ou invalide : relancez la connexion depuis Claude', code: 'demande_expiree' } }
      : undefined));
    await page.goto('/autoriser?demande=d-perimee');
    await expect(page.getByTestId('autoriser-expiree')).toContainText(/relancez la connexion depuis Claude/);
    await expect(page.getByRole('button', { name: /Autoriser/ })).toHaveCount(0);
  });
});

test.describe('Autoriser Claude : avec la session de la console', () => {
  test('🔴 tout est affiché avant le bouton, rien ne part avant le clic, puis la page part vers Claude', async ({ page }) => {
    await avecSession(page, SESSION_ADMIN);
    const appels = await monter(page, (chemin) => {
      if (chemin === '/oauth/consentement/demande') return { body: DEMANDE };
      if (chemin === '/tenants/t1/nom') return { body: { nom: 'Mon espace' } };
      if (chemin === '/tenants/t1/oauth/autoriser') return { body: { adresse: RETOUR } };
      return undefined;
    });
    await page.goto('/autoriser?demande=d-e2e');

    await expect(page.getByRole('heading', { name: 'Claude Code demande l’accès à votre espace' })).toBeVisible();
    await expect(page.getByTestId('autoriser-hote')).toHaveText('localhost');
    await expect(page.getByTestId('autoriser-droits')).toContainText('Claude Code pourra lire vos conversations');
    await expect(page.getByTestId('autoriser-droits')).toContainText('répondre dans une conversation ouverte');
    await expect(page.getByTestId('autoriser-droits')).toContainText('traitées par Anthropic');
    await expect(page.getByRole('link', { name: 'Notre politique de confidentialité' }))
      .toHaveAttribute('href', 'https://www.messagingme.fr/politique-de-confidentialite/');
    const direct = page.getByRole('button', { name: 'Autoriser dans Mon espace' });
    await expect(direct).toBeVisible();
    // Google reste offert, pour un autre espace, et le dit.
    await expect(page.getByTestId('google-simule')).toBeVisible();
    await expect(page.getByText('Pas encore de compte ? Il sera créé avec votre adresse Google.')).toBeVisible();
    expect(autorisations(appels)).toEqual([]);

    await direct.click();
    await page.waitForURL(/localhost:5555\/callback/);
    expect(page.url()).toBe(RETOUR);
    expect(autorisations(appels)).toEqual([
      { chemin: '/tenants/t1/oauth/autoriser', methode: 'POST', corps: { demande: 'd-e2e' }, autorisation: 'Bearer jeton-console' },
    ]);
  });

  test('🔴 une session qui n’est pas admin n’a pas de bouton direct, et son espace n’est même pas lu', async ({ page }) => {
    await avecSession(page, { ...SESSION_ADMIN, role: 'agent' });
    const appels = await monter(page, (chemin) => (chemin === '/oauth/consentement/demande' ? { body: DEMANDE } : undefined));
    await page.goto('/autoriser?demande=d-e2e');
    await expect(page.getByTestId('google-simule')).toBeVisible();
    await expect(page.getByTestId('autoriser-direct')).toHaveCount(0);
    expect(appels.filter((a) => a.chemin.startsWith('/tenants/'))).toEqual([]);
  });

  test('🔴 le refus du serveur s’affiche et la page reste ; une session expirée n’est pas vidée', async ({ page }) => {
    await avecSession(page, SESSION_ADMIN);
    let reponse: Reponse = { status: 403, body: { error: 'seul un administrateur de l’espace peut autoriser Claude' } };
    await monter(page, (chemin) => {
      if (chemin === '/oauth/consentement/demande') return { body: DEMANDE };
      if (chemin === '/tenants/t1/nom') return { body: { nom: 'Mon espace' } };
      if (chemin === '/tenants/t1/oauth/autoriser') return reponse;
      return undefined;
    });
    await page.goto('/autoriser?demande=d-e2e');
    await page.getByTestId('autoriser-direct').click();
    await expect(page.getByTestId('autoriser-refus')).toHaveText('seul un administrateur de l’espace peut autoriser Claude');
    await expect(page).toHaveURL(/\/autoriser\?demande=d-e2e$/);

    reponse = { status: 401, body: { error: 'token invalide ou expiré' } };
    await page.getByTestId('autoriser-direct').click();
    await expect(page.getByTestId('autoriser-refus')).toHaveText('Votre session de la console a expiré : continuez avec Google.');
    await expect(page.getByTestId('autoriser-direct')).toHaveCount(0);
    await expect(page.getByTestId('google-simule')).toBeVisible();
    expect(JSON.parse((await stockage(page, 'mba.session')) ?? '{}')).toEqual(SESSION_ADMIN);
  });

  test('🔴 une adresse de retour qui ne vise pas l’hôte montré : la page n’y va pas', async ({ page }) => {
    await avecSession(page, SESSION_ADMIN);
    await monter(page, (chemin) => {
      if (chemin === '/oauth/consentement/demande') return { body: DEMANDE };
      if (chemin === '/tenants/t1/nom') return { body: { nom: 'Mon espace' } };
      if (chemin === '/tenants/t1/oauth/autoriser') return { body: { adresse: 'https://evil.e2e.test/callback?code=mbc_e2e' } };
      return undefined;
    });
    await page.goto('/autoriser?demande=d-e2e');
    await page.getByTestId('autoriser-direct').click();
    await expect(page.getByTestId('autoriser-refus')).toContainText('ne correspond pas à celle annoncée');
    await expect(page).toHaveURL(/\/autoriser\?demande=d-e2e$/);
  });
});

test.describe('Autoriser Claude : avec Google', () => {
  test('🔴 un bouton par espace admin, les autres « demandez à un administrateur », le nouvel espace est dit', async ({ page }) => {
    const appels = await monter(page, (chemin) => {
      if (chemin === '/oauth/consentement/demande') return { body: DEMANDE };
      if (chemin === '/oauth/consentement/google') {
        return { body: { choix: 'preuve-e2e', nouveau: true, espaces: [
          { tenantId: 't9', nom: 'Espace de Léa', admin: true },
          { tenantId: 't8', nom: 'Agence', admin: false },
        ] } };
      }
      if (chemin === '/oauth/consentement/autoriser') return { body: { adresse: RETOUR } };
      return undefined;
    });
    await page.goto('/autoriser?demande=d-e2e');
    // Sans session, Google est la seule porte : pas de bouton direct.
    await expect(page.getByTestId('autoriser-direct')).toHaveCount(0);
    await expect(page.getByText('Pas encore de compte ? Il sera créé avec votre adresse Google.')).toBeVisible();
    await page.getByTestId('google-simule').click();

    await expect(page.getByTestId('autoriser-nouvel-espace')).toBeVisible();
    await expect(page.getByTestId('espace-non-admin-t8')).toContainText('Agence');
    await expect(page.getByTestId('espace-non-admin-t8')).toContainText('demandez à un administrateur');
    await expect(page.getByRole('button', { name: /Agence/ })).toHaveCount(0);
    const bouton = page.getByRole('button', { name: 'Autoriser dans Espace de Léa' });
    await expect(bouton).toBeVisible();
    expect(appels.find((a) => a.chemin === '/oauth/consentement/google')?.corps).toEqual({ demande: 'd-e2e', idToken: 'jeton-google-e2e' });
    expect(autorisations(appels)).toEqual([]);

    await bouton.click();
    await page.waitForURL(/localhost:5555\/callback/);
    expect(autorisations(appels).map((a) => a.corps)).toEqual([{ demande: 'd-e2e', choix: 'preuve-e2e', tenantId: 't9' }]);
    // Google ne pose aucune session de la console : la page de consentement n'ouvre pas la console.
    expect(await page.evaluate(() => window.localStorage.getItem('mba.session'))).toBeNull();
  });

  test('🔴 la preuve Google expirée (401) ramène au bouton Google, avec la raison', async ({ page }) => {
    await monter(page, (chemin) => {
      if (chemin === '/oauth/consentement/demande') return { body: DEMANDE };
      if (chemin === '/oauth/consentement/google') return { body: { choix: 'preuve-e2e', nouveau: false, espaces: [{ tenantId: 't9', nom: 'Espace de Léa', admin: true }] } };
      if (chemin === '/oauth/consentement/autoriser') return { status: 401, body: { error: 'connexion Google expirée : reconnectez-vous' } };
      return undefined;
    });
    await page.goto('/autoriser?demande=d-e2e');
    await page.getByTestId('google-simule').click();
    await page.getByRole('button', { name: 'Autoriser dans Espace de Léa' }).click();
    await expect(page.getByTestId('autoriser-refus')).toHaveText('connexion Google expirée : reconnectez-vous');
    await expect(page.getByTestId('autoriser-espaces')).toHaveCount(0);
    await expect(page.getByTestId('google-simule')).toBeVisible();
  });
});
