import { test, expect, type Page } from '@playwright/test';

/**
 * CHANGER D'ESPACE SANS SE DÉCONNECTER (RC3), depuis le menu du compte.
 *
 * 🔴 CE QUE CES TESTS TIENNENT : l'entrée n'existe qu'à partir de deux espaces ; choisir un espace REMPLACE la session
 * dans le navigateur, recharge la page d'arrivée de CE rôle, et ce qui s'affiche ensuite vient de l'espace choisi ; le
 * nom de l'espace actuel est en tête du menu ; une API d'avant la route ne casse rien. La décision (qui peut ouvrir
 * quoi, l'échéance conservée, l'observation refusée) est au serveur, `tests/espaces.test.ts` : ici, les réponses de
 * l'API sont recopiées à la main.
 */

const EMAIL = 'julien@e2e.test';
const ALPHA = { token: 'jeton-alpha', email: EMAIL, role: 'admin', tenantId: 't-alpha' };

type Appel = { chemin: string; methode: string; corps: unknown; autorisation?: string };

const espace = (tenantId: string, tenantName: string, role: string, actuel: string) => ({ tenantId, tenantName, role, actuel: tenantId === actuel });
const DEUX = (actuel: string) => [espace('t-alpha', 'Espace Alpha', 'admin', actuel), espace('t-beta', 'Espace Beta', 'agent', actuel)];

/** Une conversation par espace : ce qu'affiche l'Inbox dit dans quel espace on est. */
const CONVERSATION_DE: Record<string, string> = { 't-alpha': 'Alice Alpha', 't-beta': 'Bob Beta' };

async function monter(page: Page, session: Record<string, unknown>, espaces: (tenant: string) => unknown): Promise<Appel[]> {
  // ⚠️ Posée UNE fois : un script d'initialisation rejoue à chaque chargement, et écraserait la session neuve au
  // rechargement qui suit la bascule.
  await page.addInitScript((s) => {
    if (!window.localStorage.getItem('mba.session')) window.localStorage.setItem('mba.session', JSON.stringify(s));
  }, session);
  const appels: Appel[] = [];
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const chemin = url.pathname.replace('/api/backend', '');
    appels.push({ chemin, methode: req.method(), corps: req.postData() ? req.postDataJSON() : null, autorisation: req.headers().authorization });
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const tenant = /^\/tenants\/([^/]+)/.exec(chemin)?.[1] ?? '';
    if (chemin.endsWith('/espaces')) return espaces(tenant) === 404 ? json({ error: 'Not Found' }, 404) : json(espaces(tenant));
    if (chemin === '/tenants/t-alpha/changer-espace') return json({ token: 'jeton-beta', user: { email: EMAIL, role: 'agent', tenantId: 't-beta' } });
    if (chemin.endsWith('/conversations/counts')) return json({ tout: 1, aTraiter: 0, signalees: 0, archivees: 0, traitees: 0, nonAffectees: 0, parMembre: [] });
    if (chemin.endsWith('/conversations')) {
      const nom = CONVERSATION_DE[tenant] ?? '';
      return json({ conversations: [{ id: `c-${tenant}`, waId: '33600000001', profileName: nom, lastPreview: 'bonjour', lastMessageAt: '2026-10-06T10:00:00Z', controlOwner: 'app_human', unread: false, curseur: '2026-10-06T10:00:00Z' }] });
    }
    if (chemin.endsWith('/me')) return json({ email: EMAIL, name: 'Julien', role: session.role });
    return json({});
  });
  return appels;
}

/** Ouvre le menu et attend la lecture des espaces, pour qu'une absence ne se constate pas avant qu'elle ait pu changer. */
async function ouvrirMenu(page: Page, tenant: string): Promise<void> {
  const lu = page.waitForResponse((r) => r.url().endsWith(`/tenants/${tenant}/espaces`));
  await page.getByTestId('menu-compte').click();
  await lu;
  await expect(page.getByTestId('menu-mon-compte')).toBeVisible();
}

test.describe('Menu du compte : changer d’espace', () => {
  test('🔴 deux espaces : on bascule, la session est remplacée, et l’Inbox montre l’autre espace', async ({ page }) => {
    const appels = await monter(page, ALPHA, (tenant) => ({ espaces: DEUX(tenant) }));
    await page.goto('/inbox');
    await expect(page.getByText('Alice Alpha')).toBeVisible();
    await ouvrirMenu(page, 't-alpha');
    await expect(page.getByTestId('menu-espace-actuel')).toHaveText('Espace Alpha');
    // Seuls les AUTRES espaces sont proposés, avec leur rôle.
    const bloc = page.getByTestId('menu-changer-espace');
    await expect(bloc).toContainText('Espace Beta');
    await expect(bloc).toContainText('Agent');
    await expect(page.getByTestId('menu-espace-t-alpha')).toHaveCount(0);

    await page.getByTestId('menu-espace-t-beta').click();
    // Le rechargement complet : la conversation de Beta, lue avec la session NEUVE, sur l'espace NEUF.
    await expect(page.getByText('Bob Beta')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Alice Alpha')).toHaveCount(0);
    await page.waitForURL('**/inbox');
    expect(appels.filter((a) => a.chemin === '/tenants/t-alpha/changer-espace').map((a) => [a.methode, a.corps, a.autorisation]))
      .toEqual([['POST', { tenantId: 't-beta' }, 'Bearer jeton-alpha']]);
    expect(JSON.parse((await page.evaluate(() => window.localStorage.getItem('mba.session'))) ?? '{}'))
      .toEqual({ token: 'jeton-beta', email: EMAIL, role: 'agent', tenantId: 't-beta' });
    expect(appels.some((a) => a.chemin.startsWith('/tenants/t-beta/conversations') && a.autorisation === 'Bearer jeton-beta')).toBe(true);

    // Le menu dit désormais où l'on est.
    await ouvrirMenu(page, 't-beta');
    await expect(page.getByTestId('menu-espace-actuel')).toHaveText('Espace Beta');
    await expect(page.getByTestId('menu-espace-t-alpha')).toBeVisible();
  });

  test('🔴 un seul espace : l’entrée n’existe pas, le nom de l’espace et le rôle (manager) sont en tête', async ({ page }) => {
    const manager = { ...ALPHA, role: 'manager' };
    await monter(page, manager, (tenant) => ({ espaces: [espace('t-alpha', 'Espace Alpha', 'manager', tenant)] }));
    await page.goto('/inbox');
    await ouvrirMenu(page, 't-alpha');
    await expect(page.getByTestId('menu-espace-actuel')).toHaveText('Espace Alpha');
    // Un manager n'est plus affiché « Agent ».
    await expect(page.getByRole('menu')).toContainText('Manager');
    await expect(page.getByTestId('menu-changer-espace')).toHaveCount(0);
  });

  test('⚠️ une API d’avant la route (404) : pas d’entrée, et le menu reste utilisable', async ({ page }) => {
    // La console part après l'API, mais si l'ordre se rompait, l'écran ne doit ni casser ni déconnecter.
    await monter(page, ALPHA, () => 404);
    await page.goto('/inbox');
    await ouvrirMenu(page, 't-alpha');
    await expect(page.getByTestId('menu-changer-espace')).toHaveCount(0);
    await expect(page.getByTestId('menu-espace-actuel')).toHaveCount(0);
    expect(JSON.parse((await page.evaluate(() => window.localStorage.getItem('mba.session'))) ?? '{}')).toMatchObject({ token: 'jeton-alpha' });
  });
});
