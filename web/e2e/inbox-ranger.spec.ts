import { test, expect } from '@playwright/test';

/**
 * RANGER LA CONVERSATION OUVERTE dans un dossier (2026-09-09, demande de Julien).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI. Les routes sont tenues par `tests/http-inbox.test.ts`
 * et l'union SQL par un test d'intégration. Ce qui reste est la seule chose qui se décide À L'ÉCRAN : QUELLES
 * destinations sont proposées, et quand. Un menu qui les offre toutes en permanence passerait tous les autres
 * tests tout en proposant de ranger une conversation là où elle est déjà.
 *
 * ⚠️ Le point le plus délicat : « À traiter » et le bouton « Rendre la main » sont les deux moitiés d'une
 * BASCULE. Ils ne doivent jamais être visibles ensemble, sinon l'écran offre deux fois le même choix, et le
 * dépôt a déjà payé ce défaut sur le contrôle du fil.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONV = {
  id: 'c1', waId: '33600000001', profileName: 'Alice', lastPreview: 'bonjour',
  lastMessageAt: '2026-09-09T10:00:00Z', controlOwner: 'app_workflow', unread: false,
  curseur: '2026-09-09T10:00:00Z', signaleeMain: false,
};
const THREAD = { messages: [], windowOpen: true, controlOwner: 'app_workflow' };
const COMPTEURS = { tout: 1, aTraiter: 0, signalees: 0, archivees: 0, nonAffectees: 1, parMembre: [] };

async function monter(page: import('@playwright/test').Page, opts: {
  controlOwner?: string; signaleeMain?: boolean; dossier?: string; appels?: string[];
} = {}) {
  const appels = opts.appels ?? [];
  const owner = opts.controlOwner ?? 'app_workflow';
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push(`${req.method()} ${url}`);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/conversations\/counts/.test(url)) return json(COMPTEURS);
    if (/\/(signaler|ne-plus-signaler)$/.test(url)) return json({ signalee: true });
    if (/\/prendre$/.test(url)) return json({ controlOwner: 'app_human' });
    if (/\/(archive|unarchive)$/.test(url)) return json({ archived: true });
    if (url.endsWith('/c1/messages')) return json({ ...THREAD, controlOwner: owner });
    if (/\/conversations\?|\/conversations$/.test(url)) {
      return json({ conversations: [{ ...CONV, controlOwner: owner, signaleeMain: opts.signaleeMain === true }] });
    }
    if (url.includes('/users')) return json({ users: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  if (opts.dossier) await page.getByTestId(`dossier-${opts.dossier}`).click();
  await page.getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).first().click();
  await page.getByTestId('ranger-dans').waitFor();
  return appels;
}

/** Les libellés réellement proposés, sans l'entrée-titre du menu. */
async function destinations(page: import('@playwright/test').Page): Promise<string[]> {
  const tous = await page.getByTestId('ranger-dans').locator('option').allTextContents();
  return tous.slice(1);
}

test.describe('Inbox : ranger la conversation ouverte', () => {
  test('🔴 le scénario tient le fil : « À traiter » est proposé, et le bouton « Rendre la main » est ABSENT', async ({ page }) => {
    const appels = await monter(page);
    expect(await destinations(page)).toEqual(['À traiter', 'Signalé', 'Archivé']);
    await expect(page.getByTestId('inbox-rendre-la-main')).toHaveCount(0);

    await page.getByTestId('ranger-dans').selectOption('a-traiter');
    await expect.poll(() => appels.filter((a) => /POST .*\/prendre$/.test(a)).length, { timeout: 10_000 }).toBe(1);
  });

  test('🔴 un opérateur tient le fil : « À traiter » DISPARAÎT du menu, le bouton prend le relais', async ({ page }) => {
    // La preuve inverse, et c'est elle qui empêche les deux endroits pour le même choix : sans elle, un menu
    // qui proposerait toujours « À traiter » passerait le cas ci-dessus.
    await monter(page, { controlOwner: 'app_human' });
    expect(await destinations(page)).toEqual(['Signalé', 'Archivé']);
    await expect(page.getByTestId('inbox-rendre-la-main')).toBeVisible();
  });

  test('🔴 le menu DIT si le signalement est manuel, il ne le devine pas', async ({ page }) => {
    // Sur une conversation signalée par le MODÈLE, `signaleeMain` reste faux et l'écran propose « Signalé »,
    // pas « Ne plus signaler » : ce dernier n'aurait aucun effet visible, et l'opérateur cliquerait deux fois
    // avant de conclure que l'écran est cassé.
    await monter(page, { signaleeMain: true });
    expect(await destinations(page)).toContain('Ne plus signaler');
    expect(await destinations(page)).not.toContain('Signalé');
  });

  test('signaler poste sur la bonne adresse', async ({ page }) => {
    const appels = await monter(page);
    await page.getByTestId('ranger-dans').selectOption('signaler');
    await expect.poll(() => appels.filter((a) => /POST .*\/signaler$/.test(a)).length, { timeout: 10_000 }).toBe(1);
  });

  test('🔴 depuis le dossier Archivé, le menu propose DÉSARCHIVER, pas archiver', async ({ page }) => {
    const appels = await monter(page, { dossier: 'archivees' });
    expect(await destinations(page)).toContain('Désarchiver');
    expect(await destinations(page)).not.toContain('Archivé');

    await page.getByTestId('ranger-dans').selectOption('desarchiver');
    await expect.poll(() => appels.filter((a) => /POST .*\/unarchive$/.test(a)).length, { timeout: 10_000 }).toBe(1);
  });

  test('archiver depuis la conversation ouverte, sans repasser par la liste', async ({ page }) => {
    // Le geste existait, mais SEULEMENT en cochant une case dans la liste : sur la conversation ouverte, il
    // fallait revenir en arrière pour ranger ce qu'on venait de finir de lire.
    const appels = await monter(page);
    await page.getByTestId('ranger-dans').selectOption('archiver');
    await expect.poll(() => appels.filter((a) => /POST .*\/archive$/.test(a)).length, { timeout: 10_000 }).toBe(1);
  });

  test('le menu retombe TOUJOURS sur son libellé : il déclenche une action, il ne porte pas un état', async ({ page }) => {
    // Laisser l'option choisie affichée ferait croire à un réglage, et re-choisir la même ne ferait rien.
    await monter(page);
    await page.getByTestId('ranger-dans').selectOption('signaler');
    await expect(page.getByTestId('ranger-dans')).toHaveValue('');
  });
});
