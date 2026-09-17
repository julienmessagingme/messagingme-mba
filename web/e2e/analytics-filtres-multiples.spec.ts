import { test, expect } from '@playwright/test';

/**
 * E2E Analytics : les filtres « campagnes » et « templates » acceptent PLUSIEURS valeurs, et la série est
 * compilée sur l'ensemble.
 *
 * Ce que le test regarde vraiment, c'est la requête qui part : c'est le seul endroit où l'on voit que les deux
 * valeurs choisies sont bien envoyées ensemble, et non la dernière seule. Les deux axes sont mutuellement
 * exclusifs, parce que les croiser décrirait leur intersection et pas leur union.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CAMPAGNES = [
  { id: 'camp-a', name: 'Promo A', status: 'sent', createdAt: '2026-08-01T09:00:00.000Z', counts: { queued: 0, sent: 3, delivered: 3, read: 1, failed: 0 } },
  { id: 'camp-b', name: 'Promo B', status: 'sent', createdAt: '2026-08-02T09:00:00.000Z', counts: { queued: 0, sent: 2, delivered: 2, read: 0, failed: 0 } },
];
const TEMPLATES = { total: 5, breakdown: [{ name: 'tpl-un', category: 'marketing', count: 3 }, { name: 'tpl-deux', category: 'utility', count: 2 }] };
const COUT = { marketing: [], utility: [], total: 12.5, hasRates: true, currency: 'EUR' };

/**
 * Monte le sous-onglet DEMANDÉ et rend les URL de la route de coût, dans l'ordre où elles partent.
 *
 * ⚠️ Le chemin est un paramètre depuis le découpage du Quantitatif : les filtres de coût vivent sur
 * `/dashboard/couts`, la carte des erreurs sur `/securite/erreurs` (elle a demenage le 2026-09-17). Les CAS exercés n'ont pas bougé.
 */
async function monter(chemin: string, page: import('@playwright/test').Page) {
  const appelsCout: string[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/stats/cost')) {
      appelsCout.push(url);
      return json(COUT);
    }
    if (url.includes('/stats/templates')) return json(TEMPLATES);
    if (url.includes('/stats/errors')) {
      // Chaque ligne porte SA campagne depuis le lot des erreurs filtrables : c est ce qui permet a la carte
      // de filtrer par campagne sans une seconde requete. Les deux templates sont sur deux campagnes
      // DIFFERENTES, sinon un filtre par campagne ne separerait rien et le test passerait sans rien prouver.
      return json({ errors: [
        { code: 131026, count: 4, templateName: 'tpl-un', campaignId: 'camp-a', campaignName: 'Promo A' },
        { code: 131047, count: 2, templateName: 'tpl-deux', campaignId: 'camp-b', campaignName: 'Promo B' },
      ] });
    }
    if (url.includes('/stats')) return json({ contacts: [], templates: { utility: [], marketing: [] }, exchanged: [], service: [] });
    if (url.includes('/campaigns')) return json({ campaigns: CAMPAGNES });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [] });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  // ⚠️ Chemin PARAMETRE depuis le decoupage du Quantitatif en quatre sous-onglets : les filtres de cout
  // vivent sur /dashboard/couts, la carte des erreurs sur /securite/erreurs (demenagee le 2026-09-17). Les CAS exerces sont
  // inchanges, seule l adresse ou ils se jouent a bouge.
  await page.goto(chemin);
  // L attente de disponibilite suit la PAGE, elle ne peut plus etre celle du graphe de cout : la carte des
  // erreurs vit desormais sur un autre sous-onglet, ou `cout-campagnes` n existe pas. Attendre un element
  // d une autre page est le genre d attente qui expire sans rien dire du vrai probleme.
  const ancre = chemin.endsWith('/erreurs') ? 'erreurs-templates' : 'cout-campagnes';
  await expect(page.getByTestId(ancre)).toBeVisible({ timeout: 15_000 });
  return { appelsCout };
}

test.describe('Analytics : filtres multiples', () => {
  test('🔴 deux campagnes choisies partent ENSEMBLE dans la requête (série compilée)', async ({ page }) => {
    const { appelsCout } = await monter('/dashboard/couts', page);
    await page.getByTestId('cout-campagnes').selectOption('camp-a');
    await page.getByTestId('cout-campagnes').selectOption('camp-b');

    await expect.poll(() => appelsCout.some((u) => {
      const v = new URL(u).searchParams.get('campaignIds');
      return v === 'camp-a,camp-b';
    }), { timeout: 15_000 }).toBe(true);
  });

  test('🔴 les deux axes sont mutuellement exclusifs : choisir un template vide les campagnes', async ({ page }) => {
    // Les croiser produirait l'INTERSECTION (campagne A ET template B), qui ne décrit rien d'utile.
    const { appelsCout } = await monter('/dashboard/couts', page);
    await page.getByTestId('cout-campagnes').selectOption('camp-a');
    await page.getByTestId('cout-templates').selectOption('tpl-un');

    await expect.poll(() => {
      const dernier = appelsCout[appelsCout.length - 1];
      if (dernier === undefined) return false;
      const p = new URL(dernier).searchParams;
      return p.get('templateNames') === 'tpl-un' && p.get('campaignIds') === null;
    }, { timeout: 15_000 }).toBe(true);
  });

  test('une valeur retenue se retire, et le filtre repart à « tout »', async ({ page }) => {
    const { appelsCout } = await monter('/dashboard/couts', page);
    await page.getByTestId('cout-campagnes').selectOption('camp-a');
    // La pastille du groupe, pas n'importe quel « Promo A » de la page : le nom apparait aussi ailleurs.
    const pastille = page.getByTestId('cout-campagnes-retenu');
    await expect(pastille).toHaveText(/Promo A/);
    await pastille.getByRole('button').click();
    await expect(pastille).toHaveCount(0);

    await expect.poll(() => {
      const dernier = appelsCout[appelsCout.length - 1];
      return dernier !== undefined && new URL(dernier).searchParams.get('campaignIds') === null;
    }, { timeout: 15_000 }).toBe(true);
  });

  test('🔴 carte Erreurs : plusieurs templates -> breakdown compilé', async ({ page }) => {
    // Filtre LOCAL (le breakdown est déjà chargé) : ce qui compte est que les deux codes restent visibles
    // quand les deux templates sont retenus, et qu'un seul les réduise.
    await monter('/securite/erreurs', page);
    await expect(page.getByText('131026')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('erreurs-templates').selectOption('tpl-un');
    await expect(page.getByText('131047')).toHaveCount(0);

    await page.getByTestId('erreurs-templates').selectOption('tpl-deux');
    await expect(page.getByText('131026')).toBeVisible();
    await expect(page.getByText('131047')).toBeVisible();
  });

  test('🔴 U7 : la carte Erreurs se filtre AUSSI par campagne', async ({ page }) => {
    // Demande de Julien : les erreurs se requetent par template OU par campagne. Le filtre est LOCAL (chaque
    // ligne porte deja sa campagne), donc ce qui se verifie est le contenu affiche, pas une requete.
    await monter('/securite/erreurs', page);
    await expect(page.getByText('131026')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('erreurs-campagnes').selectOption('camp-a');
    await expect(page.getByText('131026')).toBeVisible();
    await expect(page.getByText('131047')).toHaveCount(0);
  });

  test('🔴 U7 : les deux axes des erreurs sont MUTUELLEMENT EXCLUSIFS', async ({ page }) => {
    // Les croiser decrirait l intersection (campagne A ET template de B), qui ne veut rien dire. Meme regle
    // qu au cout, et elle se verifie sur la PASTILLE : c est la seule trace de ce qui est retenu.
    await monter('/securite/erreurs', page);
    await page.getByTestId('erreurs-campagnes').selectOption('camp-a');
    await expect(page.getByTestId('erreurs-campagnes-retenu')).toHaveText(/Promo A/);

    await page.getByTestId('erreurs-templates').selectOption('tpl-deux');
    await expect(page.getByTestId('erreurs-templates-retenu')).toHaveText(/tpl-deux/);
    await expect(page.getByTestId('erreurs-campagnes-retenu')).toHaveCount(0);
    // Et l inverse, sinon la regle ne serait verifiee que dans un sens.
    await page.getByTestId('erreurs-campagnes').selectOption('camp-b');
    await expect(page.getByTestId('erreurs-templates-retenu')).toHaveCount(0);
  });
});
