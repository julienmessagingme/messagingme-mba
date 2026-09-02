import { test, expect } from '@playwright/test';

/**
 * LE DÉFILEMENT DU FIL D'INBOX (lot 2 du plan post-audit, 2026-09-02).
 *
 * 🔴 Pourquoi en E2E et pas en test unitaire : le défaut était une histoire de GÉOMÉTRIE réelle (hauteurs,
 * position de défilement) dans un effet React, et l'arithmétique seule ne prouve pas que la page est câblée.
 * La règle pure, elle, est testée dans `lib/defilement-fil.test.ts` ; ici on regarde l'écran.
 *
 * Les deux symptômes que ces tests interdisent de revenir :
 *  - ouvrir une conversation LONGUE atterrissait sur le plus vieux message de l'historique ;
 *  - un message plus haut que la tolérance n'était pas suivi, le fil restait une bulle en arrière.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Fil Long', lastPreview: 'ok', lastMessageAt: '2026-08-15T10:00:00Z', controlOwner: 'app_human', unread: false },
];

/** Assez de bulles pour que le fil DÉBORDE : sans débordement, ces tests passeraient sans rien prouver. */
function historique(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    direction: i % 2 === 0 ? 'in' : 'out',
    type: 'text',
    body: `Message numero ${i}, assez long pour occuper de la hauteur dans le fil et le faire deborder de son cadre.`,
    buttonPayload: null,
    createdAt: new Date(Date.UTC(2026, 7, 15, 10, 0, i)).toISOString(),
    curseur: null,
  }));
}

/** Une bulle VOLONTAIREMENT haute : c'est sa hauteur qui déclenchait le défaut, au-delà des 80 px de tolérance. */
const MESSAGE_HAUT = {
  id: 'm-haut',
  direction: 'in',
  type: 'text',
  body: Array.from({ length: 12 }, (_, i) => `ligne ${i} d un message particulierement long qui occupe beaucoup de hauteur`).join('\n'),
  buttonPayload: null,
  createdAt: '2026-08-15T12:00:00Z',
  curseur: null,
};

/**
 * Backend intercepté, avec un INTERRUPTEUR : la bulle supplémentaire n'arrive que lorsque le test le décide.
 *
 * 🔴 Ce n'est pas un détail de confort. Une première version faisait arriver la bulle « au second tour de
 * rafraîchissement » : elle pouvait donc arriver AVANT que le test n'ait remonté le fil, et le test
 * anti-arrachement passait alors sans rien prouver (vérifié en retirant la garde : il restait vert). Un test
 * dont le moment déclencheur dépend d'une course avec un minuteur ne garde rien.
 *
 * Le curseur reste nul : le fil redemande alors tout, et le dédoublonnage de la page fait le tri, donc seule
 * la nouvelle bulle change la référence de `messages`.
 */
async function mock(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const etat = { bulleEnPlus: false };
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/conversations/unread-count')) return json({ count: 0 });
    if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: CONVERSATIONS });
    if (url.includes('/messages')) {
      const bulles = historique(60);
      if (etat.bulleEnPlus) bulles.push(MESSAGE_HAUT);
      return json({ waId: '33600000001', windowOpen: true, lastInboundAt: '2026-08-15T11:00:00Z', controlOwner: 'app_human', messages: bulles });
    }
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { envoyerLaBulleHaute: () => { etat.bulleEnPlus = true; } };
}

/** La géométrie du conteneur défilant, telle que le navigateur la voit. */
async function geometrie(page: import('@playwright/test').Page) {
  return page.getByTestId('fil-messages').evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
  }));
}

async function ouvrirLeFil(page: import('@playwright/test').Page) {
  await page.goto('/inbox');
  await page.locator('li', { hasText: 'Fil Long' }).getByRole('button', { name: /Ouvrir la conversation|Open conversation/ }).click();
  await expect(page.getByText('Message numero 59')).toBeVisible();
}

test.describe('Inbox : le fil descend quand il doit, et seulement quand il doit', () => {
  test('🔴 ouvrir une conversation LONGUE atterrit sur le message le plus RÉCENT', async ({ page }) => {
    await mock(page);
    await ouvrirLeFil(page);

    await expect.poll(async () => {
      const g = await geometrie(page);
      return g.scrollHeight - g.scrollTop - g.clientHeight;
    }, { timeout: 5000 }).toBeLessThan(80);

    // 🔴 La garde qui rend le test honnête : sans débordement, « être en bas » est vrai gratuitement et
    // l'assertion ci-dessus ne prouverait rien.
    const g = await geometrie(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight + 500);
  });

  test('🔴 un message plus HAUT que la tolérance est suivi', async ({ page }) => {
    const { envoyerLaBulleHaute } = await mock(page);
    await ouvrirLeFil(page);
    // On attend d'être posé en bas AVANT de déclencher la bulle : c'est l'état de départ du défaut.
    await expect.poll(async () => {
      const g = await geometrie(page);
      return g.scrollHeight - g.scrollTop - g.clientHeight;
    }, { timeout: 5000 }).toBeLessThan(80);

    envoyerLaBulleHaute();
    await expect(page.getByText('ligne 11 d un message particulierement long')).toBeVisible({ timeout: 15000 });

    await expect.poll(async () => {
      const g = await geometrie(page);
      return g.scrollHeight - g.scrollTop - g.clientHeight;
    }, { timeout: 5000 }).toBeLessThan(80);
  });

  test('l’opérateur REMONTÉ dans l’historique n’est pas arraché à sa lecture', async ({ page }) => {
    // La garde d'origine, celle qu'il ne faut surtout pas perdre en corrigeant les deux défauts ci-dessus.
    const { envoyerLaBulleHaute } = await mock(page);
    await ouvrirLeFil(page);
    await expect.poll(async () => (await geometrie(page)).scrollTop, { timeout: 5000 }).toBeGreaterThan(0);

    // On remonte, PUIS seulement on déclenche la bulle : l'ordre est ce qui donne sa valeur au test.
    await page.getByTestId('fil-messages').evaluate((el) => { el.scrollTop = 0; });
    await expect.poll(async () => (await geometrie(page)).scrollTop, { timeout: 2000 }).toBeLessThan(80);
    envoyerLaBulleHaute();
    await expect(page.getByText('ligne 11 d un message particulierement long')).toBeVisible({ timeout: 15000 });

    // Toujours en haut : la nouvelle bulle ne l'a pas fait sauter.
    expect((await geometrie(page)).scrollTop).toBeLessThan(80);
  });
});
