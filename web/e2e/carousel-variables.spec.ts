import { test, expect } from '@playwright/test';

/**
 * E2E création d'un carousel : le message d'introduction porte des VARIABLES exactement comme un template
 * classique. Avant, c'était une simple zone de texte : impossible d'y mettre `{{1}}`, donc impossible de
 * personnaliser un carousel, alors que c'est le même composant BODY côté Meta.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

test.describe('Templates : variables d’un carousel', () => {
  let cree: Record<string, unknown> | null = null;

  test.beforeEach(async ({ page }) => {
    cree = null;
    await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
    await page.route('**/api/backend/**', async (route) => {
      const url = route.request().url();
      const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (route.request().method() === 'POST' && url.includes('/templates')) {
        cree = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'tpl-1', status: 'PENDING' }) });
      }
      if (url.includes('/templates')) return json({ templates: [] });
      if (url.endsWith('/media')) return json({ handle: '4::handle-e2e' });
      if (url.includes('/user-fields')) return json({ fields: [{ key: 'ville', label: 'Ville', type: 'text' }] });
      if (url.includes('/tags')) return json({ tags: [] });
      if (url.includes('/flows')) return json({ flows: [] });
      if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
      return json({});
    });
    await page.goto('/templates');
    await page.getByRole('button', { name: /Créer un template/i }).click();
    await page.getByRole('button', { name: 'Carousel', exact: true }).click();
  });

  test('« + Variable » insère un champ du contact dans l’introduction, avec son exemple Meta', async ({ page }) => {
    await page.getByRole('button', { name: '+ Variable' }).click();
    await page.getByRole('button', { name: 'Prénom', exact: true }).click();

    // Le chip porte le libellé lisible du champ, pas le littéral {{1}}.
    await expect(page.locator('[data-var="1"]').first()).toHaveText('Prénom');
    // L'exemple exigé par Meta se remplit tout seul (c'est la promesse du sélecteur).
    const exemple = page.getByPlaceholder(/ex\. Julie/).first();
    await expect(exemple).not.toHaveValue('');
  });

  test('le carousel part chez Meta avec son example.body_text ET son indice variable -> champ', async ({ page }) => {
    await page.getByPlaceholder('promo_selection').fill('promo_perso');
    // Texte AVANT la variable : c'est l'usage réel (« Bonjour [Prénom] »), et ça vérifie au passage que
    // l'éditeur sérialise correctement le mélange texte + chip.
    await page.getByRole('textbox', { name: /Corps du message/i }).fill('Bonjour ');
    await page.getByRole('button', { name: '+ Variable' }).click();
    await page.getByRole('button', { name: 'Prénom', exact: true }).click();

    // Les 2 cartes exigent chacune une image. PNG 1x1 RÉEL : le formulaire passe par un canvas, un fichier
    // tronqué ne se décoderait pas et la carte resterait sans visuel (donc le bouton resterait grisé).
    const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fichiers = page.locator('input[type="file"]');
    for (let i = 0; i < 2; i += 1) {
      await fichiers.nth(i).setInputFiles({ name: `c${i}.png`, mimeType: 'image/png', buffer: PNG_1x1 });
    }
    await expect(page.getByRole('button', { name: /Créer le carousel/i })).toBeEnabled();

    await page.getByRole('button', { name: /Créer le carousel/i }).click();
    await expect.poll(() => cree).not.toBeNull();
    expect(cree).toMatchObject({
      body: 'Bonjour {{1}}',
      // `example` : exigé par Meta dès qu'un corps porte une variable, rempli par le sélecteur.
      example: ['Marie'],
      // `paramHints` : l'indice « {{1}} = Prénom », qui pré-remplira le mapping de la campagne.
      paramHints: [{ position: 1, source: { type: 'field', key: 'prenom' } }],
    });
    // Le carousel est bien parti avec ses cartes : la variable ne remplace pas le reste du template.
    expect(Array.isArray((cree as { carousel?: { cards?: unknown[] } }).carousel?.cards)).toBe(true);
  });
});
