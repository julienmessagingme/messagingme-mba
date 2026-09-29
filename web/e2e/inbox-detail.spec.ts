import { test, expect, type Page } from '@playwright/test';

/**
 * LE PANNEAU DÉTAIL DE L'INBOX (cadrage du 2026-09-28) : la moitié basse de la colonne des conversations.
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI. La route est tenue par `tests/http-inbox.test.ts`, ses
 * requêtes par un test d'intégration, les phrases de la frise par `web/lib/inbox-detail.test.ts`. Reste ce qui se
 * décide à l'écran : que le panneau APPARAISSE à la sélection, dans le bon ordre, qu'il se RELISE après un geste
 * de l'en-tête, que son repli SURVIVE au rechargement, et qu'une route absente ne laisse ni trou ni erreur (la
 * console part sur Vercel au push, avant l'API).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONV = {
  id: 'c1', waId: '33600000001', profileName: 'Léa Durand', lastPreview: 'bonjour',
  lastMessageAt: '2026-09-28T10:00:00Z', controlOwner: 'app_human', unread: false,
  curseur: '2026-09-28T10:00:00Z', signaleeMain: false,
};

const DETAIL = {
  conversationId: 'c1',
  identite: {
    contactId: 'ct1', waId: '33600000001', nom: 'Durand', prenom: 'Léa', telephone: '+33600000001',
    email: 'lea@exemple.fr', tags: ['vip', 'salon'], desabonne: true, bloque: false,
  },
  resume: 'Demande les horaires du samedi.',
  assignation: { userId: 'u2', nom: 'Jean' },
  // Du plus récent au plus ancien, comme le serveur les rend.
  historique: [
    { id: '3', type: 'assignee', at: '2026-09-28T11:00:00Z', acteur: { nom: 'Alice' }, cible: { nom: 'Jean' }, cause: null, reassignation: true },
    { id: '2', type: 'rouverte', at: '2026-09-28T10:30:00Z', acteur: null, cible: null, cause: 'message du contact', reassignation: false },
    { id: '1', type: 'assignee', at: '2026-09-27T09:00:00Z', acteur: null, cible: { nom: 'Marie' }, cause: 'automatique : campagne Rentrée', reassignation: false },
  ],
};

async function monter(page: Page, opts: { detail?: unknown; statut?: number; appels?: string[] } = {}) {
  const appels = opts.appels ?? [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push(`${req.method()} ${url}`);
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/conversations\/c1\/detail$/.test(url)) {
      return opts.statut ? json({ error: 'Not Found' }, opts.statut) : json(opts.detail ?? DETAIL);
    }
    if (/\/conversations\/counts/.test(url)) return json({ tout: 1, aTraiter: 0, signalees: 0, archivees: 0, nonAffectees: 0, parMembre: [] });
    if (/\/(archive|unarchive|traiter|ne-plus-traiter|signaler|ne-plus-signaler)$/.test(url)) return json({ ok: true });
    if (url.endsWith('/c1/messages') || url.includes('/c1/messages?')) {
      return json({ messages: [], windowOpen: true, controlOwner: 'app_human', waId: CONV.waId, lastInboundAt: null });
    }
    if (/\/conversations\?|\/conversations$/.test(url)) return json({ conversations: [CONV] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Alice', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  return appels;
}

const ouvrir = (page: Page) => page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();

test.describe('Inbox : le panneau Détail', () => {
  test('🔴 rien avant la sélection, puis identité, badges, résumé et assignation', async ({ page }) => {
    await monter(page);
    await expect(page.getByTestId('inbox-ligne-c1')).toBeVisible();
    await expect(page.getByTestId('inbox-detail')).toHaveCount(0);
    await ouvrir(page);
    const identite = page.getByTestId('inbox-detail-identite');
    await expect(identite).toContainText('Léa Durand');
    await expect(identite).toContainText('+33600000001');
    await expect(identite).toContainText('lea@exemple.fr');
    await expect(identite).toContainText('vip');
    await expect(page.getByTestId('inbox-detail-desabonne')).toBeVisible();
    await expect(page.getByTestId('inbox-detail-bloque')).toHaveCount(0);
    await expect(page.getByTestId('inbox-detail-resume')).toHaveText('Demande les horaires du samedi.');
    await expect(page.getByTestId('inbox-detail-assignation')).toHaveText('Assignée à Jean');
  });

  test('« pas encore analysée » quand le résumé manque, et « non affectée »', async ({ page }) => {
    await monter(page, { detail: { ...DETAIL, resume: null, assignation: null } });
    await ouvrir(page);
    await expect(page.getByTestId('inbox-detail-resume')).toHaveText('Pas encore analysée.');
    await expect(page.getByTestId('inbox-detail-assignation')).toHaveText('Non affectée');
  });

  test('🔴 la frise dans l’ordre, du plus récent au plus ancien, avec qui ou quoi', async ({ page }) => {
    await monter(page);
    await ouvrir(page);
    const lignes = page.getByTestId('inbox-detail-evenement');
    await expect(lignes).toHaveCount(3);
    await expect(lignes.nth(0)).toContainText('Réassignée à Jean');
    await expect(lignes.nth(0)).toContainText('par Alice');
    await expect(lignes.nth(1)).toContainText('Rouverte');
    await expect(lignes.nth(1)).toContainText('message du contact');
    await expect(lignes.nth(2)).toContainText('Assignée à Marie');
    await expect(lignes.nth(2)).toContainText('automatique : campagne Rentrée');
  });

  test('« Ouvrir la fiche » ouvre la fiche du contact à droite', async ({ page }) => {
    await monter(page);
    await ouvrir(page);
    await page.getByTestId('inbox-detail-fiche').click();
    await expect(page.getByTestId('inbox-contact-panel')).toBeVisible();
  });

  test('🔴 un geste de l’en-tête relit le détail', async ({ page }) => {
    const appels = await monter(page);
    await ouvrir(page);
    await expect(page.getByTestId('inbox-detail-frise')).toBeVisible();
    const lectures = () => appels.filter((a) => /GET .*\/c1\/detail$/.test(a)).length;
    const avant = lectures();
    await page.getByTestId('ranger-dans').selectOption('archiver');
    await expect.poll(lectures, { timeout: 10_000 }).toBeGreaterThan(avant);
  });

  test('🔴 un rangement EN LOT qui contient la conversation ouverte relit aussi le détail', async ({ page }) => {
    // Relecture du 2026-09-29 : seul l'en-tête du fil prévenait le panneau. Archiver la sélection laissait la frise
    // sans l'archivage qu'on venait de faire.
    const appels = await monter(page);
    await ouvrir(page);
    await expect(page.getByTestId('inbox-detail-frise')).toBeVisible();
    const lectures = () => appels.filter((a) => /GET .*\/c1\/detail$/.test(a)).length;
    const avant = lectures();
    await page.getByTestId('cocher-c1').check();
    await page.getByTestId('inbox-ranger-selection').selectOption('archiver');
    await expect.poll(() => appels.some((a) => /POST .*\/c1\/archive$/.test(a)), { timeout: 10_000 }).toBe(true);
    await expect.poll(lectures, { timeout: 10_000 }).toBeGreaterThan(avant);
  });

  test('une PRISE se lit « Prise en charge », par qui', async ({ page }) => {
    await monter(page, { detail: { ...DETAIL, historique: [
      { id: '9', type: 'assignee', at: '2026-09-28T12:00:00Z', acteur: { nom: 'Jean' }, cible: { nom: 'Jean' }, cause: null, reassignation: false, prise: true },
    ] } });
    await ouvrir(page);
    const ligne = page.getByTestId('inbox-detail-evenement').first();
    await expect(ligne).toContainText('Prise en charge');
    await expect(ligne).toContainText('par Jean');
  });

  test('🔴 le repli est retenu au rechargement, et se défait', async ({ page }) => {
    await monter(page);
    await ouvrir(page);
    await expect(page.getByTestId('inbox-detail-frise')).toBeVisible();
    await page.getByTestId('inbox-detail-basculer').click();
    await expect(page.getByTestId('inbox-detail')).toHaveAttribute('data-replie', 'oui');
    await expect(page.getByTestId('inbox-detail-frise')).toHaveCount(0);
    await page.reload();
    await ouvrir(page);
    await expect(page.getByTestId('inbox-detail')).toHaveAttribute('data-replie', 'oui');
    await page.getByTestId('inbox-detail-basculer').click();
    await expect(page.getByTestId('inbox-detail-frise')).toBeVisible();
  });

  test('🔴 moitié-moitié, et une frise longue défile DANS le panneau sans déborder de la colonne', async ({ page }) => {
    const longue = Array.from({ length: 50 }, (_, i) => ({
      id: String(100 - i), type: i % 2 ? 'archivee' : 'desarchivee', at: '2026-09-28T10:00:00Z',
      acteur: { nom: 'Alice' }, cible: null, cause: null, reassignation: false,
    }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await monter(page, { detail: { ...DETAIL, historique: longue } });
    await ouvrir(page);
    await expect(page.getByTestId('inbox-detail-evenement')).toHaveCount(50);
    const colonne = await page.getByTestId('inbox-liste').boundingBox();
    const panneau = await page.getByTestId('inbox-detail').boundingBox();
    const liste = await page.getByTestId('inbox-liste').locator('ul').first().boundingBox();
    expect(colonne && panneau && liste).toBeTruthy();
    // Le panneau reste dans la colonne : sa frise défile, elle ne pousse rien hors de l'écran.
    expect(panneau!.y + panneau!.height).toBeLessThanOrEqual(colonne!.y + colonne!.height + 1);
    // Moitié-moitié, à la marge près.
    const part = liste!.height / (liste!.height + panneau!.height);
    expect(part).toBeGreaterThan(0.35);
    expect(part).toBeLessThan(0.65);
    const corps = page.getByTestId('inbox-detail-corps');
    expect(await corps.evaluate((n) => n.scrollHeight > n.clientHeight)).toBe(true);
  });

  test('🔴 une route absente (404) : aucun panneau, aucune erreur, la liste garde la colonne', async ({ page }) => {
    await monter(page, { statut: 404 });
    await ouvrir(page);
    await expect(page.getByTestId('fil-messages')).toBeVisible();
    await expect(page.getByTestId('inbox-detail')).toHaveCount(0);
    await expect(page.getByTestId('inbox-ligne-c1')).toBeVisible();
    // Aucun bandeau d'erreur dans la colonne : le panneau est un complément, son absence n'est pas une panne.
    await expect(page.getByTestId('inbox-liste').locator('.bg-danger-50')).toHaveCount(0);
  });

  test('une réponse mal formée se replie de même', async ({ page }) => {
    // Une API plus ancienne rendrait un corps quelconque sous une route attrapée ailleurs : pas un panneau vide.
    await monter(page, { detail: {} });
    await ouvrir(page);
    await expect(page.getByTestId('fil-messages')).toBeVisible();
    await expect(page.getByTestId('inbox-detail')).toHaveCount(0);
  });
});
