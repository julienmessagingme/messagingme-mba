import { test, expect } from '@playwright/test';

/**
 * L'en-tête de l'aperçu WhatsApp doit porter le NOM VÉRIFIÉ du compte, celui que le destinataire lit en haut
 * de sa conversation. Il affichait jusqu'ici « Votre entreprise » sur 100 % des rendus : la prop existait
 * mais aucun écran ne la passait.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const SIMPLE = {
  id: 'S1', name: 'promo_simple', status: 'APPROVED', category: 'MARKETING', language: 'fr',
  body: 'Bonjour', headerFormat: null, isCarousel: false, editable: true,
};

/** Monte l'écran Templates avec les numéros voulus, puis ouvre l'aperçu du template. */
async function ouvrirApercu(page: import('@playwright/test').Page, phoneNumbers: unknown) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/phone-numbers')) return json(phoneNumbers);
    if (url.includes('/templates')) return json({ templates: [SIMPLE] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/templates');
  await page.getByRole('button', { name: 'promo_simple' }).click();
}

test.describe('Aperçu WhatsApp : le nom de l’entreprise', () => {
  test('🔴 l’en-tête porte le nom vérifié du compte, pas un libellé générique', async ({ page }) => {
    await ouvrirApercu(page, { phoneNumbers: [{ id: 'p1', displayPhoneNumber: '+33525680250', verifiedName: 'Auxerre Mobilité' }] });
    await expect(page.getByTestId('apercu-emetteur')).toHaveText('Auxerre Mobilité');
  });

  test('🔴 un numéro SANS nom vérifié ne vide pas l’en-tête : le libellé générique reste', async ({ page }) => {
    // `verified_name` est nullable : tant que Meta ne l'a pas remonté, un en-tête vide serait pire que neutre.
    await ouvrirApercu(page, { phoneNumbers: [{ id: 'p1', displayPhoneNumber: '+33525680250', verifiedName: null }] });
    await expect(page.getByTestId('apercu-emetteur')).toHaveText(/Votre entreprise|Your business/);
  });

  test('une réponse 200 sans le tableau attendu laisse l’aperçu affiché', async ({ page }) => {
    // ⚠️ Ce cas ne PROUVE pas la normalisation `Array.isArray(...)` de PhoneFrame : elle vit dans un `.then()`
    // suivi d'un `.catch(() => null)`, qui rattraperait l'exception de toute façon. Le rendu serait identique
    // sans elle. La garantie qui compte vraiment est testée là où l'écran tombait pour de bon :
    // `campaign-contacts-degrades.spec.ts`.
    await ouvrirApercu(page, {});
    await expect(page.getByTestId('apercu-emetteur')).toHaveText(/Votre entreprise|Your business/);
    await expect(page.getByText('Bonjour')).toBeVisible();
  });

  test('le premier numéro PORTANT un nom est retenu, pas le premier tout court', async ({ page }) => {
    await ouvrirApercu(page, {
      phoneNumbers: [
        { id: 'p1', displayPhoneNumber: '+33100000000', verifiedName: null },
        { id: 'p2', displayPhoneNumber: '+33525680250', verifiedName: 'Auxerre Mobilité' },
      ],
    });
    await expect(page.getByTestId('apercu-emetteur')).toHaveText('Auxerre Mobilité');
  });
});
