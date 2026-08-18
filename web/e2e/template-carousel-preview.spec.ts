import { test, expect } from '@playwright/test';

/**
 * E2E aperçu d'un template CAROUSEL déjà créé : cliquer sur son nom montre les vraies cartes (image, texte,
 * boutons), pas un encadré gris. Les images des cartes n'étaient jusqu'ici jamais relues chez Meta.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CAROUSEL = {
  id: 'C1', name: 'liste_events', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Voici notre sélection', headerFormat: null, isCarousel: true, editable: false,
  carousel: {
    cards: [
      { mediaUrl: 'https://scontent.example/carte-a.jpg', mediaFormat: 'IMAGE', body: 'Masterclass', buttons: [{ type: 'QUICK_REPLY', text: "Je m'inscris" }, { type: 'URL', text: 'En savoir plus', url: 'https://x.fr' }] },
      { mediaUrl: 'https://scontent.example/carte-b.jpg', mediaFormat: 'IMAGE', body: 'Portes ouvertes', buttons: [{ type: 'QUICK_REPLY', text: 'Je viens' }] },
      { body: 'Carte sans image' },
    ],
  },
};
const SIMPLE = { id: 'S1', name: 'promo_simple', status: 'APPROVED', category: 'MARKETING', language: 'fr', body: 'Bonjour', headerFormat: null, isCarousel: false, editable: true };

test.describe('Templates : aperçu d’un carousel', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    // Les images pointent vers un domaine inexistant : on les sert nous-mêmes pour que le rendu soit
    // déterministe et hors réseau (le test vérifie le câblage, pas le CDN de Meta).
    await page.route('https://scontent.example/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64') }));
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (url.includes('/templates')) return json({ templates: [CAROUSEL, SIMPLE] });
      if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, timezone: 'Europe/Paris', businessHours: {} });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/templates');
  });

  test('les cartes s’affichent avec leur image, leur texte et leurs boutons', async ({ page }) => {
    await page.getByRole('button', { name: 'liste_events' }).click();

    const cards = page.getByTestId('carousel-cards');
    await expect(cards).toBeVisible();
    await expect(page.getByText('Voici notre sélection')).toBeVisible(); // bulle d'intro

    // Une image par carte qui en a une, chargée pour de vrai (naturalWidth > 0).
    const imgs = cards.locator('img');
    await expect(imgs).toHaveCount(2);
    await expect(imgs.first()).toHaveAttribute('src', 'https://scontent.example/carte-a.jpg');
    await expect
      .poll(() => imgs.first().evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);

    // Textes et boutons PROPRES à chaque carte (pas les boutons top-level, un carousel n'en a pas).
    await expect(cards.getByText('Masterclass')).toBeVisible();
    await expect(cards.getByText('Portes ouvertes')).toBeVisible();
    await expect(cards.getByText("Je m'inscris")).toBeVisible();
    await expect(cards.getByText('Je viens')).toBeVisible();

    // Carte sans image : emplacement honnête, jamais d'image cassée.
    await expect(cards.getByText('Carte sans image')).toBeVisible();
    await expect(cards.getByText('image', { exact: true })).toBeVisible();
  });

  test('image expirée ou injoignable -> on le dit, pas d’icône cassée', async ({ page }) => {
    await page.unroute('https://scontent.example/**');
    await page.route('https://scontent.example/**', (route) => route.abort());
    await page.getByRole('button', { name: 'liste_events' }).click();
    await expect(page.getByText('image indisponible').first()).toBeVisible();
  });

  test('un template SIMPLE garde son aperçu habituel (non-régression)', async ({ page }) => {
    await page.getByRole('button', { name: 'promo_simple' }).click();
    await expect(page.getByText('Bonjour')).toBeVisible();
    await expect(page.getByTestId('carousel-cards')).toHaveCount(0);
  });
});
