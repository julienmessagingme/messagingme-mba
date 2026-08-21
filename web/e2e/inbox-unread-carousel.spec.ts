import { test, expect } from '@playwright/test';

/**
 * E2E inbox, deux demandes de Julien :
 *  - une pastille avec le NOMBRE de conversations non lues, dans le menu de gauche ;
 *  - les templates CAROUSEL doivent apparaître dans la liste d'envoi (ils en étaient exclus, au motif que
 *    leur envoi exigeait de relire les cartes chez Meta, ce que l'API fait désormais).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONVERSATIONS = [
  { id: 'c1', waId: '33600000001', profileName: 'Alice Lue', lastPreview: 'ok', lastMessageAt: '2026-08-15T10:00:00Z', controlOwner: 'app_workflow', unread: false },
  { id: 'c2', waId: '33600000002', profileName: 'Bob NonLu', lastPreview: 'coucou', lastMessageAt: '2026-08-15T11:00:00Z', controlOwner: 'app_human', unread: true },
];

const TEMPLATES = [
  { id: 't1', name: 'promo_simple', status: 'APPROVED', category: 'MARKETING', language: 'fr', body: 'Bonjour {{1}}', headerFormat: null, isCarousel: false, editable: true },
  {
    id: 't2', name: 'promo_carousel', status: 'APPROVED', category: 'MARKETING', language: 'fr',
    body: 'Découvrez la sélection', headerFormat: null, isCarousel: true, editable: false,
    carousel: {
      cards: [
        { mediaUrl: 'https://exemple.test/carte1.jpg', body: 'Carte une', buttons: [{ type: 'URL', text: 'Voir un', url: 'https://exemple.fr/1' }] },
        { mediaUrl: 'https://exemple.test/carte2.jpg', body: 'Carte deux', buttons: [{ type: 'URL', text: 'Voir deux', url: 'https://exemple.fr/2' }] },
      ],
    },
  },
];

/** Backend intercepté (pattern des autres specs). `unreadCount` pilote la pastille du menu. */
async function mock(page: import('@playwright/test').Page, unreadCount: number) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/conversations/unread-count')) return json({ count: unreadCount });
    if (url.split('?')[0]!.endsWith('/conversations')) return json({ conversations: CONVERSATIONS });
    // Fenêtre 24 h FERMÉE : c'est l'état où l'inbox propose « Envoyer un template », et c'est le seul moyen
    // de ré-engager le contact, donc le cas qui nous intéresse pour le carousel.
    if (url.includes('/messages')) {
      return json({
        waId: '33600000002', windowOpen: false, lastInboundAt: '2026-08-10T10:00:00Z',
        controlOwner: 'app_human',
        messages: [{ id: 'm1', direction: 'in', type: 'text', body: 'coucou', buttonPayload: null, createdAt: '2026-08-15T11:00:00Z' }],
      });
    }
    if (url.includes('/templates')) return json({ templates: TEMPLATES });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Inbox : non-lus et carousels', () => {
  test('le menu affiche le nombre de conversations non lues à côté d’Inbox', async ({ page }) => {
    await mock(page, 3);
    await page.goto('/inbox');
    await expect(page.getByTestId('nav-badge-inbox')).toHaveText('3');
  });

  test('zéro non-lu -> aucune pastille (une pastille à 0 est du bruit)', async ({ page }) => {
    await mock(page, 0);
    await page.goto('/inbox');
    await expect(page.getByTestId('nav-badge-inbox')).toHaveCount(0);
  });

  test('la liste marque les fils non lus, pour que le compteur soit actionnable', async ({ page }) => {
    await mock(page, 1);
    await page.goto('/inbox');
    await expect(page.getByTestId('unread-dot')).toHaveCount(1);
  });

  test('ouvrir une conversation la déclare LUE au serveur', async ({ page }) => {
    await mock(page, 1);
    const lus: string[] = [];
    await page.route('**/api/backend/**/read', async (route) => {
      lus.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto('/inbox');
    await page.getByText('Bob NonLu').click();
    await expect.poll(() => lus.length).toBeGreaterThan(0);
    expect(lus[0]).toContain('/conversations/c2/read');
  });

  test('un carousel EST proposé à l’envoi, et son aperçu montre les cartes', async ({ page }) => {
    await mock(page, 0);
    await page.goto('/inbox');
    await page.getByText('Bob NonLu').click();
    await page.getByRole('button', { name: /Envoyer un template/i }).click();

    // Le carousel figure dans la liste (il en était explicitement exclu).
    const select = page.getByRole('combobox').last();
    await expect(select.locator('option', { hasText: 'promo_carousel' })).toHaveCount(1);

    await select.selectOption('promo_carousel::fr');
    // Aperçu carousel : les vraies cartes, pas un simple corps de texte.
    await expect(page.getByTestId('carousel-cards')).toBeVisible();
    await expect(page.getByText('Carte une')).toBeVisible();
    await expect(page.getByText('Carte deux')).toBeVisible();
  });
});
