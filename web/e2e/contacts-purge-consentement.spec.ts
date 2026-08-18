import { test, expect } from '@playwright/test';

/**
 * E2E mini-CRM : l'effacement DÉFINITIF et la bascule de consentement.
 *
 * Ce fichier existe pour une raison précise. Le serveur exige `confirm: 'PURGER'`, mais c'est le client qui
 * l'envoie, systématiquement : cette garde ne protège donc que d'une erreur d'API, jamais de celle de
 * l'opérateur. La SEULE chose qui protège la personne devant l'écran est la saisie du mot dans la modale, et
 * elle n'est prouvée que par ce test. Une purge est irréversible : un bouton actif trop tôt détruit des
 * conversations qu'aucune restauration ne ramène.
 *
 * Backend intercepté, aucune base requise (pattern des E2E accueil / paramètres).
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };
const CONTACTS = [
  { id: 'c1', phoneE164: '+33611111111', bsuid: null, profileName: 'Alex', optInStatus: 'opted_in', fields: {}, tags: [], createdAt: '2026-08-01T09:00:00.000Z' },
  { id: 'c2', phoneE164: '+33622222222', bsuid: null, profileName: 'Bo', optInStatus: 'unknown', fields: {}, tags: [], createdAt: '2026-08-02T09:00:00.000Z' },
];

/** Monte la page Contacts avec un backend simulé, et rend les corps reçus sur la purge et sur /bulk. */
async function monter(page: import('@playwright/test').Page) {
  const purges: Array<Record<string, unknown>> = [];
  const bulks: Array<Record<string, unknown>> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (req.method() === 'POST' && url.includes('/contacts/purge')) {
      purges.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ purges: 1, conversations: 1, messages: 7, analyses: 1 });
    }
    if (req.method() === 'POST' && url.includes('/contacts/bulk')) {
      bulks.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ affected: 1 });
    }
    if (url.includes('/contacts/count')) return json({ count: CONTACTS.length });
    if (url.includes('/user-fields')) return json({ fields: [] });
    if (url.includes('/tags')) return json({ tags: [] });
    if (url.includes('/contacts')) return json({ contacts: CONTACTS });
    if (url.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  await page.goto('/contacts');
  // Coche le premier contact : la barre d'action n'apparaît qu'à partir d'une sélection.
  await page.locator('input[type="checkbox"]').nth(1).check();
  await expect(page.getByTestId('contacts-action')).toBeVisible();
  return { purges, bulks };
}

test.describe('mini-CRM : effacement définitif', () => {
  test('🔴 le bouton reste INACTIF tant que « PURGER » n’est pas tapé, et aucun appel ne part', async ({ page }) => {
    const { purges } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-purge').click();

    const valider = page.getByTestId('bulk-submit');
    await expect(valider).toBeDisabled();

    // Un mot approchant ne suffit pas : c'est tout l'intérêt d'une confirmation par saisie.
    await page.getByTestId('purge-confirm').fill('PURGE');
    await expect(valider).toBeDisabled();
    await page.getByTestId('purge-confirm').fill('supprimer');
    await expect(valider).toBeDisabled();
    expect(purges).toEqual([]);

    await page.getByTestId('purge-confirm').fill('PURGER');
    await expect(valider).toBeEnabled();
  });

  test('confirmé : la purge part avec la cible cochée et le mot de confirmation', async ({ page }) => {
    const { purges } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-purge').click();
    await page.getByTestId('purge-confirm').fill('PURGER');
    await page.getByTestId('bulk-submit').click();

    await expect.poll(() => purges.length).toBe(1);
    expect(purges[0]).toEqual({ target: { ids: ['c1'] }, confirm: 'PURGER' });
  });

  test('🔴 « Supprimer » et « Effacer définitivement » sont DEUX entrées distinctes', async ({ page }) => {
    // Les confondre est le risque réel de cet écran : l'une se défait, l'autre non.
    await monter(page);
    await page.getByTestId('contacts-action').click();
    await expect(page.getByTestId('contacts-action-purge')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Supprimer', exact: true })).toBeVisible();
  });
});

test.describe('mini-CRM : bascule de consentement', () => {
  test('opt-out : envoie set_optin/opted_out, sans confirmation par saisie', async ({ page }) => {
    // Pas de mot à taper ici : la bascule se défait d'un clic, contrairement à la purge.
    const { bulks } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-optout').click();
    await page.getByTestId('bulk-submit').click();

    await expect.poll(() => bulks.length).toBe(1);
    expect(bulks[0]).toEqual({ target: { ids: ['c1'] }, action: { type: 'set_optin', value: 'opted_out' } });
  });

  test('opt-in : même chemin, valeur opted_in', async ({ page }) => {
    const { bulks } = await monter(page);
    await page.getByTestId('contacts-action').click();
    await page.getByTestId('contacts-action-optin').click();
    await page.getByTestId('bulk-submit').click();

    await expect.poll(() => bulks.length).toBe(1);
    expect(bulks[0]).toMatchObject({ action: { type: 'set_optin', value: 'opted_in' } });
  });
});
