import { test, expect } from '@playwright/test';

/**
 * L'ÉCRAN « PUBLICITÉS » : ses quatre états, vus depuis le navigateur (lot 2 « Connecter »).
 *
 * 🔴 CE QUE CE SPEC PROTÈGE VRAIMENT, C'EST LA FENÊTRE DE DÉPLOIEMENT. Vercel publie la console à chaque
 * `git push`, quand l'API attend son `up -d --build` : entre les deux, la route n'existe pas. L'onglet
 * « Outils » de l'agent de Meta est resté en 404 plus d'une heure pour cette raison, le 2026-09-21. Le
 * premier test ci-dessous est celui-là : un 404 doit se lire « pas encore configuré », jamais comme une panne.
 */

const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONNEXION = {
  comptePubId: '111', pageId: 'p1', devise: 'EUR', fuseau: 'Europe/Paris',
  pageLiee: 'oui' as string | null, connectePar: 'u-1',
  connecteLe: '2026-09-23T08:00:00.000Z', jetonRejeteLe: null as string | null,
};

type Etat = { configure: boolean; configId: string; appId: string; graphVersion: string; connexion: unknown } | 404;

const brancher = async (page: import('@playwright/test').Page, etat: Etat, role = 'admin') => {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), { ...SESSION, role });
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/pubs/connexion')) {
      if (etat === 404) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
      return json(etat);
    }
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role });
    return json({});
  });
  await page.goto('/publicites');
};

const etatVivant = (over: Partial<{ configure: boolean; connexion: unknown }> = {}): Etat => ({
  configure: true, configId: 'cfg-pub', appId: 'app-1', graphVersion: 'v23.0', connexion: null, ...over,
});

test.describe('Publicités : les états de la connexion', () => {
  test('🔴 la route ABSENTE se lit « pas encore configuré », jamais comme une panne', async ({ page }) => {
    // C'est l'état de la console entre le `git push` (Vercel publie) et le déploiement de l'API.
    await brancher(page, 404);
    await expect(page.getByText(/Publicités non configurées|Ads not configured/)).toBeVisible();
    // Pas de message d'erreur : le testid, et surtout pas `role=alert`, que Next pose lui-même sur son
    // annonceur de route (le piège a fait passer ce test pour rouge alors que l'écran était juste).
    await expect(page.getByTestId('pubs-erreur')).toHaveCount(0);
  });

  test('sans META_ADS_CONFIG_ID, l’écran dit que rien n’est à faire côté client', async ({ page }) => {
    await brancher(page, etatVivant({ configure: false }));
    await expect(page.getByText(/Publicités non configurées|Ads not configured/)).toBeVisible();
    await expect(page.getByText(/Rien à faire de votre côté|Nothing to do on your side/)).toBeVisible();
  });

  test('configuré et non connecté : le bouton de connexion est offert à un admin', async ({ page }) => {
    await brancher(page, etatVivant());
    await expect(page.getByRole('button', { name: /Connecter mes publicités|Connect my ads/ })).toBeEnabled();
  });

  test('🔴 un agent n’OUVRE PAS cet écran : il est renvoyé sur son inbox', async ({ page }) => {
    // `accesAutorise` (lib/nav.ts) ne laisse entrer qu'un admin. Ce test disait d'abord « le bouton est
    // désactivé », ce qui supposait un écran visible : il était faux, et la page portait en conséquence
    // un contrôle de rôle qui ne pouvait jamais servir.
    await brancher(page, etatVivant(), 'agent');
    await expect(page).toHaveURL(/\/inbox/);
  });

  test('connecté : le compte, la Page, la devise et le fuseau viennent du serveur', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: CONNEXION }));
    await expect(page.getByTestId('pubs-compte')).toHaveText('111');
    await expect(page.getByTestId('pubs-page')).toHaveText('p1');
    await expect(page.getByTestId('pubs-devise')).toHaveText('EUR');
    await expect(page.getByTestId('pubs-fuseau')).toHaveText('Europe/Paris');
    await expect(page.getByText(/La Page est bien liée|The Page is linked/)).toBeVisible();
  });

  test('🔴 une liaison INCONNUE ne se dit pas « non liée » : on annonce l’ignorance, pas un refus', async ({ page }) => {
    // Meta documente comment FAIRE la liaison, pas comment la VÉRIFIER. Dire « non liée » enverrait le
    // client refaire une liaison qui existe déjà.
    await brancher(page, etatVivant({ connexion: { ...CONNEXION, pageLiee: 'inconnu' } }));
    await expect(page.getByText(/Meta ne nous dit pas|Meta does not tell us/)).toBeVisible();
    await expect(page.getByText(/liée à un AUTRE compte|linked to ANOTHER WhatsApp/)).toHaveCount(0);
  });

  test('une Page liée à un AUTRE compte le dit, avec sa conséquence', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: { ...CONNEXION, pageLiee: 'non' } }));
    await expect(page.getByText(/n’arriverait pas dans votre Inbox|would not reach your Inbox/)).toBeVisible();
  });

  test('🔴 un jeton refusé par Meta demande une RECONNEXION, et ne fait pas passer l’espace pour jamais connecté', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: { ...CONNEXION, jetonRejeteLe: '2026-09-23T10:00:00.000Z' } }));
    await expect(page.getByTestId('pubs-jeton-rejete')).toContainText(/Reconnectez-vous|Reconnect to continue/);
    await expect(page.getByRole('button', { name: /Reconnecter|Reconnect/ })).toBeEnabled();
  });

  test('🔴 « Reconnecter » DÉCONNECTE d abord : un jeton sans expiration ne s écrase pas en silence', async ({ page }) => {
    // Le nouveau jeton ecrasait l ancien dans la base, or l ancien reste vivant chez Meta et nous venions
    // d en perdre le seul exemplaire. Les deux chemins qui perdent un jeton passent par la revocation.
    const gestes: string[] = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    // Le SDK de Meta est BLOQUÉ exprès : son chargement échoue, donc l'erreur affichée PROUVE que
    // `connecter()` a bien démarré derrière la déconnexion. Sans ça, la fenêtre Meta s'ouvrirait
    // vraiment et n'en reviendrait jamais, et le test ne distinguerait pas `reconnecter` de `deconnecter`.
    await page.route('**/connect.facebook.net/**', (route) => route.abort());
    await page.route('**/api/backend/**', async (route) => {
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      const url = route.request().url();
      if (url.includes('/pubs/connexion')) {
        gestes.push(route.request().method());
        if (route.request().method() === 'DELETE') return json({ ok: true, revoqueChezMeta: true });
        return json(etatVivant({ connexion: CONNEXION }));
      }
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/publicites');
    await page.getByRole('button', { name: /Reconnecter|Reconnect/ }).click();
    await expect.poll(() => gestes.includes('DELETE')).toBe(true);
    // ⚠️ ET LA CONNEXION EST BIEN TENTÉE DERRIÈRE : sans cette assertion, le test passerait si
    // `reconnecter()` se réduisait à `deconnecter()`. Le SDK de Meta n'existe pas dans ce navigateur de
    // test, donc l'échec de son chargement EST la preuve que `connecter()` a bien démarré.
    await expect(page.getByTestId('pubs-erreur')).toContainText(/SDK Facebook|Facebook SDK|bloqueur/);
  });

  test('🔴 si la DÉCONNEXION échoue, « Reconnecter » S ARRÊTE : pas de jeton écrasé sans révocation', async ({ page }) => {
    // Une garde qui n arrete pas la suite ne garde rien : enchainer ouvrirait la fenetre Meta, echangerait
    // un nouveau jeton par-dessus l ancien NON revoque, et effacerait au passage le message d erreur.
    const gestes: string[] = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      const url = route.request().url();
      if (url.includes('/pubs/connexion')) {
        gestes.push(route.request().method());
        if (route.request().method() === 'DELETE') {
          return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Meta ne repond pas"}' });
        }
        return json(etatVivant({ connexion: CONNEXION }));
      }
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/publicites');
    await page.getByRole('button', { name: /Reconnecter|Reconnect/ }).click();
    // Le message d erreur RESTE lisible, et aucun echange n a ete tente.
    await expect(page.getByTestId('pubs-erreur')).toContainText(/Meta ne repond pas/);
    expect(gestes.filter((m) => m === 'POST')).toHaveLength(0);
  });

  test('⚠️ ni liste de pubs ni bouton Créer : ils sont le lot 3, et un bouton inerte serait pire que rien', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: CONNEXION }));
    await expect(page.getByRole('button', { name: /^Créer|^Create/ })).toHaveCount(0);
  });
});
