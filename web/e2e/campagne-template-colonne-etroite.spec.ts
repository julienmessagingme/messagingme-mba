import { test, expect } from '@playwright/test';

/**
 * LE FORMULAIRE DE TEMPLATE EST LISIBLE DANS LA COLONNE DE LA CAMPAGNE.
 *
 * 🔴 CE QUI ÉTAIT CASSÉ, et il a fallu le MESURER pour le voir. Julien, le 2026-09-08 : « selon la taille de
 * l'écran, la miniature du template passe au-dessus des cases à remplir, c'est illisible ». Ce n'était pas un
 * chevauchement : l'aperçu prenait 300 px FIXES à côté du formulaire, et l'écran de campagne rend déjà ce
 * formulaire dans une DEMI-page. Largeur restante du champ « Nom », mesurée avant correctif :
 *
 *   écran 1280 -> 26 px · 1440 -> 101 px · 1600 -> 181 px · 1920 -> 341 px
 *
 * ⚠️ Aucune media query ne pouvait corriger ça : les points de rupture lisent la largeur de l'ÉCRAN. À 1280,
 * la page Templates dispose de ~900 px et veut ses deux colonnes ; la campagne de 345 px et n'en veut qu'une.
 * D'où le drapeau `colonneEtroite`, posé par l'appelant qui SAIT dans quoi il rend.
 *
 * Ce test mesure au lieu de décrire : une assertion sur une classe CSS passerait au vert le jour où la classe
 * existe sans plus rien produire.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

/** Sous cette largeur, un champ de saisie ne se lit plus. C'est la mesure qui fait foi, pas le rendu. */
const LARGEUR_MINIMALE = 240;

async function mock(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/template-params')) return json({ hints: [] });
    if (url.includes('/contacts/count')) return json({ total: 0 });
    if (url.includes('/contacts')) return json({ contacts: [] });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.includes('/campaign-drafts')) return json({ drafts: [] });
    if (url.includes('/campaigns')) return json({ campaigns: [] });
    if (url.includes('/phone-numbers')) return json({ phoneNumbers: [{ id: 'pn1', displayPhoneNumber: '+33525680250', verifiedName: 'Test' }] });
    if (url.endsWith('/workflows')) return json({ workflows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

async function ouvrirLeFormulaireDeTemplate(page: import('@playwright/test').Page) {
  await page.goto('/campaigns');
  await page.getByRole('button', { name: /Ajouter une campagne/i }).click();
  // La zone du template reste inerte tant que la campagne n'a pas de nom (étape 1 de l'écran).
  await page.getByTestId('campaign-name').fill('Campagne de test');
  await page.getByTestId('campaign-name').blur();
  await page.getByRole('button', { name: /Créer un nouveau template/ }).click();
}

test.describe('Campagne : le formulaire de template reste lisible dans sa colonne', () => {
  // Les quatre largeurs mesurées le 2026-09-08. 1280 est le cas le pire (26 px), 1920 le meilleur (341 px) :
  // même le meilleur méritait le correctif, et aucune n'était bonne.
  for (const largeur of [1280, 1440, 1600, 1920]) {
    test(`🔴 à ${largeur} px, les champs restent utilisables`, async ({ page }) => {
      await page.setViewportSize({ width: largeur, height: 900 });
      await mock(page);
      await ouvrirLeFormulaireDeTemplate(page);

      const champNom = page.getByPlaceholder('promo_ete');
      await expect(champNom).toBeVisible();
      const nom = (await champNom.boundingBox())!;
      expect(Math.round(nom.width), `le champ « Nom » ne fait que ${Math.round(nom.width)} px : l’aperçu a repris la place`)
        .toBeGreaterThan(LARGEUR_MINIMALE);

      // Et l'aperçu est bien SOUS le formulaire, pas à côté : c'est ce qui rend la largeur au formulaire.
      const apercu = (await page.getByTestId('apercu-whatsapp').boundingBox())!;
      expect(apercu.y, 'l’aperçu est resté à côté des champs au lieu de passer dessous').toBeGreaterThan(nom.y);
    });
  }

  test('🔴 preuve inverse : sur SA PROPRE PAGE, l’aperçu reste À CÔTÉ du formulaire', async ({ page }) => {
    // Sans ce cas, empiler l'aperçu partout passerait le test ci-dessus, et la page Templates perdrait sa
    // mise en page à deux colonnes alors qu'elle a toute la largeur voulue.
    await page.setViewportSize({ width: 1440, height: 900 });
    await mock(page);
    await page.goto('/templates');
    await page.getByRole('button', { name: /Créer un template|Create a template/ }).first().click();
    const champNom = page.getByPlaceholder('promo_ete');
    await expect(champNom).toBeVisible();
    const nom = (await champNom.boundingBox())!;
    const apercu = (await page.getByTestId('apercu-whatsapp').boundingBox())!;
    expect(apercu.x, 'l’aperçu est passé sous le formulaire alors que la page a la place pour deux colonnes')
      .toBeGreaterThan(nom.x + nom.width);
  });
});
