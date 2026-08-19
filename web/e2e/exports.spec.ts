import { test, expect } from '@playwright/test';

/**
 * E2E des exports : le PDF des tableaux d'Analytics, et le CSV du journal des actions.
 *
 * Ce que ces tests regardent, c'est ce qu'on ne voit PAS à l'oeil : quelle zone est réellement isolée au
 * moment de l'impression, et ce que contient vraiment le fichier téléchargé. Une capture d'écran n'aurait
 * montré ni l'une ni l'autre.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATES = { total: 5, breakdown: [{ name: 'tpl-un', category: 'marketing', count: 3 }], pricing: { byCategory: { marketing: { category: 'marketing', cost: 1.42, volume: 10, ratePerMessage: 0.142 } }, totalCost: 1.42, currency: 'EUR' } };
const COUT = { marketing: [], utility: [], total: 12.5, hasRates: true, currency: 'EUR' };
const STATS = { contacts: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [] };

/**
 * `window.print` est remplacé AVANT tout script de page : on enregistre l'id de la zone marquée au moment de
 * l'appel. Sans ça, la boîte d'impression du navigateur bloquerait le test, et surtout on n'aurait aucun moyen
 * de savoir CE QUI serait sorti sur la feuille.
 */
async function espionnerImpression(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const zones: Array<string | null> = [];
    Object.defineProperty(window, '__zonesImprimees', { value: zones, writable: false });
    window.print = () => {
      const marquees = Array.from(document.getElementsByClassName('zone-impression'));
      zones.push(marquees.length === 1 ? (marquees[0]?.id ?? '') : `${marquees.length} zones`);
    };
  });
}

const zonesImprimees = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __zonesImprimees: string[] }).__zonesImprimees);

async function monterDashboard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await espionnerImpression(page);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/cost')) return json(COUT);
    if (url.includes('/stats/templates')) return json(TEMPLATES);
    if (url.includes('/stats/errors')) return json({ errors: [{ code: 131026, count: 4, templateName: 'tpl-un' }] });
    if (url.includes('/stats')) return json(STATS);
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/dashboard');
  await expect(page.getByTestId('pdf-quanti-contacts')).toBeVisible({ timeout: 15_000 });
}

test.describe('Analytics quanti : chaque tableau s’exporte en PDF', () => {
  test('🔴 chaque carte porte son bouton, et n’imprime QUE sa propre zone', async ({ page }) => {
    await monterDashboard(page);
    for (const zone of ['quanti-contacts', 'quanti-echanges', 'quanti-messages-envoyes', 'quanti-cout', 'quanti-funnel', 'quanti-erreurs', 'quanti-templates']) {
      await expect(page.getByTestId(`pdf-${zone}`)).toBeVisible();
    }

    await page.getByTestId('pdf-quanti-cout').click();
    expect(await zonesImprimees(page)).toEqual(['quanti-cout']);
  });

  test('🔴 deux exports de suite : la zone précédente est démarquée, jamais imprimée avec la nouvelle', async ({ page }) => {
    // `afterprint` n'est pas garanti (impression annulée, onglet en arrière-plan). Sans nettoyage, la carte
    // d'avant repartirait collée sur la feuille suivante, et personne ne comprendrait d'où elle sort.
    await monterDashboard(page);
    await page.getByTestId('pdf-quanti-cout').click();
    await page.getByTestId('pdf-quanti-erreurs').click();
    expect(await zonesImprimees(page)).toEqual(['quanti-cout', 'quanti-erreurs']);
  });
});

test.describe('Journal des actions : export CSV', () => {
  const ENTREES = [
    { id: 'a-1', at: '2026-08-19T20:14:03.000Z', actorEmail: 'julien@messagingme.fr', action: 'contact.purged', targetKind: 'contact', targetId: 'c-42', detail: { purges: 1 } },
    { id: 'a-2', at: '2026-08-18T09:00:00.000Z', actorEmail: null, action: 'contact.optin', targetKind: 'contact', targetId: 'c-7', detail: {} },
  ];

  async function monterParametres(page: import('@playwright/test').Page) {
    const appelsAudit: string[] = [];
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    // Le CSV est fabriqué en mémoire puis téléchargé via un blob : on intercepte sa création pour lire ce qui
    // part vraiment dans le fichier, plutôt que de faire confiance au bouton.
    await page.addInitScript(() => {
      const textes: string[] = [];
      Object.defineProperty(window, '__csv', { value: textes, writable: false });
      const vrai = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (objet: Blob | MediaSource) => {
        if (objet instanceof Blob) void objet.text().then((t) => textes.push(t));
        return vrai(objet);
      };
    });
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/audit')) {
        appelsAudit.push(url);
        return json({ entries: ENTREES });
      }
      if (url.includes('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/parametres');
    await expect(page.getByTestId('journal-export-csv')).toBeEnabled({ timeout: 15_000 });
    return { appelsAudit };
  }

  test('🔴 le CSV porte les libellés, l’acteur système, et RELIT le journal au-delà de l’écran', async ({ page }) => {
    const { appelsAudit } = await monterParametres(page);
    await page.getByTestId('journal-export-csv').click();

    await expect.poll(() => page.evaluate(() => (window as unknown as { __csv: string[] }).__csv.length), { timeout: 15_000 }).toBe(1);
    const csv = (await page.evaluate(() => (window as unknown as { __csv: string[] }).__csv))[0]!;

    expect(csv).toContain('Action');
    expect(csv).toContain('Contact supprimé');
    expect(csv).toContain('julien@messagingme.fr');
    expect(csv).toContain('Système'); // acteur absent = le système, jamais une case vide
    expect(csv).toContain('2026-08-19T20:14:03.000Z'); // date ISO brute : un CSV se trie

    // L'export ne se contente pas des 100 lignes affichées : il redemande le journal jusqu'au plafond serveur.
    expect(appelsAudit.some((u) => new URL(u).searchParams.get('limit') === '1000')).toBe(true);
  });
});
