import { test, expect } from '@playwright/test';

/**
 * RC7 : un champ du contact dans l'adresse d'un bouton « Lien » (`https://client.fr/commande/{numero_commande}`).
 *
 * Ce que la console doit tenir : le bouton « Variable » du champ d'adresse insère `{cle}` À LA POSITION DU CURSEUR,
 * l'aperçu dit ce que le contact recevra, un champ placé dans le nom du site est refusé AVANT l'envoi, et l'adresse
 * part vers NOTRE API avec son champ intact. ⚠️ La substitution par notre lien tracé à jeton se fait côté serveur,
 * que ces specs simulent : elle est prouvée par `tests/templates.test.ts` (« Meta reçoit NOTRE lien à jeton »).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

async function ouvrir(page: import('@playwright/test').Page, cree: { corps: Record<string, unknown> | null }) {
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/templates')) {
      cree.corps = req.postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'tpl-1', status: 'PENDING' }) });
    }
    if (url.includes('/templates')) return json({ templates: [] });
    if (url.includes('/flows')) return json({ flows: [] });
    if (url.includes('/user-fields')) return json({ fields: [{ key: 'numero_commande', label: 'N° de commande', type: 'text' }] });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/templates');
  await page.getByRole('button', { name: /Créer un template|Create a template/ }).click();
  await expect(page.getByTestId('template-nom')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('template-nom').fill('suivi_commande');
  await page.getByRole('textbox', { name: /Corps du message/i }).fill('Votre commande est partie.');
  await page.getByTestId('template-ajouter-lien').click();
  await page.getByTestId('template-bouton-texte-0').fill('Suivre ma commande');
}

test.describe('un champ du contact dans l’adresse d’un bouton « Lien »', () => {
  test('🔴 « Variable » insère le champ au curseur, l’aperçu le montre rempli, et l’adresse part intacte', async ({ page }) => {
    const cree: { corps: Record<string, unknown> | null } = { corps: null };
    await ouvrir(page, cree);
    const adresse = page.getByTestId('template-bouton-url-0');
    await adresse.fill('https://client.fr/commande/?src=wa');
    // Le curseur juste après « /commande/ » : le champ doit s'insérer LÀ, pas en fin d'adresse.
    await adresse.evaluate((el: HTMLInputElement) => { const p = 'https://client.fr/commande/'.length; el.setSelectionRange(p, p); });

    await page.getByTestId('template-bouton-url-variable-0').click();
    await page.getByRole('button', { name: 'N° de commande', exact: true }).click();
    await expect(adresse).toHaveValue('https://client.fr/commande/{numero_commande}?src=wa');

    await expect(page.getByTestId('template-bouton-url-exemple-0')).toContainText('https://client.fr/commande/A1234?src=wa');

    await page.getByRole('button', { name: /Créer le template|Create template/ }).click();
    await expect.poll(() => cree.corps).not.toBeNull();
    expect((cree.corps!.buttons as Array<{ url?: string }>)[0]!.url).toBe('https://client.fr/commande/{numero_commande}?src=wa');
  });

  test('les champs de base sont proposés, et le « Variable » du corps reste le seul à porter ce nom', async ({ page }) => {
    await ouvrir(page, { corps: null });
    await page.getByTestId('template-bouton-url-0').fill('https://client.fr/bonjour/');
    await page.getByTestId('template-bouton-url-variable-0').click();
    await page.getByRole('button', { name: 'Prénom', exact: true }).click();
    await expect(page.getByTestId('template-bouton-url-0')).toHaveValue('https://client.fr/bonjour/{prenom}');
    // Le sélecteur du corps se trouve toujours par son nom exact (les e2e du carousel s'en servent).
    await expect(page.getByRole('button', { name: 'Variable', exact: true })).toHaveCount(1);
  });

  test('🔴 un champ dans le nom du site est refusé AVANT l’envoi, avec la raison', async ({ page }) => {
    const cree: { corps: Record<string, unknown> | null } = { corps: null };
    await ouvrir(page, cree);
    await page.getByTestId('template-bouton-url-0').fill('https://{prenom}.client.fr/commande');
    await expect(page.getByTestId('template-manques')).toContainText(/bouton 1.*après le nom du site/);
    await expect(page.getByRole('button', { name: /Créer le template|Create template/ })).toBeDisabled();
    await expect(page.getByTestId('template-bouton-url-exemple-0')).toHaveCount(0);

    // Preuve inverse : le même champ après « / » est accepté, et la raison s'en va.
    await page.getByTestId('template-bouton-url-0').fill('https://client.fr/commande/{prenom}');
    // Plus rien ne manque : la liste disparaît (nom, corps, libellé et adresse sont remplis).
    await expect(page.getByTestId('template-manques')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Créer le template|Create template/ })).toBeEnabled();
  });
});
