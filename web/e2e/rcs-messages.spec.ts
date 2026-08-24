import { test, expect } from '@playwright/test';

/**
 * Contenu > Messages RCS : composer un message avec ses boutons, le voir dans l'aperçu, et l'enregistrer.
 *
 * Ce qu'on protège : le corps REELLEMENT posté. Un message enregistré sans ses boutons, ou avec un
 * `postbackData` vide, produirait un scénario incapable de router le clic du contact.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page, posts: Array<Record<string, unknown>>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/rcs-messages')) {
      posts.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ message: { id: 'm1', name: 'x', content: null, createdAt: '', updatedAt: '' } }) });
    }
    if (url.includes('/rcs-messages')) return json({ messages: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
}

test.describe('Contenu : messages RCS', () => {
  test('compose un message avec boutons, l affiche en apercu et poste le bon corps', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Offre du jour');
    await page.getByTestId('rcs-message-text').fill('Bonjour, votre offre est disponible.');

    await page.getByTestId('rcs-message-add-button').click();
    await page.getByPlaceholder('Libellé du bouton').fill('En savoir plus');

    // L'apercu montre le texte ET le bouton, avant tout enregistrement.
    await expect(page.getByTestId('rcs-preview-text')).toHaveText('Bonjour, votre offre est disponible.');
    await expect(page.getByTestId('rcs-preview-buttons')).toContainText('En savoir plus');

    await page.getByTestId('rcs-message-save').click();

    await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
    expect(posts[0]).toMatchObject({
      name: 'Offre du jour',
      content: {
        kind: 'text',
        text: 'Bonjour, votre offre est disponible.',
        suggestions: [{ kind: 'reply', text: 'En savoir plus', postbackData: 'btn_1' }],
      },
    });
  });

  test('n enregistre PAS un bouton lien sans URL', async ({ page }) => {
    const posts: Array<Record<string, unknown>> = [];
    await mock(page, posts);
    await page.goto('/rcs-messages');

    await page.getByTestId('rcs-message-new').click();
    await page.getByTestId('rcs-message-name').fill('Avec lien');
    await page.getByTestId('rcs-message-text').fill('Bonjour');
    await page.getByTestId('rcs-message-add-button').click();
    await page.getByPlaceholder('Libellé du bouton').fill('Voir le site');
    await page.locator('select').first().selectOption('openUrl');

    // URL laissee vide : le bouton d'enregistrement doit rester inactif.
    await expect(page.getByTestId('rcs-message-save')).toBeDisabled();
    expect(posts).toHaveLength(0);
  });
});
