import { test, expect } from '@playwright/test';
import { zonesDeLaPage } from './support/zones-pdf';

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
// 🔴 `serviceParOrigine` EST INDISPENSABLE : sans lui `OrigineServiceCard` rend `null`, et la zone
// `quanti-origine-service` disparait du DOM. L inventaire se disait derive du DOM tout en etant
// aveugle sur une carte sur neuf, et c est precisement celle que le commentaire cite en exemple
// de zone ayant deja derive.
const STATS = { contacts: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [],
  serviceParOrigine: { ia: 1, scenario: 1, humain: 1, indeterminee: 0 } };

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

async function monterDashboard(chemin: string, ancre: string, page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await espionnerImpression(page);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/cost')) return json(COUT);
    if (url.includes('/stats/templates')) return json(TEMPLATES);
    // La campagne fait partie du contrat rendu par l API : une fixture qui l omet ferait passer un ecran qui
    // ne saurait pas la lire. C est exactement ainsi qu une valeur inventee a franchi la CI ce mois-ci.
    if (url.includes('/stats/errors')) return json({ errors: [{ code: 131026, count: 4, templateName: 'tpl-un', campaignId: 'camp-a', campaignName: 'Promo A' }] });
    if (url.includes('/stats')) return json(STATS);
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto(chemin);
  // Chaque sous-onglet a SON ancre : attendre celle d une autre page expirerait sans rien dire du vrai
  // probleme. La premiere carte de chaque page suffit a savoir que le rendu a eu lieu.
  await expect(page.getByTestId(`pdf-${ancre}`)).toBeVisible({ timeout: 15_000 });
}

/**
 * 🔴 LES QUATRE SOUS-ONGLETS ET LEURS ZONES, DERIVEES DU DOM ET NON ENUMEREES A LA MAIN.
 *
 * L ancienne version listait les zones dans un tableau ecrit a la main, et c etait une verification de
 * SOUS-ENSEMBLE : une carte ajoutee n y entrait pas, et le test restait vert en ne la verifiant jamais.
 * Deux zones ont derive ainsi sans que rien ne le signale (`quanti-facture` ajoutee au lot precedent,
 * `quanti-origine-service` depuis plus longtemps encore). On lit donc les zones REELLEMENT presentes, et on
 * exige que chacune porte son bouton : un inventaire tenu a la main derive, un inventaire derive ne peut pas.
 */
const SOUS_ONGLETS = [
  { chemin: '/dashboard', ancre: 'quanti-contacts' },
  { chemin: '/dashboard/couts', ancre: 'quanti-cout' },
  { chemin: '/dashboard/funnel', ancre: 'quanti-funnel' },
  // ⚠️ LA CARTE DES ERREURS A QUITTE LE QUANTITATIF LE 2026-09-17 pour le centre de Securite. Elle reste
  // dans cette liste parce que ce qui est verifie ici est « chaque zone rendue porte son bouton PDF », et
  // que cette propriete la suit ou qu elle aille. La retirer aurait cesse de garder un export qui existe.
  { chemin: '/securite/erreurs', ancre: 'quanti-erreurs' },
];

test.describe('Analytics quanti : chaque tableau s’exporte en PDF', () => {
  for (const { chemin, ancre } of SOUS_ONGLETS) {
    test(`🔴 ${chemin} : CHAQUE zone rendue porte son bouton (liste derivee du DOM)`, async ({ page }) => {
      await monterDashboard(chemin, ancre, page);
      const zones = await zonesDeLaPage(page);
      // Une page sans aucune zone serait un faux vert : le test passerait en ne verifiant rien.
      expect(zones.length, `aucune zone quanti- sur ${chemin}`).toBeGreaterThan(0);
      for (const zone of zones) {
        await expect(page.getByTestId(`pdf-${zone}`), `${zone} n a pas de bouton PDF`).toBeVisible();
      }
    });
  }

  test('🔴 un export n’imprime QUE sa propre zone', async ({ page }) => {
    await monterDashboard('/dashboard/couts', 'quanti-cout', page);
    await page.getByTestId('pdf-quanti-cout').click();
    expect(await zonesImprimees(page)).toEqual(['quanti-cout']);
  });

  test('🔴 deux exports de suite : la zone précédente est démarquée, jamais imprimée avec la nouvelle', async ({ page }) => {
    // `afterprint` n'est pas garanti (impression annulée, onglet en arrière-plan). Sans nettoyage, la carte
    // d'avant repartirait collée sur la feuille suivante, et personne ne comprendrait d'où elle sort.
    // ⚠️ Les deux zones sont prises sur la MEME page depuis le decoupage : le nettoyage se joue dans un
    // document, pas entre deux navigations, qui remettraient le DOM a zero et rendraient le test creux.
    await monterDashboard('/dashboard/couts', 'quanti-cout', page);
    await page.getByTestId('pdf-quanti-cout').click();
    await page.getByTestId('pdf-quanti-facture').click();
    expect(await zonesImprimees(page)).toEqual(['quanti-cout', 'quanti-facture']);
  });
});

test.describe('Journal des actions : export CSV', () => {
  const ENTREES = [
    { id: 'a-1', at: '2026-08-19T20:14:03.000Z', actorEmail: 'julien@messagingme.fr', action: 'contact.purged', targetKind: 'contact', targetId: 'c-42', detail: { purges: 1 } },
    { id: 'a-2', at: '2026-08-18T09:00:00.000Z', actorEmail: null, action: 'contact.optin', targetKind: 'contact', targetId: 'c-7', detail: {} },
  ];

  async function monterJournalDAudit(page: import('@playwright/test').Page) {
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
    // ⚠️ LE JOURNAL A DÉMÉNAGÉ DANS « SÉCURITÉ » LE 2026-09-13. Ce test le désignait par sa PAGE, pas par
    // un symbole : aucun `grep` sur le composant ne pouvait le trouver, et il n'a rougi qu'en CI.
    await page.goto('/securite/audit');
    await expect(page.getByTestId('journal-export-csv')).toBeEnabled({ timeout: 15_000 });
    return { appelsAudit };
  }

  test('🔴 le CSV porte les libellés, l’acteur système, et RELIT le journal au-delà de l’écran', async ({ page }) => {
    const { appelsAudit } = await monterJournalDAudit(page);
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
