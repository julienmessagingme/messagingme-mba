import { test, expect } from '@playwright/test';

/**
 * E2E création d'un carousel : les boutons se saisissent CARTE PAR CARTE (texte et lien différents), seule
 * leur disposition est commune. Avant, un seul jeu de boutons s'appliquait à toutes les cartes, donc les
 * 10 cartes renvoyaient au même endroit, ce qui vide un carousel de son intérêt.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

test.describe('Templates : boutons d’un carousel, carte par carte', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/templates')) return json({ templates: [] });
      if (url.includes('/user-fields')) return json({ fields: [] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.includes('/flows')) return json({ flows: [] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {}, returnBehavior: null });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/templates');
    await page.getByRole('button', { name: /Créer un template/i }).click();
    await page.getByRole('button', { name: 'Carousel', exact: true }).click();
  });

  test('un bouton ajouté apparaît sur CHAQUE carte, avec son propre texte et son propre lien', async ({ page }) => {
    await page.getByRole('button', { name: '+ lien' }).click();

    // Un champ texte + un champ URL par carte (2 cartes par défaut), pas un jeu unique en haut.
    const urlFields = page.getByPlaceholder('https://exemple.fr/cette-carte');
    await expect(urlFields).toHaveCount(2);

    await urlFields.nth(0).fill('https://exemple.fr/carte-un');
    await urlFields.nth(1).fill('https://exemple.fr/carte-deux');
    await expect(urlFields.nth(0)).toHaveValue('https://exemple.fr/carte-un');
    await expect(urlFields.nth(1)).toHaveValue('https://exemple.fr/carte-deux'); // vraiment indépendants

    const texts = page.getByPlaceholder(/Texte du bouton/);
    await texts.nth(0).fill('Voir un');
    await texts.nth(1).fill('Voir deux');
    await expect(texts.nth(0)).toHaveValue('Voir un');
    await expect(texts.nth(1)).toHaveValue('Voir deux');
  });

  test('le champ du lien occupe toute la largeur de la carte (il était trop étroit pour être lu)', async ({ page }) => {
    await page.getByRole('button', { name: '+ lien' }).click();
    const field = page.getByPlaceholder('https://exemple.fr/cette-carte').first();
    const box = await field.boundingBox();
    expect(box!.width).toBeGreaterThan(200); // l'ancien w-28 faisait 112 px
  });

  test('une nouvelle carte hérite de la disposition, et 2 boutons est le maximum', async ({ page }) => {
    await page.getByRole('button', { name: '+ lien' }).click();
    await page.getByRole('button', { name: '+ réponse rapide' }).click();

    // Meta refuse au-delà de 2 boutons par carte (mesuré en live) : on n'en propose pas un 3e.
    await expect(page.getByRole('button', { name: '+ lien' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '+ réponse rapide' })).toBeDisabled();

    await page.getByRole('button', { name: '+ Ajouter une carte' }).click();
    // 3 cartes x 1 lien : la carte ajoutée porte la même disposition, sinon Meta refuserait le template.
    await expect(page.getByPlaceholder('https://exemple.fr/cette-carte')).toHaveCount(3);
  });

  test('retirer un bouton le retire de toutes les cartes', async ({ page }) => {
    await page.getByRole('button', { name: '+ lien' }).click();
    await expect(page.getByPlaceholder('https://exemple.fr/cette-carte')).toHaveCount(2);
    await page.getByRole('button', { name: 'Retirer' }).first().click();
    await expect(page.getByPlaceholder('https://exemple.fr/cette-carte')).toHaveCount(0);
  });
});
