import { test, expect, type Page } from '@playwright/test';

/**
 * « /brancher » (lot 3c, livraison A) : la page de connexion du numéro que Claude Code ouvre par un lien, SANS la
 * console. Le jeton du lien voyage après le `#` ; la page le garde dans l'onglet, l'efface de l'adresse, et l'envoie
 * en Bearer sur chaque appel. Le serveur est simulé : ce qui est vérifié ici, c'est ce que la page envoie et affiche.
 */
const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';

/** Un jeton à la forme d'un JWT : la page lit l'espace et le mode dans sa charge, le serveur (simulé ici) le vérifie. */
function jeton(mode: 'fourni' | 'apporte' = 'fourni'): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ kind: 'lien_numero', tenantId: TENANT, userId: 'u-1', mode, exp: 4102444800 })}.signature`;
}

/** Le serveur de la page : le numéro fourni, la fenêtre de Meta et l'état. Chaque en-tête Authorization est gardé. */
async function simuler(page: Page, o: { refus401?: boolean; connecte?: boolean; lecturesAvantCode?: number } = {}) {
  const s = { numero: null as string | null, lectures: 0, autorisations: [] as string[], connecte: o.connecte === true };
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    s.autorisations.push(req.headers().authorization ?? '(aucune)');
    if (o.refus401) return route.fulfill(json({ error: 'lien révoqué : redemandez-en un à Claude' }, 401));
    if (chemin.endsWith('/embedded-signup/config')) return route.fulfill(json({ enabled: true, appId: 'app-e2e', configId: 'cfg-e2e', graphVersion: 'v25.0' }));
    if (chemin.endsWith('/connexion-numero')) {
      return route.fulfill(json({ etat: { fourni: s.numero, code: null, connecte: s.connecte ? { chiffres: '441235619343' } : null }, empreinte: '0123456789abcdef' }));
    }
    if (req.method() === 'POST' && chemin.endsWith('/numero-fourni')) {
      s.numero = '+441235619343';
      return route.fulfill(json({ numero: s.numero }));
    }
    if (req.method() === 'GET' && chemin.endsWith('/numero-fourni')) {
      if (s.numero === null) return route.fulfill(json({ numero: null, code: null, codeRecuLe: null }));
      s.lectures += 1;
      const code = s.lectures > (o.lecturesAvantCode ?? 1) ? '345679' : null;
      return route.fulfill(json({ numero: s.numero, code, codeRecuLe: code ? '2026-10-06T10:00:00.000Z' : null }));
    }
    return route.fulfill(json({ error: `route non simulée : ${chemin}` }, 404));
  });
  return s;
}

test('🔴 le jeton est lu, effacé de l’adresse, et part en Bearer sur CHAQUE appel', async ({ page }) => {
  const s = await simuler(page);
  const j = jeton();
  await page.goto(`/brancher#${j}`);
  await expect(page.getByTestId('choix-fourni-ouvert')).toBeVisible();
  await expect(page).toHaveURL(/\/brancher$/);
  expect(s.autorisations.length).toBeGreaterThan(0);
  expect(new Set(s.autorisations)).toEqual(new Set([`Bearer ${j}`]));
});

test('🔴 un navigateur qui porte AUSSI une session de la console : seul le jeton du lien part', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('mba.session', JSON.stringify({ token: 'session-de-la-console', tenantId: 'autre', role: 'admin', email: 'x@e2e.test' }));
  });
  const s = await simuler(page);
  const j = jeton();
  await page.goto(`/brancher#${j}`);
  await page.getByTestId('obtenir-numero').click();
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343');
  expect(s.autorisations).not.toContain('Bearer session-de-la-console');
  expect(new Set(s.autorisations)).toEqual(new Set([`Bearer ${j}`]));
});

test('le parcours fourni : le numéro, puis le code capté, sans rien recharger', async ({ page }) => {
  await simuler(page, { lecturesAvantCode: 1 });
  await page.goto(`/brancher#${jeton('fourni')}`);
  await page.getByTestId('obtenir-numero').click();
  await expect(page.getByTestId('numero-fourni')).toHaveText('+441235619343');
  await expect(page.getByTestId('code-capte')).toContainText('345679', { timeout: 12_000 });
  await expect(page.getByTestId('ouvrir-fenetre-meta')).toBeEnabled();
});

test('le mode apporté ouvre directement la fenêtre de Meta', async ({ page }) => {
  await simuler(page);
  await page.goto(`/brancher#${jeton('apporte')}`);
  await expect(page.getByTestId('ouvrir-fenetre-meta')).toBeVisible();
  await expect(page.getByTestId('obtenir-numero')).toHaveCount(0);
});

test('un rechargement sans le # garde le jeton de l’onglet', async ({ page }) => {
  const s = await simuler(page);
  const j = jeton();
  await page.goto(`/brancher#${j}`);
  await expect(page.getByTestId('choix-fourni-ouvert')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('choix-fourni-ouvert')).toBeVisible();
  expect(new Set(s.autorisations)).toEqual(new Set([`Bearer ${j}`]));
});

test('numéro connecté : retourner dans Claude Code', async ({ page }) => {
  await simuler(page, { connecte: true });
  await page.goto(`/brancher#${jeton()}`);
  await expect(page.getByTestId('brancher-connecte')).toContainText('Claude Code');
});

test('sans jeton : redemander le lien à Claude, et aucun appel', async ({ page }) => {
  const s = await simuler(page);
  await page.goto('/brancher');
  await expect(page.getByTestId('brancher-sans-lien')).toContainText('Claude');
  expect(s.autorisations).toEqual([]);
});

test('lien refusé par le serveur (401) : redemander le lien à Claude', async ({ page }) => {
  await simuler(page, { refus401: true });
  await page.goto(`/brancher#${jeton()}`);
  await expect(page.getByTestId('brancher-sans-lien')).toContainText('Claude');
});
