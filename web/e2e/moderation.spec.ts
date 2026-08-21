import { test, expect } from '@playwright/test';

/**
 * Modération : signaler, bloquer, et surtout DÉBLOQUER.
 *
 * Le test qui compte le plus ici est celui de la porte de sortie. Un contact bloqué disparaît de l'inbox et
 * n'est plus joignable : si l'écran des paramètres ne le retrouvait pas, il serait perdu pour de bon.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(
  page: import('@playwright/test').Page,
  bloques: Array<Record<string, unknown>> = [],
  /** Conversations rendues en mode « signalées ». Vide = éprouver le message d'attente. */
  signaleesRendues: Array<Record<string, unknown>> | null = null,
) {
  const urls: string[] = [];
  const patches: Array<{ url: string; body: unknown }> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const chemin = url.split('?')[0]!;
    const method = route.request().method();
    urls.push(url);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

    if (chemin.endsWith('/contacts/blocked')) return json({ contacts: bloques });
    if (chemin.endsWith('/blocked') && method === 'PATCH') {
      patches.push({ url, body: route.request().postDataJSON() });
      // Débloquer retire de la liste : c'est ce que l'écran doit refléter après l'action.
      const id = chemin.split('/').slice(-2)[0]!;
      const i = bloques.findIndex((b) => b.id === id);
      if (i >= 0) bloques.splice(i, 1);
      return json({ contactId: id, blocked: false });
    }
    if (chemin.endsWith('/conversations/todo-count')) return json({ count: 0 });
    if (chemin.endsWith('/conversations')) {
      // Le faux serveur APPLIQUE le filtre : sinon on ne testerait que l'affichage.
      const signalees = new URL(url).searchParams.get('signalees') === '1';
      if (!signalees) return json({ conversations: [] });
      return json({ conversations: signaleesRendues ?? [{ id: 'c9', waId: '33699', profileName: 'Client Injurieux', lastMessageAt: '2026-08-21T10:00:00Z', controlOwner: 'app_human' }] });
    }
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (chemin.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    if (chemin.endsWith('/audit')) return json({ entries: [] });
    return json({});
  });
  return { urls, patches };
}

test.describe('Modération', () => {
  test('l’onglet « Signalées » demande le filtre au SERVEUR', async ({ page }) => {
    // Le constat vient de l'analyse, en base : le navigateur ne peut pas le déduire des conversations
    // chargées. S'il filtrait localement, l'onglet serait vide en permanence.
    const { urls } = await mock(page);
    await page.goto('/inbox');
    await page.getByTestId('inbox-filter-flagged').click();
    await expect.poll(() => urls.some((u) => u.includes('signalees=1')), { timeout: 15_000 }).toBe(true);
    await expect(page.getByText('Client Injurieux')).toBeVisible();
  });

  test('l’onglet VIDE explique le délai, au lieu de laisser croire à une erreur', async ({ page }) => {
    // Rien à signaler est le cas NORMAL. Sans explication, on croirait la fonctionnalité cassée, alors que
    // l'analyse tourne simplement 15 min après le dernier message.
    await mock(page, [], []);
    await page.goto('/inbox');
    await page.getByTestId('inbox-filter-flagged').click();
    await expect(page.getByText(/Aucune conversation signalée|No flagged conversation/)).toBeVisible();
    await expect(page.getByText(/15 min/)).toBeVisible();
  });

  test('🔴 un contact bloqué se retrouve dans les paramètres et se débloque', async ({ page }) => {
    // LA garantie du lot : sans cet écran, un contact bloqué, invisible dans l'inbox et injoignable par
    // campagne, n'aurait plus aucun moyen de revenir.
    const { patches } = await mock(page, [
      { id: 'ct9', profileName: 'Client Injurieux', phoneE164: '+33699999999', blockedAt: '2026-08-21T09:00:00.000Z' },
    ]);
    await page.goto('/parametres');
    const bloc = page.getByTestId('blocked-contacts');
    await expect(bloc).toBeVisible();
    await expect(bloc).toContainText('Client Injurieux');

    await page.getByTestId('unblock-ct9').click();
    await expect.poll(() => patches.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(patches[0]?.body).toEqual({ blocked: false });
    // La liste se vide : l'écran reflète l'effet, il ne se contente pas d'envoyer la demande.
    await expect(page.getByTestId('blocked-contacts')).toHaveCount(0);
  });

  test('aucun contact bloqué -> pas de section vide dans les réglages', async ({ page }) => {
    await mock(page, []);
    await page.goto('/parametres');
    await expect(page.getByTestId('blocked-contacts')).toHaveCount(0);
  });
});
