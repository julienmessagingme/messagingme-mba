import { test, expect } from '@playwright/test';

/**
 * Le rangement de la barre, revu le 2026-09-08 à la demande de Julien.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, et qui se casse sans bruit : la POSITION d'une entrée dans la barre est
 * portée par la STRUCTURE (deux tableaux, l'un rendu en haut, l'autre collé en bas), pas par une propriété.
 * Déplacer une entrée, c'est la changer de tableau, et rien dans le type ne dit qu'on s'est trompé de
 * tableau : le menu s'affiche, l'entrée est simplement au mauvais endroit.
 */
const ADMIN = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function mock(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), ADMIN);
  await page.route('**/api/backend/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('/agents/solde')) return json({ soldeMicroEur: 4_200_000 });
    if (url.includes('/unread-count')) return json({ count: 0 });
    if (url.endsWith('/me')) return json({ email: ADMIN.email, name: 'Jean Test', role: 'admin' });
    if (url.endsWith('/settings')) return json({ mbaEnabled: false, hubspotListsEnabled: false, campaignsPaused: false, autoRetryEnabled: false, controlHandbackSeconds: null, mbaHandoffMode: null, timezone: 'Europe/Paris', businessHours: {} });
    return json({});
  });
}

test.describe('Barre : où sont rangées les entrées', () => {
  test('🔴 Paramètres et Support sont dans le bloc BAS, au-dessus de Developers', async ({ page }) => {
    await mock(page);
    await page.goto('/accueil');
    // Le bloc bas porte son propre identifiant : on y cherche les deux entrées, plutôt que dans la barre
    // entière, sinon le test passerait aussi si elles étaient restées en haut. Deviner la structure DOM
    // (« le dernier div de l'aside ») marchait par accident et se serait cassé à la première mise en forme.
    const blocBas = page.getByTestId('nav-bas');
    // « Paramètres » est un GROUPE depuis le 2026-09-29 : un bouton qui se déplie, plus un lien.
    await expect(blocBas.getByRole('button', { name: /Paramètres/ })).toBeVisible();
    await expect(blocBas.getByRole('link', { name: 'Support', exact: true })).toBeVisible();

    // Et l'ORDRE demandé : les deux AVANT Developers.
    const textes = await blocBas.innerText();
    expect(textes.indexOf('Paramètres')).toBeLessThan(textes.indexOf('Developers'));
    expect(textes.indexOf('Support')).toBeLessThan(textes.indexOf('Developers'));
  });

  test('🔴 « AI Agent » porte deux liens directs : MBA vers ses paramètres, Other AI agent vers /agents', async ({ page }) => {
    // Le rangement du 2026-09-29 (décision de Julien) : plus de troisième niveau sous « AI Agent », plus de guide.
    await mock(page);
    await page.goto('/agents');
    await expect(page.getByRole('link', { name: 'MBA', exact: true })).toHaveAttribute('href', '/mba/parametres');
    await expect(page.getByRole('link', { name: 'Other AI agent', exact: true })).toHaveAttribute('href', '/agents');
    await expect(page.getByRole('link', { name: 'Guide', exact: true })).toHaveCount(0);
    // L'adresse de l'écran des agents N'A PAS bougé.
    expect(new URL(page.url()).pathname).toBe('/agents');
  });

  test('🔴 « Paramètres » est un groupe du bloc bas : Général et Crédit IA', async ({ page }) => {
    await mock(page);
    await page.goto('/parametres/credit');
    const blocBas = page.getByTestId('nav-bas');
    await expect(blocBas.getByRole('link', { name: 'Général', exact: true })).toHaveAttribute('href', '/parametres');
    await expect(blocBas.getByRole('link', { name: 'Crédit IA', exact: true })).toHaveAttribute('href', '/parametres/credit');
    await expect(page.getByTestId('credit-solde')).toContainText('4');
  });

  test('les anciennes adresses mènent aux nouvelles : /agents/credit et /mba', async ({ page }) => {
    await mock(page);
    await page.goto('/agents/credit');
    await expect(page).toHaveURL(/\/parametres\/credit$/);
    await page.goto('/mba');
    await expect(page).toHaveURL(/\/mba\/parametres$/);
  });

  test('les onglets se distinguent du logo : une autre graisse, et un écart', async ({ page }) => {
    // Julien : « la police n'est pas assez différenciante et c'est positionné beaucoup trop proche du logo ».
    // Ce qui se vérifie sans juger du goût : une graisse différente de celle du nom du produit, et un écart
    // réel entre ce nom et le premier onglet.
    // ⚠️ La casse haute qui les distinguait a été retirée le 2026-09-25 (passe « anti-slop » : des majuscules
    // espacées pour structurer). Ce cas garde qu'elle ne revient pas.
    await mock(page);
    await page.goto('/accueil');
    const onglet = page.getByTestId('onglet-console');
    await expect(onglet).toHaveCSS('text-transform', 'none');
    const logo = page.getByText('Engage Me');
    const graisse = (el: Element) => getComputedStyle(el).fontWeight;
    expect(await onglet.evaluate(graisse)).not.toBe(await logo.evaluate(graisse));
    const bLogo = (await logo.boundingBox())!;
    const bOnglet = (await onglet.boundingBox())!;
    expect(bOnglet.x - (bLogo.x + bLogo.width)).toBeGreaterThan(20);
  });
});
