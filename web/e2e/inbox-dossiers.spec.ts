import { test, expect } from '@playwright/test';

/**
 * L'Inbox en boîte mail : les dossiers, leurs compteurs, et l'archivage.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et qui ne se voit pas en relisant le composant :
 *
 *  1. que le compteur soit affiché MÊME À ZÉRO. Les trois boutons qu'il remplace cachaient le leur quand il
 *     valait zéro ; dans une boîte mail, « Signalé (0) » est une information, et un libellé nu envoie
 *     vérifier pour rien ;
 *  2. que changer de dossier demande le BON filtre au serveur. C'est le point où une régression serait
 *     invisible : la liste se rechargerait, elle montrerait simplement le mauvais contenu ;
 *  3. que la section « Affectation » suive le RÔLE, dans les deux sens.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const OPERATEUR = { token: 'e2e-token', email: 'agent@e2e.test', role: 'agent', tenantId: 't-e2e' };

const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Alice', lastPreview: 'bonjour', lastMessageAt: '2026-09-08T10:00:00Z', controlOwner: 'app_workflow', unread: false, curseur: '2026-09-08T10:00:00Z' },
  { id: 'c2', waId: '33600000002', profileName: 'Bob', lastPreview: 'merci', lastMessageAt: '2026-09-08T09:00:00Z', controlOwner: 'app_human', unread: false, curseur: '2026-09-08T09:00:00Z' },
];

/** Des compteurs volontairement CONTRASTÉS : un à zéro, pour que son affichage se prouve. */
const COMPTEURS = {
  tout: 2, aTraiter: 1, signalees: 0, archivees: 3, nonAffectees: 1,
  parMembre: [{ userId: 'u-jean', nom: 'Jean', n: 1 }, { userId: 'u-marie', nom: 'Marie', n: 0 }],
};

type Appel = { method: string; url: string };

async function mock(page: import('@playwright/test').Page, session: typeof ADMIN, appels: Appel[] = []) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), session);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push({ method: req.method(), url });
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/conversations\/counts/.test(url)) return json(COMPTEURS);
    if (/\/(archive|unarchive)$/.test(url)) return json({ archived: true });
    if (/\/conversations\?|\/conversations$/.test(url)) return json({ conversations: CONVERSATIONS });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/users')) return json({ users: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: session.email, name: 'Jean Test', role: session.role });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Inbox : le menu de dossiers', () => {
  test('🔴 les quatre dossiers portent leur compteur, Y COMPRIS à zéro', async ({ page }) => {
    await mock(page, ADMIN);
    await page.goto('/inbox');
    await expect(page.getByTestId('dossier-n-toutes')).toHaveText('(2)');
    await expect(page.getByTestId('dossier-n-aTraiter')).toHaveText('(1)');
    // Le cas qui compte : « Signalé (0) » dit « rien à relire », un libellé nu ferait aller voir.
    await expect(page.getByTestId('dossier-n-signalees')).toHaveText('(0)');
    await expect(page.getByTestId('dossier-n-archivees')).toHaveText('(3)');
  });

  test('🔴 changer de dossier demande le BON filtre au serveur', async ({ page }) => {
    // Une régression ici serait invisible : la liste se rechargerait, elle montrerait le mauvais contenu.
    const appels: Appel[] = [];
    await mock(page, ADMIN, appels);
    await page.goto('/inbox');
    await page.getByTestId('dossier-archivees').click();
    await expect.poll(() => appels.some((a) => /\/conversations\?.*archivees=1/.test(a.url)), { timeout: 5000 }).toBe(true);

    await page.getByTestId('dossier-signalees').click();
    await expect.poll(() => appels.some((a) => /\/conversations\?.*signalees=1/.test(a.url)), { timeout: 5000 }).toBe(true);
  });

  test('un dossier de MEMBRE filtre sur son affectation', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, ADMIN, appels);
    await page.goto('/inbox');
    await page.getByTestId('dossier-membre-u-jean').click();
    await expect.poll(() => appels.some((a) => /\/conversations\?.*affectee=u-jean/.test(a.url)), { timeout: 5000 }).toBe(true);
  });

  test('🔴 la charge par collaborateur liste ceux à ZÉRO', async ({ page }) => {
    // C'est ce qui répond à la question du manager : ne montrer que ceux qui ont du travail rendrait
    // invisible celui qu'on cherche précisément parce qu'il n'en a pas.
    await mock(page, ADMIN);
    await page.goto('/inbox');
    await expect(page.getByTestId('dossier-membre-u-marie')).toContainText('Marie');
    await expect(page.getByTestId('dossier-membre-u-marie')).toContainText('(0)');
    await expect(page.getByTestId('dossier-nonAffectees')).toContainText('(1)');
  });

  test('🔴 un OPÉRATEUR ne voit pas la charge de ses collègues', async ({ page }) => {
    await mock(page, OPERATEUR);
    await page.goto('/inbox');
    await expect(page.getByTestId('dossier-toutes')).toBeVisible();
    await expect(page.getByTestId('dossier-nonAffectees')).toHaveCount(0);
    await expect(page.getByTestId('dossier-membre-u-jean')).toHaveCount(0);
  });

  test('🔴 preuve inverse : un ADMIN la voit', async ({ page }) => {
    // Sans ce cas, masquer la section pour tout le monde passerait le test ci-dessus.
    await mock(page, ADMIN);
    await page.goto('/inbox');
    await expect(page.getByTestId('dossier-nonAffectees')).toBeVisible();
    await expect(page.getByTestId('dossier-membre-u-jean')).toBeVisible();
  });

  test('🔴 archiver : la barre n’apparaît qu’avec une sélection, et poste bien l’archivage', async ({ page }) => {
    const appels: Appel[] = [];
    await mock(page, ADMIN, appels);
    await page.goto('/inbox');
    // Rien de coché : pas de barre. Une barre permanente prendrait une place au-dessus de la liste pour un
    // geste qu'on fait rarement.
    await expect(page.getByTestId('inbox-archiver')).toHaveCount(0);

    await page.getByTestId('cocher-c1').check();
    await expect(page.getByTestId('inbox-archiver')).toBeVisible();
    await page.getByTestId('inbox-archiver').click();
    await expect.poll(() => appels.some((a) => a.method === 'POST' && /\/conversations\/c1\/archive$/.test(a.url)), { timeout: 5000 }).toBe(true);
  });

  test('🔴 dans le dossier Archivé, le bouton DÉSARCHIVE', async ({ page }) => {
    // Le même bouton avec le sens inverse : sans ce cas, un bouton qui archiverait toujours viderait le
    // dossier Archivé au lieu de le remplir, et le test précédent passerait quand même.
    const appels: Appel[] = [];
    await mock(page, ADMIN, appels);
    await page.goto('/inbox');
    await page.getByTestId('dossier-archivees').click();
    await page.getByTestId('cocher-c1').check();
    await expect(page.getByTestId('inbox-archiver')).toHaveText(/Désarchiver|Unarchive/);
    await page.getByTestId('inbox-archiver').click();
    await expect.poll(() => appels.some((a) => a.method === 'POST' && /\/conversations\/c1\/unarchive$/.test(a.url)), { timeout: 5000 }).toBe(true);
  });

  test('changer de dossier VIDE la sélection', async ({ page }) => {
    // Garder des lignes cochées dans un dossier qu'on ne regarde plus ferait archiver ce qu'on ne voit pas.
    await mock(page, ADMIN);
    await page.goto('/inbox');
    await page.getByTestId('cocher-c1').check();
    await expect(page.getByTestId('inbox-archiver')).toBeVisible();
    await page.getByTestId('dossier-aTraiter').click();
    await expect(page.getByTestId('inbox-archiver')).toHaveCount(0);
  });

  test('🔴 les anciens boutons de filtre ont DISPARU', async ({ page }) => {
    // Deux endroits pour le même choix, ce sont deux états qui divergent. Le dépôt l'a déjà payé sur le
    // contrôle du fil : le menu REMPLACE les boutons, il ne s'y ajoute pas.
    await mock(page, ADMIN);
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox-filter-todo')).toHaveCount(0);
    await expect(page.getByTestId('inbox-filter-flagged')).toHaveCount(0);
  });
});
