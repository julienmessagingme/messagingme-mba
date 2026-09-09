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
async function destinations(page: import('@playwright/test').Page, testid = 'ranger-dans'): Promise<string[]> {
  const tous = await page.getByTestId(testid).locator('option').allTextContents();
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

/**
 * RANGER UNE SÉLECTION (2026-09-09, seconde demande de Julien le même jour).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI, et c'est DIFFÉRENT du menu ci-dessus. Une sélection
 * est HÉTÉROGÈNE : ses destinations se déduisent du DOSSIER, pas de l'état de chaque ligne. Le choix des
 * options est tenu par `tests/web-inbox-rangement.test.ts` (module pur) ; ce qui se joue ici, c'est le
 * CÂBLAGE : que le geste parte pour CHAQUE ligne cochée, et pour elles seules.
 */
const DEUX = [
  { ...CONV, id: 'c1', waId: '33600000001', profileName: 'Alice' },
  { ...CONV, id: 'c2', waId: '33600000002', profileName: 'Bruno' },
];

async function monterListe(page: import('@playwright/test').Page, opts: {
  dossier?: string; conversations?: typeof DEUX; appels?: string[];
} = {}) {
  const appels = opts.appels ?? [];
  const liste = opts.conversations ?? DEUX;
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push(`${req.method()} ${url}`);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/conversations\/counts/.test(url)) return json({ ...COMPTEURS, tout: liste.length });
    if (/\/(signaler|ne-plus-signaler)$/.test(url)) return json({ signalee: true });
    if (/\/prendre$/.test(url)) return json({ controlOwner: 'app_human' });
    if (/\/(archive|unarchive)$/.test(url)) return json({ archived: true });
    if (/\/conversations\?|\/conversations$/.test(url)) return json({ conversations: liste });
    if (url.includes('/users')) return json({ users: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  if (opts.dossier) await page.getByTestId(`dossier-${opts.dossier}`).click();
  for (const c of liste) await page.getByTestId(`cocher-${c.id}`).check();
  await page.getByTestId('inbox-ranger-selection').waitFor();
  return appels;
}

/**
 * 🔴 ATTENDRE LA FIN DU GESTE AVANT DE COMPTER LES APPELS, et c'est une leçon PAYÉE.
 *
 * Ces tests comptaient d'abord avec `expect.poll(...).toBe(1)` juste après le clic. Les rangements partent
 * SÉQUENTIELLEMENT : le compteur passe par 1 avant d'atteindre 2, et un `poll` s'arrête à la première
 * évaluation vraie. L'assertion passait donc AUSSI sur du code sans filtrage, qui postait sur les deux
 * lignes. Vérifié par mutation : douze tests sur douze au vert avec le défaut en place.
 *
 * La barre disparaît quand le rangement est TERMINÉ (la sélection est vidée à la fin, pas avant) : c'est le
 * seul instant où compter a un sens, et le compte est alors FIGÉ, donc `expect` et non `expect.poll`.
 */
async function finDuRangement(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByTestId('inbox-ranger-selection')).toHaveCount(0, { timeout: 10_000 });
}

test.describe('Inbox : ranger une SÉLECTION', () => {
  test('🔴 le menu offre les trois destinations, là où il n’y avait que « Archiver »', async ({ page }) => {
    await monterListe(page);
    expect(await destinations(page, 'inbox-ranger-selection')).toEqual(['À traiter', 'Signalé', 'Archivé']);
  });

  test('🔴 le geste part pour CHAQUE ligne cochée, pas seulement la première', async ({ page }) => {
    // La garde du câblage : une boucle qui sortirait au premier tour, ou un appel posé hors boucle, passerait
    // un test qui se contente de vérifier qu'« un » appel est parti.
    const appels = await monterListe(page);
    await page.getByTestId('inbox-ranger-selection').selectOption('a-traiter');
    await finDuRangement(page);
    expect(appels.filter((a) => /POST .*\/prendre$/.test(a)).length).toBe(2);
    expect(appels.some((a) => /POST .*\/c1\/prendre$/.test(a))).toBe(true);
    expect(appels.some((a) => /POST .*\/c2\/prendre$/.test(a))).toBe(true);
  });

  test('🔴 depuis « Signalé », « Ne plus signaler » est ABSENT quand seul le MODÈLE a signalé', async ({ page }) => {
    // Le constat de l'analyse n'est pas effaçable à la main : proposer le geste ferait cliquer deux fois
    // avant de conclure que l'écran est cassé. C'est la même règle que sur la conversation ouverte.
    await monterListe(page, { dossier: 'signalees' });
    const dest = await destinations(page, 'inbox-ranger-selection');
    expect(dest).not.toContain('Ne plus signaler');
    expect(dest).not.toContain('Signalé');
  });

  test('🔴 sélection MIXTE : le geste ne part que sur la ligne signalée à la main', async ({ page }) => {
    // La preuve inverse du cas précédent, ET la garde du filtrage. Sans elle, « ne plus signaler » partirait
    // aussi sur la ligne du modèle : l'appel réussirait, la ligne resterait dans le dossier, et on aurait
    // écrit pour rien.
    const mixte = [{ ...DEUX[0], signaleeMain: true }, { ...DEUX[1], signaleeMain: false }];
    const appels = await monterListe(page, { dossier: 'signalees', conversations: mixte });
    expect(await destinations(page, 'inbox-ranger-selection')).toContain('Ne plus signaler');

    await page.getByTestId('inbox-ranger-selection').selectOption('ne-plus-signaler');
    await finDuRangement(page);
    expect(appels.filter((a) => /POST .*\/ne-plus-signaler$/.test(a)).length).toBe(1);
    expect(appels.some((a) => /POST .*\/c1\/ne-plus-signaler$/.test(a))).toBe(true);
    expect(appels.some((a) => /POST .*\/c2\/ne-plus-signaler$/.test(a))).toBe(false);
  });

  test('le menu de la sélection retombe lui aussi sur son libellé', async ({ page }) => {
    await monterListe(page);
    await page.getByTestId('inbox-ranger-selection').selectOption('signaler');
    await expect(page.getByTestId('inbox-ranger-selection')).toHaveValue('');
  });
});
