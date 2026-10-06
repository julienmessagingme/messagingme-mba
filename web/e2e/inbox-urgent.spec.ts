import { test, expect } from '@playwright/test';

/**
 * LE STATUT « URGENT » D'UNE CONVERSATION (RC2, migration 0216, plan docs/superpowers/plans/2026-10-06-rc2-statut-urgent.md).
 *
 * 🔴 CE QUE SEUL UN TEST DE BOUT EN BOUT PEUT VOIR ICI. Les routes sont tenues par `tests/http-inbox.test.ts`, l'ordre
 * de « À traiter », sa pagination et le retrait par « Traité » par `tests/integration/inbox-urgent.integration.test.ts`.
 * Ce qui reste, c'est l'ÉCRAN : que le geste parte, que la liste rechargée mette la conversation au bon endroit avec sa
 * pastille, que le dossier et son compteur suivent, et que « Traité » la fasse sortir du dossier.
 *
 * ⚠️ Le faux serveur ci-dessous reproduit les trois règles du vrai (urgentes en tête de « À traiter », le dossier
 * « Urgent », « Traité » qui lève l'urgence) : sans cet état, l'écran rechargerait toujours la même liste et le test
 * ne prouverait rien du parcours.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

interface Conv {
  id: string; waId: string; profileName: string; lastPreview: string; lastMessageAt: string; curseur: string;
  controlOwner: string; unread: boolean; urgente: boolean; traitee: boolean;
}

async function monter(page: import('@playwright/test').Page, appels: string[] = []) {
  // Alice a écrit AUJOURD'HUI, Bruno il y a cinq jours : sans urgence, Alice passe devant dans « À traiter ».
  const convs: Conv[] = [
    { id: 'c-alice', waId: '33600000001', profileName: 'Alice', lastPreview: 'bonjour', lastMessageAt: '2026-10-06T10:00:00Z',
      curseur: '2026-10-06T10:00:00Z', controlOwner: 'app_human', unread: false, urgente: false, traitee: false },
    { id: 'c-bruno', waId: '33600000002', profileName: 'Bruno', lastPreview: 'ma commande n’est jamais arrivée', lastMessageAt: '2026-10-01T10:00:00Z',
      curseur: '2026-10-01T10:00:00Z', controlOwner: 'app_human', unread: false, urgente: false, traitee: false },
  ];
  const parDate = (a: Conv, b: Conv) => b.lastMessageAt.localeCompare(a.lastMessageAt);
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    appels.push(`${req.method()} ${url}`);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const geste = /\/conversations\/([^/?]+)\/(urgent|ne-plus-urgent|traiter|ne-plus-traiter)$/.exec(url.split('?')[0]!);
    if (req.method() === 'POST' && geste) {
      const c = convs.find((x) => x.id === geste[1]);
      if (!c) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"conversation inconnue"}' });
      if (geste[2] === 'urgent') c.urgente = true;
      if (geste[2] === 'ne-plus-urgent') c.urgente = false;
      // Le vrai serveur lève l'urgence dans la même requête que « Traité » (`basculerRangement`).
      if (geste[2] === 'traiter') { c.traitee = true; c.urgente = false; }
      if (geste[2] === 'ne-plus-traiter') c.traitee = false;
      return json({ ok: true });
    }
    if (/\/conversations\/counts/.test(url)) {
      return json({
        tout: convs.length, aTraiter: convs.filter((c) => !c.traitee).length, urgentes: convs.filter((c) => c.urgente).length,
        signalees: 0, archivees: 0, traitees: convs.filter((c) => c.traitee).length, nonAffectees: convs.length, parMembre: [],
      });
    }
    if (/\/conversations\/[^/]+\/messages/.test(url)) return json({ messages: [], windowOpen: true, controlOwner: 'app_human' });
    if (/\/conversations\/[^/]+\/detail/.test(url)) return json({});
    if (/\/conversations\?|\/conversations$/.test(url)) {
      const q = new URL(url).searchParams;
      let liste = [...convs];
      if (q.get('aTraiter') === '1') {
        liste = liste.filter((c) => !c.traitee).sort((a, b) => (Number(b.urgente) - Number(a.urgente)) || parDate(a, b));
      } else {
        liste.sort(parDate);
        if (q.get('urgentes') === '1') liste = liste.filter((c) => c.urgente);
        if (q.get('traitees') === '1') liste = liste.filter((c) => c.traitee);
      }
      return json({ conversations: liste.map((c) => ({ ...c })) });
    }
    if (url.includes('/users')) return json({ users: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/inbox');
  return appels;
}

/** Les identifiants des lignes affichées, dans l'ordre de la liste. */
async function ordre(page: import('@playwright/test').Page): Promise<string[]> {
  const ids = await page.locator('[data-testid^="inbox-ligne-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace('inbox-ligne-', ''));
}

test.describe('Inbox : le statut urgent', () => {
  test('🔴 marquer urgent, la retrouver dans « Urgent » et en tête de « À traiter », puis « Traité » la fait sortir', async ({ page }) => {
    const appels = await monter(page);

    // La situation de départ : dans « À traiter », la plus récente d'abord. Sans ce témoin, « elle passe devant » ne
    // prouverait rien.
    await page.getByTestId('dossier-aTraiter').click();
    await expect.poll(() => ordre(page), { timeout: 10_000 }).toEqual(['c-alice', 'c-bruno']);
    await expect(page.getByTestId('dossier-n-urgentes')).toHaveText('(0)');

    // Bruno écrit que sa commande n'est jamais arrivée : un opérateur la marque urgente depuis la conversation ouverte.
    await page.getByTestId('inbox-ligne-c-bruno').getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
    await page.getByTestId('ranger-dans').selectOption('urgent');
    await expect.poll(() => appels.some((a) => /POST .*\/c-bruno\/urgent$/.test(a)), { timeout: 10_000 }).toBe(true);

    // En tête de « À traiter », malgré ses cinq jours, avec la pastille rouge ; et l'en-tête du fil le dit aussi.
    await expect.poll(() => ordre(page), { timeout: 10_000 }).toEqual(['c-bruno', 'c-alice']);
    await expect(page.getByTestId('inbox-urgente-c-bruno')).toHaveText('Urgent');
    await expect(page.getByTestId('inbox-urgente-c-alice')).toHaveCount(0);
    await expect(page.getByTestId('thread-urgente')).toBeVisible();
    await expect(page.getByTestId('dossier-n-urgentes')).toHaveText('(1)');

    // Le dossier « Urgent » la montre, elle seule, et demande son filtre au serveur.
    await page.getByTestId('dossier-urgentes').click();
    await expect.poll(() => appels.some((a) => /\/conversations\?.*urgentes=1/.test(a)), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => ordre(page), { timeout: 10_000 }).toEqual(['c-bruno']);
    await expect(page.getByTestId('inbox-titre-dossier')).toHaveText('Urgent');

    // « Traité » lève l'urgence : elle quitte le dossier, et le compteur retombe.
    await page.getByTestId('ranger-dans').selectOption('traiter');
    await expect.poll(() => appels.some((a) => /POST .*\/c-bruno\/traiter$/.test(a)), { timeout: 10_000 }).toBe(true);
    await expect(page.getByTestId('inbox-ligne-c-bruno')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('dossier-n-urgentes')).toHaveText('(0)', { timeout: 10_000 });
    // Et dans « À traiter », qui exclut ce qui est traité, elle n'est plus là non plus.
    await page.getByTestId('dossier-aTraiter').click();
    await expect.poll(() => ordre(page), { timeout: 10_000 }).toEqual(['c-alice']);
  });

  test('🔴 « Charger plus » dans « À traiter » renvoie le RANG d’urgence de la dernière ligne', async ({ page }) => {
    // Sans lui, le serveur reprendrait la page suivante au mauvais endroit, à la frontière entre urgentes et non
    // urgentes. Une page pleine (50 lignes) est nécessaire pour que le bouton apparaisse.
    const appels: string[] = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`, waId: `3360000${String(i).padStart(4, '0')}`, profileName: `Contact ${i}`, lastPreview: 'x',
      lastMessageAt: '2026-10-01T10:00:00Z', curseur: `2026-10-01T10:00:00.0000${String(i).padStart(2, '0')}Z`,
      controlOwner: 'app_human', unread: false, urgente: true,
    }));
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      appels.push(url);
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/conversations\/counts/.test(url)) return json({ tout: 60, aTraiter: 60, urgentes: 50, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 60, parMembre: [] });
      if (/\/conversations\?|\/conversations$/.test(url)) {
        return json({ conversations: new URL(url).searchParams.has('beforeId') ? [] : page1 });
      }
      if (url.includes('/unread-count')) return json({ count: 0 });
      if (url.endsWith('/me')) return json({ email: SESSION.email, name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/inbox');
    await page.getByTestId('dossier-aTraiter').click();
    await page.getByTestId('inbox-load-more').click();
    await expect.poll(() => appels.find((u) => u.includes('beforeId=u49')) ?? '', { timeout: 10_000 }).toContain('beforeUrgente=1');
  });
});
