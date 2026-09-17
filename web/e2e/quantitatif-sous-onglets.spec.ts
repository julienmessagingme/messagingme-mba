import { test, expect } from '@playwright/test';
import { zonesDeLaPage } from './support/zones-pdf';

/**
 * Le rangement d'Analytics > Quantitatif en QUATRE sous-onglets : ce que chacun montre, et ce qu'il ne
 * montre pas.
 *
 * 🔴 CE QUE CES SPECS PROTÈGENT. Le découpage a déplacé des cartes d'une page vers quatre. Deux régressions
 * sont possibles et invisibles du compilateur : une carte qui reste sur DEUX pages (le lecteur la voit deux
 * fois, et l'export PDF a deux zones de même id), et une barre de période DUPLIQUÉE par onglet, qui
 * divergerait au premier ajustement. Les deux se vérifient sur le DOM réel, pas sur une liste écrite à la
 * main : c'est un inventaire tenu à la main qui avait laissé deux zones d'export dériver.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const TEMPLATES = { total: 5, breakdown: [{ name: 'tpl-un', category: 'marketing', count: 3 }], pricing: { byCategory: { marketing: { category: 'marketing', cost: 1.42, volume: 10, ratePerMessage: 0.142 } }, totalCost: 1.42, currency: 'EUR' } };
/**
 * Les chiffres du LOT 1, ceux que la restructuration ne doit pas bouger : un total, et surtout des envois
 * NON CHIFFRABLES, qui disparaissaient en silence avant ce lot.
 */
const COUT = { marketing: [{ date: '2026-09-01', count: 12.5 }], utility: [], total: 12.5, hasRates: true, currency: 'EUR', nonChiffrables: 22 };
// 🔴 `serviceParOrigine` EST INDISPENSABLE : sans lui `OrigineServiceCard` rend `null`, et la zone
// `quanti-origine-service` disparait du DOM. L inventaire se disait derive du DOM tout en etant
// aveugle sur une carte sur neuf, et c est precisement celle que le commentaire cite en exemple
// de zone ayant deja derive.
const STATS = { contacts: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [],
  serviceParOrigine: { ia: 1, scenario: 1, humain: 1, indeterminee: 0 } };
const ERREURS = { errors: [{ code: 131026, count: 4, templateName: 'tpl-un', campaignId: 'camp-a', campaignName: 'Promo A' }] };

/**
 * Les sous-onglets du Quantitatif, avec l'ancre qui prouve que LEUR page a rendu.
 *
 * ⚠️ ILS ETAIENT QUATRE JUSQU'AU 2026-09-17 : « Erreurs » est parti dans le centre de Securite, avec sa
 * carte. Le compte n'est plus ecrit dans ce commentaire, il derive de la liste juste en dessous. Et la
 * carte n'a PAS perdu sa couverture, elle a change de gardien : erreurs-contacts.spec.ts monte son nouvel
 * ecran, exports.spec.ts garde son bouton PDF.
 */
const SOUS_ONGLETS = [
  { chemin: '/dashboard', ancre: 'quanti-contacts' },
  { chemin: '/dashboard/couts', ancre: 'quanti-cout' },
  { chemin: '/dashboard/funnel', ancre: 'quanti-funnel' },
];

/** Le funnel n'a PAS de barre de période, et c'est une décision écrite dans la page : un entonnoir porte sur
 *  toute la campagne, une fenêtre de temps le découperait en tranches fausses. */
const SANS_PERIODE = '/dashboard/funnel';

async function monter(chemin: string, ancre: string, page: import('@playwright/test').Page) {
  const appels: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    appels.push(url);
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/cost')) return json(COUT);
    if (url.includes('/stats/templates')) return json(TEMPLATES);
    if (url.includes('/stats/errors')) return json(ERREURS);
    if (url.includes('/stats')) return json(STATS);
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto(chemin);
  await expect(page.locator(`#${ancre}`)).toBeVisible({ timeout: 15_000 });
  return { appels };
}

test.describe('Quantitatif : les quatre sous-onglets', () => {
  test('🔴 U2 : aucune carte n’apparaît sur DEUX sous-onglets', async ({ page }) => {
    // La question est la RÉPARTITION, pas la présence : une carte laissée sur deux pages se lirait deux
    // fois, et deux zones d'export porteraient le même id. On lit les zones de chaque page, puis on exige
    // que les quatre ensembles soient disjoints. Rien n'est écrit à la main, donc rien ne peut dériver.
    const parPage = new Map<string, string[]>();
    for (const { chemin, ancre } of SOUS_ONGLETS) {
      await monter(chemin, ancre, page);
      const zones = await zonesDeLaPage(page);
      expect(zones.length, `aucune zone sur ${chemin}`).toBeGreaterThan(0);
      parPage.set(chemin, zones);
    }
    const vues = new Map<string, string>();
    for (const [chemin, zones] of parPage) {
      for (const z of zones) {
        expect(vues.has(z), `${z} apparait sur ${vues.get(z)} ET sur ${chemin}`).toBe(false);
        vues.set(z, chemin);
      }
    }
    // 🔴 ET LE COMPTE EXACT, pas un plancher. La version d'avant exigeait « au moins quatre » sous un
    // commentaire qui promettait « aucune carte perdue » : la moitié des cartes pouvait disparaître, le test
    // restait vert. Un commentaire qui promet plus que son assertion est pire qu'une assertion absente.
    expect([...vues.keys()].sort(), 'une zone a disparu, ou une zone est apparue sans entrer ici').toEqual([
      'quanti-contacts', 'quanti-cout', 'quanti-echanges', 'quanti-facture',
      'quanti-funnel', 'quanti-messages-envoyes', 'quanti-origine-service', 'quanti-templates',
    ]);
  });

  test('🔴 U2 : chaque sous-onglet porte SON ancre, et pas celle des autres', async ({ page }) => {
    for (const { chemin, ancre } of SOUS_ONGLETS) {
      await monter(chemin, ancre, page);
      for (const autre of SOUS_ONGLETS) {
        const attendu = autre.ancre === ancre ? 1 : 0;
        await expect(page.locator(`#${autre.ancre}`), `${autre.ancre} sur ${chemin}`).toHaveCount(attendu);
      }
    }
  });

  test('🔴 U3 : la barre de période n’existe JAMAIS en double', async ({ page }) => {
    // Le découpage rendait la duplication facile (une copie par onglet) ; deux barres divergeraient dès le
    // premier ajustement, et le lecteur ne saurait plus laquelle pilote les chiffres.
    for (const { chemin, ancre } of SOUS_ONGLETS) {
      await monter(chemin, ancre, page);
      const attendu = chemin === SANS_PERIODE ? 0 : 1;
      await expect(page.getByTestId('range-bar'), `barres de periode sur ${chemin}`).toHaveCount(attendu);
    }
  });

  test('🔴 U3 : changer la période relance les chiffres du sous-onglet', async ({ page }) => {
    // Une barre présente mais inerte serait pire qu'absente : elle promettrait un filtre qui ne filtre rien.
    for (const { chemin, ancre } of SOUS_ONGLETS.filter((s) => s.chemin !== SANS_PERIODE)) {
      const { appels } = await monter(chemin, ancre, page);
      const avant = appels.length;
      await page.getByTestId('range-bar').getByRole('button', { name: /^7 (j|d)$/ }).click();
      await expect.poll(() => appels.slice(avant).some((u) => u.includes('from=') && u.includes('to=')), {
        timeout: 15_000,
        message: `aucun appel date apres le changement de periode sur ${chemin}`,
      }).toBe(true);
    }
  });

  test('🔴 U3 : le funnel dit POURQUOI il n’a pas de période', async ({ page }) => {
    // Une absence non expliquée se lit comme un oubli, et quelqu'un la « repare » en ajoutant une barre qui
    // ne filtrerait rien.
    await monter('/dashboard/funnel', 'quanti-funnel', page);
    await expect(page.getByText(/Pas de période ici|No period here/)).toBeVisible();
  });

  test('🔴 U9 : les chiffres du lot 1 sont intacts après le rangement', async ({ page }) => {
    // Le lot precedent a repare le COUT (les envois de scenario y entrent) et sorti le total facture de la
    // carte par template. Le rangement en sous-onglets ne doit rien avoir bouge : on relit les deux sur
    // l ecran restructure.
    await monter('/dashboard/couts', 'quanti-cout', page);
    const carte = page.locator('#quanti-cout');
    // Le total estime, tel que la serie le porte (12,5 EUR).
    await expect(carte).toContainText(/12[,.]50/);
    // 🔴 Et surtout les envois NON CHIFFRABLES, qui disparaissaient en silence avant le lot 1.
    await expect(page.getByTestId('cout-non-chiffrables')).toContainText('22');
    // Le total FACTURE par Meta vit dans sa propre carte, pas dans celle du detail par template.
    await expect(page.locator('#quanti-facture')).toBeVisible();
  });
});
