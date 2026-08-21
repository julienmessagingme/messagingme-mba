import { test, expect } from '@playwright/test';

/**
 * L'écran de création de campagne face à une réponse INCOMPLÈTE de l'API des contacts.
 *
 * Vécu : `/contacts` a répondu 200 avec un JSON valide mais SANS le champ `contacts`. L'état typé tableau a
 * reçu `undefined`, un `.length` du rendu a jeté, et React a démonté l'ÉCRAN ENTIER, pas la seule liste. Le
 * `try/catch` autour de l'appel n'y pouvait rien : il n'y a aucune erreur réseau dans ce cas.
 *
 * C'est la classe de défaut la plus coûteuse du produit, parce qu'elle est totale et silencieuse : une liste
 * secondaire absente fait disparaître tout le reste.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Monte /campaigns en laissant choisir ce que rendent `/contacts` et `/contacts/count`. */
async function monter(page: import('@playwright/test').Page, contacts: unknown, count: unknown) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/contacts/count')) return json(count);
    if (url.includes('/contacts')) return json(contacts);
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Auxerre Mobilité' }] });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
  await page.goto('/campaigns');
  await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
}

test.describe('Campagne : réponse incomplète de l’API des contacts', () => {
  test('🔴 un 200 SANS le champ `contacts` ne fait pas tomber l’écran', async ({ page }) => {
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));

    await monter(page, {}, {});

    // L'écran reste vivant et utilisable de bout en bout : le champ du nom, la zone destinataires, le
    // sélecteur de template. Si React avait démonté la branche, rien de tout cela ne serait là.
    await expect(page.getByTestId('campaign-name')).toBeVisible();
    await page.getByTestId('campaign-name').fill('Campagne de test');
    await expect(page.getByRole('button', { name: /Créer un nouveau template/ })).toBeVisible();
    expect(erreurs, `exception de rendu : ${erreurs.join(' | ')}`).toEqual([]);
  });

  test('🔴 un total ABSENT ne s’invente pas à partir des lignes reçues', async ({ page }) => {
    // Le repli tentant était `liste.length`, plafonné par la limite de la requête : on aurait affiché « 2 »
    // pour une base de dix mille contacts. `total` est déjà typé « inconnu possible », l'écran sait le rendre.
    await monter(page, { contacts: [{ id: 'c1', phoneE164: '+33600000001', optInStatus: 'opted_in' }, { id: 'c2', phoneE164: '+33600000002', optInStatus: 'opted_in' }] }, {});
    await page.getByTestId('campaign-name').fill('Campagne de test');
    await expect(page.getByTestId('campaign-name')).toHaveValue('Campagne de test');
    // Le nombre reçu du serveur n'apparaît nulle part comme un total de base.
    await expect(page.locator('body')).not.toContainText('2 contacts au total');
  });

  test('une réponse COMPLÈTE reste évidemment nominale', async ({ page }) => {
    // Le contrôle positif : sans lui, les deux cas ci-dessus passeraient aussi sur un écran qui n'affiche
    // jamais rien.
    await monter(page, { contacts: [{ id: 'c1', phoneE164: '+33600000001', optInStatus: 'opted_in' }] }, { total: 1 });
    await expect(page.getByTestId('campaign-name')).toBeVisible();
  });
});
