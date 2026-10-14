import { test, expect } from './aide/test';

/**
 * LA DURÉE DE VALIDITÉ D'UN MODÈLE (plan du 2026-10-14) : `message_send_ttl_seconds` chez Meta.
 *
 * 🔴 LE PIÈGE QUE CE FICHIER VERROUILLE : un modèle dont on ne touche pas la durée doit partir EXACTEMENT comme avant le
 * lot, sans le champ. Seule exception, l'édition d'un modèle qui avait une autre durée : revenir au défaut doit l'envoyer,
 * sinon Meta garde l'ancienne durée alors que l'écran affiche « par défaut ».
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const modele = (over: Record<string, unknown>) => ({
  id: 'tpl-1', name: 'rappel_rdv', status: 'APPROVED', category: 'UTILITY', language: 'fr',
  body: 'Votre rendez-vous est demain.', headerFormat: null, isCarousel: false, editable: true, ...over,
});

type Appel = { method: string; body: Record<string, unknown> };

async function ouvrir(page: import('@playwright/test').Page, modeles: unknown[]): Promise<Appel[]> {
  const appels: Appel[] = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/templates')) {
      appels.push({ method: 'POST', body: req.postDataJSON() as Record<string, unknown> });
      return json({ id: 'tpl-2', status: 'PENDING' }, 201);
    }
    if (req.method() === 'PATCH' && url.includes('/templates')) {
      appels.push({ method: 'PATCH', body: req.postDataJSON() as Record<string, unknown> });
      return json({ success: true, status: 'PENDING' });
    }
    if (url.includes('/param-hints')) return json({ hints: [] });
    if (url.includes('/templates')) return json({ templates: modeles });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/templates');
  return appels;
}

async function remplirEtCreer(page: import('@playwright/test').Page, nom: string): Promise<void> {
  await page.getByTestId('template-nom').fill(nom);
  await page.getByRole('textbox', { name: /Corps du message/i }).fill('Bonjour, profitez de nos offres.');
  await page.getByRole('button', { name: /Créer le template/ }).click();
}

test.describe('la durée de validité d’un modèle', () => {
  test('🔴 un modèle créé sans toucher à la durée part SANS le champ, avec « 30 jours (par défaut) » affiché', async ({ page }) => {
    const appels = await ouvrir(page, []);
    await page.getByRole('button', { name: /Créer un template/ }).first().click();
    await expect(page.getByTestId('template-duree')).toHaveValue('2592000');
    await expect(page.getByTestId('template-duree').locator('option:checked')).toHaveText('30 jours (par défaut)');
    await remplirEtCreer(page, 'promo_ete');
    await expect.poll(() => appels.length).toBe(1);
    expect(appels[0]!.body).not.toHaveProperty('ttlSecondes');
  });

  test('une promo réglée sur « 7 jours » part avec 604 800 secondes', async ({ page }) => {
    const appels = await ouvrir(page, []);
    await page.getByRole('button', { name: /Créer un template/ }).first().click();
    await page.getByTestId('template-duree').selectOption({ label: '7 jours' });
    await remplirEtCreer(page, 'promo_flash');
    await expect.poll(() => appels.length).toBe(1);
    expect(appels[0]!.body).toMatchObject({ category: 'MARKETING', ttlSecondes: 604_800 });
  });

  test('🔴 passer en « Utilitaire » propose les durées utilitaires, et une durée marketing revient au défaut', async ({ page }) => {
    await ouvrir(page, []);
    await page.getByRole('button', { name: /Créer un template/ }).first().click();
    await page.getByTestId('template-duree').selectOption({ label: '7 jours' });
    await page.locator('select').filter({ has: page.locator('option[value="UTILITY"]') }).selectOption('UTILITY');
    const duree = page.getByTestId('template-duree');
    await expect(duree).toHaveValue('-1');
    await expect(duree.locator('option')).toHaveText(['1 heure', '6 heures', '12 heures', '30 jours (par défaut)']);
  });

  test('🔴 à l’édition, la durée lue chez Meta est affichée, et revenir au défaut l’ENVOIE pour l’effacer', async ({ page }) => {
    const appels = await ouvrir(page, [modele({ ttlSecondes: 3_600 })]);
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    const duree = page.getByTestId('template-duree');
    await expect(duree).toHaveValue('3600');
    await duree.selectOption({ label: '30 jours (par défaut)' });
    await page.getByRole('button', { name: /Enregistrer les modifications/ }).click();
    await expect.poll(() => appels.length).toBe(1);
    expect(appels[0]).toMatchObject({ method: 'PATCH', body: { category: 'UTILITY', ttlSecondes: -1 } });
  });

  test('à l’édition d’un modèle sans durée, ne rien toucher n’envoie rien', async ({ page }) => {
    const appels = await ouvrir(page, [modele({})]);
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    await page.getByRole('button', { name: /Enregistrer les modifications/ }).click();
    await expect.poll(() => appels.length).toBe(1);
    expect(appels[0]!.body).not.toHaveProperty('ttlSecondes');
  });

  test('🔴 un modèle d’AUTHENTIFICATION s’ouvre en modification et en duplication, sans champ de durée (la page plantait)', async ({ page }) => {
    const erreurs: string[] = [];
    page.on('pageerror', (e) => erreurs.push(e.message));
    await ouvrir(page, [modele({ category: 'AUTHENTICATION', name: 'code_connexion' })]);
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    await expect(page.getByRole('button', { name: /Enregistrer les modifications/ })).toBeVisible();
    await expect(page.getByTestId('template-duree')).toHaveCount(0);
    await page.getByTestId('template-dupliquer-code_connexion').click();
    await expect(page.getByRole('button', { name: /Créer le template/ })).toBeVisible();
    await expect(page.getByTestId('template-duree')).toHaveCount(0);
    expect(erreurs).toEqual([]);
  });

  test('la copie d’un modèle à « 1 heure » reprend sa durée et l’envoie', async ({ page }) => {
    const appels = await ouvrir(page, [modele({ ttlSecondes: 3_600 })]);
    await page.getByTestId('template-dupliquer-rappel_rdv').click();
    await expect(page.getByTestId('template-duree')).toHaveValue('3600');
    await page.getByRole('button', { name: /Créer le template/ }).click();
    await expect.poll(() => appels.length).toBe(1);
    expect(appels[0]).toMatchObject({ method: 'POST', body: { category: 'UTILITY', ttlSecondes: 3_600 } });
  });

  test('🔴 en modification, passer un modèle à « 1 heure » en marketing envoie le défaut marketing, jamais 1 heure', async ({ page }) => {
    const appels = await ouvrir(page, [modele({ ttlSecondes: 3_600 })]);
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    await page.locator('select').filter({ has: page.locator('option[value="UTILITY"]') }).selectOption('MARKETING');
    await expect(page.getByTestId('template-duree')).toHaveValue('2592000');
    await page.getByRole('button', { name: /Enregistrer les modifications/ }).click();
    await expect.poll(() => appels.length).toBe(1);
    expect(appels[0]).toMatchObject({ method: 'PATCH', body: { category: 'MARKETING', ttlSecondes: 2_592_000 } });
  });

  test('une durée réglée hors de l’éditeur (2 heures) reste affichée, au lieu d’être remplacée en silence', async ({ page }) => {
    await ouvrir(page, [modele({ ttlSecondes: 7_200 })]);
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    const duree = page.getByTestId('template-duree');
    await expect(duree).toHaveValue('7200');
    await expect(duree.locator('option:checked')).toHaveText('2 heures');
  });
});
