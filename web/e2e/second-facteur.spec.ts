import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { repondre } from './aide/confirmation';

/**
 * LA DOUBLE AUTHENTIFICATION, CÔTÉ CONSOLE (plan `docs/superpowers/plans/2026-09-25-mfa-admins.md`, tâche 8).
 *
 * 🔴 CE QUE CES TESTS TIENNENT : aucune session n'existe avant que le code soit passé, un code faux garde la
 * personne sur l'étape (et ne la déconnecte jamais de la page Compte), une étape expirée la ramène au début, et
 * les codes de secours ne quittent pas l'écran (ni URL, ni stockage du navigateur, ni journal de la console).
 *
 * Les réponses de l'API sont celles de `src/auth/routes.ts` et `src/auth/mfa-routes.ts`, recopiées à la main :
 * aucun serveur ne tourne derrière.
 */

type Reponse = { status?: number; body: unknown };
type Repondeur = (chemin: string, methode: string, corps: Record<string, unknown> | null) => Reponse | undefined;
type Appel = { chemin: string; methode: string; corps: Record<string, unknown> | null };

const CODE_INVALIDE = { status: 401, body: { error: 'Code invalide ou expiré.' } };
const ETAPE_EXPIREE = { status: 401, body: { error: 'Cette étape a expiré, reconnectez-vous.' } };
const SESSION_ADMIN = { token: 'jeton-session', user: { email: 'a@b.co', role: 'admin', tenantId: 't1' } };
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CLE = { secret: SECRET, uri: `otpauth://totp/Engage%20Me:a%40b.co?secret=${SECRET}&issuer=Engage%20Me&algorithm=SHA1&digits=6&period=30` };
/** Dix codes distincts, au format du serveur (`XXXXXXXX-XXXXXXXX`, alphabet base32). */
const CODES = 'ABCDEFGHJK'.split('').map((l) => `${l.repeat(4)}2345-6723${l.repeat(4)}`);

async function monter(page: Page, repondeur: Repondeur, session?: Record<string, unknown>): Promise<Appel[]> {
  const appels: Appel[] = [];
  if (session) await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname.replace('/api/backend', '');
    const corps = req.postData() ? (req.postDataJSON() as Record<string, unknown>) : null;
    appels.push({ chemin, methode: req.method(), corps });
    const r = repondeur(chemin, req.method(), corps)
      ?? (chemin === '/auth/config' ? { body: { googleClientId: '', googleEnabled: false } } : { body: {} });
    return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return appels;
}

/** Une suite de réponses : la n-ième réponse au n-ième appel, la dernière ensuite. */
function suite(...reponses: Reponse[]): () => Reponse {
  let i = 0;
  return () => reponses[Math.min(i++, reponses.length - 1)]!;
}

async function seConnecter(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill('a@b.co');
  await page.locator('input[type="password"]').fill('motdepasse-long');
  await page.getByRole('button', { name: /Se connecter|Sign in/ }).click();
}

const sessionEnregistree = (page: Page): Promise<string | null> => page.evaluate(() => window.localStorage.getItem('mba.session'));
const appelsVers = (appels: Appel[], fin: string): Appel[] => appels.filter((a) => a.chemin.endsWith(fin));

test.describe('Connexion : l’étape du code', () => {
  test('🔴 un code est dû : aucune session avant lui, puis on entre', async ({ page }) => {
    const appels = await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { mfaToken: 'jeton-mfa' } };
      if (chemin === '/auth/mfa/verifier') return { body: SESSION_ADMIN };
      return undefined;
    });
    await seConnecter(page);
    await expect(page.getByTestId('etape-code')).toBeVisible();
    // Le mot de passe est passé, mais rien n'est ouvert : ni session, ni changement de page.
    expect(await sessionEnregistree(page)).toBeNull();
    expect(page.url()).toContain('/login');

    await page.getByTestId('code-connexion').fill('123456');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await page.waitForURL('**/accueil', { timeout: 15_000 });
    expect(appelsVers(appels, '/auth/mfa/verifier').map((a) => a.corps)).toEqual([{ mfaToken: 'jeton-mfa', code: '123456' }]);
    expect(JSON.parse((await sessionEnregistree(page)) ?? '{}')).toMatchObject({ token: 'jeton-session', role: 'admin', tenantId: 't1' });
  });

  test('🔴 un code faux garde sur l’étape, le bon fait entrer', async ({ page }) => {
    const verifier = suite(CODE_INVALIDE, { body: SESSION_ADMIN });
    const appels = await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { mfaToken: 'jeton-mfa' } };
      if (chemin === '/auth/mfa/verifier') return verifier();
      return undefined;
    });
    await seConnecter(page);
    await page.getByTestId('code-connexion').fill('000000');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await expect(page.getByTestId('etape-code-erreur')).toHaveText(/Code invalide ou expiré\.|Invalid or expired code\./);
    // Toujours sur l'étape, le champ vidé pour la saisie suivante, et toujours aucune session.
    await expect(page.getByTestId('etape-code')).toBeVisible();
    await expect(page.getByTestId('code-connexion')).toHaveValue('');
    expect(await sessionEnregistree(page)).toBeNull();

    await page.getByTestId('code-connexion').fill('654321');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await page.waitForURL('**/accueil', { timeout: 15_000 });
    expect(appelsVers(appels, '/auth/mfa/verifier').map((a) => a.corps?.code)).toEqual(['000000', '654321']);
  });

  test('🔴 une étape expirée ramène au formulaire, avec la raison', async ({ page }) => {
    await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { mfaToken: 'jeton-mfa' } };
      if (chemin === '/auth/mfa/verifier') return ETAPE_EXPIREE;
      return undefined;
    });
    await seConnecter(page);
    await page.getByTestId('code-connexion').fill('123456');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await expect(page.getByTestId('second-facteur')).toHaveCount(0);
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByText(/Cette étape a expiré, reconnectez-vous\.|This step has expired/)).toBeVisible();
    expect(await sessionEnregistree(page)).toBeNull();
  });

  test('code de secours : l’aide change, le nombre restant est dit, puis on entre', async ({ page }) => {
    const appels = await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { mfaToken: 'jeton-mfa' } };
      if (chemin === '/auth/mfa/verifier') return { body: { ...SESSION_ADMIN, codesSecoursRestants: 4 } };
      return undefined;
    });
    await seConnecter(page);
    await page.getByRole('button', { name: /Utiliser un code de secours|Use a backup code/ }).click();
    await expect(page.getByText(/^(Code de secours|Backup code)$/)).toBeVisible();
    await page.getByTestId('code-connexion').fill(CODES[0]!);
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await expect(page.getByTestId('code-secours-accepte')).toContainText(/reste 4|4 left/);
    expect(page.url()).toContain('/login');
    await page.getByRole('button', { name: /^(Continuer|Continue)$/ }).click();
    await page.waitForURL('**/accueil', { timeout: 15_000 });
    // Le même champ porte l'un ou l'autre : c'est le serveur qui reconnaît un code de secours.
    expect(appelsVers(appels, '/auth/mfa/verifier').at(-1)?.corps).toEqual({ mfaToken: 'jeton-mfa', code: CODES[0] });
  });

  test('🔴 plusieurs espaces : la liste n’apparaît qu’APRÈS le code', async ({ page }) => {
    await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { mfaToken: 'jeton-mfa' } };
      if (chemin === '/auth/mfa/verifier') {
        return { body: { choiceToken: 'jeton-choix', workspaces: [
          { tenantId: 't-alpha', tenantName: 'Espace Alpha', role: 'admin' },
          { tenantId: 't-beta', tenantName: 'Espace Beta', role: 'agent' },
        ] } };
      }
      return undefined;
    });
    await seConnecter(page);
    await expect(page.getByTestId('etape-code')).toBeVisible();
    await expect(page.getByTestId('choix-espace')).toHaveCount(0);
    await page.getByTestId('code-connexion').fill('123456');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await expect(page.getByTestId('choix-espace')).toContainText('Espace Beta');
  });
});

test.describe('Enrôlement obligatoire d’un administrateur', () => {
  test('🔴 QR, clé, premier code, dix codes de secours, puis seulement la session', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const journal: string[] = [];
    page.on('console', (m) => journal.push(m.text()));
    const appels = await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { enrolToken: 'jeton-enrol' } };
      if (chemin === '/auth/mfa/enroler') return { body: CLE };
      if (chemin === '/auth/mfa/activer') return { body: { codesSecours: CODES, ...SESSION_ADMIN } };
      return undefined;
    });
    await seConnecter(page);

    // Le QR code est DESSINÉ dans le navigateur (aucun service tiers ne voit le secret), la clé est groupée.
    await expect(page.getByTestId('enrolement-qr')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.getByTestId('enrolement-cle')).toHaveText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(appelsVers(appels, '/auth/mfa/enroler')).toHaveLength(1);

    await page.getByTestId('code-enrolement').fill('123456');
    await page.getByRole('button', { name: /^(Activer|Activate)$/ }).click();
    const liste = page.getByTestId('codes-secours-liste');
    await expect(liste.locator('li')).toHaveCount(10);
    for (const c of CODES) await expect(liste).toContainText(c);
    expect(appelsVers(appels, '/auth/mfa/activer').map((a) => a.corps)).toEqual([{ enrolToken: 'jeton-enrol', code: '123456' }]);

    // Copier, et Télécharger un .txt qui porte les dix codes.
    await page.getByTestId('codes-secours-copier').click();
    await expect(page.getByTestId('codes-secours-copier')).toHaveText(/Copiés|Copied/);
    // Le presse-papiers de Windows rend les fins de ligne en `\r\n` : on compare ligne à ligne.
    expect((await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/)).toEqual(CODES);
    const [telechargement] = await Promise.all([page.waitForEvent('download'), page.getByTestId('codes-secours-telecharger').click()]);
    expect(telechargement.suggestedFilename()).toBe('engage-me-codes-de-secours.txt');
    const fichier = readFileSync((await telechargement.path())!, 'utf8');
    for (const c of CODES) expect(fichier).toContain(c);

    // Pas de session tant que la case n'est pas cochée et la suite pas demandée.
    const continuer = page.getByTestId('codes-secours-continuer');
    await expect(continuer).toBeDisabled();
    expect(await sessionEnregistree(page)).toBeNull();
    await page.getByTestId('codes-secours-conserves').check();
    await continuer.click();
    await page.waitForURL('**/accueil', { timeout: 15_000 });
    expect(JSON.parse((await sessionEnregistree(page)) ?? '{}')).toMatchObject({ token: 'jeton-session', role: 'admin' });

    // 🔴 Les codes n'ont laissé AUCUNE trace : ni dans l'adresse, ni dans les stockages, ni dans la console.
    const stockages = await page.evaluate(() => JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage));
    for (const c of CODES) {
      expect(page.url()).not.toContain(c);
      expect(stockages).not.toContain(c);
      expect(journal.join('\n')).not.toContain(c);
    }
  });

  test('sur un téléphone, la clé et les dix codes tiennent dans la carte, un code par ligne', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { enrolToken: 'jeton-enrol' } };
      if (chemin === '/auth/mfa/enroler') return { body: CLE };
      if (chemin === '/auth/mfa/activer') return { body: { codesSecours: CODES, ...SESSION_ADMIN } };
      return undefined;
    });
    await seConnecter(page);
    await expect(page.getByTestId('enrolement-cle')).toBeVisible();
    const deborde = (testId: string): Promise<number> =>
      page.getByTestId(testId).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(await deborde('second-facteur'), 'la carte de l’enrôlement déborde').toBeLessThanOrEqual(0);
    await page.getByTestId('code-enrolement').fill('123456');
    await page.getByRole('button', { name: /^(Activer|Activate)$/ }).click();
    const liste = page.getByTestId('codes-secours-liste');
    await expect(liste.locator('li')).toHaveCount(10);
    expect(await deborde('codes-secours-liste'), 'un code sort de la liste').toBeLessThanOrEqual(0);
    // Un code coupé à son tiret se recopierait mal : chacun tient sur UNE ligne, comme le premier.
    const hauteurs = await liste.locator('li').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(hauteurs).size, `hauteurs : ${hauteurs.join(', ')}`).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('un premier code faux garde sur l’enrôlement ; un facteur activé ailleurs renvoie au formulaire', async ({ page }) => {
    const activer = suite(CODE_INVALIDE, { status: 409, body: { error: 'La double authentification est déjà active. Reconnectez-vous.' } });
    await monter(page, (chemin) => {
      if (chemin === '/auth/login') return { body: { enrolToken: 'jeton-enrol' } };
      if (chemin === '/auth/mfa/enroler') return { body: CLE };
      if (chemin === '/auth/mfa/activer') return activer();
      return undefined;
    });
    await seConnecter(page);
    await page.getByTestId('code-enrolement').fill('000000');
    await page.getByRole('button', { name: /^(Activer|Activate)$/ }).click();
    await expect(page.getByTestId('enrolement-erreur')).toHaveText(/Code invalide ou expiré\.|Invalid or expired code\./);
    await expect(page.getByTestId('enrolement-qr')).toBeVisible();

    await page.getByTestId('code-enrolement').fill('123456');
    await page.getByRole('button', { name: /^(Activer|Activate)$/ }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByText('La double authentification est déjà active. Reconnectez-vous.')).toBeVisible();
  });

  test('🔴 inscription : l’espace créé passe par l’enrôlement avant l’accueil', async ({ page }) => {
    const appels = await monter(page, (chemin) => {
      if (chemin === '/auth/signup') return { status: 201, body: { enrolToken: 'jeton-enrol' } };
      if (chemin === '/auth/mfa/enroler') return { body: CLE };
      if (chemin === '/auth/mfa/activer') return { body: { codesSecours: CODES, ...SESSION_ADMIN } };
      return undefined;
    });
    await page.goto('/signup');
    await page.getByPlaceholder(/Mon entreprise|My company/).fill('Mon espace');
    await page.locator('input[type="email"]').fill('a@b.co');
    await page.locator('input[type="password"]').fill('motdepasse-long');
    await page.getByRole('button', { name: /Créer mon espace|Create my workspace/ }).click();
    await page.getByTestId('code-enrolement').fill('123456');
    await page.getByRole('button', { name: /^(Activer|Activate)$/ }).click();
    await expect(page.getByTestId('codes-secours-liste').locator('li')).toHaveCount(10);
    expect(await sessionEnregistree(page)).toBeNull();
    await page.getByTestId('codes-secours-conserves').check();
    await page.getByTestId('codes-secours-continuer').click();
    await page.waitForURL('**/accueil', { timeout: 15_000 });
    expect(appelsVers(appels, '/auth/signup')).toHaveLength(1);
  });

  test('inscription : une étape expirée renvoie à la connexion, jamais au formulaire (l’espace existe déjà)', async ({ page }) => {
    await monter(page, (chemin) => {
      if (chemin === '/auth/signup') return { status: 201, body: { enrolToken: 'jeton-enrol' } };
      if (chemin === '/auth/mfa/enroler') return ETAPE_EXPIREE;
      return undefined;
    });
    await page.goto('/signup');
    await page.getByPlaceholder(/Mon entreprise|My company/).fill('Mon espace');
    await page.locator('input[type="email"]').fill('a@b.co');
    await page.locator('input[type="password"]').fill('motdepasse-long');
    await page.getByRole('button', { name: /Créer mon espace|Create my workspace/ }).click();
    const bloc = page.getByTestId('etape-interrompue');
    await expect(bloc).toContainText(/Cette étape a expiré|This step has expired/);
    await expect(bloc.getByRole('link')).toHaveAttribute('href', '/login');
    await expect(page.getByRole('button', { name: /Créer mon espace|Create my workspace/ })).toHaveCount(0);
  });
});

test.describe('Invitation acceptée', () => {
  test('🔴 une adresse qui a déjà un facteur donne son code avant d’entrer', async ({ page }) => {
    await monter(page, (chemin) => {
      if (chemin === '/auth/invitations/accept') return { body: { mfaToken: 'jeton-mfa' } };
      if (chemin === '/auth/mfa/verifier') return { body: SESSION_ADMIN };
      return undefined;
    });
    await page.goto('/invite/jeton-invitation');
    await page.locator('input[type="password"]').fill('motdepasse-long');
    await page.getByRole('button', { name: /Activer mon compte|Activate my account/ }).click();
    await expect(page.getByTestId('etape-code')).toBeVisible();
    expect(await sessionEnregistree(page)).toBeNull();
    await page.getByTestId('code-connexion').fill('123456');
    await page.getByRole('button', { name: /^(Valider|Confirm)$/ }).click();
    await page.waitForURL('**/accueil', { timeout: 15_000 });
  });

  test('un agent sans facteur entre directement, comme avant', async ({ page }) => {
    await monter(page, (chemin) => {
      if (chemin === '/auth/invitations/accept') return { body: { token: 'jeton-agent', user: { email: 'a@b.co', role: 'agent', tenantId: 't1' } } };
      return undefined;
    });
    await page.goto('/invite/jeton-invitation');
    await page.locator('input[type="password"]').fill('motdepasse-long');
    await page.getByRole('button', { name: /Activer mon compte|Activate my account/ }).click();
    await page.waitForURL('**/inbox', { timeout: 15_000 });
  });
});

const SESSION_E2E = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const ACTIF_ADMIN = { actif: true, activeLe: '2026-09-20T08:00:00.000Z', codesSecoursRestants: 7, obligatoire: true };

test.describe('Mon compte : la double authentification', () => {
  test('🔴 activer depuis Mon compte, jusqu’aux codes de secours', async ({ page }) => {
    let actif = false;
    const appels = await monter(page, (chemin, methode) => {
      if (chemin === '/auth/mfa/moi' && methode === 'GET') {
        return { body: actif ? { actif: true, activeLe: '2026-09-26T08:00:00.000Z', codesSecoursRestants: 10, obligatoire: false } : { actif: false, activeLe: null, codesSecoursRestants: 0, obligatoire: false } };
      }
      if (chemin === '/auth/mfa/moi/enroler') return { body: CLE };
      if (chemin === '/auth/mfa/moi/activer') { actif = true; return { body: { codesSecours: CODES } }; }
      return undefined;
    }, { ...SESSION_E2E, role: 'agent' });
    await page.goto('/compte');
    await expect(page.getByTestId('mfa-etat')).toHaveText(/Désactivée|Disabled/);
    await page.getByTestId('mfa-activer').click();
    await expect(page.getByTestId('enrolement-cle')).toHaveText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    await page.getByTestId('code-enrolement').fill('123456');
    await page.getByRole('button', { name: /^(Activer|Activate)$/ }).click();
    await expect(page.getByTestId('codes-secours-liste').locator('li')).toHaveCount(10);
    await page.getByTestId('codes-secours-conserves').check();
    await page.getByTestId('codes-secours-continuer').click();
    await expect(page.getByTestId('mfa-etat')).toContainText(/restants : 10|left: 10/);
    await expect(page.getByTestId('mfa-message')).toHaveText(/Double authentification activée\.|enabled/);
    expect(appelsVers(appels, '/auth/mfa/moi/activer').map((a) => a.corps)).toEqual([{ code: '123456' }]);
  });

  test('🔴 un code faux ne déconnecte pas ; le bon rend dix codes neufs', async ({ page }) => {
    const codes = suite(CODE_INVALIDE, { body: { codesSecours: CODES } });
    const appels = await monter(page, (chemin, methode) => {
      if (chemin === '/auth/mfa/moi' && methode === 'GET') return { body: ACTIF_ADMIN };
      if (chemin === '/auth/mfa/moi/codes') return codes();
      return undefined;
    }, SESSION_E2E);
    await page.goto('/compte');
    await expect(page.getByTestId('mfa-etat')).toContainText(/restants : 7|left: 7/);
    await page.getByTestId('mfa-regenerer').click();
    await page.getByTestId('mfa-code').fill('000000');
    await page.getByRole('button', { name: /^(Régénérer|Regenerate)$/ }).click();
    await expect(page.getByTestId('mfa-message')).toHaveText(/Code invalide ou expiré\.|Invalid or expired code\./);
    // La session est INTACTE, et la bannière de session expirée n'est pas apparue.
    expect(await sessionEnregistree(page)).not.toBeNull();
    await expect(page.getByTestId('session-expiree')).toHaveCount(0);

    await page.getByTestId('mfa-code').fill('123456');
    await page.getByRole('button', { name: /^(Régénérer|Regenerate)$/ }).click();
    await expect(page.getByTestId('codes-secours-liste').locator('li')).toHaveCount(10);
    await page.getByTestId('codes-secours-conserves').check();
    await page.getByTestId('codes-secours-continuer').click();
    await expect(page.getByTestId('mfa-message')).toHaveText(/Nouveaux codes|New backup codes/);
    expect(appelsVers(appels, '/auth/mfa/moi/codes').map((a) => a.corps)).toEqual([{ code: '000000' }, { code: '123456' }]);
  });

  test('🔴 un administrateur ne peut pas la désactiver : aucun bouton, et la raison', async ({ page }) => {
    await monter(page, (chemin, methode) => (chemin === '/auth/mfa/moi' && methode === 'GET' ? { body: ACTIF_ADMIN } : undefined), SESSION_E2E);
    await page.goto('/compte');
    await expect(page.getByTestId('mfa-regenerer')).toBeVisible();
    await expect(page.getByTestId('mfa-desactiver')).toHaveCount(0);
    await expect(page.getByTestId('mfa-obligatoire')).toHaveText(/Obligatoire pour les administrateurs|Required for administrators/);
  });

  test('un agent la désactive avec un code', async ({ page }) => {
    let actif = true;
    const appels = await monter(page, (chemin, methode) => {
      if (chemin === '/auth/mfa/moi' && methode === 'GET') {
        return { body: actif ? { ...ACTIF_ADMIN, obligatoire: false } : { actif: false, activeLe: null, codesSecoursRestants: 0, obligatoire: false } };
      }
      if (chemin === '/auth/mfa/moi/desactiver') { actif = false; return { body: { ok: true } }; }
      return undefined;
    }, { ...SESSION_E2E, role: 'agent' });
    await page.goto('/compte');
    await page.getByTestId('mfa-desactiver').click();
    await page.getByTestId('mfa-code').fill('123456');
    await page.getByRole('button', { name: /^(Désactiver|Disable)$/ }).click();
    await expect(page.getByTestId('mfa-etat')).toHaveText(/Désactivée|Disabled/);
    expect(appelsVers(appels, '/auth/mfa/moi/desactiver').map((a) => a.corps)).toEqual([{ code: '123456' }]);
  });
});

test.describe('Équipe : réinitialiser le facteur d’un membre', () => {
  const USERS = [
    { id: 'u-moi', email: 'admin@e2e.test', name: 'Moi', role: 'admin', disabled: false, pending: false, createdAt: '2026-09-01T00:00:00.000Z', lastLoginAt: null },
    { id: 'u-agent', email: 'agent@e2e.test', name: 'Agent', role: 'agent', disabled: false, pending: false, createdAt: '2026-09-01T00:00:00.000Z', lastLoginAt: null },
    { id: 'u-ailleurs', email: 'ailleurs@e2e.test', name: 'Ailleurs', role: 'admin', disabled: false, pending: false, createdAt: '2026-09-01T00:00:00.000Z', lastLoginAt: null },
    { id: 'u-invite', email: 'invite@e2e.test', name: null, role: 'agent', disabled: false, pending: true, createdAt: '2026-09-01T00:00:00.000Z', lastLoginAt: null },
  ];

  test('🔴 confirmée, elle part ; refusée, rien ne part ; le 409 dit « le support »', async ({ page }) => {
    const appels = await monter(page, (chemin, methode) => {
      if (chemin === '/tenants/t-e2e/users' && methode === 'GET') return { body: { users: USERS } };
      if (chemin === '/tenants/t-e2e/nom') return { body: { nom: 'Espace E2E' } };
      if (chemin === '/tenants/t-e2e/users/u-agent/mfa' && methode === 'DELETE') return { body: { id: 'u-agent', mfaReinitialise: true } };
      if (chemin === '/tenants/t-e2e/users/u-ailleurs/mfa' && methode === 'DELETE') {
        return { status: 409, body: { error: 'Ce membre a aussi un compte dans un autre espace : sa double authentification se réinitialise par le support.' } };
      }
      return undefined;
    }, SESSION_E2E);
    await page.goto('/admin');
    // Ni sur soi-même, ni sur une invitation en attente.
    await expect(page.getByTestId('membre-mfa-u-agent')).toBeVisible();
    await expect(page.getByTestId('membre-mfa-u-moi')).toHaveCount(0);
    await expect(page.getByTestId('membre-mfa-u-invite')).toHaveCount(0);

    const reinitialisations = (): Appel[] => appels.filter((a) => a.methode === 'DELETE' && a.chemin.endsWith('/mfa'));
    await page.getByTestId('membre-mfa-u-agent').click();
    await repondre(page, false, 'agent@e2e.test');
    expect(reinitialisations()).toHaveLength(0);

    await page.getByTestId('membre-mfa-u-agent').click();
    await repondre(page, true, /Retirer la double authentification|Remove two-factor authentication/);
    await expect(page.getByTestId('admin-info')).toContainText('agent@e2e.test');
    expect(reinitialisations().map((a) => a.chemin)).toEqual(['/tenants/t-e2e/users/u-agent/mfa']);

    await page.getByTestId('membre-mfa-u-ailleurs').click();
    await repondre(page, true);
    await expect(page.getByTestId('admin-erreur')).toHaveText(/Cette personne a un accès à un autre espace : la réinitialisation passe par le support\.|This person has access to another workspace/);
  });
});
