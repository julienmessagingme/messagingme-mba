import { test, expect } from '@playwright/test';

/**
 * Écran Contenu > Formulaires WhatsApp, bouton « Rafraîchir » : va chercher les formulaires du compte
 * WhatsApp Manager et met la liste locale à jour.
 *
 * Ce que ce test protège vraiment : la liste affichée vient de NOTRE base, pas de Meta (Meta ne renvoie pas
 * la structure d'un flow). Un formulaire construit dans WhatsApp Manager n'apparaît donc QUE si le bouton
 * appelle bien la réconciliation ET recharge ensuite la liste. Un bouton qui appellerait la route sans
 * recharger aurait l'air de marcher, l'écran resterait pourtant faux jusqu'au prochain F5.
 * Backend intercepté, aucune base (même pattern que les autres E2E de la console).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

type Flow = Record<string, unknown>;

function flow(over: Partial<Flow> = {}): Flow {
  return {
    id: 'f1', name: 'Contact', status: 'PUBLISHED', fields: [], screens: null, ref: null, mapping: null, cta: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

/** `apresRefresh` = ce que la liste renvoie UNE FOIS la réconciliation faite (le formulaire importé). */
async function mockPage(page: import('@playwright/test').Page, flows: Flow[], apresRefresh: Flow[], rapport: Record<string, number>) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  const refreshes: string[] = [];
  let courant = flows;
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });

    if (req.method() === 'POST' && /\/flows\/refresh$/.test(path)) {
      refreshes.push(path);
      courant = apresRefresh;
      return json(rapport);
    }
    if (/\/flows$/.test(path)) return json({ flows: courant });
    if (path.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { refreshes };
}

test.describe('Formulaires : rafraîchir depuis WhatsApp Manager', () => {
  test('le bouton importe les formulaires du compte et la liste les montre sans recharger la page', async ({ page }) => {
    const importe = flow({ id: 'fnew', name: 'Devis express', status: 'DRAFT' });
    const { refreshes } = await mockPage(page, [flow()], [flow(), importe], { importes: 1, majs: 0, ignores: 0, absents: 0 });

    await page.goto('/flows');
    await expect(page.getByText('Contact', { exact: true })).toBeVisible();
    await expect(page.getByText('Devis express', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Rafraîchir' }).click();

    await expect.poll(() => refreshes.length).toBe(1);
    // La liste a bien été RELUE après la réconciliation : le formulaire importé est là, tout de suite.
    await expect(page.getByText('Devis express', { exact: true })).toBeVisible();
    // Et l'écran dit ce qu'un import implique : ce formulaire s'envoie, mais ne remplit aucune fiche contact.
    const note = page.getByTestId('flows-note-rafraichissement');
    await expect(note).toContainText('1 formulaire importé');
    await expect(note).toContainText('fiches contact');
  });

  test('rien de neuf chez Meta : le dit, et n\'invente pas de formulaire', async ({ page }) => {
    const { refreshes } = await mockPage(page, [flow()], [flow()], { importes: 0, majs: 0, ignores: 0, absents: 0 });

    await page.goto('/flows');
    await page.getByRole('button', { name: 'Rafraîchir' }).click();

    await expect.poll(() => refreshes.length).toBe(1);
    await expect(page.getByTestId('flows-note-rafraichissement')).toContainText('Aucun changement');
    await expect(page.getByText('Formulaires (1)')).toBeVisible();
  });
});
