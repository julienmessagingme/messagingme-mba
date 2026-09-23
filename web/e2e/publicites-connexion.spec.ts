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

/** Ce que Meta rend : un compte avec son NOM, sa devise, son fuseau et son statut. */
const ACTIFS = {
  comptesPub: [{ id: '111', nom: 'GMC', devise: 'EUR', fuseau: 'Europe/Paris', statut: 1 }],
  pages: [{ id: 'p1', nom: 'Gerermonchantier' }],
};

const CONNEXION = {
  comptePubId: '111', compteNom: 'GMC', pageId: 'p1', pageNom: 'Gerermonchantier', devise: 'EUR', fuseau: 'Europe/Paris',
  pageLiee: 'oui' as string | null, connectePar: 'u-1',
  connecteLe: '2026-09-23T08:00:00.000Z', jetonRejeteLe: null as string | null,
};

type Etat = { configure: boolean; configId: string; appId: string; graphVersion: string; connexion: unknown; compte?: unknown } | 404;

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

const etatVivant = (over: Partial<{ configure: boolean; connexion: unknown; compte: unknown }> = {}): Etat => ({
  configure: true, configId: 'cfg-pub', appId: 'app-1', graphVersion: 'v23.0', connexion: null,
  compte: { statut: 1, raisonDesactivation: 0, moyenPaiement: true }, ...over,
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
    // Le NOM, pas l identifiant : c est ce que Julien demande le 2026-09-23 (« je veux voir des noms »).
    await expect(page.getByTestId('pubs-compte')).toHaveText('GMC');
    await expect(page.getByTestId('pubs-page')).toHaveText('Gerermonchantier');
    // et l identifiant reste a vue, en petit : c est lui qu on donne au support.
    await expect(page.getByText('111', { exact: true })).toBeVisible();
    await expect(page.getByTestId('pubs-devise')).toHaveText('EUR');
    await expect(page.getByTestId('pubs-fuseau')).toHaveText('Europe/Paris');
    // ⚠️ LE CAS QU'EXERÇAIT L'ANCIENNE ASSERTION EST CONSERVÉ, et son verdict a changé : l'écran
    // affirmait « la Page est bien liée ». Meta n'expose PAS cette liaison (mesuré le 2026-09-23), donc
    // l'écran n'affirme plus rien : il emmène le client là où Meta l'affiche. C'est ce lien qui compte,
    // parce qu'un « je ne sais pas » sans suite est ce qu'on remplace.
    await expect(page.getByRole('link', { name: /voir la liaison chez Meta|check the link at Meta/ }))
      .toHaveAttribute('href', 'https://business.facebook.com/wa/manage/phone-numbers/');
  });

  test('⚠️ sans nom (connexion d avant la migration 0169), l ecran retombe sur l identifiant', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: { ...CONNEXION, compteNom: null, pageNom: null } }));
    await expect(page.getByTestId('pubs-compte')).toHaveText('111');
    await expect(page.getByTestId('pubs-page')).toHaveText('p1');
  });

  test('🔴 « pret a diffuser » quand le compte est actif ET porte un moyen de paiement', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: CONNEXION }));
    await expect(page.getByTestId('pubs-diffusion')).toContainText(/Prêt à diffuser|Ready to deliver/);
  });

  test('🔴 SANS moyen de paiement, l ecran dit que la pub ne partirait JAMAIS', async ({ page }) => {
    // Sans ca, la pub se cree, ne diffuse pas, et l erreur arrive des jours plus tard.
    await brancher(page, etatVivant({ connexion: CONNEXION, compte: { statut: 1, raisonDesactivation: 0, moyenPaiement: false } }));
    await expect(page.getByTestId('pubs-diffusion')).toContainText(/moyen de paiement|payment method/);
  });

  test('🔴 `compte: null` ne passe PAS pour un feu vert : on dit qu on n a pas pu demander', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: CONNEXION, compte: null }));
    await expect(page.getByTestId('pubs-diffusion')).toContainText(/pas pu demander|could not ask/);
    await expect(page.getByTestId('pubs-diffusion')).not.toContainText(/Prêt à diffuser|Ready to deliver/);
  });

  test('🔴 `statut: null` est une IGNORANCE, pas un compte inactif', async ({ page }) => {
    // Meta peut répondre 200 sans `account_status`. Le ranger avec « pas actif » envoyait le client
    // réparer un compte qui va peut-être très bien, ce qui est le raisonnement que ce lot a retiré
    // de la liaison Page.
    await brancher(page, etatVivant({ connexion: CONNEXION, compte: { statut: null, raisonDesactivation: null, moyenPaiement: true } }));
    await expect(page.getByTestId('pubs-diffusion')).toContainText(/ne nous a pas dit|did not tell us/);
    await expect(page.getByTestId('pubs-diffusion')).not.toContainText(/n’est pas actif|not active/);
  });

  test('⚠️ le motif de désactivation de Meta est AFFICHÉ : c est ce que le client doit corriger', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: CONNEXION, compte: { statut: 2, raisonDesactivation: 3, moyenPaiement: true } }));
    await expect(page.getByTestId('pubs-diffusion')).toContainText(/n’est pas actif|not active/);
    await expect(page.getByTestId('pubs-diffusion')).toContainText('3');
  });

  test('🔴 le champ ABSENT ne fait pas tomber l ecran : l API d hier ne le porte pas', async ({ page }) => {
    // La console est publiée par Vercel à chaque push, l'API attend son déploiement : pendant cette
    // fenêtre, la réponse n'a AUCUNE clé `compte`. `undefined` n'est pas `null`, et le confondre avec
    // « tout va bien » ou le laisser filer vers `compte.statut` casse la page entière.
    // `compte: undefined` et la clé absente donnent le MÊME corps une fois passés par `JSON.stringify`
    // dans `brancher` : c'est bien une réponse SANS la clé que la page reçoit.
    await brancher(page, etatVivant({ connexion: CONNEXION, compte: undefined }));
    await expect(page.getByTestId('pubs-compte')).toHaveText('GMC');
    await expect(page.getByTestId('pubs-diffusion'))
      .toHaveText(/pas pu demander|could not ask/);
  });

  test('🔴 un jeton refusé par Meta demande une RECONNEXION, et ne fait pas passer l’espace pour jamais connecté', async ({ page }) => {
    await brancher(page, etatVivant({ connexion: { ...CONNEXION, jetonRejeteLe: '2026-09-23T10:00:00.000Z' } }));
    await expect(page.getByTestId('pubs-jeton-rejete')).toContainText(/Reconnectez-vous|Reconnect to continue/);
    await expect(page.getByRole('button', { name: /Reconnecter|Reconnect/ })).toBeEnabled();
  });

  test('🔴 la deconnexion FAIT DISPARAITRE la carte, et ne produit aucun bandeau', async ({ page }) => {
    // DEUX proprietes en un cas, parce qu elles se cassent ensemble : un correctif qui retirait le
    // bandeau a emporte le rechargement, et l ecran a continue d afficher « connecte » sur un espace
    // deconnecte. Le cas precedent ne pouvait pas le voir : son faux serveur rendait TOUJOURS une
    // connexion, donc la carte etait visible avant le clic comme apres.
    //
    // ⚠️ L ABSENCE DE BANDEAU EST UNE DECISION DE JULIEN (2026-09-23), pas un oubli : le jeton residuel
    // n est detenu par PERSONNE, donc avertir revient a inquieter pour un acces que nul ne peut
    // exercer, et les gestes qu on pourrait prescrire cassent chacun quelque chose.
    for (const revoqueChezMeta of [true, false]) {
      const gestes: string[] = [];
      let deconnecte = false;
      await page.addInitScript((sess) => window.localStorage.setItem('mba.session', JSON.stringify(sess)), SESSION);
      await page.route('**/api/backend/**', async (route) => {
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
        const url = route.request().url();
        if (url.includes('/pubs/connexion')) {
          gestes.push(route.request().method());
          if (route.request().method() === 'DELETE') {
            deconnecte = true;
            return json({ ok: true, revoqueChezMeta });
          }
          // 🔴 LE SERVEUR DIT LA VERITE : apres le DELETE, l espace n a plus de connexion. C est ce
          // qui rend ce cas capable de voir un ecran qui ne se recharge pas.
          return json(etatVivant({ connexion: deconnecte ? null : CONNEXION }));
        }
        if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
        return json({});
      });
      await page.goto('/publicites');
      await expect(page.getByTestId('pubs-compte')).toBeVisible();
      await page.getByRole('button', { name: /^Déconnecter$|^Disconnect$/ }).click();
      await expect.poll(() => gestes.includes('DELETE')).toBe(true);
      // La carte disparait, et le bouton de connexion revient : l ecran a bien RELU l etat.
      await expect(page.getByTestId('pubs-compte')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Connecter mes publicités|Connect my ads/ })).toBeVisible();
      // Et rien ne prescrit quoi que ce soit, dans les deux sens du retrait.
      await expect(page.getByTestId('pubs-avis')).toHaveCount(0);
      await expect(page.getByText(/Retirez-les vous-même|Remove them yourself/)).toHaveCount(0);
      await expect(page.getByText(/retirer l’application|remove the app/i)).toHaveCount(0);
    }
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
